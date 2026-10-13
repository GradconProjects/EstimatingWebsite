/**
 * Specification context for the Tender Quote reword — pure, no React, no DOM.
 *
 * Grady, 13 Oct 2026: "i want the attached API to refine the language of
 * these items and the quote to proper industry standard jargon and language.
 * it should get specifications where needed from the corresponding quote
 * line items and the estimates sections corresponding in name to the
 * project under review". The model is only ever as specific as what it is
 * handed, so each dot point (one element) travels with:
 *   - the Quotes element's priced catalog rows (concrete products, bar sizes,
 *     mesh types, formwork, pumping, insulation, subcontract quotes) and its
 *     free-text description, and
 *   - the Estimates takeoff elements of the same name on the takeoff whose
 *     project name matches the quote's: their calculator fields (grade,
 *     cover, section, bar sizes and spacings, mesh) and their register lines.
 * Nothing here invents a specification: a point with no match carries none,
 * and the prompt tells the model to stay with the quantities then.
 */
import { FULL_CATALOG } from "../data/catalog.js";
import { normalizeElementName } from "./estimateImport.js";
import { LEVEL_PREFIX, itemLines } from "./tenderQuoteDefaults.js";

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);

/** The element's own name once the building level is stripped ("Basement - Piles" → "Piles"). */
export function elementNameForTender(label) {
  const s = clean(label);
  const m = s.match(LEVEL_PREFIX);
  return (m ? s.slice(m[0].length).replace(/^[\s\-–:]+/, "") : s) || s;
}

/** Catalog bands in the order a tender description wants them. */
const SPEC_PRIORITY = ["CONCRETE", "SPECIALIST FINISHING CONCRETE", "PROCESSED BAR", "STOCK BAR", "SQUARE MESH", "TRENCH MESH", "REINFORCEMENT BY RATE", "FORMWORK", "CONCRETE PUMPING", "INSULATION", "SCREEDS", "TOPPINGS", "HYDRONIC HEATING", "SAW CUTS & DOWELS", "OTHER ACCESSORIES", "SUB CONTRACTORS / TEMPORARY WORKS", "OTHER ALLOWANCES", "PRELIMINARIES"];
const FEE_ROW = /minimum cartage|surcharge|levy|washout|short load/i;

/** The Quotes element's priced rows: [{category, product, unit, qty}], priority bands first, fee rows left out, capped. */
export function quoteElementSpec(item, cap = 16) {
  const rows = [];
  Object.entries((item && item.qtys) || {}).forEach(([key, v]) => {
    const q = num(v); if (!(q > 0)) return;
    const [category, product, unit] = String(key).split("::");
    if (FEE_ROW.test(product || "")) return;
    rows.push({ category, product, unit, qty: Math.round(q * 100) / 100 });
  });
  Object.entries((item && item.rateOverrides) || {}).forEach(([key]) => {
    const [category, product, unit] = String(key).split("::");
    if (unit === "quote" && !rows.some((r) => r.product === product)) rows.push({ category, product, unit, note: "subcontract quote received" });
  });
  const rank = (c) => { const i = SPEC_PRIORITY.indexOf(c); return i < 0 ? SPEC_PRIORITY.length : i; };
  rows.sort((a, b) => rank(a.category) - rank(b.category) || (b.qty || 0) - (a.qty || 0));
  (item && Array.isArray(item.additional) ? item.additional : []).forEach((a) => { if (a && clean(a.name) && num(a.qty) > 0) rows.push({ category: a.cat || "OTHER ALLOWANCES", product: clean(a.name), unit: a.unit || "", qty: num(a.qty) }); });
  return rows.slice(0, cap);
}

