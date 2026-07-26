import { gaussian, seeded } from '@/lib/rng'
import { getDistrictMetrics, NOW } from './districts'
import { CRIME_CATEGORIES, type CrimeCategory, type TrendSeries } from './types'

/**
 * Category time series with STL components and CUSUM spike detection (§7.4).
 *
 * Real STL *decomposes* an observed series into trend + seasonal + residual.
 * Here the series is synthetic, so it is constructed the other way round — from
 * known components — and the decomposition the UI displays is exact rather than
 * estimated. The CUSUM pass that follows is the genuine algorithm from §8: a
 * two-sided tabular CUSUM with a slack parameter and a decision interval, run
 * over the residual. It is what actually decides whether a district is a
 * red zone; nothing in the UI declares a red zone by eyeballing a number.
 */

const WEEKS = 104
const WEEK_MS = 7 * 864e5

/** Seasonal shape per category. Crime is not uniform across the year. */
const SEASONAL_AMPLITUDE: Record<CrimeCategory, number> = {
  'Body Offence': 0.09,
  'Property Crime': 0.14,
  'Vehicle Theft': 0.11,
  'Cyber & Financial Fraud': 0.06,
  'Crime Against Women': 0.07,
  'Narcotics (NDPS)': 0.18,
  'Public Order': 0.22,
  'Economic Offence': 0.05,
}

/** Weeks offset of each category's annual peak — festival season, monsoon, etc. */
const SEASONAL_PHASE: Record<CrimeCategory, number> = {
  'Body Offence': 18,
  'Property Crime': 42,
  'Vehicle Theft': 38,
  'Cyber & Financial Fraud': 12,
  'Crime Against Women': 26,
  'Narcotics (NDPS)': 46,
  'Public Order': 40,
  'Economic Offence': 8,
}

/**
 * Two-sided tabular CUSUM. `k` is the slack (half the shift we care about),
 * `h` the decision interval, both in standard deviations of the residual.
 */
function cusum(
  residual: number[],
  sd: number,
  k = 0.5,
  h = 4.2,
  refractory = 12,
): { breaches: number[]; limit: number } {
  let hi = 0
  let lo = 0
  let quietUntil = -1
  const breaches: number[] = []

  for (let i = 0; i < residual.length; i++) {
    const z = residual[i] / (sd || 1)
    hi = Math.max(0, hi + z - k)
    lo = Math.min(0, lo + z + k)

    if (hi > h || lo < -h) {
      hi = 0
      lo = 0
      // A sustained level shift re-arms the statistic within a week or two and
      // would otherwise signal every week for the rest of the series. In
      // practice a signal is acted on and the chart re-baselined, so one shift
      // produces one alert — and an alert list that repeats the same finding
      // nine times is one an analyst learns to ignore.
      if (i > quietUntil) {
        breaches.push(i)
        quietUntil = i + refractory
      }
    }
  }
  return { breaches, limit: h * (sd || 1) }
}

function buildSeries(key: string, label: string, baseWeekly: number, cat: CrimeCategory): TrendSeries {
  const r = seeded(`series:${key}`)
  const amp = SEASONAL_AMPLITUDE[cat]
  const phase = SEASONAL_PHASE[cat]

  // Trend: slow drift plus a gentle curve, so the STL trend line is not a
  // straight line pretending to be interesting.
  const drift = gaussian(r, 0.0016, 0.0022)
  const curve = gaussian(r, 0, 0.00004)

  const trend: number[] = []
  const seasonal: number[] = []
  const residual: number[] = []

  // A single injected level shift somewhere in the last third — this is what
  // CUSUM is meant to catch, and it gives the alert panel something true to say.
  const shiftAt = Math.floor(WEEKS * (0.68 + r() * 0.24))
  const shiftSize = (r() > 0.45 ? 1 : -1) * baseWeekly * (0.16 + r() * 0.22)
  const hasShift = r() > 0.42

  for (let i = 0; i < WEEKS; i++) {
    const t = baseWeekly * (1 + drift * i + curve * i * i)
    trend.push(t)
    seasonal.push(baseWeekly * amp * Math.sin(((i + phase) / 52) * Math.PI * 2))
    const shift = hasShift && i >= shiftAt ? shiftSize : 0
    residual.push(gaussian(r, 0, baseWeekly * 0.055) + shift)
  }

  // Estimate the control limit from an IN-CONTROL baseline — the portion of the
  // series before any injected shift. Including the shift in the variance
  // estimate inflates sigma, which widens the limits until the very thing being
  // detected no longer crosses them.
  const baseline = residual.slice(0, Math.floor(WEEKS * 0.6))
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length
  const sd = Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length)
  const { breaches, limit } = cusum(residual, sd)

  const start = NOW - (WEEKS - 1) * WEEK_MS
  const points = residual.map((res, i) => ({
    at: start + i * WEEK_MS,
    value: Math.max(0, trend[i] + seasonal[i] + res),
    trend: trend[i],
    seasonal: seasonal[i],
    residual: res,
  }))

  return { key, label, points, controlLimit: limit, breaches }
}

const cache = new Map<string, TrendSeries>()

/** State-wide series for one crime category. */
export function getCategorySeries(cat: CrimeCategory): TrendSeries {
  const key = `state:${cat}`
  if (!cache.has(key)) {
    const total = getDistrictMetrics().reduce((a, d) => a + d.byCategory[cat], 0)
    cache.set(key, buildSeries(key, cat, Math.max(4, total / 26), cat))
  }
  return cache.get(key)!
}

/** One district, one category. */
export function getDistrictSeries(district: string, cat: CrimeCategory): TrendSeries {
  const key = `${district}:${cat}`
  if (!cache.has(key)) {
    const d = getDistrictMetrics().find((x) => x.name === district)
    const base = Math.max(1.5, (d?.byCategory[cat] ?? 40) / 26)
    cache.set(key, buildSeries(key, `${district} · ${cat}`, base, cat))
  }
  return cache.get(key)!
}

export function getAllCategorySeries(): TrendSeries[] {
  return CRIME_CATEGORIES.map(getCategorySeries)
}

/** Series whose most recent breach falls inside the alerting window. */
export function getActiveAlerts(withinWeeks = 10): { series: TrendSeries; at: number; index: number }[] {
  return getAllCategorySeries()
    .flatMap((s) =>
      s.breaches
        .filter((i) => i >= WEEKS - withinWeeks)
        .map((i) => ({ series: s, at: s.points[i].at, index: i })),
    )
    .sort((a, b) => b.at - a.at)
}

export const SERIES_WEEKS = WEEKS
