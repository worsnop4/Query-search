import * as XLSX from 'xlsx'

// ---------------------------------------------------------------------------
// Why this file maps columns by HEADER NAME and not by position
//
// The daily WMS export is not a stable shape. Real files from one week:
//
//   14-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
//   13-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
//   12-08  12 cols  ... Quantity | Status  | Is Case Opened | ... | Zonetype 1 | Area
//   11-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
//   07-08  10 cols  ... Quantity | Status  | Is Case Opened | ...
//
// An unnamed empty column appears between Quantity and Status on some days and
// not others. Reading fixed positions 1-10 would put Status into
// is_case_opened and shift both timestamps - and it would look like it worked,
// because "Available" is a perfectly plausible-looking string.
//
// So: read the header row, find where each field actually is that day, ignore
// everything else (blank columns, the Zonetype 1 / Area formula columns, and
// any new column the WMS adds later). If a required header is missing, refuse
// the file rather than import shifted data.
// ---------------------------------------------------------------------------

const HEADER_SEARCH_DEPTH = 10 // rows to scan when locating the header row

function normalizeHeader(h) {
  return String(h ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

// Excel gives numbers for numeric-looking cells. Part numbers are a MIX of
// number and text across both files ("23588931" vs "11559571-PMC"), so a
// number must render as a plain integer string - never "23588931.0" and never
// "2.3588931e+7", or the join to master_data silently breaks.
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

function normNumber(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

// Timestamps arrive as text ("2026-01-11 19:10:32") in every file seen so far.
// cellDates:true means a genuinely date-formatted cell arrives as a Date, so
// handle both.
function normTimestamp(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString()
  const s = String(v).trim()
  return s === '' ? null : s
}

// --- field definitions ------------------------------------------------------
// `names` are matched against the normalized header text. First match wins.

const INVENTORY_FIELDS = [
  { key: 'part_number',        names: ['PART NUMBER'],                                    required: true,  norm: normText },
  { key: 'supplier_code',      names: ['SUPPLIER CODE'],                                  required: false, norm: normText },
  { key: 'case_no',            names: ['CASE NO', 'CASE NUMBER'],                         required: true,  norm: normText },
  { key: 'location',           names: ['LOCATION'],                                       required: true,  norm: normText },
  { key: 'zone_type',          names: ['ZONE TYPE'],                                      required: true,  norm: normText },
  { key: 'quantity',           names: ['QUANTITY', 'QTY'],                                required: true,  norm: normNumber },
  { key: 'status',             names: ['STATUS'],                                         required: false, norm: normText },
  { key: 'is_case_opened',     names: ['IS CASE OPENED'],                                 required: true,  norm: normText },
  { key: 'inbound_time',       names: ['INBOUND TIME-CURRENT WH', 'INBOUND TIME CURRENT WH'], required: false, norm: normTimestamp },
  { key: 'first_inbound_time', names: ['1ST INBOUND TIME', 'FIRST INBOUND TIME'],         required: false, norm: normTimestamp },
]

// PFEP master data. Mapping by name matters here too: the file has both
// "OLD DLOC" and "NEW DLOC" adjacent to each other, and we want the new one.
const MASTER_FIELDS = [
  { key: 'part_number', names: ['PART NUMBER'], required: true,  norm: normText },
  { key: 'part_name',   names: ['PART NAME'],   required: true,  norm: normText },
  { key: 'car_type',    names: ['CAR TYPE'],    required: false, norm: normText },
  { key: 'dloc',        names: ['NEW DLOC'],    required: false, norm: normText },
]

// --- workbook helpers -------------------------------------------------------

function findHeaderRow(rows, fields) {
  const wanted = new Set(fields.filter((f) => f.required).flatMap((f) => f.names))
  const depth = Math.min(HEADER_SEARCH_DEPTH, rows.length)

  let best = { index: -1, hits: 0 }
  for (let r = 0; r < depth; r++) {
    const cells = (rows[r] ?? []).map(normalizeHeader)
    const hits = [...wanted].filter((w) => cells.includes(w)).length
    if (hits > best.hits) best = { index: r, hits }
  }
  return best.index
}

function buildColumnMap(headerCells, fields) {
  const normalized = headerCells.map(normalizeHeader)
  const map = {}
  const missing = []

  for (const f of fields) {
    let idx = -1
    for (const name of f.names) {
      idx = normalized.indexOf(name)
      if (idx !== -1) break
    }
    if (idx === -1) {
      if (f.required) missing.push(f.names[0])
      else map[f.key] = null
    } else {
      map[f.key] = idx
    }
  }
  return { map, missing }
}

async function readWorkbook(file, sheetName) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: true })

  let name = sheetName
  if (name && !wb.SheetNames.includes(name)) name = null
  if (!name) name = wb.SheetNames[0]

  const ws = wb.Sheets[name]
  if (!ws) throw new Error(`The workbook has no readable sheet (found: ${wb.SheetNames.join(', ') || 'none'})`)

  // blankrows:true keeps array indices aligned with real Excel row numbers.
  // Some exports have a blank row 2 and some do not; dropping blanks would
  // make the "header row N" we report to the user wrong. Genuinely empty rows
  // are discarded later by the part_number check.
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  })

  return { rows, sheetName: name, allSheets: wb.SheetNames }
}

