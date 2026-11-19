/* Gradcon Estimates — Scope finder: the checklist's own logic.
 *
 * PURE and DOM-free, exactly like estimates-schema.js and estimates-orders.js:
 * inlined into estimates-app.html by scripts/assemble-portal.mjs AND run in
 * plain Node by scripts/verify.mjs. The reading itself is the server's
 * (api/ai-engine.js action "scope", rules in src/lib/scopeFinder.js); this
 * file only keeps, merges, compares and counts what came back.
 *
 * One document per takeoff — `gradcon-scope::<takeoffId>` in estimator_kv
 * with a localStorage mirror under the same key, NEVER inside the takeoff
 * snapshot (the takeoff's sync rules are not touched by a tick here):
 *   { version, takeoffId, name,
 *     files:  [{id, name, url, path, size, kind: "pdf"|"image", addedAt}],
 *     notes:  [{id, name, kind: "paste"|"file"|"email", text, from?, date?, addedAt}],
 *     result: {items, gaps, exclusions, questions, documents, unreadable},
 *     runs:   [{at, by, provider, model, files, notes, items, gaps, partial?}],
 *     custom: [{id, title, category, specs, addedAt, by, fromGap?}],
 *     review: {<item / gap / custom id>: {state: "done"|"na"|"", note, by, at}},
 *     removed: {<file / note / custom id>: at},
 *     updatedAt, updatedBy }
 * A run ADDS to the checklist (`mergeScopeResult`): an item already there keeps
 * its tick (ids are stable — a hash of category and title) and gains any new
 * specification; nothing a person ticked is dropped by reading another set.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SCOPE_DOC_PREFIX = "gradcon-scope::";
  const SCOPE_DOC_VERSION = 1;
  const SCOPE_FILE_MAX_BYTES = 32 * 1024 * 1024;      // the reader's PDF limit per request
  const SCOPE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const SCOPE_TEXT_MAX_CHARS = 150000;                // mirrors SCOPE_MAX_TEXT_CHARS in src/lib/scopeFinder.js
  const SCOPE_FILES_PER_RUN = 12;                     // mirrors SCOPE_MAX_FILES
  const SCOPE_MAX_PARTS = 8;                          // one set is asked for in at most this many parts (30 items a part)

  function scopeDocKey(takeoffId) { return SCOPE_DOC_PREFIX + String(takeoffId || "draft"); }
  function emptyScopeDoc(takeoffId, name) {
    return { version: SCOPE_DOC_VERSION, takeoffId: String(takeoffId || "draft"), name: name || "", files: [], notes: [], result: null, runs: [], custom: [], review: {}, removed: {}, updatedAt: null, updatedBy: null };
  }
  function normalizeScopeDoc(d, takeoffId, name) {
    const base = emptyScopeDoc(takeoffId, name);
    if (!d || typeof d !== "object") return base;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const res = d.result && typeof d.result === "object" ? { items: arr(d.result.items), gaps: arr(d.result.gaps), exclusions: arr(d.result.exclusions), questions: arr(d.result.questions), documents: arr(d.result.documents), unreadable: arr(d.result.unreadable) } : null;
    return Object.assign(base, { name: d.name || base.name, files: arr(d.files), notes: arr(d.notes), result: res, runs: arr(d.runs), custom: arr(d.custom), review: d.review && typeof d.review === "object" ? d.review : {}, removed: d.removed && typeof d.removed === "object" ? d.removed : {}, updatedAt: d.updatedAt || null, updatedBy: d.updatedBy || null });
  }

  /** What a file dropped on the panel is: a document the reader opens by URL, text read in the browser, or refused (with why). */
  function scopeFileClass(name, type, size) {
    const n = String(name || "").toLowerCase(), t = String(type || "").toLowerCase(), s = Number(size) || 0;
    if (!s) return { kind: null, error: "the file is empty" };
    if (/\.pdf$/.test(n) || t === "application/pdf") return s > SCOPE_FILE_MAX_BYTES ? { kind: null, error: `over ${Math.round(SCOPE_FILE_MAX_BYTES / 1048576)} MB — split the PDF into smaller sets` } : { kind: "pdf" };
    if (/\.(png|jpe?g|webp|gif)$/.test(n) || /^image\/(png|jpeg|webp|gif)$/.test(t)) return s > SCOPE_IMAGE_MAX_BYTES ? { kind: null, error: `image over ${Math.round(SCOPE_IMAGE_MAX_BYTES / 1048576)} MB` } : { kind: "image" };
    if (/\.(txt|eml|md|csv|html?|json|log)$/.test(n) || /^text\//.test(t) || t === "message/rfc822") return s > 2 * 1024 * 1024 ? { kind: null, error: "text file over 2 MB" } : { kind: "text" };
    if (/\.msg$/.test(n)) return { kind: null, error: "Outlook .msg files cannot be read — save the email as PDF or .eml, or paste its text" };
    if (/\.(docx?|xlsx?|pptx?)$/.test(n)) return { kind: null, error: "Word / Excel files cannot be read directly — save as PDF, or paste the text" };
    if (/\.(dwg|dxf|rvt|ifc)$/.test(n)) return { kind: null, error: "CAD files cannot be read — export the sheets to PDF" };
    return { kind: null, error: "not a PDF, image or text file" };
  }
  /** An .eml / .html file as readable text: headers kept, tags and encoded line breaks removed. */
  function scopeTextFromFile(name, raw) {
    let s = String(raw || "");
    if (/\.html?$/i.test(String(name || "")) || /<html[\s>]/i.test(s.slice(0, 2000))) {
      s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    return s.replace(/=\r?\n/g, "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  /** The text one run sends: every note under a header naming what it is, so the reader can cite it. */
  function scopeRunText(notes) {
    return (notes || []).filter((n) => n && String(n.text || "").trim()).map((n) => {
      const head = n.kind === "email" ? `EMAIL — ${n.name || "(no subject)"}${n.from ? ` — from ${n.from}` : ""}${n.date ? ` — ${String(n.date).slice(0, 10)}` : ""}` : n.kind === "file" ? `FILE — ${n.name || "text"}` : `NOTE — ${n.name || "pasted text"}`;
      return `=== ${head} ===\n${String(n.text).trim()}`;
    }).join("\n\n");
  }

  /** A run's result folded into what the checklist already holds: known items gain new specs and keep their place; new ones are appended; gaps, exclusions, questions and documents are unioned. */
  function mergeScopeResult(prev, next) {
    if (!next) return prev || null;
    if (!prev) return next;
    const byId = new Map(); (prev.items || []).forEach((it) => byId.set(it.id, Object.assign({}, it, { specs: (it.specs || []).slice() })));
    (next.items || []).forEach((it) => {
      const old = byId.get(it.id);
      if (!old) { byId.set(it.id, it); return; }
      (it.specs || []).forEach((s) => { if (!old.specs.includes(s)) old.specs.push(s); });
      ["where", "quantity", "because", "doc", "page", "quote", "type"].forEach((k) => { if (!old[k] && it[k]) old[k] = it[k]; });
      if (old.basis === "implied" && it.basis === "stated") { old.basis = "stated"; ["doc", "page", "quote"].forEach((k) => { if (it[k]) old[k] = it[k]; }); }
      if (old.party === "unclear" && it.party !== "unclear") old.party = it.party;
    });
    const union = (a, b, key) => { const seen = new Set(); return (a || []).concat(b || []).filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
    return {
      items: Array.from(byId.values()),
      gaps: union(prev.gaps, next.gaps, (g) => g.id),
      exclusions: union(prev.exclusions, next.exclusions, (e) => e.id || e.text),
      questions: union(prev.questions, next.questions, (q) => String(q).toLowerCase()),
      documents: union(prev.documents, next.documents, (x) => String(x.name || x.title).toLowerCase()),
      unreadable: union(prev.unreadable, next.unreadable, (u) => String(u).toLowerCase()),
    };
  }

  /** Two copies of a takeoff's scope document (this browser's and the cloud's) → one. Ticks merge per item by time; lists union by id less the removals; the reading is the union of both. */
  function mergeScopeDocs(a, b) {
    if (!a) return b || null; if (!b) return a;
    const newer = String(b.updatedAt || "") > String(a.updatedAt || "") ? b : a, older = newer === a ? b : a;
    const removed = Object.assign({}, older.removed || {}, newer.removed || {});
    const unionById = (x, y) => { const m = new Map(); (x || []).concat(y || []).forEach((e) => { if (e && e.id && !removed[e.id] && !m.has(e.id)) m.set(e.id, e); }); return Array.from(m.values()); };
    const review = Object.assign({}, older.review || {});
    Object.keys(newer.review || {}).forEach((id) => { const n = newer.review[id], o = review[id]; if (!o || String(n.at || "") >= String(o.at || "")) review[id] = n; });
    const runs = (() => { const m = new Map(); (older.runs || []).concat(newer.runs || []).forEach((r) => { if (r && r.at && !m.has(r.at)) m.set(r.at, r); }); return Array.from(m.values()).sort((p, q) => String(p.at).localeCompare(String(q.at))).slice(-30); })();
    return Object.assign({}, newer, {
      files: unionById(newer.files, older.files), notes: unionById(newer.notes, older.notes), custom: unionById(newer.custom, older.custom),
      result: mergeScopeResult(older.result, newer.result), review, removed, runs,
    });
  }

  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  const STOP = new Set(["the", "and", "for", "with", "under", "over", "all", "new", "typ", "typical", "concrete", "reinforced", "level", "ground", "floor"]);
  /**
   * The checklist against the open takeoff (deterministic — nothing here is
   * the model's opinion). For every scope item that names an element type:
   * "on" with the takeoff's elements of that type, or "off" — it is in the
   * documents and not on the takeoff yet. An item with no element type (a
   * membrane, a test, an access allowance) is "na": the takeoff is not where
   * it would show. Items by others are never "off". `unmatched` are the
   * takeoff's elements no scope item accounts for.
   */
  function scopeCompareToTakeoff(items, instances, libIndex) {
    const byItem = {}; const used = new Set();
    const inst = (instances || []).map((i) => ({ id: i.id, label: i.label || "", typeKey: i.typeKey, typeLabel: (libIndex && libIndex[i.typeKey] && libIndex[i.typeKey].label) || "" }));
    (items || []).forEach((it) => {
      if (it.party === "others") { byItem[it.id] = { state: "others", instances: [] }; return; }
      let hits = it.type ? inst.filter((i) => i.typeKey === it.type) : [];
      if (!hits.length) {
        // no type, or none of that type: an element whose own name carries most of the item's words is the same thing
        const w = words(it.title);
        if (w.length) hits = inst.filter((i) => { const iw = new Set(words(i.label + " " + i.typeLabel)); const n = w.filter((x) => iw.has(x)).length; return n >= 2 && n / w.length >= 0.6; });
      }
      if (hits.length) { hits.forEach((h) => used.add(h.id)); byItem[it.id] = { state: "on", instances: hits.slice(0, 4).map((h) => ({ id: h.id, label: h.label })) }; }
      else byItem[it.id] = { state: it.type ? "off" : "na", instances: [] };
    });
    return { byItem, unmatched: inst.filter((i) => !used.has(i.id)).map((i) => ({ id: i.id, label: i.label, typeLabel: i.typeLabel })) };
  }

  /** The titles a continuation is told not to repeat — every item the checklist already holds. */
  function scopeAlreadyTitles(doc) { return (((doc && doc.result && doc.result.items) || []).map((it) => it.title)).filter(Boolean).slice(0, 400); }
  /** True while the newest read was cut off before the list was complete (a read from before the parts existed, or one that ran out of parts). */
  function scopeLastReadPartial(doc) { const runs = (doc && doc.runs) || []; const last = runs[runs.length - 1]; return !!(last && last.partial); }
  const stateOf = (doc, id) => { const r = doc && doc.review && doc.review[id]; return (r && r.state) || ""; };
  /** Every row of the checklist in one list: the read items, then the estimator's own. */
  function scopeAllItems(doc) {
    const read = (doc && doc.result && doc.result.items) || [];
    const own = ((doc && doc.custom) || []).map((c) => Object.assign({ specs: [], basis: "stated", party: "ours", custom: true }, c));
    return read.concat(own);
  }
  /** The counts on the button and the panel's tiles. A tick ("done") or "not applicable" both settle a row. */
  function scopeProgress(doc, compare) {
    const items = scopeAllItems(doc), gaps = (doc && doc.result && doc.result.gaps) || [];
    const ours = items.filter((it) => it.party !== "others");
    const settled = (id) => { const s = stateOf(doc, id); return s === "done" || s === "na"; };
    const done = ours.filter((it) => settled(it.id)).length;
    const offTakeoff = compare ? ours.filter((it) => compare.byItem[it.id] && compare.byItem[it.id].state === "off" && stateOf(doc, it.id) !== "na").length : 0;
    return { total: ours.length, done, open: ours.length - done, others: items.length - ours.length, gaps: gaps.length, gapsOpen: gaps.filter((g) => !settled(g.id)).length, highOpen: gaps.filter((g) => g.severity === "high" && !settled(g.id)).length, offTakeoff, complete: ours.length > 0 && done === ours.length && gaps.every((g) => settled(g.id)) };
  }
  /** One review write: the state (or note) with who and when; clearing both removes the entry. */
  function scopeReviewPatch(doc, id, change, by, at) {
    const review = Object.assign({}, (doc && doc.review) || {});
    const cur = Object.assign({ state: "", note: "" }, review[id] || {}, change || {});
    if (!cur.state && !String(cur.note || "").trim()) delete review[id];
    else review[id] = { state: cur.state || "", note: String(cur.note || "").slice(0, 400), by: by || null, at: at || new Date().toISOString() };
    return review;
  }
  /** The rows the chosen filter shows. */
  function scopeFilterItems(doc, compare, filter) {
    const items = scopeAllItems(doc);
    if (filter === "open") return items.filter((it) => it.party !== "others" && !stateOf(doc, it.id));
    if (filter === "off") return items.filter((it) => compare && compare.byItem[it.id] && compare.byItem[it.id].state === "off");
    if (filter === "implied") return items.filter((it) => it.basis === "implied");
    if (filter === "others") return items.filter((it) => it.party === "others" || it.party === "unclear");
    return items;
  }
  /** The checklist as CSV rows (header first) — what "Export checklist" downloads. */
  function scopeCsvRows(doc, compare, categoryLabel) {
    const rows = [["Kind", "Category", "Scope item", "Where", "Specification", "Quantity (as stated)", "Basis", "Responsibility", "Status", "Note", "On the takeoff", "Document", "Page", "Quote"]];
    const label = (s) => (s === "done" ? "Allowed for" : s === "na" ? "Not applicable" : "Open");
    scopeAllItems(doc).forEach((it) => {
      const c = compare && compare.byItem[it.id]; const r = (doc.review || {})[it.id] || {};
      rows.push([it.custom ? "Added by hand" : "Scope item", categoryLabel ? categoryLabel(it.category) : it.category, it.title, it.where || "", (it.specs || []).join("; "), it.quantity || "", it.basis === "implied" ? "Implied" : "Stated", it.party === "others" ? "By others" : it.party === "unclear" ? "Unclear" : "Ours", label(r.state), r.note || "", c ? (c.state === "on" ? c.instances.map((i) => i.label).join("; ") : c.state === "off" ? "NOT on the takeoff" : "") : "", it.doc || "", it.page || "", it.quote || ""]);
    });
    ((doc.result && doc.result.gaps) || []).forEach((g) => { const r = (doc.review || {})[g.id] || {}; rows.push(["Possibly missing", g.basis === "practice" ? "Common practice" : "From the documents", g.title, g.relatesTo || "", g.why || "", "", g.severity, "", r.state === "done" ? "Considered" : r.state === "na" ? "Not applicable" : "Open", r.note || "", "", g.doc || "", g.page || "", g.quote || ""]); });
    ((doc.result && doc.result.exclusions) || []).forEach((e) => rows.push(["Exclusion / by others", "", e.text, "", "", "", "", "By others", "", "", "", e.doc || "", e.page || "", e.quote || ""]));
    ((doc.result && doc.result.questions) || []).forEach((q) => rows.push(["Question to send", "", q, "", "", "", "", "", "", "", "", "", "", ""]));
    return rows;
  }

  return {
    SCOPE_DOC_PREFIX, SCOPE_DOC_VERSION, SCOPE_FILE_MAX_BYTES, SCOPE_IMAGE_MAX_BYTES, SCOPE_TEXT_MAX_CHARS, SCOPE_FILES_PER_RUN,
    scopeDocKey, emptyScopeDoc, normalizeScopeDoc, scopeFileClass, scopeTextFromFile, scopeRunText,
    SCOPE_MAX_PARTS, scopeAlreadyTitles, scopeLastReadPartial,
    mergeScopeResult, mergeScopeDocs, scopeCompareToTakeoff, scopeAllItems, scopeProgress, scopeReviewPatch, scopeFilterItems, scopeCsvRows,
  };
});
