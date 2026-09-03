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
  actionLabel,
  bucketOf,
  readScan,
  summarise,
  accuracy,
  describeScan,
  reportRows,
  suggestedAction,
  totalsByDay,
  groupByArea,
  AREA_GROUPS,
  recheckRow,
  recheckRows,
  RECHECK,
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
// A wrong-location case that is ALSO opened cannot be put away, and the screen
// said nothing about it while the warning underneath counted seven of them.
check('a wrong-location case that is also opened says so',
      describeScan({ result: 'wrong_location', system_locations: ['X'], query_opened: true })
        === 'Query says X - and OPENED',
      describeScan({ result: 'wrong_location', system_locations: ['X'], query_opened: true }))
// The bucket label is only for cases in the RIGHT place - the old wording
// read as though it covered both and made the counter look wrong.
check('the opened bucket is named for the right place only',
      RESULTS.opened_mismatch.label === 'Here but opened', RESULTS.opened_mismatch.label)

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

console.log('\n--- actions: a LIST, because one count can need several ---')

check('the three actions', ACTIONS.map((a) => a.value).join(',') === 'put_away,shortage,profit',
      ACTIONS.map((a) => a.value).join(','))
// The old combined value is gone: ticking two boxes IS the pair, and keeping
// both would give two ways to record the same decision.
check('there is no combined shortage_profit option',
      !ACTIONS.some((a) => a.value === 'shortage_profit'), 'gone')
check('ticking both still reads as their phrase',
      actionLabel(['shortage', 'profit']) === 'Shortage + Profit',
      actionLabel(['shortage', 'profit']))
check('the label order follows ACTIONS, not the ticking order',
      actionLabel(['profit', 'put_away']) === 'Put away + Profit',
      actionLabel(['profit', 'put_away']))
check('one action reads plainly', actionLabel(['put_away']) === 'Put away',
      actionLabel(['put_away']))
check('no action is an empty label', actionLabel([]) === '', `"${actionLabel([])}"`)
check('null does not throw', actionLabel(null) === '', `"${actionLabel(null)}"`)
// Rows written before the migration could still hand us a bare string.
check('a single string is tolerated', actionLabel('shortage') === 'Shortage',
      actionLabel('shortage'))
check('an unknown value is ignored, not printed',
      actionLabel(['nonsense', 'profit']) === 'Profit', actionLabel(['nonsense', 'profit']))

// Every finding contributes now, which is the point of allowing several.
const sug = (c) => suggestedAction(c).join(',')
check('an opened mismatch suggests shortage and profit',
      sug({ opened_mismatch: 1, not_in_query: 0, wrong_location: 0 }) === 'shortage,profit',
      sug({ opened_mismatch: 1, not_in_query: 0, wrong_location: 0 }))
check('wrong location suggests put away',
      sug({ opened_mismatch: 0, not_in_query: 0, wrong_location: 1 }) === 'put_away',
      sug({ opened_mismatch: 0, not_in_query: 0, wrong_location: 1 }))
check('not in query suggests profit',
      sug({ opened_mismatch: 0, not_in_query: 1, wrong_location: 0 }) === 'profit',
      sug({ opened_mismatch: 0, not_in_query: 1, wrong_location: 0 }))
// All three findings at once: the case the old single-value action could not
// express at all.
check('all three findings suggest all three actions',
      sug({ opened_mismatch: 1, not_in_query: 2, wrong_location: 3 })
        === 'put_away,shortage,profit',
      sug({ opened_mismatch: 1, not_in_query: 2, wrong_location: 3 }))
check('profit is not suggested twice',
      suggestedAction({ opened_mismatch: 1, not_in_query: 1, wrong_location: 0 })
        .filter((a) => a === 'profit').length === 1, 'once')
check('a clean count suggests nothing',
      suggestedAction({ opened_mismatch: 0, not_in_query: 0, wrong_location: 0 }).length === 0,
      '[]')
check('missing counts do not throw', suggestedAction(null).length === 0, '[]')
check('every suggestion is a real action',
      suggestedAction({ opened_mismatch: 1, not_in_query: 1, wrong_location: 1 })
        .every((v) => ACTIONS.some((a) => a.value === v)), 'ok')

console.log('\n--- adding the admins together, per day (the chart) ---')

// cycle_count_daily is grouped by day AND admin. The chart wants the
// warehouse's total for the day, whoever counted it.
const daily = [
  { count_date: '2026-08-31', started_by: 'doni', clean_match: 10, opened_mismatch: 1,
    wrong_location: 2, not_in_query: 0, not_checked: 5, scanned: 13, locations: 2 },
  { count_date: '2026-08-31', started_by: 'dion', clean_match: 4, opened_mismatch: 0,
    wrong_location: 1, not_in_query: 3, not_checked: 2, scanned: 8, locations: 1 },
  { count_date: '2026-08-30', started_by: 'doni', clean_match: 7, opened_mismatch: 0,
    wrong_location: 0, not_in_query: 0, not_checked: 0, scanned: 7, locations: 1 },
]
const byDay = totalsByDay(daily)

