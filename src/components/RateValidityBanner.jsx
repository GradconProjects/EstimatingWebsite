import { AlertTriangle } from "lucide-react";
import { expiringRates, validityLabel, formatValidUntil } from "../lib/rateValidity.js";
import { NOTICE_IDS, noticeSig, isNoticeCleared } from "../lib/notices.js";
import { supplierDocAlarms } from "../lib/rateDocs.js";
import { readLibraryState } from "../lib/ratesLibrarySync.js";
import { ClearNoticeButton } from "./atoms.jsx";

/**
 * The alarm for time-limited rates (surcharges, levies, fees): lists every
 * one that has lapsed or lapses within the warning window, off the LIVE
 * rates — the library is where the next figure and date get entered, so the
 * alarm is about the library, not about any one project's pinned copy.
 * A supplier DOCUMENT the library's rates were applied from (a steel
 * quotation valid to a date — lib/rateDocs.js) is one line of its own here,
 * never one line per rate it set.
 */
export default function RateValidityBanner({ rates, className = "", cleared, onClear }) {
  const due = expiringRates(rates || {});
  const docs = supplierDocAlarms(readLibraryState());
  if (!due.length && !docs.length) return null;
  // cleared until a date or a figure moves (lib/notices.js)
  const sig = noticeSig(due.map((d) => `${d.key}@${d.validUntil}@${d.unitCost}`), docs.map((d) => `doc:${d.id}@${d.validUntil}@${d.state}`));
  if (isNoticeCleared(cleared, NOTICE_IDS.validity, sig)) return null;
  const expired = due.filter((d) => d.state === "expired").concat(docs.filter((d) => d.state === "expired"));
  const count = due.length + docs.length;
  const tone = expired.length ? "bg-red-50 border-red-300 text-red-900" : "bg-amber-50 border-amber-300 text-amber-900";
  return (
    <div className={`border rounded-lg px-3 py-2 text-[12px] flex items-start gap-2 ${tone} ${className}`} role="alert">
      <AlertTriangle size={15} className="flex-none mt-0.5" />
      <div className="min-w-0 flex-1">
        <b>
          {expired.length
            ? `${expired.length} supplier rate${expired.length === 1 ? " has" : "s have"} lapsed`
            : `${count} supplier rate${count === 1 ? "" : "s"} about to lapse`}
        </b>
        {" — "}update the figure and its validity date in the Rates Library (the open estimates follow it; finished ones keep their pinned rates).
        <ul className="mt-1 space-y-0.5">
          {docs.map((d) => (
            <li key={d.id} className="text-[11px]" data-testid="rate-doc-alarm">
              <span className="font-medium">{d.supplier}{d.reference ? ` — ${d.reference}` : ""}</span> — {d.rows} rate{d.rows === 1 ? "" : "s"} set from this document, valid to {formatValidUntil(d.validUntil)} ({validityLabel(d)}). Upload the supplier's next rates in the Rates Library.
            </li>
          ))}
          {due.map((d) => (
            <li key={d.key} className="font-mono tabular-nums text-[11px]">
              <span className="font-sans font-medium">{d.name}</span> — ${d.unitCost} / {d.unit}, valid to {formatValidUntil(d.validUntil)} ({validityLabel(d)})
            </li>
          ))}
        </ul>
      </div>
      <ClearNoticeButton onClick={onClear ? () => onClear(NOTICE_IDS.validity, sig) : null} />
    </div>
  );
}
