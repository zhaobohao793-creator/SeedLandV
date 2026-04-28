"""
Phase 1 exit verification.

Walks the auth flow end to end against a running API:
  1. /healthz
  2. POST /v1/auth/register
  3. POST /v1/auth/login
  4. GET /v1/auth/me
  5. POST /v1/auth/refresh

Usage:
    uvicorn app.main:app --reload &
    python scripts/verify_phase1.py
"""
from __future__ import annotations

import os
import secrets
import sys

import httpx

BASE = os.environ.get("SEEDLANDV_API_URL", "http://localhost:8000")
EMAIL = f"phase1-{secrets.token_hex(4)}@example.com"
PASSWORD = "verify_password_123"


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
            "/v1/auth/register",
            json={"email": EMAIL, "password": PASSWORD, "tenant_name": "phase1"},
        )
        all_ok &= step("register", r.status_code == 201, f"status={r.status_code}")
        if r.status_code != 201:
            print(r.text)
            return 1
        access = r.json()["access_token"]
        refresh = r.json()["refresh_token"]

        r = c.post("/v1/auth/login", json={"email": EMAIL, "password": PASSWORD})
        all_ok &= step("login", r.status_code == 200, f"status={r.status_code}")

        r = c.get("/v1/auth/me", headers={"Authorization": f"Bearer {access}"})
        all_ok &= step(
            "me",
            r.status_code == 200 and r.json()["email"] == EMAIL,
            r.json().get("email", ""),
        )

        r = c.post("/v1/auth/refresh", json={"refresh_token": refresh})
        all_ok &= step("refresh", r.status_code == 200, f"new exp={r.json().get('expires_in')}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
