// Surveys the raw WMS exports: sheet names, distinct header layouts, row and
// duplicate counts. This is how the shifting-column problem was found.
//
//   node scripts/inspect-raw.mjs [folder]      # or set $QUERY_DATA_DIR
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { dataDir, noDataMessage } from './lib.mjs'

const dir = dataDir('C:/Users/INV-ENGINEER/Downloads/query raw')
if (!dir) {
  console.error(noDataMessage('raw export folder'))
  process.exit(1)
}

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xls')).sort()
if (files.length === 0) {
  console.error(`No .xls files in ${dir}`)
  process.exit(1)
}

console.log(`${files.length} files\n`)

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

let grandTotal = 0
const layouts = new Map()
const sheetNames = new Map()
const allPartNumbers = new Set()
let dupRows = 0
const seenRowKeys = new Set()

for (let i = 0; i < files.length; i++) {
  const p = path.join(dir, files[i])
  const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', dense: true, cellDates: true })
  const sn = wb.SheetNames[0]
  sheetNames.set(sn, (sheetNames.get(sn) ?? 0) + 1)

  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
    header: 1, raw: true, defval: null, blankrows: true,
  })

  // find header row within first 10
  let hdrRow = -1
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const cells = (grid[r] ?? []).map(norm)
    if (cells.includes('PART NUMBER')) { hdrRow = r; break }
  }

  const hdr = hdrRow === -1 ? [] : (grid[hdrRow] ?? []).map(norm)
  const sig = `r${hdrRow + 1}|${hdr.map((h) => h || '<BLANK>').join(',')}`
  layouts.set(sig, (layouts.get(sig) ?? 0) + 1)

  let dataRows = 0
  const pnIdx = hdr.indexOf('PART NUMBER')
  const caseIdx = hdr.indexOf('CASE NO')
  const locIdx = hdr.indexOf('LOCATION')
  for (let r = hdrRow + 1; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const pn = row[pnIdx]
    if (pn === null || pn === undefined || String(pn).trim() === '') continue
    dataRows++
    const key = typeof pn === 'number' ? BigInt(pn).toString() : String(pn).trim()
    allPartNumbers.add(key)
    const rk = `${key}|${row[caseIdx]}|${row[locIdx]}`
    if (seenRowKeys.has(rk)) dupRows++
    else seenRowKeys.add(rk)
  }
  grandTotal += dataRows

  if (i < 3 || i === files.length - 1) {
    console.log(`  [${i + 1}] ${files[i].slice(0, 28)}...  sheet='${sn}' header=row${hdrRow + 1} rows=${dataRows.toLocaleString()}`)
  } else if (i === 3) {
    console.log(`  ... (${files.length - 4} more)`)
  }
}

console.log(`\n--- sheet names ---`)
for (const [k, v] of sheetNames) console.log(`  '${k}' x${v}`)

console.log(`\n--- distinct header layouts ---`)
let n = 1
for (const [sig, count] of layouts) {
  const [rowPart, cols] = sig.split('|')
  console.log(`  layout ${n++} (${count} files) header at ${rowPart}`)
  console.log(`    ${cols}`)
}

console.log(`\n--- totals ---`)
console.log(`  data rows across all files : ${grandTotal.toLocaleString()}`)
console.log(`  distinct part numbers      : ${allPartNumbers.size.toLocaleString()}`)
console.log(`  duplicate (pn|case|loc) rows: ${dupRows.toLocaleString()}`)
console.log(`\n  merged .xlsm for same day had 194,741 rows`)
