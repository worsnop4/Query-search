// Transit monitoring: the aging, the buckets and the follow-up rule.
//
// The number this produces decides whether someone goes and chases a case, and
// it is a DATE subtraction - which is exactly the kind of arithmetic that goes
// quietly wrong across a timezone. Their spreadsheet also labelled a case that
// arrived that morning "1 DAY", so off-by-one here is not hypothetical.
//
//   node scripts/test-transit.mjs
import {
  TIME_ZONE,
  FOLLOW_UP_AFTER,
  BUCKETS,
  localDate,
  ageInDays,
  bucketOf,
  needsFollowUp,
  prepare,
  summarise,
  arrivalsByDay,
} from '../src/lib/transit.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

// 2026-09-03 10:00 WIB = 03:00 UTC.
const NOW = new Date('2026-09-03T03:00:00Z')

console.log('--- days are counted in Jakarta, not UTC ---')

check('the timezone is the warehouse\'s', TIME_ZONE === 'Asia/Jakarta', TIME_ZONE)
// 23:00 WIB on the 2nd is 16:00 UTC the same day - both give the 2nd.
check('an evening arrival keeps its own day',
      localDate('2026-09-02T16:00:00Z') === '2026-09-02', localDate('2026-09-02T16:00:00Z'))
// 00:30 WIB on the 3rd is 17:30 UTC on the 2nd. Counting in UTC would call
// this the 2nd and report the case a day older than it is.
check('an after-midnight arrival belongs to the new day',
      localDate('2026-09-02T17:30:00Z') === '2026-09-03', localDate('2026-09-02T17:30:00Z'))
check('a missing time has no date', localDate(null) === null, 'null')
check('rubbish has no date', localDate('not a date') === null, 'null')

console.log('\n--- the aging, and the off-by-one their sheet had ---')

// The correction the user asked for: arrived today is 0 days, not 1.
check('arrived this morning is 0 days',
      ageInDays('2026-09-03T01:00:00Z', NOW) === 0, String(ageInDays('2026-09-03T01:00:00Z', NOW)))
check('arrived yesterday is 1 day',
      ageInDays('2026-09-02T01:00:00Z', NOW) === 1, String(ageInDays('2026-09-02T01:00:00Z', NOW)))
check('three days ago is 3',
      ageInDays('2026-08-31T01:00:00Z', NOW) === 3, String(ageInDays('2026-08-31T01:00:00Z', NOW)))

// The whole point of reducing both ends to a date: the answer must not drift
// as the day goes on.
const early = ageInDays('2026-09-01T02:00:00Z', new Date('2026-09-03T00:30:00Z'))
const late = ageInDays('2026-09-01T02:00:00Z', new Date('2026-09-03T16:30:00Z'))
check('the age does not change during the day', early === late, `${early} vs ${late}`)

// A case that arrived late in the WIB evening. Stored as 17:00+ UTC, which is
// where the old timezone bug did its damage.
check('a 00:30 WIB arrival is 0 days old that morning',
      ageInDays('2026-09-02T17:30:00Z', new Date('2026-09-03T03:00:00Z')) === 0,
      String(ageInDays('2026-09-02T17:30:00Z', new Date('2026-09-03T03:00:00Z'))))

check('no arrival time gives null, not zero',
      ageInDays(null, NOW) === null, String(ageInDays(null, NOW)))

console.log('\n--- buckets say what they mean ---')

check('0 days is Today', bucketOf(0) === 'today', bucketOf(0))
check('3 days is the "3 days" bucket', bucketOf(3) === 'd3', bucketOf(3))
check('7 days lands in 7+', bucketOf(7) === 'd7', bucketOf(7))
// Their detail list stopped at 10 days, hiding the worst cases. The user asked
// for "all case more than 3 days", so the last bucket is open-ended.
check('90 days still lands in 7+', bucketOf(90) === 'd7', bucketOf(90))
check('an unknown age has no bucket', bucketOf(null) === null, String(bucketOf(null)))
check('the buckets cover every age with no gap',
      BUCKETS.every((b, i) => i === 0 ? b.min === 0 : b.min === BUCKETS[i - 1].max + 1), 'contiguous')
check('the label matches the number',
      BUCKETS.find((b) => b.key === 'd3').label === '3 days',
      BUCKETS.find((b) => b.key === 'd3').label)

console.log('\n--- "more than 3 days" ---')

check('the limit is 3', FOLLOW_UP_AFTER === 3, String(FOLLOW_UP_AFTER))
check('3 days is still fine', !needsFollowUp(3), 'ok')
check('4 days needs following up', needsFollowUp(4), 'follow up')
check('today is fine', !needsFollowUp(0), 'ok')
check('an unknown age is not chased', !needsFollowUp(null), 'ok')

console.log('\n--- preparing the list ---')

