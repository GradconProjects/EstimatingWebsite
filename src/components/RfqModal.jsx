import { useEffect, useMemo, useState } from "react";
import { X, Send, Check, ChevronLeft, Paperclip, Loader2, AlertTriangle, Mail } from "lucide-react";
import { RFQ_PACKAGES, packageByKey, packageLabel, suggestPackages, contractorsFor, rfqContact, rfqDrafts, rfqText, rfqSubject, elementScope, dayPlus, rfqRecord, attachmentOptions, driveFolderOptions, missingAttachClasses } from "../lib/rfq.js";
import { readRegister, registerOrgs } from "../lib/registerStore.js";
import { readTakeoffForProject } from "../lib/estimatesRead.js";
import { driveApi } from "../lib/driveFiles.js";
import { markupSrc } from "../lib/markupStore.js";

import { classifyFile } from "../lib/rfq.js";
const classifyTags = (name, pkgKey) => classifyFile(name, "", pkgKey);
const apiBase = () => (typeof window !== "undefined" && window.location ? window.location.origin : "");
const SENDER_KEY = "gradcon-rfq-sender";
// The signature every RFQ carries unless retyped (Grady, 23 Oct 2026: "default should be: Boma Ipalibo /
// Gradcon Concrete Constructions / projects@gradcon.com.au"); a retyped name is remembered per browser.
export const DEFAULT_SIGNATORY = { name: "Boma Ipalibo", email: "projects@gradcon.com.au", phone: "" };
const defaultSender = () => {
  try { const s = JSON.parse(localStorage.getItem(SENDER_KEY) || "null"); if (s && s.name) return { ...DEFAULT_SIGNATORY, ...s }; } catch { /* ignore */ }
  return { ...DEFAULT_SIGNATORY };
};

/**
 * Request for quotation: pick the elements and the package, pick the contractors
 * the Register knows for it, read every draft (one per contractor, that
 * contractor's own name and address), approve the ones to send, send them one
 * by one through the connected mailbox. Nothing leaves without an approval tick.
 */
