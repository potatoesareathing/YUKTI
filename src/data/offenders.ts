import { getNetwork } from './network'
import type { GraphNode } from './types'

/**
 * Repeat-offender profiles (§7.2, "repeat-offender tracking").
 *
 * §7.2 asks for a person's incident edges "aggregated into a timeline/profile
 * view, with MO tags compared for similarity across jurisdictions", and the
 * challenge brief names repeat-offender tracking as a capability in its own
 * right. Both parts matter and neither works alone: a list of a suspect's cases
 * is a record search, and an MO signature with no person attached is a
 * statistic. The finding is the intersection — this person, this method, these
 * districts, this stretch of time.
 */

export interface OffenderIncident {
  id: string
  docket: string
  district: string
  at: number
  entry: string
  target: string
  window: string
}

export interface OffenderProfile {
  person: GraphNode
  incidents: OffenderIncident[]
  /** Districts the person's incidents span. */
  districts: string[]
  /** Most frequent entry→target pair — the behavioural signature. */
  signature: string
  /** Days between first and most recent linked incident. */
  spanDays: number
  priors: number
  /** Other people whose dominant signature matches, in a different district. */
  matches: { person: GraphNode; district: string; shared: number }[]
}

function readIncident(n: GraphNode): OffenderIncident | null {
  const m = n.meta
  if (!m) return null
  return {
    id: n.id,
    docket: n.label,
    district: n.district,
    at: Number(m.At ?? 0),
    entry: String(m.Entry ?? '—'),
    target: String(m.Target ?? '—'),
    window: String(m.Window ?? '—'),
  }
}

const signatureOf = (i: OffenderIncident) => `${i.entry} → ${i.target}`

let cache: OffenderProfile[] | null = null

/**
 * Everyone linked to more than one incident, ranked by how many.
 *
 * One offence is not a pattern, so a single-incident person is not a repeat
 * offender and does not belong in this list at all.
 */
export function getOffenderProfiles(): OffenderProfile[] {
  if (cache) return cache

  const { nodes, edges } = getNetwork()
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const linked = new Map<string, OffenderIncident[]>()
  for (const e of edges) {
    if (e.kind !== 'ACCUSED_IN') continue
    const person = byId.get(e.source)?.kind === 'Person' ? byId.get(e.source) : byId.get(e.target)
    const incidentNode =
      byId.get(e.source)?.kind === 'Incident' ? byId.get(e.source) : byId.get(e.target)
    if (!person || !incidentNode || incidentNode.kind !== 'Incident') continue

    const incident = readIncident(incidentNode)
    if (!incident) continue
    if (!linked.has(person.id)) linked.set(person.id, [])
    linked.get(person.id)!.push(incident)
  }

  const draft = [...linked.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => {
      const person = byId.get(id)!
      const incidents = [...list].sort((a, b) => b.at - a.at)

      const tally = new Map<string, number>()
      for (const i of incidents) tally.set(signatureOf(i), (tally.get(signatureOf(i)) ?? 0) + 1)
      const signature = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'

      const districts = [...new Set(incidents.map((i) => i.district))]
      const first = incidents[incidents.length - 1]?.at ?? 0
      const last = incidents[0]?.at ?? 0

      return {
        person,
        incidents,
        districts,
        signature,
        spanDays: Math.max(0, Math.round((last - first) / 864e5)),
        priors: Number(person.meta?.Priors ?? 0),
        matches: [] as OffenderProfile['matches'],
      }
    })

  /*
   * Signature matching across jurisdictions.
   *
   * A shared signature only says something when the two people are working in
   * DIFFERENT districts — within one district a common method is more likely to
   * be a local norm than a link between two offenders. That restriction is what
   * makes this §7.2's "compared for similarity across jurisdictions" rather
   * than a generic similarity join.
   */
  const bySignature = new Map<string, typeof draft>()
  for (const p of draft) {
    if (!bySignature.has(p.signature)) bySignature.set(p.signature, [])
    bySignature.get(p.signature)!.push(p)
  }

  for (const p of draft) {
    const peers = bySignature.get(p.signature) ?? []
    p.matches = peers
      .filter((q) => q.person.id !== p.person.id)
      .filter((q) => !q.districts.every((d) => p.districts.includes(d)))
      .map((q) => ({
        person: q.person,
        district: q.districts[0] ?? q.person.district,
        shared: q.incidents.filter((i) => signatureOf(i) === p.signature).length,
      }))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 5)
  }

  cache = draft.sort(
    (a, b) => b.incidents.length - a.incidents.length || b.districts.length - a.districts.length,
  )
  return cache
}

