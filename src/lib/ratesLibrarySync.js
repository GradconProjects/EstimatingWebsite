/**
 * Rates Library → Quotes price sync.
 *
 * The Rates Library (portal/rates-library.html) is Gradcon's authoritative
 * price list. Cost Planner already reads it live and Estimates reads its
 * global block, but Quotes historically kept its own independent copy seeded
 * from data/catalog.js — so editing a price in the library changed nothing on
 * an element card, which is exactly the disagreement that had conventional
 * formwork at $60 in one place and $150 in the other.
 *
 * This closes that gap WITHOUT throwing away deliberate Quotes edits:
 *
 *   - a Quotes rate still equal to its catalog default is unowned → the
 *     library's price is taken;
 *   - a Quotes rate equal to the value this sync last wrote is still owned by
 *     the library → a later library edit flows through too;
 *   - anything else was typed by an estimator in the Rates modal → left
 *     alone. The modal's drift banner shows it and offers a one-click restore.
 *
 * The last-written values live under LIB_SYNC_KEY so the second rule survives
 * a reload. Matching is by product NAME and only where exactly one catalog
 * product carries it — the library's stored shape is {name: {cost}} with no
 * unit, so an ambiguous name is skipped rather than guessed at.
 */
import { FULL_CATALOG, RESOURCE_COLS } from "../data/catalog.js";
import { rateKey } from "./costing.js";

export const RATES_LIBRARY_KEY = "gradcon-rates-library";
export const LIB_SYNC_KEY = "gradcon-rates-libsync";

/* The library sections that hold a plain per-product price. Its other
 * sections (steel build-ups, production hours, PT factors) are inputs to its
 * own calculators, not prices Quotes has a matching product for. */
const PRICED_SECTIONS = ["concreteGrade", "specialistConcrete", "finishRates", "formworkLegacy", "reinfAcc", "otherAcc", "otherAllow", "prelim"];

/* Gradcon's ESTABLISHED reinforcement rates live under the library's
 * `reinforcementEstablished` block as {product name: $ per unit} — trench
 * mesh per length, square mesh per sheet, stock bar per 6 m length, exactly
 * the units the Quotes catalog prices in. Processed bar is the one exception:
 * the library stores $ per METRE of each size (its per-tonne input converts
 * through the bar's kg/m) while Quotes prices PROCESSED BAR per TONNE
 * (`weightBasis`), so that section converts back through the catalog's
 * unitWeight. 21 Oct 2026, Grady: "entries made in rates library should
 * automatically update where applicable" — until then none of the four
 * reinforcement tables, the labour / plant day rates or the preliminaries
 * reached a quote. */
const REO_SECTIONS = [
  { path: ["reinforcementEstablished", "trenchMesh"], section: "trenchMesh" },
  { path: ["reinforcementEstablished", "squareMesh"], section: "squareMesh" },
  { path: ["reinforcementEstablished", "stockBar"], section: "stockBar" },
  { path: ["reinforcementEstablished", "processedBar"], section: "processedBar", perTonne: true },
];

/* The library's "Labour & Plant" table is stored by ROW INDEX
 * (`labourPlant[idx] = {cost}`), so this mirror of its rows — name, unit and
 * the Quotes crew-sheet resource (RESOURCE_COLS name + unit) or "catalog" for
 * a product row priced by name — is what joins the two. `verify.mjs` fails
 * when it drifts from LABOUR_PLANT_ITEMS in portal/rates-library.html; a row
 * with no target is a library-only figure. Append, never reorder. */
export const LIBRARY_LABOUR_PLANT = [
  ["Steel fix", "tonne", null],
  ["Factory labour", "hr", null],
  ["Concreter", "day", ["Concrete Crew", "man-day"]],
  ["Excavator", "day", ["Excavator", "day"]],
  ["Bobcat", "day", ["Bobcat", "day"]],
  ["Pump", "hr", ["Pump", "hr"]],
  ["Pump", "m3", ["Pump", "m³"]],
  ["Steel fixer", "day", ["Steel Crew", "man-day"]],
  ["Crane", "day", ["Crane", "day"]],
  ["Temporary steel props/struts (150UC23.4) — supply/hire", "tonne", "catalog"],
  ["Formworker", "day", ["Formwork Crew", "man-day"]],
  ["General labourer", "day", ["General Labour Crew", "man-day"]],
  ["Truck", "day", ["Trucks", "day"]],
];

