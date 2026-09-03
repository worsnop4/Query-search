// The cycle count CSVs: the session result an adjustment document is built
// from, and the statistics.
//
// Worth testing directly for the same reason csv.js is: a wrong column order
// or a quoting mistake is SILENT. The file opens, the columns just quietly
// hold the wrong things - and then someone adjusts stock from it.
//
//   node scripts/test-cycle-count-export.mjs
import {
  RESULT_COLUMNS,
  DAILY_COLUMNS,
  localDate,
  resultRows,
  buildResultCsv,
  resultFileName,
  dailyRows,
  buildDailyCsv,
  dailyFileName,
  allRows,
  buildAllCsv,
  allFileName,
} from '../src/lib/cycleCountExport.js'
import { accuracy } from '../src/lib/cycleCount.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const session = {
  id: 'abc',
  location: 'TRANSIT B02',
  started_at: '2026-08-31T02:55:00Z',
  started_by: 'doni',
  reason: 'Wrong put away',
  // A list now - this count needed two actions.
  action: ['shortage', 'profit'],
  done: true,
  remark: null,
}

const scans = [
  { case_no: 'LAID16235BN02SX00015', result: 'match', query_opened: false,
    system_locations: ['TRANSIT B02'] },
  { case_no: 'PAID16270FN01SX00002', result: 'wrong_location', query_opened: false,
    system_locations: ['TRANSIT-B02-014'] },
  { case_no: 'CASE, WITH COMMA', result: 'not_in_query', query_opened: false,
    system_locations: [] },
  { case_no: 'MULTI-HOME', result: 'match', query_opened: true,
    system_locations: ['TRANSIT B02', 'REC-TRANSIT-01'] },
]
const notChecked = ['NEVER-SCANNED-1', 'NEVER-SCANNED-2']

console.log('--- the local day, not the UTC day ---')

// 02:55 UTC is 09:55 the SAME day in Jakarta.
check('a morning count keeps its day', localDate('2026-08-31T02:55:00Z') === '2026-08-31',
      localDate('2026-08-31T02:55:00Z'))
// 23:30 UTC is 06:30 the NEXT day in Jakarta - the case that makes UTC wrong.
check('a late-UTC count belongs to the next local day',
      localDate('2026-08-31T23:30:00Z') === '2026-09-01',
      localDate('2026-08-31T23:30:00Z'))
// And 17:30 UTC is already tomorrow in Jakarta too.
check('17:30 UTC is the next day in WIB',
      localDate('2026-08-31T17:30:00Z') === '2026-09-01',
      localDate('2026-08-31T17:30:00Z'))
check('an empty timestamp is blank, not Invalid Date', localDate(null) === '', 'blank')

console.log('\n--- the session result ---')

const rows = resultRows(session, scans, notChecked)

check('every scan plus every unscanned case', rows.length === 6, String(rows.length))
check('numbering starts at 1 and runs on',
      rows.map((r) => r.No).join(',') === '1,2,3,4,5,6', rows.map((r) => r.No).join(','))
check('the date is the local one', rows[0].Date === '2026-08-31', rows[0].Date)
check('the checker is named', rows[0].Checker === 'doni', rows[0].Checker)
check('actual location is the counted location',
      rows.every((r) => r['Actual Location'] === 'TRANSIT B02'), 'ok')

// Their sheet has these and they were empty in all 606 real rows.
check('Part number stays empty', rows.every((r) => r['Part number'] === ''), 'ok')
check('Qty stays empty', rows.every((r) => r.Qty === ''), 'ok')

check('a clean match is True', rows[0].Status === 'True', rows[0].Status)
check('a wrong location is False', rows[1].Status === 'False', rows[1].Status)
check('an unknown case is False', rows[2].Status === 'False', rows[2].Status)
// The finding that matters most must not hide inside a plain "False".
check('a Query-says-opened case is False', rows[3].Status === 'False', rows[3].Status)
check('...but Finding says exactly what it was',
      rows[3].Finding === 'Opened in Query', rows[3].Finding)
check('a never-scanned case is Need check', rows[4].Status === 'Need check', rows[4].Status)

// A case in several places must not be silently truncated to the first.
check('several query locations are all listed',
      rows[3]['Query Location'] === 'TRANSIT B02 | REC-TRANSIT-01',
      rows[3]['Query Location'])
