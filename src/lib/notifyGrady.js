/**
 * "Notify Grady" from the tender checklist (step 08) — Grady, 2 Nov 2026: "can
 * i include an email and sms notification of summary of completed projects to
 * grady? so when i click inform grady from the checklist, it automatically
 * sends to him"; "lets wire in the sms first". Pure: the text is composed here
 * from the quote's OWN figures (never typed by hand first, always editable
 * before it goes), the record is kept on the quote, the browser request posts
 * only the approved text — api/notify.js holds the recipient.
 */
import { computeMarginRegister, computeProvisionalTotals, projectMargin, money } from "./costing.js";

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
