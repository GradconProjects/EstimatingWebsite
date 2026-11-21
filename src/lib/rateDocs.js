/**
 * Supplier rate documents read into the Rates Library (Boma, 20 Nov 2026:
 * "in the rates library, i upload the documents for the new rates and it
 * applies same flagging anything not clear and valid till the next rate
 * update. steel usually comes like the uploaded, for concrete rates etc, it
 * should also look at emails and set validity as usual").
 *
 * This file is the READER's side, pure and Node-runnable: the prompt, the
 * reply parser, what one request may carry, and the document-level alarm the
 * Quotes banner reads. The mapping onto library rows, the conversions and the
 * apply are deterministic and live with the page (portal/rates-docs.js) — the
 * model lists what the document says; it never decides a figure.
 *
 * Three rules the prompt holds:
 *   1. a price is copied as written — never computed, rounded, GST-adjusted
 *      or filled in;
 *   2. a line is pointed at a library row only when it is the same product on
 *      the same unit, by the row's id copied from the list it was given —
 *      anything else is `null` with what is unclear said in words;
 *   3. a validity date is only one the document states, with its sentence.
 */
import { scopeFileKind } from "./scopeFinder.js";

export const RATE_DOC_MAX_FILES = 6;
export const RATE_DOC_MAX_TEXT_CHARS = 120000;
export const RATE_DOC_MAX_ROWS = 600;
export const RATE_DOC_MAX_LINES = 300;
export const RATE_DOC_RESULT_KEYS = ["documents", "lines", "notes", "unreadable"];
export const RATE_PER = ["tonne", "sheet", "length", "m", "m2", "m3", "each", "bag", "roll", "hour", "day", "load", "percent", "other"];
export const RATE_KINDS = ["stock_steel", "processed_steel", "sheet_mesh", "trench_mesh", "concrete", "surcharge", "levy", "fee", "accessory", "labour_plant", "formwork", "other"];
export const RATE_MODES = ["price", "increase_amount", "increase_percent"];
export const RATE_GST = ["ex", "inc", "unknown"];
export const RATE_DOC_WARN_DAYS = 14;

const clean = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day as "YYYY-MM-DD", else null. */
export function isoDay(s) {
  const m = ISO.exec(String(s || "").trim()); if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
}

/** The library rows one request may name: id, section, product, unit — trimmed and capped. */
export function rateDocRows(rows) {
  const seen = new Set(); const out = [];
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    const id = clean(r && r.id, 200); if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, section: clean(r.section, 80), name: clean(r.name, 160), unit: clean(r.unit, 24), group: r.group === true });
  });
  return out.slice(0, RATE_DOC_MAX_ROWS);
}

/** Validates one request. Returns an error string, or null when it may run. */
export function rateDocRequestError({ files, text, rows } = {}) {
  const list = Array.isArray(files) ? files : [];
  const t = String(text || "");
  if (!list.length && !t.trim()) return "Nothing to read — upload the supplier's rate document, or add the rate email.";
  if (list.length > RATE_DOC_MAX_FILES) return `At most ${RATE_DOC_MAX_FILES} files per read — read the rest as a second one.`;
  for (const f of list) {
    if (!f || typeof f.url !== "string") return "Every file needs a url.";
    if (!scopeFileKind(f.url)) return `Not a PDF or an image the reader can open: ${clean(f.name || f.url, 120)}`;
  }
  if (t.length > RATE_DOC_MAX_TEXT_CHARS) return `The email text is ${t.length.toLocaleString("en-AU")} characters; one read takes up to ${RATE_DOC_MAX_TEXT_CHARS.toLocaleString("en-AU")}. Remove some of it — nothing is cut off silently.`;
  if (!rateDocRows(rows).length) return "The library's row list is missing — reload the Rates Library and try again.";
  return null;
}

