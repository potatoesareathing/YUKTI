import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  DataTexture,
  LinearFilter,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Color,
  AdditiveBlending,
} from 'three'
import { PLANE_SIZE } from '@/lib/geo'
import { RISK_RAMP, PALETTE } from '@/lib/palette'
import type { Incident } from '@/data/types'

/**
 * Kernel Density Estimation over incident locations (§7.4, §8).
 *
 * This is the real estimator, not a blur: a Gaussian kernel is accumulated over
 * a regular grid on the CPU, normalised, and uploaded as a single-channel
 * texture. Changing the bandwidth changes the estimate the way it does in the
 * statistics, and the density value under any point on the map is a number the
 * UI could quote.
 *
 * It renders as a filled surface WITH iso-contours rather than as a smooth
 * heat blur. Contours are how density is drawn on a survey sheet, they make
 * gradient steepness legible — a tight contour band means density is climbing
 * fast — and they keep the layer readable when it sits over extruded geometry.
 */

const RES = 224
const HALF = PLANE_SIZE / 2

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uDensity;
  uniform vec3 uRamp[4];
  uniform vec3 uContour;
  uniform float uOpacity;
  uniform float uThreshold;
  uniform float uContourCount;
  uniform float uTime;
  varying vec2 vUv;

  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0) * 3.0;
    if (t < 1.0) return mix(uRamp[0], uRamp[1], t);
    if (t < 2.0) return mix(uRamp[1], uRamp[2], t - 1.0);
    return mix(uRamp[2], uRamp[3], t - 2.0);
  }

  void main() {
    float d = texture2D(uDensity, vUv).r;
    if (d < uThreshold) discard;

    // Perceptual lift: raw KDE output is extremely peaked, and a linear map
    // leaves everything outside the top city invisible.
    float t = pow(smoothstep(uThreshold, 1.0, d), 0.55);

    vec3 col = ramp(t);

    // Iso-contours. Band edges are where the density crosses each level.
    float bands = t * uContourCount;
    float edge = abs(fract(bands) - 0.5) * 2.0;
    float line = 1.0 - smoothstep(0.82, 0.99, edge);
    col = mix(col, uContour, line * 0.55);

    // A slow breath on the highest band only — the live-instrument tell.
    float pulse = smoothstep(0.82, 1.0, t) * (0.5 + 0.5 * sin(uTime * 1.6));

    float alpha = uOpacity * (0.16 + t * 0.72 + line * 0.22 + pulse * 0.18);
    gl_FragColor = vec4(col * (0.85 + pulse * 0.5), alpha);
  }
`

interface HotspotLayerProps {
  incidents: Incident[]
  /** Kernel bandwidth in world units. Larger = smoother estimate. */
  bandwidth?: number
  opacity?: number
  /** Density below this fraction of the peak is not drawn. */
  threshold?: number
  height?: number
}

export function HotspotLayer({
  incidents,
  bandwidth = 2.6,
  opacity = 1,
  threshold = 0.06,
  height = 0.35,
}: HotspotLayerProps) {
  const material = useRef<ShaderMaterial>(null)

  const texture = useMemo(() => {
    const grid = new Float32Array(RES * RES)
    const cell = PLANE_SIZE / RES
    // Truncate the kernel at 3σ — beyond that the contribution is under 1%.
    const radius = Math.max(1, Math.ceil((bandwidth * 3) / cell))
    const inv2s2 = 1 / (2 * bandwidth * bandwidth)

    for (const inc of incidents) {
      // The plane is rotated -90° about X, which flips V against world Z:
      // u = (x + HALF) / SIZE, v = (HALF - z) / SIZE. DataTexture does not
      // flipY, so grid row 0 is v = 0 and this mapping is used directly.
      const gx = Math.round((inc.world[0] + HALF) / cell)
      const gy = Math.round((HALF - inc.world[1]) / cell)

      for (let dy = -radius; dy <= radius; dy++) {
        const y = gy + dy
        if (y < 0 || y >= RES) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const x = gx + dx
          if (x < 0 || x >= RES) continue
          const wx = dx * cell
          const wy = dy * cell
          grid[y * RES + x] += Math.exp(-(wx * wx + wy * wy) * inv2s2)
        }
      }
    }

    let peak = 0
    for (let i = 0; i < grid.length; i++) peak = Math.max(peak, grid[i])

    const bytes = new Uint8Array(RES * RES)
    if (peak > 0) {
      for (let i = 0; i < grid.length; i++) bytes[i] = Math.round((grid[i] / peak) * 255)
    }

    const tex = new DataTexture(bytes, RES, RES, RedFormat, UnsignedByteType)
    tex.magFilter = LinearFilter
    tex.minFilter = LinearFilter
    tex.needsUpdate = true
    return tex
  }, [incidents, bandwidth])

  const uniforms = useMemo(
    () => ({
      uDensity: { value: texture },
      uRamp: { value: RISK_RAMP.map((c) => new Color(c)) },
      uContour: { value: new Color(PALETTE.brassLit) },
      uOpacity: { value: opacity },
      uThreshold: { value: threshold },
      uContourCount: { value: 7 },
      uTime: { value: 0 },
    }),
    [texture, opacity, threshold],
  )

  useFrame((state) => {
    if (material.current) {
      material.current.uniforms.uTime.value = state.clock.elapsedTime
      material.current.uniforms.uOpacity.value = opacity
    }
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, height, 0]} renderOrder={2}>
      <planeGeometry args={[PLANE_SIZE, PLANE_SIZE, 1, 1]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </mesh>
  )
}
