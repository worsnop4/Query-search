import { lazy, Suspense } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
} from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import { useLastUpdate, formatWhen, relativeTime } from './lib/useLastUpdate'
import { useSessionId } from './lib/useAdminPresence'
import { supabase } from './lib/supabase'
import SearchPage from './pages/SearchPage'
import LoginPage from './pages/LoginPage'

// The admin page pulls in SheetJS (~400 kB). Everyone uses search; almost
// nobody uses upload, so load it only when someone actually opens /admin.
const AdminPage = lazy(() => import('./pages/AdminPage'))

// Lazy for the opposite reason: the cycle count is used on a phone in the
// warehouse and must not drag SheetJS along behind it.
const CycleCountPage = lazy(() => import('./pages/CycleCountPage'))

// Also lazy: it pulls SheetJS and fflate only when someone builds the file.
const BreakdownPage = lazy(() => import('./pages/BreakdownPage'))

const nf = new Intl.NumberFormat()

function RequireAuth({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <p className="muted">Checking sign in...</p>
  if (!session) return <LoginPage />
  return children
}

function LastUpdate() {
  const { info, loading, error } = useLastUpdate('inventory')

  // Say nothing if the read failed - claiming "no data" when we simply could
  // not reach the database is worse than showing nothing.
  if (loading || (!info && error)) return <div className="lastupdate" />
  if (!info) {
    return (
      <div className="lastupdate">
        <span className="muted small">No data loaded yet</span>
      </div>
    )
  }

  return (
    <div className="lastupdate" title={`${nf.format(info.row_count)} rows loaded by ${info.uploaded_email ?? 'unknown'}`}>
      <span className="muted small">Last update</span>
      <strong className="small">{formatWhen(info.uploaded_at)}</strong>
      <span className="muted small">
        {relativeTime(info.uploaded_at)} &middot; {nf.format(info.row_count)} rows
      </span>
    </div>
  )
}

function TopBar() {
  const { session } = useAuth()
  const location = useLocation()
  const sessionId = useSessionId()
  const onAdmin = location.pathname.startsWith('/admin')
  const onCount = location.pathname.startsWith('/cycle-count')

  // Drop the presence row before the token goes away - admin_release needs a
  // valid session to identify the caller, so it cannot be done afterwards.
  // An upload in flight is left alone; that row ages out on its own.
  async function signOut() {
    await supabase.rpc('admin_release', { p_session_id: sessionId })
    await supabase.auth.signOut()
  }

  return (
    <header className="topbar">
      <div className="brand">
        <h1>
          <Link to="/">Query Search</Link>
        </h1>
        <p className="sub">Search warehouse stock by part number.</p>
      </div>

      <div className="topactions">
        <LastUpdate />

        {onAdmin || onCount ? (
          <Link className="btn ghost" to="/">
            &larr; Back to search
          </Link>
        ) : (
          <Link className="btn" to="/admin">
            Update query
          </Link>
        )}

        {/* Cycle count is deliberately NOT offered here. The search page is
            public and belongs to the operation team; the count is an admin job
            and is reached from the admin page, once signed in. */}
        {onCount && (
          <Link className="btn ghost" to="/admin">
            Admin
          </Link>
        )}

        {session && (
          <button
            type="button"
            className="ghost small"
            onClick={signOut}
            title={session.user.email}
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  )
}

function Layout({ children }) {
  return (
    <div className="app">
      <TopBar />
      {children}
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<SearchPage />} />
            <Route
              path="/admin"
              element={
                <RequireAuth>
                  <Suspense fallback={<p className="muted">Loading uploader...</p>}>
                    <AdminPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route
              path="/cycle-count"
              element={
                <RequireAuth>
                  <Suspense fallback={<p className="muted">Loading cycle count...</p>}>
                    <CycleCountPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route
              path="/breakdown"
              element={
                <RequireAuth>
                  <Suspense fallback={<p className="muted">Loading breakdown...</p>}>
                    <BreakdownPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthProvider>
  )
}
