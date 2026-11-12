/**
 * How an id-keyed list (the projects index, the custom element types) is
 * merged with the cloud copy before this browser saves it. Pure — no React,
 * no storage — so scripts/verify.mjs runs it directly.
 *
 * 13 Nov 2026 ("there is an untitled project clicking underneath the listed
 * projects"): the save used to UNION the two lists whenever the cloud row's
 * stamp differed from the one this tab last synced — and it compared the
 * stamps as text. PostgREST answers "2026-11-12T20:55:51.17+00:00", the tab
 * had stored "2026-11-12T20:55:51.170Z" after its own save, so the two never
 * matched and every save merged. A union cannot tell "I removed this" from
 * "someone else added this": a deleted or pruned index entry was put straight
 * back by the tab's own save, the Dashboard pruned it again, the save put it
 * back … about 1,800 index saves an hour, and an "Untitled project" row
 * flickering under the list.
 *
 * The merge is THREE-WAY: `base` is the set of ids this tab last knew to be
 * in the cloud (what it loaded, what a poll delivered, what it last saved).
 *   - in base, gone locally          → removed HERE: it stays removed;
 *   - in base, gone from the cloud   → removed ELSEWHERE: dropped here too;
 *   - in the cloud, never seen here  → added elsewhere: kept;
 *   - only here                      → added here: kept.
 * With no base (nothing synced yet) it is the old union. A cloud copy that
 * has lost a large share of the list is never read as "all removed" — that
 * shape is a clobbered row, and the union heals it.
 */
export const idOf = (item) => (item && item.id != null ? String(item.id) : null);

export function idSet(list) {
  const s = new Set();
  (Array.isArray(list) ? list : []).forEach((item) => { const id = idOf(item); if (id != null) s.add(id); });
  return s;
}

/** Removals read off the cloud are honoured only up to this many, or half the list. */
export const REMOTE_REMOVALS_MAX = 5;

export function mergeById(local, remote, base) {
  const L = Array.isArray(local) ? local : [];
  const R = Array.isArray(remote) ? remote : [];
  const known = base instanceof Set ? base : null;
  const localIds = idSet(L), remoteIds = idSet(R);
  let goneRemotely = known ? L.map(idOf).filter((id) => id != null && known.has(id) && !remoteIds.has(id)) : [];
  if (goneRemotely.length > Math.max(REMOTE_REMOVALS_MAX, Math.floor(L.length / 2))) goneRemotely = []; // a clobbered cloud copy, not a clean-up
  const drop = new Set(goneRemotely);
  const merged = L.filter((item) => { const id = idOf(item); return id == null || !drop.has(id); });
  const added = [];
  R.forEach((item) => {
    const id = idOf(item);
    if (id == null || localIds.has(id)) return;   // this tab's copy of a shared entry stands
    if (known && known.has(id)) return;           // seen before and no longer here: removed here
    merged.push(item); added.push(id);
  });
  return { merged, added, dropped: goneRemotely, changed: added.length > 0 || goneRemotely.length > 0 };
}

/** A timestamp as milliseconds, whatever its spelling ("…51.17+00:00", "…51.170Z"); null when unreadable. */
export function stampMs(stamp) {
  if (stamp == null || stamp === "") return null;
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? t : null;
}

/** True when `remote` is no newer than the stamp this tab holds (nothing held = it IS newer). */
export function stampNotNewer(remote, held) {
  if (!held) return false;
  const r = stampMs(remote), h = stampMs(held);
  if (r == null || h == null) return String(remote) <= String(held);
  return r <= h;
}
