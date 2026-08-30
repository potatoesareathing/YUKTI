import { getNetwork, shortestPath } from '@/data/api'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimNode,
} from 'd3-force-3d'
import {
  BufferGeometry,
  Color,

  Object3D,
  SphereGeometry,
  Vector3,
  type InstancedMesh,
  type Group,
  type Mesh,
} from 'three'
import { KIND_COLOR, EDGE_LAYER, PALETTE } from '@/lib/palette'
import type { EdgeKind, GraphData, GraphNode, NodeKind } from '@/data/types'
import { useYukti } from '@/store/useYukti'

/**
 * Entity graph view — Obsidian-style force layout over the cached network.
 *
 * Bootstrap can ship thousands of FIR-scale nodes. Running d3-force over that
 * entire set (and warming with hundreds of ticks) freezes the main thread so
 * the WebGL canvas never paints. The layout therefore draws a high-centrality
 * core, always expanding to include the current selection / path endpoints and
 * their neighbours. Path finding and side panels still use the full cached graph.
 *
 * Three interaction rules stay load-bearing:
 *
 *   PHYSICS NEVER STOPS.  The simulation holds a small non-zero alpha forever,
 *     so the graph keeps breathing instead of freezing into a diagram.
 *
 *   HOVER IS A SPOTLIGHT.  Pointing at a node drops everything that is not it
 *     or its direct neighbours to near-invisible.
 *
 *   LABELS ARE EARNED.  Text appears for the pointer subject and the busiest nodes.
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
const SPREAD = 0.42
const ROTATE_SPEED = 0.02
/** How close the camera settles to a selected node. */
const FOCUS_DISTANCE = 52
const UP = new Vector3(0, 1, 0)
/**
 * Soft cap for the force layout. The client-side demo graph sits well under this;
 * the AppSail bootstrap graph does not (~6–7k nodes).
 */
const VIEW_NODE_LIMIT = 420

interface Placed {
  node: GraphNode
  sim: SimNode
  size: number
  color: Color
}

/** Induced subgraph: centrality core + any focus ids and their one-hop neighbours. */
function pickViewGraph(
  full: GraphData,
  focusIds: string[],
  district: string | null = null,
  limit = VIEW_NODE_LIMIT,
): GraphData {
  if (full.nodes.length === 0 || full.nodes.length <= limit) return full

  const byId = new Map(full.nodes.map((n) => [n.id, n]))
  const keep = new Set<string>()
  const focus = focusIds.filter((id) => byId.has(id))

  for (const id of focus) {
    keep.add(id)
    for (const e of full.edges) {
      if (e.source === id) keep.add(e.target)
      else if (e.target === id) keep.add(e.source)
    }
  }

  /*
   * A district filter has to reach the core selection, not just the shading.
   *
   * The core is otherwise chosen on centrality alone, so a district whose
   * entities are all mid-ranked contributes nothing to it — and then the filter
   * dims every node that IS drawn. The analyst arrives from the map and finds an
   * empty graph, which reads as a broken view rather than a narrowed one. Seed
   * the core with that district's own best-connected nodes first.
   */
  if (district) {
    const local = full.nodes
      .filter((n) => n.district === district)
      .sort((a, b) => b.centrality - a.centrality || b.degree - a.degree)
    for (const n of local) {
      if (keep.size >= limit) break
      keep.add(n.id)
    }
  }

  const ranked = [...full.nodes].sort(
    (a, b) => b.centrality - a.centrality || b.degree - a.degree,
  )
  for (const n of ranked) {
    if (keep.size >= limit) break
    keep.add(n.id)
  }

  if (keep.size > limit) {
    // Focus nodes and the filtered district survive the trim — they are the
    // reason the view is scoped the way it is.
    const pinned = new Set([
      ...focus,
      ...(district
        ? full.nodes.filter((n) => n.district === district).map((n) => n.id)
        : []),
    ])
    const trim = [...keep]
      .filter((id) => !pinned.has(id))
      .sort((a, b) => (byId.get(a)?.centrality ?? 0) - (byId.get(b)?.centrality ?? 0))
    for (const id of trim) {
      if (keep.size <= limit) break
      keep.delete(id)
    }
  }

  return {
    nodes: full.nodes.filter((n) => keep.has(n.id)),
    edges: full.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  }
}

