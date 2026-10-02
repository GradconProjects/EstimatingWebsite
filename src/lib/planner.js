/**
 * Pure helpers for the Planner tab's deadline/priority logic — shared by
 * PlannerView.jsx and Dashboard.jsx (both need the same "is this urgent"
 * read of a project's deadline) so the two views can never quietly
 * disagree about which projects need attention.
 */
import { PLANNER_PRIORITIES } from "../data/catalog.js";

/** Once a quote is SUBMITTED (and through Tendered / Successful /
 * Unsuccessful) its deadline clock stops: the days are counted to the day it
 * went out (`quote.submittedAt`, written by statusChangePatch in
 * lib/rateFreeze.js), never to today — Grady, 1 Oct 2026: "when a quote is
 * submitted, the days overdue should cease counting". */
export const SUBMITTED_STATUSES = ["Submitted", "Tendered", "Successful", "Unsuccessful"];

/** The dashboard's opening view: the work still in hand. Everything else —
 * a finished estimate, a quote that has gone out, the won and the lost —
 * sits under its own status tile and under "All projects" (Dashboard.jsx). */
export const OPEN_STATUSES = ["Queued", "Estimating"];
export const isSubmittedStatus = (status) => SUBMITTED_STATUSES.includes(status);

const dayDiff = (a, b) => Math.ceil((new Date(a) - new Date(b)) / 86400000);

/** "1 Oct 2026" for a stored "YYYY-MM-DD" (parsed as a LOCAL day). */
export function formatDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return String(s || "");
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/** The frozen label for a submitted quote: the DAY it went out ("Submitted
 * 1 Oct 2026" — Grady, 2 Oct 2026: the date, not the word), with how it
 * landed against its deadline as the `note` (shown on hover): "2d early",
 * "on the day", "3d late". A quote submitted before the day was recorded
 * (older data) just reads "Submitted" — no date or count is invented. */
export function submittedLabel(deadline, submittedAt) {
  if (!submittedAt) return { text: "Submitted", note: "", days: null, cls: "text-neutral-500" };
  const text = `Submitted ${formatDay(submittedAt)}`;
  if (!deadline) return { text, note: "no deadline was set", days: null, cls: "text-neutral-600" };
  const days = dayDiff(deadline, submittedAt);
  if (days < 0) return { text, note: `${Math.abs(days)}d after the ${formatDay(deadline)} deadline`, days, cls: "text-red-500" };
  if (days === 0) return { text, note: "on the deadline day", days, cls: "text-green-700" };
  return { text, note: `${days}d before the ${formatDay(deadline)} deadline`, days, cls: "text-green-700" };
}

/** Overdue = past its deadline AND not yet submitted. */
export function isOverdue(quote, today = new Date().toISOString().slice(0, 10)) {
  if (!quote || !quote.planner || !quote.planner.deadline) return false;
  if (isSubmittedStatus(quote.status)) return false;
  return quote.planner.deadline < today;
}

/** True when a project needs attention soon: Urgent/High priority, or a
 * deadline within the next 7 days (including already overdue). Everything
 * else is safe to defer — this is the whole "which to attend to and which
 * to defer" grouping the Planner exists for. */
export function isUrgent(planner, status) {
  if (!planner) return false;
  if (isSubmittedStatus(status)) return false;   // the quote has gone out — nothing left to attend to by its deadline
  if (planner.priority === "Urgent" || planner.priority === "High") return true;
  if (planner.deadline) {
    const days = (new Date(planner.deadline) - new Date()) / 86400000;
    if (days <= 7) return true;
  }
  return false;
}

export function daysLabel(deadline, status, submittedAt) {
  if (isSubmittedStatus(status)) { const f = submittedLabel(deadline, submittedAt); return { text: f.text, title: f.note, cls: `${f.cls} font-medium` }; }
  if (!deadline) return null;
  const days = Math.ceil((new Date(deadline) - new Date()) / 86400000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, cls: "text-red-600 font-semibold" };
  if (days === 0) return { text: "Due today", cls: "text-red-600 font-semibold" };
  if (days <= 7) return { text: `Due in ${days}d`, cls: "text-orange-600 font-medium" };
  return { text: `Due in ${days}d`, cls: "text-neutral-400" };
}

/** Dashboard's own compact deadline styling — italic green until 3 days
 * out (inclusive), red from there through overdue. Deliberately a
 * different colour scheme from daysLabel (Planner's own red/orange/grey
 * urgency read): the Dashboard row is a narrower "at a glance" column,
 * not the Planner's full urgency triage. */
export function dashboardDueLabel(deadline, status, submittedAt) {
  if (isSubmittedStatus(status)) { const f = submittedLabel(deadline, submittedAt); return { text: f.text, title: f.note, cls: `italic ${f.cls}` }; }
  if (!deadline) return null;
  const days = Math.ceil((new Date(deadline) - new Date()) / 86400000);
  const text = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Due today" : `Due in ${days}d`;
  const cls = days <= 3 ? "italic text-red-600 font-semibold" : "italic text-green-600 font-medium";
  return { text, cls };
}

export const priorityRank = (p) =>
  PLANNER_PRIORITIES.indexOf(p) === -1 ? PLANNER_PRIORITIES.length : PLANNER_PRIORITIES.indexOf(p);
