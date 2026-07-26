import { useEffect, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { CameraRig, STATIONS, stationFor, type CameraStation } from '@/three/CameraRig'
import { Districts } from '@/three/Districts'
import { DistrictLabels } from '@/three/DistrictLabels'
import { BasePlate, Graticule, InstrumentFrame as SceneFrame } from '@/three/Groundwork'
import { HotspotLayer } from '@/three/HotspotLayer'
import { IncidentField } from '@/three/IncidentField'
import { StationMarkers } from '@/three/StationMarkers'
import { GraphView } from '@/three/GraphView'
import { Rig } from '@/three/Scene'
import { sceneClock } from '@/three/clock'
import type { DistrictFeature } from '@/lib/geo'
import type { Incident } from '@/data/types'
import { getStations, peekStations, type StationMetrics } from '@/data/stations'
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
  const selectedStation = useYukti((s) => s.selectedStation)
  const [stations, setStations] = useState<StationMetrics[]>([])

  useEffect(() => {
    let live = true
    getStations().then(() => {
      if (live) setStations(peekStations())
    })
    return () => {
      live = false
    }
  }, [])

  // Stations only exist as a tier inside an open district.
  const districtStations = useMemo(
    () => (selected ? stations.filter((s) => s.district === selected) : []),
    [selected, stations],
  )
  const station = selectedStation
    ? districtStations.find((s) => s.id === selectedStation)
    : undefined
  const showHotspots = useYukti((s) => s.showHotspots)
  const showIncidents = useYukti((s) => s.showIncidents)
  const reduced = useMemo(prefersReducedMotion, [])

  const view: CameraStation = useMemo(() => {
    // Three tiers, three standoffs: the state is surveyed, a district is
    // inspected, a station is examined.
    if (station) return stationFor(station.world, 22, 20)
    const f = selected ? features.find((x) => x.name === selected) : undefined
    return f ? stationFor(f.world, 52, 44) : STATIONS.plan
  }, [selected, features, station])

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
      <CameraRig station={view} speed={1.5} userCanInterrupt />

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

      {districtStations.length > 0 && (
        <StationMarkers stations={districtStations} baseY={flatten ? HOTSPOT_Y + 0.2 : 0.6} />
      )}

      <DistrictLabels features={features} topN={selected ? 0 : 7} />
    </>
  )
}

/* ── MOD-02: the ego dial ──────────────────────────────────────────────────── */

/**
 * MOD-02. No scripted camera here — the analyst drives it with orbit controls,
 * the way a graph view is expected to behave.
 */
export function DialScene() {
  return (
    <>
      <Rig />
      <GraphView />
    </>
  )
}
