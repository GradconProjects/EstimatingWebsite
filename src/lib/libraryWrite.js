/** A rate typed on a Quotes card that the RATES LIBRARY governs (Boma,
 * 21 Nov 2026, on the finished-pavements band: "make it editable here and
 * the update should cross reference to the rates library").
 *
 * The library is the one figure: the card never writes the shared rates for
 * such a row (the next library sync would snap it straight back). It writes
 * the LIBRARY — this browser's copy at once, then the cloud row — and the
 * ordinary library sync (App.jsx) carries the figure onto the live rates and
 * logs the move, so every other open project is asked about it as for any
 * library change.
 *
 * `patchLibraryPrice` is pure (verify-covered); `writeLibraryPrice` is the
 * browser call (`deps` is the test seam). Only ONE section of the library
 * row is patched in the cloud (`estimator_kv_merge`, else a read-merge-write),
 * never a blind overwrite of the whole library. */
import { supabase, supabaseEnabled } from "./supabaseClient.js";
import { RATES_LIBRARY_KEY, readLibraryState } from "./ratesLibrarySync.js";

const TABLE = "estimator_kv";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The library with ONE row's cost changed (a new object; the input is never mutated). Null when there is no library, no section name, no row name or no valid figure. */
export function patchLibraryPrice(state, section, name, cost, at = new Date().toISOString()) {
  const n = Number(cost);
  if (!isObj(state) || !section || !name || cost === "" || cost == null || !Number.isFinite(n) || n < 0) return null;
  const sec = isObj(state[section]) ? state[section] : {};
  const row = isObj(sec[name]) ? sec[name] : {};
  return { ...state, [section]: { ...sec, [name]: { ...row, cost: n } }, updatedAt: at };
}

/** Tell this window's own library sync that the library changed (a localStorage write fires no storage event in the document that made it). */
function announce(win) {
  try { win.dispatchEvent(new win.StorageEvent("storage", { key: RATES_LIBRARY_KEY })); }
  catch { try { win.dispatchEvent(new win.Event("storage")); } catch { /* the next load syncs */ } }
}

/** Write one library price. Resolves `{ok, local, cloud, reason?}` — `ok` false means the library could not be written anywhere (the caller falls back to the plain rate). */
export async function writeLibraryPrice(section, name, cost, deps = {}) {
  const win = deps.window || (typeof window !== "undefined" ? window : null);
  const client = "supabase" in deps ? deps.supabase : (supabaseEnabled ? supabase : null);
  const read = deps.readLocal || readLibraryState;
  const at = deps.now || new Date().toISOString();
  let local = false;
  const putLocal = (st) => {
    if (!st || !win) return;
    try { win.localStorage.setItem(RATES_LIBRARY_KEY, JSON.stringify(st)); local = true; announce(win); } catch { /* storage full: the cloud copy still goes */ }
  };
  const mine = patchLibraryPrice(read(), section, name, cost, at);
  if (mine) putLocal(mine);                              // the card shows the figure at once
  if (!client) return local ? { ok: true, local, cloud: false } : { ok: false, local, cloud: false, reason: "The Rates Library has not been opened in this browser yet" };
  try {
    const { data: row, error } = await client.from(TABLE).select("value").eq("key", RATES_LIBRARY_KEY).maybeSingle();
    if (error) return { ok: local, local, cloud: false, reason: "The Rates Library could not be read from the cloud" };
    if (!row || !isObj(row.value)) return { ok: local, local, cloud: false, reason: local ? "" : "The Rates Library has not been saved yet — open it once" };
    const next = patchLibraryPrice(row.value, section, name, cost, at);
    if (!next) return { ok: local, local, cloud: false, reason: "Not a valid rate" };
    const patch = { [section]: next[section], updatedAt: at };
    let written = false;
    try {
      const { data, error: rpcErr } = await client.rpc("estimator_kv_merge", { p_key: RATES_LIBRARY_KEY, p_patch: patch });
      written = !rpcErr && !!data;
    } catch { /* fall through to the read-merge-write */ }
    if (!written) {
      const { error: upErr } = await client.from(TABLE).upsert({ key: RATES_LIBRARY_KEY, value: next, updated_at: at });
      written = !upErr;
    }
    if (!written) return { ok: local, local, cloud: false, reason: "The Rates Library could not be saved to the cloud" };
    putLocal(next);                                       // the cloud's library, with this figure — never an older local copy
    return { ok: true, local, cloud: true };
  } catch {
    return { ok: local, local, cloud: false, reason: "The Rates Library could not be reached" };
  }
}
