import { tenderNoteLines } from "../lib/tenderNotes.js";

/**
 * The Tender Notes cell shared by the External Quote and the Tender Quote:
 * the project's Assumptions appear at the top of the cell, bulleted and
 * read-only (they are edited in one place — the Assumptions list under
 * Project Geometry — and flow here live), and the textarea below takes the
 * report's own extra notes, one per line. The printed section lists both
 * through the same `tenderNoteLines` reading, assumptions first.
 */
export default function TenderNotesCell({ quote, value, onChange, rows = 3 }) {
  const notes = tenderNoteLines(quote, value);
  return (
    <div className="w-full border border-neutral-300 rounded text-sm overflow-hidden" data-testid="tender-notes-cell">
      {notes.assumptions.length > 0 ? (
        <div className="px-2 pt-1.5 pb-1 bg-amber-50/60 border-b border-neutral-200">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500 font-semibold mb-0.5">
            From the project&apos;s Assumptions <span className="normal-case tracking-normal font-normal">— live; edit them under Project Geometry</span>
          </div>
          <ul className="list-disc pl-5 space-y-0.5" data-testid="tender-notes-assumptions">
            {notes.assumptions.map((l, i) => (
              <li key={i}>{l}</li>
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
