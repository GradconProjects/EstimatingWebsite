/**
 * Two export formats for the live quote, both built from the same
 * computeElementCost/computeGrandTotal/computeMarginLadder calls as
 * QuoteSummary.jsx and PrintQuoteReport.jsx — never recomputed inline, for
 * the same reason CLAUDE.md gives for computeRowTotal: one implementation,
 * so these can't silently drift from what the screen and the PDF show.
 *
 * - buildQuoteExcelHtml: an HTML table saved with a .xls extension and the
 *   `application/vnd.ms-excel` MIME type — Excel opens this natively and
 *   renders the inline styling (bold headers, category/section colour
 *   bands, borders, currency alignment) as real formatting, with zero
 *   spreadsheet library added to the bundle. Covers every section
 *   QuoteSummary.jsx shows on screen (item breakdown incl. elements with no
 *   quantities entered yet, per-category subtotal, Grand Total, GFA &
 *   On-Costs, Margin Ladder with the default margin highlighted), not just
 *   the lines PrintQuoteReport.jsx prints.
 * - buildQuoteCsv: a plain-text CSV of the same content, used as the
 *   text/plain clipboard fallback in ExportExcelModal (a paste target that
 *   can't accept the HTML clipboard format still gets usable text).
 */
import { FULL_CATALOG, RESOURCE_COLS, CATEGORY_ORDER, SECTION_ORDER, MARGIN_STEPS, DEFAULT_MARGIN } from "../data/catalog.js";
import { computeElementCost, computeGrandTotal, computeMarginLadder, rateKey, lookupRate, computeRowTotal } from "./costing.js";
import { GRADCON_LOGO_DATA_URI } from "./logo.js";

/** Every line (material/labour/custom) actually filled in for one element, plus its total. */
function buildElementLines(item, rates) {
  const materialLines = [];
  FULL_CATALOG.forEach((cat) => {
    cat.products.forEach((p) => {
      const qKey = rateKey(cat.key, p.name, p.unit);
      const qty = Number(item.qtys[qKey]) || 0;
      if (qty > 0) {
        const rate = lookupRate(rates, qKey, {
          unitCost: p.unitCost ?? 0, unitWeight: p.unitWeight, sheetArea: p.sheetArea, barLength: p.barLength,
        });
        const rowTotal = computeRowTotal(cat, rate, qty);
        materialLines.push({ label: `${p.name} (${cat.key})`, qty, unit: p.unit, total: rowTotal });
      }
    });
  });

  const cost = computeElementCost(item, rates);
  const labourLines = RESOURCE_COLS.filter((res) => cost.resourceTotals[res.key] > 0).map((res) => ({
    label: res.name, qty: cost.resourceTotals[res.key], unit: res.unit, total: cost.resourceCosts[res.key],
  }));

  const customLines = item.additional
    .filter((a) => (Number(a.qty) || 0) > 0 && a.name)
    .map((a) => ({ label: a.name, qty: Number(a.qty) || 0, unit: a.unit, total: (Number(a.qty) || 0) * (Number(a.rate) || 0) }));

  return { cost, lines: [...materialLines, ...labourLines, ...customLines] };
}

/** Groups items the same way QuoteSummary.jsx does: category > section, only groups that have items. */
function groupItems(items, rates, categoryOrder, sectionOrder) {
  return categoryOrder
    .map((category) => {
      const catItems = items.filter((it) => it.category === category);
      if (catItems.length === 0) return null;
      const sections = sectionOrder
        .map((section) => {
          const secItems = catItems.filter((it) => it.section === section);
          if (secItems.length === 0) return null;
          return { section, elements: secItems.map((item) => ({ item, ...buildElementLines(item, rates) })) };
        })
        .filter(Boolean);
      const catTotal = sections.flatMap((s) => s.elements).reduce((sum, e) => sum + e.cost.total, 0);
      return { category, sections, catTotal };
    })
    .filter(Boolean);
}

/* ---------------- Excel (HTML table, .xls) ---------------- */

