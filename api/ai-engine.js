/**
 * Vercel serverless function behind the portal's AI Engine (portal/ai-engine.html).
 * POST {action, provider?, files:[{url, name}], ...} → {result, provider, model, latencyMs, usage}.
 *
 *   action "takeoff"  reads a set of structural drawings (PDFs already in the
 *                     gradcon-files bucket, public URLs) and proposes the
 *                     concrete elements as Estimates element types with their
 *                     geometry, bars, sheet reference and a confidence.
 *   action "qa"       explains the deterministic quality-check findings of a
 *                     Quotes project (src/lib/qualityChecks.js) in plain words:
 *                     what to look at first and why — text, never a new finding.
 *   action "spec"     reads a specification / tender document and lists the
 *                     applicable standards, the requirements that change how
 *                     an element is measured or priced (grade, cover, exposure,
 *                     reinforcement grade, laps, minimum member sizes,
 *                     tolerances, testing, curing) and anything unusual — every
 *                     item with its page and the sentence it came from.
 *
 * The model only ever PROPOSES: nothing here writes a quote or a takeoff. The
 * browser shows the proposal for review and only an explicit Export creates a
 * new takeoff in Estimates' "AI drafts" group. Keys live in api/_providers.js
 * (Vercel Environment Variables); the provider is the one chosen in Settings
 * when it is configured, else the default. Same-origin check as ai-providers.
 */
import { callDocuments, callText, resolveProviderId, parseJsonLoose, salvageArrays, providerStatus } from "./_providers.js";

export const config = { maxDuration: 300 };

const MAX_FILES = 12;
const MAX_TYPES = 200;

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

const SYSTEM = `You are a senior concrete estimator at Gradcon Concrete Constructions in Melbourne, Australia (AS 3600 / AS 2870 practice, D500N reinforcement, N-grade concrete, millimetres on drawings).
You read structural drawings and specifications for a concrete subcontractor's tender. You only report what the documents show; where a value is not on the documents you say so (null) rather than guess, and you quote the sentence or schedule entry you read it from. You never invent standards text or clause numbers. Reply with ONE JSON object and nothing else — no markdown fences, no prose before or after.`;

export function takeoffPrompt({ types, projectName, profile }) {
  const typeList = (types || []).map((t) => `${t.id} — ${t.label} (${t.group})`).join("\n");
  const prof = profile ? `\nA specification profile was read earlier for this project; use it for grades and covers where the drawings are silent:\n${JSON.stringify(profile).slice(0, 4000)}\n` : "";
  return `Read every sheet of the attached structural drawings for "${projectName || "this project"}" and list EVERY concrete element a concrete subcontractor would price: footings, piers/piles, pile caps, ground beams, slabs (on ground, suspended, raft, waffle), beams, columns, walls, retaining walls, stairs, kerbs, pits, tanks, plinths, roof elements, external works. Use the footing / beam / column / slab schedules and the plans together: one entry per schedule mark (e.g. PF1, SF2, B3) with the number of that mark counted on the plans, or one entry per distinct slab / wall.
${prof}
Element types available (use the id exactly; pick the closest; "compositeassembly" for an irregular assembly):
${typeList}

Return this JSON shape:
{
 "project": {"name": string|null, "address": string|null, "engineer": string|null, "drawingRevision": string|null, "concreteGrades": [string], "reoGrade": string|null, "coverNotes": string|null},
 "sheets": [{"ref": string, "title": string, "revision": string|null}],
 "elements": [
  {"type": "<id>", "label": string, "mark": string|null, "sheet": string, "qty": number|null,
   "length_mm": number|null, "width_mm": number|null, "depth_mm": number|null, "height_mm": number|null, "diameter_mm": number|null, "area_m2": number|null,
   "grade": number|null, "cover_mm": number|null,
   "bars": {"main": {"dia": string|null, "qty": number|null, "spacing_mm": number|null, "where": string|null},
            "cross": {"dia": string|null, "spacing_mm": number|null},
            "top": {"dia": string|null, "qty": number|null, "spacing_mm": number|null},
            "ligatures": {"dia": string|null, "spacing_mm": number|null},
            "mesh": string|null, "top_mesh": string|null},
   "confidence": "high"|"medium"|"low", "evidence": string, "notes": string}
 ],
 "unreadable": [string], "assumptions": [string]
}
Output rules: write the JSON compactly — no indentation, no line breaks inside it, and OMIT every key whose value would be null. Keep "evidence" under 80 characters and "notes" under 80 characters. One entry per schedule mark with its qty, never one entry per instance. If the set holds more than 120 elements, list the largest and most repeated first.
Rules: dimensions in millimetres (area in m²); for a slab give length_mm × width_mm of its plan extent or area_m2 when the plan is irregular, and depth_mm = thickness; for a pier give diameter_mm and length_mm = depth; for a wall give length_mm, height_mm, depth_mm = thickness; grade as the number (32 for N32); bar sizes as "N12" / "N16"; mesh as "SL82" / "SL72". qty is how many of that element (count the marks on the plan). confidence is "high" when the schedule and plan agree, "medium" when one is read off a plan dimension, "low" when inferred. evidence quotes the schedule row or note (short). notes says what the estimator must check. Keep labels short ("PF1 pad footing 1200×1200×600"). List everything you can read; do not stop early.`;
}

