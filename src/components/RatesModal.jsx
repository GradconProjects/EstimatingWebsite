import { X } from "lucide-react";
import { FULL_CATALOG, RESOURCE_COLS } from "../data/catalog.js";
import { rateKey } from "../lib/costing.js";
import { NumInput } from "./atoms.jsx";

export default function RatesModal({ rates, setRates, onClose }) {
  const update = (key, field, value) =>
    setRates((r) => ({ ...r, [key]: { ...r[key], [field]: value === "" ? null : Number(value) } }));

  // Weight/area/length-basis categories price by tonne/sheet/bar (see CLAUDE.md rule 2),
  // not by the unit the estimator actually types into the quote (m, m², m) — this backs
  // out that "what am I really paying per m/m²" figure from the catalog rate, and lets
  // editing it flow back into the real unitCost so Amount = Qty × Rate still holds.
  const unitRateOf = (cat, r) => {
    if (cat.weightBasis) return r.unitWeight ? (r.unitCost * r.unitWeight) / 1000 : null;
    if (cat.areaBasis) return r.sheetArea ? r.unitCost / r.sheetArea : null;
    if (cat.lengthBasis) return r.barLength ? r.unitCost / r.barLength : null;
    return null;
  };
  const updateUnitRate = (cat, key, r, value) => {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    if (cat.weightBasis) { if (r.unitWeight) update(key, "unitCost", (value * 1000) / r.unitWeight); return; }
    if (cat.areaBasis) { if (r.sheetArea) update(key, "unitCost", value * r.sheetArea); return; }
    if (cat.lengthBasis) { if (r.barLength) update(key, "unitCost", value * r.barLength); return; }
  };
  const unitRateLabel = (cat) =>
    cat.weightBasis ? "$/m" : cat.areaBasis ? "$/m²" : cat.lengthBasis ? "$/m" : null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200">
          <h2 className="font-semibold text-neutral-800">Rates — edit the Gradcon catalog</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          {FULL_CATALOG.map((cat) => (
            <div key={cat.key}>
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
                {cat.label}
                {cat.areaBasis && <span className="normal-case font-normal text-neutral-400"> — qty entered in m², sheet area below controls the conversion</span>}
                {cat.lengthBasis && <span className="normal-case font-normal text-neutral-400"> — qty entered in m, bar length below controls the conversion</span>}
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-neutral-400">
                    <th className="text-left font-medium pb-1">Product</th>
                    <th className="text-left font-medium pb-1 w-28">{cat.products.some((p) => p.unitWeight != null) ? "Weight (kg)" : ""}</th>
                    <th className="text-left font-medium pb-1 w-28">{cat.areaBasis ? "Sheet area (m²)" : cat.lengthBasis ? "Bar length (m)" : ""}</th>
                    <th className="text-left font-medium pb-1 w-28">Base rate ($/{cat.products[0]?.unit})</th>
                    {unitRateLabel(cat) && <th className="text-left font-medium pb-1 w-28">Unit rate ({unitRateLabel(cat)})</th>}
                  </tr>
                </thead>
                <tbody>
                  {cat.products.map((p) => {
                    const k = rateKey(cat.key, p.name, p.unit);
                    const r = rates[k] || { unitCost: p.unitCost, unitWeight: p.unitWeight, sheetArea: p.sheetArea, barLength: p.barLength };
                    const unitRate = unitRateOf(cat, r);
                    return (
                      <tr key={k} className="border-t border-neutral-100">
                        <td className="py-1 pr-2 text-neutral-700">{p.name} <span className="text-neutral-400">({p.unit})</span></td>
                        {p.unitWeight != null ? (
                          <td className="py-1 pr-2 w-28">
                            <NumInput value={r.unitWeight} onChange={(v) => update(k, "unitWeight", v)} />
                          </td>
                        ) : <td className="w-28"></td>}
                        {cat.areaBasis ? (
                          <td className="py-1 pr-2 w-28">
                            <NumInput value={r.sheetArea} onChange={(v) => update(k, "sheetArea", v)} />
                          </td>
                        ) : cat.lengthBasis ? (
                          <td className="py-1 pr-2 w-28">
                            <NumInput value={r.barLength} onChange={(v) => update(k, "barLength", v)} />
                          </td>
                        ) : <td className="w-28"></td>}
                        <td className="py-1 pr-2 w-28">
                          <NumInput value={r.unitCost} onChange={(v) => update(k, "unitCost", v)} />
                        </td>
                        {unitRateLabel(cat) && (
                          <td className="py-1 w-28">
                            <NumInput value={unitRate} onChange={(v) => updateUnitRate(cat, k, r, v)} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">LABOUR &amp; EQUIPMENT</div>
            <table className="w-full text-[13px]">
              <tbody>
                {RESOURCE_COLS.map((res) => {
                  const k = rateKey("LABOUR", res.name, res.unit);
                  const r = rates[k] || { unitCost: res.rate };
                  return (
                    <tr key={k} className="border-t border-neutral-100">
                      <td className="py-1 pr-2 text-neutral-700">{res.name} <span className="text-neutral-400">({res.unit})</span></td>
                      <td className="py-1 w-28">
                        <NumInput value={r.unitCost} onChange={(v) => update(k, "unitCost", v)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
