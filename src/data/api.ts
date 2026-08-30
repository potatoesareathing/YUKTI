/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE SWAP POINT — backed by the YUKTI FastAPI service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Async loaders fetch from VITE_API_BASE_URL. Sync accessors read module caches
 * hydrated by `loadPlatformData()` (GET /api/bootstrap). Path helpers remain
 * pure client-side over the cached graph.
 */

import type {
  AnomalyFlag,
  CrimeCategory,
  DistrictMetrics,
  EdgeKind,
  GraphData,
  GraphEdge,
  GraphNode,
  Incident,
  IncidentFilter,
  ModelCard,
  RiskScore,
  TrendSeries,
} from './types'
import { riskBand } from '@/lib/palette'
import { shortDate } from '@/lib/format'
import { seeded } from '@/lib/rng'
import { CENSUS_2011, KARNATAKA_STATIONS } from './census'
import { getDistrictMetrics as seedDistricts } from './districts'
import { getIncidents as seedIncidents } from './incidents'
import { getStations as seedStations } from './stations'
import { getNetwork as seedNetwork, getCommunities as seedCommunities } from './network'
import { getModelCards as seedModels } from './models'
import { getOffenderProfiles as seedOffenders } from './offenders'
import { getDistrictFlows as seedFlows } from './flows'
import {
  getActiveAlerts as seedAlerts,
  getCategorySeries as seedCategorySeries,
  getDistrictSeries as seedDistrictSeries,
} from './timeseries'
import { NOW as SEED_NOW, PERIOD_DAYS as SEED_PERIOD_DAYS } from './districts'
import { CRIME_CATEGORIES } from './types'
import type { StationMetrics } from './stations'
import type { OffenderProfile } from './offenders'
import type { FlowAggregate } from './flows'
import type { PathLink, PathResult } from './graphpaths'

export type { StationMetrics } from './stations'
export type { OffenderProfile } from './offenders'
export type { PathResult, PathLink } from './graphpaths'
export type { DistrictFlow, DistrictHub } from './flows'
export { CENSUS_2011, KARNATAKA_STATIONS }

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || 'http://127.0.0.1:8000'

export const DRIFT_THRESHOLD = 0.05
export let NOW = Date.parse('2026-07-25T00:00:00Z')
export let PERIOD_DAYS = 180

interface Community {
  id: number
  label: string
  size: number
  district: string
  topNode: GraphNode
}

interface AlertItem {
  series: TrendSeries
  at: number
  index: number
}

interface Envelope<T> {
  success: boolean
  data: T
  error: string | null
  meta: { total: number; page: number; limit: number }
}

interface Bootstrap {
  districts: DistrictMetrics[]
  stateTotals: ReturnType<typeof buildStateTotals>
  incidents: Incident[]
  stations: StationMetrics[]
  network: GraphData
  communities: Community[]
  models: ModelCard[]
  offenders: OffenderProfile[]
  flows: FlowAggregate
  alerts: AlertItem[]
  riskScores: RiskScore[]
  anomalies: AnomalyFlag[]
  categorySeries: Record<string, TrendSeries>
  districtSeries: Record<string, TrendSeries>
  now: number
  periodDays: number
}

let districtsCache: DistrictMetrics[] = []
let incidentsCache: Incident[] = []
let stationsCache: StationMetrics[] = []
let networkCache: GraphData = { nodes: [], edges: [] }
let communitiesCache: Community[] = []
let modelsCache: ModelCard[] = []
let offendersCache: OffenderProfile[] = []
let flowsCache: FlowAggregate | null = null
let alertsCache: AlertItem[] = []
let riskCache: RiskScore[] = []
let anomaliesCache: AnomalyFlag[] = []
let categorySeriesCache: Record<string, TrendSeries> = {}
let districtSeriesCache: Record<string, TrendSeries> = {}
let stateTotalsCache: ReturnType<typeof buildStateTotals> | null = null
let adjacency: {
  neighbours: Map<string, { id: string; edge: GraphEdge }[]>
  byId: Map<string, GraphNode>
} | null = null
let ready: Promise<void> | null = null

