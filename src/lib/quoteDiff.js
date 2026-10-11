/**
 * What changed between two copies of a project — pure, no React, no DOM.
 *
 * Grady, 11 Oct 2026: "i want to monitor what Grady will input so we can
 * collect data for future projects. check for 145 Harrisons road and see
 * changes." The portal already keeps an immutable version of every quote and
 * every takeoff on each save (lib/quoteVersions.js, Estimates'
 * keepEstimateVersion), so the history exists; what was missing was a reader.
 * This module is that reader: it takes two quotes (or two takeoff snapshots)
 * and returns a STRUCTURED diff — project fields, elements added / removed /
 * changed, each changed element's quantities, rate overrides, crew cells,
 * additional rows and labels, with the element's total before and after and
 * the money each catalog band moved — plus the handover drift (what the
 * handover prefilled against what the crew sheet holds now: the data set
 * future projects' bands are tuned from).
 *
 * The Gradcon AI chat's history tools (api/_versions.js) and the verify
 * suite are the callers. Costs are computed through computeElementCost —
 * never recomputed here — with `effectiveRates(after, liveRates)`, so a
 * pinned project is priced on its pinned copy, exactly as the editor does.
 */
import { computeElementCost, defaultRates, rateKey } from "./costing.js";
import { effectiveRates } from "./rateFreeze.js";
import { RESOURCE_COLS } from "../data/catalog.js";

