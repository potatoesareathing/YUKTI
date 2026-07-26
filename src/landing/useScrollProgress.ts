import { useEffect, useRef, useState } from 'react'

/**
 * Scroll position as a 0..1 value, sampled on rAF rather than on the scroll
 * event.
 *
 * Scroll events fire faster than frames on most trackpads; reading layout on
 * each one both wastes work and forces reflow. Sampling once per frame gives the
 * 3D scene exactly the cadence it can use.
 */
export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0)
  const raf = useRef(0)
  const last = useRef(-1)

  useEffect(() => {
    const tick = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
      // Only re-render on a change the eye could resolve.
      if (Math.abs(p - last.current) > 0.0008) {
        last.current = p
        setProgress(p)
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  return progress
}

/** Remap `p` from [a,b] into [0,1], clamped outside the band. */
export function band(p: number, a: number, b: number): number {
  if (b <= a) return 0
  return Math.min(1, Math.max(0, (p - a) / (b - a)))
}

/** Smootherstep — flatter at both ends than smoothstep, so acts settle. */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/** 0 outside [a,b], rising to 1 in the middle — used for act-local overlays. */
export function window01(p: number, a: number, b: number, fade = 0.14): number {
  if (p < a || p > b) return 0
  const inRamp = Math.min(1, (p - a) / fade)
  const outRamp = Math.min(1, (b - p) / fade)
  return Math.min(inRamp, outRamp)
}
