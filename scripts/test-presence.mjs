// End-to-end test of admin presence and the upload claim, using two real
// accounts against live Supabase. Run AFTER 05_admin_presence.sql.
//
// Credentials come from the environment - never commit them:
//
//   ADMIN_A_EMAIL=... ADMIN_A_PASSWORD=... \
//   ADMIN_B_EMAIL=... ADMIN_B_PASSWORD=... \
//   node --env-file=.env scripts/test-presence.mjs
//
// SAFE TO RUN: it claims, inspects and releases. It never calls swap_*(), so
// live inventory and master_data are never touched. It does truncate the
// STAGING tables, which are empty between uploads anyway.
import { createClient } from '@supabase/supabase-js'
import { checker } from './lib.mjs'

const { check, report } = checker()

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY

const A = { email: process.env.ADMIN_A_EMAIL, password: process.env.ADMIN_A_PASSWORD }
const B = { email: process.env.ADMIN_B_EMAIL, password: process.env.ADMIN_B_PASSWORD }

if (!URL || !KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Use --env-file=.env')
  process.exit(1)
}
if (!A.email || !A.password || !B.email || !B.password) {
  console.error(
    'Set ADMIN_A_EMAIL, ADMIN_A_PASSWORD, ADMIN_B_EMAIL and ADMIN_B_PASSWORD.\n' +
      'Two DIFFERENT admin accounts are required - the whole point is one\n' +
      'blocking the other.'
  )
  process.exit(1)
}

// Separate clients so each holds its own session, exactly like two browsers.
function client() {
  return createClient(URL, KEY, { auth: { persistSession: false } })
}

async function signIn(who, label) {
  const sb = client()
  const { error } = await sb.auth.signInWithPassword(who)
  if (error) {
    console.error(`Could not sign in ${label} (${who.email}): ${error.message}`)
    process.exit(1)
  }
  return sb
}

const sbA = await signIn(A, 'admin A')
const sbB = await signIn(B, 'admin B')

const sidA = crypto.randomUUID()
const sidB = crypto.randomUUID()

const rpc = (sb, fn, args) => sb.rpc(fn, args)

async function cleanup() {
  await rpc(sbA, 'release_upload', { p_session_id: sidA })
  await rpc(sbB, 'release_upload', { p_session_id: sidB })
  await rpc(sbA, 'admin_release', { p_session_id: sidA })
  await rpc(sbB, 'admin_release', { p_session_id: sidB })
}

try {
  // --- presence ------------------------------------------------------------
  console.log('--- presence ---')

  await rpc(sbA, 'admin_heartbeat', { p_session_id: sidA })
  await rpc(sbB, 'admin_heartbeat', { p_session_id: sidB })

  const seen = await sbA.from('active_admins').select('session_id, display_name, status, target')
  check('active_admins readable', !seen.error, seen.error?.message ?? '')

  const rows = seen.data ?? []
  const rowA = rows.find((r) => r.session_id === sidA)
  const rowB = rows.find((r) => r.session_id === sidB)

  check('both sessions present', !!rowA && !!rowB, `${rows.length} rows`)
  check('display names derived', !!rowA?.display_name && !!rowB?.display_name,
        `${rowA?.display_name} / ${rowB?.display_name}`)
  check('names distinguish the two admins', rowA?.display_name !== rowB?.display_name,
        `${rowA?.display_name} vs ${rowB?.display_name}`)
  // The domain must stay off a page anonymous visitors can reach.
  check('name carries no domain', !rowA?.display_name?.includes('@'), rowA?.display_name)
  check('start out viewing', rowA?.status === 'viewing' && rowB?.status === 'viewing',
        `${rowA?.status} / ${rowB?.status}`)

  // The view must never leak the email or the user id.
  const full = await sbA.from('active_admins').select('*')
  const allCols = Object.keys(full.data?.[0] ?? {})
  check('view exposes no email', !allCols.includes('email'), allCols.join(','))
  check('view exposes no user_id', !allCols.includes('user_id'), allCols.join(','))

  // Anonymous visitors see the roster too - that is the login page.
  const anon = createClient(URL, KEY, { auth: { persistSession: false } })
  const anonSee = await anon.from('active_admins').select('display_name, status')
  check('anon can read the roster', !anonSee.error && (anonSee.data?.length ?? 0) > 0,
        anonSee.error?.message ?? `${anonSee.data?.length} rows`)
  const anonRaw = await anon.from('admin_session').select('*')
  check('anon CANNOT read the base table', !!anonRaw.error || (anonRaw.data?.length ?? 0) === 0,
        anonRaw.error?.message ?? `${anonRaw.data?.length} rows leaked`)

  // --- the claim -----------------------------------------------------------
  console.log('\n--- claim ---')

  const claimA = await rpc(sbA, 'claim_upload', { p_session_id: sidA, p_target: 'inventory' })
  check('A claims inventory', !claimA.error, claimA.error?.message ?? 'ok')

  const claimB = await rpc(sbB, 'claim_upload', { p_session_id: sidB, p_target: 'inventory' })
  check('B is refused the same target', !!claimB.error,
        claimB.error?.message ?? 'NOT REFUSED - both admins hold inventory')
  check('refusal names the holder', (claimB.error?.message ?? '').includes(rowA?.display_name ?? ' '),
        claimB.error?.message ?? '')

  const claimBm = await rpc(sbB, 'claim_upload', { p_session_id: sidB, p_target: 'master_data' })
  check('B may claim a DIFFERENT target', !claimBm.error, claimBm.error?.message ?? 'ok')

  // --- server-side enforcement --------------------------------------------
  // The real test: bypass the UI entirely and call the upload RPCs directly.
  console.log('\n--- enforcement (bypassing the UI) ---')

  const resetB = await rpc(sbB, 'reset_inventory_staging', { p_session_id: sidB })
  check('B cannot reset inventory staging', !!resetB.error,
        resetB.error?.message ?? 'NOT BLOCKED - the lock is cosmetic')

  const resetA = await rpc(sbA, 'reset_inventory_staging', { p_session_id: sidA })
  check('A, who holds it, can', !resetA.error, resetA.error?.message ?? 'ok')

  const forged = await rpc(sbB, 'reset_inventory_staging', { p_session_id: sidA })
  check('B cannot borrow A\'s session id', !!forged.error,
        forged.error?.message ?? 'NOT BLOCKED - session id alone grants access')

  const swapNoClaim = await rpc(sbB, 'swap_inventory', {
    expected_rows: 1, p_session_id: sidB,
  })
  check('swap refuses without a claim', !!swapNoClaim.error,
        swapNoClaim.error?.message ?? 'NOT BLOCKED')

  // --- handover ------------------------------------------------------------
  console.log('\n--- handover ---')

  await rpc(sbA, 'release_upload', { p_session_id: sidA })
  const claimB2 = await rpc(sbB, 'claim_upload', { p_session_id: sidB, p_target: 'inventory' })
  check('B gets it once A releases', !claimB2.error, claimB2.error?.message ?? 'ok')

  // --- cleanup semantics ---------------------------------------------------
  console.log('\n--- release semantics ---')

  const midUpload = await rpc(sbB, 'admin_release', { p_session_id: sidB })
  check('admin_release call succeeds', !midUpload.error, midUpload.error?.message ?? 'ok')
  const still = await sbB.from('active_admins').select('session_id, status').eq('session_id', sidB)
  check('but will NOT drop a row mid-upload', (still.data?.length ?? 0) === 1,
        `${still.data?.length} rows - an uploading session must age out, not vanish`)
} finally {
  await cleanup()
  await sbA.auth.signOut()
  await sbB.auth.signOut()
}

report()
