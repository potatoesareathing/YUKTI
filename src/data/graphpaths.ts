import { getNetwork } from './network'
import type { EdgeKind, GraphEdge, GraphNode } from './types'

/**
 * Association analysis (§7.2).
 *
 * §7.2 names shortest-path and common-neighbour analysis as the means of
 * surfacing indirect links — "two suspects who have never appeared in the same
 * FIR but share a common associate or location". Both live here as pure
 * functions with no rendering attached, so they can be reasoned about and
 * checked on their own. Layout belongs to the view.
 */

export interface PathLink {
  from: string
  to: string
  kind: EdgeKind
  predicted: boolean
}

export interface PathResult {
  nodes: GraphNode[]
  links: PathLink[]
  hops: number
  /** True when the two endpoints share no direct edge — §7.2's actual case. */
  indirect: boolean
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

/**
 * Shortest path between two entities.
 *
 * Unweighted breadth-first, which is the right choice here: every hop is one
 * documented relationship, and "three relationships apart" is the finding an
 * investigator acts on. Weighting the edges would make the number harder to
 * state and no more true.
 */
export function shortestPath(from: string, to: string): PathResult | null {
  if (!from || !to || from === to) return null
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
  const links: PathLink[] = []
  let cursor: string | null = to

  while (cursor) {
    chain.unshift(cursor)
    const step = parent.get(cursor)
    if (!step) break
    links.unshift({
      from: step.id,
      to: cursor,
      kind: step.edge.kind,
      predicted: !!step.edge.predicted,
    })
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

/** Entities that both endpoints know, whether or not they know each other. */
export function commonNeighbours(a: string, b: string): GraphNode[] {
  if (!a || !b || a === b) return []
  const { neighbours, byId } = getAdjacency()
  const setA = new Set((neighbours.get(a) ?? []).map((n) => n.id))
  return (neighbours.get(b) ?? [])
    .filter((n) => setA.has(n.id))
    .map((n) => byId.get(n.id)!)
    .filter(Boolean)
}

/** Entities worth starting from: the best-connected people. */
export function suggestedOrigins(limit = 10): GraphNode[] {
  return [...getNetwork().nodes]
    .filter((n) => n.kind === 'Person')
    .sort((a, b) => b.centrality - a.centrality)
    .slice(0, limit)
}

/** Human-readable form of a relationship kind, for use in a sentence. */
export function edgeLabel(kind: EdgeKind): string {
  return kind.replace(/_/g, ' ').toLowerCase()
}
