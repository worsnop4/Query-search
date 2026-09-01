// The WMS "Put away" adjustment file.
//
// It is written to be opened by the WMS, not by a person, so a wrong column or
// a wrong file format fails silently at the other end - the upload is simply
// rejected, or worse, accepted with the columns shifted. Both the layout and
// the binary format are checked here.
//
//   node scripts/test-putaway.mjs
//
// It also writes a real file to the temp folder so Excel itself can be asked
// whether it opens - see the path printed at the end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import {
  PUTAWAY_SHEET,
  PUTAWAY_TITLE,
  PUTAWAY_HEADERS,
  putawayRows,
  putawaySheet,
  putawayFileName,
  writePutawayXls,
} from '../src/lib/putaway.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const session = { location: 'TRANSIT-GA-008', started_at: '2026-09-01T02:00:00Z' }

// One of every finding, so the filter is actually exercised.
const scans = [
  { case_no: 'LAID16306DN02SX00031', result: 'wrong_location', query_opened: false },
  { case_no: 'CASE, WITH COMMA',     result: 'wrong_location', query_opened: false },
  { case_no: 'LAID16306DN02SX00025', result: 'wrong_location', query_opened: false },
  { case_no: 'IS-A-MATCH',           result: 'match',          query_opened: false },
  { case_no: 'NOT-IN-QUERY',         result: 'not_in_query',   query_opened: false },
  { case_no: 'QUERY-SAYS-OPENED',    result: 'match',          query_opened: true },
]

console.log('--- only wrong-location cases belong in a put away ---')

const rows = putawayRows(session, scans)
check('three wrong-location cases', rows.length === 3, String(rows.length))
check('a clean match is left out',
      !rows.some((r) => r[0] === 'IS-A-MATCH'), 'excluded')
// These two need a shortage/profit, not a put away - sending them here would
// tell the WMS to do the wrong thing.
check('a case Query does not know is left out',
      !rows.some((r) => r[0] === 'NOT-IN-QUERY'), 'excluded')
check('a Query-says-opened case is left out',
      !rows.some((r) => r[0] === 'QUERY-SAYS-OPENED'), 'excluded')
check('sorted by case number',
      rows.map((r) => r[0]).join('|') ===
        'CASE, WITH COMMA|LAID16306DN02SX00025|LAID16306DN02SX00031',
      rows.map((r) => r[0]).join('|'))

console.log('\n--- the two columns the user asked for ---')
check('column A is the case number', rows[0][0] === 'CASE, WITH COMMA', rows[0][0])
// The ACTUAL location - where it really is - which is what a put away moves it to.
check('column B is the counted location',
      rows.every((r) => r[1] === 'TRANSIT-GA-008'), rows[0][1])
check('columns C, D and E stay empty',
      rows.every((r) => r[2] === '' && r[3] === '' && r[4] === ''), 'empty')

console.log('\n--- the template layout ---')
const aoa = putawaySheet(session, scans)
check('row 1 is the title', aoa[0][0] === PUTAWAY_TITLE, aoa[0][0])
check('and B1:E1 are blank', aoa[0].slice(1).every((c) => c === ''), 'blank')
check('row 2 is the header',
      aoa[1].join('|') === PUTAWAY_HEADERS.join('|'), aoa[1].join('|'))
check('the header is exactly the template\'s',
      PUTAWAY_HEADERS.join('|') ===
        'Old Case No|Location Code|New Case No|Part No|Quantity',
      PUTAWAY_HEADERS.join('|'))
check('data starts on row 3', aoa[2][0] === 'CASE, WITH COMMA', aoa[2][0])
check('the sheet has title + header + data', aoa.length === 5, String(aoa.length))

console.log('\n--- the binary really is an Excel 97-2003 .xls ---')
const bytes = await writePutawayXls(aoa)

// A .xls is an OLE2 compound file. If this signature is wrong the WMS will
// reject the upload no matter how right the columns are.
const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
check('starts with the OLE2 signature',
      sig.every((b, i) => bytes[i] === b),
      [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '))
check('the file name ends in .xls',
      putawayFileName(session, '2026-09-01').endsWith('.xls'),
      putawayFileName(session, '2026-09-01'))

// Read it back as a stranger would.
const back = XLSX.read(bytes, { type: 'array' })
check('one sheet, named as the template',
      back.SheetNames.length === 1 && back.SheetNames[0] === PUTAWAY_SHEET,
      back.SheetNames.join(','))

const ws = back.Sheets[PUTAWAY_SHEET]
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
check('A1 survived the round trip', grid[0][0] === PUTAWAY_TITLE, String(grid[0][0]))
check('the header row survived',
      PUTAWAY_HEADERS.every((h, i) => grid[1][i] === h), grid[1].join('|'))
check('every case survived',
      grid.slice(2).map((r) => r[0]).join('|') ===
        'CASE, WITH COMMA|LAID16306DN02SX00025|LAID16306DN02SX00031',
      grid.slice(2).map((r) => r[0]).join('|'))
// A comma inside a case number is the thing a CSV would have broken.
check('a comma inside a case number is intact',
      grid[2][0] === 'CASE, WITH COMMA', grid[2][0])
check('the location came through', grid[2][1] === 'TRANSIT-GA-008', String(grid[2][1]))

// Cell addresses, because the WMS reads by position.
check('A3 is the first case', ws['A3'].v === 'CASE, WITH COMMA', String(ws['A3']?.v))
check('B3 is its location', ws['B3'].v === 'TRANSIT-GA-008', String(ws['B3']?.v))

console.log('\n--- a count with nothing to put away ---')
const cleanAoa = putawaySheet(session, [{ case_no: 'X', result: 'match', query_opened: false }])
check('still a valid sheet, just headers', cleanAoa.length === 2, String(cleanAoa.length))
const cleanBytes = await writePutawayXls(cleanAoa)
check('and it still writes', cleanBytes.length > 0, `${cleanBytes.length} bytes`)

// Hand it to Excel, which is the only opinion that matters.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putaway-'))
const out = path.join(dir, putawayFileName(session, '2026-09-01'))
fs.writeFileSync(out, Buffer.from(bytes))
console.log(`\n   wrote ${out}`)
console.log('   open it in Excel to confirm - it should look like the blank template.')

report()
