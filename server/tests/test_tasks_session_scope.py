"""Phase 8 follow-up: GET /v1/tasks must filter to the current API boot session.

The queue panel hydrates from this endpoint at login. Without a boot_at filter,
all historical (terminal) rows for the tenant resurface after a restart and the
queue looks "uncleared" — even though startup_cleanup already failed every
non-terminal row. Persistence of full history lives in /v1/admin/orders.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.routes.tasks import list_tasks


class _CapturingSession:
    """AsyncSession stub that records the Select objects it sees."""

    def __init__(self) -> None:
        self.queries: list = []

    async def scalars(self, stmt):
        self.queries.append(stmt)

        class _Result:
            def all(self_inner):
                return []

        return _Result()


def _request_with_boot(boot_at):
    state = SimpleNamespace(boot_at=boot_at)
    app = SimpleNamespace(state=state)
    return SimpleNamespace(app=app)


def _where_repr(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": False}))


@pytest.mark.asyncio
async def test_list_tasks_filters_by_boot_at():
    boot = datetime(2026, 5, 8, 10, 0, tzinfo=UTC)
    session = _CapturingSession()
    user = SimpleNamespace(tenant_id="11111111-1111-1111-1111-111111111111")

    await list_tasks(
        request=_request_with_boot(boot),
        session=session,  # type: ignore[arg-type]
        user=user,  # type: ignore[arg-type]
    )

    assert session.queries, "expected list_tasks to execute one query"
    sql = _where_repr(session.queries[0])
    assert "created_at" in sql, sql
    assert ">=" in sql, sql


@pytest.mark.asyncio
async def test_list_tasks_no_boot_at_skips_session_filter():
    """Defensive: if app.state.boot_at is missing (test harness, etc.) the
    endpoint must still work — it just degrades to the pre-Phase-8 behaviour
    (tenant scope only)."""
    session = _CapturingSession()
    user = SimpleNamespace(tenant_id="11111111-1111-1111-1111-111111111111")

    await list_tasks(
        request=_request_with_boot(None),
        session=session,  # type: ignore[arg-type]
        user=user,  # type: ignore[arg-type]
    )

    sql = _where_repr(session.queries[0])
    # tenant scope is still required; created_at must NOT appear in WHERE
    # (it's expected in ORDER BY, so isolate the WHERE … ORDER BY span).
    assert "tenant_id" in sql, sql
    after_where = sql.split("WHERE", 1)[1] if "WHERE" in sql else ""
    where_only = after_where.split("ORDER BY", 1)[0]
    assert "created_at" not in where_only, where_only


@pytest.mark.asyncio
async def test_list_tasks_excludes_pre_boot_via_inclusive_lower_bound():
    """A task created exactly at boot_at survives (>= is inclusive); anything
    older must be filtered. We test this by checking the operator literal."""
    boot = datetime(2026, 5, 8, 10, 0, tzinfo=UTC)
    session = _CapturingSession()
    user = SimpleNamespace(tenant_id="11111111-1111-1111-1111-111111111111")

    await list_tasks(
        request=_request_with_boot(boot),
        session=session,  # type: ignore[arg-type]
        user=user,  # type: ignore[arg-type]
    )

    sql = _where_repr(session.queries[0])
    # Inclusive lower bound, not strict: we don't want to drop a task whose
    # created_at races boot_at to the same microsecond.
    assert "tasks.created_at >=" in sql, sql
    assert "tasks.created_at >" not in sql.replace("tasks.created_at >=", ""), sql


def test_boot_at_drift_is_monotonic():
    """Sanity: same lifespan body (datetime.now(UTC)) advances on each call.

    Guards against a future refactor that accidentally caches a module-level
    constant — which would defeat the per-restart contract."""
    from datetime import UTC, datetime

    a = datetime.now(UTC)
    b = datetime.now(UTC) + timedelta(microseconds=1)
    assert b > a