const norm = (s) => String(s == null ? "" : s).toLowerCase().trim().replace(/\s+/g, " ");

/** name → the single catalog product with it, or undefined when 0 or 2+ match. */
function catalogByName() {
  const seen = new Map();
  FULL_CATALOG.forEach((cat) => cat.products.forEach((p) => {
    const n = norm(p.name);
    if (seen.has(n)) seen.set(n, null);            // ambiguous — never auto-map
    else seen.set(n, { key: rateKey(cat.key, p.name, p.unit), unitCost: p.unitCost, unitWeight: p.unitWeight });
  }));
  const out = new Map();
  seen.forEach((v, k) => { if (v) out.set(k, v); });
  return out;
}

/* Prices the library keeps in its GLOBAL block rather than as a product row,
 * mapped onto the catalog product they price. Holcim's Production & Transport
 * Surcharge is the one that matters: the library has always held it as
 * `global.concreteSurchargePerM3` (Cost Planner and Estimates read it there),
 * but Quotes costs the surcharge off its own "Production & transport
 * surcharge" CONCRETE row — and until 29 Sep 2026 nothing joined the two, so
 * updating the fortnightly surcharge in the library changed no quote. */
export const GLOBAL_PRICES = [
  { path: ["global", "concreteSurchargePerM3"], name: "Production & transport surcharge", validityName: "Production & transport surcharge" },
];

/* The library's `validity` block: { "<catalog product name>": "YYYY-MM-DD" }
 * — the date each time-limited rate is published to (see lib/rateValidity.js). */
export const LIBRARY_VALIDITY_SECTION = "validity";

const readPath = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/** Every {rateKey, price} the library currently states a price for. */
export function libraryPrices(libraryState) {
  const byName = catalogByName();
  const out = [];
  const seen = new Set();
  if (!libraryState || typeof libraryState !== "object") return out;
  GLOBAL_PRICES.forEach(({ path, name }) => {
    const price = readPath(libraryState, path);
    if (typeof price !== "number" || !Number.isFinite(price)) return;
    const hit = byName.get(norm(name));
    if (!hit || seen.has(hit.key)) return;
    seen.add(hit.key);
    out.push({ key: hit.key, price, catalogCost: hit.unitCost, name, section: "global" });
  });
  const named = (section, rows, perTonne) => {
    if (!rows || typeof rows !== "object") return;
    Object.keys(rows).forEach((name) => {
      const row = rows[name];
      let price = row && typeof row === "object" ? row.cost : row;
      if (typeof price !== "number" || !Number.isFinite(price)) return;
      const hit = byName.get(norm(name));
      if (!hit) return;
      if (seen.has(hit.key)) return;                // the same product priced in two sections: first wins, never flip-flops
      let tolerance = 0;
      if (perTonne) {
        if (!(hit.unitWeight > 0)) return;          // no kg/m on the catalog row — cannot convert, leave it
        price = Math.round((price * 1000 / hit.unitWeight) * 100) / 100;
        // the library keeps $/m to four decimals, so $1,925/t comes back as
        // $1,924.95–$1,925.01: within a dollar a tonne is the same figure
        tolerance = 1;
      }
      seen.add(hit.key);
      out.push({ key: hit.key, price, catalogCost: hit.unitCost, name, section, tolerance });
    });
  };
  PRICED_SECTIONS.forEach((section) => named(section, libraryState[section], false));
  REO_SECTIONS.forEach(({ path, section, perTonne }) => named(section, readPath(libraryState, path), perTonne));
  // Labour & plant: by row index onto the crew-sheet resource it names.
  const lp = libraryState.labourPlant;
  if (lp && typeof lp === "object") {
    LIBRARY_LABOUR_PLANT.forEach(([name, unit, target], idx) => {
      if (!target) return;
      const row = lp[idx];
      const price = row && typeof row === "object" ? row.cost : row;
      if (typeof price !== "number" || !Number.isFinite(price)) return;
      let key, catalogCost;
      if (target === "catalog") { const hit = byName.get(norm(name)); if (!hit) return; key = hit.key; catalogCost = hit.unitCost; }
      else {
        const res = RESOURCE_COLS.find((r) => r.name === target[0] && r.unit === target[1]);
        if (!res) return;
        key = rateKey("LABOUR", res.name, res.unit); catalogCost = res.rate;
      }
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ key, price, catalogCost, name: `${name} (${unit})`, section: "labourPlant" });
    });
  }
  return out;
}

