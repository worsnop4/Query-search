import { useEffect, useRef, useState } from 'react'
import {
  parseShippingAdviceWorkbook,
  parseUnpackLabelWorkbook,
  uploadCaseShipping,
  uploadCaseUnpack,
  fetchCaseDetailsStats,
  deleteCaseDetailsBefore,
} from '../lib/caseDetails.js'

export function CaseDetailsAdmin() {
  // Stats state
  const [stats, setStats] = useState({
    total_count: 0,
    oldest_date: null,
    newest_date: null,
  })
  const [loadingStats, setLoadingStats] = useState(false)

  // Shipping file state
  const [saFile, setSaFile] = useState(null)
  const [saParsed, setSaParsed] = useState(null)
  const [saBusy, setSaBusy] = useState(false)
  const [saProgress, setSaProgress] = useState(null)
  const [saError, setSaError] = useState(null)
  const [saSuccess, setSaSuccess] = useState(null)
  const saInputRef = useRef(null)
  const saCancelRef = useRef(false)

  // Unpack file state
  const [unpackFile, setUnpackFile] = useState(null)
  const [unpackParsed, setUnpackParsed] = useState(null)
  const [unpackBusy, setUnpackBusy] = useState(false)
  const [unpackProgress, setUnpackProgress] = useState(null)
  const [unpackError, setUnpackError] = useState(null)
  const [unpackSuccess, setUnpackSuccess] = useState(null)
  const unpackInputRef = useRef(null)
  const unpackCancelRef = useRef(false)

  // Cleanup state
  const [cleanupDays, setCleanupDays] = useState('60')
  const [customCutoff, setCustomCutoff] = useState('')
  const [cleaningUp, setCleaningUp] = useState(false)
  const [cleanupResult, setCleanupResult] = useState(null)
  const [cleanupError, setCleanupError] = useState(null)
  const [confirmingCleanup, setConfirmingCleanup] = useState(false)

  function refreshStats() {
    setLoadingStats(true)
    fetchCaseDetailsStats()
      .then((s) => setStats(s))
      .catch(() => {})
      .finally(() => setLoadingStats(false))
  }

  useEffect(() => {
    refreshStats()
  }, [])

  // ------------------------------------------------------------- Shipping Handlers
  async function onPickSa(e) {
    const file = e.target.files?.[0]
    setSaError(null)
    setSaSuccess(null)
    setSaParsed(null)
    if (!file) return

    setSaFile(file)
    setSaBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const rows = parseShippingAdviceWorkbook(buf)
      setSaParsed(rows)
    } catch (err) {
      setSaError(err.message ?? 'Failed to read file')
      setSaFile(null)
      if (saInputRef.current) saInputRef.current.value = ''
    } finally {
      setSaBusy(false)
    }
  }

  async function doUploadSa() {
    if (!saParsed || saParsed.length === 0) return
    setSaBusy(true)
    setSaError(null)
    setSaSuccess(null)
    saCancelRef.current = false

    try {
      const res = await uploadCaseShipping({
        rows: saParsed,
        onProgress: setSaProgress,
        shouldCancel: () => saCancelRef.current,
      })
      setSaSuccess(`Successfully uploaded ${res.total.toLocaleString()} shipping records.`)
      setSaParsed(null)
      setSaFile(null)
      if (saInputRef.current) saInputRef.current.value = ''
      refreshStats()
    } catch (err) {
      setSaError(err.message ?? 'Upload failed')
    } finally {
      setSaBusy(false)
      setSaProgress(null)
    }
  }

  // ------------------------------------------------------------- Unpack Handlers
  async function onPickUnpack(e) {
    const file = e.target.files?.[0]
    setUnpackError(null)
    setUnpackSuccess(null)
    setUnpackParsed(null)
    if (!file) return

    setUnpackFile(file)
    setUnpackBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const rows = parseUnpackLabelWorkbook(buf)
      setUnpackParsed(rows)
    } catch (err) {
      setUnpackError(err.message ?? 'Failed to read file')
      setUnpackFile(null)
      if (unpackInputRef.current) unpackInputRef.current.value = ''
    } finally {
      setUnpackBusy(false)
    }
  }

  async function doUploadUnpack() {
    if (!unpackParsed || unpackParsed.length === 0) return
    setUnpackBusy(true)
    setUnpackError(null)
    setUnpackSuccess(null)
    unpackCancelRef.current = false

    try {
      const res = await uploadCaseUnpack({
        rows: unpackParsed,
        onProgress: setUnpackProgress,
        shouldCancel: () => unpackCancelRef.current,
      })
      setUnpackSuccess(`Successfully uploaded ${res.total.toLocaleString()} unpack labels.`)
      setUnpackParsed(null)
      setUnpackFile(null)
      if (unpackInputRef.current) unpackInputRef.current.value = ''
      refreshStats()
    } catch (err) {
      setUnpackError(err.message ?? 'Upload failed')
    } finally {
      setUnpackBusy(false)
      setUnpackProgress(null)
    }
  }

  // ------------------------------------------------------------- Cleanup Handlers
  async function doCleanup() {
    setCleaningUp(true)
    setCleanupError(null)
    setCleanupResult(null)

    try {
      let cutoffIso = ''
      if (cleanupDays === 'custom') {
        if (!customCutoff) throw new Error('Please select a cutoff date.')
        cutoffIso = new Date(customCutoff).toISOString()
      } else {
        const days = parseInt(cleanupDays, 10)
        const d = new Date()
        d.setDate(d.getDate() - days)
        cutoffIso = d.toISOString()
      }

      const count = await deleteCaseDetailsBefore(cutoffIso)
      setCleanupResult(`Deleted ${count.toLocaleString()} old case records.`)
      setConfirmingCleanup(false)
      refreshStats()
    } catch (err) {
      setCleanupError(err.message ?? 'Cleanup failed')
    } finally {
      setCleaningUp(false)
    }
  }

  function formatDate(d) {
    if (!d) return 'None'
    try {
      return new Date(d).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    } catch {
      return String(d)
    }
  }

  return (
    <section className="case-admin-section">
      <div className="case-admin-header">
        <div>
          <h2>Case Tracking Details</h2>
          <p className="muted small">
            Upload shipping advice &amp; unpack labels. Case numbers are matched
            automatically and become clickable in the search results.
          </p>
        </div>
        <div className="case-stats-badge">
          <span className="count">
            {loadingStats ? '...' : Number(stats.total_count).toLocaleString()}
          </span>
          <span className="label">Cases in Database</span>
        </div>
      </div>

      <div className="case-upload-grid">
        {/* Upload 1: SA & Destination */}
        <div className="case-upload-card">
          <div className="card-top">
            <span className="badge-type">Shipping Advice</span>
            <h3>1. SA &amp; Destination</h3>
            <p className="muted small">
              Upload <code>sa and destination.xlsx</code> (Shipping Advice,
              Container Code, Case Number, Destination).
            </p>
          </div>

          <div className="file-box">
            <input
              ref={saInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={onPickSa}
              disabled={saBusy}
            />
            {saParsed && (
              <div className="preview-stat">
                ✓ Ready: <strong>{saParsed.length.toLocaleString()}</strong>{' '}
                cases parsed from <em>{saFile?.name}</em>
              </div>
            )}
          </div>

          {saError && <div className="card-msg error">{saError}</div>}
          {saSuccess && <div className="card-msg success">{saSuccess}</div>}

          {saProgress && (
            <div className="upload-progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((saProgress.done / saProgress.total) * 100)}%`,
                }}
              />
              <span className="progress-text">
                {saProgress.done.toLocaleString()} /{' '}
                {saProgress.total.toLocaleString()} rows (
                {Math.round((saProgress.done / saProgress.total) * 100)}%)
              </span>
            </div>
          )}

          <div className="card-actions">
            <button
              type="button"
              className="btn"
              disabled={!saParsed || saBusy}
              onClick={doUploadSa}
            >
              {saBusy ? 'Uploading...' : 'Save & Merge Shipping Data'}
            </button>
            {saBusy && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  saCancelRef.current = true
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Upload 2: Unpack Label */}
        <div className="case-upload-card">
          <div className="card-top">
            <span className="badge-type secondary">Unpack Label</span>
            <h3>2. Unpack Label</h3>
            <p className="muted small">
              Upload <code>unpacklabel.xlsx</code> (PDAID / Case Number, Unpack
              Number, Team).
            </p>
          </div>

          <div className="file-box">
            <input
              ref={unpackInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={onPickUnpack}
              disabled={unpackBusy}
            />
            {unpackParsed && (
              <div className="preview-stat">
                ✓ Ready: <strong>{unpackParsed.length.toLocaleString()}</strong>{' '}
                unpack rows parsed from <em>{unpackFile?.name}</em>
              </div>
            )}
          </div>

          {unpackError && <div className="card-msg error">{unpackError}</div>}
          {unpackSuccess && (
            <div className="card-msg success">{unpackSuccess}</div>
          )}

          {unpackProgress && (
            <div className="upload-progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((unpackProgress.done / unpackProgress.total) * 100)}%`,
                }}
              />
              <span className="progress-text">
                {unpackProgress.done.toLocaleString()} /{' '}
                {unpackProgress.total.toLocaleString()} rows (
                {Math.round((unpackProgress.done / unpackProgress.total) * 100)}
                %)
              </span>
            </div>
          )}

          <div className="card-actions">
            <button
              type="button"
              className="btn"
              disabled={!unpackParsed || unpackBusy}
              onClick={doUploadUnpack}
            >
              {unpackBusy ? 'Uploading...' : 'Save & Merge Unpack Data'}
            </button>
            {unpackBusy && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  unpackCancelRef.current = true
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Storage Maintenance & Cleanup */}
      <div className="case-cleanup-card">
        <div className="cleanup-header">
          <div>
            <h4>Storage Retention &amp; Cleanup</h4>
            <p className="muted small">
              Clean up older case records to avoid filling database storage.
              Records date back from{' '}
              <strong>{formatDate(stats.oldest_date)}</strong> to{' '}
              <strong>{formatDate(stats.newest_date)}</strong>.
            </p>
          </div>
        </div>

        <div className="cleanup-form">
          <div className="cleanup-controls">
            <label>
              <span>Delete records older than:</span>
              <select
                value={cleanupDays}
                onChange={(e) => setCleanupDays(e.target.value)}
                disabled={cleaningUp}
              >
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days (6 months)</option>
                <option value="custom">Custom Date...</option>
              </select>
            </label>

            {cleanupDays === 'custom' && (
              <input
                type="date"
                value={customCutoff}
                onChange={(e) => setCustomCutoff(e.target.value)}
                disabled={cleaningUp}
              />
            )}

            {!confirmingCleanup ? (
              <button
                type="button"
                className="btn danger small"
                disabled={cleaningUp || stats.total_count === 0}
                onClick={() => setConfirmingCleanup(true)}
              >
                Clean Up Old Data
              </button>
            ) : (
              <div className="cleanup-confirm-group">
                <span className="warning-text">
                  Confirm delete older records?
                </span>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={cleaningUp}
                  onClick={doCleanup}
                >
                  {cleaningUp ? 'Deleting...' : 'Yes, Delete'}
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={cleaningUp}
                  onClick={() => setConfirmingCleanup(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {cleanupResult && (
            <div className="card-msg success">{cleanupResult}</div>
          )}
          {cleanupError && <div className="card-msg error">{cleanupError}</div>}
        </div>
      </div>
    </section>
  )
}
