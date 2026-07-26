from __future__ import annotations

import base64
import json
import zlib
from typing import Any, Optional

import redis

from app.config import get_settings

_client: Optional[redis.Redis] = None
_client_failed = False


def get_redis() -> Optional[redis.Redis]:
    global _client, _client_failed
    if _client is not None:
        return _client
    if _client_failed:
        return None
    settings = get_settings()
    try:
        _client = redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.5,
            socket_timeout=2.0,
            health_check_interval=30,
        )
        _client.ping()
        return _client
    except Exception:
        _client = None
        _client_failed = True
        return None


def reset_redis() -> None:
    global _client, _client_failed
    _client = None
    _client_failed = False


def cache_get(key: str) -> Any | None:
    r = get_redis()
    if not r:
        return None
    try:
        raw = r.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def cache_set(key: str, value: Any, ttl: int = 86_400) -> None:
    r = get_redis()
    if not r:
        return
    try:
        r.setex(key, ttl, json.dumps(value, separators=(",", ":")))
    except Exception:
        pass


def cache_delete(*keys: str) -> None:
    r = get_redis()
    if not r:
        return
    try:
        if keys:
            r.delete(*keys)
    except Exception:
        pass


def cache_set_compressed(key: str, value: Any, ttl: int = 172_800) -> bool:
    r = get_redis()
    if not r:
        return False
    try:
        blob = base64.b64encode(
            zlib.compress(json.dumps(value, separators=(",", ":")).encode("utf-8"), 6)
        ).decode("ascii")
        r.setex(key, ttl, blob)
        return True
    except Exception:
        return False


def cache_get_compressed(key: str) -> Any | None:
    r = get_redis()
    if not r:
        return None
    try:
        blob = r.get(key)
        if not blob:
            return None
        return json.loads(zlib.decompress(base64.b64decode(blob)))
    except Exception:
        return None


def redis_ping() -> bool:
    r = get_redis()
    if not r:
        return False
    try:
        return bool(r.ping())
    except Exception:
        return False
