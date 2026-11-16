/**
 * Notifications to Grady from the tender checklist (Grady, 2 Nov 2026: "when i
 * click inform grady from the checklist, it automatically sends to him").
 *   GET            → {sms: {configured, provider, to (masked), missing}}
 *   POST {action: "sms", text}  → one text to GRADY_MOBILE through api/_sms.js
 *   POST {action: "sms-copy", text} → one text to the SMS_COPY_TO numbers ONLY — never Grady (Boma, 16 Nov 2026:
 *                                     "fire one sms to me now"; the way to test the copy number on its own)
 * The recipient is fixed server-side; the browser sends only the text a person
 * approved on the checklist. Same-origin check as the other functions.
 */
import { smsStatus, sendSms, sendSmsByRole } from "./_sms.js";

export const config = { maxDuration: 30 };

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

/** The handler's body, testable without a request: `runNotify(body, env, fetchImpl)` → `{status, body}`. */
export async function runNotify(body, env = process.env, fetchImpl = fetch) {
  const action = body && body.action;
  if (action === "status") return { status: 200, body: { sms: smsStatus(env) } };
  if (action === "sms") {
    const text = String((body && body.text) || "").trim();
    if (!text) return { status: 400, body: { error: 'sms needs text: "…"' } };
    try {
      const r = await sendSms(text, env, fetchImpl);
      return { status: 200, body: r };
    } catch (e) {
      return { status: e.status && e.status >= 400 && e.status < 600 ? e.status : 502, body: { error: e.message, detail: e.detail || null } };
    }
  }
  if (action === "sms-copy") { // the copy numbers alone: Grady is never texted on this path
    const text = String((body && body.text) || "").trim();
    if (!text) return { status: 400, body: { error: 'sms-copy needs text: "…"' } };
    if (text.length > 480) return { status: 400, body: { error: "The text is over 480 characters (three segments) — shorten it." } };
    const st = smsStatus(env);
    if (!st.configured) return { status: 503, body: { error: `SMS is not configured — set ${st.missing.join(" and ")} in the Vercel project's Environment Variables.` } };
    if (!st.copyTo || !st.copyTo.length) return { status: 400, body: { error: "No copy number is set — put it in SMS_COPY_TO in the Vercel project's Environment Variables." } };
    const sent = (await sendSmsByRole([{ role: "copy", text }], env, fetchImpl)).map(({ to, ok, id, error }) => ({ to, ok, ...(ok ? { id } : { error }) }));
    return { status: sent.some((s) => s.ok) ? 200 : 502, body: { ok: sent.every((s) => s.ok), copies: sent } };
  }
  return { status: 400, body: { error: 'Body must carry action "sms", "sms-copy" or "status"' } };
}

export default async function handler(req, res) {
  const own = fromOwnOrigin(req);
  if (own === false) { res.status(403).json({ error: "This endpoint serves the Gradcon portal only." }); return; }
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") { res.status(200).json({ sms: smsStatus() }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "GET or POST only" }); return; }
  if (own === null) { res.status(403).json({ error: "Texts are sent from the portal only." }); return; }
  const r = await runNotify(req.body || {});
  res.status(r.status).json(r.body);
}
