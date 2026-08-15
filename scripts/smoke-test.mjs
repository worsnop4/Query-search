// Replicates exactly what src/App.jsx queries, headlessly.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
)

const PAGE_SIZE = 100

async function fetchPage(parts, filter, pageIndex, zone = 'all') {
  const from = pageIndex * PAGE_SIZE
  let q = supabase
    .from('inventory')
    .select('part_number, case_no, location, zone_type, quantity, is_case_opened', { count: 'exact' })
    .in('part_number', parts)
    .order('part_number').order('location').order('case_no')
    .range(from, from + PAGE_SIZE - 1)
  if (filter !== 'all') q = q.eq('is_case_opened', filter)
  if (zone !== 'all') q = q.eq('zone_type', zone)
  const { data, count, error } = await q
  if (error) throw new Error(`fetchPage: ${error.message}`)
  return { data: data ?? [], count: count ?? 0 }
}

function ok(label, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
  if (!cond) process.exitCode = 1
}

const parts = ['26184917', '23588931', 'NOPE123']

console.log('--- multi part search (incl. one bogus) ---')
const t0 = Date.now()
const [first, nameRes, foundRes] = await Promise.all([
  fetchPage(parts, 'all', 0),
  supabase.from('master_data').select('part_number, part_name').in('part_number', parts),
  supabase.rpc('found_part_numbers', { pns: parts }),
])
const ms = Date.now() - t0

if (nameRes.error) throw new Error(`names: ${nameRes.error.message}`)
if (foundRes.error) throw new Error(`rpc: ${foundRes.error.message}`)

const found = new Set(foundRes.data.map((r) => r.part_number))
const missing = parts.filter((p) => !found.has(p))
const names = Object.fromEntries(nameRes.data.map((r) => [r.part_number, r.part_name]))

console.log(`  round trip: ${ms} ms`)
ok('returns rows', first.data.length === PAGE_SIZE, `${first.data.length} rows on page 1`)
ok('total count present', first.count > 4000, `count = ${first.count.toLocaleString()}`)
ok('bogus PN reported missing', missing.length === 1 && missing[0] === 'NOPE123', missing.join(',') || 'none')
ok('part names resolved', !!names['26184917'], names['26184917'] ?? 'MISSING')
console.log(`  pages: ${Math.ceil(first.count / PAGE_SIZE)}`)

console.log('\n--- single part with the most rows (26184917) ---')
const big = await fetchPage(['26184917'], 'all', 0)
// Was `=== 4205`, the count on the day this was written. Inventory is replaced
// daily, so an exact figure fails on every run that is not that day and says
// nothing about whether the app works. What matters is that the part still
// returns a substantial result set; the invariants below do the real checking.
ok('returns a substantial row count', big.count > 1000, `count = ${big.count.toLocaleString()}`)

const lastPage = Math.ceil(big.count / PAGE_SIZE) - 1
const tail = await fetchPage(['26184917'], 'all', lastPage)
ok('last page reachable', tail.data.length > 0, `page ${lastPage + 1} has ${tail.data.length} rows`)

console.log('\n--- case-opened filter ---')
const yes = await fetchPage(['26184917'], 'Yes', 0)
const no = await fetchPage(['26184917'], 'No', 0)
console.log(`  opened = ${yes.count.toLocaleString()}, not opened = ${no.count.toLocaleString()}`)
ok('filters partition the total', yes.count + no.count === big.count,
   `${yes.count} + ${no.count} = ${yes.count + no.count} vs ${big.count}`)

console.log('\n--- zone type filter ---')
const zoneRes = await supabase.from('zone_types').select('zone_type, row_count').order('row_count', { ascending: false })
if (zoneRes.error) {
  ok('zone_types view exists', false, `${zoneRes.error.message} - run 02_search_helpers.sql`)
} else {
  const zones = zoneRes.data ?? []
  ok('zone_types view readable', zones.length > 0, `${zones.length} zone types`)

  const wholeTable = (await supabase.from('inventory').select('*', { count: 'exact', head: true })).count
  const summed = zones.reduce((n, z) => n + Number(z.row_count), 0)
  ok('view accounts for every row', summed === wholeTable,
     `${summed.toLocaleString()} vs ${wholeTable.toLocaleString()}`)

  // Filtering one part by each zone must partition that part's rows exactly -
  // the same invariant the case-opened filter is checked against below.
  let perZone = 0
  for (const z of zones) {
    const r = await fetchPage(['26184917'], 'all', 0, z.zone_type)
    if (r.count > 0) console.log(`  ${z.zone_type.padEnd(18)} ${r.count.toLocaleString().padStart(6)}`)
    perZone += r.count
  }
  ok('zone filters partition the part', perZone === big.count,
     `${perZone} vs ${big.count}`)
}

console.log('\n--- sample output ---')
for (const r of big.data.slice(0, 4)) {
  console.log(`  ${r.part_number} | ${(names[r.part_number] ?? '—').padEnd(32)} | ${String(r.case_no).padEnd(22)} | ${String(r.location).padEnd(18)} | ${r.quantity}`)
}
