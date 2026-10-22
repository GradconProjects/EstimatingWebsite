/**
 * Google Drive project files on the Quotes side (Grady, 21 Oct 2026: "i want
 * that folder accessible to grady … inside the app and should sync across
 * everywhere"). The server (api/drive.js) reads the office's project files
 * folder through the projects@ connection; this module is the browser's
 * client and the pure helpers for what a project remembers:
 *   quote.storageFolders.drive = {id, name, webViewLink, chosenAt}  the project's own folder
 *   quote.files[]            = {id, provider:"drive", fileId, name, kind, mimeType, size,
 *                               modifiedTime, webViewLink, attachedAt}   attached links
 * Both live on the quote, so they sync with it. Attachments are LINKS; a
 * file is copied into the app's own store only the moment it is used (a
 * markup, an AI Engine job) — api/drive.js action "copy".
 */
import { uid } from "./costing.js";

export const DRIVE_FILE_KINDS = ["pdf", "image", "doc", "sheet", "slides", "cad", "other"];
export const PREVIEWABLE = new Set(["pdf", "image", "doc", "sheet", "slides"]);

export function driveApiUrl() {
  return `${typeof window !== "undefined" && window.location ? window.location.origin : ""}/api/drive`;
}
/** POST one action to the Drive function; throws an Error carrying `status` and `needsReconnect`. */
export async function driveApi(body, fetchImpl = typeof fetch === "function" ? fetch : null) {
  const r = await fetchImpl(driveApiUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || `Drive request failed (${r.status})`); e.status = r.status; e.needsReconnect = !!d.needsReconnect; throw e; }
  return d;
}
export async function driveStatus(fetchImpl = typeof fetch === "function" ? fetch : null) {
  const r = await fetchImpl(`${driveApiUrl()}?action=status`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

export const projectDriveFolder = (quote) => (quote && quote.storageFolders && quote.storageFolders.drive) || null;
export function setProjectDriveFolderPatch(quote, folder, at = new Date().toISOString()) {
  const prev = (quote && quote.storageFolders) || {};
  return { storageFolders: { ...prev, drive: folder ? { id: folder.id, name: folder.name, webViewLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`, chosenAt: at } : null } };
}
export const projectFiles = (quote) => (quote && Array.isArray(quote.files) ? quote.files : []);
export const driveFiles = (quote) => projectFiles(quote).filter((f) => f && f.provider === "drive");
export const isAttached = (quote, fileId) => driveFiles(quote).some((f) => f.fileId === fileId);
/** Attach a Drive file as a link (idempotent by Drive id). */
export function attachFilePatch(quote, file, at = new Date().toISOString()) {
  if (!file || !file.id || isAttached(quote, file.id)) return {};
  const entry = { id: uid(), provider: "drive", fileId: file.id, name: file.name, kind: file.kind, mimeType: file.mimeType, size: file.size, modifiedTime: file.modifiedTime, webViewLink: file.webViewLink, attachedAt: at };
  return { files: [...projectFiles(quote), entry] };
}
export function detachFilePatch(quote, id) {
  return { files: projectFiles(quote).filter((f) => f.id !== id) };
}
/** The address a project's folder is matched on — whichever field the quote carries. */
export const projectAddress = (quote) => String((quote && (quote.siteAddress || quote.address || quote.site || quote.location)) || "");
export const fileIcon = (kind) => ({ folder: "📁", pdf: "📕", image: "🖼️", doc: "📝", sheet: "📊", slides: "📽️", cad: "📐" })[kind] || "📄";
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return "";
  const b = Number(n);
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
}
export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
