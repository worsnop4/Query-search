import { useEffect, useState } from 'react'
import { fetchCaseDetail } from '../lib/caseDetails.js'
import { supabase } from '../lib/supabase.js'

export function CaseDetailModal({ caseNo, inboundTime, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [unloadTime, setUnloadTime] = useState(inboundTime ?? null)

  useEffect(() => {
    if (!caseNo) return

    let cancelled = false
    setLoading(true)
    setError(null)

    // If inboundTime was not passed from search row, query it from inventory
    if (!inboundTime) {
      supabase
        .from('inventory')
        .select('inbound_time')
        .eq('case_no', caseNo)
        .limit(1)
        .maybeSingle()
        .then(({ data: inv }) => {
          if (!cancelled && inv?.inbound_time) {
            setUnloadTime(inv.inbound_time)
          }
        })
        .catch(() => {})
    } else {
      setUnloadTime(inboundTime)
    }

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
  }, [caseNo, inboundTime])

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

  function formatTime(d) {
    if (!d) return null
    try {
      const dt = new Date(d)
      if (Number.isNaN(dt.getTime())) return String(d)
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
      <div className="case-mini-popup">
        {/* Header */}
        <div className="case-popup-header">
          <div className="case-popup-title-wrap">
            <span className="case-popup-tag">Case Details</span>
            <h3 id="case-modal-title" className="case-popup-title">
              {caseNo}
            </h3>
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

        {/* Body */}
        <div className="case-popup-body">
          {loading && (
            <div className="case-popup-loading">
              <div className="case-spinner-sm" />
              <span>Looking up details...</span>
            </div>
          )}

          {error && (
            <div className="case-popup-error">
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && (
            <div className="case-popup-rows">
              {/* Row 1: Container */}
              <div className="case-popup-item">
                <span className="case-popup-label">
                  <span className="case-item-icon">🚢</span> Container
                </span>
                <span className="case-popup-value font-mono">
                  {data?.container_code ? (
                    <strong>{data.container_code}</strong>
                  ) : (
                    <span className="muted-dash">—</span>
                  )}
                </span>
              </div>

              {/* Row 2: Unload Destination */}
              <div className="case-popup-item">
                <span className="case-popup-label">
                  <span className="case-item-icon">📍</span> Unload Destination
                </span>
                <span className="case-popup-value">
                  {data?.unload_destination ? (
                    <span className="case-dest-pill">
                      {data.unload_destination}
                    </span>
                  ) : (
                    <span className="muted-dash">—</span>
                  )}
                </span>
              </div>

              {/* Row 3: Time Unload (inbound_time) */}
              <div className="case-popup-item">
                <span className="case-popup-label">
                  <span className="case-item-icon">⏱️</span> Time Unload
                </span>
                <span className="case-popup-value">
                  {unloadTime ? (
                    <span className="case-time-text">
                      {formatTime(unloadTime)}
                    </span>
                  ) : (
                    <span className="muted-dash">—</span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
