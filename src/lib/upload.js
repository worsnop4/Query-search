import { supabase } from './supabase'

// 2000 rows/request keeps each POST body around 1-2 MB. Bigger chunks mean
// fewer round trips but a single failure costs more work; ~100 requests for a
// 195k-row file is a reasonable middle.
const CHUNK_SIZE = 2000
const MAX_ATTEMPTS = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Replace a table's contents from parsed rows, safely.
 *
 * Everything lands in a staging table first. Only once every chunk has been
 * accepted does the swap function move it across, in a single transaction,
 * and only if the row count matches what we claim to have sent. A failed or
 * abandoned upload therefore cannot leave the live table empty or partial -
 * readers keep seeing the previous data until the instant the swap commits.
 */
export async function replaceTable({
  stagingTable,
  resetFn,
  swapFn,
  rows,
  onProgress,
  shouldCancel,
}) {
  const total = rows.length
  if (total === 0) throw new Error('Nothing to upload - the file produced 0 rows.')

  // 1. Clear anything left behind by a previous abandoned attempt.
  onProgress?.({ phase: 'clearing', done: 0, total })
  const { error: resetErr } = await supabase.rpc(resetFn)
  if (resetErr) {
    throw new Error(
      `Could not clear ${stagingTable}: ${resetErr.message}. ` +
        'Are you still signed in?'
    )
  }

  // 2. Insert in chunks, retrying transient failures.
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (shouldCancel?.()) throw new Error('Upload cancelled. Live data is unchanged.')

    const chunk = rows.slice(i, i + CHUNK_SIZE)
    let lastErr = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { error } = await supabase.from(stagingTable).insert(chunk)
      if (!error) { lastErr = null; break }
      lastErr = error
      if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt)
    }

    if (lastErr) {
      throw new Error(
        `Upload failed at rows ${i + 1}-${i + chunk.length} after ` +
          `${MAX_ATTEMPTS} attempts: ${lastErr.message}. Live data is unchanged.`
      )
    }

    onProgress?.({
      phase: 'uploading',
      done: Math.min(i + CHUNK_SIZE, total),
      total,
    })
  }

  // 3. Verify and swap - atomic, and recomputes zonetype/area for inventory.
  onProgress?.({ phase: 'swapping', done: total, total })
  const { data, error: swapErr } = await supabase.rpc(swapFn, { expected_rows: total })
  if (swapErr) {
    throw new Error(
      `The final swap was refused: ${swapErr.message}. ` +
        'Live data is unchanged - nothing was replaced.'
    )
  }

  onProgress?.({ phase: 'done', done: total, total })
  return typeof data === 'number' ? data : total
}

export const INVENTORY_TARGET = {
  stagingTable: 'inventory_staging',
  resetFn: 'reset_inventory_staging',
  swapFn: 'swap_inventory',
}

export const MASTER_TARGET = {
  stagingTable: 'master_data_staging',
  resetFn: 'reset_master_data_staging',
  swapFn: 'swap_master_data',
}