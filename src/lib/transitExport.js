// The follow-up list: cases that have sat at TRANSIT longer than the limit.
//
// No Supabase import, so it can be tested in plain node - the same reason
// csv.js and cycleCountExport.js are separate.

import { toCsv } from './csv.js'
import { localDate, needsFollowUp } from './transit.js'

export const FOLLOW_UP_COLUMNS = [
  'No',
  'Case Number',
  'Part Number',
  'Part Name',
  'Part Type',
  'Arrived',
  'Days in transit',
  'Cases opened',
  'Qty',
  'Parts in case',
]

/**
 * Everything past the limit, oldest first.
 *
 * `prepare()` has already sorted and aged them; this only filters and shapes.
 * Cases with no arrival time are left out: their age is unknown, so calling
 * them overdue would be a guess.
 */
export function followUpRows(rows, after) {
  return rows
    .filter((r) => needsFollowUp(r.age, after))
    .map((r, i) => ({
      No: i + 1,
      'Case Number': r.case_no,
      'Part Number': r.part_number ?? '',
      'Part Name': r.part_name ?? '',
      'Part Type': r.part_type ?? '',
      Arrived: localDate(r.first_inbound_time) ?? '',
      'Days in transit': r.age,
      'Cases opened': r.opened ? 'Yes' : 'No',
      Qty: Number(r.quantity) || 0,
      'Parts in case': Number(r.part_count) || 0,
    }))
}

export function buildFollowUpCsv(rows, after) {
  return toCsv(followUpRows(rows, after), FOLLOW_UP_COLUMNS)
}

export function followUpFileName(now = new Date()) {
  return `transit-follow-up-${localDate(now)}.csv`
}
