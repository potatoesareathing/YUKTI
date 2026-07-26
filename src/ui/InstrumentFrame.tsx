import { formatLat, formatLon } from '@/lib/geo'
import { useYukti } from '@/store/useYukti'

/**
 * The frame around the viewport: corner ticks, edge graduations, and a live
 * coordinate readout.
 *
 * The numbers are real. `readout` is written by the camera rig each few frames
 * from the actual look-at point projected back through the Mercator, so the
 * bearing shown is where the instrument is pointed. A decorative frame with
 * invented coordinates would be the exact species of detail this project cannot
 * afford to fake.
 */

function Corner({ className, h, v }: { className: string; h: 'l' | 'r'; v: 't' | 'b' }) {
  return (
    <div className={`pointer-events-none absolute ${className}`} aria-hidden>
      <div
        className="absolute bg-brass/60"
        style={{
          width: 22,
          height: 1,
          [h === 'l' ? 'left' : 'right']: 0,
          [v === 't' ? 'top' : 'bottom']: 0,
        }}
      />
      <div
        className="absolute bg-brass/60"
        style={{
          width: 1,
          height: 22,
          [h === 'l' ? 'left' : 'right']: 0,
          [v === 't' ? 'top' : 'bottom']: 0,
        }}
      />
    </div>
  )
}

/** Tick marks along one edge — the graduated scale of a survey instrument. */
function Graduations({ axis }: { axis: 'x' | 'y' }) {
  const ticks = Array.from({ length: 21 }, (_, i) => i)
  const horizontal = axis === 'x'

  return (
    <div
      className={`pointer-events-none absolute flex ${horizontal ? 'inset-x-0 flex-row' : 'inset-y-0 flex-col'}`}
      style={horizontal ? { top: 0, height: 8 } : { left: 0, width: 8 }}
      aria-hidden
    >
      {ticks.map((t) => (
        <div key={t} className="flex-1 relative">
          <div
            className="absolute bg-brass"
            style={
              horizontal
                ? { top: 0, left: 0, width: 1, height: t % 5 === 0 ? 7 : 3, opacity: t % 5 === 0 ? 0.5 : 0.25 }
                : { left: 0, top: 0, height: 1, width: t % 5 === 0 ? 7 : 3, opacity: t % 5 === 0 ? 0.5 : 0.25 }
            }
          />
        </div>
      ))}
    </div>
  )
}

interface InstrumentFrameProps {
  /** Shown at the frame's top-left, e.g. "SEC 7.1 · MOD-01". */
  reference?: string
  /** Shown at the frame's top-right. */
  status?: string
  compact?: boolean
}

export function InstrumentFrame({ reference, status, compact = false }: InstrumentFrameProps) {
  const readout = useYukti((s) => s.readout)

  return (
    <div className="pointer-events-none fixed inset-0 z-30" aria-hidden={!reference}>
      <div className={`absolute ${compact ? 'inset-3' : 'inset-5 md:inset-7'}`}>
        <Corner className="left-0 top-0" h="l" v="t" />
        <Corner className="right-0 top-0" h="r" v="t" />
        <Corner className="bottom-0 left-0" h="l" v="b" />
        <Corner className="bottom-0 right-0" h="r" v="b" />

        {!compact && (
          <>
            <Graduations axis="x" />
            <Graduations axis="y" />
          </>
        )}

        {/* Everything textual sits on the bottom rail. The top edge belongs to
            the page's own navigation, and two systems competing for that corner
            read as a bug rather than as instrumentation. */}
        <div
          className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 tnum"
          style={{ fontSize: 10, letterSpacing: '0.14em' }}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {reference && <span style={{ color: '#C9A227' }}>{reference}</span>}
            {reference && <span style={{ color: '#2A3A4C' }}>·</span>}
            <span style={{ color: '#8D8877' }}>{formatLat(readout.lat)}</span>
            <span style={{ color: '#2A3A4C' }}>·</span>
            <span style={{ color: '#8D8877' }}>{formatLon(readout.lon)}</span>
            {!compact && (
              <>
                <span className="hidden sm:inline" style={{ color: '#2A3A4C' }}>·</span>
                <span className="hidden sm:inline" style={{ color: '#8D8877' }}>
                  ALT {Math.round(readout.alt)}
                </span>
              </>
            )}
          </div>

          {/* Secondary readout drops on narrow viewports. Wrapped onto three
              lines it collides with the page's own bottom content, and the
              projection note is context, not a live value. */}
          <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
            {status && <span style={{ color: '#8D8877' }}>{status}</span>}
            {status && <span style={{ color: '#2A3A4C' }}>·</span>}
            <span style={{ color: '#8D8877' }}>MERCATOR · WGS-84</span>
          </div>
        </div>
      </div>
    </div>
  )
}
