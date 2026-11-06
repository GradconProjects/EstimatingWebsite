/**
 * The Quotes app's side of Grady's mate (the figure in the portal's corner —
 * portal/mate.js holds the rules, the shell draws it). An event is ONE write to
 * localStorage under MATE_EVENT_KEY: the blob: iframe shares the shell's origin,
 * so the shell's `storage` listener receives it. Nothing is read back and no
 * figure on the quote changes. Outside the portal (no window) it is a no-op.
 */
export const MATE_EVENT_KEY = "gradcon-mate-event";

export function mateEvent(kind, detail, storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st || !kind) return null;
    const ev = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, kind, detail: detail || {}, at: Date.now() };
    st.setItem(MATE_EVENT_KEY, JSON.stringify(ev));
    return ev;
  } catch { return null; }
}

/** Subcontract quote rows with a quantity and no amount (the same test as notifyGrady / the handover issues). */
export function countUnpricedQuoteRows(items) {
  return (items || []).reduce((acc, it) => acc + Object.entries((it && it.qtys) || {}).filter(([k, v]) => /::quote$/.test(k) && Number(v) > 0 && !(it.rateOverrides && it.rateOverrides[k] && Number(it.rateOverrides[k].unitCost) > 0)).length, 0);
}
