// What the search box does with what people type, and whether a partial
// search actually finds the parts the operation team means.
//
//   node --env-file=.env scripts/test-search-terms.mjs
import { createClient } from '@supabase/supabase-js'
import {
  readCriteria,
  sanitizeTerm,
  PARTIAL_MIN,
  CASE_MIN,
  escapeLike,
  readCaseTerm,
  readSearch,
  describeSearch,
} from '../src/lib/searchTerms.js'
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

console.log('\n--- case numbers: reading the box ---')

const cmode = (s) => readCaseTerm(s).mode
check('empty case box', cmode('') === 'empty', cmode(''))
check('whitespace only', cmode('   ') === 'empty', cmode('   '))
check(`${CASE_MIN - 1} chars is too short`, cmode('P0374') === 'tooshort', cmode('P0374'))
check(`${CASE_MIN} chars searches`, cmode('P03741') === 'partial', cmode('P03741'))
check('a full case number searches', cmode('PALET OF 2026 1320&-') === 'partial',
      cmode('PALET OF 2026 1320&-'))

// Spaces are part of 54,728 real case numbers, so only the outside is trimmed.
const spaced = readCaseTerm('  PALET OF 2026 1320&-  ')
check('outer whitespace is trimmed', spaced.term === 'PALET OF 2026 1320&-', `"${spaced.term}"`)
check('inner spaces survive', spaced.term.includes(' OF '), spaced.term)

// 20,314 case numbers contain lowercase, so upper-casing would be wrong.
check('lowercase is preserved', readCaseTerm('umVRB230001').term === 'umVRB230001',
      readCaseTerm('umVRB230001').term)

console.log('\n--- case numbers: wildcards are ESCAPED, not stripped ---')

// The opposite rule to part numbers. `_` and `\` occur in real case numbers
// (3,213 and 555 of them), so stripping them would make those unfindable.
check('underscore is escaped, not removed', escapeLike('a_b') === 'a\\_b', escapeLike('a_b'))
check('backslash is escaped', escapeLike('a\\b') === 'a\\\\b', escapeLike('a\\b'))
check('percent is escaped', escapeLike('a%b') === 'a\\%b', escapeLike('a%b'))
check('ordinary text is untouched', escapeLike('PALET OF 2026') === 'PALET OF 2026',
      escapeLike('PALET OF 2026'))

const underscored = readCaseTerm('_10003993_')
check('pattern wraps the escaped term', underscored.pattern === '%\\_10003993\\_%',
      underscored.pattern)
// A bare %%%%%% is long enough to pass CASE_MIN, so the escaping is the only
// thing standing between it and a match-everything query.
check('a bare %%%%%% cannot match everything',
      readCaseTerm('%%%%%%').pattern === '%\\%\\%\\%\\%\\%\\%%',
      readCaseTerm('%%%%%%').pattern)

console.log('\n--- the two boxes together ---')

check('both empty is an error', !!readSearch('', '').error, readSearch('', '').error ?? 'none')
check('part only is fine', !readSearch('23588931', '').error, 'ok')
check('case only is fine', !readSearch('', 'P03741331').error, 'ok')
check('both together is fine', !readSearch('23588931', 'P03741331').error, 'ok')

const both = readSearch('23588931', 'P03741331')
check('part mode survives', both.part.mode === 'exact', both.part.mode)
check('case mode survives', both.caseNo.mode === 'partial', both.caseNo.mode)

const caseOnly = readSearch('', 'P03741331')
check('case-only leaves parts empty', caseOnly.part.mode === 'empty', caseOnly.part.mode)
check('case-only has no part list', caseOnly.part.parts.length === 0,
      String(caseOnly.part.parts.length))

check('a short case number is reported', !!readSearch('', 'P037').error, 'reported')
check('a short part number is reported', !!readSearch('92', '').error, 'reported')

console.log('\n--- what the "no rows" message says ---')
const say = (p, c) => describeSearch(readSearch(p, c))
console.log(`   part only : ${say('23588931', '')}`)
console.log(`   case only : ${say('', 'P03741331')}`)
console.log(`   both      : ${say('23588931', 'P03741331')}`)
console.log(`   partial   : ${say('9242', '')}`)
check('part only names the part', say('23588931', '') === '23588931', say('23588931', ''))
check('case only names the case', say('', 'P03741331').includes('P03741331'),
      say('', 'P03741331'))
check('both are joined with "and"', say('23588931', 'P03741331').includes(' and '),
      say('23588931', 'P03741331'))

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

