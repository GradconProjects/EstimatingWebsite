/**
 * The Gradcon AI chat's HISTORY tools — read-only readers of the immutable
 * versions the portal already keeps in the gradcon-files bucket
 * (quote-versions/<projectId>/ from lib/quoteVersions.js and
 * estimate-versions/<takeoffId>/ from Estimates' keepEstimateVersion) and of
 * the live estimator_kv rows. Grady, 11 Oct 2026: "i want to monitor what
 * Grady will input so we can collect data for future projects. check for 145
 * Harrisons road and see changes" — the chat had said it could not see who
 * changed what or an earlier figure. Now it lists the versions, diffs any two
 * (or a version against the live row), walks the whole history and reports
 * the handover drift, all through src/lib/quoteDiff.js (pure, verify-covered).
 *
 * Nothing here writes. The anon/publishable key is the same one every
 * browser ships; `deps.cloud` ({list, getJson, kvGet}) is the test seam.
 * The underscore keeps this module from being an endpoint.
 */
import { diffQuotes, diffTakeoffs, handoverDrift, historyFromVersions, describeDiff } from "../src/lib/quoteDiff.js";

const SUPABASE_URL = "https://xbmyhvrcuyapoarmchpv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kr4dTFXhZsifAA28HmMAVQ_EDSR2DL0";
const BUCKET = "gradcon-files";
const H = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

export const QUOTE_PREFIX = (id) => `quote-versions/${id}`;
export const TAKEOFF_PREFIX = (id) => `estimate-versions/${id}`;
export const quoteRowKey = (id) => `gradcon-quote-${id}`;
export const TAKEOFF_INDEX_KEY = "gradcon-estimate-projects-index";
export const RATES_KEY = "gradcon-rates";

/** The real cloud: bucket listing, object fetch, estimator_kv row. */
export function realCloud(fetchImpl = fetch) {
  return {
    async list(prefix) {
      const r = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }), signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`version list failed (${r.status})`);
      const items = await r.json();
      return Array.isArray(items) ? items : [];
    },
    async getJson(path) {
      const r = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { headers: H, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`version fetch failed (${r.status})`);
      return r.json();
    },
    async kvGet(key) {
      const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(key)}&select=value,updated_at`, { headers: H, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`row fetch failed (${r.status})`);
      const rows = await r.json();
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },
  };
}

/** A bucket entry name → {savedAt, source}; both apps' naming schemes. */
export function parseVersionName(name) {
  let m = String(name || "").match(/^(\d{8})T(\d{6})(\d*)Z?-([a-z-]+)\.json$/);
  if (m) return { savedAt: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}.${(m[3] || "000").padEnd(3, "0")}Z`, source: m[4] };
  m = String(name || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z-(.+)\.json$/);
  if (m) return { savedAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, source: m[6] };
  return null;
}

const kindOf = (k) => (String(k || "quote").toLowerCase().startsWith("t") || String(k || "").toLowerCase() === "estimate" ? "takeoff" : "quote");

/** Newest first: [{path, name, savedAt, source, sizeKB}]. */
export async function listVersions(projectId, kind, cloud) {
  const prefix = kind === "takeoff" ? TAKEOFF_PREFIX(projectId) : QUOTE_PREFIX(projectId);
  const items = await cloud.list(prefix);
  return items
    .filter((o) => o && o.name && /\.json$/.test(o.name))
    .map((o) => { const p = parseVersionName(o.name) || { savedAt: o.created_at || null, source: "" }; return { path: `${prefix}/${o.name}`, name: o.name, savedAt: p.savedAt, source: p.source, sizeKB: Math.round(((o.metadata && o.metadata.size) || 0) / 1024) }; })
    .sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
}

/** One version as {savedAt, source, savedBy, path, quote | snapshot}. */
export async function loadVersion(path, kind, cloud) {
  const doc = await cloud.getJson(path);
  const body = kind === "takeoff" ? { snapshot: doc.snapshot || doc } : { quote: doc.quote || doc.value || doc };
  return { savedAt: doc.savedAt || (parseVersionName(path.split("/").pop()) || {}).savedAt || null, source: doc.source || null, savedBy: doc.savedBy || null, build: doc.build || null, path, ...body };
}

/** The live row as the same shape (source "live"). */
export async function loadLive(projectId, kind, cloud) {
  if (kind === "takeoff") {
    const idx = await cloud.kvGet(TAKEOFF_INDEX_KEY);
    const entry = (Array.isArray(idx && idx.value) ? idx.value : []).find((p) => p && p.id === projectId && !p.deleted);
    if (!entry || !entry.key) return null;
    const row = await cloud.kvGet(entry.key);
    return row ? { savedAt: row.updated_at || null, source: "live", savedBy: null, path: null, snapshot: row.value } : null;
  }
  const row = await cloud.kvGet(quoteRowKey(projectId));
  return row ? { savedAt: row.updated_at || null, source: "live", savedBy: null, path: null, quote: row.value } : null;
}

