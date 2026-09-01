// CSV for the cycle count: the result of one session, and the statistics.
//
// No Supabase import, so it can be tested in plain node - the same reason
// csv.js and exportFormat.js are separate. A quoting or column-order mistake
// here is silent: the file opens, the columns just quietly hold the wrong
// things, and someone adjusts stock from it.

// The `.js` extensions are required, not stylistic: Vite resolves without
// them, plain Node does not, and this file has to run under both.
import { toCsv } from './csv.js'
import { RESULTS, ACTION_LABEL, bucketOf } from './cycleCount.js'

/**
 * Columns of the session result, deliberately shaped like the Compare sheet of
 * "Spot check Augst.xlsm" so it drops into the workflow the warehouse already
 * has.
 *
 * `Part number` and `Qty` are always empty. They are in their sheet, and were
 * empty in all 606 real rows of it - the count records where a case is, not
 * what is in it. They are kept so the columns line up when this is pasted into
 * their existing template.
 */
export const RESULT_COLUMNS = [
  'No',
  'Date',
  'Checker',
  'Case Number',
  'Actual Location',
  'Part number',
  'Qty',
  'Query Location',
  'Status',
  'Finding',
  'Reason',
  'Action',
  'Done',
  'Remark',
]

/** Their sheet only ever held True and False. "Need check" is new. */
function statusOf(bucket) {
  if (bucket === 'clean_match') return 'True'
  if (bucket === 'not_checked') return 'Need check'
  return 'False'
}

/** yyyy-mm-dd in the warehouse's own timezone, not UTC. */
export function localDate(ts, timeZone = 'Asia/Jakarta') {
  if (!ts) return ''
  // en-CA gives ISO order (2026-08-31), which sorts correctly as text.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

/**
 * One row per case: everything scanned, plus everything Query expected here
 * that nobody scanned.
 *
 * The session's single reason / action / done is repeated on every row. That
 * is what the user asked for - one decision covers the whole location - and
 * repeating it keeps each row self-contained once the file is sorted or
 * filtered in Excel.
 */
export function resultRows(session, scans, notChecked = []) {
  const date = localDate(session.started_at)
  const checker = session.started_by ?? ''
  const reason = session.reason ?? ''
  const action = session.action ? (ACTION_LABEL[session.action] ?? session.action) : ''
  const done = session.done ? 'done' : ''
  const remark = session.remark ?? ''

  const rows = []
  const push = (case_no, bucket, where) =>
    rows.push({
      No: rows.length + 1,
      Date: date,
      Checker: checker,
      'Case Number': case_no,
      'Actual Location': session.location,
      'Part number': '',
      Qty: '',
      // A case can sit in more than one location - 381 of 108,778 full cases
      // do - so this is a list, joined rather than silently truncated.
      'Query Location': (where ?? []).join(' | '),
      Status: statusOf(bucket),
      Finding: RESULTS[bucket]?.label ?? bucket,
      Reason: reason,
      Action: action,
      Done: done,
      Remark: remark,
    })

  for (const s of scans) push(s.case_no, bucketOf(s), s.system_locations)
  // Never scanned, so Query's location for them is this location by definition.
  for (const case_no of notChecked) push(case_no, 'not_checked', [session.location])

  return rows
}

export function buildResultCsv(session, scans, notChecked = []) {
  return toCsv(resultRows(session, scans, notChecked), RESULT_COLUMNS)
}

/** Safe for a Windows filename: locations contain spaces, slashes and dots. */
function slug(s) {
  return String(s ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function resultFileName(session) {
  return `cycle-count-${slug(session.location)}-${localDate(session.started_at)}.csv`
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export const DAILY_COLUMNS = [
  'Date',
  'Checker',
  'Locations',
  'Counted',
  'True',
  'Query opened',
  'Wrong location',
  'Not in Query',
  'Accuracy %',
  'Need check',
]

/**
 * Shaped like their Recap sheet: one row per day per person, with the accuracy
 * they already know. `accuracy` is passed in rather than recomputed so there
 * stays exactly one definition of it, in cycleCount.js.
 */
export function dailyRows(days, accuracyOf) {
  return days.map((d) => {
    const pct = accuracyOf({
      clean_match: Number(d.clean_match),
      scanned: Number(d.scanned),
    })
    return {
      Date: d.count_date,
      Checker: d.started_by,
      Locations: Number(d.locations),
      Counted: Number(d.scanned),
      True: Number(d.clean_match),
      'Query opened': Number(d.opened_mismatch),
      'Wrong location': Number(d.wrong_location),
      'Not in Query': Number(d.not_in_query),
      // Blank rather than 0 when nothing was scanned: 0% would read as a
      // terrible day rather than no day at all.
      'Accuracy %': pct === null ? '' : pct.toFixed(1),
      'Need check': Number(d.not_checked),
    }
  })
}

export function buildDailyCsv(days, accuracyOf) {
  return toCsv(dailyRows(days, accuracyOf), DAILY_COLUMNS)
}

export function dailyFileName(now = new Date()) {
  return `cycle-count-statistics-${localDate(now)}.csv`
}
