// The cycle count rules that do not need a database.
//
// The classification itself lives in Postgres (record_scan), so what is proved
// here is everything around it: reading a scan, counting the buckets, and the
// accuracy figure that gets reported to the warehouse.
//
//   node scripts/test-cycle-count.mjs
import {
  RESULTS,
  RESULT_ORDER,
  readScan,
  summarise,
  accuracy,
  describeScan,
  reportRows,
} from '../src/lib/cycleCount.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

console.log('--- reading a scan ---')

check('a normal case number', readScan('P03741331').case_no === 'P03741331',
      readScan('P03741331').case_no)
check('empty is refused', !readScan('').ok, readScan('').error)
check('whitespace only is refused', !readScan('   \n ').ok, 'refused')

// A scanner wedge often appends a newline or carriage return.
check('a trailing newline is trimmed', readScan('P03741331\n').case_no === 'P03741331',
      JSON.stringify(readScan('P03741331\n').case_no))
check('a trailing CR is trimmed', readScan('P03741331\r\n').case_no === 'P03741331',
      JSON.stringify(readScan('P03741331\r\n').case_no))

// 54,728 real case numbers contain spaces, so only the OUTSIDE may be trimmed.
const spaced = readScan('  PALET OF 2026 1320&-  ')
check('inner spaces survive', spaced.case_no === 'PALET OF 2026 1320&-', spaced.case_no)

// 20,314 contain lowercase. Upper-casing would stop them matching.
check('lowercase is preserved', readScan('umVRB230001').case_no === 'umVRB230001',
      readScan('umVRB230001').case_no)

// 16 real case numbers are 3 characters or shorter, one of them just "-".
// A scan is not a guess, so there is no minimum length.
check('a 1-character case is still recorded', readScan('-').ok, 'accepted')

console.log('\n--- counting the buckets ---')

const scans = [
  { case_no: 'A', result: 'match' },
  { case_no: 'B', result: 'match' },
  { case_no: 'C', result: 'wrong_location' },
  { case_no: 'D', result: 'not_in_query' },
]
const c = summarise(scans, 3)

check('matches counted', c.match === 2, String(c.match))
check('wrong location counted', c.wrong_location === 1, String(c.wrong_location))
check('not in query counted', c.not_in_query === 1, String(c.not_in_query))
check('not checked passed through', c.not_checked === 3, String(c.not_checked))
check('scanned excludes never-scanned', c.scanned === 4, String(c.scanned))
check('problems is everything but a match', c.problems === 5, String(c.problems))
check('total is match plus problems', c.total === 7, String(c.total))

const empty = summarise([], 0)
check('an empty count has no total', empty.total === 0, String(empty.total))

console.log('\n--- accuracy ---')

check('2 of 7 is 28.6%', Math.abs(accuracy(c) - 28.571) < 0.01, accuracy(c).toFixed(3))
check('all matched is 100%', accuracy(summarise([{ result: 'match' }], 0)) === 100, '100')

// 100% of nothing reads as a perfect score and is not one.
check('nothing counted is null, not 100%', accuracy(empty) === null, String(accuracy(empty)))

// A location where everything was missing must not flatter itself.
const allMissing = summarise([], 5)
check('all missing is 0%', accuracy(allMissing) === 0, String(accuracy(allMissing)))

console.log('\n--- describing a scan ---')

check('a plain match', describeScan({ result: 'match', system_locations: ['A'] }) === 'Here',
      describeScan({ result: 'match', system_locations: ['A'] }))

// 381 of 108,778 full cases sit in more than one location, so a match can be
// correct here AND elsewhere at the same time.
check('a match that is also elsewhere',
      describeScan({ result: 'match', system_locations: ['A', 'B'] }) ===
        'Here, and in 1 other location',
      describeScan({ result: 'match', system_locations: ['A', 'B'] }))
check('plural for several others',
      describeScan({ result: 'match', system_locations: ['A', 'B', 'C'] }).includes('2 other locations'),
      describeScan({ result: 'match', system_locations: ['A', 'B', 'C'] }))

check('wrong location names where it should be',
      describeScan({ result: 'wrong_location', system_locations: ['LHO-NN24-301'] }) ===
        'Query says LHO-NN24-301',
      describeScan({ result: 'wrong_location', system_locations: ['LHO-NN24-301'] }))
check('not in query says so',
      describeScan({ result: 'not_in_query', system_locations: [] }) === 'Not in Query',
      describeScan({ result: 'not_in_query', system_locations: [] }))

console.log('\n--- the report ---')

const rows = reportRows(scans, ['E', 'F'])
check('matches are left out', rows.every((r) => r.result !== 'match'),
      rows.map((r) => r.result).join(','))
check('every problem appears', rows.length === 4, String(rows.length))
check('not in query is first', rows[0].result === 'not_in_query', rows[0].result)
check('wrong location is next', rows[1].result === 'wrong_location', rows[1].result)
check('need check last', rows.at(-1).result === 'not_checked', rows.at(-1).result)
check('never-scanned cases are included',
      rows.filter((r) => r.result === 'not_checked').map((r) => r.case_no).join(',') === 'E,F',
      rows.filter((r) => r.result === 'not_checked').map((r) => r.case_no).join(','))

const clean = reportRows([{ case_no: 'A', result: 'match' }], [])
check('a perfect count has an empty report', clean.length === 0, String(clean.length))

console.log('\n--- the four buckets are all named ---')
check('every result has a label and tone',
      RESULT_ORDER.every((k) => RESULTS[k]?.label && RESULTS[k]?.tone),
      RESULT_ORDER.join(', '))
check('the fourth bucket is the "need check later" one',
      RESULTS.not_checked.label === 'Need check later', RESULTS.not_checked.label)

report()
