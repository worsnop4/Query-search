import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useActiveAdmins, listNames } from '../lib/useAdminPresence'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Who is already in there, so you know who to ask before you start. Signing
  // in is never blocked - only uploading the same table at the same time is.
  const { admins } = useActiveAdmins()
  const uploading = admins.filter((a) => a.status === 'uploading')

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) setError(err.message)
    setBusy(false)
    // On success the AuthProvider picks up the session and this page unmounts.
  }

  return (
    <div className="login">
      <h2>Admin sign in</h2>
      <p className="muted small">
        Uploading requires an account. Accounts are created by an administrator
        in Supabase &mdash; there is no public sign-up.
      </p>

      {admins.length > 0 && (
        <div className="roster">
          <span className="muted small">Signed in now</span>
          {admins.map((a) => (
            <span
              key={a.session_id}
              className={`chip${a.status === 'uploading' ? ' busy' : ''}`}
            >
              {a.display_name}
            </span>
          ))}
          {uploading.length > 0 && (
            <span className="muted small">
              {listNames(uploading)} updating data
            </span>
          )}
        </div>
      )}

      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />

        <label htmlFor="pw">Password</label>
        <input
          id="pw"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}