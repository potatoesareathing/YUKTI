import type { ReactNode } from 'react'
import { riskCss } from '@/lib/palette'

/**
 * The platform's shared surfaces and small parts.
 *
 * Everything here is the same instrument vocabulary as the landing page: plates
 * with corner ticks, monospace labels in small caps, tabular figures. A module
 * that invented its own card style would read as a different product.
 */

interface PanelProps {
  title?: string
  /** Document reference, e.g. "SEC 7.4". Shown right-aligned in the header. */
  reference?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  ticked?: boolean
  scroll?: boolean
}

export function Panel({ title, reference, action, children, className = '', ticked, scroll }: PanelProps) {
  return (
    <section className={`plate ${ticked ? 'ticked' : ''} flex min-h-0 flex-col ${className}`}>
      {(title || reference || action) && (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
          <h2 className="label text-khaki">{title}</h2>
          <div className="flex items-center gap-3">
            {action}
            {reference && <span className="label-brass">{reference}</span>}
          </div>
        </header>
      )}
      <div className={`min-h-0 flex-1 ${scroll ? 'overflow-y-auto' : ''}`}>{children}</div>
    </section>
  )
}

/** A labelled figure. The workhorse of every module header. */
export function Stat({
  label,
  value,
  sub,
  tone = 'default',
  size = 'md',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'brass' | 'alert' | 'cool'
  size?: 'sm' | 'md' | 'lg'
}) {
  const color =
    tone === 'alert' ? '#FF3B2F' : tone === 'brass' ? '#C9A227' : tone === 'cool' ? '#4C9FC0' : '#DCD3BE'
  const fontSize = size === 'lg' ? '1.9rem' : size === 'sm' ? '1rem' : '1.35rem'

  return (
    <div className="min-w-0">
      <div className="label mb-1 truncate">{label}</div>
      <div className="tnum leading-none" style={{ fontSize, fontWeight: 500, color }}>
        {value}
      </div>
      {sub && (
        <div className="label mt-1 truncate" style={{ fontSize: 9, opacity: 0.72 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

/** Key/value row, as a case file lists a field. */
export function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule/60 py-1.5 last:border-0">
      <span className="label shrink-0">{name}</span>
      <span className="min-w-0 truncate text-right text-[0.82rem] text-khaki">{children}</span>
    </div>
  )
}

/** Horizontal magnitude bar. Used for risk, contributions, category mix. */
export function Bar({
  value,
  max = 1,
  color,
  height = 4,
}: {
  value: number
  max?: number
  color?: string
  height?: number
}) {
  const pct = Math.max(0, Math.min(1, value / (max || 1))) * 100
  return (
    <div className="w-full bg-rule/70" style={{ height }}>
      <div
        style={{ width: `${pct}%`, height: '100%', background: color ?? '#C9A227', transition: 'width .35s ease' }}
      />
    </div>
  )
}

/** Risk chip carrying the ramp colour and band name. */
export function RiskPill({ score, band }: { score: number; band: string }) {
  const c = riskCss(score)
  return (
    <span
      className="tnum inline-flex items-center gap-1.5 border px-1.5 py-0.5"
      style={{ borderColor: c, color: c, fontSize: 10, letterSpacing: '0.1em' }}
    >
      <span style={{ width: 5, height: 5, background: c, display: 'inline-block' }} aria-hidden />
      {band.toUpperCase()}
    </span>
  )
}

export function Tag({
  children,
  active,
  onClick,
  tone = 'default',
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  tone?: 'default' | 'alert'
}) {
  const activeColor = tone === 'alert' ? '#FF3B2F' : '#C9A227'
  const Comp = onClick ? 'button' : 'span'
  return (
    <Comp
      onClick={onClick}
      aria-pressed={onClick ? !!active : undefined}
      className="label border px-2 py-1 transition-colors"
      style={{
        borderColor: active ? activeColor : '#1E2A38',
        color: active ? activeColor : '#8D8877',
        background: active ? `${activeColor}14` : 'transparent',
      }}
    >
      {children}
    </Comp>
  )
}

/**
 * The standing caveat on every predictive surface.
 *
 * §10.3 and §15: model output is a decision-support signal requiring human
 * review, and the demo data is synthetic. Both facts belong next to the number,
 * not in a footer nobody reads.
 */
export function DecisionSupportNote({ children }: { children?: ReactNode }) {
  return (
    <p className="border-l border-brass/40 pl-3 text-[0.74rem] leading-relaxed text-khaki-dim">
      {children ?? (
        <>
          Decision support only. Any action affecting an individual requires review and sign-off by an
          authorised officer, with this evidence attached. Figures shown are synthetic.
        </>
      )}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center p-6 text-center">
      <p className="max-w-xs text-[0.82rem] leading-relaxed text-khaki-dim">{children}</p>
    </div>
  )
}
