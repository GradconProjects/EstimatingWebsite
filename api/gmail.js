/**
 * Reads the connected Google mailbox for the portal (AI Engine → Mail, the chat).
 * POST {action:"list", q?, max?, pageToken?}   → the newest messages matching q (headers, snippet, attachment names)
 * POST {action:"read", id}                      → one message with its text body and attachments
 * POST {action:"attachment", id, attachmentId, filename, jobId?}
 *                                               → copies a PDF attachment into the gradcon-files bucket under
 *                                                  ai-engine/mail/<messageId>/ and returns its public URL, so an
 *                                                  AI Engine job can read it like an uploaded file
 * POST {action:"send", to, toName?, subject, text, fromName?, attachments?: [{name, url}]}
 *                                               → sends ONE plain-text message to ONE address from the connected
 *                                                  mailbox (gmail.send — 409 needsReconnect until the connection
 *                                                  carries it). The portal shows every draft for approval first;
 *                                                  this function never composes anything itself.
 * Reading is gmail.readonly; sending is the one write, and only on request. Same-origin check as the other functions.
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
    if (action === "send") {
      const conn = await Gm.readConnection(fetchImpl);
      if (!Gm.hasSendScope(conn)) return { status: 409, body: { error: "The Google connection cannot send yet — reconnect it under Settings → Google mail & Drive to allow sending (gmail.send).", needsReconnect: true } };
      const to = String(body.to || "").trim(); const subject = String(body.subject || "").trim(); const text = String(body.text || "");
      if (!Gm.isOneAddress(to)) return { status: 400, body: { error: "to must be exactly one email address — every recipient gets their own message" } };
      if (!subject || subject.length > 250) return { status: 400, body: { error: "subject required (up to 250 characters)" } };
      if (!text.trim() || text.length > 40000) return { status: 400, body: { error: "text required (up to 40,000 characters)" } };
      const attachments = (Array.isArray(body.attachments) ? body.attachments : []).map((a) => ({ name: String((a && a.name) || ""), url: String((a && a.url) || "") }));
      if (attachments.length > Gm.ATTACH_MAX_FILES) return { status: 400, body: { error: `up to ${Gm.ATTACH_MAX_FILES} attachments per message` } };
      const sent = await Gm.sendMessage({ to, toName: String(body.toName || "").slice(0, 120), fromName: String(body.fromName || "Gradcon Concrete Constructions").slice(0, 120), subject, text, replyTo: tok.email, attachments }, tok.token, tok.email, fetchImpl);
      return { status: 200, body: { mailbox: tok.email, sent: { ...sent, to, subject, attachments: attachments.map((a) => a.name), at: new Date().toISOString() } } };
    }
    return { status: 400, body: { error: 'action must be "list", "read", "attachment" or "send"' } };
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
