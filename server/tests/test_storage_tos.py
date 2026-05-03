"""Unit tests for app/storage/tos.py — pure-Python wrapper, mock the SDK."""
from __future__ import annotations

import io
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from app.storage.tos import (
    SEVEN_DAYS_SECONDS,
    TosClient,
    build_object_key,
    build_video_key,
    mirror_url_to_tos,
)


class _FakeSdk:
    """Stand-in for tos.TosClientV2; records calls so tests can assert.

    Note: drains `content` into `body_bytes` immediately because the caller may
    close a SpooledTemporaryFile after the put_object call returns."""

    def __init__(self, **kwargs) -> None:
        self.init_kwargs = kwargs
        self.put_calls: list[dict] = []
        self.sign_calls: list[dict] = []

    def put_object(self, **kwargs):
        body = kwargs.get("content")
        if body is not None and hasattr(body, "read"):
            kwargs["body_bytes"] = body.read()
        self.put_calls.append(kwargs)
        return MagicMock(etag="fake-etag")

    def pre_signed_url(self, **kwargs):
        self.sign_calls.append(kwargs)
        out = MagicMock()
        out.signed_url = (
            f"https://tos.example/{kwargs['bucket']}/{kwargs['key']}"
            f"?expires={kwargs['expires']}"
        )
        return out


def _make_client(factory_holder: list[_FakeSdk]) -> TosClient:
    def factory(**kwargs):
        sdk = _FakeSdk(**kwargs)
        factory_holder.append(sdk)
        return sdk

    return TosClient(
        ak="ak",
        sk="sk",
        region="cn-beijing",
        endpoint="tos-cn-beijing.volces.com",
        bucket="my-bucket",
        client_factory=factory,
    )


def test_build_object_key_shape_and_uniqueness():
    k1 = build_object_key(".png")
    k2 = build_object_key(".png")
    assert k1.startswith("seedlandv/uploads/")
    assert k1.endswith(".png")
    # YYYY/MM/DD prefix slice — exact lengths
    parts = k1.split("/")
    assert parts[0] == "seedlandv"
    assert parts[1] == "uploads"
    assert len(parts[2]) == 4 and parts[2].isdigit()  # year
    assert len(parts[3]) == 2 and parts[3].isdigit()  # month
    assert len(parts[4]) == 2 and parts[4].isdigit()  # day
    assert k1 != k2  # uuid4 collision is astronomically unlikely


def test_build_object_key_normalises_extension():
    assert build_object_key("PNG").endswith(".png")
    assert build_object_key(".JPEG").endswith(".jpeg")
    assert build_object_key(None).split("/")[-1].count(".") == 0
    assert build_object_key("").split("/")[-1].count(".") == 0


def test_put_object_streaming_passes_key_bucket_and_content():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    stream = io.BytesIO(b"hello")
    c.put_object_streaming("k/x.png", stream, content_type="image/png", content_length=5)
    sdk = holder[0]
    assert sdk.init_kwargs["ak"] == "ak"
    assert sdk.init_kwargs["sk"] == "sk"
    assert len(sdk.put_calls) == 1
    call = sdk.put_calls[0]
    assert call["bucket"] == "my-bucket"
    assert call["key"] == "k/x.png"
    assert call["content_type"] == "image/png"
    assert call["content_length"] == 5
    assert call["content"] is stream


def test_generate_presigned_get_url_default_ttl_is_seven_days():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    url = c.generate_presigned_get_url("k/v.mp4")
    sdk = holder[0]
    assert len(sdk.sign_calls) == 1
    call = sdk.sign_calls[0]
    assert call["bucket"] == "my-bucket"
    assert call["key"] == "k/v.mp4"
    assert call["expires"] == SEVEN_DAYS_SECONDS
    assert SEVEN_DAYS_SECONDS == 7 * 24 * 3600
    assert "expires=604800" in url


def test_generate_presigned_get_url_uses_get_method():
    import tos as tos_sdk

    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    c.generate_presigned_get_url("k/v.mp4", ttl_seconds=60)
    call = holder[0].sign_calls[0]
    assert call["http_method"] == tos_sdk.HttpMethodType.Http_Method_Get
    assert call["expires"] == 60


