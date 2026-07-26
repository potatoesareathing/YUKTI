import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  TorusGeometry,
  Object3D,
  Vector3,
  type BufferGeometry as Geo,
  type Group,
  type InstancedMesh,
} from 'three'
import { PALETTE, riskColor } from '@/lib/palette'
import type { DistrictFeature } from '@/lib/geo'
import { getDistrictMetrics } from '@/data/districts'
import { communityDistricts, getDistrictFlows, linkedDistricts } from '@/data/flows'
import { getNetwork } from '@/data/network'
import type { GraphNode } from '@/data/types'
import { useYukti } from '@/store/useYukti'

/**
 * Link analysis, drawn at the level the question is asked (§7.2).
 *
 * The overview shows JURISDICTIONS, not individuals: one hub per district
 * carrying everything that stays inside it, and a weighted ribbon per district
 * pair carrying everything that crosses between them. That is roughly thirty
 * marks and thirty ribbons instead of two hundred specks and seven hundred
 * threads — the difference between a readable map and a hairball.
 *
 * Individual records have not gone anywhere. Selecting a district or a community
 * resolves its people, incidents and their real ties, while the rest of the
 * state drops back. Detail on demand, rather than everything at once.
 *
 * Under all of it the map runs near-monochrome, so risk colour lives on the hubs
 * and the ground stays ground.
 */

/* ── Layout ────────────────────────────────────────────────────────────────── */

const ARC_LIFT = 0.24
const ARC_CEILING = 26
const ARC_SAMPLES = 26

const RING_BASE = 1.5
const RING_SCALE = 0.62
const PIN_BASE = 4
const PIN_SCALE = 2.5

/** Golden angle — packs a district's individual nodes with no clumping seam. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const SPIRAL_STEP = 1.5

interface HubPlace {
  district: string
  world: [number, number]
  entities: number
  ringScale: number
  pinHeight: number
  color: Color
  risk: number
}

/** Quadratic bézier through a raised midpoint, sampled as points. */
function arcPoints(
  ax: number,
  az: number,
  ay: number,
  bx: number,
  bz: number,
  by: number,
): Vector3[] {
  const ground = Math.hypot(bx - ax, bz - az)
  const apex = Math.max(ay, by) + Math.min(ground * ARC_LIFT, ARC_CEILING) + 2
  const cx = (ax + bx) / 2
  const cz = (az + bz) / 2

  const pts: Vector3[] = []
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES
    const u = 1 - t
    pts.push(
      new Vector3(
        u * u * ax + 2 * u * t * cx + t * t * bx,
        u * u * ay + 2 * u * t * apex + t * t * by,
        u * u * az + 2 * u * t * cz + t * t * bz,
      ),
    )
  }
  return pts
}

/* ── Component ─────────────────────────────────────────────────────────────── */

interface ConstellationProps {
  data: { nodes: GraphNode[] }
  features: DistrictFeature[]
  /** 0 = collapsed onto the map, 1 = fully risen. */
  morph?: number
  showPredicted?: boolean
  interactive?: boolean
  opacity?: number
}

