import { AlertTriangle } from "lucide-react";
import { expiringRates, validityLabel, formatValidUntil } from "../lib/rateValidity.js";

/**
 * The alarm for time-limited rates (surcharges, levies, fees): lists every
 * one that has lapsed or lapses within the warning window, off the LIVE
 * rates — the library is where the next figure and date get entered, so the
 * alarm is about the library, not about any one project's pinned copy.
 */
export default function RateValidityBanner({ rates, className = "" }) {
  const due = expiringRates(rates || {});
  if (!due.length) return null;
  const expired = due.filter((d) => d.state === "expired");
  const tone = expired.length ? "bg-red-50 border-red-300 text-red-900" : "bg-amber-50 border-amber-300 text-amber-900";
  return (
    <div className={`border rounded-lg px-3 py-2 text-[12px] flex items-start gap-2 ${tone} ${className}`} role="alert">
      <AlertTriangle size={15} className="flex-none mt-0.5" />
      <div className="min-w-0">
        <b>
          {expired.length
            ? `${expired.length} supplier rate${expired.length === 1 ? " has" : "s have"} lapsed`
            : `${due.length} supplier rate${due.length === 1 ? "" : "s"} about to lapse`}
        </b>
        {" — "}update the figure and its validity date in the Rates Library (the open estimates follow it; finished ones keep their pinned rates).
        <ul className="mt-1 space-y-0.5">
          {due.map((d) => (
            <li key={d.key} className="font-mono tabular-nums text-[11px]">
              <span className="font-sans font-medium">{d.name}</span> — ${d.unitCost} / {d.unit}, valid to {formatValidUntil(d.validUntil)} ({validityLabel(d)})
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
