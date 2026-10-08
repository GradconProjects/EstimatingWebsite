/**
 * The HANDOVER PASS — what Grady does to a project once the estimator marks
 * it "Completed Estimating" (modelled on the 12 Submitted projects and their
 * version histories, 8 Oct 2026), prefilled so he starts from a sheet that
 * already reads the way he would have filled it. Pure: no React, no DOM,
 * verify-covered. Three rules shape everything here:
 *
 *   1. Prefill writes into BLANK cells only, never over a typed figure.
 *      Every cell it fills is an ordinary typed cell afterwards — Grady
 *      changes any of them like before. `quote.handover` records exactly
 *      what was written so the banner can say so and `undoHandover` can
 *      clear only cells that still hold the prefilled value.
 *   2. The bands live in the Rates Library's production rates (the
 *      "Handover: …" rows in PRODUCTION_RATES), so the figures are his to
 *      tune, not the code's.
 *   3. Nothing here prices anything: it only types into the same cells
 *      the crew sheet and the catalog already cost through.
 *
 * The crew sheet he writes (fitted to 25 elements; concreter cells are
 * man-days, always whole numbers):
 *   Site setup / mobilisation   1 man-day on elements over ~20 m³, 2 from 100 m³
 *   Excavate & prepare base     concreters 3 + m³ ÷ 30; excavator 1 day to 45 m³,
 *                               2 days to 150 m³, then m³ ÷ 75; bobcat the same on
 *                               foundations / retention (ground elements only)
 *   Tie reinforcement           steel crew 1 + 2.3 man-days per tonne (min 2);
 *                               concreters tie small jobs (2 + 2.2 per tonne) up
 *                               to 1 t; suspended elements subcontract — tie row
 *                               0 and the tonnage on the "Steel fix" quote row
 *   Pour / place / vibrate      concreters 4 + m³ ÷ 15; pump 8 hrs from 25 m³
 *   Finish / Washout            0 (finishing rides on the pour)
 *   Spare rows renamed          "Material D+C" 2, then "Boxing and Rebates" 2 on
 *                               ground work or "Tool D+C" 1
 */
import { PRODUCTION_RATES, ELEMENT_TYPES } from "../data/catalog.js";
import { labourQuantities, rateKey, lookupRate, isManualQuoteKey, uid } from "./costing.js";

export const HANDOVER_STATUS = "Completed Estimating";
/** Projects completed from this local day on are prefilled automatically on
 * open; anything completed earlier only gets the banner's "Prefill" button,
 * so a quote Grady already worked through by hand is never touched. */
export const HANDOVER_SINCE = "2026-10-08";

export const STEEL_FIX_KEY = rateKey("SUB CONTRACTORS / TEMPORARY WORKS", "Steel fix", "quote");
export const STEEL_MODES = [
  ["auto", "Auto (handover rule)"],
  ["crew", "Steel crew (in-house)"],
  ["concreters", "Concreters tie it"],
  ["subcontract", "Subcontract — tonnes on the Steel fix quote row"],
];

const SUSPENDED = new Set(["SUSPENDED STRUCTURE", "ROOF"]);
const NO_DIG = new Set(["VERTICAL STRUCTURE", "SUSPENDED STRUCTURE", "ROOF", "PRELIMINARIES", "SCREEDS", "TOPPINGS", "HYDRONIC HEATING", "SPECIALIST FINISHING CONCRETE"]);
const BOBCAT_CATS = new Set(["FOUNDATIONS", "RETENTION & TEMPORARY WORKS", "EARTHWORKS"]);

const SETUP = /site setup|mobilis/i;
const EXCAVATE = /excavate/i;
const TIE = /tie (steel|reinforcement)/i;
const POUR = /pour/i;
const FINISH = /finish concrete/i;
const WASHOUT = /washout|tidy|clean/i;
const SPARE = /^additional labour \/ plant$/i;

/** A handover band by its PRODUCTION_RATES key, read through the rates like every production rate. */
export function handoverRate(rates, key) {
  const pr = PRODUCTION_RATES.find((p) => p.key === key);
  if (!pr) return 0;
  const r = lookupRate(rates || {}, rateKey("PRODUCTION", pr.name, pr.unit), { unitCost: pr.rate });
  const n = Number(r && r.unitCost);
  return Number.isFinite(n) ? n : pr.rate;
}

