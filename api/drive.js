/**
 * Google Drive for the portal — the office's project files folder, read-only,
 * through the projects@ connection (api/_google.js holds the credentials and
 * the ONE Drive adapter). Grady, 21 Oct 2026: "i want that folder accessible
 * to grady … inside the app and should sync across everywhere".
 *
 *   GET  ?action=status                → {configured, connected, drive, email, root:{id,name,webViewLink}|null, defaultRootId}
 *   POST {action:"roots"}              → the top-level folders projects@ can see (My Drive + shared drives), for Settings
 *   POST {action:"setRoot", id|link}   → point the app at another folder (stored in the shared gradcon-storage row)
 *   POST {action:"folder", id?}        → one folder with its path back to the root (default: the root)
 *   POST {action:"list", folderId?, pageToken?} → its children, folders first
 *   POST {action:"search", text, within?}       → name + full-text search kept UNDER the root (or a folder beneath it)
 *   POST {action:"match", projectName, address?} → the root's child folders ranked for a project, `best` when one clearly fits
 *   POST {action:"file", id}           → one file's details
 *   POST {action:"copy", id, target:"preview"|"job"|"markup", jobId?}
 *                                      → copies the file into the gradcon-files bucket (a Doc / Sheet as PDF) and returns
 *                                        its public URL — preview copies are cached by content, a job copy lands under
 *                                        ai-engine/<jobId>/ like a mail attachment. Nothing on Drive is ever written.
 * Every id must sit under the root (403 otherwise). Same-origin check as the other functions.
 */
import * as Gm from "./_google.js";

export const config = { maxDuration: 60 };
const SUPABASE_URL = "https://xbmyhvrcuyapoarmchpv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kr4dTFXhZsifAA28HmMAVQ_EDSR2DL0";
const BUCKET = "gradcon-files";

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}
const safeName = (n) => String(n || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
const safeId = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "");

/** The root folder the app reads under: the stored choice, else the default. */
export async function rootConfig(fetchImpl = fetch) {
  const row = await Gm.readRow(Gm.STORAGE_ROW_KEY, fetchImpl);
  const d = row && row.drive;
  return { rootId: (d && d.rootId) || Gm.DEFAULT_DRIVE_ROOT_ID, rootName: (d && d.rootName) || null, chosenAt: (d && d.chosenAt) || null, isDefault: !(d && d.rootId) };
}

