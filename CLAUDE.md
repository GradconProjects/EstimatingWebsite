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

   **Finished pavements & concrete finishes are $/m² installed allowances**
   (`FINISHED PAVEMENTS & CONCRETE FINISHES`, scope "always", on every card —
   Grady, 13 Oct 2026, from published 2026 Melbourne contractor guides and his
   own cost build-up): preliminary estimating allowances ex GST, never
   confirmed subcontractor quotations — exposed aggregate standard / premium
   / difficult access, ordinary grey, coloured, stamped / stencilled,
   polished, burnished, honed, sealer only, and six "Build-up:" component
   rows (concrete supply with decorative aggregate, mesh, edge formwork,
   placement and finish, joints, curing and sealing — their midpoints sum
   inside the indicative $116–172/m²). The headline row is the recommended
   $180/m² for a standard 100 mm reinforced carport pavement (budget
   allowance with contingency, structural confirmation required). A guide
   stated incl. GST is seeded ex GST; a figure no guide covers says so in its
   name. The Rates Library's "Finished pavements & concrete finishes" section
   (`finishRates`, a `PRICED_SECTIONS` entry of `ratesLibrarySync.js`) lists
   the same names, so its figures govern Quotes; `verify.mjs` fails if the
   two lists drift.

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

- **FORMWORK follows Grady's 22 Oct 2026 pattern** ("i want the formwork to
  adopt this pattern going forward … remove the beam fold rather let's work on
  the depth instead"): every product is an OBJECT row `{name, unit, unitCost,
  group, label?, legacy?}` — `group` is the APPLICATION (Ground slabs /
  Suspended / Vertical / Other, in that order; the band shows a group header
  row, `product-group`, the Rates modal and the Rates Library the same
  groups), `name` is the rate KEY and is never renamed (a saved quote holds
  its quantities under it), `label` is what the card / modal / report show
  (`productLabel(p)`). Ground-slab edgeform splits by DEPTH: "Edgeform" (m,
  up to 400 mm, $25/lm) and "Edgeform >400mm deep" (m², $250); suspended work
  keeps THREE rates — "Conventional" (soffit, $200/m²), "Bondek" ($150/m²),
  "Edgeform (suspended)" ($50 per LINEAL METRE, Grady: "suspended edgeforms
  should be lm"); Vertical and Other carry the sheet's figures (Columns
  $1,500, Crane truck $2,500, "Scaffold hire (set-up)" $600 each, Handrail
  $50/lm). The two "Beam/fold sides" rows and the per-day "Scaffold Hire" are
  `legacy: true`: `visibleProducts(cat, item)` shows a retired row ONLY on an
  element still carrying a quantity on it (marked "retired"), it still costs
  there (`defaultRates()` seeds every product, retired too), and the Rates
  modal and the library never list it. The bridge prices a beam / fold side
  by depth (`edgeDepthMm` / `edgeProductForDepth` in `estimateImport.js`:
  up to 400 mm → lineal metres = m² ÷ depth on "Edgeform", over → the m²
  row; no depth stated → the m² row with a flag). The library's
  `FORMWORK_LEGACY_ITEMS` carry `g` (the group) and a `note`; `editableTable`
  prints a group row (`opts.groupOf`); `migrateFormworkPattern` moves a saved
  library onto the sheet's figures ONCE (`formworkPattern = 2`, both load
  paths), after which the sync logs the moves and every project is prompted
  rate by rate. `verify.mjs` pins the order, the units, the seeds, the retired
  behaviour and the library ↔ catalog names; `test-formwork-pattern.mjs`
  proves the library table, the move, the band and the modal.
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

- **The crew sheet is in Grady's words** (22 Oct 2026: "add and use Grady
  specific tones on the uploaded labour sections of each line item"):
  `CREW_SHEET_TASKS` / `GRADY_CREW_TASKS` in `catalog.js` — Site setup,
  Delivery of materials (yard works), Excavation & prep base, Remove soil,
  Blinding concrete, Tie reo, Pour concrete, Finish concrete surfaces, Site
  clean and tidy, Stripping (formwork), Collection of materials, Yard works,
  Boxing, one spare row — on every element but the preliminaries. Every Qty
  PREFILLS from the element's own fields through `taskRowMeta` (its `source`
  names the field on the row's hover) and stays editable: excavation and
  soil removal from the OTHER ALLOWANCES lines, blinding from the CONCRETE
  "Blinding concrete" row, tie reo from the tonnage, the pour from the poured
  m³ LESS the blinding (`lq.pourM3`, only while the sheet carries a blinding
  row), finishing from the mesh area, stripping from the formed m², **Boxing
  from everything entered on the FORMWORK band** — `lq.formworkMeasure` = the
  m² rows + the lineal-metre rows, unit "m²/lm". `TASK_MATCHERS` holds the
  name tests. The handover pass writes its delivery / boxing / collection
  man-days INTO those rows (`MATERIAL_ROW` / `BOXING_ROW` / `TOOL_ROW` in
  `handover.js`) and renames a spare row only when the sheet lacks them.
  **An element saved with the earlier names is brought onto the sheet once**
  (`upgradeCrewTasks`, `CREW_TASKS_VER` 3, run by `ElementCard` on mount):
  `LEGACY_TASK_RENAMES` renames in place — ids and every cell kept, so the
  handover record and typed figures survive — the missing rows are added and
  the sheet is put in Grady's order (his rows, then any row the estimator
  named, the spare rows last); the preliminaries sheet is left alone.
  **Blinding is decided on the crew sheet** ("we should be able to click, add
  blinding or not … if not checked to be added, both blinding material and
  labour should not form part of the overall amounts"): the Blinding concrete
  row carries the "Blinding added" tick (`item.blindingIncluded`, undefined /
  true = in, `false` = out; `blindingIncluded(item)` is the ONE test,
  `isBlindingProduct(cat, p)` the ONE reading of the catalog row). Unticked,
  `computeElementCost` leaves out the blinding material row, the blinding crew
  row's cells and its share of the Holcim fees (`pouredVolume` skips it), the
  row's Qty reads 0 and the card states `excludedBlinding` ("Blinding not
  added: $…"); the CONCRETE band, the print report and the exports mark the
  row "not added (crew sheet)" at $0. The typed figures are never touched, so
  ticking again restores the money exactly. `verify.mjs` covers the names,
  every prefill source, the upgrade, the handover rows and the tick;
  `test-crew-sheet.mjs` proves the sheet, the override, the tick and the
  upgrade in the browser.
  **The Qty prefill does not depend on "Auto from quantities"** (22 Oct
  2026: an excavation of 22 m³ never showed on the Excavation & prep base row
  while the toggle was off) — the toggle governs the crew-day cells only; the
  Qty placeholder always reads the element's fields through `taskRowMeta`.
  **BLINDING is its own band on the card, right under CONCRETE** (Grady,
  22 Oct 2026: "clearly differentiate blinding for beams internally and edge
  beams and then the overall slab … individual checkboxes … enter the depth
  of blinding and width then this autofills the volume in the labour
  section"; then "lets add Blinding as a separate item here and what is
  filled here should autopopulate in the labour row"): `BlindingBand.jsx`
  shows the parts the ELEMENT ALLOWS (`blindingPartsFor(item)`, read off its
  type — Grady, same day: "strips dont have slabs … blinding should be
  applied according to what that element allows. columns shouldnt have
  blinding"): a ground slab or raft (every `slab_ground` type) blinds under
  its Slab (plan area × depth), Edge beams and Internal beams (total run ×
  width × depth); a strip, ground, edge, internal or capping beam, a
  retaining / boundary / planter wall, a headwall or abutment under its
  Footing run; a pad, stump or pile cap, a column base plate or anchor block
  under its Pad / cap area; a hearth, plinth, culvert or pit under its Base
  area; a kerb under its Kerb run; a column, a wall, a pile, anything
  suspended, a roof, stairs, screeds, toppings, finishes, heating, earthworks
  and the preliminaries have NO band at all (the component returns null and a
  stray figure under another part is ignored). `BLINDING_PARTS` holds every
  part definition; each shown part has its own
  tick (`item.blinding[part].on`: undefined / true = in, false = out, the
  master "Blinding added" reading) and figures (`areaM2` / `lengthM` /
  `widthMm` / `tMm`, stamped on the work trail as `blinding:<part>:<field>`).
  `blindingBuildUp(item)` in `costing.js` is the ONE arithmetic and
  `autoBlindingConcrete(item, rates)` the ONE auto row: the CONCRETE
  "Blinding concrete" row costs itself as the build-up's m³ while nothing is
  typed on it (a typed Qty takes it manual, as on every auto row;
  `computeElementCost`, `CategoryBlock` — amber placeholder —,
  `PrintQuoteReport` and `exportQuote` all call it), `pouredVolume` counts it
  (Holcim fees), `labourQuantities` feeds it to the crew sheet's Blinding row
  Qty, and the master tick leaves all of it out (`excludedBlinding`). The
  band's header reads the m³ and the $; `verify.mjs` covers the arithmetic,
  the auto row, the crew Qty, the typed override and the master tick;
  `test-blinding-buildup.mjs` proves the band, the prefill, the CONCRETE
  placeholder and an untick in the browser.
- **Crew-sheet rows are matched by NAME** (`taskRowMeta` in `costing.js`):
  a row whose name says "excavate" draws its Qty from the element's
  **Excavation** (m³) line, a row saying "spoil" / "soil removal" / "cart
  away" from its **Soil removal** (m³) line — two rows, two quantities,
  never merged (an element from before the Excavation line existed falls
  back to soil removal for the excavate row). Elements keep the task rows
  they were created with, so an older element gets the spoil row by renaming
  one of its "Additional labour / plant" rows.
  **The Excavation line drives the dig, live** (Grady, 22 Oct 2026:
  "excavation values entered … should automatically fill in the right cells
  in the labour and equipment"; "also autofill the soil removal fields
  realtime"): `autoSoilRemoval(item, rates)` in `costing.js` is the ONE
  implementation of the OTHER ALLOWANCES "Soil removal" row costing itself as
  the "Excavation" m³ × (1 + the "Soil removal — bulking of the dug m³ (%)"
  production rate, seeded 15% — the Estimates spoil default) while nothing is
  typed on it; a typed Qty takes the row manual, exactly like the Holcim fee
  rows, and `computeElementCost`, `CategoryBlock` (amber placeholder),
  `PrintQuoteReport` and `exportQuote` all call it; `labourQuantities` reads
  the auto figure for the Remove soil row's Qty. The live handover
  (`handover.js`) runs its excavate band on the DUG m³ when the Excavation
  line is typed (else on the concrete, as fitted — the "Handover: excavator
  & bobcat" rates read "m³ dug, else concrete"), fills excavator / bobcat
  days on the Excavation & prep base row and, while there is spoil, the same
  dig days on the Remove soil row's Trucks cell (no haul productivity is
  fitted, so the trucks attend the excavator) — an element with a dig but no
  concrete yet is planned too. Every cell stays the estimator's to retype.
  **The Excavation row is a QUANTITY ONLY** (same day: "it should be 0 there
  and the cost determined only in the labour section"): catalog
  `quantityOnly: true` → `isQuantityOnlyKey(key)` in `costing.js` is the ONE
  test; `rowRate` answers $0 for it whatever the shared or pinned rates hold,
  the band's Unit $ reads "crew sheet" and the Rates modal does not list it.
  Soil removal keeps its $/m³ (cartage and tip). `test-excavation.mjs` seeds
  $50/m³ against the key and proves $0, types 30 m³ through the real input,
  watches it hold over 7 s and a reload, and proves the soil row and the
  plant cells. **Band titles are short**: a category's `label` is its name
  and any explanation is its `note` (the header's hover and a line inside
  the open band) — Grady, same day: "too much words".
  **Finishing has a METHOD by element** (Grady, 22 Oct 2026: "finish
  concrete should have a method to it and not just adding up all areas. for
  slabs it should be the total area of slabs. slabs with beams should have
  the slabs plus the area of formwork to the edge beams etc. do not add up
  all faces of beams but only the exposed faces … if beams form part of a
  complete system with the overlying slab, dont add beam faces"):
  `finishBuildUp(item)` in `costing.js` is the ONE arithmetic behind the
  crew sheet's "Finish concrete surfaces" Qty (`lq.finishM2`, still
  editable) — a ground slab or raft = its plan area (Project Geometry m²,
  else the BLINDING band's slab area, else the mesh area) PLUS the exposed
  edge faces = the FORMWORK band's edgeform rows (the m² rows as they are,
  the lineal-metre rows × the exposed edge depth typed on the Finish row,
  `item.finish.edgeDepthMm`; blank → the metres are listed, not counted);
  internal beams and inner beam faces are never counted; a suspended or roof
  slab and stairs = the top only (Project Geometry m², else the soffit
  formwork m²); a footing, ground beam, cap, kerb or base = its top surface
  (Project Geometry m², else the BLINDING band's plan area or run × width); a
  wall or column = its formed faces (the FORMWORK Walls m², else Project
  Geometry m²). The Finish row prints the parts (`data-testid=
  "finish-method"`, the method on hover) and, on a slab with lineal-metre
  edgeform, the "edge depth … mm exposed" box (`finish-edge-depth`).
  `verify.mjs` covers the raft, the blank depth, the mesh fallback, a strip,
  a wall, a column and a suspended slab; `test-blinding-buildup.mjs` proves
  the row and the depth box.

- **Formwork is measured by FACE SIZE — under 400 mm by the lineal metre**
  (Grady, 22 Oct 2026: "all formwork less than 400mm high or wide should be
  stated in lm rather than sqm in estimates section"; "edge form unless
  otherwise stated should be less than 400mm"; "if material is above 400mm
  then edgeform should be the depth of the material"): `formworkLines(inst,
  def, {material, spec, faces, formula})` in `estimates-app.html` is the ONE
  builder every calculator's formed faces go through — each face `{name,
  runM, faceMm, areaM2?}` is the run of the face and its fixed dimension
  across the run (a footing side's depth, a beam soffit's width, a column
  face's width, a casing's diameter, a wall end's thickness, a kerb profile's
  height). A face under `FORMWORK_LM_MAX_MM` = 400 is one line by the METRE
  (`unit "m"`, `faceMm`, `m2Equiv`, "≈ N m²" in the notes, spec "… under
  400 mm — lineal metres"); a face of 400 mm or more is one line in m²
  (`faceMm` carried), so a 300 × 450 beam formed on its sides and soffit
  gives a m² line and an lm line. A slab's edgeform, its reveals and its
  step-down faces run through the same rule: by the metre at the slab's
  thickness, and the full depth in m² once the slab is 400 mm or thicker.
  Strip / pad / pile-cap faces, trench and manual perimeters, standalone and
  raft beams, columns, walls (faces by height, ends and top by thickness),
  retaining walls, box gutters, composite parts, kerbs and pier casings are
  all on it; the slab soffit, stair and generic entered-area lines stay m².
  `formworkTotals` (`{m2, lm, no}`) keeps the units apart and `formworkStr`
  reads "lm formwork (edges, reveals, faces under 400 mm)"; the orders module
  totals `formworkLm` beside `formworkM2` and rounds an lm line by the metre.
  **The Quotes bridge** (`estimateImport.js`): an lm Formwork line lands on the
  ground-slab "Edgeform" (m) row; an m² line with `faceMm` ≥ 400 on an
  edge-type face (`isEdgeFaceLine`: edgeform / trench / side / beam / step /
  footing / reveal, never wall, column, soffit or casing) lands on "Edgeform
  >400mm deep" (m²); walls stay on "Walls", the rest on "Conventional" as
  before. `verify.mjs` and `verify-estimates.mjs` cover the bridge and the
  totals; `test-formwork-lm.mjs` proves the footing at 300 / 600, the beam
  with a 300 soffit, the slab edge at 150 / 450 and the totals.
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

   **Everything the library prices reaches Quotes on its own** (Grady, 21 Oct
   2026: "entries made in rates library should automatically update where
   applicable"): beside the seven priced sections, `REO_SECTIONS` map the
   library's `reinforcementEstablished` tables by product name — trench mesh
   per length, square mesh per sheet, stock bar per 6 m length, and
   processed bar, which the library stores as $/m per size and Quotes prices
   per TONNE, converted through the catalog `unitWeight` — `prelim` by name,
   and the index-keyed "Labour & Plant" table through `LIBRARY_LABOUR_PLANT`
   (a mirror of `LABOUR_PLANT_ITEMS`, row for row, `verify.mjs` fails on
   drift; APPEND rows, never reorder) onto the crew-sheet resources
   (`rateKey("LABOUR", <RESOURCE_COLS name>, <unit>)` — the two Pump rows by
   unit) and the temporary-props tonne product. A key the stored rates row
   never carried is compared with its catalog default and gains the key when
   the library differs (before this such a product never took the library's
   price; the app seeds the new entry from `defaultRates()` so unitWeight /
   sheetArea / minQty survive). A rate the library governs cannot be edited
   in the Rates modal, and a crew rate typed on a card snaps back to the
   library figure on the next sync — change it in the library.
   **Existing projects are PROMPTED, rate by rate** (same day: "it should
   prompt for existing projects if the new rates entered should be updated
   or applied" and "the actual rates changed should have a checkbox for user
   to select the applicable rates from the library rather than the entire
   rates applied to that project"): `lib/rateChanges.js` (pure,
   verify-covered). Every figure the sync moves is logged in the shared
   `gradcon-rates-changes` row (`recordRateChanges`: `{at, key, name, from,
   to}`, the same move within ten minutes once, capped at 400).
   `pendingRateChanges(quote, log, createdAt)` = the changes newer than the
   project's `ratesAck.at` (else its creation) on a project with elements
   that is not status-pinned, one per key — `from` is what the project
   prices that key at today (a figure it KEPT, else the earliest logged
   previous one), `to` the live rate. `RateChangesPrompt` (top of the
   editor) lists them with a TICK each (all / none), the project's direct
   cost at the previous figures and with the ticked ones
   (`rateChangeImpact(quote, live, changes, apply)`), and ONE button:
   `decideRateChangesPatch(quote, live, changes, apply)` — a ticked key
   follows the live rates, an unticked one is KEPT at its previous figure
   in a PARTIAL library pin (`ratesFrozen = {at, status, reason: "library",
   rates: ONLY the kept keys, names}` + `ratesAck = {at, applied, kept}`;
   `applyRateChangesPatch` / `keepPreviousRatesPatch` are the two ends).
   `effectiveRates` lays a library pin over the live rates on an OPEN status
   too, so the rest of the project follows the library; a later library move
   on a kept key asks again. `KeptRatesBanner` (open project) lists the kept
   figures beside the library's and releases one or all
   (`releaseKeptRatesPatch`; an empty pin is dropped). The editor's `locked`
   (rate writes to the pin, the modal's lock) is the STATUS pin only.
   Locking a project that kept figures takes a full status pin of its
   EFFECTIVE rates (`statusChangePatch`, `needsFreeze` → `freezeRates(
   effectiveRates(q, live))`), so the kept figures stay inside; open-status
   moves leave the library pin alone; a move back from a locked status drops
   any pin. The Dashboard lists the projects still to decide
   (`rate-changes-waiting`), each opening on its prompt. A project with no
   elements, or created after the change, is never asked. Edits typed in the
   Rates modal or on a card are not logged — only library-driven moves.
   **The changes are named per ELEMENT** (Grady, 22 Oct 2026: "in each
   project, list the affected rates within the elements"):
   `rateChangeElements(quote, live, changes)` → `{key: [{id, label, delta}]}`
   (the elements whose direct cost moves when that one key takes the
   library figure, each with its $) and `elementRateChanges` the same by
   element. The prompt lists the elements beside every rate — the rates an
   element carries first, the rest ("no element carries this rate today")
   folded under "and N changed rates…" — and `ElementCard` shows an amber
   strip ABOVE the fold (`element-rate-changes`, prop `rateChanges` from
   `changesByElement` in App) naming its changed rates with their deltas.

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

## Provisional items

Grady, 22 Oct 2026: "in the quotes section, we should be able to list items
as provisional". An element ticked **Provisional** (the band's top row, beside
Scope; `item.provisional = true`, `isProvisional(item)` in costing.js is the
ONE test) is a PROVISIONAL SUM: priced and carried in the grand total like
any other element — the quote includes it — but named as such everywhere it
is listed (the card's "Provisional sum" tag, a "PS" tag on the summary rail,
"… — PROVISIONAL SUM" on the print report and in the .xls / .csv exports, and
the tender's line item seeded "Provisional Sum — <element>") and totalled
apart by `computeProvisionalTotals(items, rates, scope)` → `{provisional,
firm, count}` (firm + provisional = the grand total; the rail and the print
report show "Of which provisional sums (N elements) · firm work $…").
Verify-covered; `test-provisional.mjs` proves the card, the rail and the
print.

## Grady's trail: who typed a figure, and what is done

Grady, 22 Oct 2026: "colour code Grady's inputs going forward. each time
grady logs in, activate the colour code. change text colours of his input so
he knows what he has worked on and also a checkbox for each element he has
worked on so in the project he will easily see where he left off and continue
from what he hasnt clicked done on. this should be applied to line items".
`src/lib/workTrail.js` (pure, verify-covered):

1. **Every figure typed on an element records its author.** `ElementCard`
   stamps `item.entries[<key>] = {by, at}` through `markEntry` on every
   quantity (`setQty` — key = the rate key), crew cell (`setTaskQty` —
   `task:<taskId>:<resource key>`), crew Qty (`task:<taskId>:qty`) and
   additional row (`add:<rowId>:<field>`); `ENTRY_KEY` builds the keys.
   `by` is `userKey(signedInUser())` — the portal account's part before the
   @ (`grady`, `projects`); outside the portal nothing is stamped. The
   figures are never touched, and a stamp is never removed (a cleared cell
   keeps who cleared it).
2. **The colour follows the signed-in account.** `entryTone(item, key, me)`
   → `"me"` / `"other"` / null is the ONE reading; the card passes it as
   `entryTone` to `CategoryBlock`, `LabourMatrix` and `AdditionalItems`,
   whose `NumInput`s carry `data-entry` (and a title "Your entry" /
   "Entered by <by>"). `index.css` colours `[data-entry="me"]` and
   `[data-entry="other"]` from the two theme tokens `entryMe` /
   `entryOther` (`quoteTheme.js`, group "Entries" — green and purple on the
   library and classic schemes, amber and purple on graphite, each editable
   in Settings → "Every colour, one by one"). So Grady's own figures read in
   his colour when he is signed in, and projects@ sees the same figures in
   the "other" colour. New chrome for an entry must read `entryTone`, never
   compare `entries[...].by` inline.
3. **Done is a tick per element** (beside the element NAME on the band's
   second row, vertically centred at the name's right — Grady, 22 Oct 2026:
   "centered vertically and horizontally to the rhs of the element name";
   `data-testid="element-done"`): `item.done = {by, at}` through
   `donePatch(checked, by)`; `isDone(item)` is the ONE test — the card's
   border turns emerald and the row reads "✓ Done" (hover: who and when),
   the Quote Summary rail ticks the element, the Dashboard's Elements
   column reads "N/M ✓". Untick to reopen. Done changes no figure and no
   total — it is a bookmark, not a lock.
4. **"Where you left off"** (`data-testid="work-trail"`, under the rate
   validity banner, every project with elements): `progress(items)` →
   `{done, total, next, last}` — done / total, **Next up** = the FIRST
   element not ticked done (in the quote's own order), **Last worked on** =
   the element with the newest entry or Done stamp (`lastTouched`), with
   `whenLabel` ("today at 4:12 pm" / "Mon 9 Oct at …") and "by <account>"
   when it was someone else — and the colour legend ("typed by grady" /
   "typed by others"). Both names jump to the card (`#element-<id>`,
   scrolled under the sticky header and flashed with an emerald ring for
   1.6 s).
