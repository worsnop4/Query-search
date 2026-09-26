import { useEffect, useRef, useState } from 'react'
import {
  parseSaUnpackWorkbook,
  uploadSaUnpack,
  fetchSaUnpackStats,
} from '../lib/saUnpack.js'

const nf = new Intl.NumberFormat()

export function SaUnpackAdmin() {
  const [stats, setStats] = useState({
    total_rows: 0,
    total_cases: 0,
    total_parts: 0,
    distinct_sas: 0,
    oldest_date: null,
    newest_date: null,
  })
  const [loadingStats, setLoadingStats] = useState(false)

  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [saName, setSaName] = useState('')
  const [clearFirst, setClearFirst] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const inputRef = useRef(null)
  const cancelRef = useRef(false)

  function refreshStats() {
    setLoadingStats(true)
    fetchSaUnpackStats()
      .then((s) => setStats(s))
      .catch(() => {})
      .finally(() => setLoadingStats(false))
  }

  useEffect(() => {
    refreshStats()
  }, [])

  async function onPickFile(e) {
    const f = e.target.files?.[0]
    setError(null)
    setSuccess(null)
    setParsed(null)
    if (!f) return

    setFile(f)
    setBusy(true)
    try {
      const buf = await f.arrayBuffer()
      const res = parseSaUnpackWorkbook(buf)
      setParsed(res.rows)
      setSaName(res.saName || '')
    } catch (err) {
      setError(err.message ?? 'Failed to parse file.')
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
    } finally {
      setBusy(false)
    }
  }

  async function doUpload() {
    if (!parsed || parsed.length === 0) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    cancelRef.current = false

    try {
      const res = await uploadSaUnpack({
        rows: parsed,
        saName,
        clearExisting: clearFirst,
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current,
      })
      setSuccess(
        `Successfully uploaded ${res.total.toLocaleString()} parts for "${res.saName || 'SA Unpack'}".`
      )
      setParsed(null)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      refreshStats()
    } catch (err) {
      setError(err.message ?? 'Upload failed.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <section className="case-admin-section">
      <div className="case-admin-header">
        <div>
          <h2>SA Unpack Parts Breakdown</h2>
          <p className="muted small">
            Upload Shipping Advice unpack files (e.g. <code>sa 9.10 unpack.xlsx</code>). Maps case
            numbers to their contained part numbers, grouped by production section.
          </p>
        </div>
        <div className="case-stats-summary-wrap">
          <div className="case-stats-badge">
            <span className="count">
              {loadingStats ? '...' : nf.format(stats.total_cases)}
            </span>
            <span className="label">Cases with Parts</span>
          </div>
          <div className="case-stats-badge secondary">
            <span className="count">
              {loadingStats ? '...' : nf.format(stats.total_rows)}
            </span>
            <span className="label">Total Part Records</span>
          </div>
        </div>
      </div>

      <div className="case-upload-card full-width">
        <div className="card-top">
          <span className="badge-type">Manifest Import</span>
          <h3>Upload SA Unpack File</h3>
          <p className="muted small">
            Accepts <code>sa 9.10 unpack.xlsx</code> (SA, Case Number, Part Number, part_name,
            Section, pack_qty).
          </p>
        </div>

        <div className="file-box">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={onPickFile}
            disabled={busy}
          />
          {parsed && (
            <div className="preview-stat">
              ✓ Ready: <strong>{parsed.length.toLocaleString()}</strong> rows parsed
              {saName ? (
                <span>
                  {' '}
                  for <strong>{saName}</strong>
                </span>
              ) : null}{' '}
              from <em>{file?.name}</em>
            </div>
          )}
        </div>

        {parsed && (
          <div className="sa-upload-options" style={{ marginBottom: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={clearFirst}
                onChange={(e) => setClearFirst(e.target.checked)}
                disabled={busy}
              />
              Replace / clear existing records for this SA before uploading
            </label>
          </div>
        )}

        {error && <div className="card-msg error">{error}</div>}
        {success && <div className="card-msg success">{success}</div>}

        {progress && (
          <div className="upload-progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
              }}
            />
            <span className="progress-text">
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} rows (
              {Math.round((progress.done / progress.total) * 100)}%)
            </span>
          </div>
        )}

        <div className="card-actions">
          <button
            type="button"
            className="btn"
            disabled={!parsed || busy}
            onClick={doUpload}
          >
            {busy ? 'Uploading...' : 'Save SA Unpack Parts'}
          </button>
          {busy && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                cancelRef.current = true
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