async function liveRates(cloud) { try { const r = await cloud.kvGet(RATES_KEY); return (r && r.value) || null; } catch { return null; } }

/** "live" | "latest" | "oldest" | an index (1 = newest) | a date-time prefix | a path or file name → the version entry (or the live marker). */
export function pickVersion(list, ref, fallback) {
  const r = ref == null || ref === "" ? fallback : String(ref).trim();
  if (!r) return null;
  if (/^live$/i.test(r)) return { live: true };
  if (/^latest$|^newest$/i.test(r)) return list[0] || null;
  if (/^oldest$|^first$/i.test(r)) return list[list.length - 1] || null;
  if (/^\d{1,3}$/.test(r)) return list[Number(r) - 1] || null;
  const byPath = list.find((v) => v.path === r || v.name === r);
  if (byPath) return byPath;
  // a date or date-time: the newest version saved at or before it (local-looking input compared as ISO text)
  const iso = r.replace(" ", "T");
  const atOrBefore = list.filter((v) => v.savedAt && v.savedAt.slice(0, iso.length) <= iso);
  return atOrBefore[0] || list.find((v) => (v.savedAt || "").startsWith(iso)) || null;
}

const CAP_ELEMENTS = 40, CAP_CHANGES = 30;
function compactDiff(diff) {
  if (!diff) return diff;
  const ch = (diff.elements && diff.elements.changed) || [];
  const changed = ch.slice(0, CAP_ELEMENTS).map((e) => (e.changes.length > CAP_CHANGES ? { ...e, changes: e.changes.slice(0, CAP_CHANGES), moreChanges: e.changes.length - CAP_CHANGES } : e));
  return { ...diff, elements: { ...diff.elements, changed, moreChanged: Math.max(0, ch.length - CAP_ELEMENTS) }, lines: describeDiff(diff, 60) };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** The tool definitions the chat offers (same shape as mailTools). */
export function historyTools() {
  const pid = { type: "string", description: "the project's id from the data (a Quotes project id, or a takeoff id with kind \"takeoff\")" };
  const kind = { type: "string", enum: ["quote", "takeoff"], description: "quote (default) = a Quotes project; takeoff = an Estimates takeoff" };
  return [
    { name: "list_versions", description: "List the saved versions of a project (every Save, autosave, restore and handover kept a full immutable copy): when each was saved, how (manual / autosave / before-restore / save / before-sync / other-device), by whom (savedBy, recorded from 11 Oct 2026), and when the live row was last written. Call this first to see the timeline.", parameters: { type: "object", properties: { projectId: pid, kind }, required: ["projectId"] } },
    { name: "compare_versions", description: "What changed between two copies of a project: project fields (status, client, scope, on-costs), elements added / removed, and for each changed element every quantity, subcontract quote amount, crew-sheet cell, additional row and label that moved — with the element's direct cost before and after and the $ each band moved. `from` / `to` are \"live\" (the current row), \"latest\", \"oldest\", an index from list_versions (1 = newest), a date-time (newest version at or before it) or a version path. Defaults: from = the version before `to`, to = live.", parameters: { type: "object", properties: { projectId: pid, kind, from: { type: "string" }, to: { type: "string" } }, required: ["projectId"] } },
    { name: "project_history", description: "Walk the whole history: consecutive diffs between every kept version (oldest → newest, then the live row), each with who saved it, when and what moved. Use it for \"what did Grady change on X\" or \"how did the price move\". Steps with no change are counted, not listed.", parameters: { type: "object", properties: { projectId: pid, kind, limit: { type: "integer", description: "how many of the newest versions to walk (default 12, max 30)" } }, required: ["projectId"] } },
    { name: "handover_changes", description: "For a Quotes project the handover pass prefilled (crew sheets on Completed Estimating): every prefilled crew cell, renamed row and steel tonnage against what the sheet holds NOW — kept, changed (to what) or cleared. Every \"changed\" row is Grady correcting the band: the data future projects are tuned from.", parameters: { type: "object", properties: { projectId: pid }, required: ["projectId"] } },
  ];
}

/** Runs one history tool → {summary, result}. */
export async function runHistoryTool(name, args, deps = {}) {
  const cloud = deps.cloud || realCloud(deps.fetchImpl || fetch);
  const projectId = String((args && args.projectId) || "").trim();
  if (!projectId) throw new Error("projectId required");
  const kind = kindOf(args && args.kind);
  if (name === "list_versions") {
    const list = await listVersions(projectId, kind, cloud);
    const live = await loadLive(projectId, kind, cloud).catch(() => null);
    const newest = list.slice(0, 6);
    const stamped = await mapLimit(newest, 4, async (v) => { try { const d = await cloud.getJson(v.path); return { ...v, savedBy: d.savedBy || null, elements: Array.isArray(d.quote && d.quote.items) ? d.quote.items.length : d.elementCount ?? null, status: d.quote && d.quote.status || null }; } catch { return v; } });
    const rest = list.slice(6).map((v) => ({ savedAt: v.savedAt, source: v.source, sizeKB: v.sizeKB }));
    const bySource = {}; list.forEach((v) => { bySource[v.source || "?"] = (bySource[v.source || "?"] || 0) + 1; });
    return { summary: `${list.length} version${list.length === 1 ? "" : "s"} of ${kind} ${projectId}`, result: { projectId, kind, count: list.length, oldest: list.length ? list[list.length - 1].savedAt : null, newest: list.length ? list[0].savedAt : null, bySource, liveUpdatedAt: live ? live.savedAt : null, liveFound: !!live, versions: stamped.map((v, i) => ({ index: i + 1, ...v, path: undefined })), older: rest } };
  }
  if (name === "compare_versions") {
    const list = await listVersions(projectId, kind, cloud);
    const to = pickVersion(list, args.to, "live");
    let from = pickVersion(list, args.from, null);
    if (!from) { if (to && to.live) from = list[0] || null; else { const i = list.findIndex((v) => to && v.path === to.path); from = i >= 0 ? list[i + 1] || null : null; } }
    if (!to) throw new Error(`no version matches "to" = ${args.to}`);
    if (!from) throw new Error(list.length ? `no version matches "from" = ${args.from}` : `no versions kept for ${kind} ${projectId}`);
    const [A, B, rates] = await Promise.all([
      from.live ? loadLive(projectId, kind, cloud) : loadVersion(from.path, kind, cloud),
      to.live ? loadLive(projectId, kind, cloud) : loadVersion(to.path, kind, cloud),
      kind === "quote" ? liveRates(cloud) : null,
    ]);
    if (!A || !B) throw new Error("a copy could not be read (the live row may not exist)");
    const diff = kind === "takeoff" ? diffTakeoffs(A.snapshot, B.snapshot) : diffQuotes(A.quote, B.quote, rates || undefined);
    const stamp = (d) => ({ savedAt: d.savedAt, source: d.source, savedBy: d.savedBy });
    return { summary: `${A.source} ${A.savedAt || ""} → ${B.source} ${B.savedAt || ""}: ${diff.counts.changed} changed, ${diff.counts.added} added, ${diff.counts.removed} removed`, result: { projectId, kind, from: stamp(A), to: stamp(B), diff: compactDiff(diff) } };
  }
  if (name === "project_history") {
    const limit = Math.min(30, Math.max(2, Number(args.limit) || 12));
    const list = (await listVersions(projectId, kind, cloud)).slice(0, limit);
    const [docs, live, rates] = await Promise.all([
      mapLimit(list, 4, (v) => loadVersion(v.path, kind, cloud).catch(() => null)),
      loadLive(projectId, kind, cloud).catch(() => null),
      kind === "quote" ? liveRates(cloud) : null,
    ]);
    const all = docs.filter(Boolean).concat(live ? [{ ...live, savedAt: live.savedAt || new Date().toISOString() }] : []);
    const h = historyFromVersions(all, kind, rates || undefined);
    const steps = h.steps.map((s) => ({ from: s.from, to: s.to, counts: s.diff.counts, totals: s.diff.totals || null, lines: describeDiff(s.diff, 60) }));
    const savers = {}; all.forEach((d) => { if (d.savedBy) savers[d.savedBy] = (savers[d.savedBy] || 0) + 1; });
    return { summary: `${h.versions} copies, ${steps.length} steps with changes`, result: { projectId, kind, versionsWalked: h.versions, firstAt: h.firstAt, lastAt: h.lastAt, unchangedSteps: h.unchangedSteps, savedBy: savers, liveIncluded: !!live, steps } };
  }
  if (name === "handover_changes") {
    const live = await loadLive(projectId, "quote", cloud);
    if (!live) throw new Error(`no live row for project ${projectId}`);
    const drift = handoverDrift(live.quote);
    const changed = drift.entries.filter((e) => e.status !== "kept");
    return { summary: drift.prefilled ? `${drift.summary.kept} kept, ${drift.summary.changed} changed, ${drift.summary.cleared} cleared` : "no handover prefill on this project", result: { projectId, project: live.quote && live.quote.projectName, status: live.quote && live.quote.status, prefilledAt: drift.at, undoneAt: drift.undoneAt, summary: drift.summary, steelModes: drift.steelModes, changed, keptCount: drift.summary.kept, keptSample: drift.entries.filter((e) => e.status === "kept").slice(0, 12) } };
  }
  throw new Error(`unknown tool ${name}`);
}

export const HISTORY_TOOL_NAMES = new Set(["list_versions", "compare_versions", "project_history", "handover_changes"]);
