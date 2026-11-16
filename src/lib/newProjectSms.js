/**
 * The texts sent when the tender inbox scan CREATES a project (Boma, 16 Nov 2026: "when a new project comes in, an
 * sms should be sent to both of us with the project details so i can check and attend to it and ask Grady if it is a
 * project he would like to do"). Two texts per project, written for their reader:
 *   - the ESTIMATOR's (the copy numbers): what arrived, from whom, the closing date and how it was set, the files —
 *     "please check it";
 *   - GRADY's: the same facts, shorter, and the question — is this one he wants to price.
 * Pure and verify-covered. Every word comes from the created entry the scan recorded (name, client, sender, deadline,
 * attachments) — nothing is invented, and a fact the entry lacks is left out. Plain GSM characters only (a hyphen,
 * never an em dash: one non-GSM character more than halves what fits in a segment). A reply to the sending number is
 * read by nobody, so Grady's text says who to tell.
 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-27" → "Fri 27 Nov" (a calendar day, never shifted by a time zone); "" when it is not a date. */
export function smsDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return "";
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** Anything outside the SMS alphabet becomes its plain form, so a project name with a dash stays one cheap segment set. */
export function gsmSafe(text) {
  return String(text || "").replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, "...").replace(/\s+/g, " ").trim();
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);
const who = (item) => gsmSafe(item.client || String(item.from || "").replace(/<[^>]*>/g, "").trim());

/** The closing-date sentence: stated in the email, or the default the scan set. */
export function deadlineSentence(item, { short = false } = {}) {
  const day = smsDay(item && item.deadline);
  if (!day) return "";
  if (item.deadlineSource === "default") return short ? `No closing date given - pencilled for ${day}.` : `No closing date in the email - set to ${day} (2 weeks).`;
  return `Closes ${day}.`;
}

/** Did Grady himself forward the request to the scanned mailbox? Then he is told it has landed, not asked about it. */
export function forwardedByGrady(item) {
  return /^grady@/i.test(String((item && item.via) || "").trim());
}

/** To the estimator: check it and attend to it. */
export function newProjectSmsForEstimator(item, { gradyAsked = true } = {}) {
  const from = who(item); const fwd = forwardedByGrady(item);
  const parts = [`New tender in the portal: ${clip(gsmSafe(item.name), 90)}${from ? ` from ${clip(from, 40)}` : ""}${fwd ? " (forwarded by Grady)" : ""}.`];
  const dl = deadlineSentence(item); if (dl) parts.push(dl);
  const n = Number(item.attachments) || 0;
  parts.push(n ? `${n} file${n === 1 ? "" : "s"} attached.` : "No files attached.");
  parts.push(fwd ? "Please check it. Grady has been told it is in." : gradyAsked ? "Please check it. Grady has been asked if he wants to price it." : "Please check it.");
  return parts.join(" ");
}
/** To Grady: the question. `estimator` is who he should tell (a reply to the sending number reaches nobody). */
export function newProjectSmsForGrady(item, { estimator = "Boma" } = {}) {
  const from = who(item); const name = gsmSafe(estimator) || "the estimator";
  if (forwardedByGrady(item)) { // he sent it in himself: confirm it landed, do not ask him whether he wants it
    const parts = [`Hi Grady, the request you forwarded for ${clip(gsmSafe(item.name), 90)}${from ? ` (${clip(from, 40)})` : ""} is now a project in the portal.`];
    const dl0 = deadlineSentence(item, { short: true }); if (dl0) parts.push(dl0);
    parts.push(`${name} will pick it up.`);
    return parts.join(" ");
  }
  const parts = [`Hi Grady, new tender request: ${clip(gsmSafe(item.name), 90)}${from ? ` from ${clip(from, 40)}` : ""}.`];
  const dl = deadlineSentence(item, { short: true }); if (dl) parts.push(dl);
  parts.push(`Is this one you want to price? Please let ${gsmSafe(estimator) || "the estimator"} know.`);
  return parts.join(" ");
}

export const NEW_PROJECT_SMS_EACH_MAX = 3; // more than this in one scan → ONE summary text each, not a text per project
/** Every text one scan sends: `[{role: "grady" | "copy", text, projectIds}]`. */
export function newProjectTexts(items, { estimator = "Boma", gradyAsked = true } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.name);
  if (!list.length) return [];
  const ids = (xs) => xs.map((i) => i.projectId).filter(Boolean);
  if (list.length <= NEW_PROJECT_SMS_EACH_MAX) {
    return list.flatMap((i) => [
      { role: "copy", text: newProjectSmsForEstimator(i, { gradyAsked }), projectIds: ids([i]) },
      ...(gradyAsked ? [{ role: "grady", text: newProjectSmsForGrady(i, { estimator }), projectIds: ids([i]) }] : []),
    ]);
  }
  const names = list.map((i) => clip(gsmSafe(i.name), 45)).join("; ");
  return [
    { role: "copy", text: clip(`${list.length} new tenders in the portal: ${names}. Please check them.${gradyAsked ? " Grady has been asked which he wants to price." : ""}`, 470), projectIds: ids(list) },
    ...(gradyAsked ? [{ role: "grady", text: clip(`Hi Grady, ${list.length} new tender requests: ${names}. Which would you like to price? Please let ${gsmSafe(estimator) || "the estimator"} know.`, 470), projectIds: ids(list) }] : []),
  ];
}
/** The switch: off until the wording is approved and `NEW_PROJECT_SMS` is set to on. */
export function newProjectSmsOn(env = {}) {
  return /^(on|true|1|yes)$/i.test(String(env.NEW_PROJECT_SMS || "").trim());
}
