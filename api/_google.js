/**
 * Google Workspace mail for the portal — the ONE place Google credentials are
 * handled. Server-side only (underscore file, never imported by src/ or
 * portal/). Grady, 10 Oct 2026: "can we connect a google account so it reads
 * the emails … in fact lets do it … projects@gradcon.com.au and i want it
 * read everything".
 *
 * Vercel Environment Variables (never VITE_-prefixed):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   the OAuth client (Web application)
 *                                              whose redirect URI is https://<host>/api/google-auth
 *   GOOGLE_TOKEN_SECRET                        optional; the key the stored refresh token is
 *                                              encrypted with (defaults to the client secret)
 *   GOOGLE_ALLOWED_MAILBOX                     optional; the only address allowed to connect
 *                                              (default projects@gradcon.com.au)
 *
 * The mailbox's refresh token is stored in estimator_kv under GOOGLE_ROW_KEY,
 * encrypted with AES-256-GCM under a key derived from GOOGLE_TOKEN_SECRET, so
 * the row is useless to anyone holding only the public anon key. Scope is
 * gmail.readonly: this code can read mail and attachments and nothing else.
 */
import crypto from "node:crypto";

export const GOOGLE_ROW_KEY = "gradcon-google-mail";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DEFAULT_MAILBOX = "projects@gradcon.com.au";
const SUPABASE_URL = "https://xbmyhvrcuyapoarmchpv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kr4dTFXhZsifAA28HmMAVQ_EDSR2DL0";

