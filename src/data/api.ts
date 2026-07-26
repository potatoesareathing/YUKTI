import { seeded } from '@/lib/rng'
import { riskBand } from '@/lib/palette'
import { shortDate } from '@/lib/format'
import { getDistrictMetrics, NOW } from './districts'
import { getIncidents } from './incidents'
import { getNetwork, getEgoNetwork } from './network'
import { getCategorySeries, getDistrictSeries } from './timeseries'
import { getModelCards } from './models'
import type {
  AnomalyFlag,
  CrimeCategory,
  DistrictMetrics,
  Evidence,
  GraphData,
  Incident,
  IncidentFilter,
  ModelCard,
  RiskScore,
  TrendSeries,
} from './types'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE SWAP POINT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  This is the only file the backend team replaces. Every function below returns
 *  synthetic, seeded data today; each maps to a service described in §5.2 and
 *  §6.1 of the technical solution document:
 *
 *    getDistricts    → aggregate query service over PostgreSQL / PostGIS
 *    getIncidents    → FIR query service (Elasticsearch for narrative search)
 *    getNetwork      → Neo4j graph service (§9.2 schema)
 *    getTimeSeries   → analytics service reading precomputed STL/CUSUM output
 *    getRiskScores   → model-serving endpoint for the gradient-boosted model
 *    getAnomalies    → model-serving endpoint for Isolation Forest output
 *    getModels       → MLflow registry
 *
 *  Every signature is already async and already returns the §9 domain types, so
 *  the swap is a re-implementation of this file — not a refactor of the UI.
 *
 *  CONTRACT NOTE: RiskScore and AnomalyFlag both carry a non-optional
 *  `evidence` array. §10.3 requires that a model output surfaced to an
 *  investigator links back to the records that produced it, so the type makes an
 *  unexplainable score impossible to construct. Keep it that way.
 */

/**
 * Resolution helper. Trivial today; it exists so that every call site is already
 * written against a promise and the swap to real fetches touches only this file.
 */
const settle = <T,>(value: T): Promise<T> => Promise.resolve(value)

export async function getDistricts(): Promise<DistrictMetrics[]> {
  return settle(getDistrictMetrics())
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
  return settle(rootId ? getEgoNetwork(rootId, depth) : getNetwork())
}

export async function getTimeSeries(category: CrimeCategory, district?: string): Promise<TrendSeries> {
  return settle(district ? getDistrictSeries(district, category) : getCategorySeries(category))
}

export async function getModels(): Promise<ModelCard[]> {
  return settle(getModelCards())
}

/* ── Model outputs, with evidence ──────────────────────────────────────────── */

/**
 * Recompute the risk score's feature contributions.
 *
 * These are the same four terms `districts.ts` sums to produce the score, read
 * back out and labelled. That matters: the drivers shown to an investigator are
 * the actual arithmetic behind the number, not a plausible-looking explanation
 * generated alongside it. A real deployment substitutes SHAP values from the
 * gradient-boosted model here; the display contract does not change.
 */
function driversFor(d: DistrictMetrics): RiskScore['drivers'] {
  const rateTerm = Math.min(1, (d.rate - 95) / 520) * 0.42
  const urbanTerm = (d.urbanPct / 100) * 0.24
  const trendTerm = Math.min(1, Math.max(0, (d.trend + 0.12) / 0.34)) * 0.26
  const litTerm = (1 - d.literacyPct / 100) * 0.18

  return [
    { feature: `Incident rate — ${d.rate} per 100k`, contribution: rateTerm },
    { feature: `Period-on-period change — ${(d.trend * 100).toFixed(1)}%`, contribution: trendTerm },
    { feature: `Urbanisation — ${d.urbanPct.toFixed(1)}%`, contribution: urbanTerm },
    { feature: `Literacy (inverse) — ${d.literacyPct.toFixed(1)}%`, contribution: litTerm },
  ].sort((a, b) => b.contribution - a.contribution)
}

export async function getRiskScores(): Promise<RiskScore[]> {
  const districts = getDistrictMetrics()
  const incidents = await getIncidents()

  return districts
    .map((d) => {
      const top = incidents
        .filter((i) => i.district === d.name)
        .sort((a, b) => b.at - a.at)
        .slice(0, 4)

      const evidence: Evidence[] = [
        ...top.map<Evidence>((i) => ({
          kind: 'incident',
          ref: i.id,
          label: i.docket,
          detail: `${i.category} · ${i.station} · ${shortDate(new Date(i.at))}`,
        })),
        {
          kind: 'series',
          ref: `${d.name}:trend`,
          label: 'Category trend series',
          detail: `${d.incidents.toLocaleString('en-IN')} records over the 180-day window`,
        },
        {
          kind: 'feature',
          ref: `${d.name}:census`,
          label: 'Census 2011 indicators',
          detail: `Urban ${d.urbanPct}% · Literacy ${d.literacyPct}% · Population ${d.population.toLocaleString('en-IN')}`,
        },
      ]

      return {
        district: d.name,
        score: d.risk,
        band: riskBand(d.risk),
        drivers: driversFor(d),
        evidence,
        horizonDays: 30,
      }
    })
    .sort((a, b) => b.score - a.score)
}

export async function getAnomalies(limit = 24): Promise<AnomalyFlag[]> {
  const incidents = await getIncidents()
  const flagged = incidents.filter((i) => i.anomaly).sort((a, b) => b.anomalyScore - a.anomalyScore)

  return flagged.slice(0, limit).map((i) => {
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
        { kind: 'incident', ref: i.id, label: i.docket, detail: i.narrative },
        {
          kind: 'feature',
          ref: `${i.id}:mo`,
          label: 'MO feature vector',
          detail: `${i.mo.entry} · ${i.mo.target} · ${i.mo.timing} · ${i.mo.tools}`,
        },
        {
          kind: 'feature',
          ref: `${i.id}:baseline`,
          label: 'Jurisdiction baseline',
          detail: `${i.station} — compared against 90 days of recorded ${i.category} incidents`,
        },
      ],
    }
  })
}

export { NOW }
