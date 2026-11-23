/**
 * The project LIST (the shared `gradcon-projects` index) never loses a project
 * whose data row is still stored. Pure — no React, no storage — so
 * scripts/verify.mjs runs it directly.
 *
 * 23 Nov 2026 ("the entire project went missing … grady was working on it and
 * it got missing"): "3206 Point Nepean Road — NOV23" dropped off the list at
 * 23:13:31 UTC while both accounts had it open; its row was intact. The list
 * was rewritten by a browser the moment its Dashboard mounted and read the
 * project stamps it ALREADY HELD (no fresh stamp query went out first), two
 * minutes after the entry's one-hour grace ended. The only path that removes
 * a list entry and leaves the row is the Dashboard's prune of "entries with no
 * data row" — and that prune trusted a reading that can be stale (the stamps
 * fetched when the app booted, consumed whenever the Dashboard is first shown,
 * which can be hours later). Three rules:
 *
 *   1. the boot-time stamps answer the first summary read only while they are
 *      seconds old AND list every key asked for — a key they do not list is
 *      looked up fresh, never called missing (`prefetchUsable`);
 *   2. an entry is pruned only after a FRESH, direct query for exactly that key
 *      answered and did not return it (`confirmedAbsent`) — a query that fails
 *      confirms nothing;
 *   3. a stored project that is not on the list is OFFERED back on the
 *      Dashboard (`unlistedRowKeys`, `restoredEntry`) — a dropped entry is one
 *      click to recover, by whoever notices.
 */
// the same two spellings as lib/projects.js (which talks to the database and cannot be imported in plain Node)
const LEGACY_QUOTE_KEY = "gradcon-quote";
const quoteStorageKey = (id) => `gradcon-quote-${id}`;

/** The boot-time stamps are trusted for this long, and only for keys they list. */
export const PREFETCH_MAX_AGE_MS = 15000;
/** A row younger than this may still be on its way onto the list (the row is written first). */
export const UNLISTED_GRACE_MS = 2 * 60 * 1000;

export function prefetchUsable(pre, takenAtMs, storageKeys, nowMs = Date.now()) {
  if (!pre || typeof pre !== "object") return false;
  if (!Number.isFinite(takenAtMs) || nowMs - takenAtMs > PREFETCH_MAX_AGE_MS || nowMs < takenAtMs) return false;
  const keys = Array.isArray(storageKeys) ? storageKeys : [];
  return keys.every((k) => typeof k === "string" && k.startsWith(`${LEGACY_QUOTE_KEY}-`) && k in pre);
}

/** Of `candidateKeys`, those a fresh stamp query (an object, possibly empty) did not return. `null` = the query failed: nothing is confirmed. */
export function confirmedAbsent(candidateKeys, freshStamps) {
  if (!freshStamps || typeof freshStamps !== "object") return [];
  return (Array.isArray(candidateKeys) ? candidateKeys : []).filter((k) => !(k in freshStamps));
}

/** A project id is eight random characters and then its creation time in base 36 — the day it was made, back out of the id. */
export function createdAtFromId(id, fallbackIso = null) {
  const s = String(id || "");
  if (s.length > 8) {
    const ms = parseInt(s.slice(8), 36);
    if (Number.isFinite(ms) && ms > Date.UTC(2024, 0, 1) && ms < Date.UTC(2100, 0, 1)) return new Date(ms).toISOString();
  }
  return fallbackIso || null;
}

/** Stored project rows that no list entry points at (and that are old enough not to be a create in flight). */
export function unlistedRowKeys(rowStamps, listedKeys, nowMs = Date.now()) {
  if (!rowStamps || typeof rowStamps !== "object") return [];
  const listed = listedKeys instanceof Set ? listedKeys : new Set(Array.isArray(listedKeys) ? listedKeys : []);
  const prefix = `${LEGACY_QUOTE_KEY}-`;
  return Object.keys(rowStamps).filter((k) => {
    if (!k.startsWith(prefix) || k.length <= prefix.length || listed.has(k)) return false;
    const t = Date.parse(rowStamps[k] || "");
    return !Number.isFinite(t) || nowMs - t >= UNLISTED_GRACE_MS;
  }).sort();
}

/** The list entry that puts a stored row back: its own id, and the day the id says it was made. */
export function restoredEntry(storageKey, rowUpdatedAt = null, nowIso = new Date().toISOString()) {
  const prefix = `${LEGACY_QUOTE_KEY}-`;
  const key = String(storageKey || "");
  if (!key.startsWith(prefix) || key.length <= prefix.length) return null;
  const id = key.slice(prefix.length);
  return { id, storageKey: quoteStorageKey(id), createdAt: createdAtFromId(id, rowUpdatedAt || nowIso) };
}
