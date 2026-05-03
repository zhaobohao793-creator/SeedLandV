"""Idempotent Sentry init for both FastAPI and Celery entrypoints.

No-op when `SENTRY_DSN` is empty (the dev/test default), so importing this is
free in tests. Tracing/profiling kept off until we have real load — Phase 6
just wants exception capture and breadcrumbs.
"""
from __future__ import annotations

import logging
from typing import Literal

from app.config import Settings

logger = logging.getLogger(__name__)

_initialised = False


def init_sentry(
    settings: Settings, *, integration: Literal["fastapi", "celery"]
) -> None:
    global _initialised
    if _initialised:
        return
    if not settings.sentry_dsn:
        logger.debug("sentry: SENTRY_DSN empty, init skipped")
        _initialised = True
        return

    import sentry_sdk
    from sentry_sdk.integrations.celery import CeleryIntegration
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    if integration == "fastapi":
        integrations = [StarletteIntegration(), FastApiIntegration()]
    else:
        integrations = [CeleryIntegration()]

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_env,
        integrations=integrations,
        traces_sample_rate=0.0,
        profiles_sample_rate=0.0,
        send_default_pii=False,
        attach_stacktrace=True,
    )
    _initialised = True
    logger.info(
        "sentry: initialised env=%s integration=%s", settings.sentry_env, integration
    )
