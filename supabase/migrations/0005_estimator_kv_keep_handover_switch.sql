-- Gradcon Estimator: a project's crew-prefill switch survives a save from an
-- older copy of the app.
--
-- 12 Nov 2026, 41 Wildcoast Road: two browser tabs still running builds from
-- before the "one writer at a time" rule (lib/handover.js) kept re-planning
-- the crew sheet against each other — about one whole-row save a second for
-- hours — and every one of those saves replaced what was being typed in a
-- third tab. The current build stops such a tab by storing
--     handoverLive: false, handoverMode: "live"
-- on the project (older builds read only handoverLive and stand down), but a
-- tab that is mid-save writes its own stale copy back WITHOUT the pair, so
-- the switch was lost again within the second and the tabs carried on.
--
-- This trigger makes the switch stick: when a project row that carries
-- handoverMode is replaced by a value that has none (only a build from before
-- the rule writes such a value), the stored mode is carried over and
-- handoverLive is held at false. Nothing else in the value is touched — no
-- quantity, rate, cell or name — and a value that states its own handoverMode,
-- or that explicitly turned the prefill off the old way (handoverLive: false),
-- is stored exactly as sent. Rows that are not projects are never looked at.
-- Run it in the Supabase SQL editor.

create or replace function public.estimator_kv_keep_handover_switch()
returns trigger
language plpgsql
as $$
begin
  if new.key like 'gradcon-quote-%'
     and jsonb_typeof(new.value) = 'object'
     and jsonb_typeof(old.value) = 'object'
     and old.value ? 'handoverMode'
     and not (new.value ? 'handoverMode')
     and (new.value -> 'handoverLive') is distinct from 'false'::jsonb
  then
    new.value := new.value || jsonb_build_object(
      'handoverMode', old.value -> 'handoverMode',
      'handoverLive', false
    );
  end if;
  return new;
end;
$$;

drop trigger if exists estimator_kv_keep_handover_switch on public.estimator_kv;
create trigger estimator_kv_keep_handover_switch
  before update on public.estimator_kv
  for each row execute function public.estimator_kv_keep_handover_switch();
