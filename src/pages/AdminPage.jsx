import { useRef, useState } from 'react'
import { parseInventory, parseMasterData } from '../lib/parse'
import { replaceTable, INVENTORY_TARGET, MASTER_TARGET } from '../lib/upload'
import {
  notifyDataUpdated,
  useLastUpdate,
  formatWhen,
  relativeTime,
} from '../lib/useLastUpdate'

const nf = new Intl.NumberFormat()

const PHASE_LABEL = {
  reading: 'Reading file...',
  parsing: 'Parsing rows...',
  clearing: 'Preparing...',
  uploading: 'Uploading...',
  swapping: 'Verifying and swapping...',
  done: 'Done',
}

const UPLOADS = [
  {
    id: 'inventory',
    logTable: 'inventory',
    title: 'Query',
    replaceLabel: 'Query data',
    subtitle: 'The daily stock export from the WMS',
    accept: '.xlsm,.xlsx,.xls',
    hint: 'Upload the file exactly as it comes out of the WMS. No need to clean it up or paste it into a template.',
    parse: parseInventory,
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
    hint: 'Upload the PFEP Simple Master Data file. Only Part Number, Part Name, Car Type and NEW DLOC are imported.',
    parse: parseMasterData,
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
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const cancelRef = useRef(false)
  const inputRef = useRef(null)

  function reset() {
    setFile(null)
    setParsed(null)
    setProgress(null)
    setError(null)
    setResult(null)
    cancelRef.current = false
    if (inputRef.current) inputRef.current.value = ''
  }

  async function onPick(e) {
    const f = e.target.files?.[0]
    reset()
    if (!f) return
    setFile(f)
    setBusy(true)

    try {
      const out = await config.parse(f, setProgress)
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

    try {
      const moved = await replaceTable({
        ...config.target,
        rows: parsed.rows,
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current,
      })
      setResult(moved)
      setParsed(null)
      setFile(null)
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
        onChange={onPick}
        disabled={busy}
      />

      {progress && (
        <div className="progress">
          <div className="progresshead">
            <span>{PHASE_LABEL[progress.phase] ?? progress.phase}</span>
            {progress.total > 0 && (
              <span className="mono">
                {nf.format(progress.done)} / {nf.format(progress.total)}
                {pct !== null && ` (${pct}%)`}
              </span>
            )}
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${pct ?? 0}%` }} />
          </div>
          {progress.phase === 'uploading' && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                cancelRef.current = true
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {result !== null && (
        <div className="success">
          Replaced successfully &mdash; <strong>{nf.format(result)}</strong> rows are
          now live.
        </div>
      )}

      {parsed && !busy && (
        <div className="preview">
          <div className="previewgrid">
            <span>File</span>
            <strong className="mono">{file?.name}</strong>

            <span>Sheet</span>
            <strong className="mono">{parsed.sheetName}</strong>

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