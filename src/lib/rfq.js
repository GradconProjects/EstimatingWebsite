/**
 * Requests for quotation from a project (Grady, 23 Oct 2026: "when i am working
 * on an estimate and require an RFQ to be sent, i want the app to draft this
 * email and i should be able to select from the contractors for that
 * particular item and the email draft will be made for my approval and sent
 * [to] each of the selected contractors without mixing up their details, their
 * contact and their specific trades … industry standard formatting for the
 * subject … a separate one should be sent to each rather than a bcc or cc";
 * "email should have the name of the project, and also use the details of what
 * is available in the estimates sections as entered by the estimator to form
 * the quote, it should have options to … attach the drawings").
 *
 * Pure: no React, no DOM, no network. `rfqDrafts` builds ONE draft per
 * contractor from the same facts — the contact's own name and address, the
 * package, the project — so nothing of one contractor ever reaches another.
 * Sending is `api/gmail.js` action "send", one message per draft, only after the
 * person approved that draft.
 */
import { computeElementCost } from "./costing.js";
import { takeoffMatches, takeoffElementSpec } from "./tenderSpecContext.js";

/* The packages Gradcon buys in. `trade` is a Register trade group, `cap` a Register capability
 * (the contractors recorded as DOING it come first; those who said they do not are kept apart),
 * `rows` match the SUB CONTRACTORS quote rows and `types` the element type names that imply it. */
export const RFQ_PACKAGES = [
  { key: "screw", label: "Screw Piling", trade: "piling", cap: "screw", rows: /screw/i, types: /screw/i },
  { key: "bored", label: "Bored Pier Works", trade: "piling", cap: "bored", rows: /bored|pier/i, types: /bored|pier/i },
  { key: "cfa", label: "CFA Piling", trade: "piling", cap: "cfa", rows: /cfa/i, types: /cfa/i },
  { key: "retention", label: "Retention Piling & Shotcrete", trade: "piling", cap: "retention", rows: /retention|shotcrete|soldier/i, types: /retention|shotcrete|soldier|contiguous|secant/i },
  { key: "formwork", label: "Formwork", trade: "formwork", cap: "formwork", rows: /formwork/i, types: null },
  { key: "steelfix", label: "Steel Fixing", trade: "concreting", cap: "", rows: /steel fix/i, types: null },
  { key: "steelsupply", label: "Reinforcement Supply", trade: "reo", cap: "reo", rows: /steel supply/i, types: null },
  { key: "excavation", label: "Excavation & Earthworks", trade: "earthworks", cap: "excavation", rows: /excavation/i, types: /excavat|earthwork|bulk dig/i },
  { key: "pumping", label: "Concrete Pumping", trade: "pumping", cap: "pumping", rows: /pump/i, types: null },
  { key: "pt", label: "Post-Tensioning", trade: "pt", cap: "pt", rows: /post[- ]?tension|\bPT\b/i, types: /post[- ]?tension|\bPT\b/i },
  { key: "waterproofing", label: "Waterproofing", trade: "waterproofing", cap: "waterproof", rows: /waterproof|membrane/i, types: /waterproof|tank|pool/i },
  { key: "screed", label: "Screed & Toppings", trade: "screed", cap: "screed", rows: /screed|topping/i, types: /screed|topping/i },
  { key: "premix", label: "Premixed Concrete Supply", trade: "premix", cap: "premix", rows: null, types: null },
  { key: "concrete", label: "Concrete Works", trade: "concreting", cap: "placement", rows: null, types: null },
  { key: "other", label: "Other package", trade: "", cap: "", rows: null, types: null },
];
export const packageByKey = (key) => RFQ_PACKAGES.find((p) => p.key === key) || RFQ_PACKAGES[RFQ_PACKAGES.length - 1];
export const packageLabel = (key, custom) => (key === "other" ? String(custom || "").trim() || "Other package" : packageByKey(key).label);

const SUB_BAND = "SUB CONTRACTORS / TEMPORARY WORKS";
const qtyOf = (v) => (v === "" || v === null || v === undefined ? 0 : Number(v) || 0);
/** The subcontract quote rows an element carries with a quantity or a typed amount: [{name, qty}]. */
export function subcontractRows(item) {
  const out = [];
  const qtys = (item && item.qtys) || {}; const overrides = (item && item.rateOverrides) || {};
  for (const [key, v] of Object.entries(qtys)) {
    const [cat, name] = key.split("::"); if (cat !== SUB_BAND) continue;
    if (qtyOf(v) > 0 || overrides[key]) out.push({ name, qty: qtyOf(v) });
  }
  return out;
}
/** The packages the chosen elements imply, most likely first (the rows they carry, then their type names). */
export function suggestPackages(items, typeNameOf = () => "") {
  const score = {};
  for (const item of items || []) {
    const rows = subcontractRows(item).map((r) => r.name).join(" ");
    const type = String(typeNameOf(item) || "") + " " + String((item && item.label) || "");
    for (const p of RFQ_PACKAGES) {
      if (p.rows && p.rows.test(rows)) score[p.key] = (score[p.key] || 0) + 2;
      if (p.types && p.types.test(type)) score[p.key] = (score[p.key] || 0) + 1;
    }
  }
  return RFQ_PACKAGES.map((p) => p.key).filter((k) => score[k]).sort((a, b) => score[b] - score[a]);
}

