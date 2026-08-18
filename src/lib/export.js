import { supabase } from './supabase'
import { csvRow } from './csv'
import { EXPORT_COLUMNS, zipCsv, exportCsvName } from './exportFormat'

// Re-exported so callers keep importing everything about the export from one
// place; the definitions live in exportFormat.js because that file can be
// tested in Node, and this one cannot.
export { EXPORT_COLUMNS, exportCsvName, exportFileName } from './exportFormat'

// ---------------------------------------------------------------------------
// Exporting the whole inventory table
//
// PostgREST caps every response at 1,000 rows on this project - `.limit(5000)`
// and `.range(0, 4999)` both come back with 1,000 - so 194,000 rows means
// roughly 195 requests, not one. Measured against live data, a request for the
// deepest page costs about the same as the first (~500ms), so the pages are
// fetched a few at a time rather than strictly in sequence.
//
// The columns are exactly the ten the parser imports (INVENTORY_FIELDS in
// parse.js). No `id`, which is a database artifact, and none of the columns
// Postgres computes during the swap - the file is meant to mirror what was
// uploaded.
// ---------------------------------------------------------------------------

const PAGE = 1000
const CONCURRENCY = 5

const SELECT = EXPORT_COLUMNS.join(', ')

async function fetchPage(index) {
  const from = index * PAGE
  const { data, error } = await supabase
    .from('inventory')
    .select(SELECT)
    // A stable order matters: without ORDER BY, Postgres may return the same
    // row on two different pages and skip another entirely.
    .order('id')
    .range(from, from + PAGE - 1)

  if (error) throw new Error(`Page ${index + 1}: ${error.message}`)
  return data ?? []
}

export async function countInventory() {
  const { count, error } = await supabase
    .from('inventory')
    .select('*', { count: 'exact', head: true })
  if (error) throw new Error(`Could not count the table: ${error.message}`)
  return count ?? 0
}

/**
 * Fetch every row and build a zipped CSV Blob.
 *
 * Returns { blob, rows, changed, csvBytes, zipBytes } - `changed` is true when
 * the table's row count moved while we were reading, which means an upload
 * swapped the table underneath us and the file cannot be trusted.
 */
export async function exportInventoryCsv({ onProgress, shouldCancel } = {}) {
  const total = await countInventory()
  if (total === 0) throw new Error('There is no inventory data to export.')

  const pages = Math.ceil(total / PAGE)
  // One string per page rather than one growing string: Blob takes the parts
  // as they are, so the whole file never has to exist as a single value.
  const parts = [EXPORT_COLUMNS.join(',') + '\n']
  const chunks = new Array(pages)
  let done = 0

  onProgress?.({ phase: 'downloading', done: 0, total })

  for (let start = 0; start < pages; start += CONCURRENCY) {
    if (shouldCancel?.()) throw new Error('Download cancelled.')

    const batch = []
    for (let i = start; i < Math.min(start + CONCURRENCY, pages); i++) {
      batch.push(
        fetchPage(i).then((rows) => {
          // Keyed by page index, so out-of-order completion inside a batch
          // cannot shuffle the file.
          chunks[i] = rows.map((r) => csvRow(r, EXPORT_COLUMNS)).join('\n') + '\n'
          done += rows.length
          onProgress?.({ phase: 'downloading', done, total })
        })
      )
    }
    await Promise.all(batch)
  }

  for (const c of chunks) if (c) parts.push(c)

  // Was the table replaced while we read it? swap_inventory() truncates and
  // re-inserts, so an upload landing mid-export gives duplicated and missing
  // rows. The count is a cheap tell; say so rather than hand over a file that
  // looks complete.
  const after = await countInventory()

  // The BOM is what makes Excel read the extracted file as UTF-8 on a double
  // click. It has to be inside the zip entry, not on the zip itself.
  //
  // Via a Blob rather than joining into one string: the parts stay separate
  // until arrayBuffer() walks them, so a 24 MB file never has to exist as a
  // single JavaScript value.
  const csvBlob = new Blob(['﻿', ...parts], { type: 'text/csv;charset=utf-8' })
  const csvBytes = new Uint8Array(await csvBlob.arrayBuffer())

  onProgress?.({ phase: 'compressing', done: total, total })
  const zipped = await zipCsv(exportCsvName(), csvBytes)

  onProgress?.({ phase: 'done', done: total, total })

  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    rows: done,
    changed: after !== total,
    csvBytes: csvBytes.length,
    zipBytes: zipped.length,
  }
}

/** Hand the blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the download a tick to start before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
