-- ============================================================================
-- Undo a mis-scan while counting
-- Run AFTER 14_plan_assignee.sql. Safe to run more than once.
--
-- "while i scan i cannot delete case if i have wrong scan to wrong barcode."
--
-- A hand scanner picks up whatever is in front of it - the label on the next
-- pallet, a shipping label on the box, someone else's case. Until now the only
-- way out was to cancel the whole count and start again.
--
-- ONLY WHILE THE COUNT IS OPEN, AND ONLY YOUR OWN.
--
-- A finished count is the record of what was found. Letting a scan be deleted
-- from it afterwards would mean the accuracy figure could be edited after the
-- fact, quietly, with nothing to show it had been - so the door closes when
-- the count is finished. A mistake found later is fixed by counting the
-- location again, which is honest and leaves both counts visible.
-- ============================================================================

create or replace function public.remove_scan(p_session_id uuid, p_case_no text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_open  boolean;
  v_case  text := trim(p_case_no);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select s.started_by_uid,
         (s.finished_at is null and s.cancelled_at is null)
    into v_owner, v_open
    from public.cycle_count_session s
   where s.id = p_session_id;

  if v_owner is null and v_open is null then
    raise exception 'No such count.';
  end if;
  if not v_open then
    raise exception 'That count is finished. Count the location again rather than editing it.';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception 'That is not your count.';
  end if;

  delete from public.cycle_count_scan c
   where c.session_id = p_session_id and c.case_no = v_case;

  -- false means there was nothing to delete, which the caller can ignore.
  return found;
end;
$$;

revoke all on function public.remove_scan(uuid, text) from public, anon;
grant execute on function public.remove_scan(uuid, text) to authenticated;


-- ============================================================================
-- CHECK - deleting from a finished count must be refused. Run as an admin:
-- ============================================================================
-- select public.remove_scan('<a finished session id>', 'ANY-CASE');
--   -> ERROR: That count is finished. Count the location again ...
