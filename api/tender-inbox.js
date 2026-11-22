/**
 * Vercel function: the scan of the projects@ mailbox for requests for tender /
 * quote — and, since 18 Nov 2026, a colleague's request to the estimators (a
 * takeoff, a price) — each one made into a Queued project in Quotes (Grady,
 * 28 Oct 2026 — see src/lib/tenderInbox.js for the rules and his words). It
 * runs every 15 minutes through the working day (vercel.json crons) and every
 * few minutes while someone is signed in to the portal (POST {auto:true});
 * a scan takes the record first, so two never run at once.
 *
 *   GET  with the Vercel cron header (Authorization: Bearer $CRON_SECRET, or
 *        the vercel-cron user agent when no secret is set)  → runs a scan.
 *   GET  from the portal's own origin                      → {record} (status only, nothing read from Gmail)
 *   POST from the portal's own origin {action:"scan"}      → runs a scan now ("Scan now" in Settings)
 *   POST {action:"status"}                                 → {record}
 *
 * What a scan does, in order — every step is in runTenderInbox so verify.mjs
 * can run it on a fake fetch:
 *   1. reads the record row (INBOX_ROW_KEY) — watermark, handled messages, created list;
 *   2. lists the mailbox since the watermark (first time: 14 days), newest first, up to 200 headers;
 *   3. reads IN FULL only the messages whose subject + snippet already look like a request
 *      and that were not handled before, and classifies each (classifyMessage);
 *   4. de-duplicates against every project (name, address, the same thread) and within the batch;
 *   5. asks the AI provider, when one is configured, for a second opinion in ONE call
 *      (a confident "not a tender" drops the candidate; a stated address / client / closing
 *      date refines it) — when no provider answers the rules stand;
 *   6. copies the email's drawings and documents into the gradcon-files bucket under
 *      quote-files/<projectId>/ (PDF, DWG/DXF, Word, Excel, ZIP, images; 12 files, 25 MB each);
 *   7. writes the quote row, appends the project to the gradcon-projects index with a
 *      CONDITIONAL update (never a blind overwrite of another browser's write) and records
 *      the outcome, so the same message or thread can never make a second project.
 *
 * The mailbox is read-only (nothing is labelled, moved or sent). The ONE
 * mailbox is projects@ — api/_google.js allowedMailbox; a tender that reached
 * grady@ is caught when it is forwarded or copied there.
 */
import * as Gm from "./_google.js";
import { resolveProviderId, callText } from "./_providers.js";
import { uid } from "../src/lib/costing.js";
import { smsStatus, sendSmsByRole } from "./_sms.js";
import { newProjectTexts, existingProjectTexts, newProjectSmsOn } from "../src/lib/newProjectSms.js";
import {
  INBOX_ROW_KEY, MAX_ATTACHMENT_BYTES, MAIL_ATTACH_KINDS, attachExt,
  classifyMessage, candidateFromMessage, isColleagueForward, lookbackDaysOf, tenderQuoteFrom, findDuplicate, emptyRecord, scanQuery, applyScan, wasHandled,
  tenderReviewPrompt, parseTenderReview, applyReview, isoDay, scanLockHeld, autoScanHold,
} from "../src/lib/tenderInbox.js";

const SUPABASE_URL = "https://xbmyhvrcuyapoarmchpv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kr4dTFXhZsifAA28HmMAVQ_EDSR2DL0";
const BUCKET = "gradcon-files";
const PROJECTS_INDEX_KEY = "gradcon-projects";
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
const MAX_HEADERS = 200;
const MAX_FULL_READS = 40;
const QUICK_SCORE = 2;

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}
/** Vercel's cron call: the shared secret when one is set, else the cron user agent. */
export function isCronCall(req, env = process.env) {
  const auth = String((req.headers && req.headers.authorization) || "");
  if (env.CRON_SECRET) return auth === `Bearer ${env.CRON_SECRET}`;
  return /^vercel-cron\//i.test(String((req.headers && req.headers["user-agent"]) || ""));
}
const safeName = (n) => String(n || "attachment").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 90);

