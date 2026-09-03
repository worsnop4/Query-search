-- ============================================================================
-- Part Type on master data, and the TRANSIT monitor
-- Run AFTER 16_multi_action.sql. Safe to run more than once.
--
-- 1. PART TYPE
--
--    The transit monitor watches SMALL PART cases specifically, and Part Type
--    is the one PFEP column we never imported. It is column AR in
--    "PFEP Simple Master Data", header exactly "Part Type", values like
--    "SMALL PART". The parser maps by header NAME, so it only needed adding to
--    MASTER_FIELDS - but the column has to exist here first, and the swap has
--    to carry it across or every upload would silently blank it.
--
--    AFTER RUNNING THIS, RE-UPLOAD THE PFEP FILE. Until then part_type is null
--    for every part and the transit monitor has nothing to filter on.
--
-- 2. THE TIMESTAMP TIMEZONE
--
--    Not fixed here, because it does not need to be: `swap_inventory()`
--    truncates and re-inserts, so the next Query upload replaces every row.
--    The parser now attaches +07:00 to the WMS's local timestamps
--    (normTimestamp in parse.js), so the correction arrives with the next
--    upload and no backfill has to be run - which is the safer option, since a
--    shifting UPDATE that ran twice would be very hard to notice.
--
--    Until that upload happens the aging is a day out for the 15.6% of TRANSIT
--    rows whose stored hour is 17:00 or later.
-- ============================================================================

alter table public.master_data         add column if not exists part_type text;
alter table public.master_data_staging add column if not exists part_type text;

-- Carried through the swap. Redefined in full rather than patched, so the
-- column list is visible in one place.
create or replace function public.swap_master_data(expected_rows bigint, p_session_id uuid)
returns bigint
language plpgsql
security definer
-- Supabase caps the `authenticated` role at 8s, which a full swap blows
-- through. Without this no upload can ever complete.
set statement_timeout = '5min'
set search_path = public
as $$
declare
  staged bigint;
begin
  perform public.assert_holds_claim(p_session_id, 'master_data');

  select count(*) into staged from public.master_data_staging;
  if staged <> expected_rows then
    raise exception 'Staged % rows but expected % - upload aborted, live data untouched.',
      staged, expected_rows;
  end if;

  truncate public.master_data;

  insert into public.master_data (part_number, part_name, car_type, dloc, part_type)
  select distinct on (part_number)
    part_number, part_name, car_type, dloc, part_type
  from public.master_data_staging
  where part_number is not null and trim(part_number) <> ''
  order by part_number,
           (nullif(trim(coalesce(part_name, '')), '') is null),
           (nullif(trim(coalesce(dloc,      '')), '') is null);

  truncate public.master_data_staging;

  insert into public.upload_log (table_name, row_count, uploaded_email)
  values ('master_data',
          (select count(*) from public.master_data),
          public.email_display_name(auth.jwt() ->> 'email'));

  return (select count(*) from public.master_data);
end;
$$;

revoke all on function public.swap_master_data(bigint, uuid) from public, anon;
grant execute on function public.swap_master_data(bigint, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The TRANSIT monitor
--
-- ONE ROW PER CASE, not per inventory row. A case at TRANSIT holds several
-- part rows - 6,893 rows for 3,360 cases today - and the monitor counts cases,
-- so the grouping belongs in Postgres rather than in the browser.
--
-- `location = 'TRANSIT'` exactly, the user's own rule. The area called
-- "Transit" covers 86 locations; this is only the one bare bay.
--
-- Aging is deliberately NOT computed here. It depends on "today", and putting
-- a clock inside a view means the number changes shape depending on when it is
-- read; ageInDays() in transit.js owns it, with one definition covering the
-- screen, the buckets and the export.
-- ---------------------------------------------------------------------------

drop view if exists public.transit_cases;

create view public.transit_cases as
select
  i.case_no,
  -- The earliest arrival of anything in the case: the case has been sitting
  -- there since its first row landed.
  min(i.first_inbound_time)                        as first_inbound_time,
  count(*)                                         as row_count,
  count(distinct i.part_number)                    as part_count,
  sum(i.quantity)                                  as quantity,
  bool_or(i.is_case_opened = 'Yes')                as opened,
  -- A case counts as small-part if ANY part in it is one, which is what their
  -- FILTER on the Compare sheet does.
  bool_or(m.part_type = 'SMALL PART')              as has_small_part,
  min(i.part_number)                               as part_number,
  min(m.part_name)                                 as part_name,
  min(m.part_type)                                 as part_type
from public.inventory i
left join public.master_data m on m.part_number = i.part_number
where i.location = 'TRANSIT'
group by i.case_no;

grant select on public.transit_cases to authenticated;


-- ============================================================================
-- CHECK - part_type should be filled after the PFEP re-upload, and the view
-- should return one row per case.
-- ============================================================================
-- select count(*) filter (where part_type is not null) as with_type,
--        count(*) as parts
--   from public.master_data;
--
-- select count(*) as cases,
--        count(*) filter (where has_small_part) as small_part_cases
--   from public.transit_cases;
