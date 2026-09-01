/**
 * Costing engine. Pure functions only — no React, no DOM, no storage.
 * Import this directly in Node (see scripts/verify.mjs) to sanity-check
 * the maths after any change, without spinning up a browser.
 *
 * Read CLAUDE.md → "Costing rules" before editing computeElementCost.
 */
import { FULL_CATALOG, RESOURCE_COLS, LABOUR_TEMPLATES, GST_RATE, PRODUCTION_RATES, DEFAULT_MARGIN, MARGIN_STEPS } from "../data/catalog.js";

// Shared with portal-shell.html's Settings modal (same localStorage key, same
// origin — the portal embeds this app via a blob: URL created from its own
// page, which inherits that page's origin) — lets a user preference set
// outside this app's own React tree still reach these plain formatter
// functions, which are called all over the component tree via a simple
// import rather than a hook.
function readPrefs() {
  try {
    const raw = localStorage.getItem("gradcon-preferences");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const money = (n) =>
  (n || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export const money2 = (n) => {
  const p = readPrefs();
  const dp = Number.isFinite(p.moneyDecimals) ? p.moneyDecimals : 2;
  return (n || 0).toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: dp, maximumFractionDigits: dp });
};

/** GST rate as a fraction — the Settings preference (entered as a whole %,
 * e.g. 10) overrides the catalog's GST_RATE; absent/invalid falls back. */
export function getGstRate() {
  const p = readPrefs();
  return Number.isFinite(p.gstRatePct) ? p.gstRatePct / 100 : GST_RATE;
}

/** Default margin as a fraction — Settings preference (whole %, e.g. 30)
 * over the catalog's DEFAULT_MARGIN. Bounded to <95% so the margin ladder's
 * divide-by-(1-margin) can never blow up on a bad saved value. */
export function getDefaultMargin() {
  const p = readPrefs();
  if (Number.isFinite(p.defaultMarginPct) && p.defaultMarginPct >= 0 && p.defaultMarginPct < 95) {
    return p.defaultMarginPct / 100;
  }
  return DEFAULT_MARGIN;
}

/** MARGIN_STEPS with the (possibly customised) default margin merged in,
 * sorted — so the ladder always contains a row for the default margin and
 * the Dashboard/QuoteSummary "default" highlight always has a row to hit. */
export function getMarginSteps() {
  const def = getDefaultMargin();
  const steps = MARGIN_STEPS.includes(def) ? MARGIN_STEPS : [...MARGIN_STEPS, def];
  return [...steps].sort((a, b) => a - b);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Key used both to look up a rate and to store a quantity against a product. */
export const rateKey = (cat, name, unit) => `${cat}::${name}::${unit}`;

/**
 * Builds the default rates object (every catalog product + every labour
 * resource) from src/data/catalog.js. This is the seed for a fresh
 * install; a user's live edits in the Rates panel are persisted
 * separately (see lib/storage.js) and layered on top.
 */
export function defaultRates() {
  const r = {};
  FULL_CATALOG.forEach((cat) => {
    cat.products.forEach((p) => {
      r[rateKey(cat.key, p.name, p.unit)] = { unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight, sheetArea: p.sheetArea, barLength: p.barLength };
    });
  });
  RESOURCE_COLS.forEach((res) => {
    r[rateKey("LABOUR", res.name, res.unit)] = { unitCost: res.rate, unitWeight: null };
  });
  PRODUCTION_RATES.forEach((pr) => {
    r[rateKey("PRODUCTION", pr.name, pr.unit)] = { unitCost: pr.rate, unitWeight: null };
  });
  return r;
}

/**
 * A rate lookup that ALWAYS falls back to the catalog's own default if the
 * key is missing from `rates` (e.g. a saved rates object from before the
 * catalog was extended). Never let a missing key render as blank/undefined
 * pricing — use this helper (or the same fallback pattern) anywhere a rate
 * is read, rather than indexing into `rates` directly.
 */
export function lookupRate(rates, key, fallback) {
  return rates[key] || fallback;
}

/**
 * The ONE place that turns a catalog row's quantity into a dollar figure —
 * computeElementCost, CategoryBlock.jsx and PrintQuoteReport.jsx all call
 * this rather than recomputing it themselves, so the three can never
 * silently disagree. See CLAUDE.md "Costing rules" and the areaBasis/
 * weightBasis comment above FULL_CATALOG in data/catalog.js.
 */
export function computeRowTotal(cat, rate, qty) {
  if (cat.weightBasis && rate.unitWeight) {
    return ((qty * rate.unitWeight) / 1000) * rate.unitCost;
  }
  if (cat.areaBasis && rate.sheetArea) {
    return Math.ceil(qty / rate.sheetArea) * rate.unitCost;
  }
  if (cat.lengthBasis && rate.barLength) {
    return Math.ceil(qty / rate.barLength) * rate.unitCost;
  }
  return qty * rate.unitCost;
}

/** Creates a fresh quote line item for the given element type. */
export function newElementItem(type) {
  return {
    id: uid(),
    typeId: type.id,
    category: type.category,
    section: type.section,
    label: type.name,
    collapsed: false,
    description: "", // free-text spec notes ("R2.5 XPS insulation under slab", etc.)
    markups: [], // [{id, name, type, dataURL}] — uploaded markup drawings (pdf/png/jpg)
    labourAuto: true, // crew days auto-derived from quantities (rate-of-work); typed cells override
    labourVer: 2, // crew-engine era marker — elements without it get their labour cells cleared once (see ElementCard), so values baked in by the old write-in prefill can't shadow the live engine
    qtys: {}, // rateKey(category, product, unit) -> number
    tasks: LABOUR_TEMPLATES[type.labour].map((name) => ({ id: uid(), name, qtys: {} })), // qtys: resourceKey -> number
    additional: [], // [{id, name, unit, qty, rate}]
  };
}

/**
 * Computes every cost figure for one quote line item.
 *
 * Costing rules (see CLAUDE.md for the full explanation):
 *  - Every category in FULL_CATALOG is walked; a product only contributes
 *    if its quantity is > 0. Blank rows are free — that's what lets every
 *    tab show the WHOLE catalog without inflating totals.
 *  - weightBasis categories (currently only PROCESSED BAR) cost as
 *    (qty * unitWeight / 1000) * unitCost  — i.e. Total Weight (tonnes) *
 *    $/tonne.
 *  - areaBasis categories (currently only SQUARE MESH) cost as
 *    ceil(qty / sheetArea) * unitCost — qty is m² of coverage, sheets are
 *    bought whole so the count always rounds up.
 *  - lengthBasis categories (currently only STOCK BAR) cost as
 *    ceil(qty / barLength) * unitCost — qty is metres of bar needed, bars
 *    are bought whole (fixed stock lengths) so the count always rounds up.
 *  - All other categories cost as qty * unitCost directly, even if the
 *    product also carries a unitWeight (Trench Mesh shows tonnage for
 *    information only — do not switch it to weight-based costing, its
 *    catalog price is per length). See computeRowTotal, the single
 *    implementation of all four rules above.
 *  - Labour: for each task row, quantities are entered per resource
 *    (day-count or hour-count). Resource totals are summed across all task
 *    rows, then each resource total is multiplied by that resource's
 *    day/hour rate. The element's labour total is the sum of all resource
 *    costs.
 *  - `total` = materialsTotal + labourTotal + additionalTotal. Nothing
 *    else feeds into an element's total cost.
 */
export function computeElementCost(item, rates) {
  const categoryTotals = {};
  let materialsTotal = 0;
  let concreteQty = 0;

  FULL_CATALOG.forEach((cat) => {
    let catTotal = 0;
    cat.products.forEach((p) => {
      const qKey = rateKey(cat.key, p.name, p.unit);
      const qty = Number(item.qtys[qKey]) || 0;
      if (qty > 0) {
        const rate = lookupRate(rates, qKey, { unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight, sheetArea: p.sheetArea });
        const rowTotal = computeRowTotal(cat, rate, qty);
        catTotal += rowTotal;
        if (cat.key === "CONCRETE") concreteQty += qty;
      }
    });
    categoryTotals[cat.key] = catTotal;
    materialsTotal += catTotal;
  });

  // Seamless labour: with labourAuto on, empty matrix cells are driven live
  // by the rate-of-work engine (autoLabourQtys) — quantities entered above
  // flow straight into crew days at the rates-library production rates. A
  // typed cell always wins; nothing is ever written back into the tasks.
  // Every labour figure is a WHOLE number of crews/days/hours — a typed 0.5
  // or 1.2 crew-days books 1 or 2 whole crews (fractional crews don't
  // exist). The one exception is pump m³: a real measured volume, priced
  // per m³ pumped, never rounded.
  const autoQtys = item.labourAuto !== false ? autoLabourQtys(item, rates) : null;
  const resourceTotals = {};
  RESOURCE_COLS.forEach((res) => { resourceTotals[res.key] = 0; });
  item.tasks.forEach((task) => {
    RESOURCE_COLS.forEach((res) => {
      const manual = task.qtys[res.key];
      const eff = manual !== undefined && manual !== "" ? Number(manual) || 0
        : (autoQtys && autoQtys[task.id] && autoQtys[task.id][res.key]) || 0;
      resourceTotals[res.key] += res.key === "pump_m3" ? eff : Math.ceil(eff - 1e-9);
    });
  });

  let labourTotal = 0;
  const resourceCosts = {};
  RESOURCE_COLS.forEach((res) => {
    const rate = labourResourceRate(rates, res);
    const cost = resourceTotals[res.key] * rate;
    resourceCosts[res.key] = cost;
    labourTotal += cost;
  });

  const additionalTotal = item.additional.reduce(
    (s, a) => s + (Number(a.qty) || 0) * (Number(a.rate) || 0),
    0
  );

  return {
    categoryTotals,
    materialsTotal,
    resourceTotals,
    resourceCosts,
    labourTotal,
    additionalTotal,
    concreteQty,
    total: materialsTotal + labourTotal + additionalTotal,
  };
}

/**
 * Total reinforcement weight (tonnes) across every weight-carrying category
 * in one element — mirrors CategoryBlock.jsx's per-row "Total (t)" column,
 * summed across the whole element. Used by suggestedLabourPrefill to size
 * steel-fixing hours; kept separate from computeElementCost's own totals
 * (which only ever COST Processed Bar by weight — see CLAUDE.md rule 2).
 */
export function computeElementReinforcementTonnes(item, rates) {
  let totalKg = 0;
  FULL_CATALOG.forEach((cat) => {
    cat.products.forEach((p) => {
      if (p.unitWeight == null) return;
      const qKey = rateKey(cat.key, p.name, p.unit);
      const qty = Number(item.qtys[qKey]) || 0;
      if (qty <= 0) return;
      const rate = lookupRate(rates, qKey, { unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight, sheetArea: p.sheetArea, barLength: p.barLength });
      if (rate.unitWeight == null) return;
      const sheets = cat.areaBasis && rate.sheetArea ? Math.ceil(qty / rate.sheetArea) : null;
      const bars = cat.lengthBasis && rate.barLength ? Math.ceil(qty / rate.barLength) : null;
      const units = sheets != null ? sheets : bars != null ? bars : qty;
      totalKg += units * rate.unitWeight;
    });
  });
  return totalKg / 1000;
}

const CONCRETE_POUR_TASK_MATCH = /pour/i;                     // "Pour / place / vibrate concrete", legacy "Pour concrete (pump)"
const STEEL_FIXING_TASK_MATCH = /tie (steel|reinforcement)/i; // "Tie reinforcement", legacy "Tie steel"
const FINISH_TASK_MATCH = /finish concrete/i;                 // "Finish concrete surfaces"
const EXCAVATE_TASK_MATCH = /excavate/i;                      // "Excavate & prepare base"
const FORMWORK_TASK_MATCH = /formwork|box out|prop & form/i;  // legacy per-type templates only
const STRIP_TASK_MATCH = /^strip/i;
const GENERAL_TASK_MATCH = /washout|tidy|clean|patch/i;       // "Washout / clean / tidy"

/** The quantities each crew-sheet row draws on, read DIRECTLY from the
 * element's entered line items: concrete m³ from the CONCRETE rows, formwork
 * m² from the FORMWORK rows, finish m² from the mesh coverage entered
 * (mesh area ≈ finished slab surface). Pure qty scan — no costing — so the
 * labour engine can run inside computeElementCost without recursion. */
export function labourQuantities(item, rates) {
  let concreteM3 = 0, formworkM2 = 0, finishM2 = 0;
  FULL_CATALOG.forEach((cat) => {
    if (cat.key !== "CONCRETE" && cat.key !== "FORMWORK" && cat.key !== "SQUARE MESH") return;
    cat.products.forEach((p) => {
      const qty = Number(item.qtys[rateKey(cat.key, p.name, p.unit)]) || 0;
      if (qty <= 0) return;
      if (cat.key === "CONCRETE") concreteM3 += qty;
      else if (cat.key === "FORMWORK" && p.unit === "m2") formworkM2 += qty;
      else if (cat.key === "SQUARE MESH") finishM2 += qty;
    });
  });
  return { concreteM3, formworkM2, finishM2, reinfTonnes: computeElementReinforcementTonnes(item, rates) };
}

/** Crew-sheet row metadata: the unit each task is measured in and which
 * element quantity fills its Qty column automatically. Excavation has no
 * Quotes line item to draw from, so its Qty stays manual. */
export function taskRowMeta(taskName, lq) {
  if (CONCRETE_POUR_TASK_MATCH.test(taskName)) return { unit: "m³", autoQty: lq ? lq.concreteM3 : undefined };
  if (STEEL_FIXING_TASK_MATCH.test(taskName)) return { unit: "t", autoQty: lq ? round2(lq.reinfTonnes) : undefined };
  if (FINISH_TASK_MATCH.test(taskName)) return { unit: "m²", autoQty: lq ? lq.finishM2 : undefined };
  if (EXCAVATE_TASK_MATCH.test(taskName)) return { unit: "m³", autoQty: undefined };
  if (FORMWORK_TASK_MATCH.test(taskName) && !STRIP_TASK_MATCH.test(taskName)) return { unit: "m²", autoQty: lq ? lq.formworkM2 : undefined };
  return { unit: "", autoQty: undefined };
}

const prodRate = (rates, name, unit, fallback) =>
  lookupRate(rates, rateKey("PRODUCTION", name, unit), { unitCost: fallback }).unitCost;
const round2 = (v) => Math.round(v * 100) / 100;

/** Labour rate for a resource column — always the crew/plant rate saved in
 * the rates library, falling back to the catalog default (CLAUDE.md rule 6).
 * The crew columns' unit is "crew-day", deliberately different from the old
 * per-person "day" keys so stale per-person overrides no longer apply. */
export function labourResourceRate(rates, res) {
  return lookupRate(rates, rateKey("LABOUR", res.name, res.unit), { unitCost: res.rate }).unitCost;
}

/**
 * The seamless labour engine — whole-CREW mathematics, one row per
 * crew-sheet task. Each row's Qty draws DIRECTLY from the element's entered
 * line items (concrete m³, reinforcement t, finish m²); the engine then
 * books whole crews, never fractional people:
 *
 *   crew-days = ceil( ceil(qty) / block )   — minimum 1 whole crew-day
 *
 * where `block` is how much ONE crew-day covers (rates library
 * PRODUCTION_RATES: 1 t of steel = a 5-man Steel Crew for a day, every
 * 10 m³ of concrete = a 3-man Concrete Crew day, …). The quantity is
 * rounded UP to a whole unit in the background first — 0.13 t books a full
 * tonne's crew — but the Qty column keeps DISPLAYING the true 0.13
 * (taskRowMeta, untouched here). Pump m³ stays the real measured volume
 * (it's priced per m³ pumped), and pump hours book a flat whole-pour
 * booking (6 hrs) whenever concrete is poured.
 *
 * Typing into a row's Qty cell overrides what that row draws on; typing
 * into a crew cell overrides the derived crew-days outright. Returns
 * {taskId: {resourceKey: qty}} covering only cells the estimator hasn't
 * filled — nothing is ever written back into the tasks.
 */
export function autoLabourQtys(item, rates) {
  const lq = labourQuantities(item, rates);
  const pourM3Block = prodRate(rates, "Concrete pour — m³ per crew-day", "m³/day", 10);
  const steelTBlock = prodRate(rates, "Rebar fixing — tonnes per crew-day", "t/day", 1);
  const finishM2Block = prodRate(rates, "Surface finishing — m² per crew-day", "m²/day", 300);
  const generalM3Block = prodRate(rates, "General labour — m³ per crew-day", "m³/day", 60);
  const formM2Block = prodRate(rates, "Formwork — m² per crew-day", "m²/day", 30);
  const excM3Block = prodRate(rates, "Excavation — m³ per excavator-day", "m³/day", 100);
  const pumpHrsPour = prodRate(rates, "Concrete pump — hours per pour", "hrs", 6);

  // qty → whole crew-days: round the quantity itself up to a whole unit,
  // then divide by the crew-day block, rounding up again — any quantity at
  // all books at least one whole crew (the crew IS the minimum: 3+ men).
  const crewDays = (qty, block) =>
    qty > 0 ? Math.max(1, Math.ceil(Math.ceil(qty - 1e-9) / Math.max(block, 1e-9))) : 0;

  const hasFinishTask = (item.tasks || []).some((t) => FINISH_TASK_MATCH.test(t.name));
  const suggestions = {};
  const put = (task, key, qty) => {
    if (qty <= 0) return;
    if (task.qtys[key] !== undefined && task.qtys[key] !== "") return; // typed cells win
    (suggestions[task.id] = suggestions[task.id] || {})[key] = key === "pump_m3" ? round2(qty) : qty;
  };
  (item.tasks || []).forEach((task) => {
    const meta = taskRowMeta(task.name, lq);
    // the row's driving quantity: a typed Qty overrides the drawn-in one
    const q = task.qty !== undefined && task.qty !== "" ? Number(task.qty) || 0 : (meta.autoQty || 0);
    if (CONCRETE_POUR_TASK_MATCH.test(task.name)) {
      // legacy templates had no separate finish row — finishing rode on the pour task
      put(task, "concreter_day", crewDays(q, pourM3Block) + (hasFinishTask ? 0 : crewDays(lq.finishM2, finishM2Block)));
      if (q > 0) {
        put(task, "pump_hr", pumpHrsPour); // a pour books the pump for the whole pour (6 hrs)
        put(task, "pump_m3", q); // real measured volume — priced per m³ pumped, never rounded up
      }
    } else if (STEEL_FIXING_TASK_MATCH.test(task.name)) {
      put(task, "steelfixer_day", crewDays(q, steelTBlock)); // 1 t = a 5-man crew's day
    } else if (FINISH_TASK_MATCH.test(task.name)) {
      put(task, "concreter_day", crewDays(q, finishM2Block));
    } else if (EXCAVATE_TASK_MATCH.test(task.name)) {
      put(task, "excavator_day", crewDays(q, excM3Block)); // q is the typed excavation m³ — no line item to draw from
    } else if (FORMWORK_TASK_MATCH.test(task.name) && !STRIP_TASK_MATCH.test(task.name)) {
      put(task, "concreter_day", crewDays(q, formM2Block));
    } else if (GENERAL_TASK_MATCH.test(task.name)) {
      put(task, "labourer_day", crewDays(task.qty !== undefined && task.qty !== "" ? Number(task.qty) || 0 : lq.concreteM3, generalM3Block));
    }
  });
  return suggestions;
}

export function suggestedLabourPrefill(item, rates) {
  return autoLabourQtys(item, rates);
}

/** Grand total across every quote item. */
export function computeGrandTotal(items, rates) {
  return items.reduce((s, it) => s + computeElementCost(it, rates).total, 0);
}

/**
 * Overheads/contingency/margin ladder. `overheadPct` and `contingencyPct`
 * are fractions (0.08, not 8). Returns the on-cost subtotal plus a row per
 * margin step with ex/inc-GST sell price and $/m² GFA.
 */
export function computeMarginLadder(directCost, overheadPct, contingencyPct, gfa, marginSteps) {
  const subtotal = directCost * (1 + (Number(overheadPct) || 0) + (Number(contingencyPct) || 0));
  const gfaNum = Number(gfa) || 0;
  const gstRate = getGstRate();
  const rows = marginSteps.map((margin) => {
    const sellExGst = subtotal / (1 - margin);
    const sellIncGst = sellExGst * (1 + gstRate);
    return {
      margin,
      sellExGst,
      sellIncGst,
      perM2: gfaNum > 0 ? sellExGst / gfaNum : 0,
    };
  });
  return { subtotal, rows };
}

/**
 * Client-facing scope lines for the External Quote (see
 * components/ExternalQuoteReport.jsx) — one line per element, priced as
 * that element's share of the actual sell price, so the dollar figures
 * always tie exactly to the real costed total (computeMarginLadder is the
 * one place that turns cost into a sell price — reused here, never
 * reimplemented). Elements with nothing entered (total === 0) are dropped;
 * an element with a total contributes proportionally to its own direct
 * cost's share of the whole quote's direct cost.
 */
export function computeExternalScopeLines(items, rates, overheadPct, contingencyPct, marginPct) {
  if (marginPct === undefined) marginPct = getDefaultMargin();
  const costed = items
    .map((item) => ({ id: item.id, label: item.label, directCost: computeElementCost(item, rates).total }))
    .filter((l) => l.directCost > 0);
  const directTotal = costed.reduce((s, l) => s + l.directCost, 0);
  const { rows } = computeMarginLadder(directTotal, overheadPct, contingencyPct, 0, [marginPct]);
  const totalExGst = rows[0]?.sellExGst || 0;
  const lines = costed.map((l) => ({
    id: l.id,
    label: l.label,
    sellExGst: directTotal > 0 ? (l.directCost / directTotal) * totalExGst : 0,
  }));
  return { lines, totalExGst };
}
