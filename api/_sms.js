/**
 * The ONE place an SMS provider is spoken to (Grady, 2 Nov 2026: "lets wire in
 * the sms first" — a text to Grady when the costings are ready). Two providers
 * behind one call, chosen by SMS_PROVIDER: ClickSend (Australian sender ids,
 * basic auth username + API key) or Twilio (account SID + auth token, a From
 * number or messaging service). Every variable is SERVER-SIDE ONLY (Vercel →
 * Settings → Environment Variables; never VITE_-prefixed). The recipient is
 * GRADY_MOBILE — the function never texts an address the browser supplies.
 *
 *   SMS_PROVIDER=clicksend | twilio   (blank = whichever has its keys)
 *   GRADY_MOBILE=04xx xxx xxx          (any Australian spelling; stored E.164)
 *   CLICKSEND_USERNAME= CLICKSEND_API_KEY= SMS_FROM= (optional alpha sender id or number)
 *   TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM= (a number, or MGxxx messaging service SID)
 */
const CLICKSEND_URL = "https://rest.clicksend.com/v3/sms/send";
const twilioUrl = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;

/** An Australian mobile in any common spelling → E.164 ("+61412345678"), or null. Other countries pass only as a full +… number. */
export function normalizeMobile(raw) {
  const s = String(raw || "").replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (/^\+61[2-9]\d{8}$/.test(s)) return s;
  if (/^61[2-9]\d{8}$/.test(s)) return `+${s}`;
  if (/^0[2-9]\d{8}$/.test(s)) return `+61${s.slice(1)}`;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s; // another country's full international number
  return null;
}
/**
 * The Twilio sender as the API wants it (13 Nov 2026: TWILIO_FROM was typed "04xx xxx xxx" — Twilio takes a
 * number in E.164 only and answered every send with an invalid-From error). `{field, value, kind}`:
 * an `MG…` Messaging Service SID → MessagingServiceSid; a phone number in ANY Australian spelling (or a full
 * +… number) → From in E.164; anything else (an alphanumeric sender id, "Gradcon") → From as typed.
 */
export function twilioSender(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (/^MG[0-9a-f]{32}$/i.test(v)) return { field: "MessagingServiceSid", value: v, kind: "service" };
  const num = normalizeMobile(v);
  if (num) return { field: "From", value: num, kind: "number" };
  return { field: "From", value: v, kind: /^[\d\s+()\-.]+$/.test(v) ? "unreadable" : "alpha" };
}
/** What a page may show of the Twilio sender: a number masked like the recipient, a service SID shortened, an alpha id as typed. */
export function twilioFromLabel(raw) {
  const t = twilioSender(raw);
  if (!t) return null;
  if (t.kind === "number") return maskMobile(t.value);
  if (t.kind === "service") return `${t.value.slice(0, 6)}…`;
  return t.kind === "unreadable" ? "unreadable number" : t.value;
}
/** "+61412345678" → "+61 4•• ••• 678" — enough to recognise, never the whole number in a page. */
export function maskMobile(e164) {
  const s = String(e164 || "");
  if (s.length < 8) return s ? "•••" : "";
  return `${s.slice(0, 4)}••• ••• ${s.slice(-3)}`;
}

export function smsProviderId(env = process.env) {
  const want = String(env.SMS_PROVIDER || "").trim().toLowerCase();
  const has = { clicksend: !!(env.CLICKSEND_USERNAME && env.CLICKSEND_API_KEY), twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) };
  if (want && has[want]) return want;
  if (want && !has[want]) return null;
  return has.clicksend ? "clicksend" : has.twilio ? "twilio" : null;
}

