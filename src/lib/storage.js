import { useState, useEffect, useRef } from "react";
import { supabase, supabaseEnabled } from "./supabaseClient.js";

const TABLE = "estimator_kv";

/**
 * Persists React state under `key`, debounced so rapid typing doesn't
 * hammer storage. Returns [value, setValue, status] where status is one
 * of: "loading" | "saved" | "saving" | "error" | "unavailable".
 *
 * Backed by Supabase (shared across every browser/device — see
 * lib/supabaseClient.js) when VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY are
 * configured; otherwise falls back to per-browser localStorage, so the app
 * still works with no Supabase project set up. Every caller gets the same
 * [value, setValue, status] shape regardless of which backend is active —
 * that's deliberate (see CLAUDE.md → "Known limitations") so components
 * never need to know or care which one is in use.
 */
export function useStoredState(key, initial) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState("loading");
  const loadedRef = useRef(false);
  const saveTimer = useRef(null);

  // Re-runs whenever `key` changes, not just on mount — this is what lets a
  // single mounted component switch between projects (each with its own
  // storage key) without a full remount. Always sets `value`, even when
  // nothing is stored yet, so switching to a fresh key resets state instead
  // of leaving the previous key's value on screen. `cancelled` guards
  // against a slow Supabase response for an old key landing after a newer
  // key has already been switched to.
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setStatus("loading");

    (async () => {
      if (supabaseEnabled) {
        // A network failure (offline, DNS, connection reset) REJECTS this
        // promise rather than resolving with an `error` field — without
        // this try/catch that leaves `status` stuck on "loading" forever
        // (and the whole app blank, since App.jsx waits on it) instead of
        // settling on "error".
        try {
          const { data, error } = await supabase.from(TABLE).select("value").eq("key", key).maybeSingle();
          if (cancelled) return;
          if (error) setStatus("error");
          else {
            setValue(data ? data.value : initial);
            setStatus("saved");
          }
        } catch {
          if (!cancelled) setStatus("error");
        }
      } else if (typeof window === "undefined" || !window.localStorage) {
        setStatus("unavailable");
      } else {
        try {
          const raw = window.localStorage.getItem(key);
          setValue(raw ? JSON.parse(raw) : initial);
          setStatus("saved");
        } catch {
          setStatus("error");
        }
      }
      if (!cancelled) loadedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!loadedRef.current) return;
    setStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (supabaseEnabled) {
        try {
          const { error } = await supabase.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() });
          setStatus(error ? "error" : "saved");
        } catch {
          setStatus("error");
        }
      } else if (typeof window === "undefined" || !window.localStorage) {
        setStatus("unavailable");
      } else {
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
          setStatus("saved");
        } catch {
          setStatus("error");
        }
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, key]);

  // Live updates from another browsing context sharing this origin — e.g. the
  // Estimates tool (a separate iframe) writing straight to this project's quote via
  // writeQuote() in lib/projects.js. The native `storage` event only fires in OTHER
  // contexts, never the one that wrote the change, so this never fights with the
  // save effect above. localStorage-only: Supabase-backed state has no equivalent
  // push channel here, so this is a no-op when Supabase is configured.
  useEffect(() => {
    if (supabaseEnabled) return;
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      if (e.key !== key) return;
      try {
        setValue(e.newValue ? JSON.parse(e.newValue) : initial);
      } catch {
        /* ignore a malformed external write rather than crash */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, setValue, status];
}
