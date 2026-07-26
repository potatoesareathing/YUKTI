import { getDistrictMetrics, volumeScale } from '@/data/api'
import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import type { DistrictFeature } from '@/lib/geo'
import { riskCss } from '@/lib/palette'
import { compact } from '@/lib/format'
import { useYukti } from '@/store/useYukti'

/**
 * District labels, drawn as DOM so they use the platform's actual typography
 * rather than a texture atlas approximation of it.
 *
 * Only a handful are shown at rest. Thirty labels over a state this shape
 * overlap into noise around the Bengaluru cluster, so the default is the largest
 * few plus whatever the analyst is pointing at.
 */

const MAX_HEIGHT = 14
const MIN_HEIGHT = 0.7

interface DistrictLabelsProps {
  features: DistrictFeature[]
  /** How many of the highest-volume districts stay labelled at rest. */
  topN?: number
  opacity?: number
}

export function DistrictLabels({ features, topN = 6, opacity = 1 }: DistrictLabelsProps) {
  const hovered = useYukti((s) => s.hoveredDistrict)
  const selected = useYukti((s) => s.selectedDistrict)
  const showLabels = useYukti((s) => s.showLabels)

  const items = useMemo(() => {
    const metrics = getDistrictMetrics()
    const scale = volumeScale()
    const byName = new Map(metrics.map((m) => [m.name, m]))
    const ranked = [...metrics].sort((a, b) => b.incidents - a.incidents)
    const top = new Set(ranked.slice(0, topN).map((m) => m.name))

    return features.map((f) => {
      const m = byName.get(f.name)
      return {
        name: f.name,
        world: f.world,
        height: MIN_HEIGHT + scale(m?.incidents ?? 0) * MAX_HEIGHT,
        incidents: m?.incidents ?? 0,
        risk: m?.riskNorm ?? 0,
        redZone: m?.redZone ?? false,
        isTop: top.has(f.name),
      }
    })
  }, [features, topN])

  if (!showLabels) return null

  return (
    <>
      {items.map((d) => {
        const active = hovered === d.name || selected === d.name
        if (!active && !d.isTop) return null
        if (selected && selected !== d.name && !d.isTop) return null

        return (
          <Html
            key={d.name}
            position={[d.world[0], d.height + 2.4, d.world[1]]}
            center
            distanceFactor={104}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none', opacity: active ? opacity : opacity * 0.72 }}
          >
            <div
              className="flex flex-col items-center gap-0.5 select-none whitespace-nowrap"
              style={{ transform: 'translateY(-4px)' }}
            >
              <div
                className="h-4 w-px"
                style={{ background: active ? '#F0D072' : '#8A701A' }}
                aria-hidden
              />
              <div
                className="px-1.5 py-0.5 border"
                style={{
                  background: 'rgba(7,10,15,0.82)',
                  borderColor: active ? '#C9A227' : '#1E2A38',
                }}
              >
                <div
                  className="font-medium"
                  style={{
                    fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    color: active ? '#F0D072' : '#DCD3BE',
                  }}
                >
                  {d.name.toUpperCase()}
                </div>
                <div
                  className="flex items-center gap-1.5"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9 }}
                >
                  <span style={{ color: riskCss(d.risk) }}>{compact(d.incidents)}</span>
                  {d.redZone && <span style={{ color: '#FF3B2F' }}>▲</span>}
                </div>
              </div>
            </div>
          </Html>
        )
      })}
    </>
  )
}
