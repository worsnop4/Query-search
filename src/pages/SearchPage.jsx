import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { toTsv, writeClipboard } from '../lib/clipboard'
import { readSearch, describeSearch } from '../lib/searchTerms'
import { CaseDetailModal } from '../components/CaseDetailModal'
import { fetchCaseDestinationsBatch } from '../lib/caseDetails'

const PAGE_SIZE = 100

// PostgREST caps a response at 1,000 rows on this project, so a copy of more
// than that is fetched a page at a time - the same cap the CSV export hits.
const COPY_PAGE = 1000

// A deliberate SUBSET of the columns on screen, not all of them. This is what
// the operation team actually passes around: where a part is and how many.
// Part Name and Zone Type are useful for reading the table and only get in the
// way once the rows are pasted into a message or a sheet.
//
// Because part_name is not here, a copy needs no master_data lookup at all -
// it is purely the inventory rows.
const COPY_HEADERS = ['Part Number', 'Case No', 'Location', 'Qty']
const COPY_COLUMNS = ['part_number', 'case_no', 'location', 'quantity']

// One part number can return thousands of rows, but the limit here is about
// URL length: .in() becomes a query string, and too many values overflow it.
const MAX_PARTS = 500

const CASE_FILTERS = [
  { value: 'all', label: 'All cases' },
  { value: 'Yes', label: 'Opened only' },
  { value: 'No', label: 'Not opened only' },
]


const nf = new Intl.NumberFormat()

