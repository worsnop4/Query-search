// Reading the Breakdown pivot.
//
// Split from breakdown.js because that file is pure and testable in plain node;
// this one imports supabase.js, which only exists under Vite.

import { supabase } from './supabase'

const PAGE = 1000

/**
 * Every part, with its quantity in each area.
 *
 * The `breakdown` view does the whole pivot in Postgres - one row per part
 * number, one column per site - so the browser only ever handles ~11,800 rows
 * rather than the 195,000 inventory rows behind them.
 *
 * Ordered by part_number, which is unique in the view (it is the GROUP BY key),
 * so paging is stable. Without a deterministic order PostgREST paging can
 * repeat one row and drop another, and the file would look complete while
 * quietly missing parts.
 */
export async function fetchBreakdown(onProgress) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('breakdown')
      .select('*')
      .order('part_number')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Could not load the breakdown: ${error.message}`)
    const batch = data ?? []
    all.push(...batch)
    onProgress?.(all.length)
    if (batch.length < PAGE) return all
  }
}
