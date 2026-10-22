import { ClipboardCheck, ChevronDown, ChevronUp } from "lucide-react";
import { TENDER_STEPS, KEY_CONTROL_POINTS, checklistProgress, stepState } from "../lib/tenderChecklist.js";

/** The header button: prominent (accent-coloured, the progress on it) but one small control among the others. */
export function TenderChecklistButton({ quote, open, onToggle }) {
  const pr = checklistProgress(quote);
  const tone = pr.complete ? "bg-emerald-600 hover:bg-emerald-500" : pr.done ? "bg-orange-500 hover:bg-orange-400" : "bg-blue-900 hover:bg-blue-800";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex-none ${tone}`}
      title={`Estimator tender workflow — ${pr.done} of ${pr.total} steps done${pr.next ? `; next: ${pr.next.n} ${pr.next.title}` : ""}`}
      aria-expanded={open}
      data-testid="tender-checklist-button"
    >
      <ClipboardCheck size={16} /> Checklist <span className="font-mono tabular-nums text-[12px] opacity-90" data-testid="tender-checklist-count">{pr.done}/{pr.total}</span>
      {open ? <ChevronUp size={14} className="opacity-70" /> : <ChevronDown size={14} className="opacity-70" />}
    </button>
  );
}

/** The checklist itself — rolled up until the button opens it; every step a tick and a date, a note where the step asks who. */
export default function TenderChecklist({ quote, open, onChange, onClose, me }) {
  if (!open) return null;
  const pr = checklistProgress(quote);
  return (
    <div className="rounded-xl border border-blue-200 bg-white shadow-sm overflow-hidden" data-testid="tender-checklist">
      <div className="px-3 py-2 bg-blue-950 text-white flex items-center gap-3" data-band="category">
        <ClipboardCheck size={16} className="text-orange-300 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight">Estimator tender workflow</div>
          <div className="text-[11px] text-blue-200">From tender receipt to final filing · <span className="font-mono tabular-nums">{pr.done}/{pr.total}</span> done{pr.next ? ` · next: ${pr.next.n} ${pr.next.title}` : " · all steps done"}</div>
        </div>
        <button type="button" onClick={onClose} className="text-[11px] text-blue-200 hover:text-white px-2 py-1 rounded hover:bg-blue-900" data-testid="tender-checklist-close">Roll up</button>
      </div>
      <ol className="divide-y divide-neutral-100">
        {TENDER_STEPS.map((st) => {
          const s = stepState(quote, st.id) || {};
          const done = !!s.done;
          return (
            <li key={st.id} className={`px-3 py-2 flex items-start gap-3 ${done ? "bg-emerald-50/60" : ""}`} data-testid={`tender-step-${st.id}`} data-done={done ? "1" : "0"}>
              <span className={`flex-none w-8 h-6 rounded text-[11px] font-mono font-bold flex items-center justify-center ${done ? "bg-emerald-600 text-white" : "bg-blue-900 text-white"}`}>{st.n}</span>
              <label className="flex-none flex items-center mt-0.5 cursor-pointer" title={done ? `Done${s.at ? ` ${s.at}` : ""}${s.by ? ` by ${s.by}` : ""}` : "Tick when this step is done — today's date is recorded; change it if it was another day"}>
                <input type="checkbox" className="w-4 h-4 accent-emerald-600" checked={done} onChange={(e) => onChange(st.id, { done: e.target.checked })} data-testid={`tender-tick-${st.id}`} />
              </label>
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-semibold leading-tight ${done ? "text-emerald-900" : "text-neutral-800"}`}>{st.title}</div>
                <div className="text-[11px] text-neutral-500 leading-snug">{st.detail}</div>
                {st.note && (
                  <input
                    type="text"
                    value={s.note || ""}
                    onChange={(e) => onChange(st.id, { note: e.target.value })}
                    placeholder={st.note}
                    className="mt-1 w-full max-w-md bg-amber-50 border border-amber-200 rounded px-2 py-0.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-orange-400"
                    data-testid={`tender-note-${st.id}`}
                  />
                )}
              </div>
              <div className="flex-none flex flex-col items-end gap-0.5">
                <input
                  type="date"
                  value={s.at || ""}
                  onChange={(e) => onChange(st.id, { at: e.target.value })}
                  className={`text-[12px] font-mono tabular-nums border rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-orange-400 ${done ? "border-emerald-300 bg-white" : "border-neutral-200 bg-neutral-50 text-neutral-500"}`}
                  title={done ? "The day this step was done" : "Date (recorded on its own when the box is ticked)"}
                  data-testid={`tender-date-${st.id}`}
                />
                {done && s.by && me && s.by !== me && <span className="text-[10px] text-neutral-400">by {s.by}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="px-3 py-2 bg-neutral-50 border-t border-neutral-200 text-[11px] text-neutral-600">
        <span className="font-semibold uppercase tracking-wide text-[10px] text-neutral-500">Key control points</span>
        <ul className="list-disc pl-4 mt-0.5 space-y-0.5">{KEY_CONTROL_POINTS.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    </div>
  );
}
