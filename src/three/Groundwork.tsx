import { useMemo } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute, DoubleSide } from 'three'
import { KA_BOUNDS, PLANE_SIZE, toWorldXZ } from '@/lib/geo'
import { PALETTE } from '@/lib/palette'

/**
 * The cartographic furniture the map sits on: a base plate and a true
 * graticule.
 *
 * The graticule is not a decorative grid. Each line is a real parallel or
 * meridian sampled at quarter-degree steps and pushed through the same Mercator
 * projection as the district boundaries, so the lines curve and space
 * themselves exactly as they do on the survey sheet these boundaries came from.
 * A square grid drawn in screen space would be a lie about the projection.
 */

const plateVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const plateFragment = /* glsl */ `
  uniform vec3 uLine;
  uniform vec3 uMajor;
  uniform float uSize;
  varying vec2 vUv;

  // Screen-space-derivative antialiased grid: one clean pixel at any zoom.
  float grid(vec2 p, float step, float weight) {
    vec2 g = abs(fract(p / step - 0.5) - 0.5) / fwidth(p / step);
    float line = min(g.x, g.y);
    return 1.0 - min(line * weight, 1.0);
  }

  void main() {
    vec2 p = (vUv - 0.5) * uSize;

    float minor = grid(p, 4.0, 1.0);
    float major = grid(p, 20.0, 0.9);

    // Fade to nothing at the plate edge so it reads as an instrument bed
    // rather than a rectangle floating in space.
    float r = length(vUv - 0.5) * 2.0;
    float vignette = 1.0 - smoothstep(0.55, 1.05, r);

    vec3 col = mix(uLine, uMajor, major);
    float a = (minor * 0.34 + major * 0.5) * vignette;

    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`

export function BasePlate({ size = PLANE_SIZE * 1.6 }: { size?: number }) {
  const uniforms = useMemo(
    () => ({
      uLine: { value: new Color(PALETTE.rule2) },
      uMajor: { value: new Color(PALETTE.bhuvanDim) },
      uSize: { value: size },
    }),
    [size],
  )

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]} renderOrder={0}>
      <planeGeometry args={[size, size, 1, 1]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={plateVertex}
        fragmentShader={plateFragment}
        transparent
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  )
}

/** Build one projected parallel or meridian as a polyline. */
function buildLine(
  fixed: number,
  from: number,
  to: number,
  axis: 'lon' | 'lat',
  y: number,
): number[] {
  const out: number[] = []
  const step = 0.25
  for (let v = from; v <= to + 1e-9; v += step) {
    const [x, z] = axis === 'lon' ? toWorldXZ(fixed, v) : toWorldXZ(v, fixed)
    out.push(x, y, z)
  }
  return out
}

/** True parallels and meridians at whole-degree intervals across Karnataka. */
export function Graticule({ y = 0.02, opacity = 0.4 }: { y?: number; opacity?: number }) {
  const geometry = useMemo(() => {
    const positions: number[] = []
    const pad = 0.6

    const lonFrom = Math.floor(KA_BOUNDS.minLon) - pad
    const lonTo = Math.ceil(KA_BOUNDS.maxLon) + pad
    const latFrom = Math.floor(KA_BOUNDS.minLat) - pad
    const latTo = Math.ceil(KA_BOUNDS.maxLat) + pad

    const push = (pts: number[]) => {
      // Expand the polyline into discrete segments for LineSegments.
      for (let i = 0; i + 5 < pts.length; i += 3) {
        positions.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5])
      }
    }

    for (let lon = Math.ceil(lonFrom); lon <= lonTo; lon++) {
      push(buildLine(lon, latFrom, latTo, 'lon', y))
    }
    for (let lat = Math.ceil(latFrom); lat <= latTo; lat++) {
      push(buildLine(lat, lonFrom, lonTo, 'lat', y))
    }

    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return g
  }, [y])

  return (
    <lineSegments geometry={geometry} renderOrder={1}>
      <lineBasicMaterial color={PALETTE.bhuvanDim} transparent opacity={opacity} depthWrite={false} />
    </lineSegments>
  )
}

/** The brass frame enclosing the survey area, with corner ticks. */
export function InstrumentFrame({ half = 58, y = 0.03 }: { half?: number; y?: number }) {
  const geometry = useMemo(() => {
    const p: number[] = []
    const tick = 7

    const corner = (cx: number, cz: number, sx: number, sz: number) => {
      p.push(cx, y, cz, cx + sx * tick, y, cz)
      p.push(cx, y, cz, cx, y, cz + sz * tick)
    }

    corner(-half, -half, 1, 1)
    corner(half, -half, -1, 1)
    corner(-half, half, 1, -1)
    corner(half, half, -1, -1)

    // Edge graduations — one mark every 10 units along each side.
    for (let v = -half + 10; v < half; v += 10) {
      const len = v % 20 === 0 ? 2.6 : 1.4
      p.push(v, y, -half, v, y, -half + len)
      p.push(v, y, half, v, y, half - len)
      p.push(-half, y, v, -half + len, y, v)
      p.push(half, y, v, half - len, y, v)
    }

    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(p, 3))
    return g
  }, [half, y])

  return (
    <lineSegments geometry={geometry} renderOrder={1}>
      <lineBasicMaterial color={PALETTE.brass} transparent opacity={0.75} depthWrite={false} />
    </lineSegments>
  )
}
