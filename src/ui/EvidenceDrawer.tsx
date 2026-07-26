import { useEffect, useRef } from 'react'
import { useYukti } from '@/store/useYukti'
import type { Evidence } from '@/data/types'

/**
 * The evidence drawer — §10.3 made operable.
 *
 * "Every prediction surfaced to an investigator links back to the underlying
 * records that produced it." That sentence is a UI requirement, and this is the
 * component that satisfies it. Every risk score, anomaly flag and cluster in the
 * platform opens this drawer, and the drawer never opens empty: `Evidence[]` is
 * non-optional on the types that feed it.
 */

const KIND_LABEL: Record<Evidence['kind'], string> = {
  incident: 'FIR record',
  person: 'Person record',
  series: 'Time series',
  feature: 'Model feature',
}

export function EvidenceDrawer() {
  const evidence = useYukti((s) => s.evidence)
  const close = useYukti((s) => s.closeEvidence)
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!evidence) return
    restoreTo.current = document.activeElement as HTMLElement
    panel.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreTo.current?.focus?.()
    }
  }, [evidence, close])

  if (!evidence) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Supporting evidence">
      <button
        className="absolute inset-0 bg-ink/72 backdrop-blur-[2px]"
        onClick={close}
        aria-label="Close evidence"
        tabIndex={-1}
      />

      <div
        ref={panel}
        tabIndex={-1}
        className="plate ticked relative flex h-full w-full max-w-md flex-col border-l anim-in"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-rule px-5 py-4">
          <div className="min-w-0">
            <div className="label-brass mb-1.5">Supporting evidence</div>
            <h2
              className="truncate text-khaki"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontSize: '1.2rem', fontWeight: 600 }}
            >
              {evidence.title}
            </h2>
            <p className="mt-1 text-[0.78rem] text-khaki-dim">{evidence.subtitle}</p>
          </div>
          <button
            onClick={close}
            className="label shrink-0 border border-rule px-2 py-1 transition-colors hover:border-brass hover:text-brass"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ol className="divide-y divide-rule/60">
            {evidence.items.map((item, i) => (
              <li key={`${item.ref}-${i}`} className="px-5 py-3.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className="label-brass" style={{ fontSize: 9 }}>
                    {KIND_LABEL[item.kind]}
                  </span>
                  <span className="tnum shrink-0 text-khaki-dim" style={{ fontSize: 10 }}>
                    {item.ref}
                  </span>
                </div>
                <div className="tnum mb-1 text-[0.86rem] text-khaki">{item.label}</div>
                <p className="text-[0.8rem] leading-relaxed text-khaki-dim">{item.detail}</p>
              </li>
            ))}
          </ol>
        </div>

        <footer className="shrink-0 border-t border-rule px-5 py-3.5">
          <p className="text-[0.74rem] leading-relaxed text-khaki-dim">
            This output is a decision-support signal, not a determination. Acting on it — questioning,
            surveillance, or further investigation — requires sign-off by an authorised officer with this
            evidence attached. Access to this record is logged.
          </p>
        </footer>
      </div>
    </div>
  )
}

/** Opens the drawer. Every model-output surface in the platform goes through this. */
export function useEvidence() {
  return useYukti((s) => s.openEvidence)
}
