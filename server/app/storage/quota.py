"""Per-tenant fixed-window quota for Ark task submission.

Backed by Redis INCR + EXPIRE; bucket key is `ark_submit_quota:{tenant_id}:{epoch_hour}`.
Returns budget metadata (remaining, reset_in) so callers can populate
`X-RateLimit-*` / `Retry-After` response headers.

Fixed-window has a known burst issue at the boundary (a tenant can spend 2x
budget in the seconds straddling the hour rollover). Acceptable for the first
cut — Phase 7 can swap to GCRA if real traffic warrants it.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from functools import lru_cache
from uuid import UUID

import redis

from app.config import get_settings


WINDOW_SECONDS = 3600
# Safety margin on the bucket key TTL so a request that lands at second 3599
# still finds its key alive long enough to post-expire on Redis's lazy clock.
_KEY_TTL_PADDING = 100


@lru_cache
def _client() -> redis.Redis:
    return redis.Redis.from_url(get_settings().redis_url, decode_responses=True)


def _bucket_key(tenant_id: UUID | str, epoch_hour: int) -> str:
    return f"ark_submit_quota:{tenant_id}:{epoch_hour}"


@dataclass(frozen=True)
class QuotaResult:
    allowed: bool
    used: int
    limit: int
    remaining: int
    reset_in_seconds: int


def consume_ark_submit_quota(
    tenant_id: UUID | str,
    *,
    limit: int | None = None,
    now: float | None = None,
    client: redis.Redis | None = None,
) -> QuotaResult:
    """Atomically reserve one slot in the current hour's bucket. Always
    increments the counter, even when the request would be over budget — that's
    intentional so abusive clients keep paying for a key TTL refresh and don't
    accidentally drift the window via INCR-elsewhere races."""
    s = get_settings()
    if limit is None:
        limit = s.ark_submit_rate_limit_per_hour
    rc = client or _client()
    ts = time.time() if now is None else now
    epoch_hour = int(ts) // WINDOW_SECONDS
    reset_in = WINDOW_SECONDS - (int(ts) % WINDOW_SECONDS)
    key = _bucket_key(tenant_id, epoch_hour)

    pipe = rc.pipeline(transaction=False)
    pipe.incr(key, 1)
    pipe.expire(key, WINDOW_SECONDS + _KEY_TTL_PADDING)
    used, _ = pipe.execute()
    used = int(used)
    remaining = max(limit - used, 0)
    return QuotaResult(
        allowed=used <= limit,
        used=used,
        limit=limit,
        remaining=remaining,
        reset_in_seconds=reset_in,
    )
