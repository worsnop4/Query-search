-- ============================================================================
-- Partial part-number search - run this AFTER setup.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
--
-- The operation team does not memorise 8-digit part numbers; they remember the
-- last four. So typing "9242" has to find 10189242-PHD, 23892426, 23924255 and
-- so on - a match ANYWHERE in the number, not a prefix.
--
-- The existing btree index on part_number cannot help with that. A sorted
-- index answers "starts with"; it is useless for "contains", because matching
-- rows are scattered throughout the sort order. Postgres therefore reads all
-- ~197,000 rows on every keystroke-length query: measured at 700-1000ms.
--
-- A trigram index solves exactly this. pg_trgm chops each value into
-- three-character pieces - 23588931 becomes 235, 358, 588, 889, 893, 931 - and
-- indexes those, so `%9242%` can be looked up instead of scanned.
--
-- Cost: ~20-30 MB, and the index is rebuilt as rows land during a swap, which
-- adds a few seconds to an upload that already takes minutes. Worth it for a
-- search the team runs all day.
--
-- NOTE: 4 characters is the app's minimum for a partial search, which is
-- comfortably above the 3 a trigram index needs to be effective. Do not lower
-- it to 2 without re-measuring - a 2-character query cannot use this index.
-- ============================================================================

create extension if not exists pg_trgm;

create index if not exists inventory_part_number_trgm_idx
  on public.inventory using gin (part_number gin_trgm_ops);

-- Master data is searched the same way when resolving part names, and it is
-- small, but the index costs almost nothing and keeps the two consistent.
create index if not exists master_data_part_number_trgm_idx
  on public.master_data using gin (part_number gin_trgm_ops);

analyze public.inventory;
analyze public.master_data;


-- ============================================================================
-- CHECK - the plan should say "Bitmap Index Scan on
-- inventory_part_number_trgm_idx", NOT "Seq Scan on inventory".
-- ============================================================================
-- explain analyze
-- select count(*) from public.inventory where part_number ilike '%9242%';
