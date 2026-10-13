/**
 * Standard boilerplate + seeding for the Tender Quote (see components/
 * TenderQuoteReport.jsx) — a direct copy of Gradcon's real quotation
 * document (7 Double Creek Road, Flinders — QUOTATION Rev.1), transcribed
 * verbatim so the seeded text is Gradcon's actual known-good standard
 * wording. These are only DEFAULTS: once seeded they live in
 * quote.tenderQuote and every field is freely editable per project.
 *
 * Line items are seeded from the project's own elements — the price from
 * each element's share of the real sell price (computeExternalScopeLines),
 * the dot points from the element's published estimating quantities
 * (concrete m³, reinforcement t, formwork m², mesh m² — the figures that
 * came across from the Estimates tab). Reseeding never runs over a tender
 * the estimator has already edited unless they ask for it.
 */
import { uid, computeElementCost, labourQuantities, computeExternalScopeLines, getDefaultMargin } from "./costing.js";
import { ELEMENT_TYPES } from "../data/catalog.js";

export const TENDER_INCLUSIONS = [
  "All detailed excavation.",
  "Includes the supply and placement of a 50mm minimum compacted sand bed as required.",
  "Includes the supply and placement of a polythene waterproof membrane as required.",
  "Includes the supply and placement all reinforcement to the correct requirements as per the structural documentation.",
  "Includes the supply and installation of starter bars for block walls, in-situ walls and columns.",
  "Includes the supply and placement of concrete to the correct requirements.",
  "Includes the supply and erection of all formwork and safety rails as required to suspended areas and stairs.",
  "Includes the provision of concrete pumps as required.",
  "Includes curing of the concrete slab.",
  "Includes one Australian Standard concrete test per pour if required (excludes footings & civil works).",
].join("\n");

export const TENDER_SPECIFIC_EXCLUSIONS = [
  "This quotation does not include removal of spoil or loading of trucks. Builder is to ensure the removal of spoil is carried out at such time as not to impede progress. (Refer 'Additional Options' above.)",
  "Dewatering has not been allowed for in this quotation. Builder is to ensure any dewatering is carried out as soon as practically possible to allow continuation of works.",
  "Insulation to slab beam sides is not included.",
  "Supply and placement of cast in plates is excluded from this quotation. Gradcon will assist in the placement as required.",
].join("\n");

export const TENDER_GENERAL_EXCLUSIONS = [
  "Blinding concrete. (Blinding will be charged at the rate specified below).",
  "Concrete pumping to any blinding concrete.",
  "Polystyrene insulation to underside of slab.",
  "Lagging to pipes within the slab.",
  "Rock excavation.",
  "Tanking or waterproofing.",
  "Any backfill, compacted or loose.",
  "Preparation of sub grade including replacement of soft spots.",
  "Planking and strutting to excavations.",
  "Propping and strutting of any existing structures.",
  "Selected finishes including colour, hardeners and sealers.",
  "Termite treatment.",
  "Placement of any HD bolts or cast in items.",
  "Bulk excavation or site cut or scrape.",
  "Precast panels or dowels to precast panels.",
  "Corking or sealing to saw cuts or constructions joints.",
  "Trench grates, pit lids or frames.",
  "Set out works and datum set up.",
  "Saw cutting or demolition of any existing concrete slabs, footings or paving.",
  "Cavity filling to any block work or retaining walls.",
  "Any reo to block or brick retaining walls, including starter bars from blockwork to suspended areas.",
  "Access towers.",
  "Access to all work areas must be available at all times.",
  "Any crane or hoisting.",
  "Propping footings to support precast panels unless specified in the quotation.",
  "Grouting of any kind (e.g. base plates, precast panels, underpinning).",
  "Any grano screeds or toppings unless specified in the quotation.",
  "Traffic Control or permits for concrete pump set up and deliveries.",
  "Filling of any pockets or voids formed in the slab, e.g. column rebates and PT pockets.",
  "Location of any existing services to be marked out by the builder before excavation is started.",
  "Protection of any existing concrete floors, paving or kerbs.",
].join("\n");

