/**
 * Quality checks for a Quotes project — the DETERMINISTIC layer (Grady,
 * 10 Oct 2026: "when a project is completed, user can click on quality checks
 * and the api connected should check against current prices and changes per
 * element, potentially and wrongly entered quantities that dont seem right and
 * ask for a manual review"). Pure: no React, no DOM, no network. Every finding
 * is a fact the costing library can prove; the AI only EXPLAINS findings
 * afterwards (api/ai-engine.js action "qa"), it never produces one.
 *
 * runQualityChecks(quote, liveRates, {today, benchmarks, elementTypes}) →
 *   { findings: [{id, check, severity, itemId, element, message, evidence, fix}],
 *     summary: {total, perM2, elements, concreteM3, steelT, ...}, ranAt }
 * Severities: "high" (prices money wrongly or not at all), "medium" (a figure
 * outside the usual band — look), "low" (housekeeping). Checks are named by
 * `check` so the AI Engine can group them and a person can acknowledge one.
 *
 * Shipped to the browser as dist/assets/gradcon-qa.js (vite.qa.config.js →
 * window.GradconQA) for the AI Engine's Quality checks tab; verify-covered.
 */
import { FULL_CATALOG, ELEMENT_TYPES } from "../data/catalog.js";
import {
  computeElementCost, computeElementReinforcementTonnes, labourQuantities, computeGrandTotal, computeExcludedTotals,
  rateKey, rowRate, isManualQuoteKey, categoryAppliesTo,
} from "./costing.js";
import { effectiveRates, frozenRateDrift, hasFrozenRates } from "./rateFreeze.js";
import { expiringRates } from "./rateValidity.js";
import { handoverPlan, handoverIssues } from "./handover.js";

export const STEEL_BAND_KG_M3 = { low: 20, high: 300 };
export const FORMWORK_BAND_M2_M3 = { high: 15 };
export const SLAB_THICKNESS_M = { low: 0.05, high: 2.0 };
export const LINEAR_SECTION_M2 = { low: 0.01, high: 5 };
export const BENCHMARK_FACTOR = { low: 0.5, high: 2.0 };
export const CREW_FACTOR = { low: 0.4, high: 2.5 };

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const productName = (key) => String(key).split("::")[1] || key;
const money = (v) => "$" + Math.round(n(v)).toLocaleString("en-AU");
const r1 = (v) => Math.round(n(v) * 10) / 10;
const usedKeys = (items) => { const s = new Set(); (items || []).forEach((it) => Object.entries(it.qtys || {}).forEach(([k, q]) => { if (n(q) > 0) s.add(k); })); return s; };

/** $/m² over GFA for a set of other projects (their stripped summaries) — the benchmark the project is compared with. */
export function benchmarksFrom(summaries, liveRates, statuses = ["Submitted", "Tendered", "Successful", "Unsuccessful"]) {
  const out = [];
  (summaries || []).forEach((q) => {
    if (!q || !statuses.includes(q.status) || !(n(q.gfa) > 0) || !Array.isArray(q.items) || !q.items.length) return;
    try {
      const total = computeGrandTotal(q.items, effectiveRates(q, liveRates), q.scope);
      if (total > 0) out.push({ name: q.projectName || "", status: q.status, gfa: n(q.gfa), total, perM2: total / n(q.gfa), scope: q.scope || "both" });
    } catch { /* a summary that cannot be costed is no benchmark */ }
  });
  return out;
}
export const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

