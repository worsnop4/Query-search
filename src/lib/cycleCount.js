// Cycle count rules that do not need a database or a browser.
//
// The classification itself (match / wrong location / not in query, and what
// Query says about the case state) is done in Postgres by record_scan() - it
// is the record of what was counted, so it must not be something the client
// decides. What lives here is everything around it: reading a scan, bucketing
// a result, and adding it all up.
//
// Kept free of any Supabase import so it can run under plain node - see the
// note at the top of exportFormat.js for why that matters.

/**
 * The five buckets.
 *
 * The workbook this replaces had only True and False. Three of these are new,
 * and `opened_mismatch` is the one the user cares most about: a case that is
 * physically full and complete while Query says it has been opened. In their
 * words, "that the crucial founded" - it needs the case deleted from Query as
 * a shortage and put back as a full case, a profit.
 */
export const RESULTS = {
  clean_match: {
    label: 'True',
    tone: 'ok',
    hint: 'Right place, and Query agrees about the case.',
  },
  opened_mismatch: {
    label: 'Query says opened',
    tone: 'warn',
    hint: 'Found here as a full case, but Query has it as opened.',
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

/** Order shown on screen. Good news first, then the work, then the follow-up. */
export const RESULT_ORDER = [
  'clean_match',
  'opened_mismatch',
  'wrong_location',
  'not_in_query',
  'not_checked',
]

/**
 * What to do about a discrepancy. These are the user's own four, and they map
 * onto the workbook's "DO" column.
 *
 * shortage  - take it off Query, the stock is not what Query thinks
 * profit    - put it back on Query in the state it was actually found
 * both      - the pair used when a case has to be corrected in place, which is
 *             what an opened-in-Query-but-actually-full case needs
 */
export const ACTIONS = [
  { value: 'put_away', label: 'Put away' },
  { value: 'shortage', label: 'Shortage' },
  { value: 'profit', label: 'Profit' },
  { value: 'shortage_profit', label: 'Shortage + Profit' },
]

export const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.value, a.label]))

/**
 * Which bucket a recorded scan belongs to.
 *
 * record_scan() answers the location question and reports Query's case state
 * separately, because they are two different findings. A case can be in the
 * right place and still be wrong.
 */
export function bucketOf(scan) {
  if (scan.result === 'match') {
    return scan.query_opened ? 'opened_mismatch' : 'clean_match'
  }
  return scan.result
}

/**
 * What came off the scanner.
 *
 * A barcode wedge types the text and then sends Enter, so this runs on every
 * scan. Only the outer whitespace goes: 54,728 case numbers contain spaces
 * inside them, and 20,314 contain lowercase, so nothing else may be touched.
 *
 * No minimum length. Unlike the search box, a scan is not someone guessing -
 * 16 real case numbers are 3 characters or shorter, one of them just "-", and
 * refusing to record those would hide a genuine labelling problem.
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
    clean_match: 0,
    opened_mismatch: 0,
    wrong_location: 0,
    not_in_query: 0,
    not_checked: notCheckedCount,
  }
  for (const s of scans) {
    const b = bucketOf(s)
    if (b in counts) counts[b]++
  }
  // What was physically handled. This is the workbook's "CC case".
  counts.scanned =
    counts.clean_match + counts.opened_mismatch + counts.wrong_location + counts.not_in_query
  counts.problems = counts.scanned - counts.clean_match
  return counts
}

/**
 * Share of what was scanned that was completely right, as a percentage.
 *
 * Deliberately the same formula as the Recap sheet of the workbook this
 * replaces - 43 TRUE of 75 counted = 57.3% - so the numbers stay comparable
 * with their history. "Need check later" is NOT in the denominator: those
 * cases were never handled, so they cannot be right or wrong yet. They are
 * reported separately, as a count and a list to go and look at.
 *
 * Returns null when nothing was scanned, because 100% of nothing reads as a
 * perfect score and is not one.
 */
export function accuracy(counts) {
  if (!counts.scanned) return null
  return (100 * counts.clean_match) / counts.scanned
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
    const here = where.length > 1
      ? `Here, and in ${where.length - 1} other location${where.length > 2 ? 's' : ''}`
      : 'Here'
    return scan.query_opened ? `${here} - but Query has it as OPENED` : here
  }
  if (where.length === 0) return 'Query has no location for it'
  if (where.length === 1) return `Query says ${where[0]}`
  return `Query says ${where[0]} and ${where.length - 1} more`
}

/**
 * Rows needing an adjustment, worst first.
 *
 * Everything except a clean match, plus the cases nobody scanned. No reason or
 * action per row: the user asked for one decision covering the whole location,
 * so those live on the session.
 */
export function reportRows(scans, notChecked) {
  const rows = []
  for (const s of scans) {
    const bucket = bucketOf(s)
    if (bucket === 'clean_match') continue
    rows.push({
      case_no: s.case_no,
      bucket,
      system_locations: s.system_locations ?? [],
      query_opened: !!s.query_opened,
    })
  }
  for (const case_no of notChecked) {
    rows.push({ case_no, bucket: 'not_checked', system_locations: [], query_opened: false })
  }
  const rank = { not_in_query: 0, opened_mismatch: 1, wrong_location: 2, not_checked: 3 }
  return rows.sort(
    (a, b) => rank[a.bucket] - rank[b.bucket] || a.case_no.localeCompare(b.case_no)
  )
}

