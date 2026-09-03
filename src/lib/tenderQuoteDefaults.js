/**
 * Standard boilerplate + seeding for the Tender Quote (see components/
 * TenderQuoteReport.jsx) — a direct copy of Gradcon's real quotation
 * document (7 Double Creek Road, Flinders — QUOTATION Rev.1), transcribed
 * verbatim so the seeded text is Gradcon's actual known-good standard
 * wording. These are only DEFAULTS: once seeded they live in
 * quote.tenderQuote and every field is freely editable per project.
 *
 * Line items are seeded from the project's own elements — the price from
 * each element's share of the real sell price (computeExternalScopeLines),
 * the dot points from the element's published estimating quantities
 * (concrete m³, reinforcement t, formwork m², mesh m² — the figures that
 * came across from the Estimates tab). Reseeding never runs over a tender
 * the estimator has already edited unless they ask for it.
 */
import { uid, computeElementCost, labourQuantities, computeExternalScopeLines, getDefaultMargin } from "./costing.js";

export const TENDER_INCLUSIONS = [
  "All detailed excavation.",
  "Includes the supply and placement of a 50mm minimum compacted sand bed as required.",
  "Includes the supply and placement of a polythene waterproof membrane as required.",
  "Includes the supply and placement all reinforcement to the correct requirements as per the structural documentation.",
  "Includes the supply and installation of starter bars for block walls, in-situ walls and columns.",
  "Includes the supply and placement of concrete to the correct requirements.",
  "Includes the supply and erection of all formwork and safety rails as required to suspended areas and stairs.",
  "Includes the provision of concrete pumps as required.",
  "Includes curing of the concrete slab.",
  "Includes one Australian Standard concrete test per pour if required (excludes footings & civil works).",
].join("\n");

export const TENDER_SPECIFIC_EXCLUSIONS = [
  "This quotation does not include removal of spoil or loading of trucks. Builder is to ensure the removal of spoil is carried out at such time as not to impede progress. (Refer 'Additional Options' above.)",
  "Dewatering has not been allowed for in this quotation. Builder is to ensure any dewatering is carried out as soon as practically possible to allow continuation of works.",
  "Insulation to slab beam sides is not included.",
  "Supply and placement of cast in plates is excluded from this quotation. Gradcon will assist in the placement as required.",
].join("\n");

export const TENDER_GENERAL_EXCLUSIONS = [
  "Blinding concrete. (Blinding will be charged at the rate specified below).",
  "Concrete pumping to any blinding concrete.",
  "Polystyrene insulation to underside of slab.",
  "Lagging to pipes within the slab.",
  "Rock excavation.",
  "Tanking or waterproofing.",
  "Any backfill, compacted or loose.",
  "Preparation of sub grade including replacement of soft spots.",
  "Planking and strutting to excavations.",
  "Propping and strutting of any existing structures.",
  "Selected finishes including colour, hardeners and sealers.",
  "Termite treatment.",
  "Placement of any HD bolts or cast in items.",
  "Bulk excavation or site cut or scrape.",
  "Precast panels or dowels to precast panels.",
  "Corking or sealing to saw cuts or constructions joints.",
  "Trench grates, pit lids or frames.",
  "Set out works and datum set up.",
  "Saw cutting or demolition of any existing concrete slabs, footings or paving.",
  "Cavity filling to any block work or retaining walls.",
  "Any reo to block or brick retaining walls, including starter bars from blockwork to suspended areas.",
  "Access towers.",
  "Access to all work areas must be available at all times.",
  "Any crane or hoisting.",
  "Propping footings to support precast panels unless specified in the quotation.",
  "Grouting of any kind (e.g. base plates, precast panels, underpinning).",
  "Any grano screeds or toppings unless specified in the quotation.",
  "Traffic Control or permits for concrete pump set up and deliveries.",
  "Filling of any pockets or voids formed in the slab, e.g. column rebates and PT pockets.",
  "Location of any existing services to be marked out by the builder before excavation is started.",
  "Protection of any existing concrete floors, paving or kerbs.",
].join("\n");

