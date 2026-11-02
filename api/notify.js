/**
 * Notifications to Grady from the tender checklist (Grady, 2 Nov 2026: "when i
 * click inform grady from the checklist, it automatically sends to him").
 *   GET            → {sms: {configured, provider, to (masked), missing}}
 *   POST {action: "sms", text}  → one text to GRADY_MOBILE through api/_sms.js
 * The recipient is fixed server-side; the browser sends only the text a person
 * approved on the checklist. Same-origin check as the other functions.
 */
import { smsStatus, sendSms } from "./_sms.js";

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
  return { status: 400, body: { error: 'Body must carry action "sms" or "status"' } };
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
