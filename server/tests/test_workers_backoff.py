"""Unit tests for the Phase 6 backoff helpers in app/workers/tasks.py.

These functions are pure — testing them in isolation is enough to lock down the
ladder shape; the full retry behaviour is covered by smoke tests against a real
Celery worker."""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.workers.tasks import (
    MIRROR_BASE_COOLDOWN_SECONDS,
    MIRROR_MAX_COOLDOWN_SECONDS,
    SUBMIT_BASE_BACKOFF_SECONDS,
    SUBMIT_MAX_BACKOFF_SECONDS,
    _mirror_cooldown_for,
    _submit_backoff_for,
)


def test_mirror_cooldown_doubles_each_attempt():
    # attempt=1 → base; 2 → 2x; 3 → 4x; ...
    assert _mirror_cooldown_for(1) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS)
    assert _mirror_cooldown_for(2) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS * 2)
    assert _mirror_cooldown_for(3) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS * 4)
    assert _mirror_cooldown_for(4) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS * 8)


def test_mirror_cooldown_caps_at_max():
    big = _mirror_cooldown_for(99)
    assert big == timedelta(seconds=MIRROR_MAX_COOLDOWN_SECONDS)


def test_mirror_cooldown_handles_zero_or_negative_attempt():
    # attempt=0 should still produce a reasonable wait, not zero.
    assert _mirror_cooldown_for(0) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS)
    # Defensive: negative is treated as zero.
    assert _mirror_cooldown_for(-1) == timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS)


@pytest.mark.parametrize("attempt", [1, 2, 3, 4, 5, 10])
def test_submit_backoff_full_jitter_within_capped_window(attempt: int):
    # Run many samples — full jitter is uniform [1, cap], so observed max should
    # land near the cap and observed min stays positive.
    samples = [_submit_backoff_for(attempt) for _ in range(500)]
    # Each sample is at least 1 second.
    assert min(samples) >= 1
    # And no sample exceeds the per-attempt cap (or the global cap, whichever is smaller).
    expected_cap = min(
        SUBMIT_BASE_BACKOFF_SECONDS * (2 ** max(attempt - 1, 0)),
        SUBMIT_MAX_BACKOFF_SECONDS,
    )
    assert max(samples) <= expected_cap


def test_submit_backoff_caps_at_max_for_huge_attempt():
    # Attempt high enough that 2^(n-1) overflows the cap many times over.
    samples = [_submit_backoff_for(50) for _ in range(200)]
    assert max(samples) <= SUBMIT_MAX_BACKOFF_SECONDS
