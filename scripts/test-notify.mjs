// Checks the WhatsApp notification message and its URL encoding.
//
//   node scripts/test-notify.mjs
import { buildUpdateMessage, whatsappUrl, siteUrl } from '../src/lib/notify.js'
import { checker } from './lib.mjs'

const { check, report } = checker()
const WHEN = new Date('2026-08-15T09:45:00Z')

console.log('--- message ---')

const msg = buildUpdateMessage({
  label: 'Query data',
  rows: 194278,
  files: 39,
  seconds: 239,
  who: 'admin1',
  when: WHEN,
  url: 'https://query-search.vercel.app',
})
console.log(msg.split('\n').map((l) => `   | ${l}`).join('\n'))
console.log('')

check('names the dataset', msg.startsWith('Query data updated'), msg.split('\n')[0])
check('row count is grouped', msg.includes('194,278 rows now live'))
check('file count included', msg.includes('from 39 files'))
check('uploader named', msg.includes('admin1'))
check('duration in minutes and seconds', msg.includes('3m 59s'), '239s')
check('site link present', msg.includes('https://query-search.vercel.app'))

// Single file: the "from N files" line would read oddly as "from 1 files".
const single = buildUpdateMessage({
  label: 'Master Data', rows: 18630, files: 1, seconds: 9, who: 'dian.ayu', when: WHEN,
  url: 'https://query-search.vercel.app',
})
check('no file line for a single file', !single.includes('from 1 files'))
check('seconds under a minute stay plain', single.includes('took 9s'), '9s')
check('label follows the target', single.startsWith('Master Data updated'))

// Optional pieces really are optional.
const bare = buildUpdateMessage({ label: 'Query data', rows: 5, when: WHEN })
check('no link line without a url', !bare.toLowerCase().includes('search here'))
check('no duration line at zero seconds', !bare.includes('took'))
check('still reports the rows', bare.includes('5 rows now live'))

console.log('\n--- url encoding ---')

const url = whatsappUrl(msg)
check('points at WhatsApp Web', url.startsWith('https://web.whatsapp.com/send?text='), url.slice(0, 42))
check('no raw newlines in the url', !/[\n\r]/.test(url))
check('no raw spaces in the url', !url.slice(url.indexOf('?')).includes(' '))
check('newlines encoded as %0A', url.includes('%0A'))

const decoded = decodeURIComponent(url.split('?text=')[1])
check('decodes back to exactly the message', decoded === msg,
      decoded === msg ? 'identical' : 'DIFFERS')

// A stray & or # in a message would truncate the query string if unencoded.
const hostile = buildUpdateMessage({
  label: 'Query data', rows: 1, who: 'a&b#c', when: WHEN, url: 'https://x.test/?a=1&b=2',
})
const hostileUrl = whatsappUrl(hostile)
const hostileBack = decodeURIComponent(hostileUrl.split('?text=')[1])
check('ampersand and hash survive encoding', hostileBack === hostile,
      hostileBack === hostile ? 'identical' : 'DIFFERS')
check('no bare & inside the encoded text', !hostileUrl.slice(hostileUrl.indexOf('?text=') + 6).includes('&'))

console.log('\n--- site url ---')
check('returns null outside a browser', siteUrl() === null, String(siteUrl()))

console.log(`\n   full url length: ${url.length} chars`)
check('url is a sane length for a browser', url.length < 2000, `${url.length}`)

report()