export const TENDER_CONTRACTUAL_CONDITIONS = `1) Allowances:
   a. Concrete:
      All material allowances are derived from minimum sizes and dimensions given in the structural drawings. Slabs requiring deeper beams will require additional concrete at blinding rate.
   b. Formwork:
      Additional formwork required for an elevated slab will incur additional costs unless clearly noted on the quote (i.e. deepened edge beams etc). This price includes a maximum 400mm edge form set up.

2) Additional Costs:
   a. Fill:
      Additional sand required to fill sites will be charged $65.00 per m3 + GST.
   b. Blinding:
      The supply of any blinding concrete due to collapsing ground conditions or increased beam depth required to achieve founding depth will be charged at $365.00 per m3 + GST which covers excavation, labour and concrete. (It does not include a pump. If a pump is required, an invoice will be supplied).
   c. Variations:
      Variations can be quoted and agreed upon. Alternatively, all variations will be Cost + 20% margin + GST. A detailed cost report will be provided for review.
   d. Stand down time:
      Stand down time due to delays by builder or other trades will be charged out at $85.00/hr + GST per man and $120.00/hr + GST per machine for plant hire.

3) Safety:
   a. Safety Caps:
      Safety Caps will be provided by Gradcon for all bars posing as hazardous. Caps are to be stored onsite and will be collected once their use is complete. Please advise if and when there are not required.
   b. Handrails:
      Safety handrails associated with formwork will be supplied by Gradcon - Note these temporary handrails will be removed once Gradcon's works have been completed.
   c. Deep Excavation:
      Gradcon has no allowances for safety barriers or shoring associated with deep excavation.
   d. Other:
      Refer to OHS/Insurances section of quotation for other particulars.

4) Site conditions:
   a. Builder is to ensure Gradcon is provided with updated drawings immediately they are issued.
   b. Builder to ensure a suitable access is available for vehicles (crushed rock road base or similar).
   c. Builder to ensure that the site has a toilet.
   d. Builder to ensure that the site has power available.
   e. Builder to ensure that the site has water available.
   f. Builder to ensure that all previous services have been disconnected.
   g. Setout and surveying to be done by the builder including building perimeter (concrete profile) and the location of steps, set downs and rebates.
   h. A bin is to be provided for the excess material generated from the works. If bin is not provided a neat pile of rubbish will be left on site.
   i. Water Control - The builder is, to the best of their ability, to provide a site that assists with surface water control (i.e. cut off drains).

5) Building & Construction Industry Security of Payment Act 2002:
   a. At Gradcon's sole discretion, if there are any disputes or claims for unpaid Services, the provisions of the Building and Construction Industry Security of Payment Act 2002 may apply.
   b. Nothing in this agreement is intended to have the effect of contracting out of any applicable provisions of the Building and Construction Industry Security of Payment Act 2002 of Victoria, except to the extent permitted by the Act where applicable.

6) Quote Conditions:
   a. This quotation is valid for 30 days from date provided on the quote and may be subject to prices rises after that period. Please note that due to the current volatility of pricing & supply of steel reinforcement and concrete, this quotation has a strict validity period of 30 days from time of quotation to commencement of works. Should works not commence within 30 days of this quotation, we reserve the right to review, and if necessary, pass on any increases incurred beyond the validity period.
   b. The quotation is not to have retentions held against it. Unless Agreed to.
   c. Unless "for construction" documents are provided at time of tender, all quotes will subject to review upon final documentation being issued.

7) OHS/Insurances:
   a. Work Cover Insurance Policy. Certificate of Currency provided on request.
   b. Public liability of $20,000,000.00. Certificate of Currency provided on request.
   c. All employees have a current White Card.
   d. Safe Work Method Statements (SWMS) provided as required.
   e. All employees will wear Hi-Vis clothing and hard hats when required.
   f. Material Safety Data Sheets (MSDS) provided on request.`;

