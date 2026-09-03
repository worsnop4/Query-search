// The Breakdown workbook: layout, totals, thresholds and the Stock list.
//
// The numbers here go into a stock report that people order parts from, and a
// wrong column or a mis-summed range is silent - their current spreadsheet has
// been leaving 852,650 pieces of Yanfeng out of every total because one SUM
// stops a column short. That is the class of bug this file exists to catch.
//
//   node scripts/test-breakdown.mjs
import * as XLSX from 'xlsx'
import {
  DEFAULTS,
  LOC_COLUMNS,
  OW_COLUMNS,
  NONSAIC_COLUMNS,
  layout,
  HEADER_ROWS,
  STOCK_HEADER_ROWS,
  STOCK_HEADERS,
  minimalStock,
  dayQty,
  totalsFor,
  breakdownSheet,
  rowFormulas,
  stockRows,
  stockSheet,
  breakdownFileName,
  localDate,
  writeBreakdownXlsx,
} from '../src/lib/breakdown.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

// A part with stock in all three groups, so nothing can hide.
const part = {
  part_number: '24533127',
  master_dloc: 'LSD-LOT-0-B',
  loc_dloc: 5200, loc_hr: 2616, loc_of: 4800, loc_transit: 1032,
  ow_luzhou: 0, ow_vdc5: 77, ow_wenzhou: 0, ow_new_lingyun: 0, ow_nexteer: 0,
  ow_old_lingyun: 0, ow_yobu: 0, ow_crrc: 0, ow_yanfeng: 400, ow_baosteel: 13000,
  nonsaic_xin1: 0, nonsaic_xin2: 1400,
}

console.log('--- the three fixes ---')

const t = totalsFor(part)
check('LOC total', t.loc === 5200 + 2616 + 4800 + 1032, String(t.loc))
// Their =SUM(J8:Q8) stops at CRRC and misses Yanfeng entirely.
check('Yanfeng is counted', t.ow === 77 + 400 + 13000, String(t.ow))
check('Baosteel is counted', OW_COLUMNS.some((c) => c.area === 'Baosteel'), 'has a column')
// Their header said VDC5 while the data says VDC, so SUMIFS never matched.
const vdc = OW_COLUMNS.find((c) => c.label === 'VDC5')
check('VDC5 reads the area called VDC', vdc.area === 'VDC', vdc.area)
check('grand total is every group', t.grand === t.loc + t.ow + t.nonsaic, String(t.grand))

console.log('\n--- status and gap, their formulas ---')
check('LOC gap is total minus 200', t.locGap === t.loc - 200, String(t.locGap))
check('LOC status OK above the minimum', t.locStatus === 'OK', t.locStatus)
// =IF((S8+G8)<$C$3,...) - LOC plus OW, NOT the grand total. NON-SAIC is a
// different supplier group and does not count towards the SAIC minimum.
check('SAIC gap is LOC + OW - 500', t.owGap === t.loc + t.ow - 500, String(t.owGap))
check('and excludes NON-SAIC', t.owGap !== t.grand - 500, 'excluded')

const poor = totalsFor(
  { part_number: 'X', loc_dloc: 108, nonsaic_xin2: 0 },
  DEFAULTS
)
check('a part below the minimum is NOK', poor.locStatus === 'NOK', poor.locStatus)
check('its gap is negative', poor.locGap === -92, String(poor.locGap))
// Their own row: MZ000140-PYX, LOC 108, gap -392 against the SAIC minimum.
check('and matches their file exactly', poor.owGap === -392, String(poor.owGap))

console.log('\n--- JPH is the only input ---')
check('qty is JPH x hours + 1', dayQty({ jph: 14, workingHours: 8 }) === 113,
      String(dayQty({ jph: 14, workingHours: 8 })))
check('minimal stock is twice that', minimalStock({ jph: 14, workingHours: 8 }) === 226,
      String(minimalStock({ jph: 14, workingHours: 8 })))
check('changing JPH moves the minimum',
      minimalStock({ jph: 20, workingHours: 8 }) === 322,
      String(minimalStock({ jph: 20, workingHours: 8 })))
check('zero JPH does not throw', minimalStock({ jph: 0, workingHours: 8 }) === 2, '2')

console.log('\n--- the sheet layout ---')
const L = layout()
const sheet = breakdownSheet([part])

check('data starts on row 8', sheet.length === HEADER_ROWS + 1, String(sheet.length))
check('A1 names the report', sheet[0][0] === 'Breakdown Query', sheet[0][0])
check('the LOC threshold is in C2', sheet[1][2] === 200, String(sheet[1][2]))
check('the OW threshold is in C3', sheet[2][2] === 500, String(sheet[2][2]))
check('the note is preserved', sheet[3][1] === DEFAULTS.note, sheet[3][1])
check('row 6 heads every area column',
      LOC_COLUMNS.concat(OW_COLUMNS, NONSAIC_COLUMNS)
        .every((c) => sheet[5].includes(c.label)), 'all present')

const data = sheet[HEADER_ROWS]
check('the part number is column A', data[L.partNumber] === '24533127', data[L.partNumber])
check('the master DLOC is column B', data[L.masterDloc] === 'LSD-LOT-0-B', data[L.masterDloc])
check('quantities land under their headings',
      data[L.owFirst + OW_COLUMNS.findIndex((c) => c.area === 'Yanfeng')] === 400,
      String(data[L.owFirst + OW_COLUMNS.findIndex((c) => c.area === 'Yanfeng')]))
