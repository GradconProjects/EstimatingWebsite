#!/usr/bin/env node
/**
 * Estimates data-safety checks — `npm run verify:estimates` (also part of
 * `npm run verify`). Plain Node, no browser: portal/estimates-schema.js is
 * the same file the app inlines, loaded here as CommonJS.
 *
 * Fixtures in tests/fixtures/estimates/ are REAL takeoffs exported from the
 * cloud rows on 8 Sep 2026 (pre-redesign), plus synthetic legacy shapes.
 * Every check here is a promise to the estimator: nothing they entered can
 * change meaning through a migration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The package is "type": "module", so Node treats the .js file as ESM and its
// CommonJS export never runs; evaluate it as a plain script instead — exactly
// how the browser runs it once inlined — and take the API off globalThis.
import vm from "node:vm";
const schemaSrc = fs.readFileSync(path.join(root, "portal", "estimates-schema.js"), "utf8");
const sandbox = { globalThis: undefined, module: undefined };
sandbox.globalThis = sandbox;
vm.runInNewContext(schemaSrc, sandbox, { filename: "estimates-schema.js" });
const schema = sandbox;
const {
  ESTIMATE_SCHEMA_VERSION, snapshotVersion, migrateEstimateSnapshot, isMigrated,
  collectRawAppKeys, buildRawBackup, checksumOf, ensurePreMigrationBackup, listPreMigrationBackups,
  PRE_MIGRATION_PREFIX, PRE_MIGRATION_DONE_KEY,
} = schema;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Sorted-key JSON so field order cannot masquerade as a difference. */
const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === "object" && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, kk) => { o[kk] = val[kk]; return o; }, {}) : val);

console.log(`\nEstimates schema v${ESTIMATE_SCHEMA_VERSION} — migration & backup checks\n`);

/* ---- 1. real legacy fixtures: every value intact ---- */
const fixDir = path.join(root, "tests", "fixtures", "estimates");
const fixtures = fs.readdirSync(fixDir).filter((f) => f.endsWith(".json")).sort();
check("fixtures present", fixtures.length >= 3, `${fixtures.length} found`);
for (const f of fixtures) {
  const raw = JSON.parse(fs.readFileSync(path.join(fixDir, f), "utf8"));
  const rawCanon = canon(raw);
  const v = snapshotVersion(raw);
  const m = migrateEstimateSnapshot(raw);
  const list = m.INSTANCES || m.instances;
  const rawList = raw.INSTANCES || raw.instances;
  check(`${f}: read as schema v${v}, migrated to v${ESTIMATE_SCHEMA_VERSION}`, v === 1 && isMigrated(m));
  check(`${f}: the raw object was not mutated`, canon(raw) === rawCanon);
  check(`${f}: element count intact (${rawList.length})`, list.length === rawList.length);
  check(`${f}: every element's id, type, label and data deep-equal the original`, rawList.every((inst, i) => deepEqual(inst.data, list[i].data) && inst.id === list[i].id && inst.typeKey === list[i].typeKey && inst.label === list[i].label));
  check(`${f}: project object deep-equals the original`, deepEqual(raw.PROJECT || raw.project, m.PROJECT || m.project));
  check(`${f}: migration is idempotent`, canon(migrateEstimateSnapshot(m)) === canon({ ...m }));
  // unknown fields (the export metadata I added, and anything future) survive
  const unknownKeys = Object.keys(raw).filter((k) => !["PROJECT", "SELECTED_TYPES", "INSTANCES", "ID_COUNTER", "UPLOADED_FILES", "project", "selectedTypes", "instances", "idCounter"].includes(k));
  check(`${f}: unknown top-level fields survive (${unknownKeys.length})`, unknownKeys.every((k) => deepEqual(raw[k], m[k])));
}

/* ---- 2. blank vs zero, units, and legacy starter shapes ---- */
{
  const raw = { project: { name: "Blank vs zero" }, selectedTypes: {}, idCounter: 3, instances: [
    { id: "EL01", typeKey: "stripfooting", label: "SF1", data: { qty: 1, length: 10000, width: "", depth: 0, cover: "", starters: true, connQty: 3, connDia: "N16", connEmbed: 500, connProj: 600 } },
    { id: "EL02", typeKey: "slab", label: "Raft", data: { length: 25, width: 12, thickness: 200, connMode: "spacing", connSpacing: 400, connRows: 2 } },
  ] };
  const m = migrateEstimateSnapshot(raw);
  const d = m.instances[0].data;
  check("blank stays blank (width '')", d.width === "");
  check("zero stays zero (depth 0)", d.depth === 0);
  check("blank cover stays blank (project default applies at run time, not in storage)", d.cover === "");
  check("lengths stay in millimetres (10000 not 10)", d.length === 10000);
  check("slab plan dims stay in metres (25 × 12)", m.instances[1].data.length === 25 && m.instances[1].data.width === 12);
  check("legacy starter count fields untouched (the app migrates them lazily at render)", d.starters === true && d.connQty === 3 && d.starterRuns === undefined);
  check("interim connMode/spacing fields untouched", m.instances[1].data.connMode === "spacing" && m.instances[1].data.connRows === 2);
}

/* ---- 3. structure repair, never value invention ---- */
{
  const m = migrateEstimateSnapshot({ instances: [{ id: "EL01", typeKey: "pier", label: "P1" }, null, { typeKey: "slab", data: { thickness: 150 } }] });
  check("missing project/selectedTypes containers are added empty", deepEqual(m.project, {}) && deepEqual(m.selectedTypes, {}));
  check("an element without data gets an empty data container (not defaults)", deepEqual(m.instances[0].data, {}));
  check("a null element slot is dropped, real ones kept", m.instances.length === 2 && m.instances[1].data.thickness === 150);
  check("an element without an id gets a positional one", m.instances[1].id === "EL03");
  check("idCounter is derived only when missing/invalid", m.idCounter === 3);
  check("migratedFrom records the source version", m.migratedFrom === 1);
  const again = migrateEstimateSnapshot(m);
  check("second migration leaves migratedFrom as the ORIGINAL version", again.migratedFrom === 1 && again.schemaVersion === ESTIMATE_SCHEMA_VERSION);
}

