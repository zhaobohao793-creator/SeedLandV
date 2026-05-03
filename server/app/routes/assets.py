"""POST /v1/assets — server-proxied upload to TOS, returns an opaque
short-lived `asset_token` the client passes to /v1/tasks.

The token (not the raw `tos_key`) is what the client sees, so users can't
infer bucket layout or hand off arbitrary keys. Token resolves once at task
submit time, then `tos_key` is persisted on `task_assets`; the worker signs
a GET URL when it actually calls Ark.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import secrets
from functools import lru_cache
from pathlib import PurePosixPath

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.auth.deps import get_current_user
from app.config import get_settings
from app.models import User
from app.models.enums import AssetKind
from app.storage.tos import build_object_key, get_tos_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/assets", tags=["assets"])

# Per-kind size ceiling. Server is the source of truth — clients may pre-flight
# but we re-check here.
SIZE_LIMITS_BYTES: dict[AssetKind, int] = {
    AssetKind.IMAGE: 20 * 1024 * 1024,
    AssetKind.VIDEO: 200 * 1024 * 1024,
    AssetKind.AUDIO: 50 * 1024 * 1024,
}

ASSET_TOKEN_TTL_SECONDS = 3600
ASSET_TOKEN_PREFIX = "asset_token:"


class AssetUploadResponse(BaseModel):
    asset_token: str
    kind: AssetKind
    mime: str
    size_bytes: int


@lru_cache
def _redis() -> aioredis.Redis:
    return aioredis.from_url(get_settings().redis_url, decode_responses=True)


def asset_token_key(token: str) -> str:
    return f"{ASSET_TOKEN_PREFIX}{token}"


def _ensure_mime_matches_kind(mime: str | None, kind: AssetKind) -> str:
    if not mime:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "missing Content-Type on uploaded file",
        )
    expected = {
        AssetKind.IMAGE: "image/",
        AssetKind.VIDEO: "video/",
        AssetKind.AUDIO: "audio/",
    }[kind]
    if not mime.lower().startswith(expected):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"mime '{mime}' does not match kind '{kind.value}'",
        )
    return mime


def _extension_from_filename(filename: str | None) -> str:
    if not filename:
        return ""
    suffix = PurePosixPath(filename).suffix.lower()
    if len(suffix) > 16:  # absurdly long extensions are not extensions
        return ""
    return suffix


@router.post("", response_model=AssetUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    kind: AssetKind = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> AssetUploadResponse:
    mime = _ensure_mime_matches_kind(file.content_type, kind)

    limit = SIZE_LIMITS_BYTES[kind]
    # Read up to limit+1 to detect overflow without allocating unbounded memory.
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"{kind.value} 文件超过 {limit // (1024 * 1024)}MB 上限",
        )
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "empty file")

    size_bytes = len(data)
    key = build_object_key(_extension_from_filename(file.filename))
    tos_client = get_tos_client()

    try:
        await asyncio.to_thread(
            tos_client.put_object_streaming,
            key,
            io.BytesIO(data),
            content_type=mime,
            content_length=size_bytes,
        )
    except Exception as e:
        logger.exception("TOS put failed for tenant=%s key=%s", user.tenant_id, key)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"上传到对象存储失败: {e}"
        ) from e

    token = secrets.token_urlsafe(24)
    payload = {
        "tenant_id": str(user.tenant_id),
        "user_id": str(user.id),
        "kind": kind.value,
        "mime": mime,
        "tos_key": key,
        "size_bytes": size_bytes,
    }
    try:
        await _redis().setex(
            asset_token_key(token), ASSET_TOKEN_TTL_SECONDS, json.dumps(payload)
        )
    except Exception as e:
        logger.exception("Redis setex failed for token (key=%s)", key)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"asset_token 存储失败: {e}"
        ) from e

    return AssetUploadResponse(
        asset_token=token, kind=kind, mime=mime, size_bytes=size_bytes
    )
