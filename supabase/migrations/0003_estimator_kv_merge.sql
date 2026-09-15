-- Gradcon Estimator: field-level merge into a project row.
--
-- The dashboard, Project Management and Vault pages edit a few top-level
-- fields of a quote (status, client, planner, communications, RFIs, claims,
-- defects, variations). Without this function the app has to download the
-- whole row (with its markup drawings, several MB) and upload it back for
-- every such edit. With it, the edit is a few bytes: value || patch.
-- src/lib/projects.js -> patchQuoteFields() uses it when present and falls
-- back to read-merge-write when it is not, so installing this is optional
-- but recommended. Run it in the Supabase SQL editor.

create or replace function public.estimator_kv_merge(p_key text, p_patch jsonb)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update public.estimator_kv
     set value = value || p_patch,
         updated_at = now()
   where key = p_key
  returning updated_at;
$$;

grant execute on function public.estimator_kv_merge(text, jsonb) to anon, authenticated;
