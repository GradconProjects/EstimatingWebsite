#!/usr/bin/env node
import fs from "node:fs";
import { runInNewContext } from "node:vm";
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
  FULL_CATALOG, RESOURCE_COLS, ELEMENT_TYPES, CATEGORY_ORDER, SECTION_ORDER, LABOUR_TEMPLATES, MARGIN_STEPS, PRODUCTION_RATES } from "../src/data/catalog.js";
import * as catalogAll from "../src/data/catalog.js";
import {
  computeElementCost, computeGrandTotal, computeMarginLadder, productLabel, visibleProducts,
  defaultRates, newElementItem, rateKey, suggestedLabourPrefill, computeExternalScopeLines,
  labourResourceRate, taskRowMeta, labourQuantities, autoLabourQtys, upgradeCrewTasks, blindingIncluded, autoMinimumCartage, autoConcreteSurcharge, autoEnvironmentLevy, computeRowTotal,
  computeElementUnitRates, computeProjectUnitRates, rowContext, computeElementReinforcementTonnes, getMarginSteps, additionalRowsFor, autoPigmentWashout, autoSpecialistShortLoad, autoSpecialistFees, categoryAppliesTo } from "../src/lib/costing.js";
import { buildImportFromEstimate, normalizeElementName, geometryForLabel, edgeDepthMm } from "../src/lib/estimateImport.js";
import * as importAll from "../src/lib/estimateImport.js";
import * as EB from "../src/lib/estimateBasis.js";
import * as costingAll from "../src/lib/costing.js";
import { PROJECT_SORTS, sortProjects, sortValue, defaultSortDir, preferredSortKey, isProjectSortKey } from "../src/lib/projectSort.js";

let passed = 0;
const assertTrue = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("Gradcon Estimator — costing engine checks\n");

/* Concrete prices are Gradcon's real supplier rates and DO get corrected (they
 * are synced from the Rates Library). A check that hardcodes one is really
 * asserting a price, not a rule, and breaks every time the price moves — so
 * read the rate the same way the app does and test the arithmetic around it. */
const RATE = (cat, name, unit) => defaultRates()[rateKey(cat, name, unit)].unitCost;
const C25 = RATE("CONCRETE", "25 mpa", "m3");
const C32 = RATE("CONCRETE", "32 mpa", "m3");

/* ---------- catalog shape ---------- */
check("113 element types, 18 categories, 29 sections (CUSTOM ITEMS 1, last; PRECAST / TILT-UP 4 after VERTICAL STRUCTURE; ROOF 8 after SUSPENDED STRUCTURE; PRELIMINARIES 17 first; Basement Ramp beside Ramp; IRREGULAR CONCRETE CONSTRUCTIONS 3 before External & Landscape; SCREEDS 14, TOPPINGS 7, HYDRONIC HEATING 3, SPECIALIST FINISHING CONCRETE 10 — each its own category)", () => {
  assert.equal(ELEMENT_TYPES.length, 113);
  assert.deepEqual(ELEMENT_TYPES[ELEMENT_TYPES.length - 1], { id: "custom_item", category: "CUSTOM ITEMS", section: "CUSTOM ITEMS", name: "Custom item (lump sum)", labour: "footing" }, "the custom lump-sum line is the last type");
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "IRREGULAR CONCRETE CONSTRUCTIONS").length, 3);
  assert.ok(ELEMENT_TYPES.some((t) => t.id === "hearth_fireplace_base" && t.labour === "composite"), "hearth is a priced Quotes element with a crew sheet");
  assert.ok(CATEGORY_ORDER.indexOf("IRREGULAR CONCRETE CONSTRUCTIONS") < CATEGORY_ORDER.indexOf("EXTERNAL & LANDSCAPE CONCRETE"), "irregular constructions sit with the structure, before landscape works");
  assert.ok(ELEMENT_TYPES.some((t) => t.id === "basement_ramp" && t.section === "GROUND-BEARING SLABS"), "Basement Ramp is its own selectable element");
  assert.equal(CATEGORY_ORDER.length, 18);
  assert.equal(SECTION_ORDER.length, 29);
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "PRELIMINARIES").length, 17);
  assert.equal(CATEGORY_ORDER[0], "PRELIMINARIES", "preliminaries come before earthworks");
  assert.deepEqual(SECTION_ORDER.slice(0, 3), ["TRAFFIC & ACCESS", "SITE ESTABLISHMENT", "SITE MANAGEMENT & COMPLIANCE"]);
  assert.ok(ELEMENT_TYPES.some((t) => t.id === "prelim_traffic_management") && ELEMENT_TYPES.some((t) => t.id === "prelim_temporary_access"));
  assert.ok(ELEMENT_TYPES.filter((t) => t.category === "PRELIMINARIES").every((t) => t.labour === "prelims"), "prelims use their own crew-sheet tasks");
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "SPECIALIST FINISHING CONCRETE").length, 10);
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "SCREEDS").length, 14);
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "TOPPINGS").length, 7);
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "HYDRONIC HEATING").length, 3);
  // ROOF follows SUSPENDED STRUCTURE (the roof sits on it), then the finishes and services follow the structure they sit on
  const i = CATEGORY_ORDER.indexOf("SUSPENDED STRUCTURE");
  assert.deepEqual(CATEGORY_ORDER.slice(i + 1, i + 6), ["ROOF", "SCREEDS", "TOPPINGS", "HYDRONIC HEATING", "SPECIALIST FINISHING CONCRETE"]);
  // Roof: every roof-level concrete element in its own category (6 Oct 2026)
  const roof = ELEMENT_TYPES.filter((t) => t.category === "ROOF");
  assert.deepEqual(roof.map((t) => t.id), ["roof_slab_propped", "roof_slab_cantilevered", "plant_deck_slab", "lift_overrun_slab", "roof_beam", "box_gutter", "parapet_upstand", "roof_plinth"]);
  assert.deepEqual([...new Set(roof.map((t) => t.section))], ["ROOF SLABS", "ROOF BEAMS", "ROOF GUTTERS & PARAPETS"]);
  assert.ok(roof.every((t) => LABOUR_TEMPLATES[t.labour]), "every roof type has a crew-sheet template");
  assert.equal(new Set(ELEMENT_TYPES.map((t) => t.id)).size, ELEMENT_TYPES.length, "element ids unique");
  // Stump Footings and Screw Piles are separate, individually selectable types.
  assert.ok(ELEMENT_TYPES.some((t) => t.name === "Stump Footings"), "Stump Footings present");
  assert.ok(ELEMENT_TYPES.some((t) => t.name === "Screw Piles"), "Screw Piles present");
});

check("every element type has both a category and a section", () => {
  ELEMENT_TYPES.forEach((t) => {
    assert.ok(t.category, `${t.id} is missing category`);
    assert.ok(t.section, `${t.id} is missing section`);
    assert.ok(LABOUR_TEMPLATES[t.labour], `${t.id} points at an unknown labour template "${t.labour}"`);
  });
});

check("21 material categories, 438 products (incl. KingFlor steel decking on FORMWORK (25 Nov 2026), the 12 vertical insulation rows and the 7 Slabmate boards of INSULATION (22 Nov 2026), the R6 / R8 / R10 plain rounds on PROCESSED BAR, the 12-row Void formers group of FORMWORK, the 23-row FINISHED PAVEMENTS & CONCRETE FINISHES band (permeable paving and the P4 slip-resistant row added 20 Nov 2026, the two recommended tender allowances 21 Nov 2026), the 45-row SAW CUTS & DOWELS band, CONCRETE PUMPING, REINFORCEMENT BY RATE, the 51-row INSULATION range, 31 SCREEDS, 17 HYDRONIC HEATING, 48 SPECIALIST FINISHING CONCRETE, 45 PRELIMINARIES, the full 24-size TRENCH MESH grid, Bored Piers subcontract, minimum cartage, levy, surcharge)", () => {
  assert.equal(FULL_CATALOG.length, 21);
  const total = FULL_CATALOG.reduce((s, c) => s + c.products.length, 0);
  assert.equal(total, 438);
  const pre = FULL_CATALOG.find((c) => c.key === "PRELIMINARIES");
  assert.equal(pre.products.length, 45);
  assert.ok(!pre.weightBasis && !pre.areaBasis && !pre.lengthBasis && !pre.volumeRateBasis, "preliminaries cost plain qty × rate");
  assert.ok(pre.products.some((p) => /^Traffic controller/.test(p.name)) && pre.products.some((p) => /crossover/.test(p.name)) && pre.products.some((p) => p.unit === "quote"));
  const scr = FULL_CATALOG.find((c) => c.key === "SCREEDS"), hyd = FULL_CATALOG.find((c) => c.key === "HYDRONIC HEATING");
  assert.equal(scr.products.length, 31); assert.equal(hyd.products.length, 17);
  assert.ok(!scr.weightBasis && !scr.areaBasis && !scr.lengthBasis && !scr.volumeRateBasis && !hyd.weightBasis && !hyd.areaBasis, "both cost plain qty × rate");
  assert.ok(scr.products.some((p) => p.unit === "quote") && hyd.products.some((p) => p.unit === "quote"), "each carries a subcontract quote row");
  // no duplicate product keys anywhere in the catalog
  const keys = FULL_CATALOG.flatMap((c) => c.products.map((p) => rateKey(c.key, p.name, p.unit)));
  assert.equal(new Set(keys).size, keys.length, "every rate key unique");
  // a screed and a hydronic row cost qty × rate into their own category totals
  const item = newElementItem(ELEMENT_TYPES[0]);
  item.qtys[rateKey("SCREEDS", "Screed to falls — wet areas / balconies", "m2")] = 10;
  item.qtys[rateKey("HYDRONIC HEATING", "Zone actuator", "each")] = 3;
  const cost = computeElementCost(item, defaultRates());
  assert.equal(cost.categoryTotals["SCREEDS"], 720); assert.equal(cost.categoryTotals["HYDRONIC HEATING"], 285); assert.equal(cost.materialsTotal, 1005);
  // Danley PD3 plate dowel cradles: supply per 3 m length at Allcon's ex-GST retail; the black 140–160 carries Allcon's 25-length MOQ as minQty
  const saw = FULL_CATALOG.find((c) => c.key === "SAW CUTS & DOWELS");
  assert.equal(saw.products.length, 45);
  assert.ok(!saw.weightBasis && !saw.areaBasis && !saw.lengthBasis && !saw.volumeRateBasis, "saw cuts & dowels cost plain qty × rate");
  const pd3 = (re) => saw.products.find((p) => re.test(p.name));
  assert.equal(pd3(/black — 140–160mm/).minQty, 25); assert.equal(pd3(/black — 140–160mm/).unitCost, 116.2); assert.equal(pd3(/black — 140–160mm/).unit, "each");
  assert.equal(pd3(/black — 165–185mm/).minQty, undefined); assert.equal(pd3(/galvanised — 190–210mm/).unitCost, 168.9); assert.equal(pd3(/galvanised — 140–160mm/).unitCost, 145.9);
  assert.ok(saw.products.some((p) => p.unit === "quote"), "a subcontract saw-cutting quote row");
  const dow = newElementItem(ELEMENT_TYPES[0]);
  dow.qtys[rateKey("SAW CUTS & DOWELS", pd3(/black — 140–160mm/).name, "each")] = 20;   // 59 lm → 20 lengths
  dow.qtys[rateKey("SAW CUTS & DOWELS", pd3(/galvanised — 140–160mm/).name, "each")] = 20;
  const dowCost = computeElementCost(dow, defaultRates());
  assert.equal(Math.round(dowCost.categoryTotals["SAW CUTS & DOWELS"] * 100) / 100, 2905 + 2918, "black bills the 25-length MOQ ($2,905), galvanised the 20 typed ($2,918)");
  // the N16 × 400 @ 300 c/c top-and-bottom detail: 59 m at the $200/lm tender rate = $11,800; drilled & ChemSet allowances per dowel; Danley supply rows ex GST
  const n16 = newElementItem(ELEMENT_TYPES[0]);
  n16.qtys[rateKey("SAW CUTS & DOWELS", pd3(/^N16 × 400 drilled/).name, "m")] = 59;
  n16.qtys[rateKey("SAW CUTS & DOWELS", pd3(/^N16 drilled & ChemSet/).name, "each")] = 394;
  const n16Cost = computeElementCost(n16, defaultRates());
  assert.equal(n16Cost.categoryTotals["SAW CUTS & DOWELS"], 11800 + 394 * 30);
  assert.equal(pd3(/REO 502 XTREM/).unitCost, 70.91, "$78 incl GST → $70.91 ex");
  assert.equal(pd3(/16mm square × 400 galvanised/).unitCost, 15.94); assert.equal(pd3(/diamond dowel — supply/).unitCost, 22.1);
  ["N12", "N20", "N24"].forEach((d) => assert.ok(pd3(new RegExp(`^${d} drilled & ChemSet`)), `${d} drilled dowel row`));
  // cogged ChemSet starter bars (Grady's "N16 STARTER BARS @ 400 MAX CTS, ALL FACES, COG 300, DRILL & RAMSET CHEMSET REO 502, 150 EMBEDMENT" detail, 6 Oct 2026)
  ["N12", "N16", "N20", "N24"].forEach((d) => assert.ok(pd3(new RegExp(`^${d} cogged ChemSet starter bar`)), `${d} cogged starter row`));
  assert.equal(pd3(/^N16 cogged ChemSet starter bar, 150 embed/).unitCost, 32);
  assert.equal(pd3(/^N16 cogged ChemSet starters @400/).unitCost, 80, "@400 per lm per face = 2.5 × $32");
  assert.equal(pd3(/^N16 cogged ChemSet starters @200/).unitCost, 160);
  ["@400", "@300", "@200"].forEach((s) => ["N12", "N16", "N20"].forEach((d) => assert.ok(pd3(new RegExp(`^${d} cogged ChemSet starters ${s}`)), `${d} ${s} per-lm row`)));
  const hole = saw.products.find((p) => p.name === importAll.CHEMSET_HOLE_PRODUCT);
  assert.ok(hole && hole.unit === "each" && hole.unitCost === 12, "the hole-only allowance the bridge lands Estimates' Drill & epoxy holes on");
  // the detail priced: 10 m wall, both faces @400 → 2 × 26 = 52 bars at $32 = $1,664; or 20 lm (per face) at $80 = $1,600
  const cs = newElementItem(ELEMENT_TYPES[0]);
  cs.qtys[rateKey("SAW CUTS & DOWELS", pd3(/^N16 cogged ChemSet starter bar, 150 embed/).name, "each")] = 52;
  cs.qtys[rateKey("SAW CUTS & DOWELS", pd3(/^N16 cogged ChemSet starters @400/).name, "m")] = 20;
  assert.equal(computeElementCost(cs, defaultRates()).categoryTotals["SAW CUTS & DOWELS"], 52 * 32 + 20 * 80);
  // bridge: an Estimates starter run fixed "drill & epoxy" lands its holes on the hole-only row beside the bar metres
  const br = buildImportFromEstimate({ project: { name: "Starters" }, lines: [
    { elementId: "W", element: "Wall 1", category: "Concrete Wall / Core", materialGroup: "Connections", material: "N16", spec: "Starter bars: N16 @400 crs, 300 cog (drill & epoxy)", qty: 54.6, finalQty: 57.33, unit: "m" },
    { elementId: "W", element: "Wall 1", category: "Concrete Wall / Core", materialGroup: "Connections", material: "Drill & epoxy", spec: "Starter bars: 52 holes for N16, 150mm embedment", qty: 52, finalQty: 52, unit: "no." },
  ], elementGeometry: {} });
  const brItem = br.quote.items[0];
  assert.equal(brItem.qtys[rateKey("SAW CUTS & DOWELS", importAll.CHEMSET_HOLE_PRODUCT, "each")], 52, "52 holes → the hole-only row");
  assert.ok(Object.keys(brItem.qtys).some((k) => /PROCESSED BAR/.test(k) && /N16/.test(k)), "the bar metres still go to Processed Bar");
  assert.ok(!(br.flags || []).some((f) => /Drill & epoxy/.test(f)), "the holes line is mapped, not flagged");
  ["R16", "R20", "R24", "16mm square", "20/25mm square"].forEach((d) => assert.ok(pd3(new RegExp(`^${d} .*sleeve`)), `${d} sleeve dowel row`));
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE");
  assert.ok(conc.products.some((p) => p.name === "Production & transport surcharge" && p.unit === "m3" && p.unitCost === 9.17), "concrete surcharge product seeded at $9.17/m³");
  // Vapour barrier is its own OTHER ACCESSORIES product, distinct from Insulation
  const acc = FULL_CATALOG.find((c) => c.key === "OTHER ACCESSORIES");
  assert.ok(acc.products.some((p) => p.name === "Vapour barrier" && p.unit === "m2"), "Vapour barrier accessory present");
  assert.ok(acc.products.some((p) => p.name === "Insulation" && p.unit === "m2"), "Insulation stays its own separate product");
  const subbies = FULL_CATALOG.find((c) => c.key === "SUB CONTRACTORS / TEMPORARY WORKS");
  assert.ok(subbies.products.some((p) => p.name === "Bored Piers (subcontract)" && p.unit === "quote"), "Bored Piers quote item present");
  const stock = FULL_CATALOG.find((c) => c.key === "STOCK BAR");
  assert.ok(stock.products.some((p) => /N10 Ligatures/.test(p.name)), "N10 Ligatures stock bar present");
  // R6 / R8 / R10 ligature bar in 6 m stock lengths, right under N10 Ligatures (Grady, 12 Nov 2026: "i cant find the R8")
  {
    const names = stock.products.map((p) => p.name);
    assert.deepEqual(names.slice(0, 4), ["N10 Ligatures - 6.0m length", "R6 Ligatures - 6.0m length", "R8 Ligatures - 6.0m length", "R10 Ligatures - 6.0m length"], "the ligature bars head the STOCK BAR band");
    const proc = FULL_CATALOG.find((c) => c.key === "PROCESSED BAR");
    for (const d of ["R6", "R8", "R10"]) {
      const sb = stock.products.find((p) => p.name === `${d} Ligatures - 6.0m length`), pb = proc.products.find((p) => p.name === d);
      assert.equal(sb.unit, "m");
      assert.ok(Math.abs(sb.unitWeight - pb.unitWeight * 6) < 0.005, `${d}: a 6 m length weighs 6 × the PROCESSED BAR kg/m`);
      assert.ok(Math.abs(sb.unitCost - sb.unitWeight * 1.825) < 0.006, `${d}: $/bar = weight × the band's flat $1825/tonne`);
    }
    // 13 m of R8 = 3 whole 6 m bars × $4.33
    const it = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
    it.qtys[rateKey("STOCK BAR", "R8 Ligatures - 6.0m length", "m")] = 13;
    assert.equal(Math.round(computeElementCost(it, defaultRates()).categoryTotals["STOCK BAR"] * 100) / 100, 12.99);
  }
  // The INSULATION category carries specified products (material/thickness/
  // R-value), plain qty × rate — never weight/area/length-priced.
  const insul = FULL_CATALOG.find((c) => c.key === "INSULATION");
  assert.ok(insul, "INSULATION category exists");
  assert.ok(!insul.weightBasis && !insul.areaBasis && !insul.lengthBasis, "INSULATION is plain qty × rate");
  assert.ok(insul.products.some((p) => /Kooltherm/.test(p.name)), "specified insulation products present");
});

check("10 crew-sheet resource columns (both Pump hr and Pump m3, Formwork crew, General Labour crew, Trucks, no Factory column)", () => {
  assert.equal(RESOURCE_COLS.length, 10);
  assert.ok(!RESOURCE_COLS.some((r) => r.key === "factory_hr"), "Factory labour column removed");
  assert.ok(RESOURCE_COLS.some((r) => r.key === "labourer_day"), "General Labour column present");
  const truck = RESOURCE_COLS.find((r) => r.key === "truck_day");
  assert.ok(truck && truck.name === "Trucks" && truck.unit === "day" && !truck.crew, "Trucks plant column present (day rate, not a crew)");
  const fw = RESOURCE_COLS.find((r) => r.key === "formwork_day");
  assert.ok(fw && fw.crew, "Formwork crew column present");
  // the engine must NEVER auto-fill the formwork crew column — manual only
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "suspended_slab"));
  item.qtys[rateKey("FORMWORK", "Bondek", "m2")] = 120;
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 40;
  const sug = suggestedLabourPrefill(item, rates);
  assert.ok(Object.values(sug).every((cells) => cells.formwork_day === undefined), "formwork crew stays blank for manual entry");
  const pumps = RESOURCE_COLS.filter((r) => r.name === "Pump");
  assert.equal(pumps.length, 2);
  assert.notEqual(pumps[0].key, pumps[1].key); // must have distinct keys or one silently overwrites the other
});

/* ---------- direct-rate costing (qty * unitCost) ---------- */
check("Concrete costs directly: 50 m3 Minimum cartage @ $80 = $4000", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 50;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.materialsTotal, 4000);
  assert.equal(cost.concreteQty, 0); // a fee row is never poured volume
});

check("Trench Mesh costs per WHOLE 6 m length off the METRES typed (NOT via tonnage): 60 m of 4 Bar-L12TM = 10 lengths @ $41.19 = $411.90", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("TRENCH MESH", "4 Bar-L12TM", "length")] = 60;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["TRENCH MESH"], 411.9);
});

check("Trench mesh is typed in METRES and bought in whole 6 m lengths, on every row saved or new (24 Nov 2026 — 105.84 lm had priced as 105.84 lengths, $4,359.55 for $741.42); a saved row is asked about once", () => {
  const C = costingAll, KEY = rateKey("TRENCH MESH", "4 Bar-L12TM", "length"), tm = FULL_CATALOG.find((c) => c.key === "TRENCH MESH");
  assert.ok(tm.metresEntry && tm.stockLengthM === 6 && !tm.lengthBasis && !tm.weightBasis && !tm.areaBasis, "its own flag: the Rates modal still edits $ per length");
  assert.ok(tm.products.every((p) => p.unit === "length"), "the rate KEY keeps its unit — keys are never renamed");
  assert.equal(C.stockLengthOf(KEY), 6); assert.equal(C.stockLengthOf(rateKey("STOCK BAR", "N12 - 6.0m length", "m")), null); assert.equal(C.stockLengthOf("CONCRETE::32 mpa::m3"), null);
  const mk = (qty, extra = {}) => ({ ...newElementItem(ELEMENT_TYPES.find((t) => t.id === "raft_foundation")), qtys: { [KEY]: qty }, ...extra });
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.005, `${m || ""}: ${a} vs ${b}`);
  // the row on the screenshot: saved before the change, no mark — read as metres all the same
  const saved = mk(105.84);
  near(computeElementCost(saved, defaultRates()).categoryTotals["TRENCH MESH"], 18 * 41.19, "105.84 m = 18 whole lengths");
  // an EMPTY and a STALE rates row (no barLength on the saved trench rate) price the same
  near(computeElementCost(saved, {}).categoryTotals["TRENCH MESH"], 741.42, "empty rates row");
  near(computeElementCost(saved, { [KEY]: { unitCost: 41.19, unitWeight: 21.8 } }).categoryTotals["TRENCH MESH"], 741.42, "a saved rate from before the field");
  near(computeElementCost(mk(6), {}).categoryTotals["TRENCH MESH"], 41.19, "exactly one length"); near(computeElementCost(mk(6.01), {}).categoryTotals["TRENCH MESH"], 82.38, "a centimetre over buys the next length");
  assert.equal(C.stockLengthsFor(saved, KEY), 18); assert.equal(C.rowUnit(saved, tm, tm.products[0]), "m"); assert.equal(C.stockNote(saved, tm, KEY), " — 18 × 6 m lengths");
  near(C.computeElementReinforcementTonnes(saved, defaultRates()), 18 * 21.8 / 1000, "the tonnage is the whole lengths' weight");
  assert.deepEqual([C.columnBasis(tm).price, C.columnBasis(tm).weight, C.columnBasis(tm).per], ["$ / length", "kg / length", "length"]);
  // the question: asked of a saved row, never of a row typed after the change or written by the bridge
  assert.equal(C.isUnconfirmedStockRow(saved, KEY), true);
  const typed = C.typedQtyItem(mk(undefined), KEY, 40);
  assert.deepEqual(typed.qtyBasis, { [KEY]: "m" }); assert.equal(C.isUnconfirmedStockRow(typed, KEY), false);
  assert.equal(C.isUnconfirmedStockRow(C.typedQtyItem(saved, KEY, 110), KEY), true, "retyping an unanswered row does not answer it");
  assert.equal(C.typedQtyItem(typed, KEY, undefined).qtyBasis, undefined, "a cleared row forgets its mark");
  const other = C.typedQtyItem(mk(undefined), "CONCRETE::32 mpa::m3", 5); assert.equal(other.qtyBasis, undefined, "every other band: the quantity alone");
  // the two answers
  const yes = C.confirmMetresPatch(saved, KEY);
  assert.equal(yes.qtys[KEY], 105.84); assert.equal(C.isUnconfirmedStockRow(yes, KEY), false);
  const wasLengths = C.lengthsToMetresPatch(mk(38), KEY);
  assert.equal(wasLengths.qtys[KEY], 228); near(computeElementCost(wasLengths, {}).categoryTotals["TRENCH MESH"], 38 * 41.19, "38 lengths = 228 m, priced as it was");
  assert.equal(C.lengthsToMetresPatch(wasLengths, KEY), wasLengths, "an answered row is never multiplied again");
  // the project's list
  const rows = C.unconfirmedStockRows([saved, typed, mk(38)], defaultRates());
  assert.equal(rows.length, 2); near(rows[0].before, 4359.55, "priced until 24 Nov"); near(rows[0].now, 741.42); assert.equal(rows[0].lengths, 18); assert.equal(rows[0].whole, false); assert.equal(rows[1].whole, true);
  // wiring: ONE typing rule, the band, the banner, the print and the export
  const readSrc = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const card = readSrc("src/components/ElementCard.jsx"), band = readSrc("src/components/CategoryBlock.jsx"), app = readSrc("src/App.jsx");
  assert.match(card, /stamp\(typedQtyItem\(it, qKey, v\)/); assert.match(card, /onStockBasis=\{setStockBasis\}/);
  assert.match(band, /cat\.lengthBasis \|\| cat\.metresEntry/); assert.match(band, /data-testid="stock-unconfirmed"/); assert.match(band, /cat\.metresEntry \? "Lengths" : "Bars"/);
  assert.match(app, /<StockMetresNotice/);
  ["src/components/PrintQuoteReport.jsx", "src/lib/exportQuote.js"].forEach((f) => assert.match(readSrc(f), /unit: rowUnit\(item, cat, p\)/, f));
});


/* ---------- area-basis costing (Square Mesh only) ---------- */
check("Square Mesh: qty is m² of coverage, cost = ceil(qty/sheetArea) x $/sheet, never a fractional sheet", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  // SL82: sheetArea 14.4 m², $98.12/sheet. 20 m² needs ceil(20/14.4) = 2 sheets.
  item.qtys[rateKey("SQUARE MESH", "SL82", "m2")] = 20;
  const cost = computeElementCost(item, rates);
  assert.equal(Math.round(cost.categoryTotals["SQUARE MESH"] * 100) / 100, 196.24);

  // 14.4 m² exactly needs exactly 1 sheet, not 2 — ceil() must not over-round a clean multiple.
  const item2 = newElementItem(type);
  item2.qtys[rateKey("SQUARE MESH", "SL82", "m2")] = 14.4;
  assert.equal(Math.round(computeElementCost(item2, rates).categoryTotals["SQUARE MESH"] * 100) / 100, 98.12);
});

/* ---------- length-basis costing (Stock Bar only) ---------- */
check("Stock Bar: qty is m of bar needed, cost = ceil(qty/barLength) x $/bar, never a fractional bar", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  // N16 - 6.0m length: barLength 6m, $17.52/bar (derived from a flat $1825/t x 9.6kg/bar).
  // 13m needs ceil(13/6) = 3 bars = $52.56.
  item.qtys[rateKey("STOCK BAR", "N16 - 6.0m length", "m")] = 13;
  const cost = computeElementCost(item, rates);
  assert.equal(Math.round(cost.categoryTotals["STOCK BAR"] * 100) / 100, 52.56);

  // 12m exactly needs exactly 2 bars, not 3 — ceil() must not over-round a clean multiple.
  const item2 = newElementItem(type);
  item2.qtys[rateKey("STOCK BAR", "N16 - 6.0m length", "m")] = 12;
  assert.equal(Math.round(computeElementCost(item2, rates).categoryTotals["STOCK BAR"] * 100) / 100, 35.04);
});

/* ---------- weight-basis costing (Processed Bar only) ---------- */
check("Processed Bar costs via Total Weight x $/tonne: 1000m N16 (1.6kg/m @ $1925/t) = $3080", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("PROCESSED BAR", "N16", "m")] = 1000;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["PROCESSED BAR"], 3080);
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

/* ---------- automatic small-load charge ---------- */
check("Minimum cartage: volume ÷ 4, the rule applied to the REMAINDER of that division", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const mk = (vol) => {
    const it = newElementItem(type);
    it.labourAuto = false;
    it.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
    it.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
    it.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = vol;
    return it;
  };
  const charge = (vol) => {
    const r = autoMinimumCartage(mk(vol), rates);
    return r ? Math.round(r.total * 100) / 100 : 0;
  };

  // A part load under 4 m³ is charged (4 − load) × $80 — the rule itself
  assert.equal(charge(4), 0, "exactly 4 m³ is a full load");
  assert.equal(charge(3.5), 40);
  assert.equal(charge(3), 80);
  assert.equal(charge(2.5), 120);
  assert.equal(charge(2), 160);
  assert.equal(charge(1.5), 200);
  assert.equal(charge(1), 240);

  // …and it is applied to the REMAINDER after dividing the pour by 4.
  const eleven = autoMinimumCartage(mk(11), rates);
  assert.equal(eleven.loads, 3, "11 m³ = 2 full 4 m³ loads + a part load");
  assert.equal(eleven.remainder, 3, "remainder of 11 ÷ 4 is 3");
  assert.equal(eleven.total, 80, "3 m³ remainder is 1 m³ short = $80");

  // anything that divides evenly by 4 leaves no remainder and costs nothing
  [4, 8, 12, 16, 20, 32, 100].forEach((v) =>
    assert.equal(charge(v), 0, `${v} m³ divides evenly by 4`));

  // and every remainder is charged, however big the pour — this is the change
  // from the old truck-load reading, which let a final load of 4 m³ or more
  // (5 m³ in one 8 m³ truck, say) escape the charge entirely
  assert.equal(charge(5), 240, "5 ÷ 4 leaves 1 m³ — 3 m³ short");
  assert.equal(charge(13), 240, "13 ÷ 4 leaves 1 m³ — 3 m³ short");
  assert.equal(charge(30), 160, "30 ÷ 4 leaves 2 m³ — 2 m³ short");
  assert.equal(charge(46.5), 120, "46.5 ÷ 4 = 11 loads + 2.5 m³ — 1.5 m³ short");
  assert.equal(charge(47.5), 40, "47.5 ÷ 4 = 11 loads + 3.5 m³ — 0.5 m³ short");

  // the poured volume counts mixes + blinding, never the additive or the fees
  const mixed = mk(15);
  mixed.qtys[rateKey("CONCRETE", "Blinding concrete", "m3")] = 5;      // 20 total -> divides by 4, no charge
  mixed.qtys[rateKey("CONCRETE", "Penetron (Xypex) additive", "m3")] = 15;
  assert.equal(autoMinimumCartage(mixed, rates), null, "20 m³ of real pour divides evenly; the additive is not volume");
  assert.equal(computeElementCost(mixed, rates).concreteQty, 35, "a fee never inflates poured volume"); // 15+5+15 entered rows

  // the truck-size production rate no longer feeds this — the divisor is the
  // 4 m³ minimum itself, so changing truck size must not move the charge
  const small = { ...rates, [rateKey("PRODUCTION", "Concrete truck load size", "m³/load")]: { unitCost: 6 } };
  assert.equal(charge(11), 80);
  assert.equal(autoMinimumCartage(mk(11), small).total, 80, "truck size is irrelevant to the charge now");

  // a typed qty takes the row fully manual (a known delivery split, say)
  const typed = mk(11);
  typed.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  assert.equal(autoMinimumCartage(typed, rates), null);
  assert.equal(computeElementCost(typed, rates).materialsTotal, 11 * C25);

  // and the $/m³ honours a rates override
  const dearer = { ...rates, [rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")]: { unitCost: 100 } };
  assert.equal(autoMinimumCartage(mk(3), dearer).total, 100);
});

check("Environment levy auto-applies per m³ to the whole poured volume ($2.80), typed qty takes over", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  item.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  item.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 40;
  const levy = autoEnvironmentLevy(item, rates);
  assert.equal(levy.qty, 40);
  near(levy.total, 40 * 2.8);
  near(computeElementCost(item, rates).materialsTotal, 40 * C25 + 40 * 2.8);
  // typed wins
  item.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  assert.equal(autoEnvironmentLevy(item, rates), null);
  near(computeElementCost(item, rates).materialsTotal, 40 * C25);
});

check("Pumping: contract minimums bill the minimum hours, and every pump rate matches the J. King schedule", () => {
  const rates = defaultRates();
  const cat = FULL_CATALOG.find((c) => c.key === "CONCRETE PUMPING");
  assert.ok(cat, "CONCRETE PUMPING category exists");
  const rateOf = (name) => cat.products.find((p) => p.name.startsWith(name));
  assert.equal(rateOf("Line pump — up to 70m").unitCost, 200);
  assert.equal(rateOf("Line pump — 70-90m").unitCost, 240);
  assert.equal(rateOf("Boom pump — 28-32m").unitCost, 220);
  assert.equal(rateOf("Boom pump — 37m").unitCost, 230);
  assert.equal(rateOf("Boom pump — 42m").unitCost, 240);
  assert.equal(rateOf("Pumped volume").unitCost, 10);
  assert.equal(rateOf("Washout bag").unitCost, 200);
  assert.equal(rateOf("Offsite washout").unitCost, 250);
  assert.equal(rateOf("Extra labourer").unitCost, 100);
  // the "quote only" lines carry no rate — priced from the supplier's quote
  assert.equal(rateOf("Line pump — over 90m").unit, "quote");
  assert.equal(rateOf("Boom pump — 47m").unit, "quote");

  // 4-hour minimum: 1 hour on site still bills 4
  const boom = rateOf("Boom pump — 28-32m");
  const r = rates[rateKey("CONCRETE PUMPING", boom.name, boom.unit)];
  assert.equal(r.minQty, 4, "the minimum travels into the rates object, so it is editable");
  assert.equal(computeRowTotal(cat, r, 1), 4 * 220);
  assert.equal(computeRowTotal(cat, r, 4), 4 * 220);
  assert.equal(computeRowTotal(cat, r, 6), 6 * 220, "above the minimum bills the real hours");
  assert.equal(computeRowTotal(cat, r, 0), 0, "a blank row still costs nothing");
  // 6-hour minimum on the hose hand, 1-hour on travel
  const hand = rateOf("Extra labourer");
  assert.equal(computeRowTotal(cat, rates[rateKey("CONCRETE PUMPING", hand.name, hand.unit)], 2), 6 * 100);
  const travel = rateOf("Travel charge");
  assert.equal(computeRowTotal(cat, rates[rateKey("CONCRETE PUMPING", travel.name, travel.unit)], 0.5), 1 * 220);
  // an element prices them through the normal path
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  item.qtys[rateKey("CONCRETE PUMPING", boom.name, boom.unit)] = 2;   // billed as 4
  assert.equal(computeElementCost(item, rates).categoryTotals["CONCRETE PUMPING"], 880);
});

check("Production & transport surcharge auto-applies per m³ to the WHOLE poured volume ($9.17), typed qty takes over, rate editable", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  item.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0; // isolate the surcharge
  item.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 50; // 50 ≥ 30: no small-load, but the surcharge still applies
  const surKey = rateKey("CONCRETE", "Production & transport surcharge", "m3");
  const sur = autoConcreteSurcharge(item, rates);
  assert.equal(sur.qty, 50);
  near(sur.total, 50 * 9.17);
  const cost = computeElementCost(item, rates);
  near(cost.materialsTotal, 50 * C25 + 50 * 9.17);
  assert.equal(cost.concreteQty, 50, "the surcharge fee must not inflate poured volume");
  near(labourQuantities(item, rates).concreteM3, 50, "nor the labour engine's concrete m³");
  // a typed qty on the surcharge row switches it fully manual (no double-charge)
  item.qtys[surKey] = 10;
  assert.equal(autoConcreteSurcharge(item, rates), null);
  near(computeElementCost(item, rates).materialsTotal, 50 * C25 + 10 * 9.17);
  // the rate honours a rates-library override — editable in place, the Rates modal, everywhere
  delete item.qtys[surKey];
  rates[surKey] = { unitCost: 12.5 };
  near(autoConcreteSurcharge(item, rates).total, 50 * 12.5);
});

check("Quote statuses: 'Completed Estimating' sits between Estimating and Quoting, with a style entry", () => {
  const { QUOTE_STATUSES, QUOTE_STATUS_STYLES } = catalogAll;
  const i = QUOTE_STATUSES.indexOf("Completed Estimating");
  assert.ok(i > QUOTE_STATUSES.indexOf("Estimating") && i < QUOTE_STATUSES.indexOf("Quoting"), "pipeline order");
  QUOTE_STATUSES.forEach((s) => assert.ok(QUOTE_STATUS_STYLES[s], `every status needs a style entry (missing: ${s})`));
});
await checkAsync("Taking Off splits the old Estimating step (26 Oct 2026, renamed from Measuring 27 Oct 2026): it sits between Queued and Estimating, is open work everywhere — the dashboard's opening tile, the live crew prefill, the shell's OPEN_WORK and status select, the AI Engine's Quality checks — never pins rates, and a quote stored as 'Measuring' reads as Taking Off", async () => {
  const { QUOTE_STATUSES, QUOTE_STATUS_STYLES, normalizeStatus, LEGACY_STATUS_NAMES } = catalogAll;
  const { RATES_LOCKED_STATUSES } = await import("../src/lib/rateFreeze.js");
  const { LIVE_HANDOVER_STATUSES } = await import("../src/lib/handover.js");
  const { OPEN_STATUSES } = await import("../src/lib/planner.js");
  assert.deepEqual(OPEN_STATUSES, ["Queued", "Taking Off", "Estimating"], "the dashboard opens on it");
  const i = QUOTE_STATUSES.indexOf("Taking Off");
  assert.ok(i === QUOTE_STATUSES.indexOf("Queued") + 1 && i === QUOTE_STATUSES.indexOf("Estimating") - 1, "Queued → Taking Off → Estimating");
  assert.ok(!QUOTE_STATUSES.includes("Measuring") && !QUOTE_STATUS_STYLES.Measuring, "Measuring is gone from the list");
  assert.ok(/orange/.test(QUOTE_STATUS_STYLES["Taking Off"].bar), "its own orange");
  assert.ok(!RATES_LOCKED_STATUSES.includes("Taking Off"), "open, never pinned");
  assert.ok(LIVE_HANDOVER_STATUSES.has("Taking Off"), "the live prefill runs on it");
  assert.deepEqual(LEGACY_STATUS_NAMES, { Measuring: "Taking Off" });
  assert.equal(normalizeStatus("Measuring"), "Taking Off", "the day-old name reads as the new one");
  assert.equal(normalizeStatus("Estimating"), "Estimating");
  assert.equal(normalizeStatus(undefined), undefined, "a missing status stays missing (the caller's default applies)");
  const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  assert.ok(/OPEN_WORK = \{ 'Queued':1, 'Taking Off':1, 'Estimating':1, 'Quoting':1 \}/.test(shell), "the welcome panel's open work");
  assert.ok(/<option value="Taking Off">Taking Off<\/option>/.test(shell), "the default-status select");
  assert.ok(/nTakingOff/.test(shell) && !/nMeasuring|'Measuring'/.test(shell), "a welcome line for it, none for Measuring");
  const ai = fs.readFileSync(new URL("../portal/ai-engine.html", import.meta.url), "utf8");
  assert.ok(/\["Queued","Taking Off","Estimating"\]\.includes\(q\.status\)/.test(ai), "the Quality checks picker's open-work group");
});

check("Formwork rates match the Rates Library: Conventional $150/m², Edgeform $50/lm", () => {
  // These two seeded $60 and $8 while the Rates Library — Gradcon's actual
  // price list — said $150 and $50, so an element card priced conventional
  // formwork at well under half its real rate. The library rules; this check
  // exists so the two can never drift apart again unnoticed.
  const rates = defaultRates();
  assert.equal(rates[rateKey("FORMWORK", "Conventional", "m2")].unitCost, 200); // Grady's 22 Oct 2026 formwork sheet
  assert.equal(rates[rateKey("FORMWORK", "Edgeform", "m")].unitCost, 25);
  // and the concrete grades the same drift affected
  assert.equal(rates[rateKey("CONCRETE", "32 mpa", "m3")].unitCost, 213);
  assert.equal(rates[rateKey("CONCRETE", "25 mpa", "m3")].unitCost, 204);
  assert.equal(rates[rateKey("CONCRETE", "50 mpa", "m3")].unitCost, 264.2);
  assert.equal(rates[rateKey("CONCRETE", "40 mpa Agilia", "m3")].unitCost, 339);
});

check("Subcontract 'quote' items: the received quote is entered ON THE ELEMENT — qty 1 books the whole quote, a piling row never reads a shared rate", () => {
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  const key = rateKey("SUB CONTRACTORS / TEMPORARY WORKS", "Screw Piling", "quote");
  item.qtys[key] = 1;
  assert.equal(computeElementCost(item, rates).materialsTotal, 0); // no quote entered yet — costs nothing
  rates[key] = { unitCost: 45000 }; // a figure in the SHARED rate (how it worked before 29 Sep 2026) — ignored for piling
  assert.equal(computeElementCost(item, rates).materialsTotal, 0);
  item.rateOverrides = { [key]: { unitCost: 45000 } }; // the quote received, typed straight on the row of THIS element
  assert.equal(computeElementCost(item, rates).materialsTotal, 45000);
});

/* ---------- labour matrix ---------- */
check("Labour rolls up: 8 Concrete Crew days + 20 Pump hrs on one task = $17,000, folds into element total", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  pourTask.qtys["concreter_day"] = 8; // rows default PER PERSON: 8 man-days × $500
  pourTask.qtys["pump_hr"] = 20; // 20 * $250
  const cost = computeElementCost(item, rates);
  assert.equal(cost.labourTotal, 8 * 500 + 20 * 250);
  assert.equal(cost.total, cost.materialsTotal + cost.labourTotal + cost.additionalTotal);
});

check("Labour totals split correctly across BOTH Pump columns (hr and m³) without collision", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "suspended_slab");
  const item = newElementItem(type);
  item.labourAuto = false; // pin the two typed pump cells only
  const task = item.tasks[0];
  task.qtys["pump_hr"] = 10; // 10 * $250 = 2500
  task.qtys["pump_m3"] = 40; // 40 * $10  = 400
  const cost = computeElementCost(item, rates);
  assert.equal(cost.resourceCosts["pump_hr"], 2500);
  assert.equal(cost.resourceCosts["pump_m3"], 400);
  assert.equal(cost.labourTotal, 2900);
});

/* ---------- crew auto labour (fractional crew-days) ---------- */
check("Auto labour: crew-days from crew-day blocks with decimals kept (10 m³/crew-day pour, 1 t/crew-day steel), empty cells only", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 50; // every 10 m³ = one Concrete Crew day -> 5 crew-days
  item.qtys[rateKey("PROCESSED BAR", "N16", "m")] = 2000; // 3.2 t -> 3.2 Steel Crew days (decimals kept, no ceiling)
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  const tieTask = item.tasks.find((t) => t.name === "Tie reo");

  // rows default PER PERSON, so suggestions land as man-days: crews × men
  const suggestions = suggestedLabourPrefill(item, rates);
  assert.equal(suggestions[pourTask.id].concreter_day, 15); // 5 crew-days × 3 men
  assert.equal(suggestions[tieTask.id].steelfixer_day, 16); // 3.2 crew-days × 5 men
  // switched to per crew, the same rows suggest raw crew-days
  pourTask.crewMode = "crew"; tieTask.crewMode = "crew";
  const crewSug = suggestedLabourPrefill(item, rates);
  assert.equal(crewSug[pourTask.id].concreter_day, 5);
  assert.equal(crewSug[tieTask.id].steelfixer_day, 3.2);
  pourTask.crewMode = undefined; tieTask.crewMode = undefined;
  // a pour books the pump: flat 6 hrs plus the true m³ pumped (never rounded)
  assert.equal(suggestions[pourTask.id].pump_hr, 6);
  assert.equal(suggestions[pourTask.id].pump_m3, 50);

  // A cell the estimator already filled in is never included in the suggestions,
  // so a typed value can never be overridden by the engine.
  pourTask.qtys["concreter_day"] = 3;
  const suggestions2 = suggestedLabourPrefill(item, rates);
  assert.equal(suggestions2[pourTask.id].concreter_day, undefined, "must not suggest a value for an already-filled cell");
  assert.equal(suggestions2[pourTask.id].pump_hr, 6); // other cells on the row still auto
  assert.equal(suggestions2[tieTask.id].steelfixer_day, 16); // unrelated task/resource still suggested
});

check("Fractional crew-days: tiny quantities stay fractional (no ceiling, no minimum whole crew), cost = days × men × man-day rate", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}${msg ? " — " + msg : ""}`);
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  // 0.13 t of steel -> 0.13 Steel Crew days, costed 0.13 × 5 men × $650.
  item.qtys[rateKey("PROCESSED BAR", "N12", "m")] = 146; // 146 m × 0.888 kg/m ≈ 0.13 t
  const tieTask = item.tasks.find((t) => t.name === "Tie reo");
  const sug = suggestedLabourPrefill(item, rates);
  near(sug[tieTask.id].steelfixer_day, 0.65); // 0.13 crew-days × 5 men (per-person default)
  const shown = taskRowMeta(tieTask.name, labourQuantities(item, rates)).autoQty;
  assert.ok(Math.abs(shown - 0.13) < 0.005, `Qty column must display the true tonnage (~0.13), got ${shown}`);
  near(computeElementCost(item, rates).resourceCosts.steelfixer_day, 0.13 * 5 * 650);

  // 4 m³ of concrete -> 0.4 Concrete Crew days = 1.2 man-days, pump 6 hrs + true 4 m³.
  const small = newElementItem(type);
  small.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 4;
  const pourTask = small.tasks.find((t) => t.name === "Pour concrete");
  const sug2 = suggestedLabourPrefill(small, rates);
  near(sug2[pourTask.id].concreter_day, 1.2);
  assert.equal(sug2[pourTask.id].pump_hr, 6);
  assert.equal(sug2[pourTask.id].pump_m3, 4);
});

check("Per-row crew flexibility: per-crew rows cost days × own men × man-day rate; per-person rows cost man-days directly", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}${msg ? " — " + msg : ""}`);
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.labourAuto = false;
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  pourTask.qtys.concreter_day = 2;
  // default: PER PERSON — 2 man-days costed directly at the $500 day rate
  near(computeElementCost(item, rates).resourceCosts.concreter_day, 2 * 500);
  // switched to per crew: cells become crew-days × the column default (3 men)
  pourTask.crewMode = "crew";
  near(computeElementCost(item, rates).resourceCosts.concreter_day, 2 * 3 * 500);
  // this row's own crew is 4 men — no blanket crew size
  pourTask.crewSize = 4;
  near(computeElementCost(item, rates).resourceCosts.concreter_day, 2 * 4 * 500);
  // back to per person: man-days again, crewSize ignored
  pourTask.crewMode = "person";
  near(computeElementCost(item, rates).resourceCosts.concreter_day, 2 * 500);
  // fractional cells survive untouched (no whole-crew rounding)
  pourTask.crewMode = "crew";
  pourTask.qtys.concreter_day = 1.5;
  near(computeElementCost(item, rates).resourceCosts.concreter_day, 1.5 * 4 * 500);
  near(computeElementCost(item, rates).resourceTotals.concreter_day, 1.5);
  // a per-person row's AUTO suggestion converts crews -> man-days (crews × men)
  const auto = newElementItem(type);
  auto.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 50; // 5 crew-days
  const autoPour = auto.tasks.find((t) => t.name === "Pour concrete");
  autoPour.crewMode = "person";
  autoPour.crewSize = 2;
  near(suggestedLabourPrefill(auto, rates)[autoPour.id].concreter_day, 10, "5 crews × 2 men = 10 man-days");
  near(computeElementCost(auto, rates).resourceCosts.concreter_day, 10 * 500);
});

check("Seamless labour: computeElementCost costs the auto crew days live (no write-back), and a typed cell overrides", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  assert.equal(item.labourAuto, true, "new elements default to auto labour");
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 50;
  // rows default PER PERSON: pour 50 m³ -> 5 crew-days × 3 men = 15 man-days
  // × $500; washout 50/60 = 0.83 crews × 3 = 2.49 man-days × $400; pump
  // 6 hr @ $250 + 50 m³ @ $10.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const cost = computeElementCost(item, rates);
  assert.equal(cost.resourceTotals.concreter_day, 15);
  near(cost.resourceTotals.labourer_day, 2.49);
  assert.equal(cost.resourceTotals.pump_hr, 6);
  assert.equal(cost.resourceTotals.pump_m3, 50);
  near(cost.labourTotal, 15 * 500 + 2.49 * 400 + 6 * 250 + 50 * 10);
  // tasks were NOT written to — the derivation is live
  assert.ok(item.tasks.every((t) => Object.keys(t.qtys).length === 0), "auto labour must not write into tasks");
  // a typed cell wins over the engine
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  pourTask.qtys.concreter_day = 4;
  assert.equal(computeElementCost(item, rates).resourceTotals.concreter_day, 4);
  // quantities changing flow straight through (the old one-shot prefill went stale here)
  pourTask.qtys.concreter_day = undefined;
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 100;
  assert.equal(computeElementCost(item, rates).resourceTotals.concreter_day, 30); // 10 crews × 3 men (per-person default)
  // auto off = fully manual matrix
  item.labourAuto = false;
  assert.equal(computeElementCost(item, rates).resourceTotals.concreter_day, 0);
});

check("Crew sheet: Finish row draws mesh m², a typed row Qty overrides the drawn quantity, legacy task names still auto", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 36; // the screenshot scenario: 36 m³
  item.qtys[rateKey("SQUARE MESH", "SL82", "m2")] = 200; // finish area drawn from mesh coverage
  const finishTask = item.tasks.find((t) => t.name === "Finish concrete surfaces");
  const sug = suggestedLabourPrefill(item, rates);
  assert.equal(sug[finishTask.id].concreter_day, 2.01); // 200/300 = 0.67 crew-days × 3 men (per-person default)
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  assert.equal(sug[pourTask.id].concreter_day, 10.8); // 36/10 = 3.6 crew-days × 3 men — finishing on its own row

  // typing a row Qty overrides what the row draws on
  pourTask.qty = 20;
  const sug2 = suggestedLabourPrefill(item, rates);
  assert.equal(sug2[pourTask.id].concreter_day, 6); // 20/10 = 2 crew-days × 3 men
  assert.equal(sug2[pourTask.id].pump_m3, 20); // pump volume follows the override too

  // an element saved before the crew sheet keeps auto on its old task names
  const legacy = newElementItem(type);
  legacy.tasks = [
    { id: "L1", name: "Formwork / box out", qtys: {} },
    { id: "L2", name: "Pour concrete (pump)", qtys: {} },
    { id: "L3", name: "Tie steel", qtys: {} },
  ];
  legacy.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 40;
  legacy.qtys[rateKey("FORMWORK", "Bondek", "m2")] = 100;
  const sug3 = suggestedLabourPrefill(legacy, rates);
  // formwork rows get NO auto crew fill — entered manually, always — but
  // the Qty column still shows the drawn formwork m² as a guide
  assert.equal(sug3["L1"], undefined, "formwork/prop & form crew cells must stay blank");
  assert.equal(taskRowMeta("Formwork / box out", labourQuantities(legacy, rates)).autoQty, 100);
  assert.equal(sug3["L2"].concreter_day, 12); // 40/10 = 4 crew-days × 3 men
  assert.equal(sug3["L2"].pump_m3, 40); // legacy pump task still pumps the true volume
  assert.equal(sug3["L2"].pump_hr, 6); // whole-pour pump booking
});

check("Suspended slab 2.99 t of steel is 2.99 Steel Crew days (decimals kept), and new elements carry the crew-engine marker (labourVer 2)", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "suspended_slab");
  const item = newElementItem(type);
  assert.equal(item.labourVer, 2, "new elements must be born at labourVer 2 so the stale-cell migration never wipes them");
  item.qtys[rateKey("PROCESSED BAR", "N16", "m")] = 1868; // 1.6 kg/m -> 2.9888 t, shown as 2.99
  const tie = item.tasks.find((t) => /tie/i.test(t.name));
  assert.equal(taskRowMeta(tie.name, labourQuantities(item, rates)).autoQty, 2.99);
  near(suggestedLabourPrefill(item, rates)[tie.id].steelfixer_day, 14.95); // 2.99 crews × 5 men, no whole-crew ceiling
  near(computeElementCost(item, rates).resourceCosts.steelfixer_day, 2.99 * 5 * 650);
});

check("Fractional crew cells kept as typed (0.5 stays 0.5, 1.2 stays 1.2); plant days still book whole; pump m³ a true volume", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.labourAuto = false;
  const pourTask = item.tasks.find((t) => t.name === "Pour concrete");
  const tieTask = item.tasks.find((t) => t.name === "Tie reo");
  pourTask.qtys.concreter_day = 1.2; // stays 1.2 crew-days
  tieTask.qtys.steelfixer_day = 0.5; // stays half a crew-day
  pourTask.qtys.excavator_day = 0.5; // plant still books whole days -> 1
  pourTask.qtys.pump_m3 = 36.5; // real measured volume, never rounded
  const cost = computeElementCost(item, rates);
  near(cost.resourceTotals.concreter_day, 1.2);
  near(cost.resourceTotals.steelfixer_day, 0.5);
  assert.equal(cost.resourceTotals.excavator_day, 1);
  assert.equal(cost.resourceTotals.pump_m3, 36.5);
  near(cost.labourTotal, 1.2 * 500 + 0.5 * 650 + 1 * 900 + 36.5 * 10); // per-person default: man-days × day rate
});

check("Excavate and spoil rows are separate: Excavation (m³) drives the Excavate row, Soil removal (m³) drives the spoil row; neither auto-fills plant", () => {
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "excavation_bulk"));
  const excTask = item.tasks.find((t) => /excavat/i.test(t.name));
  const spoilTask = item.tasks.find((t) => /remove soil/i.test(t.name));
  assert.ok(excTask && spoilTask, "a new element carries both rows");
  assert.equal(item.tasks.indexOf(spoilTask), item.tasks.indexOf(excTask) + 1, "the spoil row sits right after the excavate row");
  assert.ok(!/excavat/i.test(spoilTask.name), "the spoil row never matches the excavate rule");
  // only soil removal entered (a quote from before the Excavation line existed): excavate falls back to it
  item.qtys[rateKey("OTHER ALLOWANCES", "Soil removal", "m3")] = 85;
  let lq = labourQuantities(item, rates);
  assert.equal(taskRowMeta(excTask.name, lq).autoQty, 85);
  assert.equal(taskRowMeta(spoilTask.name, lq).autoQty, 85);
  // both entered: two different volumes, cleanly separated
  item.qtys[rateKey("OTHER ALLOWANCES", "Excavation", "m3")] = 70;
  lq = labourQuantities(item, rates);
  assert.equal(taskRowMeta(excTask.name, lq).autoQty, 70);
  assert.equal(taskRowMeta(spoilTask.name, lq).autoQty, 85);
  assert.equal(taskRowMeta(excTask.name, lq).unit, "m³"); assert.equal(taskRowMeta(spoilTask.name, lq).unit, "m³");
  const sug = suggestedLabourPrefill(item, rates);
  assert.ok(!sug[excTask.id] || sug[excTask.id].excavator_day === undefined, "excavator days must never auto-fill");
  assert.ok(!sug[spoilTask.id] || sug[spoilTask.id].truck_day === undefined, "truck days must never auto-fill");
  // the Excavation line seeds at $0: a quantity driver, not a cost, until a rate is set
  assert.equal(RATE("OTHER ALLOWANCES", "Excavation", "m3"), 0);
  assert.equal(computeElementCost(item, rates).categoryTotals["OTHER ALLOWANCES"], 85 * 40);
  // a renamed additional row also picks up the spoil quantity
  assert.equal(taskRowMeta("Soil removal — trucks", lq).autoQty, 85);
});

check("Crew rates: per-person man-day keys — both stale 'day' and crew-era 'crew-day' overrides are retired", () => {
  const rates = defaultRates();
  const crew = RESOURCE_COLS.find((r) => r.key === "concreter_day");
  assert.equal(crew.unit, "man-day", "crew columns price per person under the man-day unit");
  assert.equal(crew.rate, 500, "catalog default is the per-person day rate");
  assert.equal(crew.men, 3, "column keeps its default men-per-crew for rows that don't set their own");
  // overrides saved under either older generation of keys must not apply
  rates[rateKey("LABOUR", "Concrete Crew", "day")] = { unitCost: 9999 };
  rates[rateKey("LABOUR", "Concrete Crew", "crew-day")] = { unitCost: 8888 };
  assert.equal(labourResourceRate(rates, crew), 500, "man-day catalog default must win over both stale key generations");
  // an override saved under the NEW man-day key applies as normal
  rates[rateKey("LABOUR", "Concrete Crew", "man-day")] = { unitCost: 550 };
  assert.equal(labourResourceRate(rates, crew), 550);
  // pump m³ rate is $10 under its new m³ key
  const pumpM3 = RESOURCE_COLS.find((r) => r.key === "pump_m3");
  assert.equal(labourResourceRate(defaultRates(), pumpM3), 10);
});

/* ---------- External Quote scope lines (client-facing $ always ties to the real sell price) ---------- */
check("computeExternalScopeLines: per-element sell allocation sums exactly to the real margin-ladder sell price", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);
  const rates = defaultRates();
  const a = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  a.labourAuto = false;
  a.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10; // 10 × the catalog 25 mpa rate
  a.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0; // typed 0 disables the auto small-load charge — this check pins the allocation maths
  a.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  a.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0; // and the auto surcharge
  const b = newElementItem(ELEMENT_TYPES.find((t) => t.id === "capping_beam"));
  b.labourAuto = false;
  b.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 5;
  b.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  b.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  b.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  const c = newElementItem(ELEMENT_TYPES.find((t) => t.id === "pool_wall")); // no qty entered — must be dropped
  const { lines, totalExGst } = computeExternalScopeLines([a, b, c], rates, 0.08, 0.05, 0.3);

  assert.equal(lines.length, 2, "the zero-qty element must not produce a scope line");
  const directTotal = 10 * C25 + 5 * C32;
  const expectedTotal = (directTotal * 1.13) / 0.7; // matches computeMarginLadder's own formula
  near(totalExGst, expectedTotal);
  near(lines.reduce((s, l) => s + l.sellExGst, 0), totalExGst);
  near(lines[0].sellExGst, ((10 * C25) / directTotal) * expectedTotal);
});

/* ---------- variable margins (1 Nov 2026) ---------- */
check("margins: project → element → subcontract quote row, each a fraction, blank = inherit, 0 is a real pin", () => {
  const M = costingAll;
  assert.equal(M.pinnedMargin(""), null); assert.equal(M.pinnedMargin(undefined), null); assert.equal(M.pinnedMargin("abc"), null); assert.equal(M.pinnedMargin(1.2), null);
  assert.equal(M.pinnedMargin(0), 0, "0% is a pin (pass-through at cost), not blank");
  assert.equal(M.pinnedMargin(0.08), 0.08);
  assert.equal(M.projectMargin({}), M.getDefaultMargin(), "no project margin typed → the Settings default");
  assert.equal(M.projectMargin({ marginPct: 0.22 }), 0.22);
  const item = { marginPct: undefined, rowMargins: { k1: 0.08 } };
  assert.equal(M.elementMargin(item, 0.22), 0.22, "blank element inherits the project");
  assert.equal(M.rowMargin(item, "k1", 0.22), 0.08, "a pinned row beats the element");
  assert.equal(M.rowMargin(item, "k2", 0.22), 0.22, "an unpinned row inherits the element, which inherits the project");
  assert.equal(M.rowMargin({ marginPct: 0.3 }, "k2", 0.22), 0.3, "an unpinned row follows a pinned element");
  assert.equal(M.marginSource(item, "k1"), "row"); assert.equal(M.marginSource(item, "k2"), "project"); assert.equal(M.marginSource({ marginPct: 0.3 }, null), "element");
  // patches write fractions and remove on blank
  const pinned = M.elementMarginPatch({ id: "a" }, 0.3); assert.equal(pinned.marginPct, 0.3);
  assert.equal("marginPct" in M.elementMarginPatch(pinned, undefined), false, "clearing removes the key");
  const rp = M.rowMarginPatch({ id: "a" }, "k", 0.08); assert.deepEqual(rp.rowMargins, { k: 0.08 });
  assert.equal("rowMargins" in M.rowMarginPatch(rp, "k", ""), false, "an empty pin map is dropped");
  assert.equal(M.projectMarginPatch({ marginPct: 0.2 }, undefined).marginPct, undefined);
  assert.deepEqual(M.marginStepsAround(0.22, [0.1, 0.25]), [0.1, 0.22, 0.25], "the ladder gains the project rung");
  // markup on cost ↔ margin on sell: typed either way, stored as the margin
  assert.ok(Math.abs(M.markupFromMargin(0.25) - 1 / 3) < 1e-12); assert.ok(Math.abs(M.marginFromMarkup(1 / 3) - 0.25) < 1e-12);
  assert.equal(M.marginFromMarkup(1), 0.5, "a 100% markup is a 50% margin"); assert.equal(M.marginFromMarkup(0), 0); assert.equal(M.marginFromMarkup("x"), null);
  assert.ok(Math.abs(M.marginFromMarkup(M.markupFromMargin(0.08)) - 0.08) < 1e-12);
  assert.deepEqual(M.marginStepsAround(0.25, [0.1, 0.25]), [0.1, 0.25]);
});
check("margins: computeElementSell splits an element into its own work and its subcontract quote rows, each at its resolved rate", () => {
  const M = costingAll;
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} !~= ${b}`);
  const rates = defaultRates();
  const el = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles"));
  el.labourAuto = false;
  const subKey = rateKey(M.SUBCONTRACT_CATEGORY_KEY, "Screw Piling", "quote");
  el.qtys[subKey] = 1; el.rateOverrides = { [subKey]: { unitCost: 2500 } };
  el.additional.push({ id: "x", name: "Site allowance", unit: "item", qty: 1, rate: 700 });  // own work: $700
  const quote = { overheadPct: 0.1, contingencyPct: 0, marginPct: 0.25 };
  const subs = M.subcontractQuoteLines(el, rates, "both");
  assert.equal(subs.length, 1); assert.equal(subs[0].key, subKey); near(subs[0].cost, 2500);
  let e = M.computeElementSell(el, rates, quote, "both");
  near(e.cost, 3200); near(e.loaded, 3520);
  assert.deepEqual(e.lines.map((l) => l.kind), ["own", "sub"]);
  near(e.sell, 3520 / 0.75, "nothing pinned: the whole element at the project margin");
  // the piler passed through at 8%, the own work still at 25%
  const pinnedRow = M.rowMarginPatch(el, subKey, 0.08);
  e = M.computeElementSell(pinnedRow, rates, quote, "both");
  near(e.sell, (700 * 1.1) / 0.75 + (2500 * 1.1) / 0.92, "own work at 25%, the sub quote at 8%");
  assert.equal(e.lines[1].source, "row"); assert.equal(e.lines[0].source, "project");
  // the element pinned at 30%: its own work moves, the pinned row does not
  const pinnedEl = M.elementMarginPatch(pinnedRow, 0.3);
  e = M.computeElementSell(pinnedEl, rates, quote, "both");
  near(e.sell, (700 * 1.1) / 0.7 + (2500 * 1.1) / 0.92);
  assert.equal(e.lines[0].source, "element");
  // an unpinned row under a pinned element follows the element
  const onlyEl = M.elementMarginPatch(el, 0.3);
  e = M.computeElementSell(onlyEl, rates, quote, "both");
  near(e.sell, 3520 / 0.7); assert.equal(e.lines[1].margin, 0.3);
  // a labour-only scope still charges the "always" subcontract band; an element with no sub rows has one own line
  const plain = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings")); plain.labourAuto = false; plain.additional.push({ id: "y", name: "A", unit: "item", qty: 1, rate: 100 });
  const pe = M.computeElementSell(plain, rates, quote, "both"); assert.equal(pe.lines.length, 1); assert.equal(pe.lines[0].kind, "own"); near(pe.sell, 110 / 0.75);
});
check("margins: the register totals every line, states the blended rate and the per-class subtotals; the external / tender lines tie to it exactly", () => {
  const M = costingAll;
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} !~= ${b}`);
  const rates = defaultRates();
  const subKey = rateKey(M.SUBCONTRACT_CATEGORY_KEY, "Screw Piling", "quote");
  const piles = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles")); piles.labourAuto = false; piles.label = "Screw Piles";
  piles.qtys[subKey] = 1; piles.rateOverrides = { [subKey]: { unitCost: 2500 } }; piles.rowMargins = { [subKey]: 0.08 };
  const strip = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings")); strip.labourAuto = false; strip.label = "Strip Footings";
  strip.additional.push({ id: "s", name: "Own", unit: "item", qty: 1, rate: 3200 });
  const slab = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground")) || null;
  const slabItem = newElementItem(ELEMENT_TYPES.find((t) => t.id === "capping_beam")); slabItem.labourAuto = false; slabItem.label = "Slab"; slabItem.marginPct = 0.25;
  slabItem.additional.push({ id: "z", name: "Own", unit: "item", qty: 1, rate: 826 });
  const empty = newElementItem(ELEMENT_TYPES.find((t) => t.id === "pool_wall")); // nothing priced: never a register line
  const quote = { overheadPct: 0, contingencyPct: 0, marginPct: 0.25 };
  const items = [strip, piles, slabItem, empty];
  const reg = M.computeMarginRegister(items, rates, quote, "both");
  assert.equal(reg.elements.length, 3, "the unpriced element is left out");
  assert.deepEqual(reg.lines.map((l) => `${l.kind}:${l.source}`), ["own:project", "sub:row", "own:element"]);
  near(reg.totals.cost, 6526); near(reg.totals.loaded, 6526);
  const expectSell = 3200 / 0.75 + 2500 / 0.92 + 826 / 0.75;
  near(reg.totals.sell, expectSell); near(reg.totals.sellIncGst, expectSell * (1 + M.getGstRate()));
  near(reg.totals.blended, 1 - 6526 / expectSell);
  assert.equal(reg.pinned, 2);
  near(reg.byClass.sub.sell, 2500 / 0.92); near(reg.byClass.sub.margin, 0.08); near(reg.byClass.own.loaded, 4026);
  // the tender / external lines are the same figures, element by element
  const ext = M.computeExternalScopeLines(items, rates, 0, 0, 0.25, "both");
  near(ext.totalExGst, expectSell);
  const byId = {}; ext.lines.forEach((l) => { byId[l.id] = l.sellExGst; });
  near(byId[piles.id], 2500 / 0.92); near(byId[slabItem.id], 826 / 0.75); near(byId[strip.id], 3200 / 0.75);
  // the overall rate moves every inheriting line and leaves the pinned ones alone
  const reg2 = M.computeMarginRegister(items, rates, { ...quote, marginPct: 0.2 }, "both");
  near(reg2.totals.sell, 3200 / 0.8 + 2500 / 0.92 + 826 / 0.75);
  // a project with no margin typed prices at the Settings default (the old behaviour), so nothing saved re-prices on its own
  const reg3 = M.computeMarginRegister([strip], rates, { overheadPct: 0.08, contingencyPct: 0.05 }, "both");
  near(reg3.totals.sell, (3200 * 1.13) / (1 - M.getDefaultMargin()));
});
checkAsync("margins: the AI advice is context from the quote's own figures, a prompt that forbids invention, a reader that keeps a sane fraction, and a server action that refuses a missing context", async () => {
  const MA = await import("../src/lib/marginAdvice.js");
  const M = costingAll;
  const rates = defaultRates();
  const subKey = rateKey(M.SUBCONTRACT_CATEGORY_KEY, "Screw Piling", "quote");
  const piles = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles")); piles.labourAuto = false; piles.label = "Screw Piles";
  piles.qtys[subKey] = 1; piles.rateOverrides = { [subKey]: { unitCost: 2500 } }; piles.rowMargins = { [subKey]: 0.08 };
  const strip = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings")); strip.labourAuto = false; strip.label = "Strip Footings";
  strip.additional.push({ id: "s", name: "Own", unit: "item", qty: 1, rate: 3200 });
  const quote = { projectName: "19 Paringa Road, Portsea VIC 3944", clientName: "Builder X", status: "Estimating", scope: "both", planner: { deadline: "2026-11-07" }, overheadPct: 0.1, contingencyPct: 0, marginPct: 0.25, items: [strip, piles] };
  const past = MA.pastMarginsFrom({ a: { projectName: "Old Job", status: "Submitted", marginPct: 0.2, items: [] }, b: { projectName: "No margin typed", status: "Submitted", items: [] }, c: { projectName: "19 Paringa Road, Portsea VIC 3944", marginPct: 0.3 } }, quote.projectName);
  assert.deepEqual(past.map((p) => p.name), ["Old Job"], "only another project with a RECORDED margin says anything");
  const ctx = MA.marginContext(quote, quote.items, rates, { today: "2026-11-01", pastProjects: past });
  assert.equal(ctx.elements, 2); assert.equal(ctx.daysToDeadline, 6); assert.equal(ctx.currentMargin, 0.25); assert.equal(ctx.pinnedLines, 1);
  assert.ok(Math.abs(ctx.subcontractShare - 2500 / 5700) < 0.01, String(ctx.subcontractShare));
  assert.equal(ctx.subcontractLines[0].margin, 0.08); assert.equal(ctx.past[0].margin, 0.2);
  const prompt = MA.marginAdvicePrompt(ctx);
  assert.ok(/never invent a past project/.test(prompt) && /SELL price/.test(prompt) && /Old Job/.test(prompt) && /Screw Piling/.test(prompt) && /confidence_pct/.test(prompt), prompt.slice(0, 200));
  assert.deepEqual(MA.parseMarginAdvice('Sure: ```json\n{"high_confidence_pct": 22, "low_confidence_pct": 27, "reasons": ["38% of the cost is a subcontract quote at 8%", "small job"]}\n```'), { margin: 0.22, high: 0.22, low: 0.27, reasons: ["38% of the cost is a subcontract quote at 8%", "small job"] }, "two figures every time: high = firmly supported, low = the less certain higher one");
  assert.deepEqual(MA.parseMarginAdvice('{"high_confidence_pct": 27, "low_confidence_pct": 22}').high, 0.22, "swapped figures are put in order");
  assert.equal(MA.parseMarginAdvice('{"margin_pct": 0.18}').margin, 0.18, "a fraction reads as a fraction");
  assert.deepEqual([MA.parseMarginAdvice('{"margin_pct": 18}').high, MA.parseMarginAdvice('{"margin_pct": 18}').low], [0.18, 0.18], "a single-figure reply reads as both");
  assert.ok(/HIGH confidence/.test(prompt) && /LOW confidence/.test(prompt) && /high_confidence_pct/.test(prompt));
  assert.equal(MA.parseMarginAdvice('{"high_confidence_pct": 95}'), null, "an absurd rate is refused");
  assert.equal(MA.parseMarginAdvice("no json here"), null);
  // the browser request posts action "margin" with the context and the provider; a bad answer throws
  let posted = null;
  const ok = await MA.requestMarginAdvice(ctx, { provider: "openai", base: "https://portal.test", fetchImpl: async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ advice: { margin: 0.22, high: 0.22, low: 0.27, reasons: [] }, provider: "openai" }) }; } });
  assert.equal(posted.url, "https://portal.test/api/ai-engine"); assert.equal(posted.body.action, "margin"); assert.equal(posted.body.provider, "openai"); assert.equal(posted.body.context.elements, 2); assert.equal(ok.advice.margin, 0.22);
  await assert.rejects(() => MA.requestMarginAdvice(ctx, { base: "https://portal.test", fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "No AI provider is configured" }) }) }), /No AI provider/);
  // the server action: no context → 400; with no provider configured → 503 (never a made-up figure)
  const E = await import("../api/ai-engine.js");
  const r400 = await E.runAiJob({ action: "margin" }, {});
  assert.equal(r400.status, 400);
  const r503 = await E.runAiJob({ action: "margin", context: ctx }, {});
  assert.equal(r503.status, 503);
});

/* ---------- SMS to Grady from the checklist (2 Nov 2026) ---------- */
checkAsync("notify Grady: the text is built from the quote's own figures, segments are counted, the record is kept, the server fixes the recipient and refuses an unconfigured send; both providers are spoken to correctly on a mock", async () => {
  const NG = await import("../src/lib/notifyGrady.js");
  const S = await import("../api/_sms.js");
  const N = await import("../api/notify.js");
  const M = costingAll;
  const rates = defaultRates();
  const subKey = rateKey(M.SUBCONTRACT_CATEGORY_KEY, "Screw Piling", "quote");
  const piles = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles")); piles.labourAuto = false; piles.label = "Screw Piles";
  piles.qtys[subKey] = 1; piles.rateOverrides = { [subKey]: { unitCost: 2500 } }; piles.rowMargins = { [subKey]: 0.08 };
  const strip = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings")); strip.labourAuto = false; strip.label = "Strip Footings";
  strip.additional.push({ id: "s", name: "Own", unit: "item", qty: 1, rate: 3200 });
  const unpriced = newElementItem(ELEMENT_TYPES.find((t) => t.id === "capping_beam")); unpriced.labourAuto = false; unpriced.label = "Steel fix";
  unpriced.qtys[rateKey(M.SUBCONTRACT_CATEGORY_KEY, "Steel fix", "quote")] = 2; unpriced.additional.push({ id: "u", name: "Own", unit: "item", qty: 1, rate: 100 });
  const quote = { projectName: "19 Paringa Road, Portsea VIC 3944", clientName: "Builder X", planner: { deadline: "2026-11-07" }, overheadPct: 0, contingencyPct: 0, marginPct: 0.25, items: [strip, piles, unpriced] };
  const f = NG.notifyFacts(quote, quote.items, rates, { today: "2026-11-02" });
  assert.equal(f.elements, 3); assert.equal(f.subQuotes, 1); assert.equal(f.unpricedQuotes, 1, "a quote row with a qty and no amount is named as unpriced");
  assert.ok(Math.abs(f.sell - (3200 / 0.75 + 2500 / 0.92 + 100 / 0.75)) < 1e-6);
  const text = NG.smsSummary(quote, quote.items, rates, { today: "2026-11-02", portalUrl: "https://portal.test" });
  assert.ok(/^Hi Grady, costings are ready for 19 Paringa Road, Portsea VIC 3944 \(Builder X\)\./.test(text), text);
  assert.ok(/Sell \$7,117 ex GST at 18\.5% blended on \$5,800 direct\./.test(text), text); // 3200/0.75 + 2500/0.92 + 100/0.75
  assert.ok(/3 elements, 1 sub quote, 1 quote row UNPRICED\./.test(text) && /Tender due 2026-11-07 \(5d\)\.$/.test(text), text);
  assert.ok(!/https?:|portal/i.test(text), "the text carries no link (13 Nov 2026)");
  // Boma's own draft: no client, nothing pinned, no deadline
  assert.equal(NG.smsSummary({ projectName: "9 Fairfax Street, Blairgowrie VIC 3942", items: [] }, [], rates).replace(/Sell .*$/, ""), "Hi Grady, costings are ready for 9 Fairfax Street, Blairgowrie VIC 3942. ");
  assert.equal(NG.smsSegments("Hi Grady, costings are ready for 9 Fairfax Street, Blairgowrie VIC 3942. Sell $189,262 ex GST at 25% on $125,616 direct. 3 elements."), 1, "his text is one segment");
  // a link in a message to Grady is the LIVE site, never a deployment's own frozen address
  assert.equal(NG.portalLink("https://estimating-website-po3nd896b-gradcon.vercel.app"), "https://estimating-website.vercel.app");
  assert.equal(NG.portalLink("https://estimating-website.vercel.app"), "https://estimating-website.vercel.app");
  assert.equal(NG.portalLink("http://localhost:5173"), "http://localhost:5173"); assert.equal(NG.portalLink(""), "");
  assert.ok(text.length <= NG.SMS_MAX_CHARS, `${text.length} chars`);
  // the email: the same facts in full
  const em = NG.emailSummary(quote, quote.items, rates, { today: "2026-11-02", portalUrl: "https://portal.test", by: "projects" });
  assert.equal(em.subject, "Costings ready – 19 Paringa Road, Portsea VIC 3944 · tender due 2026-11-07 (5d)");
  assert.ok(/^Hi Grady,/.test(em.text) && /Client: Builder X/.test(em.text) && /Direct cost: \$5,800\.00/.test(em.text) && /Sell: \$7,117\.\d\d ex GST/.test(em.text), em.text);
  assert.ok(/- Strip Footings: \$4,266\.67 at 25%/.test(em.text) && /- Screw Piles: \$2,717\.39 at 8% \(incl\. Screw Piling \$2,500\.00 at 8%\)/.test(em.text), em.text);
  assert.ok(/SUBCONTRACT QUOTES\n- Screw Piling on Screw Piles: \$2,500\.00 at 8% → sells \$2,717\.39/.test(em.text), em.text);
  assert.ok(/QUOTE ROWS STILL UNPRICED \(1[^)]*\)\n- Steel fix on Steel fix/.test(em.text), em.text);
  assert.ok(/Margin: project 25% · blended 18\.5% \(1 line pinned at their own rate\)/.test(em.text) && /https:\/\/portal\.test/.test(em.text) && /by projects — step 08/.test(em.text), em.text);
  const emA = NG.emailSummary({ ...quote, assumptions: [{ id: "a", text: "Rock excluded", tenderText: "Rock excavation is excluded from our price." }, { id: "b", text: "" }] }, quote.items, rates, { today: "2026-11-02" });
  assert.ok(/ASSUMPTIONS\n- Rock excavation is excluded from our price\.\n/.test(emA.text), "the tender wording of an assumption prints when it has one; blanks are dropped");
  // the email goes through the projects@ connection to Grady's address only, as a plain send
  let mp = null;
  const er = await NG.requestEmail({ subject: em.subject, text: em.text }, { base: "https://portal.test", fetchImpl: async (url, init) => { mp = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ mailbox: "projects@gradcon.com.au", sent: { id: "M1", threadId: "T1", to: "grady@gradcon.com.au", subject: em.subject } }) }; } });
  assert.equal(mp.url, "https://portal.test/api/gmail"); assert.equal(mp.body.action, "send"); assert.equal(mp.body.to, NG.GRADY_EMAIL); assert.equal(mp.body.toName, "Grady"); assert.equal(mp.body.subject, em.subject); assert.ok(!("attachments" in mp.body) && !("cc" in mp.body));
  assert.deepEqual([er.id, er.threadId, er.to], ["M1", "T1", "grady@gradcon.com.au"]);
  await assert.rejects(() => NG.requestEmail({ subject: "x", text: "y" }, { base: "https://portal.test", fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "The Google connection cannot send yet" }) }) }), /cannot send yet/);
  const ms = await NG.mailSendStatus({ base: "https://portal.test", fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ configured: true, connected: true, send: false, email: "projects@gradcon.com.au" }) }) });
  assert.deepEqual([ms.configured, ms.connected, ms.send, ms.email], [true, true, false, "projects@gradcon.com.au"]);
  const emRec = NG.notifyRecord({ kind: "email", to: NG.GRADY_EMAIL, text: em.subject, by: "projects", provider: "gmail", messageId: "M1" });
  const both = { ...quote, ...NG.notifyPatch({ ...quote, ...NG.notifyPatch(quote, emRec) }, NG.notifyRecord({ kind: "sms", text: "t", messageId: "S1" })) };
  assert.equal(NG.lastNotification(both, "email").messageId, "M1"); assert.equal(NG.lastNotification(both, "sms").messageId, "S1");
  assert.equal(NG.smsSegments("a".repeat(160)), 1); assert.equal(NG.smsSegments("a".repeat(161)), 2); assert.equal(NG.smsSegments("—"), 1); assert.equal(NG.smsSegments("—" + "a".repeat(70)), 2, "a non-GSM character makes it 70 per segment");
  assert.equal(S.smsSegments("a".repeat(306)), 2); assert.equal(S.smsSegments("a".repeat(307)), 3);
  // the record on the quote
  const rec = NG.notifyRecord({ to: "+61 4•• ••• 678", text, by: "projects", provider: "clicksend", messageId: "m1", segments: 2, at: "2026-11-02T03:00:00.000Z" });
  const patched = { ...quote, ...NG.notifyPatch(quote, rec) };
  assert.equal(patched.notifications.length, 1); assert.equal(NG.lastNotification(patched).messageId, "m1"); assert.equal(NG.lastNotification(patched, "email"), null);
  // phone spellings → E.164, masked for pages
  assert.equal(S.normalizeMobile("0412 345 678"), "+61412345678"); assert.equal(S.normalizeMobile("+61 412-345-678"), "+61412345678"); assert.equal(S.normalizeMobile("61412345678"), "+61412345678");
  assert.equal(S.normalizeMobile("1234"), null); assert.equal(S.normalizeMobile("0312345678"), "+61312345678", "a landline still normalises (the provider decides)"); assert.equal(S.normalizeMobile("+447700900123"), "+447700900123");
  assert.equal(S.maskMobile("+61412345678"), "+614••• ••• 678");
  // status: nothing set → not configured, names what is missing, never a key
  const none = S.smsStatus({}); assert.equal(none.configured, false); assert.ok(none.missing.join(" ").includes("CLICKSEND_USERNAME") && none.missing.join(" ").includes("GRADY_MOBILE"));
  const cs = { SMS_PROVIDER: "clicksend", CLICKSEND_USERNAME: "u@x", CLICKSEND_API_KEY: "k", SMS_FROM: "Gradcon", GRADY_MOBILE: "0412 345 678" };
  const st = S.smsStatus(cs); assert.deepEqual([st.configured, st.provider, st.to, st.from], [true, "clicksend", "+614••• ••• 678", "Gradcon"]); assert.ok(!JSON.stringify(st).includes("\"k\""));
  assert.equal(S.smsProviderId({ SMS_PROVIDER: "twilio", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" }), null, "a named provider without its keys is not silently swapped");
  // the function: refusals, then a mocked ClickSend send
  assert.equal((await N.runNotify({ action: "sms", text: "hi" }, {})).status, 503);
  assert.equal((await N.runNotify({ action: "sms", text: "" }, cs)).status, 400);
  assert.equal((await N.runNotify({ action: "sms", text: "x".repeat(481) }, cs)).status, 400);
  assert.equal((await N.runNotify({ action: "nope" }, cs)).status, 400);
  { // "sms-copy": the copy numbers ONLY — Grady is never texted on this path (Boma, 16 Nov 2026: "fire one sms to me now")
    const twc = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+61468000120", GRADY_MOBILE: "0412 000 555", SMS_COPY_TO: "0416 000 176" };
    const tos = [];
    const okCopy = await N.runNotify({ action: "sms-copy", text: "Test.", to: "+61499999999" }, twc, async (url, init) => { tos.push(new URLSearchParams(init.body).get("To")); return { ok: true, status: 201, json: async () => ({ sid: "SMc", status: "queued" }) }; });
    assert.equal(okCopy.status, 200); assert.deepEqual(tos, ["+61416000176"], "one text, to the copy number — not Grady, not a number in the body");
    assert.deepEqual(okCopy.body, { ok: true, copies: [{ to: "+614••• ••• 176", ok: true, id: "SMc" }] });
    assert.equal((await N.runNotify({ action: "sms-copy", text: "Test." }, { ...twc, SMS_COPY_TO: "" }, async () => { throw new Error("must not send"); })).status, 400);
    assert.equal((await N.runNotify({ action: "sms-copy", text: "" }, twc)).status, 400); assert.equal((await N.runNotify({ action: "sms-copy", text: "x" }, {})).status, 503);
    const refused = await N.runNotify({ action: "sms-copy", text: "Test." }, twc, async () => ({ ok: false, status: 400, json: async () => ({ code: 21608, message: "The number is unverified." }) }));
    assert.equal(refused.status, 502); assert.ok(refused.body.ok === false && /21608/.test(refused.body.copies[0].error) && /unverified/.test(refused.body.copies[0].error), "a refused copy carries Twilio's own words");
  }
  assert.deepEqual((await N.runNotify({ action: "status" }, cs)).body.sms.to, "+614••• ••• 678");
  let posted = null;
  const okCs = await N.runNotify({ action: "sms", text: "Costings ready.", to: "+61499999999" }, cs, async (url, init) => { posted = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ data: { messages: [{ status: "SUCCESS", message_id: "CS1", message_price: 0.0794 }] } }) }; });
  assert.equal(okCs.status, 200); assert.equal(okCs.body.id, "CS1"); assert.equal(okCs.body.to, "+614••• ••• 678");
  assert.equal(posted.url, "https://rest.clicksend.com/v3/sms/send"); assert.equal(posted.body.messages[0].to, "+61412345678", "the recipient is the server's GRADY_MOBILE — a number in the body is ignored"); assert.equal(posted.body.messages[0].from, "Gradcon"); assert.ok(/^Basic /.test(posted.init.headers.Authorization));
  const badCs = await N.runNotify({ action: "sms", text: "x" }, cs, async () => ({ ok: true, status: 200, json: async () => ({ data: { messages: [{ status: "INVALID_RECIPIENT" }] } }) }));
  assert.equal(badCs.status, 200 === badCs.status ? 0 : badCs.status); assert.ok(badCs.status >= 400 && /INVALID_RECIPIENT/.test(badCs.body.error), JSON.stringify(badCs));
  // Twilio: form-encoded, From or a messaging service
  const tw = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "ACabc", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+61400000000", GRADY_MOBILE: "+61412345678" };
  let tposted = null;
  const okTw = await N.runNotify({ action: "sms", text: "Costings ready." }, tw, async (url, init) => { tposted = { url, params: new URLSearchParams(init.body) }; return { ok: true, status: 201, json: async () => ({ sid: "SM1", num_segments: "1" }) }; });
  assert.equal(okTw.body.id, "SM1"); assert.equal(okTw.body.provider, "twilio"); assert.ok(tposted.url.endsWith("/Accounts/ACabc/Messages.json"));
  assert.equal(tposted.params.get("To"), "+61412345678"); assert.equal(tposted.params.get("From"), "+61400000000"); assert.equal(tposted.params.get("Body"), "Costings ready.");
  const okMg = await N.runNotify({ action: "sms", text: "x" }, { ...tw, TWILIO_FROM: "MG" + "a".repeat(32) }, async (url, init) => { tposted = new URLSearchParams(init.body); return { ok: true, status: 201, json: async () => ({ sid: "SM2" }) }; });
  assert.equal(okMg.status, 200); assert.equal(tposted.get("MessagingServiceSid"), "MG" + "a".repeat(32)); assert.equal(tposted.get("From"), null);
  // 13 Nov 2026: TWILIO_FROM typed in the local spelling ("0400 000 000") is sent as E.164 — Twilio refuses anything else
  assert.deepEqual(S.twilioSender("0400 000 000"), { field: "From", value: "+61400000000", kind: "number" });
  assert.deepEqual(S.twilioSender("61400000000"), { field: "From", value: "+61400000000", kind: "number" });
  assert.equal(S.twilioSender("+15005550006").value, "+15005550006"); assert.equal(S.twilioSender("Gradcon").kind, "alpha"); assert.equal(S.twilioSender("Gradcon").value, "Gradcon");
  assert.equal(S.twilioSender("12345").kind, "unreadable"); assert.equal(S.twilioSender(""), null);
  const okLocal = await N.runNotify({ action: "sms", text: "x" }, { ...tw, TWILIO_FROM: "0400 000 000" }, async (url, init) => { tposted = new URLSearchParams(init.body); return { ok: true, status: 201, json: async () => ({ sid: "SM3" }) }; });
  assert.equal(okLocal.status, 200); assert.equal(tposted.get("From"), "+61400000000", "the local spelling goes to Twilio as E.164");
  const stTw = S.smsStatus({ ...tw, TWILIO_FROM: "0400 000 000" });
  assert.equal(stTw.configured, true); assert.equal(stTw.from, "+614••• ••• 000", "the sender is shown masked, never whole"); assert.equal(stTw.warning, null);
  assert.match(S.smsStatus({ ...tw, TWILIO_FROM: "12345" }).warning, /TWILIO_FROM is not a phone number/);
  // a NAME as the sender (Boma, 17 Nov 2026: "Gradcon Estimates instead of the number"): Twilio's limit is 11 characters, letters / digits / spaces
  assert.match(S.smsStatus({ ...tw, TWILIO_FROM: "Gradcon Estimates" }).warning, /17 characters — a sender name may be at most 11/);
  assert.equal(S.smsStatus({ ...tw, TWILIO_FROM: "Gradcon" }).warning, null); assert.equal(S.smsStatus({ ...tw, TWILIO_FROM: "Gradcon Est" }).warning, null); assert.equal(S.smsStatus({ ...tw, TWILIO_FROM: "Gradcon" }).from, "Gradcon");
  assert.match(S.smsStatus({ ...tw, TWILIO_FROM: "Gradcon-Est" }).warning, /letters, digits and spaces only/);
  assert.equal(S.twilioSenderWarning("+61468004120"), null); assert.equal(S.twilioSenderWarning("MG" + "a".repeat(32)), null); assert.equal(S.ALPHA_SENDER_MAX, 11);
  assert.equal(S.smsStatus({ ...tw, TWILIO_FROM: "MG" + "a".repeat(32) }).from, "MGaaaa…");
  // a Twilio refusal carries the code, Twilio's own words and, for a code read off its error page, what to do (13 Nov 2026: 572002)
  const trial = await N.runNotify({ action: "sms", text: "x" }, tw, async () => ({ ok: false, status: 400, json: async () => ({ code: 572002, message: "The 'From' number isn't assigned to this verified Messaging recipient", status: 400 }) }));
  assert.equal(trial.status, 400);
  assert.match(trial.body.error, /^Twilio did not accept the text \(572002\)\. Twilio says: The 'From' number isn't assigned to this verified Messaging recipient\. This Twilio account is on a trial/);
  assert.match(trial.body.error, /TWILIO_FROM/); assert.match(trial.body.error, /upgrade the Twilio account/);
  const other = await N.runNotify({ action: "sms", text: "x" }, tw, async () => ({ ok: false, status: 400, json: async () => ({ code: 99999, message: "Something else" }) }));
  assert.equal(other.body.error, "Twilio did not accept the text (99999). Twilio says: Something else.", "an unknown code shows Twilio's words and no invented advice");
  assert.equal(S.twilioRefusal(null), "Twilio did not accept the text.");
  // 16 Nov 2026 — a COPY of every text to SMS_COPY_TO; the two readers of a new-project text get their own words
  const cenv = { ...tw, SMS_COPY_TO: "0400 111 222; 0412345678, +61400111222, 12" };
  assert.deepEqual(S.smsCopyNumbers(cenv).numbers, ["+61400111222"], "Grady's own number and a repeat are dropped");
  assert.equal(S.smsCopyNumbers(cenv).unreadable.length, 1);
  assert.deepEqual(S.smsStatus(cenv).copyTo, ["+614••• ••• 222"]); assert.match(S.smsStatus(cenv).copyWarning, /cannot read/);
  assert.deepEqual(S.smsStatus(tw).copyTo, []); assert.equal(S.smsStatus(tw).copyWarning, null);
  const sentTo = [];
  const withCopy = await N.runNotify({ action: "sms", text: "Hi Grady, costings are ready." }, cenv, async (url, init) => { const f = new URLSearchParams(init.body); sentTo.push(f.get("To") + "|" + f.get("Body")); return { ok: true, status: 201, json: async () => ({ sid: "SM" + sentTo.length }) }; });
  assert.equal(withCopy.status, 200); assert.deepEqual(sentTo, ["+61412345678|Hi Grady, costings are ready.", "+61400111222|Hi Grady, costings are ready."], "Grady first, then the copy, the same words");
  assert.deepEqual(withCopy.body.copies, [{ to: "+614••• ••• 222", ok: true, id: "SM2" }]); assert.equal(withCopy.body.to, "+614••• ••• 678");
  let nth = 0;
  const copyFails = await N.runNotify({ action: "sms", text: "x" }, cenv, async () => { nth += 1; return nth === 1 ? { ok: true, status: 201, json: async () => ({ sid: "SM1" }) } : { ok: false, status: 400, json: async () => ({ code: 21608, message: "unverified" }) }; });
  assert.equal(copyFails.status, 200, "a refused COPY never fails the text Grady got"); assert.equal(copyFails.body.copies[0].ok, false); assert.match(copyFails.body.copies[0].error, /21608/);
  let tries = 0;
  const mainFails = await N.runNotify({ action: "sms", text: "x" }, cenv, async () => { tries += 1; return { ok: false, status: 400, json: async () => ({ code: 572002, message: "no" }) }; });
  assert.equal(mainFails.status, 400); assert.equal(tries, 1, "when Grady's text is refused no copy is attempted");
  const byRole = [];
  const roleOut = await S.sendSmsByRole([{ role: "grady", text: "to grady" }, { role: "copy", text: "to the estimator" }, { role: "nobody", text: "x" }], cenv, async (url, init) => { const f = new URLSearchParams(init.body); byRole.push(f.get("To") + "|" + f.get("Body")); return { ok: true, status: 201, json: async () => ({ sid: "S" }) }; });
  assert.deepEqual(byRole, ["+61412345678|to grady", "+61400111222|to the estimator"]); assert.equal(roleOut.length, 2);
  const NP = await import("../src/lib/newProjectSms.js");
  const np = { projectId: "p1", name: "9 Fairfax Street, Blairgowrie VIC 3942 — Residence", client: "Acme Builders", from: "Jo <jo@acme.com.au>", deadline: "2026-11-27", deadlineSource: "email", attachments: 3, via: null };
  assert.equal(NP.smsDay("2026-11-27"), "Fri 27 Nov"); assert.equal(NP.smsDay("nope"), "");
  assert.equal(NP.newProjectSmsForEstimator(np), "New tender in the portal: 9 Fairfax Street, Blairgowrie VIC 3942 - Residence from Acme Builders. Closes Fri 27 Nov. 3 files attached. Please check it. Grady has been asked if we want to price it.");
  assert.equal(NP.newProjectSmsForGrady(np), "Hi Grady, new tender request: 9 Fairfax Street, Blairgowrie VIC 3942 - Residence from Acme Builders. Closes Fri 27 Nov. Please let Boma know if it is something we want to price or not.");
  const npDef = { ...np, deadlineSource: "default", attachments: 0 };
  assert.match(NP.newProjectSmsForEstimator(npDef), /No closing date in the email - set to Fri 27 Nov \(2 weeks\)\. No files attached\./);
  assert.match(NP.newProjectSmsForGrady(npDef), /No closing date given - pencilled for Fri 27 Nov\./);
  const npFwd = { ...np, via: "grady@example.com.au" };
  assert.match(NP.newProjectSmsForGrady(npFwd), /^Hi Grady, the request you forwarded for 9 Fairfax Street.* is now a project in the portal\. Closes Fri 27 Nov\. Boma will pick it up\.$/);
  assert.ok(!/want to price/.test(NP.newProjectSmsForGrady(npFwd)), "a request Grady forwarded himself is confirmed, not asked about");
  assert.match(NP.newProjectSmsForEstimator(npFwd), /\(forwarded by Grady\)\..*Grady has been told it is in\.$/);
  [np, npDef, npFwd].forEach((i) => [NP.newProjectSmsForEstimator(i), NP.newProjectSmsForGrady(i)].forEach((t) => { assert.ok(/^[\x20-\x7E]*$/.test(t), `plain SMS characters only: ${t}`); assert.ok(t.length <= 320 && S.smsSegments(t) <= 2, `${t.length} chars`); }));
  assert.equal(NP.newProjectTexts([np]).length, 2); assert.equal(NP.newProjectTexts([np, npDef, npFwd]).length, 6);
  const many = NP.newProjectTexts([np, npDef, npFwd, { ...np, projectId: "p4", name: "4 Fourth St" }]);
  assert.equal(many.length, 2, "more than three projects in one scan: ONE summary text each"); assert.match(many[0].text, /^4 new tenders in the portal: /); assert.match(many[1].text, /^Hi Grady, 4 new tender requests: .*Please let Boma know which of these we want to price\.$/);
  assert.deepEqual(NP.newProjectTexts([]), []); assert.ok(!/undefined|null/.test(NP.newProjectSmsForEstimator({ name: "X" }) + NP.newProjectSmsForGrady({ name: "X" })), "a fact the entry lacks is left out");
  { // the scan's schedule (Boma, 16 Nov 2026: "at least twice during work hours melbourne time"; 18 Nov 2026: "i want the mailbox scanned for new emails always"): every entry a ONCE-A-DAY schedule on the scan's path (the only kind every Vercel plan accepts; 100 a project), four an hour, covering 8 am-5 pm Melbourne in daylight time (UTC+11) AND in winter (UTC+10)
    const crons = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons.filter((c) => c.path === "/api/tender-inbox");
    assert.ok(crons.length >= 40 && crons.length <= 100 && crons.every((c) => /^(?:0|15|30|45) \d{1,2} \* \* \*$/.test(c.schedule)), "each scan entry is a once-a-day schedule on a quarter hour, and the project stays inside Vercel's 100");
    assert.equal(new Set(crons.map((c) => c.schedule)).size, crons.length, "no schedule twice");
    const slots = crons.map((c) => { const [m, h] = c.schedule.split(" ").map(Number); return h * 60 + m; });
    [11, 10].forEach((off) => { for (let t = 8 * 60; t < 17 * 60; t += 15) assert.ok(slots.includes((t - off * 60 + 1440) % 1440), `UTC+${off}: a scan at ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")} Melbourne`); });
    const local = slots.map((t) => ((t + 11 * 60) % 1440) / 60); assert.ok(Math.min(...local) === 7 && Math.max(...local) === 20.75, `daylight time: the scans run 7 am to 9 pm (${Math.min(...local)}–${Math.max(...local)})`);
    const shellSrc = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
    assert.ok(/data-testid="inbox-scan-times">Every 15 min · 7 am – 9 pm · and every 3 min while signed in/.test(shellSrc) && /every 15 minutes from 7 am to 9 pm Melbourne/.test(shellSrc) && !/four times a day|4 scans a day/.test(shellSrc), "Settings states the scan times");
    // the portal's own check: one small POST {auto:true}, never while hidden, on a dead host or on a copy that is not the live site, from one tab at a time
    assert.ok(/function inboxAutoScan\(force\)\{\s*if\(!currentUser \|\| document\.hidden \|\| inboxAutoBusy \|\| window\.gradconHostingOff \|\| window\.gradconNotLive\)/.test(shellSrc) && /action:'scan', auto:true, by:'portal'/.test(shellSrc) && /INBOX_AUTO_MS = 3 \* 60 \* 1000/.test(shellSrc) && /localStorage\.setItem\(INBOX_AUTO_KEY/.test(shellSrc), "the shell asks for a scan every three minutes while someone is signed in");
  }
  assert.equal(NP.newProjectSmsOn({}), false); assert.equal(NP.newProjectSmsOn({ NEW_PROJECT_SMS: "off" }), false); assert.equal(NP.newProjectSmsOn({ NEW_PROJECT_SMS: " On " }), true);
  // the browser side posts only the text and reads the reply; an error throws with the server's words
  let b = null;
  const r = await NG.requestSms("Costings ready.", { base: "https://portal.test", fetchImpl: async (url, init) => { b = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, provider: "clicksend", id: "CS1", to: "+614••• ••• 678", segments: 1 }) }; } });
  assert.equal(b.url, "https://portal.test/api/notify"); assert.deepEqual(Object.keys(b.body).sort(), ["action", "text"]); assert.equal(r.id, "CS1");
  await assert.rejects(() => NG.requestSms("x", { base: "https://portal.test", fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "SMS is not configured — set GRADY_MOBILE" }) }) }), /not configured/);
  const stt = await NG.notifyStatus({ base: "https://portal.test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ sms: { configured: true, provider: "clicksend", to: "+614••• ••• 678" } }) }) });
  assert.equal(stt.provider, "clicksend");
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

check("a custom row added UNDER a category costs into that category (and materials), not into Other Allowances", () => {
  const type = ELEMENT_TYPES[0];
  const rates = defaultRates();
  const item = newElementItem(type);
  item.additional.push({ id: "c1", name: "Certification", unit: "item", qty: 1, rate: 450, cat: "FORMWORK" });
  item.additional.push({ id: "c2", name: "Difficult access allowance", unit: "item", qty: 2, rate: 100 });
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["FORMWORK"], 450, "Formwork band carries the custom row");
  assert.equal(cost.materialsTotal, 450, "…and so does materialsTotal");
  assert.equal(cost.additionalTotal, 200, "the uncategorised row stays in Other Allowances");
  assert.equal(cost.total, 650, "never counted twice");
  assert.equal(additionalRowsFor(item, "FORMWORK").length, 1);
  assert.equal(additionalRowsFor(item, null).length, 1);
  // a blank custom row costs nothing, like every other blank row
  item.additional.push({ id: "c3", name: "", unit: "", qty: undefined, rate: undefined, cat: "CONCRETE" });
  assert.equal(computeElementCost(item, rates).total, 650);
});

/* ---------- rate overrides / fallback ---------- */
check("A rates override changes cost; a MISSING key falls back to catalog default rather than $0", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  const key = rateKey("CONCRETE", "32 mpa", "m3");
  item.qtys[key] = 10;
  item.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0; // typed 0 disables the auto charge — this check pins override/fallback maths
  item.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  item.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;

  const before = computeElementCost(item, rates).materialsTotal;
  assert.equal(before, 10 * C32);

  rates[key] = { unitCost: 300, unitWeight: null };
  const after = computeElementCost(item, rates).materialsTotal;
  assert.equal(after, 3000);

  delete rates[key]; // simulate an old saved rates blob missing this key
  const fallback = computeElementCost(item, rates).materialsTotal;
  assert.equal(fallback, 10 * C32); // falls back to catalog default, not 0
});

/* ---------- multi-element grand total ---------- */
check("Grand total sums every element's total across the whole quote", () => {
  const rates = defaultRates();
  const a = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  a.labourAuto = false; // this check pins the MATERIALS maths; auto labour has its own checks
  a.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10;
  a.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0; // typed 0 disables the auto charge
  a.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  a.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  const b = newElementItem(ELEMENT_TYPES.find((t) => t.id === "capping_beam"));
  b.labourAuto = false;
  b.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 5; // $1107.50
  b.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  b.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  b.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  const total = computeGrandTotal([a, b], rates);
  assert.equal(total, 10 * C25 + 5 * C32);
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

/* ---------- Estimates -> Quotes import bridge (lib/estimateImport.js) ---------- */
const estLine = (over) => ({
  stage: "Foundations", category: "Bored Pier", element: "Bored Pier 1", elementId: "EL01",
  materialGroup: "Concrete", material: "", spec: "", qty: 0, unit: "m³", waste: 0, lap: 0,
  finalQty: 0, formula: "", linkedElement: "", notes: "", ...over,
});

check("Import: unambiguous grade + bar diameter prefill cleanly with no flags", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: { name: "Test Job" },
    lines: [
      estLine({ materialGroup: "Concrete", material: "N20 concrete", unit: "m³", finalQty: 12.5 }),
      estLine({ materialGroup: "Reinforcement", material: "N16", unit: "m", finalQty: 340 }),
    ],
  });
  assert.equal(quote.items.length, 1);
  const item = quote.items[0];
  assert.equal(item.typeId, "piles_bored");
  assert.equal(item.qtys[rateKey("CONCRETE", "20 mpa", "m3")], 12.5);
  assert.equal(item.qtys[rateKey("PROCESSED BAR", "N16", "m")], 340);
  assert.equal(flags.length, 0, `expected no flags, got: ${flags.join(" | ")}`);
});

check("Import: element type with no Quotes equivalent produces a flag and no item", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: { name: "Test Job" },
    lines: [
      { ...estLine({}), category: "Water Tank (in-ground)", element: "Water Tank 1", elementId: "EL02", finalQty: 8 },
    ],
  });
  assert.equal(quote.items.length, 0);
  assert.ok(flags.some((f) => f.includes("Water Tank")), `expected a Water Tank flag, got: ${flags.join(" | ")}`);
});

check("Import: Concrete Stair maps to the staircase element type (used to be unmapped/flagged)", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: { name: "Test Job" },
    lines: [
      { ...estLine({}), category: "Concrete Stair", element: "Stair 1", elementId: "EL06",
        materialGroup: "Concrete", material: "N25 concrete", spec: "Stair (steps+waist+landing)", unit: "m³", finalQty: 4.2 },
    ],
  });
  assert.equal(quote.items.length, 1);
  const item = quote.items[0];
  assert.equal(item.typeId, "staircase");
  assert.equal(item.qtys[rateKey("CONCRETE", "25 mpa", "m3")], 4.2);
});

check("Import: Column Base Plate / Grout Pad maps to the new column_base_plate element type", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: { name: "Test Job" },
    lines: [
      { ...estLine({}), category: "Column Base Plate / Grout Pad", element: "Base Plate C1", elementId: "EL07",
        materialGroup: "Concrete", material: "N40 concrete", unit: "m³", finalQty: 0.3 },
    ],
  });
  assert.equal(quote.items.length, 1);
  const item = quote.items[0];
  assert.equal(item.typeId, "column_base_plate");
  assert.equal(item.qtys[rateKey("CONCRETE", "40 mpa", "m3")], 0.3);
});

check("Import: ambiguous concrete grade (multiple products) still prefills the plain mix and flags it", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [estLine({ material: "N32 concrete", finalQty: 6 })],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("CONCRETE", "32 mpa", "m3")], 6); // plain mix preferred over Agilia/walls variants
  assert.ok(flags.some((f) => f.includes("N32") && f.includes("verify")), `expected an ambiguity flag, got: ${flags.join(" | ")}`);
});

check("Import: mesh reinforcement (m²) maps straight to Square Mesh m² qty; trench mesh with the same SL/RL code is flagged instead", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL04",
        materialGroup: "Reinforcement", material: "SL82", spec: "Mesh ×1 layer(s)", unit: "m²", finalQty: 55.5 },
      { ...estLine({}), category: "Strip Footing", element: "Footing 1", elementId: "EL05",
        materialGroup: "Reinforcement", material: "SL62", spec: "Trench mesh", unit: "m²", finalQty: 12 },
    ],
  });
  const slab = quote.items.find((i) => i.typeId === "slab_on_ground");
  assert.equal(slab.qtys[rateKey("SQUARE MESH", "SL82", "m2")], 55.5); // raw m², NOT converted to a sheet count here
  const footing = quote.items.find((i) => i.typeId === "strip_footings");
  assert.equal(footing.qtys[rateKey("SQUARE MESH", "SL62", "m2")], undefined); // must NOT be silently mapped
  assert.ok(flags.some((f) => f.includes("Trench Mesh") && f.includes("SL62")), `expected a trench-mesh flag, got: ${flags.join(" | ")}`);
});

check("Import: wall formwork area maps to Walls; other m² formwork maps to Conventional and is still flagged for review", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Concrete Wall / Core", element: "Wall 1", elementId: "EL03",
        materialGroup: "Formwork", material: "Wall formwork", spec: "Selected faces", unit: "m²", finalQty: 45 },
      { ...estLine({}), category: "Concrete Wall / Core", element: "Wall 1", elementId: "EL03",
        materialGroup: "Formwork", material: "Opening reveals", spec: "", unit: "m²", finalQty: 3 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("FORMWORK", "Walls", "m2")], 45);
  assert.equal(item.qtys[rateKey("FORMWORK", "Conventional", "m2")], 3); // non-wall formwork now crosses over too, not just flagged
  assert.ok(flags.some((f) => f.includes("Opening reveals")), `expected the non-wall formwork to still be flagged for review, got: ${flags.join(" | ")}`);
});

await checkAsync("Project bundle (lib/projectBundle.js, projectBundleBuild.js): the store zip round-trips with CRCs, the mail search names every spelling of the project, the manual carries every section, the builder on fake deps packs the quote, the takeoff, the emails, a drawing and the issues; App keeps a version before an element is removed and the autosave timer ignores the save status", async () => {
  const B = await import("../src/lib/projectBundle.js");
  const BB = await import("../src/lib/projectBundleBuild.js");
  // the zip
  const bytes = B.zipStore([{ name: "a/b.txt", data: "hello" }, { name: "c.bin", data: new Uint8Array([1, 2, 3, 250]) }, { name: "ü/ñ.json", data: { x: 1 } }], new Date("2026-11-05T10:00:00"));
  const back = B.unzipStore(bytes);
  assert.deepEqual(Object.keys(back).sort(), ["a/b.txt", "c.bin", "ü/ñ.json"]);
  assert.equal(new TextDecoder().decode(back["a/b.txt"]), "hello"); assert.deepEqual([...back["c.bin"]], [1, 2, 3, 250]); assert.equal(new TextDecoder().decode(back["ü/ñ.json"]), '{"x":1}');
  assert.equal(B.crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the CRC-32 check value");
  // the mail search
  const mq = B.mailQuery({ projectName: "14-16 Marine Parade, Shoreham VIC 3916 — Tennis Pavilion", nameSource: "14-16 Marine Pde, Shoreham", siteAddress: "14-16 Marine Parade, Shoreham VIC 3916" });
  assert.ok(mq.includes('"14-16 Marine Parade, Shoreham VIC 3916"') && mq.includes('"14-16 Marine Pde, Shoreham"') && mq.includes('"14-16 Marine Parade"') && !/Tennis/.test(mq) && mq.startsWith("(") && / OR /.test(mq), mq);
  assert.equal(B.mailQuery({}), "", "no name, no search");
  assert.equal(B.safeName("RFQ – Piling / 14-16 Marine Pde: \"draft\"?"), "RFQ - Piling 14-16 Marine Pde draft");
  assert.ok(/^7 Example Street Rye VIC 3941 - project bundle \d{4}-\d{2}-\d{2}$/.test(B.bundleName({ projectName: "7 Example Street, Rye VIC 3941" })), B.bundleName({ projectName: "7 Example Street, Rye VIC 3941" }));
  // a quote with two elements, one a subcontract quote, a tender, assumptions, a checklist tick, an RFQ and a drawing
  const t1 = ELEMENT_TYPES.find((t) => t.id === "strip_footings"), t2 = ELEMENT_TYPES.find((t) => t.id === "screw_piles");
  const a = newElementItem(t1), b = newElementItem(t2);
  a.label = "Strip Footings"; a.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10; a.measureLm = 40; a.markups = [{ id: "m1", name: "S01.pdf", type: "application/pdf", path: "quote-markups/p1/m1.pdf" }];
  b.label = "Screw Piles"; const subCat = FULL_CATALOG.find((c) => /^SUB CONTRACTORS/.test(c.key)); const subP = subCat.products.map((p) => (Array.isArray(p) ? { name: p[0], unit: p[1] } : p)).find((p) => p.unit === "quote"); const sk = rateKey(subCat.key, subP.name, subP.unit); b.qtys[sk] = 1; b.rateOverrides = { [sk]: { unitCost: 2500 } }; b.provisional = true;
  const quote = { projectName: "7 Example Street, Rye VIC 3941", clientName: "Example Builders", status: "Completed Estimating", overheadPct: 0.08, contingencyPct: 0.05, marginPct: 0.25, items: [a, b], assumptions: [{ id: "a1", text: "Spoil carted by others" }], checklist: { receive: { done: true, at: "2026-11-01", by: "projects" } }, rfqs: [{ id: "r1", at: "2026-11-02T01:00:00Z", by: "projects", package: "Screw Piling", due: "2026-11-09", attachments: ["S01.pdf"], recipients: [{ orgName: "BCS Piling", contactName: "Ben", email: "ben@bcs.example", status: "sent" }] }], packages: [] };
  const sq = (await import("../src/lib/tenderQuoteDefaults.js"));
  quote.tenderQuote = { ...sq.newTenderQuote(), items: sq.seedTenderItems(quote, quote.items, defaultRates()) };
  const html = B.manualHtml({ quote, items: quote.items, rates: defaultRates(), takeoff: { name: "7 Example Street", instances: [{ id: "i1", label: "Strip Footings", typeKey: "stripfooting", data: { length: 40, width: 600, depth: 500 }, results: { lines: [{ materialGroup: "Concrete", material: "N25 concrete", spec: "40 × 0.6 × 0.5", qty: 12, unit: "m³", finalQty: 12.6 }] } }] }, emails: [{ id: "e1", threadId: "t1", from: "ben@bcs.example", to: "projects@gradcon.com.au", subject: "RE: RFQ – Screw Piling – 7 Example Street", date: "2026-11-03T02:00:00Z", text: "Hi, quote attached. $2,500 + GST.", attachments: [{ filename: "quote.pdf", size: 20480 }] }], versions: [{ savedAt: "2026-11-05T00:00:00Z", source: "autosave", size: 1000 }], bundle: { at: "2026-11-05T10:00:00Z", by: "projects@gradcon.com.au", files: [{ name: "quote/quote.json", what: "the quote" }], issues: ["Drawing \"S01.pdf\" could not be fetched (HTTP 404)."] } });
  for (const id of ["summary", "packages", "elements", "margins", "tender", "assumptions", "checklist", "rfq", "estimates", "files", "contents"]) assert.ok(html.includes(`id="${id}"`), `section ${id}`);
  assert.ok(/Strip Footings/.test(html) && /Screw Piles/.test(html) && /Provisional sum/.test(html) && /Spoil carted by others/.test(html) && /BCS Piling/.test(html) && /RE: RFQ – Screw Piling/.test(html) && /quote attached/.test(html) && /N25 concrete/.test(html) && /01 Receive tender/.test(html) && /could not be fetched/.test(html) && /Project sum:/.test(html), "the manual names the elements, the PS, the assumption, the RFQ, the email, the takeoff line, the checklist, the issue and the tender sum");
  assert.ok(!/<script/i.test(html), "no script in the manual");
  assert.ok(/&lt;/.test(B.esc("<b>")) && B.emailText({ from: "x", subject: "s", text: "body", attachments: [{ filename: "a.pdf" }] }).includes("Attachments:\n  - a.pdf"));
  assert.equal(B.emailFileName({ date: "2026-11-03T02:00:00Z", subject: "RE: RFQ – Screw Piling / 7 Example" }, 0), "2026-11-03 01 RE RFQ - Screw Piling 7 Example.txt");
  assert.ok(B.takeoffCsv([{ label: "SF", typeKey: "strip", results: [{ materialGroup: "Concrete", material: "N25", qty: 1, unit: "m³", finalQty: 1.05 }] }]).split("\r\n")[1].startsWith("SF,strip,Concrete,N25,,1,m³,1.05"), "a v1 results array reads too");
  // the builder on fake deps
  const calls = [];
  const deps = {
    by: "projects@gradcon.com.au",
    fetch: async (url) => { calls.push(url); if (/m1\.pdf$/.test(url)) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }; return { ok: false, status: 404 }; },
    gmail: async (body) => { calls.push(`gmail:${body.action}`); if (body.action === "list") { assert.ok(/7 Example Street/.test(body.q)); return { messages: [{ id: "e1", threadId: "t1", from: "ben@bcs.example", to: "projects@", subject: "RE: RFQ", date: "2026-11-03T02:00:00Z", snippet: "quote attached" }] }; } return { message: { id: body.id, text: "Hi, quote attached. $2,500 + GST.", attachments: [] } }; },
    markupSrc: (m) => `https://files.example/${m.path}`,
    listVersions: async () => [{ savedAt: "2026-11-05T00:00:00Z", source: "autosave", size: 1000 }],
    readTakeoff: async (name) => (/7 Example/.test(name) ? { name: "7 Example Street", key: "k1", instances: [{ id: "i1", label: "Strip Footings", typeKey: "stripfooting", data: { length: 40 }, results: { lines: [{ materialGroup: "Concrete", material: "N25 concrete", qty: 12, unit: "m³", finalQty: 12.6 }] } }] } : null),
    now: () => new Date("2026-11-05T10:00:00"),
  };
  const progress = [];
  const r = await BB.buildProjectBundle({ quote: { ...quote, files: [{ id: "f1", provider: "mail", name: "tender.pdf", url: "https://files.example/quote-files/p1/tender.pdf" }] }, items: quote.items, rates: defaultRates(), project: { id: "p1" }, elementTypes: ELEMENT_TYPES }, deps, (t) => progress.push(t));
  const z = B.unzipStore(r.bytes); const names = Object.keys(z).map((n) => n.replace(/^[^/]+\//, ""));
  assert.ok(r.name.endsWith(" - project bundle 2026-11-05.zip"), r.name);
  for (const n of ["README.html", "quote/quote.json", "quote/quote.xls", "quote/quote.csv", "estimates/takeoff.json", "estimates/register.csv", "emails/2026-11-03 01 RE RFQ.txt", "drawings/Strip Footings/S01.pdf", "versions.json"]) assert.ok(names.includes(n), `${n} in ${names.join(", ")}`);
  const qdoc = JSON.parse(new TextDecoder().decode(z[Object.keys(z).find((n) => n.endsWith("quote/quote.json"))]));
  assert.equal(qdoc.source, "bundle"); assert.equal(qdoc.savedBy, "projects@gradcon.com.au"); assert.equal(qdoc.quote.items.length, 2, "the quote document is restorable");
  assert.equal(r.report.counts.emails, 1); assert.equal(r.report.counts.takeoff, 1);
  assert.ok(r.report.issues.some((s) => /tender\.pdf.*404/.test(s)), "the 404 file is named as not included: " + r.report.issues.join(" | "));
  assert.ok(!names.some((n) => /files\/tender\.pdf/.test(n)), "and is not in the zip");
  const readme = new TextDecoder().decode(z[Object.keys(z).find((n) => n.endsWith("README.html"))]);
  assert.ok(/quote attached/.test(readme) && /Not included/.test(readme) && /emails\/2026-11-03 01 RE RFQ\.txt/.test(readme), "the manual lists the email file and the issue");
  assert.ok(progress.some((t) => /Searching projects@/.test(t)) && progress.some((t) => /Packing the zip/.test(t)));
  assert.ok(calls.includes("gmail:list") && calls.includes("gmail:read"));
  // emails off: no mailbox call
  const r2 = await BB.buildProjectBundle({ quote, items: quote.items, rates: defaultRates(), project: { id: "p1" }, elementTypes: ELEMENT_TYPES, want: { emails: false, drawings: false, files: false, takeoff: false, versions: false } }, { ...deps, gmail: async () => { throw new Error("must not be called"); } });
  assert.ok(Object.keys(B.unzipStore(r2.bytes)).length === 4, "manual + the three quote files only");
  // App: the removal net and the timer
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/const removeItem = \(id\) => \{\s*keepVersion\("before-remove"\)/.test(app), "a before-remove version is kept before an element is removed");
  assert.ok(/\[autosaveMinutes, project\.id, quoteLoadedForVersions\]/.test(app) && !/\[autosaveMinutes, project\.id, quoteStatus\]/.test(app), "the autosave timer never restarts on a save's status flip");
  assert.ok(/addEventListener\("pagehide", flush\)/.test(app) && /saveVersion\(p\.projectId, p\.quote, "autosave"\)/.test(app), "leaving with pending changes keeps a version from the state they were made on");
  assert.ok(/data-testid="download-project-button"/.test(app) && /<DownloadProjectModal quote=\{quote\}/.test(app));
  const vm = fs.readFileSync(new URL("../src/components/VersionsModal.jsx", import.meta.url), "utf8");
  assert.ok(/"before-remove": "Before an element was removed"/.test(vm));
});
await checkAsync("FORMWORK follows the 22 Oct 2026 pattern: application groups in order, the depth-split edgeform, the three suspended rates, the retired beam/fold and per-day scaffold rows costing only where carried, the library's table matching name for name", async () => {
  const cat = FULL_CATALOG.find((c) => c.key === "FORMWORK");
  const live = cat.products.filter((p) => !p.legacy), retired = cat.products.filter((p) => p.legacy);
  assert.deepEqual([...new Set(live.map((p) => p.group))], ["Ground slabs", "Suspended", "Void formers", "Vertical", "Other"], "the application order");
  // void formers (4 Nov 2026): supply per m², every row m², the pods and the cardboard thicknesses priced, the two unpublished rows at $0 and saying so
  const voids = live.filter((p) => p.group === "Void formers");
  assert.ok(voids.every((p) => p.unit === "m2"), "every void former is per m²");
  assert.deepEqual(voids.map((p) => [p.name, p.unitCost]), [["Waffle pod 150mm", 14], ["Waffle pod 225mm", 15], ["Waffle pod 300mm", 16], ["Waffle pod 375mm", 26], ["Cardboard void former 50mm", 23], ["Cardboard void former 75mm", 30], ["Cardboard void former 100mm", 30], ["Cardboard void former 125mm", 44], ["Cardboard void former 150mm", 48], ["Cardboard void former 200mm", 54], ["Dome void former (Cupolex-type)", 0], ["EPS void former block", 0]]);
  assert.ok(voids.filter((p) => p.unitCost === 0).every((p) => /no published rate/.test(productLabel(p))), "an unpriced void former says so in its label");
  const podded = newElementItem(ELEMENT_TYPES[0]); podded.qtys[rateKey("FORMWORK", "Waffle pod 225mm", "m2")] = 120;
  assert.equal(computeElementCost(podded, defaultRates(), "both").categoryTotals.FORMWORK, 120 * 15, "120 m² of 225 pods at $15");
  assert.equal(labourQuantities(podded, defaultRates()).formworkMeasure, 120, "the void former m² feeds the crew sheet's Boxing row");
  const byName = (n) => cat.products.find((p) => p.name === n);
  assert.deepEqual([byName("Edgeform").unit, byName("Edgeform").unitCost, byName("Edgeform").group], ["m", 25, "Ground slabs"], "ground-slab edgeform up to 400 mm: lineal metres at $25");
  assert.deepEqual([byName("Edgeform >400mm deep").unit, byName("Edgeform >400mm deep").unitCost], ["m2", 250]);
  assert.deepEqual(live.filter((p) => p.group === "Suspended").map((p) => [p.name, p.unit, p.unitCost]), [["Conventional", "m2", 200], ["Bondek", "m2", 150], ["KingFlor", "m2", 150], ["Edgeform (suspended)", "m", 50]], "the suspended rates (KingFlor beside Bondek, at its figure — 25 Nov 2026), the edgeform by the lineal metre");
  assert.match(live.find((p) => p.name === "KingFlor").label, /seeded at the Bondek rate/, "KingFlor's label says where its figure comes from");
  assert.equal(byName("Columns (eg 300x300)").unitCost, 1500); assert.equal(byName("Crane Truck hire").unitCost, 2500); assert.equal(byName("Scaffold hire (set-up)").unitCost, 600); assert.equal(byName("Handrail").unitCost, 50);
  assert.deepEqual(retired.map((p) => p.name).sort(), ["Beam/fold sides <400mm d", "Beam/fold sides >400mm d", "Scaffold Hire"]);
  assert.equal(productLabel(byName("Edgeform")), "Edgeform — up to 400 mm deep"); assert.equal(productLabel(byName("Bondek")), "Bondek");
  // a retired row shows only on an element that carries a quantity on it — and still costs there
  const type = ELEMENT_TYPES[0];
  const blank = newElementItem(type), carrying = newElementItem(type);
  carrying.qtys[rateKey("FORMWORK", "Beam/fold sides <400mm d", "m")] = 12;
  assert.ok(!visibleProducts(cat, blank).some((p) => p.legacy), "nothing retired on a fresh element");
  assert.deepEqual(visibleProducts(cat, carrying).filter((p) => p.legacy).map((p) => p.name), ["Beam/fold sides <400mm d"]);
  assert.equal(computeElementCost(carrying, defaultRates(), "both").categoryTotals.FORMWORK, 12 * 100, "the retired row still costs at its rate");
  assert.equal(Object.keys(defaultRates()).filter((k) => k.startsWith("FORMWORK::")).length, cat.products.length, "every product, retired too, seeds a rate");
  // the Rates Library lists the live products name for name, in the same groups, at the same seeds
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const m = /const FORMWORK_LEGACY_ITEMS = \[([\s\S]*?)\n\];/.exec(html); assert.ok(m, "FORMWORK_LEGACY_ITEMS in rates-library.html");
  const rows = [...m[1].matchAll(/\{g:"([^"]+)", p:"([^"]+)",u:"([^"]+)",cost:([\d.]+)/g)].map((x) => ({ g: x[1], p: x[2], u: x[3], cost: Number(x[4]) }));
  assert.deepEqual(rows.map((r) => [r.g, r.p, r.u, r.cost]), live.map((p) => [p.group, p.name, p.unit, p.unitCost]), "library ↔ catalog drift");
  assert.ok(/formworkPattern === FORMWORK_PATTERN/.test(html) && /const FORMWORK_PATTERN = 2/.test(html), "the one-time move of the live library figures");
  const RLx = await import("../src/lib/ratesLibrarySync.js");
  assert.ok(RLx.libraryPrices({ formworkLegacy: { "Edgeform (suspended)": { cost: 55 } } }).some((x) => x.key === rateKey("FORMWORK", "Edgeform (suspended)", "m") && x.price === 55), "the library prices the suspended edgeform onto its key");
});
check("Import: a beam / fold side prices by DEPTH — up to 400 mm as lineal metres on Edgeform (m² ÷ depth), over 400 mm on the m² row, no depth stated → the m² row with a flag", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Raft Slab", element: "Raft 1", elementId: "EL20", materialGroup: "Formwork", material: "Side formwork", spec: "Beam / fold sides — 300mm deep, 2 faces", unit: "m²", finalQty: 9 },
      { ...estLine({}), category: "Raft Slab", element: "Raft 1", elementId: "EL20", materialGroup: "Formwork", material: "Side formwork", spec: "Beam / fold sides — 600 mm deep", unit: "m²", finalQty: 18 },
      { ...estLine({}), category: "Raft Slab", element: "Raft 1", elementId: "EL20", materialGroup: "Formwork", material: "Side formwork", spec: "Beam / fold sides", unit: "m²", finalQty: 4 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("FORMWORK", "Edgeform", "m")], 30, "9 m² at 300 deep = 30 lm");
  assert.equal(item.qtys[rateKey("FORMWORK", "Edgeform >400mm deep", "m2")], 22, "18 m² over 400 + 4 m² with no depth");
  assert.ok(flags.some((f) => /no depth stated/.test(f)), flags.join(" | "));
  assert.equal(edgeDepthMm("Beam / fold sides — 350 mm deep"), 350); assert.equal(edgeDepthMm("D=450 fold"), 450); assert.equal(edgeDepthMm("fold sides"), null);
});
check("Import: a named formwork system on the spec (Bondek) maps to that exact FORMWORK product, and per-m edge formwork maps to Edgeform", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Suspended Slab", element: "Slab 1", elementId: "EL07",
        materialGroup: "Formwork", material: "Soffit formwork", spec: "net area · Bondek (permanent metal deck)", unit: "m²", finalQty: 120 },
      { ...estLine({}), category: "Suspended Slab", element: "Slab 1", elementId: "EL07",
        materialGroup: "Formwork", material: "Edgeform — perimeter edge formwork", spec: "200mm high edge", unit: "m", finalQty: 44 },
      // Reveals and step-down faces are also per-m edge boards now — they
      // land on the same Edgeform product and sum with the perimeter run.
      { ...estLine({}), category: "Suspended Slab", element: "Slab 1", elementId: "EL07",
        materialGroup: "Formwork", material: "Opening reveals", spec: "200mm high reveal", unit: "m", finalQty: 6 },
      { ...estLine({}), category: "Suspended Slab", element: "Slab 1", elementId: "EL07",
        materialGroup: "Formwork", material: "Step-down face formwork", spec: "150mm deep step ×1 riser(s)", unit: "m", finalQty: 5 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("FORMWORK", "Bondek", "m2")], 120);
  assert.equal(item.qtys[rateKey("FORMWORK", "Edgeform", "m")], 55); // 44 edge + 6 reveals + 5 step faces
  assert.ok(!flags.some((f) => f.includes("Bondek")), `Bondek should map cleanly without a flag, got: ${flags.join(" | ")}`);
});

check("Import: insulation lines with catalog product names map onto the INSULATION products (m² boards AND per-m strips)", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL08",
        materialGroup: "Insulation", material: "XPS rigid board 50mm (R1.47)", spec: "Under-slab / under-element insulation", unit: "m²", finalQty: 210 },
      { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL08",
        materialGroup: "Insulation", material: "Slab edge insulation — 30mm XPS 300mm strip", spec: "Edge / strip insulation", unit: "m", finalQty: 60 },
      { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL08",
        materialGroup: "Insulation", material: "Some unknown foam", spec: "", unit: "m²", finalQty: 5 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("INSULATION", "XPS rigid board 50mm (R1.47)", "m2")], 210);
  assert.equal(item.qtys[rateKey("INSULATION", "Slab edge insulation — 30mm XPS 300mm strip", "m")], 60);
  assert.ok(flags.some((f) => f.includes("Some unknown foam")), `unknown insulation should be flagged, got: ${flags.join(" | ")}`);
});

check("Import: vapour barrier m² lines map onto the OTHER ACCESSORIES 'Vapour barrier' product (distinct from Insulation)", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL09",
        materialGroup: "Base/Blinding", material: "Vapour barrier — 200um polyethylene", spec: "incl. 10% laps/upturns", unit: "m²", finalQty: 339.9 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("OTHER ACCESSORIES", "Vapour barrier", "m2")], 339.9);
  assert.equal(item.qtys[rateKey("INSULATION", "Vapour barrier", "m2")], undefined, "must not land on any Insulation product");
  assert.ok(!flags.some((f) => f.includes("Vapour barrier")), `vapour barrier must map cleanly, got flags: ${flags.join(" | ")}`);
});

check("Catalog: Bondek is a priced FORMWORK product (m²) so it appears in the Rates modal and the import can target it", () => {
  const fw = FULL_CATALOG.find((c) => c.key === "FORMWORK");
  const bondek = fw.products.find((p) => p.name === "Bondek");
  assert.ok(bondek, "Bondek missing from FORMWORK catalog");
  assert.equal(bondek.unit, "m2");
  assert.ok(Number(bondek.unitCost) > 0, "Bondek has no default rate");
});

check("Import: a count-only reinforcement line (no length, e.g. ligatures) is flagged with its weight, never silently dropped", () => {
  const { quote, flags } = buildImportFromEstimate({
    project: {},
    lines: [
      estLine({ material: "N20 concrete", finalQty: 1 }),
      { ...estLine({}), materialGroup: "Reinforcement", material: "N10",
        spec: "Circular ligatures (top+mid+bottom zones)", unit: "no.", finalQty: 39 },
      { ...estLine({}), materialGroup: "Reinforcement", material: "N10",
        spec: "Circular ligatures — mass", unit: "kg", finalQty: 40.01 },
    ],
  });
  const item = quote.items[0];
  assert.equal(item.qtys[rateKey("PROCESSED BAR", "N10", "m")], undefined); // no length was ever given — must not be invented
  // The count line and its mass line use unrelated spec text in the source
  // tool ("Circular ligatures (top+mid+bottom zones)" vs "Circular
  // ligatures — mass"), so this bridge can't reliably recognise them as one
  // pair and merge them into a single flag — it raises one flag per line
  // instead. That's a safe failure mode (both numbers stay visible) even if
  // slightly redundant; what actually matters is that the real weight (not
  // just the bare bar count) shows up somewhere in the flags.
  assert.ok(flags.some((f) => f.includes("39.00") && f.includes("no.")), `expected the bar count to be flagged, got: ${flags.join(" | ")}`);
  assert.ok(flags.some((f) => f.includes("40.01") && f.includes("kg")), `expected the actual weight to be flagged too, got: ${flags.join(" | ")}`);
});

check("TRENCH MESH covers every L-series size 3-8 bar, priced per length off its own catalog rate", () => {
  const tm = FULL_CATALOG.find((c) => c.key === "TRENCH MESH");
  assert.ok(tm, "TRENCH MESH category present");
  const names = tm.products.map((p) => p.name);
  const missing = [];
  ["L8TM", "L11TM", "L12TM", "L16TM"].forEach((fam) => {
    for (let bars = 3; bars <= 8; bars++) {
      const n = `${bars} Bar-${fam}`;
      if (!names.includes(n)) missing.push(n);
    }
  });
  assert.equal(missing.length, 0, `missing trench mesh sizes: ${missing.join(", ")}`);
  assert.equal(tm.products.length, 24, "3-8 bar x 4 gauges = 24 sizes, nothing duplicated");
  // the one the estimator asked for by name
  const l11x7 = tm.products.find((p) => p.name === "7 Bar-L11TM");
  assert.ok(l11x7.unitCost > 0 && l11x7.unitWeight > 0, "7 Bar-L11TM carries a rate and a weight");
  // masses rise with bar count within a family — a wider mesh is never lighter
  ["L8TM", "L11TM", "L12TM", "L16TM"].forEach((fam) => {
    const w = [];
    for (let bars = 3; bars <= 8; bars++) w.push(tm.products.find((p) => p.name === `${bars} Bar-${fam}`).unitWeight);
    for (let i = 1; i < w.length; i++) assert.ok(w[i] > w[i - 1], `${fam} mass falls from ${i + 2} to ${i + 3} bar`);
  });
  // TRENCH MESH is NOT weight- or area-priced: it costs qty x $/length (rule 2)
  assert.ok(!tm.weightBasis && !tm.areaBasis, "trench mesh costs off its catalog $/length, not tonnage or area");
  // straight through the one place all three bases live (rule 2)
  assert.equal(computeRowTotal(tm, l11x7, 10), 10 * l11x7.unitCost, "10 lengths cost 10 x the $/length");
  assert.equal(computeRowTotal(tm, l11x7, 0), 0, "a blank row costs nothing");
  // its unitWeight is informational tonnage only, never the price basis
  const l12x7 = tm.products.find((p) => p.name === "7 Bar-L12TM");
  assert.ok(l11x7.unitWeight < l12x7.unitWeight && computeRowTotal(tm, l11x7, 1) < computeRowTotal(tm, l12x7, 1),
    "the heavier gauge costs more, but off its own $/length, not off tonnage");
  // every new size falls back to the catalog default when a saved rates blob predates it (rule 6)
  const stale = defaultRates();
  delete stale[rateKey("TRENCH MESH", "7 Bar-L11TM", l11x7.unit)];
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  item.qtys[rateKey("TRENCH MESH", "7 Bar-L11TM", l11x7.unit)] = 10;
  assert.ok(computeElementCost(item, stale).materialsTotal > 0, "a rates blob saved before these sizes existed still prices them");
});

check("The agreed house margin is 25%, and 25% margin means cost / 0.75 (a 33.33% markup), never cost x 1.25", () => {
  assert.equal(catalogAll.DEFAULT_MARGIN, 0.25, "Gradcon's agreed margin");
  assert.ok(MARGIN_STEPS.includes(0.25), "and it is a rung on the ladder, so it renders highlighted");

  // the ladder divides (CLAUDE.md rule 4) — this is the arithmetic Grady
  // queried, pinned so it can never silently become a markup
  const cost = 80545.91;
  const { rows } = computeMarginLadder(cost, 0, 0, 0, [0.25]);
  const r = rows[0];
  assert.ok(Math.abs(r.sellExGst - cost / 0.75) < 1e-9, "sell = cost / (1 - 0.25)");
  assert.ok(Math.abs(r.sellExGst - 107394.5467) < 1e-3, `expected $107,394.55, got ${r.sellExGst}`);
  // the profit inside that price really is 25% OF THE SELL
  const profit = r.sellExGst - cost;
  assert.ok(Math.abs(profit / r.sellExGst - 0.25) < 1e-9, "profit is 25% of the sell price");
  // ...and 33.33% of the cost, which is what you'd have to mark up by
  assert.ok(Math.abs(profit / cost - 1 / 3) < 1e-9, "the equivalent markup on cost is 33.33%");
  // marking up BY the margin instead lands 5 points short — the original bug
  const wrong = cost * 1.25;
  assert.ok(Math.abs((wrong - cost) / wrong - 0.20) < 1e-9, "cost x 1.25 only earns 20% margin");
  assert.ok(r.sellExGst > wrong, "so the ladder always prices above the multiply-by method");

  // every rung states its own markup beside it, so nobody has to convert
  assert.ok(Math.abs(r.markupOnCost - 1 / 3) < 1e-9, "the 25% rung reports a 33.33% markup");
  const all = computeMarginLadder(cost, 0, 0, 0, MARGIN_STEPS).rows;
  all.forEach((row) => {
    // the markup is exactly what reproduces that rung's sell price from cost
    assert.ok(Math.abs(cost * (1 + row.markupOnCost) - row.sellExGst) < 1e-6,
      `cost x (1 + markup) must equal the ${Math.round(row.margin * 100)}% sell price`);
    // and it is always ABOVE the margin — that is the whole point of the column
    assert.ok(row.markupOnCost > row.margin, `markup must exceed the margin at ${Math.round(row.margin * 100)}%`);
  });
  const pct = (m) => all.find((x) => Math.abs(x.margin - m) < 1e-9).markupOnCost * 100;
  assert.equal(pct(0.10).toFixed(1), "11.1");
  assert.equal(pct(0.20).toFixed(1), "25.0");
  assert.equal(pct(0.30).toFixed(1), "42.9");
  assert.equal(pct(0.40).toFixed(1), "66.7");
});

const { pendingRateUpdates, libraryPrices, libraryGovernedKeys, LIBRARY_EXCLUDED_NAMES } = await import("../src/lib/ratesLibrarySync.js");
const { isProvisional, computeProvisionalTotals } = await import("../src/lib/costing.js");
const DF = await import("../src/lib/driveFiles.js");
const PN = await import("../src/lib/projectNaming.js");
const WT = await import("../src/lib/workTrail.js");
const NOTICES = await import("../src/lib/notices.js");
const THEME = await import("../src/lib/quoteTheme.js");

check("Rates Library rules: its price flows into Quotes over ANY stored value, including a typed one", () => {
  const CONV = rateKey("FORMWORK", "Conventional", "m2");
  const C32 = rateKey("CONCRETE", "32 mpa", "m3");
  // the library's stored shape: {section: {productName: {cost}}}
  const lib = { formworkLegacy: { Conventional: { cost: 175 } }, concreteGrade: { "32 mpa": { cost: 219 } } };

  // both sitting at their catalog defaults — both move
  let rates = defaultRates();
  let up = pendingRateUpdates(rates, lib, {});
  assert.equal(up.length, 2, `expected both to move, got ${JSON.stringify(up)}`);
  assert.equal(up.find((u) => u.key === CONV).price, 175);
  assert.equal(up.find((u) => u.key === C32).price, 219);

  // an estimator (or an older build on another device) has left a different
  // formwork price in the shared row — the library STILL wins; the Rates
  // modal shows such rows as "Rates Library" and does not offer an edit box
  rates = defaultRates();
  rates[CONV] = { ...rates[CONV], unitCost: 190 };
  up = pendingRateUpdates(rates, lib, {});
  assert.ok(up.some((u) => u.key === CONV && u.price === 175), "the library corrects a stored rate whatever set it");
  assert.ok(libraryGovernedKeys(lib).has(CONV), "...and the modal knows the row is governed");

  // no last-synced record at all (a fresh browser, or a cleared one) makes no difference
  rates = defaultRates();
  rates[CONV] = { ...rates[CONV], unitCost: 60 };
  up = pendingRateUpdates(rates, { formworkLegacy: { Conventional: { cost: 150 } } }, undefined);
  assert.deepEqual(up.map(({ key, price }) => ({ key, price })), [{ key: CONV, price: 150 }]);

  // already in agreement = no update at all, so this can never render-loop
  rates = defaultRates();
  rates[CONV] = { ...rates[CONV], unitCost: 175 };
  assert.equal(pendingRateUpdates(rates, { formworkLegacy: { Conventional: { cost: 175 } } }, { [CONV]: 175 }).length, 0);
});

await checkAsync("Rates Library entries flow wherever they apply: reinforcement tables, labour & plant day rates, preliminaries, and products the stored row never carried", async () => {
  const RL = await import("../src/lib/ratesLibrarySync.js");
  const SL82 = rateKey("SQUARE MESH", "SL82", "m2"), N12 = rateKey("PROCESSED BAR", "N12", "m"), TM = rateKey("TRENCH MESH", "3 Bar-L8TM", "length"), SB = rateKey("STOCK BAR", "N12 - 6.0m length", "m");
  const CREW = rateKey("LABOUR", "Concrete Crew", "man-day"), PUMPM3 = rateKey("LABOUR", "Pump", "m³"), PUMPHR = rateKey("LABOUR", "Pump", "hr"), FORM = rateKey("LABOUR", "Formwork Crew", "man-day"), TRUCK = rateKey("LABOUR", "Trucks", "day");
  const PROPS = rateKey("SUB CONTRACTORS / TEMPORARY WORKS", "Temporary steel props/struts (150UC23.4) — supply/hire", "tonne");
  const lib = {
    reinforcementEstablished: { squareMesh: { SL82: 123 }, processedBar: { N12: 2.0 }, trenchMesh: { "3 Bar-L8TM": 15.5 }, stockBar: { "N12 - 6.0m length": 11 } },
    labourPlant: { 2: { cost: 555 }, 5: { cost: 260 }, 6: { cost: 9 }, 9: { cost: 3300 }, 10: { cost: 480 }, 12: { cost: 950 } },
  };
  let up = RL.pendingRateUpdates(defaultRates(), lib);
  const got = Object.fromEntries(up.filter((u) => u.price !== undefined).map((u) => [u.key, u.price]));
  assert.equal(got[SL82], 123, "square mesh $/sheet by name");
  assert.equal(got[N12], Math.round(2.0 * 1000 / 0.91 * 100) / 100, "processed bar: library $/m becomes Quotes $/tonne through the bar's kg/m");
  const pb = FULL_CATALOG.find((c) => c.key === "PROCESSED BAR").products;
  const seeds = Object.fromEntries(pb.map((p) => [p.name, +(1925 * p.unitWeight / 1000).toFixed(4)]));
  assert.deepEqual(RL.pendingRateUpdates(defaultRates(), { reinforcementEstablished: { processedBar: seeds } }), [], "the library's four-decimal $/m seeds round-trip to the same $/t (within a dollar) — no churn");
  assert.equal(got[TM], 15.5, "trench mesh per length"); assert.equal(got[SB], 11, "stock bar per 6 m length");
  assert.equal(got[CREW], 555, "Concreter/day → Concrete Crew man-day"); assert.equal(got[PUMPHR], 260); assert.equal(got[PUMPM3], 9, "the two Pump rows land on pump_hr and pump_m3 by UNIT");
  assert.equal(got[PROPS], 3300, "the props row lands on the SUB CONTRACTORS tonne product by name");
  assert.equal(got[FORM], 480, "the appended Formworker row → Formwork Crew"); assert.equal(got[TRUCK], 950, "Truck → Trucks");
  assert.ok(!Object.keys(got).some((k) => /Steel fix|Factory labour/.test(k)), "library-only rows reach nothing");
  // a stored row that never carried the key: compared with the catalog default, gains the key when the library differs
  const bare = {};
  assert.deepEqual(RL.pendingRateUpdates(bare, { reinforcementEstablished: { squareMesh: { SL82: 98.12 } } }), [], "equal to the catalog default = nothing to write");
  assert.deepEqual(RL.pendingRateUpdates(bare, { reinforcementEstablished: { squareMesh: { SL82: 99 } } }).map(({ key, price }) => ({ key, price })), [{ key: SL82, price: 99 }], "different = written even though the row lacked the key");
  // the modal knows every one of them is governed
  const gov = RL.libraryGovernedKeys(lib);
  [SL82, N12, TM, SB, CREW, PUMPM3, PROPS, FORM, TRUCK].forEach((k) => assert.ok(gov.has(k), `${k} governed`));
  // the labour mirror matches the library's own table, row for row
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("const LABOUR_PLANT_ITEMS"), html.indexOf("const PRELIMINARIES_ITEMS"));
  const rows = [...block.matchAll(/\{p:("(?:[^"\\]|\\.)*"),u:"([^"]+)",cost:[\d.]+\}/g)].map((m) => [JSON.parse(m[1]), m[2]]);
  assert.deepEqual(rows, RL.LIBRARY_LABOUR_PLANT.map(([n, u]) => [n, u]), "LIBRARY_LABOUR_PLANT mirrors LABOUR_PLANT_ITEMS in order");
  RL.LIBRARY_LABOUR_PLANT.forEach(([n, u, t]) => { if (Array.isArray(t)) assert.ok(RESOURCE_COLS.some((r) => r.name === t[0] && r.unit === t[1]), `${n} → a real crew-sheet resource`); });
  // preliminaries: any library name the catalog carries flows by name
  const pre = html.slice(html.indexOf("const PRELIMINARIES_ITEMS"), html.indexOf("];", html.indexOf("const PRELIMINARIES_ITEMS")));
  const preNames = [...pre.matchAll(/\{p:("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
  const cat = FULL_CATALOG.find((c) => c.key === "PRELIMINARIES");
  const shared = preNames.filter((n) => cat.products.filter((p) => p.name.toLowerCase() === n.toLowerCase()).length === 1);
  shared.forEach((n) => { const p = cat.products.find((p) => p.name.toLowerCase() === n.toLowerCase()); const u = RL.pendingRateUpdates(defaultRates(), { prelim: { [n]: { cost: p.unitCost + 7 } } }); assert.ok(u.some((x) => x.key === rateKey(cat.key, p.name, p.unit) && x.price === p.unitCost + 7), `prelim "${n}" flows`); });
});

await checkAsync("Rates Library changes are logged and an existing project is prompted per rate: ticked rates apply, unticked ones are kept (a partial library pin) and the pin travels", async () => {
  const RC = await import("../src/lib/rateChanges.js");
  const { effectiveRates, statusChangePatch, needsFreeze } = await import("../src/lib/rateFreeze.js");
  const SL82 = rateKey("SQUARE MESH", "SL82", "m2"), CREW = rateKey("LABOUR", "Concrete Crew", "man-day");
  const live = defaultRates();
  const t0 = "2026-10-20T10:00:00.000Z", t1 = "2026-10-21T10:00:00.000Z", t2 = "2026-10-21T10:05:00.000Z";
  let log = RC.recordRateChanges([], [{ key: SL82, price: 123, from: 98.12, name: "SL82" }, { key: CREW, price: 555, from: 500, name: "Concreter (day)" }, { key: "x", price: 5, from: 5, name: "same" }], t1);
  assert.equal(log.length, 2, "a move to the same figure is not a change");
  assert.deepEqual(log[0], { at: t1, key: SL82, name: "SL82", from: 98.12, to: 123 });
  assert.equal(RC.recordRateChanges(log, [{ key: SL82, price: 123, from: 98.12, name: "SL82" }], t2), log, "the same move minutes later (a second browser) is not logged twice");
  live[SL82] = { ...live[SL82], unitCost: 123 }; live[CREW] = { ...live[CREW], unitCost: 555 };
  const type = ELEMENT_TYPES.find((t) => t.labour === "slab_ground") || ELEMENT_TYPES[0];
  const item = newElementItem(type); item.qtys[SL82] = 144; // 10 sheets
  const quote = { status: "Estimating", items: [item], scope: "both" };
  const pend = RC.pendingRateChanges(quote, log, t0);
  assert.equal(pend.length, 2, "both changes are newer than the project");
  assert.deepEqual(RC.pendingRateChanges(quote, log, t2), [], "a project created after the change is never asked");
  assert.deepEqual(RC.pendingRateChanges({ ...quote, items: [] }, log, t0), [], "nothing to re-price = no prompt");
  const all = RC.rateChangeImpact(quote, live, pend), meshOnly = RC.rateChangeImpact(quote, live, pend, [SL82]), crewOnly = RC.rateChangeImpact(quote, live, pend, [CREW]);
  assert.ok(Math.abs((meshOnly.after - meshOnly.before) - 10 * (123 - 98.12)) < 0.01, `ticking the mesh alone: 10 sheets × $24.88 dearer: ${JSON.stringify(meshOnly)}`);
  assert.ok(crewOnly.after > crewOnly.before, "ticking the crew rate alone moves the auto crew days' cost");
  assert.ok(Math.abs((all.after - all.before) - ((meshOnly.after - meshOnly.before) + (crewOnly.after - crewOnly.before))) < 0.01, "both ticked = the two together");
  const touched = RC.rateChangeElements(quote, live, pend);
  assert.equal(touched[SL82].length, 1, "the mesh change touches the one element carrying SL82"); assert.equal(touched[SL82][0].id, item.id); assert.ok(Math.abs(touched[SL82][0].delta - 10 * (123 - 98.12)) < 0.01, "with its own $ move");
  assert.equal(touched[CREW].length, 1, "the crew rate touches the element through its auto crew days");
  const second = newElementItem(type); second.label = "Nothing typed yet";
  assert.deepEqual(RC.rateChangeElements({ ...quote, items: [item, second] }, live, pend)[SL82].map((e) => e.id), [item.id], "an element with no quantity on the key is not listed");
  const byEl = RC.elementRateChanges(quote, live, pend); assert.equal(byEl[item.id].length, 2, "the element's own list carries both changes with their deltas"); assert.ok(byEl[item.id].every((c) => typeof c.delta === "number" && c.name));
  // tick the crew rate, keep the mesh: a partial pin of the mesh only
  const part = { ...quote, ...RC.decideRateChangesPatch(quote, live, pend, [CREW], t2) };
  assert.ok(RC.isLibraryPin(part) && Object.keys(part.ratesFrozen.rates).length === 1 && part.ratesFrozen.rates[SL82].unitCost === 98.12, JSON.stringify(part.ratesFrozen));
  assert.equal(effectiveRates(part, live)[SL82].unitCost, 98.12, "the kept mesh prices at the previous figure on an OPEN status");
  assert.equal(effectiveRates(part, live)[CREW].unitCost, 555, "the ticked crew rate follows the library");
  assert.deepEqual(RC.keptRates(part).map((k) => [k.name, k.unitCost]), [["SL82", 98.12]]);
  assert.deepEqual(RC.pendingRateChanges(part, log, t0), [], "decided — not asked again for the same changes");
  // a LATER library move on the kept key asks again, from the kept figure
  const later = RC.recordRateChanges(log, [{ key: SL82, price: 130, from: 123, name: "SL82" }], "2026-10-22T09:00:00.000Z");
  assert.deepEqual(RC.pendingRateChanges(part, later, t0).map((c) => [c.key, c.from, c.to]), [[SL82, 98.12, 130]]);
  // apply all / keep all are the two ends of the same decision
  const applied = { ...quote, ...RC.applyRateChangesPatch(quote, live, pend, t2) };
  assert.equal(applied.ratesFrozen, null); assert.deepEqual(RC.pendingRateChanges(applied, log, t0), []); assert.equal(effectiveRates(applied, live)[SL82].unitCost, 123);
  const kept = { ...quote, ...RC.keepPreviousRatesPatch(quote, live, pend, t2) };
  assert.equal(effectiveRates(kept, live)[SL82].unitCost, 98.12); assert.equal(effectiveRates(kept, live)[CREW].unitCost, 500);
  // release: one key, then the rest — the pin goes when empty
  const rel1 = { ...kept, ...RC.releaseKeptRatesPatch(kept, [CREW]) };
  assert.equal(effectiveRates(rel1, live)[CREW].unitCost, 555); assert.equal(effectiveRates(rel1, live)[SL82].unitCost, 98.12);
  assert.equal(RC.releaseKeptRatesPatch(rel1).ratesFrozen, null, "releasing the last kept key drops the pin");
  // the kept figures travel: open → open leaves them; locking pins what the project prices at today (kept figures inside); locked → open drops the pin as ever
  let p = statusChangePatch(part, "Queued", live, t2); assert.ok(!("ratesFrozen" in p), "open → open leaves a library pin alone");
  p = statusChangePatch(part, "Completed Estimating", live, t2);
  assert.ok(p.ratesFrozen && p.ratesFrozen.reason === undefined && p.ratesFrozen.rates[SL82].unitCost === 98.12 && p.ratesFrozen.rates[CREW].unitCost === 555, "locking takes a full status pin of the EFFECTIVE rates");
  assert.ok(needsFreeze({ ...part, status: "Completed Estimating" }), "a locked project still carrying only a library pin needs its full copy");
  const lockedKept = { ...part, status: "Completed Estimating", ratesFrozen: p.ratesFrozen };
  p = statusChangePatch(lockedKept, "Estimating", live, t2); assert.equal(p.ratesFrozen, null, "back to open from a locked status drops the pin, as ever");
  const plain = { status: "Estimating", items: [item], ratesFrozen: { at: t1, status: "Completed Estimating", rates: { ...live } } };
  assert.equal(effectiveRates(plain, live), live, "a STATUS pin on an open status is still ignored");
  assert.equal(statusChangePatch(plain, "Queued", live, t2).ratesFrozen, null, "...and still cleared on an open→open move");
});

// ---------------------------------------------------------------------------
// Google Drive project files (api/_google.js Drive adapter, api/drive.js, src/lib/driveFiles.js)
// ---------------------------------------------------------------------------
await checkAsync("Drive: the consent asks for drive.readonly beside gmail; the connection reports whether Drive was granted; a folder link or id parses; a file's kind follows its mime / name", async () => {
  const G = await import("../api/_google.js");
  const genv = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" };
  const u = G.consentUrl("https://estimating-website.vercel.app/api/google-auth", genv, 1000);
  assert.ok(decodeURIComponent(u).includes(G.DRIVE_SCOPE) && decodeURIComponent(u).includes(G.GMAIL_SCOPE), "both scopes asked");
  assert.equal(G.connectionStatus({ email: "projects@gradcon.com.au", refresh: "v1.x", scope: `${G.GMAIL_SCOPE} openid email` }, genv).drive, false, "an old mail-only connection has no Drive");
  assert.equal(G.connectionStatus({ email: "projects@gradcon.com.au", refresh: "v1.x", scope: `${G.GMAIL_SCOPE} ${G.DRIVE_SCOPE} openid email` }, genv).drive, true);
  assert.equal(G.driveFolderIdFrom("https://drive.google.com/drive/folders/1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX?usp=drive_link"), "1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX");
  assert.equal(G.driveFolderIdFrom("1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX"), "1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX"); assert.equal(G.driveFolderIdFrom("not a link"), null);
  assert.equal(G.DEFAULT_DRIVE_ROOT_ID, "1rhMdIuNr3-sYtqEk29Qvwpt1AY9I11WX", "the office folder Grady gave is the default root");
  assert.deepEqual(["application/vnd.google-apps.folder", "application/pdf", "image/png", "application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/octet-stream"].map((m) => G.fileKind(m, m === "application/octet-stream" ? "plan.dwg" : "x")), ["folder", "pdf", "image", "doc", "sheet", "cad"]);
  // folder matching: the street number counts double, stop words are ignored, one clear winner is `best`
  const folders = [{ id: "a", name: "12 Beach Rd Mentone", kind: "folder" }, { id: "b", name: "145 Harrisons Road", kind: "folder" }, { id: "c", name: "Templates", kind: "folder" }, { id: "d", name: "12 Beach Road - old", kind: "folder" }];
  const m = G.matchProjectFolder(folders, { projectName: "145 Harrisons Rd Beaconsfield" });
  assert.equal(m.best && m.best.id, "b"); assert.ok(m.candidates[0].score >= 0.6);
  const tie = G.matchProjectFolder(folders, { projectName: "12 Beach Road" });
  assert.equal(tie.best, null, "two folders fit 12 Beach Road equally — no silent pick"); assert.equal(tie.candidates.length, 2);
  assert.equal(G.matchProjectFolder(folders, { projectName: "" }).candidates.length, 0);
});
await checkAsync("Drive function: unconfigured → 503; no connection → 409; a mail-only connection → 409 needsReconnect; with Drive: list / folder / search stay inside the root, a copy lands in the bucket as a public URL (a Doc exported as PDF), an id outside the root is refused", async () => {
  const G = await import("../api/_google.js");
  const DR = await import("../api/drive.js");
  const genv = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" };
  const ROOT = G.DEFAULT_DRIVE_ROOT_ID;
  // a tiny fake Drive: root → [folder "12 Beach Rd" → [plan.pdf, spec (Google Doc)], notes.pdf]; "elsewhere.pdf" sits outside the root
  const files = {
    [ROOT]: { id: ROOT, name: "Gradcon Projects", mimeType: "application/vnd.google-apps.folder", parents: [] },
    folder12BeachRd01: { id: "folder12BeachRd01", name: "12 Beach Rd", mimeType: "application/vnd.google-apps.folder", parents: [ROOT] },
    p1: { id: "p1", name: "plan.pdf", mimeType: "application/pdf", size: "1200", modifiedTime: "2026-10-20T00:00:00Z", parents: ["folder12BeachRd01"], md5Checksum: "abc" },
    d1: { id: "d1", name: "spec", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-19T00:00:00Z", parents: ["folder12BeachRd01"] },
    n1: { id: "n1", name: "notes.pdf", mimeType: "application/pdf", size: "300", parents: [ROOT] },
    x1: { id: "x1", name: "elsewhere.pdf", mimeType: "application/pdf", size: "5", parents: ["other"] },
    other: { id: "other", name: "Private", mimeType: "application/vnd.google-apps.folder", parents: [] },
  };
  const uploads = [], writes = [];
  const mk = (conn, storageRow) => async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.from("%PDF-fake"), headers: { get: (k) => (k === "content-type" ? "application/pdf" : null) } });
    if (u.includes("/rest/v1/estimator_kv?key=eq.gradcon-google-mail")) return json(conn ? [{ value: conn }] : []);
    if (u.includes("/rest/v1/estimator_kv?key=eq.gradcon-storage")) return json(storageRow ? [{ value: storageRow }] : []);
    if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (u.endsWith("/rest/v1/estimator_kv") && opts.method === "POST") { writes.push(JSON.parse(opts.body)); return json({}, 201); }
    if (u.includes("/storage/v1/object/gradcon-files/")) { uploads.push({ path: u.split("/gradcon-files/")[1], type: opts.headers && opts.headers["Content-Type"], bytes: opts.body }); return json({ Key: "ok" }); }
    const m = /\/drive\/v3\/files\/([^/?]+)(\/export)?\?/.exec(u);
    if (m) { const f = files[decodeURIComponent(m[1])]; if (!f) return json({ error: { message: "not found" } }, 404); if (m[2] || u.includes("alt=media")) return json({}); return json(f); }
    if (u.includes("/drive/v3/files?")) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q") || "");
      const inParent = /'([^']+)' in parents/.exec(q);
      let out = Object.values(files).filter((f) => f.id !== ROOT && f.id !== "other");
      if (inParent) out = out.filter((f) => (f.parents || []).includes(inParent[1]));
      else { const t = /contains '([^']+)'/.exec(q); out = out.filter((f) => f.name.toLowerCase().includes(t[1].toLowerCase())); }
      if (/mimeType = 'application\/vnd\.google-apps\.folder'/.test(q)) out = out.filter((f) => f.mimeType.endsWith("folder"));
      return json({ files: out });
    }
    throw new Error("unexpected fetch " + u);
  };
  G.resetTokenCache();
  assert.equal((await DR.runDrive({ action: "list" }, {}, mk(null))).status, 503);
  assert.equal((await DR.runDrive({ action: "list" }, genv, mk(null))).status, 409);
  const mailOnly = { email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv), scope: G.GMAIL_SCOPE };
  const r409 = await DR.runDrive({ action: "list" }, genv, mk(mailOnly)); assert.equal(r409.status, 409); assert.ok(r409.body.needsReconnect, "a mail-only connection says reconnect");
  const st0 = await DR.runDrive({ action: "status" }, genv, mk(mailOnly)); assert.equal(st0.status, 200); assert.equal(st0.body.drive, false); assert.equal(st0.body.root, null);
  const conn = { email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv), scope: `${G.GMAIL_SCOPE} ${G.DRIVE_SCOPE}` };
  const f = mk(conn);
  G.resetTokenCache();
  const st = await DR.runDrive({ action: "status" }, genv, f); assert.equal(st.body.drive, true); assert.equal(st.body.root.name, "Gradcon Projects"); assert.ok(st.body.root.isDefault);
  const list = await DR.runDrive({ action: "list" }, genv, f); assert.deepEqual(list.body.files.map((x) => x.name), ["12 Beach Rd", "notes.pdf"]); assert.equal(list.body.files[0].kind, "folder");
  const fo = await DR.runDrive({ action: "folder", id: "folder12BeachRd01" }, genv, f); assert.equal(fo.body.folder.name, "12 Beach Rd"); assert.deepEqual(fo.body.path.map((p) => p.id), [ROOT]);
  const mt = await DR.runDrive({ action: "match", projectName: "12 Beach Road Mentone" }, genv, f); assert.equal(mt.body.best && mt.body.best.id, "folder12BeachRd01");
  const se = await DR.runDrive({ action: "search", text: "pdf" }, genv, f); assert.deepEqual(se.body.files.map((x) => x.id).sort(), ["n1", "p1"], "elsewhere.pdf is outside the root and never returned");
  const se2 = await DR.runDrive({ action: "search", text: "pdf", within: "folder12BeachRd01" }, genv, f); assert.deepEqual(se2.body.files.map((x) => x.id), ["p1"], "a search within the project folder");
  assert.equal((await DR.runDrive({ action: "file", id: "x1" }, genv, f)).status, 403, "outside the root is refused");
  assert.equal((await DR.runDrive({ action: "list", folderId: "other" }, genv, f)).status, 403);
  const cp = await DR.runDrive({ action: "copy", id: "p1", target: "preview" }, genv, f);
  assert.equal(cp.status, 200); assert.ok(/^drive\/p1\/abc\/plan\.pdf$/.test(cp.body.file.path), cp.body.file.path); assert.ok(/storage\/v1\/object\/public\/gradcon-files\/drive\/p1\/abc\/plan\.pdf$/.test(cp.body.file.url)); assert.equal(cp.body.file.fromDrive.id, "p1");
  // a copy the bucket already holds (same md5 → same path) is answered from the metadata: no Drive download, no upload (26 Oct 2026)
  { const held = new Set(uploads.map((u) => u.path)); const seen = []; const f2 = async (url, opts = {}) => { const u = String(url); seen.push((opts.method || "GET") + " " + u); if (opts.method === "HEAD" && u.includes("/storage/v1/object/public/gradcon-files/")) { const path = u.split("/gradcon-files/")[1]; return held.has(path) ? { ok: true, status: 200, headers: { get: (k) => (k === "content-length" ? "1234" : k === "content-type" ? "application/pdf" : null) } } : { ok: false, status: 400, headers: { get: () => null } }; } return f(url, opts); };
    const before = uploads.length;
    const again = await DR.runDrive({ action: "copy", id: "p1", target: "preview" }, genv, f2);
    assert.equal(again.status, 200); assert.ok(again.body.file.cached, "answered from the bucket"); assert.equal(again.body.file.path, cp.body.file.path); assert.equal(again.body.file.size, 1234);
    assert.equal(uploads.length, before, "nothing re-uploaded"); assert.ok(!seen.some((x) => /alt=media/.test(x)), "nothing re-downloaded from Drive: " + seen.join(" | "));
    const fresh = await DR.runDrive({ action: "copy", id: "d1", target: "preview" }, genv, f2);
    assert.ok(!fresh.body.file.cached && uploads.length === before + 1, "a file the bucket lacks is still copied"); }
  const cj = await DR.runDrive({ action: "copy", id: "d1", target: "job", jobId: "job7" }, genv, f);
  assert.equal(cj.body.file.path, "ai-engine/job7/spec.pdf", "a Google Doc copies as PDF under the job"); assert.equal(cj.body.file.mimeType, "application/pdf");
  assert.equal((await DR.runDrive({ action: "copy", id: "p1", target: "job" }, genv, f)).status, 400, "a job copy needs the job id");
  assert.equal((await DR.runDrive({ action: "copy", id: "x1" }, genv, f)).status, 403);
  // Settings: another root folder
  const sr = await DR.runDrive({ action: "setRoot", link: "https://drive.google.com/drive/folders/folder12BeachRd01" }, genv, f); assert.equal(sr.status, 200); assert.equal(sr.body.root.name, "12 Beach Rd"); assert.equal(writes[0].key, "gradcon-storage"); assert.equal(writes[0].value.drive.rootId, "folder12BeachRd01", "the chosen root is stored in the shared row");
  assert.equal((await DR.runDrive({ action: "setRoot", id: "p1" }, genv, f)).status, 400, "a file is not a root");
  const stored = { drive: { rootId: "folder12BeachRd01", rootName: "12 Beach Rd" } };
  const scoped = await DR.runDrive({ action: "list" }, genv, mk(conn, stored)); assert.deepEqual(scoped.body.files.map((x) => x.id), ["p1", "d1"], "the chosen root scopes the listing");
  assert.equal((await DR.runDrive({ action: "file", id: "n1" }, genv, mk(conn, stored))).status, 403, "...and refuses what is above it");
});
check("project naming: the convention test, the reader of the model's reply (known ids, conventional names only), auto-apply only on a confident single answer, the patch a choice writes", () => {
  assert.ok(PN.isConventionName("19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion")); assert.ok(PN.isConventionName("2/12 Beach Road, Mentone VIC 3194")); assert.ok(PN.isConventionName("Unit 3, 8 Main Street, Mornington VIC 3931"));
  assert.ok(!PN.isConventionName("33 Churchill (from Estimates)")); assert.ok(!PN.isConventionName("18 Beach Road")); assert.ok(!PN.isConventionName(""));
  assert.ok(PN.needsAddressReview({ projectName: "18 Beach Road" })); assert.ok(!PN.needsAddressReview({ projectName: "18 Beach Road", nameReviewedFor: "18 Beach Road" }), "a typed name once reviewed is not asked again"); assert.ok(!PN.needsAddressReview({ projectName: "2/12 Beach Road, Mentone VIC 3194" }));
  const rows = [{ id: "a", name: "18 Beach Road" }, { id: "b", name: "9 Stonecutters" }];
  assert.ok(/18 Beach Road/.test(PN.addressPrompt(rows)) && /NEVER invent a street number/.test(PN.addressPrompt(rows)));
  const reply = JSON.stringify({ projects: [
    { id: "a", confidence: "low", note: "suburb not typed", options: [{ name: "18 Beach Road, Mentone VIC 3194", street: "18 Beach Road", suburb: "Mentone", state: "vic", postcode: "3194" }, { name: "18 Beach Road, Hampton VIC 3188", street: "18 Beach Road", suburb: "Hampton", state: "VIC", postcode: "3188" }, { name: "not an address", street: "", suburb: "", state: "", postcode: "" }] },
    { id: "b", confidence: "high", options: [{ name: "9 Stonecutters Road, Portsea VIC 3944", street: "9 Stonecutters Road", suburb: "Portsea", state: "VIC", postcode: "3944" }] },
    { id: "zzz", confidence: "high", options: [{ name: "1 Fake Street, Nowhere VIC 3000" }] },
  ] });
  const res = PN.parseAddressReply("```json\n" + reply + "\n```", rows);
  assert.deepEqual(Object.keys(res).sort(), ["a", "b"], "unknown ids are dropped"); assert.equal(res.a.options.length, 2, "a non-conventional option is dropped"); assert.equal(res.a.options[0].state, "VIC");
  assert.ok(!PN.autoApplies(res.a), "two options at low confidence = a choice"); assert.ok(PN.autoApplies(res.b), "one option at high confidence applies on its own");
  const patch = PN.applyNamePatch({ projectName: "9 Stonecutters" }, res.b.options[0], "9 Stonecutters");
  assert.deepEqual(patch, { projectName: "9 Stonecutters Road, Portsea VIC 3944", siteAddress: "9 Stonecutters Road, Portsea VIC 3944", nameSource: "9 Stonecutters", nameReviewedFor: "9 Stonecutters Road, Portsea VIC 3944" });
  assert.equal(PN.applyNamePatch({ projectName: "x", nameSource: "the first typed" }, res.b.options[0], "x").nameSource, "the first typed", "the FIRST typed name is kept through later renames");
  assert.deepEqual(PN.keepNamePatch({ projectName: " 18 Beach Road " }), { nameReviewedFor: "18 Beach Road" });
});
await checkAsync("Quotes colour tokens: every preset values every token; overrides lay over the preset one by one (bad hex ignored); the portal Settings mirror matches the library", async () => {
  const T = await import("../src/lib/quoteTheme.js");
  T.PRESET_KEYS.forEach((k) => T.THEME_TOKENS.forEach((t) => assert.ok(/^#[0-9a-f]{6}$/i.test(T.PRESETS[k][t.key]), `${k}.${t.key}`)));
  assert.equal(T.resolveTheme({}).preset, "portal"); assert.equal(T.resolveTheme({ quotesTheme: "nope" }).preset, "portal");
  // the portal preset (Grady, 23 Oct 2026) is the shell's own palette: its lime accent carries DARK ink on buttons and a dark olive for figures on white; the older schemes keep white ink
  assert.deepEqual([T.PRESETS.portal.page, T.PRESETS.portal.chrome950, T.PRESETS.portal.accent600, T.PRESETS.portal.accentInk, T.PRESETS.portal.accentHover], ["#fafafa", "#231f20", "#d5de5d", "#1c1c1c", "#c6d045"]);
  assert.ok(T.PRESETS.portal.accentText !== T.PRESETS.portal.accent600, "money figures on white must not be the lime itself");
  ["library", "classic", "graphite"].forEach((k) => { assert.equal(T.PRESETS[k].accentInk, "#ffffff"); assert.equal(T.PRESETS[k].accentText, T.PRESETS[k].accent600); assert.equal(T.PRESETS[k].accentHover, T.PRESETS[k].accent700); });
  const css = fs.readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.ok(/\.bg-orange-600\.text-white[^{]*\{ color: var\(--t-accent-ink/.test(css) && /\.text-orange-600[^{]*\{ color: var\(--t-accent-text/.test(css) && /hover\\:bg-orange-700:hover \{ background-color: var\(--t-accent-hover/.test(css) && /html\[data-theme="portal"\]/.test(css), "index.css maps the ink / text / hover tokens");
  const r = T.resolveTheme({ quotesTheme: "classic", quotesThemeColors: { chrome950: "#101010", accent600: "not a colour", page: "#F5F5F5" } });
  assert.equal(r.tokens.chrome950, "#101010"); assert.equal(r.tokens.accent600, "#ea580c", "a bad value is ignored"); assert.deepEqual(r.overridden, ["chrome950"], "a value equal to the preset is not an override");
  const fake = { dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
  T.applyTheme(fake, r); assert.equal(fake.dataset.theme, "classic"); assert.equal(fake.style.props["--t-chrome-950"], "#101010"); assert.equal(fake.style.props["--t-band-summary"], "#171717");
  const html = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  const tok = /var QUOTE_THEME_TOKENS = (\[[\s\S]*?\]);\n/.exec(html), pre = /var QUOTE_THEME_PRESETS = (\{[\s\S]*?\});\n/.exec(html);
  assert.ok(tok && pre, "the shell carries the two mirrors");
  assert.deepEqual(JSON.parse(tok[1]), T.THEME_TOKENS, "QUOTE_THEME_TOKENS mirror drifted"); assert.deepEqual(JSON.parse(pre[1]), T.PRESETS, "QUOTE_THEME_PRESETS mirror drifted");
});
check("Grady's crew sheet (22 Oct 2026): his task names on every new element; each Qty prefills from the element's own fields — excavation and soil removal from their lines, blinding from the CONCRETE blinding row, tie reo from the tonnage, the pour less the blinding, stripping from the formed m², BOXING from everything on the FORMWORK band (m² + lineal metres); an older element is renamed once with its cells kept and the missing rows added", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const item = newElementItem(type);
  assert.deepEqual(item.tasks.map((t) => t.name), ["Site setup", "Delivery of materials (yard works)", "Excavation & prep base", "Remove soil", "Blinding concrete", "Tie reo", "Pour concrete", "Finish concrete surfaces", "Site clean and tidy", "Stripping (formwork)", "Collection of materials", "Yard works", "Boxing", "Additional labour / plant"]);
  item.qtys[rateKey("OTHER ALLOWANCES", "Excavation", "m3")] = 30; item.qtys[rateKey("OTHER ALLOWANCES", "Soil removal", "m3")] = 36;
  item.qtys[rateKey("CONCRETE", "Blinding concrete", "m3")] = 4; item.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 20;
  item.qtys[rateKey("FORMWORK", "Edgeform", "m")] = 40; item.qtys[rateKey("FORMWORK", "Conventional", "m2")] = 12; item.qtys[rateKey("SQUARE MESH", "SL82", "m2")] = 100;
  const lq = labourQuantities(item, rates);
  const q = (re) => taskRowMeta(item.tasks.find((t) => re.test(t.name)).name, lq);
  assert.deepEqual([q(/excavat/i).autoQty, q(/remove soil/i).autoQty], [30, 36], "excavation and soil removal from their lines");
  assert.deepEqual([q(/blinding/i).unit, q(/blinding/i).autoQty], ["m³", 4], "the blinding row from the blinding concrete entered");
  assert.equal(q(/pour/i).autoQty, 20, "the pour is the poured concrete LESS the blinding (its own row)");
  assert.deepEqual([q(/boxing/i).unit, q(/boxing/i).autoQty], ["m²/lm", 52], "boxing = everything on the FORMWORK band: 12 m² + 40 lm");
  assert.equal(q(/strip/i).autoQty, 12); assert.equal(q(/finish/i).autoQty, 100);
  assert.equal(q(/tie reo/i).unit, "t");
  // the blinding row books concreters like a pour; typed cells still win
  const auto = autoLabourQtys(item, rates); const bl = item.tasks.find((t) => /blinding/i.test(t.name));
  assert.equal(auto[bl.id].concreter_day, 1.2, "4 m³ at 10 m³/crew-day = 0.4 crew-days, shown as man-days for the 3-man crew");
  // an older element: the earlier names renamed in place (ids and cells kept), the new rows added in Grady's order
  const old = newElementItem(type);
  old.tasksVer = undefined;
  old.tasks = ["Site setup / mobilisation", "Excavate & prepare base", "Remove / cart away spoil", "Tie reinforcement", "Pour / place / vibrate concrete", "Finish concrete surfaces", "Washout / clean / tidy", "Material D+C", "Boxing and Rebates"].map((name, i) => ({ id: "t" + i, name, qtys: i === 4 ? { concreter_day: 9 } : {} }));
  const up = upgradeCrewTasks(old);
  assert.equal(up.tasksVer, 3); assert.strictEqual(upgradeCrewTasks(up), up, "once");
  assert.deepEqual(up.tasks.map((t) => t.name), ["Site setup", "Delivery of materials (yard works)", "Excavation & prep base", "Remove soil", "Blinding concrete", "Tie reo", "Pour concrete", "Finish concrete surfaces", "Site clean and tidy", "Stripping (formwork)", "Collection of materials", "Yard works", "Boxing"]);
  assert.equal(up.tasks.find((t) => t.name === "Pour concrete").id, "t4"); assert.equal(up.tasks.find((t) => t.name === "Pour concrete").qtys.concreter_day, 9, "cells and ids kept");
  const pre = newElementItem(ELEMENT_TYPES.find((t) => t.labour === "prelims")); const names = pre.tasks.map((t) => t.name);
  assert.deepEqual(upgradeCrewTasks({ ...pre, tasksVer: undefined }).tasks.map((t) => t.name), names, "the preliminaries sheet is its own");
});
check("Blinding is decided on the crew sheet: ticked (the default) it is charged — material, its crew row, its share of the Holcim fees; unticked ALL of it leaves the totals while the figures stay typed, and the money left out is reported", () => {
  const rates = defaultRates();
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""}: ${a} !~= ${b}`);
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.qtys[rateKey("CONCRETE", "Blinding concrete", "m3")] = 5; item.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 11;
  item.tasks.find((t) => /blinding/i.test(t.name)).qtys.concreter_day = 2;
  const on = computeElementCost(item, rates, "both");
  assert.ok(blindingIncluded(item) && on.blindingIncluded && on.excludedBlinding === 0);
  assert.equal(on.concreteQty, 16, "blinding is poured concrete when added");
  const offItem = { ...item, blindingIncluded: false };
  const off = computeElementCost(offItem, rates, "both");
  const blindingMaterial = 5 * rates[rateKey("CONCRETE", "Blinding concrete", "m3")].unitCost;
  const crewRate = rates[rateKey("LABOUR", "Concrete Crew", "man-day")].unitCost;
  assert.ok(off.total < on.total, "unticked = less money");
  near(off.excludedBlinding, blindingMaterial + 2 * crewRate, "the material and the crew row are what is left out");
  assert.equal(off.concreteQty, 11, "...and it is no longer poured volume");
  assert.ok(!off.blindingIncluded);
  assert.equal(labourQuantities(offItem, rates).blindingM3, 0, "the blinding row's Qty reads 0 while unticked");
  assert.equal(labourQuantities(offItem, rates).pourM3, 11);
  // the Holcim fees follow the poured volume: 16 m³ = 4 loads exactly (no cartage) vs 11 m³ = 1 m³ short
  assert.equal(autoMinimumCartage(item, rates), null); assert.ok(autoMinimumCartage(offItem, rates) && autoMinimumCartage(offItem, rates).qty === 1);
  assert.equal(offItem.qtys[rateKey("CONCRETE", "Blinding concrete", "m3")], 5, "the typed figure is never touched");
});
check("finish concrete has a method (22 Oct 2026): a slab = its area + the exposed edge faces (edgeform m², lm × the exposed depth), never internal beam faces; a footing = its top; a wall = its formed faces; the crew Finish row reads it", () => {
  const C = costingAll; const rates = defaultRates();
  const fk = (n, u) => rateKey("FORMWORK", n, u), mk = rateKey("SQUARE MESH", "SL82", "m2");
  const raft = { id: "r", typeId: "raft_foundation", label: "Raft", measureM2: 200, qtys: { [fk("Edgeform >400mm deep", "m2")]: 12, [fk("Edgeform", "m")]: 40, [fk("Conventional", "m2")]: 99, [mk]: 230 }, tasks: [{ id: "f", name: "Finish concrete surfaces", qtys: {} }], additional: [], finish: { edgeDepthMm: 300 } };
  const fb = C.finishBuildUp(raft);
  assert.deepEqual(fb.parts.map((p) => [p.key, p.m2]), [["slab", 200], ["edgeM2", 12], ["edgeLm", 12]], "slab area + edge m² + 40 lm × 0.3; the Conventional m² and the mesh are not added");
  assert.equal(fb.m2, 224); assert.equal(C.labourQuantities(raft, rates).finishM2, 224); assert.equal(C.taskRowMeta("Finish concrete surfaces", C.labourQuantities(raft, rates)).autoQty, 224);
  const noDepth = C.finishBuildUp({ ...raft, finish: {} }); assert.equal(noDepth.m2, 212, "with no exposed depth the lineal metres are listed, not counted"); assert.ok(/enter the exposed edge depth/.test(noDepth.parts[2].label));
  const meshOnly = C.finishBuildUp({ ...raft, measureM2: 0, qtys: { [mk]: 230 } }); assert.equal(meshOnly.m2, 230, "no geometry → the mesh area stands in for the slab");
  const strip = C.finishBuildUp({ id: "s", typeId: "strip_footings", qtys: { [fk("Edgeform >400mm deep", "m2")]: 20 }, blinding: { footing: { lengthM: 30, widthMm: 600 } } }); assert.deepEqual(strip.parts.map((p) => [p.key, p.m2]), [["top", 18]], "a footing's top only — its formed sides are not finished");
  const wall = C.finishBuildUp({ id: "w", typeId: "core_shear_wall", qtys: { [fk("Walls", "m2")]: 30, [fk("Edgeform", "m")]: 10 } }); assert.deepEqual(wall.parts.map((p) => [p.key, p.m2]), [["faces", 30]]);
  const col = C.finishBuildUp({ id: "c", typeId: "rc_columns", measureM2: 8, qtys: {} }); assert.equal(col.m2, 8);
  const susp = C.finishBuildUp({ id: "u", typeId: "suspended_slab", qtys: { [fk("Conventional", "m2")]: 50, [fk("Edgeform (suspended)", "m")]: 30 } }); assert.deepEqual(susp.parts.map((p) => [p.key, p.m2]), [["top", 50]], "a suspended slab: the top only — no edge faces");
});
check("Excavation is a quantity only (22 Oct 2026): a saved $50/m³ against its key still prices $0 on OTHER ALLOWANCES — the dig is costed on the crew sheet; Soil removal keeps its $/m³", () => {
  const C = costingAll; const excKey = rateKey("OTHER ALLOWANCES", "Excavation", "m3"), soilKey = rateKey("OTHER ALLOWANCES", "Soil removal", "m3");
  assert.ok(C.isQuantityOnlyKey(excKey) && !C.isQuantityOnlyKey(soilKey));
  const rates = { ...defaultRates(), [excKey]: { unitCost: 50 } };
  const item = { id: "e1", typeId: "strip_footings", category: "FOUNDATIONS", label: "Strip", qtys: { [excKey]: 22, [soilKey]: 28.2 }, tasks: [], additional: [] };
  assert.equal(C.rowRate(item, rates, excKey, { unitCost: 50 }).unitCost, 0, "rowRate answers $0 for the quantity-only key");
  const cost = C.computeElementCost(item, rates);
  assert.ok(Math.abs(cost.categoryTotals["OTHER ALLOWANCES"] - 28.2 * 40) < 1e-6, "only the soil removal is money on the band");
  assert.equal(C.labourQuantities(item, rates).excavationM3, 22, "…while the dig still drives the crew sheet");
});
check("blinding build-up on the crew sheet (22 Oct 2026): slab = area × depth, a beam = run × width × depth, each part its own tick; the total costs the CONCRETE blinding row while nothing is typed there, feeds the crew Blinding row and the poured volume; the master tick leaves it out", () => {
  const C = costingAll;
  const base = { id: "r1", typeId: "raft_foundation", category: "FOUNDATIONS", label: "Raft", qtys: {}, tasks: [{ id: "t1", name: "Blinding concrete", qtys: {} }, { id: "t2", name: "Pour concrete", qtys: {} }], additional: [],
    blinding: { slab: { areaM2: 200, tMm: 50 }, edge: { lengthM: 40, widthMm: 350, tMm: 50 }, internal: { lengthM: 20, widthMm: 400, tMm: 75 } } };
  const bu = C.blindingBuildUp(base);
  assert.deepEqual(bu.parts.map((p) => [p.key, p.on, p.m3]), [["slab", true, 10], ["edge", true, 0.7], ["internal", true, 0.6]]); assert.equal(bu.m3, 11.3);
  const rates = defaultRates();
  const auto = C.autoBlindingConcrete(base, rates); assert.ok(auto && auto.qty === 11.3 && auto.key === rateKey("CONCRETE", "Blinding concrete", "m3"), "the auto row");
  assert.equal(C.labourQuantities(base, rates).blindingM3, 11.3, "the crew Blinding row's Qty");
  assert.equal(C.taskRowMeta("Blinding concrete", C.labourQuantities(base, rates)).autoQty, 11.3);
  const off = { ...base, blinding: { ...base.blinding, edge: { ...base.blinding.edge, on: false } } };
  assert.equal(C.blindingBuildUp(off).m3, 10.6, "unticking the edge beams drops only their 0.7 m³");
  const typed = { ...base, qtys: { [auto.key]: 4 } }; assert.equal(C.autoBlindingConcrete(typed, rates), null, "a typed figure on the row takes it manual"); assert.equal(C.labourQuantities(typed, rates).blindingM3, 4);
  const cost = C.computeElementCost(base, rates), costOut = C.computeElementCost({ ...base, blindingIncluded: false }, rates);
  // 6 Nov 2026: the build-up's money lands on the BLINDING band's own key, never the CONCRETE band (the CONCRETE row carries no auto figure)
  assert.ok(Math.abs(cost.categoryTotals[C.BLINDING_BAND_KEY] - 11.3 * auto.unitCost) < 1e-6, "the build-up prices on the BLINDING band");
  assert.ok(cost.categoryTotals["CONCRETE"] < 11.3 * auto.unitCost, "the CONCRETE band carries only the Holcim fees on the poured m³, not the blinding"); assert.ok(cost.categoryTotals["CONCRETE"] > 0, "the fees still count the blinding as poured m³");
  assert.ok(Math.abs(cost.total - (cost.categoryTotals["CONCRETE"] + cost.categoryTotals[C.BLINDING_BAND_KEY] + cost.labourTotal)) < 1e-6, "the element total is the two bands plus labour");
  assert.equal(costOut.categoryTotals[C.BLINDING_BAND_KEY] || 0, 0); assert.equal(costOut.categoryTotals["CONCRETE"] || 0, 0); assert.ok(costOut.excludedBlinding >= 11.3 * auto.unitCost - 1e-6, "the master tick leaves the build-up out and states the money");
  const typedCost = C.computeElementCost(typed, rates); assert.equal(typedCost.categoryTotals[C.BLINDING_BAND_KEY] || 0, 0, "a typed CONCRETE row replaces the band's build-up — nothing lands on the band");
  // custom blinding rows (6 Nov 2026): typed by hand under "custom:<id>", counted with the parts, named, removable
  const withCustom = { ...base, blinding: { ...base.blinding, "custom:x1": { name: "Lift pit base", kind: "area", areaM2: 6, tMm: 100 }, "custom:x2": { kind: "run", lengthM: 10, widthMm: 500, tMm: 50 }, "custom:x3": { kind: "area", areaM2: 4, tMm: 50, on: false } } };
  assert.deepEqual(C.customBlindingParts(withCustom).map((p) => [p.key, p.label, p.kind]), [["custom:x1", "Lift pit base", "area"], ["custom:x2", "Custom blinding", "run"], ["custom:x3", "Custom blinding", "area"]]);
  const buC = C.blindingBuildUp(withCustom);
  assert.deepEqual(buC.parts.map((p) => [p.key, p.on, p.m3]), [["slab", true, 10], ["edge", true, 0.7], ["internal", true, 0.6], ["custom:x1", true, 0.6], ["custom:x2", true, 0.25], ["custom:x3", false, 0]], "the custom rows follow the defaults; the unticked one counts nothing");
  assert.equal(buC.m3, 12.15); assert.equal(C.autoBlindingConcrete(withCustom, rates).qty, 12.15, "the band prices the custom rows too"); assert.equal(C.labourQuantities(withCustom, rates).blindingM3, 12.15, "and the crew Qty reads them");
  assert.deepEqual(C.blindingBuildUp({ ...withCustom, typeId: "rc_columns" }).parts, [], "a custom row never gives a column blinding");
  const bb = fs.readFileSync(new URL("../src/components/BlindingBand.jsx", import.meta.url), "utf8");
  assert.ok(/data-testid="blinding-add-custom"/.test(bb) && /CUSTOM_BLINDING_PREFIX\}\$\{uid\(\)\}/.test(bb) && /blinding-\$\{part\.key\}-name/.test(bb) && /onRemovePart\(part\.key\)/.test(bb), "the band adds, names and removes a custom row");
  const cb = fs.readFileSync(new URL("../src/components/CategoryBlock.jsx", import.meta.url), "utf8");
  assert.ok(/const isAutoBlind = false/.test(cb) && /data-testid="blinding-on-band"/.test(cb) && /data-testid="blinding-typed-override"/.test(cb), "the CONCRETE row shows no auto figure, says the band prices it, and flags a typed override");
  // the parts follow what the element allows
  const partsOf = (typeId) => C.blindingPartsFor({ typeId }).map((p) => p.key);
  assert.deepEqual(partsOf("raft_foundation"), ["slab", "edge", "internal"]); assert.deepEqual(partsOf("slab_on_ground"), ["slab", "edge", "internal"]); assert.deepEqual(partsOf("driveway_hardstand"), ["slab", "edge", "internal"]);
  assert.deepEqual(partsOf("strip_footings"), ["footing"], "a strip has no slab"); assert.deepEqual(partsOf("edge_beam"), ["footing"]); assert.deepEqual(partsOf("capping_beam"), ["footing"]); assert.deepEqual(partsOf("retaining_wall"), ["footing"]);
  assert.deepEqual(partsOf("pile_caps_pad"), ["pad"]); assert.deepEqual(partsOf("stump_footings"), ["pad"]); assert.deepEqual(partsOf("kerbs_channels"), ["kerb"]); assert.deepEqual(partsOf("hearth_fireplace_base"), ["base"]); assert.deepEqual(partsOf("manhole_pit"), ["base"]);
  ["rc_columns", "core_shear_wall", "suspended_slab", "roof_slab_propped", "staircase", "piles_bored", "shotcrete_wall", "screed_bonded", "prelim_supervision", "excavation_bulk", "finish_polished"].forEach((t) => assert.deepEqual(partsOf(t), [], `${t} has no blinding`));
  const strip = { ...base, typeId: "strip_footings", blinding: { slab: { areaM2: 200, tMm: 50 }, footing: { lengthM: 30, widthMm: 600, tMm: 50 } } };
  assert.deepEqual(C.blindingBuildUp(strip).parts.map((p) => [p.key, p.m3]), [["footing", 0.9]], "a strip's build-up is its footing run only — a stray slab figure is ignored");
  assert.equal(C.autoBlindingConcrete({ ...base, typeId: "rc_columns" }, rates), null, "a column never blinds");
});
check("blinding concrete crosses the bridge (22 Oct 2026): Base/Blinding m³ lines under a slab and under each raft beam land on the CONCRETE 'Blinding concrete' row (the crew sheet's Blinding row reads it); a sand blinding line stays for a manual pick", () => {
  const { quote, flags } = buildImportFromEstimate({ project: { name: "Blinding" }, lines: [
    estLine({ elementId: "R", element: "Raft Slab 1", category: "Raft Slab", materialGroup: "Base/Blinding", material: "Blinding concrete N20", spec: "50mm", qty: 10, finalQty: 10.5, unit: "m³" }),
    estLine({ elementId: "R", element: "Raft Slab 1", category: "Raft Slab", materialGroup: "Base/Blinding", material: "Blinding concrete N20", spec: "Edge beam — 50mm × 350mm wide under the beam", qty: 0.7, finalQty: 0.735, unit: "m³", part: "beam" }),
    estLine({ elementId: "R", element: "Raft Slab 1", category: "Raft Slab", materialGroup: "Base/Blinding", material: "Sand blinding", spec: "50mm", qty: 2, finalQty: 2.1, unit: "m³" }),
  ], elementGeometry: {} });
  const key = rateKey("CONCRETE", "Blinding concrete", "m3");
  const got = quote.items.reduce((t, it) => t + (Number(it.qtys[key]) || 0), 0);
  assert.equal(Math.round(got * 1000) / 1000, 11.235, "slab + edge beam blinding on the Blinding concrete row");
  assert.ok((flags || []).some((f) => /Sand blinding/.test(f)), "the sand line is flagged, not silently dropped");
  const item = quote.items[0]; const lq = labourQuantities(item, defaultRates());
  assert.equal(Math.round(lq.blindingM3 * 1000) / 1000, 11.235, "…and the crew sheet's Blinding row sees the same m³");
});
check("formwork by face size (22 Oct 2026): an Estimates face under 400 mm arrives by the lineal metre and lands on 'Edgeform' (m); an edge-type face of 400 mm or more arrives in m² and lands on 'Edgeform >400mm deep' (m²); walls keep 'Walls'", () => {
  const { quote, flags } = buildImportFromEstimate({ project: { name: "Faces" }, lines: [
    estLine({ elementId: "F1", element: "Strip Footing 1", category: "Strip Footing", materialGroup: "Formwork", material: "Trench formwork", spec: "Selected faces — left side 300 mm, right side 300 mm — under 400 mm — lineal metres", qty: 24, finalQty: 25.2, unit: "m", faceMm: 300, m2Equiv: 7.2 }),
    estLine({ elementId: "F2", element: "Strip Footing 2", category: "Strip Footing", materialGroup: "Formwork", material: "Trench formwork", spec: "Selected faces — left side 600 mm", qty: 12, finalQty: 12.6, unit: "m²", faceMm: 600 }),
    estLine({ elementId: "W1", element: "Wall 1", category: "Concrete Wall / Core", materialGroup: "Formwork", material: "Wall formwork", spec: "Selected faces — face A 2700 mm", qty: 30, finalQty: 31.5, unit: "m²", faceMm: 2700 }),
  ], elementGeometry: {} });
  const sum = (key) => quote.items.reduce((t, it) => t + (Number(it.qtys[key]) || 0), 0);
  assert.equal(sum(rateKey("FORMWORK", "Edgeform", "m")), 25.2, "300 mm faces → Edgeform by the metre");
  assert.equal(sum(rateKey("FORMWORK", "Edgeform >400mm deep", "m2")), 12.6, "600 mm face → the over-400 m² row");
  assert.equal(sum(rateKey("FORMWORK", "Walls", "m2")), 31.5, "a wall face stays on Walls");
  assert.equal(sum(rateKey("FORMWORK", "Conventional", "m2")), 0, "nothing falls through to Conventional");
  assert.ok(importAll.isEdgeFaceLine({ materialGroup: "Formwork", material: "Side formwork", spec: "" }) && !importAll.isEdgeFaceLine({ materialGroup: "Formwork", material: "Column formwork", spec: "" }));
  assert.ok(!(flags || []).some((f) => /Strip Footing/.test(f)), "neither footing line is flagged");
});
check("rebates (19 Nov 2026): a rebate row runs along the slab perimeter, a beam's whole run or a typed length; run × number is its formwork, run × width × depth comes off the concrete; the bridge lands it on Edgeform", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const grab = (name, args) => { const m = new RegExp("function " + name + "\\(" + args + "\\)\\{[\\s\\S]*?\\n\\}").exec(est); assert.ok(m, name + " in estimates-app.html"); return m[0]; };
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fns = new Function("num", "fmt", 'const REBATE_MANUAL="manual";\n' + grab("rebateTargetOf", "r, targets") + "\n" + grab("rebateCalc", "r, targets") + "\n" + grab("rebateOutText", "c") + "\nreturn {rebateCalc, rebateOutText};")(num, (n, dp) => String(+Number(n).toFixed(dp === undefined ? 2 : dp)));
  const targets = [{ key: "perim", short: "slab perimeter", runM: 60 }, { key: "beam:edgeBeam", short: "Edge beam", runM: 40 }, { key: "manual", short: "typed length", runM: 0 }];
  let c = fns.rebateCalc({ on: "beam:edgeBeam", widthMm: 120, depthMm: 150 }, targets);
  assert.deepEqual([c.runM, +c.areaM2.toFixed(3), +c.volM3.toFixed(3), c.deduct, c.ok], [40, 10.8, 0.72, true, true], "the whole edge beam: 40 m, girth 270 mm, 0.72 m³");
  c = fns.rebateCalc({ widthMm: 120, depthMm: 150 }, targets); assert.equal(c.runM, 60, "no 'where' chosen = the first option (the slab perimeter)");
  c = fns.rebateCalc({ on: "perim", runM: 25, count: 2, widthMm: 100, depthMm: 100, deduct: false }, targets); assert.deepEqual([c.runM, c.typed, c.deduct], [50, true, false], "a typed run wins, × the number along it; the concrete tick can be cleared");
  c = fns.rebateCalc({ on: "manual", widthMm: 100, depthMm: 100 }, targets); assert.ok(!c.ok && /type the run/.test(fns.rebateOutText(c)), "a typed-length rebate with no run is not priced and says so");
  c = fns.rebateCalc({ on: "beam:gone", widthMm: 100, depthMm: 100 }, targets); assert.ok(!c.target && !c.ok, "a rebate whose beam was removed has no run");
  assert.ok(!fns.rebateCalc({ on: "perim" }, targets).any, "an untouched row is nothing");
  // the source: ONE target list, the table on three tabs, the pass order, never an array created on render
  assert.match(est, /out\.push\(\{key:"perim", label:"Slab — whole perimeter", short:"slab perimeter", runM:slabPerimM\(d\), tab:"form"\}\);\n\s*slabBeamsForFormwork\(d\)\.forEach/, "a slab offers its perimeter, then every beam switched on");
  assert.match(est, /else if\(def\.calc==="beam"\)\{\n\s*out\.push\(\{key:"run", label:"Entire beam length"/, "a beam offers its whole length");
  assert.match(est, /out\.push\(\{key:REBATE_MANUAL, label:"Typed length"/, "every element takes a typed length");
  assert.match(est, /parts\.form = formworkSystemSelect\(inst\.data\) \+ parts\.form \+ rebateSection\(inst,"form"\);/, "the table closes every Formwork tab");
  assert.match(est, /if\(parts\.edgebeams!==undefined\) parts\.edgebeams \+= rebateSection\(inst,"edgebeams"\);/, "…and the slab's Edge Beams tab");
  assert.match(est, /if\(parts\.intbeams!==undefined\) parts\.intbeams \+= rebateSection\(inst,"intbeams"\);/, "…and its Internal Beams tab");
  assert.match(est, /applyConcreteOverride\(inst,def,out\);[^\n]*\n\s*applyRebates\(inst,def,out\);[^\n]*\n\s*if\(reoMethodOf\(inst\.data\)==="rate"\)/, "rebates run after a concrete override and before a steel rate reads the concrete");
  assert.match(est, /const d=inst\.data, rows=rebateRows\(d\), targets=rebateTargets\(inst\);/, "the table never creates the array on render");
  assert.match(est, /formworkLines\(inst,def,\{material:"Rebate formwork"/, "rebate formwork goes through formworkLines (lineal metres under 400 mm)");
  assert.match(est, /if\(!c\.deduct \|\| num\(d\.concVolOverride\)>0\) return;/, "a measured concrete volume stands as typed");
  assert.match(est, /const line=\(c\.target\.concSpec && own\.find\(l=>l\.spec===c\.target\.concSpec\)\) \|\| own\[0\];/, "a beam's rebate comes off that beam's concrete line");
  assert.match(est, /refreshExtraConnCount\(card,inst,f\); refreshRebateRows\(card,inst,f\); refreshInsVertRows\(card,inst,f\); refreshEdgeThickenRows\(card,inst,f\); refreshOpeningRows\(card,inst,f\); return; \}/, "the Result cell follows the typing");
  // the bridge
  const { quote, flags } = buildImportFromEstimate({ project: { name: "Rebates" }, lines: [
    estLine({ elementId: "R1", element: "Raft Slab 1", category: "Raft Slab", materialGroup: "Formwork", material: "Rebate formwork", spec: "Brick rebate — 120 wide × 150 deep — Edge beam — rebate, larger face 150 mm — under 400 mm — lineal metres", qty: 40, finalQty: 42, unit: "m", faceMm: 150, m2Equiv: 10.8 }),
    estLine({ elementId: "R1", element: "Raft Slab 1", category: "Raft Slab", materialGroup: "Formwork", material: "Rebate formwork", spec: "Deep set-down — 200 wide × 450 deep — slab perimeter — rebate, larger face 450 mm", qty: 39, finalQty: 40.95, unit: "m²", faceMm: 450 }),
  ], elementGeometry: {} });
  const sum = (key) => quote.items.reduce((t, it) => t + (Number(it.qtys[key]) || 0), 0);
  assert.equal(sum(rateKey("FORMWORK", "Edgeform", "m")), 42, "a rebate under 400 mm lands on Edgeform by the metre");
  assert.equal(sum(rateKey("FORMWORK", "Edgeform >400mm deep", "m2")), 40.95, "a 450 mm rebate lands on the over-400 m² row");
  assert.ok(!(flags || []).some((f) => /rebate/i.test(f)), "neither rebate line is flagged");
});
check("retaining wall parameters (19 Nov 2026): a core-filled blockwork stem at the CMAA's published grout volumes, the thicker lower section (H4), Y starters, stem bars on one face or two, footing mesh, agi drain, battered backfill; distribution bars counted across the footing", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  // the published figures (CMAA CM01 Concrete Masonry Handbook 2019, section 7) — pinned so they are never retyped from memory
  const m = /const RET_BLOCKS=\[([\s\S]*?)\];/.exec(est); assert.ok(m, "RET_BLOCKS");
  const blocks = [...m[1].matchAll(/\{key:"([\d.]+)", label:"[^"]*", mm:(\d+), grout:([\d.]+)\}/g)].map((x) => [x[1], +x[2], +x[3]]);
  assert.deepEqual(blocks, [["15.01", 140, 0.054], ["20.01", 190, 0.083], ["20.48", 190, 0.1], ["30.48", 290, 0.18]], "grout to fill 1 m² of wall, by block");
  assert.match(est, /const BLOCKS_PER_M2=12\.5;/, "12.5 blocks per m²");
  assert.match(est, /CM01 Concrete Masonry\s*\n?\s*\*? ?Handbook, 2019/, "the source is stated beside the figures");
  // the geometry out of the page source
  const grab = (name, args) => { const mm = new RegExp("function " + name + "\\(" + args + "\\)\\{[\\s\\S]*?\\n\\}").exec(est); assert.ok(mm, name + " in estimates-app.html"); return mm[0]; };
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fns = new Function("num", "elevGeom", m[0] + "\n" + /function retBlock\(key,dflt\)\{[^\n]*\}/.exec(est)[0] + "\n" + /function retIsBlock\(d\)\{[^\n]*\}/.exec(est)[0] + "\n" + /function retStemFaces\(d\)\{[^\n]*\}/.exec(est)[0] + "\n" + grab("retStemGeom", "d") + "\nreturn {retStemGeom, retStemFaces};")(num, () => null);
  const r3 = (x) => +x.toFixed(3);
  let g = fns.retStemGeom({ length: 10000, stemH: 1600, stemType: "block", blockUpper: "15.01", blockLower: "20.01", stemLowerH: 600, footL: 1000 });
  assert.deepEqual([r3(g.area), r3(g.upperArea), r3(g.lowerArea), r3(g.groutVol), g.T, g.Tlow], [16, 10, 6, 1.038, 0.14, 0.19], "RW1 1201–1600: 10 m² of 140 over 6 m² of 190 → 1.038 m³ of core fill");
  g = fns.retStemGeom({ length: 10000, stemH: 1600, stemType: "block", blockUpper: "15.01", blockLower: "20.01", stemLowerH: 600, coreFillPct: 50, groutUpperM2: 0.06 });
  assert.equal(r3(g.groutVol), 0.549, "half the cores, a typed supplier figure on the upper block");
  g = fns.retStemGeom({ length: 10000, stemH: 2400, stemT: 250 });
  assert.deepEqual([r3(g.stemVol), g.block, g.lowerArea, r3(g.groutVol)], [6, false, 0, 0], "a wall saved before this — in-situ, one section, 10 × 2.4 × 0.25");
  g = fns.retStemGeom({ length: 10000, stemH: 2400, stemT: 250, stemLowerH: 800, stemLowerT: 400 });
  assert.equal(r3(g.stemVol), 7.2, "in-situ with an 800 × 400 base section: 10 × (1.6 × 0.25 + 0.8 × 0.4)");
  g = fns.retStemGeom({ stemShape: "stepped", stemT: 200, stemLowerH: 500, stemLowerT: 300, segL1: 4000, segH1: 2000, segL2: 6000, segH2: 400 });
  assert.equal(r3(g.stemVol), r3(4 * (1.5 * 0.2 + 0.5 * 0.3) + 6 * (0.4 * 0.3)), "stepped: each segment's lower part is capped at its own height");
  assert.deepEqual([fns.retStemFaces({}), fns.retStemFaces({ stemType: "block" }), fns.retStemFaces({ stemType: "block", stemReoFaces: "2" }), fns.retStemFaces({ stemReoFaces: "1" })], [2, 1, 2, 1], "bars on two faces in-situ and one in blockwork unless chosen");
  // the pricing source
  assert.match(est, /let stemVol = incStem\? \(g\.block\? g\.groutVol : g\.stemVol\) : 0;/, "a blockwork stem's concrete is its core fill");
  assert.match(est, /spec:"Footing \+ key \(blockwork stem\)"/, "the footing is its own pour under a blockwork stem");
  assert.match(est, /materialGroup:"Masonry",material:`Blockwork \$\{b\.mm\} mm \(\$\{b\.key\}\)`/, "the blockwork is listed by width");
  assert.match(est, /let stemFormed = incStem && !g\.block;/, "blockwork is never formed");
  assert.match(est, /if\(!baseOff && incStem && d\.waterstop && !g\.block\) lines\.push\(/, "no waterstop under blockwork");
  assert.match(est, /let yBars = !baseOff && !!d\.yOn;/, "Y starters belong to the base");
  assert.match(est, /lapIn=yBars\? 0 : 0\.4;/, "with Y starters the stem bars carry no lap into the footing");
  assert.match(est, /two && !yBars\? "Stem vertical bars \(both faces, incl\. lap into footing\)"/, "an older wall's vertical-bar spec (its override key) is unchanged");
  assert.match(est, /if\(d\.footBotYOn!==false\) bars\(d\.footBotY,d\.footBotYSp,Lm,"Footing bottom Y bars \(distribution\)",d\.footBotYLap,footW\);/, "distribution bars are spaced across the footing width");
  assert.match(est, /bars\(d\.footTopY\|\|"N16",num\(d\.footTopYSp,200\),Lm,"Footing top Y bars \(distribution\)",d\.footTopYLap,footW\);/, "…top mat too");
  assert.match(est, /let backfillVol=Lm\*bfD\*\(bfW\+bfB\*bfD\/2\);/, "the backfill wedge");
  assert.match(est, /material:`Backfill \(behind wall\)\$\{d\.backfillMat\?` — \$\{d\.backfillMat\}`:""\}`/, "the backfill keeps its name's lead, so excluding excavation still removes it");
  assert.match(est, /materialGroup:"Drainage",material:"Agi drain pipe"/, "the agi drain is a line of its own");
  assert.match(est, /spec:`Footing mesh — sheets ×\$\{n\} layer\(s\)`/, "the footing mesh");
});
await checkAsync("Scope finder (19 Nov 2026): the reading rules, the reply parser with stable ids, the server's refusals, the checklist's merge / compare / progress, and its place in Estimates — its own row, never the takeoff", async () => {
  const SF = await import("../src/lib/scopeFinder.js");
  const E = await import("../api/ai-engine.js");
  const types = [{ id: "stripfooting", label: "Strip Footing", group: "Foundations" }, { id: "column", label: "Column", group: "Vertical" }];
  // the prompt holds the three rules
  const prompt = SF.scopePrompt({ projectName: "12 Beach Rd", types, hasDocuments: true, text: "=== NOTE — chat ===\nscrew piles by others" });
  assert.match(prompt, /Never write a dimension, grade, bar size, spacing, cover or finish that is not on the documents/, "a specification is only what is written");
  assert.match(prompt, /"gaps" are QUESTIONS, never findings of fact/, "a gap is a question");
  assert.match(prompt, /Scope asked for or changed in an EMAIL or MESSAGE counts exactly as a drawing does/, "emails and chats count as drawings do");
  assert.match(prompt, /stripfooting = Strip Footing \(Foundations\)/, "the element types are offered by id");
  assert.match(prompt, /PASTED EMAILS, MESSAGES AND NOTES\n=== NOTE — chat ===/, "the pasted text rides at the end");
  assert.ok(!/PASTED EMAILS/.test(SF.scopePrompt({ projectName: "x", types, hasDocuments: true })), "no text section when nothing was pasted");
  // the parser
  const raw = { items: [
    { title: "Strip footings SF1", category: "footings", type: "stripfooting", specs: ["N32", " 450 × 300 "], basis: "stated", party: "ours", doc: "S-01", page: 2, quote: "SF1 450x300", confidence: 1.4 },
    { title: "strip  footings sf1", category: "footings", type: "stripfooting", specs: ["N32", "50 cover"] },
    { title: "Mystery", category: "nonsense", type: "madeup", basis: "implied", because: "detail 5", party: "unclear" },
    { title: "", category: "footings" }, null ],
    gaps: [{ title: "Low one", severity: "low" }, { title: "High one", severity: "high", basis: "practice" }, { title: "High one", severity: "high" }],
    exclusions: ["Piles by others", { text: "Pump by builder", doc: "email" }], questions: ["Issue S-05?", ""], documents: [{ name: "S-01.pdf", kind: "structural drawings" }], unreadable: ["S-09 blurred"] };
  const r = SF.parseScopeResult(raw, { types });
  assert.equal(r.items.length, 2, "blank and null entries are dropped; the same item twice is one");
  assert.deepEqual(r.items[0].specs, ["N32", "450 × 300", "50 cover"], "a repeat's new specification joins the first");
  assert.deepEqual([r.items[0].type, r.items[0].page, r.items[0].confidence, r.items[0].basis, r.items[0].party], ["stripfooting", "2", 1, "stated", "ours"]);
  assert.deepEqual([r.items[1].category, r.items[1].type, r.items[1].basis, r.items[1].party, r.items[1].because], ["other", null, "implied", "unclear", "detail 5"], "an unknown category is 'other' and a type that was not offered is dropped");
  assert.equal(r.items[0].id, SF.scopeId("sc_", "footings", "STRIP FOOTINGS — SF1"), "the id is a hash of category and title, whatever the spelling — a tick survives the next read");
  assert.equal(SF.parseScopeResult(raw, { types }).items[0].id, r.items[0].id, "…and is the same on every run");
  assert.deepEqual(r.gaps.map((g) => [g.title, g.severity, g.basis]), [["High one", "high", "practice"], ["Low one", "low", "documents"]], "gaps are deduped and the costly ones come first");
  assert.deepEqual([r.exclusions.length, r.exclusions[1].doc, r.questions.length, r.unreadable.length], [2, "email", 1, 1]);
  assert.equal(SF.parseScopeResult({ items: [], gaps: [] }), null, "an empty reply is nothing");
  assert.equal(SF.parseScopeResult(null), null);
  // what one request may carry
  assert.match(SF.scopeRequestError({ files: [], text: " " }), /Nothing to read/);
  assert.match(SF.scopeRequestError({ files: Array.from({ length: 13 }, (_, i) => ({ url: `https://x.co/${i}.pdf` })) }), /At most 12 files/);
  assert.match(SF.scopeRequestError({ files: [{ url: "https://x.co/a.docx", name: "a.docx" }] }), /Not a PDF or an image/);
  assert.match(SF.scopeRequestError({ files: [{ url: "http://x.co/a.pdf" }] }), /Not a PDF or an image/, "https only");
  assert.match(SF.scopeRequestError({ text: "x".repeat(SF.SCOPE_MAX_TEXT_CHARS + 1) }), /nothing is cut off silently/, "over-long text is refused, never truncated");
  assert.equal(SF.scopeRequestError({ files: [{ url: "https://x.co/a.PDF?x=1" }, { url: "https://x.co/chat.jpeg" }], text: "" }), null);
  assert.deepEqual([SF.scopeFileKind("https://x.co/a.pdf"), SF.scopeFileKind("https://x.co/a.webp"), SF.scopeFileKind("https://x.co/a.dwg")], ["pdf", "image", null]);
  // the server
  assert.equal((await E.runAiJob({ action: "scope" }, {})).status, 400, "nothing to read → 400");
  assert.equal((await E.runAiJob({ action: "scope", files: [{ url: "https://x.co/a.docx" }] }, {})).status, 400);
  const noProv = await E.runAiJob({ action: "scope", text: "the builder asks for a slab" }, {});
  assert.equal(noProv.status, 503, "text alone may be read; with no provider configured it is a 503, never a made-up list");
  assert.match((await E.runAiJob({ action: "nope" }, {})).body.error, /"scope"/, "the action list names scope");
  const prov = fs.readFileSync(new URL("../api/_providers.js", import.meta.url), "utf8");
  assert.match(prov, /d\.kind === "image"\s*\n\s*\? \{ type: "image", source: \{ type: "url", url: d\.url \} \}/, "a screenshot goes to Claude as an image block read by URL");
  assert.match(prov, /d\.kind === "image" \? \{ type: "input_image", image_url: d\.url \} : \{ type: "input_file", file_url: d\.url \}/, "…and to OpenAI as an input_image");
  // the checklist's own logic (the pure module the page inlines)
  const box = { console }; box.globalThis = box;
  runInNewContext(fs.readFileSync(new URL("../portal/estimates-scope.js", import.meta.url), "utf8"), box, { filename: "estimates-scope.js" });
  assert.equal(box.SCOPE_TEXT_MAX_CHARS, SF.SCOPE_MAX_TEXT_CHARS, "the page and the server agree on the text limit");
  assert.equal(box.SCOPE_FILES_PER_RUN, SF.SCOPE_MAX_FILES, "…and on the files per read");
  assert.equal(box.scopeDocKey("proj_1"), "gradcon-scope::proj_1");
  const res1 = SF.parseScopeResult({ items: [{ title: "Strip footings SF1", category: "footings", type: "stripfooting", specs: ["N32"] }, { title: "Columns C1", category: "vertical", type: "column" }, { title: "Vapour barrier", category: "waterproofing" }, { title: "Screw piles", category: "piling", type: "column", party: "others" }], gaps: [{ title: "No drainage shown", severity: "high" }] }, { types });
  const res2 = SF.parseScopeResult({ items: [{ title: "Strip footings SF1", category: "footings", type: "stripfooting", specs: ["50 cover"], doc: "S-02" }, { title: "Stair", category: "stairs" }], gaps: [{ title: "No drainage shown", severity: "high" }] }, { types });
  const merged = box.mergeScopeResult(res1, res2);
  assert.equal(merged.items.length, 5, "a second read ADDS: known items stay, new ones are appended");
  assert.deepEqual(JSON.parse(JSON.stringify(merged.items[0].specs)), ["N32", "50 cover"], "a known item gains the new specification");
  assert.equal(merged.items[0].doc, "S-02", "…and a source it lacked");
  assert.equal(merged.gaps.length, 1, "the same gap is listed once");
  const inst = [{ id: "EL01", label: "Strip Footing 1", typeKey: "stripfooting" }, { id: "EL02", label: "Raft Slab 1", typeKey: "raftslab" }];
  const cmp = box.scopeCompareToTakeoff(res1.items, inst, { stripfooting: { label: "Strip Footing" }, raftslab: { label: "Raft Slab" } });
  assert.deepEqual(res1.items.map((it) => cmp.byItem[it.id].state), ["on", "off", "na", "others"], "on the takeoff / in the documents and not on it / a work item is not compared / by others is never 'off'");
  assert.deepEqual(JSON.parse(JSON.stringify(cmp.unmatched.map((u) => u.id))), ["EL02"], "takeoff elements no scope item accounts for");
  const fid = res1.items[0].id, gid = res1.gaps[0].id;
  let doc = box.normalizeScopeDoc({ result: res1 }, "proj_1", "X");
  let p = box.scopeProgress(doc, cmp);
  assert.deepEqual([p.total, p.done, p.others, p.gapsOpen, p.highOpen, p.offTakeoff, p.complete], [3, 0, 1, 1, 1, 1, false]);
  doc.review = box.scopeReviewPatch(doc, fid, { state: "done" }, "boma", "2026-11-19T01:00:00Z");
  doc.review = box.scopeReviewPatch(doc, res1.items[1].id, { state: "na" }, "boma", "2026-11-19T01:00:00Z");
  doc.review = box.scopeReviewPatch(doc, res1.items[2].id, { state: "done" }, "boma", "2026-11-19T01:00:00Z");
  doc.review = box.scopeReviewPatch(doc, gid, { state: "done" }, "boma", "2026-11-19T01:00:00Z");
  p = box.scopeProgress(doc, cmp);
  assert.deepEqual([p.done, p.gapsOpen, p.offTakeoff, p.complete], [3, 0, 0, true], "ticked or not-applicable settles a row; an N/A item is no longer 'not on the takeoff'");
  assert.ok(!(fid in box.scopeReviewPatch(doc, fid, { state: "" }, "boma")), "clearing a tick with no note removes the entry");
  // two copies of the document: ticks by time, lists by id less the removals, the reading unioned
  const a = Object.assign(box.normalizeScopeDoc({ result: res1 }, "proj_1", "X"), { updatedAt: "2026-11-19T02:00:00Z", files: [{ id: "f1", name: "a.pdf" }, { id: "f2", name: "b.pdf" }], review: { [fid]: { state: "done", at: "2026-11-19T02:00:00Z", by: "boma" } }, removed: {} });
  const b = Object.assign(box.normalizeScopeDoc({ result: res2 }, "proj_1", "X"), { updatedAt: "2026-11-19T03:00:00Z", files: [{ id: "f1", name: "a.pdf" }, { id: "f3", name: "c.pdf" }], review: { [fid]: { state: "na", at: "2026-11-19T01:00:00Z", by: "grady" }, [gid]: { state: "done", at: "2026-11-19T03:00:00Z", by: "grady" } }, removed: { f2: "2026-11-19T02:30:00Z" } });
  const m = box.mergeScopeDocs(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(m.files.map((f) => f.id).sort())), ["f1", "f3"], "a file removed on one device does not come back from the other");
  assert.equal(m.review[fid].state, "done", "the later tick wins, whichever copy is newer overall");
  assert.equal(m.review[gid].by, "grady");
  assert.equal(m.result.items.length, 5, "both devices' readings are kept");
  assert.deepEqual(JSON.parse(JSON.stringify([box.scopeFileClass("a.pdf", "", 10).kind, box.scopeFileClass("chat.PNG", "", 10).kind, box.scopeFileClass("mail.eml", "", 10).kind, box.scopeFileClass("x.msg", "", 10).kind, box.scopeFileClass("a.pdf", "", 0).kind])), ["pdf", "image", "text", null, null]);
  assert.match(box.scopeFileClass("plan.dwg", "", 10).error, /export the sheets to PDF/);
  assert.match(box.scopeRunText([{ kind: "email", name: "RE: scope", from: "sam", date: "2026-11-12T03:00:00Z", text: "hi" }, { kind: "paste", name: "chat", text: "yo" }, { kind: "paste", text: " " }]), /^=== EMAIL — RE: scope — from sam — 2026-11-12 ===\nhi\n\n=== NOTE — chat ===\nyo$/, "every text is sent under a header naming it; a blank one is left out");
  assert.equal(box.scopeTextFromFile("a.html", "<html><style>x{}</style><p>Hello&nbsp;<b>there</b></p></html>").replace(/\s+/g, " "), "Hello there");
  // its place in Estimates
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  assert.match(est, /<script src="estimates-scope\.js"><\/script>/, "the page loads the pure module");
  assert.match(fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8"), /estimates-app\.html no longer loads estimates-scope\.js — inline step out of date/, "…and the assembler inlines it, asserted");
  assert.match(est, /id="scopeBtn" type="button" data-testid="scope-button"/, "the header button");
  assert.match(est, /\nscopeInit\(\);\n/, "the panel is wired at boot");
  const cats = JSON.parse(/const SCOPE_CATS=(\[\[[\s\S]*?\]\]);/.exec(est)[1]);
  assert.deepEqual(cats, SF.SCOPE_CATEGORIES, "the page's category list mirrors the reader's");
  assert.ok(!/scope/i.test(/function estimateStateSnapshot\(\)\{[\s\S]*?\n\}/.exec(est)[0]), "the checklist is never part of the takeoff snapshot");
  const ui = est.slice(est.indexOf("/* ===================== SCOPE FINDER"), est.indexOf("scopeInit();\napplyAiHandoff();"));
  assert.equal((ui.match(/addInstance\(/g) || []).length, 1, "the ONE place the Scope finder changes the takeoff is the estimator's own Add click");
  assert.ok(!/saveEstimateState\(|pushTakeoffToCloud\(/.test(ui), "it never saves or pushes the takeoff itself");
  assert.match(ui, /const merged = row && row\.value\? mergeScopeDocs\(local, row\.value\) : local;/, "its cloud write is read → merge → write");
  assert.match(ui, /if\(kvFetchFailed\(row\)\) return;/, "a cloud read that fails is never read as 'no row'");
  assert.match(ui, /res\.status===402\? "The app's hosting has been switched off by Vercel/, "a switched-off server is said in those words");
  assert.match(ui, /nothing is cut off silently/, "over-long text is refused in the page too");
  // the bar-set table fits (19 Nov 2026: "DETAILS CUT towards the right")
  assert.match(est, /\.pane\[data-pane="edgebeams"\] > \.pane-body,\.pane\[data-pane="intbeams"\] > \.pane-body\{flex-direction:column;\}/, "the slab's beam tabs stack the sketch under the fields");
  assert.match(est, /table\.rows\.barsets select\{max-width:150px;\}/, "the anchorage selects are capped");
  assert.equal((est.match(/class="rows barsets"/g) || []).length, 2, "both bar-set tables carry the class");
});
await checkAsync("Scope finder reads a long set IN PARTS (20 Nov 2026 — five drawings in one read were cut off at 45 items and the 'possibly missing' list was lost): a reply lists a bounded number of items and says when more remain, a continuation is told what is already listed, a cut-off part keeps its items and asks for the rest, and a read that could not finish offers 'Finish the read'", async () => {
  const SF = await import("../src/lib/scopeFinder.js");
  assert.ok(SF.SCOPE_ITEMS_PER_REPLY >= 20 && SF.SCOPE_ITEMS_PER_REPLY <= 45, "one reply stays well inside the output limit");
  const first = SF.scopePrompt({ projectName: "x", types: [], hasDocuments: true });
  assert.match(first, new RegExp(`List at most ${SF.SCOPE_ITEMS_PER_REPLY} items in this reply`), "the reply is bounded");
  assert.match(first, /set "more": true and leave "gaps", "references", "exclusions" and "questions" out/, "an unfinished part carries no gaps — they belong to the last one");
  assert.match(first, /set "more": false and give the "gaps", "references", "exclusions" and "questions" for the WHOLE set/, "the last part answers for the whole set");
  assert.ok(!/ALREADY LISTED/.test(first), "a first part names nothing as already listed");
  assert.match(first, /"more": boolean/, "the shape carries the flag");
  assert.ok(!/"confidence"/.test(first), "the reply is compact: no confidence figure is asked for");
  const cont = SF.scopePrompt({ projectName: "x", types: [], hasDocuments: true, already: ["Strip footings SF1", " strip footings sf1 ", "Raft slab", "", null] });
  assert.match(cont, /ALREADY LISTED — earlier replies listed these 2 items\. Do NOT repeat them/, "a continuation is told what is listed (deduped, blanks dropped)");
  assert.match(cont, /\n- Strip footings SF1\n- Raft slab\n/);
  assert.match(cont, /counting the items already listed below as part of it/, "the gaps of the last part cover the earlier parts' items too");
  assert.equal(SF.scopeAlreadyList(Array.from({ length: 900 }, (_, i) => `Item ${i}`)).length, SF.SCOPE_MAX_ALREADY, "the list is capped");
  assert.deepEqual(SF.scopeAlreadyList("nope"), []);
  // the parser
  assert.equal(SF.parseScopeResult({ items: [{ title: "A", category: "footings" }], more: true }).more, true);
  assert.equal(SF.parseScopeResult({ items: [{ title: "A", category: "footings" }] }).more, false, "no flag = the list is complete (an older reply)");
  const none = SF.parseScopeResult({ items: [], more: false });
  assert.ok(none && none.items.length === 0 && none.more === false, "a continuation with nothing new is an answer, not an unreadable reply");
  assert.equal(SF.parseScopeResult({ items: [] }), null, "…while a reply with nothing and no flag is still nothing");
  // the server
  const eng = fs.readFileSync(new URL("../api/ai-engine.js", import.meta.url), "utf8");
  assert.match(eng, /const already = scopeAlreadyList\(body\.already\);\s*\n\s*const prompt = scopePrompt\(\{ projectName, types: sTypes, hasDocuments: sFiles\.length > 0, text, already \}\);/, "the request's already-listed titles reach the prompt");
  assert.match(eng, /raw = \{ \.\.\.got, more: true \};/, "a cut-off part keeps its complete items and asks for the rest");
  assert.match(eng, /body: \{ result, more: result\.more === true,/, "the reply says whether more remain");
  assert.match(eng, /maxTokens: 16000, env, cacheDocuments: true \}/, "the documents are cached across the parts");
  const prov = fs.readFileSync(new URL("../api/_providers.js", import.meta.url), "utf8");
  assert.match(prov, /cacheDocuments && i === documents\.length - 1 \? \{ cache_control: \{ type: "ephemeral" \} \} : \{\}/, "the cache breakpoint sits on the last document");
  // the page
  const box = { console }; box.globalThis = box;
  runInNewContext(fs.readFileSync(new URL("../portal/estimates-scope.js", import.meta.url), "utf8"), box, { filename: "estimates-scope.js" });
  assert.ok(box.SCOPE_MAX_PARTS * SF.SCOPE_ITEMS_PER_REPLY >= SF.SCOPE_MAX_ITEMS, "the parts allowed cover the longest list the reader keeps");
  const doc = { result: { items: [{ title: "A" }, { title: "" }, { title: "B" }] }, runs: [{ at: "1", partial: null }] };
  assert.deepEqual(JSON.parse(JSON.stringify(box.scopeAlreadyTitles(doc))), ["A", "B"]);
  assert.equal(box.scopeLastReadPartial(doc), false);
  assert.equal(box.scopeLastReadPartial({ runs: [{ partial: null }, { partial: "The reply was cut off at the model's output limit" }] }), true, "the newest read decides");
  assert.equal(box.scopeLastReadPartial({ runs: [{ partial: "cut" }, { partial: null }] }), false, "a later complete read clears it");
  assert.equal(box.scopeLastReadPartial({}), false);
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const run = est.slice(est.indexOf("async function scopeRun(all, resume){"), est.indexOf("function scopeSetState(id, state)"));
  assert.match(run, /while\(more && part<SCOPE_MAX_PARTS\)\{/, "the page keeps asking while more remain, up to the parts allowed");
  assert.match(run, /files:setFiles, text:setText, already \}/, "every part carries the already-listed titles");
  assert.match(run, /more = r\.body\.more===true && gained>0;/, "a part that adds nothing ends the read");
  assert.match(run, /let already = resume\? scopeAlreadyTitles\(doc\) : \[\]/, "'Finish the read' starts from the checklist's own titles");
  assert.match(run, /scopeSave\(\);\s*\n\s*\}\s*\n\s*if\(failed\) break;/, "every part is saved as it lands");
  assert.match(est, /scopeLastReadPartial\(doc\) && !SCOPE\.busy\? `<p class="small sc-err" data-testid="scope-partial-note">/, "a cut-off read is said on the panel");
  assert.match(est, /data-scope-act="runfinish" data-testid="scope-run-finish"/, "…with the button that finishes it");
  assert.match(est, /else if\(act==="runfinish"\) scopeRun\(true, true\);/);
  assert.ok(!/Run again with fewer documents/.test(eng + est), "the estimator is never told to re-run with fewer documents");
});
await checkAsync("Scope finder scans the project's own emails and Drive folder (20 Nov 2026 — Boma: 'automatically scan email box for that project and also the project folder in drive … a checkbox to select scopes from emails only or drive only or both and clearly itemise the found scope mentions and directions on where and how to find the requested scope document references'): every mention is kept with where it came from, the source ticks filter the checklist, and a referred-to document says where it is and how to get it", async () => {
  const SF = await import("../src/lib/scopeFinder.js");
  // the reader
  const prompt = SF.scopePrompt({ hasDocuments: true, text: "x", types: [{ id: "stripfooting", label: "Strip Footing" }] });
  assert.match(prompt, /"via": "email"\|"document"/, "every item says whether an email or a document asks for it");
  assert.match(prompt, /"also":/, "…and every OTHER place that mentions it");
  assert.match(prompt, /"references":/, "the documents the scope refers to are listed");
  assert.ok(SF.SCOPE_RESULT_KEYS.includes("references"), "a cut-off reply keeps its references");
  assert.equal(SF.viaOf("email", "anything"), "email");
  assert.equal(SF.viaOf(null, "Email — RE: 12 Beach Rd"), "email", "a source headed as an email is an email");
  assert.equal(SF.viaOf(null, "S-01 Structural.pdf"), "document");
  const parsed = SF.parseScopeResult({
    items: [{ title: "Strip footings SF1", category: "footings", doc: "S-01.pdf", page: "2", quote: "SF1 450W", via: "document", also: [{ doc: "Email — RE: scope", quote: "price the footings", via: "email" }, { doc: "S-01.pdf", page: "2", quote: "SF1 450W" }] }],
    gaps: [], exclusions: [], questions: [],
    references: [{ ref: "Detail 7/S-05", kind: "detail", doc: "S-01.pdf", page: "2", quote: "REFER DETAIL 7/S-05", found: null }, { ref: "detail 7/s-05", doc: "Email — RE: scope", quote: "see 7/S-05", via: "email" }, { ref: "Geotech report", kind: "report", doc: "S-01.pdf", found: { doc: "Soil.pdf", page: "1" } }, { ref: "" }] }, { types: ["stripfooting"] });
  const it = parsed.items[0];
  assert.equal(it.via, "document");
  assert.deepEqual(it.mentions.map((m) => m.via), ["document", "email"], "the same mention twice is one; the email's is kept beside the drawing's");
  assert.equal(parsed.references.length, 2, "the same reference cited twice is one reference, a blank one is dropped");
  assert.equal(parsed.references[0].cited.length, 2, "…with both places that cite it");
  assert.equal(parsed.references[0].kind, "detail");
  assert.deepEqual(parsed.references[1].found, { doc: "Soil.pdf", page: "1" });
  assert.ok(parsed.references.every((r) => /^rf_/.test(r.id)), "reference ids are stable across reads");
  // the page's pure module
  const box = { console }; box.globalThis = box;
  runInNewContext(fs.readFileSync(new URL("../portal/estimates-scope.js", import.meta.url), "utf8"), box, { filename: "estimates-scope.js" });
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.equal(box.scopeMailQuery("12 Beach Road, Rye VIC 3941 — Pool house"), '"12 Beach Road"', "the mailbox is searched for the street as an exact phrase");
  assert.equal(box.scopeMailQuery(""), "", "no name, no search");
  assert.equal(box.scopeDriveClass("S-01 Structural.pdf", "").key, box.scopeDriveClass("anything.pdf", "Structural").key, "a file is classed by its name or its folder");
  assert.ok(box.scopeDriveClass("Civiltest soil report.pdf", ""), "a soil report is a known class");
  assert.equal(box.scopeDriveClass("site photo.jpg", ""), null);
  assert.equal(box.scopeDriveReadable({ kind: "sheet", name: "Budget.xlsx" }), false, "a spreadsheet is not read");
  const files = [{ id: "a", name: "site photo.jpg", kind: "image" }, { id: "b", name: "S-01 Structural.pdf", kind: "pdf" }, { id: "c", name: "Budget.xlsx", kind: "sheet" }, { id: "d", name: "Soil report.pdf", kind: "pdf" }];
  assert.deepEqual(plain(box.scopeDriveAutoPick(files)).sort(), ["b", "d"], "drawings and reports are ticked, a photo and a spreadsheet are not");
  assert.equal(box.scopeDriveAutoPick(Array.from({ length: 30 }, (_, i) => ({ id: "f" + i, name: `S-${i} Structural.pdf`, kind: "pdf" }))).length, box.SCOPE_DRIVE_AUTO_MAX, "the automatic tick is capped");
  // the source ticks as a filter
  const both = { mentions: [{ doc: "S-01.pdf", via: "document" }, { doc: "Email — x", via: "email" }] }, onlyDoc = { doc: "S-01.pdf", quote: "q", via: "document" }, onlyMail = { doc: "Email — x", quote: "q", via: "email" }, hand = { title: "typed by hand" };
  assert.ok(box.scopeViaAllows(onlyDoc, { mail: true, drive: true }) && box.scopeViaAllows(onlyMail, { mail: true, drive: true }));
  assert.ok(box.scopeViaAllows(onlyMail, { mail: true, drive: false }) && !box.scopeViaAllows(onlyDoc, { mail: true, drive: false }), "emails only");
  assert.ok(box.scopeViaAllows(onlyDoc, { mail: false, drive: true }) && !box.scopeViaAllows(onlyMail, { mail: false, drive: true }), "Drive only");
  assert.ok(box.scopeViaAllows(both, { mail: true, drive: false }) && box.scopeViaAllows(both, { mail: false, drive: true }), "an item both mention stays under either");
  assert.ok(box.scopeViaAllows(hand, { mail: true, drive: false }), "an item typed by hand is never filtered away");
  const doc0 = box.normalizeScopeDoc({ result: { items: [Object.assign({ id: "i1", title: "Footings", category: "footings", specs: [] }, both), Object.assign({ id: "i2", title: "Stair", category: "stairs", specs: [] }, onlyMail)], gaps: [], references: parsed.references } }, "t1", "12 Beach Road");
  const groups = plain(box.scopeMentionsBySource(doc0, { mail: true, drive: true }));
  assert.deepEqual(groups.map((g) => [g.via, g.rows.length]), [["email", 2], ["document", 1]], "by source: one group per email / document, emails first, with what each asks for");
  assert.equal(plain(box.scopeMentionsBySource(doc0, { mail: false, drive: true })).length, 1, "…and the ticks apply there too");
  // where a referred-to document is
  assert.deepEqual(plain(box.scopeRefKeys({ ref: "Detail 7/S-05" })).map((k) => k.sheet), ["S-05"], "a sheet number is read out of the reference");
  const keys = box.scopeRefKeys({ ref: "S-05" });
  assert.ok(keys[0].re.test("S05 Details.pdf") && keys[0].re.test("S-5_details.pdf") && !keys[0].re.test("S-051 plan.pdf") && !keys[0].re.test("AS-05.pdf"), "…and found in any spelling, never inside another number");
  const world = { files: [{ name: "S-01 Structural.pdf", url: "https://x/s01.pdf" }], notes: [{ kind: "email", name: "RE: scope", from: "Sam Builder <sam@b.com.au>" }],
    found: { mail: [{ id: "m2", subject: "Drawings issued", from: "Eng <e@s.com.au>", date: "2026-11-10T00:00:00Z", attachments: [{ filename: "A201 Floor plan.pdf" }] }], drive: { folder: { id: "F1", name: "12 Beach Road Rye" }, files: [{ id: "d2", name: "S-05 Details.pdf", path: "Structural", webViewLink: "https://drive/d2" }] } } };
  const L = (ref) => plain(box.scopeLocateReference(ref, world));
  assert.equal(L({ ref: "Geotech", found: { doc: "Soil.pdf", page: "1" } }).state, "read", "the reader found it in the set");
  assert.equal(L({ ref: "S-01" }).state, "read", "a file already among the sources");
  const dr = L({ ref: "Detail 7/S-05" });
  assert.equal(dr.state, "drive"); assert.equal(dr.fileId, "d2"); assert.match(dr.where, /12 Beach Road Rye › Structural › S-05 Details\.pdf/); assert.equal(dr.link, "https://drive/d2");
  const ml = L({ ref: "A-201" });
  assert.equal(ml.state, "mail"); assert.match(ml.where, /Attached to the email “Drawings issued” from Eng <e@s\.com\.au>, 2026-11-10: A201 Floor plan\.pdf/); assert.match(ml.link, /#all\/m2$/); assert.match(ml.how, /Download the attachment/);
  const miss = L({ ref: "Landscape plan L-03", cited: [{ doc: "Email — RE: scope", via: "email" }] });
  assert.equal(miss.state, "missing"); assert.equal(miss.search, "L-03");
  assert.match(miss.where, /Not found in the Drive folder “12 Beach Road Rye” \(1 file\) or 1 project email/);
  assert.match(miss.how, /ask Sam Builder <sam@b\.com\.au> for it — it is cited in Email — RE: scope/, "it names who to ask");
  assert.match(plain(box.scopeLocateReference({ ref: "L-03" }, {})).where, /have not been scanned yet/, "nothing scanned is said, never 'not found'");
  // merges
  const m1 = box.mergeScopeResult({ items: [Object.assign({ id: "i1", title: "Footings", specs: [] }, onlyDoc)], gaps: [], references: [parsed.references[0]] }, { items: [Object.assign({ id: "i1", title: "Footings", specs: [] }, onlyMail)], gaps: [], references: [{ id: parsed.references[0].id, ref: "Detail 7/S-05", cited: [{ doc: "New.pdf", via: "document" }], found: { doc: "S-05.pdf" } }] });
  assert.deepEqual(plain(m1.items[0].mentions).map((m) => m.via), ["document", "email"], "a later read ADDS the email's mention to the item");
  assert.equal(m1.references.length, 1); assert.equal(m1.references[0].cited.length, 3); assert.equal(m1.references[0].found.doc, "S-05.pdf", "…and a reference found later is marked found");
  const a = box.normalizeScopeDoc({ auto: { mail: true, drive: false }, drive: { id: "F1", name: "x" }, found: { at: "2026-11-20T01:00:00Z", mail: [], drive: null, errors: {} }, updatedAt: "2026-11-20T01:00:00Z" }, "t1", "n");
  const b = box.normalizeScopeDoc({ found: { at: "2026-11-20T02:00:00Z", mail: [{ id: "m" }], drive: null, errors: {} }, updatedAt: "2026-11-20T00:30:00Z" }, "t1", "n");
  const md = box.mergeScopeDocs(a, b);
  assert.equal(md.found.at, "2026-11-20T02:00:00Z", "two devices: the newer look stands");
  assert.equal(md.drive.id, "F1", "…and the chosen folder is kept");
  assert.deepEqual(plain(box.emptyScopeDoc("t", "n").auto), { mail: true, drive: true }, "both sources are on to start");
  const csv = box.scopeCsvRows(doc0).map((r) => r.join("|")).join("\n");
  assert.match(csv, /Document referred to/); assert.match(csv, /Also mentioned/, "the export carries the mentions and the references");
  // the page: read-only everywhere
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const block = est.slice(est.indexOf("async function scopeDriveLook(found){"), est.indexOf("function scopeClose(){"));
  assert.match(est, /scopeDiscover\(false\);/, "the look runs when the panel opens");
  assert.match(block, /action:"match", projectName:PROJECT\.name/, "the Drive folder is matched by the project's name");
  assert.match(block, /action:"list", q, max:25/, "the mailbox is listed, never changed");
  assert.match(block, /action:"copy", id:[^}]*target:"preview"/, "a Drive file is copied into the portal's own bucket to be read");
  const actions = Array.from(block.matchAll(/action:"([a-z]+)"/g)).map((m) => m[1]);
  assert.deepEqual(Array.from(new Set(actions)).sort(), ["copy", "list", "match", "read", "search"], "the scan only reads: match, list, read, copy, search — nothing is sent, labelled or written to Drive");
  assert.match(est, /data-scope-auto="mail" data-testid="scope-src-mail"/); assert.match(est, /data-scope-auto="drive" data-testid="scope-src-drive"/);
  assert.match(est, /data-testid="scope-scan"/); assert.match(est, /data-testid="scope-by-source"/); assert.match(est, /data-testid="scope-refs"/); assert.match(est, /data-testid="scope-ref-add"/); assert.match(est, /data-testid="scope-ref-search"/);
  assert.ok(!/addInstance\(|saveEstimateState\(|pushTakeoffToCloud\(/.test(block), "the scan never touches the takeoff — only the estimator's own '+ Add to takeoff' does");
});
await checkAsync("Rates Library reads supplier rate documents (20 Nov 2026): the reader lists lines as written and never decides a figure; the page maps by rule, converts $/tonne by each bar's weight, flags what is not clear and leaves it unticked; applying records the document with its validity date and alarms as it nears", async () => {
  const RDL = await import("../src/lib/rateDocs.js");
  const E = await import("../api/ai-engine.js");
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const box = { console }; box.globalThis = box;
  runInNewContext(html.slice(html.indexOf("const GLOBAL = {"), html.indexOf("/* ============================= CROSS-DEVICE SYNC")) + "\n;globalThis.__t={REINFORCEMENT_ITEMS,CONCRETE_GRADE_ITEMS,SPECIALIST_CONCRETE_ITEMS,REINFORCING_ACCESSORIES,OTHER_ACCESSORIES,OTHER_ALLOWANCES,LABOUR_PLANT_ITEMS,FORMWORK_LEGACY_ITEMS,freshRates};", box, { filename: "rates-library.html" });
  runInNewContext(fs.readFileSync(new URL("../portal/rates-docs.js", import.meta.url), "utf8"), box, { filename: "rates-docs.js" });
  const T = box.__t; const state = T.freshRates();
  const tables = { reinforcement: T.REINFORCEMENT_ITEMS, concreteGrade: T.CONCRETE_GRADE_ITEMS, specialistConcrete: T.SPECIALIST_CONCRETE_ITEMS, reinfAcc: T.REINFORCING_ACCESSORIES, otherAcc: T.OTHER_ACCESSORIES, otherAllow: T.OTHER_ALLOWANCES, labourPlant: T.LABOUR_PLANT_ITEMS, formworkLegacy: T.FORMWORK_LEGACY_ITEMS };
  const rows = box.rateDocLibraryRows(state, tables);
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, rows.length, "every row id is unique");
  ["squareMesh::SL62", "trenchMesh::3 Bar-L11TM", "stockBar::N12 - 6.0m length", "processedBar::N12", "concreteGrade::32 mpa", "global::concreteSurchargePerM3", "labourPlant::5", "stockBar::*", "processedBar::*", "concreteGrade::*"].forEach((id) => assert.ok(ids.has(id), `the row list carries ${id}`));
  assert.ok(!rows.some((r) => /^finishRates::|^prelim::/.test(r.id)), "allowance tables are not supplier rows");
  const readerRows = box.rateDocRowsForReader(rows);
  assert.ok(readerRows.every((r) => !("current" in r)), "the reader is sent ids, names and units — never a price");
  // the prompt's three rules
  const prompt = RDL.rateDocPrompt({ rows: readerRows, hasDocuments: true, today: "2026-11-20" });
  assert.match(prompt, /Never compute, convert, round, add or remove GST, or fill in a price that is not there/, "a price is copied as written");
  assert.match(prompt, /never pick the nearest row/, "a line is pointed at a row only when it is the same thing");
  assert.match(prompt, /"validUntil" only when the document states the date its prices run to/, "a validity date is only one the document states");
  assert.match(prompt, /Dates in these documents are day\/month\/year/, "06/11/2026 is read as 6 November");
  assert.match(prompt, /squareMesh::SL62 \| Square Mesh \| SL62 \| sheet/, "the library rows are offered by id");
  assert.match(prompt, /stockBar::\* \| Stock Bar \| .* \| tonne \| GROUP/);
  // what one request may carry
  assert.match(RDL.rateDocRequestError({ files: [], text: " ", rows: readerRows }), /Nothing to read/);
  assert.match(RDL.rateDocRequestError({ files: Array.from({ length: 7 }, (_, i) => ({ url: `https://x.co/${i}.pdf` })), rows: readerRows }), /At most 6 files/);
  assert.match(RDL.rateDocRequestError({ files: [{ url: "https://x.co/a.xlsx", name: "a.xlsx" }], rows: readerRows }), /Not a PDF or an image/);
  assert.match(RDL.rateDocRequestError({ text: "x".repeat(RDL.RATE_DOC_MAX_TEXT_CHARS + 1), rows: readerRows }), /nothing is cut off silently/);
  assert.match(RDL.rateDocRequestError({ text: "rates", rows: [] }), /row list is missing/);
  assert.equal(RDL.rateDocRequestError({ files: [{ url: "https://x.co/quote.png" }], rows: readerRows }), null);
  assert.equal((await E.runAiJob({ action: "rates" }, {})).status, 400);
  assert.equal((await E.runAiJob({ action: "rates", text: "SL62 $58.54", rows: readerRows }, {})).status, 503, "no provider is a 503, never a made-up list");
  assert.match((await E.runAiJob({ action: "nope" }, {})).body.error, /"rates"/);
  assert.equal(box.RATE_DOC_FILES_PER_READ, RDL.RATE_DOC_MAX_FILES, "the page and the server agree on the files per read");
  assert.equal(box.RATE_DOC_TEXT_MAX_CHARS, RDL.RATE_DOC_MAX_TEXT_CHARS);
  // the AKZ quotation, as a reader would list it
  const L = (description, price, kind, extra = {}) => ({ doc: 1, description, price, kind, per: "other", mode: "price", confidence: "high", ...extra });
  const raw = { documents: [{ n: 1, supplier: "A.K.Z. Reinforcing Pty Ltd", reference: "15011", issued: "2026-11-06", validUntil: "2026-12-31", validityQuote: "The above pricing is valid until 31/12/2026 and is exclusive of GST.", gst: "ex", source: "AKZ 15011.png" }],
    lines: [L("STOCK STEEL", "$1,800.00", "stock_steel"), L("PROCESSED STEEL", 1900, "processed_steel"),
      L("FABRIC SL62 STANDARD SHEET", 58.54, "sheet_mesh", { code: "sl62", per: "sheet" }), L("FABRIC SL81 STANDARD SHEET", 186.37, "sheet_mesh", { per: "sheet" }),
      L("11mmWIRE TRENCH MESH 3 BAR", 23.96, "trench_mesh", { code: "L11TM", bars: 3 }), L("12mm WIRE TRENCH MESH 5 BAR", 53.18, "trench_mesh"),
      L("15mm WIRE TRENCH MESH 3 BAR (Sense)", 64.81, "trench_mesh", { unclear: "'(Sense)' is not explained" }), L("15mm WIRE TRENCH MESH 5 BAR", 99, "trench_mesh"),
      L("Total Indicative Cost", null, "other"), L("Semi/Tray truck transport", 300, "fee", { per: "load", target: "reinfAcc::Delivery fee", confidence: "medium" }),
      L("Demurrage", 150, "fee", { per: "hour", target: "madeup::row" }), null, { doc: 1, description: "" }],
    notes: [{ doc: 1, text: "Demurrage $150/hour after 60 minutes on site." }, { doc: 1, text: "Demurrage $150/hour after 60 minutes on site." }], unreadable: [] };
  const parsed = RDL.parseRateDocs(raw, { rows: readerRows });
  const doc = parsed.docs[0];
  assert.deepEqual([parsed.docs.length, doc.lines.length, doc.notes.length, doc.validUntil, doc.gst, doc.lines[0].price, doc.lines[2].code], [1, 11, 1, "2026-12-31", "ex", 1800, "SL62"], "blank lines dropped, the note once, '$1,800.00' read as 1800");
  assert.deepEqual([doc.lines[9].target, doc.lines[10].target, doc.lines[10].targetRefused], ["reinfAcc::Delivery fee", null, "madeup::row"], "a row the library does not have is never a target");
  assert.equal(RDL.parseRateDocs({ documents: [{ n: 1, supplier: "X", validUntil: "31/12/2026" }], lines: [L("a", 1, "other")] }, { rows: readerRows }).docs[0].validUntil, null, "a date that is not ISO is no date");
  assert.equal(RDL.parseRateDocs({ lines: [] }), null); assert.equal(RDL.parseRateDocs(null), null);
  const out = box.proposeRateDoc(doc, rows, state, { today: "2026-11-20" });
  const P = (id) => out.proposals.find((p) => p.rowId === id);
  assert.equal(out.proposals.filter((p) => p.rowId.startsWith("stockBar::")).length, T.REINFORCEMENT_ITEMS["Stock Bar"].items.length, "a stock steel rate prices every stock bar size");
  assert.deepEqual([P("stockBar::N12 - 6.0m length").to, P("stockBar::N32 - 6.0m length").to], [9.83, 69.86], "$1,800/t × the bar's weight ÷ 1000, to the cent");
  assert.equal(P("processedBar::N12").to, 1.729, "processed bar is $/m to four decimals: $1,900/t × 0.91 kg");
  assert.match(P("stockBar::N12 - 6.0m length").basis, /\$1,800\.00\/t × 5\.46 kg \(no unit stated — read as \$\/tonne\)/, "the arithmetic and the assumption are said on the row");
  assert.deepEqual([P("squareMesh::SL62").to, P("squareMesh::SL81").to, P("trenchMesh::3 Bar-L11TM").to, P("trenchMesh::5 Bar-L12TM").to], [58.54, 186.37, 23.96, 53.18], "mesh by its code — from the reader's code or the line's own wording");
  assert.ok(box.proposalTicked(P("squareMesh::SL62")) && P("squareMesh::SL62").flags.length === 0, "a plain line is ticked");
  const l15 = P("trenchMesh::3 bar-L15TM");
  assert.ok(l15 && l15.from === null && !box.proposalTicked(l15) && /Sense/.test(l15.flags.join(" ")), "a line the reader found unclear is matched but flagged and unticked");
  assert.ok(!box.proposalTicked(P("reinfAcc::Delivery fee")) && /not certain/.test(P("reinfAcc::Delivery fee").flags.join(" ")), "a row the reader was not sure of is unticked");
  assert.deepEqual(JSON.parse(JSON.stringify(out.unmapped.map((u) => u.reason.replace(/ \(.*/, "")))), ["The library has no trench mesh row for 5 bar L15TM", "No price could be read on this line", "The reader named a row the library does not have"], "what cannot be matched is listed with its reason, never applied");
  // "unit not stated" is the page's to settle on a steel quotation's lines, never a reason to untick them (the live reader said it on every AKZ line)
  const liveLike = RDL.parseRateDocs({ documents: [{ n: 1, supplier: "AKZ", gst: "ex" }], lines: [L("STOCK STEEL", 1800, "stock_steel", { confidence: "medium", target: "stockBar::*", unclear: "Unit not stated; the library group is priced per tonne" }), L("11mmWIRE TRENCH MESH 3 BAR", 23.96, "trench_mesh", { confidence: "medium", unclear: "Unit not stated; the library row is priced per length" }), L("15mm WIRE TRENCH MESH 3 BAR (Sense)", 64.81, "trench_mesh", { confidence: "low", unclear: "Unit not stated; meaning of '(Sense)' unclear" })] }, { rows: readerRows }).docs[0];
  const liveOut = box.proposeRateDoc(liveLike, rows, T.freshRates(), { today: "2026-11-20" });
  assert.ok(liveOut.proposals.filter((p) => p.rowId.startsWith("stockBar::") || p.rowId === "trenchMesh::3 Bar-L11TM").every((p) => box.proposalTicked(p) && p.flags.length === 0), "a steel line whose only doubt is the unprinted unit stays ticked");
  const sense = liveOut.proposals.find((p) => p.rowId === "trenchMesh::3 bar-L15TM");
  assert.ok(!box.proposalTicked(sense) && /Sense/.test(sense.flags.join()) && !/Unit not stated/.test(sense.flags.join()), "…while a real doubt on the same kind of line still flags it");
  assert.match(prompt, /do NOT report the missing unit in "unclear"/, "the reader is told the same");
  // not-clear cases
  const flagsOf = (line, d = {}) => { const dd = RDL.parseRateDocs({ documents: [{ n: 1, supplier: "S", gst: "ex", ...d }], lines: [line] }, { rows: readerRows }).docs[0]; const o = box.proposeRateDoc(dd, rows, state, { today: "2026-11-20" }); return o.proposals.length ? o.proposals[0] : { flags: [o.unmapped[0].reason], to: null }; };
  assert.match(flagsOf(L("32 MPa", 213, "concrete", { per: "tonne", target: "concreteGrade::32 mpa" })).flags.join(), /Priced per tonne; the library row is per m³/);
  assert.match(flagsOf(L("32 MPa", 213, "concrete", { target: "concreteGrade::32 mpa" })).flags.join(), /does not state the unit/);
  assert.match(flagsOf(L("FABRIC SL62", 120, "sheet_mesh", { per: "sheet" })).flags.join(), /Moves \+99% from the current rate/, "a big move is flagged");
  const inc = flagsOf(L("32 MPa", 234.3, "concrete", { per: "m3", target: "concreteGrade::32 mpa" }), { gst: "inc" });
  assert.ok(inc.to === 213 && /including GST/.test(inc.flags.join()), "a GST-inclusive price is shown ex GST and flagged");
  assert.match(flagsOf(L("32 MPa", 213, "concrete", { per: "m3", target: "concreteGrade::32 mpa" }), { gst: "unknown" }).flags.join(), /GST basis not stated/);
  assert.match(flagsOf(L("32 MPa", 220, "concrete", { per: "m3", target: "concreteGrade::32 mpa" }), { validFrom: "2027-01-01" }).flags.join(), /Takes effect 2027-01-01 — not yet/);
  const up = RDL.parseRateDocs({ documents: [{ n: 1, supplier: "Holcim", gst: "ex" }], lines: [L("All grades increase", 8, "concrete", { mode: "increase_amount", per: "m3", target: "concreteGrade::*" })] }, { rows: readerRows }).docs[0];
  const upOut = box.proposeRateDoc(up, rows, state, { today: "2026-11-20" });
  assert.ok(upOut.proposals.length >= 8 && upOut.proposals.every((p) => !/cartage|levy|Penetron/i.test(p.name) && p.to === Math.round((p.from + 8) * 100) / 100 && !box.proposalTicked(p)), "an across-the-board increase lands on the mixes only, worked out from each current rate, and is never ticked for you");
  assert.match(upOut.warnings.join(), /No validity date is stated/);
  // by hand: an unmatched line pointed at a row, and a matched one left out
  const hand = box.proposeRateDoc(doc, rows, state, { today: "2026-11-20", overrides: { 10: "reinfAcc::Delivery fee", 2: "" } });
  assert.ok(hand.proposals.some((p) => p.line === 10 && p.byHand) && !hand.proposals.some((p) => p.line === 2) && hand.unmapped.some((u) => u.line === 2 && u.reason === "Left out by you"));
  // apply
  const picked = out.proposals.filter((p) => box.proposalTicked(p));
  const rec = box.applyRateDoc(state, doc, rows, picked, { at: "2026-11-20T01:00:00Z", by: "projects", notApplied: out.unmapped, validityNames: ["Environment levy"] });
  assert.deepEqual([state.reinforcementEstablished.stockBar["N12 - 6.0m length"], state.reinforcementEstablished.processedBar.N12, state.reinforcementEstablished.squareMesh.SL62], [9.83, 1.729, 58.54], "the ticked figures are on the library");
  assert.equal(state.reinforcementEstablished.trenchMesh["3 bar-L15TM"], undefined, "an unticked line changes nothing");
  assert.deepEqual([rec.rows.length, rec.supplier, rec.reference, rec.validUntil, rec.by, rec.keepOlder, rec.notApplied.length, state.rateDocs.length], [picked.length, "A.K.Z. Reinforcing Pty Ltd", "15011", "2026-12-31", "projects", true, 3, 1], "the document is recorded with what it set and what it did not");
  assert.match(rec.keepBefore, /^2026-11-(19|20)$/, "older work is kept from the local day of application");
  // validity as usual on a time-limited row
  const levy = RDL.parseRateDocs({ documents: [{ n: 1, supplier: "Holcim", reference: "Notice 7", validUntil: "2027-01-31", gst: "ex" }], lines: [L("Environment levy", 3.1, "levy", { per: "m3", target: "concreteGrade::Environment levy" }), L("Production & transport surcharge", 9.6, "surcharge", { per: "m3", target: "global::concreteSurchargePerM3" })] }, { rows: readerRows }).docs[0];
  const levyOut = box.proposeRateDoc(levy, box.rateDocLibraryRows(state, tables), state, { today: "2026-11-20" });
  box.applyRateDoc(state, levy, box.rateDocLibraryRows(state, tables), levyOut.proposals, { at: "2026-11-21T01:00:00Z", validityNames: ["Environment levy"] });
  assert.deepEqual([state.concreteGrade["Environment levy"].cost, state.global.concreteSurchargePerM3, state.validity["Environment levy"], state.validity["Production & transport surcharge"]], [3.1, 9.6, "2027-01-31", "2027-01-31"], "a levy and the surcharge take the document's date in the validity block, as usual");
  // the alarm: nears, lapses, is superseded
  assert.deepEqual(JSON.parse(JSON.stringify(box.rateDocAlarms(state, "2026-11-20"))), [], "nothing to say 41 days out");
  const near = box.rateDocAlarms(state, "2026-12-20"), late = box.rateDocAlarms(state, "2027-01-05");
  assert.deepEqual([near.length, near[0].state, near[0].daysLeft, near[0].rows, late[0].state, late[0].daysLeft], [1, "expiring", 11, picked.length, "expired", -5]);
  assert.deepEqual(JSON.parse(JSON.stringify(near)), JSON.parse(JSON.stringify(RDL.supplierDocAlarms(state, new Date(2026, 11, 20)))), "the page's alarm and the Quotes banner's are the same answer");
  const next = RDL.parseRateDocs({ ...raw, documents: [{ ...raw.documents[0], reference: "15102", validUntil: "2027-03-31" }], lines: raw.lines.slice(0, 6) }, { rows: readerRows }).docs[0];
  const r2 = box.rateDocLibraryRows(state, tables); const nextOut = box.proposeRateDoc(next, r2, state, { today: "2027-01-05" });
  assert.ok(nextOut.proposals.every((p) => p.same && box.proposalTicked(p)), "the same figures again are 'unchanged' and still ticked — the new document takes over their validity");
  box.applyRateDoc(state, next, r2, nextOut.proposals, { at: "2027-01-05T01:00:00Z" });
  assert.deepEqual(JSON.parse(JSON.stringify(box.rateDocAlarms(state, "2027-01-05"))), [], "a document every row of which a later one re-priced is superseded and says nothing");
  assert.equal(box.rateDocStatus(state, "2027-01-05").find((d) => d.reference === "15011").state, "superseded");
  assert.ok(box.rateDocSetValidity(state, state.rateDocs[2].id, "2027-01-10") && box.rateDocAlarms(state, "2027-01-05").length === 1, "a validity date retyped on the record moves the alarm");
  // sources
  assert.deepEqual(JSON.parse(JSON.stringify(["q.pdf", "q.PNG", "mail.eml", "x.msg", "r.xlsx"].map((n) => box.rateDocFileClass(n, "", 10).kind))), ["pdf", "image", "text", null, null]);
  assert.match(box.rateDocRunText([{ kind: "email", name: "Holcim price notice", from: "sales@holcim", date: "2026-11-12T03:00:00Z", text: "hi" }]), /^=== EMAIL — Holcim price notice — from sales@holcim — 2026-11-12 ===\nhi$/);
  // wiring
  assert.match(html, /<script src="rates-docs\.js"><\/script>/, "the page loads the pure module");
  assert.match(fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8"), /rates-library\.html no longer loads rates-docs\.js — inline step out of date/, "…and the assembler inlines it");
  assert.match(html, /id="rateDocsBtn" type="button" data-testid="rate-docs-button"/);
  assert.match(html, /rateDocAlarmHtml\(\) \+ validityAlarmHtml\(\)/, "the document alarm heads the page beside the fee alarm");
  const ui = html.slice(html.indexOf("/* ===================== SUPPLIER RATE DOCUMENTS"), html.indexOf("renderApp(); // instant render"));
  assert.equal((ui.match(/applyRateDoc\(/g) || []).length, 1, "ONE place writes a document's rates: the Apply button");
  assert.match(ui, /const picked=out\.proposals\.filter\(p=>proposalTicked\(p,RD\.ticks\)\);/, "…and only the ticked proposals");
  assert.match(ui, /action:"rates", provider, today:rateDocLocalDay\(\), rows:rateDocRowsForReader\(rdRows\(\)\)/, "the read sends the row list without prices");
  assert.match(ui, /if\(!RD\.mail\) rdMailSearch\(RATE_DOC_MAIL_QUERY\);/, "the mailbox is searched for rate emails when the panel opens");
  assert.match(ui, /action:"attachment", id, attachmentId:a\.attachmentId, filename:a\.filename/, "a rate email's PDF is read too");
  assert.ok(!/action:"send"/.test(ui), "nothing is sent");
  assert.match(fs.readFileSync(new URL("../src/components/RateValidityBanner.jsx", import.meta.url), "utf8"), /supplierDocAlarms\(readLibraryState\(\)\)/, "Quotes shows the document alarm as one line");
});
await checkAsync("supplier-document rates never re-price older work (Boma, 20 Nov 2026: 'it shouldnt affect older works uptill yesterday'): a document-driven move is logged with its day; a project created before it keeps its figure on the Dashboard and in the editor without being asked; one created that day follows; a retyped figure asks as before", async () => {
  const LS = await import("../src/lib/ratesLibrarySync.js"), RC = await import("../src/lib/rateChanges.js");
  const key = LS.libraryPrices({ reinforcementEstablished: { squareMesh: { SL62: 58.54 } } })[0];
  assert.equal(key.rowId, "squareMesh::SL62"); assert.equal(key.raw, 58.54);
  const lib = (to, docs) => ({ reinforcementEstablished: { squareMesh: { SL62: to }, processedBar: { N12: 1.729 } }, rateDocs: docs });
  const docRec = { id: "rd1", supplier: "AKZ", reference: "15011", appliedAt: "2026-11-20T01:00:00Z", keepOlder: true, keepBefore: "2026-11-20", rows: [{ id: "squareMesh::SL62", to: 58.54 }, { id: "processedBar::N12", to: 1.729 }] };
  const rates = { [key.key]: { unitCost: 60.32 } };
  const ups = LS.pendingRateUpdates(rates, lib(58.54, [docRec]));
  const sl = ups.find((u) => u.key === key.key);
  assert.deepEqual([sl.price, sl.from, sl.keepBefore, sl.doc], [58.54, 60.32, "2026-11-20", "AKZ — 15011"], "a figure the document set carries the document's day");
  assert.ok(ups.find((u) => /PROCESSED BAR/.test(u.key) && u.keepBefore === "2026-11-20"), "processed bar is compared in the library's own $/m, whatever Quotes prices it in");
  assert.equal(LS.pendingRateUpdates(rates, lib(59, [docRec])).find((u) => u.key === key.key).keepBefore, undefined, "a figure retyped in the library after the document is an ordinary change");
  assert.equal(LS.pendingRateUpdates(rates, lib(58.54, [{ ...docRec, keepOlder: false }])).find((u) => u.key === key.key).keepBefore, undefined, "…and so is a document applied with the rule switched off");
  const log = RC.recordRateChanges([], ups, "2026-11-20T02:00:00Z");
  assert.equal(log.find((e) => e.key === key.key).keepBefore, "2026-11-20", "the log entry keeps the day");
  const item = { id: "i1", qtys: { [key.key]: 28.8 } };
  const older = { status: "Estimating", items: [item] }, live = { [key.key]: { unitCost: 58.54, sheetArea: 14.4 } };
  const oldCreated = "2026-11-10T03:00:00Z", todayCreated = new Date(2026, 10, 20, 9, 0).toISOString();
  assert.deepEqual(RC.autoKeepChanges(older, log, oldCreated).map((c) => [c.key, c.from, c.to]).filter((c) => c[0] === key.key), [[key.key, 60.32, 58.54]], "a project from before the day keeps the previous figure");
  assert.equal(RC.promptRateChanges(older, log, oldCreated).length, 0, "…and is not asked");
  assert.equal(RC.ratesKeepingOlderWork(older, live, log, oldCreated)[key.key].unitCost, 60.32, "the Dashboard prices it at the kept figure before the project is ever opened");
  assert.equal(RC.ratesKeepingOlderWork(older, live, log, oldCreated)[key.key].sheetArea, 14.4, "…with the rest of the rate untouched");
  assert.equal(RC.autoKeepChanges(older, log, todayCreated).length, 0, "a project created that day is today's work");
  assert.equal(RC.ratesKeepingOlderWork(older, live, log, todayCreated), live, "…and prices at the new rate (the same object back: nothing to overlay)");
  const patch = RC.autoKeepPatch(older, live, log, oldCreated, "2026-11-21T00:00:00Z");
  assert.deepEqual([patch.ratesFrozen.reason, patch.ratesFrozen.rates[key.key].unitCost, patch.ratesFrozen.auto, patch.ratesAutoKept[key.key]], ["library", 60.32, "AKZ — 15011", "2026-11-20T02:00:00Z"], "opening the project records the kept figures as an ordinary library pin");
  assert.equal(patch.ratesAck, undefined, "the ack is left alone, so other changes still ask");
  const kept = { ...older, ...patch };
  assert.equal(RC.pendingRateChanges(kept, log, oldCreated).length, 0, "once recorded it is settled — the effect cannot loop");
  assert.deepEqual(RC.autoKeepPatch(kept, live, log, oldCreated), {}, "nothing more to write");
  assert.equal(RC.keptRates(kept).length, patch.ratesFrozen && Object.keys(patch.ratesFrozen.rates).length, "'Previous rates kept' lists them");
  const released = { ...kept, ...RC.releaseKeptRatesPatch(kept) };
  assert.equal(released.ratesFrozen, null); assert.equal(RC.autoKeepChanges(released, log, oldCreated).length, 0, "released figures are not kept again");
  const log2 = RC.recordRateChanges(log, [{ key: key.key, price: 61, from: 58.54, name: "SL62" }], "2026-12-01T00:00:00Z");
  assert.deepEqual(RC.promptRateChanges(kept, log2, oldCreated).map((c) => [c.from, c.to]), [[60.32, 61]], "a later figure typed in the library asks, from the kept figure");
  assert.equal(RC.autoKeepChanges(kept, log2, oldCreated).length, 0);
  const frozen = { status: "Submitted", items: [item], ratesFrozen: { at: "x", status: "Submitted", rates: { [key.key]: { unitCost: 60.32 } } } };
  assert.equal(RC.ratesKeepingOlderWork(frozen, frozen.ratesFrozen.rates, log, oldCreated), frozen.ratesFrozen.rates, "a finished project already holds its own rates");
  assert.deepEqual(RC.firstWorkAck({ items: [] }, [item], "2026-11-22T00:00:00Z"), { ratesAck: { at: "2026-11-22T00:00:00Z", applied: [], kept: [] } }, "the first element of an empty project acknowledges every move before it — there was no work to keep");
  assert.deepEqual(RC.firstWorkAck({ items: [item] }, [item, item]), {}); assert.deepEqual(RC.firstWorkAck({ items: [], ratesAck: { at: "x" } }, [item]), {});
  assert.equal(RC.autoKeepChanges({ status: "Queued", items: [item], ratesAck: { at: "2026-11-22T00:00:00Z" } }, log, oldCreated).length, 0, "…so an old empty project that starts work today prices at today's rates");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /const rates = useMemo\(\(\) => ratesKeepingOlderWork\(quote, effectiveRates\(quote, liveRates\), rateChanges, project\.createdAt\)/, "the editor prices through the same reading");
  assert.match(app, /staleBuild\(\)\) return;\n    if \(!autoKeepChanges\(quote, rateChanges, project\.createdAt\)\.length\) return;/, "the record is never written from a tab on an older build");
  assert.match(fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8"), /ratesKeepingOlderWork\(quote, effectiveRates\(quote, liveRates\), rateChanges, createdAt\)/);
});
check("clearable notices (22 Oct 2026): a notice cleared at its signature stays cleared, comes back when its content changes, restore one or all; the browser store survives a bad value", () => {
  const N = NOTICES;
  const sig = N.noticeSig("a@1", null, "", ["b@2", "c@3"]); assert.equal(sig, "a@1|b@2|c@3");
  let st = N.clearNotice(undefined, N.NOTICE_IDS.keptRates, sig, "2026-10-22T05:00:00Z");
  assert.ok(N.isNoticeCleared(st, "keptRates", sig)); assert.ok(!N.isNoticeCleared(st, "keptRates", "a@1|b@9"), "a changed figure brings the notice back");
  assert.ok(!N.isNoticeCleared(st, "validity", sig)); assert.equal(st.keptRates.at, "2026-10-22T05:00:00Z");
  st = N.clearNotice(st, "trail", "trail"); assert.equal(N.clearedCount(st), 2);
  assert.equal(N.clearedCount(N.restoreNotices(st, "trail")), 1); assert.deepEqual(N.restoreNotices(st), {}); assert.equal(N.clearedCount(undefined), 0);
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  assert.deepEqual(N.readBrowserNotices(storage), {}); N.writeBrowserNotices(st, storage); assert.deepEqual(N.readBrowserNotices(storage), st);
  mem[N.BROWSER_NOTICES_KEY] = "not json"; assert.deepEqual(N.readBrowserNotices(storage), {}, "a bad value reads as nothing cleared");
});
check("work trail (Grady's colour-coded entries, 22 Oct 2026): an entry records who typed it and when, the tone is 'me' for the signed-in account and 'other' for anyone else, nothing is stamped with no account; Done per element; progress says done / total, the next element and the last one touched", () => {
  const W = WT;
  assert.equal(W.userKey("grady@gradcon.com.au"), "grady"); assert.equal(W.userKey(""), null);
  let it = { id: "a", label: "Raft", qtys: {}, tasks: [{ id: "t1", qtys: {} }] };
  const unstamped = W.markEntry(it, "CONCRETE::32 mpa::m3", null); assert.strictEqual(unstamped, it, "no account — nothing recorded");
  it = W.markEntry(it, "CONCRETE::32 mpa::m3", "grady", "2026-10-22T01:00:00Z");
  it = W.markEntry(it, W.ENTRY_KEY.cell("t1", "concreter_day"), "projects", "2026-10-22T02:00:00Z");
  assert.equal(W.entryTone(it, "CONCRETE::32 mpa::m3", "grady"), "me"); assert.equal(W.entryTone(it, "CONCRETE::32 mpa::m3", "projects"), "other");
  assert.equal(W.entryTone(it, "task:t1:concreter_day", "grady"), "other"); assert.equal(W.entryTone(it, "nothing", "grady"), null);
  assert.equal(W.ENTRY_KEY.taskQty("t1"), "task:t1:qty"); assert.equal(W.ENTRY_KEY.additional("r9", "rate"), "add:r9:rate");
  assert.ok(!W.isDone(it)); const done = { ...it, ...W.donePatch(true, "grady", "2026-10-22T03:00:00Z") }; assert.ok(W.isDone(done)); assert.equal(done.done.by, "grady");
  assert.ok(!W.isDone({ ...done, ...W.donePatch(false) }), "untick reopens");
  const b = { id: "b", label: "Slab", entries: { x: { by: "grady", at: "2026-10-22T04:00:00Z" } } }, c = { id: "c", label: "Walls" };
  const pr = W.progress([done, b, c]);
  assert.deepEqual([pr.done, pr.total, pr.next.id, pr.last.item.id, pr.last.by], [1, 3, "b", "b", "grady"], "1 of 3 done; next = the first not done; last = the newest stamp");
  assert.equal(W.progress([]).next, null); assert.equal(W.progress([done]).next, null, "every element done");
  assert.ok(/at \d/.test(W.whenLabel("2026-10-22T04:00:00Z")));
  const T = THEME.THEME_TOKENS; assert.ok(T.some((t) => t.key === "entryMe") && T.some((t) => t.key === "entryOther"), "the two entry colours are theme tokens");
});
check("driveFiles helpers: a project's folder and attachments live on the quote (sync with it); attach is idempotent by Drive id; detach removes one", () => {
  const F = { id: "p1", name: "plan.pdf", kind: "pdf", mimeType: "application/pdf", size: 1200, modifiedTime: "2026-10-20T00:00:00Z", webViewLink: "https://drive.google.com/file/d/p1" };
  let q = { projectName: "12 Beach Road", items: [] };
  q = { ...q, ...DF.setProjectDriveFolderPatch(q, { id: "f1", name: "12 Beach Rd" }, "2026-10-21T00:00:00Z") };
  assert.deepEqual(DF.projectDriveFolder(q), { id: "f1", name: "12 Beach Rd", webViewLink: "https://drive.google.com/drive/folders/f1", chosenAt: "2026-10-21T00:00:00Z" });
  q = { ...q, ...DF.attachFilePatch(q, F, "2026-10-21T01:00:00Z") };
  assert.equal(DF.driveFiles(q).length, 1); assert.ok(DF.isAttached(q, "p1")); assert.equal(DF.driveFiles(q)[0].provider, "drive"); assert.equal(DF.driveFiles(q)[0].fileId, "p1");
  assert.deepEqual(DF.attachFilePatch(q, F), {}, "attaching the same Drive file again does nothing");
  const id = DF.driveFiles(q)[0].id; q = { ...q, ...DF.detachFilePatch(q, id) }; assert.equal(DF.driveFiles(q).length, 0);
  assert.equal(DF.projectAddress({ siteAddress: "12 Beach Rd" }), "12 Beach Rd"); assert.equal(DF.projectAddress({}), "");
  assert.equal(DF.fmtBytes(2 * 1048576), "2.0 MB"); assert.equal(DF.fileIcon("folder"), "📁");
});

const { computeTenderProjectSum, parseTenderPrice, seedTenderItems } = await import("../src/lib/tenderQuoteDefaults.js");
check("provisional items: flagged elements are carried in the grand total and totalled apart from the firm work; the tender seed names them 'Provisional Sum — …'", () => {
  const type = ELEMENT_TYPES.find((t) => t.labour === "slab_ground") || ELEMENT_TYPES[0];
  const live = defaultRates();
  const a = newElementItem(type); a.label = "Firm slab"; a.qtys[Object.keys(live).find((k) => /SQUARE MESH.*SL82/.test(k))] = 144;
  const b = newElementItem(type); b.label = "Maybe slab"; b.provisional = true; b.qtys[Object.keys(live).find((k) => /SQUARE MESH.*SL82/.test(k))] = 72;
  assert.ok(isProvisional(b) && !isProvisional(a) && !isProvisional(null));
  const grand = computeGrandTotal([a, b], live, "both"), split = computeProvisionalTotals([a, b], live, "both");
  assert.equal(split.count, 1); assert.ok(split.provisional > 0 && split.firm > 0); assert.ok(Math.abs(split.provisional + split.firm - grand) < 0.005, "firm + provisional = the grand total (a provisional sum is IN the quote)");
  assert.deepEqual(computeProvisionalTotals([a], live, "both"), { provisional: 0, firm: computeGrandTotal([a], live, "both"), count: 0 });
  const seeded = seedTenderItems({ projectName: "PS probe", items: [a, b], scope: "both" }, [a, b], live);
  const lines = seeded.flatMap((it) => it.lines || []);
  assert.ok(lines.some((l) => l.name === "Provisional Sum — Maybe slab" && /^Provisional Sum — /.test(l.text)), JSON.stringify(lines.map((l) => l.name)));
  assert.ok(lines.some((l) => l.name === "Firm slab"));
});
const { tenderNoteLines, assumptionLines, typedNoteLines } = await import("../src/lib/tenderNotes.js");
const HO = await import("../src/lib/handover.js");
const { tenderPriceDrift, refreshTenderPrices, tenderPrefill, newTenderQuote } = await import("../src/lib/tenderQuoteDefaults.js");

check("Handover prefill: Grady's crew-sheet bands, blank cells only, recorded and undoable, steel mode by element", () => {
  const rates = defaultRates();
  const T = (id) => ELEMENT_TYPES.find((t) => t.id === id);
  const bar = rateKey("PROCESSED BAR", "N12", "m");
  const raft = newElementItem(T("raft_foundation")); raft.label = "Raft"; raft.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 38.87; raft.qtys[bar] = 3260;
  const susp = newElementItem(T("suspended_slab")); susp.label = "Susp"; susp.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 50.77; susp.qtys[bar] = 7700;
  const small = newElementItem(T("slab_on_ground")); small.label = "Infill"; small.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 17.42; small.qtys[bar] = 420;
  const prelim = newElementItem(T("prelim_traffic_management")); prelim.label = "Traffic";
  // a typed cell is never overwritten
  const pour = raft.tasks.find((t) => /pour/i.test(t.name)); pour.qtys.concreter_day = 9;
  const quote = { items: [raft, susp, small, prelim], status: "Completed Estimating", completedAt: "2026-10-09", overheadPct: 0.08, contingencyPct: 0.05 };
  assert.ok(HO.shouldAutoHandover(quote), "first time at Completed Estimating, completed after the cut-over");
  assert.ok(!HO.shouldAutoHandover({ ...quote, completedAt: "2026-09-24" }), "a project completed before the prefill existed is never touched on its own");
  assert.ok(!HO.shouldAutoHandover({ ...quote, status: "Submitted" }), "only the Completed Estimating moment");
  const q2 = HO.applyHandover(quote, rates, "2026-10-09T00:00:00Z");
  const cell = (it, re, key) => (it.tasks.find((t) => re.test(t.name)) || { qtys: {} }).qtys[key];
  const r = q2.items[0], s2 = q2.items[1], sm = q2.items[2], pr = q2.items[3];
  assert.equal(cell(r, /site setup/i, "concreter_day"), 1);
  assert.equal(cell(r, /excavat/i, "concreter_day"), 4); assert.equal(cell(r, /excavat/i, "excavator_day"), 1); assert.equal(cell(r, /excavat/i, "bobcat_day"), 1, "bobcat on a foundation");
  assert.equal(cell(r, /tie/i, "steelfixer_day"), 8, "steel crew: 1 + 2.3 × 2.97 t");
  assert.equal(cell(r, /pour/i, "concreter_day"), 9, "the typed pour figure is kept");
  assert.equal(cell(r, /pour/i, "pump_hr"), 8, "pump booked from 25 m³");
  assert.equal(cell(r, /finish/i, "concreter_day"), 0); assert.equal(cell(r, /washout|tidy/i, "labourer_day"), 0);
  assert.deepEqual(r.tasks.filter((t) => /Delivery of materials|^Boxing$/.test(t.name)).map((t) => [t.name, t.qtys.concreter_day]), [["Delivery of materials (yard works)", 2], ["Boxing", 2]], "spare rows renamed the way he names them");
  assert.equal(s2.steelMode, "subcontract"); assert.equal(cell(s2, /tie/i, "steelfixer_day"), 0); assert.equal(s2.qtys[HO.STEEL_FIX_KEY], 7.01, "suspended: tonnes on the Steel fix quote row");
  assert.equal(cell(s2, /excavat/i, "concreter_day"), undefined, "a suspended slab is never dug"); assert.equal(cell(s2, /pour/i, "pump_hr"), 8);
  assert.ok(s2.tasks.some((t) => t.name === "Collection of materials" && t.qtys.concreter_day === 1));
  assert.equal(sm.steelMode, "concreters"); assert.equal(cell(sm, /tie/i, "concreter_day"), 3); assert.equal(cell(sm, /tie/i, "steelfixer_day"), 0);
  assert.equal(cell(sm, /excavat/i, "bobcat_day"), undefined, "no bobcat on a substructure slab");
  assert.deepEqual(pr.tasks.map((t) => t.qtys), prelim.tasks.map((t) => t.qtys), "a prelim with no concrete is left alone");
  assert.match(HO.handoverSummary(q2.handover), /crew cells and 0 extra rows on 3 elements, steel fixing subcontracted on 1/); // Grady's sheet carries the delivery / boxing / collection rows itself — nothing is renamed
  // the tint follows the live value: a cell retyped is no longer "prefilled"
  const tint = HO.prefilledCells(q2.handover, r); assert.ok(tint[r.tasks.find((t) => /excavat/i.test(t.name)).id].excavator_day);
  const retyped = { ...r, tasks: r.tasks.map((t) => (/excavat/i.test(t.name) ? { ...t, qtys: { ...t.qtys, excavator_day: 2 } } : t)) };
  assert.ok(!HO.prefilledCells(q2.handover, retyped)[r.tasks.find((t) => /excavat/i.test(t.name)).id].excavator_day);
  // undo clears only untouched prefilled cells
  const edited = { ...q2, items: q2.items.map((it, i) => (i === 0 ? retyped : it)) };
  const u = HO.undoHandover(edited);
  assert.equal(cell(u.items[0], /excavat/i, "excavator_day"), 2, "the changed cell stays"); assert.equal(cell(u.items[0], /excavat/i, "concreter_day"), undefined, "the untouched one is cleared");
  assert.equal(cell(u.items[0], /pour/i, "concreter_day"), 9); assert.equal(u.items[1].qtys[HO.STEEL_FIX_KEY], undefined); assert.ok(u.handover.undoneAt);
  assert.ok(u.items[0].tasks.every((t) => !/Delivery of materials/.test(t.name) || t.qtys.concreter_day === undefined || t.qtys.concreter_day === ""), "the delivery row's prefilled cell is cleared (the row is Grady's own, it stays)");
  // the per-element steel switch overwrites the tie row deliberately, and back
  const sub = HO.applySteelMode(r, rates, "subcontract"); assert.equal(cell(sub, /tie/i, "steelfixer_day"), 0); assert.equal(sub.qtys[HO.STEEL_FIX_KEY], 2.97);
  const crew = HO.applySteelMode(sub, rates, "crew"); assert.equal(cell(crew, /tie/i, "steelfixer_day"), 8); assert.equal(crew.qtys[HO.STEEL_FIX_KEY], undefined, "an unpriced memo tonnage leaves with the mode");
  // the bands are production rates, editable in the Rates Library
  const tuned = { ...rates, [rateKey("PRODUCTION", "Handover: pour crew — base man-days", "days")]: { unitCost: 6 } };
  assert.equal(HO.handoverRate(tuned, "ho_pour_base_days"), 6); assert.equal(HO.handoverRate(rates, "ho_pour_base_days"), 4);
  assert.ok(PRODUCTION_RATES.filter((p) => p.key.startsWith("ho_")).length >= 20);
  // issues the banner and both reports list
  const issues = HO.handoverIssues([{ ...s2, additional: [{ id: "a", name: "Suspended beam rate", qty: 400 }] }, { ...r, label: "SCOPE REQUEST - Retaining Wall" }, { ...sm, label: "*** EXTERNAL QUOTE ITEMS ONLY ***", typeId: "screw_piles" }]);
  assert.deepEqual(issues.unpricedQuoteRows.map((x) => [x.label, x.product, x.qty]), [["Susp", "Steel fix", 7.01]]);
  assert.deepEqual(issues.halfEnteredAdditional.map((x) => x.missing), [["rate"]]);
  assert.deepEqual(issues.labelSuggestions.map((x) => x.to), ["Provisional Sum - Retaining Wall", "Screw Piles"]);
});

check("LIVE handover prefill (Grady, 13 Oct 2026): the crew sheets follow the quantities as they are typed — blank cells fill, cells still holding the pass's figure move with the quantity, a retyped cell is the estimator's, a cleared cell stays clear, a removed quantity clears what the pass wrote; same object when nothing moves; Undo switches it off; only on working statuses", () => {
  const rates = defaultRates();
  const T = (id) => ELEMENT_TYPES.find((t) => t.id === id);
  const bar = rateKey("PROCESSED BAR", "N12", "m"), conc = rateKey("CONCRETE", "32 mpa", "m3");
  const cell = (it, re, key) => (it.tasks.find((t) => re.test(t.name)) || { qtys: {} }).qtys[key];
  const raft = newElementItem(T("raft_foundation")); raft.label = "Raft";
  const q0 = { items: [raft], status: "Estimating" };
  { const s0 = HO.liveHandover(q0, rates, "t0"); assert.strictEqual(s0.items, q0.items, "nothing poured, nothing tied — no cell written"); assert.equal(s0.handover, undefined, "…and no record"); assert.equal(s0.handoverMode, "live"); assert.strictEqual(HO.liveHandover(s0, rates, "t0"), s0, "stamped once, then the same object"); }
  raft.qtys[conc] = 10; raft.qtys[bar] = 500;
  const q1 = HO.liveHandover({ items: [raft], status: "Estimating" }, rates, "t1");
  const r1 = q1.items[0];
  assert.equal(cell(r1, /excavat/i, "concreter_day"), 3); assert.equal(cell(r1, /pour/i, "concreter_day"), 5); assert.equal(cell(r1, /pour/i, "pump_hr"), undefined, "no pump under 25 m³"); assert.equal(r1.steelMode, "concreters");
  assert.deepEqual(r1.tasks.filter((t) => /Delivery of materials|^Boxing$/.test(t.name)).map((t) => [t.name, t.qtys.concreter_day]), [["Delivery of materials (yard works)", 2], ["Boxing", 2]]);
  assert.ok(q1.handover.live && q1.handover.at === "t1" && q1.handover.updatedAt === "t1");
  assert.strictEqual(HO.liveHandover(q1, rates, "t2"), q1, "a second run with nothing changed returns the same quote (no loop)");
  // the quantity grows: the held cells follow, the pump appears, the record moves
  const q3 = HO.liveHandover({ ...q1, items: q1.items.map((it) => ({ ...it, qtys: { ...it.qtys, [conc]: 60 } })) }, rates, "t3");
  const r3 = q3.items[0];
  assert.equal(cell(r3, /excavat/i, "concreter_day"), 5); assert.equal(cell(r3, /pour/i, "concreter_day"), 8); assert.equal(cell(r3, /pour/i, "pump_hr"), 8); assert.equal(q3.handover.at, "t1"); assert.equal(q3.handover.updatedAt, "t3");
  assert.ok(HO.prefilledCells(q3.handover, r3)[r3.tasks.find((t) => /pour/i.test(t.name)).id].concreter_day, "the moved cell still reads prefilled");
  // retype the pour, clear the excavate concreters
  const q5 = { ...q3, items: q3.items.map((it) => ({ ...it, tasks: it.tasks.map((t) => (/pour/i.test(t.name) ? { ...t, qtys: { ...t.qtys, concreter_day: 12 } } : /excavat/i.test(t.name) ? { ...t, qtys: { ...t.qtys, concreter_day: "" } } : t)) })) };
  const q6 = HO.liveHandover(q5, rates, "t4"); const r6 = q6.items[0];
  assert.equal(cell(r6, /pour/i, "concreter_day"), 12, "retyped — theirs"); assert.equal(cell(r6, /excavat/i, "concreter_day"), "", "cleared — stays clear"); assert.equal(q6.handover.cells.filter((c) => c.cleared).length, 1);
  assert.ok(!HO.prefilledCells(q6.handover, r6)[r6.tasks.find((t) => /pour/i.test(t.name)).id].concreter_day, "a retyped cell is no longer tinted");
  const q7 = HO.liveHandover({ ...q6, items: q6.items.map((it) => ({ ...it, qtys: { ...it.qtys, [conc]: 80 } })) }, rates, "t5"); const r7 = q7.items[0];
  assert.equal(cell(r7, /pour/i, "concreter_day"), 12, "a later quantity change never touches the retyped cell"); assert.equal(cell(r7, /excavat/i, "concreter_day"), "", "…or refills the cleared one"); assert.equal(cell(r7, /excavat/i, "excavator_day"), 2, "the other cells still follow");
  // the concrete removed: what the pass wrote is cleared again, spare rows revert, the retyped cell stays
  const q8 = HO.liveHandover({ ...q7, items: q7.items.map((it) => ({ ...it, qtys: { ...it.qtys, [conc]: "", [bar]: "" } })) }, rates, "t6"); const r8 = q8.items[0];
  assert.equal(cell(r8, /pour/i, "concreter_day"), 12); assert.equal(cell(r8, /excavat/i, "excavator_day"), undefined); assert.ok(r8.tasks.filter((t) => /Delivery of materials|^Boxing$/.test(t.name)).every((t) => t.qtys.concreter_day === undefined || t.qtys.concreter_day === ""), "the delivery and boxing rows stay (Grady's own) with their prefilled cells cleared"); assert.equal(q8.handover.cells.filter((c) => !c.cleared).length, 0);
  // undo switches the live prefill off; where it runs
  const u = HO.undoHandover(q7); assert.equal(u.handoverLive, false); assert.equal(u.handoverMode, "off"); assert.ok(!HO.handoverLiveOn(u)); assert.ok(u.handover.undoneAt);
  // ONE writer at a time (12 Nov 2026, 41 Wildcoast Road: a tab on a pre-9-Nov build and the current one re-planned a precast element at each other and wiped the figures being typed)
  {
    assert.equal(HO.HANDOVER_RULES_VER, 2);
    // the live pass stamps the rules version and stores the switch the way an older build reads as OFF
    assert.equal(q7.handover.rules, HO.HANDOVER_RULES_VER); assert.equal(q7.handoverLive, false); assert.equal(q7.handoverMode, "live"); assert.ok(HO.handoverLiveOn(q7) && HO.liveHandoverApplies({ ...q7, status: "Estimating" }));
    // …so a build from before the guard (it reads only `handoverLive !== false`) stands down on that copy
    const oldBuildApplies = (q) => !(!q || q.handoverLive === false);
    assert.ok(!oldBuildApplies(q7), "an older build never re-plans a project the current build has touched");
    // the ONE reading of the switch: the mode when set, else the old flag
    assert.ok(HO.handoverLiveOn({}) && HO.handoverLiveOn({ handoverLive: true }) && !HO.handoverLiveOn({ handoverLive: false }) && HO.handoverLiveOn({ handoverLive: false, handoverMode: "live" }) && !HO.handoverLiveOn({ handoverLive: true, handoverMode: "off" }));
    // a record planned by NEWER rules, or a tab that knows it is stale: this tab stands down
    assert.ok(!HO.liveHandoverApplies({ status: "Estimating", handover: { rules: HO.HANDOVER_RULES_VER + 1 } }), "a newer record is never re-planned by older rules");
    assert.ok(HO.liveHandoverApplies({ status: "Estimating", handover: { rules: HO.HANDOVER_RULES_VER } }) && HO.liveHandoverApplies({ status: "Estimating", handover: {} }));
    assert.ok(!HO.liveHandoverApplies({ status: "Estimating" }, { stale: true }), "a tab on an older build never re-plans");
    // a settled project is returned as the SAME object (no write), and one with nothing to prefill is still stamped once
    assert.equal(HO.liveHandover(q7, rates, "t9"), q7, "a second pass over a settled project writes nothing");
    const blank0 = { status: "Estimating", items: [] }; assert.equal(HO.liveHandover(blank0, rates, "t9"), blank0, "a project with no element is never written (a blank draft stays a draft)");
    // a precast panel never digs: the excavation row takes no crew from the pass, and figures typed on it stay
    const pt = ELEMENT_TYPES.find((t) => t.id === "precast_wall_panel"); const pi = newElementItem(pt); pi.qtys[rateKey("CONCRETE", "40 mpa", "m3")] = 29.2;
    const p1 = HO.liveHandover({ status: "Estimating", items: [pi] }, rates, "p1"); const excRow = (q) => q.items[0].tasks.find((t) => /excavat/i.test(t.name));
    assert.deepEqual(excRow(p1).qtys, {}, "no dig on a precast panel");
    const typedQ = { ...p1, items: p1.items.map((it) => ({ ...it, tasks: it.tasks.map((t) => (/excavat/i.test(t.name) ? { ...t, qty: 12, qtys: { concreter_day: 3, excavator_day: 2 } } : t)) })) };
    const p2 = HO.liveHandover(typedQ, rates, "p2"); assert.deepEqual(excRow(p2).qtys, { concreter_day: 3, excavator_day: 2 }, "typed figures on a row the pass does not plan are the estimator's"); assert.equal(excRow(p2).qty, 12);
    // cells an older build wrote there (recorded as the pass's own) are cleared ONCE, and the project then settles
    const foreign = { ...p1, items: p1.items.map((it) => ({ ...it, tasks: it.tasks.map((t) => (/excavat/i.test(t.name) ? { ...t, qtys: { concreter_day: 4, excavator_day: 1 } } : t)) })), handover: { ...p1.handover, rules: undefined, cells: p1.handover.cells.concat([{ itemId: pi.id, taskId: excRow(p1).id, key: "concreter_day", value: 4 }, { itemId: pi.id, taskId: excRow(p1).id, key: "excavator_day", value: 1 }]) } };
    const p3 = HO.liveHandover(foreign, rates, "p3"); assert.deepEqual(excRow(p3).qtys, {}, "the older build's dig cells are cleared"); assert.equal(HO.liveHandover(p3, rates, "p4"), p3, "…and the next pass writes nothing");
    const app2 = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.match(app2, /const setQuote = useCallback\(\(updater\) => \{ localEdits\.current \+= 1; setQuoteStored\(updater\); \}, \[setQuoteStored\]\);/, "every write made in this tab is counted");
    assert.match(app2, /if \(handoverRanFor\.current === localEdits\.current\) return; \/\/ nothing typed here since the last pass/, "the live pass runs after a local edit only, never in reaction to a remote copy");
    assert.match(app2, /setQuoteStored\(\(q\) => \(liveHandoverApplies\(q, \{ stale \}\) \? liveHandover\(q, effectiveRates\(q, liveRates\)\) : q\)\);/, "the pass's own write is not counted as a local edit");
    assert.match(app2, /return !!\(window\.parent && window\.parent\.gradconStaleBuild\);/, "the Quotes frame reads the shell's stale-build flag");
    const shell2 = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
    assert.match(shell2, /window\.gradconStaleBuild = true;/, "the shell flags a stale tab");
    // … and the switch STICKS in the database (same day: the two older tabs were mid-save every time the switch landed and wrote their stale copies straight back over it)
    const mig = fs.readFileSync(new URL("../supabase/migrations/0005_estimator_kv_keep_handover_switch.sql", import.meta.url), "utf8");
    assert.match(mig, /before update on public\.estimator_kv\s+for each row execute function public\.estimator_kv_keep_handover_switch\(\)/, "the trigger runs before every update");
    assert.match(mig, /new\.key like 'gradcon-quote-%'/, "project rows only");
    assert.match(mig, /old\.value \? 'handoverMode'\s+and not \(new\.value \? 'handoverMode'\)\s+and \(new\.value -> 'handoverLive'\) is distinct from 'false'::jsonb/, "only a value from before the rule, on a project that was switched");
    assert.match(mig, /'handoverMode', old\.value -> 'handoverMode',\s+'handoverLive', false/, "the stored mode is carried and the old flag held false");
    assert.ok(!/delete|truncate|drop table|security definer/i.test(mig), "the migration removes nothing and runs as the caller");
    assert.ok(fs.existsSync(new URL("./verify-handover-switch-sql.mjs", import.meta.url)), "the isolated-Postgres proof ships with it");
    // NOT THE LIVE SITE: a preview copy or a deployment's own frozen address says so, stands down and offers the live site
    assert.match(shell2, /const DEPLOY_ENV = "__DEPLOY_ENV__", PROD_HOST = "__PROD_HOST__";/, "the shell is told which deployment it is and where the live site is");
    assert.match(shell2, /host !== PROD_HOST && host !== "localhost" && host !== "127\.0\.0\.1"/, "the live host and a local build are never flagged");
    assert.match(shell2, /if\(DEPLOY_ENV === "preview"\)\{\s+notLive\(/, "a preview build says so without asking anyone");
    assert.match(shell2, /fetch\("https:\/\/" \+ PROD_HOST \+ "\/build\.txt\?" \+ Date\.now\(\), \{cache:"no-store"\}\)/, "any other address asks the live site for its build");
    assert.match(shell2, /shown = true; action = "live";\s+window\.gradconStaleBuild = true; window\.gradconNotLive = true;/, "a copy that is not the live site never re-plans a crew sheet");
    assert.match(shell2, /if\(action === "live"\) location\.href = "https:\/\/" \+ PROD_HOST \+ "\/"; else location\.reload\(\);/, "its button opens the live site");
    assert.match(shell2, /const checkAll = \(\)=>checkBuild\(\)\.then\(checkLive\);/, "the own-address check runs first (a reload fixes that one)");
    const asm2 = fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8");
    assert.match(asm2, /process\.env\.GRADCON_PROD_HOST \|\| process\.env\.VERCEL_PROJECT_PRODUCTION_URL \|\| "estimating-website\.vercel\.app"/, "the assembler names the live site");
    assert.match(asm2, /replaceAll\("__DEPLOY_ENV__", \/\^\[a-z\]\+\$\/\.test\(deployEnv\) \? deployEnv : ""\)\.replaceAll\("__PROD_HOST__", prodHost\)/, "… and bakes both into the shell");
    assert.match(asm2, /fs\.writeFileSync\(path\.join\(path\.dirname\(outPathFinal\), "build\.txt"\), stamp\.split\(" "\)\[0\] \+ "\\n"\);/, "… and writes the bare commit beside the page");
    const vj = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const bh = (vj.headers || []).find((h) => h.source === "/build.txt");
    assert.ok(bh && bh.headers.some((h) => h.key === "Access-Control-Allow-Origin" && h.value === "*") && bh.headers.some((h) => h.key === "Cache-Control" && h.value === "no-store"), "build.txt is readable from any origin and never cached");
  }
  assert.ok(HO.liveHandoverApplies({ status: "Estimating" }) && HO.liveHandoverApplies({ status: "Queued" }) && HO.liveHandoverApplies({}) && HO.liveHandoverApplies({ status: "Completed Estimating", completedAt: "2026-10-13" }));
  assert.ok(!HO.liveHandoverApplies({ status: "Submitted" }) && !HO.liveHandoverApplies({ status: "On Hold" }) && !HO.liveHandoverApplies({ status: "Completed Estimating", completedAt: "2026-09-01" }) && !HO.liveHandoverApplies({ status: "Estimating", handoverLive: false }));
  // the editor runs it on every change to the elements, the banner says it is live
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assertTrue(/liveHandover\(q, effectiveRates\(q, liveRates\)\)/.test(app) && /\[quoteStatus, ratesStatus, quote\.status, quote\.items, quote\.handoverMode, quote\.handoverLive, quote\.completedAt, liveRates\]/.test(app) && !/shouldAutoHandover\(quote\)\) setQuote/.test(app));
  const banner = fs.readFileSync(new URL("../src/components/HandoverBanner.jsx", import.meta.url), "utf8");
  assertTrue(/data-testid="handover-live"/.test(banner) && /liveHandoverApplies\(quote\)/.test(banner));
});

check("Tender prices: drift against today's figures is reported and refreshed without losing edits; attention company prefills from the client", () => {
  const rates = defaultRates();
  const raft = newElementItem(ELEMENT_TYPES.find((t) => t.id === "raft_foundation")); raft.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 20;
  const quote = { items: [raft], overheadPct: 0, contingencyPct: 0, clientName: "Belair Builders" };
  const tq = { ...tenderPrefill(newTenderQuote(), quote), items: seedTenderItems(quote, quote.items, rates) };
  assert.equal(tq.attentionCompany, "Belair Builders");
  assert.deepEqual(tenderPriceDrift({ ...quote, tenderQuote: tq }, quote.items, rates), { changed: [], missing: [] }, "fresh seed = no drift");
  tq.items[0].lines[0].text = "edited point";
  raft.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 40;
  const d = tenderPriceDrift({ ...quote, tenderQuote: tq }, quote.items, rates);
  assert.equal(d.changed.length, 1); assert.notEqual(d.changed[0].stored, d.changed[0].fresh); assert.equal(d.changed[0].elementId, raft.id, "drift is reported per element row");
  const fresh = refreshTenderPrices({ ...quote, tenderQuote: tq }, quote.items, rates, "2026-10-09T00:00:00Z");
  assert.equal(fresh.items[0].lines[0].price, d.changed[0].fresh); assert.equal(fresh.items[0].lines[0].text, "edited point", "dot points survive a price refresh"); assert.equal(fresh.pricesAt, "2026-10-09T00:00:00Z");
  assert.deepEqual(tenderPriceDrift({ ...quote, tenderQuote: fresh }, quote.items, rates).changed, []);
  // a tender from before the stage layout (level items with points, no row prices) is compared by title and its price moved as before
  const legacy = { ...tq, items: [{ id: "L", title: "Ground Floor", price: "$1.00 + GST", points: ["Raft — approx. 40 m³ concrete", "", "", ""] }] };
  const dl = tenderPriceDrift({ ...quote, tenderQuote: legacy }, quote.items, rates);
  assert.equal(dl.changed.length, 1); assert.equal(dl.changed[0].fresh, d.changed[0].fresh);
  const fl = refreshTenderPrices({ ...quote, tenderQuote: legacy }, quote.items, rates, "2026-10-09T00:00:00Z");
  assert.equal(fl.items[0].price, d.changed[0].fresh); assert.equal(fl.items[0].lines[0].text, "Raft — approx. 40 m³ concrete");
});

await checkAsync("Tender STAGES (Grady, 13 Oct 2026): the fixed list, placement by rule — the level named anywhere in the label or type, retention by name, columns under the level they rise from, the rest on the lowest level — reproduces the colour-coded printed quote; per-element rows carry their own price and the stage total is their sum", async () => {
  const TQ = await import("../src/lib/tenderQuoteDefaults.js");
  assert.deepEqual(TQ.TENDER_STAGES.map((s) => s.title), ["Retention", "Basement", "Lower Ground", "Ground Floor", "First Floor", "Second Floor", "Roof", "External Works"]);
  assert.equal(TQ.levelStage("Strip Footings - Basement"), "basement"); assert.equal(TQ.levelStage("RC Columns - Basement to Ground floor"), "basement", "the FIRST level named is the one the column rises from");
  assert.equal(TQ.levelStage("Suspended Raft - Ground Floor"), "ground"); assert.equal(TQ.levelStage("L1 slab"), "first"); assert.equal(TQ.levelStage("Level 2 columns"), "second"); assert.equal(TQ.levelStage("Level 3 slab"), "second", "a level above the second lands on Second Floor");
  assert.equal(TQ.levelStage("Lower ground walls"), "lower_ground"); assert.equal(TQ.levelStage("Rooftop plant deck"), "roof"); assert.equal(TQ.levelStage("Pad Footings"), null);
  const rates = defaultRates(); const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE").products[0];
  const T = (id) => ELEMENT_TYPES.find((t) => t.id === id); const byName = (re) => ELEMENT_TYPES.find((t) => re.test(t.name));
  const mk = (type, label, m3) => { const it = newElementItem(type); it.label = label; it.qtys[rateKey("CONCRETE", conc.name, conc.unit)] = m3; return it; };
  const els = [mk(byName(/bored pier/i), "Piles - Bored Piers", 30), mk(byName(/capping beam/i), "Capping Beam", 10), mk(byName(/shotcrete/i), "Shotcrete Retention Wall", 20),
    mk(T("strip_footings"), "Strip Footings - Basement", 18), mk(T("strip_footings"), "Pad Footings", 5), mk(byName(/^Basement Slab$/), "Slab", 30), mk(byName(/^Basement Ramp$/), "Driveway Ramp", 12),
    mk(ELEMENT_TYPES.find((t) => t.category === "VERTICAL STRUCTURE"), "RC Columns - Basement to Ground floor", 3), mk(T("strip_footings"), "Strip Footings - Ground Floor", 20), mk(T("raft_foundation"), "Suspended Raft - Ground Floor", 60), mk(T("suspended_slab"), "Suspended Slab", 50), mk(ELEMENT_TYPES.find((t) => t.category === "EXTERNAL & LANDSCAPE CONCRETE"), "Driveway", 8)];
  assert.deepEqual(els.map((e) => TQ.defaultStageFor(e, els)), ["retention", "retention", "retention", "basement", "basement", "basement", "basement", "basement", "ground", "ground", "ground", "external"]);
  assert.equal(TQ.lowestLevel([{ label: "Ground slab" }, { label: "Lower ground wall" }]), "lower_ground"); assert.equal(TQ.lowestLevel([{ label: "Slab" }]), "ground");
  const quote = { overheadPct: 0.08, contingencyPct: 0.05, items: els };
  const seeded = TQ.seedTenderItems(quote, els, rates);
  assert.deepEqual(seeded.map((s) => [s.stage, s.title, s.lines.length]), [["retention", "Retention", 3], ["basement", "Basement", 5], ["ground", "Ground Floor", 3], ["external", "External Works", 1]], "stage items in the fixed order, only the stages used");
  const ret = seeded[0];
  assert.ok(ret.lines.every((l) => l.elementId && /^\$[\d,]+\.\d\d \+ GST$/.test(l.price)), "every row names its element and carries its own price");
  assert.equal(ret.price, "", "a stage total is never typed"); assert.equal(TQ.itemPriceValue(ret), ret.lines.reduce((t, l) => t + TQ.parseTenderPrice(l.price), 0)); assert.ok(/^\$[\d,]+\.\d\d \+ GST$/.test(TQ.itemPriceLabel(ret)));
  assert.deepEqual(seeded[0].points, seeded[0].lines.map((l) => l.text), "points mirror the rows for a build that still reads them");
  const sum = TQ.computeTenderProjectSum({ items: seeded });
  assert.ok(Math.abs(sum.itemsSum - seeded.reduce((t, it) => t + TQ.itemPriceValue(it), 0)) < 0.005, "the project sum adds the stage totals");
  // a hand-added item (no rows priced) keeps its typed price; a legacy points item reads as rows with no element
  assert.equal(TQ.itemPriceValue({ id: "x", title: "Extra", price: "$5.00 + GST", lines: [{ id: "r", elementId: null, text: "typed", price: "" }] }), 5);
  const legacy = TQ.normalizeTenderItems([{ id: "a", title: "Basement", price: "$9.00 + GST", points: ["x", "", ""] }])[0];
  assert.deepEqual(legacy.lines.map((l) => [l.elementId, l.text, l.price]), [[null, "x", ""]]); assert.equal(TQ.itemPriceValue(legacy), 9);
  // regroup: a row moved to another stage, recorded on elementStages, honoured by the next seed; an emptied stage disappears
  const colId = els[7].id;
  const rg = TQ.regroupByStage(seeded, (l) => (l.elementId === colId ? "ground" : null));
  assert.deepEqual(rg.items.map((s) => [s.stage, s.lines.length]), [["retention", 3], ["basement", 4], ["ground", 4], ["external", 1]]); assert.equal(rg.elementStages[colId], "ground");
  const re = TQ.seedTenderItems({ ...quote, tenderQuote: { elementStages: { [colId]: "roof", [els[11].id]: "retention" } } }, els, rates);
  assert.deepEqual(re.map((s) => [s.stage, s.lines.length]), [["retention", 4], ["basement", 4], ["ground", 3], ["roof", 1]], "the recorded placement wins over the rule");
  // drift per element, and a new element joins its stage on refresh (the stage item created in order when the tender lacks it)
  const tq = { ...TQ.newTenderQuote(), items: rg.items, elementStages: rg.elementStages };
  assert.deepEqual(TQ.tenderPriceDrift({ ...quote, tenderQuote: tq }, els, rates), { changed: [], missing: [] });
  const els2 = els.concat([mk(T("suspended_slab"), "First Floor Slab", 22)]);
  const d = TQ.tenderPriceDrift({ ...quote, tenderQuote: tq }, els2, rates);
  assert.equal(d.changed.length, 0); assert.equal(d.missing.length, 1); assert.ok(/^First Floor · /.test(d.missing[0].title));
  const fr = TQ.refreshTenderPrices({ ...quote, tenderQuote: tq }, els2, rates, "2026-10-13T00:00:00Z");
  assert.deepEqual(fr.items.map((s) => s.stage), ["retention", "basement", "ground", "first", "external"]); assert.equal(fr.items[3].lines[0].elementId, els2[12].id);
  // the editor, the review and the print
  const src = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(/normalizeTenderItems\(tq\.items \|\| \[\]\)/.test(src) && /data-testid="items-placement-review"/.test(src) && /data-testid="placement-row"/.test(src) && /regroupByStage\(worded/.test(src) && /elementStages: \{ \.\.\.\(tq\.elementStages \|\| \{\}\), \.\.\.rg\.elementStages \}/.test(src) && /data-testid="stage-total"/.test(src) && /data-testid="print-row"/.test(src) && /moveRow\(row\.id, e\.target\.value\)/.test(src) && /stages: TENDER_STAGES/.test(src), "editor rows with price + stage select, placement review, regroup on apply, per-row print");
  assertTrue(/title: l\.stage \? l\.title : \(r\.newTitle\.trim\(\) \|\| l\.title\)/.test(src), "a stage title never changes through the reword");
});

await checkAsync("Tender '+ GST' toggle (Grady, 13 Oct 2026): gstSuffix off prints every price as a plain figure, stored strings untouched; the Project Sum editor carries the toggle and the print reads every price through printedPrice", async () => {
  const TQ = await import("../src/lib/tenderQuoteDefaults.js");
  assert.equal(TQ.printedPrice("$316,852.45 + GST", { gstSuffix: false }), "$316,852.45"); assert.equal(TQ.printedPrice("$40.00/m3 +GST", { gstSuffix: false }), "$40.00/m3");
  assert.equal(TQ.printedPrice("$316,852.45 + GST", { gstSuffix: true }), "$316,852.45 + GST"); assert.equal(TQ.printedPrice("$1.00 + GST", {}), "$1.00 + GST", "a tender saved before the toggle keeps the suffix");
  assert.equal(TQ.newTenderQuote().gstSuffix, true);
  const src = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(/data-testid="gst-suffix-toggle"/.test(src) && /printedPrice\(itemPriceLabel\(l\), tq\)/.test(src) && /printedPrice\(r\.price, tq\)/.test(src) && /printedPrice\(o\.price, tq\)/.test(src) && /ps\.gstOn \|\| !gstSuffixOn\(tq\) \? "" : " \+ GST"/.test(src));
});
await checkAsync("Tender STAGES: the reword request carries every element with its stage and the fixed stage list, the prompt asks for a placement by key (columns never a stage of their own), parseTenderPlacement keeps only known elements and stage keys, the server answers placement, and the spec context finds a row's element by id", async () => {
  const TQ = await import("../src/lib/tenderQuoteDefaults.js"); const TW = await import("../src/lib/tenderWording.js"); const SC = await import("../src/lib/tenderSpecContext.js");
  const elements = [{ id: "e1", name: "RC Columns - Basement to Ground floor", type: "Columns", category: "VERTICAL STRUCTURE", stage: "ground" }, { id: "e2", name: "Piles", type: "Bored Piers", category: "FOUNDATIONS", stage: "basement" }];
  const items = [{ id: "L1", title: "Ground Floor", points: ["RC Columns - Basement to Ground floor — approx. 3 m³ concrete"] }];
  const pr = TW.tenderItemsPrompt({ projectName: "P", items, elements, stages: TQ.TENDER_STAGES });
  assertTrue(/PLACEMENT:/.test(pr) && /Columns and walls are NEVER a stage of their own/.test(pr) && /"placement":\[\{"id":"<element id>","stage":"<stage key>"\}\]/.test(pr) && /STAGES \(JSON\):/.test(pr) && /"key":"retention","title":"Retention"/.test(pr) && /ELEMENTS \(JSON\):/.test(pr) && /"id":"e1","name":"RC Columns - Basement to Ground floor"/.test(pr) && /keep a stage title EXACTLY as given/.test(pr), "prompt");
  assertTrue(!/PLACEMENT:/.test(TW.tenderItemsPrompt({ projectName: "P", items })), "no elements → no placement block");
  const pl = TW.parseTenderPlacement('{"items":[],"placement":[{"id":"e1","stage":"basement"},{"id":"e2","stage":"retention"},{"id":"zz","stage":"ground"},{"id":"e1","stage":"mezzanine"}]}', { elements, stages: TQ.TENDER_STAGES });
  assert.deepEqual(pl, { e1: "basement", e2: "retention" });
  let posted = null;
  const r = await TW.requestTenderItemsWording(items, { projectName: "P", base: "https://x.test", elements, stages: TQ.TENDER_STAGES, fetchImpl: async (url, opts) => { posted = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ items: [], placement: { e1: "basement", e2: "nowhere" }, provider: "anthropic", model: "m" }) }; } });
  assert.deepEqual(posted.elements, elements); assert.deepEqual(posted.stages, TQ.TENDER_STAGES); assert.deepEqual(r.placement, { e1: "basement" }, "a stage key the list lacks is dropped");
  // the server: the element and stage lists are validated and bounded, the placement read from the model's reply and returned beside the items
  const apiSrc = fs.readFileSync(new URL("../api/ai-engine.js", import.meta.url), "utf8");
  assertTrue(/parseTenderPlacement/.test(apiSrc) && /const stages = Array\.isArray\(body\.stages\)/.test(apiSrc) && /slice\(0, 80\)/.test(apiSrc) && /placement, provider: r\.provider/.test(apiSrc) && /tenderItemsPrompt\(\{ projectName, items: lineItems, spec, options, sections, elements, stages \}\)/.test(apiSrc), "server placement path");
  // spec context: a stage row names its element by id even when its text does not
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings"); const el = newElementItem(strip); el.id = "q1"; el.label = "Strip Footings - Basement"; el.qtys[rateKey("PROCESSED BAR", "N12", "m")] = 100;
  const ctx = SC.tenderSpecContext({ quote: { projectName: "P" }, items: [el], lineItems: [{ id: "S", stage: "basement", title: "Basement", lines: [{ id: "r1", elementId: "q1", name: el.label, text: "Reinforced concrete footings — approx. 10 m³", price: "$1.00 + GST" }] }], takeoff: null });
  assert.equal(ctx.points[0].element, "Strip Footings - Basement"); assert.equal(ctx.matched.quote, 1);
});

check("Tender Notes = the project's Assumptions first (recorded order, blanks dropped), then the typed notes, bulleted once each", () => {
  const quote = { assumptions: [{ id: "a", text: "Paving slab thickness 150mm and SL82 mesh" }, { id: "b", text: "   " }, { id: "c", text: "External and all staircases excluded" }] };
  assert.deepEqual(assumptionLines(quote), ["Paving slab thickness 150mm and SL82 mesh", "External and all staircases excluded"]);
  const n = tenderNoteLines(quote, "Rock excavation not allowed for\n\n- Site access from Beach Road only\n");
  assert.deepEqual(n.assumptions, ["Paving slab thickness 150mm and SL82 mesh", "External and all staircases excluded"]);
  assert.deepEqual(n.typed, ["Rock excavation not allowed for", "Site access from Beach Road only"], "typed notes follow, a leading bullet mark stripped (the report prints its own)");
  assert.deepEqual(n.all, [...n.assumptions, ...n.typed]);
  // a typed line that repeats an assumption (hand-pasted before this existed) or an earlier typed line prints once
  const d = tenderNoteLines(quote, "• external and all staircases EXCLUDED\nRock excavation not allowed for\nRock excavation not allowed for");
  assert.deepEqual(d.all, ["Paving slab thickness 150mm and SL82 mesh", "External and all staircases excluded", "Rock excavation not allowed for"]);
  // legacy quotes (no assumptions) and blank reports
  assert.deepEqual(tenderNoteLines({}, ""), { assumptions: [], typed: [], all: [] });
  assert.deepEqual(tenderNoteLines(undefined, undefined).all, []);
  assert.deepEqual(typedNoteLines("a\nb"), ["a", "b"]);
});

{
  // Tender wording for the assumptions (src/lib/tenderWording.js) — Grady, 11 Oct 2026: "language reconstruction for the assumptions before pushing to the tender quote"
  const TW = await import("../src/lib/tenderWording.js");
  const TN = await import("../src/lib/tenderNotes.js");
  const E = await import("../api/ai-engine.js");
  const raw = [{ id: "a", text: "Paving slab thickness 150mm and SL82 mesh reinforcment" }, { id: "b", text: "External Staircase excluded" }, { id: "c", text: "Hydronics: Zones 2B and 3B excluded as is under tile - confirm these are included." }];
  const reply = '```json\n{"lines":[{"id":"a","tender":"A paving slab thickness of 150 mm with SL82 mesh reinforcement has been assumed and is to be confirmed by the engineer."},{"id":"b","tender":"The external staircase is excluded from our price."},{"id":"zzz","tender":"ignored"}]}\n```';
  check("tenderWording: the reply is read by id (fenced JSON tolerated, unknown ids dropped, a missing line left out), applied as tenderText + tenderSource, and the Tender Notes print the tender wording while the typed text stands", () => {
    const map = TW.parseTenderWording(reply, raw);
    assertTrue(Object.keys(map).join() === "a,b" && /150 mm with SL82/.test(map.a), JSON.stringify(map));
    const after = TW.applyTenderWording(raw, map);
    assertTrue(after[0].tenderText === map.a && after[0].tenderSource === raw[0].text && after[0].text === raw[0].text && after[2].tenderText === undefined);
    assertTrue(TW.wordingState(after[0]) === "reworded" && TW.wordingState(after[2]) === "none");
    const lines = TN.assumptionLines({ assumptions: after });
    assertTrue(lines[0] === map.a && lines[1] === map.b && lines[2] === raw[2].text, JSON.stringify(lines));
    const items = TN.assumptionNoteItems({ assumptions: after });
    assertTrue(items[0].state === "reworded" && items[0].text === raw[0].text && items[2].state === "none");
    // the original edited after the rewording: stale, the accepted wording still prints, clearing it restores the typed text
    const edited = after.map((a) => (a.id === "a" ? { ...a, text: "Paving slab 180mm and SL82" } : a));
    assertTrue(TW.wordingState(edited[0]) === "stale" && TN.assumptionNoteItems({ assumptions: edited })[0].state === "stale" && TN.assumptionLines({ assumptions: edited })[0] === map.a);
    const cleared = TW.clearTenderWording(edited, "a");
    assertTrue(TW.wordingState(cleared[0]) === "none" && TN.assumptionLines({ assumptions: cleared })[0] === "Paving slab 180mm and SL82" && !("tenderText" in cleared[0]));
    // positional fallback when the model drops the ids
    const pos = TW.parseTenderWording('{"lines":["First line","Second line"]}', raw);
    assertTrue(pos.a === "First line" && pos.b === "Second line" && !pos.c);
  });
  check("tenderWording: the prompt carries every assumption with its id, forbids new facts and asks for the trade's forms (allowance / excluded / to be confirmed) in one JSON object", () => {
    const pr = TW.tenderWordingPrompt({ projectName: "145 Harrisons Rd", assumptions: raw });
    assertTrue(/145 Harrisons Rd/.test(pr) && /"id":"c"/.test(pr) && /add NOTHING/.test(pr) && /Allowance has been made for/.test(pr) && /excluded from our price/.test(pr) && /to be confirmed/.test(pr) && /Please confirm/.test(pr) && /\{"lines":\[\{"id"/.test(pr) && /Do not merge or split/.test(pr));
  });
  await checkAsync("tenderWording: the server action rejects an empty list (400) and answers 503 with no provider; requestTenderWording posts action tender-wording to the portal origin and reads lines back (missing ids reported)", async () => {
    const bad = await E.runAiJob({ action: "tender-wording", assumptions: [] }, {});
    const noProv = await E.runAiJob({ action: "tender-wording", assumptions: raw }, {});
    assertTrue(bad.status === 400 && noProv.status === 503, JSON.stringify([bad, noProv]));
    let posted = null;
    const fetchImpl = async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ lines: [{ id: "a", tender: "Line A." }, { id: "c", tender: "Please confirm zones 2B and 3B." }], provider: "anthropic", model: "m" }) }; };
    const r = await TW.requestTenderWording(raw, { projectName: "P", provider: "openai", fetchImpl, base: "https://portal.test" });
    assertTrue(posted.url === "https://portal.test/api/ai-engine" && posted.body.action === "tender-wording" && posted.body.provider === "openai" && posted.body.assumptions.length === 3 && posted.body.assumptions[0].id === "a" && r.wording.a === "Line A." && r.missing.join() === "b" && r.model === "m", JSON.stringify([posted, r]));
    let failed = null; try { await TW.requestTenderWording(raw, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "No AI provider is configured" }) }), base: "x" }); } catch (e) { failed = e; }
    assertTrue(failed && /No AI provider/.test(failed.message));
    assertTrue(TW.preferredProvider({ getItem: () => JSON.stringify({ aiProvider: "openai" }) }) === "openai" && TW.preferredProvider({ getItem: () => "nope" }) === null);
  });
  check("tenderWording: the Tender Notes cell offers the reword step with review (ticks, editable proposals, apply), both reports thread onChangeAssumptions from App, and the Assumptions list shows the wording with a clear button", () => {
    const cell = fs.readFileSync(new URL("../src/components/TenderNotesCell.jsx", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const geo = fs.readFileSync(new URL("../src/components/ProjectGeometryPanel.jsx", import.meta.url), "utf8");
    assertTrue(/data-testid="reword-for-tender"/.test(cell) && /data-testid="tender-wording-review"/.test(cell) && /data-testid="apply-tender-wording"/.test(cell) && /requestTenderWording\(/.test(cell) && /applyTenderWording\(/.test(cell) && (app.match(/onChangeAssumptions=\{\(assumptions\) => setQuote/g) || []).length === 4 && /data-testid="assumption-tender-wording"/.test(geo) && /clearTenderWording\(/.test(geo));
  });
}

check("Tender quote itemises EVERY element of a level — one dot point each, never 'plus N further items' (Grady, 13 Oct 2026); count, run and area precede the concrete", () => {
  const rates = defaultRates();
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE").products[0];
  const els = ["Piles", "Capping Beam", "Strip Footings", "RC Columns", "Shotcrete Wall", "Lift Pit"].map((n, i) => { const it = newElementItem(strip); it.label = `Basement - ${n}`; it.qtys[rateKey("CONCRETE", conc.name, conc.unit)] = 10 + i; if (i === 0) it.measureNo = 16; if (i === 1) it.measureLm = 42; return it; });
  const seeded = seedTenderItems({ overheadPct: 0.08, contingencyPct: 0.05 }, els, rates);
  assertTrue(seeded.length === 1 && seeded[0].title === "Basement", JSON.stringify(seeded.map((s) => s.title)));
  const pts = seeded[0].points.filter(Boolean);
  assertTrue(pts.length === 6 && !pts.some((p) => /further items|combined/.test(p)) && /^Piles — 16 no\. \/ approx\. 10 m³ concrete$/.test(pts[0]) && /^Capping Beam — approx\. 42 lm \/ approx\. 11 m³ concrete$/.test(pts[1]) && /^Lift Pit — approx\. 15 m³ concrete$/.test(pts[5]), JSON.stringify(pts));
  // the Tender Quote editor shows every point (plus a spare box) and the print lists them all
  const src = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(!/\.slice\(0, 4\)\.map\(\(p, i\)/.test(src) && /"tender-row-spare"/.test(src) && /data-testid="reword-items"/.test(src) && /data-testid="items-wording-review"/.test(src) && /requestTenderItemsWording\(/.test(src));
});
check("Tender quote: a tender seeded earlier with a 'plus N further items' roll-up is found (rolledUpItems) and itemiseRolledUp replaces ONLY those points from a fresh seed, keeping titles, prices and other lines", async () => {
  const TQ = await import("../src/lib/tenderQuoteDefaults.js");
  const rates = defaultRates();
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE").products[0];
  const els = ["Piles", "Capping Beam", "Strip Footings", "RC Columns", "Shotcrete Wall"].map((n, i) => { const it = newElementItem(strip); it.label = `Basement - ${n}`; it.qtys[rateKey("CONCRETE", conc.name, conc.unit)] = 10 + i; return it; });
  const quote = { overheadPct: 0.08, contingencyPct: 0.05, tenderQuote: { ...TQ.newTenderQuote(), items: [
    { id: "a", title: "Basement", price: "$999.00 + GST", points: ["Piles — approx. 10 m³ concrete", "Capping Beam — approx. 11 m³ concrete", "Strip Footings — approx. 12 m³ concrete", "plus 2 further items — approx. 27 m³ concrete combined"] },
    { id: "b", title: "Extras", price: "$5.00 + GST", points: ["typed by hand", "", "", ""] },
  ] } };
  assertTrue(TQ.rolledUpItems(quote.tenderQuote).map((r) => r.id).join() === "a" && TQ.ROLLUP_POINT.test("plus 1 further item"));
  const next = TQ.itemiseRolledUp(quote, els, rates);
  const a = next.items.find((i) => i.id === "a"), b = next.items.find((i) => i.id === "b");
  assertTrue(a.price === "$999.00 + GST" && a.title === "Basement" && a.points.filter(Boolean).length === 5 && !a.points.some((p) => /further/.test(p)) && /Shotcrete Wall/.test(a.points[4]) && b.points[0] === "typed by hand" && b.price === "$5.00 + GST" && TQ.rolledUpItems(next).length === 0, JSON.stringify(next.items));
  const src = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(/data-testid="tender-itemise"/.test(src) && /itemiseRolledUp\(/.test(src));
});
await checkAsync("Tender spec context (Grady, 13 Oct 2026): each dot point carries its quote element's priced rows and description and the same-named takeoff elements (fields + register lines, v1 or v2 rows); the takeoff is found by project name; the prompt folds the context in with industry-language rules; options and sections ride along and parse back", async () => {
  const SC = await import("../src/lib/tenderSpecContext.js");
  const ER = await import("../src/lib/estimatesRead.js");
  const TW = await import("../src/lib/tenderWording.js");
  const rates = defaultRates();
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE").products.find((p) => /^40 mpa$/i.test(p.name)) || FULL_CATALOG.find((c) => c.key === "CONCRETE").products[0];
  const bar = FULL_CATALOG.find((c) => c.key === "PROCESSED BAR").products[0];
  const piles = { ...newElementItem(strip), label: "Basement - Piles", description: "600 dia bored piers to engineer's detail", qtys: { [rateKey("CONCRETE", conc.name, conc.unit)]: 35.28, [rateKey("PROCESSED BAR", bar.name, bar.unit)]: 1.2, [rateKey("CONCRETE", "Minimum cartage", "m3")]: 2 }, rateOverrides: { "SUB CONTRACTORS / TEMPORARY WORKS::Piling::quote": { unitCost: 50000 } } };
  const slab = { ...newElementItem(strip), label: "Ground Floor - Slab", qtys: {} };
  assertTrue(SC.elementNameForTender("Basement - Piles") === "Piles" && SC.elementNameForTender("Ground Floor Raft") === "Raft");
  const rows = SC.quoteElementSpec(piles);
  assertTrue(rows[0].category === "CONCRETE" && rows[0].product === conc.name && rows[0].qty === 35.28 && rows.some((r) => r.category === "PROCESSED BAR") && rows.some((r) => r.note === "subcontract quote received" && r.product === "Piling") && !rows.some((r) => /cartage/i.test(r.product)), JSON.stringify(rows));
  const instV2 = { id: "i1", label: "Piles", typeKey: "pier", data: { grade: 40, cover: 50, dia: 600, depth: 6000, vDia: "N16", vBars: 6, ligDia: "N10", genSpacing: 200, qty: 16, extraConn: [] }, results: { lines: [{ materialGroup: "Concrete", material: "N40 concrete", spec: "600 dia", finalQty: 35.28, unit: "m³" }, { materialGroup: "Reinforcement", material: "N16", spec: "vertical bars", finalQty: 640, unit: "m" }, { materialGroup: "Excavation", material: "Bored spoil", finalQty: 40, unit: "m³" }, { materialGroup: "Formwork", material: "x", finalQty: 0, unit: "m²" }] } };
  const spec1 = SC.takeoffElementSpec(instV2);
  assertTrue(spec1.fields.grade === 40 && spec1.fields.dia === 600 && spec1.fields.vDia === "N16" && !("extraConn" in spec1.fields) && spec1.lines.length === 3 && spec1.lines[0].material === "N40 concrete" && spec1.lines[0].qty === 35.28, JSON.stringify(spec1));
  assertTrue(SC.takeoffMatches([instV2, { label: "Basement Strip Footings 1", data: {} }], "Basement - Piles").length === 1 && SC.takeoffMatches([instV2], "Ground Floor - Slab").length === 0);
  assertTrue(SC.elementForPoint("Piles — 16 no. / approx. 35.28 m³ concrete", [piles, slab]) === piles && SC.elementForPoint("Slab — approx. 255 m²", [piles, slab]) === slab && SC.elementForPoint("Nothing here", [piles, slab]) === null);
  const lineItems = [{ id: "L1", title: "Basement", points: ["Piles — 16 no. / approx. 35.28 m³ concrete", "", "Unknown thing — approx. 1 m³ concrete"] }, { id: "L2", title: "Ground Floor", points: ["Slab — approx. 255 m²"] }];
  const ctx = SC.tenderSpecContext({ quote: { projectName: "40 Jacksons Road", clientName: "RACM" }, items: [piles, slab], lineItems, takeoff: { name: "40 Jacksons Road, Mount Eliza", instances: [instV2] } });
  assertTrue(ctx.points.length === 3 && ctx.points[0].element === "Basement - Piles" && ctx.points[0].description === "600 dia bored piers to engineer's detail" && ctx.points[0].quoteRows.length >= 2 && ctx.points[0].takeoff.length === 1 && ctx.points[0].takeoff[0].fields.dia === 600 && ctx.points[1].element === null && ctx.points[1].takeoff.length === 0 && ctx.points[2].element === "Ground Floor - Slab" && ctx.matched.quote === 2 && ctx.matched.takeoff === 1 && ctx.takeoff.name === "40 Jacksons Road, Mount Eliza", JSON.stringify(ctx).slice(0, 600));
  // a huge context trims its line and row lists, never a point
  const big = { ...instV2, results: { lines: new Array(400).fill(0).map((_, i) => ({ materialGroup: "Reinforcement", material: "N16 bar number " + i + " with a long specification string ".repeat(6), finalQty: 1, unit: "m" })) } };
  const bigCtx = SC.tenderSpecContext({ quote: { projectName: "P" }, items: [piles], lineItems: [{ id: "L", title: "B", points: new Array(30).fill("Piles — approx. 1 m³ concrete") }], takeoff: { name: "P", instances: [big, big, big, big] }, maxChars: 30000 });
  assertTrue(bigCtx.points.length === 30 && JSON.stringify(bigCtx).length < 45000 && bigCtx.points[0].takeoff.length === 1 && bigCtx.points[0].takeoff[0].lines.length <= 3, String(JSON.stringify(bigCtx).length));
  // the takeoff is found by project name (exact, then containment, newest wins) in either row schema
  const idx = [{ id: "a", key: "gradcon-estimate-state::a", name: "40 Jacksons Road, Mount Eliza", savedAt: "2026-10-01" }, { id: "b", key: "gradcon-estimate-state::b", name: "Other job", savedAt: "2026-10-05" }, { id: "c", key: "gradcon-estimate-state::c", name: "40 Jacksons Road", savedAt: "2026-09-01", deleted: true }];
  assertTrue(SC.findTakeoffEntry(idx, "40 Jacksons Road - Concrete").id === "a" && SC.findTakeoffEntry(idx, "Nope") === null && SC.findTakeoffEntry(idx, "41 Jacksons Road") === null, "street numbers tell jobs apart");
  assertTrue(SC.projectNameScore("145 Harrisons Rd - Concrete Structure Package", "145 Harrisons Road") === 1 && SC.projectNameScore("3206 Point Nepean Rd", "3206 Point Nepean Road, Sorrento") === 1 && SC.projectNameScore("25 Spindrift Ave", "18 Beach Road") === 0 && SC.projectNameTokens("145 Harrisons Rd.").join() === "145,harrisons,road");
  assertTrue(SC.takeoffSnapshot({ INSTANCES: [instV2], PROJECT: { name: "x" } }).instances.length === 1 && SC.takeoffSnapshot({ instances: [], project: {} }).instances.length === 0 && SC.takeoffSnapshot({ foo: 1 }) === null);
  const store = { "gradcon-estimate-projects-index": idx, "gradcon-estimate-state::a": { INSTANCES: [instV2], PROJECT: { name: "40 Jacksons Road, Mount Eliza" } } };
  const tk = await ER.readTakeoffForProject("40 Jacksons Road", { cloudValue: async (k) => (k in store ? store[k] : null), localValue: () => null });
  assertTrue(tk && tk.name === "40 Jacksons Road, Mount Eliza" && tk.instances.length === 1 && (await ER.readTakeoffForProject("Nope", { cloudValue: async () => null, localValue: () => null })) === null, JSON.stringify(tk && tk.name));
  const local = await ER.readTakeoffForProject("40 Jacksons Road", { cloudValue: async () => null, localValue: (k) => (k in store ? store[k] : null) });
  assertTrue(local && local.instances.length === 1, "a browser-held takeoff stands in when the cloud has none");
  // the prompt
  const pr = TW.tenderItemsPrompt({ projectName: "P", items: lineItems, spec: ctx, options: [{ id: "o1", text: "Spoil removal $40.00/m3 + GST" }], sections: { inclusions: "All detailed excavation.\nVapour barrier as required.", specificExclusions: "" } });
  assertTrue(/SPECIFICATION CONTEXT \(JSON\)/.test(pr) && /600 dia bored piers/.test(pr) && /"dia":600/.test(pr) && /industry language|Industry language/.test(pr) && /N16 bars at 200 mm centres/.test(pr) && /Never invent a grade/.test(pr) && /ADDITIONAL OPTIONS/.test(pr) && /\$40\.00\/m3 \+ GST/.test(pr) && /"inclusions":\["All detailed excavation\."/.test(pr) && /"sections":\{"inclusions"/.test(pr) && !/specificExclusions/.test(pr), pr.slice(0, 300));
  assertTrue(/no specification context is available/.test(TW.tenderItemsPrompt({ projectName: "P", items: lineItems })));
  const extras = TW.parseTenderExtras('{"items":[],"options":[{"id":"o1","text":"Removal of spoil from site — provisional sum, $40.00/m3 + GST thereafter"},{"id":"zz","text":"x"}],"sections":{"inclusions":["All detailed excavation to the structural drawings","Supply and installation of a polythene vapour barrier as required"],"generalExclusions":["ignored — not asked"]}}', { options: [{ id: "o1", text: "x" }], sections: { inclusions: "a\nb", specificExclusions: "c" } });
  assertTrue(extras.options.o1 && !extras.options.zz && extras.sections.inclusions.lines.length === 2 && extras.sections.inclusions.countMatches && !extras.sections.specificExclusions && !extras.sections.generalExclusions, JSON.stringify(extras));
  let posted = null;
  const r = await TW.requestTenderItemsWording(lineItems, { projectName: "P", base: "https://x.test", spec: ctx, options: [{ id: "o1", text: "Spoil" }], sections: { inclusions: "a\nb", specificExclusions: "" }, fetchImpl: async (url, opts) => { posted = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ items: [], options: { o1: "Spoil removal — provisional sum" }, sections: { inclusions: { lines: ["A", "B"], countMatches: true } }, provider: "anthropic", model: "m" }) }; } });
  assertTrue(posted.spec.points.length === 3 && posted.options.length === 1 && posted.sections.inclusions === "a\nb" && !("specificExclusions" in posted.sections) && r.options.o1 === "Spoil removal — provisional sum" && r.sections.inclusions.lines.length === 2, JSON.stringify(posted).slice(0, 200));
  const tqSrc = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(/readTakeoffForProject\(quote\.projectName\)/.test(tqSrc) && /tenderSpecContext\(\{ quote, items, lineItems: base, takeoff \}\)/.test(tqSrc) && /data-testid="items-options-review"/.test(tqSrc) && /data-testid="items-sections-review"/.test(tqSrc) && /data-testid="items-spec-note"/.test(tqSrc) && /onChange\(\{ \.\.\.tq, \.\.\.patch \}\)/.test(tqSrc));
});
await checkAsync("Tender quote line items reword (Grady, 13 Oct 2026): prompt keeps ids and point counts, the reply is read by id with a count check, the server takes kind \"items\" (400 empty, 503 no provider), the request posts action tender-wording kind items", async () => {
  const TW = await import("../src/lib/tenderWording.js");
  const E = await import("../api/ai-engine.js");
  const li = [{ id: "L1", title: "Basement", price: "$1 + GST", points: ["Piles - Bored Piers — 16 no. / approx. 35.28 m³ concrete", "RC Columns - Basement to Ground floor? — approx. 2.79 m³ concrete", ""] }, { id: "L2", title: "ground floor", points: ["Slab — approx. 255 m² / approx. 50.7 m³ concrete"] }];
  const pr = TW.tenderItemsPrompt({ projectName: "P", items: li });
  assertTrue(/"id":"L1"/.test(pr) && /SAME NUMBER of dot points/.test(pr) && /never write one/.test(pr) && /\{"items":\[\{"id"/.test(pr) && !/\$1 \+ GST/.test(pr));
  assertTrue(/Never write "further items"/.test(pr));
  const tqSrc = fs.readFileSync(new URL("../src/components/TenderQuoteReport.jsx", import.meta.url), "utf8");
  assertTrue(/const base = rolledCount \? itemiseRolledUp\(/.test(tqSrc) && /const worded = itemReview\.base\.map/.test(tqSrc) && /data-testid="items-itemised-note"/.test(tqSrc), "the reword itemises rolled-up lines first and applies onto that list");
  const map = TW.parseTenderItems('```json\n{"items":[{"id":"L1","title":"Basement","points":["Bored concrete piles — 16 no., approximately 35.28 m³ of concrete","Reinforced concrete columns, basement to ground floor — approximately 2.79 m³ of concrete"]},{"id":"L2","title":"Ground Floor","points":["Only one"]},{"id":"zz","title":"x","points":[]}]}\n```', li);
  assertTrue(map.L1 && map.L1.countMatches && map.L1.points.length === 2 && /Bored concrete piles/.test(map.L1.points[0]) && map.L2.title === "Ground Floor" && map.L2.countMatches && !map.zz, JSON.stringify(map));
  const bad = await E.runAiJob({ action: "tender-wording", kind: "items", items: [] }, {});
  const noProv = await E.runAiJob({ action: "tender-wording", kind: "items", items: li }, {});
  assertTrue(bad.status === 400 && noProv.status === 503, JSON.stringify([bad.status, noProv.status]));
  let posted = null;
  const r = await TW.requestTenderItemsWording(li, { projectName: "P", provider: "anthropic", base: "https://x.test", fetchImpl: async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ items: [{ id: "L1", title: "Basement", points: ["a", "b"], countMatches: true }], provider: "anthropic", model: "m" }) }; } });
  assertTrue(posted.url === "https://x.test/api/ai-engine" && posted.body.action === "tender-wording" && posted.body.kind === "items" && posted.body.items.length === 2 && posted.body.items[0].points.length === 2 && !("price" in posted.body.items[0]) && r.wording.L1.points.length === 2 && r.missing.join() === "L2", JSON.stringify([posted, r]));
});

check("Tender quote prints the FLOOR AREA entered in the quote (measureM2), not the Square Mesh coverage", () => {
  const raft = newElementItem(ELEMENT_TYPES.find((t) => t.id === "raft_foundation"));
  raft.label = "Ground Floor Raft";
  const rates = defaultRates();
  const mesh = FULL_CATALOG.find((c) => c.key === "SQUARE MESH").products[0];
  // 400 m² of floor reinforced with TWO layers of mesh = 800 m² of mesh
  raft.qtys[rateKey("SQUARE MESH", mesh.name, mesh.unit)] = 800;
  const quote = { overheadPct: 0.08, contingencyPct: 0.05 };

  // unmeasured: nothing else to go on, so the mesh coverage still shows
  let pts = seedTenderItems(quote, [raft], rates)[0].points.join(" | ");
  assert.ok(/800/.test(pts), `unmeasured element falls back to the mesh area, got: ${pts}`);
  assert.ok(labourQuantities(raft, rates).finishM2 === 800, "the mesh still drives finishM2 for the finishing crew");

  // measured in the Quotes section's Project Geometry table — THAT is the
  // floor area the tender quotes against
  raft.measureM2 = 400;
  pts = seedTenderItems(quote, [raft], rates)[0].points.join(" | ");
  assert.ok(/approx\. 400 m²/.test(pts), `expected the entered 400 m² floor area, got: ${pts}`);
  assert.ok(!/800 m²/.test(pts), `the 800 m² of mesh must not be quoted as floor area, got: ${pts}`);
  // and the entered area is exactly what the element's $/m² benchmark divides by
  const m2Rate = computeElementUnitRates(raft, rates).find((r) => r.unit === "m²");
  assert.equal(m2Rate.qty, 400, "the tender area and the $/m² divisor are the same figure");

  // a typed 0 / blank is "not measured", not "zero area"
  raft.measureM2 = "";
  assert.ok(/800/.test(seedTenderItems(quote, [raft], rates)[0].points.join(" | ")), "a blank area falls back rather than printing 0 m²");
});


check("Tender Project Sum: line-item '$… + GST' prices sum ex-GST; override replaces; markup is a whole %; GST added last and only when on", () => {
  const items = [
    { id: "a", price: "$46,050.47 + GST" },
    { id: "b", price: "$3,949.53 + GST" },
    { id: "c", price: "" }, // an unpriced item contributes $0, never NaN
  ];
  // plain sum, GST on (the defaults for a legacy tenderQuote with none of the new fields)
  let ps = computeTenderProjectSum({ items });
  assert.equal(ps.itemsSum.toFixed(2), "50000.00");
  assert.equal(ps.exGst.toFixed(2), "50000.00");
  assert.ok(ps.gstOn && !ps.markupOn);
  assert.equal(ps.gst.toFixed(2), "5000.00");
  assert.equal(ps.incGst.toFixed(2), "55000.00");
  // markup: 10 means 10%, applied ex-GST, before GST
  ps = computeTenderProjectSum({ items, markupOn: true, markupPct: "10" });
  assert.equal(ps.markupAmt.toFixed(2), "5000.00");
  assert.equal(ps.exGst.toFixed(2), "55000.00");
  assert.equal(ps.incGst.toFixed(2), "60500.00");
  // markup ticked but blank % — no NaN, no markup line
  ps = computeTenderProjectSum({ items, markupOn: true, markupPct: "" });
  assert.ok(!ps.markupOn && ps.exGst.toFixed(2) === "50000.00");
  // override replaces the items sum entirely (and markup applies to IT)
  ps = computeTenderProjectSum({ items, projectSumOverride: "$48,000.00", markupOn: true, markupPct: 5 });
  assert.ok(ps.hasOverride);
  assert.equal(ps.base.toFixed(2), "48000.00");
  assert.equal(ps.exGst.toFixed(2), "50400.00");
  // GST off: ex-GST figure is the whole story
  ps = computeTenderProjectSum({ items, gstOn: false });
  assert.ok(!ps.gstOn && ps.gst === 0);
  assert.equal(ps.incGst.toFixed(2), ps.exGst.toFixed(2));
  // price-string parsing survives commas, $ and the "+ GST" suffix
  assert.equal(parseTenderPrice("$1,234,567.89 + GST"), 1234567.89);
  assert.equal(parseTenderPrice("no digits here"), 0);
});

check("Benchmark rates: whole cost over the geometry measured in Estimates — $/lm, $/m², $/m³, in that order, only where the measure exists", () => {
  const rates = defaultRates();
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} !== ${b}`);

  const strip = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  strip.labourAuto = false; // materials only, so the expected rates are exact
  strip.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  strip.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  strip.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  strip.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10;            // 10 × the catalog 25 mpa rate
  strip.qtys[rateKey("PROCESSED BAR", "N12", "m")] = 400;          // 400 × 0.91kg = 0.364t × 1925 = 700.70
  const stripTotal = 10 * C25 + 700.7;

  // No geometry recorded yet → only the concrete volume can be divided by
  assert.deepEqual(computeElementUnitRates(strip, rates).map((l) => l.unit), ["m³"], "no measures = just $/m³");

  // The Estimates Project Geometry table supplies the run (and footprint)
  strip.measureLm = 60;
  strip.measureM2 = 27;
  const lines = computeElementUnitRates(strip, rates);
  assert.deepEqual(lines.map((l) => l.unit), ["lm", "m²", "m³"], "fixed order lm → m² → m³");
  near(lines[0].rate, stripTotal / 60, "$/lm is the whole cost over the total strip length");
  near(lines[1].rate, stripTotal / 27, "$/m² is the whole cost over the measured area");
  near(lines[2].rate, stripTotal / 10, "$/m³ is the whole cost over the poured volume");
  assert.equal(lines[0].qty, 60);

  // Labour belongs in the numerator: the same element with the crew engine
  // on must price HIGHER per lineal metre, never lower.
  const withLabour = { ...strip, labourAuto: true };
  assert.ok(computeElementUnitRates(withLabour, rates)[0].rate > lines[0].rate, "rates are all-in, labour included");

  // An area-only element (a slab with no run recorded) skips the lm line
  const slab = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  slab.labourAuto = false;
  slab.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  slab.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
  slab.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
  slab.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 20;
  slab.measureM2 = 180;
  assert.deepEqual(computeElementUnitRates(slab, rates).map((l) => l.unit), ["m²", "m³"], "slab shows m² then m³");
  near(computeElementUnitRates(slab, rates)[0].rate, (20 * C25) / 180);

  // Nothing entered at all → no rates, never a divide-by-zero
  assert.deepEqual(computeElementUnitRates(newElementItem(ELEMENT_TYPES[0]), rates), []);
});

check("Import: the Project Geometry table's runM/areaM2 land on the items and SUM when same-type elements combine", () => {
  const { quote } = buildImportFromEstimate({
    project: {},
    lines: [
      estLine({ category: "Strip Footing", element: "Strip A", elementId: "S1", material: "N25 concrete", finalQty: 6 }),
      estLine({ category: "Strip Footing", element: "Strip B", elementId: "S2", material: "N25 concrete", finalQty: 4 }),
      estLine({ category: "Slab on Ground", element: "GF Slab", elementId: "SL1", material: "N25 concrete", finalQty: 20 }),
    ],
    elementGeometry: { S1: { runM: 37.5, areaM2: 16.88 }, S2: { runM: 22.5, areaM2: 10.12 }, SL1: { runM: 0, areaM2: 180 } },
  });
  const strip = quote.items.find((it) => it.typeId === "strip_footings");
  assert.equal(strip.measureLm, 60, "the two strips' runs sum on the combined card");
  assert.equal(strip.measureM2, 27, "their areas sum too");
  const slab = quote.items.find((it) => /slab/i.test(it.typeId));
  assert.equal(slab.measureM2, 180);
  assert.equal(slab.measureLm, undefined, "a zero run is not recorded");
  // and the rates engine reads them straight off the imported item
  const l = computeElementUnitRates(strip, defaultRates());
  assert.equal(l[0].unit, "lm");
  assert.equal(l[0].qty, 60);

  // an export published before the geometry table existed still imports fine
  const { quote: legacy } = buildImportFromEstimate({
    project: {},
    lines: [estLine({ category: "Strip Footing", element: "Strip A", elementId: "S1", material: "N25 concrete", finalQty: 6 })],
  });
  assert.equal(legacy.items[0].measureLm, undefined);
  assert.equal(legacy.items[0].measureM2, undefined);
});

check("Geometry name-matching: a Quotes card sums EVERY takeoff element whose name matches it (all strips into one Strip Footings card)", () => {
  // instance numbers, plurals and the merge's "(x2 combined)" suffix all
  // reduce to the same key
  assert.equal(normalizeElementName("Strip Footing 2"), normalizeElementName("Strip Footings"));
  assert.equal(normalizeElementName("Strip Footings (×2 combined)"), normalizeElementName("Strip Footing"));
  assert.notEqual(normalizeElementName("Strip Footing"), normalizeElementName("Pad Footing"));

  const takeoff = [
    { name: "Strip Footing 1", runM: 37.5, areaM2: 16.88 },
    { name: "Strip Footing 2", runM: 22.5, areaM2: 10.12 },
    { name: "Slab on Ground 1", runM: 0, areaM2: 180 },
    { name: "Pad Footing 1", runM: 0, areaM2: 9 },
  ];
  const strips = geometryForLabel("Strip Footings", takeoff);
  assert.equal(strips.runM, 60, "the strips' runs sum — and ONLY the strips'");
  assert.equal(strips.areaM2, 27);
  assert.equal(strips.matched.length, 2);

  // a renamed card still matches: either name may contain the other
  assert.equal(geometryForLabel("Ground Floor - Slab on Ground", takeoff).areaM2, 180);
  // pads don't get dragged in by the footing word
  assert.equal(geometryForLabel("Pad Footings", takeoff).areaM2, 9);
  // nothing matching -> null, never a bogus zero
  assert.equal(geometryForLabel("Retaining Wall", takeoff), null);
  assert.equal(geometryForLabel("", takeoff), null);
});

check("Import keeps each takeoff element's geometry WITH its name, so Quotes can re-match after a rename", () => {
  const { quote } = buildImportFromEstimate({
    project: {},
    lines: [
      estLine({ category: "Strip Footing", element: "Strip Footing 1", elementId: "S1", material: "N25 concrete", finalQty: 6 }),
      estLine({ category: "Strip Footing", element: "Strip Footing 2", elementId: "S2", material: "N25 concrete", finalQty: 4 }),
    ],
    elementGeometry: { S1: { runM: 37.5, areaM2: 16.88 }, S2: { runM: 22.5, areaM2: 10.12 } },
  });
  assert.equal(quote.estimateGeometry.length, 2, "both takeoff elements are recorded by name");
  assert.deepEqual(quote.estimateGeometry.map((g) => g.name).sort(), ["Strip Footing 1", "Strip Footing 2"]);
  // renaming the merged card and re-matching still lands the full 60 lm
  const renamed = geometryForLabel("Ground Floor Strip Footings", quote.estimateGeometry);
  assert.equal(renamed.runM, 60);
});

check("Project unit rates: the whole quote's cost over the project's total run, area and concrete — including $/m³", () => {
  const rates = defaultRates();
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} !== ${b}`);
  const noFees = (it) => {
    it.labourAuto = false;
    it.qtys[rateKey("CONCRETE", "Minimum cartage (load under 4 m3)", "m3")] = 0;
  it.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
    it.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
    return it;
  };

  const strip = noFees(newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings")));
  strip.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10;   // 2,125
  strip.measureLm = 60;

  const slab = noFees(newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground")));
  slab.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 20;
  slab.measureM2 = 250;

  const items = [strip, slab];
  const total = 10 * C25 + 20 * C25;
  const lines = computeProjectUnitRates(items, rates);
  assert.deepEqual(lines.map((l) => l.unit), ["lm", "m²", "m³"], "same fixed lm -> m² -> m³ order as a row");
  near(lines[0].rate, total / 60, "project $/lm over the project's total run");
  near(lines[1].rate, total / 250, "project $/m² over the project's total area");
  near(lines[2].rate, total / 30, "project $/m³ over ALL the project's concrete");
  assert.equal(lines[2].qty, 30, "the m³ total sums every element's concrete");

  // measures that nobody recorded simply don't appear
  const bare = noFees(newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground")));
  bare.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 5;
  assert.deepEqual(computeProjectUnitRates([bare], rates).map((l) => l.unit), ["m³"]);
  // an empty/zero-cost quote gives nothing rather than dividing by zero
  assert.deepEqual(computeProjectUnitRates([], rates), []);
});

/* ---------- reinforcement priced as kg per m³ of concrete ---------- */
check("REINFORCEMENT BY RATE: kg/m³ × the element's poured concrete × $/tonne", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}${msg ? " — " + msg : ""}`);
  const rates = defaultRates();
  const RATE_CAT = "REINFORCEMENT BY RATE";
  const cat = FULL_CATALOG.find((c) => c.key === RATE_CAT);
  assert.ok(cat, "the category exists");
  assert.equal(cat.volumeRateBasis, true, "it is the volumeRateBasis category");
  assert.equal(cat.weightBasis, false, "and NOT weightBasis — it has no unitWeight to cost off");
  // it is the ONLY one, the same way Processed Bar owns weightBasis
  assert.deepEqual(
    FULL_CATALOG.filter((c) => c.volumeRateBasis).map((c) => c.key), [RATE_CAT],
    "only REINFORCEMENT BY RATE is volume-rate priced",
  );

  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  const rateRow = rateKey(RATE_CAT, "Reinforcement rate — processed bar (cut & bent)", "kg/m3");

  // 90 kg/m³ with no concrete entered yet buys nothing — the rate has no
  // volume to apply to, so the row is free rather than guessing one.
  item.qtys[rateRow] = 90;
  assert.equal(computeElementCost(item, rates).categoryTotals[RATE_CAT], 0,
    "a rate with no concrete costs nothing");

  // 20 m³ of 25 mpa at 90 kg/m³ = 1.8 t at $1925/t = $3,465
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 20;
  const cost = computeElementCost(item, rates);
  near(cost.categoryTotals[RATE_CAT], 3465, "90 kg/m³ over 20 m³ = 1.8 t at $1925/t");
  // and it is real money in the element total, not a display-only figure
  near(cost.total, cost.materialsTotal, "no labour/custom items in this fixture");
  assert.ok(cost.materialsTotal > 3465, "the steel sits on top of the concrete cost");

  // raising the pour raises the steel with it — that's the whole point
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 40;
  near(computeElementCost(item, rates).categoryTotals[RATE_CAT], 6930, "double the concrete, double the steel");

  // the delivery FEE rows are not poured volume, so they never inflate the steel
  item.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 40;
  item.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 40;
  near(computeElementCost(item, rates).categoryTotals[RATE_CAT], 6930,
    "the levy and surcharge m³ are fees, not concrete — the steel rate ignores them");

  // computeRowTotal is still the ONE implementation; it just takes the volume
  near(computeRowTotal(cat, { unitCost: 1925 }, 90, { concreteM3: 20 }), 3465, "computeRowTotal owns the rule");
  assert.equal(computeRowTotal(cat, { unitCost: 1925 }, 90, undefined), 0,
    "a missing ctx degrades to zero rather than NaN");
  near(rowContext(item).concreteM3, 40, "rowContext reports the element's poured volume");

  // stock-bar rate line prices off its own cheaper $/tonne
  const stockRow = rateKey(RATE_CAT, "Reinforcement rate — stock bar (straight lengths)", "kg/m3");
  const item2 = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item2.labourAuto = false;
  item2.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 10;
  item2.qtys[stockRow] = 100;
  near(computeElementCost(item2, rates).categoryTotals[RATE_CAT], 1825, "100 kg/m³ over 10 m³ = 1 t at $1825/t");
});

check("a kg/m³ rate drives steel-fixing crew days just like a bar schedule", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}${msg ? " — " + msg : ""}`);
  const rates = defaultRates();
  const rateRow = rateKey("REINFORCEMENT BY RATE", "Reinforcement rate — processed bar (cut & bent)", "kg/m3");
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 25;
  item.qtys[rateRow] = 80; // 25 × 80 = 2000 kg = 2 t
  near(computeElementReinforcementTonnes(item, rates), 2, "the rate's tonnage is counted");
  assert.equal(labourQuantities(item, rates).reinfTonnes, 2, "and reaches the labour engine");
  // 2 t at the 1 t/crew-day production rate = 2 crew-days on the steel row
  const tie = item.tasks.find((t) => /tie (steel|reinforcement|reo)/i.test(t.name));
  assert.ok(tie, "the crew sheet has a steel-fixing row");
  assert.equal(taskRowMeta(tie.name, labourQuantities(item, rates)).autoQty, 2, "its Qty prefills to 2 t");
  const sug = suggestedLabourPrefill(item, rates)[tie.id];
  assert.ok(sug && sug.steelfixer_day > 0, "and it books steel-fixing crew");

  // a rate-priced element with NO concrete books no steel labour either
  const bare = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  bare.qtys[rateRow] = 80;
  assert.equal(computeElementReinforcementTonnes(bare, rates), 0, "no concrete, no tonnage");
});

check("the kg/m³ rows fall back to the catalog rate, and stay editable", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}${msg ? " — " + msg : ""}`);
  const RATE_CAT = "REINFORCEMENT BY RATE";
  const rateRow = rateKey(RATE_CAT, "Reinforcement rate — processed bar (cut & bent)", "kg/m3");
  // CLAUDE.md rule 6: a saved rates blob predating this category must not
  // render the row at $0 — it degrades to the catalog default.
  const stale = defaultRates();
  delete stale[rateRow];
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  item.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = 20;
  item.qtys[rateRow] = 90;
  near(computeElementCost(item, stale).categoryTotals[RATE_CAT], 3465,
    "falls back to the catalog's $1925/t rather than $0");
  // an edited steel rate flows straight through
  const edited = defaultRates();
  edited[rateRow] = { ...edited[rateRow], unitCost: 2100 };
  near(computeElementCost(item, edited).categoryTotals[RATE_CAT], 1.8 * 2100, "an edited $/tonne is used");
});

/* ---------- insulation: every board is its own priced thickness ---------- */
check("INSULATION: rigid foam under-slab by compressive grade, and every family carries thicknesses", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "INSULATION");
  const names = cat.products.map((p) => p.name);
  // the grade the request named, in its full thickness range
  [25, 50, 75, 100].forEach((t) =>
    assert.ok(names.includes(`Rigid foam under-slab 50 kPa — ${t}mm`), `50 kPa ${t}mm present`));
  // and the heavier grades, for loaded slabs
  [100, 200, 300].forEach((g) =>
    [50, 75, 100].forEach((t) =>
      assert.ok(names.includes(`Rigid foam under-slab ${g} kPa — ${t}mm`), `${g} kPa ${t}mm present`)));

  // each family offers more than one thickness, so thickness is a real choice
  const families = [
    [/^Rigid foam under-slab 50 kPa/, 4], [/^Rigid foam under-slab 100 kPa/, 3],
    [/^Rigid foam under-slab 200 kPa/, 3], [/^Rigid foam under-slab 300 kPa/, 3],
    [/^Kooltherm K3 Floorboard/, 4], [/^XPS rigid board/, 4],
    [/^EPS board M-grade/, 3], [/^Foilboard rigid panel/, 3],
    [/^Slab edge insulation/, 2], [/^Thermal break strip/, 2],
  ];
  families.forEach(([re, n]) =>
    assert.equal(names.filter((x) => re.test(x)).length, n, `${re} offers ${n} thicknesses`));

  // a thicker board of the same material always costs more — that's the whole
  // point of pricing per thickness rather than typing one onto a single SKU
  const priceOf = (n) => cat.products.find((p) => p.name === n).unitCost;
  [["Rigid foam under-slab 50 kPa — 25mm", "Rigid foam under-slab 50 kPa — 100mm"],
   ["XPS rigid board 30mm (R0.88)", "XPS rigid board 100mm (R2.94)"],
   ["EPS board M-grade 50mm (R1.19)", "EPS board M-grade 100mm (R2.38)"],
   ["Kooltherm K3 Floorboard 50mm (R2.25)", "Kooltherm K3 Floorboard 100mm (R4.50)"],
  ].forEach(([thin, thick]) => assert.ok(priceOf(thick) > priceOf(thin), `${thick} costs more than ${thin}`));

  // and a stronger board costs more than a weaker one at the same thickness
  assert.ok(priceOf("Rigid foam under-slab 300 kPa — 50mm") > priceOf("Rigid foam under-slab 50 kPa — 50mm"),
    "300 kPa costs more than 50 kPa at the same thickness");

  // strip products stay per-metre, boards stay per-m²
  cat.products.forEach((p) => {
    const perM = /^Slab edge insulation|^Thermal break strip/.test(p.name);
    assert.equal(p.unit, perM ? "m" : "m2", `${p.name} unit`);
    assert.ok(p.unitCost > 0, `${p.name} is priced`);
  });
});

check("insulation boards are ordinary qty × unit-cost rows (no weight/area/rate basis)", () => {
  const rates = defaultRates();
  const cat = FULL_CATALOG.find((c) => c.key === "INSULATION");
  assert.ok(!cat.weightBasis && !cat.areaBasis && !cat.lengthBasis && !cat.volumeRateBasis,
    "INSULATION carries no special basis flag");
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.labourAuto = false;
  const key = rateKey("INSULATION", "Rigid foam under-slab 50 kPa — 100mm", "m2");
  item.qtys[key] = 250;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["INSULATION"], 250 * 27, "250 m² at $27/m² = $6,750");
  // a missing saved key still falls back to the catalog rate (CLAUDE.md rule 6)
  const stale = defaultRates();
  delete stale[key];
  assert.equal(computeElementCost(item, stale).categoryTotals["INSULATION"], 250 * 27,
    "falls back to the catalog default rather than $0");
});

/* ---------- every costing figure is editable ---------- */
check("Minimum cartage load size is an editable production rate, not a constant", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "slab_on_ground");
  const mk = (vol) => {
    const it = newElementItem(type);
    it.labourAuto = false;
    it.qtys[rateKey("CONCRETE", "Production & transport surcharge", "m3")] = 0;
    it.qtys[rateKey("CONCRETE", "Environment levy", "m3")] = 0;
    it.qtys[rateKey("CONCRETE", "25 mpa", "m3")] = vol;
    return it;
  };
  const sizeKey = rateKey("PRODUCTION", "Minimum cartage load size", "m³/load");
  assert.ok(rates[sizeKey], "the rate is seeded, so it appears in the Rates modal");
  assert.equal(rates[sizeKey].unitCost, 4, "defaulting to the 4 m³ minimum");

  // at the default 4 m³: 11 -> 2 loads + 3, 1 short, $80
  assert.equal(autoMinimumCartage(mk(11), rates).total, 80);
  assert.equal(autoMinimumCartage(mk(12), rates), null);

  // a supplier working to a 6 m³ minimum: 11 -> 1 load + 5, 1 short, $80
  const six = { ...rates, [sizeKey]: { unitCost: 6 } };
  const r11 = autoMinimumCartage(mk(11), six);
  assert.equal(r11.threshold, 6, "the result reports the load size it used");
  assert.equal(r11.remainder, 5);
  assert.equal(r11.total, 80, "6 − 5 = 1 m³ short");
  assert.equal(autoMinimumCartage(mk(12), six), null, "12 ÷ 6 = 2 loads exactly, nothing over");
  assert.equal(autoMinimumCartage(mk(13), six).total, 400, "13 -> 2 loads + 1, 5 m³ short of 6");

  // a 2 m³ minimum makes far more pours divide evenly
  const two = { ...rates, [sizeKey]: { unitCost: 2 } };
  assert.equal(autoMinimumCartage(mk(11), two).total, 80, "11 -> 5 loads + 1, 1 m³ short");
  assert.equal(autoMinimumCartage(mk(12), two), null, "12 divides evenly by 2");

  // a nonsense load size degrades to no charge rather than dividing by zero
  assert.equal(autoMinimumCartage(mk(11), { ...rates, [sizeKey]: { unitCost: 0 } }), null);
});

check("Margin ladder rungs are editable, and bad input falls back to the catalog list", () => {
  const store = {};
  const g = globalThis;
  const had = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const prev = had ? g.localStorage : undefined;
  g.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const setPrefs = (o) => { store["gradcon-preferences"] = JSON.stringify(o); };
  try {
    setPrefs({});
    assert.deepEqual(getMarginSteps(), [...MARGIN_STEPS].sort((a, b) => a - b), "no preference = the catalog ladder");

    // an entered ladder replaces the catalog one; the house default is always
    // folded in so the highlighted row exists, whatever the ladder says
    setPrefs({ marginStepsPct: "10,20,30,45" });
    assert.deepEqual(getMarginSteps(), [0.1, 0.2, 0.25, 0.3, 0.45], "an entered ladder replaces it, with the 25% default folded in");

    setPrefs({ marginStepsPct: "10,25,45" });
    assert.deepEqual(getMarginSteps(), [0.1, 0.25, 0.45], "a ladder that already lists the default is left alone");

    // the default margin is always represented, so the highlight has a row
    setPrefs({ marginStepsPct: "10,20", defaultMarginPct: 33 });
    assert.deepEqual(getMarginSteps(), [0.1, 0.2, 0.33]);

    // junk, out-of-range and duplicate rungs are dropped
    setPrefs({ marginStepsPct: "10, abc, 200, -5, 20, 20" });
    assert.deepEqual(getMarginSteps(), [0.1, 0.2, 0.25], "junk dropped; the 25% house default merged in");

    // nothing usable at all falls back rather than producing an empty ladder
    setPrefs({ marginStepsPct: "abc, 300" });
    assert.deepEqual(getMarginSteps(), [...MARGIN_STEPS].sort((a, b) => a - b));

    // and the ladder still drives a real sell price
    setPrefs({ marginStepsPct: "50" });
    const { rows } = computeMarginLadder(1000, 0, 0, 0, getMarginSteps());
    const fifty = rows.find((r) => Math.abs(r.margin - 0.5) < 1e-9);
    assert.ok(fifty && Math.abs(fifty.sellExGst - 2000) < 1e-6, "50% margin on $1,000 sells at $2,000");
  } finally {
    if (had) g.localStorage = prev; else delete g.localStorage;
  }
});

check("Rates Library rules: a listed product moves to the library price whatever Quotes stores", () => {
  const conv = rateKey("FORMWORK", "Conventional", "m2"), edge = rateKey("FORMWORK", "Edgeform", "m");
  const lib = { formworkLegacy: { Conventional: { cost: 200 }, Edgeform: { cost: 25 } } };
  const rates = { [conv]: { unitCost: 60 }, [edge]: { unitCost: 8 } };          // what a stale device left in the shared row
  const upd = pendingRateUpdates(rates, lib, {});                              // no last-synced record at all (a fresh browser)
  assert.deepEqual(upd.map((u) => [u.key, u.price]).sort(), [[conv, 200], [edge, 25]].sort());
  assert.deepEqual(pendingRateUpdates({ [conv]: { unitCost: 200 }, [edge]: { unitCost: 25 } }, lib, {}), [], "nothing pending once they agree");
  assert.deepEqual(pendingRateUpdates({ [conv]: { unitCost: 999 } }, lib, {}).map(({ key, price }) => ({ key, price })), [{ key: conv, price: 200 }], "a hand-typed $999 does not block the library either");
});
check("Rates Library rules: excluded and ambiguous names never move a Quotes rate", () => {
  assert.ok(LIBRARY_EXCLUDED_NAMES.includes("Delivery fee"));
  const del = rateKey("REINFORCING ACCESSORIES", "Delivery fee", "each");
  const lib = { reinfAcc: { "Delivery fee": { cost: 300 } }, otherAcc: { "Delivery fee": { cost: 0 } } };
  assert.deepEqual(pendingRateUpdates({ [del]: { unitCost: 0 } }, lib, {}), []);
  assert.ok(!libraryGovernedKeys(lib).has(del), "not governed either, so the Rates modal keeps it editable");
  assert.deepEqual(pendingRateUpdates({ x: { unitCost: 1 } }, { formworkLegacy: { "No Such Product": { cost: 5 } } }, {}), [], "an unmatched name is ignored");
});
check("Rates Library rules: governed keys are exactly the matched, non-excluded products", () => {
  const lib = { formworkLegacy: { Conventional: { cost: 150 } }, reinfAcc: { "Delivery fee": { cost: 300 } } };
  const g = libraryGovernedKeys(lib);
  assert.ok(g.has(rateKey("FORMWORK", "Conventional", "m2")) && g.size === 1);
});


check("SPECIALIST FINISHING CONCRETE: 27 VicMix mixes at the published $/m³, plain qty × rate, washout/short-load/quote rows present, library names match", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "SPECIALIST FINISHING CONCRETE");
  assert.ok(cat && !cat.weightBasis && !cat.areaBasis && !cat.lengthBasis && !cat.volumeRateBasis);
  assert.equal(cat.products.length, 48);
  const vm = cat.products.filter((p) => /^VicMix /.test(p.name) && p.unit === "m3");
  assert.equal(vm.length, 27);
  const price = (n) => vm.find((p) => p.name.startsWith("VicMix " + n + " —")).unitCost;
  assert.equal(price("Fusion Ash"), 330); assert.equal(price("Amber Ash + Cappuccino Oxide"), 490); assert.equal(price("Alpine Ivory"), 625); assert.equal(price("Rio 28 Half Black"), 530);
  assert.ok(cat.products.some((p) => /pigment washout/i.test(p.name) && p.unit === "truck" && p.unitCost === 40), "washout $40/truck");
  assert.ok(cat.products.some((p) => /short-load charge/i.test(p.name) && p.unitCost === 0), "short-load row, unpublished amount seeds $0");
  assert.ok(cat.products.some((p) => p.unit === "quote"), "subcontract quote row");
  // the production rates VicMix's terms need
  assert.ok(PRODUCTION_RATES.some((r) => r.name === "VicMix minimum delivery (Maxi truck)" && r.rate === 4));
  assert.ok(PRODUCTION_RATES.some((r) => r.name === "VicMix Maxi truck load size" && r.rate === 7));
  assert.ok(PRODUCTION_RATES.some((r) => /delivery radius/.test(r.name) && r.rate === 25));
  // the Rates Library carries every product by the SAME name so its prices flow to Quotes by name
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("const SPECIALIST_CONCRETE_ITEMS"), html.indexOf("const CONCRETE_GRADE_ITEMS"));
  const libNames = [...block.matchAll(/\{p:("(?:[^"\\]|\\.)*"),u:"[^"]*",cost:([\d.]+)\}/g)].map((m) => [JSON.parse(m[1]), Number(m[2])]);
  assert.equal(libNames.length, 48, "library lists all 48");
  cat.products.forEach((p) => { const hit = libNames.find(([n]) => n === p.name); assert.ok(hit, `library missing "${p.name}"`); assert.equal(hit[1], p.unitCost, `library price for ${p.name}`); });
});

await checkAsync("FINISHED PAVEMENTS & CONCRETE FINISHES (Grady, 13 Oct 2026): $/m² installed allowances on every card, scope always, $180/m² recommended exposed-aggregate rate, the six build-up rows, and the Rates Library lists every product by the same name and price (finishRates is a priced section)", async () => {
  const cat = FULL_CATALOG.find((c) => c.key === "FINISHED PAVEMENTS & CONCRETE FINISHES");
  assert.ok(cat && !cat.weightBasis && !cat.areaBasis && !cat.volumeRateBasis && !cat.visibleFor && cat.scopeBucket === "always");
  assert.ok(cat.products.every((p) => p.unit === "m2" && (p.unitCost > 0 || (p.unitCost === 0 && /no published rate found/.test(p.name)))), "every row is priced, or says in its name that no rate is published");
  // permeable paving (Boma, 20 Nov 2026 — EF 03 "Permeable Paving, sealer TBC, min. P4 slip rating"), from two published 2026 Melbourne guides
  assert.equal(cat.products.length, 23);
  // the two recommended tender allowances for that schedule (Boma's build-up, 21 Nov 2026): the components sum to the rate
  const ef3 = cat.products.find((p) => /^Permeable paving, vehicle-rated, sealed, P4 slip rating — driveway \/ carport — RECOMMENDED tender allowance/.test(p.name));
  const ef4 = cat.products.find((p) => /^Exposed aggregate concrete, sealed, P4 slip rating — crossover — RECOMMENDED tender allowance/.test(p.name));
  assert.ok(ef3.unit === "m2" && ef4.unit === "m2");
  assert.match(ef3.name, /\$215 \+ \$15 contingency/); assert.match(ef4.name, /\$185 \+ \$10 contingency/, "the name (the rate KEY) is unchanged and still states the build-up");
  assert.equal(cat.products[0].unitCost, 180, "the $180 carport headline stays the first row (it states no range)");
  assert.equal(cat.products.find((p) => /^Slip-resistant finish to P4/.test(p.name)).unitCost, 0, "no guide publishes a P4 treatment rate — $0 and the name says so");
  // EVERY RATE SITS AT THE TOP OF ITS RANGE (Boma, 21 Nov 2026: "always adopt the higher range")
  const price = (re) => cat.products.find((p) => re.test(p.name)).unitCost;
  const round2c = (n) => Math.round(n * 100) / 100;
  cat.products.forEach((p) => {
    const text = p.label || p.name;
    const m = /\$(\d+)–(\d+)\+?\/m²( incl\. GST)?/.exec(text);
    if (!m || /RECOMMENDED preliminary estimate rate/.test(p.name)) return;
    const top = m[3] ? round2c(Number(m[2]) / 1.1) : Number(m[2]);
    assert.equal(p.unitCost, top, `"${text.slice(0, 60)}…" is seeded at the top of its range (${m[3] ? "÷ 1.1 for a range stated incl. GST" : "as stated"})`);
  });
  assert.equal(price(/^Exposed aggregate — standard/), 185); assert.equal(price(/^Exposed aggregate — premium/), 220); assert.equal(price(/^Exposed aggregate — difficult access/), 240, "a '+' ceiling is taken at the figure before it");
  assert.equal(price(/^Ordinary grey/), 120); assert.equal(price(/^Coloured concrete/), 190.91); assert.equal(price(/^Stamped/), 190.91);
  assert.equal(price(/^Polished/), 120); assert.equal(price(/^Burnished/), 85); assert.equal(price(/^Honed/), (85 + 120) / 2, "honed has no guide: between the burnished and polished tops");
  assert.equal(price(/^Sealer only/), 16); assert.equal(price(/^Permeable paving — permeable pavers/), 209.09); assert.equal(price(/^Permeable paving — resin-bound/), 200); assert.equal(price(/^Permeable paving — gravel grid/), 130);
  assert.equal(ef3.unitCost, 280, "EF 03 at the top of its indicative $180–280"); assert.equal(ef4.unitCost, 230, "EF 04 at the top of its indicative $150–230");
  assert.match(ef3.label, /top of the indicative \$180–280\/m²; build-up Nov 2026 \$215 \+ \$15 contingency = \$230/, "the label says what the figure is and keeps the build-up");
  assert.match(ef4.label, /top of the indicative \$150–230\/m²; build-up Nov 2026 \$185 \+ \$10 contingency = \$195/);
  cat.products.forEach((p) => { const t = p.label || p.name; const q = /≈ \$([\d.]+) ex GST/.exec(t); if (q) assert.equal(Number(q[1]), p.unitCost, `the ex-GST figure quoted on "${t.slice(0, 40)}…" is the rate`); });
  const build = cat.products.filter((p) => /^Build-up: /.test(p.name));
  assert.equal(build.length, 6); const sum = build.reduce((t, p) => t + p.unitCost, 0); assert.equal(sum, 172, "the build-up rows sit at their tops and sum to the top of the indicative $116–172");
  assert.equal(cat.librarySection, "finishRates"); assert.equal(cat.libraryAnchor, "sec-finish-rates", "the band names the Rates Library section that governs it");
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("const PAVEMENT_FINISH_ITEMS"), html.indexOf("const FINISH_UPPER"));
  const libRows = [...block.matchAll(/\{p:("(?:[^"\\]|\\.)*"),u:"m2",cost:([\d.]+)(?:,was:([\d.]+))?(?:,label:("(?:[^"\\]|\\.)*"))?\}/g)].map((m) => ({ name: JSON.parse(m[1]), cost: Number(m[2]), was: m[3] == null ? null : Number(m[3]), label: m[4] ? JSON.parse(m[4]) : null }));
  assert.equal(libRows.length, cat.products.length, "library lists every product");
  cat.products.forEach((p) => { const hit = libRows.find((r) => r.name === p.name); assert.ok(hit, `library missing "${p.name}"`); assert.equal(hit.cost, p.unitCost, `library price for ${p.name}`); assert.equal(hit.label || null, p.label || null, `library label for ${p.name}`); });
  // a saved library moves onto the upper figures ONCE, and only where it still holds the seed
  const libBox = { console }; libBox.globalThis = libBox;
  runInNewContext(block + html.slice(html.indexOf("const FINISH_UPPER"), html.indexOf("const SPECIALIST_CONCRETE_ITEMS")) + "\n;globalThis.__f={PAVEMENT_FINISH_ITEMS,migrateFinishUpper,FINISH_UPPER};", libBox);
  const F = libBox.__f; const std = F.PAVEMENT_FINISH_ITEMS.find((r) => /standard/.test(r.p)), prem = F.PAVEMENT_FINISH_ITEMS.find((r) => /premium/.test(r.p)), head = F.PAVEMENT_FINISH_ITEMS[0];
  const saved = { finishRates: { [std.p]: { cost: 157.5 }, [prem.p]: { cost: 215 }, [head.p]: { cost: 180 } } };
  assert.equal(F.migrateFinishUpper(saved), true);
  assert.equal(saved.finishRates[std.p].cost, 185, "a row still on its old seed takes the top of the range");
  assert.equal(saved.finishRates[prem.p].cost, 215, "a figure typed by hand is left exactly as it is");
  assert.equal(saved.finishRates[head.p].cost, 180); assert.equal(saved.finishUpper, F.FINISH_UPPER);
  saved.finishRates[std.p].cost = 157.5;
  assert.equal(F.migrateFinishUpper(saved), false, "the move runs once"); assert.equal(saved.finishRates[std.p].cost, 157.5, "…so a figure typed back afterwards stays");
  assert.equal((html.match(/migrateFinishUpper\(state\)/g) || []).length, 2, "both load paths (this browser's copy and the cloud pull) run it");
  assert.match(html, /\$\{it\.label\|\|it\.p\}/, "the library table shows a row's label");
  assert.match(html, /const LIBRARY_OPEN_KEY = "gradcon-rates-library-open";/); assert.match(html, /el\.open = true;/, "a card's 'Open this section' request opens the section");
  // typed on a card → written to the library (lib/libraryWrite.js)
  const LW = await import("../src/lib/libraryWrite.js");
  const lib0 = { finishRates: { A: { cost: 100, note: "n" }, B: { cost: 5 } }, global: { x: 1 } };
  const lib1 = LW.patchLibraryPrice(lib0, "finishRates", "A", 120, "2026-11-21T00:00:00.000Z");
  assert.deepEqual(lib1.finishRates, { A: { cost: 120, note: "n" }, B: { cost: 5 } }); assert.equal(lib1.updatedAt, "2026-11-21T00:00:00.000Z"); assert.equal(lib0.finishRates.A.cost, 100, "the input is never mutated"); assert.deepEqual(lib1.global, { x: 1 });
  assert.equal(LW.patchLibraryPrice(lib0, "finishRates", "New row", 9).finishRates["New row"].cost, 9, "a row the saved library lacks is added");
  [[null, "finishRates", "A", 1], [lib0, "", "A", 1], [lib0, "finishRates", "", 1], [lib0, "finishRates", "A", ""], [lib0, "finishRates", "A", -3], [lib0, "finishRates", "A", "abc"]].forEach((a) => assert.equal(LW.patchLibraryPrice(...a), null));
  const store = {}; const events = [];
  const fakeWin = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } }, StorageEvent: function (type, init) { this.type = type; this.key = init.key; }, Event: function (type) { this.type = type; }, dispatchEvent: (e) => { events.push(e.key || e.type); } };
  const cloud = { row: { value: { finishRates: { A: { cost: 100 }, C: { cost: 7 } }, steel: { keep: true } } }, rpcs: [], upserts: [] };
  const fakeClient = (rpcOk) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cloud.row, error: null }) }) }), upsert: async (r) => { cloud.upserts.push(r); return { error: null }; } }), rpc: async (name, args) => { cloud.rpcs.push({ name, args }); return rpcOk ? { data: "2026-11-21T00:00:01Z", error: null } : { data: null, error: { message: "no function" } }; } });
  let res = await LW.writeLibraryPrice("finishRates", "A", 150, { window: fakeWin, supabase: fakeClient(true), readLocal: () => ({ finishRates: { A: { cost: 100 } }, old: true }), now: "2026-11-21T00:00:00.000Z" });
  assert.deepEqual(res, { ok: true, local: true, cloud: true });
  assert.equal(cloud.rpcs.length, 1); assert.equal(cloud.rpcs[0].name, "estimator_kv_merge"); assert.equal(cloud.rpcs[0].args.p_key, "gradcon-rates-library");
  assert.deepEqual(Object.keys(cloud.rpcs[0].args.p_patch).sort(), ["finishRates", "updatedAt"], "ONE section of the library is patched in the cloud, never the whole row");
  assert.deepEqual(cloud.rpcs[0].args.p_patch.finishRates, { A: { cost: 150 }, C: { cost: 7 } }, "…built on the CLOUD's copy of that section");
  const mirror = JSON.parse(store["gradcon-rates-library"]);
  assert.ok(mirror.steel.keep && mirror.finishRates.C.cost === 7 && mirror.finishRates.A.cost === 150 && !mirror.old, "this browser's copy becomes the cloud's library with the figure — never an older local copy");
  assert.deepEqual(events, ["gradcon-rates-library", "gradcon-rates-library"], "the window's own library sync is told (the optimistic write, then the cloud's copy)");
  res = await LW.writeLibraryPrice("finishRates", "A", 160, { window: fakeWin, supabase: fakeClient(false), readLocal: () => null });
  assert.ok(res.ok && res.cloud && cloud.upserts.length === 1 && cloud.upserts[0].value.finishRates.A.cost === 160 && cloud.upserts[0].value.steel.keep, "no merge function: a read-merge-write of the whole row, nothing else lost");
  res = await LW.writeLibraryPrice("finishRates", "A", 170, { window: fakeWin, supabase: null, readLocal: () => null });
  assert.ok(!res.ok && /not been opened/.test(res.reason), "no library anywhere: the caller falls back to the plain rate and says so");
  res = await LW.writeLibraryPrice("finishRates", "A", 170, { window: fakeWin, supabase: null, readLocal: () => ({ finishRates: {} }) });
  assert.deepEqual(res, { ok: true, local: true, cloud: false });
  // the project that typed the figure is not asked about its own change; others are
  const RCH = await import("../src/lib/rateChanges.js");
  const kA = rateKey(cat.key, std.p, "m2");
  const logT = [{ at: "2026-11-21T02:00:00.000Z", key: kA, name: std.p, from: 185, to: 199 }];
  const openQ = { status: "Estimating", items: [{ id: "i1", qtys: { [kA]: 10 } }] };
  assert.equal(RCH.pendingRateChanges(openQ, logT, "2026-11-01T00:00:00.000Z").length, 1, "another project is asked");
  const typedQ = { ...openQ, ...RCH.typedRatePatch(openQ, kA, 199) };
  assert.deepEqual(typedQ.ratesTyped, { [kA]: 199 });
  assert.equal(RCH.pendingRateChanges(typedQ, logT, "2026-11-01T00:00:00.000Z").length, 0, "the project that typed it is not");
  assert.equal(RCH.pendingRateChanges(typedQ, logT.concat({ at: "2026-11-22T00:00:00.000Z", key: kA, name: std.p, from: 199, to: 205 }), "2026-11-01T00:00:00.000Z").length, 1, "…until the library moves that rate again");
  const keptQ = { ...openQ, ratesFrozen: { at: "x", status: "Estimating", reason: "library", rates: { [kA]: { unitCost: 185 }, other: { unitCost: 1 } }, names: {} } };
  const rel = RCH.typedRatePatch(keptQ, kA, 199);
  assert.ok(rel.ratesFrozen && !rel.ratesFrozen.rates[kA] && rel.ratesFrozen.rates.other, "a figure the project had KEPT for that rate is released: it typed a new one");
  assert.deepEqual(RCH.typedRatePatch(openQ, kA, "abc"), {});
  // the card
  const cb = fs.readFileSync(new URL("../src/components/CategoryBlock.jsx", import.meta.url), "utf8");
  assert.match(cb, /cat\.librarySection && onLibraryRateChange \? \(\s*\/\/[^\n]*\n\s*<CommitNumInput/, "a library-governed band's Unit $ is a typed cell");
  assert.match(cb, /onCommit=\{\(v\) => onLibraryRateChange\(cat, p, v\)\}/); assert.match(cb, /data-testid="band-library-open"/);
  const atoms = fs.readFileSync(new URL("../src/components/atoms.jsx", import.meta.url), "utf8");
  assert.match(atoms, /export function CommitNumInput/); assert.match(atoms, /onBlur=\{commit\}/, "one write on blur / Enter, never one per keystroke");
  const appSrc = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSrc, /if \(locked\) \{ setMaterialRate\(key, n, p\.unitCost \?\? 0\);/, "a project whose rates are pinned keeps the figure on its own copy — the library is untouched");
  assert.match(appSrc, /typedRatePatch\(q, key, n\)/); assert.match(appSrc, /await writeLibraryPrice\(cat\.librarySection, p\.name, n\)/);
  assert.match(appSrc, /type: "gradcon:open-app", target: "rateslibrary"/);
  assert.ok(/finishRates: \{\}/.test(html) && /s\.finishRates\[it\.p\] = \{cost:it\.cost\}/.test(html) && /sec-finish-rates/.test(html) && /mapName:"finishRates"/.test(html));
  const RL = await import("../src/lib/ratesLibrarySync.js");
  const prices = RL.libraryPrices({ finishRates: { [cat.products[0].name]: { cost: 195 } } });
  assert.equal(prices.length, 1); assert.equal(prices[0].key, rateKey(cat.key, cat.products[0].name, "m2")); assert.equal(prices[0].price, 195);
});

check("VicMix pigment washout auto-applies per Maxi truck of PIGMENTED mix; short load flags under 4 m³; Holcim fees never touch specialist volume", () => {
  const type = ELEMENT_TYPES.find((t) => t.category === "SPECIALIST FINISHING CONCRETE"); const rates = defaultRates();
  const K = (n) => rateKey("SPECIALIST FINISHING CONCRETE", FULL_CATALOG.find((c) => c.key === "SPECIALIST FINISHING CONCRETE").products.find((p) => p.name.startsWith(n)).name, "m3");
  // 10 m³ of Fusion Half Black (charcoal = pigmented) → 2 trucks at 7 m³ → 2 × $40
  let item = newElementItem(type); item.qtys[K("VicMix Fusion Half Black")] = 10;
  let w = autoPigmentWashout(item, rates);
  assert.ok(w && w.qty === 2 && w.total === 80 && w.pigmentedM3 === 10, JSON.stringify(w));
  let cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["SPECIALIST FINISHING CONCRETE"], 10 * 395 + 80);
  assert.equal(cost.concreteQty, 10, "specialist mix counts as poured concrete");
  assert.equal(autoMinimumCartage(item, rates), null, "no Holcim cartage on VicMix volume");
  assert.equal(autoConcreteSurcharge(item, rates), null); assert.equal(autoEnvironmentLevy(item, rates), null);
  assert.equal(rowContext(item).concreteM3, 10, "kg/m³ reinforcement sees the volume");
  // an Ash (grey cement, no pigment) mix attracts no washout
  item = newElementItem(type); item.qtys[K("VicMix Fusion Ash")] = 10;
  assert.equal(autoPigmentWashout(item, rates), null);
  // a typed washout qty wins over the auto count
  item = newElementItem(type); item.qtys[K("VicMix Lipari Black")] = 10;
  const wk = rateKey("SPECIALIST FINISHING CONCRETE", "VicMix pigment washout charge — per truck (+ GST, pigmented mixes)", "truck");
  item.qtys[wk] = 1; assert.equal(autoPigmentWashout(item, rates), null);
  assert.equal(computeElementCost(item, rates).categoryTotals["SPECIALIST FINISHING CONCRETE"], 10 * 455 + 40);
  // truck size is an editable production rate: 7 → 4 m³ makes 10 m³ three trucks
  const r2 = { ...rates, [rateKey("PRODUCTION", "VicMix Maxi truck load size", "m³/load")]: { unitCost: 4 } };
  item = newElementItem(type); item.qtys[K("VicMix Lipari Black")] = 10;
  const w2 = autoPigmentWashout(item, r2); assert.ok(w2 && w2.qty === 3, JSON.stringify(w2));
  // short load: 3 m³ is under the 4 m³ minimum → one charge (seeded $0 until entered); 4 m³ is not
  item = newElementItem(type); item.qtys[K("VicMix Sienna Ash")] = 3;
  const sl = autoSpecialistShortLoad(item, rates); assert.ok(sl && sl.qty === 1 && sl.total === 0 && sl.shortByM3 === 1, JSON.stringify(sl));
  const sk = rateKey("SPECIALIST FINISHING CONCRETE", "VicMix short-load charge — delivery under the 4 m³ Maxi minimum", "load");
  const r3 = { ...rates, [sk]: { unitCost: 150 } };
  assert.equal(computeElementCost(item, r3).categoryTotals["SPECIALIST FINISHING CONCRETE"], 3 * 365 + 150);
  item.qtys[K("VicMix Sienna Ash")] = 4; assert.equal(autoSpecialistShortLoad(item, rates), null);
  // a blank band costs nothing and applies nothing
  assert.deepEqual(autoSpecialistFees(newElementItem(type), rates), []);
});


check("the SPECIALIST FINISHING CONCRETE band is on its own elements ONLY: hidden and free on every other element, every other band still everywhere", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "SPECIALIST FINISHING CONCRETE");
  const rates = defaultRates();
  const mixKey = rateKey(cat.key, cat.products.find((p) => p.name.startsWith("VicMix Fusion Half Black")).name, "m3");
  const footing = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  const finish = newElementItem(ELEMENT_TYPES.find((t) => t.id === "finish_polished"));
  assert.equal(categoryAppliesTo(cat, footing), false); assert.equal(categoryAppliesTo(cat, finish), true);
  FULL_CATALOG.filter((c) => !c.visibleFor).forEach((c) => { assert.ok(categoryAppliesTo(c, footing) && categoryAppliesTo(c, finish), `${c.key} must be on every card`); });
  assert.deepEqual(FULL_CATALOG.filter((c) => c.visibleFor).map((c) => c.key).sort(), ["PRECAST / TILT-UP", "PRELIMINARIES", "SPECIALIST FINISHING CONCRETE"], "exactly three element-scoped bands");
  // a stale VicMix quantity on a footing (entered before the band moved) can never carry invisible money
  footing.qtys[mixKey] = 10;
  const fc = computeElementCost(footing, rates);
  assert.equal(fc.categoryTotals[cat.key], 0); assert.equal(fc.total, 0); assert.equal(fc.concreteQty, 0);
  assert.equal(autoPigmentWashout(footing, rates), null);
  assert.equal(rowContext(footing).concreteM3, 0);
  // the same quantity on a specialist element prices in full
  finish.qtys[mixKey] = 10;
  const sc = computeElementCost(finish, rates);
  assert.equal(sc.categoryTotals[cat.key], 10 * 395 + 80); assert.equal(sc.concreteQty, 10);
});

check("the PRELIMINARIES band is on the PRELIMINARIES elements ONLY: hidden and free elsewhere, priced in full there, never poured concrete", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "PRELIMINARIES");
  const rates = defaultRates();
  const controller = cat.products.find((p) => p.name.startsWith("Traffic controller"));
  const key = rateKey(cat.key, controller.name, controller.unit);
  const footing = newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
  const finish = newElementItem(ELEMENT_TYPES.find((t) => t.id === "finish_polished"));
  const traffic = newElementItem(ELEMENT_TYPES.find((t) => t.id === "prelim_traffic_management"));
  assert.equal(categoryAppliesTo(cat, footing), false); assert.equal(categoryAppliesTo(cat, finish), false); assert.equal(categoryAppliesTo(cat, traffic), true);
  assert.equal(categoryAppliesTo(FULL_CATALOG.find((c) => c.key === "SPECIALIST FINISHING CONCRETE"), traffic), false, "the VicMix band stays off a prelim element");
  assert.equal(categoryAppliesTo(FULL_CATALOG.find((c) => c.key === "CONCRETE"), traffic), true, "every plain band is still on a prelim element (rule 1)");
  footing.qtys[key] = 8;
  const fc = computeElementCost(footing, rates);
  assert.equal(fc.categoryTotals[cat.key], 0); assert.equal(fc.total, 0);
  traffic.qtys[key] = 8;
  const tc = computeElementCost(traffic, rates);
  assert.equal(tc.categoryTotals[cat.key], 8 * controller.unitCost); assert.equal(tc.total, 8 * controller.unitCost); assert.equal(tc.concreteQty, 0);
  assert.deepEqual(traffic.tasks.map((t) => t.name).slice(0, 2), ["Site establishment / mobilisation", "Traffic management / control"]);
});


/* ---- Per-element rate overrides, pinned rates on finished projects, validity dates (29 Sep 2026) ---- */
const { rowRate, isManualQuoteKey } = await import("../src/lib/costing.js");
check("Concrete wastage by work type: the five classes, their defaults and ranges, mirrored between the Rates Library and Estimates", () => {
  const lib = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const want = { concreteWasteSlabPct: 2.5, concreteWasteFormedPct: 5, concreteWasteGroundPct: 7.5, concreteWastePilePct: 10, concreteWasteShotcretePct: 15 };
  Object.entries(want).forEach(([k, v]) => {
    const m = new RegExp(`${k}: ([0-9.]+)`).exec(lib); assert.ok(m, `${k} seeded in the library`); assert.equal(Number(m[1]), v, `${k} default`);
    assert.ok(new RegExp(`bind\\("g_cw_\\w+", \\["global","${k}"\\]\\)`).test(lib), `${k} editable in the library`);
  });
  const block = /const CONC_WASTE_CLASSES=\[([\s\S]*?)\];/.exec(est); assert.ok(block, "CONC_WASTE_CLASSES in estimates-app.html");
  const rows = [...block[1].matchAll(/key:"(\w+)",\s*label:"([^"]+)",\s*range:"([^"]+)",\s*def:([0-9.]+),\s*lib:"(\w+)"/g)].map((m) => ({ key: m[1], label: m[2], range: m[3], def: Number(m[4]), lib: m[5] }));
  assert.deepEqual(rows.map((r) => r.lib), Object.keys(want), "Estimates reads exactly the library's five keys, in table order");
  rows.forEach((r) => assert.equal(r.def, want[r.lib], `${r.key} default matches the library`));
  assert.deepEqual(rows.map((r) => r.range), ["2–3%", "5%", "5–10%", "5–15%+", "10–20%+"], "the typical ranges from the table");
  assert.ok(/pier"\) return "pile"/.test(est) && /shotwall"\) return "shotcrete"/.test(est) && /slab"\) return "slab"/.test(est), "auto class: piers → bored piles, shotcrete walls → shotcrete, slabs → large slabs, else formed");
  assert.ok(/concreteWasteMode==="flat"/.test(est) || /concreteWasteMode\|\|"class"\)==="flat"/.test(est), "a flat project-wide % remains available");

  // the library's element-type table mirrors Estimates' LIBRARY exactly, with the class autoConcWasteClass implies
  const libBlock = /const LIBRARY = \[([\s\S]*?)\n\];/.exec(est)[1];
  let group = null; const estTypes = [];
  libBlock.split("\n").forEach((line) => { const g = /\{group:"([^"]+)"/.exec(line); if (g) { group = g[1]; return; } const it = /\{id:"(\w+)",\s*label:"([^"]+)",\s*calc:"(\w+)"/.exec(line); if (it) estTypes.push([it[1], it[2], group, it[3] === "pier" ? "pile" : it[3] === "shotwall" ? "shotcrete" : it[3] === "slab" ? "slab" : "formed"]); });
  const mirror = /const EST_WASTE_TYPES = \[([\s\S]*?)\n\];/.exec(lib); assert.ok(mirror, "EST_WASTE_TYPES in rates-library.html");
  const libTypes = [...mirror[1].matchAll(/\["(\w+)", "([^"]+)", "([^"]+)", "(\w+)"\]/g)].map((m) => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(libTypes, estTypes, "every Estimates element type, label, group and built-in class is listed in the library, in order");
  assert.ok(/concreteWasteClassByType: \{\}/.test(lib) && /CONC_WASTE_TYPE_MAP=\(g\.concreteWasteClassByType/.test(est), "a moved type reaches Estimates through global.concreteWasteClassByType");
  assert.ok(/function applyLibraryWasteSettings/.test(est) && /data-bulk-act="waste"/.test(est) && /openWasteApplyDialog\(\)/.test(est), "the apply-to-selected button and bulk action exist");
});

check("Quote scope: labour-only drops the supply bands and keeps the crew; materials-only drops the crew and pumping; an element can differ from the project; nothing is lost silently", () => {
  const { elementScope, categoryChargedUnder, scopeLabel, computeExcludedTotals } = costingAll;
  const { QUOTE_SCOPES } = catalogAll;
  assert.deepEqual(QUOTE_SCOPES.map((s) => s.key), ["both", "labour", "materials"]);
  // buckets: supply bands are material; pumping is labour; rate items, prelims, other allowances and subcontract quotes are always
  const bucket = (k) => FULL_CATALOG.find((c) => c.key === k).scopeBucket;
  ["CONCRETE", "PROCESSED BAR", "SQUARE MESH", "FORMWORK", "INSULATION", "SCREEDS", "HYDRONIC HEATING", "OTHER ACCESSORIES", "SAW CUTS & DOWELS", "SPECIALIST FINISHING CONCRETE", "REINFORCEMENT BY RATE"].forEach((k) => assert.equal(bucket(k), "material", k));
  assert.equal(bucket("CONCRETE PUMPING"), "labour");
  ["RATE ITEMS", "PRELIMINARIES", "OTHER ALLOWANCES", "SUB CONTRACTORS / TEMPORARY WORKS"].forEach((k) => assert.equal(bucket(k), "always", k));
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE"), pump = FULL_CATALOG.find((c) => c.key === "CONCRETE PUMPING"), rate = FULL_CATALOG.find((c) => c.key === "RATE ITEMS");
  assert.ok(categoryChargedUnder(conc, "both") && !categoryChargedUnder(conc, "labour") && categoryChargedUnder(conc, "materials"));
  assert.ok(categoryChargedUnder(pump, "both") && categoryChargedUnder(pump, "labour") && !categoryChargedUnder(pump, "materials"));
  assert.ok(categoryChargedUnder(rate, "labour") && categoryChargedUnder(rate, "materials"));
  // resolution: element over project over "both"; "inherit" and junk fall through
  assert.equal(elementScope({}, undefined), "both"); assert.equal(elementScope({}, "labour"), "labour");
  assert.equal(elementScope({ scope: "inherit" }, "labour"), "labour"); assert.equal(elementScope({ scope: "materials" }, "labour"), "materials");
  assert.equal(elementScope({ scope: "bogus" }, "bogus"), "both");
  assert.equal(scopeLabel("labour"), "Labour only"); assert.equal(scopeLabel("materials"), "Materials only"); assert.equal(scopeLabel(undefined), "Labour + materials");
  // a slab with concrete, formwork, pumping and a rate item; the crew sheet derives days from the concrete
  const rates = defaultRates();
  const item = newElementItem(ELEMENT_TYPES.find((t) => t.id === "slab_on_ground"));
  item.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 10;
  item.qtys[rateKey("FORMWORK", "Conventional", "m2")] = 20;
  item.qtys[rateKey("CONCRETE PUMPING", "Line pump — up to 70m of line (4 hr min)", "hr")] = 4;
  item.qtys[rateKey("RATE ITEMS", "Steps", "m")] = 2;
  const both = computeElementCost(item, rates);
  assert.ok(both.materialsTotal > 0 && both.labourTotal > 0, "the baseline has materials and labour");
  assert.equal(both.scope, "both"); assert.equal(both.excludedMaterials, 0); assert.equal(both.excludedLabour, 0);
  const lab = computeElementCost(item, rates, "labour");
  assert.equal(lab.scope, "labour");
  assert.equal(lab.categoryTotals["CONCRETE"], 0); assert.equal(lab.categoryTotals["FORMWORK"], 0);
  assert.ok(lab.excludedTotals["CONCRETE"] > 0 && lab.excludedTotals["FORMWORK"] > 0, "the supply bands' money is reported, not lost");
  assert.equal(lab.categoryTotals["CONCRETE PUMPING"], both.categoryTotals["CONCRETE PUMPING"], "pumping stays on a labour-only quote");
  assert.equal(lab.categoryTotals["RATE ITEMS"], both.categoryTotals["RATE ITEMS"], "rate items stay under every scope");
  assert.equal(lab.labourTotal, both.labourTotal, "the crew sheet is unchanged — the concrete quantity still drives it");
  assert.equal(lab.concreteQty, 10, "quantities are never touched");
  assert.ok(Math.abs(lab.materialsTotal + lab.excludedMaterials - both.materialsTotal) < 1e-6, "charged + excluded = the full materials figure");
  assert.ok(Math.abs(lab.total - (both.total - lab.excludedMaterials)) < 1e-6);
  const mat = computeElementCost(item, rates, "materials");
  assert.equal(mat.scope, "materials"); assert.equal(mat.labourTotal, 0); assert.equal(mat.excludedLabour, both.labourTotal, "the crew sheet is reported, not charged");
  assert.equal(mat.categoryTotals["CONCRETE PUMPING"], 0); assert.ok(mat.excludedTotals["CONCRETE PUMPING"] > 0, "pumping is placement — not supply");
  assert.equal(mat.categoryTotals["CONCRETE"], both.categoryTotals["CONCRETE"]); assert.equal(mat.categoryTotals["RATE ITEMS"], both.categoryTotals["RATE ITEMS"]);
  assert.deepEqual(mat.resourceCosts, both.resourceCosts, "crew days still shown for information");
  // the Holcim fees ride with the concrete band: not charged under labour-only
  item.qtys[rateKey("CONCRETE", "32 mpa", "m3")] = 11;   // a 3 m³ part load → minimum cartage
  const lab2 = computeElementCost(item, rates, "labour"); const both2 = computeElementCost(item, rates);
  assert.equal(lab2.categoryTotals["CONCRETE"], 0); assert.ok(Math.abs(lab2.excludedTotals["CONCRETE"] - both2.categoryTotals["CONCRETE"]) < 1e-6, "cartage, surcharge and levy are excluded with the concrete");
  // an element can differ from the project, and the grand total follows every element's own scope
  const supplyOne = { ...item, scope: "both", qtys: { ...item.qtys } };
  const items = [item, supplyOne];
  const g = computeGrandTotal(items, rates, "labour");
  assert.ok(Math.abs(g - (lab2.total + both2.total)) < 1e-6, "labour-only project, one element priced labour + materials");
  const ex = computeExcludedTotals(items, rates, "labour");
  assert.ok(Math.abs(ex.materials - lab2.excludedMaterials) < 1e-6 && ex.labour === 0);
  assert.ok(Math.abs(computeGrandTotal(items, rates) - 2 * both2.total) < 1e-6, "no project scope = labour + materials, as before");
});

check("Estimates' standalone screed: SCREED_TYPES mirror every m² SCREEDS catalog product by exact name", () => {
  const html = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const block = /const SCREED_TYPES = \[([\s\S]*?)\];/.exec(html);
  assert.ok(block, "SCREED_TYPES list present in estimates-app.html");
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const cat = FULL_CATALOG.find((c) => c.key === "SCREEDS");
  const m2 = cat.products.filter((p) => p.unit === "m2" && !/mesh|bonding|curing/i.test(p.name)).map((p) => p.name);
  assert.deepEqual(names, m2, "Estimates lists exactly the m² screed products, in catalog order");
  assert.ok(/id:"screed", label:"Screed \(standalone\)", calc:"screed"/.test(html), "library item present");
  assert.ok(/screed:\{defaults:screedDefaults, render:renderScreed, compute:computeScreed, diagram:diagScreed\}/.test(html), "calculator registered");
});

check("Import: a standalone screed lands on the matching SCREEDS element type with every product line priced 1:1", () => {
  const { screedQuotesTypeId } = importAll;
  const scr = (over) => estLine({ stage: "Floor Finishes", category: "Screed (standalone)", element: "Screed 1", elementId: "EL07", materialGroup: "Finishes", unit: "m²", ...over });
  const lines = [
    scr({ material: "Sand/cement screed bonded — 20–30mm", spec: "25 mm", finalQty: 52.5, qty: 50 }),
    scr({ material: "Bonding agent / SBR slurry coat", finalQty: 52.5 }),
    scr({ material: "Screed reinforcement mesh (galv. 50x50)", finalQty: 55.1 }),
    scr({ material: "Screed rails / levelling battens", unit: "m", finalQty: 30 }),
    scr({ material: "Screed movement joint", unit: "m", finalQty: 12 }),
    scr({ material: "Screed curing / sealing compound", finalQty: 50 }),
  ];
  assert.equal(screedQuotesTypeId(lines), "screed_bonded");
  const { quote, flags } = buildImportFromEstimate({ project: { name: "Screed job" }, lines, elementGeometry: { EL07: { countNo: 1, areaM2: 50 } } });
  assert.equal(quote.items.length, 1);
  const item = quote.items[0];
  assert.equal(item.typeId, "screed_bonded"); assert.equal(item.measureM2, 50);
  assert.equal(item.qtys[rateKey("SCREEDS", "Sand/cement screed bonded — 20–30mm", "m2")], 52.5);
  assert.equal(item.qtys[rateKey("SCREEDS", "Bonding agent / SBR slurry coat", "m2")], 52.5);
  assert.equal(item.qtys[rateKey("SCREEDS", "Screed reinforcement mesh (galv. 50x50)", "m2")], 55.1);
  assert.equal(item.qtys[rateKey("SCREEDS", "Screed rails / levelling battens", "m")], 30);
  assert.equal(item.qtys[rateKey("SCREEDS", "Screed movement joint", "m")], 12);
  assert.equal(item.qtys[rateKey("SCREEDS", "Screed curing / sealing compound", "m2")], 50);
  assert.deepEqual(flags, [], "every line found its product — no flags");
  // the type follows the product: unbonded, to falls, flowing, anhydrite, self-levelling, granolithic topping, other
  const t = (material) => screedQuotesTypeId([scr({ material, finalQty: 1 })]);
  assert.equal(t("Sand/cement screed unbonded — 65mm"), "screed_unbonded");
  assert.equal(t("Screed to falls — wet areas / balconies"), "screed_falls_wet");
  assert.equal(t("Screed to falls — roof / podium (lightweight)"), "screed_falls_roof");
  assert.equal(t("Floating screed over insulation — 75mm"), "screed_floating");
  assert.equal(t("Heated screed over hydronic pipes — 65mm"), "screed_heated");
  assert.equal(t("Pumped liquid cement screed (flowing) — 50mm"), "screed_flowing");
  assert.equal(t("Anhydrite / calcium sulphate flowing screed — 40mm"), "screed_anhydrite");
  assert.equal(t("Rapid-drying / fast-set screed — 40mm"), "screed_rapid");
  assert.equal(t("Lightweight foamed / bead screed — 50mm"), "screed_lightweight");
  assert.equal(t("Acoustic screed over resilient mat — 50mm"), "screed_acoustic");
  assert.equal(t("Fibre-reinforced screed — 50mm"), "screed_fibre_polymer");
  assert.equal(t("Self-levelling compound — 5–10mm"), "self_levelling");
  assert.equal(t("Granolithic / hard-wearing topping — 25mm"), "topping_granolithic");
  assert.equal(t("Epoxy / resin screed — 6mm"), "topping_epoxy");
  assert.equal(t("Screed (other — specify in description)"), "screed_other");
  assert.equal(screedQuotesTypeId([]), "screed_other", "no screed line → the map's fallback");
  // an SL mesh in the screed is a Reinforcement line and lands on SQUARE MESH; a finish Quotes has no product for is flagged, never dropped
  const r = buildImportFromEstimate({ project: {}, lines: [
    scr({ material: "Sand/cement screed unbonded — 50mm", finalQty: 20 }),
    scr({ materialGroup: "Reinforcement", material: "SL62", spec: "Screed mesh — mesh sheets ×1 layer", finalQty: 22, sheets: 2 }),
    scr({ material: "Mystery finish", finalQty: 3 }),
  ] });
  assert.equal(r.quote.items[0].typeId, "screed_unbonded");
  assert.equal(r.quote.items[0].qtys[rateKey("SQUARE MESH", "SL62", "m2")], 22);
  assert.equal(r.flags.length, 1); assert.match(r.flags[0], /Mystery finish/);
});

const rf = await import("../src/lib/rateFreeze.js");
const { RATES_LOCKED_STATUSES, isRatesLocked, effectiveRates, statusChangePatch, needsFreeze, freezeRates, frozenRateDrift, hasFrozenRates } = rf;
const { validityState, expiringRates, ratesWithValidity, isTimeLimited, validityLabel } = await import("../src/lib/rateValidity.js");
const { GLOBAL_PRICES, libraryValidity } = await import("../src/lib/ratesLibrarySync.js");

check("A subcontract 'quote' amount belongs to the ELEMENT (item.rateOverrides), never the shared rate — 25 Spindrift, 29 Sep 2026", () => {
  const subs = FULL_CATALOG.find((c) => c.key === "SUB CONTRACTORS / TEMPORARY WORKS");
  const screw = subs.products.find((p) => p.name === "Screw Piling");
  const key = rateKey(subs.key, screw.name, screw.unit);
  const rates = defaultRates();
  rates[key] = { ...rates[key], unitCost: 15213 };                       // what the shared rate happens to hold
  const spindrift = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles"));
  spindrift.qtys[key] = 1;
  spindrift.rateOverrides = { [key]: { unitCost: 18400 } };              // the quote received for THIS job
  const paringa = newElementItem(ELEMENT_TYPES.find((t) => t.id === "raft_foundation"));
  paringa.qtys[key] = 1;                                                 // an older project with no override of its own
  assert.equal(rowRate(spindrift, rates, key, {}).unitCost, 18400, "the element's own figure wins");
  assert.equal(rowRate(paringa, rates, key, {}).unitCost, 0, "no figure on the element → NOTHING, never the shared rate");
  assert.equal(computeElementCost(spindrift, rates).categoryTotals[subs.key], 18400);
  assert.equal(computeElementCost(paringa, rates).categoryTotals[subs.key], 0);
  // EVERY subcontract quote row is manual-only — no shared figure, no library figure, ever
  subs.products.filter((q) => q.unit === "quote").forEach((q) => assert.ok(isManualQuoteKey(rateKey(subs.key, q.name, q.unit)), q.name));
  assert.ok(subs.products.filter((q) => q.unit === "quote").length >= 7, "the whole subcontract band is quote rows");
  assert.equal(isManualQuoteKey(rateKey("CONCRETE", "Screw Piling", "m3")), false, "only a quote-unit row");
  assert.equal(isManualQuoteKey(rateKey(subs.key, "Temporary steel props/struts (150UC23.4) — supply/hire", "tonne")), false, "a tonne-priced row on the band keeps its rate");
  const sf = rateKey(subs.key, "Steel fix", "quote"); rates[sf] = { ...rates[sf], unitCost: 1650 };
  const beach = newElementItem(ELEMENT_TYPES[0]); beach.qtys[sf] = 7;
  assert.equal(computeElementCost(beach, rates).categoryTotals[subs.key], 0, "a steel-fix quote row without a figure on the element costs nothing, whatever the shared rate holds");
  beach.rateOverrides = { [sf]: { unitCost: 1650 } };
  assert.equal(computeElementCost(beach, rates).categoryTotals[subs.key], 7 * 1650, "…and prices off the element's own figure");
  // the override carries only what it states — weights/areas still come from the shared rate
  const mesh = FULL_CATALOG.find((c) => c.key === "SQUARE MESH"); const sl = mesh.products[0]; const mk = rateKey(mesh.key, sl.name, sl.unit);
  const it = newElementItem(ELEMENT_TYPES[0]); it.rateOverrides = { [mk]: { unitCost: 99 } };
  const r = rowRate(it, rates, mk, {});
  assert.equal(r.unitCost, 99); assert.equal(r.sheetArea, rates[mk].sheetArea); assert.equal(r.unitWeight, rates[mk].unitWeight);
  assert.equal(rowRate(it, rates, "no::such::key", { unitCost: 7 }).unitCost, 7, "falls back to the catalog default like lookupRate");
});

check("Finished statuses pin the rates: Completed Estimating onwards, never On Hold / Queued / Estimating", () => {
  assert.deepEqual(RATES_LOCKED_STATUSES, ["Completed Estimating", "Quoting", "Submitted", "Tendered", "Successful", "Unsuccessful", "Deadline Missed"]);
  RATES_LOCKED_STATUSES.forEach((st) => assert.ok(catalogAll.QUOTE_STATUSES.includes(st), `${st} is a real status`));
  ["Queued", "Taking Off", "Estimating", "On Hold"].forEach((st) => assert.equal(isRatesLocked(st), false, st));
  assert.equal(isRatesLocked(undefined), false);
});

check("statusChangePatch is the ONE status rule: open→locked pins live rates, locked→locked keeps the pin, locked→open drops it", () => {
  const live = defaultRates();
  const C32 = rateKey("CONCRETE", "32 mpa", "m3");
  live[C32] = { ...live[C32], unitCost: 250 };
  const open = { status: "Estimating", items: [] };
  const p1 = statusChangePatch(open, "Completed Estimating", live, "2026-09-29T00:00:00.000Z");
  assert.equal(p1.status, "Completed Estimating");
  assert.equal(p1.ratesFrozen.at, "2026-09-29T00:00:00.000Z"); assert.equal(p1.ratesFrozen.status, "Completed Estimating");
  assert.equal(p1.ratesFrozen.rates[C32].unitCost, 250);
  const done = { ...open, ...p1 };
  // the library moves on — the finished project does not
  live[C32] = { ...live[C32], unitCost: 275 };
  assert.equal(effectiveRates(done, live)[C32].unitCost, 250, "pinned copy governs while locked");
  assert.equal(effectiveRates(open, live)[C32].unitCost, 275, "an open project follows the live rates");
  assert.equal(computeGrandTotal([], effectiveRates(done, live)), 0);
  // Completed Estimating → Successful keeps the SAME pin (no silent re-price on the way through the pipeline); it only records the submission day
  const p2 = statusChangePatch(done, "Successful", live);
  assert.equal(p2.status, "Successful"); assert.equal(p2.ratesFrozen, undefined); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p2.submittedAt));
  // back to an open status drops the pin (null so a field merge clears it)
  const p3 = statusChangePatch(done, "Estimating", live);
  assert.deepEqual(p3, { status: "Estimating", ratesFrozen: null, completedAt: null });
  assert.equal(effectiveRates({ ...done, ...p3 }, live)[C32].unitCost, 275);
  // a locked project whose pin was lost gets a fresh one on the next status change too
  assert.ok(statusChangePatch({ status: "Submitted" }, "Successful", live).ratesFrozen, "no pin → pins now");
  // a product added to the catalog AFTER the pin still resolves through the live rates
  const later = { ...live, "NEW::Thing::each": { unitCost: 5 } };
  assert.equal(effectiveRates(done, later)["NEW::Thing::each"].unitCost, 5);
});

check("A project finished before pins existed is pinned on open (needsFreeze) and drift is reported, never applied", () => {
  const live = defaultRates();
  const C32 = rateKey("CONCRETE", "32 mpa", "m3");
  assert.equal(needsFreeze({ status: "Submitted", items: [] }), true);
  assert.equal(needsFreeze({ status: "Estimating", items: [] }), false);
  const q = { status: "Submitted", ratesFrozen: freezeRates(live, "Submitted") };
  assert.equal(needsFreeze(q), false); assert.ok(hasFrozenRates(q));
  assert.deepEqual(frozenRateDrift(q, live), []);
  const moved = { ...live, [C32]: { ...live[C32], unitCost: live[C32].unitCost + 10 } };
  const drift = frozenRateDrift(q, moved);
  assert.equal(drift.length, 1); assert.equal(drift[0].key, C32); assert.equal(drift[0].live, live[C32].unitCost + 10);
  assert.equal(effectiveRates(q, moved)[C32].unitCost, live[C32].unitCost, "drift is information — the pin still governs");
  assert.deepEqual(frozenRateDrift({ status: "Estimating" }, moved), [], "nothing pinned, nothing to report");
});

check("Validity dates: a time-limited rate alarms 14 days out and once lapsed, dates parse as LOCAL days", () => {
  const today = new Date(2026, 8, 29);                                    // 29 Sep 2026
  assert.deepEqual(validityState("2026-10-20", today), { state: "ok", daysLeft: 21 });
  assert.deepEqual(validityState("2026-10-13", today), { state: "expiring", daysLeft: 14 });
  assert.deepEqual(validityState("2026-09-29", today), { state: "expiring", daysLeft: 0 });
  assert.deepEqual(validityState("2026-09-28", today), { state: "expired", daysLeft: -1 });
  assert.deepEqual(validityState("", today), { state: "none", daysLeft: null });
  assert.deepEqual(validityState("30/09/2026", today), { state: "none", daysLeft: null }, "an unreadable date is no date");
  assert.equal(validityLabel({ daysLeft: -1 }), "expired 1 day ago"); assert.equal(validityLabel({ daysLeft: 0 }), "expires today"); assert.equal(validityLabel({ daysLeft: 5 }), "expires in 5 days");
  ["Production & transport surcharge", "Environment levy", "Minimum cartage (load under 4 m3)", "VicMix pigment washout charge — per truck (+ GST, pigmented mixes)", "VicMix short-load charge — delivery under the 4 m³ Maxi minimum", "VicMix delivery beyond 25 km of plant — per load", "Delivery fee"].forEach((n) => assert.ok(isTimeLimited(n), n));
  ["32 mpa", "Conventional", "Screw Piling", "N12"].forEach((n) => assert.equal(isTimeLimited(n), false, n));
  const rates = defaultRates();
  const SUR = rateKey("CONCRETE", "Production & transport surcharge", "m3");
  const LEVY = rateKey("CONCRETE", "Environment levy", "m3");
  const C32 = rateKey("CONCRETE", "32 mpa", "m3");
  rates[SUR] = { ...rates[SUR], validUntil: "2026-10-05" };               // 6 days
  rates[LEVY] = { ...rates[LEVY], validUntil: "2026-09-20" };             // lapsed
  rates[C32] = { ...rates[C32], validUntil: "2026-09-20" };               // a grade is not time-limited: ignored even with a date
  const due = expiringRates(rates, today);
  assert.deepEqual(due.map((d) => [d.key, d.state, d.daysLeft]), [[LEVY, "expired", -9], [SUR, "expiring", 6]], "lapsed first, then soonest");
  assert.equal(due[1].unitCost, rates[SUR].unitCost); assert.equal(due[1].unit, "m3");
  rates[SUR].validUntil = "2026-12-01";
  assert.deepEqual(expiringRates(rates, today).map((d) => d.key), [LEVY]);
  assert.equal(ratesWithValidity(rates, today).length, 2, "every dated time-limited rate, ok ones included");
  assert.deepEqual(expiringRates(defaultRates(), today), [], "no dates → no alarm");
});

check("Rates Library: the GLOBAL fuel/transport surcharge now governs Quotes' surcharge row, and validity dates sync as validUntil", () => {
  const SUR = rateKey("CONCRETE", "Production & transport surcharge", "m3");
  assert.deepEqual(GLOBAL_PRICES.map((g) => g.path.join(".")), ["global.concreteSurchargePerM3"]);
  const lib = { global: { concreteSurchargePerM3: 11.4 }, validity: { "Production & transport surcharge": "2026-10-12", "Environment levy": "2026-12-31", "No Such Product": "2026-01-01", "32 mpa": "not a date" } };
  assert.ok(libraryPrices(lib).some((p) => p.key === SUR && p.price === 11.4 && p.section === "global"));
  assert.ok(libraryGovernedKeys(lib).has(SUR), "the modal shows the surcharge as library-governed");
  let rates = defaultRates();
  let up = pendingRateUpdates(rates, lib, {});
  const sur = up.find((u) => u.key === SUR && u.price !== undefined);
  assert.deepEqual({ key: sur.key, price: sur.price }, { key: SUR, price: 11.4 }, "price entry keeps its {key, price} shape (plus from + name for the change log)");
  assert.equal(sur.from, 9.17); assert.equal(sur.name, "Production & transport surcharge");
  assert.deepEqual(up.find((u) => u.key === SUR && u.validUntil !== undefined), { key: SUR, validUntil: "2026-10-12" });
  assert.deepEqual(up.find((u) => u.validUntil === "2026-12-31"), { key: rateKey("CONCRETE", "Environment levy", "m3"), validUntil: "2026-12-31" });
  assert.equal(up.filter((u) => u.validUntil !== undefined).length, 2, "an unmatched name and an unreadable date are ignored");
  assert.deepEqual(libraryValidity(lib).map((v) => v.name).sort(), ["Environment levy", "Production & transport surcharge"]);
  // once applied, nothing is pending — the sync can never loop
  rates[SUR] = { ...rates[SUR], unitCost: 11.4, validUntil: "2026-10-12" };
  rates[rateKey("CONCRETE", "Environment levy", "m3")].validUntil = "2026-12-31";
  assert.deepEqual(pendingRateUpdates(rates, lib, {}), []);
  // clearing the date in the library clears it in Quotes
  assert.deepEqual(pendingRateUpdates(rates, { ...lib, validity: { "Production & transport surcharge": "", "Environment levy": "2026-12-31" } }, {}), [{ key: SUR, validUntil: "" }]);
  // a library without the block, or a global block without the figure, asks for nothing new
  assert.deepEqual(pendingRateUpdates(defaultRates(), { global: {} }, {}), []);
  assert.deepEqual(pendingRateUpdates(defaultRates(), { global: { concreteSurchargePerM3: "9.17" } }, {}), [], "a non-numeric global is ignored");
});

check("The Rates Library carries NO subcontractor rates or list (29 Sep 2026)", () => {
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  assert.ok(!/SUBCONTRACTOR_ITEMS|sec-subbies|Subcontractor Quotes/.test(html), "the subcontractor section is gone from the library");
  ["Screw Piling", "CFA Piling", "Bored Piers"].forEach((n) => assert.ok(!html.includes(`p:"${n}"`), `${n} is not a library item`));
});

check("The Rates Library's validity rows name real Quotes catalog products (the two lists cannot drift)", () => {
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const block = /const VALIDITY_ITEMS = \[([\s\S]*?)\n\];/.exec(html);
  assert.ok(block, "VALIDITY_ITEMS found in rates-library.html");
  const names = [...block[1].matchAll(/\{ name:"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.ok(names.length >= 6, `expected the surcharge, cartage, levy and the three VicMix charges; got ${names.length}`);
  const catalogNames = new Set(); FULL_CATALOG.forEach((c) => c.products.forEach((p) => catalogNames.add(p.name)));
  names.forEach((n) => { assert.ok(catalogNames.has(n), `library validity row "${n}" is not a Quotes catalog product`); assert.ok(isTimeLimited(n), `"${n}" is not a time-limited row`); });
  assert.ok(names.includes("Production & transport surcharge"));
});


const planner = await import("../src/lib/planner.js");
const { SUBMITTED_STATUSES, isSubmittedStatus, submittedLabel, daysLabel, dashboardDueLabel, isUrgent, isOverdue, OPEN_STATUSES } = planner;

check("Dashboard opens on Queued + Estimating only; submitted work lives under its tile / All projects", () => {
  assert.deepEqual(OPEN_STATUSES, ["Queued", "Taking Off", "Estimating"]);
  OPEN_STATUSES.forEach((st) => assert.ok(catalogAll.QUOTE_STATUSES.includes(st), st));
  SUBMITTED_STATUSES.forEach((st) => assert.ok(!OPEN_STATUSES.includes(st), `${st} is never on the opening screen`));
});

check("Deadline Missed (9 Oct 2026): a closed status after Unsuccessful — rates pinned, deadline clock stopped at the miss, never overdue or urgent, never 'submitted'", () => {
  const { DEADLINE_MISSED_STATUS, isDeadlineMissedStatus, missedLabel } = planner;
  const S = catalogAll.QUOTE_STATUSES;
  assert.equal(DEADLINE_MISSED_STATUS, "Deadline Missed");
  assert.ok(S.indexOf("Deadline Missed") === S.indexOf("Unsuccessful") + 1 && S.indexOf("On Hold") === S.indexOf("Deadline Missed") + 1, "sits between Unsuccessful and On Hold");
  assert.ok(catalogAll.QUOTE_STATUS_STYLES["Deadline Missed"] && /rose/.test(catalogAll.QUOTE_STATUS_STYLES["Deadline Missed"].bar), "its own rose style");
  assert.ok(RATES_LOCKED_STATUSES.includes("Deadline Missed") && !SUBMITTED_STATUSES.includes("Deadline Missed") && !OPEN_STATUSES.includes("Deadline Missed"));
  assert.ok(isDeadlineMissedStatus("Deadline Missed") && !isDeadlineMissedStatus("Unsuccessful"));
  const past = "2020-01-10";
  assert.equal(daysLabel(past, "Deadline Missed", null).text, "Deadline missed 10 Jan 2020", "frozen label, never 'N d overdue'");
  assert.equal(dashboardDueLabel(past, "Deadline Missed", null).text, "Deadline missed 10 Jan 2020");
  assert.equal(missedLabel(null).text, "Deadline missed", "no deadline recorded → no date invented");
  assert.equal(isOverdue({ status: "Deadline Missed", planner: { deadline: past } }, "2026-10-09"), false, "a recorded miss is not overdue work");
  assert.equal(isUrgent({ deadline: past, priority: "Urgent" }, "Deadline Missed"), false, "nor urgent");
  assert.equal(isOverdue({ status: "Estimating", planner: { deadline: past } }, "2026-10-09"), true, "an open project past its date still is");
  const live = { "k": { unitCost: 1 } };
  const patch = statusChangePatch({ status: "Estimating", items: [] }, "Deadline Missed", live, "2026-10-09T01:00:00.000Z");
  assert.ok(patch.ratesFrozen && patch.ratesFrozen.rates.k.unitCost === 1, "pins the live rates like every closed status");
  assert.equal(patch.submittedAt, undefined, "nothing went out — no submission day");
  assert.equal(patch.completedAt, "2026-10-09", "the day it was closed is the day the Date-completed sort uses");
  const back = statusChangePatch({ status: "Deadline Missed", ratesFrozen: patch.ratesFrozen, completedAt: "2026-10-09" }, "Estimating", live);
  assert.equal(back.ratesFrozen, null); assert.equal(back.completedAt, null, "reopening it follows the live rates again");
});

check("Deadline clock stops at submission: Submitted and later statuses count to the submission day, never to today (1 Oct 2026)", () => {
  assert.deepEqual(SUBMITTED_STATUSES, ["Submitted", "Tendered", "Successful", "Unsuccessful"]);
  SUBMITTED_STATUSES.forEach((st) => assert.ok(catalogAll.QUOTE_STATUSES.includes(st), st));
  ["Queued", "Estimating", "Completed Estimating", "Quoting", "On Hold"].forEach((st) => assert.equal(isSubmittedStatus(st), false, st));
  const past = "2020-01-10";                                           // a deadline long gone — the live count would be thousands of days
  // the label is the DAY it went out; how it landed against the deadline is the hover note
  assert.equal(submittedLabel(past, "2020-01-08").text, "Submitted 8 Jan 2020"); assert.equal(submittedLabel(past, "2020-01-08").note, "2d before the 10 Jan 2020 deadline");
  assert.equal(submittedLabel(past, "2020-01-10").text, "Submitted 10 Jan 2020"); assert.equal(submittedLabel(past, "2020-01-10").note, "on the deadline day");
  assert.equal(submittedLabel(past, "2020-01-13").text, "Submitted 13 Jan 2020"); assert.equal(submittedLabel(past, "2020-01-13").note, "3d after the 10 Jan 2020 deadline");
  assert.equal(submittedLabel(past, null).text, "Submitted", "no recorded day → no invented date or count");
  assert.equal(submittedLabel(null, "2020-01-13").text, "Submitted 13 Jan 2020"); assert.equal(submittedLabel(null, "2020-01-13").note, "no deadline was set");
  assert.equal(dashboardDueLabel(past, "Submitted", "2020-01-13").text, "Submitted 13 Jan 2020"); assert.equal(dashboardDueLabel(past, "Submitted", "2020-01-13").title, "3d after the 10 Jan 2020 deadline");
  assert.equal(dashboardDueLabel(past, "Successful", "2020-01-08").text, "Submitted 8 Jan 2020");
  assert.ok(/overdue/.test(dashboardDueLabel(past, "Quoting", null).text), "an open quote still counts up");
  assert.ok(/overdue/.test(daysLabel(past, "Estimating").text));
  assert.equal(daysLabel(past, "Tendered", "2020-01-10").text, "Submitted 10 Jan 2020");
  assert.equal(dashboardDueLabel(null, "Estimating"), null);
  // urgency and the Planner's overdue tile follow the same rule
  assert.equal(isUrgent({ deadline: past, priority: "Urgent" }, "Submitted"), false);
  assert.equal(isUrgent({ deadline: past, priority: "Low" }, "Estimating"), true);
  assert.equal(isOverdue({ status: "Quoting", planner: { deadline: past } }, "2026-10-01"), true);
  assert.equal(isOverdue({ status: "Submitted", planner: { deadline: past } }, "2026-10-01"), false);
  assert.equal(isOverdue({ status: "Quoting", planner: { deadline: "2099-01-01" } }, "2026-10-01"), false);
});

check("statusChangePatch records completedAt the day a status enters the locked set, keeps it through the pipeline, clears it on the way back; completedDay falls back to the pin", () => {
  const { completedDay } = rf;
  const live = defaultRates();
  const p1 = statusChangePatch({ status: "Estimating" }, "Completed Estimating", live, "2026-09-29T02:00:00.000Z");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p1.completedAt), `a local day, got ${p1.completedAt}`);
  const done = { status: "Completed Estimating", ...p1 };
  assert.equal(statusChangePatch(done, "Quoting", live).completedAt, undefined, "Completed → Quoting keeps the recorded day");
  assert.equal(statusChangePatch(done, "Submitted", live).completedAt, undefined, "and so does Submitted");
  assert.equal(statusChangePatch(done, "On Hold", live).completedAt, null, "back to an open status clears it (null so a field merge removes it)");
  assert.equal(statusChangePatch({ status: "Queued" }, "On Hold", live).completedAt, undefined, "an open → open move never touches it");
  // straight from Estimating to Submitted: finished AND submitted that day
  const p2 = statusChangePatch({ status: "Estimating" }, "Submitted", live, "2026-10-01T02:00:00.000Z");
  assert.ok(p2.completedAt && p2.submittedAt, "both days recorded");
  // a project locked before the field existed is filled in on its next move within the pipeline
  assert.ok(statusChangePatch({ status: "Quoting", ratesFrozen: freezeRates(live, "Quoting") }, "Submitted", live).completedAt, "unrecorded → set now");
  // completedDay: the recorded day, else the pin's moment, else nothing — never today
  assert.equal(completedDay({ completedAt: "2026-09-29" }), "2026-09-29");
  assert.ok(/^2026-09-2[89]$/.test(completedDay({ ratesFrozen: { at: "2026-09-28T23:30:00.000Z", status: "Completed Estimating", rates: {} } })), "the pin's moment as a local day");
  assert.equal(completedDay({ status: "Estimating" }), null);
  assert.equal(completedDay({ ratesFrozen: { at: "garbage" } }), null);
  assert.equal(completedDay(null), null);
});

check("sortProjects is the ONE project-list order: every key, both directions, missing dates sink either way, ties by name, stable", () => {
  const row = (name, extra = {}) => ({ project: { createdAt: "2026-09-01T00:00:00.000Z" }, name, client: "", date: null, deadline: null, completedAt: null, submittedAt: null, status: "Queued", sellExGst: 0, directCost: 0, elementCount: 0, ...extra });
  const rows = [
    row("Beta", { project: { createdAt: "2026-09-10T00:00:00.000Z" }, completedAt: "2026-09-20", submittedAt: null, deadline: "2026-10-05", date: "2026-09-02", client: "Zed", status: "Submitted", sellExGst: 300, directCost: 200, elementCount: 2 }),
    row("Alpha", { project: { createdAt: "2026-09-12T00:00:00.000Z" }, completedAt: null, submittedAt: "2026-09-30", deadline: null, date: "2026-09-01", client: "Ann", status: "Estimating", sellExGst: 100, directCost: 50, elementCount: 9 }),
    row("Gamma", { project: { createdAt: "2026-09-11T00:00:00.000Z" }, completedAt: "2026-09-25", submittedAt: "2026-09-28", deadline: "2026-10-01", date: null, client: "Bob", status: "Completed Estimating", sellExGst: 300, directCost: 80, elementCount: 5 }),
  ];
  const names = (key, dir) => sortProjects(rows, key, dir).map((r) => r.name).join(",");
  assert.equal(names("added"), "Alpha,Gamma,Beta", "newest added first by default");
  assert.equal(names("added", "asc"), "Beta,Gamma,Alpha");
  assert.equal(names("completed"), "Gamma,Beta,Alpha", "latest completed first; the unfinished one last");
  assert.equal(names("completed", "asc"), "Beta,Gamma,Alpha", "ascending still leaves the unfinished one last");
  assert.equal(names("submitted"), "Alpha,Gamma,Beta", "Beta never went out → last");
  assert.equal(names("deadline"), "Gamma,Beta,Alpha", "soonest deadline first; no deadline last");
  assert.equal(names("deadline", "desc"), "Beta,Gamma,Alpha");
  assert.equal(names("date"), "Beta,Alpha,Gamma");
  assert.equal(names("name"), "Alpha,Beta,Gamma"); assert.equal(names("name", "desc"), "Gamma,Beta,Alpha");
  assert.equal(names("client"), "Alpha,Gamma,Beta");
  assert.equal(names("status"), "Alpha,Gamma,Beta", "pipeline order: Estimating, Completed Estimating, Submitted");
  assert.equal(names("value"), "Beta,Gamma,Alpha", "equal values tie on the name");
  assert.equal(names("cost"), "Beta,Gamma,Alpha"); assert.equal(names("elements"), "Alpha,Gamma,Beta");
  assert.equal(names("nonsense"), "Alpha,Beta,Gamma", "an unknown key: nothing to compare, names A→Z");
  assert.deepEqual(sortProjects(null, "name"), []);
  assert.equal(rows[0].name, "Beta", "the input is never reordered in place");
  // the directions each key opens on, and the Settings preference read
  assert.equal(defaultSortDir("completed"), "desc"); assert.equal(defaultSortDir("deadline"), "asc"); assert.equal(defaultSortDir("name"), "asc"); assert.equal(defaultSortDir("value"), "desc");
  assert.equal(preferredSortKey({ quotesDefaultSort: "completed" }), "completed");
  assert.equal(preferredSortKey({ quotesDefaultSort: "bogus" }), "added"); assert.equal(preferredSortKey(null), "added");
  assert.ok(PROJECT_SORTS.every((o) => isProjectSortKey(o.key) && sortValue(rows[0], o.key) !== undefined));
  assert.equal(sortValue({ status: "Not a status" }, "status"), catalogAll.QUOTE_STATUSES.length, "an unknown status sorts after the pipeline");
  // the portal Settings "Dashboard sort order" select offers exactly these keys
  const html = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  const sel = /<select id="settings-sort">([\s\S]*?)<\/select>/.exec(html)[1];
  const opts = [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(opts, PROJECT_SORTS.map((o) => o.key), "Settings lists every PROJECT_SORTS key in menu order");
});

check("statusChangePatch records submittedAt on entering Submitted, keeps it through the pipeline, clears it on the way back", () => {
  const live = defaultRates();
  const open = { status: "Quoting", items: [], ratesFrozen: freezeRates(live, "Quoting") };
  const p1 = statusChangePatch(open, "Submitted", live, "2026-10-01T03:00:00.000Z");
  assert.equal(p1.status, "Submitted");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p1.submittedAt), `a local day, got ${p1.submittedAt}`);
  assert.equal(p1.ratesFrozen, undefined, "already pinned — the pin is kept untouched");
  const sub = { ...open, ...p1 };
  assert.deepEqual(statusChangePatch(sub, "Successful", live), { status: "Successful" }, "Submitted → Successful keeps the recorded day");
  const back = statusChangePatch(sub, "Estimating", live);
  assert.equal(back.submittedAt, null, "back to an open status clears it (null so a field merge removes it)");
  assert.equal(back.ratesFrozen, null);
  // a project that was submitted before the day was recorded gets today's when it next changes INTO a submitted status only
  assert.deepEqual(statusChangePatch({ status: "Submitted", ratesFrozen: freezeRates(live, "Submitted") }, "Tendered", live).submittedAt && "set", "set", "an unrecorded day is filled in on the next move within the pipeline");
});


check("Project Geometry carries a COUNT: $/no. leads the benchmark rates, sums across the project, and travels from Estimates (2 Oct 2026)", () => {
  const rates = defaultRates();
  const piles = newElementItem(ELEMENT_TYPES.find((t) => t.id === "screw_piles"));
  piles.labourAuto = false;
  const subs = FULL_CATALOG.find((c) => c.key === "SUB CONTRACTORS / TEMPORARY WORKS");
  const key = rateKey(subs.key, "Screw Piling", "quote");
  piles.qtys[key] = 1; piles.rateOverrides = { [key]: { unitCost: 24000 } };
  assert.deepEqual(computeElementUnitRates(piles, rates), [], "no count, no run, no area, no concrete → no rates");
  piles.measureNo = 12;
  const r = computeElementUnitRates(piles, rates);
  assert.deepEqual(r.map((x) => x.unit), ["no."]);
  assert.equal(r[0].qty, 12); assert.equal(r[0].rate, 2000, "$24,000 over 12 piles = $2,000 a pile");
  piles.measureLm = 96;
  assert.deepEqual(computeElementUnitRates(piles, rates).map((x) => x.unit), ["no.", "lm"], "fixed order: no. → lm → m² → m³");
  const pr = computeProjectUnitRates([piles], rates);
  assert.equal(pr.find((x) => x.unit === "no.").qty, 12); assert.equal(pr.find((x) => x.unit === "no.").rate, 2000);
  // the bridge: the takeoff's count arrives as measureNo, sums on a combined card, and re-matches by name
  const geo = [{ id: "e1", name: "Screw Piles 1", countNo: 8, runM: 0, areaM2: 0 }, { id: "e2", name: "Screw Piles 2", countNo: 4, runM: 0, areaM2: 0 }];
  const g = geometryForLabel("Screw Piles", geo);
  assert.equal(g.countNo, 12); assert.deepEqual(g.matched, ["Screw Piles 1", "Screw Piles 2"]);
});

// ---------------------------------------------------------------------------
// AI provider keys: server-side only, reported without key material (api/_providers.js)
// ---------------------------------------------------------------------------
{
  const P = await import("../api/_providers.js");
  const none = P.providerStatus({});
  check("AI providers: with no keys nothing is configured and there is no default", () => assertTrue(none.length === 3 && none.every((p) => !p.configured && !p.isDefault) && P.defaultProviderId({}) === null));
  const env = { OPENAI_API_KEY: "sk-secret-1", DEEPSEEK_API_KEY: "ds-secret-2", OPENAI_MODEL: "gpt-x" };
  const st = P.providerStatus(env);
  check("AI providers: the first configured provider is the default unless AI_PROVIDER names another", () => assertTrue(st.find((p) => p.id === "openai").isDefault && !st.find((p) => p.id === "deepseek").isDefault && P.defaultProviderId({ ...env, AI_PROVIDER: "deepseek" }) === "deepseek" && P.defaultProviderId({ ...env, AI_PROVIDER: "anthropic" }) === "openai"));
  check("AI providers: the model env var overrides the default and the status never carries key material", () => assertTrue(st.find((p) => p.id === "openai").model === "gpt-x" && st.find((p) => p.id === "anthropic").model === "claude-opus-5-5" && !JSON.stringify(st).includes("secret")));
  let threw = null; try { await P.callText("openai", { prompt: "x", env: {} }); } catch (e) { threw = e; }
  check("AI providers: a call on an unconfigured provider fails with 503 and names the variable to set", () => assertTrue(threw && threw.status === 503 && /OPENAI_API_KEY/.test(threw.message)));
}

// ---------------------------------------------------------------------------
// AI Engine: provider switch, document reading, the job function, the chat (api/ai-engine.js, api/ai-chat.js)
// ---------------------------------------------------------------------------
{
  const P = await import("../api/_providers.js");
  const E = await import("../api/ai-engine.js");
  const C = await import("../api/ai-chat.js");
  check("AI providers: OPEN_AI_KEY is accepted as the OpenAI key (the spelling set on 10 Oct 2026)", () => assertTrue(P.providerStatus({ OPEN_AI_KEY: "k" }).find((p) => p.id === "openai").configured && P.defaultProviderId({ OPEN_AI_KEY: "k" }) === "openai"));
  check("AI providers: OpenAI chat calls send max_completion_tokens (its models reject max_tokens), DeepSeek keeps max_tokens", () => assertTrue(JSON.stringify(P.tokenLimit({ id: "openai" }, 5)) === '{"max_completion_tokens":5}' && JSON.stringify(P.tokenLimit({ id: "deepseek" }, 5)) === '{"max_tokens":5}' && !/max_tokens: maxTokens,\n\s+messages/.test(fs.readFileSync(new URL("../api/_providers.js", import.meta.url), "utf8"))));
  check("AI providers: resolveProviderId honours the browser's choice only when that provider has a key, else the default", () => assertTrue(P.resolveProviderId("openai", { OPEN_AI_KEY: "a", ANTHROPIC_API_KEY: "b" }) === "openai" && P.resolveProviderId("deepseek", { ANTHROPIC_API_KEY: "b" }) === "anthropic" && P.resolveProviderId(undefined, {}) === null));
  let t501 = null; try { await P.callDocuments("deepseek", { prompt: "x", documents: [{ url: "https://x/a.pdf" }], env: { DEEPSEEK_API_KEY: "k" } }); } catch (e) { t501 = e; }
  check("AI Engine: a PDF job on DeepSeek fails with 501 and says to switch provider (it cannot read documents)", () => assertTrue(t501 && t501.status === 501 && /switch/i.test(t501.message)));
  check("AI Engine: parseJsonLoose reads a fenced or prefixed JSON object and returns null for none", () => assertTrue(P.parseJsonLoose("Here:\n```json\n{\"a\":[1,2]}\n```")?.a?.length === 2 && P.parseJsonLoose("no json") === null));
  const cut = '{"project":{"name":"X"},"sheets":[{"ref":"S-01"}],"elements":[{"type":"padfooting","label":"PF1 \\"big\\"","qty":4,"bars":{"main":{"dia":"N16"}}},{"type":"column","label":"C1","qty":6},{"type":"wall","label":"W1 [cut';
  const sal = P.salvageArrays(cut, ["elements", "sheets", "unreadable"]);
  check("AI Engine: a reply cut off mid-element keeps every element that closed (quotes and nesting respected), the sheets and the project; nothing usable → null", () => assertTrue(sal.elements.length === 2 && sal.elements[0].label === 'PF1 "big"' && sal.elements[0].bars.main.dia === "N16" && sal.sheets.length === 1 && sal.project.name === "X" && P.salvageArrays("no json", ["elements"]) === null));
  check("AI Engine: the takeoff prompt asks for compact JSON without null keys and short evidence (a 6.7 MB set overran the output limit on 10 Oct 2026)", () => assertTrue(/OMIT every key whose value would be null/.test(E.takeoffPrompt({ types: [], projectName: "P" })) && /under 80 characters/.test(E.takeoffPrompt({ types: [] }))));
  const bad = await E.runAiJob({ action: "nope" }, {});
  const noFiles = await E.runAiJob({ action: "takeoff", files: [], types: [{ id: "x" }] }, {});
  const notPdf = await E.runAiJob({ action: "spec", files: [{ url: "https://x/a.docx", name: "a" }] }, { ANTHROPIC_API_KEY: "k" });
  const noTypes = await E.runAiJob({ action: "takeoff", files: [{ url: "https://x/a.pdf", name: "a" }] }, { ANTHROPIC_API_KEY: "k" });
  const noProv = await E.runAiJob({ action: "spec", files: [{ url: "https://x/a.pdf", name: "a" }] }, {});
  const ds = await E.runAiJob({ action: "spec", provider: "deepseek", files: [{ url: "https://x/a.pdf", name: "a" }] }, { DEEPSEEK_API_KEY: "k" });
  check("AI Engine: the job function rejects a bad action, no files, a non-PDF, a takeoff without the type list (400) and no provider (503) without calling any model", () => assertTrue(bad.status === 400 && noFiles.status === 400 && notPdf.status === 400 && /PDF/.test(notPdf.body.error) && noTypes.status === 400 && noProv.status === 503));
  check("AI Engine: a document job routed to DeepSeek answers 501 with the provider named", () => assertTrue(ds.status === 501 && ds.body.provider === "deepseek"));
  const tp = E.takeoffPrompt({ types: [{ id: "padfooting", label: "Pad Footing", group: "Foundations" }], projectName: "P", profile: { defaults: { coverByElement: { all: 50 } } } });
  check("AI Engine: the takeoff prompt carries the element type ids, the JSON shape and the spec profile, and asks for evidence and confidence", () => assertTrue(/padfooting — Pad Footing/.test(tp) && /"confidence": "high"\|"medium"\|"low"/.test(tp) && /coverByElement/.test(tp) && /evidence/.test(tp)));
  check("AI Engine: the spec prompt asks for page and quote on every item and forbids invented standards", () => assertTrue(/"page": number, "quote": string/.test(E.specPrompt({})) && /Do not list standards or clauses that are not on the pages/.test(E.specPrompt({}))));
  // Cogs on reinforcement (Grady, 9 Nov 2026: "add cog option to reinforcement in estimates")
  {
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    assert.match(est, /\["cog","Cog — the typed cog length \(Cogs section\)"\]/, "every anchorage select offers Cog");
    assert.match(est, /if\(type==="cog"\) return \{mm:Math\.max\(0,num\(custom\)\), bySection:false, cog:true/, "a cog is the typed length, never a diameter multiple or the section rule");
    assert.match(est, /function hookLeg\(inst,type,dia,custom\)\{ if\(type==="cog" && !\(num\(custom\)>0\)\) custom=inst\.data\.cogMm;/, "the element's cog length is the fallback");
    assert.match(est, /hookLegOf\(r\.startA,bd,g\.secDepthMm,cvr,inst\.data\.cogMm\)/, "raft beam rows read the same length");
    assert.match(est, /let out=calc\.compute\(inst,def\);\n\s*applyCogs\(inst,def,out\);\s*\/\/[^\n]*\n\s*applyConcreteOverride\(inst,def,out\);/, "the cog pass runs right after the calculator, before the by-rate replacement");
    assert.match(est, /\$\{parts\.reo\}\$\{cogSection\(inst\)\}<\/div>/, "the Cogs section sits on every Reinforcement tab's detailed block");
    assert.match(est, /if\(l\.materialGroup!=="Reinforcement" \|\| l\.unit!=="m" \|\| !\(num\(l\.bars\)>0\) \|\| l\.manualOverride\) return;/, "only metre bar lines with a bar count take the cog");
    const tagged = (est.match(/bars:(count|N\*count|N\*num\(qty\)|count\*N|ev\?0:N\*count)|spec:label,bars,qty/g) || []).length;
    assert.ok(tagged >= 11, `the main-bar lines carry a bar count (${tagged})`);
    assert.ok(!/spec:\`\$\{label\} \(area covered[^]*?bars:/.test(est.slice(est.indexOf("(area covered"), est.indexOf("(area covered") + 400)), "a by-area mat is a rate — never cogged");
    const cogFn = est.slice(est.indexOf("function applyCogs"), est.indexOf("function reoMethodSection"));
    assert.ok(!/l\.spec\s*=/.test(cogFn), "the spec (the manual-override key) is never changed by the cog pass");
    assert.match(cogFn, /no cog length is typed — nothing is added until it is/, "cogs on with no length = a completeness warning, never a silent zero");
    // R8 ligatures (Grady, 9 Nov 2026: "include r8 ligatures"): every Estimates bar size is a PROCESSED BAR row, at d²/162 kg/m for the plain rounds
    const sizes = JSON.parse(/const BARSIZES = (\[[^\]]*\])/.exec(est)[1]);
    assert.deepEqual(sizes, ["N10","N12","N16","N20","N24","N28","N32","N36","N40","R6","R8","R10"], "Estimates bar sizes carry R6 / R8 / R10");
    const pb = FULL_CATALOG.find((c) => c.key === "PROCESSED BAR");
    for (const sz of sizes) { const prod = pb.products.find((p) => p.name === sz); assert.ok(prod, `PROCESSED BAR prices ${sz}`); assert.equal(prod.unit, "m"); }
    for (const [sz, d] of [["R6", 6], ["R8", 8], ["R10", 10]]) { const prod = pb.products.find((p) => p.name === sz); assert.equal(prod.unitWeight, Math.round(d * d / 162 * 1000) / 1000, `${sz} weighs d²/162`); assert.equal(prod.unitCost, 1925, `${sz} at the flat mill rate`); }
    const names = (src) => { const i = src.indexOf('"Processed Bar": { buildup:"Processed", items:['); return [...src.slice(i, src.indexOf("]},", i)).matchAll(/\{p:"([^"]+)",u:"m",w:([0-9.]+)\}/g)].map((m) => [m[1], Number(m[2])]); };
    for (const [file, label] of [["../portal/rates-library.html", "Rates Library"], ["../portal/cost-planner.html", "Cost Planner"]]) {
      const list = names(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
      assert.deepEqual(list.map((x) => x[0]), pb.products.map((p) => p.name), `${label}'s Processed Bar table lists the catalog's sizes in order`);
      for (const [nm, w] of list) assert.equal(w, pb.products.find((p) => p.name === nm).unitWeight, `${label} ${nm} kg/m = catalog`);
    }
    { const { quote, flags } = buildImportFromEstimate({ project: {}, lines: [estLine({ material: "N20 concrete", finalQty: 1 }), { ...estLine({}), materialGroup: "Reinforcement", material: "R8", spec: "Ligatures / stirrups", unit: "m", finalQty: 52.5 }] });
      assert.equal(quote.items[0].qtys[rateKey("PROCESSED BAR", "R8", "m")], 52.5, "an R8 ligature line bridges onto PROCESSED BAR R8"); assert.ok(!flags.some((f) => /R8/.test(f)), "and is not flagged as unmatched"); }
  }
  // Precast / tilt-up panels wired through both apps (Grady, 9 Nov 2026: "include precast panels in the estimates and the quotes with all geometry applicable etc and wire it in")
  {
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    // Quotes: the category, its four types, their crew sheet, the band and its rows
    const pc = ELEMENT_TYPES.filter((t) => t.category === "PRECAST / TILT-UP");
    assert.deepEqual(pc.map((t) => t.id), ["precast_wall_panel", "precast_column_beam", "precast_floor_plank", "precast_stitch_grout"]);
    assert.deepEqual([...new Set(pc.map((t) => t.section))], ["PRECAST PANELS", "PRECAST JOINTS & EMBEDS"]);
    assert.ok(pc.every((t) => t.labour === "precast") && LABOUR_TEMPLATES.precast, "precast types carry the precast crew-sheet template");
    assert.equal(CATEGORY_ORDER.indexOf("PRECAST / TILT-UP"), CATEGORY_ORDER.indexOf("VERTICAL STRUCTURE") + 1, "precast sits right after the vertical structure");
    const band = FULL_CATALOG.find((c) => c.key === "PRECAST / TILT-UP");
    assert.ok(band && band.scopeBucket === "always" && !band.weightBasis && !band.areaBasis && !band.volumeRateBasis, "the band is a typed-figures band");
    assert.deepEqual(band.visibleFor, ["PRECAST / TILT-UP"], "the band renders and costs only on precast elements");
    assert.deepEqual(band.products.map((p) => p.unit), ["quote", "quote", "quote", "each", "each", "each", "each"]);
    band.products.filter((p) => p.unit === "quote").forEach((p) => assert.equal(p.unitCost, null, `${p.name} carries no catalog price — a subcontract quote is typed on the element`));
    band.products.filter((p) => p.unit === "each" && p.unitCost === 0).forEach((p) => assert.match(p.name, /no published rate/, `${p.name} seeds $0 and says so`));
    assert.equal(band.products.filter((p) => p.unit === "each" && p.unitCost === 0).length, 2, "two rows have no published rate");
    assert.equal(band.products.find((p) => /Lifting insert/.test(p.name)).unitCost, 15.19); assert.equal(band.products.find((p) => /Non-shrink grout/.test(p.name)).unitCost, 34.09);
    const panel = { typeId: "precast_wall_panel", category: "PRECAST / TILT-UP" };
    assert.ok(categoryAppliesTo(band, panel) && !categoryAppliesTo(band, { typeId: "strip_footings", category: "FOUNDATIONS" }), "the band is on a panel, not a footing");
    assert.ok(FULL_CATALOG.filter((c) => !c.visibleFor).every((c) => categoryAppliesTo(c, panel)), "every ordinary band is still on the panel card");
    band.products.filter((p) => p.unit === "quote").forEach((p) => assert.ok(costingAll.isManualQuoteKey(rateKey("PRECAST / TILT-UP", p.name, "quote")), "supply and erection are manual-only quote rows"));
    // Costing rules: no blinding, finish = one face, the handover never digs
    assert.deepEqual(costingAll.blindingPartsFor({ typeId: "precast_wall_panel" }), [], "a precast panel never blinds");
    const fb = costingAll.finishBuildUp({ typeId: "precast_wall_panel", measureM2: 96, qtys: {} });
    assert.equal(fb.m2, 96); assert.match(fb.method, /one face of the panels/);
    assert.match(fs.readFileSync(new URL("../src/lib/handover.js", import.meta.url), "utf8"), /NO_DIG = new Set\(\["VERTICAL STRUCTURE", "PRECAST \/ TILT-UP"/, "the handover's dig band skips precast");
    // Estimates: the panel schedule, the erection items and the geometry publish
    assert.match(est, /function panelScheduleTotals\(d\)\{/, "panelScheduleTotals is the ONE schedule reading");
    assert.match(est, /if\(panelScheduleOn\(d\)\) return panelScheduleTotals\(d\)\.edgeM;/, "the schedule's edge length is the perimeter (edge forms)");
    assert.match(est, /let area = ps\? ps\.grossM2 : d\.manualArea\?/, "the schedule's gross area drives the slab area");
    assert.match(est, /let openArea= \(ps\? ps\.openM2 : 0\) \+ openTot\.areaM2;/, "the schedule's openings come off");
    assert.match(est, /: precast\? slabPerimM\(d\)\s*: 0;/, "autoGeometry publishes a panel set's edge length as its run");
    assert.match(est, /const countNo = \(precast && panelScheduleOn\(d\)\)\? panelScheduleTotals\(d\)\.count : Math\.max\(0, num\(d\.qty, 1\)\);/, "the schedule's count is the element's No.");
    assert.match(est, /leaf==="panelRows"\? \{mark:`P\$\{arr\.length\+1\}`, qty:1, hMm:3000, wMm:2400, openM2:0, openPerM:0\}/, "the add-row template precedes the generic Rows rule");
    assert.ok(est.indexOf('leaf==="panelRows"') < est.indexOf('/Rows$/.test(leaf)'), "panelRows is matched before /Rows$/");
    assert.match(est, /const GROUT_BAG_LITRES = 11;/);
    // every panel edge is selectable (Grady, 9 Nov 2026: "FORMWORK for precast should have all perimeter possible to select")
    assert.match(est, /function panelEdgeSelection\(d\)\{/, "panelEdgeSelection is the ONE reading of the edges formed");
    assert.match(est, /const top = d\.panelEdgeTop===undefined\? true : !!d\.panelEdgeTop, bottom = d\.panelEdgeBottom===undefined\? true : !!d\.panelEdgeBottom;/, "an unset edge is formed — a takeoff saved before the choice forms all four");
    assert.match(est, /edge=sel\.widths\*w\+sel\.sides\*h;/, "the schedule's edge run is the selected edges: widths × W + sides × H");
    assert.match(est, /4\*Math\.sqrt\(A\/n\)\*n\*panelEdgeSelection\(d\)\.fraction : 0;/, "the square-panel assumption forms only the selected fraction");
    assert.match(est, /data-testid="panel-edges"/); assert.match(est, /selOpts\("panelEdgeSides",String\(sel\.sides\),\[\["2","Both sides"\],\["1","One side[^"]*"\],\["0","None"\]\]\)/, "sides: both / one / none");
    assert.match(est, /panelRows\.\$\{i\}\.openPerM/, "the schedule row carries the reveal perimeter");
    assert.match(est, /const revLm = revealsOn\? \(ps\? ps\.revealM : num\(d\.panelRevealRunM\)\) : 0;/, "panel reveals come from the schedule or the typed run");
    assert.match(est, /<\/div><\/div>\$\{panelEdgeFormSection\(inst\)\}/, "the edge section sits on the slab's Formwork tab, right under the Slab Formwork ticks");
    // the three erection line names are the catalog rows' exact names, so the bridge lands them 1:1
    for (const [cst, re] of [["PRECAST_INSERT_PRODUCT", /Lifting insert/], ["PRECAST_PROP_PRODUCT", /props \/ braces hire/], ["PRECAST_GROUT_PRODUCT", /Non-shrink grout/]]) {
      const m = est.match(new RegExp(`const ${cst} = "([^"]+)";`)); assert.ok(m, `${cst} declared`);
      assert.ok(band.products.some((p) => p.name === m[1] && p.unit === "each" && re.test(p.name)), `${cst} names the catalog row exactly`);
    }
    assert.match(est, /let conns=panelErectionSection\(inst\)\+starterRunsUI\(inst,d,slabPerimM\(d\),"slab","slab perimeter"\);/, "the erection block heads the slab's Connections tab");
    // the library's waste-type mirror and the bridge's type map carry the three Estimates precast labels
    for (const label of ["Precast / Tilt-up Panel (supply-and-fix allowance)", "Precast / Tilt-up Panel (measured — total area, mesh, bars, edge forms)", "Precast Stitch / Grout / Embeds"]) {
      assert.ok(importAll.ESTIMATE_TYPE_MAP[label], `${label} is bridged`); assert.ok(est.includes(`label:"${label}"`), `${label} is an Estimates library label`);
    }
    assert.equal(importAll.ESTIMATE_TYPE_MAP["Precast / Tilt-up Panel (measured — total area, mesh, bars, edge forms)"], "precast_wall_panel");
    assert.equal(importAll.ESTIMATE_TYPE_MAP["Precast Stitch / Grout / Embeds"], "precast_stitch_grout");
    // the bridge: a measured panel's lines land on the wall panel type, the inserts / props / grout bags on the band, the concrete on CONCRETE
    const L = (o) => estLine({ stage: "Precast / Tilt-up", category: "Precast / Tilt-up Panel (measured — total area, mesh, bars, edge forms)", element: "Precast Panel 1", elementId: "PC1", ...o });
    const { quote, flags } = buildImportFromEstimate({ project: { name: "Panels" }, lines: [
      L({ materialGroup: "Concrete", material: "N40 concrete", unit: "m³", finalQty: 14.4 }),
      L({ materialGroup: "Connections", material: "Lifting insert / face lifter 5 t (cast-in)", unit: "no.", finalQty: 24 }),
      L({ materialGroup: "Temporary Works", material: "Panel props / braces hire (no published rate — enter the hire quote per prop)", unit: "no.", finalQty: 24 }),
      L({ materialGroup: "Joints", material: "Non-shrink grout — 20 kg bag (SikaGrout-212 HP class)", unit: "no.", finalQty: 6 }),
    ], elementGeometry: { PC1: { countNo: 12, runM: 129.6, areaM2: 86.4 } } });
    const it = quote.items[0];
    assert.equal(it.typeId, "precast_wall_panel");
    assert.equal(it.qtys[rateKey("PRECAST / TILT-UP", "Lifting insert / face lifter 5 t (cast-in)", "each")], 24);
    assert.equal(it.qtys[rateKey("PRECAST / TILT-UP", "Panel props / braces hire (no published rate — enter the hire quote per prop)", "each")], 24);
    assert.equal(it.qtys[rateKey("PRECAST / TILT-UP", "Non-shrink grout — 20 kg bag (SikaGrout-212 HP class)", "each")], 6);
    assert.ok(!flags.some((f) => /Lifting insert|props \/ braces|Non-shrink grout/.test(f)), `erection items are not flagged: ${flags.join(" | ")}`);
    assert.equal(it.measureNo, 12); assert.equal(it.measureLm, 129.6); assert.equal(it.measureM2, 86.4);
    const cost = computeElementCost(it, defaultRates());
    assert.equal(Math.round(cost.categoryTotals["PRECAST / TILT-UP"] * 100) / 100, Math.round((24 * 15.19 + 6 * 34.09) * 100) / 100, "the band prices the inserts and the grout; the $0 props row and the unquoted supply rows cost nothing");
  }
  // Re-entrant corner reinforcement is ONE shared block — bars, trench-mesh / mesh strips, sheet pieces — on slabs, walls and composites (Grady, 10 Nov 2026)
  {
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    assert.match(est, /function reentrantSection\(inst, autoCount, autoNote\)\{/, "reentrantSection is the ONE renderer");
    assert.match(est, /function reentrantLines\(inst,def,autoCount\)\{/, "reentrantLines is the ONE pricing");
    assert.equal((est.match(/Diagonal Re-entrant Corner Bars/g) || []).length, 1, "the block's markup exists once, in the shared renderer");
    assert.match(est, /\[\["bars","Diagonal bars"\],\["strip","Trench mesh \/ mesh strip \(cut to width\)"\],\["sheet","Mesh sheet piece \(SL\/RL offcut, L × W\)"\]\]/, "the three materials");
    assert.match(est, /reentrantSection\(inst, reentrantCornerCount\(d\), "sketch shows"\)/, "the slab passes its sketched reflex corners");
    assert.match(est, /lines\.push\(\.\.\.reentrantLines\(inst,def,reentrantCornerCount\(d\)\)\);/, "the slab prices through the shared pricing");
    assert.match(est, /const wallOpenCorners = 4\*\(d\.openings\|\|\[\]\)\.reduce/, "a wall's corners default to 4 per opening");
    assert.match(est, /reentrantSection\(inst, wallOpenCorners, "openings give"\)/, "the wall renders the block");
    assert.match(est, /lines\.push\(\.\.\.reentrantLines\(inst,def,4\*\(d\.openings\|\|\[\]\)\.reduce/, "the wall prices it");
    assert.match(est, /reentrantSection\(inst, 0, ""\)/, "the composite renders the block (typed count)");
    assert.match(est, /lines\.push\(\.\.\.reentrantLines\(inst,def,0\)\);/, "the composite prices it");
    assert.match(est, /if\(lp\.kind==="bars"\)\{\n\s*\/\/ straight stock bars picked in the strip selector price as plain bar/, "a stock-bar choice in the strip selector is plain bar, never a trench product");
  }
  // An Additional row with a run and NO spacing: the run is the bar's length; a zero Total says why (Grady, 12 Nov 2026: "total didnt update realtime" — count 4, run 16 m, × 2 read 0)
  {
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    const grab = (name) => { const m = new RegExp("function " + name + "\\(r\\)\\{[\\s\\S]*?\\n\\}").exec(est); assert.ok(m, name + " in estimates-app.html"); return m[0]; };
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const dowelProduct = () => ({ kind: "bar" }); const DOWEL_PIECE_W_MM = 300;
    const fns = new Function("num", "dowelProduct", "DOWEL_PIECE_W_MM", ["addlRowSetOut", "addlRowCount", "addlRunAsLength", "addlRowHint", "addlMeshProduct", "addlRowEach", "addlRowQty"].map((n) => (n === "addlMeshProduct" ? "function addlMeshProduct(r){ return null; }" : grab(n))).join("\n") + "\nfunction addlRowMult(r){ const m=num(r && r.mult); return m>0? m : 1; }\nreturn {addlRowQty, addlRowHint, addlRunAsLength};")(num, dowelProduct, DOWEL_PIECE_W_MM);
    assert.equal(fns.addlRowQty({ count: 4, runM: 16, unit: "m", mult: 2 }), 128, "4 bars along a 16 m run, × 2 = 128 m");
    assert.equal(fns.addlRowQty({ runM: 7.5, unit: "m" }), 7.5, "a run alone is one bar of that length");
    assert.ok(Math.abs(fns.addlRowQty({ runM: 16, spacing: 300, lengthMm: 600, unit: "m" }) - 32.4) < 1e-9, "a run at a spacing still sets pieces out (54 × 0.6)");
    assert.ok(Math.abs(fns.addlRowQty({ runM: 16, spacing: 300, lengthMm: 1400, unit: "m", mult: 2 }) - 151.2) < 1e-9, "… × the multiplier");
    assert.ok(Math.abs(fns.addlRowQty({ count: 4, runM: 16, lengthMm: 600, unit: "m" }) - 2.4) < 1e-9, "a length each beats the run when there is no spacing");
    assert.equal(fns.addlRowQty({ runM: 16, spacing: 300, unit: "m" }), 0, "a set-out with no length each prices nothing");
    assert.equal(fns.addlRowQty({ count: 4, runM: 16, unit: "no." }), 4, "a no. row counts its pieces, the run is not a length there");
    assert.equal(fns.addlRowQty({ count: 4, runM: 16, qty: 3, unit: "m" }), 12, "a typed qty each beats the run");
    assert.match(fns.addlRowHint({ count: 4, unit: "m" }), /Len each \(mm\), or a Run \(m\) with no spacing/, "a zero says what is missing");
    assert.match(fns.addlRowHint({ spacing: 300, unit: "m" }), /needs a Run/, "a spacing with no run");
    assert.match(fns.addlRowHint({ count: 3, unit: "m²" }), /Area ea/, "an area row with only a count");
    assert.equal(fns.addlRowHint({ unit: "m" }), "", "a blank row has no hint"); assert.equal(fns.addlRowHint({ count: 4, runM: 16, unit: "m" }), "", "a row that prices has no hint");
    assert.match(est, /td\.textContent=fmt\(addlRowQty\(r\),2\)\+\(hint\? " ⓘ" : ""\); td\.title=hint; td\.classList\.toggle\("need",!!hint\);/, "the live refresh paints the hint with the figure");
    assert.match(est, /: addlRunAsLength\(r\) \? `\$\{cnt\}\$\{num\(r\.runM\)\} m run`/, "the register formula names the run");
    assert.match(est, /else if\(meshP\.kind==="trench" && addlRunAsLength\(r\)\)\{ const lm=n\*num\(r\.runM\)/, "a trench mesh row runs the length too");
  }
  // A precast panel forms ONE soffit and the perimeter of each panel; bulk excavation is a real dig in Estimates and lands on the Quotes Excavation / Soil removal rows (Grady, 12 Nov 2026)
  {
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    assert.match(est, /panelSoffit:true,/, "a panel's soffit is on by default");
    assert.match(est, /if\(d\.panelSoffit!==false && area>0\) lines\.push\(baseLine\(inst,def,\{materialGroup:"Formwork",material:"Soffit formwork",spec:"Precast panel soffit — casting bed \/ mould base, one face \(top face open\)",qty:area,unit:"m²"/, "the soffit is one face over the gross panel area, unset = on");
    assert.match(est, /\} else if\(d\.suspended && d\.soffit\) lines\.push\(/, "a suspended slab keeps its own soffit tick");
    assert.match(est, /\$\{d\.suspended && d\.category!=="Precast Panel"\? chk\("soffit",d\.soffit,"Soffit formwork"\):""\}/, "the slab's soffit tick is not shown on a panel");
    assert.match(est, /Panel formwork — one soffit and the perimeter of each panel/, "the Formwork section says what it forms");
    assert.match(est, /data-testid="panel-soffit-note"/, "the soffit figure is stated");
    // the dig
    assert.match(est, /const digApplies=\(def\)=>!!def && def\.kind==="excavation" && def\.id!=="backfill";/, "the dig options are on every excavation item but backfill");
    assert.match(est, /function digGeom\(d,def\)\{/, "digGeom is the ONE reading of the dig");
    assert.match(est, /n\*\(D\/3\)\*\(A1\+A2\+Math\.sqrt\(A1\*A2\)\)/, "a battered pit is a prismoid");
    assert.match(est, /digSpoilOn:kind==="excavation"/, "a new excavation item carts its spoil; an older one (unset) does not");
    assert.match(est, /const spoil = spoilOn\? \(vol-retain\)\*\(1\+bulk\/100\) : 0;/, "spoil = the dug volume less what is kept, bulked");
    assert.match(est, /material:"Rock excavation"/, "the rock share is its own line");
    assert.match(est, /material:"Spoil disposal \(loose, bulked\)",spec:`Bulking/, "the spoil line carries the name the bridge reads");
    assert.match(est, /\$\{excavationDigSection\(inst,def\)\}`;/, "the dig block is on the item's Geometry tab");
    assert.match(est, /else if\(digApplies\(def\) && dig\.planM2>0\) d\._autoAreaM2 = dig\.planM2;/, "an L × W dig publishes its plan area");
    // the bridge
    const L = (o) => estLine({ stage: "Earthworks", category: "Bulk Excavation", element: "Bulk Excavation 1", elementId: "BX1", materialGroup: "Excavation", unit: "m³", ...o });
    const { quote, flags } = buildImportFromEstimate({ project: { name: "Dig" }, lines: [
      L({ material: "Bulk Excavation", finalQty: 240 }),
      L({ material: "Rock excavation", finalQty: 60 }),
      L({ material: "Spoil disposal (loose, bulked)", finalQty: 345 }),
    ], elementGeometry: { BX1: { countNo: 1, areaM2: 200 } } });
    const it = quote.items[0];
    assert.equal(it.typeId, "excavation_bulk");
    assert.equal(it.qtys[rateKey("OTHER ALLOWANCES", "Excavation", "m3")], 300, "ordinary + rock land on the Excavation row");
    assert.equal(it.qtys[rateKey("OTHER ALLOWANCES", "Soil removal", "m3")], 345, "the bulked spoil lands on Soil removal");
    assert.ok(flags.some((f) => /60\.00 m³ of the dig is ROCK/.test(f)), "the rock share is named");
    assert.ok(!flags.some((f) => /Quotes has no catalog line/.test(f)), `nothing of the dig is left unmapped: ${flags.join(" | ")}`);
    const cost = computeElementCost(it, defaultRates());
    assert.equal(cost.categoryTotals["OTHER ALLOWANCES"], 345 * 40, "Excavation is a quantity only; the spoil prices at the Soil removal rate");
    { const lq = labourQuantities(it, defaultRates()); assert.equal(lq.excavationM3, 300, "the crew sheet's Excavation row takes the dug m³"); assert.equal(lq.soilRemovalM3, 345, "and its Remove soil row the spoil"); }
    // a footing's own trench dig and spoil cross the same way; a pier's bored spoil stays flagged
    const F = (o) => estLine({ stage: "Foundations", category: "Strip Footing", element: "SF1", elementId: "SF1", materialGroup: "Excavation", unit: "m³", ...o });
    const P = (o) => estLine({ stage: "Foundations", category: "Bored Pier", element: "BP1", elementId: "BP1", materialGroup: "Excavation", unit: "m³", ...o });
    const r2 = buildImportFromEstimate({ project: { name: "Dig 2" }, lines: [
      F({ material: "Trench excavation", finalQty: 12.5 }), F({ material: "Spoil disposal (loose, bulked)", finalQty: 14.38 }),
      P({ material: "Bored spoil", finalQty: 9 }),
    ] });
    const sf = r2.quote.items.find((i) => i.label === "SF1"), bp = r2.quote.items.find((i) => i.label === "BP1");
    assert.equal(sf.qtys[rateKey("OTHER ALLOWANCES", "Excavation", "m3")], 12.5);
    assert.equal(sf.qtys[rateKey("OTHER ALLOWANCES", "Soil removal", "m3")], 14.38);
    assert.equal(bp.qtys[rateKey("OTHER ALLOWANCES", "Excavation", "m3")], undefined, "a bored pier's spoil is the rig's — not put on the Excavation row");
    assert.ok(r2.flags.some((f) => /BP1.*Bored spoil/.test(f)), "and it stays flagged");
  }
  // ONE catalog fallback for every per-row rate read (12 Nov 2026, 41 Wildcoast Road: the R8 ligature stock bar priced as whole 6 m bars on the
  // card's row and as metres × $/bar in the element total, because computeElementCost's inline fallback left out barLength and the saved rates
  // row did not list the new product; and no fallback carried minQty, so a pump minimum was never billed on an install whose rates predate it)
  {
    const C = await import("../src/lib/costing.js");
    assert.deepEqual(C.catalogRate({ unitCost: 4.33, unitWeight: 2.37, sheetArea: undefined, barLength: 6, minQty: undefined }), { unitCost: 4.33, unitWeight: 2.37, sheetArea: undefined, barLength: 6, minQty: undefined });
    assert.deepEqual(C.catalogRate(null), { unitCost: 0 });
    const mk = () => newElementItem(ELEMENT_TYPES.find((t) => t.id === "strip_footings"));
    // a saved rates row that lists NONE of the products prices exactly as the catalog does — for every product with a bar length, a minimum or a sheet area
    let checked = 0;
    for (const cat of FULL_CATALOG) for (const p of cat.products) {
      if (!(p.barLength || p.minQty || p.sheetArea) || p.unit === "quote") continue;
      const typesFor = cat.visibleFor ? ELEMENT_TYPES.filter((t) => cat.visibleFor.includes(t.category)) : [ELEMENT_TYPES.find((t) => t.id === "strip_footings")];
      const it = newElementItem(typesFor[0]); it.qtys[rateKey(cat.key, p.name, p.unit)] = 1.5;
      const withDefaults = computeElementCost(it, defaultRates()).categoryTotals[cat.key], withNone = computeElementCost(it, {}).categoryTotals[cat.key];
      assert.ok(withDefaults > 0 || !(p.unitCost > 0), `${p.name} prices`);
      assert.equal(Math.round(withNone * 100), Math.round(withDefaults * 100), `${cat.key} › ${p.name}: a rates row that does not list the product prices as the catalog (bar length / minimum / sheet area kept)`);
      checked++;
    }
    assert.ok(checked >= 30, `the fallback is checked on every special product (${checked})`);
    // the case itself: 72.53 m of R8 ligatures = 13 whole bars × $4.33 = $56.29, never 72.53 × $4.33 = $314.05
    const sf = mk(); sf.qtys[rateKey("STOCK BAR", "R8 Ligatures - 6.0m length", "m")] = 72.53;
    assert.equal(Math.round(computeElementCost(sf, {}).categoryTotals["STOCK BAR"] * 100) / 100, 56.29);
    assert.ok(Math.abs(C.computeElementReinforcementTonnes(sf, {}) - 13 * 2.37 / 1000) < 1e-9, "…and it weighs 13 bars");
    // a pump's contract minimum bills on a rates row that never listed the pump: 1 hour typed = the 4 hour minimum
    const pump = FULL_CATALOG.find((c) => c.key === "CONCRETE PUMPING").products.find((p) => p.minQty === 4 && p.unitCost > 0);
    const pi2 = mk(); pi2.qtys[rateKey("CONCRETE PUMPING", pump.name, pump.unit)] = 1;
    assert.equal(computeElementCost(pi2, {}).categoryTotals["CONCRETE PUMPING"], 4 * pump.unitCost, "1 hr on a 4 hr-min pump bills 4 hours");
    // no call site spells the fallback inline any more
    for (const f of ["../src/lib/costing.js", "../src/lib/exportQuote.js", "../src/components/CategoryBlock.jsx", "../src/components/PrintQuoteReport.jsx", "../src/components/AdditionalItems.jsx"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      const inline = (src.match(/unitWeight: p\.unitWeight/g) || []).length;
      assert.equal(inline, f.endsWith("costing.js") ? 1 : 0, `${f}: the catalog fallback is catalogRate(p), spelled once`);
      assert.ok(/catalogRate\(p\)/.test(src), `${f} reads the fallback through catalogRate`);
    }
  }
  // The AI Engine page's AI_TYPES mirror must list exactly the Estimates LIBRARY ids
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const libBlock = est.slice(est.indexOf("const LIBRARY = ["), est.indexOf("];", est.indexOf("const LIBRARY = [")));
  const libIds = [...libBlock.matchAll(/\{id:"([a-z0-9]+)", label:"([^"]+)", calc:"([a-z]+)"/g)].map((m) => m[1]);
  const ai = fs.readFileSync(new URL("../portal/ai-engine.html", import.meta.url), "utf8");
  const aiBlock = ai.slice(ai.indexOf("const AI_TYPES = ["), ai.indexOf("];", ai.indexOf("const AI_TYPES = [")));
  const aiIds = [...aiBlock.matchAll(/\{id:"([a-z0-9]+)", label:"([^"]+)", calc:"([a-z]+)"/g)].map((m) => m[1]);
  check("AI Engine: AI_TYPES in ai-engine.html mirrors every Estimates LIBRARY id (same ids, same order)", () => assertTrue(libIds.length > 40 && JSON.stringify(libIds) === JSON.stringify(aiIds), `library ${libIds.length} vs mirror ${aiIds.length}: ${libIds.filter((i) => !aiIds.includes(i)).concat(aiIds.filter((i) => !libIds.includes(i))).join(",")}`));
  check("AI Engine: Estimates maps the hand-off (applyAiHandoff → aiProposalToInstance) and tags the takeoff into the AI drafts group", () => assertTrue(/function applyAiHandoff\(/.test(est) && /function aiProposalToInstance\(/.test(est) && /tagTakeoffGroup\(CURRENT_PROJECT_KEY, "ai"\)/.test(est) && /AI draft — verify/.test(est)));
  check("Google mail: the Settings panel explains a preview-deployment address (credentials are Production-scoped) and names the MAIN host as the redirect URI, never the page's own address", () => { const sh = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8"); assertTrue(/Not available at this address/.test(sh) && /tick "Preview" on GOOGLE_CLIENT_ID/.test(sh) && /canonical \+ '\/api\/google-auth/.test(sh) && !/escapeHtml\(location\.origin\) \+ '\/api\/google-auth/.test(sh)); });
  check("AI Engine: the portal shell carries the tile, the menu entry, the payload slot and the chat panel", () => { const sh = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8"); assertTrue(/data-target="aiengine"/.test(sh) && /data-menu="aiengine"/.test(sh) && /__AIENGINE_B64__/.test(sh) && /id="ai-chat-fab"/.test(sh) && /function assistantContext\(/.test(sh)); });
  // Chat
  const pr = C.parseReply("Two due.\nACTIONS: [{\"app\":\"quotes\",\"id\":\"p1\",\"label\":\"Open it\"},{\"app\":\"estimates\",\"id\":null,\"label\":\"Estimates\"},{\"app\":\"x\"},{\"app\":\"y\"}]");
  check("AI chat: parseReply strips the ACTIONS line into at most three typed buttons and leaves the prose", () => assertTrue(pr.reply === "Two due." && pr.actions.length === 3 && pr.actions[0].app === "quotes" && pr.actions[0].id === "p1" && pr.actions[1].id === null));
  check("AI chat: a reply without an ACTIONS line has no actions and the text is untouched", () => assertTrue(C.parseReply("Just text.\nMore.").reply === "Just text.\nMore." && C.parseReply("x").actions.length === 0));
  const sys = C.chatSystem({ today: "2026-10-10", quotes: [{ id: "p1", name: "Spindrift" }] });
  check("AI chat: the system prompt embeds the portal data, forbids acting alone and defines the ACTIONS line", () => assertTrue(/Spindrift/.test(sys) && /NEVER act on your own/.test(sys) && /ACTIONS: \[/.test(sys)));
  const c400 = await C.runChat({ messages: [] }, {}); const c503 = await C.runChat({ messages: [{ role: "user", content: "hi" }] }, {}); const c413 = await C.runChat({ messages: [{ role: "user", content: "hi" }], context: { big: "x".repeat(100000) } }, { ANTHROPIC_API_KEY: "k" });
  check("AI chat: no messages → 400, no provider → 503, oversized context → 413, none of them calling a model", () => assertTrue(c400.status === 400 && c503.status === 503 && c413.status === 413));
  let cthrew = null; try { await P.callChat("openai", { messages: [{ role: "assistant", content: "x" }], env: { OPENAI_API_KEY: "k" } }); } catch (e) { cthrew = e; }
  check("AI chat: a conversation that does not end with the user is refused (400) before any request", () => assertTrue(cthrew && cthrew.status === 400));
}

// ---------------------------------------------------------------------------
// Quality checks (src/lib/qualityChecks.js), the qa explain action, Google mail (api/_google.js, api/gmail.js), mail in the chat
// ---------------------------------------------------------------------------
{
  const Q = await import("../src/lib/qualityChecks.js");
  const E = await import("../api/ai-engine.js");
  const G = await import("../api/_google.js");
  const GM = await import("../api/gmail.js");
  const C = await import("../api/ai-chat.js");
  const rates = defaultRates();
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const concCat = FULL_CATALOG.find((c) => c.key === "CONCRETE"); const concP = concCat.products.find((p) => p.unit === "m3");
  const subCat = FULL_CATALOG.find((c) => /SUB CONTRACTORS/.test(c.key)); const subQ = subCat.products.find((p) => p.unit === "quote");
  const barCat = FULL_CATALOG.find((c) => c.key === "PROCESSED BAR"); const bar = barCat.products[0];
  const mk = (label, qtys, extra) => { const it = newElementItem(strip); it.label = label; Object.assign(it.qtys, qtys); return Object.assign(it, extra || {}); };
  const concKey = rateKey("CONCRETE", concP.name, concP.unit), subKey = rateKey(subCat.key, subQ.name, subQ.unit), barKey = rateKey("PROCESSED BAR", bar.name, bar.unit);
  const okItem = mk("Strip OK", { [concKey]: 12, [barKey]: 60 }, { measureLm: 40 }); // 60 m of bar ≈ 1.2 t? depends on unitWeight; the band check uses the real tonnes
  const unpriced = mk("Piling", { [subKey]: 1 });
  const bare = mk("Bare slab", { [concKey]: 10 });
  const dup = mk("Bare slab", { [concKey]: 10 });
  const empty = mk("Nothing here", {});
  const thin = mk("Thin", { [concKey]: 1 }, { measureM2: 100 });
  const quote = { projectName: "QA probe", clientName: "", gfa: 200, scope: "both", status: "Completed Estimating", items: [okItem, unpriced, bare, dup, empty, thin], planner: {} };
  const r = Q.runQualityChecks(quote, rates, { today: "2026-10-10", benchmarks: [{ name: "A", perM2: 900 }, { name: "B", perM2: 1100 }, { name: "C", perM2: 1000 }] });
  const checks = (name) => r.findings.filter((f) => f.check === name);
  check("Quality: a subcontract quote row with a quantity and no amount is a HIGH finding naming the element", () => assertTrue(checks("unpriced-quote").length === 1 && checks("unpriced-quote")[0].severity === "high" && checks("unpriced-quote")[0].element === "Piling"));
  check("Quality: concrete with no reinforcement is flagged (medium), once per such element", () => assertTrue(checks("no-steel").length === 2 && checks("no-steel").every((f) => f.severity === "medium") && checks("no-steel").some((f) => f.element === "Bare slab")));
  check("Quality: an identical second element is a duplicate finding on the SECOND one only", () => assertTrue(checks("duplicate-element").length === 1 && checks("duplicate-element")[0].itemId === dup.id && /Same type and name/.test(checks("duplicate-element")[0].message)));
  check("Quality: an element with no quantities and no cost is a low 'empty' finding", () => assertTrue(checks("empty-element").length === 1 && checks("empty-element")[0].element === "Nothing here"));
  check("Quality: concrete over the recorded area outside the thickness band is flagged with the implied mm", () => assertTrue(checks("concrete-vs-measure").some((f) => f.element === "Thin" && /10 mm thick/.test(f.message))));
  check("Quality: no client and no deadline are low project-field findings; $/m² far off the submitted median is a benchmark finding with the median", () => assertTrue(checks("project-fields").length === 2 && checks("sqm-benchmark").length === 1 && /median of \$1,000\/m²/.test(checks("sqm-benchmark")[0].message)));
  check("Quality: findings sort high → medium → low and the counts agree; the summary carries total, $/m², elements and the median", () => { const sev = r.findings.map((f) => f.severity); const order = { high: 0, medium: 1, low: 2 }; assertTrue(sev.every((x, i) => i === 0 || order[sev[i - 1]] <= order[x]) && r.counts.high + r.counts.medium + r.counts.low === r.findings.length && r.summary.elements === 6 && r.summary.benchmarkMedianPerM2 === 1000 && r.summary.perM2 > 0); });
  // rates: expired, pinned drift with the cost
  const exp = JSON.parse(JSON.stringify(rates)); const levyKey = Object.keys(exp).find((k) => /environment levy/i.test(k)); exp[levyKey].validUntil = "2026-10-01";
  const pinned = { ...quote, items: [okItem], ratesFrozen: { at: "2026-10-01T00:00:00Z", status: "Completed Estimating", rates: JSON.parse(JSON.stringify(rates)) } };
  const live = JSON.parse(JSON.stringify(exp)); live[concKey].unitCost = Number(rates[concKey].unitCost) + 50;
  const r2 = Q.runQualityChecks(pinned, live, { today: "2026-10-10" });
  check("Quality: a rate past its validity is reported (low when the project does not use it) and a pinned rate that moved shows the $ impact at the project's quantities", () => assertTrue(r2.findings.some((f) => f.check === "rate-expired") && r2.findings.some((f) => f.check === "rate-drift" && /\+\$600/.test(f.message))));
  check("Quality: benchmarksFrom costs only submitted projects with a GFA and items, as $/m²", () => { const b = Q.benchmarksFrom([{ status: "Submitted", gfa: 100, items: [okItem] }, { status: "Estimating", gfa: 100, items: [okItem] }, { status: "Successful", gfa: 0, items: [okItem] }], rates); assertTrue(b.length === 1 && b[0].perM2 > 0 && Q.median([3, 1, 2]) === 2 && Q.median([]) === null); });
  await checkAsync("Quality: the AI explain action needs findings (400) and a provider (503); the prompt forbids inventing figures", async () => assertTrue((await E.runAiJob({ action: "qa" }, {})).status === 400 && (await E.runAiJob({ action: "qa", findings: [] }, {})).status === 503 && /Never invent a figure/.test(E.qaPrompt({ project: { name: "P" }, findings: [] }))));
  // Google mail
  const genv = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" };
  check("Google: the refresh token round-trips through AES-GCM under the client secret and a tampered blob is refused", () => { const enc = G.encryptText("1//refresh", genv); let bad = false; const ti = enc.length - 6; const tampered = enc.slice(0, ti) + (enc[ti] === "A" ? "B" : "A") + enc.slice(ti + 1); /* a character INSIDE the blob: the last two can be base64 padding bits the decoder ignores, which failed this check at random */ try { G.decryptText(tampered, genv); } catch { bad = true; } assertTrue(G.decryptText(enc, genv) === "1//refresh" && /^v1\./.test(enc) && !enc.includes("refresh") && bad); });
  check("Google: the OAuth state is signed and expires after ten minutes; the consent URL asks for gmail.readonly offline with the mailbox as login hint", () => { const st = G.signState(genv, 1000); const u = G.consentUrl("https://h/api/google-auth", genv, 1000); assertTrue(G.verifyState(st, genv, 5000) && !G.verifyState(st, genv, 1000 + 11 * 60000) && !G.verifyState("a.b", genv) && /gmail\.readonly/.test(u) && /access_type=offline/.test(u) && /login_hint=projects%40gradcon\.com\.au/.test(u) && /prompt=consent/.test(u)); });
  check("Google: the redirect URI is the registered production one whatever alias the portal was opened on (a preview host caused redirect_uri_mismatch, 11 Oct 2026); localhost keeps itself; the env override wins", () => assertTrue(G.redirectUri({ headers: { host: "estimating-website-git-main-gradcon.vercel.app" } }, genv) === "https://estimating-website.vercel.app/api/google-auth" && G.redirectUri({ headers: { host: "estimating-website.vercel.app" } }, genv) === "https://estimating-website.vercel.app/api/google-auth" && G.redirectUri({ headers: { host: "localhost:3000" } }, genv) === "http://localhost:3000/api/google-auth" && G.redirectUri({ headers: { host: "x" } }, { ...genv, GOOGLE_OAUTH_REDIRECT: "https://other/api/google-auth" }) === "https://other/api/google-auth"));
  check("Google: connectionStatus never carries a token; the allowed mailbox defaults to projects@gradcon.com.au", () => { const st = G.connectionStatus({ email: "projects@gradcon.com.au", refresh: "v1.x.y.z", connectedAt: "2026-10-10" }, genv); assertTrue(st.connected && st.email === "projects@gradcon.com.au" && !JSON.stringify(st).includes("v1.x") && G.allowedMailbox({}) === "projects@gradcon.com.au" && G.allowedMailbox({ GOOGLE_ALLOWED_MAILBOX: "Grady@Gradcon.com.au" }) === "grady@gradcon.com.au"); });
  const gmsg = { id: "m1", threadId: "t1", internalDate: "1760000000000", snippet: "Tender invitation", labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: "Bob <bob@x.com>" }, { name: "Subject", value: "Tender — 12 Beach Rd" }], parts: [{ mimeType: "text/html", body: { data: Buffer.from("<p>Hello <b>Grady</b></p><style>x{}</style>").toString("base64url") } }, { mimeType: "application/pdf", filename: "S-01.pdf", body: { attachmentId: "a1", size: 10 } }, { mimeType: "application/vnd.ms-excel", filename: "boq.xlsx", body: { attachmentId: "a2", size: 5 } }] } };
  const pm = G.parseMessage(gmsg);
  check("Google: parseMessage reads headers, the HTML body as text, unread, and the attachments with a PDF flag", () => assertTrue(pm.from === "Bob <bob@x.com>" && pm.subject === "Tender — 12 Beach Rd" && pm.body === "Hello Grady" && pm.unread && pm.attachments.length === 2 && pm.attachments[0].isPdf && !pm.attachments[1].isPdf && pm.hasAttachments && /^2025-10-09/.test(pm.date)));
  await checkAsync("Gmail function: unconfigured → 503; configured with no stored connection → 409 asking to connect; never a network call to Google", async () => { const fetchNone = async () => ({ ok: true, json: async () => [] }); assertTrue((await GM.runGmail({ action: "list" }, {}, fetchNone)).status === 503 && (await GM.runGmail({ action: "list" }, genv, fetchNone)).status === 409); });
  await checkAsync("Gmail function: with a connection, list/read/attachment go through Gmail and an attachment lands in the bucket as a public PDF URL", async () => {
    const stored = { email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv) };
    const calls = [];
    const fetchMock = async (url, init) => { calls.push(String(url)); const u = String(url);
      if (/estimator_kv\?key=eq\./.test(u)) return { ok: true, json: async () => [{ value: stored }] };
      if (/oauth2\.googleapis\.com\/token/.test(u)) return { ok: true, json: async () => ({ access_token: "at", expires_in: 3600 }) };
      if (/\/messages\?/.test(u)) return { ok: true, json: async () => ({ messages: [{ id: "m1" }], resultSizeEstimate: 1 }) };
      if (/\/messages\/m1\/attachments\/a1/.test(u)) return { ok: true, json: async () => ({ data: Buffer.from("%PDF-1.4 x").toString("base64url") }) };
      if (/\/messages\/m1/.test(u)) return { ok: true, json: async () => gmsg };
      if (/storage\/v1\/object\//.test(u)) return { ok: true, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) }; };
    G.resetTokenCache();
    const l = await GM.runGmail({ action: "list", q: "tender" }, genv, fetchMock);
    const rd = await GM.runGmail({ action: "read", id: "m1" }, genv, fetchMock);
    const at = await GM.runGmail({ action: "attachment", id: "m1", attachmentId: "a1", filename: "S-01.pdf" }, genv, fetchMock);
    const notPdf = await GM.runGmail({ action: "attachment", id: "m1", attachmentId: "a2", filename: "boq.xlsx" }, genv, fetchMock);
    G.resetTokenCache();
    assertTrue(l.status === 200 && l.body.messages.length === 1 && l.body.messages[0].subject === "Tender — 12 Beach Rd" && !("body" in l.body.messages[0]) && calls.some((c) => /q=tender/.test(c))
      && rd.status === 200 && rd.body.message.body === "Hello Grady"
      && at.status === 200 && /ai-engine\/mail\/m1\/S-01\.pdf$/.test(at.body.file.url) && at.body.file.size === 10 && calls.some((c) => /storage\/v1\/object\/gradcon-files\/ai-engine\/mail\/m1\/S-01\.pdf/.test(c))
      && notPdf.status === 400 && calls.filter((c) => /oauth2\.googleapis\.com\/token/.test(c)).length === 1);
  });

  // ---- the tender inbox scan (src/lib/tenderInbox.js + api/tender-inbox.js; Grady, 28 Oct 2026)
  {
    const T = await import("../src/lib/tenderInbox.js");
    const TI = await import("../api/tender-inbox.js");
    const now = new Date("2026-10-28T03:00:00Z");
    const rfq = { id: "m1", threadId: "t1", from: "Fred Nguyen <fred@buildco.com.au>", subject: "Request for Quote – 12 Beach Road, Rye – Concrete works", date: "2026-10-27T22:10:00Z", body: "Please find attached the tender documents for 12 Beach Road, Rye VIC 3941. Quotes are due by COB Friday 14 November 2026.", attachments: [{ attachmentId: "a1", filename: "S-01 Structural.pdf", mimeType: "application/pdf", size: 1200 }, { attachmentId: "a2", filename: "A101 Floor plan.dwg", size: 500 }, { attachmentId: "a3", filename: "logo.gif", size: 10 }] };
    const fwd = { id: "m2", threadId: "t2", from: "Grady <grady@gradcon.com.au>", subject: "Fwd: Invitation to tender - Myer Shed, Dandenong", date: "2026-10-27T01:00:00Z", body: "FYI\n\n---------- Forwarded message ---------\nFrom: Sam Lee <sam@hansenyuncken.com.au>\nDate: Mon, 27 Oct 2026\nSubject: Invitation to tender - Myer Shed, Dandenong\nTo: grady@gradcon.com.au\n\nGradcon is invited to tender for the concrete package at 45 Frankston Dandenong Road, Dandenong South. Tender closes 2pm 10/11/2026.", attachments: [] };
    const ownRfq = { id: "m3", threadId: "t3", from: "projects@gradcon.com.au", subject: "RFQ – Screw Piling – 19 Paringa Road, Portsea VIC 3944", date: "2026-10-27T01:00:00Z", body: "Dear Trevor, Gradcon invites DMAC to quote", attachments: [] };
    const reply = { id: "m4", threadId: "t4", from: "Trevor <trevor@dmacpiling.com.au>", subject: "Re: RFQ – Screw Piling – 19 Paringa Road", date: "2026-10-27T01:00:00Z", body: "Please find our quote attached", attachments: [{ attachmentId: "q", filename: "Quote.pdf" }] };
    const news = { id: "m5", threadId: "t5", from: "news@holcim.com.au", subject: "October newsletter: new quote tool", date: "2026-10-27T01:00:00Z", body: "Unsubscribe here. Request a quote online today!", attachments: [] };
    const plain = { id: "m6", threadId: "t6", from: "Jo <jo@archfirm.com>", subject: "Pricing please - new carport slab", date: "2026-10-27T01:00:00Z", body: "Could you provide a quote for a 100mm slab at 7 Ocean St, Sorrento. No rush.", attachments: [] };
    const invoice = { id: "m7", threadId: "t7", from: "accounts@supplier.com.au", subject: "Tax invoice 4471 — quote 88 accepted", date: "2026-10-27T01:00:00Z", body: "Please find attached your tax invoice for the quote accepted last week.", attachments: [{ attachmentId: "i", filename: "invoice.pdf" }] };
    check("Tender inbox: a request for quote with drawings, a forwarded invitation and a plain 'could you provide a quote' are candidates; Gradcon's own RFQ, a contractor's reply to it, a newsletter and an invoice are not", () => {
      assertTrue(T.classifyMessage(rfq).candidate && T.classifyMessage(fwd).candidate && T.classifyMessage(plain).candidate);
      assertTrue(T.classifyMessage(ownRfq).excluded === "Gradcon's own message" && T.classifyMessage(reply).excluded === "a reply to Gradcon's own RFQ" && !T.classifyMessage(news).candidate && !T.classifyMessage(invoice).candidate);
    });
    const c1 = T.candidateFromMessage(rfq, { now }), c2 = T.candidateFromMessage(fwd, { now }), c6 = T.candidateFromMessage(plain, { now });
    check("Tender inbox: the project is named by the site address (the body's fuller form), the client is the sender's organisation, the closing date is read from 'due by COB Friday 14 November 2026', only drawing / document attachments are kept", () =>
      assertTrue(c1.projectName === "12 Beach Road, Rye VIC 3941 — Concrete works" && c1.client === "Buildco" && c1.deadline === "2026-11-14" && c1.deadlineSource === "email" && /due by COB/.test(c1.deadlineText) && c1.attachments.length === 2 && c1.attachments[1].kind === "cad" && c1.siteAddress === "12 Beach Road, Rye VIC 3941"));
    check("Tender inbox: a tender forwarded from grady@ reads the ORIGINAL sender as the client (via grady@), its address from the forwarded body and 'closes 2pm 10/11/2026' as the deadline", () =>
      assertTrue(c2.from === "Sam Lee <sam@hansenyuncken.com.au>" && c2.via === "grady@gradcon.com.au" && c2.forwarded && c2.client === "Hansenyuncken" && /^45 Frankston Dandenong Road, Dandenong South/.test(c2.projectName) && c2.deadline === "2026-11-10"));
    check("Tender inbox: no closing date in the email → 14 days from receipt, marked default; 'by 3/11' and 'within 2 weeks' near a due word are read; a stale date is ignored", () => {
      assertTrue(c6.deadline === "2026-11-10" && c6.deadlineSource === "default");
      assertTrue(T.extractDeadline("send your price through by 3/11 please", "2026-10-28").date === "2026-11-03");
      assertTrue(T.extractDeadline("quotes to be submitted within 2 weeks", "2026-10-28").date === "2026-11-11" && T.extractDeadline("quotes to be submitted within 2 weeks", "2026-10-28").source === "email");
      assertTrue(T.extractDeadline("Tender closes at 2:00pm on Thursday 6th November", "2026-10-28").date === "2026-11-06");
      assertTrue(T.extractDeadline("ref 01/02/2020 — tender closes 01/02/2020", "2026-10-28").source === "default");
    });
    check("Tender inbox: the duplicate test catches the same thread, the same street address in another spelling and the same name — and nothing else", () => {
      assertTrue(T.findDuplicate(c1, [{ name: "12 Beach Rd, Rye — carport", source: null }]).why === "a project at the same address exists");
      assertTrue(T.findDuplicate(c1, [{ name: "Other", source: { kind: "mail", threadId: "t1" } }]).why === "the same email thread already made this project");
      assertTrue(T.findDuplicate({ projectName: "Myer Shed - Dandenong", siteAddress: "", messageId: "x", threadId: "y" }, [{ name: "Myer shed Dandenong", source: null }]).why === "a project with the same name exists");
      assertTrue(T.findDuplicate(c1, [{ name: "12 Beach Road, Mentone VIC 3194", source: null }]) === null && T.findDuplicate(c1, [{ name: "14 Beach Road, Rye", source: null }]) === null);
    });
    check("Tender inbox: the quote a candidate becomes is Queued, dated today, deadline on the planner, source on the quote (message, thread, sender, how the deadline was set) and the copied files under provider 'mail'", () => {
      const q = T.tenderQuoteFrom(c1, { today: "2026-10-28", files: [{ name: "S-01 Structural.pdf", kind: "pdf", mimeType: "application/pdf", size: 1200, url: "https://x/quote-files/p1/S-01_Structural.pdf", path: "quote-files/p1/S-01_Structural.pdf", attachmentId: "a1" }] });
      assertTrue(q.status === "Queued" && q.projectDate === "2026-10-28" && q.planner.deadline === "2026-11-14" && q.items.length === 0 && q.clientName === "Buildco" && q.source.kind === "mail" && q.source.messageId === "m1" && q.source.threadId === "t1" && q.source.deadlineSource === "email" && q.files.length === 1 && q.files[0].provider === "mail" && T.mailFiles(q).length === 1 && q.siteAddress === "12 Beach Road, Rye VIC 3941");
    });
    check("Tender inbox: the scan record — the first query looks back 14 days, a later one from the watermark less an hour; applyScan keeps handled messages, the created list and the watermark; wasHandled covers a created thread; newSince filters by the dismissal stamp", () => {
      assertTrue(/^after:\d+ -in:spam -in:trash -in:sent -in:drafts/.test(T.scanQuery(T.emptyRecord(), now)) && Number(T.scanQuery(T.emptyRecord(), now).split(" ")[0].slice(6)) === Math.floor((now.getTime() - 14 * 86400000) / 1000));
      const r1 = T.applyScan(T.emptyRecord(), { at: "2026-10-28T03:00:00Z", seenMaxMs: Date.parse("2026-10-27T22:10:00Z"), created: [{ projectId: "p1", name: "A", messageId: "m1", threadId: "t1" }], handled: [{ messageId: "m1", threadId: "t1", outcome: "created", projectId: "p1" }, { messageId: "m5", outcome: "skipped", reason: "newsletter" }], summary: { scanned: 5, created: 1 } });
      assertTrue(r1.watermarkMs === Date.parse("2026-10-27T22:10:00Z") && r1.created.length === 1 && r1.created[0].at === "2026-10-28T03:00:00Z" && r1.handled.m1.outcome === "created" && r1.lastResult.scanned === 5);
      assertTrue(Number(T.scanQuery(r1, now).split(" ")[0].slice(6)) === Math.floor((r1.watermarkMs - 3600000) / 1000));
      assertTrue(T.wasHandled(r1, { id: "m1" }) && T.wasHandled(r1, { id: "m9", threadId: "t1" }) && !T.wasHandled(r1, { id: "m9", threadId: "t9" }));
      assertTrue(T.newSince(r1, "2026-10-28T02:00:00Z").length === 1 && T.newSince(r1, "2026-10-28T04:00:00Z").length === 0 && T.newSince(r1, "").length === 1);
    });
    check("Tender inbox: the AI review prompt forbids inventing an address or a date; parseTenderReview keeps known ids and valid dates only; applyReview drops a confident 'not a tender', refines a client and fills a default deadline, never overrides a stated one", () => {
      const prompt = T.tenderReviewPrompt([c1, c6], { today: "2026-10-28" });
      assertTrue(/Never invent an address/.test(prompt) && /"id":"m1"/.test(prompt.replace(/\s+/g, "")));
      const rv = T.parseTenderReview('```json\n{"reviews":[{"id":"m1","tender":true,"confidence":"high","projectName":"12 Beach Road, Rye VIC 3941","client":"BuildCo Pty Ltd","deadline":"2026-11-20"},{"id":"m6","tender":true,"confidence":"medium","client":"Arch Firm","deadline":"2026-11-05"},{"id":"zz","tender":false},{"id":"m9","tender":false,"deadline":"next week"}]}\n```', [c1, c6]);
      assertTrue(Object.keys(rv).length === 2 && rv.m1.client === "BuildCo Pty Ltd" && rv.m6.deadline === "2026-11-05");
      const a1 = T.applyReview(c1, rv.m1); const a6 = T.applyReview(c6, rv.m6);
      assertTrue(!a1.drop && a1.cand.deadline === "2026-11-14" && a1.cand.client === "BuildCo Pty Ltd" && !a6.drop && a6.cand.deadline === "2026-11-05" && a6.cand.deadlineSource === "ai" && a6.cand.client === "Arch Firm");
      assertTrue(T.applyReview(c6, { tender: false, confidence: "high", reason: "a supplier" }).drop && !T.applyReview(c6, { tender: false, confidence: "low" }).drop);
    });
    await checkAsync("Tender inbox function: a scan lists the mailbox since the watermark, reads the likely messages in full, creates ONE Queued project per request (row written, index appended with a conditional update, the PDF and DWG copied under quote-files/<id>/), skips Gradcon's own RFQ, the reply, the newsletter and a duplicate of an existing project, records every outcome — and a second scan creates nothing", async () => {
      const stored = { email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv) };
      const gm = (m) => ({ id: m.id, threadId: m.threadId, internalDate: String(Date.parse(m.date)), snippet: m.body.slice(0, 80), labelIds: [], payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: m.date }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from(m.body).toString("base64url") } }, ...m.attachments.map((a) => ({ mimeType: a.mimeType || "application/octet-stream", filename: a.filename, body: { attachmentId: a.attachmentId, size: a.size || 10 } }))] } });
      const mail = { m1: gm(rfq), m2: gm(fwd), m3: gm(ownRfq), m4: gm(reply), m5: gm(news), m6: gm(plain), m8: gm({ id: "m8", threadId: "t8", from: "Kim <kim@builder.com.au>", subject: "RFT – 19 Paringa Road, Portsea – tennis pavilion", date: "2026-10-27T05:00:00Z", body: "Request for tender attached, closing 12 November 2026.", attachments: [] }) };
      const kv = { "gradcon-google-mail": { value: stored, updated_at: "2026-10-01T00:00:00Z" }, "gradcon-projects": { value: [{ id: "old1", storageKey: "gradcon-quote-old1", createdAt: "2026-10-01T00:00:00Z" }], updated_at: "2026-10-20T00:00:00Z" }, "gradcon-quote-old1": { value: { projectName: "19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion", clientName: "X", status: "Estimating" }, updated_at: "2026-10-20T00:00:00Z" } };
      const calls = [];
      const fetchMock = async (url, init = {}) => { const u = String(url); const method = (init.method || "GET").toUpperCase(); calls.push(`${method} ${u}`);
        if (/oauth2\.googleapis\.com\/token/.test(u)) return { ok: true, json: async () => ({ access_token: "at", expires_in: 3600 }) };
        if (/estimator_kv\?key=like\.gradcon-quote-/.test(u)) return { ok: true, json: async () => Object.keys(kv).filter((k) => /^gradcon-quote-/.test(k)).map((k) => ({ key: k, updated_at: kv[k].updated_at, name: kv[k].value.projectName, client: kv[k].value.clientName, status: kv[k].value.status, source: kv[k].value.source || null })) };
        let m = /estimator_kv\?key=eq\.([^&]+)(?:&updated_at=eq\.([^&]+))?/.exec(u);
        if (m && method === "GET") { const k = decodeURIComponent(m[1]); return { ok: true, json: async () => (kv[k] ? [kv[k]] : []) }; }
        if (m && method === "PATCH") { const k = decodeURIComponent(m[1]); const stamp = decodeURIComponent(m[2] || ""); if (!kv[k] || kv[k].updated_at !== stamp) return { ok: true, json: async () => [] }; const b = JSON.parse(init.body); kv[k] = { value: b.value, updated_at: b.updated_at }; return { ok: true, json: async () => [{ key: k }] }; }
        if (/\/rest\/v1\/estimator_kv$/.test(u) && method === "POST") { const b = JSON.parse(init.body); kv[b.key] = { value: b.value, updated_at: b.updated_at }; return { ok: true, json: async () => ({}) }; }
        if (/\/messages\?/.test(u)) { const q = decodeURIComponent(u.split("q=")[1] || ""); return { ok: true, json: async () => ({ messages: /after:/.test(q) ? Object.keys(mail).map((id) => ({ id })) : [] }) }; }
        m = /\/messages\/([^/?]+)\/attachments\/([^/?]+)/.exec(u); if (m) return { ok: true, json: async () => ({ data: Buffer.from(`%PDF-${m[2]}`).toString("base64url") }) };
        m = /\/messages\/([^/?]+)\?format=(metadata|full)/.exec(u); if (m) { const msg = mail[m[1]]; if (!msg) return { ok: false, status: 404, json: async () => ({}) }; if (m[2] === "metadata") { const { payload, ...rest } = msg; return { ok: true, json: async () => ({ ...rest, payload: { headers: payload.headers } }) }; } return { ok: true, json: async () => msg }; }
        if (/storage\/v1\/object\/gradcon-files\//.test(u) && method === "POST") return { ok: true, json: async () => ({}) };
        return { ok: false, status: 404, json: async () => ({}) }; };
      G.resetTokenCache();
      const first = await TI.runTenderInbox({ action: "scan", by: "test" }, genv, fetchMock, { now: () => now, review: null });
      assertTrue(first.status === 200, `status ${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
      const names = first.body.created.map((c) => c.name).sort();
      assertTrue(first.body.created.length === 3, `created ${JSON.stringify(names)}; errors ${JSON.stringify(first.body.errors)}`);
      assertTrue(names[0] === "12 Beach Road, Rye VIC 3941 — Concrete works" && /^45 Frankston Dandenong Road/.test(names[1]) && /^7 Ocean St, Sorrento/.test(names[2]));
      const idx = kv["gradcon-projects"].value; assertTrue(idx.length === 4 && idx[0].id === "old1" && idx.slice(1).every((e) => /^gradcon-quote-/.test(e.storageKey)), "the index keeps the old entry and gains three");
      const beach = kv[first.body.created[0].storageKey].value;
      assertTrue(beach.status === "Queued" && beach.planner.deadline === "2026-11-14" && beach.source.messageId === "m1" && beach.files.length === 2 && beach.files.every((f) => f.provider === "mail" && new RegExp(`quote-files/${first.body.created[0].projectId}/`).test(f.url)) && beach.files[0].size === 7, JSON.stringify(beach.files));
      assertTrue(calls.some((c) => /POST .*storage\/v1\/object\/gradcon-files\/quote-files\/[^/]+\/S-01_Structural\.pdf/.test(c)) && calls.some((c) => /A101_Floor_plan\.dwg/.test(c)) && !calls.some((c) => /logo\.gif/.test(c)), "the PDF and DWG are copied, the gif is not");
      assertTrue(calls.some((c) => /PATCH .*key=eq\.gradcon-projects&updated_at=eq\./.test(c)), "the index is appended with a conditional PATCH");
      const rec = kv["gradcon-tender-inbox"].value;
      assertTrue(rec.handled.m3.outcome === "skipped" && rec.handled.m4.outcome === "skipped" && rec.handled.m8.outcome === "duplicate" && /same address/.test(rec.handled.m8.reason) && rec.handled.m1.outcome === "created" && rec.created.length === 3 && rec.watermarkMs === Date.parse("2026-10-27T22:10:00Z") && rec.lastResult.created === 3, JSON.stringify(rec.handled));
      assertTrue(!rec.handled.m5 || rec.handled.m5.outcome === "skipped", "the newsletter never becomes a project");
      const nCalls = calls.length;
      const second = await TI.runTenderInbox({ action: "scan", by: "test" }, genv, fetchMock, { now: () => new Date("2026-10-29T03:00:00Z"), review: null });
      assertTrue(second.status === 200 && second.body.created.length === 0 && kv["gradcon-projects"].value.length === 4 && !calls.slice(nCalls).some((c) => /format=full/.test(c)), `a second scan reads nothing twice and creates nothing: ${JSON.stringify({ created: second.body.created.length, full: calls.slice(nCalls).filter((c) => /format=full/.test(c)), handled: Object.keys(rec.handled) })}`);
      assertTrue(/after:/.test(decodeURIComponent(calls.slice(nCalls).find((c) => /\/messages\?/.test(c)) || "")) && Number(/after:(\d+)/.exec(decodeURIComponent(calls.slice(nCalls).find((c) => /\/messages\?/.test(c))))[1]) === Math.floor((rec.watermarkMs - 3600000) / 1000), "the second scan starts an hour before the watermark");
      // the AI review: a confident "not a tender" drops one, a stated deadline fills a default
      const kv2 = JSON.parse(JSON.stringify({ "gradcon-google-mail": kv["gradcon-google-mail"], "gradcon-projects": { value: [], updated_at: "2026-10-20T00:00:00Z" } }));
      Object.keys(kv).forEach((k) => { if (!kv2[k] && k !== "gradcon-tender-inbox" && !/^gradcon-quote-/.test(k)) kv2[k] = kv[k]; });
      Object.keys(kv).forEach((k) => delete kv[k]); Object.assign(kv, kv2);
      G.resetTokenCache();
      const third = await TI.runTenderInbox({ action: "scan", by: "test" }, genv, fetchMock, { now: () => now, review: async (list) => { const out = {}; list.forEach((c) => { out[c.messageId] = c.messageId === "m6" ? { tender: false, confidence: "high", reason: "an architect asking for a budget" } : { tender: true, confidence: "high", projectName: "", client: "", deadline: null }; }); return out; } });
      assertTrue(third.status === 200 && third.body.created.length === 3 && !third.body.created.some((c) => /Ocean St/.test(c.name)) && kv["gradcon-tender-inbox"].value.handled.m6.outcome === "skipped" && /AI review/.test(kv["gradcon-tender-inbox"].value.handled.m6.reason), JSON.stringify(third.body.created.map((c) => c.name)));
      const st = await TI.runTenderInbox({ action: "status" }, genv, fetchMock);
      assertTrue(st.status === 200 && st.body.record.created.length === 3 && st.body.configured === true);
      // 16 Nov 2026 — texts on a new project: OFF unless NEW_PROJECT_SMS is on; on, each project texts the estimator (the details) and Grady (the question)
      assertTrue(first.body.summary.sms.on === false && first.body.summary.sms.sent === 0, "with the switch off the scan texts nobody");
      assertTrue(st.body.sms && st.body.sms.on === false, "the status says the switch is off");
      const kv3 = JSON.parse(JSON.stringify({ "gradcon-google-mail": kv["gradcon-google-mail"], "gradcon-projects": { value: [], updated_at: "2026-10-20T00:00:00Z" } }));
      Object.keys(kv).forEach((k) => { if (!kv3[k] && k !== "gradcon-tender-inbox" && !/^gradcon-quote-/.test(k)) kv3[k] = kv[k]; });
      Object.keys(kv).forEach((k) => delete kv[k]); Object.assign(kv, kv3);
      G.resetTokenCache();
      const texted = [];
      const fourth = await TI.runTenderInbox({ action: "scan", by: "test" }, { ...genv, NEW_PROJECT_SMS: "on", SMS_COPY_NAME: "Sam" }, fetchMock, { now: () => now, review: async (list) => { const out = {}; list.forEach((c) => { out[c.messageId] = c.messageId === "m6" ? { tender: false, confidence: "high", reason: "a budget enquiry" } : { tender: true, confidence: "high", projectName: "", client: "", deadline: null }; }); return out; },
        sendSms: async (msgs) => msgs.map((m, i) => { texted.push(m); return i === 1 ? { role: m.role, to: "+614••• ••• 000", ok: false, error: "Twilio said no" } : { role: m.role, to: "+614••• ••• 111", ok: true, id: "SM" + i }; }) });
      assertTrue(fourth.status === 200 && fourth.body.created.length === 3 && texted.length === 6, `created ${fourth.body.created.length}, texts ${texted.length}`);
      assertTrue(texted.filter((m) => m.role === "copy").length === 3 && texted.filter((m) => m.role === "grady").length === 3);
      const beachCopy = texted.find((m) => m.role === "copy" && /12 Beach Road/.test(m.text)), beachGrady = texted.find((m) => m.role === "grady" && /12 Beach Road/.test(m.text));
      assertTrue(/^New tender in the portal: 12 Beach Road, Rye VIC 3941 - Concrete works/.test(beachCopy.text) && /Closes Sat 14 Nov\./.test(beachCopy.text) && /2 files attached\./.test(beachCopy.text) && /Please check it\./.test(beachCopy.text), beachCopy.text);
      assertTrue(/^Hi Grady, /.test(beachGrady.text) && /Please let Sam know if it is something we want to price or not\.$|Sam will pick it up\.$/.test(beachGrady.text), beachGrady.text);
      assertTrue(fourth.body.summary.sms.on === true && fourth.body.summary.sms.sent === 5 && fourth.body.summary.sms.failed === 1 && fourth.body.errors.some((e) => /Text to \+614••• ••• 000 not sent: Twilio said no/.test(e)), JSON.stringify(fourth.body.summary.sms));
      assertTrue(kv["gradcon-tender-inbox"].value.created.length === 3, "a refused text never fails the scan or its record");
      assertTrue((await TI.runTenderInbox({ action: "scan" }, {}, fetchMock)).status === 503, "unconfigured → 503");
      G.resetTokenCache();
    });
    check("Tender inbox function: the cron call is the shared secret when one is set, else Vercel's cron user agent; the index append retries on a changed stamp and never overwrites", async () => {
      assertTrue(TI.isCronCall({ headers: { authorization: "Bearer s3" } }, { CRON_SECRET: "s3" }) && !TI.isCronCall({ headers: { authorization: "Bearer nope" } }, { CRON_SECRET: "s3" }) && !TI.isCronCall({ headers: { "user-agent": "vercel-cron/1.0" } }, { CRON_SECRET: "s3" }) && TI.isCronCall({ headers: { "user-agent": "vercel-cron/1.0" } }, {}) && !TI.isCronCall({ headers: { "user-agent": "Mozilla" } }, {}));
    });
    await checkAsync("Tender inbox function: appendProjectEntry re-reads after a lost race and gives up, never a blind overwrite", async () => {
      let reads = 0; const calls = [];
      const racy = async (url, init = {}) => { const method = (init.method || "GET").toUpperCase(); calls.push(method); if (method === "GET") { reads += 1; return { ok: true, json: async () => [{ value: [{ id: "a" }], updated_at: `2026-10-28T00:00:0${reads}Z` }] }; } if (method === "PATCH") return { ok: true, json: async () => [] }; return { ok: false, status: 500, json: async () => ({}) }; };
      const r = await TI.appendProjectEntry({ id: "new", storageKey: "gradcon-quote-new", createdAt: "x" }, racy, { attempts: 3 });
      assertTrue(!r.ok && reads === 3 && calls.filter((c) => c === "PATCH").length === 3 && !calls.includes("POST"));
    });
    // ---- 18 Nov 2026 (Boma: "a new take off rfq just arrived and we werent notified. i want the mailbox scanned for new emails always and flag projects even if it is from within the organisation")
    const NPS = await import("../src/lib/newProjectSms.js");
    // Grady's email, as the mailbox holds it
    const takeoff = { id: "k1", threadId: "k1", from: "Grady Fink <grady@gradcon.com.au>", subject: "Takeoff - 22 Junction Rd, Merricks", date: "2026-11-18T23:19:21.000Z", body: "Hey Mate, \n\nCan I please get you to measure/ mark up the following areas as per my markup. It’s to assist me with some variation works that have been completed onsite. \n\nRelevant drawings attached\n\nCheers", attachments: [{ attachmentId: "a", filename: "19112026101719-0001.pdf", size: 2010244 }, { attachmentId: "b", filename: "001_Ground Floor Plan_RevR.pdf", size: 1200554 }, { attachmentId: "c", filename: "Grady.png", size: 59923 }] };
    check("Tender inbox: a colleague's request to the estimators IS a request (Grady's 'Takeoff - 22 Junction Rd, Merricks … measure / mark up' — skipped until 18 Nov 2026 as Gradcon's own message); the mailbox's own mail, a colleague's ordinary reply and a forwarded supplier notice are not", () => {
      const c = T.classifyMessage(takeoff);
      assertTrue(c.candidate && c.internal && c.excluded === null && c.reasons.includes("from within Gradcon") && c.reasons.includes("a takeoff asked for"), JSON.stringify(c));
      assertTrue(T.classifyMessage({ ...takeoff, from: "Boma Ipalibo <projects@gradcon.com.au>" }).excluded === "Gradcon's own message" && T.classifyMessage({ ...takeoff, from: "projects@gradcon.com.au" }).excluded === "Gradcon's own message", "the scanned mailbox's own message is never a request");
      assertTrue(T.classifyMessage({ ...takeoff, from: "Boma <projects@gradcon.com.au>" }, { mailbox: "estimating@gradcon.com.au" }).candidate, "the mailbox is the one the scan reads, not a fixed address");
      const hours = T.classifyMessage({ from: "Georgie Keach <accounts@gradcon.com.au>", subject: "Re: Hours Log for the week ending 15 November, 2026", body: "Thanks Boma, can you please send the hours for Friday too" });
      assertTrue(!hours.candidate && hours.internal && hours.excluded === null, JSON.stringify(hours));
      assertTrue(!T.classifyMessage({ from: "Narelle Higgins <admin@gradcon.com.au>", subject: "Fwd: Fuel Surcharge Adjustment - Effective 16th November 2026 - VIC", body: "---------- Forwarded message ---------\nFrom: Holcim <x@holcim.com>\nSubject: Fuel Surcharge\n\nplease see attached pricing" }).candidate);
      assertTrue(T.classifyMessage(fwd).candidate && !T.classifyMessage(fwd).internal, "a tender a colleague FORWARDS is still the builder's request");
      assertTrue(T.classifyMessage({ ...takeoff, from: "Trevor <trevor@dmacpiling.com.au>", subject: "Re: RFQ – Bored Pier Works – 514 Park Street", body: "see our takeoff attached" }).excluded === "a reply to Gradcon's own RFQ");
      assertTrue(T.parseAddress("projects@gradcon.com.au").email === "projects@gradcon.com.au" && T.parseAddress("<a.b@x.com.au>").email === "a.b@x.com.au" && T.parseAddress("Boma Ipalibo <projects@gradcon.com.au>").name === "Boma Ipalibo", "a bare address is read whole (it used to split into a name and a tail)");
    });
    const ck = T.candidateFromMessage(takeoff, { now: new Date("2026-11-18T23:40:00Z") });
    check("Tender inbox: the colleague's request becomes a project named by its address ('Takeoff -' is furniture), with no client (a colleague is not the client), marked internal · takeoff, the two drawings kept and the signature picture left in the email", () => {
      assertTrue(ck.projectName === "22 Junction Rd, Merricks" && ck.client === "" && ck.internal === true && ck.requestKind === "takeoff" && ck.fromEmail === "grady@gradcon.com.au" && ck.deadline === "2026-12-02" && ck.deadlineSource === "default", JSON.stringify([ck.projectName, ck.client, ck.requestKind, ck.deadline]));
      assertTrue(ck.attachments.length === 2 && !ck.attachments.some((a) => /Grady\.png/.test(a.filename)) && T.isSignatureImage({ filename: "logo.png", size: 4000 }) && !T.isSignatureImage({ filename: "site photo.jpg", size: 900000 }) && !T.isSignatureImage({ filename: "S-01.pdf", size: 4000 }), "an image under 100 kB is a signature, not a drawing");
      const q = T.tenderQuoteFrom(ck, { today: "2026-11-19" });
      assertTrue(q.status === "Queued" && q.source.internal === true && q.source.requestKind === "takeoff" && q.clientName === "" && T.tenderQuoteFrom(c1).source.internal === false && T.tenderQuoteFrom(c1).source.requestKind === "tender");
      assertTrue(T.requestKindOf({ subject: "New job to price - 4 High St", body: "can you price this one" }, true) === "internal" && T.requestKindOf(takeoff, false) === "tender");
      const prompt = T.tenderReviewPrompt([ck], { today: "2026-11-19" });
      assertTrue(/"internal":true/.test(prompt.replace(/\s+/g, "")) && /from a colleague at Gradcon/.test(prompt) && /sender is NOT the client/.test(prompt), "the AI review is told what an internal request is");
      assertTrue(T.applyReview(ck, { tender: true, confidence: "high", projectName: "", client: "Gradcon Concrete Constructions", deadline: null }).cand.client === "", "the review never makes Gradcon its own client");
    });
    check("Tender inbox: the texts for a colleague's request — the estimator is told who asked and what, Grady is told his own request is in (never asked whether to price it), another colleague's request is reported to him; a request about a project already in the portal texts the estimator only", () => {
      const item = { projectId: "pk", name: ck.projectName, client: ck.client, deadline: ck.deadline, deadlineSource: ck.deadlineSource, from: ck.from, fromEmail: ck.fromEmail, via: ck.via, internal: true, requestKind: "takeoff", attachments: 2 };
      const texts = NPS.newProjectTexts([item], { estimator: "Boma" });
      assertTrue(texts.length === 2 && texts[0].role === "copy" && texts[0].text === "New takeoff request in the portal: 22 Junction Rd, Merricks from Grady Fink. No closing date in the email - set to Wed 2 Dec (2 weeks). 2 files attached. Please check it.", texts[0].text);
      assertTrue(texts[1].role === "grady" && texts[1].text === "Hi Grady, your takeoff request for 22 Junction Rd, Merricks is now a project in the portal. Boma will pick it up.", texts[1].text);
      assertTrue(NPS.sentByGrady(item) && !NPS.sentByGrady({ ...item, internal: false }) && !NPS.sentByGrady({ ...item, from: "Narelle Higgins <admin@gradcon.com.au>", fromEmail: "admin@gradcon.com.au" }));
      const other = NPS.newProjectSmsForGrady({ ...item, requestKind: "internal", from: "Narelle Higgins <admin@gradcon.com.au>", fromEmail: "admin@gradcon.com.au" }, { estimator: "Boma" });
      assertTrue(other === "Hi Grady, Narelle Higgins sent the estimators a request: 22 Junction Rd, Merricks. It is now a project in the portal. Boma will pick it up.", other);
      assertTrue(!/price it|want to price/.test(texts.map((t) => t.text).join(" ")) && texts.every((t) => !/[^\x00-\x7f]/.test(t.text) && t.text.length <= 306), "plain GSM characters, two segments at most, nothing asked of Grady");
      const tA = { projectId: "t1", name: "1 First St", client: "Buildco", deadline: "2026-11-27", deadlineSource: "email", from: "Fred <fred@buildco.com.au>", attachments: 1 };
      assertTrue(/^4 new requests in the portal: /.test(NPS.newProjectTexts([item, tA, { ...tA, projectId: "t2", name: "2 Second St" }, { ...tA, projectId: "t3", name: "3 Third St" }])[0].text) && /^4 new tenders in the portal: /.test(NPS.newProjectTexts([tA, { ...tA, projectId: "t2", name: "2 Second St" }, { ...tA, projectId: "t3", name: "3 Third St" }, { ...tA, projectId: "t4", name: "4 Fourth St" }])[0].text), "a colleague's request among several makes them 'requests'");
      const flags = NPS.existingProjectTexts([{ projectId: "old1", existingName: "22 Junction Road, Merricks VIC 3916", subject: "Takeoff - 22 Junction Rd, Merricks", from: "Grady Fink <grady@gradcon.com.au>", internal: true, requestKind: "takeoff" }]);
      assertTrue(flags.length === 1 && flags[0].role === "copy" && flags[0].text === 'New takeoff request about a project already in the portal (22 Junction Road, Merricks VIC 3916) from Grady Fink: "Takeoff - 22 Junction Rd, Merricks". No new project was made - please check the email.' && flags[0].projectIds[0] === "old1", flags[0] && flags[0].text);
      assertTrue(NPS.existingProjectTexts([]).length === 0 && NPS.existingProjectTexts([1, 2, 3, 4].map((i) => ({ existingName: `Job ${i}`, subject: "x" }))).length === 1 && NPS.existingProjectTexts([{ existingName: "A", subject: "B", from: "x@y.com" }]).every((t) => t.role === "copy"), "more than three → one text; never to Grady");
    });
    check("Tender inbox: a message the old rule skipped as 'Gradcon's own message' is looked at again unless the mailbox itself wrote it; the lock, the night hours and the three-minute throttle", () => {
      const rec = { ...T.emptyRecord(), handled: { k1: { outcome: "skipped", reason: "Gradcon's own message", at: "x" }, k2: { outcome: "skipped", reason: "Gradcon's own message", at: "x" }, k3: { outcome: "skipped", reason: "not a request (score 1)", at: "x" } } };
      assertTrue(!T.wasHandled(rec, { id: "k1", from: "Grady Fink <grady@gradcon.com.au>" }) && T.wasHandled(rec, { id: "k2", from: "Boma <projects@gradcon.com.au>" }) && T.wasHandled(rec, { id: "k3", from: "Grady Fink <grady@gradcon.com.au>" }) && T.wasHandled(rec, { id: "k1" }), "only a colleague's message is re-read, and only for that reason");
      const t0 = new Date("2026-11-19T00:00:00Z");   // 11 am in Melbourne
      assertTrue(T.scanLockHeld({ scanning: { at: "2026-11-18T23:57:00Z", by: "cron" } }, t0) && !T.scanLockHeld({ scanning: { at: "2026-11-18T23:50:00Z", by: "cron" } }, t0) && !T.scanLockHeld({ scanning: null }, t0) && !T.scanLockHeld(T.emptyRecord(), t0), "a lock older than six minutes is a scan that died");
      assertTrue(T.applyScan({ ...T.emptyRecord(), scanning: { at: "x", by: "y" } }, { at: "2026-11-19T00:00:00Z" }).scanning === null, "a finished scan lets go of the record");
      assertTrue(T.melbourneHour(t0) === 11 && T.melbourneHour(new Date("2026-06-19T00:00:00Z")) === 10 && T.melbourneHour(new Date("2026-11-19T13:30:00Z")) === 0);
      assertTrue(T.autoScanHold({ lastScanAt: "2026-11-18T23:58:30Z" }, t0) === "scanned a moment ago" && T.autoScanHold({ lastScanAt: "2026-11-18T23:50:00Z" }, t0) === null && T.autoScanHold(T.emptyRecord(), t0) === null);
      assertTrue(/outside 6 am - 9 pm/.test(T.autoScanHold(T.emptyRecord(), new Date("2026-11-19T12:00:00Z"))) && /outside/.test(T.autoScanHold(T.emptyRecord(), new Date("2026-11-18T18:30:00Z"))) && T.autoScanHold(T.emptyRecord(), new Date("2026-11-18T19:00:00Z")) === null, "11 pm and 5:30 am stand down, 6 am runs");
      assertTrue(T.AUTO_SCAN_MIN_MS === 180000 && T.SCAN_LOCK_MS === 360000);
    });
    await checkAsync("Tender inbox function: Grady's takeoff request makes ONE project and both texts; a scan that finds the record held, an automatic one inside three minutes or at night, stands down without reading the mailbox; the automatic answer carries no record; a record that cannot be read scans nothing; a request about a project already in the portal texts the estimator only", async () => {
      const stored = { email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv) };
      const gm = (m) => ({ id: m.id, threadId: m.threadId, internalDate: String(Date.parse(m.date)), snippet: m.body.slice(0, 120), labelIds: [], payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: m.date }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from(m.body).toString("base64url") } }, ...m.attachments.map((a) => ({ mimeType: a.mimeType || "application/octet-stream", filename: a.filename, body: { attachmentId: a.attachmentId, size: a.size || 10 } }))] } });
      const mail = { k1: gm(takeoff), k2: gm({ id: "k2", threadId: "k2", from: "Boma Ipalibo <projects@gradcon.com.au>", subject: "RFQ – Bored Pier Works – 62-66 Withers Street", date: "2026-11-17T23:27:48Z", body: "Dear Trevor, Gradcon invites DMAC to quote", attachments: [] }), k3: gm({ id: "k3", threadId: "k3", from: "Georgie Keach <accounts@gradcon.com.au>", subject: "Re: Hours Log for the week ending 15 November, 2026", date: "2026-11-17T22:53:16Z", body: "Thanks", attachments: [] }) };
      // the record as the live one stood: the two colleagues' messages skipped by the old rule
      const kv = { "gradcon-google-mail": { value: stored, updated_at: "2026-10-01T00:00:00Z" }, "gradcon-projects": { value: [], updated_at: "2026-10-20T00:00:00Z" }, "gradcon-tender-inbox": { value: { ...T.emptyRecord(), watermarkMs: Date.parse("2026-11-18T23:00:19Z"), lastScanAt: "2026-11-18T23:00:45Z", handled: { k1: { outcome: "skipped", reason: "Gradcon's own message", at: "2026-11-19T02:00:00Z" }, k3: { outcome: "skipped", reason: "Gradcon's own message", at: "2026-11-17T23:00:45Z" } } }, updated_at: "2026-11-18T23:00:46Z" } };
      const calls = []; let failRecord = false;
      const fetchMock = async (url, init = {}) => { const u = String(url); const method = (init.method || "GET").toUpperCase(); calls.push(`${method} ${u}`);
        if (/oauth2\.googleapis\.com\/token/.test(u)) return { ok: true, json: async () => ({ access_token: "at", expires_in: 3600 }) };
        if (/estimator_kv\?key=like\.gradcon-quote-/.test(u)) return { ok: true, json: async () => Object.keys(kv).filter((k) => /^gradcon-quote-/.test(k)).map((k) => ({ key: k, updated_at: kv[k].updated_at, name: kv[k].value.projectName, client: kv[k].value.clientName, status: kv[k].value.status, source: kv[k].value.source || null })) };
        let m = /estimator_kv\?key=eq\.([^&]+)(?:&updated_at=eq\.([^&]+))?/.exec(u);
        if (m && method === "GET") { const k = decodeURIComponent(m[1]); if (failRecord && k === "gradcon-tender-inbox") return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, json: async () => (kv[k] ? [kv[k]] : []) }; }
        if (m && method === "PATCH") { const k = decodeURIComponent(m[1]); const stamp = decodeURIComponent(m[2] || ""); if (!kv[k] || kv[k].updated_at !== stamp) return { ok: true, json: async () => [] }; const b = JSON.parse(init.body); kv[k] = { value: b.value, updated_at: b.updated_at }; return { ok: true, json: async () => [{ key: k }] }; }
        if (/\/rest\/v1\/estimator_kv$/.test(u) && method === "POST") { const b = JSON.parse(init.body); kv[b.key] = { value: b.value, updated_at: b.updated_at }; return { ok: true, json: async () => ({}) }; }
        if (/\/messages\?/.test(u)) return { ok: true, json: async () => ({ messages: Object.keys(mail).map((id) => ({ id })) }) };
        m = /\/messages\/([^/?]+)\/attachments\/([^/?]+)/.exec(u); if (m) return { ok: true, json: async () => ({ data: Buffer.from(`%PDF-${m[2]}`).toString("base64url") }) };
        m = /\/messages\/([^/?]+)\?format=(metadata|full)/.exec(u); if (m) { const msg = mail[m[1]]; if (!msg) return { ok: false, status: 404, json: async () => ({}) }; if (m[2] === "metadata") { const { payload, ...rest } = msg; return { ok: true, json: async () => ({ ...rest, payload: { headers: payload.headers } }) }; } return { ok: true, json: async () => msg }; }
        if (/storage\/v1\/object\/gradcon-files\//.test(u) && method === "POST") return { ok: true, json: async () => ({}) };
        return { ok: false, status: 404, json: async () => ({}) }; };
      const envOn = { ...genv, NEW_PROJECT_SMS: "on" };
      const day = new Date("2026-11-18T23:40:00Z");   // 10:40 am Melbourne
      G.resetTokenCache();
      // an automatic scan inside three minutes of the last one, and one at night: neither reads the mailbox
      const soon = await TI.runTenderInbox({ action: "scan", by: "portal", auto: true }, envOn, fetchMock, { now: () => new Date("2026-11-18T23:02:00Z"), review: null });
      const night = await TI.runTenderInbox({ action: "scan", by: "portal", auto: true }, envOn, fetchMock, { now: () => new Date("2026-11-19T13:00:00Z"), review: null });
      assertTrue(soon.status === 200 && soon.body.skipped === "scanned a moment ago" && /outside 6 am/.test(night.body.skipped) && !("record" in soon.body) && !calls.some((c) => /\/messages/.test(c) || /oauth2/.test(c)), JSON.stringify([soon.body, night.body]));
      // a record another scan holds: stood down, nothing read, nothing written
      const before = JSON.stringify(kv["gradcon-tender-inbox"]);
      kv["gradcon-tender-inbox"].value.scanning = { at: "2026-11-18T23:38:00Z", by: "cron" };
      const held = await TI.runTenderInbox({ action: "scan", by: "boma" }, envOn, fetchMock, { now: () => day, review: null });
      assertTrue(held.status === 200 && held.body.skipped === "another scan is running" && held.body.created.length === 0 && !calls.some((c) => /\/messages/.test(c)), JSON.stringify(held.body).slice(0, 200));
      kv["gradcon-tender-inbox"] = JSON.parse(before);
      // a record that cannot be read: nothing scanned, nothing saved over it
      failRecord = true;
      const unread = await TI.runTenderInbox({ action: "scan", by: "cron" }, envOn, fetchMock, { now: () => day, review: null });
      failRecord = false;
      assertTrue(unread.status === 502 && /could not read the scan record/.test(unread.body.error) && JSON.stringify(kv["gradcon-tender-inbox"]) === before && !calls.some((c) => /\/messages/.test(c)), JSON.stringify(unread.body));
      // the scan itself — the portal's own (automatic), in the day
      const texted = [];
      const sendSms = async (msgs) => msgs.map((mm, i) => { texted.push(mm); return { role: mm.role, to: "+614••• ••• 111", ok: true, id: "SM" + i }; });
      const run = await TI.runTenderInbox({ action: "scan", by: "portal", auto: true }, envOn, fetchMock, { now: () => day, review: null, sendSms });
      assertTrue(run.status === 200 && run.body.created.length === 1 && run.body.created[0].name === "22 Junction Rd, Merricks" && run.body.created[0].internal === true && run.body.created[0].requestKind === "takeoff" && run.body.created[0].attachments === 2, JSON.stringify(run.body).slice(0, 400));
      assertTrue(!("record" in run.body) && JSON.stringify(run.body).length < 1500, "the automatic answer carries no record");
      assertTrue(calls.some((c) => /PATCH .*key=eq\.gradcon-tender-inbox&updated_at=eq\./.test(c)), "the record is taken with a conditional update before the mailbox is read");
      const rec = kv["gradcon-tender-inbox"].value;
      assertTrue(rec.scanning === null && rec.handled.k1.outcome === "created" && rec.handled.k2.outcome === "skipped" && rec.handled.k2.reason === "Gradcon's own message" && rec.created.length === 1 && rec.lastScanBy === "portal", JSON.stringify(rec.handled));
      assertTrue(!rec.handled.k3 || rec.handled.k3.outcome === "skipped", "the hours-log reply never becomes a project");
      const made = kv[run.body.created[0].storageKey].value;
      assertTrue(made.status === "Queued" && made.source.internal === true && made.source.requestKind === "takeoff" && made.clientName === "" && made.files.length === 2 && !made.files.some((f) => /Grady\.png/.test(f.name)), JSON.stringify(made.files.map((f) => f.name)));
      assertTrue(texted.length === 2 && texted[0].role === "copy" && /^New takeoff request in the portal: 22 Junction Rd, Merricks from Grady Fink\./.test(texted[0].text) && texted[1].role === "grady" && /^Hi Grady, your takeoff request for 22 Junction Rd, Merricks is now a project in the portal\./.test(texted[1].text) && run.body.summary.sms.sent === 2, JSON.stringify(texted));
      // the same scan again: nothing new, nobody texted
      const again = await TI.runTenderInbox({ action: "scan", by: "cron" }, envOn, fetchMock, { now: () => new Date("2026-11-18T23:55:00Z"), review: null, sendSms });
      assertTrue(again.status === 200 && again.body.created.length === 0 && texted.length === 2 && kv["gradcon-projects"].value.length === 1, "a second scan makes nothing and texts nobody");
      // a second email about the same address, on another thread: no project, the estimator alone is told
      mail.k4 = gm({ ...takeoff, id: "k4", threadId: "k4", subject: "Takeoff - 22 Junction Road, Merricks - balcony", date: "2026-11-19T00:10:00Z" });
      const flag = await TI.runTenderInbox({ action: "scan", by: "cron" }, envOn, fetchMock, { now: () => new Date("2026-11-19T00:15:00Z"), review: null, sendSms });
      assertTrue(flag.status === 200 && flag.body.created.length === 0 && flag.body.flagged.length === 1 && flag.body.summary.flagged === 1 && kv["gradcon-projects"].value.length === 1 && kv["gradcon-tender-inbox"].value.handled.k4.outcome === "duplicate", JSON.stringify(flag.body.summary));
      assertTrue(texted.length === 3 && texted[2].role === "copy" && /^New takeoff request about a project already in the portal \(22 Junction Rd, Merricks\) from Grady Fink: "Takeoff - 22 Junction Road, Merricks - balcony"\. No new project was made/.test(texted[2].text), texted[2] && texted[2].text);
      G.resetTokenCache();
    });
    check("Tender inbox function: the handler passes `auto` only when the body says true, and the record is read with its stamp (a failed read throws, never an empty record)", () => {
      const src = fs.readFileSync(new URL("../api/tender-inbox.js", import.meta.url), "utf8");
      assertTrue(/auto: body\.auto === true/.test(src) && /if \(!r\.ok\) throw new Error\(`could not read the scan record/.test(src) && !/readRow\(INBOX_ROW_KEY/.test(src), "no scan path reads the record through the null-on-failure reader");
      assertTrue(/if \(auto\) \{ const hold = autoScanHold\(row\.record, now\)/.test(src) && /if \(scanLockHeld\(row\.record, now\)\) return stoodDown/.test(src) && src.indexOf("takeScanLock(row.record") < src.indexOf("Gm.listMessages("), "the throttle and the lock come before the mailbox is listed");
    });
  }
  await checkAsync("AI chat: recent mail joins the context when Google is configured, a mail failure never fails the chat, and no Google means no mail key", async () => {
    const got = await C.mailForContext(genv, { mail: async () => ({ mailbox: "projects@gradcon.com.au", messages: [{ subject: "Tender" }] }) });
    const failed = await C.mailForContext(genv, { mail: async () => { throw new Error("offline"); } });
    assertTrue(got.messages[0].subject === "Tender" && failed.error === "offline" && (await C.mailForContext({})) === null && /under "mail"/.test(C.chatSystem({})));
  });
  await checkAsync("AI chat: with the mailbox connected the model gets search_mail / read_mail tools and the loop runs them (OpenAI function-calling shape, mocked), returning the trace of what was searched", async () => {
    let n = 0;
    const fetchImpl = async (url, init) => { n++; const body = JSON.parse(init.body); if (n === 1) { assertTrue(Array.isArray(body.tools) && body.tools.some((t) => t.function.name === "search_mail")); return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_mail", arguments: JSON.stringify({ q: "from:holcim newer_than:90d" }) } }] } }] }) }; } const toolMsg = body.messages.find((m) => m.role === "tool"); return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ message: { content: "Found **1**: " + JSON.parse(toolMsg.content).messages[0].subject } }] }) }; };
    const deps = { mail: async () => ({ mailbox: "projects@gradcon.com.au", messages: [] }), search: async (q) => ({ messages: [{ id: "m9", from: "Holcim", subject: "Surcharge notice 1 Aug", date: "2026-08-01", snippet: "x", attachments: [] }], resultSizeEstimate: 1 }), fetchImpl };
    const r = await C.runChat({ provider: "openai", messages: [{ role: "user", content: "any holcim surcharge in the last 3 months?" }], context: {} }, { OPENAI_API_KEY: "k", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }, deps);
    assertTrue(r.status === 200 && /Surcharge notice 1 Aug/.test(r.body.reply) && r.body.trace.length === 1 && r.body.trace[0].name === "search_mail" && r.body.trace[0].args.q === "from:holcim newer_than:90d" && n === 2);
    const noMail = await C.runChat({ provider: "openai", messages: [{ role: "user", content: "hi" }], context: {} }, { OPENAI_API_KEY: "k" }, { fetchImpl: async () => ({ ok: true, json: async () => ({ model: "gpt-5", choices: [{ message: { content: "Hello" } }] }) }) });
    assertTrue(noMail.status === 200 && noMail.body.trace.length === 0);
    assertTrue(/search_mail/.test(C.chatSystem({})) && /Never say you cannot look back/.test(C.chatSystem({})) && /### Heading/.test(C.chatSystem({})));
  });
  // Takeoff vs documents, rates vs market (Grady, 11 Oct 2026)
  {
    const inst = { id: "EL01", typeKey: "padfooting", label: "PF1 pad footing PF1", data: { grade: 32, cover: 50, length: 1200, width: 1200, depth: 600, botReoType: "bars", botXDia: "N16", botXSpacing: 200, qty: 4, __aiImport: { mark: "PF1", sheet: "S-02" } } };
    const col = { id: "EL02", typeKey: "column", label: "C1 column C1", data: { grade: 32, cover: 40, shape: "rect", width: 400, depth: 400, height: 3200, vDia: "N24", vBars: 8, ligDia: "N10", ligSpacing: 200, qty: 6, __aiImport: { mark: "C1", sheet: "S-02" } } };
    const hand = { id: "EL03", typeKey: "slabonground", label: "Blinding slab (added by hand)", data: { grade: 20, thickness: 50, length: 5, width: 5, meshOn: false } };
    const proposal = { elements: [{ type: "padfooting", label: "PF1 pad footing", mark: "PF1", sheet: "S-02", qty: 4, length_mm: 1200, width_mm: 1200, depth_mm: 600, grade: 40, cover_mm: 50, mainDia: "N16", mainSpacing: 200, evidence: "PF1 N40", include: true }, { type: "column", label: "C1 column", mark: "C1", sheet: "S-02", qty: 6, width_mm: 400, depth_mm: 400, height_mm: 3200, grade: 32, mainDia: "N24", mainQty: 8, ligDia: "N10", ligSpacing: 150, include: true }, { type: "suspslab", label: "L1 slab", sheet: "S-03", area_m2: 72, depth_mm: 200, include: true }, { type: "beam", label: "rejected", include: false }] };
    const profile = { specName: "Spec C", defaults: { concreteGradeByElement: { footings: "N40", columns: "N40", all: "N32" }, coverByElement: { footings: 50, all: 40 } } };
    const calcOf = (t) => ({ padfooting: "padfooting", column: "column", slabonground: "slab" })[t] || null;
    const r = Q.compareTakeoffToDocuments({ instances: [inst, col, hand], proposal, profile, calcOf, today: "2026-10-11" });
    // both documents optional (11 Oct 2026): no drawing reading → nothing "not on the drawings" or "missing from the takeoff"; no spec → no spec findings; the takeoff's own warnings always listed
    const warned = { ...inst, results: { warnings: [{ text: "Footing length not entered", level: "completeness" }, { text: "Cover 20 mm is below the section", level: "sanity" }, { text: "Confirm the grade", level: "verify" }] } };
    const none = Q.compareTakeoffToDocuments({ instances: [warned, col, hand], proposal: null, profile: null, calcOf, today: "2026-10-11" });
    assertTrue(!none.findings.some((f) => /drawing|spec/.test(f.check)) && none.findings.filter((f) => f.check === "takeoff-warning").length === 2 && none.findings.some((f) => f.severity === "medium" && /Incomplete: Footing length/.test(f.message)) && !none.findings.some((f) => /Confirm the grade/.test(f.message)) && none.summary.documents.drawings === false && none.summary.documents.specification === false, JSON.stringify(none.findings));
    const drawOnly = Q.compareTakeoffToDocuments({ instances: [inst, col, hand], proposal, profile: null, calcOf, today: "2026-10-11" });
    assertTrue(drawOnly.summary.documents.drawings === true && drawOnly.summary.documents.specification === false && !drawOnly.findings.some((f) => /-vs-spec$/.test(f.check)) && drawOnly.findings.some((f) => /-vs-drawing$/.test(f.check)), JSON.stringify(drawOnly.findings.map((f) => f.check)));
    const by = (c) => r.findings.filter((f) => f.check === c);
    check("Quality (documents): instanceFacts reads each calculator's own fields into the generic shape (pad footing bars and size, column verticals, ligatures and height)", () => { const f = Q.instanceFacts(inst, "padfooting"), g = Q.instanceFacts(col, "column"); assertTrue(f.grade === 32 && f.cover === 50 && f.L === 1200 && f.D === 600 && f.main.dia === "N16" && f.main.spacing === 200 && g.main.qty === 8 && g.ligs.spacing === 200 && g.H === 3200 && g.W === 400); });
    check("Quality (documents): elements match by mark and sheet, a rejected drawing element never counts, and the hand-added element is noted as not on the drawings", () => { const m = Q.matchInstances([inst, col, hand], proposal.elements.filter((e) => e.include)); assertTrue(m.pairs[0].el.mark === "PF1" && m.pairs[1].el.mark === "C1" && m.pairs[2].el === null && m.unmatched.length === 1 && m.unmatched[0].el.label === "L1 slab" && by("not-on-drawings").length === 1 && by("not-on-drawings")[0].element === "Blinding slab (added by hand)"); });
    check("Quality (documents): the grade the takeoff used is compared with the drawings (HIGH: N32 vs N40 with the sheet and quoted evidence) and with the specification per element family", () => assertTrue(by("grade-vs-drawing").length === 1 && by("grade-vs-drawing")[0].severity === "high" && /N32 in the takeoff; the drawings say N40/.test(by("grade-vs-drawing")[0].message) && /sheet S-02 mark PF1: PF1 N40/.test(by("grade-vs-drawing")[0].evidence) && by("grade-vs-spec").length === 3 && by("grade-vs-spec").some((f) => f.element === "C1 column C1" && f.severity === "medium" && /drawings agree with the takeoff/.test(f.message))));
    check("Quality (documents): bars, ligature spacing and counts are compared; an element on the drawings with no takeoff element is a missing-from-takeoff finding", () => assertTrue(by("reo-vs-drawing").some((f) => f.element === "C1 column C1" && /Ligatures at 200 mm in the takeoff; the drawings say 150 mm/.test(f.message)) && by("missing-from-takeoff").length === 1 && /L1 slab/.test(by("missing-from-takeoff")[0].message) && r.summary.matched === 2 && r.summary.unmatchedOnDrawings === 1 && r.summary.hasSpec));
    const rates = defaultRates(); const concKey = Object.keys(rates).find((k) => /32 mpa/i.test(k));
    const rb = Q.rateBenchmarkFindings(rates, [{ name: "N32 concrete", match: "32 MPa", unit: "m3", low: 200, high: 260, source: "Holcim list", asOf: "2026-10" }, { name: "Concreter", match: "Concrete Crew", unit: "man-day", low: 400, high: 800 }, { match: "", low: 1 }], new Set([concKey]));
    check("Quality (market): an entered rate outside its Victorian band is a finding (medium when the project uses it) with the band and source; a rate inside its band is not; a row without a match is ignored", () => assertTrue(rb.length === 1 && rb[0].check === "rate-vs-market" && rb[0].severity === "medium" && /32 mpa Agilia \(m3\): entered \$31\d, Victorian market band \$200–\$260/.test(rb[0].message) && /Holcim list · as of 2026-10/.test(rb[0].evidence)));
    check("Quality (market): runQualityChecks folds the benchmark findings in through opts.rateBenchmarks", () => { const q = { projectName: "B", items: [(() => { const it = newElementItem(ELEMENT_TYPES[0]); it.qtys[concKey] = 5; return it; })()], gfa: 0 }; const rr = Q.runQualityChecks(q, rates, { today: "2026-10-11", rateBenchmarks: [{ match: "32 mpa", unit: "m3", low: 200, high: 260 }] }); assertTrue(rr.findings.some((f) => f.check === "rate-vs-market" && f.severity === "medium")); });
    await checkAsync("AI Engine: the benchmarks action needs products (400) and a provider (503); DeepSeek cannot web-search (501); the prompt forbids figures from memory", async () => { const P2 = await import("../api/_providers.js"); let t = null; try { await P2.callWebSearch("deepseek", { prompt: "x", env: { DEEPSEEK_API_KEY: "k" } }); } catch (e) { t = e.status; } assertTrue((await E.runAiJob({ action: "benchmarks" }, {})).status === 400 && (await E.runAiJob({ action: "benchmarks", products: [{ name: "x", unit: "m3" }] }, {})).status === 503 && t === 501 && /never estimate from memory/.test(E.benchmarksPrompt({ products: [{ name: "x", unit: "m3" }] }))); });
  }
  // Automatic quantities (src/lib/aiQuantities.js), the geotech and contract readers, detail / scale checks
  {
    const AQ = await import("../src/lib/aiQuantities.js");
    const pf = AQ.elementQuantities({ type: "padfooting", qty: 4, length_mm: 1200, width_mm: 1200, depth_mm: 600, mainDia: "N16", mainSpacing: 200, cover_mm: 50 }, "padfooting");
    const col = AQ.elementQuantities({ type: "column", qty: 6, width_mm: 400, depth_mm: 400, height_mm: 3200, mainDia: "N24", mainQty: 8, ligDia: "N10", ligSpacing: 200 }, "column");
    const slab = AQ.elementQuantities({ type: "suspslab", area_m2: 72, depth_mm: 200, mesh: "SL82" }, "slab");
    const sog = AQ.elementQuantities({ type: "slabonground", length_mm: 10000, width_mm: 8000, depth_mm: 100, mainDia: "N12", mainSpacing: 200 }, "slab");
    const none = AQ.elementQuantities({ type: "x", qty: 1 }, null);
    check("Quantities: a pad footing mark is L·W·D × qty of concrete, four formed faces, bars each way at the spacing (3.46 m³ / 11.52 m² / ~106 kg for 4 × 1200×1200×600 N16-200)", () => assertTrue(pf.concreteM3 === 3.46 && pf.formworkM2 === 11.52 && pf.steelKg > 95 && pf.steelKg < 120 && pf.excavationM3 > pf.concreteM3 && /L·W·D/.test(pf.basis)));
    check("Quantities: a column is W·D·H × qty with 4 faces, verticals × height and ties at the spacing; a suspended slab adds its soffit and weighs mesh by the sheet table; a slab on ground has edge formwork only", () => assertTrue(col.concreteM3 === 3.07 && col.formworkM2 === 30.72 && col.steelKg > 600 && slab.concreteM3 === 14.4 && slab.formworkM2 > 72 && slab.steelKg === Math.round(72 * 3.61 * 1.1) && sog.concreteM3 === 8 && sog.formworkM2 === 3.6 && sog.steelKg > 0));
    check("Quantities: an element with no formula gives zeros and says so — never a guess; bar mass is d²/162", () => assertTrue(none.concreteM3 === 0 && none.steelKg === 0 && /no formula/.test(none.notes[0]) && Math.abs(AQ.barKgPerM("N16") - 1.58) < 0.01 && AQ.MESH_KG_M2.SL82 === 3.61));
    check("Quantities: proposalTotals sums the ticked elements and counts the ones with no formula", () => { const t = AQ.proposalTotals([{ type: "padfooting", qty: 4, length_mm: 1200, width_mm: 1200, depth_mm: 600 }, { type: "nope" }], (ty) => (ty === "padfooting" ? "padfooting" : null)); assertTrue(t.concreteM3 === 3.46 && t.elements === 2 && t.uncounted === 1); });
    await checkAsync("AI Engine: geotech and contract are document actions (validated like spec), the takeoff prompt asks for detail callouts and scale checks, and the readers' prompts forbid invention", async () => assertTrue((await E.runAiJob({ action: "geotech", files: [{ url: "https://x/a.pdf", name: "a" }] }, {})).status === 503 && (await E.runAiJob({ action: "contract", files: [] }, {})).status === 400 && (await E.runAiJob({ action: "nope" }, {})).status === 400 && /"details"/.test(E.takeoffPrompt({ types: [] })) && /"scales"/.test(E.takeoffPrompt({ types: [] })) && /Do not invent values/.test(E.geotechPrompt({})) && /Do not invent clauses/.test(E.contractPrompt({})) && /responsibility matrix/.test(E.contractPrompt({}))));
    check("Estimates: the hand-off writes back the exact per-element and total quantities it computed (concrete m³, steel kg, formwork m²)", () => { const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8"); assertTrue(/quantities:\{ totals, perElement \}/.test(est) && /steelKg\(lines\)/.test(est) && /formworkTotals\(lines\)\.m2/.test(est)); });
  }
  check("Portal: the AI Engine page carries the Mail tab, the Quality checks picker and the system mirror's Open links; the shell carries Settings → Google mail", () => { const ai = fs.readFileSync(new URL("../portal/ai-engine.html", import.meta.url), "utf8"); const sh = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8"); assertTrue(/id="page-mail"/.test(ai) && /id="qaProject"/.test(ai) && /gradcon-qa\.js/.test(ai) && /data-open-quote=/.test(ai) && /data-open-takeoff=/.test(ai) && /id="settings-google"/.test(sh) && /google-auth\?action=start/.test(sh)); });
}

// ---------------------------------------------------------------------------
// Markup drawings live in the bucket, not the quote row (lib/markupStore.js)
// ---------------------------------------------------------------------------
{
  const MS = await import("../src/lib/markupStore.js");
  const uploads = [];
  const mock = (failId) => ({ storage: { from: (bucket) => ({
    upload: async (path, blob, opts) => { if (failId && path.includes(failId)) return { error: new Error("boom") }; uploads.push({ bucket, path, size: blob.size, type: blob.type, opts }); return { error: null }; },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
  }) } });
  const png = "data:image/png;base64," + Buffer.from("PNGBYTES").toString("base64");
  const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4 x").toString("base64");
  const quote = { items: [
    { id: "E1", markups: [{ id: "m1", name: "a.png", type: "image", rotation: 90, dataURL: png }, { id: "m2", name: "old.png", type: "image", path: "quote-markups/P1/m2.png" }] },
    { id: "E2", markups: [{ id: "m3", name: "b.pdf", type: "pdf", dataURL: pdf }] },
    { id: "E3" },
  ] };
  check("Markups: needsOffload sees the inline data URLs and nothing once they are paths", () => assertTrue(MS.needsOffload(quote) && !MS.needsOffload({ items: [quote.items[0] && { ...quote.items[0], markups: [quote.items[0].markups[1]] }] })));
  const client = mock();
  const { uploaded, failed } = await MS.offloadMarkups(quote, "P1", client);
  check("Markups: every inline markup is uploaded once, by id, with the right extension and content type (m2 already in the bucket is left alone)", () => assertTrue(uploaded.length === 2 && failed.length === 0 && uploads.map((u) => u.path).join() === "quote-markups/P1/m1.png,quote-markups/P1/m3.pdf"
    && uploads[0].size === 8 && uploads[0].type === "image/png" && uploads[0].opts.upsert === true && uploads[0].opts.contentType === "image/png" && uploads[1].opts.contentType === "application/pdf" && uploads.every((u) => u.bucket === "gradcon-files")));
  const after = MS.applyOffload(quote, uploaded);
  const m1 = after.items[0].markups[0], m3 = after.items[1].markups[0];
  check("Markups: applyOffload drops the data URL and keeps id, name, type and rotation beside the path", () => assertTrue(!("dataURL" in m1) && m1.path === "quote-markups/P1/m1.png" && m1.rotation === 90 && m1.name === "a.png" && !("dataURL" in m3) && m3.path === "quote-markups/P1/m3.pdf" && !MS.needsOffload(after)));
  check("Markups: a drawing replaced while its predecessor was uploading keeps its new bytes (data URL no longer matches → untouched)", () => assertTrue((() => { const q2 = { items: [{ id: "E1", markups: [{ id: "m1", dataURL: "data:image/png;base64,QUJD" }] }] }; const r = MS.applyOffload(q2, uploaded); return r === q2 && r.items[0].markups[0].dataURL === "data:image/png;base64,QUJD"; })()));
  check("Markups: applyOffload returns the same object when nothing changed; untouched items keep their identity", () => assertTrue(MS.applyOffload(quote, []) === quote && after.items[2] === quote.items[2]));
  check("Markups: markupSrc is the data URL while inline, the bucket's public URL once offloaded, '' with neither", () => assertTrue(MS.markupSrc(quote.items[0].markups[0], client) === png && MS.markupSrc(m1, client) === "https://x.supabase.co/storage/v1/object/public/gradcon-files/quote-markups/P1/m1.png" && MS.markupSrc({ id: "x" }, client) === "" && MS.markupSrc(m1, null) === ""));
  const r2 = await MS.offloadMarkups(quote, "P1", mock("m3"));
  check("Markups: one failed upload is reported, the others still go up, and the failed markup keeps its data URL", () => assertTrue(r2.uploaded.length === 1 && r2.failed.length === 1 && r2.failed[0].markupId === "m3" && MS.applyOffload(quote, r2.uploaded).items[1].markups[0].dataURL === pdf));
  const r3 = await MS.offloadMarkups(quote, "P1", mock(), { skip: new Set(["m1"]) });
  check("Markups: a skipped id (retry back-off) is not uploaded", () => assertTrue(r3.uploaded.length === 1 && r3.uploaded[0].markupId === "m3"));
  let threw = false; try { MS.dataUrlToBlob("https://not-a-data-url"); } catch { threw = true; }
  const r4 = await MS.offloadMarkups({ items: [{ id: "E", markups: [{ id: "q", dataURL: "data:text/plain,hello" }] }] }, "P1", mock());
  check("Markups: a non-data URL never uploads (dataUrlToBlob throws, offload reports it as failed)", () => assertTrue(threw && r4.failed.length === 1 && r4.uploaded.length === 0));
}

{
  const TC = await import("../src/lib/tenderChecklist.js");
  check("Tender checklist: Grady's eleven steps in order, 'Subcontractor quotes received' right after 05, every tick dated, the Dashboard counts it", () => {
    const ns = TC.TENDER_STEPS.map((s) => s.n);
    assert.deepEqual(ns, ["01", "02", "03", "04", "05", "05b", "06", "07", "08", "09", "10", "11"]);
    assert.equal(TC.TENDER_STEPS[5].id, "rfq_received");
    assertTrue(TC.TENDER_STEPS[4].note && TC.TENDER_STEPS[5].note, "05 and 05b ask who");
    assertTrue(/to Grady or the sender/.test(TC.TENDER_STEPS[1].detail) && /priority list/.test(TC.TENDER_STEPS[4].detail), "the pen notes are on the steps");
    assert.equal(TC.KEY_CONTROL_POINTS.length, 3);
    let q = { items: [] };
    let pr = TC.checklistProgress(q);
    assert.deepEqual([pr.done, pr.total, pr.next.id, pr.complete], [0, 12, "receive", false]);
    // a tick is dated today and signed; the date can be moved; an untick keeps the date for a re-tick
    q = { ...q, ...TC.checklistPatch(q, "rfq", { done: true }, "grady", "2026-10-22") };
    assert.deepEqual(q.checklist.rfq, { done: true, at: "2026-10-22", by: "grady" });
    q = { ...q, ...TC.checklistPatch(q, "rfq", { at: "2026-10-20" }) };
    q = { ...q, ...TC.checklistPatch(q, "rfq", { note: "CFA piling — Pile Co; formwork — ABC" }) };
    assert.equal(q.checklist.rfq.at, "2026-10-20");
    q = { ...q, ...TC.checklistPatch(q, "rfq_received", { done: true }, "projects", "2026-10-23") };
    pr = TC.checklistProgress(q);
    assert.deepEqual([pr.done, pr.next.id, pr.last.id], [2, "receive", "rfq_received"]);
    q = { ...q, ...TC.checklistPatch(q, "rfq", { done: false }) };
    assert.deepEqual(q.checklist.rfq, { done: false, at: "2026-10-20", by: "grady", note: "CFA piling — Pile Co; formwork — ABC" });
    assert.deepEqual(TC.checklistPatch(q, "nope", { done: true }), {});
    // the wiring: the header button, the rolled-up panel, the Dashboard chip
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const dash = fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8");
    assertTrue(/useState\(false\); \/\/ the tender workflow checklist/.test(app) && /<TenderChecklistButton quote=\{quote\}/.test(app) && /checklistPatch\(q, id, change, workUser\(portalUser\(\)\)\)/.test(app));
    assertTrue(/checklist: checklistProgress\(quote\)/.test(dash) && /data-testid="dashboard-checklist"/.test(dash));
  });
}

{
  const N = await import("../api/_news.js");
  await checkAsync("Industry updates (api/_news.js): RSS with CDATA, Atom, Google News 'Title - Outlet' and <source>; merge dedupes, ages out, sorts newest first; one dead feed never empties the list", async () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>CCAA</title>
      <item><title><![CDATA[Affordable Homes Need Affordable Materials]]></title><link>https://ccaa.example/a</link><pubDate>Wed, 21 Oct 2026 01:00:00 GMT</pubDate><description><![CDATA[<p>CCAA calls for <b>consistent</b> policy &amp; supply.</p>]]></description></item>
      <item><title>Old news</title><link>https://ccaa.example/old</link><pubDate>Mon, 1 Jan 2026 01:00:00 GMT</pubDate></item>
      </channel></rss>`;
    const gn = `<rss><channel><item><title>VCAT clears building surveyor in cladding action - Lander &amp; Rogers</title><link>https://news.google.com/rss/articles/x?oc=5</link><pubDate>Fri, 16 Oct 2026 06:04:38 GMT</pubDate><description>&lt;a href="x"&gt;VCAT clears building surveyor in cladding action&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Lander &amp; Rogers&lt;/font&gt;</description><source url="https://landers.com.au">Lander &amp; Rogers</source></item>
      <item><title>VCAT clears building surveyor in cladding action - The Age</title><link>https://news.google.com/rss/articles/y?oc=5</link><pubDate>Fri, 16 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>NCC 2025 adoption dates</title><link href="https://abcb.example/ncc"/><updated>2026-10-20T03:00:00Z</updated><summary>States adopt the 2025 edition from May 2027.</summary></entry></feed>`;
    const a = N.parseFeed(rss), b = N.parseFeed(gn), c = N.parseFeed(atom);
    assert.deepEqual([a.length, a[0].title, a[0].snippet, a[0].at], [2, "Affordable Homes Need Affordable Materials", "CCAA calls for consistent policy & supply.", "2026-10-21T01:00:00.000Z"]);
    assert.deepEqual([b[0].title, b[0].outlet, b[1].title, b[1].outlet], ["VCAT clears building surveyor in cladding action", "Lander & Rogers", "VCAT clears building surveyor in cladding action", "The Age"], "the outlet is split off a Google News title, from <source> when present");
    assert.deepEqual([c[0].title, c[0].link, c[0].at, c[0].snippet], ["NCC 2025 adoption dates", "https://abcb.example/ncc", "2026-10-20T03:00:00.000Z", "States adopt the 2025 edition from May 2027."]);
    const now = new Date("2026-10-23T00:00:00Z");
    const merged = N.mergeNews([{ source: { id: "ccaa", label: "CCAA" }, items: a }, { source: { id: "vba", label: "VBA / BPC" }, items: b }, { source: { id: "ncc", label: "NCC / ABCB" }, items: c }], { now, maxAgeDays: 120 });
    assert.deepEqual(merged.map((m) => m.source + ":" + m.at.slice(0, 10)), ["ccaa:2026-10-21", "ncc:2026-10-20", "vba:2026-10-16"], "newest first, the duplicate VCAT story once, the January item aged out");
    assert.equal(merged[2].sourceLabel, "VBA / BPC"); assert.equal(merged[2].outlet, "Lander & Rogers");
    assert.equal(N.mergeNews([{ source: { id: "x", label: "x" }, items: a }], { now, maxItems: 1 }).length, 1);
    // fetchNews: a failing source is reported, the rest stand; the real source list names the VBA, the NCC, standards, business, WorkSafe and CCAA
    const fake = async (url) => url.includes("ccaa") ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => (url.includes("Victorian") ? gn : atom) };
    const r = await N.fetchNews(N.NEWS_SOURCES, fake, { now });
    const bySrc = Object.fromEntries(r.sources.map((s) => [s.id, s]));
    assert.deepEqual([bySrc.ccaa.ok, bySrc.ccaa.error, bySrc.vba.ok, bySrc.vba.count, bySrc.ncc.ok], [false, "HTTP 503", true, 2, true]);
    assert.ok(r.items.length >= 2 && r.items.every((i) => i.title && i.link && i.sourceLabel), "items carry title, link and source");
    assert.deepEqual(N.NEWS_SOURCES.map((s) => s.id), ["vba", "ncc", "spec", "business", "worksafe", "ccaa"]);
    assert.ok(N.NEWS_SOURCES.every((s) => /^https:\/\/(news\.google\.com\/rss\/search\?q=|www\.ccaa\.com\.au\/feed)/.test(s.url)), "every source is a real feed URL");
    const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
    assert.ok(/id="welcome-news"/.test(shell) && /fetch\('\/api\/industry-news'/.test(shell) && /paintIndustryNews\(false\);/.test(shell) && /animation:welcome-marquee/.test(shell) && /function excitedLine\(f, now\)/.test(shell), "the shell carries the rail, the fetch, the marquee and the slot pick");
    const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.equal(vercel.functions["api/industry-news.js"].maxDuration, 30);
  });
}

await checkAsync("Duplicate a project (lib/projectDuplicate.js; Boma, 17 Nov 2026): the copy keeps the WORK and drops the record of what happened to the original; an open source keeps its status and kept rates, a finished one becomes open work at today's rates with the crew prefill off; the name is unique; the row is written before the index entry", async () => {
  const D = await import("../src/lib/projectDuplicate.js");
  const H = await import("../src/lib/handover.js");
  // names
  assert.equal(D.copyName("9 Fairfax Street, Blairgowrie VIC 3942"), "9 Fairfax Street, Blairgowrie VIC 3942 (copy)");
  assert.equal(D.copyName("Shed (copy)", ["Shed", "Shed (copy)"]), "Shed (copy 2)", "never '(copy) (copy)', never a name already taken");
  assert.equal(D.copyName("Shed (copy 2)", ["shed (COPY)", "Shed (copy 2)"]), "Shed (copy 3)"); assert.equal(D.copyName(""), "Untitled project (copy)");
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings") || ELEMENT_TYPES.find((t) => /strip/i.test(t.name));
  const el = { ...newElementItem(type), id: "e1", label: "Strip footings", packageId: "pk1", done: { by: "grady", at: "2026-11-01T00:00:00Z" }, markups: [{ id: "m1", name: "S01.png", path: "quote-markups/src/m1.png" }], rowMargins: { k: 0.08 } };
  const concreteKey = Object.keys(defaultRates()).find((k) => /^CONCRETE::.*32/.test(k)); el.qtys = { ...el.qtys, [concreteKey]: 12 };
  const base = { projectName: "9 Fairfax Street, Blairgowrie VIC 3942", clientName: "Acme", siteAddress: "9 Fairfax Street, Blairgowrie VIC 3942", projectDate: "2026-10-01", overheadPct: 0.08, contingencyPct: 0.05, marginPct: 0.25, scope: "both", items: [el], packages: [{ id: "pk1", name: "Main works", marginPct: 0.2 }], assumptions: [{ id: "a1", text: "Rock excluded" }], planner: { deadline: "2026-11-27", priority: "High" }, storageFolders: { drive: { id: "f1", name: "9 Fairfax" } }, files: [{ id: "x", provider: "drive", fileId: "d1", name: "A-101.pdf" }], tenderQuote: { items: [{ id: "t1", stage: "ground", lines: [{ id: "l1", elementId: "e1", text: "Strip footings", price: "$1" }] }], elementStages: { e1: "ground" } },
    checklist: { received: { done: true, at: "2026-10-02" } }, rfqs: [{ id: "r1", package: "Formwork" }], notifications: [{ id: "n1", kind: "sms" }], source: { kind: "mail", messageId: "m9" }, clearedNotices: { trail: { sig: "trail" } }, importFlags: ["x"] };
  // an OPEN source: status kept, kept (library) rates travel, the live prefill stays as it was
  const open = { ...base, status: "Estimating", handoverMode: "live", handoverLive: false, ratesFrozen: { at: "2026-10-05", reason: "library", rates: { [concreteKey]: { unitCost: 300 } } }, ratesAck: { at: "2026-10-05" } };
  const before = JSON.stringify(open);
  const a = D.duplicateQuote(open, { existingNames: [open.projectName], today: "2026-11-17", defaultStatus: "Queued", by: "boma", sourceId: "src", at: "2026-11-17T01:00:00.000Z" });
  assert.equal(JSON.stringify(open), before, "the source is never mutated");
  assert.equal(a.name, "9 Fairfax Street, Blairgowrie VIC 3942 (copy)"); assert.equal(a.quote.projectName, a.name); assert.equal(a.quote.nameReviewedFor, a.name, "the address review never asks about the copy's name");
  assert.equal(a.quote.status, "Estimating"); assert.equal(a.repriced, false); assert.equal(a.prefillOff, false); assert.equal(a.quote.handoverMode, "live");
  assert.deepEqual(a.quote.ratesFrozen, open.ratesFrozen, "figures the project KEPT against the library travel with the copy"); assert.deepEqual(a.quote.ratesAck, open.ratesAck);
  assert.deepEqual(a.quote.items, open.items, "every element exactly as it stands — ids, quantities, drawings, done ticks, row margins");
  for (const k of ["packages", "assumptions", "planner", "storageFolders", "files", "tenderQuote", "clientName", "siteAddress", "overheadPct", "contingencyPct", "marginPct", "scope"]) assert.deepEqual(a.quote[k], open[k], k + " is carried");
  for (const k of D.COPY_DROPS.filter((x) => x !== "copiedFrom")) assert.ok(!(k in a.quote), k + " is not carried onto a copy");
  assert.equal(a.quote.projectDate, "2026-11-17"); assert.deepEqual(a.quote.copiedFrom, { projectId: "src", name: open.projectName, status: "Estimating", at: "2026-11-17T01:00:00.000Z", by: "boma" });
  a.quote.items[0].label = "changed"; assert.equal(open.items[0].label, "Strip footings", "the copy shares no object with the source");
  // a SUBMITTED source with a status pin: open work at today's rates, the prefill off, the day it went out not carried
  const pinnedRates = { ...defaultRates(), [concreteKey]: { ...defaultRates()[concreteKey], unitCost: 111 } };
  const sent = { ...base, status: "Submitted", submittedAt: "2026-10-20", completedAt: "2026-10-18", handoverMode: "live", handoverLive: false, handover: { at: "2026-10-18", cells: [], rules: 1 }, ratesFrozen: { at: "2026-10-18", status: "Completed Estimating", rates: pinnedRates } };
  const b = D.duplicateQuote(sent, { existingNames: [], today: "2026-11-17", defaultStatus: "Queued" });
  assert.equal(b.quote.status, "Queued"); assert.equal(b.quote.ratesFrozen, null); assert.equal(b.repriced, true); assert.ok(!("submittedAt" in b.quote) && !("completedAt" in b.quote));
  assert.equal(b.prefillOff, true); assert.equal(b.quote.handoverMode, "off"); assert.equal(H.liveHandoverApplies(b.quote), false, "opening the copy never fills a crew cell on its own");
  assert.deepEqual(b.quote.handover, sent.handover, "the prefill record travels, so tinted cells stay tinted");
  const live = defaultRates();
  assert.equal(computeGrandTotal(b.quote.items, live), computeGrandTotal(sent.items, live), "the copy at today's rates = the original's elements at today's rates");
  assert.notEqual(computeGrandTotal(sent.items, pinnedRates), computeGrandTotal(b.quote.items, live), "…which is not the pinned figure — hence 'repriced'");
  // a status renamed since (Measuring), an unknown / missing status, On Hold kept, nothing to copy
  assert.equal(D.duplicateQuote({ ...base, status: "Measuring" }, {}).quote.status, "Taking Off"); assert.equal(D.duplicateQuote({ ...base, status: "" }, { defaultStatus: "Estimating" }).quote.status, "Estimating");
  const hold = D.duplicateQuote({ ...base, status: "On Hold" }, {}); assert.equal(hold.quote.status, "On Hold"); assert.equal(hold.prefillOff, true, "the prefill was not running on a held project");
  assert.equal(D.duplicateQuote(null), null);
  // wiring: the full row is read, the copy's row is confirmed before the index entry, the Dashboard carries the button and the band
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"); const dash = fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8"); const proj = fs.readFileSync(new URL("../src/lib/projects.js", import.meta.url), "utf8"); const hb = fs.readFileSync(new URL("../src/components/HandoverBanner.jsx", import.meta.url), "utf8");
  const dup = app.slice(app.indexOf("const duplicateProject = async"), app.indexOf("const deleteProject ="));
  assert.ok(/await readQuote\(target\.storageKey\)/.test(dup) && /if \(!source\) return \{ ok: false/.test(dup) && dup.indexOf("await writeQuoteChecked(") < dup.indexOf("setProjects(") && /if \(!landed\) return \{ ok: false/.test(dup), "read in full; an unread source or an unsaved copy adds nothing");
  assert.ok(/export async function writeQuoteChecked/.test(proj) && /onDuplicate=\{duplicateProject\}/.test(app));
  assert.ok(/data-testid="project-duplicate"/.test(dash) && /data-testid="project-duplicated"/.test(dash) && /project-duplicated-open/.test(dash) && /onDuplicate\(id, names\)/.test(dash));
  assert.ok(/copyOff/.test(hb) && /handover-copy-off/.test(hb), "the handover band shows on a copy whose prefill was switched off, so it can be turned on");
  // opening a project must not rewrite it: the old-rows swap never runs on an element already on the current crew sheet (its row names match the old-name test)
  const card = fs.readFileSync(new URL("../src/components/ElementCard.jsx", import.meta.url), "utf8");
  const swap = card.slice(card.indexOf("if (item.tasksVer >= CREW_TASKS_VER) return;"), card.indexOf("LABOUR_TEMPLATES.footing.map"));
  assert.ok(swap.length > 0 && /const legacy = item\.tasks\.some/.test(swap), "the crew-sheet version guard sits BEFORE the legacy rows swap");
  assert.ok(catalogAll.GRADY_CREW_TASKS.some((n) => /formwork|setout|blinding|lay poly|cart spoil|backfill|factory/i.test(n)), "…because the current sheet's own names match the old-name test");
});

check("Register (tile 08): the seed, its categories and sides, the piling capability facts (BCS no screw piles, Allstate screw not bored, DMAC bored/CFA/retention with screw unstated), no personal addresses, and the shell / assembler wiring", () => {
  const sandbox = { module: { exports: {} } };
  runInNewContext(fs.readFileSync(new URL("../portal/register-seed.js", import.meta.url), "utf8"), sandbox, { filename: "register-seed.js" });
  const { REGISTER_SEED, REGISTER_CAPABILITIES, REGISTER_TRADE_GROUPS } = sandbox.module.exports;
  assert.ok(REGISTER_SEED && Array.isArray(REGISTER_SEED.orgs) && REGISTER_SEED.orgs.length >= 80, "80+ organisations");
  const CATS = { subcontractor: "supply", supplier: "supply", consultant: "supply", service: "supply", builder: "client", client: "client", other: "other" };
  const ids = new Set();
  for (const o of REGISTER_SEED.orgs) {
    assert.ok(o.id && o.name && !ids.has(o.id), `id and name on ${o.id}`); ids.add(o.id);
    assert.ok(o.category in CATS, `${o.name}: category ${o.category}`); assert.equal(o.side, CATS[o.category], `${o.name}: side follows the category`);
    assert.ok(Array.isArray(o.contacts) && Array.isArray(o.emails) && o.capabilities && typeof o.capabilities === "object", `${o.name}: shape`);
    assert.ok(["A", "B", "C", "D"].includes(o.tier) && o.score >= 0 && o.score <= 100 && o.scoreBasis, `${o.name}: score and basis`);
    for (const c of o.contacts) assert.ok(!c.phone || c.phone.replace(/\D/g, "").length >= 8, `${o.name}: a phone is a number, not a shifted column (${c.phone})`);
  }
  const blob = JSON.stringify(REGISTER_SEED);
  assert.ok(!/fyneboma|alandjoce|ongroundpm/i.test(blob), "the estimators' own addresses and the draft outreach never enter the register");
  const by = (re) => REGISTER_SEED.orgs.find((o) => re.test(o.name));
  const bcs = by(/BCS/), allstate = by(/Allstate/), dmac = by(/DMAC/);
  assert.equal(bcs.capabilities.screw.status, "no"); assert.ok(/do not install/.test(bcs.capabilities.screw.evidence)); assert.equal(bcs.capabilities.bored.status, "yes");
  assert.equal(allstate.capabilities.screw.status, "yes"); assert.equal(allstate.capabilities.bored.status, "no");
  assert.deepEqual([dmac.capabilities.bored.status, dmac.capabilities.cfa.status, dmac.capabilities.retention.status, dmac.capabilities.shotcrete.status, dmac.capabilities.screw.status], ["yes", "yes", "yes", "yes", "unknown"]);
  assert.ok([bcs, allstate, dmac].every((o) => o.tradeGroup === "piling" && o.category === "subcontractor"));
  assert.ok(REGISTER_CAPABILITIES.map((c) => c.key).includes("screw") && REGISTER_TRADE_GROUPS.some((g) => g.key === "piling"));
  // the clients are kept apart from the supply chain
  assert.ok(by(/Long Contracting/).side === "client" && by(/TSW Group/).category === "builder" && by(/Holcim/).category === "supplier" && by(/Philip Kulpa/).category === "client");
  // the page, the shell and the assembler
  const page = fs.readFileSync(new URL("../portal/register.html", import.meta.url), "utf8");
  assert.ok(/<script src="register-seed\.js"><\/script>/.test(page) && /const KEY = "gradcon-register"/.test(page) && /function mergeStates/.test(page) && /action: "list"/.test(page), "the page loads the seed, keys the cloud row and merges per organisation");
  assert.ok(!/action: "(reply|trash|delete|modify)"/.test(page) && /if \(!st \|\| !st\.approved\) return;/.test(page), "the page's one mailbox write is a send, and only of a draft the person approved");
  const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  assert.ok(/id="register-app-b64"/.test(shell) && /data-target="register"/.test(shell) && /data-menu="register"/.test(shell) && /register:\s*\{ target:'register'/.test(shell) && /<option value="register">Register<\/option>/.test(shell) && /key=eq\.gradcon-register/.test(shell), "payload, tile, menu, route, Settings option and chat read");
  const asm = fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8");
  assert.ok(/__REGISTER_B64__/.test(asm) && /register-seed\.js/.test(asm), "the assembler inlines the seed and the payload");
  // the per-organisation merge, run from the page's own source
  const fn = /function blankState\(\)[\s\S]*?\nfunction mergeStates[\s\S]*?\n\}\n/.exec(page); assert.ok(fn, "mergeStates found in register.html");
  const sb = { userKey: () => "t", nowIso: () => "2026-10-23T00:00:00.000Z" };
  runInNewContext(fn[0].replace(/function seedState[\s\S]*?\n(?=function normalize)/, "").replace(/function normalize[\s\S]*?\n\}\n/, "") + "\nglobalThis.mergeStates = mergeStates;", sb);
  const a = { orgs: [{ id: "x", name: "X old", updatedAt: "2026-10-01" }, { id: "y", name: "Y", updatedAt: "2026-10-02" }], tombstones: [], log: [{ at: "1", text: "a" }], updatedAt: "2026-10-02" };
  const b = { orgs: [{ id: "x", name: "X new", updatedAt: "2026-10-05" }, { id: "z", name: "Z", updatedAt: "2026-10-03" }], tombstones: [{ id: "y", at: "2026-10-04" }], log: [{ at: "1", text: "a" }, { at: "2", text: "b" }], updatedAt: "2026-10-05" };
  const m = sb.mergeStates(a, b);
  assert.equal(JSON.stringify(Array.from(m.orgs, (o) => o.id + ":" + o.name).sort()), JSON.stringify(["x:X new", "z:Z"]), "newer copy of each organisation wins; a newer tombstone removes (compared as JSON — the array comes from another realm)");
  assert.equal(m.log.length, 2, "the log is the union");
});

await checkAsync("RFQ (src/lib/rfq.js, api/gmail.js send): one draft per contractor with its own contact, the industry subject, the project and takeoff facts in the body, auto-attach classes, ONE recipient per message, the send scope and the 409 before a reconnect", async () => {
  const R = await import("../src/lib/rfq.js");
  const G = await import("../api/_google.js"); const GM = await import("../api/gmail.js");
  const dmac = { id: "org-dmac", name: "DMAC Contracting", category: "subcontractor", tradeGroup: "piling", trade: "Bored piers, CFA", score: 95, capabilities: { bored: { status: "yes" }, screw: { status: "unknown" } }, contacts: [{ id: "c1", name: "Trevor Carr", email: "trevor@dmacpiling.com.au", primary: true }], emails: ["trevor@dmacpiling.com.au"] };
  const bcs = { id: "org-bcs", name: "BCS Piling", category: "subcontractor", tradeGroup: "piling", trade: "Bored piers", score: 89, capabilities: { bored: { status: "yes" }, screw: { status: "no" } }, contacts: [{ id: "c2", name: "Will Bean", email: "will_bean@basementconstruction.com.au", primary: true }], emails: [] };
  const allstate = { id: "org-all", name: "Allstate Screw Piling", category: "subcontractor", tradeGroup: "piling", trade: "Screw piles", score: 83, capabilities: { screw: { status: "yes" }, bored: { status: "no" } }, contacts: [{ id: "c3", name: "Dean Johnson", email: "estimating@allstatesp.com.au", primary: true }], emails: [] };
  const holcim = { id: "org-h", name: "Holcim", category: "supplier", tradeGroup: "premix", trade: "Premixed concrete", score: 76, capabilities: {}, contacts: [], emails: ["frank@holcim.com"] };
  const g = R.contractorsFor([dmac, bcs, allstate, holcim], "bored");
  assert.deepEqual([g.does.map((o) => o.id), g.unknown.map((o) => o.id), g.not.map((o) => o.id)], [["org-dmac", "org-bcs"], [], ["org-all"]], "bored piers: DMAC and BCS do it (score order), Allstate said no, a concrete supplier is not in the trade");
  assert.deepEqual(R.contractorsFor([dmac, bcs, allstate], "screw").does.map((o) => o.id), ["org-all"]);
  const item = { ...newElementItem(ELEMENT_TYPES.find((t) => t.id === "piles_bored")), id: "e1", label: "Bored piers to boundary", qtys: { "SUB CONTRACTORS / TEMPORARY WORKS::Bored Piers (subcontract)::quote": 1 }, measureNo: 12, description: "450 dia, 6 m, socketed 1 m into rock" };
  assert.deepEqual(R.suggestPackages([item], () => "Piles - Bored Piers"), ["bored"], "the row and the type name both say bored piers");
  const takeoff = [{ label: "Bored piers to boundary", typeKey: "pier", data: { dia: 450, depth: 6000, qty: 12 }, results: { lines: [{ materialGroup: "Concrete", material: "N32", finalQty: 9.54, unit: "m³" }] } }];
  const scope = R.elementScope(item, defaultRates(), "both", "Piles - Bored Piers", takeoff);
  assert.ok(scope.measures.includes("12 no.") && scope.items[0] === "Bored Piers (subcontract)" && scope.takeoff.length === 1 && scope.takeoff[0].fields.dia === 450, JSON.stringify(scope));
  const drafts = R.rfqDrafts({ orgs: [dmac, bcs], projectName: "11 Skelton Place, Sorrento VIC 3943", pkgLabel: "Bored Pier Works", pkgKey: "bored", showQuantities: true, scopes: [scope], due: "2026-10-30", leadDays: 7, requestedOn: "2026-10-23", sender: { name: "Grady Fink" }, attachments: [{ name: "S-01.pdf", tags: ["struct"] }, { name: "Geotech.pdf", tags: ["soil"] }] });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].subject, "RFQ – Bored Pier Works – 11 Skelton Place, Sorrento VIC 3943", "industry subject form");
  assert.ok(drafts[0].email === "trevor@dmacpiling.com.au" && drafts[0].text.startsWith("Dear Trevor,") && /invites DMAC Contracting/.test(drafts[0].text) && !/Will|BCS/.test(drafts[0].text), "DMAC's draft carries only DMAC");
  assert.ok(drafts[1].email === "will_bean@basementconstruction.com.au" && drafts[1].text.startsWith("Dear Will,") && !/Trevor|DMAC/.test(drafts[1].text), "BCS's draft carries only BCS");
  assert.ok(/Project: 11 Skelton Place, Sorrento VIC 3943/.test(drafts[0].text) && !/Builder \/ client/.test(drafts[0].text) && /Request issued: Friday 23 October 2026/.test(drafts[0].text) && /Bored piers to boundary \(Piles - Bored Piers\) — 12 no\./.test(drafts[0].text) && /As taken off \(pier\): depth 6000, diameter 450, number 12/.test(drafts[0].text) && /Concrete: N32 — 9\.54 m³/.test(drafts[0].text) && /450 dia, 6 m, socketed/.test(drafts[0].text) && /Friday 30 October 2026, 5:00 pm \(7 days from this request\)/.test(drafts[0].text) && /If you can submit sooner, please do\. If that date cannot be met, please reply with the date you can submit by\./.test(drafts[0].text) && /- S-01\.pdf \(structural drawings\)/.test(drafts[0].text) && /- Geotech\.pdf \(soil \/ geotechnical report\)/.test(drafts[0].text) && !/available on request/.test(drafts[0].text) && /ex GST/.test(drafts[0].text), drafts[0].text);
  assert.ok(/No documents are attached to this email — they will follow separately\./.test(R.rfqText({ projectName: "x", pkgLabel: "Formwork", org: dmac, contact: R.rfqContact(dmac) })), "no attachments is said plainly, never 'available on request'");
  assert.deepEqual([R.RFQ_LEAD.simple.days, R.RFQ_LEAD.complex.days], [3, 7]);
  assert.ok(drafts[0].text !== drafts[1].text && drafts.every((d) => d.approved === false), "built unapproved, independent texts");
  // 26 Oct 2026 — the name mix-up: the greeting + invitation HEAD is per contractor and the BODY is common; a draft naming another contractor is caught
  assert.ok(drafts[0].head.startsWith("Dear Trevor,") && /invites DMAC Contracting/.test(drafts[0].head) && !/Project:/.test(drafts[0].head) && drafts[0].body.startsWith("Project: ") && drafts[0].body === drafts[1].body && drafts[0].text === R.joinDraft(drafts[0].head, drafts[0].body), "head = greeting + invitation (per contractor); body = the rest, identical across the round");
  const mixed = { ...drafts[0], body: drafts[1].body, text: R.joinDraft(drafts[0].head, drafts[1].body) };
  assert.deepEqual(R.draftNameIssues(mixed, drafts), [], "the common body itself names nobody — swapping bodies is harmless");
  const pasted = { ...drafts[0], body: "Gradcon Concrete Constructions invites BCS Piling / Basement Construction to submit a quotation.\n" + drafts[0].body };
  const hit = R.draftNameIssues(pasted, drafts);
  assert.ok(hit.length === 1 && hit[0].orgId === drafts[1].orgId && /bcs piling/.test(hit[0].found), "Trevor's draft carrying 'invites BCS Piling' is flagged against BCS: " + JSON.stringify(hit));
  assert.ok(R.draftNameIssues({ ...drafts[1], body: "Please copy will_bean@basementconstruction.com.au — as discussed with Will Bean" }, drafts).length === 0, "a draft's OWN contractor is never a hit");
  assert.ok(R.draftNameIssues({ ...drafts[1], subject: "RFQ – as per trevor@dmacpiling.com.au" }, drafts).length === 1 && R.draftNameIssues({ ...drafts[1], body: "dmacpiling.com.au" }, drafts).length === 1 && R.draftNameIssues({ ...drafts[1], body: "Trevor Carr said" }, drafts).length === 1, "subject, email, domain and contact name are all searched");
  // the register's generic inboxes are never greeted by name
  assert.equal(R.rfqContact({ contacts: [{ name: "Estimating Team", email: "est@x.com", primary: true }] }).firstName, "", "a team inbox gets no first name");
  // auto-attach classes
  const files = [{ id: "a", name: "A-101 Architectural Plans.pdf", kind: "pdf" }, { id: "s", name: "S01 Structural.pdf", kind: "pdf" }, { id: "g", name: "Geotechnical Site Investigation.pdf", kind: "pdf", folderName: "Reports" }, { id: "p", name: "Pile layout.pdf", kind: "pdf" }, { id: "x", name: "Energy rating.pdf", kind: "pdf" }, { id: "f", name: "Reports", kind: "folder" }];
  const opts = R.driveFolderOptions(files, "bored");
  assert.deepEqual(opts.map((o) => [o.name.split(" ")[0], o.auto, o.tags.join(",")]), [["A-101", true, "archi"], ["Geotechnical", true, "soil"], ["Pile", true, "pkg"], ["S01", true, "struct"], ["Energy", false, ""]], "archi / struct / soil always, the package's own words too, folders never");
  assert.deepEqual(R.missingAttachClasses(opts, new Set(["drive:a", "drive:s"])).map((c) => c.key), ["soil"], "an unticked soil report is reported missing");
  assert.deepEqual(R.ATTACH_CLASSES.filter((c) => c.required).map((c) => c.key), ["archi", "struct", "soil"]);
  { // A contractor's OWN copies (Trevor, DMAC, 17 Nov 2026: "add the following emails on your end for when you send us RFQs"): ticked "RFQ copy" on the Register, cc'd on THAT contractor's RFQ only
    assert.deepEqual(drafts.map((d) => d.cc), [[], []], "no contact ticked → no contractor copies");
    const dmacFull = { ...dmac, id: "org-dmac-contracting", contacts: [{ id: "c1", name: "Trevor Carr", email: "trevor@dmacpiling.com.au", primary: true }, { id: "c4", name: "Estimating Team", email: "estimating@dmacpiling.com.au" }, { id: "c5", name: "Danny McChesney", email: "Danny@dmacpiling.com.au" }, { id: "c6", name: "Kale", email: "kale@dmacpiling.com.au" }] };
    const reg = { orgs: [dmacFull, bcs] };
    const moved = R.applyStandingRfqCopies(reg);
    assert.deepEqual(R.rfqCopies(moved[0]), ["estimating@dmacpiling.com.au", "danny@dmacpiling.com.au"], "the two addresses Trevor asked for — Kale is not copied, Trevor is the To");
    assert.deepEqual(R.rfqCopies(moved[1]), []); assert.equal(moved[1], bcs, "an organisation with no standing request is the stored object, untouched");
    assert.ok(!dmacFull.contacts.some((c) => c.rfqCc), "the stored register is never mutated by the reader");
    assert.equal(R.applyStandingRfqCopies({ orgs: [dmacFull], rfqStandingVersion: R.RFQ_STANDING_VER })[0], dmacFull, "once the Register page has moved the row, its ticks govern — an unticked copy stays unticked");
    const byDomain = R.applyStandingRfqCopies({ orgs: [{ ...dmac, id: "org-renamed", contacts: [{ id: "c1", name: "Trevor Carr", email: "trevor@dmacpiling.com.au", primary: true }] }] });
    assert.deepEqual(R.rfqCopies(byDomain[0]), ["danny@dmacpiling.com.au", "estimating@dmacpiling.com.au"], "found by its mail domain when the id differs; a missing contact is added");
    assert.deepEqual(R.rfqCopies({ contacts: [{ email: "a@x.com", primary: true, rfqCc: true }, { email: "b@x.com", rfqCc: true }, { email: "B@x.com", rfqCc: true }, { email: "nope", rfqCc: true }, { email: "c@x.com" }] }), ["b@x.com"], "never the To address, once each, valid addresses only, ticked only");
    const round = R.rfqDrafts({ orgs: [moved[0], bcs], projectName: "11 Skelton Place, Sorrento VIC 3943", pkgLabel: "Bored Pier Works", scopes: [scope], due: "2026-10-30", leadDays: 7, requestedOn: "2026-10-23", sender: { name: "Boma" }, attachments: [] });
    assert.deepEqual(round[0].cc, ["estimating@dmacpiling.com.au", "danny@dmacpiling.com.au"]); assert.deepEqual(round[1].cc, [], "BCS's draft carries none of DMAC's addresses");
    assert.equal(round[0].email, "trevor@dmacpiling.com.au", "the RFQ still goes TO the primary contact");
    assert.deepEqual(R.draftCc(round[0], ["grady@gradcon.com.au", "Danny@dmacpiling.com.au", "trevor@dmacpiling.com.au"]), ["estimating@dmacpiling.com.au", "danny@dmacpiling.com.au", "grady@gradcon.com.au"], "their own copies, then Gradcon's — once each, never the To address");
    assert.deepEqual(R.draftCc(round[1], ["grady@gradcon.com.au"]), ["grady@gradcon.com.au"]);
    assert.ok(!/dmacpiling|danny|trevor/i.test(JSON.stringify(round[1])), "nothing of DMAC anywhere in BCS's draft");
    assert.equal(R.draftNameIssues({ ...round[1], body: "copy danny@dmacpiling.com.au" }, round).length, 1, "a DMAC copy address typed into BCS's text is caught by the name guard");
    assert.equal(R.draftNameIssues({ ...round[0], body: "also to estimating@dmacpiling.com.au" }, round).length, 0, "and is DMAC's own in DMAC's draft");
    const recCc = R.rfqRecord({ pkgKey: "bored", pkgLabel: "Bored Pier Works", elementIds: ["e1"], due: "2026-10-30", by: "boma", sent: [{ ...round[0], status: "sent" }] }, "2026-11-17T00:00:00.000Z");
    assert.deepEqual(recCc.recipients[0].cc, ["estimating@dmacpiling.com.au", "danny@dmacpiling.com.au"], "the round's record keeps who was copied");
    // The composer's per-contractor Cc box (Boma, 17 Nov 2026: "make it a cc like the one to grady and prefill … if others give emails, we would manually input them and the option of saving … should be coded in")
    assert.deepEqual(R.contractorCc(moved[0], "Estimating@dmacpiling.com.au; danny@dmacpiling.com.au, trevor@dmacpiling.com.au  nope kale@dmacpiling.com.au"), ["estimating@dmacpiling.com.au", "danny@dmacpiling.com.au", "kale@dmacpiling.com.au"], "what is typed: valid addresses, once each, never the To address");
    assert.deepEqual(R.contractorCc(bcs, ""), []);
    assert.deepEqual(R.ccConflicts(bcs, ["danny@dmacpiling.com.au", "ops@basementconstruction.com.au", "someone@gmail.com", "x@newfirm.com.au"], [moved[0], bcs, allstate]), [{ email: "danny@dmacpiling.com.au", orgId: "org-dmac-contracting", orgName: "DMAC Contracting" }], "an address on ANOTHER organisation's record or company domain is refused; the contractor's own domain, a free-mail address and an unknown firm are not");
    assert.deepEqual(R.ccConflicts(moved[0], ["danny@dmacpiling.com.au"], [moved[0], bcs]), [], "its own people are never a conflict");
    const set1 = R.setRfqCopies(bcs, ["ops@basementconstruction.com.au", "Will_Bean@basementconstruction.com.au"]);
    assert.ok(set1.changed && set1.added.join() === "ops@basementconstruction.com.au" && set1.on.join() === "ops@basementconstruction.com.au" && set1.off.length === 0);
    assert.deepEqual(R.rfqCopies(set1.org), ["ops@basementconstruction.com.au"], "saved: a new contact is added and ticked; the To address is never a copy"); assert.ok(!bcs.contacts.some((c) => c.rfqCc) && bcs.contacts.length === 1, "the organisation passed in is not mutated");
    assert.ok(set1.org.contacts.find((c) => c.email === "ops@basementconstruction.com.au").name === "Ops" && set1.org.emails.includes("ops@basementconstruction.com.au"));
    const set2 = R.setRfqCopies(moved[0], ["estimating@dmacpiling.com.au"]);
    assert.deepEqual([set2.on, set2.off, R.rfqCopies(set2.org)], [[], ["danny@dmacpiling.com.au"], ["estimating@dmacpiling.com.au"]], "an address left out of the box is unticked");
    assert.equal(R.setRfqCopies(moved[0], ["danny@dmacpiling.com.au", "ESTIMATING@dmacpiling.com.au"]).changed, false, "the same list in another order and case changes nothing");
    assert.equal(R.ccDiffersFromRegister(moved[0], ["danny@dmacpiling.com.au", "estimating@dmacpiling.com.au"]), false); assert.equal(R.ccDiffersFromRegister(moved[0], ["estimating@dmacpiling.com.au"]), true); assert.equal(R.ccDiffersFromRegister(bcs, []), false);
    const typedRound = R.rfqDrafts({ orgs: [moved[0], bcs], projectName: "11 Skelton Place, Sorrento VIC 3943", pkgLabel: "Bored Pier Works", scopes: [scope], due: "2026-10-30", leadDays: 7, requestedOn: "2026-10-23", sender: { name: "Boma" }, attachments: [], ccByOrg: { "org-dmac-contracting": ["estimating@dmacpiling.com.au"], "org-bcs": ["Ops@basementconstruction.com.au", "will_bean@basementconstruction.com.au", "bad"] } });
    assert.deepEqual(typedRound.map((d) => d.cc), [["estimating@dmacpiling.com.au"], ["ops@basementconstruction.com.au"]], "the drafts carry what the composer's boxes hold, not the Register's list");
    { // "Save to Register" (registerStore.saveRfqCopies) on a fake cloud: the standing copies are applied first on a row the Register page has not moved, the change is logged, touched organisations get a new stamp
      const RS = await import("../src/lib/registerStore.js");
      const row = { value: { version: 1, orgs: [JSON.parse(JSON.stringify(dmacFull)), JSON.parse(JSON.stringify(bcs))], tombstones: [], log: [] } }; const writes = [];
      const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: JSON.parse(JSON.stringify(row.value)) }, error: null }) }) }), upsert: async (r) => { writes.push(r); row.value = JSON.parse(JSON.stringify(r.value)); return { error: null }; } }) };
      const g0 = globalThis.localStorage; globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); } };
      try {
        const saved = await RS.saveRfqCopies("org-bcs", ["ops@basementconstruction.com.au"], "boma", { client, enabled: true, now: new Date("2026-11-17T02:00:00.000Z") });
        assert.ok(saved && saved.saved === true && writes.length === 1 && writes[0].key === "gradcon-register");
        const sb = row.value.orgs.find((o) => o.id === "org-bcs"), sd = row.value.orgs.find((o) => o.id === "org-dmac-contracting");
        assert.deepEqual(R.rfqCopies(sb), ["ops@basementconstruction.com.au"]); assert.equal(sb.updatedAt, "2026-11-17T02:00:00.000Z"); assert.equal(sb.updatedBy, "boma");
        assert.deepEqual([...R.rfqCopies(sd)].sort(), ["danny@dmacpiling.com.au", "estimating@dmacpiling.com.au"], "DMAC's standing copies were applied in the same write"); assert.equal(sd.updatedAt, "2026-11-17T02:00:00.000Z", "…with a new stamp, so the Register page's merge keeps them"); assert.equal(row.value.rfqStandingVersion, R.RFQ_STANDING_VER);
        assert.ok(row.value.log.some((l) => /RFQ copy ticked for ops@basementconstruction\.com\.au — saved from the RFQ composer/.test(l.text) && l.by === "boma"));
        const again = await RS.saveRfqCopies("org-dmac-contracting", ["estimating@dmacpiling.com.au"], "boma", { client, enabled: true, now: new Date("2026-11-17T03:00:00.000Z") });
        assert.deepEqual(R.rfqCopies(again.orgs.find((o) => o.id === "org-dmac-contracting")), ["estimating@dmacpiling.com.au"], "unticking Danny from the composer sticks — the standing move is not run again");
        assert.equal(await RS.saveRfqCopies("org-nope", ["a@b.co"], "boma", { client, enabled: true }), null, "an organisation not on the Register saves nothing"); assert.equal(writes.length, 2);
        const failing = { from: () => ({ select: client.from().select, upsert: async () => ({ error: { message: "down" } }) }) };
        assert.equal((await RS.saveRfqCopies("org-bcs", [], "boma", { client: failing, enabled: true })).saved, false, "a cloud write that did not land says so");
      } finally { globalThis.localStorage = g0; }
    }
    { const modalSrc0 = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
      assert.ok(/rfq-org-cc-input-/.test(modalSrc0) && /rfq-org-cc-save-/.test(modalSrc0) && /rfq-org-cc-conflict-/.test(modalSrc0) && /ccByOrg: Object\.fromEntries\(pickedOrgs\.map/.test(modalSrc0) && /saveRfqCopies\(o\.id, list/.test(modalSrc0), "the composer carries the Cc box, the conflict line, the Save button and feeds the boxes into the drafts");
      assert.ok(!/<OrgRow /.test(modalSrc0) && /const orgRow = \(o, tag, pkgKey\)/.test(modalSrc0), "the contractor row is a plain function — a component defined inside the modal would remount the Cc box on every keystroke"); }
    // the Register page: the same list (a mirror), the one-off move, the tick and its handler; the composer reads through the ONE functions
    const regSrc = fs.readFileSync(new URL("../portal/register.html", import.meta.url), "utf8");
    { // the page's script must PARSE (17 Nov 2026: an apostrophe inside a single-quoted string stopped the whole Register loading; only a browser run showed it)
      const vm = await import("node:vm"); const body = [...regSrc.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
      assert.doesNotThrow(() => new vm.Script(body, { filename: "register.html" }), "portal/register.html's script parses");
    }
    const mirror = regSrc.match(/const RFQ_STANDING_COPIES = (\[[\s\S]*?\]);\n/); assert.ok(mirror, "register.html carries the list");
    assert.deepEqual(new Function("return " + mirror[1])(), R.RFQ_STANDING_COPIES, "register.html's standing RFQ copies mirror src/lib/rfq.js");
    assert.ok(new RegExp("const RFQ_STANDING_VER = " + R.RFQ_STANDING_VER + ";").test(regSrc) && /function applyStandingRfqCopies\(state\)/.test(regSrc) && /applyStandingRfqCopies\(STATE\)/.test(regSrc) && /out\.rfqStandingVersion = Math\.max/.test(regSrc) && /data-rfqcc=/.test(regSrc) && /t\.dataset\.rfqcc != null/.test(regSrc), "the page moves a stored register once, keeps the version through a merge and carries the RFQ copy tick");
    const modalSrc = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
    assert.ok(/applyStandingRfqCopies\(register\)/.test(modalSrc) && /cc: draftCc\(d, ccList\)/.test(modalSrc) && /rfq-own-cc/.test(modalSrc) && /rfq-org-copies-/.test(modalSrc) && !/cc: ccList \}/.test(modalSrc), "the composer sends each draft's own copies beside Gradcon's and shows them");
    // the real seed: DMAC is there under the id the rule names, with both addresses on record
    const seedSrc = fs.readFileSync(new URL("../portal/register-seed.js", import.meta.url), "utf8"); const seedM = seedSrc.match(/const REGISTER_SEED = (\{[\s\S]*?\});\n/);
    const seedOrgs = R.applyStandingRfqCopies({ orgs: JSON.parse(seedM[1]).orgs });
    const seedDmac = seedOrgs.find((o) => o.id === "org-dmac-contracting");
    assert.deepEqual([...R.rfqCopies(seedDmac)].sort(), ["danny@dmacpiling.com.au", "estimating@dmacpiling.com.au"]); assert.equal(R.rfqContact(seedDmac).email, "trevor@dmacpiling.com.au");
    assert.equal(seedOrgs.filter((o) => R.rfqCopies(o).length).length, 1, "only DMAC carries copies");
  }
  const rec = R.rfqRecord({ pkgKey: "bored", pkgLabel: "Bored Pier Works", elementIds: ["e1"], due: "2026-10-30", by: "grady", sent: [{ ...drafts[0], status: "sent", messageId: "m1", threadId: "t1" }], attachments: [{ name: "S-01.pdf" }] }, "2026-10-23T04:00:00.000Z");
  assert.ok(rec.recipients.length === 1 && rec.recipients[0].email === "trevor@dmacpiling.com.au" && rec.attachments[0] === "S-01.pdf" && R.rfqPatch({ rfqs: [] }, rec).rfqs.length === 1);
  // the send path
  assert.ok(G.consentUrl("https://x/api/google-auth", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }).includes(encodeURIComponent(G.GMAIL_SEND_SCOPE)), "consent asks for gmail.send");
  const genv = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_TOKEN_SECRET: "k" };
  assert.equal(G.connectionStatus({ refresh: "x", scope: G.GMAIL_SCOPE + " " + G.DRIVE_SCOPE }, genv).send, false);
  assert.equal(G.connectionStatus({ refresh: "x", scope: G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE }, genv).send, true);
  const raw = G.buildMime({ to: "trevor@dmacpiling.com.au", toName: "Trevor Carr", from: "projects@gradcon.com.au", fromName: "Grady Fink", subject: "RFQ – Bored Pier Works – 11 Skelton Place", text: "Dear Trevor,\n\nHello.", attachments: [{ name: "S-01.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 x") }] });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(/^From: Grady Fink <projects@gradcon\.com\.au>\r\nTo: Trevor Carr <trevor@dmacpiling\.com\.au>/.test(mime) && !/^(Cc|Bcc):/m.test(mime) && /multipart\/mixed; boundary=/.test(mime) && /Content-Disposition: attachment; filename="S-01\.pdf"/.test(mime) && /=\?UTF-8\?B\?/.test(mime), "one To, no Cc/Bcc, the attachment part, the en-dash subject encoded");
  // Gradcon's own cc (grady@ by default, more addable — 26 Oct 2026): one Cc header, deduplicated, never the recipient, never Bcc
  const ccMime = Buffer.from(G.buildMime({ to: "trevor@dmacpiling.com.au", from: "projects@gradcon.com.au", subject: "x", text: "y", cc: ["grady@gradcon.com.au", "Grady@gradcon.com.au", "boma@gradcon.com.au", "trevor@dmacpiling.com.au", "not an address"] }), "base64url").toString("utf8");
  assert.ok(/^Cc: grady@gradcon\.com\.au, boma@gradcon\.com\.au\r\n/m.test(ccMime) && !/^Bcc:/m.test(ccMime) && (ccMime.match(/^Cc:/gm) || []).length === 1, "Cc: the internal copies once each, the contractor never copied to himself, no Bcc");
  assert.deepEqual(R.DEFAULT_CC, ["grady@gradcon.com.au"]);
  assert.deepEqual(R.parseCc("grady@gradcon.com.au, Boma@Gradcon.com.au; junk  grady@gradcon.com.au"), ["grady@gradcon.com.au", "boma@gradcon.com.au"], "parseCc: commas, semicolons or spaces, lower-cased, deduplicated, junk dropped");
  // attachments are planned against Gmail's limit BEFORE the send: what fits attaches, the rest goes as download links
  const MB = 1024 * 1024;
  const pl = R.planAttachments([{ name: "A.pdf", size: 9 * MB }, { name: "S.pdf", size: 7 * MB }, { name: "G.pdf", size: 12 * MB }, { name: "T.pdf", size: 0.5 * MB }, { name: "U.pdf" }]);
  assert.deepEqual([pl.attach.map((f) => f.name), pl.link.map((f) => f.name), pl.total], [["A.pdf", "S.pdf", "T.pdf"], ["G.pdf", "U.pdf"], 16.5 * MB], "16.5 MB attached under the 17 MB plan; the 12 MB geotech and the unsized file go as links");
  assert.ok(R.ATTACH_PLAN_BYTES < G.ATTACH_MAX_BYTES && G.ATTACH_MAX_BYTES * 4 / 3 < 25 * MB, "plan cap under the server cap, server cap under Gmail's 25 MB encoded limit");
  const linked = R.rfqText({ projectName: "P", pkgLabel: "Bored Pier Works", org: { name: "DMAC" }, contact: { name: "Trevor" }, scopes: [], due: "2026-11-02", leadDays: 7, requestedOn: "2026-10-26", sender: { name: "Boma Ipalibo" }, attachments: [{ name: "A-101 Architectural.pdf", tags: ["archi"] }], links: [{ name: "Geotechnical report.pdf", tags: ["soil"], size: 12 * MB, url: G.ATTACH_URL_PREFIX + "drive/g/v/Geotechnical%20report.pdf" }] });
  assert.ok(/Attached to this email:\n  - A-101 Architectural\.pdf \(architectural drawings\)/.test(linked) && /Too large to attach — download from these links:\n  - Geotechnical report\.pdf \(soil \/ geotechnical report\) \(12\.0 MB\): https:\/\//.test(linked) && !/follow separately/.test(linked), "the body names the attached files and gives a download link for the oversize one");
  assert.equal(R.fmtBytes(2.4 * MB), "2.4 MB");
  assert.ok(G.isOneAddress("a@b.co") && !G.isOneAddress("a@b.co, c@d.co") && !G.isOneAddress("a@b.co; c@d.co"));
  let posted = null;
  const mk = (scope) => ({ email: "projects@gradcon.com.au", refresh: G.encryptText("1//r", genv), scope });
  const fetchFor = (stored) => async (url, init) => { const u = String(url);
    if (/estimator_kv\?key=eq\./.test(u)) return { ok: true, json: async () => [{ value: stored }] };
    if (/oauth2\.googleapis\.com\/token/.test(u)) return { ok: true, json: async () => ({ access_token: "at", expires_in: 3600 }) };
    if (/\/messages\/send/.test(u)) { posted = JSON.parse(init.body); return { ok: true, json: async () => ({ id: "m9", threadId: "t9", labelIds: ["SENT"] }) }; }
    if (/gradcon-files\//.test(u)) return { ok: true, headers: { get: () => "application/pdf" }, arrayBuffer: async () => Buffer.from("%PDF-1.4 y") };
    return { ok: false, status: 404, json: async () => ({}) }; };
  G.resetTokenCache();
  const noScope = await GM.runGmail({ action: "send", to: "trevor@dmacpiling.com.au", subject: "x", text: "y" }, genv, fetchFor(mk(G.GMAIL_SCOPE)));
  assert.ok(noScope.status === 409 && noScope.body.needsReconnect === true && posted === null, "read-only connection: 409 needsReconnect, nothing sent");
  G.resetTokenCache();
  const two = await GM.runGmail({ action: "send", to: "a@b.co, c@d.co", subject: "x", text: "y" }, genv, fetchFor(mk(G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE)));
  assert.equal(two.status, 400, "two addresses are refused — one message per recipient");
  G.resetTokenCache();
  const bad = await GM.runGmail({ action: "send", to: "a@b.co", subject: "x", text: "y", attachments: [{ name: "evil", url: "https://example.com/x.pdf" }] }, genv, fetchFor(mk(G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE)));
  assert.equal(bad.status, 400, "an attachment outside the portal's own bucket is refused");
  G.resetTokenCache();
  const ok = await GM.runGmail({ action: "send", to: "trevor@dmacpiling.com.au", toName: "Trevor Carr", fromName: "Grady Fink", subject: "RFQ – x", text: "Dear Trevor,", attachments: [{ name: "S-01.pdf", url: G.ATTACH_URL_PREFIX + "drive/p1/v/S-01.pdf" }] }, genv, fetchFor(mk(G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE)));
  assert.ok(ok.status === 200 && ok.body.sent.id === "m9" && ok.body.sent.attachments[0] === "S-01.pdf" && posted && /To: Trevor Carr <trevor@dmacpiling\.com\.au>/.test(Buffer.from(posted.raw, "base64url").toString("utf8")), JSON.stringify(ok.body));
  G.resetTokenCache();
  const badCc = await GM.runGmail({ action: "send", to: "a@b.co", subject: "x", text: "y", cc: ["grady@gradcon.com.au", "x@y.co, z@w.co"] }, genv, fetchFor(mk(G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE)));
  assert.equal(badCc.status, 400, "a cc entry holding two addresses is refused");
  G.resetTokenCache();
  const withCc = await GM.runGmail({ action: "send", to: "trevor@dmacpiling.com.au", subject: "RFQ – x", text: "Dear Trevor,", cc: ["grady@gradcon.com.au"] }, genv, fetchFor(mk(G.GMAIL_SCOPE + " " + G.GMAIL_SEND_SCOPE)));
  assert.ok(withCc.status === 200 && withCc.body.sent.cc[0] === "grady@gradcon.com.au" && /^Cc: grady@gradcon\.com\.au\r\n/m.test(Buffer.from(posted.raw, "base64url").toString("utf8")), "the cc rides on the message and is reported back");
  G.resetTokenCache();
});

console.log(`\n${passed} check(s) passed.`);
// ---------------------------------------------------------------------------
// Version history for the chat (src/lib/quoteDiff.js, api/_versions.js, savedBy on every version) — Grady, 11 Oct 2026
// ---------------------------------------------------------------------------
{
  const D = await import("../src/lib/quoteDiff.js");
  const V = await import("../api/_versions.js");
  const C = await import("../api/ai-chat.js");
  const QV = await import("../src/lib/quoteVersions.js");
  const HO = await import("../src/lib/handover.js");
  const rates = defaultRates();
  const strip = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const wall = ELEMENT_TYPES.find((t) => t.category === "VERTICAL STRUCTURE");
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE").products.find((p) => /^40 mpa$/i.test(p.name)) || FULL_CATALOG.find((c) => c.key === "CONCRETE").products[0];
  const ck = rateKey("CONCRETE", conc.name, conc.unit);
  const el = { ...newElementItem(strip), label: "Strip footing A", qtys: { [ck]: 30 } };
  const q1 = { projectName: "Diff probe", clientName: "A", status: "Estimating", scope: "both", assumptions: [{ text: "Stairs excluded" }], items: [el] };
  const q2 = JSON.parse(JSON.stringify(q1));
  q2.status = "Completed Estimating"; q2.clientName = "B"; q2.assumptions.push({ text: "Piers excluded" });
  q2.items[0].qtys[ck] = 44; q2.items[0].label = "Strip footing A rev B"; q2.items[0].tasks[0].qtys.concreter_day = 3; q2.items[0].rateOverrides = { "SUB CONTRACTORS / TEMPORARY WORKS::Steel fix::quote": { unitCost: 1200 } };
  q2.items[0].additional = [{ id: "a1", name: "Certification", qty: 1, rate: 500 }];
  q2.items.unshift({ ...newElementItem(wall), label: "New wall" });
  const d = D.diffQuotes(q1, q2, rates);
  const chg = d.elements.changed[0];
  check("quoteDiff: project fields (status, client, assumption), an added element, and on the changed element the qty, label, crew cell, quote amount and additional row — with $ before and after", () => assertTrue(d.counts.added === 1 && d.elements.added[0].label === "New wall" && d.project.some((p) => p.field === "status" && p.to === "Completed Estimating") && d.project.some((p) => p.field === "clientName" && p.from === "A" && p.to === "B") && d.project.some((p) => p.field === "assumption" && p.to === "Piers excluded") && chg && chg.label === "Strip footing A rev B" && chg.changes.some((c) => c.kind === "qty" && c.product === conc.name && c.from === 30 && c.to === 44) && chg.changes.some((c) => c.kind === "crew" && c.resource === "Concrete Crew" && c.to === 3) && chg.changes.some((c) => c.kind === "rateOverride" && c.product === "Steel fix" && c.to === 1200) && chg.changes.some((c) => c.kind === "additional" && c.name === "Certification") && chg.changes.some((c) => c.kind === "field" && c.field === "label") && chg.totalTo > chg.totalFrom && d.totals.delta > 0 && chg.bands.CONCRETE && chg.bands.CONCRETE.to > chg.bands.CONCRETE.from, JSON.stringify({ counts: d.counts, chg: chg && chg.changes })));
  check("quoteDiff: an element added ABOVE the others is not reported as every other element moving; identical copies diff to nothing", () => assertTrue(!chg.moved && d.elements.changed.length === 1 && D.diffQuotes(q2, JSON.parse(JSON.stringify(q2)), rates).any === false));
  check("quoteDiff: describeDiff reads as one-liners (qty, crew, quote amount, status, direct cost)", () => { const l = D.describeDiff(d).join("\n"); assertTrue(/status: Estimating → Completed Estimating/.test(l) && new RegExp(`qty ${conc.name} \\(CONCRETE\\): 30 → 44`).test(l) && /crew .* Concrete Crew: blank → 3/.test(l) && /quote amount Steel fix: blank → 1200/.test(l) && /direct cost: \$/.test(l), l); });
  const q3 = HO.applyHandover({ ...q2, completedAt: "2026-10-09" }, rates, "2026-10-09T05:00:00Z");
  const drift0 = D.handoverDrift(q3);
  const q4 = JSON.parse(JSON.stringify(q3)); const c0 = q3.handover.cells[0]; const it4 = q4.items.find((i) => i.id === c0.itemId); const t4 = it4.tasks.find((t) => t.id === c0.taskId); t4.qtys[c0.key] = (c0.value || 0) + 5;
  const c1 = q3.handover.cells[1]; const t5 = q4.items.find((i) => i.id === c1.itemId).tasks.find((t) => t.id === c1.taskId); delete t5.qtys[c1.key];
  const drift1 = D.handoverDrift(q4);
  check("quoteDiff: handoverDrift — fresh prefill is all kept; a retyped cell reads changed (prefilled → now), an emptied one cleared; no handover → not prefilled", () => assertTrue(drift0.prefilled && drift0.summary.kept === drift0.entries.length && drift0.summary.kept > 5 && drift1.summary.changed === 1 && drift1.summary.cleared === 1 && drift1.entries.find((e) => e.status === "changed").now === (c0.value || 0) + 5 && drift1.entries.find((e) => e.status === "changed").prefilled === c0.value && D.handoverDrift(q1).prefilled === false, JSON.stringify(drift1.summary)));
  const tk = D.diffTakeoffs({ project: { name: "a" }, instances: [{ id: "1", label: "PF1", typeKey: "padfooting", data: { L: 1200, W: 1200, _x: 1 } }] }, { project: { name: "b" }, instances: [{ id: "1", label: "PF1", typeKey: "padfooting", data: { L: 1500, W: 1200, _x: 2 }, review: { at: "t" } }, { id: "2", label: "C1", typeKey: "column", data: {} }] });
  check("quoteDiff: diffTakeoffs — project name, a data field (L 1200 → 1500), the review stamp and an added element; _-prefixed UI flags ignored", () => assertTrue(tk.project[0].field === "name" && tk.elements.added[0].label === "C1" && tk.elements.changed[0].changes.some((c) => c.field === "L" && c.from === 1200 && c.to === 1500) && tk.elements.changed[0].changes.some((c) => c.field === "reviewedAt") && !tk.elements.changed[0].changes.some((c) => c.field === "_x"), JSON.stringify(tk)));
  const hist = D.historyFromVersions([{ savedAt: "2026-10-09T03:00:00Z", source: "manual", quote: q2 }, { savedAt: "2026-10-09T01:00:00Z", source: "autosave", quote: q1 }, { savedAt: "2026-10-09T02:00:00Z", source: "manual", savedBy: "grady@gradcon.com.au", quote: q1 }], "quote", rates);
  check("quoteDiff: historyFromVersions sorts oldest → newest, counts the unchanged step and keeps who saved each", () => assertTrue(hist.versions === 3 && hist.unchangedSteps === 1 && hist.steps.length === 1 && hist.steps[0].from.savedBy === "grady@gradcon.com.au" && hist.steps[0].to.savedAt === "2026-10-09T03:00:00Z"));
  // the server tools on a mock cloud (both naming schemes, the live row, the rates row, the takeoff index)
  const pid = "p145";
  const store = {
    [`quote-versions/${pid}/20261009T010000000Z-autosave.json`]: { ...QV.buildQuoteFile(pid, q1, "autosave", null), savedAt: "2026-10-09T01:00:00.000Z" },
    [`quote-versions/${pid}/20261009T020000000Z-manual.json`]: { ...QV.buildQuoteFile(pid, q2, "manual", "grady@gradcon.com.au"), savedAt: "2026-10-09T02:00:00.000Z" },
    "estimate-versions/tk1/2026-10-09T01-00-00-000Z-save.json": { format: "gradcon-estimate-version", savedAt: "2026-10-09T01:00:00.000Z", source: "save", savedBy: "projects@gradcon.com.au", snapshot: { project: { name: "Old" }, instances: [{ id: "1", label: "PF1", typeKey: "padfooting", data: { L: 1200 } }] } },
  };
  const kv = { [`gradcon-quote-${pid}`]: { value: q3, updated_at: "2026-10-09T07:00:00Z" }, "gradcon-rates": { value: rates, updated_at: "2026-10-01T00:00:00Z" }, "gradcon-estimate-projects-index": { value: [{ id: "tk1", key: "gradcon-estimate::tk1", name: "Old" }] }, "gradcon-estimate::tk1": { value: { project: { name: "New" }, instances: [{ id: "1", label: "PF1", typeKey: "padfooting", data: { L: 1500 } }] }, updated_at: "2026-10-09T08:00:00Z" } };
  const cloud = { calls: [], async list(prefix) { this.calls.push("list " + prefix); return Object.keys(store).filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1), metadata: { size: JSON.stringify(store[k]).length } })); }, async getJson(path) { this.calls.push("get " + path); if (!store[path]) throw new Error("404"); return store[path]; }, async kvGet(key) { this.calls.push("kv " + key); return kv[key] || null; } };
  await checkAsync("history tools: list_versions reads both naming schemes, stamps savedBy from the documents and reports the live row's time", async () => {
    const l = await V.runHistoryTool("list_versions", { projectId: pid }, { cloud });
    const t = await V.runHistoryTool("list_versions", { projectId: "tk1", kind: "takeoff" }, { cloud });
    assertTrue(l.result.count === 2 && l.result.versions[0].source === "manual" && l.result.versions[0].savedBy === "grady@gradcon.com.au" && l.result.versions[1].savedBy === null && l.result.versions[0].elements === 2 && l.result.liveUpdatedAt === "2026-10-09T07:00:00Z" && l.result.bySource.autosave === 1 && t.result.count === 1 && t.result.versions[0].savedAt === "2026-10-09T01:00:00.000Z" && t.result.versions[0].savedBy === "projects@gradcon.com.au" && t.result.liveUpdatedAt === "2026-10-09T08:00:00Z", JSON.stringify([l.result, t.result]));
  });
  await checkAsync("history tools: compare_versions defaults to the newest version → live (priced on the live rates row), takes oldest/latest/index/date-time/live refs, and diffs a takeoff against its live row", async () => {
    const a = await V.runHistoryTool("compare_versions", { projectId: pid }, { cloud });
    const b = await V.runHistoryTool("compare_versions", { projectId: pid, from: "oldest", to: "1" }, { cloud });
    const c = await V.runHistoryTool("compare_versions", { projectId: pid, from: "2026-10-09T01", to: "latest" }, { cloud });
    const t = await V.runHistoryTool("compare_versions", { projectId: "tk1", kind: "takeoff", from: "1", to: "live" }, { cloud });
    assertTrue(a.result.from.source === "manual" && a.result.to.source === "live" && a.result.diff.project.some((p) => p.field === "handoverPrefilled") && a.result.diff.lines.some((x) => /crew /.test(x)) && b.result.from.source === "autosave" && b.result.to.source === "manual" && b.result.diff.counts.added === 1 && b.result.diff.totals.delta > 0 && c.result.diff.counts.added === 1 && t.result.diff.elements.changed[0].changes[0].field === "L" && t.result.diff.project[0].to === "New" && cloud.calls.includes("kv gradcon-rates"), JSON.stringify([a.result.from, a.result.to, b.result.diff.counts, t.result.diff]));
  });
  await checkAsync("history tools: project_history walks every kept copy then the live row, with who saved each; handover_changes reports the drift off the live row", async () => {
    const h = await V.runHistoryTool("project_history", { projectId: pid }, { cloud });
    const d2 = await V.runHistoryTool("handover_changes", { projectId: pid }, { cloud });
    assertTrue(h.result.versionsWalked === 3 && h.result.liveIncluded && h.result.steps.length === 2 && h.result.steps[0].to.savedBy === "grady@gradcon.com.au" && h.result.steps[1].to.source === "live" && h.result.savedBy["grady@gradcon.com.au"] === 1 && h.result.steps[0].lines.some((x) => /element added: New wall/.test(x)) && d2.result.summary.kept > 5 && d2.result.changed.length === 0 && d2.result.prefilledAt === "2026-10-09T05:00:00Z", JSON.stringify([h.result.steps.map((s) => [s.from.source, s.to.source, s.counts]), d2.summary]));
  });
  let bad = null; try { await V.runHistoryTool("compare_versions", { projectId: "nothing" }, { cloud }); } catch (e) { bad = e; }
  check("history tools: a project with no versions fails with a plain reason (no crash, nothing invented); parseVersionName reads both apps' file names", () => assertTrue(bad && /no versions kept/.test(bad.message) && V.parseVersionName("20261009T042905226Z-autosave.json").savedAt === "2026-10-09T04:29:05.226Z" && V.parseVersionName("2026-10-09T01-00-00-000Z-before-sync.json").source === "before-sync" && V.parseVersionName("x.txt") === null));
  check("chat: the system prompt names the four history tools and forbids 'cannot see who changed what'; runChat offers them on every call (with or without mail)", () => { const sys = C.chatSystem({}); assertTrue(/list_versions/.test(sys) && /compare_versions/.test(sys) && /project_history/.test(sys) && /handover_changes/.test(sys) && /never say you cannot see earlier values/.test(sys) && V.historyTools().length === 4 && V.historyTools().every((t) => t.parameters.required.includes("projectId")) && /historyTools\(\)\)/.test(fs.readFileSync(new URL("../api/ai-chat.js", import.meta.url), "utf8"))); });
  await checkAsync("chat: a history tool call from the model runs through runChat's tool loop (OpenAI shape) and lands in the trace", async () => {
    let n = 0;
    const fetchImpl = async (url, opts) => { n++; const body = JSON.parse(opts.body); const last = body.messages[body.messages.length - 1]; if (last.role === "tool") { const r = JSON.parse(last.content); return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ message: { content: `Versions: ${r.count}` } }] }) }; } return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_versions", arguments: JSON.stringify({ projectId: pid }) } }] } }] }) }; };
    const r = await C.runChat({ provider: "openai", messages: [{ role: "user", content: "what changed on 145?" }], context: {} }, { OPENAI_API_KEY: "k" }, { fetchImpl, cloud });
    assertTrue(r.status === 200 && /Versions: 2/.test(r.body.reply) && r.body.trace.some((t) => t.name === "list_versions" && /2 versions/.test(t.summary)), JSON.stringify(r.body));
  });
  await checkAsync("chat: a model that ends its tool round with no prose is asked once more (tools withheld) for the written answer; stopReason reports both stops", async () => {
    let n = 0; const bodies = [];
    const fetchImpl = async (url, opts) => { n++; const body = JSON.parse(opts.body); bodies.push(body); const last = body.messages[body.messages.length - 1];
      if (n === 1) return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_versions", arguments: JSON.stringify({ projectId: pid }) } }] } }] }) };
      if (n === 2) return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ finish_reason: "stop", message: { content: "" } }] }) };
      return { ok: true, json: async () => ({ model: "gpt-5", choices: [{ finish_reason: "stop", message: { content: `Answer: ${/Write your answer now/.test(last.content) && !body.tools ? "written" : "wrong"}` } }] }) }; };
    const r = await C.runChat({ provider: "openai", messages: [{ role: "user", content: "history?" }], context: {} }, { OPENAI_API_KEY: "k" }, { fetchImpl, cloud });
    assertTrue(n === 3 && r.body.reply === "Answer: written" && r.body.stopReason === "stop→stop" && r.body.trace.length === 1, JSON.stringify(r.body));
  });
  check("versions: buildQuoteFile stamps savedBy from the portal session (null outside the portal), parseQuoteFile returns it; Estimates stamps the same on keepEstimateVersion's document", () => {
    const fake = { getItem: (k) => (k === "gradcon-portal-session" ? JSON.stringify({ currentUser: "grady@gradcon.com.au" }) : null) };
    const doc = QV.buildQuoteFile("p1", { items: [] }, "manual", QV.signedInUser(fake));
    const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
    assertTrue(doc.savedBy === "grady@gradcon.com.au" && QV.signedInUser({ getItem: () => "not json" }) === null && QV.buildQuoteFile("p1", { items: [] }, "manual", null).savedBy === null && QV.parseQuoteFile(doc).savedBy === "grady@gradcon.com.au" && /savedBy:portalSignedInUser\(\)/.test(est) && /function portalSignedInUser\(\)/.test(est));
  });
}

// ---- Summaries in batches (26 Oct 2026: 25 keys in one summaries call ran
// 2.95 s against the anon role's 3 s statement timeout; the dashboard fell
// back to ~37 MB of full-row reads and showed only the projects the browser
// had seen before — "projects are missing") ----
{
  const SB = await import("../src/lib/summaryBatches.js");
  check("summaryBatches: consecutive batches of at most N keys (7 keys → 3 + 3 + 1); a size under 1 is one key per batch; the default is 3 keys, 4 calls in flight", () => {
    const b = SB.summaryBatches(["a", "b", "c", "d", "e", "f", "g"], 3);
    assertTrue(JSON.stringify(b) === JSON.stringify([["a", "b", "c"], ["d", "e", "f"], ["g"]]), JSON.stringify(b));
    assertTrue(SB.summaryBatches(["a", "b"], 0).length === 2 && SB.summaryBatches([], 3).length === 0);
    assertTrue(SB.SUMMARIES_BATCH === 3 && SB.SUMMARIES_IN_FLIGHT === 4);
  });
  await checkAsync("collectSummaries: a failed batch is retried one key at a time, a key the function never returns goes to the bounded row read, one that still fails is `failed` (never missing), every landing is handed to onPartial exactly once, and no more than `inFlight` calls run at a time", async () => {
    const calls = []; let running = 0, peak = 0;
    const rpc = async (ask) => {
      calls.push(ask.slice()); running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 3)); running--;
      if (ask.length > 1 && ask.includes("big")) return null;            // the call that times out
      return ask.filter((k) => k !== "dead" && k !== "gone").map((k) => ({ key: k, value: { name: k }, updated_at: "t-" + k }));
    };
    const reads = [];
    const readRow = async (k) => { reads.push(k); return k === "dead" ? { key: k, value: { name: k, fromRow: true }, updated_at: "t-dead" } : null; };
    const partials = [];
    const res = await SB.collectSummaries(["a", "b", "big", "c", "dead", "gone", "f", "a"], { rpc, readRow, batch: 3, inFlight: 2, onPartial: (m) => partials.push(m) });
    assertTrue(Object.keys(res.map).sort().join() === "a,b,big,c,dead,f", Object.keys(res.map).join());
    assertTrue(JSON.stringify(res.failed) === JSON.stringify(["gone"]), JSON.stringify(res.failed));
    assertTrue(res.map.big.value.name === "big" && res.map.dead.value.fromRow === true && res.map.a.updated_at === "t-a");
    const singles = calls.filter((c) => c.length === 1).map((c) => c[0]).sort().join();
    assertTrue(singles === "a,b,big,f" && calls.length === 6, "single-key calls: " + singles + " of " + calls.length); // the failed batch's three keys retried one by one, plus the natural one-key last batch; the good batch is never re-asked
    assertTrue(JSON.stringify(reads) === JSON.stringify(["dead", "gone"]), JSON.stringify(reads));
    const landed = partials.flatMap((m) => Object.keys(m)).sort().join();
    assertTrue(landed === "a,b,big,c,dead,f", "onPartial keys: " + landed);
    assertTrue(partials.every((m) => Object.keys(m).every((k) => m[k] === res.map[k].value)));
    assertTrue(peak <= 2 && peak >= 1, "peak in flight " + peak);
  });
  await checkAsync("collectSummaries: with no function (rpc null) every key goes straight to the row read; a throwing rpc or readRow is a failure, never an exception", async () => {
    const reads = [];
    const res = await SB.collectSummaries(["a", "b"], { rpc: null, readRow: async (k) => { reads.push(k); return { key: k, value: {}, updated_at: "t" }; } });
    assertTrue(Object.keys(res.map).length === 2 && res.failed.length === 0 && reads.join() === "a,b");
    const res2 = await SB.collectSummaries(["x"], { rpc: async () => { throw new Error("boom"); }, readRow: async () => { throw new Error("boom"); } });
    assertTrue(Object.keys(res2.map).length === 0 && res2.failed.join() === "x");
  });
  check("every summaries caller goes through the batches: projects.js reads through collectSummaries and hands the dashboard onPartial, the portal shell and the AI Engine define summariesInBatches and no longer post the whole key list at once", () => {
    const pj = fs.readFileSync(new URL("../src/lib/projects.js", import.meta.url), "utf8");
    const dash = fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8");
    const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
    const ai = fs.readFileSync(new URL("../portal/ai-engine.html", import.meta.url), "utf8");
    assertTrue(/import \{ collectSummaries \} from "\.\/summaryBatches\.js"/.test(pj) && /collectSummaries\(storageKeys, \{ rpc, readRow, onPartial \}\)/.test(pj) && !/p_keys: storageKeys/.test(pj));
    assertTrue(/readQuoteSummariesDetailed\(storageKeys, \{ onPartial \} = \{\}\)/.test(pj));
    assertTrue(/readQuoteSummariesDetailed\(projects\.map\(\(p\) => p\.storageKey\), \{ onPartial \}\)/.test(dash));
    assertTrue(/function summariesInBatches\(keys\)/.test(shell) && !/p_keys: missing/.test(shell) && !/p_keys: unnamed/.test(shell) && (shell.match(/summariesInBatches\(/g) || []).length >= 3);
    assertTrue(/async function summariesInBatches\(keys\)/.test(ai) && !/p_keys: missing/.test(ai) && /await summariesInBatches\(missing\)/.test(ai));
  });
}

// ---- Dowels as trench mesh / sheet strips (26 Oct 2026) — the bridge prices an L-series line by NAME ----
check("bridge: an L-series trench-mesh line in lineal metres (a joint dowel strip, a footing layer) lands on the TRENCH MESH product of the same name in whole 6 m lengths; sheet-mesh dowel pieces in m² land on Square Mesh; an SL/RL code on a trench line stays flagged", () => {
  const br = buildImportFromEstimate({ project: { name: "Dowels" }, lines: [
    { elementId: "S", element: "Raft Slab A", category: "Raft Slab", materialGroup: "Joints", material: "4 Bar-L12TM", spec: "Joint dowels — 4 Bar-L12TM trench mesh laid along the run", qty: 30, finalQty: 31.5, unit: "lm", massPerUnit: 21.8 / 6 },
    { elementId: "S", element: "Raft Slab A", category: "Raft Slab", materialGroup: "Connections", material: "SL82", spec: "Step-down connecting dowels — 21 × SL82 sheet-mesh pieces 600 × 300 mm", qty: 3.78, finalQty: 3.97, unit: "m²", sheets: 1, massPerUnit: 1.2 },
    { elementId: "S", element: "Raft Slab A", category: "Raft Slab", materialGroup: "Reinforcement", material: "SL72", spec: "Trench mesh", qty: 8, finalQty: 8.4, unit: "lm", massPerUnit: 1.0 },
  ], elementGeometry: {} });
  const it = br.quote.items[0];
  const tmK = rateKey("TRENCH MESH", "4 Bar-L12TM", "length");
  assertTrue(it.qtys[tmK] === 31.5 && it.qtyBasis && it.qtyBasis[tmK] === "m", "the row takes the METRES, marked as metres (24 Nov 2026): " + JSON.stringify(it.qtys));
  assertTrue(costingAll.stockLengthsFor(it, tmK) === 6 && Math.abs(computeElementCost(it, defaultRates()).categoryTotals["TRENCH MESH"] - 6 * 41.19) < 0.005, "31.5 lm ÷ 6 = 5.25 → 6 lengths, bought by the row");
  assertTrue(Object.keys(it.qtys).some((k) => /SQUARE MESH/.test(k) && /SL82/.test(k)), "sheet-mesh dowel pieces (m²) land on Square Mesh: " + JSON.stringify(it.qtys));
  assertTrue(br.flags.some((f) => /of SL72/.test(f)) && !br.flags.some((f) => /of 4 Bar-L12TM|of SL82/.test(f)), br.flags.join(" | "));
  assertTrue(importAll.TRENCH_STOCK_M === 6);
});

// ---------------------------------------------------------------------------------------------------------------
// RFQ attachments added BY HAND (4 Nov 2026): a local file uploaded into the bucket, a pasted Drive file link —
// and the "not attached" note is information, never a stop.
await checkAsync("RFQ scope: a package is told ONLY its own work and no measurement unless the estimator ticks it on (19 Nov 2026 — a Formwork RFQ had listed steel fixing, every concrete volume, every bar run and the formed areas)", async () => {
  const R = await import("../src/lib/rfq.js");
  const TK = (lines) => [{ type: "suspslab", fields: { grade: 50, cover: 25, thickness: 150 }, lines }];
  const scopes = [
    { label: "Lift Core / Shear Wall", type: "Core / Shear Wall", measures: ["6.13 m³ concrete"], items: [], description: "", takeoff: [] },
    { label: "Ground RC Columns", type: "RC Columns - Fence Post Columns", measures: ["9 no.", "3.81 m³ concrete"], items: [], description: "", takeoff: [] },
    { label: "Suspended Slab - Roof", type: "Suspended Slab", measures: ["21 m²", "7.47 m³ concrete"], items: ["Steel fix"], description: "200 thick, N12 @ 200 each way", takeoff: TK([{ group: "Concrete", material: "N50 concrete", spec: "Suspended Slab 150mm", qty: 3.31, unit: "m³" }, { group: "Reinforcement", material: "N12", spec: "Bottom X bars — Section 1", qty: 158.36, unit: "m" }, { group: "Formwork", material: "Soffit formwork", qty: 22.05, unit: "m²" }, { group: "Formwork", material: "Edgeform", spec: "perimeter edge formwork 270mm high edge", qty: 127.05, unit: "m" }, { group: "Formwork", material: "Soffit formwork", qty: 114.45, unit: "m²" }]) },
    { label: "Post-Tensioned Slab - Including HOBS/Bench", type: "Post-Tensioned Slab", measures: ["590 m²", "195.41 m³ concrete"], items: ["Steel fix"], description: "", takeoff: TK([{ group: "Concrete", material: "N32 concrete", spec: "150x300 kerb", qty: 2.16, unit: "m³" }, { group: "Joints", material: "Construction joints @12m", qty: 3, unit: "no." }, { group: "Joints", material: "N12", spec: "Joint dowels", qty: 5.04, unit: "m" }, { group: "Formwork", material: "Profile formwork (both sides)", spec: "150x300 kerb", qty: 25.2, unit: "m²" }]) },
  ];
  const fw = R.scopeLines(scopes, { pkgKey: "formwork", pkgLabel: "Formwork" });
  assert.deepEqual(fw, [
    "  Please price the Formwork package for the following, measured by you from the documents provided.",
    "  - Lift Core / Shear Wall",
    "  - Ground RC Columns",
    "  - Suspended Slab - Roof: Soffit formwork, Edgeform",
    "  - Post-Tensioned Slab - Including HOBS/Bench: Profile formwork (both sides)",
  ]);
  assert.ok(!/\d/.test(fw.join("\n")), "the Formwork scope carries no figure at all: no area, no run, no depth, no count");
  assert.ok(!/steel fix|concrete|N12|N50|reinforc|joint|dowel|As taken off|Items to price|200 thick/i.test(fw.join("\n")), "nothing of another trade, no takeoff fields, no typed description");
  // each package takes its own lines
  const sf = R.scopeLines(scopes, { pkgKey: "steelfix", pkgLabel: "Steel Fixing" }).join("\n");
  assert.ok(/Suspended Slab - Roof: Steel fix, N12/.test(sf) && !/formwork|Edgeform|concrete|Construction joints|\d{2,}\.\d|m²|m³/i.test(sf), sf);
  const pm = R.scopeLines(scopes, { pkgKey: "premix", pkgLabel: "Premixed Concrete Supply" }).join("\n");
  assert.ok(/Suspended Slab - Roof: N50 concrete/.test(pm) && /HOBS\/Bench: N32 concrete/.test(pm) && !/formwork|Steel fix|N12\b/i.test(pm), pm);
  assert.ok(R.packageTakesLine("formwork", { group: "Formwork", material: "Edgeform" }) && !R.packageTakesLine("formwork", { group: "Reinforcement", material: "N12" }) && !R.packageTakesLine("steelfix", { group: "Joints", material: "Construction joints @12m" }) && R.packageTakesLine("steelfix", { group: "Joints", material: "N12" }) && R.packageTakesLine("other", { group: "Formwork" }) && R.packageTakesLine("", { group: "Concrete" }));
  assert.deepEqual(R.packageItems("formwork", ["Steel fix", "Formwork (subcontract)"]), ["Formwork (subcontract)"]);
  assert.deepEqual(R.packageItems("steelfix", ["Steel fix", "Formwork (subcontract)"]), ["Steel fix"]);
  assert.deepEqual(R.packageItems("premix", ["Steel fix"]), []); assert.deepEqual(R.packageItems("other", ["Steel fix"]), ["Steel fix"]);
  assert.equal(R.workKind({ material: "Profile formwork 150x300 (both sides)" }), "Profile formwork (both sides)"); assert.equal(R.workKind({ material: "Edgeform 270mm" }), "Edgeform"); assert.equal(R.workKind({ material: "N16" }), "N16");
  // ticked on for the round: the package's own measures and lines, still nothing of another trade, and the m³ only where the package prices concrete
  const fwQ = R.scopeLines(scopes, { pkgKey: "formwork", pkgLabel: "Formwork", showQuantities: true }).join("\n");
  assert.ok(/Quantities are Gradcon's own measure, for guidance only/.test(fwQ) && /Ground RC Columns \(RC Columns - Fence Post Columns\) — 9 no\./.test(fwQ) && /Formwork: Edgeform perimeter edge formwork 270mm high edge — 127\.05 m/.test(fwQ) && /Formwork: Soffit formwork — 114\.45 m²/.test(fwQ) && /200 thick, N12 @ 200 each way/.test(fwQ) && !/m³ concrete|Steel fix|As taken off|Reinforcement:|Concrete:|Joints:/.test(fwQ), fwQ);
  const pmQ = R.scopeLines(scopes, { pkgKey: "premix", pkgLabel: "Premixed Concrete Supply", showQuantities: true }).join("\n");
  assert.ok(/Lift Core \/ Shear Wall \(Core \/ Shear Wall\) — 6\.13 m³ concrete/.test(pmQ) && /Concrete: N50 concrete Suspended Slab 150mm — 3\.31 m³/.test(pmQ) && !/Formwork:|Reinforcement:/.test(pmQ), pmQ);
  // the body and the drafts carry the rule; the default is OFF
  const body = R.rfqBody({ projectName: "3206 Point Nepean Road, Sorrento", pkgLabel: "Formwork", pkgKey: "formwork", scopes, due: "2026-11-23" });
  const scopeBlock = body.split("SCOPE OF WORKS")[1].split("DOCUMENTS")[0];
  assert.ok(/- Suspended Slab - Roof: Soffit formwork, Edgeform/.test(scopeBlock) && !/\d/.test(scopeBlock), scopeBlock);
  assert.deepEqual(R.scopeLines([], { pkgKey: "formwork", pkgLabel: "Formwork" }), ["  As per the attached documents."]);
  const modal = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
  assert.ok(/const \[showQty, setShowQty\] = useState\(false\)/.test(modal) && /data-testid="rfq-show-qty"/.test(modal) && (modal.match(/showQuantities: showQty/g) || []).length === 2 && /pkgKey: p\.key, showQuantities: showQty/.test(modal) && /pkgKey: d\.pkgKey, showQuantities: showQty/.test(modal), "the composer's tick is off by default and reaches both the build and the re-draft");
});
await checkAsync("RFQ: a Drive file too large to copy goes on the email as a link, never an error that stops the build (19 Nov 2026) — the link-only copy may be 200 MB, a file the storage cannot take becomes its Drive link, and the composer knows whether a contractor can open it", async () => {
  const R = await import("../src/lib/rfq.js");
  const Gm = await import("../api/_google.js");
  const D = await import("../api/drive.js");
  // the option carries the Drive link and who can open it
  const opt = R.driveFolderOptions([{ id: "big1", name: "S-01 Structural set.pdf", kind: "pdf", mimeType: "application/pdf", size: 64 * 1048576, webViewLink: "https://drive.google.com/file/d/big1/view?usp=drivesdk", linkShared: false }], "formwork")[0];
  assert.ok(opt.webViewLink === "https://drive.google.com/file/d/big1/view?usp=drivesdk" && opt.linkShared === false, "a folder option keeps the file's Drive link and its sharing");
  assert.ok(R.driveLinkOption({ id: "x9", name: "Geo.pdf", kind: "pdf", webViewLink: "https://drive.google.com/file/d/x9/view", linkShared: true }).linkShared === true && R.driveLinkOption({ id: "x9", name: "Geo.pdf", kind: "pdf" }).linkShared === null);
  const f = R.driveLinkFile(opt, "file over 200 MB");
  assert.deepEqual({ name: f.name, url: f.url, driveLink: f.driveLink, linkShared: f.linkShared, size: f.size, reason: f.reason }, { name: "S-01 Structural set.pdf", url: "https://drive.google.com/file/d/big1/view?usp=drivesdk", driveLink: true, linkShared: false, size: 64 * 1048576, reason: "file over 200 MB" });
  assert.equal(R.driveLinkFile({ name: "a.pdf", fileId: "abc" }).url, "https://drive.google.com/file/d/abc/view", "no stored link → the file's own view address");
  // the plan: a Drive link is never attached and never counted against Gmail's size
  const small = { name: "A-101.pdf", url: "https://x/a.pdf", size: 2 * 1048576, tags: ["archi"] };
  const plan = R.planAttachments([f, small]);
  assert.ok(plan.attach.length === 1 && plan.attach[0] === small && plan.link.length === 1 && plan.link[0] === f && plan.total === 2 * 1048576, "the Drive link goes in the body, the small file is attached");
  assert.ok(R.unsharedDriveLinks([f, { ...f, linkShared: true }, { ...f, linkShared: null }, small]).length === 2, "not shared and not known both need the estimator's eye; a bucket link never does");
  // the body names the file, its size, that it is on Google Drive, and the link
  const body = R.rfqBody({ projectName: "3206 Point Nepean Road, Sorrento", pkgLabel: "Formwork", due: "2026-11-23", attachments: plan.attach, links: plan.link });
  assert.ok(body.includes("  - S-01 Structural set.pdf (structural drawings) (64.0 MB) — Google Drive: https://drive.google.com/file/d/big1/view?usp=drivesdk") && /Too large to attach — download from these links:/.test(body) && !/file over/.test(body), body.split("\n").filter((l) => /S-01|Too large/.test(l)).join(" | "));
  // Drive's own answer: "anyoneWithLink" among the permission ids = a contractor can open it
  assert.equal(Gm.normalizeFile({ id: "1", name: "a.pdf", mimeType: "application/pdf", permissionIds: ["0123", "anyoneWithLink"] }).linkShared, true);
  assert.equal(Gm.normalizeFile({ id: "1", name: "a.pdf", mimeType: "application/pdf", permissionIds: ["0123"] }).linkShared, false);
  assert.equal(Gm.normalizeFile({ id: "1", name: "a.pdf", mimeType: "application/pdf" }).linkShared, null, "a shared-drive item lists no permission ids: unknown, never 'shared'");
  assert.ok(/permissionIds/.test(Gm.DRIVE_FILE_FIELDS) && Gm.DRIVE_COPY_MAX_BYTES === 30 * 1048576 && Gm.DRIVE_LINK_MAX_BYTES === 200 * 1048576);
  // the download: 40 MB is refused for a preview / job copy and taken for a link copy; 250 MB is refused for both, as tooLarge
  const sized = (mb) => async (url) => { const u = String(url); if (/alt=media/.test(u)) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => "application/pdf" } }; return { ok: true, json: async () => ({ id: "f", name: "set.pdf", mimeType: "application/pdf", size: String(mb * 1048576), md5Checksum: "m" }) }; };
  await assert.rejects(() => Gm.driveDownload("f", "t", sized(40)), (e) => e.status === 413 && e.tooLarge === true && /file over 30 MB/.test(e.message));
  assert.equal((await Gm.driveDownload("f", "t", sized(40), { maxBytes: Gm.DRIVE_LINK_MAX_BYTES })).name, "set.pdf");
  await assert.rejects(() => Gm.driveDownload("f", "t", sized(250), { maxBytes: Gm.DRIVE_LINK_MAX_BYTES }), (e) => e.status === 413 && /file over 200 MB/.test(e.message));
  // the wiring: only `big: true` on a non-job copy lifts the cap; the composer asks for it and catches a refusal per file
  const driveSrc = fs.readFileSync(new URL("../api/drive.js", import.meta.url), "utf8");
  assert.ok(/const big = body\.big === true && target !== "job";/.test(driveSrc) && /big \? \{ maxBytes: Gm\.DRIVE_LINK_MAX_BYTES \} : \{\}/.test(driveSrc) && /up\.status === 413 \? 413 : 502/.test(driveSrc), "the copy action lifts the cap for a link copy only, and names a storage refusal");
  const modal = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
  assert.ok(/action: "copy", id: opt\.fileId, target: "preview", big: true/.test(modal) && /if \(e && e\.needsReconnect\) throw e;/.test(modal) && /files\[i\] = driveLinkFile\(opt,/.test(modal) && /data-testid="rfq-drive-links"/.test(modal), "a copy that fails becomes a Drive link; only a reconnect stops the build");
  assert.equal(JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).functions["api/drive.js"].maxDuration, 300, "a 200 MB copy has the time it needs");
  assert.ok(/body && body\.big \? 280000 : 60000/.test(fs.readFileSync(new URL("../src/lib/driveFiles.js", import.meta.url), "utf8")));
});
await checkAsync("RFQ attachments by hand (rfq.js, markupStore.uploadRfqFile): the Drive FILE id from every link form, the local-file check, the bucket path, the two option builders, and the missing-class note satisfied by a local file", async () => {
  const R = await import("../src/lib/rfq.js");
  const MS = await import("../src/lib/markupStore.js");
  const G = await import("../api/_google.js");
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456";
  assert.equal(R.driveFileIdFrom(`https://drive.google.com/file/d/${id}/view?usp=sharing`), id, "share link");
  assert.equal(R.driveFileIdFrom(`https://drive.google.com/open?id=${id}`), id, "open?id link");
  assert.equal(R.driveFileIdFrom(`https://drive.google.com/uc?export=download&id=${id}`), id, "uc?id link");
  assert.equal(R.driveFileIdFrom(`https://docs.google.com/document/d/${id}/edit`), id, "a Google Doc link");
  assert.equal(R.driveFileIdFrom(`  ${id} `), id, "a bare id");
  assert.equal(R.driveFileIdFrom(`https://drive.google.com/drive/folders/${id}`), null, "a FOLDER link is not a file link");
  assert.equal(R.driveFileIdFrom("not a link"), null); assert.equal(R.driveFileIdFrom(""), null);
  assert.equal(G.driveFolderIdFrom(`https://drive.google.com/drive/folders/${id}`), id, "the folder reader is unchanged");
  // local files: the kinds a contractor can open, under the cap, never empty
  assert.equal(R.localFileCheck({ name: "Geotech Report.pdf", size: 1200 }), "");
  assert.equal(R.localFileCheck({ name: "S-01 slab plan.dwg", size: 1200 }), "");
  assert.match(R.localFileCheck({ name: "setup.exe", size: 1200 }), /not a drawing/);
  assert.match(R.localFileCheck({ name: "big.pdf", size: R.LOCAL_FILE_MAX_BYTES + 1 }), /over 50 MB/);
  assert.equal(R.localFileCheck({ name: "empty.pdf", size: 0 }), "empty file");
  assert.equal(R.rfqFilePath("p-12/x", "Soil Report (final).pdf", 1700000000000), "rfq-files/p-12x/1700000000000-Soil_Report_final_.pdf", "the server's safe-name rule, the project id cleaned");
  // the options: tagged by name like a folder file, ticked on their own (auto), marked added
  const loc = R.localFileOption({ path: "rfq-files/p1/1-Geotech_Report.pdf", url: "https://x/rfq-files/p1/1-Geotech_Report.pdf", name: "Geotech Report.pdf", size: 1200, mimeType: "application/pdf" }, "bored");
  assert.deepEqual([loc.id, loc.kind, loc.auto, loc.added, loc.tags], ["local:rfq-files/p1/1-Geotech_Report.pdf", "local", true, true, ["soil"]]);
  const lnk = R.driveLinkOption({ id: "f1", name: "S-01 Structural.pdf", mimeType: "application/pdf", kind: "pdf", size: 9000 }, "bored");
  assert.deepEqual([lnk.id, lnk.kind, lnk.fileId, lnk.folderName, lnk.tags, lnk.auto, lnk.added], ["drive:f1", "drive", "f1", "Drive link", ["struct"], true, true]);
  assert.equal(R.driveLinkOption({ id: "d1", name: "Drawings", kind: "folder" }, "bored"), null, "a folder is no attachment");
  assert.equal(R.driveLinkOption(null), null);
  // the note: the soil report missing from the folder is covered by the local file
  const folderOpts = R.driveFolderOptions([{ id: "a", name: "A-101 Architectural.pdf", kind: "pdf", size: 1 }, { id: "s", name: "S-01 Structural.pdf", kind: "pdf", size: 1 }], "bored");
  assert.deepEqual(R.missingAttachClasses(folderOpts, new Set(folderOpts.map((o) => o.id))).map((c) => c.key), ["soil"]);
  assert.deepEqual(R.missingAttachClasses([...folderOpts, loc], new Set([...folderOpts.map((o) => o.id), loc.id])), [], "the local geotech report satisfies the soil class");
  // the upload: the bucket, the path, upsert, the content type, the public URL — on a fake storage client; no client throws
  const calls = [];
  const client = { storage: { from: (bucket) => ({ upload: async (path, body, opts) => { calls.push({ bucket, path, size: body.size, opts }); return { error: null }; }, getPublicUrl: (path) => ({ data: { publicUrl: `https://xbmyhvrcuyapoarmchpv.supabase.co/storage/v1/object/public/${bucket}/${path}` } }) }) } };
  const up = await MS.uploadRfqFile("p1", { name: "Soil Report.pdf", size: 4321, type: "application/pdf" }, client, 1700000000000);
  assert.deepEqual(calls, [{ bucket: "gradcon-files", path: "rfq-files/p1/1700000000000-Soil_Report.pdf", size: 4321, opts: { upsert: true, contentType: "application/pdf" } }]);
  assert.deepEqual(up, { path: "rfq-files/p1/1700000000000-Soil_Report.pdf", url: "https://xbmyhvrcuyapoarmchpv.supabase.co/storage/v1/object/public/gradcon-files/rfq-files/p1/1700000000000-Soil_Report.pdf", name: "Soil Report.pdf", size: 4321, mimeType: "application/pdf" });
  assert.ok(up.url.startsWith(G.ATTACH_URL_PREFIX), "the uploaded file is where the send function may fetch from");
  await assert.rejects(() => MS.uploadRfqFile("p1", { name: "x.pdf", size: 1, type: "" }, null), /not configured/);
  const refused = { storage: { from: () => ({ upload: async () => ({ error: new Error("Payload too large") }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } };
  await assert.rejects(() => MS.uploadRfqFile("p1", { name: "x.pdf", size: 1, type: "" }, refused), /Payload too large/);
  // the composer: the note is information, the build button is never gated on it, and both add paths exist
  const src = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
  assert.ok(/data-testid="rfq-attach-missing">Not attached yet:/.test(src) && !/Not found in the folder, not attached/.test(src), "the note no longer reads as an error");
  assert.ok(/disabled=\{building \|\| !totalPicks \|\| !chosenItems\.length\}/.test(src), "Build is gated on contractors and elements only — never on the attachments");
  assert.ok(/data-testid="rfq-add-local-input"/.test(src) && /data-testid="rfq-add-link-button"/.test(src) && /uploadRfqFile\(projectId/.test(src) && /action: "file", id/.test(src), "the local upload and the Drive link read");
});

// ---------------------------------------------------------------------------------------------------------------
// Packages within a project (lib/packages.js, 4 Nov 2026): the model and its patches, the margin chain
// row → element → package → project, the package totals adding up, and the tender's combined / by-package reading.
await checkAsync("Packages (lib/packages.js, costing.js inheritedMargin, tenderQuoteDefaults.js tender*): patches, grouping, the margin chain, totals that add up, and the tender's two layouts with a package left out", async () => {
  const P = await import("../src/lib/packages.js");
  const C = await import("../src/lib/costing.js");
  const T = await import("../src/lib/tenderQuoteDefaults.js");
  const { ELEMENT_TYPES, FULL_CATALOG } = await import("../src/data/catalog.js");
  const rates = C.defaultRates();
  const conc = FULL_CATALOG.find((c) => c.key === "CONCRETE"); const prod = conc.products.find((p) => /25 mpa/i.test(p.name));
  const concKey = C.rateKey(conc.key, prod.name, prod.unit);
  const sub = FULL_CATALOG.find((c) => c.key === C.SUBCONTRACT_CATEGORY_KEY); const sq = sub.products.find((p) => p.unit === "quote"); const subKey = C.rateKey(sub.key, sq.name, sq.unit);
  const mk = (label, m3) => ({ ...C.newElementItem(ELEMENT_TYPES.find((t) => t.id === "piles_bored")), label, qtys: { [concKey]: m3 } });
  let a = mk("House raft", 10), b = mk("Pool shell", 5), c = mk("Boundary wall", 2);
  c.qtys[subKey] = 1; c.rateOverrides = { [subKey]: { unitCost: 2000 } };
  let q = { projectName: "7 Example St", marginPct: 0.25, overheadPct: 0, contingencyPct: 0, items: [a, b, c] };
  // a plain project: one group, no package, nothing changes
  assert.equal(P.hasPackages(q), false); assert.deepEqual(P.itemsByPackage(q, q.items).map((g) => [g.pkg, g.items.length]), [[null, 3]]);
  assert.equal(P.packageLabelFor(q, a), "");
  // the FIRST package takes every element; the second starts empty
  const p1 = P.addPackagePatch(q, "Main residence"); q = { ...q, packages: p1.packages, items: p1.items };
  assert.equal(q.packages.length, 1); assert.ok(q.items.every((it) => it.packageId === q.packages[0].id), "every element joined the first package");
  const p2 = P.addPackagePatch(q, "Pool & surrounds"); q = { ...q, packages: p2.packages, items: p2.items };
  assert.equal(q.packages.length, 2); assert.ok(q.items.every((it) => it.packageId === q.packages[0].id), "a second package takes nothing on its own");
  assert.equal(P.addPackagePatch(q, "   ").packages[2].name, P.DEFAULT_PACKAGE_NAME, "a blank name gets the default");
  const main = q.packages[0], pool = q.packages[1];
  q = { ...q, ...P.assignElementPatch(q, b.id, pool.id) };
  a = q.items.find((it) => it.id === a.id); b = q.items.find((it) => it.id === b.id); c = q.items.find((it) => it.id === c.id); // the patches copy the elements
  assert.deepEqual(P.itemsByPackage(q, q.items).map((g) => [g.pkg.id, g.items.map((i) => i.label)]), [[main.id, ["House raft", "Boundary wall"]], [pool.id, ["Pool shell"]]], "grouped in package order, the quote order kept inside");
  assert.equal(P.packageLabelFor(q, b), "Pool & surrounds");
  assert.deepEqual(P.assignElementPatch(q, b.id, "nope").items, q.items, "an unknown package id changes nothing");
  const un = P.assignElementPatch(q, b.id, "").items.find((it) => it.id === b.id); assert.ok(!("packageId" in un), "unassigned drops the key");
  assert.equal(P.itemsByPackage({ ...q, items: P.assignElementPatch(q, b.id, "").items }, P.assignElementPatch(q, b.id, "").items).pop().pkg, null, "an unassigned element closes the list");
  // rename, move, margin
  assert.equal(P.renamePackagePatch(q, pool.id, "Pool").packages[1].name, "Pool");
  assert.deepEqual(P.movePackagePatch(q, pool.id, -1).packages.map((p) => p.id), [pool.id, main.id]); assert.deepEqual(P.movePackagePatch(q, main.id, -1).packages.map((p) => p.id), [main.id, pool.id], "cannot move above the top");
  q = { ...q, ...P.packageMarginPatch(q, pool.id, 0.1) };
  assert.equal(q.packages[1].marginPct, 0.1); assert.ok(!("marginPct" in P.packageMarginPatch(q, pool.id, "").packages[1]), "a blank clears the package margin");
  // the chain: the pool element inherits 10% from its package, the house keeps the project's 25%, a pinned element wins, a pinned row wins over that
  assert.equal(C.inheritedMargin(q, b), 0.1); assert.equal(C.inheritedMargin(q, a), 0.25); assert.equal(C.packageMarginFor(q, a), null);
  assert.equal(C.marginSource(b, null, q), "package"); assert.equal(C.marginSource(a, null, q), "project");
  const eb = C.computeElementSell(b, rates, q, "both"); const ea = C.computeElementSell(a, rates, q, "both");
  assert.ok(Math.abs(eb.sell - eb.loaded / 0.9) < 1e-6 && eb.lines[0].source === "package" && eb.packageId === pool.id, "the pool element sells at its package's 10%");
  assert.ok(Math.abs(ea.sell - ea.loaded / 0.75) < 1e-6 && ea.lines[0].source === "project");
  const bPinned = C.elementMarginPatch(b, 0.3); assert.ok(Math.abs(C.computeElementSell(bPinned, rates, q, "both").sell - eb.loaded / 0.7) < 1e-6, "an element pin beats the package");
  const cRow = C.rowMarginPatch(c, subKey, 0.05); const ec = C.computeElementSell(cRow, rates, q, "both");
  assert.equal(ec.lines.find((l) => l.kind === "sub").margin, 0.05); assert.equal(ec.lines.find((l) => l.kind === "own").margin, 0.25);
  // the register carries the package on every line and the totals add up
  const reg = C.computeMarginRegister(q.items, rates, q, "both");
  assert.ok(reg.lines.every((l) => l.packageId) && reg.lines.find((l) => l.elementId === b.id).inherited === 0.1);
  const tot = P.computePackageTotals(q, q.items, rates, "both");
  assert.deepEqual(tot.map((t) => [t.name, t.count]), [["Main residence", 2], ["Pool & surrounds", 1]]);
  assert.ok(Math.abs(tot.reduce((s, t) => s + t.cost, 0) - C.computeGrandTotal(q.items, rates, "both")) < 1e-6, "package direct costs add up to the grand total");
  assert.ok(Math.abs(tot.reduce((s, t) => s + t.sell, 0) - reg.totals.sell) < 1e-6, "package sells add up to the register's sell");
  assert.ok(Math.abs(tot[1].margin - 0.1) < 1e-9, "the pool package's blended margin is its own 10%");
  // removing a package moves its elements to the first remaining one; removing the last unpackages the project
  const r1 = P.removePackagePatch(q, pool.id); assert.equal(r1.packages.length, 1); assert.ok(r1.items.every((it) => it.packageId === main.id));
  const r2 = P.removePackagePatch({ ...q, ...r1 }, main.id); assert.deepEqual(r2.packages, []); assert.ok(r2.items.every((it) => !("packageId" in it)));
  // the tender: seeded as ever; "combined" = every row; "byPackage" = one block per package with its own sum; an unticked package leaves the print and the sum
  const tq = { ...T.newTenderQuote(), items: T.seedTenderItems(q, q.items, rates) };
  assert.equal(T.tenderLayout(tq), "combined"); assert.equal(T.tenderIncludes(tq, pool.id), true);
  const allRows = T.tenderItemsIncluded(tq, q, q.items).flatMap((it) => it.lines); assert.equal(allRows.length, 3);
  const sumAll = T.tenderProjectSumFor(tq, q, q.items, 0.1).exGst; assert.ok(Math.abs(sumAll - reg.totals.sell) < 0.02, "the combined project sum is the register's sell");
  const blocks = T.tenderPackageBlocks({ ...tq, packageLayout: "byPackage" }, q, q.items);
  assert.deepEqual(blocks.map((b) => [b.name, b.items.flatMap((i) => i.lines).length]), [["Main residence", 2], ["Pool & surrounds", 1]]);
  assert.ok(Math.abs(blocks.reduce((s, b) => s + b.sum, 0) - sumAll) < 0.02, "the package sums add up to the project sum");
  assert.ok(Math.abs(blocks[1].sum - eb.sell) < 0.02, "the pool block sums the pool element's price");
  const without = { ...tq, packagesIncluded: { [pool.id]: false } };
  assert.equal(T.tenderItemsIncluded(without, q, q.items).flatMap((it) => it.lines).length, 2, "the pool's row leaves");
  assert.ok(Math.abs(T.tenderProjectSumFor(without, q, q.items, 0.1).exGst - (sumAll - eb.sell)) < 0.02, "…and the project sum drops by its price");
  assert.deepEqual(T.tenderPackageBlocks({ ...without, packageLayout: "byPackage" }, q, q.items).map((b) => b.name), ["Main residence"]);
  assert.equal(tq.items.length, T.tenderItemsIncluded(without, q, q.items).length + 0, "a stage emptied by the untick is dropped only when it held element rows");
  // a hand-typed row with no element stays whatever is ticked, and lands in General by package
  const typed = { ...without, items: without.items.concat([{ id: "hand", stage: null, title: "Allowance", price: "$100.00 + GST", lines: [] }]) };
  assert.ok(T.tenderItemsIncluded(typed, q, q.items).some((it) => it.id === "hand"));
  assert.deepEqual(T.tenderPackageBlocks({ ...typed, packageLayout: "byPackage" }, q, q.items).map((b) => [b.name, Math.round(b.sum)]).pop(), ["General", 100]);
  // colours: the palette by position, a picked #rrggbb, black or white ink, the unassigned grey
  assert.equal(P.packageColour(q, main), P.PACKAGE_COLOURS[0]); assert.equal(P.packageColour(q, pool), P.PACKAGE_COLOURS[1]); assert.equal(P.packageColour(q, null), P.UNASSIGNED_COLOUR);
  const qc = { ...q, ...P.packageColourPatch(q, pool.id, "#FF8800") };
  assert.equal(P.packageColour(qc, qc.packages[1]), "#ff8800", "a picked colour, lower-cased"); assert.equal(P.packageColour(qc, qc.packages[0]), P.PACKAGE_COLOURS[0], "the other keeps the palette");
  assert.ok(!("colour" in P.packageColourPatch(qc, pool.id, "red").packages[1]), "a bad value clears the colour"); assert.equal(P.isHexColour("#abc"), false);
  assert.equal(P.inkFor("#ff8800"), "#111111"); assert.equal(P.inkFor("#1d4ed8"), "#ffffff"); assert.equal(P.inkFor("#ffffff"), "#111111"); assert.equal(P.inkFor("#000000"), "#ffffff"); assert.equal(P.inkFor("nope"), "#ffffff");
  assert.ok(P.PACKAGE_COLOURS.every(P.isHexColour) && new Set(P.PACKAGE_COLOURS).size === P.PACKAGE_COLOURS.length, "a palette of distinct hex colours");
  // the summary ticks: itemsInPackages keeps the ticked packages' elements, an element with no / a gone package always
  assert.deepEqual(P.itemsInPackages(q, q.items, new Set()).map((i) => i.id), q.items.map((i) => i.id), "no tick off = everything");
  assert.deepEqual(P.itemsInPackages(q, q.items, new Set([pool.id])).map((i) => i.id), q.items.filter((i) => i.packageId !== pool.id).map((i) => i.id), "the pool unticked leaves");
  assert.equal(P.itemsInPackages(q, q.items, [pool.id]).length, P.itemsInPackages(q, q.items, new Set([pool.id])).length, "an array works too");
  assert.deepEqual(P.itemsInPackages(q, q.items.concat([{ id: "orphan", packageId: "gone" }, { id: "none" }]), new Set([pool.id, "gone"])).map((i) => i.id).slice(-2), ["orphan", "none"], "a gone or unset package never leaves");
  assert.equal(P.itemsInPackages({ ...q, packages: [] }, q.items, new Set([pool.id])).length, q.items.length, "a plain project ignores the ticks");
  // package assumptions: on the package, the tender notes carry them after the project's, prefixed; an unticked package's leave
  const TN = await import("../src/lib/tenderNotes.js");
  const qa = { ...q, assumptions: [{ id: "a1", text: "Spoil to be carted by others" }], ...P.packageAssumptionsPatch(q, pool.id, [{ id: "pa1", text: "Pool shell to engineer's detail" }, { id: "pa2", text: "   " }]) };
  assert.deepEqual(P.packageAssumptions(qa.packages[1]).map((a) => a.id), ["pa1", "pa2"]); assert.deepEqual(P.packageAssumptions(qa.packages[0]), []);
  assert.deepEqual(TN.assumptionLines(qa), ["Spoil to be carted by others", "Pool & surrounds: Pool shell to engineer's detail"], "the project's first, the package's prefixed, the blank dropped");
  assert.deepEqual(TN.assumptionNoteItems(qa).map((a) => [a.id, a.packageId]), [["a1", null], ["pa1", pool.id]]);
  assert.deepEqual(TN.assumptionLines(qa, { excludePackages: [pool.id] }), ["Spoil to be carted by others"], "an unticked package's assumptions leave the notes");
  assert.deepEqual(TN.tenderNoteLines(qa, "Pool & surrounds: Pool shell to engineer's detail\nAccess from the lane").all, ["Spoil to be carted by others", "Pool & surrounds: Pool shell to engineer's detail", "Access from the lane"], "a typed repeat of a package line prints once");
  // a project without packages reads exactly as before
  const plain = { ...q, packages: [], items: r2.items };
  assert.deepEqual(T.tenderItemsIncluded(tq, plain, plain.items), T.normalizeTenderItems(tq.items));
  assert.equal(T.newTenderQuote().packageLayout, "combined");
});

await checkAsync("Grady's mate (portal/mate.js, src/lib/mate.js): the rules, the dedupe, the idle, the switch, the wiring", async () => {
  const vm = await import("node:vm");
  const src = fs.readFileSync(new URL("../portal/mate.js", import.meta.url), "utf8");
  const sb = { globalThis: undefined, module: undefined }; sb.globalThis = sb; vm.runInNewContext(src, sb, { filename: "mate.js" });
  const M = sb; const ML = await import("../src/lib/mate.js");
  assert.equal(M.MATE_EVENT_KEY, ML.MATE_EVENT_KEY, "the apps write the key the shell listens on");
  assert.equal(JSON.stringify(M.MATE_POSES), JSON.stringify(["idle", "wave", "point", "nod", "thumbs", "scratch", "wrist", "celebrate", "sleep", "measure", "hips", "clipboard"]));
  // chatter: 60–100 sayings, every placeholder declared, filled lines carry no braces, a line needs its facts, no back-to-back repeat
  assert.ok(M.MATE_SAYINGS.length >= 60 && M.MATE_SAYINGS.length <= 100, `${M.MATE_SAYINGS.length} sayings`);
  for (const sy of M.MATE_SAYINGS) {
    const ph = [...sy.t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.ok(ph.every((k) => sy.needs.includes(k)), `every placeholder of "${sy.t}" is declared`);
    assert.ok(sy.needs.every((k) => M.SAYING_PLACEHOLDERS.includes(k) || M.SAYING_FLAGS.includes(k)), `"${sy.t}" needs known facts`);
    assert.ok(M.MATE_POSES.includes(sy.pose), `"${sy.t}" strikes a known pose`);
  }
  const rawFacts = { name: "Grady", tod: "Good morning", welcome: { day: "Friday", dueToday: ["7 Example Street"], dueWeek: ["9 Beach Road"], nQueued: 3, nEstimating: 2, nTakingOff: 1, recent: { name: "14 Marine Pde", when: "today at 9:12 am", elements: 5 } }, project: "14 Marine Pde", next: "Slab SL3", done: 2, total: 5, opened: ["7 Example Street", "14 Marine Pde"], weather: { temp: 21.4, sky: "Sunny", place: "Melbourne" } };
  const sf = M.sayingFacts(rawFacts); assert.equal(sf.temp, "21"); assert.equal(sf.sky, "sunny"); assert.equal(sf.nOpened, "2"); assert.equal(sf.elementsMany, "1"); assert.equal(sf.noneDue, undefined);
  const el1 = M.eligibleSayings(sf); assert.ok(el1.length >= 60, `${el1.length} eligible with every fact`);
  for (let i = 0; i < 200; i++) { const sy = M.mateSaying(rawFacts, i); assert.ok(sy && !/[{}]/.test(sy.text), `no brace left in "${sy && sy.text}"`); assert.ok(M.MATE_POSES.includes(sy.pose)); }
  assert.match(M.mateSaying(rawFacts, 0).text, /Last worked on was 14 Marine Pde, today at 9:12 am/);
  const bare = M.eligibleSayings(M.sayingFacts({})); assert.ok(bare.length >= 25 && bare.every((sy) => sy.needs.length === 0), "with nothing known only the fact-free lines are eligible");
  assert.ok(!M.eligibleSayings(M.sayingFacts({ welcome: { recent: { name: "X" } } })).some((sy) => sy.needs.includes("lastWhen")), "no 'when' → no line that needs it");
  const first = M.mateSaying(rawFacts, 7); assert.notEqual(M.mateSaying(rawFacts, 7, first.text).text, first.text, "the previous line is not repeated");
  assert.equal(M.mateSaying({}, 1, null) && M.mateSaying({}, 1, null).needs, undefined);
  assert.ok(M.MATE_SAYINGS.filter((sy) => sy.needs.includes("last")).length >= 6 && M.MATE_SAYINGS.filter((sy) => sy.needs.includes("opened") || sy.needs.includes("nOpened")).length >= 3 && M.MATE_SAYINGS.some((sy) => /What a good/.test(sy.t)), "last worked on, the projects opened, what a good day");
  // size, transparency, chatter interval, the remembered spot
  assert.equal(M.mateSize({}), 240); assert.equal(M.mateSize({ mateSize: "120" }), 120); assert.equal(M.mateSize({ mateSize: 999 }), 240);
  assert.equal(M.mateOpacity({}), 1); assert.equal(M.mateOpacity({ mateOpacity: 60 }), 0.6); assert.equal(M.mateOpacity({ mateOpacity: 5 }), 0.2); assert.equal(M.mateOpacity({ mateOpacity: 500 }), 1);
  assert.equal(M.mateChatterMs({}), 20 * 60000); assert.equal(M.mateChatterMs({ mateChatterMin: "0" }), 0); assert.equal(M.mateChatterMs({ mateChatterMin: 60 }), 3600000); assert.equal(M.mateChatterMs({ mateChatterMin: 7 }), 20 * 60000);
  assert.equal(M.clampMatePos(null), null); assert.equal(M.clampMatePos({ x: "a", y: 1 }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(M.clampMatePos({ x: 5000, y: -40 }, { w: 150, h: 240 }, { w: 1280, h: 800 }))), { x: 1130, y: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(M.clampMatePos({ x: 300, y: 200 }, { w: 150, h: 240 }, { w: 1280, h: 800 }))), { x: 300, y: 200 });
  const facts = { dueToday: ["7 Example Street, Rye VIC 3941"], dueWeek: ["9 Beach Road"] };
  let r = M.mateReaction({ kind: "signin", detail: { name: "Grady" }, at: 1 }, facts); assert.equal(r.pose, "wrist"); assert.match(r.text, /G'day Grady\. 1 quote is due TODAY: 7 Example Street/);
  r = M.mateReaction({ kind: "signin", detail: { name: "Grady" }, at: 1 }, { dueToday: [], dueWeek: ["A", "B"] }); assert.equal(r.pose, "wave"); assert.match(r.text, /2 quotes due this week — A first/);
  r = M.mateReaction({ kind: "signin", detail: {}, at: 1 }, {}); assert.equal(r.pose, "wave"); assert.match(r.text, /G'day there\. Nothing due this week/);
  r = M.mateReaction({ kind: "open", detail: { project: "14 Marine Pde", done: 2, total: 5, next: "Slab on Ground SL3" }, at: 1 }); assert.equal(r.pose, "point"); assert.equal(r.text, "Back on 14 Marine Pde. Next up: Slab on Ground SL3.");
  r = M.mateReaction({ kind: "open", detail: { project: "P", done: 2, total: 5, next: "X", unpriced: 2 }, at: 1 }); assert.equal(r.pose, "scratch"); assert.match(r.text, /2 quote rows on P still have no amount/, "an unpriced quote row beats the next-up line");
  r = M.mateReaction({ kind: "open", detail: { project: "P", done: 0, total: 3, expiring: 1 }, at: 1 }); assert.equal(r.pose, "scratch"); assert.match(r.text, /1 supplier rate expiring/);
  r = M.mateReaction({ kind: "open", detail: { project: "P", done: 0, total: 0 }, at: 1 }); assert.equal(r.pose, "wave"); assert.match(r.text, /blank quote/);
  r = M.mateReaction({ kind: "open", detail: { project: "P", done: 3, total: 3 }, at: 1 }); assert.equal(r.pose, "clipboard");
  assert.equal(M.mateReaction({ kind: "open", detail: { project: "P", status: "Taking Off", done: 0, total: 3, next: "Raft" }, at: 1 }).pose, "measure", "a Taking Off project gets the tape");
  r = M.mateReaction({ kind: "done", detail: { label: "Strip Footings", done: 1, total: 3, next: "Screw Piles" }, at: 1 }); assert.equal(r.pose, "nod"); assert.equal(r.text, "Strip Footings ticked. 1 of 3 done. Next up: Screw Piles.");
  r = M.mateReaction({ kind: "done", detail: { label: "Strip Footings", done: 3, total: 3 }, at: 1 }); assert.equal(r.pose, "celebrate"); assert.match(r.text, /every element/);
  r = M.mateReaction({ kind: "saved", detail: { project: "P" }, at: 60000 }); assert.equal(r.pose, "clipboard"); assert.match(r.text, /Saved — a version of P kept for good/);
  r = M.mateReaction({ kind: "rfq", detail: { count: 2, packages: "Screw Piling" }, at: 1 }); assert.equal(r.pose, "wave"); assert.match(r.text, /2 RFQs sent — Screw Piling/); assert.equal(M.mateReaction({ kind: "rfq", detail: { count: 0 }, at: 1 }), null);
  assert.equal(M.mateReaction({ kind: "status", detail: { project: "P", status: "Successful" }, at: 1 }).pose, "celebrate"); assert.equal(M.mateReaction({ kind: "status", detail: { status: "Submitted" }, at: 1 }).pose, "celebrate");
  assert.equal(M.mateReaction({ kind: "status", detail: { status: "Completed Estimating" }, at: 1 }).pose, "clipboard"); assert.equal(M.mateReaction({ kind: "status", detail: { status: "Unsuccessful" }, at: 1 }).pose, "scratch");
  assert.equal(M.mateReaction({ kind: "status", detail: { status: "Deadline Missed" }, at: 1 }).pose, "wrist"); assert.equal(M.mateReaction({ kind: "status", detail: { status: "Estimating" }, at: 1 }), null, "an open status says nothing");
  assert.equal(M.mateReaction({ kind: "checklist", detail: { complete: true, total: 12 }, at: 1 }).pose, "celebrate"); assert.equal(M.mateReaction({ kind: "checklist", detail: { complete: false }, at: 1 }), null);
  assert.equal(M.mateReaction({ kind: "jump", detail: { label: "Raft Slab B" }, at: 1 }).text, "Raft Slab B — right there.");
  assert.equal(M.mateReaction({ kind: "whatever", detail: {}, at: 1 }), null); assert.equal(M.mateReaction("not json"), null); assert.equal(M.mateReaction({ detail: {} }), null);
  assert.match(M.mateReaction({ kind: "open", detail: { project: "x".repeat(80), done: 0, total: 1, next: "y".repeat(80) }, at: 1 }).text, /x{47}…\. Next up: y{47}…\./, "long names are trimmed");
  // dedupe: the same fact once in ten minutes
  r = M.mateReaction({ kind: "open", detail: { project: "P", done: 1, total: 2, next: "X" }, at: 1 });
  assert.equal(M.shouldSpeak(r, null, 0, 1000), true); assert.equal(M.shouldSpeak(r, r.sig, 1000, 1000 + 5 * 60000), false); assert.equal(M.shouldSpeak(r, r.sig, 1000, 1000 + M.MATE_REPEAT_MS), true); assert.equal(M.shouldSpeak(null, null, 0, 1), false);
  assert.equal(M.idlePose(0, M.MATE_IDLE_MS - 1), "idle"); assert.equal(M.idlePose(0, M.MATE_IDLE_MS), "sleep");
  assert.equal(M.mateEnabled({}), true); assert.equal(M.mateEnabled(null), true); assert.equal(M.mateEnabled({ mateOn: false }), false); assert.equal(M.mateEnabled({ mateOn: true }), true);
  const its = [{ qtys: { "SUB CONTRACTORS::Steel fix::quote": 2 } }, { qtys: { "SUB CONTRACTORS::Steel fix::quote": 1 }, rateOverrides: { "SUB CONTRACTORS::Steel fix::quote": { unitCost: 500 } } }, { qtys: { "CONCRETE::25 mpa::m3": 4 } }];
  assert.equal(M.countUnpricedQuoteRows(its), 1); assert.equal(ML.countUnpricedQuoteRows(its), 1); assert.equal(M.countUnpricedQuoteRows(null), 0);
  // the writer: one localStorage write under the key, a no-op with no storage
  const store = {}; const fake = { setItem: (k, v) => { store[k] = v; } };
  const ev = ML.mateEvent("done", { label: "A" }, fake); assert.equal(ev.kind, "done"); assert.equal(JSON.stringify(M.parseMateEvent(store[M.MATE_EVENT_KEY]).detail), JSON.stringify({ label: "A" })); assert.ok(M.parseMateEvent(store[M.MATE_EVENT_KEY]).at > 0);
  assert.equal(ML.mateEvent("done", {}, null), null); assert.equal(ML.mateEvent("", {}, fake), null);
  // the wiring: the shell loads the module and carries the figure, the bubble and the Settings switch; the assembler inlines it; the editor sends every event
  const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(shell, /<script src="mate\.js"><\/script>/); assert.match(shell, /id="mate" hidden data-pose="idle"/); assert.match(shell, /id="mate-bubble"/); assert.match(shell, /\['settings-mate','mateOn',true\]/);
  assert.match(shell, /window\.gradconMate\.react\(\{ kind:'signin'/); assert.match(shell, /window\.gradconMate\.screen\(id\)/); assert.match(shell, /e\.key === MATE_EVENT_KEY/);
  assert.match(shell, /prefers-reduced-motion: reduce\)\{ #mate \*, #mate-bubble\{ animation:none !important; \}/, "reduced motion = a still figure");
  for (const pose of M.MATE_POSES.filter((p) => p !== "idle" && p !== "sleep")) assert.match(shell, new RegExp(`#mate\\[data-pose="${pose}"\\]`), `the shell styles the ${pose} pose`);
  // 8 Nov 2026: the ✕ over his head, the pose cycle while idle, his own Settings block
  assert.ok(JSON.stringify(M.MATE_CYCLE_OPTIONS) === "[0,10,20,45,90]" && M.MATE_CYCLE_SEC_DEFAULT === 20, "pose-change options");
  assert.equal(M.mateCycleMs({}), 20000); assert.equal(M.mateCycleMs({ mateCycleSec: "0" }), 0); assert.equal(M.mateCycleMs({ mateCycleSec: 45 }), 45000); assert.equal(M.mateCycleMs({ mateCycleSec: 7 }), 20000, "an unknown value = the default");
  for (const p of M.MATE_CALM_POSES) assert.ok(M.MATE_POSES.indexOf(p) >= 0, `calm pose ${p} is a known pose`);
  for (const p of ["scratch", "wrist", "celebrate", "sleep", "wave", "point", "nod"]) assert.ok(M.MATE_CALM_POSES.indexOf(p) < 0, `${p} carries a mark or a reaction — never cycled`);
  for (let slot = 0; slot < 12; slot++) { const nx = M.cyclePose("idle", slot); assert.ok(nx !== "idle" && M.MATE_CALM_POSES.indexOf(nx) >= 0, "the cycle never repeats the current pose"); assert.equal(M.cyclePose("hips", slot), M.cyclePose("hips", slot), "deterministic by slot"); }
  assert.ok(new Set([0, 1, 2, 3].map((k) => M.cyclePose("idle", k))).size === 4, "every other calm pose comes round");
  assert.equal(M.MATE_CLOSED_KEY, "gradcon-mate-closed"); assert.ok(M.mateClosed({ getItem: () => "1" }) && !M.mateClosed({ getItem: () => null }) && !M.mateClosed(null));
  assert.match(shell, /<button type="button" class="hide" id="mate-hide"[^>]*data-testid="mate-hide">✕<\/button>/, "the ✕ over his head");
  assert.match(shell, /#mate \.hide\{ position:absolute; left:50%; top:-8px;/, "the ✕ sits above the figure");
  assert.match(shell, /hideBtn\.addEventListener\('pointerdown', function\(e\)\{ e\.stopPropagation\(\); \}\)/, "pressing the ✕ never starts a drag");
  assert.match(shell, /function closeForSession\(\)\{ try\{ sessionStorage\.setItem\(MATE_CLOSED_KEY/, "the ✕ closes him for this tab's session, never for good");
  assert.match(shell, /function visible\(\)\{ return enabled\(\) && !closed\(\) && screenId !== 'screen-login'; \}/);
  assert.match(shell, /setPose\(cyclePose\(el\.getAttribute\('data-pose'\), Math\.floor\(now \/ 1000\)\)\)/, "the idle pose cycle");
  assert.match(shell, /if\(!ms \|\| !bubble\.hidden \|\| idlePose\(lastActive, now\) === 'sleep' \|\| now - lastCycleAt < ms\) return false;/, "never over a bubble, never asleep");
  assert.match(shell, /\}, 5000\);\n\s*document\.getElementById\('mate-close'\)/, "the tick runs every 5 s");
  assert.match(shell, /<div class="settings-section" id="settings-section-mate">Grady's mate<\/div>/, "his own Settings block");
  const mateBlock = shell.slice(shell.indexOf('id="settings-section-mate"'), shell.indexOf("Estimates — defaults for new takeoffs"));
  for (const id of ["settings-mate", "settings-mate-show", "settings-mate-cycle", "settings-mate-chatter", "settings-mate-size", "settings-mate-opacity"]) assert.ok(mateBlock.includes(`id="${id}"`), `${id} lives in the Grady's mate block`);
  const appBlock = shell.slice(shell.indexOf('<div class="settings-section">App behaviour</div>'), shell.indexOf('id="settings-section-mate"'));
  assert.ok(!/settings-mate/.test(appBlock), "nothing of his is left under App behaviour");
  assert.match(shell, /\['settings-mate-cycle','mateCycleSec','20'\]/, "the cycle is a stored preference");
  // the Gradcon Storage badge on the welcome dashboard opens the DRIVE once connected (Grady, 6 Nov 2026: "this opens settings instead of the drive") — the nav's Google Drive route — and Settings only while there is nothing to browse
  assert.match(shell, /function storageBadgeTarget\(b\)\{ return b\.classList\.contains\('on'\) \? 'drive' : 'settings'; \}/);
  const badgeClick = shell.slice(shell.indexOf("document.getElementById('welcome-storage').addEventListener('click'"), shell.indexOf("document.getElementById('welcome-storage').addEventListener('click'") + 700);
  assert.match(badgeClick, /storageBadgeTarget\(b\) === 'drive'/); assert.match(badgeClick, /MENU_ROUTES\.drive/); assert.match(badgeClick, /localStorage\.setItem\('gradcon-quotes-initial-view', route\.view\)/); assert.match(badgeClick, /openApp\(route\.target, true\); setActiveMenu\('drive'\)/); assert.match(badgeClick, /document\.getElementById\('settings-btn'\)\.click\(\)/);
  assert.match(shell, /drive:\s*\{ target:'quotes',\s*view:'drive' \}/); assert.match(shell, /click to open the Drive'/); assert.ok(!/click for Settings'/.test(shell), "the connected badge's hover no longer says Settings");
  assert.match(shell, /#mate\[data-pose="sleep"\]/);
  const asm = fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8"); assert.match(asm, /portal", "mate\.js"/); assert.match(asm, /no longer loads mate\.js/);
  for (const pose of ["stand", "point", "thumbs", "arms", "hips", "kneel", "clipboard", "wave"]) { // his eight illustrated poses, cut out and inlined
    const webp = fs.readFileSync(new URL(`../portal/mate/${pose}.webp`, import.meta.url)); assert.ok(webp.length > 1000 && webp.toString("ascii", 0, 4) === "RIFF" && webp.toString("ascii", 8, 12) === "WEBP", `portal/mate/${pose}.webp is a WebP`);
    assert.ok(shell.includes(`__MATE_POSE_${pose.toUpperCase()}__`), `the shell carries the ${pose} placeholder`); assert.match(shell, new RegExp(`\\.img-${pose}\\{ display:block`), `some pose shows the ${pose} image`);
  }
  for (const id of ["settings-mate-chatter", "settings-mate-size", "settings-mate-opacity"]) assert.ok(shell.includes(`id="${id}"`), `Settings carries ${id}`);
  assert.match(shell, /\['settings-mate-chatter','mateChatterMin','20'\]/); assert.match(shell, /\['settings-mate-size','mateSize','240'\]/); assert.match(shell, /\['settings-mate-opacity','mateOpacity'\]/);
  assert.match(shell, /el\.addEventListener\('pointerdown'/, "draggable"); assert.match(shell, /p\.matePos = \{ x:/, "the spot is remembered"); assert.match(shell, /MATE_WEATHER = \{ temp: w\.temp, sky: sky\[1\], place: w\.place \}/, "the weather facts come from the chip");
  assert.match(app, /mateEvent\("open", \{ project: quote\.projectName \|\| "", status: quote\.status/, "the open event carries the status");
  // the inbox band never counts a submitted or closed-as-missed project overdue (6 Nov 2026)
  assert.match(shell, /var SUBMITTED_WORK = \{ 'Submitted':1, 'Tendered':1, 'Successful':1, 'Unsuccessful':1 \}/); assert.match(shell, /function frozenDueLabel\(status, deadline, submittedAt\)/);
  assert.match(shell, /frozenDueLabel\(st\.status, st\.deadline \|\| c\.deadline, st\.submittedAt\)\) \|\| \(c\.deadline \? dueLabel\(c\.deadline, now\) : null\)/, "the band reads the status before the countdown");
  assert.match(shell, /items\.forEach\(noteProjectStatus\); if\(INBOX_RECORD\) paintInboxBand\(\);/, "the welcome paint feeds the band the statuses");
  assert.match(asm, /__MATE_POSE_\$\{pose\.toUpperCase\(\)\}__/, "the assembler inlines the poses");
  for (const k of ["open", "done", "checklist", "saved", "status", "rfq", "jump"]) assert.match(app, new RegExp(`mateEvent\\("${k}"`), `the editor sends the ${k} event`);
});

// A removed project stays removed (13 Nov 2026: "there is an untitled project clicking underneath the listed projects" — a deleted / pruned index entry was put back by the tab's own save, ~1,800 index saves an hour)
await checkAsync("the projects index merges THREE ways: a removal sticks, an addition from elsewhere is kept, stamps compare as instants", async () => {
  const AM = await import("../src/lib/arrayMerge.js");
  const e = (id) => ({ id, storageKey: "gradcon-quote-" + id });
  const ids = (l) => l.map((x) => x.id).join(",");
  // the bug: the cloud still holds X, this tab removed it → the old union put it back
  let r = AM.mergeById([e("a"), e("b")], [e("a"), e("b"), e("x")], AM.idSet([e("a"), e("b"), e("x")]));
  assert.equal(ids(r.merged), "a,b", "an entry removed here is not put back by the cloud copy"); assert.equal(r.changed, false);
  // added elsewhere, never seen here → kept
  r = AM.mergeById([e("a"), e("b")], [e("a"), e("b"), e("n")], AM.idSet([e("a"), e("b")]));
  assert.equal(ids(r.merged), "a,b,n"); assert.deepEqual(r.added, ["n"]); assert.equal(r.changed, true);
  // removed elsewhere (in base, still here, gone from the cloud) → dropped here too
  r = AM.mergeById([e("a"), e("b"), e("c")], [e("a"), e("c")], AM.idSet([e("a"), e("b"), e("c")]));
  assert.equal(ids(r.merged), "a,c"); assert.deepEqual(r.dropped, ["b"]);
  // added here (not in base, not in the cloud) → kept; all four at once
  r = AM.mergeById([e("a"), e("mine")], [e("a"), e("x"), e("theirs")], AM.idSet([e("a"), e("x"), e("gone")]));
  assert.equal(ids(r.merged), "a,mine,theirs", "mine kept, theirs kept, x stays removed");
  // nothing synced yet → the old union
  r = AM.mergeById([e("a")], [e("b")], null); assert.equal(ids(r.merged), "a,b");
  // a clobbered cloud copy (most of the list missing) is never read as removals
  const many = Array.from({ length: 30 }, (_, i) => e("p" + i));
  r = AM.mergeById(many, [e("p0")], AM.idSet(many)); assert.equal(r.merged.length, 30, "a cloud copy that lost 29 of 30 entries removes nothing"); assert.deepEqual(r.dropped, []);
  r = AM.mergeById(many, many.slice(0, 27), AM.idSet(many)); assert.equal(r.merged.length, 27, "three removed elsewhere are dropped");
  // entries with no id (the rate-change log) are this tab's list as it stands — the old code emptied such a list
  r = AM.mergeById([{ at: 1 }, { at: 2 }], [{ at: 0 }], AM.idSet([])); assert.equal(r.merged.length, 2); assert.equal(r.changed, false);
  // stamps: PostgREST's spelling and the tab's own are the same instant
  assert.equal(AM.stampMs("2026-11-12T20:55:51.17+00:00"), AM.stampMs("2026-11-12T20:55:51.170Z"));
  assert.ok(AM.stampNotNewer("2026-11-12T20:55:51.17+00:00", "2026-11-12T20:55:51.170Z"), "the tab's own save echoed back is not newer");
  assert.ok(AM.stampNotNewer("2026-11-12T20:55:51+00:00", "2026-11-12T20:55:51.000Z"));
  assert.ok(!AM.stampNotNewer("2026-11-12T20:55:51.171+00:00", "2026-11-12T20:55:51.170Z"), "a millisecond later is newer");
  assert.ok(AM.stampNotNewer("2026-11-12T20:55:51.169+00:00", "2026-11-12T20:55:51.170Z"));
  assert.ok(!AM.stampNotNewer("2026-11-12T20:55:51.17+00:00", null), "nothing held: the cloud copy is newer");
  const st = fs.readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8");
  assert.match(st, /const res = mergeById\(toSave, current\.value, baseIdsRef\.current, removedHereRef\.current\);/, "the save merges three ways, honouring only the removals this tab made");
  assert.ok(!/updated_at !== lastSyncedAtRef\.current/.test(st) && !/updated_at <= lastSyncedAtRef\.current/.test(st), "no stamp is compared as text any more");
  assert.equal((st.match(/stampNotNewer\(/g) || []).length, 4, "load, poll (twice) and push compare instants");
  assert.equal((st.match(/noteSynced\(/g) || []).length, 5, "the base is noted on the mirror paint, the load, the save, the poll and the push");
  assert.match(st, /if \(valueRef\.current === started\) \{\s+remoteApplyRef\.current = true;\s+remoteValueRef\.current = res\.merged;\s+setValue\(res\.merged\);\s+\} else mergedNotInState = true;/, "a merged list never overwrites an edit made while the cloud was being read");
  // 23 Nov 2026: a value painted from storage is never re-saved as an edit, and an entry leaves the list only by a removal
  assert.match(st, /const applyRemote = \(next\) => \{\s+remoteValueRef\.current = next;/, "what came from storage is remembered by identity");
  const saveEffect = st.slice(st.indexOf("const prev = seenValueRef.current;"), st.indexOf("// Explicit \"Save\" button support"));
  assert.ok(saveEffect.length > 300);
  assert.ok(saveEffect.indexOf("if (Object.is(value, remoteValueRef.current)) {") > 0 && saveEffect.indexOf("if (Object.is(value, remoteValueRef.current)) {") < saveEffect.indexOf("saveTimer.current = setTimeout(doSave, 500);"), "the value that came from storage schedules no save, whatever order the effects ran in");
  assert.match(saveEffect, /if \(Object\.is\(value, prev\)\) return;/, "a run that changed nothing (mount, a key switch) saves nothing");
  assert.doesNotMatch(saveEffect, /if \(remoteApplyRef\.current\) \{/, "the one-shot flag no longer decides a save");
  assert.match(st, /const seenValueRef = useRef\(value\);/);
  assert.match(st, /if \(mergedNotInState && Array\.isArray\(toSave\)\) \{\s+const here = idSet\(valueRef\.current\);\s+baseIdsRef\.current = new Set\(\[\.\.\.idSet\(toSave\)\]\.filter\(\(id\) => here\.has\(id\)\)\);\s+\} else noteSynced\(toSave\);/, "the base never runs ahead of what the tab holds");
  const ent = (id) => ({ id });
  assert.deepEqual(AM.mergeById([ent("a")], [ent("a"), ent("b")], new Set(["a", "b"]), new Set()).merged.map((x) => x.id), ["a", "b"], "in the cloud, known, absent here and NOT removed here: put back");
  assert.deepEqual(AM.mergeById([ent("a")], [ent("a"), ent("b")], new Set(["a", "b"]), new Set(["b"])).merged.map((x) => x.id), ["a"], "removed here: stays removed");
  assert.deepEqual(AM.mergeById([ent("a")], [ent("a"), ent("b")], new Set(["a", "b"])).merged.map((x) => x.id), ["a"], "with no removal record the rule is as it was");
  assert.deepEqual(AM.mergeById([ent("a"), ent("b")], [ent("a")], new Set(["a", "b"]), new Set()).merged.map((x) => x.id), ["a"], "removed elsewhere is still dropped here");
  const dash = fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8");
  assert.match(dash, /projects\.filter\(\(p\) => !orphanKeys\.has\(p\.storageKey\)\)\.map\(/, "an entry with no data row is never listed");
  assert.match(dash, /if \(t\.n >= 10 \|\| now - t\.at < 20000\) return false;/, "the prune is asked at most once in 20 s, ten times in all");
});

await checkAsync("a server that does not answer is never 'not configured'; the build check asks for 8 bytes; a bar / sheet band says what its price is per (13 Nov 2026)", async () => {
  const SS = await import("../src/lib/serverStatus.js");
  const NG2 = await import("../src/lib/notifyGrady.js");
  const DF = await import("../src/lib/driveFiles.js");
  const C2 = await import("../src/lib/costing.js");
  // Vercel's disabled-project page: 402, plain text, no JSON
  const off = async () => ({ ok: false, status: 402, json: async () => { throw new Error("not json"); } });
  assert.match(SS.serverDownReason(402), /switched off by Vercel \(402 Payment required\)/);
  assert.match(SS.serverDownReason(402), /do not reload/);
  assert.match(SS.serverDownReason(0), /could not be reached/);
  assert.match(SS.serverDownReason(504), /did not answer \(504\)/);
  assert.equal(SS.failureReason({ status: 503, body: { error: "Google is not configured — set X" } }), "Google is not configured — set X", "the server's own words stand when it sent JSON");
  const ms = await NG2.mailSendStatus({ base: "https://portal.test", fetchImpl: off });
  assert.equal(ms.configured, false); assert.equal(ms.unreachable, true); assert.equal(ms.status, 402);
  assert.match(ms.reason, /switched off by Vercel/, "the checklist is told the hosting is off, not that Google is unset");
  const thrown = await NG2.mailSendStatus({ base: "https://portal.test", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(thrown.unreachable, true); assert.match(thrown.reason, /could not be reached/);
  const real = await NG2.mailSendStatus({ base: "https://portal.test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ configured: false, connected: false }) }) });
  assert.equal(real.configured, false); assert.ok(!real.reason, "a server that ANSWERS 'not configured' still reads as not configured");
  await assert.rejects(() => NG2.requestEmail({ subject: "s", text: "t" }, { base: "https://portal.test", fetchImpl: off }), /switched off by Vercel/);
  await assert.rejects(() => NG2.requestSms("x", { base: "https://portal.test", fetchImpl: off }), /switched off by Vercel/);
  await assert.rejects(() => NG2.notifyStatus({ base: "https://portal.test", fetchImpl: off }), /switched off by Vercel/);
  await assert.rejects(() => DF.driveApi({ action: "status" }, off), (e) => /switched off by Vercel/.test(e.message) && e.status === 402 && e.serverDown === true);
  await assert.rejects(() => DF.driveApi({ action: "status" }, async () => ({ ok: false, status: 409, json: async () => ({ error: "Reconnect for Drive", needsReconnect: true }) })), (e) => e.message === "Reconnect for Drive" && e.needsReconnect === true && !e.serverDown);
  const tc = fs.readFileSync(new URL("../src/components/TenderChecklist.jsx", import.meta.url), "utf8");
  assert.match(tc, /mail\.reason \? mail\.reason : !mail\.configured \?/, "the checklist prints the reason before it says 'not configured'");
  const rfq = fs.readFileSync(new URL("../src/components/RfqModal.jsx", import.meta.url), "utf8");
  assert.match(rfq, /reason: failureReason\(rep\)/); assert.match(rfq, /mail\.reason \? `\$\{mail\.reason\} Drafts can be built/);
  // the shell: the build check reads build.txt, never the whole page; a 402 shows the hosting notice and it clears itself
  const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  assert.ok(!/\?build-check=/.test(shell), "the build check no longer downloads the page");
  assert.match(shell, /const res = await fetch\("\/build\.txt\?" \+ Date\.now\(\), \{cache:"no-store"\}\);\s+if\(res\.status === 402\)\{ hostingOff\(\); return; \}/);
  assert.match(shell, /function hostingOff\(\)\{[\s\S]{0,700}data-kind", "hosting-off"/);
  assert.match(shell, /hostingBack\(\);\s+if\(live && live !== shaOf\(RUNNING\)\)/, "the notice clears the moment the site answers again");
  // the columns
  const cat = (k) => FULL_CATALOG.find((c) => c.key === k);
  assert.deepEqual([C2.columnBasis(cat("STOCK BAR")).price, C2.columnBasis(cat("STOCK BAR")).weight], ["$ / bar", "kg / bar"]);
  assert.deepEqual([C2.columnBasis(cat("SQUARE MESH")).price, C2.columnBasis(cat("SQUARE MESH")).weight], ["$ / sheet", "kg / sheet"]);
  assert.deepEqual([C2.columnBasis(cat("PROCESSED BAR")).price, C2.columnBasis(cat("PROCESSED BAR")).weight], ["$ / tonne", "kg / m"]);
  assert.equal(C2.columnBasis(cat("REINFORCEMENT BY RATE")).price, "$ / tonne");
  assert.equal(C2.columnBasis(cat("CONCRETE")).price, "Unit $"); assert.equal(C2.columnBasis(cat("TRENCH MESH")).price, "$ / length");
  // every basis computeRowTotal prices by has its words (a band with a basis flag never reads plain "Unit $")
  FULL_CATALOG.forEach((c) => { if (c.lengthBasis || c.metresEntry || c.areaBasis || c.weightBasis || c.volumeRateBasis) assert.notEqual(C2.columnBasis(c).price, "Unit $", c.key); });
  // Boma's row: 112 m of N12 = 19 whole bars × $9.96 = $189.24 (not 112 × $9.96)
  const sb = cat("STOCK BAR"); const n12 = sb.products.map((p) => (Array.isArray(p) ? { name: p[0], unit: p[1], unitWeight: p[2], unitCost: p[3], barLength: p[5] } : p)).find((p) => p.name === "N12 - 6.0m length");
  assert.equal(Math.round(C2.computeRowTotal(sb, { unitCost: n12.unitCost, unitWeight: n12.unitWeight, barLength: n12.barLength }, 112, { concreteM3: 0 }) * 100) / 100, 189.24);
  const cb = fs.readFileSync(new URL("../src/components/CategoryBlock.jsx", import.meta.url), "utf8");
  assert.match(cb, /const basis = columnBasis\(cat\);/); assert.match(cb, /data-testid="col-unit-cost" title=\{basis\.priceNote\}>\{basis\.price\}/);
  assert.match(cb, /data-testid="row-sum"/, "a whole-bar / whole-sheet row prints the sum behind its total");
});

check("Compile assumptions (21 Nov 2026): what was measured comes off the takeoff's own register lines (net), assumptions off defaults / rates / overrides, exclusions off switches and the Scope finder; inferred lines start unticked; the push UPDATES the project's Assumptions — never doubles, never touches a typed one", () => {
  const box = { console }; box.globalThis = box;
  runInNewContext(fs.readFileSync(new URL("../portal/estimates-basis.js", import.meta.url), "utf8"), box, { filename: "estimates-basis.js" });
  assert.equal(box.BASIS_HANDOFF_KEY, EB.ESTIMATE_BASIS_KEY, "Estimates and Quotes agree on the hand-off key");
  assert.equal(box.basisDocKey("t1"), "gradcon-basis::t1", "the estimator's ticks live in their own row, never in the takeoff");
  const L = (g, m, q, u, x = {}) => ({ materialGroup: g, material: m, qty: q, finalQty: q * 1.05, unit: u, spec: "", ...x });
  const input = () => ({
    project: { name: "12 Beach Road", drawingRev: "S1-S6 Rev C", specRev: "Spec Rev B", revision: "Rev A", wasteStr: "2.5–15% by work type", reoWastePct: 5, barLapPct: 8, meshLapPct: 5, formWastePct: 5, bulkingPct: 15 },
    elements: [
      { id: "EL1", label: "Raft Slab A", type: "RC Raft Slab", ground: true, nativeExc: false, data: {}, geometry: { countNo: 1, runM: 0, areaM2: 120 }, assumed: { grade: 32, cover: 40 }, status: "reviewed",
        lines: [L("Concrete", "N32 concrete", 36, "m³"), L("Reinforcement", "SL92", 120, "m²", { weightKg: 630 }), L("Reinforcement", "N12", 500, "m", { weightKg: 466.2 }), L("Connections", "Drill & epoxy", 30, "no.", { weightKg: 0 }), L("Formwork", "Edgeform", 44, "m"), L("Base/Blinding", "Blinding concrete", 6, "m³"), L("Vapour Barrier", "0.2mm poly", 120, "m²")] },
      { id: "EL2", label: "SF1", type: "Strip Footing", ground: true, nativeExc: true, data: { excOn: false }, geometry: { countNo: 1, runM: 60, areaM2: 0 }, assumed: { grade: 0, cover: 0 }, status: "draft", reoRate: { basis: "m3", rate: 90, kg: 810 },
        lines: [L("Concrete", "N25 concrete", 9, "m³"), L("Reinforcement", "N16", 513, "m", { weightKg: 850.5 })] },
      { id: "EL3", label: "Pads", type: "Pad Footing", ground: true, nativeExc: true, data: {}, geometry: { countNo: 4 }, assumed: {}, status: "draft", decisions: [{ label: "Vapour barrier", decision: "excluded", reason: "not shown" }],
        lines: [L("Concrete", "N32 concrete", 2, "m³", { manualOverride: true, finalQty: 2.5, calculatedQty: 2.1, overrideReason: "haunch", overrideKey: "k" }), L("Excavation", "Excavation", 5, "m³"), L("Excavation", "Spoil disposal (loose, bulked)", 5.75, "m³"), L("Excavation", "Rock breaking", 3, "m³", { spec: "Scoped allowance — estimating item, not design" })] },
      { id: "EL4", label: "Empty wall", type: "Wall", lines: [], status: "draft" },
      { id: "EL5", label: "RW1", type: "Retaining Wall", ground: true, nativeExc: true, data: { incBase: false }, geometry: {}, assumed: {}, status: "reviewed", lines: [L("Concrete", "N32 concrete", 4, "m³"), L("Reinforcement", "N16", 100, "m", { weightKg: 158 }), L("Formwork", "Walls", 30, "m²"), L("Excavation", "Excavation", 2, "m³")] },
    ],
    scope: { exclusions: [{ text: "Waterproofing membranes.", doc: "Tender letter" }], others: [{ title: "Site survey and set-out" }] },
  });
  const c = box.compileBasis(input());
  const by = (k) => c.lines.filter((l) => l.kind === k).map((l) => l.text);
  const M = by("measured"), A = by("assumption"), X = by("exclusion");
  // what was measured — from the lines
  assert.equal(M[0], "Measured from: drawings S1-S6 Rev C; specification Spec Rev B (takeoff Rev A).");
  assert.equal(M[1], "Raft Slab A (RC Raft Slab) — 120 m²; N32 concrete 36 m³; reinforcement 1.04 t (incl. SL92 mesh 120 m²); formwork 44 lm; blinding concrete 6 m³; vapour barrier / membrane 120 m².", "NET quantities: the mesh and bar kg come back off the waste (630 + 466.2 = 1,096.2 kg final ÷ 1.05), the weightless holes are not steel");
  assert.equal(M[2], "SF1 (Strip Footing) — 60 lm; N25 concrete 9 m³; reinforcement 810 kg.");
  assert.match(M[3], /^Pads \(Pad Footing\) — 4 no\.; N32 concrete 2\.5 m³; excavation 8 m³ \(spoil 5\.8 m³ loose\)\.$/, "a manual override IS the measured figure");
  assert.ok(!M.some((t) => /Empty wall/.test(t)), "an element with nothing measured is not listed…");
  assert.ok(c.notes.some((n) => n.kind === "empty" && /Empty wall/.test(n.text)), "…the panel says so instead");
  assert.ok(c.notes.some((n) => n.kind === "unreviewed" && /^3 of 5 elements not marked reviewed/.test(n.text)));
  assert.match(M[M.length - 1], /^Totals as measured, net — concrete 51\.5 m³ \(N25 9, N32 42\.5\); reinforcement 2 t; formwork 30 m² \+ 44 lm; excavation 10 m³\.$/);
  // assumptions
  assert.ok(A.some((t) => t === "Quantities are net as measured from the documents; the price allows for ordering waste and laps on top (concrete waste 2.5–15% by work type; reinforcement 5% waste, 8% bar laps, 5% mesh laps; formwork 5% waste)."));
  assert.ok(A.includes("Spoil is measured loose, bulked 15% over the in-ground volume."));
  assert.ok(A.includes("Concrete grade N32 is assumed (the project default — not confirmed from the specification) for: Raft Slab A."), "only an element still on the default is named");
  assert.ok(A.includes("Cover to reinforcement of 40 mm is assumed (default — exposure classification not confirmed) for: Raft Slab A."));
  assert.ok(A.includes("SF1: reinforcement is allowed at 90 kg per m³ of concrete (810 kg) — no bar schedule was measured."));
  assert.ok(A.includes("Pads: N32 concrete taken as 2.5 m³ in place of the calculated 2.1 — haunch."));
  assert.ok(A.includes("Pads: an allowance is made for rock breaking — 3 m³ (an estimating allowance, not a design quantity)."));
  // exclusions: switches and documents are sure; absence is inferred
  const sure = c.lines.filter((l) => l.kind === "exclusion" && l.sure).map((l) => l.text), unsure = c.lines.filter((l) => l.kind === "exclusion" && !l.sure).map((l) => l.text);
  assert.deepEqual([...sure], ["Pads: vapour barrier — not shown.", "The footing / base of RW1 — the wall stem only is measured.", "Excavation, spoil removal and backfill to: SF1.", "Waterproofing membranes (as stated in Tender letter).", "Site survey and set-out — by others."]);
  assert.deepEqual([...unsure], ["Excavation and spoil removal to: Raft Slab A (none measured on the takeoff).", "Reinforcement to: Pads (none measured on the takeoff).", "Formwork to: SF1, Pads (none measured on the takeoff)."]);
  assert.equal(new Set(c.lines.map((l) => l.id)).size, c.lines.length, "ids are unique");
  assert.deepEqual(box.compileBasis(input()).lines.map((l) => l.id), c.lines.map((l) => l.id), "…and stable across compiles");
  assert.equal(box.compileBasis({ elements: [] }).lines.length, 0, "an empty takeoff compiles to nothing — no line is invented");
  // the estimator's document
  let doc = box.emptyBasisDoc("t1");
  let lines = box.basisLines(c, doc);
  assert.ok(lines.filter((l) => !l.sure).every((l) => !l.on) && lines.filter((l) => l.sure).every((l) => l.on), "a line read from a switch or a figure starts ticked, an inferred one never");
  const gradeId = c.lines.find((l) => /Concrete grade N32/.test(l.text)).id, coverId = c.lines.find((l) => /Cover to/.test(l.text)).id, sfId = c.lines.find((l) => /^SF1 \(/.test(l.text)).id;
  doc = box.basisEditPatch(doc, gradeId, { text: "Grades as nominated on the drawings.", auto: lines.find((l) => l.id === gradeId).auto }, "2026-11-21T01:00:00Z", "boma");
  doc = box.basisEditPatch(doc, coverId, { on: false }, "2026-11-21T01:00:01Z", "boma");
  doc = box.basisAddCustom(doc, "exclusion", "Traffic management", "2026-11-21T01:00:02Z", "boma");
  lines = box.basisLines(c, doc);
  const g = lines.find((l) => l.id === gradeId);
  assert.ok(g.edited && !g.stale && g.text === "Grades as nominated on the drawings." && !lines.find((l) => l.id === coverId).on);
  assert.ok(lines.some((l) => l.custom && l.kind === "exclusion" && l.text === "Traffic management" && l.on));
  // quantities off: the kinds of work, no figure; the totals line drops out; a reworded line is not called stale by the switch
  const plainDoc = box.basisEditPatch(doc, null, { showQty: false }, "2026-11-21T01:00:03Z");
  const plain = box.basisLines(c, plainDoc);
  assert.equal(plain.find((l) => l.id === sfId).text, "SF1 (Strip Footing) — N25 concrete, reinforcement.");
  assert.ok(!plain.some((l) => /^Totals as measured/.test(l.text)) && !plain.find((l) => l.id === gradeId).stale);
  // the takeoff moves under a reworded line → flagged; putting the takeoff's wording back clears the edit
  const moved = input(); moved.elements[1].assumed = { grade: 32, cover: 0 };
  const g2 = box.basisLines(box.compileBasis(moved), doc).find((l) => l.id === gradeId);
  assert.ok(g2.stale && g2.text === "Grades as nominated on the drawings." && /Raft Slab A, SF1/.test(g2.auto), "the estimator's wording stands, and the panel says the takeoff changed underneath");
  assert.ok(!box.basisLines(c, box.basisEditPatch(doc, gradeId, { text: "" })).find((l) => l.id === gradeId).edited);
  // two devices: the newer tick per line, typed lines by id less the removed ones
  const other = box.basisRemoveCustom(box.basisEditPatch(doc, coverId, { on: true }, "2026-11-21T02:00:00Z"), doc.custom[0].id, "2026-11-21T02:00:01Z");
  const merged = box.mergeBasisDocs(doc, other);
  assert.ok(merged.edits[coverId].on === true && merged.custom.length === 0 && merged.edits[gradeId].text === "Grades as nominated on the drawings.");
  // the push: ticked lines only, in the three kinds' order
  const payload = box.basisPayload(lines, { takeoffId: "t1", estimateSessionId: "S1", projectName: "12 Beach Road", by: "boma", at: "2026-11-21T03:00:00Z" });
  assert.ok(payload.lines.every((l) => l.id && l.text && ["measured", "assumption", "exclusion"].includes(l.kind)));
  assert.equal(payload.lines.length, box.basisCounts(lines).total);
  assert.ok(!payload.lines.some((l) => l.id === coverId || /none measured/.test(l.text)), "an unticked or inferred line is not sent");
  assert.deepEqual([...new Set(payload.lines.map((l) => l.kind))], ["measured", "assumption", "exclusion"]);
  assert.match(box.basisText(lines), /^WHAT WAS MEASURED\n- Measured from:[\s\S]*\n\nASSUMPTIONS\n- [\s\S]*\n\nEXCLUSIONS\n- /);
  // ---- Quotes side ----
  assert.equal(EB.basisEntryText({ kind: "measured", text: "SF1 — 9 m³." }), "Measured: SF1 — 9 m³.");
  assert.equal(EB.basisEntryText({ kind: "measured", text: "Measured from: drawings Rev C." }), "Measured from: drawings Rev C.", "never 'Measured: Measured from'");
  assert.equal(EB.basisEntryText({ kind: "exclusion", text: "Traffic management" }), "Excluded: Traffic management");
  assert.equal(EB.basisEntryText({ kind: "assumption", text: " Net  quantities. " }), "Net quantities.");
  const mine = [{ id: "a1", text: "Access via the rear lane", tenderText: "Access is assumed via the rear lane.", tenderSource: "Access via the rear lane" }];
  const r1 = EB.mergeBasisAssumptions(mine, payload);
  assert.equal(r1.added, payload.lines.length); assert.equal(r1.updated + r1.left + r1.kept + r1.unchanged, 0);
  assert.deepEqual(r1.assumptions[0], mine[0], "an assumption typed in Quotes keeps its place, its text and its tender wording");
  assert.ok(r1.assumptions.slice(1).every((a) => a.source === "estimates" && a.id.startsWith("est:") && a.pushedText === a.text && a.takeoffId === "t1"));
  const r1b = EB.mergeBasisAssumptions(r1.assumptions, payload);
  assert.equal(r1b.unchanged, payload.lines.length); assert.equal(r1b.assumptions.length, r1.assumptions.length, "the same push twice doubles nothing");
  // second push: one line reworded in Estimates, one unticked, one retyped in Quotes, one given tender wording
  const totalsEntry = r1.assumptions.find((a) => /^Measured: Totals/.test(a.text)), sfEntry = r1.assumptions.find((a) => /^Measured: SF1/.test(a.text)), netEntry = r1.assumptions.find((a) => /^Quantities are net/.test(a.text));
  const inQuotes = r1.assumptions.map((a) => (a.id === totalsEntry.id ? { ...a, text: "Measured: totals are indicative only." } : a.id === netEntry.id ? { ...a, tenderText: "Our price is based on net measured quantities.", tenderSource: a.text } : a));
  const p2 = { ...payload, at: "2026-11-21T04:00:00Z", lines: payload.lines.filter((l) => !/Waterproofing/.test(l.text)).map((l) => (/^SF1 \(/.test(l.text) ? { ...l, text: "SF1 (Strip Footing) — 72 lm; N25 concrete 10.8 m³." } : /^Totals/.test(l.text) ? { ...l, text: "Totals as measured, net — concrete 53.3 m³." } : l)) };
  const r2 = EB.mergeBasisAssumptions(inQuotes, p2);
  assert.deepEqual([r2.added, r2.updated, r2.left, r2.kept], [0, 1, 1, 1]);
  assert.equal(r2.assumptions.find((a) => a.id === sfEntry.id).text, "Measured: SF1 (Strip Footing) — 72 lm; N25 concrete 10.8 m³.", "a pushed line follows the takeoff");
  assert.equal(r2.assumptions.find((a) => a.id === totalsEntry.id).text, "Measured: totals are indicative only.", "a line retyped in Quotes stands");
  assert.ok(r2.assumptions.some((a) => /Waterproofing/.test(a.text)), "a line no longer sent STAYS — a push never deletes what is already there (Boma, 21 Nov 2026)");
  assert.equal(r2.assumptions.length, inQuotes.length, "…so the list never gets shorter");
  assert.deepEqual(r2.assumptions.map((a) => a.id), inQuotes.map((a) => a.id), "…and every entry keeps its place");
  assert.equal(r2.assumptions.find((a) => a.id === netEntry.id).tenderText, "Our price is based on net measured quantities.", "accepted tender wording is kept");
  assert.equal(new Set(r2.assumptions.map((a) => a.id)).size, r2.assumptions.length);
  const empty = EB.mergeBasisAssumptions(r2.assumptions, { ...p2, lines: [] });
  assert.ok(empty.assumptions.length === r2.assumptions.length && empty.left === r2.assumptions.length - 1 && empty.added === 0, "an empty push removes nothing");
  // a line the list has never held goes on the END, after everything already there
  const r3 = EB.mergeBasisAssumptions(r2.assumptions, { ...p2, lines: [...p2.lines, { id: "bx_new", kind: "exclusion", text: "Traffic management" }] });
  assert.ok(r3.added === 1 && r3.assumptions[r3.assumptions.length - 1].text === "Excluded: Traffic management");
  assert.match(EB.basisResultText(r2), /^1 updated, \d+ unchanged, 1 kept as retyped here, 1 pushed earlier left in place$/);
  // WHERE it goes: a project with packages is always asked; the write is one list of the quote, nothing else
  const packed = { projectName: "57 Back Beach Road", assumptions: [{ id: "pa1", text: "Ligatures to raft beams not included" }],
    packages: [{ id: "pkA", name: "MAIN BUILDING", assumptions: [{ id: "ka1", text: "Kooltherm K3 adopted" }] }, { id: "pkB", name: "EXTERNAL WORKS", assumptions: [{ id: "kb1", text: "Sealers not included" }] }] };
  assert.ok(EB.basisNeedsDestination(packed) && !EB.basisNeedsDestination({ assumptions: [] }) && !EB.basisNeedsDestination({ packages: [] }));
  assert.deepEqual(EB.basisDestinations(packed).map((d) => [d.id, d.kind, d.count]), [["pkA", "package", 1], ["pkB", "package", 1], ["", "project", 1]], "each package, then the project-wide list");
  assert.equal(EB.basisLastDestination(packed, payload), null, "a first push suggests nothing");
  const toPkg = EB.applyBasisToQuote(packed, payload, "pkA");
  assert.deepEqual(Object.keys(toPkg.patch), ["packages"], "a push to a package writes the packages only");
  const afterPkg = { ...packed, ...toPkg.patch };
  assert.deepEqual(afterPkg.packages[0].assumptions[0], packed.packages[0].assumptions[0], "the package's own assumption is first and untouched");
  assert.equal(afterPkg.packages[0].assumptions.length, 1 + payload.lines.length);
  assert.deepEqual(afterPkg.packages[1], packed.packages[1], "the other package is not touched"); assert.deepEqual(afterPkg.assumptions, packed.assumptions, "nor the project-wide list");
  assert.deepEqual(toPkg.where, { packageId: "pkA", name: "MAIN BUILDING" });
  assert.equal(EB.basisLastDestination(afterPkg, payload), "pkA", "the next push suggests where the last one went — and still asks");
  const toProject = EB.applyBasisToQuote(afterPkg, payload, EB.BASIS_PROJECT_WIDE);
  assert.deepEqual(Object.keys(toProject.patch), ["assumptions"]);
  assert.ok(toProject.patch.assumptions[0].id === "pa1" && toProject.patch.assumptions.length === 1 + payload.lines.length && toProject.result.added === payload.lines.length, "another destination only ADDS there — the package keeps its lines");
  assert.equal(EB.applyBasisToQuote(packed, payload, "gone"), null, "a package that is not on the quote is never written");
  assert.equal(EB.applyBasisToQuote(packed, { lines: "x" }, "pkA"), null);
  // which project: the takeoff's own published project, else ONE of that name; anything else is asked
  const projects = [{ id: "p1", name: "12 Beach Road, Rye VIC 3941", nameSource: "12 Beach Road", estimateSessionId: null }, { id: "p2", name: "5 Other Street", estimateSessionId: "S1" }, { id: "p3", name: "12 beach road", estimateSessionId: null }];
  assert.equal(EB.matchBasisProject(payload, projects).match.id, "p2", "the project this takeoff was published to wins");
  const noSession = { ...payload, estimateSessionId: null };
  const amb = EB.matchBasisProject(noSession, projects);
  assert.ok(amb.match === null && amb.candidates.length === 2, "two projects of that name: asked, never guessed");
  assert.equal(EB.matchBasisProject(noSession, projects.slice(0, 2)).match.id, "p1", "one project first typed under that name");
  assert.equal(EB.matchBasisProject({ ...noSession, projectName: "Somewhere else" }, projects).match, null);
  assert.equal(EB.matchBasisProject({ ...noSession, projectName: "" }, projects).match, null, "an unnamed takeoff never matches by name");
  assert.ok(EB.validBasisPayload(payload) && !EB.validBasisPayload({}) && !EB.validBasisPayload(null));
  // ---- wiring ----
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  assert.match(est, /<script src="estimates-basis\.js"><\/script>/, "the page loads the pure module");
  assert.match(fs.readFileSync(new URL("./assemble-portal.mjs", import.meta.url), "utf8"), /estimates-app\.html no longer loads estimates-basis\.js — inline step out of date/, "…and the assembler inlines it, asserted");
  assert.match(est, /id="basisBtn"[^>]*data-testid="basis-button"/); assert.match(est, /id="basisPanel"[^>]*data-testid="basis-panel"/);
  const blk = est.slice(est.indexOf("COMPILE ASSUMPTIONS (21 Nov 2026)"), est.indexOf("basisInit();\napplyAiHandoff();"));
  assert.ok(blk.length > 2000, "the block is found");
  assert.ok(!/saveEstimateState\(|pushTakeoffToCloud\(|addInstance\(|computeAllAndRefresh\(/.test(blk.replace(/\/\*[\s\S]*?\*\//g, "")), "compiling and pushing never write the takeoff");
  assert.match(blk, /lines:\(out&&out\.lines\)\|\|\[\], geometry:elementGeometry\(inst\)/, "what was measured is read off each element's own register lines and published geometry");
  assert.match(blk, /fieldProvenance\(inst,f,defaults\)==="default"/, "an assumed grade / cover is one nobody typed over");
  assert.match(blk, /localStorage\.setItem\(BASIS_HANDOFF_KEY, JSON\.stringify\(payload\)\)/); assert.match(blk, /type:"gradcon:open-app", target:"quotes"/);
  assert.equal((blk.match(/localStorage\.setItem\(BASIS_HANDOFF_KEY/g) || []).length, 1, "ONE hand-off write");
  assert.match(blk, /function basisTextChanged\(t\)\{[\s\S]*?basisSave\(\);/, "a reworded line is saved without repainting the panel under the click");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(!found\.match\) \{\s*\n\s*setBasisPush\(\{ stage: "choose"/, "no single project: the estimator picks");
  // the write is the OPEN EDITOR's own (21 Nov 2026: a patch behind the editor was overwritten by its next save and 29 lines were lost)
  const recv = app.slice(app.indexOf("const receiveBasis = async"), app.indexOf("const dropBasisHandoff"));
  assert.ok(recv.length > 300 && !/patchQuoteFields|writeQuote|mergeBasisAssumptions|applyBasisToQuote/.test(recv), "the App level only finds the project and opens it — it never writes the row behind the editor");
  assert.match(recv, /setBasisPush\(\{ stage: "apply", payload, projectId: found\.match\.id, projectName: found\.match\.name \}\);\s*\n\s*setActiveId\(found\.match\.id\);/);
  assert.ok(!/patchQuoteFields/.test(app.slice(0, app.indexOf("function ProjectEditor("))), "…and no other App-level path patches a quote for a push");
  assert.match(app, /const basisReady = !!basisPush && quoteLoaded && quoteStatus !== "loading";/, "the editor waits for the project's row before it applies anything");
  assert.match(app, /const basisAsk = basisReady && basisNeedsDestination\(quote\) && basisDoneRef\.current !== basisPush\.payload\.at;/, "a project with packages is ALWAYS asked which package");
  assert.match(app, /setQuote\(\(q\) => \{ const o = applyBasisToQuote\(q, payload, packageId\); return o \? \{ \.\.\.q, \.\.\.o\.patch \} : q; \}\);/, "the lines are written through the editor's own setQuote, on the state as it stands");
  assert.match(app, /if \(basisReady && !basisNeedsDestination\(quote\)\) applyBasis\(BASIS_PROJECT_WIDE\);/, "a plain project has the one list and is not asked");
  assert.match(app, /if \(packageId\) openPkg\(packageId\); else setProjGeoOpen\(true\);/, "the destination is unfolded so the lines are in view");
  const bn = fs.readFileSync(new URL("../src/components/BasisPushNotice.jsx", import.meta.url), "utf8");
  assert.match(bn, /data-testid="basis-push-where"/); assert.match(bn, /disabled=\{value === null\} onClick=\{\(\) => onWhere\(value\)\}/, "nothing is added until a destination is picked");
  const pg = fs.readFileSync(new URL("../src/components/ProjectGeometryPanel.jsx", import.meta.url), "utf8");
  assert.match(pg, /a\.source === "estimates" && \(\s*\n\s*<div[^>]*data-testid="assumption-from-estimates"/, "the Assumptions list marks a pushed line");
});

check("Beam steel (22 Nov 2026): trench mesh AND bar sets can be used in the same beam — one reading, unset = the older either / or", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const m = est.match(/function beamSteelMix\(trench,both\)\{[^\n]*\}/);
  assert.ok(m, "the ONE reading exists");
  const mix = new Function(m[0] + "\nreturn beamSteelMix;")();
  assert.deepEqual({ ...mix(undefined, undefined) }, { mesh: false, bars: true, both: false }, "nothing ticked (and every older takeoff): bar sets only");
  assert.deepEqual({ ...mix(true, undefined) }, { mesh: true, bars: false, both: false }, "'Trench mesh instead' alone: the mesh only, as before");
  assert.deepEqual({ ...mix(true, true) }, { mesh: true, bars: true, both: true }, "both ticks: mesh and bars");
  assert.deepEqual({ ...mix(false, true) }, { mesh: true, bars: true, both: true }, "the both tick alone is both — it never needs the first tick");
  // the calculators: two independent branches, never an else
  const inner = est.slice(est.indexOf("function raftBeamGroupLinesInner("), est.indexOf("if(g.ligsOn){", est.indexOf("function raftBeamGroupLinesInner(")));
  assert.match(inner, /const mix=beamSteelMix\(g\.trench,g\.both\);\s*\n\s*if\(mix\.mesh\)\{/);
  assert.match(inner, /\n    \}\n    if\(mix\.bars\)\{\n      \(g\.rows\|\|\[\]\)\.forEach/, "the bar sets are priced beside the mesh, not instead of it");
  assert.ok(!/\} else \{/.test(inner), "no either / or left in the slab beam steel");
  assert.match(est, /trench:d\.edgeBeamTrenchMesh, both:d\.edgeBeamTrenchBars,/, "edge beam");
  assert.match(est, /trench:d\.beamStripsTrenchMesh, both:d\.beamStripsTrenchBars,/, "internal beam strips");
  assert.match(est, /trench:g\.trenchMesh, both:g\.trenchBars,/, "every extra beam group");
  assert.match(est, /g\.trenchBars=!!d\[p\+"TrenchBars"\];/, "a beam duplicated from the primary keeps the choice");
  assert.match(est, /const steelMix=beamSteelMix\(d\.trenchMesh,d\.trenchMeshBars\);\n  if\(steelMix\.mesh\)\{[\s\S]{0,1400}?\n  \}\n  if\(steelMix\.bars\)\{\n    d\.reoRows\.forEach/, "the standalone beam the same");
  // the cards: the second tick sits beside the first, and the table follows the reading
  for (const f of ['"edgeBeamTrenchBars",d.edgeBeamTrenchBars', '"beamStripsTrenchBars",d.beamStripsTrenchBars', 'base+"trenchBars",g.trenchBars', '"trenchMeshBars",d.trenchMeshBars']) {
    assert.ok(est.includes(`chk(${f},BEAM_BOTH_LABEL,null,true)`), `the both tick is on the card (${f})`);
  }
  assert.match(est, /beamSteelMix\(d\.edgeBeamTrenchMesh,d\.edgeBeamTrenchBars\)\.bars\? raftBeamReoTable\(inst,d\.edgeBeamRows,"edgeBeamRows"\) : ""/);
  assert.match(est, /<div class="subsec \$\{steelMix\.bars\?'':'hidden'\}" data-steel="bars">/, "the beam's bar table shows whenever bars are priced");
  assert.ok(!est.includes('data-show-if="trenchMesh_off"'), "the old hide-the-bars toggle is gone from the beam");
  // spec strings are unchanged, so a manual override keyed on them still applies
  assert.match(inner, /spec:`\$\{g\.label\} — trench mesh \(longitudinal\)\$\{layerNote\}`/); assert.match(inner, /spec:`\$\{g\.label\} — \$\{r\.position\}\$\{layerNote\}`/);
});

check("Vertical insulation (22 Nov 2026): twelve m² rows on the INSULATION band, each at its flat board's figure; Estimates measures run × height × faces and lands on them", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "INSULATION");
  const vert = cat.products.filter((p) => /^Vertical insulation/.test(p.name));
  assert.equal(vert.length, 12, "twelve vertical rows");
  assert.ok(vert.every((p) => p.unit === "m2" && p.unitCost > 0), "every row is m² of face and priced");
  assert.equal(cat.products.length, 51);
  // each row is the same board as the flat row of that material and thickness, at that row's own seed
  const flat = (n) => cat.products.find((p) => p.name === n);
  vert.forEach((p) => {
    const board = p.name.replace(/^Vertical insulation — /, "");
    const twin = /other/.test(p.name) ? flat("Insulation (other — specify in description)") : flat(board) || flat(board.replace("Kooltherm K3 ", "Kooltherm K3 Floorboard "));
    assert.ok(twin, `${p.name} has a flat twin`);
    assert.equal(p.unitCost, twin.unitCost, `${p.name} is seeded at its flat board's figure`);
  });
  const key = rateKey("INSULATION", "Vertical insulation — XPS rigid board 50mm (R1.47)", "m2");
  const item = { id: "v", typeId: "raft_slab", qtys: { [key]: 24 }, tasks: [], additional: [] };
  assert.equal(computeElementCost(item, defaultRates()).categoryTotals["INSULATION"], 24 * 26, "24 m² of face at $26 = $624");
  // Estimates: the names are the catalog's, verbatim
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const boards = JSON.parse(est.match(/const INS_VERT_BOARDS=(\[[^\]]*\]);/)[1]);
  const other = JSON.parse(est.match(/const INS_VERT_OTHER=("[^"]*");/)[1]);
  assert.deepEqual(boards.map((b) => `Vertical insulation — ${b}`).concat([other]), vert.map((p) => p.name), "Estimates lists exactly the catalog's vertical rows, in order");
  // the ONE arithmetic, run out of the page source
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const calc = new Function("num", est.match(/function insVertCalc\(r, autoRun\)\{[\s\S]*?\n\}/)[0] + "\nreturn insVertCalc;")(num);
  assert.equal(calc({ runM: 40, heightMm: 600 }, 0).area, 24, "40 m × 600 mm = 24 m²");
  assert.equal(calc({ runM: 40, heightMm: 600, faces: 2 }, 0).area, 48, "both faces = 48 m²");
  assert.equal(calc({ heightMm: 300 }, 60).area, 18, "a blank run takes the element's own (60 m × 300 mm)");
  assert.equal(calc({ runM: 40, heightMm: 600, areaM2: 31.5 }, 0).area, 31.5, "a typed area wins");
  assert.equal(calc({ runM: 40 }, 0).area, 0, "no height prices nothing");
  assert.equal(calc({}, 60).any, false, "an untouched row is nothing — the element's run alone never makes a line");
  // wiring
  assert.ok(est.includes("insulationSubsection(inst.data) + verticalInsulationSection(inst)"), "the table sits on every Blinding / Insulation tab, under the under-slab board");
  assert.match(est, /leaf==="insVertRows"\? \{name:"", product:INS_VERT_DEFAULT/, "its own add-row template, ahead of the generic Rows rule");
  assert.ok(est.indexOf('leaf==="insVertRows"') < est.indexOf("/Rows$/.test(leaf)"));
  assert.match(est, /computeVerticalInsulation\(inst,def,out\);/);
  assert.match(est, /materialGroup:"Insulation",material:insVertProduct\(r\),spec:`Vertical insulation/);
  assert.match(est, /function insVertRows\(d\)\{ return Array\.isArray\(d&&d\.insVertRows\)\? d\.insVertRows : \[\]; \}/, "the table never creates the array on render");
  // the bridge lands a published line on its own row by name
  const { quote, flags } = buildImportFromEstimate({ project: {}, lines: [
    { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL08",
      materialGroup: "Insulation", material: "Vertical insulation — Kooltherm K3 80mm (R3.60)", spec: "Vertical insulation — edge beam", unit: "m²", finalQty: 25.2 },
  ] });
  assert.equal(quote.items[0].qtys[rateKey("INSULATION", "Vertical insulation — Kooltherm K3 80mm (R3.60)", "m2")], 25.2);
  assert.ok(!flags.some((f) => /Vertical insulation/.test(f)), "…unflagged");
});

check("Slabmate (22 Nov 2026): Foilboard's 70 kPa under-slab EPS in five thicknesses and Slabmate Pro (185 kPa) in two, seeded ex GST from the published pack prices; every Estimates insulation choice names a catalog row", () => {
  const cat = FULL_CATALOG.find((c) => c.key === "INSULATION");
  const price = (n) => { const p = cat.products.find((x) => x.name === n); assert.ok(p, n); assert.equal(p.unit, "m2"); return p.unitCost; };
  // pack price inc GST, the pack's m² (sheets × 2.88), as read off the supplier's pages
  const packs = [
    ["Slabmate under-slab 70 kPa — 30mm (R0.78)", 359.39, 15], ["Slabmate under-slab 70 kPa — 40mm (R0.92)", 382.89, 12],
    ["Slabmate under-slab 70 kPa — 50mm (R1.1)", 399.31, 10], ["Slabmate under-slab 70 kPa — 60mm (R1.35)", 382.89, 8],
    ["Slabmate under-slab 70 kPa — 70mm (R1.7)", 389.92, 7],
    ["Slabmate Pro under-slab 185 kPa — 40mm (R1.15)", 876.06, 12], ["Slabmate Pro under-slab 185 kPa — 50mm (R1.45)", 912.57, 10],
  ];
  packs.forEach(([name, pack, sheets]) => assert.equal(price(name), Math.round((pack / (sheets * 2.88) / 1.1) * 100) / 100, `${name} = pack ÷ m² ÷ 1.1`));
  assert.equal(price("Slabmate under-slab 70 kPa — 50mm (R1.1)"), 12.6, "the specified 50 mm board: $12.60/m² ex GST");
  const key = rateKey("INSULATION", "Slabmate under-slab 70 kPa — 50mm (R1.1)", "m2");
  assert.equal(computeElementCost({ id: "s", typeId: "raft_slab", qtys: { [key]: 200 }, tasks: [], additional: [] }, defaultRates()).categoryTotals["INSULATION"], 2520, "200 m² = $2,520");
  // Estimates: every family × thickness is a catalog row of the same unit (the bridge maps by exact name)
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const fams = new Function(est.match(/const INSULATION_FAMILIES=\[[\s\S]*?\n\];/)[0] + "\nreturn INSULATION_FAMILIES;")();
  fams.forEach(([k, , unit, ths, name]) => ths.forEach((t) => {
    const p = cat.products.find((x) => x.name === name(t));
    assert.ok(p, `Estimates' ${k} ${t}mm ("${name(t)}") is a Quotes INSULATION row`);
    assert.equal(p.unit, unit === "m" ? "m" : "m2", `${name(t)} unit`);
  }));
  assert.deepEqual([...fams.find((f) => f[0] === "slabmate")[3]], [30, 40, 50, 60, 70]);
  assert.deepEqual([...fams.find((f) => f[0] === "slabmatepro")[3]], [40, 50]);
  const { quote, flags } = buildImportFromEstimate({ project: {}, lines: [
    { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL08",
      materialGroup: "Insulation", material: "Slabmate under-slab 70 kPa — 50mm (R1.1)", spec: "Under-slab / under-element insulation — 50mm", unit: "m²", finalQty: 210 },
  ] });
  assert.equal(quote.items[0].qtys[key], 210, "a published Slabmate line lands on its row");
  assert.ok(!flags.some((f) => /Slabmate/.test(f)));
});

const TENDER_INBOX_23 = await import("../src/lib/tenderInbox.js");
check("Tender inbox (23 Nov 2026): an informal price request and a quoted forward are recognised, a supplier's own estimate is not, and a re-check reads back a set number of days", () => {
  const T = TENDER_INBOX_23;
  const pdf = [{ filename: "3 WIMBLEDON CRT PORTSEA 03_TP0 _FULL SET.pdf", attachmentId: "a1", size: 900000, mimeType: "application/pdf" }];
  const text = "Hi both\nLooking to get some indicative costs together for the attached boat house garage at 3 Wimbledon crt Portsea. No engineering or specifications as yet but for the exercise thought we just allow a 100mm raft slab with 600 edge beam.\nCall with any queries";
  const direct = { id: "m1", threadId: "t1", from: "Dean Wilson <inbox@dwbuild.com.au>", to: "projects@gradcon.com.au", subject: "3 Wimbledon Crt Portsea", date: "2026-11-21T02:35:00Z", body: text, snippet: text.slice(0, 150), attachments: pdf };
  const c1 = T.classifyMessage(direct);
  assert.ok(c1.candidate && c1.reasons.includes("indicative / budget costs asked for") && c1.reasons.includes("looking to get costs / a price"), "\"looking to get some indicative costs\" is a request");
  assert.ok(T.classifyMessage({ ...direct, body: direct.snippet, attachments: [] }).score >= 2, "…and its first lines alone earn the full read");
  const cand = T.candidateFromMessage(direct, { now: new Date("2026-11-23T00:00:00Z") });
  assert.deepEqual([cand.projectName, cand.siteAddress, cand.client, cand.deadlineSource, cand.internal], ["3 Wimbledon Crt, Portsea", "3 Wimbledon Crt, Portsea", "Dwbuild", "default", false], "named by its address — Crt is a street type");
  // the same request forwarded by the director, every line quoted with "> " (Apple Mail)
  const quoted = "\n> Begin forwarded message:\n> \n> From: Dean Wilson <inbox@dwbuild.com.au>\n> Subject: 3 Wimbledon Crt Portsea\n> Date: 21 November 2026 at 1:35:01 pm AEDT\n> To: Grady <grady@gradcon.com.au>\n> \n" + text.split("\n").map((l) => "> " + l).join("\n");
  const fwd = { id: "m2", threadId: "t2", from: "Grady Fink <grady@gradcon.com.au>", to: "projects@gradcon.com.au", subject: "Fwd: 3 Wimbledon Crt Portsea", date: "2026-11-22T21:32:00Z", body: quoted, snippet: "> Begin forwarded message: > > From: Dean Wilson > Subject: 3 Wimbledon Crt Portsea", attachments: pdf };
  assert.equal(T.forwardedFrom(fwd).from, "Dean Wilson <inbox@dwbuild.com.au>", "a forward quoted with > marks is read");
  const cf = T.candidateFromMessage(fwd, { now: new Date("2026-11-23T00:00:00Z") });
  assert.deepEqual([cf.client, cf.via, cf.internal, cf.projectName, cf.siteAddress], ["Dwbuild", "grady@gradcon.com.au", false, "3 Wimbledon Crt, Portsea", "3 Wimbledon Crt, Portsea"], "the builder is the client, the director the forwarder, the suburb never \"Portsea Fwd\"");
  assert.ok(T.isColleagueForward(fwd) && !T.isColleagueForward(direct) && !T.isColleagueForward({ ...fwd, from: "Boma <projects@gradcon.com.au>" }), "a colleague's forward is always read in full; the mailbox's own is not");
  assert.ok(T.findDuplicate(cand, [{ id: "p", name: cf.projectName, source: {} }]), "the original and its forward are one project");
  // what must NOT become a project
  const est = T.classifyMessage({ from: "Ruschiel <r@piling.example>", subject: "BUDGET ESTIMATE: 16-18 Beach Avenue, Blairgowrie - Conforming Piling", body: "Good morning Boma, Please find attached our budget estimate for the conforming piling and sleeper retaining wall.", attachments: pdf });
  assert.ok(!est.candidate && est.reasons.some((r) => /a quote sent to Gradcon/.test(r)), "a supplier sending ITS estimate is not a request");
  assert.ok(!T.classifyMessage({ from: "Rep <rep@steel.example>", subject: "Supply Rates", body: "Just wanted to send through some decreased general supply rates as per attached. Still happy to offer project rates.", attachments: pdf }).candidate, "a supplier's rate notice is not a request");
  // "receiving your quotation" asks for a quote; "your quotation was received" is about one already sent
  const ask = T.classifyMessage({ from: "Builder <b@builder.example>", subject: "NEW TENDER - 66 North Rd, Brighton", body: "We have a new tender opportunity. We would appreciate receiving your quotation by 11 December." });
  assert.ok(ask.candidate && !ask.reasons.some((r) => /own quote/.test(r)), "\"receiving your quotation\" carries no penalty");
  assert.ok(T.classifyMessage({ from: "Builder <b@builder.example>", subject: "Re: pricing", body: "Thanks, your quotation has been reviewed." }).reasons.some((r) => /own quote/.test(r)), "…mail about a quote already sent still does");
  // the re-check window
  const now = new Date("2026-11-23T00:00:00Z"), rec = { watermarkMs: Date.parse("2026-11-22T22:41:00Z") };
  assert.equal(T.scanQuery(rec, now).match(/after:(\d+)/)[1], String(Math.floor((rec.watermarkMs - T.SCAN_OVERLAP_MS) / 1000)), "an ordinary scan reads from the watermark");
  assert.equal(T.scanQuery(rec, now, { lookbackDays: 3 }).match(/after:(\d+)/)[1], String(Math.floor((now.getTime() - 3 * 86400000) / 1000)), "a re-check reads from three days back");
  assert.deepEqual([T.lookbackDaysOf(3), T.lookbackDaysOf("3"), T.lookbackDaysOf(99), T.lookbackDaysOf(0), T.lookbackDaysOf(-2), T.lookbackDaysOf("x")], [3, 3, T.LOOKBACK_MAX_DAYS, 0, 0, 0], "bounded to 14 days, never negative");
  const api = fs.readFileSync(new URL("../api/tender-inbox.js", import.meta.url), "utf8");
  assert.match(api, /const lookbackDays = auto \? 0 : lookbackDaysOf\(lookbackAsked\);/, "an automatic scan never looks back");
  assert.match(api, /scanQuery\(record, now, \{ lookbackDays \}\)/);
  assert.match(api, /!\(h\.attachments \|\| \[\]\)\.length && !isColleagueForward\(h, mailbox\)\) continue;/, "a colleague's forward gets its full read");
  const shell = fs.readFileSync(new URL("../portal/portal-shell.html", import.meta.url), "utf8");
  assert.match(shell, /data-testid="inbox-rescan"/); assert.match(shell, /lookbackDays: back/);
});

check("Slab step-down edge formwork (22 Nov 2026): the edge along the step-down run is formed, shown and shaped on the Formwork tab; nothing chosen = the line as it was", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const geom = new Function("num", est.match(/function sdFactors\(d\)\{[\s\S]*?\n\}/)[0] + "\n" + est.match(/function sdFormGeom\(d\)\{[\s\S]*?\n\}/)[0] + "\nreturn sdFormGeom;")(num);
  const base = { stepdown: true, sdLength: 6, sdDepth: 150 };
  let g = geom(base);
  assert.ok(g.on && !g.custom && g.runEach === 6 && g.runM === 6 && g.faceMm === 150, "a step saved before the choice: formed, 6 m, 150 mm, not custom");
  assert.equal(geom({ ...base, sdRisers: 2 }).runM, 12, "each riser is formed");
  g = geom({ ...base, sdFormEdges: "2" });
  assert.ok(g.custom && g.runM === 12 && g.edges === 2, "both edges of the run = twice the run");
  g = geom({ ...base, sdFormRunM: 9.5, sdFormFaceMm: 450 });
  assert.ok(g.custom && g.runEach === 9.5 && g.faceMm === 450 && Math.abs(g.areaM2 - 4.275) < 1e-9, "a typed run and face height win (9.5 m × 450 mm = 4.275 m²)");
  assert.equal(geom({ ...base, sdFormOn: false }).on, false, "unticked = no edge formwork");
  assert.equal(geom({ ...base, stepdown: false }).on, false, "no step, no formwork");
  assert.equal(geom({ stepdown: true, sdDepth: 150 }).runEach, 0, "no step-down length and no typed run = nothing to form");
  assert.equal(geom({ stepdown: true, sdDepth: 150, sdFormRunM: 4 }).runEach, 4, "…a typed run alone is enough");
  // wiring: the block is on the slab's Formwork tab, the compute reads the ONE geometry, the old spec is kept
  assert.ok(est.includes("${slabBeamFormworkSection(inst,d)}${stepdownFormSection(d)}`;"), "the block sits on the slab's Formwork tab");
  assert.match(est, /data-testid="stepdown-form"/);
  assert.match(est, /chk\("sdFormOn",d\.sdFormOn!==false,/, "unset = formed");
  assert.match(est, /const sf=sdFormGeom\(d\);\s*if\(sf\.on && sf\.runEach>0\)\{\s*if\(!sf\.custom\)\{/, "the compute reads sdFormGeom; nothing chosen takes the old branch");
  assert.ok(est.includes('spec:`${d.sdDepth}mm deep step ×${sdf.risers} riser(s)`,faces:[{name:"step faces",runM:fLm,'), "the default line's spec is spelled as before (manual-override key)");
  assert.match(est, /if\(d\.sdDowels===false\)\{[^}]*\}\s*else if\(dowelProduct\(d\.sdDia\)\.kind!=="bar"\)/, "the dowels are their own tick (unset = counted)");
  assert.match(est, /refreshSdFormNote\(card,inst\);/, "the result line follows the typing");
  assert.match(est, /Step-down: the edge along the step is to be formed but no run is known/, "a step with no run is a completeness warning");
  // the bridge: the lm line lands on Edgeform, a 400 mm+ face on the deep-edge m² row
  const { quote } = buildImportFromEstimate({ project: {}, lines: [
    { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL01", materialGroup: "Formwork", material: "Step-down face formwork", spec: "150mm deep step ×1 riser(s) — both edges of the run — step edges 150 mm — under 400 mm — lineal metres", unit: "m", finalQty: 12, faceMm: 150 },
    { ...estLine({}), category: "Slab on Ground", element: "Slab 1", elementId: "EL01", materialGroup: "Formwork", material: "Step-down face formwork", spec: "450mm deep step ×1 riser(s) — step faces 450 mm", unit: "m²", finalQty: 4.275, faceMm: 450 },
  ] });
  const q = quote.items[0].qtys;
  assert.equal(q[rateKey("FORMWORK", "Edgeform", "m")], 12, "12 m of step edge on Edgeform");
  assert.equal(q[rateKey("FORMWORK", "Edgeform >400mm deep", "m2")], 4.275, "a 450 mm step face on the deep-edge m² row");
});

check("Estimates cloud check never pulls this tab's own save back over the typing (22 Nov 2026): it stands down while a push is in flight, judges a browser copy stale only at the first reconcile, and adopts an identical cloud copy without rebuilding", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  assert.match(est, /function ownPushInFlight\(key\)\{ const st=PUSH_STATE\[key\]; return !!\(st && \(st\.running \|\| st\.queued\)\); \}/);
  const sync = est.slice(est.indexOf("async function syncFromCloud(){"), est.indexOf("async function syncProjectsIndexFromCloud(){"));
  assert.ok(sync.length > 2000);
  const iFail = sync.indexOf("scheduleCloudRetry();"), iOwn = sync.indexOf("if(ownPushInFlight(keyAtStart)) return;"), iApply = sync.indexOf("applyLoadedEstimateState(migratedRow);");
  assert.ok(iFail > 0 && iOwn > iFail && iOwn < iApply, "a push of this tab's in flight ends the check before anything is compared or applied");
  assert.equal((sync.match(/if\(ownPushInFlight\(keyAtStart\)\) return;/g) || []).length, 2, "…and again after the version was kept, right before the apply");
  assert.match(sync, /const staleLocal = \(\(\)=>\{[\s\S]{0,700}?if\(cloudReconciled\(keyAtStart\)\) return false;/, "the stale-browser-copy test runs only at this session's first reconcile of the key");
  const iSame = sync.indexOf("if(!awaitingCloudLoad && !localBlank && sameTakeoff(localSnap, migratedRow)){");
  assert.ok(iSame > 0 && iSame < iApply, "an identical cloud copy is caught before the apply");
  assert.match(sync.slice(iSame, iSame + 700), /localStorage\.setItem\(keyAtStart\+"__syncedAt", row\.updated_at\);[\s\S]*?LAST_CLOUD_HASH\[keyAtStart\] = snapshotHash\(migratedRow\);\s*markReconciled\(keyAtStart\);\s*return;/, "…its stamp is taken and nothing is rebuilt");
});

check("Margin Register (23 Nov 2026): a custom row under the SUB CONTRACTORS band is its own subcontract line with its own margin, and a custom LINE added in the register is a lump-sum element with an editable name and cost", () => {
  const near = (x, y, tol = 0.005, msg) => { if (typeof tol === "string") { msg = tol; tol = 0.005; } assert.ok(Math.abs(x - y) <= tol, `${msg || "near"}: ${x} vs ${y}`); };
  const SUB = "SUB CONTRACTORS / TEMPORARY WORKS";
  const fw = rateKey(SUB, "Formwork (subcontract)", "quote");
  const slabType = ELEMENT_TYPES.find((t) => t.id === "suspended_slab") || ELEMENT_TYPES.find((t) => t.category === "SUSPENDED STRUCTURE");
  const slab = { ...newElementItem(slabType), label: "Post-Tensioned Slab", marginPct: 0.2,
    qtys: { [fw]: 1 }, rateOverrides: { [fw]: { unitCost: 167793.65 } }, rowMargins: { [fw]: 0.15 / 1.15 },
    additional: [{ id: "pt1", cat: SUB, name: "Post Tensioning Quote from Contractor", unit: "", qty: 1, rate: 45000 }, { id: "ri1", cat: "RATE ITEMS", name: "Hobs", unit: "m", qty: 10, rate: 51.661 }] };
  const rates = defaultRates(); const q = { marginPct: 0.25 };
  const lines = costingAll.subcontractQuoteLines(slab, rates, "both");
  assert.deepEqual(lines.map((l) => [l.key, l.name, l.cost]), [[fw, "Formwork (subcontract)", 167793.65], ["add:pt1", "Post Tensioning Quote from Contractor", 45000]], "the catalog quote row, then the custom row added under the band — a custom row under ANOTHER band is own work");
  assert.equal(lines[1].custom, true); assert.equal(lines[1].rowId, "pt1"); assert.equal(costingAll.customSubKey("pt1"), "add:pt1");
  const before = costingAll.computeElementSell(slab, rates, q, "both");
  const pt = before.lines.find((l) => l.key === "add:pt1"), own = before.lines.find((l) => l.kind === "own");
  assert.equal(pt.kind, "sub"); assert.equal(pt.custom, true); assert.equal(pt.rowId, "pt1", "the register edits its cost by the row's id"); near(pt.cost, 45000); near(pt.margin, 0.2); assert.equal(pt.source, "element"); near(pt.sell, 56250);
  near(own.cost, before.cost - 167793.65 - 45000, 0.01, "the post-tensioning quote is no longer inside the slab's own work");
  near(before.sell, before.cost / 0.8 - 167793.65 / 0.8 + 167793.65 * 1.15, 0.01, "unpinned it sells exactly as it did inside the own work — nothing re-prices on its own");
  // its own margin: 10% on the post-tensioning quote alone
  const pinned = costingAll.rowMarginPatch(slab, "add:pt1", 0.1);
  const after = costingAll.computeElementSell(pinned, rates, q, "both");
  const pt2 = after.lines.find((l) => l.key === "add:pt1");
  near(pt2.margin, 0.1); assert.equal(pt2.source, "row"); near(pt2.sell, 50000);
  near(after.sell, before.sell - 56250 + 50000, 0.01, "only that line moved");
  const reg = costingAll.computeMarginRegister([pinned], rates, q, "both");
  assert.equal(reg.byClass.sub.count, 2); near(reg.byClass.sub.cost, 212793.65); near(reg.totals.cost, after.cost);
  // an unpriced custom row is no line; the register can set its cost
  assert.equal(costingAll.subcontractQuoteLines({ ...slab, additional: [{ id: "x", cat: SUB, name: "", qty: 1 }] }, rates, "both").length, 1);
  const costed = costingAll.customRowCostPatch(slab, "pt1", 52000);
  near(costed.additional.find((a) => a.id === "pt1").rate, 52000); assert.equal(costed.additional.find((a) => a.id === "ri1").rate, 51.661, "no other row is touched");
  near(costingAll.customRowCostPatch({ ...slab, additional: [{ id: "pt1", cat: SUB, qty: 2, rate: 10 }] }, "pt1", 300).additional[0].rate, 150, "the quantity is kept: rate = cost ÷ qty");
  assert.equal(costingAll.customRowCostPatch(slab, "pt1", undefined).additional.find((a) => a.id === "pt1").rate, undefined);
  // a custom LINE: a lump-sum element
  const type = ELEMENT_TYPES.find((t) => t.id === costingAll.CUSTOM_ITEM_TYPE_ID);
  assert.ok(type && type.category === "CUSTOM ITEMS");
  const line = costingAll.newCustomLine(type);
  assert.equal(costingAll.isCustomLine(line), true); assert.equal(line.label, "Custom item"); assert.equal(costingAll.customLineCost(line), 0);
  assert.equal(computeElementCost(line, rates, "both").total, 0, "a new line costs nothing until a figure is typed");
  const named = costingAll.customLinePatch(costingAll.customLinePatch(line, { name: "Crane hire allowance" }), { cost: 12500 });
  assert.equal(named.label, "Crane hire allowance"); assert.equal(named.additional.length, 1, "ONE lump row, edited in place");
  assert.equal(named.additional[0].name, "Crane hire allowance"); assert.equal(named.additional[0].cat, "RATE ITEMS"); assert.equal(named.additional[0].lump, true);
  near(computeElementCost(named, rates, "both").total, 12500); near(costingAll.customLineCost(named), 12500);
  near(computeElementCost(named, rates, "labour").total, 12500, "a lump sum is charged under every scope"); near(computeElementCost(named, rates, "materials").total, 12500);
  const sold = costingAll.computeElementSell(costingAll.elementMarginPatch(named, 0.1), rates, q, "both");
  assert.equal(sold.lines.length, 1); assert.equal(sold.lines[0].kind, "own"); near(sold.sell, 12500 / 0.9);
  near(computeGrandTotal([pinned, named], rates, "both"), after.cost + 12500, 0.01, "the grand total carries it");
  assert.equal(costingAll.customLineCost(costingAll.customLinePatch(named, { cost: undefined })), 0, "a cleared figure leaves the line at $0");
  assert.equal(costingAll.customLinePatch(slab, { cost: 5 }), slab, "an ordinary element is never patched as a custom line");
  assert.equal(costingAll.blindingPartsFor(named).length, 0, "a custom line never blinds");
  // the wiring
  const mr = fs.readFileSync(new URL("../src/components/MarginRegister.jsx", import.meta.url), "utf8");
  for (const id of ["margin-register-add", "margin-register-custom-name", "margin-register-custom-cost", "margin-register-custom-remove", "margin-register-sub-cost"]) assert.ok(mr.includes(`data-testid="${id}"`), id);
  assert.match(mr, /\.\.\.rowsOf\(g\)\.map\(\(l\) => \{/, "rows are laid out per element, so an unpriced custom line keeps its row and its key");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.equal((app.match(/onAddCustomLine=\{addCustomLine\} onCustomLine=\{setCustomLine\} onRemoveCustomLine=\{removeItem\} onCustomRowCost=\{setCustomRowCost\}/g) || []).length, 2, "both registers (a package's and the project's) take the four writers; removal goes through removeItem, which keeps a before-remove version");
});

const LIST_GUARD_23 = await import("../src/lib/listGuard.js");
check("A project never drops off the list while its row is stored (23 Nov 2026 — 3206 Point Nepean Road NOV23 vanished while two people had it open): boot-time stamps answer only while seconds old and complete, a prune needs a fresh per-key confirmation, a stored row with no entry is offered back", () => {
  const G = LIST_GUARD_23;
  const k = (id) => `gradcon-quote-${id}`;
  const t0 = Date.UTC(2026, 10, 23, 23, 3, 27);
  const pre = { [k("a")]: "x", [k("b")]: "y" };
  // 1. the boot-time stamps
  assert.equal(G.prefetchUsable(pre, t0, [k("a"), k("b")], t0 + 2000), true, "seconds old and complete: used");
  assert.equal(G.prefetchUsable(pre, t0, [k("a"), k("b")], t0 + 10 * 60 * 1000), false, "ten minutes old: never used");
  assert.equal(G.prefetchUsable(pre, t0, [k("a"), k("c")], t0 + 2000), false, "a key it does not list is looked up fresh, never called missing");
  assert.equal(G.prefetchUsable(null, t0, [k("a")], t0 + 1), false);
  assert.equal(G.prefetchUsable(pre, t0, ["other-key"], t0 + 1), false);
  assert.equal(G.prefetchUsable(pre, t0, [], t0 + 1), true);
  // 2. the prune's confirmation
  assert.deepEqual(G.confirmedAbsent([k("a"), k("gone")], { [k("a")]: "x" }), [k("gone")], "only the key the fresh query did not return");
  assert.deepEqual(G.confirmedAbsent([k("a"), k("gone")], null), [], "a failed query confirms nothing");
  assert.deepEqual(G.confirmedAbsent([k("gone")], {}), [k("gone")], "an answered, empty result is a confirmation");
  // 3. stored rows with no entry
  const now = Date.UTC(2026, 10, 23, 23, 20, 0);
  const stamps = { [k("9tcfmth0mwttljb4")]: "2026-11-23T23:07:45.412+00:00", [k("listed")]: "2026-11-01T00:00:00Z", [k("fresh")]: new Date(now - 30000).toISOString(), "gradcon-rates": "2026-11-01T00:00:00Z", "gradcon-quote-": "2026-11-01T00:00:00Z" };
  assert.deepEqual(G.unlistedRowKeys(stamps, [k("listed")], now), [k("9tcfmth0mwttljb4")], "the dropped project is found; a row seconds old (a create in flight) and other keys are not");
  assert.deepEqual(G.unlistedRowKeys(stamps, new Set([k("listed"), k("9tcfmth0mwttljb4")]), now), []);
  assert.deepEqual(G.unlistedRowKeys(null, [], now), []);
  const e = G.restoredEntry(k("9tcfmth0mwttljb4"), "2026-11-23T23:07:45.412+00:00");
  assert.equal(e.id, "9tcfmth0mwttljb4"); assert.equal(e.storageKey, k("9tcfmth0mwttljb4"));
  assert.equal(e.createdAt.slice(0, 16), "2026-11-23T22:11", "the creation time is read back out of the id (the copy was made at 22:11:17 UTC)");
  assert.equal(G.restoredEntry("gradcon-rates"), null);
  assert.equal(G.createdAtFromId("short", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z", "an id with no readable time takes the fallback");
  // the wiring
  const pj = fs.readFileSync(new URL("../src/lib/projects.js", import.meta.url), "utf8");
  assert.match(pj, /if \(prefetchUsable\(pre, stampsPrefetchAt, storageKeys\)\) stamps = pre;/, "the first read takes the boot-time stamps only through the guard");
  assert.doesNotMatch(pj, /if \(pre && storageKeys\.every/, "…never on the key spelling alone");
  assert.match(pj, /export async function confirmRowsAbsent\(storageKeys\) \{[\s\S]{0,400}?const stamps = await readQuoteStamps\(keys\);\s*return stamps \? confirmedAbsent\(keys, stamps\) : null;/, "the confirmation is a fresh stamp query for exactly those keys");
  assert.match(pj, /export async function readUnlistedProjects\(listedKeys\)/);
  const dash = fs.readFileSync(new URL("../src/components/Dashboard.jsx", import.meta.url), "utf8");
  const eff = dash.slice(dash.indexOf("const suspects = projects.filter("), dash.indexOf("// Stored projects that are not on the list"));
  assert.ok(eff.length > 500);
  assert.match(eff, /confirmRowsAbsent\(suspects\.map\(\(p\) => p\.storageKey\)\)\.then\(\(absent\) => \{[\s\S]{0,200}?applyOrphans\(suspects\.filter\(\(p\) => gone\.has\(p\.storageKey\)\)\);/, "only entries the fresh check confirmed absent are hidden and pruned");
  assert.equal((dash.match(/onPrune\(due\)/g) || []).length, 1, "ONE prune call");
  assert.ok(dash.indexOf("onPrune(due)") < dash.indexOf("confirmRowsAbsent(suspects"), "…inside applyOrphans, which the suspects reach only through the confirmation");
  assert.doesNotMatch(eff, /applyOrphans\(suspects\)/, "the suspects are never pruned as they stand");
  assert.match(dash, /data-testid="unlisted-projects"/); assert.match(dash, /data-testid="unlisted-restore"/);
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /const restoreProject = \(entry\) => \{[\s\S]{0,200}?setProjects\(\(ps\) => \(ps\.some\(\(p\) => p\.id === entry\.id\) \? ps : \[\.\.\.ps, entry\]\)\);/, "putting a project back only ever ADDS its entry");
  assert.match(app, /onRestore=\{restoreProject\}/);
});

check("KingFlor (25 Nov 2026): a formwork system in Estimates, a FORMWORK row in Quotes and the Rates Library, and the bridge lands a KingFlor soffit on it", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  assert.match(est, /\["bondek","Bondek \(permanent metal deck\)"\],\s*\["kingflor","KingFlor \(Fielders steel decking — permanent\)"\]/);
  const lib = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8"), cp = fs.readFileSync(new URL("../portal/cost-planner.html", import.meta.url), "utf8");
  assert.match(lib, /\{g:"Suspended", p:"KingFlor",u:"m2",cost:150,/); assert.match(lib, /p:"KingFlor decking to suspended slab"/); assert.match(cp, /p:"KingFlor decking to suspended slab"/); assert.match(cp, /\{p:"KingFlor",u:"m2",cost:125,/);
  const br = buildImportFromEstimate({ project: { name: "KF" }, lines: [
    { elementId: "S", element: "Suspended Slab L1", category: "Suspended Slab", materialGroup: "Concrete", material: "N32 concrete", spec: "Suspended Slab 300mm", qty: 30, finalQty: 30.75, unit: "m³" },
    { elementId: "S", element: "Suspended Slab L1", category: "Suspended Slab", materialGroup: "Formwork", material: "Soffit formwork", spec: "Soffit · KingFlor (Fielders steel decking — permanent)", qty: 100, finalQty: 100, unit: "m²" },
  ], elementGeometry: {} });
  const it = br.quote.items[0], K = rateKey("FORMWORK", "KingFlor", "m2");
  assert.equal(it.qtys[K], 100, "the soffit lands on the KingFlor row: " + JSON.stringify(it.qtys));
  assert.ok(!it.qtys[rateKey("FORMWORK", "Conventional", "m2")] && !it.qtys[rateKey("FORMWORK", "Bondek", "m2")]);
  assert.ok(Math.abs(computeElementCost(it, defaultRates()).categoryTotals["FORMWORK"] - 15000) < 0.005);
});

check("Further edge thickenings (25 Nov 2026): a slab's edge can be thickened to several widths — each on its own typed run, the first taking the rest of the perimeter; none = the slab as it was", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fmt = (n, dp) => Number(n).toFixed(dp === undefined ? 2 : dp);
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const one = (name) => est.match(new RegExp("function " + name + "\\([^\\n]*\\n"))[0];
  const M = new Function("num", "fmt", [fn("sectionAreaM2"), fn("sectionLabel"), one("extraEdgeThickens"), fn("edgeThickenRowCalc"), one("extraEdgeThickenRunM"), fn("etRunM")].join("\n") + "\nreturn {edgeThickenRowCalc, extraEdgeThickenRunM, etRunM};")(num, fmt);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  // none: the first thickening runs the whole perimeter, as before
  assert.equal(M.etRunM({ edgeThicken: true }, 60), 60); assert.equal(M.etRunM({ edgeThicken: true, edgeThickens: [] }, 60), 60);
  // 450 wide over 20 m and 600 wide over 8 m: the first takes the other 32 m
  const d = { edgeThicken: true, edgeThickens: [{ runM: 20, widthMm: 450, depthMm: 150, shape: "tri" }, { runM: 8, widthMm: 600, depthMm: 200, shape: "rect" }] };
  assert.equal(M.extraEdgeThickenRunM(d), 28); assert.equal(M.etRunM(d, 60), 32);
  assert.equal(M.etRunM({ ...d, edgeThickenLenOverride: 40 }, 60), 40, "a typed run on the first thickening stands");
  assert.equal(M.etRunM({ edgeThicken: true, edgeThickens: [{ runM: 70 }] }, 60), 0, "never below zero");
  near(M.edgeThickenRowCalc(d.edgeThickens[0]).vol, 20 * 0.45 * 0.15 / 2, "triangular: run × w × d ÷ 2");
  near(M.edgeThickenRowCalc(d.edgeThickens[1]).vol, 8 * 0.6 * 0.2, "rectangular: run × w × d");
  near(M.edgeThickenRowCalc({ runM: 10, widthMm: 400, depthMm: 200, shape: "trap", baseW: 200 }).vol, 10 * (0.4 + 0.2) * 0.2 / 2, "trapezoidal with a flat base");
  const noRun = M.edgeThickenRowCalc({ widthMm: 300, depthMm: 150 });
  assert.ok(noRun.touched && noRun.vol === 0, "a row with no run prices nothing and is flagged");
  assert.equal(M.edgeThickenRowCalc({}).touched, false);
  // wiring: the render never creates the array; the compute emits a line per row; add / duplicate / delete; the live cells
  assert.doesNotMatch(est, /d\.edgeThickens\s*\|\|\s*\(d\.edgeThickens\s*=/, "a render never creates the array");
  assert.match(est, /spec:`Edge thickening — \$\{nm\}`/); assert.match(est, /spec:"Edge thickening \(perimeter strip\)"/, "the first thickening's spec is unchanged (the override key)");
  assert.match(est, /act==="addEdgeThicken" \|\| act==="dupEdgeThicken"/); assert.match(est, /data-action="delRow" data-target="edgeThickens"/);
  assert.match(est, /data-testid="edge-thickens"/); assert.match(est, /data-testid="edge-thicken-run-note"/);
  assert.equal((est.match(/refreshEdgeThickenRows\(card,inst,f\)/g) || []).length, 2, "both typing paths refresh the row results");
});

check("Blinding between the pile faces of a shotcrete wall (26 Nov 2026): wall length and the number of piles give the scallop fill — (L × D/2 − N × πD²/8) × height", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const geom = new Function("num", fn("pileBlindGeom") + "\nreturn pileBlindGeom;")(num);
  const near = (a, b, m, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${m}: ${a} vs ${b}`);
  // the detail: 450 dia piles touching (P1 at 900 with a P2 between), 20 m of wall = 44.44 → say 18 m with 40 piles
  let g = geom({ pileBlindOn: true, length: 18000, height: 3000, pileBlindPiles: 40, pileBlindDia: 450 });
  assert.equal(g.ready, true); near(g.L, 18, "blank length = the wall length"); near(g.H, 3, "blank height = the wall height");
  near(g.plan, 18 * 0.225 - 40 * Math.PI * 0.45 * 0.45 / 8, "strip less the half piles");
  near(g.avgMm, 0.45 * (0.5 - Math.PI / 8) * 1000, "touching piles: 0.107 × D = 48.3 mm on average", 1e-6);
  near(g.vol, g.plan * 3, "× the height"); near(g.centresMm, 450, "centres = length ÷ piles"); assert.equal(g.over, false);
  // a typed length and height win; piles standing apart fill more per pile
  g = geom({ pileBlindOn: true, length: 18000, height: 3000, pileBlindLenMm: 9000, pileBlindHeightMm: 2500, pileBlindPiles: 15, pileBlindDia: 450 });
  near(g.L, 9, "typed length"); near(g.H, 2.5, "typed height"); near(g.centresMm, 600, "600 centres");
  near(g.vol, (9 * 0.225 - 15 * Math.PI * 0.2025 / 8) * 2.5, "volume at 600 centres"); assert.ok(g.avgMm > 48.4, "more fill between piles that stand apart");
  // nothing typed: not ready, names what is missing, prices nothing
  g = geom({ pileBlindOn: true, length: 18000, height: 3000 });
  assert.equal(g.ready, false); assert.equal(g.vol, 0); assert.deepEqual(g.missing, ["the pile diameter", "the number of piles"]);
  assert.equal(geom({ length: 18000, height: 3000, pileBlindPiles: 40, pileBlindDia: 450 }).on, false, "off until ticked");
  // more pile than wall is flagged, and the fill never goes negative
  g = geom({ pileBlindOn: true, length: 9000, height: 3000, pileBlindPiles: 40, pileBlindDia: 450 });
  assert.equal(g.over, true); assert.ok(g.plan >= 0 && g.vol >= 0);
  // wiring: the Blinding tab leads with it on a shotcrete wall; a Base/Blinding concrete line the bridge lands on the blinding row; the note follows the typing
  assert.match(est, /if\(def\.calc==="shotwall"\) parts\.blind = pileBlindSection\(inst\.data\) \+ vertBlindSection\(inst\.data\) \+ vertVmSection\(inst\.data\) \+ parts\.blind;/);
  assert.match(est, /const pb=pileBlindGeom\(d\);/); assert.equal((est.match(/=pileBlindGeom\(d\);/g) || []).length, 2, "compute and the note read the ONE geometry");
  assert.match(est, /materialGroup:"Base\/Blinding",material:`Blinding concrete N\$\{bg\}`,spec:"Between the pile faces — flush finish behind the shotcrete",shotFace:true/);
  assert.match(est, /inpNum\("pileBlindLenMm",d\.pileBlindLenMm\)/); assert.match(est, /inpNum\("pileBlindPiles",d\.pileBlindPiles\)/);
  assert.match(est, /refreshSdFormNote\(card,inst\);\s*refreshPileBlindNote\(card,inst\);/, "the result line follows the typing");
  assert.match(est, / missing — nothing is priced for it\.`,section:"blind",level:"completeness"/); assert.match(est, /level:"sanity"\}\);\s*\}\s*\}\s*return \{lines,warnings\};/);
  assert.doesNotMatch(est.match(/function shotWallDefaults[\s\S]*?\n\};?\}/)[0], /pileBlind/, "no new default: an older shotcrete wall's content is unchanged");
});

check("Shotcrete wall dowels into the piers set out as a VERTICAL RUN (26 Nov 2026): positions up a pier = run ÷ spacing + 1, × bars × piers; no mode = a number per pier, as before", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const setOut = new Function("num", "INSTANCES", fn("shotPierCount") + "\n" + fn("pierDowelSetOut") + "\nreturn pierDowelSetOut;")(num, [{ id: "p1", data: { qty: 12 } }]);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  // as before: no mode = a number per pier (defaults 4 per pier, 400 + 600)
  let g = setOut({ pierDowelOn: true, pierDowelPiers: 10 });
  assert.equal(g.mode, "count"); assert.equal(g.total, 40); near(g.each, 1.0, "embed 400 + proj 600");
  // the detail: 1 × N12 at 900 cts vertically, 110 embedment, lap 400, to every P1 pile — 20 piles on a 3 m wall
  g = setOut({ pierDowelOn: true, pierDowelMode: "spacing", height: 3000, pierDowelPiers: 20, pierDowelSpacing: 900, pierDowelEmbed: 110, pierDowelProj: 400, pierDowelFix: "epoxy" });
  assert.equal(g.positions, 4, "3000 ÷ 900 + 1 = 4 positions up a pier"); assert.equal(g.total, 80, "× 20 piles"); near(g.each, 0.51, "110 + 400"); assert.equal(g.epoxy, true);
  // a typed run, two bars at each position, the linked pier element's quantity
  g = setOut({ pierDowelOn: true, pierDowelMode: "spacing", height: 3000, pierDowelRunMm: 5400, pierDowelSpacing: 900, pierDowelAt: 2, pierDowelTarget: "p1" });
  assert.equal(g.positions, 7, "5400 ÷ 900 + 1"); assert.equal(g.piers, 12, "the linked pier element's quantity"); assert.equal(g.total, 12 * 7 * 2);
  assert.equal(setOut({ pierDowelMode: "spacing", height: 3000, pierDowelPiers: 5 }).sp, 900, "a blank spacing is the 900 shown in the box");
  assert.equal(setOut({ pierDowelMode: "spacing", height: 0, pierDowelPiers: 5 }).total, 0, "no run: nothing");
  assert.equal(setOut({ pierDowelMode: "spacing", height: 3000, pierDowelSpacing: 0, pierDowelPiers: 5 }).total, 0, "no spacing: nothing");
  // wiring: the old spec and formula stand in count mode; the vertical run has its own spec; epoxy holes land on the ChemSet row; the note follows the typing
  assert.match(est, /spec:\(vertRun\?"Dowels into bored piers \(vertical run\) → ":"Dowels into bored piers → "\)\+\(tgt\|\|"\(unlinked\)"\)/);
  assert.match(est, /`\$\{piers\} piers × \$\{per\} dowels × \(embed \$\{num\(d\.pierDowelEmbed,400\)\} \+ proj \$\{num\(d\.pierDowelProj,600\)\}\)\/1000`/, "the count-mode formula is unchanged");
  assert.match(est, /materialGroup:"Connections",material:"Drill & epoxy",spec:`Dowels into bored piers: /);
  assert.match(est, /selOpts\("pierDowelMode",vert\?"spacing":"count",\[\["count","A number per pier"\],\["spacing","At a spacing up each pier \(vertical run\)"\]\],true\)/);
  assert.match(est, /refreshPileBlindNote\(card,inst\);\s*refreshPierDowelNote\(card,inst\);/);
  assert.match(est, /nothing is priced for them\.`,section:"conn",level:"completeness"/);
  assert.doesNotMatch(est.match(/function shotWallDefaults[\s\S]*?\n\};?\}/)[0], /pierDowelMode|pierDowelFix/, "no new default: an older wall prices as it did");
  // the bridge: the holes line is the one the ChemSet hole-only allowance takes
  const imp = fs.readFileSync(new URL("../src/lib/estimateImport.js", import.meta.url), "utf8");
  assert.match(imp, /\/\^drill & epoxy\$\/i\.test\(l\.material \|\| ""\) && l\.unit === "no\."/);
});

check("Vertical vapour barrier on a shotcrete wall (26 Nov 2026): face area + laps — a typed area, else length × height; its own line beside the blindings", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const geom = new Function("num", fn("vertVmGeom") + "\nreturn vertVmGeom;")(num);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  let g = geom({ vertVmOn: true, length: 18000, height: 3000 });
  near(g.area, 54, "blank = the wall's own length × height"); assert.equal(g.lap, 10, "blank laps = 10%"); near(g.finalM2, 59.4, "54 m² + 10%"); assert.equal(g.type, "200um polyethylene");
  g = geom({ vertVmOn: true, length: 18000, height: 3000, vertVmLenMm: 9000, vertVmHeightMm: 2000, vertVmLap: 15, vertVmType: "Fortecon 200um" });
  near(g.area, 18, "typed length × height"); near(g.finalM2, 18 * 1.15, "+ a typed 15%"); assert.equal(g.type, "Fortecon 200um");
  g = geom({ vertVmOn: true, length: 18000, height: 3000, vertVmAreaM2: 41.5, vertVmLap: 0 });
  assert.equal(g.areaTyped, true); near(g.finalM2, 41.5, "a typed face area wins; 0% laps is 0, not the default");
  assert.equal(geom({ vertVmOn: true }).ready, false); assert.equal(geom({ length: 18000, height: 3000 }).on, false, "off until ticked");
  // wiring: its own Vapour Barrier line, which the bridge lands on the Vapour barrier row; the wall-face lines never switch the generic under-element section off
  assert.match(est, /const vm=vertVmGeom\(d\);/);
  assert.match(est, /materialGroup:"Vapour Barrier",material:`Vapour barrier — \$\{vm\.type\}`,spec:"Vertical — to the wall face, incl\. laps",shotFace:true/);
  assert.match(est, /\(l\.materialGroup==="Base\/Blinding"\|\|l\.materialGroup==="Vapour Barrier"\) && !l\.shotFace\)\)\{/, "the generic blinding / membrane still prices beside the wall-face lines");
  assert.match(est, /data-vertvm-out\]'\); if\(em\) em\.textContent=vertVmOutText\(inst\.data\);/);
  assert.match(est, /Vertical vapour barrier to the wall face is ticked but there is no face area[^`"]*nothing is priced for it\.",section:"blind",level:"completeness"/);
  assert.doesNotMatch(est.match(/function shotWallDefaults[\s\S]*?\n\};?\}/)[0], /vertVm/, "no new default: an older shotcrete wall's content is unchanged");
  const imp = fs.readFileSync(new URL("../src/lib/estimateImport.js", import.meta.url), "utf8");
  assert.match(imp, /l\.materialGroup === "Vapour Barrier"\) && \/vapour\|membrane\/i\.test\(l\.material \|\| ""\)/);
});

check("Vertical blinding on a shotcrete wall (26 Nov 2026): face area × thickness — a typed area, else length × height; blank thickness = 50 mm", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const geom = new Function("num", "const VERT_BLIND_T_MM=50;\n" + fn("vertBlindGeom") + "\nreturn vertBlindGeom;")(num);
  assert.match(est, /const VERT_BLIND_T_MM=50;/);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  let g = geom({ vertBlindOn: true, length: 18000, height: 3000 });
  near(g.area, 54, "blank = the wall's own length × height"); assert.equal(g.tMm, 50, "blank thickness = 50 mm"); near(g.vol, 2.7, "54 m² × 50 mm");
  g = geom({ vertBlindOn: true, length: 18000, height: 3000, vertBlindLenMm: 9000, vertBlindHeightMm: 2000, vertBlindT: 75 });
  near(g.area, 18, "typed length × height"); near(g.vol, 18 * 0.075, "× a typed thickness");
  g = geom({ vertBlindOn: true, length: 18000, height: 3000, vertBlindAreaM2: 41.5, vertBlindT: 40 });
  assert.equal(g.areaTyped, true); near(g.area, 41.5, "a typed face area wins"); near(g.vol, 41.5 * 0.04, "typed area × thickness");
  g = geom({ vertBlindOn: true }); assert.equal(g.ready, false); assert.equal(g.vol, 0, "no face area: nothing priced");
  assert.equal(geom({ length: 18000, height: 3000 }).on, false, "off until ticked");
  // wiring: its own Base/Blinding concrete line with a stable spec, beside the pile fill; the note follows the typing; no new default
  assert.match(est, /const vb=vertBlindGeom\(d\);/);
  assert.match(est, /materialGroup:"Base\/Blinding",material:`Blinding concrete N\$\{vg\}`,spec:"Vertical blinding to the wall face",shotFace:true/);
  assert.match(est, /Vertical blinding to the wall face is ticked but there is no face area[^`"]*nothing is priced for it\.",section:"blind",level:"completeness"/);
  assert.match(est, /data-vertblind-out\]'\); if\(ev\) ev\.textContent=vertBlindOutText\(inst\.data\);/);
  assert.match(est, /inpNum\("vertBlindT",d\.vertBlindT\)/); assert.match(est, /inpNum\("vertBlindAreaM2",d\.vertBlindAreaM2\)/);
  assert.doesNotMatch(est.match(/function shotWallDefaults[\s\S]*?\n\};?\}/)[0], /vertBlind/, "no new default: an older shotcrete wall's content is unchanged");
});

check("Openings / penetrations by perimeter (25 Nov 2026): a row is width × height, or a typed perimeter and area — the perimeter forms the reveal, the area comes off the concrete; untouched rows price as before", () => {
  const est = fs.readFileSync(new URL("../portal/estimates-app.html", import.meta.url), "utf8");
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const fn = (name) => est.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"))[0];
  const M = new Function("num", fn("openingCalc") + "\n" + fn("openingsTotals") + "\nreturn {openingCalc, openingsTotals};")(num);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  // as before: 600 × 2100 × 2
  let c = M.openingCalc({ w: 600, h: 2100, qty: 2 });
  near(c.perimM, 2 * (0.6 + 2.1) * 2, "2 × (w + h) × qty"); near(c.areaM2, 0.6 * 2.1 * 2, "w × h × qty"); assert.equal(c.perimTyped, false); assert.equal(c.noArea, false);
  // a typed perimeter wins for the reveal; the area still comes from w × h
  c = M.openingCalc({ w: 1000, h: 1000, perimM: 3, qty: 1 }); near(c.perimM, 3, "typed perimeter (an opening against an edge: three sides formed)"); near(c.areaM2, 1, "area still w × h");
  // perimeter and area, no size: a round Ø300 penetration × 6
  c = M.openingCalc({ perimM: 0.942, areaM2: 0.0707, qty: 6 }); near(c.perimM, 5.652, "perimeter × qty"); near(c.areaM2, 0.4242, "area × qty");
  // perimeter alone: the reveal, nothing off the concrete, and it says so
  c = M.openingCalc({ label: "Riser", perimM: 4.4, qty: 1 }); near(c.perimM, 4.4, "reveal"); assert.equal(c.areaM2, 0); assert.equal(c.noArea, true);
  assert.equal(M.openingCalc({ perimM: 2 }).qty, 1, "blank qty = 1"); assert.equal(M.openingCalc({}).perimM, 0);
  const t = M.openingsTotals([{ w: 600, h: 2100, qty: 2 }, { label: "Riser", perimM: 4.4, qty: 1 }, { perimM: 0.942, areaM2: 0.0707, qty: 6 }]);
  near(t.perimM, 10.8 + 4.4 + 5.652, "the reveals add up"); near(t.areaM2, 2.52 + 0.4242, "the areas add up"); assert.equal(t.typedPerim, true); assert.deepEqual(t.noArea, ["Riser"]);
  assert.equal(M.openingsTotals([{ w: 600, h: 2100, qty: 2 }]).typedPerim, false);
  // wiring: slab and wall both read it; the reveal runs whenever there is a perimeter; the live cell
  assert.equal((est.match(/const openTot=openingsTotals\(d\.openings\);/g) || []).length, 2, "the slab and the wall read the ONE totals");
  assert.match(est, /\} else if\(openTot\.perimM>0\)\{/); assert.match(est, /if\(openTot\.perimM>0\)\{\s*let revLm=N\*openTot\.perimM;/);
  assert.doesNotMatch(est, /reduce\(\(s,o\)=>s\+2\*\(\(num\(o\.w\)/, "no calculator spells the reveal arithmetic itself any more");
  assert.match(est, /openTot\.typedPerim\? "Σ perimeter×qty \(typed perimeter, else 2×\(w\+h\)\)" : "Σ 2×\(w\+h\)×qty"/, "an untouched takeoff keeps its formula text");
  assert.match(est, /data-open-out=/); assert.equal((est.match(/refreshOpeningRows\(card,inst,f\)/g) || []).length, 2);
});

if (process.exitCode) {
  console.error("\nSome checks FAILED — see above.");
} else {
  console.log("All good.");
}
