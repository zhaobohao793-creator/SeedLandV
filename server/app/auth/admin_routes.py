"""Admin-only employee CRUD. Workshop owners (is_admin=True) manage staff
accounts here instead of the public /v1/auth/register flow we used to ship."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_admin
from app.auth.schemas import (
    CreateEmployeeRequest,
    UpdateEmployeeRequest,
    UserOut,
)
from app.auth.security import hash_password
from app.db.session import get_session
from app.models import User

router = APIRouter(prefix="/v1/admin/employees", tags=["admin"])


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        tenant_id=user.tenant_id,
        employee_id=user.employee_id,
        display_name=user.display_name,
        email=user.email,
        is_admin=user.is_admin,
        is_active=user.is_active,
    )


@router.get("", response_model=list[UserOut])
async def list_employees(
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
) -> list[UserOut]:
    rows = (
        await session.scalars(
            select(User)
            .where(User.tenant_id == admin.tenant_id)
            .order_by(User.created_at)
        )
    ).all()
    return [_user_out(u) for u in rows]


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_employee(
    req: CreateEmployeeRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    user = User(
        tenant_id=admin.tenant_id,
        employee_id=req.employee_id,
        display_name=req.display_name or req.employee_id,
        email=req.email,
        password_hash=hash_password(req.password),
        is_admin=req.is_admin,
        is_active=True,
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "工号已存在"
        ) from e
    await session.refresh(user)
    return _user_out(user)


@router.patch("/{user_id}", response_model=UserOut)
async def update_employee(
    user_id: UUID,
    req: UpdateEmployeeRequest,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    user = await session.scalar(
        select(User).where(User.id == user_id, User.tenant_id == admin.tenant_id)
    )
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "员工不存在")

    if req.display_name is not None:
        user.display_name = req.display_name
    if req.password is not None:
        user.password_hash = hash_password(req.password)
    if req.is_admin is not None:
        # Refuse to demote the last remaining admin so the workshop can't
        # accidentally lock itself out of the management UI.
        if user.is_admin and not req.is_admin:
            remaining = (
                await session.scalars(
                    select(User).where(
                        User.tenant_id == admin.tenant_id,
                        User.is_admin.is_(True),
                        User.is_active.is_(True),
                        User.id != user.id,
                    )
                )
            ).all()
            if not remaining:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "不能取消最后一个管理员的权限",
                )
        user.is_admin = req.is_admin
    if req.is_active is not None:
        if user.is_active and not req.is_active and user.id == admin.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "不能停用自己的账号"
            )
        user.is_active = req.is_active

    await session.commit()
    await session.refresh(user)
    return _user_out(user)


@router.delete("/{user_id}", response_model=UserOut)
async def deactivate_employee(
    user_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    """Soft-delete: flips is_active=False so historical task.user_id stays valid."""
    user = await session.scalar(
        select(User).where(User.id == user_id, User.tenant_id == admin.tenant_id)
    )
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "员工不存在")
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能停用自己的账号")
    user.is_active = False
    await session.commit()
    await session.refresh(user)
    return _user_out(user)
