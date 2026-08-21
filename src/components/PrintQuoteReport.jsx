import {
  CATEGORY_ORDER, SECTION_ORDER, FULL_CATALOG, RESOURCE_COLS, MARGIN_STEPS, DEFAULT_MARGIN,
} from "../data/catalog.js";
import {
  computeElementCost, computeGrandTotal, computeMarginLadder, rateKey, lookupRate, money, money2,
} from "../lib/costing.js";

/**
 * Print/PDF export — the "window.print() + @media print stylesheet" approach
 * CLAUDE.md flags as the cheapest way to add this. Deliberately NOT a
 * printout of the on-screen editable UI: that would either (a) only show
 * whatever categories/cards happen to be expanded on screen (they're
 * conditionally unmounted when collapsed, so CSS alone can't reveal them),
 * or (b) print all 114 catalog products per element regardless, which is
 * useless for a client-facing quote. Instead this is a standalone report,
 * built straight from computeElementCost, that lists only the lines an
 * estimator actually filled in. Hidden on screen, shown only under
 * `@media print` via Tailwind's `print:` variant.
 */
export default function PrintQuoteReport({ quote, items, rates }) {
  const grandTotal = computeGrandTotal(items, rates);
  const { subtotal, rows } = computeMarginLadder(
    grandTotal, quote.overheadPct, quote.contingencyPct, quote.gfa, MARGIN_STEPS
  );

  return (
    <div className="hidden print:block text-black text-[11px]">
      <div className="border-b-2 border-black pb-2 mb-3">
        <div className="text-[10px] uppercase tracking-widest text-neutral-600 font-semibold">
          Gradcon Concrete Constructions
        </div>
        <div className="text-xl font-bold">{quote.projectName || "Untitled project"}</div>
        <div className="text-neutral-600">Date: {quote.projectDate}</div>
      </div>

      {CATEGORY_ORDER.map((category) => {
        const catItems = items.filter((it) => it.category === category);
        if (catItems.length === 0) return null;
        return (
          <div key={category} className="mb-3">
            <div className="text-xs font-bold uppercase tracking-wide bg-neutral-200 px-2 py-1">{category}</div>
            {SECTION_ORDER.map((section) => {
              const secItems = catItems.filter((it) => it.section === section);
              if (secItems.length === 0) return null;
              return (
                <div key={section} className="pl-2">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-500 font-semibold mt-1">
                    {section}
                  </div>
                  {secItems.map((item) => (
                    <ElementReportBlock key={item.id} item={item} rates={rates} />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="mt-4 border-t-2 border-black pt-2 flex justify-between text-sm font-bold break-inside-avoid">
        <span>Grand Total (ex GST)</span>
        <span>{money2(grandTotal)}</span>
      </div>

      <div className="mt-3 break-inside-avoid">
        <div className="text-xs font-bold uppercase tracking-wide bg-neutral-200 px-2 py-1">GFA &amp; On-Costs</div>
        <div className="px-2 py-1 flex justify-between">
          <span>Total GFA</span><span>{quote.gfa ? `${quote.gfa} m²` : "—"}</span>
        </div>
        <div className="px-2 py-1 flex justify-between">
          <span>Overheads</span><span>{Math.round((Number(quote.overheadPct) || 0) * 100)}%</span>
        </div>
        <div className="px-2 py-1 flex justify-between">
          <span>Contingency</span><span>{Math.round((Number(quote.contingencyPct) || 0) * 100)}%</span>
        </div>
        <div className="px-2 py-1 flex justify-between font-semibold border-t border-neutral-300">
          <span>Subtotal</span><span>{money2(subtotal)}</span>
        </div>
      </div>

      <div className="mt-3 break-inside-avoid">
        <div className="text-xs font-bold uppercase tracking-wide bg-neutral-200 px-2 py-1">Margin Ladder</div>
        <table className="w-full text-[11px] mt-1">
          <thead>
            <tr className="text-left border-b border-neutral-400">
              <th className="py-1">Margin</th>
              <th className="py-1 text-right">Sell (ex GST)</th>
              <th className="py-1 text-right">Sell (inc GST)</th>
              <th className="py-1 text-right">$/m² GFA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.margin}
                className={`border-b border-neutral-200 ${Math.abs(row.margin - DEFAULT_MARGIN) < 1e-9 ? "font-bold" : ""}`}
              >
                <td className="py-0.5">{Math.round(row.margin * 100)}%</td>
                <td className="py-0.5 text-right">{money(row.sellExGst)}</td>
                <td className="py-0.5 text-right">{money(row.sellIncGst)}</td>
                <td className="py-0.5 text-right">{row.perM2 > 0 ? money2(row.perM2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ElementReportBlock({ item, rates }) {
  const cost = computeElementCost(item, rates);

  const materialLines = [];
  FULL_CATALOG.forEach((cat) => {
    cat.products.forEach((p) => {
      const qKey = rateKey(cat.key, p.name, p.unit);
      const qty = Number(item.qtys[qKey]) || 0;
      if (qty > 0) {
        const rate = lookupRate(rates, qKey, { unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight });
        const rowTotal =
          cat.weightBasis && rate.unitWeight
            ? ((qty * rate.unitWeight) / 1000) * rate.unitCost
            : qty * rate.unitCost;
        materialLines.push({ key: qKey, label: `${p.name} (${cat.key})`, qty, unit: p.unit, total: rowTotal });
      }
    });
  });

  const labourLines = RESOURCE_COLS.filter((res) => cost.resourceTotals[res.key] > 0).map((res) => ({
    key: res.key,
    label: res.name,
    qty: cost.resourceTotals[res.key],
    unit: res.unit,
    total: cost.resourceCosts[res.key],
  }));

  const customLines = item.additional.filter((a) => (Number(a.qty) || 0) > 0 && a.name);
  const noLines = materialLines.length === 0 && labourLines.length === 0 && customLines.length === 0;

  return (
    <div className="mb-2 break-inside-avoid">
      <div className="flex justify-between font-semibold border-b border-neutral-300 py-0.5">
        <span>{item.label}</span>
        <span>{money2(cost.total)}</span>
      </div>
      {[...materialLines, ...labourLines].map((l) => (
        <div key={l.key} className="flex justify-between pl-2 text-neutral-700">
          <span>{l.label} — {l.qty.toLocaleString("en-AU", { maximumFractionDigits: 2 })} {l.unit}</span>
          <span>{money2(l.total)}</span>
        </div>
      ))}
      {customLines.map((a) => (
        <div key={a.id} className="flex justify-between pl-2 text-neutral-700">
          <span>{a.name} — {a.qty} {a.unit}</span>
          <span>{money2((Number(a.qty) || 0) * (Number(a.rate) || 0))}</span>
        </div>
      ))}
      {noLines && <div className="pl-2 text-neutral-400 italic">No quantities entered</div>}
    </div>
  );
}
