import { supabase } from './supabase'

// 2000 rows/request keeps each POST body around 1-2 MB. Bigger chunks mean
// fewer round trips but a single failure costs more work; ~100 requests for a
// 195k-row file is a reasonable middle.
const CHUNK_SIZE = 2000
const MAX_ATTEMPTS = 3

// An upload runs for minutes. The claim is only honoured while its heartbeat
// is fresh, so it has to keep beating for the whole run - the chunk loop
// awaits the network constantly, so this interval fires between chunks.
const HEARTBEAT_MS = 30_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Replace a table's contents from parsed rows, safely.
 *
 * Everything lands in a staging table first. Only once every chunk has been
 * accepted does the swap function move it across, in a single transaction,
 * and only if the row count matches what we claim to have sent. A failed or
 * abandoned upload therefore cannot leave the live table empty or partial -
 * readers keep seeing the previous data until the instant the swap commits.
 *
 * Exclusive per target: the claim is taken before anything is staged, and the
 * reset and swap functions refuse to run without it. Two admins cannot upload
 * the same table at once even by calling the API directly; two admins
 * uploading DIFFERENT tables are unaffected.
 */
export async function replaceTable({
  stagingTable,
  resetFn,
  swapFn,
  target,
  sessionId,
  rows,
  onProgress,
  shouldCancel,
}) {
  const total = rows.length
  if (total === 0) throw new Error('Nothing to upload - the file produced 0 rows.')

  // 1. Claim the target. Fails if another admin holds it, before any work.
  onProgress?.({ phase: 'claiming', done: 0, total })
  const { error: claimErr } = await supabase.rpc('claim_upload', {
    p_session_id: sessionId,
    p_target: target,
  })
  if (claimErr) throw new Error(claimErr.message)

  // From here on the claim must stay alive or the swap will refuse at the end.
  const beat = setInterval(() => {
    supabase.rpc('admin_heartbeat', { p_session_id: sessionId })
  }, HEARTBEAT_MS)

  try {
    return await runUpload({
      stagingTable, resetFn, swapFn, sessionId, rows, total, onProgress, shouldCancel,
    })
  } catch (err) {
    // Hand the target back immediately rather than making the next admin wait
    // out the 90s staleness window for an upload we know has stopped.
    await supabase.rpc('release_upload', { p_session_id: sessionId })
    throw err
  } finally {
    clearInterval(beat)
  }
}

async function runUpload({
  stagingTable,
  resetFn,
  swapFn,
  sessionId,
  rows,
  total,
  onProgress,
  shouldCancel,
}) {
  // 1b. Clear anything left behind by a previous abandoned attempt.
  onProgress?.({ phase: 'clearing', done: 0, total })
  const { error: resetErr } = await supabase.rpc(resetFn, { p_session_id: sessionId })
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
      if (attempt >= MAX_ATTEMPTS) break

      await sleep(500 * attempt)

      // The request may have failed AFTER the server committed it - a gateway
      // timeout, a dropped connection. Re-sending would then insert the chunk
      // twice, and the swap's exact row-count check would reject the whole
      // upload at the very end. An insert of an array is one statement, so
      // staging holds either i or i + chunk.length rows: ask which.
      const { count, error: countErr } = await supabase
        .from(stagingTable)
        .select('*', { count: 'exact', head: true })
      if (!countErr && count === i + chunk.length) { lastErr = null; break }
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
  //    The swap releases the claim in the same transaction that makes the data
  //    live, so there is no window where the data is in but the lock is still
  //    held.
  onProgress?.({ phase: 'swapping', done: total, total })
  const { data, error: swapErr } = await supabase.rpc(swapFn, {
    expected_rows: total,
    p_session_id: sessionId,
  })
  if (swapErr) {
    throw new Error(
      `The final swap was refused: ${swapErr.message}. ` +
        'Live data is unchanged - nothing was replaced.'
    )
  }

  onProgress?.({ phase: 'done', done: total, total })
  return typeof data === 'number' ? data : total
}

// `target` must match the values claim_upload() accepts, and the `table_name`
// the upload log records - they are the same two strings throughout.
export const INVENTORY_TARGET = {
  stagingTable: 'inventory_staging',
  resetFn: 'reset_inventory_staging',
  swapFn: 'swap_inventory',
  target: 'inventory',
}

export const MASTER_TARGET = {
  stagingTable: 'master_data_staging',
  resetFn: 'reset_master_data_staging',
  swapFn: 'swap_master_data',
  target: 'master_data',
}