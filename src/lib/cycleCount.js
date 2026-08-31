// Cycle count rules that do not need a database or a browser.
//
// The classification itself (match / wrong location / not in query) is done in
// Postgres by record_scan() - it is the record of what was counted, so it must
// not be something the client decides. What lives here is everything around
// it: reading a scan, naming a result, and adding the buckets up.
//
// Kept free of any Supabase import so it can run under plain node - see the
// note at the top of exportFormat.js for why that matters.

/**
 * The four outcomes. The first three come back from record_scan(); the fourth
 * is everything that never happened, so it can only be worked out at the end
 * against the frozen expected list.
 */
export const RESULTS = {
  match: {
    label: 'Match',
    tone: 'ok',
    hint: 'Query agrees this case is here.',
  },
  wrong_location: {
    label: 'Wrong location',
    tone: 'warn',
    hint: 'Query has this case somewhere else.',
  },
  not_in_query: {
    label: 'Not in Query',
    tone: 'bad',
    hint: 'Query has never heard of this case number.',
  },
  not_checked: {
    label: 'Need check later',
    tone: 'muted',
    hint: 'Query says it is here, but it was never scanned.',
  },
}

/** Order the buckets are shown in - worst news last is unhelpful on a phone. */
export const RESULT_ORDER = ['match', 'wrong_location', 'not_in_query', 'not_checked']

/**
 * What came off the scanner.
 *
 * A barcode wedge types the text and then sends Enter, so this runs on every
 * scan. Only the outer whitespace goes: 54,728 case numbers contain spaces
 * inside them, and 20,314 contain lowercase, so nothing else may be touched.
 *
 * No minimum length. Unlike the search box, a scan is not someone guessing -
 * 16 real case numbers are 3 characters or shorter, one of them just "-", and
 * refusing to record those would hide a genuine labelling problem rather than
 * prevent a bad search.
 */
export function readScan(text) {
  const case_no = String(text ?? '').trim()
  if (case_no === '') return { ok: false, case_no: '', error: 'Nothing was scanned.' }
  return { ok: true, case_no }
}

/**
 * Add the buckets up.
 *
 * `notChecked` is passed in rather than derived: it is expected-minus-scanned,
 * and only the database holds the frozen expected list.
 */
export function summarise(scans, notCheckedCount = 0) {
  const counts = {
    match: 0,
    wrong_location: 0,
    not_in_query: 0,
    not_checked: notCheckedCount,
  }
  for (const s of scans) {
    if (s.result in counts) counts[s.result]++
  }
  counts.scanned = counts.match + counts.wrong_location + counts.not_in_query
  counts.problems = counts.wrong_location + counts.not_in_query + counts.not_checked
  counts.total = counts.match + counts.problems
  return counts
}

/**
 * Share of the location that was exactly right, as a percentage.
 *
 * Every kind of discrepancy counts against it - a case in the wrong place, a
 * case that should not exist, and a case nobody could find are all failures of
 * the same thing. Returns null when there was nothing to count, because 100%
 * of nothing reads as a perfect score and is not one.
 */
export function accuracy(counts) {
  if (!counts.total) return null
  return (100 * counts.match) / counts.total
}

/**
 * One line describing a scan, for the running list.
 *
 * A case can legitimately be in several locations at once - 381 of 108,778
 * full cases are - so the system location is a list, not a value.
 */
export function describeScan(scan) {
  const where = scan.system_locations ?? []
  if (scan.result === 'not_in_query') return 'Not in Query'
  if (scan.result === 'match') {
    return where.length > 1
      ? `Here, and in ${where.length - 1} other location${where.length > 2 ? 's' : ''}`
      : 'Here'
  }
  if (where.length === 0) return 'Query has no location for it'
  if (where.length === 1) return `Query says ${where[0]}`
  return `Query says ${where[0]} and ${where.length - 1} more`
}

/** Rows for the finished report, worst first so the work to do is at the top. */
export function reportRows(scans, notChecked) {
  const rows = []
  for (const s of scans) {
    if (s.result === 'match') continue
    rows.push({ case_no: s.case_no, result: s.result, system_locations: s.system_locations ?? [] })
  }
  for (const case_no of notChecked) {
    rows.push({ case_no, result: 'not_checked', system_locations: [] })
  }
  const rank = { not_in_query: 0, wrong_location: 1, not_checked: 2 }
  return rows.sort(
    (a, b) => rank[a.result] - rank[b.result] || a.case_no.localeCompare(b.case_no)
  )
}
