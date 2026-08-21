# Gradcon Estimator

A concrete-subcontract estimating tool: pick a structural element (piling,
footings, walls, slabs, etc.) from a dropdown, the full Gradcon material,
reinforcement, formwork and labour catalog for that element rolls out
below it, fill in the quantities that apply, and everything rolls up live
into a quote — element total → section subtotal → grand total → margin
ladder with GST.

## Running it

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev
```

Then open the URL it prints (usually `http://localhost:5173`).

For a production build:

```bash
npm run build
npm run preview   # serves the built app locally to check it
```

## Editing with Claude Code

This project has a **`CLAUDE.md`** file at the root written specifically
so Claude Code (or any coding assistant) can safely make changes without
breaking the costing math — it documents the pricing rules, the
architecture, and a Node-runnable regression check (`npm run verify`)
that catches the kinds of mistakes that don't throw an error but do
produce a wrong quote. Point Claude Code at this folder and it'll pick
`CLAUDE.md` up automatically.

## Data persistence

Your quote and any rate edits are saved automatically to your browser's
local storage as you work — no login, no server. That also means it's
**per-browser**: it won't sync between your desktop and laptop, and it
won't be visible to anyone else opening the app on a different machine.
If you need shared, multi-user access (e.g. you and Grady editing the
same live quote), that requires adding a real backend — see the "Known
limitations" section of `CLAUDE.md` for what that would involve.

## Project layout

```
src/data/catalog.js     the material/labour catalog and element-type list — edit prices/products here
src/lib/costing.js       the costing formulas — read CLAUDE.md before touching this
src/lib/storage.js        localStorage persistence
src/components/            UI
src/App.jsx                    top-level page
scripts/verify.mjs             run with `npm run verify` — regression checks for the costing engine
```