export function GraphView({ revision = 0 }: { revision?: number }) {
  const selectedNode = useYukti((s) => s.selectedNode)
  const selectNode = useYukti((s) => s.selectNode)
  const pathFrom = useYukti((s) => s.pathFrom)
  const pathTo = useYukti((s) => s.pathTo)
  const showPredicted = useYukti((s) => s.showPredicted)
  /**
   * A district chosen on the map narrows the graph here.
   *
   * This is the one link between the geospatial and network views, and it runs
   * one way on purpose: MOD-01 answers "where", so a district selected there is
   * a question the analyst is still asking when they arrive. Nothing in this
   * module writes back — a view that silently retargets the module you came
   * from stops being navigable.
   */
  const districtFilter = useYukti((s) => s.selectedDistrict)
  const showCdrLinks = useYukti((s) => s.showCdrLinks)
  const showAnprHits = useYukti((s) => s.showAnprHits)
  const showBankTx = useYukti((s) => s.showBankTx)
  const syndicateHighlight = useYukti((s) => s.syndicateHighlight)

  const { camera } = useThree()
  const controls = useThree((state) => state.controls) as
    | { target: Vector3; update: () => void }
    | null
  const spinner = useRef<Group>(null)
  const meshes = useRef(new Map<NodeKind, InstancedMesh>())
  const edgeRef = useRef<BufferGeometry>(null)
  const predictedRef = useRef<BufferGeometry>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const scratch = useMemo(() => new Color(), [])
  const [hovered, setHovered] = useState<string | null>(null)

  const focusIds = useMemo(
    () => [selectedNode, pathFrom, pathTo, ...syndicateHighlight].filter((id): id is string => !!id),
    [selectedNode, pathFrom, pathTo, syndicateHighlight],
  )

  const allowedKinds = useMemo(() => {
    const kinds = new Set<EdgeKind>(EDGE_LAYER.core)
    if (showCdrLinks) EDGE_LAYER.cdr.forEach((k) => kinds.add(k))
    if (showAnprHits) EDGE_LAYER.anpr.forEach((k) => kinds.add(k))
    if (showBankTx) EDGE_LAYER.finance.forEach((k) => kinds.add(k))
    return kinds
  }, [showCdrLinks, showAnprHits, showBankTx])

  // `revision` bumps when bootstrap hydrates so we never keep an empty mount snapshot.
  const graph = useMemo(() => {
    const full = getNetwork()
    const filtered: GraphData = {
      nodes: full.nodes,
      edges: full.edges.filter((e) => allowedKinds.has(e.kind)),
    }
    return pickViewGraph(filtered, focusIds, districtFilter)
  }, [revision, focusIds, allowedKinds, districtFilter])

  /* The simulation, rebuilt when the visible subgraph changes. */
  const sim = useMemo(() => {
    const simNodes: SimNode[] = graph.nodes.map((n) => ({ id: n.id }))
    const sizeOf = new Map(
      graph.nodes.map((n) => [n.id, 0.34 + Math.sqrt(n.degree) * 0.2 + n.centrality * 0.9]),
    )
    const simLinks = graph.edges
      .filter((e) => !e.predicted)
      .map((e) => ({ source: e.source, target: e.target }))

    const simulation = forceSimulation(simNodes, 3)
      .force(
        'link',
        forceLink(simLinks)
          .id((d) => d.id)
          .distance(11)
          .strength(0.45),
      )
      .force('charge', forceManyBody().strength(-26).distanceMax(110).theta(0.9))
      .force('centre', forceCenter(0, 0, 0).strength(0.5))
      // Without collision the simulation is free to stack nodes on top of one
      // another — charge repels at range but nothing stops two nodes sharing a
      // point, which is what buried the labels in a pile.
      .force(
        'collide',
        forceCollide((n: SimNode) => (sizeOf.get(n.id) ?? 1) * 2.6 + 2.4)
          .strength(0.9)
          .iterations(2),
      )
      .alphaDecay(0.028)
      // Never let alpha reach zero: a frozen graph reads as a screenshot.
      .alphaMin(0)

    // Warm it up so the first frame is already a graph, not a ball.
    // Scale ticks with size — a fixed 320 on thousands of nodes never returns.
    const warm = Math.min(320, Math.max(60, Math.floor(80_000 / Math.max(simNodes.length, 1))))
    simulation.stop()
    simulation.tick(warm)

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
        color: new Color(KIND_COLOR[node.kind] || PALETTE.brass),
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
  /**
   * Observed and predicted are kept apart all the way to the draw call. A
   * GraphSAGE suggestion rendered the same as a recorded association claims the
   * platform has evidence it does not have — §10.3 turns on exactly this
   * distinction, so it cannot be a styling afterthought.
   */
  const observed = useMemo(() => edges.filter((e) => !e.predicted), [edges])
  const predicted = useMemo(() => edges.filter((e) => e.predicted), [edges])
  const edgeBuffer = useMemo(() => new Float32Array(observed.length * 6), [observed])
  const predictedBuffer = useMemo(() => new Float32Array(predicted.length * 6), [predicted])

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

  /**
   * Fly to a selection.
   *
   * Clicking previously changed a side panel and nothing else, so there was no
   * link between the click and the picture. The camera now travels to the node
   * and holds it at the centre of the orbit, which both confirms the click and
   * spreads that node's neighbourhood across the frame — the same crowding that
   * made labels collide resolves simply by getting closer.
   */
  const flyTo = useRef<Vector3 | null>(null)
  const halo = useRef<Mesh>(null)

  const pathChain = useMemo(
    () => (pathFrom && pathTo ? (shortestPath(pathFrom, pathTo)?.nodes.map((n) => n.id) ?? []) : []),
    [pathFrom, pathTo],
  )

  /** Standoff for the current subject: one node, or a whole traced chain. */
  const framing = useRef(FOCUS_DISTANCE)

  useEffect(() => {
    // A traced path takes priority over a single selection: the route is the
    // subject, and both ends of it have to be in frame.
    if (pathChain.length > 1) {
      const pts = pathChain.map((id) => sim.byId.get(id)).filter(Boolean)
      const centre = new Vector3()
      for (const p of pts) centre.add(new Vector3(p!.x ?? 0, p!.y ?? 0, p!.z ?? 0))
      centre.multiplyScalar(SPREAD / pts.length)

      let extent = 1
      for (const p of pts) {
        extent = Math.max(
          extent,
          centre.distanceTo(new Vector3((p!.x ?? 0) * SPREAD, (p!.y ?? 0) * SPREAD, (p!.z ?? 0) * SPREAD)),
        )
      }
      flyTo.current = centre
      framing.current = Math.max(FOCUS_DISTANCE, extent * 2.6)
      return
    }

    framing.current = FOCUS_DISTANCE
    if (!selectedNode) {
      flyTo.current = null
      return
    }
    const p = sim.byId.get(selectedNode)
    if (p) flyTo.current = new Vector3((p.x ?? 0) * SPREAD, (p.y ?? 0) * SPREAD, (p.z ?? 0) * SPREAD)
  }, [selectedNode, sim, pathChain])

  useFrame((_, delta) => {
    const s = sim.simulation
    // Hold a floor under alpha so the graph keeps drifting indefinitely.
    s.tick(1)
    const current = (s as unknown as { alpha(): number }).alpha?.() ?? 1
    if (current < IDLE_ALPHA) s.alpha(IDLE_ALPHA)

    // Idle rotation stops while there is a subject — the analyst is reading it,
    // and a target that keeps drifting is a target you have to chase.
    const holding = selectedNode || pathChain.length > 1
    if (spinner.current && !holding) spinner.current.rotation.y += delta * ROTATE_SPEED

    if (flyTo.current && controls) {
      // The path centroid is fixed in simulation space, so it needs the same
      // rotation the nodes get from the spinning group.
      if (pathChain.length > 1 && spinner.current) {
        // recomputed each frame so it tracks the still-settling simulation
        const pts = pathChain.map((id) => sim.byId.get(id)).filter(Boolean)
        if (pts.length) {
          flyTo.current.set(0, 0, 0)
          for (const p of pts) flyTo.current.add(new Vector3(p!.x ?? 0, p!.y ?? 0, p!.z ?? 0))
          flyTo.current.multiplyScalar(SPREAD / pts.length)
          flyTo.current.applyAxisAngle(UP, spinner.current.rotation.y)
        }
      }
      const live = pathChain.length > 1 ? null : sim.byId.get(selectedNode ?? '')
      if (live) {
        flyTo.current.set((live.x ?? 0) * SPREAD, (live.y ?? 0) * SPREAD, (live.z ?? 0) * SPREAD)
        // The graph spins, so the node's world position is its simulation
        // position rotated by the group.
        flyTo.current.applyAxisAngle(UP, spinner.current?.rotation.y ?? 0)
      }
      const k = 1 - Math.pow(0.0016, delta)
      controls.target.lerp(flyTo.current, k)
      const want = flyTo.current
        .clone()
        .add(camera.position.clone().sub(controls.target).normalize().multiplyScalar(framing.current))
      camera.position.lerp(want, k * 0.75)
      controls.update()

      if (halo.current) {
        halo.current.position.copy(flyTo.current)
        halo.current.lookAt(camera.position)
        const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.08
        halo.current.scale.setScalar(pulse)
      }
    }

    for (const [kind, list] of byKind) {
      const mesh = meshes.current.get(kind)
      if (!mesh) continue
      list.forEach((p, i) => {
        const outside = districtFilter ? p.node.district !== districtFilter : false
        const dim = outside || (focus ? !focus.keep.has(p.node.id) : false)
        const isFocus = focus?.id === p.node.id && !outside

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

    const writeInto = (list: typeof edges, buf: Float32Array) => {
      list.forEach((e, i) => {
        const a = sim.byId.get(e.source)
        const b = sim.byId.get(e.target)
        if (!a || !b) return
        buf[i * 6] = (a.x ?? 0) * SPREAD
        buf[i * 6 + 1] = (a.y ?? 0) * SPREAD
        buf[i * 6 + 2] = (a.z ?? 0) * SPREAD
        buf[i * 6 + 3] = (b.x ?? 0) * SPREAD
        buf[i * 6 + 4] = (b.y ?? 0) * SPREAD
        buf[i * 6 + 5] = (b.z ?? 0) * SPREAD
      })
    }
    writeInto(observed, edgeBuffer)
    if (showPredicted) writeInto(predicted, predictedBuffer)

    const mark = (g: BufferGeometry | null) => {
      const attr = g?.getAttribute('position')
      if (attr) attr.needsUpdate = true
    }
    mark(edgeRef.current)
    mark(predictedRef.current)
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
    if (focus) return focus.keep
    // With a district filter on, label what survives it rather than the
    // state-wide top six — most of which are dimmed and would read as noise.
    if (districtFilter) {
      return new Set(
        placed
          .filter((p) => p.node.district === districtFilter)
          .sort((a, b) => b.node.centrality - a.node.centrality)
          .slice(0, 8)
          .map((p) => p.node.id),
      )
    }
    return alwaysLabelled
  }, [focus, alwaysLabelled, districtFilter, placed])

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
            color={PALETTE.bhuvan}
            transparent
            opacity={focus || districtFilter ? 0.06 : 0.5}
            depthWrite={false}
          />
        </lineSegments>

        {showPredicted && predicted.length > 0 && (
          <lineSegments frustumCulled={false} renderOrder={1}>
            <bufferGeometry ref={predictedRef}>
              <bufferAttribute attach="attributes-position" args={[predictedBuffer, 3]} />
            </bufferGeometry>
            <lineBasicMaterial
              color={PALETTE.brass}
              transparent
              opacity={focus ? 0.08 : 0.75}
              depthWrite={false}
            />
          </lineSegments>
        )}

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

        {/* Inside the spinning group: the chain is built from simulation
            coordinates, so drawing it outside left it drifting off the nodes as
            the graph rotated. */}
        {pathFrom && pathTo && <PathHighlight sim={sim} from={pathFrom} to={pathTo} />}
      </group>

      {selectedNode && (
        <mesh ref={halo} renderOrder={5}>
          <ringGeometry args={[2.6, 3.1, 48]} />
          <meshBasicMaterial color={PALETTE.brassLit} transparent opacity={0.8} depthWrite={false} />
        </mesh>
      )}

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

  // Drawn twice: a wide soft pass for presence and a hairline over it for the
  // actual geometry. One thin line at this zoom disappears against the field.
  return (
    <>
      <lineSegments frustumCulled={false} renderOrder={3}>
        <bufferGeometry ref={ref}>
          <bufferAttribute attach="attributes-position" args={[buffer, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={PALETTE.brassLit} transparent opacity={0.95} depthWrite={false} />
      </lineSegments>
    </>
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
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <span
              className="whitespace-nowrap px-1"
              style={{
                fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                fontSize: on ? 13 : 11,
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
function PathHighlight({
  sim,
  from,
  to,
}: {
  sim: { byId: Map<string, SimNode> }
  from: string
  to: string
}) {
  const ref = useRef<BufferGeometry>(null)

  const chain = useMemo(
    () => shortestPath(from, to)?.nodes.map((n) => n.id) ?? [],
    [from, to],
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
