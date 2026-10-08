# Gradcon Estimator — instructions for Claude Code

This is Gradcon Concrete Constructions' estimating tool: pick a structural
element from a dropdown, the entire material/reo/formwork/labour catalog
for that element rolls out below it, fill in quantities, and everything
rolls up live into a quote (element → section → grand total → margin
ladder). It's a React + Vite + Tailwind app, built to replace an Excel
workbook that did the same thing with formulas.

Read this whole file before changing anything in `src/lib/costing.js` or
`src/data/catalog.js` — the costing rules below aren't arbitrary, they're
what a real Excel workbook got wrong once and had corrected. Breaking one
of them silently produces a wrong quote, not a crash.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run verify      # re-runs the costing regression checks — do this after ANY change to catalog.js or costing.js
npm run build        # production build
```

`npm run verify` runs `scripts/verify.mjs` in plain Node — no browser, no
build step. It caught two real bugs during development (a duplicate
"Pump" resource key silently overwriting itself, and Trench Mesh/Square
Mesh/Stock Bar being costed off tonnage instead of their catalog $/unit
price). Treat a red `verify` run the same as a broken build.

## Architecture

```
src/
  data/catalog.js       — ALL domain data. No React, no logic. Plain arrays/objects.
  lib/costing.js         — ALL domain logic. Pure functions, no React, no DOM.
  lib/storage.js          — the ONE hook that talks to localStorage.
  components/              — presentation only. Should not contain business rules
                             (a component multiplying qty * rate itself, instead of
                             calling computeElementCost, is a bug waiting to diverge).
  App.jsx                    — composition root: wires storage + costing + components together.
