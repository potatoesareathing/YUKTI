"""Deterministic PRNG matching the spirit of src/lib/rng.ts seeded()."""

from __future__ import annotations

import math


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def _xmur3(s: str):
    h = 1779033703 ^ len(s)

    def next_h():
        nonlocal h
        # consume already done in init below — this is the step function
        h = _imul(h ^ (h >> 16), 2246822507)
        h = _imul(h ^ (h >> 13), 3266489909)
        return (h ^ (h >> 16)) & 0xFFFFFFFF

    for c in s:
        h = _imul(h ^ ord(c), 3432918353)
        h = (h << 13 | h >> 19) & 0xFFFFFFFF
    return next_h


def _mulberry32(a: int):
    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rng


def seeded(key: str):
    return _mulberry32(_xmur3(key)())


def gaussian(rng, mean: float = 0.0, std: float = 1.0) -> float:
    u1 = max(1e-12, rng())
    u2 = rng()
    z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2 * math.pi * u2)
    return mean + z * std
