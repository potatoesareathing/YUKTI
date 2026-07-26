/**
 * Deterministic pseudo-random generation.
 *
 * Every figure in YUKTI's demo dataset is synthetic. It must also be *stable*:
 * a judge reloading the page must see the same Kalaburagi risk score they saw a
 * minute ago, and the same district must sit in the same network cluster. So we
 * never touch Math.random — everything derives from a named seed.
 */

/** mulberry32 — small, fast, good enough distribution for synthetic data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — turns a stable string key ("Bengaluru Urban") into a stable seed. */
export function hashSeed(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A named generator. `rng('incidents:Mysuru')` always yields the same stream. */
export function seeded(key: string): () => number {
  return mulberry32(hashSeed(key))
}

export type Rng = () => number

export const randRange = (r: Rng, min: number, max: number) => min + r() * (max - min)

export const randInt = (r: Rng, min: number, max: number) =>
  Math.floor(min + r() * (max - min + 1))

export const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]

/** Weighted pick. Weights need not sum to 1. */
export function pickWeighted<T>(r: Rng, xs: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let t = r() * total
  for (let i = 0; i < xs.length; i++) {
    t -= weights[i]
    if (t <= 0) return xs[i]
  }
  return xs[xs.length - 1]
}

/** Box–Muller. Crime counts cluster around a mean rather than spreading flat. */
export function gaussian(r: Rng, mean = 0, sd = 1): number {
  let u = 0
  let v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
