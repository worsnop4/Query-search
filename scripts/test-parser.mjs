// Runs the real browser parser (src/lib/parse.js) against the actual WMS
// exports, checking that header-name mapping survives the shifting layouts.
//
//   node scripts/test-parser.mjs
import fs from 'node:fs'
import { parseInventory, parseMasterData } from '../src/lib/parse.js'

function fileFrom(path) {
  const b = fs.readFileSync(path)
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  return { name: path.split(/[\\/]/).pop(), arrayBuffer: async () => ab }
}

let failed = 0
function check(label, cond, detail = '') {
  if (!cond) failed++
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const INVENTORY_FILES = [
  'C:/Users/INV-ENGINEER/Downloads/Query - 14-08-2026 (08.20).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 13-08-2026 (08.20).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query -12-08-2026 (07.36).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 11-08-2026 (08.02).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 07-08-2026 (13.10).xlsm',
  'D:/project/template querry upload.xlsm',
]

const ZONE_TYPES = new Set([
  'DLOC Area', 'Stock Area-LOC', 'OF Area', 'Stock Area-Temp',
  'Stock Area A', 'Stock Area-OW', 'Hold Area',
])

for (const path of INVENTORY_FILES) {
  if (!fs.existsSync(path)) { console.log(`\nSKIP (missing): ${path}`); continue }
  const name = path.split('/').pop()
  console.log(`\n=== ${name}`)

  const t0 = Date.now()
  let out
  try {
    out = await parseInventory(fileFrom(path))
  } catch (err) {
    failed++
    console.log(`   FAIL  threw: ${err.message}`)
    continue
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const first = out.rows[0]
  console.log(`   sheet='${out.sheetName}' headerRow=${out.headerRow} rows=${out.rows.length.toLocaleString()} skipped=${out.skipped} in ${secs}s`)
  if (out.missingOptional.length) console.log(`   optional missing: ${out.missingOptional.join(', ')}`)

  // The whole point: no matter which layout, fields must land correctly.
  check('part_number looks like a part number', /^[A-Z0-9][A-Z0-9\-/]*$/.test(first.part_number ?? ''), first.part_number)
  check('quantity is numeric', typeof first.quantity === 'number', String(first.quantity))
  check('zone_type is a known value', ZONE_TYPES.has(first.zone_type), first.zone_type)

  // If columns had shifted, Status ("Available") would land here instead.
  const opened = new Set(out.rows.slice(0, 50000).map((r) => r.is_case_opened))
  check('is_case_opened is only Yes/No', [...opened].every((v) => v === 'Yes' || v === 'No'), [...opened].join(','))

  const statuses = new Set(out.rows.slice(0, 50000).map((r) => r.status))
  check('status is not a Yes/No value', ![...statuses].some((v) => v === 'Yes' || v === 'No'), [...statuses].join(','))

  const ts = first.inbound_time
  check('inbound_time parsed', ts === null || /^\d{4}-\d{2}-\d{2}/.test(String(ts)), String(ts))

  const blankPn = out.rows.filter((r) => !r.part_number).length
  check('no blank part numbers', blankPn === 0, String(blankPn))
}

// ---- master data ----
const MASTER = 'D:/project/PFEP Simple Master Data_12 Aug 2026.xlsb'
if (fs.existsSync(MASTER)) {
  console.log(`\n=== ${MASTER.split('/').pop()}`)
  const t0 = Date.now()
  const out = await parseMasterData(fileFrom(MASTER))
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`   sheet='${out.sheetName}' headerRow=${out.headerRow} rows=${out.rows.length.toLocaleString()} dupes=${out.duplicates} in ${secs}s`)

  const f = out.rows[0]
  console.log(`   first row: ${JSON.stringify(f)}`)
  check('18630 rows', out.rows.length === 18630, String(out.rows.length))
  check('part_name present', !!f.part_name, f.part_name)

  // "OLD DLOC" and "NEW DLOC" sit next to each other in the file, so verify
  // exactly - read the sheet independently and compare column by column
  // rather than guessing from the value's shape.
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await fileFrom(MASTER).arrayBuffer(), { type: 'array', dense: true })
  const grid = XLSX.utils.sheet_to_json(wb.Sheets.MASDAT, { header: 1, raw: true, defval: null, blankrows: true })
  const hdr = grid[2].map((h) => String(h ?? '').replace(/\s+/g, ' ').trim().toUpperCase())
  const iNew = hdr.indexOf('NEW DLOC')
  const iOld = hdr.indexOf('OLD DLOC')
  const iPn = hdr.indexOf('PART NUMBER')
  console.log(`   column indices: PART NUMBER=${iPn} OLD DLOC=${iOld} NEW DLOC=${iNew}`)

  const truth = new Map()
  for (let r = 3; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const pn = row[iPn]
    if (pn === null || pn === undefined || String(pn).trim() === '') continue
    const key = typeof pn === 'number' ? BigInt(pn).toString() : String(pn).trim()
    if (!truth.has(key)) truth.set(key, { neu: row[iNew], old: row[iOld] })
  }

  let wrong = 0, matchedOld = 0
  for (const r of out.rows) {
    const t = truth.get(r.part_number)
    if (!t) continue
    const expect = t.neu === null || String(t.neu).trim() === '' ? null : String(t.neu).trim()
    if (r.dloc !== expect) {
      wrong++
      const oldVal = t.old === null ? null : String(t.old).trim()
      if (r.dloc === oldVal) matchedOld++
    }
  }
  check('dloc matches NEW DLOC exactly', wrong === 0, `${wrong} mismatches (${matchedOld} equal to OLD DLOC)`)
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
