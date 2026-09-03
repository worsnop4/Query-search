// The daily Breakdown Query workbook.
//
// Replaces a hand-built Excel file that takes minutes to open on an old
// laptop. Measured on their "Breakdown Query 02092026.xlsb":
//
//   their Breakdown sheet   195,704 rows for 11,419 parts - every part
//                           repeated about 17 times, because it is one row per
//                           INVENTORY ROW rather than one row per part
//   their Query sheet       another 195,704 rows of raw export
//
// The actual answer is one row per part, ~11,800 rows. Postgres already
// computes the whole pivot in the `breakdown` view, verified against their own
// file to the piece (MZ000140-PYX: DLOC 36, HR 0, OF 0, Transit 72, total 108).
//
// THREE FIXES to their template, agreed with the user:
//
//   1. Yanfeng was displayed but never counted. Their OW total is
//      =SUM(J8:Q8), which stops at CRRC - Yanfeng is column R, outside the
//      range. That is 852,650 pieces missing from the totals.
//   2. Baosteel had no column at all, so its stock was invisible.
//   3. The "VDC5" column header did not match the data value "VDC", and
//      SUMIFS matches on that text, so it always read 0. The label stays
//      "VDC5" - it is what they call it - but it now reads the right area.
//
// Fixing 2 makes the sheet one column wider than their old one: Baosteel is
// inserted after Yanfeng, so the columns from the OW total rightwards all
// shift one to the right.

/** Area name in the data -> column heading, in column order. */
export const LOC_COLUMNS = [
  { area: 'DLOC', label: 'DLOC' },
  { area: 'HR', label: 'HR' },
  { area: 'OF', label: 'OF' },
  { area: 'Transit', label: 'Transit' },
]

// Their nine, plus Baosteel. "VDC5" is their label for the area called "VDC".
export const OW_COLUMNS = [
  { area: 'Luzhou', label: 'Luzhou' },
  { area: 'VDC', label: 'VDC5' },
  { area: 'Wenzhou', label: 'Wenzhou' },
  { area: 'New Lingyun', label: 'New Lingyun' },
  { area: 'Nexteer', label: 'Nexteer' },
  { area: 'Old Lingyun', label: 'Old Lingyun' },
  { area: 'YOBU', label: 'YOBU' },
  { area: 'CRRC', label: 'CRRC' },
  { area: 'Yanfeng', label: 'Yanfeng' },
  { area: 'Baosteel', label: 'Baosteel' },
]

export const NONSAIC_COLUMNS = [
  { area: 'XIN1', label: 'XIN1' },
  { area: 'XIN2', label: 'XIN2' },
]

/** The view's column for each area, so the two can never drift apart. */
const FIELD = {
  DLOC: 'loc_dloc',
  HR: 'loc_hr',
  OF: 'loc_of',
  Transit: 'loc_transit',
  Luzhou: 'ow_luzhou',
  VDC: 'ow_vdc5',
  Wenzhou: 'ow_wenzhou',
  'New Lingyun': 'ow_new_lingyun',
  Nexteer: 'ow_nexteer',
  'Old Lingyun': 'ow_old_lingyun',
  YOBU: 'ow_yobu',
  CRRC: 'ow_crrc',
  Yanfeng: 'ow_yanfeng',
  Baosteel: 'ow_baosteel',
  XIN1: 'nonsaic_xin1',
  XIN2: 'nonsaic_xin2',
}

export const DEFAULTS = {
  locMin: 200,
  owMin: 500,
  jph: 14,
  workingHours: 8,
  note: 'Not yet compare to production need',
}

/**
 * Minimum stock for the Stock sheet, from their own formulas:
 *
 *   Qty           = (JPH x Working Hour) + 1     -> 14 x 8 + 1 = 113
 *   Minimal Stock = Qty x 2                      -> 226
 *
 * JPH is the only real input; everything else follows. Changing it is the one
 * knob they asked about.
 */
export function minimalStock({ jph, workingHours }) {
  return dayQty({ jph, workingHours }) * 2
}

export function dayQty({ jph, workingHours }) {
  return (Number(jph) || 0) * (Number(workingHours) || 0) + 1
}

const num = (v) => Number(v) || 0

/** Every quantity column for one part, in sheet order. */
export function partCells(row) {
  const q = (c) => num(row[FIELD[c.area]])
  return {
    loc: LOC_COLUMNS.map(q),
    ow: OW_COLUMNS.map(q),
    nonsaic: NONSAIC_COLUMNS.map(q),
  }
}

/**
 * The totals, computed here as well as by the spreadsheet formulas.
 *
 * The file carries live formulas so a threshold can still be changed in Excel,
 * but the screen has to show the same numbers without evaluating them - and
 * having one definition here means the preview and the file cannot disagree.
 */
