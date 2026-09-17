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
// Crew-sheet columns, in the order they read on Gradcon's labour sheet:
// the three 3+-person crews first, then plant, pump (hr AND m³ — distinct
// keys, see CLAUDE.md rule 5), crane. `crew: true` marks the minimum-crew
// columns; they count CREW-days (a whole crew booked for a day), so their
// rates are PER CREW: Concrete Crew 3 men, Steel Crew 5 men, General Labour
// 3 men. Plant stays per unit-day; pumping is $10/m³ plus $250/hr.
// The crew units are "crew-day" (not "day") ON PURPOSE: the per-crew rates
// replaced per-person rates saved in existing installs under the old
// name+"day" keys, and the changed unit retires those stale overrides —
// lookupRate falls back to these new catalog defaults (CLAUDE.md rule 6).
// A concrete order under this volume (per element/pour) attracts the
// catalog's "Minimum cartage" automatically — see autoMinimumCartage in
// lib/costing.js. Typed values on the Minimum cartage row always win.
//
// MINIMUM CARTAGE. The poured volume is divided by this minimum load size
// into whole loads and the REMAINDER of that division — a part load — is
// charged $80 for every m³ it falls short of it: 11 m³ is 2 loads + 3 m³,
// so 1 m³ short, $80; 12 m³ divides evenly and costs nothing. This figure
// is BOTH the divisor and the minimum.
//
// It is only the fallback: the live value is the editable "Minimum cartage
// load size" production rate (see PRODUCTION_RATES below), so a supplier
// working to a different minimum is a rate edit, not a code change. The
// $/m³ is editable on the row itself, and typing a quantity on the row
// takes it fully manual for a known delivery split.
export const MIN_CARTAGE_THRESHOLD_M3 = 4;
// Kept as an alias so saved code/tests referring to the old name still read.
export const SMALL_LOAD_THRESHOLD_M3 = MIN_CARTAGE_THRESHOLD_M3;
export const TRUCK_LOAD_M3 = 8;

// Crew columns are priced PER PERSON per day ("man-day" unit — a fresh key
// that retires both the original per-person "day" overrides and the
// crew-era "crew-day" ones). Each crew-sheet ROW chooses its own mode:
// per-crew cells are crew-days costed as cells × that row's men-per-crew ×
// this man-day rate (row's men blank → the column's `men` default below);
// per-person cells are man-days costed directly. Defaults reproduce the
// old crew pricing exactly (3 × $500 = $1,500 concrete crew-day, 5 × $650
// = $3,250 steel crew-day, …).
export const RESOURCE_COLS = [
  { key: "concreter_day", name: "Concrete Crew", unit: "man-day", rate: 500, crew: true, men: 3 },
  { key: "steelfixer_day", name: "Steel Crew", unit: "man-day", rate: 650, crew: true, men: 5 },
  // Formwork crew-days are always entered MANUALLY — the engine never
  // auto-fills this column (propping effort varies too much by system).
  { key: "formwork_day", name: "Formwork Crew", unit: "man-day", rate: 500, crew: true, men: 3 },
  { key: "labourer_day", name: "General Labour Crew", unit: "man-day", rate: 400, crew: true, men: 3 },
  { key: "excavator_day", name: "Excavator", unit: "day", rate: 900 },
  { key: "bobcat_day", name: "Bobcat", unit: "day", rate: 900 },
  { key: "truck_day", name: "Trucks", unit: "day", rate: 900 },
  { key: "pump_hr", name: "Pump", unit: "hr", rate: 250 },
  { key: "pump_m3", name: "Pump", unit: "m³", rate: 10 },
  { key: "crane_day", name: "Crane", unit: "day", rate: 1600 },
];

/* ---------- Production rates ----------
 * Labour-productivity rates (hours per m³ / per tonne) used to suggest
 * — never force — labour hours in an element's Labour/Equipment matrix
 * from quantities already entered in its material rows. Mirrors Rates
 * Library's own concreteLabour.placingHrsPerM3/finishingHrsPerM3 and
 * steel fixingLabourHrsPerT fields (same real-world numbers), kept as
 * Quotes' own separate, independently-editable copy — Quotes has always
 * had its own rates system rather than reading Rates Library's live data,
 * see CLAUDE.md. Suggestions only ever fill a genuinely empty cell; see
 * suggestedLabourPrefill in lib/costing.js.
 */
// Crew-block rules: how much work ONE crew-day (or one plant-day) covers.
// The engine works in whole crews: the transferred quantity is rounded UP to
// a whole unit in the background (0.13 t books a full tonne's crew) and then
// to whole crew-days — the Qty column still DISPLAYS the true quantity.
// All editable in the Rates modal like every other rate.
export const PRODUCTION_RATES = [
  { key: "pour_m3_crewday", name: "Concrete pour — m³ per crew-day", unit: "m³/day", rate: 10 },
  { key: "steel_t_crewday", name: "Rebar fixing — tonnes per crew-day", unit: "t/day", rate: 1 },
  { key: "finish_m2_crewday", name: "Surface finishing — m² per crew-day", unit: "m²/day", rate: 300 },
  { key: "general_m3_crewday", name: "General labour — m³ per crew-day", unit: "m³/day", rate: 60 },
  // No formwork or excavation blocks: those crew/plant cells are NOT
  // auto-derived (propping effort varies by system, excavator days by ground
  // conditions) — entered manually, always. Their Qty columns still prefill.
  { key: "pump_hrs_pour", name: "Concrete pump — hours per pour", unit: "hrs", rate: 6 },
  // The load size the minimum-cartage split divides by. The poured volume is
  // divided by this into whole loads and the remainder is charged the
  // minimum-cartage rate for every m³ it falls short of it — so this one
  // figure is both the divisor and the minimum. Edit it if a supplier works
  // to a different minimum load.
  { key: "min_cartage_m3", name: "Minimum cartage load size", unit: "m³/load", rate: 4 },
  // The agitator size. Informational since minimum cartage moved to dividing
  // by the minimum itself — kept so no saved override is orphaned, and so a
  // job that wants to reason about truck counts still has the figure.
  { key: "truck_load_m3", name: "Concrete truck load size", unit: "m³/load", rate: 8 },
  // VicMix (SPECIALIST FINISHING CONCRETE): published prices apply to a
  // minimum 4 m³ delivery in a Maxi truck within 25 km of the plant. The
  // truck size sets how many washout charges a pigmented pour attracts.
  { key: "vicmix_min_m3", name: "VicMix minimum delivery (Maxi truck)", unit: "m³/load", rate: 4 },
  { key: "vicmix_truck_m3", name: "VicMix Maxi truck load size", unit: "m³/load", rate: 7 },
  { key: "vicmix_radius_km", name: "VicMix published-price delivery radius", unit: "km", rate: 25 },
];
export const SPECIALIST_CONCRETE_KEY = "SPECIALIST FINISHING CONCRETE";

/* ---------- Labour task templates, keyed by the element's `labour` field ---------- */
// ONE fixed crew-sheet task structure for every element type (matching the
// paper labour sheet: setup, excavate, tie, pour, finish, washout, plus two
// free additional rows). The template keys survive because every
// ELEMENT_TYPES entry references one. Elements saved before this change
// keep the task rows they were created with.
const CREW_SHEET_TASKS = [
  "Site setup / mobilisation",
  "Excavate & prepare base",
  "Tie reinforcement",
  "Pour / place / vibrate concrete",
  "Finish concrete surfaces",
  "Washout / clean / tidy",
  "Additional labour / plant",
  "Additional labour / plant",
];
// Preliminaries have no pour: their crew sheet lists the site-management
// work instead (the only template whose task sequence genuinely differs).
const PRELIM_TASKS = [
  "Site establishment / mobilisation",
  "Traffic management / control",
  "Temporary access, protection & hoarding",
  "Site services, amenities & cleaning",
  "Supervision, safety & compliance",
  "Demobilisation / make good",
  "Additional labour / plant",
  "Additional labour / plant",
];
export const LABOUR_TEMPLATES = {
  prelims: PRELIM_TASKS,
  excavation: CREW_SHEET_TASKS,
  footing: CREW_SHEET_TASKS,
  wall: CREW_SHEET_TASKS,
  slab_ground: CREW_SHEET_TASKS,
  slab_suspended: CREW_SHEET_TASKS,
  stairs: CREW_SHEET_TASKS,
  // Floor finishes laid on a structure: same crew sheet, own keys so a
  // future screed/topping-specific task list can be swapped in per family.
  screed: CREW_SHEET_TASKS,
  topping: CREW_SHEET_TASKS,
  hydronic: CREW_SHEET_TASKS,
  finishing: CREW_SHEET_TASKS,
};

