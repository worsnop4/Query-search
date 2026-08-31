import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { parseInventoryFiles, parseMasterDataFiles } from '../lib/parse'
import { replaceTable, INVENTORY_TARGET, MASTER_TARGET } from '../lib/upload'
import {
  notifyDataUpdated,
  useLastUpdate,
  formatWhen,
  relativeTime,
} from '../lib/useLastUpdate'
import { useAdminPresence, listNames } from '../lib/useAdminPresence'
import { exportInventoryCsv, exportFileName, saveBlob } from '../lib/export'
import { buildUpdateMessage, whatsappUrl } from '../lib/notify'
import { writeClipboard } from '../lib/clipboard'
import { useAuth } from '../lib/AuthContext'

const nf = new Intl.NumberFormat()

const PHASE_LABEL = {
  claiming: 'Reserving the upload...',
  reading: 'Reading files...',
  parsing: 'Reading files...',
  clearing: 'Preparing database...',
  uploading: 'Uploading to database...',
  swapping: 'Verifying and switching over...',
  downloading: 'Downloading rows...',
  compressing: 'Compressing...',
  done: 'Done',
}

// Which step of the whole operation each phase belongs to, for "Step 2 of 3".
const PHASE_STEP = {
  reading: 1, parsing: 1,
  claiming: 2, clearing: 2, uploading: 2,
  swapping: 3, done: 3,
}

