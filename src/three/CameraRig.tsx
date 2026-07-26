import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { fromWorldXZ } from '@/lib/geo'
import { useYukti } from '@/store/useYukti'

/**
 * Camera behaviour, modelled on a theodolite rather than a flying camera.
 *
 * Movement is always toward a named station — a district, the state overview,
 * the graph — never free flight. The camera eases in, settles, and reports its
 * geographic position to the store every few frames so the coordinate readout
 * in the chrome is genuinely live.
 *
 * A user drag cancels the scripted move immediately. Fighting an analyst for
 * control of the view is the fastest way to make a map feel broken.
 */

export interface CameraStation {
  position: [number, number, number]
  target: [number, number, number]
}

export const STATIONS = {
  /**
   * The whole state, slightly oblique so extrusion reads as volume, and framed
   * right-of-centre: Act I's headline occupies the left third, and a map
   * centred in the viewport would sit directly under the type.
   */
  state: { position: [-10, 158, 156], target: [-18, 0, 4] },
  /** Act I on a narrow viewport: centred, and pulled back to fit the aspect. */
  stateNarrow: { position: [2, 176, 172], target: [0, 0, 6] },
  /** Low and close, for the hotspot dive. */
  hotspot: { position: [10, 26, 40], target: [6, 0, 12] },
  /**
   * Link analysis. Low and oblique rather than high and distant: the
   * constellation stands on the state, so the camera has to sit near the plate
   * for the arcs to read as arcs instead of collapsing into a top-down tangle.
   */
  /**
   * Three-quarter view from the south-west, ~29° elevation. Yawed off-axis on
   * purpose: a dead-on view flattens the ribbons into a symmetric fan, and the
   * yaw is what lets the eye read one arc passing in front of another.
   */
  network: { position: [-56, 84, 134], target: [-2, 9, 4] },
  /**
   * MOD-02's dial. Near-overhead but tilted ~62°, so the graduated rings read as
   * rings rather than as a flat diagram and the marks standing on them catch the
   * key light.
   */
  dial: { position: [0, 66, 60], target: [0, 1, 0] },
  /** Near-top-down working view for the platform's map module. */
  plan: { position: [0, 224, 70], target: [0, 0, 2] },
} as const satisfies Record<string, CameraStation>

export type StationName = keyof typeof STATIONS

interface CameraRigProps {
  station: CameraStation
  /** Higher is snappier. Below ~0.6 the move reads as drift. */
  speed?: number
  /**
   * When true, a pointer press on the page suspends the scripted move until the
   * next station change. An analyst who cannot stop the camera stops trusting
   * the map.
   */
  userCanInterrupt?: boolean
  /** Called with the OrbitControls target so external controls stay in sync. */
  onTarget?: (t: Vector3) => void
  enabled?: boolean
}

export function CameraRig({
  station,
  speed = 1.6,
  userCanInterrupt = false,
  onTarget,
  enabled = true,
}: CameraRigProps) {
  const camera = useThree((s) => s.camera)
  const setReadout = useYukti((s) => s.setReadout)

  const targetPos = useRef(new Vector3(...station.position))
  const targetLook = useRef(new Vector3(...station.target))
  const currentLook = useRef(new Vector3(...station.target))
  const frame = useRef(0)
  // A ref, not state: it is read inside the frame loop, and turning every
  // pointer press into a render would be pure waste.
  const suspended = useRef(false)

  useEffect(() => {
    targetPos.current.set(...station.position)
    targetLook.current.set(...station.target)
    suspended.current = false // an explicit selection always wins back control
  }, [station])

  useEffect(() => {
    if (!userCanInterrupt) return
    const onDown = () => {
      suspended.current = true
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [userCanInterrupt])

  // Publish a correct bearing on mount rather than waiting for the sixth frame,
  // so the readout never briefly displays the store's placeholder coordinates.
  useEffect(() => {
    const [lon, lat] = fromWorldXZ(station.target[0], station.target[2])
    setReadout({ lon, lat, alt: station.position[1] })
  }, [station, setReadout])

  useFrame((_, delta) => {
    if (!enabled) return

    if (!suspended.current) {
      // Frame-rate independent exponential ease.
      const k = 1 - Math.exp(-speed * delta)
      camera.position.lerp(targetPos.current, k)
      currentLook.current.lerp(targetLook.current, k)
      camera.lookAt(currentLook.current)
      onTarget?.(currentLook.current)
    }

    // The readout does not need 60 updates a second, and re-rendering the
    // chrome that often would cost more than the camera move.
    frame.current++
    if (frame.current % 6 === 0) {
      const [lon, lat] = fromWorldXZ(currentLook.current.x, currentLook.current.z)
      setReadout({ lon, lat, alt: camera.position.y })
    }
  })

  return null
}

/** A station centred on a point on the ground plane, at a given standoff. */
export function stationFor(
  world: [number, number],
  height = 30,
  standoff = 34,
): CameraStation {
  return {
    position: [world[0] + 2, height, world[1] + standoff],
    target: [world[0], 0, world[1]],
  }
}