export const TENDER_DEFAULT_OPTIONS = [
  { text: "Spoil removal (Provisional Sum based on 100m3). Additional spoil removal will be charged at $40.00/m3 + GST", price: "$7,600.00 + GST" },
  { text: "Bin hire rubbish/rubbish management", price: "$600.00 per skip + GST" },
  { text: "Blinding Contingency", price: "$365.00/m3 + GST" },
];

/** The STAGES a tender is laid out in — the one fixed list every quote uses
 * (Grady, 13 Oct 2026, from his colour-coded printed quote and spreadsheet:
 * "yes that is the standard stage list … the stages in quote should not
 * change"). There is NO Vertical Structure stage: "vertical structures should
 * be only for each level" — a column or wall sits under the level it stands
 * on. The order here is the print order; a stage with nothing under it is
 * left off the document. */
export const TENDER_STAGES = [
  { key: "retention", title: "Retention" },
  { key: "basement", title: "Basement" },
  { key: "lower_ground", title: "Lower Ground" },
  { key: "ground", title: "Ground Floor" },
  { key: "first", title: "First Floor" },
  { key: "second", title: "Second Floor" },
  { key: "roof", title: "Roof" },
  { key: "external", title: "External Works" },
];
export const stageTitle = (key) => { const st = TENDER_STAGES.find((x) => x.key === key); return st ? st.title : ""; };
export const stageIndex = (key) => { const i = TENDER_STAGES.findIndex((x) => x.key === key); return i < 0 ? TENDER_STAGES.length : i; };
export const isStageKey = (key) => TENDER_STAGES.some((x) => x.key === key);

/** The building level named at the start of an element label ("Basement - …",
 * "Ground Floor Raft", "First floor columns …"); `levelStage(label)` reads it
 * as a stage key, null when the label names none. */
export const LEVEL_PREFIX = /^(lower ground floor|lower ground|basement|ground floor|ground|first floor|second floor|third floor|fourth floor|fifth floor|first|second|third|fourth|fifth|level\s*\d+|l\d+\b|mezzanine|podium|rooftop|roof)/i;
const LEVEL_WORD = /\b(lower ground(?: floor)?|\blg\b|basement|\bb[12]\b|ground floor|ground level|upper ground|\bgf\b|\bground\b|podium|first floor|mezzanine|\bmezz\b|second floor|third floor|fourth floor|fifth floor|level\s*(\d+)|\bl(\d+)\b|rooftop|roof)\b/i;
/** The building level an element label names ANYWHERE in it ("Strip Footings
 * - Basement", "RC Columns - Basement to Ground floor" → the FIRST level named
 * is the one the element stands on), as a stage key; null when none. A level
 * above the second has no stage of its own in the standard list — it lands on
 * Second Floor and the review says so. */
export function levelStage(label) {
  const m = String(label || "").match(LEVEL_WORD);
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/\s+/g, " ").trim();
  const n = m[2] || m[3];
  if (n != null) return Number(n) <= 1 ? "first" : "second";
  if (w.startsWith("basement") || w === "b1" || w === "b2") return "basement";
  if (w.startsWith("lower ground") || w === "lg") return "lower_ground";
  if (w.startsWith("ground") || w === "upper ground" || w === "gf" || w === "podium") return "ground";
  if (w === "first floor" || w === "mezzanine" || w === "mezz") return "first";
  if (w === "second floor") return "second";
  if (w === "roof" || w === "rooftop") return "roof";
  return "second"; // third / fourth / fifth floor
}
/** Retention work named on its face — piles, piers, capping beams, shotcrete, retaining — belongs to the Retention stage whatever its catalog band (Grady's printed quote lists bored piers and the capping beam under RETENTION). */
const RETENTION_WORD = /\b(piles?|piling|piers?|capping beams?|shotcrete|retaining|retention|soldier|anchors?|sheet pil\w*)\b/i;
const CATEGORY_STAGE = { "RETENTION & TEMPORARY WORKS": "retention", ROOF: "roof", "EXTERNAL & LANDSCAPE CONCRETE": "external", "CIVIL & INFRASTRUCTURE": "external", "POOL CONSTRUCTION": "external", "SUSPENDED STRUCTURE": "ground" };
const LEVEL_ORDER = ["basement", "lower_ground", "ground"];
/** The lowest building level any element of the quote names — where the
 * footings, the columns and the earthworks of an unlabelled element belong
 * (the basement when the job has one, else the lower ground, else the ground). */
