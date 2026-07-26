import { Color } from 'three'

/**
 * The palette, mirrored from globals.css so three.js materials and DOM stay in
 * lockstep. Change a value here and it must change there too — these are the
 * same design tokens expressed in two runtimes.
 */
export const PALETTE = {
  ink: '#070A0F',
  ink2: '#0B111A',
  slate: '#101823',
  rule: '#1E2A38',
  rule2: '#2A3A4C',
  brass: '#C9A227',
  brassDim: '#8A701A',
  brassLit: '#F0D072',
  khaki: '#DCD3BE',
  khakiDim: '#8D8877',
  bhuvan: '#4C9FC0',
  bhuvanDim: '#2B6076',
  redzone: '#FF3B2F',
} as const

/**
 * Sequential risk ramp — cool → hot, and monotonically LIGHTER with magnitude
 * (OKLab L: 0.411 → 0.628 → 0.653 → 0.706).
 *
 * That second property is the one that matters and the one that is easy to get
 * wrong. The obvious cool-to-red ramp puts its lightest step in the middle,
 * because mid-brass is brighter than deep red: mid-risk districts then pull the
 * eye harder than critical ones, and the encoding inverts in greyscale, in print
 * and for a colour-blind reader. Stepping lightness upward with risk keeps
 * magnitude readable even if hue is lost entirely.
 *
 * Not a rainbow: a rainbow implies categories, and risk is a magnitude.
 *
 * Note that `redzone` (#FF3B2F) is deliberately NOT the top of this ramp. It is
 * a reserved status colour for a CUSUM breach and always ships with the ▲ glyph
 * and a text label, so it can never be confused with "merely high".
 */
export const RISK_RAMP = ['#22525F', '#A8822A', '#DD6A2F', '#FF6B45'] as const

const RAMP_COLORS = RISK_RAMP.map((c) => new Color(c))

/** Interpolate the risk ramp. `t` is clamped to 0..1. Returns a new Color. */
export function riskColor(t: number): Color {
  const x = Math.max(0, Math.min(1, t)) * (RAMP_COLORS.length - 1)
  const i = Math.min(Math.floor(x), RAMP_COLORS.length - 2)
  return new Color().copy(RAMP_COLORS[i]).lerp(RAMP_COLORS[i + 1], x - i)
}

/** Same ramp as a CSS string, for DOM elements that must match the 3D scene. */
export function riskCss(t: number): string {
  return `#${riskColor(t).getHexString()}`
}

export type RiskBand = 'low' | 'moderate' | 'high' | 'critical'

export function riskBand(t: number): RiskBand {
  if (t < 0.35) return 'low'
  if (t < 0.6) return 'moderate'
  if (t < 0.82) return 'high'
  return 'critical'
}

export const BAND_LABEL: Record<RiskBand, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  critical: 'Critical',
}

/** Categorical series colours, for charts with more than one line. */
export const SERIES = [
  PALETTE.brass,
  PALETTE.bhuvan,
  '#9C7BB8',
  '#6FAE7E',
  '#D8845A',
  PALETTE.khakiDim,
] as const

/** Entity-kind accents, used by the node inspector and the detail layer. */
export const KIND_COLOR: Record<string, string> = {
  Organisation: PALETTE.brassLit,
  Person: PALETTE.brass,
  Location: '#A98A2E',
  Incident: '#7E93A3',
  Vehicle: '#6A6356',
}