function formatDuration(secs) {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

const UPLOADS = [
  {
    id: 'inventory',
    logTable: 'inventory',
    title: 'Query',
    replaceLabel: 'Query data',
    notifyLabel: 'Query',
    subtitle: 'The daily stock export from the WMS',
    accept: '.xls,.xlsm,.xlsx',
    multiple: true,
    hint: 'Select ALL the raw files the WMS gave you at once - the whole folder, around 39 files. No merging, no macro, no template. A single merged file works too.',
    parse: parseInventoryFiles,
    target: INVENTORY_TARGET,
    affects: 'Replaces all query rows. Master data is not touched.',
  },
  {
    id: 'master',
    logTable: 'master_data',
    title: 'Master Data (PFEP)',
    replaceLabel: 'Master Data',
    notifyLabel: 'Master Data',
    subtitle: 'Part names, car type and DLOC',
    accept: '.xlsb,.xlsx,.xls',
    multiple: true,
    hint: 'Upload the PFEP Simple Master Data file. Only Part Number, Part Name, Car Type and NEW DLOC are imported.',
    parse: parseMasterDataFiles,
    target: MASTER_TARGET,
    affects: 'Replaces all master data. Query data is not touched.',
  },
]

function CardLastUpdate({ table }) {
  const { info } = useLastUpdate(table)
  if (!info) return null
  return (
    <div className="cardmeta">
      <span className="muted small">Currently loaded</span>
      <strong className="small">{nf.format(info.row_count)} rows</strong>
      <span className="muted small">
        {formatWhen(info.uploaded_at)} &middot; {relativeTime(info.uploaded_at)}
      </span>
      {info.uploaded_email && (
        <span className="muted small">by {info.uploaded_email}</span>
      )}
    </div>
  )
}

// Shown after a successful upload. WhatsApp cannot be pointed at a group from
// a link - see the note in lib/notify.js - so this writes the message and the
// admin chooses the group. Copy is offered alongside for anyone not using
// WhatsApp Web, or who wants to paste it somewhere else entirely.
function NotifyTeam({ config, result, who }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(null)

  const message = buildUpdateMessage({ label: config.notifyLabel, who })

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    setCopyError(null)
    try {
      await writeClipboard(message)
      setCopied(true)
    } catch (err) {
      setCopyError(err.message ?? String(err))
    }
  }

  return (
    <div className="notify">
      <div className="notifyactions">
        <a
          className="btn wa"
          href={whatsappUrl(message)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Notify group on WhatsApp
        </a>
        <button type="button" className="ghost small" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy message'}
        </button>
      </div>

      <details className="notifypreview">
        <summary>What will be sent</summary>
        <pre>{message}</pre>
      </details>

      <p className="muted small">
        WhatsApp Web opens with this ready — pick the group and press send. A
        link cannot choose the group for you.
      </p>

      {copyError && <span className="muted small">{copyError}</span>}
    </div>
  )
}

function UploadCard({ config, sessionId, uploader, onFinished, who }) {
  const [files, setFiles] = useState([])
  const [parsed, setParsed] = useState(null)
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const [elapsed, setElapsed] = useState(0)

  const cancelRef = useRef(false)
  const inputRef = useRef(null)

  // A running clock, so a long upload visibly moves even while a single
  // chunk is in flight.
  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  // Closing the tab mid-upload is safe for the data, but the admin loses all
  // their progress and has to start again. Warn them.
  useEffect(() => {
    if (!busy) return
    const warn = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  function reset() {
    setFiles([])
    setParsed(null)
    setProgress(null)
    setError(null)
    setResult(null)
    cancelRef.current = false
    if (inputRef.current) inputRef.current.value = ''
  }

  async function onPick(e) {
    // Snapshot into a real array BEFORE reset(). e.target.files is a *live*
    // FileList bound to the input, so reset() clearing input.value empties it
    // too - which silently left us with zero files and nothing happening.
    const picked = Array.from(e.target.files ?? [])
    reset()
    if (picked.length === 0) return

    setFiles(picked)
    // Reset the clock here, not only in the effect below: the effect runs
    // after paint, so the first frame would otherwise still show the previous
    // phase's duration.
    setElapsed(0)
    setBusy(true)
    // Show something immediately: reading the first file can take seconds
    // before the parser reports any progress of its own.
    setProgress({
      phase: 'reading',
      done: 0,
      total: picked.length,
      fileCount: picked.length,
      fileIndex: 1,
      fileName: picked[0]?.name,
    })

    try {
      const out = await config.parse(picked, setProgress)
      setParsed(out)
    } catch (err) {
      // Nothing has been sent anywhere at this point - say so, rather than
      // reporting a failed upload the admin then has to go and check.
      setError({
        title: 'Could not read that file.',
        message: err.message ?? String(err),
      })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function doUpload() {
    if (!parsed) return
    setElapsed(0)
    setBusy(true)
    setError(null)
    setResult(null)
    cancelRef.current = false

    const startedAt = Date.now()
    try {
      const moved = await replaceTable({
        ...config.target,
        sessionId,
        rows: parsed.rows,
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current,
      })
      setResult({
        rows: moved,
        files: parsed.fileCount ?? 1,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      })
      setParsed(null)
      setFiles([])
      if (inputRef.current) inputRef.current.value = ''
      notifyDataUpdated() // refresh the "Last update" in the header
    } catch (err) {
      setError({ title: 'Upload failed.', message: err.message ?? String(err) })
    } finally {
      setBusy(false)
      setProgress(null)
      // Whether it worked or not, the claim has moved - let the other cards
      // and the roster catch up without waiting for the next poll.
      onFinished?.()
    }
  }

  // Another admin holds this table. The server would refuse anyway; blocking
  // here just saves them parsing a 195k-row file only to be turned away.
  const lockedBy = uploader?.display_name ?? null

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null

  return (
    <section className="card">
      <header className="cardhead">
        <div>
          <h2>{config.title}</h2>
          <p className="muted small">{config.subtitle}</p>
        </div>
        <CardLastUpdate table={config.logTable} />
      </header>

      <p className="hint">{config.hint}</p>

      {lockedBy && (
        <div className="locked">
          <strong>{lockedBy} is updating {config.title} right now.</strong>{' '}
          This card unlocks by itself the moment they finish
          {uploader.started_at && ` (started ${relativeTime(uploader.started_at)})`}.
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={config.accept}
        multiple={config.multiple}
        onChange={onPick}
        disabled={busy || !!lockedBy}
      />

      {files.length > 1 && !parsed && !error && (
        <p className="muted small">{nf.format(files.length)} files selected</p>
      )}

      {progress && (
        <div className="progress">
          <div className="progresshead">
            <span>
              <span className="step">
                Step {PHASE_STEP[progress.phase] ?? 1} of 3
              </span>
              {PHASE_LABEL[progress.phase] ?? progress.phase}
            </span>
            <span className="mono">
              {progress.total > 0 && (
                <>
                  {nf.format(progress.done)} / {nf.format(progress.total)}
                  {pct !== null && ` (${pct}%)`}
                </>
              )}
              {elapsed > 0 && (
                <span className="muted"> &nbsp;{formatDuration(elapsed)}</span>
              )}
            </span>
          </div>

          <div className="bar">
            <div
              className={`fill${pct === null ? ' indeterminate' : ''}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>

          <p className="muted small progressnote">
            {progress.fileCount > 1 && PHASE_STEP[progress.phase] === 1 ? (
              <>
                File {nf.format(progress.fileIndex ?? progress.done + 1)} of{' '}
                {nf.format(progress.fileCount)}
                {progress.rowsSoFar > 0 &&
                  ` · ${nf.format(progress.rowsSoFar)} rows so far`}
                {progress.fileName && (
                  <>
                    {' '}
                    · <span className="mono">{progress.fileName}</span>
                  </>
                )}
              </>
            ) : progress.phase === 'uploading' ? (
              'Sending rows in batches of 2,000. Keep this tab open.'
            ) : progress.phase === 'swapping' ? (
              'Checking the row count, then switching the live data over in one step.'
            ) : (
              'Working...'
            )}
          </p>

          {progress.phase === 'uploading' && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                cancelRef.current = true
              }}
            >
              Cancel upload
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="error">
          <strong>{error.title}</strong> {error.message}
        </div>
      )}

      {result !== null && (
        <div className="success">
          <strong>Update complete.</strong>{' '}
          {nf.format(result.rows)} rows are now live
          {result.files > 1 && ` from ${nf.format(result.files)} files`}, replaced in{' '}
          {formatDuration(result.seconds)}.
          <NotifyTeam config={config} result={result} who={who} />
        </div>
      )}

      {parsed && !busy && (
        <div className="preview">
          <div className="previewgrid">
            {parsed.fileCount > 1 ? (
              <>
                <span>Files</span>
                <strong>{nf.format(parsed.fileCount)} files combined</strong>
              </>
            ) : (
              <>
                <span>File</span>
                <strong className="mono">{files[0]?.name}</strong>

                <span>Sheet</span>
                <strong className="mono">{parsed.sheetName}</strong>
              </>
            )}

            <span>Header row</span>
            <strong>{parsed.headerRow}</strong>

            <span>Rows to import</span>
            <strong>{nf.format(parsed.rows.length)}</strong>

            {parsed.duplicates > 0 && (
              <>
                <span>Duplicates merged</span>
                <strong>{nf.format(parsed.duplicates)}</strong>
              </>
            )}

            {parsed.skipped > 0 && (
              <>
                <span>Blank rows skipped</span>
                <strong>{nf.format(parsed.skipped)}</strong>
              </>
            )}
          </div>

          {parsed.fileCount > 1 && (
            <details className="filelist">
              <summary>
                Rows per file ({nf.format(parsed.perFile.length)} files)
              </summary>
              <div className="tablewrap tight">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th className="num">Rows</th>
                      <th className="num">Header row</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.perFile.map((f) => (
                      <tr key={f.name}>
                        <td className="mono ellipsis" title={f.name}>
                          {f.name}
                        </td>
                        <td className="num">{nf.format(f.rows)}</td>
                        <td className="num">{f.headerRow}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {parsed.missingOptional?.length > 0 && (
            <div className="warn">
              <strong>Not found in this file:</strong>{' '}
              {parsed.missingOptional.join(', ')}. These will be stored empty.
            </div>
          )}

          <div className="tablewrap tight">
            <table>
              <thead>
                <tr>
                  {Object.keys(parsed.rows[0] ?? {}).map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 3).map((r, i) => (
                  <tr key={i}>
                    {Object.keys(parsed.rows[0]).map((k) => (
                      <td key={k} className="mono">
                        {r[k] === null ? (
                          <span className="muted">null</span>
                        ) : (
                          String(r[k])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Check the first rows line up with the column names above before
            replacing.
          </p>

          <div className="danger">{config.affects}</div>

          <div className="buttons">
            <button type="button" onClick={doUpload} disabled={busy || !!lockedBy}>
              {lockedBy
                ? `Locked - ${lockedBy} is updating this`
                : `Replace all ${config.replaceLabel} (${nf.format(parsed.rows.length)} rows)`}
            </button>
            <button type="button" className="ghost" onClick={reset} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Roster({ others }) {
  if (others.length === 0) {
    return <p className="muted small">You are the only admin on this page.</p>
  }

  return (
    <div className="roster">
      <span className="muted small">Also here</span>
      {others.map((a) => (
        <span
          key={a.session_id}
          className={`chip${a.status === 'uploading' ? ' busy' : ''}`}
          title={a.status === 'uploading' ? `Updating ${a.target}` : 'Viewing'}
        >
          {a.display_name}
        </span>
      ))}
      <span className="muted small">
        {others.some((a) => a.status === 'uploading')
          ? `${listNames(others.filter((a) => a.status === 'uploading'))} updating`
          : 'viewing only'}
      </span>
    </div>
  )
}

function DownloadCard({ blockedBy }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const cancelRef = useRef(false)

  async function run() {
    setBusy(true)
    setError(null)
    setResult(null)
    cancelRef.current = false

    const startedAt = Date.now()
    try {
      const { blob, rows, changed, csvBytes, zipBytes } = await exportInventoryCsv({
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current,
      })
      const name = exportFileName()
      saveBlob(blob, name)
      setResult({
        rows,
        name,
        mb: blob.size / 1048576,
        csvMb: csvBytes / 1048576,
        savedPct: csvBytes > 0 ? 100 - (100 * zipBytes) / csvBytes : 0,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        changed,
      })
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null

  return (
    <section className="card">
      <header className="cardhead">
        <div>
          <h2>Download Query data</h2>
          <p className="muted small">Every inventory row as one zipped CSV</p>
        </div>
        <CardLastUpdate table="inventory" />
      </header>

      <p className="hint">
        The ten columns exactly as they came from the WMS &mdash; no part names,
        and none of the columns the database computes during an upload.
      </p>

      {blockedBy && (
        <div className="locked">
          <strong>{blockedBy} is updating Query right now.</strong> Downloading
          during an upload would produce a file with rows repeated and rows
          missing, so this waits until they finish.
        </div>
      )}

      {progress && (
        <div className="progress">
          <div className="progresshead">
            <span>Downloading...</span>
            <span className="mono">
              {nf.format(progress.done)} / {nf.format(progress.total)}
              {pct !== null && ` (${pct}%)`}
            </span>
          </div>
          <div className="bar">
            <div
              className={`fill${pct === null ? ' indeterminate' : ''}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="muted small progressnote">
            The database returns at most 1,000 rows per request, so this takes
            about 195 of them. Keep this tab open.
          </p>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              cancelRef.current = true
            }}
          >
            Cancel download
          </button>
        </div>
      )}

      {error && (
        <div className="error">
          <strong>Download failed.</strong> {error}
        </div>
      )}

      {result && (
        <>
          <div className="success">
            <strong>Saved {result.name}.</strong>{' '}
            {nf.format(result.rows)} rows, <strong>{result.mb.toFixed(1)} MB</strong>{' '}
            zipped from {result.csvMb.toFixed(1)} MB &mdash;{' '}
            {result.savedPct.toFixed(0)}% smaller &mdash; in{' '}
            {formatDuration(result.seconds)}.
            <p className="muted small">
              Double-click the .zip to open it; the CSV is inside. Windows
              handles .zip on its own, no extra program needed.
            </p>
          </div>
          {result.changed && (
            <div className="warn">
              <strong>The table changed while this was downloading.</strong> An
              upload finished mid-export, so this file may repeat some rows and
              miss others. Download it again.
            </div>
          )}
        </>
      )}

      <div className="buttons">
        <button type="button" onClick={run} disabled={busy || !!blockedBy}>
          {busy
            ? 'Downloading...'
            : blockedBy
              ? `Locked - ${blockedBy} is updating this`
              : 'Download all Query data (zipped CSV)'}
        </button>
      </div>

      <p className="muted small">
        The file is a .zip about a tenth the size of the CSV inside it.
        Double-click to open it &mdash; Windows reads .zip without any extra
        program. Note that opening the CSV by double-clicking can make Excel
        turn long part numbers into scientific notation; Data &rarr; From
        Text/CSV, with the part number column set to Text, avoids that.
      </p>
    </section>
  )
}

export default function AdminPage() {
  const { sessionId, others, uploaderOf, refresh } = useAdminPresence(true)
  const { session } = useAuth()

  // Just for the notification text, so it reads "by dian.ayu" rather than
  // anonymously. Same local-part rule the database uses for presence names -
  // this one is cosmetic, so deriving it here is fine.
  const who = session?.user?.email?.split('@')[0] ?? null

  return (
    <div className="admin">
      <p className="muted small lead">
        Uploads are safe to retry. Rows are staged first and only swapped in
        once every row has arrived and the count matches, so a failed or
        cancelled upload leaves the live data untouched.
      </p>

      <Roster others={others} />

      {UPLOADS.map((u) => (
        <UploadCard
          key={u.id}
          config={u}
          sessionId={sessionId}
          uploader={uploaderOf(u.logTable)}
          onFinished={refresh}
          who={who}
        />
      ))}

      <DownloadCard blockedBy={uploaderOf('inventory')?.display_name ?? null} />

      <CycleCountCard />
    </div>
  )
}

// The only way into the cycle count. Deliberately not in the top bar: the
// search page is public and belongs to the operation team, and counting is an
// admin job.
function CycleCountCard() {
  return (
    <div className="card">
      <h2>Cycle count</h2>
      <p className="muted small">
        Scan one location and compare it against Query. Two admins can count
        different locations at the same time; a location being counted is
        locked until that count is finished.
      </p>
      <div className="ccactions">
        <Link className="btn" to="/cycle-count">
          Open cycle count
        </Link>
      </div>
    </div>
  )
}