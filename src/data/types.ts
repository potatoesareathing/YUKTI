/**
 * Domain types, mirroring §9 (Data Model Overview) of the CIAP Technical
 * Solution Document. The backend team implements against these exactly: the
 * relational entities in §9.1 and the Neo4j graph schema in §9.2.
 */

/* ── §9.1 Core entities (relational) ───────────────────────────────────────── */

export type CrimeCategory =
  | 'Body Offence'
  | 'Property Crime'
  | 'Vehicle Theft'
  | 'Cyber & Financial Fraud'
  | 'Crime Against Women'
  | 'Narcotics (NDPS)'
  | 'Public Order'
  | 'Economic Offence'

export const CRIME_CATEGORIES: CrimeCategory[] = [
  'Body Offence',
  'Property Crime',
  'Vehicle Theft',
  'Cyber & Financial Fraud',
  'Crime Against Women',
  'Narcotics (NDPS)',
  'Public Order',
  'Economic Offence',
]

export type CaseStatus = 'Under Investigation' | 'Chargesheeted' | 'Disposed' | 'Untraced'

/** Modus operandi features, per §7.5 — the behavioural signature. */
export interface ModusOperandi {
  entry: string
  target: string
  timing: string
  tools: string
}

/** An FIR / incident record. §9.1 "Incident / FIR". */
export interface Incident {
  id: string
  docket: string
  category: CrimeCategory
  district: string
  station: string
  lonLat: [number, number]
  /** Ground-plane position, precomputed so the 3D layer never re-projects. */
  world: [number, number]
  at: number
  status: CaseStatus
  mo: ModusOperandi
  narrative: string
  officer: string
  /** True where the AI/ML layer (§8) flagged this record as out-of-pattern. */
  anomaly: boolean
  anomalyScore: number
}

/** §9.1 "Person" — role is per-incident, never a fixed attribute. */
export interface Person {
  id: string
  docket: string
  name: string
  age: number
  district: string
  priors: number
  /** MO signature cluster this person's incidents fall into (§7.5). */
  moCluster: number
}

export interface DistrictMetrics {
  name: string
  code: string
  /** 2011 Census — real reference figures, not synthetic. */
  population: number
  urbanPct: number
  literacyPct: number
  stations: number
  /** Synthetic, seeded. */
  incidents: number
  byCategory: Record<CrimeCategory, number>
  /** Incidents per 100,000 population — the comparable figure. */
  rate: number
  /** 0..1 relative risk score from the gradient-boosted model (§8). */
  risk: number
  /** Rank of `risk` within the state, 0..1. Colour only — see districts.ts. */
  riskNorm: number
  /** Period-on-period change in total incidents. */
  trend: number
  /** True where CUSUM/EWMA breached the control limit (§7.4). */
  redZone: boolean
  clearancePct: number
}

/* ── §9.2 Graph schema (Neo4j) ─────────────────────────────────────────────── */

export type NodeKind = 'Person' | 'Incident' | 'Location' | 'Vehicle' | 'Organisation'

export type EdgeKind =
  | 'ACCUSED_IN'
  | 'VICTIM_OF'
  | 'WITNESSED'
  | 'OCCURRED_AT'
  | 'ASSOCIATED_WITH'
  | 'SAME_MO_AS'
  | 'MEMBER_OF'
  | 'CO_ACCUSED_WITH'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  district: string
  /** Louvain community index (§7.5). */
  community: number
  /** Normalised PageRank — drives node size in the 3D graph. */
  centrality: number
  degree: number
  meta?: Record<string, string | number>
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  weight: number
  /** True where the edge is a GraphSAGE-predicted link, not an observed one. */
  predicted?: boolean
  confidence?: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/* ── §8 Analytical outputs ─────────────────────────────────────────────────── */

/** A time series with STL components separated, per §7.4. */
export interface TrendSeries {
  key: string
  label: string
  points: { at: number; value: number; trend: number; seasonal: number; residual: number }[]
  /** CUSUM control limit, in residual units. */
  controlLimit: number
  /** Indices where the residual breached the limit. */
  breaches: number[]
}

/**
 * Every model output carries the records that produced it. This is §10.3
 * expressed as a type: an output without evidence must not be constructible.
 */
export interface Evidence {
  kind: 'incident' | 'person' | 'series' | 'feature'
  ref: string
  label: string
  detail: string
}

export interface RiskScore {
  district: string
  score: number
  band: 'low' | 'moderate' | 'high' | 'critical'
  /** SHAP-style contributions, summing to roughly the score. */
  drivers: { feature: string; contribution: number }[]
  evidence: Evidence[]
  horizonDays: number
}

export interface AnomalyFlag {
  id: string
  incidentId: string
  district: string
  score: number
  reason: string
  evidence: Evidence[]
  at: number
}

/** §8 model portfolio, as surfaced in MOD-06. */
export interface ModelCard {
  id: string
  name: string
  purpose: string
  family: string
  io: string
  status: 'Serving' | 'Retraining' | 'Validation' | 'Registered'
  version: string
  metricLabel: string
  metric: number
  drift: number
  lastTrained: number
  module: string
}

export interface IncidentFilter {
  districts?: string[]
  categories?: CrimeCategory[]
  from?: number
  to?: number
  anomalousOnly?: boolean
}