export default function RfqModal({ quote, items, rates, projectScope, elementTypes = [], initialItemIds = null, user = "", onClose, onSent }) {
  const [step, setStep] = useState("setup");
  const [register, setRegister] = useState(null);
  const [takeoff, setTakeoff] = useState(null);
  const [mail, setMail] = useState(null); // /api/google-auth status
  const [selected, setSelected] = useState(() => new Set(initialItemIds || items.map((i) => i.id)));
  const [pkgKeys, setPkgKeys] = useState(() => new Set()); // several packages at once; each with its own contractors
  const [pkgCustom, setPkgCustom] = useState("");
  const [picks, setPicks] = useState(() => ({})); // pkgKey → Set of orgIds
  const [showNot, setShowNot] = useState("");
  const [due, setDue] = useState(() => dayPlus(7));
  const [sender, setSender] = useState(() => defaultSender());
  const [extraNotes, setExtraNotes] = useState("");
  const [attach, setAttach] = useState(() => new Set());
  const [drafts, setDrafts] = useState([]);
  const [current, setCurrent] = useState(0);
  const [building, setBuilding] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [resolvedFiles, setResolvedFiles] = useState([]);
  const [driveFolder, setDriveFolder] = useState(null); // {id, name, files:[...], note}
  const [autoDone, setAutoDone] = useState(false);

  const typeName = (item) => { const t = elementTypes.find((x) => x.id === item.typeId); return t ? t.name : ""; };
  const chosenItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const suggested = useMemo(() => suggestPackages(chosenItems, typeName), [chosenItems]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pkgKeys.size && suggested.length) setPkgKeys(new Set([suggested[0]])); }, [suggested, pkgKeys.size]);
  const pkgs = useMemo(() => RFQ_PACKAGES.filter((p) => pkgKeys.has(p.key)), [pkgKeys]);
  const pkgKeyList = useMemo(() => pkgs.map((p) => p.key), [pkgs]);
  const labelOf = (p) => packageLabel(p.key, pkgCustom);
  const pkgLabelNow = pkgs.map(labelOf).join(", ") || "—";
  const orgs = registerOrgs(register);
  const groupsFor = useMemo(() => Object.fromEntries(pkgs.map((p) => [p.key, contractorsFor(orgs, p)])), [orgs, pkgs]);
  const picked = (key) => picks[key] || new Set();
  const togglePick = (key, id) => setPicks((cur) => { const n = new Set(cur[key] || []); n.has(id) ? n.delete(id) : n.add(id); return { ...cur, [key]: n }; });
  const [searches, setSearches] = useState({});
  const hitsFor = (key) => { const q = String(searches[key] || "").trim().toLowerCase(); if (!q) return []; return orgs.filter((o) => !picked(key).has(o.id) && [o.name, o.trade, ...(o.emails || [])].join(" ").toLowerCase().includes(q)).slice(0, 8); };
  const totalPicks = pkgs.reduce((n, p) => n + picked(p.key).size, 0);
  const options = useMemo(() => {
    const base = attachmentOptions(quote, chosenItems, (m) => markupSrc(m));
    const seen = new Set(base.map((o) => o.fileId).filter(Boolean));
    const folder = driveFolderOptions((driveFolder && driveFolder.files) || [], pkgKeyList).filter((o) => !seen.has(o.fileId));
    // the project's already-attached Drive files are tagged the same way
    return [...base.map((o) => (o.kind === "drive" ? { ...o, tags: classifyTags(o.name, pkgKeyList), auto: classifyTags(o.name, pkgKeyList).length > 0 } : o)), ...folder];
  }, [quote, chosenItems, driveFolder, pkgKeyList]);
  // the relevant files are ticked on their own once the folder has been read (and again when the package changes)
  useEffect(() => { if (!driveFolder || autoDone) return; setAttach(new Set(options.filter((o) => o.auto || o.kind === "markup").map((o) => o.id))); setAutoDone(true); }, [driveFolder, options, autoDone]);
  useEffect(() => { setAutoDone(false); }, [pkgKeyList.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = useMemo(() => missingAttachClasses(options, attach), [options, attach]);

  useEffect(() => {
    let alive = true;
    readRegister().then((r) => { if (alive) setRegister(r); });
    readTakeoffForProject(quote.projectName).then((t) => { if (alive) setTakeoff(t); }).catch(() => {});
    fetch(`${apiBase()}/api/google-auth?action=status`, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setMail(d || { configured: false }); }).catch(() => { if (alive) setMail({ configured: false }); });
    // the project's Drive folder: its files, one level of subfolders, and a keyword search beneath — tagged for auto-attach
    (async () => {
      try {
        let folder = quote.storageFolders && quote.storageFolders.drive ? { id: quote.storageFolders.drive.id, name: quote.storageFolders.drive.name } : null;
        if (!folder) { const m = await driveApi({ action: "match", projectName: quote.projectName || "", address: quote.siteAddress || "" }); if (m && m.best) folder = { id: m.best.id, name: m.best.name }; }
        if (!folder) { if (alive) setDriveFolder({ id: null, name: "", files: [], note: "No Drive folder is linked to this project yet (Files → This is the project's folder) — nothing could be attached on its own." }); return; }
        const byId = new Map();
        const add = (f, folderName) => { if (f && f.id && !byId.has(f.id)) byId.set(f.id, { ...f, folderName }); };
        const top = await driveApi({ action: "list", folderId: folder.id, max: 200 });
        for (const f of top.files || []) add(f, "");
        const subs = (top.files || []).filter((f) => f.kind === "folder").slice(0, 8);
        for (const sf of subs) { try { const r = await driveApi({ action: "list", folderId: sf.id, max: 200 }); for (const f of r.files || []) add(f, sf.name); } catch { /* one subfolder failing never hides the rest */ } }
        for (const word of ["architectural", "structural", "geotech", "soil"]) { try { const r = await driveApi({ action: "search", text: word, within: folder.id, max: 40 }); for (const f of r.files || []) add(f, ""); } catch { /* ignore */ } }
        if (alive) setDriveFolder({ id: folder.id, name: folder.name, files: [...byId.values()], note: "" });
      } catch (e) { if (alive) setDriveFolder({ id: null, name: "", files: [], note: e.needsReconnect ? "The Google connection has no Drive access yet (Settings → Google mail & Drive → Reconnect) — attach files by hand." : "The project's Drive folder could not be read" + (e.message ? ": " + e.message : "") + "." }); }
    })();
    return () => { alive = false; };
  }, [quote.projectName, quote.siteAddress, quote.storageFolders]);

  const toggle = (set, id, setter) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n); };
  const canSend = !!(mail && mail.configured && mail.connected && mail.send);

  async function buildDrafts() {
    setError(""); setBuilding(true);
    try {
      const files = [];
      for (const opt of options.filter((o) => attach.has(o.id))) {
        if (opt.kind === "markup") files.push({ name: opt.name, url: opt.url });
        else { const r = await driveApi({ action: "copy", id: opt.fileId, target: "preview" }); files.push({ name: opt.name, url: r.file.url }); }
      }
      setResolvedFiles(files);
      try { localStorage.setItem(SENDER_KEY, JSON.stringify(sender)); } catch { /* ignore */ }
      const scopes = chosenItems.map((item) => elementScope(item, rates, projectScope, typeName(item), takeoff ? takeoff.instances : null));
      // one draft per (package, contractor): a contractor ticked under two packages gets two RFQs, each about its own package
      const all = [];
      for (const p of pkgs) {
        const pickedOrgs = orgs.filter((o) => picked(p.key).has(o.id));
        for (const d of rfqDrafts({ orgs: pickedOrgs, projectName: quote.projectName || "Untitled project", siteAddress: quote.siteAddress || "", clientName: quote.clientName || "", pkgLabel: labelOf(p), scopes, due, sender, attachments: files, extraNotes })) all.push({ ...d, id: `d-${p.key}-${d.orgId}`, pkgKey: p.key, pkgLabel: labelOf(p) });
      }
      setDrafts(all);
      setCurrent(0); setStep("drafts");
    } catch (e) { setError(e.needsReconnect ? "The Google connection needs a reconnect for Drive (Settings → Google mail & Drive) before a Drive file can be attached." : e.message || "could not build the drafts"); }
    finally { setBuilding(false); }
  }
  const patchDraft = (i, patch) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const redraft = (i) => { const d = drafts[i]; const org = orgs.find((o) => o.id === d.orgId); if (!org) return; const scopes = chosenItems.map((item) => elementScope(item, rates, projectScope, typeName(item), takeoff ? takeoff.instances : null)); patchDraft(i, { subject: rfqSubject({ pkgLabel: d.pkgLabel, projectName: quote.projectName || "Untitled project" }), text: rfqText({ projectName: quote.projectName || "Untitled project", siteAddress: quote.siteAddress || "", clientName: quote.clientName || "", pkgLabel: d.pkgLabel, org, contact: rfqContact(org), scopes, due, sender, attachments: resolvedFiles, extraNotes }), approved: false }); };

  async function sendApproved() {
    const todo = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.approved && d.status !== "sent");
    if (!todo.length) return;
    setSending(true); setError("");
    const results = [];
    for (const { d, i } of todo) {
      patchDraft(i, { status: "sending" });
      try {
        const r = await fetch(`${apiBase()}/api/gmail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send", to: d.email, toName: d.contactName, fromName: sender.name, subject: d.subject, text: d.text, attachments: resolvedFiles }), signal: AbortSignal.timeout(120000) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        const sent = { ...d, status: "sent", messageId: body.sent && body.sent.id, threadId: body.sent && body.sent.threadId };
        patchDraft(i, sent); results.push(sent);
      } catch (e) { patchDraft(i, { status: "failed", error: e.message }); results.push({ ...d, status: "failed", error: e.message }); }
    }
    setSending(false);
    const ok = results.filter((r) => r.status === "sent");
    // one record per package on the project
    const records = pkgs.map((p) => ({ p, sent: ok.filter((r) => r.pkgKey === p.key) })).filter((x) => x.sent.length).map(({ p, sent }) => rfqRecord({ pkgKey: p.key, pkgLabel: labelOf(p), elementIds: chosenItems.map((i) => i.id), due, by: user, sent, attachments: resolvedFiles }));
    if (ok.length && onSent) onSent(records, ok);
    setStep("done");
  }

  const OrgRow = ({ o, tag, pkgKey }) => { const c = rfqContact(o); const on = picked(pkgKey).has(o.id); return (
    <label className={`flex items-start gap-2 px-2 py-1.5 rounded border ${on ? "border-orange-400 bg-orange-50" : "border-neutral-200 bg-white"} ${c.email ? "cursor-pointer" : "opacity-60"}`} data-testid={`rfq-org-${pkgKey}-${o.id}`}>
      <input type="checkbox" className="mt-1" checked={on} disabled={!c.email} onChange={() => togglePick(pkgKey, o.id)} />
      <span className="min-w-0 flex-1 text-[12.5px]">
        <span className="font-semibold">{o.name}</span>{tag && <span className={`ml-1.5 text-[10px] font-bold uppercase tracking-wider px-1.5 rounded ${tag === "does" ? "bg-emerald-100 text-emerald-800" : tag === "not" ? "bg-red-100 text-red-700" : "bg-neutral-100 text-neutral-500"}`}>{tag === "does" ? "does this" : tag === "not" ? "says they don't" : "not stated"}</span>}
        <span className="block text-neutral-500">{o.trade}</span>
        <span className="block text-neutral-600">{c.email ? `${c.name ? c.name + " · " : ""}${c.email}` : "no email address on the register — add one there first"}</span>
      </span>
    </label>
  ); };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto print:hidden" data-testid="rfq-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl my-4">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-neutral-200">
          <div>
            <div className="font-semibold text-[15px] flex items-center gap-2"><Mail size={16} /> Request for quotation — {quote.projectName || "Untitled project"}</div>
            <div className="text-[11.5px] text-neutral-500">{step === "setup" ? "1 · Elements, package and contractors" : step === "drafts" ? "2 · One draft per contractor — read, edit, approve, then send" : "3 · Sent"}</div>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-800" aria-label="Close"><X size={18} /></button>
        </div>

        {mail && (!mail.configured || !mail.connected || !mail.send) && (
          <div className="mx-5 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 flex items-start gap-2" data-testid="rfq-mail-warning">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            <span>{!mail.configured ? "The Google connection is not configured on this deployment — drafts can be built and copied, not sent." : !mail.connected ? "The projects@ mailbox is not connected — connect it under Settings → Google mail & Drive to send." : "The mailbox connection is read-only — open Settings → Google mail & Drive and click “Reconnect for sending” once. Until then, drafts can be built and copied, not sent."}</span>
          </div>
        )}
        {error && <div className="mx-5 mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-800" data-testid="rfq-error">{error}</div>}

        {step === "setup" && (
          <div className="grid md:grid-cols-2 gap-4 p-5">
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1">Elements to price</div>
                <div className="max-h-48 overflow-y-auto rounded border border-neutral-200 divide-y divide-neutral-100">
                  {items.map((it) => (
                    <label key={it.id} className="flex items-center gap-2 px-2 py-1 text-[12.5px] cursor-pointer" data-testid={`rfq-item-${it.id}`}>
                      <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(selected, it.id, setSelected)} />
                      <span className="font-medium">{it.label}</span><span className="text-neutral-400">{typeName(it)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1">Packages <span className="normal-case tracking-normal font-normal text-neutral-400">— tick every package to ask for; each gets its own contractors and its own RFQ</span></div>
                <div className="flex flex-wrap gap-1" data-testid="rfq-packages">
                  {[...suggested.map((k) => packageByKey(k)), ...RFQ_PACKAGES.filter((p) => !suggested.includes(p.key))].map((p) => (
                    <button key={p.key} type="button" onClick={() => toggle(pkgKeys, p.key, setPkgKeys)} className={`text-[12px] px-2 py-1 rounded-full border ${pkgKeys.has(p.key) ? "bg-neutral-900 border-neutral-900 text-white" : "bg-white border-neutral-300 text-neutral-700 hover:border-neutral-800"}`} data-testid={`rfq-package-${p.key}`} data-on={pkgKeys.has(p.key) ? "1" : "0"} title={suggested.includes(p.key) ? "Suggested from the chosen elements" : ""}>{p.label}{suggested.includes(p.key) ? " ★" : ""}</button>
                  ))}
                </div>
                {pkgKeys.has("other") && <input value={pkgCustom} onChange={(e) => setPkgCustom(e.target.value)} placeholder="Name the package, e.g. Precast Panels" className="mt-1 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-package-name" />}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[12px] text-neutral-600">Quotes required by<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-due" /></label>
                <label className="text-[12px] text-neutral-600">Signed<input value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-sender" /></label>
              </div>
              <label className="block text-[12px] text-neutral-600">Notes for every contractor (optional)<textarea value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[12.5px]" placeholder="e.g. Site access from Esplanade only; geotech report attached; program start February" /></label>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1 flex items-center gap-1"><Paperclip size={12} /> Attach to every email <span className="normal-case tracking-normal font-normal text-neutral-400">— {driveFolder ? (driveFolder.id ? `from the project's Drive folder “${driveFolder.name}”: the architectural, structural and soil-report files are ticked on their own` : "no Drive folder") : "reading the project's Drive folder…"}</span></div>
                {driveFolder && driveFolder.note && <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1" data-testid="rfq-drive-note">{driveFolder.note}</div>}
                {options.length === 0 ? <div className="text-[12px] text-neutral-400">{driveFolder ? "No attachable files found — add them to the project's Drive folder or drop a drawing on the element." : ""}</div> : (
                  <div className="max-h-44 overflow-y-auto rounded border border-neutral-200 divide-y divide-neutral-100">
                    {options.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 px-2 py-1 text-[12.5px] cursor-pointer" data-testid={`rfq-attach-${o.kind}`} data-auto={o.auto ? "1" : "0"} data-tags={(o.tags || []).join(",")}>
                        <input type="checkbox" checked={attach.has(o.id)} onChange={() => toggle(attach, o.id, setAttach)} />
                        <span className="font-medium truncate">{o.name}</span>
                        {(o.tags || []).filter((t) => t !== "pkg").map((t) => <span key={t} className="text-[10px] font-bold uppercase tracking-wider px-1 rounded bg-emerald-100 text-emerald-800">{t === "archi" ? "archi" : t === "struct" ? "struct" : "soil"}</span>)}
                        {(o.tags || []).includes("pkg") && <span className="text-[10px] font-bold uppercase tracking-wider px-1 rounded bg-blue-100 text-blue-800">{pkgLabelNow}</span>}
                        <span className="text-neutral-400 text-[11px] ml-auto whitespace-nowrap">{o.kind === "drive" ? (o.folderName ? o.folderName + " · " : "") + (o.size ? Math.max(1, Math.round(o.size / 1024)) + " KB" : "Drive") : `drawing on ${o.element}`}</span>
                      </label>
                    ))}
                  </div>
                )}
                {driveFolder && driveFolder.id && missing.length > 0 && <div className="text-[12px] text-amber-800 mt-1" data-testid="rfq-attach-missing">Not found in the folder, not attached: {missing.map((c) => c.label).join(", ")} — add it to Drive, or say so in the notes.</div>}
              </div>
            </div>
            <div className="space-y-3">
              {!register && <div className="text-[12px] text-neutral-500">Reading the Register…</div>}
              {register && pkgs.length === 0 && <div className="text-[12px] text-neutral-500">Tick a package to see its contractors.</div>}
              <div className="space-y-3 max-h-[30rem] overflow-y-auto pr-1">
                {pkgs.map((p) => { const g = groupsFor[p.key]; const notOpen = showNot === p.key; return (
                  <div key={p.key} className="rounded-lg border border-neutral-200 p-2 space-y-1" data-testid={`rfq-contractors-${p.key}`}>
                    <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">Contractors for {labelOf(p)} <span className="normal-case tracking-normal font-normal text-neutral-400">· {picked(p.key).size} ticked</span></div>
                    {register && g.does.length + g.unknown.length + g.not.length === 0 && <div className="text-[12px] text-neutral-500">The Register has nobody in this trade yet — search below, or add them in the Register first.</div>}
                    {g.does.map((o) => <OrgRow key={o.id} o={o} tag={p.cap ? "does" : ""} pkgKey={p.key} />)}
                    {g.unknown.map((o) => <OrgRow key={o.id} o={o} tag="unknown" pkgKey={p.key} />)}
                    {g.not.length > 0 && <button onClick={() => setShowNot(notOpen ? "" : p.key)} className="text-[11.5px] text-neutral-500 underline">{notOpen ? "Hide" : "Show"} {g.not.length} who said they do not do this</button>}
                    {notOpen && g.not.map((o) => <OrgRow key={o.id} o={o} tag="not" pkgKey={p.key} />)}
                    <input value={searches[p.key] || ""} onChange={(e) => setSearches({ ...searches, [p.key]: e.target.value })} placeholder={`Add any organisation for ${labelOf(p)}…`} className="w-full border border-neutral-300 rounded px-2 py-1 text-[12px]" data-testid={`rfq-search-${p.key}`} />
                    {hitsFor(p.key).map((o) => <OrgRow key={o.id} o={o} tag="" pkgKey={p.key} />)}
                  </div>
                ); })}
              </div>
              <div className="pt-1 flex items-center justify-between gap-2">
                <span className="text-[12px] text-neutral-500">{totalPicks} RFQ{totalPicks === 1 ? "" : "s"} across {pkgs.length} package{pkgs.length === 1 ? "" : "s"} · {chosenItems.length} element{chosenItems.length === 1 ? "" : "s"}{takeoff ? " · Estimates takeoff found" : ""}</span>
                <button onClick={buildDrafts} disabled={building || !totalPicks || !chosenItems.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium disabled:opacity-40" data-testid="rfq-build">
                  {building ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Build {totalPicks || ""} draft{totalPicks === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "drafts" && drafts.length > 0 && (
          <div className="grid md:grid-cols-[16rem_1fr] gap-4 p-5">
            <div className="space-y-1">
              {drafts.map((d, i) => (
                <button key={d.id} onClick={() => setCurrent(i)} className={`w-full text-left px-2 py-1.5 rounded border text-[12.5px] ${i === current ? "border-orange-400 bg-orange-50" : "border-neutral-200 bg-white"}`} data-testid={`rfq-draft-${d.orgId}`} data-pkg={d.pkgKey} data-approved={d.approved ? "1" : "0"} data-status={d.status}>
                  <span className="flex items-center gap-1.5"><span className={`w-4 h-4 rounded border flex items-center justify-center ${d.approved ? "bg-emerald-500 border-emerald-500 text-white" : "border-neutral-300"}`}>{d.approved && <Check size={11} />}</span><span className="font-semibold truncate">{d.orgName}</span></span>
                  {pkgs.length > 1 && <span className="block text-[11px] text-blue-800 font-semibold">{d.pkgLabel}</span>}
                  <span className="block text-neutral-500 truncate">{d.contactName ? d.contactName + " · " : ""}{d.email}</span>
                  {d.status === "sent" && <span className="text-emerald-700 font-semibold">sent</span>}{d.status === "failed" && <span className="text-red-700 font-semibold">failed: {d.error}</span>}
                </button>
              ))}
              <div className="pt-2 space-y-1">
                <button onClick={() => setDrafts((ds) => ds.map((d) => ({ ...d, approved: d.status === "sent" ? d.approved : true })))} className="w-full text-[12px] px-2 py-1 rounded border border-neutral-300 hover:border-neutral-800">Approve all</button>
                <button onClick={() => setStep("setup")} className="w-full text-[12px] px-2 py-1 rounded border border-neutral-300 hover:border-neutral-800 flex items-center justify-center gap-1"><ChevronLeft size={12} /> Back</button>
              </div>
            </div>
            {(() => { const d = drafts[current]; if (!d) return null; return (
              <div className="space-y-2">
                <div className="text-[12px] text-neutral-600"><b>{d.pkgLabel}</b> · To: <b>{d.contactName || d.orgName}</b> &lt;{d.email}&gt; — {d.orgName}{d.trade ? ` · ${d.trade}` : ""}{resolvedFiles.length ? ` · ${resolvedFiles.length} attachment${resolvedFiles.length === 1 ? "" : "s"}` : ""}</div>
                <input value={d.subject} onChange={(e) => patchDraft(current, { subject: e.target.value, approved: false })} className="w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px] font-semibold" data-testid="rfq-subject" />
                <textarea value={d.text} onChange={(e) => patchDraft(current, { text: e.target.value, approved: false })} rows={22} className="w-full border border-neutral-300 rounded px-3 py-2 text-[12.5px] font-mono leading-snug" data-testid="rfq-text" />
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button onClick={() => patchDraft(current, { approved: !d.approved })} disabled={d.status === "sent"} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${d.approved ? "bg-emerald-600 border-emerald-600 text-white" : "border-neutral-300 hover:border-neutral-800"}`} data-testid="rfq-approve">{d.approved ? <><Check size={14} /> Approved</> : "Approve this draft"}</button>
                    <button onClick={() => redraft(current)} className="text-[12px] text-neutral-500 underline">Re-draft</button>
                    <button onClick={() => { try { navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.text}`); } catch { /* ignore */ } }} className="text-[12px] text-neutral-500 underline">Copy</button>
                  </div>
                  <button onClick={sendApproved} disabled={sending || !canSend || !drafts.some((x) => x.approved && x.status !== "sent")} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium disabled:opacity-40" title={canSend ? "Each approved draft is sent as its own email" : "Sending needs the mailbox reconnected for sending (Settings)"} data-testid="rfq-send">
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send {drafts.filter((x) => x.approved && x.status !== "sent").length} approved
                  </button>
                </div>
              </div>
            ); })()}
          </div>
        )}

        {step === "done" && (
          <div className="p-5 space-y-2" data-testid="rfq-done">
            <div className="font-semibold">{drafts.filter((d) => d.status === "sent").length} RFQ{drafts.filter((d) => d.status === "sent").length === 1 ? "" : "s"} sent for {pkgLabelNow}</div>
            <ul className="text-[12.5px] space-y-1">
              {drafts.map((d) => <li key={d.id} className={d.status === "sent" ? "text-emerald-800" : d.status === "failed" ? "text-red-700" : "text-neutral-500"}>{d.status === "sent" ? "✓" : d.status === "failed" ? "✗" : "–"} {d.pkgLabel}: {d.orgName} — {d.email}{d.status === "failed" ? ` — ${d.error}` : d.status !== "sent" ? " — not approved, not sent" : ""}</li>)}
            </ul>
            <div className="text-[12px] text-neutral-500">Recorded on this project (checklist step 05 ticked) and on each contractor in the Register as their last contact.</div>
            <div className="flex gap-2 pt-1"><button onClick={() => setStep("drafts")} className="text-[12px] px-3 py-1.5 rounded border border-neutral-300">Back to the drafts</button><button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded bg-neutral-900 text-white">Close</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
