import { useState, useEffect } from "react";
import { ClipboardCheck, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { TENDER_STEPS, KEY_CONTROL_POINTS, checklistProgress, stepState } from "../lib/tenderChecklist.js";
import { smsSegments, SMS_MAX_CHARS, lastNotification } from "../lib/notifyGrady.js";
import { whenLabel } from "../lib/workTrail.js";

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
export default function TenderChecklist({ quote, open, onChange, onClose, me, notify }) {
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
                {st.id === "notify" && notify && <NotifyGrady quote={quote} notify={notify} />}
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

/** Step 08 — "Text Grady" (Grady, 2 Nov 2026: "when i click inform grady from the checklist, it automatically
 * sends to him"; "lets wire in the sms first"): the summary is composed from the quote's own figures
 * (lib/notifyGrady.js), shown as an editable draft with an Approve tick, and ONE text goes to the number the
 * server holds (api/notify.js) when Send is pressed. The step is ticked and the send recorded on the quote. */
function NotifyGrady({ quote, notify }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [text, setText] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const last = lastNotification(quote, "sms");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setText(notify.draft()); setApproved(false); setResult(null); setError(null);
    notify.status().then((st) => { if (alive) setStatus(st); }).catch((e) => { if (alive) setStatus({ configured: false, missing: [], error: e.message }); });
    return () => { alive = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const segs = smsSegments(text);
  const over = text.length > SMS_MAX_CHARS;
  const canSend = !!(status && status.configured) && approved && !busy && !over && text.trim();
  const send = async () => {
    setBusy(true); setError(null);
    try { const rec = await notify.send(text.trim()); setResult(rec); setApproved(false); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-600 text-white text-[11px] font-medium hover:bg-orange-700" data-testid="tender-sms-button">
          <MessageSquare size={12} /> {open ? "Close" : "Text Grady"}
        </button>
        {last && !open && <span className="text-[11px] text-emerald-800" data-testid="tender-sms-last" title={last.text}>Texted {whenLabel(last.at)}{last.by ? ` by ${last.by}` : ""}{last.segments ? ` · ${last.segments} segment${last.segments === 1 ? "" : "s"}` : ""}</span>}
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-orange-200 bg-orange-50/50 p-2 space-y-1.5 max-w-xl" data-testid="tender-sms-panel">
          <div className="text-[11px] text-neutral-600" data-testid="tender-sms-status">
            {!status ? "Checking the SMS set-up…"
              : status.configured ? <>SMS ready · to Grady <span className="font-mono">{status.to}</span>{status.provider ? ` via ${status.provider === "clicksend" ? "ClickSend" : "Twilio"}` : ""}</>
              : <span className="text-red-700">SMS not configured{status.missing && status.missing.length ? ` — set ${status.missing.join(" and ")} in the Vercel project's Environment Variables` : status.error ? ` — ${status.error}` : ""}.</span>}
          </div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setApproved(false); }} rows={4} className="w-full bg-white border border-neutral-300 rounded px-2 py-1 text-[12px] font-mono leading-snug focus:outline-none focus:ring-2 focus:ring-orange-400" data-testid="tender-sms-text" />
          <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
            <span className={over ? "text-red-700" : "text-neutral-500"} data-testid="tender-sms-count">{text.length} characters · {segs} segment{segs === 1 ? "" : "s"}{over ? ` — over ${SMS_MAX_CHARS}, shorten it` : ""}</span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => { setText(notify.draft()); setApproved(false); }} className="px-2 py-0.5 rounded border border-neutral-300 text-neutral-600 hover:bg-white" title="Rebuild the text from the quote's current figures">Re-draft</button>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="accent-emerald-600" data-testid="tender-sms-approve" /> Approve</label>
              <button type="button" onClick={send} disabled={!canSend} className="px-2.5 py-0.5 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-40" data-testid="tender-sms-send" title={!status || !status.configured ? "Set the SMS variables first" : !approved ? "Tick Approve to send" : "Send this text to Grady now"}>{busy ? "Sending…" : "Send SMS"}</button>
            </span>
          </div>
          {error && <div className="text-[11px] text-red-700" data-testid="tender-sms-error">{error}</div>}
          {result && <div className="text-[11px] text-emerald-800" data-testid="tender-sms-sent">Sent to Grady {result.to ? <span className="font-mono">{result.to}</span> : ""}{result.segments ? ` · ${result.segments} segment${result.segments === 1 ? "" : "s"}` : ""} · recorded on this project and step 08 ticked.</div>}
          <div className="text-[10px] text-neutral-400">Nothing is sent until Approve is ticked and Send is pressed. The number lives on the server, never in this page.</div>
        </div>
      )}
    </div>
  );
}