function buildStateTotals(ds: DistrictMetrics[]) {
  const byCategory = {} as Record<CrimeCategory, number>
  for (const d of ds) {
    for (const [k, v] of Object.entries(d.byCategory)) {
      byCategory[k as CrimeCategory] = (byCategory[k as CrimeCategory] ?? 0) + v
    }
  }
  return {
    incidents: ds.reduce((a, d) => a + d.incidents, 0),
    byCategory,
    redZones: ds.filter((d) => d.redZone).length,
    stations: ds.reduce((a, d) => a + d.stations, 0),
    avgClearance: Math.round(ds.reduce((a, d) => a + d.clearancePct, 0) / Math.max(1, ds.length)),
  }
}

async function apiGet<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`)
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(body.error || `API ${path} failed`)
  return body.data
}

function hydrate(b: Bootstrap) {
  districtsCache = b.districts
  stateTotalsCache = b.stateTotals
  incidentsCache = b.incidents
  stationsCache = b.stations
  networkCache = b.network
  communitiesCache = b.communities
  modelsCache = b.models
  offendersCache = b.offenders
  flowsCache = b.flows
  alertsCache = b.alerts
  riskCache = b.riskScores
  anomaliesCache = b.anomalies
  categorySeriesCache = b.categorySeries
  districtSeriesCache = b.districtSeries
  NOW = b.now
  PERIOD_DAYS = b.periodDays
  adjacency = null
}

/**
 * Whether the caches are backed by the API or by the bundled seed.
 *
 * The UI reads this to label the dataset honestly — a demo running on seeded
 * data must not present itself as live.
 */
export type DataSource = 'api' | 'seed'
let source: DataSource = 'seed'
export const getDataSource = (): DataSource => source

/**
 * Build the bootstrap payload locally from the bundled generators.
 *
 * This is the fallback when the API is unreachable, and it is not a nicety: the
 * frontend is deployed as a static bundle and is demonstrated on machines where
 * the backend is not running. Without it, an unreachable API takes down the
 * landing page and every module with a "Failed to fetch" card — the whole
 * product becomes a blank screen because one service is down.
 */
async function seedBootstrap(): Promise<Bootstrap> {
  const districts = seedDistricts()
  const [incidents, stations] = await Promise.all([seedIncidents(), seedStations()])

  const categorySeries: Bootstrap['categorySeries'] = {}
  for (const c of CRIME_CATEGORIES) categorySeries[c] = seedCategorySeries(c)

  const districtSeries: Bootstrap['districtSeries'] = {}
  for (const d of districts) {
    for (const c of CRIME_CATEGORIES) {
      districtSeries[`${d.name}|${c}`] = seedDistrictSeries(d.name, c)
    }
  }

  return {
    districts,
    stateTotals: buildStateTotals(districts),
    incidents,
    stations,
    network: seedNetwork(),
    communities: seedCommunities(),
    models: seedModels(),
    offenders: seedOffenders(),
    flows: seedFlows(2),
    alerts: seedAlerts(12),
    riskScores: buildSeedRiskScores(districts, incidents),
    anomalies: buildSeedAnomalies(incidents),
    categorySeries,
    districtSeries,
    now: SEED_NOW,
    periodDays: SEED_PERIOD_DAYS,
  } as Bootstrap
}

/**
 * Seed risk scores.
 *
 * The drivers are read back out of the same four terms `districts.ts` sums to
 * produce the score, so what is displayed is the actual arithmetic rather than a
 * plausible-looking companion to it. A real deployment substitutes SHAP values
 * from the gradient-boosted model; the display contract does not change.
 */
function buildSeedRiskScores(districts: DistrictMetrics[], incidents: Incident[]): RiskScore[] {
  return districts
    .map((d) => {
      const rateTerm = Math.min(1, (d.rate - 95) / 520) * 0.42
      const urbanTerm = (d.urbanPct / 100) * 0.24
      const trendTerm = Math.min(1, Math.max(0, (d.trend + 0.12) / 0.34)) * 0.26
      const litTerm = (1 - d.literacyPct / 100) * 0.18

      const recent = incidents
        .filter((i) => i.district === d.name)
        .sort((a, b) => b.at - a.at)
        .slice(0, 4)

      return {
        district: d.name,
        score: d.riskNorm,
        band: riskBand(d.riskNorm),
        drivers: [
          { feature: `Incident rate — ${d.rate} per 100k`, contribution: rateTerm },
          { feature: `Period-on-period change — ${(d.trend * 100).toFixed(1)}%`, contribution: trendTerm },
          { feature: `Urbanisation — ${d.urbanPct.toFixed(1)}%`, contribution: urbanTerm },
          { feature: `Literacy (inverse) — ${d.literacyPct.toFixed(1)}%`, contribution: litTerm },
        ].sort((a, b) => b.contribution - a.contribution),
        evidence: [
          ...recent.map((i) => ({
            kind: 'incident' as const,
            ref: i.id,
            label: i.docket,
            detail: `${i.category} · ${i.station} · ${shortDate(new Date(i.at))}`,
          })),
          {
            kind: 'feature' as const,
            ref: `${d.name}:census`,
            label: 'Census 2011 indicators',
            detail: `Urban ${d.urbanPct}% · Literacy ${d.literacyPct}% · Population ${d.population.toLocaleString('en-IN')}`,
          },
        ],
        horizonDays: 30,
      }
    })
    .sort((a, b) => b.score - a.score)
}

function buildSeedAnomalies(incidents: Incident[], limit = 24): AnomalyFlag[] {
  return incidents
    .filter((i) => i.anomaly)
    .sort((a, b) => b.anomalyScore - a.anomalyScore)
    .slice(0, limit)
    .map((i) => {
      const r = seeded(`anomaly:${i.id}`)
      const reasons = [
        `Offence window ${i.mo.timing} is atypical for ${i.category} in this jurisdiction`,
        `Entry method "${i.mo.entry}" rare for ${i.mo.target} in ${i.district}`,
        `Target profile deviates from the station's recorded pattern`,
        `Combination of tools and timing not seen in the preceding 90 days`,
      ]
      return {
        id: `ANM-${i.id}`,
        incidentId: i.id,
        district: i.district,
        score: i.anomalyScore,
        reason: reasons[Math.floor(r() * reasons.length)],
        at: i.at,
        evidence: [
          { kind: 'incident' as const, ref: i.id, label: i.docket, detail: i.narrative },
          {
            kind: 'feature' as const,
            ref: `${i.id}:mo`,
            label: 'MO feature vector',
            detail: `${i.mo.entry} · ${i.mo.target} · ${i.mo.timing} · ${i.mo.tools}`,
          },
        ],
      }
    })
}