`test-work-trail.mjs` proves the stamps, both colours on both accounts,
the tick, the rail, the Dashboard count and the jump.

## The tender workflow checklist (one per project, rolled up)

Grady, 22 Oct 2026, from his printed "Estimator Tender Workflow" sheet: "In
each project always rolled up, I want to create a checklist form. After 05
add another row … quote received. Both should have date. It should live on
each project but shouldn't be imposing. Make the button prominent but not
imposing." `src/lib/tenderChecklist.js` (pure, verify-covered):
`TENDER_STEPS` is the ONE list — the printed eleven in order plus
`rfq_received` ("05b Subcontractor quotes received") right after 05; the pen
notes are in the details (02 "to Grady or the sender", 03 "set up the project
folder", 05 "be clear on who — get the priority list"); 05 and 05b carry a
"who" note. Ids never change (the ticks are stored under them).
`quote.checklist[id] = {done, at, by, note}` — `checklistPatch(quote, id,
change, by)` dates a tick TODAY (local "YYYY-MM-DD") unless a date is already
there, keeps the date and note on an untick, and ignores an unknown id;
`checklistProgress(quote)` → `{done, total, next, last, complete}`. Nothing
here changes a figure. `TenderChecklist.jsx`: `TenderChecklistButton` in the
editor header beside Files (`tender-checklist-button`, the count on it,
accent-coloured once a step is ticked, emerald when all are) and the panel at
the top of the editor's left column (`tender-checklist`), ROLLED UP on every
open (`checklistOpen` state in `ProjectEditor`, never saved) — one row per
step: tick, title, detail, date box (editable), the note where asked, "by
<account>" when another account ticked it, and the three Key control points.
The Dashboard's `summarizeQuote` carries `checklist` and the project name
shows a "☑ N/12" chip (`dashboard-checklist`, next step on hover) once a step
is ticked. `test-tender-checklist.mjs` proves the rolled-up open, the twelve
rows, the dating, the note, the reload and the chip.

## Clearable notices (every banner has a ✕)

Grady, 22 Oct 2026: "i should be able to clear these and other notifications
used and unused". `src/lib/notices.js` (pure, verify-covered). Every band at
the top of a project — the supplier-rate alarm (`RateValidityBanner`), the
where-you-left-off strip, the Rates Library prompt (`RateChangesPrompt`),
"Previous rates kept" (`KeptRatesBanner`), "Rates pinned" and the handover
prefill (`HandoverBanner`) — carries `ClearNoticeButton` (`atoms.jsx`,
`data-testid="notice-clear"`). Rules:

1. **A clear records WHAT the notice said, not just that it was closed.**
   Each banner computes its `noticeSig(...)` — the rate keys with their
   figures and dates, the pending changes with their new figures, the kept
   figures beside the library's, the pin stamp with the drift count, the
   handover stamps with the issue counts; the trail strip's is the constant
   `"trail"` — and `isNoticeCleared(store, id, sig)` hides it ONLY while the
   signature matches. A later expiry date, another library move, a new kept
   rate or a new handover issue brings the band back on its own.
2. **Clearing decides nothing.** A kept rate stays kept, a prompt still waits,
   the pin stands; only the band is hidden. The decisions remain where they
   were (the Dashboard's "rate-changes-waiting" list, the Rates modal).
3. **The record lives on the quote** (`quote.clearedNotices[id] = {sig, at}`
   through `clearNotice` / `restoreNotices`), so a cleared band stays cleared
   on every device; the Dashboard's alarm, which has no project, keeps the
   same record in this browser (`BROWSER_NOTICES_KEY` =
   `gradcon-notices-cleared`, `readBrowserNotices` / `writeBrowserNotices`).
4. **"N notices cleared … Show again"** (`data-testid="notices-cleared"` /
   `notices-show-again`, under the banners in the editor and under the alarm
   on the Dashboard) restores every cleared notice at once.
`ImportFlagsBanner` keeps its own one-shot dismiss (the flags are deleted).
`test-notices.mjs` proves the Dashboard alarm (clear, reload, a changed date,
show again) and, in a project, the strip, the alarm and the pinned banner.

## The handover pass (Completed Estimating → Grady)

Grady, 8 Oct 2026: "model how grady assigns the works after i have marked
the projects as completed … implement all these for the next projects that
will be tagged completed estimating but still retain the freedom for Grady
to be able to change all cell entries". Modelled on the 12 Submitted projects
and 8 version histories (read-only, anon REST); `lib/handover.js` is pure
and verify-covered. Rules:

1. **It runs LIVE, in the editor, as the quantities are typed** (Grady,
   13 Oct 2026: "i want the prefill to happen realtime and automatically as
   the values are entered"): `liveHandover(quote, rates)` re-plans from the
   current quantities on every change to `quote.items` (App.jsx's effect; the
   Dashboard never writes items — its copies are stripped of drawings) and
   returns the SAME quote object when nothing moves, so the effect cannot
   loop. It writes where a crew cell is blank or still holds the figure the
   pass wrote last time (`handoverPlan(items, rates, prev)` reads the previous
   record); a cell retyped by hand is the estimator's for good; a cell they
   CLEARED is recorded `cleared: true` and never refilled; a cell the new plan
   no longer wants (the concrete was removed) is cleared again while it still
   holds the pass's figure; a spare row the pass named and nobody touched is
   re-used, never duplicated; the steel mode is set when unset and followed
   while it is still the pass's own choice. `liveHandoverApplies(quote)`:
   `handoverLive !== false`, a working status (`LIVE_HANDOVER_STATUSES` =
   Queued, Estimating, Completed Estimating, Quoting — a quote that went out,
   won, lost, missed or on hold never re-prices itself) and, on a finished
   status, `completedAt >= HANDOVER_SINCE` = 2026-10-08 (a project Grady worked
   through by hand before the prefill existed is never touched on its own).
   `undoHandover` also sets `handoverLive: false` (or it would refill at
   once); the banner's "Turn live prefill on" / "Prefill crew sheets now" sets
   it back. `applyHandover` / `shouldAutoHandover` remain the one-shot form
   (blank cells only) for a project the live rule does not cover.
2. **Blank cells only, every cell stays an ordinary typed cell.**
   `handoverPlan` writes only where the crew cell is blank, renames only a
   blank "Additional labour / plant" row, sets the Steel fix tonnage only
   when that qty is blank. `quote.handover = {at, cells, rows, qtys, steel,
   addedRows}` records exactly what was written; `prefilledCells` tints a
   cell on the crew sheet (`data-prefilled`, amber) only while it still holds
   the prefilled figure — retype it and the tint goes; `undoHandover` clears
   only cells / rows / qtys that still hold the prefilled figure and marks
   `handover.undoneAt`.
3. **The bands are production rates** (`PRODUCTION_RATES` "Handover: …"
   rows, keys `ho_*`, read through `handoverRate` → `lookupRate`), so Grady
   tunes them in the Rates modal like any production rate. What they encode
   (fitted to 25 elements; concreter cells are man-days, whole numbers):
   site setup 1 man-day on elements over 20 m³ (2 from 100 m³; the largest
   element always gets one); excavate & prepare base — ground elements only
   (`NO_DIG` = vertical / suspended / roof / prelims / finishes) — concreters
   3 + m³ ÷ 30, excavator 1 day to 45 m³, 2 to 150 m³, then m³ ÷ 75, bobcat
   the same on FOUNDATIONS / RETENTION / EARTHWORKS; tie reinforcement by
   `steelModeFor` — suspended → **subcontract** (tie row 0, tonnes on the
   `Steel fix` quote row = `STEEL_FIX_KEY`, UNPRICED until the quote is
   typed), ≤ 1 t → **concreters** tie (2 + 2.2 per t), else **steel crew**
   1 + 2.3 per t (min 2); pour 4 + m³ ÷ 15 man-days, pump 8 hrs from 25 m³
   or on suspended work; finish 0 and washout 0 typed (so the auto rule
   stops adding its own days); the two spare rows become "Material D+C" 2
   and "Boxing and Rebates" 2 (ground work) or "Tool D+C" 1.
4. **Steel fixing is a per-element switch** on the crew sheet (`Steel
   fixing` select, `item.steelMode`: auto / crew / concreters / subcontract;
   `applySteelMode` DOES overwrite the Tie row's crew cells and the Steel
   fix tonnage — that is the point of switching; an unpriced memo tonnage
   leaves with the mode, a priced quote stays).
5. **`HandoverBanner`** (every locked status, or whenever a prefill exists)
   says what was filled, offers Undo (two clicks) / Prefill again, and lists
   `handoverIssues`: subcontract quote rows with a qty and no amount (they
   price at $0 — five submitted elements carried steel tonnage that way),
   additional items typed halfway, estimator-note names with a one-click
   rename ("SCOPE REQUEST - X" → "Provisional Sum - X", "*** EXTERNAL QUOTE
   ITEMS ONLY ***" → the element type's name, "… - Receive Quote" stripped,
   a trailing "?" dropped) and the on-cost presets Grady uses (0 / 0,
   0 / 10, 8 / 5 — no rule was derivable, so they are one-click, never
   automatic).
6. **Tender Quote line items itemise EVERY element** (13 Oct 2026, Grady: "i
   dont want this statement, i want a very professional itemization of them
   rather than an approximate given"): `seedTenderItems` gives a level one dot
   point per element — count, run, area, concrete in the Project Geometry
   order — with no cap and never a "plus N further items — approx. X m³
   combined" roll-up; the editor shows every point plus one spare box
   (`patchPoint` appends) and the print lists them all. **The reword step
   applies here too** (Grady, same day: "apply the reword concept to tender
   quote also"): "✎ Reword for tender" above the line items asks the AI
   provider (`api/ai-engine.js` action `tender-wording`, `kind: "items"` →
   `tenderItemsPrompt` / `parseTenderItems` / `requestTenderItemsWording` in
   `lib/tenderWording.js` — same ids, the SAME number of points, every figure
   kept, no prices) and shows every title and point beside its struck-through
   original, editable, one tick per line, with a warning when a proposal's
   point count differs from the typed one; only "Use ticked wording" writes
   titles and points — prices are never touched, and "Reseed" still rebuilds
   from the quote. **The wording is industry language specified from the
   project's own records** (Grady, same day: "refine the language … to proper
   industry standard jargon … get specifications where needed from the
   corresponding quote line items and the estimates sections corresponding in
   name to the project"): `lib/tenderSpecContext.js` (pure) builds the
   context one request carries — for every dot point the matching quote
   element (`elementForPoint`: the point's leading name against the element
   labels with the level stripped, `elementNameForTender`), its priced
   catalog rows in a tender-minded band order (`quoteElementSpec`, fee rows
   left out, subcontract quotes named) and its free-text description, and
   the same-named elements (`takeoffMatches`) of the Estimates takeoff whose
   project name matches the quote's (`findTakeoffEntry`: exact, then
   containment, newest wins), each as its calculator fields and register
   lines (`takeoffElementSpec`; `takeoffSnapshot` reads v1 and v2 rows);
   `tenderSpecContext` trims line and row lists to `maxChars`, never a point,
   and reports `matched`. `lib/estimatesRead.js` reads the takeoff index and
   row from the cloud, then this browser (`readTakeoffForProject`; deps are
   the test seam). The prompt tells the model to fold ONLY those facts in
   (grade, section, bars and spacing, mesh, cover, finish, formwork, blinding,
   membrane, subcontract items) and never to invent one; the review note
   says what matched. The same request rewords the Additional Options (text
   only, every $ figure kept, prices never sent) and the Inclusions /
   Specific exclusions / General exclusions sections line for line
   (`parseTenderExtras`), each with its own tick in the review; one `onChange`
   writes items, options and sections together. A tender seeded before this
   still holds the roll-up line: `rolledUpItems` finds it and the red check strip's
   "Itemise" (`itemiseRolledUp`) replaces only those lines' points from a
   fresh seed, titles and prices kept. `test-tender-items.mjs` proves the
   itemisation, the repair and the review.
   **The Tender Quote is laid out in STAGES** (Grady, 13 Oct 2026, from his
   colour-coded printed quote and spreadsheet: "the stages in quote should not
   change but use the api calls to place those line items in the proper.
   vertical structures should be only for each level. per element prices
   should be printed under the right category"): `TENDER_STAGES` in
   `tenderQuoteDefaults.js` is the ONE fixed list — Retention, Basement, Lower
   Ground, Ground Floor, First Floor, Second Floor, Roof, External Works, in
   print order, a stage with nothing under it left off, NO Vertical Structure
   stage (a column or wall goes under the level it rises from). A line item is
   `{id, stage, title, price: "", lines: [{id, elementId, name, text, price}]}`
   — one row per element with ITS OWN price (`fmtTenderPrice` of its
   `computeExternalScopeLines` share); the stage total is NEVER typed
   (`itemPriceValue` = the rows' sum whenever any row carries a price, else the
   item's typed price — a hand-added item, or a tender saved before this).
   `itemLines(item)` is the ONE reading of an item's rows (a pre-stage item's
   `points` read as rows with no element and no price); `normalizeTenderItems`
   gives every item `lines` and mirrors the texts onto `points` for a build
   that still reads them — `lines` is canonical. Placement:
   `defaultStageFor(item, allItems)` is the rule — the level named ANYWHERE in
   the label or the element type's name (`levelStage`: "Strip Footings -
   Basement", "RC Columns - Basement to Ground floor" → the FIRST level named
   is the one the column rises from; a level above the second lands on Second
   Floor), retention work by name (piles, piers, capping beams, shotcrete,
   retaining) or band, roof / external / suspended by band, everything else on
   `lowestLevel` (the basement when the quote has one) — and
   `tenderQuote.elementStages` ({elementId: stage key}) is the recorded
   decision that `stageForElement` prefers, written by `regroupByStage` on
   every move (the row's own stage select in the editor, `moveRow`) and
   honoured by Reseed, refresh and the roll-up repair. **The AI places the
   elements in the reword step**: `requestTenderItemsWording` sends
   `elements` (id, name, type, category, description, current stage) and
   `stages`; `tenderItemsPrompt`'s PLACEMENT rule asks for `placement` by key
   from the fixed list only (columns never a stage of their own);
   `parseTenderPlacement` keeps known elements and keys only; the review's
   "Placement under the stages" block (`items-placement-review`) shows every
   element with its current → proposed stage as a select (orange when it
   moves) and "Use ticked wording" regroups by what the selects say whatever
   the wording ticks; a stage title is never changed by the reword. The print
   lists each row's text with its price (`print-row`) under its stage with the
   stage total on the heading; drift is per element row (`title` "Stage ·
   Element") and `refreshTenderPrices` moves row prices and adds a new element
   to its stage (creating the stage item in order). `test-tender-stages.mjs`
   proves the seed, the move, the placement review, the apply, Reseed, a typed
   row price and the legacy tender's itemise.
   **The "+ GST" after every price is a toggle** (`tq.gstSuffix`, default on,
   beside the GST-lines toggle in the Project Sum editor; Grady, 13 Oct 2026:
   "we need to toggle if we want to remove the gst or not"): off, the print
   reads every price — stage totals, rows, options, the project sum — through
   `printedPrice(str, tq)`, which drops the suffix; stored strings never change.
   **Tender Quote prices are a snapshot** (`seedTenderItems` on first open;
   `pricesAt` stamped). `tenderPriceDrift` compares each stored line's price
   with a fresh seed by title; the red check strip at the top of the Tender
   Quote lists the drift and `refreshTenderPrices` moves ONLY the prices
   (titles and dot points kept, new groups appended). Both the Tender and
   External quotes show the $0 quote rows in the same strip. `tenderPrefill`
   seeds the attention company from `quote.clientName`; the External Quote
   does the same on its first open.
`test-handover.mjs` proves the whole pass through the UI; `verify.mjs`
covers the plan, undo, tint, steel switch, bands and the tender drift.

## Tender Notes carry the project's Assumptions

Grady, 8 Oct 2026: "entered assumptions should automatically be entered in
the external tender quote under the relevant section inside the Tender
Notes cell well bulleted and formatted accordingly". `lib/tenderNotes.js`
(pure, verify-covered): `tenderNoteLines(quote, typedText)` is the ONE
reading both the External Quote and the Tender Quote use, on screen and in
print — the project's `quote.assumptions` texts first (recorded order, blanks
dropped), then the report's own typed notes one per line with a leading
bullet mark stripped, and a typed line that repeats an assumption or an
earlier line printed once. `components/TenderNotesCell.jsx` is the shared
cell: the assumptions sit at the top, bulleted and READ-ONLY (they are edited
in one place — the Assumptions list under Project Geometry — and flow here
live), the textarea below holds the report's extra notes. Nothing is ever
copied into `externalQuote.tenderNotes` / `tenderQuote.tenderNotes`: they
hold only what was typed on that report, so a later assumption still
appears and a deleted one disappears. The printed "Tender Notes:" section
(`data-testid="tender-notes-print"`) renders when either list has a line.
`test-tender-notes.mjs` proves both reports.

**Tender wording** (Grady, 11 Oct 2026: "language reconstruction for the
assumptions before pushing to the tender quote"): the estimator's shorthand
is rewritten as tender qualification lines by the AI provider and REVIEWED
before any of it is used. `lib/tenderWording.js` (pure, verify-covered): an
assumption gains `tenderText` (the accepted line) and `tenderSource` (the
typed text it was written from); `assumptionTenderLine(a)` is what the
Tender Notes print (`assumptionLines` / `assumptionNoteItems` in
`tenderNotes.js` read through it), `wordingState(a)` = none / reworded /
stale (the typed text changed after the rewording — the accepted line still
prints, the cell and the Assumptions list say "original changed since" until
it is redone or cleared), `tenderWordingPrompt` (same ids, no new facts, the
trade's forms: "Allowance has been made for …", "… is excluded from our
price", "… to be confirmed", "Please confirm …") and `parseTenderWording`
(by id, then by position) are what `api/ai-engine.js` action
`tender-wording` runs through `callText`; `requestTenderWording` posts it
from the Quotes bundle to `location.origin + "/api/ai-engine"` with the
browser's provider choice (`preferredProvider`). `TenderNotesCell` carries
"✎ Reword for tender": every proposal beside its struck-through original,
editable, each with its own tick, and only "Use ticked wording" writes
(`applyTenderWording`) through `onChangeAssumptions`, which both reports take
from App. The typed assumption text is never changed — the quote report and
the Assumptions list keep it; the list shows the tender wording under each
with a "clear" (`clearTenderWording`). `test-tender-wording.mjs` proves the
review, the apply, the stale flag, the clear and the no-provider error.

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

## Estimates opens on the takeoff last worked on

Grady, 18 Oct 2026: "opening estimates should default to the last project
worked on". `initTakeoffRegistry` picks, in order: (1) a one-shot request in
`gradcon-estimate-open` (`ESTIMATE_OPEN_REQUEST_KEY`) — written beside
`gradcon-estimate-active` by the shell's welcome cards / "Coming up" rows,
the Gradcon AI chat's open-takeoff button and the AI Engine mirror's
`openInPortal`, and REMOVED the moment it is read so it can never apply
twice; (2) `lastWorkedTakeoff(live)` — the live registry entry with the
newest `savedAt` (every save, autosave, tab-hide and unload stamps the open
takeoff; the registry is the cloud-merged list, so "last worked on" is
across devices and matches the welcome panel's "Last worked on"); (3) this
browser's `gradcon-estimate-active`; (4) the first live entry. Before this
the boot opened whatever this browser last left open, else the FIRST entry
in the list. `test-last-worked.mjs` proves the stale-active case, the
request, an unknown request and the welcome card. **The Saved Takeoffs bar
is ONE dropdown** (Grady, 22 Oct 2026: "i want the saved takeoffs rolled up
with a drop down to select the projects and it should default to opening the
last project worked on"): `renderTakeoffsBar` renders `#takeoffSelect`
(`data-testid="takeoff-select"`) — every live takeoff newest-saved first,
each option "name — saved <when> · N elements", the open one selected, AI
drafts in their own optgroup, an "Unsaved new takeoff" option while the open
draft is not yet registered — beside "+ New takeoff", "✕ Delete this takeoff"
(the open one) and a `takeoff-current` line; picking an option runs
`switchToTakeoff` (the open takeoff is saved first). The header's
"📁 Projects ▾" picker and the cloud versions list are unchanged.
`test-takeoff-select.mjs` proves the order, the switch and the reload
opening on the takeoff last worked on.

## Welcome panel (portal sign-in)

Grady, 10 Oct 2026: "when Grady logs in, it welcomes him and gives random
excited messages about his work for that day and displays links to projects
he left off and when he left it off." `portal-shell.html` → `renderWelcome()`
(run on sign-in, on a restored session that lands on the dashboard, and on
Back to portal): the hero's eyebrow becomes today's date, the heading
"Good morning, Grady." (`firstName` from the email; `projects@` is "team"),
and the paragraph one of `EXCITED` — lines built from REAL facts
(`welcomeFacts`: quotes due today / within 7 days among the open statuses in
`OPEN_WORK`, counts in Estimating and Queued, the most recently saved item
and when) plus a few generic ones, picked at random and never the same as
the previous sign-in (`sessionStorage` `gradcon-welcome-last`). The "Pick up
where you left off" cards are the six most recently saved Quotes projects
and Estimates takeoffs with `whenLabel` ("30 min ago", "today at 4:12 pm",
"yesterday at …", "Mon 9 Oct at …"); a quote card writes
`gradcon-active-project` and opens Quotes with a forced reload (the same
handoff the Planner tile uses), a takeoff card writes
`gradcon-estimate-active` and opens Estimates. Facts come first from what the
browser holds (`gradcon-cache:gradcon-projects`, the `gradcon-cache:summary:`
mirrors, `gradcon-estimate-projects-index`, else the bare localStorage-mode
keys), then the cloud stamps refine the "when" and the summaries function
names up to three projects this browser never opened. The shell carries its
own copy of the Supabase URL and anon key (`CLOUD`) for those two reads —
the same public key the Estimates app ships. Offline, the local paint
stands. **Grady's account sees Quotes only** (`QUOTES_ONLY_USERS` /
`seesTakeoffs(email)`, 10 Oct 2026: "grady's account doesnt have to display
estimates. he only works on quotes"): no takeoff cards, no takeoff facts, no
cloud read of the Estimates index; `projects@` sees both. **Both accounts get
the "Coming up" strip** (`#welcome-upcoming`, painted by `paintWelcome`):
every open quote (`OPEN_WORK` = Queued, Estimating, Quoting — Grady, 10 Oct
2026: "completed and deadline missed should not be here"; the cards obey the
same set, takeoffs are not filtered) whose deadline is overdue, today or within 7
days, soonest first, with a red chip for overdue / today, amber up to 3 days
out (`dueLabel(deadline, now)` → `{text, cls, n}` off `dayDiff`, local
days), each row opening the quote; "No quote deadlines in the next 7 days"
otherwise; then "Last worked on: <name> <when>" — the most recently saved
item (a takeoff only for an account that sees them). `openFromWelcome` is
the ONE click handler for cards, rows and that link (`data-kind` +
`data-id`). `test-welcome.mjs` proves both accounts.

**The welcome panel is ONE centred column** (Grady, 23 Oct 2026: "format
this well and rearrange these items as they are too scattered"): `--welcome-col`
= 880 px in the shell's CSS; the greeting block (`.dash-hero`), the chips row
(`.welcome-badges`, now UNDER the greeting line: weather then storage, one
row), "Coming up" and the pick-up cards (`.welcome-recent`, `auto-fit` columns)
all take `width:100%; max-width:var(--welcome-col); margin:auto`. The
`width:100%` is load-bearing — `#screen-dashboard` is a flex column and a flex
item with auto side margins shrinks to its content (the cards once collapsed
to a 300 px stack). The storage pill is short ("Google Drive · <folder>"; the
account and "Dropbox soon" ride on its hover) and the weather chip drops the
word "today" so both fit one row; an empty chip never paints (`:empty`).
`test-welcome-layout.mjs` measures the column at 2000 px wide.

**The welcome line is a MARQUEE that changes every 30 minutes** (Grady,
23 Oct 2026: "the every tender... bit should be a marquee centred horizontally
with a different quote every 30 mins"): `#welcome-line` is a centred 640 px
strip (overflow hidden, edges faded by a mask) whose `.track` scrolls right to
left on the `welcome-marquee` animation (duration from the line's length,
paused on hover; `prefers-reduced-motion` gets a static centred line).
`excitedLine(facts, now)` is no longer random: it is the half-hour clock SLOT
(`welcomeSlot` = floor(now / 30 min)) modulo the lines that apply, so the next
slot is always the next line and every device shows the same one in the same
half hour; `paintWelcomeLine(now)` repaints only when the line changes and
`scheduleWelcomeRotation` fires it on the next boundary. The old
`gradcon-welcome-last` sessionStorage key is gone. `window.gradconWelcome` is
the test seam.

**"Industry updates" rail** (Grady, same day: "give construction related
updates on the side especially from the VBA and recent updates and some
business related specification snippets"): `api/_news.js` (pure,
verify-covered) + `api/industry-news.js` (GET, own-origin check, a 30-minute
server copy, `?refresh=1` re-reads; `vercel.json` maxDuration 30). **Every
item is a real published article** — nothing is composed. `NEWS_SOURCES`:
the VBA / Building and Plumbing Commission, the NCC / ABCB, "Standards &
specs" (AS 3600 / AS 2870 / AS 3610 / Standards Australia / specification),
"Industry & business" (insolvency, security of payment, building contracts,
tenders, Master Builders), WorkSafe Victoria — each a Google News RSS search
(`GNEWS(q)`, en-AU) because the VBA's own site answers server fetches with a
Cloudflare challenge (403, checked 23 Oct 2026) — and CCAA's own RSS feed.
`parseFeed` reads RSS 2.0 and Atom (CDATA, `<source>`, Google News' "Title -
Outlet" suffix → `outlet`), `mergeNews` dedupes by title, ages out items older
than 120 days, sorts newest first and caps at 30, `fetchNews(sources,
fetchImpl)` reports every source's ok / count so one dead feed never empties
the panel. The shell: `#welcome-news` (an `<aside>` in `.welcome-grid` beside
`.welcome-main` — a 330 px right column from 1180 px, below the cards under
it; `no-news` keeps the single centred column when nothing could be read),
`paintIndustryNews(force)` (sessionStorage `gradcon-news`, 30 min; "refresh"
forces), `renderIndustryNews` (source chips as a filter, 14 newest shown, each
item a link to the outlet's own page in a new tab with a source chip, the
outlet — `outletName` turns a URL into its host — the day and a two-line
snippet). `test-welcome-layout.mjs` proves the marquee, the slot, the rail
beside / below and the filter on a mocked `/api/industry-news`.

**Weather at the top of the dashboard** (Grady, 22 Oct 2026: "show weather
and temperature on the top of the dashboard upon loggin in"): `paintWeather`
in the shell (run by `renderWelcome` and on every Settings save) reads
Open-Meteo straight from the browser — no key — for the place in Settings →
App behaviour "Weather on the dashboard — place" (`weatherPlace`, blank =
Melbourne; the first Australian geocoding hit, cached in localStorage
`gradcon-weather-geo:<place>`; the reading cached 15 min per tab in
sessionStorage) and paints `#welcome-weather` beside the storage badge: sky
(`WMO` code → icon and words), temperature, feels-like, today's min–max,
rain chance and wind. Nothing shows when it cannot be read; the chip opens
Settings. `test-weather.mjs` proves it on a mocked Open-Meteo.

## AI provider keys live on the server (api/)

Grady, 10 Oct 2026: "code in the environment variables so i can add the api
keys." `api/_providers.js` is the ONE place a provider key is read — a Vercel
function module (the underscore keeps it from being an endpoint), never
imported by `src/` or `portal/`. Variables, set in the Vercel project under
Settings → Environment Variables and NEVER prefixed `VITE_` (that prefix
bundles a value into the public browser code): `ANTHROPIC_API_KEY` /
`ANTHROPIC_MODEL` (default `claude-opus-5-5`), `OPENAI_API_KEY` /
`OPENAI_MODEL` (default `gpt-5`), `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`
(default `deepseek-chat`), `AI_PROVIDER` (the default provider; else the
first with a key). `providerStatus(env)` reports what is set without key
material, `defaultProviderId`, `callText(id, {system, prompt, maxTokens})`
runs one prompt on one provider (Anthropic through `@anthropic-ai/sdk` with
the server-side refusal fallback; OpenAI and DeepSeek through their shared
chat-completions shape), `pingProvider` is the one-word test. Every future
job that reads a drawing or a tender document goes through `callText`, so the
provider is a config choice. `api/ai-providers.js` (GET status, POST
`{provider, action:"test"}`) backs Settings → "AI providers" in the shell
(`loadAiProviders`); it checks the call comes from the portal's own origin,
which deters a drive-by page but is not a security boundary.
`api/parse-assist.js` now calls the adapter on the default provider.
`.env.example` documents the variables; `verify.mjs` covers the status,
default and the 503 on an unconfigured provider.

## Gradcon Storage: the office's Google Drive project files, inside the app

Grady, 21 Oct 2026: "the office uses dropbox and i have introduced google
drive … so Grady doesnt have to leave the app to locate stored files … lets
use the gmail account linked to projects@ … i already have the folders in
the drive, i want that folder accessible to grady … inside the app and should
sync across everywhere". Google first; Dropbox is a second adapter behind the
same drawer, later. Rules:

1. **One Google connection carries both scopes.** `DRIVE_SCOPE`
   (drive.readonly) joins `GMAIL_SCOPE` in `consentUrl`; `connectionStatus`
   reports `drive` (the stored `scope` includes it). A mailbox connected
   before this reconnects ONCE (Settings → Google mail & Drive → "Reconnect
   for Drive"); until then `api/drive.js` answers 409 `needsReconnect` and
   every surface says so. The token stays encrypted server-side as for mail.
2. **`api/_google.js` is the ONE Drive adapter** (read-only, never writes to
   Drive): `driveFile`, `driveChildren` (folders first), `driveAncestors` /
   `withinRoot` (the parent chain, memoised per request), `driveSearch` (name
   + fullText, then KEPT under the root by ancestry — Drive cannot search a
   subtree itself), `driveDownload` (a Doc / Sheet / Slides exported as PDF,
   capped `DRIVE_COPY_MAX_BYTES` = 30 MB), `normalizeFile` / `fileKind`
   (folder / pdf / image / doc / sheet / slides / cad / other),
   `matchProjectFolder` / `scoreFolderMatch` (pure: shared name tokens over
   the project's, a street number counting double, stop words dropped;
   `best` only when one folder scores ≥ 0.6 and leads by 0.2),
   `driveFolderIdFrom` (a folder link or bare id). Shared drives are
   included on every call.
3. **`api/drive.js` reads ONLY under the root folder.** The root is the
   office folder Grady gave (`DEFAULT_DRIVE_ROOT_ID`, a folder id is not a
   secret) unless the shared `gradcon-storage` row (`STORAGE_ROW_KEY`,
   `{drive: {rootId, rootName, chosenAt}}`, written by action `setRoot` from
   Settings) names another; every `folder` / `list` / `search` / `file` /
   `copy` id must be the root or beneath it (403 otherwise). Actions: `status`
   (GET too — the Dashboard badge), `roots`, `setRoot`, `folder`, `list`,
   `search`, `match`, `file`, `copy` {target: preview | markup | job}. A copy
   goes to the `gradcon-files` bucket — `drive/<id>/<md5|modified>/<name>`
   for previews (cached by content) or `ai-engine/<jobId>/<name>` for a job,
   exactly as a mail attachment — and returns its public URL with `fromDrive`.
   Same-origin check as the other functions; `maxDuration` 60.
4. **A project remembers its folder and its attachments ON THE QUOTE** (so
   they sync with it): `quote.storageFolders.drive = {id, name, webViewLink,
   chosenAt}` and `quote.files[] = {id, provider: "drive", fileId, name,
   kind, mimeType, size, modifiedTime, webViewLink, attachedAt}` —
   `src/lib/driveFiles.js` (pure helpers + the browser client `driveApi`):
   `setProjectDriveFolderPatch`, `attachFilePatch` (idempotent by Drive id),
   `detachFilePatch`, `driveFiles`, `projectAddress`. **Attachments are
   LINKS; a file is copied only when it is used** — "Use" in the picker
   (a markup, an AI Engine job) or a preview.
5. **`DriveFilesDrawer`** (Quotes, `mode: "attach"` from the editor's
   **Files** button — count of attached files on it — or `mode: "pick"` as
   the picker) opens on the project's folder; with none, `match` offers the
   fitting folders (the best is taken when clear) or the root to browse, and
   "This is the project's folder" records the choice. Breadcrumb browse,
   search within the folder (or the whole root), preview in place (PDF
   `<embed>` / image from the preview copy), "open in Drive", Attach /
   Attached, the attached list with remove. `pickDriveFile(accept)` in
   `ProjectEditor` resolves with the copied file: an element card's **From
   Drive** button feeds it through `addMarkupFiles` like a dropped file;
   the Project Folder's "Google Drive files for this project" opens the
   project on its drawer (`gradcon-open-drive`, one-shot).
6. **The AI Engine's "From Google Drive"** (`openDrivePicker`) browses /
   searches the same folder (the job's project folder when matched) and
   copies a PDF / Doc into the job as a mail attachment is.
7. **Gradcon Cloud Storage** (Grady, 22 Oct 2026: "use that space and name it
   Gradcon Cloud Storage and let the gradcon vault and its parameters be under
   this"): the Quotes tab that was "Gradcon Vault" is now `CloudStorageView`
   — the office folder browsed IN PLACE (`DriveFilesDrawer inline mode=
   "browse"`: no project, no attach / use, breadcrumb / search / preview /
   open in Drive) with `ProjectFolderView` (the Vault, unchanged) beneath.
   The portal nav reads "Cloud Storage" and carries a dedicated **Google
   Drive** button (`MENU_ROUTES.drive` → Quotes initial view `drive`, which
   `takeInitialView` maps to `folder`); the welcome tile 06 is "Gradcon
   Cloud Storage". `test-cloud-storage.mjs` proves it.
8. **Settings → Google mail & Drive** shows the folder the app reads under
   (open in Drive, default or chosen) and "Change folder…" (a pasted link,
   or one of projects@'s top-level folders / shared drives). The **Gradcon
   Storage badge** on the portal dashboard (`#welcome-storage`,
   `paintStorageBadge`) states Drive connected + folder, Drive access to
   grant, or not connected, and opens Settings. Dropbox reads "soon".
`verify.mjs` covers the scopes, the matching, every `runDrive` action on a
fake Drive (root scoping, the 403s, the copy paths, a chosen root) and the
quote helpers; `test-drive-files.mjs` proves the drawer, the card picker, the
Settings panel, the badge and the AI Engine picker against a mocked
`/api/drive`.

## The Register (tile 08): contractors, suppliers, consultants and clients

Grady, 23 Oct 2026: "i want the register included in the gradcon app. same
level as the quotes, estimating, etc. … fully editable and well categorised";
then "the foundation contractors, make sure you highlight the ones that dont
do screw piles and vice versa or both. so you understand the level of details
that i seek". `portal/register.html` is its own vanilla app (payload
`__REGISTER_B64__`, menu key `register`, tile 08, Settings "open after
sign-in" option), inlined by `scripts/assemble-portal.mjs` with its seed
`portal/register-seed.js` (the way `estimates-schema.js` is). Rules:

1. **One cloud row, merged per organisation.** `gradcon-register` in
   `estimator_kv` = `{version, orgs, tombstones, log, updatedAt, updatedBy}`
   with a localStorage mirror under the same key. `mergeStates(a, b)` is the
   ONE merge: the newer `updatedAt` copy of each organisation wins, a
   tombstone newer than the organisation removes it (so a removal never
   comes back from another device), the change log is the union. The tab
   never writes before it has read the cloud row (or a positive "no row");
   `pushNow` re-reads and merges before every write (never a blind
   overwrite); a 20 s stamp poll pulls another device's edits. A failed
   fetch is never "no row". `readLocal()` answers null when nothing is
   stored — on 23 Oct 2026 a blank-normalised local copy once hid the seed.
2. **The seed is a starting point, read once.** `register-seed.js`
   (`REGISTER_SEED`, `REGISTER_CAPABILITIES`, `REGISTER_TRADE_GROUPS`) was
   built by a one-off script from three READ-ONLY sources: the projects@
   mailbox (818 messages, drafts and system mail excluded, the estimators'
   own personal addresses excluded — `verify.mjs` checks), the 23 Oct 2026
   contractor/supplier workbook (trades, websites, projects, people where the
   mailbox read did not reach) and the Project Management register's seed
   rows (the two `RegisterTab`s in `PlannerView.jsx` stay, with a note
   pointing at the Register). It is used only on an install with no row;
   "Add missing from list" adds seed organisations that are absent and not
   tombstoned, never overwriting. Regenerate the file from the script, never
   hand-edit it.
3. **Supply chain and clients are kept apart.** `category` ∈ subcontractor /
   supplier / consultant / service (side `supply`) · builder / client (side
   `client`) · other. The tabs are Supply chain · Clients · Everyone · People
   (every contact across organisations) · Follow-ups · How this register
   works. Supply-side organisations also carry a `tradeGroup` (piling,
   formwork, concreting, pumping, pt, screed, waterproofing, earthworks, reo,
   premix, foam, consumables, plant, estimating, other).
4. **Capabilities are what THEY said, never what Gradcon asked for.**
   `org.capabilities[key] = {status: "yes" | "no" | "unknown", evidence, by}`
   over the sixteen `REGISTER_CAPABILITIES` (screw piles, bored piers, CFA,
   retention piling, shotcrete, capping beams, anchors, formwork, pumping,
   placement, PT, waterproofing, screed, reo, premix, excavation). The seed
   reads a contractor's own sentences (the part before any quoted reply) and
   quotes the sentence with its date; stated facts are pinned by hand
   (`CAPABILITY_FACTS` in the build script): BCS "It does have 15 screw piles
   which we do not install" → screw `no`; Allstate quotes screw piles as the
   alternative wherever bored piers are specified → screw `yes`, bored `no`;
   DMAC bored / CFA / retention / shotcrete / capping `yes`, screw `unknown`
   (no screw-pile correspondence). **Mining is limited to the contractor's
   own trade family** (`CAP_FAMILY` in the build script → each
   `REGISTER_TRADE_GROUPS` entry's `capGroups`; 23 Oct 2026: a foam supplier
   had been tagged "screed", a piler "reo"). A piling-group organisation
   always carries the four piling keys, `unknown` when unstated. The seed
   carries `version`; `resyncSeedCapabilities` runs ONCE per version on a
   stored register (`state.seedVersion`): mailbox-read (`by: "mail"`) and
   placeholder (`by: "seed"`) entries follow the new seed, a capability set
   by hand is never touched, and the move is logged. The list row shows
   ✓ / ✗ (struck through) / ? chips; the **piling matrix** (shown when the
   Piling trade chip or a piling capability chip is on) puts the foundation
   contractors side by side; a change in the row's grid is stamped with the
   account and logged. **Filtering is one click** (Grady, same day: "if
   screw piles clicked, only screw piles contractors should appear and not
   this multi choice filtering"): every chip row — Category, Trade, Does —
   is a single choice (click to see only those, click again to clear), and a
   capability chip shows ONLY the organisations recorded as DOING it; who
   does NOT is read off the matrix and the row chips, never a sub-filter.
   **The expanded row is compact** ("reduce details given under the dropdown
   when each item clicked"): the organisation's own fields, its people with
   the last contact and subjects, and the capabilities of its own trade
   family ("Every capability" shows all 16); compliance, projects / address /
   risks, the evidence basis and the change log sit behind "More ▾"
   (`UI.more`, `UI.allCaps`, session-only).
5. **The evidence score is correspondence, never performance.** 0–100 =
   volume (6·ln(1+emails), ≤30) + threads (5 each, ≤20) + two-way (15) +
   their median reply time (≤24 h 15 / ≤72 h 10 / else 5) + recency (≤30 d
   20 / ≤90 d 14 / ≤180 d 8 / else 2); tiers A ≥80, B ≥60, C ≥40, D. The
   basis is printed on every row (`scoreBasis`). **Grady's star rating** is
   separate and never computed. "Ball with Gradcon" = their email is the last
   in the thread, 3+ days; "Waiting on them" = Gradcon wrote last, 3+ days
   (7+ on Follow-ups); "Going cold" = 90+ days. Compliance (ABN, GST,
   insurances, licences, payment terms, last rate) is Grady's to fill —
   the register states it is unverified until then.
6. **Mail is read only when asked, and never written.** "Check mail now" on a
   row and "Check mail for N shown" POST `/api/gmail` `{action: "list", q:
   "{from:@domain to:@domain cc:@domain …}", max: 8}` through the portal's
   Google connection (read-only), move `lastContact` / `lastContactDir` /
   `lastMailId` to the newest message, add its subject to `threads` and log
   the move. Nothing runs on a timer. Gmail links open the mailbox
   (`#all/<id>`, `#search/<q>`). The Gradcon AI chat context carries the
   register (`register` in `assistantContextWith`: category, trade, does /
   does not, last contact, primary contact) — read-only.
`test-register.mjs` proves the tile, the matrix facts, the filter, the edit
trail, the mailbox check, the three tabs and the cloud round trip on a mock
cloud; `verify.mjs` pins the seed facts, the shapes, the wiring and the
merge.

## RFQs and emails sent from the app (one message per contractor, approved first)

Grady, 23 Oct 2026: "when i am working on an estimate and require an RFQ to
be sent, i want the app to draft this email and i should be able to select
from the contractors for that particular item and the email draft will be
made for my approval and sent each of the selected contractors without mixing
up their details, their contact and their specific trades … industry standard
formatting for the subject … a separate one should be sent to each rather
than a bcc or cc"; "email should have the name of the project, and also use
the details of what is available in the estimates sections as entered by the
estimator … options to attach the drawings"; "for each email with the
keywords, automatically attach the relevant files from the attached drive,
bare minimum should be archi, struct, soil report". Rules:

1. **Sending is the ONE write to Google, and only on approval.** `api/_google.js`
   `GMAIL_SEND_SCOPE` (gmail.send) joins the consent; `connectionStatus.send`
   says whether the stored connection carries it; a connection made before
   this reconnects ONCE (Settings → Google mail & Drive → "Reconnect for
   sending", `google-reconnect-send`) and until then `api/gmail.js` action
   `send` answers 409 `needsReconnect`. `buildMime` writes ONE `To:` (one
   contractor per message — never Bcc, never another contractor) and, since
   26 Oct 2026 (Grady: "add a cc copy to grady@gradcon.com.au and allow me
   to add other ccs"), a `Cc:` of GRADCON'S OWN copies — `DEFAULT_CC` =
   grady@gradcon.com.au, the composer's "Cc on every email" box (`rfq-cc`,
   remembered per browser `gradcon-rfq-cc`, `parseCc` splits commas /
   semicolons / spaces, lower-cases and dedupes) and the Register composer's
   Cc box; `api/gmail.js` takes `cc: [address…]` (≤ 6, each `isOneAddress`),
   `buildMime` drops a cc equal to the recipient — RFC 2047 headers (the en
   dash in "RFQ – …"), multipart/mixed with attachments; `isOneAddress`
   refuses "a, b"; attachments are fetched by the server from the portal's
   own bucket only (`ATTACH_URL_PREFIX`, ≤ 10 files, `ATTACH_MAX_BYTES` =
   18 MB raw — Gmail refuses 25 MB ENCODED, base64 adds a third —
   `fetchAttachments`), never an arbitrary URL. **Attachments are PLANNED
   before anything is built** (26 Oct 2026: a real round failed on both
   contractors with "attachments over 20 MB in total"): `planAttachments(
   files, ATTACH_PLAN_BYTES = 17 MB)` in `rfq.js` takes the ticked files in
   order while they fit and puts the rest in `link` — those go in the body
   under DOCUMENTS as "Too large to attach — download from these links"
   (the bucket copy's URL, with its size), the composer shows every file's
   size (`rfq-attach-bytes`, "as a link" on the oversize ones) and the
   running total against the cap (`rfq-attach-size`), and the draft header
   counts "N as download links". A send therefore never fails on size; the
   server cap is the hard stop behind it. The done screen claims the
   record ("Recorded on this project … checklist step 05 ticked …") ONLY
   when at least one RFQ went; with none it reads "Nothing was sent …" in
   red and "Nothing was recorded" (`onSent` was never called). Reply-To is
   the mailbox. Nothing is composed server-side; the function sends what the
   browser shows after a person ticked "Approve" on THAT draft.
2. **`src/lib/rfq.js` is pure and verify-covered.** `RFQ_PACKAGES` (Screw
   Piling, Bored Pier Works, CFA Piling, Retention Piling & Shotcrete,
   Formwork, Steel Fixing, Reinforcement Supply, Excavation & Earthworks,
   Concrete Pumping, Post-Tensioning, Waterproofing, Screed & Toppings,
   Premixed Concrete Supply, Concrete Works, Other) each name a Register
   trade group and capability; `suggestPackages(items, typeNameOf)` reads the
   elements' SUB CONTRACTORS rows and type names; `contractorsFor(orgs, pkg)`
   → `{does, unknown, not}` from the Register (supply side, that trade, the
   capability's yes / unstated / no — "says they don't" is folded away, never
   hidden); `rfqContact(org)` = the primary contact with an email (a team
   inbox is never greeted by first name); `rfqSubject` = `RFQ – <Package> –
   <Project name>` (Gradcon's own form in the mailbox); `elementScope(item,
   rates, scope, typeName, takeoffInstances)` = the element's measures (no. /
   lm / m² / m³ through `computeElementCost`), its subcontract rows, the
   estimator's description and, through `takeoffMatches` /
   `takeoffElementSpec` (`tenderSpecContext.js`), the same-named Estimates
   takeoff element's fields and register lines ("As taken off (pier): depth
   6000, diameter 450 …", "Concrete: N32 — 9.54 m³"); `rfqText` lays out the
   RFQ (project, site, package — never the builder / client, Grady 23 Oct
   2026 —, "Request issued", "Quotation required by … (N days from this
   request)" + "If you can submit sooner, please do. If that date cannot be
   met, please reply with the date you can submit by.", SCOPE OF WORKS,
   NOTES, DOCUMENTS naming every attachment with what it is —
   `attachmentLabel`: "(architectural drawings)", "(structural drawings)",
   "(soil / geotechnical report)" — and, with nothing attached, "No documents
   are attached to this email — they will follow separately" (never
   "available on request": documents are always attached), what to include
   — rates ex GST, inclusions / exclusions, validity, lead time, site
   requirements, insurances and ABN — and the signature). `RFQ_LEAD` is the
   lead time Grady picks per round ("How heavy is this quote?": simple 3
   days, complex 7 — business days through `dayPlus`, the date still
   editable); `rfqDrafts` builds ONE
   independent draft per organisation from the same facts, so no name,
   address or trade of one contractor can reach another (verify checks the
   DMAC draft holds no BCS and vice versa). **The greeting is locked and the
   body is shared** (26 Oct 2026: a body edited by hand on BCS's draft was
   carried into Trevor's at DMAC with "invites BCS Piling" still in it —
   Grady: "there is a name mix up and i dont want this happening again"):
   `rfqHead({pkgLabel, org, contact})` = "Dear <first name>," + the
   invitation line — the ONLY lines that name the contractor — is written
   per draft (`d.head`) and shown READ-ONLY above the textarea
   (`rfq-head-lines`); `rfqBody(...)` (`d.body`, from "Project:" down) is
   ONE text per PACKAGE (`bodies[pkgKey]` in `RfqModal`), edited once for
   every contractor of that package (an edit clears their approvals; Re-draft
   rebuilds the package's body and this draft's head); `rfqText` =
   `joinDraft(head, body)` and the send posts `textOf(d)`. **The name guard
   `draftNameIssues(draft, allDrafts)`** searches a draft's subject, head and
   body for ANOTHER contractor of the round — organisation name and each
   part of an "A / B" name, contact name, email, email domain (free-mail
   domains excepted); a word that belongs to the draft's own contractor is
   never a hit — and the composer shows the hit in red (`rfq-name-issue`),
   disables Approve, skips the draft on Approve all and refuses it at the
   moment of sending ("not sent — the text names …"). Verify-covered;
   `test-rfq.mjs` pastes BCS's name into the shared body and proves DMAC's
   draft is held while BCS's goes. `rfqRecord` / `rfqPatch` keep the
   round on `quote.rfqs[]` (package, elements, due, attachments, every
   recipient with status, message and thread ids).
3. **Auto-attach from the project's Drive folder.** `ATTACH_CLASSES` — archi
   (architectural / A-101 / floor plan …), struct (structural / S01 /
   engineer …), soil (geotech / soil / site investigation / Civil Test …) are
   REQUIRED on every package, `PACKAGE_WORDS` add the package's own words
   (pile / pier, formwork, reo, membrane …); `classifyFile(name, folderName,
   pkgKey)` tags a file, `driveFolderOptions(files, pkgKey)` lists the
   folder's attachable files with the tagged ones ticked (`auto`), and
   `missingAttachClasses(options, ticked)` names a required class nothing
   ticked covers — the composer prints "Not found in the folder, not
   attached: …" rather than skipping it. `RfqModal` reads the folder
   (`quote.storageFolders.drive`, else `match` by project name), one level of
   subfolders and a search for the three words; a ticked Drive file is copied
   into the bucket ONCE per build (`api/drive` copy, target preview) and the
   same URLs ride on every message of the round; drawings dropped on the
   chosen elements (`markupSrc`) are offered too.
4. **`RfqModal.jsx`** (editor header "RFQ (n)" button `rfq-button`, every
   element card's mail button `element-rfq` opening on that element): step 1
   elements, PACKAGES as chips — several at once (Grady, 23 Oct 2026: "i
   should be able to select more than one package"; suggested ones first,
   ★), each ticked package with its OWN contractor section and search
   (`picks`: pkgKey → orgIds), so a contractor ticked under two packages
   gets two RFQs each about its own package; one `quote.rfqs` record per
   package; due date (`dayPlus(7)`, business
   day), signatory (default "Boma Ipalibo / Gradcon Concrete Constructions /
   projects@gradcon.com.au" — `DEFAULT_SIGNATORY`, Grady 23 Oct 2026; a
   retyped name is remembered per browser, `gradcon-rfq-sender`), notes for
   all, attachments, the contractors (search adds any Register organisation;
   one without an email cannot be ticked); step 2 one draft per contractor —
   subject and body editable (an edit clears its approval), Approve / Approve
   all, Re-draft, Copy, "Send N approved" (disabled with a read-only mailbox,
   the warning `rfq-mail-warning` says to reconnect); each send is its own
   POST, results per contractor; step 3 the summary. `onSent` in App records
   the round (`rfqPatch`), ticks checklist step 05 with the package and
   names (`checklistPatch`), and `recordRegisterContacts`
   (`src/lib/registerStore.js`: the Register row read from the cloud, else
   this browser's mirror; merged per organisation) moves each contractor's
   last contact to today (Gradcon wrote), adds the subject and logs it.
5. **The Register's own "✉ Email"** (`register.html`, `data-compose-open`): a
   drafted message to one chosen contact (`emailTemplate` — subject from the
   trade, a body with a bracketed prompt), editable, Approve, Send (one
   message, `/api/gmail` send), recorded on the organisation the same way.
   Nothing is sent without the approval tick; an edit after approval clears
   it.
`test-rfq.mjs` proves both buttons, the suggestion, the contractor groups,
the auto-attach from a mocked Drive folder (match → list → subfolder; the
missing-class note), the two independent drafts, the read-only block, the
two separate sends with attachments, the record, the checklist tick, the
Register's last contact and the Register's direct email; `verify.mjs` covers
the library, the MIME, the scope, the 409 and the refusals.

## AI Engine (tile 07) and the Gradcon AI chat

Grady, 10 Oct 2026: "dont touch the existing app. rather create another
category called AI takeoff on the dashboard … compliance and specification
reader … let the api have access to all sections but must not be autonomous
except asked by me … more like a chat bot … visible on all user accounts upon
login and on the main dashboard". Rules:

1. **`portal/ai-engine.html` is its own app** (payload `__AIENGINE_B64__`,
   menu key `aiengine`), with its own storage — job index `gradcon-ai-jobs`,
   one row per job `gradcon-ai-job::<id>` (estimator_kv + a localStorage
   mirror, union-merged by `updatedAt`), PDFs in the `gradcon-files` bucket
   under `ai-engine/<jobId>/` (public URLs the model reads). It never reads a
   quote or a takeoff to write it. API calls go to `location.origin + "/api/…"`
   (`API_BASE`): the app runs from a blob: URL where a relative path fails.
   `AI_TYPES` MIRRORS the Estimates `LIBRARY` ids (`verify.mjs` fails on
   drift) — the model may only propose those types. Two job kinds: **takeoff**
   (drawings → `result.elements` in a generic shape: type, label, mark, sheet,
   qty, length/width/depth/height/diameter mm, area m², grade, cover, bars
   main/cross/top/ligatures/mesh, confidence, evidence, notes) and **spec**
   (standards by designation + family code, requirements by category and
   element, defaults — grade and cover per element bucket, exposure, reo
   grade, laps, minimum member sizes — and unusual items, every one with its
   page and quoted sentence). The model's `result` is kept as read; every edit
   and tick lands on `job.review` (`takeoffReviewFrom` / `specReviewFrom`), and
   `profileFromSpecJob` is the ONE reading of a ticked specification.
2. **The ONLY way anything leaves the AI Engine is Export** (`exportToEstimates`):
   a hand-off blob in `localStorage["gradcon-ai-handoff"]` + `gradcon:open-app
   estimates`. Estimates' `applyAiHandoff()` (end of boot, before
   `syncFromCloud`) makes a NEW takeoff through `newTakeoff()` — the open one is
   saved and untouched — maps each element with **`aiProposalToInstance`, the
   ONE mapping** onto the calculator's own fields (pier, pilecap, strip and pad
   footing, beam, slab, column, wall, retwall, stairs, kerb, generic; anything
   else keeps its defaults), seeds `PROJECT.standards` / grade / cover / spec
   and drawing revisions from the ticked profile, stamps `PROJECT.aiImport`
   and writes `gradcon-ai-handoff-result` back for the job. The index entry
   carries **`group: "ai"`**: `renderTakeoffsBar` and `renderProjectMenu` list
   those apart under "AI drafts — review before use", the cloud index merge
   keeps the group. Every element carries `data.__aiImport = {jobId, sheet,
   mark, confidence, evidence, notes}` and reads **"AI draft — verify"**
   (`elementStatus`; `fieldProvenance` treats it like `__csvImport`;
   `templateDataFrom` strips it).
3. **Server functions** (`api/ai-engine.js`, `vercel.json` maxDuration 300):
   POST `{action: "takeoff"|"spec", provider?, files:[{url,name}], types,
   projectName, profile}` → `runAiJob` validates (PDF https URLs only, ≤ 12
   files, the type list for a takeoff), resolves the provider, runs
   `callDocuments` (Claude: document URL blocks; OpenAI: Responses API
   `input_file`; DeepSeek: 501 "switch provider") with `takeoffPrompt` /
   `specPrompt`, reads the reply with `parseJsonLoose`. Same-origin check as
   `ai-providers`. Keys stay in `api/_providers.js`; `OPEN_AI_KEY` /
   `OPENAI_KEY` are accepted spellings of `OPENAI_API_KEY`.
4. **The provider is a Settings choice** (`aiProvider` in `gradcon-preferences`,
   per browser): Settings → AI providers shows "Use" per configured provider
   and "in use" on the one that applies, and the AI Engine header carries the
   same switch as pills (`#providerToggle`, `setPortalPref`); `resolveProviderId(requested, env)`
   honours it only when that provider has a key, else the server default.
   Every AI request from the browser passes `provider`.
5. **Gradcon AI chat** (`#ai-chat-fab` / `#ai-chat` in the shell; `show()` shows
   the button on every screen but login, for every account; no provider name
   in its header and no footer line, by request): `assistantContext()` (async)
   gathers EVERY section — what the browser holds first, then the cloud for
   what it never opened (`chatCloudData`, kept 5 min: the quotes index, the
   stamps, the summaries function for every project without a local copy, the
   takeoff index, the rates, the AI jobs — 10 Oct 2026, projects@'s browser had
   never opened Quotes and the chat saw no projects) — quotes summaries (name,
   client, status, deadline and days to it, elements, scope, pinned rates),
   takeoffs (elements, review status, AI drafts), rates validity, the Rates
   Library global block, Cost Planner projects, AI jobs — capped at ~60 kB and
   READ-ONLY; `api/ai-chat.js` (`runChat`, `chatSystem`, `callChat`) answers
   from it and may end with an `ACTIONS:` line that `parseReply` turns into at
   most three buttons (open an app / a project / a takeoff —
   `runChatAction`, never a write). **Nothing runs until the person clicks.**
   History is per tab (`sessionStorage` `gradcon-ai-chat`, 30 turns).
6. **The AI Engine mirrors the rest of the system** (`loadMirror` /
   `renderMirror`, Home → "What the system holds"): the Quotes projects
   (local mirrors, then the cloud index + stamps + the summaries function for
   the rest) and the Estimates takeoffs (local + cloud index), read-only,
   refreshed on demand and kept 5 min; a takeoff job's "Quotes project" select
   (`job.projectId` / `projectName`) names the job after the project and rides
   on the hand-off into `PROJECT.aiImport`.
7. **Quality checks** (`src/lib/qualityChecks.js`, pure, verify-covered;
   shipped to the browser as `dist/assets/gradcon-qa.js` = `window.GradconQA`
   by `vite.qa.config.js`, asserted by the assembler, fetched on demand like
   the 3D bundle): `runQualityChecks(quote, liveRates, {today, benchmarks})`
   is the DETERMINISTIC layer — unpriced subcontract quote rows (high), steel
   kg/m³ and formwork m²/m³ outside their bands, concrete against the recorded
   measures, duplicated / empty elements, crew days against the handover
   bands, rates past validity (read off the LIVE rates — a pinned copy never
   gains a date), pinned-rate drift with its $ impact, $/m² against the
   median of the submitted projects (`benchmarksFrom`), project fields,
   excluded scope money, the handover's own issues — every finding `{id,
   check, severity, itemId, element, message, evidence, fix}`. The AI Engine's
   Quality checks tab picks any project (Completed Estimating & quoting
   first), reads its row and the live rates from the cloud, benchmarks against
   the mirror's other summaries, stores the run as a `kind: "qa"` job with
   `acks` (ticked = reviewed, with when) and asks `api/ai-engine.js` action
   `qa` (`qaPrompt` → `callText`, plain prose) to explain the OPEN findings.
   Nothing on the project is written. The automatic run on Completed
   Estimating is still to come. **Takeoff mode's documents are both
   optional** (Grady, 11 Oct 2026: "i dont need the specification becoming a
   problem"): a takeoff alone runs; with no drawing reading
   `compareTakeoffToDocuments` compares nothing to the drawings and flags
   nothing as missing from them, with no specification it runs no spec
   check, and the takeoff's own completeness / sanity warnings are always
   listed as `takeoff-warning` findings (`summary.documents` says what was
   used).
8. **A cut-off reply is salvaged** (`salvageArrays` in `_providers.js`): every
   element / standard / requirement that closed before the output limit is
   kept and returned with `partial: {reason, kept, advice}`, which the job page
   shows as a banner; the prompts ask for compact JSON (no null keys, short
   evidence) so a full set fits (10 Oct 2026: a 6.7 MB preliminary set lost the
   whole run).
9. **Google mail** (`api/_google.js` — the ONE place Google credentials are
   handled; `api/google-auth.js` for status / start / callback / disconnect;
   `api/gmail.js` for list / read / attachment): Grady, 10 Oct 2026,
   "projects@gradcon.com.au and i want it read everything". OAuth client in
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (redirect URI
   `https://<host>/api/google-auth`, consent screen Internal to the Workspace,
   scope `gmail.readonly` only); only `allowedMailbox` (default
   projects@gradcon.com.au) may connect — any other account is revoked and
   refused. The refresh token lives in estimator_kv row `gradcon-google-mail`
   encrypted AES-256-GCM under `GOOGLE_TOKEN_SECRET` (default: the client
   secret), so the public anon key cannot use it; the OAuth state is an HMAC
   of the time, valid 10 minutes. `parseMessage` is the ONE reading of a Gmail
   message. Settings → Google mail connects / disconnects; the AI Engine's
   Mail tab searches and reads the mailbox and turns a PDF attachment into a
   takeoff or specification job (`api/gmail.js` copies it into the bucket
   under `ai-engine/mail/<messageId>/`); the chat's context gains `mail` (the
   newest 25 of 14 days, headers and snippets) through `mailForContext`, and a
   `mail` action opens that message in the Mail tab
   (`gradcon-ai-open-mail`). Read-only everywhere: nothing is sent, replied
   to or deleted.
10. **Automatic quantities** (`src/lib/aiQuantities.js`, pure, in the
   `gradcon-qa.js` bundle; Grady, 11 Oct 2026: "can we not have an estimator
   that can actually give the quantities automatically?"):
   `elementQuantities(el, calc)` turns a reviewed drawing element's geometry
   and bars into indicative concrete m³, steel kg (d²/162, `MESH_KG_M2`),
   formed m² and excavation m³ per calculator family — DETERMINISTIC, never
   a figure the model wrote; an element with no formula gives zeros and a
   note. The review table shows the three figures per row (`qtyCells` /
   `refreshQtyCells`, live on every edit) and `proposalTotals` under it,
   labelled geometry only. On export Estimates computes the exact lines and
   writes `quantities: {totals, perElement}` (concrete m³ of its Concrete
   lines, `steelKg`, `formworkTotals().m2`) into `gradcon-ai-handoff-result`,
   which the job's export banner shows as "Estimates computed".
11. **Geotech and contract readers** (job kinds `geotech` and `contract`,
   `geotechPrompt` / `contractPrompt` in `api/ai-engine.js`, `geotechReviewFrom`
   / `contractReviewFrom` and their renderers in the page): the geotech
   report's site conditions, constraints, implied allowances and missing
   items; the contract's responsibility matrix, obligations with money or
   risk, exclusions, suggested qualifications and risks — every item with
   page and quote, ticked for review. A takeoff job may pick a geotech job
   (`geoJobId`); `specProfileFor` folds its ticked items in as `profile.site`
   for the drawing reading. The drawing reading also returns `details`
   (plan callouts matched to the sheet that draws them, missing ones flagged)
   and `scales` (each sheet's stated scale against a measured dimension
   string), both model-read and shown under the elements.
12. **Roadmap tab** (`ROADMAP` in `ai-engine.html`): Grady's 10 Oct 2026
   specification as capability-group tabs, each item Live (with a link to
   where it runs) / Partial / Planned — the ONE place the plan is stated in
   the product; update an item's status in that array when it ships, never
   claim more.
`test-ai-engine.mjs` proves the tile, both job kinds with a mocked server,
the review edits, the export into AI drafts with the field mapping and the
profile, the chat on both accounts and the provider switch.

## Version history for the chat (what changed, who changed it)

Grady, 11 Oct 2026: "I want this chat to not have this limitation … i want to
monitor what Grady will input so we can collect data for future projects.
check for 145 Harrisons road and see changes". The copies already existed —
every Save, autosave and restore keeps a full immutable version
(`quote-versions/<projectId>/` from `lib/quoteVersions.js`,
`estimate-versions/<takeoffId>/` from Estimates' `keepEstimateVersion`) — what
was missing was a reader. Rules:

1. **`src/lib/quoteDiff.js` is the ONE diff** (pure, verify-covered):
   `diffQuotes(before, after, liveRates)` → project fields (status, client,
   scope, on-costs, planner, assumptions, rates pin, handover, the two report
   blobs as "edited"), elements added / removed / changed — on a changed
   element every `qtys` key, `rateOverrides` amount, crew cell (by task and
   resource NAME, keyed by `key`), additional row, label / scope / steel mode
   and the drawing count — with the element's direct cost before and after
   (`computeElementCost`, priced through `effectiveRates(after, liveRates)`
   so a pinned project reads off its pin) and the $ each band moved. An
   element added ABOVE the others is not "every other element moved": order
   is compared among the elements both copies hold. `handoverDrift(quote)`
   lays the handover's prefilled cells / rows / tonnages against what the
   sheet holds now — kept, changed (to what) or cleared — the record future
   bands are tuned from. `diffTakeoffs` does the same per instance for
   Estimates (`data` fields, label, type, review stamp, tags; `_`-flags and
   `results` ignored). `historyFromVersions(docs, kind, liveRates)` walks
   consecutive copies oldest → newest, counting unchanged steps;
   `describeDiff` renders the one-liners the chat is given.
2. **`api/_versions.js` are the chat's history tools** (read-only;
   `deps.cloud` = `{list, getJson, kvGet}` is the test seam): `list_versions`
   (both apps' file-name schemes through `parseVersionName`, `savedBy` read
   from the newest documents, the live row's `updated_at`), `compare_versions`
   (`from` / `to` = "live", "latest", "oldest", an index with 1 = newest, a
   date-time prefix, a path; defaults = the newest version → live; the quote
   diff is priced on the live `gradcon-rates` row), `project_history` (the
   newest N versions then the live row, with who saved each) and
   `handover_changes` (the drift off the live row). `api/ai-chat.js` offers
   them on EVERY call beside the mail tools (`HISTORY_TOOL_NAMES` routes the
   call) and `chatSystem` tells the model to CALL them rather than say it
   cannot see earlier values or who changed what. The anon key reads the
   bucket as any browser does; nothing is written. Older versions carry
   inline drawings (7 MB each on 145 Harrisons Rd), so a history walk is
   bounded (default 12, max 20, six fetches in flight; `api/ai-chat.js` runs up to 120 s). A model that ends a tool round with no prose is asked once more, tools withheld, for the written answer (`callChatWithTools`, `stopReason` in the reply).
3. **Every new version is stamped `savedBy`** — `signedInUser()` in
   `quoteVersions.js` and `portalSignedInUser()` in Estimates read the
   portal session (`gradcon-portal-session.currentUser`, shared localStorage
   under the blob: iframe) and `buildQuoteFile` / `keepEstimateVersion` write
   it (`null` outside the portal). Versions saved before 11 Oct 2026 carry
   none — the chat says "not recorded", never invents a person.
`test-saved-by.mjs` proves both apps stamp the account; `verify.mjs` covers
the diff, the drift, the takeoff diff, the history, every tool on a mock
cloud and the tool loop through `runChat`.

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
submitted, the days overdue should cease counting". **"Deadline Missed"**
(Grady, 9 Oct 2026: "in statuses, add deadline missed") is the closed
outcome for a tender date that passed with nothing submitted: it sits after
Unsuccessful in `QUOTE_STATUSES` (deep rose), is in `RATES_LOCKED_STATUSES`
(the figures stand as they were the day it was closed; `completedAt` is that
day) but NOT in `SUBMITTED_STATUSES` (no `submittedAt` is ever written);
`isDeadlineMissedStatus` / `missedLabel` in `planner.js` freeze its label to
"Deadline missed <deadline day>" (never "N d overdue") in both the Planner
and the Dashboard, and `isOverdue` / `isUrgent` treat it as finished work.
Reopening it (any open status) drops the pin like every other closed status.

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

**Project names follow ONE address convention** (Grady, 22 Oct 2026: "use
the API to rename the projects maintaining a proper convention, full address
and suburbs. when project is entered, the actual address convention should
automatically apply. where details are scanty, ask the user to select address
options"): `<number> <Street name> <Street type>, <Suburb> VIC <postcode>[ —
<descriptor>]`, e.g. "19 Paringa Road, Portsea VIC 3944 — Tennis Pavilion".
`src/lib/projectNaming.js` (pure, verify-covered): `isConventionName`,
`needsAddressReview(quote)` (a typed name not in the convention and not yet
reviewed — `nameReviewedFor`), `addressPrompt` / `parseAddressReply` (known
ids only, options that pass the convention only, confidence high / medium /
low; the prompt forbids inventing a street number and asks for up to three
suburbs when none is typed), `autoApplies` (ONE option at HIGH confidence),
`applyNamePatch` (projectName, `siteAddress` — the Drive folder match reads
it — `nameSource` = the FIRST typed name, kept through later renames,
`nameReviewedFor`), `keepNamePatch`, `requestProjectNames` → `api/ai-engine`
action **`address`** (up to 40 names per call). In the editor the name
field asks when it is LEFT (blur / Enter; `reviewProjectName` in App): a
confident single answer is applied at once with a note, anything less opens
`AddressOptions` under the field (radios, "Use this name", "Keep …", "Back
to … as typed" when the name was renamed before); the pin beside the name
(`project-name-address`) asks again on demand. The Dashboard's
**Standardise names** (`RenameProjectsModal`, badge = the count not yet in
the convention) sends every unconventional name in one request, shows the
proposal (a select when there are several) with a tick — ticked by default
only at high confidence — and ONE button renames the ticked ones through
`patchQuoteFields`. The project column is `min-w-[18rem]` and wraps.
`test-project-naming.mjs` proves both paths on a mocked provider.

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
  statement timeout (57014, measured 17 Sep 2026). **The function is asked a
  FEW keys per call** (`src/lib/summaryBatches.js`, pure, verify-covered —
  26 Oct 2026, Grady: "projects are missing on this deployment": a browser
  with no summary mirrors asked for all 25 projects in ONE call, the function
  ran 2.95 s against the anon role's 3 s statement timeout, PostgREST answered
  500, and the dashboard fell back to ~37 MB of one-by-one full-row reads,
  showing only the projects that browser had seen before until they
  finished): `collectSummaries(keys, {rpc, readRow, onPartial})` —
  `SUMMARIES_BATCH` = 3 keys per call (the 7 MB rows cost ~0.6 s each inside
  the function), `SUMMARIES_IN_FLIGHT` = 4 calls at once, a failed call
  retried one key at a time, a key the function still cannot give read
  through `readFullRowBounded`, a key that still fails in `failed` (never
  missing), and `onPartial({key: value})` after every landing — the Dashboard
  passes it through `readQuoteSummariesDetailed(keys, {onPartial})` and
  paints rows as they arrive. The portal shell's welcome panel / chat
  context and the AI Engine mirror call the same function through their own
  `summariesInBatches(keys)` (three keys, four in flight, per-key retry).
  Never post the whole key list to the function in one call again.
  `test-summaries-batches.mjs` runs the CLOUD build against a mocked
  PostgREST that refuses more than three keys with 500 / 57014 and proves the
  25 rows, the nine calls, no full-row read and the progressive paint. Those copies are stripped
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

- **Markup drawings live in the `gradcon-files` bucket, never in the row**
  (`lib/markupStore.js`, 9 Oct 2026: a nine-element project carried 17
  drawings inline — 7.46 MB of a 7.48 MB row — and every keystroke
  re-uploaded the lot, so saves queued, timed out and the editor said "not
  reaching the cloud" for minutes). A markup is `{id, name, type, rotation,
  path}` with `path` = `quote-markups/<projectId>/<markupId>.<png|jpg|pdf>`
  (public URL, like the Vault's files); `dataURL` is only the in-flight form
  — just dropped onto a card, or an install with no Supabase, which keeps it
  inline as before. `ProjectEditor` runs `offloadMarkups` (the ONE uploader)
  as soon as the row has settled and whenever an inline markup appears, then
  `applyOffload` drops the data URL only where the bytes still match what
  went up (a markup that failed waits a minute before the next try).
  `markupSrc(m)` is the ONE reading for every `<img>`/`<embed>` (card,
  lightbox, print report); `markupDataURL(m)` fetches the bytes back for the
  PDF converter. Nothing deletes a bucket object — versions, "Save to
  computer" files and duplicated elements all point at the same path. The
  summaries function's `dataURL` strip stays (harmless on a path).
  Verify-covered with a mock storage client.

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
4. **A cloud fetch that FAILS is never "nothing in the cloud"** (9 Oct 2026,
   145 Harrisons Road: the Quotes tab was uploading a 7.5 MB row, the
   Estimates fetch of the open takeoff timed out at 8 s, `syncFromCloud` read
   the `null` as "no row" and pushed the blank placeholder over an
   18-element takeoff — restored from its 06:58 autosave version). `kvFetch`
   answers one of THREE things: a row, `null` (the cloud answered: no row),
   or `KV_FETCH_FAILED` (`kvFetchFailed(row)`: timeout, offline, 5xx — nothing
   is known). On failure `syncFromCloud` leaves the tab unreconciled (so no
   push can leave it), keeps a placeholder held from autosave, and
   `scheduleCloudRetry` asks again in 15 s; only a positive "no row" seeds the
   cloud from local state. `pushTakeoffOnce` with no `__syncedAt` stamp (this
   tab never synced the key) looks first and never writes blind: a failed
   look is no write, and a blank snapshot never replaces a cloud copy that
   has elements (kept as a `cloud-kept` version instead). Every other
   `kvFetch` caller treats the sentinel as "no row" harmlessly (it has no
   `.value`). A fresh browser's workspace is a PLACEHOLDER until that first
   answer (`awaitingCloudLoad`): `saveEstimateState` through the auto path
   (`computeAllAndRefresh` fires it on boot and on every edit) never commits
   an empty, unnamed placeholder — before this the boot recompute wrote a
   blank blob locally and lifted the hold before the cloud was even asked.
   `test-cloud-fetch-fail.mjs` proves all of it with a mock cloud whose fetch
   fails first and succeeds later. **The Quotes hook has the same rule**
   (`useStoredState`, 5th return `loaded`): a row that cannot be read, with
   no last-known copy standing in, leaves the hook NOT loaded — no save can
   run, the read retries on the save back-off — and `ProjectEditor` shows
   "could not be loaded … writes nothing until it has loaded" instead of an
   editable blank quote that the next keystroke would save as the whole
   project. `test-quote-load-fail.mjs` proves it.

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
- **A pad footing can be reinforced with TRENCH MESH STRIPS that fill its plan
  area** (18 Oct 2026, Grady: "pad footings should also have option of trench
  mesh to fill the area specified"): the Bottom Mat and Top Mat "Reinforcement
  type" selects carry a third choice, "Trench mesh strips — fill the plan
  area" (`botReoType` / `topReoType` = `"trench"`, fields `<p>TrenchType`,
  `<p>TrenchWidth`, `<p>TrenchLayers`, `<p>TrenchLayerTypes`,
  `<p>TrenchEachWay`, `<p>TrenchLap`). `trenchFillSel` offers the L-series
  meshes and square-mesh strips only (straight bars do not fill an area);
  `trenchStripWidthMm(type, typed)` is the ONE strip width — a typed width,
  else (bars − 1) × 100 mm for an L-series mesh (3 bar = 200 … 8 bar = 700),
  else 300 mm for a mesh strip; `trenchFillRun` is the ONE arithmetic: whole
  strips across the clear width (ceil((W − 2c) ÷ width)), each the clear
  length (L − 2c), "each way" adding the second set, a round pad taking
  π(Ø − 2c)²/4 ÷ width. The line is lineal metres of the product (unit `lm`,
  `massPerUnit` from `trenchReoMassPerM`), so the Reinforcement Summary, the
  orders schedule (6 m stock) and the Quotes bridge treat it exactly like a
  strip footing's trench mesh; `padComponents` reads the choice. No clear
  area is a completeness warning. `test-pad-trench.mjs` proves it.
- **A card's fields column clips its own overflow** (`.pane-fields`, `flex:2 1
  280px; min-width:0; overflow-x:auto`, beside the `.diag-host` sketch — 18 Oct
  2026, Grady: "the delete elements is hidden under the sketch and
  unclickable"): a table wider than the column used to slide under the sketch
  box, which then swallowed the clicks on its tail. The Additional
  Connections table (`table.rows.extra-conn`) is kept narrow enough to fit
  beside the sketch. **Its target can be TYPED** (`targetSelect(…, allowManual)`
  adds "✎ Type a name…" = `MANUAL_TARGET`, which reveals `extraConn[i].targetName`;
  `extraConnTargetLabel(r)` is the ONE reading the line, the duplicate-target
  warning and the "typed target with no name" completeness warning use), so a
  bar can connect to an element that is not on the takeoff.
- **Starter bars are set out as RUNS on slabs too, and any additional bar row
  can be set out along a run** (18 Oct 2026, Grady: "still not gotten the
  starter or additional bars part right. i want to be able to enter a length
  the starter runs, the spacing etc."). The slab calculator's Connections tab
  (raft, ground, suspended, roof slabs) now carries the shared
  `starterRunsUI` / `starterRunLines` the footings, beams and composites use
  — bar, "At a spacing along the run" (run m ÷ spacing mm + 1 end bar × rows)
  or "Total number", embedment, projection, cog, cast / epoxy — with the
  default run = `slabPerimM(d)` (the ONE perimeter reading: typed override,
  sketched outline, else 2 × (L + W); the 5th `starterRunsUI` argument names
  it in the placeholder). A slab saved with the old single "Starter bars in
  from footing/wall below" count is migrated lazily by `starterRunsOf` into
  one run by total number, so it prices as before. **Additional Connections**
  rows carry `mode` ("count", the default, or "spacing" with `runM`,
  `spacing`, `rows`): `extraConnCount(r)` is the ONE bar count
  (`extraConnSetOut` the words on the line), a spacing row with no run prices
  nothing and is a completeness warning. **Additional Reinforcement /
  Elements** rows carry `runM` and `spacing` columns ("Run (m)", "@ (mm)"):
  `addlRowSetOut(r)` = run ÷ spacing + 1 when both are typed and
  `addlRowCount(r)` = that × the typed count (blank = one run), else the
  count — `addlRowQty`, `addlRowEach` and the compute formula all read it, so
  "N12 starters @400 over 12 m, 900 each" is 31 × 0.9 m without counting by
  hand. **A TYPED numeric box that rebuilds the card (`inpNumR`, or any
  `data-num` input with `data-rerender`) rebuilds on blur / Enter, never per
  keystroke** (same day, Grady: "entering run cell is too tight and doesnt
  allow me see what has been entered and also doesnt allow decimals"): the
  card's `input` handler stores and costs the value at once and marks the box
  `rerenderPending`; the `change` handler runs `rerenderCardKeepTab`. A
  per-keystroke rebuild threw the focus away and normalised "5." to "5".
  Selects and checkboxes still rebuild on the event. The Additional
  Connections set-out shows "= N bars" live through `refreshExtraConnCount`.
  `test-slab-starters.mjs` proves all three, the typed decimal and the fit.
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
- **A raft's extra edge / internal beam can start as a COPY of a beam
  already worked on** (11 Oct 2026, Grady: "RAFT edge or internal beam should
  have option to duplicate the beam already worked on rather than starting
  with a new beam"): the Edge Beams and Internal Beams tabs carry "⧉ Duplicate
  edge beam 1 (above)" beside "+ Add another" (only while that primary beam is
  switched on — `primaryBeamOn`) and every extra group's header carries
  "⧉ Duplicate this beam". `extraBeamGroupFromPrimary(d, arrName)` maps the
  primary beam's flat fields onto a group with the same mapping `computeSlab`
  prices it by; `duplicateExtraBeamGroup(g, idx, arr)` deep-copies a group.
  Both carry EVERYTHING — section, depth mode, cover, grade, bar sets, trench
  mesh layers, ligature zones, formwork, trench — except the run length,
  which is blanked: the runs ADD, so a copy that kept its run would buy the
  beam twice the moment it was added (a blank run prices nothing). Names go
  "<name> (copy)", "(copy 2)" … through `copyName`, never "(copy) (copy)".
  The `dupBeam` click action is next to `addRow` / `delRow`.
  `test-beam-dup.mjs` proves both tabs, the pricing once a run is typed and
  the independence of the copied bar sets.
- **Slab beam grades** (`slabBeamGrade(d, g, part)` is the ONE reading —
  26 Oct 2026, Grady: "raft beams concrete grade could be different from the
  slab grade"): an extra beam group's own `grade`, else the primary beam's
  own box on ITS tab (`edgeBeamGrade` on Edge Beams, `beamStripsGrade` on
  Internal Beams — `part` "edge" / "strips"; the box's label says what blank
  means), else the shared `beamGrade` on the Concrete tab (edge and wall
  thickenings read this one), else the slab `grade`; the slab line and the
  blinding keep their own grades, so the pour schedule separates the
  products. `test-raft-blinding.mjs` proves the three boxes and the
  fall-through.
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
- **Precast / tilt-up panels are measured like a SLAB** (26 Oct 2026,
  Grady: "for precast panels, i want to be able to enter areas manually and
  also allow sheet materials and all types of reinforcements etc, more like
  the slab entries"): `precastpanelmeasured` ("Precast / Tilt-up Panel
  (measured — total area, mesh, bars, edge forms)", group Precast / Tilt-up,
  `calc: "slab"`, `slabCategory: "Precast Panel"`, `suspended: true`,
  `precast: true`) sits beside the old supply-and-fix allowance, which is
  unchanged. `slabDefaults("Precast Panel")`: `manualArea` on (the area typed
  is the TOTAL of all panels), `qty` = the number of panels (Project
  Geometry's count), no soffit formwork (cast on a bed), no joints, every bar
  block on the "area covered × layers" method, no top mat by default; being
  suspended it never blinds, lays base or membrane, and its group is not a
  ground group, so it never digs. The Geometry tab carries the precast note
  (`precast-note`), the panel count and the relabelled area / edge-length
  boxes. **Edge forms**: `slabPerimM` with no typed edge length on a manual-
  area panel set assumes n equal SQUARE panels (4·√(A/n)·n) and
  `computeSlab` flags it (`precastPerimAssumed` — completeness) until the
  total edge length is typed as the perimeter override. **Bars**: the bar
  blocks stay usable under manual area on a panel (`precastBlk` /
  `precastCalc` — elsewhere a manual-area slab forces the sections table):
  the only Method is "By area covered × layers" and `areaBarGeom` reads a
  blank area as the whole panel area; sections, by-rate, by-area, mesh,
  additional rows, starters and connections all work as on a slab. **Sheets
  and trenches** (same day, Grady: "bar type should allow for sheets and
  trenches … for the precast panels"): the Mesh block is the sheets; the
  panel's Reinforcement tab also carries "Trench mesh / strips / stock bars
  along the panels" (`panelTrenchOn`, `panelTrenchType` through the shared
  `trenchMeshTypeSel`, `panelTrenchRunM` blank = the panels' edge length,
  `panelTrenchLayers`, `panelTrenchLap`) — one `part: "extra"` line per
  product (trench / strip lm through `trenchReoMassPerM` at the panel
  thickness, stock bars through `stockBarLayerLine`), kept under every
  reinforcement method. Whole-sheet counts carry a 1e-9 epsilon
  (100.8 ÷ 14.4 once rounded up to 8 sheets). The
  generic spacing sanity check skips `jointSpacing` (metres) — before this
  every slab and kerb carried "Unusually tight spacing of 6 mm". The library's
  `EST_WASTE_TYPES` and `DEFAULT_COVERS.slab["Precast Panel"]` = 30 carry the
  type; `test-precast-panel.mjs` proves the defaults, the concrete / mesh /
  bars, the assumed edge, the typed edge and the by-area method.
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
- **A raft's blinding is decided PER PART** (22 Oct 2026, Grady: "clearly
  differentiate blinding for beams internally and edge beams and then the
  overall slab. these elements should have their individual checkboxes …
  when lengths are entered, user should be able to enter the depth of
  blinding and width then this autofills the volume in the labour section"):
  the slab keeps `slabBlindOn` ("Concrete blinding under the SLAB"); the edge
  beam (`edgeBeamBlindOn` / `edgeBeamBlindWidth` / `edgeBeamBlindT` /
  `edgeBeamBlindGrade`), the internal beam strips (`beamStrips…`) and every
  extra beam group (`g.blindOn` / `blindWidth` / `blindT` / `blindGrade`)
  carry their own tick, width (blank = that beam's trench width) and
  thickness (blank = 50 mm) on their tabs, and `raftBeamGroupLinesInner`
  emits ONE Base/Blinding line per beam = run × width × thickness, named for
  the beam (`part: "beam"`), once its run length is entered. **The run
  lengths are asked for** (same day: "request user to enter the lengths of
  internal beams, edge beams etc during slab element populating"):
  `slabBeamsNeedingLength(d)` / `slabBeamLengthPrompt(d)` put an amber prompt
  on the slab's Geometry tab (`data-testid="beam-length-prompt"`) naming every
  beam switched on with no run and the tab its length is typed on, and
  `computeSlab` carries a completeness warning per such beam. **The bridge
  lands blinding concrete on the Quotes blinding row**: `estimateImport.js`
  maps every Base/Blinding m³ line whose material is blinding concrete / mud
  slab / lean-mix onto CONCRETE "Blinding concrete" (sand, crushed rock and
  compacted base stay flagged for a manual pick), so the crew sheet's Blinding
  row takes the m³. `test-raft-blinding.mjs` proves the prompt, the four
  ticks, each beam's volume and the untick; `verify.mjs` the bridge. (Grady
  works the same split on the Quotes card's BLINDING band — see the crew
  sheet notes; the two meet on the CONCRETE "Blinding concrete" row.)
- **Slab bars can be measured by AREA COVERED × LAYERS** (6 Oct 2026,
  Grady: "some slabs dont have proper bars designed … lets use the area
  covered and include also layer … i should be able to select more than a
  layer"): each slab bar block (botX / botY / topX / topY) has a third
  Method beside "By spacing" and "By bar count" — "By area covered ×
  layers" (`<prefix>Method: "area"`, `<prefix>Area` m², `<prefix>Layers`
  whole number, blank = 1, the block's own `<prefix>Spacing`). `barMode(d,
  prefix)` is the ONE reading of the select (no value = spacing, so older
  takeoffs are unchanged) and `areaBarGeom(d, prefix)` the ONE arithmetic:
  the bars are taken per 1 m × 1 m BLOCK and multiplied by the entered area
  (Grady, 8 Oct 2026: "i want the calculation in 1m blocks then multiplied
  by the entered area. add the extra bar to one side only for instance
  1/0.2 = 5+1 and for the other side, dont add the extra bar. sum them up
  and multiply by the manually entered area"): `areaBarsPerM(spMm, extra)`
  = 1000 ÷ spacing (+ 1 when `extra`), UNROUNDED (150 mm = 6.67 bars/m, a
  rate not a count), each bar 1 m long, so metres per m² = bars per metre;
  × area × layers. The END BAR IS COUNTED ON ONE SIDE ONLY: the X blocks
  carry it (1 ÷ 0.2 = 5 + 1 = 6 m/m²), the Y blocks never do (5 m/m²), so
  a mat on the X and Y blocks is 11 m/m². Waste and lap as for every bar
  line, the spec reads "(area covered, N layers)", the formula shows the
  per-m² figure. (For an hour on 8 Oct 2026 this counted floor(L ÷ s) + 1
  bars over the slab's L × W; replaced by the 1 m block at Grady's
  instruction.) A blank area in that
  mode is a completeness warning and no line, never a silent zero
  (`computeSlab` now returns its own `warnings`). The Method select
  rerenders the card so only the chosen mode's fields show.
- **A selected hook spans the section depth less the cover** (`hookLegOf` /
  `hookLeg` / `sectionDepthMm` / `instCoverMm` beside `anchorLen`; 8 Oct
  2026, Grady: "when a user selects hooks, hooks should span the depth of
  the section minus the concrete cover"): every hook the estimator picks in
  an `anchorSel` (90° / 135° / 180° on pad-footing, pile-cap, tankbox and
  shared starters, the extra-connections table, a pier cage's top / bottom
  anchorage, a beam's or slab beam group's main-bar start / end anchorage)
  is priced as the element's section depth − its cover, never a
  bar-diameter multiple. `sectionDepthMm(inst)` is the ONE reading of the
  depth per calculator: pier = diameter, pile cap = D, strip / pad footing /
  beam / generic = depth, slab = thickness, wall / shotcrete = thickness,
  retaining wall = footing depth (else stem), column = depth (diameter when
  round), box gutter = base thickness; a slab beam group passes its own
  section (`g.secDepthMm`) and cover (`cvr`) to `hookLegOf` directly. The
  cover is the element's typed cover, else `defaultCoverFor`. An element
  with no section depth (stairs, kerb, tank, composite, screed) keeps the
  12d / 10d / 8d development of `anchorLen`; couplers, cast-in starters,
  chemical anchors and custom lengths are unchanged. Each connection line's
  notes state "hook N mm = section D − cover c" (`hookNote`); the hook
  options are labelled "(section depth − cover)". Ligature fitment hooks
  (always 135°, 10d) and starter-run cogs (typed mm) are not selectable
  hooks and are untouched. `test-hook-depth.mjs` proves it.
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
  planArea)` is the ONE row arithmetic — the same 1 m block as the slab bar
  blocks above (`areaBarsPerM`): each way = (1 m ÷ spacing + 1) + (1 m ÷
  spacing) bars per m² (the end bar on the FIRST direction only — 6 + 5 =
  11 m/m² at 200), one way = (1 m ÷ spacing + 1) alone (6 m/m² at 200), ×
  the area (typed, or the element's plan area when blank). The row carries
  `perM2` and the `formula` the register line prints; N12 @200 each way
  over 50 m² is 550 m (until 8 Oct 2026 it was area ÷ spacing × 2 = 500 m). `applyReoArea` emits
  ONE line PER LAYER, replacing the detailed lines like the rate does; the
  table's metres cells refresh live. **A layer is one of five PRODUCTS**
  (26 Oct 2026, Grady, on the precast walls' table: "i need the sheets and
  trench mesh here and it is not visible"): `reoAreaProduct(v)` is the ONE
  reading of the row's `dia` and `reoAreaProductSel` the ONE select — a bar
  size (as before); a SHEET mesh (the mesh name: the area once per layer in
  whole sheets, `unit: "m²"`, `sheets`, spacing and layout ignored; the cell
  reads "128.0 m² (10 sh)"); an L-series trench mesh or a square mesh cut as
  strips (`strip:<mesh>`, 300 mm wide) laid at the spacing exactly as a bar
  is, in lm with `massPerUnit` from `trenchReoMassPerM`; or stock bars
  (`<n> Bar-N<d>`, n bars at every position, priced as plain bar). The
  register line, the hint and `out.reoRate.rows` carry `kind`, `label`,
  `unit` and (for sheets) `m2` / `sheets`. **Beam steel always counts**: every line
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
  Grady's "nope".) **Only the MAT is replaced** (8 Oct 2026, Grady: "i want
  the re entrant bar option available too whether slab is calculated by
  stock, volume or area. all other options available to slabs should be
  available too"): `isMatLine(l)` is the ONE test of what a rate / area
  method removes — a Reinforcement line that is neither `part:"beam"` nor
  `part:"extra"`. `computeSlab` tags its edge return / turn-down bars or
  strip and its re-entrant corner bars / strips / mesh pieces `part:"extra"`
  (and the wall-thickening trimmers `part:"beam"`), so they price under
  every method; `renderSlab` returns the mat (mesh + the four bar blocks) as
  `parts.reo` and everything else on the tab (edge return, re-entrant,
  joints & dowels, step-downs) as `parts.reoAlways`, which `buildCard`
  appends AFTER the method-gated block so it is visible and editable under
  "By rate" and "By area" too. `test-reo-extras-kept.mjs` proves it.
- **A bar size's total counts its steel from EVERY group** (8 Oct 2026, Grady:
  filtering N12 "the total should total the reinforcement, connections, etc"):
  `isBarSteelLine(l)` in `estimates-app.html` is the ONE test — every
  Reinforcement line, plus a Connections / Joints line that carries WEIGHT
  (starter bars, column starters, step and joint dowels are N12 / N16 bought
  from the same stock as the mat; a weightless line — "Drill & epoxy" holes,
  PVC waterstop, counted joints, chairs — is never steel) — and `steelKg(lines)`
  the ONE kg total built on it: the element head, group heads, the register
  totals tile, `bpTotalsOf` and the PDF all read it, so "kg reo" is one number
  everywhere. `summarizeReinforcement` folds those lines into `bars[size]`
  with a per-group split (`by`, printed by `barSplitStr` in an "Of which"
  column of both Reinforcement Summary tables only when a size came from more
  than one group) and counts steel entered by weight (an Additional "50 kg of
  N20" row) as kg with no metres. `estimates-orders.js` carries its own copy
  of the test (exported `isBarSteelLine`): `reinforcementByProduct` and
  `totalsOf` count the same lines and `procurementRuleFor` buys joint dowels
  in whole bar stock lengths. `lineWeightKg` now weighs the `Joints` group
  too (before this, joint dowels weighed 0 kg in every total while their
  notes said otherwise). The kg/m³ · kg/m² rate hint of the by-rate / by-area
  methods stays on the mat (a design ratio); the kg/m³ SANITY check and the
  Materials Summary's "All reinforcing steel" strip (`steelByGroup` /
  `steelSummaryStrip`, also in the summary CSV) count every bar in the pour
  — Grady, 11 Oct 2026: "reinforcment summing in estimates should include
  those of the connectors". The Quotes bridge
  already priced Reinforcement + Connections + Joints bars together on
  PROCESSED BAR, so Estimates now agrees with what Quotes charges.
  `test-steel-across-groups.mjs` proves it; `verify-estimates.mjs` covers the
  module.
- **Every calculator with a natural area publishes it** (`_autoAreaM2`,
  deleted by `computeInstance` before each compute and read FIRST by
  `autoGeometry`): a wall's face net of openings, a shotcrete face, a
  retaining-wall stem face (the base footprint when only the base is priced),
  a box gutter's plan footprint (external width × run), a composite's slab
  parts. Before 6 Oct 2026 those elements reached Quotes with no m², so their
  cards showed no $/m².

## Estimates standards profile, allowances and review gate (Phase 4)

- **The generic calculator measures three ways** (26 Oct 2026, Grady: "it
  should also have option to input area manually not just volume"): qty × L ×
  W × depth, a typed TOTAL area × the depth (`manualArea` / `areaOverride`,
  the formula says so and the area becomes `_autoAreaM2` for Project
  Geometry), or a typed volume (`manualVolume` wins over a typed area). Every
  generic kind — excavation, alteration, temporary, the precast allowance,
  civil — has both boxes. **Its reinforcement is one of three products**
  (same day, Grady: "bar type should allow for sheets and trenches"):
  `reoType` "bar" (straight bar by total length, as before), "mesh" (sheet
  mesh by area × layers in whole 6.0 × 2.4 m sheets — `reoMeshType`,
  `reoArea` blank = the element's own area, `reoLayers`) or "trench" (the
  shared `trenchMeshTypeSel` — an L-series mesh, a square-mesh strip or
  straight stock bars — by `reoLength` metres of run × layers, priced as the
  footing's trench layer is: `trenchReoMassPerM`, or `stockBarLayerLine` for
  bars). **Its m³ IS concrete on a precast or civil item** (26 Oct 2026,
  Grady, on a Precast Walls allowance with 128 m² typed: "concrete is not
  calculated, check all other calculations are correct"): the volume line
  goes under the `Concrete` group as "N<grade> concrete" (the Concrete tab's
  grade, seeded `PROJECT.grade`; the type's name rides in the spec), with the
  concrete waste class, so the element head, the by-rate / by-area steel
  hints and the kg/m³ check, the pour schedule and the Quotes bridge all
  count it — before this the precast kinds sat under a "Precast" group and
  the civil kinds carried the type's label as their material, so no grade
  could be read. Excavation, alteration and temporary-works allowances keep
  their own groups (an allowance, not a pour; the Concrete tab's note says
  which). A typed bar COUNT multiplies the bar length (the "Qty" box was
  shown and never read). `test-generic-area.mjs` proves the three bases, the
  three products, the concrete on a precast and a civil item, the excavation
  staying out and the bar count.
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

- **Colour schemes** (Grady, 22 Oct 2026: "change the quotes colour theme to
  that of the rates library with options in settings to change the colour
  scheme"): the components keep the Tailwind classes below; `index.css`
  re-colours the chrome (`blue-9xx`) and accent (`orange-*`) utilities under
  `html[data-theme]` — `portal` (the DEFAULT since 23 Oct 2026 — Grady:
  "change the default quotes colour to the uploaded. background and accent,
  etc": the portal shell's own palette, #fafafa page, #231f20 charcoal
  chrome, the #d5de5d lime accent, Inter), `library` (the Rates Library's
  navy #0f2e4c / #1F4E78, #2f7fd6 accent, #eef2f6 page, Segoe UI), `classic`
  (the blueprint navy & orange, no overrides), `graphite` (charcoal &
  emerald). **A light accent needs three tokens of its own**: `accentInk`
  (the text on `bg-orange-600 / -500` buttons — dark #1c1c1c on the lime,
  white on the other three), `accentText` (`text-orange-600` money figures on
  white — a dark olive #6b7416 on the portal scheme, the accent itself
  elsewhere) and `accentHover` (`hover:bg-orange-700` — #c6d045 on the lime
  so the dark ink stays readable). index.css maps exactly those classes to
  them; every other orange utility still follows the accent shades.
  `verify.mjs` pins the portal values, the white ink on the older schemes and
  the three mappings.
  `applyQuotesTheme` / `readQuotesTheme` in App.jsx read the portal
  preference `quotesTheme` (Settings → App behaviour → "Quotes colour
  scheme") on mount and on every Settings save (the `storage` event reaches
  the blob: frame), so a change shows at once. A new chrome / accent utility
  class needs its override line in `index.css` or it stays orange / navy
  under every scheme. **Every colour is a named TOKEN** (Grady, same day:
  "the settings to change the colours and themes should get up to macro
  level so basically everything could be individually changed"):
  `src/lib/quoteTheme.js` — `THEME_TOKENS` (29: the chrome and accent shades, the ink / text / hover trio above,
  the five dark BANDS — labour sheet, labour header, Project Geometry,
  summary rail / grand total, category headers — and the page), `PRESETS`
  (every preset values every token; classic = Tailwind's own values),
  `resolveTheme(prefs)` = preset + `prefs.quotesThemeColors` ({token key:
  "#rrggbb"}, a bad value ignored, a value equal to the preset not an
  override) and `applyTheme(root, theme)` (data-theme + every `--t-*`
  custom property inline on <html>). The components tag their dark bands
  `data-band="summary|category|labour|labour-head|geometry"` and index.css
  maps each to its token, so the element lists, rails and bands follow the
  scheme. Settings → "Every colour, one by one" renders a picker per token
  from the shell's JSON mirrors `QUOTE_THEME_TOKENS` / `QUOTE_THEME_PRESETS`
  (verify.mjs fails on drift) with ↺ per token and "Reset all to the
  scheme". `test-quotes-theme.mjs` proves the three presets and the
  overrides.
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
