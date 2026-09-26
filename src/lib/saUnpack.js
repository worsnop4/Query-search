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
 * Parse "sa 9.10 unpack.xlsx" workbook.
 * Matches headers flexibly:
 *   - SA: 'SA', 'SHIPPING ADVICE'
 *   - Case Number: 'CASE NUMBER', 'CASE NO', 'CASE', 'PDAID'
 *   - Part Number: 'PART NUMBER', 'PART NO', 'PART'
 *   - Part Name: 'PART_NAME', 'PART NAME', 'DESCRIPTION'
 *   - Section: 'SECTION', 'LINE', 'AREA'
 *   - Pack Qty: 'PACK_QTY', 'PACK QTY', 'QTY', 'QUANTITY'
 */
export function parseSaUnpackWorkbook(arrayBuffer) {
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
  let colSa = -1
  let colCase = -1
  let colPart = -1
  let colName = -1
  let colSection = -1
  let colQty = -1

  for (let i = 0; i < Math.min(15, rawRows.length); i++) {
    const row = rawRows[i]
    if (!Array.isArray(row)) continue

    const headers = row.map(normalizeHeader)
    const foundCase = headers.findIndex(
      (h) =>
        h === 'CASE NUMBER' ||
        h === 'CASE NO' ||
        h === 'CASE' ||
        h === 'PDAID' ||
        h.includes('CASE')
    )
    const foundPart = headers.findIndex(
      (h) => h === 'PART NUMBER' || h === 'PART NO' || h === 'PART' || h.includes('PART')
    )

    if (foundCase !== -1 && foundPart !== -1) {
      headerIdx = i
      colCase = foundCase
      colPart = foundPart
      colSa = headers.findIndex(
        (h) => h === 'SA' || h.includes('SHIPPING') || h.includes('ADVICE')
      )
      colName = headers.findIndex(
        (h) =>
          h === 'PART_NAME' ||
          h === 'PART NAME' ||
          h.includes('NAME') ||
          h.includes('DESC')
      )
      colSection = headers.findIndex(
        (h) => h === 'SECTION' || h.includes('SECTION') || h === 'LINE'
      )
      colQty = headers.findIndex(
        (h) =>
          h === 'PACK_QTY' ||
          h === 'PACK QTY' ||
          h === 'QTY' ||
          h.includes('QTY') ||
          h.includes('QUANTITY')
      )
      break
    }
  }

  if (headerIdx === -1 || colCase === -1 || colPart === -1) {
    throw new Error(
      'Could not locate expected columns. Expected at least "Case Number" and "Part Number".'
    )
  }

  const rows = []
  let detectedSa = null

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i]
    if (!r) continue

    const caseVal = normText(r[colCase])
    const partVal = normText(r[colPart])
    if (!caseVal || !partVal) continue

    const saVal = colSa !== -1 ? normText(r[colSa]) : null
    if (!detectedSa && saVal) detectedSa = saVal

    const nameVal = colName !== -1 ? normText(r[colName]) : null
    const sectionVal = colSection !== -1 ? normText(r[colSection]) : null
    const qtyVal = colQty !== -1 ? Number(r[colQty]) || 0 : 0

    rows.push({
      sa: saVal,
      case_no: caseVal.toUpperCase(),
      part_number: partVal,
      part_name: nameVal,
      section: sectionVal ? sectionVal.toUpperCase() : 'UNASSIGNED',
      pack_qty: Number.isFinite(qtyVal) ? qtyVal : 0,
    })
  }

  return {
    saName: detectedSa,
    rows,
  }
}

/**
 * Upload SA Unpack rows in chunks of 2,000.
 */
export async function uploadSaUnpack({
  rows,
  saName,
  clearExisting = false,
  onProgress,
  shouldCancel,
}) {
  const total = rows.length
  if (total === 0) throw new Error('No valid rows found to upload.')

  if (clearExisting) {
    const { error: clearErr } = await supabase.rpc('clear_sa_unpack', {
      p_sa: saName || null,
    })
    if (clearErr) throw clearErr
  }

  let done = 0
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (shouldCancel?.()) throw new Error('Upload cancelled.')

    const chunk = rows.slice(i, i + CHUNK_SIZE)
    let ok = false
    let lastErr = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await supabase.rpc('insert_sa_unpack_batch', {
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

  return { total, saName }
}

/**
 * Fetch all parts inside a case, organized and grouped by section.
 */
export async function fetchSaUnpackCase(caseNo) {
  if (!caseNo) return null
  const clean = String(caseNo).trim().toUpperCase()

  const { data, error } = await supabase.rpc('get_sa_unpack_case', {
    p_case_no: clean,
  })

  if (error) throw error
  if (!data || data.length === 0) return null

  // Extract SA and Case No
  const sa = data[0]?.sa ?? null

  // Group by Section
  const sectionMap = new Map()
  let totalParts = 0
  let totalQty = 0

  for (const row of data) {
    const secName = row.section || 'UNASSIGNED'
    if (!sectionMap.has(secName)) {
      sectionMap.set(secName, {
        name: secName,
        parts: [],
        section_qty: 0,
      })
    }
    const sec = sectionMap.get(secName)
    const qty = Number(row.total_qty || 0)
    sec.parts.push({
      part_number: row.part_number,
      part_name: row.part_name,
      total_qty: qty,
      box_count: Number(row.box_count || 1),
      box_qtys: row.box_qtys || [],
    })
    sec.section_qty += qty
    totalParts++
    totalQty += qty
  }

  // Sort sections with prominent production sections first
  const sectionOrder = [
    'TRIMMING',
    'BATTERY SHOP',
    'LOW CHASSIS',
    'HIGH CHASSIS',
    'ENGINE',
    'FINAL',
    'BODY SHOP',
    'PAINT BUMPER',
    'IP',
    'SA DOOR',
    'SA IP',
    'SA TIRE',
  ]

  const sections = Array.from(sectionMap.values()).sort((a, b) => {
    const idxA = sectionOrder.indexOf(a.name)
    const idxB = sectionOrder.indexOf(b.name)
    if (idxA !== -1 && idxB !== -1) return idxA - idxB
    if (idxA !== -1) return -1
    if (idxB !== -1) return 1
    return a.name.localeCompare(b.name)
  })

  return {
    case_no: clean,
    sa,
    total_parts: totalParts,
    total_qty: totalQty,
    sections,
  }
}

/**
 * Search cases matching partial term.
 */
export async function searchSaUnpackCases(term) {
  if (!term || term.trim().length === 0) return []
  const clean = term.trim()

  const { data, error } = await supabase.rpc('search_sa_unpack_cases', {
    p_term: clean,
  })

  if (error) return []
  return data ?? []
}

/**
 * Fetch storage statistics for SA Unpack.
 */
export async function fetchSaUnpackStats() {
  const { data, error } = await supabase.rpc('get_sa_unpack_stats')
  if (error) {
    const { count } = await supabase
      .from('sa_unpack_items')
      .select('id', { count: 'exact', head: true })
    return {
      total_rows: count ?? 0,
      total_cases: 0,
      total_parts: 0,
      distinct_sas: 0,
      oldest_date: null,
      newest_date: null,
    }
  }

  const stat = Array.isArray(data) ? data[0] : data
  return {
    total_rows: Number(stat?.total_rows ?? 0),
    total_cases: Number(stat?.total_cases ?? 0),
    total_parts: Number(stat?.total_parts ?? 0),
    distinct_sas: Number(stat?.distinct_sas ?? 0),
    oldest_date: stat?.oldest_date ?? null,
    newest_date: stat?.newest_date ?? null,
  }
}
