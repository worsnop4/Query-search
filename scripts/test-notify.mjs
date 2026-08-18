// Checks the WhatsApp notification message and its URL encoding.
//
//   node scripts/test-notify.mjs
import { buildUpdateMessage, whatsappUrl, SITE_DOMAIN } from '../src/lib/notify.js'
import { checker } from './lib.mjs'

const { check, report } = checker()

// 09:45 UTC. The formatter is pinned to en-GB and 24h, but NOT to a timezone -
// the stamp is meant to read in the sender's local time, so this test asserts
// the shape rather than a fixed hour.
const WHEN = new Date('2026-08-15T09:45:00Z')

console.log('--- message ---')

const msg = buildUpdateMessage({ label: 'Query', who: 'admin1', when: WHEN })
console.log(msg.split('\n').map((l) => `   | ${l}`).join('\n'))
console.log('')

const lines = msg.split('\n')
check('exactly three lines', lines.length === 3, String(lines.length))
check('first line names the dataset', lines[0] === 'Query updated', lines[0])
check('second line is who and when', /^admin1 · \d{2} \w{3} \d{4}, \d{2}:\d{2}$/.test(lines[1]), lines[1])
check('third line is the domain', lines[2] === SITE_DOMAIN, lines[2])
check('no blank lines', !lines.includes(''), JSON.stringify(lines))

// Day-first and 24-hour regardless of the machine's locale.
check('day comes before the month', /^\d{2} \w{3}/.test(lines[1].split('· ')[1]), lines[1])
check('24-hour clock, no AM/PM', !/[AP]M/i.test(lines[1]), lines[1])

const master = buildUpdateMessage({ label: 'Master Data', who: 'dian.ayu', when: WHEN })
check('label follows the target', master.startsWith('Master Data updated'), master.split('\n')[0])
check('uploader name follows the signed-in admin', master.includes('dian.ayu'), master.split('\n')[1])

// Signed in but no email on the session: the line should collapse, not read " · ".
const anon = buildUpdateMessage({ label: 'Query', who: null, when: WHEN })
check('no dangling separator without a name', !anon.includes('· ') || !anon.split('\n')[1].startsWith('·'),
      anon.split('\n')[1])
check('still three lines without a name', anon.split('\n').length === 3, String(anon.split('\n').length))

check('domain is the public one, not vercel', SITE_DOMAIN === 'querry.online', SITE_DOMAIN)

console.log('--- url encoding ---')

const url = whatsappUrl(msg)
check('points at WhatsApp Web', url.startsWith('https://web.whatsapp.com/send?text='), url.slice(0, 42))
check('no raw newlines in the url', !/[\n\r]/.test(url))
check('no raw spaces in the url', !url.slice(url.indexOf('?')).includes(' '))
check('newlines encoded as %0A', url.includes('%0A'))
check('the middle dot survives', decodeURIComponent(url.split('?text=')[1]).includes('·'))

const decoded = decodeURIComponent(url.split('?text=')[1])
check('decodes back to exactly the message', decoded === msg, decoded === msg ? 'identical' : 'DIFFERS')

// A stray & or # would truncate the query string if it were not encoded.
const hostile = buildUpdateMessage({ label: 'Query', who: 'a&b#c', when: WHEN })
const hostileBack = decodeURIComponent(whatsappUrl(hostile).split('?text=')[1])
check('ampersand and hash survive encoding', hostileBack === hostile,
      hostileBack === hostile ? 'identical' : 'DIFFERS')
check('no bare & inside the encoded text',
      !whatsappUrl(hostile).slice(whatsappUrl(hostile).indexOf('?text=') + 6).includes('&'))

console.log(`\n   full url: ${url}`)
check('url is a sane length for a browser', url.length < 2000, `${url.length} chars`)

report()
