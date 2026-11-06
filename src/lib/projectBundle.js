/**
 * The project bundle — "Download project" (Grady, 5 Nov 2026: "a local download
 * option … once Grady finishes his input and clicks on download project. it
 * should export the estimates, the quotes etc and even the emails associated
 * to that project as a reference manual").
 *
 * This module is PURE (no React, no DOM, no network): it lays out the
 * reference manual (one self-contained HTML document), writes the takeoff
 * register and the emails as text, builds the Gmail search for the project's
 * correspondence and packs everything into a ZIP (store method, CRC-32 — no
 * dependency, readable by every unzipper). `projectBundleBuild.js` gathers the
 * pieces in the browser and hands them here; `scripts/verify.mjs` runs this
 * file in Node against a fixture quote.
 */
import { FULL_CATALOG, RESOURCE_COLS, ELEMENT_TYPES } from "../data/catalog.js";
import { computeElementCost, computeMarginRegister, computeProvisionalTotals, computeElementUnitRates, projectMargin, getGstRate, labourResourceRate, elementScope } from "./costing.js";
import { buildElementLines } from "./exportQuote.js";
import { itemsByPackage, hasPackages, packageName, computePackageTotals, packageAssumptions } from "./packages.js";
import { itemLines, itemPriceValue, tenderPackageBlocks, tenderProjectSumFor, stageTitle } from "./tenderQuoteDefaults.js";
import { tenderNoteLines } from "./tenderNotes.js";
import { TENDER_STEPS } from "./tenderChecklist.js";
import { rfqsOf } from "./rfq.js";
import { notificationsOf } from "./notifyGrady.js";
import { allProjectFiles } from "./driveFiles.js";

