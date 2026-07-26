import { pick, randInt, seeded, type Rng } from '@/lib/rng'
import { docket } from '@/lib/format'
import { getDistrictMetrics, NOW, PERIOD_DAYS } from './districts'
import { MO_VOCAB } from './incidents'
import type { EdgeKind, GraphData, GraphEdge, GraphNode, NodeKind } from './types'

/**
 * The suspect–victim–location graph behind MOD-02 and MOD-05.
 *
 * Node and relationship kinds are exactly §9.2's Neo4j schema. The structure is
 * generated as a set of overlapping groups rather than as a random graph,
 * because §7.5's whole claim is that community detection reveals organised
 * structure — run Louvain on an Erdős–Rényi graph and it finds nothing, which
 * would make the module a lie.
 *
 * Centrality is not assigned. PageRank is actually iterated over the generated
 * edges below, so the "key individuals" the UI highlights are the ones the graph
 * really does route through.
 */

const GROUPS = 14
const SURNAMES = [
  'Shetty', 'Gowda', 'Patil', 'Hegde', 'Naik', 'Rao', 'Kulkarni', 'Desai',
  'Reddy', 'Nayak', 'Bhat', 'Kamath', 'Murthy', 'Shastri', 'Jadhav', 'Poojary',
  'Ballal', 'Acharya', 'Kadam', 'Salian', 'Rai', 'Prabhu',
]
const GIVEN = [
  'Ravi', 'Suresh', 'Manjunath', 'Ganesh', 'Anil', 'Prakash', 'Vinay', 'Kiran',
  'Harish', 'Basavaraj', 'Mahesh', 'Santhosh', 'Nagaraj', 'Umesh', 'Girish', 'Lokesh',
  'Shivakumar', 'Chandrashekar', 'Venkatesh', 'Rajesh', 'Dinesh', 'Praveen',
]

/**
 * Names must not repeat across the graph. Two rows reading "Ganesh Hegde" in a
 * ranked suspect list is indistinguishable from a duplicate-record bug, and this
 * is a product whose entire premise is entity resolution.
 */
function uniqueName(r: Rng, used: Set<string>): string {
  for (let i = 0; i < 60; i++) {
    const n = `${pick(r, GIVEN)} ${pick(r, SURNAMES)}`
    if (!used.has(n)) {
      used.add(n)
      return n
    }
  }
  const fallback = `${pick(r, GIVEN)} ${pick(r, SURNAMES)} ${used.size}`
  used.add(fallback)
  return fallback
}
const GROUP_NAMES = [
  'Chikkapet Ring', 'Coastal Transit Group', 'NH-48 Corridor Cell', 'Peenya Scrap Network',
  'Hubballi Market Group', 'Malnad Transport Cell', 'Kalaburagi Border Ring', 'Cyber Payout Mules',
  'Yeshwanthpur Consignment Group', 'Raichur Cross-Border Cell', 'Old Town Fencing Ring',
  'Bidar Transit Network', 'Mangaluru Port Cell', 'Vijayapura Highway Group',
]
const VEHICLE_KIND = ['Two-wheeler', 'Hatchback', 'Sedan', 'Tempo', 'Pickup', 'SUV']

/** KA RTO codes, so registrations read like real Karnataka plates. */
const RTO = ['KA-01', 'KA-03', 'KA-05', 'KA-19', 'KA-20', 'KA-25', 'KA-28', 'KA-32', 'KA-51']

function plate(r: Rng): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  return `${pick(r, RTO)}-${pick(r, letters.split(''))}${pick(r, letters.split(''))}-${randInt(r, 1000, 9999)}`
}

interface Builder {
  nodes: GraphNode[]
  edges: GraphEdge[]
  index: Map<string, GraphNode>
}

function addNode(b: Builder, n: Omit<GraphNode, 'centrality' | 'degree'>): GraphNode {
  const node: GraphNode = { ...n, centrality: 0, degree: 0 }
  b.nodes.push(node)
  b.index.set(node.id, node)
  return node
}

function addEdge(b: Builder, source: string, target: string, kind: EdgeKind, weight = 1, extra?: Partial<GraphEdge>) {
  if (source === target) return
  b.edges.push({ id: `E${b.edges.length}`, source, target, kind, weight, ...extra })
}

/** PageRank over the undirected edge list. Damping 0.85, 40 iterations. */
function pageRank(nodes: GraphNode[], edges: GraphEdge[], d = 0.85, iters = 40): void {
  const n = nodes.length
  const idx = new Map(nodes.map((x, i) => [x.id, i]))
  const adj: number[][] = Array.from({ length: n }, () => [])

  for (const e of edges) {
    const a = idx.get(e.source)
    const b = idx.get(e.target)
    if (a === undefined || b === undefined) continue
    adj[a].push(b)
    adj[b].push(a)
  }

  let rank = new Array<number>(n).fill(1 / n)
  for (let it = 0; it < iters; it++) {
    const next = new Array<number>(n).fill((1 - d) / n)
    for (let i = 0; i < n; i++) {
      const out = adj[i]
      if (out.length === 0) {
        // Dangling node — redistribute evenly rather than losing the mass.
        const share = (d * rank[i]) / n
        for (let j = 0; j < n; j++) next[j] += share
        continue
      }
      const share = (d * rank[i]) / out.length
      for (const j of out) next[j] += share
    }
    rank = next
  }

  const max = Math.max(...rank)
  nodes.forEach((node, i) => {
    node.centrality = max > 0 ? rank[i] / max : 0
    // DISTINCT neighbours, not adjacency entries. Two people co-accused in three
    // separate FIRs generate three edges, and counting those as three links
    // inflates every "direct links" figure in the platform and makes the same
    // name appear three times in a connections list.
    node.degree = new Set(adj[i]).size
  })
}

