/**
 * Tender inbox — pure helpers behind api/tender-inbox.js (the daily scan of
 * the projects@ mailbox that turns a request for tender / quote into a
 * Queued project) and the portal's "New from the inbox" band.
 *
 * Grady, 28 Oct 2026: "automatically crawl my inbox and if an email for
 * request for tender or quote is observed, create a project in the quotes
 * section with a deadline of 2 weeks if none was given in the email and
 * notify each time one logs in with the details of the created project …
 * it should only be for projects@ and should also pick up tender requests
 * from grady's email. i want a daily scheduled scan and yes create the
 * project straight away making sure no duplicate projects are present and
 * yes copy email attachments".
 *
 * Nothing here touches the network or the DOM: the server function reads
 * the mailbox through api/_google.js and hands every message to
 * `classifyMessage` / `candidateFromMessage`; verify.mjs runs the same code
 * on fixtures. The ONE mailbox is projects@ (the only Google connection the
 * app may hold — api/_google.js `allowedMailbox`): a tender that reached
 * grady@ is picked up when it is FORWARDED or copied to projects@ — the
 * forwarded header block is read and the ORIGINAL sender becomes the client,
 * never Grady.
 */
import { uid } from "./costing.js";

export const INBOX_ROW_KEY = "gradcon-tender-inbox";
/** A quote with no closing date in the email is due this many days after it was received. */
export const DEFAULT_TENDER_DAYS = 14;
/** The first scan ever (no record) looks this far back. */
export const FIRST_SCAN_DAYS = 14;
/** A re-scan overlaps the previous one by this much, so a message that landed during the last run is not missed. */
export const SCAN_OVERLAP_MS = 60 * 60 * 1000;
export const MAX_ATTACHMENTS_PER_PROJECT = 12;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Mail from these domains is Gradcon's own — never a tender request unless it forwards one. */
export const OWN_DOMAINS = ["gradcon.com.au"];
/** The seen-stamp a browser keeps per account for the welcome band: `gradcon-inbox-seen:<account>`. */
export const INBOX_SEEN_PREFIX = "gradcon-inbox-seen:";
/** The attachment kinds copied onto the project (extension → {kind, mime}). */
export const MAIL_ATTACH_KINDS = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  dwg: { kind: "cad", mime: "application/acad" },
  dxf: { kind: "cad", mime: "application/dxf" },
  doc: { kind: "doc", mime: "application/msword" },
  docx: { kind: "doc", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { kind: "sheet", mime: "application/vnd.ms-excel" },
  xlsx: { kind: "sheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  csv: { kind: "sheet", mime: "text/csv" },
  zip: { kind: "other", mime: "application/zip" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
};

const FREE_MAIL = new Set(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.au", "bigpond.com", "icloud.com", "live.com", "live.com.au", "optusnet.com.au", "me.com", "msn.com"]);
const CANDIDATE_SCORE = 3;

/* ---------- senders ---------- */
export function parseAddress(s) {
  const str = String(s || "").trim();
  const m = /^(?:"?([^"<]*)"?\s*)?<?([^\s<>@"]+@[^\s<>"]+)>?\s*$/.exec(str) || /([^\s<>@"]+@[^\s<>"]+)/.exec(str);
  if (!m) return { name: str, email: "", domain: "" };
  const email = (m[2] || m[1] || "").toLowerCase().replace(/[>,;]+$/, "");
  const name = (m[2] ? m[1] : "") ? String(m[1]).trim().replace(/^['"]|['"]$/g, "") : str.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  return { name: name === email ? "" : name, email, domain: email.split("@")[1] || "" };
}
export const isOwnAddress = (email) => OWN_DOMAINS.includes(parseAddress(email).domain);
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** The organisation a sender writes for: the second-level label of a company domain ("dmacpiling.com.au" → "Dmacpiling"), else the display name (free mail). */
export function orgFromSender(from) {
  const a = parseAddress(from);
  if (a.domain && !FREE_MAIL.has(a.domain)) {
    const label = a.domain.replace(/\.(com|net|org|edu|gov)?\.?(au|nz|uk)$/i, "").replace(/\.(com|net|org|io|co)$/i, "").split(".").pop() || "";
    const words = label.replace(/[-_]+/g, " ").trim();
    if (words) return titleCase(words);
  }
  return a.name || a.email || "";
}

/* ---------- forwarded mail (a tender sent to grady@ and passed on) ---------- */
const FWD_SUBJECT = /^\s*(?:(?:fwd?|fw|tr|wg)\s*:\s*)+/i;
const FWD_MARKER = /-{2,}\s*(?:Forwarded message|Original Message|Begin forwarded message)\s*-{2,}|^Begin forwarded message:|^-+\s*Forwarded message\s*-+$/im;
/** The sender inside a forwarded header block, and the original subject when it carries one. */
export function forwardedFrom(msg) {
  const subject = String((msg && msg.subject) || ""), body = String((msg && msg.body) || "");
  const marked = FWD_MARKER.test(body);
  if (!FWD_SUBJECT.test(subject) && !marked) return null;
  const start = marked ? body.search(FWD_MARKER) : 0;
  const block = body.slice(Math.max(0, start), Math.max(0, start) + 1500);
  const fm = /^\s*\*?From:?\*?\s*:?\s*(.+)$/im.exec(block);
  const sm = /^\s*\*?Subject:?\*?\s*:?\s*(.+)$/im.exec(block);
  const dm = /^\s*\*?(?:Date|Sent):?\*?\s*:?\s*(.+)$/im.exec(block);
  const from = fm ? fm[1].trim().replace(/\s*\[mailto:[^\]]*\]/i, "") : "";
  if (!from && !sm) return { from: "", subject: "", date: "", forwarded: true };
  return { from, subject: sm ? sm[1].trim() : "", date: dm ? dm[1].trim() : "", forwarded: true };
}
/** Who really asked: the original sender of a forwarded message, else the From line. `via` names the forwarder when it was one of ours. */
export function effectiveSender(msg) {
  const from = String((msg && msg.from) || "");
  const fwd = forwardedFrom(msg);
  if (fwd && fwd.from && parseAddress(fwd.from).email) return { from: fwd.from, via: isOwnAddress(from) ? parseAddress(from).email : "", forwarded: true, originalSubject: fwd.subject };
  return { from, via: "", forwarded: !!fwd, originalSubject: fwd ? fwd.subject : "" };
}

/* ---------- classification ---------- */
const STRONG = [
  [/\b(?:rfq|rft|itt|rfp|eoi|rfi)\b/i, "RFQ / RFT / ITT / EOI in the text"],
  [/request\s+for\s+(?:a\s+|an\s+)?(?:quot(?:e|ation)s?|tenders?|pric(?:e|ing)|proposals?|submission)/i, "request for quote / tender"],
  [/invitation\s+to\s+(?:tender|quote|price|bid|submit)/i, "invitation to tender"],
  [/invited\s+to\s+(?:tender|quote|price|submit|bid)/i, "invited to tender"],
  [/tender\s+(?:invitation|documents?|package|submission|enquiry|opportunity|drawings|set)/i, "tender documents"],
  [/call\s+for\s+(?:tenders?|quot(?:es|ations))/i, "call for tenders"],
  [/expressions?\s+of\s+interest/i, "expression of interest"],
  [/(?:please|kindly|could\s+you|can\s+you)\s+(?:provide|submit|forward|send|supply|give)\s+(?:us\s+|me\s+)?(?:with\s+)?(?:a|an|your|the)?\s*(?:quot(?:e|ation)|price|pricing|proposal|tender|cost(?:ing)?s?|rates?)/i, "asked for a quote"],
  [/(?:please|kindly)\s+(?:quote|price|tender|cost)\b/i, "please quote"],
  [/quot(?:e|ation)s?\s+(?:is\s+|are\s+)?(?:required|requested|needed|sought)/i, "quotation required"],
  [/pric(?:e|ing)\s+(?:is\s+)?(?:required|requested|needed|sought)/i, "pricing required"],
  [/opportunity\s+to\s+(?:tender|quote|price|bid)/i, "opportunity to tender"],
  [/tenders?\s+(?:close|closes|closing|due)/i, "tender closing"],
  [/quot(?:e|ation)s?\s+(?:to\s+be\s+)?(?:back|returned|submitted|due)\s+by/i, "quote due by"],
  [/(?:scope\s+of\s+works?|concrete\s+(?:works?|package|scope))\b[\s\S]{0,120}\b(?:quot|pric|tender)/i, "scope of works for pricing"],
  [/(?:like|love|wish|want)\s+(?:you\s+)?to\s+(?:quote|price|tender)/i, "would like you to quote"],
];
const WEAK = [
  [/\btenders?\b/i, "tender"],
  [/\bquot(?:e|ation)s?\b/i, "quote"],
  [/\b(?:drawings?|plans|documents?|specifications?)\s+(?:are\s+)?(?:attached|enclosed|below|linked)/i, "drawings attached"],
  [/\b(?:footings?|slabs?|concrete|piling|formwork|retaining\s+walls?|basement)\b/i, "concrete scope words"],
];
const NOISE = [
  [/\bunsubscribe\b/i, "newsletter"],
  [/\bwebinar\b|\bspecial\s+offer\b|\bpromo(?:tion)?\b/i, "marketing"],
  [/\b(?:tax\s+)?invoice\b|\bremittance\b|\bstatement\s+of\s+account\b|\bpayment\s+(?:claim|received|advice)\b|\bpurchase\s+order\b/i, "accounts mail"],
  [/\bquote\s+(?:has\s+been\s+|was\s+)?(?:accepted|approved|declined|unsuccessful)\b/i, "an outcome, not a request"],
  [/\byour\s+(?:recent\s+)?quot(?:e|ation)\b/i, "about Gradcon's own quote"],
  [/\bthank\s+you\s+for\s+(?:your|the)\s+quot(?:e|ation)\b/i, "a thank-you for a quote"],
];
const DRAWING_FILE = /\b(?:arch(?:itectural)?|struct(?:ural)?|eng(?:ineering)?|drawing|dwg|plan|spec(?:ification)?|geotech|soil|tender|boq|scope|schedule|survey|[AS]\s?-?\d{2,4}[A-Z]?)\b/i;
export const attachExt = (name) => String(name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] || "";
export const isAttachable = (att) => !!att && !!MAIL_ATTACH_KINDS[attachExt(att.filename || att.name)] && (att.attachmentId || att.body);

/** Does this message ask Gradcon to price something? → {candidate, score, reasons, excluded}. */
export function classifyMessage(msg) {
  const subject = String((msg && msg.subject) || ""), body = String((msg && msg.body) || msg?.snippet || "");
  const text = `${subject}\n${body}`.slice(0, 20000);
  const reasons = [];
  let score = 0;
  const sender = effectiveSender(msg);
  const fromOwn = isOwnAddress(msg && msg.from);
  if (fromOwn && !sender.forwarded) return { candidate: false, score: 0, reasons: [], excluded: "Gradcon's own message" };
  if (fromOwn && sender.forwarded && !parseAddress(sender.from).email) return { candidate: false, score: 0, reasons: [], excluded: "forwarded with no readable original sender" };
  if (/^\s*re\s*:\s*rfq\s*[–—-]/i.test(subject)) return { candidate: false, score: 0, reasons: [], excluded: "a reply to Gradcon's own RFQ" };
  if (/^\s*(?:re|aw|sv)\s*:/i.test(subject)) { score -= 1; reasons.push("a reply (−1)"); }
  let strongHits = 0;
  STRONG.forEach(([re, why]) => { if (re.test(text) && strongHits < 2) { strongHits += 1; score += 3; reasons.push(why); } });
  WEAK.forEach(([re, why]) => { if (re.test(text)) { score += 1; reasons.push(why); } });
  if (STRONG.some(([re]) => re.test(subject))) { score += 1; reasons.push("in the subject"); }
  const atts = Array.isArray(msg && msg.attachments) ? msg.attachments : [];
  if (atts.some((a) => isAttachable(a) && DRAWING_FILE.test(a.filename || a.name || ""))) { score += 2; reasons.push("drawings / documents attached"); }
  else if (atts.some(isAttachable)) { score += 1; reasons.push("attachments"); }
  NOISE.forEach(([re, why]) => { if (re.test(text)) { score -= 3; reasons.push(`${why} (−3)`); } });
  if (/no-?reply@|donotreply@|notifications?@/i.test(String(msg && msg.from))) { score -= 1; reasons.push("automated sender (−1)"); }
  return { candidate: strongHits > 0 && score >= CANDIDATE_SCORE, score, reasons, excluded: null };
}

/* ---------- the project name and the site ---------- */
const STREET_TYPES = "Street|St|Road|Rd|Avenue|Ave|Av|Drive|Dr|Court|Ct|Crescent|Cres|Cr|Place|Pl|Lane|Ln|Boulevard|Blvd|Bvd|Highway|Hwy|Parade|Pde|Way|Close|Cl|Terrace|Tce|Grove|Gr|Esplanade|Esp|Circuit|Cct|Square|Sq|Rise|Walk|Promenade|Prom|Track|Trk|Mews|Loop|Retreat|Rtt|Gardens|Gdns|Point|Pt|Quay|Ridge|Row|Strand|View|Vista|Wynd";
const ADDRESS_RE = new RegExp(`\\b(\\d{1,5}[A-Za-z]?(?:\\s*[-–/]\\s*\\d{1,5}[A-Za-z]?)?\\s+(?:[A-Z][A-Za-z'’]+\\s+){1,4}(?:${STREET_TYPES})\\b\\.?)(?:,?\\s+((?:[A-Z][A-Za-z'’]+\\s?){1,3}))?(?:,?\\s*(VIC|Vic|Victoria|NSW|QLD|SA|WA|TAS|ACT|NT))?(?:,?\\s*(\\d{4}))?`);
/** The first street address in a text, as "<number> <Street> <Type>[, <Suburb>[ VIC][ <postcode>]]", else "". */
export function addressIn(text) {
  const m = ADDRESS_RE.exec(String(text || "").replace(/\s+/g, " "));
  if (!m) return "";
  const street = m[1].replace(/\.$/, "").replace(/\s+/g, " ").trim();
  let suburb = (m[2] || "").trim();
  // a suburb must not be the start of a sentence's next clause ("Road is", "Street on")
  if (/^(?:is|on|in|at|for|and|the|to|we|our|please|this|which|project|site|works?|tender|quote|job|development)\b/i.test(suburb)) suburb = "";
  const state = m[3] ? "VIC" : "";
  const pc = m[4] || "";
  const tail = [suburb, [state, pc].filter(Boolean).join(" ")].filter(Boolean).join(" ");
  return tail ? `${street}, ${tail}` : street;
}
const PREFIXES = /^\s*(?:(?:fwd?|fw|re|tr|wg|aw)\s*:\s*)+/i;
const LEADS = /^\s*(?:(?:rfq|rft|itt|rfp|eoi|rfi|tender(?:\s+invitation| documents| package)?|request\s+for\s+(?:quot(?:e|ation)|tender|pricing|proposal)|invitation\s+to\s+(?:tender|quote)|quote\s+request|quotation\s+request|pricing\s+request|call\s+for\s+tenders?)\s*(?:[-–—:|]|for|–)\s*)+/i;
const TAILS = /\s*(?:[-–—:|]\s*)?(?:tender\s+documents?|for\s+pricing|for\s+quot(?:e|ation)|rfq|rft|quote\s+request|request\s+for\s+quot(?:e|ation))\s*$/i;
/** "<number> <street> <type>" of an address, normalised — the part two spellings of one site share. */
export const streetKey = (addr) => normName(String(addr || "").split(",")[0]).replace(/\b(street|st|road|rd|avenue|ave|av|drive|dr|court|ct|crescent|cres|cr|place|pl|lane|ln|boulevard|blvd|bvd|highway|hwy|parade|pde|close|cl|terrace|tce|grove|gr|esplanade|esp|circuit|cct|square|sq)\b/g, "").replace(/\s+/g, " ").trim();
/** The site address: the subject's, or the body's fuller spelling of the same street, else the body's first address. */
export function siteAddressOf(msg, sender) {
  const subj = addressIn(`${(sender && sender.originalSubject) || ""} ${(msg && msg.subject) || ""}`);
  const body = addressIn(String((msg && msg.body) || ""));
  if (subj && body && streetKey(subj) === streetKey(body) && body.length > subj.length) return body;
  return subj || body;
}
/** A project name for the tender: the site address when one is stated (subject first, then the body), else the subject stripped of RFQ / Re: / Fwd: furniture. */
export function projectNameFrom(msg, sender) {
  const subject = String((msg && msg.subject) || "");
  const orig = sender && sender.originalSubject ? String(sender.originalSubject) : "";
  const cleaned = (s) => s.replace(PREFIXES, "").replace(LEADS, "").replace(TAILS, "").replace(/\s+/g, " ").trim();
  const subj = cleaned(orig || subject) || cleaned(subject);
  const fromSubject = addressIn(subj);
  if (fromSubject) {
    // the body often carries the fuller form of the same address (suburb, VIC, postcode)
    const bodyAddr = addressIn(String((msg && msg.body) || ""));
    const addr = bodyAddr && streetKey(bodyAddr) === streetKey(fromSubject) && bodyAddr.length > fromSubject.length ? bodyAddr : fromSubject;
    const rest = subj.replace(ADDRESS_RE, "").replace(/^[\s,–—:|-]+|[\s,–—:|-]+$/g, "").trim();
    return rest && rest.length > 2 && !/^(?:vic|victoria|\d{4})$/i.test(rest) ? `${addr} — ${rest}` : addr;
  }
  const fromBody = addressIn(String((msg && msg.body) || ""));
  if (fromBody) return subj && subj.length > 2 ? `${fromBody} — ${subj}` : fromBody;
  return subj || `Tender from ${orgFromSender(sender ? sender.from : msg && msg.from) || "the inbox"}`;
}

/* ---------- the closing date ---------- */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function addDays(isoOrDate, n) {
  const d = typeof isoOrDate === "string" ? new Date(`${isoOrDate.slice(0, 10)}T00:00:00Z`) : new Date(isoOrDate);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
const validDay = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? isoDay(dt) : null; };
const monthIdx = (s) => MONTHS.indexOf(String(s || "").slice(0, 3).toLowerCase()) + 1;
/** Every calendar date written in a text, as {iso, index, text}. A year left out is the next occurrence on or after `after` (YYYY-MM-DD). */
export function datesIn(text, after) {
  const s = String(text || ""); const out = [];
  const ref = new Date(`${String(after || isoDay(new Date())).slice(0, 10)}T00:00:00Z`);
  const yearFor = (m, d) => { let y = ref.getUTCFullYear(); const cand = validDay(y, m, d); if (cand && cand < isoDay(ref)) y += 1; return y; };
  let m;
  const numeric = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})\b/g;
  while ((m = numeric.exec(s))) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const iso = validDay(y, Number(m[2]), Number(m[1])); if (iso) out.push({ iso, index: m.index, text: m[0] }); }
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?(?:\s+(\d{4}))?\b/gi;
  while ((m = dmy.exec(s))) { const mo = monthIdx(m[2]); const d = Number(m[1]); const y = m[3] ? Number(m[3]) : yearFor(mo, d); const iso = validDay(y, mo, d); if (iso) out.push({ iso, index: m.index, text: m[0] }); }
  const mdy = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b/gi;
  while ((m = mdy.exec(s))) { const mo = monthIdx(m[1]); const d = Number(m[2]); if (d > 31) continue; const y = m[3] ? Number(m[3]) : yearFor(mo, d); const iso = validDay(y, mo, d); if (iso && !out.some((o) => o.index === m.index)) out.push({ iso, index: m.index, text: m[0] }); }
  const dm = /\b(\d{1,2})\/(\d{1,2})\b(?![\/.\d])/g;   // "by 3/11" — the next 3 November
  while ((m = dm.exec(s))) { const d = Number(m[1]), mo = Number(m[2]); if (mo < 1 || mo > 12 || d < 1 || d > 31) continue; const iso = validDay(yearFor(mo, d), mo, d); if (iso && !out.some((o) => o.index === m.index)) out.push({ iso, index: m.index, text: m[0] }); }
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = isoRe.exec(s))) { const iso = validDay(Number(m[1]), Number(m[2]), Number(m[3])); if (iso) out.push({ iso, index: m.index, text: m[0] }); }
  return out.sort((a, b) => a.index - b.index);
}
const DUE_WORDS = /\b(?:clos(?:e|es|ing)(?:\s+date)?|due(?:\s+date|\s+back)?|deadline|submit(?:ted|ting)?(?:\s+by|\s+before|\s+no\s+later\s+than)?|return(?:ed)?\s+(?:by|before)|no\s+later\s+than|required\s+(?:by|before)|back\s+(?:to\s+(?:us|me)\s+)?by|respond\s+by|reply\s+by|(?:by|before)\s+(?:cob|close\s+of\s+business|end\s+of\s+(?:day|business))|pric(?:e|ing)\s+by|quot(?:e|ation)s?\s+by|tenders?\s+by|lodg(?:e|ed)\s+by|in\s+by)\b/gi;
const BY_WORD = /\b(?:by|before)\b/gi;   // last resort: "price through by 3/11"
/** The closing date the email states (a date within 90 characters after a closing / due / submit-by word, on or after receipt, within a year), else receipt + DEFAULT_TENDER_DAYS. */
export function extractDeadline(text, receivedISO, { defaultDays = DEFAULT_TENDER_DAYS } = {}) {
  const received = String(receivedISO || isoDay(new Date())).slice(0, 10);
  const s = String(text || "").replace(/\s+/g, " ");
  const dates = datesIn(s, received);
  const floor = addDays(received, -1), ceiling = addDays(received, 366);
  let m;
  for (const words of [DUE_WORDS, BY_WORD]) {
  words.lastIndex = 0;
  while ((m = words.exec(s))) {
    const from = m.index, to = m.index + m[0].length + 90;
    const hit = dates.find((d) => d.index >= from && d.index <= to && d.iso >= floor && d.iso <= ceiling);
    if (hit) return { date: hit.iso, source: "email", text: s.slice(from, Math.min(s.length, hit.index + hit.text.length)).trim() };
    const rel = /(?:within|in)\s+(\d{1,2}|one|two|three|four|five|six|seven|ten)\s+(business\s+|working\s+)?(days?|weeks?)/i.exec(s.slice(from, to));
    if (rel) {
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
      const n = words[rel[1].toLowerCase()] || Number(rel[1]);
      const days = /week/i.test(rel[3]) ? n * 7 : rel[2] ? Math.round(n * 7 / 5) : n;
      return { date: addDays(received, days), source: "email", text: s.slice(from, from + rel.index + rel[0].length).trim() };
    }
  }
  }
  return { date: addDays(received, defaultDays), source: "default", text: "" };
}