/** Every project's name, client, status and mail source — a few bytes per row, never the items. */
export async function existingProjects(fetchImpl = fetch) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=like.gradcon-quote-*&select=key,updated_at,name:value-%3E%3EprojectName,client:value-%3E%3EclientName,status:value-%3E%3Estatus,source:value-%3Esource`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`could not read the projects (${r.status})`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}
/** Append one entry to the projects index without overwriting another writer: PATCH conditioned on updated_at, re-read and retried. */
export async function appendProjectEntry(entry, fetchImpl = fetch, { attempts = 5, now = () => new Date().toISOString() } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${PROJECTS_INDEX_KEY}&select=value,updated_at`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`could not read the projects index (${r.status})`);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    const list = row && Array.isArray(row.value) ? row.value : [];
    if (list.some((p) => p && p.id === entry.id)) return { ok: true, already: true };
    const next = [...list, entry];
    if (!row) {
      const ins = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: PROJECTS_INDEX_KEY, value: next, updated_at: now() }), signal: AbortSignal.timeout(10000) });
      if (ins.ok) return { ok: true };
      continue;
    }
    const up = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${PROJECTS_INDEX_KEY}&updated_at=eq.${encodeURIComponent(row.updated_at)}`, { method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ value: next, updated_at: now() }), signal: AbortSignal.timeout(10000) });
    if (!up.ok) continue;
    const changed = await up.json().catch(() => []);
    if (Array.isArray(changed) && changed.length > 0) return { ok: true };
    // someone else wrote the index between the read and the patch — read again
  }
  return { ok: false, error: "the projects index kept changing while the new project was being added" };
}
async function writeQuoteRow(key, value, fetchImpl) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`could not write the project row (${r.status})`);
}
/** Copy the email's attachments into the bucket under the project; a file that fails is skipped and named in `errors`. */
export async function copyAttachments(cand, projectId, token, fetchImpl, errors) {
  const files = [];
  for (const a of cand.attachments) {
    try {
      if (!a.attachmentId) continue;
      const bytes = await Gm.attachmentBytes(cand.messageId, a.attachmentId, token, fetchImpl);
      if (bytes.length > MAX_ATTACHMENT_BYTES) { errors.push(`${a.filename}: over 25 MB, left in the email`); continue; }
      const name = safeName(a.filename);
      const path = `quote-files/${projectId}/${name}`;
      const mime = MAIL_ATTACH_KINDS[attachExt(a.filename)]?.mime || a.mimeType || "application/octet-stream";
      const up = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: { ...HEADERS, "Content-Type": mime, "x-upsert": "true" }, body: bytes, signal: AbortSignal.timeout(60000) });
      if (!up.ok) { errors.push(`${a.filename}: the bucket refused it (${up.status})`); continue; }
      files.push({ id: uid(), name: a.filename, kind: a.kind, mimeType: mime, size: bytes.length, path, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, attachmentId: a.attachmentId });
    } catch (e) { errors.push(`${a.filename}: ${e.message}`); }
  }
  return files;
}

/** The record row WITH its stamp. Throws when it cannot be read: a failed read is never "no record" (an empty record would
 *  look back 14 days with nothing handled and then be saved over the real one). */
export async function readRecordRow(fetchImpl = fetch) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${INBOX_ROW_KEY}&select=value,updated_at`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`could not read the scan record (${r.status})`);
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return { record: row && row.value && typeof row.value === "object" ? { ...emptyRecord(), ...row.value } : emptyRecord(), stamp: row ? row.updated_at : null };
}
/** Take the record for this scan: `scanning = {at, by}` written with a CONDITIONAL update on the row's stamp, so of two scans
 *  that start together exactly one goes on (the scans now run every few minutes from the cron AND from the portal — without
 *  this both would read the same unhandled email and each make the project and send the texts). → true when this scan holds it. */
