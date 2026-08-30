import type { ModuleId } from '@/store/useYukti'

/**
 * The six modules of §3.1, with their document references.
 *
 * Kannada names are not decoration: §13 makes bilingual Kannada/English support
 * a non-functional requirement for the dashboards, and navigation is the first
 * place that has to hold.
 */
export interface ModuleMeta {
  id: ModuleId
  short: string
  name: string
  kannada: string
  purpose: string
  /** Whether this module drives the shared 3D scene. */
  scene: 'map' | 'graph' | 'none'
}

export const MODULES: ModuleMeta[] = [
  {
    id: 'MOD-01',
    short: 'Geospatial',
    name: 'Advanced Visualisation & Geospatial Maps',
    kannada: 'ಭೂಪ್ರಾದೇಶಿಕ',
    purpose: 'District and station drill-down, spatiotemporal hotspots, emerging-trend alerts.',
    scene: 'map',
  },
  {
    id: 'MOD-02',
    short: 'Network',
    name: 'Criminological Network & Link Analysis',
    kannada: 'ಜಾಲ ವಿಶ್ಲೇಷಣೆ',
    purpose: 'Node-based relationship mapping, repeat-offender tracking, hidden associations.',
    scene: 'graph',
  },
  {
    id: 'MOD-03',
    short: 'Predictive',
    name: 'Sociological & AI-Driven Predictive Dashboards',
    kannada: 'ಮುನ್ಸೂಚನೆ',
    purpose: 'Socio-economic overlays, predictive risk scoring, anomaly call-outs.',
    scene: 'none',
  },
  {
    id: 'MOD-04',
    short: 'Trends',
    name: 'Pattern & Trend Discovery',
    kannada: 'ಪ್ರವೃತ್ತಿ',
    purpose: 'Statistical spatial and temporal analytics for resource deployment.',
    scene: 'none',
  },
  {
    id: 'MOD-05',
    short: 'Behaviour',
    name: 'Network & Behavioural Analysis',
    kannada: 'ವರ್ತನೆ',
    purpose: 'Suspect-network detection and recurring modus-operandi identification.',
    scene: 'none',
  },
  {
    id: 'MOD-06',
    short: 'Intelligence',
    name: 'AI/ML-Driven Intelligence',
    kannada: 'ಗುಪ್ತಚರ',
    purpose: 'Model portfolio, anomaly queue, hidden-correlation discovery.',
    scene: 'none',
  },
  {
    id: 'MOD-07',
    short: 'Persons',
    name: 'Person Intelligence & Alerts',
    kannada: 'ವ್ಯಕ್ತಿ ಬುದ್ಧಿ',
    purpose: 'Documented person profiles, investigation relevance, potential-match alerts.',
    scene: 'none',
  },
]

export const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]))

/** Route slug ↔ module id. `/platform/network` reads better than `/platform/MOD-02`. */
export const SLUG_BY_ID: Record<ModuleId, string> = {
  'MOD-01': 'geospatial',
  'MOD-02': 'network',
  'MOD-03': 'predictive',
  'MOD-04': 'trends',
  'MOD-05': 'behaviour',
  'MOD-06': 'intelligence',
  'MOD-07': 'persons',
}

export const ID_BY_SLUG: Record<string, ModuleId> = Object.fromEntries(
  Object.entries(SLUG_BY_ID).map(([id, slug]) => [slug, id as ModuleId]),
) as Record<string, ModuleId>
