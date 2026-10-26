/* Summaries in batches — pure, no imports (verify.mjs runs it in Node).
 *
 * `estimator_kv_quote_summaries` (supabase/migrations/0004) rebuilds every
 * row it is handed inside ONE statement, and the anon role's statement
 * timeout is 3 s. On 26 Oct 2026 a browser with no summary mirrors asked for
 * all 25 projects at once: the call ran 2.95 s in the database, PostgREST
 * answered 500 (57014), and the dashboard fell back to downloading every row
 * in full, one after another (~37 MB — the seven rows from before the
 * drawings moved to the bucket are 3–7 MB each). Until that finished the
 * dashboard showed only the projects this browser had seen before, and Grady
 * reported "projects are missing". So: a few keys per call, several calls in
 * flight, a failed call retried one key at a time, and every landing handed
 * back at once so the page can paint as the rows arrive. */

/** Keys per summaries call: the largest rows cost ~0.6 s each inside the
 * function, so three stay well under the 3 s statement timeout. */
export const SUMMARIES_BATCH = 3;
/** Summaries calls in flight at once. */
export const SUMMARIES_IN_FLIGHT = 4;

/** `keys` split into consecutive batches of at most `size`. */
export function summaryBatches(keys, size = SUMMARIES_BATCH) {
  const out = [];
  const n = Math.max(1, Math.floor(size) || 1);
  for (let i = 0; i < keys.length; i += n) out.push(keys.slice(i, i + n));
  return out;
}

/**
 * Read `{key, value, updated_at}` rows for `keys`:
 *   rpc(keys) → rows | null     the summaries function (null = that call failed)
 *   readRow(key) → row | null   the bounded full-row read, for a key the function could not give
 *   onPartial({key: value})     called after every landing with ONLY the keys that just arrived
 * A batch that fails is retried one key at a time; a key the function never
 * returns goes to `readRow`; a key that still cannot be read is in `failed`
 * (unavailable — never "missing"). `map` holds the rows. Nothing throws.
 */
export async function collectSummaries(keys, { rpc, readRow, batch = SUMMARIES_BATCH, inFlight = SUMMARIES_IN_FLIGHT, onPartial } = {}) {
  const map = {};
  const failed = [];
  const wanted = Array.from(new Set((keys || []).filter((k) => typeof k === "string" && k)));
  const land = (rows, ask) => {
    const landed = {};
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.key !== "string" || !ask.includes(r.key) || r.key in map) continue;
      map[r.key] = r;
      landed[r.key] = r.value;
    }
    if (onPartial && Object.keys(landed).length) {
      try { onPartial(landed); } catch { /* a paint callback must never stop the read */ }
    }
  };
  const call = async (ask) => {
    if (!rpc) return null;
    try { return await rpc(ask); } catch { return null; }
  };
  const one = async (ask) => {
    const rows = await call(ask);
    if (rows) land(rows, ask);
    else if (ask.length > 1 && rpc) {
      for (const k of ask) { const r = await call([k]); if (r) land(r, [k]); }
    }
    for (const k of ask.filter((x) => !(x in map))) {
      let row = null;
      if (readRow) { try { row = await readRow(k); } catch { row = null; } }
      if (row) land([row], [k]);
      else failed.push(k);
    }
  };
  const batches = summaryBatches(wanted, batch);
  let next = 0;
  const worker = async () => { while (next < batches.length) await one(batches[next++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(inFlight, batches.length)) }, worker));
  return { map, failed };
}
