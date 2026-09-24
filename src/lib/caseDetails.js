import * as XLSX from 'xlsx'
import { supabase } from './supabase.js'

const CHUNK_SIZE = 2000
const MAX_ATTEMPTS = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function normalizeHeader(h) {
  return String(h ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

function normText(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    if (Number.isInteger(v)) return BigInt(v).toString()
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Parse "sa and destination.xlsx" workbook.
 * Matches headers flexibly:
 *   - Case Number / PDAID
 *   - Shipping Advice
 *   - Container Number / cont_no
 *   - Unload Destination
 */
export function parseShippingAdviceWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('Excel workbook contains no sheets.')

  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: '',
    blankrows: false,
  })

  if (!rawRows || rawRows.length === 0) {
    throw new Error('The selected file is empty.')
  }

  // Find header row in first 15 rows
  let headerIdx = -1
  let colCase = -1
  let colSa = -1
  let colCont = -1
  let colDest = -1

  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i]
    if (!Array.isArray(row)) continue

    const headers = row.map(normalizeHeader)
    const foundCase = headers.findIndex(
      (h) => h === 'CASE NUMBER' || h.includes('CASE') || h === 'PDAID'
    )
    const foundSa = headers.findIndex(
      (h) => h.includes('SHIPPING') || h === 'SA' || h.includes('ADVICE')
    )
    const foundCont = headers.findIndex(
      (h) => h.includes('CONT') || h.includes('CONTAINER')
    )
    const foundDest = headers.findIndex(
      (h) => h.includes('DESTINATION') || h.includes('UNLOAD')
    )

    if (foundCase !== -1) {
      headerIdx = i
      colCase = foundCase
      colSa = foundSa
      colCont = foundCont
      colDest = foundDest
      break
    }
  }

  if (headerIdx === -1 || colCase === -1) {
    throw new Error(
      'Could not locate header row. Expected a column named "Case Number" or "PDAID".'
    )
  }

  const rows = []
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i]
    if (!r) continue

    const caseVal = normText(r[colCase])
    if (!caseVal) continue

    rows.push({
      case_no: caseVal.toUpperCase(),
      shipping_advice: colSa !== -1 ? normText(r[colSa]) : null,
      container_code: colCont !== -1 ? normText(r[colCont]) : null,
      unload_destination: colDest !== -1 ? normText(r[colDest]) : null,
    })
  }

  return rows
}

/**
 * Parse "unpacklabel.xlsx" workbook.
 * Matches headers:
 *   - PDAID / Case Number
 *   - NO UNPACK / Unpack Number
 *   - Team (optional)
 */
export function parseUnpackLabelWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('Excel workbook contains no sheets.')

  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: '',
    blankrows: false,
  })

  if (!rawRows || rawRows.length === 0) {
    throw new Error('The selected file is empty.')
  }

  // Find header row in first 15 rows
  let headerIdx = -1
  let colCase = -1
  let colUnpack = -1
  let colTeam = -1

  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i]
    if (!Array.isArray(row)) continue

    const headers = row.map(normalizeHeader)
    const foundCase = headers.findIndex(
      (h) => h === 'PDAID' || h.includes('CASE') || h === 'CASE NO'
    )
    const foundUnpack = headers.findIndex(
      (h) => h.includes('UNPACK') || h === 'NO UNPACK'
    )
    const foundTeam = headers.findIndex((h) => h.includes('TEAM'))

    if (foundCase !== -1) {
      headerIdx = i
      colCase = foundCase
      colUnpack = foundUnpack
      colTeam = foundTeam
      break
    }
  }

  if (headerIdx === -1 || colCase === -1) {
    throw new Error(
      'Could not locate header row. Expected a column named "PDAID" or "Case Number".'
    )
  }

  const rows = []
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i]
    if (!r) continue

    const caseVal = normText(r[colCase])
    if (!caseVal) continue

    rows.push({
      case_no: caseVal.toUpperCase(),
      unpack_number: colUnpack !== -1 ? normText(r[colUnpack]) : null,
      team_no: colTeam !== -1 ? normText(r[colTeam]) : null,
    })
  }

  return rows
}

/**
 * Upload Shipping Advice & Destination rows in chunks of 2,000.
 */
export async function uploadCaseShipping({ rows, onProgress, shouldCancel }) {
  const total = rows.length
  if (total === 0) throw new Error('No valid case rows found to upload.')

  let done = 0
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (shouldCancel?.()) throw new Error('Upload cancelled.')

    const chunk = rows.slice(i, i + CHUNK_SIZE)
    let ok = false
    let lastErr = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await supabase.rpc('upsert_case_shipping_batch', {
          p_rows: chunk,
        })
        if (error) throw error
        ok = true
        break
      } catch (err) {
        lastErr = err
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000)
      }
    }

    if (!ok) {
      throw new Error(
        `Failed uploading chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${lastErr?.message ?? lastErr}`
      )
    }

    done += chunk.length
    onProgress?.({ done, total })
  }

  return { total }
}

/**
 * Upload Unpack Label rows in chunks of 2,000.
 */
export async function uploadCaseUnpack({ rows, onProgress, shouldCancel }) {
  const total = rows.length
  if (total === 0) throw new Error('No valid unpack rows found to upload.')

  let done = 0
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (shouldCancel?.()) throw new Error('Upload cancelled.')

    const chunk = rows.slice(i, i + CHUNK_SIZE)
    let ok = false
    let lastErr = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await supabase.rpc('upsert_case_unpack_batch', {
          p_rows: chunk,
        })
        if (error) throw error
        ok = true
        break
      } catch (err) {
        lastErr = err
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000)
      }
    }

    if (!ok) {
      throw new Error(
        `Failed uploading chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${lastErr?.message ?? lastErr}`
      )
    }

    done += chunk.length
    onProgress?.({ done, total })
  }

  return { total }
}

/**
 * Fetch storage statistics for case_details.
 */
export async function fetchCaseDetailsStats() {
  const { data, error } = await supabase.rpc('get_case_details_stats')
  if (error) {
    // Fallback if rpc is not yet available
    const { count, error: countErr } = await supabase
      .from('case_details')
      .select('case_no', { count: 'exact', head: true })
    if (countErr) return { total_count: 0, oldest_date: null, newest_date: null }
    return { total_count: count ?? 0, oldest_date: null, newest_date: null }
  }

  const stat = Array.isArray(data) ? data[0] : data
  return {
    total_count: Number(stat?.total_count ?? 0),
    oldest_date: stat?.oldest_date ?? null,
    newest_date: stat?.newest_date ?? null,
  }
}

/**
 * Delete records older than a given date or days.
 */
export async function deleteCaseDetailsBefore(cutoffIsoString) {
  const { data, error } = await supabase.rpc('delete_case_details_before', {
    p_cutoff: cutoffIsoString,
  })
  if (error) throw error
  return Number(data ?? 0)
}

/**
 * Look up single case details by case number.
 */
export async function fetchCaseDetail(caseNo) {
  if (!caseNo) return null
  const clean = String(caseNo).trim().toUpperCase()
  const { data, error } = await supabase
    .from('case_details')
    .select(
      'case_no, shipping_advice, container_code, unload_destination, unpack_number, team_no, sa_updated_at, unpack_updated_at, updated_at'
    )
    .eq('case_no', clean)
    .maybeSingle()

  if (error) throw error
  return data
}
