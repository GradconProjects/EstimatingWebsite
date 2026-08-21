/**
 * Gradcon catalog data.
 *
 * Plain data only — no React, no side effects. This file (and lib/costing.js,
 * which consumes it) is deliberately kept importable by plain Node so the
 * costing logic can be unit-tested without a browser (see scripts/verify.mjs).
 *
 * See CLAUDE.md at the project root for the business rules this data
 * encodes before changing anything here.
 */

/* ---------- Resource / labour catalog ---------- */
export const RESOURCE_COLS = [
  { key: "concreter_day", name: "Concreter", unit: "day", rate: 500 },
  { key: "excavator_day", name: "Excavator", unit: "day", rate: 900 },
  { key: "bobcat_day", name: "Bobcat", unit: "day", rate: 900 },
  { key: "pump_hr", name: "Pump", unit: "hr", rate: 250 },
  { key: "pump_m3", name: "Pump", unit: "m3", rate: 7 },
  { key: "steelfixer_day", name: "Steel fixer", unit: "day", rate: 650 },
  { key: "crane_day", name: "Crane", unit: "day", rate: 1600 },
  { key: "factory_hr", name: "Factory labour", unit: "hr", rate: 150 },
];

/* ---------- Labour task templates, keyed by the element's `labour` field ---------- */
export const LABOUR_TEMPLATES = {
  footing: ["Site setout as required", "Excavate & prep base", "Formwork / box out", "Tie steel", "Pour concrete", "Strip & tidy", "Factory labour"],
  wall: ["Site setout as required", "Excavate & prep (if required)", "Formwork (both faces)", "Tie steel", "Pour concrete", "Strip formwork", "Patch & clean up", "Factory labour"],
  slab_ground: ["Site setout as required", "Excavate & prep base", "Pour blinding", "Lay poly", "Tie steel / box slab", "Pour concrete", "Strip & tidy", "Factory labour"],
  slab_suspended: ["Site setout as required", "Prop & form suspended soffit", "Tie steel / box slab", "Pour concrete (pump)", "Strip formwork / props", "Strip & tidy", "Factory labour"],
};

/* ---------- Full material catalog ----------
 * weightBasis: true means Total Cost = (Qty * Unit Weight / 1000) * Unit Cost
 *              (Unit Cost is $/tonne). Only PROCESSED BAR is genuinely
 *              priced this way in Gradcon's supplier pricing.
 * weightBasis: false (the default) means Total Cost = Qty * Unit Cost,
 *              even for products that also carry a Unit Weight for
 *              informational tonnage (Trench Mesh, Square Mesh, Stock Bar
 *              are priced per length/sheet/bar, not per tonne).
 * See CLAUDE.md → "Costing rules" before changing this flag on any category.
 */
