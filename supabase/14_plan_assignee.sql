-- ============================================================================
-- Cycle count plan: assign each entry to an admin
-- Run AFTER 13_cycle_count_area_and_plan.sql. Safe to run more than once.
--
-- "the plan add admin also so every admin have plan" - a plan row now names
-- who is meant to count it, so each person has their own list.
--
-- WHAT DOES NOT CHANGE
--
-- `done` still means "this location was counted on this day", by anyone. If
-- Dian Ayu counts a location assigned to Doni, the work IS done and the plan
-- must say so - a plan that only ticks for the named person would report the
-- warehouse as behind when it is not. The assignee is who was ASKED, not a
-- condition on the answer.
--
-- The unique (plan_date, location) constraint stays: one location on one day
-- is one job, whoever it belongs to.
-- ============================================================================

alter table public.cycle_count_plan
  add column if not exists assigned_to     text,
  add column if not exists assigned_to_uid uuid;

create index if not exists cycle_count_plan_assignee_idx
  on public.cycle_count_plan (assigned_to_uid);

-- ---------------------------------------------------------------------------
-- Who can be assigned
--
-- Every account in this project is an admin - they are created by hand in the
-- dashboard and there is no signup - so the whole user list is the assignee
-- list. Display names only, never emails: the same rule active_admins follows,
-- and for the same reason.
-- ---------------------------------------------------------------------------

create or replace function public.admin_list()
returns table (uid uuid, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, public.email_display_name(u.email::text)
    from auth.users u
   order by 2;
$$;

-- ---------------------------------------------------------------------------
-- Adding an entry, now with an assignee
--
-- Dropped rather than overloaded: adding a parameter would leave TWO
-- add_plan_entry functions, and PostgREST cannot choose between overloads.
-- Dropping loses the grant from 13, so it is reapplied below.
-- ---------------------------------------------------------------------------

drop function if exists public.add_plan_entry(date, text, text);

create or replace function public.add_plan_entry(
  p_plan_date    date,
  p_location     text,
  p_assigned_uid uuid default null,
  p_note         text default null
)
returns public.cycle_count_plan
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cycle_count_plan;
  v_loc  text := trim(p_location);
  v_name text;
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

  -- The name is resolved HERE from the id, never taken from the client, so a
  -- plan cannot be filed under a name that belongs to nobody.
  if p_assigned_uid is not null then
    select display_name into v_name
      from public.admin_list() where uid = p_assigned_uid;
    if v_name is null then
      raise exception 'That admin does not exist.';
    end if;
  end if;

  insert into public.cycle_count_plan
    (plan_date, location, area, note, assigned_to, assigned_to_uid,
     created_by, created_by_uid)
  values
    (p_plan_date, v_loc, public.area_of_location(v_loc),
     nullif(trim(coalesce(p_note, '')), ''), v_name, p_assigned_uid,
     public.email_display_name(auth.jwt() ->> 'email'), auth.uid())
  on conflict (plan_date, location) do nothing
  returning * into r;

  if r.id is null then
    raise exception '% is already planned for %.', v_loc, p_plan_date;
  end if;
  return r;
end;
$$;

-- Reassign without deleting and re-adding, which would lose the note.
create or replace function public.assign_plan_entry(
  p_id           uuid,
  p_assigned_uid uuid
)
returns public.cycle_count_plan
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cycle_count_plan;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  if p_assigned_uid is not null then
    select display_name into v_name
      from public.admin_list() where uid = p_assigned_uid;
    if v_name is null then
      raise exception 'That admin does not exist.';
    end if;
  end if;

  update public.cycle_count_plan
     set assigned_to = v_name, assigned_to_uid = p_assigned_uid
   where id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'No such plan entry.';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- The status view, now carrying the assignee
-- ---------------------------------------------------------------------------

drop view if exists public.cycle_count_plan_status;

create view public.cycle_count_plan_status as
select
  p.id,
  p.plan_date,
  p.location,
  p.area,
  p.note,
  p.assigned_to,
  p.assigned_to_uid,
  p.created_by,
  p.created_at,
  -- Done by ANYONE. See the header: the assignee is who was asked, not a
  -- condition on whether the work counts.
  exists (
    select 1 from public.cycle_count_session s
     where s.location = p.location
       and s.finished_at is not null
       and (s.started_at at time zone 'Asia/Jakarta')::date = p.plan_date
  ) as done,
  (select s.started_by from public.cycle_count_session s
    where s.location = p.location
      and s.finished_at is not null
      and (s.started_at at time zone 'Asia/Jakarta')::date = p.plan_date
    order by s.finished_at desc limit 1) as done_by,
  (select max(s.finished_at) from public.cycle_count_session s
    where s.location = p.location and s.finished_at is not null) as last_counted_at,
  (select s.started_by from public.cycle_count_session s
    where s.location = p.location and s.finished_at is not null
    order by s.finished_at desc limit 1) as last_counted_by
from public.cycle_count_plan p;

-- ---------------------------------------------------------------------------
-- Permissions. add_plan_entry was DROPPED above, so its grant went with it.
-- ---------------------------------------------------------------------------

grant select on public.cycle_count_plan_status to authenticated;

revoke all on function public.admin_list()                          from public, anon;
revoke all on function public.add_plan_entry(date, text, uuid, text) from public, anon;
revoke all on function public.assign_plan_entry(uuid, uuid)         from public, anon;

grant execute on function public.admin_list()                           to authenticated;
grant execute on function public.add_plan_entry(date, text, uuid, text) to authenticated;
grant execute on function public.assign_plan_entry(uuid, uuid)          to authenticated;


-- ============================================================================
-- CHECK - the admin list should name everyone who can be assigned, and there
-- must be exactly ONE add_plan_entry.
-- ============================================================================
-- select * from public.admin_list();
--
-- select p.oid::regprocedure
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'add_plan_entry';