/* ---------- a candidate and its project ---------- */
/** One parsed Gmail message (api/_google.js parseMessage) → the facts a project is made from, or null when it is not a request. */
export function candidateFromMessage(msg, { now = new Date() } = {}) {
  const cls = classifyMessage(msg);
  if (!cls.candidate) return null;
  const sender = effectiveSender(msg);
  const a = parseAddress(sender.from);
  const receivedAt = msg.date && !Number.isNaN(Date.parse(msg.date)) ? new Date(msg.date).toISOString() : now.toISOString();
  const body = String(msg.body || msg.snippet || "");
  const dl = extractDeadline(`${msg.subject || ""}\n${body}`, receivedAt);
  const attachments = (Array.isArray(msg.attachments) ? msg.attachments : []).filter(isAttachable).slice(0, MAX_ATTACHMENTS_PER_PROJECT)
    .map((x) => ({ attachmentId: x.attachmentId || null, filename: x.filename, mimeType: x.mimeType || MAIL_ATTACH_KINDS[attachExt(x.filename)].mime, size: Number(x.size) || 0, kind: MAIL_ATTACH_KINDS[attachExt(x.filename)].kind }));
  return {
    messageId: msg.id, threadId: msg.threadId || msg.id, subject: String(msg.subject || "").trim(), receivedAt,
    from: sender.from, fromEmail: a.email, fromName: a.name, via: sender.via, forwarded: sender.forwarded,
    client: orgFromSender(sender.from), projectName: projectNameFrom(msg, sender), siteAddress: siteAddressOf(msg, sender),
    deadline: dl.date, deadlineSource: dl.source, deadlineText: dl.text,
    attachments, snippet: body.replace(/\s+/g, " ").trim().slice(0, 600), score: cls.score, reasons: cls.reasons,
  };
}
/** The Queued project a candidate becomes. `files` are the copied attachments (provider "mail"). */
export function tenderQuoteFrom(cand, { today = isoDay(new Date()), files = [], scannedAt = new Date().toISOString(), overheadPct = 0.08, contingencyPct = 0.05 } = {}) {
  return {
    projectName: cand.projectName, clientName: cand.client || "", projectDate: today, gfa: undefined,
    overheadPct, contingencyPct, status: "Queued", items: [],
    siteAddress: cand.siteAddress || "",
    planner: { deadline: cand.deadline, priority: null },
    source: { kind: "mail", messageId: cand.messageId, threadId: cand.threadId, from: cand.from, fromEmail: cand.fromEmail, via: cand.via || "", subject: cand.subject, receivedAt: cand.receivedAt, scannedAt, deadlineSource: cand.deadlineSource, deadlineText: cand.deadlineText || "", snippet: cand.snippet, reasons: cand.reasons },
    files: files.map((f) => ({ id: f.id || uid(), provider: "mail", name: f.name, kind: f.kind, mimeType: f.mimeType, size: f.size, url: f.url, path: f.path, attachedAt: scannedAt, fromMail: { messageId: cand.messageId, attachmentId: f.attachmentId || null } })),
  };
}
/** The project-level files copied from the tender email (provider "mail"). */
export const mailFiles = (quote) => (quote && Array.isArray(quote.files) ? quote.files : []).filter((f) => f && f.provider === "mail");

