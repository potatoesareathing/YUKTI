import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { ConeGeometry, Color, Object3D, type InstancedMesh } from 'three'
import { PALETTE } from '@/lib/palette'
import { compact } from '@/lib/format'
import type { StationMetrics } from '@/data/api'
import { useYukti } from '@/store/useYukti'

/**
 * Police stations, drawn only once a district is open.
 *
 * The third tier of §7.1's drill-down. Showing all ~950 stations at state level
 * would be the hairball problem again in a different costume, so they appear
 * only inside the district under inspection — which is also the only zoom at
 * which they are distinguishable from one another.
 *
 * A station is a small brass pin standing on its own centre of activity, sized
 * by its share of the district. The tallest pin in a district is where that
 * district's caseload actually sits.
 */

const MIN_HEIGHT = 2.2
const MAX_HEIGHT = 11

interface StationMarkersProps {
  stations: StationMetrics[]
  /** Height offset so pins clear a flattened or extruded district. */
  baseY?: number
}

export function StationMarkers({ stations, baseY = 0.4 }: StationMarkersProps) {
  const selected = useYukti((s) => s.selectedStation)
  const selectStation = useYukti((s) => s.selectStation)
  const mesh = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const scratch = useMemo(() => new Color(), [])

  // Origin at the base so instance scale.y reads directly as height.
  const geometry = useMemo(() => {
    const g = new ConeGeometry(0.42, 1, 6)
    g.translate(0, 0.5, 0)
    return g
  }, [])

  const placed = useMemo(() => {
    const peak = Math.max(...stations.map((s) => s.share), 0.01)
    return stations.map((s) => ({
      station: s,
      height: MIN_HEIGHT + (s.share / peak) * (MAX_HEIGHT - MIN_HEIGHT),
    }))
  }, [stations])

  useFrame(({ clock }) => {
    const m = mesh.current
    if (!m) return
    placed.forEach((p, i) => {
      const on = selected === p.station.id
      const dim = !!selected && !on
      // A gentle rise on the selected pin, so the click has a visible result
      // even before the panel updates.
      const lift = on ? 1 + Math.sin(clock.elapsedTime * 2.4) * 0.04 : 1

      dummy.position.set(p.station.world[0], baseY, p.station.world[1])
      dummy.scale.set(on ? 1.5 : dim ? 0.8 : 1, p.height * lift, on ? 1.5 : dim ? 0.8 : 1)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix)

      scratch.set(on ? PALETTE.brassLit : PALETTE.brass)
      if (dim) scratch.multiplyScalar(0.45)
      m.setColorAt(i, scratch)
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  })

  if (!stations.length) return null

  return (
    <group>
      <instancedMesh
        ref={mesh}
        args={[geometry, undefined, placed.length]}
        frustumCulled={false}
        renderOrder={6}
        onClick={(ev) => {
          ev.stopPropagation()
          const i = ev.instanceId
          if (i === undefined) return
          const id = placed[i]?.station.id
          selectStation(id === selected ? null : id)
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <meshStandardMaterial
          metalness={0.6}
          roughness={0.3}
          emissive={new Color(PALETTE.brass)}
          emissiveIntensity={0.4}
        />
      </instancedMesh>

      {placed.map((p) => {
        const on = selected === p.station.id
        if (selected && !on) return null
        return (
          <Html
            key={p.station.id}
            position={[p.station.world[0], baseY + p.height + 1.4, p.station.world[1]]}
            center
            distanceFactor={58}
            zIndexRange={[18, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div
              className="whitespace-nowrap border px-1.5 py-0.5 text-center"
              style={{
                background: 'rgba(7,10,15,0.9)',
                borderColor: on ? PALETTE.brass : '#1E2A38',
              }}
            >
              <span
                className="block"
                style={{
                  fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                  fontSize: on ? 12 : 10,
                  fontWeight: 600,
                  color: on ? PALETTE.brassLit : PALETTE.khaki,
                }}
              >
                {p.station.name}
              </span>
              <span
                className="block"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 8,
                  color: '#8D8877',
                }}
              >
                ~{compact(p.station.estimated)}
              </span>
            </div>
          </Html>
        )
      })}
    </group>
  )
}