/**
 * How the warehouse groups its areas, straight out of REPORT ACCURACY.xlsx.
 *
 * `calc_area()` in setup.sql already produces these buckets - it was written
 * for the Breakdown and happens to be exactly the classification their report
 * uses. Verified: every location in their HR, TRANSIT, XINHAI and spot-check
 * sheets lands in the group their own report puts it in.
 *
 * XINHAI is XIN1 and XIN2 together, which is how their report names it. XIN1
 * has had zero rows in every export seen so far but is mapped anyway.
 *
 * `catchAll` takes every remaining OW area - Yanfeng, Lingyun, Baosteel and
 * the rest - so a new supplier area appears under OW SAIC on its own rather
 * than vanishing from the dashboard.
 */
export const AREA_GROUPS = [
  { label: 'HR', areas: ['HR'] },
  { label: 'Transit', areas: ['Transit'] },
  { label: 'XINHAI', areas: ['XIN1', 'XIN2'] },
  { label: 'DLOC', areas: ['DLOC'] },
  { label: 'OF', areas: ['OF'] },
  { label: 'OW SAIC', areas: [], catchAll: true },
]

const NAMED_AREAS = new Set(AREA_GROUPS.flatMap((g) => g.areas))

/**
 * Fold the per-area rows into the report's groups, and pair each with how big
 * that area actually is.
 *
 * `sizes` comes from the `area_sizes` view. Showing the size matters: "42
 * locations counted" means nothing until you know whether the area has 50 or
 * 4,400 of them, and an area with nothing counted has to stay visible or the
 * plan has no gap to point at.
 */
export function groupByArea(counted = [], sizes = []) {
  const blank = () => ({
    sessions: 0, locations: 0, scanned: 0, clean_match: 0,
    opened_mismatch: 0, wrong_location: 0, not_in_query: 0, not_checked: 0,
    totalLocations: 0, totalCases: 0,
  })

  const out = new Map(AREA_GROUPS.map((g) => [g.label, { label: g.label, ...blank() }]))
  const labelOf = (area) => {
    const named = AREA_GROUPS.find((g) => g.areas.includes(area))
    if (named) return named.label
    if (!area || area === 'Unknown') return null
    return AREA_GROUPS.find((g) => g.catchAll)?.label ?? null
  }

  for (const r of counted) {
    const label = labelOf(r.area)
    if (!label) continue
    const t = out.get(label)
    for (const k of ['sessions', 'locations', 'scanned', 'clean_match',
                     'opened_mismatch', 'wrong_location', 'not_in_query', 'not_checked']) {
      t[k] += Number(r[k]) || 0
    }
  }

  for (const r of sizes) {
    const label = labelOf(r.area)
    if (!label) continue
    const t = out.get(label)
    t.totalLocations += Number(r.locations) || 0
    t.totalCases += Number(r.cases) || 0
  }

  // Order is the report's, not by size: people read it in a fixed order.
  return [...out.values()].filter((t) => t.totalCases > 0 || t.scanned > 0)
}

/** Which areas the app knows by name, for anything that needs the list. */
export function isNamedArea(area) {
  return NAMED_AREAS.has(area)
}

/**
 * Collapse the per-admin daily rows into one row per day.
 *
 * `cycle_count_daily` is grouped by day AND admin so the table can show who
 * did what. The chart wants the warehouse's total for the day regardless of
 * who counted it, so the admins are added together here rather than in a
 * second SQL view - it is a handful of rows and this stays testable.
 *
 * Newest first, matching the order the rows arrive in.
 */
export function totalsByDay(days) {
  const byDate = new Map()
  const add = (t, d, k) => { t[k] += Number(d[k]) || 0 }

  for (const d of days) {
    const key = d.count_date
    if (!byDate.has(key)) {
      byDate.set(key, {
        count_date: key,
        clean_match: 0,
        opened_mismatch: 0,
        wrong_location: 0,
        not_in_query: 0,
        not_checked: 0,
        scanned: 0,
        locations: 0,
        _admins: new Set(),
      })
    }
    const t = byDate.get(key)
    for (const k of ['clean_match', 'opened_mismatch', 'wrong_location',
                     'not_in_query', 'not_checked', 'scanned', 'locations']) {
      add(t, d, k)
    }
    if (d.started_by) t._admins.add(d.started_by)
  }

  return [...byDate.values()]
    .map(({ _admins, ...t }) => ({ ...t, admins: _admins.size }))
    .sort((a, b) => String(b.count_date).localeCompare(String(a.count_date)))
}

/**
 * The action a count most likely needs, offered as the default for the whole
 * session. A suggestion only - the admin chooses.
 *
 * Driven by the worst thing found, in the order below: a case Query has as
 * opened when it was actually full has to come off and go back on, which is
 * the pair; a case Query does not know about is a profit; a case in the wrong
 * place just gets put away.
 */
export function suggestedAction(counts) {
  if (!counts) return ''
  if (counts.opened_mismatch > 0) return 'shortage_profit'
  if (counts.not_in_query > 0) return 'profit'
  if (counts.wrong_location > 0) return 'put_away'
  return ''
}
