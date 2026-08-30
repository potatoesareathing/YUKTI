import type { MoComparison, MoPatternAlert } from '@/data/api'
import { PALETTE } from '@/lib/palette'

export function MoCompareModal({
  alert,
  onClose,
}: {
  alert: MoPatternAlert
  onClose: () => void
}) {
  const cmp = alert.comparison as MoComparison | undefined
  const shared = alert.shared_tags || []

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="MO comparison"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto border border-brass/40 bg-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
          <div>
            <div className="label-brass">Emerging Pattern Alert</div>
            <div className="text-[0.95rem] text-khaki">
              Cross-jurisdiction MO match · {alert.score_pct ?? Math.round((alert.score || 0) * 100)}%
            </div>
            <div className="mt-1 text-[0.75rem] text-khaki-dim">
              {alert.district_a} ↔ {alert.district_b}
            </div>
          </div>
          <button className="label border border-rule px-2 py-1 hover:border-brass" onClick={onClose}>
            Close
          </button>
        </div>

        {shared.length > 0 && (
          <div className="border-b border-rule px-4 py-3">
            <div className="label mb-2">Shared Kannada / MO tags</div>
            <div className="flex flex-wrap gap-1.5">
              {shared.map((t) => (
                <span
                  key={t}
                  className="border px-2 py-0.5 text-[0.72rem]"
                  style={{ borderColor: PALETTE.brass, color: PALETTE.brass }}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
          <Side title="Incident A" side={cmp?.a} />
          <Side title="Incident B" side={cmp?.b} />
        </div>
      </div>
    </div>
  )
}

function Side({
  title,
  side,
}: {
  title: string
  side?: MoComparison['a']
}) {
  const mo = (side?.mo || {}) as Record<string, unknown>
  const weapons = (mo.weapons as string[]) || []
  const aliases = (mo.suspect_aliases as string[]) || []
  const methods = (mo.mo_methods as string[]) || []
  const vehicles = (mo.vehicles as string[]) || []

  return (
    <div className="border-t border-rule p-4 md:border-t-0 md:odd:border-r">
      <div className="label-brass mb-2">{title}</div>
      <div className="mb-2 text-[0.85rem] text-khaki">{side?.district || '—'}</div>
      <div className="label mb-1" style={{ fontSize: 9 }}>
        {side?.crime_head || side?.id || ''}
      </div>
      <p
        className="mb-3 text-[0.78rem] leading-relaxed text-khaki-dim"
        style={{ fontFamily: "'Noto Serif Kannada', serif" }}
      >
        {side?.narrative || 'No narrative'}
      </p>
      <Row label="Aliases" values={aliases} />
      <Row label="Weapons" values={weapons} />
      <Row label="Vehicles" values={vehicles} />
      <Row label="MO methods" values={methods} />
    </div>
  )
}

function Row({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mb-2">
      <div className="label" style={{ fontSize: 9 }}>
        {label}
      </div>
      <div className="text-[0.76rem] text-khaki">
        {values.length ? values.join(' · ') : '—'}
      </div>
    </div>
  )
}
