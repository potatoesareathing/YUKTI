import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, ShaderMaterial } from 'three'
import { PALETTE } from '@/lib/palette'
import { NOW, PERIOD_DAYS } from '@/data/districts'
import { sceneClock } from './clock'
import type { Incident } from '@/data/types'

/**
 * Individual incident records as points above the map.
 *
 * Colour carries one bit only: whether the AI/ML layer flagged the record as
 * out-of-pattern (§8, Isolation Forest). Flagged records are red and larger;
 * everything else is a quiet cool dot. Colouring by category instead would put
 * eight hues on the map and make the anomalies — the thing an analyst is
 * actually scanning for — impossible to pick out.
 *
 * Reveal runs either spatially (the west→east sweep in Act I) or temporally
 * (chronological playback in MOD-01), selected by `revealMode`.
 */

const PERIOD_MS = PERIOD_DAYS * 864e5

const vertexShader = /* glsl */ `
  attribute float aAnomaly;
  attribute float aTime;
  attribute float aSeed;
  uniform float uReveal;
  uniform float uRevealMode;   // 0 = spatial (world X), 1 = temporal
  uniform float uSweepMin;
  uniform float uSweepMax;
  uniform float uSize;
  uniform float uTime;
  varying float vAnomaly;
  varying float vFade;

  void main() {
    vAnomaly = aAnomaly;

    // How far past the reveal front this point sits, normalised.
    float axis = mix((position.x - uSweepMin) / (uSweepMax - uSweepMin), aTime, uRevealMode);
    float behind = uReveal - axis;
    vFade = smoothstep(0.0, 0.045, behind);

    vec3 p = position;
    // Points pop up as the front passes, then settle.
    p.y += (1.0 - vFade) * 3.0 + sin(uTime * 0.7 + aSeed * 6.28) * 0.12 * aAnomaly;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = uSize * (1.0 + aAnomaly * 1.6);
    gl_PointSize = size * (34.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uFlag;
  uniform float uOpacity;
  uniform float uTime;
  varying float vAnomaly;
  varying float vFade;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    if (r > 0.5) discard;

    // Soft core with a harder centre — reads as a plotted mark, not a blob.
    float core = 1.0 - smoothstep(0.0, 0.22, r);
    float halo = 1.0 - smoothstep(0.1, 0.5, r);

    vec3 col = mix(uBase, uFlag, vAnomaly);
    float pulse = 1.0 + vAnomaly * 0.5 * sin(uTime * 3.0);
    float a = (core * 0.95 + halo * 0.4) * uOpacity * vFade * pulse;

    if (a < 0.01) discard;
    gl_FragColor = vec4(col * (0.7 + core * 0.8), a);
  }
`

interface IncidentFieldProps {
  incidents: Incident[]
  /** 0..1 reveal front. 1 shows everything. */
  reveal?: number
  /**
   * 'clock' takes the front from the shared sweep, so points light up as the
   * sweep line passes them without any per-frame React work.
   */
  revealSource?: 'prop' | 'clock'
  revealMode?: 'spatial' | 'temporal'
  opacity?: number
  size?: number
  height?: number
}

export function IncidentField({
  incidents,
  reveal = 1,
  revealSource = 'prop',
  revealMode = 'spatial',
  opacity = 1,
  size = 2.2,
  height = 0.9,
}: IncidentFieldProps) {
  const material = useRef<ShaderMaterial>(null)

  const geometry = useMemo(() => {
    const n = incidents.length
    const pos = new Float32Array(n * 3)
    const anomaly = new Float32Array(n)
    const time = new Float32Array(n)
    const seed = new Float32Array(n)

    incidents.forEach((inc, i) => {
      pos[i * 3] = inc.world[0]
      pos[i * 3 + 1] = height
      pos[i * 3 + 2] = inc.world[1]
      anomaly[i] = inc.anomaly ? 1 : 0
      time[i] = 1 - (NOW - inc.at) / PERIOD_MS
      seed[i] = (i % 97) / 97
    })

    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('aAnomaly', new Float32BufferAttribute(anomaly, 1))
    g.setAttribute('aTime', new Float32BufferAttribute(time, 1))
    g.setAttribute('aSeed', new Float32BufferAttribute(seed, 1))
    return g
  }, [incidents, height])

  const uniforms = useMemo(
    () => ({
      uReveal: { value: reveal },
      uRevealMode: { value: revealMode === 'temporal' ? 1 : 0 },
      uSweepMin: { value: -62 },
      uSweepMax: { value: 62 },
      uSize: { value: size },
      uTime: { value: 0 },
      uBase: { value: new Color(PALETTE.bhuvan) },
      uFlag: { value: new Color(PALETTE.redzone) },
      uOpacity: { value: opacity },
    }),
    // Uniform objects are mutated in useFrame rather than rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame((state) => {
    const m = material.current
    if (!m) return
    m.uniforms.uTime.value = state.clock.elapsedTime
    // Whichever front is further along wins, so scrolling past the sweep does
    // not hide points the sweep already revealed.
    m.uniforms.uReveal.value =
      revealSource === 'clock' ? Math.max(sceneClock.sweep, reveal) : reveal
    m.uniforms.uRevealMode.value = revealMode === 'temporal' ? 1 : 0
    m.uniforms.uOpacity.value = opacity
    m.uniforms.uSize.value = size
  })

  if (!incidents.length) return null

  return (
    <points geometry={geometry} renderOrder={3}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  )
}