export async function loadPlatformData(): Promise<void> {
  if (!ready) {
    ready = apiGet<Bootstrap>('/api/bootstrap')
      .then((b) => {
        source = 'api'
        hydrate(b)
      })
      .catch(async () => {
        // Degrade to the bundled seed rather than taking the whole app down.
        source = 'seed'
        hydrate(await seedBootstrap())
      })
  }
  return ready
}

export async function getDistricts(): Promise<DistrictMetrics[]> {
  await loadPlatformData()
  return districtsCache
}

export async function getIncidents(): Promise<Incident[]> {
  await loadPlatformData()
  return incidentsCache
}

export async function getStations(): Promise<StationMetrics[]> {
  await loadPlatformData()
  return stationsCache
}

export async function getIncidentsFiltered(filter: IncidentFilter = {}): Promise<Incident[]> {
  const all = await getIncidents()
  return all.filter((i) => {
    if (filter.districts?.length && !filter.districts.includes(i.district)) return false
    if (filter.categories?.length && !filter.categories.includes(i.category)) return false
    if (filter.from !== undefined && i.at < filter.from) return false
    if (filter.to !== undefined && i.at > filter.to) return false
    if (filter.anomalousOnly && !i.anomaly) return false
    return true
  })
}

export async function getGraph(rootId?: string, depth = 2): Promise<GraphData> {
  return apiGet<GraphData>('/api/graph', { rootId, depth })
}

