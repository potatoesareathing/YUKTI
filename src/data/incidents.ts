import { loadDistricts, samplePointInDistrict, toWorldXZ, type DistrictFeature } from '@/lib/geo'
import { gaussian, pick, pickWeighted, seeded, type Rng } from '@/lib/rng'
import { docket } from '@/lib/format'
import { getDistrictMetrics, NOW, PERIOD_DAYS } from './districts'
import { CRIME_CATEGORIES, type CaseStatus, type CrimeCategory, type Incident, type ModusOperandi } from './types'

/**
 * A representative sample of geo-tagged incident records.
 *
 * The platform reports state-wide totals from district aggregates; this file
 * generates the individual records the map, the hotspot layer and the evidence
 * drawer actually draw. It is a SAMPLE — roughly 4,200 records standing in for
 * the full period — because rendering every record as a point would say nothing
 * a density surface does not say better, at ten times the cost.
 *
 * Records cluster around a small number of per-district cores rather than
 * spreading evenly, so the KDE / ST-DBSCAN layer in §7.4 has genuine structure
 * to find instead of uniform noise.
 */

const SAMPLE_SIZE = 4200

const STATION_SUFFIX = [
  'Town', 'Rural', 'North', 'South', 'East', 'West', 'Market', 'Extension',
  'Cantonment', 'Industrial Area', 'Lake Road', 'Old Town',
]

/**
 * Modus-operandi signatures.
 *
 * MO features are NOT sampled independently. Drawing entry, target and tools
 * from three flat lists produces every combination in roughly equal numbers
 * everywhere, which means MO clustering finds hundreds of clusters that all span
 * the whole state — the exact opposite of the finding §7.5 describes. A real
 * signature is a specific, repeated combination that shows up in a few places.
 *
 * So incidents pick a whole signature, and each district weights the signature
 * pool differently. Some signatures stay local; a few travel. Those travelling
 * ones are what MOD-05 is built to surface.
 */
interface MoSignature {
  id: string
  entry: string
  target: string
  tools: string
  /** Preferred offence window; individual records still vary around it. */
  window: string
  /** Cyber signatures apply to fraud categories, physical ones to the rest. */
  cyber: boolean
}

const SIGNATURES: MoSignature[] = [
  { id: 'sig-01', entry: 'Forced door', target: 'Residence — locked', tools: 'Crowbar', window: '0000–0400', cyber: false },
  { id: 'sig-02', entry: 'Window latch', target: 'Residence — locked', tools: 'Screwdriver', window: '1200–1600', cyber: false },
  { id: 'sig-03', entry: 'Shutter cut', target: 'Retail premises', tools: 'Bolt cutter', window: '0000–0400', cyber: false },
  { id: 'sig-04', entry: 'Duplicate key', target: 'Two-wheeler', tools: 'Duplicate key', window: '2000–0000', cyber: false },
  { id: 'sig-05', entry: 'Open premises', target: 'Two-wheeler', tools: 'None recorded', window: '0800–1200', cyber: false },
  { id: 'sig-06', entry: 'Roof access', target: 'Warehouse', tools: 'Bolt cutter', window: '0000–0400', cyber: false },
  { id: 'sig-07', entry: 'Ventilator', target: 'Retail premises', tools: 'Crowbar', window: '0400–0800', cyber: false },
  { id: 'sig-08', entry: 'Open premises', target: 'Individual — street', tools: 'Sharp weapon', window: '2000–0000', cyber: false },
  { id: 'sig-09', entry: 'Open premises', target: 'Individual — street', tools: 'Chemical spray', window: '1600–2000', cyber: false },
  { id: 'sig-10', entry: 'Duplicate key', target: 'Four-wheeler', tools: 'Duplicate key', window: '0000–0400', cyber: false },
  { id: 'sig-11', entry: 'Forced door', target: 'ATM kiosk', tools: 'Crowbar', window: '0000–0400', cyber: false },
  { id: 'sig-12', entry: 'Open premises', target: 'Warehouse', tools: 'None recorded', window: '1200–1600', cyber: false },

  { id: 'sig-20', entry: 'Impersonation — bank official', target: 'Bank account', tools: 'OTP capture', window: '0800–1200', cyber: true },
  { id: 'sig-21', entry: 'KYC update demand', target: 'Bank account', tools: 'Remote-access app', window: '1200–1600', cyber: true },
  { id: 'sig-22', entry: 'Investment portal', target: 'UPI wallet', tools: 'Fake portal', window: '1600–2000', cyber: true },
  { id: 'sig-23', entry: 'Job offer', target: 'UPI wallet', tools: 'Phishing link', window: '1200–1600', cyber: true },
  { id: 'sig-24', entry: 'Parcel / customs call', target: 'Credit card', tools: 'OTP capture', window: '0800–1200', cyber: true },
  { id: 'sig-25', entry: 'Impersonation — police', target: 'Bank account', tools: 'Remote-access app', window: '1600–2000', cyber: true },
  { id: 'sig-26', entry: 'Loan application', target: 'Merchant account', tools: 'Phishing link', window: '2000–0000', cyber: true },
  { id: 'sig-27', entry: 'SIM replacement', target: 'Bank account', tools: 'SIM swap', window: '0400–0800', cyber: true },
]