check('no query location renders blank', rows[2]['Query Location'] === '',
      `"${rows[2]['Query Location']}"`)

console.log('\n--- one decision, repeated on every row ---')
check('the reason is on every row', rows.every((r) => r.Reason === 'Wrong put away'), 'ok')
// Several actions read as one phrase, and as LABELS not codes.
check('two actions join into their own wording',
      rows.every((r) => r.Action === 'Shortage + Profit'), rows[0].Action)
check('done is marked', rows.every((r) => r.Done === 'done'), rows[0].Done)

const oneAction = resultRows({ ...session, action: ['put_away'] }, scans, [])
check('a single action reads plainly', oneAction[0].Action === 'Put away', oneAction[0].Action)

const undecided = resultRows(
  { ...session, reason: null, action: null, done: false, remark: null }, scans, []
)
check('an undecided count has no reason or action',
      undecided.every((r) => r.Reason === '' && r.Action === ''), 'ok')
// "in progress" rather than blank: an empty cell reads as a missing value, not
// as work that has not been done yet.
check('and says the adjustment is in progress',
      undecided.every((r) => r.Done === 'in progress'), undecided[0].Done)

console.log('\n--- the CSV itself ---')

const csv = buildResultCsv(session, scans, notChecked)
const lines = csv.trimEnd().split('\n')

check('header first', lines[0] === RESULT_COLUMNS.join(','), lines[0].slice(0, 40))
check('one line per row plus the header', lines.length === 7, String(lines.length))
// The comma inside a case number is the classic silent corruption.
check('a comma inside a case number is quoted',
      lines[3].includes('"CASE, WITH COMMA"'), lines[3].slice(0, 60))
check('the pipe-joined locations survive',
      lines[4].includes('TRANSIT B02 | REC-TRANSIT-01'), 'ok')
check('no stray CR', !csv.includes('\r'), 'clean')

console.log('\n--- file names ---')
const name = resultFileName(session)
console.log(`   ${name}`)
check('names the location and the day', name === 'cycle-count-TRANSIT-B02-2026-08-31.csv', name)
// Locations contain spaces, dots, slashes and brackets - none may reach a
// Windows filename.
const awkward = resultFileName({
  location: 'CANOPY-LOC-047 (STORAGE CANOPY EX-SOR5)',
  started_at: '2026-08-31T02:55:00Z',
})
console.log(`   ${awkward}`)
check('an awkward location is made safe', /^[A-Za-z0-9.\-]+$/.test(awkward), awkward)
check('and still ends in .csv', awkward.endsWith('.csv'), awkward)

console.log('\n--- every count, every admin ---')

// Straight from the cycle_count_rows view: each row carries its own session,
// and "never scanned" has already been resolved to result = 'not_checked'.
const viewRows = [
  { session_id: 's1', location: 'TRANSIT B02', started_at: '2026-08-30T02:00:00Z',
    started_by: 'doni', reason: 'Wrong put away', action: ['put_away'], done: true,
    remark: null, case_no: 'OLD-1', result: 'wrong_location', query_opened: false,
    system_locations: ['REC-TRANSIT-01'] },
  { session_id: 's2', location: 'STORAGE-A001', started_at: '2026-08-31T02:00:00Z',
    started_by: 'dion', reason: null, action: null, done: false, remark: null,
    case_no: 'NEW-1', result: 'match', query_opened: false,
    system_locations: ['STORAGE-A001'] },
  { session_id: 's2', location: 'STORAGE-A001', started_at: '2026-08-31T02:00:00Z',
    started_by: 'dion', reason: null, action: null, done: false, remark: null,
    case_no: 'NEW-2', result: 'not_checked', query_opened: false,
    system_locations: ['STORAGE-A001'] },
  { session_id: 's2', location: 'STORAGE-A001', started_at: '2026-08-31T02:00:00Z',
    started_by: 'dion', reason: null, action: null, done: false, remark: null,
    case_no: 'NEW-3', result: 'match', query_opened: true,
    system_locations: ['STORAGE-A001'] },
]

const arows = allRows(viewRows)

check('every row is kept', arows.length === 4, String(arows.length))
// The two things the user asked for by name.
check('need-check cases are included',
      arows.some((r) => r.Status === 'Need check'),
      arows.map((r) => r.Status).join(','))