export function lowestLevel(items) {
  let best = null;
  (items || []).forEach((it) => { const st = levelStage(it && it.label); if (st && LEVEL_ORDER.includes(st) && (best == null || LEVEL_ORDER.indexOf(st) < LEVEL_ORDER.indexOf(best))) best = st; });
  return best || "ground";
}
/** The stage an element falls under BEFORE anyone has placed it (the AI
 * placement in the reword review and the row's own select override it, and
 * `tenderQuote.elementStages` remembers the decision): the level named anywhere in its
 * label or in its element type's name first; retention work by name; retention, roof, external and
 * suspended work by catalog category; everything else — footings, slabs on
 * ground, columns, walls, earthworks, preliminaries — on the lowest level the
 * quote names. */
export function defaultStageFor(item, allItems, elementTypes = ELEMENT_TYPES) {
  const byLabel = levelStage(item && item.label);
  if (byLabel) return byLabel;
  const type = (elementTypes || []).find((t) => t.id === (item && item.typeId));
  const byType = type ? levelStage(type.name) : null; // "Basement Slab", "Roof Beam"
  if (byType) return byType;
  const cat = String((item && item.category) || "").toUpperCase();
  if (cat === "RETENTION & TEMPORARY WORKS" || RETENTION_WORD.test(String((item && item.label) || "")) || (type && RETENTION_WORD.test(type.name))) return "retention";
  if (CATEGORY_STAGE[cat]) return CATEGORY_STAGE[cat];
  return lowestLevel(allItems || []);
}
/** The stage a tender places an element under: the recorded decision, else the rule. */
export function stageForElement(item, allItems, elementStages) {
  const rec = elementStages && item && elementStages[item.id];
  return isStageKey(rec) ? rec : defaultStageFor(item, allItems);
}

const titleCase = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
export const fmtTenderPrice = (n) => (n > 0 ? `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + GST` : "");

/** A line item's rows — `lines` [{id, elementId, name, text, price}] is the
 * stored form (one row per element, each with its own price); a tender saved
 * before 13 Oct 2026 holds only `points` (strings, no row prices) and reads
 * as rows with no element and no price. ONE reading for the editor, the print,
 * the drift, the reword and the spec context. */
export function itemLines(item) {
  if (item && Array.isArray(item.lines)) return item.lines;
  return (item && Array.isArray(item.points) ? item.points : []).map((p, i) => ({ id: `${item.id}:${i}`, elementId: null, name: "", text: String(p == null ? "" : p), price: "" }));
}
/** Every item carries `lines` (its `points` become rows once) and `points`
 * mirrors the texts for a build that still reads them; blank trailing rows
 * are dropped. Lossless on a tender from before the stage layout. */
export function normalizeTenderItems(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const lines = itemLines(it).map((l) => ({ id: l.id || uid(), elementId: l.elementId || null, name: String(l.name || ""), text: String(l.text == null ? "" : l.text), price: String(l.price == null ? "" : l.price) }));
    while (lines.length && !lines[lines.length - 1].text.trim() && !lines[lines.length - 1].price.trim() && !lines[lines.length - 1].elementId) lines.pop();
    return { ...it, lines, points: lines.map((l) => l.text) };
  });
}
/** A line item's price in dollars: the SUM of its rows' prices when any row
 * carries one (a stage total is never typed — Grady, 13 Oct 2026: "per element
 * prices should be printed under the right category"), else the item's own
 * typed price (a hand-added item, or a tender from before the stage layout). */
