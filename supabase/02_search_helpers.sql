-- ============================================================================
-- Search page helpers - run this AFTER setup.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
-- ============================================================================


-- Which of the searched part numbers actually exist in inventory?
--
-- The search page needs this to tell you "you searched for 5 parts, 2 of them
-- have no stock". It cannot work that out from the results table, because
-- results are paginated - page 1 only proves what is on page 1.
--
-- Returns the DISTINCT matching part numbers, so the answer is a handful of
-- rows even when the parts themselves have thousands of inventory rows.
create or replace function public.found_part_numbers(pns text[])
returns table (part_number text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct i.part_number
  from public.inventory i
  where i.part_number = any(pns);
$$;

grant execute on function public.found_part_numbers(text[]) to anon, authenticated;


-- ============================================================================
-- Corrected search_results view - the version in setup.sql was missing
-- is_case_opened. The app queries the tables directly today, so this is only
-- here to keep the view honest for later use.
--
-- DROP first, not CREATE OR REPLACE: replacing a view can only append columns
-- at the end, never rename or reorder existing ones, and this version moves
-- case_no earlier in the list. Nothing depends on this view yet, so dropping
-- it is free.
-- ============================================================================
drop view if exists public.search_results;

create view public.search_results as
select
  i.part_number,
  m.part_name,
  i.case_no,
  i.location,
  i.quantity,
  i.is_case_opened,
  m.car_type,
  m.dloc,
  i.zone_type,
  i.area,
  i.status,
  i.inbound_time
from public.inventory i
left join public.master_data m on m.part_number = i.part_number;

alter view public.search_results set (security_invoker = on);
grant select on public.search_results to anon, authenticated;
