/**
 * Tender Notes on the External Quote and the Tender Quote = the project's
 * recorded ASSUMPTIONS (the Assumptions list under Project Geometry, live)
 * followed by whatever the estimator types on the report itself (Grady,
 * 8 Oct 2026: "entered assumptions should automatically be entered in the
 * external tender quote under the relevant section inside the Tender Notes
 * cell well bulleted and formatted accordingly"). Pure — no React, no DOM —
 * so scripts/verify.mjs runs it.
 *
 * `tenderNoteLines(quote, typedText)` is the ONE reading both reports (the
 * on-screen cell and the printed section) use: the assumptions come first,
 * in the order they were recorded, blanks dropped; the typed notes follow,
 * one per line, a leading bullet mark stripped (the report prints its own
 * bullets), and a typed line that repeats an assumption — or an earlier
 * typed line — is printed once, so notes pasted in by hand before this
 * existed do not double up. Nothing is written back into either text: the
 * assumptions stay the project's and the typed notes stay the report's.
 */
const BULLET_PREFIX = /^[\s•\-–—*·▪◦]+/;

export function cleanNoteLine(line) {
  return String(line == null ? "" : line).replace(BULLET_PREFIX, "").replace(/\s+/g, " ").trim();
}

function noteKey(line) {
  return cleanNoteLine(line).toLowerCase();
}

/** The project's assumption texts, recorded order, blanks dropped. */
export function assumptionLines(quote) {
  const list = quote && Array.isArray(quote.assumptions) ? quote.assumptions : [];
  return list.map((a) => cleanNoteLine(a && a.text)).filter(Boolean);
}

/** The notes typed on the report: one per line, bullet marks stripped, blanks dropped. */
export function typedNoteLines(text) {
  return String(text == null ? "" : text).split("\n").map(cleanNoteLine).filter(Boolean);
}

export function tenderNoteLines(quote, typedText) {
  const assumptions = assumptionLines(quote);
  const seen = new Set(assumptions.map(noteKey));
  const typed = [];
  for (const line of typedNoteLines(typedText)) {
    const k = noteKey(line);
    if (seen.has(k)) continue;
    seen.add(k);
    typed.push(line);
  }
  return { assumptions, typed, all: [...assumptions, ...typed] };
}
