/**
 * Multi-project index. A project is a lightweight pointer — `{ id,
 * storageKey, createdAt }` — into its own quote object stored separately
 * under `storageKey` (see lib/storage.js, which is backed by Supabase when
 * configured, localStorage otherwise). The index itself lives under
 * PROJECTS_INDEX_KEY. Name/date/GFA/items etc. all live in the quote, not
 * here, so there's exactly one place that owns each piece of data.
 */
import { uid, rateKey, categoryAppliesTo } from "./costing.js";
import { supabase, supabaseEnabled } from "./supabaseClient.js";
import { FULL_CATALOG } from "../data/catalog.js";
import { readMirror, writeMirror, clearMirror } from "./localMirror.js";

const TABLE = "estimator_kv";

export const PROJECTS_INDEX_KEY = "gradcon-projects";
export const LEGACY_QUOTE_KEY = "gradcon-quote";
export const PUBLISHED_QUOTES_KEY = "gradcon-published-quotes";

export const quoteStorageKey = (id) => `gradcon-quote-${id}`;

/* ---- Dashboard summary mirror -------------------------------------------
 * The dashboard needs every project's quote to draw its rows (name, status,
 * totals), which used to mean a blank list until a SECOND round trip — after
 * the index — came back. Two things fix that, both Supabase-only:
 *
 *   1. readQuotesCached(): a localStorage mirror of each quote as the dashboard
 *      needs it, painted synchronously on first render. Markup drawings are
 *      stripped of their image data so the mirror stays small enough to keep
 *      (see MAX_MIRROR_BYTES) — which is exactly why this mirror is ONLY for
 *      summaries and never feeds the project editor: a save made from a copy
 *      without the drawings would delete them.
 *   2. a boot-time prefetch of every quote row, fired the moment this module
 *      evaluates (before React mounts), in parallel with the index fetch that
 *      useStoredState makes. The first readQuotes() call consumes it, so the
 *      dashboard's own fetch costs no extra round trip. Consumed exactly once:
 *      every later call — a refresh, another view, the Estimates import — goes
 *      to the database as before, so nothing can ever be served stale.
 */
const summaryMirrorKey = (storageKey) => `summary:${storageKey}`;
const stripForSummary = (quote) => {
  if (!quote || typeof quote !== "object" || !Array.isArray(quote.items)) return quote;
  return {
    ...quote,
    items: quote.items.map((it) =>
      it && Array.isArray(it.markups)
        ? { ...it, markups: it.markups.map((m) => (m && typeof m === "object" ? { ...m, dataURL: undefined } : m)) }
        : it
    ),
  };
};
function mirrorSummaries(map, stamps) {
  Object.keys(map).forEach((k) => writeMirror(summaryMirrorKey(k), stripForSummary(map[k]), (stamps && stamps[k]) || null));
}

/* ---- Download only what changed, and never the drawings ------------------
 * Every project row carries its markup drawings as image data — the 16 rows
 * measured 30 MB on 17 Sep 2026, and one select of them all now trips the
 * database statement timeout. The dashboard, the Project Management page and
 * the Vault only need the SUMMARY of each project (name, status, planner,
 * RFIs, claims, totals) — never the drawings. readQuoteSummariesDetailed():
 *   1. asks the database for each row's updated_at only (a few bytes);
 *   2. serves every row whose summary mirror carries that same stamp from
 *      the mirror;
 *   3. fetches just the rows that changed since this browser last saw them —
 *      through estimator_kv_quote_summaries (supabase/migrations/0004), a
 *      read-only database function that drops items[*].markups[*].dataURL
 *      BEFORE the row leaves the database, so the drawing bytes never cross
 *      the network; where that function is not installed, one full row per
 *      request, in sequence (bounded), stripped here as before.
 *
 * The values it returns are STRIPPED of drawing data. They must never be
 * written back whole — that would delete the drawings. Field edits from those
 * pages go through patchQuoteFields() below, which merges the fields into
 * the full row in the database. The project editor keeps its own full,
 * live row through useStoredState and is untouched by any of this.
 *
 * Failures are never "the project does not exist": a key is reported as
 * `missing` only when a SUCCESSFUL stamp query did not list it; anything
 * that could not be read (network, timeout, an error) is reported as
 * `failed`, its last-known mirror copy stays on screen, and the caller
 * offers a retry. */
