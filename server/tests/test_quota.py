"""Unit tests for app/storage/quota.py — Redis client is injected, no live infra."""
from __future__ import annotations

from uuid import uuid4

import pytest

from app.storage.quota import WINDOW_SECONDS, consume_ark_submit_quota


class _FakePipeline:
    def __init__(self, store: dict, key_owner: "_FakeRedis") -> None:
        self._store = store
        self._owner = key_owner
        self._ops: list = []

    def incr(self, key: str, n: int = 1):
        self._ops.append(("incr", key, n))
        return self

    def expire(self, key: str, ttl: int):
        self._ops.append(("expire", key, ttl))
        return self

    def execute(self):
        results = []
        for op, key, arg in self._ops:
            if op == "incr":
                self._store[key] = self._store.get(key, 0) + arg
                self._owner.last_incr_key = key
                results.append(self._store[key])
            elif op == "expire":
                self._owner.last_expire_ttl = arg
                results.append(True)
        self._ops.clear()
        return results


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, int] = {}
        self.last_incr_key: str | None = None
        self.last_expire_ttl: int | None = None

    def pipeline(self, transaction: bool = False):  # noqa: ARG002
        return _FakePipeline(self.store, self)


def test_first_request_is_allowed_and_emits_remaining():
    rc = _FakeRedis()
    tid = uuid4()
    res = consume_ark_submit_quota(tid, limit=10, client=rc)
    assert res.allowed is True
    assert res.used == 1
    assert res.limit == 10
    assert res.remaining == 9
    assert 0 < res.reset_in_seconds <= WINDOW_SECONDS
    # Key must include tenant + epoch_hour, not anything else.
    assert rc.last_incr_key.startswith(f"ark_submit_quota:{tid}:")
    # TTL has padding so a request landing at second 3599 doesn't expire mid-bucket.
    assert rc.last_expire_ttl > WINDOW_SECONDS


def test_quota_exhaustion_returns_disallowed_with_zero_remaining():
    rc = _FakeRedis()
    tid = uuid4()
    for i in range(5):
        res = consume_ark_submit_quota(tid, limit=5, client=rc)
        assert res.allowed is True, f"call {i+1} should still be allowed"
    over = consume_ark_submit_quota(tid, limit=5, client=rc)
    assert over.allowed is False
    assert over.used == 6
    assert over.remaining == 0
    # Counter still increments past the limit — keeps spammers paying for TTL refresh.
    further = consume_ark_submit_quota(tid, limit=5, client=rc)
    assert further.used == 7
    assert further.allowed is False


def test_separate_tenants_have_independent_buckets():
    rc = _FakeRedis()
    a, b = uuid4(), uuid4()
    consume_ark_submit_quota(a, limit=2, client=rc)
    consume_ark_submit_quota(a, limit=2, client=rc)
    over_a = consume_ark_submit_quota(a, limit=2, client=rc)
    fresh_b = consume_ark_submit_quota(b, limit=2, client=rc)
    assert over_a.allowed is False
    assert fresh_b.allowed is True
    assert fresh_b.used == 1


def test_clock_in_different_hour_uses_new_bucket():
    rc = _FakeRedis()
    tid = uuid4()
    # Hour 100 bucket — fill it up.
    base = 100 * WINDOW_SECONDS
    for _ in range(3):
        consume_ark_submit_quota(tid, limit=3, now=base + 5, client=rc)
    over = consume_ark_submit_quota(tid, limit=3, now=base + 6, client=rc)
    assert over.allowed is False

    # One hour later — new bucket, fresh budget.
    fresh = consume_ark_submit_quota(tid, limit=3, now=base + WINDOW_SECONDS + 1, client=rc)
    assert fresh.allowed is True
    assert fresh.used == 1


def test_reset_in_seconds_counts_down_within_hour():
    rc = _FakeRedis()
    base = 1234 * WINDOW_SECONDS
    early = consume_ark_submit_quota(uuid4(), limit=10, now=base + 1, client=rc)
    late = consume_ark_submit_quota(uuid4(), limit=10, now=base + WINDOW_SECONDS - 5, client=rc)
    # Earlier in the window → larger reset_in.
    assert early.reset_in_seconds == WINDOW_SECONDS - 1
    assert late.reset_in_seconds == 5