/* ---- 3b. Phase 3/4 fields ride through untouched ---- */
{
  const raw = { schemaVersion: 2, project: { name: "P4", standards: { projectType: "civil", standards: ["as3600", "as5100"], nccEdition: "NCC 2022 Amdt 1", checks: { reoMaxKgM3: 250 } }, reviewAck: { name: "G", role: "QS", at: "2026-09-09 08:00", hash: "abcd1234" } }, selectedTypes: {}, idCounter: 2, instances: [
    { id: "EL01", typeKey: "padfooting", label: "F1", data: { length: 600, allowOverbreakPct: 10, allowPlacement: "pump", allowPumpHours: 4 }, tags: { level: "L1", pour: "P2" }, entered: { length: true }, review: { hash: "x", at: "t" }, scope: { membrane: { decision: "excluded", reason: "by others" } } },
  ] };
  const m = migrateEstimateSnapshot(raw);
  check("standards profile, review acknowledgement, tags, entered, review and scope survive migration untouched", deepEqual(m.project.standards, raw.project.standards) && deepEqual(m.project.reviewAck, raw.project.reviewAck) && deepEqual(m.instances[0].tags, raw.instances[0].tags) && deepEqual(m.instances[0].scope, raw.instances[0].scope) && m.instances[0].data.allowOverbreakPct === 10);
  check("a v2 snapshot is not re-marked as migrated from v1", m.migratedFrom === undefined);
}

/* ---- 4. rejection: never overwrite what we cannot read ---- */
{
  const bad = [null, 42, "text", [], {}, { foo: 1 }];
  check("non-takeoff inputs are rejected with an Error", bad.every((b) => { try { migrateEstimateSnapshot(b); return false; } catch (e) { return !!e && typeof e.message === "string" && /takeoff/.test(e.message); } }));   // (a vm sandbox has its own Error class)
  let msg = ""; try { migrateEstimateSnapshot({ schemaVersion: 99, instances: [] }); } catch (e) { msg = e.message; }
  check("a NEWER schema is rejected with a clear message", /newer version/.test(msg));
}

/* ---- 5. raw backup: raw strings, exclusions, checksum, once-only ---- */
{
  const mem = new Map([
    ["gradcon-estimate-state::proj_a", '{"project":{"name":"A"},"instances":[]}'],
    ["gradcon-preferences", '{"quotesRememberProject":false}'],
    ["gradcon-quote-x", '{"projectName":"X","items":[]}'],
    ["unrelated-key", "keep out"],
    ["gradcon-pre-migration-backup::2020-01-01T00-00-00-000Z", '{"format":"gradcon-all-data-backup"}'],
  ]);
  const storage = { get length() { return mem.size; }, key: (i) => [...mem.keys()][i], getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const keys = collectRawAppKeys(storage);
  check("backup collects only gradcon-* keys", Object.keys(keys).sort().join(",") === "gradcon-estimate-state::proj_a,gradcon-preferences,gradcon-quote-x");
  check("backup stores the RAW string, unparsed", keys["gradcon-estimate-state::proj_a"] === '{"project":{"name":"A"},"instances":[]}');
  check("an earlier pre-migration backup is not nested", !("gradcon-pre-migration-backup::2020-01-01T00-00-00-000Z" in keys));
  const doc = buildRawBackup(storage, { build: "test", origin: "https://example.test" });
  check("backup document carries format, count, bytes and checksum", doc.format === "gradcon-all-data-backup" && doc.keyCount === 3 && doc.bytes > 0 && /^[0-9a-f]{8}$/.test(doc.checksum) && doc.checksum === checksumOf(keys));
  const r1 = ensurePreMigrationBackup(storage, { build: "test" });
  check("first load creates the pre-migration key", r1.created && r1.key.startsWith(PRE_MIGRATION_PREFIX) && mem.has(r1.key));
  check("...and the done-marker points at it", mem.get(PRE_MIGRATION_DONE_KEY) === r1.key);
  const r2 = ensurePreMigrationBackup(storage, { build: "test" });
  check("second load does NOT create another (once per schema version)", !r2.created && r2.key === r1.key);
  check("listPreMigrationBackups finds both, newest first", listPreMigrationBackups(storage)[0] === r1.key && listPreMigrationBackups(storage).length === 2);
  const stored = JSON.parse(mem.get(r1.key));
  check("the pre-migration copy equals the raw values byte for byte", stored.keys["gradcon-quote-x"] === '{"projectName":"X","items":[]}' && stored.keyCount === 3);
  // quota failure: reported, not thrown, marker not written
  const full = { get length() { return mem.size; }, key: (i) => [...mem.keys()][i], getItem: (k) => (k === PRE_MIGRATION_DONE_KEY ? null : (mem.has(k) ? mem.get(k) : null)), setItem: () => { throw new Error("QuotaExceededError"); } };
  const r3 = ensurePreMigrationBackup(full, {});
  check("a storage failure is reported, not thrown, and leaves no marker", !r3.created && /Quota/.test(r3.error));
}

console.log(`\n${passed} check(s) passed${failed ? `, ${failed} FAILED` : ""}.`);
if (failed) { console.log("Estimates data safety is NOT proven — do not ship."); process.exit(1); }
console.log("All good.");
