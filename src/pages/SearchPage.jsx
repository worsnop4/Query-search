import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 100

// One part number can return thousands of rows, but the limit here is about
// URL length: .in() becomes a query string, and too many values overflow it.
const MAX_PARTS = 500

const CASE_FILTERS = [
  { value: 'all', label: 'All cases' },
  { value: 'Yes', label: 'Opened only' },
  { value: 'No', label: 'Not opened only' },
]

// Accepts a single part number or many pasted together, separated by commas,
// spaces, tabs, semicolons or newlines - so a column copied straight out of
// Excel works. Every part number in both source files is uppercase, so
// upper-casing the input makes the search forgiving without breaking the
// exact match.
function parseParts(text) {
  const seen = new Set()
  for (const raw of text.split(/[\s,;]+/)) {
    const p = raw.trim().toUpperCase()
    if (p) seen.add(p)
  }
  return [...seen]
}

const nf = new Intl.NumberFormat()

// "No rows found for X" is misleading when a filter is what excluded them, so
// name the filters that are actually on.
function filterNote(caseFilter, zoneFilters) {
  const on = []
  if (caseFilter !== 'all') on.push('this case filter')
  if (zoneFilters.length === 1) on.push(`zone type ${zoneFilters[0]}`)
  else if (zoneFilters.length > 1) on.push(`these ${zoneFilters.length} zone types`)
  if (on.length === 0) return ''
  return ` with ${on.join(' and ')}`
}

// How many filters are narrowing the results right now. The collapsed button
// shows this: hiding the controls is fine, hiding the fact that they are
// filtering is how someone ends up staring at four results wondering why.
function countActiveFilters(caseFilter, zoneFilters) {
  return (caseFilter === 'all' ? 0 : 1) + zoneFilters.length
}

// The zone types actually present in the data. Read from the `zone_types` view
// rather than hardcoded here - see the comment on that view. A failure is not
// surfaced: the row of toggles is simply empty, leaving the page behaving as
// it did before the filter existed.
//
// Ordered by row count so the zones people actually use come first; the count
// itself is not shown - it is a property of the whole table, not of whatever
// part numbers you happen to be searching, so putting it next to the filter
// invited reading it as the number of matches.
function useZoneTypes() {
  const [zones, setZones] = useState([])

  useEffect(() => {
    let active = true
    supabase
      .from('zone_types')
      .select('zone_type, row_count')
      .order('row_count', { ascending: false })
      .then(({ data, error }) => {
        if (!active || error) return
        setZones((data ?? []).map((z) => z.zone_type))
      })
    return () => {
      active = false
    }
  }, [])

  return zones
}

