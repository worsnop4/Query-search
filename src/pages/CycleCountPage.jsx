import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RESULTS,
  RESULT_ORDER,
  ACTIONS,
  readScan,
  summarise,
  accuracy,
  bucketOf,
  describeScan,
  reportRows,
  suggestedAction,
  totalsByDay,
  groupByArea,
} from '../lib/cycleCount'
import {
  searchLocations,
  currentLocks,
  startSession,
  recordScan,
  finishSession,
  cancelSession,
  saveFollowup,
  notCheckedCases,
  sessionSummary,
  sessionScans,
  recentSessions,
  openSession,
  dailyStats,
  adminStats,
  allCountRows,
  areaStats,
  planEntries,
  addPlanEntry,
  removePlanEntry,
} from '../lib/cycleCountData'
import {
  buildResultCsv,
  resultFileName,
  buildDailyCsv,
  dailyFileName,
  buildAllCsv,
  allFileName,
} from '../lib/cycleCountExport'
import { saveCsv } from '../lib/download'

const nf = new Intl.NumberFormat()

function when(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// ---------------------------------------------------------------------------
// Choosing what to count
// ---------------------------------------------------------------------------

function LocationPicker({ onStarted, onError, onBack }) {
  const [term, setTerm] = useState('')
  const [locations, setLocations] = useState([])
  const [locks, setLocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(null)

  // Only the newest lookup may paint: typing fires several and they can land
  // out of order, which would show results for a term already deleted.
  const reqRef = useRef(0)

  useEffect(() => {
    const id = ++reqRef.current
    setLoading(true)
    const t = setTimeout(() => {
      Promise.all([searchLocations(term), currentLocks()])
        .then(([rows, held]) => {
          if (reqRef.current !== id) return
          setLocations(rows)
          setLocks(held)
          setLoading(false)
        })
        .catch((err) => {
          if (reqRef.current !== id) return
          onError(err.message)
          setLoading(false)
        })
    }, 200)
    return () => clearTimeout(t)
  }, [term, onError])

  const lockOf = (loc) => locks.find((l) => l.location === loc) ?? null

  async function start(location) {
    setStarting(location)
    onError(null)
    try {
      onStarted(await startSession(location))
    } catch (err) {
      onError(err.message)
      setStarting(null)
      // Someone may have taken the location while the list was on screen.
      currentLocks().then(setLocks).catch(() => {})
    }
  }

  return (
    <div className="card">
      <div className="cchead">
        <div>
          <h2>Pick a location</h2>
          <p className="muted small">
            One location at a time. Every case Query has there is included,
            opened or not - a case found full while Query says it was opened is
            exactly what this is for.
          </p>
        </div>
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
      </div>

      <input
        type="text"
        className="ccsearch"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Find a location - TRANSIT B02"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
      />

      {loading && <p className="muted small">Loading...</p>}

      {!loading && locations.length === 0 && (
        <p className="muted small">No location matches that.</p>
      )}

      <ul className="loclist">
        {locations.map((l) => {
          const held = lockOf(l.location)
          return (
            <li key={l.location}>
              <button
                type="button"
                className="locbtn"
                onClick={() => start(l.location)}
                disabled={starting !== null || !!held}
                title={held ? `${held.started_by} is counting this now` : undefined}
              >
                <span className="mono">{l.location}</span>
                <span className="muted small">
                  {held ? (
                    <span className="pill warn">{held.started_by} is counting</span>
                  ) : starting === l.location ? (
                    'Starting...'
                  ) : (
                    <>
                      {nf.format(l.cases)} case{l.cases === 1 ? '' : 's'}
                      {l.opened_cases > 0 && `, ${nf.format(l.opened_cases)} opened`}
                    </>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Counters({ counts, expected }) {
  return (
    <div className="ccounts five">
      {RESULT_ORDER.map((key) => {
        const n =
          key === 'not_checked'
            ? Math.max(0, expected - counts.clean_match - counts.opened_mismatch)
            : counts[key]
        return (
          <div key={key} className={`ccount ${RESULTS[key].tone}`}>
            <strong>{nf.format(n)}</strong>
            <span>{RESULTS[key].label}</span>
          </div>
        )
      })}
    </div>
  )
}

function ScanScreen({ session, onFinished, onError }) {
  const [value, setValue] = useState('')
  const [scans, setScans] = useState([])
  const [last, setLast] = useState(null)
  const [busy, setBusy] = useState(false)
  const [ending, setEnding] = useState(false)

  const inputRef = useRef(null)

  // A barcode wedge can fire faster than a round trip completes. Scans are
  // queued and sent one at a time rather than dropped or raced - losing a scan
  // silently is the one failure a counter would never notice.
  const queueRef = useRef([])
  const workingRef = useRef(false)

  const pump = useCallback(async () => {
    if (workingRef.current) return
    workingRef.current = true
    setBusy(true)
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()
        try {
          const row = await recordScan(session.id, next)
          setLast(row)
          if (!row.already_scanned) setScans((prev) => [row, ...prev])
        } catch (err) {
          onError(err.message)
        }
      }
    } finally {
      workingRef.current = false
      setBusy(false)
    }
  }, [session.id, onError])

  function submit(e) {
    e?.preventDefault()
    const read = readScan(value)
    // Clear immediately either way, so the next scan never lands on top of the
    // previous one.
    setValue('')
    inputRef.current?.focus()
    if (!read.ok) return
    queueRef.current.push(read.case_no)
    pump()
  }

  async function end(fn) {
    setEnding(true)
    onError(null)
    try {
      await fn(session.id)
      onFinished(session.id)
    } catch (err) {
      onError(err.message)
      setEnding(false)
    }
  }

  const counts = summarise(scans)

  return (
    <>
      <div className="card ccscan">
        <div className="cchead">
          <div>
            <span className="muted small">Counting</span>
            <h2 className="mono">{session.location}</h2>
          </div>
          <div className="muted small">
            Query expects {nf.format(session.expected_count)} case
            {session.expected_count === 1 ? '' : 's'}
            <br />
            started {when(session.started_at)} by {session.started_by}
          </div>
        </div>

        <form onSubmit={submit}>
          {/* autoFocus and re-focus after every scan: a barcode wedge types
              into whatever has focus, so losing it silently drops scans. */}
          <input
            ref={inputRef}
            type="text"
            className="ccinput"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Scan a case barcode"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </form>

        {last && (
          <div className={`ccresult ${RESULTS[bucketOf(last)].tone}`}>
            <strong>{RESULTS[bucketOf(last)].label}</strong>
            {last.already_scanned && <em> · already scanned</em>}
            <span className="mono ccresultcase">{last.case_no}</span>
            <span className="small">{describeScan(last)}</span>
          </div>
        )}

        <Counters counts={counts} expected={session.expected_count} />

        <div className="ccactions">
          <button type="button" onClick={() => end(finishSession)} disabled={ending}>
            {ending ? 'Finishing...' : 'Finish and see the result'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => end(cancelSession)}
            disabled={ending}
            title="Abandon this count and let someone else take the location"
          >
            Cancel
          </button>
          {busy && <span className="muted small">Saving...</span>}
        </div>
      </div>

      {scans.length > 0 && (
        <div className="card">
          <h3>Scanned in this session ({nf.format(scans.length)})</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Case No</th>
                  <th>Result</th>
                  <th>Query says</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((s) => (
                  <tr key={s.case_no}>
                    <td className="mono">{s.case_no}</td>
                    <td>
                      <span className={`pill ${RESULTS[bucketOf(s)].tone}`}>
                        {RESULTS[bucketOf(s)].label}
                      </span>
                    </td>
                    <td className="small">{describeScan(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One reason / action / status for the WHOLE count, mirroring the workbook's
// Historic / DO / Status columns.
//
// Not per case, deliberately: "no need reason for every case number. make
// reason action, status for 1 location". A count is one location on one day
// and gets one decision.
// ---------------------------------------------------------------------------

function SessionFollowup({ summary, counts, onError }) {
  const [reason, setReason] = useState(summary.reason ?? '')
  const [action, setAction] = useState(summary.action ?? suggestedAction(counts))
  const [done, setDone] = useState(!!summary.done)
  const [remark, setRemark] = useState(summary.remark ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = useCallback(
    async (next) => {
      setSaving(true)
      try {
        await saveFollowup(summary.id, { reason, action, done, remark, ...next })
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
      } catch (err) {
        onError(err.message)
      } finally {
        setSaving(false)
      }
    },
    [summary.id, reason, action, done, remark, onError]
  )

  return (
    <div className="card">
      <h3>What to do about this location</h3>
      <p className="muted small">
        One decision for the whole count, not per case.
      </p>

      <div className="ccfollowup">
        <label>
          <span className="muted small">Reason</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => save({})}
            placeholder="Wrong put away"
            spellCheck={false}
          />
        </label>

        <label>
          <span className="muted small">Action</span>
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              save({ action: e.target.value })
            }}
          >
            <option value="">Choose...</option>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="muted small">Remark</span>
          <input
            type="text"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            onBlur={() => save({})}
            placeholder="optional"
            spellCheck={false}
          />
        </label>

        <label className="cccheck">
          <input
            type="checkbox"
            checked={done}
            onChange={(e) => {
              setDone(e.target.checked)
              save({ done: e.target.checked })
            }}
          />
          <span>Adjustment done</span>
        </label>
      </div>

      <p className="muted small">
        {saving ? 'Saving...' : saved ? 'Saved.' : ' '}
      </p>
    </div>
  )
}

function DoneScreen({ sessionId, onNew, onError }) {
  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState([])
  // Kept as they came back so the CSV can hold every case, not just the
  // problems the screen lists.
  const [raw, setRaw] = useState({ scans: [], notChecked: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all([
      sessionSummary(sessionId),
      sessionScans(sessionId),
      notCheckedCases(sessionId),
    ])
      .then(([s, scans, notChecked]) => {
        if (!active) return
        setSummary(s)
        setRaw({ scans, notChecked })
        setRows(reportRows(scans, notChecked))
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        onError(err.message)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [sessionId, onError])

  if (loading) return <p className="muted">Working out the result...</p>
  if (!summary) return null

  const counts = {
    clean_match: Number(summary.clean_match),
    opened_mismatch: Number(summary.opened_mismatch),
    wrong_location: Number(summary.wrong_location),
    not_in_query: Number(summary.not_in_query),
    not_checked: Number(summary.not_checked),
    scanned: Number(summary.scanned),
  }
  counts.problems = counts.scanned - counts.clean_match
  const pct = accuracy(counts)
  const work = rows.filter((r) => r.bucket !== 'not_checked')
  const later = rows.filter((r) => r.bucket === 'not_checked')

  return (
    <>
      <div className="card">
        <div className="cchead">
          <div>
            <span className="muted small">
              {summary.cancelled_at ? 'Cancelled' : 'Counted'}
            </span>
            <h2 className="mono">{summary.location}</h2>
          </div>
          <div className="muted small">
            {when(summary.started_at)} &rarr;{' '}
            {when(summary.finished_at ?? summary.cancelled_at)}
            <br />
            by {summary.started_by}
          </div>
        </div>

        {pct !== null && (
          <p className="ccaccuracy">
            <strong>{pct.toFixed(1)}%</strong> accuracy &mdash;{' '}
            {nf.format(counts.clean_match)} of {nf.format(counts.scanned)} scanned cases
            were completely right.
          </p>
        )}

        <Counters counts={counts} expected={Number(summary.expected_count)} />

        <div className="ccactions">
          <button type="button" onClick={onNew}>
            Count another location
          </button>
          {/* Every case, not just the problems on screen - the adjustment
              document is built from this. */}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              saveCsv(
                buildResultCsv(summary, raw.scans, raw.notChecked),
                resultFileName(summary)
              )
            }
          >
            Download result (CSV)
          </button>
        </div>
      </div>

      <SessionFollowup summary={summary} counts={counts} onError={onError} />

      <div className="card">
        <h3>
          {work.length === 0
            ? 'Nothing to adjust'
            : `${nf.format(work.length)} case${work.length === 1 ? '' : 's'} to adjust`}
        </h3>
        {work.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Case No</th>
                  <th>Problem</th>
                  <th>Query says</th>
                </tr>
              </thead>
              <tbody>
                {work.map((r) => (
                  <tr key={r.case_no}>
                    <td className="mono ccbreak">{r.case_no}</td>
                    <td>
                      <span className={`pill ${RESULTS[r.bucket].tone}`}>
                        {RESULTS[r.bucket].label}
                      </span>
                    </td>
                    <td className="small">
                      {describeScan({
                        ...r,
                        result: r.bucket === 'opened_mismatch' ? 'match' : r.bucket,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {later.length > 0 && (
        <div className="card">
          <h3>Need check later &mdash; {nf.format(later.length)} cases</h3>
          <p className="muted small">
            Query says these are here but they were never scanned. They are not
            counted in the accuracy above, because they were never handled.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Case No</th>
                </tr>
              </thead>
              <tbody>
                {later.map((r) => (
                  <tr key={r.case_no}>
                    <td className="mono ccbreak">{r.case_no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard: how the counting is going, per person and per day.
//
// Days are grouped in Asia/Jakarta by the cycle_count_daily view, not UTC - a
// count at 06:00 WIB is 23:00 UTC the day BEFORE, so grouping in UTC would
// quietly move early-morning counts into yesterday.
// ---------------------------------------------------------------------------

function pctOf(row) {
  return accuracy({ clean_match: Number(row.clean_match), scanned: Number(row.scanned) })
}

// ---------------------------------------------------------------------------
// The chart: what everyone found, by day.
//
// Hand-drawn SVG rather than a charting library. Recharts is ~100 kB gzipped
// and this page is opened on a phone in the warehouse - the whole cycle count
// chunk is currently 6 kB. One stacked bar chart does not justify that, and a
// dependency here would be the first in the project outside React itself.
//
// Sized with a viewBox so it scales to any width without the text distorting;
// colours come from CSS variables so light and dark both work.
// ---------------------------------------------------------------------------

const SERIES = [
  { key: 'clean_match', label: 'True', fill: 'var(--c-true)' },
  { key: 'opened_mismatch', label: 'Query says opened', fill: 'var(--c-opened)' },
  { key: 'wrong_location', label: 'Wrong location', fill: 'var(--c-wrong)' },
  { key: 'not_in_query', label: 'Not in Query', fill: 'var(--c-missing)' },
]

/** A round number at or above v, so the axis reads 40 rather than 37. */
function niceMax(v) {
  if (!(v > 0)) return 1
  const base = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (v <= m * base) return m * base
  }
  return 10 * base
}

const VB_W = 760
const VB_H = 250
const PAD = { top: 14, right: 10, bottom: 38, left: 42 }
const PLOT_W = VB_W - PAD.left - PAD.right
const PLOT_H = VB_H - PAD.top - PAD.bottom

function DayChart({ days, limit = 21 }) {
  // Oldest on the left, which is how a date axis is read.
  const data = totalsByDay(days).slice(0, limit).reverse()
  if (data.length === 0) return null

  const max = niceMax(Math.max(...data.map((d) => d.scanned), 1))
  const band = PLOT_W / data.length
  const barW = Math.min(band * 0.62, 44)
  const y = (v) => PAD.top + PLOT_H - (v / max) * PLOT_H

  // Four gridlines is enough to read a height against without becoming a grid.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))
  // Thin the date labels rather than letting them collide.
  const every = data.length <= 11 ? 1 : data.length <= 18 ? 2 : 3

  return (
    <>
      <div className="ccchartwrap">
        <svg
          className="ccchart"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label="Cases counted each day, split by result"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left} x2={VB_W - PAD.right}
                y1={y(t)} y2={y(t)}
                stroke="var(--border)" strokeWidth="1"
              />
              <text
                x={PAD.left - 7} y={y(t) + 4}
                textAnchor="end" fontSize="11" fill="var(--muted)"
              >
                {nf.format(t)}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            const x = PAD.left + i * band + (band - barW) / 2
            const pct = pctOf(d)
            let top = 0
            return (
              <g key={d.count_date}>
                <title>
                  {`${d.count_date} — ${nf.format(d.scanned)} counted, ` +
                    `${nf.format(d.clean_match)} true` +
                    (pct === null ? '' : ` (${pct.toFixed(1)}%)`) +
                    `\n${nf.format(d.opened_mismatch)} Query says opened, ` +
                    `${nf.format(d.wrong_location)} wrong location, ` +
                    `${nf.format(d.not_in_query)} not in Query` +
                    `\n${nf.format(d.not_checked)} need check · ` +
                    `${nf.format(d.locations)} location${d.locations === 1 ? '' : 's'} · ` +
                    `${d.admins} admin${d.admins === 1 ? '' : 's'}`}
                </title>
                {SERIES.map((s) => {
                  const v = d[s.key]
                  if (!v) return null
                  const h = (v / max) * PLOT_H
                  const yTop = PAD.top + PLOT_H - top - h
                  top += h
                  return (
                    <rect
                      key={s.key}
                      x={x} y={yTop} width={barW} height={h}
                      fill={s.fill}
                    />
                  )
                })}
                {i % every === 0 && (
                  <text
                    x={x + barW / 2} y={VB_H - PAD.bottom + 16}
                    textAnchor="middle" fontSize="11" fill="var(--muted)"
                  >
                    {String(d.count_date).slice(5)}
                  </text>
                )}
              </g>
            )
          })}

          <line
            x1={PAD.left} x2={VB_W - PAD.right}
            y1={y(0)} y2={y(0)}
            stroke="var(--muted)" strokeWidth="1"
          />
        </svg>
      </div>

      <div className="cclegend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.fill }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
        <span className="muted small">
          Cases scanned per day, all admins together. Need check is not shown -
          those cases were never handled.
        </span>
      </div>
    </>
  )
}

function Pct({ row }) {
  const p = pctOf(row)
  if (p === null) return <span className="muted">&mdash;</span>
  const tone = p >= 90 ? 'ok' : p >= 70 ? 'warn' : 'bad'
  return <span className={`pill ${tone}`}>{p.toFixed(0)}%</span>
}

// ---------------------------------------------------------------------------
// The monthly plan.
//
// "Develop a cycle count plan on a monthly basis" - their own report's
// instruction. Any admin may edit it; in practice one person keeps it.
//
// Whether a planned count HAPPENED is derived from the counts themselves, not
// ticked by hand, so the plan can never claim work that was not done.
// ---------------------------------------------------------------------------

function monthRange(month) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`]
}

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function PlanPage({ onError, onBack }) {
  const [month, setMonth] = useState(thisMonth)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [term, setTerm] = useState('')
  const [matches, setMatches] = useState([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [from, to] = monthRange(month)
      setRows(await planEntries(from, to))
    } catch (err) {
      onError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month, onError])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!term.trim()) { setMatches([]); return }
    let active = true
    const t = setTimeout(() => {
      searchLocations(term, 8)
        .then((r) => active && setMatches(r))
        .catch(() => {})
    }, 200)
    return () => { active = false; clearTimeout(t) }
  }, [term])

  async function add(location) {
    setBusy(true)
    onError(null)
    try {
      await addPlanEntry(date, location)
      setTerm('')
      setMatches([])
      await load()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    setBusy(true)
    try {
      await removePlanEntry(id)
      await load()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const done = rows.filter((r) => r.done).length

  return (
    <>
      <div className="card">
        <div className="cchead">
          <div>
            <h2>Cycle count plan</h2>
            <p className="muted small">
              Plan which location is counted on which day. Whether it happened
              is taken from the counts themselves, never ticked by hand.
            </p>
          </div>
          <button type="button" className="ghost" onClick={onBack}>
            Back
          </button>
        </div>

        <div className="ccplanadd">
          <label>
            <span className="muted small">Month</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label>
            <span className="muted small">Plan date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="grow">
            <span className="muted small">Add a location</span>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search - LHS-PP01-401"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </label>
        </div>

        {matches.length > 0 && (
          <ul className="loclist">
            {matches.map((m) => (
              <li key={m.location}>
                <button
                  type="button"
                  className="locbtn"
                  onClick={() => add(m.location)}
                  disabled={busy}
                >
                  <span className="mono">{m.location}</span>
                  <span className="muted small">
                    {nf.format(m.cases)} case{m.cases === 1 ? '' : 's'} &middot; add to {date}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3>
          {loading
            ? 'Loading...'
            : `${nf.format(rows.length)} planned, ${nf.format(done)} done`}
        </h3>

        {!loading && rows.length === 0 && (
          <p className="muted small">Nothing planned for this month yet.</p>
        )}

        {rows.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Location</th>
                  <th>Area</th>
                  <th>Done</th>
                  <th>Last counted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.done ? 'ccdone' : undefined}>
                    <td className="mono small">{r.plan_date}</td>
                    <td className="mono">{r.location}</td>
                    <td className="small">{r.area || '—'}</td>
                    <td>
                      {r.done ? (
                        <span className="pill ok">Done</span>
                      ) : (
                        <span className="pill muted">Not yet</span>
                      )}
                    </td>
                    <td className="small">
                      {r.last_counted_at
                        ? `${when(r.last_counted_at)} · ${r.last_counted_by}`
                        : '—'}
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => remove(r.id)}
                        disabled={busy}
                        aria-label={`Remove ${r.location}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function Dashboard({ onError, onStart, onPlan }) {
  const [days, setDays] = useState([])
  const [admins, setAdmins] = useState([])
  const [areas, setAreas] = useState([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState(0)

  // Every case from every count by every admin. Paged, so it can take a
  // moment - the row count is shown rather than a spinner that says nothing.
  async function downloadAll() {
    setDownloading(1)
    try {
      const rows = await allCountRows((n) => setDownloading(n))
      if (rows.length === 0) {
        onError('There are no finished counts to export yet.')
        return
      }
      saveCsv(buildAllCsv(rows), allFileName())
    } catch (err) {
      onError(err.message)
    } finally {
      setDownloading(0)
    }
  }

  useEffect(() => {
    let active = true
    Promise.all([dailyStats(), adminStats(), areaStats()])
      .then(([d, a, ar]) => {
        if (!active) return
        setDays(d)
        setAdmins(a)
        setAreas(groupByArea(ar.counted, ar.sizes))
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        onError(err.message)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onError])

  if (loading) return <p className="muted">Loading the dashboard...</p>

  // Nothing counted yet: still offer the way in, or the page is a dead end.
  if (days.length === 0 && admins.length === 0) {
    return (
      <div className="card">
        <h2>Cycle count</h2>
        <p className="muted small">
          No counts yet. Pick a location and scan the cases on it; Query is
          compared against what you find.
        </p>
        <div className="ccactions">
          <button type="button" onClick={onStart}>
            Start a cycle count
          </button>
          <button type="button" className="ghost" onClick={onPlan}>
            Plan
          </button>
        </div>
      </div>
    )
  }

  const total = admins.reduce(
    (t, a) => ({
      clean_match: t.clean_match + Number(a.clean_match),
      scanned: t.scanned + Number(a.scanned),
      not_checked: t.not_checked + Number(a.not_checked),
      locations: t.locations + Number(a.locations),
    }),
    { clean_match: 0, scanned: 0, not_checked: 0, locations: 0 }
  )
  const overall = accuracy(total)

  return (
    <div className="card">
      <div className="cchead">
        <div>
          <h2>Cycle count</h2>
          <p className="muted small">Finished counts only.</p>
        </div>
        {overall !== null && (
          <p className="ccaccuracy">
            <strong>{overall.toFixed(1)}%</strong>
            <br />
            <span className="muted small">
              overall &mdash; {nf.format(total.clean_match)} of{' '}
              {nf.format(total.scanned)} cases
            </span>
          </p>
        )}
      </div>

      <div className="ccactions">
        <button type="button" onClick={onStart}>
          Start a cycle count
        </button>
        <button type="button" className="ghost" onClick={onPlan}>
          Plan
        </button>
        <button
          type="button"
          className="ghost"
          onClick={downloadAll}
          disabled={downloading > 0}
          title="Every case from every count, including the ones that still need checking"
        >
          {downloading > 0
            ? `Collecting ${nf.format(downloading)} rows...`
            : 'Download all counts (CSV)'}
        </button>
      </div>

      {areas.length > 0 && (
        <>
          <h3>By area</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th className="num">Counts</th>
                  <th className="num">Locations</th>
                  <th className="num">Cases</th>
                  <th className="num">True</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Need check</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.label} className={a.scanned === 0 ? 'ccquiet' : undefined}>
                    <td>
                      <strong>{a.label}</strong>
                    </td>
                    <td className="num">{nf.format(a.sessions)}</td>
                    {/* How much of the area has been touched. A bare "42
                        locations" says nothing until you know the area has
                        1,562 of them. */}
                    <td className="num">
                      {nf.format(a.locations)}
                      <span className="muted small"> / {nf.format(a.totalLocations)}</span>
                    </td>
                    <td className="num">{nf.format(a.scanned)}</td>
                    <td className="num">{nf.format(a.clean_match)}</td>
                    <td className="num">
                      {a.scanned === 0 ? <span className="muted">—</span> : <Pct row={a} />}
                    </td>
                    <td className="num">{nf.format(a.not_checked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <DayChart days={days} />

      {admins.length > 0 && (
        <>
          <h3>By admin</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Admin</th>
                  <th className="num">Counts</th>
                  <th className="num">Locations</th>
                  <th className="num">Cases</th>
                  <th className="num">True</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Need check</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.started_by_uid ?? a.started_by}>
                    <td>{a.started_by}</td>
                    <td className="num">{nf.format(a.sessions)}</td>
                    <td className="num">{nf.format(a.locations)}</td>
                    <td className="num">{nf.format(a.scanned)}</td>
                    <td className="num">{nf.format(a.clean_match)}</td>
                    <td className="num">
                      <Pct row={a} />
                    </td>
                    <td className="num">{nf.format(a.not_checked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {days.length > 0 && (
        <>
          <h3>By day</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Admin</th>
                  <th className="num">Locations</th>
                  <th className="num">Cases</th>
                  <th className="num">True</th>
                  <th className="num">Opened</th>
                  <th className="num">Wrong loc</th>
                  <th className="num">Not in Query</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Need check</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={`${d.count_date}-${d.started_by}`}>
                    <td className="mono small">{d.count_date}</td>
                    <td className="small">{d.started_by}</td>
                    <td className="num">{nf.format(d.locations)}</td>
                    <td className="num">{nf.format(d.scanned)}</td>
                    <td className="num">{nf.format(d.clean_match)}</td>
                    <td className="num">{nf.format(d.opened_mismatch)}</td>
                    <td className="num">{nf.format(d.wrong_location)}</td>
                    <td className="num">{nf.format(d.not_in_query)}</td>
                    <td className="num">
                      <Pct row={d} />
                    </td>
                    <td className="num">{nf.format(d.not_checked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ccactions">
            <button
              type="button"
              className="ghost"
              onClick={() => saveCsv(buildDailyCsv(days, accuracy), dailyFileName())}
            >
              Download statistics (CSV)
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function RecentSessions() {
  const [rows, setRows] = useState([])

  useEffect(() => {
    let active = true
    recentSessions(10)
      .then((r) => active && setRows(r))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  if (rows.length === 0) return null

  return (
    <div className="card">
      <h3>Recent counts</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>By</th>
              <th>When</th>
              <th className="num">True</th>
              <th className="num">Scanned</th>
              <th className="num">Accuracy</th>
              <th className="num">Need check</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const pct = accuracy({
                clean_match: Number(s.clean_match),
                scanned: Number(s.scanned),
              })
              return (
                <tr key={s.id}>
                  <td className="mono">{s.location}</td>
                  <td className="small">{s.started_by}</td>
                  <td className="small">{when(s.started_at)}</td>
                  <td className="num">{nf.format(s.clean_match)}</td>
                  <td className="num">{nf.format(s.scanned)}</td>
                  <td className="num">{pct === null ? '—' : `${pct.toFixed(0)}%`}</td>
                  <td className="num">{nf.format(s.not_checked)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function CycleCountPage() {
  const [session, setSession] = useState(null)
  const [doneId, setDoneId] = useState(null)
  const [error, setError] = useState(null)
  const [checking, setChecking] = useState(true)
  // The dashboard is the landing screen; null means show it. 'pick' opens the
  // location list, 'plan' the monthly plan.
  const [picking, setPicking] = useState(null)

  const fail = useCallback((msg) => setError(msg), [])

  // A count can outlive the tab - the phone locks, the browser is closed. Pick
  // THIS admin's unfinished session back up rather than stranding it, and
  // never someone else's.
  useEffect(() => {
    let active = true
    openSession()
      .then((s) => {
        if (!active) return
        if (s) setSession({ ...s, expected_count: Number(s.expected_count) })
        setChecking(false)
      })
      .catch(() => active && setChecking(false))
    return () => {
      active = false
    }
  }, [])

  function reset() {
    setSession(null)
    setDoneId(null)
    setError(null)
    setPicking(null)
  }

  return (
    <div className="admin">
      {error && <div className="error">{error}</div>}

      {checking ? (
        <p className="muted">Checking for an unfinished count...</p>
      ) : doneId ? (
        <DoneScreen sessionId={doneId} onNew={reset} onError={fail} />
      ) : session ? (
        <ScanScreen
          session={session}
          onFinished={(id) => {
            setSession(null)
            setDoneId(id)
          }}
          onError={fail}
        />
      ) : (
        <>
          {picking === 'pick' ? (
            <LocationPicker
              onStarted={setSession}
              onError={fail}
              onBack={() => setPicking(null)}
            />
          ) : picking === 'plan' ? (
            <PlanPage onError={fail} onBack={() => setPicking(null)} />
          ) : (
            <>
              <Dashboard
                onError={fail}
                onStart={() => setPicking('pick')}
                onPlan={() => setPicking('plan')}
              />
              <RecentSessions />
            </>
          )}
        </>
      )}
    </div>
  )
}
