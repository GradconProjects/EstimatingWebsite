/**
 * Packages within a project (Grady, 4 Nov 2026: "so we dont have different
 * disjointed packages within a project. i would like to be able to under a
 * project add different line items as the main projects with the option of
 * adding all the packages together or individually in the tender quote").
 *
 * A package is a named group of elements INSIDE one project — "Main
 * residence", "Pool & surrounds", "Stage 2 extension" — a separable portion
 * whose sums ADD UP to the project (an alternative priced instead of
 * another is not a package). `quote.packages = [{id, name, marginPct?}]` in
 * display order; `item.packageId` names the element's package. A project
 * with no packages is exactly what it was. Pure: no React, no DOM.
 */
import { uid, pinnedMargin, projectMargin, computeElementCost, computeElementSell, isProvisional } from "./costing.js";

export const DEFAULT_PACKAGE_NAME = "Main works";
export const UNASSIGNED_LABEL = "Unassigned";

export const packageList = (quote) => (quote && Array.isArray(quote.packages) ? quote.packages.filter((p) => p && p.id) : []);
export const hasPackages = (quote) => packageList(quote).length > 0;
export const packageById = (quote, id) => packageList(quote).find((p) => p.id === id) || null;
export const packageOf = (quote, item) => (item && item.packageId ? packageById(quote, item.packageId) : null);
export const packageName = (pkg) => (pkg ? String(pkg.name || "").trim() || "Package" : UNASSIGNED_LABEL);
/** The package name an element prints under; "" on a project without packages. */
export function packageLabelFor(quote, item) {
  if (!hasPackages(quote)) return "";
  return packageName(packageOf(quote, item));
}
/** The elements grouped in package order — `[{pkg, items}]`; an element whose
 * package is gone or unset comes LAST under `pkg: null` (shown "Unassigned").
 * On a project without packages: one group, `pkg: null`, every element. */
export function itemsByPackage(quote, items) {
  const pkgs = packageList(quote);
  const list = Array.isArray(items) ? items : [];
  if (!pkgs.length) return [{ pkg: null, items: list }];
  const groups = pkgs.map((p) => ({ pkg: p, items: [] }));
  const rest = [];
  list.forEach((it) => { const g = it && it.packageId ? groups.find((x) => x.pkg.id === it.packageId) : null; if (g) g.items.push(it); else rest.push(it); });
  if (rest.length) groups.push({ pkg: null, items: rest });
  return groups;
}
export const newPackage = (name) => ({ id: uid(), name: String(name || "").trim() || DEFAULT_PACKAGE_NAME });

/** Adds a package. The FIRST package takes every existing element with it
 * (a project is either packaged or not — nothing is left stranded). Returns
 * the quote fields to patch: `{packages, items}`. */
export function addPackagePatch(quote, name, pkg = newPackage(name)) {
  const pkgs = packageList(quote);
  const items = Array.isArray(quote && quote.items) ? quote.items : [];
  return { packages: pkgs.concat([pkg]), items: pkgs.length ? items : items.map((it) => ({ ...it, packageId: pkg.id })), packageId: pkg.id };
}
export function renamePackagePatch(quote, id, name) {
  return { packages: packageList(quote).map((p) => (p.id === id ? { ...p, name: String(name || "") } : p)) };
}
/** Removes a package: its elements move to the FIRST remaining package; when
 * none remains every element loses its packageId and the project is plain again. */
export function removePackagePatch(quote, id) {
  const remaining = packageList(quote).filter((p) => p.id !== id);
  const items = (Array.isArray(quote && quote.items) ? quote.items : []).map((it) => {
    if (!remaining.length) { const { packageId, ...rest } = it; return packageId === undefined ? it : rest; }
    return it.packageId === id || !remaining.some((p) => p.id === it.packageId) ? { ...it, packageId: remaining[0].id } : it;
  });
  return { packages: remaining, items };
}
export function movePackagePatch(quote, id, dir) {
  const pkgs = packageList(quote).slice();
  const i = pkgs.findIndex((p) => p.id === id); const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= pkgs.length) return { packages: pkgs };
  const [p] = pkgs.splice(i, 1); pkgs.splice(j, 0, p);
  return { packages: pkgs };
}
/** Moves one element into a package ("" / null = unassigned). An unknown package id is ignored. */
export function assignElementPatch(quote, itemId, packageId) {
  const ok = !packageId || !!packageById(quote, packageId);
  return { items: (Array.isArray(quote && quote.items) ? quote.items : []).map((it) => {
    if (it.id !== itemId || !ok) return it;
    if (!packageId) { const { packageId: _p, ...rest } = it; return rest; }
    return { ...it, packageId };
  }) };
}
/** A package's own margin (a fraction; blank clears it — the package then follows the project margin). */
export function packageMarginPatch(quote, id, pct) {
  const m = pinnedMargin(pct);
  return { packages: packageList(quote).map((p) => { if (p.id !== id) return p; const { marginPct, ...rest } = p; return m == null ? rest : { ...rest, marginPct: m }; }) };
}
export function packageMargin(quote, pkg) {
  const p = pinnedMargin(pkg && pkg.marginPct);
  return p == null ? projectMargin(quote) : p;
}
/** Every package with its elements priced — `[{id, name, pkg, count, cost, loaded, sell, provisional, margin}]`
 * in package order (the unassigned group last, id null). Sums add up to the project. */