export function itemPriceValue(item) {
  const lines = itemLines(item);
  if (lines.some((l) => String(l.price || "").trim())) return lines.reduce((s, l) => s + parseTenderPrice(l.price), 0);
  return parseTenderPrice(item && item.price);
}
export const itemHasRowPrices = (item) => itemLines(item).some((l) => String(l.price || "").trim());
/** What the item's price prints as: the row sum as "$… + GST", else the typed price string. */
export const itemPriceLabel = (item) => (itemHasRowPrices(item) ? fmtTenderPrice(itemPriceValue(item)) : String((item && item.price) || ""));

/** Tender line items are the fixed STAGES, each holding one row per element
 * placed under it — the element's dot point (its name and its published
 * estimating quantities in the Project Geometry order: count, run, area,
 * concrete) and its own share of the real sell price. Every element is
 * itemised (Grady, 13 Oct 2026: "i dont want this statement, i want a very
 * professional itemization of them rather than an approximate given" — until
 * then a level with more than four elements rolled the rest into "plus N
 * further items"). The stage comes from `quote.tenderQuote.elementStages`
 * (the AI placement or the row's select, recorded) else `defaultStageFor`.
 * Every field is editable afterwards. */
export function seedTenderItems(quote, items, rates) {
  const { lines } = computeExternalScopeLines(items, rates, quote.overheadPct, quote.contingencyPct, getDefaultMargin(), quote.scope);
  const sellById = {};
  lines.forEach((l) => { sellById[l.id] = l.sellExGst; });
  const fmt = (n, dp = 2) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: dp });
  const elementStages = (quote.tenderQuote && quote.tenderQuote.elementStages) || {};

  // one short summary point per element — name + its most telling figure
  const summarize = (item) => {
    const cost = computeElementCost(item, rates, quote.scope);
    const lq = labourQuantities(item, rates);
    const m = (item.label || "").match(LEVEL_PREFIX);
    let name = item.label || "Element";
    if (m) name = name.slice(m[0].length).replace(/^[\s\-–:]+/, "") || name;
    const figs = [];
    // The area a tender quotes against is the FLOOR AREA the estimator
    // entered against that element in the Quotes section (the Project
    // Geometry table's "Total area (m²)", item.measureM2) — the same figure
    // its $/m² benchmark divides by. It is NOT the Square Mesh coverage in
    // lq.finishM2: on a raft two layers of mesh over one floor is twice the
    // area, and mesh often covers only part of a slab, so quoting the mesh
    // m² prints a floor area the client can't reconcile with the drawing.
    // finishM2 stays the fallback for an element nobody has measured yet
    // (and stays untouched as the finishing crew-day driver in costing.js).
    const areaM2 = Number(item.measureM2) > 0 ? Number(item.measureM2) : lq.finishM2;
    if (Number(item.measureNo) > 0) figs.push(`${fmt(Number(item.measureNo), 0)} no.`);
    if (Number(item.measureLm) > 0) figs.push(`approx. ${fmt(Number(item.measureLm))} lm`);
    if (areaM2 > 0) figs.push(`approx. ${fmt(areaM2)} m²`);
    if (cost.concreteQty > 0) figs.push(`approx. ${fmt(cost.concreteQty)} m³ concrete`);
    if (!figs.length && lq.formworkM2 > 0) figs.push(`approx. ${fmt(lq.formworkM2)} m² formwork`);
    if (!figs.length && lq.reinfTonnes > 0.005) figs.push(`approx. ${fmt(lq.reinfTonnes)} t reinforcement`);
    const sell = sellById[item.id] || 0;
    return { id: uid(), elementId: item.id, name: item.label || "", text: figs.length ? `${name} — ${figs.slice(0, 3).join(" / ")}` : name, price: fmtTenderPrice(sell) };
  };

  // one line item per stage used, in the fixed stage order; elements keep the quote's order inside it
  const byStage = {};
  items.forEach((item) => {
    const key = stageForElement(item, items, elementStages);
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(summarize(item));
  });
  return TENDER_STAGES.filter((st) => byStage[st.key]).map((st) => ({ id: uid(), elementId: null, stage: st.key, title: st.title, price: "", lines: byStage[st.key], points: byStage[st.key].map((l) => l.text) }));
}

