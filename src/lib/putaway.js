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
// ONLY WRONG-LOCATION CASES GO IN THIS FILE. A put away moves a case to where
// it really is. The other findings need different WMS actions - a case Query
// has as opened needs a shortage and a profit, and a case Query does not know
// about needs a profit - so mixing them into one put-away file would tell the
// WMS to do the wrong thing.

import { bucketOf } from './cycleCount.js'

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
    .filter((s) => bucketOf(s) === 'wrong_location')
    .map((s) => [s.case_no, session.location, '', '', ''])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
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
