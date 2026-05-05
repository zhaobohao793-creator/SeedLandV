"""
End-to-end smoke test (post-workshop-delivery refactor).

Walks the full happy path against a running stack:
  uvicorn app.main:app + celery worker + Postgres + Redis.

Steps:
  1. Bootstrap a fresh workshop+admin (or login with existing admin if
     SMOKE_EMPLOYEE_ID/SMOKE_PASSWORD are set and the system is already
     initialized).
  2. PUT tenant Ark API key (read from VOLC_ARK_API_KEY env)
  3. POST /v1/tasks with orderId
  4. Poll GET /v1/tasks/{server_id} until terminal
  5. Print final status + videoUrl + orderSeq

Usage:
    cd server && uvicorn app.main:app
    cd server && celery -A app.workers.celery_app:celery_app worker -P solo
    cd server && VOLC_ARK_API_KEY=... python scripts/smoke_e2e.py
"""
from __future__ import annotations

import os
import secrets
import sys
import time

import httpx

API = os.environ.get("SEEDLANDV_API_URL", "http://localhost:8000")
ARK_KEY = os.environ.get("VOLC_ARK_API_KEY")
PROMPT = os.environ.get(
    "SMOKE_PROMPT", "一只橘色小猫在阳光下伸懒腰，慢镜头特写"
)
EXISTING_EMPLOYEE = os.environ.get("SMOKE_EMPLOYEE_ID")
EXISTING_PASSWORD = os.environ.get("SMOKE_PASSWORD")


def _login_or_bootstrap(c: httpx.Client) -> str:
    employee_id = f"smoke-{secrets.token_hex(3)}"
    password = "smoke_password_123"
    r = c.post(
        "/v1/auth/bootstrap",
        json={
            "workshop_name": f"smoke-{secrets.token_hex(3)}",
            "employee_id": employee_id,
            "password": password,
        },
    )
    if r.status_code == 201:
        print(f"[OK ] bootstrapped fresh workshop ({employee_id})")
        return r.json()["access_token"]
    if r.status_code == 409:
        if not (EXISTING_EMPLOYEE and EXISTING_PASSWORD):
            print(
                "[FAIL] system already initialized; set SMOKE_EMPLOYEE_ID + "
                "SMOKE_PASSWORD to login as an existing admin",
                file=sys.stderr,
            )
            raise SystemExit(2)
        r = c.post(
            "/v1/auth/login",
            json={"employee_id": EXISTING_EMPLOYEE, "password": EXISTING_PASSWORD},
        )
        r.raise_for_status()
        print(f"[OK ] logged in as existing admin ({EXISTING_EMPLOYEE})")
        return r.json()["access_token"]
    r.raise_for_status()
    raise AssertionError("unreachable")


def main() -> int:
    if not ARK_KEY:
        print("[FAIL] set VOLC_ARK_API_KEY before running this smoke test")
        return 2

    with httpx.Client(base_url=API, timeout=30) as c:
        access = _login_or_bootstrap(c)
        h = {"Authorization": f"Bearer {access}"}

        r = c.put("/v1/tenants/me/ark-key", headers=h, json={"api_key": ARK_KEY})
        r.raise_for_status()
        print("[OK ] tenant Ark key encrypted + stored")

        local_id = f"local-{int(time.time() * 1000)}-smoke"
        order_id = f"SMOKE-{secrets.token_hex(3)}"
        r = c.post(
            "/v1/tasks",
            headers=h,
            json={
                "localId": local_id,
                "orderId": order_id,
                "mode": "text-to-video",
                "prompt": PROMPT,
                "assets": [],
                "params": {
                    "model": "doubao-seedance-2-0-fast-260128",
                    "resolution": "480p",
                    "ratio": "16:9",
                    "duration": 3,
                    "watermark": False,
                    "generateAudio": False,
                    "returnLastFrame": False,
                },
            },
        )
        r.raise_for_status()
        body = r.json()
        server_id = body["server_id"]
        print(
            f"[OK ] task enqueued server_id={server_id} "
            f"orderId={body['orderId']} orderSeq={body['orderSeq']}"
        )

        deadline = time.monotonic() + 15 * 60
        while time.monotonic() < deadline:
            r = c.get(f"/v1/tasks/{server_id}", headers=h)
            r.raise_for_status()
            t = r.json()
            print(f"     status={t['status']} videoUrl={t.get('videoUrl')}")
            if t["status"] in {"completed", "succeeded", "failed", "cancelled", "expired"}:
                if t["status"] in {"completed", "succeeded"}:
                    print("[OK ] terminal: success")
                    return 0
                print(f"[FAIL] terminal: {t['status']} error={t.get('error')}")
                return 1
            time.sleep(5)

        print("[FAIL] smoke test timed out after 15min")
        return 1


if __name__ == "__main__":
    sys.exit(main())
