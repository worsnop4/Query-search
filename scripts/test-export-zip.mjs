// Proves the exported archive is a real, openable zip whose contents survive
// the round trip byte for byte.
//
// The failure this guards against is quiet: a malformed central directory or a
// wrong CRC still produces a file, and it still downloads. It only fails when
// someone tries to open it - by which time the export looks like the thing that
// works and the recipient looks like the problem.
//
//   node scripts/test-export-zip.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { csvRow } from '../src/lib/csv.js'
import {
  EXPORT_COLUMNS,
  zipCsv,
  exportCsvName,
  exportFileName,
} from '../src/lib/exportFormat.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

// Same rows the real exporter would emit, including the awkward ones.
const ROWS = [
  { part_number: '23588931', supplier_code: '8020019', case_no: 'CR-JAN-2025-558&-', location: 'AREA-HIGH-VALUE', zone_type: 'Stock Area-Temp', quantity: 56, status: 'Available', is_case_opened: 'No', inbound_time: '2026-01-11 19:10:32', first_inbound_time: '2026-01-11 19:10:32' },
  { part_number: '11559571-PMC', supplier_code: null, case_no: 'PALET OF 2026 1320&-', location: 'LHO-LL13-202', zone_type: 'OF Area', quantity: 500, status: 'Available', is_case_opened: 'Yes', inbound_time: null, first_inbound_time: null },
  { part_number: '1261/1262', supplier_code: '8020020', case_no: 'CASE, WITH COMMA', location: 'SAYS "QUOTED"', zone_type: 'DLOC Area', quantity: 0, status: 'Available', is_case_opened: 'No', inbound_time: '2026-02-01 08:00:00', first_inbound_time: '2026-02-01 08:00:00' },
]

const csvText =
  '﻿' +
  EXPORT_COLUMNS.join(',') + '\n' +
  ROWS.map((r) => csvRow(r, EXPORT_COLUMNS)).join('\n') + '\n'

const csvBytes = new Uint8Array(Buffer.from(csvText, 'utf8'))

const innerName = exportCsvName(new Date('2026-08-15T16:45:00'))
const zipped = await zipCsv(innerName, csvBytes)

console.log('--- names ---')
const outer = exportFileName(new Date('2026-08-15T16:45:00'))
console.log(`   archive : ${outer}`)
console.log(`   inside  : ${innerName}`)
check('archive is a .zip', outer.endsWith('.zip'), outer)
check('the entry inside is a .csv', innerName.endsWith('.csv'), innerName)
check('names share the same timestamp',
      outer.replace(/\.zip$/, '') === innerName.replace(/\.csv$/, ''), `${outer} / ${innerName}`)

console.log('\n--- container ---')
// Local file header magic. If this is wrong nothing will open the file.
check('starts with the PK local file header',
      zipped[0] === 0x50 && zipped[1] === 0x4b && zipped[2] === 0x03 && zipped[3] === 0x04,
      [...zipped.slice(0, 4)].map((b) => b.toString(16)).join(' '))
// Three rows do not compress - zip headers cost about 100 bytes and there is
// nothing to find. Size is asserted further down on a realistic payload.
console.log(`   ${zipped.length} bytes from ${csvBytes.length} (too small to compress; see below)`)

console.log('\n--- round trip ---')
const back = unzipSync(zipped)
const entries = Object.keys(back)
check('exactly one entry', entries.length === 1, entries.join(', '))
check('entry keeps its name', entries[0] === innerName, entries[0])

const backBytes = back[innerName]
const identical =
  backBytes.length === csvBytes.length && backBytes.every((b, i) => b === csvBytes[i])
check('content is byte-identical', identical,
      identical ? 'identical' : `${backBytes.length} vs ${csvBytes.length} bytes`)

console.log('\n--- the CSV inside is still a correct CSV ---')
// Compared as BYTES. strFromU8 decodes with TextDecoder, which silently strips
// a leading BOM - checking the decoded string would report the BOM missing
// even when it is present, which is exactly what it did on the first run.
check('BOM survived, inside the entry rather than on the zip',
      backBytes[0] === 0xef && backBytes[1] === 0xbb && backBytes[2] === 0xbf,
      [...backBytes.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(' '))

const lines = strFromU8(backBytes).replace(/^﻿/, '').trimEnd().split('\n')
check('header plus every row', lines.length === ROWS.length + 1, String(lines.length))
check('header matches the export columns', lines[0] === EXPORT_COLUMNS.join(','), lines[0])
check('a comma inside a value stays quoted', lines[3].includes('"CASE, WITH COMMA"'), lines[3])
check('embedded quotes are doubled', lines[3].includes('"SAYS ""QUOTED"""'), lines[3])
check('a null renders empty, not the text null', lines[2].split(',')[1] === '', `"${lines[2].split(',')[1]}"`)
check('quantity zero is not dropped', lines[3].includes(',0,'), lines[3])
check('part number with a slash survives', lines[3].startsWith('1261/1262'), lines[3].slice(0, 12))

// Compression only means anything at real size. 20,000 rows of the same shape
// as the live table - highly repetitive locations, case prefixes and zone
// types, which is exactly what deflate eats.
console.log('\n--- does it actually compress at real size? ---')
const bigRows = []
for (let i = 0; i < 20000; i++) {
  bigRows.push({
    ...ROWS[i % ROWS.length],
    case_no: `CR-JAN-2026-${String(i % 900).padStart(3, '0')}&-`,
    quantity: (i % 50) * 6,
  })
}
const bigCsv =
  '﻿' + EXPORT_COLUMNS.join(',') + '\n' +
  bigRows.map((r) => csvRow(r, EXPORT_COLUMNS)).join('\n') + '\n'
const bigBytes = new Uint8Array(Buffer.from(bigCsv, 'utf8'))

const t0 = Date.now()
const bigZip = await zipCsv(exportCsvName(), bigBytes)
const secs = (Date.now() - t0) / 1000
const pct = (100 * bigZip.length) / bigBytes.length

console.log(
  `   ${(bigBytes.length / 1048576).toFixed(1)} MB -> ` +
    `${(bigZip.length / 1048576).toFixed(2)} MB  (${pct.toFixed(1)}%)  in ${secs.toFixed(1)}s`
)
check('compresses to under a fifth of the CSV', pct < 20, `${pct.toFixed(1)}%`)

const bigBack = unzipSync(bigZip)
const bigEntry = bigBack[Object.keys(bigBack)[0]]
check('20k rows survive the round trip',
      bigEntry.length === bigBytes.length && bigEntry.every((b, i) => b === bigBytes[i]),
      `${bigEntry.length} vs ${bigBytes.length} bytes`)

// unzipSync above proves fflate can read its own output, which is weaker than
// it sounds. Write the file out so the operating system can be asked too - the
// only opinion that matters is the one on the user's machine:
//
//   Expand-Archive -Path <the path below> -DestinationPath .\out
//
// Verified 15 Aug 2026: Windows extracted it without complaint, and the
// extracted CSV still began EF BB BF.
console.log('\n--- for checking against Windows itself ---')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipcheck-'))
const zipPath = path.join(dir, outer)
fs.writeFileSync(zipPath, zipped)
console.log(`   wrote ${zipPath}`)

report()
