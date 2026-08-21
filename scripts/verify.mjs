#!/usr/bin/env node
/**
 * Sanity-checks the costing engine without needing a browser.
 * Run with: npm run verify
 *
 * This is NOT a full test suite — it's a fast regression net for the
 * handful of formulas that are easy to silently break (weight-basis
 * costing, the duplicate "Pump" resource columns, margin ladder maths).
 * Extend this file when you add new domain logic to lib/costing.js.
 */
import assert from "node:assert/strict";
import {
  FULL_CATALOG, RESOURCE_COLS, ELEMENT_TYPES, CATEGORY_ORDER, SECTION_ORDER, LABOUR_TEMPLATES, MARGIN_STEPS,
} from "../src/data/catalog.js";
import {
  computeElementCost, computeGrandTotal, computeMarginLadder,
  defaultRates, newElementItem, rateKey,
} from "../src/lib/costing.js";

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("Gradcon Estimator — costing engine checks\n");

/* ---------- catalog shape ---------- */
check("39 element types, 9 categories, 14 sections", () => {
  assert.equal(ELEMENT_TYPES.length, 39);
  assert.equal(CATEGORY_ORDER.length, 9);
  assert.equal(SECTION_ORDER.length, 14);
});

check("every element type has both a category and a section", () => {
  ELEMENT_TYPES.forEach((t) => {
    assert.ok(t.category, `${t.id} is missing category`);
    assert.ok(t.section, `${t.id} is missing section`);
    assert.ok(LABOUR_TEMPLATES[t.labour], `${t.id} points at an unknown labour template "${t.labour}"`);
  });
});

check("11 material categories, 114 products", () => {
  assert.equal(FULL_CATALOG.length, 11);
  const total = FULL_CATALOG.reduce((s, c) => s + c.products.length, 0);
  assert.equal(total, 114);
});

check("8 labour/equipment resource columns (incl. both Pump hr and Pump m3)", () => {
  assert.equal(RESOURCE_COLS.length, 8);
  const pumps = RESOURCE_COLS.filter((r) => r.name === "Pump");
  assert.equal(pumps.length, 2);
  assert.notEqual(pumps[0].key, pumps[1].key); // must have distinct keys or one silently overwrites the other
});

/* ---------- direct-rate costing (qty * unitCost) ---------- */
check("Concrete costs directly: 50 m3 Small load charge @ $47.25 = $2362.50", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("CONCRETE", "Small load charge", "m3")] = 50;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.materialsTotal, 2362.5);
  assert.equal(cost.concreteQty, 50);
});

check("Trench Mesh costs directly (NOT via tonnage): 10x 4 Bar-L12TM @ $41.19 = $411.90", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("TRENCH MESH", "4 Bar-L12TM", "length")] = 10;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["TRENCH MESH"], 411.9);
});

check("Square Mesh and Stock Bar also cost directly, not via tonnage", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  item.qtys[rateKey("SQUARE MESH", "SL82", "sheet")] = 5; // $98.12/sheet
  item.qtys[rateKey("STOCK BAR", "N16 - 6.0m length", "each")] = 3; // $17.51/each
  const cost = computeElementCost(item, rates);
  assert.equal(Math.round(cost.categoryTotals["SQUARE MESH"] * 100) / 100, 490.6);
  assert.equal(Math.round(cost.categoryTotals["STOCK BAR"] * 100) / 100, 52.53);
});

/* ---------- weight-basis costing (Processed Bar only) ---------- */
check("Processed Bar costs via Total Weight x $/tonne: 1000m N16 (1.6kg/m @ $1930/t) = $3088", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("PROCESSED BAR", "N16", "m")] = 1000;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["PROCESSED BAR"], 3088);
});

