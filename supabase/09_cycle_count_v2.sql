-- ============================================================================
-- Cycle count, second pass - run AFTER 08_cycle_count.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once. Additive: 08 has already been applied, so
-- nothing here drops a table or loses a recorded count.
--
-- Five corrections, all from the user 31 Aug 2026 after reading the real
-- "Spot check Augst.xlsm" workbook:
--
-- 1. THE EXPECTED LIST IS EVERY CASE, NOT JUST FULL ONES.
--
--    08 filtered the expected list to is_case_opened = 'No'. That was wrong,
--    and it hid the single most valuable thing a count finds:
--
--      "i do the cc today, actual case not open still full case, but after
--       compare to query the case has been open. that the crucial founded."
--
--    A case that is physically full while Query says it has been opened needs
--    an adjustment - deleted from Query as a shortage and put back as a full
--    case, a profit. Filtering those rows out meant they could never be found.
--
--    Cost of including them: 48% more case+location pairs across the whole
--    warehouse. But in the 16 areas they actually cycle count it is almost
--    nothing - 15 of them have zero opened cases, and TRANSIT has 58 out of
--    3,252. So this is close to free where it matters.
--
-- 2. ACCURACY MATCHES THEIR SPREADSHEET.
--
--    Recap sheet, 2026-08-03: 43 TRUE of 75 counted = 57.3%. The denominator
--    is what was physically scanned. "Need check" is NOT in it - it is
--    reported separately as a count plus the list of cases, so an admin can go
--    and look at them later.
--
-- 3. ONE LOCATION, ONE COUNTER. An unfinished session locks its location, the
--    same idea as claim_upload() for uploads.
--
-- 4. SESSIONS BELONG TO A USER. 08 stored only a display name, so
--    openSession() resumed ANY unfinished session and a second admin would
--    have been dropped into the first admin's count.
--
-- 5. EACH DISCREPANCY CARRIES A REASON AND AN ACTION, mirroring the
--    Historic / DO / Status columns of the workbook.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

alter table public.cycle_count_session
  add column if not exists started_by_uid uuid,
  add column if not exists cancelled_at   timestamptz;

-- Whether Query said the case had been opened, frozen at the moment of the
-- scan alongside system_locations.
--
-- The rule is "any row for this case is marked opened". is_case_opened lives
-- on the ROW, not the case: measured, 4 case+location pairs carry both Yes and
-- No at once. Treating any Yes as opened is the safe direction - it raises the
-- question rather than burying it.
alter table public.cycle_count_scan
  add column if not exists query_opened boolean not null default false,
  add column if not exists reason       text,
  add column if not exists action       text,
  add column if not exists done         boolean not null default false,
  add column if not exists remark       text;

alter table public.cycle_count_expected
  add column if not exists query_opened boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cycle_count_scan_action_check'
  ) then
    alter table public.cycle_count_scan
      add constraint cycle_count_scan_action_check
      check (action is null or action in
             ('put_away', 'shortage', 'profit', 'shortage_profit'));
  end if;
end $$;

-- Close anything 08 left open, BEFORE the unique index below is built.
--
-- 08 stored no owner, so a session already open belongs to nobody and can
-- never be resumed or cancelled through the app. Two of them on one location
-- would also make the index fail to build, which is why this runs first.
update public.cycle_count_session
   set cancelled_at = now()
 where started_by_uid is null
   and finished_at is null
   and cancelled_at is null;

-- One open session per location. A partial unique index rather than a plain
-- one, so finished and cancelled sessions can pile up on the same location for
-- as long as the warehouse keeps counting it.
create unique index if not exists cycle_count_one_open_per_location
  on public.cycle_count_session (location)
  where finished_at is null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- Open a session - now with a lock and an owner
--
-- Dropped rather than replaced: it returns public.cycle_count_session, whose
-- row type just gained two columns, and `create or replace function` cannot
-- change a return type. Dropping loses the grants from 08, so they are all
-- reapplied at the bottom of this file.
-- ---------------------------------------------------------------------------

drop function if exists public.start_cycle_count(text);

