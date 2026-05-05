"""Celery worker: drive a Task row through the Ark submit + poll lifecycle,
then mirror the finished video into our TOS bucket so we own the URL."""
from __future__ import annotations

import logging
import random
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import or_, select
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

# Phase 5: mirror retry budget and cooldowns.
MIRROR_MAX_ATTEMPTS = 5
# Phase 6: replace the fixed 5-minute mirror cooldown with per-attempt
# exponential backoff so transient TOS hiccups recover fast but persistent
# failures don't hammer the bucket.
MIRROR_BASE_COOLDOWN_SECONDS = 60
MIRROR_MAX_COOLDOWN_SECONDS = 60 * 60  # 1h cap
# A row stuck in `mirroring` for longer than this means the worker that claimed
# it crashed; the sweeper rolls it back to `succeeded` so it can be re-tried.
MIRROR_STUCK_THRESHOLD = timedelta(minutes=15)
# Re-sign URLs that will expire within this window.
URL_REFRESH_LEAD = timedelta(hours=24)

# Phase 6: Ark submit-time retry budget. `attempt` column is bumped on each
# transient ArkError (5xx / 429); permanent errors (4xx other than 429) skip
# retry and fail immediately.
SUBMIT_MAX_ATTEMPTS = 5
SUBMIT_BASE_BACKOFF_SECONDS = 30
SUBMIT_MAX_BACKOFF_SECONDS = 600  # 10 min cap


def _mirror_cooldown_for(attempt: int) -> timedelta:
    """Exponential cooldown between mirror retries. attempt is the count of
    *prior* failed attempts (0-indexed before this run), so the first wait is
    `MIRROR_BASE_COOLDOWN_SECONDS`."""
    secs = MIRROR_BASE_COOLDOWN_SECONDS * (2 ** max(attempt - 1, 0))
    return timedelta(seconds=min(secs, MIRROR_MAX_COOLDOWN_SECONDS))


def _submit_backoff_for(attempt: int) -> int:
    """Full-jitter exponential backoff for Ark submit retries. `attempt` is the
    count of submissions already attempted (>=1). Returns seconds to sleep
    before the next try."""
    cap = min(
        SUBMIT_BASE_BACKOFF_SECONDS * (2 ** max(attempt - 1, 0)),
        SUBMIT_MAX_BACKOFF_SECONDS,
    )
    # Full jitter — uniform [0, cap]; reduces thundering herd on synchronized
    # 429 storms without losing the upper bound.
    return random.randint(1, max(cap, 1))


