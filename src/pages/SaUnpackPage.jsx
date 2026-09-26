import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchSaUnpackCase, searchSaUnpackCases } from '../lib/saUnpack.js'
import { fetchCaseDetail } from '../lib/caseDetails.js'
import { toTsv, writeClipboard } from '../lib/clipboard.js'

const nf = new Intl.NumberFormat()

// Friendly section icons
function getSectionIcon(sectionName) {
  const s = String(sectionName || '').toUpperCase()
  if (s.includes('TRIM')) return '✂️'
  if (s.includes('BATTERY')) return '🔋'
  if (s.includes('CHASSIS')) return '🚗'
  if (s.includes('ENGINE')) return '⚙️'
  if (s.includes('FINAL')) return '🏁'
  if (s.includes('BODY')) return '🚙'
  if (s.includes('PAINT')) return '🎨'
  if (s.includes('DOOR')) return '🚪'
  if (s.includes('IP')) return '🖥️'
  if (s.includes('TIRE')) return '🛞'
  if (s.includes('GLASS')) return '🪟'
  return '📦'
}

export default function SaUnpackPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [containerInfo, setContainerInfo] = useState(null)
  const [copiedCase, setCopiedCase] = useState(false)
  const [copyTsvState, setCopyTsvState] = useState('idle') // idle | copied
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  // Focus search box on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Auto-search suggestions as user types
  function onInputChange(e) {
    const val = e.target.value
    setQuery(val)
    if (!val || val.trim().length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const matches = await searchSaUnpackCases(val)
        setSuggestions(matches)
        setShowSuggestions(matches.length > 0)
      } catch {
        // ignore
      }
    }, 200)
  }

  async function executeSearch(caseNumberToSearch) {
    const term = (caseNumberToSearch ?? query).trim().toUpperCase()
    if (!term) return

    setQuery(term)
    setShowSuggestions(false)
    setLoading(true)
    setError(null)
    setResult(null)
    setContainerInfo(null)

    try {
      // Query both SA Unpack breakdown and container destination mapping in parallel
      const [res, contData] = await Promise.all([
        fetchSaUnpackCase(term),
        fetchCaseDetail(term).catch(() => null),
      ])

      if (!res) {
        setError(`No SA Unpack records found for case "${term}".`)
      } else {
        setResult(res)
        setContainerInfo(contData)
      }
    } catch (err) {
      setError(err.message ?? 'Search failed.')
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      executeSearch()
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }

  function handleSelectSuggestion(suggCase) {
    executeSearch(suggCase)
  }

  function copyCaseNumber() {
    if (!result?.case_no || !navigator.clipboard?.writeText) return
    navigator.clipboard.writeText(result.case_no).then(() => {
      setCopiedCase(true)
      setTimeout(() => setCopiedCase(false), 2000)
    })
  }

  async function copyAllPartsTsv() {
    if (!result?.sections) return
    const rows = []
    for (const sec of result.sections) {
      for (const p of sec.parts) {
        rows.push({
          section: sec.name,
          part_number: p.part_number,
          part_name: p.part_name || '',
          quantity: p.total_qty,
        })
      }
    }
    const headers = ['Section', 'Part Number', 'Part Name', 'Qty']
    const cols = ['section', 'part_number', 'part_name', 'quantity']
    try {
      await writeClipboard(toTsv(headers, rows, cols))
      setCopyTsvState('copied')
      setTimeout(() => setCopyTsvState('idle'), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="sa-unpack-page">
      {/* Header */}
      <div className="sa-unpack-hero">
        <div className="sa-unpack-badge">SA Unpack Explorer</div>
        <h2>Search Case &amp; Section Parts</h2>
        <p className="muted">
          Look up any Case Number to inspect all part numbers inside, organized by production
          section (Trimming, Battery, Chassis, etc.).
        </p>
      </div>

      {/* Search Input Bar */}
      <div className="sa-search-card">
        <div className="sa-search-bar-wrap">
          <div className="sa-search-input-box">
            <span className="sa-search-icon">🔍</span>
            <input
              ref={inputRef}
              type="text"
              className="sa-search-input"
              placeholder="Enter Case Number (e.g. LAID16345BN01SX00073)..."
              value={query}
              onChange={onInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true)
              }}
              autoComplete="off"
              spellCheck="false"
            />
            {query && (
              <button
                type="button"
                className="sa-search-clear"
                onClick={() => {
                  setQuery('')
                  setResult(null)
                  setError(null)
                  setSuggestions([])
                  setShowSuggestions(false)
                  inputRef.current?.focus()
                }}
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn sa-search-submit"
            onClick={() => executeSearch()}
            disabled={loading || !query.trim()}
          >
            {loading ? 'Searching...' : 'Search Case'}
          </button>
        </div>

        {/* Suggestion dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="sa-suggestions-menu">
            <div className="sa-suggestions-header">Matching Cases:</div>
            {suggestions.map((s) => (
              <button
                key={s.case_no}
                type="button"
                className="sa-suggestion-row"
                onClick={() => handleSelectSuggestion(s.case_no)}
              >
                <span className="sa-sugg-case mono">{s.case_no}</span>
                <span className="sa-sugg-meta">
                  {s.sa && <span className="sa-sugg-badge">{s.sa}</span>}
                  <span className="muted small">
                    {s.part_count} parts ({nf.format(s.total_qty)} pcs)
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="sa-unpack-loading">
          <div className="case-spinner" />
          <p>Looking up case unpack details...</p>
        </div>
      )}

      {/* Error / Not Found */}
      {error && !loading && (
        <div className="sa-unpack-empty-state">
          <div className="empty-icon">🔎</div>
          <h3>Case Not Found</h3>
          <p>{error}</p>
          <p className="muted small">
            Tip: Make sure the case number is correct or that the SA Unpack file has been uploaded in{' '}
            <Link to="/admin">Admin</Link>.
          </p>
        </div>
      )}

      {/* Initial state: quick sample chips */}
      {!loading && !error && !result && (
        <div className="sa-unpack-intro">
          <p className="muted">Try searching with a sample case from the active Shipping Advice:</p>
          <div className="sa-sample-chips">
            {['LAID16345BN01SX00073', 'LAID16345BN01SX00131', 'LAID16345BN01SX00071'].map((c) => (
              <button
                key={c}
                type="button"
                className="sa-sample-chip mono"
                onClick={() => executeSearch(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results View */}
      {result && !loading && (
        <div className="sa-results-container">
          {/* Case Header Banner */}
          <div className="sa-case-banner">
            <div className="sa-case-header-left">
              <div className="sa-case-title-row">
                <span className="sa-case-label">CASE NUMBER</span>
                <h1 className="sa-case-title mono">{result.case_no}</h1>
                <button
                  type="button"
                  className="case-copy-btn"
                  onClick={copyCaseNumber}
                  title="Copy Case Number"
                >
                  {copiedCase ? '✓ Copied' : 'Copy'}
                </button>
              </div>

              <div className="sa-case-meta-row">
                {result.sa && <span className="sa-tag-badge">🚢 {result.sa}</span>}
                {containerInfo?.container_code && (
                  <span className="sa-tag-badge cont-badge mono">
                    📦 Container: <strong>{containerInfo.container_code}</strong>
                  </span>
                )}
                {containerInfo?.unload_destination && (
                  <span className="sa-tag-badge dest-badge">
                    📍 Destination: <strong>{containerInfo.unload_destination}</strong>
                  </span>
                )}
              </div>
            </div>

            <div className="sa-case-header-right">
              <div className="sa-stat-pill">
                <span className="sa-stat-num">{nf.format(result.total_parts)}</span>
                <span className="sa-stat-lbl">Part Numbers</span>
              </div>
              <div className="sa-stat-pill highlight">
                <span className="sa-stat-num">{nf.format(result.total_qty)}</span>
                <span className="sa-stat-lbl">Total Pieces</span>
              </div>
              <div className="sa-stat-pill">
                <span className="sa-stat-num">{result.sections.length}</span>
                <span className="sa-stat-lbl">Sections</span>
              </div>
            </div>
          </div>

          {/* Action bar */}
          <div className="sa-actions-bar">
            <span className="sa-sections-count">
              Showing parts in <strong>{result.sections.length}</strong> section
              {result.sections.length === 1 ? '' : 's'}:
            </span>
            <button
              type="button"
              className="btn secondary small"
              onClick={copyAllPartsTsv}
            >
              {copyTsvState === 'copied' ? '✓ Copied Table' : '📋 Copy Parts Table'}
            </button>
          </div>

          {/* Grouped Section Cards */}
          <div className="sa-sections-grid">
            {result.sections.map((sec) => (
              <div key={sec.name} className="sa-section-card">
                <div className="sa-section-header">
                  <div className="sa-section-title-wrap">
                    <span className="sa-section-icon">{getSectionIcon(sec.name)}</span>
                    <h3 className="sa-section-name">{sec.name}</h3>
                  </div>
                  <div className="sa-section-stats">
                    <span className="sa-sec-badge">
                      {sec.parts.length} part{sec.parts.length === 1 ? '' : 's'}
                    </span>
                    <span className="sa-sec-qty-badge">
                      {nf.format(sec.section_qty)} pcs
                    </span>
                  </div>
                </div>

                <div className="sa-section-table-wrap">
                  <table className="sa-parts-table">
                    <thead>
                      <tr>
                        <th style={{ width: '22%' }}>Part Number</th>
                        <th style={{ width: '58%' }}>Part Name</th>
                        <th style={{ width: '20%', textAlign: 'right' }}>Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.parts.map((p) => (
                        <tr key={p.part_number}>
                          <td className="mono font-semibold">
                            <span className="sa-part-link" title="Part Number">
                              {p.part_number}
                            </span>
                          </td>
                          <td className="sa-part-name">
                            {p.part_name || <span className="muted">—</span>}
                          </td>
                          <td className="sa-part-qty">
                            <span className="sa-qty-val font-mono">
                              {nf.format(p.total_qty)}
                            </span>
                            {p.box_count > 1 && (
                              <span
                                className="sa-box-breakdown"
                                title={`Boxes: ${p.box_qtys.join(', ')}`}
                              >
                                ({p.box_count} boxes)
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
