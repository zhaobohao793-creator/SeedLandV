"""Admin order history with employee_id / order_id / status / date filters.

Tenant-scoped reader endpoint distinct from `/v1/tasks` (which is per-user).
The renderer's admin pane will hit this; the tenant `GET /v1/tasks` contract
stays untouched.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_admin
from app.db.session import get_session
from app.models import Task, TaskAsset, User
from app.models.enums import TaskStatus
from app.routes.tasks import _to_task_out
from app.schemas.tasks import AdminOrderOut

router = APIRouter(prefix="/v1/admin/orders", tags=["admin"])


@router.get("", response_model=list[AdminOrderOut])
async def list_orders(
    employee_id: Optional[str] = Query(default=None, max_length=64),
    order_id: Optional[str] = Query(default=None, max_length=64),
    status: Optional[TaskStatus] = Query(default=None),
    from_: Optional[datetime] = Query(default=None, alias="from"),
    to: Optional[datetime] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
) -> list[AdminOrderOut]:
    stmt = (
        select(Task, User.employee_id, User.display_name)
        .join(User, User.id == Task.user_id, isouter=True)
        .where(Task.tenant_id == admin.tenant_id)
    )
    if employee_id is not None:
        stmt = stmt.where(User.employee_id == employee_id)
    if order_id is not None:
        stmt = stmt.where(Task.order_id == order_id)
    if status is not None:
        stmt = stmt.where(Task.status == status)
    if from_ is not None:
        stmt = stmt.where(Task.created_at >= from_)
    if to is not None:
        stmt = stmt.where(Task.created_at <= to)
    stmt = stmt.order_by(desc(Task.created_at)).limit(limit).offset(offset)

    rows = (await session.execute(stmt)).all()
    out: list[AdminOrderOut] = []
    for task, emp_id, emp_name in rows:
        assets = (
            await session.scalars(
                select(TaskAsset)
                .where(TaskAsset.task_id == task.id)
                .order_by(TaskAsset.position)
            )
        ).all()
        base = _to_task_out(task, list(assets))
        out.append(
            AdminOrderOut(
                **base.model_dump(by_alias=False),
                employeeId=emp_id,
                employeeDisplayName=emp_name,
            )
        )
    return out
