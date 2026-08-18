// Checks the "copy results" path: TSV shaping, and that fetching a multi-page
// result set returns every row exactly once.
//
//   node --env-file=.env scripts/test-copy.mjs
import { createClient } from '@supabase/supabase-js'
import { tsvCell, toTsv } from '../src/lib/clipboard.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
)

const COPY_PAGE = 1000
const COPY_HEADERS = ['Part Number', 'Part Name', 'Case No', 'Location', 'Zone Type', 'Qty']
const COPY_COLUMNS = ['part_number', 'part_name', 'case_no', 'location', 'zone_type', 'quantity']

// ---------------------------------------------------------------- TSV shaping
console.log('--- TSV shaping ---')

check('plain value untouched', tsvCell('BATTERY-SHOP') === 'BATTERY-SHOP', tsvCell('BATTERY-SHOP'))
check('null becomes empty', tsvCell(null) === '', `"${tsvCell(null)}"`)
check('undefined becomes empty', tsvCell(undefined) === '', `"${tsvCell(undefined)}"`)
check('zero survives', tsvCell(0) === '0', tsvCell(0))
check('a comma needs no quoting in TSV', tsvCell('CELL-BAT, SPARE') === 'CELL-BAT, SPARE', tsvCell('CELL-BAT, SPARE'))

// A tab or newline inside a value would shift every later column silently.
check('embedded tab collapsed', tsvCell('A\tB') === 'A B', JSON.stringify(tsvCell('A\tB')))
check('embedded newline collapsed', tsvCell('A\nB') === 'A B', JSON.stringify(tsvCell('A\nB')))
check('CRLF collapsed to one space', tsvCell('A\r\nB') === 'A B', JSON.stringify(tsvCell('A\r\nB')))

const tsv = toTsv(COPY_HEADERS, [
  { part_number: '12109505-PYX', part_name: 'BODY ASM-PAINT', case_no: 'P03780830', location: 'CENTRAL-BIW', zone_type: 'DLOC Area', quantity: 1 },
  { part_number: '26184917', part_name: null, case_no: 'LAID1610', location: 'BATTERY-SHOP', zone_type: 'OF Area', quantity: 75 },
], COPY_COLUMNS)

const lines = tsv.split('\n')
check('header line present', lines[0] === COPY_HEADERS.join('\t'), lines[0])
check('one line per row plus header', lines.length === 3, String(lines.length))
check('every line has 6 columns', lines.every((l) => l.split('\t').length === 6),
      lines.map((l) => l.split('\t').length).join(','))
check('missing part name is blank, not "null"', lines[2].split('\t')[1] === '', `"${lines[2].split('\t')[1]}"`)
console.log(`   sample line: ${JSON.stringify(lines[1])}\n`)

// ------------------------------------------------------------ live pagination
console.log('--- live multi-page copy ---')

// Same shape as resultQuery() in SearchPage.jsx.
function resultQuery(parts, select) {
  return supabase
    .from('inventory')
    .select(select, { count: 'exact' })
    .in('part_number', parts)
    .order('part_number')
    .order('location')
    .order('case_no')
    .order('id')
}

// A set spanning several pages AND containing rows whose part+location+case
// are identical - the sort keys the page order is built on. 26184917 supplies
// the volume; the rest are parts measured to carry ties, so the result set
// genuinely exercises what the .order('id') tiebreaker is there for.
const PARTS = ['26184917', '11374954', '10218431', '10625728', '11475687', '10899047']

const { count: total, error: cErr } = await resultQuery(PARTS, 'part_number').range(0, 0)
if (cErr) throw new Error(cErr.message)
console.log(`   ${PARTS[0]} has ${total.toLocaleString()} rows (${Math.ceil(total / COPY_PAGE)} pages)`)

const all = []
for (let from = 0; from < total; from += COPY_PAGE) {
  const { data, error } = await resultQuery(
    PARTS,
    'id, part_number, case_no, location, zone_type, quantity'
  ).range(from, from + COPY_PAGE - 1)
  if (error) throw new Error(error.message)
  if (!data.length) break
  all.push(...data)
}

check('fetched exactly the reported count', all.length === total, `${all.length} vs ${total}`)

const ids = new Set(all.map((r) => r.id))
check('no row fetched twice', ids.size === all.length, `${all.length - ids.size} duplicates`)
check('every row has a part number', all.every((r) => r.part_number), 'ok')

// The reason the tiebreaker exists: part_number + location + case_no is NOT a
// unique key in this data, so on its own it cannot define a page boundary.
const ties = all.length - new Set(all.map((r) => `${r.part_number}|${r.location}|${r.case_no}`)).size
check('the sort keys really are non-unique here', ties > 0,
      `${ties} rows share part+location+case`)

// Informational only, and deliberately not a pass/fail assertion: an unstable
// sort is ALLOWED to come back correct on any given run. Postgres simply makes
// no promise either way, which is the whole argument for the tiebreaker - the
// bug it prevents is one you cannot reliably reproduce.
const untied = []
for (let from = 0; from < total; from += COPY_PAGE) {
  const { data } = await supabase
    .from('inventory')
    .select('id')
    .in('part_number', PARTS)
    .order('part_number').order('location').order('case_no')
    .range(from, from + COPY_PAGE - 1)
  untied.push(...(data ?? []))
}
const untiedUnique = new Set(untied.map((r) => r.id)).size
console.log(
  `   same paging without .order('id'): ${untied.length} rows, ${untiedUnique} unique` +
    (untiedUnique === untied.length
      ? '  (came back clean this run - not a guarantee)'
      : `  <-- ${untied.length - untiedUnique} DUPLICATED`)
)

const withNames = all.map((r) => ({ ...r, part_name: 'X' }))
const bigTsv = toTsv(COPY_HEADERS, withNames, COPY_COLUMNS)
const bigLines = bigTsv.split('\n')
check('TSV line count matches row count', bigLines.length === all.length + 1, `${bigLines.length} vs ${all.length + 1}`)
check('no line has a stray tab count', bigLines.every((l) => l.split('\t').length === 6), 'ok')
console.log(`   clipboard payload: ${(bigTsv.length / 1024).toFixed(0)} KB`)

report()
