/**
 * The AI's margin suggestion under the ladder (Grady, 1 Nov 2026: "let the
 * AI suggest best margin based on what was entered"). Pure: the context is
 * built here from the quote's OWN figures and the recorded margins of past
 * projects, the prompt asks for a rate with its reasons, the reader keeps a
 * sane fraction. The suggestion is ADVICE — nothing applies it but the Use
 * button in the Quote Summary.
 */
import { computeMarginRegister, computeProvisionalTotals, projectMargin, pinnedMargin } from "./costing.js";
import { SUBMITTED_STATUSES } from "./planner.js";

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const dayDiff = (iso, today) => {
  if (!iso) return null;
  const a = new Date(`${iso}T00:00:00`), b = new Date(`${today}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
};
const localDay = (d) => { const x = d || new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

/** The recorded margins of OTHER projects, from the drawing-free summaries: only a project whose margin was typed says anything. */
export function pastMarginsFrom(quotesByKey, excludeName) {
  const rows = Object.values(quotesByKey || {}).filter((q) => q && typeof q === "object");
  return rows
    .filter((q) => pinnedMargin(q.marginPct) != null && q.projectName && q.projectName !== excludeName)
    .map((q) => ({ name: q.projectName, status: q.status || "", margin: pinnedMargin(q.marginPct), elements: Array.isArray(q.items) ? q.items.length : undefined, submitted: SUBMITTED_STATUSES.includes(q.status) }))
    .sort((a, b) => (b.submitted ? 1 : 0) - (a.submitted ? 1 : 0))
    .slice(0, 8);
}

/** What one request carries — the quote's figures, never a price list. */
export function marginContext(quote, items, rates, { today, pastProjects } = {}) {
  const q = quote || {};
  const its = items || q.items || [];
  const reg = computeMarginRegister(its, rates, q, q.scope);
  const prov = computeProvisionalTotals(its, rates, q.scope);
  const day = today || localDay();
  const r = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    project: clean(q.projectName) || "Untitled project",
    client: clean(q.clientName),
    status: q.status || "",
    scope: q.scope || "both",
    deadline: (q.planner && q.planner.deadline) || null,
    daysToDeadline: dayDiff(q.planner && q.planner.deadline, day),
    elements: reg.elements.length,
    elementNames: reg.elements.slice(0, 14).map((e) => clean(e.label)),
    directCost: r(reg.totals.cost),
    loadedCost: r(reg.totals.loaded),
    overheadPct: Number(q.overheadPct) || 0,
    contingencyPct: Number(q.contingencyPct) || 0,
    currentMargin: projectMargin(q),
    blendedMargin: Math.round(reg.totals.blended * 1000) / 1000,
    subcontractShare: reg.totals.cost > 0 ? Math.round((reg.byClass.sub.cost / reg.totals.cost) * 100) / 100 : 0,
    subcontractLines: reg.lines.filter((l) => l.kind === "sub").slice(0, 10).map((l) => ({ name: clean(l.name), element: clean(l.element), cost: r(l.cost), margin: l.margin, source: l.source })),
    provisionalShare: reg.totals.cost > 0 ? Math.round((prov.provisional / (prov.provisional + prov.firm || 1)) * 100) / 100 : 0,
    pinnedLines: reg.pinned,
    past: Array.isArray(pastProjects) ? pastProjects.slice(0, 8) : [],
  };
}

export function marginAdvicePrompt(ctx) {
  const c = ctx || {};
  const pct = (f) => `${Math.round((Number(f) || 0) * 1000) / 10}%`;
  const lines = [
    `Project: ${c.project}${c.client ? ` — client ${c.client}` : ""}`,
    `Status: ${c.status || "—"} · scope: ${c.scope} · deadline: ${c.deadline || "none"}${c.daysToDeadline != null ? ` (${c.daysToDeadline} days away)` : ""}`,
    `Elements (${c.elements}): ${(c.elementNames || []).join("; ") || "none"}`,
    `Direct cost $${c.directCost} · with overheads ${pct(c.overheadPct)} and contingency ${pct(c.contingencyPct)} = $${c.loadedCost}`,
    `Current project margin ${pct(c.currentMargin)} · blended across the pinned lines ${pct(c.blendedMargin)} · ${c.pinnedLines || 0} line(s) pinned at their own rate`,
    `Subcontract quotes: ${pct(c.subcontractShare)} of the cost${(c.subcontractLines || []).length ? " — " + c.subcontractLines.map((l) => `${l.name} on ${l.element} $${l.cost} at ${pct(l.margin)} (${l.source})`).join("; ") : ""}`,
    `Provisional sums: ${pct(c.provisionalShare)} of the cost`,
    `Past projects with a recorded margin: ${(c.past || []).length ? c.past.map((p) => `${p.name} (${p.status || "—"}) ${pct(p.margin)}`).join("; ") : "none recorded"}`,
  ];
  return `Suggest the PROJECT margin for this concrete subcontract quote. Margin is on the SELL price (sell = loaded cost ÷ (1 − margin)), never a markup on cost.

FACTS (the only facts you may use — never invent a past project, a competitor, a market figure or a client history):
${lines.map((l) => `- ${l}`).join("\n")}

RULES
- Reason from what is here: the subcontract share (a pass-through earns less than self-performed work), job size, element count, provisional sums, the deadline, the scope and any recorded past margins.
- Stay between 5 and 45. A figure outside that needs a reason the facts support.
- Give TWO figures every time: HIGH confidence = the margin these facts firmly support (the rate you would defend as both winnable and worth doing); LOW confidence = the higher margin that could still win but with less certainty. The low-confidence figure is never below the high-confidence one.
- Give at most 4 reasons, each one short sentence citing a fact above.

Reply with ONE JSON object and nothing else: {"high_confidence_pct": <number, whole or half percent>, "low_confidence_pct": <number>, "reasons": ["…", "…"]}`;
}

/** Reads the reply: `{margin, high, low (fractions), reasons}` — `high` the firmly supported rate, `low` the
 * less certain higher one (Grady, 1 Nov 2026: "always show low confidence and high confidence"); `margin`
 * = `high` for any caller that wants one figure. A single-figure reply reads as both. Null when nothing usable. */
export function parseMarginAdvice(text) {
  const raw = String(text || "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const frac = (v) => { const n = Number(v); if (!Number.isFinite(n)) return null; const f = n > 1 ? n / 100 : n; return f >= 0.01 && f <= 0.6 ? Math.round(f * 1000) / 1000 : null; };
  const single = frac(o && (o.margin_pct ?? o.marginPct ?? o.margin));
  let high = frac(o && (o.high_confidence_pct ?? o.high_pct ?? o.high)) ?? single;
  let low = frac(o && (o.low_confidence_pct ?? o.low_pct ?? o.low)) ?? high;
  if (high == null) return null;
  if (low < high) [low, high] = [high, low]; // the less certain figure is the higher one
  const reasons = Array.isArray(o.reasons) ? o.reasons.map(clean).filter(Boolean).slice(0, 4) : [];
  return { margin: high, high, low, reasons };
}

/** Posts the context to the AI function; resolves `{advice, provider, model}`. */
export async function requestMarginAdvice(context, { provider, fetchImpl, base } = {}) {
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "margin", provider: provider || undefined, context }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  if (!body || !body.advice) throw new Error("The AI gave no usable margin.");
  return { advice: body.advice, provider: body.provider, model: body.model };
}