export function specPrompt({ projectName }) {
  return `Read the attached specification / tender document(s) for "${projectName || "this project"}" as a concrete subcontractor. Extract everything that changes how concrete, reinforcement, formwork or excavation is measured, bought or priced. Quote the sentence each item came from and give the page number in the PDF.

Return this JSON shape:
{
 "document": {"title": string|null, "revision": string|null, "date": string|null, "author": string|null},
 "standards": [{"designation": string, "code": "ncc"|"as3600"|"as2870"|"as4671"|"as1379"|"as3610"|"as2159"|"as1170"|"as3735"|"as5100"|"other", "title": string|null, "page": number, "quote": string}],
 "requirements": [{"category": "concrete"|"cover"|"exposure"|"reinforcement"|"laps"|"formwork"|"tolerances"|"testing"|"curing"|"minimums"|"excavation"|"other",
                   "element": "all"|"footings"|"piers"|"slabs"|"beams"|"columns"|"walls"|"stairs"|"kerbs"|"other",
                   "text": string, "value": string|null, "page": number, "quote": string}],
 "defaults": {"concreteGradeByElement": {"footings": string|null, "piers": string|null, "slabs": string|null, "beams": string|null, "columns": string|null, "walls": string|null, "stairs": string|null, "kerbs": string|null, "all": string|null},
              "coverByElement": {"footings": number|null, "piers": number|null, "slabs": number|null, "beams": number|null, "columns": number|null, "walls": number|null, "stairs": number|null, "kerbs": number|null, "all": number|null},
              "exposureClass": string|null, "reoGrade": string|null, "lapRule": string|null, "slump": string|null, "aggregate": string|null,
              "minMemberSizes": [{"element": string, "minimum": string, "page": number, "quote": string}]},
 "unusual": [{"text": string, "page": number, "quote": string}],
 "unreadable": [string]
}
Output rules: write the JSON compactly — no indentation, and omit keys whose value would be null; keep every "quote" under 160 characters.
Rules: "code" is the matching family of the standard's designation (AS 3600 → "as3600", NCC → "ncc", anything else → "other") and "designation" is the exact text on the page including year and amendment where printed. Grades as "N32" / "S40"; covers in mm. A requirement that applies to every element is element "all". "unusual" is anything a concrete subcontractor would not expect and must price (special finishes, waterproofing admixtures, hold points, out-of-hours work, crane limits, staged pours). Do not list standards or clauses that are not on the pages. List everything relevant; do not stop early.`;
}

function validFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return "files must be a non-empty array of {url, name}";
  if (files.length > MAX_FILES) return `at most ${MAX_FILES} files per job`;
  for (const f of files) {
    if (!f || typeof f.url !== "string") return "every file needs a url";
    let u; try { u = new URL(f.url); } catch { return `not a URL: ${f.url}`; }
    if (u.protocol !== "https:") return "file URLs must be https";
    if (!/\.pdf(\?|$)/i.test(u.pathname)) return "PDF files only for now";
  }
  return null;
}

/**
 * The job itself, separated from the HTTP handler so verify.mjs can exercise
 * validation and the no-provider path without a network.
 */
