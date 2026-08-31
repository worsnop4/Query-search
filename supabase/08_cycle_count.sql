-- ============================================================================
-- Cycle count - run AFTER setup.sql, 05_admin_presence.sql and 07_case_search.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
--
-- One session counts ONE location. The counter scans case barcodes with a
-- mobile scanner; each scan is compared against where Query says that case is.
--
-- Four outcomes, and the fourth is the reason this needs tables rather than a
-- screen that adds up as it goes:
--
--   match           scanned here, and Query agrees it is here
--   wrong_location  scanned here, but Query has it somewhere else
--   not_in_query    scanned here, and Query has never heard of it
--   NOT CHECKED     Query says it is here, but nobody scanned it
--                   -> "need check later"
--
-- That last one cannot be worked out from the scans alone: it is everything
-- that did NOT happen. It needs the list of what should have been there,
-- captured before counting starts.
--
-- WHY THE EXPECTED LIST IS FROZEN
--
-- `swap_inventory()` truncates and re-inserts the whole table, so every id
-- changes and rows come and go on every upload. A session started this morning
-- and finished after lunch would otherwise be measured against different data
-- than it began with, and "not checked" would silently change meaning. So
-- start_cycle_count() copies the expected case numbers into
-- cycle_count_expected, and record_scan() stores the system location it saw at
-- the moment of the scan. Nothing here is recomputed later.
--
-- SCOPE: FULL CASES ONLY
--
-- Opened cases are handled with a different tool, so the expected list is
-- restricted to is_case_opened = 'No'. Measured on 206,795 live rows this
-- removes 32.4% of the case+location pairs - without it a third of every
-- location would report as "not checked" on every single count.
--
-- SIZE: measured over 4,286 locations that hold at least one full case -
-- median 8 cases, p75 25, p90 46. The ten biggest are not real racks
-- (NEED-CHECK-CASE 8,666, TRANSIT 3,194, TRANSIT-HR 2,573).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.cycle_count_session (
  id             uuid primary key default gen_random_uuid(),
  location       text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  started_by     text not null,
  expected_count integer not null default 0
);

create index if not exists cycle_count_session_started_idx
  on public.cycle_count_session (started_at desc);

-- What Query said should be at that location, frozen when the session opened.
create table if not exists public.cycle_count_expected (
  session_id uuid not null references public.cycle_count_session(id) on delete cascade,
  case_no    text not null,
  primary key (session_id, case_no)
);

create table if not exists public.cycle_count_scan (
  id               bigserial primary key,
  session_id       uuid not null references public.cycle_count_session(id) on delete cascade,
  case_no          text not null,
  scanned_at       timestamptz not null default now(),
  result           text not null
                   check (result in ('match', 'wrong_location', 'not_in_query')),
  -- Where Query had the case AT THE MOMENT OF THE SCAN. An array because a
  -- case is not always in one place: measured, 381 of 108,778 full cases
  -- (0.35%) sit in more than one location, up to 18.
  system_locations text[] not null default '{}',
  -- A double scan is normal with a hand scanner and must not count twice.
  unique (session_id, case_no)
);

create index if not exists cycle_count_scan_session_idx
  on public.cycle_count_scan (session_id, scanned_at);

-- ---------------------------------------------------------------------------
-- Open a session
-- ---------------------------------------------------------------------------

create or replace function public.start_cycle_count(p_location text)
returns public.cycle_count_session
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cycle_count_session;
  v_loc text := trim(p_location);
begin
  if auth.uid() is null then
    raise exception 'Sign in before starting a cycle count.';
  end if;
  if coalesce(v_loc, '') = '' then
    raise exception 'Pick a location first.';
  end if;

  insert into public.cycle_count_session (location, started_by)
  values (v_loc, public.email_display_name(auth.jwt() ->> 'email'))
  returning * into s;

  -- Full cases only - see the header.
  insert into public.cycle_count_expected (session_id, case_no)
  select distinct s.id, i.case_no
    from public.inventory i
   where i.location = v_loc
     and i.is_case_opened = 'No';

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
-- Record one scan
--
-- Classification happens HERE rather than in the browser: the result is the
-- record of what was counted, so it must not be something a client can send.
-- ---------------------------------------------------------------------------

