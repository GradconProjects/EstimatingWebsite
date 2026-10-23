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
check("108 element types, 16 categories, 26 sections (ROOF 8 after SUSPENDED STRUCTURE; PRELIMINARIES 17 first; Basement Ramp beside Ramp; IRREGULAR CONCRETE CONSTRUCTIONS 3 before External & Landscape; SCREEDS 14, TOPPINGS 7, HYDRONIC HEATING 3, SPECIALIST FINISHING CONCRETE 10 — each its own category)", () => {
  assert.equal(ELEMENT_TYPES.length, 108);
  assert.equal(ELEMENT_TYPES.filter((t) => t.category === "IRREGULAR CONCRETE CONSTRUCTIONS").length, 3);
  assert.ok(ELEMENT_TYPES.some((t) => t.id === "hearth_fireplace_base" && t.labour === "composite"), "hearth is a priced Quotes element with a crew sheet");
  assert.ok(CATEGORY_ORDER.indexOf("IRREGULAR CONCRETE CONSTRUCTIONS") < CATEGORY_ORDER.indexOf("EXTERNAL & LANDSCAPE CONCRETE"), "irregular constructions sit with the structure, before landscape works");
  assert.ok(ELEMENT_TYPES.some((t) => t.id === "basement_ramp" && t.section === "GROUND-BEARING SLABS"), "Basement Ramp is its own selectable element");
  assert.equal(CATEGORY_ORDER.length, 16);
  assert.equal(SECTION_ORDER.length, 26);
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

check("20 material categories, 387 products (incl. the 17-row FINISHED PAVEMENTS & CONCRETE FINISHES band, the 45-row SAW CUTS & DOWELS band, CONCRETE PUMPING, REINFORCEMENT BY RATE, the 32-board INSULATION range, 31 SCREEDS, 17 HYDRONIC HEATING, 48 SPECIALIST FINISHING CONCRETE, 45 PRELIMINARIES, the full 24-size TRENCH MESH grid, Bored Piers subcontract, minimum cartage, levy, surcharge)", () => {
  assert.equal(FULL_CATALOG.length, 20);
  const total = FULL_CATALOG.reduce((s, c) => s + c.products.length, 0);
  assert.equal(total, 387);
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

check("Trench Mesh costs directly (NOT via tonnage): 10x 4 Bar-L12TM @ $41.19 = $411.90", () => {
  const rates = defaultRates();
  const type = ELEMENT_TYPES.find((t) => t.id === "strip_footings");
  const item = newElementItem(type);
  item.qtys[rateKey("TRENCH MESH", "4 Bar-L12TM", "length")] = 10;
  const cost = computeElementCost(item, rates);
  assert.equal(cost.categoryTotals["TRENCH MESH"], 411.9);
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

await checkAsync("FORMWORK follows the 22 Oct 2026 pattern: application groups in order, the depth-split edgeform, the three suspended rates, the retired beam/fold and per-day scaffold rows costing only where carried, the library's table matching name for name", async () => {
  const cat = FULL_CATALOG.find((c) => c.key === "FORMWORK");
  const live = cat.products.filter((p) => !p.legacy), retired = cat.products.filter((p) => p.legacy);
  assert.deepEqual([...new Set(live.map((p) => p.group))], ["Ground slabs", "Suspended", "Vertical", "Other"], "the application order");
  const byName = (n) => cat.products.find((p) => p.name === n);
  assert.deepEqual([byName("Edgeform").unit, byName("Edgeform").unitCost, byName("Edgeform").group], ["m", 25, "Ground slabs"], "ground-slab edgeform up to 400 mm: lineal metres at $25");
  assert.deepEqual([byName("Edgeform >400mm deep").unit, byName("Edgeform >400mm deep").unitCost], ["m2", 250]);
  assert.deepEqual(live.filter((p) => p.group === "Suspended").map((p) => [p.name, p.unit, p.unitCost]), [["Conventional", "m2", 200], ["Bondek", "m2", 150], ["Edgeform (suspended)", "m", 50]], "three suspended rates, the edgeform by the lineal metre");
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
  assert.ok(cost.categoryTotals["CONCRETE"] >= 11.3 * auto.unitCost - 1e-6, "the build-up prices on the CONCRETE band (plus the Holcim fees on the poured m³)");
  assert.equal(costOut.categoryTotals["CONCRETE"] || 0, 0); assert.ok(costOut.excludedBlinding >= 11.3 * auto.unitCost - 1e-6, "the master tick leaves the build-up out and states the money");
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
  assert.strictEqual(HO.liveHandover(q0, rates, "t0"), q0, "nothing poured, nothing tied — nothing written, no record");
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
  const u = HO.undoHandover(q7); assert.equal(u.handoverLive, false); assert.ok(u.handover.undoneAt);
  assert.ok(HO.liveHandoverApplies({ status: "Estimating" }) && HO.liveHandoverApplies({ status: "Queued" }) && HO.liveHandoverApplies({}) && HO.liveHandoverApplies({ status: "Completed Estimating", completedAt: "2026-10-13" }));
  assert.ok(!HO.liveHandoverApplies({ status: "Submitted" }) && !HO.liveHandoverApplies({ status: "On Hold" }) && !HO.liveHandoverApplies({ status: "Completed Estimating", completedAt: "2026-09-01" }) && !HO.liveHandoverApplies({ status: "Estimating", handoverLive: false }));
  // the editor runs it on every change to the elements, the banner says it is live
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assertTrue(/liveHandover\(q, effectiveRates\(q, liveRates\)\)/.test(app) && /\[quoteStatus, ratesStatus, quote\.status, quote\.items, quote\.handoverLive, quote\.completedAt, liveRates\]/.test(app) && !/shouldAutoHandover\(quote\)\) setQuote/.test(app));
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
    assertTrue(/data-testid="reword-for-tender"/.test(cell) && /data-testid="tender-wording-review"/.test(cell) && /data-testid="apply-tender-wording"/.test(cell) && /requestTenderWording\(/.test(cell) && /applyTenderWording\(/.test(cell) && (app.match(/onChangeAssumptions=\{\(assumptions\) => setQuote/g) || []).length === 3 && /data-testid="assumption-tender-wording"/.test(geo) && /clearTenderWording\(/.test(geo));
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
  assert.ok(cat.products.every((p) => p.unit === "m2" && p.unitCost > 0));
  assert.equal(cat.products.find((p) => /RECOMMENDED preliminary estimate rate/.test(p.name)).unitCost, 180);
  assert.equal(cat.products.find((p) => /^Exposed aggregate — standard/.test(p.name)).unitCost, 157.5);
  assert.equal(cat.products.find((p) => /^Ordinary grey/.test(p.name)).unitCost, 102.5);
  const build = cat.products.filter((p) => /^Build-up: /.test(p.name));
  assert.equal(build.length, 6); const sum = build.reduce((t, p) => t + p.unitCost, 0); assert.ok(sum >= 116 && sum <= 172, `build-up midpoints sum ${sum} inside the indicative $116–172`);
  const html = fs.readFileSync(new URL("../portal/rates-library.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("const PAVEMENT_FINISH_ITEMS"), html.indexOf("const SPECIALIST_CONCRETE_ITEMS"));
  const libNames = [...block.matchAll(/\{p:("(?:[^"\\]|\\.)*"),u:"m2",cost:([\d.]+)\}/g)].map((m) => [JSON.parse(m[1]), Number(m[2])]);
  assert.equal(libNames.length, cat.products.length, "library lists every product");
  cat.products.forEach((p) => { const hit = libNames.find(([n]) => n === p.name); assert.ok(hit, `library missing "${p.name}"`); assert.equal(hit[1], p.unitCost, `library price for ${p.name}`); });
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
  assert.deepEqual(FULL_CATALOG.filter((c) => c.visibleFor).map((c) => c.key).sort(), ["PRELIMINARIES", "SPECIALIST FINISHING CONCRETE"], "exactly two element-scoped bands");
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
  ["Queued", "Estimating", "On Hold"].forEach((st) => assert.equal(isRatesLocked(st), false, st));
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
  assert.deepEqual(OPEN_STATUSES, ["Queued", "Estimating"]);
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
  check("Google: the refresh token round-trips through AES-GCM under the client secret and a tampered blob is refused", () => { const enc = G.encryptText("1//refresh", genv); let bad = false; try { G.decryptText(enc.slice(0, -2) + "zz", genv); } catch { bad = true; } assertTrue(G.decryptText(enc, genv) === "1//refresh" && /^v1\./.test(enc) && !enc.includes("refresh") && bad); });
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
  assert.ok(!/action: "(send|reply|trash|delete)"/.test(page), "the page never writes to the mailbox");
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

if (process.exitCode) {
  console.error("\nSome checks FAILED — see above.");
} else {
  console.log("All good.");
}
