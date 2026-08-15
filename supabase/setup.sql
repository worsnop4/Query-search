-- ============================================================================
-- Inventory Search Website - Supabase setup
-- Run this whole file in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- It is safe to run more than once (idempotent).
--
-- BUT if you have already run 02_search_helpers.sql / 03_upload_log.sql, run
-- them AGAIN afterwards. This file re-creates objects those two later replace:
-- the search_results view (03's version has is_case_opened) and the swap
-- functions (03's versions write to upload_log, which is what feeds the
-- "Last update" shown in the header). Re-running this file alone silently
-- reverts both.
-- ============================================================================


-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists public.inventory (
  id                 bigserial primary key,
  part_number        text not null,
  supplier_code      text,
  case_no            text,
  location           text,
  zone_type          text,
  quantity           numeric,
  status             text,
  is_case_opened     text,
  inbound_time       timestamptz,
  first_inbound_time timestamptz
);

-- Derived columns. NOT uploaded - filled automatically by swap_inventory()
-- using the mapping functions in section 3.
alter table public.inventory add column if not exists zonetype text;
alter table public.inventory add column if not exists area     text;

create table if not exists public.master_data (
  part_number text primary key,
  part_name   text,
  car_type    text,
  dloc        text
);


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

create index if not exists inventory_part_number_idx on public.inventory (part_number);
create index if not exists inventory_location_idx    on public.inventory (location);
create index if not exists inventory_area_idx        on public.inventory (area);


-- ============================================================================
-- 3. ZONE TYPE -> ZONETYPE -> AREA MAPPING
--    This replaces the two Excel formula columns (Zonetype 1, Area).
--    Kept in SQL so the rules can be changed later without re-uploading
--    the 195k-row file - see section 8 for the one-line refresh statement.
-- ============================================================================

-- Stage 1: Zone Type -> Zonetype
create or replace function public.calc_zonetype(p_zone_type text)
returns text
language sql
immutable
as $$
  select case lower(trim(coalesce(p_zone_type, '')))
    when 'dloc area'       then 'DLOC'
    when 'stock area-loc'  then 'HR'
    when 'of area'         then 'OF'
    when 'stock area-temp' then 'Transit'
    when 'stock area a'    then 'OF'
    when 'stock area-ow'   then 'OW'
    when 'hold area'       then 'Transit'
    else ''
  end;
$$;

-- Stage 2: Zonetype + Location -> Area
-- If Zonetype is not 'OW', Area = Zonetype.
-- If Zonetype is 'OW', scan Location for substrings, first match wins,
-- in exactly the order below (mirrors nested Excel SEARCH).
create or replace function public.calc_area(p_zone_type text, p_location text)
returns text
language plpgsql
immutable
as $$
declare
  zt  text := public.calc_zonetype(p_zone_type);
  loc text := upper(coalesce(p_location, ''));
begin
  if zt <> 'OW' then
    return zt;
  end if;

  if loc like '%XIN1%'      then return 'XIN1';        end if;
  if loc like '%XIN2%'      then return 'XIN2';        end if;
  if loc like '%YOBU%'      then return 'YOBU';        end if;
  if loc like '%LZ%'        then return 'Luzhou';      end if;
  if loc like '%NLY%'       then return 'New Lingyun'; end if;
  if loc like '%OLY%'       then return 'Old Lingyun'; end if;
  if loc like '%NXT%'       then return 'Nexteer';     end if;
  if loc like '%BST%'       then return 'Baosteel';    end if;
  if loc like '%OWZ%'       then return 'Wenzhou';     end if;
  if loc like '%LOC%'       then return 'Transit';     end if;
  if loc like '%BAOSTEEL%'  then return 'Baosteel';    end if;
  if loc like '%BT-CANOPI%' then return 'Baosteel';    end if;
  if loc like '%CRRC%'      then return 'CRRC';        end if;
  if loc like '%YNF%'       then return 'YANFENG';     end if;
  if loc like '%VDC%'       then return 'VDC';         end if;

  return '';
end;
$$;


-- ============================================================================
-- 4. STAGING TABLES + ATOMIC SWAP
--    Upload writes to the *_staging table. Only when every chunk has landed
--    and the row count matches does the swap function replace the live table,
--    inside a single transaction. A failed or abandoned upload can never
--    leave the live table empty.
-- ============================================================================

create table if not exists public.inventory_staging (
  part_number        text,
  supplier_code      text,
  case_no            text,
  location           text,
  zone_type          text,
  quantity           numeric,
  status             text,
  is_case_opened     text,
  inbound_time       timestamptz,
  first_inbound_time timestamptz
);

create table if not exists public.master_data_staging (
  part_number text,
  part_name   text,
  car_type    text,
  dloc        text
);


-- Called by the app before the first chunk, to clear leftovers.
create or replace function public.reset_inventory_staging()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate public.inventory_staging;
end;
$$;

create or replace function public.reset_master_data_staging()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate public.master_data_staging;
end;
$$;


-- Called by the app after the last chunk. Pass the number of rows the
-- parser produced; the function refuses to swap unless staging matches.
--
-- statement_timeout: Supabase caps the `authenticated` role at 8 seconds by
-- default. This function truncates and re-inserts ~195,000 rows, computing
-- calc_area() per row and maintaining three indexes, which takes far longer
-- than that - without the override the swap is cancelled and rolled back every
-- time, and no upload can ever complete. If the platform still cancels it,
-- raise the role-level limit too:
--   alter role authenticated set statement_timeout = '5min';
--   notify pgrst, 'reload config';
create or replace function public.swap_inventory(expected_rows bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '5min'
as $$
declare
  staged bigint;
begin
  select count(*) into staged from public.inventory_staging;

  if staged = 0 then
    raise exception 'Refusing to swap: staging table is empty';
  end if;

  if staged <> expected_rows then
    raise exception 'Refusing to swap: expected % rows, staging has %',
      expected_rows, staged;
  end if;

  truncate public.inventory;

  insert into public.inventory (
    part_number, supplier_code, case_no, location, zone_type,
    quantity, status, is_case_opened, inbound_time, first_inbound_time,
    zonetype, area
  )
  select
    part_number, supplier_code, case_no, location, zone_type,
    quantity, status, is_case_opened, inbound_time, first_inbound_time,
    public.calc_zonetype(zone_type),
    public.calc_area(zone_type, location)
  from public.inventory_staging;

  truncate public.inventory_staging;

  return staged;
end;
$$;


create or replace function public.swap_master_data(expected_rows bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '5min'
as $$
declare
  staged bigint;
begin
  select count(*) into staged from public.master_data_staging;

  if staged = 0 then
    raise exception 'Refusing to swap: staging table is empty';
  end if;

  if staged <> expected_rows then
    raise exception 'Refusing to swap: expected % rows, staging has %',
      expected_rows, staged;
  end if;

  truncate public.master_data;

  -- Second safety net for de-duplication; the parser also de-dupes.
  insert into public.master_data (part_number, part_name, car_type, dloc)
  select distinct on (part_number)
    part_number, part_name, car_type, dloc
  from public.master_data_staging
  where part_number is not null and trim(part_number) <> ''
  order by part_number,
           (nullif(trim(coalesce(part_name, '')), '') is null),  -- non-blank name first
           (nullif(trim(coalesce(dloc,      '')), '') is null);

  truncate public.master_data_staging;

  return staged;
end;
$$;


-- ============================================================================
-- 5. READ VIEWS (dashboard + breakdown)
--    Views, not RPCs, so the app can filter/paginate/sort with the normal
--    Supabase query builder: .ilike(), .range(), .order()
-- ============================================================================

-- Dashboard: per raw location
create or replace view public.dashboard_by_location as
select
  location,
  count(distinct part_number) as part_count,
  coalesce(sum(quantity), 0)  as total_qty
from public.inventory
group by location;

-- Dashboard: per mapped area (usually the more useful one)
create or replace view public.dashboard_by_area as
select
  area,
  count(distinct part_number) as part_count,
  coalesce(sum(quantity), 0)  as total_qty
from public.inventory
group by area;


-- Breakdown pivot: one row per part number, one column per site.
-- Totals are included; Status and GAP are computed in the app so the two
-- minimum-stock thresholds stay editable on the page.
create or replace view public.breakdown as
select
  i.part_number,
  m.part_name,
  m.dloc as master_dloc,

  -- LOC group
  coalesce(sum(i.quantity) filter (where i.area = 'DLOC'),        0) as loc_dloc,
  coalesce(sum(i.quantity) filter (where i.area = 'HR'),          0) as loc_hr,
  coalesce(sum(i.quantity) filter (where i.area = 'OF'),          0) as loc_of,
  coalesce(sum(i.quantity) filter (where i.area = 'Transit'),     0) as loc_transit,
  coalesce(sum(i.quantity) filter (where i.area in
    ('DLOC','HR','OF','Transit')),                                0) as loc_total,

  -- OW / SAIC group   (Area 'VDC' is shown as column "VDC5",
  --                    Area 'YANFENG' is shown as column "Yanfeng")
  coalesce(sum(i.quantity) filter (where i.area = 'Luzhou'),      0) as ow_luzhou,
  coalesce(sum(i.quantity) filter (where i.area = 'VDC'),         0) as ow_vdc5,
  coalesce(sum(i.quantity) filter (where i.area = 'Wenzhou'),     0) as ow_wenzhou,
  coalesce(sum(i.quantity) filter (where i.area = 'New Lingyun'), 0) as ow_new_lingyun,
  coalesce(sum(i.quantity) filter (where i.area = 'Nexteer'),     0) as ow_nexteer,
  coalesce(sum(i.quantity) filter (where i.area = 'Old Lingyun'), 0) as ow_old_lingyun,
  coalesce(sum(i.quantity) filter (where i.area = 'YOBU'),        0) as ow_yobu,
  coalesce(sum(i.quantity) filter (where i.area = 'CRRC'),        0) as ow_crrc,
  coalesce(sum(i.quantity) filter (where i.area = 'YANFENG'),     0) as ow_yanfeng,
  coalesce(sum(i.quantity) filter (where i.area = 'Baosteel'),    0) as ow_baosteel,
  coalesce(sum(i.quantity) filter (where i.area in
    ('Luzhou','VDC','Wenzhou','New Lingyun','Nexteer','Old Lingyun',
     'YOBU','CRRC','YANFENG','Baosteel')),                        0) as ow_total,

  -- NON-SAIC group
  coalesce(sum(i.quantity) filter (where i.area = 'XIN1'),        0) as nonsaic_xin1,
  coalesce(sum(i.quantity) filter (where i.area = 'XIN2'),        0) as nonsaic_xin2,
  coalesce(sum(i.quantity) filter (where i.area in
    ('XIN1','XIN2')),                                             0) as nonsaic_total,

  coalesce(sum(i.quantity), 0) as grand_total
from public.inventory i
left join public.master_data m on m.part_number = i.part_number
group by i.part_number, m.part_name, m.dloc;


-- Search: inventory joined to master data, columns in display order.
-- DROP first, not CREATE OR REPLACE: 02_search_helpers.sql redefines this view
-- with the columns in a different order, and CREATE OR REPLACE can only append
-- columns - it cannot rename or reorder them. Without the drop, re-running
-- this file after 02 fails with "cannot change name of view column", and the
-- SQL Editor rolls the whole script back.
drop view if exists public.search_results;

create view public.search_results as
select
  i.part_number,
  m.part_name,
  i.location,
  i.quantity,
  m.car_type,
  m.dloc,
  i.zone_type,
  i.area,
  i.status,
  i.case_no,
  i.inbound_time
from public.inventory i
left join public.master_data m on m.part_number = i.part_number;


-- Make views respect the caller's RLS instead of the view owner's.
alter view public.dashboard_by_location set (security_invoker = on);
alter view public.dashboard_by_area     set (security_invoker = on);
alter view public.breakdown             set (security_invoker = on);
alter view public.search_results        set (security_invoker = on);


-- ============================================================================
-- 6. ROW LEVEL SECURITY
--    Public (anon): read live tables and views only.
--    Authenticated:  additionally write to the staging tables.
--    Nobody writes to the live tables directly - only swap_*(), which is
--    SECURITY DEFINER and therefore bypasses RLS.
-- ============================================================================

alter table public.inventory           enable row level security;
alter table public.master_data         enable row level security;
alter table public.inventory_staging   enable row level security;
alter table public.master_data_staging enable row level security;

drop policy if exists inventory_public_read   on public.inventory;
drop policy if exists master_data_public_read on public.master_data;
drop policy if exists inventory_staging_write   on public.inventory_staging;
drop policy if exists master_data_staging_write on public.master_data_staging;

create policy inventory_public_read
  on public.inventory for select
  to anon, authenticated
  using (true);

create policy master_data_public_read
  on public.master_data for select
  to anon, authenticated
  using (true);

create policy inventory_staging_write
  on public.inventory_staging for all
  to authenticated
  using (true) with check (true);

create policy master_data_staging_write
  on public.master_data_staging for all
  to authenticated
  using (true) with check (true);


-- Grants: anon may read, only authenticated may run the upload functions.
grant select on
  public.dashboard_by_location,
  public.dashboard_by_area,
  public.breakdown,
  public.search_results
to anon, authenticated;

revoke all on function public.reset_inventory_staging()   from public, anon;
revoke all on function public.reset_master_data_staging() from public, anon;
revoke all on function public.swap_inventory(bigint)      from public, anon;
revoke all on function public.swap_master_data(bigint)    from public, anon;

grant execute on function public.reset_inventory_staging()   to authenticated;
grant execute on function public.reset_master_data_staging() to authenticated;
grant execute on function public.swap_inventory(bigint)      to authenticated;
grant execute on function public.swap_master_data(bigint)    to authenticated;


-- ============================================================================
-- 7. QUICK CHECKS - run these after your first upload
-- ============================================================================
-- select count(*) from public.inventory;
-- select area, count(*) from public.inventory group by area order by 2 desc;
--   ^ an unexpectedly large '' (blank) bucket means a Zone Type value or a
--     Location code is missing from the mapping in section 3.
-- select * from public.breakdown limit 20;
-- select * from public.dashboard_by_area;


-- ============================================================================
-- 8. IF THE MAPPING RULES EVER CHANGE
--    Edit calc_zonetype / calc_area above, re-run section 3, then run this.
--    No re-upload needed.
-- ============================================================================
-- update public.inventory
--    set zonetype = public.calc_zonetype(zone_type),
--        area     = public.calc_area(zone_type, location);
