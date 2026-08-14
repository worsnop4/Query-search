import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill in the values from ' +
      'Supabase Dashboard -> Project Settings -> API Keys.'
  )
}

export const supabase = createClient(url, key, {
  auth: {
    // Admins stay logged in across reloads - an upload takes minutes and
    // must survive an accidental refresh.
    persistSession: true,
    autoRefreshToken: true,
  },
})
