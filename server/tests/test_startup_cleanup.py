"""Unit tests for app.lifecycle.startup_cleanup — Redis-side only.

Postgres-side `purge_in_flight_tasks` requires a live database; that path is
covered by manual end-to-end verification (see HANDOFF Phase 8) until the
integration test harness lands.
"""
from __future__ import annotations

from app.lifecycle.startup_cleanup import (
    CELERY_QUEUE_KEYS,
    CELERY_SCAN_PATTERNS,
    _scan_delete,
    flush_celery_queues,
)


class _FakeRedis:
    """Minimal Redis stand-in supporting delete + scan for our cleanup paths."""

    def __init__(self, store: dict[str, object] | None = None) -> None:
        self.store: dict[str, object] = dict(store or {})
        self.delete_calls: list[tuple[str, ...]] = []

    def delete(self, *keys: str) -> int:
        self.delete_calls.append(keys)
        removed = 0
        for k in keys:
            if k in self.store:
                del self.store[k]
                removed += 1
        return removed

    def scan(self, cursor: int = 0, match: str | None = None, count: int = 100):
        # Deterministic single-page scan: return everything matching the prefix
        # before '*' on first call, then signal "done" with cursor=0.
        if cursor != 0:
            return 0, []
        if match is None:
            keys = list(self.store.keys())
        else:
            prefix = match.rstrip("*")
            keys = [k for k in self.store.keys() if k.startswith(prefix)]
        return 0, keys


def test_flush_celery_queues_deletes_known_queue_keys():
    rc = _FakeRedis(store={"celery": [1, 2, 3], "unacked": {}, "unacked_index": []})
    deleted = flush_celery_queues(rc)
    assert deleted == 3
    assert all(k not in rc.store for k in CELERY_QUEUE_KEYS)


def test_flush_celery_queues_skips_missing_keys():
    rc = _FakeRedis(store={"celery": [1]})
    deleted = flush_celery_queues(rc)
    assert deleted == 1


def test_flush_celery_queues_scans_result_meta_and_kombu_bindings():
    rc = _FakeRedis(
        store={
            "celery-task-meta-abc": "x",
            "celery-task-meta-def": "y",
            "_kombu.binding.celery": "z",
            "_kombu.binding.something": "z",
            "asset_token:keep-me": "untouched",  # not in any pattern
            "ark_submit_quota:also-keep": "untouched",
        }
    )
    deleted = flush_celery_queues(rc)
    assert deleted == 4
    assert "asset_token:keep-me" in rc.store
    assert "ark_submit_quota:also-keep" in rc.store


def test_scan_delete_returns_zero_when_no_match():
    rc = _FakeRedis(store={"unrelated:key": "x"})
    assert _scan_delete(rc, "celery-task-meta-*") == 0
    assert "unrelated:key" in rc.store


def test_celery_scan_patterns_are_explicit_allowlist():
    # Guards against accidental wildcards that'd nuke asset_token / quota.
    assert CELERY_SCAN_PATTERNS == ("celery-task-meta-*", "_kombu.binding.*")
    for pat in CELERY_SCAN_PATTERNS:
        assert "asset_token" not in pat
        assert "ark_submit_quota" not in pat
        assert "task:" not in pat  # pub/sub channels
