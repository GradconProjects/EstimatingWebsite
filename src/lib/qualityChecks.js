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
import { FULL_CATALOG, ELEMENT_TYPES, RESOURCE_COLS } from "../data/catalog.js";
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
  // 10b. entered rates against the Victorian market bands Grady keeps (AI Engine → Quality checks → benchmarks)
  rateBenchmarkFindings(rates, opts.rateBenchmarks, used).forEach((f) => { f.id = `${f.check}-${++seq}`; findings.push(f); });
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

/* ======================= Takeoff vs documents =======================
 * Grady, 11 Oct 2026: "see what grade of concrete for instance was used in
 * the estimates section against what was specified on the drawings and the
 * specifications sheet. and do same for all other elements so we dont submit
 * something wrong". The takeoff's instances (Estimates data fields, read per
 * calculator by instanceFacts) are matched to the AI Engine's drawing
 * proposal (the takeoff job's reviewed elements) and to the ticked
 * specification profile; every difference is a finding with both figures.
 * Pure; the AI Engine passes `calcOf(typeKey)` from its LIBRARY mirror. */
const DOC_BUCKET = { stripfooting: "footings", padfooting: "footings", pilecap: "footings", pier: "piers", slab: "slabs", beam: "beams", column: "columns", wall: "walls", retwall: "walls", shotwall: "walls", stairs: "stairs", kerb: "kerbs" };
const gradeNum = (g) => { if (g == null || g === "") return null; const m = String(g).match(/(\d{2,3})/); return m ? +m[1] : null; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const dia = (v) => (v && /^[nrl]\d{2}$/i.test(String(v).trim()) ? String(v).trim().toUpperCase() : null);

/** The facts a calculator's data carries, in the generic shape the drawings proposal uses. */
export function instanceFacts(inst, calc) {
  const d = (inst && inst.data) || {};
  const f = { grade: gradeNum(d.grade), cover: n(d.cover) || null, mesh: null, main: {}, cross: {}, top: {}, ligs: {}, qty: n(d.qty) || null, L: null, W: null, D: null, H: null, DIA: null };
  const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
  switch (calc) {
    case "pier": f.DIA = num(d.dia); f.L = num(d.depth); f.main = { dia: dia(d.vDia), qty: num(d.vBars) }; f.ligs = { dia: dia(d.ligDia), spacing: num(d.genSpacing) }; break;
    case "pilecap": f.L = num(d.L); f.W = num(d.W); f.D = num(d.D); f.main = { dia: dia(d.botXDia), spacing: num(d.botXSpacing) }; f.top = { dia: dia(d.topXDia), spacing: num(d.topXSpacing) }; break;
    case "stripfooting": f.L = num(d.length); f.W = num(d.width); f.D = num(d.depth); f.main = { dia: dia(d.botLongDia), qty: num(d.botLongQty) }; f.cross = { dia: dia(d.crossDia), spacing: num(d.crossSpacing) }; if (d.topLong) f.top = { dia: dia(d.topLongDia), qty: num(d.topLongQty) }; if (d.ligs) f.ligs = { dia: dia(d.ligDia), spacing: num(d.ligSpacing) }; break;
    case "padfooting": f.L = num(d.length); f.W = num(d.width); f.D = num(d.depth); if (d.shape === "round") f.DIA = num(d.diameter); if (d.botReoType === "mesh") f.mesh = d.botMeshType || null; else f.main = { dia: dia(d.botXDia), spacing: num(d.botXSpacing) }; if (d.topMatOn) f.top = { dia: dia(d.topXDia), spacing: num(d.topXSpacing) }; if (d.ligs) f.ligs = { dia: dia(d.ligDia), spacing: num(d.ligSpacing) }; break;
    case "beam": { f.L = num(d.length); f.W = num(d.width); f.D = num(d.depth); const rows = Array.isArray(d.reoRows) ? d.reoRows : []; const bot = rows.find((r) => /bottom/i.test(r.position)), top = rows.find((r) => /top/i.test(r.position)); if (bot) f.main = { dia: dia(bot.dia), qty: num(bot.qty) }; if (top) f.top = { dia: dia(top.dia), qty: num(top.qty) }; const z = Array.isArray(d.ligZones) ? d.ligZones.find((x) => /mid/i.test(x.zone)) || d.ligZones[0] : null; if (z) f.ligs = { dia: dia(z.dia), spacing: num(z.spacing) }; break; }
    case "slab": f.L = num(d.length) != null ? num(d.length) * 1000 : null; f.W = num(d.width) != null ? num(d.width) * 1000 : null; f.D = num(d.thickness); f.qty = null; if (d.meshOn) f.mesh = d.meshType || null; if (d.botX) f.main = { dia: dia(d.botXDia), spacing: num(d.botXSpacing) }; if (d.topX) f.top = { dia: dia(d.topXDia), spacing: num(d.topXSpacing) }; break;
    case "column": if (d.shape === "circular") f.DIA = num(d.dia); else { f.W = num(d.width); f.D = num(d.depth); } f.H = num(d.height); f.main = { dia: dia(d.vDia), qty: num(d.vBars) }; f.ligs = { dia: dia(d.ligDia), spacing: num(d.ligSpacing) }; break;
    case "wall": f.L = num(d.length); f.D = num(d.thickness); f.H = num(d.height); f.main = { dia: dia(d.vertADia), spacing: num(d.vertASpacing) }; f.cross = { dia: dia(d.horADia), spacing: num(d.horASpacing) }; break;
    case "retwall": f.L = num(d.length); f.H = num(d.stemH); f.D = num(d.stemT); f.W = num(d.footL); f.qty = null; break;
    case "stairs": f.W = num(d.width); f.D = num(d.waistT); f.qty = null; break;
    case "kerb": f.L = num(d.length); f.qty = null; break;
    case "generic": f.L = num(d.length); f.W = num(d.width); f.D = num(d.depth); break;
    default: break;
  }
  return f;
}
const propFacts = (el) => ({
  grade: gradeNum(el.grade), cover: n(el.cover_mm) || null, mesh: el.mesh || null, qty: n(el.qty) || null,
  main: { dia: dia(el.mainDia), qty: n(el.mainQty) || null, spacing: n(el.mainSpacing) || null }, cross: { dia: dia(el.crossDia), spacing: n(el.crossSpacing) || null },
  top: { dia: dia(el.topDia), qty: n(el.topQty) || null, spacing: n(el.topSpacing) || null }, ligs: { dia: dia(el.ligDia), spacing: n(el.ligSpacing) || null },
  L: n(el.length_mm) || null, W: n(el.width_mm) || null, D: n(el.depth_mm) || null, H: n(el.height_mm) || null, DIA: n(el.diameter_mm) || null,
});
const close = (a, b, tol = 0.02) => a != null && b != null && Math.abs(a - b) <= Math.max(1, tol * Math.max(Math.abs(a), Math.abs(b)));

/** Match takeoff instances to drawing elements: by the AI import's mark + sheet, then by label, then by mark inside the label. */
export function matchInstances(instances, elements) {
  const pairs = []; const used = new Set();
  const findEl = (pred) => elements.findIndex((e, i) => !used.has(i) && pred(e, i));
  instances.forEach((inst) => {
    const ai = inst.data && inst.data.__aiImport; let i = -1;
    if (ai && ai.mark) i = findEl((e) => e.mark && norm(e.mark) === norm(ai.mark) && (!ai.sheet || !e.sheet || norm(e.sheet) === norm(ai.sheet)));
    if (i < 0) i = findEl((e) => norm(e.label) && norm(e.label) === norm(inst.label));
    if (i < 0) i = findEl((e) => e.mark && norm(inst.label).split(" ").includes(norm(e.mark)));
    if (i >= 0) { used.add(i); pairs.push({ inst, el: elements[i], index: i }); } else pairs.push({ inst, el: null, index: -1 });
  });
  const unmatched = elements.map((e, i) => ({ el: e, index: i })).filter((x) => !used.has(x.index));
  return { pairs, unmatched };
}

export function compareTakeoffToDocuments({ instances = [], proposal = null, profile = null, calcOf = () => null, today } = {}) {
  const findings = []; let seq = 0;
  const add = (check, severity, inst, message, evidence, fix) => findings.push({ id: `${check}-${++seq}`, check, severity, itemId: inst ? inst.id : null, element: inst ? inst.label || "" : null, message, evidence: evidence || "", fix: fix || "" });
  const elements = proposal && Array.isArray(proposal.elements) ? proposal.elements.filter((e) => e && (e.include == null || e.include)) : [];
  const { pairs, unmatched } = matchInstances(instances, elements);
  const pd = profile && profile.defaults ? profile.defaults : null;
  pairs.forEach(({ inst, el }) => {
    const calc = calcOf(inst.typeKey); const f = instanceFacts(inst, calc); const bucket = DOC_BUCKET[calc] || null;
    const where = el ? `sheet ${el.sheet || "?"}${el.mark ? " mark " + el.mark : ""}` : "";
    if (el) {
      const p = propFacts(el);
      if (p.grade && f.grade && p.grade !== f.grade) add("grade-vs-drawing", "high", inst, `Concrete grade N${f.grade} in the takeoff; the drawings say N${p.grade}.`, `${where}: ${el.evidence || ""}`, `Set the element's grade to N${p.grade}, or record why it differs.`);
      if (p.cover && f.cover && p.cover !== f.cover) add("cover-vs-drawing", "medium", inst, `Cover ${f.cover} mm in the takeoff; the drawings say ${p.cover} mm.`, `${where}: ${el.evidence || ""}`, "Check the cover on the element.");
      if (p.mesh && f.mesh && norm(p.mesh) !== norm(f.mesh)) add("reo-vs-drawing", "high", inst, `Mesh ${f.mesh} in the takeoff; the drawings say ${p.mesh}.`, `${where}: ${el.evidence || ""}`, "Change the mesh type.");
      if (p.mesh && !f.mesh && f.main.dia) add("reo-vs-drawing", "medium", inst, `The takeoff reinforces with ${f.main.dia} bars; the drawings show mesh ${p.mesh}.`, `${where}: ${el.evidence || ""}`, "Confirm bars or mesh.");
      if (p.main.dia && f.main.dia && p.main.dia !== f.main.dia) add("reo-vs-drawing", "high", inst, `Main bars ${f.main.dia} in the takeoff; the drawings say ${p.main.dia}.`, `${where}: ${el.evidence || ""}`, `Change the main bar size to ${p.main.dia}.`);
      if (p.main.qty && f.main.qty && p.main.qty !== f.main.qty) add("reo-vs-drawing", "medium", inst, `${f.main.qty} main bars in the takeoff; the drawings say ${p.main.qty}.`, where, "Check the bar count.");
      if (p.main.spacing && f.main.spacing && !close(p.main.spacing, f.main.spacing, 0.01)) add("reo-vs-drawing", "medium", inst, `Main bars at ${f.main.spacing} mm in the takeoff; the drawings say ${p.main.spacing} mm.`, where, "Check the spacing.");
      if (p.ligs.dia && f.ligs.dia && p.ligs.dia !== f.ligs.dia) add("reo-vs-drawing", "medium", inst, `Ligatures ${f.ligs.dia} in the takeoff; the drawings say ${p.ligs.dia}.`, where, "Change the ligature size.");
      if (p.ligs.spacing && f.ligs.spacing && !close(p.ligs.spacing, f.ligs.spacing, 0.01)) add("reo-vs-drawing", "medium", inst, `Ligatures at ${f.ligs.spacing} mm in the takeoff; the drawings say ${p.ligs.spacing} mm.`, where, "Check the ligature spacing.");
      if (p.top.dia && f.top.dia && p.top.dia !== f.top.dia) add("reo-vs-drawing", "medium", inst, `Top bars ${f.top.dia} in the takeoff; the drawings say ${p.top.dia}.`, where, "Change the top bar size.");
      [["L", "length"], ["W", "width"], ["D", "depth / thickness"], ["H", "height"], ["DIA", "diameter"]].forEach(([k, name]) => { if (p[k] && f[k] && !close(p[k], f[k])) add("size-vs-drawing", "medium", inst, `${name} ${Math.round(f[k])} mm in the takeoff; the drawings say ${Math.round(p[k])} mm.`, where, "Check the dimension on the sheet."); });
      if (p.qty && f.qty && p.qty !== f.qty) add("count-vs-drawing", "medium", inst, `${f.qty} in the takeoff; ${p.qty} counted on the drawings.`, where, "Count the mark on the plan again.");
    } else if (elements.length) {
      add("not-on-drawings", "low", inst, "No element on the drawings matches this takeoff element.", "matched by mark, sheet and name", "Fine if it was added by hand (blinding, allowances); otherwise check it belongs to this job.");
    }
    if (pd && bucket) {
      const sg = gradeNum((pd.concreteGradeByElement || {})[bucket] || (pd.concreteGradeByElement || {}).all);
      const sc = n((pd.coverByElement || {})[bucket] || (pd.coverByElement || {}).all) || null;
      if (sg && f.grade && sg !== f.grade) add("grade-vs-spec", el && gradeNum(el.grade) === f.grade ? "medium" : "high", inst, `Concrete grade N${f.grade} in the takeoff; the specification says N${sg} for ${bucket}${el && gradeNum(el.grade) === f.grade ? " (the drawings agree with the takeoff — specification and drawings differ)" : ""}.`, `specification profile${profile && profile.specName ? " " + profile.specName : ""}`, "Resolve with the engineer which document governs; price the higher grade until then.");
      if (sc && f.cover && sc !== f.cover) add("cover-vs-spec", "medium", inst, `Cover ${f.cover} mm in the takeoff; the specification says ${sc} mm for ${bucket}.`, "specification profile", "Check the exposure class and cover.");
    }
  });
  unmatched.forEach(({ el }) => add("missing-from-takeoff", "medium", null, `On the drawings but not in the takeoff: ${el.label || el.type}${el.qty ? " × " + el.qty : ""}${el.sheet ? " (sheet " + el.sheet + ")" : ""}.`, el.evidence || "", "Add it to the takeoff, or record that it is out of scope."));
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
  return { ranAt: (today ? new Date(today) : new Date()).toISOString(), findings, counts: { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, low: findings.filter((f) => f.severity === "low").length }, summary: { elements: instances.length, drawingElements: elements.length, matched: pairs.filter((p) => p.el).length, unmatchedOnDrawings: unmatched.length, hasSpec: !!pd } };
}

/* ======================= Rates vs Victorian market =======================
 * Benchmarks are rows Grady keeps in the AI Engine ({name, match, unit, low,
 * high, source, asOf}; `match` is matched case-insensitively inside catalog
 * product names and labour resource names, `unit` must agree). An entered
 * rate outside [low, high] is a finding; nothing is changed. The AI may
 * SUGGEST rows from a web search (api/ai-engine.js action "benchmarks") but
 * only a row Grady accepted counts. */
export function rateBenchmarkFindings(rates, benchmarks, usedKeys = new Set(), opts = {}) {
  const findings = []; let seq = 0; const r = rates || {};
  const cands = [];
  FULL_CATALOG.forEach((cat) => cat.products.forEach((p) => cands.push({ key: rateKey(cat.key, p.name, p.unit), name: p.name, unit: p.unit, cat: cat.key })));
  RESOURCE_COLS.forEach((res) => cands.push({ key: rateKey("LABOUR", res.name, res.unit), name: res.name, unit: res.unit, cat: "LABOUR" }));
  (benchmarks || []).forEach((b) => {
    if (!b || !b.match || !(n(b.low) > 0 || n(b.high) > 0)) return;
    const m = norm(b.match); const unit = String(b.unit || "").toLowerCase();
    cands.filter((c) => norm(c.name).includes(m) && (!unit || String(c.unit).toLowerCase() === unit)).forEach((c) => {
      const v = r[c.key] && r[c.key].unitCost; if (v == null || v === "" || !(n(v) > 0)) return;
      const low = n(b.low) || 0, high = n(b.high) || Infinity; const inUse = usedKeys.has(c.key);
      if (n(v) < low || n(v) > high) findings.push({ id: `rate-vs-market-${++seq}`, check: "rate-vs-market", severity: inUse ? "medium" : "low", itemId: null, element: null, message: `${c.name} (${c.unit}): entered ${money(v)}, Victorian market band ${money(low)}–${high === Infinity ? "∞" : money(high)}${b.name ? " (" + b.name + ")" : ""}${inUse ? " — this project uses it" : ""}.`, evidence: `${b.source || "benchmark"}${b.asOf ? " · as of " + b.asOf : ""}`, fix: "Check the supplier's current price list; update the Rates Library if it moved, or the benchmark if the market did." });
    });
  });
  return findings;
}
