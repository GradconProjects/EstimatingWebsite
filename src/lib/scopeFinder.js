/**
 * Scope finder — the reading rules and the reply parser (pure; no DOM, no
 * network). Boma, 19 Nov 2026: "i want extra accuracy and would like to build
 * in a scope finder and analyser and place it in the estimates section. so i
 * can upload project drawing and emails chats etc and it should hightlight all
 * the scope items and their specifications where applicable. it should live
 * behind a button i can press and possibly tick a checklist. it should list all
 * the salient and obvious scope items required and if possible flag something
 * that could possibly be missing or overlooked".
 *
 * `api/ai-engine.js` action "scope" runs `scopePrompt` over the attached PDFs /
 * images and the pasted text, and returns `parseScopeResult` of the reply. The
 * Estimates page (portal/estimates-app.html + portal/estimates-scope.js) shows
 * the result as a checklist. Three rules the prompt and the parser hold:
 *   1. a scope item is something a DOCUMENT shows or says — every item carries
 *      the document, the page and a short quote, or is marked "implied" with
 *      the reason; a specification is only what is written, never a typical
 *      value;
 *   2. a "possibly missing" entry is a QUESTION to check, labelled by its
 *      basis: "documents" (a conflict, a missing detail / schedule / report, an
 *      element with no size or grade, unclear responsibility) or "practice"
 *      (work that normally accompanies a listed item and no document mentions);
 *   3. ids are STABLE across runs — a hash of the category and the title — so a
 *      tick made on one run stays on the same item after the next.
 */

export const SCOPE_CATEGORIES = [
  ["prelims", "Preliminaries, access & site"],
  ["earthworks", "Earthworks & excavation"],
  ["piling", "Piling & retention"],
  ["footings", "Footings & ground beams"],
  ["groundslabs", "Slabs on ground"],
  ["suspended", "Suspended slabs & beams"],
  ["vertical", "Columns & walls"],
  ["stairs", "Stairs & ramps"],
  ["precast", "Precast & tilt-up"],
  ["reinforcement", "Reinforcement"],
  ["formwork", "Formwork"],
  ["concrete", "Concrete supply, placing & curing"],
  ["waterproofing", "Waterproofing & membranes"],
  ["joints", "Joints, dowels & finishes"],
  ["drainage", "Drainage & backfill"],
  ["external", "External works & paving"],
  ["testing", "Testing & compliance"],
  ["other", "Other"],
];
const CATEGORY_KEYS = SCOPE_CATEGORIES.map((c) => c[0]);
export const scopeCategoryLabel = (key) => (SCOPE_CATEGORIES.find((c) => c[0] === key) || SCOPE_CATEGORIES[SCOPE_CATEGORIES.length - 1])[1];

/** What one run may carry. Text over the limit is REFUSED, never cut: a silently truncated email is a scope item nobody was told was unread. */
export const SCOPE_MAX_FILES = 12;
export const SCOPE_MAX_TEXT_CHARS = 150000;
export const SCOPE_MAX_ITEMS = 160;
export const SCOPE_RESULT_KEYS = ["items", "gaps", "exclusions", "questions", "references", "documents", "unreadable"];
export const SCOPE_MAX_REFERENCES = 80;
export const SCOPE_REF_KINDS = ["drawing", "detail", "schedule", "report", "specification", "standard", "other"];
/**
 * A long set is read IN PARTS (20 Nov 2026 — five drawings in one read ran the
 * reply into the model's output limit: 45 items were kept and everything after
 * them, the whole "possibly missing" list included, was lost). One reply lists
 * at most this many items and says `"more": true` when scope remains; the page
 * asks again with the titles ALREADY LISTED until a reply says there is no
 * more, and only that last reply carries the gaps, exclusions and questions —
 * for the whole set.
 */
