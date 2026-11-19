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
export const SCOPE_RESULT_KEYS = ["items", "gaps", "exclusions", "questions", "documents", "unreadable"];

const clean = (v, max = 240) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** FNV-1a of the normalised words — the stable id of an item or a gap. */
export function scopeId(prefix, ...parts) {
  const s = parts.map((p) => String(p || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return prefix + ("00000000" + h.toString(16)).slice(-8);
}

export function scopePrompt({ projectName, types = [], hasDocuments = false, text = "" } = {}) {
  const typeList = (types || []).slice(0, 220).map((t) => `${t.id} = ${t.label}${t.group ? ` (${t.group})` : ""}`).join("\n");
  return `Read EVERYTHING supplied for "${clean(projectName, 160) || "this project"}" as the estimator of a concrete subcontractor preparing a tender${hasDocuments ? ": the attached drawings, specification pages, screenshots and other documents" : ""}${text ? `${hasDocuments ? ", and" : ":"} the emails, messages and notes pasted at the end of this message` : ""}. Find the scope of work these put on the concrete subcontractor, with the specification each document gives for it, and point out what could be missing or overlooked.

Return ONE JSON object in this shape (compact: omit null and empty keys; quotes under 140 characters):
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
   "confidence": number          // 0 to 1
 }],
 "gaps": [{
   "title": string,              // worded as something to CHECK: "No vapour barrier or sub-base shown under the ground slab — confirm"
   "why": string,                // what it could cost or cause if missed
   "basis": "documents"|"practice",
   "relatesTo": string|null,     // the item title it concerns
   "severity": "high"|"medium"|"low",
   "doc": string|null, "page": string|null, "quote": string|null
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
- At most ${SCOPE_MAX_ITEMS} items; put the costly and the easily missed ones first within each category.

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
    if (prev) { specs.forEach((s) => { if (!prev.specs.includes(s)) prev.specs.push(s); }); return; }
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
    });
  });
  const rank = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const exclusions = arr(raw.exclusions).map((e) => (typeof e === "string" ? { text: clean(e, 300) } : { text: clean(e && e.text, 300), ...sourceOf(e) })).filter((e) => e.text).slice(0, 60)
    .map((e) => ({ id: scopeId("ex_", e.text), ...e }));
  const questions = arr(raw.questions).map((q) => clean(q, 300)).filter(Boolean).slice(0, 40);
  const documents = arr(raw.documents).map((d) => ({ name: clean(d && d.name, 160), kind: clean(d && d.kind, 40) || "other", title: clean(d && d.title, 160) || null, revision: clean(d && d.revision, 40) || null, date: clean(d && d.date, 40) || null })).filter((d) => d.name || d.title).slice(0, 40);
  const unreadable = arr(raw.unreadable).map((u) => clean(u, 240)).filter(Boolean).slice(0, 40);
  const items = [...byId.values()];
  if (!items.length && !gaps.length && !exclusions.length && !questions.length) return null;
  return { items, gaps, exclusions, questions, documents, unreadable };
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
