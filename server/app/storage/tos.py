"""Volcengine TOS client wrapper.

Two surfaces only:
  - put_object_streaming(): server-proxied multipart upload from FastAPI
  - generate_presigned_get_url(): 7d URL handed to Ark so it can fetch the asset

Object key shape: `seedlandv/uploads/{yyyy}/{mm}/{dd}/{uuid4}{ext}` — date prefix
makes lifecycle policies and bulk audits straightforward.
"""
from __future__ import annotations

from datetime import UTC, datetime
from functools import lru_cache
from typing import IO
from uuid import uuid4

import tos
from tos import HttpMethodType

from app.config import get_settings


SEVEN_DAYS_SECONDS = 7 * 24 * 3600


def build_object_key(extension: str | None) -> str:
    ext = extension or ""
    if ext and not ext.startswith("."):
        ext = "." + ext
    now = datetime.now(UTC)
    return f"seedlandv/uploads/{now:%Y/%m/%d}/{uuid4().hex}{ext.lower()}"


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