create or replace function public.record_scan(p_session_id uuid, p_case_no text)
returns table (
  case_no          text,
  result           text,
  system_locations text[],
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
  v_result text;
  v_n      integer;
  v_inserted boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in before scanning.';
  end if;

  select location into v_session_loc
    from public.cycle_count_session
   where id = p_session_id and finished_at is null;

  if v_session_loc is null then
    raise exception 'That count session is finished, or does not exist.';
  end if;
  if v_case = '' then
    raise exception 'Nothing was scanned.';
  end if;

  -- Exact first: a barcode normally carries the whole case number, and
  -- inventory_case_no_idx from 07_case_search.sql makes this a lookup.
  select array_agg(distinct i.location) into v_locs
    from public.inventory i
   where i.case_no = v_case;

  -- Fallback: some labels carry only part of the number. Accept a contains
  -- match ONLY when it resolves to exactly one case number - anything else is
  -- ambiguous, and guessing which case was in someone's hand is worse than
  -- saying it was not found. `_`, `%` and `\` are escaped because real case
  -- numbers contain them (3,213 and 555 of them respectively).
  if v_locs is null then
    select count(distinct i.case_no) into v_n
      from public.inventory i
     where i.case_no ilike '%' ||
           replace(replace(replace(v_case, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    if v_n = 1 then
      select min(i.case_no) into v_case
        from public.inventory i
       where i.case_no ilike '%' ||
             replace(replace(replace(v_case, '\', '\\'), '%', '\%'), '_', '\_') || '%';

      select array_agg(distinct i.location) into v_locs
        from public.inventory i
       where i.case_no = v_case;
    end if;
  end if;

  if v_locs is null then
    v_result := 'not_in_query';
  elsif v_session_loc = any (v_locs) then
    -- Any one of the system locations matching is enough. A case in several
    -- places is genuinely here as well as there.
    v_result := 'match';
  else
    v_result := 'wrong_location';
  end if;

  insert into public.cycle_count_scan (session_id, case_no, result, system_locations)
  values (p_session_id, v_case, v_result, coalesce(v_locs, '{}'))
  on conflict (session_id, case_no) do nothing;

  v_inserted := found;

  -- On a repeat scan, report what was recorded the first time rather than the
  -- freshly computed answer, so the screen always agrees with the stored row.
  if not v_inserted then
    select c.result, c.system_locations into v_result, v_locs
      from public.cycle_count_scan c
     where c.session_id = p_session_id and c.case_no = v_case;
  end if;

  return query select v_case, v_result, coalesce(v_locs, '{}'), not v_inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Close a session
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
   where id = p_session_id and finished_at is null
  returning * into s;

  if s.id is null then
    raise exception 'That count session is already finished, or does not exist.';
  end if;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- What was never scanned - "need check later"
-- ---------------------------------------------------------------------------

create or replace function public.cycle_count_not_checked(p_session_id uuid)
returns table (case_no text)
language sql
stable
security definer
set search_path = public
as $$
  select e.case_no
    from public.cycle_count_expected e
   where e.session_id = p_session_id
     and not exists (
       select 1 from public.cycle_count_scan c
        where c.session_id = e.session_id and c.case_no = e.case_no
     )
   order by e.case_no;
$$;

-- ---------------------------------------------------------------------------
-- One row per session, with the four buckets already counted
-- ---------------------------------------------------------------------------

create or replace view public.cycle_count_summary as
select
  s.id,
  s.location,
  s.started_at,
  s.finished_at,
  s.started_by,
  s.expected_count,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match')          as matched,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'wrong_location') as wrong_location,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'not_in_query')   as not_in_query,
  (select count(*) from public.cycle_count_expected e
    where e.session_id = s.id
      and not exists (select 1 from public.cycle_count_scan c
                       where c.session_id = e.session_id and c.case_no = e.case_no)
  ) as not_checked
from public.cycle_count_session s;

-- ---------------------------------------------------------------------------
-- Permissions
--
-- Reading is for signed-in admins only - unlike inventory, this is a record of
-- who counted what and when, and the search page has no use for it.
--
-- Nothing may be written directly. Every insert goes through the SECURITY
-- DEFINER functions above, so a result cannot be posted straight to the table
-- with a valid JWT and PostgREST.
-- ---------------------------------------------------------------------------

alter table public.cycle_count_session  enable row level security;
alter table public.cycle_count_expected enable row level security;
alter table public.cycle_count_scan     enable row level security;

drop policy if exists cycle_count_session_read  on public.cycle_count_session;
drop policy if exists cycle_count_expected_read on public.cycle_count_expected;
drop policy if exists cycle_count_scan_read     on public.cycle_count_scan;

create policy cycle_count_session_read  on public.cycle_count_session
  for select to authenticated using (true);
create policy cycle_count_expected_read on public.cycle_count_expected
  for select to authenticated using (true);
create policy cycle_count_scan_read     on public.cycle_count_scan
  for select to authenticated using (true);

grant select on public.cycle_count_session  to authenticated;
grant select on public.cycle_count_expected to authenticated;
grant select on public.cycle_count_scan     to authenticated;
grant select on public.cycle_count_summary  to authenticated;

revoke all on function public.start_cycle_count(text)        from public, anon;
revoke all on function public.record_scan(uuid, text)        from public, anon;
revoke all on function public.finish_cycle_count(uuid)       from public, anon;
revoke all on function public.cycle_count_not_checked(uuid)  from public, anon;

grant execute on function public.start_cycle_count(text)       to authenticated;
grant execute on function public.record_scan(uuid, text)       to authenticated;
grant execute on function public.finish_cycle_count(uuid)      to authenticated;
grant execute on function public.cycle_count_not_checked(uuid) to authenticated;


-- ============================================================================
-- Locations to choose from. 4,286 of them hold at least one full case, so the
-- picker needs a searchable list rather than a dropdown.
--
-- anon may read it: it is only shelf names, and it keeps the view usable from
-- the same client as everything else.
-- ============================================================================

drop view if exists public.count_locations;

create view public.count_locations as
select
  i.location,
  count(distinct i.case_no) as full_cases
from public.inventory i
where i.is_case_opened = 'No'
group by i.location
having count(distinct i.case_no) > 0;

grant select on public.count_locations to anon, authenticated;
