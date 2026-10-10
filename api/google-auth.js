/**
 * Google mailbox connection for the portal (Settings → Google mail).
 *   GET  ?action=status      → {configured, connected, email, connectedAt, mailbox}
 *   GET  ?action=start       → redirects the browser to Google's consent screen
 *   GET  ?code=…&state=…     → the OAuth callback: exchanges the code, stores the
 *                              encrypted refresh token, redirects to /?google=connected
 *   POST {action:"disconnect"} → revokes and forgets the token
 * Only the allowed mailbox (projects@gradcon.com.au unless GOOGLE_ALLOWED_MAILBOX
 * says otherwise) may be connected; any other Google account is refused.
 * Credentials and tokens are handled in api/_google.js only.
 */
import * as Gm from "./_google.js";

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}
const back = (res, q) => { res.statusCode = 302; res.setHeader("location", `/?google=${encodeURIComponent(q)}`); res.end(); };

export default async function handler(req, res) {
  const env = process.env;
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const action = url.searchParams.get("action");
  if (req.method === "GET" && action === "status") {
    res.setHeader("cache-control", "no-store");
    res.status(200).json(Gm.connectionStatus(await Gm.readConnection(), env));
    return;
  }
  if (req.method === "GET" && action === "start") {
    if (!Gm.googleConfigured(env)) { res.status(503).send("Google is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Vercel project's Environment Variables."); return; }
    res.statusCode = 302; res.setHeader("location", Gm.consentUrl(Gm.redirectUri(req, env), env)); res.end();
    return;
  }
  if (req.method === "GET" && (url.searchParams.get("code") || url.searchParams.get("error"))) {
    if (url.searchParams.get("error")) { back(res, "error:" + url.searchParams.get("error")); return; }
    if (!Gm.verifyState(url.searchParams.get("state"), env)) { back(res, "error:state"); return; }
    try {
      const tokens = await Gm.exchangeCode(url.searchParams.get("code"), Gm.redirectUri(req, env), env);
      const email = await Gm.whoAmI(tokens.access_token);
      if (email !== Gm.allowedMailbox(env)) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token || tokens.access_token)}`, { method: "POST" }); } catch {} back(res, "error:wrong-account:" + email); return; }
      if (!tokens.refresh_token) { back(res, "error:no-refresh-token"); return; }
      await Gm.writeConnection({ email, refresh: Gm.encryptText(tokens.refresh_token, env), scope: tokens.scope || Gm.GMAIL_SCOPE, connectedAt: new Date().toISOString() });
      Gm.resetTokenCache();
      back(res, "connected");
    } catch (e) { back(res, "error:" + String(e.message || e).slice(0, 120)); }
    return;
  }
  if (req.method === "POST") {
    if (fromOwnOrigin(req) !== true) { res.status(403).json({ error: "The portal only." }); return; }
    const body = req.body || {};
    if (body.action === "disconnect") { await Gm.revoke(env); res.status(200).json({ ok: true, connected: false }); return; }
    res.status(400).json({ error: 'POST body must be {action: "disconnect"}' }); return;
  }
  res.status(400).json({ error: "Unknown request" });
}
