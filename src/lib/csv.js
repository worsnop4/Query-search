// CSV writing, kept free of any Supabase import so it can be unit-tested in
// plain Node. Quoting bugs here are silent - the file opens, the columns just
// quietly hold the wrong things - so this is the part worth testing directly.

/**
 * RFC 4180: double any quote, and wrap the field if it contains a quote, a
 * comma, or a line break. Everything else is written bare.
 *
 * null and undefined become empty, NOT the text "null" - a blank supplier code
 * must read as blank in Excel.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** One record as a CSV line, columns in the given order. */
export function csvRow(row, columns) {
  return columns.map((c) => csvCell(row[c])).join(',')
}

/** Header line plus every row. Used by the tests; the exporter streams instead. */
export function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => csvRow(r, columns))].join('\n') + '\n'
}
