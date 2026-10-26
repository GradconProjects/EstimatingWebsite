/**
 * Google Workspace mail for the portal — the ONE place Google credentials are
 * handled. Server-side only (underscore file, never imported by src/ or
 * portal/). Grady, 10 Oct 2026: "can we connect a google account so it reads
 * the emails … in fact lets do it … projects@gradcon.com.au and i want it
 * read everything".
 *
 * Vercel Environment Variables (never VITE_-prefixed):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   the OAuth client (Web application)
 *                                              whose redirect URI is https://<host>/api/google-auth
 *   GOOGLE_TOKEN_SECRET                        optional; the key the stored refresh token is
 *                                              encrypted with (defaults to the client secret)
 *   GOOGLE_ALLOWED_MAILBOX                     optional; the only address allowed to connect
 *                                              (default projects@gradcon.com.au)
 *
 * The mailbox's refresh token is stored in estimator_kv under GOOGLE_ROW_KEY,
 * encrypted with AES-256-GCM under a key derived from GOOGLE_TOKEN_SECRET, so
 * the row is useless to anyone holding only the public anon key. Scope is
 * gmail.readonly: this code can read mail and attachments and nothing else.
 */
import crypto from "node:crypto";

export const GOOGLE_ROW_KEY = "gradcon-google-mail";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/* Google Drive, read-only, for the project files folder (Grady, 21 Oct 2026:
 * "i want that folder accessible to grady … inside the app and should sync
 * across everywhere"). The SAME connection carries both scopes; a mailbox
 * connected before this must reconnect once to grant Drive. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/* Sending (Grady, 23 Oct 2026: RFQs drafted in the app, approved one by one and sent to each
 * contractor separately). gmail.send only — the app can send a message it composed, never read
 * or change anything beyond what gmail.readonly allows. A connection made before this reconnects
 * ONCE (Settings → Google mail & Drive → "Reconnect for sending"); until then api/gmail.js answers
 * 409 needsReconnect to every send. Nothing is ever sent without a person approving that one
 * draft in the portal. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** The office's project files folder in projects@'s Drive — the default root
 * the app may read under; Settings → Google Drive can point it elsewhere
 * (stored in STORAGE_ROW_KEY). A folder id is not a secret. */
export const DEFAULT_DRIVE_ROOT_ID = "1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX";
export const STORAGE_ROW_KEY = "gradcon-storage";
export const DEFAULT_MAILBOX = "projects@gradcon.com.au";
const SUPABASE_URL = "https://xbmyhvrcuyapoarmchpv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kr4dTFXhZsifAA28HmMAVQ_EDSR2DL0";

