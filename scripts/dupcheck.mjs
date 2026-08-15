// Compares the duplicate rate in the macro-merged workbook against a single
// raw file, to confirm the duplicates come from the source and not the merge.
//
//   node scripts/dupcheck.mjs [raw-folder] [--merged=/path/to.xlsm]
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { dataDir, namedFile, noDataMessage } from './lib.mjs'

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
const key = (v) =>
  v === null || v === undefined ? '' :
  typeof v === 'number' ? (Number.isInteger(v) ? BigInt(v).toString() : String(v)) :
  String(v).trim()

function dupRate(grid, label) {
  let hdrRow = -1
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    if ((grid[r] ?? []).map(norm).includes('PART NUMBER')) { hdrRow = r; break }
  }
  const hdr = (grid[hdrRow] ?? []).map(norm)
  const iPn = hdr.indexOf('PART NUMBER')
  const iCase = hdr.indexOf('CASE NO')
  const iLoc = hdr.indexOf('LOCATION')
  const iQty = hdr.indexOf('QUANTITY')

  const seen = new Set()
  let rows = 0, dups = 0
  const seenFull = new Set()
  let fullDups = 0

  for (let r = hdrRow + 1; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const pn = key(row[iPn])
    if (!pn) continue
    rows++
    const k3 = `${pn}|${key(row[iCase])}|${key(row[iLoc])}`
    if (seen.has(k3)) dups++; else seen.add(k3)
    const k4 = `${k3}|${key(row[iQty])}`
    if (seenFull.has(k4)) fullDups++; else seenFull.add(k4)
  }
  console.log(`${label}`)
  console.log(`   rows                      : ${rows.toLocaleString()}`)
  console.log(`   dup by pn|case|location   : ${dups.toLocaleString()}  (${((100 * dups) / rows).toFixed(1)}%)`)
  console.log(`   dup incl. quantity        : ${fullDups.toLocaleString()}  (${((100 * fullDups) / rows).toFixed(1)}%)`)
  console.log('')
  return { rows, dups }
}

const grid = (p) => {
  const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', dense: true })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1, raw: true, defval: null, blankrows: true,
  })
}

// merged file produced by the macro
const merged = namedFile(
  'merged',
  'QUERY_MERGED',
  'C:/Users/INV-ENGINEER/Downloads/Query - 14-08-2026 (08.20).xlsm'
)
if (merged) {
  dupRate(grid(merged), `MERGED  ${merged.split(/[\\/]/).pop()}  [macro output]`)
} else {
  console.log('MERGED file not found - pass --merged=/path/to.xlsm to include it\n')
}

// one single raw file on its own
const dir = dataDir('C:/Users/INV-ENGINEER/Downloads/query raw')
if (!dir) {
  if (!merged) {
    console.error(noDataMessage('raw export folder'))
    process.exit(1)
  }
} else {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xls')).sort()
  if (files.length === 0) {
    console.log(`No .xls files in ${dir}`)
  } else {
    dupRate(grid(`${dir}/${files[0]}`), `SINGLE RAW FILE  ${files[0].slice(0, 24)}...`)
  }
}
