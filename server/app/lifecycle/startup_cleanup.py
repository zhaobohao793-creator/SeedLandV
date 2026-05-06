"""Phase 8: 重启即清空契约。

API 进程启动时:
  1. Postgres 中所有非终态 task 行批量改 `failed`,写一条 `server_restart`
     审计事件。这避免重启窗口里前端看到卡死的 `running`/`mirroring`,也
     让本地状态成为可信源(Ark 侧浪费的一两个任务可接受)。
  2. Redis 中 Celery 队列相关 key 全清 —— 默认队列、unacked、result-meta、
     kombu binding 都删,避免重启后旧任务被重新派发。

不动 asset_token / 限流 / pub/sub 通道 —— 它们都有 TTL,自然过期。

单工作室单机部署假设:api 和 worker 同生共死(用户运维约定为 pkill 双
进程一起重启)。多副本或独立运维 worker 时,本路径不能跑 —— 会把 API
新提交但 worker 还没领走的行也误杀。
"""
from __future__ import annotations

import logging

import redis
from sqlalchemy import func as sa_func
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionLocal
from app.models import Task, TaskEvent
from app.models.enums import TERMINAL_STATUSES, TaskStatus

logger = logging.getLogger(__name__)


CELERY_QUEUE_KEYS = ("celery", "unacked", "unacked_index")
CELERY_SCAN_PATTERNS = ("celery-task-meta-*", "_kombu.binding.*")


async def purge_in_flight_tasks(session: AsyncSession) -> int:
    """把所有非终态 task 行打 failed,每行写一条审计事件。返回打 failed 的行数。"""
    non_terminal = [s for s in TaskStatus if s not in TERMINAL_STATUSES]
    task_ids = (
        await session.scalars(
            select(Task.id).where(Task.status.in_(non_terminal))
        )
    ).all()
    if not task_ids:
        return 0

    await session.execute(
        update(Task)
        .where(Task.id.in_(task_ids))
        .values(status=TaskStatus.FAILED, terminal_at=sa_func.now())
        .execution_options(synchronize_session=False)
    )
    for tid in task_ids:
        session.add(
            TaskEvent(
                task_id=tid,
                kind="server_restart",
                status=TaskStatus.FAILED,
                payload={"reason": "queue purge on boot"},
            )
        )
    await session.commit()
    return len(task_ids)


def flush_celery_queues(client: redis.Redis) -> int:
    """删 Celery 队列、result-meta、kombu binding 等 key。返回删除的 key 数。"""
    deleted = 0
    for key in CELERY_QUEUE_KEYS:
        deleted += client.delete(key)
    for pattern in CELERY_SCAN_PATTERNS:
        deleted += _scan_delete(client, pattern)
    return deleted


def _scan_delete(client: redis.Redis, pattern: str, batch: int = 1000) -> int:
    """SCAN + DEL 一批 key,避免 KEYS 阻塞。"""
    deleted = 0
    cursor = 0
    while True:
        cursor, keys = client.scan(cursor=cursor, match=pattern, count=batch)
        if keys:
            deleted += client.delete(*keys)
        if cursor == 0:
            break
    return deleted


async def run_startup_cleanup() -> dict[str, int]:
    """API 启动钩子:Postgres 非终态 → failed + Redis Celery key 清空。"""
    failed_count = 0
    redis_keys_deleted = 0

    try:
        async with SessionLocal() as session:
            failed_count = await purge_in_flight_tasks(session)
    except Exception:
        logger.exception("startup_cleanup: postgres purge failed")

    try:
        from app.realtime.publisher import _client as get_redis
        redis_keys_deleted = flush_celery_queues(get_redis())
    except Exception:
        logger.exception("startup_cleanup: redis flush failed")

    summary = (
        f"startup_cleanup: tasks_failed={failed_count} "
        f"redis_keys_deleted={redis_keys_deleted}"
    )
    logger.info(summary)
    # Also print so the line is visible under uvicorn's default log config,
    # which doesn't propagate app loggers to stdout.
    print(summary, flush=True)
    return {"tasks_failed": failed_count, "redis_keys_deleted": redis_keys_deleted}