export const TENDER_CONTRACTUAL_CONDITIONS = `1) Allowances:
   a. Concrete:
      All material allowances are derived from minimum sizes and dimensions given in the structural drawings. Slabs requiring deeper beams will require additional concrete at blinding rate.
   b. Formwork:
      Additional formwork required for an elevated slab will incur additional costs unless clearly noted on the quote (i.e. deepened edge beams etc). This price includes a maximum 400mm edge form set up.

2) Additional Costs:
   a. Fill:
      Additional sand required to fill sites will be charged $65.00 per m3 + GST.
   b. Blinding:
      The supply of any blinding concrete due to collapsing ground conditions or increased beam depth required to achieve founding depth will be charged at $365.00 per m3 + GST which covers excavation, labour and concrete. (It does not include a pump. If a pump is required, an invoice will be supplied).
   c. Variations:
      Variations can be quoted and agreed upon. Alternatively, all variations will be Cost + 20% margin + GST. A detailed cost report will be provided for review.
   d. Stand down time:
      Stand down time due to delays by builder or other trades will be charged out at $85.00/hr + GST per man and $120.00/hr + GST per machine for plant hire.

3) Safety:
   a. Safety Caps:
      Safety Caps will be provided by Gradcon for all bars posing as hazardous. Caps are to be stored onsite and will be collected once their use is complete. Please advise if and when there are not required.
   b. Handrails:
      Safety handrails associated with formwork will be supplied by Gradcon - Note these temporary handrails will be removed once Gradcon's works have been completed.
   c. Deep Excavation:
      Gradcon has no allowances for safety barriers or shoring associated with deep excavation.
   d. Other:
      Refer to OHS/Insurances section of quotation for other particulars.

4) Site conditions:
   a. Builder is to ensure Gradcon is provided with updated drawings immediately they are issued.
   b. Builder to ensure a suitable access is available for vehicles (crushed rock road base or similar).
   c. Builder to ensure that the site has a toilet.
   d. Builder to ensure that the site has power available.
   e. Builder to ensure that the site has water available.
   f. Builder to ensure that all previous services have been disconnected.
   g. Setout and surveying to be done by the builder including building perimeter (concrete profile) and the location of steps, set downs and rebates.
   h. A bin is to be provided for the excess material generated from the works. If bin is not provided a neat pile of rubbish will be left on site.
   i. Water Control - The builder is, to the best of their ability, to provide a site that assists with surface water control (i.e. cut off drains).

5) Building & Construction Industry Security of Payment Act 2002:
   a. At Gradcon's sole discretion, if there are any disputes or claims for unpaid Services, the provisions of the Building and Construction Industry Security of Payment Act 2002 may apply.
   b. Nothing in this agreement is intended to have the effect of contracting out of any applicable provisions of the Building and Construction Industry Security of Payment Act 2002 of Victoria, except to the extent permitted by the Act where applicable.

6) Quote Conditions:
   a. This quotation is valid for 30 days from date provided on the quote and may be subject to prices rises after that period. Please note that due to the current volatility of pricing & supply of steel reinforcement and concrete, this quotation has a strict validity period of 30 days from time of quotation to commencement of works. Should works not commence within 30 days of this quotation, we reserve the right to review, and if necessary, pass on any increases incurred beyond the validity period.
   b. The quotation is not to have retentions held against it. Unless Agreed to.
   c. Unless "for construction" documents are provided at time of tender, all quotes will subject to review upon final documentation being issued.

7) OHS/Insurances:
   a. Work Cover Insurance Policy. Certificate of Currency provided on request.
   b. Public liability of $20,000,000.00. Certificate of Currency provided on request.
   c. All employees have a current White Card.
   d. Safe Work Method Statements (SWMS) provided as required.
   e. All employees will wear Hi-Vis clothing and hard hats when required.
   f. Material Safety Data Sheets (MSDS) provided on request.`;

export const TENDER_DEFAULT_OPTIONS = [
  { text: "Spoil removal (Provisional Sum based on 100m3). Additional spoil removal will be charged at $40.00/m3 + GST", price: "$7,600.00 + GST" },
  { text: "Bin hire rubbish/rubbish management", price: "$600.00 per skip + GST" },
  { text: "Blinding Contingency", price: "$365.00/m3 + GST" },
];

/** One tender line item per quote element: the price seeded from that
 * element's share of the REAL sell price, the dot points (up to 4) from its
 * published estimating quantities. Every field is editable afterwards. */
export function seedTenderItems(quote, items, rates) {
  const { lines } = computeExternalScopeLines(items, rates, quote.overheadPct, quote.contingencyPct, getDefaultMargin());
  const sellById = {};
  lines.forEach((l) => { sellById[l.id] = l.sellExGst; });
  const fmt = (n, dp = 2) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: dp });
  return items.map((item) => {
    const cost = computeElementCost(item, rates);
    const lq = labourQuantities(item, rates);
    const points = [];
    if ((item.description || "").trim()) points.push(item.description.trim());
    if (cost.concreteQty > 0) points.push(`Concrete — approx. ${fmt(cost.concreteQty)} m³`);
    if (lq.reinfTonnes > 0.005) points.push(`Reinforcement — approx. ${fmt(lq.reinfTonnes)} t`);
    if (lq.formworkM2 > 0) points.push(`Formwork — approx. ${fmt(lq.formworkM2)} m²`);
    if (lq.finishM2 > 0 && points.length < 4) points.push(`Mesh coverage — approx. ${fmt(lq.finishM2)} m²`);
    if (lq.excavationM3 > 0 && points.length < 4) points.push(`Excavation / spoil — approx. ${fmt(lq.excavationM3)} m³`);
    while (points.length < 4) points.push("");
    const sell = sellById[item.id];
    return {
      id: uid(),
      elementId: item.id,
      title: item.label,
      price: sell ? `$${sell.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + GST` : "",
      points: points.slice(0, 4),
    };
  });
}

export function newTenderQuote() {
  return {
    rev: "Rev.1",
    date: "",              // blank = the project date
    attentionName: "",
    attentionCompany: "",
    projectTitle: "",      // e.g. "New residence"
    projectAddress: "",    // one line per address line
    items: null,           // null = seed from the quote on first open
    additionalOptions: TENDER_DEFAULT_OPTIONS.map((o) => ({ id: uid(), ...o })),
    drawingsArchitect: "",
    drawingsStructural: "",
    drawingsCivil: "",
    tenderNotes: "",
    inclusions: TENDER_INCLUSIONS,
    specificExclusions: TENDER_SPECIFIC_EXCLUSIONS,
    generalExclusions: TENDER_GENERAL_EXCLUSIONS,
    contractualConditions: TENDER_CONTRACTUAL_CONDITIONS,
    signatureName: "Grady Fink",
    signatureTitle: "Director",
  };
}