const blank = (v) => v === undefined || v === null || v === "";
/** Blank → null, numeric strings → numbers, everything else as is. */
export function normValue(v) {
  if (blank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const t = v.trim(); if (t !== "" && Number.isFinite(Number(t))) return Number(t); return t; }
  return v;
}
const same = (a, b) => { const x = normValue(a), y = normValue(b); if (x === y) return true; if (typeof x === "object" || typeof y === "object") return JSON.stringify(x) === JSON.stringify(y); return false; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const PRODUCT = (key) => { const p = String(key || "").split("::"); return { category: p[0] || "", product: p[1] || key, unit: p[2] || "" }; };
const RESOURCE_NAME = (key) => { const r = RESOURCE_COLS.find((c) => c.key === key); return r ? r.name : key; };

/** Top-level quote fields that are compared one by one (anything else scalar is compared too, these are just named first). */
export const PROJECT_FIELDS = ["projectName", "clientName", "status", "scope", "gfa", "projectDate", "overheadPct", "contingencyPct", "marginPct", "submittedAt", "completedAt", "notes", "address"];
const SKIP_TOP = new Set(["items", "ratesFrozen", "handover", "planner", "assumptions", "importFlags", "externalQuote", "tenderQuote", "versions"]);

function scalarDiff(a, b, prefix, out, named) {
  const keys = new Set([...(named || []), ...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach((k) => {
    if (SKIP_TOP.has(k) && !prefix) return;
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if (x && typeof x === "object" && !Array.isArray(x)) return; // nested objects handled by their own rule
    if (y && typeof y === "object" && !Array.isArray(y)) return;
    if (Array.isArray(x) || Array.isArray(y)) { if (JSON.stringify(x || []) !== JSON.stringify(y || [])) out.push({ field: prefix + k, from: Array.isArray(x) ? x.length : null, to: Array.isArray(y) ? y.length : null, note: "count" }); return; }
    if (!same(x, y)) out.push({ field: prefix + k, from: normValue(x), to: normValue(y) });
  });
}

/** Project-level changes: named fields, planner fields, assumptions, rates pin, handover. */
export function diffProjectFields(before, after) {
  const out = [];
  const a = before || {}, b = after || {};
  scalarDiff(a, b, "", out, PROJECT_FIELDS);
  scalarDiff(a.planner || {}, b.planner || {}, "planner.", out);
  const la = Array.isArray(a.assumptions) ? a.assumptions.map((x) => (typeof x === "string" ? x : x && x.text) || "").filter(Boolean) : [];
  const lb = Array.isArray(b.assumptions) ? b.assumptions.map((x) => (typeof x === "string" ? x : x && x.text) || "").filter(Boolean) : [];
  lb.filter((t) => !la.includes(t)).forEach((t) => out.push({ field: "assumption", from: null, to: t }));
  la.filter((t) => !lb.includes(t)).forEach((t) => out.push({ field: "assumption", from: t, to: null }));
  const pa = a.ratesFrozen && a.ratesFrozen.at, pb = b.ratesFrozen && b.ratesFrozen.at;
  if (pa !== pb) out.push({ field: "ratesPinned", from: pa || null, to: pb || null });
  const ha = a.handover && a.handover.at, hb = b.handover && b.handover.at;
  if (ha !== hb) out.push({ field: "handoverPrefilled", from: ha || null, to: hb || null });
  if ((a.handover && a.handover.undoneAt) !== (b.handover && b.handover.undoneAt)) out.push({ field: "handoverUndone", from: (a.handover && a.handover.undoneAt) || null, to: (b.handover && b.handover.undoneAt) || null });
  ["externalQuote", "tenderQuote"].forEach((k) => { if (JSON.stringify(a[k] || null) !== JSON.stringify(b[k] || null)) out.push({ field: k, from: a[k] ? "edited" : null, to: b[k] ? "edited" : null, note: "report changed" }); });
  return out;
}

const ELEMENT_FIELDS = ["label", "typeId", "category", "section", "scope", "description", "steelMode", "labourAuto", "measureNo", "measureLm", "measureM2", "onCostOverheadPct", "onCostContingencyPct"];
const SKIP_ELEMENT = new Set(["id", "collapsed", "markups", "qtys", "tasks", "additional", "rateOverrides", "labourVer", "labourQtys"]);

/** One element against its earlier copy: field, quantity, override, crew, additional-row and drawing changes. */
export function diffElement(before, after) {
  const changes = [];
  const a = before || {}, b = after || {};
  const fields = new Set([...ELEMENT_FIELDS, ...Object.keys(a), ...Object.keys(b)]);
  fields.forEach((k) => {
    if (SKIP_ELEMENT.has(k)) return;
    const x = a[k], y = b[k];
    if ((x && typeof x === "object") || (y && typeof y === "object")) return;
    if (!same(x, y)) changes.push({ kind: "field", field: k, from: normValue(x), to: normValue(y) });
  });
  const qa = a.qtys || {}, qb = b.qtys || {};
  new Set([...Object.keys(qa), ...Object.keys(qb)]).forEach((key) => { if (!same(qa[key], qb[key])) changes.push({ kind: "qty", key, ...PRODUCT(key), from: normValue(qa[key]), to: normValue(qb[key]) }); });
  const oa = a.rateOverrides || {}, ob = b.rateOverrides || {};
  new Set([...Object.keys(oa), ...Object.keys(ob)]).forEach((key) => {
    const x = oa[key] && oa[key].unitCost, y = ob[key] && ob[key].unitCost;
    if (!same(x, y)) changes.push({ kind: "rateOverride", key, ...PRODUCT(key), from: normValue(x), to: normValue(y) });
  });
  const ta = a.tasks || [], tb = b.tasks || [];
  tb.forEach((t) => {
    const prev = ta.find((p) => p.id === t.id);
    if (!prev) { Object.keys(t.qtys || {}).forEach((rk) => { if (!blank(t.qtys[rk])) changes.push({ kind: "crew", task: t.name, resource: RESOURCE_NAME(rk), resourceKey: rk, from: null, to: normValue(t.qtys[rk]), note: "row added" }); }); return; }
    if (!same(prev.name, t.name)) changes.push({ kind: "taskName", from: prev.name, to: t.name });
    if ((prev.crewMode || "person") !== (t.crewMode || "person")) changes.push({ kind: "field", field: `crewMode (${t.name})`, from: prev.crewMode || "person", to: t.crewMode || "person" });
    const ka = prev.qtys || {}, kb = t.qtys || {};
    new Set([...Object.keys(ka), ...Object.keys(kb)]).forEach((rk) => { if (!same(ka[rk], kb[rk])) changes.push({ kind: "crew", task: t.name, resource: RESOURCE_NAME(rk), resourceKey: rk, from: normValue(ka[rk]), to: normValue(kb[rk]) }); });
  });
  ta.forEach((t) => { if (!tb.find((p) => p.id === t.id)) changes.push({ kind: "taskRemoved", task: t.name }); });
  const aa = a.additional || [], ab = b.additional || [];
  ab.forEach((r) => {
    const prev = aa.find((p) => p.id === r.id);
    if (!prev) { changes.push({ kind: "additional", name: r.name, from: null, to: { qty: normValue(r.qty), rate: normValue(r.rate), unit: r.unit || null }, category: r.cat || null }); return; }
    if (!same(prev.name, r.name) || !same(prev.qty, r.qty) || !same(prev.rate, r.rate) || !same(prev.unit, r.unit)) changes.push({ kind: "additional", name: r.name, from: { name: prev.name, qty: normValue(prev.qty), rate: normValue(prev.rate), unit: prev.unit || null }, to: { qty: normValue(r.qty), rate: normValue(r.rate), unit: r.unit || null }, category: r.cat || null });
  });
  aa.forEach((r) => { if (!ab.find((p) => p.id === r.id)) changes.push({ kind: "additional", name: r.name, from: { qty: normValue(r.qty), rate: normValue(r.rate), unit: r.unit || null }, to: null, category: r.cat || null }); });
  const ma = (a.markups || []).length, mb = (b.markups || []).length;
  if (ma !== mb) changes.push({ kind: "field", field: "markups", from: ma, to: mb, note: "drawing count" });
  return changes;
}

const costOf = (item, rates, scope) => { try { return computeElementCost(item, rates, scope); } catch { return null; } };

/**
 * The whole diff. `liveRates` is the shared rates row (the after quote's
 * pinned copy is laid over it); defaults to the catalog when none is given.
 * Returns { project, elements: {added, removed, changed}, totals, counts }.
 */
export function diffQuotes(before, after, liveRates) {
  const a = before || { items: [] }, b = after || { items: [] };
  const rates = effectiveRates(b, liveRates || defaultRates());
  const ia = Array.isArray(a.items) ? a.items : [], ib = Array.isArray(b.items) ? b.items : [];
  const scopeA = a.scope || "both", scopeB = b.scope || "both";
  const added = [], removed = [], changed = [];
  let totalFrom = 0, totalTo = 0;
  const idsB = new Set(ib.map((i) => i.id)), idsA = new Set(ia.map((i) => i.id));
  const commonA = ia.filter((i) => idsB.has(i.id)).map((i) => i.id), commonB = ib.filter((i) => idsA.has(i.id)).map((i) => i.id);
  ia.forEach((it) => { const c = costOf(it, rates, scopeA); totalFrom += c ? c.total : 0; });
  ib.forEach((it) => { const c = costOf(it, rates, scopeB); totalTo += c ? c.total : 0; });
  ib.forEach((it, idx) => {
    const prev = ia.find((p) => p.id === it.id);
    const c = costOf(it, rates, scopeB);
    if (!prev) { added.push({ id: it.id, label: it.label, type: it.typeId, position: idx + 1, total: c ? round2(c.total) : null }); return; }
    const changes = diffElement(prev, it);
    const cp = costOf(prev, rates, scopeA);
    const bands = {};
    const cats = new Set([...Object.keys((cp && cp.categoryTotals) || {}), ...Object.keys((c && c.categoryTotals) || {})]);
    cats.forEach((cat) => { const x = round2(cp && cp.categoryTotals[cat]), y = round2(c && c.categoryTotals[cat]); if (x !== y) bands[cat] = { from: x, to: y }; });
    const lab = { from: round2(cp && cp.labourTotal), to: round2(c && c.labourTotal) };
    if (lab.from !== lab.to) bands["LABOUR (crew sheet)"] = lab;
    // a move is a change of order among the elements BOTH copies hold — an element added above shifts positions, it does not move anything
    const posA = commonA.indexOf(it.id), posB = commonB.indexOf(it.id);
    if (!changes.length && !Object.keys(bands).length && posA === posB) return;
    changed.push({ id: it.id, label: it.label, type: it.typeId, totalFrom: cp ? round2(cp.total) : null, totalTo: c ? round2(c.total) : null, moved: posA !== posB ? { from: posA + 1, to: posB + 1 } : null, changes, bands });
  });
  ia.forEach((it, idx) => { if (!ib.find((p) => p.id === it.id)) { const c = costOf(it, rates, scopeA); removed.push({ id: it.id, label: it.label, type: it.typeId, position: idx + 1, total: c ? round2(c.total) : null }); } });
  const project = diffProjectFields(a, b);
  const counts = { project: project.length, added: added.length, removed: removed.length, changed: changed.length, cells: changed.reduce((s, e) => s + e.changes.length, 0) };
  return { project, elements: { added, removed, changed }, totals: { from: round2(totalFrom), to: round2(totalTo), delta: round2(totalTo - totalFrom) }, counts, any: counts.project + counts.added + counts.removed + counts.changed > 0 };
}

/**
 * The handover's prefilled figures against what the crew sheet holds NOW —
 * kept, changed (to what) or cleared. This is the record future bands are
 * tuned from: every "changed" row is Grady correcting the model.
 */
export function handoverDrift(quote) {
  const h = quote && quote.handover;
  if (!h) return { prefilled: false, entries: [], summary: { kept: 0, changed: 0, cleared: 0 } };
  const items = Array.isArray(quote.items) ? quote.items : [];
  const entries = [];
  const status = (pre, now) => (blank(now) ? "cleared" : same(pre, now) ? "kept" : "changed");
  (h.cells || []).forEach((c) => {
    const it = items.find((i) => i.id === c.itemId); const t = it && (it.tasks || []).find((x) => x.id === c.taskId);
    const now = t ? (t.qtys || {})[c.key] : undefined;
    entries.push({ element: it ? it.label : c.itemId, elementId: c.itemId, task: t ? t.name : "(row gone)", resource: RESOURCE_NAME(c.key), resourceKey: c.key, prefilled: normValue(c.value), now: normValue(now), status: t ? status(c.value, now) : "cleared" });
  });
  (h.rows || []).forEach((r) => {
    const it = items.find((i) => i.id === r.itemId); const t = it && (it.tasks || []).find((x) => x.id === r.taskId);
    const now = t ? (t.qtys || {})[r.key] : undefined;
    entries.push({ element: it ? it.label : r.itemId, elementId: r.itemId, task: t ? t.name : "(row gone)", renamedTo: r.to, resource: RESOURCE_NAME(r.key), resourceKey: r.key, prefilled: normValue(r.value), now: normValue(now), status: t ? status(r.value, now) : "cleared", renamed: t && t.name !== r.to ? t.name : null });
  });
  (h.qtys || []).forEach((q) => {
    const it = items.find((i) => i.id === q.itemId);
    const now = it ? (it.qtys || {})[q.key] : undefined;
    entries.push({ element: it ? it.label : q.itemId, elementId: q.itemId, task: null, product: PRODUCT(q.key).product, resourceKey: q.key, prefilled: normValue(q.value), now: normValue(now), status: it ? status(q.value, now) : "cleared" });
  });
  const summary = { kept: 0, changed: 0, cleared: 0 };
  entries.forEach((e) => { summary[e.status] = (summary[e.status] || 0) + 1; });
  return { prefilled: true, at: h.at || null, undoneAt: h.undoneAt || null, steelModes: (h.steel || []).map((s) => ({ elementId: s.itemId, mode: s.mode })), entries, summary };
}

/* ---------------- Estimates takeoffs ---------------- */

const TK_SKIP = new Set(["results", "entered", "_collapsed"]);
function instanceDataDiff(a, b) {
  const out = [];
  const da = (a && a.data) || {}, db = (b && b.data) || {};
  new Set([...Object.keys(da), ...Object.keys(db)]).forEach((k) => {
    if (k.startsWith("_") || k.startsWith("__")) return;
    const x = da[k], y = db[k];
    if ((x && typeof x === "object") || (y && typeof y === "object")) { if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) out.push({ kind: "data", field: k, from: Array.isArray(x) ? `${x.length} rows` : x == null ? null : "…", to: Array.isArray(y) ? `${y.length} rows` : y == null ? null : "…" }); return; }
    if (!same(x, y)) out.push({ kind: "data", field: k, from: normValue(x), to: normValue(y) });
  });
  ["label", "typeKey", "qty"].forEach((k) => { if (!same(a && a[k], b && b[k])) out.push({ kind: "field", field: k, from: normValue(a && a[k]), to: normValue(b && b[k]) }); });
  const ra = a && a.review && a.review.at, rb = b && b.review && b.review.at;
  if (ra !== rb) out.push({ kind: "field", field: "reviewedAt", from: ra || null, to: rb || null });
  const ta = JSON.stringify((a && a.tags) || {}), tb = JSON.stringify((b && b.tags) || {});
  if (ta !== tb) out.push({ kind: "field", field: "tags", from: (a && a.tags) || null, to: (b && b.tags) || null });
  return out;
}

/** Two takeoff snapshots ({project, instances}) → {project, elements:{added, removed, changed}, counts}. */
export function diffTakeoffs(before, after) {
  const a = before || {}, b = after || {};
  const project = [];
  const pa = a.project || {}, pb = b.project || {};
  new Set([...Object.keys(pa), ...Object.keys(pb)]).forEach((k) => {
    if (TK_SKIP.has(k) || k.startsWith("_")) return;
    const x = pa[k], y = pb[k];
    if ((x && typeof x === "object") || (y && typeof y === "object")) { if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) project.push({ field: k, from: x == null ? null : "…", to: y == null ? null : "…", note: "changed" }); return; }
    if (!same(x, y)) project.push({ field: k, from: normValue(x), to: normValue(y) });
  });
  const ia = Array.isArray(a.instances) ? a.instances : [], ib = Array.isArray(b.instances) ? b.instances : [];
  const added = [], removed = [], changed = [];
  ib.forEach((it) => {
    const prev = ia.find((p) => p.id === it.id);
    if (!prev) { added.push({ id: it.id, label: it.label, type: it.typeKey }); return; }
    const changes = instanceDataDiff(prev, it);
    if (changes.length) changed.push({ id: it.id, label: it.label, type: it.typeKey, changes });
  });
  ia.forEach((it) => { if (!ib.find((p) => p.id === it.id)) removed.push({ id: it.id, label: it.label, type: it.typeKey }); });
  const counts = { project: project.length, added: added.length, removed: removed.length, changed: changed.length, cells: changed.reduce((s, e) => s + e.changes.length, 0) };
  return { project, elements: { added, removed, changed }, counts, any: counts.project + counts.added + counts.removed + counts.changed > 0 };
}

/* ---------------- a run of versions ---------------- */

const stamp = (doc) => ({ savedAt: doc.savedAt || null, source: doc.source || null, savedBy: doc.savedBy || null, path: doc.path || null });

/**
 * Consecutive diffs over versions sorted oldest → newest. `docs` are
 * {savedAt, source, savedBy, path, quote | snapshot}; `kind` "quote" |
 * "takeoff". Steps with no change are counted, not listed.
 */
export function historyFromVersions(docs, kind, liveRates) {
  const list = (docs || []).filter(Boolean).slice().sort((x, y) => String(x.savedAt || "").localeCompare(String(y.savedAt || "")));
  const steps = [];
  let unchanged = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    const diff = kind === "takeoff" ? diffTakeoffs(prev.snapshot, cur.snapshot) : diffQuotes(prev.quote, cur.quote, liveRates);
    if (!diff.any) { unchanged++; continue; }
    steps.push({ from: stamp(prev), to: stamp(cur), diff });
  }
  return { kind, versions: list.length, firstAt: list.length ? list[0].savedAt : null, lastAt: list.length ? list[list.length - 1].savedAt : null, unchangedSteps: unchanged, steps };
}

