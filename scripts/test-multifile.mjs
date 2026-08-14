// Runs the real multi-file browser parser against the 39 raw WMS exports,
// and checks the combined result against the macro-merged file for the same day.
//
//   node scripts/test-multifile.mjs
import fs from 'node:fs'
import path from 'node:path'
import { parseInventoryFiles } from '../src/lib/parse.js'

const RAW_DIR = 'C:/Users/INV-ENGINEER/Downloads/query raw'

function fileFrom(p) {
  const b = fs.readFileSync(p)
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  return { name: path.basename(p), arrayBuffer: async () => ab }
}

let failed = 0
function check(label, cond, detail = '') {
  if (!cond) failed++
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

if (!fs.existsSync(RAW_DIR)) {
  console.log(`SKIP - folder not found: ${RAW_DIR}`)
  process.exit(0)
}

const paths = fs
  .readdirSync(RAW_DIR)
  .filter((f) => /\.(xls|xlsx|xlsm)$/i.test(f))
  .map((f) => path.join(RAW_DIR, f))

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
check('row count matches standalone scan', out.rows.length === 194278, out.rows.length.toLocaleString())
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
check('part count in expected range', parts.size > 11000 && parts.size < 12000, String(parts.size))

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
