// End-to-end test of the cycle count RPCs, using two real accounts against
// live Supabase. Run AFTER 10_fix_scan_ambiguity.sql.
//
//   ADMIN_A_EMAIL=... ADMIN_A_PASSWORD=... \
//   ADMIN_B_EMAIL=... ADMIN_B_PASSWORD=... \
//   node --env-file=.env scripts/test-cycle-count-live.mjs
//
// WHY THIS EXISTS
//
// record_scan() shipped with `on conflict (session_id, case_no)`, where
// case_no is also one of its OUT parameters. PL/pgSQL only parses a statement
// the first time it runs, so 09 applied without a single error and the
// function then failed on the first real scan with 42702. A SQL file applying
// cleanly is NOT evidence that its functions work - only calling them is.
//
// SAFE TO RUN: it never touches inventory, master_data or the staging tables.
// It opens two count sessions, scans into them, and cancels both at the end
// even if a check fails. A cancelled session is excluded from the recent-counts
// list, so it does not pollute the statistics.
import { createClient } from '@supabase/supabase-js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const A = { email: process.env.ADMIN_A_EMAIL, password: process.env.ADMIN_A_PASSWORD }
const B = { email: process.env.ADMIN_B_EMAIL, password: process.env.ADMIN_B_PASSWORD }

if (!URL || !KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Use --env-file=.env')
  process.exit(1)
}
if (!A.email || !A.password || !B.email || !B.password) {
  console.error(
    'Set ADMIN_A_EMAIL, ADMIN_A_PASSWORD, ADMIN_B_EMAIL and ADMIN_B_PASSWORD.\n' +
      'Two DIFFERENT admin accounts are required - one has to be blocked by the other.'
  )
  process.exit(1)
}

async function signIn(who, label) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } })
  const { error } = await sb.auth.signInWithPassword(who)
  if (error) {
    console.error(`Could not sign in ${label} (${who.email}): ${error.message}`)
    process.exit(1)
  }
  return sb
}

const sbA = await signIn(A, 'admin A')
const sbB = await signIn(B, 'admin B')

// A small location keeps the expected-list insert quick. Two different ones,
// because half of what is being tested is that two admins do not collide.
const { data: locs, error: locErr } = await sbA
  .from('count_locations')
  .select('location, cases, opened_cases')
  .gte('cases', 3)
  .lte('cases', 25)
  .limit(40)
if (locErr) throw new Error(`count_locations: ${locErr.message}`)

const held = (await sbA.from('cycle_count_locks').select('location')).data ?? []
const heldSet = new Set(held.map((h) => h.location))
const free = locs.filter((l) => !heldSet.has(l.location))
if (free.length < 2) {
  console.error('Need two small unlocked locations to test with; found ' + free.length)
  process.exit(1)
}
const locA = free[0]
const locB = free[1]
console.log(`admin A will count ${locA.location} (${locA.cases} cases)`)
console.log(`admin B will count ${locB.location} (${locB.cases} cases)\n`)

let sessA = null
let sessB = null

