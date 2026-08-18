// Telling the team the data has been refreshed.
//
// WhatsApp cannot be deep-linked to a GROUP. Its click-to-chat URLs accept a
// phone number or no recipient at all, and nothing else - group chats have no
// addressable id in that scheme. The chat.whatsapp.com/<code> links are invite
// links: following one offers to JOIN the group, it does not open a compose box.
//
// So the most that can be automated is the message itself. WhatsApp Web opens
// with the text ready and the person picks the group from their chat list.

const WHATSAPP_WEB = 'https://web.whatsapp.com/send'

// The public address to share, hardcoded rather than read from
// window.location. An admin uploading from a vercel.app preview URL - or from
// localhost - would otherwise send the team a link only they can use.
export const SITE_DOMAIN = 'querry.online'

// en-GB, not the machine locale: this produces "15 Aug 2026, 16:45" everywhere.
// The default locale would render "Aug 15, 2026, 04:45 PM" on a US-configured
// machine, so the message would change shape depending on who pressed the
// button.
const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * Three lines, deliberately short - it is a notification, not a report:
 *
 *   Query updated
 *   admin1 · 15 Aug 2026, 16:45
 *   querry.online
 *
 * Plain text on purpose. WhatsApp renders *bold* from asterisks, but they show
 * up as literal asterisks anywhere else the message gets pasted.
 */
export function buildUpdateMessage({
  label,
  who = null,
  when = new Date(),
  domain = SITE_DOMAIN,
}) {
  const lines = [`${label} updated`]

  const by = [who, STAMP.format(when)].filter(Boolean).join(' · ')
  if (by) lines.push(by)

  if (domain) lines.push(domain)

  return lines.join('\n')
}

/** WhatsApp Web, message pre-filled, recipient chosen by the sender. */
export function whatsappUrl(text) {
  return `${WHATSAPP_WEB}?text=${encodeURIComponent(text)}`
}
