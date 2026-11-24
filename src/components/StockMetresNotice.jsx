import { useMemo } from "react";
import { unconfirmedStockRows, money2 } from "../lib/costing.js";
import { NOTICE_IDS, noticeSig, isNoticeCleared } from "../lib/notices.js";
import { ClearNoticeButton } from "./atoms.jsx";

/**
 * "Trench mesh is now priced by the metre" (24 Nov 2026 — Boma: "rates are for single bar lengths and was quoted as
 * lm … apply to all the projects with trench mesh"). Every trench mesh row a project saved before that day was priced
 * as a COUNT of 6 m lengths; it is now read as lineal metres and buys whole lengths. This band lists those rows — the
 * figure, what it was priced at and what it is now — so a row that really was a count of lengths can be put right
 * (× 6, on the row or here) and the rest confirmed in one click. `unconfirmedStockRows` (costing.js) is the ONE list.
 */
export default function StockMetresNotice({ items, rates, cleared, onClear, onAnswer, onJump }) {
  const rows = useMemo(() => unconfirmedStockRows(items, rates), [items, rates]);
  if (!rows.length) return null;
  const sig = noticeSig(...rows.map((r) => `${r.itemId}|${r.key}|${r.qty}`));
  if (isNoticeCleared(cleared, NOTICE_IDS.stockMetres, sig)) return null;
  const before = rows.reduce((s, r) => s + r.before, 0), now = rows.reduce((s, r) => s + r.now, 0);
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 text-[12px] text-amber-950" role="status" data-testid="stock-metres-notice">
      <div className="flex items-start justify-between gap-3">
        <div>
          <b>Trench mesh is now priced by the metre.</b> The price is per 6 m length, so {rows.length === 1 ? "the figure below is" : `the ${rows.length} figures below are`} now read as lineal metres and bought in whole lengths:
          {" "}<span className="font-mono tabular-nums">{money2(before)}</span> → <b className="font-mono tabular-nums" data-testid="stock-metres-now">{money2(now)}</b> ({money2(now - before)}).
          {" "}If a figure was typed as a <i>count of lengths</i>, say so on its row.
        </div>
        <ClearNoticeButton onClick={onClear ? () => onClear(NOTICE_IDS.stockMetres, sig) : undefined} />
      </div>
      <table className="mt-1.5 w-full text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId + r.key} className="border-t border-amber-200/70" data-testid="stock-metres-row">
              <td className="py-0.5 pr-2">
                <button type="button" className="underline decoration-dotted hover:text-black text-left" onClick={() => onJump && onJump(r.itemId)}>{r.element || "Element"}</button>
              </td>
              <td className="py-0.5 pr-2 whitespace-nowrap">{r.name}</td>
              <td className="py-0.5 pr-2 text-right font-mono tabular-nums whitespace-nowrap">{r.qty} m = {r.lengths} length{r.lengths === 1 ? "" : "s"}</td>
              <td className="py-0.5 pr-2 text-right font-mono tabular-nums whitespace-nowrap">{money2(r.before)} → <b>{money2(r.now)}</b></td>
              <td className="py-0.5 text-right whitespace-nowrap">
                <button type="button" className="underline hover:text-black" data-testid="stock-metres-as-lengths" onClick={() => onAnswer([r], "lengths")} title={`${r.qty} was a count of lengths: make it ${Math.round(r.qty * r.stockM * 100) / 100} m, priced ${money2(r.before)} as before`}>it was {r.qty} lengths</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5">
        <button type="button" className="px-2 py-0.5 rounded border border-amber-400 bg-white hover:bg-amber-100 font-semibold" data-testid="stock-metres-confirm" onClick={() => onAnswer(rows, "m")}>✓ {rows.length === 1 ? "Metres is right" : `All ${rows.length} are metres`}</button>
      </div>
    </div>
  );
}
