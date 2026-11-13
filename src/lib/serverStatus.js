/**
 * The app's own server functions (/api/*) NOT ANSWERING is never "not configured".
 *
 * 13 Nov 2026 (Boma: "this message has become too persistent … i cant send the emails for grady notification:
 * Google mail is not configured on the server"): Vercel had switched the whole project off — every address
 * answered `402 Payment required / DEPLOYMENT_DISABLED` in plain text — and each surface read "no JSON came
 * back" as "the Google variables are not set", which sent the reader to the wrong place. A tab already open
 * keeps saving to the database (the browser talks to Supabase directly), so the only sign was that message.
 *
 * `serverDownReason(status)` is the ONE wording for a server that did not answer with JSON; every browser call
 * to /api/* uses it instead of naming a setting. Pure, verify-covered.
 */
export const HOSTING_OFF_STATUS = 402;

export function serverDownReason(status) {
  const s = Number(status) || 0;
  if (s === HOSTING_OFF_STATUS) {
    return "The app's hosting has been switched off by Vercel (402 Payment required) — the Vercel account needs attention (billing or plan usage). Mail, Google Drive, SMS and the AI functions cannot run until it is back. Work typed here still saves; do not reload this tab until then.";
  }
  if (!s) return "The app's server could not be reached — check the connection and try again.";
  return `The app's server did not answer (${s}) — try again in a minute.`;
}

/** Read a server function's reply: `{ok, status, body}` with `body` null when no JSON came back. */
export async function readServerReply(res) {
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (body == null || typeof body !== "object") body = null;
  return { ok: !!res.ok, status: res.status, body };
}

/** The reason a failed call shows: the server's own words when it sent JSON, else `serverDownReason`. */
export function failureReason(reply, fallback) {
  if (reply && reply.body && reply.body.error) return String(reply.body.error);
  if (reply && !reply.body) return serverDownReason(reply.status);
  return fallback || serverDownReason(reply && reply.status);
}
