/**
 * Tender wording for the project's Assumptions — pure, no React, no DOM.
 *
 * Grady, 11 Oct 2026: "language reconstruction for the assumptions before
 * pushing to the tender quote". The estimator types assumptions as shorthand
 * ("Paving slab thickness 150mm and SL82 mesh reinforcment", "Hydronics:
 * Zones 2B and 3B excluded as is under tile - confirm these are included.")
 * and they flow live into the Tender Notes of the External and Tender
 * Quotes (lib/tenderNotes.js). Before the quote goes out the wording is
 * reconstructed into formal tender qualification language — by the AI
 * provider, REVIEWED by a person, and only then stored.
 *
 * Shape: an assumption `{id, text}` gains `tenderText` (the accepted tender
 * wording) and `tenderSource` (the original text it was written from). The
 * estimator's own text is never changed — the quote report and the
 * Assumptions list keep it — only the Tender Notes read the tender wording,
 * through `assumptionTenderLine`. If the original is edited after the
 * rewording, `wordingState` reads "stale" and the cell says so; the stale
 * wording still prints (it was accepted) until it is redone or cleared.
 */

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/** The line the Tender Notes print for one assumption: the accepted tender wording, else the typed text. */
export function assumptionTenderLine(a) {
  if (!a) return "";
  const t = clean(a.tenderText);
  return t || clean(a.text);
}

/** "none" (typed text only), "reworded" (tender wording accepted for this exact text), "stale" (the original changed since). */
export function wordingState(a) {
  if (!a || !clean(a.tenderText)) return "none";
  return clean(a.tenderSource) === clean(a.text) ? "reworded" : "stale";
}

/** The prompt the server sends: one tender line per assumption, same ids, no new facts. */
export function tenderWordingPrompt({ projectName, assumptions }) {
  const rows = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  return `Project: ${projectName || "(unnamed)"}.
Below are the estimator's ASSUMPTIONS for a concrete subcontract tender, typed as working shorthand. Rewrite each one as a formal tender qualification / clarification line for the Tender Notes of the quote, as a Melbourne concrete subcontractor writes to a builder.

Rules:
- One line per assumption, SAME id, same order. Keep every fact, figure, unit, product name, zone and drawing reference exactly; add NOTHING that is not in the shorthand (no new scope, figures or standards).
- Use the trade's conventions: an inclusion reads "Allowance has been made for …" / "Our price includes …"; an exclusion reads "… is excluded from our price" or "No allowance has been made for …"; a figure read off a drawing or taken on the builder's word reads "… has been assumed … and is to be confirmed by the builder / engineer"; a query becomes a request: "Please confirm …". Where the shorthand says confirm / TBC / query, keep that as a confirmation request.
- Correct spelling and grammar, expand abbreviations the builder may not know (e.g. "reo" → "reinforcement", "SL82" stays), keep Australian terms and metric units, one or two sentences, no bullet marks, no headings, no quotes around the line.
- Do not merge or split assumptions; do not reorder.

Reply with ONE JSON object and nothing else: {"lines":[{"id":"<id>","tender":"<the rewritten line>"}]}

ASSUMPTIONS (JSON):
${JSON.stringify(rows)}`;
}

/** Reads the model's reply back onto the assumptions: {id → tender}. Lines matched by id, then by position; blank or missing ones are left out. */
export function parseTenderWording(text, assumptions) {
  const list = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  let doc = null;
  const s = String(text == null ? "" : text);
  try { doc = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch { doc = null; } }
  }
  const lines = doc && Array.isArray(doc.lines) ? doc.lines : Array.isArray(doc) ? doc : [];
  const out = {};
  lines.forEach((l, i) => {
    if (!l) return;
    const tender = clean(typeof l === "string" ? l : l.tender || l.text || l.line);
    if (!tender) return;
    const id = l && l.id != null ? String(l.id) : null;
    const target = (id && list.find((a) => a.id === id)) || (!id && list[i]) || null;
    if (target && !out[target.id]) out[target.id] = tender;
  });
  return out;
}

/** Writes accepted wording onto the assumptions: `accepted` = {id → tender line}; everything else untouched. */
export function applyTenderWording(assumptions, accepted) {
  const acc = accepted || {};
  return (assumptions || []).map((a) => {
    const t = clean(acc[String(a.id)]);
    if (!t) return a;
    return { ...a, tenderText: t, tenderSource: clean(a.text) };
  });
}

/** Removes the tender wording from one assumption (the typed text stands again). */
export function clearTenderWording(assumptions, id) {
  return (assumptions || []).map((a) => {
    if (String(a.id) !== String(id)) return a;
    const { tenderText, tenderSource, ...rest } = a; // eslint-disable-line no-unused-vars
    return rest;
  });
}

