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
import { CENSUS_2011, KARNATAKA_STATIONS } from './census'
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

export async function loadPlatformData(): Promise<void> {
  if (!ready) {
    ready = apiGet<Bootstrap>('/api/bootstrap')
      .then(hydrate)
      .catch((err) => {
        ready = null
        throw err
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

/**
 * The natural-language assistant — POST /api/ask.
 *
 * The model that reads the question never sees a row: it is given the schema
 * and returns a query, which the backend validates and runs. `answer` is
 * composed server-side from the result set, not generated by the model, and
 * `query` is the exact statement that produced it — show it, so an officer can
 * check the answer rather than trust it. See docs/ASSISTANT.md.
 */
export interface AskAnswer {
  answer: string
  query: string
  columns: string[]
  rows: Record<string, unknown>[]
  evidence: string[]
  source: string
  model: string
  answerable: boolean
  redactedIdentifiers: number
  elapsedMs: number
  notes: string[]
}

export async function askQuestion(question: string, source?: 'local' | 'catalyst'): Promise<AskAnswer> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, source }),
  })
  const body = (await res.json().catch(() => null)) as (Envelope<AskAnswer> & { detail?: string }) | null
  if (!res.ok) {
    // The backend returns 422 with a plain-language reason — a rejected query,
    // a missing key, an unanswerable question. Surface it verbatim.
    throw new Error(body?.detail || body?.error || `Assistant unavailable (HTTP ${res.status})`)
  }
  if (!body?.success) throw new Error(body?.error || 'Assistant failed')
  return body.data
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
