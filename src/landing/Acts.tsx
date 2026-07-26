import { Link } from 'react-router-dom'
import { compact, inr } from '@/lib/format'
import { stateTotals } from '@/data/districts'
import { KARNATAKA_STATIONS } from '@/data/census'

/**
 * Act overlays.
 *
 * Copy is deliberately technical. This is a platform for crime analysts and the
 * judges of a datathon, and both are better served by naming the actual
 * estimator than by a sentence about empowering decision-makers. Every method
 * named here is one the technical solution document commits to.
 */

interface ActProps {
  opacity: number
}

const fade = (opacity: number) => ({
  opacity,
  transform: `translateY(${(1 - opacity) * 18}px)`,
  transition: 'none' as const,
})

export function ActOne({ opacity }: ActProps) {
  const totals = stateTotals()

  return (
    <div
      className="pointer-events-none relative flex min-h-[100svh] flex-col justify-center px-6 md:px-16"
      style={fade(opacity)}
    >
      {/* Scrim. The camera frames the state right-of-centre, but the coast still
          reaches under the headline — this keeps the type readable without
          dimming the map itself. */}
      <div
        className="pointer-events-none absolute inset-0 md:hidden"
        style={{
          // On a phone the copy spans the full width, so the scrim has to as
          // well — a gradient that clears by 100% leaves the last paragraph
          // sitting directly on the map.
          background:
            'linear-gradient(to bottom, rgba(7,10,15,0.86) 0%, rgba(7,10,15,0.93) 22%, rgba(7,10,15,0.93) 88%, rgba(7,10,15,0.7) 100%)',
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-y-0 left-0 hidden w-[62%] md:block"
        style={{
          background:
            'linear-gradient(to right, rgba(7,10,15,0.94) 0%, rgba(7,10,15,0.82) 42%, rgba(7,10,15,0) 100%)',
        }}
        aria-hidden
      />

      <div className="relative max-w-3xl">
        <div className="label-brass mb-6 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span style={{ fontFamily: "'Noto Serif Kannada', serif", letterSpacing: 0 }}>
            ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್
          </span>
          <span className="text-rule-2">·</span>
          <span>State Crime Records Bureau</span>
        </div>

        {/* The Kannada wordmark leads. English annotates it. */}
        <h1
          className="leading-[0.82] text-khaki"
          style={{
            fontFamily: "'Noto Serif Kannada', serif",
            fontSize: 'clamp(4.5rem, 15vw, 13rem)',
            fontWeight: 600,
            textShadow: '0 0 90px rgba(201,162,39,0.22)',
          }}
        >
          ಯುಕ್ತಿ
        </h1>

        <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span
            className="text-brass"
            style={{
              fontFamily: "'IBM Plex Sans Condensed', sans-serif",
              fontSize: 'clamp(1.5rem, 3.4vw, 2.6rem)',
              fontWeight: 600,
              letterSpacing: '0.24em',
            }}
          >
            YUKTI
          </span>
          <span className="label">
            Yielding Unified Karnataka Trend Intelligence Platform
          </span>
        </div>

        <p
          className="mt-9 max-w-2xl text-khaki/75"
          style={{ fontSize: 'clamp(0.95rem, 1.5vw, 1.1rem)', lineHeight: 1.65 }}
        >
          Karnataka's crime record is spread across Excel sheets, station registers and systems
          that do not talk to each other. YUKTI reads all of it as one surface — geography, network
          and forecast — and shows its working behind every figure it puts on screen.
        </p>

        <dl className="mt-11 flex flex-wrap gap-x-10 gap-y-5">
          <Stat label="Districts" value="30" note="Real boundaries" />
          <Stat label="Police stations" value={inr(KARNATAKA_STATIONS)} note="State-wide" />
          <Stat label="Records analysed" value={compact(totals.incidents)} note="180-day window" />
          <Stat
            label="Red zones"
            value={String(totals.redZones)}
            note="CUSUM breach"
            alert={totals.redZones > 0}
          />
        </dl>
      </div>

      <div className="absolute bottom-20 left-6 flex items-center gap-3 md:bottom-14 md:left-16">
        <div className="h-px w-10 overflow-hidden bg-rule">
          <div className="sweep-line h-px w-full bg-brass" />
        </div>
        <span className="label">Scroll to read the state</span>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  note,
  alert,
}: {
  label: string
  value: string
  note: string
  alert?: boolean
}) {
  return (
    <div>
      <dt className="label mb-1.5">{label}</dt>
      <dd
        className="tnum leading-none"
        style={{ fontSize: '1.9rem', fontWeight: 500, color: alert ? '#FF3B2F' : '#DCD3BE' }}
      >
        {value}
      </dd>
      <div className="label mt-1.5" style={{ fontSize: 9, opacity: 0.7 }}>
        {note}
      </div>
    </div>
  )
}

export function ActTwo({ opacity }: ActProps) {
  return (
    <ActPanel
      opacity={opacity}
      reference="SEC 7.1 · MOD-01 / MOD-04"
      heading="Where, and when"
      body="Kernel density estimation over geo-tagged incidents, clustered by ST-DBSCAN and sliced by time of day. The contour bands mark where density climbs fastest — a tight band is a sharp edge to a hotspot, not a gradient."
      footnote="A CUSUM control chart on the STL residual decides when a jurisdiction becomes a red zone. Not a threshold on the raw count."
      side="right"
    />
  )
}

export function ActThree({ opacity }: ActProps) {
  return (
    <ActPanel
      opacity={opacity}
      reference="SEC 7.2 · MOD-02 / MOD-05"
      heading="And who, with whom"
      body="The same records, re-sorted by association instead of by place. Louvain community detection over a suspect–victim–location graph; PageRank ranks the people the network actually routes through."
      footnote="Brass edges are GraphSAGE link predictions — hypotheses to check, not records. The platform never shows the two the same way."
      side="left"
      cta
    />
  )
}

interface ActPanelProps {
  opacity: number
  reference: string
  heading: string
  body: string
  footnote: string
  side: 'left' | 'right'
  cta?: boolean
}

function ActPanel({ opacity, reference, heading, body, footnote, side, cta }: ActPanelProps) {
  return (
    <div
      className={`pointer-events-none flex min-h-[100svh] items-center px-6 md:px-16 ${
        side === 'right' ? 'justify-end' : 'justify-start'
      }`}
      style={fade(opacity)}
    >
      <div className="plate ticked max-w-md p-7 backdrop-blur-[2px]">
        <div className="label-brass mb-4">{reference}</div>
        <h2
          className="mb-4 text-khaki"
          style={{
            fontFamily: "'IBM Plex Sans Condensed', sans-serif",
            fontSize: 'clamp(1.8rem, 3.6vw, 2.6rem)',
            fontWeight: 600,
            lineHeight: 1.05,
          }}
        >
          {heading}
        </h2>
        <p className="text-[0.94rem] leading-relaxed text-khaki/75">{body}</p>

        <div className="mt-5 border-t border-rule pt-4">
          <p className="text-[0.82rem] leading-relaxed text-khaki-dim">{footnote}</p>
        </div>

        {cta && (
          <Link
            to="/platform"
            className="pointer-events-auto mt-7 flex items-center justify-between border border-brass/50 bg-brass/[0.07] px-4 py-3 transition-colors hover:bg-brass/15 focus-visible:bg-brass/15"
          >
            <span>
              <span
                className="block text-brass"
                style={{
                  fontFamily: "'IBM Plex Sans Condensed', sans-serif",
                  fontSize: '1rem',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                }}
              >
                ENTER THE PLATFORM
              </span>
              <span className="label mt-1 block" style={{ fontSize: 9 }}>
                Six modules · evidence on every score
              </span>
            </span>
            <span className="text-brass" aria-hidden>
              →
            </span>
          </Link>
        )}
      </div>
    </div>
  )
}
