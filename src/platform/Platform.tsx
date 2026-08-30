import { getDataSource, loadPlatformData, stateTotals } from '@/data/api'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Scene } from '@/three/Scene'
import { resetSceneClock } from '@/three/clock'
import { useGeo } from '@/three/useGeo'
import { InstrumentFrame } from '@/ui/InstrumentFrame'
import { EvidenceDrawer } from '@/ui/EvidenceDrawer'
import { useYukti, type ModuleId } from '@/store/useYukti'
import { compact } from '@/lib/format'
import { ID_BY_SLUG, MODULE_BY_ID, MODULES, SLUG_BY_ID } from './modules'
import { DialScene, MapScene } from './PlatformScene'
import { FeatureShortcuts } from './FeatureShortcuts'
import { M1Geospatial } from './modules/M1Geospatial'
import { M2Network } from './modules/M2Network'
import { M3Predictive } from './modules/M3Predictive'
import { M4Trends } from './modules/M4Trends'
import { M5Behaviour } from './modules/M5Behaviour'
import { M6Intelligence } from './modules/M6Intelligence'

/**
 * The platform shell.
 *
 * One persistent chrome — masthead, module navigation, instrument frame,
 * evidence drawer — around a module body. MOD-01 and MOD-02 mount the shared 3D
 * canvas; the analytical modules are DOM. Filters and selection live in the
 * store, so moving between modules carries the analyst's context with them
 * rather than resetting it.
 */
export function Platform() {
  const { module: slug } = useParams()
  const navigate = useNavigate()
  const active: ModuleId = ID_BY_SLUG[slug ?? ''] ?? 'MOD-01'
  const meta = MODULE_BY_ID.get(active)!
  const [dataEpoch, setDataEpoch] = useState(0)

  const { features, incidents, ready, error } = useGeo()
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const totals = useMemo(() => stateTotals(), [dataEpoch])

  const [source, setSource] = useState<'api' | 'seed'>('seed')

  useEffect(() => {
    resetSceneClock(1)
    void loadPlatformData().then(() => setSource(getDataSource())).then(() => setDataEpoch((n) => n + 1))
  }, [])

  // Keyboard access to the modules: 1–6 jump between them, matching the
  // numbering an analyst already sees on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target?.tagName === 'INPUT' || target?.isContentEditable) return
      const n = Number(e.key)
      if (n >= 1 && n <= MODULES.length) navigate(`/platform/${SLUG_BY_ID[MODULES[n - 1].id]}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const usesScene = meta.scene !== 'none'

  return (
    <div className="flex h-[100svh] flex-col overflow-hidden bg-ink">
      <Masthead active={active} redZones={totals.redZones} incidents={totals.incidents} />
      <FeatureShortcuts />

      <main className="relative min-h-0 flex-1">
        {usesScene && (
          <div className="absolute inset-0 z-0">
            {ready && dataEpoch > 0 ? (
              <Scene key={dataEpoch}>
                {meta.scene === 'graph' ? (
                  <DialScene revision={dataEpoch} />
                ) : (
                  <MapScene features={features} incidents={incidents} />
                )}
              </Scene>
            ) : (
              <Loading error={error} />
            )}
          </div>
        )}

        <div className={`relative z-10 h-full pb-6 ${usesScene ? 'pointer-events-none' : 'overflow-y-auto'}`} key={dataEpoch}>
          {active === 'MOD-01' && <M1Geospatial ready={ready && dataEpoch > 0} onPick={selectDistrict} />}
          {active === 'MOD-02' && <M2Network ready={ready && dataEpoch > 0} />}
          {active === 'MOD-03' && <M3Predictive />}
          {active === 'MOD-04' && <M4Trends />}
          {active === 'MOD-05' && <M5Behaviour />}
          {active === 'MOD-06' && <M6Intelligence />}
        </div>
      </main>

      <InstrumentFrame
        compact
        reference={`${meta.id} · ${meta.short.toUpperCase()}`}
        status={`${compact(totals.incidents)} RECORDS · ${source === 'api' ? 'LIVE' : 'SYNTHETIC'}`}
      />

      <EvidenceDrawer />
    </div>
  )
}

function Masthead({
  active,
  redZones,
  incidents,
}: {
  active: ModuleId
  redZones: number
  incidents: number
}) {
  return (
    <header className="z-40 shrink-0 border-b border-rule bg-ink/92 backdrop-blur">
      <div className="flex items-center justify-between gap-6 px-4 py-2.5">
        <Link to="/" className="flex shrink-0 items-baseline gap-2.5" aria-label="YUKTI home">
          <span
            className="text-khaki"
            style={{ fontFamily: "'Noto Serif Kannada', serif", fontSize: 19, fontWeight: 600 }}
          >
            ಯುಕ್ತಿ
          </span>
          <span className="label-brass hidden sm:inline" style={{ fontSize: 10 }}>
            YUKTI
          </span>
        </Link>

        <nav className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto" aria-label="Modules">
          {MODULES.map((m, i) => {
            const on = m.id === active
            return (
              <Link
                key={m.id}
                to={`/platform/${SLUG_BY_ID[m.id]}`}
                aria-current={on ? 'page' : undefined}
                title={`${m.name} — press ${i + 1}`}
                className="group shrink-0 border-b-2 px-3 py-1.5 transition-colors"
                style={{
                  borderColor: on ? '#C9A227' : 'transparent',
                  background: on ? 'rgba(201,162,39,0.07)' : 'transparent',
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span className="tnum" style={{ fontSize: 9, color: on ? '#C9A227' : '#8D8877' }}>
                    {m.id}
                  </span>
                  <span
                    style={{
                      fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                      fontSize: 13,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      color: on ? '#DCD3BE' : '#8D8877',
                    }}
                  >
                    {m.short}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: "'Noto Serif Kannada', serif",
                    fontSize: 10,
                    color: on ? '#8A701A' : '#3A4553',
                    lineHeight: 1.2,
                  }}
                >
                  {m.kannada}
                </div>
              </Link>
            )
          })}
        </nav>

        <div className="hidden shrink-0 items-center gap-4 sm:flex">
          <div className="text-right">
            <div className="label" style={{ fontSize: 9 }}>
              Records
            </div>
            <div className="tnum text-khaki" style={{ fontSize: 13 }}>
              {compact(incidents)}
            </div>
          </div>
          <div className="text-right">
            <div className="label" style={{ fontSize: 9 }}>
              Red zones
            </div>
            <div
              className="tnum flex items-center justify-end gap-1"
              style={{ fontSize: 13, color: redZones > 0 ? '#FF3B2F' : '#DCD3BE' }}
            >
              {redZones > 0 && (
                <span className="redzone-pulse" aria-hidden>
                  ▲
                </span>
              )}
              {redZones}
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

function Loading({ error }: { error: string | null }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      {error ? (
        <div className="plate ticked max-w-md p-6">
          <div className="label-brass mb-2">Boundary data unavailable</div>
          <p className="text-[0.86rem] leading-relaxed text-khaki/80">{error}</p>
        </div>
      ) : (
        <div className="text-center">
          <div className="label-brass mb-3">Loading district boundaries</div>
          <div className="mx-auto h-px w-40 overflow-hidden bg-rule">
            <div className="sweep-line h-px w-full bg-brass" />
          </div>
        </div>
      )}
    </div>
  )
}
