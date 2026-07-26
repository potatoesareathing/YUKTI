import { useId, useMemo, useState } from 'react'
import { line as d3line, area as d3area, curveMonotoneX } from 'd3-shape'
import { scaleLinear } from 'd3-scale'
import { extent, max as d3max } from 'd3-array'
import { PALETTE, riskCss } from '@/lib/palette'
import { monthLabel, shortDate } from '@/lib/format'
import type { TrendSeries } from '@/data/types'

/**
 * Charts for the platform.
 *
 * Two decisions shape everything here.
 *
 * 1. STL output is drawn as SMALL MULTIPLES, not four overlaid lines. That is how
 *    a decomposition is conventionally read — each component against its own
 *    baseline — and it means every panel carries exactly one series. One series
 *    needs no legend and no categorical palette, so the "which colour was
 *    seasonal again?" problem never arises.
 *
 * 2. Category comparisons are single-hue. Their job is magnitude, and magnitude
 *    is carried by length; giving eight crime categories eight hues would add an
 *    identity encoding nothing is asking for, and eight hues cannot be separated
 *    reliably for a colour-blind reader anyway. Labels carry identity.
 *
 * Colour that does appear is doing one of two jobs: the sequential risk ramp, or
 * the reserved alert red — and the alert red never travels without its ▲ glyph
 * and a text label beside it.
 */

const AXIS = PALETTE.rule2
const INK_MUTED = PALETTE.khakiDim

/* ── Sparkline ─────────────────────────────────────────────────────────────── */

export function Sparkline({
  values,
  width = 96,
  height = 22,
  color = PALETTE.brass,
  showLast = true,
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  showLast?: boolean
}) {
  const path = useMemo(() => {
    if (values.length < 2) return null
    const x = scaleLinear().domain([0, values.length - 1]).range([1, width - 1])
    const [lo, hi] = extent(values) as [number, number]
    const y = scaleLinear().domain([lo, hi || lo + 1]).range([height - 2, 2])
    return {
      d: d3line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX)(values) ?? '',
      lastX: x(values.length - 1),
      lastY: y(values[values.length - 1]),
    }
  }, [values, width, height])

  if (!path) return null

  return (
    <svg width={width} height={height} role="img" aria-hidden className="overflow-visible">
      <path d={path.d} fill="none" stroke={color} strokeWidth={1.5} />
      {showLast && <circle cx={path.lastX} cy={path.lastY} r={2} fill={color} />}
    </svg>
  )
}

/* ── STL small multiples with CUSUM breaches ───────────────────────────────── */

type Component = 'value' | 'trend' | 'seasonal' | 'residual'

const COMPONENT_META: Record<Component, { label: string; note: string; color: string }> = {
  value: { label: 'Observed', note: 'Weekly recorded incidents', color: PALETTE.khaki },
  trend: { label: 'Trend', note: 'Loess-smoothed level', color: PALETTE.brass },
  seasonal: { label: 'Seasonal', note: 'Annual cycle', color: PALETTE.bhuvan },
  residual: { label: 'Residual', note: 'What CUSUM monitors', color: PALETTE.khakiDim },
}

interface StlChartProps {
  series: TrendSeries
  height?: number
  components?: Component[]
}

export function StlChart({
  series,
  height = 62,
  components = ['value', 'trend', 'seasonal', 'residual'],
}: StlChartProps) {
  return (
    <div className="flex flex-col">
      {components.map((c, i) => (
        <StlPanel
          key={c}
          series={series}
          component={c}
          height={height}
          showAxis={i === components.length - 1}
        />
      ))}
    </div>
  )
}

