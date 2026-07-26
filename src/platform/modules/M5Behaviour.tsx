import { useEffect, useMemo, useState } from 'react'
import { Panel, Stat, Field, Tag, DecisionSupportNote, Empty } from '@/ui/primitives'
import { RankedBars } from '@/ui/charts'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { getIncidents } from '@/data/incidents'
import { getCommunities } from '@/data/network'
import { getOffenderProfiles, type OffenderProfile } from '@/data/offenders'
import { PALETTE } from '@/lib/palette'
import { shortDate } from '@/lib/format'
import { OffenderPanel } from './M5Offenders'
import type { Evidence, Incident, ModusOperandi } from '@/data/types'

/**
 * MOD-05 — Network & Behavioural Analysis (§7.5).
 *
 * MO similarity clustering. Incidents are grouped by their modus-operandi
 * feature vector — entry method, target type, offence window, tools — and a
 * cluster that spans several jurisdictions is the signal §7.5 is after: a
 * behavioural signature that station-level records cannot see because each
 * station only holds its own.
 */

/** The MO signature key. Timing is excluded — it varies too much within a
 *  genuine signature to be a useful clustering feature on its own. */
function signature(mo: ModusOperandi): string {
  return `${mo.entry} · ${mo.target} · ${mo.tools}`
}

/** A district counts toward a signature's span only at this many records. */
const PRESENCE_THRESHOLD = 3

interface Cluster {
  key: string
  mo: ModusOperandi
  incidents: Incident[]
  /** Districts where the signature is materially present, not merely observed. */
  districts: string[]
  span: number
  strayDistricts: number
}