async function readQuoteStamps(storageKeys) {
  const { data, error } = await supabase.from(TABLE).select("key, updated_at").in("key", storageKeys);
  if (error || !data) return null;
  const stamps = {};
  data.forEach((row) => { stamps[row.key] = row.updated_at; });
  return stamps;
}
const SUMMARIES_FN = "estimator_kv_quote_summaries";
// Remembered for the session once the database says the function is not
// installed, so every later summary read goes straight to the bounded
// per-row fallback instead of asking again. Any other error (a timeout, a
// network failure) falls back for that read only and tries the function next time.
let summariesFnMissing = false;
const isMissingFunction = (error) =>
  !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message || ""));
/** Drawing-stripped values for `storageKeys` → `{ map, failed }`. Keys in
 * `failed` could not be read; they are NOT missing rows. Every row that
 * arrives is mirrored with its stamp. */
async function fetchSummaries(storageKeys, stamps) {
  const map = {};
  const failed = [];
  if (storageKeys.length === 0) return { map, failed };
  if (!summariesFnMissing) {
    try {
      const { data, error } = await supabase.rpc(SUMMARIES_FN, { p_keys: storageKeys });
      if (!error && Array.isArray(data)) {
        data.forEach((row) => {
          if (!row || typeof row.key !== "string" || !storageKeys.includes(row.key)) return;
          map[row.key] = row.value;
          if (stamps) stamps[row.key] = row.updated_at;
        });
        storageKeys.forEach((k) => { if (!(k in map)) failed.push(k); }); // listed by the stamp query a moment ago, so unavailable, not gone
        mirrorSummaries(map, stamps);
        return { map, failed };
      }
      if (isMissingFunction(error)) summariesFnMissing = true;
    } catch {
      /* network failure — fall through to the bounded per-row reads */
    }
  }
  // Fallback: ONE full row per request, in sequence — never the whole set in
  // one select (that is the query that times out). A row that fails is
  // skipped, not treated as absent; the others still arrive.
  for (const k of storageKeys) {
    const row = await readFullRowBounded(k);
    if (!row) { failed.push(k); continue; }
    map[k] = stripForSummary(row.value);
    if (stamps) stamps[k] = row.updated_at;
    writeMirror(summaryMirrorKey(k), map[k], row.updated_at);
  }
  return { map, failed };
}
/* Full-row reads are the expensive request (a row with drawings is up to
 * 6 MB), so ALL of them — summary fallback and readQuotes() — go through one
 * queue: at most one in flight for the whole app, whoever asks (the dashboard
 * effect re-runs while its first read is still going, and the pages would
 * otherwise overlap). A key already being read is shared, not fetched twice.
 * Resolves to the row or null; never throws. */
let rowReadQueue = Promise.resolve();
const rowReadsInFlight = new Map();
function readFullRowBounded(storageKey) {
  if (rowReadsInFlight.has(storageKey)) return rowReadsInFlight.get(storageKey);
  const read = rowReadQueue.then(async () => {
    try {
      const { data, error } = await supabase.from(TABLE).select("key, value, updated_at").eq("key", storageKey).maybeSingle();
      return error || !data ? null : data;
    } catch {
      return null;
    }
  });
  rowReadsInFlight.set(storageKey, read);
  read.finally(() => rowReadsInFlight.delete(storageKey));
  rowReadQueue = read.catch(() => {});
  return read;
}
/** Mirror hits for stamped keys, then only the stale ones from the database. */
async function summariesFromStamps(storageKeys, stamps) {
  const map = {};
  const missing = [];
  const stale = [];
  storageKeys.forEach((k) => {
    if (!(k in stamps)) { missing.push(k); return; } // confirmed: the stamp query succeeded and did not list it
    const hit = readMirror(summaryMirrorKey(k));
    if (hit && hit.value && hit.updatedAt && hit.updatedAt === stamps[k]) map[k] = hit.value;
    else stale.push(k);
  });
  const fresh = await fetchSummaries(stale, stamps);
  Object.assign(map, fresh.map);
  // a row that could not be refreshed keeps its last-known copy on screen
  fresh.failed.forEach((k) => {
    const hit = readMirror(summaryMirrorKey(k));
    if (hit && hit.value) map[k] = hit.value;
  });
  return { map, missing, failed: fresh.failed, error: fresh.failed.length ? "rows" : null };
}
/** Nothing could be confirmed: last-known copies only, every key reported failed. */
function summariesUnavailable(storageKeys, why) {
  return { map: readQuotesCached(storageKeys), missing: [], failed: storageKeys.slice(), error: why };
}
/**
 * `{ map, missing, failed, error }` for the summary pages:
 *   map     — `{ storageKey: quote-without-drawing-data }` (current, or the
 *             last-known copy for a key that is also in `failed`);
 *   missing — keys a SUCCESSFUL stamp query did not list: confirmed to have
 *             no row (the dashboard prunes those, and only those);
 *   failed  — keys that could not be read or refreshed: unavailable, never
 *             to be pruned, written or defaulted;
 *   error   — null, or a short reason when something in `failed` remains.
 */