const SUPPLY = new Set(["subcontractor", "supplier", "consultant", "service", "other"]);
/** The Register's contractors for a package: {does, unknown, not} — each sorted by evidence score. */
export function contractorsFor(orgs, pkg) {
  const p = typeof pkg === "string" ? packageByKey(pkg) : pkg;
  const pool = (orgs || []).filter((o) => o && SUPPLY.has(o.category) && o.status !== "Do not use" && o.status !== "Inactive" && (!p.trade || (o.tradeGroup || "") === p.trade));
  const bucket = (o) => { if (!p.cap) return "does"; const c = o.capabilities && o.capabilities[p.cap]; return c && c.status === "yes" ? "does" : c && c.status === "no" ? "not" : "unknown"; };
  const out = { does: [], unknown: [], not: [] };
  for (const o of pool) out[bucket(o)].push(o);
  for (const k of Object.keys(out)) out[k].sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.name).localeCompare(String(b.name)));
  return out;
}
/** Who the RFQ goes to: the primary contact with an email, else the first contact with one, else the organisation's own address. */
export function rfqContact(org) {
  const contacts = (org && Array.isArray(org.contacts) ? org.contacts : []).filter((c) => c && c.email);
  const c = contacts.find((x) => x.primary) || contacts[0] || null;
  const email = c ? c.email : (org && org.emails && org.emails[0]) || "";
  const name = c ? String(c.name || "").trim() : "";
  const firstName = name && !/@/.test(name) && !/inbox|team|sales|accounts|admin|estimating|info|office/i.test(name) ? name.split(/\s+/)[0] : "";
  return { name, email, firstName, role: c ? c.role || "" : "", contactId: c ? c.id : null };
}

