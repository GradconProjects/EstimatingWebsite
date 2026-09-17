import { Loader2, Check, AlertTriangle } from "lucide-react";

const STATUS_MAP = {
  loading: { icon: Loader2, text: "Loading…", cls: "text-neutral-400", spin: true },
  saving: { icon: Loader2, text: "Saving…", cls: "text-amber-600", spin: true },
  saved: { icon: Check, text: "Saved", cls: "text-emerald-600", spin: false },
  error: { icon: AlertTriangle, text: "Not saved to the cloud — retrying…", cls: "text-red-600", spin: false },
  unavailable: { icon: AlertTriangle, text: "No local storage — changes won't survive a refresh", cls: "text-amber-600", spin: false },
};

export function SaveBadge({ status }) {
  const m = STATUS_MAP[status] || STATUS_MAP.saved;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${m.cls}`}>
      <Icon size={13} className={m.spin ? "animate-spin" : ""} />
      {m.text}
    </span>
  );
}

export function NumInput({ value, onChange, placeholder = "—", className = "", step = "0.01" }) {
  return (
    <input
      type="number"
      step={step}
      value={value === undefined || value === null || value === "" ? "" : value}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      placeholder={placeholder}
      className={`w-full bg-amber-50 border border-amber-200 rounded px-2 py-1 text-right font-mono text-[13px] tabular-nums
                  focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400 ${className}`}
    />
  );
}

/** Shown by the summary pages when some project rows could not be read from
 * the cloud. Nothing is changed by a failed load: the last-known copy stays
 * on screen where one exists, and Retry re-reads only what is stale. */
export function SummaryLoadNotice({ failedCount, onRetry }) {
  if (!failedCount) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-sm px-3 py-2 flex items-center gap-3 flex-wrap" role="alert" data-summary-load-notice>
      <AlertTriangle size={14} className="shrink-0" />
      <span>
        {failedCount === 1 ? "1 project" : `${failedCount} projects`} could not be loaded from the cloud — showing the last saved copy where one exists. Nothing has been changed.
      </span>
      <button type="button" onClick={onRetry} className="ml-auto px-2.5 py-1 rounded border border-amber-400 bg-white hover:bg-amber-100 text-xs font-medium">
        Retry
      </button>
    </div>
  );
}
