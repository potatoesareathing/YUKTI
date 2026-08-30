/**
 * Beat Constable mobile dispatch PWA screen.
 * Geolocation watcher + red-zone notifications + local IndexedDB cache.
 */

import { checkGeofence, fetchBeatFeed } from '@/data/api'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PALETTE } from '@/lib/palette'

const DB_NAME = 'yukti-beat'
const STORE = 'feed'

async function idbPut(key: string, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(STORE, 'readonly')
      const g = tx.objectStore(STORE).get(key)
      g.onsuccess = () => resolve((g.result as T) ?? null)
      g.onerror = () => reject(g.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const p = await Notification.requestPermission()
  return p === 'granted'
}

export function BeatDispatch() {
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [feed, setFeed] = useState<Record<string, unknown> | null>(null)
  const [status, setStatus] = useState('Requesting location…')
  const [alert, setAlert] = useState<string | null>(null)
  const lastZone = useRef<string | null>(null)

  const refresh = useCallback(async (la: number, ln: number) => {
    try {
      const data = await fetchBeatFeed(la, ln, 2)
      setFeed(data)
      void idbPut('last-feed', data)
      const geo = await checkGeofence(la, ln)
      if (geo.inside && geo.zones[0]) {
        const z = geo.zones[0]
        const msg = z.alert_template || `ALERT: Entering ${z.label || 'red zone'}`
        setAlert(msg)
        const key = `${z.label}:${Math.round(z.distance_m || 0)}`
        if (lastZone.current !== key) {
          lastZone.current = key
          if (await ensureNotifyPermission()) {
            new Notification('YUKTI Beat Alert', { body: msg, tag: 'beat-redzone' })
          }
        }
      } else {
        setAlert(null)
        lastZone.current = null
      }
      setStatus('Live beat feed')
    } catch {
      const cached = await idbGet<Record<string, unknown>>('last-feed')
      if (cached) {
        setFeed(cached)
        setStatus('Offline — showing cached beat feed')
      } else {
        setStatus('Feed unavailable')
      }
    }
  }, [])

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setStatus('Geolocation not supported')
      // Demo fallback: Bengaluru CBD
      setLat(12.9716)
      setLng(77.5946)
      void refresh(12.9716, 77.5946)
      return
    }
    void ensureNotifyPermission()
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const la = pos.coords.latitude
        const ln = pos.coords.longitude
        setLat(la)
        setLng(ln)
        void refresh(la, ln)
      },
      () => {
        setStatus('GPS denied — using Bengaluru demo point')
        setLat(12.9716)
        setLng(77.5946)
        void refresh(12.9716, 77.5946)
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    return () => navigator.geolocation.clearWatch(watch)
  }, [refresh])

  const firs = (feed?.recent_firs as Array<Record<string, unknown>>) || []
  const warrants = (feed?.active_warrants as Array<Record<string, unknown>>) || []
  const suspects = (feed?.suspects as Array<Record<string, unknown>>) || []

  return (
    <div className="min-h-[100svh] bg-ink text-khaki">
      <header className="sticky top-0 z-20 border-b border-rule bg-ink/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="label-brass" style={{ fontSize: 10 }}>
              Beat Dispatch PWA
            </div>
            <h1
              style={{
                fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              Mobile Patrol Feed
            </h1>
          </div>
          <Link to="/platform/geospatial" className="label border border-rule px-2 py-1 hover:border-brass">
            Desktop
          </Link>
        </div>
        <p className="mt-1 text-[0.72rem] text-khaki-dim">
          {status}
          {lat != null && lng != null ? ` · ${lat.toFixed(4)}, ${lng.toFixed(4)} · 2 km radius` : ''}
        </p>
      </header>

      {alert && (
        <div
          className="mx-3 mt-3 border px-3 py-2 text-[0.8rem] leading-snug"
          style={{ borderColor: PALETTE.redzone, color: PALETTE.redzone }}
          role="alert"
        >
          {alert}
        </div>
      )}

      <section className="space-y-3 p-3 pb-24">
        <Panel title="Active NBWs" count={warrants.length}>
          {warrants.length === 0 ? (
            <Empty>No active warrants in cache.</Empty>
          ) : (
            <ul className="divide-y divide-rule/50">
              {warrants.map((w) => (
                <li key={String(w.person_id)} className="flex gap-3 px-3 py-2">
                  <Mugshot />
                  <div className="min-w-0">
                    <div className="truncate text-[0.85rem]">{String(w.name)}</div>
                    <div className="label" style={{ fontSize: 9 }}>
                      {String(w.warrant_type)} · {String(w.court_name || 'Court')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Suspects nearby" count={suspects.length}>
          <ul className="divide-y divide-rule/50">
            {suspects.slice(0, 8).map((s) => (
              <li key={String(s.id)} className="flex gap-3 px-3 py-2">
                <Mugshot />
                <div className="min-w-0">
                  <div className="truncate text-[0.85rem]">{String(s.label)}</div>
                  <div className="label" style={{ fontSize: 9 }}>
                    {String(s.district)} · priors {String(s.priors)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Station / FIR inputs (2 km)" count={firs.length}>
          {firs.length === 0 ? (
            <Empty>No recent FIRs in beat radius.</Empty>
          ) : (
            <ul className="divide-y divide-rule/50">
              {firs.map((f) => (
                <li key={String(f.cctns_fir_id)} className="px-3 py-2">
                  <div className="text-[0.82rem]">{String(f.crime_head_name || 'FIR')}</div>
                  <div className="label" style={{ fontSize: 9 }}>
                    {String(f.district_id)} · {String(f.distance_km)} km
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  )
}

function Panel({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="border border-rule">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2">
        <span className="label-brass">{title}</span>
        <span className="tnum text-khaki-dim" style={{ fontSize: 11 }}>
          {count}
        </span>
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-[0.78rem] text-khaki-dim">{children}</p>
}

function Mugshot() {
  return (
    <span
      className="inline-block h-10 w-8 shrink-0 border border-rule"
      style={{ background: 'linear-gradient(160deg,#1a2230,#0d1218)' }}
      aria-hidden
    />
  )
}