def _resolve_assets(session: Session, task_id: int) -> list[ResolvedAsset]:
    rows = session.scalars(
        select(TaskAsset).where(TaskAsset.task_id == task_id).order_by(TaskAsset.position)
    ).all()
    resolved: list[ResolvedAsset] = []
    tos_client = None
    for row in rows:
        if row.source == "url":
            url = row.origin_url
        elif row.source == "upload":
            if not row.tos_key:
                raise RuntimeError(f"task_assets.id={row.id} upload row missing tos_key")
            if tos_client is None:
                from app.storage.tos import get_tos_client
                tos_client = get_tos_client()
            url = tos_client.generate_presigned_get_url(row.tos_key)
        else:
            raise RuntimeError(
                f"task_assets.id={row.id} unknown source={row.source!r}"
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
        "orderId": task.order_id,
        "orderSeq": task.order_seq,
        "mode": task.mode,
        "prompt": task.prompt,
        "params": task.params,
        "assetsPreview": [
            {"kind": a.kind, "label": a.origin_url or (a.tos_key or "uploaded")}
            for a in assets
        ],
        "status": task.status.value,
        "videoUrl": task.tos_video_url or task.ark_video_url,
        "lastFrameUrl": task.tos_last_frame_url or task.ark_last_frame,
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


@celery_app.task(
    name="ark.submit_and_poll",
    bind=True,
    max_retries=SUBMIT_MAX_ATTEMPTS,
    autoretry_for=(),  # we drive retries manually via self.retry(...)
)
def ark_submit_and_poll(self, task_id: int) -> str:  # noqa: ANN001
    """Submit task to Ark, then poll to terminal status. Idempotent on `task_id`.

    Phase 6: transient submit errors (5xx / 429 / network) are re-enqueued with
    full-jitter exponential backoff, bumping `tasks.attempt`. Permanent 4xx and
    auth errors fail the task immediately. Poll-phase transient errors are
    already handled inside `poll_until_done`."""
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
            # Transient → bump attempt, schedule retry, keep task visible as
            # SUBMITTING (renderer shows "retrying" via the event payload).
            if e.is_transient and task.attempt < SUBMIT_MAX_ATTEMPTS:
                task.attempt += 1
                countdown = _submit_backoff_for(task.attempt)
                _update_status(
                    session,
                    task,
                    TaskStatus.SUBMITTING,
                    event_kind="submit_retry",
                    event_payload={
                        "attempt": task.attempt,
                        "countdown_s": countdown,
                        "code": e.code,
                        "status": e.status,
                    },
                )
                session.commit()
                _publish_snapshot(session, task)
                logger.warning(
                    "ark.submit transient task_id=%s attempt=%s/%s countdown=%ss code=%s",
                    task_id, task.attempt, SUBMIT_MAX_ATTEMPTS, countdown, e.code,
                )
                raise self.retry(exc=e, countdown=countdown)
            # Permanent (4xx other than 429) or out of retries → fail.
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={
                    "phase": "submit",
                    "code": e.code,
                    "raw": e.raw,
                    "attempt": task.attempt,
                },
                extra={"error": {"message": str(e), "code": e.code, "raw": e.raw}},
            )
            session.commit()
            _publish_snapshot(session, task)
            return TaskStatus.FAILED.value
        except Exception as e:
            # Network errors / DNS / missing Ark Key → treat network-class as
            # transient (retryable), missing-key as permanent.
            transient = isinstance(e, (httpx.RequestError, ConnectionError))
            if transient and task.attempt < SUBMIT_MAX_ATTEMPTS:
                task.attempt += 1
                countdown = _submit_backoff_for(task.attempt)
                _update_status(
                    session,
                    task,
                    TaskStatus.SUBMITTING,
                    event_kind="submit_retry",
                    event_payload={
                        "attempt": task.attempt,
                        "countdown_s": countdown,
                        "exc": type(e).__name__,
                    },
                )
                session.commit()
                _publish_snapshot(session, task)
                raise self.retry(exc=e, countdown=countdown)
            _update_status(
                session,
                task,
                TaskStatus.FAILED,
                event_kind="error",
                event_payload={
                    "phase": "submit",
                    "message": str(e),
                    "exc": type(e).__name__,
                    "attempt": task.attempt,
                },
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

        # Terminal handling (final state already written by on_update). On a
        # successful Ark render, hand off to the mirror task — the row stays in
        # `succeeded` and gets bumped to `completed` once TOS has the bytes.
        if final.status == TaskStatus.SUCCEEDED.value:
            t = session.get(Task, task_id)
            if t is not None and t.ark_video_url and t.tos_video_key is None:
                tos_mirror_video.delay(task_id)
        return final.status


def _claim_mirror_row(session: Session, task_id: int) -> Task | None:
    """Lock the row, validate state, bump attempt counter, transition to
    MIRRORING. Returns the locked task on success, or None if we should bail
    (already mirrored / wrong state / out of retries / contested by another
    worker). Caller must `session.commit()` after this returns a row."""
    task = session.execute(
        select(Task).where(Task.id == task_id).with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if task is None:
        return None
    if task.tos_video_key is not None:
        return None  # already mirrored
    if not task.ark_video_url:
        return None  # nothing to mirror
    if task.status not in (TaskStatus.SUCCEEDED, TaskStatus.MIRRORING):
        return None  # wrong state — don't touch terminal rows
    if task.mirror_attempt >= MIRROR_MAX_ATTEMPTS:
        # Permanent failure: keep the Ark URL (24h validity) but mark the row
        # so the renderer knows there's no permanent mirror.
        _update_status(
            session,
            task,
            TaskStatus.COMPLETED_PARTIAL,
            event_kind="mirror_giveup",
            event_payload={"attempts": task.mirror_attempt},
        )
        return None
    # Recent attempt? Another worker is/was on this row; wait for the cooldown
    # appropriate to the current attempt count (Phase 6: exponential).
    if task.mirror_last_attempt_at is not None:
        cooldown = _mirror_cooldown_for(task.mirror_attempt)
        if datetime.now(UTC) - task.mirror_last_attempt_at < cooldown:
            return None
    task.mirror_attempt += 1
    task.mirror_last_attempt_at = datetime.now(UTC)
    _update_status(
        session,
        task,
        TaskStatus.MIRRORING,
        event_kind="mirror_start",
        event_payload={"attempt": task.mirror_attempt},
    )
    return task


@celery_app.task(name="tos.mirror_video", bind=True, max_retries=0)
def tos_mirror_video(self, task_id: int) -> str:  # noqa: ANN001
    """Pull `tasks.ark_video_url` into our TOS bucket. Idempotent on `task_id`.

    Phase 1 (short txn): claim the row + bump attempt + transition to MIRRORING.
    Phase 2 (no DB): stream Ark URL → SpooledTempFile → TOS PUT (slow network IO).
    Phase 3 (short txn): record success or rewind status to SUCCEEDED for retry.
    """
    src_url: str | None = None
    src_last_frame: str | None = None
    task_uuid = None
    tenant_id = None
    with SyncSessionLocal() as session:
        task = _claim_mirror_row(session, task_id)
        session.commit()
        if task is None:
            # _claim_mirror_row may have committed a give-up transition; publish
            # a snapshot in that case so the renderer sees COMPLETED_PARTIAL.
            t = session.get(Task, task_id)
            if t is not None and t.status == TaskStatus.COMPLETED_PARTIAL:
                _publish_snapshot(session, t)
            return "skip"
        _publish_snapshot(session, task)
        src_url = task.ark_video_url
        src_last_frame = task.ark_last_frame
        task_uuid = task.uuid
        tenant_id = task.tenant_id

    # --- network phase, no DB lock held ---
    from app.storage.tos import (
        SEVEN_DAYS_SECONDS,
        build_last_frame_key,
        build_video_key,
        get_tos_client,
        mirror_url_to_tos,
    )

    dest_key = build_video_key(task_uuid)
    try:
        tos_client = get_tos_client()
        bytes_written = mirror_url_to_tos(
            client=tos_client,
            src_url=src_url,
            dest_key=dest_key,
            content_type="video/mp4",
        )
        signed_url = tos_client.generate_presigned_get_url(dest_key)
    except Exception as e:
        logger.exception("tos.mirror_video failed task_id=%s", task_id)
        with SyncSessionLocal() as session:
            t = session.get(Task, task_id)
            if t is None:
                return "missing"
            t.mirror_error = {
                "message": str(e),
                "type": type(e).__name__,
                "at": datetime.now(UTC).isoformat(),
            }
            # Roll status back to SUCCEEDED so the next sweep / retry can pick it
            # up. Don't decrement attempt — we already burned one.
            _update_status(
                session,
                t,
                TaskStatus.SUCCEEDED,
                event_kind="mirror_error",
                event_payload={"message": str(e), "attempt": t.mirror_attempt},
            )
            session.commit()
            _publish_snapshot(session, t)
        return "failed"

    # Best-effort last-frame mirror — Ark only serves the still for ~hours, so
    # we grab it inside the same network phase as the video. A failure here is
    # non-fatal: the task is still COMPLETED with a usable video; the renderer
    # falls back to a video poster instead of a still image.
    last_frame_key: str | None = None
    last_frame_signed_url: str | None = None
    if src_last_frame:
        candidate_key = build_last_frame_key(task_uuid)
        try:
            mirror_url_to_tos(
                client=tos_client,
                src_url=src_last_frame,
                dest_key=candidate_key,
                content_type="image/png",
            )
            last_frame_key = candidate_key
            last_frame_signed_url = tos_client.generate_presigned_get_url(candidate_key)
        except Exception as e:
            logger.warning(
                "tos.mirror_last_frame failed task_id=%s: %s", task_id, e
            )

    signed_at = datetime.now(UTC)
    expires_at = signed_at + timedelta(seconds=SEVEN_DAYS_SECONDS)
    with SyncSessionLocal() as session:
        t = session.get(Task, task_id)
        if t is None:
            return "missing"
        t.tos_video_key = dest_key
        t.tos_video_url = signed_url
        t.tos_video_url_expires_at = expires_at
        if last_frame_key:
            t.tos_last_frame_key = last_frame_key
            t.tos_last_frame_url = last_frame_signed_url
            t.tos_last_frame_url_expires_at = expires_at
        t.mirror_error = None
        _update_status(
            session,
            t,
            TaskStatus.COMPLETED,
            event_kind="mirror_done",
            event_payload={"bytes": bytes_written, "key": dest_key},
        )
        session.commit()
        _publish_snapshot(session, t)
    return "ok"


@celery_app.task(name="tos.mirror_retry_sweep")
def mirror_retry_sweep(limit: int = 100) -> dict[str, int]:
    """Periodic sweep: re-enqueue mirror for stuck or failed rows.

    Two passes:
      1. Rows in MIRRORING for too long → roll back to SUCCEEDED (claimer crashed).
      2. Rows in SUCCEEDED with no tos_video_key + retry budget left + cooldown elapsed.
    """
    now = datetime.now(UTC)
    enqueued: list[int] = []
    rolled_back = 0
    with SyncSessionLocal() as session:
        stuck = session.scalars(
            select(Task).where(
                Task.status == TaskStatus.MIRRORING,
                Task.tos_video_key.is_(None),
                Task.mirror_last_attempt_at < now - MIRROR_STUCK_THRESHOLD,
            ).limit(limit)
        ).all()
        for t in stuck:
            _update_status(
                session,
                t,
                TaskStatus.SUCCEEDED,
                event_kind="mirror_stuck_rollback",
                event_payload={"attempt": t.mirror_attempt},
            )
            rolled_back += 1
        if rolled_back:
            session.commit()
            for t in stuck:
                _publish_snapshot(session, t)

        # Coarse SQL filter using the *minimum* per-attempt cooldown — the
        # actual exponential gate is enforced by `_claim_mirror_row`. We over-
        # enqueue here and let the worker bail cheaply on contested rows; this
        # is simpler than encoding the exponential ladder in a CASE expression.
        min_cooldown = timedelta(seconds=MIRROR_BASE_COOLDOWN_SECONDS)
        candidates = session.scalars(
            select(Task.id).where(
                Task.status == TaskStatus.SUCCEEDED,
                Task.tos_video_key.is_(None),
                Task.mirror_attempt < MIRROR_MAX_ATTEMPTS,
                or_(
                    Task.mirror_last_attempt_at.is_(None),
                    Task.mirror_last_attempt_at < now - min_cooldown,
                ),
            ).limit(limit)
        ).all()
        enqueued = list(candidates)

    for tid in enqueued:
        tos_mirror_video.delay(tid)
    return {"enqueued": len(enqueued), "rolled_back": rolled_back}


@celery_app.task(name="tos.signed_url_refresh")
def signed_url_refresh(limit: int = 500) -> dict[str, int]:
    """Re-sign TOS URLs that fall within the refresh lead window. Cheap — no
    upload, just a fresh `pre_signed_url` call per row."""
    cutoff = datetime.now(UTC) + URL_REFRESH_LEAD
    refreshed = 0
    with SyncSessionLocal() as session:
        rows = session.scalars(
            select(Task).where(
                Task.tos_video_key.is_not(None),
                or_(
                    Task.tos_video_url_expires_at.is_(None),
                    Task.tos_video_url_expires_at < cutoff,
                ),
            ).limit(limit)
        ).all()
        if not rows:
            return {"refreshed": 0}

        from app.storage.tos import SEVEN_DAYS_SECONDS, get_tos_client

        tos_client = get_tos_client()
        new_expiry = datetime.now(UTC) + timedelta(seconds=SEVEN_DAYS_SECONDS)
        for t in rows:
            t.tos_video_url = tos_client.generate_presigned_get_url(t.tos_video_key)
            t.tos_video_url_expires_at = new_expiry
            if t.tos_last_frame_key:
                t.tos_last_frame_url = tos_client.generate_presigned_get_url(
                    t.tos_last_frame_key
                )
                t.tos_last_frame_url_expires_at = new_expiry
            refreshed += 1
        session.commit()
        for t in rows:
            _publish_snapshot(session, t)
    return {"refreshed": refreshed}
