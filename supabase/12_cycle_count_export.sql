-- ============================================================================
-- One flat row per case, across every finished count and every admin
-- Run AFTER 11_cycle_count_session_followup.sql. Safe to run more than once.
--
-- The per-session download already covers one count. This is the whole
-- history: every case anyone counted, plus every case Query expected that
-- nobody scanned - "i need all case counting and need check case also
-- included. and every admin."
--
-- WHY A VIEW AND NOT A JOIN IN THE BROWSER
--
-- The "need check" cases are the awkward half: they live in
-- cycle_count_expected and are defined by their ABSENCE from
-- cycle_count_scan. Working that out client-side means pulling both tables
-- whole and subtracting - and cycle_count_expected is the big one, since a
-- single count of TRANSIT freezes 3,252 rows into it. Postgres does the
-- anti-join here and the browser pages through the result.
--
-- ORDERING: (session_id, case_no) is unique across the union - scans are
-- unique on it by constraint, expected by primary key, and the WHERE below
-- guarantees a case is never in both halves. So it is a safe, stable sort key
-- for paging, which matters: PostgREST caps a response at 1,000 rows and an
-- unstable sort would silently repeat one row and drop another.
--
-- FINISHED COUNTS ONLY, like cycle_count_daily. A count still in progress has
-- an incomplete "need check" list by definition, and exporting it would read
-- as lost stock that is simply not scanned yet.
-- ============================================================================

drop view if exists public.cycle_count_rows;

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
  -- Query said it was here; that is precisely why it was expected.
  array[s.location]  as system_locations,
  null::timestamptz  as scanned_at
from public.cycle_count_session s
join public.cycle_count_expected e on e.session_id = s.id
where s.finished_at is not null
  and not exists (
    select 1 from public.cycle_count_scan c
     where c.session_id = e.session_id and c.case_no = e.case_no
  );

grant select on public.cycle_count_rows to authenticated;


-- ============================================================================
-- CHECK - the two halves must add up, and no case may appear twice in one
-- session.
-- ============================================================================
-- select count(*) as rows,
--        count(*) filter (where result = 'not_checked') as need_check,
--        count(distinct session_id) as counts,
--        count(distinct started_by) as admins
--   from public.cycle_count_rows;
--
-- -- must return no rows:
-- select session_id, case_no, count(*)
--   from public.cycle_count_rows
--  group by 1, 2 having count(*) > 1;
