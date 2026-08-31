import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RESULTS,
  RESULT_ORDER,
  readScan,
  summarise,
  accuracy,
  describeScan,
  reportRows,
} from '../lib/cycleCount'
import {
  searchLocations,
  startSession,
  recordScan,
  finishSession,
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
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(null)

  // Only the newest lookup may paint: typing fires several and they can land
  // out of order, which would show results for a term already deleted.
  const reqRef = useRef(0)

  useEffect(() => {
    const id = ++reqRef.current
    setLoading(true)
    const t = setTimeout(() => {
      searchLocations(term)
        .then((rows) => {
          if (reqRef.current !== id) return
          setLocations(rows)
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

  async function start(location) {
    setStarting(location)
    onError(null)
    try {
      onStarted(await startSession(location))
    } catch (err) {
      onError(err.message)
      setStarting(null)
    }
  }

  return (
    <div className="card">
      <h2>Start a cycle count</h2>
      <p className="muted small">
        One location at a time, full cases only. Opened cases are not included.
      </p>

      <input
        type="text"
        className="ccsearch"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Find a location - LHO-NN24-301"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
      />

      {loading && <p className="muted small">Loading...</p>}

      {!loading && locations.length === 0 && (
        <p className="muted small">No location matches that.</p>
      )}

      <ul className="loclist">
        {locations.map((l) => (
          <li key={l.location}>
            <button
              type="button"
              className="locbtn"
              onClick={() => start(l.location)}
              disabled={starting !== null}
            >
              <span className="mono">{l.location}</span>
              <span className="muted small">
                {starting === l.location
                  ? 'Starting...'
                  : `${nf.format(l.full_cases)} full case${l.full_cases === 1 ? '' : 's'}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function Counters({ counts, expected }) {
  return (
    <div className="ccounts">
      {RESULT_ORDER.map((key) => {
        const n = key === 'not_checked' ? Math.max(0, expected - counts.match) : counts[key]
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
  const [finishing, setFinishing] = useState(false)

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
          if (!row.already_scanned) {
            setScans((prev) => [
              { case_no: row.case_no, result: row.result, system_locations: row.system_locations },
              ...prev,
            ])
          }
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

  async function finish() {
    setFinishing(true)
    onError(null)
    try {
      await finishSession(session.id)
      onFinished(session.id)
    } catch (err) {
      onError(err.message)
      setFinishing(false)
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
            Query expects {nf.format(session.expected_count)} full case
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
          <div className={`ccresult ${RESULTS[last.result].tone}`}>
            <strong>{RESULTS[last.result].label}</strong>
            {last.already_scanned && <em> · already scanned</em>}
            <span className="mono ccresultcase">{last.case_no}</span>
            <span className="small">{describeScan(last)}</span>
          </div>
        )}

        <Counters counts={counts} expected={session.expected_count} />

        <div className="ccactions">
          <button type="button" onClick={finish} disabled={finishing}>
            {finishing ? 'Finishing...' : 'Finish and see the result'}
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
                      <span className={`pill ${RESULTS[s.result].tone}`}>
                        {RESULTS[s.result].label}
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
// The result
// ---------------------------------------------------------------------------

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

  const counts = summarise(
    [
      ...Array(Number(summary.matched)).fill({ result: 'match' }),
      ...Array(Number(summary.wrong_location)).fill({ result: 'wrong_location' }),
      ...Array(Number(summary.not_in_query)).fill({ result: 'not_in_query' }),
    ],
    Number(summary.not_checked)
  )
  const pct = accuracy(counts)

  return (
    <>
      <div className="card">
        <div className="cchead">
          <div>
            <span className="muted small">Counted</span>
            <h2 className="mono">{summary.location}</h2>
          </div>
          <div className="muted small">
            {when(summary.started_at)} &rarr; {when(summary.finished_at)}
            <br />
            by {summary.started_by}
          </div>
        </div>

        {pct !== null && (
          <p className="ccaccuracy">
            <strong>{pct.toFixed(1)}%</strong> of this location was exactly where Query
            said it was.
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
          {rows.length === 0
            ? 'Nothing to fix - everything matched'
            : `${nf.format(rows.length)} thing${rows.length === 1 ? '' : 's'} to look at`}
        </h3>
        {rows.length > 0 && (
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
                {rows.map((r) => (
                  <tr key={`${r.result}-${r.case_no}`}>
                    <td className="mono">{r.case_no}</td>
                    <td>
                      <span className={`pill ${RESULTS[r.result].tone}`}>
                        {RESULTS[r.result].label}
                      </span>
                    </td>
                    <td className="small">
                      {r.result === 'not_checked'
                        ? 'Expected here, never scanned'
                        : describeScan(r)}
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

// ---------------------------------------------------------------------------

function RecentSessions() {
  const [rows, setRows] = useState([])

  useEffect(() => {
    let active = true
    recentSessions(10)
      .then((r) => active && setRows(r.filter((s) => s.finished_at)))
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
              <th>When</th>
              <th className="num">Match</th>
              <th className="num">Wrong loc</th>
              <th className="num">Not in Query</th>
              <th className="num">Need check</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.location}</td>
                <td className="small">{when(s.started_at)}</td>
                <td className="num">{nf.format(s.matched)}</td>
                <td className="num">{nf.format(s.wrong_location)}</td>
                <td className="num">{nf.format(s.not_in_query)}</td>
                <td className="num">{nf.format(s.not_checked)}</td>
              </tr>
            ))}
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
  // an unfinished session back up rather than stranding it.
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
