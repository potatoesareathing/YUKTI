import { useEffect, useState } from 'react'
import { AskPanel } from '@/ui/AskPanel'

/**
 * The assistant's home on the platform.
 *
 * It is mounted beside the evidence drawer rather than added to MODULES,
 * because it is not a seventh module: §3.1 defines six, and the assistant cuts
 * across all of them. An officer reading the hotspot map and an officer reading
 * the anomaly queue have the same kind of question, and should not have to
 * navigate away from either to ask it.
 *
 * Collapsed it is a tab on the right edge; open it is a column that does not
 * take the scene with it. `\` toggles — the one key on the row that the module
 * number shortcuts (1–6) have not already claimed.
 */
export function AskDock() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (e.key === 'Escape' && open && !typing) {
        setOpen(false)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return
      if (e.key === '\\') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        title="Ask (\)"
        className="label fixed right-0 top-1/2 z-30 -translate-y-1/2 border border-r-0 border-rule bg-ink/92 px-2 py-4 text-khaki-dim backdrop-blur transition-colors hover:border-brass hover:text-brass"
        style={{ writingMode: 'vertical-rl' }}
      >
        ASK
      </button>
    )
  }

  return (
    <aside
      className="fixed right-0 top-0 z-30 flex h-[100svh] w-full max-w-[420px] flex-col border-l border-rule bg-ink/95 backdrop-blur"
      aria-label="Assistant"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-rule px-3 py-2">
        <span className="label-brass">Assistant</span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close the assistant"
          className="label px-2 py-1 text-khaki-dim transition-colors hover:text-brass"
        >
          CLOSE
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <AskPanel />
      </div>
    </aside>
  )
}