/* ---------- duplicates ---------- */
export const normName = (s) => String(s || "").toLowerCase().replace(/\b(?:fwd?|fw|re)\s*:/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\b(?:vic|victoria|australia)\b/g, " ").replace(/\s+/g, " ").trim();
/** The existing project this candidate would duplicate — the same message or thread already recorded on a project, the same address, or the same normalised name — else null.
 *  `existing` rows are `{key, name, client, source, status}` (what the server selects from every quote row). */
export function findDuplicate(cand, existing) {
  const rows = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const byMail = rows.find((r) => r.source && r.source.kind === "mail" && (r.source.messageId === cand.messageId || (cand.threadId && r.source.threadId === cand.threadId)));
  if (byMail) return { row: byMail, why: "the same email thread already made this project" };
  const site = cand.siteAddress || addressIn(cand.projectName);
  const street = streetKey(site);
  const suburbOf = (a) => normName((String(a || "").split(",")[1] || "").replace(/\b\d{4}\b/g, ""));
  if (street && street.length >= 6) {
    const hit = rows.find((r) => { const ra = addressIn(String(r.name || "")); if (!ra || streetKey(ra) !== street) return false; const s1 = suburbOf(ra), s2 = suburbOf(site); return !s1 || !s2 || s1 === s2 || s1.startsWith(s2) || s2.startsWith(s1); });
    if (hit) return { row: hit, why: "a project at the same address exists" };
  }
  const name = normName(cand.projectName);
  if (name && name.length >= 6) { const hit = rows.find((r) => normName(r.name) === name); if (hit) return { row: hit, why: "a project with the same name exists" }; }
  return null;
}