export async function getTimeSeries(category: CrimeCategory, district?: string): Promise<TrendSeries> {
  await loadPlatformData()
  if (district) return getDistrictSeries(district, category)
  return getCategorySeries(category)
}

export async function getModels(): Promise<ModelCard[]> {
  await loadPlatformData()
  return modelsCache
}

export async function getRiskScores(): Promise<RiskScore[]> {
  await loadPlatformData()
  return riskCache
}

export async function getAnomalies(limit = 24): Promise<AnomalyFlag[]> {
  await loadPlatformData()
  return anomaliesCache.slice(0, limit)
}

export function getDistrictMetrics(): DistrictMetrics[] {
  return districtsCache
}

export function stateTotals() {
  return stateTotalsCache ?? buildStateTotals(districtsCache)
}

export function volumeScale(): (n: number) => number {
  const all = getDistrictMetrics().map((d) => d.incidents)
  const max = Math.max(0, ...all)
  const min = Math.min(...all, 0)
  return (n) => Math.sqrt((n - min) / (max - min || 1))
}

export function getNetwork(): GraphData {
  return networkCache
}

export function getCommunities() {
  return communitiesCache
}

export function getModelCards(): ModelCard[] {
  return modelsCache
}

export function getCategorySeries(cat: CrimeCategory): TrendSeries {
  return (
    categorySeriesCache[cat] ?? {
      key: cat,
      label: cat,
      points: [],
      controlLimit: 0,
      breaches: [],
    }
  )
}

export function getDistrictSeries(district: string, cat: CrimeCategory): TrendSeries {
  return (
    districtSeriesCache[`${district}|${cat}`] ?? {
      key: `${district}:${cat}`,
      label: `${district} — ${cat}`,
      points: [],
      controlLimit: 0,
      breaches: [],
    }
  )
}

export function getActiveAlerts(withinWeeks = 10): AlertItem[] {
  if (!alertsCache.length) return []
  const maxAt = Math.max(...alertsCache.map((a) => a.at))
  const windowMs = withinWeeks * 7 * 864e5
  return alertsCache.filter((a) => maxAt - a.at <= windowMs)
}

export function getOffenderProfiles(): OffenderProfile[] {
  return offendersCache
}

export function peekStations(district?: string): StationMetrics[] {
  return district ? stationsCache.filter((s) => s.district === district) : stationsCache
}

export function getDistrictFlows(minTies = 2): FlowAggregate {
  if (flowsCache && flowsCache.minTies === minTies) return flowsCache
  return (
    flowsCache ?? {
      flows: [],
      hubs: [],
      droppedPairs: 0,
      droppedTies: 0,
      totalCrossTies: 0,
      minTies,
    }
  )
}

export function linkedDistricts(district: string, minTies = 2): Set<string> {
  const out = new Set<string>()
  for (const f of getDistrictFlows(minTies).flows) {
    if (f.a === district) out.add(f.b)
    if (f.b === district) out.add(f.a)
  }
  return out
}

export function communityDistricts(community: number): Set<string> {
  const out = new Set<string>()
  for (const n of getNetwork().nodes) {
    if (n.community === community) out.add(n.district)
  }
  return out
}

