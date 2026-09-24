import { useEffect, useState } from 'react'
import { fetchCaseDetail } from '../lib/caseDetails.js'

export function CaseDetailModal({ caseNo, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!caseNo) return

    let cancelled = false
    setLoading(true)
    setError(null)

    fetchCaseDetail(caseNo)
      .then((res) => {
        if (!cancelled) {
          setData(res)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message ?? 'Failed to load case details')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [caseNo])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!caseNo) return null

  function copyCase() {
    if (!navigator.clipboard?.writeText) return
    navigator.clipboard.writeText(caseNo).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function formatDate(d) {
    if (!d) return '-'
    try {
      const dt = new Date(d)
      return dt.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return String(d)
    }
  }

  return (
    <div
      className="case-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="case-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div className="case-modal">
        <div className="case-modal-header">
          <div className="case-modal-title-wrap">
            <span className="case-modal-badge">Case Tracking</span>
            <h2 id="case-modal-title" className="case-modal-title">
              {caseNo}
            </h2>
            <button
              type="button"
              className="case-copy-btn"
              onClick={copyCase}
              title="Copy Case Number"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            className="case-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="case-modal-body">
          {loading && (
            <div className="case-modal-state">
              <div className="case-spinner" />
              <p>Looking up case details...</p>
            </div>
          )}

          {error && (
            <div className="case-modal-error">
              <p>Error: {error}</p>
            </div>
          )}

          {!loading && !error && !data && (
            <div className="case-modal-empty">
              <div className="empty-icon">📦</div>
              <h3>No Case Details Found</h3>
              <p>
                No Shipping Advice or Unpack details have been uploaded for case{' '}
                <strong>{caseNo}</strong> yet.
              </p>
              <p className="case-modal-subhint">
                Admins can upload <code>sa and destination.xlsx</code> and{' '}
                <code>unpacklabel.xlsx</code> from the Admin page.
              </p>
            </div>
          )}

          {!loading && !error && data && (
            <div className="case-details-grid">
              {/* Section 1: Logistics & Shipping */}
              <div className="case-detail-card">
                <div className="card-header">
                  <span className="card-icon">🚢</span>
                  <h4>Shipping & Logistics</h4>
                </div>
                <div className="field-list">
                  <div className="field-row">
                    <span className="field-label">Shipping Advice</span>
                    <span className="field-value">
                      {data.shipping_advice || (
                        <span className="muted-dash">-</span>
                      )}
                    </span>
                  </div>
                  <div className="field-row">
                    <span className="field-label">Container Code</span>
                    <span className="field-value font-mono">
                      {data.container_code || (
                        <span className="muted-dash">-</span>
                      )}
                    </span>
                  </div>
                  <div className="field-row">
                    <span className="field-label">Unload Destination</span>
                    <span className="field-value">
                      {data.unload_destination ? (
                        <span className="dest-tag">
                          {data.unload_destination}
                        </span>
                      ) : (
                        <span className="muted-dash">-</span>
                      )}
                    </span>
                  </div>
                  <div className="field-row footer-row">
                    <span className="field-label">Last SA Update</span>
                    <span className="field-value small">
                      {formatDate(data.sa_updated_at)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Section 2: Unpack & Team */}
              <div className="case-detail-card">
                <div className="card-header">
                  <span className="card-icon">🏷️</span>
                  <h4>Unpack & Team Label</h4>
                </div>
                <div className="field-list">
                  <div className="field-row">
                    <span className="field-label">Unpack Number</span>
                    <span className="field-value">
                      {data.unpack_number ? (
                        <span className="unpack-tag">
                          {data.unpack_number}
                        </span>
                      ) : (
                        <span className="muted-dash">-</span>
                      )}
                    </span>
                  </div>
                  <div className="field-row">
                    <span className="field-label">Team No</span>
                    <span className="field-value">
                      {data.team_no ? (
                        <span className="team-tag">{data.team_no}</span>
                      ) : (
                        <span className="muted-dash">-</span>
                      )}
                    </span>
                  </div>
                  <div className="field-row footer-row">
                    <span className="field-label">Last Unpack Update</span>
                    <span className="field-value small">
                      {formatDate(data.unpack_updated_at)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="case-modal-footer">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
