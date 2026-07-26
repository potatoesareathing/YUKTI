"""Production snapshot store — nightly publish, request-time read only."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models_orm import ApiSnapshot
from app.redis_client import cache_get_compressed, cache_set_compressed

_lock = threading.RLock()
_mem: dict[str, tuple[float, Any]] = {}
_mem_raw: dict[str, bytes] = {}
_MEM_TTL = 600.0


def _redis_key(name: str) -> str:
    return f"yukti:snap:{name}"


def _envelope_key(name: str) -> str:
    return f"{name}__envelope"


def mem_get(name: str) -> Any | None:
    with _lock:
        hit = _mem.get(name)
        if not hit:
            return None
        ts, val = hit
        if time.time() - ts > _MEM_TTL:
            _mem.pop(name, None)
            return None
        return val


def mem_set(name: str, value: Any) -> None:
    with _lock:
        _mem[name] = (time.time(), value)


def mem_get_raw(name: str) -> bytes | None:
    with _lock:
        return _mem_raw.get(_envelope_key(name))


def mem_set_raw(name: str, raw: bytes) -> None:
    with _lock:
        _mem_raw[_envelope_key(name)] = raw


def mem_clear() -> None:
    with _lock:
        _mem.clear()
        _mem_raw.clear()


def db_set(db: Session, name: str, value: Any) -> None:
    row = db.get(ApiSnapshot, name)
    if row:
        row.payload = value
        row.updated_at = datetime.utcnow()
    else:
        db.add(ApiSnapshot(id=name, payload=value, updated_at=datetime.utcnow()))


def db_get(db: Session, name: str) -> Any | None:
    row = db.get(ApiSnapshot, name)
    return row.payload if row else None


def _dumps(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def make_envelope(data: Any, total: int | None = None) -> dict:
    if total is None:
        total = len(data) if isinstance(data, list) else 1
    return {
        "success": True,
        "data": data,
        "error": None,
        "meta": {"total": total, "page": 1, "limit": total if isinstance(data, list) else 100},
    }


def publish(db: Session, name: str, value: Any) -> None:
    db_set(db, name, value)
    cache_set_compressed(_redis_key(name), value)
    mem_set(name, value)
    env = make_envelope(value)
    raw = _dumps(env)
    mem_set_raw(name, raw)
    cache_set_compressed(_redis_key(_envelope_key(name)), env)


def load(db: Session | None, name: str) -> Any | None:
    hit = mem_get(name)
    if hit is not None:
        return hit
    hit = cache_get_compressed(_redis_key(name))
    if hit is not None:
        mem_set(name, hit)
        env = make_envelope(hit)
        mem_set_raw(name, _dumps(env))
        return hit
    if db is not None:
        hit = db_get(db, name)
        if hit is not None:
            cache_set_compressed(_redis_key(name), hit)
            mem_set(name, hit)
            env = make_envelope(hit)
            mem_set_raw(name, _dumps(env))
            return hit
    return None


def load_envelope_bytes(db: Session | None, name: str) -> bytes | None:
    raw = mem_get_raw(name)
    if raw is not None:
        return raw
    env = cache_get_compressed(_redis_key(_envelope_key(name)))
    if env is not None:
        raw = _dumps(env)
        mem_set_raw(name, raw)
        if "data" in env:
            mem_set(name, env["data"])
        return raw
    data = load(db, name)
    if data is None:
        return None
    return mem_get_raw(name)


def publish_all(db: Session, payloads: dict[str, Any]) -> None:
    for name, value in payloads.items():
        publish(db, name, value)
    db.commit()
    # refresh raw envelopes after clear
    mem_clear()
    for name, value in payloads.items():
        mem_set(name, value)
        mem_set_raw(name, _dumps(make_envelope(value)))
