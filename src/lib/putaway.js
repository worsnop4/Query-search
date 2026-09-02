// The WMS "Put away" adjustment file.
//
// Shaped to match `D:\Daily\Cycle Count\Put away template.xls` exactly, because
// the WMS reads that layout and nothing else:
//
//   sheet name   Sheet3
//   row 1        A1 = "Case List", B1:E1 empty
//   row 2        Old Case No | Location Code | New Case No | Part No | Quantity
//   row 3+       the data
//
// The user's instruction was precise: "you just need to put case to row a and
// actual location at row b. thats it." So only the first two columns are
// filled; New Case No, Part No and Quantity stay empty, exactly as in the
// blank template.
//
// ONLY WRONG-LOCATION CASES THAT QUERY STILL HAS AS FULL GO IN THIS FILE.
//
// A put away moves a case to where it really is, and the WMS will only move a
// whole case. If Query has the case as opened its quantity is 0, and the
// upload is rejected: "case qty 0, case has been opened, cannot put away
// anymore" - the real error this cost an afternoon.
//
// So an opened case in the wrong place cannot be put away at all. It needs a
// shortage and a profit instead, which is a different WMS action and a
// different file. Those cases are reported by cannotPutAway() rather than
// silently dropped - leaving them out with no explanation would be worse than
// the rejected upload, because nobody would know they still need doing.
//
// The other findings are excluded for the same reason: a case Query does not
// know about needs a profit, not a put away.

import { bucketOf } from './cycleCount.js'

/** Query still has it as a whole case, so the WMS can move it. */
function canPutAway(s) {
  return bucketOf(s) === 'wrong_location' && !s.query_opened
}

export const PUTAWAY_SHEET = 'Sheet3'
export const PUTAWAY_TITLE = 'Case List'
export const PUTAWAY_HEADERS = [
  'Old Case No',
  'Location Code',
  'New Case No',
  'Part No',
  'Quantity',
]

/**
 * One row per case that was found somewhere other than where Query has it.
 *
 * `Location Code` is the ACTUAL location - the one that was counted - because
 * that is where the case really is and where the WMS must be told to put it.
 */
export function putawayRows(session, scans) {
  return scans
    .filter(canPutAway)
    .map((s) => [s.case_no, session.location, '', '', ''])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
}

/**
 * Cases in the wrong place that the WMS will NOT accept a put away for,
 * because Query has them opened and an opened case has quantity 0.
 *
 * They still need fixing - as a shortage and a profit - so they are handed
 * back to be listed rather than quietly left out of the file.
 */
export function cannotPutAway(scans) {
  return scans
    .filter((s) => bucketOf(s) === 'wrong_location' && s.query_opened)
    .map((s) => s.case_no)
    .sort((a, b) => String(a).localeCompare(String(b)))
}

/** The whole sheet, as an array of arrays, title row and headers included. */
export function putawaySheet(session, scans) {
  return [
    [PUTAWAY_TITLE, '', '', '', ''],
    [...PUTAWAY_HEADERS],
    ...putawayRows(session, scans),
  ]
}

function slug(s) {
  return String(s ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function putawayFileName(session, dateStr) {
  return `putaway-${slug(session.location)}-${dateStr}.xls`
}

/**
 * Write the sheet as a real Excel 97-2003 .xls, the format of their template.
 *
 * SheetJS is imported DYNAMICALLY. It is ~400 kB, it already sits in the admin
 * upload chunk, and the cycle count page is opened on a phone in the
 * warehouse - so it must not be part of that page's download. This way it
 * arrives only when someone actually asks for the file.
 */
export async function writePutawayXls(aoa) {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, PUTAWAY_SHEET)
  // biff8 is Excel 97-2004 .xls - the template's own format (FileFormat 56).
  //
  // `type: 'array'` returns a raw ArrayBuffer, NOT a typed array, despite the
  // name. Wrapping it here means callers get something they can slice, check
  // and hand to a Blob without thinking about it.
  return new Uint8Array(XLSX.write(wb, { bookType: 'biff8', type: 'array' }))
}
