/**
 * Validity dates on the time-limited rates.
 *
 * Supplier surcharges, levies and fees (Holcim's fortnightly Production &
 * Transport Surcharge above all) are published FOR A PERIOD. A rate object
 * may carry `validUntil: "YYYY-MM-DD"` — set in the Rates Library (which
 * syncs it through lib/ratesLibrarySync.js) or in the Rates modal for a row
 * the library does not govern — and this module turns those dates into the
 * alarm the dashboard, the editor, the Rates modal and the library show:
 * expired, or expiring within `warnDays`.
 *
 * Pure module: no React, no DOM — scripts/verify.mjs runs it in Node.
 */
import { FULL_CATALOG } from "../data/catalog.js";
import { rateKey } from "./costing.js";

/** The catalog rows that are time-limited by nature — the ones that get a
 * "Valid until" field. Matched on the product NAME so a new fee row picks
 * it up without a list to maintain. */
export const TIME_LIMITED_MATCH = /surcharge|levy|cartage|washout|short-load|delivery beyond|delivery fee/i;
export const isTimeLimited = (name) => TIME_LIMITED_MATCH.test(String(name || ""));

/** Days before expiry at which the alarm starts. */
export const VALIDITY_WARN_DAYS = 14;

/** Normalises "today" to a date-only timestamp so two dates compare by day. */
const dayStart = (d) => { const x = d instanceof Date ? new Date(d) : new Date(d || Date.now()); x.setHours(0, 0, 0, 0); return x.getTime(); };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses "YYYY-MM-DD" as a LOCAL date (new Date("2026-09-30") would be UTC
 * midnight — the day before, in Melbourne). Returns null when unreadable. */
export function parseValidUntil(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** { state: "ok" | "expiring" | "expired" | "none", daysLeft } for one date. */
export function validityState(validUntil, today = new Date(), warnDays = VALIDITY_WARN_DAYS) {
  const d = parseValidUntil(validUntil);
  if (!d) return { state: "none", daysLeft: null };
  const daysLeft = Math.round((dayStart(d) - dayStart(today)) / DAY_MS);
  if (daysLeft < 0) return { state: "expired", daysLeft };
  if (daysLeft <= warnDays) return { state: "expiring", daysLeft };
  return { state: "ok", daysLeft };
}

/** Every time-limited catalog rate with a date: [{ key, name, catKey, unit,
 * validUntil, state, daysLeft, unitCost }], expired first, then soonest. */
export function ratesWithValidity(rates, today = new Date(), warnDays = VALIDITY_WARN_DAYS) {
  const out = [];
  FULL_CATALOG.forEach((cat) => cat.products.forEach((p) => {
    if (!isTimeLimited(p.name)) return;
    const key = rateKey(cat.key, p.name, p.unit);
    const r = rates && rates[key];
    if (!r || !r.validUntil) return;
    const v = validityState(r.validUntil, today, warnDays);
    if (v.state === "none") return;
    out.push({ key, name: p.name, catKey: cat.key, unit: p.unit, validUntil: r.validUntil, unitCost: r.unitCost, ...v });
  }));
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** The alarm list: only the expired and expiring ones. */
export function expiringRates(rates, today = new Date(), warnDays = VALIDITY_WARN_DAYS) {
  return ratesWithValidity(rates, today, warnDays).filter((r) => r.state !== "ok");
}

/** "expired 3 days ago" / "expires today" / "expires in 5 days". */
export function validityLabel(entry) {
  const n = entry.daysLeft;
  if (n == null) return "";
  if (n < 0) return `expired ${-n} day${n === -1 ? "" : "s"} ago`;
  if (n === 0) return "expires today";
  return `expires in ${n} day${n === 1 ? "" : "s"}`;
}

/** "30 Sep 2026" for a stored date, or the raw text if it will not parse. */
export function formatValidUntil(s) {
  const d = parseValidUntil(s);
  return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : String(s || "");
}
