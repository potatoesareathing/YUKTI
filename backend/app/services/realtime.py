"""In-process pub/sub for SSE / live map updates."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, channel: str = "fir") -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        async with self._lock:
            self._subs[channel].add(q)
        return q

    async def unsubscribe(self, channel: str, q: asyncio.Queue[str]) -> None:
        async with self._lock:
            self._subs[channel].discard(q)

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        async with self._lock:
            targets = list(self._subs.get(channel, ()))
        for q in targets:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(data)
                except asyncio.QueueFull:
                    pass


bus = EventBus()