/* ---------- Full material catalog ----------
 * weightBasis: true means Total Cost = (Qty * Unit Weight / 1000) * Unit Cost
 *              (Unit Cost is $/tonne). Only PROCESSED BAR is genuinely
 *              priced this way in Gradcon's supplier pricing.
 * areaBasis: true means Qty is entered in m² of coverage and Total Cost =
 *            ceil(Qty / Sheet Area) * Unit Cost (Unit Cost is $/sheet).
 *            Only SQUARE MESH works this way — sheets are bought whole, so
 *            the estimator enters the area to cover and the tool works out
 *            how many sheets that requires, rather than making them count
 *            sheets by hand.
 * weightBasis: false, areaBasis: false (the default) means Total Cost =
 *              Qty * Unit Cost, even for products that also carry a Unit
 *              Weight for informational tonnage (Trench Mesh is priced per
 *              length, not per tonne).
 * lengthBasis: true means Qty is entered in metres of bar needed and Total
 *              Cost = ceil(Qty / Bar Length) * Unit Cost (Unit Cost is
 *              $/bar, Bar Length is the fixed stock length in metres —
 *              6.0m for every current STOCK BAR product). Only STOCK BAR
 *              works this way — bars are bought as whole fixed-length
 *              sticks, so the estimator enters the run of metres needed and
 *              the tool works out how many whole bars that requires, the
 *              same idea as areaBasis/SQUARE MESH but by length instead of
 *              area.
 * volumeRateBasis: true means Qty is entered as a REINFORCEMENT RATE in
 *              kg of steel per m³ of concrete, and Total Cost =
 *              (Qty * the element's poured m³ / 1000) * Unit Cost (Unit Cost
 *              is $/tonne, as for weightBasis). This is the one basis whose
 *              cost depends on ANOTHER category's quantities — the concrete
 *              rows — so computeRowTotal takes a 4th `ctx` argument
 *              ({concreteM3}) that every caller builds with rowContext(item).
 *              Only REINFORCEMENT BY RATE works this way. An element with no
 *              concrete entered costs nothing here, however high the rate.
 * See CLAUDE.md → "Costing rules" before changing any of these flags on any
 * category, and lib/costing.js → computeRowTotal, the ONE place that
 * implements this — never recompute a row total inline elsewhere.
 */