create or replace function public.start_cycle_count(p_location text)
returns public.cycle_count_session
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cycle_count_session;
  v_loc    text := trim(p_location);
  v_holder text;
  v_mine   text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before starting a cycle count.';
  end if;
  if coalesce(v_loc, '') = '' then
    raise exception 'Pick a location first.';
  end if;

  -- The lock. Someone else counting here would be counting the same boxes.
  select started_by into v_holder
    from public.cycle_count_session
   where location = v_loc
     and finished_at is null and cancelled_at is null
   limit 1;

  if v_holder is not null then
    raise exception '% is already counting %. Pick another location.',
      v_holder, v_loc;
  end if;

  -- And one count at a time per person, so resuming is never ambiguous.
  select location into v_mine
    from public.cycle_count_session
   where started_by_uid = auth.uid()
     and finished_at is null and cancelled_at is null
   limit 1;

  if v_mine is not null then
    raise exception 'You already have a count open at %. Finish it first.', v_mine;
  end if;

  insert into public.cycle_count_session (location, started_by, started_by_uid)
  values (v_loc, public.email_display_name(auth.jwt() ->> 'email'), auth.uid())
  returning * into s;

  -- EVERY case Query has here, opened or not - see correction 1 in the header.
  insert into public.cycle_count_expected (session_id, case_no, query_opened)
  select s.id,
         i.case_no,
         bool_or(i.is_case_opened = 'Yes')
    from public.inventory i
   where i.location = v_loc
   group by i.case_no;

  update public.cycle_count_session
     set expected_count = (select count(*)
                             from public.cycle_count_expected
                            where session_id = s.id)
   where id = s.id
  returning * into s;

  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Record one scan - now also reporting what Query says about the case state
--
-- Must be dropped first: it gained a `query_opened` OUT column, and the OUT
-- parameters ARE the return type, so `create or replace` refuses it with
-- 42P13. Same reason as start_cycle_count above.
-- ---------------------------------------------------------------------------

drop function if exists public.record_scan(uuid, text);

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
  v_case   text := trim(p_case_no);
  v_locs   text[];
  v_opened boolean := false;
  v_result text;
  v_n      integer;
  v_inserted boolean;
  v_pattern text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before scanning.';
  end if;

  select location into v_session_loc
    from public.cycle_count_session
   where id = p_session_id
     and finished_at is null and cancelled_at is null;

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

  insert into public.cycle_count_scan
    (session_id, case_no, result, system_locations, query_opened)
  values
    (p_session_id, v_case, v_result, coalesce(v_locs, '{}'), coalesce(v_opened, false))
  on conflict (session_id, case_no) do nothing;

  v_inserted := found;

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

-- ---------------------------------------------------------------------------
-- Give up on a session, releasing the location
-- ---------------------------------------------------------------------------

create or replace function public.cancel_cycle_count(p_session_id uuid)
returns public.cycle_count_session
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cycle_count_session;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  -- Marked, not deleted. An abandoned count is still a fact about the day, and
  -- deleting it would take its scans with it.
  update public.cycle_count_session
     set cancelled_at = now()
   where id = p_session_id
     and finished_at is null and cancelled_at is null
     and started_by_uid = auth.uid()
  returning * into s;

  if s.id is null then
    raise exception 'That is not an open count of yours.';
  end if;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Finish a session
--
-- Redefined from 08 for two reasons: it did not know about cancelled_at, so a
-- cancelled count could still be "finished"; and it checked no ownership, so
-- any signed-in admin could close someone else's count and release a location
-- out from under them.
-- ---------------------------------------------------------------------------

create or replace function public.finish_cycle_count(p_session_id uuid)
returns public.cycle_count_session
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cycle_count_session;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  update public.cycle_count_session
     set finished_at = now()
   where id = p_session_id
     and finished_at is null and cancelled_at is null
     and started_by_uid = auth.uid()
  returning * into s;

  if s.id is null then
    raise exception 'That is not an open count of yours.';
  end if;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- The reason / action / done follow-up, from the workbook's Historic, DO and
-- Status columns
-- ---------------------------------------------------------------------------