def test_generate_presigned_get_url_custom_ttl():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    c.generate_presigned_get_url("k/v.mp4", ttl_seconds=120)
    assert holder[0].sign_calls[0]["expires"] == 120


@pytest.mark.parametrize("ext,expected_suffix", [
    (".png", ".png"),
    ("png", ".png"),
    (".MP4", ".mp4"),
    ("", ""),
    (None, ""),
])
def test_build_object_key_extension_handling(ext, expected_suffix):
    k = build_object_key(ext)
    if expected_suffix:
        assert k.endswith(expected_suffix)
    else:
        # No dot in the final segment when no extension
        assert "." not in k.split("/")[-1]


def test_build_video_key_shape_and_uuid_segment():
    u = uuid4()
    k = build_video_key(u)
    assert k.startswith("seedlandv/videos/")
    assert k.endswith(f"/{u}/video.mp4")
    parts = k.split("/")
    # seedlandv / videos / yyyy / mm / dd / <uuid> / video.mp4
    assert parts[0] == "seedlandv"
    assert parts[1] == "videos"
    assert len(parts[2]) == 4 and parts[2].isdigit()
    assert len(parts[3]) == 2 and parts[3].isdigit()
    assert len(parts[4]) == 2 and parts[4].isdigit()
    UUID(parts[5])  # well-formed
    assert parts[6] == "video.mp4"


def test_build_video_key_accepts_str_uuid():
    s = str(uuid4())
    k = build_video_key(s)
    assert k.endswith(f"/{s}/video.mp4")


class _FakeStreamCtx:
    """Stand-in for `httpx.stream(...)` context manager."""

    def __init__(self, *, chunks: list[bytes], status_code: int = 200) -> None:
        self._chunks = chunks
        self.status_code = status_code
        self.raise_called = False

    def raise_for_status(self) -> None:
        self.raise_called = True
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def iter_bytes(self, chunk_size: int):  # noqa: ARG002 — mirror httpx signature
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stream_factory(chunks: list[bytes], *, status: int = 200):
    seen = {}

    def factory(method, url, *, timeout, follow_redirects):  # noqa: ARG001
        seen["method"] = method
        seen["url"] = url
        seen["timeout"] = timeout
        seen["follow_redirects"] = follow_redirects
        return _FakeStreamCtx(chunks=chunks, status_code=status)

    return factory, seen


def test_mirror_url_to_tos_streams_into_put_with_correct_size():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    chunks = [b"abc", b"defgh"]  # 8 bytes total
    factory, seen = _stream_factory(chunks)

    n = mirror_url_to_tos(
        client=c,
        src_url="https://upstream.example/v.mp4",
        dest_key="seedlandv/videos/2026/05/03/x/video.mp4",
        content_type="video/mp4",
        http_factory=factory,
    )

    assert n == 8
    assert seen["method"] == "GET"
    assert seen["url"] == "https://upstream.example/v.mp4"
    assert seen["follow_redirects"] is True

    sdk = holder[0]
    assert len(sdk.put_calls) == 1
    call = sdk.put_calls[0]
    assert call["bucket"] == "my-bucket"
    assert call["key"] == "seedlandv/videos/2026/05/03/x/video.mp4"
    assert call["content_type"] == "video/mp4"
    assert call["content_length"] == 8
    # SpooledTemporaryFile is rewound to 0 before put_object — drained on call
    assert call["body_bytes"] == b"abcdefgh"


def test_mirror_url_to_tos_raises_on_zero_bytes():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    factory, _ = _stream_factory([b"", b""])

    with pytest.raises(RuntimeError, match="0 bytes"):
        mirror_url_to_tos(
            client=c,
            src_url="https://upstream.example/empty",
            dest_key="seedlandv/videos/x/empty.mp4",
            http_factory=factory,
        )
    # Must not have called TOS PUT for an empty body
    assert holder[0].put_calls == []


def test_mirror_url_to_tos_propagates_http_errors():
    holder: list[_FakeSdk] = []
    c = _make_client(holder)
    factory, _ = _stream_factory([b"unused"], status=404)

    with pytest.raises(RuntimeError, match="http 404"):
        mirror_url_to_tos(
            client=c,
            src_url="https://upstream.example/missing",
            dest_key="seedlandv/videos/x/missing.mp4",
            http_factory=factory,
        )
    assert holder[0].put_calls == []
