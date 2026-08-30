import { DRIFT_THRESHOLD, fetchMoPatternAlerts, fetchPersonIntelDashboard, getAnomalies, getModelCards, type MoPatternAlert, type PersonIntelDashboard } from '@/data/api'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel, Stat, Bar, DecisionSupportNote, Empty } from '@/ui/primitives'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { MoCompareModal } from '@/ui/MoCompareModal'
import { PALETTE } from '@/lib/palette'
import { pct, shortDate } from '@/lib/format'
import type { AnomalyFlag, ModelCard } from '@/data/types'

/**
 * MOD-06 — AI/ML-Driven Intelligence (§7.6, §8).
 *
 * The shared model layer, shown as an operator would need to see it: what is
 * serving, on what version, at what measured performance, and how far each has
 * drifted since it was last trained. §8 requires that material changes in model
 * behaviour are reviewed before redeployment, which means drift has to be
 * visible in the product rather than buried in a dashboard nobody opens.
 *
 * Beside it sits the anomaly queue — the output an analyst actually works
 * through, every item carrying the records that produced it.
 */

const STATUS_STYLE: Record<ModelCard['status'], { color: string; glyph: string }> = {
  Serving: { color: PALETTE.brass, glyph: '●' },
  Retraining: { color: PALETTE.bhuvan, glyph: '◐' },
  Validation: { color: PALETTE.khakiDim, glyph: '◔' },
  Registered: { color: PALETTE.rule2, glyph: '○' },
}