export async function readQuoteSummariesDetailed(storageKeys) {
  if (storageKeys.length === 0) return { map: {}, missing: [], failed: [], error: null };
  if (!supabaseEnabled) {
    const map = await readQuotes(storageKeys);
    return { map, missing: storageKeys.filter((k) => !(k in map)), failed: [], error: null };
  }
  try {
    let stamps = null;
    if (stampsPrefetch) {
      // the boot-time stamp query (a few bytes) covers every gradcon-quote-* row;
      // consumed once, and only when it can answer for every requested key
      const pending = stampsPrefetch;
      stampsPrefetch = null;
      const pre = await pending;
      if (pre && storageKeys.every((k) => k.startsWith(`${LEGACY_QUOTE_KEY}-`))) stamps = pre;
    }
    if (!stamps) stamps = await readQuoteStamps(storageKeys);
    if (!stamps) return summariesUnavailable(storageKeys, "stamps");
    return await summariesFromStamps(storageKeys, stamps);
  } catch {
    return summariesUnavailable(storageKeys, "network");
  }
}
/** `{ storageKey: quote-without-drawing-data }` — the map of
 * readQuoteSummariesDetailed() for callers that need no error state. */
export async function readQuoteSummaries(storageKeys) {
  return (await readQuoteSummariesDetailed(storageKeys)).map;
}
/**
 * Merge a few top-level fields (status, clientName, planner, communications,
 * rfis, claims, …) into a project's FULL row without ever holding the whole
 * row on the client. Prefers the estimator_kv_merge database function
 * (supabase/migrations/0003_estimator_kv_merge.sql: `value || patch`, a
 * few-byte call); where that function is not installed it falls back to
 * read-merge-write of the full row. Either way the drawings stay exactly as
 * they are, and the summary mirror is patched to match. Resolves to the new
 * updated_at (or null when nothing could be written).
 */
export async function patchQuoteFields(storageKey, patch) {
  if (!storageKey || !patch || typeof patch !== "object") return null;
  let stamp = null;
  if (supabaseEnabled) {
    try {
      const { data, error } = await supabase.rpc("estimator_kv_merge", { p_key: storageKey, p_patch: patch });
      if (!error && data) stamp = typeof data === "string" ? data : (data.updated_at || null);
    } catch { /* fall through to the full-row merge */ }
    if (!stamp) {
      try {
        const { data: row, error } = await supabase.from(TABLE).select("value").eq("key", storageKey).maybeSingle();
        if (error || !row || !row.value) return null;
        const merged = { ...row.value, ...patch };
        stamp = new Date().toISOString();
        const { error: upErr } = await supabase.from(TABLE).upsert({ key: storageKey, value: merged, updated_at: stamp });
        if (upErr) return null;
      } catch {
        return null;
      }
    }
    // keep the summary mirror in step so the next paint shows the edit without a round trip
    const hit = readMirror(summaryMirrorKey(storageKey));
    if (hit && hit.value) writeMirror(summaryMirrorKey(storageKey), { ...hit.value, ...patch }, stamp);
    return stamp;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    const cur = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(storageKey, JSON.stringify({ ...cur, ...patch }));
    return new Date().toISOString();
  } catch {
    return null;
  }
}

/** Keeps a project's summary mirror current as it is EDITED — the editor
 * saves through useStoredState, which knows nothing about summaries, so
 * without this a rename made just before leaving would show its old name
 * on the next dashboard visit for the length of one round trip. */
