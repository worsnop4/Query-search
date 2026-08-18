// Telling the team the data has been refreshed.
//
// WhatsApp cannot be deep-linked to a GROUP. Its click-to-chat URLs accept a
// phone number or no recipient at all, and nothing else - group chats have no
// addressable id in that scheme. The chat.whatsapp.com/<code> links are invite
// links: following one offers to JOIN the group, it does not open a compose box.
//
// So the most that can be automated is the message itself. WhatsApp Web opens
// with the text ready and the person picks the group from their chat list.
// That still removes the part people get wrong - retyping the row count and
// the timestamp.

const WHATSAPP_WEB = 'https://web.whatsapp.com/send'

/**
 * The message body. Deliberately plain text: WhatsApp renders *bold* with
 * asterisks, but those become literal asterisks anywhere else the message is
 * pasted, and this is short enough not to need them.
 */
export function buildUpdateMessage({
  label,
  rows,
  files = 1,
  seconds = 0,
  who = null,
  when = new Date(),
  url = null,
}) {
  const nf = new Intl.NumberFormat()

  const stamp = when.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const lines = [`${label} updated`, '']
  lines.push(`${nf.format(rows)} rows now live`)
  if (files > 1) lines.push(`from ${nf.format(files)} files`)

  const by = [who, stamp].filter(Boolean).join(' · ')
  if (by) lines.push(by)

  if (seconds > 0) lines.push(`took ${formatSeconds(seconds)}`)

  if (url) {
    lines.push('')
    lines.push(`Search here: ${url}`)
  }

  return lines.join('\n')
}

function formatSeconds(s) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

/** WhatsApp Web, message pre-filled, recipient chosen by the sender. */
export function whatsappUrl(text) {
  return `${WHATSAPP_WEB}?text=${encodeURIComponent(text)}`
}

/** Where the site lives, for the link inside the message. */
export function siteUrl() {
  if (typeof window === 'undefined') return null
  // Skip the link on localhost - it would be useless to anyone receiving it.
  const { origin, hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return null
  return origin
}