const blank = (v) => v === undefined || v === null || v === "";
const whole = (n) => Math.max(0, Math.round(n));
const isBlankRow = (t) => Object.values(t.qtys || {}).every(blank) && blank(t.qty);

/** The steel-fixing mode an element works under: its own `steelMode` when
 * set, else the handover rule (suspended → subcontract, tiny → concreters,
 * else the steel crew). */
export function steelModeFor(item, rates, lq) {
  const m = item && item.steelMode;
  if (m && m !== "auto") return m;
  const q = lq || labourQuantities(item, rates);
  if (SUSPENDED.has(item.category)) return "subcontract";
  if (q.reinfTonnes > 0 && q.reinfTonnes <= handoverRate(rates, "ho_concreters_tie_max_t")) return "concreters";
  return "crew";
}

/** The cells one steel mode writes on an element's Tie row (and the Steel fix qty). */
function steelCells(item, rates, lq, mode) {
  const t = lq.reinfTonnes || 0;
  const cells = {};
  let steelFixQty = null;
  if (t <= 0) return { cells, steelFixQty };
  if (mode === "crew") {
    cells.steelfixer_day = Math.max(handoverRate(rates, "ho_steel_min_days"), whole(handoverRate(rates, "ho_steel_base_days") + t * handoverRate(rates, "ho_steel_days_per_t")));
  } else if (mode === "concreters") {
    cells.steelfixer_day = 0;
    cells.concreter_day = Math.max(1, whole(handoverRate(rates, "ho_conc_tie_base_days") + t * handoverRate(rates, "ho_conc_tie_days_per_t")));
  } else {
    cells.steelfixer_day = 0;
    steelFixQty = Math.round(t * 100) / 100;
  }
  return { cells, steelFixQty };
}

/** Everything the handover pass WOULD write for these items — cells into blank
 * crew cells, renames of spare rows, the Steel fix tonnage, the steel mode
 * each element lands on. Nothing is applied here. */
