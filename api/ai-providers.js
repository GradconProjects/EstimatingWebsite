/**
 * Vercel serverless function behind the portal's Settings → "AI providers"
 * panel. GET reports which providers have a key configured (never the key);
 * POST {provider, action:"test"} runs a one-word round trip on that provider.
 * The keys themselves live only in the Vercel Environment Variables and are
 * read by api/_providers.js — see that file for the variable names.
 *
 * The portal has no real sign-in (a client-side PIN), so this endpoint checks
 * that the call comes from the portal's own origin. That stops a drive-by page
 * elsewhere spending the keys; it is not a security boundary against someone
 * crafting requests by hand.
 */
import { providerStatus, defaultProviderId, pingProvider } from "./_providers.js";

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null; // no origin header: a direct call, not a browser page
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

export default async function handler(req, res) {
  const own = fromOwnOrigin(req);
  if (own === false) { res.status(403).json({ error: "This endpoint serves the Gradcon portal only." }); return; }
  if (req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    res.status(200).json({ providers: providerStatus(), defaultProvider: defaultProviderId() });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "GET or POST only" }); return; }
  if (own === null) { res.status(403).json({ error: "Tests run from the portal's Settings panel only." }); return; }
  const { provider, action } = req.body || {};
  if (action !== "test") { res.status(400).json({ error: 'Body must be {provider, action: "test"}' }); return; }
  const st = providerStatus().find((p) => p.id === provider);
  if (!st) { res.status(400).json({ error: `Unknown provider "${provider}"` }); return; }
  if (!st.configured) { res.status(503).json({ ok: false, provider, error: `${st.label} is not configured — set ${st.keyVar} in the Vercel project's Environment Variables (server-side, no VITE_ prefix), then redeploy.` }); return; }
  try {
    const r = await pingProvider(provider);
    res.status(200).json({ ok: r.ok, provider, model: r.model, latencyMs: r.latencyMs, reply: r.text.slice(0, 80) });
  } catch (e) {
    res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 502).json({ ok: false, provider, model: st.model, error: e.message, detail: e.detail || null });
  }
}
