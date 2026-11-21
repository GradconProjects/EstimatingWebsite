/**
 * The Quotes side of Estimates' "Compile assumptions" push (Boma, 21 Nov 2026:
 * "a button that compiles assumptions, exclusions and what was measure so we
 * can push to the assumptions section of the quotes").
 *
 * Estimates leaves `{takeoffId, estimateSessionId, projectName, at, by,
 * lines: [{id, kind: "measured" | "assumption" | "exclusion", text}]}` under
 * ESTIMATE_BASIS_KEY (portal/estimates-basis.js builds it); App.jsx consumes
 * it once. Pure — no React, no DOM — so scripts/verify.mjs runs it.
 *
 * The lines become ordinary entries of `quote.assumptions` (the list under
 * Project Geometry, which the quote report and both Tender Notes print),
 * each tagged `source: "estimates"` with its `kind`, the id `est:<line id>`
 * and `pushedText` — the wording Estimates sent. That tag is what makes a
 * second push an UPDATE and not a second copy:
 *   - a line pushed before and still ticked follows the new wording, unless
 *     it was retyped in Quotes (text !== pushedText) — a hand edit stands;
 *   - a line pushed before and no longer sent is removed, unless it was
 *     retyped in Quotes — then it stays as the estimator's own line;
 *   - an assumption typed in Quotes is never touched, and keeps its place
 *     ahead of the pushed block;
 *   - accepted tender wording (tenderText / tenderSource) is kept — the
 *     existing "original changed since" flag says when it needs redoing.
 */
export const ESTIMATE_BASIS_KEY = "gradcon-estimate-basis";
/** What the frame that applied a push leaves for its own reload (the shell reloads Quotes when it switches to it). */
export const ESTIMATE_BASIS_RESULT_KEY = "gradcon-estimate-basis-result";
export const BASIS_SOURCE = "estimates";
export const BASIS_KIND_LABEL = { measured: "Measured", assumption: "Assumption", exclusion: "Excluded" };
const KINDS = ["measured", "assumption", "exclusion"];

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const nameKey = (s) => clean(s).toLowerCase();

/** The text an assumption entry carries: the tender reads one flat list, so a measured line and an exclusion say what they are. */
export function basisEntryText(line) {
  const t = clean(line && line.text);
  if (!t) return "";
  if (line.kind === "measured") return /^measured\b/i.test(t) ? t : `Measured: ${t}`;
  if (line.kind === "exclusion") return /^(excluded|exclusion)\b/i.test(t) ? t : `Excluded: ${t}`;
  return t;
}

/** A hand-off blob that can be used: a takeoff name or id and at least the lines array. */
export function validBasisPayload(payload) {
  return !!payload && typeof payload === "object" && Array.isArray(payload.lines);
}

/**
 * Lay a push over a project's assumptions. → {assumptions, added, updated, removed, kept, unchanged, total}
 * (`kept` = pushed-before lines that were retyped in Quotes and therefore left alone).
 */
export function mergeBasisAssumptions(existing, payload) {
  const list = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const sent = [];
  const seen = new Set();
  (validBasisPayload(payload) ? payload.lines : []).forEach((l) => {
    if (!l || !KINDS.includes(l.kind)) return;
    const text = basisEntryText(l);
    const id = `est:${clean(l.id) || text}`;
    if (!text || seen.has(id)) return;
    seen.add(id);
    sent.push({ id, kind: l.kind, text });
  });
  const mine = list.filter((a) => a.source !== BASIS_SOURCE);
  const pushedBefore = new Map(list.filter((a) => a.source === BASIS_SOURCE).map((a) => [a.id, a]));
  let added = 0, updated = 0, removed = 0, kept = 0, unchanged = 0;
  const handEdited = (a) => typeof a.pushedText === "string" && clean(a.text) !== clean(a.pushedText);
  const block = sent.map((s) => {
    const old = pushedBefore.get(s.id);
    pushedBefore.delete(s.id);
    const stamp = { source: BASIS_SOURCE, kind: s.kind, takeoffId: clean(payload.takeoffId) || undefined, pushedAt: payload.at || undefined };
    if (!old) { added++; return { id: s.id, text: s.text, pushedText: s.text, ...stamp }; }
    if (handEdited(old)) { kept++; return { ...old, ...stamp, pushedText: s.text }; }
    if (clean(old.text) === s.text) { unchanged++; return { ...old, ...stamp, pushedText: s.text }; }
    updated++;
    return { ...old, ...stamp, text: s.text, pushedText: s.text };
  });
  // pushed before, not sent now: gone — unless it was retyped here, when it becomes the estimator's own line
  const adopted = [];
  pushedBefore.forEach((a) => {
    if (handEdited(a)) { kept++; const { source, kind, pushedText, takeoffId, pushedAt, ...own } = a; adopted.push(own); } else removed++;
  });
  return { assumptions: [...mine, ...adopted, ...block], added, updated, removed, kept, unchanged, total: block.length };
}

/**
 * Which project a push belongs to. `projects` = [{id, name, nameSource, estimateSessionId}] (drawing-free summaries).
 * The takeoff's own published project first (estimateSessionId), then ONE project of the same name (as it reads now
 * or as it was first typed). Anything else is the estimator's pick — never a guess. → {match, candidates}
 */
export function matchBasisProject(payload, projects) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.id) : [];
  const sid = payload && payload.estimateSessionId;
  if (sid) {
    const bySession = list.filter((p) => p.estimateSessionId === sid);
    if (bySession.length === 1) return { match: bySession[0], candidates: bySession, by: "takeoff" };
  }
  const want = nameKey(payload && payload.projectName);
  if (!want) return { match: null, candidates: [], by: null };
  const byName = list.filter((p) => nameKey(p.name) === want || nameKey(p.nameSource) === want);
  if (byName.length === 1) return { match: byName[0], candidates: byName, by: "name" };
  // the convention name carries the takeoff's name inside it ("19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion")
  const loose = byName.length ? byName : list.filter((p) => { const n = nameKey(p.name); return n && (n.includes(want) || want.includes(n)) && Math.min(n.length, want.length) >= 6; });
  return { match: null, candidates: loose, by: null };
}

/** "3 added, 2 updated, 1 removed" — what the notice says after a push landed. */
export function basisResultText(r) {
  if (!r) return "";
  const parts = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
  if (r.kept) parts.push(`${r.kept} kept as retyped here`);
  return parts.join(", ") || "nothing to change";
}