export function qaPrompt({ project, findings }) {
  return `Quality checks ran on the Gradcon estimating project "${(project && project.name) || "project"}" (status ${(project && project.status) || "?"}). Project summary: ${JSON.stringify((project && project.summary) || {})}.

The deterministic checks found these items (each is a verified fact from the costing library; do not add, remove or re-rate any):
${JSON.stringify(findings, null, 1).slice(0, 14000)}

Write the review note an experienced concrete estimator would hand Grady before this quote goes out: (1) the three things to look at first and why, in order of money at risk; (2) one line per remaining finding grouping the similar ones; (3) what is probably fine and can be acknowledged. Plain English, Australian terms, no headings longer than a few words, no markdown tables, under 350 words. Never invent a figure that is not in the findings.`;
}

export async function runAiJob(body, env = process.env) {
  const { action, provider, files, types, projectName, profile } = body || {};
  if (action === "qa") {
    const findings = Array.isArray(body.findings) ? body.findings : null;
    if (!findings) return { status: 400, body: { error: "qa needs findings: [...]" } };
    const id = resolveProviderId(provider, env);
    if (!id) return { status: 503, body: { error: "No AI provider is configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY in the Vercel project's Environment Variables." } };
    try {
      const r = await callText(id, { system: SYSTEM.replace("Reply with ONE JSON object and nothing else — no markdown fences, no prose before or after.", "Reply in plain prose."), prompt: qaPrompt({ project: body.project, findings: findings.slice(0, 60) }), maxTokens: 1500, timeoutMs: 110000, env });
      return { status: 200, body: { text: r.text, provider: r.provider, model: r.model, latencyMs: r.latencyMs } };
    } catch (e) {
      return { status: e.status && e.status >= 400 && e.status < 600 ? e.status : 502, body: { error: e.message, detail: e.detail || null, provider: id } };
    }
  }
  if (action !== "takeoff" && action !== "spec") return { status: 400, body: { error: 'Body must carry action "takeoff", "spec" or "qa"' } };
  const bad = validFiles(files);
  if (bad) return { status: 400, body: { error: bad } };
  if (action === "takeoff" && (!Array.isArray(types) || types.length === 0 || types.length > MAX_TYPES)) return { status: 400, body: { error: "takeoff needs the element type list (types: [{id, label, group}])" } };
  const id = resolveProviderId(provider, env);
  if (!id) return { status: 503, body: { error: "No AI provider is configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY in the Vercel project's Environment Variables." } };
  const prompt = action === "takeoff" ? takeoffPrompt({ types, projectName, profile }) : specPrompt({ projectName });
  let r;
  try {
    r = await callDocuments(id, { system: SYSTEM, prompt, documents: files.map((f) => ({ url: f.url, name: f.name })), maxTokens: action === "takeoff" ? 16000 : 12000, env });
  } catch (e) {
    const st = providerStatus(env).find((p) => p.id === id);
    return { status: e.status && e.status >= 400 && e.status < 600 ? e.status : 502, body: { error: e.message, detail: e.detail || null, provider: id, model: st ? st.model : null } };
  }
  let result = parseJsonLoose(r.text);
  let partial = null;
  if (!result) {
    // A cut-off reply: keep every element / standard / requirement that was written in full.
    const keys = action === "takeoff" ? ["elements", "sheets", "unreadable", "assumptions"] : ["standards", "requirements", "unusual", "unreadable"];
    const got = salvageArrays(r.text, keys);
    const n = got ? ((got.elements || got.standards || []).length) : 0;
    if (got && n > 0) {
      result = got;
      partial = { reason: r.truncated ? "The reply was cut off at the model's output limit" : "The reply was not a complete JSON object", kept: n, advice: "What was read is shown. Run again with fewer sheets, or split the set into two jobs and merge the exports in Estimates." };
    }
  }
  if (!result) return { status: 502, body: { error: `${id} replied without a readable JSON result${r.truncated ? " (the reply was cut off — fewer sheets per job)" : ""}`, provider: r.provider, model: r.model, raw: String(r.text || "").slice(0, 2000) } };
  return { status: 200, body: { result, provider: r.provider, model: r.model, latencyMs: r.latencyMs, usage: r.usage || null, truncated: !!r.truncated, partial } };
}

export default async function handler(req, res) {
  const own = fromOwnOrigin(req);
  if (own !== true) { res.status(403).json({ error: "The AI Engine runs from the Gradcon portal only." }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const out = await runAiJob(req.body || {});
  res.setHeader("cache-control", "no-store");
  res.status(out.status).json(out.body);
}
