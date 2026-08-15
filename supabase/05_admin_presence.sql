-- ============================================================================
-- Admin presence + upload claim - run this AFTER 03_upload_log.sql
-- Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Safe to run more than once. It recreates the presence table from scratch
-- each time, which drops whoever is currently shown as present - they
-- reappear on their next heartbeat, within 30 seconds. Do not run it in the
-- middle of an upload: the claim would go with it.
--
-- Two things, one table:
--
--   1. SOFT - who is on the admin page right now, shown by name. Nobody is
--      blocked. This is for the team to coordinate ("dian.ayu is in there").
--
--   2. HARD - only one admin may upload a given table at a time. Enforced
--      HERE, not in the browser: reset_*_staging() and swap_*() now refuse to
--      run unless the caller holds a live claim. A second admin cannot bypass
--      it by calling PostgREST directly with a valid JWT.
--
-- Uploads to DIFFERENT tables still run concurrently - the claim is per
-- target, and inventory and master_data never touch each other's staging.
--
-- !! BREAKING: this file DROPS the old reset_*_staging() and swap_*(bigint)
-- !! signatures and replaces them with versions taking a session id. The
-- !! deployed frontend must be redeployed together with running this file,
-- !! or uploads will fail with "function does not exist" in between.
-- ============================================================================


-- ============================================================================
-- 1. TABLE
--    One row per browser TAB, not per user. If the key were user_id, an admin
--    with two tabs open would have the idle tab's heartbeat overwrite the
--    uploading tab's status, and the claim would evaporate mid-upload.
-- ============================================================================

-- DROP and recreate, rather than `create table if not exists`. This table holds
-- nothing but live presence - who has the admin page open this minute - and
-- every row is rebuilt by the next heartbeat within 30 seconds. There is no
-- data here worth preserving, so re-running this file always produces exactly
-- the shape below, instead of silently keeping an older one and failing later
-- with "column does not exist" when the view is created.
--
-- CASCADE takes active_admins with it; it is recreated in section 3.
drop table if exists public.admin_session cascade;

create table public.admin_session (
  session_id   uuid        primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  display_name text        not null,
  status       text        not null default 'viewing'
                           check (status in ('viewing', 'uploading')),
  target       text        check (target is null or target in ('inventory', 'master_data')),
  started_at   timestamptz,
  heartbeat    timestamptz not null default now()
);

create index admin_session_heartbeat_idx
  on public.admin_session (heartbeat desc);


-- How long after its last heartbeat a session is considered gone. The browser
-- beats every 30s, so 90s tolerates two missed beats before a crashed tab is
-- treated as gone and its claim becomes available to someone else.
create or replace function public.admin_stale_after()
returns interval
language sql
immutable
as $$ select interval '90 seconds' $$;


-- ============================================================================
-- 2. DISPLAY NAME
--    The email's local part, derived server-side. The client never supplies
--    it, so one admin cannot display as another.
--
--      dian.ayu@panli.com    -> dian.ayu
--      dian.fitri@panli.com  -> dian.fitri
--      dworsnop4@gmail.com   -> dworsnop4
--
--    Names, not initials: the team recognises "dian.ayu" instantly, where
--    "DA" and "DF" need a moment's thought. Note the trade-off - the login
--    page is reachable by anyone with the URL, so this publishes valid email
--    local parts. Acceptable here because the site is internal.
--
--    Domain is deliberately dropped: it adds nothing for colleagues who all
--    share it, and keeps the full address off a public page.
-- ============================================================================

drop function if exists public.email_initials(text);

create or replace function public.email_display_name(p_email text)
returns text
language sql
immutable
as $$
  select coalesce(nullif(trim(split_part(coalesce(p_email, ''), '@', 1)), ''), 'unknown');
$$;


