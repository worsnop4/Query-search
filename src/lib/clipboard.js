// Copying search results to the clipboard.
//
// Tab-separated, not comma-separated: pasting TSV into Excel, Google Sheets or
// a WhatsApp/Teams message splits straight into columns with no import dialog,
// which is the whole point of the button. CSV pasted into Excel lands in one
// column until you run Text to Columns.
//
// Because the separator is a tab, a value containing a tab or a newline would
// silently shift every column after it. Rather than quote (Excel's paste does
// not honour quoting the way its CSV import does), collapse whitespace: the
// values here are part numbers, case numbers and locations, none of which
// legitimately contain either.

export function tsvCell(v) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/[\t\r\n]+/g, ' ').trim()
}

export function toTsv(headers, rows, columns) {
  const lines = [headers.join('\t')]
  for (const r of rows) lines.push(columns.map((c) => tsvCell(r[c])).join('\t'))
  return lines.join('\n')
}

/**
 * Write text to the clipboard.
 *
 * The async Clipboard API needs a secure context - it is undefined on plain
 * http, which an internal site served by IP could well be. The textarea
 * fallback is deprecated but still works everywhere, so try the good path and
 * keep the old one for when it is missing.
 */
export async function writeClipboard(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // Off-screen but focusable; display:none would not be selectable.
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()

  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    ta.remove()
  }

  if (!ok) {
    throw new Error(
      'This browser would not let the page copy. Select the table and use Ctrl+C instead.'
    )
  }
}
