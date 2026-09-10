import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { rateKey, money2, lookupRate, computeRowTotal, rowContext, autoMinimumCartage, autoConcreteSurcharge, autoEnvironmentLevy, additionalRowsFor, additionalRowTotal } from "../lib/costing.js";
import { NumInput } from "./atoms.jsx";

/**
 * Renders EVERY product in one catalog category as a line item, applicable
 * or not — this is the "roll everything down" behaviour Grady asked for.
 * Nothing here should filter products by element type; if a category
 * shouldn't apply to a given job, the estimator just leaves those rows
 * blank (blank quantities cost nothing — see computeElementCost).
 */
export default function CategoryBlock({ cat, item, rates, onQtyChange, onRateChange, catOpen, toggleCat, catTotal, onAddCustom, onRemoveCustom, onChangeCustom }) {
  const hasWeight = cat.products.some((p) => p.unitWeight != null);
  // Custom rows the estimator added under THIS category (item.additional
  // rows carrying cat === this key). They sit after the last catalog product,
  // cost qty × rate through computeElementCost, and are part of catTotal.
  const customRows = additionalRowsFor(item, cat.key);
  const hasArea = !!cat.areaBasis;
  const hasLength = !!cat.lengthBasis;
  // Reinforcement priced in kg/m³ needs the element's poured volume, both to
  // cost the row and to show the estimator the tonnage the rate works out to.
  const hasVolumeRate = !!cat.volumeRateBasis;
  const extraCols = (hasArea ? 1 : 0) + (hasLength ? 1 : 0) + (hasVolumeRate ? 2 : 0) + (hasWeight ? 2 : 0);
  const ctx = rowContext(item);
  // A last delivered load under 4 m³ auto-applies Minimum cartage (amber ghost on its
  // row, like the crew sheet) — typing a Qty there takes the row manual.
  const minCartage = cat.key === "CONCRETE" ? autoMinimumCartage(item, rates) : null;
  // The production & transport surcharge auto-applies per m³ to the whole
  // poured volume ($2.59/m³ default) — same amber-ghost treatment.
  const surcharge = cat.key === "CONCRETE" ? autoConcreteSurcharge(item, rates) : null;
  const levy = cat.key === "CONCRETE" ? autoEnvironmentLevy(item, rates) : null;
  return (
    <div className="border border-neutral-200 rounded-lg overflow-hidden bg-white">
      <button
        onClick={toggleCat}
        className="w-full flex items-center justify-between px-3 py-2 bg-neutral-800 text-white text-xs font-semibold tracking-wide uppercase hover:bg-neutral-700 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {catOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {cat.label}
        </span>
        <span className="font-mono tabular-nums normal-case font-semibold text-orange-300">
          {money2(catTotal)}
        </span>
      </button>
      {catOpen && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-neutral-50 text-neutral-500 text-[11px] uppercase tracking-wide">
                <th className="text-left px-3 py-1.5 font-medium">Product</th>
                <th className="text-left px-2 py-1.5 font-medium">Unit</th>
                <th className="text-right px-2 py-1.5 font-medium w-24">Qty</th>
                {hasArea && <th className="text-right px-2 py-1.5 font-medium w-20">Sheets</th>}
                {hasLength && <th className="text-right px-2 py-1.5 font-medium w-20">Bars</th>}
                {hasVolumeRate && <th className="text-right px-2 py-1.5 font-medium w-20">On m³</th>}
                {hasVolumeRate && <th className="text-right px-2 py-1.5 font-medium w-20">Steel (t)</th>}
                {hasWeight && <th className="text-right px-2 py-1.5 font-medium w-20">Wt (kg)</th>}
                {hasWeight && <th className="text-right px-2 py-1.5 font-medium w-20">Total (t)</th>}
                <th className="text-right px-2 py-1.5 font-medium w-24">Unit $</th>
                <th className="text-right px-3 py-1.5 font-medium w-28">Total $</th>
              </tr>
            </thead>
            <tbody>
              {cat.products.map((p) => {
                const qKey = rateKey(cat.key, p.name, p.unit);
                const rate = lookupRate(rates, qKey, { unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight, sheetArea: p.sheetArea, barLength: p.barLength });
                const qty = Number(item.qtys[qKey]) || 0;
                const sheets = hasArea && rate.sheetArea ? Math.ceil(qty / rate.sheetArea) : null;
                const bars = hasLength && rate.barLength ? Math.ceil(qty / rate.barLength) : null;
                const totalWeight = rate.unitWeight
                  ? ((sheets != null ? sheets : bars != null ? bars : qty) * rate.unitWeight) / 1000
                  : null;
                const isAutoCartage = minCartage && minCartage.key === qKey;
                const isAutoSur = surcharge && surcharge.key === qKey;
                const isAutoLevy = levy && levy.key === qKey;
                const autoRow = isAutoCartage ? minCartage : isAutoSur ? surcharge : isAutoLevy ? levy : null;
                const rowTotal = autoRow ? autoRow.total : computeRowTotal(cat, rate, qty, ctx);
                // kg/m³ × the element's poured m³ — the tonnage this rate buys
                const rateTonnes = hasVolumeRate ? (qty * ctx.concreteM3) / 1000 : null;
                const filled = qty > 0 || !!autoRow;
                return (
                  <tr key={qKey} className={`border-t border-neutral-100 ${filled ? "bg-orange-50/40" : ""}`}>
                    <td className="px-3 py-1 text-neutral-700">
                      {p.name}
                      {isAutoCartage && (
                        <span
                          className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                          title={`The pour divides into ${minCartage.loads - 1} full ${minCartage.threshold} m³ load${minCartage.loads - 1 === 1 ? "" : "s"} with ${minCartage.remainder} m³ left over. That remainder is a part load, ${minCartage.qty} m³ short of the ${minCartage.threshold} m³ minimum. The load size is editable in the Rates modal ("Minimum cartage load size"); type a quantity here to price a known delivery split instead.`}
                        >
                          auto — {minCartage.remainder} m³ remainder, {minCartage.qty} m³ short of {minCartage.threshold} m³
                        </span>
                      )}
                      {isAutoSur && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">auto — per m³ of concrete</span>}
                      {isAutoLevy && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">auto — per m³ of concrete</span>}
                    </td>
                    <td className="px-2 py-1 text-neutral-400">{p.unit}</td>
                    <td className="px-2 py-1">
                      <NumInput
                        value={item.qtys[qKey]}
                        placeholder={autoRow ? String(autoRow.qty) : undefined}
                        className={autoRow ? "placeholder:text-amber-800 placeholder:opacity-100 placeholder:font-semibold border-amber-400" : ""}
                        onChange={(v) => onQtyChange(qKey, v)}
                      />
                    </td>
                    {hasArea && (
                      <td className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums">
                        {sheets != null && qty > 0 ? sheets : "—"}
                      </td>
                    )}
                    {hasLength && (
                      <td className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums">
                        {bars != null && qty > 0 ? bars : "—"}
                      </td>
                    )}
                    {hasVolumeRate && (
                      <td className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums">
                        {ctx.concreteM3 > 0 ? ctx.concreteM3.toLocaleString("en-AU") : "—"}
                      </td>
                    )}
                    {hasVolumeRate && (
                      <td
                        className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums"
                        title={qty > 0 && !(ctx.concreteM3 > 0) ? "No concrete entered on this element yet — the rate costs nothing until there is a volume to apply it to." : undefined}
                      >
                        {rateTonnes != null && qty > 0 ? rateTonnes.toFixed(3) : "—"}
                      </td>
                    )}
                    {hasWeight && (
                      <td className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums">
                        {rate.unitWeight != null ? rate.unitWeight : "—"}
                      </td>
                    )}
                    {hasWeight && (
                      <td className="px-2 py-1 text-right font-mono text-neutral-400 tabular-nums">
                        {totalWeight != null && qty > 0 ? totalWeight.toFixed(3) : "—"}
                      </td>
                    )}
                    <td className="px-2 py-1 text-right font-mono text-neutral-500 tabular-nums">
                      {/* Editable-in-place rates, saved to the same
                          rates-library key the Rates modal shows (one figure,
                          everywhere): the small-load charge, and every
                          "quote"-unit row — those are subcontract items whose
                          price IS the quote received, so the estimator types
                          the quoted amount straight onto the row (qty 1 books
                          the whole quote). */}
                      {/* The kg/m³ reinforcement rows price at $/tonne — the
                          steel rate moves with the market often enough that
                          it's worth editing on the row rather than only in the
                          Rates modal. Same key either way, so one figure. */}
                      {onRateChange && ((cat.key === "CONCRETE" && (/minimum cartage|small load/i.test(p.name) || /transport surcharge/i.test(p.name) || /environment levy/i.test(p.name))) || p.unit === "quote" || cat.volumeRateBasis) ? (
                        <NumInput
                          step={p.unit === "quote" ? "50" : cat.volumeRateBasis ? "25" : "0.25"}
                          value={rate.unitCost}
                          placeholder={p.unit === "quote" ? "quote $" : undefined}
                          onChange={(v) => onRateChange(qKey, v, p.unitCost ?? 0)}
                        />
                      ) : (
                        money2(rate.unitCost)
                      )}
                    </td>
                    <td className={`px-3 py-1 text-right font-mono tabular-nums font-medium ${filled ? "text-neutral-900" : "text-neutral-300"}`}>
                      {/* Subcontract "quote" rows: the TOTAL itself is where
                          the received quote lands — type the contractor's
                          figure straight in (qty books as 1, the rate becomes
                          the quote); clear it to zero the row again. */}
                      {p.unit === "quote" && onRateChange ? (
                        <NumInput
                          step="50"
                          value={qty > 0 ? rowTotal : undefined}
                          placeholder="quote $"
                          onChange={(v) => {
                            const n = Number(v);
                            if (v === undefined || v === "" || !Number.isFinite(n)) {
                              onQtyChange(qKey, undefined);
                            } else {
                              const q = qty > 0 ? qty : 1;
                              if (!(qty > 0)) onQtyChange(qKey, 1);
                              onRateChange(qKey, n / q, p.unitCost ?? 0);
                            }
                          }}
                        />
                      ) : (
                        money2(rowTotal)
                      )}
                    </td>
                  </tr>
                );
              })}
              {customRows.map((a) => {
                const total = additionalRowTotal(a);
                const filled = total > 0;
                return (
                  <tr key={a.id} data-custom-row={a.id} className={`border-t border-dashed border-neutral-200 ${filled ? "bg-orange-50/40" : "bg-neutral-50/60"}`}>
                    <td className="px-3 py-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 flex-none" title="Custom item added under this category">custom</span>
                        <input
                          type="text"
                          value={a.name || ""}
                          placeholder="Item name (e.g. Certification)"
                          onChange={(e) => onChangeCustom(a.id, "name", e.target.value)}
                          className="flex-1 min-w-[10rem] border border-neutral-200 rounded px-2 py-1 text-[13px] focus:outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={a.unit || ""}
                        placeholder="unit"
                        onChange={(e) => onChangeCustom(a.id, "unit", e.target.value)}
                        className="w-16 border border-neutral-200 rounded px-2 py-1 text-[13px] focus:outline-none focus:ring-2 focus:ring-orange-400"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <NumInput value={a.qty} onChange={(v) => onChangeCustom(a.id, "qty", v)} />
                    </td>
                    {extraCols > 0 && <td colSpan={extraCols} className="px-2 py-1 text-right font-mono text-neutral-300 tabular-nums">—</td>}
                    <td className="px-2 py-1">
                      <NumInput step="0.25" value={a.rate} placeholder="$/unit" onChange={(v) => onChangeCustom(a.id, "rate", v)} />
                    </td>
                    <td className={`px-3 py-1 text-right font-mono tabular-nums font-medium ${filled ? "text-neutral-900" : "text-neutral-300"}`}>
                      <div className="flex items-center justify-end gap-1.5">
                        <span>{money2(total)}</span>
                        <button
                          type="button"
                          onClick={() => onRemoveCustom(a.id)}
                          title="Remove this custom item"
                          className="text-neutral-400 hover:text-red-600"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {onAddCustom && (
                <tr className="border-t border-neutral-100 bg-neutral-50/40">
                  <td colSpan={5 + extraCols} className="px-3 py-1">
                    <button
                      type="button"
                      onClick={() => onAddCustom(cat.key)}
                      data-add-custom={cat.key}
                      title={`Add your own line under ${cat.label} — name, unit, quantity and rate are all yours; it costs qty × rate into this category`}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-orange-700 hover:text-orange-800"
                    >
                      <Plus size={13} /> Add item under {cat.label}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
