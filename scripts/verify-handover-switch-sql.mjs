#!/usr/bin/env node
/**
 * Runs supabase/migrations/0005_estimator_kv_keep_handover_switch.sql in an
 * ISOLATED, in-process Postgres (PGlite — nothing touches the live project)
 * and proves what the migration header promises: a project's crew-prefill
 * switch survives a whole-row save from an older build, and nothing else in
 * any row is ever changed.
 *     npm i --no-save @electric-sql/pglite && node scripts/verify-handover-switch-sql.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); }
catch { console.log("SKIP: @electric-sql/pglite is not installed (npm i --no-save @electric-sql/pglite)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = (f) => fs.readFileSync(path.join(here, "..", "supabase", "migrations", f), "utf8");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec(sql("0001_estimator_kv.sql"));
await db.exec(sql("0003_estimator_kv_merge.sql"));
await db.exec(sql("0005_estimator_kv_keep_handover_switch.sql"));
await db.exec(sql("0005_estimator_kv_keep_handover_switch.sql")); // installing twice is harmless

// The app's own save: PostgREST upsert = INSERT … ON CONFLICT (key) DO UPDATE.
const upsert = (key, value) => db.query(
  `insert into public.estimator_kv (key, value, updated_at) values ($1, $2::jsonb, now())
   on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`, [key, JSON.stringify(value)]);
const read = async (key) => (await db.query(`select value from public.estimator_kv where key = $1`, [key])).rows[0]?.value;

const K = "gradcon-quote-test1";
const base = { projectName: "41 Test Road", status: "Estimating", items: [{ id: "a", qtys: { "CONCRETE|N32|m3": 12.5, blank: "" }, tasks: [{ id: "t", name: "Pour concrete", cells: { concreter_day: 4 } }] }], overheadPct: 0.08 };

await upsert(K, base);
check("a project that was never stamped is stored exactly as sent", canon(await read(K)) === canon(base));
await upsert(K, { ...base, projectName: "41 Test Road, Portsea" });
check("… and an older build's save of it changes nothing either (no switch to keep)", canon(await read(K)) === canon({ ...base, projectName: "41 Test Road, Portsea" }));

// The current build stamps the project.
const stamped = { ...base, handoverLive: false, handoverMode: "live", handover: { rules: 2, cells: {} } };
await upsert(K, stamped);
check("the current build's stamp is stored as sent", canon(await read(K)) === canon(stamped));

// A tab on an older build saves its stale copy: no handoverMode, handoverLive unset.
const stale = { ...base, items: [{ ...base.items[0], tasks: [{ id: "t", name: "Pour concrete", cells: { concreter_day: 4, excavator_day: 1 } }] }], handover: { cells: { x: 1 } } };
await upsert(K, stale);
let v = await read(K);
check("an older build's save keeps the switch: handoverMode carried, handoverLive held false", v.handoverMode === "live" && v.handoverLive === false);
check("… and every other field is exactly what that tab sent", canon({ ...v, handoverMode: undefined, handoverLive: undefined }) === canon({ ...stale, handoverMode: undefined, handoverLive: undefined }) && canon(v.items) === canon(stale.items) && canon(v.handover) === canon(stale.handover));

// An older build that had handoverLive: true in memory (it pressed "Turn live prefill on").
await upsert(K, { ...stale, handoverLive: true });
v = await read(K);
check("an older build cannot switch its own re-planning back on", v.handoverMode === "live" && v.handoverLive === false);

// The current build's own writes pass through untouched.
await upsert(K, { ...stamped, handoverLive: false, handoverMode: "off" });
v = await read(K);
check("Undo from the current build (mode off) is stored as sent", v.handoverMode === "off" && v.handoverLive === false);
await upsert(K, stale);
v = await read(K);
check("… and an older build's save then keeps it OFF, never back to live", v.handoverMode === "off" && v.handoverLive === false);
await upsert(K, { ...stamped });
check("the current build turns it on again", (await read(K)).handoverMode === "live");

// A value that turned the prefill off the old way (a restored version, an old Undo) is left alone.
const legacyOff = { ...base, handoverLive: false };
await upsert(K, legacyOff);
v = await read(K);
check("a value with handoverLive:false and no mode is stored as sent (prefill stays off)", !("handoverMode" in v) && v.handoverLive === false && canon(v) === canon(legacyOff));

// The field-level merge the Dashboard uses.
await upsert(K, stamped);
await db.query(`select public.estimator_kv_merge($1, $2::jsonb)`, [K, JSON.stringify({ status: "Quoting" })]);
v = await read(K);
check("the Dashboard's field merge is unaffected", v.status === "Quoting" && v.handoverMode === "live" && canon({ ...v, status: "Estimating" }) === canon(stamped));

// Rows that are not projects are never looked at.
await upsert("gradcon-rates", { handoverMode: "live", a: 1 });
await upsert("gradcon-rates", { a: 2 });
check("a row that is not a project is never touched", canon(await read("gradcon-rates")) === canon({ a: 2 }));
await upsert("gradcon-quote-arr", [1, 2]);
await upsert("gradcon-quote-arr", { x: 1 });
await upsert("gradcon-quote-arr", [3]);
check("non-object values on a project key pass through", canon(await read("gradcon-quote-arr")) === canon([3]));

// A storm: two older tabs alternating saves after one stamp — the switch holds through all of them.
await upsert(K, stamped);
let held = true;
for (let i = 0; i < 200; i++) {
  await upsert(K, { ...stale, n: i, items: i % 2 ? stale.items : base.items });
  const r = await read(K);
  if (!(r.handoverMode === "live" && r.handoverLive === false && r.n === i)) held = false;
}
check("200 alternating saves from two older tabs: the switch holds every time, their content stored each time", held);

// A big row (inline drawings) keeps its bytes.
const big = { ...stale, items: [{ id: "b", markups: [{ id: "m", dataURL: "data:image/png;base64," + "Q".repeat(3_000_000) }] }] };
await upsert(K, big);
v = await read(K);
check("a 3 MB row keeps every byte", v.items[0].markups[0].dataURL.length === big.items[0].markups[0].dataURL.length && v.handoverMode === "live");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
