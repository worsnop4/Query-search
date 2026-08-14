-- ============================================================================
-- Upload log - run this AFTER setup.sql and 02_search_helpers.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
--
-- Records every successful data replacement so the site can show
-- "Last update: ..." to everyone, not just admins.
-- ============================================================================

create table if not exists public.upload_log (
  id             bigserial primary key,
  table_name     text        not null,
  row_count      bigint      not null,
  uploaded_at    timestamptz not null default now(),
  uploaded_by    uuid,
  uploaded_email text
);

create index if not exists upload_log_table_time_idx
  on public.upload_log (table_name, uploaded_at desc);

alter table public.upload_log enable row level security;

-- Anyone can read it (the header shows the timestamp publicly). Nobody writes
-- to it directly - only the swap functions do, and they are SECURITY DEFINER.
drop policy if exists upload_log_public_read on public.upload_log;
create policy upload_log_public_read
  on public.upload_log for select
  to anon, authenticated
  using (true);


-- ============================================================================
-- Swap functions, now logging. Bodies are otherwise unchanged from setup.sql.
-- ============================================================================

create or replace function public.swap_inventory(expected_rows bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
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

  insert into public.upload_log (table_name, row_count, uploaded_by, uploaded_email)
  values ('inventory', staged, auth.uid(),
          coalesce(auth.jwt() ->> 'email', 'system'));

  return staged;
end;
$$;


create or replace function public.swap_master_data(expected_rows bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
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

  insert into public.master_data (part_number, part_name, car_type, dloc)
  select distinct on (part_number)
    part_number, part_name, car_type, dloc
  from public.master_data_staging
  where part_number is not null and trim(part_number) <> ''
  order by part_number,
           (nullif(trim(coalesce(part_name, '')), '') is null),
           (nullif(trim(coalesce(dloc,      '')), '') is null);

  truncate public.master_data_staging;

  insert into public.upload_log (table_name, row_count, uploaded_by, uploaded_email)
  values ('master_data', staged, auth.uid(),
          coalesce(auth.jwt() ->> 'email', 'system'));

  return staged;
end;
$$;

grant execute on function public.swap_inventory(bigint)   to authenticated;
grant execute on function public.swap_master_data(bigint) to authenticated;


-- ============================================================================
-- Latest upload per table, for the header. One row per table.
-- ============================================================================
create or replace view public.latest_upload as
select distinct on (table_name)
  table_name, row_count, uploaded_at, uploaded_email
from public.upload_log
order by table_name, uploaded_at desc;

alter view public.latest_upload set (security_invoker = on);
grant select on public.latest_upload to anon, authenticated;


-- ============================================================================
-- Backfill: the current data was loaded by CSV import before this log existed,
-- so record it once. Does nothing if the log already has entries.
--
-- NOTE the shape of these statements. Writing it as
--   select 'inventory', count(*) from public.inventory where not exists (...)
-- is WRONG: when the guard is false no rows survive the WHERE, but an
-- aggregate over an empty set still returns one row containing 0 - so every
-- re-run would append a bogus "0 rows" entry and the header would show 0.
-- With no FROM clause and the count as a scalar subquery, a false WHERE
-- correctly produces no row at all.
-- ============================================================================
insert into public.upload_log (table_name, row_count, uploaded_email)
select 'inventory', (select count(*) from public.inventory), 'initial CSV load'
where not exists (select 1 from public.upload_log where table_name = 'inventory')
  and (select count(*) from public.inventory) > 0;

insert into public.upload_log (table_name, row_count, uploaded_email)
select 'master_data', (select count(*) from public.master_data), 'initial CSV load'
where not exists (select 1 from public.upload_log where table_name = 'master_data')
  and (select count(*) from public.master_data) > 0;