export function handoverPlan(items, rates) {
  const plan = { cells: [], rows: [], qtys: [], steel: [] };
  const list = Array.isArray(items) ? items : [];
  const lqs = list.map((it) => labourQuantities(it, rates));
  const maxConc = Math.max(0, ...lqs.map((q) => q.concreteM3 || 0));
  list.forEach((item, i) => {
    const lq = lqs[i];
    const conc = lq.concreteM3 || 0;
    const tasks = item.tasks || [];
    if (conc <= 0 && (lq.reinfTonnes || 0) <= 0) return; // nothing poured, nothing tied — prelims and empty cards stay as they are
    const put = (task, key, value) => {
      if (!task || !blank((task.qtys || {})[key])) return;
      plan.cells.push({ itemId: item.id, taskId: task.id, key, value });
    };
    const find = (re, skip) => tasks.find((t) => re.test(t.name || "") && !(skip && skip.test(t.name || "")));
    // Site setup
    const setup = find(SETUP);
    if (conc >= handoverRate(rates, "ho_setup_min_m3") || (conc > 0 && conc === maxConc)) {
      put(setup, "concreter_day", conc >= handoverRate(rates, "ho_setup_big_m3") ? 2 * handoverRate(rates, "ho_setup_days") : handoverRate(rates, "ho_setup_days"));
    }
    // Excavate & prepare base — ground elements only
    if (conc > 0 && !NO_DIG.has(item.category)) {
      const exc = find(EXCAVATE);
      put(exc, "concreter_day", Math.max(1, whole(handoverRate(rates, "ho_exc_base_days") + conc / Math.max(1e-9, handoverRate(rates, "ho_exc_m3_per_day")))));
      const b1 = handoverRate(rates, "ho_excavator_band1_m3"), b2 = handoverRate(rates, "ho_excavator_band2_m3"), per = Math.max(1e-9, handoverRate(rates, "ho_excavator_m3_per_day"));
      const plantDays = conc <= b1 ? 1 : conc <= b2 ? 2 : Math.max(3, whole(conc / per));
      put(exc, "excavator_day", plantDays);
      if (BOBCAT_CATS.has(item.category)) put(exc, "bobcat_day", plantDays);
    }
    // Tie reinforcement
    const mode = steelModeFor(item, rates, lq);
    plan.steel.push({ itemId: item.id, mode });
    const tie = find(TIE);
    const sc = steelCells(item, rates, lq, mode);
    Object.entries(sc.cells).forEach(([k, v]) => put(tie, k, v));
    if (sc.steelFixQty != null && blank((item.qtys || {})[STEEL_FIX_KEY])) plan.qtys.push({ itemId: item.id, key: STEEL_FIX_KEY, value: sc.steelFixQty });
    // Pour / place / vibrate (the first pour row that is not a blinding pour)
    if (conc > 0) {
      const pour = find(POUR, /blinding/i) || find(POUR);
      put(pour, "concreter_day", Math.max(1, whole(handoverRate(rates, "ho_pour_base_days") + conc / Math.max(1e-9, handoverRate(rates, "ho_pour_m3_per_day")))));
      if (conc >= handoverRate(rates, "ho_pump_min_m3") || SUSPENDED.has(item.category)) put(pour, "pump_hr", handoverRate(rates, "ho_pump_hrs_pour"));
      // Finishing rides on the pour and the tidy-up on the extra rows: a typed
      // 0 stops the auto rule from adding its own days to these cells.
      put(find(FINISH), "concreter_day", 0);
      put(find(WASHOUT), "labourer_day", 0);
    }
    // Spare rows → the rows Grady always adds
    const spares = tasks.filter((t) => SPARE.test(t.name || "") && isBlankRow(t));
    const groundWork = !SUSPENDED.has(item.category) && (lq.formworkM2 > 0 || ["FOUNDATIONS", "SUBSTRUCTURE", "EXTERNAL & LANDSCAPE CONCRETE"].includes(item.category));
    const wanted = [["Material D+C", "ho_material_dc_days"], groundWork ? ["Boxing and Rebates", "ho_boxing_days"] : ["Tool D+C", "ho_tool_dc_days"]];
    wanted.forEach(([name, key], n) => {
      const days = handoverRate(rates, key);
      if (!(days > 0)) return;
      const spare = spares[n];
      if (spare) plan.rows.push({ itemId: item.id, taskId: spare.id, from: spare.name, to: name, key: "concreter_day", value: days });
      else if (n === 0) plan.rows.push({ itemId: item.id, taskId: null, from: null, to: name, key: "concreter_day", value: days }); // no spare row left: add the one row he never skips
    });
  });
  return plan;
}

/** Apply a plan to the quote's items — blank cells only — and record it in
 * `quote.handover` so the banner can say what was filled and undo it. */
export function applyHandover(quote, rates, at) {
  const plan = handoverPlan(quote.items || [], rates);
  const byItem = {};
  const idx = (id) => (byItem[id] = byItem[id] || { cells: [], rows: [], qtys: [] });
  plan.cells.forEach((c) => idx(c.itemId).cells.push(c));
  plan.rows.forEach((r) => idx(r.itemId).rows.push(r));
  plan.qtys.forEach((q) => idx(q.itemId).qtys.push(q));
  const addedRows = [];
  const items = (quote.items || []).map((item) => {
    const p = byItem[item.id];
    if (!p) return item;
    let tasks = (item.tasks || []).map((t) => ({ ...t, qtys: { ...(t.qtys || {}) } }));
    p.cells.forEach((c) => { const t = tasks.find((x) => x.id === c.taskId); if (t && blank(t.qtys[c.key])) t.qtys[c.key] = c.value; });
    p.rows.forEach((r) => {
      if (r.taskId) { const t = tasks.find((x) => x.id === r.taskId); if (t && isBlankRow(t)) { t.name = r.to; t.qtys[r.key] = r.value; } }
      else { const id = uid(); tasks = tasks.concat({ id, name: r.to, qtys: { [r.key]: r.value } }); addedRows.push({ itemId: item.id, taskId: id }); r.taskId = id; }
    });
    const qtys = { ...(item.qtys || {}) };
    p.qtys.forEach((q) => { if (blank(qtys[q.key])) qtys[q.key] = q.value; });
    const steel = plan.steel.find((s) => s.itemId === item.id);
    return { ...item, tasks, qtys, steelMode: item.steelMode || (steel ? steel.mode : undefined) };
  });
  const handover = { at: at || new Date().toISOString(), cells: plan.cells, rows: plan.rows, qtys: plan.qtys, steel: plan.steel, addedRows };
  return { ...quote, items, handover };
}

