/**
 * Pure helpers for the Planner tab's deadline/priority logic — shared by
 * PlannerView.jsx and Dashboard.jsx (both need the same "is this urgent"
 * read of a project's deadline) so the two views can never quietly
 * disagree about which projects need attention.
 */
import { PLANNER_PRIORITIES } from "../data/catalog.js";

/** True when a project needs attention soon: Urgent/High priority, or a
 * deadline within the next 7 days (including already overdue). Everything
 * else is safe to defer — this is the whole "which to attend to and which
 * to defer" grouping the Planner exists for. */
export function isUrgent(planner) {
  if (!planner) return false;
  if (planner.priority === "Urgent" || planner.priority === "High") return true;
  if (planner.deadline) {
    const days = (new Date(planner.deadline) - new Date()) / 86400000;
    if (days <= 7) return true;
  }
  return false;
}

export function daysLabel(deadline) {
  if (!deadline) return null;
  const days = Math.ceil((new Date(deadline) - new Date()) / 86400000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, cls: "text-red-600 font-semibold" };
  if (days === 0) return { text: "Due today", cls: "text-red-600 font-semibold" };
  if (days <= 7) return { text: `Due in ${days}d`, cls: "text-orange-600 font-medium" };
  return { text: `Due in ${days}d`, cls: "text-neutral-400" };
}

export const priorityRank = (p) =>
  PLANNER_PRIORITIES.indexOf(p) === -1 ? PLANNER_PRIORITIES.length : PLANNER_PRIORITIES.indexOf(p);
