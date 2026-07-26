/** Presentation formatting. Indian numbering, because this is an Indian system. */

/** 1,23,456 — lakh/crore grouping, not thousands grouping. */
export function inr(n: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(n))
}

/** Compact for tight readouts: 12.3k, 1.4L */
export function compact(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export const pct = (t: number, digits = 0) => `${(t * 100).toFixed(digits)}%`

/** Signed delta, for trend comparisons. */
export function delta(t: number): string {
  const s = (t * 100).toFixed(1)
  return `${t >= 0 ? '+' : ''}${s}%`
}

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]

export function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function shortDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`
}

/** 24h clock — police records do not use AM/PM. */
export function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')} hrs`
}

/**
 * Docket reference in the shape CCTNS uses. Purely presentational — it makes the
 * synthetic records legible as police records rather than as rows in a table.
 */
export function docket(kind: 'FIR' | 'CASE' | 'PER' | 'ALT', n: number, year = 2026): string {
  return `${kind}/${String(n).padStart(5, '0')}/${year}`
}