export const FULL_CATALOG = [
  { key: "TRENCH MESH", weightBasis: false, products: [
    ["3 Bar-L8TM", "length", 6.8, 14.39], ["4 Bar-L8TM", "length", 9.2, 18.58], ["5 Bar-L8TM", "length", 11.6, 25.87], ["6 Bar-L8TM", "length", 13.9, 31.05],
    ["3 Bar-L11TM", "length", 13.3, 24.43], ["4 Bar-L11TM", "length", 17.7, 33.79], ["5 Bar-L11TM", "length", 22.3, 41.3], ["6 Bar-L11TM", "length", 26.8, 50.66],
    ["3 Bar-L12TM", "length", 16.3, 30.07], ["4 Bar-L12TM", "length", 21.8, 41.19], ["5 Bar-L12TM", "length", 27.3, 50.66], ["6 Bar-L12TM", "length", 32.8, 61.84], ["7 Bar-L12TM", "length", 38.75, 103.5],
    ["3 Bar-L16TM", "length", 28.9, 91.08], ["4 Bar-L16TM", "length", 38.5, 92.89],
  ]},
  { key: "SQUARE MESH", weightBasis: false, products: [
    ["SL52", "sheet", 21, 50.64], ["SL62", "sheet", 33, 61.84], ["SL72", "sheet", 41, 74.62], ["SL82", "sheet", 52, 98.12], ["SL92", "sheet", 66, 116.54],
    ["SL102", "sheet", 80, 141.18], ["SL81", "sheet", 105, 185.27], ["RL718", "sheet", 67, 168.71], ["RL818", "sheet", 79, 196], ["RL918", "sheet", 93, 230.73],
    ["RL1018", "sheet", 109, 255.85], ["RL1118", "sheet", 130.53, 231.12], ["RL1218", "sheet", 157, 328.1],
  ]},
  { key: "STOCK BAR", weightBasis: false, products: [
    ["N12 - 6.0m length", "each", 5.46, 10], ["N16 - 6.0m length", "each", 9.6, 17.51], ["N20 - 6.0m length", "each", 15.19, 27.76],
    ["N24 - 6.0m length", "each", 21.83, 38.68], ["N28 - 6.0m length", "each", 29.71, 57.9], ["N32 - 6.0m length", "each", 38.81, 70.86],
  ]},
  { key: "PROCESSED BAR", label: "PROCESSED BAR (unit cost $/tonne, applied to Total Weight)", weightBasis: true, products: [
    ["N10", "m", 0.632, 1930], ["N12", "m", 0.91, 1930], ["N16", "m", 1.6, 1930], ["N20", "m", 2.532, 1930], ["N24", "m", 3.639, 1930],
    ["N28", "m", 4.951, 1930], ["N32", "m", 6.468, 1930], ["N36", "m", 8.19, 1930], ["N40", "m", 10.107, 1930],
  ]},
  { key: "REINFORCING ACCESSORIES", weightBasis: false, products: [
    ["Delivery fee", "each", null, 300], ["Poly", "roll", null, 89.4], ["Duct Tape", "roll", null, 4.5], ["Abelflex 100mm", "roll", null, 36],
    ["Abelflex 150mm", "roll", null, 54], ["CP 25/40 Bar chairs", "bag", null, 16.2], ["CP 50/65 Bar chairs", "bag", null, 17.4],
    ["CP 75/90 Bar chairs", "bag", null, 21], ["CP 85/100 Bar chairs", "bag", null, 24], ["BCPT 30 Bar chairs", "bag", null, 19.2],
    ["BCPT 100 Bar chairs", "bag", null, 45.6], ["Base 152", "bag", null, 36.6], ["BP1.6 Tie wire", "roll", null, 5.15],
  ]},
  { key: "CONCRETE", weightBasis: false, products: [
    ["25 mpa Agilia", "m3", null, 310.5], ["32 mpa Agilia", "m3", null, 322.5], ["40 mpa Agilia", "m3", null, 334.5], ["40 mpa Agilia (walls)", "m3", null, 342.5],
    ["15 mpa", "m3", null, 196.5], ["20 mpa", "m3", null, 207.5], ["25 mpa", "m3", null, 212.5], ["32 mpa", "m3", null, 221.5], ["40 mpa", "m3", null, 233.5],
    ["50 mpa", "m3", null, 252.5], ["Exposed Agg", "m3", null, 400], ["Small load charge", "m3", null, 47.25], ["Penetron (Xypex) additive", "m3", null, 100],
  ]},
  { key: "RATE ITEMS", weightBasis: false, products: [
    ["Hobbs", "m", null, 105], ["Plinths", "m2", null, 610], ["0-50mm set downs", "m", null, 20], ["51-100mm set downs", "m", null, 45],
    ["101mm-150mm setdown", "m", null, 80], ["Steps", "m", null, 200], ["Screeds", "m2", null, 120], ["Screeds (decorative)", "m2", null, 140],
    ["Insitu Walls", "m2", null, 760], ["Stair (floor-floor)", "l/m risers", null, 682], ["Shotcrete", "m2", null, 300],
  ]},
  { key: "FORMWORK", weightBasis: false, products: [
    ["Material", "unit", null, 400], ["Conventional", "m2", null, 150], ["Bondek", "m2", null, 125], ["Edgeform", "m", null, 50],
    ["Beam/fold sides <400mm d", "m", null, 100], ["Beam/fold sides >400mm d", "m2", null, 250], ["Handrail", "m", null, 30],
    ["Walls", "m2", null, 250], ["Walls Curved", "m2", null, 350], ["Columns (eg 300x300)", "each", null, 1000],
    ["Oregon boards", "m2", null, 125], ["Crane Truck hire", "each", null, 1500], ["Scaffold Hire", "day", null, 175], ["Certification", "each", null, 400],
  ]},
  { key: "OTHER ACCESSORIES", weightBasis: false, products: [
    ["Packing sand", "m3", null, 50], ["Crushed Rock", "m3", null, 63], ["Insulation", "m2", null, 25], ["Epoxy", "unit", null, 70],
    ["Marking Paint", "unit", null, 4], ["Sealers/Acid/MBT", "each", null, 400], ["Curing Products", "price", null, 100],
  ]},
  { key: "OTHER ALLOWANCES", weightBasis: false, products: [
    ["Inspector", "each", null, 130], ["Soil removal", "m3", null, 40], ["Bin Hire", "each", null, 600], ["Sawcutting", "day", null, 450],
    ["Concrete test", "each", null, 241.5], ["Off-site washout fee", "each", null, 400], ["Truck washout fee", "each", null, 10.5],
  ]},
  { key: "SUB CONTRACTORS / TEMPORARY WORKS", weightBasis: false, products: [
    ["Formwork (subcontract)", "quote", null, null], ["Steel supply", "quote", null, null], ["Steel fix", "quote", null, null],
    ["Screw Piling", "quote", null, null], ["CFA Piling", "quote", null, null],
    ["Temporary steel props/struts (150UC23.4) — supply/hire", "tonne", null, 3200],
  ]},
].map((c) => ({
  ...c,
  label: c.label || c.key,
  products: c.products.map(([name, unit, unitWeight, unitCost]) => ({ name, unit, unitWeight, unitCost })),
}));

