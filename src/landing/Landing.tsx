import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Scene } from '@/three/Scene'
import { resetSceneClock } from '@/three/clock'
import { useGeo } from '@/three/useGeo'
import { InstrumentFrame } from '@/ui/InstrumentFrame'
import { useYukti, prefersReducedMotion } from '@/store/useYukti'
import { ACTS, LandingScene } from './LandingScene'
import { ActOne, ActThree, ActTwo } from './Acts'
import { useScrollProgress, window01 } from './useScrollProgress'

/**
 * The landing narrative: one fixed 3D scene, three scrolled overlays.
 *
 * The canvas never unmounts and never scrolls. Scroll position is the only
 * input — it drives the camera station, the hotspot layer's opacity and the
 * map→graph morph. Overlay text fades in and out of act windows on top.
 */
export function Landing() {
  const scrollProgress = useScrollProgress()

  // ?p=0.46 pins the narrative to a fixed point, independent of scroll. Useful
  // for linking a reviewer straight at one moment of the sequence, and for
  // capturing stills without depending on how a headless viewport resolves svh.
  const pinned = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('p')
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null
  }, [])

  const progress = pinned ?? scrollProgress
  const { features, incidents, ready, error } = useGeo()
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const selectNode = useYukti((s) => s.selectNode)

  useEffect(() => {
    resetSceneClock(prefersReducedMotion() ? 1 : 0)
    selectDistrict(null)
    selectNode(null)

    // ?act=hotspots|network deep-links into an act, so a specific part of the
    // narrative can be linked to directly instead of described as "scroll a bit".
    const requested = new URLSearchParams(window.location.search).get('act')
    const at = requested === 'network' ? 0.86 : requested === 'hotspots' ? 0.46 : 0
    // Wait a frame: section heights are in svh, and reading scrollHeight during
    // the mount effect can land before those have resolved.
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo(0, at * max)
    })
  }, [selectDistrict, selectNode])

  // Act I must be FULLY opaque at the top of the page. Starting its window at
  // -0.05 with a 0.1 fade left the ramp only half-complete at progress 0, so the
  // hero — and its scrim — rendered at 50%: washed-out type with the map
  // bleeding through it, worst of all on mobile where the scrim does the work.
  const actOne = window01(progress, -0.2, ACTS.one[1] - 0.02, 0.1)
  const actTwo = window01(progress, ACTS.two[0] - 0.04, ACTS.two[1] - 0.02, 0.09)
  const actThree = window01(progress, ACTS.three[0] + 0.02, 1.05, 0.09)

  if (error) return <BoundaryError message={error} />

  return (
    <>
      <div className="fixed inset-0 z-0">
        {ready ? (
          <Scene interactive={false}>
            <LandingScene progress={progress} features={features} incidents={incidents} />
          </Scene>
        ) : (
          <Calibrating />
        )}
      </div>

      <InstrumentFrame
        reference={
          progress >= ACTS.three[0]
            ? 'SEC 7.2 · LINK ANALYSIS'
            : progress >= ACTS.two[0]
              ? 'SEC 7.1 · SPATIOTEMPORAL'
              : 'YUKTI · STATE OVERVIEW'
        }
        status={ready ? 'SYNTHETIC DATASET · DEMONSTRATION' : 'LOADING BOUNDARIES'}
      />

      <TopBar />

      {/* Scroll track. Each act owns a full viewport; the extra height at the
          end gives Act III room to complete its morph before the page bottoms. */}
      <main className="relative z-10">
        <section aria-label="YUKTI">
          <ActOne opacity={actOne} />
        </section>
        <section aria-label="Spatiotemporal hotspots">
          <ActTwo opacity={actTwo} />
        </section>
        <section aria-label="Network and link analysis">
          <ActThree opacity={actThree} />
        </section>
        <div className="h-[40svh]" aria-hidden />
      </main>

      <ProgressRail progress={progress} />
    </>
  )
}

function TopBar() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between px-6 py-5 md:px-16">
      <Link to="/" className="flex items-baseline gap-2.5">
        <span
          className="text-khaki"
          style={{ fontFamily: "'Noto Serif Kannada', serif", fontSize: 20, fontWeight: 600 }}
        >
          ಯುಕ್ತಿ
        </span>
        <span className="label-brass" style={{ fontSize: 10 }}>
          YUKTI
        </span>
      </Link>

      <Link
        to="/platform"
        className="label border border-rule px-3 py-1.5 text-khaki transition-colors hover:border-brass hover:text-brass"
      >
        Open platform →
      </Link>
    </header>
  )
}

/** Act rail — shows position through the narrative, and lets you jump. */
function ProgressRail({ progress }: { progress: number }) {
  const acts = [
    { label: 'State', at: 0.02 },
    { label: 'Hotspots', at: 0.44 },
    { label: 'Network', at: 0.84 },
  ]

  const jump = (at: number) => {
    const max = document.documentElement.scrollHeight - window.innerHeight
    window.scrollTo({ top: at * max, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  return (
    <nav
      className="fixed right-6 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-end gap-4 md:flex md:right-16"
      aria-label="Narrative sections"
    >
      {acts.map((a, i) => {
        const next = acts[i + 1]?.at ?? 1.05
        const active = progress >= a.at - 0.06 && progress < next - 0.06
        return (
          <button
            key={a.label}
            onClick={() => jump(a.at)}
            className="group flex items-center gap-3"
            aria-current={active ? 'true' : undefined}
          >
            <span
              className="label transition-opacity"
              style={{ opacity: active ? 1 : 0, color: '#C9A227' }}
            >
              {a.label}
            </span>
            <span
              className="block transition-all"
              style={{
                width: active ? 22 : 10,
                height: 1,
                background: active ? '#C9A227' : '#2A3A4C',
              }}
            />
          </button>
        )
      })}
    </nav>
  )
}

function Calibrating() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="label-brass mb-3">Loading district boundaries</div>
        <div className="mx-auto h-px w-40 overflow-hidden bg-rule">
          <div className="sweep-line h-px w-full bg-brass" />
        </div>
      </div>
    </div>
  )
}

function BoundaryError({ message }: { message: string }) {
  return (
    <div className="flex min-h-[100svh] items-center justify-center px-6">
      <div className="plate ticked max-w-md p-7">
        <div className="label-brass mb-3">Boundary data unavailable</div>
        <p className="mb-4 text-[0.94rem] leading-relaxed text-khaki/80">{message}</p>
        <p className="text-[0.84rem] leading-relaxed text-khaki-dim">
          The map needs <span className="tnum text-khaki">/data/karnataka-districts.geo.json</span>.
          Check that the file is served, then reload.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="label mt-6 border border-brass/50 px-4 py-2 text-brass transition-colors hover:bg-brass/10"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
