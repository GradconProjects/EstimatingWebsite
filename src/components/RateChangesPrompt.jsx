import { useState } from "react";
import { money } from "../lib/costing.js";
import { rateChangeImpact } from "../lib/rateChanges.js";

/**
 * The prompt an EXISTING project gets when the Rates Library has moved
 * figures it was priced with (lib/rateChanges.js; Grady, 21 Oct 2026: "it
 * should prompt for existing projects if the new rates entered should be
 * updated or applied"). The project already prices at the new figures — the
 * live rates follow the library on their own — so the choice is to accept
 * that (acknowledge) or to keep the previous figures (a pin). Nothing is
 * decided until a button is pressed; the prompt returns on every open.
 */
// A rate to the cent ($61.84, $1,925.00) — money() rounds totals to the dollar.
const rate = (v) => "$" + Number(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function RateChangesPrompt({ changes, quote, liveRates, onApply, onKeep }) {
  const [showAll, setShowAll] = useState(false);
  if (!changes || !changes.length) return null;
  const impact = rateChangeImpact(quote, liveRates, changes);
  const delta = impact.after - impact.before;
  const shown = showAll ? changes : changes.slice(0, 6);
  const when = changes.reduce((m, c) => (c.at > m ? c.at : m), "");
  return (
    <div className="border border-orange-300 bg-orange-50 rounded-lg px-3 py-2.5 text-[12px] text-neutral-900" role="alert" data-testid="rate-changes-prompt">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <div className="font-semibold text-orange-900">
            The Rates Library changed {changes.length} rate{changes.length === 1 ? "" : "s"} this project was priced with
            {when ? <span className="font-normal text-neutral-600"> (latest {new Date(when).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })})</span> : null}
          </div>
          <table className="mt-1.5 text-[11.5px]">
            <tbody>
              {shown.map((c) => (
                <tr key={c.key} data-testid="rate-change-row">
                  <td className="pr-3 py-0.5">{c.name}</td>
                  <td className="pr-1 py-0.5 font-mono tabular-nums text-neutral-500 line-through">{rate(c.from)}</td>
                  <td className="py-0.5 font-mono tabular-nums font-semibold">{rate(c.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {changes.length > 6 && (
            <button type="button" className="mt-1 text-[11px] underline text-orange-900" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `and ${changes.length - 6} more…`}
            </button>
          )}
          <div className="mt-1.5">
            Direct cost of this project: <span className="font-mono tabular-nums">{money(impact.before)}</span> at the previous figures →{" "}
            <span className="font-mono tabular-nums font-semibold">{money(impact.after)}</span> now
            <span className={`ml-1 font-mono tabular-nums ${delta > 0 ? "text-red-700" : delta < 0 ? "text-emerald-700" : "text-neutral-500"}`} data-testid="rate-change-delta">
              ({delta >= 0 ? "+" : "−"}{money(Math.abs(delta))})
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 flex-none">
          <button type="button" onClick={onApply} className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-orange-600 hover:bg-orange-700 text-white" title="Price this project at the new Rates Library figures (it already does — this records your decision)" data-testid="rate-changes-apply">
            Apply the new rates to this project
          </button>
          <button type="button" onClick={() => onKeep(changes)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-white border border-orange-300 hover:bg-orange-100 text-orange-900" title="Pin the figures this project was estimated with; the Rates Library no longer touches it until you re-price it" data-testid="rate-changes-keep">
            Keep the previous rates for this project
          </button>
        </div>
      </div>
    </div>
  );
}
