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
 * a change is PROMPTED the next time it is opened — each changed
 * rate has a tick (Grady, same day: "the actual rates changed should have a
 * checkbox for user to select the applicable rates from the library rather
 * than the entire rates applied to that project"): a ticked rate takes the
 * library's figure, an unticked one is KEPT at the figure the project was
 * estimated with — a library pin holding only the kept keys (`reason:
 * "library"`, laid over the live rates by rateFreeze.effectiveRates, honoured
 * on an OPEN status). `quote.ratesAck = {at, applied, kept}` is the decision;
 * changes older than it (or older than the project itself) never prompt
 * again, a later library move on a kept key asks again. Pure, verify-covered.
 */
import { computeGrandTotal, computeElementCost } from "./costing.js";
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

/** The keys this project keeps at previous figures (its library pin), with
 * the figure each is held at. Empty for a status pin or no pin. */
export function keptRates(quote) {
  if (!isLibraryPin(quote)) return [];
  const rates = quote.ratesFrozen.rates || {};
  return Object.keys(rates).map((key) => ({ key, unitCost: rates[key] && rates[key].unitCost, name: (quote.ratesFrozen.names || {})[key] || key }));
}

/**
 * The library changes this project has not decided on, one per rate key:
 * `from` = what the project prices that key at today (the figure it KEEPS,
 * if it kept one, else the earliest logged previous figure) and `to` = the
 * live rate now. A key that moved and moved back is left out. Empty for a
 * status-pinned project (its copy is untouched by the library) and for a
 * project with no elements (nothing to re-price). A project that kept some
 * previous figures is asked again when the library moves those keys.
 */
export function pendingRateChanges(quote, log, createdAt) {
  if (!quote || (hasFrozenRates(quote) && !isLibraryPin(quote))) return [];
  if (!Array.isArray(quote.items) || !quote.items.length) return [];
  const since = rateAckAt(quote, createdAt);
  const kept = isLibraryPin(quote) ? quote.ratesFrozen.rates || {} : {};
  const byKey = new Map();
  (Array.isArray(log) ? log : []).forEach((e) => {
    if (!e || !(Date.parse(e.at) > since)) return;
    const cur = byKey.get(e.key);
    if (!cur) byKey.set(e.key, { key: e.key, name: e.name || e.key, from: e.from, to: e.to, at: e.at });
    else { cur.to = e.to; cur.at = e.at; }
  });
  byKey.forEach((c) => { if (kept[c.key] && kept[c.key].unitCost != null) c.from = kept[c.key].unitCost; });
  return [...byKey.values()].filter((c) => Number(c.from) !== Number(c.to));
}

/** The project's rates with each change's figure chosen: `to` for a key in
 * `apply`, `from` otherwise — laid over what the project prices at today. */
export function ratesWithChoice(quote, liveRates, changes, apply) {
  const out = { ...(liveRates || {}), ...(isLibraryPin(quote) ? quote.ratesFrozen.rates : {}) };
  const take = new Set(apply || []);
  (changes || []).forEach((c) => { out[c.key] = { ...(out[c.key] || {}), unitCost: take.has(c.key) ? c.to : c.from }; });
  return out;
}

/** The live rates with the previous figures laid back over the changed keys. */
export function previousRates(liveRates, changes) {
  const out = { ...(liveRates || {}) };
  (changes || []).forEach((c) => { out[c.key] = { ...(out[c.key] || {}), unitCost: c.from }; });
  return out;
}

/**
 * Which ELEMENTS each change touches (Grady, 22 Oct 2026: "in each project,
 * list the affected rates within the elements"): for every change, the
 * elements whose direct cost moves when that one key takes the library's
 * figure, with the $ each moves — {key: [{id, label, delta}]}. An element
 * with no quantity on the key is not listed; a change no element carries
 * has an empty list (it re-prices nothing today).
 */
export function rateChangeElements(quote, liveRates, changes) {
  const out = {};
  const items = (quote && quote.items) || [];
  const scope = quote && quote.scope;
  const base = ratesWithChoice(quote, liveRates, changes, []);
  (changes || []).forEach((c) => {
    const one = ratesWithChoice(quote, liveRates, changes, [c.key]);
    out[c.key] = items.map((it, i) => {
      const before = computeElementCost(it, base, scope).total;
      const after = computeElementCost(it, one, scope).total;
      return { id: it.id, label: it.label || `Element ${i + 1}`, delta: after - before };
    }).filter((e) => Math.abs(e.delta) >= 0.005);
  });
  return out;
}

/** The same record turned around: {elementId: [{...change, delta}]}. */
export function elementRateChanges(quote, liveRates, changes) {
  const byKey = rateChangeElements(quote, liveRates, changes);
  const out = {};
  (changes || []).forEach((c) => (byKey[c.key] || []).forEach((e) => { (out[e.id] = out[e.id] || []).push({ ...c, delta: e.delta }); }));
  return out;
}

/** The project's direct cost at the previous figures, and with the ticked
 * changes applied (every change when `apply` is omitted). */
export function rateChangeImpact(quote, liveRates, changes, apply) {
  const items = (quote && quote.items) || [];
  const scope = quote && quote.scope;
  const keys = apply === undefined ? (changes || []).map((c) => c.key) : apply;
  return {
    before: computeGrandTotal(items, ratesWithChoice(quote, liveRates, changes, []), scope),
    after: computeGrandTotal(items, ratesWithChoice(quote, liveRates, changes, keys), scope),
  };
}

/**
 * The decision: the ticked keys (`apply`) take the library's figure — they
 * follow the live rates from here — and every other change is KEPT at its
 * previous figure in the project's library pin ({reason: "library", rates:
 * only the kept keys, laid over the live rates by effectiveRates). Keys the
 * project kept earlier stay kept unless ticked now. An empty pin is dropped.
 */
export function decideRateChangesPatch(quote, liveRates, changes, apply, at = new Date().toISOString()) {
  const take = new Set(apply || []);
  const rates = { ...(isLibraryPin(quote) ? quote.ratesFrozen.rates : {}) };
  const names = { ...((isLibraryPin(quote) && quote.ratesFrozen.names) || {}) };
  (changes || []).forEach((c) => {
    if (take.has(c.key)) { delete rates[c.key]; delete names[c.key]; return; }
    rates[c.key] = { ...((liveRates || {})[c.key] || {}), unitCost: c.from };
    names[c.key] = c.name || c.key;
  });
  const keptKeys = Object.keys(rates);
  return {
    ratesFrozen: keptKeys.length ? { at, status: quote && quote.status, reason: "library", rates, names } : null,
    ratesAck: { at, applied: [...take], kept: keptKeys },
  };
}

/** "Apply the new rates" — every change ticked. */
export function applyRateChangesPatch(quote, liveRates, changes, at = new Date().toISOString()) {
  return decideRateChangesPatch(quote, liveRates, changes, (changes || []).map((c) => c.key), at);
}

/** "Keep the previous rates" — nothing ticked. */
export function keepPreviousRatesPatch(quote, liveRates, changes, at = new Date().toISOString()) {
  return decideRateChangesPatch(quote, liveRates, changes, [], at);
}

/** Release kept figures: the given keys (all when omitted) follow the live
 * rates again; the pin goes when nothing is left in it. */
export function releaseKeptRatesPatch(quote, keys, at = new Date().toISOString()) {
  if (!isLibraryPin(quote)) return {};
  const drop = new Set(keys || Object.keys(quote.ratesFrozen.rates || {}));
  const rates = {}; const names = {};
  Object.keys(quote.ratesFrozen.rates || {}).forEach((k) => { if (!drop.has(k)) { rates[k] = quote.ratesFrozen.rates[k]; if (quote.ratesFrozen.names && quote.ratesFrozen.names[k]) names[k] = quote.ratesFrozen.names[k]; } });
  return { ratesFrozen: Object.keys(rates).length ? { ...quote.ratesFrozen, at, rates, names } : null };
}

export const isLibraryPin = (quote) => !!(quote && hasFrozenRates(quote) && quote.ratesFrozen.reason === "library");
