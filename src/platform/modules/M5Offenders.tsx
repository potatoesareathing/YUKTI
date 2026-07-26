import { Field, Stat } from '@/ui/primitives'
import { PALETTE } from '@/lib/palette'
import { shortDate } from '@/lib/format'
import type { OffenderProfile } from '@/data/api'
import type { Evidence } from '@/data/types'

/**
 * Repeat-offender profiles — §7.2's "visual profiles that link an individual to
 * multiple incidents, highlighting their specific Modus Operandi across
 * different jurisdictions".
 *
 * Three things have to be on screen at once for that sentence to be true: the
 * person, their incidents ON A TIME AXIS, and the districts those incidents
 * cross. A list of cases alone is a record search; an MO signature alone is a
 * statistic. The finding is the intersection.
 */

interface Props {
  offenders: OffenderProfile[]
  selected: OffenderProfile | undefined
  onSelect: (id: string) => void
  onEvidence: (ctx: { title: string; subtitle: string; items: Evidence[] }) => void
}

export function OffenderPanel({ offenders, selected, onSelect, onEvidence }: Props) {
  const crossJurisdiction = offenders.filter((o) => o.districts.length > 1).length

  return (
    <>
      <div className="grid grid-cols-2 gap-4 border-b border-rule p-3 sm:grid-cols-4">
        <Stat label="Repeat offenders" value={String(offenders.length)} sub="≥ 2 incidents" />
        <Stat
          label="Cross-jurisdiction"
          value={String(crossJurisdiction)}
          tone="brass"
          sub="Operating in 2+ districts"
        />
        <Stat
          label="Most incidents"
          value={String(offenders[0]?.incidents.length ?? 0)}
          sub={offenders[0]?.person.label ?? '—'}
        />
        <Stat
          label="MO matches"
          value={String(offenders.reduce((a, o) => a + o.matches.length, 0))}
          tone="cool"
          sub="Same method, other district"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <ul className="divide-y divide-rule/50 border-r border-rule">
          {offenders.slice(0, 14).map((o) => {
            const on = selected?.person.id === o.person.id
            return (
              <li key={o.person.id}>
                <button
                  onClick={() => onSelect(o.person.id)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-brass/[0.06]"
                  style={{ background: on ? 'rgba(201,162,39,0.1)' : undefined }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[0.82rem]"
                      style={{ color: on ? PALETTE.brassLit : PALETTE.khaki }}
                    >
                      {o.person.label}
                    </span>
                    <span className="label block" style={{ fontSize: 9 }}>
                      {o.districts.slice(0, 2).join(', ')}
                      {o.districts.length > 2 ? ` +${o.districts.length - 2}` : ''}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-right" style={{ fontSize: 11, color: PALETTE.khaki }}>
                    {o.incidents.length}
                    <span className="label block" style={{ fontSize: 9 }}>
                      {o.districts.length} dist
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {selected ? (
          <div className="min-w-0 p-3">
            <div className="mb-3">
              <div
                className="mb-1"
                style={{
                  fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                  fontSize: '1.35rem',
                  fontWeight: 600,
                  color: PALETTE.brassLit,
                }}
              >
                {selected.person.label}
              </div>
              <div className="label">
                {String(selected.person.meta?.Reference ?? selected.person.id)} ·{' '}
                {selected.person.district}
              </div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <Field name="Incidents">{selected.incidents.length}</Field>
              <Field name="Districts">{selected.districts.length}</Field>
              <Field name="Priors">{selected.priors}</Field>
              <Field name="Active over">{selected.spanDays} days</Field>
            </div>

            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="label">Modus operandi</span>
              <span className="text-[0.8rem]" style={{ color: PALETTE.brass }}>
                {selected.signature}
              </span>
            </div>

            <Timeline profile={selected} />

            <div className="label mb-1.5 mt-3">Linked incidents</div>
            <ul className="mb-3 divide-y divide-rule/50 border-y border-rule/50">
              {selected.incidents.slice(0, 6).map((i) => (
                <li key={i.id} className="flex items-baseline gap-3 py-1.5">
                  <span className="tnum shrink-0 text-[0.76rem] text-khaki">{i.docket}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] text-khaki-dim">
                    {i.entry} → {i.target} · {i.window}
                  </span>
                  <span className="label shrink-0" style={{ fontSize: 9 }}>
                    {i.district} · {shortDate(new Date(i.at))}
                  </span>
                </li>
              ))}
            </ul>

            {selected.matches.length > 0 && (
              <div className="mb-3">
                <div className="label mb-1.5">
                  Same method, other jurisdictions · {selected.matches.length}
                </div>
                <ul className="flex flex-col gap-1">
                  {selected.matches.map((m) => (
                    <li key={m.person.id}>
                      <button
                        onClick={() => onSelect(m.person.id)}
                        className="flex w-full items-baseline gap-2 text-left transition-colors hover:text-brass"
                      >
                        <span className="min-w-0 flex-1 truncate text-[0.78rem] text-khaki">
                          {m.person.label}
                        </span>
                        <span className="label shrink-0" style={{ fontSize: 9 }}>
                          {m.district} · {m.shared} matching
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              onClick={() => onEvidence(offenderEvidence(selected))}
              className="label w-full border border-brass/50 px-3 py-2 text-brass transition-colors hover:bg-brass/12"
            >
              Show the {selected.incidents.length} linked records
            </button>

            <p className="mt-3 border-l border-brass/40 pl-3 text-[0.74rem] leading-relaxed text-khaki-dim">
              A shared modus operandi links METHODS, not people. It indicates where to look for a
              common offender; it does not establish one, and must not be treated as identification.
            </p>
          </div>
        ) : (
          <div className="p-6">
            <p className="text-[0.82rem] text-khaki-dim">Select an offender to open their profile.</p>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Incidents on a real time axis, not a list with dates beside it.
 *
 * Position carries when, and colour carries whether that incident matches the
 * person's dominant signature — so a run of same-method offences reads as a run
 * rather than as something you have to reconstruct by reading dates.
 */
function Timeline({ profile }: { profile: OffenderProfile }) {
  const times = profile.incidents.map((i) => i.at)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const span = Math.max(1, last - first)

  return (
    <div>
      <div className="relative" style={{ height: 34 }}>
        <div className="absolute inset-x-0 bg-rule" style={{ top: 16, height: 1 }} aria-hidden />
        {profile.incidents.map((i) => {
          const at = ((i.at - first) / span) * 100
          const onSignature = `${i.entry} → ${i.target}` === profile.signature
          return (
            <span
              key={i.id}
              className="absolute"
              title={`${i.docket} · ${i.district} · ${shortDate(new Date(i.at))}`}
              style={{
                left: `${at}%`,
                top: 10,
                width: 8,
                height: 8,
                marginLeft: -4,
                borderRadius: '50%',
                background: onSignature ? PALETTE.brass : PALETTE.bhuvanDim,
                border: `1px solid ${onSignature ? PALETTE.brassLit : PALETTE.rule2}`,
              }}
            />
          )
        })}
      </div>
      <div className="flex justify-between">
        <span className="label" style={{ fontSize: 9 }}>
          {shortDate(new Date(first))}
        </span>
        <span className="label" style={{ fontSize: 9 }}>
          Filled = matches their signature
        </span>
        <span className="label" style={{ fontSize: 9 }}>
          {shortDate(new Date(last))}
        </span>
      </div>
    </div>
  )
}

function offenderEvidence(p: OffenderProfile) {
  const items: Evidence[] = [
    {
      kind: 'person',
      ref: p.person.id,
      label: p.person.label,
      detail: `${p.incidents.length} linked incidents across ${p.districts.join(', ')}. Dominant modus operandi: ${p.signature}. Recorded priors: ${p.priors}.`,
    },
    ...p.incidents.slice(0, 6).map<Evidence>((i) => ({
      kind: 'incident',
      ref: i.id,
      label: i.docket,
      detail: `${i.district} · ${shortDate(new Date(i.at))} · ${i.entry} → ${i.target}, offence window ${i.window}`,
    })),
    {
      kind: 'feature',
      ref: `${p.person.id}:mo`,
      label: 'Signature derivation',
      detail:
        'The dominant entry-and-target pair across this person’s linked incidents. Matching is restricted to people operating in a DIFFERENT district, since a shared method within one jurisdiction is more likely a local norm than a link.',
    },
  ]

  return {
    title: p.person.label,
    subtitle: `${p.incidents.length} incidents · ${p.districts.length} districts · §7.2 repeat-offender tracking`,
    items,
  }
}
