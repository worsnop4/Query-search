-- ============================================================================
-- Fix: "column reference case_no is ambiguous" on every scan
-- Run AFTER 09_cycle_count_v2.sql. Safe to run more than once.
--
-- record_scan() is declared `returns table (case_no text, result text, ...)`.
-- In PL/pgSQL those OUT parameters are VARIABLES for the whole function body,
-- and `cycle_count_scan` has columns with the same names. Almost every
-- reference was already qualified (i.case_no, c.result), but one was not:
--
--     on conflict (session_id, case_no) do nothing
--
-- The ON CONFLICT target is parsed as an expression, so PL/pgSQL tries to
-- substitute the variable, finds a column of the same name, and gives up with
-- 42702. A conflict target cannot be table-qualified either - `on conflict
-- (c.case_no)` is not valid syntax - so the fix is to drop the target and let
-- ON CONFLICT DO NOTHING catch any unique violation on the table.
--
-- That is equivalent here: cycle_count_scan has exactly two unique constraints,
-- the bigserial primary key (which cannot collide on insert) and
-- unique (session_id, case_no), which is the one being relied on.
--
-- WHY IT INSTALLED CLEANLY AND THEN FAILED
--
-- PL/pgSQL only parses a statement the first time it is executed, so the whole
-- of 09 applied without complaint and the error appeared on the first real
-- scan from the mobile scanner. A SQL file running without an error is not
-- evidence that its functions work.
-- ============================================================================

-- Signature and return type are unchanged, so this can be replaced in place -
-- no drop, and the grants from 09 survive.
create or replace function public.record_scan(p_session_id uuid, p_case_no text)
returns table (
  case_no          text,
  result           text,
  system_locations text[],
  query_opened     boolean,
  already_scanned  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_loc text;
  v_case     text := trim(p_case_no);
  v_locs     text[];
  v_opened   boolean := false;
  v_result   text;
  v_n        integer;
  v_inserted boolean;
  v_pattern  text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before scanning.';
  end if;

  select s.location into v_session_loc
    from public.cycle_count_session s
   where s.id = p_session_id
     and s.finished_at is null and s.cancelled_at is null;

  if v_session_loc is null then
    raise exception 'That count session is finished, or does not exist.';
  end if;
  if v_case = '' then
    raise exception 'Nothing was scanned.';
  end if;

  select array_agg(distinct i.location), bool_or(i.is_case_opened = 'Yes')
    into v_locs, v_opened
    from public.inventory i
   where i.case_no = v_case;

  -- Fallback for a label that carries only part of the number, accepted only
  -- when it resolves to exactly one case. `_`, `%` and `\` are escaped: real
  -- case numbers contain them.
  if v_locs is null then
    v_pattern := '%' ||
      replace(replace(replace(v_case, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    select count(distinct i.case_no) into v_n
      from public.inventory i where i.case_no ilike v_pattern;

    if v_n = 1 then
      select min(i.case_no) into v_case
        from public.inventory i where i.case_no ilike v_pattern;

      select array_agg(distinct i.location), bool_or(i.is_case_opened = 'Yes')
        into v_locs, v_opened
        from public.inventory i
       where i.case_no = v_case;
    end if;
  end if;

  if v_locs is null then
    v_result := 'not_in_query';
  elsif v_session_loc = any (v_locs) then
    v_result := 'match';
  else
    v_result := 'wrong_location';
  end if;

  -- No conflict target: see the header. A double scan is normal with a hand
  -- scanner and must not count twice.
  insert into public.cycle_count_scan
    (session_id, case_no, result, system_locations, query_opened)
  values
    (p_session_id, v_case, v_result, coalesce(v_locs, '{}'), coalesce(v_opened, false))
  on conflict do nothing;

  v_inserted := found;

  -- On a repeat scan, report what was stored the first time rather than the
  -- freshly computed answer, so the screen always agrees with the row.
  if not v_inserted then
    select c.result, c.system_locations, c.query_opened
      into v_result, v_locs, v_opened
      from public.cycle_count_scan c
     where c.session_id = p_session_id and c.case_no = v_case;
  end if;

  return query select v_case, v_result, coalesce(v_locs, '{}'),
                      coalesce(v_opened, false), not v_inserted;
end;
$$;

revoke all on function public.record_scan(uuid, text) from public, anon;
grant execute on function public.record_scan(uuid, text) to authenticated;


-- ============================================================================
-- CHECK - run this while signed in as an admin, with a location you can lock.
-- It exercises the real path instead of trusting that the file applied.
--
-- Nothing here writes to inventory; the session is cancelled at the end, so
-- the location is released and the trial count is not left in the statistics.
-- ============================================================================
-- select 'starting' as step;
-- with s as (select public.start_cycle_count('TRANSIT B02') as sess)
-- select (sess).id, (sess).location, (sess).expected_count from s;
--
-- -- then, with the id printed above:
-- -- select * from public.record_scan('<id>', '<any case number>');
-- -- select * from public.cycle_count_summary where id = '<id>';
-- -- select public.cancel_cycle_count('<id>');
