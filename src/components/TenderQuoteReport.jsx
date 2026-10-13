import { useEffect, useState } from "react";
import { uid, getGstRate } from "../lib/costing.js";
import { GRADCON_LOGO_FULL_DATA_URI } from "../lib/logo.js";
import { newTenderQuote, seedTenderItems, computeTenderProjectSum, tenderPriceDrift, refreshTenderPrices, tenderPrefill, rolledUpItems, itemiseRolledUp, normalizeTenderItems, itemLines, itemPriceLabel, itemHasRowPrices, regroupByStage, TENDER_STAGES, stageTitle, isStageKey, printedPrice, gstSuffixOn } from "../lib/tenderQuoteDefaults.js";
import { ELEMENT_TYPES } from "../data/catalog.js";
import { handoverIssues } from "../lib/handover.js";
import { tenderNoteLines } from "../lib/tenderNotes.js";
import TenderNotesCell from "./TenderNotesCell.jsx";
import { requestTenderItemsWording, preferredProvider } from "../lib/tenderWording.js";
import { tenderSpecContext } from "../lib/tenderSpecContext.js";
import { readTakeoffForProject } from "../lib/estimatesRead.js";

const fmtMoney = (n) => `$${(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The TENDER QUOTE — a direct copy of Gradcon's real quotation document
 * (logo header, Date / Attention / Project block, numbered Project Details
 * line items — the fixed construction STAGES since 13 Oct 2026, each with its
 * right-aligned "$… + GST" total and one row per element carrying the
 * element's own price — Additional Options, Drawings, Tender Notes, Inclusions, Specific
 * Exclusions, General exclusions, Specific Contractual Conditions and the
 * signature block). Unlike the Internal Quote this shows no cost breakdown
 * and — deliberately — NO markup drawings.
 *
 * EVERYTHING is editable. Line items seed once from the project's own quote
 * (title = element, price = that element's share of the real sell price,
 * dot points = the element's published estimating quantities — the figures
 * that came across from the Estimates tab), and a Reseed button pulls them
 * fresh whenever the quote changes; the boilerplate sections seed from
 * Gradcon's real standard wording (lib/tenderQuoteDefaults.js).
 *
 * Same dual-render pattern as the other two documents: a `hidden
 * print:block` copy (only when this is the active print target — App.jsx's
 * printTarget) plus an on-screen editor with a live print preview, since
 * window.print() can be silently blocked in a sandboxed iframe.
 */
export default function TenderQuoteReport({ quote, items, rates, visible, onClose, onChange, onChangeAssumptions, isPrintTarget }) {
  const tq = quote.tenderQuote || newTenderQuote();
  const set = (field, value) => onChange({ ...tq, [field]: value });

  // First open: seed the line items from the quote + estimating quantities.
  useEffect(() => {
    if (visible && (!quote.tenderQuote || quote.tenderQuote.items == null)) {
      onChange({ ...tenderPrefill(tq, quote), items: seedTenderItems(quote, items, rates), pricesAt: new Date().toISOString() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Line items are the fixed construction STAGES (lib/tenderQuoteDefaults.js
  // TENDER_STAGES), each holding one row per element with its own price; a
  // tender saved before 13 Oct 2026 reads through the same normaliser.
  const lineItems = normalizeTenderItems(tq.items || []);
  const setLineItems = (next) => set("items", normalizeTenderItems(next));
  const patchLine = (id, patch) => setLineItems(lineItems.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  // a row beyond the stored list appends (the editor always shows one spare box, so a stage can carry any number of elements)
  const patchRow = (id, i, patch) =>
    setLineItems(lineItems.map((l) => { if (l.id !== id) return l; const rows = itemLines(l).slice(); while (rows.length <= i) rows.push({ id: uid(), elementId: null, name: "", text: "", price: "" }); rows[i] = { ...rows[i], ...patch }; return { ...l, lines: rows }; }));
  const removeRow = (id, rowId) => setLineItems(lineItems.map((l) => (l.id === id ? { ...l, lines: itemLines(l).filter((r) => r.id !== rowId) } : l)));
  // moving one row to another stage (the row's own select) — the stage items are rebuilt in order and the decision recorded on elementStages
  const moveRow = (rowId, stage) => {
    const rg = regroupByStage(lineItems, (l) => (l.id === rowId ? stage : null));
    onChange({ ...tq, items: rg.items, elementStages: { ...(tq.elementStages || {}), ...rg.elementStages } });
  };
  const typeName = (typeId) => { const t = ELEMENT_TYPES.find((x) => x.id === typeId); return t ? t.name : ""; };
  // "Reword for tender" on the line items (Grady, 13 Oct 2026: "apply the reword
  // concept to tender quote also"): every title and dot point proposed by the AI
  // provider, reviewed per line, applied only on "Use ticked wording"; prices untouched.
  const [itemReview, setItemReview] = useState(null); // {rows:[{id, title, points, newTitle, newPoints, use, countMatches}], model, missing}
  const [itemBusy, setItemBusy] = useState(false);
  const [itemErr, setItemErr] = useState(null);
  const rewordItems = async () => {
    setItemBusy(true); setItemErr(null);
    try {
      // A line still carrying the old "plus N further items" roll-up is itemised
      // FIRST, so the model sees every element and names each one — never a
      // reworded roll-up (Grady, 13 Oct 2026: "name the three further items
      // individually: dont bind them up"). The itemised list is what the
      // review shows and what "Use ticked wording" writes.
      const rolledCount = rolledUpItems(tq).length;
      const base = rolledCount ? itemiseRolledUp({ ...quote, tenderQuote: tq }, items, rates).items : lineItems;
      // Specifications for the model: every dot point's quote element (its priced
      // rows and description) and the Estimates takeoff of the same project name
      // (lib/tenderSpecContext.js) — Grady, 13 Oct 2026: "get specifications where
      // needed from the corresponding quote line items and the estimates sections".
      const takeoff = await readTakeoffForProject(quote.projectName).catch(() => null);
      const spec = tenderSpecContext({ quote, items, lineItems: base, takeoff });
      const options = (tq.additionalOptions || []).filter((o) => o && String(o.text || "").trim());
      const sections = { inclusions: tq.inclusions || "", specificExclusions: tq.specificExclusions || "", generalExclusions: tq.generalExclusions || "" };
      // every element row, with its current stage, for the model to PLACE under the fixed stages
      const elements = [];
      base.forEach((l) => itemLines(l).forEach((row) => { const el = row.elementId && items.find((it) => it.id === row.elementId); if (el) elements.push({ id: el.id, name: el.label || "", type: typeName(el.typeId), category: el.category || "", description: String(el.description || "").slice(0, 200), stage: l.stage || "" }); }));
      const r = await requestTenderItemsWording(base, { projectName: quote.projectName, provider: preferredProvider(), spec, options, sections, elements, stages: TENDER_STAGES });
      const sectionLabel = { inclusions: "Inclusions", specificExclusions: "Specific exclusions", generalExclusions: "General exclusions" };
      const placements = [];
      base.forEach((l) => itemLines(l).forEach((row) => { if (!row.elementId) return; const from = l.stage || null; const proposed = r.placement[row.elementId] || null; placements.push({ rowId: row.id, elementId: row.elementId, name: row.name || row.text.split(" — ")[0], from, proposed, to: proposed || from || "" }); }));
      setItemReview({
        base, itemised: rolledCount, spec: { takeoffName: takeoff ? takeoff.name : null, ...spec.matched },
        rows: base.map((l) => { const w = r.wording[String(l.id)]; const pts = itemLines(l).map((row) => String(row.text || "").trim()).filter(Boolean); return { id: l.id, stage: l.stage || null, title: l.title || "", points: pts, newTitle: w && w.title ? w.title : l.title || "", newPoints: w ? w.points : [], use: !!w, countMatches: w ? w.points.length === pts.length : false }; }),
        placements, placed: Object.keys(r.placement).length,
        optionRows: options.map((o) => ({ id: String(o.id), text: String(o.text).trim(), newText: r.options[String(o.id)] || "", use: !!r.options[String(o.id)] })),
        sectionRows: Object.keys(sections).filter((k) => String(sections[k]).trim()).map((k) => { const got = r.sections[k]; return { key: k, label: sectionLabel[k] || k, text: String(sections[k]), newText: got ? got.lines.join("\n") : "", use: !!got, countMatches: got ? got.countMatches : false }; }),
        model: r.model, missing: r.missing,
      });
    } catch (e) { setItemErr(String((e && e.message) || e)); } finally { setItemBusy(false); }
  };
  const applyItemReview = () => {
    const by = {}; itemReview.rows.forEach((r) => { if (r.use) by[r.id] = r; });
    // the ticked wording onto each row (by position — the same number of points per item), a stage title never changes, prices never move
    const worded = itemReview.base.map((l) => {
      const r = by[l.id]; if (!r) return l;
      const rows = itemLines(l); const texts = rows.map((row) => String(row.text || "").trim());
      const nonBlank = texts.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
      const pts = r.newPoints.map((p) => String(p || "").trim());
      const lines = rows.map((row) => ({ ...row }));
      nonBlank.forEach((rowIdx, k) => { if (pts[k]) lines[rowIdx].text = pts[k]; });
      pts.slice(nonBlank.length).filter(Boolean).forEach((t) => lines.push({ id: uid(), elementId: null, name: "", text: t, price: "" }));
      return { ...l, title: l.stage ? l.title : (r.newTitle.trim() || l.title), lines };
    });
    // then every element under the stage chosen in the review (the AI's placement, or the select)
    const stageSel = {}; (itemReview.placements || []).forEach((p) => { if (isStageKey(p.to)) stageSel[p.rowId] = p.to; });
    const rg = regroupByStage(worded, (l) => stageSel[l.id] || null);
    const nextItems = rg.items;
    const optBy = {}; (itemReview.optionRows || []).forEach((o) => { if (o.use && o.newText.trim()) optBy[o.id] = o.newText.trim(); });
    const nextOpts = (tq.additionalOptions || []).map((o) => (optBy[String(o.id)] ? { ...o, text: optBy[String(o.id)] } : o));
    const patch = { items: nextItems, elementStages: { ...(tq.elementStages || {}), ...rg.elementStages }, additionalOptions: nextOpts };
    (itemReview.sectionRows || []).forEach((s) => { if (s.use && s.newText.trim()) patch[s.key] = s.newText.trim(); });
    onChange({ ...tq, ...patch }); // one write: line items, options and sections together, prices untouched
    setItemReview(null);
  };
  const setItemRow = (id, patch) => setItemReview((rv) => ({ ...rv, rows: rv.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const setOptionRow = (id, patch) => setItemReview((rv) => ({ ...rv, optionRows: rv.optionRows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const setSectionRow = (key, patch) => setItemReview((rv) => ({ ...rv, sectionRows: rv.sectionRows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const setPlacement = (rowId, to) => setItemReview((rv) => ({ ...rv, placements: rv.placements.map((p) => (p.rowId === rowId ? { ...p, to } : p)) }));

  const opts = tq.additionalOptions || [];
  const setOpts = (next) => set("additionalOptions", next);
  // What a tender must not go out with (lib/handover.js, lib/tenderQuoteDefaults.js):
  // subcontract quote rows carrying a quantity but no amount (they price at
  // $0), and category prices seeded earlier that no longer match the quote.
  const unpriced = visible ? handoverIssues(items).unpricedQuoteRows : [];
  const drift = visible && tq.items ? tenderPriceDrift({ ...quote, tenderQuote: tq }, items, rates) : { changed: [], missing: [] };
  const rolled = visible && tq.items ? rolledUpItems(tq) : [];

  return (
    <>
      {isPrintTarget && (
        <div className="hidden print:block text-black text-[11px]">
          <ReportContent quote={quote} tq={tq} />
        </div>
      )}
      {visible && (
        <div className="print:hidden fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl">
            {(unpriced.length > 0 || drift.changed.length > 0 || drift.missing.length > 0 || rolled.length > 0) && (
              <div className="px-5 py-2 border-b border-red-200 bg-red-50 text-[12px] text-red-900 space-y-1 rounded-t-xl" role="alert" data-testid="tender-checks">
                {rolled.length > 0 && (
                  <div className="flex items-start justify-between gap-3" data-testid="tender-rollup">
                    <div><b>{rolled.length} line item{rolled.length === 1 ? "" : "s"} still carr{rolled.length === 1 ? "ies" : "y"} a &quot;plus N further items&quot; roll-up</b> from an earlier seed: {rolled.map((r) => r.title).join("; ")}. Every element is itemised now — replace those dot points with one per element (titles and prices kept).</div>
                    <button type="button" onClick={() => onChange(itemiseRolledUp({ ...quote, tenderQuote: tq }, items, rates))} data-testid="tender-itemise" className="flex-none px-2.5 py-1 rounded-lg bg-red-700 hover:bg-red-800 text-white text-[11px] font-semibold" title="Replace only the rolled-up lines' dot points with one point per element from a fresh seed; titles, prices and your other edits are kept">
                      Itemise
                    </button>
                  </div>
                )}
                {unpriced.length > 0 && (
                  <div data-testid="tender-unpriced"><b>{unpriced.length} subcontract quote row{unpriced.length === 1 ? "" : "s"} price at $0</b> — a quantity but no amount: {unpriced.map((r) => `${r.label} — ${r.product} (${r.qty})`).join("; ")}. Type the received quote on the element before this goes out.</div>
                )}
                {(drift.changed.length > 0 || drift.missing.length > 0) && (
                  <div className="flex items-start justify-between gap-3" data-testid="tender-drift">
                    <div>
                      <b>Prices seeded {tq.pricesAt ? new Date(tq.pricesAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "earlier"} no longer match the quote:</b>{" "}
                      {drift.changed.map((d) => `${d.title} ${d.stored} → ${d.fresh}`).join("; ")}{drift.missing.length ? `${drift.changed.length ? "; " : ""}not on the tender yet: ${drift.missing.map((m) => `${m.title} ${m.price}`).join(", ")}` : ""}.
                    </div>
                    <button type="button" onClick={() => onChange(refreshTenderPrices({ ...quote, tenderQuote: tq }, items, rates))} className="flex-none px-2.5 py-1 rounded-lg bg-red-700 hover:bg-red-800 text-white text-[11px] font-semibold" title="Move each line's price to today's figure; titles and dot points you edited are kept">
                      Refresh prices
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-neutral-200 bg-amber-50 rounded-t-xl">
              <div className="text-[13px] text-neutral-800">
                <b>Tender Quote — fully editable.</b> Line items are the standard CONSTRUCTION STAGES (Retention, Basement, Lower Ground, Ground Floor, First Floor, Second Floor, Roof, External Works — a stage with nothing under it is left off): every element sits under its stage with its own share of the real sell price printed beside it, the stage total is the sum of its rows. Columns and walls go under the level they rise from. "Reword for tender" asks the AI to place each element and to reword each row; you review both before anything is used. Edit anything, move a row with its stage select, add or remove items, then check
                the preview below and use <kbd className="px-1 py-0.5 bg-white border border-neutral-300 rounded text-[11px]">Ctrl+P</kbd> / <kbd className="px-1 py-0.5 bg-white border border-neutral-300 rounded text-[11px]">Cmd+P</kbd> → "Save as PDF". No markup drawings are ever included.
              </div>
              <div className="flex items-center gap-2 flex-none">
                <button
                  onClick={() => { try { window.print(); } catch (e) { /* Ctrl+P still works */ } }}
                  className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold"
                >
                  Print / Save as PDF
                </button>
                <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-900 text-white text-xs font-semibold">
                  Close
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <Field label="Revision (title reads QUOTATION (…))">
                  <input value={tq.rev} onChange={(e) => set("rev", e.target.value)} className={inputCls} />
                </Field>
                <Field label={`Date (blank = project date ${quote.projectDate || ""})`}>
                  <input value={tq.date} onChange={(e) => set("date", e.target.value)} className={inputCls} placeholder={quote.projectDate} />
                </Field>
                <Field label="Attention (contact name)">
                  <input value={tq.attentionName} onChange={(e) => set("attentionName", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Attention (company)">
                  <input value={tq.attentionCompany} onChange={(e) => set("attentionCompany", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Project title (e.g. New residence)">
                  <input value={tq.projectTitle} onChange={(e) => set("projectTitle", e.target.value)} className={inputCls} />
                </Field>
                <Field label={`Project address (one line per line; blank = ${quote.projectName || "project name"})`}>
                  <textarea value={tq.projectAddress} onChange={(e) => set("projectAddress", e.target.value)} rows={2} className={textareaCls} />
                </Field>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Project Details — stages (one row per element: dot point · price · stage)</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={rewordItems}
                      disabled={itemBusy || !!itemReview || lineItems.length === 0}
                      data-testid="reword-items"
                      className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-950 text-white hover:bg-blue-900 disabled:opacity-50"
                      title="Rewrite every title and dot point as a professional tender description — you review each line before any of it is used; prices are never touched"
                    >
                      {itemBusy ? "Rewording…" : "✎ Reword for tender"}
                    </button>
                    <button
                      onClick={() => setLineItems(seedTenderItems(quote, items, rates))}
                      className="text-[11px] font-semibold text-amber-800 border border-amber-400 rounded px-2 py-0.5 hover:bg-amber-50"
                      title="Replace the line items with a fresh seed from this quote's elements — prices from the current sell allocation, dot points from the current estimating quantities. Overwrites any edits to the line items (other sections untouched)."
                    >
                      ↺ Reseed from quote &amp; estimates
                    </button>
                    <button
                      onClick={() => setLineItems([...lineItems, { id: uid(), elementId: null, title: "New item", price: "", lines: [] }])}
                      className="text-[11px] font-semibold text-neutral-700 border border-neutral-300 rounded px-2 py-0.5 hover:bg-neutral-50"
                    >
                      + Add line item
                    </button>
                  </div>
                </div>
                {itemErr && <div className="text-[11px] text-red-700 mb-1" data-testid="reword-items-error">Could not reword: {itemErr}</div>}
                {itemReview && (
                  <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-2 mb-2 space-y-2" data-testid="items-wording-review">
                    <div className="text-[11px] text-neutral-700">
                      Proposed wording for each line item — the typed version is shown struck through above each proposal. Edit anything, untick a line to keep it as typed. Nothing changes until you click <b>Use ticked wording</b>; prices are never touched.
                      {itemReview.itemised > 0 && <span className="text-emerald-800" data-testid="items-itemised-note"> {itemReview.itemised} line{itemReview.itemised === 1 ? "" : "s"} carried a &quot;plus N further items&quot; roll-up and {itemReview.itemised === 1 ? "was" : "were"} itemised first, so every element is named.</span>}
                      {itemReview.spec && (
                        <span className="block text-neutral-600" data-testid="items-spec-note">
                          Specifications drawn from this quote&apos;s elements ({itemReview.spec.quote} of {itemReview.spec.points} points matched)
                          {itemReview.spec.takeoffName ? ` and the Estimates takeoff "${itemReview.spec.takeoffName}" (${itemReview.spec.takeoff} points matched)` : " — no Estimates takeoff carries this project's name, so only the quote's rows were used"}.
                          {" "}Every specification in a proposal must be one the context holds — check anything you did not type.
                        </span>
                      )}
                      {itemReview.missing.length > 0 && <span className="text-amber-700"> {itemReview.missing.length} line{itemReview.missing.length === 1 ? "" : "s"} came back without a proposal and stay as typed.</span>}
                    </div>
                    {itemReview.rows.map((r) => (
                      <div key={r.id} className="bg-white border border-neutral-200 rounded p-2" data-testid="items-wording-row">
                        <div className="flex items-start gap-2">
                          <input type="checkbox" checked={r.use} onChange={(e) => setItemRow(r.id, { use: e.target.checked })} className="mt-1.5 flex-none" aria-label="Use this line's wording" disabled={!r.newTitle.trim() && !r.newPoints.length} />
                          <div className="flex-1 min-w-0 space-y-1">
                            {!r.stage && <div className="text-[11px] text-neutral-500 line-through decoration-neutral-300">{r.title}</div>}
                            {r.stage ? <div className="text-[12px] font-semibold text-neutral-800">{r.title} <span className="text-[10px] font-normal text-neutral-500">(stage — title fixed)</span></div> : <input value={r.newTitle} onChange={(e) => setItemRow(r.id, { newTitle: e.target.value })} className={`${inputCls} font-semibold`} placeholder="Title" />}
                            {!r.countMatches && r.newPoints.length > 0 && <div className="text-[11px] text-amber-700">The proposal has {r.newPoints.length} dot point{r.newPoints.length === 1 ? "" : "s"} for {r.points.length} typed — check nothing was merged or dropped.</div>}
                            {r.newPoints.map((p, i) => (
                              <div key={i}>
                                {r.points[i] && <div className="text-[11px] text-neutral-500 line-through decoration-neutral-300">{r.points[i]}</div>}
                                <textarea value={p} onChange={(e) => setItemRow(r.id, { newPoints: r.newPoints.map((x, j) => (j === i ? e.target.value : x)) })} rows={1} className={`${inputCls} text-[12px]`} />
                              </div>
                            ))}
                            {r.points.slice(r.newPoints.length).map((p, i) => <div key={"k" + i} className="text-[11px] text-neutral-500">{p} <span className="text-amber-700">(no proposal — kept as typed only if you untick this line)</span></div>)}
                          </div>
                        </div>
                      </div>
                    ))}
                    {(itemReview.placements || []).length > 0 && (
                      <div className="space-y-1" data-testid="items-placement-review">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Placement under the stages — {itemReview.placed} of {itemReview.placements.length} element{itemReview.placements.length === 1 ? "" : "s"} placed by the AI; {itemReview.placements.filter((p) => p.proposed && p.proposed !== p.from).length} would move</div>
                        <div className="text-[11px] text-neutral-600">The stages are fixed. Change any stage here; every row is placed where this says when you click Use ticked wording (whatever its wording tick).</div>
                        <div className="bg-white border border-neutral-200 rounded divide-y divide-neutral-100">
                          {itemReview.placements.map((p) => (
                            <div key={p.rowId} className="flex items-center gap-2 px-2 py-1" data-testid="placement-row" data-moves={p.proposed && p.proposed !== p.from ? "1" : "0"}>
                              <span className="flex-1 min-w-0 text-[12px] truncate" title={p.name}>{p.name}</span>
                              <span className="text-[11px] text-neutral-500 flex-none">{p.from ? stageTitle(p.from) : "—"} →</span>
                              <select value={p.to} onChange={(e) => setPlacement(p.rowId, e.target.value)} className={`border rounded px-1 py-0.5 text-[12px] flex-none ${p.proposed && p.proposed !== p.from ? "border-orange-400 bg-orange-50 font-semibold" : "border-neutral-300"}`} aria-label={`Stage for ${p.name}`}>
                                {TENDER_STAGES.map((st) => <option key={st.key} value={st.key}>{st.title}</option>)}
                              </select>
                              {!p.proposed && <span className="text-[10px] text-amber-700 flex-none">no proposal</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {(itemReview.optionRows || []).length > 0 && (
                      <div className="space-y-1" data-testid="items-options-review">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Additional options — text only, prices untouched</div>
                        {itemReview.optionRows.map((o) => (
                          <div key={o.id} className="bg-white border border-neutral-200 rounded p-2 flex items-start gap-2" data-testid="option-wording-row">
                            <input type="checkbox" checked={o.use} onChange={(e) => setOptionRow(o.id, { use: e.target.checked })} className="mt-1.5 flex-none" aria-label="Use this option's wording" disabled={!o.newText.trim()} />
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] text-neutral-500 line-through decoration-neutral-300">{o.text}</div>
                              <textarea value={o.newText} onChange={(e) => setOptionRow(o.id, { newText: e.target.value, use: !!e.target.value.trim() })} rows={1} className={`${inputCls} text-[12px]`} placeholder="No proposal — kept as typed" />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {(itemReview.sectionRows || []).length > 0 && (
                      <div className="space-y-1" data-testid="items-sections-review">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Inclusions &amp; exclusions — one line per clause</div>
                        {itemReview.sectionRows.map((s) => (
                          <div key={s.key} className="bg-white border border-neutral-200 rounded p-2 flex items-start gap-2" data-testid="section-wording-row" data-section={s.key}>
                            <input type="checkbox" checked={s.use} onChange={(e) => setSectionRow(s.key, { use: e.target.checked })} className="mt-1.5 flex-none" aria-label={`Use the ${s.label} wording`} disabled={!s.newText.trim()} />
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-semibold text-neutral-700">{s.label}{!s.countMatches && s.newText.trim() ? <span className="text-amber-700 font-normal"> — the proposal has a different number of lines than typed; check nothing was merged or dropped</span> : null}</div>
                              <div className="text-[11px] text-neutral-500 line-through decoration-neutral-300 whitespace-pre-line max-h-24 overflow-auto">{s.text}</div>
                              <textarea value={s.newText} onChange={(e) => setSectionRow(s.key, { newText: e.target.value, use: !!e.target.value.trim() })} rows={Math.min(10, Math.max(3, s.newText.split("\n").length))} className={`${inputCls} text-[12px]`} placeholder="No proposal — kept as typed" />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={applyItemReview} data-testid="apply-items-wording" className="text-[11px] font-semibold px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700">Use ticked wording ({itemReview.rows.filter((r) => r.use).length + (itemReview.optionRows || []).filter((o) => o.use).length + (itemReview.sectionRows || []).filter((s) => s.use).length})</button>
                      <button type="button" onClick={() => setItemReview(null)} className="text-[11px] font-semibold px-2.5 py-1 rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-100">Cancel</button>
                      <span className="text-[10px] text-neutral-400">{itemReview.model ? `proposed by ${itemReview.model}` : ""}</span>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  {lineItems.map((l, idx) => {
                    const rows = itemLines(l).slice(); if (!rows.length || rows[rows.length - 1].text.trim() || rows[rows.length - 1].price.trim()) rows.push({ id: "__spare", elementId: null, name: "", text: "", price: "" });
                    const rowPriced = itemHasRowPrices(l);
                    return (
                      <div key={l.id} className="border border-neutral-200 rounded-lg p-2" data-testid="tender-item" data-stage={l.stage || ""}>
                        <div className="flex gap-2 items-center">
                          <span className="text-xs text-neutral-400 font-mono w-5 text-right">{idx + 1}.</span>
                          {l.stage ? <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-950 text-white flex-none" title="A construction stage — the fixed list every quote uses">stage</span> : null}
                          <input value={l.title} onChange={(e) => patchLine(l.id, { title: e.target.value })} className={`${inputCls} flex-1 min-w-0 font-semibold`} placeholder="Item title (e.g. Ground Floor)" />
                          {rowPriced
                            ? <span className="w-52 flex-none text-right font-mono text-sm font-semibold text-neutral-800 px-2" title="The stage total is the sum of its rows' prices — it is never typed" data-testid="stage-total">{itemPriceLabel(l)}</span>
                            : <input value={l.price} onChange={(e) => patchLine(l.id, { price: e.target.value })} className={`${fixedCls} w-52 flex-none text-right font-mono`} placeholder="$0.00 + GST" />}
                          <button onClick={() => setLineItems(lineItems.filter((x) => x.id !== l.id))} className="text-neutral-300 hover:text-red-500 text-sm flex-none" title="Remove this item and every row under it">✕</button>
                        </div>
                        <div className="space-y-1 mt-1.5 pl-7">
                          {rows.map((row, i) => (
                            <div key={row.id} className="flex gap-1.5 items-start" data-testid={row.id === "__spare" ? "tender-row-spare" : "tender-row"} data-element={row.elementId || ""}>
                              <textarea value={row.text} onChange={(e) => patchRow(l.id, i, { text: e.target.value })} rows={1} className={`${inputCls} flex-1 min-w-0 text-[12px]`} placeholder={row.id === "__spare" ? "• add a row" : "• dot point"} />
                              <input value={row.price} onChange={(e) => patchRow(l.id, i, { price: e.target.value })} className={`${fixedCls} w-40 flex-none text-right font-mono text-[12px]`} placeholder={l.stage || rowPriced ? "$0.00 + GST" : "price (optional)"} aria-label="Row price" />
                              {row.id !== "__spare" && (l.stage || row.elementId) ? (
                                <select value={l.stage || ""} onChange={(e) => moveRow(row.id, e.target.value)} className="border border-neutral-300 rounded px-1 py-1 text-[11px] flex-none w-32" title="Move this row to another stage" aria-label="Stage">
                                  {!l.stage && <option value="">(no stage)</option>}
                                  {TENDER_STAGES.map((st) => <option key={st.key} value={st.key}>{st.title}</option>)}
                                </select>
                              ) : <span className="w-32 flex-none" />}
                              {row.id !== "__spare" ? <button onClick={() => removeRow(l.id, row.id)} className="text-neutral-300 hover:text-red-500 text-sm flex-none pt-1" title="Remove this row">✕</button> : <span className="w-3 flex-none" />}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <ProjectSumEditor tq={tq} set={set} />

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Additional Options</span>
                  <button
                    onClick={() => setOpts([...opts, { id: uid(), text: "", price: "" }])}
                    className="text-[11px] font-semibold text-neutral-700 border border-neutral-300 rounded px-2 py-0.5 hover:bg-neutral-50"
                  >
                    + Add option
                  </button>
                </div>
                <div className="space-y-1.5">
                  {opts.map((o) => (
                    <div key={o.id} className="flex gap-2 items-center">
                      <input value={o.text} onChange={(e) => setOpts(opts.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))} className={inputCls} placeholder="Option description" />
                      <input value={o.price} onChange={(e) => setOpts(opts.map((x) => (x.id === o.id ? { ...x, price: e.target.value } : x)))} className={`${inputCls} w-52 flex-none text-right font-mono`} placeholder="$0.00 + GST" />
                      <button onClick={() => setOpts(opts.filter((x) => x.id !== o.id))} className="text-neutral-300 hover:text-red-500 text-sm flex-none">✕</button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Drawings — Architectural">
                  <textarea value={tq.drawingsArchitect} onChange={(e) => set("drawingsArchitect", e.target.value)} rows={3} className={textareaCls} />
                </Field>
                <Field label="Drawings — Structural">
                  <textarea value={tq.drawingsStructural} onChange={(e) => set("drawingsStructural", e.target.value)} rows={3} className={textareaCls} />
                </Field>
                <Field label="Drawings — Civil">
                  <textarea value={tq.drawingsCivil} onChange={(e) => set("drawingsCivil", e.target.value)} rows={3} className={textareaCls} />
                </Field>
              </div>

              <Field label="Tender Notes (the project's Assumptions, then one extra note per line — information missing from documentation, discrepancies etc.)">
                <TenderNotesCell quote={quote} value={tq.tenderNotes} onChange={(v) => set("tenderNotes", v)} onChangeAssumptions={onChangeAssumptions} rows={4} />
              </Field>
              <Field label="Inclusions (one per line)">
                <textarea value={tq.inclusions} onChange={(e) => set("inclusions", e.target.value)} rows={6} className={textareaCls} />
              </Field>
              <Field label="Specific Exclusions (one per line)">
                <textarea value={tq.specificExclusions} onChange={(e) => set("specificExclusions", e.target.value)} rows={4} className={textareaCls} />
              </Field>
              <Field label="General exclusions (one per line)">
                <textarea value={tq.generalExclusions} onChange={(e) => set("generalExclusions", e.target.value)} rows={8} className={textareaCls} />
              </Field>
              <Field label="Specific Contractual Conditions / Safety / Site conditions / Quote Conditions / OHS (free text, printed as-is)">
                <textarea value={tq.contractualConditions} onChange={(e) => set("contractualConditions", e.target.value)} rows={18} className={`${textareaCls} font-mono text-[11px] whitespace-pre`} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Signed by">
                  <input value={tq.signatureName} onChange={(e) => set("signatureName", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Title">
                  <input value={tq.signatureTitle} onChange={(e) => set("signatureTitle", e.target.value)} className={inputCls} />
                </Field>
              </div>

              <div className="border-t border-neutral-200 pt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Print preview</div>
                <div className="border border-neutral-300 rounded-lg p-5 text-[11px] text-black bg-white">
                  <ReportContent quote={quote} tq={tq} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const inputCls = "w-full border border-neutral-300 rounded px-2 py-1.5 text-sm";
const fixedCls = "border border-neutral-300 rounded px-2 py-1.5 text-sm"; // a fixed-width cell beside a growing one (w-full would win over w-40)
const textareaCls = "w-full border border-neutral-300 rounded px-2 py-1.5 text-sm";

/** The Project Sum controls: show/hide the block, override the sum, bolt an
 * extra markup on top, and choose whether GST + incl-GST lines print. The
 * numbers preview live here exactly as they'll print. */
function ProjectSumEditor({ tq, set }) {
  const gstRate = getGstRate();
  const ps = computeTenderProjectSum(tq, gstRate);
  return (
    <div className="border border-neutral-200 rounded-lg p-3 bg-neutral-50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Project Sum</span>
        <label className="flex items-center gap-1.5 text-xs text-neutral-700">
          <input type="checkbox" checked={tq.showProjectSum !== false} onChange={(e) => set("showProjectSum", e.target.checked)} />
          Show on the document
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <Field label={`Project sum override ($ ex GST — blank = sum of the line items, ${fmtMoney(ps.itemsSum)})`}>
          <input
            value={tq.projectSumOverride ?? ""}
            onChange={(e) => set("projectSumOverride", e.target.value)}
            className={`${inputCls} text-right font-mono`}
            placeholder={fmtMoney(ps.itemsSum)}
          />
        </Field>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral-700 pb-2 flex-none">
            <input type="checkbox" checked={!!tq.markupOn} onChange={(e) => set("markupOn", e.target.checked)} />
            Include markup
          </label>
          <Field label="Markup label">
            <input value={tq.markupLabel ?? "Markup"} onChange={(e) => set("markupLabel", e.target.value)} className={inputCls} disabled={!tq.markupOn} />
          </Field>
          <Field label="Markup %">
            <input
              type="number" step="0.5"
              value={tq.markupPct ?? ""}
              onChange={(e) => set("markupPct", e.target.value)}
              className={`${inputCls} w-24 text-right font-mono`}
              placeholder="e.g. 10"
              disabled={!tq.markupOn}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 gap-3 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-neutral-700">
            <input type="checkbox" checked={tq.gstOn !== false} onChange={(e) => set("gstOn", e.target.checked)} />
            Add GST — print GST ({(gstRate * 100).toLocaleString("en-AU", { maximumFractionDigits: 2 })}%) and TOTAL incl. GST lines
          </label>
          <label className="flex items-center gap-1.5 text-xs text-neutral-700" title="Off: every price on the document prints as a plain figure — the stored prices are not changed">
            <input type="checkbox" checked={gstSuffixOn(tq)} onChange={(e) => set("gstSuffix", e.target.checked)} data-testid="gst-suffix-toggle" />
            Print &quot;+ GST&quot; after every price (stages, rows, options, project sum)
          </label>
        </div>
        <div className="text-[12px] font-mono tabular-nums text-neutral-700">
          {ps.markupOn && <>sub {fmtMoney(ps.base)} + {ps.markupPct}% markup {fmtMoney(ps.markupAmt)} → </>}
          <b>PROJECT SUM {fmtMoney(ps.exGst)} ex GST</b>
          {ps.gstOn && <> · GST {fmtMoney(ps.gst)} · <b>incl. GST {fmtMoney(ps.incGst)}</b></>}
        </div>
      </div>
      <p className="text-[11px] text-neutral-500 mt-1.5">
        The sum adds up the line-item prices above (each read as its ex-GST figure) — type an override to replace it
        with a negotiated round figure. Markup here is an <b>extra</b> document-level markup: the seeded prices already
        carry Gradcon's margin from the sell allocation, so leave it off unless you mean to add more on top.
      </p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-neutral-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Bullets({ text }) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <ul className="list-disc pl-6 space-y-0.5">
      {lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

function ReportContent({ quote, tq }) {
  const lineItems = normalizeTenderItems(tq.items || []);
  const addr = (tq.projectAddress || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const gstRate = getGstRate();
  const ps = computeTenderProjectSum(tq, gstRate);
  const gstPctLabel = (gstRate * 100).toLocaleString("en-AU", { maximumFractionDigits: 2 });
  return (
    <>
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 text-center pt-2">
          <span className="text-2xl font-bold underline underline-offset-4">QUOTATION{tq.rev ? ` (${tq.rev})` : ""}</span>
        </div>
        <img src={GRADCON_LOGO_FULL_DATA_URI} alt="Gradcon Concrete Constructions" className="h-44 flex-none" />
      </div>

      <table className="mb-3">
        <tbody className="align-top">
          <tr><td className="font-bold pr-10 py-0.5 align-top">Date:</td><td>{tq.date || quote.projectDate}</td></tr>
          <tr><td className="font-bold pr-10 py-0.5 align-top">Attention:</td><td>{tq.attentionName}{tq.attentionCompany ? <><br />{tq.attentionCompany}</> : null}</td></tr>
          <tr>
            <td className="font-bold pr-10 py-0.5 align-top">Project:</td>
            <td>
              {tq.projectTitle && <>{tq.projectTitle}<br /></>}
              {addr.length ? addr.map((l, i) => <span key={i}>{l}<br /></span>) : (quote.projectName || "Untitled project")}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="mb-3">
        <div className="font-bold mb-1">Project Details:</div>
        {lineItems.length === 0 && <div className="text-neutral-500 italic">No line items yet.</div>}
        <ol className="space-y-2">
          {lineItems.map((l, i) => {
            const rows = itemLines(l).filter((r) => String(r.text || "").trim() || String(r.price || "").trim());
            return (
              <li key={l.id} className="break-inside-avoid" data-testid="print-item" data-stage={l.stage || ""}>
                <div className="flex justify-between">
                  <span className="font-bold">{i + 1}. {l.title}{l.title && !/[:：]\s*$/.test(l.title) ? ":" : ""}</span>
                  <span className="font-bold">{printedPrice(itemPriceLabel(l), tq)}</span>
                </div>
                {rows.length > 0 && (
                  <ul className="list-disc pl-6 space-y-0.5">
                    {rows.map((r) => (
                      <li key={r.id} data-testid="print-row">
                        <div className="flex justify-between gap-4"><span>{r.text}</span>{String(r.price || "").trim() ? <span className="pl-4 flex-none font-mono tabular-nums">{printedPrice(r.price, tq)}</span> : null}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
        {tq.showProjectSum !== false && (
          <div className="mt-3 ml-auto w-80 break-inside-avoid">
            {ps.markupOn && (
              <>
                <div className="flex justify-between py-0.5">
                  <span>Sub Total (ex GST)</span>
                  <span className="font-mono tabular-nums">{fmtMoney(ps.base)}</span>
                </div>
                <div className="flex justify-between py-0.5">
                  <span>{tq.markupLabel || "Markup"} ({ps.markupPct}%)</span>
                  <span className="font-mono tabular-nums">{fmtMoney(ps.markupAmt)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between py-0.5 font-bold border-t-2 border-black">
              <span>PROJECT SUM {ps.gstOn ? "(ex GST)" : ""}</span>
              <span className="font-mono tabular-nums">{fmtMoney(ps.exGst)}{ps.gstOn || !gstSuffixOn(tq) ? "" : " + GST"}</span>
            </div>
            {ps.gstOn && (
              <>
                <div className="flex justify-between py-0.5">
                  <span>GST ({gstPctLabel}%)</span>
                  <span className="font-mono tabular-nums">{fmtMoney(ps.gst)}</span>
                </div>
                <div className="flex justify-between py-0.5 font-bold border-t border-black">
                  <span>TOTAL (incl. GST)</span>
                  <span className="font-mono tabular-nums">{fmtMoney(ps.incGst)}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {(tq.additionalOptions || []).some((o) => (o.text || "").trim()) && (
        <div className="mb-3 break-inside-avoid">
          <div className="font-bold mb-1">Additional Options:</div>
          <ul className="list-disc pl-6 space-y-0.5">
            {(tq.additionalOptions || []).filter((o) => (o.text || "").trim()).map((o) => (
              <li key={o.id}>
                <div className="flex justify-between"><span>{o.text}</span><span className="pl-4 flex-none">{printedPrice(o.price, tq)}</span></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(tq.drawingsArchitect || tq.drawingsStructural || tq.drawingsCivil) && (
        <div className="mb-3 break-inside-avoid">
          <div className="font-bold mb-1">Drawings relevant to quote:</div>
          {[["Architectural", tq.drawingsArchitect], ["Structural", tq.drawingsStructural], ["Civil", tq.drawingsCivil]].map(([label, text]) =>
            text ? (
              <div key={label} className="flex gap-2 mb-1 pl-6"><span className="w-28 flex-none">• {label}:</span><span className="whitespace-pre-wrap">{text}</span></div>
            ) : null
          )}
        </div>
      )}

      {tenderNoteLines(quote, tq.tenderNotes).all.length > 0 && (
        <div className="mb-3 break-inside-avoid" data-testid="tender-notes-print">
          <div className="font-bold mb-1">Tender Notes: <span className="font-normal italic">(information missing from documentation, discrepancies, assumptions etc.)</span></div>
          <Bullets text={tenderNoteLines(quote, tq.tenderNotes).all.join("\n")} />
        </div>
      )}

      {tq.inclusions && (
        <div className="mb-3 break-inside-avoid">
          <div className="font-bold mb-1">Inclusions:</div>
          <Bullets text={tq.inclusions} />
        </div>
      )}

      {tq.specificExclusions && (
        <div className="mb-3 break-inside-avoid">
          <div className="font-bold mb-1">Specific Exclusions:</div>
          <Bullets text={tq.specificExclusions} />
        </div>
      )}

      {tq.generalExclusions && (
        <div className="mb-3 break-inside-avoid">
          <div className="font-bold mb-1">General exclusions <span className="font-normal italic">(Unless noted in inclusions):</span></div>
          <Bullets text={tq.generalExclusions} />
        </div>
      )}

      {tq.contractualConditions && (
        <div className="mb-3">
          <div className="font-bold mb-1">Specific Contractual Conditions:</div>
          <div className="whitespace-pre-wrap">{tq.contractualConditions}</div>
        </div>
      )}

      <div className="mt-8 break-inside-avoid border-t border-black pt-2 w-64">
        <div>{tq.signatureName}</div>
        <div>{tq.signatureTitle}</div>
        <div>Gradcon Concrete Constructions</div>
      </div>
    </>
  );
}