function build(): GraphData {
  const r = seeded('network:v1')
  const usedNames = new Set<string>()
  const b: Builder = { nodes: [], edges: [], index: new Map() }
  const districts = getDistrictMetrics()

  // Weight group placement toward high-risk districts — organised activity is
  // where the risk model already says pressure is highest.
  const hotDistricts = [...districts].sort((a, x) => x.risk - a.risk).slice(0, 16)

  let personSerial = 1
  let incidentSerial = 1

  for (let g = 0; g < GROUPS; g++) {
    const home = hotDistricts[g % hotDistricts.length]
    const org = addNode(b, {
      id: `ORG-${g}`,
      kind: 'Organisation',
      label: GROUP_NAMES[g],
      district: home.name,
      community: g,
      meta: { 'Primary district': home.name, 'Members traced': 0 },
    })

    const size = randInt(r, 4, 9)
    const members: GraphNode[] = []

    for (let m = 0; m < size; m++) {
      const person = addNode(b, {
        id: `PER-${personSerial}`,
        kind: 'Person',
        label: uniqueName(r, usedNames),
        district: r() > 0.72 ? pick(r, hotDistricts).name : home.name,
        community: g,
        meta: {
          Reference: docket('PER', personSerial),
          Priors: randInt(r, 0, 11),
          'MO cluster': g % 6,
        },
      })
      personSerial++
      members.push(person)
      addEdge(b, person.id, org.id, 'MEMBER_OF', 1)
    }
    org.meta!['Members traced'] = size

    // A location the group works out of.
    const loc = addNode(b, {
      id: `LOC-${g}`,
      kind: 'Location',
      district: home.name,
      label: `${home.name.split(' ')[0]} ${pick(r, ['Market', 'Bus Stand', 'Layout', 'Industrial Estate', 'Junction'])}`,
      community: g,
      meta: { Jurisdiction: home.name },
    })

    // Incidents the group is jointly accused in.
    const incidentCount = randInt(r, 3, 7)
    for (let i = 0; i < incidentCount; i++) {
      // A share of a group's offences happen where its members live rather than
      // at its home base. Without this every incident sits in one district, no
      // offender can span jurisdictions, and "MO across different
      // jurisdictions" — a named capability — has nothing to find.
      const away = r() < 0.4 ? pick(r, members) : null
      const incidentDistrict = away?.district ?? home.name

      const inc = addNode(b, {
        id: `GINC-${incidentSerial}`,
        kind: 'Incident',
        district: incidentDistrict,
        label: docket('FIR', 40000 + incidentSerial),
        community: g,
        meta: {
          Entry: pick(r, MO_VOCAB.ENTRY),
          Target: pick(r, MO_VOCAB.TARGET),
          Window: pick(r, MO_VOCAB.TIMING),
          // §7.2 wants a person's incidents "aggregated into a timeline", which
          // is impossible without a date on each one.
          At: NOW - Math.floor(r() * PERIOD_DAYS) * 864e5,
        },
      })
      incidentSerial++
      addEdge(b, inc.id, loc.id, 'OCCURRED_AT', 1)

      // Two to four members accused together — this is what creates the
      // co-accused clique that community detection later recovers.
      const accused = [...members].sort(() => r() - 0.5).slice(0, randInt(r, 2, 4))
      for (const p of accused) addEdge(b, p.id, inc.id, 'ACCUSED_IN', 1)
      for (let x = 0; x < accused.length; x++) {
        for (let y = x + 1; y < accused.length; y++) {
          addEdge(b, accused[x].id, accused[y].id, 'CO_ACCUSED_WITH', 1.4)
        }
      }

      // Victim and witness, so the graph is not purely offender-side.
      if (r() > 0.35) {
        const victim = addNode(b, {
          id: `PER-${personSerial}`,
          kind: 'Person',
          label: uniqueName(r, usedNames),
          district: home.name,
          community: g,
          meta: { Reference: docket('PER', personSerial), Role: 'Complainant' },
        })
        personSerial++
        addEdge(b, victim.id, inc.id, 'VICTIM_OF', 0.8)
      }
    }

    // A vehicle tied to one or two members.
    if (r() > 0.3) {
      const veh = addNode(b, {
        id: `VEH-${g}`,
        kind: 'Vehicle',
        district: home.name,
        label: plate(r),
        community: g,
        meta: { Type: pick(r, VEHICLE_KIND) },
      })
      for (const p of [...members].sort(() => r() - 0.5).slice(0, randInt(r, 1, 2))) {
        addEdge(b, p.id, veh.id, 'ASSOCIATED_WITH', 1)
      }
    }
  }

  // Bridges between groups. These are the edges that make the graph worth
  // exploring — the "two suspects who never appeared in the same FIR but share
  // a common associate" case named in §7.2.
  const people = b.nodes.filter((n) => n.kind === 'Person')
  for (let i = 0; i < 22; i++) {
    const a = pick(r, people)
    const candidates = people.filter((p) => p.community !== a.community)
    const c = pick(r, candidates)
    addEdge(b, a.id, c.id, 'ASSOCIATED_WITH', 0.6)
  }

  // SAME_MO_AS between incidents sharing an entry method across groups (§7.5).
  const incidents = b.nodes.filter((n) => n.kind === 'Incident')
  for (let i = 0; i < incidents.length; i++) {
    for (let j = i + 1; j < incidents.length; j++) {
      if (
        incidents[i].community !== incidents[j].community &&
        incidents[i].meta?.Entry === incidents[j].meta?.Entry &&
        incidents[i].meta?.Target === incidents[j].meta?.Target
      ) {
        addEdge(b, incidents[i].id, incidents[j].id, 'SAME_MO_AS', 0.9)
      }
    }
  }

  pageRank(b.nodes, b.edges)

  // Link prediction (§8, GraphSAGE). Candidates are pairs with NO observed edge
  // that nonetheless share neighbours — precisely §7.2's case of "two suspects
  // who have never appeared in the same FIR but share a common associate or
  // location". Ranking by shared-neighbour count is the Adamic-Adar intuition
  // and, unlike a same-community-and-high-centrality rule, it actually yields
  // candidates: the highest-centrality members of a community are already
  // connected to each other, so that rule returns almost nothing.
  const observed = new Set(b.edges.map((e) => [e.source, e.target].sort().join('|')))
  const neighbours = new Map<string, Set<string>>()
  for (const n of b.nodes) neighbours.set(n.id, new Set())
  for (const e of b.edges) {
    neighbours.get(e.source)?.add(e.target)
    neighbours.get(e.target)?.add(e.source)
  }

  const candidates: { a: string; c: string; shared: number }[] = []
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const key = [people[i].id, people[j].id].sort().join('|')
      if (observed.has(key)) continue
      const na = neighbours.get(people[i].id)!
      const nb = neighbours.get(people[j].id)!
      let shared = 0
      for (const x of na) if (nb.has(x)) shared++
      if (shared >= 2) candidates.push({ a: people[i].id, c: people[j].id, shared })
    }
  }

  candidates.sort((x, y) => y.shared - x.shared)
  for (const cand of candidates.slice(0, 18)) {
    addEdge(b, cand.a, cand.c, 'ASSOCIATED_WITH', 0.5, {
      predicted: true,
      // Confidence rises with the number of shared associates, capped short of
      // certainty — this is a suggestion to check, never a conclusion.
      confidence: Math.min(0.93, 0.48 + cand.shared * 0.09),
    })
  }

  return { nodes: b.nodes, edges: b.edges }
}

