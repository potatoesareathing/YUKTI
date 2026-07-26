import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { CameraRig, STATIONS, stationFor, type CameraStation } from '@/three/CameraRig'
import { Districts } from '@/three/Districts'
import { DistrictLabels } from '@/three/DistrictLabels'
import { BasePlate, Graticule, InstrumentFrame as SceneFrame } from '@/three/Groundwork'
import { HotspotLayer } from '@/three/HotspotLayer'
import { IncidentField } from '@/three/IncidentField'
import { OrbitFocus } from '@/three/OrbitFocus'
import { Rig } from '@/three/Scene'
import { sceneClock } from '@/three/clock'
import { suggestedOrigins } from '@/data/graphpaths'
import type { DistrictFeature } from '@/lib/geo'
import type { Incident } from '@/data/types'
import { useYukti, prefersReducedMotion } from '@/store/useYukti'

/**
 * The two working 3D views, kept as separate scenes rather than one component
 * with mode branches.
 *
 * They stopped having anything in common once MOD-02 dropped the map: one is a
 * geographic surface, the other is an abstract dial with no ground plane, no
 * graticule and a different camera. Branching inside a single component meant
 * every prop had to be read as "…but only in map mode", which is how the two
 * kept bleeding into each other.
 */

const FLAT_RELIEF = 0.15
const HOTSPOT_Y = 2.7

/* ── MOD-01: the geographic surface ────────────────────────────────────────── */

interface MapSceneProps {
  features: DistrictFeature[]
  incidents: Incident[]
}

export function MapScene({ features, incidents }: MapSceneProps) {
  const selected = useYukti((s) => s.selectedDistrict)
  const showHotspots = useYukti((s) => s.showHotspots)
  const showIncidents = useYukti((s) => s.showIncidents)
  const reduced = useMemo(prefersReducedMotion, [])

  const station: CameraStation = useMemo(() => {
    const f = selected ? features.find((x) => x.name === selected) : undefined
    // Standoff scales with how much of the state we still want in view: a
    // selected district is inspected, the state as a whole is surveyed.
    return f ? stationFor(f.world, 52, 44) : STATIONS.plan
  }, [selected, features])

  // The hotspot layer is only meaningful lying flat; extrusions occlude it.
  const flatten = showHotspots

  useFrame((_, delta) => {
    sceneClock.elapsed += delta
    const target = flatten ? FLAT_RELIEF : 1
    sceneClock.growth += (target - sceneClock.growth) * Math.min(1, delta * 3)
    sceneClock.sweep = reduced ? 1 : (sceneClock.elapsed % 11) / 11
  })

  return (
    <>
      <Rig />
      <CameraRig station={station} speed={1.5} userCanInterrupt />

      <BasePlate />
      <Graticule opacity={0.3} />
      <SceneFrame />

      <Districts features={features} opacity={1} interactive />

      {flatten && (
        <HotspotLayer incidents={incidents} opacity={0.95} bandwidth={2.1} height={HOTSPOT_Y} />
      )}

      {showIncidents && (
        <IncidentField
          incidents={incidents}
          reveal={1}
          revealMode="temporal"
          opacity={0.9}
          size={2.6}
          height={flatten ? HOTSPOT_Y + 0.6 : 1.2}
        />
      )}

      <DistrictLabels features={features} topN={selected ? 0 : 7} />
    </>
  )
}

/* ── MOD-02: the ego dial ──────────────────────────────────────────────────── */

export function DialScene() {
  const origin = useYukti((s) => s.egoOrigin)
  const walkTo = useYukti((s) => s.walkTo)

  // Fall back to the best-connected person so the canvas is never empty, even
  // if the module's own effect has not run yet.
  const focusId = origin ?? suggestedOrigins(1)[0]?.id ?? null
  if (!focusId) return null

  return (
    <>
      <Rig />
      <CameraRig station={STATIONS.dial} speed={1.6} userCanInterrupt />
      <SceneFrame />
      <OrbitFocus focusId={focusId} onFocus={walkTo} />
    </>
  )
}
