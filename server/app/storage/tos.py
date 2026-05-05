"""Volcengine TOS client wrapper.

Surfaces:
  - put_object_streaming(): server-proxied multipart upload from FastAPI
  - generate_presigned_get_url(): 7d URL handed to Ark so it can fetch the asset
  - mirror_url_to_tos(): Phase 5 — pull a remote URL into TOS (used to mirror
    the Ark-hosted finished video into our bucket before the upstream URL expires)

Object key shapes:
  - uploads:  `seedlandv/uploads/{yyyy}/{mm}/{dd}/{uuid4}{ext}`
  - videos:   `seedlandv/videos/{yyyy}/{mm}/{dd}/{task_uuid}/video.mp4`
"""
from __future__ import annotations

import tempfile
from datetime import UTC, datetime
from functools import lru_cache
from typing import IO
from uuid import UUID, uuid4

import httpx
import tos
from tos import HttpMethodType

from app.config import get_settings


SEVEN_DAYS_SECONDS = 7 * 24 * 3600
# Spool boundary for mirror downloads — videos under 64 MiB stay in RAM, larger
# ones spill to a tmpfile so we don't OOM on long renders.
_MIRROR_SPOOL_BYTES = 64 * 1024 * 1024
_MIRROR_CHUNK_BYTES = 1024 * 1024


def build_object_key(extension: str | None) -> str:
    ext = extension or ""
    if ext and not ext.startswith("."):
        ext = "." + ext
    now = datetime.now(UTC)
    return f"seedlandv/uploads/{now:%Y/%m/%d}/{uuid4().hex}{ext.lower()}"


def build_video_key(task_uuid: UUID | str) -> str:
    """Mirrored-video object key. Stable per-task: re-mirroring the same row
    overwrites the same key (idempotent on retry)."""
    now = datetime.now(UTC)
    return f"seedlandv/videos/{now:%Y/%m/%d}/{task_uuid}/video.mp4"


def build_last_frame_key(task_uuid: UUID | str) -> str:
    """Mirrored last-frame thumbnail key, sibling of the video key. PNG, since
    Ark always serves last frame as `..._last-frame.png`."""
    now = datetime.now(UTC)
    return f"seedlandv/videos/{now:%Y/%m/%d}/{task_uuid}/last_frame.png"


class TosClient:
    """Thin wrapper around tos.TosClientV2 — only the methods we use."""

    def __init__(
        self,
        *,
        ak: str,
        sk: str,
        region: str,
        endpoint: str,
        bucket: str,
        client_factory=tos.TosClientV2,
    ) -> None:
        self._bucket = bucket
        self._client = client_factory(ak=ak, sk=sk, endpoint=endpoint, region=region)

    @property
    def bucket(self) -> str:
        return self._bucket

    def put_object_streaming(
        self,
        key: str,
        stream: IO[bytes],
        *,
        content_type: str | None = None,
        content_length: int | None = None,
    ) -> None:
        self._client.put_object(
            bucket=self._bucket,
            key=key,
            content=stream,
            content_type=content_type,
            content_length=content_length,
        )

    def generate_presigned_get_url(
        self, key: str, ttl_seconds: int = SEVEN_DAYS_SECONDS
    ) -> str:
        out = self._client.pre_signed_url(
            http_method=HttpMethodType.Http_Method_Get,
            bucket=self._bucket,
            key=key,
            expires=ttl_seconds,
        )
        return out.signed_url


def mirror_url_to_tos(
    *,
    client: TosClient,
    src_url: str,
    dest_key: str,
    content_type: str | None = None,
    timeout: float = 300.0,
    http_factory=httpx.stream,
) -> int:
    """Stream src_url into TOS at dest_key. Returns bytes written.

    Two-phase: download into a SpooledTemporaryFile (RAM up to ~64 MiB, disk
    above), then put_object once total size is known. We need content_length up
    front because TOS PUT prefers it; chunked transfer-encoding is not part of
    our wrapper surface.

    `http_factory` is overridable so unit tests can swap in respx without an
    actual TLS stack.
    """
    with tempfile.SpooledTemporaryFile(max_size=_MIRROR_SPOOL_BYTES) as buf:
        with http_factory(
            "GET", src_url, timeout=timeout, follow_redirects=True
        ) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes(_MIRROR_CHUNK_BYTES):
                if chunk:
                    buf.write(chunk)
        size = buf.tell()
        if size == 0:
            raise RuntimeError("mirror download returned 0 bytes")
        buf.seek(0)
        client.put_object_streaming(
            dest_key,
            buf,
            content_type=content_type,
            content_length=size,
        )
        return size


@lru_cache
def get_tos_client() -> TosClient:
    s = get_settings()
    return TosClient(
        ak=s.volc_tos_ak,
        sk=s.volc_tos_sk,
        region=s.volc_tos_region,
        endpoint=s.volc_tos_endpoint,
        bucket=s.volc_tos_bucket,
    )
