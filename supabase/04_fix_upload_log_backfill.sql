-- ============================================================================
-- Repair for the bad backfill rows written by the first version of
-- 03_upload_log.sql. Run this ONCE in the SQL Editor.
--
-- Symptom: the header shows "0 rows". Cause: re-running 03 appended a
-- "0 rows / initial CSV load" entry each time, and latest_upload takes the
-- newest entry per table. 03_upload_log.sql has since been corrected, so
-- this only needs running if you already ran the old version.
-- ============================================================================

-- 1. Remove every backfill placeholder. Real uploads made through the admin
--    page are NOT touched - they have a real email address attached.
delete from public.upload_log
where uploaded_email = 'initial CSV load';

-- 2. Re-create one correct entry per table, only where no genuine upload has
--    been recorded yet.
insert into public.upload_log (table_name, row_count, uploaded_email)
select 'inventory', (select count(*) from public.inventory), 'initial CSV load'
where not exists (select 1 from public.upload_log where table_name = 'inventory')
  and (select count(*) from public.inventory) > 0;

insert into public.upload_log (table_name, row_count, uploaded_email)
select 'master_data', (select count(*) from public.master_data), 'initial CSV load'
where not exists (select 1 from public.upload_log where table_name = 'master_data')
  and (select count(*) from public.master_data) > 0;

-- 3. Check - expect inventory 194731 and master_data 18630.
select table_name, row_count, uploaded_at, uploaded_email
from public.latest_upload
order by table_name;
