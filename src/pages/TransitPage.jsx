import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BUCKETS,
  FOLLOW_UP_AFTER,
  prepare,
  summarise,
  arrivalsByDay,
  localDate,
} from '../lib/transit'
import { fetchTransitCases } from '../lib/transitData'
import { buildFollowUpCsv, followUpFileName } from '../lib/transitExport'
import { saveCsv } from '../lib/download'
import { useLastUpdate, formatWhen, relativeTime } from '../lib/useLastUpdate'

const nf = new Intl.NumberFormat()

// ---------------------------------------------------------------------------
// Arrivals per day. Hand-drawn SVG for the same reason the cycle count chart
// is: one small bar chart does not justify a charting dependency.
// ---------------------------------------------------------------------------

const VB_W = 760
const VB_H = 150
const PAD = { top: 10, right: 8, bottom: 26, left: 38 }
const PLOT_W = VB_W - PAD.left - PAD.right
const PLOT_H = VB_H - PAD.top - PAD.bottom

function niceMax(v) {
  if (!(v > 0)) return 1
  const base = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * base) return m * base
  return 10 * base
}

function ArrivalsChart({ days }) {
  if (days.length === 0) return null
  const max = niceMax(Math.max(...days.map((d) => d.count), 1))
  const band = PLOT_W / days.length
  const barW = Math.min(band * 0.62, 40)
  const y = (v) => PAD.top + PLOT_H - (v / max) * PLOT_H
  const every = days.length <= 10 ? 1 : 2

  return (
    <div className="ccchartwrap">
      <svg
        className="ccchart"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="Cases arriving at TRANSIT each day"
      >
        {[0, max].map((t) => (
          <g key={t}>
            <line
              x1={PAD.left} x2={VB_W - PAD.right} y1={y(t)} y2={y(t)}
              stroke="var(--border)" strokeWidth="1"
            />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {nf.format(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const h = (d.count / max) * PLOT_H
          const x = PAD.left + i * band + (band - barW) / 2
          return (
            <g key={d.date}>
              <title>{`${d.date} — ${nf.format(d.count)} case${d.count === 1 ? '' : 's'} arrived`}</title>
              {d.count > 0 && (
                <rect
                  x={x} y={PAD.top + PLOT_H - h} width={barW} height={h}
                  fill={d.today ? 'var(--accent)' : 'var(--c-true)'}
                />
              )}
              {i % every === 0 && (
                <text
                  x={x + barW / 2} y={VB_H - PAD.bottom + 15}
                  textAnchor="middle" fontSize="11" fill="var(--muted)"
                >
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function TransitPage() {
  const [cases, setCases] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(0)
  const [error, setError] = useState(null)
  const [smallPartOnly, setSmallPartOnly] = useState(true)
  const [after, setAfter] = useState(FOLLOW_UP_AFTER)

  const { info: lastUpdate } = useLastUpdate('inventory')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setLoaded(0)
    try {
      setCases(await fetchTransitCases(setLoaded))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Recomputed rather than stored: the aging depends on today, and the two
  // toggles change what is being looked at.
  const rows = useMemo(
    () => (cases ? prepare(cases, { smallPartOnly }) : []),
    [cases, smallPartOnly]
  )
  const stats = useMemo(() => summarise(rows, after), [rows, after])
  const days = useMemo(() => arrivalsByDay(rows, 14), [rows])

  const overdue = rows.filter((r) => r.age !== null && r.age > after)
  const noType = cases ? cases.filter((c) => !c.has_small_part).length : 0

  if (loading) {
    return (
      <div className="admin">
        <p className="muted">
          Loading transit cases{loaded > 0 ? ` (${nf.format(loaded)})` : ''}...
        </p>
      </div>
    )
  }

  return (
    <div className="admin">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="cchead">
          <div>
            <h2>Transit monitoring</h2>
            <p className="muted small">
              Cases sitting at location <strong className="mono">TRANSIT</strong>.
              Query last updated{' '}
              {lastUpdate ? (
                <strong>
                  {formatWhen(lastUpdate.uploaded_at)} ({relativeTime(lastUpdate.uploaded_at)})
                </strong>
              ) : (
                'at an unknown time'
              )}
              .
            </p>
          </div>
          {stats.followUp > 0 && (
            <p className="ccaccuracy">
              <strong>{nf.format(stats.followUp)}</strong>
              <br />
              <span className="muted small">
                more than {after} day{after === 1 ? '' : 's'}
              </span>
            </p>
          )}
        </div>

        <div className="bdopts">
          <label>
            <span className="muted small">Follow up after</span>
            <input
              type="number"
              min="0"
              value={after}
              onChange={(e) => setAfter(Number(e.target.value) || 0)}
            />
          </label>
          <label className="cccheck">
            <input
              type="checkbox"
              checked={smallPartOnly}
              onChange={(e) => setSmallPartOnly(e.target.checked)}
            />
            <span>Small parts only</span>
          </label>
        </div>

        {smallPartOnly && noType > 0 && cases.every((c) => !c.has_small_part) && (
          <div className="warn">
            No case is marked <strong>SMALL PART</strong>. Part Type comes from
            the PFEP file &mdash; run <strong>17_part_type_and_transit.sql</strong>{' '}
            and upload Master Data again, or untick the box to see every case.
          </div>
        )}

        <div className="ccactions">
          <button
            type="button"
            onClick={() => saveCsv(buildFollowUpCsv(rows, after), followUpFileName())}
            disabled={overdue.length === 0}
          >
            {overdue.length === 0
              ? 'Nothing to follow up'
              : `Export ${nf.format(overdue.length)} case${overdue.length === 1 ? '' : 's'} (CSV)`}
          </button>
          <button type="button" className="ghost" onClick={load}>
            Reload
          </button>
        </div>
      </div>

      <div className="card">
        <h3>How long they have been there</h3>
        <div className="ccounts five">
          {BUCKETS.map((b) => (
            <div key={b.key} className={`ccount ${b.tone}`}>
              <strong>{nf.format(stats.counts[b.key])}</strong>
              <span>{b.label}</span>
            </div>
          ))}
          {stats.unknown > 0 && (
            <div className="ccount">
              <strong>{nf.format(stats.unknown)}</strong>
              <span>no arrival time</span>
            </div>
          )}
        </div>
        <p className="muted small">
          {nf.format(stats.total)} case{stats.total === 1 ? '' : 's'} at TRANSIT
          {smallPartOnly && ' marked SMALL PART'}
          {stats.oldest !== null && `, the oldest sitting ${nf.format(stats.oldest)} days`}.
          A case that arrived today counts as <strong>0 days</strong>.
        </p>

        <h3>Arriving each day</h3>
        <ArrivalsChart days={days} />
      </div>

      <div className="card">
        <h3>
          {overdue.length === 0
            ? `Nothing over ${after} days`
            : `${nf.format(overdue.length)} case${overdue.length === 1 ? '' : 's'} over ${after} days`}
        </h3>
        {overdue.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Case No</th>
                  <th>Part</th>
                  <th>Arrived</th>
                  <th className="num">Days</th>
                  <th className="num">Qty</th>
                </tr>
              </thead>
              <tbody>
                {overdue.slice(0, 300).map((r) => (
                  <tr key={r.case_no}>
                    <td className="mono ccbreak">{r.case_no}</td>
                    <td className="small">
                      <span className="mono">{r.part_number}</span>
                      {r.part_name ? ` — ${r.part_name}` : ''}
                    </td>
                    <td className="small mono">{localDate(r.first_inbound_time)}</td>
                    <td className="num">
                      <span className={`pill ${r.age > 6 ? 'bad' : 'warn'}`}>{r.age}</span>
                    </td>
                    <td className="num">{nf.format(Number(r.quantity) || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {overdue.length > 300 && (
          <p className="muted small">
            Showing the oldest 300. The export has all {nf.format(overdue.length)}.
          </p>
        )}
      </div>
    </div>
  )
}
