// Tests the inventory CSV export: the quoting rules directly, and the
// pagination against live Supabase.
//
//   node --env-file=.env scripts/test-export.mjs
//
// SAFE TO RUN: reads only. Nothing is written to the database and no file is
// left behind unless you pass --save.
//
// The pagination half is the part that could silently go wrong. PostgREST caps
// responses at 1,000 rows however large a range you ask for, and a query with
// no ORDER BY may return one row on two pages and skip another - both produce
// a file that looks complete and is not. So: fetch every page and assert the
// result is exactly the table, with nothing repeated and nothing missing.
import { createClient } from '@supabase/supabase-js'
import { csvCell, toCsv } from '../src/lib/csv.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const COLUMNS = [
  'part_number', 'supplier_code', 'case_no', 'location', 'zone_type',
  'quantity', 'status', 'is_case_opened', 'inbound_time', 'first_inbound_time',
]
const PAGE = 1000
const CONCURRENCY = 5

// --- quoting ---------------------------------------------------------------
console.log('--- CSV quoting ---')

check('plain text is left bare', csvCell('BATTERY-SHOP') === 'BATTERY-SHOP', csvCell('BATTERY-SHOP'))
check('null becomes empty, not "null"', csvCell(null) === '', JSON.stringify(csvCell(null)))
check('undefined becomes empty', csvCell(undefined) === '', JSON.stringify(csvCell(undefined)))
check('zero survives', csvCell(0) === '0', csvCell(0))
check('comma forces quotes', csvCell('CELL-BAT, SPARE') === '"CELL-BAT, SPARE"', csvCell('CELL-BAT, SPARE'))
check('quote is doubled and wrapped', csvCell('SIZE 5"') === '"SIZE 5"""', csvCell('SIZE 5"'))
check('newline forces quotes', csvCell('A\nB') === '"A\nB"', JSON.stringify(csvCell('A\nB')))
check('carriage return forces quotes', csvCell('A\rB') === '"A\rB"', JSON.stringify(csvCell('A\rB')))
check('hyphenated part number stays plain', csvCell('11559571-PMC') === '11559571-PMC', csvCell('11559571-PMC'))

// A row whose every field is hostile must still round-trip to the right shape.
const nasty = toCsv(
  [{ part_number: 'A,1', supplier_code: 'say "hi"', case_no: null, location: 'x\ny', zone_type: 'DLOC Area', quantity: 5, status: '', is_case_opened: 'Yes', inbound_time: null, first_inbound_time: null }],
  COLUMNS
)
check('header names all columns', nasty.split('\n')[0] === COLUMNS.join(','), nasty.split('\n')[0])
check('hostile row is quoted correctly',
  nasty.includes('"A,1","say ""hi""",,"x\ny",DLOC Area,5,,Yes,,'),
  JSON.stringify(nasty.split('\n').slice(1).join('\n')))

// --- live pagination -------------------------------------------------------
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('\nMissing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Use --env-file=.env')
  process.exit(1)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

console.log('\n--- live pagination ---')

const { count: total, error: countErr } = await sb
  .from('inventory')
  .select('*', { count: 'exact', head: true })
if (countErr) {
  console.error(`Could not count inventory: ${countErr.message}`)
  process.exit(1)
}
console.log(`  table holds ${total.toLocaleString()} rows`)

// Confirm the cap the whole design is built around still applies.
const capProbe = await sb.from('inventory').select('id').order('id').range(0, 4999)
check('server caps a 5,000-row request', (capProbe.data?.length ?? 0) === PAGE,
      `asked 5000, got ${capProbe.data?.length}`)

const pages = Math.ceil(total / PAGE)
console.log(`  fetching ${pages} pages, ${CONCURRENCY} at a time...`)

const chunks = new Array(pages)
let rows = 0
const t0 = Date.now()

for (let start = 0; start < pages; start += CONCURRENCY) {
  const batch = []
  for (let i = start; i < Math.min(start + CONCURRENCY, pages); i++) {
    const from = i * PAGE
    batch.push(
      sb.from('inventory').select(`id, ${COLUMNS.join(', ')}`).order('id').range(from, from + PAGE - 1)
        .then(({ data, error }) => {
          if (error) throw new Error(`page ${i + 1}: ${error.message}`)
          chunks[i] = data
          rows += data.length
        })
    )
  }
  await Promise.all(batch)
  if (start % (CONCURRENCY * 20) === 0 && start > 0) {
    console.log(`    ${rows.toLocaleString()} / ${total.toLocaleString()}`)
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  done in ${secs}s`)

const all = chunks.flat()
check('fetched exactly the row count', all.length === total, `${all.length} vs ${total}`)

const ids = new Set(all.map((r) => r.id))
check('no row appeared twice', ids.size === all.length, `${all.length - ids.size} duplicates`)

// Ordering by a unique key is what guarantees no gaps; verify it held.
let ordered = true
for (let i = 1; i < all.length; i++) if (all[i].id <= all[i - 1].id) { ordered = false; break }
check('pages came back in a stable order', ordered)

const blanks = all.filter((r) => !r.part_number).length
check('every row has a part number', blanks === 0, String(blanks))

// The export must not carry the computed columns or the surrogate key.
const cols = Object.keys(all[0] ?? {}).filter((c) => c !== 'id')
check('no computed columns in the selection',
      !cols.includes('zonetype') && !cols.includes('area'), cols.join(','))
check('exactly the ten parser columns', cols.length === COLUMNS.length, `${cols.length}: ${cols.join(',')}`)

// --- the file it would produce ---------------------------------------------
console.log('\n--- resulting file ---')

const csv = toCsv(all.map(({ id, ...r }) => r), COLUMNS)
const bytes = Buffer.byteLength('﻿' + csv, 'utf8')
const lines = csv.split('\n').length - 1

console.log(`  ${(bytes / 1048576).toFixed(1)} MB, ${lines.toLocaleString()} lines`)
check('one line per row, plus the header', lines === total + 1, `${lines} vs ${total + 1}`)

if (process.argv.includes('--save')) {
  const fs = await import('node:fs')
  fs.writeFileSync('inventory-test-export.csv', '﻿' + csv)
  console.log('  wrote inventory-test-export.csv')
}

report()
