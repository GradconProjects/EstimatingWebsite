/**
 * Read-only access to the Estimates takeoffs from the Quotes bundle — the
 * takeoff index row and one takeoff row, cloud first (the same estimator_kv
 * table) then this browser's copy. Nothing here writes. Used by the Tender
 * Quote reword to find the takeoff whose project name matches the quote's
 * (lib/tenderSpecContext.js). A failed read is null, never an error thrown
 * at the caller: a tender can always be reworded without a takeoff.
 */
import { supabase, supabaseEnabled } from "./supabaseClient.js";
import { findTakeoffEntry, takeoffSnapshot } from "./tenderSpecContext.js";

export const TAKEOFF_INDEX_KEY = "gradcon-estimate-projects-index";

async function cloudValue(key) {
  if (!supabaseEnabled) return undefined;
  try {
    const { data, error } = await supabase.from("estimator_kv").select("value").eq("key", key).maybeSingle();
    return error || !data ? null : data.value;
  } catch { return null; }
}
function localValue(key) {
  try { const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** The takeoff index: the cloud's and this browser's entries, union by key (newest savedAt wins). */
export async function readTakeoffIndex(deps = {}) {
  const cloud = deps.cloudValue ? await deps.cloudValue(TAKEOFF_INDEX_KEY) : await cloudValue(TAKEOFF_INDEX_KEY);
  const local = deps.localValue ? deps.localValue(TAKEOFF_INDEX_KEY) : localValue(TAKEOFF_INDEX_KEY);
  const by = {};
  [].concat(Array.isArray(cloud) ? cloud : [], Array.isArray(local) ? local : []).forEach((e) => { if (!e || !e.key) return; const cur = by[e.key]; if (!cur || String(e.savedAt || "") > String(cur.savedAt || "")) by[e.key] = e; });
  return Object.values(by);
}

/** The takeoff for a project name: {name, key, instances} or null. */
export async function readTakeoffForProject(projectName, deps = {}) {
  const index = await readTakeoffIndex(deps);
  const entry = findTakeoffEntry(index, projectName);
  if (!entry) return null;
  const value = deps.cloudValue ? await deps.cloudValue(entry.key) : await cloudValue(entry.key);
  const snap = takeoffSnapshot(value) || takeoffSnapshot(deps.localValue ? deps.localValue(entry.key) : localValue(entry.key));
  if (!snap) return null;
  return { name: entry.name || (snap.project && snap.project.name) || "", key: entry.key, instances: snap.instances };
}
