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
