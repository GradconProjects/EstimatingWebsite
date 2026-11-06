import { useState } from "react";
import { X, HardDriveDownload, Loader2 } from "lucide-react";
import { buildProjectBundle, downloadBytes } from "../lib/projectBundleBuild.js";
import { readTakeoffForProject } from "../lib/estimatesRead.js";
import { listVersions, signedInUser } from "../lib/quoteVersions.js";
import { markupSrc } from "../lib/markupStore.js";
import { driveApi } from "../lib/driveFiles.js";

const PARTS = [
  ["takeoff", "The Estimates takeoff with this project's name (fields and register)"],
  ["emails", "The emails in projects@ about this project (the newest 60, each in full)"],
  ["drawings", "The drawings on the element cards"],
  ["files", "The files attached to the project (tender email attachments, Google Drive attachments)"],
  ["versions", "The list of saved versions"],
];

/**
 * "Download project" (Grady, 5 Nov 2026): one zip — the reference manual
 * (README.html), the quote (.json / .xls / .csv), the takeoff, the emails, the
 * drawings and the attached files — saved to this computer. Nothing on the
 * project changes; every read is read-only.
 */
export default function DownloadProjectModal({ quote, items, rates, project, elementTypes, onClose }) {
  const [want, setWant] = useState({ takeoff: true, emails: true, drawings: true, files: true, versions: true });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const deps = {
        by: signedInUser() || undefined,
        markupSrc,
        drive: driveApi,
        listVersions,
        readTakeoff: async (name, alt) => (await readTakeoffForProject(name)) || (alt && alt !== name ? readTakeoffForProject(alt) : null),
      };
      const r = await buildProjectBundle({ quote, items, rates, project, elementTypes, want }, deps, setProgress);
      setProgress("Saving…");
      const how = await downloadBytes(r.bytes, r.name);
      setResult({ ...r, how, size: r.bytes.length });
    } catch (e) { setError(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); setProgress(""); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-auto print:hidden" data-testid="download-project-modal">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between px-5 py-3 bg-neutral-900 text-white rounded-t-xl">
          <div className="flex items-center gap-2 text-sm font-semibold"><HardDriveDownload size={16} /> Download project — reference manual</div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/10" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4 text-[13px]">
          <p className="text-neutral-600">
            One zip for <b>{quote.projectName || "this project"}</b>: a reference manual (<code>README.html</code>) with the costing, the crew sheets, the margin register, the Tender Quote, the assumptions, the checklist, the RFQs and the emails — beside the quote itself (<code>.json</code>, <code>.xls</code>, <code>.csv</code>) and the parts ticked below. Nothing on the project changes.
          </p>
          <div className="space-y-1.5">
            {PARTS.map(([k, label]) => (
              <label key={k} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={!!want[k]} disabled={busy} onChange={(e) => setWant((w) => ({ ...w, [k]: e.target.checked }))} data-testid={`download-part-${k}`} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {busy && <div className="flex items-center gap-2 text-neutral-700" data-testid="download-progress"><Loader2 size={14} className="animate-spin" /> {progress || "Working…"}</div>}
          {error && <div className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2" data-testid="download-error">{error}</div>}
          {result && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 space-y-1" data-testid="download-result">
              <div className="font-semibold text-emerald-900">{result.how === "cancelled" ? "Save cancelled — the bundle was built; press Download again to save it." : `Saved ${result.name} (${(result.size / 1024 / 1024).toFixed(1)} MB)`}</div>
              <div className="text-neutral-700">{result.report.files.length} files · {result.report.counts.emails} emails · {result.report.counts.takeoff} takeoff elements · {result.report.counts.versions} versions listed</div>
              {result.report.issues.length > 0 && (
                <ul className="list-disc pl-5 text-amber-800" data-testid="download-issues">{result.report.issues.map((s, i) => <li key={i}>{s}</li>)}</ul>
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-50">Close</button>
            <button type="button" onClick={run} disabled={busy} className="px-3 py-1.5 rounded bg-orange-600 hover:bg-orange-700 text-white font-medium disabled:opacity-50 flex items-center gap-1.5" data-testid="download-project-build">
              <HardDriveDownload size={14} /> {busy ? "Building…" : result ? "Download again" : "Build & download"}
            </button>
          </div>
          <p className="text-[11px] text-neutral-500">Saving straight into the project's Google Drive folder is not on yet — the app's Drive connection is read-only. Ask for it and it is a scope change on the projects@ connection.</p>
        </div>
      </div>
    </div>
  );
}
