// Shape and packaging of the export file. Deliberately free of any Supabase
// import - `supabase.js` reads `import.meta.env`, which only exists under Vite,
// so anything that touches it cannot be run or tested in plain Node. Same
// reasoning as csv.js.
//
// The failures this module can produce are the quiet kind: a malformed zip
// still downloads and still looks like a file. It only goes wrong when someone
// tries to open it, by which point the export looks fine and the recipient
// looks like the problem. So it is kept testable.

import { zip } from 'fflate'

// The ten columns the parser imports (INVENTORY_FIELDS in parse.js). No `id`,
// which is a database artifact, and none of the columns Postgres computes
// during the swap - the file mirrors what was uploaded.
export const EXPORT_COLUMNS = [
  'part_number',
  'supplier_code',
  'case_no',
  'location',
  'zone_type',
  'quantity',
  'status',
  'is_case_opened',
  'inbound_time',
  'first_inbound_time',
]

// Measured on a real 194,731-row export:
//
//   CSV        24.1 MB   0.2s
//   CSV.zip     1.8 MB    22s     <- 7.6% of the CSV
//   XLSX       23.9 MB   150s
//   XLSB          did not finish in over 7 minutes
//
// The Excel binary formats are not the answer here. .xlsx is itself a zip
// container, but its XML is so verbose that compressing it lands back where
// the plain CSV started - 0.2 MB saved for 150 seconds of work, and this runs
// in a browser tab rather than on a server. Zipping the CSV instead is 13x
// smaller, and .zip opens natively on Windows: double-click, and Excel opens
// the CSV inside.
//
// Level 6 rather than 9: on this data 9 saves under 2% for roughly twice the
// time, and that time is spent on the user's main thread.
const ZIP_LEVEL = 6

/** fflate's zip() is callback-based; wrap it so callers can await. */
export function zipCsv(name, bytes, mtime = new Date()) {
  return new Promise((resolve, reject) => {
    zip({ [name]: bytes }, { level: ZIP_LEVEL, mtime }, (err, out) =>
      err
        ? reject(new Error(`Could not compress the file: ${err.message}`))
        : resolve(out)
    )
  })
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`
  )
}

/** The name of the CSV *inside* the archive. */
export function exportCsvName(now = new Date()) {
  return `inventory-${stamp(now)}.csv`
}

/** The name of the file the browser saves. */
export function exportFileName(now = new Date()) {
  return `inventory-${stamp(now)}.zip`
}
