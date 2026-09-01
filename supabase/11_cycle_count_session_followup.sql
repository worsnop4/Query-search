-- ============================================================================
-- Cycle count: one reason / action / status per SESSION, plus statistics
-- Run AFTER 10_fix_scan_ambiguity.sql. Safe to run more than once.
--
-- 1. THE FOLLOW-UP MOVES FROM THE CASE TO THE SESSION.
--
--    09 put reason / action / done on every scanned case. The user asked for
--    the opposite: "no need reason for every case number. make reason action,
--    status for 1 location in result or made for 1 session cycle count."
--
--    One count is one location on one day, and the whole location gets one
--    decision - put away, shortage, profit, or shortage + profit. The
--    per-case columns are dropped rather than left behind, because a dead
--    column that still accepts writes is worse than no column at all.
--
--    Anything already typed into those per-case fields is lost. That is only
--    test data: record_scan() did not work at all until 10.
--
-- 2. STATISTICS PER DAY AND PER ADMIN.
--
--    Grouped in ASIA/JAKARTA, not UTC. started_at is a timestamptz written by
--    now(), so it is correct - but "which day was this counted on" is a local
--    question, and a count at 08:00 WIB is 01:00 UTC the same day while one at
--    06:00 WIB is 23:00 UTC the day BEFORE. Grouping in UTC would quietly move
--    early-morning counts into the previous day.
--
--    (This is unrelated to the known inbound_time / first_inbound_time bug,
--    which is about imported TEXT timestamps being read as UTC. That one is
--    still open and does not affect anything here.)
--
--    Accuracy is deliberately NOT computed in these views. It lives in
--    accuracy() in src/lib/cycleCount.js so there is exactly one definition of
--    it, matching the Recap sheet: clean matches over what was scanned.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Move the follow-up onto the session
-- ---------------------------------------------------------------------------

alter table public.cycle_count_session
  add column if not exists reason text,
  add column if not exists action text,
  add column if not exists done   boolean not null default false,
  add column if not exists remark text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cycle_count_session_action_check'
  ) then
    alter table public.cycle_count_session
      add constraint cycle_count_session_action_check
      check (action is null or action in
             ('put_away', 'shortage', 'profit', 'shortage_profit'));
  end if;
end $$;

-- The function first: it returns public.cycle_count_scan, so it has to go
-- before the columns it reads are removed.
drop function if exists public.set_scan_followup(bigint, text, text, boolean, text);

-- The summary view reads cycle_count_scan, so it also has to go before the
-- columns are dropped - and it is rebuilt further down with the session
-- follow-up included.
drop view if exists public.cycle_count_summary cascade;

alter table public.cycle_count_scan
  drop column if exists reason,
  drop column if exists action,
  drop column if exists done,
  drop column if exists remark;

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'cycle_count_scan_action_check'
  ) then
    alter table public.cycle_count_scan drop constraint cycle_count_scan_action_check;
  end if;
end $$;

create or replace function public.set_session_followup(
  p_session_id uuid,
  p_reason     text,
  p_action     text,
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
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  update public.cycle_count_session s
     set reason = nullif(trim(coalesce(p_reason, '')), ''),
         action = nullif(trim(coalesce(p_action, '')), ''),
         done   = coalesce(p_done, false),
         remark = nullif(trim(coalesce(p_remark, '')), '')
   where s.id = p_session_id
  returning s.* into r;

  if r.id is null then
    raise exception 'No such cycle count.';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Summary, now carrying the session's decision
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
  ) as not_checked
from public.cycle_count_session s;

-- ---------------------------------------------------------------------------
-- 3. Statistics
--
-- Only FINISHED counts. A session still open, or one that was cancelled, says
-- nothing about how accurate the warehouse is.
-- ---------------------------------------------------------------------------

drop view if exists public.cycle_count_daily;

create view public.cycle_count_daily as
select
  (started_at at time zone 'Asia/Jakarta')::date as count_date,
  started_by,
  started_by_uid,
  count(*)                    as sessions,
  count(distinct location)    as locations,
  sum(scanned)                as scanned,
  sum(clean_match)            as clean_match,
  sum(opened_mismatch)        as opened_mismatch,
  sum(wrong_location)         as wrong_location,
  sum(not_in_query)           as not_in_query,
  sum(not_checked)            as not_checked,
  sum(expected_count)         as expected_count
from public.cycle_count_summary
where finished_at is not null
group by 1, 2, 3;

drop view if exists public.cycle_count_by_admin;

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

-- ---------------------------------------------------------------------------
-- Permissions
--
-- cycle_count_summary was dropped with CASCADE above, which takes its grants
-- with it - and a lost grant fails closed, so the page would simply stop
-- working for a signed-in admin. Reapply everything.
-- ---------------------------------------------------------------------------

grant select on public.cycle_count_summary  to authenticated;
grant select on public.cycle_count_daily    to authenticated;
grant select on public.cycle_count_by_admin to authenticated;

revoke all on function public.set_session_followup(uuid, text, text, boolean, text)
  from public, anon;
grant execute on function public.set_session_followup(uuid, text, text, boolean, text)
  to authenticated;


-- ============================================================================
-- CHECK - the summary must still be readable, and the day must be the LOCAL
-- day. A count started at 23:30 UTC belongs to the next day in Jakarta.
-- ============================================================================
-- select count_date, started_by, sessions, locations, scanned, clean_match
--   from public.cycle_count_daily order by count_date desc limit 10;
--
-- select (timestamptz '2026-08-31 23:30:00+00' at time zone 'Asia/Jakarta')::date
--        as should_be_2026_09_01;
