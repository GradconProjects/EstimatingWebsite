import { useMemo, useState } from "react";
import { money } from "../lib/costing.js";
import { rateChangeImpact, keptRates, rateChangeElements } from "../lib/rateChanges.js";

// A rate to the cent ($61.84, $1,925.00) — money() rounds totals to the dollar.
const rate = (v) => "$" + Number(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The prompt an EXISTING project gets when the Rates Library has moved
 * figures it was priced with (lib/rateChanges.js; Grady, 21 Oct 2026: "it
 * should prompt for existing projects if the new rates entered should be
 * updated or applied" … "the actual rates changed should have a checkbox for
 * user to select the applicable rates from the library rather than the
 * entire rates applied to that project"). Every changed rate has a tick:
 * ticked = take the library's figure, unticked = keep the figure this
 * project was estimated with. Nothing is decided until the button is
 * pressed; the prompt returns on every open until then.
 */
export default function RateChangesPrompt({ changes, quote, liveRates, onDecide }) {
  const [unticked, setUnticked] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const list = changes || [];
  const apply = useMemo(() => list.filter((c) => !unticked.has(c.key)).map((c) => c.key), [list, unticked]);
  const impact = useMemo(() => rateChangeImpact(quote, liveRates, list, apply), [quote, liveRates, list, apply]);
  const touched = useMemo(() => rateChangeElements(quote, liveRates, list), [quote, liveRates, list]);
  if (!list.length) return null;
  const signed = (v) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;
  const delta = impact.after - impact.before;
  // the rates an element actually carries come first; the rest (the library
  // moved them, nothing here is priced on them today) fold away by default
  const used = list.filter((c) => (touched[c.key] || []).length), unused = list.filter((c) => !(touched[c.key] || []).length);
  const shown = showAll ? [...used, ...unused] : used.slice(0, 8);
  const hidden = list.length - shown.length;
  const when = list.reduce((m, c) => (c.at > m ? c.at : m), "");
  const keptCount = list.length - apply.length;
  const toggle = (key) => setUnticked((u) => { const n = new Set(u); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <div className="border border-orange-300 bg-orange-50 rounded-lg px-3 py-2.5 text-[12px] text-neutral-900" role="alert" data-testid="rate-changes-prompt">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <div className="font-semibold text-orange-900">
            The Rates Library changed {list.length} rate{list.length === 1 ? "" : "s"} this project was priced with
            {when ? <span className="font-normal text-neutral-600"> (latest {new Date(when).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })})</span> : null}
          </div>
          <div className="text-[11px] text-neutral-700 mt-0.5">
            Tick the rates to apply to this project; an unticked rate stays at the figure this project was priced with.
            <button type="button" className="ml-2 underline" onClick={() => setUnticked(new Set())} data-testid="rate-changes-all">all</button>
            <button type="button" className="ml-1.5 underline" onClick={() => setUnticked(new Set(list.map((c) => c.key)))} data-testid="rate-changes-none">none</button>
          </div>
          <table className="mt-1.5 text-[11.5px]">
            <tbody>
              {shown.map((c) => (
                <tr key={c.key} data-testid="rate-change-row" data-key={c.key} data-ticked={unticked.has(c.key) ? "0" : "1"}>
                  <td className="pr-2 py-0.5"><input type="checkbox" checked={!unticked.has(c.key)} onChange={() => toggle(c.key)} aria-label={`Apply ${c.name}`} /></td>
                  <td className="pr-3 py-0.5">{c.name}</td>
                  <td className="pr-1 py-0.5 font-mono tabular-nums text-neutral-500 line-through">{rate(c.from)}</td>
                  <td className={`py-0.5 font-mono tabular-nums ${unticked.has(c.key) ? "text-neutral-400" : "font-semibold"}`}>{rate(c.to)}</td>
                  <td className="pl-3 py-0.5 text-[11px] text-neutral-700" data-testid="rate-change-elements">
                    {(touched[c.key] || []).length
                      ? <>in {(touched[c.key] || []).map((e, i) => (
                          <span key={e.id}>{i > 0 ? ", " : ""}<b className="font-semibold">{e.label}</b> <span className={`font-mono tabular-nums ${e.delta > 0 ? "text-red-700" : "text-emerald-700"}`}>({signed(e.delta)})</span></span>
                        ))}</>
                      : <span className="text-neutral-400">no element carries this rate today</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(hidden > 0 || showAll) && (
            <button type="button" className="mt-1 text-[11px] underline text-orange-900" onClick={() => setShowAll((v) => !v)} data-testid="rate-changes-more">
              {showAll ? "Show fewer" : used.length > 8 ? `and ${hidden} more…` : `and ${hidden} changed rate${hidden === 1 ? "" : "s"} no element here carries today (still applied or kept by the button)…`}
            </button>
          )}
          {used.length === 0 && !showAll && <div className="mt-1 text-[11px] text-neutral-600">None of the changed rates is used by an element of this project today — the button records the decision all the same.</div>}
          <div className="mt-1.5">
            Direct cost of this project: <span className="font-mono tabular-nums">{money(impact.before)}</span> at the previous figures →{" "}
            <span className="font-mono tabular-nums font-semibold">{money(impact.after)}</span> with the ticked rates
            <span className={`ml-1 font-mono tabular-nums ${delta > 0 ? "text-red-700" : delta < 0 ? "text-emerald-700" : "text-neutral-500"}`} data-testid="rate-change-delta">
              ({delta >= 0 ? "+" : "−"}{money(Math.abs(delta))})
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 flex-none">
          <button type="button" onClick={() => onDecide(list, apply)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-orange-600 hover:bg-orange-700 text-white" title="Apply the ticked rates to this project and keep the rest at their previous figures" data-testid="rate-changes-decide">
            {apply.length === list.length ? "Apply all the new rates" : apply.length === 0 ? "Keep all the previous rates" : `Apply ${apply.length} ticked, keep ${keptCount} previous`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The figures this project keeps at a previous value (its library pin),
 * shown while any remain — each can be released to the current library
 * figure, or all at once. Replaces the blue "Rates pinned" banner for an
 * OPEN project; a locked project shows its status pin instead.
 */
export function KeptRatesBanner({ quote, liveRates, onRelease }) {
  const kept = keptRates(quote);
  if (!kept.length) return null;
  return (
    <div className="border border-blue-200 bg-blue-50 rounded-lg px-3 py-2 text-[12px] text-blue-950" role="status" data-testid="kept-rates-banner">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <b>Previous rates kept</b> — this project prices {kept.length} rate{kept.length === 1 ? "" : "s"} at the figure{kept.length === 1 ? "" : "s"} it was estimated with; every other rate follows the Rates Library.
          <table className="mt-1 text-[11.5px]">
            <tbody>
              {kept.map((k) => {
                const live = liveRates && liveRates[k.key] ? liveRates[k.key].unitCost : undefined;
                return (
                  <tr key={k.key} data-testid="kept-rate-row">
                    <td className="pr-3 py-0.5">{k.name}</td>
                    <td className="pr-2 py-0.5 font-mono tabular-nums font-semibold">{rate(k.unitCost)}</td>
                    <td className="pr-2 py-0.5 font-mono tabular-nums text-neutral-500">{live != null && Number(live) !== Number(k.unitCost) ? `library ${rate(live)}` : ""}</td>
                    <td className="py-0.5"><button type="button" className="underline text-[11px]" onClick={() => onRelease([k.key])}>use current</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => onRelease()} className="flex-none px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-900 hover:bg-blue-800 text-white" data-testid="kept-rates-release-all">
          Use the current library figures for all
        </button>
      </div>
    </div>
  );
}