export function totalsFor(row, { locMin, owMin } = DEFAULTS) {
  const c = partCells(row)
  const loc = c.loc.reduce((a, b) => a + b, 0)
  const ow = c.ow.reduce((a, b) => a + b, 0)
  const nonsaic = c.nonsaic.reduce((a, b) => a + b, 0)
  return {
    loc,
    ow,
    nonsaic,
    grand: loc + ow + nonsaic,
    locStatus: loc < locMin ? 'NOK' : 'OK',
    locGap: loc - locMin,
    // Their rule, from =IF((S8+G8)<$C$3,...) and =G8+S8-$C$3: the SAIC check
    // is LOC plus OW against the OW minimum. NON-SAIC is a different supplier
    // group and deliberately does not count towards it.
    owStatus: loc + ow < owMin ? 'NOK' : 'OK',
    owGap: loc + ow - owMin,
  }
}

// ---------------------------------------------------------------------------
// Sheet layout
// ---------------------------------------------------------------------------

const A = (n) => {
  // 0 -> A, 25 -> Z, 26 -> AA
  let s = ''
  for (let x = n; x >= 0; x = Math.floor(x / 26) - 1) s = String.fromCharCode(65 + (x % 26)) + s
  return s
}

/** Where each block sits, derived rather than hard-coded so adding a column
 *  cannot silently break the formulas. */
export function layout() {
  const locFirst = 2 // C
  const locLast = locFirst + LOC_COLUMNS.length - 1
  const locTotal = locLast + 1
  const locStatus = locTotal + 1
  const locGap = locStatus + 1
  const owFirst = locGap + 1
  const owLast = owFirst + OW_COLUMNS.length - 1
  const owTotal = owLast + 1
  const owStatus = owTotal + 1
  const owGap = owStatus + 1
  const nsFirst = owGap + 1
  const nsLast = nsFirst + NONSAIC_COLUMNS.length - 1
  const nsTotal = nsLast + 1
  const grand = nsTotal + 1
  return {
    partNumber: 0, masterDloc: 1,
    locFirst, locLast, locTotal, locStatus, locGap,
    owFirst, owLast, owTotal, owStatus, owGap,
    nsFirst, nsLast, nsTotal, grand,
    width: grand + 1,
    col: A,
  }
}

export const HEADER_ROWS = 7 // data starts on row 8, as in their template

/**
 * The Breakdown sheet as an array of arrays: the header block, then one row
 * per part. Formulas are added afterwards by the writer.
 */
export function breakdownSheet(rows, opts = DEFAULTS) {
  const L = layout()
  const blank = () => new Array(L.width).fill('')

  const r1 = blank(); r1[0] = 'Breakdown Query'
  const r2 = blank(); r2[0] = 'Stock Level'; r2[1] = 'LOC'; r2[2] = opts.locMin
  const r3 = blank(); r3[1] = 'OW SAIC'; r3[2] = opts.owMin
  const r4 = blank(); r4[0] = 'Note'; r4[1] = opts.note ?? DEFAULTS.note

  const r5 = blank()
  r5[L.partNumber] = 'Part Number'
  r5[L.locFirst] = 'LOC'
  r5[L.locTotal] = 'TOTAL'
  r5[L.locStatus] = 'Status'
  r5[L.locGap] = 'GAP'
  r5[L.owTotal] = 'TOTAL'
  r5[L.owStatus] = 'Status'
  r5[L.owGap] = 'Gap'
  r5[L.nsFirst] = 'NON SAIC'
  r5[L.nsTotal] = 'TOTAL'
  r5[L.grand] = 'Grand Total'

  const r6 = blank()
  r6[L.masterDloc] = 'DLOC'
  LOC_COLUMNS.forEach((c, i) => { r6[L.locFirst + i] = c.label })
  OW_COLUMNS.forEach((c, i) => { r6[L.owFirst + i] = c.label })
  NONSAIC_COLUMNS.forEach((c, i) => { r6[L.nsFirst + i] = c.label })

  const r7 = blank()

  const body = rows.map((row) => {
    const line = blank()
    const c = partCells(row)
    line[L.partNumber] = row.part_number
    // Their B column is an XLOOKUP into the master data; "-" when unknown,
    // which is what XLOOKUP's fallback produced.
    line[L.masterDloc] = row.master_dloc ?? '-'
    c.loc.forEach((v, i) => { line[L.locFirst + i] = v })
    c.ow.forEach((v, i) => { line[L.owFirst + i] = v })
    c.nonsaic.forEach((v, i) => { line[L.nsFirst + i] = v })
    // The totals, status and gap cells are left empty here and filled with
    // real formulas by the writer, so the thresholds stay live in Excel.
    return line
  })

  return [r1, r2, r3, r4, r5, r6, r7, ...body]
}

