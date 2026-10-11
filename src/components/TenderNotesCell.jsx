import { useState } from "react";
import { tenderNoteLines, assumptionNoteItems } from "../lib/tenderNotes.js";
import { requestTenderWording, applyTenderWording, preferredProvider } from "../lib/tenderWording.js";

/**
 * The Tender Notes cell shared by the External Quote and the Tender Quote:
 * the project's Assumptions appear at the top of the cell, bulleted and
 * read-only (they are edited in one place — the Assumptions list under
 * Project Geometry — and flow here live), and the textarea below takes the
 * report's own extra notes, one per line. The printed section lists both
 * through the same `tenderNoteLines` reading, assumptions first.
 *
 * "Reword for tender" (Grady, 11 Oct 2026: "language reconstruction for the
 * assumptions before pushing to the tender quote") asks the AI provider to
 * rewrite the estimator's shorthand as tender qualification lines, shows
 * every proposal beside its original for review — editable, each with its
 * own tick — and stores only what is accepted (`tenderText` on the
 * assumption, lib/tenderWording.js). Nothing is stored until "Use ticked
 * wording" is clicked; the typed assumption text is never changed.
 */
export default function TenderNotesCell({ quote, value, onChange, onChangeAssumptions, rows = 3 }) {
  const notes = tenderNoteLines(quote, value);
  const items = assumptionNoteItems(quote);
  const [review, setReview] = useState(null); // {rows:[{id, text, tender, use}], provider, model, missing}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const canReword = typeof onChangeAssumptions === "function" && items.length > 0;
  const stale = items.filter((a) => a.state === "stale").length;
  const reworded = items.filter((a) => a.state !== "none").length;

  const reword = async () => {
    setBusy(true); setErr(null);
    try {
      const list = (quote.assumptions || []).filter((a) => a && String(a.text || "").trim());
      const r = await requestTenderWording(list, { projectName: quote.projectName, provider: preferredProvider() });
      setReview({
        rows: list.map((a) => ({ id: String(a.id), text: String(a.text).trim(), current: a.tenderText || null, tender: r.wording[String(a.id)] || "", use: !!r.wording[String(a.id)] })),
        provider: r.provider, model: r.model, missing: r.missing,
      });
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally { setBusy(false); }
  };
  const apply = () => {
    const accepted = {};
    review.rows.forEach((r) => { if (r.use && r.tender.trim()) accepted[r.id] = r.tender.trim(); });
    onChangeAssumptions(applyTenderWording(quote.assumptions || [], accepted));
    setReview(null);
  };
  const setRow = (id, patch) => setReview((rv) => ({ ...rv, rows: rv.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  return (
    <div className="w-full border border-neutral-300 rounded text-sm overflow-hidden" data-testid="tender-notes-cell">
      {notes.assumptions.length > 0 ? (
        <div className="px-2 pt-1.5 pb-1 bg-amber-50/60 border-b border-neutral-200">
          <div className="flex items-start justify-between gap-2 mb-0.5">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500 font-semibold">
              From the project&apos;s Assumptions <span className="normal-case tracking-normal font-normal">— live; edit them under Project Geometry</span>
              {reworded > 0 && (
                <span className="normal-case tracking-normal font-normal ml-1" data-testid="tender-wording-state">
                  · {reworded} in tender wording{stale > 0 ? <span className="text-amber-700 font-semibold"> · {stale} changed since — reword again</span> : null}
                </span>
              )}
            </div>
            {canReword && !review && (
              <button
                type="button"
                onClick={reword}
                disabled={busy}
                data-testid="reword-for-tender"
                title="Rewrite every assumption as a formal tender qualification line — you review each proposal before any of it is used"
                className="flex-none text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-950 text-white hover:bg-blue-900 disabled:opacity-50 print:hidden"
              >
                {busy ? "Rewording…" : "✎ Reword for tender"}
              </button>
            )}
          </div>
          {err && <div className="text-[11px] text-red-700 mb-1 print:hidden" data-testid="reword-error">Could not reword: {err}</div>}
          {review ? (
            <div className="border border-blue-200 bg-white rounded p-2 mb-1 space-y-2 print:hidden" data-testid="tender-wording-review">
              <div className="text-[11px] text-neutral-600">
                Proposed tender wording — read each line, edit it if you like, untick any you do not want. Nothing is used until you click <b>Use ticked wording</b>. The typed assumptions stay as they are under Project Geometry.
                {review.missing.length > 0 && <span className="text-amber-700"> {review.missing.length} assumption{review.missing.length === 1 ? "" : "s"} came back without a proposal and keep their typed text.</span>}
              </div>
              <ul className="space-y-1.5">
                {review.rows.map((r) => (
                  <li key={r.id} className="flex items-start gap-2" data-testid="tender-wording-row">
                    <input type="checkbox" checked={r.use} onChange={(e) => setRow(r.id, { use: e.target.checked })} className="mt-1.5 flex-none" aria-label="Use this wording" disabled={!r.tender.trim()} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-neutral-500 line-through decoration-neutral-300">{r.text}</div>
                      <textarea
                        value={r.tender}
                        onChange={(e) => setRow(r.id, { tender: e.target.value, use: !!e.target.value.trim() })}
                        rows={2}
                        placeholder="No proposal returned — type the tender wording here or leave blank to keep the typed text"
                        className="w-full border border-neutral-200 rounded px-2 py-1 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-orange-400"
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={apply} data-testid="apply-tender-wording" className="text-[11px] font-semibold px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700">
                  Use ticked wording ({review.rows.filter((r) => r.use && r.tender.trim()).length})
                </button>
                <button type="button" onClick={() => setReview(null)} className="text-[11px] font-semibold px-2.5 py-1 rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-100">Cancel</button>
                <span className="text-[10px] text-neutral-400">{review.model ? `proposed by ${review.model}` : ""}</span>
              </div>
            </div>
          ) : null}
          <ul className="list-disc pl-5 space-y-0.5" data-testid="tender-notes-assumptions">
            {items.map((a, i) => (
              <li key={a.id || i} data-wording={a.state}>
                {a.line}
                {a.state === "stale" && <span className="ml-1 text-[10px] text-amber-700 font-semibold print:hidden" title={`Typed assumption now reads: ${a.text}`}>(original changed since)</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="px-2 pt-1.5 pb-1 bg-amber-50/60 border-b border-neutral-200 text-[11px] text-neutral-400 italic">
          No assumptions recorded on this project yet — add them under Project Geometry and they appear here, bulleted, automatically.
        </div>
      )}
      <textarea
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder="Additional tender notes — one per line (information missing from documentation, discrepancies, etc.)"
        aria-label="Additional tender notes"
        className="w-full border-0 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
      />
    </div>
  );
}
