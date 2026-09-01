-- ============================================================================
-- Cycle count: group by AREA, and a monthly plan
-- Run AFTER 12_cycle_count_export.sql. Safe to run more than once.
--
-- 1. AREA ON THE COUNT
--
--    "REPORT ACCURACY.xlsx" reports by area - HR, Transit, XINHAI, DLOC, with
--    OW SAIC coming later. Nothing new has to be invented for that: the app
--    has computed exactly those buckets since setup.sql, in calc_zonetype()
--    and calc_area(), and every one of the 207k rows carries one. Verified
--    against their own sheets - every location they counted lands in the group
--    their report puts it in:
--
--      HR sheet      LHS-PP01-401     -> HR
--      TRANSIT sheet CTR-BIW-001      -> Transit
--      XINHAI sheet  XIN2-G02         -> XIN2
--      Spot check    TRANSIT B02      -> Transit
--
--    The area is FROZEN onto the session, like everything else here.
--    swap_inventory() replaces the whole table on each upload, and a location
--    can be re-zoned; a count's area must stay whatever it was on the day.
--
-- 2. THE PLAN
--
--    Their report's own instruction: "Develop a cycle count plan on a monthly
--    basis; in the cycle count plan, parts of each area (DLOC area or
--    non-DLOC area) need to be included."
--
--    Any admin may edit it - the user's call, though in practice one person
--    will keep it. A plan row is just "this location, on this day"; whether it
--    happened is DERIVED from the counts, never ticked by hand, so the plan
--    cannot claim work that was not done.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Area on the session
-- ---------------------------------------------------------------------------

alter table public.cycle_count_session
  add column if not exists area text;

