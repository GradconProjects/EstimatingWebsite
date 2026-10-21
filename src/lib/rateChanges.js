/**
 * Rates Library changes and the per-project decision they call for.
 *
 * Grady, 21 Oct 2026: "entries made in rates library should automatically
 * update where applicable" and "it should prompt for existing projects if
 * the new rates entered should be updated or applied". The first half is
 * lib/ratesLibrarySync.js (the library writes the live rates on its own).
 * This module is the second half: every figure the library moves is
 * RECORDED here ({at, key, name, from, to}, a cloud-shared log under
 * RATE_CHANGES_KEY, capped), and an existing project that was priced before
 * a change is PROMPTED the next time it is opened — "Apply the new rates"
 * (it already prices at them; the prompt is acknowledged) or "Keep the
 * previous rates" (a pin of the figures it was estimated with, `reason:
 * "library"`, honoured on an OPEN status too — see rateFreeze.effectiveRates).
 * `quote.ratesAck = {at, kept}` is the decision; changes older than it (or
 * older than the project itself) never prompt again. Pure, verify-covered.
 */
import { computeGrandTotal } from "./costing.js";
import { hasFrozenRates } from "./rateFreeze.js";

export const RATE_CHANGES_KEY = "gradcon-rates-changes";
export const MAX_RATE_CHANGES = 400;

/** Append the figures a library sync just moved. A repeat of the same move
 * within ten minutes (two browsers applying the same library edit) is one
 * entry. Newest last; the log is trimmed from the front. */
export function recordRateChanges(log, updates, at = new Date().toISOString()) {
  const base = Array.isArray(log) ? log : [];
  const fresh = [];
  (updates || []).forEach((u) => {
    if (!u || u.price === undefined || u.from === undefined) return;
    if (Number(u.from) === Number(u.price)) return;
    const dup = base.concat(fresh).some((e) => e.key === u.key && Number(e.from) === Number(u.from) && Number(e.to) === Number(u.price) && Math.abs(Date.parse(e.at) - Date.parse(at)) < 10 * 60 * 1000);
    if (dup) return;
    fresh.push({ at, key: u.key, name: u.name || u.key, from: Number(u.from), to: Number(u.price) });
  });
  if (!fresh.length) return base;
  const next = base.concat(fresh);
  return next.length > MAX_RATE_CHANGES ? next.slice(next.length - MAX_RATE_CHANGES) : next;
}

/** The moment this project last decided on library changes (its ack), else
 * the moment it was created — nothing older than that can concern it. */
export function rateAckAt(quote, createdAt) {
  const ack = quote && quote.ratesAck && quote.ratesAck.at;
  const t = Date.parse(ack || createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * The library changes this project has not decided on, one per rate key:
 * the earliest `from` (what it was priced at) and the latest `to` (what the
 * live rate is now); a key that moved and moved back is left out. Empty for
 * a pinned project (its copy is untouched by the library) and for a project
 * with no elements (nothing to re-price).
 */
export function pendingRateChanges(quote, log, createdAt) {
  if (!quote || hasFrozenRates(quote)) return [];
  if (!Array.isArray(quote.items) || !quote.items.length) return [];
  const since = rateAckAt(quote, createdAt);
  const byKey = new Map();
  (Array.isArray(log) ? log : []).forEach((e) => {
    if (!e || !(Date.parse(e.at) > since)) return;
    const cur = byKey.get(e.key);
    if (!cur) byKey.set(e.key, { key: e.key, name: e.name || e.key, from: e.from, to: e.to, at: e.at });
    else { cur.to = e.to; cur.at = e.at; }
  });
  return [...byKey.values()].filter((c) => Number(c.from) !== Number(c.to));
}

/** The live rates with the previous figures laid back over the changed keys. */
export function previousRates(liveRates, changes) {
  const out = { ...(liveRates || {}) };
  (changes || []).forEach((c) => { out[c.key] = { ...(out[c.key] || {}), unitCost: c.from }; });
  return out;
}

/** The project's direct cost at the previous figures and at today's. */
export function rateChangeImpact(quote, liveRates, changes) {
  const items = (quote && quote.items) || [];
  const scope = quote && quote.scope;
  return { before: computeGrandTotal(items, previousRates(liveRates, changes), scope), after: computeGrandTotal(items, liveRates || {}, scope) };
}

/** "Apply the new rates": the project goes on pricing at the live rates; the
 * changes are acknowledged so they never prompt again. */
export function applyRateChangesPatch(at = new Date().toISOString()) {
  return { ratesAck: { at, kept: false } };
}

/** "Keep the previous rates": pin the figures the project was estimated with
 * (the live rates with every pending change reverted) under reason
 * "library" — honoured whatever the status — and acknowledge. */
export function keepPreviousRatesPatch(quote, liveRates, changes, at = new Date().toISOString()) {
  return {
    ratesFrozen: { at, status: quote && quote.status, reason: "library", rates: previousRates(liveRates, changes) },
    ratesAck: { at, kept: true },
  };
}

export const isLibraryPin = (quote) => !!(quote && hasFrozenRates(quote) && quote.ratesFrozen.reason === "library");