scripts/verify.mjs            — Node-runnable regression checks for lib/costing.js.
```

**Why data/logic/UI are split like this:** `data/catalog.js` and
`lib/costing.js` have zero React or DOM dependency, so they can be
imported directly by plain Node (`scripts/verify.mjs` does exactly this).
That's what makes fast, no-browser regression testing possible. If you
move costing logic into a component (e.g. compute a row's cost inline in
`CategoryBlock.jsx` instead of via `computeElementCost`), you lose that
safety net silently. Keep all cost arithmetic in `lib/costing.js`.

## Costing rules (the part that's easy to get subtly wrong)

1. **Every product in `FULL_CATALOG` is shown on every element type, always.**
   There is no per-element filtering of which categories or products
   apply — that was a deliberate decision (Grady wants to see the whole
   catalog and decide per job what applies, not have the tool guess).
   A blank quantity costs $0 and contributes nothing — that's what makes
   showing the whole catalog on every tab harmless. **Do not add
   per-element-type filtering of catalog rows** without checking that's
   actually what's wanted; it was explicitly requested to be removed once
   already (see git history / prior conversation) after an earlier
   version tried to curate a subset per element type. **One explicit
   exception, by request (15 Sep 2026):** a category carrying `visibleFor:
   [<element categories>]` renders and costs ONLY on elements of those
   categories — today `SPECIALIST FINISHING CONCRETE` (on the Specialist
   Finishing Concrete elements) and `PRELIMINARIES` (on the Preliminaries
   elements — traffic management, temporary access, site establishment,
   supervision and so on, added 17 Sep 2026; those elements are first in the
   dropdown and use the `prelims` crew-sheet template). `categoryAppliesTo(cat, item)`
   in `costing.js` is the ONE test; `computeElementCost`, `ElementCard`,
   `PrintQuoteReport`, `exportQuote` and the Cost Planner publish all use it,
   so a hidden band can never carry invisible money (verify-covered).

2. **Only `PROCESSED BAR` costs off Total Weight, and only `SQUARE MESH`
   costs off Total Area.** Processed Bar's catalog `unitCost` is genuinely
   $/tonne (`weightBasis: true`). Square Mesh's `unitCost` is genuinely
   $/sheet, but the estimator enters **m² of coverage**, not a sheet count
   — `areaBasis: true` tells `computeRowTotal` to cost it as
   `ceil(qty / sheetArea) * unitCost` (sheets are bought whole, so this
   always rounds up; `sheetArea` — 14.4 m², a standard 6.0×2.4m sheet — is
   a per-product catalog/rate field, editable in the Rates modal like
   `unitWeight`). Every other category — including Trench Mesh and Stock
   Bar, which also carry a `unitWeight` — costs as `qty * unitCost`
   directly, because their catalog price is per length/bar, not per tonne;
   that leftover `unitWeight` exists purely so the UI can show informational
   tonnage (useful for delivery planning). **`computeRowTotal` in
   `costing.js` is the ONE place that implements all three rules — always
   call it (from `computeElementCost`, `CategoryBlock.jsx`,
   `PrintQuoteReport.jsx`) rather than recomputing a row total inline
   anywhere else, or the three will eventually disagree.** If you add a new
   weight- or area-priced category, set the matching flag in `catalog.js`.
   If you're unsure whether a category should be `true` on either flag, it
   almost certainly shouldn't be — only Processed Bar and Square Mesh are.

3. **Percentages are fractions, not whole numbers.** `overheadPct: 0.08`
   means 8%, not `8`. A whole-number entry displayed with a `%` format
   but stored as `8` would multiply through as 800%. This bit the
   original Excel workbook once. There's no UI validation preventing
   someone typing `8` instead of `0.08` in the Overheads/Contingency
   inputs right now — if you're touching `QuoteSummary.jsx`, consider
   whether the input should divide by 100 for a more human-friendly "type
   8 for 8%" UX, but if you do, update `computeMarginLadder`'s callers
   consistently (don't have some callers pass fractions and others
   percentages).

4. **The margin ladder divides, it doesn't multiply.** Sell price =
   `subtotal / (1 - margin)`, not `subtotal * (1 + margin)`. A 30% margin
   on cost is not the same number as a 30% markup — this app implements
   margin-on-sell-price (the construction-industry convention Gradcon
   uses), matching the original workbook. See
   `computeMarginLadder` in `costing.js`.

5. **`RESOURCE_COLS` has two entries named "Pump"** (`pump_hr` and
   `pump_m3` — the catalog prices pumping both per hour and per m³ of
   concrete pumped). They're distinguished by `key`, not `name`. Anywhere
   you index labour data by resource, **use `key`, never `name` alone** —
   keying by name was a real bug during development (the `pump_hr`
   column's totals silently went missing because a `{name: column}` map
   only kept the last "Pump" entry). If you add another resource that
   shares a name with an existing one, give it a distinct `key` and check
   `verify.mjs`'s "BOTH Pump columns" test still passes as a pattern to
   follow.

6. **Rate lookups always fall back to the catalog default.** Use
   `lookupRate(rates, key, fallback)` (or the same `rates[key] || fallback`
   pattern) everywhere a rate is read — never index into the `rates`
   object directly and assume the key exists. This matters because a
   user's saved `rates` blob in localStorage predates any future catalog
   additions; a missing key should degrade to the catalog default, not
   render blank/undefined pricing. `verify.mjs` has a test for this
   ("falls back to catalog default rather than $0") — keep it passing.

7. **Concrete delivery fees are auto-applied, per the Holcim schedule.**
   Three CONCRETE rows cost themselves from the element's poured volume
   rather than being typed: **Minimum cartage** (the poured volume is
   divided by `MIN_CARTAGE_THRESHOLD_M3` = 4 m³ into whole loads, and the
   REMAINDER of that division — a part load — is charged $80 per m³ it is
   short of 4; a volume that divides evenly leaves no remainder and costs
   nothing, so 11 m³ → 2 loads + 3 m³ → 1 m³ short → $80, while 12 m³ →
   nothing), the **production & transport surcharge** and the
   **environment levy** (both flat $/m³ on every delivered m³).
   `TRUCK_LOAD_M3` and the "Concrete truck load size" production rate no
   longer feed minimum cartage — the divisor is the 4 m³ minimum itself. Typing a Qty on any of those rows takes that row
   fully manual — that's how a known delivery split is priced exactly.
   None of the three count towards `concreteQty` (they're fees, not
   poured volume), and none is charged on the others. See
   `autoMinimumCartage` / `autoConcreteSurcharge` / `autoEnvironmentLevy`
   in `costing.js` — each has exactly ONE implementation, called by
   `computeElementCost`, `CategoryBlock.jsx` and `PrintQuoteReport.jsx`.

   **VicMix charges work the same way on the `SPECIALIST FINISHING
   CONCRETE` band**: `autoPigmentWashout` ($40 + GST per Maxi truck of
   PIGMENTED mix — charcoal / half black / black / oxide; "Ivory" is a
   cement, not a pigment — trucks = ceil(m³ / "VicMix Maxi truck load size"))
   and `autoSpecialistShortLoad` (one charge when the pour is under the
   "VicMix minimum delivery" production rate; VicMix does not publish the
   amount, so it seeds $0). Each has ONE implementation, called by
   `computeElementCost`, `CategoryBlock.jsx`, `PrintQuoteReport.jsx` and
   `exportQuote.js`; a typed Qty takes the row manual. Specialist m³ IS
   poured concrete for `rowContext` (kg/m³ steel), `labourQuantities` and
   `concreteQty`, but NEVER for the Holcim fees above (different supplier).
   The Rates Library's "Specialist concrete" section lists every product by
   the same name so its prices govern Quotes through `ratesLibrarySync`;
   `verify.mjs` fails if the two lists drift.

8. **Contract minimums bill through `computeRowTotal`.** A product can
   carry a `minQty` (the 7th field in its catalog row) — a "4 hour min"
   pump bills 4 hours for a 1-hour job. `computeRowTotal` raises the
   quantity to `minQty` before any weight/area/length basis applies, and
   only when the row has a quantity at all (a blank row still costs
   nothing). Every CONCRETE PUMPING rate and minimum comes from the
   supplier's schedule and is editable in the Rates modal.

9. **Reinforcement can be priced off a RATE instead of a schedule.**
   `REINFORCEMENT BY RATE` is the only `volumeRateBasis: true` category: its
   Qty is entered as **kg of steel per m³ of concrete** and it costs as
   `(qty * concreteM3 / 1000) * unitCost` (`unitCost` is $/tonne, as for
   Processed Bar in rule 2). This is the one basis whose cost depends on
   *another* category's quantities — the element's own CONCRETE rows — so
   `computeRowTotal` takes a 4th `ctx` argument that every caller builds with
   **`rowContext(item)`**. If you add a `computeRowTotal` call, pass that ctx;
   omitting it silently prices every rate row at $0 (it degrades to zero
   rather than `NaN`, so nothing crashes — it just quietly costs nothing).
   The delivery-fee rows are not poured volume (`pouredVolume` excludes
   them), so the levy and surcharge never inflate the steel.
   `computeElementReinforcementTonnes` counts these rows too, so a
   rate-priced element still drives steel-fixing crew days like a bar-listed
   one. These rows are an **alternative** to bar-listing, not an addition —
   an element carrying both a schedule and a rate buys its steel twice. That
   isn't enforced (a blank row costs nothing, exactly like every other row);
   the category label says so on its face instead.

10. **GST is hardcoded at 10%** (`GST_RATE` in `catalog.js`). This is an
   Australian tool. If this is ever adapted for another market, that's
   the one place to change — but check every place `GST_RATE` or `* 1.1`
   is used (currently just `computeMarginLadder`).

## How to extend

- **Add a new material product:** add a row to the relevant category's
  `products` array in `catalog.js` — `[name, unit, unitWeight, unitCost]`,
  `unitWeight`/`unitCost` are `null` if not applicable. It will
  automatically appear on every element card and in the Rates modal; no
  other file needs to change.

- **Add a new material category:** add an object to `FULL_CATALOG`
  (`{ key, weightBasis, products }`) — it renders automatically via the
  `FULL_CATALOG.map(...)` in `ElementCard.jsx`. Decide `weightBasis`
  carefully — see rule 2 above.

- **Add a new element type (tab):** add an entry to `ELEMENT_TYPES` in
  `catalog.js` with a `category` (the broad, foldable group shown as
  optgroups in the Add-Element dropdown and as the outer fold in
  QuoteSummary — e.g. `FOUNDATIONS`, `SUSPENDED STRUCTURE`), a `section`
  (the finer sub-group nested under category in QuoteSummary — existing
  or new), and a `labour` key pointing at one of the `LABOUR_TEMPLATES`
  (or a new one, if the task sequence genuinely differs — e.g.
  ground-bearing slabs pour blinding and lay poly; suspended slabs prop
  and strip formwork instead; excavation-only elements don't pour
  concrete at all). Both `category` and `section` are required — `npm run
  verify` fails an entry missing either. Keep new entries in roughly
  ground-up construction order in the array (earthworks → foundations →
  retention → substructure → vertical structure → suspended structure →
  external/landscape → pool → civil) — that order is what the dropdown
  and summary display, and it's meaningful to an estimator scanning the
  list. `ELEMENT_TYPES` is deliberately comprehensive — every
  concrete/structural element Gradcon might meet across any building or
  civil project, not curated per job (see rule 1).

- **Crew-sheet rows are matched by NAME** (`taskRowMeta` in `costing.js`):
  a row whose name says "excavate" draws its Qty from the element's
  **Excavation** (m³) line, a row saying "spoil" / "soil removal" / "cart
  away" from its **Soil removal** (m³) line — two rows, two quantities,
  never merged (an element from before the Excavation line existed falls
  back to soil removal for the excavate row). Neither row auto-fills
  excavator or truck days. Elements keep the task rows they were created
  with, so an older element gets the spoil row by renaming one of its
  "Additional labour / plant" rows.

- **Every trench-reinforcement layer is one of three products**
  (`trenchMeshTypeSel` is the ONE selector: L-series trench mesh, an SL/RL
  sheet cut as strips, or straight stock bars encoded as `"<count> Bar-N<dia>"`
  from `STOCK_BAR_LAYER_DIAS`; `layerProduct(type)` tells them apart). A bar
  layer is priced by `stockBarLayerLine` as plain `N12` by the METRE (count ×
  layers × run, bar lap %), never as a trench product by the lineal metre,
  so the register, the orders schedule and the Quotes bridge see ordinary
  bar. The beam calculator and every slab beam run (edge beams, internal
  strips, extra groups) branch on it before `trenchReoMassPerM`.
- **Mesh sizes live in one catalog, mirrored in two places:** `SQUARE MESH`
  in `catalog.js` (name, sheet weight, $/sheet) is the source; the
  Estimates `MESHTYPES` table (kg/m² = sheet weight ÷ 14.4) and the portal
  Settings default-mesh select must list the same names —
  `scripts/verify-estimates.mjs` fails if they drift. Rates Library and
  Cost Planner carry their own copies of the same list. Add a new size to
  the catalog first, then the two mirrors.

- **Add a new labour resource:** add to `RESOURCE_COLS` with a unique
  `key`. It appears as a new column in every element's Labour/Equipment
  matrix and in the Rates modal automatically.

- **Change default prices:** edit the `unitCost`/`unitWeight` values
  directly in `catalog.js`. Note this only changes what a *fresh install*
  seeds — a user who has already opened the Rates modal and edited a
  price has that override saved in `localStorage` under `gradcon-rates`,
  which takes precedence (see `lookupRate`). There's currently no "reset
  to catalog defaults" button; add one if that's needed (clear the
  relevant key from the stored rates object).

## Rates: what is shared, what is per element, what is pinned (read before touching rates)

Three rules, each from a real loss (25 Spindrift Ave, 29 Sep 2026: a screw
piling quote typed on one project changed on its own, because the figure
lived in the one shared rate that two other projects also carried):

1. **A subcontract "quote" row's amount belongs to the ELEMENT.** Typing the
   received quote onto a `unit: "quote"` row (the amount cell or the Unit $
   cell in `CategoryBlock`) writes `item.rateOverrides[rateKey] = {unitCost}`
   — never the shared `gradcon-rates` row. **`rowRate(item, rates, key,
   fallback)` in `costing.js` is the ONE per-row rate read** (the shared
   rate through `lookupRate`, with the element's override laid over it):
   `computeElementCost`, `computeElementReinforcementTonnes`, the auto fee
   rows, `CategoryBlock`, `PrintQuoteReport` and `exportQuote` all use it.
   A new per-row costing path must call `rowRate`, not `lookupRate`, or an
   overridden quote silently prices at the shared figure. Clearing the
   amount removes the override. **Every subcontract quote row is manual-only**
   (`isManualQuoteKey`: any `quote`-unit key — Grady, 29 Sep 2026: "remove all
   unit rates for sub contractors … I have seen this replacing manually
   entered actual live quotes"): `rowRate` never reads the shared rate for
   them, a row with a qty but no figure typed on the element costs NOTHING
   and shows a red "quote amount needed" chip, its Unit $ cell is EMPTY (no
   input, no placeholder — the amount cell is the only place a quote goes),
   the Rates modal does not list them, the Rates Library has no subcontractor section at all, and App.jsx
   wipes any figure such a key still holds in the shared rates on load. The
   band's only rated product is the tonne-priced temporary props row. Never
   add a subcontract price to `catalog.js`, the library or the shared rates.
   Rates have NO version history (quote versions hold items, not rates), so
   an overwritten shared figure is unrecoverable — that is why this rule
   exists. The other card-side rate edits (Holcim fees, kg/m³ steel, crew
   rates) still write the shared rates through `setMaterialRate` /
   `setLabourRate` in `App.jsx` (or the pinned copy, rule 3).

2. **The Rates Library governs the live rates, including the fuel/transport
   surcharge.** `lib/ratesLibrarySync.js` maps priced library sections by
   product NAME onto catalog keys; `GLOBAL_PRICES` adds library figures that
   live in its `global` block — today only `global.concreteSurchargePerM3`
   → the CONCRETE "Production & transport surcharge" row (until 29 Sep 2026
   nothing joined the two, so changing the surcharge in the library changed
   no quote). The library's `validity` block (`{<catalog product name>:
   "YYYY-MM-DD"}`, entered in its "Validity of surcharges, levies & fees"
   panel — `VALIDITY_ITEMS`, whose names `verify.mjs` checks against the
   catalog) syncs the same way as `rates[key].validUntil`;
   `pendingRateUpdates` emits `{key, validUntil}` entries beside the
   `{key, price}` ones. `lib/rateValidity.js` (pure): `isTimeLimited(name)`
   (surcharge / levy / cartage / washout / short-load / delivery-beyond /
   delivery-fee rows get a "Valid until" field in the Rates modal),
   `validityState` (expiring within `VALIDITY_WARN_DAYS` = 14, or expired;
   dates parse as LOCAL days), `expiringRates(rates, today)` → the alarm
   `RateValidityBanner` shows on the Dashboard and in every open project, off
   the LIVE rates; the library shows its own copy of the alarm at the top of
   the page. Nothing changes a figure when its date lapses — the alarm is
   the reminder to enter the supplier's next notice and date together.

3. **A finished project keeps its own copy of the rates** (`lib/rateFreeze.js`,
   pure): the moment a status enters `RATES_LOCKED_STATUSES` (Completed
   Estimating, Quoting, Submitted, Tendered, Successful, Unsuccessful — never
   Queued / Estimating / On Hold) `statusChangePatch` writes `quote.ratesFrozen
   = {at, status, rates}` (a full copy of the live rates); moving between two
   locked statuses keeps the pin; moving back to an open status sets
   `ratesFrozen: null`. `statusChangePatch` is the ONE status rule — the
   editor's select and the Dashboard's dropdown both go through it (the
   Dashboard patches `{status, ratesFrozen}` through `patchQuoteFields`).
   `effectiveRates(quote, liveRates)` (pinned copy over live, so a product
   added later still resolves) is what `ProjectEditor` costs with and passes
   to every child, report, export and the Rates modal, and what the
   Dashboard's `summarizeQuote` uses. Inside a locked project every rate
   write (`setRates`, card fee edits, crew rates, the Rates modal) lands on
   the pinned copy — never the shared rates, and the library never touches
   the copy. A project finished before pins existed is pinned the first time
   it is opened (`needsFreeze`, once its row and the live rates have both
   settled); until then the Dashboard prices it off the live rates. The
   editor's blue "Rates pinned" banner reports `frozenRateDrift` and the
   only way a pinned project re-prices is its "Re-price with current rates"
   button (two clicks; a `before-reprice` version is kept first).

## Quote scope: labour + materials, labour only, materials only

Grady, 2 Oct 2026: "labour only options … some elements labour only and
others including materials … at project setup select materials only or
labour only". `quote.scope` ("both" default, "labour", "materials";
`QUOTE_SCOPES` in catalog.js) is set in the editor header beside the live
total; `item.scope` (unset / "inherit" = the project's) is the select on an
element card's header, so one element can differ. `elementScope(item,
projectScope)` in costing.js is the ONE resolution and
`categoryChargedUnder(cat, scope)` the ONE test: every catalog band carries
a `scopeBucket` — "material" (the default: every supply band) is NOT charged
under labour-only, "labour" (CONCRETE PUMPING — placement) is NOT charged
under materials-only, "always" (RATE ITEMS, PRELIMINARIES, OTHER
ALLOWANCES, SUB CONTRACTORS / TEMPORARY WORKS — figures typed
deliberately) is charged under every scope; the crew sheet drops out of
materials-only. **Quantities are never touched** — they still drive the crew
days, the register and the bridge — and the excluded money is returned
beside the total (`excludedMaterials`, `excludedLabour`,
`excludedTotals[cat]`, `computeExcludedTotals(items, rates, scope)`) so it
can be stated, never lost. `computeElementCost`, `computeGrandTotal`,
`computeElementUnitRates`, `computeProjectUnitRates` and
`computeExternalScopeLines` all take the project scope as their LAST
argument; every caller (ElementCard, QuoteSummary, ProjectGeometryPanel,
PrintQuoteReport, exportQuote, tenderQuoteDefaults, ExternalQuoteReport,
Dashboard's `summarizeQuote`) passes `quote.scope` — a new caller that omits
it silently prices as labour + materials. Cards show a "not charged — <scope>"
tag on an excluded band (its would-be figure struck through), the labour
matrix likewise under materials-only; the summary rail, print report and
exports state the scope and the figures not charged. Verify-covered.

## Roof is its own element category (both apps)

Grady, 6 Oct 2026: "INCLUDE ROOF as an element category to include all roof
concrete elements, including box gutters, suspended slabs propped and
cantilevered". Quotes: `ROOF` in `ELEMENT_TYPES`, right after SUSPENDED
STRUCTURE (the roof sits on it; `verify.mjs` pins the order), sections ROOF
SLABS (propped roof slab, cantilevered roof slab / canopy, plant deck, lift
overrun), ROOF BEAMS (roof / band beam) and ROOF GUTTERS & PARAPETS (concrete
box gutter, parapet / upstand, roof plinth / plant kerb / hob) — 8 types, all
on the `slab_suspended` crew sheet except the parapet (`wall`). Estimates: the
`Roof` library group carries the same eight (`roofslab` keeps its id, its
label is now "RC Roof Slab (propped)"; `roofslabcant`, `plantdeck`,
`liftoverrun` are suspended `slab`s; `roofbeam` is a `beam` with
`beamCategory: "Roof"`; `parapet` a `wall`; `roofplinth` a `kerb`). **The box
gutter is its own CROSS-SECTION calculator** (`boxgutter`: `boxGutterDefaults`
/ `boxGutterGeom` / `renderBoxGutter` / `computeBoxGutter` / `diagBoxGutter` —
Grady, 6 Oct 2026: "BOX gutter should be cross sectional. we determine
everything as per the cross section and it multiplies by the length"): the
section is typed once — internal width and depth, base thickness, wall A / B
thicknesses, wall A / B heights (blank = the internal depth; a taller wall is
the upstand against a parapet), cover — and EVERY quantity is a per-metre
figure of that section × run length × runs: concrete area (plus typed closed
ends), formed faces (soffit = external width, outer faces = full external
height for 2 / 1 / 0 faces, inner faces = both wall heights), the membrane
girth (width + both wall heights, 10% laps), waterstop on both base/wall
joints, longitudinal bars counted in the section, and transverse U-bars at a
spacing (run ÷ spacing + 1, each the developed length = base + both legs
inside the cover, or a typed length) or a mesh bent to the section (girth ×
run, whole sheets). `boxGutterGeom(d)` is the ONE reading. Suspended at roof
level: never digs or blinds; a blank run prices NOTHING (completeness
warning); `autoGeometry` publishes the run. `DEFAULT_COVERS.boxgutter` = 40.
`DEFAULT_COVERS` also carries the new slab categories and the Roof beam; the
library's `EST_WASTE_TYPES`
mirror and `ESTIMATE_TYPE_MAP` (every roof label → its Quotes id) are
verify-covered; the CSV importer's label rules match box gutter / parapet /
plant deck / overrun / cantilever / roof beam before the generic slab and
wall rules.

## Dashboard opens on the open work only

`OPEN_STATUSES` (`lib/planner.js`, used by `Dashboard.jsx`) = Queued, Estimating: the status filter
starts on the "Open — Queued & Estimating" tile, so a quote that has gone out
(or is finished, quoting, on hold, won or lost) leaves the main screen and
sits under its own status tile and under "All projects" — never deleted,
never hidden from the tiles' counts. Clicking the active tile again toggles
between Open and All. Session-local; every fresh load starts on Open.
Grady, 1 Oct 2026.

## Deadlines stop at submission

`lib/planner.js`: `SUBMITTED_STATUSES` (Submitted, Tendered, Successful,
Unsuccessful). `statusChangePatch` (`lib/rateFreeze.js`, the ONE status rule)
writes `quote.submittedAt` (a local "YYYY-MM-DD") the moment a status enters
that set, keeps it through the pipeline and clears it (`null`) on a move back
to an open status. `daysLabel` / `dashboardDueLabel` take `(deadline, status,
submittedAt)` and, for a submitted quote, show the FROZEN result
(`submittedLabel`: the text is the DAY it went out — "Submitted 1 Oct 2026",
Grady, 2 Oct 2026 — with how it landed against the deadline as the hover
`title` ("2d before / on the deadline day / 3d after the … deadline"), or
plain "Submitted" when no day was recorded — never a date or count
invented from today);
`isUrgent(planner, status)` and the Planner's "Projects overdue" tile
(`isOverdue`) ignore submitted quotes. Grady, 1 Oct 2026: "when a quote is
submitted, the days overdue should cease counting".

## Project lists sort by ONE rule

`lib/projectSort.js` (pure): `PROJECT_SORTS` (date added, date completed,
date submitted, deadline, project date, name, client, status, and — Dashboard
only, `costed: true` — value, direct cost, elements), `sortProjects(rows, key,
dir)` (stable, ties by name, a row with no value for a DATE key sinks to the
bottom in either direction so "Date completed" never opens on the unfinished
work), `defaultSortDir`, `preferredSortKey` (the portal Settings "Dashboard
sort order", whose option list `verify.mjs` checks against `PROJECT_SORTS`).
The Dashboard sorts through its "Sort by" select, the Asc/Desc button and
every column heading (`SortTh`; click to sort, click again to flip); Project
Management (`PLANNER_SORTS` = its own "Priority, then deadline" + the
uncosted keys, applied inside BOTH sections) and the Vault use the shared
`ProjectSortBar` (`atoms.jsx`). Session-local everywhere. **`completedAt`**
(a local "YYYY-MM-DD") is the day estimating finished: `statusChangePatch`
writes it when a status first enters `RATES_LOCKED_STATUSES`, keeps it through
the pipeline and clears it (`null`) on a move back to an open status;
`completedDay(quote)` is the ONE reader — the recorded day, else the day the
rates were pinned (a project finished before the field existed), else null,
never today. The Dashboard shows it in its "Completed" column and the planner
card beside the deadline. Grady, 2 Oct 2026.

## Multi-project dashboard

The app has two views, switched in `App.jsx` by whether `activeId` points
at a project: the **Dashboard** (`components/Dashboard.jsx`) lists every
project with a live-computed summary row (direct cost, sell at the default
margin, $/m², element count) and a portfolio-wide totals footer; opening
one renders `ProjectEditor`, the original single-quote UI, scoped to that
project's own storage key. `lib/projects.js` holds a lightweight index —
`{ id, storageKey, createdAt }` per project — under `PROJECTS_INDEX_KEY`;
everything else (name, date, GFA, items) lives in the project's own quote
object, read via `readQuote`/`readQuotes`. An install that predates
multi-project support (a single quote under the old fixed `gradcon-quote`
key) auto-migrates into project #1 the first time the index loads empty —
see `migrateLegacyQuote`.

## Optional Supabase backend

`lib/storage.js`'s `useStoredState` — the one hook every piece of
persisted state goes through — transparently backs onto Supabase (a
single `estimator_kv(key, value, updated_at)` table, see
`supabase/migrations/0001_estimator_kv.sql`) when
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are set, and falls back to
per-browser `localStorage` otherwise. This is exactly the "network-backed
implementation swapped in without touching any component" the hook's
`[value, setValue, status]` signature was originally kept generic for.
Components never check which backend is active. Both the Supabase load
and save paths are wrapped in `try/catch` — a network failure (not just an
API-level error) must still resolve `status` to `"error"`, never leave it
hung on `"loading"` forever (App.jsx blocks rendering on the projects
index finishing its load).

`lib/supabaseClient.js` reads the client only from env vars — never
hardcode a URL or key. `VITE_SUPABASE_ANON_KEY` must be the
anon/publishable key; the secret/service_role key bypasses every RLS
policy and must never ship in client code. See `.env.example`.

## How a project is persisted (read before touching storage.js, projects.js or quoteVersions.js)

Three layers, each with a rule that was learned the hard way:

- **The live row** (`useStoredState` in `lib/storage.js`, one `estimator_kv`
  row per key) is the moving copy: every edit lands there within 500 ms. A
  failed save **retries on its own** (5 s → 15 s → 30 s → every 60 s) and the
  editor shows a red banner until it lands — a project once vanished
  because a save failed silently and the badge was the only sign. The hook
  cannot save an edit made before its row has loaded, so `ProjectEditor`
  renders nothing editable while `quoteStatus === "loading"`; never remove
  that gate. `applyRemote()` is the ONE way a stored value enters state —
  it arms the "remote apply" flag only when React will actually re-render
  (a same-reference `initial` bails out, and an armed flag would swallow the
  user's first real edit). `localEditPending()` is the ONE definition of
  "this browser is mid-write" that the poll, the realtime push and the
  cache-first reconcile all consult.
- **Cache-first mirrors** (`lib/localMirror.js`, `cacheFirst: true` on the
  projects index and the rates only) paint the last-known copy instantly
  with status `"syncing"`, then reconcile on `updated_at`. One-off
  migrations in `App.jsx` wait for `"saved"` (see `settled()`). **A project's
  quote is never cache-first**: its mirror would have to drop the markup
  drawings to fit, and a save from that copy would delete them. The
  dashboard's summary mirrors (drawings' image data stripped) exist only to
  draw rows. Every quote row is prefetched in one like-query at boot; the
  FIRST `readQuotes()` consumes it, later calls hit the database.
- **Summary pages never hold a full quote.** The dashboard, Project
  Management and Vault read through `readQuoteSummariesDetailed()`
  (`projects.js`): a `key, updated_at` stamp query (the boot prefetch is
  this query and nothing more), the summary mirror for every row whose
  stamp is unchanged, and — ONLY for rows that changed — the
  `estimator_kv_quote_summaries` database function
  (`supabase/migrations/0004_estimator_kv_quote_summaries.sql`: read-only,
  SECURITY INVOKER, drops `items[*].markups[*].dataURL` before the row
  leaves the database, proven in an isolated Postgres by
  `scripts/verify-summaries-sql.mjs`). Where that function is not installed
  the fallback is ONE full row per request through `readFullRowBounded()`
  (one in flight for the whole app, shared per key) — never a single select
  of every row: the 16 rows are ~30 MB and that select trips the database
  statement timeout (57014, measured 17 Sep 2026). Those copies are stripped
  of drawing data, so they are never written back whole: field edits from
  those pages go through `patchQuoteFields()` (the `estimator_kv_merge`
  database function when installed, see
  `supabase/migrations/0003_estimator_kv_merge.sql`, else a read-merge-write
  of the full row), and the mirror is patched to match. `readQuotes()` (full
  rows, bounded the same way) is only for callers that must write a whole
  quote; the Estimates import matches on summaries and reads the ONE matched
  row in full. The result separates `missing` (absent from a SUCCESSFUL
  stamp query — the only thing the dashboard ever prunes) from `failed`
  (could not be read: last-known copy stays on screen, a notice offers
  Retry, nothing is pruned, written or defaulted). A failed load must never
  be read as "this project does not exist". The 6 s poll in `storage.js`
  likewise asks for the timestamp first and fetches the row only when it is
  newer.
- **Versions** (`lib/quoteVersions.js`) are immutable full copies in the
  `gradcon-files` bucket under `quote-versions/<projectId>/` — one on every
  Save, one every N minutes (portal Settings `quotesAutosaveMinutes`, 0 =
  off) while the quote has changed, and one "before-restore" ahead of any
  restore. Nothing deletes a version. The same document shape is what "Save
  to computer" downloads and "Open .json" reads; filenames must stay ASCII
  (Chromium drops a download name containing an em dash or curly quote).

A new project is a **draft** held only in `App` state until it has a name
or an element (`onPromote`); leaving it unpromoted discards it, so an
"Untitled project" never persists. The dashboard prunes index entries whose
row does not exist (older than an hour, and only when the fetch plainly
succeeded) — an entry with no row is the other way "Untitled project" used
to appear.

**A tab keeps running the build it loaded.** The Quotes bundle runs from a
blob: URL and every other panel is inlined, so switching panels never picks
up a newer deploy — only a page reload does (30 Sep 2026: a tab open across
three deploys kept showing subcontractor rates the live site no longer
had). The shell's stale-build notice (`#stale-build`, end of
`portal-shell.html`) fetches the page with `?build-check=` on focus and
every 3 minutes, compares the `Build <b>sha` stamp with the one baked in
(`__BUILD_STAMP__`) and offers "Reload now" when they differ. When a user
reports behaviour the current build cannot produce, check the Build number
in their footer first.

