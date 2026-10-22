/**
 * Project names follow ONE address convention (Grady, 22 Oct 2026: "use the
 * API to rename the projects maintaining a proper convention, full address
 * and suburbs. when project is entered, the actual address convention should
 * automatically apply. where details are scanty, ask the user to select
 * address options"):
 *
 *     <number> <Street name> <Street type>, <Suburb> <STATE> <postcode>[ — <descriptor>]
 *     e.g. 19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion
 *
 * Pure: the convention test, the prompt the AI provider gets, the reader of
 * its reply and the patch a chosen option writes onto the quote. The
 * request itself (`requestProjectNames`) posts to api/ai-engine action
 * "address"; App.jsx asks on the editor's name field (blur) and the Dashboard
 * batches the existing projects through RenameProjectsModal. A person always
 * sees the result: a confident single answer is applied with an Undo, anything
 * less is a choice.
 */

const STATES = "VIC|NSW|QLD|SA|WA|TAS|NT|ACT";
const CONVENTION = new RegExp(`^(?:(?:Unit|Lot|Shop|Level)\\s+\\w+[,/]?\\s*)?(?:\\d+[A-Za-z]?\\/)?\\d+[A-Za-z]?(?:-\\d+[A-Za-z]?)?\\s+[A-Za-z][A-Za-z'.\\- ]+,\\s+[A-Za-z][A-Za-z'.\\- ]+\\s+(?:${STATES})\\s+\\d{4}(?:\\s+—\\s+.+)?$`);

/** Does a name already read as "<number> <Street>, <Suburb> VIC <postcode>[ — descriptor]"? */
export function isConventionName(name) {
  return CONVENTION.test(String(name || "").trim());
}

/** The typed name with nothing to go on at all (blank) is never asked about. */
export function needsAddressReview(quote) {
  const name = String((quote && quote.projectName) || "").trim();
  if (!name) return false;
  if (isConventionName(name)) return false;
  return (quote && quote.nameReviewedFor) !== name;
}

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

export function addressPrompt(rows) {
  const list = rows.map((r) => `- id ${JSON.stringify(String(r.id))}: ${JSON.stringify(clean(r.name))}${r.client ? ` (client: ${JSON.stringify(clean(r.client))})` : ""}`).join("\n");
  return `Gradcon Concrete Constructions (Melbourne, Victoria — most work is metropolitan Melbourne and the Mornington Peninsula) names every project by the site address, in this exact convention:

    <number> <Street name> <Street type>, <Suburb> <STATE> <postcode>[ — <descriptor>]
    e.g. "19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion", "2/12 Beach Road, Mentone VIC 3194"

Below are project names as typed by estimators. For EACH, propose the name in the convention.
Rules:
- Expand street-type abbreviations (Rd → Road, St → Street, Ave → Avenue, Cres → Crescent, Ct → Court, Dr → Drive, Pde → Parade, Hwy → Highway, Bvd → Boulevard, Pl → Place, Gr → Grove, Tce → Terrace, Esp → Esplanade, Cl → Close, Ln → Lane).
- Title-case the street and suburb; the state in capitals; the postcode is the suburb's real Australian postcode.
- Keep any words that are not the address (a building, a stage, "Tennis Pavilion", "Stage 2", "(from Estimates)" is NOT kept) as the descriptor after " — ".
- Victoria unless the typed text clearly says another state.
- NEVER invent a street number or a street that is not typed. If the suburb is not typed, give up to 3 real suburbs where that street exists in the Melbourne / Peninsula region as separate options, best first, and set confidence "low"; if the street itself is missing, give one option that keeps the typed words as the descriptor and set confidence "low".
- confidence "high" ONLY when the number, street and suburb are all typed (or the suburb is beyond doubt) and the postcode is certain; "medium" when one of them is inferred; "low" otherwise.

Projects:
${list}

Reply with ONE JSON object and nothing else:
{"projects":[{"id":"<id>","confidence":"high|medium|low","note":"<one short line, what was inferred or missing>","options":[{"name":"<the full name in the convention>","street":"<number + street>","suburb":"<Suburb>","state":"<STATE>","postcode":"<4 digits>","descriptor":"<descriptor or empty>"}]}]}`;
}

/** Read the model's reply: options by id (known ids only), each option's name
 *  checked against the convention, confidence normalised. */
export function parseAddressReply(text, rows) {
  let data = null;
  try { data = typeof text === "string" ? JSON.parse(text) : text; } catch { data = null; }
  if (!data) {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
  }
  const known = new Map((rows || []).map((r) => [String(r.id), r]));
  const out = {};
  const list = data && Array.isArray(data.projects) ? data.projects : [];
  list.forEach((p) => {
    if (!p || p.id == null || !known.has(String(p.id))) return;
    const options = (Array.isArray(p.options) ? p.options : []).map((o) => ({
      name: clean(o && o.name), street: clean(o && o.street), suburb: clean(o && o.suburb), state: clean(o && o.state).toUpperCase(), postcode: clean(o && o.postcode), descriptor: clean(o && o.descriptor),
    })).filter((o) => o.name && isConventionName(o.name)).slice(0, 4);
    if (!options.length) return;
    const confidence = ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low";
    out[String(p.id)] = { options, confidence, note: clean(p.note) };
  });
  return out;
}

/** A confident single answer is applied on its own; anything else is a choice. */
export function autoApplies(result) {
  return !!result && result.confidence === "high" && result.options.length === 1;
}

/** What a chosen option writes onto the quote: the name, the site address
 *  (used by the Drive folder match), the typed name kept, and the review mark
 *  so the same typed name is never asked about twice. */
export function applyNamePatch(quote, option, typed) {
  const from = clean(typed != null ? typed : quote && quote.projectName);
  return {
    projectName: option.name,
    siteAddress: [option.street, [option.suburb, option.state, option.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    nameSource: quote && quote.nameSource ? quote.nameSource : from,
    nameReviewedFor: option.name,
  };
}

/** Keep the typed name: mark it reviewed so the field stops asking. */
export function keepNamePatch(quote) {
  return { nameReviewedFor: clean(quote && quote.projectName) };
}

/** Ask the server (api/ai-engine action "address") for up to 40 names at once. */
export async function requestProjectNames(rows, { provider, fetchImpl, base } = {}) {
  const list = (rows || []).map((r) => ({ id: String(r.id), name: clean(r.name), client: clean(r.client) })).filter((r) => r.name).slice(0, 40);
  if (!list.length) throw new Error("No project names to review.");
  const f = fetchImpl || fetch;
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const res = await f(`${origin}/api/ai-engine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "address", provider: provider || undefined, projects: list }) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `The AI function answered ${res.status}`);
  return { results: (body && body.projects) || {}, provider: body && body.provider, model: body && body.model };
}
