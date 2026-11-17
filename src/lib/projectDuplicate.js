/**
 * Duplicating a project (Boma, 17 Nov 2026: "i want to be able to duplicate projects in quote section").
 * Pure — runs in Node (scripts/verify.mjs). `duplicateQuote(quote, opts)` is the ONE rule of what a copy is:
 *
 *   KEPT — the WORK: every element exactly as it stands (same ids, so the packages, the tender stages, the crew
 *   prefill record and the per-row margins that point at them still do; quantities, typed quote amounts, crew cells,
 *   drawings, done ticks and who-typed stamps), the packages, the assumptions, the margins, scope and on-costs, the
 *   Tender / External quote text, the client, the site address, the deadline and planner fields, the Drive folder
 *   and the attached files (links — nothing is copied in the bucket; a drawing's path is shared, as for a duplicated
 *   element).
 *
 *   DROPPED — the record of things that HAPPENED to the original: the tender checklist's ticks, the RFQ rounds sent,
 *   the notifications to Grady, the day it was completed / submitted, the inbox email it was created from, cleared
 *   notices and one-shot import flags. A copy has had none of that done to it.
 *
 *   STATUS — a copy is OPEN work. An open status (Queued, Taking Off, Estimating, On Hold) is kept; a finished /
 *   sent / closed one becomes the new-project status. A STATUS pin of the rates is dropped with it, so the copy
 *   prices at today's live rates like any open project (`repriced: true` — the Dashboard says so; the original keeps
 *   its pin). Figures the project chose to KEEP against the Rates Library (a "library" pin on an open project) are
 *   that project's decisions and travel with the copy.
 *
 *   CREW PREFILL — a copy never changes a figure on its own. Where the live crew prefill was NOT running on the
 *   original (it had gone out or closed, was on hold, was switched off, or was worked by hand before the prefill
 *   existed), the copy starts with it OFF (`prefillOff: true`) — otherwise opening the copy, now an open project,
 *   would fill the original's blank crew cells. The editor's handover band says so and turns it on in one click.
 */
import { normalizeStatus } from "../data/catalog.js";
import { isRatesLocked } from "./rateFreeze.js";
import { liveHandoverApplies, HANDOVER_LIVE_OFF } from "./handover.js";

/** Fields that record what happened to the ORIGINAL — never carried onto a copy. */
export const COPY_DROPS = ["checklist", "rfqs", "notifications", "submittedAt", "completedAt", "source", "clearedNotices", "importFlags", "copiedFrom"];

const clean = (s) => String(s == null ? "" : s).trim();
/** "<name> (copy)", then "(copy 2)", "(copy 3)" … — never "(copy) (copy)", never a name another project holds. */
export function copyName(name, existingNames = []) {
  const base = clean(name).replace(/\s*\((?:copy)(?:\s+\d+)?\)\s*$/i, "") || "Untitled project";
  const taken = new Set((existingNames || []).map((n) => clean(n).toLowerCase()));
  for (let n = 1; n < 500; n++) {
    const candidate = `${base} (copy${n === 1 ? "" : ` ${n}`})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (copy)`;
}

/** → `{quote, repriced, name}`; null when there is nothing to copy. The source is never mutated. */
export function duplicateQuote(quote, { existingNames = [], today = "", defaultStatus = "Queued", by = null, sourceId = null, at = "" } = {}) {
  if (!quote || typeof quote !== "object") return null;
  const copy = JSON.parse(JSON.stringify(quote));
  for (const k of COPY_DROPS) delete copy[k];
  const name = copyName(quote.projectName, existingNames);
  copy.projectName = name;
  copy.nameReviewedFor = name; // the copy's name is a decision already — the address review never asks about it
  if (today) copy.projectDate = today;
  const status = normalizeStatus(quote.status);
  const locked = isRatesLocked(status);
  copy.status = locked || !status ? defaultStatus : status;
  let repriced = false;
  const pin = quote.ratesFrozen;
  if (pin && pin.reason !== "library") { copy.ratesFrozen = null; delete copy.ratesAck; repriced = true; }
  else if (locked && pin) { copy.ratesFrozen = null; delete copy.ratesAck; repriced = true; }
  const prefillOff = !liveHandoverApplies(quote);
  if (prefillOff) Object.assign(copy, HANDOVER_LIVE_OFF);
  copy.copiedFrom = { projectId: sourceId || null, name: clean(quote.projectName) || "Untitled project", status: status || null, at: at || null, by: by || null };
  return { quote: copy, repriced, prefillOff, name };
}
