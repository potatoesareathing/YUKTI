import { useEffect, useState } from 'react'
import { loadDistricts, type DistrictFeature } from '@/lib/geo'
import { getIncidents } from '@/data/incidents'
import type { Incident } from '@/data/types'

interface GeoState {
  features: DistrictFeature[]
  incidents: Incident[]
  ready: boolean
  error: string | null
}

/**
 * Loads boundaries and the incident sample once, then shares the result with
 * every scene that mounts. Both underlying loaders cache, so this is cheap on
 * repeat mounts — the cost is paid on the first act of the landing page and the
 * platform reuses it.
 */
export function useGeo(): GeoState {
  const [state, setState] = useState<GeoState>({
    features: [],
    incidents: [],
    ready: false,
    error: null,
  })

  useEffect(() => {
    let live = true
    Promise.all([loadDistricts(), getIncidents()])
      .then(([features, incidents]) => {
        if (live) setState({ features, incidents, ready: true, error: null })
      })
      .catch((err: unknown) => {
        if (!live) return
        const message = err instanceof Error ? err.message : 'Boundary data could not be loaded'
        setState({ features: [], incidents: [], ready: false, error: message })
      })
    return () => {
      live = false
    }
  }, [])

  return state
}
