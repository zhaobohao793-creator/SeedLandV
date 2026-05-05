"""
Auth flow exit verification (post-workshop-delivery refactor).

Walks the new auth flow end to end against a running API:
  1. /healthz
  2. POST /v1/auth/bootstrap (idempotent — accepts 409 if already initialized)
  3. POST /v1/auth/login with employee_id
  4. GET /v1/auth/me
  5. POST /v1/auth/refresh
  6. GET /v1/admin/employees (admin-only)

Usage:
    uvicorn app.main:app &
    python scripts/verify_phase1.py
"""
from __future__ import annotations

import os
import secrets
import sys

import httpx

BASE = os.environ.get("SEEDLANDV_API_URL", "http://localhost:8000")
EMPLOYEE_ID = f"verify-{secrets.token_hex(3)}"
PASSWORD = "verify_password_123"
WORKSHOP = f"verify-{secrets.token_hex(3)}"


def step(label: str, ok: bool, detail: str = "") -> bool:
    marker = "OK  " if ok else "FAIL"
    print(f"[{marker}] {label}{(' — ' + detail) if detail else ''}")
    return ok


def main() -> int:
    all_ok = True
    with httpx.Client(base_url=BASE, timeout=10) as c:
        r = c.get("/healthz")
        all_ok &= step("/healthz", r.status_code == 200, str(r.json()))

        r = c.post(
            "/v1/auth/bootstrap",
            json={
                "workshop_name": WORKSHOP,
                "employee_id": EMPLOYEE_ID,
                "password": PASSWORD,
            },
        )
        # First run returns 201; re-runs return 409 — both leave system usable.
        bootstrapped = r.status_code == 201
        all_ok &= step(
            "bootstrap",
            r.status_code in (201, 409),
            f"status={r.status_code} ({'created' if bootstrapped else 'already initialized'})",
        )
        if not bootstrapped:
            print(
                "  note: cannot continue verification when system is already "
                "initialized — run against a fresh DB or use a known admin login.",
            )
            return 0

        access = r.json()["access_token"]
        refresh = r.json()["refresh_token"]

        r = c.post(
            "/v1/auth/login",
            json={"employee_id": EMPLOYEE_ID, "password": PASSWORD},
        )
        all_ok &= step("login", r.status_code == 200, f"status={r.status_code}")

        r = c.get("/v1/auth/me", headers={"Authorization": f"Bearer {access}"})
        body = r.json()
        all_ok &= step(
            "me",
            r.status_code == 200
            and body["employee_id"] == EMPLOYEE_ID
            and body["is_admin"] is True,
            f"employee_id={body.get('employee_id')} is_admin={body.get('is_admin')}",
        )

        r = c.post("/v1/auth/refresh", json={"refresh_token": refresh})
        all_ok &= step("refresh", r.status_code == 200, f"new exp={r.json().get('expires_in')}")

        r = c.get(
            "/v1/admin/employees",
            headers={"Authorization": f"Bearer {access}"},
        )
        all_ok &= step(
            "admin list employees",
            r.status_code == 200 and len(r.json()) >= 1,
            f"count={len(r.json()) if r.status_code == 200 else 'n/a'}",
        )

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
