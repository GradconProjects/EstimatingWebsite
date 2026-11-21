/* Gradcon Estimates — "Compile assumptions": what was measured, what was
 * assumed and what is excluded, built from the takeoff itself.
 *
 * Boma, 21 Nov 2026: "in estimates, i want to include a button that compiles
 * assumptions, exclusions and what was measure so we can push to the
 * assumptions section of the quotes. what was measured should derive from the
 * actual take off".
 *
 * PURE and DOM-free, like estimates-schema.js / estimates-orders.js /
 * estimates-scope.js: inlined into estimates-app.html by
 * scripts/assemble-portal.mjs AND run in plain Node by scripts/verify.mjs.
 *
 * `compileBasis(input)` is the ONE compiler. Every line it returns is a
 * reading of something the takeoff holds — a register line, a field the
 * estimator set, a default nobody typed over, a switch turned off — or of the
 * Scope finder's document for the same takeoff. Nothing is composed and no
 * figure is invented: a quantity is the sum of the element's own register
 * lines (NET, as measured — the waste and lap the price carries are stated
 * once, as an assumption).
 *
 * A line is `{id, kind: "measured" | "assumption" | "exclusion", text, plain,
 * sure, elementId?}`. `id` is stable (a hash of the kind and the rule that
 * made it), so a tick or an edit survives the next compile. `plain` is the
 * same line with no quantity in it. `sure: false` marks a line INFERRED from
 * something that is absent ("no excavation measured for …") — it starts
 * unticked; a line read from a switch or a figure starts ticked.
 *
 * The estimator's ticks, edits and hand-typed lines live in their OWN row —
 * `gradcon-basis::<takeoffId>` in estimator_kv with a localStorage mirror —
 * never inside the takeoff snapshot:
 *   { version, takeoffId, showQty, edits: {<lineId>: {on?, text?, base?, at}},
 *     custom: [{id, kind, text, at}], removed: {<custom id>: at},
 *     pushed: {at, by, project, count}, updatedAt, updatedBy }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const BASIS_DOC_PREFIX = "gradcon-basis::";
  const BASIS_DOC_VERSION = 1;
  /** The one-shot hand-off Quotes consumes (src/lib/estimateBasis.js holds the same name). */
  const BASIS_HANDOFF_KEY = "gradcon-estimate-basis";
  const BASIS_KINDS = [
    { key: "measured", label: "What was measured", add: "Add a measured item" },
    { key: "assumption", label: "Assumptions", add: "Add an assumption" },
    { key: "exclusion", label: "Exclusions", add: "Add an exclusion" },
  ];
  const BASIS_NAMES_MAX = 8;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const str = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  function basisDocKey(takeoffId) { return BASIS_DOC_PREFIX + String(takeoffId || "default"); }
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  /** Stable id of a compiled line: the kind's letter and a hash of the rule (and the element / value it is about). */
  function basisId(kind, ...parts) { return "b" + String(kind || "x").charAt(0) + "_" + hash(parts.map((p) => String(p == null ? "" : p).toLowerCase()).join("|")); }

  /** 1,234.5 — up to `dp` decimals, trailing zeros dropped. */
  function fmtQty(n, dp) {
    const d = dp == null ? 2 : dp;
    const v = Math.round(num(n) * Math.pow(10, d)) / Math.pow(10, d);
    const [i, f] = v.toFixed(d).split(".");
    const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const frac = (f || "").replace(/0+$/, "");
    return frac ? int + "." + frac : int;
  }
  function fmtSteel(kg) { return kg >= 1000 ? fmtQty(kg / 1000, 2) + " t" : fmtQty(kg, 0) + " kg"; }
  /** The NET quantity of a register line — what was measured; a manual override IS the estimator's figure. */
  function netQty(l) { return l && l.manualOverride ? num(l.finalQty) : num(l && l.qty) || (l && !("qty" in l) ? num(l.finalQty) : 0); }
  /** Bar steel: every Reinforcement line, and a Connections / Joints line that weighs (the app's isBarSteelLine). */
  function isSteelLine(l) { return !!l && (l.materialGroup === "Reinforcement" || ((l.materialGroup === "Connections" || l.materialGroup === "Joints") && num(l.weightKg) > 0)); }
  function netKg(l) { const f = num(l.finalQty), w = num(l.weightKg); if (!(w > 0)) return 0; const q = netQty(l); return f > 0 && q > 0 ? (w * q) / f : w; }
  const isM3 = (u) => /^m(3|³)$/i.test(String(u || ""));
  const isM2 = (u) => /^m(2|²)$/i.test(String(u || ""));
  const isLm = (u) => /^(m|lm)$/i.test(String(u || ""));
  const KNOWN_GROUPS = { Concrete: 1, Reinforcement: 1, Connections: 1, Joints: 1, Formwork: 1, Excavation: 1, "Base/Blinding": 1, "Vapour Barrier": 1 };

  function names(list, max) {
    const m = max || BASIS_NAMES_MAX;
    const u = []; list.forEach((n) => { const s = str(n); if (s && u.indexOf(s) < 0) u.push(s); });
    if (u.length <= m) return u.join(", ");
    return u.slice(0, m).join(", ") + " and " + (u.length - m) + " more";
  }
  function elName(el) {
    const label = str(el.label) || str(el.type) || "Element";
    const type = str(el.type);
    return type && label.toLowerCase().indexOf(type.toLowerCase()) < 0 && type.toLowerCase().indexOf(label.toLowerCase()) < 0 ? label + " (" + type + ")" : label;
  }
  /** "Blinding concrete" → "blinding concrete"; a code keeps its capitals ("N32 concrete", "SL92"). */
  const lower1 = (s) => { const t = str(s); return t && /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; };

  /** What one element's register lines add up to — net, by the kind of work. */
  function elementMeasure(el) {
    const lines = (el && el.lines) || [];
    const conc = new Map(), mesh = new Map(), base = new Map(), other = new Map();
    let steelKg = 0, formM2 = 0, formLm = 0, formNo = 0, excM3 = 0, spoilM3 = 0, backfillM3 = 0, vapM2 = 0;
    lines.forEach((l) => {
      if (!l) return;
      const q = netQty(l), g = l.materialGroup, m = str(l.material);
      if (isSteelLine(l)) {
        steelKg += netKg(l);
        if (g === "Reinforcement" && isM2(l.unit) && q > 0) mesh.set(m || "Mesh", (mesh.get(m || "Mesh") || 0) + q);
        return;
      }
      if (!(q > 0)) return;
      if (g === "Concrete") { if (isM3(l.unit)) conc.set(m || "Concrete", (conc.get(m || "Concrete") || 0) + q); }
      else if (g === "Formwork") { if (isM2(l.unit)) formM2 += q; else if (isLm(l.unit)) formLm += q; else if (/^no/i.test(l.unit || "")) formNo += q; else formM2 += q; }
      else if (g === "Excavation") {
        if (!isM3(l.unit)) return;
        if (/backfill/i.test(m)) backfillM3 += q; else if (/spoil/i.test(m)) spoilM3 += q; else excM3 += q;
      }
      else if (g === "Base/Blinding") { const k = (m || "Blinding") + "|" + (l.unit || ""); base.set(k, (base.get(k) || 0) + q); }
      else if (g === "Vapour Barrier") { if (isM2(l.unit)) vapM2 += q; }
      else if (g && !KNOWN_GROUPS[g]) { const k = g + "|" + (m || g) + "|" + (l.unit || ""); other.set(k, (other.get(k) || 0) + q); }
    });
    return { conc, mesh, base, other, steelKg, formM2, formLm, formNo, excM3, spoilM3, backfillM3, vapM2, lineCount: lines.length };
  }
  function measureBits(m) {
    const bits = [], kinds = [];
    [...m.conc.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).forEach(([mat, v]) => { bits.push(mat + " " + fmtQty(v, 2) + " m³"); kinds.push(lower1(mat)); });
    if (m.steelKg > 0) {
      const meshStr = [...m.mesh.entries()].map(([mat, v]) => mat + " mesh " + fmtQty(v, 1) + " m²").join(", ");
      bits.push("reinforcement " + fmtSteel(m.steelKg) + (meshStr ? " (incl. " + meshStr + ")" : ""));
      kinds.push("reinforcement" + (m.mesh.size ? " (incl. " + [...m.mesh.keys()].join(", ") + " mesh)" : ""));
    }
    if (m.formM2 > 0 || m.formLm > 0 || m.formNo > 0) {
      const f = []; if (m.formM2 > 0) f.push(fmtQty(m.formM2, 1) + " m²"); if (m.formLm > 0) f.push(fmtQty(m.formLm, 1) + " lm"); if (m.formNo > 0) f.push(fmtQty(m.formNo, 0) + " formed openings");
      bits.push("formwork " + f.join(" + ")); kinds.push("formwork");
    }
    if (m.excM3 > 0) { bits.push("excavation " + fmtQty(m.excM3, 1) + " m³" + (m.spoilM3 > 0 ? " (spoil " + fmtQty(m.spoilM3, 1) + " m³ loose)" : "")); kinds.push("excavation" + (m.spoilM3 > 0 ? " and spoil removal" : "")); }
    else if (m.spoilM3 > 0) { bits.push("spoil " + fmtQty(m.spoilM3, 1) + " m³ loose"); kinds.push("spoil removal"); }
    if (m.backfillM3 > 0) { bits.push("backfill " + fmtQty(m.backfillM3, 1) + " m³"); kinds.push("backfill"); }
    [...m.base.entries()].forEach(([k, v]) => { const [mat, unit] = k.split("|"); bits.push(lower1(mat) + " " + fmtQty(v, 2) + " " + (unit || "")); kinds.push(lower1(mat)); });
    if (m.vapM2 > 0) { bits.push("vapour barrier / membrane " + fmtQty(m.vapM2, 1) + " m²"); kinds.push("vapour barrier / membrane"); }
    [...m.other.entries()].slice(0, 6).forEach(([k, v]) => { const [, mat, unit] = k.split("|"); bits.push(lower1(mat) + " " + fmtQty(v, 2) + " " + (unit || "")); kinds.push(lower1(mat)); });
    return { bits: bits.map((b) => b.trim()), kinds: kinds.filter((k, i, a) => k && a.indexOf(k) === i) };
  }
  function geomBits(g) {
    const out = []; if (!g) return out;
    if (num(g.countNo) > 1) out.push(fmtQty(g.countNo, 0) + " no.");
    if (num(g.runM) > 0) out.push(fmtQty(g.runM, 1) + " lm");
    if (num(g.areaM2) > 0) out.push(fmtQty(g.areaM2, 1) + " m²");
    return out;
  }

  /**
   * The compile. `input` = { project: {name, drawingRev, specRev, revision, engineer, wasteStr, reoWastePct,
   * barLapPct, meshLapPct, formWastePct, bulkingPct}, elements: [{id, label, type, ground, nativeExc, data, lines,
   * geometry, assumed: {grade, cover}, reoRate, decisions: [{label, decision, reason}], formless, status}],
   * scope: {exclusions: [{text, doc}], others: [{title, where}]} }  →  {lines, notes}
   */
  function compileBasis(input) {
    const inp = input || {}; const P = inp.project || {}; const els = (inp.elements || []).filter(Boolean);
    const out = []; const notes = [];
    const push = (kind, id, text, extra) => { const t = str(text); if (!t) return; out.push(Object.assign({ id, kind, text: t, plain: t, sure: true }, extra || {})); };

    // ---------- what was measured ----------
    const docs = [];
    if (str(P.drawingRev)) docs.push("drawings " + str(P.drawingRev));
    if (str(P.specRev)) docs.push("specification " + str(P.specRev));
    if (str(P.engineer)) docs.push("engineer " + str(P.engineer));
    if (docs.length) push("measured", basisId("measured", "documents"), "Measured from: " + docs.join("; ") + (str(P.revision) ? " (takeoff " + str(P.revision) + ")" : "") + ".");
    const tot = { conc: new Map(), steelKg: 0, formM2: 0, formLm: 0, excM3: 0 };
    const empty = [], unreviewed = [];
    els.forEach((el) => {
      const m = elementMeasure(el); const mb = measureBits(m);
      if (el.status && el.status !== "reviewed") unreviewed.push(str(el.label));
      if (!mb.bits.length) { empty.push(str(el.label) || str(el.type)); return; }
      m.conc.forEach((v, k) => tot.conc.set(k, (tot.conc.get(k) || 0) + v));
      tot.steelKg += m.steelKg; tot.formM2 += m.formM2; tot.formLm += m.formLm; tot.excM3 += m.excM3;
      const g = geomBits(el.geometry);
      const head = elName(el);
      push("measured", basisId("measured", "element", el.id), head + " — " + (g.length ? g.join(", ") + "; " : "") + mb.bits.join("; ") + ".",
        { plain: head + " — " + mb.kinds.join(", ") + ".", elementId: el.id });
    });
    if (out.filter((l) => l.elementId).length > 1) {
      const t = [];
      const concAll = [...tot.conc.values()].reduce((s, v) => s + v, 0);
      if (concAll > 0) t.push("concrete " + fmtQty(concAll, 1) + " m³" + (tot.conc.size > 1 ? " (" + [...tot.conc.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, v]) => k.replace(/\s*concrete\s*/i, " ").trim() + " " + fmtQty(v, 1)).join(", ") + ")" : ""));
      if (tot.steelKg > 0) t.push("reinforcement " + fmtSteel(tot.steelKg));
      if (tot.formM2 > 0 || tot.formLm > 0) t.push("formwork " + [tot.formM2 > 0 ? fmtQty(tot.formM2, 0) + " m²" : "", tot.formLm > 0 ? fmtQty(tot.formLm, 0) + " lm" : ""].filter(Boolean).join(" + "));
      if (tot.excM3 > 0) t.push("excavation " + fmtQty(tot.excM3, 0) + " m³");
      if (t.length) push("measured", basisId("measured", "totals"), "Totals as measured, net — " + t.join("; ") + ".", { plain: "" });
    }
    if (empty.length) notes.push({ kind: "empty", text: "Nothing is measured yet on: " + names(empty) + " — " + (empty.length === 1 ? "it is" : "they are") + " not listed." });
    if (unreviewed.length) notes.push({ kind: "unreviewed", text: unreviewed.length + " of " + els.length + " element" + (els.length === 1 ? "" : "s") + " not marked reviewed: " + names(unreviewed) + "." });

    // ---------- assumptions ----------
    const anyLines = els.some((el) => (el.lines || []).length);
    if (anyLines) {
      const allow = [];
      if (str(P.wasteStr)) allow.push("concrete waste " + str(P.wasteStr));
      const reo = []; if (num(P.reoWastePct) > 0) reo.push(fmtQty(P.reoWastePct, 1) + "% waste"); if (num(P.barLapPct) > 0) reo.push(fmtQty(P.barLapPct, 1) + "% bar laps"); if (num(P.meshLapPct) > 0) reo.push(fmtQty(P.meshLapPct, 1) + "% mesh laps");
      if (reo.length) allow.push("reinforcement " + reo.join(", "));
      if (num(P.formWastePct) > 0) allow.push("formwork " + fmtQty(P.formWastePct, 1) + "% waste");
      push("assumption", basisId("assumption", "net"), "Quantities are net as measured from the documents" + (allow.length ? "; the price allows for ordering waste and laps on top (" + allow.join("; ") + ")." : "."));
    }
    if (num(P.bulkingPct) > 0 && els.some((el) => (el.lines || []).some((l) => l && l.materialGroup === "Excavation" && /spoil/i.test(l.material || ""))))
      push("assumption", basisId("assumption", "bulking"), "Spoil is measured loose, bulked " + fmtQty(P.bulkingPct, 1) + "% over the in-ground volume.");
    const byGrade = new Map(), byCover = new Map();
    els.forEach((el) => {
      const a = el.assumed || {}; const hasConc = (el.lines || []).some((l) => l && l.materialGroup === "Concrete");
      if (hasConc && num(a.grade) > 0) { const k = String(a.grade); byGrade.set(k, (byGrade.get(k) || []).concat(str(el.label))); }
      if (hasConc && num(a.cover) > 0) { const k = String(a.cover); byCover.set(k, (byCover.get(k) || []).concat(str(el.label))); }
    });
    byGrade.forEach((list, g) => push("assumption", basisId("assumption", "grade", g), "Concrete grade N" + g + " is assumed (the project default — not confirmed from the specification) for: " + names(list) + "."));
    byCover.forEach((list, c) => push("assumption", basisId("assumption", "cover", c), "Cover to reinforcement of " + c + " mm is assumed (default — exposure classification not confirmed) for: " + names(list) + "."));
    els.forEach((el) => {
      const d = el.data || {}; const nm = str(el.label) || str(el.type); const rr = el.reoRate;
      if (rr && rr.basis === "m3" && num(rr.rate) > 0)
        push("assumption", basisId("assumption", "reorate", el.id), nm + ": reinforcement is allowed at " + fmtQty(rr.rate, 1) + " kg per m³ of concrete" + (num(rr.kg) > 0 ? " (" + fmtSteel(num(rr.kg)) + ")" : "") + " — no bar schedule was measured.",
          { plain: nm + ": reinforcement is allowed at a rate per m³ of concrete — no bar schedule was measured.", elementId: el.id });
      else if (rr && rr.basis === "area" && (rr.rows || []).length)
        push("assumption", basisId("assumption", "reoarea", el.id), nm + ": reinforcement is allowed by area — " + (rr.rows || []).map((r) => str(r.label || r.dia) + (r.kind === "sheet" ? "" : num(r.sp) > 0 ? " @" + fmtQty(r.sp, 0) + (num(r.ways) === 1 ? " one way" : " each way") : "") + (num(r.area) > 0 ? " over " + fmtQty(r.area, 1) + " m²" : "")).join("; ") + " — no bar schedule was measured.",
          { plain: nm + ": reinforcement is allowed by area covered — no bar schedule was measured.", elementId: el.id });
      if (num(d.concVolOverride) > 0)
        push("assumption", basisId("assumption", "concvol", el.id), nm + ": concrete volume entered as " + fmtQty(d.concVolOverride, 2) + " m³ (irregular shape), not calculated from dimensions.",
          { plain: nm + ": concrete volume entered directly (irregular shape), not calculated from dimensions.", elementId: el.id });
      (el.lines || []).forEach((l) => {
        if (!l) return;
        if (l.manualOverride) {
          const what = [str(l.material), str(l.spec)].filter(Boolean).join(" — ");
          push("assumption", basisId("assumption", "override", el.id, l.overrideKey || what), nm + ": " + what + " taken as " + fmtQty(l.finalQty, 2) + " " + str(l.unit) + (num(l.calculatedQty) > 0 ? " in place of the calculated " + fmtQty(l.calculatedQty, 2) : "") + (str(l.overrideReason) ? " — " + str(l.overrideReason) : "") + ".",
            { plain: nm + ": " + what + " entered by hand in place of the calculated quantity" + (str(l.overrideReason) ? " — " + str(l.overrideReason) : "") + ".", elementId: el.id });
        } else if (/^scoped allowance/i.test(str(l.spec)) && netQty(l) > 0) {
          push("assumption", basisId("assumption", "allowance", el.id, l.material, l.unit), nm + ": an allowance is made for " + lower1(l.material) + " — " + fmtQty(netQty(l), 2) + " " + str(l.unit) + " (an estimating allowance, not a design quantity).",
            { plain: nm + ": an allowance is made for " + lower1(l.material) + " (an estimating allowance, not a design quantity).", elementId: el.id });
        }
      });
    });

    // ---------- exclusions ----------
    const excOff = [], noExc = [], noReo = [], noForm = [];
    els.forEach((el) => {
      const d = el.data || {}; const nm = str(el.label) || str(el.type); const lines = el.lines || [];
      const hasConc = lines.some((l) => l && l.materialGroup === "Concrete" && netQty(l) > 0);
      const hasExc = lines.some((l) => l && l.materialGroup === "Excavation");
      if (el.ground && el.nativeExc && d.excOn === false) excOff.push(nm);
      else if (el.ground && hasConc && !hasExc) noExc.push(nm);
      if (hasConc && !lines.some(isSteelLine)) noReo.push(nm);
      if (hasConc && !el.formless && !lines.some((l) => l && l.materialGroup === "Formwork")) noForm.push(nm);
      if (d.incStem === false && d.incBase !== false) push("exclusion", basisId("exclusion", "stem", el.id), "The wall stem of " + nm + " — the footing / base only is measured.", { elementId: el.id });
      if (d.incBase === false && d.incStem !== false) push("exclusion", basisId("exclusion", "base", el.id), "The footing / base of " + nm + " — the wall stem only is measured.", { elementId: el.id });
      (el.decisions || []).forEach((dc) => {
        if (!dc || dc.decision !== "excluded") return;
        push("exclusion", basisId("exclusion", "decision", el.id, dc.label), nm + ": " + lower1(dc.label) + (str(dc.reason) ? " — " + str(dc.reason) : "") + ".", { elementId: el.id });
      });
    });
    if (excOff.length) push("exclusion", basisId("exclusion", "excoff"), "Excavation, spoil removal and backfill to: " + names(excOff) + ".");
    const sc = inp.scope || {};
    (sc.exclusions || []).forEach((e) => { const t = str(e && e.text); if (t) push("exclusion", basisId("exclusion", "stated", t), t.replace(/[.\s]+$/, "") + (str(e.doc) ? " (as stated in " + str(e.doc) + ")" : "") + ".", { from: "scope" }); });
    (sc.others || []).forEach((o) => { const t = str(o && o.title); if (t) push("exclusion", basisId("exclusion", "others", t), t.replace(/[.\s]+$/, "") + (str(o.where) ? " (" + str(o.where) + ")" : "") + " — by others.", { from: "scope" }); });
    // inferred from what is ABSENT — never ticked on its own
    if (noExc.length) push("exclusion", basisId("exclusion", "noexc"), "Excavation and spoil removal to: " + names(noExc) + " (none measured on the takeoff).", { sure: false });
    if (noReo.length) push("exclusion", basisId("exclusion", "noreo"), "Reinforcement to: " + names(noReo) + " (none measured on the takeoff).", { sure: false });
    if (noForm.length) push("exclusion", basisId("exclusion", "noform"), "Formwork to: " + names(noForm) + " (none measured on the takeoff).", { sure: false });

    // the same id twice (two rules landing on one thing) is listed once
    const seen = {}; const lines = out.filter((l) => (seen[l.id] ? false : (seen[l.id] = true)));
    return { lines, notes };
  }

  // ---------- the estimator's document: ticks, edits, hand-typed lines ----------
  function emptyBasisDoc(takeoffId) { return { version: BASIS_DOC_VERSION, takeoffId: String(takeoffId || "default"), showQty: true, edits: {}, custom: [], removed: {}, pushed: null, updatedAt: null, updatedBy: null }; }
  function normalizeBasisDoc(raw, takeoffId) {
    const d = emptyBasisDoc(takeoffId); if (!raw || typeof raw !== "object") return d;
    d.showQty = raw.showQty !== false;
    if (raw.edits && typeof raw.edits === "object") Object.keys(raw.edits).forEach((k) => { const e = raw.edits[k]; if (e && typeof e === "object") d.edits[k] = { on: typeof e.on === "boolean" ? e.on : undefined, text: typeof e.text === "string" ? e.text : undefined, base: typeof e.base === "string" ? e.base : undefined, at: e.at || null }; });
    if (Array.isArray(raw.custom)) d.custom = raw.custom.filter((c) => c && c.id && BASIS_KINDS.some((k) => k.key === c.kind)).map((c) => ({ id: String(c.id), kind: c.kind, text: typeof c.text === "string" ? c.text : "", at: c.at || null }));
    if (raw.removed && typeof raw.removed === "object") d.removed = Object.assign({}, raw.removed);
    d.custom = d.custom.filter((c) => !d.removed[c.id]);
    d.pushed = raw.pushed && typeof raw.pushed === "object" ? raw.pushed : null;
    d.updatedAt = raw.updatedAt || null; d.updatedBy = raw.updatedBy || null;
    return d;
  }
  /** The newer tick / edit per line, hand-typed lines by id less the removed ones, the newer push record. */
  function mergeBasisDocs(a, b) {
    const A = normalizeBasisDoc(a, (a && a.takeoffId) || (b && b.takeoffId)), B = normalizeBasisDoc(b, A.takeoffId);
    const newer = (x, y) => String((x && x.at) || "") >= String((y && y.at) || "");
    const out = emptyBasisDoc(A.takeoffId);
    const aNewer = String(A.updatedAt || "") >= String(B.updatedAt || "");
    out.showQty = aNewer ? A.showQty : B.showQty;
    Object.keys(Object.assign({}, A.edits, B.edits)).forEach((k) => { const x = A.edits[k], y = B.edits[k]; out.edits[k] = !y ? x : !x ? y : newer(x, y) ? x : y; });
    out.removed = Object.assign({}, B.removed, A.removed);
    const byId = {}; B.custom.concat(A.custom).forEach((c) => { const old = byId[c.id]; if (!old || newer(c, old)) byId[c.id] = c; });
    const order = []; A.custom.concat(B.custom).forEach((c) => { if (order.indexOf(c.id) < 0) order.push(c.id); });
    out.custom = order.map((id) => byId[id]).filter((c) => c && !out.removed[c.id]);
    out.pushed = !B.pushed ? A.pushed : !A.pushed ? B.pushed : String(A.pushed.at || "") >= String(B.pushed.at || "") ? A.pushed : B.pushed;
    out.updatedAt = aNewer ? A.updatedAt : B.updatedAt; out.updatedBy = aNewer ? A.updatedBy : B.updatedBy;
    return out;
  }
  /**
   * The list the panel shows and the push sends: every compiled line with the estimator's tick and wording laid
   * over it, then the hand-typed lines. `auto` is the takeoff's own wording today (with or without quantities);
   * `stale` says the takeoff's wording moved after the line was edited by hand.
   */
  function basisLines(compiled, doc) {
    const d = normalizeBasisDoc(doc, doc && doc.takeoffId); const out = [];
    ((compiled && compiled.lines) || []).forEach((l) => {
      const auto = d.showQty ? l.text : (l.plain === "" ? "" : l.plain || l.text);
      if (!auto) return;   // a line that is nothing but quantities (the totals) is left out when quantities are off
      const e = d.edits[l.id] || {};
      const edited = typeof e.text === "string" && e.text.trim() !== "" && e.text !== auto;
      out.push({ id: l.id, kind: l.kind, text: edited ? e.text : auto, auto, on: typeof e.on === "boolean" ? e.on : l.sure !== false, sure: l.sure !== false, edited, stale: edited && typeof e.base === "string" && e.base !== l.text && e.base !== (l.plain || l.text), elementId: l.elementId || null, from: l.from || "takeoff", custom: false });
    });
    d.custom.forEach((c) => { const e = d.edits[c.id] || {}; out.push({ id: c.id, kind: c.kind, text: c.text, auto: "", on: typeof e.on === "boolean" ? e.on : true, sure: true, edited: false, stale: false, elementId: null, from: "typed", custom: true }); });
    return out;
  }
  /** One change to the document: {on}, {text, auto} (an edit; text === auto or "" puts the takeoff's wording back), {showQty}. */
  function basisEditPatch(doc, id, change, at, by) {
    const d = normalizeBasisDoc(doc, doc && doc.takeoffId); const when = at || new Date().toISOString(); const c = change || {};
    if (id == null) { if (typeof c.showQty === "boolean") d.showQty = c.showQty; if (c.pushed) d.pushed = c.pushed; }
    else {
      const custom = d.custom.find((x) => x.id === id);
      const e = Object.assign({}, d.edits[id]);
      if (typeof c.on === "boolean") e.on = c.on;
      if (typeof c.text === "string") {
        if (custom) { custom.text = c.text; custom.at = when; }
        else if (c.text.trim() === "" || c.text === c.auto) { delete e.text; delete e.base; }
        else { e.text = c.text; e.base = typeof c.auto === "string" ? c.auto : e.base; }
      }
      e.at = when; d.edits[id] = e;
    }
    d.updatedAt = when; d.updatedBy = by || d.updatedBy || null;
    return d;
  }
  function basisAddCustom(doc, kind, text, at, by) {
    const d = normalizeBasisDoc(doc, doc && doc.takeoffId); const when = at || new Date().toISOString();
    if (!BASIS_KINDS.some((k) => k.key === kind)) return d;
    const id = "bc_" + hash(kind + "|" + when + "|" + d.custom.length + "|" + Math.random());
    d.custom.push({ id, kind, text: String(text || ""), at: when });
    d.updatedAt = when; d.updatedBy = by || d.updatedBy || null;
    return d;
  }
  function basisRemoveCustom(doc, id, at, by) {
    const d = normalizeBasisDoc(doc, doc && doc.takeoffId); const when = at || new Date().toISOString();
    if (!d.custom.some((c) => c.id === id)) return d;
    d.removed[id] = when; d.custom = d.custom.filter((c) => c.id !== id); delete d.edits[id];
    d.updatedAt = when; d.updatedBy = by || d.updatedBy || null;
    return d;
  }
  function basisCounts(lines) {
    const c = { measured: 0, assumption: 0, exclusion: 0, total: 0, off: 0 };
    (lines || []).forEach((l) => { if (l.on && str(l.text)) { c[l.kind] = (c[l.kind] || 0) + 1; c.total++; } else c.off++; });
    return c;
  }
  /** What "Push to Quotes" hands over: the TICKED lines with text, in the three kinds' order. */
  function basisPayload(lines, meta) {
    const m = meta || {}; const picked = [];
    BASIS_KINDS.forEach((k) => (lines || []).forEach((l) => { if (l.kind === k.key && l.on && str(l.text)) picked.push({ id: l.id, kind: l.kind, text: str(l.text) }); }));
    return { version: 1, takeoffId: String(m.takeoffId || ""), estimateSessionId: m.estimateSessionId || null, projectName: str(m.projectName), at: m.at || new Date().toISOString(), by: m.by || null, lines: picked };
  }
  /** The ticked lines as plain text under their three headings — what "Copy" puts on the clipboard. */
  function basisText(lines) {
    const out = [];
    BASIS_KINDS.forEach((k) => { const rows = (lines || []).filter((l) => l.kind === k.key && l.on && str(l.text)); if (!rows.length) return; if (out.length) out.push(""); out.push(k.label.toUpperCase()); rows.forEach((l) => out.push("- " + str(l.text))); });
    return out.join("\n");
  }

  return {
    BASIS_DOC_PREFIX, BASIS_DOC_VERSION, BASIS_HANDOFF_KEY, BASIS_KINDS, BASIS_NAMES_MAX,
    basisDocKey, basisId, compileBasis, elementMeasure,
    emptyBasisDoc, normalizeBasisDoc, mergeBasisDocs, basisLines, basisEditPatch, basisAddCustom, basisRemoveCustom, basisCounts, basisPayload, basisText,
  };
});
