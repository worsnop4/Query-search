// Transit monitoring: how long a case has been sitting in the TRANSIT bay.
//
// Replaces a spreadsheet that pulled the arrival time out of a second
// workbook, `INbound monitoring (new).xlsb`, by XLOOKUP on the case number.
// Compared against our own first_inbound_time the two differ by about three
// minutes, and the aging only uses the DATE, so that external file is not
// needed - which also removes the blank rows their sheet showed wherever the
// lookup missed.
//
// COUNTED IN WHOLE LOCAL DAYS. A case that arrived today is 0 days old and is
// shown as "Today"; one that arrived yesterday is 1. So "3 days" means three
// days, which is the correction the user asked for - their sheet's "1 DAY"
// bucket actually held cases that arrived that morning.
//
// The timezone matters here more than anywhere else in the app. Days are
// counted in Asia/Jakarta: a case that arrived at 23:00 WIB is 16:00 UTC the
// same day, and counting in UTC would put it on the wrong calendar day.

export const TIME_ZONE = 'Asia/Jakarta'

/** Cases older than this need following up. "More than 3 days" - so 4 and up. */
export const FOLLOW_UP_AFTER = 3

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** yyyy-mm-dd in the warehouse's own day, not UTC's. */
export function localDate(ts) {
  if (!ts) return null
  const d = ts instanceof Date ? ts : new Date(ts)
  if (isNaN(d.getTime())) return null
  return fmt.format(d)
}

/** Whole days between two yyyy-mm-dd strings. */
function daysBetween(fromISO, toISO) {
  const a = Date.UTC(...fromISO.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
  const b = Date.UTC(...toISO.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
  return Math.round((b - a) / 86400000)
}

/**
 * How many whole local days a case has been in transit.
 *
 * Both ends are reduced to a calendar DATE first, so the answer does not
 * depend on the time of day it is asked - a case that arrived at 08:00 is
 * still "1 day" whether you look at 09:00 or 23:00 the next day. That is what
 * their `DAYS(NOW(), INT(LES IN))` did, and it is what makes the number stable
 * enough to act on.
 *
 * Returns null when there is no arrival time, rather than 0 - "arrived today"
 * and "we do not know when it arrived" are different answers.
 */
export function ageInDays(firstInboundTime, now = new Date()) {
  const from = localDate(firstInboundTime)
  const to = localDate(now)
  if (!from || !to) return null
  return daysBetween(from, to)
}

/**
 * The buckets on the dashboard.
 *
 * Their sheet ran "1 DAY".."6 DAY" then "> 7 DAY", where "1 DAY" meant a case
 * that arrived that morning. These say what they mean, and the last bucket is
 * open-ended: the user asked for "all case more than 3 days", so nothing is
 * capped at 10 the way their detail list was - the oldest cases are exactly
 * the ones worth seeing.
 */
export const BUCKETS = [
  { key: 'today', label: 'Today', min: 0, max: 0, tone: 'ok' },
  { key: 'd1', label: '1 day', min: 1, max: 1, tone: 'ok' },
  { key: 'd2', label: '2 days', min: 2, max: 2, tone: 'ok' },
  { key: 'd3', label: '3 days', min: 3, max: 3, tone: 'ok' },
  { key: 'd4', label: '4 days', min: 4, max: 4, tone: 'warn' },
  { key: 'd5', label: '5 days', min: 5, max: 5, tone: 'warn' },
  { key: 'd6', label: '6 days', min: 6, max: 6, tone: 'warn' },
  { key: 'd7', label: '7+ days', min: 7, max: Infinity, tone: 'bad' },
]

export function bucketOf(age) {
  if (age === null || age === undefined) return null
  return BUCKETS.find((b) => age >= b.min && age <= b.max)?.key ?? null
}

/** Past the limit, so it needs chasing. */
export function needsFollowUp(age, after = FOLLOW_UP_AFTER) {
  return age !== null && age !== undefined && age > after
}

/**
 * Add the aging to every case and keep only the ones being monitored.
 *
 * `smallPartOnly` mirrors their Compare sheet, which filters the export to
 * Part Type = "SMALL PART" before doing anything else. It is a toggle rather
 * than a hard rule so the same screen can show everything at TRANSIT when
 * someone wants the whole picture.
 */
export function prepare(cases, { now = new Date(), smallPartOnly = true } = {}) {
  return cases
    .filter((c) => (smallPartOnly ? c.has_small_part : true))
    .map((c) => {
      const age = ageInDays(c.first_inbound_time, now)
      return { ...c, age, bucket: bucketOf(age), followUp: needsFollowUp(age) }
    })
    .sort((a, b) => (b.age ?? -1) - (a.age ?? -1) ||
                    String(a.case_no).localeCompare(String(b.case_no)))
}

/** Counts per bucket, plus the headline numbers. */
export function summarise(rows, after = FOLLOW_UP_AFTER) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]))
  let unknown = 0
  let followUp = 0
  let oldest = null

  for (const r of rows) {
    if (r.age === null || r.age === undefined) { unknown++; continue }
    if (r.bucket) counts[r.bucket]++
    if (needsFollowUp(r.age, after)) followUp++
    if (oldest === null || r.age > oldest) oldest = r.age
  }
  return { counts, unknown, followUp, oldest, total: rows.length }
}

/**
 * Cases arriving per local day, for the trend.
 *
 * Their dashboard had an "Inbound" row typed in by hand; this one is counted.
 */
export function arrivalsByDay(rows, days = 14, now = new Date()) {
  const today = localDate(now)
  const out = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    out.set(localDate(d), 0)
  }
  for (const r of rows) {
    const d = localDate(r.first_inbound_time)
    if (d && out.has(d)) out.set(d, out.get(d) + 1)
  }
  return [...out.entries()].map(([date, count]) => ({ date, count, today: date === today }))
}