/** The formulas for one data row, keyed by column index. */
export function rowFormulas(excelRow) {
  const L = layout()
  const c = L.col
  const g = `${c(L.locTotal)}${excelRow}`
  const s = `${c(L.owTotal)}${excelRow}`
  const x = `${c(L.nsTotal)}${excelRow}`
  return {
    [L.locTotal]: `SUM(${c(L.locFirst)}${excelRow}:${c(L.locLast)}${excelRow})`,
    [L.locStatus]: `IF(${g}<$C$2,"NOK","OK")`,
    [L.locGap]: `${g}-$C$2`,
    [L.owTotal]: `SUM(${c(L.owFirst)}${excelRow}:${c(L.owLast)}${excelRow})`,
    [L.owStatus]: `IF((${s}+${g})<$C$3,"NOK","OK")`,
    [L.owGap]: `${g}+${s}-$C$3`,
    [L.nsTotal]: `SUM(${c(L.nsFirst)}${excelRow}:${c(L.nsLast)}${excelRow})`,
    [L.grand]: `SUM(${g},${s},${x})`,
  }
}

// ---------------------------------------------------------------------------
// The Stock sheet
// ---------------------------------------------------------------------------

export const STOCK_HEADERS = [
  'Part Number',
  'Grand Total',
  'Status',
  'MRP Stock',
  'Feedback from SGMW',
]

/**
 * Parts below the minimum, which is what their Stock sheet lists.
 *
 * Verified against their file: 10189234 has LOC 16 and NON-SAIC 8, and their
 * Stock sheet shows 24 - the GRAND total, not the LOC total and not the
 * NON-SAIC total. (Their template's VLOOKUP asks for column 24, which is the
 * NON-SAIC column; the file they actually use produces the grand total, so
 * that is what is reproduced here.)
 *
 * MRP Stock and Feedback from SGMW are left empty - they are filled in by hand
 * afterwards.
 */
export function stockRows(rows, opts = DEFAULTS) {
  const min = minimalStock(opts)
  return rows
    .map((row) => ({ row, t: totalsFor(row, opts) }))
    .filter(({ t }) => t.grand < min)
    .sort((a, b) => a.t.grand - b.t.grand ||
                    String(a.row.part_number).localeCompare(String(b.row.part_number)))
    .map(({ row, t }) => [row.part_number, t.grand, '', '', ''])
}

export function stockSheet(rows, opts = DEFAULTS) {
  const blank = () => ['', '', '', '', '']
  const r1 = ['Minimal Stock', minimalStock(opts), '', 'JPH', Number(opts.jph) || 0]
  const r2 = ['', '', '', 'Working Hour', Number(opts.workingHours) || 0]
  const r3 = ['', '', '', 'Qty', dayQty(opts)]
  const r4 = blank()
  const r5 = [...STOCK_HEADERS]
  return [r1, r2, r3, r4, r5, ...stockRows(rows, opts)]
}

export const STOCK_HEADER_ROWS = 5 // data starts on row 6, as in their template

/** yyyy-mm-dd in the warehouse's own timezone. */
export function localDate(now = new Date(), timeZone = 'Asia/Jakarta') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Their own naming: "Breakdown Query 02092026". */
export function breakdownFileName(now = new Date(), ext = 'xlsx') {
  const d = localDate(now)
  const [y, m, day] = d.split('-')
  return `Breakdown Query ${day}${m}${y}.${ext}`
}

// ---------------------------------------------------------------------------
// Writing the workbook
// ---------------------------------------------------------------------------

/**
 * Build the .xlsx.
 *
 * SheetJS is imported DYNAMICALLY - it is ~490 kB and already sits in the
 * admin upload chunk, so it should only arrive when someone actually asks for
 * this file.
 *
 * The totals, Status and GAP cells are written as real FORMULAS rather than
 * numbers, so the two thresholds and the JPH block stay live: change C2, C3 or
 * the JPH cell in Excel and every row recalculates, exactly as their template
 * does today. Which parts appear on the Stock sheet still depends on the
 * threshold used at download time - that list cannot recompute itself.
 */
export async function writeBreakdownXlsx(rows, opts = DEFAULTS) {
  const XLSX = await import('xlsx')
  const L = layout()

  const ws = XLSX.utils.aoa_to_sheet(breakdownSheet(rows, opts))
  for (let i = 0; i < rows.length; i++) {
    const excelRow = HEADER_ROWS + 1 + i
    const f = rowFormulas(excelRow)
    for (const [colIdx, formula] of Object.entries(f)) {
      const addr = XLSX.utils.encode_cell({ r: excelRow - 1, c: Number(colIdx) })
      // t:'n' with no v: Excel computes it on open. A cached value would only
      // go stale the moment a threshold is edited.
      ws[addr] = { t: 'n', f: formula }
    }
  }

  const stock = XLSX.utils.aoa_to_sheet(stockSheet(rows, opts))
  // The same three formulas their template uses, so JPH stays the only input.
  stock['B1'] = { t: 'n', f: 'E3*2' }
  stock['E3'] = { t: 'n', f: '(E1*E2)+1' }
  const stockCount = stockRows(rows, opts).length
  for (let i = 0; i < stockCount; i++) {
    const r = STOCK_HEADER_ROWS + 1 + i
    stock[`C${r}`] = { t: 's', f: `IF(B${r}<$B$1,"NOK","OK")` }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Breakdown')
  XLSX.utils.book_append_sheet(wb, stock, 'Stock')

  // `type: 'array'` hands back a raw ArrayBuffer despite the name.
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }))
}