// What "nothing has been searched for" looks like, in the shape readSearch()
// returns. One constant so the initial state and Clear cannot drift apart.
const EMPTY_SEARCH = {
  part: { mode: 'empty', parts: [] },
  caseNo: { mode: 'empty', term: '' },
}

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
  // The case number box. A single line, not a textarea: case numbers cannot be
  // pasted as a list because 54,728 of them contain spaces and 4 contain
  // commas, so there is no separator that could be split on safely.
  const [caseInput, setCaseInput] = useState('')
  const [caseFilter, setCaseFilter] = useState('all')
  // Empty means no zone filter at all. Any selection is a whitelist.
  const [zoneFilters, setZoneFilters] = useState([])

  // Only consulted on narrow screens - the stylesheet shows every filter
  // unconditionally once there is room, and hides the button that flips this.
  const [filtersOpen, setFiltersOpen] = useState(false)

  const zones = useZoneTypes()

  // What the current results are FOR: a part-number criteria (exact list or
  // partial term) plus an optional case-number fragment. Held as one object so
  // the table, the pager and the copy button can never disagree about it.
  const [criteria, setCriteria] = useState(EMPTY_SEARCH)
  const [rows, setRows] = useState([])
  const [selectedCase, setSelectedCase] = useState(null)
  const [names, setNames] = useState({})
  const [caseDestinations, setCaseDestinations] = useState({})
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

  const [copyState, setCopyState] = useState('idle') // idle | copying | copied
  const [copyError, setCopyError] = useState(null)
  const [copyDone, setCopyDone] = useState(0)

  // The criteria the current search is for. A ref as well as state because
  // changeFilter/reload need them in the same tick that runSearch sets them,
  // before React has committed the state update.
  const critRef = useRef(EMPTY_SEARCH)

  // The one place the result set is defined, so the table and the copy button
  // can never disagree about what "the result" is.
  //
  // No index on zone_type, and none needed: .in('part_number', ...) narrows to
  // at most a few thousand rows first, so the zone filter never scans the
  // whole 194k-row table.
  //
  // The trailing .order('id') is a tiebreaker, not cosmetic. Rows sharing a
  // part number, location AND case number are ordinary here - 6-8% of the
  // table - so those three columns are not a unique sort, and with LIMIT/OFFSET
  // Postgres is free to return the same row on two pages and drop another.
  // Invisible in a 100-row page; it would quietly corrupt a multi-page copy.
  function resultQuery(criteria, filter, zoneList, select, opts) {
    let q = supabase.from('inventory').select(select, opts)

    // Partial searches lean on the pg_trgm index from 06_partial_search.sql.
    // Without it this is a full scan of ~197k rows, roughly 0.8s per search.
    //
    // Either box may be empty - the other one then defines the whole result -
    // so neither filter is applied unconditionally. An .in() on an empty array
    // would match nothing and silently break a case-only search.
    if (criteria.part.mode === 'partial') {
      q = q.ilike('part_number', `%${criteria.part.term}%`)
    } else if (criteria.part.mode === 'exact') {
      q = q.in('part_number', criteria.part.parts)
    }

    // Always a contains match, on a pattern whose `_`, `%` and `\` are already
    // escaped by readCaseTerm - those characters occur in real case numbers.
    // Needs the trigram index from 07_case_search.sql; without it this is a
    // sequential scan measured at 1.0-1.4s.
    if (criteria.caseNo.mode === 'partial') {
      q = q.ilike('case_no', criteria.caseNo.pattern)
    }

    q = q.order('part_number').order('location').order('case_no').order('id')

    if (filter !== 'all') q = q.eq('is_case_opened', filter)
    if (zoneList.length > 0) q = q.in('zone_type', zoneList)
    return q
  }

  async function fetchPage(criteria, filter, zoneList, pageIndex) {
    const from = pageIndex * PAGE_SIZE
    const { data, count, error: err } = await resultQuery(
      criteria,
      filter,
      zoneList,
      'part_number, case_no, location, zone_type, quantity, is_case_opened, inbound_time',
      { count: 'exact' }
    ).range(from, from + PAGE_SIZE - 1)

    if (err) throw err
    return { data: data ?? [], count: count ?? 0 }
  }

  async function lookupDestinations(rowList) {
    if (!rowList || rowList.length === 0) return
    const caseNumbers = rowList
      .map((r) => r.case_no)
      .filter((c) => c && String(c).trim() !== '')
    if (caseNumbers.length === 0) return
    try {
      const destMap = await fetchCaseDestinationsBatch(caseNumbers)
      if (destMap && Object.keys(destMap).length > 0) {
        setCaseDestinations((prev) => ({ ...prev, ...destMap }))
      }
    } catch {
      // Non-blocking background enhancement
    }
  }

  // An exact search knows its part numbers up front. A partial one does not -
  // it discovers them - so names are looked up from whatever came back.
  // Chunked because .in() becomes a query string and a long one overflows it.
  async function fetchNames(partNumbers) {
    const out = {}
    const list = [...new Set(partNumbers)]
    for (let i = 0; i < list.length; i += MAX_PARTS) {
      const { data, error: err } = await supabase
        .from('master_data')
        .select('part_number, part_name')
        .in('part_number', list.slice(i, i + MAX_PARTS))
      if (err) throw err
      for (const r of data ?? []) out[r.part_number] = r.part_name
    }
    return out
  }

  // Copies EVERY matching row, not just the page on screen - "share the result"
  // means the result, and a colleague receiving 100 of 264 rows with no hint
  // that the rest exist is worse than useless. PostgREST caps a response at
  // 1,000 rows, so anything past that is fetched a page at a time.
  async function copyAll() {
    if (total === 0 || copyState === 'copying') return

    setCopyState('copying')
    setCopyError(null)
    setCopyDone(0)

    try {
      const all = []
      for (let from = 0; from < total; from += COPY_PAGE) {
        const { data, error: err } = await resultQuery(
          critRef.current,
          caseFilter,
          zoneFilters,
          COPY_COLUMNS.join(', ')
        ).range(from, from + COPY_PAGE - 1)

        if (err) throw err
        const batch = data ?? []
        if (batch.length === 0) break
        all.push(...batch)
        setCopyDone(all.length)
      }

      // For any cases sitting at TRANSIT, include their unload destination
      let allDestinations = { ...caseDestinations }
      const transitCases = all
        .filter((r) => r.location?.trim()?.toUpperCase() === 'TRANSIT' && r.case_no)
        .map((r) => r.case_no)

      const unknownTransitCases = transitCases.filter(
        (c) => !allDestinations[String(c).trim().toUpperCase()]
      )

      if (unknownTransitCases.length > 0) {
        try {
          const fetched = await fetchCaseDestinationsBatch(unknownTransitCases)
          allDestinations = { ...allDestinations, ...fetched }
          setCaseDestinations((prev) => ({ ...prev, ...fetched }))
        } catch {
          // If destination lookup fails, continue copying with plain TRANSIT
        }
      }

      const rowsToCopy = all.map((r) => {
        if (r.location?.trim()?.toUpperCase() === 'TRANSIT' && r.case_no) {
          const dest = allDestinations[r.case_no.trim().toUpperCase()]?.unload_destination
          if (dest) {
            return {
              ...r,
              location: `TRANSIT (${dest})`,
            }
          }
        }
        return r
      })

      await writeClipboard(toTsv(COPY_HEADERS, rowsToCopy, COPY_COLUMNS))
      setCopyState('copied')
    } catch (err) {
      setCopyError(err.message ?? String(err))
      setCopyState('idle')
    }
  }

  // Let the tick fade back to the normal label so the button is obviously
  // ready to be used again.
  useEffect(() => {
    if (copyState !== 'copied') return
    const t = setTimeout(() => setCopyState('idle'), 2500)
    return () => clearTimeout(t)
  }, [copyState])

  async function runSearch(e) {
    e?.preventDefault()
    const criteria = readSearch(input, caseInput)

    if (criteria.error) {
      setError(criteria.error)
      return
    }
    if (criteria.part.parts.length > MAX_PARTS) {
      setError(
        `That is ${nf.format(criteria.part.parts.length)} part numbers. ` +
          `Please search at most ${MAX_PARTS} at a time.`
      )
      return
    }

    const reqId = ++reqRef.current
    const searchId = ++searchRef.current
    critRef.current = criteria
    setLoading(true)
    setError(null)
    setSearched(true)
    setCriteria(criteria)
    setPage(0)
    resetCopy()

    try {
      const first = await fetchPage(criteria, caseFilter, zoneFilters, 0)

      if (reqRef.current === reqId) {
        setRows(first.data)
        setTotal(first.count)
        lookupDestinations(first.data)
      }

      if (criteria.part.mode !== 'exact') {
        // Nothing was "not found" - a partial or case-only search asks which
        // parts exist, it does not assert any. Names come from what matched.
        const nameMap = await fetchNames(first.data.map((r) => r.part_number))
        if (searchRef.current === searchId) {
          setNames(nameMap)
          setMissing([])
        }
      } else {
        // "Not in query" means the part has no stock anywhere. With a case
        // number also narrowing the search that claim would be false - a part
        // can be absent from THIS case and still sit in the warehouse - so the
        // lookup is skipped entirely rather than reported wrongly.
        const checkMissing = criteria.caseNo.mode === 'empty'

        const [nameRes, foundRes] = await Promise.all([
          supabase
            .from('master_data')
            .select('part_number, part_name')
            .in('part_number', criteria.part.parts),
          checkMissing
            ? supabase.rpc('found_part_numbers', { pns: criteria.part.parts })
            : Promise.resolve({ data: null, error: null }),
        ])
        if (nameRes.error) throw nameRes.error
        if (foundRes.error) throw foundRes.error

        const nameMap = {}
        for (const r of nameRes.data ?? []) nameMap[r.part_number] = r.part_name

        if (searchRef.current === searchId) {
          setNames(nameMap)
          if (checkMissing) {
            const found = new Set((foundRes.data ?? []).map((r) => r.part_number))
            setMissing(criteria.part.parts.filter((p) => !found.has(p)))
          } else {
            setMissing([])
          }
        }
      }
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

  async function reload(filter, zone, pageIndex, crit = critRef.current) {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    // Changing filter or page changes what "copy" would mean - drop any
    // lingering "Copied" tick so it cannot describe the previous result set.
    resetCopy()
    try {
      // Guard, not paranoia: this signature grew a `zone` argument in the
      // middle, and the pager kept calling reload(filter, page) - so the page
      // index arrived as undefined. Nothing threw. `.range(NaN, NaN)` returns
      // no rows while the exact count still comes back correct, so the page
      // read "NaN-NaN of 184 rows" over an empty table. Inside the try so a
      // wrong call says so on screen rather than in the console.
      if (!Number.isInteger(pageIndex)) {
        throw new Error(`reload() needs a page index, got ${pageIndex}`)
      }

      const { data, count } = await fetchPage(crit, filter, zone, pageIndex)
      if (reqRef.current !== reqId) return
      setRows(data)
      setTotal(count)
      setPage(pageIndex)
      lookupDestinations(data)

      // A partial or case-only search discovers its part numbers, so page 2
      // may hold parts page 1 never mentioned. Merge rather than replace -
      // going back a page would otherwise blank out names already looked up.
      if (crit.part.mode !== 'exact') {
        const unknown = data.map((r) => r.part_number).filter((p) => !(p in names))
        if (unknown.length > 0) {
          const more = await fetchNames(unknown)
          if (reqRef.current === reqId) setNames((prev) => ({ ...prev, ...more }))
        }
      }
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
    critRef.current = EMPTY_SEARCH
    setLoading(false)
    setInput('')
    setCaseInput('')
    setCriteria(EMPTY_SEARCH)
    setRows([])
    setNames({})
    setCaseDestinations({})
    setMissing([])
    setTotal(0)
    setPage(0)
    setError(null)
    setSearched(false)
    resetCopy()
  }

  function resetCopy() {
    setCopyState('idle')
    setCopyError(null)
    setCopyDone(0)
  }

  const activeFilters = countActiveFilters(caseFilter, zoneFilters)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const firstRow = total === 0 ? 0 : page * PAGE_SIZE + 1
  const lastRow = Math.min(total, (page + 1) * PAGE_SIZE)

  // Distinct parts on the page being shown. Deliberately not the whole result
  // set: counting those would need another query, and the honest thing is to
  // describe what is actually on screen.
  const pageParts = new Set(rows.map((r) => r.part_number)).size

  return (
    <>
      <form onSubmit={runSearch} className="search">
        {/* A single line, not a textarea. Case numbers cannot be pasted as a
            list: 54,728 of them contain spaces and 4 contain commas, so there
            is no separator that could be split on without cutting real case
            numbers in half. One fragment at a time. */}
        <label htmlFor="caseno">Case number</label>
        <input
          id="caseno"
          type="text"
          value={caseInput}
          onChange={(e) => setCaseInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch(e)
          }}
          placeholder="any part of the case number - P03741331, or 2026 1320&-"
          spellCheck={false}
          autoComplete="off"
        />

        <label htmlFor="pn">Part numbers</label>
        <textarea
          id="pn"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) runSearch(e)
          }}
          placeholder={
            '23588931\nor just the last 4 digits: 8931\nor paste many: 23588931, 23593625, 11559571-PMC'
          }
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
            <div className="summarytext">
              {loading ? (
                'Loading...'
              ) : total === 0 ? (
                <>
                  No rows found for {describeSearch(criteria, nf.format)}
                  {filterNote(caseFilter, zoneFilters)}.
                </>
              ) : (
                <>
                  Showing <strong>{nf.format(firstRow)}</strong>&ndash;
                  <strong>{nf.format(lastRow)}</strong> of{' '}
                  <strong>{nf.format(total)}</strong> rows
                  {/* A search that DISCOVERS its part numbers - partial, or by
                      case number alone - matched parts nobody named, so say how
                      many. An exact list already knows what it asked for. */}
                  {criteria.part.mode === 'exact' ? (
                    criteria.part.parts.length > 1 &&
                    ` across ${nf.format(criteria.part.parts.length)} part numbers`
                  ) : (
                    <>
                      {' '}
                      across <strong>{nf.format(pageParts)}</strong>
                      {pageParts === 1 ? ' part number' : ' part numbers'}
                      {criteria.part.mode === 'partial' && (
                        <>
                          {' '}
                          containing <strong>{criteria.part.term}</strong>
                        </>
                      )}
                      {total > PAGE_SIZE && ' on this page'}
                    </>
                  )}
                  {criteria.caseNo.mode === 'partial' && (
                    <>
                      {' '}
                      in cases matching <strong>{criteria.caseNo.term}</strong>
                    </>
                  )}
                </>
              )}
            </div>

            {!loading && total > 0 && (
              <button
                type="button"
                className={`copybtn${copyState === 'copied' ? ' ok' : ''}`}
                onClick={copyAll}
                disabled={copyState === 'copying'}
                title={
                  total > PAGE_SIZE
                    ? `Copies all ${nf.format(total)} rows, not just this page. Paste straight into Excel.`
                    : 'Copy these rows. Paste straight into Excel.'
                }
              >
                {copyState === 'copying'
                  ? `Copying ${nf.format(copyDone)} / ${nf.format(total)}...`
                  : copyState === 'copied'
                    ? '✓ Copied'
                    : `Copy ${nf.format(total)} rows`}
              </button>
            )}
          </div>

          {copyError && <div className="error">{copyError}</div>}

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
                      <td className="mono">
                        {r.case_no ? (
                          <button
                            type="button"
                            className="case-link-btn"
                            onClick={() =>
                              setSelectedCase({
                                caseNo: r.case_no,
                                inboundTime: r.inbound_time,
                              })
                            }
                            title={`View details for case ${r.case_no}`}
                          >
                            {r.case_no}
                          </button>
                        ) : (
                          <span className="muted">&mdash;</span>
                        )}
                      </td>
                      <td>
                        <span>{r.location}</span>
                        {r.location === 'TRANSIT' &&
                          caseDestinations[r.case_no?.trim()?.toUpperCase()]
                            ?.unload_destination && (
                            <span
                              className="transit-dest-badge"
                              title={`Unload Destination: ${caseDestinations[r.case_no.trim().toUpperCase()].unload_destination}`}
                            >
                              {
                                caseDestinations[
                                  r.case_no.trim().toUpperCase()
                                ].unload_destination
                              }
                            </span>
                          )}
                      </td>
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
                onClick={() => reload(caseFilter, zoneFilters, page - 1)}
                disabled={page === 0 || loading}
              >
                &larr; Previous
              </button>
              <span>
                Page {nf.format(page + 1)} of {nf.format(totalPages)}
              </span>
              <button
                onClick={() => reload(caseFilter, zoneFilters, page + 1)}
                disabled={page >= totalPages - 1 || loading}
              >
                Next &rarr;
              </button>
            </div>
          )}
        </>
      )}

      {selectedCase && (
        <CaseDetailModal
          caseNo={selectedCase.caseNo}
          inboundTime={selectedCase.inboundTime}
          onClose={() => setSelectedCase(null)}
        />
      )}
    </>
  )
}
