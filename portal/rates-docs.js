/* Gradcon Rates Library — supplier rate documents: the page's own logic.
 *
 * PURE and DOM-free, like estimates-scope.js: inlined into rates-library.html
 * by scripts/assemble-portal.mjs AND run in plain Node by scripts/verify.mjs.
 * The READING is the server's (api/ai-engine.js action "rates", rules in
 * src/lib/rateDocs.js): it lists what a supplier's document says. Everything
 * that decides a figure is here and deterministic —
 *   rateDocLibraryRows   the library rows a document line can price (ids
 *                        `<map>::<key>`, the same ids Quotes' sync reads)
 *   proposeRateDoc       document lines → proposed row changes, each with the
 *                        arithmetic it came from and every reason it is NOT
 *                        clear (a flagged proposal starts unticked)
 *   applyRateDoc         the ticked proposals onto the library state + the
 *                        record of the document (`state.rateDocs[]`) + the
 *                        usual validity dates on the time-limited rows
 *   rateDocStatus / rateDocAlarms   which document governs which rows, and
 *                        the alarm as its validity date nears or lapses
 * Nothing is ever applied that a person did not tick.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const RATE_DOC_BUCKET_PREFIX = "rate-docs/";
  const RATE_DOC_FILES_PER_READ = 6;        // mirrors RATE_DOC_MAX_FILES
  const RATE_DOC_TEXT_MAX_CHARS = 120000;   // mirrors RATE_DOC_MAX_TEXT_CHARS
  const RATE_DOC_KEEP = 60;                 // records kept on the library
  const RATE_DOC_WARN_DAYS = 14;
  const RATE_DOC_BIG_MOVE = 0.25;           // a move over this share of the current rate is flagged
  const RATE_DOC_MAIL_QUERY = '{price pricing rates surcharge levy increase quotation "price list"} {holcim vicmix akz boral hanson concrete reinforcing steel mesh} newer_than:1y';
  const REO_MAPS = { "Trench mesh": "trenchMesh", "Square Mesh": "squareMesh", "Stock Bar": "stockBar", "Processed Bar": "processedBar" };
  const REO_MAP_NAMES = ["trenchMesh", "squareMesh", "stockBar", "processedBar"];
  /* A row whose figure is time-limited carries a "valid until" date in the library's `validity` block, keyed by the Quotes product name. */
  const VALIDITY_NAME_OF_ROW = { "global::concreteSurchargePerM3": "Production & transport surcharge" };

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const round = (v, dp) => { const f = Math.pow(10, dp); return Math.round((v + Number.EPSILON) * f) / f; };
  const money = (v, dp) => "$" + Number(v).toLocaleString("en-AU", { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
  const isoMs = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN; };
  const localDay = (d) => { const x = d ? new Date(d) : new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

  /** What a unit is counted in, so "per m3" is never laid on a "per sheet" row. */
  function unitClass(u) {
    const s = String(u || "").toLowerCase().replace(/[³]/g, "3").replace(/[²]/g, "2").trim();
    if (!s || s === "other") return null;
    if (/^m3$|cubic/.test(s)) return "m3";
    if (/^m2$|square/.test(s)) return "m2";
    if (/^(t|tonne|tonnes)$/.test(s)) return "tonne";
    if (/^sheet/.test(s)) return "sheet";
    if (/^length/.test(s)) return "length";
    if (/^(hr|hrs|hour|hours)$/.test(s)) return "hour";
    if (/^(day|days)$/.test(s)) return "day";
    if (/^(m|lm|metre|meter)$/.test(s)) return "m";
    if (/^percent|^%$/.test(s)) return "percent";
    return "count";   // each, bag, roll, unit, pack, load, truck, price …
  }
  const UNIT_WORDS = { m3: "m³", m2: "m²", tonne: "tonne", sheet: "sheet", length: "length", hour: "hour", day: "day", m: "metre", count: "item", percent: "%" };

  /** Every library row a supplier's line can price. `tables` are the page's own item lists. */
  function rateDocLibraryRows(state, tables) {
    const st = state || {}; const t = tables || {}; const rows = [];
    const reo = st.reinforcementEstablished || {};
    const push = (r) => rows.push(r);
    const plain = (map, section, items) => (items || []).forEach((it) => {
      if (!it || !it.p || it.legacy) return;
      push({ id: `${map}::${it.p}`, map, key: it.p, section, name: it.p, unit: it.u || "", current: num((st[map] || {})[it.p] && (st[map] || {})[it.p].cost) });
    });
    // Concrete
    (t.concreteGrade || []).forEach((it) => push({ id: `concreteGrade::${it.p}`, map: "concreteGrade", key: it.p, section: "Concrete", name: it.p, unit: it.u || "m3", current: num((st.concreteGrade || {})[it.p] && st.concreteGrade[it.p].cost), mix: /mpa|agg/i.test(it.p) }));
    push({ id: "global::concreteSurchargePerM3", map: "global", key: "concreteSurchargePerM3", section: "Concrete", name: "Production & transport surcharge", unit: "m3", current: num((st.global || {}).concreteSurchargePerM3) });
    push({ id: "concreteGrade::*", group: true, map: "concreteGrade", section: "Concrete", name: "Every concrete grade (an across-the-board increase)", unit: "m3", members: rows.filter((r) => r.map === "concreteGrade" && r.mix).map((r) => r.id) });
    plain("specialistConcrete", "Specialist concrete", t.specialistConcrete);
    // Reinforcement
    Object.keys(t.reinforcement || {}).forEach((group) => {
      const map = REO_MAPS[group]; if (!map) return;
      ((t.reinforcement[group] || {}).items || []).forEach((it) => push({ id: `${map}::${it.p}`, map, key: it.p, section: group, name: it.p, unit: it.u || "", weight: num(it.w), current: num((reo[map] || {})[it.p]) }));
    });
    push({ id: "stockBar::*", group: true, perTonne: true, map: "stockBar", section: "Stock Bar", name: "Stock Bar — every size, from a $/tonne stock steel rate", unit: "tonne", members: rows.filter((r) => r.map === "stockBar").map((r) => r.id) });
    push({ id: "processedBar::*", group: true, perTonne: true, map: "processedBar", section: "Processed Bar", name: "Processed Bar — every size, from a $/tonne processed steel rate", unit: "tonne", members: rows.filter((r) => r.map === "processedBar").map((r) => r.id) });
    push({ id: "global::reinforcementDeliveryPerTonne", map: "global", key: "reinforcementDeliveryPerTonne", section: "Reinforcement", name: "Reinforcing steel delivery", unit: "tonne", current: num((st.global || {}).reinforcementDeliveryPerTonne) });
    plain("reinfAcc", "Reinforcing accessories", t.reinfAcc);
    plain("otherAcc", "Other accessories", t.otherAcc);
    plain("otherAllow", "Other allowances", t.otherAllow);
    plain("formworkLegacy", "Formwork", t.formworkLegacy);
    (t.labourPlant || []).forEach((it, idx) => push({ id: `labourPlant::${idx}`, map: "labourPlant", key: String(idx), section: "Labour & plant", name: it.p, unit: it.u || "", current: num((st.labourPlant || {})[idx] && st.labourPlant[idx].cost) }));
    return rows;
  }
  const rowIndex = (rows) => { const m = new Map(); (rows || []).forEach((r) => m.set(r.id, r)); return m; };
  /** The list one read sends to the reader: ids, sections, names, units — never a price. */
  const rateDocRowsForReader = (rows) => (rows || []).map((r) => ({ id: r.id, section: r.section, name: r.name, unit: r.unit, group: !!r.group }));

  function setRowValue(state, row, value) {
    if (!state || !row || row.group) return false;
    if (REO_MAP_NAMES.includes(row.map)) { if (!state.reinforcementEstablished) state.reinforcementEstablished = {}; if (!state.reinforcementEstablished[row.map]) state.reinforcementEstablished[row.map] = {}; state.reinforcementEstablished[row.map][row.key] = value; return true; }
    if (row.map === "global") { if (!state.global) state.global = {}; state.global[row.key] = value; return true; }
    if (!state[row.map] || typeof state[row.map] !== "object") state[row.map] = {};
    const k = row.map === "labourPlant" ? Number(row.key) : row.key;
    state[row.map][k] = Object.assign({}, state[row.map][k] || {}, { cost: value });
    return true;
  }

  /* ---------- a line → the row(s) it prices, by rule before by the reader's word ---------- */
  function trenchRowFor(line, rows) {
    const d = String(line.description || "");
    let size = null, bars = line.bars || null;
    const c = /^L(\d{1,2})TM$/i.exec(String(line.code || "")); if (c) size = c[1];
    if (!size) { const m = /\bL\s?(\d{1,2})\s?TM\b/i.exec(d) || /(\d{1,2})\s*mm\s*(?:wire\s*)?trench\s*mesh/i.exec(d); if (m) size = m[1]; }
    if (!bars) { const m = /(\d)\s*[- ]?bar\b/i.exec(d); if (m) bars = +m[1]; }
    if (!size || !bars) return null;
    const re = new RegExp(`^${bars}\\s*bar-L${size}TM$`, "i");
    const hit = (rows || []).find((r) => r.map === "trenchMesh" && re.test(r.name));
    return { id: hit ? hit.id : null, label: `${bars} bar L${size}TM` };
  }
  function sheetRowFor(line, rows) {
    const d = String(line.description || "");
    const m = /^(SL|RL)\s?(\d{2,4})$/i.exec(String(line.code || "")) || /\b(SL|RL)\s?(\d{2,4})\b/i.exec(d);
    if (!m) return null;
    const name = (m[1] + m[2]).toUpperCase();
    const hit = (rows || []).find((r) => r.map === "squareMesh" && r.name.toUpperCase() === name);
    return { id: hit ? hit.id : null, label: name };
  }
  /** `{ids, why}` when a rule names the row, `{ids: [], missing}` when the rule knows the product and the library has no row for it, null when no rule applies. */
  function ruleRowsFor(line, rows) {
    const d = String(line.description || "");
    if (line.kind === "trench_mesh" || /trench\s*mesh/i.test(d)) { const t = trenchRowFor(line, rows); if (t) return t.id ? { ids: [t.id], why: "by its code" } : { ids: [], missing: `The library has no trench mesh row for ${t.label}` }; }
    if (line.kind === "sheet_mesh" || /\b(SL|RL)\s?\d{2,4}\b/i.test(d)) { const s = sheetRowFor(line, rows); if (s) return s.id ? { ids: [s.id], why: "by its code" } : { ids: [], missing: `The library has no mesh sheet row for ${s.label}` }; }
    if (line.mode === "price") {
      if (line.kind === "stock_steel" || /^\s*stock\s+(steel|bar)/i.test(d)) return { ids: ["stockBar::*"], why: "a stock steel rate" };
      if (line.kind === "processed_steel" || /^\s*processed\s+(steel|bar)|cut\s*(&|and)\s*bent/i.test(d)) return { ids: ["processedBar::*"], why: "a processed steel rate" };
    }
    return null;
  }
  const KIND_UNIT = { sheet_mesh: "sheet", trench_mesh: "length", stock_steel: "tonne", processed_steel: "tonne" };

  /**
   * One document's lines → `{proposals, unmapped, warnings}`.
   * opts: {today: "YYYY-MM-DD", overrides: {<line index>: rowId | ""}} — an
   * override is the estimator pointing a line at a row by hand ("" = at none).
   */
  function proposeRateDoc(doc, rows, state, opts) {
    const o = opts || {}; const idx = rowIndex(rows); const overrides = o.overrides || {};
    const today = o.today || localDay();
    const d = doc || {}; const proposals = []; const unmapped = []; const warnings = [];
    const notYet = d.validFrom && isoMs(d.validFrom) > isoMs(today);
    if (!d.validUntil) warnings.push("No validity date is stated on this document — its rates stand until the next rate update. Enter a date if the supplier gave one.");
    if (notYet) warnings.push(`These prices take effect on ${d.validFrom} — apply them on or after that day.`);
    if (d.gst === "inc") warnings.push("The document states its prices INCLUDING GST. The library is ex GST, so each figure is shown ÷ 1.1 and left for you to tick.");
    if (d.gst === "unknown") warnings.push("The document does not say whether its prices include GST — check before ticking.");
    const usedRows = new Set();
    (d.lines || []).forEach((l) => {
      const base = { docN: d.n, line: l.i, description: l.description, price: l.price, per: l.per, mode: l.mode, page: l.page || null, quote: l.quote || null };
      if (l.price == null || !(Math.abs(l.price) > 0)) { unmapped.push(Object.assign({ reason: "No price could be read on this line" }, base)); return; }
      const hand = Object.prototype.hasOwnProperty.call(overrides, l.i);
      const rule = hand ? null : ruleRowsFor(l, rows);
      let ids = hand ? (overrides[l.i] ? [overrides[l.i]] : []) : rule ? rule.ids : l.target ? [l.target] : [];
      ids = ids.filter((id) => idx.has(id));
      if (!ids.length) {
        const reason = hand ? "Left out by you" : rule && rule.missing ? rule.missing : l.targetRefused ? `The reader named a row the library does not have (${l.targetRefused})` : l.unclear ? `Not clear: ${l.unclear}` : "No library row is the same product on the same unit";
        unmapped.push(Object.assign({ reason, unclear: l.unclear || null }, base)); return;
      }
      const lineFlags = [];
      if (l.unclear) lineFlags.push(`Reader: ${l.unclear}`);
      if (!hand && !rule && l.confidence !== "high") lineFlags.push("The reader was not certain this is the row");
      if (d.gst === "inc") lineFlags.push("Stated including GST — shown ex GST (÷ 1.1)");
      if (d.gst === "unknown") lineFlags.push("GST basis not stated");
      if (notYet) lineFlags.push(`Takes effect ${d.validFrom} — not yet`);
      const gstDiv = d.gst === "inc" && l.mode !== "increase_percent" ? 1.1 : 1;
      const perClass = unitClass(l.per) || KIND_UNIT[l.kind] || null;
      ids.forEach((id) => {
        const target = idx.get(id);
        const members = target.group ? (target.members || []).map((m) => idx.get(m)).filter(Boolean) : [target];
        const flags = lineFlags.slice();
        if (target.group && target.perTonne && l.mode === "price") {
          if (perClass && perClass !== "tonne") flags.push(`Priced per ${UNIT_WORDS[perClass] || l.per}; a steel rate for the whole table is per tonne`);
          if (!unitClass(l.per)) flags.push("__assumed_tonne__");
        } else if (l.mode === "price") {
          const rowClass = unitClass(target.unit);
          if (!perClass) flags.push(`The document does not state the unit — the library row is per ${UNIT_WORDS[rowClass] || target.unit}`);
          else if (rowClass && perClass !== rowClass) flags.push(`Priced per ${UNIT_WORDS[perClass] || l.per}; the library row is per ${UNIT_WORDS[rowClass] || target.unit}`);
        }
        members.forEach((r) => {
          const dp = r.map === "processedBar" ? 4 : 2;
          const from = num(r.current);
          let to = null, basis = "";
          if (l.mode === "increase_percent") {
            if (from == null) { unmapped.push(Object.assign({ reason: `${r.name} has no current rate to increase` }, base)); return; }
            to = round(from * (1 + l.price / 100), dp); basis = `${money(from, dp)} + ${l.price}%`;
          } else if (l.mode === "increase_amount") {
            if (from == null) { unmapped.push(Object.assign({ reason: `${r.name} has no current rate to increase` }, base)); return; }
            to = round(from + l.price / gstDiv, dp); basis = `${money(from, dp)} + ${money(l.price / gstDiv)}`;
          } else if (target.group && target.perTonne) {
            if (!(r.weight > 0)) { unmapped.push(Object.assign({ reason: `${r.name} has no weight to convert a $/tonne rate by` }, base)); return; }
            to = round((l.price / gstDiv) * r.weight / 1000, dp); basis = `${money(l.price / gstDiv)}/t × ${r.weight} kg`;
          } else { to = round(l.price / gstDiv, dp); basis = gstDiv > 1 ? `${money(l.price)} ÷ 1.1` : ""; }
          if (!(to > 0)) { unmapped.push(Object.assign({ reason: "The figure works out to nothing" }, base)); return; }
          const f = flags.filter((x) => x !== "__assumed_tonne__");
          const assumedTonne = flags.includes("__assumed_tonne__");
          if (l.mode !== "price") f.push(`Worked out from a stated increase of ${l.mode === "increase_percent" ? l.price + "%" : money(l.price)}`);
          const move = from != null && from > 0 ? (to - from) / from : null;
          if (move != null && Math.abs(move) > RATE_DOC_BIG_MOVE) f.push(`Moves ${move > 0 ? "+" : "−"}${Math.abs(Math.round(move * 100))}% from the current rate`);
          // a unit the document leaves unstated on a whole-table steel rate is read as $/tonne — said on the row, and flagged only when the figure then looks wrong
          if (assumedTonne) { if (move == null || Math.abs(move) > RATE_DOC_BIG_MOVE) f.push("No unit is stated — read as $ per tonne"); else basis += " (no unit stated — read as $/tonne)"; }
          if (usedRows.has(r.id)) f.push("Another line of this document also prices this row");
          usedRows.add(r.id);
          const tol = dp === 4 ? 0.00005 : 0.005;
          proposals.push(Object.assign({}, base, {
            pid: `${d.n}:${l.i}:${r.id}`, rowId: r.id, section: r.section, name: r.name, unit: r.unit,
            from, to, basis: basis.trim(), flags: f, byHand: hand, same: from != null && Math.abs(to - from) < tol, move,
          }));
        });
      });
    });
    return { proposals, unmapped, warnings };
  }
  /** Ticked unless a person said otherwise: a proposal with nothing flagged starts ticked, a flagged one does not. */
  const proposalTicked = (p, ticks) => (ticks && Object.prototype.hasOwnProperty.call(ticks, p.pid) ? !!ticks[p.pid] : p.flags.length === 0);

  /**
   * Writes the ticked proposals onto the library state and records the
   * document. `meta`: {id, at, by, source, validUntil, keepOlder, tables.validityNames}.
   * Returns the record. A row ticked twice takes the LAST proposal.
   */
  function applyRateDoc(state, doc, rows, picked, meta) {
    const m = meta || {}; const idx = rowIndex(rows); const d = doc || {};
    const at = m.at || new Date().toISOString();
    const applied = [];
    (picked || []).forEach((p) => {
      const row = idx.get(p.rowId); if (!row || !(p.to > 0)) return;
      if (!setRowValue(state, row, p.to)) return;
      const prev = applied.findIndex((a) => a.id === row.id); if (prev >= 0) applied.splice(prev, 1);
      applied.push({ id: row.id, name: row.name, section: row.section, unit: row.unit, from: p.from == null ? null : p.from, to: p.to });
    });
    const validUntil = m.validUntil !== undefined ? (m.validUntil || null) : d.validUntil || null;
    // validity as usual: a time-limited row takes the document's date in the library's `validity` block
    if (validUntil) {
      const names = new Set(m.validityNames || []);
      if (!state.validity || typeof state.validity !== "object") state.validity = {};
      applied.forEach((a) => {
        const row = idx.get(a.id);
        const name = VALIDITY_NAME_OF_ROW[a.id] || (row && names.has(row.key) ? row.key : null);
        if (name) state.validity[name] = validUntil;
      });
    }
    const record = {
      id: m.id || "rd_" + Date.parse(at).toString(36) + Math.random().toString(36).slice(2, 6),
      supplier: d.supplier || "Supplier", reference: d.reference || null, issued: d.issued || null, validFrom: d.validFrom || null,
      validUntil, validityQuote: d.validityQuote || null, gst: d.gst || "unknown",
      source: m.source || (d.source ? { kind: "file", name: d.source } : null),
      appliedAt: at, by: m.by || null,
      // work that existed before this day keeps the figures it was priced on (Quotes reads these two)
      keepOlder: m.keepOlder !== false, keepBefore: m.keepBefore || localDay(at),
      rows: applied,
      notApplied: (m.notApplied || []).slice(0, 80).map((u) => ({ description: u.description, price: u.price == null ? null : u.price, per: u.per || "", reason: u.reason || "" })),
      notes: (d.notes || []).slice(0, 30),
    };
    const list = Array.isArray(state.rateDocs) ? state.rateDocs.slice() : [];
    list.push(record);
    state.rateDocs = list.length > RATE_DOC_KEEP ? list.slice(list.length - RATE_DOC_KEEP) : list;
    return record;
  }

  /** rowId → the document that last set it. */
  function rateDocLatestByRow(state) {
    const docs = state && Array.isArray(state.rateDocs) ? state.rateDocs : [];
    const latest = new Map();
    docs.slice().sort((a, b) => String(a.appliedAt || "").localeCompare(String(b.appliedAt || ""))).forEach((d) => (d.rows || []).forEach((r) => latest.set(r.id, d.id)));
    return latest;
  }
  /** Every recorded document, newest first, with how many of its rows it still governs and where its validity stands. */
  function rateDocStatus(state, today, warnDays) {
    const docs = state && Array.isArray(state.rateDocs) ? state.rateDocs : [];
    const latest = rateDocLatestByRow(state);
    const t = today ? new Date(today) : new Date(); t.setHours(0, 0, 0, 0);
    const warn = warnDays == null ? RATE_DOC_WARN_DAYS : warnDays;
    return docs.map((d) => {
      const current = (d.rows || []).filter((r) => latest.get(r.id) === d.id).length;
      const ms = isoMs(d.validUntil);
      const daysLeft = Number.isFinite(ms) ? Math.round((ms - t.getTime()) / 86400000) : null;
      const st = !current ? "superseded" : daysLeft == null ? "open" : daysLeft < 0 ? "expired" : daysLeft <= warn ? "expiring" : "ok";
      return Object.assign({}, d, { current, daysLeft, state: st });
    }).sort((a, b) => String(b.appliedAt || "").localeCompare(String(a.appliedAt || "")));
  }
  /** The documents to raise an alarm for — the same answer as supplierDocAlarms in src/lib/rateDocs.js. */
  function rateDocAlarms(state, today, warnDays) {
    return rateDocStatus(state, today, warnDays).filter((d) => d.state === "expired" || d.state === "expiring")
      .map((d) => ({ id: d.id, supplier: d.supplier || "Supplier", reference: d.reference || "", validUntil: d.validUntil, daysLeft: d.daysLeft, state: d.state, rows: d.current }))
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }
  function rateDocSetValidity(state, id, validUntil, validityNames, rows) {
    const d = (state.rateDocs || []).find((x) => x.id === id); if (!d) return false;
    d.validUntil = validUntil || null;
    if (validUntil) {
      const idx = rowIndex(rows || []); const names = new Set(validityNames || []); const latest = rateDocLatestByRow(state);
      if (!state.validity || typeof state.validity !== "object") state.validity = {};
      (d.rows || []).forEach((a) => { if (latest.get(a.id) !== d.id) return; const row = idx.get(a.id); const name = VALIDITY_NAME_OF_ROW[a.id] || (row && names.has(row.key) ? row.key : null); if (name) state.validity[name] = validUntil; });
    }
    return true;
  }

  /* ---------- sources ---------- */
  function rateDocFileClass(name, type, size) {
    const n = String(name || "").toLowerCase(); const t = String(type || "").toLowerCase();
    if (!(size > 0)) return { kind: null, error: `${name}: the file is empty.` };
    if (/\.pdf$/.test(n) || t === "application/pdf") return size > 32 * 1024 * 1024 ? { kind: null, error: `${name}: over 32 MB — the reader takes PDFs up to 32 MB.` } : { kind: "pdf" };
    if (/\.(png|jpe?g|webp|gif)$/.test(n) || /^image\/(png|jpeg|webp|gif)$/.test(t)) return size > 5 * 1024 * 1024 ? { kind: null, error: `${name}: over 5 MB — save the picture smaller, or upload the PDF.` } : { kind: "image" };
    if (/\.(eml|txt|html?|csv)$/.test(n) || /^text\//.test(t) || t === "message/rfc822") return { kind: "text" };
    if (/\.msg$/.test(n)) return { kind: null, error: `${name}: Outlook .msg files cannot be read — pick the email from the mailbox list instead, or paste its text.` };
    if (/\.(xlsx?|docx?)$/.test(n)) return { kind: null, error: `${name}: save it as a PDF first, or paste the rates as text.` };
    return { kind: null, error: `${name}: not a PDF, a picture or a text file.` };
  }
  function rateDocTextOf(raw) {
    let s = String(raw || "");
    if (/<(html|body|div|p|br|table)\b/i.test(s)) s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  /** Every text source under a header naming it, so the reader can say which email a rate came from. */
  function rateDocRunText(notes) {
    return (notes || []).filter((n) => n && String(n.text || "").trim()).map((n) => {
      const head = n.kind === "email" ? `EMAIL — ${n.name || "(no subject)"}${n.from ? ` — from ${n.from}` : ""}${n.date ? ` — ${String(n.date).slice(0, 10)}` : ""}` : n.kind === "file" ? `FILE — ${n.name}` : `NOTE — ${n.name || "pasted text"}`;
      return `=== ${head} ===\n${String(n.text).trim()}`;
    }).join("\n\n");
  }
  /** The message ids already used by an applied document — the mailbox list marks them. */
  function rateDocUsedMailIds(state) {
    const out = new Set();
    ((state && state.rateDocs) || []).forEach((d) => ((d.source && d.source.mailIds) || []).forEach((id) => out.add(id)));
    return out;
  }

  return {
    RATE_DOC_BUCKET_PREFIX, RATE_DOC_FILES_PER_READ, RATE_DOC_TEXT_MAX_CHARS, RATE_DOC_KEEP, RATE_DOC_WARN_DAYS, RATE_DOC_BIG_MOVE, RATE_DOC_MAIL_QUERY, VALIDITY_NAME_OF_ROW,
    unitClass, rateDocLibraryRows, rateDocRowsForReader, setRowValue, ruleRowsFor, proposeRateDoc, proposalTicked, applyRateDoc,
    rateDocLatestByRow, rateDocStatus, rateDocAlarms, rateDocSetValidity, rateDocFileClass, rateDocTextOf, rateDocRunText, rateDocUsedMailIds, rateDocLocalDay: localDay,
  };
});
