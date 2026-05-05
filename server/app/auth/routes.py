from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.schemas import (
    BootstrapRequest,
    LoginRequest,
    RefreshRequest,
    TokenResponse,
    UserOut,
)
from app.auth.security import (
    TokenError,
    decode_token,
    encode_access_token,
    encode_refresh_token,
    hash_password,
    verify_password,
)
from app.config import get_settings
from app.db.session import get_session
from app.models import Tenant, User

router = APIRouter(prefix="/v1/auth", tags=["auth"])


def _token_response(user: User) -> TokenResponse:
    s = get_settings()
    return TokenResponse(
        access_token=encode_access_token(
            user.id, user.tenant_id, user.employee_id, user.is_admin
        ),
        refresh_token=encode_refresh_token(user.id),
        expires_in=s.jwt_access_ttl_seconds,
    )


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


@router.get("/bootstrap")
async def bootstrap_status(
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    """Lets the renderer decide whether to show the login form or the
    first-run bootstrap form on a fresh install."""
    count = await session.scalar(select(func.count()).select_from(Tenant))
    return {"initialized": bool(count)}


@router.post(
    "/bootstrap",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bootstrap(
    req: BootstrapRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    """One-shot setup: creates the first tenant + admin when DB is empty.

    Returns 409 once any tenant exists, so this endpoint can stay live in
    production without becoming a re-registration backdoor. After bootstrap,
    employees are created via /v1/admin/employees by an authenticated admin.
    """
    existing = await session.scalar(select(func.count()).select_from(Tenant))
    if existing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "system already initialized; ask an administrator to create your account",
        )

    tenant = Tenant(name=req.workshop_name)
    session.add(tenant)
    await session.flush()

    user = User(
        tenant_id=tenant.id,
        employee_id=req.employee_id,
        display_name=req.display_name or req.employee_id,
        password_hash=hash_password(req.password),
        is_admin=True,
        is_active=True,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return _token_response(user)


@router.post("/login", response_model=TokenResponse)
async def login(
    req: LoginRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    # Single-tenant delivery model: employee_id is globally unambiguous in
    # practice. If multiple tenants exist (future), the matching set should
    # collapse to one — otherwise we treat as bad credentials to avoid leaking
    # which workshop a given employee_id belongs to.
    rows = (
        await session.scalars(
            select(User).where(
                User.employee_id == req.employee_id, User.is_active.is_(True)
            )
        )
    ).all()
    if len(rows) != 1:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    user = rows[0]
    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    return _token_response(user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    req: RefreshRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    try:
        claims = decode_token(req.refresh_token, expected_type="refresh")
    except TokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e)) from e
    user = await session.scalar(select(User).where(User.id == UUID(claims["sub"])))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return _token_response(user)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> UserOut:
    return _user_out(user)
