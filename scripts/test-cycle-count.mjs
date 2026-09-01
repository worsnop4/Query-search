// The cycle count rules that do not need a database.
//
// The classification itself lives in Postgres (record_scan), so what is proved
// here is everything around it: reading a scan, bucketing a result, the
// accuracy figure reported to the warehouse, and the adjustment worklist.
//
//   node scripts/test-cycle-count.mjs
import {
  RESULTS,
  RESULT_ORDER,
  ACTIONS,
  ACTION_LABEL,
  bucketOf,
  readScan,
  summarise,
  accuracy,
  describeScan,
  reportRows,
  suggestedAction,
} from '../src/lib/cycleCount.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

console.log('--- reading a scan ---')

check('a normal case number', readScan('P03741331').case_no === 'P03741331',
      readScan('P03741331').case_no)
check('empty is refused', !readScan('').ok, readScan('').error)
check('whitespace only is refused', !readScan('   \n ').ok, 'refused')
check('a trailing newline is trimmed', readScan('P03741331\n').case_no === 'P03741331',
      JSON.stringify(readScan('P03741331\n').case_no))
check('a trailing CR is trimmed', readScan('P03741331\r\n').case_no === 'P03741331',
      JSON.stringify(readScan('P03741331\r\n').case_no))

// 54,728 real case numbers contain spaces, so only the OUTSIDE may be trimmed.
check('inner spaces survive',
      readScan('  PALET OF 2026 1320&-  ').case_no === 'PALET OF 2026 1320&-',
      readScan('  PALET OF 2026 1320&-  ').case_no)
// 20,314 contain lowercase. Upper-casing would stop them matching.
check('lowercase is preserved', readScan('umVRB230001').case_no === 'umVRB230001',
      readScan('umVRB230001').case_no)
// 16 real case numbers are 3 characters or shorter, one of them just "-".
check('a 1-character case is still recorded', readScan('-').ok, 'accepted')

console.log('\n--- bucketing: right place is not the same as right ---')

// The whole point of correction 1: a case can be exactly where Query says and
// still be wrong, because Query has it as opened when it is physically full.
check('right place, Query agrees -> True',
      bucketOf({ result: 'match', query_opened: false }) === 'clean_match',
      bucketOf({ result: 'match', query_opened: false }))
check('right place, Query says opened -> its own bucket',
      bucketOf({ result: 'match', query_opened: true }) === 'opened_mismatch',
      bucketOf({ result: 'match', query_opened: true }))
check('wrong place passes through',
      bucketOf({ result: 'wrong_location', query_opened: false }) === 'wrong_location',
      bucketOf({ result: 'wrong_location' }))
check('not in query passes through',
      bucketOf({ result: 'not_in_query', query_opened: false }) === 'not_in_query',
      bucketOf({ result: 'not_in_query' }))
// An opened case in the WRONG place is still a wrong-place problem first.
check('wrong place wins over the opened flag',
      bucketOf({ result: 'wrong_location', query_opened: true }) === 'wrong_location',
      bucketOf({ result: 'wrong_location', query_opened: true }))

console.log('\n--- counting the buckets ---')

const scans = [
  { case_no: 'A', result: 'match', query_opened: false },
  { case_no: 'B', result: 'match', query_opened: false },
  { case_no: 'C', result: 'match', query_opened: true },
  { case_no: 'D', result: 'wrong_location', query_opened: false },
  { case_no: 'E', result: 'not_in_query', query_opened: false },
]
const c = summarise(scans, 3)

check('clean matches counted', c.clean_match === 2, String(c.clean_match))
check('opened mismatches counted', c.opened_mismatch === 1, String(c.opened_mismatch))
check('wrong location counted', c.wrong_location === 1, String(c.wrong_location))
check('not in query counted', c.not_in_query === 1, String(c.not_in_query))
check('not checked passed through', c.not_checked === 3, String(c.not_checked))
check('scanned is everything handled', c.scanned === 5, String(c.scanned))
check('not checked is NOT in scanned', c.scanned === scans.length, String(c.scanned))
check('problems is scanned minus clean', c.problems === 3, String(c.problems))

console.log('\n--- accuracy matches their spreadsheet ---')

// Recap sheet, 2026-08-03: 43 TRUE of 75 counted = 57.3%. Reproduce it exactly,
// or the new numbers will not be comparable with their own history.
const theirDay = summarise(
  [
    ...Array(43).fill({ result: 'match', query_opened: false }),
    ...Array(32).fill({ result: 'wrong_location', query_opened: false }),
  ],
  0
)
check('their 43 of 75 is 57.3%', Math.abs(accuracy(theirDay) - 57.333) < 0.01,
      `${accuracy(theirDay).toFixed(3)}%`)
check('and the denominator is 75', theirDay.scanned === 75, String(theirDay.scanned))

// "Need check later" must NOT drag the percentage down - those cases were
// never handled, so they cannot be right or wrong yet.
const withUnchecked = summarise(
  [
    ...Array(43).fill({ result: 'match', query_opened: false }),
    ...Array(32).fill({ result: 'wrong_location', query_opened: false }),
  ],
  40
)
check('40 unchecked cases do not change the accuracy',
      accuracy(withUnchecked) === accuracy(theirDay),
      `${accuracy(withUnchecked).toFixed(3)}% vs ${accuracy(theirDay).toFixed(3)}%`)