export const SCOPE_ITEMS_PER_REPLY = 30;
export const SCOPE_MAX_ALREADY = 400;
/** The titles a continuation is told not to repeat: trimmed, deduped, capped. */
export function scopeAlreadyList(already) {
  const seen = new Set(); const out = [];
  (Array.isArray(already) ? already : []).forEach((t) => { const c = clean(t, 160); const k = c.toLowerCase(); if (c && !seen.has(k)) { seen.add(k); out.push(c); } });
  return out.slice(0, SCOPE_MAX_ALREADY);
}

const clean = (v, max = 240) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** FNV-1a of the normalised words — the stable id of an item or a gap. */
export function scopeId(prefix, ...parts) {
  const s = parts.map((p) => String(p || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return prefix + ("00000000" + h.toString(16)).slice(-8);
}

export function scopePrompt({ projectName, types = [], hasDocuments = false, text = "", already = [] } = {}) {
  const done = scopeAlreadyList(already);
  const typeList = (types || []).slice(0, 220).map((t) => `${t.id} = ${t.label}${t.group ? ` (${t.group})` : ""}`).join("\n");
  return `Read EVERYTHING supplied for "${clean(projectName, 160) || "this project"}" as the estimator of a concrete subcontractor preparing a tender${hasDocuments ? ": the attached drawings, specification pages, screenshots and other documents" : ""}${text ? `${hasDocuments ? ", and" : ":"} the emails, messages and notes pasted at the end of this message` : ""}. Find the scope of work these put on the concrete subcontractor, with the specification each document gives for it, and point out what could be missing or overlooked.

Return ONE JSON object in this shape. Keep it COMPACT so the whole list fits: omit null and empty keys, omit "basis" when it is "stated", "party" when it is "ours" and "type" when no id fits; quotes under 100 characters; at most 8 "specs" per item, each a few words.
{
 "documents": [{"name": string, "kind": "structural drawings"|"architectural drawings"|"civil drawings"|"specification"|"geotechnical report"|"email"|"message"|"schedule"|"other", "title": string|null, "revision": string|null, "date": string|null}],
 "items": [{
   "title": string,              // the scope item in an estimator's words: "Strip footings SF1 / SF2", "Slab on ground 150 mm", "Vapour barrier under slab"
   "category": ${CATEGORY_KEYS.map((k) => `"${k}"`).join("|")},
   "type": string|null,          // the element-type id from the list below that fits best, or null for a work item that is not an element
   "where": string|null,         // marks, grid lines, levels or areas it applies to
   "specs": [string],            // each specification fact AS WRITTEN: "N32", "150 thick", "SL82 top, 30 cover", "N12-200 EW", "Class 2 off-form finish", "0.2 mm polyethylene membrane"
   "quantity": string|null,      // a count, length, area or volume ONLY where a document states one
   "basis": "stated"|"implied",  // stated = a document draws or says it; implied = not written, but required by something that is
   "because": string|null,       // for "implied": what in the documents requires it
   "party": "ours"|"others"|"unclear",   // who the documents make responsible ("by builder", "by others", "NIC" = others)
   "doc": string|null, "page": string|null, "quote": string|null,   // where it was read
   "via": "email"|"document",    // "document" = an attached file; "email" = anything in the EMAILS / MESSAGES text at the end (emails, chats, notes)
   "also": [{"doc": string, "page": string|null, "quote": string|null, "via": "email"|"document"}]   // up to 2 OTHER places that mention the same item — a drawing and an email, two emails
 }],
 "more": boolean,                // true when scope items remain that this reply did not list (see PARTS below)
 "gaps": [{
   "title": string,              // worded as something to CHECK: "No vapour barrier or sub-base shown under the ground slab — confirm"
   "why": string,                // what it could cost or cause if missed
   "basis": "documents"|"practice",
   "relatesTo": string|null,     // the item title it concerns
   "severity": "high"|"medium"|"low",
   "doc": string|null, "page": string|null, "quote": string|null, "via": "email"|"document"
 }],
 "references": [{                // every drawing sheet, detail, schedule, report or specification that a document or message REFERS to by number or name
   "ref": string,                // as written: "S-05", "Detail 7/S-05", "Geotechnical report by Civiltest ref 1234", "A-201 rev C"
   "what": string|null,          // what it is said to contain, in a few words
   "kind": "drawing"|"detail"|"schedule"|"report"|"specification"|"standard"|"other",
   "doc": string|null, "page": string|null, "quote": string|null, "via": "email"|"document",   // where the reference is made
   "found": {"doc": string, "page": string|null}|null   // where that sheet or document itself is in the set you read; null when it is referred to and NOT in the set
 }],
 "exclusions": [{"text": string, "doc": string|null, "page": string|null, "quote": string|null}],
 "questions": [string],          // the clarifications worth sending to the builder or engineer
 "unreadable": [string]          // sheets, pages or attachments you could not read, and why
}

RULES
- "items": one entry per distinct element type or work item; merge repeats and give their marks in "where". Cover the structural elements (footings, piers, piles, pile caps, slabs, beams, columns, walls, cores, stairs, ramps, retaining walls, kerbs, paving, pits, tanks) AND the work that goes with them wherever a document names it: excavation and spoil, blinding and sub-base, membranes and waterproofing, formwork and its finish class, reinforcement supply and fixing, starter bars and dowels, joints and sealants, cast-in items, pumping and cranage, curing, testing and inspections, access, traffic management, temporary works, surveys, clean-up.
- Scope asked for or changed in an EMAIL or MESSAGE counts exactly as a drawing does, and a later message overrides an earlier one — say so in "because" or raise it as a gap when they disagree.
- Every item needs its "doc", "page" and "quote", or "basis": "implied" with "because". Never write a dimension, grade, bar size, spacing, cover or finish that is not on the documents — leave "specs" short rather than fill it from typical practice.
- "gaps" are QUESTIONS, never findings of fact. "documents" basis: two documents disagree; a detail, schedule, section or report is referred to and not in the set; an element is drawn with no size, grade or reinforcement; a message asks for work no drawing shows; responsibility is unclear. "practice" basis: work that normally accompanies an item you listed and that NO document mentions either way (for example a slab on ground with no membrane or sub-base noted, a suspended slab with no back-propping note, a retaining wall with no drainage, no allowance stated for pumping, cranage, access or testing). List only gaps that relate to something in these documents; do not pad the list.
- "exclusions": every statement that work is by others, not in contract, excluded or supplied by the builder.
- "via": say for every item, gap and reference whether it was read in an attached file ("document") or in the emails / messages text ("email"). When both mention an item, give the clearer one as its source and the other under "also" — the estimator must be able to see every place a scope item is asked for.
- "references": list each referred-to document once. A sheet number on a drawing's own title block is not a reference; "refer to detail 7 on S-05", "as per the geotechnical report", "see architectural drawings", "to engineer's specification" are. "found" only when you actually read that sheet or document in this set — never assume it is there.
- Put the costly and the easily missed items first.

PARTS
- List at most ${SCOPE_ITEMS_PER_REPLY} items in this reply. If the documents hold more scope items than that, stop at ${SCOPE_ITEMS_PER_REPLY}, set "more": true and leave "gaps", "references", "exclusions" and "questions" out — you will be asked to continue and they belong in the last reply only.
- When this reply completes the list, set "more": false and give the "gaps", "references", "exclusions" and "questions" for the WHOLE set${done.length ? ", counting the items already listed below as part of it" : ""}.${done.length ? `

ALREADY LISTED — earlier replies listed these ${done.length} items. Do NOT repeat them; list only scope items that are NOT in this list (there may be none — then "items" is empty and "more" is false):
${done.map((t) => `- ${t}`).join("\n")}` : ""}

ELEMENT TYPE IDS ("type")
${typeList || "(none supplied — use null)"}${text ? `

PASTED EMAILS, MESSAGES AND NOTES
${text}` : ""}`;
}

function sourceOf(o) {
  const out = {};
  const doc = clean(o && o.doc, 160), page = clean(o && o.page, 40), quote = clean(o && o.quote, 260);
  if (doc) out.doc = doc; if (page) out.page = page; if (quote) out.quote = quote;
  return out;
}

/**
 * The model's reply → the shape the page shows. Unknown categories fall to
 * "other", an element type the caller did not offer is dropped, strings are
 * trimmed and capped, duplicates by id are merged (specs unioned), and every
 * entry gains its stable id. Returns null when the reply holds nothing usable.
 */
/** "email" or "document": the reader's word, else read off the source's name (an email, a message, a chat or a note is "email"). */
export function viaOf(via, doc) {
  if (via === "email" || via === "document") return via;
  return /\b(e-?mail|message|chat|whatsapp|sms|text|note|pasted)\b/i.test(String(doc || "")) ? "email" : "document";
}
const mentionKey = (m) => `${String(m.doc || "").toLowerCase()}|${String(m.page || "")}|${String(m.quote || "").toLowerCase()}`;
function pushMention(list, m) {
  if (!m || (!m.doc && !m.quote)) return list;
  const one = { doc: m.doc || null, page: m.page || null, quote: m.quote || null, via: viaOf(m.via, m.doc) };
  if (list.length < 6 && !list.some((x) => mentionKey(x) === mentionKey(one))) list.push(one);
  return list;
}
/** Every place an item is mentioned: its own source first, then the others — each once, at most six. */
function mentionsOf(item, also) {
  const list = Array.isArray(item.mentions) ? item.mentions.slice() : [];
  pushMention(list, { doc: item.doc, page: item.page, quote: item.quote, via: item.via });
  (Array.isArray(also) ? also : []).forEach((a) => { if (a && typeof a === "object") pushMention(list, { doc: clean(a.doc, 160) || null, page: a.page == null ? null : clean(a.page, 20) || null, quote: clean(a.quote, 200) || null, via: a.via }); });
  return list;
}

export function parseScopeResult(raw, { types = [] } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const known = new Set((types || []).map((t) => t.id));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const byId = new Map();
  arr(raw.items).forEach((it) => {
    if (!it || typeof it !== "object") return;
    const title = clean(it.title, 200); if (!title) return;
    const category = CATEGORY_KEYS.includes(it.category) ? it.category : "other";
    const id = scopeId("sc_", category, title);
    const specs = arr(it.specs).map((s) => clean(s, 160)).filter(Boolean);
    const prev = byId.get(id);
    if (prev) { specs.forEach((s) => { if (!prev.specs.includes(s)) prev.specs.push(s); }); prev.mentions = mentionsOf(prev, [{ ...sourceOf(it), via: it.via }].concat(arr(it.also))); return; }
    if (byId.size >= SCOPE_MAX_ITEMS) return;
    const conf = Number(it.confidence);
    const item = {
      id, title, category,
      type: known.has(it.type) ? it.type : null,
      where: clean(it.where, 200) || null,
      specs: specs.slice(0, 16),
      quantity: clean(it.quantity, 120) || null,
      basis: it.basis === "implied" ? "implied" : "stated",
      because: clean(it.because, 260) || null,
      party: it.party === "others" || it.party === "unclear" ? it.party : "ours",
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
      ...sourceOf(it),
    };
    item.via = viaOf(it.via, item.doc);
    item.mentions = mentionsOf(item, it.also);
    byId.set(id, item);
  });
  const gapIds = new Set();
  const gaps = [];
  arr(raw.gaps).forEach((g) => {
    if (!g || typeof g !== "object") return;
    const title = clean(g.title, 240); if (!title) return;
    const id = scopeId("gp_", title); if (gapIds.has(id)) return; gapIds.add(id);
    gaps.push({
      id, title,
      why: clean(g.why, 300) || null,
      basis: g.basis === "practice" ? "practice" : "documents",
      relatesTo: clean(g.relatesTo, 200) || null,
      severity: ["high", "medium", "low"].includes(g.severity) ? g.severity : "medium",
      ...sourceOf(g),
      via: viaOf(g.via, sourceOf(g).doc),
    });
  });
  const rank = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const exclusions = arr(raw.exclusions).map((e) => (typeof e === "string" ? { text: clean(e, 300) } : { text: clean(e && e.text, 300), ...sourceOf(e) })).filter((e) => e.text).slice(0, 60)
    .map((e) => ({ id: scopeId("ex_", e.text), ...e }));
  const questions = arr(raw.questions).map((q) => clean(q, 300)).filter(Boolean).slice(0, 40);
  const refById = new Map();
  arr(raw.references).forEach((r) => {
    if (!r || typeof r !== "object") return;
    const ref = clean(r.ref, 160); if (!ref) return;
    const id = scopeId("rf_", ref);
    const cited = { ...sourceOf(r), via: viaOf(r.via, sourceOf(r).doc) };
    const found = r.found && typeof r.found === "object" && clean(r.found.doc, 160) ? { doc: clean(r.found.doc, 160), page: r.found.page == null ? null : clean(r.found.page, 20) || null } : null;
    const prev = refById.get(id);
    if (prev) { if (cited.doc || cited.quote) pushMention(prev.cited, cited); if (!prev.found && found) prev.found = found; return; }
    if (refById.size >= SCOPE_MAX_REFERENCES) return;
    refById.set(id, { id, ref, what: clean(r.what, 200) || null, kind: SCOPE_REF_KINDS.includes(r.kind) ? r.kind : "other", cited: cited.doc || cited.quote ? [cited] : [], found });
  });
  const references = [...refById.values()];
  const documents = arr(raw.documents).map((d) => ({ name: clean(d && d.name, 160), kind: clean(d && d.kind, 40) || "other", title: clean(d && d.title, 160) || null, revision: clean(d && d.revision, 40) || null, date: clean(d && d.date, 40) || null })).filter((d) => d.name || d.title).slice(0, 40);
  const unreadable = arr(raw.unreadable).map((u) => clean(u, 240)).filter(Boolean).slice(0, 40);
  const items = [...byId.values()];
  const more = raw.more === true;
  // a continuation may honestly hold nothing new ("items": [], "more": false) — that is an answer, not an unreadable reply
  if (!items.length && !gaps.length && !exclusions.length && !questions.length && !references.length && raw.more === undefined) return null;
  return { items, gaps, exclusions, questions, references, documents, unreadable, more };
}

const PDF_RE = /\.pdf(\?|$)/i, IMAGE_RE = /\.(png|jpe?g|webp|gif)(\?|$)/i;
/** A file the scope read can take: an https PDF or image. Returns "pdf" | "image" | null. */
export function scopeFileKind(url) {
  let u; try { u = new URL(String(url || "")); } catch { return null; }
  if (u.protocol !== "https:") return null;
  return PDF_RE.test(u.pathname) ? "pdf" : IMAGE_RE.test(u.pathname) ? "image" : null;
}

/** Validates one request. Returns an error string, or null when it may run. */
export function scopeRequestError({ files, text } = {}) {
  const list = Array.isArray(files) ? files : [];
  const t = String(text || "");
  if (!list.length && !t.trim()) return "Nothing to read — attach a drawing or document, or paste the emails and messages.";
  if (list.length > SCOPE_MAX_FILES) return `At most ${SCOPE_MAX_FILES} files per run — run the rest as a second read.`;
  for (const f of list) {
    if (!f || typeof f.url !== "string") return "Every file needs a url.";
    if (!scopeFileKind(f.url)) return `Not a PDF or an image the reader can open: ${clean(f.name || f.url, 120)}`;
  }
  if (t.length > SCOPE_MAX_TEXT_CHARS) return `The pasted text is ${t.length.toLocaleString("en-AU")} characters; one run reads up to ${SCOPE_MAX_TEXT_CHARS.toLocaleString("en-AU")}. Remove some of it (nothing is cut off silently).`;
  return null;
}
