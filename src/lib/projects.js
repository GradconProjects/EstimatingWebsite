/**
 * Multi-project index. A project is a lightweight pointer — `{ id,
 * storageKey, createdAt }` — into its own quote object stored separately
 * under `storageKey` (see lib/storage.js, which is backed by Supabase when
 * configured, localStorage otherwise). The index itself lives under
 * PROJECTS_INDEX_KEY. Name/date/GFA/items etc. all live in the quote, not
 * here, so there's exactly one place that owns each piece of data.
 */
import { uid } from "./costing.js";
import { supabase, supabaseEnabled } from "./supabaseClient.js";

const TABLE = "estimator_kv";

export const PROJECTS_INDEX_KEY = "gradcon-projects";
export const LEGACY_QUOTE_KEY = "gradcon-quote";

export const quoteStorageKey = (id) => `gradcon-quote-${id}`;

export function newProjectEntry() {
  const id = uid();
  return { id, storageKey: quoteStorageKey(id), createdAt: new Date().toISOString() };
}

/** Read-only snapshot of one quote, for dashboard summary rows. Not a live
 * subscription — the project editor (via useStoredState) is the source of
 * truth once a project is open. */
export async function readQuote(storageKey) {
  if (supabaseEnabled) {
    try {
      const { data, error } = await supabase.from(TABLE).select("value").eq("key", storageKey).maybeSingle();
      return error || !data ? null : data.value;
    } catch {
      return null;
    }
  }
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Reads many quotes in one round trip — `{ storageKey: quote }` — so the
 * dashboard can summarize every project without one request per row. */
export async function readQuotes(storageKeys) {
  if (storageKeys.length === 0) return {};
  if (supabaseEnabled) {
    try {
      const { data, error } = await supabase.from(TABLE).select("key, value").in("key", storageKeys);
      const map = {};
      if (!error && data) data.forEach((row) => { map[row.key] = row.value; });
      return map;
    } catch {
      return {};
    }
  }
  const map = {};
  storageKeys.forEach((k) => {
    try {
      const raw = window.localStorage.getItem(k);
      if (raw) map[k] = JSON.parse(raw);
    } catch {
      /* skip unreadable entries */
    }
  });
  return map;
}

/** One-time direct write, used only by the Estimates-import flow (see
 * lib/estimateImport.js) to seed a brand-new project's quote before its
 * ProjectEditor (and useStoredState) has ever mounted. Everywhere else,
 * useStoredState owns writes — this bypasses it deliberately because there
 * is no mounted editor yet to own the save. */
export async function writeQuote(storageKey, quote) {
  if (supabaseEnabled) {
    try {
      await supabase.from(TABLE).upsert({ key: storageKey, value: quote, updated_at: new Date().toISOString() });
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(quote));
  } catch {
    /* best-effort */
  }
}

export async function deleteQuote(storageKey) {
  if (supabaseEnabled) {
    try {
      await supabase.from(TABLE).delete().eq("key", storageKey);
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* best-effort */
  }
}

/**
 * One-time migration for installs that had a single quote under the old
 * fixed key (`gradcon-quote`) before multi-project support existed. Turns
 * it into project #1 in the index without moving or duplicating the data —
 * the migrated entry's storageKey stays LEGACY_QUOTE_KEY so nothing is lost
 * if migration runs more than once.
 */
export async function migrateLegacyQuote() {
  const legacy = await readQuote(LEGACY_QUOTE_KEY);
  if (!legacy) return [];
  return [{ id: "legacy", storageKey: LEGACY_QUOTE_KEY, createdAt: legacy.projectDate || new Date().toISOString() }];
}
