/**
 * The Estimator Tender Workflow, as a checklist ON EACH PROJECT (Grady,
 * 22 Oct 2026, from his printed "Estimator Tender Workflow — 11-step process,
 * from tender receipt to final filing" with his pen notes: "In each project
 * always rolled up, I want to create a checklist form. After 05 add another
 * row … quote received. Both should have date. It should live on each
 * project but shouldn't be imposing").
 *
 * `TENDER_STEPS` is the ONE list — the printed eleven, in their order, plus
 * "Subcontractor quotes received" right after 05 (the RFQs go out on 05, the
 * answers come back on 05b; each carries its own date). The pen notes are
 * folded into the step details: 02 "to Grady or the sender", 03 "set up",
 * 05 "be clear on who — get the priority list". The ids never change: a
 * project's ticks are stored under them.
 *
 * `quote.checklist[stepId] = {done, at, by, note}` — `done` true/false, `at`
 * a local "YYYY-MM-DD" (stamped the day the box is ticked, editable),
 * `by` the signed-in portal account (`userKey`), `note` free text where the
 * step asks for one (who was asked, who answered). Ticking changes no figure
 * on the quote; the checklist is a record, never a lock.
 */
export const TENDER_STEPS = [
  { id: "receive", n: "01", title: "Receive tender", detail: "Check invitation, due date and documents." },
  { id: "acknowledge", n: "02", title: "Acknowledge receipt", detail: "Reply by email confirming tender received — to Grady or the sender." },
  { id: "upload", n: "03", title: "Upload tender documents", detail: "Save all plans and specifications in Gradcon web storage for Grady (set up the project folder)." },
  { id: "review", n: "04", title: "Initial project review", detail: "Understand scope, scale, complexity and construction requirements." },
  { id: "rfq", n: "05", title: "Request subcontractor pricing", detail: "Issue RFQs as needed: CFA/screw piling, formwork, post-tensioning and specialists. Be clear on who — get the priority list.", note: "Who was asked" },
  { id: "rfq_received", n: "05b", title: "Subcontractor quotes received", detail: "Every quote requested on 05 has come back; chase the ones still out.", note: "Who has returned / still out" },
  { id: "takeoff", n: "06", title: "Take-offs and price all works", detail: "Price concrete structures, footings, slabs, external and feature works, and all tender scope." },
  { id: "costings", n: "07", title: "Prepare costings", detail: "Compile estimate, take-offs, subcontractor quotes, assumptions and exclusions." },
  { id: "notify", n: "08", title: "Notify Grady", detail: "Advise that costings are ready, with time allowed for review." },
  { id: "approval", n: "09", title: "Grady review and approval", detail: "Grady reviews scope, margins and price. Revise and resubmit if required." },
  { id: "submit", n: "10", title: "Submit quotation", detail: "Send approved quote to nominated client/builder before the deadline." },
  { id: "file", n: "11", title: "File and update register", detail: "Save final quote, take-offs, marked-up plans and supporting prices; log submission." },
];

export const KEY_CONTROL_POINTS = [
  "No quotation submitted without Grady approval.",
  "Flag unclear scope, missing information or significant risks.",
  "Keep all supporting documentation traceable and on file.",
];

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const stepState = (quote, id) => (quote && quote.checklist && quote.checklist[id]) || null;
export const isStepDone = (quote, id) => { const s = stepState(quote, id); return !!(s && s.done); };

/** done / total, the first step not yet ticked (in order), the newest tick. */
export function checklistProgress(quote) {
  const total = TENDER_STEPS.length;
  let done = 0, next = null, last = null;
  TENDER_STEPS.forEach((st) => {
    const s = stepState(quote, st.id);
    if (s && s.done) { done += 1; if (!last || String(s.at || "") > String(last.at || "")) last = { ...st, ...s }; }
    else if (!next) next = st;
  });
  return { done, total, next, last, complete: done === total };
}

/** The patch that ticks / unticks a step, dates it, or notes it. A tick with no date is dated today; an untick keeps the date and note so re-ticking restores them. */
export function checklistPatch(quote, id, change, by = null, today = localDay()) {
  if (!TENDER_STEPS.some((s) => s.id === id)) return {};
  const prev = stepState(quote, id) || {};
  const next = { ...prev };
  if (change && Object.prototype.hasOwnProperty.call(change, "done")) {
    next.done = !!change.done;
    if (next.done) { next.at = next.at || today; next.by = by || next.by || null; }
  }
  if (change && Object.prototype.hasOwnProperty.call(change, "at")) next.at = change.at || null;
  if (change && Object.prototype.hasOwnProperty.call(change, "note")) next.note = String(change.note || "");
  return { checklist: { ...((quote && quote.checklist) || {}), [id]: next } };
}
