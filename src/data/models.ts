import { seeded, randRange, gaussian } from '@/lib/rng'
import { NOW } from './districts'
import type { ModelCard } from './types'

/**
 * The model portfolio, transcribed from §8 of the technical solution document.
 *
 * Purpose, algorithm family and input→output are the document's own text — these
 * are commitments the data-science team has made, not invented content. Only
 * the operational figures (version, metric, drift, last-trained) are synthetic,
 * standing in for what the MLflow registry in §5.4 would report.
 */

interface Seed {
  id: string
  name: string
  purpose: string
  family: string
  io: string
  metricLabel: string
  metricRange: [number, number]
  module: string
}

const SEEDS: Seed[] = [
  {
    id: 'hotspot-kde',
    name: 'Spatiotemporal hotspot detection',
    purpose: 'Identify crime hotspots by place & time',
    family: 'Kernel Density Estimation, ST-DBSCAN',
    io: 'Geo-tagged incidents → hotspot polygons / heat layers',
    metricLabel: 'Silhouette',
    metricRange: [0.58, 0.71],
    module: 'MOD-01 / MOD-04',
  },
  {
    id: 'trend-cusum',
    name: 'Trend / spike detection',
    purpose: 'Flag categories spiking vs. historical baseline',
    family: 'STL decomposition + CUSUM/EWMA',
    io: 'Category time series → alert triggers',
    metricLabel: 'Precision',
    metricRange: [0.79, 0.88],
    module: 'MOD-04',
  },
  {
    id: 'risk-gbm',
    name: 'Predictive risk scoring',
    purpose: 'Forecast high-risk areas / typologies',
    family: 'Gradient boosting (XGBoost/LightGBM)',
    io: 'Historical incidents + socio-economic features → risk score per jurisdiction',
    metricLabel: 'AUC-ROC',
    metricRange: [0.74, 0.83],
    module: 'MOD-03',
  },
  {
    id: 'anomaly-iforest',
    name: 'Anomaly detection',
    purpose: 'Detect incidents deviating from behavioural norms',
    family: 'Isolation Forest, autoencoders',
    io: 'Incident feature vectors → anomaly flags',
    metricLabel: 'Recall',
    metricRange: [0.66, 0.78],
    module: 'MOD-03 / MOD-06',
  },
  {
    id: 'mo-similarity',
    name: 'MO similarity / repeat-offender linking',
    purpose: 'Link incidents to the same offender via MO pattern',
    family: 'TF-IDF/embedding similarity + clustering',
    io: 'FIR text + MO tags → similarity scores / clusters',
    metricLabel: 'Top-5 accuracy',
    metricRange: [0.61, 0.74],
    module: 'MOD-05',
  },
  {
    id: 'nlp-ner',
    name: 'NLP entity extraction',
    purpose: 'Extract names, locations, weapons, vehicles from free text',
    family: 'Transformer-based NER (Kannada + English)',
    io: 'FIR narrative text → structured entity records',
    metricLabel: 'F1',
    metricRange: [0.81, 0.9],
    module: 'MOD-06',
  },
  {
    id: 'community-louvain',
    name: 'Community detection',
    purpose: 'Reveal organised-crime clusters',
    family: 'Louvain / Leiden, centrality measures',
    io: 'Suspect-victim-location graph → communities, key nodes',
    metricLabel: 'Modularity',
    metricRange: [0.52, 0.68],
    module: 'MOD-02 / MOD-05',
  },
  {
    id: 'link-graphsage',
    name: 'Link prediction',
    purpose: 'Suggest probable hidden associations',
    family: 'Graph neural networks (e.g. GraphSAGE)',
    io: 'Graph structure + node features → ranked probable links',
    metricLabel: 'AUC',
    metricRange: [0.69, 0.79],
    module: 'MOD-02',
  },
]

/** Most of a deployed portfolio is serving; a minority is mid-lifecycle. */
const STATUSES: ModelCard['status'][] = [
  'Serving', 'Serving', 'Serving', 'Serving', 'Serving', 'Serving',
  'Retraining', 'Validation', 'Registered',
]

function build(): ModelCard[] {
  return SEEDS.map((s, i) => {
    const r = seeded(`model:${s.id}`)
    return {
      id: s.id,
      name: s.name,
      purpose: s.purpose,
      family: s.family,
      io: s.io,
      // §8: retrained on a fixed quarterly schedule.
      status: STATUSES[Math.floor(r() * STATUSES.length)],
      version: `v${1 + Math.floor(r() * 3)}.${Math.floor(r() * 9)}.${Math.floor(r() * 5)}`,
      metricLabel: s.metricLabel,
      metric: randRange(r, s.metricRange[0], s.metricRange[1]),
      drift: Math.abs(gaussian(r, 0.022, 0.019)),
      lastTrained: NOW - (14 + i * 9 + Math.floor(r() * 30)) * 864e5,
      module: s.module,
    }
  })
}

let cached: ModelCard[] | null = null

export function getModelCards(): ModelCard[] {
  if (!cached) cached = build()
  return cached
}

/** Drift beyond this is where §8's "material change reviewed before redeployment" bites. */
export const DRIFT_THRESHOLD = 0.05
