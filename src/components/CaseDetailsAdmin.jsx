import { useEffect, useRef, useState } from 'react'
import {
  parseCaseContainerWorkbook,
  parseContainerDestinationWorkbook,
  uploadCaseContainers,
  uploadContainerDestinations,
  fetchCaseDetailsStats,
  deleteCaseDetailsBefore,
} from '../lib/caseDetails.js'

export function CaseDetailsAdmin() {
  // Stats state
  const [stats, setStats] = useState({
    case_count: 0,
    container_count: 0,
    oldest_date: null,
    newest_date: null,
  })
  const [loadingStats, setLoadingStats] = useState(false)

  // Case & Container file state
  const [caseFile, setCaseFile] = useState(null)
  const [caseParsed, setCaseParsed] = useState(null)
  const [caseBusy, setCaseBusy] = useState(false)
  const [caseProgress, setCaseProgress] = useState(null)
  const [caseError, setCaseError] = useState(null)
  const [caseSuccess, setCaseSuccess] = useState(null)
  const caseInputRef = useRef(null)
  const caseCancelRef = useRef(false)

  // Container & Destination file state
  const [destFile, setDestFile] = useState(null)
  const [destParsed, setDestParsed] = useState(null)
  const [destBusy, setDestBusy] = useState(false)
  const [destProgress, setDestProgress] = useState(null)
  const [destError, setDestError] = useState(null)
  const [destSuccess, setDestSuccess] = useState(null)
  const destInputRef = useRef(null)
  const destCancelRef = useRef(false)

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

  // ------------------------------------------------------------- 1. Case & Container Handlers
  async function onPickCase(e) {
    const file = e.target.files?.[0]
    setCaseError(null)
    setCaseSuccess(null)
    setCaseParsed(null)
    if (!file) return

    setCaseFile(file)
    setCaseBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const rows = parseCaseContainerWorkbook(buf)
      setCaseParsed(rows)
    } catch (err) {
      setCaseError(err.message ?? 'Failed to read file')
      setCaseFile(null)
      if (caseInputRef.current) caseInputRef.current.value = ''
    } finally {
      setCaseBusy(false)
    }
  }

  async function doUploadCase() {
    if (!caseParsed || caseParsed.length === 0) return
    setCaseBusy(true)
    setCaseError(null)
    setCaseSuccess(null)
    caseCancelRef.current = false

    try {
      const res = await uploadCaseContainers({
        rows: caseParsed,
        onProgress: setCaseProgress,
        shouldCancel: () => caseCancelRef.current,
      })
      setCaseSuccess(`Successfully saved ${res.total.toLocaleString()} case-to-container records.`)
      setCaseParsed(null)
      setCaseFile(null)
      if (caseInputRef.current) caseInputRef.current.value = ''
      refreshStats()
    } catch (err) {
      setCaseError(err.message ?? 'Upload failed')
    } finally {
      setCaseBusy(false)
      setCaseProgress(null)
    }
  }

  // ------------------------------------------------------------- 2. Container & Destination Handlers
  async function onPickDest(e) {
    const file = e.target.files?.[0]
    setDestError(null)
    setDestSuccess(null)
    setDestParsed(null)
    if (!file) return

    setDestFile(file)
    setDestBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const rows = parseContainerDestinationWorkbook(buf)
      setDestParsed(rows)
    } catch (err) {
      setDestError(err.message ?? 'Failed to read file')
      setDestFile(null)
      if (destInputRef.current) destInputRef.current.value = ''
    } finally {
      setDestBusy(false)
    }
  }

  async function doUploadDest() {
    if (!destParsed || destParsed.length === 0) return
    setDestBusy(true)
    setDestError(null)
    setDestSuccess(null)
    destCancelRef.current = false

    try {
      const res = await uploadContainerDestinations({
        rows: destParsed,
        onProgress: setDestProgress,
        shouldCancel: () => destCancelRef.current,
      })
      setDestSuccess(`Successfully saved ${res.total.toLocaleString()} container destination records.`)
      setDestParsed(null)
      setDestFile(null)
      if (destInputRef.current) destInputRef.current.value = ''
      refreshStats()
    } catch (err) {
      setDestError(err.message ?? 'Upload failed')
    } finally {
      setDestBusy(false)
      setDestProgress(null)
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
      setCleanupResult(`Deleted ${count.toLocaleString()} old records.`)
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

  const totalRecords = Number(stats.case_count || 0) + Number(stats.container_count || 0)

  return (
    <section className="case-admin-section">
      <div className="case-admin-header">
        <div>
          <h2>Case Tracking &amp; Container Details</h2>
          <p className="muted small">
            Upload Case-to-Container and Container-to-Destination templates. Cases become
            clickable in search results, showing container, unload destination, and unload time.
          </p>
        </div>
        <div className="case-stats-summary-wrap">
          <div className="case-stats-badge">
            <span className="count">
              {loadingStats ? '...' : Number(stats.case_count || 0).toLocaleString()}
            </span>
            <span className="label">Cases Mapped</span>
          </div>
          <div className="case-stats-badge secondary">
            <span className="count">
              {loadingStats ? '...' : Number(stats.container_count || 0).toLocaleString()}
            </span>
            <span className="label">Containers</span>
          </div>
        </div>
      </div>

      <div className="case-upload-grid">
        {/* Upload 1: Case & Container */}
        <div className="case-upload-card">
          <div className="card-top">
            <span className="badge-type">Template 1</span>
            <h3>1. Case &amp; Container</h3>
            <p className="muted small">
              Upload <code>Case cont.xlsx</code> (Case Number &amp; Container Code).
            </p>
          </div>

          <div className="file-box">
            <input
              ref={caseInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={onPickCase}
              disabled={caseBusy}
            />
            {caseParsed && (
              <div className="preview-stat">
                ✓ Ready: <strong>{caseParsed.length.toLocaleString()}</strong>{' '}
                cases parsed from <em>{caseFile?.name}</em>
              </div>
            )}
          </div>

          {caseError && <div className="card-msg error">{caseError}</div>}
          {caseSuccess && <div className="card-msg success">{caseSuccess}</div>}

          {caseProgress && (
            <div className="upload-progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((caseProgress.done / caseProgress.total) * 100)}%`,
                }}
              />
              <span className="progress-text">
                {caseProgress.done.toLocaleString()} /{' '}
                {caseProgress.total.toLocaleString()} rows (
                {Math.round((caseProgress.done / caseProgress.total) * 100)}%)
              </span>
            </div>
          )}

          <div className="card-actions">
            <button
              type="button"
              className="btn"
              disabled={!caseParsed || caseBusy}
              onClick={doUploadCase}
            >
              {caseBusy ? 'Uploading...' : 'Save Case & Container Mapping'}
            </button>
            {caseBusy && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  caseCancelRef.current = true
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Upload 2: Container & Destination */}
        <div className="case-upload-card">
          <div className="card-top">
            <span className="badge-type secondary">Template 2</span>
            <h3>2. Container &amp; Destination</h3>
            <p className="muted small">
              Upload <code>cont dest.xlsx</code> (Container Code &amp; Unload Destination).
            </p>
          </div>

          <div className="file-box">
            <input
              ref={destInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={onPickDest}
              disabled={destBusy}
            />
            {destParsed && (
              <div className="preview-stat">
                ✓ Ready: <strong>{destParsed.length.toLocaleString()}</strong>{' '}
                containers parsed from <em>{destFile?.name}</em>
              </div>
            )}
          </div>

          {destError && <div className="card-msg error">{destError}</div>}
          {destSuccess && <div className="card-msg success">{destSuccess}</div>}

          {destProgress && (
            <div className="upload-progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((destProgress.done / destProgress.total) * 100)}%`,
                }}
              />
              <span className="progress-text">
                {destProgress.done.toLocaleString()} /{' '}
                {destProgress.total.toLocaleString()} containers (
                {Math.round((destProgress.done / destProgress.total) * 100)}%)
              </span>
            </div>
          )}

          <div className="card-actions">
            <button
              type="button"
              className="btn"
              disabled={!destParsed || destBusy}
              onClick={doUploadDest}
            >
              {destBusy ? 'Uploading...' : 'Save Container Destination'}
            </button>
            {destBusy && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  destCancelRef.current = true
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
              Clean up older records to keep database storage lean.
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
                disabled={cleaningUp || totalRecords === 0}
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
