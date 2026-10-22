/**
 * Grady's trail through a quote (22 Oct 2026: "colour code Grady's inputs
 * going forward. each time grady logs in, activate the colour code. change
 * text colours of his input so he knows what he has worked on and also a
 * checkbox for each element he has worked on so … he will easily see where he
 * left off").
 *
 * Every figure typed on an element records WHO typed it and WHEN —
 * `item.entries[<key>] = {by, at}` where `by` is the signed-in portal account
 * (`userKey`: the part before the @) and the key names the cell:
 *   a catalog quantity → its rate key, a crew cell → "task:<taskId>:<resource>",
 *   a crew row's Qty → "task:<taskId>:qty", a custom row → "add:<id>:<field>".
 * A signed-in user's own entries show in one colour, everyone else's in
 * another (`entryTone`; the colours are theme tokens — Settings can change
 * them). Each element carries a **Done** tick (`item.done = {by, at}`), and
 * `progress(items)` says how many are done, which comes next and what was
 * worked on last, so the editor opens on "where you left off". Nothing here
 * changes a figure; outside the portal (no signed-in account) nothing is
 * stamped.
 */
export const userKey = (email) => {
  const s = String(email || "").trim().toLowerCase();
  return s ? s.split("@")[0] : null;
};

export const ENTRY_KEY = {
  qty: (rateKey) => rateKey,
  cell: (taskId, resKey) => `task:${taskId}:${resKey}`,
  taskQty: (taskId) => `task:${taskId}:qty`,
  additional: (rowId, field) => `add:${rowId}:${field}`,
};

/** The item with this cell's author recorded (no user → unchanged). */
export function markEntry(item, key, by, at = new Date().toISOString()) {
  if (!item || !key || !by) return item;
  return { ...item, entries: { ...(item.entries || {}), [key]: { by, at } } };
}

export function entryOf(item, key) {
  const e = item && item.entries && item.entries[key];
  return e && e.by ? e : null;
}

/** "me" for the signed-in user's own entry, "other" for someone else's, null for none. */
export function entryTone(item, key, me) {
  const e = entryOf(item, key);
  if (!e) return null;
  return me && e.by === me ? "me" : "other";
}

export const isDone = (item) => !!(item && item.done && item.done.at);

export function donePatch(done, by, at = new Date().toISOString()) {
  return { done: done ? { by: by || null, at } : undefined };
}

/** When each element was last worked on (its newest entry or its Done stamp). */
export function lastTouched(item) {
  let best = null;
  Object.values((item && item.entries) || {}).forEach((e) => { if (e && e.at && (!best || e.at > best.at)) best = e; });
  if (item && item.done && item.done.at && (!best || item.done.at > best.at)) best = item.done;
  return best;
}

/** Where the project stands: done / total, the first element not yet done, the one worked on last. */
export function progress(items) {
  const list = items || [];
  const done = list.filter(isDone).length;
  const next = list.find((it) => !isDone(it)) || null;
  let last = null;
  list.forEach((it) => { const t = lastTouched(it); if (t && (!last || t.at > last.at)) last = { item: it, at: t.at, by: t.by || null }; });
  return { done, total: list.length, next, last };
}

/** "today at 4:12 pm" / "Mon 9 Oct at 10:03 am" — local time. */
export function whenLabel(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `today at ${time}`;
  return `${d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
}
