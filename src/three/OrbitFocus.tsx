import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  OctahedronGeometry,
  TorusGeometry,
  Object3D,
  Vector3,
  type BufferGeometry as Geo,
  type Group,
  type InstancedMesh,
  type Mesh,
} from 'three'
import { PALETTE } from '@/lib/palette'
import { getFocusView, type FocusView } from '@/data/focus'
import type { NodeKind } from '@/data/types'
import { useYukti } from '@/store/useYukti'

/**
 * The orbit — one entity and its direct connections, and the motion between
 * them.
 *
 * The whole point of this view is the TRANSITION. Clicking a satellite rotates
 * the ring until that satellite reaches the front, then draws it inward as the
 * old centre swings out into its vacated slot. You watch your position in the
 * network change instead of having the screen redraw around you, which is the
 * difference between navigating and being teleported.
 *
 * Nothing crosses the interior. Ties between two satellites bulge OUTWARD past
 * the ring, so "your two associates know each other" is legible as a small arc
 * at the rim rather than as another line through an already busy middle.
 */

const RING_MIN = 15.5
const RING_MAX = 21
const NODE_Y = 0
const TRANSITION_SECONDS = 1.15
/** Radians per second at rest. Slow enough to read, fast enough to feel alive. */
const IDLE_SPIN = 0.11

const KIND_SCALE: Record<NodeKind, number> = {
  Organisation: 1.6,
  Person: 1.35,
  Location: 1.2,
  Incident: 1.1,
  Vehicle: 1.1,
}

function buildGeometry(): Record<NodeKind, Geo> {
  const ring = new TorusGeometry(0.85, 0.2, 8, 22)
  ring.rotateX(-Math.PI / 2)
  return {
    Person: new ConeGeometry(0.62, 1.8, 7),
    Incident: new OctahedronGeometry(0.7, 0),
    Location: new BoxGeometry(1.15, 0.3, 1.15),
    Vehicle: new BoxGeometry(1.5, 0.34, 0.55),
    Organisation: ring,
  }
}

interface Slot {
  id: string
  angle: number
  radius: number
  position: Vector3
}

/** Where each satellite sits: evenly spaced, pulled in by tie strength. */
function layoutOf(view: FocusView): Map<string, Slot> {
  const slots = new Map<string, Slot>()
  const n = view.satellites.length || 1
  view.satellites.forEach((s, i) => {
    const angle = (i / n) * Math.PI * 2
    // Stronger ties sit closer in — a real encoding on an axis that was
    // otherwise carrying nothing.
    const radius = RING_MAX - s.strength * (RING_MAX - RING_MIN)
    slots.set(s.node.id, {
      id: s.node.id,
      angle,
      radius,
      position: new Vector3(radius * Math.cos(angle), NODE_Y, radius * Math.sin(angle)),
    })
  })
  return slots
}

interface OrbitFocusProps {
  focusId: string
  onFocus: (id: string) => void
}

