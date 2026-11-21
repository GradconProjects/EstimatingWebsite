/**
 * The Quotes side of Estimates' "Compile assumptions" push (Boma, 21 Nov 2026:
 * "a button that compiles assumptions, exclusions and what was measure so we
 * can push to the assumptions section of the quotes").
 *
 * Estimates leaves `{takeoffId, estimateSessionId, projectName, at, by,
 * lines: [{id, kind: "measured" | "assumption" | "exclusion", text}]}` under
 * ESTIMATE_BASIS_KEY (portal/estimates-basis.js builds it). Pure — no React,
 * no DOM — so scripts/verify.mjs runs it.
 *
 * WHERE the lines go is the estimator's choice, every time, on a project with
 * packages (Boma, same day, after 29 lines went to the project-wide list of a
 * packaged project and he looked for them under MAIN BUILDING: "always ask
 * what package to send it to"): one package's own Assumptions, or the
 * project-wide list. `applyBasisToQuote(quote, payload, packageId)` is the
 * ONE write, and it is applied THROUGH THE OPEN EDITOR'S OWN STATE — never
 * patched into the row behind it (the first build did that: the editor had
 * loaded the project a moment earlier and its next save put its older copy
 * back, so the 29 lines were gone the same minute).
 *
 * The lines become ordinary assumption entries (`quote.assumptions`, or a
 * package's `assumptions`), each tagged `source: "estimates"` with its
 * `kind`, the id `est:<line id>` and `pushedText` — the wording Estimates
 * sent. A push only ADDS and UPDATES ("dont delete already existing ones"):
 *   - a line pushed before and sent again follows the new wording, unless it
 *     was retyped in Quotes (text !== pushedText) — a hand edit stands;
 *   - a line pushed before and NOT sent this time stays where it is — it is
 *     removed in Quotes, by hand, like any assumption;
 *   - an assumption typed in Quotes is never touched, and keeps its place
 *     ahead of the pushed lines;
 *   - accepted tender wording (tenderText / tenderSource) is kept — the
 *     existing "original changed since" flag says when it needs redoing.
 */
export const ESTIMATE_BASIS_KEY = "gradcon-estimate-basis";
export const BASIS_SOURCE = "estimates";
export const BASIS_KIND_LABEL = { measured: "Measured", assumption: "Assumption", exclusion: "Excluded" };
/** The destination id of the project-wide Assumptions list (a package's is its own id). */
export const BASIS_PROJECT_WIDE = "";
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

/** A hand-off blob that can be used: at least the lines array. */
export function validBasisPayload(payload) {
  return !!payload && typeof payload === "object" && Array.isArray(payload.lines);
}

/**
 * Lay a push over ONE assumptions list. Nothing is ever removed.
 * → {assumptions, added, updated, kept, unchanged, left, total}
 * (`kept` = sent again but retyped in Quotes, so left as retyped; `left` = pushed before, not sent now, still there).
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
  const byId = new Map(sent.map((s) => [s.id, s]));
  let added = 0, updated = 0, kept = 0, unchanged = 0, left = 0;
  const handEdited = (a) => typeof a.pushedText === "string" && clean(a.text) !== clean(a.pushedText);
  const stamp = { source: BASIS_SOURCE, takeoffId: clean(payload && payload.takeoffId) || undefined, pushedAt: (payload && payload.at) || undefined };
  // every entry already there keeps its place; one this push sends again takes the new wording unless it was retyped here
  const out = list.map((a) => {
    const s = a.source === BASIS_SOURCE ? byId.get(a.id) : null;
    if (!s) { if (a.source === BASIS_SOURCE) left++; return a; }
    byId.delete(a.id);
    if (handEdited(a)) { kept++; return { ...a, ...stamp, kind: s.kind, pushedText: s.text }; }
    if (clean(a.text) === s.text) { unchanged++; return { ...a, ...stamp, kind: s.kind, pushedText: s.text }; }
    updated++;
    return { ...a, ...stamp, kind: s.kind, text: s.text, pushedText: s.text };
  });
  // the lines this list has never held go on the end, in the push's own order
  sent.forEach((s) => { if (!byId.has(s.id)) return; added++; out.push({ id: s.id, text: s.text, pushedText: s.text, ...stamp, kind: s.kind }); });
  return { assumptions: out, added, updated, kept, unchanged, left, total: sent.length };
}

const packagesOf = (quote) => (quote && Array.isArray(quote.packages) ? quote.packages.filter((p) => p && p.id) : []);

/** Where a push can go on this project: the project-wide list, then each package. A plain project has the one list. */
export function basisDestinations(quote) {
  const pkgs = packagesOf(quote);
  const count = (list) => (Array.isArray(list) ? list.filter((a) => a && clean(a.text)).length : 0);
  return [
    ...pkgs.map((p) => ({ id: p.id, name: clean(p.name) || "Package", kind: "package", count: count(p.assumptions) })),
    { id: BASIS_PROJECT_WIDE, name: pkgs.length ? "Whole project — the project-wide assumptions" : "The project's assumptions", kind: "project", count: count(quote && quote.assumptions) },
  ];
}

/** True when the estimator has to be asked where the lines go — any project with packages. */
export function basisNeedsDestination(quote) {
  return packagesOf(quote).length > 0;
}

/** The destination that already holds lines of this takeoff (a suggestion for the picker — it still asks), else null. */
export function basisLastDestination(quote, payload) {
  const tid = clean(payload && payload.takeoffId);
  const ids = new Set((validBasisPayload(payload) ? payload.lines : []).map((l) => `est:${clean(l && l.id)}`));
  const holds = (list) => (Array.isArray(list) ? list : []).some((a) => a && a.source === BASIS_SOURCE && ((tid && a.takeoffId === tid) || ids.has(a.id)));
  const pkg = packagesOf(quote).find((p) => holds(p.assumptions));
  if (pkg) return pkg.id;
  return holds(quote && quote.assumptions) ? BASIS_PROJECT_WIDE : null;
}

/**
 * The ONE write: the push laid over the chosen list of this quote. `packageId` = a package's id, or
 * BASIS_PROJECT_WIDE for the project's own list. → {patch, result, where: {packageId, name}} — or null when the
 * package is not on the quote (nothing is written to a place that does not exist).
 */
export function applyBasisToQuote(quote, payload, packageId) {
  if (!validBasisPayload(payload)) return null;
  const q = quote || {};
  if (!packageId) {
    const result = mergeBasisAssumptions(q.assumptions, payload);
    return { patch: { assumptions: result.assumptions }, result, where: { packageId: BASIS_PROJECT_WIDE, name: "" } };
  }
  const pkgs = packagesOf(q);
  const pkg = pkgs.find((p) => p.id === packageId);
  if (!pkg) return null;
  const result = mergeBasisAssumptions(pkg.assumptions, payload);
  return {
    patch: { packages: (Array.isArray(q.packages) ? q.packages : []).map((p) => (p && p.id === packageId ? { ...p, assumptions: result.assumptions } : p)) },
    result,
    where: { packageId, name: clean(pkg.name) || "Package" },
  };
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

/** "3 added, 2 updated" — what the notice says after a push landed. */
export function basisResultText(r) {
  if (!r) return "";
  const parts = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
  if (r.kept) parts.push(`${r.kept} kept as retyped here`);
  if (r.left) parts.push(`${r.left} pushed earlier left in place`);
  return parts.join(", ") || "nothing to change";
}