// A missing master record showed as "-" in their XLOOKUP fallback.
check('an unknown DLOC renders as a dash',
      breakdownSheet([{ part_number: 'Y' }])[HEADER_ROWS][L.masterDloc] === '-', '-')

console.log('\n--- the formulas cover the right ranges ---')
const f = rowFormulas(8)
console.log(`   OW total: ${f[L.owTotal]}`)
check('the OW total spans every OW column, Yanfeng and Baosteel included',
      f[L.owTotal] === `SUM(${L.col(L.owFirst)}8:${L.col(L.owLast)}8)`, f[L.owTotal])
check('the last OW column really is Baosteel',
      OW_COLUMNS[OW_COLUMNS.length - 1].area === 'Baosteel', 'Baosteel')
check('the LOC total spans the four LOC columns',
      f[L.locTotal] === `SUM(${L.col(L.locFirst)}8:${L.col(L.locLast)}8)`, f[L.locTotal])
check('the SAIC status adds LOC to OW',
      f[L.owStatus].includes(`+${L.col(L.locTotal)}8`), f[L.owStatus])
check('the grand total adds the three group totals',
      f[L.grand] === `SUM(${L.col(L.locTotal)}8,${L.col(L.owTotal)}8,${L.col(L.nsTotal)}8)`,
      f[L.grand])
check('thresholds are absolute so they survive a fill',
      f[L.locGap].includes('$C$2') && f[L.owGap].includes('$C$3'), 'absolute')

console.log('\n--- the Stock sheet ---')
const many = [
  part,                                                   // grand 27125, above
  { part_number: 'LOW-1', loc_dloc: 10 },                 // 10
  { part_number: 'LOW-2', loc_dloc: 100, nonsaic_xin2: 8 }, // 108
  { part_number: 'EDGE', loc_dloc: 226 },                 // exactly the minimum
]
const st = stockRows(many)
check('only parts below the minimum', st.length === 2, String(st.length))
check('the biggest part is left out', !st.some((r) => r[0] === '24533127'), 'excluded')
// IF(B<226,"NOK","OK") - so exactly 226 is OK and does not belong on the list.
check('a part exactly at the minimum is not listed',
      !st.some((r) => r[0] === 'EDGE'), 'excluded')
check('smallest first', st[0][0] === 'LOW-1', st[0][0])
// The column they read is the GRAND total, proved against their own file:
// 10189234 has LOC 16 and NON-SAIC 8, and their Stock sheet shows 24.
check('the number shown is the GRAND total',
      st.find((r) => r[0] === 'LOW-2')[1] === 108,
      String(st.find((r) => r[0] === 'LOW-2')[1]))
check('MRP Stock and Feedback are left empty',
      st[0][2] === '' && st[0][3] === '' && st[0][4] === '', 'empty')

const ss = stockSheet(many)
check('Minimal Stock in B1', ss[0][1] === 226, String(ss[0][1]))
check('JPH in E1', ss[0][4] === 14, String(ss[0][4]))
check('Working Hour in E2', ss[1][4] === 8, String(ss[1][4]))
check('Qty in E3', ss[2][4] === 113, String(ss[2][4]))
check('headers on row 5', ss[4].join('|') === STOCK_HEADERS.join('|'), ss[4].join('|'))
check('data starts on row 6', ss.length === STOCK_HEADER_ROWS + st.length, String(ss.length))

console.log('\n--- naming ---')
const name = breakdownFileName(new Date('2026-09-02T05:00:00Z'))
console.log(`   ${name}`)
check('named the way they name it', name === 'Breakdown Query 02092026.xlsx', name)
// 23:30 UTC is already the next day in Jakarta.
check('uses the local day', localDate(new Date('2026-09-02T17:30:00Z')) === '2026-09-03',
      localDate(new Date('2026-09-02T17:30:00Z')))

console.log('\n--- the workbook itself ---')
const bytes = await writeBreakdownXlsx(many)
check('it writes', bytes.length > 0, `${bytes.length} bytes`)
// xlsx is a zip container: PK.
check('starts with the zip signature',
      bytes[0] === 0x50 && bytes[1] === 0x4b, 'PK')

const back = XLSX.read(bytes, { type: 'array' })
check('two sheets, named as their template',
      back.SheetNames.join(',') === 'Breakdown,Stock', back.SheetNames.join(','))

const bs = back.Sheets.Breakdown
check('the threshold cell survived', bs['C2'].v === 200, String(bs['C2']?.v))
check('the part number is on row 8', bs['A8'].v === '24533127', String(bs['A8']?.v))
// The point of writing formulas: a threshold can still be changed in Excel.
check('the LOC total is a live formula',
      !!bs[`${L.col(L.locTotal)}8`]?.f, bs[`${L.col(L.locTotal)}8`]?.f ?? 'none')
check('the status is a live formula',
      !!bs[`${L.col(L.locStatus)}8`]?.f, bs[`${L.col(L.locStatus)}8`]?.f ?? 'none')
check('the Stock minimum is a live formula', bs && back.Sheets.Stock['B1']?.f === 'E3*2',
      back.Sheets.Stock['B1']?.f ?? 'none')
check('and Qty derives from JPH', back.Sheets.Stock['E3']?.f === '(E1*E2)+1',
      back.Sheets.Stock['E3']?.f ?? 'none')

report()
