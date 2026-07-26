import { getNetwork } from './network'
import type { EdgeKind, GraphNode } from './types'

/**
 * One entity and its direct connections — nothing further out.
 *
 * Every earlier version of this module drew the whole three-hop neighbourhood:
 * forty-odd nodes and a hundred edges, which is a hairball in any layout. That
 * is a volume problem, not a geometry problem, and the tools this module is
 * modelled on solve it the same way — Bloom, Maltego and i2 all show a handful
 * of entities and let the analyst grow the view deliberately.
 *
 * So the view is one hop. The centre, its neighbours, and the ties BETWEEN
 * those neighbours. Everything else is reached by walking.
 */

/** Satellites shown at once. Past this the labels collide. */
const MAX_SATELLITES = 17

export interface Satellite {
  node: GraphNode
  kind: EdgeKind
  /** Edge weight, normalised 0..1 across this view. */
  strength: number
  predicted: boolean
}

export interface FocusView {
  centre: GraphNode
  satellites: Satellite[]
  /**
   * Ties between two satellites. Drawn as short arcs OUTSIDE the ring, never
   * through the middle — this is the "your two associates know each other"
   * finding, and routing it across the centre is what made it unreadable.
   */
  rim: { a: string; b: string; kind: EdgeKind }[]
  /** Direct links not shown, because the ring is full. */
  hidden: number
}

interface Adjacency {
  neighbours: Map<string, { id: string; kind: EdgeKind; weight: number; predicted: boolean }[]>
  byId: Map<string, GraphNode>
}

let adjacency: Adjacency | null = null

function getAdjacency(): Adjacency {
  if (adjacency) return adjacency
  const { nodes, edges } = getNetwork()
  const neighbours: Adjacency['neighbours'] = new Map()
  for (const n of nodes) neighbours.set(n.id, [])
  for (const e of edges) {
    const entry = { kind: e.kind, weight: e.weight, predicted: !!e.predicted }
    neighbours.get(e.source)?.push({ id: e.target, ...entry })
    neighbours.get(e.target)?.push({ id: e.source, ...entry })
  }
  adjacency = { neighbours, byId: new Map(nodes.map((n) => [n.id, n])) }
  return adjacency
}

export function getFocusView(id: string): FocusView | null {
  const { neighbours, byId } = getAdjacency()
  const centre = byId.get(id)
  if (!centre) return null

  const all = (neighbours.get(id) ?? []).filter((n) => byId.has(n.id))
  const ranked = [...all].sort(
    (a, b) => (byId.get(b.id)?.centrality ?? 0) - (byId.get(a.id)?.centrality ?? 0),
  )
  const kept = ranked.slice(0, MAX_SATELLITES)

  const maxWeight = Math.max(1, ...kept.map((n) => n.weight))

  /*
   * Order around the ring by community, then by centrality.
   *
   * Grouping co-members adjacently keeps the rim ties short, which is what lets
   * them be drawn as small arcs at the edge instead of as chords across the
   * middle. Sorting by centrality alone would interleave communities and every
   * rim tie would have to reach halfway round.
   */
  const satellites: Satellite[] = kept
    .map((n) => ({
      node: byId.get(n.id)!,
      kind: n.kind,
      strength: n.weight / maxWeight,
      predicted: n.predicted,
    }))
    .sort(
      (a, b) =>
        a.node.community - b.node.community || b.node.centrality - a.node.centrality,
    )

  const present = new Set(satellites.map((s) => s.node.id))
  const rim: FocusView['rim'] = []
  const seen = new Set<string>()

  for (const s of satellites) {
    for (const n of neighbours.get(s.node.id) ?? []) {
      if (!present.has(n.id) || n.id === s.node.id) continue
      const key = [s.node.id, n.id].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      rim.push({ a: s.node.id, b: n.id, kind: n.kind })
    }
  }

  return { centre, satellites, rim, hidden: all.length - kept.length }
}

/** Label for an edge kind, as it should read in a sentence. */
export function edgeLabel(kind: EdgeKind): string {
  return kind.replace(/_/g, ' ').toLowerCase()
}