export const FULL_CATALOG = [
  /* The full L-series trench mesh grid: every bar width from 3 to 8 in each
   * of the four wire gauges, so a schedule calling up a 7 Bar-L11TM has a
   * product to hit instead of forcing the nearest wrong size. Bars sit at
   * 100mm centres, so bar count also reads as the strip width.
   *
   * The 3-6 bar L8/L11/L12 sizes and 7 Bar-L12TM / 3-4 Bar-L16TM are
   * Gradcon's own supplier-confirmed prices and are untouched. The sizes
   * added to complete the grid carry a mass extrapolated from that family's
   * own per-bar increment (L8TM +2.4, L11TM +4.5, L12TM +5.5, L16TM +9.6 kg
   * per 6m sheet) and a price at that family's own average $/kg — DERIVED,
   * not quoted, so confirm them with the supplier before relying on one. As
   * with every catalog price these are only what a fresh install seeds; the
   * Rates modal overrides win (see lookupRate). */
  { key: "TRENCH MESH", weightBasis: false, products: [
    ["3 Bar-L8TM", "length", 6.8, 14.39], ["4 Bar-L8TM", "length", 9.2, 18.58], ["5 Bar-L8TM", "length", 11.6, 25.87], ["6 Bar-L8TM", "length", 13.9, 31.05], ["7 Bar-L8TM", "length", 16.3, 35.05], ["8 Bar-L8TM", "length", 18.7, 40.21],
    ["3 Bar-L11TM", "length", 13.3, 24.43], ["4 Bar-L11TM", "length", 17.7, 33.79], ["5 Bar-L11TM", "length", 22.3, 41.3], ["6 Bar-L11TM", "length", 26.8, 50.66], ["7 Bar-L11TM", "length", 31.3, 58.59], ["8 Bar-L11TM", "length", 35.8, 67.02],
    ["3 Bar-L12TM", "length", 16.3, 30.07], ["4 Bar-L12TM", "length", 21.8, 41.19], ["5 Bar-L12TM", "length", 27.3, 50.66], ["6 Bar-L12TM", "length", 32.8, 61.84], ["7 Bar-L12TM", "length", 38.75, 103.5], ["8 Bar-L12TM", "length", 44.25, 82.7],
    ["3 Bar-L16TM", "length", 28.9, 91.08], ["4 Bar-L16TM", "length", 38.5, 92.89], ["5 Bar-L16TM", "length", 48.1, 133.86], ["6 Bar-L16TM", "length", 57.7, 160.58], ["7 Bar-L16TM", "length", 67.3, 187.29], ["8 Bar-L16TM", "length", 76.9, 214.01],
  ]},
  /* areaBasis: qty is entered in m² of coverage, not sheet count — a
   * standard AU mesh sheet is 6.0m x 2.4m = 14.4m², so cost is
   * ceil(qty / sheetArea) * unitCost (you can't buy a fraction of a
   * sheet). unitCost is still genuinely $/sheet. See computeRowTotal in
   * lib/costing.js — this mirrors the weightBasis pattern (Processed Bar)
   * but converts by sheet coverage instead of by weight. */
  { key: "SQUARE MESH", weightBasis: false, areaBasis: true, products: [
    ["SL52", "m2", 21, 50.64, 14.4], ["SL62", "m2", 33, 61.84, 14.4], ["SL72", "m2", 41, 74.62, 14.4], ["SL82", "m2", 52, 98.12, 14.4], ["SL92", "m2", 66, 116.54, 14.4],
    ["SL102", "m2", 80, 141.18, 14.4], ["SL81", "m2", 105, 185.27, 14.4], ["RL718", "m2", 67, 168.71, 14.4], ["RL818", "m2", 79, 196, 14.4], ["RL918", "m2", 93, 230.73, 14.4],
    ["RL1018", "m2", 109, 255.85, 14.4], ["RL1118", "m2", 130.53, 231.12, 14.4], ["RL1218", "m2", 157, 328.1, 14.4],
  ]},
  // Stock Bar's unitCost is derived from a flat $1825/tonne (GRADCON_STOCK_BAR_RATE_PER_TONNE)
  // × each bar's own unitWeight — same "one real steel rate, converted per product" approach
  // Processed Bar already uses below. It's still priced $/bar (lengthBasis), not by weight —
  // see rule 2 in CLAUDE.md — this only changes where the $/bar number comes from.
  { key: "STOCK BAR", weightBasis: false, lengthBasis: true, products: [
    ["N10 Ligatures - 6.0m length", "m", 3.79, 6.92, null, 6],
    ["N12 - 6.0m length", "m", 5.46, 9.96, null, 6], ["N16 - 6.0m length", "m", 9.6, 17.52, null, 6], ["N20 - 6.0m length", "m", 15.19, 27.72, null, 6],
    ["N24 - 6.0m length", "m", 21.83, 39.84, null, 6], ["N28 - 6.0m length", "m", 29.71, 54.22, null, 6], ["N32 - 6.0m length", "m", 38.81, 70.83, null, 6],
  ]},
  // Uniform $1925/tonne (GRADCON_PROCESSED_BAR_RATE_PER_TONNE, matching Rates Library's own
  // constant) across every diameter — Processed Bar has always been priced this way, a single
  // flat mill rate rather than a per-diameter price.
  { key: "PROCESSED BAR", label: "PROCESSED BAR (unit cost $/tonne, applied to Total Weight)", weightBasis: true, products: [
    ["N10", "m", 0.632, 1925], ["N12", "m", 0.91, 1925], ["N16", "m", 1.6, 1925], ["N20", "m", 2.532, 1925], ["N24", "m", 3.639, 1925],
    ["N28", "m", 4.951, 1925], ["N32", "m", 6.468, 1925], ["N36", "m", 8.19, 1925], ["N40", "m", 10.107, 1925],
  ]},
  /* Reinforcement priced off a RATE rather than a schedule — the way a job is
   * costed before anyone has bar-listed it ("call it 90 kg/m³"). Qty is the
   * rate in kg per m³ of concrete; the tonnage follows from the concrete rows
   * entered on this same element, so raising the pour raises the steel with
   * it. Unit cost is $/tonne, the same real steel rates the schedule
   * categories above are built from ($1925/t processed, $1825/t stock), and
   * editable in the Rates modal like any other product.
   *
   * These rows are an ALTERNATIVE to bar-listing, not an addition to it — an
   * element with both a schedule and a rate entered is buying its steel
   * twice. Left as the estimator's call (blank costs nothing, exactly like
   * every other row) rather than being enforced, but that's why the rate
   * lines say so on their face. */
  { key: "REINFORCEMENT BY RATE", label: "REINFORCEMENT BY RATE (kg per m³ of concrete — use INSTEAD OF a bar schedule)", weightBasis: false, volumeRateBasis: true, products: [
    ["Reinforcement rate — processed bar (cut & bent)", "kg/m3", null, 1925],
    ["Reinforcement rate — stock bar (straight lengths)", "kg/m3", null, 1825],
    ["Reinforcement rate — mesh & bar combined", "kg/m3", null, 1925],
  ]},
  { key: "REINFORCING ACCESSORIES", weightBasis: false, products: [
    ["Delivery fee", "each", null, 300], ["Poly", "roll", null, 89.4],
    // Same product Poly already covers (a roll of polythene sheeting), but named explicitly so
    // it's findable by name rather than only recognisable to someone who already knows "Poly" is
    // it — kept as a SEPARATE product rather than renaming Poly, since Poly is an existing,
    // rateKey-identified product a live quote could already have a quantity saved against;
    // renaming it would silently orphan that entry from the UI (see CLAUDE.md rule 6).
    ["Vapour Barrier / DPM membrane", "m2", null, 2.5],
    ["Duct Tape", "roll", null, 4.2], ["Abelflex 100mm", "roll", null, 36],
    ["Abelflex 150mm", "roll", null, 54], ["CP 25/40 Bar chairs", "bag", null, 17.4], ["CP 50/65 Bar chairs", "bag", null, 18],
    ["CP 75/90 Bar chairs", "bag", null, 22.2], ["CP 85/100 Bar chairs", "bag", null, 25.2], ["BCPT 30 Bar chairs", "bag", null, 20.4],
    ["BCPT 100 Bar chairs", "bag", null, 48], ["Base 152", "bag", null, 38.4], ["BP1.6 Tie wire", "roll", null, 4.8],
  ]},
  { key: "CONCRETE", weightBasis: false, products: [
    ["25 mpa Agilia", "m3", null, 318], ["32 mpa Agilia", "m3", null, 317], ["40 mpa Agilia", "m3", null, 339], ["40 mpa Agilia (walls)", "m3", null, 339],
    ["15 mpa", "m3", null, 197], ["20 mpa", "m3", null, 199], ["25 mpa", "m3", null, 204], ["32 mpa", "m3", null, 213], ["40 mpa", "m3", null, 225],
    ["50 mpa", "m3", null, 264.2], ["Exposed Agg", "m3", null, 400],
    // Holcim service fees. Minimum cartage is $/m³ SHORT of a 4 m³ load (see
    // MIN_CARTAGE_THRESHOLD_M3); the levy and surcharge are $/m³ delivered.
    ["Minimum cartage (load under 4 m3)", "m3", null, 80],
    ["Production & transport surcharge", "m3", null, 9.17],
    ["Environment levy", "m3", null, 2.8],
    ["Penetron (Xypex) additive", "m3", null, 100],
    // Blinding is normally a low-strength unreinforced mix — seeded at the same rate as 15 mpa
    // (the lowest plain mix already in this catalog) rather than inventing a new price point.
    ["Blinding concrete", "m3", null, 196.5],
  ]},
  /* J. King concrete pumping schedule. `minQty` is the contract MINIMUM
   * billed quantity — a 4-hour-minimum pump costs 4 hours even if it's on
   * site for one, so computeRowTotal bills max(qty, minQty). Every rate and
   * every minimum is editable in the Rates modal like any other product.
   * The two "quote only" lines carry no rate: price them from the supplier's
   * quote by typing the total on the row. */
  /* Specialist finishing concrete — VicMix exposed / decorative mixes at
   * their PUBLISHED $/m³ (ex GST; VicMix's list applies to minimum 4 m³
   * deliveries in a Maxi truck within 25 km of the plant, and prices change —
   * every figure is editable in the Rates modal and the Rates Library), other
   * decorative finishes priced per m², and the supplier charges: pigment
   * mixes attract a $40 per truck (+ GST) washout charge, auto-applied per
   * truck of pigmented mix (autoPigmentWashout, editable "VicMix Maxi truck
   * load size" production rate), and a delivery under the 4 m³ minimum
   * flags a short-load charge (autoSpecialistShortLoad — VicMix does not
   * publish the amount, so it seeds at $0 until entered). This concrete is
   * poured volume for crew days and kg/m³ reinforcement, but NOT for the
   * Holcim delivery fees on the CONCRETE band (different supplier). */
  { key: "SPECIALIST FINISHING CONCRETE", label: "SPECIALIST FINISHING CONCRETE (VicMix exposed / decorative mixes $/m³ published — min 4 m³ Maxi within 25 km, prices may change; pigment mixes + $40/truck washout)", weightBasis: false,
    // The ONE band that is not on every card (rule 1 exception, by request):
    // it appears — and is costed — only on elements of the matching element
    // category (categoryAppliesTo), i.e. the Specialist Finishing Concrete
    // elements in the Add-Element dropdown. Every other band stays everywhere.
    visibleFor: ["SPECIALIST FINISHING CONCRETE"], products: [
    ["VicMix Fusion Ash — grey cement, grey granite/dark aggregate", "m3", null, 330],
    ["VicMix Meridian 37 Ash — grey cement, predominantly dark stone", "m3", null, 340],
    ["VicMix Meridian 55 Ash — grey cement, light grey/brown/black aggregate", "m3", null, 340],
    ["VicMix Himalayas Ash — grey cement, small dark stone", "m3", null, 340],
    ["VicMix Cobram 91 Ash — grey cement, light grey/brown/black", "m3", null, 365],
    ["VicMix Sienna Ash — grey cement, light grey/brown aggregate", "m3", null, 365],
    ["VicMix Baltic 91 Ash — grey cement, red/brown/black", "m3", null, 370],
    ["VicMix Amber Ash — grey cement, red/brown aggregate", "m3", null, 390],
    ["VicMix Fusion Half Black — charcoal, grey granite/dark aggregate", "m3", null, 395],
    ["VicMix Cobram 28 Half Black — charcoal, large dark + light stone", "m3", null, 405],
    ["VicMix Bahrain Half Black — charcoal, light grey/brown rounded aggregate", "m3", null, 405],
    ["VicMix Lipari Ivory — off-white cement with black stone", "m3", null, 425],
    ["VicMix Meridian 37 Half Black — charcoal, dark stone/brown aggregate", "m3", null, 430],
    ["VicMix Panuba 55 Ivory — off-white, light grey/brown rounded aggregate", "m3", null, 450],
    ["VicMix Blizzard 19 Half Black — charcoal, dark stone + white quartz", "m3", null, 455],
    ["VicMix Lipari Black — black background, large dark stone", "m3", null, 455],
    ["VicMix Bahrain Ivory — off-white, light grey/brown rounded aggregate", "m3", null, 465],
    ["VicMix Cobram 91 Ivory — off-white, light grey/brown/black", "m3", null, 465],
    ["VicMix Meridian 82 Ivory — off-white, light grey/brown/black", "m3", null, 465],
    ["VicMix Sienna Ivory — off-white, grey/brown aggregate", "m3", null, 465],
    ["VicMix Baltic 91 Ivory — off-white, red/brown/black aggregate", "m3", null, 470],
    ["VicMix Amber Ivory — off-white, red/brown aggregate", "m3", null, 490],
    ["VicMix Amber Ash + Cappuccino Oxide — cappuccino coloured base, red/brown aggregate", "m3", null, 490],
    ["VicMix Walsh 118 Black — black, large dark + brown/white stone", "m3", null, 495],
    ["VicMix Ares 46 Ivory — off-white, red/brown/light aggregate", "m3", null, 505],
    ["VicMix Rio 28 Half Black — charcoal, dark stone + white quartz", "m3", null, 530],
    ["VicMix Alpine Ivory — off-white, predominantly white quartz", "m3", null, 625],
    // Other decorative finishes and treatments (finishing work per m² unless stated)
    ["Exposed aggregate — retarder wash-off finish (finishing only)", "m2", null, 18],
    ["Exposed aggregate — seeded decorative aggregate (supply & seed)", "m2", null, 38],
    ["Honed / ground exposed aggregate finish", "m2", null, 65],
    ["Polished concrete — mechanical grind & polish", "m2", null, 95],
    ["Burnished / power-trowel finish", "m2", null, 14],
    ["Broom / non-slip finish", "m2", null, 4],
    ["Salt finish", "m2", null, 12],
    ["Stamped / stencilled pattern finish", "m2", null, 55],
    ["Acid-wash / etched finish", "m2", null, 10],
    ["Sandblasted finish", "m2", null, 25],
    ["Coloured concrete — oxide pigment surcharge (per m³, other supplier)", "m3", null, 65],
    ["Off-white / white cement base surcharge (per m³, other supplier)", "m3", null, 110],
    ["Decorative sealer — penetrating, 2 coats", "m2", null, 12],
    ["Decorative sealer — acrylic gloss / matt, 2 coats", "m2", null, 10],
    ["Concrete densifier / hardener", "m2", null, 8],
    ["Sample panel / mock-up", "each", null, 650],
    // Supplier charges and catch-alls
    ["VicMix pigment washout charge — per truck (+ GST, pigmented mixes)", "truck", null, 40],
    ["VicMix short-load charge — delivery under the 4 m³ Maxi minimum", "load", null, 0],
    ["VicMix delivery beyond 25 km of plant — per load", "load", null, 0],
    ["Specialist finishing concrete (subcontract quote)", "quote", null, 0],
    ["Specialist finish (other — specify in description)", "m2", null, 60],
  ]},
  { key: "CONCRETE PUMPING", weightBasis: false, products: [
    ["Line pump — up to 70m of line (4 hr min)", "hr", null, 200, null, null, 4],
    ["Line pump — 70-90m of line (4 hr min)", "hr", null, 240, null, null, 4],
    ["Line pump — over 90m of line (quote only)", "quote", null, 0],
    ["Boom pump — 28-32m boom (4 hr min)", "hr", null, 220, null, null, 4],
    ["Boom pump — 37m boom (4 hr min)", "hr", null, 230, null, null, 4],
    ["Boom pump — 42m boom (4 hr min)", "hr", null, 240, null, null, 4],
    ["Boom pump — 47m boom and above (quote only)", "quote", null, 0],
    ["Travel charge (1 hr min, at the pump's hourly rate)", "hr", null, 220, null, null, 1],
    ["Pumped volume", "m3", null, 10],
    ["Washout bag", "each", null, 200],
    ["Offsite washout", "each", null, 250],
    ["Extra labourer / hose hand (6 hr min)", "hr", null, 100, null, null, 6],
    ["Saturday work (6 hr min, at the pump's hourly rate)", "hr", null, 220, null, null, 6],
    ["Cancellation (5 hr min, at the pump's hourly rate)", "hr", null, 220, null, null, 5],
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
  // Specified insulation products (under-slab, slab edge, thermal break) —
  // the estimator picks the actual material/thickness/R-value, not a generic
  // "Insulation" line. Prices are catalog seeds, editable in the Rates modal
  // like everything else. The old generic "Insulation" row stays in OTHER
  // ACCESSORIES below because its rateKey may already carry quantities in
  // saved quotes — removing/renaming it would silently drop those from totals.
  /* Insulation is bought by BOARD, and a board's price is set by its material,
   * its compressive strength grade and its thickness together — so every
   * thickness is its own priced product rather than one product with a typed
   * thickness, which could only ever be priced wrong. The Estimates app picks
   * a material and a thickness and emits these names VERBATIM (see
   * INSULATION_FAMILIES there), so an import lands the area straight on the
   * right board; if you rename a product here, rename it there too.
   *
   * The rigid-foam grades are quoted by compressive strength because that is
   * what an under-slab board is specified on — 50 kPa for a domestic slab on
   * good ground, up to 300 kPa under heavily loaded industrial slabs. */
  { key: "INSULATION", weightBasis: false, products: [
    // Rigid foam under-slab, by compressive strength grade then thickness
    ["Rigid foam under-slab 50 kPa — 25mm", "m2", null, 9],
    ["Rigid foam under-slab 50 kPa — 50mm", "m2", null, 15],
    ["Rigid foam under-slab 50 kPa — 75mm", "m2", null, 21],
    ["Rigid foam under-slab 50 kPa — 100mm", "m2", null, 27],
    ["Rigid foam under-slab 100 kPa — 50mm", "m2", null, 19],
    ["Rigid foam under-slab 100 kPa — 75mm", "m2", null, 27],
    ["Rigid foam under-slab 100 kPa — 100mm", "m2", null, 34],
    ["Rigid foam under-slab 200 kPa — 50mm", "m2", null, 28],
    ["Rigid foam under-slab 200 kPa — 75mm", "m2", null, 40],
    ["Rigid foam under-slab 200 kPa — 100mm", "m2", null, 51],
    ["Rigid foam under-slab 300 kPa — 50mm", "m2", null, 36],
    ["Rigid foam under-slab 300 kPa — 75mm", "m2", null, 52],
    ["Rigid foam under-slab 300 kPa — 100mm", "m2", null, 67],
    ["Kooltherm K3 Floorboard 50mm (R2.25)", "m2", null, 42],
    ["Kooltherm K3 Floorboard 60mm (R2.70)", "m2", null, 50],
    ["Kooltherm K3 Floorboard 80mm (R3.60)", "m2", null, 66],
    ["Kooltherm K3 Floorboard 100mm (R4.50)", "m2", null, 82],
    ["XPS rigid board 30mm (R0.88)", "m2", null, 18],
    ["XPS rigid board 50mm (R1.47)", "m2", null, 26],
    ["XPS rigid board 75mm (R2.20)", "m2", null, 36],
    ["XPS rigid board 100mm (R2.94)", "m2", null, 46],
    ["EPS board M-grade 50mm (R1.19)", "m2", null, 12],
    ["EPS board M-grade 75mm (R1.79)", "m2", null, 16],
    ["EPS board M-grade 100mm (R2.38)", "m2", null, 20],
    ["Foilboard rigid panel 25mm", "m2", null, 15],
    ["Foilboard rigid panel 30mm", "m2", null, 17],
    ["Foilboard rigid panel 50mm", "m2", null, 26],
    ["Slab edge insulation — 30mm XPS 300mm strip", "m", null, 9],
    ["Slab edge insulation — 50mm XPS 300mm strip", "m", null, 13],
    ["Thermal break strip 10mm", "m", null, 6],
    ["Thermal break strip 20mm", "m", null, 9],
    ["Insulation (other — specify in description)", "m2", null, 25],
  ]},
  /* Preliminaries — the site-wide items a job needs before and around the
   * concrete work: traffic management, temporary access and protection,
   * site establishment, services and amenities, supervision, survey,
   * environmental controls, permits and clean-up. Like the specialist band,
   * this one carries visibleFor and is rendered and costed ONLY on the
   * PRELIMINARIES elements in the Add-Element dropdown (rule 1 exception);
   * it would be noise on a footing card. Every product costs plain
   * qty × rate; defaults are placeholders to be set in the Rates modal, and
   * "+ Add item under PRELIMINARIES" takes anything not listed. The Cost
   * Planner keeps its own Preliminaries list; a published Quotes line that
   * has no name match there lands as a custom BOQ row, so nothing is lost. */
  { key: "PRELIMINARIES", weightBasis: false, visibleFor: ["PRELIMINARIES"], products: [
    // Traffic management
    ["Traffic management plan (TMP) & permits — prepare / lodge", "each", null, 1800],
    ["Traffic controller (accredited)", "hr", null, 68],
    ["Traffic control crew (2 controllers + ute + signs)", "day", null, 1500],
    ["Traffic signage & barrier set (hire)", "day", null, 180],
    ["Variable message sign (VMS) board hire", "week", null, 550],
    ["Water-filled / concrete road barriers (hire)", "m/week", null, 9],
    ["Pedestrian detour / walkway & fencing", "m", null, 45],
    ["Road / lane / footpath occupation fee (council)", "day", null, 350],
    // Temporary access
    ["Temporary vehicle crossover / access ramp", "each", null, 2200],
    ["Road plates / trench covers (hire)", "each/week", null, 220],
    ["Temporary haul road / hardstand (crushed rock)", "m2", null, 38],
    ["Temporary access stairs / walkways / gantry", "each", null, 1500],
    ["Ground protection mats (hire)", "each/week", null, 45],
    ["Tree / asset protection", "each", null, 350],
    // Site establishment
    ["Site establishment & set-up", "each", null, 3500],
    ["Demobilisation & make good", "each", null, 2000],
    ["Temporary fencing (hire)", "m/week", null, 2.5],
    ["Hoarding / solid site fence", "m", null, 95],
    ["Site gates (vehicle / pedestrian)", "each", null, 650],
    ["Site shed / office hire", "week", null, 150],
    ["Toilet / amenities hire", "week", null, 120],
    ["Lunchroom / first-aid room hire", "week", null, 140],
    ["Site signage & project board", "each", null, 400],
    // Temporary services
    ["Temporary power connection", "each", null, 1200],
    ["Generator hire (incl. fuel)", "week", null, 650],
    ["Temporary water connection / water cart", "each", null, 800],
    ["Site lighting / towers (hire)", "week", null, 380],
    // Temporary works, protection & cranage
    ["Scaffold / edge protection (hire)", "m/week", null, 12],
    ["Temporary propping / shoring (hire)", "week", null, 900],
    ["Crane hire (incl. operator)", "day", null, 2800],
    ["Franna / pick-and-carry crane", "hr", null, 220],
    ["Forklift / telehandler hire", "day", null, 550],
    // Site management & compliance
    ["Site supervision / foreman", "week", null, 1800],
    ["Project / contract management", "week", null, 1200],
    ["Survey & set-out (visit)", "each", null, 1500],
    ["Site inductions / WHS management", "week", null, 300],
    ["Environmental controls (sediment fence, wheel wash, dust)", "m", null, 18],
    ["Dust / noise / vibration monitoring", "week", null, 450],
    ["Permits, fees & council requirements", "each", null, 900],
    ["Insurances (public liability & contract works)", "each", null, 2500],
    ["Site cleaning & rubbish removal", "week", null, 250],
    ["Skip bin / waste disposal", "each", null, 600],
    ["As-built documentation / handover", "each", null, 800],
    ["Preliminaries — subcontract quote (specify)", "quote", null, 0],
    ["Preliminaries — other (specify)", "each", null, 0],
  ]},
  /* Screeds — every common Australian floor screed, supply-and-lay $/m² at
   * the stated thickness (placeholder defaults: edit in the Rates modal or
   * type a received quote straight onto the "subcontract quote" row). Costed
   * plain qty × rate like formwork. "+ Add item under SCREEDS" on any element
   * card takes any type not listed here. */
  { key: "SCREEDS", weightBasis: false, products: [
    ["Sand/cement screed bonded — 20–30mm", "m2", null, 42],
    ["Sand/cement screed bonded — 30–40mm", "m2", null, 48],
    ["Sand/cement screed unbonded — 50mm", "m2", null, 58],
    ["Sand/cement screed unbonded — 65mm", "m2", null, 66],
    ["Sand/cement screed unbonded — 75mm", "m2", null, 74],
    ["Floating screed over insulation — 65mm", "m2", null, 78],
    ["Floating screed over insulation — 75mm", "m2", null, 86],
    ["Screed to falls — wet areas / balconies", "m2", null, 72],
    ["Screed to falls — roof / podium (lightweight)", "m2", null, 92],
    ["Heated screed over hydronic pipes — 65mm", "m2", null, 82],
    ["Heated screed over hydronic pipes — 75mm", "m2", null, 90],
    ["Fibre-reinforced screed — 50mm", "m2", null, 62],
    ["Polymer-modified screed — 25mm", "m2", null, 70],
    ["Pumped liquid cement screed (flowing) — 50mm", "m2", null, 64],
    ["Anhydrite / calcium sulphate flowing screed — 40mm", "m2", null, 58],
    ["Rapid-drying / fast-set screed — 40mm", "m2", null, 76],
    ["Lightweight foamed / bead screed — 50mm", "m2", null, 60],
    ["Acoustic screed over resilient mat — 50mm", "m2", null, 98],
    ["Granolithic / hard-wearing topping — 25mm", "m2", null, 95],
    ["Epoxy / resin screed — 6mm", "m2", null, 125],
    ["Self-levelling compound — 3–5mm", "m2", null, 32],
    ["Self-levelling compound — 5–10mm", "m2", null, 44],
    ["Screed reinforcement mesh (galv. 50x50)", "m2", null, 9],
    ["Screed rails / levelling battens", "m", null, 8],
    ["Bonding agent / SBR slurry coat", "m2", null, 6],
    ["Polypropylene fibres", "kg", null, 14],
    ["Screed movement joint", "m", null, 18],
    ["Screed curing / sealing compound", "m2", null, 4],
    ["Screed pump hire", "day", null, 650],
    ["Screed (subcontract quote)", "quote", null, 0],
    ["Screed (other — specify in description)", "m2", null, 60],
  ]},
  /* Hydronic (in-slab / in-screed) heating — pipe loops per m² of heated
   * floor plus the parts that are counted, and quote rows for the heat
   * source and a full subcontract. Placeholder defaults, editable in the
   * Rates modal. */
  { key: "HYDRONIC HEATING", weightBasis: false, products: [
    ["Hydronic in-slab heating — pipe loops supply & lay (incl. clips)", "m2", null, 58],
    ["Hydronic in-screed heating — pipe loops supply & lay", "m2", null, 68],
    ["Hydronic heating on castellated insulation panel system", "m2", null, 85],
    ["PEX-a pipe 16mm", "m", null, 6],
    ["PEX-a pipe 20mm", "m", null, 8],
    ["PE-RT / multilayer pipe 16mm", "m", null, 7],
    ["Pipe clip rail / staple track", "m2", null, 4],
    ["Pipe conduit sleeves at joints / penetrations", "m", null, 5],
    ["Perimeter edge insulation strip", "m", null, 3],
    ["Manifold — per port (incl. flow meters)", "each", null, 180],
    ["Manifold cabinet (recessed / surface)", "each", null, 450],
    ["Zone actuator", "each", null, 95],
    ["Room thermostat / zone controller", "each", null, 220],
    ["Pressure test & commissioning", "each", null, 350],
    ["Heat source connection — boiler / heat pump (by others, quote)", "quote", null, 0],
    ["Hydronic heating (subcontract quote)", "quote", null, 0],
    ["Hydronic heating (other — specify in description)", "m2", null, 60],
  ]},
  { key: "OTHER ACCESSORIES", weightBasis: false, products: [
    // Vapour barrier is its own product, DISTINCT from Insulation — a 200µm
    // poly membrane per m² laid, not an insulation board/strip.
    ["Packing sand", "m3", null, 50], ["Crushed Rock", "m3", null, 63], ["Insulation", "m2", null, 25], ["Vapour barrier", "m2", null, 3], ["Epoxy", "unit", null, 70],
    ["Marking Paint", "unit", null, 4], ["Sealers/Acid/MBT", "each", null, 400], ["Curing Products", "price", null, 100],
  ]},
  { key: "OTHER ALLOWANCES", weightBasis: false, products: [
    ["Inspector", "each", null, 130], ["Soil removal", "m3", null, 40], ["Bin Hire", "each", null, 600], ["Sawcutting", "day", null, 450],
    ["Concrete test", "each", null, 241.5], ["Off-site washout fee", "each", null, 400], ["Truck washout fee", "each", null, 10.5],
  ]},
  { key: "SUB CONTRACTORS / TEMPORARY WORKS", weightBasis: false, products: [
    ["Excavation (subcontract)", "quote", null, null], ["Formwork (subcontract)", "quote", null, null], ["Steel supply", "quote", null, null], ["Steel fix", "quote", null, null],
    ["Screw Piling", "quote", null, null], ["CFA Piling", "quote", null, null],
    // Bored piers: the DRILLING is a subcontract quote item — the pier's own
    // concrete and reinforcement stay priced from their normal categories.
    ["Bored Piers (subcontract)", "quote", null, null],
    ["Temporary steel props/struts (150UC23.4) — supply/hire", "tonne", null, 3200],
  ]},
].map((c) => ({
  ...c,
  label: c.label || c.key,
  products: c.products.map(([name, unit, unitWeight, unitCost, sheetArea, barLength, minQty]) => ({ name, unit, unitWeight, unitCost, sheetArea, barLength, minQty })),
}));

/* ---------- Element types ----------
 * Every concrete/structural element Gradcon might reasonably meet across
 * ANY building or civil project — not curated per job. `category` is the
 * broad, foldable grouping (Foundations, Suspended Structure, ...) shown
 * on the Add-Element dropdown; `section` is the finer sub-group used by
 * the Quote Summary rail. Keep the array in roughly ground-up construction
 * order (earthworks → foundations → retention → substructure → vertical
 * structure → suspended structure → external/landscape → pool → civil)
 * since that's meaningful to an estimator scanning the list, not
 * arbitrary. See CLAUDE.md → "How to extend" before adding to this list.
 */
export const ELEMENT_TYPES = [
  // Preliminaries — site-wide items before and around the concrete work.
  // They come first (nothing is poured before the site is set up), carry the
  // PRELIMINARIES band only (visibleFor) and their own crew-sheet tasks.
  { id: "prelim_traffic_management", category: "PRELIMINARIES", section: "TRAFFIC & ACCESS", name: "Traffic Management (TMP, controllers, signage, barriers)", labour: "prelims" },
  { id: "prelim_pedestrian_management", category: "PRELIMINARIES", section: "TRAFFIC & ACCESS", name: "Pedestrian Management & Protection", labour: "prelims" },
  { id: "prelim_temporary_access", category: "PRELIMINARIES", section: "TRAFFIC & ACCESS", name: "Temporary Access (crossovers, ramps, road plates, haul roads)", labour: "prelims" },
  { id: "prelim_temporary_works", category: "PRELIMINARIES", section: "TRAFFIC & ACCESS", name: "Temporary Works (propping, shoring, scaffold, edge protection)", labour: "prelims" },
  { id: "prelim_cranage", category: "PRELIMINARIES", section: "TRAFFIC & ACCESS", name: "Cranage & Hoisting", labour: "prelims" },
  { id: "prelim_site_establishment", category: "PRELIMINARIES", section: "SITE ESTABLISHMENT", name: "Site Establishment & Set-Up", labour: "prelims" },
  { id: "prelim_fencing_hoarding", category: "PRELIMINARIES", section: "SITE ESTABLISHMENT", name: "Site Fencing, Hoarding & Gates", labour: "prelims" },
  { id: "prelim_amenities", category: "PRELIMINARIES", section: "SITE ESTABLISHMENT", name: "Site Sheds & Amenities", labour: "prelims" },
  { id: "prelim_temporary_services", category: "PRELIMINARIES", section: "SITE ESTABLISHMENT", name: "Temporary Services (power, water, lighting)", labour: "prelims" },
  { id: "prelim_demobilisation", category: "PRELIMINARIES", section: "SITE ESTABLISHMENT", name: "Demobilisation & Make Good", labour: "prelims" },
  { id: "prelim_supervision", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Supervision & Site Management", labour: "prelims" },
  { id: "prelim_survey_setout", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Survey & Set-Out", labour: "prelims" },
  { id: "prelim_environmental", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Environmental Controls (sediment, dust, noise)", labour: "prelims" },
  { id: "prelim_permits", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Permits, Fees & Council Requirements", labour: "prelims" },
  { id: "prelim_whs", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "WHS, Safety & Inductions", labour: "prelims" },
  { id: "prelim_cleaning_waste", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Site Cleaning & Waste Removal", labour: "prelims" },
  { id: "prelim_other", category: "PRELIMINARIES", section: "SITE MANAGEMENT & COMPLIANCE", name: "Preliminaries (Other - specify)", labour: "prelims" },

  // Earthworks — standalone excavation/backfill, not bundled into a pour's labour tasks.
  { id: "excavation_bulk", category: "EARTHWORKS", section: "EXCAVATION", name: "Bulk Excavation", labour: "excavation" },
  { id: "excavation_trench", category: "EARTHWORKS", section: "EXCAVATION", name: "Trench Excavation", labour: "excavation" },
  { id: "excavation_rock", category: "EARTHWORKS", section: "EXCAVATION", name: "Rock Excavation / Breaking", labour: "excavation" },
  { id: "backfill_compaction", category: "EARTHWORKS", section: "EXCAVATION", name: "Backfill & Compaction", labour: "excavation" },

  // Foundations — piers/piles and footings that carry the structure to ground.
  { id: "piles_bored", category: "FOUNDATIONS", section: "PILING & PIERS", name: "Piles - Bored Piers", labour: "footing" },
  { id: "piles_driven", category: "FOUNDATIONS", section: "PILING & PIERS", name: "Driven Piles", labour: "footing" },
  { id: "piles_cfa", category: "FOUNDATIONS", section: "PILING & PIERS", name: "CFA Piles", labour: "footing" },
  { id: "screw_piles", category: "FOUNDATIONS", section: "PILING & PIERS", name: "Screw Piles", labour: "footing" },
  { id: "pile_caps_pad", category: "FOUNDATIONS", section: "FOOTINGS", name: "Pile Caps - Pad Footings", labour: "footing" },
  { id: "stump_footings", category: "FOUNDATIONS", section: "FOOTINGS", name: "Stump Footings", labour: "footing" },
  { id: "strip_footings", category: "FOUNDATIONS", section: "FOOTINGS", name: "Strip Footings", labour: "footing" },
  { id: "raft_foundation", category: "FOUNDATIONS", section: "FOOTINGS", name: "Raft / Mat Foundation", labour: "slab_ground" },
  { id: "capping_beam", category: "FOUNDATIONS", section: "FOOTINGS", name: "Capping Beam", labour: "footing" },
  { id: "edge_beam", category: "FOUNDATIONS", section: "FOOTINGS", name: "Edge Beam", labour: "footing" },
  { id: "internal_beam", category: "FOUNDATIONS", section: "FOOTINGS", name: "Internal Beam", labour: "footing" },
  { id: "column_base_plate", category: "FOUNDATIONS", section: "FOOTINGS", name: "Column Base Plate / Grout Pad", labour: "footing" },

  // Retention & temporary works — holds ground/excavations back during and after construction.
  { id: "anchor_block_strut", category: "RETENTION & TEMPORARY WORKS", section: "TEMPORARY PROPPING", name: "Anchor Block & Strut", labour: "footing" },
  { id: "shotcrete_wall", category: "RETENTION & TEMPORARY WORKS", section: "RETENTION SYSTEMS", name: "Shotcrete Retention Wall", labour: "wall" },
  { id: "secant_pile_wall", category: "RETENTION & TEMPORARY WORKS", section: "RETENTION SYSTEMS", name: "Secant / Contiguous Pile Wall", labour: "wall" },
  { id: "soldier_pile_wall", category: "RETENTION & TEMPORARY WORKS", section: "RETENTION SYSTEMS", name: "Soldier Pile Wall", labour: "wall" },
  { id: "retaining_wall", category: "RETENTION & TEMPORARY WORKS", section: "RETENTION SYSTEMS", name: "Basement - Retaining Wall", labour: "wall" },

  // Substructure — ground-bearing slabs below or at the lowest level.
  { id: "slab_on_ground", category: "SUBSTRUCTURE", section: "GROUND-BEARING SLABS", name: "Slab on Ground (Garage / Tennis Court / Plant Room / Hardstand)", labour: "slab_ground" },
  { id: "basement_slab", category: "SUBSTRUCTURE", section: "GROUND-BEARING SLABS", name: "Basement Slab", labour: "slab_ground" },
  { id: "ramp", category: "SUBSTRUCTURE", section: "GROUND-BEARING SLABS", name: "Ramp", labour: "slab_ground" },

  // Vertical structure — columns and load-bearing/core walls carrying floors above.
  { id: "rc_columns", category: "VERTICAL STRUCTURE", section: "COLUMNS", name: "RC Columns - Fence Post Columns", labour: "footing" },
  { id: "core_shear_wall", category: "VERTICAL STRUCTURE", section: "WALLS", name: "Core / Shear Wall", labour: "wall" },
  { id: "loadbearing_wall", category: "VERTICAL STRUCTURE", section: "WALLS", name: "Load-Bearing Wall", labour: "wall" },

  // Suspended structure — elevated slabs/beams, deliberately separate from Foundations.
  { id: "suspended_beam", category: "SUSPENDED STRUCTURE", section: "SUSPENDED BEAMS", name: "Suspended Beam", labour: "slab_suspended" },
  { id: "suspended_slab", category: "SUSPENDED STRUCTURE", section: "SUSPENDED SLABS", name: "Suspended Slab", labour: "slab_suspended" },
  { id: "transfer_slab_beam", category: "SUSPENDED STRUCTURE", section: "SUSPENDED SLABS", name: "Transfer Slab / Beam", labour: "slab_suspended" },
  { id: "post_tensioned_slab", category: "SUSPENDED STRUCTURE", section: "SUSPENDED SLABS", name: "Post-Tensioned Slab", labour: "slab_suspended" },
  // Its own labour template (stepped riser/tread formwork, not a flat soffit — see
  // LABOUR_TEMPLATES.stairs) and its own section, since a staircase isn't really a
  // suspended slab even though it's typically propped/formed the same way.
  { id: "staircase", category: "SUSPENDED STRUCTURE", section: "STAIRS", name: "Staircase", labour: "stairs" },

  // Screeds, toppings and hydronic heating — finishes and services laid ON a
  // slab (ground or suspended), each its OWN category (like Foundations) so
  // they are selected and summarised in their own right rather than buried
  // under a Suspended Slab. One element per distinct work type; thickness, grade and extras are
  // chosen on the card from the SCREEDS / HYDRONIC HEATING / CONCRETE / RATE
  // ITEMS bands (rule 1: every band is on every card).
  { id: "screed_bonded", category: "SCREEDS", section: "SCREEDS", name: "Sand/Cement Screed (Bonded)", labour: "screed" },
  { id: "screed_unbonded", category: "SCREEDS", section: "SCREEDS", name: "Sand/Cement Screed (Unbonded)", labour: "screed" },
  { id: "screed_floating", category: "SCREEDS", section: "SCREEDS", name: "Floating Screed (over insulation / acoustic mat)", labour: "screed" },
  { id: "screed_falls_wet", category: "SCREEDS", section: "SCREEDS", name: "Screed to Falls (Wet Areas / Balconies)", labour: "screed" },
  { id: "screed_falls_roof", category: "SCREEDS", section: "SCREEDS", name: "Roof / Podium Screed to Falls", labour: "screed" },
  { id: "screed_heated", category: "SCREEDS", section: "SCREEDS", name: "Heated Screed (over hydronic pipes)", labour: "screed" },
  { id: "screed_flowing", category: "SCREEDS", section: "SCREEDS", name: "Pumped Liquid / Flowing Screed", labour: "screed" },
  { id: "screed_anhydrite", category: "SCREEDS", section: "SCREEDS", name: "Anhydrite / Calcium Sulphate Screed", labour: "screed" },
  { id: "screed_lightweight", category: "SCREEDS", section: "SCREEDS", name: "Lightweight Screed (foamed / bead)", labour: "screed" },
  { id: "screed_fibre_polymer", category: "SCREEDS", section: "SCREEDS", name: "Fibre-Reinforced / Polymer-Modified Screed", labour: "screed" },
  { id: "screed_rapid", category: "SCREEDS", section: "SCREEDS", name: "Rapid-Drying / Fast-Set Screed", labour: "screed" },
  { id: "screed_acoustic", category: "SCREEDS", section: "SCREEDS", name: "Acoustic Screed", labour: "screed" },
  { id: "self_levelling", category: "SCREEDS", section: "SCREEDS", name: "Self-Levelling Compound", labour: "screed" },
  { id: "screed_other", category: "SCREEDS", section: "SCREEDS", name: "Screed (Other - specify)", labour: "screed" },
  { id: "topping_structural", category: "TOPPINGS", section: "TOPPINGS", name: "Structural Concrete Topping (precast / hollowcore)", labour: "topping" },
  { id: "topping_metal_deck", category: "TOPPINGS", section: "TOPPINGS", name: "Concrete Topping on Bondek / Metal Deck", labour: "topping" },
  { id: "topping_granolithic", category: "TOPPINGS", section: "TOPPINGS", name: "Granolithic / Hard-Wearing Topping", labour: "topping" },
  { id: "topping_epoxy", category: "TOPPINGS", section: "TOPPINGS", name: "Epoxy / Resin Topping", labour: "topping" },
  { id: "topping_decorative", category: "TOPPINGS", section: "TOPPINGS", name: "Decorative / Polished / Burnished Topping", labour: "topping" },
  { id: "topping_overlay", category: "TOPPINGS", section: "TOPPINGS", name: "Bonded Overlay / Resurfacing", labour: "topping" },
  { id: "topping_other", category: "TOPPINGS", section: "TOPPINGS", name: "Topping (Other - specify)", labour: "topping" },
  { id: "hydronic_in_slab", category: "HYDRONIC HEATING", section: "HYDRONIC HEATING", name: "Hydronic Heating - In-Slab", labour: "hydronic" },
  { id: "hydronic_in_screed", category: "HYDRONIC HEATING", section: "HYDRONIC HEATING", name: "Hydronic Heating - In-Screed", labour: "hydronic" },
  { id: "hydronic_panel", category: "HYDRONIC HEATING", section: "HYDRONIC HEATING", name: "Hydronic Heating - Castellated Panel System", labour: "hydronic" },

  // Specialist finishing concrete — decorative / exposed / polished work as
  // its own selectable element, like the screeds. Only these elements carry
  // the SPECIALIST FINISHING CONCRETE band (VicMix mixes and finishes).
  { id: "finish_exposed_washoff", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Exposed Aggregate - Wash-Off Finish (VicMix mix)", labour: "finishing" },
  { id: "finish_exposed_honed", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Honed / Ground Exposed Aggregate", labour: "finishing" },
  { id: "finish_polished", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Polished Concrete", labour: "finishing" },
  { id: "finish_burnished", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Burnished / Power-Trowel Finish", labour: "finishing" },
  { id: "finish_coloured", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Coloured (Oxide) Concrete", labour: "finishing" },
  { id: "finish_stamped", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Stamped / Stencilled Concrete", labour: "finishing" },
  { id: "finish_nonslip", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Broom / Salt / Non-Slip Finish", labour: "finishing" },
  { id: "finish_etched", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Acid-Wash / Sandblasted Finish", labour: "finishing" },
  { id: "finish_sealed", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Decorative Overlay / Sealed Finish", labour: "finishing" },
  { id: "finish_other", category: "SPECIALIST FINISHING CONCRETE", section: "SPECIALIST FINISHING CONCRETE", name: "Specialist Finish (Other - specify)", labour: "finishing" },

  // External & landscape concrete — outside the building envelope.
  { id: "planter_wall", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "BOUNDARY & LANDSCAPE WALLS", name: "Planter Wall", labour: "wall" },
  { id: "boundary_wall", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "BOUNDARY & LANDSCAPE WALLS", name: "Boundary Wall", labour: "wall" },
  { id: "retaining_wall_landscape", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "BOUNDARY & LANDSCAPE WALLS", name: "Retaining Wall (Landscape)", labour: "wall" },
  { id: "driveway_hardstand", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "PAVING & HARDSTAND", name: "Driveway / External Hardstand", labour: "slab_ground" },
  { id: "paths_paving", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "PAVING & HARDSTAND", name: "Paths & Paving", labour: "slab_ground" },
  { id: "kerbs_channels", category: "EXTERNAL & LANDSCAPE CONCRETE", section: "PAVING & HARDSTAND", name: "Kerbs & Channels", labour: "footing" },

  // Pool construction.
  { id: "pool_wall", category: "POOL CONSTRUCTION", section: "POOL CONSTRUCTION", name: "Pool Wall", labour: "wall" },
  { id: "pool_slab", category: "POOL CONSTRUCTION", section: "POOL CONSTRUCTION", name: "Pool Slab", labour: "slab_ground" },
  { id: "spa_water_feature", category: "POOL CONSTRUCTION", section: "POOL CONSTRUCTION", name: "Spa / Water Feature", labour: "wall" },

  // Civil & infrastructure concrete structures.
  { id: "culvert", category: "CIVIL & INFRASTRUCTURE", section: "CIVIL STRUCTURES", name: "Culvert", labour: "footing" },
  { id: "headwall", category: "CIVIL & INFRASTRUCTURE", section: "CIVIL STRUCTURES", name: "Headwall", labour: "wall" },
  { id: "manhole_pit", category: "CIVIL & INFRASTRUCTURE", section: "CIVIL STRUCTURES", name: "Manhole / Pit (in-situ)", labour: "footing" },
  { id: "bridge_abutment", category: "CIVIL & INFRASTRUCTURE", section: "CIVIL STRUCTURES", name: "Bridge Abutment", labour: "wall" },
];

export const CATEGORY_ORDER = [...new Set(ELEMENT_TYPES.map((t) => t.category))];
export const SECTION_ORDER = [...new Set(ELEMENT_TYPES.map((t) => t.section))];

/* ---------- Quote pipeline status ----------
 * A project's own stage through Gradcon's estimating/quoting pipeline —
 * distinct from Cost Planner's post-award project/tender status (Active/On
 * Hold/Complete, Tendering/Submitted/Won/Lost in cost-planner.html), which
 * tracks a job already won. This tracks getting there. Order below is the
 * pipeline order, used both for the Dashboard's status dropdown and for
 * "sort by status". `quote.status` defaults to QUOTE_STATUSES[0] for any
 * quote that predates this field (see Dashboard.jsx) — never rendered as
 * blank/unknown.
 */
export const QUOTE_STATUSES = ["Queued", "Estimating", "Completed Estimating", "Quoting", "Submitted", "Tendered", "Successful", "Unsuccessful", "On Hold"];
export const QUOTE_STATUS_STYLES = {
  Queued: { bar: "bg-violet-400", dot: "bg-violet-400", text: "text-violet-600", bg: "bg-violet-50" },
  Estimating: { bar: "bg-red-500", dot: "bg-red-500", text: "text-red-600", bg: "bg-red-50" },
  // Estimate finished, quote not yet drafted — sits between Estimating (red) and Quoting (blue).
  "Completed Estimating": { bar: "bg-teal-500", dot: "bg-teal-500", text: "text-teal-700", bg: "bg-teal-50" },
  Quoting: { bar: "bg-blue-500", dot: "bg-blue-500", text: "text-blue-700", bg: "bg-blue-50" },
  // Quote finished and sent to the client — sits between Quoting (blue) and Tendered (amber).
  Submitted: { bar: "bg-sky-400", dot: "bg-sky-400", text: "text-sky-700", bg: "bg-sky-50" },
  Tendered: { bar: "bg-amber-500", dot: "bg-amber-500", text: "text-amber-700", bg: "bg-amber-50" },
  Successful: { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
  // Distinct from Estimating's red (now that it's taken) rather than a near-duplicate shade.
  Unsuccessful: { bar: "bg-stone-500", dot: "bg-stone-500", text: "text-stone-600", bg: "bg-stone-100" },
  "On Hold": { bar: "bg-neutral-300", dot: "bg-neutral-300", text: "text-neutral-500", bg: "bg-neutral-100" },
};

/* ---------- Planner priority (Planner tab — see components/PlannerView.jsx) ---------- */
export const PLANNER_PRIORITIES = ["Urgent", "High", "Medium", "Low"];
export const PLANNER_PRIORITY_STYLES = {
  Urgent: { text: "text-red-600", bg: "bg-red-50", dot: "bg-red-500" },
  High: { text: "text-orange-600", bg: "bg-orange-50", dot: "bg-orange-500" },
  Medium: { text: "text-amber-600", bg: "bg-amber-50", dot: "bg-amber-400" },
  Low: { text: "text-neutral-500", bg: "bg-neutral-100", dot: "bg-neutral-300" },
};

/* ---------- Overhead/contingency/margin ladder ----------
 * Applied in sequence: Direct Cost -> (+Overheads% +Contingency%) ->
 * Subtotal -> /(1-margin) -> Sell ex GST -> *1.1 -> Sell inc GST.
 * Percentages are always stored as fractions (0.08, not 8) — see
 * CLAUDE.md "the 15-vs-0.15 gotcha" before touching this.
 */
export const MARGIN_STEPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
/* Gradcon's agreed house margin. This is the rung the Quote Summary
 * highlights, the one the Dashboard's "Total sell" column and $/m² are struck
 * at, and the one the External and Tender quotes allocate their line prices
 * from — so changing it moves every headline sell figure in the app.
 * Margin is on the SELL price, not a markup on cost: 25% margin is cost
 * ÷ 0.75, which is a 33.33% markup (see computeMarginLadder). A saved
 * Settings value ("Default margin %") overrides this per install — see
 * getDefaultMargin() — so an install that has one keeps it until it is
 * changed there too. */
export const DEFAULT_MARGIN = 0.25;
export const GST_RATE = 0.10; // Australian GST — change here if this is ever used outside AU