export function mirrorQuoteSummary(storageKey, quote) {
  if (!supabaseEnabled || !storageKey || !quote) return;
  writeMirror(summaryMirrorKey(storageKey), stripForSummary(quote), null);
}

/** Synchronous: `{ storageKey: quote-without-drawing-data }` for every key
 * that has a mirror. Only for summary rows; empty on a localStorage install
 * (there the quotes are already local and instant). */
export function readQuotesCached(storageKeys) {
  const map = {};
  if (!supabaseEnabled) return map;
  storageKeys.forEach((k) => {
    const hit = readMirror(summaryMirrorKey(k));
    if (hit && hit.value) map[k] = hit.value;
  });
  return map;
}

// Boot-time prefetch for the FIRST summary read (the dashboard): the
// key/updated_at STAMPS of every project row — a few bytes, fired the moment
// this module evaluates, in parallel with the index fetch. Deliberately no
// row data: which rows are needed is decided by the first read, against the
// mirror, and fetched drawing-free (see fetchSummaries). Consumed once.
let stampsPrefetch = null;
if (supabaseEnabled) {
  stampsPrefetch = (async () => {
    try {
      const { data, error } = await supabase.from(TABLE).select("key, updated_at").like("key", `${LEGACY_QUOTE_KEY}-%`);
      if (error || !data) return null;
      const stamps = {};
      data.forEach((row) => { stamps[row.key] = row.updated_at; });
      return stamps;
    } catch {
      return null;
    }
  })();
}

export function newProjectEntry() {
  const id = uid();
  return { id, storageKey: quoteStorageKey(id), createdAt: new Date().toISOString() };
}

/** Read-only snapshot of one quote, for dashboard summary rows. Not a live
 * subscription — the project editor (via useStoredState) is the source of
 * truth once a project is open. */
