/**
 * Clearable notices (Grady, 22 Oct 2026: "i should be able to clear these
 * and other notifications used and unused").
 *
 * Every banner at the top of a project — the supplier-rate alarm, the
 * where-you-left-off strip, the Rates Library prompt, the kept rates, the
 * pinned rates, the handover prefill — carries a ✕. Clearing records the
 * notice's SIGNATURE (what it was about: the rate keys, the dates, the
 * handover stamp) in `quote.clearedNotices[id] = {sig, at}`, so the notice
 * stays cleared while it says the same thing and comes back on its own the
 * moment its content changes (a new kept rate, a later expiry, another
 * library move). Clearing never decides anything — a kept rate stays kept, a
 * prompt still waits — it only hides the band; "show again" restores every
 * cleared notice. The Dashboard's alarm (no project) keeps the same record
 * in this browser (`BROWSER_NOTICES_KEY`).
 */
export const BROWSER_NOTICES_KEY = "gradcon-notices-cleared";

export const NOTICE_IDS = {
  validity: "validity",
  trail: "trail",
  rateChanges: "rateChanges",
  keptRates: "keptRates",
  ratesPinned: "ratesPinned",
  handover: "handover",
};

/** One string for what a notice says, from its parts (order kept, blanks dropped). */
export const noticeSig = (...parts) => parts.flat().filter((p) => p != null && p !== "").map(String).join("|");

export function isNoticeCleared(store, id, sig) {
  const c = store && store[id];
  return !!c && c.sig === sig;
}

/** The store with this notice cleared at its current signature. */
export function clearNotice(store, id, sig, at = new Date().toISOString()) {
  return { ...(store || {}), [id]: { sig, at } };
}

/** The store with one notice (or every notice) restored. */
export function restoreNotices(store, id) {
  if (!id) return {};
  const next = { ...(store || {}) };
  delete next[id];
  return next;
}

export const clearedCount = (store) => Object.keys(store || {}).length;

export function readBrowserNotices(storage = typeof localStorage !== "undefined" ? localStorage : null) {
  try { const raw = storage && storage.getItem(BROWSER_NOTICES_KEY); const v = raw ? JSON.parse(raw) : null; return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export function writeBrowserNotices(store, storage = typeof localStorage !== "undefined" ? localStorage : null) {
  try { if (storage) storage.setItem(BROWSER_NOTICES_KEY, JSON.stringify(store || {})); } catch { /* private mode / quota: the clear lasts the tab */ }
  return store || {};
}
