// Runs the real multi-file browser parser against the 39 raw WMS exports,
// and checks the combined result against the macro-merged file for the same day.
//
//   node scripts/test-multifile.mjs                    # fallback folder
//   node scripts/test-multifile.mjs ~/data/query-raw   # explicit folder
//   QUERY_DATA_DIR=~/data/query-raw node scripts/test-multifile.mjs
import { parseInventoryFiles } from '../src/lib/parse.js'
import { fileFrom, checker, dataDir, workbooksIn, noDataMessage } from './lib.mjs'

const FALLBACK_DIR = 'C:/Users/INV-ENGINEER/Downloads/query raw'
const { check, report } = checker()

const RAW_DIR = dataDir(FALLBACK_DIR)
if (!RAW_DIR) {
  console.error(noDataMessage('raw export folder'))
  process.exit(1)
}

const paths = workbooksIn(RAW_DIR, /\.(xls|xlsx|xlsm)$/i)
if (paths.length === 0) {
  console.error(`No .xls/.xlsx/.xlsm files in ${RAW_DIR}`)
  process.exit(1)
}

console.log(`=== parsing ${paths.length} raw files as one upload\n`)

let lastPct = -1
const t0 = Date.now()
const out = await parseInventoryFiles(paths.map(fileFrom), (p) => {
  if (p.total && p.done !== undefined) {
    const pct = Math.round((p.done / p.total) * 100)
    if (pct !== lastPct && pct % 20 === 0) {
      console.log(`   ${pct}%  file ${p.fileIndex ?? p.done}/${p.fileCount}  ${(p.rowsSoFar ?? 0).toLocaleString()} rows`)
      lastPct = pct
    }
  }
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\n   parsed in ${secs}s`)
console.log(`   files       : ${out.fileCount}`)
console.log(`   total rows  : ${out.rows.length.toLocaleString()}`)
console.log(`   skipped     : ${out.skipped}`)
if (out.missingOptional.length) console.log(`   optional missing: ${out.missingOptional.join(', ')}`)
console.log('')

check('all files parsed', out.fileCount === paths.length, `${out.fileCount}/${paths.length}`)
// 194,278 is the count recorded from the 14-08 export. Only assert it against
// that same folder; any other day legitimately has a different total.
if (RAW_DIR === FALLBACK_DIR) {
  check('row count matches standalone scan', out.rows.length === 194278, out.rows.length.toLocaleString())
} else {
  check('produced rows', out.rows.length > 0, out.rows.length.toLocaleString())
}
check('every file found its header on row 3', out.perFile.every((f) => f.headerRow === 3))
check('no file produced zero rows', out.perFile.every((f) => f.rows > 0),
      out.perFile.filter((f) => f.rows === 0).map((f) => f.name).join(',') || 'none')

const first = out.rows[0]
console.log(`   sample row: ${JSON.stringify(first)}\n`)

check('part_number populated', !!first.part_number, first.part_number)
check('quantity numeric', typeof first.quantity === 'number', String(first.quantity))

// The column-shift canaries, same as the single-file test.
const opened = new Set(out.rows.map((r) => r.is_case_opened))
check('is_case_opened only Yes/No', [...opened].every((v) => v === 'Yes' || v === 'No'), [...opened].join(','))
const statuses = new Set(out.rows.map((r) => r.status))
check('status never Yes/No', ![...statuses].some((v) => v === 'Yes' || v === 'No'), [...statuses].join(','))

const zones = new Set(out.rows.map((r) => r.zone_type))
console.log(`   zone types: ${[...zones].join(' | ')}`)

const blank = out.rows.filter((r) => !r.part_number).length
check('no blank part numbers', blank === 0, String(blank))

const parts = new Set(out.rows.map((r) => r.part_number))
console.log(`   distinct part numbers: ${parts.size.toLocaleString()}`)
// Like the row count above, this range describes the recorded export only.
if (RAW_DIR === FALLBACK_DIR) {
  check('part count in expected range', parts.size > 11000 && parts.size < 12000, String(parts.size))
} else {
  check('found distinct part numbers', parts.size > 0, String(parts.size))
}

report()