export async function readQuote(storageKey) {
  if (supabaseEnabled) {
    try {
      const { data, error } = await supabase.from(TABLE).select("value").eq("key", storageKey).maybeSingle();
      return error || !data ? null : data.value;
    } catch {
      return null;
    }
  }
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Reads many FULL quotes — `{ storageKey: quote }`. Only for callers that
 * must write a whole quote back; summary pages never use it. */
export async function readQuotes(storageKeys) {
  if (storageKeys.length === 0) return {};
  if (supabaseEnabled) {
    // FULL rows, drawings included — for callers that must write a whole
    // quote back (the Estimates import merge). Summary pages use
    // readQuoteSummariesDetailed() instead and never pay for the drawings.
    // One row per request, in sequence: a single select of every row is
    // ~30 MB and trips the database statement timeout. A row that cannot be
    // read is simply absent from the map — never a blank stand-in.
    const map = {};
    for (const k of storageKeys) {
      const row = await readFullRowBounded(k);
      if (!row) continue; // unavailable — leave it out
      map[k] = row.value;
      writeMirror(summaryMirrorKey(k), stripForSummary(row.value), row.updated_at);
    }
    return map;
  }
  const map = {};
  storageKeys.forEach((k) => {
    try {
      const raw = window.localStorage.getItem(k);
      if (raw) map[k] = JSON.parse(raw);
    } catch {
      /* skip unreadable entries */
    }
  });
  return map;
}

/** One-time direct write, used only by the Estimates-import flow (see
 * lib/estimateImport.js) to seed a brand-new project's quote before its
 * ProjectEditor (and useStoredState) has ever mounted. Everywhere else,
 * useStoredState owns writes — this bypasses it deliberately because there
 * is no mounted editor yet to own the save. */
export async function writeQuote(storageKey, quote) {
  if (supabaseEnabled) {
    try {
      const stamp = new Date().toISOString();
      await supabase.from(TABLE).upsert({ key: storageKey, value: quote, updated_at: stamp });
      writeMirror(summaryMirrorKey(storageKey), stripForSummary(quote), stamp);
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(quote));
  } catch {
    /* best-effort */
  }
}

export async function deleteQuote(storageKey) {
  if (supabaseEnabled) {
    clearMirror(summaryMirrorKey(storageKey));
    try {
      await supabase.from(TABLE).delete().eq("key", storageKey);
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* best-effort */
  }
}

/**
 * Mirrors this project's name/GFA — and every catalog line with a real quantity
 * entered — into "gradcon-published-quotes", the same shared bridge Estimates
 * already publishes to (see estimates-app.html's writeEstimateExport and
 * cost-planner.html's importPublishedEstimates). Cost Planner matches each line
 * back to its own BOQ catalog by category+product name (the two apps share the
 * same real Gradcon catalog, so this matches cleanly for almost everything —
 * reinforcement, concrete by grade, formwork, rate items, accessories) and drops
 * a new custom BOQ row for anything it can't match, so nothing entered in Quotes
 * is silently missing from Cost Planner's BOQ. Matched back to the same Cost
 * Planner project by this project's own id on every re-publish rather than
 * spawning a duplicate. Best-effort and silent — called from a debounced effect
 * on every real edit, so a failure here should never surface as an error to the
 * estimator working on their quote.
 *
 * Each line also carries the Quotes element's own label (e.g. "RC Columns - Fence
 * Post Columns", "Strip Footings") as its `member` — Cost Planner groups the BOQ
 * report by "building member", and mirroring the exact element the quantity was
 * entered against is a straight 1:1 match to how Quotes itself is organized, rather
 * than remapping through Cost Planner's own coarser member vocabulary (which loses
 * which specific element a line came from, and can group unrelated elements — e.g.
 * two different column types — under one generic "Columns" bucket). Cost Planner's
 * member grouping already accepts any string here, not just its own built-in list.
 */
export async function publishQuoteToCostPlanner(projectId, quote) {
  if (!quote.projectName) return;
  const lines = [];
  (quote.items || []).forEach((item) => {
    const member = item.label || null;
    FULL_CATALOG.forEach((cat) => {
      if (!categoryAppliesTo(cat, item)) return;
      cat.products.forEach((p) => {
        const qKey = rateKey(cat.key, p.name, p.unit);
        const qty = Number(item.qtys?.[qKey]) || 0;
        if (qty > 0) lines.push({ category: cat.key, name: p.name, unit: p.unit, qty, member });
      });
    });
    (item.additional || []).forEach((a) => {
      const qty = Number(a.qty) || 0;
      // a row added under a catalog category keeps that category; free-standing rows are CUSTOM
      if (qty > 0 && a.name) lines.push({ category: a.cat || "CUSTOM", name: a.name, unit: a.unit || "each", qty, rate: Number(a.rate) || 0, member, custom: true });
    });
  });
  const record = {
    id: projectId,
    project: {
      name: quote.projectName,
      gfa: Number(quote.gfa) || 0,
      status: quote.status || null,
      deadline: quote.planner?.deadline || null,
      priority: quote.planner?.priority || null,
    },
    lines,
    publishedAt: new Date().toISOString(),
  };
  if (supabaseEnabled) {
    try {
      const { data } = await supabase.from(TABLE).select("value").eq("key", PUBLISHED_QUOTES_KEY).maybeSingle();
      const existing = data && Array.isArray(data.value) ? data.value.slice() : [];
      const idx = existing.findIndex((r) => r && r.id === record.id);
      if (idx >= 0) existing[idx] = record; else existing.push(record);
      await supabase.from(TABLE).upsert({ key: PUBLISHED_QUOTES_KEY, value: existing, updated_at: new Date().toISOString() });
    } catch {
      /* best-effort */
    }
    return;
  }
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(PUBLISHED_QUOTES_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const idx = existing.findIndex((r) => r && r.id === record.id);
    if (idx >= 0) existing[idx] = record; else existing.push(record);
    window.localStorage.setItem(PUBLISHED_QUOTES_KEY, JSON.stringify(existing));
  } catch {
    /* best-effort */
  }
}

/**
 * One-time migration for installs that had a single quote under the old
 * fixed key (`gradcon-quote`) before multi-project support existed. Turns
 * it into project #1 in the index without moving or duplicating the data —
 * the migrated entry's storageKey stays LEGACY_QUOTE_KEY so nothing is lost
 * if migration runs more than once.
 */
export async function migrateLegacyQuote() {
  const legacy = await readQuote(LEGACY_QUOTE_KEY);
  if (!legacy) return [];
  return [{ id: "legacy", storageKey: LEGACY_QUOTE_KEY, createdAt: legacy.projectDate || new Date().toISOString() }];
}