/* Names the library lists but Quotes must not take a price from: "Delivery
 * fee" appears in TWO library sections ($300 and $0 — different things) and
 * would map to one catalog product, so it is left to the Rates modal. */
export const LIBRARY_EXCLUDED_NAMES = ["Delivery fee"];
const excluded = (name) => LIBRARY_EXCLUDED_NAMES.some((n) => norm(n) === norm(name));

/** The rate keys the library governs right now (a Set). */
export function libraryGovernedKeys(libraryState) {
  const out = new Set();
  libraryPrices(libraryState).forEach(({ key, name }) => { if (!excluded(name)) out.add(key); });
  return out;
}

/**
 * The rate changes this library state implies. THE LIBRARY RULES: for every
 * product it prices, the stored Quotes rate must equal the library price —
 * no matter who set the stored value or on which device. (An earlier rule
 * only moved a rate that still equalled the catalog default or the value the
 * sync last wrote on THIS browser; a second browser, or a value written by an
 * older build, then looked like a deliberate edit and was never corrected —
 * that is how conventional formwork sat at $60 across every project while
 * the library said $150.) Returns [] when nothing should move, so a caller
 * can skip setState entirely and avoid a render loop.
 */
export function pendingRateUpdates(rates, libraryState /* , lastSynced: kept for callers, no longer consulted */) {
  const updates = [];
  libraryPrices(libraryState).forEach(({ key, price, name, catalogCost, tolerance }) => {
    if (excluded(name)) return;
    // A key the stored row does not carry yet (a product added to the
    // catalog after this install first saved its rates) prices at the
    // catalog default through lookupRate — so THAT is the figure the library
    // is compared with, and the row gains the key when they differ. Before
    // this such a product never took the library's price at all.
    const cur = rates && rates[key] && rates[key].unitCost != null ? rates[key].unitCost : catalogCost;
    if (cur == null) return;                        // nothing known on either side
    if (Math.abs(Number(cur) - Number(price)) <= (tolerance || 0)) return;   // already agrees
    updates.push({ key, price, from: cur, name });  // from + name feed the change log (lib/rateChanges.js)
  });
  // Validity dates travel the same way: a date the library states for a
  // product lands on that product's rate as `validUntil` (a separate entry,
  // so a price-only change keeps its {key, price} shape for older callers).
  libraryValidity(libraryState).forEach(({ key, validUntil }) => {
    const cur = rates && rates[key] ? rates[key].validUntil : undefined;
    if (!rates) return;
    if ((cur || "") === (validUntil || "")) return;
    updates.push({ key, validUntil });
  });
  return updates;
}

/** Every {rateKey, validUntil} the library states a validity date for —
 * keyed by catalog product name in its `validity` block; an empty string
 * clears the date on the Quotes side. */
export function libraryValidity(libraryState) {
  const out = [];
  if (!libraryState || typeof libraryState !== "object") return out;
  const rows = libraryState[LIBRARY_VALIDITY_SECTION];
  if (!rows || typeof rows !== "object") return out;
  const byName = catalogByName();
  Object.keys(rows).forEach((name) => {
    const v = rows[name];
    if (typeof v !== "string") return;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;   // only a real date, or blank to clear
    const hit = byName.get(norm(name));
    if (!hit) return;
    out.push({ key: hit.key, validUntil: v, name });
  });
  return out;
}

/* localStorage helpers — every read is guarded because a private window or a
 * browser with site data blocked throws on access rather than returning null. */
export function readLibraryState() {
  try { return JSON.parse(window.localStorage.getItem(RATES_LIBRARY_KEY)) || null; } catch { return null; }
}
export function readLastSynced() {
  try { return JSON.parse(window.localStorage.getItem(LIB_SYNC_KEY)) || {}; } catch { return {}; }
}
export function writeLastSynced(map) {
  try { window.localStorage.setItem(LIB_SYNC_KEY, JSON.stringify(map)); } catch { /* best-effort */ }
}