try {
  // ---------------------------------------------------------------- starting
  console.log('--- starting a session ---')
  {
    const { data, error } = await sbA.rpc('start_cycle_count', { p_location: locA.location })
    check('admin A can start a count', !error, error?.message ?? 'ok')
    if (error) throw new Error(error.message)
    sessA = Array.isArray(data) ? data[0] : data
    check('the session has an id', !!sessA?.id, String(sessA?.id))
    check('the session records the owner', !!sessA?.started_by_uid, String(sessA?.started_by_uid))
    // EVERY case, opened or not - the correction that makes the count useful.
    check('expected_count is every case at the location',
          Number(sessA.expected_count) === Number(locA.cases),
          `${sessA.expected_count} vs ${locA.cases}`)
  }

  console.log('\n--- the location lock ---')
  {
    const { error } = await sbB.rpc('start_cycle_count', { p_location: locA.location })
    check('admin B is blocked from the same location', !!error,
          error?.message ?? 'NOT BLOCKED')
    check('and is told who has it', (error?.message ?? '').includes('already counting'),
          error?.message ?? '')
  }
  {
    const { data, error } = await sbB.rpc('start_cycle_count', { p_location: locB.location })
    check('admin B can count a DIFFERENT location at the same time', !error,
          error?.message ?? 'ok')
    if (!error) sessB = Array.isArray(data) ? data[0] : data
  }
  {
    const { error } = await sbA.rpc('start_cycle_count', { p_location: locB.location })
    check('one open count per person', !!error, error?.message ?? 'ALLOWED TWO')
  }

  // ------------------------------------------------------------------ scans
  console.log('\n--- scanning ---')

  const { data: hereRows } = await sbA
    .from('inventory').select('case_no').eq('location', locA.location).limit(1)
  const caseHere = hereRows?.[0]?.case_no
  check('found a real case at the location', !!caseHere, caseHere ?? 'none')

  {
    const { data, error } = await sbA.rpc('record_scan', {
      p_session_id: sessA.id, p_case_no: caseHere,
    })
    // The bug this file was written for: 42702, column reference is ambiguous.
    check('a scan is recorded at all', !error, error?.message ?? 'ok')
    const row = Array.isArray(data) ? data[0] : data
    check('a case that is here matches', row?.result === 'match', row?.result)
    check('it is not reported as a repeat', row?.already_scanned === false,
          String(row?.already_scanned))
    check('the case number comes back', row?.case_no === caseHere, row?.case_no)
    check('query_opened is present', typeof row?.query_opened === 'boolean',
          String(row?.query_opened))
  }
  {
    // A hand scanner double-fires constantly. It must not count twice.
    const { data, error } = await sbA.rpc('record_scan', {
      p_session_id: sessA.id, p_case_no: caseHere,
    })
    const row = Array.isArray(data) ? data[0] : data
    check('a repeat scan is accepted', !error, error?.message ?? 'ok')
    check('and flagged as already scanned', row?.already_scanned === true,
          String(row?.already_scanned))
    check('with the same verdict as the first time', row?.result === 'match', row?.result)
  }

  // A case that lives somewhere else entirely.
  const { data: elsewhere } = await sbA
    .from('inventory').select('case_no, location').neq('location', locA.location).limit(50)
  let caseElsewhere = null
  for (const r of elsewhere ?? []) {
    const { data: all } = await sbA
      .from('inventory').select('location').eq('case_no', r.case_no)
    if (!(all ?? []).some((x) => x.location === locA.location)) {
      caseElsewhere = r.case_no
      break
    }
  }
  check('found a case that is NOT here', !!caseElsewhere, caseElsewhere ?? 'none')

  if (caseElsewhere) {
    const { data, error } = await sbA.rpc('record_scan', {
      p_session_id: sessA.id, p_case_no: caseElsewhere,
    })
    const row = Array.isArray(data) ? data[0] : data
    check('a case from elsewhere is wrong_location', !error && row?.result === 'wrong_location',
          error?.message ?? row?.result)
    check('and Query says where it should be', (row?.system_locations ?? []).length > 0,
          (row?.system_locations ?? []).join(', '))
  }

  {
    const bogus = 'ZZZ-NOT-A-REAL-CASE-' + Date.now()
    const { data, error } = await sbA.rpc('record_scan', {
      p_session_id: sessA.id, p_case_no: bogus,
    })
    const row = Array.isArray(data) ? data[0] : data
    check('an unknown case is not_in_query', !error && row?.result === 'not_in_query',
          error?.message ?? row?.result)
    check('with no system location', (row?.system_locations ?? []).length === 0,
          JSON.stringify(row?.system_locations))
  }

  // --------------------------------------------------------------- counting
  console.log('\n--- the summary ---')
  {
    const { data, error } = await sbA
      .from('cycle_count_summary').select('*').eq('id', sessA.id).single()
    check('the summary is readable', !error, error?.message ?? 'ok')
    check('one clean match', Number(data.clean_match) + Number(data.opened_mismatch) === 1,
          `${data.clean_match} + ${data.opened_mismatch}`)
    check('one not in query', Number(data.not_in_query) === 1, String(data.not_in_query))
    check('scanned counts every scan once',
          Number(data.scanned) === (caseElsewhere ? 3 : 2), String(data.scanned))
    // not_checked is expected minus scanned - the bucket that cannot be
    // derived from the scans alone.
    check('not_checked is what was never scanned',
          Number(data.not_checked) === Number(data.expected_count) - 1,
          `${data.not_checked} vs ${data.expected_count} - 1`)
  }
  {
    const { data, error } = await sbA.rpc('cycle_count_not_checked', { p_session_id: sessA.id })
    check('the not-checked list is readable', !error, error?.message ?? 'ok')
    check('and excludes the case that was scanned',
          !(data ?? []).some((r) => r.case_no === caseHere), 'excluded')
  }

  // -------------------------------------------------------------- follow-up
  console.log('\n--- the reason / action / done follow-up ---')
  {
    const { data: scans } = await sbA
      .from('cycle_count_scan').select('id, case_no, result')
      .eq('session_id', sessA.id).eq('result', 'not_in_query').limit(1)
    const scanId = scans?.[0]?.id
    check('a discrepancy row has an id', !!scanId, String(scanId))

    const { data, error } = await sbA.rpc('set_scan_followup', {
      p_scan_id: scanId, p_reason: 'test run', p_action: 'profit',
      p_done: true, p_remark: null,
    })
    const row = Array.isArray(data) ? data[0] : data
    check('the follow-up saves', !error, error?.message ?? 'ok')
    check('the action is stored', row?.action === 'profit', row?.action)
    check('the reason is stored', row?.reason === 'test run', row?.reason)
    check('done is stored', row?.done === true, String(row?.done))
  }
  {
    const { data: scans } = await sbA
      .from('cycle_count_scan').select('id').eq('session_id', sessA.id).limit(1)
    const { error } = await sbA.rpc('set_scan_followup', {
      p_scan_id: scans[0].id, p_reason: null, p_action: 'not_a_real_action',
      p_done: false, p_remark: null,
    })
    check('an invalid action is refused by the check constraint', !!error,
          error?.message ?? 'ACCEPTED')
  }

  // -------------------------------------------------------------- ownership
  console.log('\n--- one admin cannot close another admin\'s count ---')
  {
    const { error } = await sbB.rpc('finish_cycle_count', { p_session_id: sessA.id })
    check('admin B cannot finish admin A\'s session', !!error, error?.message ?? 'ALLOWED')
  }
  {
    const { error } = await sbB.rpc('cancel_cycle_count', { p_session_id: sessA.id })
    check('admin B cannot cancel it either', !!error, error?.message ?? 'ALLOWED')
  }

  console.log('\n--- finishing ---')
  {
    const { data, error } = await sbA.rpc('finish_cycle_count', { p_session_id: sessA.id })
    const row = Array.isArray(data) ? data[0] : data
    check('admin A can finish their own', !error, error?.message ?? 'ok')
    check('finished_at is set', !!row?.finished_at, String(row?.finished_at))
    sessA = null
  }
  {
    const { error } = await sbA.rpc('record_scan', {
      p_session_id: (await sbA.from('cycle_count_summary').select('id')
        .eq('location', locA.location).order('started_at', { ascending: false })
        .limit(1)).data[0].id,
      p_case_no: caseHere,
    })
    check('scanning into a finished session is refused', !!error,
          error?.message ?? 'ACCEPTED')
  }
  {
    const { data } = await sbA.from('cycle_count_locks').select('location')
    check('the location is released once finished',
          !(data ?? []).some((l) => l.location === locA.location), 'released')
  }
} finally {
  // Always let go of the locations, however the run ended.
  if (sessA) await sbA.rpc('cancel_cycle_count', { p_session_id: sessA.id }).catch(() => {})
  if (sessB) await sbB.rpc('cancel_cycle_count', { p_session_id: sessB.id }).catch(() => {})
  await sbA.auth.signOut()
  await sbB.auth.signOut()
}

report()