/** Moves every element row onto the stage `stageOf(line)` names (a stage key;
 * anything else keeps the row where it is): stage items are rebuilt in the
 * fixed order, an emptied stage item is dropped, a row `stageOf` says nothing
 * about stays with its item, hand-added items (no stage) are untouched. Returns the items
 * and the `elementStages` record to keep on the tender. */
export function regroupByStage(items, stageOf) {
  const list = normalizeTenderItems(items);
  const stageItems = {}; const others = [];
  list.forEach((it) => { if (it.stage && isStageKey(it.stage)) stageItems[it.stage] = { ...it, lines: [] }; else others.push(it); });
  const elementStages = {};
  list.forEach((it) => {
    it.lines.forEach((l) => {
      const want = stageOf(l, it);
      const key = isStageKey(want) ? want : (it.stage && isStageKey(it.stage) ? it.stage : null);
      if (l.elementId && key) elementStages[l.elementId] = key;
      if (!key) { const o = others.find((x) => x.id === it.id); if (o) { if (!o._lines) o._lines = []; o._lines.push(l); } return; }
      if (!stageItems[key]) stageItems[key] = { id: uid(), elementId: null, stage: key, title: stageTitle(key), price: "", lines: [] };
      stageItems[key].lines.push(l);
    });
  });
  const staged = TENDER_STAGES.filter((st) => stageItems[st.key] && stageItems[st.key].lines.length).map((st) => ({ ...stageItems[st.key], points: stageItems[st.key].lines.map((l) => l.text) }));
  const rest = others.map((o) => { const lines = o._lines || []; const { _lines, ...it } = o; return { ...it, lines, points: lines.map((l) => l.text) }; });
  return { items: staged.concat(rest), elementStages };
}

/** The category prices a tender was seeded with against what the quote's
 * elements compute today — the tender's prices are a SNAPSHOT taken when its
 * items were seeded, so a subcontract quote typed afterwards or a changed
 * quantity does not flow into them on its own (8 Oct 2026: four of twelve
 * submitted tenders differed from a fresh computation). Returns one entry per
 * stored item whose title matches a seeded group and whose price differs,
 * plus the seeded groups the tender has no item for. */
export function tenderPriceDrift(quote, items, rates) {
  const tq = quote && quote.tenderQuote;
  if (!tq || !Array.isArray(tq.items)) return { changed: [], missing: [] };
  const fresh = seedTenderItems(quote, items, rates);
  const freshRows = {}; fresh.forEach((f) => f.lines.forEach((l) => { freshRows[l.elementId] = { ...l, stage: f.title }; }));
  const key = (t) => String(t || "").trim().toLowerCase();
  const changed = []; const seen = new Set();
  normalizeTenderItems(tq.items).forEach((it) => {
    const rows = it.lines.filter((l) => l.elementId);
    if (rows.length) {
      rows.forEach((l) => {
        seen.add(l.elementId);
        const f = freshRows[l.elementId]; if (!f) return;
        if (String(f.price) !== String(l.price)) changed.push({ id: l.id, itemId: it.id, elementId: l.elementId, title: `${it.title} · ${l.name || l.text.split(" — ")[0]}`, stored: l.price, fresh: f.price });
      });
      return;
    }
    // a tender from before the stage layout: its level items are compared by title to the stage items
    const f = fresh.find((x) => key(x.title) === key(it.title));
    if (f) { f.lines.forEach((l) => seen.add(l.elementId)); if (fmtTenderPrice(itemPriceValue(f)) !== String(it.price)) changed.push({ id: it.id, title: it.title, stored: it.price, fresh: fmtTenderPrice(itemPriceValue(f)) }); }
  });
  const missing = [];
  fresh.forEach((f) => f.lines.forEach((l) => { if (l.price && !seen.has(l.elementId)) missing.push({ elementId: l.elementId, title: `${f.title} · ${l.name || l.text}`, price: l.price }); }));
  return { changed, missing };
}