export function M5Behaviour() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [crossOnly, setCrossOnly] = useState(true)
  const [view, setView] = useState<'mo' | 'offenders'>(() =>
    new URLSearchParams(window.location.search).get('view') === 'offenders' ? 'offenders' : 'mo',
  )
  const [offenderId, setOffenderId] = useState<string | null>(null)
  const openEvidence = useEvidence()

  useEffect(() => {
    let live = true
    getIncidents().then((all) => {
      if (live) setIncidents(all)
    })
    return () => {
      live = false
    }
  }, [])

  const clusters = useMemo<Cluster[]>(() => {
    const groups = new Map<string, Incident[]>()
    for (const inc of incidents) {
      const key = signature(inc.mo)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(inc)
    }

    return [...groups.entries()]
      .map(([key, list]) => {
        // Presence, not appearance. One matching record in a district is a
        // coincidence — every MO turns up occasionally everywhere. A signature
        // is "present" in a jurisdiction once it recurs there, and only then
        // does it say anything about where an offender is operating.
        const counts = new Map<string, number>()
        for (const i of list) counts.set(i.district, (counts.get(i.district) ?? 0) + 1)
        const districts = [...counts.entries()]
          .filter(([, n]) => n >= PRESENCE_THRESHOLD)
          .sort((a, b) => b[1] - a[1])
          .map(([d]) => d)

        return {
          key,
          mo: list[0].mo,
          incidents: list.sort((a, b) => b.at - a.at),
          districts,
          span: districts.length,
          strayDistricts: counts.size - districts.length,
        }
      })
      .filter((c) => c.incidents.length >= 4)
      .sort((a, b) => b.span - a.span || b.incidents.length - a.incidents.length)
  }, [incidents])

  const shown = crossOnly ? clusters.filter((c) => c.span >= 3) : clusters
  const focus = shown.find((c) => c.key === selected) ?? shown[0]

  const communities = useMemo(() => getCommunities(), [])
  const offenders = useMemo<OffenderProfile[]>(() => getOffenderProfiles(), [])
  const offender = offenderId
    ? offenders.find((o) => o.person.id === offenderId)
    : offenders[0]

  if (!incidents.length) {
    return (
      <div className="p-6">
        <Empty>Loading incident records.</Empty>
      </div>
    )
  }

  return (
    <div
      className={`mx-auto grid max-w-[1500px] grid-cols-1 gap-3 p-3 ${
        view === 'mo' ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : ''
      }`}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Panel
          title={view === 'mo' ? 'Modus-operandi clusters' : 'Repeat offenders'}
          reference="SEC 7.5"
          ticked
          action={
            <div className="flex gap-1">
              {(['mo', 'offenders'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className="label px-1.5 py-0.5 transition-colors"
                  style={{ color: view === v ? PALETTE.brass : undefined }}
                >
                  {v === 'mo' ? 'By method' : 'By person'}
                </button>
              ))}
            </div>
          }
        >
          {view === 'offenders' ? (
            <OffenderPanel
              offenders={offenders}
              selected={offender}
              onSelect={setOffenderId}
              onEvidence={openEvidence}
            />
          ) : (
          <>
          <div className="grid grid-cols-2 gap-4 border-b border-rule p-3 sm:grid-cols-4">
            <Stat label="Clusters" value={String(clusters.length)} sub="≥ 4 incidents" />
            <Stat
              label="Cross-jurisdiction"
              value={String(clusters.filter((c) => c.span >= 3).length)}
              tone="brass"
              sub="≥ 3 districts"
            />
            <Stat label="Records grouped" value={String(clusters.reduce((a, c) => a + c.incidents.length, 0))} />
            <Stat
              label="Widest span"
              value={`${clusters[0]?.span ?? 0} districts`}
              tone="cool"
              sub={`≥ ${PRESENCE_THRESHOLD} records each`}
            />
          </div>

          <div className="flex items-center gap-2 border-b border-rule p-3">
            <Tag active={crossOnly} onClick={() => setCrossOnly(!crossOnly)}>
              Cross-jurisdiction only
            </Tag>
            <span className="label" style={{ fontSize: 9 }}>
              {shown.length} shown
            </span>
          </div>

          <ul className="divide-y divide-rule/50">
            {shown.slice(0, 14).map((c) => {
              const on = focus?.key === c.key
              return (
                <li key={c.key}>
                  <button
                    onClick={() => setSelected(c.key)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brass/[0.06]"
                    style={{ background: on ? 'rgba(201,162,39,0.1)' : undefined }}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[0.82rem]"
                        style={{ color: on ? PALETTE.brassLit : PALETTE.khaki }}
                      >
                        {c.mo.entry} → {c.mo.target}
                      </span>
                      <span className="label block" style={{ fontSize: 9 }}>
                        {c.mo.tools} · {c.districts.slice(0, 3).join(', ')}
                        {c.districts.length > 3 ? ` +${c.districts.length - 3}` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-right" style={{ fontSize: 11, color: PALETTE.khaki }}>
                      {c.incidents.length}
                      <span className="label block" style={{ fontSize: 9 }}>
                        {c.span} dist
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          </>
          )}
        </Panel>

        <Panel title="Known groups" reference="Louvain communities">
          <RankedBars
            rows={communities.map((c) => ({
              key: String(c.id),
              label: c.label,
              value: c.size,
            }))}
            format={(n) => `${n} nodes`}
          />
        </Panel>
      </div>

      {view === 'mo' && (
      <div className="flex min-w-0 flex-col gap-3">
        {focus ? (
          <>
            <Panel title="Cluster detail" reference={`${focus.incidents.length} records`} ticked>
              <div className="p-3">
                <div className="mb-3">
                  <Field name="Entry method">{focus.mo.entry}</Field>
                  <Field name="Target type">{focus.mo.target}</Field>
                  <Field name="Tools">{focus.mo.tools}</Field>
                  <Field name="Jurisdictions">
                    {focus.span}
                    {focus.strayDistricts > 0 && (
                      <span className="text-khaki-dim"> (+{focus.strayDistricts} isolated)</span>
                    )}
                  </Field>
                  <Field name="First recorded">
                    {shortDate(new Date(focus.incidents[focus.incidents.length - 1].at))}
                  </Field>
                  <Field name="Most recent">{shortDate(new Date(focus.incidents[0].at))}</Field>
                </div>

                <div className="label mb-2">Offence-window distribution</div>
                <WindowHistogram incidents={focus.incidents} />

                <button
                  onClick={() => openEvidence(evidenceForCluster(focus))}
                  className="label mt-3 w-full border border-brass/50 px-3 py-2 text-brass transition-colors hover:bg-brass/12"
                >
                  Show the linked records
                </button>
              </div>
            </Panel>

            <Panel title="Recent in cluster" reference="Latest first" scroll className="min-h-0 flex-1">
              <ul className="divide-y divide-rule/50">
                {focus.incidents.slice(0, 12).map((i) => (
                  <li key={i.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="tnum text-[0.78rem] text-khaki">{i.docket}</span>
                      <span className="label shrink-0" style={{ fontSize: 9 }}>
                        {shortDate(new Date(i.at))}
                      </span>
                    </div>
                    <div className="label mt-0.5" style={{ fontSize: 9 }}>
                      {i.station} · {i.category}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="border-t border-rule p-3">
                <DecisionSupportNote>
                  MO similarity groups incidents by recorded method. It suggests where to look for a
                  common offender; it does not establish one, and it must not be treated as
                  identification.
                </DecisionSupportNote>
              </div>
            </Panel>
          </>
        ) : (
          <Panel title="Cluster detail">
            <Empty>No cluster meets the current filter. Turn off cross-jurisdiction to see all.</Empty>
          </Panel>
        )}
      </div>
      )}
    </div>
  )
}

/** Offence windows are ordered time-of-day bins, so the histogram keeps them in
 *  clock order rather than sorting by count — the shape is the finding. */
function WindowHistogram({ incidents }: { incidents: Incident[] }) {
  const WINDOWS = ['0000–0400', '0400–0800', '0800–1200', '1200–1600', '1600–2000', '2000–0000']
  const counts = WINDOWS.map((w) => incidents.filter((i) => i.mo.timing === w).length)
  const peak = Math.max(...counts, 1)

  return (
    <div className="flex gap-1" style={{ height: 62 }}>
      {WINDOWS.map((w, i) => (
        // h-full on the column: without a definite height the flex-1 track
        // collapses and every bar renders as a hairline.
        <div key={w} className="flex h-full flex-1 flex-col items-center gap-1">
          <div className="flex w-full min-h-0 flex-1 items-end">
            <div
              className="w-full"
              style={{
                height: `${(counts[i] / peak) * 100}%`,
                background: PALETTE.brass,
                borderRadius: '2px 2px 0 0',
                minHeight: counts[i] ? 2 : 0,
              }}
              title={`${w}: ${counts[i]}`}
            />
          </div>
          <span className="label" style={{ fontSize: 8, letterSpacing: '0.04em' }}>
            {w.slice(0, 2)}
          </span>
        </div>
      ))}
    </div>
  )
}

function evidenceForCluster(c: Cluster) {
  const items: Evidence[] = [
    {
      kind: 'feature',
      ref: c.key,
      label: 'MO signature',
      detail: `${c.mo.entry} · ${c.mo.target} · ${c.mo.tools}. Clustering uses these three features; offence window is retained for inspection but excluded from the key, as it varies within a genuine signature.`,
    },
    ...c.incidents.slice(0, 6).map<Evidence>((i) => ({
      kind: 'incident',
      ref: i.id,
      label: i.docket,
      detail: `${i.station} · ${i.category} · ${shortDate(new Date(i.at))} — ${i.narrative}`,
    })),
    {
      kind: 'feature',
      ref: `${c.key}:span`,
      label: 'Jurisdictional span',
      detail: `${c.incidents.length} records across ${c.span} districts: ${c.districts.join(', ')}.`,
    },
  ]

  return {
    title: `${c.mo.entry} → ${c.mo.target}`,
    subtitle: `MO cluster · ${c.incidents.length} records · ${c.span} districts`,
    items,
  }
}
