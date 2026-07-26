import { CENSUS_2011 } from './census'
import { CRIME_CATEGORIES, type CrimeCategory, type DistrictMetrics } from './types'
import { gaussian, seeded } from '@/lib/rng'

/**
 * Synthetic district-level metrics, built on the real Census denominators.
 *
 * The generator is not noise. Category mix is driven by socio-economic
 * structure the way §7.3 describes it: cyber and financial fraud concentrate
 * where urbanisation and literacy are high, property crime tracks urban density,
 * and NDPS weights toward coastal and border districts. This means the
 * correlations MOD-03 surfaces are actually present in the data rather than
 * being asserted over random numbers.
 */

/** Fixed clock. Every derived figure is stable across reloads. */
export const NOW = Date.parse('2026-07-25T00:00:00Z')
export const PERIOD_DAYS = 180

/** Districts where NDPS enforcement runs higher — coastal belt and state borders. */
const NDPS_WEIGHTED = new Set([
  'Dakshina Kannada', 'Udupi', 'Uttara Kannada', 'Kodagu',
  'Bidar', 'Kalaburagi', 'Chamarajanagara', 'Bengaluru Urban',
])

function categoryWeights(row: (typeof CENSUS_2011)[number]): Record<CrimeCategory, number> {
  const u = row.urbanPct / 100
  const lit = row.literacyPct / 100
  const rural = 1 - u

  return {
    'Body Offence': 0.9 + rural * 0.7,
    'Property Crime': 0.7 + u * 2.1,
    'Vehicle Theft': 0.35 + u * 2.4,
    'Cyber & Financial Fraud': 0.15 + u * 2.6 * lit,
    'Crime Against Women': 0.8 + u * 0.5,
    'Narcotics (NDPS)': (0.3 + u * 0.6) * (NDPS_WEIGHTED.has(row.name) ? 2.3 : 1),
    'Public Order': 0.6 + rural * 0.9,
    'Economic Offence': 0.2 + u * 1.4 * lit,
  }
}

function build(): DistrictMetrics[] {
  return CENSUS_2011.map((row) => {
    const r = seeded(`district:${row.name}`)
    const u = row.urbanPct / 100

    // Incidents per 100k. Urban districts report more; the spread is modest
    // because reporting rate, not just incidence, drives recorded crime.
    const baseRate = 150 + u * 330 + gaussian(r, 0, 38)
    const rate = Math.max(95, baseRate)
    const total = Math.round((rate * row.population) / 100_000 / (365 / PERIOD_DAYS))

    const weights = categoryWeights(row)
    const wsum = CRIME_CATEGORIES.reduce((a, c) => a + weights[c], 0)

    const byCategory = {} as Record<CrimeCategory, number>
    let assigned = 0
    CRIME_CATEGORIES.forEach((c, i) => {
      if (i === CRIME_CATEGORIES.length - 1) {
        byCategory[c] = Math.max(0, total - assigned)
      } else {
        const n = Math.round((weights[c] / wsum) * total * (0.9 + r() * 0.2))
        byCategory[c] = n
        assigned += n
      }
    })

    const trend = gaussian(r, 0.012, 0.085)

    // Risk is a function of observable features, not a random number — the
    // drivers surfaced in MOD-03 are read back out of this same computation.
    const rateTerm = Math.min(1, (rate - 95) / 520) * 0.42
    const urbanTerm = u * 0.24
    const trendTerm = Math.min(1, Math.max(0, (trend + 0.12) / 0.34)) * 0.26
    const litTerm = (1 - row.literacyPct / 100) * 0.18
    const risk = Math.min(0.97, Math.max(0.05, rateTerm + urbanTerm + trendTerm + litTerm))

    return {
      name: row.name,
      code: '',
      population: row.population,
      urbanPct: row.urbanPct,
      literacyPct: row.literacyPct,
      stations: row.stations,
      incidents: total,
      byCategory,
      rate: Math.round(rate),
      risk,
      riskNorm: 0, // filled in below, once the whole distribution is known
      trend,
      redZone: false, // ditto — a red zone is defined relative to the state
      clearancePct: Math.round(38 + (row.literacyPct - 50) * 0.42 + gaussian(r, 0, 5)),
    }
  })
}

/**
 * Spread the raw risk scores across the full ramp for display.
 *
 * The gradient-boosted score is a sum of four bounded terms, so in practice it
 * occupies roughly 0.25–0.65 and every district lands in the same brass-orange
 * band — a map on which nothing is distinguishable from anything else. §7.3
 * calls for a RELATIVE risk score per jurisdiction, so the display value is the
 * district's rank within the state. `risk` stays the model's own number and is
 * what MOD-03 reports; `riskNorm` is only ever used for colour.
 */
function normalise(rows: DistrictMetrics[]): DistrictMetrics[] {
  const order = [...rows].sort((a, b) => a.risk - b.risk)
  const rank = new Map(order.map((d, i) => [d.name, i / (order.length - 1)]))

  return rows.map((d) => {
    const r = rank.get(d.name) ?? 0
    return {
      ...d,
      // Raw rank would paint the top quarter of the state critical red, which
      // overstates the finding: on a 30-district ranking, someone is always in
      // the top quartile. The exponent keeps the order intact but reserves the
      // hot end of the ramp for districts that are genuinely separated from the
      // pack, so red on the map means what red means in the alert list.
      riskNorm: Math.pow(r, 1.45),
      // §7.4: a red zone needs both elevated relative risk AND a climbing
      // period-on-period change, so a persistently busy district does not sit
      // permanently in alarm.
      redZone: r > 0.74 && d.trend > 0.075,
    }
  })
}

let cached: DistrictMetrics[] | null = null

export function getDistrictMetrics(): DistrictMetrics[] {
  if (!cached) cached = normalise(build())
  return cached
}


/** Normalise incident volume to 0..1 — drives extruded tower height. */
export function volumeScale(): (n: number) => number {
  const all = getDistrictMetrics().map((d) => d.incidents)
  const max = Math.max(...all)
  const min = Math.min(...all)
  // Square root: Bengaluru Urban is an order of magnitude above Kodagu, and a
  // linear scale would flatten all 29 other districts into the base plate.
  return (n) => Math.sqrt((n - min) / (max - min || 1))
}

export function stateTotals() {
  const ds = getDistrictMetrics()
  const incidents = ds.reduce((a, d) => a + d.incidents, 0)
  const byCategory = {} as Record<CrimeCategory, number>
  CRIME_CATEGORIES.forEach((c) => {
    byCategory[c] = ds.reduce((a, d) => a + d.byCategory[c], 0)
  })
  return {
    incidents,
    byCategory,
    redZones: ds.filter((d) => d.redZone).length,
    stations: ds.reduce((a, d) => a + d.stations, 0),
    avgClearance: Math.round(ds.reduce((a, d) => a + d.clearancePct, 0) / ds.length),
  }
}