check('but they are still reported', withUnchecked.not_checked === 40,
      String(withUnchecked.not_checked))

// An opened-in-Query case counts against accuracy - it is not a pass.
const oneOpened = summarise([{ result: 'match', query_opened: true }], 0)
check('a Query-says-opened case scores 0%', accuracy(oneOpened) === 0,
      String(accuracy(oneOpened)))

check('nothing scanned is null, not 100%', accuracy(summarise([], 0)) === null,
      String(accuracy(summarise([], 0))))
check('nothing scanned stays null even with unchecked cases',
      accuracy(summarise([], 9)) === null, String(accuracy(summarise([], 9))))

console.log('\n--- describing a scan ---')

check('a plain match',
      describeScan({ result: 'match', system_locations: ['A'], query_opened: false }) === 'Here',
      describeScan({ result: 'match', system_locations: ['A'] }))
// 381 of 108,778 full cases sit in more than one location.
check('a match that is also elsewhere',
      describeScan({ result: 'match', system_locations: ['A', 'B'] }) ===
        'Here, and in 1 other location',
      describeScan({ result: 'match', system_locations: ['A', 'B'] }))
check('the opened flag is spelled out',
      describeScan({ result: 'match', system_locations: ['A'], query_opened: true })
        .includes('OPENED'),
      describeScan({ result: 'match', system_locations: ['A'], query_opened: true }))
check('wrong location names where it should be',
      describeScan({ result: 'wrong_location', system_locations: ['LHO-NN24-301'] }) ===
        'Query says LHO-NN24-301',
      describeScan({ result: 'wrong_location', system_locations: ['LHO-NN24-301'] }))

console.log('\n--- the adjustment worklist ---')

const rows = reportRows(scans, ['X', 'Y'])

check('clean matches are left out', rows.every((r) => r.bucket !== 'clean_match'),
      rows.map((r) => r.bucket).join(','))
check('every problem appears', rows.length === 5, String(rows.length))
check('not in query is first', rows[0].bucket === 'not_in_query', rows[0].bucket)
check('the crucial finding is second', rows[1].bucket === 'opened_mismatch', rows[1].bucket)
check('wrong location next', rows[2].bucket === 'wrong_location', rows[2].bucket)
check('need check last', rows.at(-1).bucket === 'not_checked', rows.at(-1).bucket)
check('never-scanned cases are included',
      rows.filter((r) => r.bucket === 'not_checked').map((r) => r.case_no).join(',') === 'X,Y',
      rows.filter((r) => r.bucket === 'not_checked').map((r) => r.case_no).join(','))

// The decision is per COUNT now, not per case, so no row carries one.
check('no row carries its own reason or action',
      rows.every((r) => !('reason' in r) && !('action' in r)), 'ok')

check('a perfect count has an empty worklist',
      reportRows([{ case_no: 'A', result: 'match', query_opened: false }], []).length === 0,
      '0')

console.log('\n--- actions: one decision for the whole count ---')

check('the four actions the user asked for',
      ACTIONS.map((a) => a.value).join(',') === 'put_away,shortage,profit,shortage_profit',
      ACTIONS.map((a) => a.value).join(','))
check('shortage + profit is labelled properly',
      ACTION_LABEL.shortage_profit === 'Shortage + Profit', ACTION_LABEL.shortage_profit)

// Driven by the worst finding: a case Query has as opened but was actually
// full has to come off and go back on, so it outranks the others.
check('an opened mismatch suggests shortage + profit',
      suggestedAction({ opened_mismatch: 1, not_in_query: 3, wrong_location: 9 })
        === 'shortage_profit', 'shortage_profit')
check('otherwise not in query suggests profit',
      suggestedAction({ opened_mismatch: 0, not_in_query: 1, wrong_location: 9 })
        === 'profit', 'profit')
check('otherwise wrong location suggests put away',
      suggestedAction({ opened_mismatch: 0, not_in_query: 0, wrong_location: 1 })
        === 'put_away', 'put_away')
check('a clean count suggests nothing',
      suggestedAction({ opened_mismatch: 0, not_in_query: 0, wrong_location: 0 }) === '', '""')
check('missing counts do not throw', suggestedAction(null) === '', '""')
check('every suggestion is a real action',
      [{ opened_mismatch: 1 }, { not_in_query: 1 }, { wrong_location: 1 }]
        .every((c) => ACTIONS.some((a) => a.value === suggestedAction(c))), 'ok')

console.log('\n--- the five buckets are all named ---')
check('every bucket has a label and tone',
      RESULT_ORDER.every((k) => RESULTS[k]?.label && RESULTS[k]?.tone),
      RESULT_ORDER.join(', '))
check('True is named as in their workbook', RESULTS.clean_match.label === 'True',
      RESULTS.clean_match.label)
check('the fourth bucket is "need check later"',
      RESULTS.not_checked.label === 'Need check later', RESULTS.not_checked.label)

report()
