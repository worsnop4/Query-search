-- ============================================================================
-- 20_sa_unpack.sql
-- SA Unpack parts breakdown by case and section.
-- (from "sa 9.10 unpack.xlsx")
-- ============================================================================

-- ---------------------------------------------------------------- Tables
create table if not exists public.sa_unpack_items (
  id          bigserial primary key,
  sa          text,
  case_no     text not null,
  part_number text not null,
  part_name   text,
  section     text not null default 'UNASSIGNED',
  pack_qty    numeric not null default 0,
  updated_at  timestamptz not null default now()
);

create index if not exists idx_sa_unpack_case_no
  on public.sa_unpack_items (case_no);

create index if not exists idx_sa_unpack_section
  on public.sa_unpack_items (section);

create index if not exists idx_sa_unpack_part_number
  on public.sa_unpack_items (part_number);

create index if not exists idx_sa_unpack_sa
  on public.sa_unpack_items (sa);

create index if not exists idx_sa_unpack_updated_at
  on public.sa_unpack_items (updated_at);

-- Trigram index for partial case number searching
create extension if not exists pg_trgm;

create index if not exists idx_sa_unpack_case_trgm
  on public.sa_unpack_items using gin (case_no gin_trgm_ops);

-- ---------------------------------------------------------------- RLS
alter table public.sa_unpack_items enable row level security;

drop policy if exists "Anyone can read sa_unpack_items" on public.sa_unpack_items;
create policy "Anyone can read sa_unpack_items"
  on public.sa_unpack_items for select
  using (true);

drop policy if exists "Authenticated can modify sa_unpack_items" on public.sa_unpack_items;
create policy "Authenticated can modify sa_unpack_items"
  on public.sa_unpack_items for all
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------- Functions
drop function if exists public.insert_sa_unpack_batch(jsonb);
drop function if exists public.clear_sa_unpack(text);
drop function if exists public.get_sa_unpack_case(text);
drop function if exists public.search_sa_unpack_cases(text);
drop function if exists public.get_sa_unpack_stats();
drop function if exists public.delete_sa_unpack_before(timestamptz);

-- Batch insert rows from uploaded Excel
create or replace function public.insert_sa_unpack_batch(p_rows jsonb)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  inserted_count bigint;
begin
  insert into public.sa_unpack_items (
    sa,
    case_no,
    part_number,
    part_name,
    section,
    pack_qty,
    updated_at
  )
  select
    nullif(trim(r->>'sa'), ''),
    upper(trim(r->>'case_no')),
    trim(r->>'part_number'),
    nullif(trim(r->>'part_name'), ''),
    coalesce(nullif(upper(trim(r->>'section')), ''), 'UNASSIGNED'),
    coalesce((r->>'pack_qty')::numeric, 0),
    now()
  from jsonb_array_elements(p_rows) r
  where r->>'case_no' is not null and trim(r->>'case_no') <> ''
    and r->>'part_number' is not null and trim(r->>'part_number') <> '';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- Clear previous data for an SA or all
create or replace function public.clear_sa_unpack(p_sa text default null)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  if p_sa is not null and trim(p_sa) <> '' then
    delete from public.sa_unpack_items
    where sa = trim(p_sa);
  else
    delete from public.sa_unpack_items;
  end if;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Look up all parts in a case, grouped by section
create or replace function public.get_sa_unpack_case(p_case_no text)
returns table (
  sa          text,
  case_no     text,
  section     text,
  part_number text,
  part_name   text,
  total_qty   numeric,
  box_count   bigint,
  box_qtys    numeric[]
)
language sql
security definer
set search_path = public
as $$
  select
    max(i.sa)                              as sa,
    i.case_no,
    i.section,
    i.part_number,
    max(i.part_name)                       as part_name,
    sum(i.pack_qty)::numeric               as total_qty,
    count(*)::bigint                       as box_count,
    array_agg(i.pack_qty order by i.id)    as box_qtys
  from public.sa_unpack_items i
  where i.case_no = upper(trim(p_case_no))
  group by i.case_no, i.section, i.part_number
  order by i.section, i.part_number;
$$;

-- Search case numbers matching query
create or replace function public.search_sa_unpack_cases(p_term text)
returns table (
  case_no    text,
  sa         text,
  part_count bigint,
  total_qty  numeric
)
language sql
security definer
set search_path = public
as $$
  select
    i.case_no,
    max(i.sa)                as sa,
    count(distinct i.part_number)::bigint as part_count,
    sum(i.pack_qty)::numeric as total_qty
  from public.sa_unpack_items i
  where i.case_no ilike '%' || upper(trim(p_term)) || '%'
  group by i.case_no
  order by (i.case_no = upper(trim(p_term))) desc, i.case_no
  limit 25;
$$;

-- Storage and data stats
create or replace function public.get_sa_unpack_stats()
returns table (
  total_rows   bigint,
  total_cases  bigint,
  total_parts  bigint,
  distinct_sas bigint,
  oldest_date  timestamptz,
  newest_date  timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::bigint                                  as total_rows,
    count(distinct case_no)::bigint                  as total_cases,
    count(distinct part_number)::bigint              as total_parts,
    count(distinct sa)::bigint                       as distinct_sas,
    min(updated_at)                                  as oldest_date,
    max(updated_at)                                  as newest_date
  from public.sa_unpack_items;
$$;

create or replace function public.delete_sa_unpack_before(p_cutoff timestamptz)
returns bigint
language plpgsql
security definer
set statement_timeout = '2min'
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.sa_unpack_items
  where updated_at < p_cutoff;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- ---------------------------------------------------------------- Grants
grant select on public.sa_unpack_items to anon, authenticated;

grant execute on function public.insert_sa_unpack_batch(jsonb) to authenticated;
grant execute on function public.clear_sa_unpack(text) to authenticated;
grant execute on function public.get_sa_unpack_case(text) to anon, authenticated;
grant execute on function public.search_sa_unpack_cases(text) to anon, authenticated;
grant execute on function public.get_sa_unpack_stats() to anon, authenticated;
grant execute on function public.delete_sa_unpack_before(timestamptz) to authenticated;