export function OrbitFocus({ focusId, onFocus }: OrbitFocusProps) {
  const selectNode = useYukti((s) => s.selectNode)
  const selectedNode = useYukti((s) => s.selectedNode)
  const geometry = useMemo(buildGeometry, [])
  const dummy = useMemo(() => new Object3D(), [])
  const scratch = useMemo(() => new Color(), [])

  const spinner = useRef<Group>(null)
  const centreRef = useRef<Mesh>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const view = useMemo(() => getFocusView(focusId), [focusId])

  /* Previous view, held through the transition so both can be drawn. */
  const prev = useRef<{ view: FocusView; slots: Map<string, Slot> } | null>(null)
  const t = useRef(1)
  const spin = useRef(0)
  const spinTarget = useRef(0)

  const slots = useMemo(() => (view ? layoutOf(view) : new Map<string, Slot>()), [view])

  useEffect(() => {
    t.current = 0
  }, [focusId])

  useEffect(() => {
    return () => {
      if (view) prev.current = { view, slots }
    }
  }, [view, slots])

  /**
   * Every mark drawn this frame — the union of the outgoing and incoming views,
   * so a node present in both slides between its two slots rather than
   * disappearing and reappearing somewhere else.
   */
  const cast = useMemo(() => {
    if (!view) return []
    const out: {
      id: string
      kind: NodeKind
      label: string
      from: Vector3
      to: Vector3
      fromScale: number
      toScale: number
      order: number
    }[] = []

    const before = prev.current
    const centreAt = new Vector3(0, NODE_Y, 0)

    view.satellites.forEach((s, i) => {
      const to = slots.get(s.node.id)!.position
      // A node that was the previous centre grows out of the middle; one that
      // was already in orbit slides across; anything new rises from the centre.
      const from = before?.slots.get(s.node.id)?.position ?? centreAt
      out.push({
        id: s.node.id,
        kind: s.node.kind,
        label: s.node.label,
        from,
        to,
        fromScale: before?.slots.has(s.node.id) ? 1 : 0,
        toScale: 1,
        order: i,
      })
    })

    // Outgoing satellites that have no place in the new view fall inward.
    if (before) {
      for (const s of before.view.satellites) {
        if (slots.has(s.node.id) || s.node.id === view.centre.id) continue
        out.push({
          id: s.node.id,
          kind: s.node.kind,
          label: s.node.label,
          from: before.slots.get(s.node.id)!.position,
          to: centreAt,
          fromScale: 1,
          toScale: 0,
          order: 0,
        })
      }
    }

    return out
  }, [view, slots])

  const byKind = useMemo(() => {
    const m = new Map<NodeKind, typeof cast>()
    for (const c of cast) {
      if (!m.has(c.kind)) m.set(c.kind, [])
      m.get(c.kind)!.push(c)
    }
    return m
  }, [cast])

  const meshes = useRef(new Map<NodeKind, InstancedMesh>())

  /* Spokes and rim arcs, rebuilt per view. */
  const lines = useMemo(() => {
    if (!view) return { spokes: new BufferGeometry(), rim: new BufferGeometry() }

    const spokes: number[] = []
    for (const s of view.satellites) {
      const p = slots.get(s.node.id)!.position
      // Start just outside the centre mark so the spoke does not spear it.
      const dir = p.clone().normalize()
      const a = dir.clone().multiplyScalar(3.1)
      spokes.push(a.x, NODE_Y, a.z, p.x, NODE_Y, p.z)
    }

    const rim: number[] = []
    for (const link of view.rim) {
      const a = slots.get(link.a)
      const b = slots.get(link.b)
      if (!a || !b) continue

      // Bulge outward past the ring. Routing these through the middle is what
      // turned every previous version into spaghetti.
      let delta = b.angle - a.angle
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2

      // Hug the rim. A bulge that scales freely with the angular gap throws
      // wide ellipses across the whole view, which read as stray orbits rather
      // than as a tie between two neighbours.
      const bulge = RING_MAX + 1.1 + Math.min(2.8, Math.abs(delta) * 1.5)
      const steps = 16
      let px = a.position.x
      let pz = a.position.z
      for (let i = 1; i <= steps; i++) {
        const k = i / steps
        const angle = a.angle + delta * k
        // Ease out to the bulge radius and back, so the arc leaves and rejoins
        // the ring tangentially instead of kinking.
        const lift = Math.sin(k * Math.PI)
        const radius = a.radius + (b.radius - a.radius) * k + (bulge - RING_MAX) * lift
        const x = radius * Math.cos(angle)
        const z = radius * Math.sin(angle)
        rim.push(px, NODE_Y, pz, x, NODE_Y, z)
        px = x
        pz = z
      }
    }

    const make = (arr: number[]) => {
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(arr, 3))
      return g
    }
    return { spokes: make(spokes), rim: make(rim) }
  }, [view, slots])

  useFrame((state, delta) => {
    if (t.current < 1) t.current = Math.min(1, t.current + delta / TRANSITION_SECONDS)
    // Ease-in-out: the ring accelerates away and settles, rather than snapping.
    const e = t.current < 0.5 ? 2 * t.current ** 2 : 1 - (-2 * t.current + 2) ** 2 / 2

    // Idle rotation keeps the instrument alive between interactions.
    spinTarget.current += delta * IDLE_SPIN
    spin.current += (spinTarget.current - spin.current) * Math.min(1, delta * 3)
    if (spinner.current) spinner.current.rotation.y = spin.current

    if (centreRef.current) {
      const s = 1 + Math.sin(state.clock.elapsedTime * 1.4) * 0.02
      centreRef.current.scale.setScalar(s * (0.4 + e * 0.6))
    }

    for (const [kind, list] of byKind) {
      const mesh = meshes.current.get(kind)
      if (!mesh) continue
      list.forEach((c, i) => {
        // Stagger arrivals slightly so the ring assembles rather than pops.
        const lead = Math.min(0.45, c.order * 0.028)
        const local = Math.max(0, Math.min(1, (e - lead) / (1 - lead || 1)))

        dummy.position.copy(c.from).lerp(c.to, local)
        const on = hovered === c.id || selectedNode === c.id
        const scale =
          (c.fromScale + (c.toScale - c.fromScale) * local) *
          KIND_SCALE[c.kind] *
          (on ? 1.5 : 1)
        dummy.scale.setScalar(Math.max(0.001, scale))
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)

        scratch.set(on ? PALETTE.brassLit : PALETTE.brass)
        if (hovered && !on) scratch.multiplyScalar(0.4)
        mesh.setColorAt(i, scratch)
      })
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  })

  if (!view) return null

  return (
    <group>
      {/* Centre mark — the entity in focus, outside the spinning group so it
          reads as fixed while the ring turns around it. */}
      <mesh ref={centreRef} position={[0, NODE_Y, 0]}>
        <icosahedronGeometry args={[2.4, 1]} />
        <meshStandardMaterial
          color={PALETTE.brassLit}
          metalness={0.7}
          roughness={0.22}
          emissive={new Color(PALETTE.brass)}
          emissiveIntensity={0.6}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, NODE_Y - 0.05, 0]}>
        <torusGeometry args={[3.6, 0.07, 6, 64]} />
        <meshBasicMaterial color={PALETTE.brass} transparent opacity={0.7} />
      </mesh>

      <group ref={spinner}>
        {/* The ring the satellites ride on. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[(RING_MIN + RING_MAX) / 2, 0.035, 4, 160]} />
          <meshBasicMaterial color={PALETTE.rule2} transparent opacity={0.5} />
        </mesh>

        <lineSegments geometry={lines.spokes} frustumCulled={false}>
          <lineBasicMaterial color={PALETTE.brass} transparent opacity={0.42} depthWrite={false} />
        </lineSegments>

        <lineSegments geometry={lines.rim} frustumCulled={false}>
          <lineBasicMaterial
            color={PALETTE.bhuvanDim}
            transparent
            opacity={hovered ? 0.16 : 0.3}
            depthWrite={false}
          />
        </lineSegments>

        {[...byKind.entries()].map(([kind, list]) => (
          <instancedMesh
            key={kind}
            ref={(m) => {
              if (m) meshes.current.set(kind, m)
            }}
            args={[geometry[kind], undefined, Math.max(1, list.length)]}
            frustumCulled={false}
            onPointerMove={(ev) => {
              ev.stopPropagation()
              const i = ev.instanceId
              setHovered(i !== undefined ? list[i]?.id ?? null : null)
            }}
            onPointerOut={() => setHovered(null)}
            onClick={(ev) => {
              ev.stopPropagation()
              const i = ev.instanceId
              if (i !== undefined && list[i]) selectNode(list[i].id)
            }}
            onDoubleClick={(ev) => {
              ev.stopPropagation()
              const i = ev.instanceId
              if (i !== undefined && list[i]) onFocus(list[i].id)
            }}
          >
            <meshStandardMaterial
              metalness={0.6}
              roughness={0.3}
              emissive={new Color(PALETTE.brass)}
              emissiveIntensity={0.28}
            />
          </instancedMesh>
        ))}

        <Labels view={view} slots={slots} hovered={hovered} onFocus={onFocus} />
      </group>

      <CentreLabel view={view} />
    </group>
  )
}

function Labels({
  view,
  slots,
  hovered,
  onFocus,
}: {
  view: FocusView
  slots: Map<string, Slot>
  hovered: string | null
  onFocus: (id: string) => void
}) {
  return (
    <>
      {view.satellites.map((s) => {
        const slot = slots.get(s.node.id)
        if (!slot) return null
        // Ride outward along the node's own bearing so labels separate radially.
        const out = 1.24
        const on = hovered === s.node.id
        return (
          <Html
            key={s.node.id}
            position={[slot.position.x * out, NODE_Y + 1.6, slot.position.z * out]}
            center
            distanceFactor={54}
            zIndexRange={[22, 0]}
          >
            <button
              onDoubleClick={() => onFocus(s.node.id)}
              className="whitespace-nowrap border px-1.5 py-0.5 text-center transition-colors"
              style={{
                background: on ? 'rgba(20,16,6,0.95)' : 'rgba(7,10,15,0.86)',
                borderColor: on ? PALETTE.brass : '#1E2A38',
                cursor: 'pointer',
              }}
            >
              <span
                className="block"
                style={{
                  fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                  fontSize: 12,
                  fontWeight: 600,
                  color: on ? PALETTE.brassLit : PALETTE.khaki,
                }}
              >
                {s.node.label}
              </span>
              <span
                className="block"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 8,
                  letterSpacing: '0.12em',
                  color: '#8D8877',
                }}
              >
                {s.kind.replace(/_/g, ' ')}
              </span>
            </button>
          </Html>
        )
      })}
    </>
  )
}

function CentreLabel({ view }: { view: FocusView }) {
  return (
    <Html position={[0, NODE_Y + 4.6, 0]} center distanceFactor={44} zIndexRange={[26, 0]}>
      <div
        className="whitespace-nowrap border px-2.5 py-1 text-center"
        style={{ background: 'rgba(7,10,15,0.94)', borderColor: PALETTE.brass }}
      >
        <span
          className="block"
          style={{
            fontFamily: "'IBM Plex Sans Condensed', sans-serif",
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '0.02em',
            color: PALETTE.brassLit,
          }}
        >
          {view.centre.label}
        </span>
        <span
          className="block"
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 9,
            letterSpacing: '0.18em',
            color: '#8D8877',
          }}
        >
          {view.centre.district.toUpperCase()} · {view.satellites.length} LINKS
        </span>
      </div>
    </Html>
  )
}