check('one row per day, not per admin', byDay.length === 2, String(byDay.length))
check('newest day first', byDay[0].count_date === '2026-08-31', byDay[0].count_date)

const d31 = byDay[0]
check('clean matches add up', d31.clean_match === 14, String(d31.clean_match))
check('scanned adds up', d31.scanned === 21, String(d31.scanned))
check('every bucket adds up',
      d31.opened_mismatch === 1 && d31.wrong_location === 3 && d31.not_in_query === 3,
      `${d31.opened_mismatch}/${d31.wrong_location}/${d31.not_in_query}`)
check('need check adds up too', d31.not_checked === 7, String(d31.not_checked))
check('locations add up', d31.locations === 3, String(d31.locations))
check('admins are counted, not summed', d31.admins === 2, String(d31.admins))
check('a single-admin day still reports 1 admin', byDay[1].admins === 1, String(byDay[1].admins))

// The stacked bar is only honest if the parts really make up the whole.
check('the four scanned buckets equal the total scanned',
      byDay.every((d) =>
        d.clean_match + d.opened_mismatch + d.wrong_location + d.not_in_query === d.scanned),
      'ok')
// Need check must NOT be in the stack - those cases were never handled.
check('need check is kept out of scanned',
      d31.scanned === 21 && d31.not_checked === 7, `${d31.scanned} / ${d31.not_checked}`)

check('the accuracy of a summed day is right',
      Math.abs(accuracy({ clean_match: d31.clean_match, scanned: d31.scanned }) - 66.667) < 0.01,
      accuracy({ clean_match: d31.clean_match, scanned: d31.scanned }).toFixed(3))

check('no days is an empty list, not a crash', totalsByDay([]).length === 0, '0')
check('string counts from PostgREST still add up',
      totalsByDay([{ count_date: 'x', started_by: 'a', clean_match: '3', scanned: '4' }])[0]
        .clean_match === 3, 'numeric')

console.log('\n--- grouping by area, the way their report does ---')

// The buckets calc_area() actually produces, with the real sizes measured on
// 2026-09-01: 8,724 locations, and every one of them in exactly one area.
const sizes = [
  { area: 'OF', locations: 2171, cases: 46019 },
  { area: 'DLOC', locations: 4421, cases: 38175 },
  { area: 'Transit', locations: 86, cases: 28390 },
  { area: 'XIN2', locations: 342, cases: 14973 },
  { area: 'HR', locations: 1562, cases: 14133 },
  { area: 'YANFENG', locations: 32, cases: 3421 },
  { area: 'New Lingyun', locations: 34, cases: 778 },
  { area: 'Baosteel', locations: 11, cases: 589 },
]
const countedAreas = [
  { area: 'Transit', sessions: 3, locations: 3, scanned: 100, clean_match: 90,
    opened_mismatch: 2, wrong_location: 6, not_in_query: 2, not_checked: 10 },
  { area: 'HR', sessions: 1, locations: 1, scanned: 20, clean_match: 20,
    opened_mismatch: 0, wrong_location: 0, not_in_query: 0, not_checked: 0 },
  { area: 'XIN2', sessions: 1, locations: 1, scanned: 21, clean_match: 21,
    opened_mismatch: 0, wrong_location: 0, not_in_query: 0, not_checked: 0 },
  { area: 'YANFENG', sessions: 1, locations: 1, scanned: 5, clean_match: 4,
    opened_mismatch: 0, wrong_location: 1, not_in_query: 0, not_checked: 0 },
]
const grouped = groupByArea(countedAreas, sizes)
const at = (label) => grouped.find((g) => g.label === label)

check('the report\'s group order is preserved',
      grouped.map((g) => g.label).join(',') === 'HR,Transit,XINHAI,DLOC,OF,OW SAIC',
      grouped.map((g) => g.label).join(','))

// XIN1 and XIN2 are one group in their report, and XIN1 has never had rows.
check('XIN2 lands under XINHAI', at('XINHAI').scanned === 21, String(at('XINHAI').scanned))
check('and carries XIN2\'s size', at('XINHAI').totalCases === 14973,
      String(at('XINHAI').totalCases))

// Yanfeng is not named anywhere, so it must fall into OW SAIC rather than
// vanish - a new supplier area should never silently disappear.
check('an unnamed OW area falls into OW SAIC', at('OW SAIC').scanned === 5,
      String(at('OW SAIC').scanned))
check('OW SAIC sums every unnamed area',
      at('OW SAIC').totalCases === 3421 + 778 + 589, String(at('OW SAIC').totalCases))

