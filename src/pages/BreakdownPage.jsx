import { useCallback, useState } from 'react'
import { zip } from 'fflate'
import {
  DEFAULTS,
  LOC_COLUMNS,
  OW_COLUMNS,
  NONSAIC_COLUMNS,
  minimalStock,
  dayQty,
  totalsFor,
  stockRows,
  writeBreakdownXlsx,
  breakdownFileName,
} from '../lib/breakdown'
import { fetchBreakdown } from '../lib/breakdownData'
import { saveBlob } from '../lib/download'
import { useLastUpdate, formatWhen, relativeTime } from '../lib/useLastUpdate'

const nf = new Intl.NumberFormat()

/** fflate's zip() is callback-based; wrap it so it can be awaited. */
function zipOne(name, bytes) {
  return new Promise((resolve, reject) => {
    zip({ [name]: bytes }, { level: 6 }, (err, out) =>
      err ? reject(new Error(`Could not compress the file: ${err.message}`)) : resolve(out)
    )
  })
}

export default function BreakdownPage() {
  const [opts, setOpts] = useState(DEFAULTS)
  const [rows, setRows] = useState(null)
  const [phase, setPhase] = useState(null) // loading | building | zipping
  const [loaded, setLoaded] = useState(0)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const { info: lastUpdate } = useLastUpdate('inventory')

  const set = (k) => (e) => {
    const v = e.target.value
    setOpts((o) => ({ ...o, [k]: v === '' ? '' : Number(v) }))
    // The thresholds change what the file says, so a previous run's numbers
    // must not stay on screen looking current.
    setResult(null)
  }

  const load = useCallback(async () => {
    setPhase('loading')
    setError(null)
    setLoaded(0)
    try {
      const data = await fetchBreakdown(setLoaded)
      setRows(data)
      return data
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setPhase(null)
    }
  }, [])

  async function download() {
    setError(null)
    setResult(null)
    const data = rows ?? (await load())
    if (!data) return

    try {
      setPhase('building')
      const bytes = await writeBreakdownXlsx(data, opts)
      const name = breakdownFileName()

      setPhase('zipping')
      const zipped = await zipOne(name, bytes)
      saveBlob(new Blob([zipped], { type: 'application/zip' }),
               name.replace(/\.xlsx$/, '.zip'))

      setResult({
        parts: data.length,
        xlsx: bytes.length,
        zip: zipped.length,
        stock: stockRows(data, opts).length,
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setPhase(null)
    }
  }

  // A preview of what the file will say, from the same functions that write it.
  const preview = rows
    ? rows.reduce(
        (acc, r) => {
          const t = totalsFor(r, opts)
          acc.grand += t.grand
          if (t.locStatus === 'NOK') acc.locNok++
          if (t.owStatus === 'NOK') acc.owNok++
          return acc
        },
        { grand: 0, locNok: 0, owNok: 0 }
      )
    : null

  const busy = phase !== null
  const min = minimalStock(opts)

  return (
    <div className="admin">
      <div className="card">
        <h2>Breakdown Query</h2>
        <p className="muted small">
          One row per part number, with its stock in every area. Built from
          Query as it stands now &mdash; last updated{' '}
          {lastUpdate ? (
            <strong>
              {formatWhen(lastUpdate.uploaded_at)} ({relativeTime(lastUpdate.uploaded_at)})
            </strong>
          ) : (
            'at an unknown time'
          )}
          .
        </p>

        <div className="bdopts">
          <label>
            <span className="muted small">Stock level &mdash; LOC</span>
            <input type="number" value={opts.locMin} onChange={set('locMin')} min="0" />
          </label>
          <label>
            <span className="muted small">Stock level &mdash; OW SAIC</span>
            <input type="number" value={opts.owMin} onChange={set('owMin')} min="0" />
          </label>
          <label>
            <span className="muted small">JPH</span>
            <input type="number" value={opts.jph} onChange={set('jph')} min="0" />
          </label>
          <label>
            <span className="muted small">Working hours</span>
            <input
              type="number"
              value={opts.workingHours}
              onChange={set('workingHours')}
              min="0"
            />
          </label>
        </div>

        <p className="muted small">
          Minimal Stock for the Stock sheet is <strong>{nf.format(min)}</strong>{' '}
          &mdash; (JPH {opts.jph || 0} &times; {opts.workingHours || 0} hours) + 1 ={' '}
          {nf.format(dayQty(opts))}, doubled. Change JPH here and download again;
          the thresholds are also live formulas inside the file, so they can be
          changed in Excel afterwards.
        </p>

        <div className="ccactions">
          <button type="button" onClick={download} disabled={busy}>
            {phase === 'loading'
              ? `Loading ${nf.format(loaded)} parts...`
              : phase === 'building'
                ? 'Building the workbook...'
                : phase === 'zipping'
                  ? 'Compressing...'
                  : 'Download Breakdown (zipped .xlsx)'}
          </button>
          {rows && !busy && (
            <button type="button" className="ghost" onClick={load}>
              Reload from Query
            </button>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        {result && (
          <div className="ccdoneline">
            {nf.format(result.parts)} parts &middot;{' '}
            {(result.zip / 1048576).toFixed(2)} MB zipped from{' '}
            {(result.xlsx / 1048576).toFixed(1)} MB &middot;{' '}
            {nf.format(result.stock)} parts on the Stock sheet.
          </div>
        )}
      </div>

      {preview && (
        <div className="card">
          <h3>What the file will say</h3>
          <div className="ccounts five">
            <div className="ccount">
              <strong>{nf.format(rows.length)}</strong>
              <span>parts with stock</span>
            </div>
            <div className="ccount">
              <strong>{nf.format(preview.grand)}</strong>
              <span>pieces in total</span>
            </div>
            <div className="ccount bad">
              <strong>{nf.format(preview.locNok)}</strong>
              <span>NOK vs LOC {nf.format(opts.locMin || 0)}</span>
            </div>
            <div className="ccount warn">
              <strong>{nf.format(preview.owNok)}</strong>
              <span>NOK vs SAIC {nf.format(opts.owMin || 0)}</span>
            </div>
            <div className="ccount">
              <strong>{nf.format(stockRows(rows, opts).length)}</strong>
              <span>below {nf.format(min)}</span>
            </div>
          </div>

          <p className="muted small">
            Columns: {LOC_COLUMNS.map((c) => c.label).join(', ')} &middot;{' '}
            {OW_COLUMNS.map((c) => c.label).join(', ')} &middot;{' '}
            {NONSAIC_COLUMNS.map((c) => c.label).join(', ')}.
          </p>
        </div>
      )}
    </div>
  )
}