export function rateDocPrompt({ rows = [], hasDocuments = false, text = "", today = "" } = {}) {
  const list = rateDocRows(rows);
  return `You are reading supplier rate documents for the Rates Library of Gradcon Concrete Constructions, a concrete contractor in Victoria, Australia: quotations, price lists, price-increase notices and rate emails from steel, concrete and other suppliers. List every price they state so a person can check each one against the library row it belongs to. You read and list; a person approves every figure before it is used, and the arithmetic is done by the application, not by you.

${today ? `Today is ${today}. ` : ""}Dates in these documents are day/month/year (Australian): 06/11/2026 is 6 November 2026.
${hasDocuments ? "The documents are attached." : "No document is attached — read the text at the end."}

Return ONE JSON object, compact (omit null and empty keys):
{
 "documents": [{
   "n": 1,                               // number them from 1; one per supplier document or email that states rates
   "supplier": string,                   // as the document names itself
   "reference": string|null,             // its quote / notice / price-list number
   "issued": "YYYY-MM-DD"|null,
   "validFrom": "YYYY-MM-DD"|null,       // the day new prices take effect, when stated
   "validUntil": "YYYY-MM-DD"|null,      // the day the prices run to, when stated
   "validityQuote": string|null,         // the sentence that states the validity, as written
   "gst": "ex"|"inc"|"unknown",          // whether the prices exclude or include GST, as the document says
   "source": string                      // the file name or the email subject it was read from
 }],
 "lines": [{
   "doc": 1,                             // the document's n
   "description": string,                // the line as written
   "mode": "price"|"increase_amount"|"increase_percent",
   "price": number,                      // the figure as written: no $ sign, no thousands separator
   "per": ${RATE_PER.map((p) => `"${p}"`).join("|")},
   "kind": ${RATE_KINDS.map((p) => `"${p}"`).join("|")},
   "code": string|null,                  // the product code in standard form — see RULES
   "bars": number|null,                  // a trench mesh's number of bars
   "target": string|null,                // the id of the library row this line prices — see RULES
   "confidence": "high"|"medium"|"low",
   "unclear": string|null,               // what is not clear about this line, in a few words
   "page": string|null, "quote": string|null
 }],
 "notes": [{"doc": 1, "text": string}],  // conditions that carry money or timing and are not a price for a row
 "unreadable": [string]                  // pages or attachments you could not read, and why
}

RULES
- "lines": one entry for every priced line, in the document's order. Copy the price as written. Never compute, convert, round, add or remove GST, or fill in a price that is not there. Do not list totals, subtotals, a "total indicative cost", quantities, account numbers or phone numbers.
- "per": the unit the price is for when the document states it or the line's own wording makes it plain (a "standard sheet" is per sheet; "per m3"; "per tonne"). "other" when the document does not say — never guess a unit.
- "kind": stock_steel = stock / straight bar steel; processed_steel = cut-and-bent / scheduled / processed bar; sheet_mesh = SL / RL fabric sheets; trench_mesh = L-series trench mesh; concrete = a concrete mix or grade; surcharge / levy / fee = charges added to a supply (fuel, transport, environment, minimum load, washout, waiting, delivery); accessory = chairs, tie wire, membrane and the like; labour_plant = a pump, crane, crew or hire rate; formwork = formwork and void formers; other = anything else.
- "code": sheet mesh "SL62", "RL818"; trench mesh "L8TM", "L11TM", "L12TM", "L15TM", "L16TM" (an "11mm wire trench mesh" is L11TM, a "12mm" one L12TM) with "bars" = its number of bars; a bar size "N12", "R10"; a concrete strength as its MPa number, "32". Omit it when the line names no code.
- "target": the id of the ONE row in LIBRARY ROWS that is the same product on the same unit, copied exactly. A group id (it ends in ::*) only for a rate that prices that whole group: a per-tonne stock steel rate → stockBar::*, a per-tonne processed steel rate → processedBar::*, an increase applied to every concrete grade → concreteGrade::*. Omit it when no row is the same thing — never pick the nearest row.
- "unclear": say what is not clear — wording you cannot interpret, a unit that is not stated, two rows it could be, a figure that may be a total and not a rate, a price that looks out of line with its neighbours. Do not hide a doubt behind a target; a line can carry both.
- "confidence": high only when the product, the unit and the figure are all plain on the page.
- An increase stated as an amount or a percentage, and not as a new price, is "increase_amount" or "increase_percent" with the amount in "price" (4.5 for 4.5%).
- "validUntil" only when the document states the date its prices run to ("valid until", "prices hold until", "subject to rise and fall after"), with that sentence in "validityQuote". A period ("valid for 30 days") may be turned into a date only when the issue date is stated — say so in "validityQuote". Otherwise omit it.
- "gst": "ex" or "inc" only when the document says so; otherwise "unknown".
- "notes": transport per load, demurrage and waiting time, minimum loads, surcharges that may apply, rise and fall, what the prices include — each as one short sentence.

LIBRARY ROWS (id | section | product | unit)
${list.length ? list.map((r) => `${r.id} | ${r.section} | ${r.name} | ${r.unit}${r.group ? " | GROUP" : ""}`).join("\n") : "(none supplied — leave every target out)"}
${String(text || "").trim() ? `
EMAILS AND PASTED TEXT
${String(text).slice(0, RATE_DOC_MAX_TEXT_CHARS)}` : ""}`;
}

