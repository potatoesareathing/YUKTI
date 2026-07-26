import { useEffect, useMemo, useState } from 'react'
import { Panel, Stat, Field, Tag, RiskPill, Empty } from '@/ui/primitives'
import { RankedBars, Sparkline } from '@/ui/charts'
import { useYukti } from '@/store/useYukti'
import { getDistrictMetrics, stateTotals } from '@/data/districts'
import { getCategorySeries } from '@/data/timeseries'
import { getStations, peekStations, type StationMetrics } from '@/data/stations'
import { CRIME_CATEGORIES } from '@/data/types'
import { compact, inr, delta, shortDate } from '@/lib/format'
import { riskBand, riskCss, BAND_LABEL, PALETTE } from '@/lib/palette'
import { pct } from '@/lib/format'

/**
 * MOD-01 — Advanced Visualisation & Geospatial Maps (§7.1).
 *
 * The map is the module; this is the apparatus around it. Panels float over the
 * canvas and pass pointer events through everywhere they are not, so the analyst
 * can still orbit and pick districts underneath.
 */

interface Props {
  ready: boolean
  onPick: (name: string | null) => void
}

export function M1Geospatial({ ready, onPick }: Props) {
  const selected = useYukti((s) => s.selectedDistrict)
  const categories = useYukti((s) => s.categories)
  const toggleCategory = useYukti((s) => s.toggleCategory)
  const resetCategories = useYukti((s) => s.resetCategories)
  const showHotspots = useYukti((s) => s.showHotspots)
  const showIncidents = useYukti((s) => s.showIncidents)
  const showLabels = useYukti((s) => s.showLabels)
  const toggleLayer = useYukti((s) => s.toggleLayer)
  const selectedStation = useYukti((s) => s.selectedStation)
  const selectStation = useYukti((s) => s.selectStation)
  const [stations, setStations] = useState<StationMetrics[]>([])

  useEffect(() => {
    let live = true
    getStations().then(() => {
      if (!live) return
      const all = peekStations()
      setStations(all)

      // ?district=<name>&station=<n> opens a tier directly.
      const params = new URLSearchParams(window.location.search)
      const d = params.get('district')
      if (d) {
        onPick(d)
        const raw = params.get('station')
        if (raw !== null && raw.trim() !== '') {
          const n = Number(raw)
          const inDistrict = all.filter((x) => x.district === d)
          if (Number.isInteger(n) && inDistrict[n]) {
            const id = inDistrict[n].id
            queueMicrotask(() => selectStation(id))
          }
        }
      }
    })
    return () => {
      live = false
    }
  }, [onPick, selectStation])

  const districts = useMemo(() => getDistrictMetrics(), [])
  const totals = useMemo(() => stateTotals(), [])
  const detail = selected ? districts.find((d) => d.name === selected) : null

  // Ranking honours the category filter, so the list always answers the
  // question the filter bar is currently asking.
  const ranked = useMemo(() => {
    const subset = (d: (typeof districts)[number]) =>
      categories.reduce((a, c) => a + d.byCategory[c], 0)
    return [...districts]
      .map((d) => ({
        key: d.name,
        label: d.name,
        value: subset(d),
        risk: d.riskNorm,
        flag: d.redZone,
      }))
      .sort((a, b) => b.value - a.value)
  }, [districts, categories])

  const districtStations = useMemo(
    () => (selected ? stations.filter((s) => s.district === selected) : []),
    [selected, stations],
  )
  const station = selectedStation
    ? districtStations.find((s) => s.id === selectedStation)
    : undefined

  const filtered = categories.length < CRIME_CATEGORIES.length

  return (
    <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[248px_1fr_302px]">
      {/* Left rail — filters and layers */}
      <div className="pointer-events-auto hidden min-h-0 flex-col gap-3 lg:flex">
        <Panel title="Crime category" reference="Filter" scroll>
          <div className="flex flex-wrap gap-1.5 p-3">
            {CRIME_CATEGORIES.map((c) => (
              <Tag key={c} active={categories.includes(c)} onClick={() => toggleCategory(c)}>
                {c}
              </Tag>
            ))}
          </div>
          {filtered && (
            <div className="border-t border-rule px-3 py-2">
              <button className="label transition-colors hover:text-brass" onClick={resetCategories}>
                Show all categories
              </button>
            </div>
          )}
        </Panel>

        <Panel title="Layers" reference="View">
          <div className="flex flex-col gap-1 p-3">
            <LayerToggle
              on={showHotspots}
              onClick={() => toggleLayer('showHotspots')}
              label="Density surface"
              note="KDE · flattens relief"
            />
            <LayerToggle
              on={showIncidents}
              onClick={() => toggleLayer('showIncidents')}
              label="Incident records"
              note="Anomalies in red"
            />
            <LayerToggle
              on={showLabels}
              onClick={() => toggleLayer('showLabels')}
              label="District labels"
              note=""
            />
          </div>
        </Panel>

        <Panel title="Risk scale" reference="Legend">
          <div className="p-3">
            <div className="mb-1.5 flex h-2.5 overflow-hidden">
              {Array.from({ length: 28 }, (_, i) => i / 27).map((t) => (
                <span key={t} className="flex-1" style={{ background: riskCss(t) }} />
              ))}
            </div>
            <div className="flex justify-between">
              <span className="label" style={{ fontSize: 9 }}>
                Low
              </span>
              <span className="label" style={{ fontSize: 9 }}>
                Critical
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-rule pt-3">
              <span className="redzone-pulse" style={{ color: PALETTE.redzone }} aria-hidden>
                ▲
              </span>
              <span className="label" style={{ fontSize: 9 }}>
                Red zone — CUSUM breach
              </span>
            </div>
          </div>
        </Panel>
      </div>

      {/* Centre column stays empty: this is the map. */}
      <div aria-hidden />

      {/* Right rail — ranking and the selected district */}
      <div className="pointer-events-auto flex min-h-0 flex-col gap-3">
        {detail ? (
          <Panel
            title={detail.name}
            reference="Jurisdiction"
            ticked
            action={
              <button className="label transition-colors hover:text-brass" onClick={() => onPick(null)}>
                Clear
              </button>
            }
            scroll
          >
            <div className="p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <Stat label="Incidents · 180d" value={inr(detail.incidents)} size="lg" />
                <RiskPill score={detail.riskNorm} band={BAND_LABEL[riskBand(detail.riskNorm)]} />
              </div>

              <div className="mb-3">
                <Field name="Rate / 100k">{inr(detail.rate)}</Field>
                <Field name="Population">{inr(detail.population)}</Field>
                <Field name="Police stations">{detail.stations}</Field>
                <Field name="Urban">{detail.urbanPct}%</Field>
                <Field name="Literacy">{detail.literacyPct}%</Field>
                <Field name="Clearance">{detail.clearancePct}%</Field>
                <Field name="Period change">
                  <span style={{ color: detail.trend > 0 ? PALETTE.redzone : PALETTE.bhuvan }}>
                    {delta(detail.trend)}
                  </span>
                </Field>
              </div>

              <div className="label mb-2">Category mix</div>
              <RankedBars
                rows={CRIME_CATEGORIES.map((c) => ({
                  key: c,
                  label: c,
                  value: detail.byCategory[c],
                }))
                  .sort((a, b) => b.value - a.value)
                  .slice(0, 5)}
                format={compact}
              />
            </div>
          </Panel>
        ) : (
          <Panel title="State overview" reference="Karnataka">
            <div className="grid grid-cols-2 gap-3 p-3">
              <Stat label="Records · 180d" value={compact(totals.incidents)} />
              <Stat label="Police stations" value={inr(totals.stations)} />
              <Stat label="Avg clearance" value={`${totals.avgClearance}%`} tone="cool" />
              <Stat
                label="Red zones"
                value={String(totals.redZones)}
                tone={totals.redZones ? 'alert' : 'default'}
                sub="CUSUM breach"
              />
            </div>
            <div className="border-t border-rule px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label">State trend · property crime</span>
                <Sparkline
                  values={getCategorySeries('Property Crime').points.map((p) => p.value)}
                  width={110}
                />
              </div>
            </div>
          </Panel>
        )}

        {selected ? (
          <Panel
            title={station ? station.name : 'Police stations'}
            reference={station ? 'Station' : `${districtStations.length} in ${selected}`}
            scroll
            className="min-h-0 flex-1"
            action={
              station ? (
                <button
                  className="label transition-colors hover:text-brass"
                  onClick={() => selectStation(null)}
                >
                  All stations
                </button>
              ) : null
            }
          >
            {station ? (
              <div className="p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <Stat
                    label="Records · estimated"
                    value={`~${compact(station.estimated)}`}
                    size="lg"
                    sub={`${pct(station.share)} of ${station.district}`}
                  />
                  {station.anomalies > 0 && (
                    <Stat label="Anomalies" value={String(station.anomalies)} tone="alert" size="sm" />
                  )}
                </div>

                <Field name="Predominant">{station.topCategory}</Field>
                <Field name="Sampled records">{station.sampled}</Field>
                <Field name="Most recent">{shortDate(new Date(station.lastAt))}</Field>

                <div className="label mb-2 mt-3">Category mix</div>
                <RankedBars
                  rows={CRIME_CATEGORIES.map((c) => ({
                    key: c,
                    label: c,
                    value: station.byCategory[c],
                  }))
                    .filter((r) => r.value > 0)
                    .sort((a, b) => b.value - a.value)
                    .slice(0, 5)}
                  format={(n) => String(n)}
                />

                <p className="mt-3 border-l border-brass/40 pl-3 text-[0.72rem] leading-relaxed text-khaki-dim">
                  Station figures are estimated: the station's share of the district's sampled
                  records applied to the district total. Position is the centre of its recorded
                  activity, not the address of the building.
                </p>
              </div>
            ) : (
              <RankedBars
                rows={districtStations.map((s) => ({
                  key: s.id,
                  label: s.name,
                  value: s.estimated,
                }))}
                format={(n) => `~${compact(n)}`}
                onSelect={(k) => selectStation(k === selectedStation ? null : k)}
                selected={selectedStation}
              />
            )}
          </Panel>
        ) : (
          <Panel
            title={filtered ? 'Ranked · filtered' : 'Ranked by volume'}
            reference={`${ranked.length} districts`}
            scroll
            className="min-h-0 flex-1"
          >
            {ready ? (
              <RankedBars
                rows={ranked}
                colorBy="risk"
                format={compact}
                onSelect={(k) => onPick(k === selected ? null : k)}
                selected={selected}
              />
            ) : (
              <Empty>Waiting for district boundaries.</Empty>
            )}
          </Panel>
        )}
      </div>
    </div>
  )
}

function LayerToggle({
  on,
  onClick,
  label,
  note,
}: {
  on: boolean
  onClick: () => void
  label: string
  note: string
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="flex items-center gap-2.5 px-1 py-1.5 text-left transition-colors hover:bg-brass/[0.06]"
    >
      <span
        className="flex h-3 w-3 shrink-0 items-center justify-center border"
        style={{ borderColor: on ? PALETTE.brass : PALETTE.rule2 }}
        aria-hidden
      >
        {on && <span style={{ width: 5, height: 5, background: PALETTE.brass }} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[0.8rem]" style={{ color: on ? PALETTE.khaki : PALETTE.khakiDim }}>
          {label}
        </span>
        {note && (
          <span className="label block" style={{ fontSize: 9 }}>
            {note}
          </span>
        )}
      </span>
    </button>
  )
}
