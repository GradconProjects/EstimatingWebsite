/**
 * Gathers a project's bundle in the browser (Grady, 5 Nov 2026: "Download
 * project … export the estimates, the quotes etc and even the emails associated
 * to that project as a reference manual") and hands the pieces to the pure
 * `projectBundle.js`. Every network read is best-effort and READ-ONLY: a piece
 * that cannot be fetched is named in the manual's "Not included" list, never a
 * silent gap. `deps` are the test seam: {fetch, gmail, drive, readTakeoff,
 * listVersions, markupSrc, now, by}.
 */
import { manualHtml, zipStore, bundleName, safeName, takeoffCsv, emailText, emailFileName, mailQuery } from "./projectBundle.js";
import { buildQuoteFile } from "./quoteVersions.js";
import { buildQuoteExcelHtml, buildQuoteCsv } from "./exportQuote.js";
import { allProjectFiles } from "./driveFiles.js";

export const EMAILS_MAX = 60;       // the newest N messages that match the project's name / address
const IN_FLIGHT = 5;

async function pool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}
async function fetchBytes(url, fetchImpl, timeoutMs = 60000) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const defaultGmail = (fetchImpl) => async (body) => {
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
  const r = await fetchImpl(`${origin}/api/gmail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || `mail request failed (${r.status})`); e.status = r.status; throw e; }
  return d;
};

/** The project's correspondence from projects@: the newest matches, each read in full. {emails, note}. */
export async function gatherEmails(quote, gmail, { max = EMAILS_MAX } = {}) {
  const q = mailQuery(quote);
  if (!q) return { emails: [], note: "The project has no name to search the mailbox by." };
  let listed;
  try { listed = await gmail({ action: "list", q, max }); }
  catch (e) { return { emails: [], note: e.status === 503 || e.status === 409 ? "The projects@ mailbox is not connected (Settings → Google mail & Drive)." : `The mailbox could not be searched: ${e.message}` }; }
  const heads = (listed && listed.messages) || [];
  const emails = await pool(heads, IN_FLIGHT, async (h) => {
    try { const r = await gmail({ action: "read", id: h.id }); return { ...h, ...(r.message || {}) }; }
    catch { return { ...h, text: h.snippet || "", unread: true }; }
  });
  emails.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return { emails, note: emails.length ? "" : `No email in projects@ matches ${q}.`, query: q };
}

/**
 * Build the bundle: {blob, name, report: {files, issues, counts}}. `want` picks
 * the optional parts: {emails, drawings, files, takeoff, versions} (all true by default).
 */
export async function buildProjectBundle({ quote, items, rates, project, elementTypes, want = {} }, deps = {}, onProgress = () => {}) {
  const fetchImpl = deps.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const gmail = deps.gmail || defaultGmail(fetchImpl);
  const at = deps.now ? deps.now() : new Date();
  const folder = bundleName(quote, at);
  const files = []; const manifest = []; const issues = [];
  const add = (name, data, what, note) => { files.push({ name: `${folder}/${name}`, data, modified: at }); manifest.push({ name, what, note }); };
  const w = { emails: true, drawings: true, files: true, takeoff: true, versions: true, ...want };
  const step = (text) => onProgress(text);

  // 1. the quote itself (restorable), the sheet and the csv
  step("Writing the quote…");
  const doc = buildQuoteFile(project.id, quote, "bundle", deps.by || undefined);
  add("quote/quote.json", JSON.stringify(doc, null, 2), "The whole quote as Quotes saves it — Open .json in Quotes to work on a copy");
  try { add("quote/quote.xls", buildQuoteExcelHtml(quote, items, rates), "The costing sheet (Excel)"); } catch (e) { issues.push(`The Excel sheet could not be written: ${e.message}`); }
  try { add("quote/quote.csv", buildQuoteCsv(quote, items, rates), "The costing lines (CSV)"); } catch (e) { issues.push(`The CSV could not be written: ${e.message}`); }

  // 2. the Estimates takeoff with the project's name
  let takeoff = null; let takeoffNote = "";
  if (w.takeoff) {
    step("Reading the Estimates takeoff…");
    try {
      takeoff = deps.readTakeoff ? await deps.readTakeoff(quote.projectName, quote.nameSource) : null;
      if (takeoff) {
        add("estimates/takeoff.json", JSON.stringify({ name: takeoff.name, key: takeoff.key, instances: takeoff.instances, exportedAt: at.toISOString() }, null, 2), `The Estimates takeoff "${takeoff.name}" (every element's fields and register lines)`);
        add("estimates/register.csv", takeoffCsv(takeoff.instances), "The takeoff's quantity register (CSV)");
      } else takeoffNote = "No Estimates takeoff carries this project's name.";
    } catch (e) { takeoffNote = `The takeoff could not be read: ${e.message}`; issues.push(takeoffNote); }
  }

  // 3. emails
  let emails = []; let mailNote = "";
  if (w.emails) {
    step("Searching projects@ for the project's emails…");
    const r = await gatherEmails(quote, gmail);
    emails = r.emails; mailNote = r.note;
    if (mailNote && !emails.length) issues.push(`Emails: ${mailNote}`);
    emails.forEach((m, i) => add(`emails/${emailFileName(m, i)}`, emailText(m), `Email — ${m.subject || "(no subject)"}`));
  }

  // 4. drawings on the cards, mail attachments and Drive attachments (copied through the app's own bucket)
  if (w.drawings) {
    const drawings = items.flatMap((it) => (it.markups || []).map((m) => ({ it, m })));
    await pool(drawings, IN_FLIGHT, async ({ it, m }, i) => {
      step(`Fetching drawing ${i + 1} of ${drawings.length} — ${m.name}…`);
      try {
        const src = m.dataURL ? m.dataURL : deps.markupSrc ? deps.markupSrc(m) : "";
        if (!src) throw new Error("no source");
        const bytes = await fetchBytes(src, fetchImpl);
        add(`drawings/${safeName(it.label, "element")}/${safeName(m.name, "drawing")}`, bytes, `Drawing on "${it.label}"`, m.path || m.name);
      } catch (e) { issues.push(`Drawing "${m.name}" on ${it.label} could not be fetched (${e.message}).`); }
    });
  }
  if (w.files) {
    const att = allProjectFiles(quote);
    await pool(att, 3, async (f, i) => {
      step(`Fetching attached file ${i + 1} of ${att.length} — ${f.name}…`);
      try {
        let url = f.url || null;
        if (!url && f.provider === "drive" && deps.drive) { const c = await deps.drive({ action: "copy", fileId: f.fileId, target: "preview" }); url = c && (c.url || (c.file && c.file.url)); }
        if (!url) throw new Error(f.provider === "drive" ? "Drive is not connected — the file is linked in the manual" : "no url");
        const bytes = await fetchBytes(url, fetchImpl, 120000);
        add(`files/${safeName(f.name, "file")}`, bytes, `${f.provider === "mail" ? "Attachment of the tender email" : "Google Drive file attached to the project"}`);
      } catch (e) { issues.push(`File "${f.name}" could not be fetched (${e.message}).`); }
    });
  }

  // 5. the version list (names only — the copies stay in the cloud)
  let versions = [];
  if (w.versions && deps.listVersions) {
    step("Listing the saved versions…");
    try { versions = await deps.listVersions(project.id); add("versions.json", JSON.stringify(versions, null, 2), "The saved versions on record (names, dates, sizes — the copies stay in the cloud)"); }
    catch (e) { issues.push(`The version list could not be read: ${e.message}`); }
  }

  // 6. the manual, first in the folder
  step("Writing the reference manual…");
  const manual = manualHtml({ quote, items, rates, elementTypes, takeoff, emails, versions, bundle: { name: folder, at: at.toISOString(), by: deps.by || "", files: [{ name: "README.html", what: "This reference manual" }, ...manifest], issues, mailNote, takeoffNote } });
  files.unshift({ name: `${folder}/README.html`, data: manual, modified: at });
  step("Packing the zip…");
  const bytes = zipStore(files, at);
  return { bytes, name: `${folder}.zip`, report: { files: manifest, issues, counts: { emails: emails.length, files: files.length, takeoff: takeoff ? takeoff.instances.length : 0, versions: versions.length } } };
}

/** Hand a zip to the browser: the Save-as dialog where it is offered, else a plain download (the same two-window dance as quoteVersions). */
export async function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/zip" });
  const windows = [];
  try { if (window.top && window.top !== window) windows.push(window.top); } catch { /* cross-origin */ }
  windows.push(window);
  const activated = typeof navigator !== "undefined" && navigator.userActivation ? navigator.userActivation.isActive === true : true;
  for (const wnd of activated ? windows : []) {
    if (typeof wnd.showSaveFilePicker !== "function") continue;
    try {
      const handle = await wnd.showSaveFilePicker({ suggestedName: filename, types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }] });
      const writable = await handle.createWritable(); await writable.write(blob); await writable.close();
      return "picker";
    } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  for (const wnd of windows) {
    try {
      const d = wnd.document; const url = wnd.URL.createObjectURL(blob);
      const a = d.createElement("a"); a.href = url; a.download = filename; a.style.display = "none"; d.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => wnd.URL.revokeObjectURL(url), 10000);
      return "download";
    } catch { /* next window */ }
  }
  throw new Error("The browser refused the download.");
}