// Is the trigram index actually in use?
//
// An absolute millisecond threshold is useless here: the round trip to
// Supabase is ~190ms from this office before Postgres does any work, so a
// perfectly indexed search still "takes 200ms". Measure the floor and compare
// against it instead.
//
// The control is a 2-character pattern. Trigrams are three characters, so
// `%00%` CANNOT use the index and must scan the table - if the 4-character
// searches are close to the floor while the 2-character one is well above it,
// the index is doing its job.
async function timeOf(fn, runs = 5) {
  const times = []
  for (let i = 0; i < runs; i++) {
    const t = Date.now()
    await fn()
    times.push(Date.now() - t)
  }
  return Math.min(...times)
}

console.log('\n--- is the trigram index in use? ---')

const floor = await timeOf(() =>
  supabase.from('inventory').select('part_number').eq('part_number', '23588931').limit(1)
)
const indexed = await timeOf(() =>
  supabase.from('inventory').select('part_number', { count: 'exact' })
    .ilike('part_number', '%9242%').range(0, 99)
)
const scanned = await timeOf(() =>
  supabase.from('inventory').select('part_number', { count: 'exact' })
    .ilike('part_number', '%00%').range(0, 99)
)

console.log(`   network floor (exact, 1 row) : ${floor}ms`)
console.log(`   4-char partial (can index)   : ${indexed}ms`)
console.log(`   2-char partial (cannot)      : ${scanned}ms`)

check('partial search costs little over the network floor', indexed - floor < 250,
      `${indexed - floor}ms above floor`)
check('the un-indexable control is measurably slower', scanned > indexed,
      `${scanned}ms vs ${indexed}ms`)

if (indexed - floor >= 250) {
  console.log('\n   NOTE: has supabase/06_partial_search.sql been run?')
}

console.log('\n--- case number search against live data ---')

// Pick a real case number out of the table rather than hardcoding one: the
// inventory is replaced daily, and a fixed case number would eventually vanish
// and fail for a reason that has nothing to do with the search.
const { data: sampleRows, error: sErr } = await supabase
  .from('inventory')
  .select('case_no')
  .order('id')
  .limit(200)
if (sErr) throw new Error(sErr.message)

const sampleCase = sampleRows.map((r) => r.case_no).find((c) => c && c.length >= 20)
check('found a case number to test with', !!sampleCase, sampleCase ?? 'none')

async function caseSearch(term) {
  const t0 = Date.now()
  const { data, count, error } = await supabase
    .from('inventory')
    .select('case_no, part_number', { count: 'exact' })
    .ilike('case_no', readCaseTerm(term).pattern)
    .order('part_number').order('location').order('case_no').order('id')
    .range(0, 99)
  if (error) throw new Error(error.message)
  return { count, rows: data, ms: Date.now() - t0 }
}

const whole = await caseSearch(sampleCase)
console.log(`   whole case number -> ${whole.count} rows, ${whole.ms}ms`)
check('a whole case number finds itself', whole.count > 0, String(whole.count))
check('every row really is that case',
      whole.rows.every((r) => r.case_no === sampleCase), 'ok')

const tail = sampleCase.slice(-12)
const frag = await caseSearch(tail)
console.log(`   last 12 chars ("${tail}") -> ${frag.count} rows, ${frag.ms}ms`)
check('a fragment finds at least what the whole one did', frag.count >= whole.count,
      `${frag.count} vs ${whole.count}`)
check('every row contains the fragment',
      frag.rows.every((r) => r.case_no.includes(tail)), 'ok')

// The escaping is what stops `_` behaving as "any character". Only meaningful
// on a case number that actually contains one.
const withUnderscore = sampleRows.map((r) => r.case_no).find((c) => c && c.includes('_'))
if (withUnderscore) {
  const piece = withUnderscore.slice(withUnderscore.indexOf('_'), withUnderscore.indexOf('_') + 10)
  const escaped = await caseSearch(piece)
  const { count: unescaped } = await supabase
    .from('inventory')
    .select('*', { count: 'exact', head: true })
    .ilike('case_no', `%${piece}%`)
  console.log(`   "${piece}" escaped -> ${escaped.count} rows, raw -> ${unescaped} rows`)
  check('escaping never widens the result', escaped.count <= unescaped,
        `${escaped.count} vs ${unescaped}`)
} else {
  console.log('   (no sampled case number contains an underscore - skipped)')
}

// Same reasoning as the part-number index check above: compare against the
// measured network floor, not a fixed millisecond count.
const caseIndexed = await timeOf(() =>
  supabase.from('inventory').select('case_no', { count: 'exact' })
    .ilike('case_no', readCaseTerm(tail).pattern).range(0, 99)
)
console.log(`\n   network floor          : ${floor}ms`)
console.log(`   case fragment (12 char): ${caseIndexed}ms`)
check('case search costs little over the network floor', caseIndexed - floor < 250,
      `${caseIndexed - floor}ms above floor`)

if (caseIndexed - floor >= 250) {
  console.log('\n   NOTE: has supabase/07_case_search.sql been run?')
  console.log('   Without the trigram index on case_no this is a full table scan.')
}

report()
