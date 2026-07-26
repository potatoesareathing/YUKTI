import { getNetwork } from './network'
import type { GraphNode } from './types'

/**
 * District-level aggregation of the entity graph (§7.2).
 *
 * Drawing 688 person-to-person ties over a map produces a hairball: every arc
 * launches from the same clustered region, none can be traced end to end, and
 * "this tie crosses a jurisdiction" stops being readable because every tie looks
 * identical. The information is real but the encoding destroys it.
 *
 * So the overview asks the question one level up — *which jurisdictions are
 * linked, and how strongly* — which is the question an SCRB analyst actually
 * opens a state-wide view to answer. Individual records are still there; they
 * resolve on demand when a district or a community is selected.
 *
 * Two structures come out of this:
 *   - a HUB per district, carrying everything that stays inside it
 *   - a FLOW per district pair, carrying everything that crosses between them
 *
 * Nothing is discarded. Intra-district ties become hub weight rather than
 * vanishing, and flows below the threshold are counted and reported rather than
 * silently dropped.
 */

export interface DistrictFlow {
  id: string
  a: string
  b: string
  /** Observed edges running between these two districts. */
  ties: number
  /** How many of those are GraphSAGE predictions rather than records. */
  predicted: number
  communities: number[]
}

export interface DistrictHub {
  district: string
  entities: number
  people: number
  incidents: number
  /** Ties with both endpoints inside this district. */
  internalTies: number
  communities: number[]
  topNode: GraphNode
}

export interface FlowAggregate {
  flows: DistrictFlow[]
  hubs: DistrictHub[]
  /** Pairs that fell below the threshold — reported, never silently dropped. */
  droppedPairs: number
  droppedTies: number
  totalCrossTies: number
  minTies: number
}

/**
 * A single tie between two districts is an incident, not a corridor. The
 * threshold is what turns a scatter of one-offs into a small set of legible
 * routes; the count it excludes is surfaced in the UI.
 */
const DEFAULT_MIN_TIES = 2

const cache = new Map<number, FlowAggregate>()

export function getDistrictFlows(minTies = DEFAULT_MIN_TIES): FlowAggregate {
  const hit = cache.get(minTies)
  if (hit) return hit

  const { nodes, edges } = getNetwork()
  const byId = new Map(nodes.map((n) => [n.id, n]))

  /* Hubs — one per district that holds anything at all. */
  const hubs = new Map<string, DistrictHub>()
  const hubCommunities = new Map<string, Set<number>>()

  for (const n of nodes) {
    let hub = hubs.get(n.district)
    if (!hub) {
      hub = {
        district: n.district,
        entities: 0,
        people: 0,
        incidents: 0,
        internalTies: 0,
        communities: [],
        topNode: n,
      }
      hubs.set(n.district, hub)
      hubCommunities.set(n.district, new Set())
    }
    hub.entities++
    if (n.kind === 'Person') hub.people++
    if (n.kind === 'Incident') hub.incidents++
    if (n.centrality > hub.topNode.centrality) hub.topNode = n
    hubCommunities.get(n.district)!.add(n.community)
  }

  /* Flows — one per unordered district pair. */
  const pairs = new Map<string, DistrictFlow>()
  const pairCommunities = new Map<string, Set<number>>()
  let totalCrossTies = 0

  for (const e of edges) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue

    if (a.district === b.district) {
      const hub = hubs.get(a.district)
      if (hub) hub.internalTies++
      continue
    }

    totalCrossTies++
    // Sort the pair so A→B and B→A land in the same bucket.
    const [x, y] = a.district < b.district ? [a.district, b.district] : [b.district, a.district]
    const id = `${x}|${y}`

    let flow = pairs.get(id)
    if (!flow) {
      flow = { id, a: x, b: y, ties: 0, predicted: 0, communities: [] }
      pairs.set(id, flow)
      pairCommunities.set(id, new Set())
    }
    flow.ties++
    if (e.predicted) flow.predicted++
    pairCommunities.get(id)!.add(a.community)
    pairCommunities.get(id)!.add(b.community)
  }

  for (const [district, set] of hubCommunities) {
    hubs.get(district)!.communities = [...set].sort((p, q) => p - q)
  }
  for (const [id, set] of pairCommunities) {
    pairs.get(id)!.communities = [...set].sort((p, q) => p - q)
  }

  const all = [...pairs.values()]
  const kept = all.filter((f) => f.ties >= minTies).sort((p, q) => q.ties - p.ties)
  const dropped = all.filter((f) => f.ties < minTies)

  const result: FlowAggregate = {
    flows: kept,
    hubs: [...hubs.values()].sort((p, q) => q.entities - p.entities),
    droppedPairs: dropped.length,
    droppedTies: dropped.reduce((sum, f) => sum + f.ties, 0),
    totalCrossTies,
    minTies,
  }

  cache.set(minTies, result)
  return result
}

/** Districts reachable from `district` along a drawn flow. Powers drill-down. */
export function linkedDistricts(district: string, minTies = DEFAULT_MIN_TIES): Set<string> {
  const out = new Set<string>([district])
  for (const f of getDistrictFlows(minTies).flows) {
    if (f.a === district) out.add(f.b)
    else if (f.b === district) out.add(f.a)
  }
  return out
}

/** Districts a community's members occupy. Powers community selection. */
export function communityDistricts(community: number): Set<string> {
  const out = new Set<string>()
  for (const n of getNetwork().nodes) {
    if (n.community === community) out.add(n.district)
  }
  return out
}
