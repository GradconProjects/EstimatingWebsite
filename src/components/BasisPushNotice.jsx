import { useState } from "react";
import { Check, AlertTriangle, X, ListChecks } from "lucide-react";
import { basisResultText } from "../lib/estimateBasis.js";

/**
 * The stages of a "Compile assumptions" push from Estimates
 * (lib/estimateBasis.js): `choose` — no single project fits the takeoff's
 * name, so the project is picked; `where` — the project has packages, so the
 * estimator is ALWAYS asked which package's Assumptions take the lines (or
 * the project-wide list); `done` — what landed and where; `error`.
 * Presentation only: App.jsx finds the project, ProjectEditor does the write.
 */
export default function BasisPushNotice({ push, onChoose, onWhere, onDiscard, onDismiss, onRetry }) {
  const [pick, setPick] = useState("");
  const [dest, setDest] = useState(null);
  if (!push) return null;
  const n = (push.payload && push.payload.lines ? push.payload.lines.length : 0);
  const from = (push.payload && push.payload.projectName) || "the open takeoff";
  const shell = "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(46rem,94vw)] rounded-xl shadow-xl border px-4 py-3 text-sm print:hidden";

  if (push.stage === "done") {
    const where = push.where && push.where.packageId
      ? <>the package <b>{push.where.name}</b> — its Assumptions list (“Assumptions — {push.where.name}”, under the package's geometry) is open below</>
      : push.packaged
        ? <>the <b>project-wide</b> assumptions — the “Project geometry — whole project” panel under the packages is open below</>
        : <>the Assumptions list under Project Geometry, open below</>;
    return (
      <div className={`${shell} bg-emerald-50 border-emerald-300 text-emerald-900`} role="status" data-testid="basis-push-note">
        <div className="flex items-start gap-3">
          <Check size={18} className="flex-none mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">Assumptions from Estimates are on {push.projectName || "this project"}</div>
            <div className="text-[13px]" data-testid="basis-push-result">
              {push.total} line{push.total === 1 ? "" : "s"} from the takeoff — {basisResultText(push.result)}. They went to {where}, each marked “from Estimates”, and print in the Tender Notes. Nothing that was already there was removed.
            </div>
          </div>
          <button type="button" onClick={onDismiss} className="flex-none p-1 rounded hover:bg-emerald-100" aria-label="Dismiss" data-testid="basis-push-dismiss"><X size={15} /></button>
        </div>
      </div>
    );
  }

  if (push.stage === "error") {
    return (
      <div className={`${shell} bg-red-50 border-red-300 text-red-900`} role="alert" data-testid="basis-push-error">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="flex-none mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">The assumptions from Estimates were not added</div>
            <div className="text-[13px]">{push.message} Nothing was changed.</div>
          </div>
          <button type="button" onClick={onRetry} className="flex-none px-2.5 py-1 rounded border border-red-300 bg-white hover:bg-red-100 text-xs font-medium">Try again</button>
          <button type="button" onClick={onDiscard} className="flex-none px-2.5 py-1 rounded border border-red-300 bg-white hover:bg-red-100 text-xs font-medium">Discard</button>
        </div>
      </div>
    );
  }

  if (push.stage === "where") {
    // a project with packages: which Assumptions list takes the lines — asked on every push
    const options = push.destinations || [];
    const value = dest !== null ? dest : (push.suggested !== null && push.suggested !== undefined ? push.suggested : null);
    return (
      <div className={`${shell} bg-white border-amber-300 text-neutral-900`} role="dialog" aria-label="Choose where the assumptions from Estimates go" data-testid="basis-push-where">
        <div className="flex items-start gap-3">
          <ListChecks size={18} className="flex-none mt-0.5 text-amber-700" />
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <div className="font-semibold">Which package takes the assumptions from Estimates?</div>
              <div className="text-[13px] text-neutral-600">
                {n} line{n === 1 ? "" : "s"} compiled from the takeoff “{from}” for <b>{push.projectName || "this project"}</b>. Nothing is added until you pick one, and nothing already there is removed.
              </div>
            </div>
            <div className="space-y-1" role="radiogroup" aria-label="Destination">
              {options.map((o) => (
                <label key={o.id || "__project"} className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer ${value === o.id ? "border-orange-400 bg-orange-50" : "border-neutral-200 hover:bg-neutral-50"}`} data-testid="basis-push-dest" data-dest={o.id || "project"} data-on={value === o.id ? "1" : "0"}>
                  <input type="radio" name="basis-dest" checked={value === o.id} onChange={() => setDest(o.id)} />
                  <span className="flex-1 min-w-0">
                    {o.kind === "package" ? <><span className="text-neutral-500">Package · </span><b>{o.name}</b></> : o.name}
                    {push.suggested === o.id ? <span className="ml-2 text-[11px] text-neutral-500">(the last push from this takeoff went here)</span> : null}
                  </span>
                  <span className="flex-none text-[11px] text-neutral-500">{o.count} there now</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={value === null} onClick={() => onWhere(value)} className="px-3 py-1.5 rounded bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-semibold" data-testid="basis-push-apply">Add {n} line{n === 1 ? "" : "s"} here</button>
              <button type="button" onClick={onDiscard} className="px-3 py-1.5 rounded border border-neutral-300 hover:bg-neutral-50 text-sm" data-testid="basis-push-discard">Discard</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (push.stage !== "choose") return null;
  // choose — no project (or more than one) fits the takeoff's name
  const options = push.options || [];
  const suggested = (push.candidates || []).map((c) => c.id);
  const value = pick || suggested[0] || "";
  return (
    <div className={`${shell} bg-white border-amber-300 text-neutral-900`} role="dialog" aria-label="Choose the project for the assumptions from Estimates" data-testid="basis-push-choose">
      <div className="flex items-start gap-3">
        <ListChecks size={18} className="flex-none mt-0.5 text-amber-700" />
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <div className="font-semibold">Which project takes the assumptions from Estimates?</div>
            <div className="text-[13px] text-neutral-600">
              {n} line{n === 1 ? "" : "s"} compiled from the takeoff “{from}”. {suggested.length > 1 ? "More than one project fits that name." : "No project here has that name."} Nothing is added until you pick one{" "}— a project with packages then asks which package.
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={value} onChange={(e) => setPick(e.target.value)} className="flex-1 min-w-[14rem] border border-neutral-300 rounded px-2 py-1.5 text-sm bg-white" data-testid="basis-push-select" aria-label="Project">
              <option value="">Choose a project…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name || "Untitled project"}{suggested.includes(o.id) ? "  (similar name)" : ""}</option>)}
            </select>
            <button type="button" disabled={!value} onClick={() => onChoose(value)} className="px-3 py-1.5 rounded bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-semibold" data-testid="basis-push-add">Open this project</button>
            <button type="button" onClick={onDiscard} className="px-3 py-1.5 rounded border border-neutral-300 hover:bg-neutral-50 text-sm" data-testid="basis-push-discard">Discard</button>
          </div>
        </div>
      </div>
    </div>
  );
}
