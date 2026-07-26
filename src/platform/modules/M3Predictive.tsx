import { useEffect, useMemo, useState } from 'react'
import { Panel, Stat, Bar, RiskPill, DecisionSupportNote, Field } from '@/ui/primitives'
import { CorrelationScatter, RankedBars } from '@/ui/charts'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { useYukti } from '@/store/useYukti'
import { getRiskScores } from '@/data/api'
import { getDistrictMetrics } from '@/data/districts'
import { BAND_LABEL, PALETTE, riskCss } from '@/lib/palette'
import { delta, inr, pct } from '@/lib/format'
import type { RiskScore } from '@/data/types'

/**
 * MOD-03 — Sociological & AI-Driven Predictive Dashboards (§7.3).
 *
 * This is the module where the platform's central commitment has to be visible:
 * a score is never shown without its drivers and its evidence one click away.
 * The drivers are read back out of the same arithmetic that produced the score,
 * so what an investigator sees is the reason, not a plausible-sounding companion
 * to it.
 */

type Overlay = 'urbanPct' | 'literacyPct' | 'clearancePct'

const OVERLAY: Record<Overlay, { label: string; axis: string }> = {
  urbanPct: { label: 'Urbanisation', axis: 'Urban population %' },
  literacyPct: { label: 'Literacy', axis: 'Literacy %' },
  clearancePct: { label: 'Clearance', axis: 'Cases cleared %' },
}

export function M3Predictive() {
  const [scores, setScores] = useState<RiskScore[]>([])
  const [overlay, setOverlay] = useState<Overlay>('urbanPct')
  const selected = useYukti((s) => s.selectedDistrict)
  const selectDistrict = useYukti((s) => s.selectDistrict)
  const openEvidence = useEvidence()

  const districts = useMemo(() => getDistrictMetrics(), [])

  useEffect(() => {
    let live = true
    getRiskScores().then((s) => {
      if (live) setScores(s)
    })
    return () => {
      live = false
    }
  }, [])

  const focus = useMemo(
    () => scores.find((s) => s.district === selected) ?? scores[0],
    [scores, selected],
  )

  const scatter = useMemo(
    () =>
      districts.map((d) => ({
        key: d.name,
        label: d.name,
        x: d[overlay],
        y: d.rate,
        risk: d.riskNorm,
      })),
    [districts, overlay],
  )

  if (!scores.length) return null

  const critical = scores.filter((s) => s.band === 'critical' || s.band === 'high').length

  return (
    <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="Relative risk · next 30 days" reference="SEC 7.3" ticked>
          <div className="grid grid-cols-2 gap-4 p-3 sm:grid-cols-4">
            <Stat label="Districts scored" value={String(scores.length)} />
            <Stat label="High or critical" value={String(critical)} tone="brass" />
            <Stat
              label="Top district"
              value={scores[0].district}
              size="sm"
              sub={`${(scores[0].score * 100).toFixed(0)} / 100`}
            />
            <Stat label="Horizon" value="30 days" sub="Retrained quarterly" />
          </div>
          <div className="border-t border-rule p-3">
            <DecisionSupportNote />
          </div>
        </Panel>

        <Panel
          title="Socio-economic correlation"
          reference="Census 2011"
          action={
            <div className="flex gap-1">
              {(Object.keys(OVERLAY) as Overlay[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setOverlay(k)}
                  aria-pressed={overlay === k}
                  className="label px-1.5 py-0.5 transition-colors"
                  style={{ color: overlay === k ? PALETTE.brass : undefined }}
                >
                  {OVERLAY[k].label}
                </button>
              ))}
            </div>
          }
        >
          <div className="p-3">
            <CorrelationScatter
              points={scatter}
              xLabel={OVERLAY[overlay].axis}
              yLabel="Incidents per 100k"
              onSelect={(k) => selectDistrict(k === selected ? null : k)}
              selected={selected}
            />
            <p className="mt-3 text-[0.76rem] leading-relaxed text-khaki-dim">
              Points are coloured by relative risk. The fitted line is shown so the strength of the
              association is legible, not to assert that one causes the other — recorded crime
              reflects reporting behaviour and enforcement intensity as much as incidence.
            </p>
          </div>
        </Panel>

        <Panel title="Ranked by relative risk" reference={`${scores.length} districts`} scroll>
          <RankedBars
            rows={scores.map((s) => {
              const d = districts.find((x) => x.name === s.district)
              return {
                key: s.district,
                label: s.district,
                value: Math.round(s.score * 100),
                risk: d?.riskNorm ?? s.score,
                flag: d?.redZone,
              }
            })}
            colorBy="risk"
            format={(n) => `${n}`}
            onSelect={(k) => selectDistrict(k === selected ? null : k)}
            selected={selected}
          />
        </Panel>
      </div>

      {/* Score detail — never without drivers and evidence. */}
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title={focus.district} reference="Risk detail" ticked>
          <div className="p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="label mb-1.5">Relative risk</div>
                <div
                  className="tnum leading-none"
                  style={{ fontSize: '3.1rem', fontWeight: 500, color: riskCss(focus.score) }}
                >
                  {(focus.score * 100).toFixed(0)}
                </div>
                <div className="label mt-1" style={{ fontSize: 9 }}>
                  of 100 · {focus.horizonDays}-day horizon
                </div>
              </div>
              <RiskPill score={focus.score} band={BAND_LABEL[focus.band]} />
            </div>

            <div className="label mb-2">What drives this score</div>
            <ul className="mb-4 flex flex-col gap-2.5">
              {focus.drivers.map((d) => (
                <li key={d.feature}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[0.78rem] text-khaki">{d.feature}</span>
                    <span className="tnum shrink-0 text-khaki-dim" style={{ fontSize: 10 }}>
                      {pct(d.contribution / Math.max(focus.score, 0.001), 0)}
                    </span>
                  </div>
                  <Bar value={d.contribution} max={focus.score || 1} color={riskCss(focus.score)} />
                </li>
              ))}
            </ul>

            <button
              onClick={() =>
                openEvidence({
                  title: `${focus.district} — relative risk ${(focus.score * 100).toFixed(0)}`,
                  subtitle: `Gradient-boosted model · ${focus.horizonDays}-day horizon · ${BAND_LABEL[focus.band]}`,
                  items: focus.evidence,
                })
              }
              className="label w-full border border-brass/50 px-3 py-2.5 text-brass transition-colors hover:bg-brass/12"
            >
              Show the {focus.evidence.length} records behind this score
            </button>
          </div>
        </Panel>

        <DistrictContext name={focus.district} />
      </div>
    </div>
  )
}

function DistrictContext({ name }: { name: string }) {
  const d = getDistrictMetrics().find((x) => x.name === name)
  if (!d) return null

  return (
    <Panel title="Jurisdiction context" reference="Census 2011">
      <div className="p-3">
        <Field name="Population">{inr(d.population)}</Field>
        <Field name="Police stations">{d.stations}</Field>
        <Field name="Urban">{d.urbanPct}%</Field>
        <Field name="Literacy">{d.literacyPct}%</Field>
        <Field name="Rate / 100k">{inr(d.rate)}</Field>
        <Field name="Clearance">{d.clearancePct}%</Field>
        <Field name="Period change">
          <span style={{ color: d.trend > 0 ? PALETTE.redzone : PALETTE.bhuvan }}>{delta(d.trend)}</span>
        </Field>
        <Field name="Red zone">
          {d.redZone ? (
            <span style={{ color: PALETTE.redzone }}>▲ Active</span>
          ) : (
            <span className="text-khaki-dim">None</span>
          )}
        </Field>
      </div>
    </Panel>
  )
}
