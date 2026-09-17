#!/usr/bin/env node
/**
 * Runs supabase/migrations/0004_estimator_kv_quote_summaries.sql in an
 * ISOLATED, in-process Postgres (PGlite — WASM Postgres, nothing touches the
 * live project) and proves what the migration header promises:
 *   - read-only (STABLE) and SECURITY INVOKER, executable by anon;
 *   - returns only the requested keys;
 *   - every value comes back identical except items[*].markups[*].dataURL —
 *     blanks, zeroes, decimals, array order, unknown fields, non-object
 *     values and non-array `items`/`markups` all survive untouched;
 *   - the caller's row-level security applies (no policy → no rows);
 *   - no stored row changes (value text, updated_at and xmin compared).
 *
 * Not part of `npm run verify` because it needs the optional
 * @electric-sql/pglite package:
 *     npm i --no-save @electric-sql/pglite && node scripts/verify-summaries-sql.mjs
 * Optional: FIXTURE=/path/to/a/backup/estimator_kv/<row>.json measures the
 * size reduction on a real project row (kept private, never committed).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("SKIP: @electric-sql/pglite is not installed (npm i --no-save @electric-sql/pglite)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = (f) => fs.readFileSync(path.join(here, "..", "supabase", "migrations", f), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// The client-side rule the function must reproduce exactly (src/lib/projects.js → stripForSummary).
const expectedSummary = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Array.isArray(v.items)) return v;
  return { ...v, items: v.items.map((it) => (it && typeof it === "object" && !Array.isArray(it) && Array.isArray(it.markups)
    ? { ...it, markups: it.markups.map((m) => { if (!m || typeof m !== "object" || Array.isArray(m)) return m; const { dataURL, ...rest } = m; return rest; }) }
    : it)) };
};
// jsonb does not keep object key order, so compare with sorted keys (array order is kept and compared).
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec(sql("0001_estimator_kv.sql"));
await db.exec(`grant usage on schema public to anon, authenticated; grant select, insert, update, delete on public.estimator_kv to anon, authenticated;`);

const DRAWING = "data:image/png;base64," + "Q".repeat(200000);
const rows = {
  "gradcon-quote-a": {
    projectName: "Alpha", status: "Queued", clientName: "", gfa: 0, date: "2026-09-01", margin: 0.25, notes: null,
    unknownTopLevel: { keep: [1, 2.50, "x", null, false] },
    items: [
      { id: "i1", label: "Strip Footings", qtys: { "CONCRETE|N25|m3": 12.75, "FORMWORK|Edge|m": 0, blank: "" }, tasks: [], additional: [], mystery: "keep me",
        markups: [{ id: "m1", name: "S3.png", type: "image", dataURL: DRAWING, rotation: 90 }, { id: "m2", name: "note", dataURL: "data:image/png;base64,AAA" }] },
      { id: "i2", label: "No markups key", qtys: {} },
      { id: "i3", label: "markups null", markups: null },
      { id: "i4", label: "markups not an array", markups: { dataURL: "keep-this-it-is-not-in-an-array" } },
      { id: "i5", label: "mixed markup entries", markups: [null, "str", 3, { dataURL: DRAWING }, { noImage: true }] },
      null, "a bare string item", 7,
    ],
  },
  "gradcon-quote-b": { projectName: "Beta", items: "not an array", markups: [{ dataURL: "top-level-not-under-items" }] },
  "gradcon-quote-c": { projectName: "Gamma", items: [] },
  "gradcon-projects": [{ id: "a", storageKey: "gradcon-quote-a" }, { id: "b" }],
  "gradcon-rates": { "CONCRETE|N25|m3": { unitCost: 260.5 } },
  "gradcon-quote-scalar": 42,
};
for (const [k, v] of Object.entries(rows)) await db.query(`insert into public.estimator_kv(key, value, updated_at) values ($1, $2::jsonb, '2026-09-10T01:02:03.456Z')`, [k, JSON.stringify(v)]);
if (process.env.FIXTURE) {
  const fx = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
  rows[fx.key] = fx.value;
  await db.query(`insert into public.estimator_kv(key, value, updated_at) values ($1, $2::jsonb, $3)`, [fx.key, JSON.stringify(fx.value), fx.updated_at]);
}

const before = (await db.query(`select key, value::text as v, updated_at::text as u, xmin::text as x from public.estimator_kv order by key`)).rows;

await db.exec(sql("0004_estimator_kv_quote_summaries.sql"));

const meta = (await db.query(`select provolatile, prosecdef, has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where proname = 'estimator_kv_quote_summaries'`)).rows;
check("function exists once with (p_keys text[])", meta.length === 1 && meta[0].args === "p_keys text[]", JSON.stringify(meta));
check("STABLE (read-only) and SECURITY INVOKER", meta[0].provolatile === "s" && meta[0].prosecdef === false, JSON.stringify(meta[0]));
check("executable by anon and authenticated", meta[0].anon_exec === true && meta[0].auth_exec === true);

const KEYS = ["gradcon-quote-a", "gradcon-quote-b", "gradcon-quote-c", "gradcon-projects", "gradcon-rates", "gradcon-quote-scalar", "gradcon-quote-does-not-exist"];
if (process.env.FIXTURE) KEYS.push(JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8")).key);
await db.exec(`set role anon`);
const t0 = Date.now();
const out = (await db.query(`select key, value, updated_at::text as updated_at from public.estimator_kv_quote_summaries($1::text[]) order by key`, [KEYS])).rows;
const ms = Date.now() - t0;
await db.exec(`reset role`);
check("returns exactly the requested existing keys (no phantom row for a missing key, nothing extra)", out.map((r) => r.key).sort().join() === KEYS.filter((k) => k in rows).sort().join(), out.map((r) => r.key).join());
for (const r of out) {
  const exp = expectedSummary(rows[r.key]);
  check(`value for ${r.key} equals the client-side strip (only markups[*].dataURL removed)`, canon(r.value) === canon(exp), canon(r.value).slice(0, 160));
  check(`updated_at for ${r.key} is the stored one`, r.updated_at.startsWith("2026-09-10 01:02:03.456") || !!process.env.FIXTURE, r.updated_at);
}
const a = out.find((r) => r.key === "gradcon-quote-a").value;
check("drawing bytes are gone from the summary", !JSON.stringify(a).includes("QQQQQQQQ") && !("dataURL" in a.items[0].markups[0]) && !("dataURL" in a.items[4].markups[3]));
check("other markup fields, item order, blanks, zeroes, decimals and unknown fields survive", a.items[0].markups[0].rotation === 90 && a.items[0].markups[1].name === "note" && a.items[0].qtys["CONCRETE|N25|m3"] === 12.75 && a.items[0].qtys["FORMWORK|Edge|m"] === 0 && a.items[0].qtys.blank === "" && a.items[0].mystery === "keep me" && a.items[5] === null && a.items[6] === "a bare string item" && a.items[7] === 7 && a.unknownTopLevel.keep[1] === 2.5 && a.gfa === 0 && a.clientName === "" && a.notes === null);
check("a dataURL that is not under items[*].markups[] is left alone", out.find((r) => r.key === "gradcon-quote-b").value.markups[0].dataURL === "top-level-not-under-items" && a.items[3].markups.dataURL === "keep-this-it-is-not-in-an-array");
if (process.env.FIXTURE) {
  const fx = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
  const full = JSON.stringify(fx.value).length, summ = JSON.stringify(out.find((r) => r.key === fx.key).value).length;
  console.log(`  real row ${fx.key}: full ${full} bytes → summary ${summ} bytes (${(100 * summ / full).toFixed(2)} %), function call ${ms} ms in WASM Postgres`);
  check("real row: summary is under 5 % of the full row", summ < full * 0.05);
}

// RLS applies to the caller: without the anon policy, anon sees nothing through the function.
await db.exec(`drop policy "anon read/write" on public.estimator_kv`);
await db.exec(`set role anon`);
const none = (await db.query(`select key from public.estimator_kv_quote_summaries($1::text[])`, [KEYS])).rows;
await db.exec(`reset role`);
check("row-level security is the caller's: with no policy the function returns no rows", none.length === 0, `${none.length} rows`);
await db.exec(`create policy "anon read/write" on public.estimator_kv for all to anon using (true) with check (true)`);

const after = (await db.query(`select key, value::text as v, updated_at::text as u, xmin::text as x from public.estimator_kv order by key`)).rows;
check("no stored row changed (value, updated_at, xmin identical before and after)", JSON.stringify(before) === JSON.stringify(after));
await db.exec(sql("0004_estimator_kv_quote_summaries.sql"));
check("migration is idempotent (create or replace runs again cleanly)", true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
