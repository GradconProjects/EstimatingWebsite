import { useMemo, useState } from "react";
import { CATEGORY_ORDER, SECTION_ORDER } from "../data/catalog.js";
import { isDone } from "../lib/workTrail.js";
import { computeElementCost, computeGrandTotal, computeExcludedTotals, computeProvisionalTotals, isProvisional, computeMarginLadder, money, money2, getDefaultMargin, scopeLabel, computeMarginRegister, projectMargin, pinnedMargin, marginStepsAround, elementMargin, markupFromMargin, marginFromMarkup } from "../lib/costing.js";
import { NumInput, PctInput } from "./atoms.jsx";

const pctLabel = (f) => `${Math.round((Number(f) || 0) * 1000) / 10}%`;

export default function QuoteSummary({
  items, onReorder, rates, categoryOrder = CATEGORY_ORDER, sectionOrder = SECTION_ORDER,
  gfa, setGfa, overheadPct, setOverheadPct, contingencyPct, setContingencyPct, scope,
  quote, setProjectMargin, setElementMargin, setRowMargin, requestAdvice,
}) {
  // Variable margins (1 Nov 2026): the project margin is typed on the ladder,
  // every element and every subcontract quote row can pin its own under the
  // element's row, and the register prices the lot (lib/costing.js).
  const pm = projectMargin(quote || {});
  const reg = useMemo(() => computeMarginRegister(items, rates, quote || {}, scope), [items, rates, quote, scope]);
  const sellById = useMemo(() => { const m = {}; reg.elements.forEach((e) => { m[e.id] = e; }); return m; }, [reg]);
  // Folded two levels deep — category (Foundations, Suspended Structure...)
  // then section within it — matching the Add-Element dropdown's grouping.
  const byCategory = useMemo(() => {
    const cats = {};
    categoryOrder.forEach((c) => { cats[c] = {}; });
    items.forEach((it) => {
      const cost = computeElementCost(it, rates, scope);
      cats[it.category] = cats[it.category] || {};
      cats[it.category][it.section] = cats[it.category][it.section] || [];
      cats[it.category][it.section].push({ item: it, total: cost.total, scope: cost.scope });
    });
    return cats;
  }, [items, rates, categoryOrder, scope]);

  const grandTotal = useMemo(() => computeGrandTotal(items, rates, scope), [items, rates, scope]);
  const provisional = useMemo(() => computeProvisionalTotals(items, rates, scope), [items, rates, scope]);
  const excluded = useMemo(() => computeExcludedTotals(items, rates, scope), [items, rates, scope]);
  const projectScope = scope && scope !== "both" ? scope : "both";
  const { subtotal, rows } = useMemo(
    () => computeMarginLadder(grandTotal, overheadPct, contingencyPct, gfa, marginStepsAround(pm)),
    [grandTotal, overheadPct, contingencyPct, gfa, pm]
  );

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
        <div data-band="summary" className="bg-neutral-900 text-white px-4 py-2 text-xs font-semibold uppercase tracking-wide flex items-center justify-between gap-2">
          <span>Quote Summary</span>
          <span className={`normal-case tracking-normal font-medium text-[11px] ${projectScope !== "both" ? "text-orange-300" : "text-neutral-400"}`} title="The project's scope — set in the editor header; an element can differ on its own card">
            {scopeLabel(projectScope)}
          </span>
        </div>
        {(excluded.materials > 0 || excluded.labour > 0) && (
          <div className="px-4 py-1.5 text-[11px] text-orange-800 bg-orange-50 border-b border-orange-100">
            Not charged under scope: {excluded.materials > 0 ? `materials ${money(excluded.materials)}` : ""}{excluded.materials > 0 && excluded.labour > 0 ? " · " : ""}{excluded.labour > 0 ? `labour ${money(excluded.labour)}` : ""}
          </div>
        )}
        <div className="p-3 max-h-[40vh] overflow-y-auto space-y-3">
          {categoryOrder.filter((c) => Object.values(byCategory[c] || {}).some((rows) => rows.length)).map((category) => {
            const sections = byCategory[category];
            const catTotal = Object.values(sections).flat().reduce((s, r) => s + r.total, 0);
            return (
              <div key={category}>
                <div className="text-[11px] uppercase tracking-widest text-neutral-600 font-bold">{category}</div>
                {sectionOrder.filter((s) => sections[s]?.length).map((section) => (
                  <div key={section} className="pl-2 mt-1">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-400 font-semibold">{section}</div>
                    {sections[section].map((r) => (
                      <div key={r.item.id}>
                      <div
                        draggable={!!onReorder}
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.item.id); }}
                        onDragOver={(e) => { if (onReorder) e.preventDefault(); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const draggedId = e.dataTransfer.getData("text/plain");
                          if (draggedId && onReorder) onReorder(draggedId, r.item.id);
                        }}
                        className={`flex justify-between text-[13px] py-0.5 ${onReorder ? "cursor-grab active:cursor-grabbing hover:bg-neutral-50 rounded" : ""}`}
                        title={onReorder ? "Drag to reorder" : undefined}
                      >
                        <span className="text-neutral-600 truncate pr-2">{isDone(r.item) && <span className="mr-1 text-emerald-600 font-bold" title="Done">✓</span>}{r.item.label}{isProvisional(r.item) && <span className="ml-1 px-1 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold" title="Provisional sum">PS</span>}{r.scope !== projectScope && <span className="ml-1 text-[10px] text-orange-700 font-medium">({scopeLabel(r.scope)})</span>}</span>
                        <span className="font-mono tabular-nums text-neutral-800 flex-none">{money2(r.total)}</span>
                      </div>
                      {setElementMargin && r.total > 0 && (() => {
                        // the element's margin row, then one per subcontract quote row it carries
                        const e = sellById[r.item.id];
                        const pinned = pinnedMargin(r.item.marginPct);
                        return (
                          <div className="pl-4 pb-1.5 space-y-0.5 border-l-2 border-orange-200 ml-1" data-testid="element-margin" data-element={r.item.id}>
                            <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                              <span className="uppercase tracking-wide text-[9px] font-semibold">Margin</span>
                              <PctInput value={pinned ?? undefined} placeholder={pctLabel(pm)} onChange={(v) => setElementMargin(r.item.id, v)} className="!w-14 !py-0 !text-[11px]" title="This element's margin — blank follows the project margin on the ladder" />
                              <span>{pinned != null ? "pinned" : `inherits ${pctLabel(pm)}`}</span>
                              {e && <span className="ml-auto font-mono tabular-nums text-neutral-700" title="Sell ex GST at this element's margins">sells {money2(e.sell)}</span>}
                            </div>
                            {e && e.lines.filter((l) => l.kind === "sub").map((l) => {
                              const rp = pinnedMargin(r.item.rowMargins && r.item.rowMargins[l.key]);
                              return (
                                <div key={l.key} className="flex items-center gap-1.5 text-[11px] text-neutral-500 pl-3" data-testid="row-margin" data-key={l.key}>
                                  <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 rounded px-1 flex-none">sub quote</span>
                                  <span className="truncate" title={l.name}>{l.name} · {money2(l.cost)}</span>
                                  <PctInput value={rp ?? undefined} placeholder={pctLabel(elementMargin(r.item, pm))} onChange={(v) => setRowMargin(r.item.id, l.key, v)} className="!w-14 !py-0 !text-[11px] flex-none" title="This quote row's margin — blank follows the element" />
                                  <span className="flex-none">{rp != null ? "pinned" : "inherits"}</span>
                                  <span className="ml-auto font-mono tabular-nums text-neutral-700 flex-none">{money2(l.sell)}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                      </div>
                    ))}
                  </div>
                ))}
                <div className="flex justify-between text-[12px] font-semibold border-t border-neutral-100 mt-1 pt-1">
                  <span className="text-neutral-500">Subtotal</span>
                  <span className="font-mono tabular-nums text-neutral-700">{money2(catTotal)}</span>
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="text-sm text-neutral-400 text-center py-6">No elements added yet.</div>
          )}
        </div>
        <div data-band="summary" className="px-4 py-3 bg-neutral-900 text-white flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide">Grand Total (ex GST)</span>
          <span className="font-mono tabular-nums text-xl font-bold text-orange-400">{money2(grandTotal)}</span>
        </div>
        {provisional.count > 0 && (
          <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-[12px] text-amber-900 flex items-center justify-between gap-2" data-testid="provisional-sums">
            <span>Of which <b>provisional sums</b> ({provisional.count} element{provisional.count === 1 ? "" : "s"}) · firm work {money2(provisional.firm)}</span>
            <span className="font-mono tabular-nums font-semibold">{money2(provisional.provisional)}</span>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white shadow-sm p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">GFA &amp; on-costs</div>
        <label className="flex items-center justify-between text-[13px]">
          Total GFA (m²)
          <NumInput value={gfa} onChange={setGfa} className="w-28" step="0.1" />
        </label>
        <label className="flex items-center justify-between text-[13px]">
          Overheads %
          <NumInput value={overheadPct} onChange={setOverheadPct} className="w-28" step="0.01" />
        </label>
        <label className="flex items-center justify-between text-[13px]">
          Contingency %
          <NumInput value={contingencyPct} onChange={setContingencyPct} className="w-28" step="0.01" />
        </label>
        <div className="flex justify-between text-[13px] font-semibold pt-1 border-t border-neutral-100">
          <span className="text-neutral-500">Subtotal (+ OH + Cont.)</span>
          <span className="font-mono tabular-nums">{money2(subtotal)}</span>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
        <div data-band="summary" className="bg-neutral-900 text-white px-4 py-2 text-xs font-semibold uppercase tracking-wide">
          Margin Ladder
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-neutral-50 text-neutral-500 text-[10px] uppercase tracking-wide">
              <th className="text-left px-3 py-1.5 font-medium">Margin</th>
              <th className="text-right px-2 py-1.5 font-medium" title="What you add to COST to land the margin on the left. They are not the same number — a 25% margin needs 33.3% on cost.">= Markup on cost</th>
              <th className="text-right px-2 py-1.5 font-medium">Sell (ex GST)</th>
              <th className="text-right px-2 py-1.5 font-medium">Sell (inc GST)</th>
              <th className="text-right px-3 py-1.5 font-medium">$/m² GFA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isProject = Math.abs(row.margin - pm) < 1e-9;
              return (
                <tr key={row.margin} className={`border-t border-neutral-100 ${isProject ? "bg-emerald-50" : ""}`}>
                  <td className="px-3 py-1 font-medium text-neutral-700">
                    {isProject && setProjectMargin ? (
                      <span className="flex items-center gap-1" data-testid="project-margin">
                        <PctInput value={pm} onChange={(v) => setProjectMargin(v)} className="!w-16 !py-0.5" title="The project margin — every element follows it unless pinned at its own rate" />
                        {pinnedMargin(quote && quote.marginPct) != null && (
                          <button type="button" className="text-[11px] text-neutral-400 hover:text-neutral-700" title={`Back to the Settings default ${pctLabel(getDefaultMargin())}`} onClick={() => setProjectMargin(undefined)} data-testid="project-margin-reset">↺</button>
                        )}
                      </span>
                    ) : pctLabel(row.margin)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-neutral-500">
                    {isProject && setProjectMargin ? (
                      <PctInput value={markupFromMargin(pm)} max={900} onChange={(v) => setProjectMargin(v === undefined ? undefined : marginFromMarkup(v))} className="!w-16 !py-0.5" title="Markup on COST — typing here sets the margin on the left (margin = markup ÷ (1 + markup))" data-testid="project-markup" />
                    ) : `${(row.markupOnCost * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{money(row.sellExGst)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{money(row.sellIncGst)}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {row.perM2 > 0 ? money2(row.perM2) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t border-neutral-100 text-[12px] flex items-center justify-between gap-2" data-testid="margin-blended">
          <span className="text-neutral-600">
            {reg.pinned > 0
              ? <>With the per-line margins ({reg.pinned} pinned) · blended <b>{pctLabel(reg.totals.blended)}</b></>
              : <>Every line at the project margin {pctLabel(pm)}</>}
          </span>
          <span className="font-mono tabular-nums font-semibold">{money(reg.totals.sell)} <span className="text-neutral-400 font-normal">ex GST</span></span>
        </div>
        {requestAdvice && setProjectMargin && items.length > 0 && (
          <MarginAdvice requestAdvice={requestAdvice} current={pm} onUse={(m) => setProjectMargin(m)} />
        )}
      </div>
    </div>
  );
}

/** The AI's suggestion under the ladder: advice with its reasons, applied only by Use. */
function MarginAdvice({ requestAdvice, current, onUse }) {
  const [state, setState] = useState({ busy: false, advice: null, error: null });
  const ask = async () => {
    setState({ busy: true, advice: null, error: null });
    try { const r = await requestAdvice(); setState({ busy: false, advice: r.advice, error: null, provider: r.provider }); }
    catch (e) { setState({ busy: false, advice: null, error: e.message || String(e) }); }
  };
  const a = state.advice;
  return (
    <div className="px-3 py-2 border-t border-neutral-100 bg-neutral-50 text-[12px] space-y-1.5" data-testid="margin-advice">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">AI suggestion, from what was entered</span>
        <button type="button" onClick={ask} disabled={state.busy} className="px-2 py-0.5 rounded bg-orange-600 text-white text-[11px] font-medium hover:bg-orange-700 disabled:opacity-50" data-testid="margin-suggest">
          {state.busy ? "Reading the quote…" : "Click here to suggest margin"}
        </button>
      </div>
      {state.error && <div className="text-red-700" data-testid="margin-advice-error">{state.error}</div>}
      {a && (
        <div className="space-y-1">
          {[["high", a.high, "High confidence", "the margin the quote's facts firmly support"], ["low", a.low, "Low confidence", "a higher margin that could still win, with less certainty"]].map(([k, m, label, why]) => (
            <div key={k} className="flex items-center gap-2 flex-wrap" data-testid={`margin-advice-${k}`}>
              <span className={`inline-block w-[6.5rem] text-[10px] font-semibold uppercase tracking-wide ${k === "high" ? "text-emerald-700" : "text-amber-700"}`} title={why}>{label}</span>
              <b className="font-mono text-[13px]" data-testid={`margin-advice-${k}-pct`}>{pctLabel(m)}</b>
              {Math.abs(m - current) > 1e-9
                ? <button type="button" onClick={() => onUse(m)} className={`px-2 py-0.5 rounded text-white text-[11px] font-medium ${k === "high" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"}`} data-testid={`margin-use-${k}`}>Use {pctLabel(m)}</button>
                : <span className="text-[10px] text-neutral-400">in use</span>}
            </div>
          ))}
          <div><button type="button" onClick={() => setState({ busy: false, advice: null, error: null })} className="px-2 py-0.5 rounded border border-neutral-300 text-[11px] text-neutral-600 hover:bg-white">Dismiss</button></div>
          {a.reasons && a.reasons.length > 0 && (
            <ul className="list-disc pl-4 text-neutral-600 space-y-0.5">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          <div className="text-[10px] text-neutral-400">Advice only — nothing changes until you press Use. Read from this quote's own figures and the margins recorded on other projects.</div>
        </div>
      )}
    </div>
  );
}
