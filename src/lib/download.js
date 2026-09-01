// Handing a Blob to the browser as a file.
//
// Split out of export.js so a page can offer a download without importing that
// module, which pulls in supabase.js, fflate and the whole inventory paging
// machinery. The cycle count only needs these six lines.

/** Hand the blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the download a tick to start before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Save text as a CSV file.
 *
 * The BOM is what makes Excel read it as UTF-8 on a double click - without it
 * a case number containing anything non-ASCII arrives as mojibake.
 */
export function saveCsv(text, filename) {
  saveBlob(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }), filename)
}