const COLORS = {
  navy: "#172554", navyText: "#ffffff",
  catBand: "#262626", catText: "#ffffff",
  sectionBand: "#e5e5e5", sectionText: "#404040",
  totalBand: "#171717", totalText: "#fb923c",
  money: "#c2410c",
  border: "#d4d4d4",
  muted: "#737373",
  defaultMargin: "#ecfdf5",
};

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function td(content, { colSpan, align = "left", bold, bg, color, italic, border = true, numeric } = {}) {
  const styles = [
    numeric ? `mso-number-format:&quot;#,##0.00&quot;` : "",
    `padding:4px 8px`,
    `font-family:Calibri,Arial,sans-serif`,
    `font-size:11pt`,
    `text-align:${align}`,
    border ? `border:1px solid ${COLORS.border}` : `border:none`,
    bold ? `font-weight:bold` : "",
    italic ? `font-style:italic` : "",
    bg ? `background:${bg}` : "",
    color ? `color:${color}` : "",
  ].filter(Boolean).join(";");
  return `<td${colSpan ? ` colspan="${colSpan}"` : ""} style="${styles}">${content}</td>`;
}
const tr = (cells) => `<tr>${cells}</tr>`;

export function buildQuoteExcelHtml(quote, items, rates, categoryOrder = CATEGORY_ORDER, sectionOrder = SECTION_ORDER) {
  const groups = groupItems(items, rates, categoryOrder, sectionOrder);
  const grandTotal = computeGrandTotal(items, rates);
  const { subtotal, rows: marginRows } = computeMarginLadder(
    grandTotal, quote.overheadPct, quote.contingencyPct, quote.gfa, MARGIN_STEPS
  );

  const rowsHtml = [];

  // White background row for the logo — it has a solid white background
  // baked into the PNG (no alpha channel), so it must sit on white, never
  // on the navy title band below.
  rowsHtml.push(tr(td(`<img src="${GRADCON_LOGO_DATA_URI}" height="34" alt="Gradcon Concrete Constructions">`, {
    colSpan: 4, border: false,
  })));
  rowsHtml.push(tr(td(esc(quote.projectName || "Untitled project"), {
    colSpan: 4, bold: true, bg: COLORS.navy, color: COLORS.navyText, border: false,
  })));
  rowsHtml.push(tr(td(esc(`Date: ${quote.projectDate || ""}`), { colSpan: 4, color: COLORS.muted, border: false })));
  rowsHtml.push(tr(td("&nbsp;", { colSpan: 4, border: false })));

  rowsHtml.push(tr(
    td("Element / Line", { bold: true, bg: COLORS.navy, color: COLORS.navyText })
    + td("Qty", { bold: true, bg: COLORS.navy, color: COLORS.navyText, align: "right" })
    + td("Unit", { bold: true, bg: COLORS.navy, color: COLORS.navyText })
    + td("Total ($)", { bold: true, bg: COLORS.navy, color: COLORS.navyText, align: "right" })
  ));

  groups.forEach(({ category, sections, catTotal }) => {
    rowsHtml.push(tr(td(esc(category), { colSpan: 4, bold: true, bg: COLORS.catBand, color: COLORS.catText })));

    sections.forEach(({ section, elements }) => {
      rowsHtml.push(tr(td(`&nbsp;&nbsp;${esc(section)}`, { colSpan: 4, bold: true, bg: COLORS.sectionBand, color: COLORS.sectionText })));

      elements.forEach(({ item, cost, lines }) => {
        rowsHtml.push(tr(
          td(`&nbsp;&nbsp;&nbsp;&nbsp;${esc(item.label)}`, { bold: true })
          + td("", {})
          + td("", {})
          + td(cost.total.toFixed(2), { bold: true, align: "right", color: COLORS.money, numeric: true })
        ));

        if (lines.length === 0) {
          rowsHtml.push(tr(
            td("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;No quantities entered", { italic: true, color: COLORS.muted })
            + td("", {}) + td("", {}) + td("", {})
          ));
        } else {
          lines.forEach((l) => {
            rowsHtml.push(tr(
              td(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${esc(l.label)}`, {})
              + td(String(l.qty), { align: "right", numeric: true })
              + td(esc(l.unit), {})
              + td(l.total.toFixed(2), { align: "right", numeric: true })
            ));
          });
        }
      });

      rowsHtml.push(tr(
        td(`&nbsp;&nbsp;${esc(section)} subtotal`, { bold: true })
        + td("", {}) + td("", {})
        + td(elements.reduce((s, e) => s + e.cost.total, 0).toFixed(2), {
          bold: true, align: "right", numeric: true,
        })
      ));
    });

    rowsHtml.push(tr(
      td(`${esc(category)} SUBTOTAL`, { bold: true, bg: COLORS.sectionBand })
      + td("", { bg: COLORS.sectionBand }) + td("", { bg: COLORS.sectionBand })
      + td(catTotal.toFixed(2), { bold: true, align: "right", bg: COLORS.sectionBand, numeric: true })
    ));
    rowsHtml.push(tr(td("&nbsp;", { colSpan: 4, border: false })));
  });

  if (groups.length === 0) {
    rowsHtml.push(tr(td("No elements added yet.", { colSpan: 4, italic: true, color: COLORS.muted })));
    rowsHtml.push(tr(td("&nbsp;", { colSpan: 4, border: false })));
  }

  rowsHtml.push(tr(
    td("GRAND TOTAL (EX GST)", { bold: true, bg: COLORS.totalBand, color: COLORS.totalText })
    + td("", { bg: COLORS.totalBand }) + td("", { bg: COLORS.totalBand })
    + td(grandTotal.toFixed(2), { bold: true, align: "right", bg: COLORS.totalBand, color: COLORS.totalText, numeric: true })
  ));
  rowsHtml.push(tr(td("&nbsp;", { colSpan: 4, border: false })));

  rowsHtml.push(tr(td("GFA &amp; ON-COSTS", { colSpan: 4, bold: true, bg: COLORS.catBand, color: COLORS.catText })));
  rowsHtml.push(tr(td("Total GFA", {}) + td(quote.gfa ? String(quote.gfa) : "", { align: "right", numeric: !!quote.gfa }) + td("m²", {}) + td("", {})));
  rowsHtml.push(tr(td("Overheads", {}) + td(`${Math.round((Number(quote.overheadPct) || 0) * 100)}%`, { align: "right" }) + td("", {}) + td("", {})));
  rowsHtml.push(tr(td("Contingency", {}) + td(`${Math.round((Number(quote.contingencyPct) || 0) * 100)}%`, { align: "right" }) + td("", {}) + td("", {})));
  rowsHtml.push(tr(
    td("Subtotal (+ OH + Cont.)", { bold: true }) + td("", {}) + td("", {})
    + td(subtotal.toFixed(2), { bold: true, align: "right", numeric: true })
  ));
  rowsHtml.push(tr(td("&nbsp;", { colSpan: 4, border: false })));

  rowsHtml.push(tr(td("MARGIN LADDER", { colSpan: 4, bold: true, bg: COLORS.catBand, color: COLORS.catText })));
  rowsHtml.push(tr(
    td("Margin", { bold: true, bg: COLORS.sectionBand })
    + td("Sell (ex GST)", { bold: true, bg: COLORS.sectionBand, align: "right" })
    + td("Sell (inc GST)", { bold: true, bg: COLORS.sectionBand, align: "right" })
    + td("$/m² GFA", { bold: true, bg: COLORS.sectionBand, align: "right" })
  ));
  marginRows.forEach((r) => {
    const isDefault = Math.abs(r.margin - DEFAULT_MARGIN) < 1e-9;
    const bg = isDefault ? COLORS.defaultMargin : undefined;
    rowsHtml.push(tr(
      td(`${Math.round(r.margin * 100)}%`, { bold: isDefault, bg })
      + td(r.sellExGst.toFixed(2), { align: "right", bg, numeric: true })
      + td(r.sellIncGst.toFixed(2), { align: "right", bg, numeric: true })
      + td(r.perM2 > 0 ? r.perM2.toFixed(2) : "", { align: "right", bg, numeric: r.perM2 > 0 })
    ));
  });

  const sheetName = (quote.projectName || "Quote").slice(0, 31).replace(/[\\/*?:[\]]/g, " ");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${esc(sheetName)}</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
<style>
table { border-collapse: collapse; }
col.c0 { width: 320px; } col.c1 { width: 90px; } col.c2 { width: 70px; } col.c3 { width: 120px; }
</style>
</head>
<body>
<table>
<colgroup><col class="c0"><col class="c1"><col class="c2"><col class="c3"></colgroup>
${rowsHtml.join("\n")}
</table>
</body>
</html>`;
}

export function quoteExcelFilename(quote) {
  const name = (quote.projectName || "quote").trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "quote";
  return `${name}.xls`;
}

/* ---------------- Plain-text CSV (clipboard fallback) ---------------- */

const csvField = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (...cells) => cells.map(csvField).join(",");

export function buildQuoteCsv(quote, items, rates, categoryOrder = CATEGORY_ORDER, sectionOrder = SECTION_ORDER) {
  const groups = groupItems(items, rates, categoryOrder, sectionOrder);
  const lines = [];
  lines.push(csvRow("GRADCON CONCRETE CONSTRUCTIONS"));
  lines.push(csvRow(quote.projectName || "Untitled project"));
  lines.push(csvRow(`Date: ${quote.projectDate || ""}`));
  lines.push("");
  lines.push(csvRow("Category", "Section", "Element / Line", "Qty", "Unit", "Total ($)"));

  groups.forEach(({ category, sections, catTotal }) => {
    let categoryPrinted = false;
    sections.forEach(({ section, elements }) => {
      let sectionPrinted = false;
      elements.forEach(({ item, cost, lines: elLines }) => {
        lines.push(csvRow(categoryPrinted ? "" : category, sectionPrinted ? "" : section, item.label, "", "", cost.total.toFixed(2)));
        categoryPrinted = true;
        sectionPrinted = true;
        if (elLines.length === 0) {
          lines.push(csvRow("", "", "  No quantities entered", "", "", ""));
        } else {
          elLines.forEach((l) => lines.push(csvRow("", "", `  ${l.label}`, l.qty, l.unit, l.total.toFixed(2))));
        }
      });
      lines.push(csvRow("", "", `  ${section} subtotal`, "", "", elements.reduce((s, e) => s + e.cost.total, 0).toFixed(2)));
    });
    lines.push(csvRow(`${category} SUBTOTAL`, "", "", "", "", catTotal.toFixed(2)));
  });

  const grandTotal = computeGrandTotal(items, rates);
  lines.push("");
  lines.push(csvRow("", "", "GRAND TOTAL (EX GST)", "", "", grandTotal.toFixed(2)));

  const { subtotal, rows } = computeMarginLadder(
    grandTotal, quote.overheadPct, quote.contingencyPct, quote.gfa, MARGIN_STEPS
  );

  lines.push("");
  lines.push(csvRow("GFA & ON-COSTS"));
  lines.push(csvRow("", "", "Total GFA", quote.gfa || "", "m²", ""));
  lines.push(csvRow("", "", "Overheads", `${Math.round((Number(quote.overheadPct) || 0) * 100)}%`, "", ""));
  lines.push(csvRow("", "", "Contingency", `${Math.round((Number(quote.contingencyPct) || 0) * 100)}%`, "", ""));
  lines.push(csvRow("", "", "Subtotal", "", "", subtotal.toFixed(2)));

  lines.push("");
  lines.push(csvRow("MARGIN LADDER"));
  lines.push(csvRow("Margin", "", "", "Sell (ex GST)", "Sell (inc GST)", "$/m² GFA"));
  rows.forEach((r) => {
    lines.push(csvRow(`${Math.round(r.margin * 100)}%`, "", "", r.sellExGst.toFixed(2), r.sellIncGst.toFixed(2), r.perM2 > 0 ? r.perM2.toFixed(2) : ""));
  });

  return lines.join("\r\n");
}

export function quoteCsvFilename(quote) {
  const name = (quote.projectName || "quote").trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "quote";
  return `${name}.csv`;
}
