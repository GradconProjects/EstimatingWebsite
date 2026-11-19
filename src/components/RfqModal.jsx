import { serverDownReason, readServerReply, failureReason } from "../lib/serverStatus.js";
import { useEffect, useMemo, useState } from "react";
import { X, Send, Check, ChevronLeft, Paperclip, Loader2, AlertTriangle, Mail } from "lucide-react";
import { RFQ_PACKAGES, RFQ_LEAD, packageByKey, packageLabel, suggestPackages, contractorsFor, rfqContact, rfqCopies, draftCc, applyStandingRfqCopies, contractorCc, ccConflicts, ccDiffersFromRegister, rfqDrafts, rfqSubject, elementScope, dayPlus, rfqRecord, attachmentOptions, driveFolderOptions, missingAttachClasses, planAttachments, driveFileIdFrom, localFileCheck, localFileOption, driveLinkOption, LOCAL_FILE_ACCEPT, fmtBytes, ATTACH_PLAN_BYTES, DEFAULT_CC, parseCc, rfqHead, rfqBody, joinDraft, draftNameIssues } from "../lib/rfq.js";
import { readRegister, saveRfqCopies } from "../lib/registerStore.js";
import { readTakeoffForProject } from "../lib/estimatesRead.js";
import { driveApi } from "../lib/driveFiles.js";
import { markupSrc, uploadRfqFile, markupStoreEnabled } from "../lib/markupStore.js";
/** Run async jobs at most `n` at a time, in order of start; resolves when all have settled (a throw rejects at once). */
async function runPool(jobs, n) { let next = 0; const workers = Array.from({ length: Math.min(n, jobs.length) }, async () => { while (next < jobs.length) { const j = jobs[next++]; await j(); } }); await Promise.all(workers); }