/* ---------- Element types ----------
 * One entry per "tab" in the original workbook. `section` groups them on
 * the Add-Element dropdown and the Quote Summary — keep the array in
 * ground-up construction sequence (piling → propping → columns → capping
 * beams → footings → walls → pool → planter → slabs → beams) since that
 * order is meaningful to an estimator scanning the list, not arbitrary.
 */
export const ELEMENT_TYPES = [
  { id: "piles_bored", section: "PILING", name: "Piles - Bored Piers", labour: "footing" },
  { id: "screw_piles", section: "PILING", name: "Screw Piles", labour: "footing" },
  { id: "anchor_block_strut", section: "TEMPORARY PROPPING", name: "Anchor Block & Strut", labour: "footing" },
  { id: "rc_columns", section: "COLUMNS", name: "RC Columns - Fence Post Columns", labour: "footing" },
  { id: "capping_beam", section: "CAPPING BEAMS", name: "Capping Beam", labour: "footing" },
  { id: "pile_caps_pad", section: "PILE CAPS & PAD FOOTINGS", name: "Pile Caps - Pad Footings", labour: "footing" },
  { id: "strip_footings", section: "STRIP FOOTINGS", name: "Strip Footings", labour: "footing" },
  { id: "shotcrete_wall", section: "SHOTCRETE RETENTION WALLS", name: "Shotcrete Retention Wall", labour: "wall" },
  { id: "retaining_wall", section: "RETAINING & BOUNDARY WALLS", name: "Basement - Retaining Wall", labour: "wall" },
  { id: "pool_wall", section: "POOL CONSTRUCTION", name: "Pool Wall", labour: "wall" },
  { id: "pool_slab", section: "POOL CONSTRUCTION", name: "Pool Slab", labour: "slab_ground" },
  { id: "planter_wall", section: "PLANTER WALLS", name: "Planter Wall", labour: "wall" },
  { id: "slab_on_ground", section: "GROUND-BEARING SLABS", name: "Slab on Ground (Garage / Tennis Court / Plant Room / Hardstand)", labour: "slab_ground" },
  { id: "ramp", section: "GROUND-BEARING SLABS", name: "Ramp", labour: "slab_ground" },
  { id: "suspended_beam", section: "SUSPENDED BEAMS", name: "Suspended Beam", labour: "slab_suspended" },
  { id: "suspended_slab", section: "SUSPENDED SLAB", name: "Suspended Slab", labour: "slab_suspended" },
];

export const SECTION_ORDER = [...new Set(ELEMENT_TYPES.map((t) => t.section))];

/* ---------- Overhead/contingency/margin ladder ----------
 * Applied in sequence: Direct Cost -> (+Overheads% +Contingency%) ->
 * Subtotal -> /(1-margin) -> Sell ex GST -> *1.1 -> Sell inc GST.
 * Percentages are always stored as fractions (0.08, not 8) — see
 * CLAUDE.md "the 15-vs-0.15 gotcha" before touching this.
 */
export const MARGIN_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
export const DEFAULT_MARGIN = 0.30;
export const GST_RATE = 0.10; // Australian GST — change here if this is ever used outside AU
