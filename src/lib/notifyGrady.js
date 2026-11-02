/**
 * "Notify Grady" from the tender checklist (step 08) — Grady, 2 Nov 2026: "can
 * i include an email and sms notification of summary of completed projects to
 * grady? so when i click inform grady from the checklist, it automatically
 * sends to him"; "lets wire in the sms first". Pure: the text is composed here
 * from the quote's OWN figures (never typed by hand first, always editable
 * before it goes), the record is kept on the quote, the browser request posts
 * only the approved text — api/notify.js holds the recipient.
 */
import { computeMarginRegister, computeProvisionalTotals, projectMargin, money, money2 } from "./costing.js";

/** Grady's address — the ONE recipient of the checklist's email (an address is not a secret; the mailbox that sends is projects@). */
export const GRADY_EMAIL = "grady@gradcon.com.au";

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const localDay = (d) => { const x = d || new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const dayDiff = (iso, today) => { if (!iso) return null; const a = new Date(`${iso}T00:00:00`), b = new Date(`${today}T00:00:00`); return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((a - b) / 86400000); };
const pct = (f) => `${Math.round((Number(f) || 0) * 1000) / 10}%`;
const money0 = (n) => money(Math.round(Number(n) || 0));
const dueWords = (iso, today) => {
  const d = dayDiff(iso, today);
  if (d == null) return "";
  if (d < 0) return `was due ${iso} (${-d}d ago)`;
  if (d === 0) return `due TODAY (${iso})`;
  return `due ${iso} (${d}d)`;
};

/** The figures the text is built from — one reading, so the email (later) says the same things. */
export function notifyFacts(quote, items, rates, { today } = {}) {
  const q = quote || {};
  const its = items || q.items || [];
  const reg = computeMarginRegister(its, rates, q, q.scope);
  const prov = computeProvisionalTotals(its, rates, q.scope);
  const unpriced = its.filter((it) => Object.entries((it && it.qtys) || {}).some(([k, v]) => /::quote$/.test(k) && Number(v) > 0 && !(it.rateOverrides && it.rateOverrides[k] && Number(it.rateOverrides[k].unitCost) > 0))).length;
  return {
    project: clean(q.projectName) || "Untitled project",
    client: clean(q.clientName),
    deadline: (q.planner && q.planner.deadline) || null,
    due: dueWords(q.planner && q.planner.deadline, today || localDay()),
    elements: reg.elements.length,
    directCost: reg.totals.cost,
    sell: reg.totals.sell,
    sellIncGst: reg.totals.sellIncGst,
    projectMargin: projectMargin(q),
    blended: reg.totals.blended,
    pinned: reg.pinned,
    subQuotes: reg.byClass.sub.count,
    subCost: reg.byClass.sub.cost,
    provisional: prov.count,
    unpricedQuotes: unpriced,
    scope: q.scope || "both",
  };
}

/** The text message: short, the figures Grady asks for first, a pointer to the portal. Editable before it goes. */
export function smsSummary(quote, items, rates, { today, portalUrl } = {}) {
  const f = notifyFacts(quote, items, rates, { today });
  const parts = [];
  parts.push(`Gradcon: costings ready for ${f.project}${f.client ? ` (${f.client})` : ""}.`);
  parts.push(`Sell ${money0(f.sell)} ex GST at ${pct(f.blended)}${f.pinned ? " blended" : ""} on ${money0(f.directCost)} direct.`);
  const bits = [`${f.elements} element${f.elements === 1 ? "" : "s"}`];
  if (f.subQuotes) bits.push(`${f.subQuotes} sub quote${f.subQuotes === 1 ? "" : "s"}`);
  if (f.provisional) bits.push(`${f.provisional} provisional`);
  if (f.unpricedQuotes) bits.push(`${f.unpricedQuotes} quote row${f.unpricedQuotes === 1 ? "" : "s"} UNPRICED`);
  if (f.scope !== "both") bits.push(f.scope === "labour" ? "labour only" : "materials only");
  parts.push(`${bits.join(", ")}.`);
  if (f.due) parts.push(`Tender ${f.due}.`);
  parts.push(`Review in the portal${portalUrl ? `: ${portalUrl}` : "."}`);
  return parts.join(" ");
}

/** The email: the same facts in full — every element with its sell and rate, the subcontract quotes, the unpriced
 * rows, the provisional sums, the assumptions, the portal link. Plain text, editable before it goes. */
export function emailSummary(quote, items, rates, { today, portalUrl, by } = {}) {
  const q = quote || {};
  const its = items || q.items || [];
  const f = notifyFacts(q, its, rates, { today });
  const reg = computeMarginRegister(its, rates, q, q.scope);
  const prov = computeProvisionalTotals(its, rates, q.scope);
  const scopeWords = f.scope === "labour" ? "labour only" : f.scope === "materials" ? "materials only" : "labour + materials";
  const L = [];
  L.push("Hi Grady,", "", `The costings for ${f.project} are ready for your review.`, "");
  L.push("PROJECT");
  L.push(`Project: ${f.project}`);
  if (f.client) L.push(`Client: ${f.client}`);
  L.push(`Tender: ${f.due || (f.deadline ? `due ${f.deadline}` : "no deadline recorded")}`);
  L.push(`Scope: ${scopeWords}`);
  L.push("", "PRICE");
  L.push(`Direct cost: ${money2(f.directCost)}`);
  L.push(`Loaded (overheads ${pct(q.overheadPct || 0)}, contingency ${pct(q.contingencyPct || 0)}): ${money2(reg.totals.loaded)}`);
  L.push(`Margin: project ${pct(f.projectMargin)}${f.pinned ? ` · blended ${pct(f.blended)} (${f.pinned} line${f.pinned === 1 ? "" : "s"} pinned at their own rate)` : ""}`);
  L.push(`Sell: ${money2(f.sell)} ex GST (${money2(f.sellIncGst)} inc GST)`);
  L.push("", `ELEMENTS (${reg.elements.length}, sell ex GST)`);
  reg.elements.forEach((e) => {
    const subs = e.lines.filter((l) => l.kind === "sub");
    L.push(`- ${clean(e.label)}: ${money2(e.sell)} at ${pct(e.margin)}${subs.length ? ` (incl. ${subs.map((l) => `${clean(l.name)} ${money2(l.cost)} at ${pct(l.margin)}`).join("; ")})` : ""}`);
  });
  if (f.subQuotes) {
    L.push("", "SUBCONTRACT QUOTES");
    reg.lines.filter((l) => l.kind === "sub").forEach((l) => L.push(`- ${clean(l.name)} on ${clean(l.element)}: ${money2(l.cost)} at ${pct(l.margin)} → sells ${money2(l.sell)}`));
  }
  if (f.unpricedQuotes) {
    L.push("", `QUOTE ROWS STILL UNPRICED (${f.unpricedQuotes} — priced at $0 today)`);
    its.forEach((it) => Object.entries((it && it.qtys) || {}).forEach(([k, v]) => {
      if (/::quote$/.test(k) && Number(v) > 0 && !(it.rateOverrides && it.rateOverrides[k] && Number(it.rateOverrides[k].unitCost) > 0)) L.push(`- ${k.split("::")[1]} on ${clean(it.label)}`);
    }));
  }
  if (prov.count) L.push("", `PROVISIONAL SUMS: ${prov.count} element${prov.count === 1 ? "" : "s"}, ${money2(prov.provisional)} (firm work ${money2(prov.firm)})`);
  const assumptions = (Array.isArray(q.assumptions) ? q.assumptions : []).map((a) => clean(a && (a.tenderText || a.text))).filter(Boolean);
  if (assumptions.length) { L.push("", "ASSUMPTIONS"); assumptions.forEach((a) => L.push(`- ${a}`)); }
  L.push("", `Open the project in the portal${portalUrl ? `: ${portalUrl}` : "."}`);
  L.push("", `Sent from the Gradcon portal${by ? ` by ${by}` : ""} — step 08 of the tender checklist.`);
  return { subject: `Costings ready – ${f.project}${f.due ? ` · tender ${f.due}` : ""}`, text: L.join("\n") };
}

export const SMS_MAX_CHARS = 480;
export function smsSegments(text) {
  const t = String(text || "");
  if (!t) return 0;
  const gsm = /^[A-Za-z0-9@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/.test(t);
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return t.length <= single ? 1 : Math.ceil(t.length / multi);
}

/** The record kept on the quote: `quote.notifications[] = {id, kind, step, to, text, by, at, provider, messageId, segments}`. */
export function notifyRecord({ kind = "sms", step = "notify", to, text, by, provider, messageId, segments, at } = {}) {
  return { id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, kind, step, to: to || null, text: String(text || ""), by: by || null, at: at || new Date().toISOString(), provider: provider || null, messageId: messageId || null, segments: segments || null };
}
export function notifyPatch(quote, record) {
  const list = Array.isArray(quote && quote.notifications) ? quote.notifications : [];
  return { notifications: [...list, record] };
}
export const notificationsOf = (quote) => (quote && Array.isArray(quote.notifications) ? quote.notifications : []);
export const lastNotification = (quote, kind = "sms") => notificationsOf(quote).filter((n) => n.kind === kind).slice(-1)[0] || null;

/** The Google connection's sending status: `{configured, connected, send, email}` from /api/google-auth. */
export async function mailSendStatus({ fetchImpl, base } = {}) {
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/google-auth?action=status`, { method: "GET", headers: { accept: "application/json" } });
  let body = null; try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body) return { configured: false, connected: false, send: false };
  return { configured: !!body.configured, connected: !!body.connected, send: !!body.send, email: body.email || body.mailbox || null };
}
/** POST the approved email to Grady through the projects@ connection (api/gmail.js `send`). Resolves `{id, threadId, to, subject}`. */
export async function requestEmail({ subject, text, fromName }, { fetchImpl, base, to } = {}) {
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/gmail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", to: to || GRADY_EMAIL, toName: "Grady", fromName: fromName || "Gradcon Concrete Constructions", subject: String(subject || ""), text: String(text || "") }) });
  let body = null; try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The mail function answered ${res.status}`);
  const sent = (body && body.sent) || {};
  return { id: sent.id || null, threadId: sent.threadId || null, to: sent.to || to || GRADY_EMAIL, subject: sent.subject || subject };
}

/** GET the SMS status (configured, provider, masked recipient). */
export async function notifyStatus({ fetchImpl, base } = {}) {
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/notify`, { method: "GET" });
  let body = null; try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The notify function answered ${res.status}`);
  return (body && body.sms) || { configured: false, missing: ["unknown"] };
}
/** POST the approved text. Resolves `{ok, provider, id, to, segments}`; throws with the server's reason. */
export async function requestSms(text, { fetchImpl, base } = {}) {
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sms", text: String(text || "") }) });
  let body = null; try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The notify function answered ${res.status}`);
  return body;
}