const cases = [
  { case_no: 'OLD',    first_inbound_time: '2026-08-20T02:00:00Z', has_small_part: true },
  { case_no: 'FOUR',   first_inbound_time: '2026-08-30T02:00:00Z', has_small_part: true },
  { case_no: 'THREE',  first_inbound_time: '2026-08-31T02:00:00Z', has_small_part: true },
  { case_no: 'TODAY',  first_inbound_time: '2026-09-03T01:00:00Z', has_small_part: true },
  { case_no: 'BIG',    first_inbound_time: '2026-08-01T02:00:00Z', has_small_part: false },
  { case_no: 'NOTIME', first_inbound_time: null,                   has_small_part: true },
]

const small = prepare(cases, { now: NOW })
check('non small-part cases are filtered out',
      !small.some((c) => c.case_no === 'BIG'), 'excluded')
check('everything else is kept', small.length === 5, String(small.length))
check('oldest first', small[0].case_no === 'OLD', small[0].case_no)
// A case with no arrival time must not silently sort as "brand new".
check('an unknown age sorts last', small.at(-1).case_no === 'NOTIME', small.at(-1).case_no)

const all = prepare(cases, { now: NOW, smallPartOnly: false })
check('the filter can be turned off', all.length === 6, String(all.length))

console.log('\n--- the summary ---')

const s = summarise(small)
check('four days is a follow-up', small.find((c) => c.case_no === 'FOUR').followUp, 'yes')
check('three days is not', !small.find((c) => c.case_no === 'THREE').followUp, 'no')
check('two cases need following up', s.followUp === 2, String(s.followUp))
check('one case has no arrival time', s.unknown === 1, String(s.unknown))
check('the oldest is reported', s.oldest === 14, String(s.oldest))
check('today is counted', s.counts.today === 1, String(s.counts.today))
check('the bucket counts plus unknown equal the total',
      Object.values(s.counts).reduce((a, b) => a + b, 0) + s.unknown === s.total,
      `${Object.values(s.counts).reduce((a, b) => a + b, 0)} + ${s.unknown} vs ${s.total}`)

console.log('\n--- arrivals per day ---')

const days = arrivalsByDay(small, 7, NOW)
check('one entry per day', days.length === 7, String(days.length))
check('the last entry is today', days.at(-1).today === true, days.at(-1).date)
check('today\'s arrival is counted', days.at(-1).count === 1, String(days.at(-1).count))
check('a day with no arrivals is 0, not missing',
      days.every((d) => typeof d.count === 'number'), 'all present')
// FOUR (Aug 30), THREE (Aug 31) and TODAY (Sep 3) fall inside the 7-day
// window; OLD (Aug 20) does not, and must not be crammed into the first day.
check('only arrivals inside the window are counted',
      days.reduce((a, d) => a + d.count, 0) === 3,
      String(days.reduce((a, d) => a + d.count, 0)))
check('the window starts 6 days back', days[0].date === '2026-08-28', days[0].date)
check('the case from outside the window is absent',
      days.find((d) => d.date === '2026-08-20') === undefined, 'absent')

console.log('\n--- the follow-up export ---')

const { FOLLOW_UP_COLUMNS, followUpRows, buildFollowUpCsv, followUpFileName } =
  await import('../src/lib/transitExport.js')

const withDetail = prepare(
  [
    { case_no: 'A, WITH COMMA', first_inbound_time: '2026-08-20T02:00:00Z',
      has_small_part: true, part_number: '10531725-PMC', part_name: 'CLIP',
      part_type: 'SMALL PART', quantity: 500, part_count: 2, opened: true },
    { case_no: 'FRESH', first_inbound_time: '2026-09-03T01:00:00Z',
      has_small_part: true, part_number: 'X', part_name: 'Y',
      part_type: 'SMALL PART', quantity: 1, part_count: 1, opened: false },
    { case_no: 'NOTIME', first_inbound_time: null, has_small_part: true },
  ],
  { now: NOW }
)
const ex = followUpRows(withDetail, 3)

check('only overdue cases are exported', ex.length === 1, String(ex.length))
check('a fresh case is left out', !ex.some((r) => r['Case Number'] === 'FRESH'), 'excluded')
// An unknown age is not evidence of being overdue.
check('a case with no arrival time is left out',
      !ex.some((r) => r['Case Number'] === 'NOTIME'), 'excluded')
check('numbering starts at 1', ex[0].No === 1, String(ex[0].No))
check('the arrival is the local date', ex[0].Arrived === '2026-08-20', ex[0].Arrived)
check('the age is carried', ex[0]['Days in transit'] === 14, String(ex[0]['Days in transit']))
check('opened reads Yes/No', ex[0]['Cases opened'] === 'Yes', ex[0]['Cases opened'])

const csv = buildFollowUpCsv(withDetail, 3)
check('header matches the columns',
      csv.split('\n')[0] === FOLLOW_UP_COLUMNS.join(','), csv.split('\n')[0])
// Case numbers contain commas - 4 of them do.
check('a comma inside a case number is quoted',
      csv.includes('"A, WITH COMMA"'), csv.split('\n')[1].slice(0, 40))
check('one line per case plus the header',
      csv.trimEnd().split('\n').length === 2, String(csv.trimEnd().split('\n').length))
check('named for today',
      /^transit-follow-up-\d{4}-\d{2}-\d{2}\.csv$/.test(followUpFileName()), followUpFileName())

report()
