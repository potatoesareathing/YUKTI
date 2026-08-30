import { Link, useLocation } from 'react-router-dom'

/**
 * Always-visible entry points for the capabilities added this sprint —
 * Beat PWA, CCTNS live map, multi-source graph, KSP dossier, Kannada MO matching.
 */
const FEATURES = [
  {
    id: 'beat',
    label: 'Beat PWA',
    hint: 'Constable dispatch',
    to: '/beat',
  },
  {
    id: 'cctns',
    label: 'CCTNS Live',
    hint: 'FIR map feed',
    to: '/platform/geospatial#cctns-live',
  },
  {
    id: 'mo',
    label: 'MO Alerts',
    hint: 'Kannada patterns',
    to: '/platform/intelligence#mo-patterns',
  },
  {
    id: 'graph',
    label: 'Multi-source',
    hint: 'CDR · ANPR · Bank',
    to: '/platform/network#multisource',
  },
  {
    id: 'dossier',
    label: 'KSP Dossier',
    hint: 'PDF export',
    to: '/platform/behaviour?view=offenders#dossier',
  },
  {
    id: 'persons',
    label: 'Person Intel',
    hint: 'MOD-07 alerts',
    to: '/platform/persons#alerts',
  },
] as const

function isActive(pathname: string, search: string, hash: string, to: string): boolean {
  const url = new URL(to, 'http://local')
  if (pathname !== url.pathname) return false
  for (const [k, v] of url.searchParams) {
    if (new URLSearchParams(search).get(k) !== v) return false
  }
  if (url.hash) return hash === url.hash
  return true
}

export function FeatureShortcuts({ compact = false }: { compact?: boolean }) {
  const { pathname, hash, search } = useLocation()

  return (
    <nav
      aria-label="Quick access"
      className={
        compact
          ? 'flex max-w-full flex-wrap items-center justify-end gap-1.5'
          : 'flex gap-2 overflow-x-auto border-b border-rule bg-ink/80 px-3 py-2 backdrop-blur sm:px-4'
      }
    >
      {!compact && (
        <span className="label-brass mr-1 hidden shrink-0 sm:inline" style={{ fontSize: 9 }}>
          Quick access
        </span>
      )}
      {FEATURES.map((f) => {
        const on = isActive(pathname, search, hash, f.to)
        return (
          <Link
            key={f.id}
            to={f.to}
            className="shrink-0 border px-2.5 py-1.5 transition-colors hover:border-brass"
            style={{
              borderColor: on ? '#C9A227' : 'rgba(61, 72, 86, 0.9)',
              background: on ? 'rgba(201,162,39,0.12)' : 'rgba(16, 24, 35, 0.6)',
            }}
          >
            <span
              className="block leading-tight"
              style={{
                fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                fontSize: compact ? 11 : 12,
                fontWeight: 600,
                letterSpacing: '0.03em',
                color: on ? '#DCD3BE' : '#B8B09A',
              }}
            >
              {f.label}
            </span>
            {!compact && (
              <span className="label block" style={{ fontSize: 8, color: '#6E6858' }}>
                {f.hint}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
