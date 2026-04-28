"""Tenant self-service routes (currently: Ark API key set/clear)."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.ark.client import ArkClient, ArkError
from app.auth.crypto import CryptoError, encrypt_ark_key
from app.auth.deps import get_current_user
from app.db.session import get_session
from app.models import Tenant, User

router = APIRouter(prefix="/v1/tenants/me", tags=["tenants"])


class ArkKeyRequest(BaseModel):
    api_key: str = Field(min_length=10, max_length=512)


def _probe_ark_key(api_key: str) -> tuple[bool, str]:
    """Quick liveness check: hit GET task with a sentinel UUID. We expect
    404 (auth ok, task not found). 401/403 means the key is bad."""
    try:
        client = ArkClient(api_key=api_key, timeout=8.0)
        client.get_task("00000000-0000-0000-0000-000000000000")
        return True, ""  # unlikely path; treat as valid
    except ArkError as e:
        if e.status in (401, 403):
            return False, str(e) or "Ark Key 鉴权失败"
        # 404 / other errors mean auth passed.
        return True, ""
    except Exception as e:
        # Network/timeout — accept; first real submit will surface the issue.
        return True, f"Ark 探测网络异常,已暂时接受: {e}"


@router.put("/ark-key", status_code=status.HTTP_204_NO_CONTENT)
async def set_ark_key(
    req: ArkKeyRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    ok, err = await asyncio.to_thread(_probe_ark_key, req.api_key)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, err or "Ark Key 鉴权失败")

    tenant = await session.get(Tenant, user.tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tenant not found")
    try:
        tenant.ark_api_key_ciphertext = encrypt_ark_key(req.api_key)
    except CryptoError as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e)) from e
    await session.commit()


@router.delete("/ark-key", status_code=status.HTTP_204_NO_CONTENT)
async def clear_ark_key(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    tenant = await session.get(Tenant, user.tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tenant not found")
    tenant.ark_api_key_ciphertext = None
    await session.commit()


@router.get("/ark-key", response_model=dict)
async def has_ark_key(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    tenant = await session.get(Tenant, user.tenant_id)
    return {"hasKey": bool(tenant and tenant.ark_api_key_ciphertext)}