export default function SearchPage() {
  const [input, setInput] = useState('')
  const [caseFilter, setCaseFilter] = useState('all')
  // Empty means no zone filter at all. Any selection is a whitelist.
  const [zoneFilters, setZoneFilters] = useState([])

  // Only consulted on narrow screens - the stylesheet shows every filter
  // unconditionally once there is room, and hides the button that flips this.
  const [filtersOpen, setFiltersOpen] = useState(false)

  const zones = useZoneTypes()

  const [parts, setParts] = useState([])
  const [rows, setRows] = useState([])
  const [names, setNames] = useState({})
  const [missing, setMissing] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searched, setSearched] = useState(false)

  // Enter in the textarea fires a search even while one is running (the
  // button is disabled, the key handler is not), and changing the filter
  // starts another. Whichever response lands last would win, painting rows,
  // count and page from different queries. Only the newest request may write.
  // reqRef gates the paged rows; searchRef gates the per-search name/missing
  // lookups, which a filter or page change never touches.
  const reqRef = useRef(0)
  const searchRef = useRef(0)

  // The part numbers the current search is for. A ref as well as state
  // because changeFilter/reload need them in the same tick that runSearch
  // sets them, before React has committed the state update.
  const partsRef = useRef([])

  // No index on zone_type, and none needed: .in('part_number', ...) narrows to
  // at most a few thousand rows first, so the zone filter never scans the
  // whole 194k-row table.
  async function fetchPage(searchParts, filter, zoneList, pageIndex) {
    const from = pageIndex * PAGE_SIZE
    let q = supabase
      .from('inventory')
      .select('part_number, case_no, location, zone_type, quantity, is_case_opened', {
        count: 'exact',
      })
      .in('part_number', searchParts)
      .order('part_number')
      .order('location')
      .order('case_no')
      .range(from, from + PAGE_SIZE - 1)

    if (filter !== 'all') q = q.eq('is_case_opened', filter)
    if (zoneList.length > 0) q = q.in('zone_type', zoneList)

    const { data, count, error: err } = await q
    if (err) throw err
    return { data: data ?? [], count: count ?? 0 }
  }

  async function runSearch(e) {
    e?.preventDefault()
    const searchParts = parseParts(input)

    if (searchParts.length === 0) {
      setError('Enter at least one part number.')
      return
    }
    if (searchParts.length > MAX_PARTS) {
      setError(
        `That is ${nf.format(searchParts.length)} part numbers. ` +
          `Please search at most ${MAX_PARTS} at a time.`
      )
      return
    }

    const reqId = ++reqRef.current
    const searchId = ++searchRef.current
    partsRef.current = searchParts
    setLoading(true)
    setError(null)
    setSearched(true)
    setParts(searchParts)
    setPage(0)

    try {
      const [first, nameRes, foundRes] = await Promise.all([
        fetchPage(searchParts, caseFilter, zoneFilters, 0),
        supabase
          .from('master_data')
          .select('part_number, part_name')
          .in('part_number', searchParts),
        supabase.rpc('found_part_numbers', { pns: searchParts }),
      ])

      if (nameRes.error) throw nameRes.error
      if (foundRes.error) throw foundRes.error

      const nameMap = {}
      for (const r of nameRes.data ?? []) nameMap[r.part_number] = r.part_name
      const found = new Set((foundRes.data ?? []).map((r) => r.part_number))

      if (searchRef.current === searchId) {
        setNames(nameMap)
        setMissing(searchParts.filter((p) => !found.has(p)))
      }
      if (reqRef.current !== reqId) return
      setRows(first.data)
      setTotal(first.count)
    } catch (err) {
      if (reqRef.current !== reqId) return
      setError(err.message ?? String(err))
      setRows([])
      setTotal(0)
      setMissing([])
    } finally {
      if (reqRef.current === reqId) setLoading(false)
    }
  }

  async function reload(filter, zone, pageIndex, searchParts = partsRef.current) {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    try {
      const { data, count } = await fetchPage(searchParts, filter, zone, pageIndex)
      if (reqRef.current !== reqId) return
      setRows(data)
      setTotal(count)
      setPage(pageIndex)
    } catch (err) {
      if (reqRef.current !== reqId) return
      setError(err.message ?? String(err))
    } finally {
      if (reqRef.current === reqId) setLoading(false)
    }
  }

  // Both filters go back to page 1: page 7 of the old result set says nothing
  // about the new one, and may not exist in it at all.
  function changeFilter(value) {
    setCaseFilter(value)
    if (searched) reload(value, zoneFilters, 0)
  }

  function toggleZone(value) {
    const next = zoneFilters.includes(value)
      ? zoneFilters.filter((z) => z !== value)
      : [...zoneFilters, value]
    setZoneFilters(next)
    if (searched) reload(caseFilter, next, 0)
  }

  function clearZones() {
    if (zoneFilters.length === 0) return
    setZoneFilters([])
    if (searched) reload(caseFilter, [], 0)
  }

  function clearAll() {
    // Abandon anything in flight; no later request will arrive to unset
    // `loading` on its behalf, so do it here.
    reqRef.current++
    searchRef.current++
    partsRef.current = []
    setLoading(false)
    setInput('')
    setParts([])
    setRows([])
    setNames({})
    setMissing([])
    setTotal(0)
    setPage(0)
    setError(null)
    setSearched(false)
  }

  const activeFilters = countActiveFilters(caseFilter, zoneFilters)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const firstRow = total === 0 ? 0 : page * PAGE_SIZE + 1
  const lastRow = Math.min(total, (page + 1) * PAGE_SIZE)

  return (
    <>
      <form onSubmit={runSearch} className="search">
        <label htmlFor="pn">Part numbers</label>
        <textarea
          id="pn"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) runSearch(e)
          }}
          placeholder={'23588931\nor paste many: 23588931, 23593625, 11559571-PMC'}
          rows={4}
          spellCheck={false}
        />

        <div className={`controls${filtersOpen ? ' filters-open' : ''}`}>
          {/* Narrow screens only - the stylesheet hides this the moment there
              is room to show every filter at once. */}
          <button
            type="button"
            className={`filtertoggle${activeFilters > 0 ? ' on' : ''}`}
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="casefilter zonefilter"
          >
            Filters
            {activeFilters > 0 && ` · ${activeFilters}`}
            <span aria-hidden="true">{filtersOpen ? ' ▴' : ' ▾'}</span>
          </button>

          <div className="filter" id="casefilter">
            <label htmlFor="cf">Case opened</label>
            <select
              id="cf"
              value={caseFilter}
              onChange={(e) => changeFilter(e.target.value)}
            >
              {CASE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div className="buttons">
            <button type="submit" disabled={loading}>
              {loading ? 'Searching...' : 'Search'}
            </button>
            <button type="button" className="ghost" onClick={clearAll}>
              Clear
            </button>
          </div>

          {/* Inside .controls, not after it, so CSS `order` can keep Search and
              Clear in one place - as a sibling it could only ever land below
              them, which on a phone stranded the buttons between the two
              filters. The pills are real checkboxes: several zones can be on at
              once, and a checkbox says so to the keyboard and to a screen
              reader without any extra wiring. Nothing selected means no
              filter. */}
          {zones.length > 0 && (
            <fieldset
              className={`zonefilter${filtersOpen ? ' open' : ''}`}
              id="zonefilter"
            >
              <legend>Zone type</legend>

              <div className="zonechips">
                <button
                  type="button"
                  className={`zonechip${zoneFilters.length === 0 ? ' on' : ''}`}
                  onClick={clearZones}
                  aria-pressed={zoneFilters.length === 0}
                >
                  All
                </button>

                {zones.map((z) => {
                  const on = zoneFilters.includes(z)
                  return (
                    <label key={z} className={`zonechip${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleZone(z)}
                      />
                      {z}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {searched && !error && (
        <>
          <div className="summary">
            {loading ? (
              'Loading...'
            ) : total === 0 ? (
              <>
                No rows found for{' '}
                {parts.length === 1
                  ? parts[0]
                  : `these ${nf.format(parts.length)} part numbers`}
                {filterNote(caseFilter, zoneFilters)}.
              </>
            ) : (
              <>
                Showing <strong>{nf.format(firstRow)}</strong>&ndash;
                <strong>{nf.format(lastRow)}</strong> of{' '}
                <strong>{nf.format(total)}</strong> rows
                {parts.length > 1 && ` across ${nf.format(parts.length)} part numbers`}
              </>
            )}
          </div>

          {missing.length > 0 && (
            <div className="warn">
              <strong>Not in query:</strong> {missing.join(', ')}
            </div>
          )}

          {rows.length > 0 && (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Part Number</th>
                    <th>Part Name</th>
                    <th>Case No</th>
                    <th>Location</th>
                    <th>Zone Type</th>
                    <th className="num">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.part_number}-${r.case_no}-${r.location}-${i}`}>
                      <td className="mono">{r.part_number}</td>
                      <td>
                        {names[r.part_number] ?? (
                          <span className="muted" title="No master data record">
                            &mdash;
                          </span>
                        )}
                      </td>
                      <td className="mono">{r.case_no}</td>
                      <td>{r.location}</td>
                      <td>{r.zone_type}</td>
                      <td className="num">{nf.format(Number(r.quantity) || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="pager">
              <button
                onClick={() => reload(caseFilter, page - 1)}
                disabled={page === 0 || loading}
              >
                &larr; Previous
              </button>
              <span>
                Page {nf.format(page + 1)} of {nf.format(totalPages)}
              </span>
              <button
                onClick={() => reload(caseFilter, page + 1)}
                disabled={page >= totalPages - 1 || loading}
              >
                Next &rarr;
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
