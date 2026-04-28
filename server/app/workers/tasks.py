"""Celery worker: drive a Task row through the Ark submit + poll lifecycle."""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ark.builder import ResolvedAsset, TaskParams, build_payload
from app.ark.client import ArkClient, ArkError
from app.ark.poller import PollCancelled, PollTimeout, poll_until_done
from app.ark.types import ArkTaskResponse
from app.auth.crypto import decrypt_ark_key
from app.db.sync_session import SyncSessionLocal
from app.models import Task, TaskAsset, TaskEvent, Tenant
from app.models.enums import AssetKind, GenerationMode, TaskStatus, TERMINAL_STATUSES
from app.realtime.publisher import publish_task_update
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


def _resolve_assets(session: Session, task_id: int) -> list[ResolvedAsset]:
    rows = session.scalars(
        select(TaskAsset).where(TaskAsset.task_id == task_id).order_by(TaskAsset.position)
    ).all()
    resolved: list[ResolvedAsset] = []
    for row in rows:
        if row.source == "url":
            url = row.origin_url
        else:
            # Phase 4 wires TOS signed URLs here.
            raise RuntimeError(
                "asset uploads not implemented until Phase 4 — submit URLs only for now"
            )
        if not url:
            raise RuntimeError(f"task_assets.id={row.id} missing url")
        resolved.append(
            ResolvedAsset(kind=AssetKind(row.kind), url=url, position=row.position)
        )
    return resolved


def _update_status(
    session: Session,
    task: Task,
    status: TaskStatus,
    *,
    event_kind: str = "status",
    event_payload: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    task.status = status
    if status in TERMINAL_STATUSES:
        task.terminal_at = datetime.now(UTC)
    if extra:
        for k, v in extra.items():
            setattr(task, k, v)
    session.add(
        TaskEvent(task_id=task.id, kind=event_kind, status=status, payload=event_payload)
    )
    session.flush()


def _publish_snapshot(session: Session, task: Task) -> None:
    """Emit full TaskOut-shaped snapshot — renderer's `task:update` consumes this verbatim."""
    assets = session.scalars(
        select(TaskAsset).where(TaskAsset.task_id == task.id).order_by(TaskAsset.position)
    ).all()
    payload = {
        "server_id": str(task.uuid),
        "id": task.ark_task_id,
        "localId": task.local_id,
        "mode": task.mode,
        "prompt": task.prompt,
        "params": task.params,
        "assetsPreview": [
            {"kind": a.kind, "label": a.origin_url or (a.tos_key or "uploaded")}
            for a in assets
        ],
        "status": task.status.value,
        "videoUrl": task.tos_video_url or task.ark_video_url,
        "lastFrameUrl": task.ark_last_frame,
        "usage": task.usage,
        "error": task.error,
        "createdAt": int(task.created_at.timestamp() * 1000) if task.created_at else 0,
        "updatedAt": int(task.updated_at.timestamp() * 1000) if task.updated_at else 0,
    }
    publish_task_update(task.tenant_id, payload)


def _ark_client_for(session: Session, tenant_id) -> ArkClient:
    tenant = session.get(Tenant, tenant_id)
    if tenant is None:
        raise RuntimeError(f"tenant {tenant_id} not found")
    if not tenant.ark_api_key_ciphertext:
        raise RuntimeError("tenant has no Ark API key configured")
    return ArkClient(api_key=decrypt_ark_key(tenant.ark_api_key_ciphertext))


@celery_app.task(name="ark.submit_and_poll", bind=True, max_retries=0)
def ark_submit_and_poll(self, task_id: int) -> str:  # noqa: ANN001
    """Submit task to Ark, then poll to terminal status. Idempotent on `task_id`."""
    with SyncSessionLocal() as session:
        task: Task | None = session.get(Task, task_id)
        if task is None:
            logger.warning("ark.submit_and_poll: task_id=%s gone", task_id)
            return "missing"
        if task.status in TERMINAL_STATUSES:
            logger.info("ark.submit_and_poll: task_id=%s already terminal", task_id)
            return task.status.value

        try:
            assets = _resolve_assets(session, task.id)
            params_dict = task.params or {}
            params = TaskParams(
                model=params_dict["model"],
                resolution=params_dict.get("resolution"),
                ratio=params_dict.get("ratio"),
                duration=params_dict.get("duration"),
                watermark=params_dict.get("watermark"),
                generate_audio=params_dict.get("generateAudio"),
                return_last_frame=params_dict.get("returnLastFrame"),
                seed=params_dict.get("seed"),
            )
            payload = build_payload(GenerationMode(task.mode), task.prompt, assets, params)
        except Exception as e:
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={"phase": "build", "message": str(e)},
                extra={"error": {"message": str(e), "phase": "build"}},
            )
            session.commit()
            _publish_snapshot(session, task)
            raise

        _update_status(session, task, TaskStatus.SUBMITTING)
        session.commit()
        _publish_snapshot(session, task)

        try:
            client = _ark_client_for(session, task.tenant_id)
            sub = client.submit(payload)
        except ArkError as e:
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={"phase": "submit", "code": e.code, "raw": e.raw},
                extra={"error": {"message": str(e), "code": e.code, "raw": e.raw}},
            )
            session.commit()
            _publish_snapshot(session, task)
            return TaskStatus.FAILED.value
        except Exception as e:
            # Covers missing Ark Key, network, etc. — anything that prevents submit.
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={"phase": "submit", "message": str(e)},
                extra={"error": {"message": str(e), "phase": "submit"}},
            )
            session.commit()
            _publish_snapshot(session, task)
            return TaskStatus.FAILED.value

        task.ark_task_id = sub.id
        _update_status(session, task, TaskStatus.QUEUED)
        session.commit()
        _publish_snapshot(session, task)

        def on_update(snap: ArkTaskResponse) -> None:
            # Refresh task in this same session — long-running poll, so re-bind on each tick.
            t = session.get(Task, task_id)
            if t is None:
                return
            mapped = TaskStatus(snap.status)
            extra: dict[str, Any] = {}
            if snap.content:
                if snap.content.video_url:
                    extra["ark_video_url"] = snap.content.video_url
                if snap.content.last_frame_url:
                    extra["ark_last_frame"] = snap.content.last_frame_url
            if snap.usage:
                extra["usage"] = snap.usage.model_dump(exclude_none=True)
            _update_status(
                session,
                t,
                mapped,
                event_kind="ark_response",
                event_payload=snap.model_dump(exclude_none=True),
                extra=extra,
            )
            session.commit()
            _publish_snapshot(session, t)

        try:
            final = poll_until_done(client, sub.id, on_update=on_update)
        except PollTimeout as e:
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={"phase": "poll", "message": str(e)},
                extra={"error": {"message": "轮询超时", "raw": str(e)}},
            )
            session.commit()
            _publish_snapshot(session, task)
            return TaskStatus.FAILED.value
        except PollCancelled:
            return TaskStatus.CANCELLED.value
        except ArkError as e:
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={"phase": "poll", "code": e.code, "raw": e.raw},
                extra={"error": {"message": str(e), "code": e.code, "raw": e.raw}},
            )
            session.commit()
            _publish_snapshot(session, task)
            return TaskStatus.FAILED.value

        # Terminal handling (final state already written by on_update).
        # Phase 5 will enqueue tos_mirror_video here on success.
        return final.status
