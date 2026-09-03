-- ============================================================================
-- An opened case is opened, wherever Query says it is
-- Run AFTER 16_multi_action.sql. Safe to run more than once.
--
-- MUST RUN AFTER 16. That file rebuilds cycle_count_summary with the old
-- bucketing, so running it afterwards would silently undo this.
--
-- THE RULE, FROM THE USER
--
--   "in case opened we can never meet case right location but open, because
--    every case open will automatic change location. so in that case opened
--    count all case open no need in right location"
--
-- Opening a case in the WMS moves it. So "scanned at the right location AND
-- Query has it opened" cannot happen - and the opened_mismatch counter, which
-- required exactly that, was permanently 0. Every opened case was landing in
-- wrong_location instead, which is why a count could show "Opened 0, Wrong
-- location 8" while the put-away warning underneath listed 7 opened cases.
--
-- So the opened flag now decides the bucket on its own:
--
--   clean_match      right place, and Query does not have it opened
--   opened_mismatch  Query has it opened, WHATEVER the location
--   wrong_location   wrong place, and not opened
--   not_in_query     unchanged (a case Query has never seen cannot be opened)
--
-- The four still add up to `scanned`, and `clean_match` is untouched - so the
-- accuracy figure and every number already recorded stay exactly as they were.
--
-- `create or replace` is enough here: the column names, types and order are
-- unchanged, only the expressions behind three of them. No cascade, so
-- cycle_count_daily, cycle_count_by_admin and cycle_count_by_area keep working
-- and no grant is lost.
-- ============================================================================

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
  -- Unchanged: a clean match was already "right place and not opened".
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'match'
      and not c.query_opened)                                  as clean_match,
  -- Every opened case, whatever its location.
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.query_opened)              as opened_mismatch,
  -- Wrong place, and not opened - otherwise it would be counted twice.
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'wrong_location'
      and not c.query_opened)                                  as wrong_location,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id and c.result = 'not_in_query'
      and not c.query_opened)                                  as not_in_query,
  (select count(*) from public.cycle_count_scan c
    where c.session_id = s.id)                                 as scanned,
  (select count(*) from public.cycle_count_expected e
    where e.session_id = s.id
      and not exists (select 1 from public.cycle_count_scan c
                       where c.session_id = e.session_id and c.case_no = e.case_no)
  ) as not_checked,
  s.area
from public.cycle_count_session s;

grant select on public.cycle_count_summary to authenticated;


-- ============================================================================
-- CHECK - the four buckets must still add up to what was scanned, for every
-- count ever taken. This must return NO ROWS.
-- ============================================================================
-- select id, location,
--        clean_match, opened_mismatch, wrong_location, not_in_query, scanned
--   from public.cycle_count_summary
--  where clean_match + opened_mismatch + wrong_location + not_in_query <> scanned;
--
-- -- And the counts that were already taken, to see what moved:
-- select location, clean_match, opened_mismatch, wrong_location, not_in_query
--   from public.cycle_count_summary
--  where finished_at is not null
--  order by started_at desc limit 10;