// An area with nothing counted must stay on the dashboard: that gap is the
// entire point of having a plan.
check('DLOC is listed even with nothing counted',
      at('DLOC') && at('DLOC').scanned === 0 && at('DLOC').totalCases === 38175,
      `${at('DLOC')?.scanned} of ${at('DLOC')?.totalCases}`)
check('OF too', at('OF').scanned === 0 && at('OF').totalLocations === 2171, 'listed')

check('counted locations are shown against the area total',
      at('Transit').locations === 3 && at('Transit').totalLocations === 86,
      `${at('Transit').locations} / ${at('Transit').totalLocations}`)
check('the area accuracy is right',
      Math.abs(accuracy({ clean_match: at('Transit').clean_match,
                          scanned: at('Transit').scanned }) - 90) < 0.001, '90%')

check('nothing at all produces no rows', groupByArea([], []).length === 0, '0')
check('every group in the report is defined',
      AREA_GROUPS.map((g) => g.label).join(',') === 'HR,Transit,XINHAI,DLOC,OF,OW SAIC',
      AREA_GROUPS.map((g) => g.label).join(','))
check('exactly one group is the catch-all',
      AREA_GROUPS.filter((g) => g.catchAll).length === 1, 'one')

console.log('\n--- re-checking a finished count against Query ---')

const HERE = 'TRANSIT B02'
const rc = (bucket, current) => recheckRow({ bucket }, current, HERE)

// A wrong-location case is fixed once Query has it where it was counted.
check('wrong location, now here -> fixed',
      rc('wrong_location', { locations: [HERE], opened: false }) === 'fixed', 'fixed')
check('wrong location, still elsewhere -> still wrong',
      rc('wrong_location', { locations: ['REC-TRANSIT-01'], opened: false }) === 'still_wrong',
      'still_wrong')
// A case can sit in several places; being here is enough.
check('here AND elsewhere still counts as fixed',
      rc('wrong_location', { locations: ['REC-TRANSIT-01', HERE], opened: false }) === 'fixed',
      'fixed')
check('wrong location, vanished from Query -> gone',
      rc('wrong_location', undefined) === 'gone', 'gone')

// A case Query never knew about is fixed by a profit: it should now exist here.
check('not in query, now here -> fixed',
      rc('not_in_query', { locations: [HERE], opened: false }) === 'fixed', 'fixed')
check('not in query, still absent -> still wrong',
      rc('not_in_query', undefined) === 'still_wrong', 'still_wrong')
check('not in query, appeared somewhere else -> still wrong',
      rc('not_in_query', { locations: ['DUMMY'], opened: false }) === 'still_wrong',
      'still_wrong')

// The opened case needs BOTH halves: back here, and no longer flagged opened.
check('opened mismatch, here and no longer opened -> fixed',
      rc('opened_mismatch', { locations: [HERE], opened: false }) === 'fixed', 'fixed')
check('opened mismatch, here but STILL opened -> still wrong',
      rc('opened_mismatch', { locations: [HERE], opened: true }) === 'still_wrong',
      'still_wrong')
check('opened mismatch, closed but moved away -> still wrong',
      rc('opened_mismatch', { locations: ['DUMMY'], opened: false }) === 'still_wrong',
      'still_wrong')

const problems = [
  { case_no: 'A', bucket: 'wrong_location' },
  { case_no: 'B', bucket: 'wrong_location' },
  { case_no: 'C', bucket: 'not_in_query' },
  { case_no: 'D', bucket: 'not_checked' },
]
const current = new Map([
  ['A', { locations: [HERE], opened: false }],
  ['B', { locations: ['SOMEWHERE-ELSE'], opened: false }],
  ['C', { locations: [HERE], opened: false }],
])
const res = recheckRows(problems, current, HERE)

check('two fixed, one outstanding',
      res.fixed === 2 && res.outstanding === 1, `${res.fixed} / ${res.outstanding}`)
// Never-scanned cases have no adjustment to have landed.
check('never-scanned cases are left out',
      !res.rows.some((r) => r.case_no === 'D'), 'excluded')
check('every row keeps its original bucket',
      res.rows.every((r) => r.bucket), 'kept')

// The recorded count must survive being looked at again.
check('re-checking does not touch the original rows',
      problems.every((p) => !('recheck' in p)), 'untouched')

check('every recheck value has a label and tone',
      ['fixed', 'still_wrong', 'gone'].every((k) => RECHECK[k]?.label && RECHECK[k]?.tone),
      Object.keys(RECHECK).join(', '))

console.log('\n--- the five buckets are all named ---')
check('every bucket has a label and tone',
      RESULT_ORDER.every((k) => RESULTS[k]?.label && RESULTS[k]?.tone),
      RESULT_ORDER.join(', '))
check('True is named as in their workbook', RESULTS.clean_match.label === 'True',
      RESULTS.clean_match.label)
check('the fourth bucket is "need check later"',
      RESULTS.not_checked.label === 'Need check later', RESULTS.not_checked.label)

report()
