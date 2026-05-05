"""Bootstrap or add an admin account for a delivered SeedLandV instance.

Usage:
    # First-run bootstrap — creates the workshop tenant + first admin.
    python -m scripts.create_initial_admin \\
        --workshop "Studio A" --employee-id A001 --password 'CHANGE_ME!'

    # Add another admin to an already-initialized workshop (matched by name
    # or, if there's only one tenant, picked automatically).
    python -m scripts.create_initial_admin \\
        --employee-id A002 --password 'CHANGE_ME!' --display-name 'Lao Wang'

Run from the server/ directory so `app.*` imports resolve.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import hash_password
from app.db.session import SessionLocal
from app.models import Tenant, User


async def _resolve_tenant(
    session: AsyncSession, workshop_name: str | None
) -> Tenant:
    if workshop_name:
        existing = await session.scalar(
            select(Tenant).where(Tenant.name == workshop_name)
        )
        if existing is not None:
            return existing
        tenant = Tenant(name=workshop_name)
        session.add(tenant)
        await session.flush()
        return tenant

    tenants = (await session.scalars(select(Tenant))).all()
    if len(tenants) == 1:
        return tenants[0]
    if not tenants:
        raise SystemExit(
            "no tenant exists; pass --workshop to create the first one"
        )
    raise SystemExit(
        "multiple tenants exist; pass --workshop to pick which one"
    )


async def main(args: argparse.Namespace) -> int:
    async with SessionLocal() as session:
        tenant = await _resolve_tenant(session, args.workshop)

        user = User(
            tenant_id=tenant.id,
            employee_id=args.employee_id,
            display_name=args.display_name or args.employee_id,
            email=args.email,
            password_hash=hash_password(args.password),
            is_admin=True,
            is_active=True,
        )
        session.add(user)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            print(
                f"error: employee_id '{args.employee_id}' already exists in "
                f"tenant '{tenant.name}'",
                file=sys.stderr,
            )
            return 1

        print(
            f"created admin: tenant='{tenant.name}' "
            f"employee_id='{args.employee_id}'"
        )
        return 0


def parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Create an admin account.")
    p.add_argument("--workshop", help="Workshop/tenant name (creates if absent)")
    p.add_argument("--employee-id", required=True, help="Login ID for the admin")
    p.add_argument("--password", required=True, help="Initial password (min 8 chars)")
    p.add_argument("--display-name", help="Human-readable name (defaults to employee-id)")
    p.add_argument("--email", help="Optional contact email")
    return p.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(parse())))
