/**
 * projectSort.js — the ONE sort rule for every project list.
 *
 * The Dashboard table, the Project Management planner and the Vault's project
 * folders all list the same projects; before 2 Oct 2026 only the Dashboard
 * could be sorted, and only by a handful of keys (Grady: "this page and
 * others should have a sorting feature according to date completed, date
 * added … and other pages"). Every list now hands its rows to
 * `sortProjects(rows, key, dir)`, so a sort chosen on one page means the
 * same thing on the next.
 *
 * Pure: no React, no DOM — `scripts/verify.mjs` exercises it directly.
 *
 * A row is `{ project: {createdAt}, name, client, date, deadline,
 * completedAt, submittedAt, status, sellExGst, directCost, elementCount }`
 * (the Dashboard's summary row; the planner and the vault build the same
 * shape without the costed figures). Dates are "YYYY-MM-DD" days or ISO
 * stamps; a row without the chosen date ALWAYS sinks to the bottom, whatever
 * the direction, so "Date completed" never opens on a wall of unfinished
 * projects.
 */
import { QUOTE_STATUSES } from "../data/catalog.js";

/** Every sort a project list offers, in menu order. `dir` is the direction
 * the key opens on (newest / soonest / highest first, names A→Z); `costed`
 * marks keys only the Dashboard can sort by (it is the one page that prices
 * the rows). */
export const PROJECT_SORTS = [
  { key: "added", label: "Date added", dir: "desc" },
  { key: "completed", label: "Date completed", dir: "desc" },
  { key: "submitted", label: "Date submitted", dir: "desc" },
  { key: "deadline", label: "Deadline (soonest first)", dir: "asc" },
  { key: "date", label: "Project date", dir: "desc" },
  { key: "name", label: "Project name", dir: "asc" },
  { key: "client", label: "Client", dir: "asc" },
  { key: "status", label: "Status (pipeline order)", dir: "asc" },
  { key: "value", label: "Value (sell)", dir: "desc", costed: true },
  { key: "cost", label: "Direct cost", dir: "desc", costed: true },
  { key: "elements", label: "Elements", dir: "desc", costed: true },
];

export const isProjectSortKey = (key) => PROJECT_SORTS.some((o) => o.key === key);

/** The direction a key opens on ("desc" for the dates, values and counts,
 * "asc" for names, clients, deadlines and the pipeline). */
export function defaultSortDir(key) {
  const o = PROJECT_SORTS.find((s) => s.key === key);
  return o ? o.dir : "asc";
}

const time = (s) => {
  if (!s) return null;
  const n = Date.parse(String(s));
  return Number.isFinite(n) ? n : null;
};
const str = (s) => String(s || "").trim().toLowerCase();

/** The comparable value a row sorts by for `key`: a number (dates as epoch
 * ms, money, counts, pipeline position), a lower-cased string, or `null`
 * when the row has nothing for that key (missing dates sink; a missing
 * name/client reads as ""). */
export function sortValue(row, key) {
  switch (key) {
    case "added": return time(row.project && row.project.createdAt);
    case "completed": return time(row.completedAt);
    case "submitted": return time(row.submittedAt);
    case "deadline": return time(row.deadline);
    case "date": return time(row.date);
    case "name": return str(row.name);
    case "client": return str(row.client);
    case "status": { const i = QUOTE_STATUSES.indexOf(row.status); return i < 0 ? QUOTE_STATUSES.length : i; }
    case "value": return Number(row.sellExGst) || 0;
    case "cost": return Number(row.directCost) || 0;
    case "elements": return Number(row.elementCount) || 0;
    default: return null;
  }
}

/** A new array of `rows` ordered by `key` in `dir` ("asc" | "desc"; the
 * key's own default when omitted). Stable; ties break on the project name
 * A→Z, then on the original order. Rows with no value for a date key go
 * last in either direction. */
export function sortProjects(rows, key, dir) {
  const d = dir === "asc" || dir === "desc" ? dir : defaultSortDir(key);
  const sign = d === "asc" ? 1 : -1;
  return (rows || [])
    .map((row, i) => ({ row, i, v: sortValue(row, key), n: str(row.name) }))
    .sort((a, b) => {
      if (a.v == null && b.v == null) return a.n.localeCompare(b.n) || a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      let c = 0;
      if (typeof a.v === "string" || typeof b.v === "string") c = String(a.v).localeCompare(String(b.v));
      else c = a.v - b.v;
      return (c * sign) || a.n.localeCompare(b.n) || a.i - b.i;
    })
    .map((x) => x.row);
}

/** The sort key saved under the portal Settings "Dashboard sort order"
 * preference, or `fallback` when nothing valid is stored. */
export function preferredSortKey(prefs, fallback = "added") {
  const k = prefs && prefs.quotesDefaultSort;
  return isProjectSortKey(k) ? k : fallback;
}
