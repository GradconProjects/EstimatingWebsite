import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Wand2 } from "lucide-react";
import { geometryForLabel } from "../lib/estimateImport.js";

/**
 * The one place a Quotes project records the LENGTH and AREA behind each of
 * its elements — the two measures a price list can't imply, and the
 * divisors behind every element row's $/lm and $/m² benchmark rates. (The
 * third rate, $/m³, needs nothing here: it always divides by that element's
 * own poured concrete volume.)
 *
 * Cells are filled automatically when a project is published from Estimates
 * (its Project Geometry table travels with the quote), and "Fill from
 * Estimates" re-matches them at any time BY NAME — every takeoff element
 * whose name matches a card is summed into it, so one "Strip Footings" card
 * divides by the combined length of every strip footing on the takeoff.
 * That name match is also what keeps a renamed or hand-added card working.
 * Everything stays typeable: the estimator's own figure always wins.
 */
export default function ProjectGeometryPanel({ items, estimateGeometry, onChangeItem }) {
  const [open, setOpen] = useState(false);

  const totals = useMemo(
    () =>
      items.reduce(
        (a, it) => ({
          lm: a.lm + (Number(it.measureLm) || 0),
          m2: a.m2 + (Number(it.measureM2) || 0),
        }),
        { lm: 0, m2: 0 }
      ),
    [items]
  );

  // What a name-match against the published takeoff would give each card —
  // shown as the cell's placeholder, and applied in bulk by the button.
  const suggestions = useMemo(() => {
    const map = {};
    items.forEach((it) => {
      const g = geometryForLabel(it.label, estimateGeometry);
      if (g && (g.runM > 0 || g.areaM2 > 0)) map[it.id] = g;
    });
    return map;
  }, [items, estimateGeometry]);
  const suggestionCount = Object.keys(suggestions).length;

  const fillAll = () => {
    items.forEach((it) => {
      const g = suggestions[it.id];
      if (!g) return;
      const next = { ...it };
      if (g.runM > 0) next.measureLm = g.runM;
      if (g.areaM2 > 0) next.measureM2 = g.areaM2;
      onChangeItem(it.id, next);
    });
  };

  const set = (item, field, value) => onChangeItem(item.id, { ...item, [field]: value });

  if (items.length === 0) return null;

  const fmt = (n) => (n > 0 ? n.toLocaleString("en-AU", { maximumFractionDigits: 2 }) : "—");

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
      <div className="bg-blue-950 text-white px-4 py-3 flex items-center gap-3">
        <button onClick={() => setOpen(!open)} className="text-blue-300 hover:text-white transition-colors flex-none">
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px]">Project Geometry — lengths &amp; areas</div>
        </div>
        <div className="text-right flex-none">
          <div className="text-[10px] uppercase tracking-widest text-blue-300">Project total</div>
          <div className="font-mono tabular-nums text-sm font-bold text-orange-400">
            {fmt(totals.lm)} lm · {fmt(totals.m2)} m²
          </div>
        </div>
      </div>

      {open && (
        <div className="p-3 bg-neutral-50 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-neutral-500 max-w-3xl">
              The measured length and area behind each element — the divisors for its <b>$/lm</b> and <b>$/m²</b> rates
              (the <b>$/m³</b> always uses that element&apos;s own concrete volume). Filled automatically when the project
              is published from Estimates; type over any cell where the drawing measures differently.
            </p>
            {suggestionCount > 0 && (
              <button
                onClick={fillAll}
                className="flex-none flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-950 hover:bg-blue-900 text-white text-[11px] font-semibold"
                title="Match every element to the takeoff BY NAME and fill its length and area — all matching takeoff elements are summed into one card (every strip footing into the Strip Footings card, for example)."
              >
                <Wand2 size={13} /> Fill from Estimates ({suggestionCount})
              </button>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-neutral-50 text-neutral-500 text-[11px] uppercase tracking-wide">
                  <th className="text-left px-3 py-2 font-medium">Element</th>
                  <th className="text-right px-3 py-2 font-medium w-40">Total length (lm)</th>
                  <th className="text-right px-3 py-2 font-medium w-40">Total area (m²)</th>
                  <th className="text-left px-3 py-2 font-medium">From the takeoff</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const g = suggestions[item.id];
                  const cell = (field, suggested) => (
                    <input
                      type="number"
                      step="any"
                      value={item[field] ?? ""}
                      onChange={(e) => set(item, field, e.target.value)}
                      placeholder={suggested > 0 ? String(suggested) : "—"}
                      className="w-full border border-neutral-200 rounded px-2 py-1 text-right font-mono tabular-nums text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  );
                  return (
                    <tr key={item.id} className="border-t border-neutral-100">
                      <td className="px-3 py-2">
                        <div className="font-medium text-neutral-800">{item.label}</div>
                        <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                          {item.category} {item.category && item.section ? "›" : ""} {item.section}
                        </div>
                      </td>
                      <td className="px-3 py-2">{cell("measureLm", g ? g.runM : 0)}</td>
                      <td className="px-3 py-2">{cell("measureM2", g ? g.areaM2 : 0)}</td>
                      <td className="px-3 py-2 text-[11px] text-neutral-400">
                        {g ? `matched ${g.matched.join(", ")}` : "no takeoff match — enter by hand"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