/** Asks the portal's AI function for the wording (never autonomous — a button click calls this). `fetchImpl` / `base` are test seams. */
export async function requestTenderWording(assumptions, { projectName, provider, fetchImpl, base } = {}) {
  const rows = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  if (!rows.length) throw new Error("No assumptions to reword.");
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "tender-wording", provider: provider || undefined, projectName: projectName || "", assumptions: rows }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  const proposals = Array.isArray(body && body.lines) ? body.lines : [];
  const map = {};
  proposals.forEach((l) => { if (l && l.id != null && clean(l.tender)) map[String(l.id)] = clean(l.tender); });
  return { wording: map, provider: body && body.provider, model: body && body.model, missing: rows.filter((r) => !map[r.id]).map((r) => r.id) };
}

/* ---------------- Tender Quote line items (titles and dot points) ---------------- */

/** The prompt for the Tender Quote's line items: every level's title and its itemised dot points rewritten as professional tender descriptions — same ids, same number of points, every figure kept. */
export function tenderItemsPrompt({ projectName, items }) {
  const rows = (items || []).map((l) => ({ id: String(l.id), title: clean(l.title), points: (l.points || []).map(clean).filter(Boolean) }));
  return `Project: ${projectName || "(unnamed)"}.
Below are the PROJECT DETAILS line items of a concrete subcontract tender quote: each item is a building level (or work group) with its price (not shown — never write one) and one dot point per structural element, typed by the estimator as shorthand from the takeoff ("Strip Footings - Basement — approx. 35.28 m² / approx. 18.53 m³ concrete").
Rewrite them as a professional itemised description for the client, as a Melbourne concrete subcontractor writes to a builder.

Rules:
- Same ids, same order; the SAME NUMBER of dot points per item, in the same order — one per element, never merged, split, dropped or added.
- Keep every figure, unit, grade, element name and level exactly (a figure may be reformatted, e.g. "approx. 35.28 m²" → "approximately 35.28 m² in plan"); add NO figure, scope or product that is not in the shorthand; keep "approx." / "approximately" wherever the shorthand says approx.
- Title: a clean level or work-group name ("Basement", "Ground Floor", "Suspended Structure"), no trailing punctuation.
- Dot point: "<Element>, supply and install, …" style is NOT required — write a tidy noun phrase: the element, then its quantities, e.g. "Bored concrete piles — 16 no., approximately 35.28 m³ of concrete"; expand estimator abbreviations (reo → reinforcement, RC → reinforced concrete), fix spelling, drop stray question marks and internal notes, Australian terms and metric units, no bullet marks, no trailing full stop.

Reply with ONE JSON object and nothing else: {"items":[{"id":"<id>","title":"<title>","points":["<point>", …]}]}

LINE ITEMS (JSON):
${JSON.stringify(rows)}`;
}

/** Reads the model's reply back onto the line items: {id → {title, points}}. A point count that differs from the original is still returned (the review shows it); missing items are left out. */
export function parseTenderItems(text, items) {
  const list = (items || []).map((l) => ({ id: String(l.id), n: (l.points || []).map(clean).filter(Boolean).length }));
  let doc = null;
  const s = String(text == null ? "" : text);
  try { doc = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch { doc = null; } }
  }
  const rows = doc && Array.isArray(doc.items) ? doc.items : [];
  const out = {};
  rows.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const id = r.id != null ? String(r.id) : null;
    const target = (id && list.find((l) => l.id === id)) || (!id && list[i]) || null;
    if (!target || out[target.id]) return;
    const title = clean(r.title);
    const points = Array.isArray(r.points) ? r.points.map(clean).filter(Boolean) : [];
    if (!title && !points.length) return;
    out[target.id] = { title, points, countMatches: points.length === target.n };
  });
  return out;
}

/** Asks the portal's AI function for the line-item wording (a button click calls this). */
export async function requestTenderItemsWording(items, { projectName, provider, fetchImpl, base } = {}) {
  const rows = (items || []).map((l) => ({ id: String(l.id), title: clean(l.title), points: (l.points || []).map(clean).filter(Boolean) })).filter((l) => l.title || l.points.length);
  if (!rows.length) throw new Error("No line items to reword.");
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "tender-wording", kind: "items", provider: provider || undefined, projectName: projectName || "", items: rows }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  const map = {};
  (Array.isArray(body && body.items) ? body.items : []).forEach((r) => { if (r && r.id != null) map[String(r.id)] = { title: clean(r.title), points: Array.isArray(r.points) ? r.points.map(clean).filter(Boolean) : [], countMatches: !!r.countMatches }; });
  return { wording: map, provider: body && body.provider, model: body && body.model, missing: rows.filter((r) => !map[r.id]).map((r) => r.id) };
}

/** The per-browser provider choice the portal Settings keep (`gradcon-preferences.aiProvider`); null when none. */
export function preferredProvider(storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const p = st && JSON.parse(st.getItem("gradcon-preferences") || "null");
    return p && typeof p.aiProvider === "string" && p.aiProvider ? p.aiProvider : null;
  } catch { return null; }
}
