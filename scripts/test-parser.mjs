// Runs the real browser parser (src/lib/parse.js) against the actual WMS
// exports, checking that header-name mapping survives the shifting layouts.
//
//   node scripts/test-parser.mjs                  # the fallback paths below
//   node scripts/test-parser.mjs ~/data           # every workbook in a folder
//   node scripts/test-parser.mjs a.xlsm b.xlsm    # specific files
//
// Point it at the master data with --master=/path/to.xlsb or $QUERY_MASTER.
import { parseInventory, parseMasterData } from '../src/lib/parse.js'
import { fileFrom, checker, resolveWorkbooks, namedFile, noDataMessage } from './lib.mjs'

const { check, report } = checker()

// Where the data sits on the machine it was captured on. Overridable - see
// the header above - so this test is runnable anywhere the files are.
const FALLBACK_INVENTORY = [
  'C:/Users/INV-ENGINEER/Downloads/Query - 14-08-2026 (08.20).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 13-08-2026 (08.20).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query -12-08-2026 (07.36).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 11-08-2026 (08.02).xlsm',
  'C:/Users/INV-ENGINEER/Downloads/Query - 07-08-2026 (13.10).xlsm',
  'D:/project/template querry upload.xlsm',
]
const FALLBACK_MASTER = 'D:/project/PFEP Simple Master Data_12 Aug 2026.xlsb'

const INVENTORY_FILES = resolveWorkbooks(FALLBACK_INVENTORY)
const MASTER = namedFile('master', 'QUERY_MASTER', FALLBACK_MASTER)

if (INVENTORY_FILES.length === 0 && !MASTER) {
  console.error(noDataMessage('workbooks'))
  process.exit(1)
}

const ZONE_TYPES = new Set([
  'DLOC Area', 'Stock Area-LOC', 'OF Area', 'Stock Area-Temp',
  'Stock Area A', 'Stock Area-OW', 'Hold Area',
])