export function Constellation({
  features,
  morph = 1,
  showPredicted = false,
  interactive = true,
  opacity = 1,
}: ConstellationProps) {
  const selectedDistrict = useYukti((s) => s.selectedDistrict)
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const selectedNode = useYukti((s) => s.selectedNode)

  const rise = useRef<Group>(null)
  const ringsRef = useRef<InstancedMesh>(null)
  const pinsRef = useRef<InstancedMesh>(null)
  const capsRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const scratch = useMemo(() => new Color(), [])
  const BRASS = useMemo(() => new Color(PALETTE.brass), [])
  const BRASS_LIT = useMemo(() => new Color(PALETTE.brassLit), [])
  const observedColor = useMemo(() => new Color(PALETTE.bhuvan), [])
  const predictedColor = useMemo(() => new Color(PALETTE.brass), [])

  const aggregate = useMemo(() => getDistrictFlows(2), [])

  /* Hubs, positioned on their district centroids. */
  const hubs = useMemo<HubPlace[]>(() => {
    const centre = new Map(features.map((f) => [f.name, f.world]))
    const risk = new Map(getDistrictMetrics().map((d) => [d.name, d.riskNorm]))

    return aggregate.hubs
      .filter((h) => centre.has(h.district))
      .map((h) => {
        const r = risk.get(h.district) ?? 0
        return {
          district: h.district,
          world: centre.get(h.district)!,
          entities: h.entities,
          ringScale: RING_BASE + Math.sqrt(h.entities) * RING_SCALE,
          pinHeight: PIN_BASE + Math.sqrt(h.entities) * PIN_SCALE,
          // The ground is monochrome under this view, so risk colour lives here
          // instead — the information is kept, just moved to where it reads.
          color: riskColor(r),
          risk: r,
        }
      })
  }, [aggregate, features])

  const hubByDistrict = useMemo(() => new Map(hubs.map((h) => [h.district, h])), [hubs])

  /* Which districts are in focus, if any. */
  const focus = useMemo(() => {
    if (selectedNode) {
      const node = getNetwork().nodes.find((n) => n.id === selectedNode)
      if (node) return communityDistricts(node.community)
    }
    if (selectedDistrict) return linkedDistricts(selectedDistrict)
    return null
  }, [selectedNode, selectedDistrict])

  /* Ribbons — one per district pair, width carrying the tie count. */
  const ribbons = useMemo(() => {
    return aggregate.flows.flatMap((f) => {
      const a = hubByDistrict.get(f.a)
      const b = hubByDistrict.get(f.b)
      if (!a || !b) return []
      return [
        {
          flow: f,
          points: arcPoints(
            a.world[0],
            a.world[1],
            a.pinHeight,
            b.world[0],
            b.world[1],
            b.pinHeight,
          ),
          // Near-linear above the threshold, capped. A square root compressed
          // the whole range into 2.8–5px, which is not a difference anyone can
          // compare by eye — and comparing weights is the entire point of
          // aggregating to corridors in the first place.
          width: Math.min(9.5, 1.2 + (f.ties - aggregate.minTies) * 1.15),
          predictedShare: f.ties ? f.predicted / f.ties : 0,
        },
      ]
    })
  }, [aggregate, hubByDistrict])

  /* Detail layer — individual records, only for districts in focus. */
  const detail = useMemo(() => {
    if (!focus) return null
    const { nodes, edges } = getNetwork()
    const centre = new Map(features.map((f) => [f.name, f.world]))

    const inFocus = nodes.filter((n) => focus.has(n.district))
    const grouped = new Map<string, GraphNode[]>()
    for (const n of inFocus) {
      if (!grouped.has(n.district)) grouped.set(n.district, [])
      grouped.get(n.district)!.push(n)
    }

    const placed = new Map<string, Vector3>()
    for (const [district, members] of grouped) {
      const home = centre.get(district) ?? [0, 0]
      const hub = hubByDistrict.get(district)
      const base = (hub?.pinHeight ?? PIN_BASE) + 2
      members
        .sort((p, q) => q.centrality - p.centrality)
        .forEach((n, i) => {
          const radius = SPIRAL_STEP * Math.sqrt(i) + (hub?.ringScale ?? 2) * 0.5
          const theta = i * GOLDEN_ANGLE
          placed.set(
            n.id,
            new Vector3(
              home[0] + radius * Math.cos(theta),
              base + n.centrality * 12,
              home[1] + radius * Math.sin(theta),
            ),
          )
        })
    }

    const positions: number[] = []
    for (const e of edges) {
      const a = placed.get(e.source)
      const b = placed.get(e.target)
      if (!a || !b) continue
      const pts = arcPoints(a.x, a.z, a.y, b.x, b.z, b.y)
      for (let i = 0; i + 1 < pts.length; i++) {
        positions.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z)
      }
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))

    return { placed: [...placed.entries()], nodes: inFocus, edges: geo }
  }, [focus, features, hubByDistrict])

  /* Shared geometry for the hub markers. */
  const markers = useMemo(() => {
    const ring = new TorusGeometry(1, 0.075, 6, 28)
    ring.rotateX(-Math.PI / 2)
    // Origin at the base, so instance scale.y reads directly as height.
    const pin = new CylinderGeometry(0.11, 0.3, 1, 7)
    pin.translate(0, 0.5, 0)
    return { ring, pin, cap: new ConeGeometry(0.62, 1.5, 7) }
  }, [])

  const detailGeometry = useMemo(() => {
    const dot = new ConeGeometry(0.34, 0.95, 6)
    return dot
  }, [])

  const eased = useRef(morph)
  const settled = useRef(false)

  useEffect(() => {
    settled.current = false
  }, [focus, opacity, showPredicted])

  useFrame((_, delta) => {
    const gap = morph - eased.current
    eased.current += gap * Math.min(1, delta * 4.5)
    if (Math.abs(gap) < 0.0005 && settled.current) return
    settled.current = Math.abs(gap) < 0.0005

    const t = Math.min(1, Math.max(0, eased.current))
    const e = 1 - Math.pow(1 - t, 3)
    if (rise.current) rise.current.scale.y = Math.max(0.0001, e)

    hubs.forEach((h, i) => {
      const dim = focus ? !focus.has(h.district) : false

      if (ringsRef.current) {
        dummy.position.set(h.world[0], 0.2, h.world[1])
        dummy.scale.set(h.ringScale, 1, h.ringScale)
        dummy.updateMatrix()
        ringsRef.current.setMatrixAt(i, dummy.matrix)
        scratch.copy(h.color).multiplyScalar(dim ? 0.25 : 1)
        ringsRef.current.setColorAt(i, scratch)
      }
      if (pinsRef.current) {
        dummy.position.set(h.world[0], 0.2, h.world[1])
        dummy.scale.set(1, h.pinHeight, 1)
        dummy.updateMatrix()
        pinsRef.current.setMatrixAt(i, dummy.matrix)
        scratch.copy(h.color).lerp(BRASS, 0.55).multiplyScalar(dim ? 0.28 : 1)
        pinsRef.current.setColorAt(i, scratch)
      }
      if (capsRef.current) {
        dummy.position.set(h.world[0], h.pinHeight + 0.5, h.world[1])
        dummy.scale.setScalar(dim ? 0.7 : 1)
        dummy.updateMatrix()
        capsRef.current.setMatrixAt(i, dummy.matrix)
        scratch.copy(h.color).lerp(BRASS_LIT, 0.3).multiplyScalar(dim ? 0.35 : 1.5)
        capsRef.current.setColorAt(i, scratch)
      }
    })

    for (const m of [ringsRef.current, pinsRef.current, capsRef.current]) {
      if (!m) continue
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
  })

  const pick = (district: string) => {
    if (!interactive) return
    selectDistrict(district === selectedDistrict ? null : district)
  }

  return (
    <group>
      <group ref={rise}>
        {ribbons.map(({ flow, points, width, predictedShare }) => {
          const inFocus = !focus || (focus.has(flow.a) && focus.has(flow.b))
          // Tint in PROPORTION to how much of the corridor is predicted. A
          // straight boolean turned a corridor of eight records and one
          // hypothesis fully brass, which claims the whole route is speculative
          // — the opposite of what §10.3 asks the platform to communicate.
          const color = showPredicted
            ? observedColor.clone().lerp(predictedColor, predictedShare)
            : observedColor
          return (
            <Line
              key={flow.id}
              points={points}
              color={color}
              lineWidth={width}
              transparent
              opacity={(inFocus ? 0.85 : 0.12) * opacity}
              depthWrite={false}
            />
          )
        })}

        {detail && (
          <lineSegments geometry={detail.edges} frustumCulled={false} renderOrder={6}>
            <lineBasicMaterial
              color={PALETTE.brassLit}
              transparent
              opacity={0.55 * opacity}
              depthWrite={false}
              blending={AdditiveBlending}
            />
          </lineSegments>
        )}
      </group>

      {/* Hub markers. Outside the rising group so the marks are never squashed. */}
      <instancedMesh
        ref={ringsRef}
        args={[markers.ring, undefined, hubs.length]}
        frustumCulled={false}
        onClick={
          interactive
            ? (ev) => {
                ev.stopPropagation()
                const i = ev.instanceId
                if (i !== undefined) pick(hubs[i].district)
              }
            : undefined
        }
        onPointerOver={interactive ? () => (document.body.style.cursor = 'pointer') : undefined}
        onPointerOut={interactive ? () => (document.body.style.cursor = '') : undefined}
      >
        <meshStandardMaterial
          metalness={0.6}
          roughness={0.3}
          emissive={new Color(PALETTE.brass)}
          emissiveIntensity={0.3}
          transparent
          opacity={opacity}
        />
      </instancedMesh>

      <instancedMesh ref={pinsRef} args={[markers.pin, undefined, hubs.length]} frustumCulled={false}>
        <meshStandardMaterial
          metalness={0.5}
          roughness={0.42}
          emissive={new Color(PALETTE.brass)}
          emissiveIntensity={0.5}
          transparent
          opacity={0.95 * opacity}
        />
      </instancedMesh>

      <instancedMesh
        ref={capsRef}
        args={[markers.cap, undefined, hubs.length]}
        frustumCulled={false}
        onClick={
          interactive
            ? (ev) => {
                ev.stopPropagation()
                const i = ev.instanceId
                if (i !== undefined) pick(hubs[i].district)
              }
            : undefined
        }
      >
        <meshStandardMaterial
          metalness={0.65}
          roughness={0.26}
          emissive={new Color(PALETTE.brassLit)}
          emissiveIntensity={0.85}
          transparent
          opacity={opacity}
        />
      </instancedMesh>

      {detail && <DetailMarks placed={detail.placed} geometry={detailGeometry} opacity={opacity} />}
    </group>
  )
}

/** Individual records for the districts currently in focus. */
function DetailMarks({
  placed,
  geometry,
  opacity,
}: {
  placed: [string, Vector3][]
  geometry: Geo
  opacity: number
}) {
  const ref = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    placed.forEach(([, p], i) => {
      dummy.position.copy(p)
      dummy.scale.setScalar(0.9)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [placed, dummy])

  return (
    <instancedMesh ref={ref} args={[geometry, undefined, placed.length]} frustumCulled={false}>
      <meshStandardMaterial
        color={PALETTE.khaki}
        metalness={0.4}
        roughness={0.45}
        emissive={new Color(PALETTE.brass)}
        emissiveIntensity={0.25}
        transparent
        opacity={opacity}
      />
    </instancedMesh>
  )
}

