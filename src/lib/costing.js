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
  const autoQtys = item.labourAuto !== false ? autoLabourQtys(item, rates) : null;
  const resourceTotals = {};
  RESOURCE_COLS.forEach((res) => { resourceTotals[res.key] = 0; });
  item.tasks.forEach((task) => {
    RESOURCE_COLS.forEach((res) => {
      const manual = task.qtys[res.key];
      const eff = manual !== undefined && manual !== "" ? Number(manual) || 0
        : (autoQtys && autoQtys[task.id] && autoQtys[task.id][res.key]) || 0;
      resourceTotals[res.key] += eff;
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
const PUMP_TASK_MATCH = /\(pump\)/i;                          // legacy suspended templates

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

/** Labour rate for a resource column, honouring overrides saved under the
 * column's pre-crew-sheet name (Concreter, Steel fixer, General Labour). */
export function labourResourceRate(rates, res) {
  const key = rateKey("LABOUR", res.name, res.unit);
  if (rates[key] !== undefined) return lookupRate(rates, key, { unitCost: res.rate }).unitCost;
  if (res.legacyName) {
    const legacyKey = rateKey("LABOUR", res.legacyName, res.unit);
    if (rates[legacyKey] !== undefined) return lookupRate(rates, legacyKey, { unitCost: res.rate }).unitCost;
  }
  return res.rate;
}

/**
 * The seamless labour engine, one row per crew-sheet task:
 *   crew days = row Qty × the rate-of-work rate in the rates library.
 * The row Qty draws DIRECTLY from the quantities entered on the element's
 * line items (concrete m³, reinforcement t, finish m², formwork m²); typing
 * into a row's Qty cell overrides what that row draws on, and typing into a
 * crew-day cell overrides the derived days outright. Returns
 * {taskId: {resourceKey: qty}} covering only cells the estimator hasn't
 * filled. Crews are 3+ people, so a trade's derived total under 3
 * person-days bumps up to the 3-day minimum callout.
 */
export function autoLabourQtys(item, rates) {
  const lq = labourQuantities(item, rates);
  const pourDaysM3 = prodRate(rates, "Concrete pour (placing & finishing)", "days/m³", 0.15);
  const finishDaysM2 = prodRate(rates, "Finish concrete surfaces", "days/m²", 0.01);
  const fixDaysT = prodRate(rates, "Rebar fixing / tying", "days/tonne", 1.5);
  const formDaysM2 = prodRate(rates, "Formwork install & strip", "days/m²", 0.1);
  const generalDaysM3 = prodRate(rates, "General labour (prep, washout, clean & tidy)", "days/m³", 0.05);
  const excDaysM3 = prodRate(rates, "Excavation & base preparation", "days/m³", 0.03);
  const pumpHrsM3 = prodRate(rates, "Concrete pumping", "hrs/m³", 0.05);

  const hasFinishTask = (item.tasks || []).some((t) => FINISH_TASK_MATCH.test(t.name));
  const suggestions = {};
  const put = (task, key, qty) => {
    if (qty <= 0) return;
    if (task.qtys[key] !== undefined && task.qtys[key] !== "") return; // typed crew days win
    (suggestions[task.id] = suggestions[task.id] || {})[key] = round2(qty);
  };
  (item.tasks || []).forEach((task) => {
    const meta = taskRowMeta(task.name, lq);
    // the row's driving quantity: a typed Qty overrides the drawn-in one
    const q = task.qty !== undefined && task.qty !== "" ? Number(task.qty) || 0 : (meta.autoQty || 0);
    if (CONCRETE_POUR_TASK_MATCH.test(task.name)) {
      // legacy templates had no separate finish row — finishing rode on the pour task
      put(task, "concreter_day", q * pourDaysM3 + (hasFinishTask ? 0 : lq.finishM2 * finishDaysM2));
      if (PUMP_TASK_MATCH.test(task.name)) {
        put(task, "pump_m3", q);
        put(task, "pump_hr", q * pumpHrsM3);
      }
    } else if (STEEL_FIXING_TASK_MATCH.test(task.name)) {
      put(task, "steelfixer_day", q * fixDaysT);
    } else if (FINISH_TASK_MATCH.test(task.name)) {
      put(task, "concreter_day", q * finishDaysM2);
    } else if (EXCAVATE_TASK_MATCH.test(task.name)) {
      put(task, "excavator_day", q * excDaysM3); // q is the typed excavation m³ — no line item to draw from
    } else if (FORMWORK_TASK_MATCH.test(task.name) && !STRIP_TASK_MATCH.test(task.name)) {
      put(task, "concreter_day", q * formDaysM2);
    } else if (GENERAL_TASK_MATCH.test(task.name)) {
      put(task, "labourer_day", (task.qty !== undefined && task.qty !== "" ? Number(task.qty) || 0 : lq.concreteM3) * generalDaysM3);
    }
  });

  // Minimum 3-person-day crew callout per trade (auto amounts only; manual
  // entries are respected as-is and count toward the minimum).
  ["concreter_day", "steelfixer_day", "labourer_day"].forEach((key) => {
    let auto = 0, manual = 0;
    (item.tasks || []).forEach((task) => {
      auto += (suggestions[task.id] && suggestions[task.id][key]) || 0;
      manual += Number(task.qtys[key]) || 0;
    });
    if (auto > 0 && auto + manual < 3) {
      const scale = (3 - manual) / auto;
      Object.values(suggestions).forEach((entry) => {
        if (entry[key]) entry[key] = round2(entry[key] * scale);
      });
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