/** What Settings and the checklist may know: configured or not, which provider, the recipient masked. Never a key. */
export function smsStatus(env = process.env) {
  const provider = smsProviderId(env);
  const to = normalizeMobile(env.GRADY_MOBILE);
  const missing = [];
  if (!provider) missing.push(String(env.SMS_PROVIDER || "").toLowerCase() === "twilio" ? "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM" : "CLICKSEND_USERNAME / CLICKSEND_API_KEY (or the Twilio trio)");
  if (!to) missing.push(env.GRADY_MOBILE ? "GRADY_MOBILE is not a mobile number the function can read" : "GRADY_MOBILE");
  return { configured: !!provider && !!to, provider, to: to ? maskMobile(to) : null, from: provider === "twilio" ? twilioFromLabel(env.TWILIO_FROM) : (env.SMS_FROM || null), missing,
    // a sender the function cannot read as a number is said here, before a send is refused by Twilio
    warning: provider === "twilio" && (twilioSender(env.TWILIO_FROM) || {}).kind === "unreadable" ? "TWILIO_FROM is not a phone number the function can read — use the Twilio number as +61…, or an MG… Messaging Service SID" : null };
}

/** GSM-7 segments: 160 in one, 153 each after; a non-GSM character (an em dash, a curly quote) makes it UCS-2 — 70 / 67. */
const GSM = /^[A-Za-z0-9@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/;
export function smsSegments(text) {
  const t = String(text || "");
  if (!t) return 0;
  const gsm = GSM.test(t);
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return t.length <= single ? 1 : Math.ceil(t.length / multi);
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const err = (status, message, detail) => Object.assign(new Error(message), { status, detail });

/** Sends ONE text to the configured recipient. Resolves `{ok, provider, id, to (masked), segments}`; throws with a status. */
export async function sendSms(text, env = process.env, fetchImpl = fetch) {
  const st = smsStatus(env);
  if (!st.configured) throw err(503, `SMS is not configured — set ${st.missing.join(" and ")} in the Vercel project's Environment Variables.`);
  const body = String(text || "").trim();
  if (!body) throw err(400, "Nothing to send.");
  if (body.length > 480) throw err(400, "The text is over 480 characters (three segments) — shorten it.");
  const to = normalizeMobile(env.GRADY_MOBILE);
  if (st.provider === "clicksend") {
    const msg = { source: "gradcon-portal", to, body };
    if (env.SMS_FROM) msg.from = String(env.SMS_FROM).slice(0, 11);
    const res = await fetchImpl(CLICKSEND_URL, { method: "POST", headers: { Authorization: `Basic ${b64(`${env.CLICKSEND_USERNAME}:${env.CLICKSEND_API_KEY}`)}`, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [msg] }) });
    let j = null; try { j = await res.json(); } catch { j = null; }
    const m = j && j.data && Array.isArray(j.data.messages) ? j.data.messages[0] : null;
    if (!res.ok || !m || !/^(SUCCESS|QUEUED)$/i.test(String(m.status || ""))) throw err(res.status >= 400 && res.status < 600 ? res.status : 502, `ClickSend did not accept the text${m && m.status ? ` (${m.status})` : ""}.`, (j && (j.response_msg || j.message)) || null);
    return { ok: true, provider: "clicksend", id: m.message_id || null, to: maskMobile(to), segments: smsSegments(body), cost: m.message_price != null ? Number(m.message_price) : null };
  }
  // Twilio: form-encoded, a number or a messaging service as the sender
  const form = new URLSearchParams({ To: to, Body: body });
  const sender = twilioSender(env.TWILIO_FROM);
  form.set(sender.field, sender.value);
  const res = await fetchImpl(twilioUrl(env.TWILIO_ACCOUNT_SID), { method: "POST", headers: { Authorization: `Basic ${b64(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  let j = null; try { j = await res.json(); } catch { j = null; }
  if (!res.ok || !j || !j.sid) throw err(res.status >= 400 && res.status < 600 ? res.status : 502, `Twilio did not accept the text${j && j.code ? ` (${j.code})` : ""}.`, (j && j.message) || null);
  return { ok: true, provider: "twilio", id: j.sid, to: maskMobile(to), segments: j.num_segments ? Number(j.num_segments) : smsSegments(body) };
}