/** The takeoff fields a description can use, whatever the calculator — only the ones the element carries. */
const FIELD_KEYS = ["grade", "beamGrade", "blindingGrade", "cover", "thickness", "depth", "width", "length", "height", "dia", "diameter", "D", "L", "W", "shape", "slabCategory", "meshType", "botMeshType", "topMeshType", "meshLayers", "botReoType", "botXDia", "botXSpacing", "botYDia", "botYSpacing", "topXDia", "topXSpacing", "topYDia", "topYSpacing", "topMatOn", "botLongDia", "botLongQty", "topLongDia", "topLongQty", "crossDia", "crossSpacing", "ligDia", "ligSpacing", "genSpacing", "vDia", "vBars", "vertADia", "vertASpacing", "horADia", "horASpacing", "stemT", "stemH", "footL", "footD", "reoMethod", "reoRateKgM3", "reoRateDia", "trenchType", "layers", "edgeBeamOn", "edgeBeamWidth", "edgeBeamExtraDepth", "beamStrips", "beamStripsWidth", "beamStripsExtraDepth", "blinding", "slabBlindT", "vapour", "excDepth", "formFinish", "waistT", "risers", "going", "qty"];
const LINE_GROUPS = ["Concrete", "Reinforcement", "Connections", "Joints", "Formwork", "Base/Blinding", "Vapour Barrier", "Insulation", "Finishes", "Excavation"];

/** One takeoff element as the model should see it: type, fields it carries, its register lines (capped). */
export function takeoffElementSpec(inst, lineCap = 14) {
  const d = (inst && inst.data) || {};
  const fields = {};
  FIELD_KEYS.forEach((k) => { const v = d[k]; if (v === undefined || v === null || v === "" || v === false) return; if (typeof v === "object") return; fields[k] = v; });
  const lines = ((inst && inst.results && Array.isArray(inst.results.lines)) ? inst.results.lines : [])
    .filter((l) => l && LINE_GROUPS.includes(l.materialGroup) && num(l.finalQty) > 0)
    .sort((a, b) => LINE_GROUPS.indexOf(a.materialGroup) - LINE_GROUPS.indexOf(b.materialGroup))
    .slice(0, lineCap)
    .map((l) => ({ group: l.materialGroup, material: clean(l.material).slice(0, 90), spec: clean(l.spec).slice(0, 80) || undefined, qty: Math.round(num(l.finalQty) * 100) / 100, unit: l.unit || "" }));
  return { label: clean(inst && inst.label), type: inst && inst.typeKey, fields, lines };
}

/** Takeoff instances whose name matches an element label (level prefix stripped, numbers ignored). */
export function takeoffMatches(instances, label) {
  const want = normalizeElementName(elementNameForTender(label));
  if (!want) return [];
  return (Array.isArray(instances) ? instances : []).filter((i) => {
    const have = normalizeElementName(elementNameForTender(i && i.label));
    return have && (have === want || have.includes(want) || want.includes(have));
  });
}

/** The quote element a dot point describes: its leading name (before " — ") against the elements' names, level stripped. */
export function elementForPoint(point, items) {
  const head = clean(point).split(" — ")[0].split(" - ")[0];
  const want = normalizeElementName(head);
  if (!want) return null;
  const list = Array.isArray(items) ? items : [];
  return list.find((it) => normalizeElementName(elementNameForTender(it.label)) === want)
    || list.find((it) => normalizeElementName(it.label) === normalizeElementName(clean(point).split(" — ")[0]))
    || list.find((it) => { const have = normalizeElementName(elementNameForTender(it.label)); return have && (have.includes(want) || want.includes(have)); })
    || null;
}

/** A project name as tokens for matching: lower case, punctuation dropped, street-type
 * abbreviations expanded, numbers KEPT (the street number is what tells two jobs apart). */