function getAdjacency() {
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

export function commonNeighbours(a: string, b: string): GraphNode[] {
  if (!a || !b || a === b) return []
  const { neighbours, byId } = getAdjacency()
  const setA = new Set((neighbours.get(a) ?? []).map((n) => n.id))
  return (neighbours.get(b) ?? [])
    .filter((n) => setA.has(n.id))
    .map((n) => byId.get(n.id)!)
    .filter(Boolean)
}

export function suggestedOrigins(limit = 10): GraphNode[] {
  return [...getNetwork().nodes]
    .filter((n) => n.kind === 'Person')
    .sort((a, b) => b.centrality - a.centrality)
    .slice(0, limit)
}

export function edgeLabel(kind: EdgeKind): string {
  return kind.replace(/_/g, ' ').toLowerCase()
}

/** Download KSP Criminal History / Rowdy-Sheet PDF for a suspect (offender) id. */
export async function downloadDossierPdf(suspectId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/suspects/${encodeURIComponent(suspectId)}/dossier-pdf`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Dossier export failed (${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `KSP_Dossier_${suspectId}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Multi-source syndicate shortest path across phones / vehicles / accounts. */
export async function findSyndicatePath(
  a: string,
  b: string,
  maxHops = 6,
): Promise<{ found: boolean; hops: number; nodes: GraphNode[]; edges: GraphEdge[] }> {
  const res = await fetch(
    `${BASE}/api/v1/graph/syndicate-path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&maxHops=${maxHops}`,
  )
  if (!res.ok) throw new Error(`Syndicate path failed (${res.status})`)
  const env = (await res.json()) as Envelope<{
    found: boolean
    hops: number
    nodes: GraphNode[]
    edges: GraphEdge[]
  }>
  return env.data
}

export type LiveFirEvent = {
  event?: string
  cctns_fir_id?: string
  district_id?: string
  crime_head_name?: string
  lat?: number
  lng?: number
  fir_timestamp?: number
  parsed_mo_metadata?: Record<string, unknown>
  mo_alerts?: MoPatternAlert[]
  type?: string
  score_pct?: number
  comparison?: MoComparison
}

export type MoPatternAlert = {
  id?: string
  type?: string
  fir_a?: string
  fir_b?: string
  district_a?: string
  district_b?: string
  score?: number
  score_pct?: number
  shared_tags?: string[]
  comparison?: MoComparison
}

export type MoComparison = {
  a: { id: string; district: string; crime_head?: string; mo?: Record<string, unknown>; narrative?: string }
  b: { id: string; district: string; crime_head?: string; mo?: Record<string, unknown>; narrative?: string }
}

export function subscribeCctnsLive(onEvent: (ev: LiveFirEvent) => void): () => void {
  const es = new EventSource(`${BASE}/api/v1/cctns/stream`)
  const handler = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(e.data)) as LiveFirEvent)
    } catch {
      /* ignore */
    }
  }
  es.addEventListener('fir', handler as EventListener)
  es.onerror = () => {
    /* browser auto-reconnects */
  }
  return () => es.close()
}

export async function fetchBeatFeed(lat: number, lng: number, radiusKm = 2) {
  const res = await fetch(
    `${BASE}/api/v1/beat/feed?lat=${lat}&lng=${lng}&radiusKm=${radiusKm}`,
  )
  if (!res.ok) throw new Error(`Beat feed failed (${res.status})`)
  const env = (await res.json()) as Envelope<Record<string, unknown>>
  return env.data
}

export async function checkGeofence(lat: number, lng: number) {
  const res = await fetch(`${BASE}/api/v1/beat/geofence-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng }),
  })
  if (!res.ok) throw new Error(`Geofence check failed (${res.status})`)
  const env = (await res.json()) as Envelope<{
    inside: boolean
    zones: Array<{ alert_template?: string; label?: string; distance_m?: number }>
  }>
  return env.data
}

export async function fetchMoPatternAlerts(limit = 30): Promise<MoPatternAlert[]> {
  const res = await fetch(`${BASE}/api/v1/mo/pattern-alerts?limit=${limit}`)
  if (!res.ok) return []
  const env = (await res.json()) as Envelope<MoPatternAlert[]>
  return env.data ?? []
}

export async function extractMoNarrative(narrative: string) {
  const res = await fetch(`${BASE}/api/v1/nlp/extract-mo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_kannada_narrative: narrative }),
  })
  if (!res.ok) throw new Error(`NLP extract failed (${res.status})`)
  const env = (await res.json()) as Envelope<Record<string, unknown>>
  return env.data
}

/** Log evidence-drawer opens — §10.1 */
export async function logAudit(action: string, resourceRefs: string[], detail = ''): Promise<void> {
  try {
    await fetch(`${BASE}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, resource_refs: resourceRefs, detail }),
    })
  } catch {
    /* non-blocking */
  }
}
