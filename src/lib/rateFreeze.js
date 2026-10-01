/**
 * Rates on a finished project are PINNED.
 *
 * Rates (`gradcon-rates`) are one shared object for the whole office: a
 * change in the Rates Library, the Rates modal or an in-place edit on a card
 * reaches every project that reads the live object. That is what an open
 * estimate wants — the fuel surcharge Holcim announced this fortnight should
 * price this week's jobs — but a quote that has already gone out must not
 * quietly re-cost itself when the next surcharge lands.
 *
 * So the moment a project's status moves into a "finished" state (Completed
 * Estimating onwards — see RATES_LOCKED_STATUSES) a full copy of the live
 * rates is written onto the quote as `quote.ratesFrozen = { at, status,
 * rates }`, and from then on every costing call for that project reads the
 * copy (`effectiveRates`). Moving back to an open status drops the copy and
 * the project follows the live rates again. Nothing about a pinned project
 * changes automatically; "Re-price with current rates" in the editor replaces
 * the copy deliberately.
 *
 * Pure module: no React, no DOM — scripts/verify.mjs runs it in Node.
 */
import { isSubmittedStatus } from "./planner.js";

/** Today as the "YYYY-MM-DD" the deadline fields use (local day). */
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Statuses whose projects keep their own copy of the rates. "On Hold" is
 * not finished — a project on hold follows the live rates like an open one. */
export const RATES_LOCKED_STATUSES = ["Completed Estimating", "Quoting", "Submitted", "Tendered", "Successful", "Unsuccessful"];

export const isRatesLocked = (status) => RATES_LOCKED_STATUSES.includes(status);

/** Does this quote carry a usable pinned copy? */
export const hasFrozenRates = (quote) =>
  !!(quote && quote.ratesFrozen && quote.ratesFrozen.rates && typeof quote.ratesFrozen.rates === "object");

/**
 * The rates a project should be costed with: its pinned copy while its
 * status is a locked one, else the live rates. The copy is laid OVER the live
 * object so a product added to the catalog after the pin still resolves
 * (through the live rate, then the catalog default) instead of pricing blank.
 */
export function effectiveRates(quote, liveRates) {
  const live = liveRates || {};
  if (!quote || !isRatesLocked(quote.status) || !hasFrozenRates(quote)) return live;
  return { ...live, ...quote.ratesFrozen.rates };
}

/** A fresh pinned copy of `liveRates` stamped with when and why. */
export function freezeRates(liveRates, status, at = new Date().toISOString()) {
  return { at, status, rates: { ...(liveRates || {}) } };
}

/**
 * The ONE way a status change is applied to a quote — the editor's status
 * select and the dashboard's status dropdown both go through here so the
 * pin can never be missed by one of them.
 *
 *   open → locked : pin the live rates now
 *   locked → locked: keep the existing pin (a project moving Submitted →
 *                    Successful must not re-price on the way)
 *   locked → open : drop the pin, follow the live rates again
 *
 * Returns the fields that changed, ready for a setQuote merge or a
 * patchQuoteFields call (`ratesFrozen: null` clears it in either).
 */
export function statusChangePatch(quote, nextStatus, liveRates, at) {
  const wasLocked = isRatesLocked(quote && quote.status);
  const willLock = isRatesLocked(nextStatus);
  const patch = { status: nextStatus };
  if (willLock && !(wasLocked && hasFrozenRates(quote))) patch.ratesFrozen = freezeRates(liveRates, nextStatus, at);
  else if (!willLock && quote && quote.ratesFrozen) patch.ratesFrozen = null;
  // The deadline clock stops the day the quote goes out (lib/planner.js):
  // entering Submitted (or later) from an open status records the day; a
  // move between submitted statuses keeps it; moving back to an open status
  // clears it so the countdown runs again.
  const wasSubmitted = isSubmittedStatus(quote && quote.status) && !!(quote && quote.submittedAt);
  const willSubmit = isSubmittedStatus(nextStatus);
  if (willSubmit && !wasSubmitted) patch.submittedAt = at ? localDay(new Date(at)) : localDay();
  else if (!willSubmit && quote && quote.submittedAt) patch.submittedAt = null;
  return patch;
}

/** A project already in a locked status but without a pin (it was finished
 * before pins existed, or was patched by an older build) gets one the first
 * time it is opened — that is the moment its figures stop moving. */
export function needsFreeze(quote) {
  return !!quote && isRatesLocked(quote.status) && !hasFrozenRates(quote);
}

/** Which pinned rates no longer match the live ones: [{ key, pinned, live }].
 * Only compares `unitCost` — weights, sheet areas and validity dates are
 * catalog facts, not prices. */
export function frozenRateDrift(quote, liveRates) {
  if (!hasFrozenRates(quote)) return [];
  const pinned = quote.ratesFrozen.rates;
  const live = liveRates || {};
  const out = [];
  Object.keys(pinned).forEach((key) => {
    const a = pinned[key] && pinned[key].unitCost;
    const b = live[key] && live[key].unitCost;
    if (a == null || b == null) return;
    if (Number(a) !== Number(b)) out.push({ key, pinned: Number(a), live: Number(b) });
  });
  return out;
}