const TIMING = ['0000–0400', '0400–0800', '0800–1200', '1200–1600', '1600–2000', '2000–0000']

/**
 * Per-district preference over the signature pool.
 *
 * A handful of signatures are heavily weighted in each district — its local
 * pattern — and the rest sit at a low floor so nothing is impossible anywhere.
 * The floor is what lets a signature genuinely travel.
 */
function signatureWeights(district: string, cyber: boolean): { pool: MoSignature[]; weights: number[] } {
  const pool = SIGNATURES.filter((s) => s.cyber === cyber)
  const r = seeded(`mo:${district}:${cyber}`)
  const favoured = new Set<number>()
  while (favoured.size < Math.min(3, pool.length)) favoured.add(Math.floor(r() * pool.length))
  // The floor has to be genuinely low. At a floor of 0.5 against ~12 signatures,
  // every signature still lands a few times in every district, and MO clustering
  // reports that all twenty patterns are active state-wide — which is no finding
  // at all.
  return { pool, weights: pool.map((_, i) => (favoured.has(i) ? 9 + r() * 6 : 0.06 + r() * 0.14)) }
}

const OFFICER_RANK = ['PSI', 'ASI', 'PI', 'CPI']
const OFFICER_NAME = [
  'Shetty', 'Gowda', 'Patil', 'Hegde', 'Naik', 'Rao', 'Kulkarni', 'Desai',
  'Reddy', 'Nayak', 'Bhat', 'Kamath', 'Murthy', 'Shastri', 'Jadhav', 'Poojary',
]

const NARRATIVE: Record<CrimeCategory, string[]> = {
  'Body Offence': [
    'Altercation between known parties escalated; complainant sustained injuries and was shifted for treatment.',
    'Dispute over land boundary resulted in assault on the complainant near the village limits.',
  ],
  'Property Crime': [
    'House found broken into on return from travel; almirah forced and valuables removed.',
    'Commercial premises entered after business hours; shutter lock found cut.',
  ],
  'Vehicle Theft': [
    'Two-wheeler parked outside residence found missing next morning; no witnesses recorded.',
    'Vehicle removed from paid parking area; gate CCTV under retrieval.',
  ],
  'Cyber & Financial Fraud': [
    'Complainant received call impersonating bank official; OTP shared and account debited in three transfers.',
    'Investment portal advertised on social media collected deposits and ceased responding.',
  ],
  'Crime Against Women': [
    'Complaint registered under relevant sections; complainant statement recorded and support services notified.',
    'Harassment reported at workplace; internal committee record sought.',
  ],
  'Narcotics (NDPS)': [
    'Contraband recovered during routine vehicle check at the check post; sample sent to FSL.',
    'Acting on credible information, premises searched and prohibited substance seized.',
  ],
  'Public Order': [
    'Unlawful assembly obstructed traffic on the main road; dispersed without injury.',
    'Disturbance reported near commercial area during evening hours.',
  ],
  'Economic Offence': [
    'Chit fund operator collected subscriptions and failed to disburse on maturity.',
    'Forged documents presented for property transfer; registrar records under verification.',
  ],
}

const STATUS: CaseStatus[] = ['Under Investigation', 'Chargesheeted', 'Disposed', 'Untraced']
const STATUS_W = [0.42, 0.31, 0.18, 0.09]

