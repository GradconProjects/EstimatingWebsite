/**
 * Reads the connected Google mailbox for the portal (AI Engine → Mail, the chat).
 * POST {action:"list", q?, max?, pageToken?}   → the newest messages matching q (headers, snippet, attachment names)
 * POST {action:"read", id}                      → one message with its text body and attachments
 * POST {action:"attachment", id, attachmentId, filename, jobId?}
 *                                               → copies a PDF attachment into the gradcon-files bucket under
 *                                                  ai-engine/mail/<messageId>/ and returns its public URL, so an
 *                                                  AI Engine job can read it like an uploaded file
 * Read-only against Gmail (gmail.readonly). Same-origin check as the other functions.
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
const safeName = (n) => String(n || "attachment.pdf").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

export async function runGmail(body, env = process.env, fetchImpl = fetch) {
  const { action } = body || {};
  if (!Gm.googleConfigured(env)) return { status: 503, body: { error: "Google is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Vercel project's Environment Variables." } };
  let tok;
  try { tok = await Gm.accessToken(env, fetchImpl); } catch (e) { return { status: e.status || 502, body: { error: e.message } }; }
  try {
    if (action === "list") {
      const q = String(body.q || "").slice(0, 300); const max = Number(body.max) || 25;
      const r = await Gm.listMessages({ q, max, pageToken: body.pageToken || "" }, tok.token, fetchImpl);
      return { status: 200, body: { mailbox: tok.email, ...r } };
    }
    if (action === "read") {
      if (!body.id) return { status: 400, body: { error: "id required" } };
      return { status: 200, body: { mailbox: tok.email, message: await Gm.readMessage(String(body.id), tok.token, fetchImpl) } };
    }
    if (action === "attachment") {
      if (!body.id || !body.attachmentId) return { status: 400, body: { error: "id and attachmentId required" } };
      const name = safeName(body.filename);
      if (!/\.pdf$/i.test(name)) return { status: 400, body: { error: "PDF attachments only for now" } };
      const bytes = await Gm.attachmentBytes(String(body.id), String(body.attachmentId), tok.token, fetchImpl);
      if (bytes.length > 30 * 1024 * 1024) return { status: 413, body: { error: "attachment over 30 MB" } };
      const path = `ai-engine/mail/${String(body.id).replace(/[^A-Za-z0-9_-]/g, "")}/${name}`;
      const up = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/pdf", "x-upsert": "true" }, body: bytes, signal: AbortSignal.timeout(60000) });
      if (!up.ok) return { status: 502, body: { error: `could not store the attachment (${up.status})` } };
      return { status: 200, body: { file: { name, size: bytes.length, path, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, uploadedAt: new Date().toISOString(), fromMail: { id: String(body.id), attachmentId: String(body.attachmentId) } } } };
    }
    return { status: 400, body: { error: 'action must be "list", "read" or "attachment"' } };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message } };
  }
}

export default async function handler(req, res) {
  if (fromOwnOrigin(req) !== true) { res.status(403).json({ error: "The portal only." }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const out = await runGmail(req.body || {});
  res.setHeader("cache-control", "no-store");
  res.status(out.status).json(out.body);
}
