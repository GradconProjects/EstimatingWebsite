import { useState } from "react";
import { handoverIssues, handoverSummary, HANDOVER_STATUS } from "../lib/handover.js";
import { isRatesLocked } from "../lib/rateFreeze.js";

/**
 * The handover banner — shown once a project is Completed Estimating (or
 * later), or whenever a handover prefill exists. It says what the prefill
 * wrote (every one of those cells stays editable and is tinted on the crew
 * sheet), offers Undo / Prefill again, and lists what still needs Grady's
 * hand: subcontract quote rows with a quantity but no amount (they price at
 * $0), half-typed additional items, estimator-note element names with a
 * one-click rename, and the on-cost settings he changes before a tender.
 */
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

export default function HandoverBanner({ quote, items, elementTypes, onPrefill, onUndo, onRenameItem, onSetOnCosts }) {
  const [undoArmed, setUndoArmed] = useState(false);
  const h = quote.handover;
  const applied = !!(h && !h.undoneAt);
  if (!applied && !isRatesLocked(quote.status)) return null;
  const issues = handoverIssues(items, elementTypes);
  const oh = Number(quote.overheadPct) || 0, cont = Number(quote.contingencyPct) || 0;
  const presets = [[0, 0], [0, 0.1], [0.08, 0.05]].filter(([a, b]) => Math.abs(a - oh) > 1e-9 || Math.abs(b - cont) > 1e-9);
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 text-[12px] text-amber-950 space-y-1.5" role="status" data-testid="handover-banner">
      <div className="flex items-start justify-between gap-3">
        <div>
          <b>Handover prefill</b>{" "}
          {applied ? (
            <>applied {fmtDay(h.at)}: {handoverSummary(h)}. Every figure is yours to change — prefilled cells are tinted on each crew sheet; a cell you retype stops being "prefilled".</>
          ) : h && h.undoneAt ? (
            <>undone {fmtDay(h.undoneAt)}. Blank crew cells can be prefilled again from the handover bands in the Rates Library.</>
          ) : (
            <>not run on this project (completed before the prefill existed, or still {HANDOVER_STATUS === quote.status ? "to run" : "open"}). It fills blank crew cells only, from the "Handover" bands in the Rates Library.</>
          )}
        </div>
        <div className="flex items-center gap-2 flex-none">
          {applied && (
            <button
              type="button"
              onClick={() => { if (!undoArmed) { setUndoArmed(true); setTimeout(() => setUndoArmed(false), 4000); return; } setUndoArmed(false); onUndo(); }}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold ${undoArmed ? "bg-red-600 hover:bg-red-700 text-white" : "border border-amber-400 hover:bg-amber-100 text-amber-900"}`}
              title="Clear the prefilled cells that still hold their prefilled figure (anything you changed stays)"
            >
              {undoArmed ? "Confirm — undo prefill" : "Undo prefill"}
            </button>
          )}
          <button type="button" onClick={onPrefill} className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-800 hover:bg-amber-700 text-white" title="Fill blank crew cells from the handover bands (typed cells are never overwritten)">
            {applied ? "Prefill again (blank cells only)" : "Prefill crew sheets now"}
          </button>
        </div>
      </div>
      {issues.unpricedQuoteRows.length > 0 && (
        <div className="text-red-800" data-testid="handover-unpriced">
          <b>{issues.unpricedQuoteRows.length} subcontract quote row{issues.unpricedQuoteRows.length === 1 ? "" : "s"} price at $0</b> — a quantity is entered but no amount:{" "}
          {issues.unpricedQuoteRows.map((r) => `${r.label} — ${r.product} (${r.qty})`).join("; ")}. Type the received quote on the row's amount cell.
        </div>
      )}
      {issues.halfEnteredAdditional.length > 0 && (
        <div className="text-amber-900" data-testid="handover-half">
          <b>{issues.halfEnteredAdditional.length} additional item{issues.halfEnteredAdditional.length === 1 ? "" : "s"} typed halfway</b> (cost $0 until complete):{" "}
          {issues.halfEnteredAdditional.map((a) => `${a.label} — "${a.name || "(no name)"}" missing ${a.missing.join(", ")}`).join("; ")}.
        </div>
      )}
      {issues.labelSuggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="handover-renames">
          <span><b>Element names that read as estimating notes:</b></span>
          {issues.labelSuggestions.map((s) => (
            <button key={s.itemId} type="button" onClick={() => onRenameItem(s.itemId, s.to)} className="px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-100 text-[11px]" title={`Rename "${s.from}"`}>
              "{s.from.length > 38 ? s.from.slice(0, 36) + "…" : s.from}" → <b>{s.to}</b>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="handover-oncosts">
        <span>On-costs now: <b>overheads {pct(oh)}</b> · <b>contingency {pct(cont)}</b>.</span>
        {presets.map(([a, b]) => (
          <button key={`${a}-${b}`} type="button" onClick={() => onSetOnCosts(a, b)} className="px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-100 text-[11px]">
            Set {pct(a)} / {pct(b)}
          </button>
        ))}
      </div>
    </div>
  );
}