/** Clear what the pass filled — only cells, rows and quantities that STILL
 * hold the prefilled figure; anything Grady changed since stays. */
export function undoHandover(quote) {
  const h = quote && quote.handover;
  if (!h || h.undoneAt) return quote;
  const same = (a, b) => String(a) === String(b);
  const items = (quote.items || []).map((item) => {
    let tasks = (item.tasks || []).map((t) => ({ ...t, qtys: { ...(t.qtys || {}) } }));
    (h.cells || []).filter((c) => c.itemId === item.id).forEach((c) => { const t = tasks.find((x) => x.id === c.taskId); if (t && same(t.qtys[c.key], c.value)) delete t.qtys[c.key]; });
    (h.rows || []).filter((r) => r.itemId === item.id).forEach((r) => {
      const t = tasks.find((x) => x.id === r.taskId); if (!t) return;
      const untouched = t.name === r.to && same(t.qtys[r.key], r.value) && Object.keys(t.qtys).every((k) => k === r.key || blank(t.qtys[k]));
      if (!untouched) return;
      if ((h.addedRows || []).some((a) => a.taskId === r.taskId)) tasks = tasks.filter((x) => x.id !== r.taskId);
      else { t.name = r.from; delete t.qtys[r.key]; }
    });
    const qtys = { ...(item.qtys || {}) };
    (h.qtys || []).filter((q) => q.itemId === item.id).forEach((q) => { if (same(qtys[q.key], q.value)) delete qtys[q.key]; });
    const steel = (h.steel || []).find((s) => s.itemId === item.id);
    const steelMode = steel && item.steelMode === steel.mode ? undefined : item.steelMode;
    return { ...item, tasks, qtys, steelMode };
  });
  return { ...quote, items, handover: { ...h, undoneAt: new Date().toISOString() } };
}

/** The cells on one element the pass filled and that still hold its figure —
 * what the crew sheet tints. `{taskId: {key: true}}`. */
export function prefilledCells(handover, item) {
  const out = {};
  if (!handover || handover.undoneAt || !item) return out;
  const tasks = item.tasks || [];
  const same = (a, b) => String(a) === String(b);
  (handover.cells || []).filter((c) => c.itemId === item.id).forEach((c) => { const t = tasks.find((x) => x.id === c.taskId); if (t && same((t.qtys || {})[c.key], c.value)) (out[c.taskId] = out[c.taskId] || {})[c.key] = true; });
  (handover.rows || []).filter((r) => r.itemId === item.id).forEach((r) => { const t = tasks.find((x) => x.id === r.taskId); if (t && t.name === r.to && same((t.qtys || {})[r.key], r.value)) (out[r.taskId] = out[r.taskId] || {})[r.key] = true; });
  return out;
}

/** Re-write one element's Tie row (and the Steel fix tonnage) for a chosen
 * steel mode — the explicit per-element switch, so it OVERWRITES the tie
 * row's crew cells (that is the point of switching). */
export function applySteelMode(item, rates, mode) {
  const lq = labourQuantities(item, rates);
  const resolved = mode === "auto" ? steelModeFor({ ...item, steelMode: undefined }, rates, lq) : mode;
  const sc = steelCells(item, rates, lq, resolved);
  const tasks = (item.tasks || []).map((t) => {
    if (!TIE.test(t.name || "")) return t;
    const qtys = { ...(t.qtys || {}) };
    delete qtys.steelfixer_day; delete qtys.concreter_day;
    Object.entries(sc.cells).forEach(([k, v]) => { qtys[k] = v; });
    return { ...t, qtys };
  });
  const qtys = { ...(item.qtys || {}) };
  if (resolved === "subcontract" && sc.steelFixQty != null) qtys[STEEL_FIX_KEY] = sc.steelFixQty;
  else if (resolved !== "subcontract" && Number(qtys[STEEL_FIX_KEY]) > 0 && !(item.rateOverrides && item.rateOverrides[STEEL_FIX_KEY])) delete qtys[STEEL_FIX_KEY]; // an unpriced memo tonnage goes with the mode; a priced quote stays
  return { ...item, tasks, qtys, steelMode: mode };
}