export async function takeScanLock(record, stamp, by, now, fetchImpl = fetch) {
  const value = { ...record, scanning: { at: now.toISOString(), by } };
  const body = JSON.stringify({ key: INBOX_ROW_KEY, value, updated_at: new Date().toISOString() });
  if (!stamp) { // no record yet: the first scan ever
    const ins = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body, signal: AbortSignal.timeout(10000) });
    return !!ins.ok;
  }
  const up = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${INBOX_ROW_KEY}&updated_at=eq.${encodeURIComponent(stamp)}`, { method: "PATCH", headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(10000) });
  if (!up.ok) return false;
  const changed = await up.json().catch(() => []);
  return Array.isArray(changed) && changed.length > 0;
}

/** The scan. `deps.review` is the AI second opinion (default: callText on the configured provider; null → rules only).
 *  `auto` = the portal asked on its own (someone is signed in): throttled, daytime only, and answered without the record. */
export async function runTenderInbox({ action = "status", by = "cron", auto = false, lookbackDays: lookbackAsked = 0 } = {}, env = process.env, fetchImpl = fetch, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  // A RE-CHECK ("the last N days", Settings) reads the mailbox again from N days back instead of from the watermark: a request the
  // rules of the day did not recognise was never recorded, so it is read again under today's rules. A handled message or thread
  // still makes no second project (wasHandled). Only a person asks for it — never an automatic scan.
  const lookbackDays = auto ? 0 : lookbackDaysOf(lookbackAsked);
  if (action === "status") {
    let record; try { record = (await readRecordRow(fetchImpl)).record; } catch { record = emptyRecord(); }   // a status read only shows; it never writes
    return { status: 200, body: { record, configured: Gm.googleConfigured(env), sms: newProjectSmsStatus(env) } };
  }
  if (action !== "scan") return { status: 400, body: { error: `unknown action ${action}` } };
  if (!Gm.googleConfigured(env)) return { status: 503, body: { error: "Google is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Vercel project's Environment Variables." } };
  let row;
  try { row = await readRecordRow(fetchImpl); } catch (e) { return { status: 502, body: { error: `${e.message} — nothing was scanned, so nothing could be made twice` } }; }
  const stoodDown = (why) => ({ status: 200, body: auto ? { skipped: why, created: [], lastScanAt: row.record.lastScanAt } : { skipped: why, record: row.record, created: [], summary: row.record.lastResult || null, errors: [] } });
  if (auto) { const hold = autoScanHold(row.record, now); if (hold) return stoodDown(hold); }
  if (scanLockHeld(row.record, now)) return stoodDown("another scan is running");
  let tok;
  try { tok = await Gm.accessToken(env, fetchImpl); } catch (e) { return { status: e.status || 502, body: { error: e.message } }; }
  try { if (!(await takeScanLock(row.record, row.stamp, by, now, fetchImpl))) return stoodDown("another scan is running"); }
  catch (e) { return { status: 502, body: { error: `could not take the scan record: ${e.message}` } }; }
  const record = row.record;
  const release = async () => { try { await Gm.writeRow(INBOX_ROW_KEY, { ...record, scanning: null }, fetchImpl); } catch { /* the lock lapses on its own */ } };
  const mailbox = tok.email || Gm.allowedMailbox(env);
  const errors = [];
  const handled = [];
  const created = [];
  let seenMaxMs = 0, scanned = 0, fullReads = 0;
  // 2. the headers since the watermark
  const headers = [];
  try {
    let pageToken = "";
    const q = scanQuery(record, now, { lookbackDays });
    while (headers.length < MAX_HEADERS) {
      const page = await Gm.listMessages({ q, max: 50, pageToken }, tok.token, fetchImpl);
      headers.push(...page.messages);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (e) { await release(); return { status: e.status || 502, body: { error: `could not list the mailbox: ${e.message}` } }; }
  scanned = headers.length;
  headers.forEach((m) => { const ms = Date.parse(m.date); if (ms && ms > seenMaxMs) seenMaxMs = ms; });
  // 3. full reads for the likely ones, classification
  const cands = [];
  for (const h of headers) {
    if (wasHandled(record, h, { mailbox })) continue;
    const quick = classifyMessage({ ...h, body: h.snippet || "" }, { mailbox });
    if (quick.excluded) { handled.push({ messageId: h.id, threadId: h.threadId, outcome: "skipped", reason: quick.excluded }); continue; }
    if (quick.score < QUICK_SCORE && !(h.attachments || []).length && !isColleagueForward(h, mailbox)) continue;
    if (fullReads >= MAX_FULL_READS) break;
    fullReads += 1;
    let full;
    try { full = await Gm.readMessage(h.id, tok.token, fetchImpl); } catch (e) { errors.push(`${h.subject || h.id}: ${e.message}`); continue; }
    const cand = candidateFromMessage(full, { now, mailbox });
    if (!cand) { const c = classifyMessage(full, { mailbox }); handled.push({ messageId: h.id, threadId: h.threadId, outcome: "skipped", reason: c.excluded || `not a request (score ${c.score})` }); continue; }
    cands.push(cand);
  }
  // 4. duplicates — against every project and within the batch (one project per thread / address)
  let existing = [];
  if (cands.length) { try { existing = await existingProjects(fetchImpl); } catch (e) { await release(); return { status: 502, body: { error: `${e.message} — nothing was created, so no duplicate could be made` } }; } }
  const accepted = [];
  const flagged = [];   // a request about a project the portal already holds: no second project, but the estimator is told
  for (const cand of cands) {
    const inPortal = findDuplicate(cand, existing);
    const dup = inPortal || findDuplicate(cand, accepted.map((a) => ({ key: a.messageId, name: a.projectName, source: { kind: "mail", messageId: a.messageId, threadId: a.threadId } })));
    if (dup) {
      handled.push({ messageId: cand.messageId, threadId: cand.threadId, outcome: "duplicate", reason: `${dup.why}${dup.row.name ? ` (${dup.row.name})` : ""}` });
      if (inPortal && !/same email thread/.test(dup.why)) flagged.push({ projectId: String(dup.row.key || "").replace(/^gradcon-quote-/, "") || null, existingName: dup.row.name || "", subject: cand.subject, from: cand.from, fromEmail: cand.fromEmail, internal: cand.internal, requestKind: cand.requestKind, messageId: cand.messageId });
      continue;
    }
    accepted.push(cand);
  }
  // 5. the AI second opinion, one call for the batch
  let reviewed = accepted;
  if (accepted.length) {
    const review = deps.review !== undefined ? deps.review : async (list) => {
      const id = resolveProviderId(null, env);
      if (!id) return null;
      const r = await callText(id, { system: "You are the estimating administrator of a Melbourne concrete subcontractor. Reply with ONE JSON object and nothing else.", prompt: tenderReviewPrompt(list, { today: isoDay(now) }), maxTokens: 2500, timeoutMs: 90000, env });
      return parseTenderReview(r.text, list);
    };
    try {
      const rv = review ? await review(accepted) : null;
      if (rv) {
        reviewed = [];
        accepted.forEach((c) => { const out = applyReview(c, rv[c.messageId]); if (out.drop) handled.push({ messageId: c.messageId, threadId: c.threadId, outcome: "skipped", reason: `AI review: ${out.why}` }); else reviewed.push(out.cand); });
      }
    } catch (e) { errors.push(`AI review skipped: ${e.message}`); }
  }
  // 6 + 7. create each project: files, row, index, record
  for (const cand of reviewed) {
    const projectId = uid();
    const storageKey = `gradcon-quote-${projectId}`;
    const fileErrors = [];
    const files = await copyAttachments(cand, projectId, tok.token, fetchImpl, fileErrors);
    fileErrors.forEach((m) => errors.push(`${cand.projectName}: ${m}`));
    const quote = tenderQuoteFrom(cand, { today: isoDay(now), files, scannedAt: now.toISOString() });
    try {
      await writeQuoteRow(storageKey, quote, fetchImpl);
      const idx = await appendProjectEntry({ id: projectId, storageKey, createdAt: now.toISOString() }, fetchImpl);
      if (!idx.ok) { errors.push(`${cand.projectName}: ${idx.error}`); handled.push({ messageId: cand.messageId, threadId: cand.threadId, outcome: "failed", reason: idx.error }); continue; }
    } catch (e) { errors.push(`${cand.projectName}: ${e.message}`); handled.push({ messageId: cand.messageId, threadId: cand.threadId, outcome: "failed", reason: e.message }); continue; }
    const item = { projectId, storageKey, name: quote.projectName, client: quote.clientName, deadline: cand.deadline, deadlineSource: cand.deadlineSource, from: cand.from, fromEmail: cand.fromEmail, via: cand.via, internal: !!cand.internal, requestKind: cand.requestKind || "tender", subject: cand.subject, receivedAt: cand.receivedAt, messageId: cand.messageId, threadId: cand.threadId, attachments: files.length, by };
    created.push(item);
    handled.push({ messageId: cand.messageId, threadId: cand.threadId, outcome: "created", projectId });
  }
  // 8. tell both people by text (16 Nov 2026) — only when NEW_PROJECT_SMS is on; a refused text is an error line, never a failed scan
  const sms = { on: newProjectSmsOn(env), sent: 0, failed: 0 };
  if ((created.length || flagged.length) && sms.on) {
    const send = deps.sendSms || ((msgs) => sendSmsByRole(msgs, env, fetchImpl));
    if (!deps.sendSms && !smsStatus(env).configured) errors.push("New-project texts are switched on but SMS is not configured — nothing was texted");
    else {
      try {
        const out = await send([...newProjectTexts(created, { estimator: env.SMS_COPY_NAME || "Boma" }), ...existingProjectTexts(flagged)]);
        (out || []).forEach((r) => { if (r.ok) sms.sent += 1; else { sms.failed += 1; errors.push(`Text to ${r.to} not sent: ${r.error}`); } });
      } catch (e) { errors.push(`New-project texts not sent: ${e.message}`); }
    }
  }
  const summary = { sms, scanned, read: fullReads, candidates: cands.length, created: created.length, flagged: flagged.length, duplicates: handled.filter((h) => h.outcome === "duplicate").length, skipped: handled.filter((h) => h.outcome === "skipped").length, failed: handled.filter((h) => h.outcome === "failed").length };
  const next = applyScan(record, { at: now.toISOString(), by, seenMaxMs, created, handled, summary, errors });
  try { await Gm.writeRow(INBOX_ROW_KEY, next, fetchImpl); } catch (e) { errors.push(`the scan record could not be saved: ${e.message}`); }
  // a scan the portal asked for on its own is answered in a few hundred bytes (it runs every few minutes from every signed-in tab)
  if (auto) return { status: 200, body: { created, flagged: flagged.length, summary, lastScanAt: next.lastScanAt, errors: errors.slice(0, 5) } };
  return { status: 200, body: { mailbox: tok.email, record: next, created, flagged, summary, errors } };
}

/** What Settings may show of the new-project texts: the switch and the masked numbers. Never a key or a whole number. */
export function newProjectSmsStatus(env = process.env) {
  const st = smsStatus(env);
  return { on: newProjectSmsOn(env), configured: st.configured, to: st.to, copyTo: st.copyTo || [], copyWarning: st.copyWarning || null };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const own = fromOwnOrigin(req);
  if (req.method === "GET") {
    if (isCronCall(req)) { const out = await runTenderInbox({ action: "scan", by: "cron" }); res.status(out.status).json(out.body); return; }
    if (own !== true) { res.status(403).json({ error: "The portal only." }); return; }
    const out = await runTenderInbox({ action: "status" });
    res.status(out.status).json(out.body); return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "GET or POST" }); return; }
  if (own !== true) { res.status(403).json({ error: "The portal only." }); return; }
  const body = req.body || {};
  const out = await runTenderInbox({ action: body.action || "status", by: String(body.by || "manual").slice(0, 40), auto: body.auto === true, lookbackDays: body.lookbackDays });
  res.status(out.status).json(out.body);
}
