import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.auth.admin_routes import router as admin_router
from app.auth.routes import router as auth_router
from app.config import get_settings
from app.observability.sentry import init_sentry
from app.routes.assets import router as assets_router
from app.routes.tasks import router as tasks_router
from app.routes.tenants import router as tenants_router
from app.routes.ws import router as ws_router

init_sentry(get_settings(), integration="fastapi")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="SeedLandV API",
    version="0.1.0",
    description="批量视频生成订单服务（Seedance 2.0 via 火山方舟 Ark）",
    lifespan=lifespan,
)

# Electron 渲染进程通过 main process 代理调本地 API；CORS 仅为开发期 Web 客户端预留。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(tenants_router)
app.include_router(assets_router)
app.include_router(tasks_router)
app.include_router(ws_router)


@app.get("/healthz", tags=["meta"])
async def healthz() -> dict[str, str]:
    """Cheap liveness probe — does not touch external deps."""
    return {"status": "ok"}


async def _check_db() -> tuple[bool, str | None]:
    from app.db.session import engine

    try:
        async with engine.connect() as c:
            await c.execute(text("SELECT 1"))
        return True, None
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


async def _check_redis() -> tuple[bool, str | None]:
    from app.realtime.publisher import _client as _pub_client

    try:
        await asyncio.to_thread(lambda: _pub_client().ping())
        return True, None
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


async def _check_tos() -> tuple[bool, str | None]:
    from app.storage.tos import get_tos_client

    try:
        c = get_tos_client()
        await asyncio.to_thread(lambda: c._client.head_bucket(c.bucket))
        return True, None
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


@app.get("/readyz", tags=["meta"])
async def readyz() -> JSONResponse:
    """Deep readiness — pings DB / Redis / TOS in parallel and returns 503 if
    any dep is unhealthy. Use for k8s readinessProbe; do NOT use for liveness."""
    db_ok, redis_ok, tos_ok = await asyncio.gather(
        _check_db(), _check_redis(), _check_tos()
    )
    body = {
        "db": {"ok": db_ok[0], "error": db_ok[1]},
        "redis": {"ok": redis_ok[0], "error": redis_ok[1]},
        "tos": {"ok": tos_ok[0], "error": tos_ok[1]},
    }
    overall = db_ok[0] and redis_ok[0] and tos_ok[0]
    body["status"] = "ok" if overall else "degraded"
    return JSONResponse(content=body, status_code=200 if overall else 503)
