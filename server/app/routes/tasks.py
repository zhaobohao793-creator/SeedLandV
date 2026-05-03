import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.session import get_session
from app.models import Task, TaskAsset, User
from app.models.enums import TaskStatus
from app.routes.assets import _redis as _assets_redis, asset_token_key
from app.schemas.tasks import (
    AssetPreview,
    AssetSourceUpload,
    AssetSourceUrl,
    SubmitTaskRequest,
    SubmitTaskResponse,
    TaskOut,
)
from app.storage.quota import consume_ark_submit_quota

router = APIRouter(prefix="/v1/tasks", tags=["tasks"])


def _params_to_jsonb(p) -> dict[str, Any]:
    return p.model_dump(exclude_none=True)


async def _resolve_asset_token(token: str, user: User) -> dict[str, Any]:
    """Look up an asset_token in Redis; enforce tenant ownership + non-expiry."""
    raw = await _assets_redis().get(asset_token_key(token))
    if raw is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "asset_token 无效或已过期,请重新上传"
        )
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "asset_token 数据损坏"
        ) from e
    if data.get("tenant_id") != str(user.tenant_id):
        # Don't leak existence — same error as missing.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "asset_token 无效或已过期,请重新上传"
        )
    if not data.get("tos_key"):
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "asset_token 缺少 tos_key"
        )
    return data


def _epoch_ms(dt: datetime | None) -> int:
    return int(dt.timestamp() * 1000) if dt else 0


def _to_task_out(task: Task, assets: list[TaskAsset]) -> TaskOut:
    previews = [
        AssetPreview(
            kind=a.kind,  # type: ignore[arg-type]
            label=a.origin_url or (a.tos_key or "uploaded"),
        )
        for a in assets
    ]
    return TaskOut(
        server_id=task.uuid,
        id=task.ark_task_id,
        localId=task.local_id,
        mode=task.mode,  # type: ignore[arg-type]
        prompt=task.prompt,
        params=task.params,  # type: ignore[arg-type]
        assetsPreview=previews,
        status=task.status,
        videoUrl=task.tos_video_url or task.ark_video_url,
        lastFrameUrl=task.ark_last_frame,
        error=task.error,  # type: ignore[arg-type]
        createdAt=_epoch_ms(task.created_at),
        updatedAt=_epoch_ms(task.updated_at),
        usage=task.usage,  # type: ignore[arg-type]
    )


@router.post("", response_model=SubmitTaskResponse, status_code=status.HTTP_202_ACCEPTED)
async def submit_task(
    req: SubmitTaskRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SubmitTaskResponse:
    # Phase 6: per-tenant fixed-window quota. Always emits X-RateLimit-* so the
    # renderer can show "X submits left this hour"; rejects with 429 +
    # Retry-After when over budget. Counter increments even on rejection so
    # spammers don't game the bucket via concurrent retries.
    quota = consume_ark_submit_quota(user.tenant_id)
    response.headers["X-RateLimit-Limit"] = str(quota.limit)
    response.headers["X-RateLimit-Remaining"] = str(quota.remaining)
    response.headers["X-RateLimit-Reset"] = str(quota.reset_in_seconds)
    if not quota.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"已达到每小时提交上限({quota.limit}),请 {quota.reset_in_seconds}s 后再试",
            headers={
                "Retry-After": str(quota.reset_in_seconds),
                "X-RateLimit-Limit": str(quota.limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(quota.reset_in_seconds),
            },
        )

    task = Task(
        tenant_id=user.tenant_id,
        user_id=user.id,
        local_id=req.localId,
        mode=req.mode.value,
        prompt=req.prompt,
        params=_params_to_jsonb(req.params),
        status=TaskStatus.PENDING,
    )
    session.add(task)
    await session.flush()

    for idx, asset in enumerate(req.assets):
        if isinstance(asset, AssetSourceUrl):
            session.add(
                TaskAsset(
                    task_id=task.id,
                    position=idx,
                    kind=asset.kind.value,
                    source="url",
                    origin_url=asset.url,
                )
            )
        elif isinstance(asset, AssetSourceUpload):
            resolved = await _resolve_asset_token(asset.asset_token, user)
            if resolved["kind"] != asset.kind.value:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"asset_token kind mismatch (token={resolved['kind']}, request={asset.kind.value})",
                )
            session.add(
                TaskAsset(
                    task_id=task.id,
                    position=idx,
                    kind=asset.kind.value,
                    source="upload",
                    tos_key=resolved["tos_key"],
                    mime=resolved.get("mime"),
                    size_bytes=resolved.get("size_bytes"),
                )
            )

    await session.commit()

    # Enqueue Celery task (sync .delay; Celery's broker call is fast and we don't await it).
    from app.workers.tasks import ark_submit_and_poll

    ark_submit_and_poll.delay(task.id)

    return SubmitTaskResponse(
        server_id=task.uuid, localId=task.local_id, status=task.status
    )


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
    limit: int = 100,
) -> list[TaskOut]:
    rows = (
        await session.scalars(
            select(Task)
            .where(Task.tenant_id == user.tenant_id)
            .order_by(desc(Task.created_at))
            .limit(limit)
        )
    ).all()
    out: list[TaskOut] = []
    for t in rows:
        assets = (
            await session.scalars(
                select(TaskAsset).where(TaskAsset.task_id == t.id).order_by(TaskAsset.position)
            )
        ).all()
        out.append(_to_task_out(t, list(assets)))
    return out


@router.get("/{server_id}", response_model=TaskOut)
async def get_task(
    server_id: UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TaskOut:
    task = await session.scalar(
        select(Task).where(Task.uuid == server_id, Task.tenant_id == user.tenant_id)
    )
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    assets = (
        await session.scalars(
            select(TaskAsset).where(TaskAsset.task_id == task.id).order_by(TaskAsset.position)
        )
    ).all()
    return _to_task_out(task, list(assets))


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    server_id: UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    task = await session.scalar(
        select(Task).where(Task.uuid == server_id, Task.tenant_id == user.tenant_id)
    )
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    await session.delete(task)
    await session.commit()


@router.get("/{server_id}/video-url")
async def get_task_video_url(
    server_id: UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Re-sign a fresh 7d TOS GET URL for a mirrored video. The cached URL on
    the row is updated as a side effect so subsequent WS snapshots stay fresh."""
    task = await session.scalar(
        select(Task).where(Task.uuid == server_id, Task.tenant_id == user.tenant_id)
    )
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    if not task.tos_video_key:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "video has not been mirrored yet"
        )

    from app.storage.tos import SEVEN_DAYS_SECONDS, get_tos_client

    tos_client = get_tos_client()
    url = tos_client.generate_presigned_get_url(task.tos_video_key)
    expires_at = datetime.now(UTC) + timedelta(seconds=SEVEN_DAYS_SECONDS)

    task.tos_video_url = url
    task.tos_video_url_expires_at = expires_at
    await session.commit()

    return {
        "video_url": url,
        "expires_at": expires_at.isoformat(),
        "ttl_seconds": SEVEN_DAYS_SECONDS,
    }