export function M6Intelligence() {
  const [anomalies, setAnomalies] = useState<AnomalyFlag[]>([])
  const [moAlerts, setMoAlerts] = useState<MoPatternAlert[]>([])
  const [personDash, setPersonDash] = useState<PersonIntelDashboard | null>(null)
  const [compare, setCompare] = useState<MoPatternAlert | null>(null)
  const models = useMemo(() => getModelCards(), [])
  const openEvidence = useEvidence()

  useEffect(() => {
    let live = true
    getAnomalies(20).then((a) => {
      if (live) setAnomalies(a)
    })
    fetchMoPatternAlerts(30).then((a) => {
      if (live) setMoAlerts(a)
    })
    fetchPersonIntelDashboard()
      .then((d) => {
        if (live) setPersonDash(d)
      })
      .catch(() => {
        /* optional panel */
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (window.location.hash !== '#mo-patterns') return
    const el = document.getElementById('mo-patterns')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [moAlerts])

  const serving = models.filter((m) => m.status === 'Serving').length
  const drifting = models.filter((m) => m.drift > DRIFT_THRESHOLD).length

  return (
    <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_384px]">
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="Model portfolio" reference="Registry" ticked>
          <div className="grid grid-cols-2 gap-4 border-b border-rule p-3 sm:grid-cols-4">
            <Stat label="Models" value={String(models.length)} />
            <Stat label="Serving" value={String(serving)} tone="brass" />
            <Stat
              label="Drift over threshold"
              value={String(drifting)}
              tone={drifting ? 'alert' : 'default'}
              sub={`> ${pct(DRIFT_THRESHOLD, 0)}`}
            />
            <Stat label="Retrain cycle" value="Quarterly" sub="Per §8" />
          </div>

          <ul className="divide-y divide-rule/50">
            {models.map((m) => {
              const s = STATUS_STYLE[m.status]
              const hot = m.drift > DRIFT_THRESHOLD
              return (
                <li key={m.id} className="px-3 py-3">
                  <div className="mb-1.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span style={{ color: s.color, fontSize: 10 }} aria-hidden>
                          {s.glyph}
                        </span>
                        <span
                          className="truncate"
                          style={{
                            fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                            fontSize: '0.95rem',
                            fontWeight: 600,
                            color: PALETTE.khaki,
                          }}
                        >
                          {m.name}
                        </span>
                      </div>
                      <div className="label mt-1" style={{ fontSize: 9 }}>
                        {m.family}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <div className="tnum" style={{ fontSize: 10, color: s.color }}>
                        {m.status.toUpperCase()}
                      </div>
                      <div className="tnum text-khaki-dim" style={{ fontSize: 10 }}>
                        {m.version} · {m.module}
                      </div>
                    </div>
                  </div>

                  <p className="mb-2 text-[0.78rem] leading-relaxed text-khaki-dim">{m.io}</p>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="label" style={{ fontSize: 9 }}>
                          {m.metricLabel}
                        </span>
                        <span className="tnum text-khaki" style={{ fontSize: 10 }}>
                          {m.metric.toFixed(3)}
                        </span>
                      </div>
                      <Bar value={m.metric} color={PALETTE.brass} />
                    </div>
                    <div>
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="label" style={{ fontSize: 9 }}>
                          Drift
                        </span>
                        <span
                          className="tnum flex items-center gap-1"
                          style={{ fontSize: 10, color: hot ? PALETTE.redzone : PALETTE.khaki }}
                        >
                          {hot && <span aria-hidden>▲</span>}
                          {pct(m.drift, 1)}
                        </span>
                      </div>
                      <Bar
                        value={m.drift}
                        max={DRIFT_THRESHOLD * 2}
                        color={hot ? PALETTE.redzone : PALETTE.bhuvan}
                      />
                    </div>
                  </div>

                  <div className="label mt-2" style={{ fontSize: 9 }}>
                    Last trained {shortDate(new Date(m.lastTrained))}
                    {hot && ' — review required before redeployment'}
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>

        <Panel title="Governance" reference="Policy">
          <div className="p-4">
            <DecisionSupportNote>
              Every prediction surfaced to an investigator links back to the records that produced it.
              Models are retrained quarterly with performance and drift monitored through the MLOps
              pipeline, and any material change in behaviour is reviewed before redeployment.
              Protected attributes are excluded as direct model inputs, and outputs are subject to
              periodic fairness audit.
            </DecisionSupportNote>
          </div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Panel
          title="Anomaly queue"
          reference={`${anomalies.length} flagged`}
          scroll
          className="min-h-0 flex-1"
        >
          {anomalies.length ? (
            <ul className="divide-y divide-rule/50">
              {anomalies.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() =>
                      openEvidence({
                        title: a.evidence[0]?.label ?? a.id,
                        subtitle: `Anomaly score ${pct(a.score, 0)} · ${a.district} · Isolation Forest`,
                        items: a.evidence,
                      })
                    }
                    className="w-full px-3 py-2.5 text-left transition-colors hover:bg-brass/[0.06]"
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="tnum text-[0.78rem] text-khaki">{a.district}</span>
                      <span
                        className="tnum shrink-0"
                        style={{ fontSize: 10, color: a.score > 0.85 ? PALETTE.redzone : PALETTE.brass }}
                      >
                        {pct(a.score, 0)}
                      </span>
                    </div>
                    <p className="mb-1.5 text-[0.76rem] leading-snug text-khaki-dim">{a.reason}</p>
                    <Bar
                      value={a.score}
                      color={a.score > 0.85 ? PALETTE.redzone : PALETTE.brass}
                      height={2}
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Loading anomaly flags.</Empty>
          )}
        </Panel>

        <Panel title="Person Intelligence" reference="MOD-07" ticked id="person-intel-dash">
          <div className="grid grid-cols-2 gap-3 p-3">
            <Stat label="Potential matches" value={String(personDash?.potential_matches_detected ?? '—')} tone="brass" />
            <Stat label="High relevance" value={String(personDash?.high_relevance_matches ?? '—')} tone="alert" />
            <Stat label="For investigation" value={String(personDash?.marked_for_investigation ?? '—')} />
            <Stat label="Documented profiles" value={String(personDash?.documented_person_profiles ?? '—')} />
          </div>
          <div className="border-t border-rule p-3">
            <Link
              to="/platform/persons#alerts"
              className="label block border border-brass/40 px-2 py-2 text-center text-brass hover:bg-brass/10"
            >
              Open Person Intelligence →
            </Link>
            <p className="mt-2 text-[0.7rem] text-khaki-dim">
              Decision-support relevance only — requires officer verification.
            </p>
          </div>
        </Panel>

        <Panel title="Emerging MO patterns" reference="SCRB · >80%" ticked id="mo-patterns">
          {moAlerts.length === 0 ? (
            <Empty>No cross-jurisdiction MO matches above threshold yet.</Empty>
          ) : (
            <ul className="divide-y divide-rule/50">
              {moAlerts.map((a) => (
                <li key={a.id || `${a.fir_a}-${a.fir_b}`}>
                  <button
                    className="w-full px-3 py-2.5 text-left transition-colors hover:bg-brass/[0.06]"
                    onClick={() => setCompare(a)}
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="text-[0.78rem] text-khaki">
                        {a.district_a} ↔ {a.district_b}
                      </span>
                      <span className="tnum" style={{ fontSize: 11, color: PALETTE.redzone }}>
                        {a.score_pct ?? Math.round((a.score || 0) * 100)}%
                      </span>
                    </div>
                    <p className="text-[0.72rem] text-khaki-dim">
                      {(a.shared_tags || []).slice(0, 4).join(' · ') || 'Open side-by-side comparison'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {compare && <MoCompareModal alert={compare} onClose={() => setCompare(null)} />}
    </div>
  )
}
