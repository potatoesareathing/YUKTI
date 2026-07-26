import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimNode } from 'd3-force-3d'
import {
  BufferGeometry,
  Color,

  Object3D,
  SphereGeometry,
  Vector3,
  type InstancedMesh,
  type Group,
} from 'three'
import { KIND_COLOR, PALETTE } from '@/lib/palette'
import { getNetwork } from '@/data/network'
import { shortestPath } from '@/data/graphpaths'
import type { GraphNode, NodeKind } from '@/data/types'
import { useYukti } from '@/store/useYukti'

/**
 * The whole entity graph, in the manner of Obsidian's graph view.
 *
 * Earlier versions of this module tried to make a dense graph legible by
 * reducing it — aggregating to districts, capping hops, showing one hop at a
 * time. This takes the opposite bet, and it is the bet Obsidian makes with
 * vaults of thousands of notes: show EVERYTHING, quietly, and let interaction do
 * the work.
 *
 * Three things make that work, and all three are load-bearing:
 *
 *   PHYSICS NEVER STOPS.  The simulation holds a small non-zero alpha forever,
 *     so the graph keeps breathing instead of freezing into a diagram. That
 *     motion is what makes a dense picture feel navigable rather than dead.
 *
 *   HOVER IS A SPOTLIGHT.  Pointing at a node drops everything that is not it
 *     or its direct neighbours to near-invisible. Any local neighbourhood
 *     becomes instantly readable without removing a single node from the view.
 *
 *   LABELS ARE EARNED.  Text appears for what you are pointing at and for the
 *     few highest-centrality nodes. Labelling everything is what turns a graph
 *     into noise.
 */

/** Alpha the simulation is held at. Enough to drift, not enough to wander. */
const IDLE_ALPHA = 0.015
/**
 * World units per simulation unit.
 *
 * OrbitControls captures the camera's position when it initialises, so setting
 * the camera from the measured extent in an effect gets overwritten. Scaling
 * the layout to the frame instead is the same fit from the other direction, and
 * it survives the analyst zooming afterwards.
 */
const SPREAD = 0.62
const ROTATE_SPEED = 0.02

interface Placed {
  node: GraphNode
  sim: SimNode
  size: number
  color: Color
}

