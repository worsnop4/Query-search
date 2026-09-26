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
 * Parse "Case cont.xlsx" workbook (Case -> Container).
 * Matches headers flexibly:
 *   - Case: 'CASE', 'CASE NO', 'CASE NUMBER', 'PDAID'
 *   - Container: 'CONTAINER', 'NO CONT', 'CONT', 'CONT NO', 'CONTAINER CODE'
 */
export function parseCaseContainerWorkbook(arrayBuffer) {
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
  let colCont = -1

  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i]
    if (!Array.isArray(row)) continue

    const headers = row.map(normalizeHeader)
    const foundCase = headers.findIndex(
      (h) => h === 'CASE' || h === 'CASE NO' || h === 'CASE NUMBER' || h === 'PDAID' || h.includes('CASE')
    )
    const foundCont = headers.findIndex(
      (h) => h === 'CONTAINER' || h === 'NO CONT' || h === 'CONT' || h.includes('CONT')
    )

    if (foundCase !== -1 && foundCont !== -1) {
      headerIdx = i
      colCase = foundCase
      colCont = foundCont
      break
    }
  }

  if (headerIdx === -1 || colCase === -1 || colCont === -1) {
    throw new Error(
      'Could not locate expected columns. Expected "Case" (or "Case Number") and "Container" (or "NO CONT").'
    )
  }

  const rows = []
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i]
    if (!r) continue

    const caseVal = normText(r[colCase])
    const contVal = normText(r[colCont])
    if (!caseVal || !contVal) continue

    rows.push({
      case_no: caseVal.toUpperCase(),
      container_code: contVal.toUpperCase(),
    })
  }

  return rows
}

/**
 * Parse "cont dest.xlsx" workbook (Container -> Unload Destination).
 * Matches headers flexibly:
 *   - Container: 'NO CONT', 'CONTAINER', 'CONT', 'CONT NO', 'CONTAINER CODE'
 *   - Destination: 'DEATINATION', 'DESTINATION', 'UNLOAD DESTINATION', 'UNLOAD'
 */
export function parseContainerDestinationWorkbook(arrayBuffer) {
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
  let colCont = -1
  let colDest = -1

  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i]
    if (!Array.isArray(row)) continue

    const headers = row.map(normalizeHeader)
    const foundCont = headers.findIndex(
      (h) => h === 'NO CONT' || h === 'CONTAINER' || h === 'CONT' || h.includes('CONT')
    )
    const foundDest = headers.findIndex(
      (h) =>
        h === 'DEATINATION' ||
        h === 'DESTINATION' ||
        h.includes('DEST') ||
        h.includes('UNLOAD')
    )

    if (foundCont !== -1 && foundDest !== -1) {
      headerIdx = i
      colCont = foundCont
      colDest = foundDest
      break
    }
  }

  if (headerIdx === -1 || colCont === -1 || colDest === -1) {
    throw new Error(
      'Could not locate expected columns. Expected "NO CONT" (or "Container") and "Destination" (or "Deatination").'
    )
  }

  const rows = []
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i]
    if (!r) continue

    const contVal = normText(r[colCont])
    const destVal = normText(r[colDest])
    if (!contVal || !destVal) continue

    rows.push({
      container_code: contVal.toUpperCase(),
      unload_destination: destVal,
    })
  }

  return rows
}

/**
 * Upload Case & Container rows in chunks of 2,000.
 */
export async function uploadCaseContainers({ rows, onProgress, shouldCancel }) {
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
        const { error } = await supabase.rpc('upsert_case_containers_batch', {
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
 * Upload Container & Destination rows in chunks of 2,000.
 */
export async function uploadContainerDestinations({ rows, onProgress, shouldCancel }) {
  const total = rows.length
  if (total === 0) throw new Error('No valid container rows found to upload.')

  let done = 0
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (shouldCancel?.()) throw new Error('Upload cancelled.')

    const chunk = rows.slice(i, i + CHUNK_SIZE)
    let ok = false
    let lastErr = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await supabase.rpc('upsert_container_destinations_batch', {
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
 * Fetch storage statistics for case details.
 */
export async function fetchCaseDetailsStats() {
  const { data, error } = await supabase.rpc('get_case_details_stats')
  if (error) {
    // Fallback if rpc is not yet run
    const { count: caseCount } = await supabase
      .from('case_containers')
      .select('case_no', { count: 'exact', head: true })
    const { count: contCount } = await supabase
      .from('container_destinations')
      .select('container_code', { count: 'exact', head: true })
    return {
      case_count: caseCount ?? 0,
      container_count: contCount ?? 0,
      oldest_date: null,
      newest_date: null,
    }
  }

  const stat = Array.isArray(data) ? data[0] : data
  return {
    case_count: Number(stat?.case_count ?? 0),
    container_count: Number(stat?.container_count ?? 0),
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

  const { data, error } = await supabase.rpc('get_case_detail', {
    p_case_no: clean,
  })

  if (!error && data) {
    const res = Array.isArray(data) ? data[0] : data
    if (res && res.case_no) return res
  }

  // Fallback direct view query
  const { data: viewData, error: viewErr } = await supabase
    .from('case_details')
    .select('case_no, container_code, unload_destination')
    .eq('case_no', clean)
    .maybeSingle()

  if (viewErr) throw viewErr
  return viewData
}

/**
 * Look up unload destinations for a list of case numbers (e.g., current page of 100).
 * Returns an object keyed by case_no: { [case_no]: { container_code, unload_destination } }
 */
export async function fetchCaseDestinationsBatch(caseNumbers) {
  if (!caseNumbers || caseNumbers.length === 0) return {}
  const uniqueCases = [...new Set(caseNumbers.map((c) => String(c).trim().toUpperCase()))].filter(Boolean)
  if (uniqueCases.length === 0) return {}

  const out = {}
  const CHUNK = 500

  for (let i = 0; i < uniqueCases.length; i += CHUNK) {
    const chunk = uniqueCases.slice(i, i + CHUNK)
    const { data, error } = await supabase.rpc('get_case_destinations_batch', {
      p_cases: chunk,
    })

    if (!error && Array.isArray(data)) {
      for (const row of data) {
        if (row && row.case_no) {
          out[row.case_no] = {
            container_code: row.container_code ?? null,
            unload_destination: row.unload_destination ?? null,
          }
        }
      }
    } else {
      // Fallback query to view
      const { data: vData } = await supabase
        .from('case_details')
        .select('case_no, container_code, unload_destination')
        .in('case_no', chunk)

      for (const row of vData ?? []) {
        if (row && row.case_no) {
          out[row.case_no] = {
            container_code: row.container_code ?? null,
            unload_destination: row.unload_destination ?? null,
          }
        }
      }
    }
  }

  return out
}
