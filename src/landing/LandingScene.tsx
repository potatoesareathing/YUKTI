import { useEffect, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { CameraRig, STATIONS, stationFor, type CameraStation } from '@/three/CameraRig'
import { Districts } from '@/three/Districts'
import { DistrictLabels } from '@/three/DistrictLabels'
import { BasePlate, Graticule, InstrumentFrame as SceneFrame } from '@/three/Groundwork'
import { HotspotLayer } from '@/three/HotspotLayer'
import { IncidentField } from '@/three/IncidentField'
import { Constellation } from '@/three/Constellation'
import { Rig } from '@/three/Scene'
import { sceneClock } from '@/three/clock'
import { getNetwork } from '@/data/network'
import type { DistrictFeature } from '@/lib/geo'
import type { Incident } from '@/data/types'
import { prefersReducedMotion } from '@/store/useYukti'
import { band, ease } from './useScrollProgress'
import { useIsNarrow } from './useViewport'

/**
 * The single continuous scene behind all three acts.
 *
 * Nothing is unmounted between acts — the same district geometry that rose out
 * of the plate in Act I is what the camera dives into in Act II, and its
 * incidents are the records that lift into the graph in Act III. That continuity
 * is the argument itself: one governed data platform, three ways of reading it.
 */

export const ACTS = {
  one: [0.0, 0.34],
  two: [0.34, 0.66],
  three: [0.66, 1.0],
} as const

const REVEAL_SECONDS = 2.4
const SWEEP_PERIOD = 9

/** Extrusion left standing under the hotspot surface — enough to keep district
 *  boundaries legible as relief, low enough not to occlude the density layer. */
const FLAT_RELIEF = 0.13
/** Height of the KDE surface. Must clear the flattened relief. */
const HOTSPOT_Y = 2.6

interface LandingSceneProps {
  progress: number
  features: DistrictFeature[]
  incidents: Incident[]
}

export function LandingScene({ progress, features, incidents }: LandingSceneProps) {
  const reduced = useMemo(prefersReducedMotion, [])
  const narrow = useIsNarrow()
  const network = useMemo(() => getNetwork(), [])
  const [hotspotsMounted, setHotspotsMounted] = useState(false)

  const bengaluru = useMemo(
    () => (features.find((f) => f.name === 'Bengaluru Urban')?.world ?? [0, 0]) as [number, number],
    [features],
  )

  const pTwo = ease(band(progress, ACTS.two[0], ACTS.two[1]))
  const pThree = ease(band(progress, ACTS.three[0] - 0.02, ACTS.three[1] - 0.08))

  const station: CameraStation = useMemo(() => {
    if (progress >= ACTS.three[0]) return STATIONS.network
    // Close enough that the hotspot contours resolve, far enough that
    // Bengaluru's neighbours stay in frame — a dive that loses all context
    // stops being a drill-down and becomes a different map.
    if (progress >= ACTS.two[0]) return stationFor(bengaluru, narrow ? 96 : 78, narrow ? 76 : 62)
    return narrow ? STATIONS.stateNarrow : STATIONS.state
  }, [progress, bengaluru, narrow])

  useFrame((_, delta) => {
    sceneClock.elapsed += delta

    // Act I reads volume per district, so the state stands up. Act II reads a
    // continuous density surface, so it lies back down — a KDE estimate drawn
    // between 14-unit towers is occluded by the very geometry it describes, and
    // a hotspot map is a plan view by nature. The towers sinking as the heat
    // blooms is the transition doing the explaining.
    const risen = reduced ? 1 : Math.min(1, ease(sceneClock.elapsed / REVEAL_SECONDS))
    // Act II lies the state flat for the density surface; Act III stands it
    // back up, because the constellation needs recognisable ground beneath it.
    const flat = pTwo * (1 - pThree)
    const target = risen * (1 - flat * (1 - FLAT_RELIEF))
    sceneClock.growth += (target - sceneClock.growth) * Math.min(1, delta * 3.2)

    // The sweep is the instrument's idle behaviour — what says the platform is
    // live rather than a screenshot.
    sceneClock.sweep = reduced ? 1 : (sceneClock.elapsed % SWEEP_PERIOD) / SWEEP_PERIOD
  })

  // The KDE texture costs a moment to bake, so mount it just before Act II
  // rather than at page load or at the instant it is needed. This must run as an
  // effect, not during render: a render-phase setState inside the R3F tree
  // aborts the commit and the canvas comes up blank.
  useEffect(() => {
    if (!hotspotsMounted && progress > ACTS.two[0] - 0.12) setHotspotsMounted(true)
  }, [hotspotsMounted, progress])

  // The map stays lit through Act III. The constellation stands on it now, so
  // fading the ground out would leave the arcs floating over nothing — and the
  // districts a tie crosses are exactly what the act is pointing at.
  const mapOpacity = 1 - pThree * 0.12
  const hotspotOpacity = Math.min(pTwo * 1.4, 1) * (1 - pThree)

  return (
    <>
      <Rig />
      <CameraRig station={station} speed={progress >= ACTS.two[0] ? 1.1 : 1.5} />

      <BasePlate />
      <Graticule opacity={0.34 * (1 - pThree * 0.35)} />
      <SceneFrame />

      <Districts features={features} opacity={mapOpacity} monochrome={pThree * 0.82} interactive={false} />

      {hotspotsMounted && hotspotOpacity > 0.008 && (
        <HotspotLayer
          incidents={incidents}
          opacity={hotspotOpacity}
          bandwidth={2.2}
          height={HOTSPOT_Y}
        />
      )}

      <IncidentField
        incidents={incidents}
        revealSource={reduced ? 'prop' : 'clock'}
        reveal={reduced ? 1 : pTwo}
        opacity={(0.35 + pTwo * 0.65) * (1 - pThree)}
        size={2 + pTwo * 1.6}
        height={HOTSPOT_Y + 0.5}
      />

      {pThree > 0.004 && (
        <Constellation
          data={network}
          features={features}
          morph={pThree}
          showPredicted={pThree > 0.62}
          interactive={false}
          opacity={Math.min(1, pThree * 2.4)}
        />
      )}

      <DistrictLabels features={features} topN={6} opacity={mapOpacity} />
    </>
  )
}
