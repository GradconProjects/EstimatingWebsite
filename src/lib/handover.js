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
const EXCAVATE = /excavat/i;
const SPOIL = /spoil|soil removal|remove soil|cart away/i;   // "Remove soil", legacy "Remove / cart away spoil"
const TIE = /tie (steel|reinforcement|reo)/i;
const MATERIAL_ROW = /delivery of materials|material d\+c/i;
const BOXING_ROW = /^boxing/i;
const TOOL_ROW = /collection of materials|tool d\+c/i;
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
export function handoverPlan(items, rates, prev) {
  const plan = { cells: [], rows: [], qtys: [], steel: [] };
  const list = Array.isArray(items) ? items : [];
  const lqs = list.map((it) => labourQuantities(it, rates));
  const maxConc = Math.max(0, ...lqs.map((q) => q.concreteM3 || 0));
  const same = (a, b) => String(a) === String(b);
  // The previous record (live mode): a cell that still holds the figure the
  // pass wrote is the pass's to update; one the estimator cleared is never
  // written again; one retyped is theirs.
  const prevCell = (itemId, taskId, key) => (prev && !prev.undoneAt ? (prev.cells || []).find((c) => c.itemId === itemId && c.taskId === taskId && c.key === key) : null);
  const prevRow = (itemId, taskId) => (prev && !prev.undoneAt ? (prev.rows || []).find((r) => r.itemId === itemId && r.taskId === taskId) : null);
  const prevQty = (itemId, key) => (prev && !prev.undoneAt ? (prev.qtys || []).find((q) => q.itemId === itemId && q.key === key) : null);
  const heldRow = (item, t) => { const r = prevRow(item.id, t.id); return !!(r && t.name === r.to && same((t.qtys || {})[r.key], r.value) && Object.keys(t.qtys || {}).every((k) => k === r.key || blank((t.qtys || {})[k]))); };
  list.forEach((item, i) => {
    const lq = lqs[i];
    const conc = lq.concreteM3 || 0;
    const dug = lq.excavationM3 || 0, spoil = lq.soilRemovalM3 || 0;
    const tasks = item.tasks || [];
    if (conc <= 0 && (lq.reinfTonnes || 0) <= 0 && dug <= 0 && spoil <= 0) return; // nothing poured, tied or dug — prelims and empty cards stay as they are
    const put = (task, key, value) => {
      if (!task) return;
      const cur = (task.qtys || {})[key];
      const pc = prevCell(item.id, task.id, key);
      if (pc && (pc.cleared || blank(cur))) return; // the estimator cleared it — never refilled
      if (!blank(cur) && !(pc && same(cur, pc.value))) return; // typed by hand (or retyped) — theirs
      plan.cells.push({ itemId: item.id, taskId: task.id, key, value });
    };
    const find = (re, skip) => tasks.find((t) => re.test(t.name || "") && !(skip && skip.test(t.name || "")));
    // Site setup
    const setup = find(SETUP);
    if (conc >= handoverRate(rates, "ho_setup_min_m3") || (conc > 0 && conc === maxConc)) {
      put(setup, "concreter_day", conc >= handoverRate(rates, "ho_setup_big_m3") ? 2 * handoverRate(rates, "ho_setup_days") : handoverRate(rates, "ho_setup_days"));
    }
    // Excavate & prepare base — ground elements only. The bands run on the
    // Excavation line's m³ the moment it is typed (Grady, 22 Oct 2026: "when
    // they are entered, they should automatically fill in the right cells in
    // the labour and equipment"), else on the concrete as fitted.
    const dig = dug > 0 ? dug : conc;
    if (dig > 0 && !NO_DIG.has(item.category)) {
      const exc = find(EXCAVATE);
      put(exc, "concreter_day", Math.max(1, whole(handoverRate(rates, "ho_exc_base_days") + dig / Math.max(1e-9, handoverRate(rates, "ho_exc_m3_per_day")))));
      const b1 = handoverRate(rates, "ho_excavator_band1_m3"), b2 = handoverRate(rates, "ho_excavator_band2_m3"), per = Math.max(1e-9, handoverRate(rates, "ho_excavator_m3_per_day"));
      const plantDays = dig <= b1 ? 1 : dig <= b2 ? 2 : Math.max(3, whole(dig / per));
      put(exc, "excavator_day", plantDays);
      if (BOBCAT_CATS.has(item.category)) put(exc, "bobcat_day", plantDays);
      // Remove soil: the trucks attend the excavator for the days it digs (no
      // haul productivity is fitted, so the dig days are the rule) — only
      // when there is spoil to cart (the Soil removal line, typed or bulked
      // off the Excavation line).
      if (spoil > 0) put(find(SPOIL), "truck_day", plantDays);
    }
    // Tie reinforcement
    const mode = steelModeFor(item, rates, lq);
    plan.steel.push({ itemId: item.id, mode });
    const tie = find(TIE);
    const sc = steelCells(item, rates, lq, mode);
    Object.entries(sc.cells).forEach(([k, v]) => put(tie, k, v));
    if (sc.steelFixQty != null) {
      const cur = (item.qtys || {})[STEEL_FIX_KEY]; const pq = prevQty(item.id, STEEL_FIX_KEY);
      if (pq && (pq.cleared || blank(cur))) { /* the estimator cleared it — never written again */ }
      else if (blank(cur) || (pq && same(cur, pq.value))) plan.qtys.push({ itemId: item.id, key: STEEL_FIX_KEY, value: sc.steelFixQty });
    }
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
    const spares = tasks.filter((t) => (SPARE.test(t.name || "") && isBlankRow(t)) || heldRow(item, t)); // a blank spare row, or one the pass named before and nobody touched
    const groundWork = !SUSPENDED.has(item.category) && (lq.formworkM2 > 0 || ["FOUNDATIONS", "SUBSTRUCTURE", "EXTERNAL & LANDSCAPE CONCRETE"].includes(item.category));
    const wanted = [["Delivery of materials (yard works)", "ho_material_dc_days", MATERIAL_ROW], groundWork ? ["Boxing", "ho_boxing_days", BOXING_ROW] : ["Collection of materials", "ho_tool_dc_days", TOOL_ROW]];
    let spareIdx = 0;
    wanted.forEach(([name, key, re], n) => {
      const days = handoverRate(rates, key);
      if (!(days > 0)) return;
      // Grady's sheet already carries the row (22 Oct 2026): write its cell, never rename a spare
      const own = tasks.find((t) => re.test(String(t.name || "").trim()));
      if (own) { put(own, "concreter_day", days); return; }
      const spare = spares[spareIdx++];
      if (spare) { const pr = prevRow(item.id, spare.id); plan.rows.push({ itemId: item.id, taskId: spare.id, from: pr ? pr.from : spare.name, to: name, key: "concreter_day", value: days }); }
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

/** The statuses a project is worked in: the live prefill runs on these only
 * (a quote that has gone out, won, lost, missed or on hold never re-prices
 * itself). */
export const LIVE_HANDOVER_STATUSES = new Set(["Queued", "Estimating", "Completed Estimating", "Quoting"]);
/** Whether the live prefill runs on this project right now: not switched off
 * (Undo switches it off), a working status, and — on a finished status — a
 * project completed on or after HANDOVER_SINCE (one Grady worked through by
 * hand before the prefill existed is never touched on its own). */
export function liveHandoverApplies(quote) {
  if (!quote || quote.handoverLive === false) return false;
  const status = quote.status || "Queued";
  if (!LIVE_HANDOVER_STATUSES.has(status)) return false;
  if (status === "Completed Estimating" || status === "Quoting") { const day = quote.completedAt || ""; if (!(typeof day === "string" && day >= HANDOVER_SINCE)) return false; }
  return true;
}

/** The LIVE prefill (Grady, 13 Oct 2026: "i want the prefill to happen
 * realtime and automatically as the values are entered"): the crew sheets
 * follow the quantities as they are typed. Every run re-plans from the current
 * quantities and writes where the cell is blank or still holds the figure the
 * pass wrote last time; a cell retyped by hand is theirs and is left alone; a
 * cell they CLEARED stays clear for good (recorded `cleared`); a cell the new
 * plan no longer wants (the concrete was removed) is cleared again if it still
 * holds the pass's figure; a spare row named by the pass and untouched is
 * re-used, never duplicated. `quote.handover` records what the sheet holds
 * from the pass right now. Returns the SAME quote object when nothing moves,
 * so an effect can call it on every change without looping. */
export function liveHandover(quote, rates, at) {
  const prev = quote.handover && !quote.handover.undoneAt ? quote.handover : null;
  const plan = handoverPlan(quote.items || [], rates, prev);
  const same = (a, b) => String(a) === String(b);
  const byItem = {};
  const idx = (id) => (byItem[id] = byItem[id] || { cells: [], rows: [], qtys: [] });
  plan.cells.forEach((c) => idx(c.itemId).cells.push(c));
  plan.rows.forEach((r) => idx(r.itemId).rows.push(r));
  plan.qtys.forEach((q) => idx(q.itemId).qtys.push(q));
  const planned = (c) => plan.cells.some((x) => x.itemId === c.itemId && x.taskId === c.taskId && x.key === c.key);
  const plannedRow = (r) => plan.rows.some((x) => x.itemId === r.itemId && x.taskId === r.taskId);
  const plannedQty = (q) => plan.qtys.some((x) => x.itemId === q.itemId && x.key === q.key);
  const prevAdded = prev ? prev.addedRows || [] : [];
  const addedRows = [];
  const clearedCells = [], clearedQtys = [];
  let changed = false;
  const items = (quote.items || []).map((item) => {
    const p = byItem[item.id] || { cells: [], rows: [], qtys: [] };
    let tasks = (item.tasks || []).map((t) => ({ ...t, qtys: { ...(t.qtys || {}) } }));
    let touched = false;
    // cells the plan wants
    p.cells.forEach((c) => { const t = tasks.find((x) => x.id === c.taskId); if (t && !same(t.qtys[c.key], c.value)) { t.qtys[c.key] = c.value; touched = true; } });
    // cells written before: cleared by the estimator → remembered; no longer wanted and still held → cleared
    (prev ? prev.cells || [] : []).filter((c) => c.itemId === item.id).forEach((c) => {
      const t = tasks.find((x) => x.id === c.taskId); if (!t) return;
      if (c.cleared) { if (blank(t.qtys[c.key])) clearedCells.push(c); return; }
      if (blank(t.qtys[c.key])) { clearedCells.push({ ...c, cleared: true }); return; }
      if (!planned(c) && same(t.qtys[c.key], c.value)) { delete t.qtys[c.key]; touched = true; }
    });
    // spare rows
    p.rows.forEach((r) => {
      if (r.taskId) { const t = tasks.find((x) => x.id === r.taskId); if (t && (t.name !== r.to || !same(t.qtys[r.key], r.value))) { t.name = r.to; t.qtys[r.key] = r.value; touched = true; } if (t && prevAdded.some((a) => a.taskId === r.taskId)) addedRows.push({ itemId: item.id, taskId: r.taskId }); }
      else { const id = uid(); tasks = tasks.concat({ id, name: r.to, qtys: { [r.key]: r.value } }); addedRows.push({ itemId: item.id, taskId: id }); r.taskId = id; touched = true; }
    });
    (prev ? prev.rows || [] : []).filter((r) => r.itemId === item.id && !plannedRow(r)).forEach((r) => {
      const t = tasks.find((x) => x.id === r.taskId); if (!t) return;
      const untouched = t.name === r.to && same(t.qtys[r.key], r.value) && Object.keys(t.qtys).every((k) => k === r.key || blank(t.qtys[k]));
      if (!untouched) return;
      if (prevAdded.some((a) => a.taskId === r.taskId)) tasks = tasks.filter((x) => x.id !== r.taskId); else { t.name = r.from; delete t.qtys[r.key]; }
      touched = true;
    });
    // the Steel fix tonnage
    const qtys = { ...(item.qtys || {}) };
    p.qtys.forEach((q) => { if (!same(qtys[q.key], q.value)) { qtys[q.key] = q.value; touched = true; } });
    (prev ? prev.qtys || [] : []).filter((q) => q.itemId === item.id).forEach((q) => {
      if (q.cleared) { if (blank(qtys[q.key])) clearedQtys.push(q); return; }
      if (blank(qtys[q.key])) { clearedQtys.push({ ...q, cleared: true }); return; }
      if (!plannedQty(q) && same(qtys[q.key], q.value)) { delete qtys[q.key]; touched = true; }
    });
    // the steel mode: set when unset; followed while it is still the pass's own choice
    const steel = plan.steel.find((s) => s.itemId === item.id);
    const prevSteel = prev ? (prev.steel || []).find((s) => s.itemId === item.id) : null;
    let steelMode = item.steelMode;
    if (steel && (steelMode == null || (prevSteel && steelMode === prevSteel.mode)) && steelMode !== steel.mode) { steelMode = steel.mode; touched = true; }
    if (!touched) return item;
    changed = true;
    return { ...item, tasks, qtys, steelMode };
  });
  const handover = { at: prev ? prev.at : at || new Date().toISOString(), live: true, cells: plan.cells.concat(clearedCells), rows: plan.rows, qtys: plan.qtys.concat(clearedQtys), steel: plan.steel, addedRows };
  const strip = (h) => h && JSON.stringify({ ...h, at: null, updatedAt: null });
  if (!changed && prev && strip(prev) === strip(handover)) return quote;
  if (!changed && !prev && !handover.cells.length && !handover.rows.length && !handover.qtys.length) return quote; // nothing to prefill yet — no record either
  return { ...quote, items, handover: { ...handover, updatedAt: at || new Date().toISOString() } };
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
  return { ...quote, items, handover: { ...h, undoneAt: new Date().toISOString() }, handoverLive: false }; // undo also switches the live prefill off, or it would refill at once
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
  const cells = (handover.cells || []).filter((c) => !c.cleared), qtys = (handover.qtys || []).filter((q) => !q.cleared);
  const elements = new Set([...cells.map((c) => c.itemId), ...(handover.rows || []).map((r) => r.itemId), ...qtys.map((q) => q.itemId)]);
  const sub = (handover.steel || []).filter((s) => s.mode === "subcontract").length;
  return `${cells.length} crew cells and ${(handover.rows || []).length} extra rows on ${elements.size} element${elements.size === 1 ? "" : "s"}${sub ? `, steel fixing subcontracted on ${sub}` : ""}`;
}
