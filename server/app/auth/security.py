from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings

_pwd = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd.verify(plain, hashed)


def _encode(claims: dict[str, Any], ttl_seconds: int) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        **claims,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def encode_access_token(
    user_id: UUID,
    tenant_id: UUID,
    employee_id: str,
    is_admin: bool,
) -> str:
    s = get_settings()
    return _encode(
        {
            "sub": str(user_id),
            "tid": str(tenant_id),
            "eid": employee_id,
            "adm": bool(is_admin),
            "typ": "access",
        },
        s.jwt_access_ttl_seconds,
    )


def encode_refresh_token(user_id: UUID) -> str:
    s = get_settings()
    return _encode(
        {"sub": str(user_id), "typ": "refresh"},
        s.jwt_refresh_ttl_seconds,
    )


class TokenError(Exception):
    pass


def decode_token(token: str, expected_type: Literal["access", "refresh"]) -> dict[str, Any]:
    s = get_settings()
    try:
        claims = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
    except JWTError as e:
        raise TokenError(f"invalid token: {e}") from e
    if claims.get("typ") != expected_type:
        raise TokenError(f"wrong token type: expected {expected_type}, got {claims.get('typ')}")
    return claims
