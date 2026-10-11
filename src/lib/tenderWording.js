/**
 * Tender wording for the project's Assumptions — pure, no React, no DOM.
 *
 * Grady, 11 Oct 2026: "language reconstruction for the assumptions before
 * pushing to the tender quote". The estimator types assumptions as shorthand
 * ("Paving slab thickness 150mm and SL82 mesh reinforcment", "Hydronics:
 * Zones 2B and 3B excluded as is under tile - confirm these are included.")
 * and they flow live into the Tender Notes of the External and Tender
 * Quotes (lib/tenderNotes.js). Before the quote goes out the wording is
 * reconstructed into formal tender qualification language — by the AI
 * provider, REVIEWED by a person, and only then stored.
 *
 * Shape: an assumption `{id, text}` gains `tenderText` (the accepted tender
 * wording) and `tenderSource` (the original text it was written from). The
 * estimator's own text is never changed — the quote report and the
 * Assumptions list keep it — only the Tender Notes read the tender wording,
 * through `assumptionTenderLine`. If the original is edited after the
 * rewording, `wordingState` reads "stale" and the cell says so; the stale
 * wording still prints (it was accepted) until it is redone or cleared.
 */

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/** The line the Tender Notes print for one assumption: the accepted tender wording, else the typed text. */
export function assumptionTenderLine(a) {
  if (!a) return "";
  const t = clean(a.tenderText);
  return t || clean(a.text);
}

/** "none" (typed text only), "reworded" (tender wording accepted for this exact text), "stale" (the original changed since). */
export function wordingState(a) {
  if (!a || !clean(a.tenderText)) return "none";
  return clean(a.tenderSource) === clean(a.text) ? "reworded" : "stale";
}

/** The prompt the server sends: one tender line per assumption, same ids, no new facts. */
export function tenderWordingPrompt({ projectName, assumptions }) {
  const rows = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  return `Project: ${projectName || "(unnamed)"}.
Below are the estimator's ASSUMPTIONS for a concrete subcontract tender, typed as working shorthand. Rewrite each one as a formal tender qualification / clarification line for the Tender Notes of the quote, as a Melbourne concrete subcontractor writes to a builder.

Rules:
- One line per assumption, SAME id, same order. Keep every fact, figure, unit, product name, zone and drawing reference exactly; add NOTHING that is not in the shorthand (no new scope, figures or standards).
- Use the trade's conventions: an inclusion reads "Allowance has been made for …" / "Our price includes …"; an exclusion reads "… is excluded from our price" or "No allowance has been made for …"; a figure read off a drawing or taken on the builder's word reads "… has been assumed … and is to be confirmed by the builder / engineer"; a query becomes a request: "Please confirm …". Where the shorthand says confirm / TBC / query, keep that as a confirmation request.
- Correct spelling and grammar, expand abbreviations the builder may not know (e.g. "reo" → "reinforcement", "SL82" stays), keep Australian terms and metric units, one or two sentences, no bullet marks, no headings, no quotes around the line.
- Do not merge or split assumptions; do not reorder.

Reply with ONE JSON object and nothing else: {"lines":[{"id":"<id>","tender":"<the rewritten line>"}]}

ASSUMPTIONS (JSON):
${JSON.stringify(rows)}`;
}

/** Reads the model's reply back onto the assumptions: {id → tender}. Lines matched by id, then by position; blank or missing ones are left out. */
export function parseTenderWording(text, assumptions) {
  const list = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  let doc = null;
  const s = String(text == null ? "" : text);
  try { doc = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch { doc = null; } }
  }
  const lines = doc && Array.isArray(doc.lines) ? doc.lines : Array.isArray(doc) ? doc : [];
  const out = {};
  lines.forEach((l, i) => {
    if (!l) return;
    const tender = clean(typeof l === "string" ? l : l.tender || l.text || l.line);
    if (!tender) return;
    const id = l && l.id != null ? String(l.id) : null;
    const target = (id && list.find((a) => a.id === id)) || (!id && list[i]) || null;
    if (target && !out[target.id]) out[target.id] = tender;
  });
  return out;
}

/** Writes accepted wording onto the assumptions: `accepted` = {id → tender line}; everything else untouched. */
export function applyTenderWording(assumptions, accepted) {
  const acc = accepted || {};
  return (assumptions || []).map((a) => {
    const t = clean(acc[String(a.id)]);
    if (!t) return a;
    return { ...a, tenderText: t, tenderSource: clean(a.text) };
  });
}

/** Removes the tender wording from one assumption (the typed text stands again). */
export function clearTenderWording(assumptions, id) {
  return (assumptions || []).map((a) => {
    if (String(a.id) !== String(id)) return a;
    const { tenderText, tenderSource, ...rest } = a; // eslint-disable-line no-unused-vars
    return rest;
  });
}

/** Asks the portal's AI function for the wording (never autonomous — a button click calls this). `fetchImpl` / `base` are test seams. */
export async function requestTenderWording(assumptions, { projectName, provider, fetchImpl, base } = {}) {
  const rows = (assumptions || []).map((a) => ({ id: String(a.id), text: clean(a.text) })).filter((a) => a.text);
  if (!rows.length) throw new Error("No assumptions to reword.");
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "tender-wording", provider: provider || undefined, projectName: projectName || "", assumptions: rows }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  const proposals = Array.isArray(body && body.lines) ? body.lines : [];
  const map = {};
  proposals.forEach((l) => { if (l && l.id != null && clean(l.tender)) map[String(l.id)] = clean(l.tender); });
  return { wording: map, provider: body && body.provider, model: body && body.model, missing: rows.filter((r) => !map[r.id]).map((r) => r.id) };
}

/** The per-browser provider choice the portal Settings keep (`gradcon-preferences.aiProvider`); null when none. */
export function preferredProvider(storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const p = st && JSON.parse(st.getItem("gradcon-preferences") || "null");
    return p && typeof p.aiProvider === "string" && p.aiProvider ? p.aiProvider : null;
  } catch { return null; }
}
