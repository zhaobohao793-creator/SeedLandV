"""Per-tenant WebSocket registry + Redis subscriber lifecycle.

Subscriber tasks are started lazily on first connect and cancelled when the
last connection for a tenant drops, so an idle process pays no Redis chatter.
"""
from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

import redis.asyncio as aioredis
from fastapi import WebSocket
from starlette.websockets import WebSocketState

from app.config import get_settings
from app.realtime.publisher import channel_for

logger = logging.getLogger(__name__)


class TenantHub:
    def __init__(self) -> None:
        self._conns: dict[UUID, set[WebSocket]] = {}
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()
        self._redis: aioredis.Redis | None = None

    def _client(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = aioredis.from_url(
                get_settings().redis_url, decode_responses=True
            )
        return self._redis

    async def add(self, tenant_id: UUID, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.setdefault(tenant_id, set())
            conns.add(ws)
            if tenant_id not in self._tasks:
                self._tasks[tenant_id] = asyncio.create_task(
                    self._run_subscriber(tenant_id),
                    name=f"sub:{tenant_id}",
                )

    async def remove(self, tenant_id: UUID, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.get(tenant_id)
            if conns is None:
                return
            conns.discard(ws)
            if not conns:
                self._conns.pop(tenant_id, None)
                task = self._tasks.pop(tenant_id, None)
                if task:
                    task.cancel()

    async def _run_subscriber(self, tenant_id: UUID) -> None:
        channel = channel_for(tenant_id)
        try:
            pubsub = self._client().pubsub()
            await pubsub.subscribe(channel)
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    await self._fanout(tenant_id, msg["data"])
            finally:
                try:
                    await pubsub.unsubscribe(channel)
                    await pubsub.aclose()
                except Exception:
                    logger.debug("pubsub teardown error", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("subscriber task crashed for tenant=%s", tenant_id)

    async def _fanout(self, tenant_id: UUID, raw: str) -> None:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("dropping non-json msg on tenant=%s", tenant_id)
            return
        envelope = {"type": "task:update", "data": data}
        targets = list(self._conns.get(tenant_id, ()))
        for ws in targets:
            if ws.application_state != WebSocketState.CONNECTED:
                continue
            try:
                await ws.send_json(envelope)
            except Exception:
                logger.debug("ws send failed; route will clean up on disconnect", exc_info=True)


hub = TenantHub()
