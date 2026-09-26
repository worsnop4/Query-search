-- ============================================================================
-- 19_case_details.sql
-- Case tracking details:
-- 1. case_containers: maps case_no -> container_code (from "Case cont.xlsx")
-- 2. container_destinations: maps container_code -> unload_destination (from "cont dest.xlsx")
-- 3. case_details: view joining both tables
-- ============================================================================

-- ---------------------------------------------------------------- Tables
create table if not exists public.case_containers (
  case_no        text primary key,
  container_code text not null,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_case_containers_container
  on public.case_containers (container_code);

create index if not exists idx_case_containers_updated_at
  on public.case_containers (updated_at);

create table if not exists public.container_destinations (
  container_code     text primary key,
  unload_destination text not null,
  updated_at         timestamptz not null default now()
);

create index if not exists idx_container_destinations_updated_at
  on public.container_destinations (updated_at);

-- Drop legacy table or view if migrating from earlier case_details setup
drop table if exists public.case_details cascade;
drop view if exists public.case_details cascade;

-- View joining case and container destination
create or replace view public.case_details as
select
  c.case_no,
  c.container_code,
  d.unload_destination,
  c.updated_at as case_updated_at,
  d.updated_at as dest_updated_at,
  greatest(c.updated_at, d.updated_at) as updated_at
from public.case_containers c
left join public.container_destinations d
  on d.container_code = c.container_code;

-- ---------------------------------------------------------------- RLS
alter table public.case_containers enable row level security;
alter table public.container_destinations enable row level security;

drop policy if exists "Anyone can read case_containers" on public.case_containers;
create policy "Anyone can read case_containers"
  on public.case_containers for select
  using (true);

drop policy if exists "Authenticated can modify case_containers" on public.case_containers;
create policy "Authenticated can modify case_containers"
  on public.case_containers for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Anyone can read container_destinations" on public.container_destinations;
create policy "Anyone can read container_destinations"
  on public.container_destinations for select
  using (true);

drop policy if exists "Authenticated can modify container_destinations" on public.container_destinations;
create policy "Authenticated can modify container_destinations"
  on public.container_destinations for all
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------- Drop Existing Functions
-- Required because PostgreSQL disallows changing the return table type of an existing function
drop function if exists public.get_case_details_stats();
drop function if exists public.get_case_detail(text);
drop function if exists public.get_case_destinations_batch(text[]);
drop function if exists public.upsert_case_containers_batch(jsonb);
drop function if exists public.upsert_container_destinations_batch(jsonb);
drop function if exists public.delete_case_details_before(timestamptz);
-- Clean up legacy functions from previous implementation
drop function if exists public.upsert_case_shipping_batch(jsonb);
drop function if exists public.upsert_case_unpack_batch(jsonb);

-- ---------------------------------------------------------------- Upsert Batch: Case & Container
create or replace function public.upsert_case_containers_batch(p_rows jsonb)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  inserted_count bigint;
begin
  with data as (
    select
      upper(trim(r->>'case_no')) as c_no,
      upper(trim(r->>'container_code')) as c_code
    from jsonb_array_elements(p_rows) r
    where r->>'case_no' is not null and trim(r->>'case_no') <> ''
      and r->>'container_code' is not null and trim(r->>'container_code') <> ''
  ),
  deduped as (
    select distinct on (c_no)
      c_no, c_code
    from data
  )
  insert into public.case_containers (
    case_no,
    container_code,
    updated_at
  )
  select
    c_no,
    c_code,
    now()
  from deduped
  on conflict (case_no) do update set
    container_code = excluded.container_code,
    updated_at     = excluded.updated_at;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- ---------------------------------------------------------------- Upsert Batch: Container & Destination
create or replace function public.upsert_container_destinations_batch(p_rows jsonb)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  inserted_count bigint;
begin
  with data as (
    select
      upper(trim(r->>'container_code')) as c_code,
      trim(r->>'unload_destination') as u_dest
    from jsonb_array_elements(p_rows) r
    where r->>'container_code' is not null and trim(r->>'container_code') <> ''
      and r->>'unload_destination' is not null and trim(r->>'unload_destination') <> ''
  ),
  deduped as (
    select distinct on (c_code)
      c_code, u_dest
    from data
  )
  insert into public.container_destinations (
    container_code,
    unload_destination,
    updated_at
  )
  select
    c_code,
    u_dest,
    now()
  from deduped
  on conflict (container_code) do update set
    unload_destination = excluded.unload_destination,
    updated_at         = excluded.updated_at;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- ---------------------------------------------------------------- Lookups
create or replace function public.get_case_detail(p_case_no text)
returns table (
  case_no            text,
  container_code     text,
  unload_destination text
)
language sql
security definer
set search_path = public
as $$
  select
    c.case_no,
    c.container_code,
    d.unload_destination
  from public.case_containers c
  left join public.container_destinations d
    on d.container_code = c.container_code
  where c.case_no = upper(trim(p_case_no))
  limit 1;
$$;

-- Batch lookup for multiple cases (used on search results page)
create or replace function public.get_case_destinations_batch(p_cases text[])
returns table (
  case_no            text,
  container_code     text,
  unload_destination text
)
language sql
security definer
set search_path = public
as $$
  select
    c.case_no,
    c.container_code,
    d.unload_destination
  from public.case_containers c
  left join public.container_destinations d
    on d.container_code = c.container_code
  where c.case_no = any(p_cases);
$$;

-- ---------------------------------------------------------------- Stats & Cleanup
create or replace function public.get_case_details_stats()
returns table (
  case_count      bigint,
  container_count bigint,
  oldest_date     timestamptz,
  newest_date     timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*)::bigint from public.case_containers) as case_count,
    (select count(*)::bigint from public.container_destinations) as container_count,
    least(
      (select min(updated_at) from public.case_containers),
      (select min(updated_at) from public.container_destinations)
    ) as oldest_date,
    greatest(
      (select max(updated_at) from public.case_containers),
      (select max(updated_at) from public.container_destinations)
    ) as newest_date;
$$;

create or replace function public.delete_case_details_before(p_cutoff timestamptz)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  deleted_cases bigint;
  deleted_conts bigint;
begin
  delete from public.case_containers
  where updated_at < p_cutoff;
  get diagnostics deleted_cases = row_count;

  delete from public.container_destinations
  where updated_at < p_cutoff;
  get diagnostics deleted_conts = row_count;

  return deleted_cases + deleted_conts;
end;
$$;

-- ---------------------------------------------------------------- Grants
grant select on public.case_containers to anon, authenticated;
grant select on public.container_destinations to anon, authenticated;
grant select on public.case_details to anon, authenticated;

grant execute on function public.upsert_case_containers_batch(jsonb) to authenticated;
grant execute on function public.upsert_container_destinations_batch(jsonb) to authenticated;
grant execute on function public.get_case_detail(text) to anon, authenticated;
grant execute on function public.get_case_destinations_batch(text[]) to anon, authenticated;
grant execute on function public.get_case_details_stats() to anon, authenticated;
grant execute on function public.delete_case_details_before(timestamptz) to authenticated;