-- ============================================================================
-- 3. PUBLIC VIEW
--    The login page shows who is signed in, and that page is reachable by
--    anyone who knows the URL. So the view exposes the name and status only -
--    never the email, never user_id.
--
--    NOTE: this view is deliberately SECURITY DEFINER (the default), unlike
--    every other view in this project. That is the point: the base table has
--    no anon read policy at all, and this view is the single narrow window
--    onto it. Adding security_invoker = on here would either break the login
--    page or force an anon policy on the table itself, which would expose
--    every column. Supabase's linter flags definer views generically - this
--    one is intentional.
-- ============================================================================

-- DROP first, for the reason learned in 02_search_helpers.sql: CREATE OR
-- REPLACE on a view can only append columns, so any future change to this
-- column list would make re-running this file fail.
drop view if exists public.active_admins;

create view public.active_admins as
select
  session_id,
  display_name,
  status,
  target,
  started_at,
  heartbeat
from public.admin_session
where heartbeat > now() - public.admin_stale_after();


-- ============================================================================
-- 4. PRESENCE - heartbeat and release
-- ============================================================================

-- Called on entering /admin and every 30s after. Creates the row on first
-- call, then only ever bumps the clock.
--
-- Deliberately CANNOT change status: if a stray heartbeat could reset status
-- to 'viewing', a slow response arriving mid-upload would silently drop the
-- claim while the upload was still running. Status moves only through
-- claim_upload() and release_upload().
create or replace function public.admin_heartbeat(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  insert into public.admin_session (session_id, user_id, display_name, heartbeat)
  values (
    p_session_id,
    auth.uid(),
    public.email_display_name(auth.jwt() ->> 'email'),
    now()
  )
  on conflict (session_id) do update
    set heartbeat = now()
    where admin_session.user_id = auth.uid();
end;
$$;


-- Called on sign out, on leaving /admin, and on tab close. Losing this call is
-- not a problem - the row simply ages out after admin_stale_after().
--
-- Deliberately will NOT remove a row that is mid-upload. Closing the tab kills
-- the upload but chunks may still be landing in staging; letting the claim age
-- out naturally keeps the target reserved until things have certainly stopped,
-- instead of handing it to the next admin while writes are still arriving.
create or replace function public.admin_release(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.admin_session
  where session_id = p_session_id
    and user_id = auth.uid()
    and status <> 'uploading';
end;
$$;


-- ============================================================================
-- 5. THE CLAIM
-- ============================================================================

-- Taken when the admin presses Replace, before a single row is staged.
create or replace function public.claim_upload(p_session_id uuid, p_target text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  holder text;
begin
  if p_target not in ('inventory', 'master_data') then
    raise exception 'Unknown upload target: %', p_target;
  end if;

  -- Serialises the check-then-set below, so two admins pressing Replace in the
  -- same second cannot both find the target free. Transaction-scoped: released
  -- automatically when this function returns. It does NOT span the upload -
  -- that is what the claim row itself is for.
  perform pg_advisory_xact_lock(hashtext('upload_claim:' || p_target));

  select a.display_name into holder
  from public.admin_session a
  where a.target = p_target
    and a.status = 'uploading'
    and a.session_id <> p_session_id
    and a.heartbeat > now() - public.admin_stale_after()
  limit 1;

  if holder is not null then
    raise exception '% is uploading % right now. Wait until they finish.',
      holder, p_target;
  end if;

  update public.admin_session
     set status = 'uploading', target = p_target, started_at = now(), heartbeat = now()
   where session_id = p_session_id
     and user_id = auth.uid();

  if not found then
    raise exception 'No admin session on record - reload the page and try again.';
  end if;
end;
$$;


-- Called after the swap commits, and after a failed or cancelled upload.
create or replace function public.release_upload(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.admin_session
     set status = 'viewing', target = null, started_at = null, heartbeat = now()
   where session_id = p_session_id
     and user_id = auth.uid();
end;
$$;


-- The guard the upload functions call. Kept separate so the rule lives in
-- exactly one place.
create or replace function public.assert_holds_claim(p_session_id uuid, p_target text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.admin_session a
    where a.session_id = p_session_id
      and a.user_id = auth.uid()
      and a.status = 'uploading'
      and a.target = p_target
      and a.heartbeat > now() - public.admin_stale_after()
  ) then
    raise exception
      'No live upload claim on % for this session. Nothing was changed. '
      'If the upload has been running a long time, the page may have lost '
      'its connection - reload and start again.', p_target;
  end if;
end;
$$;


-- ============================================================================
-- 6. UPLOAD FUNCTIONS, NOW CLAIM-CHECKED
--    Bodies are otherwise identical to 03_upload_log.sql. The old signatures
--    are dropped so nothing can call the unprotected versions by accident -
--    including a stale deployed bundle.
-- ============================================================================

drop function if exists public.reset_inventory_staging();
drop function if exists public.reset_master_data_staging();
drop function if exists public.swap_inventory(bigint);
drop function if exists public.swap_master_data(bigint);


create or replace function public.reset_inventory_staging(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_holds_claim(p_session_id, 'inventory');
  truncate public.inventory_staging;
end;
$$;

create or replace function public.reset_master_data_staging(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_holds_claim(p_session_id, 'master_data');
  truncate public.master_data_staging;
end;
$$;


-- statement_timeout: see 03_upload_log.sql. Supabase caps `authenticated` at
-- 8s by default, which is far below what a 195,000-row swap needs.
create or replace function public.swap_inventory(expected_rows bigint, p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '5min'
as $$
declare
  staged bigint;
begin
  perform public.assert_holds_claim(p_session_id, 'inventory');

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

  -- Free the target for the next admin in the same transaction that made the
  -- data live, so there is no window where the swap is done but the lock is
  -- still held.
  update public.admin_session
     set status = 'viewing', target = null, started_at = null
   where session_id = p_session_id;

  return staged;
end;
$$;


create or replace function public.swap_master_data(expected_rows bigint, p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '5min'
as $$
declare
  staged bigint;
begin
  perform public.assert_holds_claim(p_session_id, 'master_data');

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

  update public.admin_session
     set status = 'viewing', target = null, started_at = null
   where session_id = p_session_id;

  return staged;
end;
$$;


-- ============================================================================
-- 7. ROW LEVEL SECURITY + GRANTS
--    admin_session has RLS on and NO policies: every read and write goes
--    through the SECURITY DEFINER functions above, which check auth.uid()
--    themselves. Direct table access is denied to everyone.
-- ============================================================================

alter table public.admin_session enable row level security;

grant select on public.active_admins to anon, authenticated;

revoke all on function public.admin_heartbeat(uuid)        from public, anon;
revoke all on function public.admin_release(uuid)          from public, anon;
revoke all on function public.claim_upload(uuid, text)     from public, anon;
revoke all on function public.release_upload(uuid)         from public, anon;
revoke all on function public.assert_holds_claim(uuid, text) from public, anon;

grant execute on function public.admin_heartbeat(uuid)    to authenticated;
grant execute on function public.admin_release(uuid)      to authenticated;
grant execute on function public.claim_upload(uuid, text) to authenticated;
grant execute on function public.release_upload(uuid)     to authenticated;

revoke all on function public.reset_inventory_staging(uuid)        from public, anon;
revoke all on function public.reset_master_data_staging(uuid)      from public, anon;
revoke all on function public.swap_inventory(bigint, uuid)         from public, anon;
revoke all on function public.swap_master_data(bigint, uuid)       from public, anon;

grant execute on function public.reset_inventory_staging(uuid)   to authenticated;
grant execute on function public.reset_master_data_staging(uuid) to authenticated;
grant execute on function public.swap_inventory(bigint, uuid)    to authenticated;
grant execute on function public.swap_master_data(bigint, uuid)  to authenticated;


-- ============================================================================
-- 8. QUICK CHECKS
-- ============================================================================
-- select public.email_display_name('dian.ayu@panli.com');    -- expect dian.ayu
-- select public.email_display_name('dian.fitri@panli.com');  -- expect dian.fitri
-- select * from public.active_admins;                    -- empty until someone opens /admin
--
-- Stale rows disappear from the view on their own; to clear the table by hand:
-- delete from public.admin_session
--  where heartbeat < now() - public.admin_stale_after();
