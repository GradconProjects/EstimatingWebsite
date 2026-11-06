import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { NumInput } from "./atoms.jsx";
import { money2, blindingBuildUp, autoBlindingConcrete, blindingIncluded, CUSTOM_BLINDING_PREFIX, uid } from "../lib/costing.js";

/**
 * The BLINDING band on the element card (Grady, 22 Oct 2026: "lets add
 * Blinding as a separate item here and what is filled here should
 * autopopulate in the labour row"): the slab, the edge beams and the
 * internal beams, each with its own tick, figures and m³. The total is the
 * CONCRETE "Blinding concrete" row's auto quantity while nothing is typed
 * there, and the crew sheet's Blinding row Qty (lib/costing.js:
 * blindingBuildUp / autoBlindingConcrete — the ONE arithmetic). The crew
 * sheet's "Blinding added" tick still decides whether any of it is charged.
 */
export default function BlindingBand({ item, rates, open, toggle, onPart, onRemovePart, entryTone }) {
  const bu = blindingBuildUp(item);
  if (!bu.parts.length) return null; // this element type does not blind (columns, walls, suspended work, piles…)
  const auto = autoBlindingConcrete(item, rates);
  const included = blindingIncluded(item);
  const typedOnRow = !auto && bu.m3 > 0;
  return (
    <div className="rounded-lg overflow-hidden border border-neutral-200" data-testid="blinding-band" data-m3={bu.m3}>
      <button
        onClick={toggle}
        data-band="category"
        className="w-full flex items-center justify-between px-3 py-2 bg-neutral-800 text-white text-xs font-semibold tracking-wide uppercase hover:bg-neutral-700 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Blinding
          <span className="normal-case tracking-normal font-medium text-[10px] text-neutral-300">— {bu.parts.map((p) => p.label.toLowerCase()).join(", ")} → the crew sheet's Blinding row</span>
          {!included && <span className="normal-case tracking-normal font-medium text-[10px] px-1.5 py-0.5 rounded bg-neutral-600 text-neutral-200">not added (crew sheet)</span>}
        </span>
        <span className="font-mono tabular-nums normal-case font-semibold text-orange-300">
          {bu.m3 > 0 ? `${bu.m3} m³` : "—"}{auto && included ? ` · ${money2(auto.total)}` : ""}
        </span>
      </button>
      {open && (
        <div className="bg-white">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-neutral-500 bg-neutral-50">
                <th className="text-left px-3 py-1.5 font-medium w-10">Added</th>
                <th className="text-left px-3 py-1.5 font-medium">Part</th>
                <th className="text-right px-3 py-1.5 font-medium">Area / length</th>
                <th className="text-right px-3 py-1.5 font-medium">Width (mm)</th>
                <th className="text-right px-3 py-1.5 font-medium">Depth (mm)</th>
                <th className="text-right px-3 py-1.5 font-medium">m³</th>
              </tr>
            </thead>
            <tbody>
              {bu.parts.map((part) => {
                const f = part.fields || {};
                const tone = (field) => (entryTone ? entryTone(`blinding:${part.key}:${field}`) || undefined : undefined);
                const cell = (field, ph) => (
                  <NumInput step="0.01" value={f[field] ?? ""} placeholder={ph} onChange={(v) => onPart(part.key, field, v)} data-entry={tone(field)} data-testid={`blinding-${part.key}-${field}`} />
                );
                return (
                  <tr key={part.key} className={`border-t border-neutral-100 ${part.on ? "" : "opacity-60"}`} data-testid={`blinding-part-${part.key}`} data-on={part.on ? "1" : "0"} title={part.hint}>
                    <td className="px-3 py-1.5">
                      <input type="checkbox" checked={part.on} onChange={(e) => onPart(part.key, "on", e.target.checked)} className="accent-emerald-600" aria-label={`${part.label} blinding added`} />
                    </td>
                    <td className="px-3 py-1.5 text-neutral-800 font-medium">
                      {part.custom ? (
                        <span className="flex items-center gap-1.5">
                          <input value={f.name ?? ""} onChange={(e) => onPart(part.key, "name", e.target.value)} placeholder="Custom blinding — name it" className="w-40 border border-neutral-300 rounded px-1.5 py-0.5 text-[12px] font-medium" data-testid={`blinding-${part.key}-name`} aria-label="Custom blinding name" />
                          <select value={part.kind} onChange={(e) => onPart(part.key, "kind", e.target.value)} className="border border-neutral-300 rounded px-1 py-0.5 text-[11px]" data-testid={`blinding-${part.key}-kind`} aria-label="How this blinding is measured">
                            <option value="area">area × depth</option>
                            <option value="run">run × width × depth</option>
                          </select>
                          {onRemovePart && <button type="button" onClick={() => onRemovePart(part.key)} className="p-0.5 rounded text-neutral-400 hover:text-red-700 hover:bg-red-50" title="Remove this blinding row" aria-label="Remove this blinding row" data-testid={`blinding-${part.key}-remove`}><X size={13} /></button>}
                        </span>
                      ) : part.label}
                      <span className="block text-[10.5px] text-neutral-400 font-normal">{part.custom ? "typed by hand — " : ""}{part.kind === "area" ? "plan area × depth" : "total run × width × depth"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">{part.kind === "area" ? cell("areaM2", "m²") : cell("lengthM", "m")}</td>
                    <td className="px-3 py-1.5 text-right">{part.kind === "area" ? <span className="text-neutral-300">—</span> : cell("widthMm", "mm")}</td>
                    <td className="px-3 py-1.5 text-right">{cell("tMm", "mm")}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold" data-testid={`blinding-${part.key}-m3`}>{part.m3 > 0 ? `${part.m3} m³` : <span className="text-neutral-300">—</span>}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-neutral-100">
                <td colSpan={6} className="px-3 py-1">
                  <button type="button" onClick={() => onPart(`${CUSTOM_BLINDING_PREFIX}${uid()}`, "kind", "area")} className="inline-flex items-center gap-1 text-[11px] font-semibold text-neutral-700 hover:text-neutral-900 border border-dashed border-neutral-300 rounded px-2 py-0.5" data-testid="blinding-add-custom" title="Another blinding row typed by hand — a name, an area or a run, the depth — counted with the parts above">
                    <Plus size={12} /> Add a blinding row
                  </button>
                </td>
              </tr>
              <tr className="border-t border-neutral-200 bg-neutral-50">
                <td colSpan={5} className="px-3 py-1.5 text-[11px] text-neutral-600">
                  Total blinding — priced here and filled into the crew sheet's <b>Blinding concrete</b> row
                  {typedOnRow ? <span className="text-amber-800"> (a figure is typed on that CONCRETE row, so the row keeps the typed figure)</span> : auto ? <span> at {money2(auto.unitCost)}/m³ = <b>{money2(auto.total)}</b></span> : null}
                  {!included && <span className="text-neutral-500"> — not charged while "Add blinding" is unticked on the crew sheet</span>}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums font-bold" data-testid="blinding-buildup-total">{bu.m3} m³</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
