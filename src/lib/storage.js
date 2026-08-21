import { useState, useEffect, useRef } from "react";

/**
 * Persists React state to localStorage under `key`, debounced so rapid
 * typing doesn't hammer storage. Returns [value, setValue, status] where
 * status is one of: "loading" | "saved" | "saving" | "error" | "unavailable".
 *
 * This is single-browser, single-user persistence — see CLAUDE.md →
 * "Known limitation: no shared/multi-user state" before assuming two
 * people looking at the same quote will see each other's edits.
 */
export function useStoredState(key, initial) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState("loading");
  const loadedRef = useRef(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    try {
      if (typeof window === "undefined" || !window.localStorage) {
        setStatus("unavailable");
      } else {
        const raw = window.localStorage.getItem(key);
        if (raw) setValue(JSON.parse(raw));
        setStatus("saved");
      }
    } catch {
      setStatus("error");
    } finally {
      loadedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (typeof window === "undefined" || !window.localStorage) {
      setStatus("unavailable");
      return;
    }
    setStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        setStatus("saved");
      } catch {
        setStatus("error");
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return [value, setValue, status];
}