function StlPanel({
  series,
  component,
  height,
  showAxis,
}: {
  series: TrendSeries
  component: Component
  height: number
  showAxis: boolean
}) {
  const meta = COMPONENT_META[component]
  const [hover, setHover] = useState<number | null>(null)
  const clipId = useId()

  const W = 100 // viewBox units; the SVG scales to its container
  const pad = { t: 6, b: showAxis ? 14 : 6 }

  const geom = useMemo(() => {
    const values = series.points.map((p) => p[component])
    const x = scaleLinear().domain([0, values.length - 1]).range([0, W])
    const [lo, hi] = extent(values) as [number, number]
    const span = hi - lo || 1
    const y = scaleLinear().domain([lo - span * 0.1, hi + span * 0.1]).range([height - pad.b, pad.t])

    return {
      values,
      x,
      y,
      d: d3line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX)(values) ?? '',
      areaD:
        d3area<number>()
          .x((_, i) => x(i))
          .y0(y(Math.max(lo - span * 0.1, Math.min(0, hi))))
          .y1((v) => y(v))
          .curve(curveMonotoneX)(values) ?? '',
      zero: y(0),
    }
  }, [series, component, height, pad.b])

  // Only the residual panel shows control limits — that is the series CUSUM runs
  // on, and drawing limits over the observed series would imply otherwise.
  const isResidual = component === 'residual'

  return (
    <div className="relative border-b border-rule/50 last:border-0">
      {/* Breach markers, in real pixels rather than stretched viewBox units. */}
      <div className="pointer-events-none absolute inset-x-0" style={{ top: 22, height: 8 }} aria-hidden>
        {series.breaches.map((b) => (
          <span
            key={b}
            className="absolute"
            style={{
              left: `${(b / (series.points.length - 1)) * 100}%`,
              transform: 'translateX(-50%)',
              color: PALETTE.redzone,
              fontSize: 8,
              lineHeight: 1,
            }}
          >
            ▲
          </span>
        ))}
      </div>

      <div className="flex items-baseline justify-between px-3 pt-2">
        <span className="label" style={{ color: meta.color }}>
          {meta.label}
        </span>
        <span className="label" style={{ fontSize: 9, opacity: 0.65 }}>
          {meta.note}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        role="img"
        aria-label={`${meta.label}: ${meta.note}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const i = Math.round(((e.clientX - r.left) / r.width) * (geom.values.length - 1))
          setHover(Math.max(0, Math.min(geom.values.length - 1, i)))
        }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={W} height={height} />
          </clipPath>
        </defs>

        {isResidual && (
          <>
            <line
              x1={0}
              x2={W}
              y1={geom.zero}
              y2={geom.zero}
              stroke={AXIS}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {[1, -1].map((sign) => (
              <line
                key={sign}
                x1={0}
                x2={W}
                y1={geom.y(sign * series.controlLimit)}
                y2={geom.y(sign * series.controlLimit)}
                stroke={PALETTE.redzone}
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </>
        )}

        <g clipPath={`url(#${clipId})`}>
          {component === 'value' && <path d={geom.areaD} fill={meta.color} opacity={0.07} />}
          <path
            d={geom.d}
            fill="none"
            stroke={meta.color}
            strokeWidth={component === 'trend' ? 2 : 1.4}
            vectorEffect="non-scaling-stroke"
          />
        </g>

        {/* CUSUM breaches. Only the vertical rule lives in the SVG — the viewBox
            uses preserveAspectRatio="none" so the x axis is stretched to the
            container, and any glyph drawn here is stretched with it. The
            triangles are DOM, positioned by percentage, below. */}
        {series.breaches.map((b) => (
          <line
            key={b}
            x1={geom.x(b)}
            x2={geom.x(b)}
            y1={pad.t}
            y2={height - pad.b}
            stroke={PALETTE.redzone}
            strokeWidth={1}
            opacity={0.45}
            // Without this the 100-unit viewBox stretched to ~1100px turns a
            // 0.5-unit rule into a 5px slab.
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hover !== null && (
          <>
            <line
              x1={geom.x(hover)}
              x2={geom.x(hover)}
              y1={pad.t}
              y2={height - pad.b}
              stroke={PALETTE.brass}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}

        {showAxis && (
          <>
            <line
              x1={0}
              x2={W}
              y1={height - pad.b + 3}
              y2={height - pad.b + 3}
              stroke={AXIS}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {/* Readout sits outside the SVG so it uses real type, not scaled text. */}
      {showAxis && (
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="label" style={{ fontSize: 9 }}>
            {monthLabel(new Date(series.points[0].at))}
          </span>
          <span className="tnum" style={{ fontSize: 10, color: hover !== null ? PALETTE.brass : INK_MUTED }}>
            {hover !== null
              ? `${shortDate(new Date(series.points[hover].at))} · ${series.points[hover][component].toFixed(1)}`
              : `${series.breaches.length} breach${series.breaches.length === 1 ? '' : 'es'}`}
          </span>
          <span className="label" style={{ fontSize: 9 }}>
            {monthLabel(new Date(series.points[series.points.length - 1].at))}
          </span>
        </div>
      )}
    </div>
  )
}

/* ── Ranked magnitude bars — single hue, labels carry identity ─────────────── */

export function RankedBars({
  rows,
  colorBy,
  format = (n) => n.toLocaleString('en-IN'),
  onSelect,
  selected,
}: {
  rows: { key: string; label: string; value: number; risk?: number; flag?: boolean }[]
  /** 'risk' uses the sequential ramp; otherwise a single brass hue. */
  colorBy?: 'risk'
  format?: (n: number) => string
  onSelect?: (key: string) => void
  selected?: string | null
}) {
  const peak = d3max(rows, (r) => r.value) ?? 1

  return (
    <ul className="divide-y divide-rule/50">
      {rows.map((r) => {
        const color = colorBy === 'risk' && r.risk !== undefined ? riskCss(r.risk) : PALETTE.brass
        const active = selected === r.key
        const Row = onSelect ? 'button' : 'div'
        return (
          <li key={r.key}>
            <Row
              onClick={onSelect ? () => onSelect(r.key) : undefined}
              className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-brass/[0.06]"
              style={{ background: active ? 'rgba(201,162,39,0.1)' : undefined }}
              aria-pressed={onSelect ? active : undefined}
            >
              <span
                className="w-32 shrink-0 truncate text-[0.78rem]"
                style={{ color: active ? PALETTE.brassLit : PALETTE.khaki }}
              >
                {r.label}
              </span>

              <span className="relative min-w-0 flex-1">
                <span className="block h-[5px] w-full bg-rule/60">
                  <span
                    className="block h-full"
                    style={{
                      width: `${(r.value / peak) * 100}%`,
                      background: color,
                      // 4px rounded data-end, anchored at the baseline.
                      borderRadius: '0 2px 2px 0',
                      transition: 'width .4s cubic-bezier(.16,1,.3,1)',
                    }}
                  />
                </span>
              </span>

              {r.flag && (
                <span className="tnum shrink-0" style={{ color: PALETTE.redzone, fontSize: 10 }} title="Red zone">
                  ▲
                </span>
              )}
              <span className="tnum w-16 shrink-0 text-right" style={{ fontSize: 11, color: PALETTE.khaki }}>
                {format(r.value)}
              </span>
            </Row>
          </li>
        )
      })}
    </ul>
  )
}

/* ── Risk gauge — a single hero figure, not a chart ────────────────────────── */

export function RiskGauge({ score, band, size = 132 }: { score: number; band: string; size?: number }) {
  const r = size / 2 - 10
  const c = size / 2
  // 240° sweep, opening downward — a dial face, not a doughnut.
  const START = Math.PI * 0.75
  const SWEEP = Math.PI * 1.5
  const color = riskCss(score)

  const arc = (from: number, to: number) => {
    const p = (a: number) => [c + r * Math.cos(a), c + r * Math.sin(a)]
    const [x0, y0] = p(START + SWEEP * from)
    const [x1, y1] = p(START + SWEEP * to)
    return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x1} ${y1}`
  }

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.82} viewBox={`0 0 ${size} ${size * 0.82}`} role="img"
        aria-label={`Relative risk ${(score * 100).toFixed(0)} of 100, band ${band}`}>
        <path d={arc(0, 1)} fill="none" stroke={PALETTE.rule} strokeWidth={5} strokeLinecap="butt" />
        <path d={arc(0, score)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="butt" />
        {/* Graduations every 10 — the dial reads like an instrument face. */}
        {Array.from({ length: 11 }, (_, i) => i / 10).map((t) => {
          const a = START + SWEEP * t
          const inner = r - (t * 10) % 5 === 0 ? r - 9 : r - 6
          return (
            <line
              key={t}
              x1={c + inner * Math.cos(a)}
              y1={c + inner * Math.sin(a)}
              x2={c + (r - 12) * Math.cos(a)}
              y2={c + (r - 12) * Math.sin(a)}
              stroke={AXIS}
              strokeWidth={0.8}
            />
          )
        })}
        <text
          x={c}
          y={c + 2}
          textAnchor="middle"
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 26, fill: color, fontVariantNumeric: 'tabular-nums' }}
        >
          {(score * 100).toFixed(0)}
        </text>
        <text
          x={c}
          y={c + 17}
          textAnchor="middle"
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, fill: INK_MUTED, letterSpacing: '0.18em' }}
        >
          {band.toUpperCase()}
        </text>
      </svg>
    </div>
  )
}

/* ── Scatter: socio-economic vs risk (§7.3) ────────────────────────────────── */

export function CorrelationScatter({
  points,
  xLabel,
  yLabel,
  onSelect,
  selected,
  height = 260,
}: {
  points: { key: string; x: number; y: number; risk: number; label: string }[]
  xLabel: string
  yLabel: string
  onSelect?: (key: string) => void
  selected?: string | null
  height?: number
}) {
  const [hover, setHover] = useState<string | null>(null)
  const W = 320
  const pad = { l: 34, r: 12, t: 12, b: 28 }

  const { xs, ys, fit } = useMemo(() => {
    const xd = extent(points, (p) => p.x) as [number, number]
    const yd = extent(points, (p) => p.y) as [number, number]
    const xs = scaleLinear().domain(xd).nice().range([pad.l, W - pad.r])
    const ys = scaleLinear().domain(yd).nice().range([height - pad.b, pad.t])

    // Ordinary least squares. §7.3 is explicit that these are correlations
    // presented for interpretation, never causal claims — so the line is drawn
    // faintly and labelled with r, not with a conclusion.
    const n = points.length
    const mx = points.reduce((a, p) => a + p.x, 0) / n
    const my = points.reduce((a, p) => a + p.y, 0) / n
    const sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0)
    const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0)
    const syy = points.reduce((a, p) => a + (p.y - my) ** 2, 0)
    const slope = sxx ? sxy / sxx : 0
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
    const [x0, x1] = xd
    return {
      xs,
      ys,
      fit: { x0, y0: my + slope * (x0 - mx), x1, y1: my + slope * (x1 - mx), r },
    }
  }, [points, height, pad.l, pad.r, pad.t, pad.b])

  const active = hover ?? selected

  return (
    <div>
      {/* preserveAspectRatio must stay at the default meet: the marks are circles,
          and letting the viewBox stretch to the container width turns every point
          into an ellipse and the axis type into a distorted smear. */}
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height, display: 'block' }}
        role="img"
        aria-label={`${yLabel} against ${xLabel}, ${points.length} districts, r = ${fit.r.toFixed(2)}`}
      >
        <line x1={pad.l} x2={W - pad.r} y1={height - pad.b} y2={height - pad.b} stroke={AXIS} strokeWidth={0.6} />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={height - pad.b} stroke={AXIS} strokeWidth={0.6} />

        <line
          x1={xs(fit.x0)}
          y1={ys(fit.y0)}
          x2={xs(fit.x1)}
          y2={ys(fit.y1)}
          stroke={PALETTE.brass}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.5}
        />

        {points.map((p) => {
          const on = active === p.key
          return (
            <circle
              key={p.key}
              cx={xs(p.x)}
              cy={ys(p.y)}
              r={on ? 6 : 4.2}
              fill={riskCss(p.risk)}
              stroke={on ? PALETTE.brassLit : PALETTE.slate}
              strokeWidth={on ? 1.4 : 1}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(p.key)}
              onMouseLeave={() => setHover(null)}
              onClick={onSelect ? () => onSelect(p.key) : undefined}
            >
              <title>{`${p.label} — ${xLabel} ${p.x}, ${yLabel} ${p.y}`}</title>
            </circle>
          )
        })}

        <text x={W / 2} y={height - 6} textAnchor="middle"
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, fill: INK_MUTED, letterSpacing: '0.14em' }}>
          {xLabel.toUpperCase()}
        </text>
        <text x={9} y={height / 2} textAnchor="middle" transform={`rotate(-90 9 ${height / 2})`}
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, fill: INK_MUTED, letterSpacing: '0.14em' }}>
          {yLabel.toUpperCase()}
        </text>
      </svg>

      <div className="flex items-center justify-between px-1 pt-1">
        <span className="tnum" style={{ fontSize: 10, color: PALETTE.brass }}>
          r = {fit.r.toFixed(2)}
        </span>
        <span className="label" style={{ fontSize: 9 }}>
          {active ? points.find((p) => p.key === active)?.label : 'Correlation, not causation'}
        </span>
      </div>
    </div>
  )
}