The Quotes bundle is inlined into the portal and runs from a blob: URL, so
a relative chunk import cannot resolve there: `scripts/assemble-portal.mjs`
rewrites each lazily-loaded chunk (today only the PDF renderer) to
`location.origin + "/assets/<chunk>"` and asserts every step — a build only
succeeds with a working lazy path. `vite.config.js` turns the preload
helper off so the import takes the plain form that rewrite targets.

## Estimates layout switch (Phase 1 of the UX redesign)

Estimates has two layouts over ONE DOM and one set of calculators:
**classic** (the default: every element card stacked in the Workspace) and
**blueprint** (opt-in: element navigator | the selected card | inspector,
tutorials in a Help drawer, cooler tokens). The switch is the portal
preference `estBlueprintShell` (Settings → "Estimates: new blueprint layout",
or the ⇄ button in the Estimates header, which writes the same key through
`setPortalPref`). `applyShellMode(mode)` sets `body[data-shell]`, relabels
the tabs from `SHELL_LABELS`, and re-renders the workspace; every blueprint
style is scoped under `body[data-shell="blueprint"]`, so the classic skin is
untouched while the switch is off. `renderWorkspace()` branches to
`renderBlueprintWorkspace()` which mounts ONLY the selected element's card
(`BP_SELECTED_ID`) and never writes to `inst._collapsed` — the fold state
belongs to the classic layout. No layout state is ever saved into the
takeoff (`estimateStateSnapshot` is unchanged); a takeoff edited in one
layout opens identically in the other. `refreshCardResults` is the one hook
that refreshes the inspector and the navigator row after an edit — keep
calling it rather than recomputing totals in the shell code.
**`rerenderCardKeepTab` builds the replacement card OPEN** (6 Oct 2026,
Grady: "slab reinforcement folds up and doesnt reveal options to enter until
a refresh is done"): a card being typed into is open by definition, but a
never-unfolded element stores `_collapsed: true`, so a rerendering control
(a slab bar block's Method, the rate basis, "Enter as bar sections", any
`data-rerender` select or box) rebuilt the card folded and its fields
vanished. It now clears the fold for the build — classic keeps the card
open (it is), blueprint restores the stored classic fold as
`renderBlueprintWorkspace` does — tolerates a missing active tab button
(falls back to `CARD_TAB_MEMORY`) and re-arms the blueprint sticky
observer. `test-card-rerender-fold.mjs` proves both layouts.

## Estimates cloud sync (read before touching saveEstimateState, syncFromCloud or kvPush)

Three rules, each learned from a real loss (18 Beach Road, 8 Sep 2026: a
second tab pushed its stale two-element copy over a five-element takeoff,
and the first tab pulled it back within six seconds):

1. **A tab never pushes a takeoff until it has reconciled with the cloud copy
   of that key this session** (`CLOUD_RECONCILED_KEY`, set by `syncFromCloud`).
   `pushTakeoffToCloud` is the ONE cloud writer for takeoff rows; edits made
   before reconciling are saved locally and go up afterwards
   (`PENDING_CLOUD_PUSH`). Pushes are serialised per key (`PUSH_STATE`) and an
   unchanged snapshot is never re-sent (`LAST_CLOUD_HASH`), so tabs cannot
   ping-pong echoes.
2. **Every push is conditional** on the row being unchanged since this tab
   last synced it (`kvPatchIfUnchanged`, PostgREST `updated_at=eq.`). On a
   conflict the other device's copy is kept as a cloud version
   (`other-device`) BEFORE this tab's live work goes up, and the estimator is
   told in the save-status line. This tab's in-memory work always wins — it is
   the human's latest intent — but nothing is discarded.
   **Takeoffs are compared by CONTENT** (`contentString` / `sameTakeoff` /
   `snapshotHash`): project, selected types, id counter and each instance
   minus its derived `results` and any `_`-prefixed UI flag, with keys
   canonicalised. Never compare raw JSON of a snapshot: different builds
   recompute `results` differently, and on 9 Sep 2026 two sessions re-saved
   and re-versioned each other every poll (288 "before-sync" versions in
   three hours) because of exactly that. `before-sync` versions are also
   capped at one per key per minute.
3. **Cloud versions are immutable and unlimited**: `keepEstimateVersion`
   writes `estimate-versions/<projectId>/<iso>-<source>.json` to the
   `gradcon-files` bucket on every 💾 Save, every N minutes while the takeoff
   changes (portal `quotesAutosaveMinutes`, 0 = off), before a cloud pull
   replaces local content that differs (`before-sync`), before any restore,
   and on every conflict. `📁 Projects ▾` lists them with restore. Nothing
   deletes a version. `scratchpad`'s `test-sync-safety.mjs` proves all three
   with two browsers on a mock cloud; keep it passing.

## Estimates provenance and status (Phase 2)

Data, not layout, so both layouts share it: `inst.entered[field] = true` is
recorded the moment a field is typed (`markEntered`); a field equal to
`defaultDataFor(typeKey)` and never typed reads as **Default**, never as
entered. `inst.review = {hash, at}` is written by "Mark reviewed"; the status
(Draft / Reviewed / Changed since review / Imported — verify) is DERIVED from
the hash on every read, so no edit path has to maintain it. `computeInstance`
normalises every warning to `{text, section}` and appends the generic checks
in `validateInstance` (cover vs section, spacing ≤ 0, openings ≥ host);
warnings never block a save. Manual overrides carry an optional `reason` next
to the quantity and `baseLine` copies it onto the line as `overrideReason`.
The blueprint-only chrome (header row 2, section rail, input chips, ↺ default,
inspector warnings/trace) all reads these; `refreshCardResults` → 
`refreshSectionRail` is the one refresh path.

## Estimates assembly checklist and 3D (Phase 2B, pad footing first)

The 3D model is a VIEW of the takeoff, never a second calculator.
`buildElementScene(inst)` (estimates-app.html) reads the same instance
fields and result lines the Quantity Register uses and returns a SceneModel
(`{units:"mm", nodes:[{id, role, geometry, included, ghost, visible,
fields}], dimensions, labels}`); the viewer in `portal/estimates-3d/main.js`
(Three.js 0.186.0, pinned, built by `vite.3d.config.js` into
`dist/assets/estimates-3d.js`) only draws it and never writes back. The
hosted portal fetches that file on demand from `location.origin + "/assets/…"`
the first time a 3D view opens; the standalone/offline copies embed it as
base64 through the `<!-- __GRADCON_3D_BUNDLE__ -->` placeholder (asserted by
the assembler). Run the full `npm run build` before `assemble-portal.mjs` —
the assembler rewrites dist/index.html in place and cannot run twice on it.

Two independent controls, by rule: **Include in estimate** is the card's own
canonical checkbox/field (the checklist's checkbox carries the same
`data-field`, so the calculator recomputes and only then is the scene
rebuilt); **Visible in 3D** (`VIS_3D`, session-only, never saved) hides the
object and can never change a quantity. `padComponents(inst)` is the one
component tree (Core / Suggested—review / Included / Excluded / N/A); a
suggestion becomes Excluded or N/A only through an explicit decision stored
in `inst.scope[id] = {decision, reason}`, and `markReviewed` is refused while
any suggestion is undecided — "not applicable" is never the same as "not
reviewed". `refreshCardResults` → `refresh3D` is the only scene refresh
path; `renderWorkspace`/`rerenderCardKeepTab` dispose the viewer first, so a
viewer never outlives its card. No WebGL → the SVG drawing and checklist
stay fully usable. `scratchpad/test-3d.mjs` proves parity, visibility,
decisions, disposal and the fallback; keep it passing. Extending 3D to other
element families waits on the owner's approval of the pad footing.

## Estimates data-entry power tools (Phase 3)

- **Numeric fields are `<input type="text" inputmode="decimal" data-num>`**,
  not `type=number`: `parseNumInput(raw, displayUnit)` is the ONE parser —
  a hand-written tokenizer/recursive-descent evaluator for `+ - * / ( )`,
  thousands separators and a trailing `mm|cm|m` suffix (converted into the
  field's display unit from `fieldDisplayUnit`). It never calls `eval` or
  `Function`; anything it cannot parse is shown red and NOT stored. The
  display normalises to the result on change. Arrow keys step (Shift ×10),
  Enter in a table row adds a row, Ctrl+D duplicates the row, pasting a
  column fills down. Manual-override cells stay `type=number`.
- **Undo/redo** is snapshot-based: `computeAllAndRefresh` calls
  `undoCommit(UNDO_CTX)`; keystrokes in the same field within 1.5 s coalesce
  into one step; `applyLoadedEstimateState` resets the history on any real
  load/sync/restore so undo never crosses another device's save. Undo runs
  through the normal save path, so the autosaved copy and the cloud follow.
- **Templates** (`gradcon-estimate-templates`, local + cloud row) copy
  configuration only (`templateDataFrom`: no overrides, import flags,
  derived `_` fields); adding one gives a new ID and no results/history.
  "Copy values from…" and "Duplicate — settings only" (`DIM_FIELDS` reset)
  live in the card's ⧉ Duplicate ▾ menu.
- **Tags** `inst.tags = {level, zone, pour}` are data (saved); the navigator's
  multi-select (`BP_MULTI`, session) drives `bulkApply` for tags, review,
  delete. Bulk review skips elements with undecided assembly items.
- **Register**: `registerFilteredLines()` is the one filter (the Elements
  picker — `REG_ELEMENTS`, a Set of instance ids or null for all, any mix of
  the workspace's elements ticked individually or per type group, carried in
  saved views as `els`, handed over from the blueprint bulk bar by
  `showElementsInRegister` — then selects, chips,
  search incl. warnings and tags); `regGroupKey` groups by element /
  material / category / level / zone / pour; totals show filtered vs whole
  project; rows jump to their source section (`openLineSource` →
  `lineSection`); saved views (`gradcon-estimate-register-views`) and hidden
  columns (`gradcon-estimate-register-cols`) are per-browser preferences;
  "Export filtered view" exports exactly the rows shown. **Materials
  Summary** (`summarizeByMaterial`, `renderMaterialSummary`): one row per
  group::material::unit for the rows shown — every concrete grade, bar size,
  mesh type, formwork type, blinding material… on its own line with net,
  final, kg and element count, an "All <group>" row when the units agree,
  a CSV export, and a click that sets the **Material** select
  (`filterMaterial`, `matKey(l)`, saved in views as `mat`).
  `concreteGradeStr` puts the per-grade split on element heads (card and
  register) and in the totals whenever more than one grade is present.
  **Formwork is totalled by UNIT** (`formworkTotals` → `{m2, lm, no}`,
  `formworkStr`): m² faces, lm edgeform / reveals / step-down faces and
  no. penetration trimmers are never added together — card head and tiles,
  register heads and tiles, the PDF totals and the m²-per-m³ sanity check
  all use it (before 23 Sep 2026 the metres and pieces were summed into
  "m²"). A Materials Summary group with mixed units closes with one
  "All <group> (<unit>)" row per unit.

## Estimates geometry options: wall shapes, stair forms, reinforcement by rate

- **Irregular shape — concrete volume override** (`concreteOverrideSection`,
  `applyConcreteOverride` in `computeInstance`, on EVERY element with a
  Concrete tab): `concVolOverride` > 0 replaces the element's own concrete
  line(s) with one entered-volume line (first line's material kept; blinding
  and "(reference only)" pointers untouched). It runs BEFORE `applyReoRate`,
  so a rate follows the entered volume. Formwork keeps its own override on
  the Formwork tab.
- **Strip footing footprint** (`footShape`: `"run"` = length × width, the
  default and every older takeoff; `"area"` = the plan area typed off the
  drawing, `footPlanArea` m² per footing — 30 Sep 2026). `stripGeom(d)` is
  the ONE reading (compute, render, diagram): in area mode concrete = area ×
  depth, blinding covers the area, the trench is the area widened by trench
  width ÷ width, while bars, cross bars, ligatures, formwork faces and
  starter runs follow the RUN LENGTH — the typed `length`, or area ÷ width
  when it is blank. Area mode with no area typed is a completeness warning,
  never a silent zero. **Footing formwork can be a typed perimeter** (strip
  and pad footings, `formMode`: `"faces"` = the ticked faces × run × depth,
  the default; `"manual"` = `formLm`, the formed perimeter / total formed
  length in lm per footing, × `formDepthMm` (blank = footing depth) —
  `manualFormworkUI` / `manualFormworkLines` are the ONE pair). Manual mode
  emits ONE m² line with the lm figure in its spec and notes — never an m²
  line AND an lm line for the same faces, which the order schedule and the
  Quotes bridge would price twice; no perimeter typed is a completeness
  warning.
- **In-ground tanks and pits dig and blind by default** (`TANKBOX_INGROUND`:
  Lift Pit, Sump Pit, Water Tank, Swimming Pool — 2 Oct 2026): the `tankbox`
  calculator is NATIVE excavation for those kinds (`hasNativeExcavation`),
  so the Excavation tab's option starts ticked and `computeTankbox` takes
  off "Bulk excavation" = (external footprint + `excWorkingSpace` each side)
  × (internal depth + base + blinding + `excExtraDepth`) plus bulked spoil
  (`NATIVE_EXC_LINE` strips both when unticked); blinding under the base
  slab is the external footprint (`tankboxExternal`, walls included; the
  generic `blindArea` override wins) and the presets seed 50 mm. A planter
  stays above ground: opt-in excavation, no blinding unless entered. A lift
  pit saved before this gains the dig on next open (no `excOn` = native =
  included) but keeps blinding off until it is entered — the card's
  Blinding tab turns it on.
- **Retaining walls** also carry a plan shape (`planShape`: straight, curved —
  `planRadius` × `planAngle` gives the developed length, or irregular —
  the developed length is typed), a battered stem (`stemBatter`: mean of
  `stemT` and `stemTt`) and a footing footprint (`footShape: "area"` uses
  `footPlanArea` × depth; excavation oversizes that footprint).
- **Retaining wall stems** (`retStemGeom(d)`) come in four elevation shapes:
  uniform, tapered (`stemH` → `stemH2`), stepped (up to six `segL/segH/segT[/segTt]`
  segments — each its own height and thickness, lengths summed into the wall
  length, stem volume = Σ l × h × t) and manual (`stemArea`, an
  irregular face measured off the drawing). Stem concrete = face area ×
  thickness, stem formwork = 2 × face area, vertical bars = 2 faces × bars
  along the length × (average height + 0.4 lap), horizontal bars = 2 faces ×
  (face area ÷ spacing + one bottom row). A uniform wall reduces to L × H;
  before 17 Sep 2026 the stem bars counted one face vertically and used the
  wall length as the row count horizontally, so those two lines changed for
  existing takeoffs (review status flags it).
- **Wall elevation sketch** (`elevationSketchUI`, `elevGeom`, `elevSVG`,
  sketch-pad mode `"elev"`; fields `elevOn`, `elevDirs`, `elevLens` in mm —
  its own fields, never the slab's `outline*`): the concrete wall and the
  retaining wall stem (`stemShape: "sketch"`) price off a FACE drawn on the
  sketch pad and straightened into sides A, B, C… whose true lengths are
  typed; the labelled drawing shows every side's length, every corner's
  interior angle (editable through `data-elevang`, later sides turn with
  it), the overall length and height as dimension lines and the shoelace
  area, with a misclose warning over 25 mm. Concrete wall: concrete = face
  area × thickness, formwork = area per face, vertical bars along the
  overall length at the AVERAGE height, horizontal bars = area ÷ spacing +
  one bottom row. Retaining wall: the face area, overall length (straight
  plan) and tallest height come from the sketch. The generic closed-shape
  helpers (`shapePts`, `shapeArea`, `shapeBounds`, `shapeCornerAngle`,
  `setShapeCornerAngle`) are what any future face sketch should reuse.
  `straightenClosed(stroke, square, smart)` is the ONE stroke → polygon
  reader for closed sketches (slab outline and wall face): with `smart`
  (wall faces) a side within 15° of level or plumb is squared and any other
  side keeps its slope to 5°, so a raked top survives "Square corners"
  (23 Sep 2026: it used to flatten into a rectangle); the pad previews the
  reading over the stroke on pen-up. `elevAreaM2` is the face-area
  override: it beats the sketch and length × height, and with no sketch the
  wall's own length and height still set the bar counts. Typing a side
  length or the override refreshes `.elevHost` live through the field
  handler, like the slab's `.outlineHost`.
- **Retaining wall scope** (`incStem`, `incBase`, both true when absent):
  the estimator prices the stem alone or the base alone — `baseOff` (a
  linked footing OR base excluded) drops the footing concrete, key,
  footing bars, footing formwork and excavation; `incStem` false drops the
  stem concrete, stem bars, stem formwork, waterstop and dowels out;
  backfill stays (site work); both off is a completeness warning.
- **Retention Walls** is its own library group (Retaining Wall, Shotcrete
  Wall — moved out of Ground Structure 22 Sep 2026; `stage` on their lines
  follows the group name). The shotcrete wall's Connections tab has two
  clickable ties: `slabTieOn` (horizontal bars into a slab — `targetSelect`
  filtered to `slab`, bars = L ÷ spacing + 1) and `pierDowelOn` (dowels
  into adjoining bored piers — filtered to `pier`, piers = typed or the
  linked pier element's qty via `shotPierCount`), each emitting one
  Connections line counted on the wall only.
- **Slab beam grades** (`slabBeamGrade(d, g)`): edge beams, internal beams
  / raft ribs, edge and wall thickenings take `beamGrade` (Concrete tab,
  blank = slab `grade`) and each extra beam group can carry its own `grade`;
  the slab line and blinding keep the slab grade, so the pour schedule
  separates the products.
- **Additional Reinforcement / Elements rows** (`addlRowQty` / `addlRowEach`,
  on every element): the COUNT multiplies whichever "each" value the unit
  reads — length each (m), area each (m², m³), else qty each (no., kg, item).
  A blank count is one; a count with nothing to multiply is pieces only on a
  "no." row; no description or no quantity = not on the takeoff. Before
  23 Sep 2026 the typed qty ignored the count on no./kg/item rows. **A steel
  row (Reinforcement / Connections with a bar size) counted in no. WITH a
  length each, or weighed in kg, is that bar's steel** (6 Oct 2026, Grady:
  "additional reinforcement doesnt seem to add up or shown in the material
  summaries"): material = the bar, `lengthM` = pieces × length, kg through
  `massPerUnit` (1 for a kg row), so the card kg, the Reinforcement Summary,
  the Materials Summary and the orders schedule all count it; a no. row with
  no length (chairs) stays a plain counted item. Selects in
  any `table.rows` keep their own width (`width:auto`, capped at 260 px) so a
  crowded row can never crush the bar-size dropdown to a sliver.
- **Excavation is the estimator's decision on every ground element**
  (`isGroundElement` = library group Foundations / Retention Walls / Ground
  Structure / Ramps / External Works / Special Items, never the generic
  calculator; `excavationOptionSection` heads the Excavation tab,
  `applyExcavationOption` runs in `computeInstance` BEFORE
  `siteAllowanceLines` so an overbreak % follows it). Calculators that have
  always dug (`NATIVE_EXC_CALCS`: strip/pad footing, pile cap, pier,
  retaining wall) keep digging until `excOn` is false, which strips their
  excavation, spoil, drilled/bored spoil and backfill lines
  (`NATIVE_EXC_LINE`) — an existing takeoff is unchanged. Everything else
  (slabs, beams, tanks, kerbs, stairs) adds nothing until `excOn` is true,
  then ONE bulk excavation = (footprint from `elementFootprintM2`, or the
  typed `excAddArea`, oversized `excAddOversize` each side as a square of
  the same area) × `excAddDepth`, plus spoil at `excAddBulk` or the project
  bulking; a blank depth or unknown area is a completeness warning, never
  a silent zero.
- **Ligature zones ALWAYS cover the whole run** (`ligZoneSpans(zones, runMm)`,
  the ONE reading for the standalone beam, every slab beam group — edge
  beams, internal strips, extra groups — and both beam diagrams; 6 Oct 2026,
  Grady: "these bars in beam ligatures dont add up to the overall
  reinforcement counts. code it in to count always"): a typed zone length
  stands, zones with no length share the rest of the run equally, and when
  every zone is typed but they fall short of the run the remainder is
  counted at the LAST zone's spacing — the line's spec says "incl. N m
  uncovered run" and the formula shows zone + rest. Before this a lone
  "General 10000" zone on a 60 m run counted ligatures over 10 m and the
  other 50 m had none. `test-lig-zones.mjs` proves it.
- **Irregular Concrete Constructions** (library group; `composite`
  calculator — `compositeDefaults` / `renderComposite` / `computeComposite`
  / `diagComposite`; items hearth, plinth, compositeassembly): ONE element
  built from parts — `slabs[]` (each L × W or a plan-area override, thickness,
  own grade or the element grade, mesh × layers or bars each way, edge
  formwork by the metre with an entered-length override, optional soffit
  formwork and blinding) and `walls[]` (each L × H × T, own grade, vertical
  and horizontal bars × reinforced faces with the wall calculator's 0.4 m
  lap, formed faces 0/1/2 + ends), plus the SHARED starter runs
  (`starterRunsUI` / `starterRunLines`, elemLenM = the longest part) for
  starters in as many locations as the detail shows. One register line per
  part, labelled with the part's name; a part missing its dimensions is a
  completeness warning, never a silent zero. `addRow` templates `slabs` /
  `walls`; the group is a ground group (excavation option, footprint = the
  first slab). Starter runs everywhere gain `fix` = cast / epoxy: epoxy adds
  a "Drill & epoxy" Connections line in no. (one hole per bar,
  `massPerUnit: 0`) beside the bar line. A run also carries `cog` (mm, blank =
  straight) added to every bar's cut length, so the typical note "N16
  STARTER BARS @ 400 MAX CTS, ALL FACES, COG 300, DRILL & RAMSET CHEMSET REO
  502, 150 EMBEDMENT INTO SLAB" (Grady, 6 Oct 2026) is one run: N16, 400,
  2 rows, embed 150, projection = the lap, cog 300, epoxy. The bridge lands
  the holes line on the SAW CUTS & DOWELS "ChemSet hole only" allowance
  (`CHEMSET_HOLE_PRODUCT` in `estimateImport.js`, verify-covered) beside the
  bar metres on PROCESSED BAR; the band also carries cogged ChemSet starter
  bars N12–N24 each (150 / 200 embed, 300 cog) and N12–N20 per lm PER FACE
  @400 / @300 / @200 — "all faces" of a wall is 2 × the lm. Quotes mirrors the group as the
  `IRREGULAR CONCRETE CONSTRUCTIONS` category (hearth_fireplace_base,
  plinth_machine_base, irregular_concrete_assembly; `labour: "composite"`)
  and `ESTIMATE_TYPE_MAP` bridges the three Estimates labels onto them.
- **Concrete wastage goes by WORK TYPE** (2 Oct 2026, Grady's table):
  `CONC_WASTE_CLASSES` in `estimates-app.html` — large slabs / well-controlled
  pours 2.5% (typ. 2–3%), footings / pile caps / beams / walls 5%, concrete
  against excavated ground 7.5% (5–10%), bored piles 10% (5–15%+), shotcrete /
  irregular surfaces 15% (10–20%+) — each a whole percent edited in the Rates
  Library's "Concrete wastage by work type" panel (`global.concreteWaste*Pct`,
  `verify.mjs` keeps the two lists and defaults identical) and read LIVE by
  `refreshReoAllowances` into `CONC_WASTE`. `autoConcWasteClass(def)` is the
  class a calculator implies (pier → pile, shotwall → shotcrete, slab → slab,
  everything else formed), written to `inst.data._concWasteAuto` by
  `computeInstance` / `buildCard`; the Concrete tab's `concreteWasteClass`
  select overrides it per element and `concreteWasteOverride` (a typed %)
  beats both. `concWastePct(d)` is the ONE reading. `PROJECT.concreteWasteMode`
  = `"class"` (new projects) or `"flat"` (one `concreteWaste` % everywhere —
  `applyLoadedEstimateState` sets it on any takeoff saved without the field,
  so nothing re-prices on its own; the estimator switches the basis in
  Project Setup). The PDF prints `concWasteModeStr()`. **The rule is stated
  expressly in the library**: its "Concrete waste class by Estimates element
  type" table (`EST_WASTE_TYPES`, a MIRROR of Estimates' `LIBRARY` ids,
  labels, groups and built-in classes — `verify.mjs` fails on drift) shows
  every type's class and lets Grady move a type to another class
  (`global.concreteWasteClassByType`, only the moved types stored; "Reset
  all to built-in"); `autoConcWasteClass` reads that map (`CONC_WASTE_TYPE_MAP`,
  refreshed with the percentages) BEFORE its calculator rule, so a moved
  type re-prices every element still on Auto, live. **Re-applying later**:
  the Workspace toolbar's "♻ Apply library waste settings…" dialog
  (`openWasteApplyDialog` → `applyLibraryWasteSettings(ids, {clearOverrides,
  useClassBasis})`) and the blueprint bulk bar's "♻ Library waste class"
  (`bulkApply("waste")`) put chosen elements back on Auto, optionally clear
  typed % overrides, and can move a flat-basis project onto the work-type
  basis; nothing else on the element changes.
- **Screed (standalone)** (`Floor Finishes` library group, calc `screed`:
  `screedDefaults` / `screedGeom` / `renderScreed` / `computeScreed` /
  `diagScreed` — 2 Oct 2026, Grady: "the screed is standalone. add it as its
  own element"): a floor screed priced on its own, not as a slab's topping.
  `SCREED_TYPES` MIRRORS the m² products of the Quotes `SCREEDS` catalog by
  exact NAME (`verify.mjs` fails if they drift) and every extra (bonding
  coat, galvanised mesh, fibres in kg, rails and joints in m, curing) is
  emitted under `materialGroup: "Finishes"` with the Quotes product name, so
  `estimateImport.js` prices each line 1:1 on `SCREEDS`
  (`findScreedProduct`) and picks the Quotes element type from the screed
  product (`screedQuotesTypeId`, `SCREED_TYPE_RULES`: unbonded before
  bonded; granolithic / epoxy land on TOPPINGS). An SL sheet mesh in the
  screed is an ordinary Reinforcement mesh line (whole sheets). Area = qty ×
  (L × W or an entered plan area), priced by the m² at the average
  thickness (min and max averaged when laid to falls); the m³ and tonnes
  ride on the line as notes, never as a second quantity. It sets
  `_autoInsArea` / `_autoInsPerim` so the shared insulation / acoustic-mat
  section and Project Geometry take the screed area; it is not a ground
  element (no excavation) and has no Concrete tab.
- **Blinding concrete is an express checkbox on slabs and every ground
  element** (6 Oct 2026): ground slabs (slab calc, not suspended) carry
  "Concrete blinding under slab" (`slabBlindOn`, `slabBlindT` blank = 50 mm,
  `slabBlindGrade` 20) beside the Base Course — its own Base/Blinding line
  over the net plan area, separate from the base-material line; pier / pile
  caps carry "Concrete blinding under the caps" (`capBlindOn`, on by default
  as the 50 mm seed always was) gating `capCapExcLines`' blinding; every
  other ground element uses the shared Blinding & Vapour Barrier section's
  `blindingOn` box, whose thickness now reads through `blindingThicknessMm(d)`
  (unticked = 0, blank-but-ticked = 50 mm, never a silent zero) in
  `blindingAndVapourLines`, the tankbox and the generic path; retaining
  walls (`_autoBlindArea` = footing footprint) and kerbs (`_autoBlindArea` =
  length × profile width) hand their footprint to that section so the box
  works without typing an area. **The blinding concrete grade is the
  estimator's**: every blinding line's grade field (`blindingGrade`,
  `capBlindingGrade`, `slabBlindGrade`, composite parts' `blindGrade`) falls
  back to Project Setup's `PROJECT.blindingGrade` (`blindGradeDefault()`,
  20 when unset) rather than a fixed N20.
- **Slab bars can be measured by AREA COVERED × LAYERS** (6 Oct 2026,
  Grady: "some slabs dont have proper bars designed … lets use the area
  covered and include also layer … i should be able to select more than a
  layer"): each slab bar block (botX / botY / topX / topY) has a third
  Method beside "By spacing" and "By bar count" — "By area covered ×
  layers" (`<prefix>Method: "area"`, `<prefix>Area` m², `<prefix>Layers`
  whole number, blank = 1, the block's own `<prefix>Spacing`). `barMode(d,
  prefix)` is the ONE reading of the select (no value = spacing, so older
  takeoffs are unchanged) and `areaBarGeom(d, prefix)` the ONE arithmetic:
  the bars are COUNTED, never divided out (Grady, 8 Oct 2026: "include the
  bar count +1 in the calculations rather than using l/spacing. it should
  be l/spacing +1"): bars = floor(across ÷ spacing) + 1 (`areaBarCount`, the
  same "+1" every spacing count in the file uses), each the other dimension
  long, × layers, ONE direction per block (X bars run the length and are
  spaced across the width; a mat each way uses the X and Y blocks).
  `areaBarRun(area, dims, isPlan)` is the ONE reading of WHICH dimensions:
  the slab's own L × W (`_autoPlanL` / `_autoPlanW`, published by
  `computeSlab` for a plain rectangle and cleared by `computeInstance` before
  every compute) when the area IS the slab's area (blank, or typed within 2%
  of L × W), else a square of equal area (√A a side). Waste and lap as for
  every bar line, the spec reads "(area covered, N layers)", the formula
  shows the count. Before 8 Oct 2026 the total was area ÷ spacing (50 m² at
  200 → 250 m; now 26 bars × 10 m = 260 m on a 10 × 5 slab). A blank area in that
  mode is a completeness warning and no line, never a silent zero
  (`computeSlab` now returns its own `warnings`). The Method select
  rerenders the card so only the chosen mode's fields show.
- **Column vertical bars = bars × qty × HEIGHT** (`computeColumn`, 5 Oct
  2026): the lap onto the starters from below sits inside the height (those
  starters are counted on their source element) and the bars continuing up
  are the column's own Connections line (embedment + projection, only with a
  "continues to" target). Before this every vertical bar carried the 900 mm
  `connProj` on top of H whether or not the column continued, and a
  continuing column counted that projection twice. Existing takeoffs with
  columns drop by bars × 0.9 m per column (review status flags it).
- **Stairs** (`stairGeom(d)`, `STAIR_SHAPES`): straight, L (quarter-turn),
  U / dog-leg, multi-flight, winder, spiral (newel + outer radius, turn), curved
  (centreline radius, turn) and irregular (measured overrides; an old
  `irregular: true` maps to it). Risers are split over `flights`; L/U/multi
  carry `flights − 1` landings of `landL × landW × landD`; spiral and curved
  measure the going on the centreline arc. `landReo` (off by default, so
  older takeoffs are unchanged) reinforces each landing as a slab.
- **Reinforcement by rate** (`reoMethodSection`, `applyReoRate` in
  `computeInstance`, on EVERY element with a Reinforcement tab): `reoMethod:
  "rate"` prices the element's steel as `reoRateKgM3` × its own concrete
  (blinding and reference lines excluded), converted to metres of one bar
  size (`reoRateDia`, kg ÷ d²/162) so orders, tonnage and the Quotes bridge
  keep working. It REPLACES the calculator's Reinforcement lines and keeps
  Connections; the detailed fields hide under `data-show-if="reoMethod_detailed"`.
  `validateInstance` flags a rate with no concrete (completeness) and always
  asks for the ratio to be confirmed (verify). **A slab with no proper bar
  design is taken BY AREA instead** (`reoMethod: "area"`, 6 Oct 2026, Grady:
  "i want the square meter alone and the spacing and bar type only"):
  one row per LAYER in `reoAreaRows[]` (`{area, dia, spacing, ways}` — area
  blank = the element's own plan area from `reoRateArea(d)` = `_autoAreaM2 ||
  _autoInsArea || _autoBlindArea`, the same area Project Geometry publishes;
  `ways` "each" = two directions or "one"; "+ Add layer" through `addRow`,
  whose template sits BEFORE the generic `/Rows$/` rule) and a lap tick —
  Grady: "it only has one layer" → "i want to be flexible with layers".
  `reoAreaLayerRows(d)` is the ONE reading: the stored rows, else the single
  field set a takeoff saved earlier on 6 Oct 2026 (`reoAreaM2`, `reoAreaDia`,
  `reoAreaSpacing`, `reoAreaWays`) repeated `reoAreaLayers` times, seeded
  into `reoAreaRows` the first time the table renders; `reoAreaRowMetres(r,
  planArea, planDimsOf(d))` is the ONE row arithmetic — COUNTED bars through
  `areaBarRun` / `areaBarCount` (same rule as the slab bar blocks above):
  each way = (W ÷ spacing + 1 bars × L) + (L ÷ spacing + 1 bars × W), one
  way = bars spanning the SHORT side (long ÷ spacing + 1 bars × short); a
  blank area is the slab's own L × W, a typed one is the slab's L × W only
  when it is the slab's area, else a √A square. The row carries `count`,
  `bars` and the `formula` the register line prints; on a 10 × 5 slab N12
  @200 each way is 515 m (was 500 m as area ÷ spacing × 2). `applyReoArea` emits
  ONE bar line PER LAYER, replacing the detailed lines like the rate does; the
  table's metres cells refresh live. **Beam steel always counts**: every line
  a slab's beam group emits (`raftBeamGroupLines` wrapper tags `part:
  "beam"`; the edge beam / internal strips / thickening concrete lines carry
  the same tag) survives both methods — the mat is replaced, the beams' bars
  and ligatures are kept — and `reoRateConcrete` applies a kg/m³ rate to the
  slab's own concrete only (6 Oct 2026, Grady: "it still doesnt acknowledge
  those reinforcements" — a by-area slab had dropped its beam ligatures). No layer, a layer with no area anywhere,
  or no spacing, is a completeness warning. `out.reoRate` carries `{basis:
  "m3" | "area", rate, conc, area, kg, metres, dia, layers, rows, kgPerM3,
  kgPerM2}` and `reoRateHintText` states the result both per m³ and per m²
  under either method (refreshed live by `refreshCardResults`); the card
  head and the Results totals show the element's steel rate in kg/m³ and,
  wherever a plan area exists, kg/m² — whatever the method. (A kg-per-m²
  RATE basis existed for an hour on 6 Oct 2026 and was replaced by this at
  Grady's "nope".)
- **Every calculator with a natural area publishes it** (`_autoAreaM2`,
  deleted by `computeInstance` before each compute and read FIRST by
  `autoGeometry`): a wall's face net of openings, a shotcrete face, a
  retaining-wall stem face (the base footprint when only the base is priced),
  a box gutter's plan footprint (external width × run), a composite's slab
  parts. Before 6 Oct 2026 those elements reached Quotes with no m², so their
  cards showed no $/m².

## Estimates standards profile, allowances and review gate (Phase 4)

- `docs/ESTIMATES_COVERAGE.md` is the coverage audit (brief §11.3): map a
  new real-world item to an existing calculator + modifier first; the
  generic calculator (`kind` excavation / alteration / temporary / precast /
  civil) is the universal measured item. The Civil / Bridge library group
  renders only when `PROJECT.standards.projectType` is civil, bridge or water.
- `PROJECT.standards` (jurisdiction, NCC class/edition, project type,
  drawing/spec revisions, engineer, governing standards by exact designation
  from `STANDARD_OPTIONS`, measurement rules, rate base, currency/GST,
  `checks` thresholds) is recorded with the takeoff and printed on the PDF
  and warnings export. Standards are designations only — no standards text,
  no invented clause references.
- **Site & Placement Allowances** (`siteAllowancesSection` /
  `siteAllowanceLines`) put overbreak, rock, dewatering, backfill, placement
  method, propping and testing on every element as register lines whose spec
  reads "Scoped allowance — estimating item, not design". Blank = nothing.
- `validateInstance` emits three levels: `completeness` (○, counted),
  `sanity` (⚠, counted, thresholds from `standards.checks`) and `verify`
  (ⓘ, never counted as a warning — cover/grade from defaults, reinforcement
  adequacy, formwork design, pile capacity are confirmed from the engineer's
  documents). Wording never asserts a design verdict.
- The deliberate **Publish** is held by `publishBlockers()`: acknowledgement
  (`PROJECT.reviewAck` = name, role, time, `linesHash()`), stale
  acknowledgement, manual overrides without a reason, undecided assembly
  items. The live auto-publish that follows a first publish is unchanged.
  `DISCLAIMER_SHORT` appears in Project Setup, the Publish page, the PDF and
  the warnings CSV.

## Estimates data safety (schema, migration, recovery, raw backup)

`portal/estimates-schema.js` is pure and DOM-free: the assembler inlines it
into `estimates-app.html` (asserted) and `scripts/verify-estimates.mjs`
runs the same file in Node against real takeoffs in `tests/fixtures/estimates/`.
Rules: a snapshot without `schemaVersion` is v1; `migrateEstimateSnapshot`
deep-copies, repairs STRUCTURE only (never a value, a name or a unit — mm
stay mm, blank stays blank, zero stays zero), is idempotent, keeps unknown
fields, and THROWS for anything it cannot read. Every load path (boot,
cloud sync, save-history restore, Load .json) goes through it. A throw on
the open takeoff puts the app in RECOVERY MODE: read-only banner, raw copy
downloadable, and `saveEstimateState`/`autosaveLocal` refuse to write that
key — before this an unreadable row silently became a fresh takeoff that
the next autosave wrote over the original. On first load of each schema
version, before anything is parsed, every raw `gradcon-*` key is copied to
`gradcon-pre-migration-backup::<timestamp>` (never overwritten by the app;
excluded from later backups); Project Setup offers "Download full backup"
(all raw keys, with checksum) and the pre-migration copy. JSON downloads
carry no BOM. `npm run verify` runs both suites.

## Estimates orders, export preview and reconciliation (Phase 5)

`portal/estimates-orders.js` is the second pure, DOM-free module (same
contract as `estimates-schema.js`: inlined by the assembler, asserted, and
run in Node by `scripts/verify-estimates.mjs`). It never measures anything
— it groups, rounds and totals the register lines the calculators already
produce. Three quantities are kept apart on every order line and never
merged: **net** (`line.qty`), **adjusted** (`line.finalQty`, waste + lap —
the register/export figure) and **order** (adjusted rounded UP by the
material's procurement rule, with the rule text on the row:
`procurementRuleFor`). `ordersCtx()` in the app hands the module the facts
it must not hard-code (bar stock length from Project Setup, sheet area,
trench/strip stock 6 m, concrete step 0.2 m³, the mesh/trench product
tables). `orderScheduleFrom` keeps the `group::material::unit` key that
`PROJECT.orderExclude` ticks are stored under; `reinforcementByProduct`
groups bars by diameter (ligatures join their bar size through `lengthM`),
trench mesh and strips by product, sheet mesh by type; `pourSchedule`
groups concrete by grade → the element's `pour` tag → element and rounds
each pour separately (a separate delivery). `reconcile(sources)` totals
several line sets independently and compares them to the metric's decimal
places plus an order-independent `linesFingerprint`; the Export page shows
element cards = register = export payload, plus the copy last published
from this browser (stale = publish again). The PDF prints the same block.

**Every export previews first** (`openExportPreview`): the exact rows and
columns, row count, and the report metadata from `reportMeta()` (project,
job, revision, drawing/spec revs, `PROJECT.preparedBy`, reviewer, date,
standards, fingerprint, build). `download()` still shows the copy fallback;
the preview uses `triggerDownload()` and reports in-dialog. Worksheet CSVs
stay pure tables (their Final Quantity is a live row-relative formula); the
order schedule, pour schedule and warnings CSVs append `reportTrailerRows()`.
`scratchpad/test-phase5.mjs` proves the schedule, preview, reconciliation,
both bridges (Quotes and Cost Planner pick up one publish) and the offline
local-only mode; keep it passing with `npm run verify`.

## PDF / print export

The "Print / PDF" button in `ProjectEditor` calls `window.print()`; the
browser's own print-to-PDF handles the export, no library needed. What
prints is **not** the on-screen editable UI — `components/PrintQuoteReport.jsx`
is a standalone report, hidden on screen and shown only under
`@media print` (via Tailwind's `print:` variant), built straight from
`computeElementCost`. Two reasons it's separate rather than just revealing
the existing cards: (1) collapsed `ElementCard`/`CategoryBlock` sections
are conditionally unmounted, not just visually hidden, so CSS alone can't
print their contents regardless of on-screen collapse state; (2) printing
the full catalog (114 products per element) would be useless — the report
lists only lines with a quantity entered. The rest of the editor gets
`print:hidden` (see `App.jsx`). `@page` sizing lives in `index.css`.

## Self-service element types (Element Types modal)

`ELEMENT_TYPES` in `catalog.js` stays a static, code-reviewed list — but
Grady can add his own element types from the app itself via the "Element
Types" button (`components/ManageElementTypesModal.jsx`), so a new job
that needs an element type nobody's coded yet doesn't have to wait on a
code change. Custom types are stored separately under
`gradcon-custom-element-types` (`{id, category, section, name, labour}`,
same shape as a built-in entry, `labour` restricted to the existing
`LABOUR_TEMPLATES` keys) and merged with the built-ins at render time in
`App.jsx` (`allElementTypes`/`allCategoryOrder`/`allSectionOrder`), which
is what actually gets threaded down to `AddElementBar`, `QuoteSummary` and
`PrintQuoteReport` as props — `data/catalog.js` itself is never written to.
If you add a new prop-consuming place that needs the element list, take
`elementTypes`/`categoryOrder` as props with the built-in exports as
defaults, the way those three components do, rather than importing
`ELEMENT_TYPES` directly.

## Estimates → Quotes import bridge

The separate "Estimates" tool (Gradcon Element Takeoff Engine, embedded
in the combined portal) computes generic quantities — a bar diameter +
length, a concrete grade + volume — that don't line up 1:1 with Quotes'
named catalog SKUs. "Publish to Quote" in that tool writes its live
Quantity Register (`{project, lines}`, i.e. its own `allLines()` output)
to `localStorage["gradcon-estimate-export"]` and asks the portal shell to
switch to the Quotes app; `App.jsx` picks that up on load, runs it through
`lib/estimateImport.js`'s `buildImportFromEstimate`, and creates a new
project from the result. That function is deliberately conservative: it
only prefills a catalog quantity where the match is unambiguous (an exact
element-type match, a bar diameter that exists in Processed Bar, a
concrete grade with exactly one product, wall formwork against the one
"Walls" product) and pushes a plain-English flag onto `quote.importFlags`
for everything else (ambiguous concrete mixes, formwork it can't
identify, element types Quotes has no equivalent for, trench mesh — see
the file's comments for why that last one can't auto-map even though it
reuses Square Mesh's SL/RL codes). `ImportFlagsBanner.jsx` shows those
flags once, on the freshly-created project; dismissing just clears
`quote.importFlags`. Extend `ESTIMATE_TYPE_MAP` there (not `catalog.js`)
if Estimates gains an element type Quotes already has a match for.

## Known limitations, on purpose (not oversights)

- **No auth, even with Supabase configured.** The `estimator_kv` RLS
  policy allows the anon key to read/write every row — this matches the
  app's original "no login" design, just shared across devices instead of
  confined to one browser, not a security boundary. Anyone with the URL
  and the anon key can edit any project's rates and quotes. Fine for a
  single-team internal tool; tighten the policy (require `auth.uid()`) if
  this ever needs real per-user accounts.
- **No undo.** Every edit is immediate and only reversible by hand
  (or duplicating an element before making risky changes to it).

## Design conventions

- Tailwind utility classes throughout, no CSS-in-JS. Palette: `neutral-*`
  for structure, `blue-950`/`blue-9xx` for the "blueprint navy" header
  chrome, `orange-*` (safety/hi-vis) for money figures and primary
  actions, `amber-*` for the labour matrix (visually distinct from
  material sections). Numbers are `font-mono tabular-nums` throughout so
  columns of figures align — keep that convention for any new numeric
  display.
- Every material/labour input is a controlled `<input type="number">`
  via the shared `NumInput` component (`components/atoms.jsx`) — reuse
  it rather than writing a new number input, it already handles the
  "empty string vs. 0" distinction correctly (an empty cell means "not
  entered", not "zero").
- **Project Geometry carries three measures per element, plus the concrete:**
  `item.measureNo` (count — how many of the element, 12 screw piles →
  $/no.), `item.measureLm` (run) and `item.measureM2` (area); the m³ is the
  element's own poured concrete. `computeElementUnitRates` /
  `computeProjectUnitRates` show a rate for every measure that exists, in
  the fixed order no. → lm → m² → m³, never per element type. The Estimates
  takeoff publishes `elementGeometry[id] = {countNo, runM, areaM2}`
  (`autoGeometry`: the calculator's own Quantity, with `geomCountNo` /
  `geomRunM` / `geomAreaM2` as typed overrides) and `geometryForLabel` sums
  all three by name onto a card; a combined card sums them too.
- Element cards can be put in any order at any time: the ▲ ▼ arrows on a
  card's header (`onMoveUp` / `onMoveDown` → `moveItem` in App.jsx) or
  dragging a header onto another card (`onReorder` → `reorderItems`, the
  same handler the Quote Summary rail's drag uses). The order is
  `quote.items` itself, so the rail, the print report and the export follow
  it — never keep a second, display-only order anywhere.
- **The element card's blue band wraps** (`ElementCard.jsx`, 7 Oct 2026,
  Grady: "i want the blue bands responsive so that i can easily see the
  names of elements working on"): row 1 is the breadcrumb with the element
  Scope select tucked small and muted into the band's TOP-RIGHT corner
  (Grady, same day: "placed at the top right hand corner of each band so it
  is not imposing" — muted blue when it follows the project, orange when the
  element differs); row 2 is `flex-wrap`: the name block takes at least
  14 rem and grows, and the total / arrows / buttons travel as ONE
  right-aligned group that drops to a line below when the band is too
  narrow for both. The name itself is a `<textarea rows=1>`
  sized to its content (`labelRef`, refit on every label change and by a
  ResizeObserver), so a long name wraps onto more lines instead of being
  clipped; Enter blurs and any line break typed or pasted becomes a space,
  so `item.label` stays one line for the rail, the report and the exports.
  Before this the name was an `<input>` squeezed onto one row with every
  control and read "Lower Ground Strip Foot…".
- Category blocks and the whole element card are independently
  collapsible — this was a deliberate response to "the full catalog on
  every tab is a lot of rows"; don't remove the ability to collapse in
  the name of simplifying the DOM.

## Verifying a change before calling it done

1. `npm run verify` — must pass.
2. `npm run dev` and manually add one of each element-type "shape"
   (an excavation-type, a footing-type, a wall-type, a slab-type) and
   confirm quantities still roll up into the sticky total and the Quote
   Summary rail, folded under the right category and section.
3. If you touched `computeElementCost` or `computeMarginLadder`, add a
   new case to `scripts/verify.mjs` covering it before merging — that
   file is the project's only regression net and should grow with the
   logic, not stay static.
4. If you touched the Dashboard or multi-project flow: create a second
   project, add different elements to each, and confirm the Dashboard's
   per-row totals and "All projects" footer match what each project's own
   Quote Summary shows.
