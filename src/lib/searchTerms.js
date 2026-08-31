// Working out what someone meant by what they typed in the search box.
//
// Kept out of SearchPage.jsx so it can be tested in plain Node - the rules
// here decide whether a query is a fast indexed lookup or a substring scan,
// and getting them wrong is silent rather than loud.

// The operation team remembers the last four digits, not the whole 8-digit
// number, so one short entry searches for a part number CONTAINING it.
//
// Contains, not ends-with: 683 parts end in letters, so 10189242-PHD does not
// end with "9242" even though that is the part someone means. Ends-with
// returns nothing for it and looks broken.
export const PARTIAL_MIN = 4

// At this length or beyond, treat the entry as a whole part number and match
// it exactly. 17,904 of 18,630 parts are 8 digits.
export const FULL_LENGTH = 8

/**
 * Split typed text into part numbers on commas, spaces, tabs, semicolons or
 * newlines - so a column copied straight out of Excel works. Every part number
 * in both source files is uppercase, so upper-casing is safe and makes the
 * search forgiving without breaking the exact match.
 */
export function parseParts(text) {
  const seen = new Set()
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const p = raw.trim().toUpperCase()
    if (p) seen.add(p)
  }
  return [...seen]
}

/**
 * Part numbers are alphanumeric plus - and / (11559571-PMC, SM1367, 1261/1262).
 * Stripping anything else keeps % and _ - both ILIKE wildcards - out of the
 * pattern, so a stray character cannot turn into a match-everything search.
 */
export function sanitizeTerm(s) {
  return String(s ?? '').replace(/[^A-Z0-9\-/]/gi, '').toUpperCase()
}

/**
 * What the typed text means:
 *
 *   empty     nothing usable
 *   tooshort  a single entry below PARTIAL_MIN - too vague to be useful
 *   partial   a single short entry: match part numbers CONTAINING it
 *   exact     a pasted list, or a full-length part number: match exactly
 *
 * A list stays exact even if its entries are short. Someone pasting a column
 * from Excel wants those part numbers, not everything resembling them - and a
 * substring scan per entry would be far slower.
 */
export function readCriteria(text) {
  const parts = parseParts(text)
  if (parts.length === 0) return { mode: 'empty', parts: [] }

  if (parts.length === 1 && parts[0].length < FULL_LENGTH) {
    const term = sanitizeTerm(parts[0])
    if (term.length < PARTIAL_MIN) return { mode: 'tooshort', parts, term }
    return { mode: 'partial', term, parts }
  }

  return { mode: 'exact', parts }
}

// ---------------------------------------------------------------------------
// Case numbers
//
// These behave nothing like part numbers and the rules above do not transfer.
// Measured on 207,633 live rows / 147,090 distinct case numbers, Aug 2026:
//
//   median length 42 characters, longest 100. Real examples:
//     P03741331
//     PALET OF 2026 1320&-
//     PALET OF 2026 0213&0010007029_10003993_SMC2C4_2200.0_B16608901_740A_
//
// Nobody types one of those in full, so a case search is ALWAYS a contains
// match. There is no "exact" mode the way there is for part numbers.
// ---------------------------------------------------------------------------

// How much a typed fragment actually narrows things, measured over 300 real
// case numbers by taking their last n characters:
//
//   n    median rows matched   worst
//   4            291          11,903
//   6             50           2,382
//   8             29             624
//  12              7             196
//
// PARTIAL_MIN of 4 is useless here - case numbers are long and highly
// repetitive ("PALET OF 2026 ..."), so a 4-character fragment browses rather
// than searches. 6 is where the median result fits on one page, and it stays
// above the 3 characters a trigram index needs.
export const CASE_MIN = 6

/**
 * Make a typed fragment safe to drop inside an ILIKE pattern.
 *
 * Case numbers genuinely contain `_` (3,213 of them) and `\` (555). Both are
 * special to ILIKE, so they are ESCAPED rather than stripped the way
 * sanitizeTerm() strips them from part numbers - stripping would make those
 * cases permanently unfindable.
 *
 * Verified through PostgREST against live data: `%SMC_C4%` unescaped matches
 * 1,349 rows, because `_` stands for any single character. Escaped it matches
 * 0, which is the correct answer - no case number contains that literal text.
 *
 * `%` never occurs in a real case number, so it is escaped too rather than
 * special-cased. A typed `%` then means a literal `%` and finds nothing,
 * instead of matching all 207k rows.
 */
export function escapeLike(s) {
  return String(s ?? '').replace(/[\\%_]/g, (m) => '\\' + m)
}

/**
 * What the case number box means.
 *
 * Only the OUTER whitespace is trimmed. 54,728 case numbers contain spaces
 * inside them, so the input cannot be split into a list the way part numbers
 * can - there is no separator that is safe. Commas are out too: 4 case numbers
 * contain one. Hence a single-line box holding a single fragment.
 *
 * Not upper-cased either: 20,314 case numbers contain lowercase letters, and
 * ILIKE is case-insensitive regardless.
 */
export function readCaseTerm(text) {
  const term = String(text ?? '').trim()
  if (term === '') return { mode: 'empty', term: '' }
  if (term.length < CASE_MIN) return { mode: 'tooshort', term }
  return { mode: 'partial', term, pattern: `%${escapeLike(term)}%` }
}

/**
 * The whole search box: part numbers, a case number, or both together.
 *
 * Both together is an AND - they filter the same rows, so "part 23588931 in a
 * case containing 1320" is the useful reading. Either box on its own works.
 */
export function readSearch(partText, caseText) {
  const part = readCriteria(partText)
  const caseNo = readCaseTerm(caseText)

  let error = null
  if (part.mode === 'empty' && caseNo.mode === 'empty') {
    error = 'Enter a part number, or a case number.'
  } else if (part.mode === 'tooshort') {
    error =
      `"${part.parts[0]}" is too short. Type at least ${PARTIAL_MIN} ` +
      'characters of the part number - the last 4 digits are enough.'
  } else if (caseNo.mode === 'tooshort') {
    error =
      `"${caseNo.term}" is too short for a case number. Type at least ` +
      `${CASE_MIN} characters - they are long, so a short piece matches ` +
      'thousands of rows.'
  }

  return { part, caseNo, error }
}

/** Plain description of what was searched, for the "no rows found" message. */
export function describeSearch({ part, caseNo }, fmt = (n) => String(n)) {
  const bits = []
  if (part.mode === 'partial') bits.push(`part numbers containing ${part.term}`)
  else if (part.mode === 'exact') {
    bits.push(
      part.parts.length === 1
        ? part.parts[0]
        : `these ${fmt(part.parts.length)} part numbers`
    )
  }
  if (caseNo.mode === 'partial') bits.push(`case numbers containing "${caseNo.term}"`)
  return bits.join(' and ')
}