export function dayPlus(days, from = new Date()) { const d = new Date(from); d.setDate(d.getDate() + days); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
export const fmtDay = (day) => { if (!day) return ""; const d = new Date(day + "T00:00:00"); return Number.isFinite(+d) ? d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : day; };

/** Industry form, as Gradcon's own RFQs read in the mailbox: "RFQ – Bored Pier Works – 45 Shoreham Road, Red Hill South". */
export const rfqSubject = ({ pkgLabel, projectName }) => `RFQ – ${pkgLabel} – ${projectName}`;

const n2 = (v) => (Math.round(v * 100) / 100).toLocaleString("en-AU");
/** What one element asks for: its measures, its subcontract rows, the estimator's description and the Estimates takeoff's own figures for it. */
export function elementScope(item, rates, projectScope, typeName = "", takeoffInstances = null) {
  const cost = computeElementCost(item, rates || {}, projectScope);
  const measures = [];
  if (qtyOf(item.measureNo) > 0) measures.push(`${n2(qtyOf(item.measureNo))} no.`);
  if (qtyOf(item.measureLm) > 0) measures.push(`${n2(qtyOf(item.measureLm))} lm`);
  if (qtyOf(item.measureM2) > 0) measures.push(`${n2(qtyOf(item.measureM2))} m²`);
  if (cost && cost.concreteQty > 0) measures.push(`${n2(cost.concreteQty)} m³ concrete`);
  const matches = takeoffInstances ? takeoffMatches(takeoffInstances, item.label) : [];
  const takeoff = matches.map((inst) => takeoffElementSpec(inst, 12));
  return { id: item.id, label: String(item.label || "").trim(), type: typeName, measures, items: subcontractRows(item).map((r) => r.name), description: String(item.description || "").trim(), takeoff };
}
const FIELD_LABELS = { grade: "concrete grade", beamGrade: "beam grade", blindingGrade: "blinding grade", cover: "cover", thickness: "thickness", depth: "depth", width: "width", length: "length", height: "height", dia: "diameter", diameter: "diameter", D: "depth", L: "length", W: "width", shape: "shape", meshType: "mesh", botMeshType: "bottom mesh", topMeshType: "top mesh", meshLayers: "mesh layers", botXDia: "bottom bars X", botXSpacing: "bottom X spacing", botYDia: "bottom bars Y", botYSpacing: "bottom Y spacing", topXDia: "top bars X", topXSpacing: "top X spacing", topYDia: "top bars Y", topYSpacing: "top Y spacing", qty: "number", count: "number", bars: "bars", barDia: "bar", ligDia: "ligatures", ligSpacing: "ligature spacing", spacing: "spacing" };
function takeoffLines(t) {
  const out = [];
  const fields = Object.entries(t.fields || {}).map(([k, v]) => `${FIELD_LABELS[k] || k} ${v}`);
  if (fields.length) out.push(`    As taken off (${t.type || "element"}): ${fields.join(", ")}`);
  for (const l of t.lines || []) out.push(`    ${l.group}: ${l.material}${l.spec ? " " + l.spec : ""} — ${n2(l.qty)} ${l.unit}`);
  return out;
}
/** The body of ONE RFQ: this contractor's name and contact, nobody else's. */
export function rfqText({ projectName, siteAddress = "", clientName = "", pkgLabel, org, contact, scopes = [], due, sender = {}, attachments = [], extraNotes = "" }) {
  const lines = [];
  lines.push(`Dear ${contact && contact.firstName ? contact.firstName : (org && org.name) || "Sir/Madam"},`, "");
  lines.push(`Gradcon Concrete Constructions invites ${org && org.name ? org.name : "you"} to submit a quotation for the ${pkgLabel} package on the project below.`, "");
  lines.push(`Project: ${projectName}`);
  if (siteAddress && siteAddress !== projectName) lines.push(`Site: ${siteAddress}`);
  if (clientName) lines.push(`Builder / client: ${clientName}`);
  lines.push(`Package: ${pkgLabel}`);
  if (due) lines.push(`Quotation required by: ${fmtDay(due)}, 5:00 pm`);
  lines.push("", "SCOPE OF WORKS");
  if (!scopes.length) lines.push("  As per the attached documents.");
  for (const s of scopes) {
    lines.push(`  ${s.label}${s.type && s.type !== s.label ? ` (${s.type})` : ""}${s.measures.length ? ` — ${s.measures.join(", ")}` : ""}`);
    if (s.items.length) lines.push(`    Items to price: ${s.items.join("; ")}`);
    if (s.description) lines.push(`    ${s.description}`);
    for (const t of s.takeoff || []) lines.push(...takeoffLines(t));
  }
  if (extraNotes && extraNotes.trim()) lines.push("", "NOTES", ...extraNotes.trim().split(/\r?\n/).map((l) => "  " + l));
  lines.push("", "DOCUMENTS");
  if (attachments.length) { lines.push("  Attached to this email:"); for (const a of attachments) lines.push(`  - ${a.name}`); }
  else lines.push("  Drawings and the geotechnical report are available on request.");
  lines.push("", "PLEASE INCLUDE IN YOUR QUOTATION",
    "  - Lump sum and unit rates, ex GST, with the basis of measurement",
    "  - Inclusions, exclusions and any assumptions or qualifications",
    "  - Validity period (30 days minimum requested) and lead time from order",
    "  - Site requirements (access, crane, power, water, hardstand) and any items by others",
    "  - Current public liability and workers compensation certificates, and your ABN");
  lines.push("", "Please reply to this email with your quotation. Call or email with any questions on the documents.", "");
  lines.push("Kind regards,", "", sender.name || "Boma Ipalibo", "Gradcon Concrete Constructions", sender.email || "projects@gradcon.com.au");
  if (sender.phone) lines.push(sender.phone);
  return lines.join("\n");
}
/** One independent draft per organisation — built from the same facts, never shared text objects. */
export function rfqDrafts({ orgs, projectName, siteAddress, clientName, pkgLabel, scopes, due, sender, attachments, extraNotes }) {
  return (orgs || []).map((org) => {
    const contact = rfqContact(org);
    return { id: `d-${org.id}`, orgId: org.id, orgName: org.name, trade: org.trade || "", contactName: contact.name, contactId: contact.contactId, email: contact.email, subject: rfqSubject({ pkgLabel, projectName }), text: rfqText({ projectName, siteAddress, clientName, pkgLabel, org, contact, scopes, due, sender, attachments, extraNotes }), approved: false, status: "draft" };
  });
}
/** What a project remembers of an RFQ round, and the 05 checklist step it ticks. */
export function rfqRecord({ pkgKey, pkgLabel, elementIds, due, by, sent, attachments = [] }, at = new Date().toISOString()) {
  return { id: `rfq-${at.replace(/[^0-9]/g, "").slice(0, 14)}-${pkgKey}`, at, by: by || null, package: pkgLabel, packageKey: pkgKey, elementIds: elementIds || [], due: due || null, attachments: attachments.map((a) => a.name), recipients: (sent || []).map((d) => ({ orgId: d.orgId, orgName: d.orgName, contactName: d.contactName, email: d.email, subject: d.subject, messageId: d.messageId || null, threadId: d.threadId || null, status: d.status || "sent", error: d.error || null })) };
}
export function rfqPatch(quote, record) {
  const rfqs = Array.isArray(quote && quote.rfqs) ? quote.rfqs : [];
  return { rfqs: [...rfqs, record] };
}
export const rfqsOf = (quote) => (quote && Array.isArray(quote.rfqs) ? quote.rfqs : []);
/* Which Drive files an RFQ carries on its own (Grady, 23 Oct 2026: "for each email with the keywords,
 * automatically attach the relevant files from the attached drive, bare minimum should be archi,
 * struct, soil report"). A file is tagged by the words in its name (and its folder's name); the
 * three REQUIRED classes are ticked for every package, the package's own words add more; a class
 * the folder lacks is said so, never silently skipped. */
export const ATTACH_CLASSES = [
  { key: "archi", label: "Architectural drawings", required: true, re: /\b(archi\w*|architect\w*|arch\b|a[- ]?\d{2,3}\b|ad[- ]?\d{2,3}\b|floor plan|site plan|elevation|section)/i },
  { key: "struct", label: "Structural drawings", required: true, re: /\b(struct\w*|structural|engineer\w*|eng\b|s[- ]?\d{2,3}\b|sd[- ]?\d{2,3}\b|footing plan|slab plan|reo\b|reinforc\w*)/i },
  { key: "soil", label: "Soil / geotechnical report", required: true, re: /\b(soil\w*|geotech\w*|geo[- ]?tech\w*|geotechnical|site investigation|bore ?log\w*|site classification|civil ?test|ground report)/i },
  { key: "pkg", label: "Package-specific", required: false, re: null },
];
const PACKAGE_WORDS = { screw: /screw|pile|piling/i, bored: /bored|pier|pile|piling/i, cfa: /cfa|pile|piling/i, retention: /retention|shotcrete|soldier|anchor|pile/i, formwork: /formwork|form\b/i, steelfix: /reo|reinforc|bar schedule|steel/i, steelsupply: /reo|reinforc|bar schedule|steel/i, excavation: /excavat|earthwork|survey|contour|level/i, pumping: /pour|site plan/i, pt: /post[- ]?tension|\bpt\b|tendon/i, waterproofing: /waterproof|membrane|tank/i, screed: /screed|finish|floor/i, premix: /pour|concrete/i, concrete: /concrete|slab|footing/i };
export function classifyFile(name, folderName = "", pkgKey = "") {
  const hay = `${name || ""} ${folderName || ""}`;
  const tags = [];
  for (const c of ATTACH_CLASSES) { if (c.re && c.re.test(hay)) tags.push(c.key); }
  const pw = PACKAGE_WORDS[pkgKey]; if (pw && pw.test(hay)) tags.push("pkg");
  return tags;
}
const ATTACHABLE_KINDS = new Set(["pdf", "image", "doc", "sheet", "slides", "cad", "other"]);
/** The project's Drive folder files as attachment options: tagged, the relevant ones pre-ticked. */
export function driveFolderOptions(files, pkgKey = "") {
  const out = [];
  for (const f of files || []) {
    if (!f || f.kind === "folder" || !ATTACHABLE_KINDS.has(f.kind || "other")) continue;
    const tags = classifyFile(f.name, f.folderName || "", pkgKey);
    out.push({ id: `drive:${f.id}`, kind: "drive", name: f.name, fileId: f.id, mimeType: f.mimeType || "", url: "", size: Number(f.size) || 0, folderName: f.folderName || "", tags, auto: tags.length > 0 });
  }
  out.sort((a, b) => (b.auto - a.auto) || String(a.name).localeCompare(String(b.name)));
  return out;
}
/** Which required classes the chosen attachments do not cover: [{key, label}]. */
export function missingAttachClasses(options, ticked) {
  const have = new Set(); for (const o of options || []) if (ticked.has(o.id)) for (const t of o.tags || []) have.add(t);
  return ATTACH_CLASSES.filter((c) => c.required && !have.has(c.key));
}
/** The attachable files for a round: the project's Drive files (copied into the bucket when ticked) and the drawings on the chosen elements. */
export function attachmentOptions(quote, items, markupUrl = () => "") {
  const out = [];
  for (const f of (quote && Array.isArray(quote.files) ? quote.files : [])) if (f && f.provider === "drive") out.push({ id: `drive:${f.fileId || f.id}`, kind: "drive", name: f.name, fileId: f.fileId, mimeType: f.mimeType || "", url: "", size: f.size || 0 });
  for (const item of items || []) for (const m of (Array.isArray(item.markups) ? item.markups : [])) { const url = markupUrl(m); if (url && !/^data:/.test(url)) out.push({ id: `markup:${m.id}`, kind: "markup", name: m.name || "drawing", mimeType: m.type || "", url, element: item.label }); }
  return out;
}