const PRODUCT_NAME = (key) => String(key || "").split("::")[1] || key;

/** What still needs Grady's hand after the pass: subcontract quote rows that
 * carry a quantity but no amount (they price at $0), additional items typed
 * halfway, and element names that read as estimator notes rather than client
 * lines. Pure; the banner and both quote reports render it. */
export function handoverIssues(items, elementTypes) {
  const types = Array.isArray(elementTypes) && elementTypes.length ? elementTypes : ELEMENT_TYPES;
  const unpricedQuoteRows = [], halfEnteredAdditional = [], labelSuggestions = [];
  (items || []).forEach((item) => {
    Object.entries(item.qtys || {}).forEach(([key, qty]) => {
      if (!isManualQuoteKey(key) || !(Number(qty) > 0)) return;
      const ov = item.rateOverrides && item.rateOverrides[key];
      if (!(ov && Number(ov.unitCost) > 0)) unpricedQuoteRows.push({ itemId: item.id, label: item.label, key, product: PRODUCT_NAME(key), qty: Number(qty) });
    });
    (item.additional || []).forEach((a) => {
      const hasName = String(a.name || "").trim() !== "", hasQty = Number(a.qty) > 0, hasRate = Number(a.rate) > 0;
      if (!hasName && !hasQty && !hasRate) return; // an untouched blank row
      if (!hasName || !hasQty || !hasRate) halfEnteredAdditional.push({ itemId: item.id, label: item.label, rowId: a.id, name: a.name || "", qty: a.qty, rate: a.rate, missing: [!hasName && "name", !hasQty && "qty", !hasRate && "rate"].filter(Boolean) });
    });
    const label = String(item.label || "");
    let to = null;
    if (/^\s*SCOPE REQUEST\s*[-–:]\s*/i.test(label)) to = label.replace(/^\s*SCOPE REQUEST\s*[-–:]\s*/i, "Provisional Sum - ");
    else if (/\*\*\*.*EXTERNAL QUOTE ITEMS ONLY.*\*\*\*/i.test(label)) { const t = types.find((x) => x.id === item.typeId); to = t ? t.name : null; }
    else if (/\s*[-–(]\s*receive (actual )?quote.*$/i.test(label)) to = label.replace(/\s*[-–(]\s*receive (actual )?quote.*$/i, "").trim();
    else if (/\?\s*$/.test(label)) to = label.replace(/\s*\?+\s*$/, "").trim();
    if (to && to !== label) labelSuggestions.push({ itemId: item.id, from: label, to });
  });
  return { unpricedQuoteRows, halfEnteredAdditional, labelSuggestions };
}

/** Whether a project opened in the editor should be prefilled now: first
 * entry into Completed Estimating, completed on or after HANDOVER_SINCE, and
 * never prefilled (or undone) before. */
export function shouldAutoHandover(quote) {
  if (!quote || quote.status !== HANDOVER_STATUS || quote.handover) return false;
  const day = quote.completedAt || "";
  return typeof day === "string" && day >= HANDOVER_SINCE;
}

/** Human summary for the banner. */
export function handoverSummary(handover) {
  if (!handover) return "";
  const elements = new Set([...(handover.cells || []).map((c) => c.itemId), ...(handover.rows || []).map((r) => r.itemId), ...(handover.qtys || []).map((q) => q.itemId)]);
  const sub = (handover.steel || []).filter((s) => s.mode === "subcontract").length;
  return `${(handover.cells || []).length} crew cells and ${(handover.rows || []).length} extra rows on ${elements.size} element${elements.size === 1 ? "" : "s"}${sub ? `, steel fixing subcontracted on ${sub}` : ""}`;
}
