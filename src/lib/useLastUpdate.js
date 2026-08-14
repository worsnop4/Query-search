import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

// Fired by the admin page after a successful swap so the header refreshes
// without a page reload.
export const DATA_UPDATED_EVENT = 'inventory-data-updated'

export function notifyDataUpdated() {
  window.dispatchEvent(new Event(DATA_UPDATED_EVENT))
}

export function useLastUpdate(tableName = 'inventory') {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('latest_upload')
      .select('table_name, row_count, uploaded_at, uploaded_email')
      .eq('table_name', tableName)
      .maybeSingle()
    if (!error) setInfo(data ?? null)
    setLoading(false)
  }, [tableName])

  useEffect(() => {
    load()
    const handler = () => load()
    window.addEventListener(DATA_UPDATED_EVENT, handler)
    return () => window.removeEventListener(DATA_UPDATED_EVENT, handler)
  }, [load])

  return { info, loading, refresh: load }
}

// Timestamps come back as UTC and are rendered in the viewer's local zone.
export function formatWhen(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function relativeTime(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