export async function runDrive(body, env = process.env, fetchImpl = fetch) {
  const { action } = body || {};
  if (!Gm.googleConfigured(env)) return { status: 503, body: { error: "Google is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Vercel project's Environment Variables." } };
  const conn = await Gm.readConnection(fetchImpl);
  const root = await rootConfig(fetchImpl);
  if (action === "status") {
    const st = Gm.connectionStatus(conn, env);
    let rootInfo = null;
    if (st.connected && st.drive) {
      try { const tok = await Gm.accessToken(env, fetchImpl); const f = await Gm.driveFile(root.rootId, tok.token, fetchImpl); rootInfo = { id: f.id, name: f.name, webViewLink: f.webViewLink, isDefault: root.isDefault }; }
      catch (e) { rootInfo = { id: root.rootId, name: root.rootName, webViewLink: `https://drive.google.com/drive/folders/${root.rootId}`, isDefault: root.isDefault, error: e.message }; }
    }
    return { status: 200, body: { ...st, root: rootInfo, defaultRootId: Gm.DEFAULT_DRIVE_ROOT_ID } };
  }
  if (!conn || !conn.refresh) return { status: 409, body: { error: "No Google account is connected — connect projects@ under Settings → Google mail & Drive." } };
  if (!Gm.hasDriveScope(conn)) return { status: 409, body: { error: "The Google connection has no Drive access yet — reconnect it under Settings → Google mail & Drive to grant Drive (read-only).", needsReconnect: true } };
  let tok;
  try { tok = await Gm.accessToken(env, fetchImpl); } catch (e) { return { status: e.status || 502, body: { error: e.message } }; }
  const token = tok.token, cache = new Map();
  const guard = async (id) => { if (!(await Gm.withinRoot(id, root.rootId, token, fetchImpl, cache))) { const e = new Error("That item is outside the project files folder the app may read."); e.status = 403; throw e; } };
  try {
    if (action === "roots") {
      const mine = await Gm.driveChildren("root", token, fetchImpl, { foldersOnly: true, max: 200 });
      let drives = [];
      try { const d = await Gm.driveGet("/drives?pageSize=100&fields=drives(id,name)", token, fetchImpl); drives = (d.drives || []).map((x) => ({ id: x.id, name: x.name, kind: "folder", shared: true, webViewLink: `https://drive.google.com/drive/folders/${x.id}` })); } catch { /* no shared drives, or no access */ }
      return { status: 200, body: { folders: [...mine.files, ...drives], current: root } };
    }
    if (action === "setRoot") {
      const id = Gm.driveFolderIdFrom(body.id || body.link);
      if (!id) return { status: 400, body: { error: "a folder id or a Drive folder link is needed" } };
      const f = await Gm.driveFile(id, token, fetchImpl);
      if (f.kind !== "folder") return { status: 400, body: { error: `"${f.name}" is a file, not a folder` } };
      const prev = (await Gm.readRow(Gm.STORAGE_ROW_KEY, fetchImpl)) || {};
      await Gm.writeRow(Gm.STORAGE_ROW_KEY, { ...prev, drive: { rootId: f.id, rootName: f.name, chosenAt: new Date().toISOString() } }, fetchImpl);
      return { status: 200, body: { root: { id: f.id, name: f.name, webViewLink: f.webViewLink, isDefault: false } } };
    }
    if (action === "folder") {
      const id = body.id ? safeId(body.id) : root.rootId;
      await guard(id);
      const f = await Gm.driveFile(id, token, fetchImpl);
      const anc = id === root.rootId ? [] : await Gm.driveAncestors(id, token, fetchImpl, cache);
      const upto = []; for (const a of anc) { upto.push(a); if (a.id === root.rootId) break; }
      return { status: 200, body: { folder: f, path: upto.reverse(), rootId: root.rootId } };
    }
    if (action === "list") {
      const id = body.folderId ? safeId(body.folderId) : root.rootId;
      await guard(id);
      const r = await Gm.driveChildren(id, token, fetchImpl, { pageToken: body.pageToken || "", max: Number(body.max) || 200 });
      return { status: 200, body: { folderId: id, rootId: root.rootId, ...r } };
    }
    if (action === "search") {
      const within = body.within ? safeId(body.within) : root.rootId;
      await guard(within);
      const r = await Gm.driveSearch({ text: body.text, within, max: Number(body.max) || 40 }, token, fetchImpl, cache);
      return { status: 200, body: { within, rootId: root.rootId, ...r } };
    }
    if (action === "match") {
      const r = await Gm.driveChildren(root.rootId, token, fetchImpl, { foldersOnly: true, max: 500 });
      const m = Gm.matchProjectFolder(r.files, { projectName: body.projectName, address: body.address });
      return { status: 200, body: { rootId: root.rootId, ...m } };
    }
    if (action === "file") {
      const id = safeId(body.id); if (!id) return { status: 400, body: { error: "id required" } };
      await guard(id);
      return { status: 200, body: { file: await Gm.driveFile(id, token, fetchImpl) } };
    }
    if (action === "copy") {
      const id = safeId(body.id); if (!id) return { status: 400, body: { error: "id required" } };
      await guard(id);
      const target = body.target === "job" ? "job" : body.target === "markup" ? "markup" : "preview";
      if (target === "job" && !safeId(body.jobId)) return { status: 400, body: { error: "jobId required for a job copy" } };
      const dl = await Gm.driveDownload(id, token, fetchImpl);
      const name = safeName(dl.name);
      const stamp = safeId(dl.meta.md5 || (dl.meta.modifiedTime || "").replace(/[^0-9]/g, "")) || "v";
      const path = target === "job" ? `ai-engine/${safeId(body.jobId)}/${name}` : `drive/${id}/${stamp}/${name}`;
      const up = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": dl.mimeType, "x-upsert": "true" }, body: dl.bytes, signal: AbortSignal.timeout(50000) });
      if (!up.ok) return { status: 502, body: { error: `could not store the copy (${up.status})` } };
      return { status: 200, body: { file: { name, size: dl.bytes.length, mimeType: dl.mimeType, kind: Gm.fileKind(dl.mimeType, name), path, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, uploadedAt: new Date().toISOString(), fromDrive: { id: dl.meta.id, name: dl.meta.name, webViewLink: dl.meta.webViewLink, modifiedTime: dl.meta.modifiedTime, md5: dl.meta.md5 } } } };
    }
    return { status: 400, body: { error: "unknown action" } };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message } };
  }
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.searchParams.get("action") === "status") { const out = await runDrive({ action: "status" }); res.status(out.status).json(out.body); return; }
  if (fromOwnOrigin(req) !== true) { res.status(403).json({ error: "The portal only." }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const out = await runDrive(req.body || {});
  res.status(out.status).json(out.body);
}