for (const path of INVENTORY_FILES) {
  const name = path.split(/[\\/]/).pop()
  console.log(`\n=== ${name}`)

  const t0 = Date.now()
  let out
  try {
    out = await parseInventory(fileFrom(path))
  } catch (err) {
    check('parsed without throwing', false, err.message)
    continue
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const first = out.rows[0]
  console.log(`   sheet='${out.sheetName}' headerRow=${out.headerRow} rows=${out.rows.length.toLocaleString()} skipped=${out.skipped} in ${secs}s`)
  if (out.missingOptional.length) console.log(`   optional missing: ${out.missingOptional.join(', ')}`)

  // The whole point: no matter which layout, fields must land correctly.
  check('part_number looks like a part number', /^[A-Z0-9][A-Z0-9\-/]*$/.test(first.part_number ?? ''), first.part_number)
  check('quantity is numeric', typeof first.quantity === 'number', String(first.quantity))
  check('zone_type is a known value', ZONE_TYPES.has(first.zone_type), first.zone_type)

  // If columns had shifted, Status ("Available") would land here instead.
  const opened = new Set(out.rows.slice(0, 50000).map((r) => r.is_case_opened))
  check('is_case_opened is only Yes/No', [...opened].every((v) => v === 'Yes' || v === 'No'), [...opened].join(','))

  const statuses = new Set(out.rows.slice(0, 50000).map((r) => r.status))
  check('status is not a Yes/No value', ![...statuses].some((v) => v === 'Yes' || v === 'No'), [...statuses].join(','))

  const ts = first.inbound_time
  check('inbound_time parsed', ts === null || /^\d{4}-\d{2}-\d{2}/.test(String(ts)), String(ts))

  // The WMS writes local time with no offset, and these columns are
  // timestamptz - so without an offset Postgres reads them as UTC and every
  // value lands seven hours early. Harmless while nothing showed a date; the
  // transit monitor ages cases in whole DAYS, and 15.6% of the rows sitting at
  // TRANSIT carry a stored hour of 17:00 or later, which would tip them onto
  // the wrong calendar day.
  const stamps = out.rows.slice(0, 20000)
    .flatMap((r) => [r.inbound_time, r.first_inbound_time])
    .filter(Boolean)
  const zoned = stamps.filter((s) => /(?:Z|[+-]\d{2}:\d{2})$/.test(String(s)))
  check('every timestamp carries a zone', zoned.length === stamps.length,
        `${stamps.length - zoned.length} of ${stamps.length} without one`)
  check('and it is WIB (+07:00)',
        stamps.every((s) => String(s).endsWith('+07:00')),
        String(stamps[0]))
  // The offset must shift the instant, not just decorate the text.
  const asInstant = new Date(stamps[0])
  check('which really moves the instant back 7 hours',
        asInstant.toISOString().slice(11, 13) ===
          String((Number(String(stamps[0]).slice(11, 13)) + 17) % 24).padStart(2, '0'),
        `${stamps[0]} -> ${asInstant.toISOString()}`)

  const blankPn = out.rows.filter((r) => !r.part_number).length
  check('no blank part numbers', blankPn === 0, String(blankPn))
}

// ---- master data ----
if (MASTER) {
  console.log(`\n=== ${MASTER.split(/[\\/]/).pop()}`)
  const t0 = Date.now()
  const out = await parseMasterData(fileFrom(MASTER))
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`   sheet='${out.sheetName}' headerRow=${out.headerRow} rows=${out.rows.length.toLocaleString()} dupes=${out.duplicates} in ${secs}s`)

  const f = out.rows[0]
  console.log(`   first row: ${JSON.stringify(f)}`)
  // The exact count only means something for the file it was recorded from;
  // against any other master file it would be a guaranteed failure.
  if (MASTER === FALLBACK_MASTER) {
    check('18630 rows', out.rows.length === 18630, String(out.rows.length))
  } else {
    check('parsed a plausible number of rows', out.rows.length > 1000, String(out.rows.length))
  }
  check('part_name present', !!f.part_name, f.part_name)

  // "OLD DLOC" and "NEW DLOC" sit next to each other in the file, so verify
  // exactly - read the sheet independently and compare column by column
  // rather than guessing from the value's shape.
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await fileFrom(MASTER).arrayBuffer(), { type: 'array', dense: true })
  const grid = XLSX.utils.sheet_to_json(wb.Sheets.MASDAT, { header: 1, raw: true, defval: null, blankrows: true })
  // Use the header row the parser actually found rather than assuming row 3,
  // so this cross-check still lines up if the file's preamble changes.
  const hdrIdx = out.headerRow - 1
  const hdr = (grid[hdrIdx] ?? []).map((h) => String(h ?? '').replace(/\s+/g, ' ').trim().toUpperCase())
  const iNew = hdr.indexOf('NEW DLOC')
  const iOld = hdr.indexOf('OLD DLOC')
  const iPn = hdr.indexOf('PART NUMBER')
  console.log(`   column indices: PART NUMBER=${iPn} OLD DLOC=${iOld} NEW DLOC=${iNew}`)

  const truth = new Map()
  for (let r = hdrIdx + 1; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const pn = row[iPn]
    if (pn === null || pn === undefined || String(pn).trim() === '') continue
    const key = typeof pn === 'number' ? BigInt(pn).toString() : String(pn).trim()
    if (!truth.has(key)) truth.set(key, { neu: row[iNew], old: row[iOld] })
  }

  let wrong = 0, matchedOld = 0
  for (const r of out.rows) {
    const t = truth.get(r.part_number)
    if (!t) continue
    const expect = t.neu === null || String(t.neu).trim() === '' ? null : String(t.neu).trim()
    if (r.dloc !== expect) {
      wrong++
      const oldVal = t.old === null ? null : String(t.old).trim()
      if (r.dloc === oldVal) matchedOld++
    }
  }
  check('dloc matches NEW DLOC exactly', wrong === 0, `${wrong} mismatches (${matchedOld} equal to OLD DLOC)`)
}

report()
