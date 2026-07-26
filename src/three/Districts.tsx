import { getDistrictMetrics, volumeScale } from '@/data/api'
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  type Group,
  type Mesh,
} from 'three'
import type { DistrictFeature } from '@/lib/geo'
import { PALETTE, riskColor } from '@/lib/palette'
import { useYukti } from '@/store/useYukti'
import { sceneClock } from './clock'

/**
 * The instrument itself: 30 real district boundaries extruded into volume.
 *
 *   height = incident volume (square-root scaled — see volumeScale)
 *   colour = risk ramp
 *   rim    = brass outline on the top face
 *
 * A sweep rakes west→east across the state; districts near the sweep line lift
 * their emissive briefly, so the eye is carried across the whole state rather
 * than landing on Bengaluru and staying there.
 */

const MAX_HEIGHT = 14
const MIN_HEIGHT = 0.7

/** Extent in world X, used to convert the 0..1 playhead into a sweep position. */
const SWEEP_MIN = -62
const SWEEP_MAX = 62
const SWEEP_WIDTH = 13

interface Built {
  name: string
  geometry: ExtrudeGeometry
  rim: BufferGeometry
  height: number
  base: Color
  risk: number
  centreX: number
  world: [number, number]
  incidents: number
}

/** Top-face outline, drawn as a brass line loop sitting on the extrusion. */
function buildRim(f: DistrictFeature, height: number): BufferGeometry {
  const positions: number[] = []
  for (const shape of f.shapes) {
    const rings = [shape.getPoints(24), ...shape.holes.map((h) => h.getPoints(24))]
    for (const pts of rings) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        positions.push(a.x, a.y, height, b.x, b.y, height)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return g
}

interface DistrictsProps {
  features: DistrictFeature[]
  /** Global fade, used when the map hands over to the network in Act III. */
  opacity?: number
  /**
   * 0..1 desaturation toward slate. Under the network view the map has to stop
   * being a second dataset: a fully saturated risk choropleth and a bright
   * ribbon field compete, and neither wins. Boundaries and relief stay; the
   * colour moves onto the hub markers instead.
   */
  monochrome?: number
  interactive?: boolean
}

export function Districts({
  features,
  opacity = 1,
  monochrome = 0,
  interactive = true,
}: DistrictsProps) {
  const hovered = useYukti((s) => s.hoveredDistrict)
  const selected = useYukti((s) => s.selectedDistrict)
  const setHovered = useYukti((s) => s.setHoveredDistrict)
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const group = useRef<Group>(null)

  // Extrusion reveal is driven from the scene clock, not from props, so growing
  // the state out of the plate costs zero React renders.
  useFrame(() => {
    if (group.current) group.current.scale.z = Math.max(0.001, sceneClock.growth)
  })

  const built = useMemo<Built[]>(() => {
    const metrics = getDistrictMetrics()
    const scale = volumeScale()
    const byName = new Map(metrics.map((m) => [m.name, m]))

    return features.map((f) => {
      const m = byName.get(f.name)
      const height = MIN_HEIGHT + scale(m?.incidents ?? 0) * MAX_HEIGHT
      const geometry = new ExtrudeGeometry(f.shapes, {
        depth: height,
        bevelEnabled: true,
        bevelThickness: 0.12,
        bevelSize: 0.1,
        bevelSegments: 1,
        curveSegments: 2,
      })
      return {
        name: f.name,
        geometry,
        rim: buildRim(f, height + 0.14),
        height,
        base: riskColor(m?.riskNorm ?? 0),
        risk: m?.risk ?? 0,
        centreX: f.world[0],
        world: f.world,
        incidents: m?.incidents ?? 0,
      }
    })
  }, [features])

  return (
    <group ref={group} rotation={[-Math.PI / 2, 0, 0]}>
      {built.map((d) => (
        <DistrictBlock
          key={d.name}
          d={d}
          hovered={hovered === d.name}
          selected={selected === d.name}
          dimmed={!!selected && selected !== d.name}
          opacity={opacity}
          monochrome={monochrome}
          interactive={interactive}
          onHover={setHovered}
          onSelect={selectDistrict}
        />
      ))}
    </group>
  )
}

interface BlockProps {
  d: Built
  hovered: boolean
  selected: boolean
  dimmed: boolean
  opacity: number
  monochrome: number
  interactive: boolean
  onHover: (n: string | null) => void
  onSelect: (n: string | null) => void
}

function DistrictBlock({ d, hovered, selected, dimmed, opacity, monochrome, interactive, onHover, onSelect }: BlockProps) {
  const mesh = useRef<Mesh>(null)

  const SLATE = useMemo(() => new Color('#26313D'), [])

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: d.base.clone(),
        emissive: d.base.clone().multiplyScalar(0.46),
        emissiveIntensity: 0.75,
        metalness: 0.38,
        roughness: 0.44,
        transparent: true,
        opacity: 1,
      }),
    [d.base],
  )

  useFrame(() => {
    // Proximity to the sweep line, 0..1, with a soft falloff either side.
    const sweepX = SWEEP_MIN + sceneClock.sweep * (SWEEP_MAX - SWEEP_MIN)
    const dist = Math.abs(d.centreX - sweepX)
    const pulse = Math.max(0, 1 - dist / SWEEP_WIDTH) ** 2

    const target = 0.72 + pulse * 1.5 + (hovered ? 1.1 : 0) + (selected ? 1.4 : 0)
    material.emissiveIntensity += (target - material.emissiveIntensity) * 0.16

    // Desaturate toward slate rather than simply darkening — a dark orange is
    // still orange and still reads as a value on the risk ramp.
    material.color.copy(d.base).lerp(SLATE, monochrome)
    material.emissive.copy(material.color).multiplyScalar(0.46 * (1 - monochrome * 0.6))

    const wantOpacity = (dimmed ? 0.35 : 1) * opacity
    material.opacity += (wantOpacity - material.opacity) * 0.14
    material.visible = material.opacity > 0.01

    if (mesh.current) {
      const lift = (hovered ? 0.55 : 0) + (selected ? 0.9 : 0)
      mesh.current.position.z += (lift - mesh.current.position.z) * 0.18
    }
  })

  return (
    <group>
      <mesh
        ref={mesh}
        geometry={d.geometry}
        material={material}
        castShadow
        receiveShadow
        onPointerOver={
          interactive
            ? (e) => {
                e.stopPropagation()
                onHover(d.name)
                document.body.style.cursor = 'pointer'
              }
            : undefined
        }
        onPointerOut={
          interactive
            ? () => {
                onHover(null)
                document.body.style.cursor = ''
              }
            : undefined
        }
        onClick={
          interactive
            ? (e) => {
                e.stopPropagation()
                onSelect(selected ? null : d.name)
              }
            : undefined
        }
      />
      <lineSegments geometry={d.rim} position={[0, 0, hovered || selected ? 0.6 : 0]}>
        <lineBasicMaterial
          color={selected ? PALETTE.brassLit : hovered ? PALETTE.brassLit : PALETTE.brass}
          transparent
          opacity={(dimmed ? 0.18 : selected || hovered ? 0.95 : 0.5) * opacity}
        />
      </lineSegments>
    </group>
  )
}
