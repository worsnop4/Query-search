import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

// The server treats a session as gone 90s after its last heartbeat, so beating
// every 30s tolerates two missed beats before an admin is wrongly declared
// absent. Reading is cheaper than beating and only drives the display, so it
// can run more often.
const HEARTBEAT_MS = 30_000
const POLL_MS = 15_000

const SESSION_KEY = 'query-admin-session-id'

// One id per browser TAB - sessionStorage is per-tab by definition, and unlike
// a module-level constant it survives a reload, so refreshing the page does
// not strand the previous row for 90 seconds.
function tabSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

export function useSessionId() {
  const ref = useRef(null)
  if (ref.current === null) ref.current = tabSessionId()
  return ref.current
}

/**
 * Who is on the admin page right now. Readable without signing in - the login
 * page shows it - so this hits the `active_admins` view, which exposes
 * the display name and status only, never emails.
 */
export function useActiveAdmins(pollMs = POLL_MS) {
  const [admins, setAdmins] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('active_admins')
      .select('session_id, display_name, status, target, started_at')
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setAdmins(data ?? [])
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, pollMs)

    // A hidden tab does not need to poll, and browsers throttle its timers
    // anyway - so refresh immediately on the way back rather than showing a
    // stale roster until the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, pollMs])

  return { admins, error, refresh: load }
}

/**
 * Announce this tab as present while `enabled`, and report who else is here.
 *
 * `enabled` should be true only on the admin page and only when signed in -
 * the heartbeat RPC requires a session.
 */
export function useAdminPresence(enabled) {
  const sessionId = useSessionId()
  const { admins, refresh } = useActiveAdmins()

  useEffect(() => {
    if (!enabled) return
    let alive = true

    const beat = async () => {
      if (!alive) return
      const { error } = await supabase.rpc('admin_heartbeat', { p_session_id: sessionId })
      // A failed beat is not worth interrupting the admin over: the row ages
      // out, presence disappears, and the upload path checks the claim itself.
      if (error && import.meta.env.DEV) console.warn('heartbeat failed:', error.message)
    }

    beat().then(refresh)
    const id = setInterval(beat, HEARTBEAT_MS)

    const release = () => {
      // Fire and forget. If the page dies before this lands, the row ages out
      // on its own - which is also why it is safe not to await it here.
      supabase.rpc('admin_release', { p_session_id: sessionId })
    }
    window.addEventListener('pagehide', release)

    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('pagehide', release)
      release()
    }
  }, [enabled, sessionId, refresh])

  const others = admins.filter((a) => a.session_id !== sessionId)

  // Who, if anyone, is uploading a given table right now - excluding us.
  const uploaderOf = useCallback(
    (target) => others.find((a) => a.status === 'uploading' && a.target === target) ?? null,
    [others]
  )

  return { sessionId, admins, others, uploaderOf, refresh }
}

/** "dian.ayu", "dian.ayu and dian.fitri", "a, b and 2 others" */
export function listNames(list) {
  const names = list.map((a) => a.display_name)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}