export function googleConfigured(env = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
export function allowedMailbox(env = process.env) {
  return String(env.GOOGLE_ALLOWED_MAILBOX || DEFAULT_MAILBOX).trim().toLowerCase();
}
function keyBytes(env) {
  const secret = env.GOOGLE_TOKEN_SECRET || env.GOOGLE_CLIENT_SECRET || "";
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return crypto.createHash("sha256").update(String(secret)).digest();
}
/** AES-256-GCM, output "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encryptText(plain, env = process.env) {
  const key = keyBytes(env); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function decryptText(blob, env = process.env) {
  const [v, iv, tag, enc] = String(blob || "").split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("unreadable token blob");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBytes(env), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}
/** The OAuth state: a timestamp signed with the secret, valid 10 minutes — no session store needed. */
export function signState(env = process.env, now = Date.now()) {
  const t = String(now);
  const mac = crypto.createHmac("sha256", keyBytes(env)).update(t).digest("base64url");
  return `${t}.${mac}`;
}
export function verifyState(state, env = process.env, now = Date.now()) {
  const [t, mac] = String(state || "").split(".");
  if (!t || !mac) return false;
  const want = crypto.createHmac("sha256", keyBytes(env)).update(t).digest("base64url");
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return false;
  return Math.abs(now - Number(t)) < 10 * 60000;
}
export function redirectUri(req, env = process.env) {
  if (env.GOOGLE_OAUTH_REDIRECT) return env.GOOGLE_OAUTH_REDIRECT;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${req.headers.host}/api/google-auth`;
}
export function consentUrl(redirect, env = process.env, now = Date.now()) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: `${GMAIL_SCOPE} openid email`,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: signState(env, now), login_hint: allowedMailbox(env),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/* ---------- the stored connection (estimator_kv row) ---------- */
export async function readConnection(fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(GOOGLE_ROW_KEY)}&select=value,updated_at`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null; const rows = await r.json(); return rows[0] && rows[0].value ? rows[0].value : null;
  } catch { return null; }
}
export async function writeConnection(value, fetchImpl = fetch) {
  const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv`, { method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: GOOGLE_ROW_KEY, value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`could not store the connection (${r.status})`);
}
export async function deleteConnection(fetchImpl = fetch) {
  await fetchImpl(`${SUPABASE_URL}/rest/v1/estimator_kv?key=eq.${encodeURIComponent(GOOGLE_ROW_KEY)}`, { method: "DELETE", headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) }).catch(() => {});
}
/** Safe to show in the browser: connected or not, which address, when — never a token. */
export function connectionStatus(conn, env = process.env) {
  return { configured: googleConfigured(env), connected: !!(conn && conn.refresh), email: conn ? conn.email || null : null, connectedAt: conn ? conn.connectedAt || null : null, mailbox: allowedMailbox(env), scope: GMAIL_SCOPE };
}

/* ---------- tokens ---------- */
export async function exchangeCode(code, redirect, env = process.env, fetchImpl = fetch) {
  const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" }), signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`Google did not issue tokens (${r.status}${data.error ? " " + data.error : ""})`);
  return data; // {access_token, refresh_token, expires_in, scope, id_token}
}
export async function whoAmI(accessToken, fetchImpl = fetch) {
  const r = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.emailAddress) throw new Error(`Gmail profile could not be read (${r.status})`);
  return String(d.emailAddress).toLowerCase();
}
let TOKEN_CACHE = { token: null, until: 0, refresh: null };
export function resetTokenCache() { TOKEN_CACHE = { token: null, until: 0, refresh: null }; }
/** A live access token for the stored connection: refreshed through Google when the cached one is near expiry. */
export async function accessToken(env = process.env, fetchImpl = fetch) {
  const conn = await readConnection(fetchImpl);
  if (!conn || !conn.refresh) { const e = new Error("No Google mailbox is connected — connect it under Settings → Google mail."); e.status = 409; throw e; }
  const refresh = decryptText(conn.refresh, env);
  if (TOKEN_CACHE.token && TOKEN_CACHE.refresh === refresh && Date.now() < TOKEN_CACHE.until) return { token: TOKEN_CACHE.token, email: conn.email };
  const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }), signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) { const e = new Error(`Google refused to refresh the mailbox token (${data.error || r.status}) — reconnect it under Settings → Google mail.`); e.status = 401; throw e; }
  TOKEN_CACHE = { token: data.access_token, until: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000, refresh };
  return { token: data.access_token, email: conn.email };
}
export async function revoke(env = process.env, fetchImpl = fetch) {
  const conn = await readConnection(fetchImpl);
  if (conn && conn.refresh) { try { const refresh = decryptText(conn.refresh, env); await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST", signal: AbortSignal.timeout(10000) }); } catch {} }
  await deleteConnection(fetchImpl); resetTokenCache();
}

/* ---------- Gmail reading ---------- */
const G = "https://gmail.googleapis.com/gmail/v1/users/me";
export async function gmailGet(path, token, fetchImpl = fetch) {
  const r = await fetchImpl(`${G}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Gmail ${r.status}${d.error && d.error.message ? ": " + d.error.message : ""}`); e.status = r.status === 401 ? 401 : 502; throw e; }
  return d;
}
const header = (msg, name) => { const h = ((msg.payload || {}).headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase()); return h ? h.value : ""; };
const b64 = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
export function stripHtml(html) {
  return String(html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** One Gmail message (format=full or metadata) → the plain shape the portal shows. The ONE reading of a message. */
export function parseMessage(msg) {
  const parts = []; const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(msg.payload);
  let text = "", html = "";
  parts.forEach((p) => { const mime = String(p.mimeType || ""); const data = p.body && p.body.data; if (!data || (p.filename && p.filename.length)) return; if (mime === "text/plain" && !text) text = b64(data); else if (mime === "text/html" && !html) html = b64(data); });
  const attachments = parts.filter((p) => p.filename && p.filename.length && p.body && (p.body.attachmentId || p.body.data)).map((p) => ({ attachmentId: p.body.attachmentId || null, filename: p.filename, mimeType: p.mimeType || "application/octet-stream", size: p.body.size || 0, isPdf: /\.pdf$/i.test(p.filename) || p.mimeType === "application/pdf" }));
  const dateMs = Number(msg.internalDate || 0);
  return { id: msg.id, threadId: msg.threadId, from: header(msg, "From"), to: header(msg, "To"), cc: header(msg, "Cc"), subject: header(msg, "Subject"), date: dateMs ? new Date(dateMs).toISOString() : header(msg, "Date"), snippet: msg.snippet || "", labels: msg.labelIds || [], unread: (msg.labelIds || []).includes("UNREAD"), body: (text || stripHtml(html)).slice(0, 20000), attachments, hasAttachments: attachments.length > 0 };
}
export async function listMessages({ q = "", max = 25, pageToken = "" } = {}, token, fetchImpl = fetch) {
  const p = new URLSearchParams({ maxResults: String(Math.min(Math.max(1, max), 50)) }); if (q) p.set("q", q); if (pageToken) p.set("pageToken", pageToken);
  const list = await gmailGet(`/messages?${p}`, token, fetchImpl);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) { // metadata per message: headers + snippet, no body
    const m = await gmailGet(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token, fetchImpl);
    const parsed = parseMessage(m); delete parsed.body; out.push(parsed);
  }
  return { messages: out, nextPageToken: list.nextPageToken || null, resultSizeEstimate: list.resultSizeEstimate || out.length };
}
export async function readMessage(id, token, fetchImpl = fetch) {
  return parseMessage(await gmailGet(`/messages/${encodeURIComponent(id)}?format=full`, token, fetchImpl));
}
export async function attachmentBytes(messageId, attachmentId, token, fetchImpl = fetch) {
  const d = await gmailGet(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, token, fetchImpl);
  return Buffer.from(String(d.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
/** What the chat sees: the newest messages of the last N days, headers and snippets only. */
export async function mailSummaries(env = process.env, { days = 14, max = 25 } = {}, fetchImpl = fetch) {
  const { token, email } = await accessToken(env, fetchImpl);
  const r = await listMessages({ q: `newer_than:${days}d`, max }, token, fetchImpl);
  return { mailbox: email, days, messages: r.messages.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, snippet: m.snippet, unread: m.unread, attachments: m.attachments.map((a) => a.filename) })) };
}