/* ---------- the scan record (estimator_kv row INBOX_ROW_KEY) ---------- */
export const emptyRecord = () => ({ version: 1, lastScanAt: null, lastScanBy: null, watermarkMs: 0, handled: {}, created: [], lastResult: null, errors: [] });
/** The Gmail search for the next scan: everything since the watermark (less an hour's overlap), the first time the last FIRST_SCAN_DAYS days; never spam, trash, sent or drafts. */
export function scanQuery(record, now = new Date()) {
  const wm = Number(record && record.watermarkMs) || 0;
  const since = wm > 0 ? Math.floor((wm - SCAN_OVERLAP_MS) / 1000) : Math.floor((now.getTime() - FIRST_SCAN_DAYS * 86400000) / 1000);
  return `after:${since} -in:spam -in:trash -in:sent -in:drafts -in:chats`;
}
/** Fold one scan's outcome into the record: handled messages (newest 1000), the created list (newest 200), the watermark, the summary. */
export function applyScan(record, { at = new Date().toISOString(), by = "cron", seenMaxMs = 0, created = [], handled = [], summary = {}, errors = [] } = {}) {
  const r = { ...emptyRecord(), ...(record || {}) };
  const h = { ...(r.handled || {}) };
  handled.forEach((x) => { if (x && x.messageId) h[x.messageId] = { outcome: x.outcome, reason: x.reason || "", projectId: x.projectId || null, threadId: x.threadId || null, at }; });
  const keys = Object.keys(h).sort((a, b) => String(h[b].at).localeCompare(String(h[a].at))).slice(0, 1000);
  const handledOut = {}; keys.forEach((k) => { handledOut[k] = h[k]; });
  const createdOut = [...created.map((c) => ({ ...c, at })), ...(r.created || [])].slice(0, 200);
  return { ...r, version: 1, lastScanAt: at, lastScanBy: by, watermarkMs: Math.max(Number(r.watermarkMs) || 0, Number(seenMaxMs) || 0), handled: handledOut, created: createdOut, lastResult: { at, by, ...summary }, errors: errors.slice(0, 20) };
}
export const wasHandled = (record, msg) => !!(record && record.handled && msg && (record.handled[msg.id] || Object.values(record.handled).some((h) => h && h.outcome === "created" && h.threadId && h.threadId === msg.threadId)));
/** The projects the scan created after `sinceISO` (what the welcome band shows an account that cleared it then). */
export const newSince = (record, sinceISO) => ((record && record.created) || []).filter((c) => !sinceISO || String(c.at) > String(sinceISO));

