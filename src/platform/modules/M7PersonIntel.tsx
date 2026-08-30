import {
  fetchPersonIntelAlerts,
  fetchPersonIntelDashboard,
  fetchPersonIntelMatch,
  fetchPersonIntelProfile,
  searchPersonIntel,
  setPersonIntelAlertStatus,
  type PersonIntelAlert,
  type PersonIntelDashboard,
  type PersonIntelMatchResult,
  type PersonIntelProfile,
  type PersonIntelSearchHit,
} from '@/data/api'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DecisionSupportNote, Empty, Field, Panel, Stat, Tag } from '@/ui/primitives'
import { useEvidence } from '@/ui/EvidenceDrawer'
import { useYukti } from '@/store/useYukti'
import { PALETTE } from '@/lib/palette'
import { shortDate } from '@/lib/format'
import type { Evidence } from '@/data/types'

/**
 * MOD-07 — Person Intelligence & Alerts.
 *
 * Decision-support only: surfaces documented persons who may be relevant to an
 * incident, with explainable Investigation Relevance factors and evidence links.
 * Never frames matches as guilt or perpetrator identification.
 */

type View = 'alerts' | 'search' | 'profile'

export function M7PersonIntel() {
  const [view, setView] = useState<View>('alerts')
  const [dash, setDash] = useState<PersonIntelDashboard | null>(null)
  const [alerts, setAlerts] = useState<PersonIntelAlert[]>([])
  const [probeNote, setProbeNote] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<PersonIntelSearchHit[]>([])
  const [profile, setProfile] = useState<PersonIntelProfile | null>(null)
  const [match, setMatch] = useState<PersonIntelMatchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [whyOpen, setWhyOpen] = useState(false)
  const openEvidence = useEvidence()
  const selectNode = useYukti((s) => s.selectNode)

  async function refreshAlerts() {
    const [d, a] = await Promise.all([fetchPersonIntelDashboard(), fetchPersonIntelAlerts(40)])
    setDash(d)
    setAlerts(a.alerts)
    if (a.probe?.synthetic) {
      setProbeNote(`Synthetic demo incident ${a.probe.docket || a.probe.id} — for demonstration only.`)
    }
  }

  useEffect(() => {
    let live = true
    setBusy(true)
    refreshAlerts()
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => live && setBusy(false))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const person = params.get('person')
    if (person) void openProfile(person)

    const hash = window.location.hash
    if (hash === '#alerts') setView('alerts')
    if (hash === '#search') setView('search')
    if (hash === '#profile' || hash === '#why') {
      setView('profile')
      if (hash === '#why') setWhyOpen(true)
    }
    const el = document.getElementById(hash.replace('#', ''))
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [alerts, profile])

  async function openProfile(personId: string) {
    setBusy(true)
    setError(null)
    try {
      const p = await fetchPersonIntelProfile(personId)
      setProfile(p)
      setView('profile')
      selectNode(personId)
      const m = await fetchPersonIntelMatch(undefined, 12)
      setMatch(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Profile load failed')
    } finally {
      setBusy(false)
    }
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setHits(await searchPersonIntel(q, 40))
      setView('search')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  async function onAlertStatus(alert: PersonIntelAlert, status: 'investigating' | 'dismissed') {
    await setPersonIntelAlertStatus(alert.id, status)
    await refreshAlerts()
    if (status === 'investigating') await openProfile(alert.person_id)
  }

  const selectedMatch = useMemo(() => {
    if (!profile || !match) return null
    return match.matches.find((m) => m.person_id === profile.person_id) ?? null
  }, [profile, match])

  return (
    <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        <Panel
          id="alerts"
          title="Person Intelligence & Alerts"
          reference="MOD-07 · Decision support"
          ticked
          action={
            <div className="flex gap-1">
              <Tag active={view === 'alerts'} onClick={() => setView('alerts')}>
                Alerts
              </Tag>
              <Tag active={view === 'search'} onClick={() => setView('search')}>
                Search
              </Tag>
              <Tag active={view === 'profile'} onClick={() => profile && setView('profile')}>
                Profile
              </Tag>
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-3 border-b border-rule p-3 sm:grid-cols-4">
            <Stat
              label="Potential matches"
              value={String(dash?.potential_matches_detected ?? '—')}
              tone="brass"
              sub="Above relevance threshold"
            />
            <Stat
              label="High relevance"
              value={String(dash?.high_relevance_matches ?? '—')}
              tone="alert"
              sub="≥ 85%"
            />
            <Stat
              label="Marked for investigation"
              value={String(dash?.marked_for_investigation ?? '—')}
            />
            <Stat
              label="Documented profiles"
              value={String(dash?.documented_person_profiles ?? '—')}
              sub="Recurring patterns in dataset"
            />
          </div>

          <DecisionSupportNote>
            Investigation Relevance identifies documented persons who may be relevant to an
            incident. It is not a guilt score, does not name a perpetrator, and always requires
            officer verification.
          </DecisionSupportNote>

          {probeNote && (
            <p className="border-b border-rule px-3 py-2 text-[0.72rem] text-khaki-dim">{probeNote}</p>
          )}
          {error && (
            <p className="border-b border-rule px-3 py-2 text-[0.78rem]" style={{ color: PALETTE.redzone }}>
              {error}
            </p>
          )}
          {busy && !alerts.length && !profile && (
            <div className="p-4">
              <Empty>Loading Person Intelligence…</Empty>
            </div>
          )}
        </Panel>

        {view === 'alerts' && (
          <Panel title="Potential Match Alerts" reference="Requires verification">
            {!alerts.length ? (
              <div className="p-4">
                <Empty>No open potential-match alerts above the relevance threshold.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-rule/50">
                {alerts.map((a) => (
                  <li key={a.id} className="px-3 py-3">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div>
                        <div className="label-brass" style={{ fontSize: 10 }}>
                          ⚠ {a.title}
                        </div>
                        <div className="text-[0.88rem] text-khaki">{a.person_name}</div>
                      </div>
                      <div className="tnum text-right" style={{ color: PALETTE.brass, fontSize: 18 }}>
                        {a.investigation_relevance}%
                        <div className="label block" style={{ fontSize: 8 }}>
                          Investigation Relevance
                        </div>
                      </div>
                    </div>
                    <p className="mb-2 text-[0.76rem] leading-relaxed text-khaki-dim">{a.summary}</p>
                    <div className="mb-2 flex flex-wrap gap-3 text-[0.72rem] text-khaki-dim">
                      <span>Previous related cases: {a.previous_related_cases}</span>
                      <span>MO similarity: {a.mo_similarity_pct ?? '—'}%</span>
                      <span>Geographic overlap: {a.geographic_overlap}</span>
                    </div>
                    <div className="mb-2">
                      <div className="label mb-1" style={{ fontSize: 9 }}>
                        Why this person was surfaced
                      </div>
                      <ul className="space-y-1">
                        {a.reasons.slice(0, 4).map((r) => (
                          <li key={r.factor} className="text-[0.74rem] text-khaki">
                            · {r.label} ({r.score_pct}%) — {r.explanation}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <p className="label mb-2" style={{ fontSize: 9, color: PALETTE.brass }}>
                      Requires Officer Verification · status: {a.status}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="label border border-brass/50 px-2 py-1.5 text-brass hover:bg-brass/12"
                        onClick={() => openProfile(a.person_id)}
                      >
                        View profile
                      </button>
                      <button
                        className="label border border-rule px-2 py-1.5 hover:border-brass"
                        onClick={() =>
                          openEvidence({
                            title: `Why ${a.person_name}?`,
                            subtitle: `Investigation Relevance ${a.investigation_relevance}% · decision support`,
                            items: reasonsToEvidence(a),
                          })
                        }
                      >
                        View evidence
                      </button>
                      <button
                        className="label border border-rule px-2 py-1.5 hover:border-brass"
                        onClick={() => onAlertStatus(a, 'investigating')}
                      >
                        Mark for investigation
                      </button>
                      <button
                        className="label border border-rule px-2 py-1.5 hover:border-brass"
                        onClick={() => onAlertStatus(a, 'dismissed')}
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {view === 'search' && (
          <Panel id="search" title="Person Intelligence Search" reference="Record vs relevance">
            <form onSubmit={onSearch} className="flex gap-2 border-b border-rule p-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, alias, FIR, crime type, location, vehicle…"
                className="min-w-0 flex-1 border border-rule bg-transparent px-2 py-1.5 text-[0.82rem] text-khaki outline-none focus:border-brass"
              />
              <button type="submit" className="label border border-brass/50 px-3 py-1.5 text-brass">
                Search
              </button>
            </form>
            {!hits.length ? (
              <div className="p-4">
                <Empty>Search the documented person set. Exact record hits are labelled separately from relevance matches.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-rule/50">
                {hits.map((h) => (
                  <li key={h.person_id}>
                    <button
                      onClick={() => openProfile(h.person_id)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-brass/[0.06]"
                    >
                      <span>
                        <span className="block text-[0.84rem] text-khaki">{h.name}</span>
                        <span className="label block" style={{ fontSize: 9 }}>
                          {h.district} · {h.documented_cases} cases · {h.mo_signature}
                        </span>
                      </span>
                      <span className="label shrink-0" style={{ fontSize: 9, color: PALETTE.brass }}>
                        {h.match_kind === 'exact_record' ? 'Exact / record' : 'Record match'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {view === 'profile' && profile && (
          <ProfileView
            profile={profile}
            selectedMatch={selectedMatch}
            whyOpen={whyOpen}
            setWhyOpen={setWhyOpen}
            onEvidence={openEvidence}
          />
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-3">
        <Panel title="Cross-module" reference="Existing YUKTI">
          <div className="flex flex-col gap-2 p-3 text-[0.78rem] text-khaki-dim">
            <Link className="border border-rule px-2 py-2 hover:border-brass hover:text-brass" to="/platform/geospatial">
              Geospatial — historical locations
            </Link>
            <Link
              className="border border-rule px-2 py-2 hover:border-brass hover:text-brass"
              to="/platform/network"
              onClick={() => profile && selectNode(profile.person_id)}
            >
              Network — associates & vehicles
            </Link>
            <Link className="border border-rule px-2 py-2 hover:border-brass hover:text-brass" to="/platform/behaviour">
              Behaviour — MO patterns
            </Link>
            <Link className="border border-rule px-2 py-2 hover:border-brass hover:text-brass" to="/platform/trends">
              Trends — activity over time
            </Link>
          </div>
        </Panel>

        {profile && (
          <Panel title="Map points" reference="Documented cases">
            {!profile.map_points.length ? (
              <div className="p-3">
                <Empty>No coordinates on linked cases.</Empty>
              </div>
            ) : (
              <ul className="max-h-64 divide-y divide-rule/50 overflow-y-auto">
                {profile.map_points.map((p) => (
                  <li key={`${p.case_id}-${p.at}`} className="px-3 py-2 text-[0.76rem]">
                    <div className="text-khaki">{p.docket}</div>
                    <div className="label" style={{ fontSize: 9 }}>
                      {p.district} · {p.category} · {p.lonLat?.[1].toFixed(3)}, {p.lonLat?.[0].toFixed(3)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </aside>
    </div>
  )
}

function ProfileView({
  profile,
  selectedMatch,
  whyOpen,
  setWhyOpen,
  onEvidence,
}: {
  profile: PersonIntelProfile
  selectedMatch: PersonIntelMatchResult['matches'][number] | null
  whyOpen: boolean
  setWhyOpen: (v: boolean) => void
  onEvidence: (ctx: { title: string; subtitle: string; items: Evidence[] }) => void
}) {
  return (
    <Panel id="profile" title={profile.name} reference="Relevant person profile" ticked>
      <div className="grid grid-cols-2 gap-3 border-b border-rule p-3 sm:grid-cols-4">
        <Stat label="Documented cases" value={String(profile.documented_cases)} />
        <Stat label="Priors (dataset)" value={String(profile.priors)} />
        <Stat label="Frequent crime" value={profile.most_frequent_crime_type ?? '—'} size="sm" />
        <Stat
          label="Investigation Relevance"
          value={selectedMatch ? `${selectedMatch.relevance.investigation_relevance}%` : '—'}
          tone="brass"
          sub="vs demo probe"
        />
      </div>

      <div className="border-b border-rule p-3">
        <Field name="District">{profile.district}</Field>
        <Field name="Aliases">{profile.aliases.length ? profile.aliases.join(', ') : 'None in dataset'}</Field>
        <Field name="MO signature">{profile.mo_signature ?? '—'}</Field>
        <Field name="Frequent location">{profile.frequently_occurring_location ?? '—'}</Field>
        <Field name="Status">{profile.case_status}</Field>
        {profile.data_notes.map((n) => (
          <p key={n} className="mt-1 text-[0.7rem] text-khaki-dim">
            · {n}
          </p>
        ))}
      </div>

      <div id="why" className="flex flex-wrap gap-2 border-b border-rule p-3">
        <button
          className="label border border-brass/50 px-2 py-1.5 text-brass hover:bg-brass/12"
          onClick={() => setWhyOpen(!whyOpen)}
        >
          Why this person?
        </button>
        {selectedMatch && (
          <button
            className="label border border-rule px-2 py-1.5 hover:border-brass"
            onClick={() =>
              onEvidence({
                title: `Why ${profile.name}?`,
                subtitle: `Investigation Relevance ${selectedMatch.relevance.investigation_relevance}%`,
                items: matchReasonsToEvidence(selectedMatch),
              })
            }
          >
            Open evidence drawer
          </button>
        )}
      </div>

      {whyOpen && selectedMatch && (
        <div className="border-b border-rule p-3">
          <div className="label-brass mb-2" style={{ fontSize: 10 }}>
            Investigation Relevance — {selectedMatch.relevance.investigation_relevance}%
          </div>
          <ul className="mb-2 space-y-1.5">
            {Object.entries(selectedMatch.relevance.factors).map(([k, f]) => (
              <li key={k} className="flex justify-between gap-2 text-[0.76rem] text-khaki">
                <span>
                  {k.replace(/_/g, ' ')}
                  {!f.available && <span className="text-khaki-dim"> (unavailable)</span>}
                </span>
                <span className="tnum">{f.score_pct == null ? '—' : `${f.score_pct}%`}</span>
              </li>
            ))}
          </ul>
          <p className="text-[0.7rem] text-khaki-dim">{selectedMatch.relevance.disclaimer}</p>
        </div>
      )}

      <div className="grid grid-cols-1 border-b border-rule lg:grid-cols-2">
        <div className="border-b border-rule p-3 lg:border-b-0 lg:border-r">
          <div className="label mb-2" style={{ fontSize: 9 }}>
            Associated vehicles
          </div>
          {!profile.associated_vehicles.length ? (
            <Empty>None linked in graph.</Empty>
          ) : (
            <ul className="space-y-1">
              {profile.associated_vehicles.map((v) => (
                <li key={v.id} className="text-[0.78rem] text-khaki">
                  {v.label}
                  {v.synthetic ? <span className="label ml-1">synthetic overlay</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-3">
          <div className="label mb-2" style={{ fontSize: 9 }}>
            Associated persons / entities
          </div>
          {!profile.associated_persons.length ? (
            <Empty>None linked in graph.</Empty>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {profile.associated_persons.slice(0, 12).map((a) => (
                <li key={a.id} className="text-[0.78rem] text-khaki">
                  {a.label} <span className="label">· {a.edge}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="p-3">
        <div className="label mb-2" style={{ fontSize: 9 }}>
          Historical incident timeline
        </div>
        {!profile.timeline.length ? (
          <Empty>No documented incidents.</Empty>
        ) : (
          <ol className="relative space-y-3 border-l border-rule pl-3">
            {profile.timeline.map((t) => (
              <li key={`${t.case_id}-${t.at}`}>
                <div className="text-[0.8rem] text-khaki">{t.docket}</div>
                <div className="label" style={{ fontSize: 9 }}>
                  {shortDate(new Date(t.at))} · {t.district} · {t.category} · {t.mo}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  )
}

function reasonsToEvidence(a: PersonIntelAlert): Evidence[] {
  return a.reasons.map((r) => ({
    kind: 'feature',
    ref: r.factor,
    label: `${r.label} (${r.score_pct}%)`,
    detail: `${r.explanation}${r.evidence_refs.length ? ` · refs: ${r.evidence_refs.join(', ')}` : ''}`,
  }))
}

function matchReasonsToEvidence(m: PersonIntelMatchResult['matches'][number]): Evidence[] {
  return m.relevance.reasons.map((r) => ({
    kind: 'feature',
    ref: r.factor,
    label: `${r.label} (${r.score_pct}%)`,
    detail: `${r.explanation}${r.evidence_refs.length ? ` · refs: ${r.evidence_refs.join(', ')}` : ''}`,
  }))
}
