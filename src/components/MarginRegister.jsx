/**
 * The Margin Register (Grady, 1 Nov 2026: "the final quote margin register so
 * we can adjust and determine what rate to apply per line and also the
 * possibility of changing the overall rate"): every priced line of the quote
 * with its loaded cost, the rate applied, where that rate came from and the
 * sell, the per-class subtotals and the blended whole. Every rate cell is
 * editable in place and writes back onto the element or the subcontract
 * quote row (never kept twice); the overall rate box is the ladder's project
 * margin. Priced through computeMarginRegister — never its own arithmetic.
 */
import { useMemo } from "react";
import { computeMarginRegister, projectMargin, pinnedMargin, getDefaultMargin, money, money2, markupFromMargin, marginFromMarkup } from "../lib/costing.js";
import { PctInput } from "./atoms.jsx";
import { packageList, packageMargin, packageName, packageColour, inkFor } from "../lib/packages.js";

const pctLabel = (f) => `${Math.round((Number(f) || 0) * 1000) / 10}%`;
const SOURCE_LABEL = { project: "project", element: "element · pinned", row: "row · pinned", package: "package · pinned" };

export default function MarginRegister({ items, rates, quote, scope, setProjectMargin, setElementMargin, setRowMargin, open, onToggle, pkg = null, setPackageMargin }) {
  const reg = useMemo(() => computeMarginRegister(items, rates, quote || {}, scope), [items, rates, quote, scope]);
  // a PACKAGE's own register (lib/packages.js, 4 Nov 2026): its lines only, its overall rate = the package margin
  // (blank = the project's), written back onto the package — the project's register stays the whole quote
  const projectPm = projectMargin(quote || {});
  const pm = pkg ? packageMargin(quote || {}, pkg) : projectPm;
  const setOverall = pkg ? (v) => setPackageMargin && setPackageMargin(pkg.id, v) : setProjectMargin;
  const overallPinned = pkg ? pinnedMargin(pkg.marginPct) != null : pinnedMargin(quote && quote.marginPct) != null;
  const band = pkg ? { background: packageColour(quote, pkg), color: inkFor(packageColour(quote, pkg)) } : undefined;
  const t = reg.totals;
  const pkgNameOf = (id) => { const p = packageList(quote).find((x) => x.id === id); return p ? (p.name || "Package") : ""; };
  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden print:hidden" data-testid={pkg ? "package-margin-register" : "margin-register"} id={pkg ? `margin-register-${pkg.id}` : "margin-register"} data-package={pkg ? pkg.id : undefined}>
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left bg-neutral-900 text-white" data-band={pkg ? undefined : "summary"} style={band} data-testid="margin-register-toggle" aria-expanded={open}>
        <span className="text-xs font-semibold uppercase tracking-wide">Margin register{pkg ? ` — ${packageName(pkg)}` : ""}</span>
        <span className="text-[12px] font-mono tabular-nums text-neutral-300">
          overall <b className="text-white">{pctLabel(pm)}</b> · blended <b className="text-white" data-testid="margin-register-blended">{pctLabel(t.blended)}</b> · sell <b className="text-orange-300">{money(t.sell)}</b> ex GST {reg.pinned > 0 && <span className="text-amber-300">· {reg.pinned} pinned</span>} <span className="ml-2 text-neutral-400">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
            <label className="flex items-center gap-2">
              <span className="font-semibold text-neutral-700">{pkg ? "Package rate" : "Overall rate"}</span>
              <PctInput value={pm} onChange={(v) => setOverall(v)} className="!w-16" title={pkg ? "This package's margin — its lines not pinned follow it; clear it to follow the project margin" : "The project margin — every line not pinned follows it"} data-testid="margin-register-overall" />
              <span className="text-neutral-400">= markup</span>
              <PctInput value={markupFromMargin(pm)} max={900} onChange={(v) => setOverall(v === undefined ? undefined : marginFromMarkup(v))} className="!w-16" title="The same figure as a markup on cost — typing here sets the margin" data-testid="margin-register-overall-markup" />
              {overallPinned && (
                <button type="button" className="text-neutral-400 hover:text-neutral-700" title={pkg ? `Back to the project margin ${pctLabel(projectPm)}` : `Back to the Settings default ${pctLabel(getDefaultMargin())}`} onClick={() => setOverall(undefined)}>↺ default</button>
              )}
            </label>
            <span className="text-neutral-500">Own work {money(reg.byClass.own.loaded)} at {reg.byClass.own.margin == null ? "—" : pctLabel(reg.byClass.own.margin)} → {money(reg.byClass.own.sell)}</span>
            <span className="text-neutral-500">Subcontract quotes {money(reg.byClass.sub.loaded)} at {reg.byClass.sub.margin == null ? "—" : pctLabel(reg.byClass.sub.margin)} → {money(reg.byClass.sub.sell)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-neutral-50 text-neutral-500 text-[10px] uppercase tracking-wide">
                  <th className="text-left px-2 py-1.5 font-medium">Line</th>
                  <th className="text-right px-2 py-1.5 font-medium" title="Direct cost">Cost</th>
                  <th className="text-right px-2 py-1.5 font-medium" title="Direct cost with the project's overheads and contingency on it">Loaded</th>
                  <th className="text-right px-2 py-1.5 font-medium" title="Margin on the sell price">Margin</th>
                  <th className="text-right px-2 py-1.5 font-medium" title="The same rate as a markup on cost — type either; the other follows">= Markup</th>
                  <th className="text-left px-2 py-1.5 font-medium">Source</th>
                  <th className="text-right px-2 py-1.5 font-medium">Sell ex GST</th>
                  <th className="text-right px-2 py-1.5 font-medium">Sell inc GST</th>
                </tr>
              </thead>
              <tbody>
                {reg.lines.map((l) => {
                  const item = items.find((it) => it.id === l.elementId);
                  const pinned = l.kind === "sub" ? pinnedMargin(item && item.rowMargins && item.rowMargins[l.key]) : pinnedMargin(item && item.marginPct);
                  const base = l.inherited != null ? l.inherited : pm; // the package's margin when it pins one (lib/packages.js), else the project's
                  const inherit = l.kind === "sub" ? (pinnedMargin(item && item.marginPct) ?? base) : base;
                  return (
                    <tr key={`${l.elementId}:${l.key || "own"}`} className="border-t border-neutral-100" data-testid="margin-register-row" data-kind={l.kind}>
                      <td className="px-2 py-1">
                        <span className="text-neutral-800">{l.kind === "sub" ? l.name : l.element}</span>
                        {l.kind === "sub"
                          ? <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 rounded px-1">sub quote</span>
                          : <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-500 border border-neutral-200 rounded px-1">own work</span>}
                        {l.kind === "sub" && <div className="text-[10px] text-neutral-400">{l.element}</div>}
                        {l.packageId && pkgNameOf(l.packageId) && <div className="text-[10px] text-neutral-400" data-testid="margin-register-package">{pkgNameOf(l.packageId)}</div>}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{money2(l.cost)}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{money2(l.loaded)}</td>
                      <td className="px-2 py-1 text-right">
                        <PctInput value={pinned ?? undefined} placeholder={pctLabel(inherit)} className="!w-16 !py-0.5" title={pinned != null ? "Pinned — clear to inherit" : `Inherits ${pctLabel(inherit)} — type a rate to pin this line`}
                          onChange={(v) => (l.kind === "sub" ? setRowMargin(l.elementId, l.key, v) : setElementMargin(l.elementId, v))} />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <PctInput value={pinned != null ? markupFromMargin(pinned) : undefined} max={900} placeholder={pctLabel(markupFromMargin(inherit))} className="!w-16 !py-0.5" title="Markup on cost — typing here pins the line at the matching margin; clear to inherit" data-testid="margin-register-markup"
                          onChange={(v) => { const m = v === undefined ? undefined : marginFromMarkup(v); l.kind === "sub" ? setRowMargin(l.elementId, l.key, m) : setElementMargin(l.elementId, m); }} />
                      </td>
                      <td className="px-2 py-1 text-neutral-500">{SOURCE_LABEL[l.source] || l.source}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{money2(l.sell)}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-neutral-500">{money2(l.sell * (t.sellIncGst / (t.sell || 1)))}</td>
                    </tr>
                  );
                })}
                {reg.lines.length === 0 && <tr><td colSpan={8} className="px-2 py-3 text-center text-neutral-400">Nothing priced yet.</td></tr>}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-800 font-semibold">
                  <td className="px-2 py-1.5">{pkg ? `Whole package — ${packageName(pkg)}` : "Whole quote"}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{money2(t.cost)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{money2(t.loaded)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums" data-testid="margin-register-blended-cell">{pctLabel(t.blended)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-500">{pctLabel(markupFromMargin(t.blended))}</td>
                  <td className="px-2 py-1.5 text-neutral-500 font-normal">blended</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums" data-testid="margin-register-sell">{money2(t.sell)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{money2(t.sellIncGst)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="text-[11px] text-neutral-500">Loaded = direct cost + overheads + contingency, as the ladder's subtotal. Margin is on the sell price (sell = loaded ÷ (1 − margin)); the Markup column is the same rate on cost (a 33.3% markup is a 25% margin) — type either and the other follows. A rate typed here is written onto that element or quote row and shows in the Quote Summary; clear it to inherit again.</div>
        </div>
      )}
    </div>
  );
}
