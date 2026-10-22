/**
 * Industry updates for the portal dashboard (Grady, 23 Oct 2026: "give
 * construction related updates on the side especially from the VBA and recent
 * updates and some business related specification snippets").
 *
 * Pure: no key, no secret, nothing written. Every item is a REAL published
 * article from a real feed — nothing here is composed. The VBA's own site sits
 * behind a Cloudflare challenge that refuses server fetches (checked 23 Oct
 * 2026: HTTP 403 "cf-mitigated: challenge"), so the regulator's news comes
 * through Google News RSS searches, which return the outlets' own articles
 * (ABC, AFR, the trade press, law firms) with the outlet named on each item;
 * the NCC / ABCB, standards and specification, business and WorkSafe groups
 * come the same way, and CCAA's own RSS feed is read directly. `parseFeed`
 * reads RSS 2.0 and Atom (CDATA titles, <source> outlets, Google News'
 * "Title - Outlet" suffix); `mergeNews` dedupes by title, drops anything older
 * than `maxAgeDays`, sorts newest first and caps the list; `fetchNews` runs
 * every source with a per-source timeout and reports each one's ok / count,
 * so one dead feed never empties the panel.
 */
export const GNEWS = (q) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-AU&gl=AU&ceid=AU:en";

export const NEWS_SOURCES = [
  { id: "vba", label: "VBA / BPC", kind: "gnews", url: GNEWS('"Victorian Building Authority" OR "Building and Plumbing Commission"') },
  { id: "ncc", label: "NCC / ABCB", kind: "gnews", url: GNEWS('"National Construction Code" OR "Australian Building Codes Board"') },
  { id: "spec", label: "Standards & specs", kind: "gnews", url: GNEWS('concrete ("Standards Australia" OR "AS 3600" OR "AS 2870" OR "AS 3610" OR specification)') },
  { id: "business", label: "Industry & business", kind: "gnews", url: GNEWS('construction Victoria (builder OR contractor) (insolvency OR "security of payment" OR "building contracts" OR tender OR "Master Builders")') },
  { id: "worksafe", label: "WorkSafe", kind: "gnews", url: GNEWS('"WorkSafe Victoria" construction') },
  { id: "ccaa", label: "CCAA", kind: "rss", url: "https://www.ccaa.com.au/feed" },
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”", "#8211": "–", "#8212": "—", "#160": " " };
export function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] != null) return ENTITIES[k];
    if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return m;
  });
}
const unCdata = (s) => String(s == null ? "" : s).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
export const stripTags = (s) => decodeEntities(unCdata(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (block, name) => { const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(block); return m ? m[1] : ""; };
const attr = (block, name, a) => { const m = new RegExp("<" + name + "\\s[^>]*?" + a + "=[\"']([^\"']+)[\"']", "i").exec(block); return m ? m[1] : ""; };

/** One feed (RSS 2.0 or Atom) → [{title, outlet, link, at, snippet}]. */
export function parseFeed(xml) {
  const text = String(xml || "");
  const blocks = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let title = stripTags(tag(b, "title"));
    let outlet = stripTags(tag(b, "source"));
    if (!outlet) { const m = /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title); if (m) { title = m[1]; outlet = m[2]; } } // Google News: "Title - Outlet"
    else { const m = new RegExp("\\s+-\\s+" + outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$").exec(title); if (m) title = title.slice(0, m.index); }
    let link = stripTags(tag(b, "link")) || attr(b, "link", "href") || stripTags(tag(b, "guid"));
    const when = stripTags(tag(b, "pubDate")) || stripTags(tag(b, "updated")) || stripTags(tag(b, "published")) || stripTags(tag(b, "dc:date"));
    const d = when ? new Date(when) : null;
    const snippet = stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 220);
    return { title, outlet, link, at: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null, snippet: snippet && snippet !== title ? snippet : "" };
  }).filter((it) => it.title && it.link);
}

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Several sources' items → one list, newest first, deduped by title, capped. */
export function mergeNews(perSource, { now = new Date(), maxItems = 30, maxAgeDays = 120 } = {}) {
  const cutoff = +now - maxAgeDays * 864e5;
  const seen = new Set(); const out = [];
  perSource.forEach(({ source, items }) => {
    (items || []).forEach((it) => {
      const k = normTitle(it.title); if (!k || seen.has(k)) return;
      if (it.at && +new Date(it.at) < cutoff) return;
      seen.add(k);
      out.push({ id: source.id + ":" + k.slice(0, 48).replace(/\s+/g, "-"), source: source.id, sourceLabel: source.label, outlet: it.outlet || "", title: it.title, link: it.link, at: it.at, snippet: it.snippet || "" });
    });
  });
  out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return out.slice(0, maxItems);
}

/** Fetch every source (fetchImpl is the test seam) → {items, sources: [{id, label, ok, count, error}], fetchedAt}. */
export async function fetchNews(sources = NEWS_SOURCES, fetchImpl = globalThis.fetch, { now = new Date(), timeoutMs = 8000, maxItems = 30, maxAgeDays = 120 } = {}) {
  const results = await Promise.all(sources.map(async (source) => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(source.url, { signal: ctrl ? ctrl.signal : undefined, headers: { "user-agent": "Mozilla/5.0 (GradconPortal industry updates)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } });
      if (!r.ok) return { source, ok: false, items: [], error: "HTTP " + r.status };
      const items = parseFeed(await r.text());
      return { source, ok: true, items, error: null };
    } catch (e) {
      return { source, ok: false, items: [], error: String(e && e.message || e).slice(0, 120) };
    } finally { if (timer) clearTimeout(timer); }
  }));
  const items = mergeNews(results, { now, maxItems, maxAgeDays });
  return { items, sources: results.map((r) => ({ id: r.source.id, label: r.source.label, ok: r.ok, count: r.items.length, error: r.error })), fetchedAt: now.toISOString() };
}
