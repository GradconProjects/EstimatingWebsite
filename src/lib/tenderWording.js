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

/** The prompt for the Tender Quote: every level's title and its itemised dot points — plus the Additional Options and the Inclusions / Exclusions sections — rewritten in industry-standard tender language, each element specified from the context handed over (Grady, 13 Oct 2026: "proper industry standard jargon and language … get specifications where needed from the corresponding quote line items and the estimates sections"). */
export function tenderItemsPrompt({ projectName, items, spec, options, sections, elements, stages }) {
  const rows = (items || []).map((l) => ({ id: String(l.id), title: clean(l.title), points: (l.points || []).map(clean).filter(Boolean) }));
  const els = (elements || []).map((e) => ({ id: String(e.id), name: clean(e.name), type: clean(e.type) || undefined, category: clean(e.category) || undefined, description: clean(e.description) ? clean(e.description).slice(0, 200) : undefined, stage: clean(e.stage) || undefined })).filter((e) => e.name);
  const stageList = (stages || []).map((st) => ({ key: String(st.key), title: clean(st.title) })).filter((st) => st.key);
  const opts = (options || []).map((o) => ({ id: String(o.id), text: clean(o.text) })).filter((o) => o.text);
  const secs = {}; Object.entries(sections || {}).forEach(([k, v]) => { const lines = String(v == null ? "" : v).split("\n").map(clean).filter(Boolean); if (lines.length) secs[k] = lines; });
  const ctx = spec && spec.points && spec.points.length ? JSON.stringify(spec) : null;
  return `Project: ${projectName || "(unnamed)"}.
Below are the PROJECT DETAILS line items of a concrete subcontract tender quote: each item is a construction STAGE (or a work group) with its price (not shown — never write one) and one dot point per structural element, typed by the estimator as shorthand from the takeoff ("Strip Footings - Basement — approx. 35.28 m² / approx. 18.53 m³ concrete").
Rewrite them as a professional, itemised scope description in proper Australian concrete-industry tender language, as a Melbourne concrete subcontractor writes to a builder.

Rules:
- Same ids, same order; the SAME NUMBER of dot points per item, in the same order — one per element, never merged, split, dropped or added. Never write "further items", "other items" or any line that stands for several elements: every element is named on its own line.
- Keep every figure, unit, grade, element name and level exactly (a figure may be reformatted, e.g. "approx. 35.28 m²" → "approximately 35.28 m² in plan"); keep "approx." / "approximately" wherever the shorthand says approx.
- Industry language: the trade's own terms and standard forms — "supply, place and finish N32 concrete", "SL82 mesh to top, 30 mm cover", "N16 bars at 200 mm centres", "N12 ligatures at 300 mm centres", "bored piers 600 mm diameter", "edge beams 300 × 500 mm", "steel-trowel / broom / helicopter finish", "formwork to exposed faces", "50 mm blinding", "200 µm vapour barrier", "sawn control joints", "cast-in starter bars" — written tightly, as a quantity surveyor or senior estimator writes a priced scope.
- SPECIFICATIONS: ${ctx ? "a SPECIFICATION CONTEXT follows — for each dot point (matched by itemId and index) the quote element's priced rows (concrete products, bar sizes, mesh, formwork, pumping, subcontract quotes, its free-text description) and the matching Estimates takeoff elements (fields such as grade, cover, section sizes, bar sizes and spacings, mesh type; their register lines). Fold the RELEVANT facts from that context into each dot point: concrete grade, section / thickness / diameter, reinforcement (bar size and spacing or mesh type), cover, finish, formwork, blinding, membrane, subcontract items. Use ONLY facts from the context for that point; a point whose context carries nothing stays with its quantities." : "no specification context is available — write from the shorthand alone and add no specification."} Never invent a grade, size, spacing, cover, finish or standard; never write a dollar figure; do not cite standards or clause numbers that are not in the context.
- Title: keep a stage title EXACTLY as given (the stages are a fixed list and never change); a work-group title may be tidied, no trailing punctuation.
${els.length && stageList.length ? `- PLACEMENT: the ELEMENTS list names every element with its current stage. Place each element under the proper construction stage from the STAGES list ONLY (by key): retention work — piles, piers, capping beams, shotcrete, retaining walls, anchors — under Retention; every other element under the LEVEL it stands on or forms — basement footings, basement slab, basement ramp and the columns and walls rising from the basement under Basement; ground floor footings, the ground floor slab or raft, the suspended slab that FORMS the ground floor, and the columns and walls rising from the ground floor under Ground Floor; likewise Lower Ground, First Floor, Second Floor; roof slabs, roof beams, box gutters and parapets under Roof; driveways, paths, paving, pits, kerbs, pools and civil work under External Works. Columns and walls are NEVER a stage of their own: each goes under the level it rises from. Read the level from the element's name, type, category and description; keep the current stage when nothing says otherwise. Return every element in "placement".\n` : ""}
- Dot point: a tidy noun phrase — the element, its specification, then its quantities, e.g. "Bored concrete piers, 600 mm diameter in N40 concrete with N16 vertical bars and N10 ligatures at 200 mm centres — 16 no., approximately 35.28 m³ of concrete"; expand estimator abbreviations (reo → reinforcement, RC → reinforced concrete), fix spelling, drop stray question marks and internal notes, Australian terms and metric units, no bullet marks, no trailing full stop.
${opts.length ? `- ADDITIONAL OPTIONS: rewrite each option's text in the same tender language — same ids, every dollar figure, rate and unit kept EXACTLY as typed (e.g. "$40.00/m3 + GST" stays), one line each.\n` : ""}${Object.keys(secs).length ? `- SECTIONS (inclusions / exclusions): rewrite each line as a standard tender inclusion or exclusion clause — same number of lines per section, same order, every figure kept, no new scope; an exclusion reads as an exclusion, an inclusion as an inclusion.\n` : ""}
Reply with ONE JSON object and nothing else: {"items":[{"id":"<id>","title":"<title>","points":["<point>", …]}]${els.length && stageList.length ? ', "placement":[{"id":"<element id>","stage":"<stage key>"}]' : ""}${opts.length ? ', "options":[{"id":"<id>","text":"<text>"}]' : ""}${Object.keys(secs).length ? ', "sections":{' + Object.keys(secs).map((k) => `"${k}":["<line>", …]`).join(", ") + "}" : ""}}

LINE ITEMS (JSON):
${JSON.stringify(rows)}
${els.length && stageList.length ? `\nSTAGES (JSON):\n${JSON.stringify(stageList)}\n\nELEMENTS (JSON):\n${JSON.stringify(els)}\n` : ""}${opts.length ? `\nADDITIONAL OPTIONS (JSON):\n${JSON.stringify(opts)}\n` : ""}${Object.keys(secs).length ? `\nSECTIONS (JSON):\n${JSON.stringify(secs)}\n` : ""}${ctx ? `\nSPECIFICATION CONTEXT (JSON):\n${ctx}\n` : ""}`;
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

/** The stage the model placed each element under: {elementId → stage key}, stage keys outside `stages` and unknown elements dropped. */
export function parseTenderPlacement(text, { elements, stages } = {}) {
  let doc = null;
  const s = String(text == null ? "" : text);
  try { doc = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch { doc = null; } }
  }
  const ids = new Set((elements || []).map((e) => String(e.id)));
  const keys = new Set((stages || []).map((st) => String(st.key)));
  const out = {};
  (doc && Array.isArray(doc.placement) ? doc.placement : []).forEach((p) => { if (p && p.id != null && ids.has(String(p.id)) && keys.has(String(p.stage))) out[String(p.id)] = String(p.stage); });
  return out;
}

/** The Additional Options and the Inclusions / Exclusions sections of the reply: {options: {id → text}, sections: {name → [lines]}} — a section whose line count differs from the typed one is still returned (the review flags it). */
export function parseTenderExtras(text, { options, sections } = {}) {
  let doc = null;
  const s = String(text == null ? "" : text);
  try { doc = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch { doc = null; } }
  }
  const out = { options: {}, sections: {} };
  const optIds = new Set((options || []).map((o) => String(o.id)));
  (doc && Array.isArray(doc.options) ? doc.options : []).forEach((o) => { if (o && o.id != null && optIds.has(String(o.id)) && clean(o.text)) out.options[String(o.id)] = clean(o.text); });
  const secIn = sections || {};
  Object.keys(secIn).forEach((k) => {
    const got = doc && doc.sections && Array.isArray(doc.sections[k]) ? doc.sections[k].map(clean).filter(Boolean) : null;
    if (!got || !got.length) return;
    const typed = String(secIn[k] == null ? "" : secIn[k]).split("\n").map(clean).filter(Boolean);
    out.sections[k] = { lines: got, countMatches: got.length === typed.length };
  });
  return out;
}

/** Asks the portal's AI function for the line-item wording (a button click calls this). `spec` is the context of lib/tenderSpecContext.js; `options` and `sections` ride along and come back reworded; `elements` + `stages` ask for the PLACEMENT of every element under a stage (Grady, 13 Oct 2026: "use the api calls to place those line items in the proper"), returned as `placement` {elementId → stage key}. */
export async function requestTenderItemsWording(items, { projectName, provider, fetchImpl, base, spec, options, sections, elements, stages } = {}) {
  const rows = (items || []).map((l) => ({ id: String(l.id), title: clean(l.title), points: (l.points || []).map(clean).filter(Boolean) })).filter((l) => l.title || l.points.length);
  if (!rows.length) throw new Error("No line items to reword.");
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const opts = (options || []).map((o) => ({ id: String(o.id), text: clean(o.text) })).filter((o) => o.text);
  const secs = {}; Object.entries(sections || {}).forEach(([k, v]) => { if (clean(v)) secs[k] = String(v); });
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "tender-wording", kind: "items", provider: provider || undefined, projectName: projectName || "", items: rows, spec: spec || undefined, options: opts.length ? opts : undefined, sections: Object.keys(secs).length ? secs : undefined, elements: Array.isArray(elements) && elements.length ? elements : undefined, stages: Array.isArray(stages) && stages.length ? stages : undefined }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  const map = {};
  (Array.isArray(body && body.items) ? body.items : []).forEach((r) => { if (r && r.id != null) map[String(r.id)] = { title: clean(r.title), points: Array.isArray(r.points) ? r.points.map(clean).filter(Boolean) : [], countMatches: !!r.countMatches }; });
  const optionsOut = {}; Object.entries((body && body.options) || {}).forEach(([k, v]) => { if (clean(v)) optionsOut[k] = clean(v); });
  const sectionsOut = {}; Object.entries((body && body.sections) || {}).forEach(([k, v]) => { if (v && Array.isArray(v.lines) && v.lines.length) sectionsOut[k] = { lines: v.lines.map(clean).filter(Boolean), countMatches: !!v.countMatches }; });
  const placement = {}; const stageKeys = new Set((stages || []).map((st) => String(st.key)));
  Object.entries((body && body.placement) || {}).forEach(([k, v]) => { if (stageKeys.has(String(v))) placement[k] = String(v); });
  return { wording: map, options: optionsOut, sections: sectionsOut, placement, provider: body && body.provider, model: body && body.model, missing: rows.filter((r) => !map[r.id]).map((r) => r.id) };
}

/** The per-browser provider choice the portal Settings keep (`gradcon-preferences.aiProvider`); null when none. */
export function preferredProvider(storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const p = st && JSON.parse(st.getItem("gradcon-preferences") || "null");
    return p && typeof p.aiProvider === "string" && p.aiProvider ? p.aiProvider : null;
  } catch { return null; }
}
