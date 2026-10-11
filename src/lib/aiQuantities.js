/**
 * Indicative quantities for an AI-read element — DETERMINISTIC geometry from
 * the generic shape the drawing reader returns (qty, mm dimensions, bars,
 * mesh), never a figure the model wrote. Shown in the AI Engine's review
 * table so an estimator sees m³ / kg / m² the moment the drawings are read
 * (Grady, 11 Oct 2026: "can we not have an estimator that can actually give
 * the quantities automatically?"); Estimates recomputes everything exactly
 * on export with its full calculators (laps, waste, hooks, blinding, joints)
 * and writes its figures back onto the job. Pure, no DOM; bundled into
 * dist/assets/gradcon-qa.js.
 */
const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
/** D500N bar mass, kg per metre: d² ÷ 162 (the approximation Estimates uses). */
export const barKgPerM = (dia) => { const m = String(dia || "").match(/(\d{2})/); return m ? (Number(m[1]) ** 2) / 162 : 0; };
/** Sheet mesh, kg per m² (the Estimates MESHTYPES table). */
export const MESH_KG_M2 = { SL52: 1.46, SL62: 2.29, SL72: 2.85, SL81: 7.29, SL82: 3.61, SL92: 4.58, SL102: 5.56, RL718: 4.6, RL818: 5.9, RL918: 7.5, RL1018: 9.3, RL1118: 11.1, RL1218: 13.3 };
export const SUSPENDED_TYPES = new Set(["suspslab", "roofslab", "roofslabcant", "plantdeck", "liftoverrun", "turntableslab"]);

/** The family a drawing element type prices as (the Estimates calculator), for the formulas below. */
export function calcFamily(type, calcOf) {
  if (typeof calcOf === "function") { const c = calcOf(type); if (c) return c; }
  return null;
}

/**
 * elementQuantities(el, calc) → {concreteM3, steelKg, formworkM2, excavationM3, basis, notes}
 * `el` is a reviewed drawing element (length_mm, width_mm, depth_mm, height_mm,
 * diameter_mm, area_m2, qty, mainDia/mainQty/mainSpacing, crossDia/crossSpacing,
 * topDia/topQty/topSpacing, ligDia/ligSpacing, mesh, cover_mm); `calc` the
 * calculator family. Dimensions in mm, area in m². Every figure is per the
 * whole mark (× qty). Missing inputs give 0 with a note, never a guess.
 */