/** Bring the tender's prices up to today's figures WITHOUT losing the
 * estimator's edits: each stored item keeps its title and dot points and only
 * its price moves to the fresh figure for that group; seeded groups the
 * tender lacks are appended. Stamps `pricesAt`. */
export function refreshTenderPrices(quote, items, rates, at) {
  const tq = quote.tenderQuote;
  const fresh = seedTenderItems(quote, items, rates);
  const freshRows = {}; fresh.forEach((f) => f.lines.forEach((l) => { freshRows[l.elementId] = l; }));
  const key = (t) => String(t || "").trim().toLowerCase();
  const seen = new Set();
  let kept = normalizeTenderItems(tq.items).map((it) => {
    if (it.lines.some((l) => l.elementId)) {
      const lines = it.lines.map((l) => { if (!l.elementId) return l; seen.add(l.elementId); const f = freshRows[l.elementId]; return f && f.price !== l.price ? { ...l, price: f.price } : l; });
      return { ...it, lines, points: lines.map((l) => l.text) };
    }
    const f = fresh.find((x) => key(x.title) === key(it.title));
    if (f) { f.lines.forEach((l) => seen.add(l.elementId)); const p = fmtTenderPrice(itemPriceValue(f)); return p ? { ...it, price: p } : it; }
    return it;
  });
  // elements not on the tender yet join their stage (the stage item is created in order when the tender lacks it)
  const add = []; fresh.forEach((f) => f.lines.forEach((l) => { if (l.price && !seen.has(l.elementId)) add.push({ ...l, _stage: f.stage }); }));
  if (add.length) {
    const byStage = {}; add.forEach((l) => { const { _stage, ...row } = l; (byStage[_stage] = byStage[_stage] || []).push(row); });
    Object.keys(byStage).forEach((st) => {
      const idx = kept.findIndex((it) => it.stage === st);
      if (idx >= 0) { const lines = kept[idx].lines.concat(byStage[st]); kept[idx] = { ...kept[idx], lines, points: lines.map((l) => l.text) }; }
      else {
        const item = { id: uid(), elementId: null, stage: st, title: stageTitle(st), price: "", lines: byStage[st], points: byStage[st].map((l) => l.text) };
        const after = kept.findIndex((it) => it.stage && stageIndex(it.stage) > stageIndex(st));
        kept = after < 0 ? kept.concat([item]) : kept.slice(0, after).concat([item], kept.slice(after));
      }
    });
  }
  return { ...tq, items: kept, pricesAt: at || new Date().toISOString() };
}

/** A dot point an earlier seed wrote in place of the elements it did not list. */
export const ROLLUP_POINT = /^plus \d+ further items?\b/i;
/** The stored line items still carrying that roll-up (Grady, 13 Oct 2026: "the plus 3 other further items i dont want that going forward"). */
export function rolledUpItems(tq) {
  return (tq && Array.isArray(tq.items) ? tq.items : []).filter((it) => itemLines(it).some((l) => ROLLUP_POINT.test(String(l.text || "").trim())));
}
/** Replaces ONLY the rolled-up items' rows with the fresh seed's itemised rows for the same stage / title (each element on its own row with its own price); every other item is kept. */
export function itemiseRolledUp(quote, items, rates) {
  const tq = quote.tenderQuote || newTenderQuote();
  const fresh = seedTenderItems(quote, items, rates);
  const key = (t) => String(t || "").trim().toLowerCase();
  const next = normalizeTenderItems(tq.items).map((it) => {
    if (!it.lines.some((l) => ROLLUP_POINT.test(String(l.text || "").trim()))) return it;
    const f = fresh.find((x) => (it.stage && x.stage === it.stage) || key(x.title) === key(it.title));
    const lines = f ? f.lines.slice() : it.lines.filter((l) => !ROLLUP_POINT.test(String(l.text || "").trim()));
    return { ...it, stage: it.stage || (f ? f.stage : undefined), lines, points: lines.map((l) => l.text) };
  });
  return { ...tq, items: next };
}