export function googleConfigured(env = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
export function allowedMailbox(env = process.env) {
  return String(env.GOOGLE_ALLOWED_MAILBOX || DEFAULT_MAILBOX).trim().toLowerCase();
}
function keyBytes(env) {
  const secret = env.GOOGLE_TOKEN_SECRET || env.GOOGLE_CLIENT_SECRET || "";
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return crypto.createHash("sha256").update(String(secret)).digest();
}
/** AES-256-GCM, output "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encryptText(plain, env = process.env) {
  const key = keyBytes(env); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function decryptText(blob, env = process.env) {
  const [v, iv, tag, enc] = String(blob || "").split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("unreadable token blob");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBytes(env), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}
/** The OAuth state: a timestamp signed with the secret, valid 10 minutes — no session store needed. */
export function signState(env = process.env, now = Date.now()) {
  const t = String(now);
  const mac = crypto.createHmac("sha256", keyBytes(env)).update(t).digest("base64url");
  return `${t}.${mac}`;
}
export function verifyState(state, env = process.env, now = Date.now()) {
  const [t, mac] = String(state || "").split(".");
  if (!t || !mac) return false;
  const want = crypto.createHmac("sha256", keyBytes(env)).update(t).digest("base64url");
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return false;
  return Math.abs(now - Number(t)) < 10 * 60000;
}
/** The production portal host: the ONE redirect URI registered with Google. A
 * portal opened on a Vercel preview / branch alias must still send this one,
 * or Google answers redirect_uri_mismatch (11 Oct 2026). GOOGLE_OAUTH_REDIRECT
 * overrides it for another deployment. */
export const CANONICAL_HOST = "estimating-website.vercel.app";
export function redirectUri(req, env = process.env) {
  if (env.GOOGLE_OAUTH_REDIRECT) return env.GOOGLE_OAUTH_REDIRECT;
  const host = String((req && req.headers && req.headers.host) || "").toLowerCase();
  // localhost keeps its own host (a local Vercel dev run); every hosted alias uses the registered one
  if (/^localhost(:\d+)?$/.test(host) || /^127\.0\.0\.1/.test(host)) return `http://${host}/api/google-auth`;
  return `https://${CANONICAL_HOST}/api/google-auth`;
}
export function consentUrl(redirect, env = process.env, now = Date.now()) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: `${GMAIL_SCOPE} ${DRIVE_SCOPE} ${GMAIL_SEND_SCOPE} openid email`,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: signState(env, now), login_hint: allowedMailbox(env),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/* ---------- the stored connection (estimator_kv row) ---------- */
/** Any estimator_kv row's value (null when absent or unreadable). */
export async function readRow(key, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(key)}&select=value,updated_at`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null; const rows = await r.json(); return rows[0] && rows[0].value ? rows[0].value : null;
  } catch { return null; }
}
export async function writeRow(key, value, fetchImpl = fetch) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`could not store ${key} (${r.status})`);
}
export async function readConnection(fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(GOOGLE_ROW_KEY)}&select=value,updated_at`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null; const rows = await r.json(); return rows[0] && rows[0].value ? rows[0].value : null;
  } catch { return null; }
}
export async function writeConnection(value, fetchImpl = fetch) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: GOOGLE_ROW_KEY, value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`could not store the connection (${r.status})`);
}
export async function deleteConnection(fetchImpl = fetch) {
  await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(GOOGLE_ROW_KEY)}`, { method: "DELETE", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) }).catch(() => {});
}
/** Safe to show in the browser: connected or not, which address, when — never a token. */
export const hasDriveScope = (conn) => !!(conn && typeof conn.scope === "string" && conn.scope.split(/\s+/).includes(DRIVE_SCOPE));
export const hasSendScope = (conn) => !!(conn && typeof conn.scope === "string" && conn.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE));
export function connectionStatus(conn, env = process.env) {
  return { configured: googleConfigured(env), connected: !!(conn && conn.refresh), drive: hasDriveScope(conn), send: hasSendScope(conn), email: conn ? conn.email || null : null, connectedAt: conn ? conn.connectedAt || null : null, mailbox: allowedMailbox(env), scope: GMAIL_SCOPE };
}

/* ---------- tokens ---------- */
export async function exchangeCode(code, redirect, env = process.env, fetchImpl = fetch) {
  const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" }), signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`Google did not issue tokens (${r.status}${data.error ? " " + data.error : ""})`);
  return data; // {access_token, refresh_token, expires_in, scope, id_token}
}
export async function whoAmI(accessToken, fetchImpl = fetch) {
  const r = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.emailAddress) throw new Error(`Gmail profile could not be read (${r.status})`);
  return String(d.emailAddress).toLowerCase();
}
let TOKEN_CACHE = { token: null, until: 0, refresh: null };
export function resetTokenCache() { TOKEN_CACHE = { token: null, until: 0, refresh: null }; }
/** A live access token for the stored connection: refreshed through Google when the cached one is near expiry. */
export async function accessToken(env = process.env, fetchImpl = fetch) {
  const conn = await readConnection(fetchImpl);
  if (!conn || !conn.refresh) { const e = new Error("No Google mailbox is connected — connect it under Settings → Google mail."); e.status = 409; throw e; }
  const refresh = decryptText(conn.refresh, env);
  if (TOKEN_CACHE.token && TOKEN_CACHE.refresh === refresh && Date.now() < TOKEN_CACHE.until) return { token: TOKEN_CACHE.token, email: conn.email };
  const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }), signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) { const e = new Error(`Google refused to refresh the mailbox token (${data.error || r.status}) — reconnect it under Settings → Google mail.`); e.status = 401; throw e; }
  TOKEN_CACHE = { token: data.access_token, until: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000, refresh };
  return { token: data.access_token, email: conn.email };
}
export async function revoke(env = process.env, fetchImpl = fetch) {
  const conn = await readConnection(fetchImpl);
  if (conn && conn.refresh) { try { const refresh = decryptText(conn.refresh, env); await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST", signal: AbortSignal.timeout(10000) }); } catch {} }
  await deleteConnection(fetchImpl); resetTokenCache();
}

/* ---------- Gmail reading ---------- */
const G = "https://gmail.googleapis.com/gmail/v1/users/me";
export async function gmailGet(path, token, fetchImpl = fetch) {
  const r = await fetchImpl(`${G}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Gmail ${r.status}${d.error && d.error.message ? ": " + d.error.message : ""}`); e.status = r.status === 401 ? 401 : 502; throw e; }
  return d;
}
const header = (msg, name) => { const h = ((msg.payload || {}).headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase()); return h ? h.value : ""; };
const b64 = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
export function stripHtml(html) {
  return String(html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** One Gmail message (format=full or metadata) → the plain shape the portal shows. The ONE reading of a message. */
export function parseMessage(msg) {
  const parts = []; const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(msg.payload);
  let text = "", html = "";
  parts.forEach((p) => { const mime = String(p.mimeType || ""); const data = p.body && p.body.data; if (!data || (p.filename && p.filename.length)) return; if (mime === "text/plain" && !text) text = b64(data); else if (mime === "text/html" && !html) html = b64(data); });
  const attachments = parts.filter((p) => p.filename && p.filename.length && p.body && (p.body.attachmentId || p.body.data)).map((p) => ({ attachmentId: p.body.attachmentId || null, filename: p.filename, mimeType: p.mimeType || "application/octet-stream", size: p.body.size || 0, isPdf: /\.pdf$/i.test(p.filename) || p.mimeType === "application/pdf" }));
  const dateMs = Number(msg.internalDate || 0);
  return { id: msg.id, threadId: msg.threadId, from: header(msg, "From"), to: header(msg, "To"), cc: header(msg, "Cc"), subject: header(msg, "Subject"), date: dateMs ? new Date(dateMs).toISOString() : header(msg, "Date"), snippet: msg.snippet || "", labels: msg.labelIds || [], unread: (msg.labelIds || []).includes("UNREAD"), body: (text || stripHtml(html)).slice(0, 20000), attachments, hasAttachments: attachments.length > 0 };
}
export async function listMessages({ q = "", max = 25, pageToken = "" } = {}, token, fetchImpl = fetch) {
  const p = new URLSearchParams({ maxResults: String(Math.min(Math.max(1, max), 50)) }); if (q) p.set("q", q); if (pageToken) p.set("pageToken", pageToken);
  const list = await gmailGet(`/messages?${p}`, token, fetchImpl);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) { // metadata per message: headers + snippet, no body
    const m = await gmailGet(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token, fetchImpl);
    const parsed = parseMessage(m); delete parsed.body; out.push(parsed);
  }
  return { messages: out, nextPageToken: list.nextPageToken || null, resultSizeEstimate: list.resultSizeEstimate || out.length };
}
export async function readMessage(id, token, fetchImpl = fetch) {
  return parseMessage(await gmailGet(`/messages/${encodeURIComponent(id)}?format=full`, token, fetchImpl));
}
/* ---------- Gmail sending ---------- */
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const isOneAddress = (s) => EMAIL_RE.test(String(s || "").trim());
// RFC 2047 for a header that may carry a non-ASCII name or subject (an en dash in "RFQ – …" is one)
const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
const b64wrap = (buf) => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
/** One plain-text message as an RFC 2822 document (multipart/mixed when it carries attachments), base64url for the Gmail API. ONE recipient — never cc, never bcc. */
/* ONE contractor per message — the To line. `cc` is Gradcon's own copy (grady@ by default, more
 * addable — Grady, 26 Oct 2026), never another contractor: the composer builds a separate message per
 * recipient and the server only ever carries the cc list it is handed. Bcc is never written. */
export function buildMime({ to, toName = "", from, fromName = "", subject, text, replyTo = "", attachments = [], cc = [] }) {
  const addr = (name, email) => (name ? `${encodeHeader(String(name).replace(/[\r\n"<>]/g, " ").trim())} <${email}>` : email);
  const ccList = (Array.isArray(cc) ? cc : []).map((c) => String(c || "").trim()).filter((c) => isOneAddress(c) && c.toLowerCase() !== String(to).toLowerCase());
  const head = [
    `From: ${addr(fromName, from)}`,
    `To: ${addr(toName, to)}`,
    ccList.length ? `Cc: ${[...new Set(ccList.map((c) => c.toLowerCase()))].join(", ")}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(String(subject).replace(/[\r\n]+/g, " ").trim())}`,
    "MIME-Version: 1.0",
  ].filter((l) => l !== null);
  const body = b64wrap(Buffer.from(String(text).replace(/\r?\n/g, "\r\n"), "utf8"));
  let lines;
  if (!attachments.length) lines = [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body];
  else {
    const boundary = "gradcon_" + Buffer.from(String(Date.now()) + subject).toString("base64url").slice(0, 24);
    lines = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body];
    for (const a of attachments) {
      const name = String(a.name || "attachment").replace(/[\r\n"]/g, " ").trim();
      lines.push(`--${boundary}`, `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${encodeHeader(name)}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${encodeHeader(name)}"`, "", b64wrap(a.bytes));
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
/* Attachments are fetched by the server from the portal's own public bucket ONLY (Drive files land
 * there through api/drive copy, element drawings live there as quote-markups/…) — never an arbitrary
 * URL — and are capped so a message stays inside Gmail's limit. */
export const ATTACH_URL_PREFIX = "https://xbmyhvrcuyapoarmchpv.supabase.co/storage/v1/object/public/gradcon-files/";
export const ATTACH_MAX_FILES = 10;
/* Gmail refuses a message over 25 MB ENCODED; base64 adds a third, so the raw files must stay under
 * ~18 MB. The composer plans against ATTACH_PLAN_BYTES (a little lower) and sends the rest as
 * download links; the server cap is the hard stop. */
export const ATTACH_MAX_BYTES = 18 * 1024 * 1024;
export const ATTACH_PLAN_BYTES = 17 * 1024 * 1024;
export async function fetchAttachments(list, fetchImpl = fetch) {
  const out = []; let total = 0;
  for (const a of (Array.isArray(list) ? list : []).slice(0, ATTACH_MAX_FILES)) {
    const url = String((a && a.url) || "");
    if (!url.startsWith(ATTACH_URL_PREFIX)) { const e = new Error(`attachment not in the portal's file store: ${url.slice(0, 80)}`); e.status = 400; throw e; }
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) { const e = new Error(`could not fetch attachment ${a.name || url} (${r.status})`); e.status = 502; throw e; }
    const bytes = Buffer.from(await r.arrayBuffer());
    total += bytes.length;
    if (total > ATTACH_MAX_BYTES) { const e = new Error("attachments over 18 MB in total — Gmail's limit; untick the largest file (it is offered as a download link instead) and send again"); e.status = 413; throw e; }
    out.push({ name: String(a.name || url.split("/").pop() || "attachment").slice(0, 120), mimeType: r.headers && r.headers.get ? (r.headers.get("content-type") || "").split(";")[0] || a.mimeType || "application/octet-stream" : a.mimeType || "application/octet-stream", bytes });
  }
  return out;
}
export async function sendMessage({ to, toName, fromName, subject, text, replyTo, attachments = [], cc = [] }, token, email, fetchImpl = fetch) {
  const files = attachments.length ? await fetchAttachments(attachments, fetchImpl) : [];
  const raw = buildMime({ to, toName, from: email, fromName, subject, text, replyTo, attachments: files, cc });
  const r = await fetchImpl(`${G}/messages/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Gmail ${r.status}${d.error && d.error.message ? ": " + d.error.message : ""}`); e.status = r.status === 401 ? 401 : r.status === 403 ? 403 : 502; throw e; }
  return { id: d.id, threadId: d.threadId, labelIds: d.labelIds || [] };
}
export async function attachmentBytes(messageId, attachmentId, token, fetchImpl = fetch) {
  const d = await gmailGet(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, token, fetchImpl);
  return Buffer.from(String(d.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
/** What the chat sees: the newest messages of the last N days, headers and snippets only. */
export async function mailSummaries(env = process.env, { days = 14, max = 25 } = {}, fetchImpl = fetch) {
  const { token, email } = await accessToken(env, fetchImpl);
  const r = await listMessages({ q: `newer_than:${days}d`, max }, token, fetchImpl);
  return { mailbox: email, days, messages: r.messages.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, snippet: m.snippet, unread: m.unread, attachments: m.attachments.map((a) => a.filename) })) };
}

/* ---------- Google Drive reading (drive.readonly) — the ONE adapter ---------- */
const D = "https://www.googleapis.com/drive/v3";
export const DRIVE_FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,iconLink,thumbnailLink,parents,md5Checksum,driveId,shortcutDetails,trashed";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export async function driveGet(path, token, fetchImpl = fetch, { raw = false } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetchImpl(`${D}${path}${sep}supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
  if (raw) {
    if (!r.ok) { const e = new Error(`Drive ${r.status}`); e.status = r.status === 401 ? 401 : r.status === 404 ? 404 : 502; throw e; }
    return r;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Drive ${r.status}${d.error && d.error.message ? ": " + d.error.message : ""}`); e.status = r.status === 401 ? 401 : r.status === 404 ? 404 : 502; throw e; }
  return d;
}
/** The kind the portal shows and previews by: folder / pdf / image / doc / sheet / slides / cad / other. */
export function fileKind(mimeType, name) {
  const m = String(mimeType || ""), n = String(name || "").toLowerCase();
  if (m === FOLDER_MIME) return "folder";
  if (m === "application/pdf" || /\.pdf$/.test(n)) return "pdf";
  if (/^image\//.test(m) || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(n)) return "image";
  if (m === "application/vnd.google-apps.document" || /\.docx?$/.test(n)) return "doc";
  if (m === "application/vnd.google-apps.spreadsheet" || /\.xlsx?$|\.csv$/.test(n)) return "sheet";
  if (m === "application/vnd.google-apps.presentation" || /\.pptx?$/.test(n)) return "slides";
  if (/\.(dwg|dxf|dwf|rvt|ifc|skp)$/.test(n)) return "cad";
  return "other";
}
const isGoogleNative = (m) => /^application\/vnd\.google-apps\./.test(String(m || "")) && String(m) !== FOLDER_MIME;
/** One Drive file in the plain shape the portal shows. The ONE reading of a file. */
export function normalizeFile(f) {
  if (!f) return null;
  return { id: f.id, name: f.name || "", mimeType: f.mimeType || "", kind: fileKind(f.mimeType, f.name), size: f.size != null ? Number(f.size) : null, modifiedTime: f.modifiedTime || null, webViewLink: f.webViewLink || `https://drive.google.com/${f.mimeType === FOLDER_MIME ? "drive/folders" : "file/d"}/${f.id}`, iconLink: f.iconLink || null, thumbnailLink: f.thumbnailLink || null, parents: f.parents || [], md5: f.md5Checksum || null, driveId: f.driveId || null, native: isGoogleNative(f.mimeType) };
}
export async function driveFile(id, token, fetchImpl = fetch) {
  return normalizeFile(await driveGet(`/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`, token, fetchImpl));
}
const q = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
/** The children of a folder, folders first then by name; one page. */
export async function driveChildren(folderId, token, fetchImpl = fetch, { pageToken = "", max = 200, foldersOnly = false } = {}) {
  const p = new URLSearchParams({ q: `'${q(folderId)}' in parents and trashed = false${foldersOnly ? ` and mimeType = '${FOLDER_MIME}'` : ""}`, fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`, pageSize: String(Math.min(Math.max(1, max), 1000)), orderBy: "folder,name", includeItemsFromAllDrives: "true", corpora: "allDrives" });
  if (pageToken) p.set("pageToken", pageToken);
  const d = await driveGet(`/files?${p}`, token, fetchImpl);
  return { files: (d.files || []).map(normalizeFile), nextPageToken: d.nextPageToken || null };
}
/** The chain of parents from a file up to its root (nearest first), at most 10 hops; `cache` memoises across one request. */
export async function driveAncestors(id, token, fetchImpl = fetch, cache = new Map()) {
  const out = []; let cur = id; const seen = new Set();
  for (let hop = 0; hop < 10 && cur && !seen.has(cur); hop++) {
    seen.add(cur);
    let f = cache.get(cur);
    if (!f) { try { f = await driveFile(cur, token, fetchImpl); } catch { break; } cache.set(cur, f); }
    const parent = f.parents && f.parents[0];
    if (!parent) break;
    let pf = cache.get(parent);
    if (!pf) { try { pf = await driveFile(parent, token, fetchImpl); } catch { pf = { id: parent, name: "", kind: "folder", parents: [] }; } cache.set(parent, pf); }
    out.push({ id: pf.id, name: pf.name });
    cur = parent;
  }
  return out;
}
/** Is `id` the root itself or anywhere under it? */
export async function withinRoot(id, rootId, token, fetchImpl = fetch, cache = new Map()) {
  if (!rootId) return true;
  if (id === rootId) return true;
  const anc = await driveAncestors(id, token, fetchImpl, cache);
  return anc.some((a) => a.id === rootId);
}
/** Full-text + name search, kept to files under `within` (the root or a folder beneath it) by their parent chain. */
export async function driveSearch({ text, within, max = 40 }, token, fetchImpl = fetch, cache = new Map()) {
  const t = String(text || "").trim().slice(0, 120);
  if (!t) return { files: [] };
  const p = new URLSearchParams({ q: `trashed = false and (name contains '${q(t)}' or fullText contains '${q(t)}')`, fields: `files(${DRIVE_FILE_FIELDS})`, pageSize: "100", orderBy: "modifiedTime desc", includeItemsFromAllDrives: "true", corpora: "allDrives" });
  const d = await driveGet(`/files?${p}`, token, fetchImpl);
  const hits = (d.files || []).map(normalizeFile);
  const out = [];
  for (const f of hits) {
    if (out.length >= max) break;
    if (!within || (await withinRoot(f.id, within, token, fetchImpl, cache))) out.push(f);
  }
  return { files: out, scanned: hits.length };
}
/** The bytes of a file — a Google Doc / Sheet / Slides exported as PDF, anything else as stored. Capped. */
export const DRIVE_COPY_MAX_BYTES = 30 * 1024 * 1024;
export async function driveDownload(id, token, fetchImpl = fetch) {
  const meta = await driveFile(id, token, fetchImpl);
  if (meta.kind === "folder") { const e = new Error("that is a folder"); e.status = 400; throw e; }
  if (meta.size != null && meta.size > DRIVE_COPY_MAX_BYTES) { const e = new Error(`file over ${Math.round(DRIVE_COPY_MAX_BYTES / 1048576)} MB`); e.status = 413; throw e; }
  const r = meta.native
    ? await driveGet(`/files/${encodeURIComponent(id)}/export?mimeType=application%2Fpdf`, token, fetchImpl, { raw: true })
    : await driveGet(`/files/${encodeURIComponent(id)}?alt=media`, token, fetchImpl, { raw: true });
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > DRIVE_COPY_MAX_BYTES) { const e = new Error(`file over ${Math.round(DRIVE_COPY_MAX_BYTES / 1048576)} MB`); e.status = 413; throw e; }
  const mimeType = meta.native ? "application/pdf" : (r.headers && r.headers.get && r.headers.get("content-type")) || meta.mimeType || "application/octet-stream";
  const name = meta.native && !/\.pdf$/i.test(meta.name) ? `${meta.name}.pdf` : meta.name;
  return { bytes, mimeType, name, meta };
}
/* ---------- matching a project to its folder (pure) ---------- */
const STOP = new Set(["the", "and", "of", "at", "to", "a", "an", "st", "rd", "ave", "avenue", "street", "road", "dr", "drive", "ct", "court", "pl", "place", "cres", "crescent", "lane", "ln", "way", "vic", "nsw", "qld", "project", "projects", "quote", "tender", "job"]);
export const folderTokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w));
/** How well a folder name fits a project: shared tokens over the project's tokens, a street number counting double, 1 = every token present. */
export function scoreFolderMatch(folderName, { projectName = "", address = "" } = {}) {
  const want = [...new Set([...folderTokens(projectName), ...folderTokens(address)])];
  if (!want.length) return 0;
  const have = new Set(folderTokens(folderName));
  let got = 0, total = 0;
  want.forEach((w) => { const weight = /^\d+[a-z]?$/.test(w) ? 2 : 1; total += weight; if (have.has(w)) got += weight; });
  return total ? got / total : 0;
}
/** The folders ranked for a project; `best` only when one folder clearly fits (score ≥ 0.6 and ahead of the next by 0.2). */
export function matchProjectFolder(folders, quoteLike) {
  const ranked = (folders || []).filter((f) => f && f.kind === "folder").map((f) => ({ ...f, score: scoreFolderMatch(f.name, quoteLike) })).filter((f) => f.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = ranked.length && ranked[0].score >= 0.6 && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.2) ? ranked[0] : null;
  return { candidates: ranked.slice(0, 8), best };
}
/** A Drive folder URL or bare id → the id, or null. */
export function driveFolderIdFrom(text) {
  const s = String(text || "").trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}