-- Resolve a location to its area. A location is expected to have exactly one,
-- but this takes the most common rather than assuming - a tie or a stray row
-- should not decide a whole count's grouping.
create or replace function public.area_of_location(p_location text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select i.area
    from public.inventory i
   where i.location = p_location
     and coalesce(i.area, '') <> ''
   group by i.area
   order by count(*) desc, i.area
   limit 1;
$$;

-- Backfill counts taken before this file existed.
update public.cycle_count_session s
   set area = public.area_of_location(s.location)
 where s.area is null;

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

  select started_by into v_holder
    from public.cycle_count_session
   where location = v_loc
     and finished_at is null and cancelled_at is null
   limit 1;

  if v_holder is not null then
    raise exception '% is already counting %. Pick another location.',
      v_holder, v_loc;
  end if;

  select location into v_mine
    from public.cycle_count_session
   where started_by_uid = auth.uid()
     and finished_at is null and cancelled_at is null
   limit 1;

  if v_mine is not null then
    raise exception 'You already have a count open at %. Finish it first.', v_mine;
  end if;

  insert into public.cycle_count_session (location, area, started_by, started_by_uid)
  values (v_loc, public.area_of_location(v_loc),
          public.email_display_name(auth.jwt() ->> 'email'), auth.uid())
  returning * into s;

  insert into public.cycle_count_expected (session_id, case_no, query_opened)
  select s.id, i.case_no, bool_or(i.is_case_opened = 'Yes')
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

-- Appending `area` at the END keeps this a replace rather than a drop:
-- create or replace view can add columns, it just cannot rename or reorder
-- them. That matters because cycle_count_daily and cycle_count_by_admin are
-- built on this view, and dropping it would take them - and every grant - with
-- it.
create or replace view public.cycle_count_summary as
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

-- Totals per area. A separate view rather than another GROUP BY column on
-- cycle_count_daily, which is deliberately one row per day per person.
drop view if exists public.cycle_count_by_area;

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

-- How much of each area exists at all, so a count can be read as a share of
-- the whole rather than a bare number. anon may read it: shelf names and
-- counts, nothing about people.
drop view if exists public.area_sizes;

create view public.area_sizes as
select
  coalesce(nullif(i.area, ''), 'Unknown') as area,
  count(distinct i.location) as locations,
  count(distinct i.case_no)  as cases
from public.inventory i
group by 1;

-- ---------------------------------------------------------------------------
-- 2. The plan
-- ---------------------------------------------------------------------------

create table if not exists public.cycle_count_plan (
  id             uuid primary key default gen_random_uuid(),
  plan_date      date not null,
  location       text not null,
  area           text,
  note           text,
  created_by     text not null,
  created_by_uid uuid,
  created_at     timestamptz not null default now(),
  -- The same location twice on one day is a mistake, not a plan.
  unique (plan_date, location)
);

create index if not exists cycle_count_plan_date_idx
  on public.cycle_count_plan (plan_date);

create or replace function public.add_plan_entry(
  p_plan_date date,
  p_location  text,
  p_note      text default null
)
returns public.cycle_count_plan
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cycle_count_plan;
  v_loc text := trim(p_location);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if coalesce(v_loc, '') = '' then
    raise exception 'Pick a location.';
  end if;
  if p_plan_date is null then
    raise exception 'Pick a date.';
  end if;

  insert into public.cycle_count_plan
    (plan_date, location, area, note, created_by, created_by_uid)
  values
    (p_plan_date, v_loc, public.area_of_location(v_loc), nullif(trim(coalesce(p_note,'')), ''),
     public.email_display_name(auth.jwt() ->> 'email'), auth.uid())
  on conflict (plan_date, location) do nothing
  returning * into r;

  if r.id is null then
    raise exception '% is already planned for %.', v_loc, p_plan_date;
  end if;
  return r;
end;
$$;

-- Any admin may remove an entry: the user said any of them can edit the plan.
create or replace function public.remove_plan_entry(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  delete from public.cycle_count_plan where id = p_id;
  return found;
end;
$$;

-- Whether a planned count happened is DERIVED, never ticked. `done` means a
-- finished count of that location on that day, in Asia/Jakarta - the same
-- local-day rule the statistics use.
drop view if exists public.cycle_count_plan_status;

create view public.cycle_count_plan_status as
select
  p.id,
  p.plan_date,
  p.location,
  p.area,
  p.note,
  p.created_by,
  p.created_at,
  exists (
    select 1 from public.cycle_count_session s
     where s.location = p.location
       and s.finished_at is not null
       and (s.started_at at time zone 'Asia/Jakarta')::date = p.plan_date
  ) as done,
  -- For context when it was counted late, or not at all.
  (select max(s.finished_at) from public.cycle_count_session s
    where s.location = p.location and s.finished_at is not null) as last_counted_at,
  (select s.started_by from public.cycle_count_session s
    where s.location = p.location and s.finished_at is not null
    order by s.finished_at desc limit 1) as last_counted_by
from public.cycle_count_plan p;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

alter table public.cycle_count_plan enable row level security;

drop policy if exists cycle_count_plan_read on public.cycle_count_plan;
create policy cycle_count_plan_read on public.cycle_count_plan
  for select to authenticated using (true);

grant select on public.cycle_count_plan        to authenticated;
grant select on public.cycle_count_plan_status to authenticated;
grant select on public.cycle_count_by_area     to authenticated;
grant select on public.cycle_count_summary     to authenticated;
grant select on public.area_sizes              to anon, authenticated;

revoke all on function public.area_of_location(text)         from public, anon;
revoke all on function public.add_plan_entry(date, text, text) from public, anon;
revoke all on function public.remove_plan_entry(uuid)        from public, anon;
-- start_cycle_count was REPLACED, not dropped, so its grant survives - but
-- reapplying costs nothing and a lost grant fails closed.
revoke all on function public.start_cycle_count(text)        from public, anon;

grant execute on function public.area_of_location(text)          to authenticated;
grant execute on function public.add_plan_entry(date, text, text) to authenticated;
grant execute on function public.remove_plan_entry(uuid)         to authenticated;
grant execute on function public.start_cycle_count(text)         to authenticated;


-- ============================================================================
-- CHECK - every counted location should resolve to an area, and the four
-- areas they count today should all be present.
-- ============================================================================
-- select area, sessions, locations, scanned, clean_match
--   from public.cycle_count_by_area order by scanned desc;
--
-- select area, locations, cases from public.area_sizes
--  where area in ('HR', 'Transit', 'XIN1', 'XIN2', 'DLOC', 'OF')
--  order by cases desc;
--
-- -- must return no rows: a session whose location has no area
-- select id, location from public.cycle_count_session where area is null;
