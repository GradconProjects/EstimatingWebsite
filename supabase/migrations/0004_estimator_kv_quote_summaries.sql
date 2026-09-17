-- Gradcon Estimator: read-only project SUMMARIES for the dashboard, Project
-- Management and Vault pages.
--
-- Every project row carries its markup drawings as base64 image data inside
-- value.items[*].markups[*].dataURL — the 16 rows measured 30 MB on
-- 17 Sep 2026, 99% of it drawings. The summary pages never show a drawing,
-- yet on a cold or stale load the browser had to download the whole row and
-- drop the image data itself. This function drops it in the database, so the
-- drawing bytes never cross the network.
--
-- Guarantees (verified by scripts/verify-summaries-sql.mjs in an isolated
-- database):
--   * read-only: STABLE, a single SELECT, no row is ever written;
--   * SECURITY INVOKER: runs as the caller, so estimator_kv's row-level
--     security policies apply exactly as they do to a plain SELECT;
--   * reads only the requested keys (p_keys), never the whole table;
--   * everything except items[*].markups[*].dataURL comes back byte-for-byte
--     (blanks, zeroes, decimals, array order, unknown fields) — a value that is
--     not an object, or has no items array, is returned unchanged;
--   * additive: nothing in the existing table or policies changes.
--
-- The app (src/lib/projects.js → fetchSummaries) calls this when it exists
-- and falls back to one bounded full-row read per project when it does not,
-- so installing it is optional but is what makes the summary pages fast.
-- Run it in the Supabase SQL editor (or `supabase db push`).
--
-- A summary returned by this function is NOT a complete quote: it must never
-- be written back whole. The project editor loads the full row itself.

create or replace function public.estimator_kv_quote_summaries(p_keys text[])
returns table (key text, value jsonb, updated_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select k.key,
         case
           when jsonb_typeof(k.value) = 'object' and jsonb_typeof(k.value -> 'items') = 'array' then
             jsonb_set(
               k.value,
               '{items}',
               coalesce((
                 select jsonb_agg(
                   case
                     when jsonb_typeof(it.item) = 'object' and jsonb_typeof(it.item -> 'markups') = 'array' then
                       jsonb_set(
                         it.item,
                         '{markups}',
                         coalesce((
                           select jsonb_agg(
                             case when jsonb_typeof(mk.markup) = 'object' then mk.markup - 'dataURL' else mk.markup end
                             order by mk.ord)
                           from jsonb_array_elements(it.item -> 'markups') with ordinality as mk(markup, ord)
                         ), '[]'::jsonb)
                       )
                     else it.item
                   end
                   order by it.ord)
                 from jsonb_array_elements(k.value -> 'items') with ordinality as it(item, ord)
               ), '[]'::jsonb)
             )
           else k.value
         end as value,
         k.updated_at
    from public.estimator_kv k
   where k.key = any (p_keys);
$$;

grant execute on function public.estimator_kv_quote_summaries(text[]) to anon, authenticated;