// Yield to the browser periodically so the progress bar actually repaints
// instead of freezing for the whole 195k-row loop.
const YIELD_EVERY = 20000
const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0))

// --- public API -------------------------------------------------------------

/**
 * Parse the daily inventory .xlsm into rows shaped for `inventory_staging`.
 * Returns { rows, sheetName, headerRow, missingOptional, skipped }.
 */
export async function parseInventory(file, onProgress) {
  onProgress?.({ phase: 'reading', done: 0, total: 0 })
  const { rows: raw, sheetName } = await readWorkbook(file, 'Sheet1')

  const headerRow = findHeaderRow(raw, INVENTORY_FIELDS)
  if (headerRow === -1) {
    throw new Error(
      'Could not find the header row. Expected a row containing "Part Number", ' +
        '"Location", "Zone Type", "Quantity" and "Is Case Opened" within the ' +
        `first ${HEADER_SEARCH_DEPTH} rows.`
    )
  }

  const { map, missing } = buildColumnMap(raw[headerRow], INVENTORY_FIELDS)
  if (missing.length > 0) {
    const found = (raw[headerRow] ?? []).map(normalizeHeader).filter(Boolean)
    throw new Error(
      `This file is missing required column(s): ${missing.join(', ')}. ` +
        `Headers found on row ${headerRow + 1}: ${found.join(' | ')}`
    )
  }

  const missingOptional = INVENTORY_FIELDS.filter(
    (f) => !f.required && map[f.key] === null
  ).map((f) => f.names[0])

  const out = []
  let skipped = 0
  const total = raw.length - headerRow - 1

  for (let r = headerRow + 1; r < raw.length; r++) {
    const src = raw[r]
    if (!src) { skipped++; continue }

    const rec = {}
    for (const f of INVENTORY_FIELDS) {
      const idx = map[f.key]
      rec[f.key] = idx === null ? null : f.norm(src[idx])
    }

    // A row with no part number is not inventory - trailing junk, a spacer,
    // or a totals line.
    if (!rec.part_number) { skipped++; continue }

    out.push(rec)

    if (out.length % YIELD_EVERY === 0) {
      onProgress?.({ phase: 'parsing', done: out.length, total })
      await yieldToBrowser()
    }
  }

  onProgress?.({ phase: 'parsing', done: out.length, total })
  return { rows: out, sheetName, headerRow: headerRow + 1, missingOptional, skipped }
}

/**
 * Parse the PFEP master data .xlsb into rows shaped for `master_data_staging`.
 * De-duplicates on part_number, preferring the first row that actually has a
 * part name.
 * Returns { rows, sheetName, headerRow, missingOptional, duplicates, skipped }.
 */
export async function parseMasterData(file, onProgress) {
  onProgress?.({ phase: 'reading', done: 0, total: 0 })
  const { rows: raw, sheetName } = await readWorkbook(file, 'MASDAT')

  const headerRow = findHeaderRow(raw, MASTER_FIELDS)
  if (headerRow === -1) {
    throw new Error(
      'Could not find the header row. Expected a row containing "Part Number" ' +
        `and "Part Name" within the first ${HEADER_SEARCH_DEPTH} rows.`
    )
  }

  const { map, missing } = buildColumnMap(raw[headerRow], MASTER_FIELDS)
  if (missing.length > 0) {
    const found = (raw[headerRow] ?? []).map(normalizeHeader).filter(Boolean)
    throw new Error(
      `This file is missing required column(s): ${missing.join(', ')}. ` +
        `Headers found on row ${headerRow + 1}: ${found.join(' | ')}`
    )
  }

  const missingOptional = MASTER_FIELDS.filter(
    (f) => !f.required && map[f.key] === null
  ).map((f) => f.names[0])

  const byPart = new Map()
  let duplicates = 0
  let skipped = 0
  const total = raw.length - headerRow - 1

  for (let r = headerRow + 1; r < raw.length; r++) {
    const src = raw[r]
    if (!src) { skipped++; continue }

    const rec = {}
    for (const f of MASTER_FIELDS) {
      const idx = map[f.key]
      rec[f.key] = idx === null ? null : f.norm(src[idx])
    }

    if (!rec.part_number) { skipped++; continue }

    const existing = byPart.get(rec.part_number)
    if (existing) {
      duplicates++
      // Keep the first row, unless it had no part name and this one does.
      if (!existing.part_name && rec.part_name) byPart.set(rec.part_number, rec)
    } else {
      byPart.set(rec.part_number, rec)
    }

    if (byPart.size % YIELD_EVERY === 0) {
      onProgress?.({ phase: 'parsing', done: byPart.size, total })
      await yieldToBrowser()
    }
  }

  const rows = [...byPart.values()]
  onProgress?.({ phase: 'parsing', done: rows.length, total })
  return { rows, sheetName, headerRow: headerRow + 1, missingOptional, duplicates, skipped }
}
