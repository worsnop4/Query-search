// What the search box does with what people type, and whether a partial
// search actually finds the parts the operation team means.
//
//   node --env-file=.env scripts/test-search-terms.mjs
import { createClient } from '@supabase/supabase-js'
import { readCriteria, sanitizeTerm, PARTIAL_MIN } from '../src/lib/searchTerms.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

console.log('--- reading what was typed ---')

const mode = (s) => readCriteria(s).mode

check('empty input', mode('') === 'empty', mode(''))
check('whitespace only', mode('   \n  ') === 'empty', mode('   \n  '))
check('1 char is too short', mode('9') === 'tooshort', mode('9'))
check('3 chars is too short', mode('924') === 'tooshort', mode('924'))
check(`${PARTIAL_MIN} chars is a partial search`, mode('9242') === 'partial', mode('9242'))
check('7 chars is still partial', mode('2358893') === 'partial', mode('2358893'))
check('8 chars is an exact match', mode('23588931') === 'exact', mode('23588931'))
check('a hyphenated part is exact', mode('11559571-PMC') === 'exact', mode('11559571-PMC'))

// A pasted list must stay exact even when the entries are short: someone
// pasting a column wants those parts, not everything resembling them.
check('two short entries stay exact', mode('9242, 8931') === 'exact', mode('9242, 8931'))
check('a pasted column stays exact',
      mode('23588931\n23593625\n11559571-PMC') === 'exact',
      mode('23588931\n23593625\n11559571-PMC'))

const list = readCriteria('23588931, 23593625 23593625')
check('duplicates collapse', list.parts.length === 2, list.parts.join(','))

const partial = readCriteria('  9242  ')
check('partial term is trimmed', partial.term === '9242', `"${partial.term}"`)
check('partial term is upper-cased', readCriteria('sm13').term === 'SM13', readCriteria('sm13').term)

console.log('\n--- wildcards cannot leak into the pattern ---')

// % and _ are ILIKE wildcards. Unstripped, "%" alone would match every row.
check('percent is stripped', sanitizeTerm('92%42') === '9242', sanitizeTerm('92%42'))
check('underscore is stripped', sanitizeTerm('92_42') === '9242', sanitizeTerm('92_42'))
check('backslash is stripped', sanitizeTerm('92\\42') === '9242', sanitizeTerm('92\\42'))
check('a bare % is too short to search', mode('%') === 'tooshort', mode('%'))
check('%%%% collapses to nothing', readCriteria('%%%%').term === '', `"${readCriteria('%%%%').term}"`)
check('hyphen survives', sanitizeTerm('9571-PMC') === '9571-PMC', sanitizeTerm('9571-PMC'))
check('slash survives', sanitizeTerm('1261/1262') === '1261/1262', sanitizeTerm('1261/1262'))

console.log('\n--- against live data ---')

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
)

async function partialSearch(term) {
  const t0 = Date.now()
  const { data, count, error } = await supabase
    .from('inventory')
    .select('part_number', { count: 'exact' })
    .ilike('part_number', `%${term}%`)
    .order('part_number').order('location').order('case_no').order('id')
    .range(0, 99)
  if (error) throw new Error(error.message)
  return { count, parts: [...new Set(data.map((r) => r.part_number))], ms: Date.now() - t0 }
}

// The case that motivated the whole feature: the last 4 digits of a part
// whose full number ends in letters.
const r1 = await partialSearch('9242')
console.log(`   "9242" -> ${r1.count} rows, ${r1.parts.length} parts on page 1, ${r1.ms}ms`)
console.log(`             ${r1.parts.join(', ')}`)
check('finds the letter-suffixed part', r1.parts.includes('10189242-PHD'), r1.parts.join(','))
check('every match really contains the digits',
      r1.parts.every((p) => p.includes('9242')), 'ok')

const r2 = await partialSearch('8931')
console.log(`   "8931" -> ${r2.count} rows, ${r2.parts.length} parts, ${r2.ms}ms`)
check('finds the known part 23588931', r2.parts.includes('23588931'), r2.parts.join(','))

// Exact search must still be exact - a partial rule leaking into it would
// quietly widen every list search.
const { count: exact, error: eErr } = await supabase
  .from('inventory')
  .select('*', { count: 'exact', head: true })
  .in('part_number', ['23588931'])
if (eErr) throw new Error(eErr.message)
const { count: contains } = await supabase
  .from('inventory')
  .select('*', { count: 'exact', head: true })
  .ilike('part_number', '%23588931%')
console.log(`   exact 23588931 -> ${exact} rows; contains -> ${contains} rows`)
check('exact is not wider than contains', exact <= contains, `${exact} vs ${contains}`)

console.log(`\n   partial search timing: ${r1.ms}ms and ${r2.ms}ms`)
if (r1.ms > 300 || r2.ms > 300) {
  console.log('   NOTE: still slow - has supabase/06_partial_search.sql been run?')
}

report()
