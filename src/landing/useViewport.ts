import { useEffect, useState } from 'react'

/**
 * Whether the viewport is too narrow for the split composition.
 *
 * Act I frames the state right-of-centre so the headline has clear ground on the
 * left. On a phone there is no left third — the copy spans the full width — so
 * the same framing pushes Karnataka off the edge and puts the map underneath the
 * text. Below this breakpoint the camera centres instead and the scrim goes
 * near-solid.
 */
export function useIsNarrow(breakpoint = 900): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoint,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => setNarrow(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [breakpoint])

  return narrow
}