const ABBR = { rd: "road", st: "street", ave: "avenue", av: "avenue", cres: "crescent", crs: "crescent", dr: "drive", ct: "court", pl: "place", hwy: "highway", pde: "parade", tce: "terrace", ln: "lane", blvd: "boulevard", cl: "close", esp: "esplanade" };
const NOISE = new Set(["the", "and", "of", "concrete", "structure", "package", "works", "project", "job", "tender", "quote", "estimate", "takeoff", "vic", "victoria"]);
export function projectNameTokens(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((t) => ABBR[t] || t).filter((t) => !NOISE.has(t));
}
/** How alike two project names are: shared tokens over the shorter list; two names that both start with a street number only match on the same number. */
export function projectNameScore(a, b) {
  const ta = projectNameTokens(a), tb = projectNameTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (/^\d+$/.test(ta[0]) && /^\d+$/.test(tb[0]) && ta[0] !== tb[0]) return 0;
  const set = new Set(tb);
  const shared = ta.filter((t) => set.has(t)).length;
  return shared / Math.min(ta.length, tb.length);
}
/** The takeoff index entry whose project name matches the quote's — the best score of at least 0.6 (exact = 1), newest first on a tie. */
export function findTakeoffEntry(index, projectName) {
  if (!clean(projectName)) return null;
  const rows = (Array.isArray(index) ? index : []).filter((e) => e && e.key && !e.deleted && clean(e.name));
  const scored = rows.map((e) => ({ e, s: projectNameScore(projectName, e.name) })).filter((x) => x.s >= 0.6);
  scored.sort((a, b) => b.s - a.s || String(b.e.savedAt || "").localeCompare(String(a.e.savedAt || "")));
  return scored.length ? scored[0].e : null;
}

/** A stored takeoff row in either schema (v1 uppercase keys or v2) → {project, instances}. */
export function takeoffSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const instances = Array.isArray(value.instances) ? value.instances : Array.isArray(value.INSTANCES) ? value.INSTANCES : null;
  if (!instances) return null;
  return { project: value.project || value.PROJECT || {}, instances };
}

/**
 * The context one reword request carries: for every non-blank dot point of
 * every line item, the matching quote element's rows and description and the
 * matching takeoff elements. `takeoff` = {name, instances} or null. Trimmed to
 * `maxChars` of JSON by shortening the line and row lists, never by dropping a point.
 */
export function tenderSpecContext({ quote, items, lineItems, takeoff, maxChars = 48000 } = {}) {
  const els = Array.isArray(items) ? items : [];
  const instances = takeoff && Array.isArray(takeoff.instances) ? takeoff.instances : [];
  let lineCap = 14, rowCap = 16, takeoffCap = 4;
  const build = () => {
    const points = [];
    (Array.isArray(lineItems) ? lineItems : []).forEach((li) => {
      itemLines(li).forEach((row, index) => {
        const text = clean(row.text); if (!text) return;
        // the row names its element directly (a stage row); a tender from before the stage layout is matched by the point's leading name
        const el = (row.elementId && els.find((it) => it.id === row.elementId)) || elementForPoint(text, els);
        const matches = el ? takeoffMatches(instances, el.label) : takeoffMatches(instances, text.split(" — ")[0]);
        points.push({
          itemId: String(li.id), index, text,
          element: el ? el.label : null,
          elementType: el ? el.typeId : null,
          description: el && clean(el.description) ? clean(el.description).slice(0, 400) : undefined,
          quoteRows: el ? quoteElementSpec(el, rowCap) : [],
          takeoff: matches.slice(0, takeoffCap).map((i) => takeoffElementSpec(i, lineCap)),
        });
      });
    });
    return {
      project: { name: clean(quote && quote.projectName), client: clean(quote && quote.clientName) || undefined, scope: (quote && quote.scope) || "both" },
      takeoff: takeoff ? { name: clean(takeoff.name), elements: instances.length } : null,
      points,
    };
  };
  let ctx = build();
  let json = JSON.stringify(ctx);
  while (json.length > maxChars && (lineCap > 3 || rowCap > 6 || takeoffCap > 1)) { lineCap = Math.max(3, lineCap - 3); rowCap = Math.max(6, rowCap - 3); takeoffCap = Math.max(1, takeoffCap - 1); ctx = build(); json = JSON.stringify(ctx); }
  ctx.matched = { quote: ctx.points.filter((p) => p.element).length, takeoff: ctx.points.filter((p) => p.takeoff.length).length, points: ctx.points.length };
  return ctx;
}