/* ---------- blank rows cost nothing ---------- */
check("Every product listed with zero qty contributes $0 (full catalog is 'free' until filled in)", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "pool_wall");
  const item = newElementItem(type);
  const cost = computeElementCost(item, rates);
  assert.equal(cost.materialsTotal, 0);
  assert.equal(cost.labourTotal, 0);
  assert.equal(cost.total, 0);
});

/* ---------- labour matrix ---------- */
check("Labour rolls up: 8 Concreter days + 20 Pump hrs on one task = $9000, folds into element total", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  pourTask.qtys["concreter_day"] = 8; // 8 * $500
  pourTask.qtys["pump_hr"] = 20; // 20 * $250
  const cost = computeElementCost(item, rates);
  assert.equal(cost.labourTotal, 9000);
  assert.equal(cost.total, cost.materialsTotal + cost.labourTotal + cost.additionalTotal);
});

check("Labour totals split correctly across BOTH Pump columns (hr and m3) without collision", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "suspended_slab");
  const item = newElementItem(type);
  const task = item.tasks[0];
  task.qtys["pump_hr"] = 10; // 10 * $250 = 2500
  task.qtys["pump_m3"] = 40; // 40 * $7   = 280
  const cost = computeElementCost(item, rates);
  assert.equal(cost.resourceCosts["pump_hr"], 2500);
  assert.equal(cost.resourceCosts["pump_m3"], 280);
  assert.equal(cost.labourTotal, 2780);
});

/* ---------- custom / one-off items ---------- */
check("Custom line items add directly (qty * rate)", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "screw_piles");
  const item = newElementItem(type);
  item.additional.push({ id: "x", name: "Difficult access allowance", unit: "item", qty: 1, rate: 2500 });
  const cost = computeElementCost(item, rates);
  assert.equal(cost.additionalTotal, 2500);
  assert.equal(cost.total, 2500);
});

/* ---------- rate overrides / fallback ---------- */
check("A rates override changes cost; a MISSING key falls back to catalog default rather than $0", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  const key = rateKey("CONCRETE", "32 mpa", "m3");
  item.qtys[key] = 10;

  const before = computeElementCost(item, rates).materialsTotal;
  assert.equal(before, 10 * 221.5);

  rates[key] = { unitCost: 300, unitWeight: null };
  const after = computeElementCost(item, rates).materialsTotal;
  assert.equal(after, 3000);

  delete rates[key]; // simulate an old saved rates blob missing this key
  const fallback = computeElementCost(item, rates).materialsTotal;
  assert.equal(fallback, 10 * 221.5); // falls back to catalog default, not 0
});

/* ---------- multi-element grand total ---------- */
check("Grand total sums every element's total across the whole quote", () => {
  const rates = defaultRates();
  const a = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  a.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10; // $2125
  const b = newElementItem(ELEMENT_TYPES.find((t) => t.id === "capping_beam"));
  b.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 5; // $1107.50
  const total = computeGrandTotal([a, b], rates);
  assert.equal(total, 10 * 212.5 + 5 * 221.5);
});

/* ---------- margin ladder ---------- */
const approxEqual = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

check("Margin ladder: overheads/contingency compound onto direct cost, then margin divides (not multiplies)", () => {
  const directCost = 100000;
  const { subtotal, rows } = computeMarginLadder(directCost, 0.08, 0.05, 500, MARGIN_STEPS);
  approxEqual(subtotal, 113000);
  const row30 = rows.find((r) => Math.abs(r.margin - 0.3) < 1e-9);
  approxEqual(row30.sellExGst, subtotal / 0.7);
  approxEqual(row30.sellIncGst, row30.sellExGst * 1.1);
  approxEqual(row30.perM2, subtotal / 0.7 / 500);
});

check("Margin ladder with GFA=0 reports $/m² as 0, not an error", () => {
  const { rows } = computeMarginLadder(50000, 0, 0, 0, MARGIN_STEPS);
  rows.forEach((r) => assert.equal(r.perM2, 0));
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("\nSome checks FAILED — see above.");
} else {
  console.log("All good.");
}
