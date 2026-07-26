import { geoMercator, geoCentroid, geoArea, geoBounds, geoContains, type GeoProjection } from 'd3-geo'
import { Shape } from 'three'
import type { Rng } from './rng'

/**
 * Turns the Survey-of-India-derived district boundaries into three.js geometry.
 *
 * Coordinate conventions, fixed here once so nothing downstream has to think:
 *   - Shapes are authored in the XY plane and extruded along +Z, then the mesh
 *     is rotated -90° about X so extrusion becomes height (+Y).
 *   - After that rotation a shape point (sx, sy) lands at world (sx, h, -sy).
 *   - North therefore sits at -Z, so a camera on +Z sees the state upright.
 */

export const PLANE_SIZE = 120

export interface DistrictFeature {
  name: string
  code: string
  /** Outline(s) in shape space, ready for ExtrudeGeometry. */
  shapes: Shape[]
  /** Geographic centroid. */
  lonLat: [number, number]
  /** Centroid in world XZ, for labels, towers and camera targets. */
  world: [number, number]
  /** Steradians — used to scale label size and normalise per-area rates. */
  area: number
  /** [[west, south], [east, north]] — the rejection-sampling envelope. */
  bounds: [[number, number], [number, number]]
  /** Retained so incidents can be sampled strictly inside the real boundary. */
  raw: GeoJSON.Feature
}

/**
 * Draw a random point that genuinely falls inside the district.
 *
 * Rejection sampling against the true polygon. Incidents scattered around a
 * centroid instead would leak across boundaries and put crimes in the sea off
 * Dakshina Kannada — which a police analyst would notice immediately. Bails out
 * to the centroid after a bounded number of tries so a pathological shape can
 * never hang the generator.
 */
export function samplePointInDistrict(d: DistrictFeature, r: Rng): [number, number] {
  const [[w, s], [e, n]] = d.bounds
  for (let i = 0; i < 40; i++) {
    const lon = w + r() * (e - w)
    const lat = s + r() * (n - s)
    if (geoContains(d.raw, [lon, lat])) return [lon, lat]
  }
  return d.lonLat
}

interface RawFeature {
  properties: { district: string; code: string }
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
}

interface RawCollection {
  features: RawFeature[]
}

let projection: GeoProjection | null = null

/** The active projection. Available only after `loadDistricts` resolves. */
export function getProjection(): GeoProjection {
  if (!projection) throw new Error('geo: projection requested before districts loaded')
  return projection
}

/** Project lon/lat into shape space (XY, north = +Y). */
export function toShapeXY(lon: number, lat: number): [number, number] {
  const p = getProjection()([lon, lat])
  if (!p) return [0, 0]
  return [p[0] - PLANE_SIZE / 2, PLANE_SIZE / 2 - p[1]]
}

/** Project lon/lat into world XZ (the ground plane), north = -Z. */
export function toWorldXZ(lon: number, lat: number): [number, number] {
  const [sx, sy] = toShapeXY(lon, lat)
  return [sx, -sy]
}

/**
 * Inverse — world XZ back to lon/lat, for the live coordinate readout.
 *
 * The forward path is sy = SIZE/2 - py, then z = -sy, which collapses to
 * z = py - SIZE/2. The inverse is therefore py = z + SIZE/2. Negating z here
 * instead mirrors latitude about the centre of the state, which reads as
 * plausible numbers that are quietly wrong — Bengaluru reporting as 17.13° N.
 */
export function fromWorldXZ(x: number, z: number): [number, number] {
  const p = getProjection().invert?.([x + PLANE_SIZE / 2, z + PLANE_SIZE / 2])
  return p ? [p[0], p[1]] : [0, 0]
}

function ringToShape(ring: number[][]): Shape {
  const s = new Shape()
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = toShapeXY(ring[i][0], ring[i][1])
    if (i === 0) s.moveTo(x, y)
    else s.lineTo(x, y)
  }
  s.closePath()
  return s
}

function buildShapes(geom: RawFeature['geometry']): Shape[] {
  const polygons: number[][][][] =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates

  return polygons.map((poly) => {
    const shape = ringToShape(poly[0])
    // Remaining rings are holes (enclaves). Karnataka has few, but honour them.
    for (let i = 1; i < poly.length; i++) shape.holes.push(ringToShape(poly[i]))
    return shape
  })
}

let cache: Promise<DistrictFeature[]> | null = null

/**
 * Load and prepare all 30 districts. Cached — the fetch and the projection fit
 * happen exactly once per session even though several scenes ask for them.
 */
export function loadDistricts(): Promise<DistrictFeature[]> {
  if (cache) return cache

  cache = fetch('/data/karnataka-districts.geo.json')
    .then((r) => {
      if (!r.ok) throw new Error(`geo: boundaries unavailable (HTTP ${r.status})`)
      return r.json() as Promise<RawCollection>
    })
    .then((collection) => {
      // Fit the whole state into the plane once, then reuse for every point.
      projection = geoMercator().fitSize(
        [PLANE_SIZE, PLANE_SIZE],
        collection as unknown as GeoJSON.GeoJSON,
      )

      return collection.features.map((f) => {
        const raw = f as unknown as GeoJSON.Feature
        const lonLat = geoCentroid(raw) as [number, number]
        return {
          name: f.properties.district,
          code: f.properties.code,
          shapes: buildShapes(f.geometry),
          lonLat,
          world: toWorldXZ(lonLat[0], lonLat[1]),
          area: geoArea(raw),
          bounds: geoBounds(raw) as [[number, number], [number, number]],
          raw,
        }
      })
    })
    .catch((err) => {
      cache = null // allow a retry rather than caching the failure
      throw err
    })

  return cache
}

/** Format a coordinate the way a survey readout does: 12.9716° N */
export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`
}

export function formatLon(lon: number): string {
  return `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`
}

/** Karnataka's true extent, for graticule ticks. */
export const KA_BOUNDS = { minLon: 74.086, maxLon: 78.586, minLat: 11.595, maxLat: 18.454 }