let cached: GraphData | null = null

export function getNetwork(): GraphData {
  if (!cached) cached = build()
  return cached
}

/** Ego network — everything within `depth` hops of a node. Powers expand-on-click. */
export function getEgoNetwork(rootId: string, depth = 2): GraphData {
  const { nodes, edges } = getNetwork()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const keep = new Set([rootId])
  let frontier = [rootId]

  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const e of edges) {
      if (frontier.includes(e.source) && !keep.has(e.target)) {
        keep.add(e.target)
        next.push(e.target)
      } else if (frontier.includes(e.target) && !keep.has(e.source)) {
        keep.add(e.source)
        next.push(e.source)
      }
    }
    frontier = next
    if (!frontier.length) break
  }

  return {
    nodes: [...keep].map((id) => byId.get(id)!).filter(Boolean),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  }
}

export function getCommunities(): { id: number; label: string; size: number; district: string; topNode: GraphNode }[] {
  const { nodes } = getNetwork()
  const groups = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    if (!groups.has(n.community)) groups.set(n.community, [])
    groups.get(n.community)!.push(n)
  }
  return [...groups.entries()]
    .map(([id, members]) => {
      const org = members.find((m) => m.kind === 'Organisation')
      const top = [...members]
        .filter((m) => m.kind === 'Person')
        .sort((a, b) => b.centrality - a.centrality)[0]
      return {
        id,
        label: org?.label ?? `Community ${id}`,
        size: members.length,
        district: org?.district ?? members[0].district,
        topNode: top ?? members[0],
      }
    })
    .sort((a, b) => b.size - a.size)
}

export const NODE_KINDS: NodeKind[] = ['Person', 'Incident', 'Location', 'Vehicle', 'Organisation']
