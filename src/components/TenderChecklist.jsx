import { serverDownReason } from "../lib/serverStatus.js";
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

/** Step 08 — "Notify Grady" (Grady, 2 Nov 2026: "can i include an email and sms notification of summary of completed
 * projects to grady? so when i click inform grady from the checklist, it automatically sends to him"; "lets do both at
 * once"): the email and the text are composed from the quote's own figures (lib/notifyGrady.js), each shown as an
 * editable draft with its own Approve tick; Send sends what is approved — the email through the projects@ Google
 * connection (api/gmail.js), the text to the number the server holds (api/notify.js). Every send is recorded on the
 * quote and step 08 is ticked. Nothing goes without the tick and the press. */
function NotifyGrady({ quote, notify }) {
  const [open, setOpen] = useState(false);
  const [sms, setSms] = useState(null);
  const [mail, setMail] = useState(null);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [okSms, setOkSms] = useState(false);
  const [okMail, setOkMail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const lastSms = lastNotification(quote, "sms");
  const lastMail = lastNotification(quote, "email");
  const redraft = () => { setText(notify.draft()); const e = notify.emailDraft(); setSubject(e.subject); setBody(e.text); setOkSms(false); setOkMail(false); };
  useEffect(() => {
    if (!open) return;
    let alive = true;
    redraft(); setResult(null); setError(null);
    notify.status().then((st) => { if (alive) setSms(st); }).catch((e) => { if (alive) setSms({ configured: false, missing: [], error: e.message }); });
    notify.mailStatus().then((st) => { if (alive) setMail(st); }).catch(() => { if (alive) setMail({ configured: false, connected: false, send: false, unreachable: true, reason: serverDownReason(0) }); });
    return () => { alive = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const segs = smsSegments(text);
  const over = text.length > SMS_MAX_CHARS;
  const smsReady = !!(sms && sms.configured);
  const mailReady = !!(mail && mail.configured && mail.connected && mail.send);
  const canSms = smsReady && okSms && !over && !!text.trim();
  const canMail = mailReady && okMail && !!subject.trim() && !!body.trim();
  const send = async (which) => {
    setBusy(true); setError(null); setResult(null);
    const done = [];
    try {
      if ((which === "email" || which === "both") && canMail) { const rec = await notify.sendEmail({ subject: subject.trim(), text: body }); done.push(rec); setOkMail(false); }
      if ((which === "sms" || which === "both") && canSms) { const rec = await notify.send(text.trim()); done.push(rec); setOkSms(false); }
      setResult(done);
    } catch (e) { setError(e.message || String(e)); if (done.length) setResult(done); }
    finally { setBusy(false); }
  };
  const lastLine = [lastMail && `Emailed ${whenLabel(lastMail.at)}${lastMail.by ? ` by ${lastMail.by}` : ""}`, lastSms && `Texted ${whenLabel(lastSms.at)}${lastSms.by ? ` by ${lastSms.by}` : ""}${lastSms.segments ? ` · ${lastSms.segments} segment${lastSms.segments === 1 ? "" : "s"}` : ""}`].filter(Boolean).join(" · ");
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-600 text-white text-[11px] font-medium hover:bg-orange-700" data-testid="tender-sms-button">
          <MessageSquare size={12} /> {open ? "Close" : "Notify Grady — email & SMS"}
        </button>
        {lastLine && !open && <span className="text-[11px] text-emerald-800" data-testid="tender-sms-last" title={(lastMail && lastMail.text) || (lastSms && lastSms.text) || ""}>{lastLine}</span>}
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-orange-200 bg-orange-50/50 p-2 space-y-2 max-w-2xl" data-testid="tender-sms-panel">
          {/* EMAIL */}
          <div className="rounded border border-neutral-200 bg-white p-2 space-y-1" data-testid="tender-email-block">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Email to Grady</span>
              <span className="text-[11px] text-neutral-600" data-testid="tender-email-status">
                {!mail ? "Checking the mailbox…"
                  : mailReady ? <>Mail ready · from <span className="font-mono">{mail.email || "projects@gradcon.com.au"}</span> to <span className="font-mono">grady@gradcon.com.au</span></>
                  : <span className="text-red-700" data-testid="tender-email-problem">{mail.reason ? mail.reason : !mail.configured ? "Google mail is not configured on the server." : !mail.connected ? "projects@ is not connected — connect it under Settings → Google mail & Drive." : "The Google connection cannot send yet — reconnect it for sending under Settings → Google mail & Drive."}</span>}
              </span>
            </div>
            <input type="text" value={subject} onChange={(e) => { setSubject(e.target.value); setOkMail(false); }} className="w-full bg-white border border-neutral-300 rounded px-2 py-1 text-[12px] focus:outline-none focus:ring-2 focus:ring-orange-400" data-testid="tender-email-subject" placeholder="Subject" />
            <textarea value={body} onChange={(e) => { setBody(e.target.value); setOkMail(false); }} rows={10} className="w-full bg-white border border-neutral-300 rounded px-2 py-1 text-[12px] font-mono leading-snug focus:outline-none focus:ring-2 focus:ring-orange-400" data-testid="tender-email-text" />
            <div className="flex items-center justify-end gap-2 text-[11px]">
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={okMail} onChange={(e) => setOkMail(e.target.checked)} className="accent-emerald-600" data-testid="tender-email-approve" /> Approve email</label>
              <button type="button" onClick={() => send("email")} disabled={busy || !canMail} className="px-2.5 py-0.5 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-40" data-testid="tender-email-send" title={!mailReady ? "Connect projects@ for sending first" : !okMail ? "Tick Approve email to send" : "Send this email to Grady now"}>{busy ? "Sending…" : "Send email"}</button>
            </div>
          </div>
          {/* SMS */}
          <div className="rounded border border-neutral-200 bg-white p-2 space-y-1" data-testid="tender-sms-block">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Text message to Grady</span>
              <span className="text-[11px] text-neutral-600" data-testid="tender-sms-status">
                {!sms ? "Checking the SMS set-up…"
                  : smsReady ? <>SMS ready · to Grady <span className="font-mono">{sms.to}</span>{sms.provider ? ` via ${sms.provider === "clicksend" ? "ClickSend" : "Twilio"}` : ""}{sms.warning ? <span className="text-amber-700" data-testid="tender-sms-warning"> · {sms.warning}</span> : null}</>
                  : <span className="text-red-700" data-testid="tender-sms-problem">{sms.error && !(sms.missing && sms.missing.length) ? sms.error : <>SMS not configured{sms.missing && sms.missing.length ? ` — set ${sms.missing.join(" and ")} in the Vercel project's Environment Variables` : ""}.</>}</span>}
              </span>
            </div>
            <textarea value={text} onChange={(e) => { setText(e.target.value); setOkSms(false); }} rows={4} className="w-full bg-white border border-neutral-300 rounded px-2 py-1 text-[12px] font-mono leading-snug focus:outline-none focus:ring-2 focus:ring-orange-400" data-testid="tender-sms-text" />
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className={over ? "text-red-700" : "text-neutral-500"} data-testid="tender-sms-count">{text.length} characters · {segs} segment{segs === 1 ? "" : "s"}{over ? ` — over ${SMS_MAX_CHARS}, shorten it` : ""}</span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={okSms} onChange={(e) => setOkSms(e.target.checked)} className="accent-emerald-600" data-testid="tender-sms-approve" /> Approve SMS</label>
                <button type="button" onClick={() => send("sms")} disabled={busy || !canSms} className="px-2.5 py-0.5 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-40" data-testid="tender-sms-send" title={!smsReady ? "Set the SMS variables first" : !okSms ? "Tick Approve SMS to send" : "Send this text to Grady now"}>{busy ? "Sending…" : "Send SMS"}</button>
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
            <button type="button" onClick={redraft} className="px-2 py-0.5 rounded border border-neutral-300 text-neutral-600 hover:bg-white" title="Rebuild both drafts from the quote's current figures" data-testid="tender-notify-redraft">Re-draft both</button>
            <button type="button" onClick={() => send("both")} disabled={busy || !(canMail && canSms)} className="px-3 py-1 rounded bg-orange-600 text-white font-semibold hover:bg-orange-700 disabled:opacity-40" data-testid="tender-notify-both" title={canMail && canSms ? "Send the approved email and text together" : "Approve both the email and the SMS to send them together"}>{busy ? "Sending…" : "Send both"}</button>
          </div>
          {error && <div className="text-[11px] text-red-700" data-testid="tender-sms-error">{error}</div>}
          {result && result.length > 0 && (
            <div className="text-[11px] text-emerald-800" data-testid="tender-sms-sent">
              {result.map((r) => r.kind === "email" ? `Emailed Grady at ${r.to}` : `Texted Grady ${r.to || ""}${r.segments ? ` · ${r.segments} segment${r.segments === 1 ? "" : "s"}` : ""}`).join(" · ")} · recorded on this project and step 08 ticked.
            </div>
          )}
          <div className="text-[10px] text-neutral-400">Nothing is sent until its Approve box is ticked and Send is pressed. The email goes from projects@ to grady@gradcon.com.au; the mobile number lives on the server, never in this page.</div>
        </div>
      )}
    </div>
  );
}