/** Plain-English one-liners for a diff — what a chat answer or a log line reads. */
export function describeDiff(diff, limit = 40) {
  const lines = [];
  if (!diff) return lines;
  (diff.project || []).forEach((p) => lines.push(`${p.field}: ${fmt(p.from)} → ${fmt(p.to)}`));
  (diff.elements?.added || []).forEach((e) => lines.push(`element added: ${e.label}${e.total != null ? ` ($${e.total})` : ""}`));
  (diff.elements?.removed || []).forEach((e) => lines.push(`element removed: ${e.label}${e.total != null ? ` ($${e.total})` : ""}`));
  (diff.elements?.changed || []).forEach((e) => {
    const head = e.totalFrom != null && e.totalTo != null && e.totalFrom !== e.totalTo ? ` ($${e.totalFrom} → $${e.totalTo})` : "";
    lines.push(`${e.label}${head}:`);
    if (e.moved) lines.push(`  moved from position ${e.moved.from} to ${e.moved.to}`);
    if (!e.changes.length && e.bands) Object.keys(e.bands).forEach((cat) => lines.push(`  ${cat}: $${e.bands[cat].from} → $${e.bands[cat].to} (rates or scope, not a quantity)`));
    e.changes.forEach((c) => {
      if (c.kind === "qty") lines.push(`  qty ${c.product} (${c.category}): ${fmt(c.from)} → ${fmt(c.to)} ${c.unit}`);
      else if (c.kind === "crew") lines.push(`  crew ${c.task} / ${c.resource}: ${fmt(c.from)} → ${fmt(c.to)}`);
      else if (c.kind === "rateOverride") lines.push(`  quote amount ${c.product}: ${fmt(c.from)} → ${fmt(c.to)}`);
      else if (c.kind === "additional") lines.push(`  additional row ${c.name}: ${c.from ? JSON.stringify(c.from) : "—"} → ${c.to ? JSON.stringify(c.to) : "removed"}`);
      else if (c.kind === "taskName") lines.push(`  crew row renamed: ${c.from} → ${c.to}`);
      else if (c.kind === "taskRemoved") lines.push(`  crew row removed: ${c.task}`);
      else lines.push(`  ${c.field}: ${fmt(c.from)} → ${fmt(c.to)}`);
    });
  });
  if (diff.totals && diff.totals.delta) lines.push(`direct cost: $${diff.totals.from} → $${diff.totals.to} (${diff.totals.delta > 0 ? "+" : ""}${diff.totals.delta})`);
  return lines.length > limit ? lines.slice(0, limit).concat([`… ${lines.length - limit} more`]) : lines;
}
const fmt = (v) => (v === null || v === undefined ? "blank" : typeof v === "object" ? JSON.stringify(v) : String(v));

export { rateKey };
