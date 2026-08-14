import { useEffect, useRef, useState } from 'react'
import { parseInventoryFiles, parseMasterDataFiles } from '../lib/parse'
import { replaceTable, INVENTORY_TARGET, MASTER_TARGET } from '../lib/upload'
import {
  notifyDataUpdated,
  useLastUpdate,
  formatWhen,
  relativeTime,
} from '../lib/useLastUpdate'

const nf = new Intl.NumberFormat()

const PHASE_LABEL = {
  reading: 'Reading files...',
  parsing: 'Reading files...',
  clearing: 'Preparing database...',
  uploading: 'Uploading to database...',
  swapping: 'Verifying and switching over...',
  done: 'Done',
}

// Which step of the whole operation each phase belongs to, for "Step 2 of 3".
const PHASE_STEP = { reading: 1, parsing: 1, clearing: 2, uploading: 2, swapping: 3, done: 3 }

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

function UploadCard({ config }) {
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
      setError(err.message ?? String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function doUpload() {
    if (!parsed) return
    setBusy(true)
    setError(null)
    setResult(null)
    cancelRef.current = false

    const startedAt = Date.now()
    try {
      const moved = await replaceTable({
        ...config.target,
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
          <h2>{config.title}</h2>
          <p className="muted small">{config.subtitle}</p>
        </div>
        <CardLastUpdate table={config.logTable} />
      </header>

      <p className="hint">{config.hint}</p>

      <input
        ref={inputRef}
        type="file"
        accept={config.accept}
        multiple={config.multiple}
        onChange={onPick}
        disabled={busy}
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
          <strong>Upload failed.</strong> {error}
        </div>
      )}

      {result !== null && (
        <div className="success">
          <strong>Update complete.</strong>{' '}
          {nf.format(result.rows)} rows are now live
          {result.files > 1 && ` from ${nf.format(result.files)} files`}, replaced in{' '}
          {formatDuration(result.seconds)}.
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
            <button type="button" onClick={doUpload} disabled={busy}>
              Replace all {config.replaceLabel} ({nf.format(parsed.rows.length)} rows)
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

export default function AdminPage() {
  return (
    <div className="admin">
      <p className="muted small lead">
        Uploads are safe to retry. Rows are staged first and only swapped in
        once every row has arrived and the count matches, so a failed or
        cancelled upload leaves the live data untouched.
      </p>
      {UPLOADS.map((u) => (
        <UploadCard key={u.id} config={u} />
      ))}
    </div>
  )
}