create or replace function public.set_scan_followup(
  p_scan_id bigint,
  p_reason  text,
  p_action  text,
  p_done    boolean,
  p_remark  text default null
)
returns public.cycle_count_scan
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cycle_count_scan;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  update public.cycle_count_scan
     set reason = nullif(trim(coalesce(p_reason, '')), ''),
         action = nullif(trim(coalesce(p_action, '')), ''),
         done   = coalesce(p_done, false),
         remark = nullif(trim(coalesce(p_remark, '')), '')
   where id = p_scan_id
  returning * into r;

  if r.id is null then
    raise exception 'No such scan.';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Summary
--
-- clean_match is the workbook's TRUE: right place AND Query agrees about the
-- case state. A case found full where Query says opened is not a pass - it is
-- the discovery the count exists to make, and it needs an adjustment.
--
-- DROPPED first, not replaced. `create or replace view` can only APPEND
-- columns - it cannot rename or reorder them - and this adds cancelled_at and
-- started_by_uid in the middle. Replacing it fails with 42P16, exactly as the
-- search_results view did earlier in this project.
-- ---------------------------------------------------------------------------

drop view if exists public.cycle_count_summary;

create view public.cycle_count_summary as
select
  s.id,
  s.location,
  s.started_at,
  s.finished_at,
  s.cancelled_at,
  s.started_by,
  s.started_by_uid,
  s.expected_count,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match'
      and not c.query_opened)                                  as clean_match,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match')          as matched,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match'
      and c.query_opened)                                      as opened_mismatch,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'wrong_location') as wrong_location,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'not_in_query')   as not_in_query,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id)                                 as scanned,
  (select count(*) from public.cycle_count_expected e
    where e.session_id = s.id
      and not exists (select 1 from public.cycle_count_scan c
                       where c.session_id = e.session_id and c.case_no = e.case_no)
  ) as not_checked
from public.cycle_count_session s;

-- Which locations are being counted right now, and by whom.
drop view if exists public.cycle_count_locks;

create view public.cycle_count_locks as
select id as session_id, location, started_by, started_by_uid, started_at
  from public.cycle_count_session
 where finished_at is null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- The location picker - every case now, not only full ones
-- ---------------------------------------------------------------------------

drop view if exists public.count_locations;

create view public.count_locations as
select
  i.location,
  count(distinct i.case_no)                                          as cases,
  count(distinct i.case_no) filter (where i.is_case_opened = 'Yes')  as opened_cases
from public.inventory i
group by i.location;

grant select on public.count_locations     to anon, authenticated;
grant select on public.cycle_count_locks   to authenticated;
grant select on public.cycle_count_summary to authenticated;

-- start_cycle_count and record_scan were DROPPED above to change their return
-- types, which took 08's grants with them. Reapply every one, not just the new
-- functions - a dropped grant fails closed, so the page would simply stop
-- working for a signed-in admin.
revoke all on function public.start_cycle_count(text)   from public, anon;
revoke all on function public.record_scan(uuid, text)   from public, anon;
revoke all on function public.finish_cycle_count(uuid)  from public, anon;
revoke all on function public.cancel_cycle_count(uuid)  from public, anon;
revoke all on function public.set_scan_followup(bigint, text, text, boolean, text)
  from public, anon;

grant execute on function public.start_cycle_count(text)  to authenticated;
grant execute on function public.record_scan(uuid, text)  to authenticated;
grant execute on function public.finish_cycle_count(uuid) to authenticated;
grant execute on function public.cancel_cycle_count(uuid) to authenticated;
grant execute on function public.set_scan_followup(bigint, text, text, boolean, text)
  to authenticated;


-- ============================================================================
-- CHECK - all five should come back, and start_cycle_count / record_scan must
-- show EXECUTE for `authenticated` or the page will fail once signed in.
-- ============================================================================
-- select p.proname,
--        has_function_privilege('authenticated', p.oid, 'execute') as authed
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('start_cycle_count', 'record_scan', 'finish_cycle_count',
--                      'cancel_cycle_count', 'set_scan_followup')
--  order by p.proname;
