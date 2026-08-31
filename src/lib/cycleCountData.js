// Everything the cycle count reads from or writes to Supabase.
//
// Split from cycleCount.js because this file imports supabase.js, which reads
// import.meta.env and therefore only exists under Vite. The rules live next
// door so they can be tested in plain node.

import { supabase } from './supabase'

/**
 * Locations that hold at least one full case, for the picker.
 *
 * There are ~4,286 of them, which is well under the 1,000-row PostgREST cap
 * only if it is filtered - so the list is searched server-side rather than
 * pulled down whole. Ordered by size: someone counting a rack is far more
 * likely to want a busy location than a one-case one.
 */
export async function searchLocations(term, limit = 25) {
  let q = supabase
    .from('count_locations')
    .select('location, cases, opened_cases')
    .order('cases', { ascending: false })
    .limit(limit)

  const t = String(term ?? '').trim()
  // `_` and `%` are ILIKE wildcards. Location codes are plain (LHO-NN24-301),
  // so stripping is safe here - unlike case numbers, where they are real.
  if (t) q = q.ilike('location', `%${t.replace(/[%_\\]/g, '')}%`)

  const { data, error } = await q
  if (error) throw new Error(`Could not load locations: ${error.message}`)
  return data ?? []
}

/**
 * Locations being counted right now, and by whom.
 *
 * One per open session, so there are only ever a handful - fetched whole and
 * matched against the picker rather than joined server-side, which would have
 * meant exposing who is counting to `anon` through count_locations.
 */
export async function currentLocks() {
  const { data, error } = await supabase
    .from('cycle_count_locks')
    .select('session_id, location, started_by, started_by_uid, started_at')
  if (error) throw new Error(`Could not check locations: ${error.message}`)
  return data ?? []
}

/** Open a session and freeze what Query says should be at that location. */
export async function startSession(location) {
  const { data, error } = await supabase.rpc('start_cycle_count', { p_location: location })
  if (error) throw new Error(error.message)
  // The function returns a single row; PostgREST gives it back as an object.
  return Array.isArray(data) ? data[0] : data
}

/**
 * Record one scan and get back what it was.
 *
 * `already_scanned` is true when this case was scanned earlier in the same
 * session - normal with a hand scanner, and it must not count twice.
 */
export async function recordScan(sessionId, caseNo) {
  const { data, error } = await supabase.rpc('record_scan', {
    p_session_id: sessionId,
    p_case_no: caseNo,
  })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('The scan was not recorded.')
  return row
}

export async function finishSession(sessionId) {
  const { data, error } = await supabase.rpc('finish_cycle_count', {
    p_session_id: sessionId,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

/** Abandon a count, releasing the location for someone else. */
export async function cancelSession(sessionId) {
  const { data, error } = await supabase.rpc('cancel_cycle_count', {
    p_session_id: sessionId,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

/** The reason / action / done follow-up on one discrepancy. */
export async function saveFollowup(scanId, { reason, action, done, remark }) {
  const { data, error } = await supabase.rpc('set_scan_followup', {
    p_scan_id: scanId,
    p_reason: reason ?? null,
    p_action: action ?? null,
    p_done: !!done,
    p_remark: remark ?? null,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

/** Case numbers Query expected here that were never scanned. */
export async function notCheckedCases(sessionId) {
  const { data, error } = await supabase.rpc('cycle_count_not_checked', {
    p_session_id: sessionId,
  })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => r.case_no)
}

export async function sessionSummary(sessionId) {
  const { data, error } = await supabase
    .from('cycle_count_summary')
    .select('*')
    .eq('id', sessionId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

/**
 * Every scan in a session, oldest first.
 *
 * Paged for the same reason as everything else here: PostgREST caps a response
 * at 1,000 rows, and NEED-CHECK-CASE alone holds 8,666 full cases.
 */
export async function sessionScans(sessionId) {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('cycle_count_scan')
      .select(
        'id, case_no, result, system_locations, query_opened, reason, action, done, remark, scanned_at'
      )
      .eq('session_id', sessionId)
      .order('scanned_at')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const batch = data ?? []
    all.push(...batch)
    if (batch.length < PAGE) return all
  }
}

/** Recent sessions, for the list on the cycle count landing screen. */
export async function recentSessions(limit = 20) {
  const { data, error } = await supabase
    .from('cycle_count_summary')
    .select('*')
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return data ?? []
}

/**
 * THIS user's unfinished session, so a dropped phone does not strand a count.
 *
 * Scoped to the signed-in admin, which it was not before: two admins count
 * different locations at the same time, and resuming "the newest open session"
 * would have dropped the second one straight into the first one's count.
 */
export async function openSession() {
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth?.user?.id
  if (!uid) return null

  const { data, error } = await supabase
    .from('cycle_count_summary')
    .select('*')
    .is('finished_at', null)
    .is('cancelled_at', null)
    .eq('started_by_uid', uid)
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0] ?? null
}