function isCyber(category: CrimeCategory): boolean {
  return category === 'Cyber & Financial Fraud' || category === 'Economic Offence'
}

function makeMo(r: Rng, sig: MoSignature): ModusOperandi {
  return {
    entry: sig.entry,
    target: sig.target,
    // The window varies around the signature's preferred one — an offender has
    // habits, not a timetable — so the histogram in MOD-05 has a shape.
    timing: r() < 0.7 ? sig.window : pick(r, TIMING),
    tools: sig.tools,
  }
}

/**
 * Hotspot cores per district — more cores where there is more urban fabric.
 *
 * Each core doubles as a police station's territory. Naming stations at random
 * and scattering their incidents across the whole district gives every station
 * the same centroid, so on the map they stack into one pile and the
 * station-level drill-down has nothing to distinguish. A station owns a place.
 */
function makeCores(d: DistrictFeature, urbanPct: number, r: Rng): [number, number][] {
  const n = 2 + Math.floor(urbanPct / 22)
  return Array.from({ length: n }, () => samplePointInDistrict(d, r))
}

function build(features: DistrictFeature[]): Incident[] {
  const metrics = getDistrictMetrics()
  const byName = new Map(features.map((f) => [f.name, f]))
  const total = metrics.reduce((a, d) => a + d.incidents, 0)
  const out: Incident[] = []
  let serial = 1

  for (const m of metrics) {
    const feature = byName.get(m.name)
    if (!feature) continue

    const r = seeded(`incidents:${m.name}`)
    const count = Math.max(12, Math.round((m.incidents / total) * SAMPLE_SIZE))
    const cores = makeCores(feature, m.urbanPct, r)
    const coreWeights = cores.map(() => 0.4 + r())
    const catWeights = CRIME_CATEGORIES.map((c) => m.byCategory[c] + 1)
    const physical = signatureWeights(m.name, false)
    const cyber = signatureWeights(m.name, true)

    // Tighter scatter in dense districts — Bengaluru Urban's hotspots are
    // street-scale, Kodagu's are valley-scale.
    const spread = 0.055 + (1 - m.urbanPct / 100) * 0.16

    const coreIndex = cores.map((_, i) => i)
    const stationOf = cores.map(
      (_, i) => `${m.name.split(' ')[0]} ${STATION_SUFFIX[i % STATION_SUFFIX.length]}`,
    )

    for (let i = 0; i < count; i++) {
      const ci = pickWeighted(r, coreIndex, coreWeights)
      const core = cores[ci]
      const lon = core[0] + gaussian(r, 0, spread)
      const lat = core[1] + gaussian(r, 0, spread)
      const category = pickWeighted(r, CRIME_CATEGORIES, catWeights)

      // Recency-weighted: r()**0.7 biases toward the recent end of the window,
      // matching a rising reporting trend.
      const at = NOW - Math.pow(r(), 0.7) * PERIOD_DAYS * 864e5

      const bank = isCyber(category) ? cyber : physical
      const sig = pickWeighted(r, bank.pool, bank.weights)
      const anomalyScore = Math.min(0.99, Math.max(0, gaussian(r, 0.24, 0.19)))

      out.push({
        id: `INC-${serial}`,
        docket: docket('FIR', serial),
        category,
        district: m.name,
        station: stationOf[ci],
        lonLat: [lon, lat],
        world: toWorldXZ(lon, lat),
        at,
        status: pickWeighted(r, STATUS, STATUS_W),
        mo: makeMo(r, sig),
        narrative: pick(r, NARRATIVE[category]),
        officer: `${pick(r, OFFICER_RANK)} ${pick(r, OFFICER_NAME)}`,
        anomaly: anomalyScore > 0.72,
        anomalyScore,
      })
      serial++
    }
  }

  return out.sort((a, b) => a.at - b.at)
}

let cached: Incident[] | null = null

export async function getIncidents(): Promise<Incident[]> {
  if (!cached) cached = build(await loadDistricts())
  return cached
}




export const MO_VOCAB = {
  ENTRY: [...new Set(SIGNATURES.map((s) => s.entry))],
  TARGET: [...new Set(SIGNATURES.map((s) => s.target))],
  TOOLS: [...new Set(SIGNATURES.map((s) => s.tools))],
  TIMING,
}