export function runQualityChecks(quote, liveRates, opts = {}) {
  const today = opts.today ? new Date(opts.today) : new Date();
  const items = Array.isArray(quote && quote.items) ? quote.items : [];
  const rates = effectiveRates(quote || {}, liveRates || {});
  const scope = (quote && quote.scope) || "both";
  const types = Array.isArray(opts.elementTypes) && opts.elementTypes.length ? opts.elementTypes : ELEMENT_TYPES;
  const findings = [];
  let seq = 0;
  const add = (check, severity, item, message, evidence, fix) => findings.push({ id: `${check}-${++seq}`, check, severity, itemId: item ? item.id : null, element: item ? item.label || "" : null, message, evidence: evidence || "", fix: fix || "" });

  // Per element: cost, concrete, steel, formwork, measures, duplicates, crew bands
  const costs = items.map((it) => computeElementCost(it, rates, scope));
  const lqs = items.map((it) => labourQuantities(it, rates));
  const tonnes = items.map((it) => computeElementReinforcementTonnes(it, rates));
  const seenSig = new Map();
  items.forEach((item, i) => {
    const c = costs[i], lq = lqs[i], conc = n(c.concreteQty), t = n(tonnes[i]);
    const hasQty = Object.values(item.qtys || {}).some((q) => n(q) > 0) || (item.additional || []).some((a) => n(a.qty) > 0);
    // 1. subcontract quote rows with a quantity and no figure — they price at $0
    Object.entries(item.qtys || {}).forEach(([key, q]) => {
      if (!isManualQuoteKey(key) || !(n(q) > 0)) return;
      if (!(rowRate(item, rates, key, 0) > 0)) add("unpriced-quote", "high", item, `${productName(key)}: quantity ${n(q)} typed but no quote amount — it prices at $0.`, `qtys[${productName(key)}] = ${n(q)}, no rateOverrides amount`, "Type the received quote on the row, or clear the quantity if it is not in scope.");
    });
    // 2. steel against concrete
    if (conc > 0) {
      const kg = (t * 1000) / conc;
      if (t <= 0 && conc >= 2) add("no-steel", "medium", item, `${r1(conc)} m³ of concrete and no reinforcement on this element.`, `concrete ${r1(conc)} m³, reinforcement 0 t`, "Check the bar, mesh or rate rows — or confirm the element is unreinforced / steel is elsewhere.");
      else if (t > 0 && kg < STEEL_BAND_KG_M3.low) add("steel-ratio", "medium", item, `Steel ${r1(kg)} kg/m³ is below the usual ${STEEL_BAND_KG_M3.low} kg/m³.`, `${r1(t * 1000)} kg over ${r1(conc)} m³`, "Check bar lengths, mesh area or the kg/m³ rate row.");
      else if (kg > STEEL_BAND_KG_M3.high) add("steel-ratio", "medium", item, `Steel ${r1(kg)} kg/m³ is above the usual ${STEEL_BAND_KG_M3.high} kg/m³.`, `${r1(t * 1000)} kg over ${r1(conc)} m³`, "A bar schedule may be entered twice, or a rate row sits beside a bar list (rule 9).");
      // 3. formwork against concrete
      const fm = n(lq.formworkM2) / conc;
      if (fm > FORMWORK_BAND_M2_M3.high) add("formwork-ratio", "medium", item, `Formwork ${r1(fm)} m²/m³ is above the usual ${FORMWORK_BAND_M2_M3.high} m²/m³.`, `${r1(lq.formworkM2)} m² over ${r1(conc)} m³`, "Check the formwork quantity against the faces actually formed.");
      // 4. concrete against the measures
      if (n(item.measureM2) > 0) { const th = conc / n(item.measureM2); if (th < SLAB_THICKNESS_M.low || th > SLAB_THICKNESS_M.high) add("concrete-vs-measure", "medium", item, `Concrete over the recorded area implies ${Math.round(th * 1000)} mm thick — outside ${SLAB_THICKNESS_M.low * 1000}–${SLAB_THICKNESS_M.high * 1000} mm.`, `${r1(conc)} m³ ÷ ${r1(item.measureM2)} m²`, "Check the m³ or the m² in Project Geometry."); }
      if (n(item.measureLm) > 0) { const a = conc / n(item.measureLm); if (a < LINEAR_SECTION_M2.low || a > LINEAR_SECTION_M2.high) add("concrete-vs-measure", "medium", item, `Concrete over the recorded run implies a ${r1(a * 1000) / 1000} m² section — outside ${LINEAR_SECTION_M2.low}–${LINEAR_SECTION_M2.high} m².`, `${r1(conc)} m³ ÷ ${r1(item.measureLm)} lm`, "Check the m³ or the run length in Project Geometry."); }
    }
    // 5. an element that carries nothing
    if (!hasQty && n(c.total) === 0) add("empty-element", "low", item, "This element carries no quantities and no cost.", "no qtys, no additional rows", "Fill it in, or remove it so the report does not list an empty line.");
    // 6. duplicates: same type and label, or the same non-empty quantities
    const sig = JSON.stringify(Object.entries(item.qtys || {}).filter(([, q]) => n(q) > 0).sort());
    const labelKey = `${item.typeId}::${String(item.label || "").trim().toLowerCase()}`;
    const prevL = seenSig.get("L" + labelKey), prevS = sig !== "[]" ? seenSig.get("S" + sig) : null;
    if (prevL) add("duplicate-element", "medium", item, `Same type and name as "${prevL.label}" — entered twice?`, `typeId ${item.typeId}, label "${item.label}"`, "Keep one, or rename them so each is a distinct element.");
    else if (prevS) add("duplicate-element", "medium", item, `Identical quantities to "${prevS.label}" — copied and not changed?`, "every quantity equal", "Check that both elements are real and different.");
    seenSig.set("L" + labelKey, item); if (sig !== "[]") seenSig.set("S" + sig, item);
    // 7. crew days against the handover bands (what the bands would put in each cell, compared with what is typed)
    if (conc > 0 && Array.isArray(item.tasks) && item.tasks.length) {
      const blankCopy = JSON.parse(JSON.stringify(item)); blankCopy.tasks.forEach((tk) => { tk.qtys = {}; });
      let plan = null; try { plan = handoverPlan([blankCopy], rates); } catch { plan = null; }
      (plan ? plan.cells : []).forEach((cell) => {
        const task = item.tasks.find((tk) => tk.id === cell.taskId); if (!task) return;
        const typed = (task.qtys || {})[cell.key]; if (typed === "" || typed == null || !(n(cell.value) >= 2)) return;
        const ratio = n(typed) / n(cell.value);
        if (ratio > CREW_FACTOR.high || (n(typed) > 0 && ratio < CREW_FACTOR.low)) add("crew-vs-band", "low", item, `${task.name}: ${n(typed)} ${cell.key.replace(/_/g, " ")} typed, the handover band says about ${n(cell.value)}.`, `${r1(conc)} m³ poured`, "Keep it if the job is unusual; otherwise check the cell.");
      });
    }
  });

  // 8. rates past or near their validity — only the ones this project uses count as medium
  const used = usedKeys(items);
  // Validity dates are supplier notices and live on the LIVE rates; a pinned
  // project's copy never gains one, so the alarm reads the live dates over the copy.
  const validitySource = { ...rates };
  Object.keys(liveRates || {}).forEach((k) => { const lr = liveRates[k]; if (lr && lr.validUntil) validitySource[k] = { ...(validitySource[k] || {}), validUntil: lr.validUntil, unitCost: validitySource[k] && validitySource[k].unitCost != null ? validitySource[k].unitCost : lr.unitCost }; });
  expiringRates(validitySource, today).forEach((r) => {
    const inUse = used.has(r.key);
    add(r.state === "expired" ? "rate-expired" : "rate-expiring", r.state === "expired" ? (inUse ? "high" : "low") : (inUse ? "medium" : "low"), null, `${r.name}: ${r.state === "expired" ? "validity passed" : "validity ends"} ${r.validUntil}${inUse ? " and this project uses it" : ""}.`, `${r.catKey} · ${money(r.unitCost)} / ${r.unit}`, "Enter the supplier's next notice and date in the Rates Library.");
  });
  // 9. rate drift since the project was pinned, with its cost
  if (hasFrozenRates(quote)) {
    frozenRateDrift(quote, liveRates || {}).forEach((d) => {
      if (!used.has(d.key)) return;
      let qty = 0; items.forEach((it) => { qty += n((it.qtys || {})[d.key]); });
      const impact = (d.live - d.pinned) * qty;
      add("rate-drift", Math.abs(impact) >= 500 ? "medium" : "low", null, `${productName(d.key)}: pinned at ${money(d.pinned)}, the live rate is ${money(d.live)} (${impact >= 0 ? "+" : "−"}${money(Math.abs(impact))} on this project at the current quantities, before any basis).`, `pinned ${quote.ratesFrozen.at}`, "Re-price with current rates from the editor's banner if the quote has not gone out.");
    });
  }
  // 10. $/m² against Gradcon's own submitted projects
  const total = computeGrandTotal(items, rates, scope);
  const gfa = n(quote && quote.gfa);
  const perM2 = gfa > 0 ? total / gfa : null;
  const bench = Array.isArray(opts.benchmarks) ? opts.benchmarks.filter((b) => b && b.perM2 > 0) : [];
  const med = median(bench.map((b) => b.perM2));
  if (perM2 != null && med) {
    const f = perM2 / med;
    if (f < BENCHMARK_FACTOR.low || f > BENCHMARK_FACTOR.high) add("sqm-benchmark", "medium", null, `${money(perM2)}/m² direct cost against a median of ${money(med)}/m² over ${bench.length} submitted project${bench.length === 1 ? "" : "s"} (${Math.round(f * 100)}%).`, bench.slice(0, 5).map((b) => `${b.name}: ${money(b.perM2)}/m²`).join(" · "), "Different building type or scope? If not, look for a missing or doubled element.");
  }
  // 11. project fields
  if (!quote || !String(quote.clientName || "").trim()) add("project-fields", "low", null, "No client recorded.", "", "Type the client in the editor header.");
  if (!quote || !(quote.planner && quote.planner.deadline)) add("project-fields", "low", null, "No tender deadline recorded.", "", "Set it in Project Management.");
  if (!(gfa > 0)) add("project-fields", "low", null, "No GFA recorded — no $/m² can be checked.", "", "Type the GFA in the editor header.");
  // 12. money the scope leaves out — stated, never lost
  const ex = computeExcludedTotals(items, rates, scope);
  if (n(ex.materials) + n(ex.labour) > 0) add("scope-excluded", "low", null, `Scope "${scope}" leaves ${money(ex.materials)} of materials and ${money(ex.labour)} of labour uncharged.`, "computeExcludedTotals", "State it on the tender as not included.");
  // 13. the handover's own issue list (half-entered additional rows, estimator-note names)
  const hi = handoverIssues(items, types);
  hi.halfEnteredAdditional.forEach((a) => { const it = items.find((x) => x.id === a.itemId); add("half-entered-row", "medium", it, `Additional row "${a.name || "(no name)"}" is only part-entered (qty ${a.qty == null ? "—" : a.qty}, rate ${a.rate == null ? "—" : a.rate}).`, "", "Finish the row or delete it."); });
  hi.labelSuggestions.forEach((l) => { const it = items.find((x) => x.id === l.itemId); add("label-note", "low", it, `Element name reads like an estimator's note: "${l.from}".`, "", `Rename to "${l.to}".`); });

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
  return {
    ranAt: today.toISOString(),
    findings,
    counts: { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length },
    summary: { total, gfa, perM2, elements: items.length, concreteM3: costs.reduce((s, c) => s + n(c.concreteQty), 0), steelT: tonnes.reduce((s, t) => s + n(t), 0), pinned: hasFrozenRates(quote) ? quote.ratesFrozen.at : null, benchmarkMedianPerM2: med, benchmarks: bench.length, scope },
  };
}
