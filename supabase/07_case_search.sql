-- ============================================================================
-- Search by case number - run this AFTER setup.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
--
-- `inventory` is indexed on part_number, location and area. It has never had
-- an index on case_no, so every case search was a full sequential scan.
-- Measured against 207,633 live rows before this file existed:
--
--   exact match on a full case number      1029 ms
--   contains, last 12 characters           1394 ms
--   part_number contains (has trgm index)   295 ms   <- the target
--
-- Why a trigram index and not just a btree: the app always searches case
-- numbers with a CONTAINS match, never a prefix. It has to. Measured on the
-- live data, a case number is a median of 42 characters and up to 100:
--
--   P03741331
--   PALET OF 2026 1320&-
--   PALET OF 2026 0213&0010007029_10003993_SMC2C4_2200.0_B16608901_740A_
--
-- Nobody types that. They read a fragment off the label, and the fragment can
-- be anywhere in the string - so a sorted btree cannot help, exactly as with
-- partial part-number search in 06_partial_search.sql.
--
-- NOTE: 6 characters is the app's minimum for a case fragment (CASE_MIN in
-- src/lib/searchTerms.js), comfortably above the 3 a trigram index needs.
-- Do not lower it: at 4 characters the median fragment already matches 291
-- rows and the worst matches 11,903, which is a browse rather than a search.
-- ============================================================================

create extension if not exists pg_trgm;

create index if not exists inventory_case_no_trgm_idx
  on public.inventory using gin (case_no gin_trgm_ops);

-- Plain equality, which the trigram index above does not serve especially
-- well. Nothing needs this today - the search page only ever does a contains
-- match - but a cycle count looks a case up by its exact number, and this is
-- the cheap moment to add it.
create index if not exists inventory_case_no_idx
  on public.inventory (case_no);

analyze public.inventory;


-- ============================================================================
-- CHECK - the plan should say "Bitmap Index Scan on
-- inventory_case_no_trgm_idx", NOT "Seq Scan on inventory".
-- ============================================================================
-- explain analyze
-- select count(*) from public.inventory where case_no ilike '%P03741331%';