export function elementQuantities(el, calc) {
  const e = el || {};
  const qty = n(e.qty) || 1, L = n(e.length_mm), W = n(e.width_mm), D = n(e.depth_mm), H = n(e.height_mm), DIA = n(e.diameter_mm), A = n(e.area_m2), cover = n(e.cover_mm) || 50;
  const notes = []; let conc = 0, steel = 0, form = 0, exc = 0, basis = "";
  const mm = (v) => v / 1000;
  const barsAlong = (runMm, spacingMm) => (runMm > 0 && spacingMm > 0 ? Math.floor(runMm / spacingMm) + 1 : 0);
  const ligPerimeter = (w, d) => 2 * (mm(w) + mm(d) - 4 * mm(cover)) + 0.2; // closed tie inside the cover plus hooks
  const main = { dia: e.mainDia, qty: n(e.mainQty), s: n(e.mainSpacing) }, cross = { dia: e.crossDia, s: n(e.crossSpacing) }, top = { dia: e.topDia, qty: n(e.topQty), s: n(e.topSpacing) }, ligs = { dia: e.ligDia, s: n(e.ligSpacing) };
  switch (calc) {
    case "padfooting": case "pilecap": {
      if (DIA && D) { conc = Math.PI * (mm(DIA) / 2) ** 2 * mm(D) * qty; form = Math.PI * mm(DIA) * mm(D) * qty; basis = "π·r²·D"; }
      else if (L && W && D) { conc = mm(L) * mm(W) * mm(D) * qty; form = 2 * (mm(L) + mm(W)) * mm(D) * qty; basis = "L·W·D, 4 faces"; }
      else notes.push("size incomplete");
      if (conc) exc = (mm(L || DIA) + 0.3) * (mm(W || DIA) + 0.3) * (mm(D) + 0.05) * qty;
      if (e.mesh && MESH_KG_M2[String(e.mesh).toUpperCase()] && L && W) steel += mm(L) * mm(W) * MESH_KG_M2[String(e.mesh).toUpperCase()] * 1.1 * qty;
      else if (main.dia && main.s && L && W) steel += (barsAlong(W, main.s) * mm(L) + barsAlong(L, main.s) * mm(W)) * barKgPerM(main.dia) * qty;
      else if (main.dia) notes.push("bottom bar spacing or size unknown — steel not counted");
      if (top.dia && top.s && L && W) steel += (barsAlong(W, top.s) * mm(L) + barsAlong(L, top.s) * mm(W)) * barKgPerM(top.dia) * qty;
      break;
    }
    case "stripfooting": {
      if (L && W && D) { conc = mm(L) * mm(W) * mm(D) * qty; form = 2 * mm(L) * mm(D) * qty; exc = (mm(W) + 0.1) * (mm(D) + 0.05) * mm(L) * qty; basis = "run·W·D, 2 faces"; } else notes.push("run, width or depth unknown");
      if (main.dia && L) steel += (main.qty || 2) * mm(L) * barKgPerM(main.dia) * qty;
      if (top.dia && L) steel += (top.qty || 2) * mm(L) * barKgPerM(top.dia) * qty;
      if (cross.dia && cross.s && L && W) steel += barsAlong(L, cross.s) * (mm(W) - 2 * mm(cover) + 0.3) * barKgPerM(cross.dia) * qty;
      if (ligs.dia && ligs.s && L && W && D) steel += barsAlong(L, ligs.s) * ligPerimeter(W, D) * barKgPerM(ligs.dia) * qty;
      break;
    }
    case "pier": {
      const len = L || H || D;
      if (DIA && len) { conc = Math.PI * (mm(DIA) / 2) ** 2 * mm(len) * qty; exc = conc; basis = "π·r²·depth (bored)"; } else notes.push("diameter or depth unknown");
      if (main.dia && len) steel += (main.qty || 6) * (mm(len) + 0.6) * barKgPerM(main.dia) * qty;
      if (ligs.dia && ligs.s && DIA && len) steel += barsAlong(len, ligs.s) * (Math.PI * mm(DIA - 2 * cover) + 0.2) * barKgPerM(ligs.dia) * qty;
      break;
    }
    case "column": {
      const h = H || L;
      if (DIA && h) { conc = Math.PI * (mm(DIA) / 2) ** 2 * mm(h) * qty; form = Math.PI * mm(DIA) * mm(h) * qty; basis = "π·r²·H"; }
      else if (W && D && h) { conc = mm(W) * mm(D) * mm(h) * qty; form = 2 * (mm(W) + mm(D)) * mm(h) * qty; basis = "W·D·H, 4 faces"; } else notes.push("section or height unknown");
      if (main.dia && h) steel += (main.qty || 4) * mm(h) * barKgPerM(main.dia) * qty;
      if (ligs.dia && ligs.s && h) steel += barsAlong(h, ligs.s) * (DIA ? Math.PI * mm(DIA - 2 * cover) + 0.2 : ligPerimeter(W, D)) * barKgPerM(ligs.dia) * qty;
      break;
    }
    case "beam": {
      if (L && W && D) { conc = mm(L) * mm(W) * mm(D) * qty; form = (mm(W) + 2 * mm(D)) * mm(L) * qty; basis = "L·W·D, soffit + 2 sides"; } else notes.push("length, width or depth unknown");
      if (main.dia && L) steel += (main.qty || 2) * mm(L) * barKgPerM(main.dia) * qty;
      if (top.dia && L) steel += (top.qty || 2) * mm(L) * barKgPerM(top.dia) * qty;
      if (ligs.dia && ligs.s && L && W && D) steel += barsAlong(L, ligs.s) * ligPerimeter(W, D) * barKgPerM(ligs.dia) * qty;
      break;
    }
    case "slab": {
      const area = A || (L && W ? mm(L) * mm(W) : 0); const perim = L && W ? 2 * (mm(L) + mm(W)) : area ? 4 * Math.sqrt(area) : 0;
      if (area && D) { conc = area * mm(D) * qty; basis = A ? "area·T" : "L·W·T"; } else notes.push("area or thickness unknown");
      const suspended = SUSPENDED_TYPES.has(String(e.type || ""));
      if (area && D) form = ((suspended ? area : 0) + perim * mm(D)) * qty;
      const meshKey = String(e.mesh || "").toUpperCase();
      if (area && MESH_KG_M2[meshKey]) steel += area * MESH_KG_M2[meshKey] * 1.1 * qty;
      else if (main.dia && main.s && area) steel += area * ((1000 / main.s + 1) + 1000 / main.s) * barKgPerM(main.dia) * qty; // the 1 m block, each way
      else if (e.mesh) notes.push(`mesh ${e.mesh} not in the mass table`);
      if (top.dia && top.s && area) steel += area * ((1000 / top.s + 1) + 1000 / top.s) * barKgPerM(top.dia) * qty;
      if (String(e.topMesh || "").toUpperCase() in MESH_KG_M2 && area) steel += area * MESH_KG_M2[String(e.topMesh).toUpperCase()] * 1.1 * qty;
      break;
    }
    case "wall": {
      if (L && D && H) { conc = mm(L) * mm(D) * mm(H) * qty; form = 2 * mm(L) * mm(H) * qty; basis = "L·T·H, 2 faces"; } else notes.push("length, thickness or height unknown");
      if (main.dia && main.s && L && H) steel += 2 * barsAlong(L, main.s) * (mm(H) + 0.4) * barKgPerM(main.dia) * qty;
      if (cross.dia && cross.s && L && H) steel += 2 * (barsAlong(H, cross.s) + 1) * mm(L) * barKgPerM(cross.dia) * qty;
      break;
    }
    case "retwall": {
      if (L && D && H) { conc = mm(L) * mm(D) * mm(H) * qty; form = 2 * mm(L) * mm(H) * qty; basis = "stem L·T·H (footing not read)"; notes.push("footing and bars priced in Estimates"); } else notes.push("length, stem thickness or height unknown");
      break;
    }
    case "generic": case "kerb": case "stairs": {
      if (L && W && D) { conc = mm(L) * mm(W) * mm(D) * qty; basis = "L·W·D"; } else notes.push("no formula for this element here — Estimates prices it");
      break;
    }
    default: notes.push("no formula for this element here — Estimates prices it");
  }
  return { concreteM3: r2(conc), steelKg: Math.round(steel), formworkM2: r2(form), excavationM3: r2(exc), basis, notes };
}

export function proposalTotals(elements, calcOf) {
  const t = { concreteM3: 0, steelKg: 0, formworkM2: 0, excavationM3: 0, elements: 0, uncounted: 0 };
  (elements || []).forEach((e) => { const q = elementQuantities(e, calcFamily(e.type, calcOf)); t.elements++; if (!q.concreteM3 && !q.steelKg && !q.formworkM2) t.uncounted++; t.concreteM3 += q.concreteM3; t.steelKg += q.steelKg; t.formworkM2 += q.formworkM2; t.excavationM3 += q.excavationM3; });
  t.concreteM3 = r2(t.concreteM3); t.formworkM2 = r2(t.formworkM2); t.excavationM3 = r2(t.excavationM3);
  return t;
}