/** The model's reply → `{docs: [{n, supplier, …, lines, notes}], unreadable}`; null when nothing usable. */
export function parseRateDocs(raw, { rows = [] } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const known = new Set(rateDocRows(rows).map((r) => r.id));
  const docs = new Map();
  const docOf = (n) => {
    const k = Number(n) > 0 ? Math.round(Number(n)) : 1;
    if (!docs.has(k)) docs.set(k, { n: k, supplier: "", reference: null, issued: null, validFrom: null, validUntil: null, validityQuote: null, gst: "unknown", source: "", lines: [], notes: [] });
    return docs.get(k);
  };
  (Array.isArray(raw.documents) ? raw.documents : []).forEach((d) => {
    if (!d || typeof d !== "object") return;
    const doc = docOf(d.n);
    doc.supplier = clean(d.supplier, 120); doc.reference = clean(d.reference, 80) || null;
    doc.issued = isoDay(d.issued); doc.validFrom = isoDay(d.validFrom); doc.validUntil = isoDay(d.validUntil);
    doc.validityQuote = clean(d.validityQuote, 300) || null;
    doc.gst = RATE_GST.includes(d.gst) ? d.gst : "unknown";
    doc.source = clean(d.source, 160);
  });
  let count = 0;
  (Array.isArray(raw.lines) ? raw.lines : []).forEach((l) => {
    if (!l || typeof l !== "object" || count >= RATE_DOC_MAX_LINES) return;
    const description = clean(l.description, 240); if (!description) return;
    const price = typeof l.price === "number" ? l.price : Number(String(l.price == null ? "" : l.price).replace(/[$,\s]/g, ""));
    const target = clean(l.target, 200);
    const doc = docOf(l.doc);
    const bars = Number(l.bars);
    doc.lines.push({
      i: doc.lines.length, description,
      mode: RATE_MODES.includes(l.mode) ? l.mode : "price",
      price: Number.isFinite(price) ? price : null,
      per: RATE_PER.includes(l.per) ? l.per : "other",
      kind: RATE_KINDS.includes(l.kind) ? l.kind : "other",
      code: clean(l.code, 24).toUpperCase() || null,
      bars: Number.isFinite(bars) && bars > 0 ? Math.round(bars) : null,
      target: target && known.has(target) ? target : null,
      targetRefused: target && !known.has(target) ? target : null,   // a row the reader named that is not in the library: said, never used
      confidence: ["high", "medium", "low"].includes(l.confidence) ? l.confidence : "low",
      unclear: clean(l.unclear, 240) || null,
      page: l.page == null ? null : clean(l.page, 20) || null,
      quote: clean(l.quote, 200) || null,
    });
    count++;
  });
  (Array.isArray(raw.notes) ? raw.notes : []).forEach((nt) => {
    const text = clean(nt && typeof nt === "object" ? nt.text : nt, 400); if (!text) return;
    const doc = docOf(nt && typeof nt === "object" ? nt.doc : 1);
    if (doc.notes.length < 30 && !doc.notes.includes(text)) doc.notes.push(text);
  });
  const out = [...docs.values()].filter((d) => d.lines.length || d.notes.length || d.supplier).sort((a, b) => a.n - b.n);
  const unreadable = (Array.isArray(raw.unreadable) ? raw.unreadable : []).map((u) => clean(u, 240)).filter(Boolean).slice(0, 20);
  if (!out.length && !unreadable.length) return null;
  return { docs: out, unreadable };
}

/* ---------- the document-level validity alarm (the Quotes banner reads it; the page carries its own copy in portal/rates-docs.js — verify.mjs holds the two to the same answer) ---------- */
const dayMs = (iso) => { const m = ISO.exec(String(iso || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN; };
/**
 * The supplier documents whose rates are about to lapse or have lapsed. A
 * document counts only while it is still the NEWEST one for at least one of
 * the rows it set — once a later document re-prices every row, the earlier
 * one has been superseded and says nothing.
 */
export function supplierDocAlarms(library, today = new Date(), warnDays = RATE_DOC_WARN_DAYS) {
  const docs = library && Array.isArray(library.rateDocs) ? library.rateDocs : [];
  if (!docs.length) return [];
  const t = new Date(today); t.setHours(0, 0, 0, 0);
  const latest = new Map();
  docs.slice().sort((a, b) => String(a.appliedAt || "").localeCompare(String(b.appliedAt || ""))).forEach((d) => (d.rows || []).forEach((r) => latest.set(r.id, d.id)));
  const out = [];
  docs.forEach((d) => {
    const ms = dayMs(d.validUntil); if (!Number.isFinite(ms)) return;
    const current = (d.rows || []).filter((r) => latest.get(r.id) === d.id).length;
    if (!current) return;
    const daysLeft = Math.round((ms - t.getTime()) / 86400000);
    if (daysLeft > warnDays) return;
    out.push({ id: d.id, supplier: d.supplier || "Supplier", reference: d.reference || "", validUntil: d.validUntil, daysLeft, state: daysLeft < 0 ? "expired" : "expiring", rows: current });
  });
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
