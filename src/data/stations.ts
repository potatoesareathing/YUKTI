import { getIncidents } from './incidents'
import { getDistrictMetrics } from './districts'
import { CRIME_CATEGORIES, type CrimeCategory, type Incident } from './types'

/**
 * Police-station aggregation — the second tier of §7.1's drill-down.
 *
 * §7.1 asks for a map that filters "state → district → police-station
 * jurisdiction", and the challenge brief repeats it: interactive maps across
 * districts AND specific police stations. District was as far as the map went.
 *
 * Stations have no boundary geometry in the dataset, so a station's position is
 * the centroid of its own recorded incidents. That is honest — it is where the
 * station's work actually happened, which for a hotspot map is more useful than
 * the address of the building.
 *
 * Counts are SCALED. The incident layer is a ~4,200-record sample standing in
 * for the full period, so a raw station count would read as "eleven burglaries
 * in Bengaluru East" when the district's real figure is in the thousands. Each
 * station's share of its district's sample is applied to the district's true
 * total, and the UI says the figure is an estimate.
 */

export interface StationMetrics {
  id: string
  name: string
  district: string
  /** Centroid of this station's incidents, in world XZ. */
  world: [number, number]
  /** Records in the sample — the basis for the estimate. */
  sampled: number
  /** Sample share applied to the district total. */
  estimated: number
  byCategory: Record<CrimeCategory, number>
  topCategory: CrimeCategory
  anomalies: number
  /** Share of the district's recorded activity, 0..1. */
  share: number
  lastAt: number
}

function build(incidents: Incident[]): StationMetrics[] {
  const districtTotals = new Map(getDistrictMetrics().map((d) => [d.name, d.incidents]))

  const grouped = new Map<string, Incident[]>()
  for (const i of incidents) {
    const key = `${i.district}|${i.station}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(i)
  }

  const perDistrictSample = new Map<string, number>()
  for (const i of incidents) {
    perDistrictSample.set(i.district, (perDistrictSample.get(i.district) ?? 0) + 1)
  }

  return [...grouped.entries()]
    .map(([id, list]) => {
      const district = list[0].district
      const sampleTotal = perDistrictSample.get(district) ?? list.length
      const share = list.length / (sampleTotal || 1)

      const byCategory = {} as Record<CrimeCategory, number>
      for (const c of CRIME_CATEGORIES) byCategory[c] = 0
      for (const i of list) byCategory[i.category]++

      const topCategory = CRIME_CATEGORIES.reduce((best, c) =>
        byCategory[c] > byCategory[best] ? c : best,
      )

      let x = 0
      let z = 0
      for (const i of list) {
        x += i.world[0]
        z += i.world[1]
      }

      return {
        id,
        name: list[0].station,
        district,
        world: [x / list.length, z / list.length] as [number, number],
        sampled: list.length,
        estimated: Math.round(share * (districtTotals.get(district) ?? 0)),
        byCategory,
        topCategory,
        anomalies: list.filter((i) => i.anomaly).length,
        share,
        lastAt: Math.max(...list.map((i) => i.at)),
      }
    })
    .sort((a, b) => b.estimated - a.estimated)
}

let cache: StationMetrics[] | null = null

export async function getStations(): Promise<StationMetrics[]> {
  if (!cache) cache = build(await getIncidents())
  return cache
}

/** Synchronous read, valid once `getStations` has resolved. */
export function peekStations(district?: string): StationMetrics[] {
  const all = cache ?? []
  return district ? all.filter((s) => s.district === district) : all
}