/** What a tender is seeded with for THIS project beyond its line items: the
 * attention company from the project's client (Grady fills it on 10 of 12
 * tenders; the name is his to add). Blank fields only. */
export function tenderPrefill(tq, quote) {
  const next = { ...tq };
  const client = String((quote && quote.clientName) || "").trim();
  if (client && !String(next.attentionCompany || "").trim()) next.attentionCompany = client;
  return next;
}

/** Pull the first number out of a tender price string like
 * "$46,050.47 + GST" or "46050.47". Anything without a digit is $0. */
export const parseTenderPrice = (s) => {
  const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
};

/** The Project Sum block's numbers, all ex-GST until GST is added last —
 * the line-item prices are "+ GST" figures, so the sum of them is ex-GST
 * too. A typed projectSumOverride replaces the items sum entirely (the
 * estimator's negotiated round figure); markup is an EXTRA document-level
 * markup entered as a whole % (10 = 10%) on top of prices that already
 * carry Gradcon's margin from the sell allocation, so it defaults OFF.
 * gstOn defaults ON (tenders normally print the GST and incl-GST lines);
 * legacy tenderQuote objects saved before these fields existed get the
 * same defaults via the `!== false` / falsy checks here. */
export function computeTenderProjectSum(tq, gstRate = 0.1) {
  const itemsSum = (tq.items || []).reduce((s, l) => s + itemPriceValue(l), 0);
  const hasOverride = String(tq.projectSumOverride ?? "").trim() !== "";
  const base = hasOverride ? parseTenderPrice(tq.projectSumOverride) : itemsSum;
  const pct = Number(tq.markupPct);
  const markupOn = !!tq.markupOn && Number.isFinite(pct) && pct !== 0;
  const markupAmt = markupOn ? base * (pct / 100) : 0;
  const exGst = base + markupAmt;
  const gstOn = tq.gstOn !== false;
  const gst = gstOn ? exGst * gstRate : 0;
  return { itemsSum, hasOverride, base, markupOn, markupPct: markupOn ? pct : 0, markupAmt, exGst, gstOn, gst, incGst: exGst + gst };
}

export function newTenderQuote() {
  return {
    rev: "Rev.1",
    date: "",              // blank = the project date
    attentionName: "",
    attentionCompany: "",
    projectTitle: "",      // e.g. "New residence"
    projectAddress: "",    // one line per address line
    items: null,           // null = seed from the quote on first open
    elementStages: {},     // {elementId: stage key} — where each element was placed (AI placement / the row select); seeds and refreshes honour it
    showProjectSum: true,  // print the Project Sum block under the line items
    projectSumOverride: "", // blank = sum of the line items; typed $ replaces it
    markupOn: false,       // extra document-level markup (prices already carry margin)
    markupPct: "",         // whole %, e.g. 10 for 10%
    markupLabel: "Markup",
    gstOn: true,           // print GST and TOTAL incl. GST lines
    additionalOptions: TENDER_DEFAULT_OPTIONS.map((o) => ({ id: uid(), ...o })),
    drawingsArchitect: "",
    drawingsStructural: "",
    drawingsCivil: "",
    tenderNotes: "",
    inclusions: TENDER_INCLUSIONS,
    specificExclusions: TENDER_SPECIFIC_EXCLUSIONS,
    generalExclusions: TENDER_GENERAL_EXCLUSIONS,
    contractualConditions: TENDER_CONTRACTUAL_CONDITIONS,
    signatureName: "Grady Fink",
    signatureTitle: "Director",
  };
}
