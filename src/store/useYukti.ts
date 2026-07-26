import { create } from 'zustand'
import { CRIME_CATEGORIES, type CrimeCategory, type Evidence } from '@/data/types'
import { NOW, PERIOD_DAYS } from '@/data/districts'

export type ModuleId = 'MOD-01' | 'MOD-02' | 'MOD-03' | 'MOD-04' | 'MOD-05' | 'MOD-06'

/** What the 3D scene is currently showing. The landing acts drive this too. */
export type SceneMode = 'state' | 'hotspot' | 'network'

export interface EvidenceContext {
  title: string
  subtitle: string
  items: Evidence[]
}

interface YuktiState {
  /* Scene */
  mode: SceneMode
  setMode: (m: SceneMode) => void

  /* Selection */
  hoveredDistrict: string | null
  selectedDistrict: string | null
  setHoveredDistrict: (d: string | null) => void
  selectDistrict: (d: string | null) => void

  /** MOD-01's third drill-down tier: a police station inside a district. */
  selectedStation: string | null
  selectStation: (id: string | null) => void

  selectedNode: string | null
  selectNode: (id: string | null) => void

  /**
   * MOD-02 path finding. Two explicit endpoints — naming them `from` and `to`
   * rather than reusing "origin" keeps them distinct from `selectedNode`, which
   * is simply whatever the analyst last clicked.
   */
  pathFrom: string | null
  pathTo: string | null
  setPathFrom: (id: string | null) => void
  setPathTo: (id: string | null) => void
  clearPath: () => void

  /*
   * Crime-category filter. Currently read only by MOD-01.
   *
   * This once claimed to be shared across every module. It is not: MOD-04 has
   * its own single-category selector and ignores this entirely, so a filter set
   * on the map does not follow the analyst to the trend view. Left here as the
   * intended home for a shared filter, but do not rely on it being applied
   * anywhere except MOD-01 until the other modules actually read it.
   */
  categories: CrimeCategory[]
  toggleCategory: (c: CrimeCategory) => void
  setCategories: (c: CrimeCategory[]) => void
  resetCategories: () => void

  /** Time window as a 0..1 fraction of the 180-day period. */
  timeWindow: [number, number]
  setTimeWindow: (w: [number, number]) => void
  timeRangeMs: () => [number, number]

  /** Time-sweep playhead, 0..1. Drives the Act I sweep and MOD-01 playback. */
  playhead: number
  setPlayhead: (t: number) => void
  playing: boolean
  setPlaying: (p: boolean) => void

  /* Layers */
  showHotspots: boolean
  showIncidents: boolean
  showLabels: boolean
  showPredicted: boolean
  toggleLayer: (k: 'showHotspots' | 'showIncidents' | 'showLabels' | 'showPredicted') => void

  /* Evidence drawer — the §10.3 affordance */
  evidence: EvidenceContext | null
  openEvidence: (e: EvidenceContext) => void
  closeEvidence: () => void

  /* Live coordinate readout, written by the 3D camera each frame */
  readout: { lon: number; lat: number; alt: number }
  setReadout: (r: { lon: number; lat: number; alt: number }) => void
}

export const useYukti = create<YuktiState>((set, get) => ({
  mode: 'state',
  setMode: (mode) => set({ mode }),

  hoveredDistrict: null,
  selectedDistrict: null,
  setHoveredDistrict: (hoveredDistrict) => set({ hoveredDistrict }),
  // Changing district invalidates any station selection inside the old one.
  selectDistrict: (selectedDistrict) => set({ selectedDistrict, selectedStation: null }),

  selectedStation: null,
  selectStation: (selectedStation) => set({ selectedStation }),

  selectedNode: null,
  selectNode: (selectedNode) => set({ selectedNode }),

  pathFrom: null,
  pathTo: null,
  setPathFrom: (pathFrom) => set({ pathFrom }),
  setPathTo: (pathTo) => set({ pathTo }),
  clearPath: () => set({ pathFrom: null, pathTo: null }),

  categories: [...CRIME_CATEGORIES],
  toggleCategory: (c) =>
    set((s) => {
      const has = s.categories.includes(c)
      // Never allow an empty selection — an empty map reads as "no data" rather
      // than "no filter", and analysts lose their place.
      if (has && s.categories.length === 1) return s
      return { categories: has ? s.categories.filter((x) => x !== c) : [...s.categories, c] }
    }),
  setCategories: (categories) => set({ categories }),
  resetCategories: () => set({ categories: [...CRIME_CATEGORIES] }),

  timeWindow: [0, 1],
  setTimeWindow: (timeWindow) => set({ timeWindow }),
  timeRangeMs: () => {
    const [a, b] = get().timeWindow
    const span = PERIOD_DAYS * 864e5
    return [NOW - span + a * span, NOW - span + b * span]
  },

  playhead: 1,
  setPlayhead: (playhead) => set({ playhead }),
  playing: false,
  setPlaying: (playing) => set({ playing }),

  showHotspots: true,
  showIncidents: true,
  showLabels: true,
  showPredicted: false,
  toggleLayer: (k) => set((s) => ({ [k]: !s[k] }) as Pick<YuktiState, typeof k>),

  evidence: null,
  openEvidence: (evidence) => set({ evidence }),
  closeEvidence: () => set({ evidence: null }),

  readout: { lon: 76.3, lat: 15.0, alt: 0 },
  setReadout: (readout) => set({ readout }),
}))

/** Respect the OS motion preference everywhere, including inside the 3D scene. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
