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
} from '../lib/cycleCountData'

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

function LocationPicker({ onStarted, onError }) {
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
      <h2>Start a cycle count</h2>
      <p className="muted small">
        One location at a time. Every case Query has there is included, opened
        or not - a case found full while Query says it was opened is exactly
        what this is for.
      </p>

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
// The follow-up on one discrepancy: reason, action, done.
// Mirrors the Historic / DO / Status columns of the workbook.
// ---------------------------------------------------------------------------

function FollowupRow({ row, onError }) {
  const [reason, setReason] = useState(row.reason)
  const [action, setAction] = useState(row.action || suggestedAction(row.bucket))
  const [done, setDone] = useState(row.done)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = useCallback(
    async (next) => {
      if (row.id == null) return
      setSaving(true)
      try {
        await saveFollowup(row.id, { reason, action, done, ...next })
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      } catch (err) {
        onError(err.message)
      } finally {
        setSaving(false)
      }
    },
    [row.id, reason, action, done, onError]
  )

  return (
    <tr className={done ? 'ccdone' : undefined}>
      <td className="mono ccbreak">{row.case_no}</td>
      <td>
        <span className={`pill ${RESULTS[row.bucket].tone}`}>{RESULTS[row.bucket].label}</span>
      </td>
      <td className="small">
        {row.bucket === 'not_checked'
          ? 'Expected here, never scanned'
          : describeScan({ ...row, result: row.bucket === 'opened_mismatch' ? 'match' : row.bucket })}
      </td>
      {row.id == null ? (
        // A case nobody scanned has no scan row to attach a decision to. It is
        // a list to go and look at, not work that can be recorded yet.
        <td colSpan={3} className="muted small">
          Check this case later
        </td>
      ) : (
        <>
          <td>
            <input
              type="text"
              className="ccreason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => save({})}
              placeholder="Reason"
              spellCheck={false}
            />
          </td>
          <td>
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
          </td>
          <td className="num">
            <input
              type="checkbox"
              checked={done}
              onChange={(e) => {
                setDone(e.target.checked)
                save({ done: e.target.checked })
              }}
              aria-label="Done"
            />
            {saving && <span className="muted small"> ...</span>}
            {saved && <span className="ok small"> ok</span>}
          </td>
        </>
      )}
    </tr>
  )
}

function DoneScreen({ sessionId, onNew, onError }) {
  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState([])
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
        </div>
      </div>

      <div className="card">
        <h3>
          {work.length === 0
            ? 'Nothing to adjust'
            : `${nf.format(work.length)} adjustment${work.length === 1 ? '' : 's'} to make`}
        </h3>
        {work.length > 0 && (
          <div className="tablewrap">
            <table className="ccwork">
              <thead>
                <tr>
                  <th>Case No</th>
                  <th>Problem</th>
                  <th>Query says</th>
                  <th>Reason</th>
                  <th>Action</th>
                  <th className="num">Done</th>
                </tr>
              </thead>
              <tbody>
                {work.map((r) => (
                  <FollowupRow key={r.id ?? r.case_no} row={r} onError={onError} />
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
          <LocationPicker onStarted={setSession} onError={fail} />
          <RecentSessions />
        </>
      )}
    </div>
  )
}
