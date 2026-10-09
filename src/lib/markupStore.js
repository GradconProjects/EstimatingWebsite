/**
 * Markup drawings live in the `gradcon-files` bucket, not in the quote row.
 *
 * 9 Oct 2026: a nine-element project carried 17 drawings as inline data
 * URLs — 7.46 MB of a 7.48 MB row — and every keystroke re-uploaded the
 * lot through the 500 ms debounce in storage.js. Saves queued behind each
 * other, timed out and the editor showed "Your changes are not reaching the
 * cloud" for minutes at a time. Nothing about a quote needs the pixels in
 * the row: the row needs to know WHICH drawing sits on the element.
 *
 * A markup is `{id, name, type, rotation, path}` once it is in the bucket
 * (`quote-markups/<projectId>/<markupId>.<png|jpg|pdf>`, public URL like the
 * Vault's files). `dataURL` is only the in-flight form — just dropped onto
 * the card in this tab, or an install with no Supabase at all, which keeps
 * the data inline in localStorage as it always did. `offloadMarkups` is the
 * ONE uploader (the editor runs it as soon as the row has settled and again
 * whenever a markup with a data URL appears); `applyOffload` drops the data
 * URL only where the markup still holds the bytes that were uploaded, so a
 * drawing replaced mid-upload is never lost. Nothing ever deletes a bucket
 * object: versions, "Save to computer" files and duplicated elements all
 * keep pointing at the same path.
 *
 * `markupSrc(m)` is the ONE reading every <img>/<embed> uses (the card, the
 * lightbox, the print report); `markupDataURL(m)` fetches the bytes back for
 * the PDF-to-images converter.
 */
import { supabase, supabaseEnabled } from "./supabaseClient.js";

export const MARKUP_BUCKET = "gradcon-files";
export const markupFolder = (projectId) => `quote-markups/${projectId}`;

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "application/pdf": "pdf" };

/** The src for an <img>/<embed>: the in-flight data URL, else the bucket's public URL, else "". */
export function markupSrc(m, client = supabase) {
  if (!m) return "";
  if (m.dataURL) return m.dataURL;
  if (m.path && client) {
    const r = client.storage.from(MARKUP_BUCKET).getPublicUrl(m.path);
    return (r && r.data && r.data.publicUrl) || "";
  }
  return "";
}

/** True while any markup on any element still carries its bytes inline. */
export function needsOffload(quote) {
  return !!(quote && Array.isArray(quote.items) && quote.items.some((it) => it && Array.isArray(it.markups) && it.markups.some((m) => m && typeof m.dataURL === "string" && m.dataURL.length > 0)));
}

/** data:<mime>;base64,<...> → { blob, mime, ext }. Throws on anything else. */
export function dataUrlToBlob(dataURL) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataURL || ""));
  if (!m || !m[2]) throw new Error("not a base64 data URL");
  const mime = m[1] || "application/octet-stream";
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), mime, ext: EXT[mime] || "bin" };
}

/** Upload one markup's bytes; returns its bucket path. */
export async function uploadMarkupData(projectId, m, client = supabase) {
  if (!client) throw new Error("no storage client");
  const { blob, mime, ext } = dataUrlToBlob(m.dataURL);
  const path = `${markupFolder(projectId)}/${m.id}.${ext}`;
  const { error } = await client.storage.from(MARKUP_BUCKET).upload(path, blob, { upsert: true, contentType: mime });
  if (error) throw error;
  return path;
}

/**
 * Upload every inline markup of the quote. Never throws for one bad file:
 * returns { uploaded: [{itemId, markupId, dataURL, path}], failed: [{itemId,
 * markupId, error}] }. `skip` is a Set of markup ids to leave alone (the
 * editor's retry back-off).
 */
export async function offloadMarkups(quote, projectId, client = supabase, { skip } = {}) {
  const uploaded = [], failed = [];
  if (!client || !quote || !Array.isArray(quote.items)) return { uploaded, failed };
  for (const it of quote.items) {
    if (!it || !Array.isArray(it.markups)) continue;
    for (const m of it.markups) {
      if (!m || typeof m.dataURL !== "string" || !m.dataURL) continue;
      if (skip && skip.has(m.id)) continue;
      try {
        const path = await uploadMarkupData(projectId, m, client);
        uploaded.push({ itemId: it.id, markupId: m.id, dataURL: m.dataURL, path });
      } catch (error) {
        failed.push({ itemId: it.id, markupId: m.id, error });
      }
    }
  }
  return { uploaded, failed };
}

/** Drop the data URL and record the path — only where the markup still holds the bytes that went up. */
export function applyOffload(quote, uploaded) {
  if (!quote || !uploaded || !uploaded.length) return quote;
  const byMarkup = new Map(uploaded.map((u) => [u.markupId, u]));
  let changed = false;
  const items = (quote.items || []).map((it) => {
    if (!it || !Array.isArray(it.markups)) return it;
    let touched = false;
    const markups = it.markups.map((m) => {
      const u = m && byMarkup.get(m.id);
      if (!u || m.dataURL !== u.dataURL) return m;
      touched = true;
      const { dataURL, ...rest } = m;
      return { ...rest, path: u.path };
    });
    if (!touched) return it;
    changed = true;
    return { ...it, markups };
  });
  return changed ? { ...quote, items } : quote;
}

/** The markup's bytes as a data URL — inline, or fetched back from the bucket (for the PDF converter). */
export async function markupDataURL(m, client = supabase) {
  if (!m) throw new Error("no markup");
  if (m.dataURL) return m.dataURL;
  const url = markupSrc(m, client);
  if (!url) throw new Error("markup has no source");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
}

export { supabaseEnabled as markupStoreEnabled };