import { classifyFile, driveLinkFile, unsharedDriveLinks } from "../lib/rfq.js";
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
export default function RfqModal({ quote, items, rates, projectScope, elementTypes = [], initialItemIds = null, user = "", projectId = "", onClose, onSent }) {
  const [step, setStep] = useState("setup");
  const [register, setRegister] = useState(null);
  const [orgCc, setOrgCc] = useState({});       // orgId → the text typed in its Cc box (absent = the Register's own copies)
  const [ccSave, setCcSave] = useState({});     // orgId → "saving" | "saved" | an error sentence
  const [takeoff, setTakeoff] = useState(null);
  const [mail, setMail] = useState(null); // /api/google-auth status
  const [selected, setSelected] = useState(() => new Set(initialItemIds || items.map((i) => i.id)));
  const [pkgKeys, setPkgKeys] = useState(() => new Set()); // several packages at once; each with its own contractors
  const [pkgCustom, setPkgCustom] = useState("");
  const [picks, setPicks] = useState(() => ({})); // pkgKey → Set of orgIds
  const [showNot, setShowNot] = useState("");
  const [complexity, setComplexity] = useState("simple"); // simple = 3 days, complex = 7 — Grady decides what is heavy
  const [due, setDue] = useState(() => dayPlus(RFQ_LEAD.simple.days));
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [sender, setSender] = useState(() => defaultSender());
  const [extraNotes, setExtraNotes] = useState("");
  const [showQty, setShowQty] = useState(false);   // off: the contractor measures from the documents — Gradcon's own take-off never pre-empts their figure
  const [attach, setAttach] = useState(() => new Set());
  const [drafts, setDrafts] = useState([]);
  // ONE body per package, shared by every contractor's draft of that package; a draft's own text is its
  // locked head + that body (see rfqHead in rfq.js — the greeting is never typed, so it can never be pasted wrong)
  const [bodies, setBodies] = useState({});
  const [current, setCurrent] = useState(0);
  const textOf = (d) => joinDraft(d.head, bodies[d.pkgKey] != null ? bodies[d.pkgKey] : d.body);
  const issuesOf = (d) => draftNameIssues({ ...d, body: bodies[d.pkgKey] != null ? bodies[d.pkgKey] : d.body }, drafts);
  const [building, setBuilding] = useState(false);
  const [copyNote, setCopyNote] = useState("");   // "Copying 2 of 5 — S-01 plan.pdf" while the Drive files are brought into the bucket
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [resolvedFiles, setResolvedFiles] = useState([]);
  const [resolvedLinks, setResolvedLinks] = useState([]);
  const [ccText, setCcText] = useState(() => { try { const s = localStorage.getItem("gradcon-rfq-cc"); if (s !== null) return s; } catch { /* ignore */ } return DEFAULT_CC.join(", "); });
  const ccList = useMemo(() => parseCc(ccText), [ccText]);
  const [driveFolder, setDriveFolder] = useState(null); // {id, name, files:[...], note}
  const [autoDone, setAutoDone] = useState(false);
  // files brought in BY HAND — uploaded from this computer, or a pasted Drive file link (4 Nov 2026)
  const [added, setAdded] = useState([]);
  const [addError, setAddError] = useState("");
  const [addNote, setAddNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linking, setLinking] = useState(false);

  const typeName = (item) => { const t = elementTypes.find((x) => x.id === item.typeId); return t ? t.name : ""; };
  const chosenItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const suggested = useMemo(() => suggestPackages(chosenItems, typeName), [chosenItems]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pkgKeys.size && suggested.length) setPkgKeys(new Set([suggested[0]])); }, [suggested, pkgKeys.size]);
  const pkgs = useMemo(() => RFQ_PACKAGES.filter((p) => pkgKeys.has(p.key)), [pkgKeys]);
  const pkgKeyList = useMemo(() => pkgs.map((p) => p.key), [pkgs]);
  const labelOf = (p) => packageLabel(p.key, pkgCustom);
  const pkgLabelNow = pkgs.map(labelOf).join(", ") || "—";
  // the Register's organisations, with the coded-in "RFQ copy" requests applied when the Register page has not moved this row yet
  const orgs = useMemo(() => applyStandingRfqCopies(register), [register]);
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
    const list = [...base.map((o) => (o.kind === "drive" ? { ...o, tags: classifyTags(o.name, pkgKeyList), auto: classifyTags(o.name, pkgKeyList).length > 0 } : o)), ...folder];
    // the files added by hand (uploaded, or a Drive link) come last, tagged by name like the rest; one already listed is not repeated
    const ids = new Set(list.map((o) => o.id));
    for (const a of added) if (!ids.has(a.id)) { list.push({ ...a, tags: classifyTags(a.name, pkgKeyList) }); ids.add(a.id); }
    return list;
  }, [quote, chosenItems, driveFolder, pkgKeyList, added]);
  // the relevant files are ticked on their own once the folder has been read (and again when the package changes)
  useEffect(() => { if (!driveFolder || autoDone) return; setAttach(new Set(options.filter((o) => o.auto || o.kind === "markup").map((o) => o.id))); setAutoDone(true); }, [driveFolder, options, autoDone]);
  useEffect(() => { setAutoDone(false); }, [pkgKeyList.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = useMemo(() => missingAttachClasses(options, attach), [options, attach]);
  const plan = useMemo(() => planAttachments(options.filter((o) => attach.has(o.id))), [options, attach]);

  // A document the folder does not hold is added BY HAND and ticked at once (Grady, 4 Nov 2026: "i would like this error
  // message to not stop the progress of works. rather add a button so i can add local files too or drive links"): a file
  // from this computer goes into the portal's own bucket (the only place the send function fetches an attachment from);
  // a pasted Drive FILE link is read through the Drive function (root-scoped — outside the office folder is a 403).
  const addOption = (opt) => { setAdded((a) => (a.some((x) => x.id === opt.id) ? a : [...a, opt])); setAttach((s) => new Set([...s, opt.id])); };
  async function addLocalFiles(fileList) {
    setAddError("");
    const files = Array.from(fileList || []); if (!files.length) return;
    if (!markupStoreEnabled) { setAddError("Cloud storage is not configured in this build — a file from this computer cannot be attached here."); return; }
    setUploading(true); const bad = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]; const why = localFileCheck(f);
        if (why) { bad.push(`${f.name} (${why})`); continue; }
        setAddNote(`Uploading ${i + 1} of ${files.length} — ${f.name}`);
        try { const up = await uploadRfqFile(projectId || "project", f); addOption(localFileOption(up, pkgKeyList)); }
        catch (e) { bad.push(`${f.name} (${(e && e.message) || "upload failed"})`); }
      }
    } finally { setUploading(false); setAddNote(""); }
    if (bad.length) setAddError("Not attached — " + bad.join("; ") + ".");
  }
  async function addDriveLink() {
    setAddError("");
    const id = driveFileIdFrom(linkText);
    if (!id) { setAddError("That is not a Google Drive file link — in Drive, right-click the file → Share → Copy link, and paste it here."); return; }
    const have = options.find((o) => o.kind === "drive" && o.fileId === id);
    if (have) { setAttach((s) => new Set([...s, have.id])); setLinkText(""); return; }
    setLinking(true);
    try {
      const r = await driveApi({ action: "file", id });
      const opt = driveLinkOption(r && r.file, pkgKeyList);
      if (!opt) { setAddError("That link is a folder — paste the link of a FILE (a folder's files are read from the project folder itself)."); return; }
      addOption(opt); setLinkText("");
    } catch (e) {
      setAddError(e && e.status === 403 ? "That file is outside the office folder the app may read — move or share it into the project files folder, or add it from this computer."
        : e && e.needsReconnect ? "The Google connection needs a reconnect for Drive (Settings → Google mail & Drive) before a Drive link can be read."
        : "The Drive link could not be read" + (e && e.message ? ": " + e.message : "") + ".");
    } finally { setLinking(false); }
  }

  useEffect(() => {
    let alive = true;
    readRegister().then((r) => { if (alive) setRegister(r); });
    readTakeoffForProject(quote.projectName).then((t) => { if (alive) setTakeoff(t); }).catch(() => {});
    fetch(`${apiBase()}/api/google-auth?action=status`, { headers: { accept: "application/json" } }).then(async (r) => { const rep = await readServerReply(r); return rep.body && r.ok ? rep.body : { configured: false, reason: failureReason(rep) }; }).then((d) => { if (alive) setMail(d); }).catch(() => { if (alive) setMail({ configured: false, reason: serverDownReason(0) }); });
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
        // the subfolders and the keyword searches are read AT ONCE (26 Oct 2026: thirteen round trips in a row made the composer slow to open)
        const [subRes, wordRes] = await Promise.all([
          Promise.all(subs.map((sf) => driveApi({ action: "list", folderId: sf.id, max: 200 }).then((r) => ({ sf, files: r.files || [] })).catch(() => ({ sf, files: [] })))),   /* one subfolder failing never hides the rest */
          Promise.all(["architectural", "structural", "geotech", "soil"].map((word) => driveApi({ action: "search", text: word, within: folder.id, max: 40 }).then((r) => r.files || []).catch(() => []))),
        ]);
        for (const { sf, files } of subRes) for (const f of files) add(f, sf.name);
        for (const files of wordRes) for (const f of files) add(f, "");
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
      // the ticked Drive files are copied into the bucket FOUR AT A TIME, in the ticked order, with progress on the button
      // (26 Oct 2026, Grady: "attaching documents to the RFQ email seems too slow" — one 10 MB drawing after another, each a
      // Drive download and a bucket upload inside one function call; the server now answers a file it already holds at once)
      const ticked = options.filter((o) => attach.has(o.id));
      const files = new Array(ticked.length); let done = 0;
      await runPool(ticked.map((opt, i) => async () => {
        if (opt.kind === "markup" || opt.kind === "local") { files[i] = { name: opt.name, url: opt.url, tags: opt.kind === "local" && opt.tags && opt.tags.length ? opt.tags : ["pkg"], size: Number(opt.size) || 0 }; }
        else {
          setCopyNote(`Copying ${Math.min(done + 1, ticked.length)} of ${ticked.length} — ${opt.name}`);
          // `big`: the copy may only ever be LINKED, so it may be far larger than a preview. A file the storage still
          // cannot take (or a copy that fails) goes on the RFQ as its own Drive link — it never stops the build
          // (Boma, 19 Nov 2026: "rather than say file over 30mb it should rather have the link attached a readable one").
          try {
            const r = await driveApi({ action: "copy", id: opt.fileId, target: "preview", big: true });
            files[i] = { name: opt.name, url: r.file.url, tags: opt.tags || [], size: Number(opt.size) || Number(r.file && r.file.size) || 0 };
          } catch (e) {
            if (e && e.needsReconnect) throw e;   // nothing can be read from Drive at all: say so, once
            files[i] = driveLinkFile(opt, (e && e.message) || "the copy failed");
          }
        }
        done++; setCopyNote(done < ticked.length ? `Copied ${done} of ${ticked.length}` : "");
      }), 4);
      // what fits goes as attachments, the rest as download links — never a failed send
      const planned = planAttachments(files);
      setResolvedFiles(planned.attach); setResolvedLinks(planned.link);
      try { localStorage.setItem("gradcon-rfq-cc", ccText); } catch { /* ignore */ }
      try { localStorage.setItem(SENDER_KEY, JSON.stringify(sender)); } catch { /* ignore */ }
      const scopes = chosenItems.map((item) => elementScope(item, rates, projectScope, typeName(item), takeoff ? takeoff.instances : null));
      // one draft per (package, contractor): a contractor ticked under two packages gets two RFQs, each about its own package
      const all = [];
      for (const p of pkgs) {
        const pickedOrgs = orgs.filter((o) => picked(p.key).has(o.id));
        for (const d of rfqDrafts({ orgs: pickedOrgs, projectName: quote.projectName || "Untitled project", siteAddress: quote.siteAddress || "", pkgLabel: labelOf(p), pkgKey: p.key, showQuantities: showQty, scopes, due, leadDays: RFQ_LEAD[complexity].days, requestedOn: today(), sender, attachments: planned.attach, links: planned.link, extraNotes, ccByOrg: Object.fromEntries(pickedOrgs.map((o) => [o.id, ccFor(o).list])) })) all.push({ ...d, id: `d-${p.key}-${d.orgId}`, pkgKey: p.key, pkgLabel: labelOf(p) });
      }
      const nextBodies = {}; for (const d of all) if (nextBodies[d.pkgKey] == null) nextBodies[d.pkgKey] = d.body;
      setBodies(nextBodies); setDrafts(all);
      setCurrent(0); setStep("drafts");
    } catch (e) { setError(e.needsReconnect ? "The Google connection needs a reconnect for Drive (Settings → Google mail & Drive) before a Drive file can be attached." : e.message || "could not build the drafts"); }
    finally { setCopyNote(""); setBuilding(false); }
  }
  const patchDraft = (i, patch) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  // Re-draft rebuilds the package's shared body (every draft of the package follows, approvals cleared) and this draft's head
  const redraft = (i) => { const d = drafts[i]; const org = orgs.find((o) => o.id === d.orgId); if (!org) return; const scopes = chosenItems.map((item) => elementScope(item, rates, projectScope, typeName(item), takeoff ? takeoff.instances : null)); const body = rfqBody({ projectName: quote.projectName || "Untitled project", siteAddress: quote.siteAddress || "", pkgLabel: d.pkgLabel, pkgKey: d.pkgKey, showQuantities: showQty, scopes, due, leadDays: RFQ_LEAD[complexity].days, requestedOn: today(), sender, attachments: resolvedFiles, links: resolvedLinks, extraNotes }); setBodies((b) => ({ ...b, [d.pkgKey]: body })); setDrafts((ds) => ds.map((x) => (x.pkgKey === d.pkgKey ? { ...x, body, subject: rfqSubject({ pkgLabel: x.pkgLabel, projectName: quote.projectName || "Untitled project" }), approved: false, ...(x.id === d.id ? { head: rfqHead({ pkgLabel: d.pkgLabel, org, contact: rfqContact(org) }) } : {}) } : x))); };
  const editBody = (pkgKey, body) => { setBodies((b) => ({ ...b, [pkgKey]: body })); setDrafts((ds) => ds.map((x) => (x.pkgKey === pkgKey && x.status !== "sent" ? { ...x, approved: false } : x))); };

  async function sendApproved() {
    const todo = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.approved && d.status !== "sent");
    if (!todo.length) return;
    setSending(true); setError("");
    // the approved drafts go THREE AT A TIME — each send is its own POST and its own result, in the drafts' order
    const results = new Array(todo.length);
    await runPool(todo.map(({ d, i }, k) => async () => {
      // the name guard runs again at the moment of sending — a draft naming another contractor never leaves
      const issues = issuesOf(d);
      if (issues.length) { const msg = `not sent — the text names ${issues.map((x) => x.orgName).join(", ")} (another contractor in this round)`; patchDraft(i, { status: "failed", error: msg, approved: false }); results[k] = { ...d, status: "failed", error: msg }; return; }
      const text = textOf(d);
      patchDraft(i, { status: "sending", text });
      try {
        const r = await fetch(`${apiBase()}/api/gmail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send", to: d.email, toName: d.contactName, fromName: sender.name, subject: d.subject, text, attachments: resolvedFiles.map((f) => ({ name: f.name, url: f.url })), cc: draftCc(d, ccList) }), signal: AbortSignal.timeout(120000) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        const sent = { ...d, text, status: "sent", messageId: body.sent && body.sent.id, threadId: body.sent && body.sent.threadId };
        patchDraft(i, sent); results[k] = sent;
      } catch (e) { patchDraft(i, { status: "failed", error: e.message }); results[k] = { ...d, status: "failed", error: e.message }; }
    }), 3);
    setSending(false);
    const ok = results.filter((r) => r.status === "sent");
    // one record per package on the project
    const records = pkgs.map((p) => ({ p, sent: ok.filter((r) => r.pkgKey === p.key) })).filter((x) => x.sent.length).map(({ p, sent }) => rfqRecord({ pkgKey: p.key, pkgLabel: labelOf(p), elementIds: chosenItems.map((i) => i.id), due, by: user, sent, attachments: resolvedFiles }));
    if (ok.length && onSent) onSent(records, ok);
    setStep("done");
  }

  // The contractor's own Cc (Boma, 17 Nov 2026): one box per ticked contractor, prefilled with the addresses ticked
  // "RFQ copy" on the Register (DMAC: estimating@, danny@), editable here, and "Save to Register" keeps what was typed
  // so it is prefilled next time. An address that belongs to another organisation on the Register is never copied.
  const ccTextFor = (o) => (orgCc[o.id] !== undefined ? orgCc[o.id] : rfqCopies(o).join(", "));
  const ccFor = (o) => { const typed = contractorCc(o, ccTextFor(o)); const conflicts = ccConflicts(o, typed, orgs); const bad = new Set(conflicts.map((x) => x.email)); return { list: typed.filter((e) => !bad.has(e)), conflicts }; };
  const saveCc = async (o) => {
    const { list } = ccFor(o);
    setCcSave((m) => ({ ...m, [o.id]: "saving" }));
    let reg = null;
    try { reg = await saveRfqCopies(o.id, list, String(user || "").split("@")[0] || "quotes"); } catch { reg = null; }
    if (!reg) { setCcSave((m) => ({ ...m, [o.id]: "The Register could not be read just now, so nothing was saved. The addresses still go on this RFQ." })); return; }
    setRegister(reg);
    setOrgCc((m) => { const n = { ...m }; delete n[o.id]; return n; });
    setCcSave((m) => ({ ...m, [o.id]: reg.saved === false ? "Saved in this browser only — the cloud did not take it; the Register will retry when it is next opened." : "saved" }));
  };
  // A plain function (not a component): a component defined in here is a new type on every render, which would
  // remount the Cc box and drop the cursor on each keystroke.
  const orgRow = (o, tag, pkgKey) => { const c = rfqContact(o); const copies = rfqCopies(o); const on = picked(pkgKey).has(o.id); const cc = on ? ccFor(o) : null; const note = ccSave[o.id]; const dirty = on && ccDiffersFromRegister(o, cc.list); return (
    <div key={o.id} className="space-y-0">
    <label className={`flex items-start gap-2 px-2 py-1.5 rounded border ${on ? "border-orange-400 bg-orange-50" : "border-neutral-200 bg-white"} ${c.email ? "cursor-pointer" : "opacity-60"}`} data-testid={`rfq-org-${pkgKey}-${o.id}`}>
      <input type="checkbox" className="mt-1" checked={on} disabled={!c.email} onChange={() => togglePick(pkgKey, o.id)} />
      <span className="min-w-0 flex-1 text-[12.5px]">
        <span className="font-semibold">{o.name}</span>{tag && <span className={`ml-1.5 text-[10px] font-bold uppercase tracking-wider px-1.5 rounded ${tag === "does" ? "bg-emerald-100 text-emerald-800" : tag === "not" ? "bg-red-100 text-red-700" : "bg-neutral-100 text-neutral-500"}`}>{tag === "does" ? "does this" : tag === "not" ? "says they don't" : "not stated"}</span>}
        <span className="block text-neutral-500">{o.trade}</span>
        <span className="block text-neutral-600">{c.email ? `${c.name ? c.name + " · " : ""}${c.email}` : "no email address on the register — add one there first"}</span>
        {c.email && !on && copies.length > 0 && <span className="block text-neutral-500" title="Their own addresses, ticked 'RFQ copy' on the Register — copied on this contractor's RFQ only" data-testid={`rfq-org-copies-${o.id}`}>+ cc {copies.join(", ")}</span>}
      </span>
    </label>
    {on && (
      <div className="ml-7 mr-1 -mt-px mb-1 px-2 py-1.5 rounded-b border border-t-0 border-orange-300 bg-orange-50/60 text-[12px] text-neutral-700" data-testid={`rfq-org-cc-${pkgKey}-${o.id}`}>
        <label className="block">Cc at {o.name} <span className="text-neutral-400">(their own people — on this contractor's email only)</span>
          <input value={ccTextFor(o)} onChange={(e) => { const v = e.target.value; setOrgCc((m) => ({ ...m, [o.id]: v })); setCcSave((m) => { if (!m[o.id]) return m; const n = { ...m }; delete n[o.id]; return n; }); }} placeholder="name@theircompany.com.au, …" className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-[12.5px] bg-white" data-testid={`rfq-org-cc-input-${o.id}`} />
        </label>
        {cc.conflicts.length > 0 && <div className="mt-1 text-red-700" data-testid={`rfq-org-cc-conflict-${o.id}`}>Not copied: {cc.conflicts.map((x) => `${x.email} belongs to ${x.orgName}`).join("; ")} — contractors are never copied on each other.</div>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-neutral-500">
          {cc.list.length ? <span data-testid={`rfq-org-cc-count-${o.id}`}>{cc.list.length} cop{cc.list.length === 1 ? "y" : "ies"} on this RFQ</span> : <span>No copies at {o.name}.</span>}
          {dirty && note !== "saving" && <button type="button" onClick={() => saveCc(o)} className="px-2 py-0.5 rounded border border-orange-400 bg-white hover:bg-orange-100 text-orange-900 font-semibold" title={`Keep these addresses as ${o.name}'s RFQ copies on the Register, so they are filled in next time`} data-testid={`rfq-org-cc-save-${o.id}`}>Save to Register</button>}
          {note === "saving" && <span>Saving…</span>}
          {note === "saved" && !dirty && <span className="text-emerald-700" data-testid={`rfq-org-cc-saved-${o.id}`}>✓ Saved on the Register — filled in next time</span>}
          {note && note !== "saving" && note !== "saved" && <span className="text-red-700" data-testid={`rfq-org-cc-error-${o.id}`}>{note}</span>}
          {!dirty && !note && cc.list.length > 0 && <span>· as saved on the Register</span>}
        </div>
      </div>
    )}
    </div>
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
            <span>{mail.reason ? `${mail.reason} Drafts can be built and copied, not sent.` : !mail.configured ? "The Google connection is not configured on this deployment — drafts can be built and copied, not sent." : !mail.connected ? "The projects@ mailbox is not connected — connect it under Settings → Google mail & Drive to send." : "The mailbox connection is read-only — open Settings → Google mail & Drive and click “Reconnect for sending” once. Until then, drafts can be built and copied, not sent."}</span>
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
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1">How heavy is this quote?</div>
                <div className="flex gap-1" data-testid="rfq-complexity">
                  {Object.entries(RFQ_LEAD).map(([k, v]) => <button key={k} type="button" onClick={() => { setComplexity(k); setDue(dayPlus(v.days)); }} className={`text-[12px] px-2 py-1 rounded-full border ${complexity === k ? "bg-neutral-900 border-neutral-900 text-white" : "bg-white border-neutral-300 hover:border-neutral-800"}`} data-testid={`rfq-complexity-${k}`}>{v.label}</button>)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[12px] text-neutral-600">Quotes required by <span className="text-neutral-400">({RFQ_LEAD[complexity].days} days; business day, editable)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-due" /></label>
                <label className="text-[12px] text-neutral-600">Signed<input value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-sender" /></label>
              </div>
              <label className="block text-[12px] text-neutral-600">Cc on every email <span className="text-neutral-400">(Gradcon's own copies — contractors are never cc'd on each other)</span><input value={ccText} onChange={(e) => setCcText(e.target.value)} placeholder="grady@gradcon.com.au, …" className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px]" data-testid="rfq-cc" /></label>
              <label className="flex items-start gap-2 text-[12px] text-neutral-700" data-testid="rfq-show-qty-row">
                <input type="checkbox" checked={showQty} onChange={(e) => setShowQty(e.target.checked)} className="mt-0.5" data-testid="rfq-show-qty" />
                <span><b>Include our measured quantities</b> in the scope <span className="text-neutral-500">(off: each RFQ names the elements and the kinds of work for its own package only, and the contractor measures from the documents)</span></span>
              </label>
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
                        {o.size > 0 && <span className={`text-[11px] tabular-nums ${plan.link.some((f) => f.id === o.id) ? "text-amber-800 font-semibold" : "text-neutral-400"}`} data-testid="rfq-attach-bytes">{fmtBytes(o.size)}{plan.link.some((f) => f.id === o.id) ? " · as a link" : ""}</span>}
                        {(o.tags || []).filter((t) => t !== "pkg").map((t) => <span key={t} className="text-[10px] font-bold uppercase tracking-wider px-1 rounded bg-emerald-100 text-emerald-800">{t === "archi" ? "archi" : t === "struct" ? "struct" : "soil"}</span>)}
                        {(o.tags || []).includes("pkg") && <span className="text-[10px] font-bold uppercase tracking-wider px-1 rounded bg-blue-100 text-blue-800">{pkgLabelNow}</span>}
                        <span className="text-neutral-400 text-[11px] ml-auto whitespace-nowrap">{o.kind === "drive" ? (o.folderName ? o.folderName + " · " : "") + (o.size ? Math.max(1, Math.round(o.size / 1024)) + " KB" : "Drive") : o.kind === "local" ? "from this computer" : `drawing on ${o.element}`}</span>
                      </label>
                    ))}
                  </div>
                )}
                {(driveFolder || added.length > 0) && missing.length > 0 && <div className="text-[12px] text-neutral-600 mt-1" data-testid="rfq-attach-missing">Not attached yet: {missing.map((c) => c.label).join(", ")} — add it below from this computer or as a Drive link, or say so in the notes. The RFQ goes without it if you choose.</div>}
                {attach.size > 0 && <div className={`text-[12px] mt-1 ${plan.link.length ? "text-amber-800" : "text-neutral-500"}`} data-testid="rfq-attach-size">{fmtBytes(plan.total)} attached of {fmtBytes(ATTACH_PLAN_BYTES)} Gmail allows{plan.link.length ? ` — ${plan.link.map((f) => f.name).join(", ")} ${plan.link.length === 1 ? "is" : "are"} too large and will go as download links in the email` : ""}</div>}
                {driveFolder && attach.size === 0 && <div className="text-[12px] text-amber-800 mt-1" data-testid="rfq-attach-none">Nothing is ticked yet — an RFQ normally goes out with the architectural and structural drawings and the soil report attached. Tick them, add them below, or build anyway and say they follow separately.</div>}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="rfq-add-files">
                  <label className={`inline-flex items-center gap-1 px-2 py-1 rounded border border-neutral-300 bg-white text-[12px] cursor-pointer ${uploading ? "opacity-60" : "hover:bg-neutral-50"}`} data-testid="rfq-add-local" title="Upload files from this computer into the project's file store and attach them">
                    {uploading ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />} {uploading ? (addNote || "Uploading…") : "Add files from this computer"}
                    <input type="file" multiple className="hidden" accept={LOCAL_FILE_ACCEPT} disabled={uploading} onChange={(e) => { const fl = Array.from(e.target.files || []); e.target.value = ""; addLocalFiles(fl); }} data-testid="rfq-add-local-input" />
                  </label>
                  <input value={linkText} onChange={(e) => setLinkText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDriveLink(); } }} placeholder="Paste a Google Drive file link…" className="flex-1 min-w-[12rem] border border-neutral-300 rounded px-2 py-1 text-[12px]" data-testid="rfq-add-link" />
                  <button type="button" onClick={addDriveLink} disabled={linking || !linkText.trim()} className="px-2 py-1 rounded border border-neutral-300 bg-white text-[12px] hover:bg-neutral-50 disabled:opacity-40" data-testid="rfq-add-link-button">{linking ? "Reading…" : "Add link"}</button>
                </div>
                {addError && <div className="text-[12px] text-red-700 mt-1" data-testid="rfq-add-error">{addError}</div>}
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
                    {g.does.map((o) => orgRow(o, p.cap ? "does" : "", p.key))}
                    {g.unknown.map((o) => orgRow(o, "unknown", p.key))}
                    {g.not.length > 0 && <button onClick={() => setShowNot(notOpen ? "" : p.key)} className="text-[11.5px] text-neutral-500 underline">{notOpen ? "Hide" : "Show"} {g.not.length} who said they do not do this</button>}
                    {notOpen && g.not.map((o) => orgRow(o, "not", p.key))}
                    <input value={searches[p.key] || ""} onChange={(e) => setSearches({ ...searches, [p.key]: e.target.value })} placeholder={`Add any organisation for ${labelOf(p)}…`} className="w-full border border-neutral-300 rounded px-2 py-1 text-[12px]" data-testid={`rfq-search-${p.key}`} />
                    {hitsFor(p.key).map((o) => orgRow(o, "", p.key))}
                  </div>
                ); })}
              </div>
              <div className="pt-1 flex items-center justify-between gap-2">
                <span className="text-[12px] text-neutral-500">{totalPicks} RFQ{totalPicks === 1 ? "" : "s"} across {pkgs.length} package{pkgs.length === 1 ? "" : "s"} · {chosenItems.length} element{chosenItems.length === 1 ? "" : "s"}{takeoff ? " · Estimates takeoff found" : ""}</span>
                <button onClick={buildDrafts} disabled={building || !totalPicks || !chosenItems.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium disabled:opacity-40" data-testid="rfq-build">
                  {building ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} {building && copyNote ? copyNote : `Build ${totalPicks || ""} draft${totalPicks === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "drafts" && resolvedLinks.some((f) => f.driveLink) && (() => {
          // files the portal's storage could not take: the email carries their Drive links — say which a contractor can open
          const dl = resolvedLinks.filter((f) => f.driveLink); const closed = unsharedDriveLinks(dl);
          return (
            <div className={`mx-5 mt-3 rounded-lg border px-3 py-2 text-[12px] ${closed.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-neutral-200 bg-neutral-50 text-neutral-700"}`} data-testid="rfq-drive-links">
              <div className="font-semibold">{dl.length === 1 ? "One file is" : `${dl.length} files are`} too large to copy, so the email carries {dl.length === 1 ? "its" : "their"} Google Drive link{dl.length === 1 ? "" : "s"} instead of an attachment.</div>
              <ul className="mt-1 space-y-0.5">
                {dl.map((f) => (
                  <li key={f.url} data-testid="rfq-drive-link" data-shared={f.linkShared === true ? "yes" : f.linkShared === false ? "no" : "unknown"}>
                    <a href={f.url} target="_blank" rel="noreferrer" className="underline font-semibold">{f.name}</a>{f.size ? ` (${fmtBytes(f.size)})` : ""}
                    {" — "}{f.linkShared === true ? "shared with anyone who has the link: the contractor can open it." : f.linkShared === false ? "NOT shared outside the office: the contractor will be asked to request access." : "Drive did not say who can open it."}
                  </li>
                ))}
              </ul>
              {closed.length > 0 && <div className="mt-1">Before sending, open {closed.length === 1 ? "it" : "each one"} in Drive → Share → General access → <b>Anyone with the link · Viewer</b>, so the contractor can read it. The app only reads Drive and cannot change sharing.</div>}
            </div>
          );
        })()}
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
                <button onClick={() => setDrafts((ds) => ds.map((d) => ({ ...d, approved: d.status === "sent" ? d.approved : issuesOf(d).length === 0 })))} className="w-full text-[12px] px-2 py-1 rounded border border-neutral-300 hover:border-neutral-800">Approve all</button>
                <button onClick={() => setStep("setup")} className="w-full text-[12px] px-2 py-1 rounded border border-neutral-300 hover:border-neutral-800 flex items-center justify-center gap-1"><ChevronLeft size={12} /> Back</button>
              </div>
            </div>
            {(() => { const d = drafts[current]; if (!d) return null; const issues = issuesOf(d); const sharers = drafts.filter((x) => x.pkgKey === d.pkgKey).length; return (
              <div className="space-y-2">
                <div className="text-[12px] text-neutral-600" data-testid="rfq-head"><b>{d.pkgLabel}</b> · To: <b>{d.contactName || d.orgName}</b> &lt;{d.email}&gt; — {d.orgName}{d.trade ? ` · ${d.trade}` : ""}{(d.cc || []).length ? <span data-testid="rfq-own-cc"> · Cc (their own): <b>{d.cc.join(", ")}</b></span> : null}{ccList.length ? ` · Cc: ${ccList.join(", ")}` : ""}{resolvedFiles.length ? ` · ${resolvedFiles.length} attachment${resolvedFiles.length === 1 ? "" : "s"}` : ""}{resolvedLinks.length ? ` · ${resolvedLinks.length} as download link${resolvedLinks.length === 1 ? "" : "s"}` : ""}</div>
                <input value={d.subject} onChange={(e) => patchDraft(current, { subject: e.target.value, approved: false })} className="w-full border border-neutral-300 rounded px-2 py-1.5 text-[13px] font-semibold" data-testid="rfq-subject" />
                <pre className="m-0 whitespace-pre-wrap border border-neutral-200 bg-neutral-50 rounded px-3 py-2 text-[12.5px] font-mono leading-snug text-neutral-800" title="Written for this contractor from the Register — not editable, so it can never be pasted into another contractor's email" data-testid="rfq-head-lines">{d.head}</pre>
                <div className="text-[11px] text-neutral-500 -mt-1">↑ greeting written for <b>{d.orgName}</b> (locked) · ↓ the wording below goes to {sharers === 1 ? "this contractor" : `all ${sharers} ${d.pkgLabel} contractors`} — edit it once{sharers > 1 ? ", never copy it between drafts" : ""}</div>
                <textarea value={bodies[d.pkgKey] != null ? bodies[d.pkgKey] : d.body} onChange={(e) => editBody(d.pkgKey, e.target.value)} rows={20} className={`w-full border rounded px-3 py-2 text-[12.5px] font-mono leading-snug ${issues.length ? "border-red-400 bg-red-50" : "border-neutral-300"}`} data-testid="rfq-text" />
                {issues.length > 0 && <div className="text-[12px] text-red-700 font-medium" data-testid="rfq-name-issue">✗ This email to {d.orgName} names {issues.map((x) => `${x.orgName} ("${x.found}")`).join(", ")} — another contractor in this round. Remove it (or Re-draft) before it can be approved or sent.</div>}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button onClick={() => patchDraft(current, { approved: issues.length ? false : !d.approved })} disabled={d.status === "sent" || issues.length > 0} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${d.approved ? "bg-emerald-600 border-emerald-600 text-white" : "border-neutral-300 hover:border-neutral-800"}`} data-testid="rfq-approve">{d.approved ? <><Check size={14} /> Approved</> : "Approve this draft"}</button>
                    <button onClick={() => redraft(current)} className="text-[12px] text-neutral-500 underline">Re-draft</button>
                    <button onClick={() => { try { navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${textOf(d)}`); } catch { /* ignore */ } }} className="text-[12px] text-neutral-500 underline">Copy</button>
                  </div>
                  <button onClick={sendApproved} disabled={sending || !canSend || !drafts.some((x) => x.approved && x.status !== "sent" && !issuesOf(x).length)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium disabled:opacity-40" title={canSend ? "Each approved draft is sent as its own email" : "Sending needs the mailbox reconnected for sending (Settings)"} data-testid="rfq-send">
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send {drafts.filter((x) => x.approved && x.status !== "sent").length} approved
                  </button>
                </div>
              </div>
            ); })()}
          </div>
        )}

        {step === "done" && (
          <div className="p-5 space-y-2" data-testid="rfq-done">
            {(() => { const n = drafts.filter((d) => d.status === "sent").length; return <div className={`font-semibold ${n ? "" : "text-red-700"}`}>{n ? `${n} RFQ${n === 1 ? "" : "s"} sent for ${pkgLabelNow}` : `Nothing was sent for ${pkgLabelNow} — see the reasons below, fix them and send again`}</div>; })()}
            <ul className="text-[12.5px] space-y-1">
              {drafts.map((d) => <li key={d.id} className={d.status === "sent" ? "text-emerald-800" : d.status === "failed" ? "text-red-700" : "text-neutral-500"}>{d.status === "sent" ? "✓" : d.status === "failed" ? "✗" : "–"} {d.pkgLabel}: {d.orgName} — {d.email}{d.status === "failed" ? ` — ${d.error}` : d.status !== "sent" ? " — not approved, not sent" : ""}</li>)}
            </ul>
            {drafts.some((d) => d.status === "sent") ? <div className="text-[12px] text-neutral-500">Recorded on this project (checklist step 05 ticked) and on each contractor in the Register as their last contact.</div> : <div className="text-[12px] text-neutral-500">Nothing was recorded. Go back to the drafts, or back to step 1 to change the attachments, then send again.</div>}
            <div className="flex gap-2 pt-1"><button onClick={() => setStep("drafts")} className="text-[12px] px-3 py-1.5 rounded border border-neutral-300">Back to the drafts</button><button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded bg-neutral-900 text-white">Close</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
