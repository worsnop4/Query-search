-- ============================================================================
-- One count can need more than one action
-- Run AFTER 15_remove_scan.sql. Safe to run more than once.
--
-- "action can choose more than one" - a location can need a put away AND a
-- shortage, so `action` becomes a list instead of a single value.
--
-- WHY 'shortage_profit' GOES AWAY
--
-- It only existed because one value had to carry a pair. With a list, ticking
-- Shortage and Profit IS that pair - keeping the combined option as well would
-- give two different ways to record the same decision, and every report would
-- then have to know both. Existing rows are converted, not dropped:
--
--     'shortage_profit'  ->  {shortage, profit}
--     'put_away'         ->  {put_away}
--
-- WHY THIS TOUCHES SO MANY VIEWS
--
-- Postgres will not alter a column's type while a view reads it, and
-- `create or replace view` cannot change a column's type either. So every view
-- that exposes `action` is dropped and rebuilt here - and dropping
-- cycle_count_summary CASCADEs to the three views built on it. Every grant is
-- reapplied at the bottom: a lost grant fails closed and the page simply stops
-- working for a signed-in admin.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Clear the way
-- ---------------------------------------------------------------------------

drop view if exists public.cycle_count_rows;
-- Takes cycle_count_daily, cycle_count_by_admin and cycle_count_by_area with it.
drop view if exists public.cycle_count_summary cascade;

drop function if exists public.set_session_followup(uuid, text, text, boolean, text);

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'cycle_count_session_action_check'
  ) then
    alter table public.cycle_count_session
      drop constraint cycle_count_session_action_check;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. text -> text[]
-- ---------------------------------------------------------------------------

do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'cycle_count_session'
         and column_name = 'action') = 'text' then
    alter table public.cycle_count_session
      alter column action type text[]
      using (
        case
          when action is null or btrim(action) = '' then null
          when action = 'shortage_profit' then array['shortage', 'profit']
          else array[action]
        end
      );
  end if;
end $$;

alter table public.cycle_count_session
  add constraint cycle_count_session_action_check
  check (
    action is null
    or (array_length(action, 1) > 0
        and action <@ array['put_away', 'shortage', 'profit'])
  );

-- ---------------------------------------------------------------------------
-- 3. The follow-up, now taking a list
--
-- `done` stays a boolean. The screen shows it as "In progress" or "Done",
-- which is two states and needs nothing more than a boolean to hold.
-- ---------------------------------------------------------------------------

create or replace function public.set_session_followup(
  p_session_id uuid,
  p_reason     text,
  p_action     text[],
  p_done       boolean,
  p_remark     text default null
)
returns public.cycle_count_session
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cycle_count_session;
  v_action text[];
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  -- Deduplicate and drop blanks, so ticking the same box twice through the API
  -- cannot store {shortage,shortage}. An empty list is stored as NULL, which
  -- is what "no decision yet" means everywhere else.
  select nullif(array_agg(distinct a order by a), '{}')
    into v_action
    from unnest(coalesce(p_action, '{}')) as a
   where coalesce(btrim(a), '') <> '';

  update public.cycle_count_session s
     set reason = nullif(btrim(coalesce(p_reason, '')), ''),
         action = v_action,
         done   = coalesce(p_done, false),
         remark = nullif(btrim(coalesce(p_remark, '')), '')
   where s.id = p_session_id
  returning s.* into r;

  if r.id is null then
    raise exception 'No such cycle count.';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Rebuild every view that was dropped
-- ---------------------------------------------------------------------------

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
  s.reason,
  s.action,
  s.done,
  s.remark,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match'
      and not c.query_opened)                                  as clean_match,
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
  ) as not_checked,
  s.area
from public.cycle_count_session s;

create view public.cycle_count_daily as
select
  (started_at at time zone 'Asia/Jakarta')::date as count_date,
  started_by,
  started_by_uid,
  count(*)                 as sessions,
  count(distinct location) as locations,
  sum(scanned)             as scanned,
  sum(clean_match)         as clean_match,
  sum(opened_mismatch)     as opened_mismatch,
  sum(wrong_location)      as wrong_location,
  sum(not_in_query)        as not_in_query,
  sum(not_checked)         as not_checked,
  sum(expected_count)      as expected_count
from public.cycle_count_summary
where finished_at is not null
group by 1, 2, 3;

create view public.cycle_count_by_admin as
select
  started_by,
  started_by_uid,
  count(*)                 as sessions,
  count(distinct location) as locations,
  min(started_at)          as first_count,
  max(started_at)          as last_count,
  sum(scanned)             as scanned,
  sum(clean_match)         as clean_match,
  sum(opened_mismatch)     as opened_mismatch,
  sum(wrong_location)      as wrong_location,
  sum(not_in_query)        as not_in_query,
  sum(not_checked)         as not_checked
from public.cycle_count_summary
where finished_at is not null
group by 1, 2;

create view public.cycle_count_by_area as
select
  coalesce(nullif(area, ''), 'Unknown') as area,
  count(*)                 as sessions,
  count(distinct location) as locations,
  min(started_at)          as first_count,
  max(started_at)          as last_count,
  sum(scanned)             as scanned,
  sum(clean_match)         as clean_match,
  sum(opened_mismatch)     as opened_mismatch,
  sum(wrong_location)      as wrong_location,
  sum(not_in_query)        as not_in_query,
  sum(not_checked)         as not_checked
from public.cycle_count_summary
where finished_at is not null
group by 1;

create view public.cycle_count_rows as
select
  s.id            as session_id,
  s.location,
  s.started_at,
  s.finished_at,
  s.started_by,
  s.started_by_uid,
  s.reason,
  s.action,
  s.done,
  s.remark,
  c.case_no,
  c.result,
  c.query_opened,
  c.system_locations,
  c.scanned_at
from public.cycle_count_session s
join public.cycle_count_scan c on c.session_id = s.id
where s.finished_at is not null

union all

select
  s.id,
  s.location,
  s.started_at,
  s.finished_at,
  s.started_by,
  s.started_by_uid,
  s.reason,
  s.action,
  s.done,
  s.remark,
  e.case_no,
  'not_checked'      as result,
  e.query_opened,
  array[s.location]  as system_locations,
  null::timestamptz  as scanned_at
from public.cycle_count_session s
join public.cycle_count_expected e on e.session_id = s.id
where s.finished_at is not null
  and not exists (
    select 1 from public.cycle_count_scan c
     where c.session_id = e.session_id and c.case_no = e.case_no
  );

-- ---------------------------------------------------------------------------
-- 5. Every grant back
-- ---------------------------------------------------------------------------

grant select on public.cycle_count_summary  to authenticated;
grant select on public.cycle_count_daily    to authenticated;
grant select on public.cycle_count_by_admin to authenticated;
grant select on public.cycle_count_by_area  to authenticated;
grant select on public.cycle_count_rows     to authenticated;

revoke all on function public.set_session_followup(uuid, text, text[], boolean, text)
  from public, anon;
grant execute on function public.set_session_followup(uuid, text, text[], boolean, text)
  to authenticated;


-- ============================================================================
-- CHECK - action must now be an array, and nothing may still say
-- 'shortage_profit'.
-- ============================================================================
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'cycle_count_session'
--    and column_name = 'action';        -- expect ARRAY
--
-- select id, location, action from public.cycle_count_session
--  where action is not null;
--
-- -- must return no rows:
-- select id from public.cycle_count_session where 'shortage_profit' = any(action);