/* ---------------- small helpers ---------------- */
export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (f) => (f == null || !Number.isFinite(Number(f)) ? "—" : `${(Number(f) * 100).toFixed(Number(f) * 100 % 1 ? 1 : 0)}%`);
const num = (n, d = 2) => (Number(n) || 0).toLocaleString("en-AU", { maximumFractionDigits: d });
const when = (iso) => { if (!iso) return ""; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const day = (s) => { if (!s) return ""; const d = new Date(s); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };

/** A file-system-safe name: letters, digits, space, dash, dot, underscore; never empty. */
export function safeName(s, fallback = "file") {
  const out = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[–—]/g, "-").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  return out || fallback;
}
/** The bundle's folder and zip name: "<project> - project bundle <YYYY-MM-DD>". */
export function bundleName(quote, at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${safeName(quote && quote.projectName, "Project")} - project bundle ${stamp}`;
}

/**
 * The Gmail search for the project's correspondence: every distinct spelling of
 * the project name and address the quote carries (the convention name, the
 * name as first typed, the site address) and the street part alone
 * ("14-16 Marine Parade"), each as an exact phrase, OR-ed. Never the client's
 * whole mailbox — a project with no name searches nothing.
 */
export function mailQuery(quote) {
  const phrases = new Set();
  const add = (s) => { const t = String(s || "").replace(/\s+—.*$/, "").replace(/["()]/g, " ").replace(/\s+/g, " ").trim(); if (t.length >= 4) phrases.add(t); };
  add(quote && quote.projectName); add(quote && quote.nameSource); add(quote && quote.siteAddress);
  [quote && quote.projectName, quote && quote.nameSource, quote && quote.siteAddress].forEach((s) => {
    const m = /^(\d+[A-Za-z]?(?:\s*[-–]\s*\d+[A-Za-z]?)?)\s+([A-Za-z'’]+(?:\s+[A-Za-z'’]+)?)/.exec(String(s || "").trim());
    if (m) add(`${m[1]} ${m[2]}`.replace(/\s*[-–]\s*/, "-"));
  });
  const list = [...phrases].sort((a, b) => b.length - a.length);
  if (!list.length) return "";
  return `(${list.map((p) => `"${p}"`).join(" OR ")})`;
}

/* ---------------- ZIP (store) ---------------- */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  return CRC_TABLE;
}
export function crc32(bytes) {
  const t = crcTable(); let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const utf8 = (s) => new TextEncoder().encode(String(s));
const toBytes = (data) => (data instanceof Uint8Array ? data : typeof data === "string" ? utf8(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : utf8(JSON.stringify(data)));
function dosDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  const date = ((Math.max(1980, dt.getFullYear()) - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  return { time, date };
}
/**
 * Pack `files` = [{name, data, modified?}] (data: string | Uint8Array | ArrayBuffer |
 * JSON-able) into a ZIP with the store method. Names are UTF-8 (flag bit 11),
 * folders implied by "/" in the names. Returns a Uint8Array.
 */
export function zipStore(files, at = new Date()) {
  const entries = []; const parts = []; let offset = 0;
  for (const f of files) {
    const name = utf8(String(f.name).replace(/^\/+/, "")); const data = toBytes(f.data); const crc = crc32(data); const { time, date } = dosDateTime(f.modified || at);
    const local = new Uint8Array(30 + name.length); const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true); v.setUint16(10, time, true); v.setUint16(12, date, true);
    v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data); entries.push({ name, crc, size: data.length, time, date, offset }); offset += local.length + data.length;
  }
  const cdStart = offset; const cd = [];
  for (const e of entries) {
    const h = new Uint8Array(46 + e.name.length); const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true); v.setUint16(12, e.time, true); v.setUint16(14, e.date, true);
    v.setUint32(16, e.crc, true); v.setUint32(20, e.size, true); v.setUint32(24, e.size, true); v.setUint16(28, e.name.length, true); v.setUint16(30, 0, true); v.setUint16(32, 0, true);
    v.setUint16(34, 0, true); v.setUint16(36, 0, true); v.setUint32(38, 0, true); v.setUint32(42, e.offset, true); h.set(e.name, 46);
    cd.push(h); offset += h.length;
  }
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, offset - cdStart, true); ev.setUint32(16, cdStart, true); ev.setUint16(20, 0, true);
  const total = offset + 22; const out = new Uint8Array(total); let p = 0;
  for (const b of [...parts, ...cd, end]) { out.set(b, p); p += b.length; }
  return out;
}
/** Read a store-method ZIP back ({name → Uint8Array}) — the verify check's reader, and a sanity check on the writer. */
export function unzipStore(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out = {};
  let p = bytes.length - 22; while (p >= 0 && v.getUint32(p, true) !== 0x06054b50) p--;
  if (p < 0) throw new Error("not a zip");
  const n = v.getUint16(p + 10, true); let c = v.getUint32(p + 16, true);
  for (let i = 0; i < n; i++) {
    if (v.getUint32(c, true) !== 0x02014b50) throw new Error("bad central directory");
    const size = v.getUint32(c + 20, true), nl = v.getUint16(c + 28, true), el = v.getUint16(c + 30, true), cl = v.getUint16(c + 32, true), off = v.getUint32(c + 42, true), crc = v.getUint32(c + 16, true);
    const name = new TextDecoder().decode(bytes.subarray(c + 46, c + 46 + nl));
    const lnl = v.getUint16(off + 26, true), lel = v.getUint16(off + 28, true);
    const data = bytes.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + size);
    if (crc32(data) !== crc) throw new Error(`crc mismatch on ${name}`);
    out[name] = data; c += 46 + nl + el + cl;
  }
  return out;
}

/* ---------------- the takeoff and the emails as text ---------------- */
const csvField = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (...c) => c.map(csvField).join(",");
/** The register lines a stored takeoff instance carries (v1 / v2 rows: results.lines, results[], or lines). */
export function takeoffInstanceLines(inst) {
  const r = inst && (inst.results || inst.lines);
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.lines)) return r.lines;
  return [];
}
export function takeoffCsv(instances) {
  const rows = [csvRow("Element", "Type", "Group", "Material", "Spec", "Qty", "Unit", "Final qty", "Notes")];
  (instances || []).forEach((inst) => {
    takeoffInstanceLines(inst).forEach((l) => rows.push(csvRow(inst.label || inst.name || "", inst.typeKey || inst.type || "", l.materialGroup || l.group || "", l.material || "", l.spec || "", l.qty ?? "", l.unit || "", l.finalQty ?? l.qty ?? "", l.notes || "")));
  });
  return rows.join("\r\n");
}
/** One email as a plain-text document (headers, then the body, then the attachment names). */
export function emailText(m) {
  const head = [`From: ${m.from || ""}`, `To: ${m.to || ""}`, m.cc ? `Cc: ${m.cc}` : null, `Date: ${m.date || ""}`, `Subject: ${m.subject || ""}`, `Gmail id: ${m.id || ""}${m.threadId ? ` · thread ${m.threadId}` : ""}`].filter(Boolean);
  const body = String(m.text || m.snippet || "").replace(/\r\n/g, "\n");
  const att = (m.attachments || []).map((a) => `  - ${a.filename || a.name || "attachment"}${a.size ? ` (${num(a.size / 1024, 0)} KB)` : ""}`);
  return `${head.join("\n")}\n\n${body}${att.length ? `\n\nAttachments:\n${att.join("\n")}` : ""}\n`;
}
export function emailFileName(m, i) {
  const d = m.date ? String(m.date).slice(0, 10) : "undated";
  return `${d} ${String(i + 1).padStart(2, "0")} ${safeName(m.subject, "no subject").slice(0, 60)}.txt`;
}

/* ---------------- the reference manual ---------------- */
const CSS = `body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#1c1c1c;margin:0;background:#fff}main{max-width:1100px;margin:0 auto;padding:28px 32px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 8px;padding-bottom:4px;border-bottom:2px solid #231f20;text-transform:uppercase;letter-spacing:.04em}h3{font-size:14px;margin:18px 0 6px}table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0 10px}th,td{border:1px solid #d4d4d4;padding:4px 6px;vertical-align:top;text-align:left}th{background:#f3f3f3;font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,Consolas,monospace}tr.sub td{background:#fafafa;font-weight:600}.muted{color:#6b6b6b}.cover{background:#231f20;color:#fff;padding:26px 32px;margin:-28px -32px 20px}.cover .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#d5de5d}.cover h1{color:#fff}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px;font-size:13px}.facts b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#6b6b6b}.toc{columns:2;font-size:13px}.toc a{color:#1c1c1c}.band{background:#231f20;color:#fff;padding:4px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:16px 0 4px}pre{white-space:pre-wrap;font-size:12px;background:#fafafa;border:1px solid #e5e5e5;padding:8px;border-radius:4px}.chip{display:inline-block;border:1px solid #c9c9c9;border-radius:999px;padding:0 7px;font-size:11px;margin-right:4px}.ok{color:#1b7f3b}.warn{color:#9a5b00}@media print{main{padding:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}.cover{margin:0 0 20px}}`;

const typeOf = (item, elementTypes) => (elementTypes || ELEMENT_TYPES).find((t) => t.id === item.typeId) || null;

function elementSection(item, rates, scope, quote, elementTypes, geometry) {
  const { cost, lines } = buildElementLines(item, rates, scope);
  const t = typeOf(item, elementTypes);
  const unitRates = computeElementUnitRates(item, rates, scope) || [];
  const measures = [item.measureNo ? `${num(item.measureNo, 2)} no.` : "", item.measureLm ? `${num(item.measureLm, 2)} lm` : "", item.measureM2 ? `${num(item.measureM2, 2)} m²` : "", cost.concreteQty ? `${num(cost.concreteQty, 2)} m³ concrete` : ""].filter(Boolean).join(" · ");
  const tags = [item.provisional ? '<span class="chip">Provisional sum</span>' : "", item.scope && item.scope !== "inherit" ? `<span class="chip">scope: ${esc(item.scope)}</span>` : "", item.done ? `<span class="chip ok">✓ Done ${esc(when(item.done.at))}${item.done.by ? " by " + esc(item.done.by) : ""}</span>` : ""].join(" ");
  const rows = lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="n">${num(l.qty, 3)}</td><td>${esc(l.unit)}</td><td class="n">${l.qty ? money(l.total / l.qty) : ""}</td><td class="n">${money(l.total)}</td></tr>`).join("");
  const crew = (item.tasks || []).filter((task) => task && (Object.values(task.qtys || {}).some((v) => v !== "" && v != null) || (task.qty !== "" && task.qty != null)));
  const crewHead = RESOURCE_COLS.filter((r) => cost.resourceTotals[r.key] > 0);
  const crewTable = crewHead.length ? `<h3>Crew sheet — ${item.labourAuto === false ? "every cell typed" : "auto from quantities, typed cells kept"}</h3><table><tr><th>Task</th><th class="n">Qty</th>${crewHead.map((r) => `<th class="n">${esc(r.name)}<br><span class="muted">${esc(r.unit)} · ${money(labourResourceRate(rates, r))}</span></th>`).join("")}</tr>${crew.map((task) => `<tr><td>${esc(task.name)}</td><td class="n">${task.qty === "" || task.qty == null ? "" : num(task.qty, 2)}</td>${crewHead.map((r) => `<td class="n">${task.qtys && task.qtys[r.key] !== "" && task.qtys[r.key] != null ? num(task.qtys[r.key], 2) : ""}</td>`).join("")}</tr>`).join("")}<tr class="sub"><td>Total (incl. auto cells)</td><td></td>${crewHead.map((r) => `<td class="n">${num(cost.resourceTotals[r.key], 2)} = ${money(cost.resourceCosts[r.key])}</td>`).join("")}</tr></table>` : "";
  const desc = item.description ? `<p>${esc(item.description)}</p>` : "";
  const geo = geometry ? `<p class="muted">Rates: ${unitRates.map((u) => `${money(u.rate)}/${esc(u.unit)}`).join(" · ")}</p>` : "";
  return `<h3 id="el-${esc(item.id)}">${esc(item.label)} <span class="muted">· ${esc(t ? `${t.category} › ${t.section} › ${t.name}` : item.typeId)}${hasPackages(quote) ? ` · package ${esc(packageName(itemsByPackage(quote, [item])[0].pkg))}` : ""}</span> ${tags}</h3>${desc}<p>${esc(measures)}${measures ? " · " : ""}direct cost <b>${money(cost.total)}</b> (materials ${money(cost.materialsTotal)}, labour ${money(cost.labourTotal)}${cost.additionalTotal ? `, other ${money(cost.additionalTotal)}` : ""})${cost.excludedBlinding ? ` · blinding not added ${money(cost.excludedBlinding)}` : ""}</p>${geo}<table><tr><th>Line</th><th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Total</th></tr>${rows || '<tr><td colspan="5" class="muted">Nothing priced on this element.</td></tr>'}</table>${crewTable}`;
}

function tenderSection(quote, items) {
  const tq = quote.tenderQuote; if (!tq || !Array.isArray(tq.items)) return '<p class="muted">No Tender Quote has been opened on this project.</p>';
  const blocks = tenderPackageBlocks(tq, quote, items);
  const sum = tenderProjectSumFor(tq, quote, items, getGstRate());
  const out = [];
  blocks.forEach((b) => {
    if (blocks.length > 1 || b.pkg) out.push(`<div class="band">${esc(b.name)} — ${money(b.sum)} + GST</div>`);
    b.items.forEach((it) => {
      out.push(`<h3>${esc(it.title || stageTitle(it.stage))} <span class="muted">· ${money(itemPriceValue(it))} + GST</span></h3><table><tr><th>Line</th><th class="n">Price</th></tr>${itemLines(it).filter((l) => String(l.text || "").trim() || String(l.price || "").trim()).map((l) => `<tr><td>${esc(l.text)}</td><td class="n">${esc(l.price || "")}</td></tr>`).join("")}</table>`);
    });
  });
  const opts = Array.isArray(tq.additionalOptions) ? tq.additionalOptions.filter((o) => o && (o.text || o.title || o.price)) : [];
  if (opts.length) out.push(`<h3>Additional options</h3><table>${opts.map((o) => `<tr><td>${esc(o.title || o.text || "")}${o.title && o.text ? `<br><span class="muted">${esc(o.text)}</span>` : ""}</td><td class="n">${esc(o.price || "")}</td></tr>`).join("")}</table>`);
  ["inclusions", "exclusions", "generalExclusions"].forEach((k) => { const v = tq[k]; if (!v) return; const lines = Array.isArray(v) ? v : String(v).split(/\n+/); const kept = lines.map((s) => String(s || "").trim()).filter(Boolean); if (kept.length) out.push(`<h3>${esc(k === "generalExclusions" ? "General exclusions" : k[0].toUpperCase() + k.slice(1))}</h3><ul>${kept.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`); });
  const notes = tenderNoteLines(quote, tq.tenderNotes).all; if (notes.length) out.push(`<h3>Tender notes</h3><ul>${notes.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
  out.push(`<p><b>Project sum: ${money(sum.exGst)} + GST</b>${sum.gstOn ? ` · ${money(sum.incGst)} inc GST` : ""}${sum.markupOn ? ` · includes ${sum.markupPct}% markup` : ""}</p>`);
  return out.join("");
}

/**
 * The reference manual: one HTML document a person opens first. `ctx`:
 * {quote, items, rates, scope, elementTypes, takeoff ({name, instances} | null),
 *  emails [], versions [], bundle: {name, at, by, files: [{name, note}], issues: []}}.
 */
export function manualHtml(ctx) {
  const { quote, items = [], rates = {}, elementTypes = ELEMENT_TYPES, takeoff = null, emails = [], versions = [], bundle = {} } = ctx;
  const scope = quote.scope || "both";
  const reg = computeMarginRegister(items, rates, quote, scope);
  const prov = computeProvisionalTotals(items, rates, scope);
  const oh = Number(quote.overheadPct) || 0, ct = Number(quote.contingencyPct) || 0;
  const pkgTotals = hasPackages(quote) ? computePackageTotals(quote, items, rates, scope) : [];
  const files = allProjectFiles(quote);
  const checklist = quote.checklist || {};
  const facts = [["Client", quote.clientName], ["Site", quote.siteAddress || quote.nameSource], ["Status", quote.status], ["Tender due", day(quote.planner && quote.planner.deadline)], ["Project date", day(quote.projectDate)], ["Estimating completed", day(quote.completedAt)], ["Submitted", day(quote.submittedAt)], ["Scope", scope === "both" ? "Labour + materials" : scope === "labour" ? "Labour only" : "Materials only"], ["GFA", quote.gfa ? `${num(quote.gfa, 1)} m²` : ""], ["Rates", quote.ratesFrozen ? `pinned ${when(quote.ratesFrozen.at)}` : "live"], ["Bundle made", `${when(bundle.at || new Date().toISOString())}${bundle.by ? ` by ${bundle.by}` : ""}`]].filter(([, v]) => v);
  const sections = [["summary", "Summary"], ["packages", "Packages"], ["elements", "Elements — the costing"], ["margins", "Margin register"], ["tender", "Tender Quote"], ["assumptions", "Assumptions"], ["checklist", "Tender workflow checklist"], ["rfq", "RFQs, notifications and correspondence"], ["estimates", "Estimates takeoff"], ["files", "Files, drawings and versions"], ["contents", "What is in this bundle"]];
  const H = [];
  H.push(`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(quote.projectName || "Project")} — reference manual</title><style>${CSS}</style></head><body><main>`);
  H.push(`<div class="cover"><div class="eyebrow">Gradcon Concrete Constructions · project reference manual</div><h1>${esc(quote.projectName || "Untitled project")}</h1><div class="facts">${facts.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join("")}</div></div>`);
  H.push(`<div class="toc">${sections.map(([id, t]) => `<div><a href="#${id}">${esc(t)}</a></div>`).join("")}</div>`);
  // summary
  H.push(`<h2 id="summary">Summary</h2><table><tr><th>Direct cost</th><th>Overheads</th><th>Contingency</th><th>Loaded cost</th><th>Project margin</th><th>Blended margin</th><th>Sell ex GST</th><th>Sell inc GST</th></tr><tr><td class="n">${money(reg.totals.cost)}</td><td class="n">${pct(oh)}</td><td class="n">${pct(ct)}</td><td class="n">${money(reg.totals.loaded)}</td><td class="n">${pct(projectMargin(quote))}</td><td class="n">${pct(reg.totals.blended)}</td><td class="n"><b>${money(reg.totals.sell)}</b></td><td class="n">${money(reg.totals.sellIncGst)}</td></tr></table>`);
  if (prov.count) H.push(`<p>Of which provisional sums: ${money(prov.provisional)} across ${prov.count} element${prov.count === 1 ? "" : "s"} · firm work ${money(prov.firm)}.</p>`);
  H.push(`<table><tr><th>Element</th><th>Package</th><th class="n">Direct cost</th><th class="n">Loaded</th><th class="n">Margin</th><th class="n">Sell ex GST</th></tr>${reg.elements.map((e) => `<tr><td><a href="#el-${esc(e.id)}">${esc(e.label)}</a></td><td>${esc(hasPackages(quote) ? packageName(itemsByPackage(quote, items.filter((i) => i.id === e.id))[0].pkg) : "")}</td><td class="n">${money(e.cost)}</td><td class="n">${money(e.loaded)}</td><td class="n">${pct(e.margin)}</td><td class="n">${money(e.sell)}</td></tr>`).join("")}</table>`);
  // packages
  H.push(`<h2 id="packages">Packages</h2>`);
  if (pkgTotals.length) H.push(`<table><tr><th>Package</th><th class="n">Elements</th><th class="n">Direct cost</th><th class="n">Margin</th><th class="n">Sell ex GST</th></tr>${pkgTotals.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.count}</td><td class="n">${money(p.cost)}</td><td class="n">${p.margin == null ? "project" : pct(p.margin)}</td><td class="n">${money(p.sell)}</td></tr>`).join("")}</table>`);
  else H.push('<p class="muted">The project is priced as one job — no packages.</p>');
  // elements
  H.push(`<h2 id="elements">Elements — the costing</h2>`);
  itemsByPackage(quote, items).forEach((g) => { if (hasPackages(quote)) H.push(`<div class="band">${esc(packageName(g.pkg))}</div>`); g.items.forEach((it) => H.push(elementSection(it, rates, scope, quote, elementTypes, true))); });
  if (!items.length) H.push('<p class="muted">No elements.</p>');
  // margins
  H.push(`<h2 id="margins">Margin register</h2><table><tr><th>Line</th><th class="n">Cost</th><th class="n">Loaded</th><th class="n">Margin</th><th>Source</th><th class="n">Sell ex GST</th><th class="n">Sell inc GST</th></tr>${reg.lines.map((l) => `<tr><td>${esc(l.kind === "sub" ? `${l.name} (subcontract quote)` : l.element)}</td><td class="n">${money(l.cost)}</td><td class="n">${money(l.loaded)}</td><td class="n">${pct(l.margin)}</td><td>${esc(l.source)}</td><td class="n">${money(l.sell)}</td><td class="n">${money(l.sell * (1 + getGstRate()))}</td></tr>`).join("")}<tr class="sub"><td>Whole quote</td><td class="n">${money(reg.totals.cost)}</td><td class="n">${money(reg.totals.loaded)}</td><td class="n">${pct(reg.totals.blended)}</td><td>blended</td><td class="n">${money(reg.totals.sell)}</td><td class="n">${money(reg.totals.sellIncGst)}</td></tr></table>`);
  // tender
  H.push(`<h2 id="tender">Tender Quote</h2>${tenderSection(quote, items)}`);
  // assumptions
  const pa = (quote.packages || []).flatMap((p) => packageAssumptions(p).filter((a) => a && String(a.text || "").trim()).map((a) => ({ ...a, pkg: p.name })));
  const qa = (quote.assumptions || []).filter((a) => a && String(a.text || "").trim());
  H.push(`<h2 id="assumptions">Assumptions</h2>${qa.length || pa.length ? `<ol>${qa.map((a) => `<li>${esc(a.text)}${a.tenderText ? `<br><span class="muted">Tender wording: ${esc(a.tenderText)}</span>` : ""}</li>`).join("")}${pa.map((a) => `<li><b>${esc(a.pkg)}:</b> ${esc(a.text)}${a.tenderText ? `<br><span class="muted">Tender wording: ${esc(a.tenderText)}</span>` : ""}</li>`).join("")}</ol>` : '<p class="muted">None recorded.</p>'}`);
  // checklist
  H.push(`<h2 id="checklist">Tender workflow checklist</h2><table><tr><th>Step</th><th>Done</th><th>Date</th><th>By</th><th>Note</th></tr>${TENDER_STEPS.map((s) => { const c = checklist[s.id] || {}; return `<tr><td>${esc(s.n)} ${esc(s.title)}</td><td>${c.done ? "✓" : ""}</td><td>${esc(day(c.at))}</td><td>${esc(c.by || "")}</td><td>${esc(c.note || "")}</td></tr>`; }).join("")}</table>`);
  // rfq, notifications, emails
  H.push(`<h2 id="rfq">RFQs, notifications and correspondence</h2>`);
  const rfqs = rfqsOf(quote);
  H.push(rfqs.length ? `<h3>RFQ rounds sent from the app</h3><table><tr><th>When</th><th>Package</th><th>Due</th><th>Recipients</th><th>Attachments</th></tr>${rfqs.map((r) => `<tr><td>${esc(when(r.at))}${r.by ? `<br><span class="muted">by ${esc(r.by)}</span>` : ""}</td><td>${esc(r.package)}</td><td>${esc(day(r.due))}</td><td>${(r.recipients || r.sent || []).map((x) => `${esc(x.orgName || x.org || x.name || "")}${x.contactName || x.contact ? ` — ${esc(x.contactName || x.contact)}` : ""}${x.email ? ` &lt;${esc(x.email)}&gt;` : ""}${x.status ? ` <span class="muted">(${esc(x.status)})</span>` : ""}`).join("<br>")}</td><td>${(r.attachments || []).map((a) => esc(typeof a === "string" ? a : a.name)).join("<br>")}</td></tr>`).join("")}</table>` : '<p class="muted">No RFQ round has been sent from the app.</p>');
  const notif = notificationsOf(quote);
  if (notif.length) H.push(`<h3>Notifications to Grady</h3><table><tr><th>When</th><th>Kind</th><th>To</th><th>By</th><th>Text</th></tr>${notif.map((n) => `<tr><td>${esc(when(n.at))}</td><td>${esc(n.kind)}</td><td>${esc(n.to || "")}</td><td>${esc(n.by || "")}</td><td>${esc(String(n.text || "").slice(0, 400))}</td></tr>`).join("")}</table>`);
  H.push(`<h3>Emails in projects@ about this project (${emails.length})</h3>`);
  H.push(emails.length ? `<table><tr><th>Date</th><th>From</th><th>To</th><th>Subject</th><th>Attachments</th><th>File</th></tr>${emails.map((m, i) => `<tr><td>${esc(when(m.date))}</td><td>${esc(m.from)}</td><td>${esc(m.to)}</td><td><a href="#mail-${i}">${esc(m.subject || "(no subject)")}</a></td><td>${(m.attachments || []).map((a) => esc(a.filename || a.name)).join("<br>")}</td><td class="muted">emails/${esc(emailFileName(m, i))}</td></tr>`).join("")}</table>${emails.map((m, i) => `<h3 id="mail-${i}">${esc(m.subject || "(no subject)")} <span class="muted">· ${esc(when(m.date))}</span></h3><pre>${esc(emailText(m))}</pre>`).join("")}` : `<p class="muted">${esc(bundle.mailNote || "No emails were gathered for this bundle.")}</p>`);
  // estimates
  H.push(`<h2 id="estimates">Estimates takeoff</h2>`);
  if (takeoff && Array.isArray(takeoff.instances) && takeoff.instances.length) {
    H.push(`<p>Takeoff <b>${esc(takeoff.name || "")}</b> — ${takeoff.instances.length} element${takeoff.instances.length === 1 ? "" : "s"}. The full takeoff is in <code>estimates/takeoff.json</code> and its register in <code>estimates/register.csv</code>.</p>`);
    takeoff.instances.forEach((inst) => {
      const d = inst.data || {}; const fields = Object.entries(d).filter(([k, v]) => !k.startsWith("_") && v !== "" && v != null && typeof v !== "object").slice(0, 18).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ");
      const lines = takeoffInstanceLines(inst);
      H.push(`<h3>${esc(inst.label || inst.name || inst.id || "element")} <span class="muted">· ${esc(inst.typeKey || inst.type || "")}${d.qty ? ` · qty ${esc(d.qty)}` : ""}</span></h3>${fields ? `<p class="muted">${fields}</p>` : ""}${lines.length ? `<table><tr><th>Group</th><th>Material</th><th>Spec</th><th class="n">Qty</th><th>Unit</th><th class="n">Final</th></tr>${lines.map((l) => `<tr><td>${esc(l.materialGroup || l.group || "")}</td><td>${esc(l.material || "")}</td><td>${esc(l.spec || "")}</td><td class="n">${l.qty == null ? "" : num(l.qty, 3)}</td><td>${esc(l.unit || "")}</td><td class="n">${l.finalQty == null ? "" : num(l.finalQty, 3)}</td></tr>`).join("")}</table>` : '<p class="muted">No register lines stored on this element.</p>'}`);
    });
  } else H.push(`<p class="muted">${esc(bundle.takeoffNote || "No Estimates takeoff with this project's name was found.")}</p>`);
  // files & versions
  H.push(`<h2 id="files">Files, drawings and versions</h2>`);
  const drawings = items.flatMap((it) => (it.markups || []).map((m) => ({ element: it.label, name: m.name, path: m.path })));
  H.push(drawings.length ? `<h3>Drawings on the element cards</h3><table><tr><th>Element</th><th>Drawing</th><th>In the bundle</th></tr>${drawings.map((d) => `<tr><td>${esc(d.element)}</td><td>${esc(d.name)}</td><td class="muted">${esc((bundle.files || []).find((f) => f.note === d.path) ? "drawings/…" : "not fetched")}</td></tr>`).join("")}</table>` : "");
  H.push(files.length ? `<h3>Attached files</h3><table><tr><th>Name</th><th>From</th><th>Size</th><th>Link</th></tr>${files.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.provider === "mail" ? "tender email" : "Google Drive")}</td><td>${f.size ? `${num(f.size / 1024, 0)} KB` : ""}</td><td>${f.webViewLink ? `<a href="${esc(f.webViewLink)}">open in Drive</a>` : f.url ? `<a href="${esc(f.url)}">download</a>` : ""}</td></tr>`).join("")}</table>` : '<p class="muted">No files attached to the project.</p>');
  H.push(versions.length ? `<h3>Saved versions (${versions.length}, newest first)</h3><table><tr><th>Saved</th><th>Kind</th><th>Size</th></tr>${versions.slice(0, 60).map((v) => `<tr><td>${esc(when(v.savedAt))}</td><td>${esc(v.source)}</td><td>${v.size ? `${num(v.size / 1024, 0)} KB` : ""}</td></tr>`).join("")}</table>` : "");
  // contents
  H.push(`<h2 id="contents">What is in this bundle</h2><table><tr><th>File</th><th>What it is</th></tr>${(bundle.files || []).map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.what || "")}</td></tr>`).join("")}</table>`);
  if (bundle.issues && bundle.issues.length) H.push(`<h3 class="warn">Not included</h3><ul>${bundle.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
  H.push(`<p class="muted">Figures are the project's own at the moment the bundle was made${quote.ratesFrozen ? ", priced on its pinned rates" : ", priced on the live rates"}. Open <code>quote/quote.json</code> in Quotes (Open .json) to work on a copy.</p></main></body></html>`);
  return H.join("\n");
}
