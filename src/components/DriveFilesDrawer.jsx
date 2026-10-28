import { useEffect, useMemo, useState } from "react";
import { X, Search, ExternalLink, Paperclip, Eye, FolderOpen, ChevronRight, Loader2, Trash2, Check } from "lucide-react";
import { driveApi, projectDriveFolder, setProjectDriveFolderPatch, driveFiles, mailFiles, isAttached, attachFilePatch, detachFilePatch, projectAddress, fileIcon, fmtBytes, fmtWhen, PREVIEWABLE } from "../lib/driveFiles.js";

/**
 * The project's Google Drive files — one drawer for two jobs:
 *   mode "attach": browse / search the office's project files folder, preview
 *                  PDFs and images in place, open the original in Drive, attach
 *                  a file to the project (a link, kept on the quote);
 *   mode "pick":   the same browser as a picker — "Use" copies the file into
 *                  the app's own store (api/drive.js "copy") and hands the copy
 *                  back (element-card markups, the AI Engine, the Vault).
 * The project's own folder is remembered on the quote (storageFolders.drive);
 * the first open offers the folder whose name fits the project.
 */
export default function DriveFilesDrawer({ quote, patchQuote, mode = "attach", accept = null, copyTarget = "markup", onPick, onClose, projectId, inline = false }) {
  // mode "browse" (the Gradcon Cloud Storage page): no project, no attach, no
  // Use — browse, search, preview and open in Drive from the office folder down.
  const folder = quote ? projectDriveFolder(quote) : null;
  const [status, setStatus] = useState(null);           // /api/drive status
  const [error, setError] = useState(null);
  const [cwd, setCwd] = useState(null);                 // {id, name}
  const [path, setPath] = useState([]);                 // [{id, name}] from the project folder down
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [wholeRoot, setWholeRoot] = useState(false);
  const [candidates, setCandidates] = useState(null);   // folder matches when the project has none
  const [preview, setPreview] = useState(null);         // {file, url, kind, loading}
  const [busyId, setBusyId] = useState(null);
  const attached = driveFiles(quote);

  const fail = (e) => setError(e && e.message ? e.message : String(e));
  const load = async (dir) => {
    setLoading(true); setError(null); setResults(null);
    try {
      const r = await driveApi({ action: "list", folderId: dir ? dir.id : undefined });
      setItems(r.files || []);
      setCwd(dir || { id: r.folderId, name: folder && folder.id === r.folderId ? folder.name : "Project files" });
    } catch (e) { fail(e); } finally { setLoading(false); }
  };
  // first open: the project's folder, else offer the matches
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await driveApi({ action: "status" });
        if (cancelled) return;
        setStatus(st);
        if (!st.connected || !st.drive) return;
        if (folder) { setPath([{ id: folder.id, name: folder.name }]); await load({ id: folder.id, name: folder.name }); return; }
        if (!quote) { setPath([{ id: st.root.id, name: st.root.name || "Project files" }]); await load({ id: st.root.id, name: st.root.name || "Project files" }); return; }
        const m = await driveApi({ action: "match", projectName: quote.projectName || "", address: projectAddress(quote) });
        if (cancelled) return;
        setCandidates(m);
        if (m.best) { patchQuote(setProjectDriveFolderPatch(quote, m.best)); setPath([{ id: m.best.id, name: m.best.name }]); await load({ id: m.best.id, name: m.best.name }); }
        else { setPath([{ id: m.rootId, name: (st.root && st.root.name) || "Project files" }]); await load({ id: m.rootId, name: (st.root && st.root.name) || "Project files" }); }
      } catch (e) { if (!cancelled) fail(e); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = (f) => { const next = [...path, { id: f.id, name: f.name }]; setPath(next); load({ id: f.id, name: f.name }); };
  const jumpTo = (i) => { const next = path.slice(0, i + 1); setPath(next); load(next[next.length - 1]); };
  const chooseFolder = (f) => { if (!quote) return; patchQuote(setProjectDriveFolderPatch(quote, f)); setCandidates(null); setPath([{ id: f.id, name: f.name }]); load({ id: f.id, name: f.name }); };
  const runSearch = async (e) => {
    if (e) e.preventDefault();
    const t = query.trim(); if (!t) { setResults(null); return; }
    setLoading(true); setError(null);
    try { const r = await driveApi({ action: "search", text: t, within: wholeRoot || !folder ? undefined : folder.id }); setResults(r.files || []); }
    catch (err) { fail(err); } finally { setLoading(false); }
  };
  const openPreview = async (f) => {
    setPreview({ file: f, url: null, loading: true });
    try { const r = await driveApi({ action: "copy", id: f.id, target: "preview" }); setPreview({ file: f, url: r.file.url, kind: r.file.kind, loading: false }); }
    catch (e) { setPreview({ file: f, url: null, loading: false, error: e.message }); }
  };
  const use = async (f) => {
    setBusyId(f.id); setError(null);
    try { const r = await driveApi({ action: "copy", id: f.id, target: copyTarget, jobId: projectId }); onPick && onPick(f, r.file); }
    catch (e) { fail(e); } finally { setBusyId(null); }
  };
  const canPick = (f) => !accept || accept.includes(f.kind);
  const list = results || items;
  const showing = useMemo(() => list.filter((f) => f.kind === "folder" || mode === "attach" || canPick(f) || true), [list, mode]);

  const Row = ({ f }) => {
    const att = quote ? isAttached(quote, f.id) : false;
    return (
      <div className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-neutral-50 ${f.kind === "folder" ? "cursor-pointer" : ""}`} data-testid="drive-row" data-kind={f.kind} onClick={f.kind === "folder" ? () => enter(f) : undefined}>
        <span className="w-6 text-center flex-none">{fileIcon(f.kind)}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[12.5px] text-neutral-900">{f.name}</span>
          <span className="block text-[10.5px] text-neutral-500">{f.kind === "folder" ? "Folder" : [fmtWhen(f.modifiedTime), fmtBytes(f.size)].filter(Boolean).join(" · ")}</span>
        </span>
        {f.kind === "folder" ? <ChevronRight size={14} className="text-neutral-400" /> : (
          <span className="flex items-center gap-1 flex-none">
            {PREVIEWABLE.has(f.kind) && <button type="button" onClick={() => openPreview(f)} className="p-1 rounded hover:bg-neutral-200 text-neutral-600" title="Preview here" aria-label={`Preview ${f.name}`}><Eye size={14} /></button>}
            <a href={f.webViewLink} target="_blank" rel="noopener" className="p-1 rounded hover:bg-neutral-200 text-neutral-600" title="Open in Google Drive" aria-label={`Open ${f.name} in Drive`}><ExternalLink size={14} /></a>
            {mode === "browse" ? null : mode === "attach" ? (
              att ? <span className="text-[11px] text-emerald-700 font-semibold flex items-center gap-0.5" data-testid="drive-attached"><Check size={12} /> Attached</span>
                : <button type="button" onClick={() => patchQuote(attachFilePatch(quote, f))} className="px-2 py-0.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-[11px] font-semibold" data-testid="drive-attach"><Paperclip size={11} className="inline mr-0.5" />Attach</button>
            ) : (
              <button type="button" disabled={!canPick(f) || busyId === f.id} onClick={() => use(f)} className="px-2 py-0.5 rounded-md bg-orange-600 hover:bg-orange-700 disabled:bg-neutral-300 text-white text-[11px] font-semibold" title={canPick(f) ? "Copy this file into the app and use it" : "Not a usable type here"} data-testid="drive-use">{busyId === f.id ? "Copying…" : "Use"}</button>
            )}
          </span>
        )}
      </div>
    );
  };

  const body = (
      <div className={inline ? "w-full bg-white rounded-xl border border-neutral-200 shadow-sm flex flex-col overflow-hidden" : "w-full max-w-xl bg-white h-full shadow-2xl flex flex-col"} style={inline ? { minHeight: "28rem", maxHeight: "40rem" } : undefined}>
        <div className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between gap-3 bg-blue-950 text-white">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-blue-300 font-semibold">Gradcon Storage · Google Drive</div>
            <div className="font-semibold truncate">{mode === "pick" ? "Pick a file" : mode === "browse" ? "The office's project files" : "Project files"}{folder ? <span className="text-blue-200 font-normal"> · {folder.name}</span> : null}{mode === "browse" && status && status.root ? <span className="text-blue-200 font-normal"> · {status.root.name}</span> : null}</div>
          </div>
          {onClose && <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-blue-900" aria-label="Close"><X size={18} /></button>}
        </div>

        {status && (!status.configured || !status.connected || !status.drive) && (
          <div className="m-3 border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 text-[12px] text-amber-900" data-testid="drive-not-ready">
            {!status.configured ? "Google is not configured on this deployment." : !status.connected ? "projects@ is not connected to Google yet — connect it in the portal's Settings → Google mail & Drive." : "The Google connection has no Drive access yet — reconnect projects@ in Settings → Google mail & Drive to grant it (read-only)."}
          </div>
        )}
        {error && <div className="m-3 border border-red-300 bg-red-50 rounded-lg px-3 py-2 text-[12px] text-red-800" data-testid="drive-error">{error}</div>}

        {mode === "attach" && attached.length > 0 && (
          <div className="px-4 pt-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-500 mb-1">Attached to this project ({attached.length})</div>
            <div className="space-y-0.5" data-testid="drive-attached-list">
              {attached.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[12px]" data-testid="drive-attached-row">
                  <span>{fileIcon(a.kind)}</span>
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  {PREVIEWABLE.has(a.kind) && <button type="button" onClick={() => openPreview({ id: a.fileId, name: a.name, kind: a.kind, webViewLink: a.webViewLink })} className="p-1 rounded hover:bg-neutral-200 text-neutral-600" title="Preview"><Eye size={13} /></button>}
                  <a href={a.webViewLink} target="_blank" rel="noopener" className="p-1 rounded hover:bg-neutral-200 text-neutral-600" title="Open in Google Drive"><ExternalLink size={13} /></a>
                  <button type="button" onClick={() => patchQuote(detachFilePatch(quote, a.id))} className="p-1 rounded hover:bg-red-100 text-neutral-400 hover:text-red-700" title="Remove from this project (the file stays in Drive)" aria-label={`Remove ${a.name}`}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "attach" && mailFiles(quote).length > 0 && (
          <div className="px-4 pt-3" data-testid="mail-files">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-500 mb-1">From the tender email ({mailFiles(quote).length})</div>
            <div className="space-y-0.5">
              {mailFiles(quote).map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[12px]" data-testid="mail-file-row">
                  <span>{fileIcon(a.kind)}</span>
                  <a href={a.url} target="_blank" rel="noopener" className="flex-1 min-w-0 truncate underline decoration-neutral-300 hover:decoration-neutral-700" title="Open the copy">{a.name}</a>
                  <span className="text-neutral-400 font-mono tabular-nums">{fmtBytes(a.size)}</span>
                  <button type="button" onClick={() => patchQuote(detachFilePatch(quote, a.id))} className="p-1 rounded hover:bg-red-100 text-neutral-400 hover:text-red-700" title="Remove from this project (the copy stays in the bucket)"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {candidates && !folder && (
          <div className="mx-3 mt-3 border border-blue-200 bg-blue-50 rounded-lg px-3 py-2 text-[12px]" data-testid="drive-candidates">
            <div className="font-semibold text-blue-950 mb-1">Which Drive folder is this project's?</div>
            {candidates.candidates.length ? candidates.candidates.map((c) => (
              <button key={c.id} type="button" onClick={() => chooseFolder(c)} className="block w-full text-left px-2 py-1 rounded hover:bg-blue-100">📁 {c.name} <span className="text-neutral-500">· {Math.round(c.score * 100)}% match</span></button>
            )) : <div className="text-neutral-600">No folder name resembles "{quote && quote.projectName}". Browse below and use "This is the project's folder" on the right one.</div>}
          </div>
        )}

        <form onSubmit={runSearch} className="px-4 pt-3 flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 border border-neutral-300 rounded-lg px-2 py-1">
            <Search size={14} className="text-neutral-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={folder && !wholeRoot ? `Search in ${folder.name}…` : "Search the project files folder…"} className="flex-1 min-w-0 text-[12.5px] outline-none" data-testid="drive-search" />
            {results && <button type="button" onClick={() => { setQuery(""); setResults(null); }} className="text-[11px] text-neutral-500 underline">clear</button>}
          </div>
          {folder && <label className="text-[11px] text-neutral-600 flex items-center gap-1"><input type="checkbox" checked={wholeRoot} onChange={(e) => setWholeRoot(e.target.checked)} /> whole folder</label>}
        </form>

        <div className="px-4 pt-2 flex items-center gap-1 text-[11px] text-neutral-600 flex-wrap" data-testid="drive-path">
          {results ? <span>Search results{folder && !wholeRoot ? ` in ${folder.name}` : ""}</span> : path.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={11} />}
              <button type="button" onClick={() => jumpTo(i)} className={`hover:underline ${i === path.length - 1 ? "font-semibold text-neutral-900" : ""}`}>{p.name}</button>
            </span>
          ))}
          {quote && cwd && !results && (!folder || folder.id !== cwd.id) && cwd.id !== (status && status.root && status.root.id) && (
            <button type="button" onClick={() => chooseFolder(cwd)} className="ml-auto text-blue-900 underline" data-testid="drive-set-folder">This is the project's folder</button>
          )}
          {cwd && !results && folder && folder.id !== cwd.id && cwd.id === (status && status.root && status.root.id) && (
            <button type="button" onClick={() => { setPath([{ id: folder.id, name: folder.name }]); load({ id: folder.id, name: folder.name }); }} className="ml-auto text-blue-900 underline">Back to {folder.name}</button>
          )}
          {folder && !results && cwd && cwd.id === folder.id && status && status.root && (
            <button type="button" onClick={() => { setPath([{ id: status.root.id, name: status.root.name }]); load({ id: status.root.id, name: status.root.name }); }} className="ml-auto text-neutral-500 underline">All project folders</button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2" data-testid="drive-list">
          {loading ? <div className="flex items-center gap-2 text-[12px] text-neutral-500 px-2 py-3"><Loader2 size={14} className="animate-spin" /> Reading Drive…</div>
            : showing.length ? showing.map((f) => <Row key={f.id} f={f} />)
            : <div className="text-[12px] text-neutral-500 px-2 py-3">{results ? "Nothing matched." : "This folder is empty."}</div>}
        </div>

        {preview && (
          <div className="border-t border-neutral-200 bg-neutral-50" data-testid="drive-preview">
            <div className="px-3 py-1.5 flex items-center justify-between text-[12px]">
              <span className="truncate">{fileIcon(preview.file.kind)} {preview.file.name}</span>
              <span className="flex items-center gap-2">
                {preview.url && <a href={preview.url} target="_blank" rel="noopener" className="underline text-blue-900">open copy</a>}
                <a href={preview.file.webViewLink} target="_blank" rel="noopener" className="underline text-blue-900">open in Drive</a>
                <button type="button" onClick={() => setPreview(null)} className="p-1 rounded hover:bg-neutral-200" aria-label="Close preview"><X size={14} /></button>
              </span>
            </div>
            <div className="h-72 bg-white border-t border-neutral-200">
              {preview.loading ? <div className="flex items-center gap-2 text-[12px] text-neutral-500 p-3"><Loader2 size={14} className="animate-spin" /> Fetching a copy to preview…</div>
                : preview.error ? <div className="text-[12px] text-red-700 p-3">{preview.error}</div>
                : preview.kind === "image" ? <img src={preview.url} alt={preview.file.name} className="max-h-full max-w-full object-contain mx-auto" />
                : <embed src={preview.url} type="application/pdf" className="w-full h-full" />}
            </div>
          </div>
        )}
        <div className="px-4 py-2 border-t border-neutral-200 text-[10.5px] text-neutral-500 flex items-center gap-1"><FolderOpen size={11} /> Read-only: nothing here changes Drive. {status && status.email ? `Connected as ${status.email}.` : ""}</div>
      </div>
  );
  if (inline) return <div data-testid="drive-browser">{body}</div>;
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-label="Google Drive files" data-testid="drive-drawer">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      {body}
    </div>
  );
}
