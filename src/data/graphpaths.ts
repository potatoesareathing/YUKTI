import { getNetwork } from './network'
import type { EdgeKind, GraphEdge, GraphNode } from './types'

/**
 * Ego-network layout and path finding (§7.2).
 *
 * §7.2's stated output is a viewer analysts "expand interactively from any
 * starting entity", and it names shortest-path and common-neighbour analysis as
 * the tools for surfacing indirect links. Both live here as pure functions, with
 * no rendering attached, so the layout can be reasoned about and checked on its
 * own.
 *
 * The layout places nodes on concentric rings by hop distance, evenly spaced,
 * ordered by the barycentre heuristic. See `buildEgoTree` for why a spanning
 * tree with angular wedges — the obvious choice — is the wrong one here.
 */

/** Hops shown at once. Beyond three the wedges are too thin to read. */
export const MAX_DEPTH = 3

export interface EgoNode {
  id: string
  node: GraphNode
  depth: number
  /** Radians, centre of this node's wedge. */
  angle: number
  parent: string | null
}

export interface EgoLink {
  id: string
  from: string
  to: string
  kind: EdgeKind
  predicted: boolean
}

export interface EgoTree {
  root: string
  nodes: EgoNode[]
  byId: Map<string, EgoNode>
  /** Links between adjacent rings — a step outward from the origin. */
  treeLinks: EgoLink[]
  /** Links within one ring — a cycle at equal distance from the origin. */
  crossLinks: EgoLink[]
  /** Neighbours omitted by the breadth cap, so the UI can say so. */
  truncated: number
}

interface Adjacency {
  neighbours: Map<string, { id: string; edge: GraphEdge }[]>
  byId: Map<string, GraphNode>
}

let adjacency: Adjacency | null = null

function getAdjacency(): Adjacency {
  if (adjacency) return adjacency
  const { nodes, edges } = getNetwork()
  const neighbours = new Map<string, { id: string; edge: GraphEdge }[]>()
  for (const n of nodes) neighbours.set(n.id, [])
  for (const e of edges) {
    neighbours.get(e.source)?.push({ id: e.target, edge: e })
    neighbours.get(e.target)?.push({ id: e.source, edge: e })
  }
  adjacency = { neighbours, byId: new Map(nodes.map((n) => [n.id, n])) }
  return adjacency
}

const linkOf = (from: string, to: string, edge: GraphEdge): EgoLink => ({
  id: `${from}>${to}`,
  from,
  to,
  kind: edge.kind,
  predicted: !!edge.predicted,
})

/** Nodes kept on each ring. Beyond this the marks collide. */
const RING_CAPACITY = [1, 14, 20, 24]

/** Circular mean of a set of bearings — the barycentre of a node's anchors. */
function circularMean(angles: number[]): number {
  if (!angles.length) return 0
  let x = 0
  let y = 0
  for (const a of angles) {
    x += Math.cos(a)
    y += Math.sin(a)
  }
  return Math.atan2(y, x)
}

/**
 * Lay the ego network out on concentric rings.
 *
 * An earlier version built a spanning tree and gave each subtree an angular
 * wedge. That is the right technique for data that is genuinely hierarchical,
 * and the wrong one here: in a tight criminal community everyone's neighbours
 * are everyone else's, so breadth-first search hands each shared node to
 * whichever sibling happened to reach it first. The resulting "hierarchy" is an
 * artifact of traversal order, and it shows — one branch inherits nine
 * descendants and swallows half the dial while nine siblings get nothing.
 *
 * So there is no tree. Each ring is populated by hop distance and its nodes are
 * spaced EVENLY around the full circle, which makes an even dial by
 * construction. Their ORDER around that ring is then chosen by the barycentre
 * heuristic from layered graph drawing: each node is placed at the circular mean
 * of the bearings of its already-placed neighbours, so connected nodes end up
 * near one another and radial lines stay short. Two refinement passes are enough
 * to settle it.
 */
