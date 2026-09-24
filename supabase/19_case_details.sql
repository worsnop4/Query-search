-- ============================================================================
-- 19_case_details.sql
-- Case tracking details: Shipping Advice, Container Code, Unload Destination,
-- and Unpack Label.
-- ============================================================================

create table if not exists public.case_details (
  case_no            text primary key,
  shipping_advice    text,
  container_code     text,
  unload_destination text,
  unpack_number      text,
  team_no            text,
  sa_updated_at      timestamptz,
  unpack_updated_at  timestamptz,
  updated_at         timestamptz not null default now()
);

create index if not exists idx_case_details_updated_at
  on public.case_details (updated_at);

-- ---------------------------------------------------------------- RLS
alter table public.case_details enable row level security;

drop policy if exists "Anyone can read case_details" on public.case_details;
create policy "Anyone can read case_details"
  on public.case_details for select
  using (true);

drop policy if exists "Authenticated can modify case_details" on public.case_details;
create policy "Authenticated can modify case_details"
  on public.case_details for all
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------- Upsert Shipping
create or replace function public.upsert_case_shipping_batch(p_rows jsonb)
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
      nullif(trim(r->>'shipping_advice'), '') as s_adv,
      nullif(trim(r->>'container_code'), '') as c_code,
      nullif(trim(r->>'unload_destination'), '') as u_dest
    from jsonb_array_elements(p_rows) r
    where r->>'case_no' is not null and trim(r->>'case_no') <> ''
  ),
  deduped as (
    select distinct on (c_no)
      c_no, s_adv, c_code, u_dest
    from data
  )
  insert into public.case_details (
    case_no,
    shipping_advice,
    container_code,
    unload_destination,
    sa_updated_at,
    updated_at
  )
  select
    c_no,
    s_adv,
    c_code,
    u_dest,
    now(),
    now()
  from deduped
  on conflict (case_no) do update set
    shipping_advice    = excluded.shipping_advice,
    container_code     = excluded.container_code,
    unload_destination = excluded.unload_destination,
    sa_updated_at      = excluded.sa_updated_at,
    updated_at         = excluded.updated_at;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- ---------------------------------------------------------------- Upsert Unpack
create or replace function public.upsert_case_unpack_batch(p_rows jsonb)
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
      nullif(trim(r->>'unpack_number'), '') as u_num,
      nullif(trim(r->>'team_no'), '') as t_no
    from jsonb_array_elements(p_rows) r
    where r->>'case_no' is not null and trim(r->>'case_no') <> ''
  ),
  deduped as (
    select distinct on (c_no)
      c_no, u_num, t_no
    from data
  )
  insert into public.case_details (
    case_no,
    unpack_number,
    team_no,
    unpack_updated_at,
    updated_at
  )
  select
    c_no,
    u_num,
    t_no,
    now(),
    now()
  from deduped
  on conflict (case_no) do update set
    unpack_number     = excluded.unpack_number,
    team_no           = coalesce(excluded.team_no, case_details.team_no),
    unpack_updated_at = excluded.unpack_updated_at,
    updated_at        = excluded.updated_at;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- ---------------------------------------------------------------- Stats & Cleanup
create or replace function public.get_case_details_stats()
returns table (
  total_count bigint,
  oldest_date timestamptz,
  newest_date timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::bigint as total_count,
    min(updated_at)  as oldest_date,
    max(updated_at)  as newest_date
  from public.case_details;
$$;

create or replace function public.delete_case_details_before(p_cutoff timestamptz)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.case_details
  where updated_at < p_cutoff;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- ---------------------------------------------------------------- Grants
grant select on public.case_details to anon, authenticated;
grant execute on function public.upsert_case_shipping_batch(jsonb) to authenticated;
grant execute on function public.upsert_case_unpack_batch(jsonb) to authenticated;
grant execute on function public.get_case_details_stats() to anon, authenticated;
grant execute on function public.delete_case_details_before(timestamptz) to authenticated;
