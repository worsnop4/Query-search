// Reading the TRANSIT bay.
//
// Split from transit.js so that file stays pure and testable in plain node.

import { supabase } from './supabase'

const PAGE = 1000

/**
 * One row per case sitting at location TRANSIT.
 *
 * The `transit_cases` view does the grouping in Postgres - 6,893 inventory
 * rows collapse to about 3,360 cases - so the browser handles a third of the
 * data and never has to join to master_data itself.
 *
 * Ordered by case_no, which is the view's GROUP BY key and therefore unique,
 * so paging is stable. Without a deterministic order PostgREST can repeat one
 * row and drop another.
 */
export async function fetchTransitCases(onProgress) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transit_cases')
      .select('*')
      .order('case_no')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Could not load the transit cases: ${error.message}`)
    const batch = data ?? []
    all.push(...batch)
    onProgress?.(all.length)
    if (batch.length < PAGE) return all
  }
}