export function computePackageTotals(quote, items, rates, projectScope) {
  const q = quote || {};
  return itemsByPackage(q, items).map(({ pkg, items: group }) => {
    let cost = 0, loaded = 0, sell = 0, provisional = 0;
    group.forEach((it) => {
      const e = computeElementSell(it, rates, q, projectScope);
      cost += e.cost; loaded += e.loaded; sell += e.sell;
      if (isProvisional(it)) provisional += computeElementCost(it, rates, projectScope).total;
    });
    return { id: pkg ? pkg.id : null, name: packageName(pkg), pkg, count: group.length, cost, loaded, sell, provisional, margin: sell > 0 ? 1 - loaded / sell : packageMargin(q, pkg) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Colour-coded packages (Grady, 4 Nov 2026: "COLOUR CODED THE differenct packages"): every package has a colour —
// its own `colour` (#rrggbb, picked on the band) or, unset, the palette entry for its position — read everywhere the
// package is shown: the band, the chip, the left edge of its element cards, the rail header, the tender panel and the
// prints. `inkFor` picks black or white text for legibility on it.
export const PACKAGE_COLOURS = ["#1d4ed8", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#4d7c0f", "#0e7490", "#9f1239"];
export const UNASSIGNED_COLOUR = "#525252";
export const isHexColour = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ""));
export function packageColour(quote, pkg) {
  if (!pkg) return UNASSIGNED_COLOUR;
  if (isHexColour(pkg.colour)) return pkg.colour.toLowerCase();
  const i = packageList(quote).findIndex((p) => p.id === pkg.id);
  return PACKAGE_COLOURS[(i < 0 ? 0 : i) % PACKAGE_COLOURS.length];
}
/** Black or white text for a background colour (WCAG relative luminance). */
export function inkFor(hex) {
  if (!isHexColour(hex)) return "#ffffff";
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return lum > 0.179 ? "#111111" : "#ffffff";
}
export function packageColourPatch(quote, id, hex) {
  return { packages: packageList(quote).map((p) => { if (p.id !== id) return p; const { colour, ...rest } = p; return isHexColour(hex) ? { ...rest, colour: String(hex).toLowerCase() } : rest; }) };
}

// Package assumptions (Grady, 4 Nov 2026: "package geometeries for all should have their own assumptions logic too"):
// `pkg.assumptions = [{id, text, tenderText?, tenderSource?}]` — the same shape as `quote.assumptions`, edited on the
// package's own geometry panel, printed under the package and read into the Tender Notes prefixed with the package name.
export const packageAssumptions = (pkg) => (pkg && Array.isArray(pkg.assumptions) ? pkg.assumptions : []);
export function packageAssumptionsPatch(quote, id, assumptions) {
  const list = Array.isArray(assumptions) ? assumptions : [];
  return { packages: packageList(quote).map((p) => (p.id === id ? { ...p, assumptions: list } : p)) };
}

// The elements the summary ticks keep (Grady, 4 Nov 2026: "all created packages should act individually and only come
// together by the checklist toggles"): an element of an UNTICKED package leaves; an element whose package is gone or
// unset (the null group) always stays. `excluded` is a Set (or array) of package ids. The ONE reading for the rail, the
// overall margin register and the combined project geometry.
export function itemsInPackages(quote, items, excluded) {
  const skip = excluded instanceof Set ? excluded : new Set(Array.isArray(excluded) ? excluded : []);
  if (!skip.size || !hasPackages(quote)) return items || [];
  return (items || []).filter((it) => !(it && it.packageId && skip.has(it.packageId) && packageById(quote, it.packageId)));
}
