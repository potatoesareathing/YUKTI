"""Approximate Mercator fit matching frontend PLANE_SIZE=120 over Karnataka bounds."""

from __future__ import annotations

import math

PLANE_SIZE = 120.0
# Karnataka extent from src/lib/geo.ts
MIN_LON, MAX_LON = 74.086, 78.586
MIN_LAT, MAX_LAT = 11.595, 18.454


def _merc_y(lat: float) -> float:
    lat_r = math.radians(max(min(lat, 89.5), -89.5))
    return math.log(math.tan(math.pi / 4 + lat_r / 2))


def to_world_xz(lon: float, lat: float) -> tuple[float, float]:
    """Project lon/lat → world XZ (north = -Z), approximating frontend fitSize."""
    x_norm = (lon - MIN_LON) / (MAX_LON - MIN_LON)
    y_merc = _merc_y(lat)
    y_min, y_max = _merc_y(MIN_LAT), _merc_y(MAX_LAT)
    y_norm = (y_merc - y_min) / (y_max - y_min)
    # fitSize into PLANE_SIZE; shape XY then world (sx, -sy)
    sx = x_norm * PLANE_SIZE - PLANE_SIZE / 2
    sy = (1 - y_norm) * PLANE_SIZE - PLANE_SIZE / 2
    # Frontend: world = [sx, -sy] after shape transform; shape sy already flipped above
    return (sx, -sy)


def jitter(lon: float, lat: float, rng, spread: float = 0.08) -> tuple[float, float]:
    return (lon + (rng() - 0.5) * spread, lat + (rng() - 0.5) * spread * 0.7)
