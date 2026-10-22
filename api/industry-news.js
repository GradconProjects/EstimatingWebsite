/**
 * GET /api/industry-news → the dashboard's "Industry updates" rail (see
 * api/_news.js for the sources). Read-only, no key. One copy is kept in this
 * function instance for 30 minutes (NEWS_TTL_MS) so a busy morning does not
 * hammer the feeds; the browser keeps its own 30-minute copy as well.
 */
import { fetchNews, NEWS_SOURCES } from "./_news.js";

export const NEWS_TTL_MS = 30 * 60 * 1000;
let cache = null; // {at, body}

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }
  if (fromOwnOrigin(req) === false) { res.status(403).json({ error: "This endpoint serves the Gradcon portal only." }); return; }
  const fresh = cache && Date.now() - cache.at < NEWS_TTL_MS && !("refresh" in (req.query || {}));
  if (!fresh) {
    try {
      const body = await fetchNews(NEWS_SOURCES, fetch, { now: new Date() });
      if (body.items.length || !cache) cache = { at: Date.now(), body };   // a run that found nothing never replaces a good copy
    } catch (e) {
      if (!cache) { res.status(502).json({ error: "Could not read the industry feeds: " + String(e && e.message || e) }); return; }
    }
  }
  res.setHeader("cache-control", "public, max-age=600");
  res.status(200).json({ ...cache.body, cached: fresh });
}