check('more than one admin appears',
      new Set(arows.map((r) => r.Checker)).size === 2,
      [...new Set(arows.map((r) => r.Checker))].join(','))

check('newest count first', arows[0].Date === '2026-08-31', arows[0].Date)
check('the older count is last', arows.at(-1).Date === '2026-08-30', arows.at(-1).Date)
check('numbering is continuous across counts',
      arows.map((r) => r.No).join(',') === '1,2,3,4', arows.map((r) => r.No).join(','))

// Each row must carry ITS OWN count's location and decision - the bug this
// export could easily have: one session's action smeared across all of them.
const older = arows.find((r) => r['Case Number'] === 'OLD-1')
const newer = arows.find((r) => r['Case Number'] === 'NEW-1')
check('each row keeps its own location',
      older['Actual Location'] === 'TRANSIT B02' &&
        newer['Actual Location'] === 'STORAGE-A001',
      `${older['Actual Location']} / ${newer['Actual Location']}`)
check('each row keeps its own checker',
      older.Checker === 'doni' && newer.Checker === 'dion',
      `${older.Checker} / ${newer.Checker}`)
check('a decision does not leak between counts',
      older.Action === 'Put away' && newer.Action === '',
      `"${older.Action}" / "${newer.Action}"`)
check('the status does not leak either',
      older.Done === 'done' && newer.Done === 'in progress',
      `"${older.Done}" / "${newer.Done}"`)

// The finding that matters most must survive this path too.
const opened = arows.find((r) => r['Case Number'] === 'NEW-3')
check('an opened-in-Query case keeps its finding',
      opened.Finding === 'Opened in Query' && opened.Status === 'False',
      `${opened.Status} / ${opened.Finding}`)

const acsv = buildAllCsv(viewRows)
check('the all-counts CSV uses the same columns as one count',
      acsv.split('\n')[0] === RESULT_COLUMNS.join(','), 'same header')
check('one line per case plus the header', acsv.trimEnd().split('\n').length === 5,
      String(acsv.trimEnd().split('\n').length))
check('it is named for today',
      /^cycle-count-all-\d{4}-\d{2}-\d{2}\.csv$/.test(allFileName()), allFileName())
check('an empty history produces just a header',
      buildAllCsv([]).trim() === RESULT_COLUMNS.join(','), 'header only')

console.log('\n--- the statistics CSV ---')

const days = [
  { count_date: '2026-08-03', started_by: 'doni', locations: 13, sessions: 13,
    scanned: 75, clean_match: 43, opened_mismatch: 0, wrong_location: 32,
    not_in_query: 0, not_checked: 12 },
  { count_date: '2026-08-04', started_by: 'doni', locations: 1, sessions: 1,
    scanned: 103, clean_match: 103, opened_mismatch: 0, wrong_location: 0,
    not_in_query: 0, not_checked: 0 },
  { count_date: '2026-08-05', started_by: 'dion', locations: 0, sessions: 0,
    scanned: 0, clean_match: 0, opened_mismatch: 0, wrong_location: 0,
    not_in_query: 0, not_checked: 4 },
]
const drows = dailyRows(days, accuracy)

// The figure from their own Recap sheet. If this drifts, the new numbers stop
// being comparable with their history.
check('3 Aug reproduces their 57.3%', drows[0]['Accuracy %'] === '57.3', drows[0]['Accuracy %'])
check('a perfect day is 100.0', drows[1]['Accuracy %'] === '100.0', drows[1]['Accuracy %'])
// 0% would read as a terrible day rather than no day at all.
check('a day with nothing scanned is blank, not 0',
      drows[2]['Accuracy %'] === '', `"${drows[2]['Accuracy %']}"`)
check('need check is still reported on that day', drows[2]['Need check'] === 4,
      String(drows[2]['Need check']))

const dcsv = buildDailyCsv(days, accuracy)
check('statistics header matches the columns',
      dcsv.split('\n')[0] === DAILY_COLUMNS.join(','), dcsv.split('\n')[0])
check('one line per day plus the header', dcsv.trimEnd().split('\n').length === 4,
      String(dcsv.trimEnd().split('\n').length))
check('the statistics file is named for today',
      /^cycle-count-statistics-\d{4}-\d{2}-\d{2}\.csv$/.test(dailyFileName()), dailyFileName())

report()
