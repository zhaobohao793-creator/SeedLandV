"""WebSocket endpoint for live task updates.

Browsers can't set Authorization headers on a WebSocket handshake, so the
JWT travels as a `?token=` query string. The token is authenticated once
at handshake and the connection stays bound to the resolved tenant for its
entire lifetime.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from app.auth.security import TokenError, decode_token
from app.db.session import SessionLocal
from app.models import User
from app.realtime.connections import hub

router = APIRouter()


@router.websocket("/ws/tasks")
async def ws_tasks(ws: WebSocket, token: str = Query(default="")) -> None:
    if not token:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    try:
        claims = decode_token(token, expected_type="access")
        user_id = UUID(claims["sub"])
        tenant_id = UUID(claims["tid"])
    except (TokenError, KeyError, ValueError):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.id == user_id))
        if user is None or user.tenant_id != tenant_id:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return

    await ws.accept()
    await hub.add(tenant_id, ws)
    try:
        # Keep the socket open. Client→server messages are not used in Phase 3,
        # but receive_text() will raise WebSocketDisconnect on close.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(tenant_id, ws)
