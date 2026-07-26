import { getActiveAlerts, getCategorySeries, getDistrictMetrics, getDistrictSeries } from '@/data/api'
import { useMemo, useState } from 'react'
import { Panel, Stat, Tag, DecisionSupportNote } from '@/ui/primitives'
import { StlChart, Sparkline, RankedBars } from '@/ui/charts'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { useYukti } from '@/store/useYukti'
import { CRIME_CATEGORIES, type CrimeCategory } from '@/data/types'
import { PALETTE } from '@/lib/palette'
import { compact, monthLabel, shortDate } from '@/lib/format'

/**
 * MOD-04 — Pattern & Trend Discovery (§7.4).
 *
 * The decomposition is the argument. Raw weekly counts wander for reasons that
 * have nothing to do with policing — festival season, monsoon, the annual cycle
 * of a category — and eyeballing a raw line produces alarm about seasonality.
 * Separating trend and seasonal out leaves a residual, and it is the residual
 * that CUSUM watches. Every red-zone flag in the platform traces back to a
 * breach on that bottom panel.
 */
export function M4Trends() {
  const selectedDistrict = useYukti((s) => s.selectedDistrict)
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const [category, setCategory] = useState<CrimeCategory>('Property Crime')
  const openEvidence = useEvidence()

  const series = useMemo(
    () => (selectedDistrict ? getDistrictSeries(selectedDistrict, category) : getCategorySeries(category)),
    [selectedDistrict, category],
  )

  const alerts = useMemo(() => getActiveAlerts(12), [])
  const districts = useMemo(() => getDistrictMetrics(), [])

  const latest = series.points[series.points.length - 1]
  const prior = series.points[series.points.length - 14] ?? series.points[0]
  const change = prior.value ? (latest.value - prior.value) / prior.value : 0

  const redZones = useMemo(() => districts.filter((d) => d.redZone), [districts])

  return (
    <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-3">
        <Panel
          title={selectedDistrict ? `${selectedDistrict} · ${category}` : `Karnataka · ${category}`}
          reference="STL + CUSUM"
          ticked
          action={
            selectedDistrict ? (
              <button className="label transition-colors hover:text-brass" onClick={() => selectDistrict(null)}>
                State-wide
              </button>
            ) : null
          }
        >
          <div className="flex flex-wrap gap-1.5 border-b border-rule p-3">
            {CRIME_CATEGORIES.map((c) => (
              <Tag key={c} active={c === category} onClick={() => setCategory(c)}>
                {c}
              </Tag>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4 border-b border-rule p-3 sm:grid-cols-4">
            <Stat label="Latest week" value={latest.value.toFixed(0)} />
            <Stat
              label="vs 13 weeks ago"
              value={`${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`}
              tone={change > 0.08 ? 'alert' : 'default'}
            />
            <Stat
              label="Breaches"
              value={String(series.breaches.length)}
              tone={series.breaches.length ? 'alert' : 'default'}
              sub="Over 104 weeks"
            />
            <Stat label="Control limit" value={`±${series.controlLimit.toFixed(1)}`} sub="CUSUM h = 4.2σ" />
          </div>

          <StlChart series={series} />
        </Panel>

        <Panel title="How this works" reference="SEC 7.4">
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
            <Step
              n="Decompose"
              body="STL separates the weekly series into a Loess-smoothed trend, an annual seasonal cycle, and the residual left over."
            />
            <Step
              n="Monitor"
              body="A two-sided tabular CUSUM accumulates the residual against a slack of 0.5σ, signalling when it exceeds a decision interval of 4.2σ."
            />
            <Step
              n="Flag"
              body="A signal marks a red zone only when relative risk for that jurisdiction is also elevated — a busy district does not sit permanently in alarm."
            />
          </div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="Active alerts" reference="Last 12 weeks">
          {alerts.length ? (
            <ul className="divide-y divide-rule/50">
              {alerts.slice(0, 8).map((a) => (
                <li key={`${a.series.key}-${a.index}`}>
                  <button
                    onClick={() => {
                      const cat = a.series.label as CrimeCategory
                      if (CRIME_CATEGORIES.includes(cat)) setCategory(cat)
                      openEvidence({
                        title: `${a.series.label} — control-limit breach`,
                        subtitle: `Signalled ${shortDate(new Date(a.at))} · CUSUM on STL residual`,
                        items: [
                          {
                            kind: 'series',
                            ref: a.series.key,
                            label: a.series.label,
                            detail: `Residual at signal ${a.series.points[a.index].residual.toFixed(2)} against a control limit of ±${a.series.controlLimit.toFixed(2)}.`,
                          },
                          {
                            kind: 'feature',
                            ref: `${a.series.key}:params`,
                            label: 'Detector parameters',
                            detail: 'Two-sided tabular CUSUM, slack k = 0.5σ, decision interval h = 4.2σ, reset on signal.',
                          },
                          {
                            kind: 'feature',
                            ref: `${a.series.key}:window`,
                            label: 'Baseline',
                            detail: `104 weeks to ${monthLabel(new Date(a.series.points[a.series.points.length - 1].at))}.`,
                          },
                        ],
                      })
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brass/[0.06]"
                  >
                    <span className="redzone-pulse shrink-0" style={{ color: PALETTE.redzone }} aria-hidden>
                      ▲
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8rem] text-khaki">{a.series.label}</span>
                      <span className="label block" style={{ fontSize: 9 }}>
                        Signalled {shortDate(new Date(a.at))}
                      </span>
                    </span>
                    <Sparkline
                      values={a.series.points.slice(-26).map((p) => p.residual)}
                      width={54}
                      height={18}
                      color={PALETTE.redzone}
                      showLast={false}
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <p className="text-[0.82rem] leading-relaxed text-khaki-dim">
                No category has breached its control limit in the last 12 weeks.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Red-zone districts" reference={`${redZones.length} active`} scroll>
          {redZones.length ? (
            <RankedBars
              rows={redZones
                .map((d) => ({
                  key: d.name,
                  label: d.name,
                  value: Math.round(d.trend * 1000) / 10,
                  risk: d.riskNorm,
                  flag: true,
                }))
                .sort((a, b) => b.value - a.value)}
              colorBy="risk"
              format={(n) => `+${n.toFixed(1)}%`}
              onSelect={(k) => selectDistrict(k === selectedDistrict ? null : k)}
              selected={selectedDistrict}
            />
          ) : (
            <div className="p-4">
              <p className="text-[0.82rem] text-khaki-dim">No districts currently in red zone.</p>
            </div>
          )}
          <div className="border-t border-rule p-3">
            <DecisionSupportNote>
              A red zone directs attention and resourcing. It is not a finding about any individual,
              and it does not on its own justify action against one.
            </DecisionSupportNote>
          </div>
        </Panel>

        <Panel title="Category volumes" reference="180-day">
          <RankedBars
            rows={CRIME_CATEGORIES.map((c) => ({
              key: c,
              label: c,
              value: districts.reduce((a, d) => a + d.byCategory[c], 0),
            })).sort((a, b) => b.value - a.value)}
            format={compact}
            onSelect={(k) => setCategory(k as CrimeCategory)}
            selected={category}
          />
        </Panel>
      </div>
    </div>
  )
}

function Step({ n, body }: { n: string; body: string }) {
  return (
    <div>
      <div className="label-brass mb-2">{n}</div>
      <p className="text-[0.82rem] leading-relaxed text-khaki-dim">{body}</p>
    </div>
  )
}