/* ---------- the AI second opinion (optional; the rules decide when no provider answers) ---------- */
export function tenderReviewPrompt(cands, { today = isoDay(new Date()) } = {}) {
  const rows = cands.map((c) => ({ id: c.messageId, from: c.from, subject: c.subject, received: c.receivedAt.slice(0, 10), attachments: c.attachments.map((a) => a.filename), text: c.snippet }));
  return [
    `Today is ${today}. Gradcon Concrete Constructions is a concrete subcontractor in Melbourne. Each email below reached its estimating inbox. For EACH one decide whether it is a REQUEST for Gradcon to tender, quote or price work (a builder, client, consultant or tender portal asking for a price), as opposed to anything else (a supplier quoting Gradcon, a reply about Gradcon's own quote, an invoice, a newsletter, a site notice).`,
    `Reply with ONE JSON object and nothing else: {"reviews":[{"id":"<id>","tender":true|false,"confidence":"high"|"medium"|"low","projectName":"<site address in the form '<number> <Street> <Type>, <Suburb> VIC <postcode>' when the email states one, else a short project name, never invented>","client":"<the organisation asking, from the email>","deadline":"YYYY-MM-DD or null — ONLY a closing / due / submission date the email itself states, never a guess","reason":"<ten words>"}]}.`,
    `Never invent an address, a street number, a date or a company. Keep the ids exactly.`,
    `EMAILS:\n${JSON.stringify(rows, null, 1)}`,
  ].join("\n\n");
}
export function parseTenderReview(text, cands) {
  const ids = new Set(cands.map((c) => c.messageId));
  let obj = null;
  try { obj = JSON.parse(String(text || "")); } catch { const m = /\{[\s\S]*\}/.exec(String(text || "")); if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } } }
  const out = {};
  const list = obj && Array.isArray(obj.reviews) ? obj.reviews : [];
  list.forEach((r) => {
    if (!r || !ids.has(String(r.id))) return;
    const deadline = typeof r.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.deadline) ? r.deadline : null;
    out[String(r.id)] = { tender: r.tender === true, confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low", projectName: typeof r.projectName === "string" ? r.projectName.trim().slice(0, 140) : "", client: typeof r.client === "string" ? r.client.trim().slice(0, 80) : "", deadline, reason: typeof r.reason === "string" ? r.reason.slice(0, 160) : "" };
  });
  return out;
}
/** Lay the AI's review over a candidate: a confident "not a tender" drops it; a stated address-convention name, a client and a stated deadline refine it. */
export function applyReview(cand, review) {
  if (!review) return { cand, drop: false };
  if (review.tender === false && review.confidence !== "low") return { cand, drop: true, why: review.reason || "the AI review read it as not a request" };
  const next = { ...cand };
  if (review.projectName && (!addressIn(cand.projectName) || addressIn(review.projectName))) next.projectName = review.projectName;
  if (review.client && (!cand.client || cand.client === cand.fromName || /^[a-z0-9]+$/i.test(cand.client))) next.client = review.client;
  if (review.deadline && review.deadline >= cand.receivedAt.slice(0, 10) && (cand.deadlineSource === "default" || review.deadline === cand.deadline)) { next.deadline = review.deadline; next.deadlineSource = cand.deadlineSource === "default" ? "ai" : cand.deadlineSource; }
  next.siteAddress = next.siteAddress || addressIn(next.projectName);
  return { cand: next, drop: false };
}
export const DEADLINE_SOURCE_LABEL = { email: "the closing date stated in the email", ai: "the closing date read from the email", default: `no closing date in the email — set ${DEFAULT_TENDER_DAYS} days from receipt` };