export function buildEgoTree(root: string, maxDepth = MAX_DEPTH): EgoTree | null {
  const { neighbours, byId } = getAdjacency()
  const rootNode = byId.get(root)
  if (!rootNode) return null

  /* Hop distance, with each ring capped by centrality. */
  const depth = new Map<string, number>([[root, 0]])
  const rings: string[][] = [[root]]
  let truncated = 0

  for (let d = 1; d <= maxDepth; d++) {
    const candidates = new Set<string>()
    for (const id of rings[d - 1]) {
      for (const n of neighbours.get(id) ?? []) {
        if (!depth.has(n.id)) candidates.add(n.id)
      }
    }

    const ordered = [...candidates].sort(
      (a, b) => (byId.get(b)?.centrality ?? 0) - (byId.get(a)?.centrality ?? 0),
    )
    const cap = RING_CAPACITY[d] ?? 20
    const kept = ordered.slice(0, cap)
    truncated += ordered.length - kept.length

    for (const id of kept) depth.set(id, d)
    rings.push(kept)
    if (!kept.length) break
  }

  /* Order each ring so connected nodes sit near each other, then space evenly. */
  const angle = new Map<string, number>([[root, 0]])
  const visible = new Set(depth.keys())

  const spaceEvenly = (ids: string[]) => {
    ids.forEach((id, i) => angle.set(id, (i / ids.length) * Math.PI * 2))
  }

  for (let d = 1; d < rings.length; d++) {
    const ring = rings[d]
    if (!ring.length) continue

    // Seed: bearings of neighbours already placed on the inner ring.
    const anchorAngle = (id: string) =>
      circularMean(
        (neighbours.get(id) ?? [])
          .filter((n) => depth.get(n.id) === d - 1 && angle.has(n.id))
          .map((n) => angle.get(n.id)!),
      )

    ring.sort((a, b) => anchorAngle(a) - anchorAngle(b))
    spaceEvenly(ring)

    // Refine against ALL placed neighbours, inner ring and same ring alike.
    for (let pass = 0; pass < 2; pass++) {
      const bary = new Map(
        ring.map((id) => [
          id,
          circularMean(
            (neighbours.get(id) ?? [])
              .filter((n) => visible.has(n.id) && n.id !== id && angle.has(n.id))
              .map((n) => angle.get(n.id)!),
          ),
        ]),
      )
      ring.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
      spaceEvenly(ring)
    }
  }

  const nodes: EgoNode[] = [...depth.keys()].map((id) => ({
    id,
    node: byId.get(id)!,
    depth: depth.get(id)!,
    angle: angle.get(id) ?? 0,
    parent: null,
  }))

  /* Edges between visible nodes, split by whether they step outward or not. */
  const radial: EgoLink[] = []
  const chords: EgoLink[] = []
  const seen = new Set<string>()

  for (const id of visible) {
    for (const n of neighbours.get(id) ?? []) {
      if (!visible.has(n.id)) continue
      const key = [id, n.id].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)

      const link = linkOf(id, n.id, n.edge)
      // A link between adjacent rings is a step outward and follows the radius.
      // A link within one ring is a cycle — two nodes the same distance from the
      // origin who also know each other — and crosses the interior.
      if (Math.abs(depth.get(id)! - depth.get(n.id)!) === 1) radial.push(link)
      else chords.push(link)
    }
  }

  return {
    root,
    nodes: nodes.sort((a, b) => a.depth - b.depth),
    byId: new Map(nodes.map((n) => [n.id, n])),
    treeLinks: radial,
    crossLinks: chords,
    truncated,
  }
}

export interface PathResult {
  nodes: GraphNode[]
  links: EgoLink[]
  hops: number
  /** True when the two endpoints share no direct edge — §7.2's actual case. */
  indirect: boolean
}

/**
 * Shortest path between two entities (§7.2, association detection).
 *
 * Unweighted BFS, which is the right choice here: every hop is one documented
 * relationship, and "three relationships apart" is the finding an investigator
 * acts on. Weighting the edges would make the number harder to state and no
 * more true.
 */
export function shortestPath(from: string, to: string): PathResult | null {
  if (from === to) return null
  const { neighbours, byId } = getAdjacency()
  if (!byId.has(from) || !byId.has(to)) return null

  const parent = new Map<string, { id: string; edge: GraphEdge } | null>([[from, null]])
  const queue = [from]

  while (queue.length) {
    const id = queue.shift()!
    if (id === to) break
    for (const n of neighbours.get(id) ?? []) {
      if (parent.has(n.id)) continue
      parent.set(n.id, { id, edge: n.edge })
      queue.push(n.id)
    }
  }

  if (!parent.has(to)) return null

  const chain: string[] = []
  const links: EgoLink[] = []
  let cursor: string | null = to
  while (cursor) {
    chain.unshift(cursor)
    const step = parent.get(cursor)
    if (!step) break
    links.unshift(linkOf(step.id, cursor, step.edge))
    cursor = step.id
  }

  const direct = (neighbours.get(from) ?? []).some((n) => n.id === to)

  return {
    nodes: chain.map((id) => byId.get(id)!),
    links,
    hops: chain.length - 1,
    indirect: !direct,
  }
}

/** Entities that both share, with neither necessarily linked to the other. */
export function commonNeighbours(a: string, b: string): GraphNode[] {
  const { neighbours, byId } = getAdjacency()
  const setA = new Set((neighbours.get(a) ?? []).map((n) => n.id))
  return (neighbours.get(b) ?? [])
    .filter((n) => setA.has(n.id))
    .map((n) => byId.get(n.id)!)
    .filter(Boolean)
}

/** Sensible entities to open the explorer on: the best-connected people. */
export function suggestedOrigins(limit = 10): GraphNode[] {
  return [...getNetwork().nodes]
    .filter((n) => n.kind === 'Person')
    .sort((a, b) => b.centrality - a.centrality)
    .slice(0, limit)
}