export function GraphView() {
  const selectedNode = useYukti((s) => s.selectedNode)
  const selectNode = useYukti((s) => s.selectNode)
  const pathTarget = useYukti((s) => s.pathTarget)

  const { camera } = useThree()
  const spinner = useRef<Group>(null)
  const meshes = useRef(new Map<NodeKind, InstancedMesh>())
  const edgeRef = useRef<BufferGeometry>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const scratch = useMemo(() => new Color(), [])
  const [hovered, setHovered] = useState<string | null>(null)

  const graph = useMemo(() => getNetwork(), [])

  /* The simulation, built once and left running. */
  const sim = useMemo(() => {
    const simNodes: SimNode[] = graph.nodes.map((n) => ({ id: n.id }))
    const simLinks = graph.edges
      .filter((e) => !e.predicted)
      .map((e) => ({ source: e.source, target: e.target }))

    const simulation = forceSimulation(simNodes, 3)
      .force(
        'link',
        forceLink(simLinks)
          .id((d) => d.id)
          .distance(7)
          .strength(0.55),
      )
      .force('charge', forceManyBody().strength(-17).distanceMax(90).theta(0.9))
      .force('centre', forceCenter(0, 0, 0).strength(0.6))
      .alphaDecay(0.028)
      // Never let alpha reach zero: a frozen graph reads as a screenshot.
      .alphaMin(0)

    // Warm it up so the first frame is already a graph, not a ball.
    simulation.stop()
    simulation.tick(220)

    const byId = new Map(simNodes.map((n) => [n.id, n]))
    return { simulation, simNodes, byId }
  }, [graph])

  const placed = useMemo<Placed[]>(
    () =>
      graph.nodes.map((node) => ({
        node,
        sim: sim.byId.get(node.id)!,
        // Obsidian sizes by link count; PageRank is the better measure here and
        // the panels already rank by it.
        size: 0.34 + Math.sqrt(node.degree) * 0.2 + node.centrality * 0.9,
        color: new Color(KIND_COLOR[node.kind]),
      })),
    [graph.nodes, sim],
  )

  const byKind = useMemo(() => {
    const m = new Map<NodeKind, Placed[]>()
    for (const p of placed) {
      if (!m.has(p.node.kind)) m.set(p.node.kind, [])
      m.get(p.node.kind)!.push(p)
    }
    return m
  }, [placed])

  const edges = useMemo(() => graph.edges, [graph.edges])
  const edgeBuffer = useMemo(() => new Float32Array(edges.length * 6), [edges])

  /** Everything one step from what the pointer or the selection is on. */
  const focus = useMemo(() => {
    const id = hovered ?? selectedNode
    if (!id) return null
    const keep = new Set([id])
    for (const e of edges) {
      if (e.source === id) keep.add(e.target)
      else if (e.target === id) keep.add(e.source)
    }
    return { id, keep }
  }, [hovered, selectedNode, edges])

  /* Keep the simulation warm rather than letting it converge and stop. */
  useEffect(() => {
    const s = sim.simulation
    return () => {
      s.stop()
    }
  }, [sim])

  const geometry = useMemo(() => new SphereGeometry(1, 12, 10), [])

  useFrame((_, delta) => {
    const s = sim.simulation
    // Hold a floor under alpha so the graph keeps drifting indefinitely.
    s.tick(1)
    const current = (s as unknown as { alpha(): number }).alpha?.() ?? 1
    if (current < IDLE_ALPHA) s.alpha(IDLE_ALPHA)

    if (spinner.current) spinner.current.rotation.y += delta * ROTATE_SPEED

    for (const [kind, list] of byKind) {
      const mesh = meshes.current.get(kind)
      if (!mesh) continue
      list.forEach((p, i) => {
        const dim = focus ? !focus.keep.has(p.node.id) : false
        const isFocus = focus?.id === p.node.id

        dummy.position.set(
          (p.sim.x ?? 0) * SPREAD,
          (p.sim.y ?? 0) * SPREAD,
          (p.sim.z ?? 0) * SPREAD,
        )
        dummy.scale.setScalar(p.size * (isFocus ? 2 : dim ? 0.7 : 1))
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)

        if (isFocus) scratch.set(PALETTE.brassLit)
        else scratch.copy(p.color)
        if (dim) scratch.multiplyScalar(0.13)
        mesh.setColorAt(i, scratch)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }

    edges.forEach((e, i) => {
      const a = sim.byId.get(e.source)
      const b = sim.byId.get(e.target)
      if (!a || !b) return
      edgeBuffer[i * 6] = (a.x ?? 0) * SPREAD
      edgeBuffer[i * 6 + 1] = (a.y ?? 0) * SPREAD
      edgeBuffer[i * 6 + 2] = (a.z ?? 0) * SPREAD
      edgeBuffer[i * 6 + 3] = (b.x ?? 0) * SPREAD
      edgeBuffer[i * 6 + 4] = (b.y ?? 0) * SPREAD
      edgeBuffer[i * 6 + 5] = (b.z ?? 0) * SPREAD
    })
    if (edgeRef.current) {
      const attr = edgeRef.current.getAttribute('position')
      if (attr) attr.needsUpdate = true
    }
  })

  /* Labels: what you are pointing at, its neighbours, and the few busiest. */
  const alwaysLabelled = useMemo(
    () =>
      new Set(
        [...placed]
          .sort((a, b) => b.node.centrality - a.node.centrality)
          .slice(0, 6)
          .map((p) => p.node.id),
      ),
    [placed],
  )

  const labelled = useMemo(() => {
    if (!focus) return alwaysLabelled
    return focus.keep
  }, [focus, alwaysLabelled])

  /**
   * Frame the graph from its actual extent rather than a guessed distance. The
   * simulation's scale depends on node count, charge and link distance, so any
   * hard-coded camera position is wrong the moment one of those is tuned.
   */
  useEffect(() => {
    let radius = 1
    for (const n of sim.simNodes) {
      radius = Math.max(radius, Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) * SPREAD)
    }
    const fov = ((camera as { fov?: number }).fov ?? 38) * (Math.PI / 180)
    // Generous margin: the simulation is still live, so the extent measured at
    // mount is a floor rather than a final answer, and the labels need room
    // beyond the outermost node.
    camera.position.set(0, radius * 0.15, (radius / Math.tan(fov / 2)) * 2.1)
    camera.lookAt(0, 0, 0)
  }, [camera, sim])

  return (
    <group>
      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        minDistance={22}
        maxDistance={190}
        dampingFactor={0.09}
        makeDefault
      />

      <group ref={spinner}>
        <lineSegments frustumCulled={false} renderOrder={1}>
          <bufferGeometry ref={edgeRef}>
            <bufferAttribute attach="attributes-position" args={[edgeBuffer, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color={PALETTE.khakiDim}
            transparent
            opacity={focus ? 0.07 : 0.3}
            depthWrite={false}
          />
        </lineSegments>

        {focus && <FocusEdges edges={edges} sim={sim} focusId={focus.id} />}

        {[...byKind.entries()].map(([kind, list]) => (
          <instancedMesh
            key={kind}
            ref={(m) => {
              if (m) meshes.current.set(kind, m)
            }}
            args={[geometry, undefined, list.length]}
            frustumCulled={false}
            renderOrder={2}
            onPointerMove={(ev) => {
              ev.stopPropagation()
              const i = ev.instanceId
              setHovered(i !== undefined ? (list[i]?.node.id ?? null) : null)
            }}
            onPointerOut={() => setHovered(null)}
            onClick={(ev) => {
              ev.stopPropagation()
              const i = ev.instanceId
              if (i !== undefined && list[i]) selectNode(list[i].node.id)
            }}
          >
            <meshStandardMaterial
              metalness={0.05}
              roughness={0.95}
              emissive={new Color(PALETTE.brass)}
              emissiveIntensity={0.55}
            />
          </instancedMesh>
        ))}

        <GraphLabels placed={placed} labelled={labelled} focusId={focus?.id ?? null} />
      </group>

      {pathTarget && <PathHighlight sim={sim} />}
    </group>
  )
}

/** The hovered node's own edges, drawn bright over the dimmed field. */
function FocusEdges({
  edges,
  sim,
  focusId,
}: {
  edges: ReturnType<typeof getNetwork>['edges']
  sim: { byId: Map<string, SimNode> }
  focusId: string
}) {
  const ref = useRef<BufferGeometry>(null)
  const own = useMemo(
    () => edges.filter((e) => e.source === focusId || e.target === focusId),
    [edges, focusId],
  )
  const buffer = useMemo(() => new Float32Array(own.length * 6), [own])

  useFrame(() => {
    own.forEach((e, i) => {
      const a = sim.byId.get(e.source)
      const b = sim.byId.get(e.target)
      if (!a || !b) return
      buffer[i * 6] = (a.x ?? 0) * SPREAD
      buffer[i * 6 + 1] = (a.y ?? 0) * SPREAD
      buffer[i * 6 + 2] = (a.z ?? 0) * SPREAD
      buffer[i * 6 + 3] = (b.x ?? 0) * SPREAD
      buffer[i * 6 + 4] = (b.y ?? 0) * SPREAD
      buffer[i * 6 + 5] = (b.z ?? 0) * SPREAD
    })
    const attr = ref.current?.getAttribute('position')
    if (attr) attr.needsUpdate = true
  })

  if (!own.length) return null

  return (
    <lineSegments frustumCulled={false} renderOrder={3}>
      <bufferGeometry ref={ref}>
        <bufferAttribute attach="attributes-position" args={[buffer, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PALETTE.brassLit} transparent opacity={0.85} depthWrite={false} />
    </lineSegments>
  )
}

function GraphLabels({
  placed,
  labelled,
  focusId,
}: {
  placed: Placed[]
  labelled: Set<string>
  focusId: string | null
}) {
  const group = useRef<Group>(null)
  const scratch = useMemo(() => new Vector3(), [])

  // Labels follow their node every frame; React state would re-render the whole
  // list sixty times a second for what is a transform.
  useFrame(() => {
    const g = group.current
    if (!g) return
    let i = 0
    for (const p of placed) {
      if (!labelled.has(p.node.id)) continue
      const child = g.children[i++]
      if (!child) continue
      scratch.set(
        (p.sim.x ?? 0) * SPREAD,
        (p.sim.y ?? 0) * SPREAD + p.size + 1.2,
        (p.sim.z ?? 0) * SPREAD,
      )
      child.position.copy(scratch)
    }
  })

  const visible = placed.filter((p) => labelled.has(p.node.id))

  return (
    <group ref={group}>
      {visible.map((p) => {
        const on = focusId === p.node.id
        return (
          <Html
            key={p.node.id}
            center
            distanceFactor={130}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <span
              className="whitespace-nowrap px-1"
              style={{
                fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                fontSize: on ? 15 : 12,
                fontWeight: on ? 700 : 500,
                color: on ? PALETTE.brassLit : PALETTE.khaki,
                textShadow: '0 0 6px rgba(7,10,15,0.95), 0 0 12px rgba(7,10,15,0.9)',
              }}
            >
              {p.node.label}
            </span>
          </Html>
        )
      })}
    </group>
  )
}

/** The shortest-path chain, lit over the dimmed graph. */
function PathHighlight({ sim }: { sim: { byId: Map<string, SimNode> } }) {
  const origin = useYukti((s) => s.egoOrigin)
  const target = useYukti((s) => s.pathTarget)
  const ref = useRef<BufferGeometry>(null)

  const chain = useMemo(
    () => (origin && target ? (shortestPath(origin, target)?.nodes.map((n) => n.id) ?? []) : []),
    [origin, target],
  )

  const buffer = useMemo(() => new Float32Array(Math.max(1, chain.length - 1) * 6), [chain])

  useFrame(() => {
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = sim.byId.get(chain[i])
      const b = sim.byId.get(chain[i + 1])
      if (!a || !b) continue
      buffer[i * 6] = (a.x ?? 0) * SPREAD
      buffer[i * 6 + 1] = (a.y ?? 0) * SPREAD
      buffer[i * 6 + 2] = (a.z ?? 0) * SPREAD
      buffer[i * 6 + 3] = (b.x ?? 0) * SPREAD
      buffer[i * 6 + 4] = (b.y ?? 0) * SPREAD
      buffer[i * 6 + 5] = (b.z ?? 0) * SPREAD
    }
    const attr = ref.current?.getAttribute('position')
    if (attr) attr.needsUpdate = true
  })

  if (chain.length < 2) return null

  return (
    <lineSegments frustumCulled={false} renderOrder={4}>
      <bufferGeometry ref={ref}>
        <bufferAttribute attach="attributes-position" args={[buffer, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PALETTE.redzone} transparent opacity={0.95} depthWrite={false} />
    </lineSegments>
  )
}
