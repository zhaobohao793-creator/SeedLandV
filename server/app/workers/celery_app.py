from celery import Celery
from celery.schedules import crontab

from app.config import get_settings
from app.observability.sentry import init_sentry


def _make_celery() -> Celery:
    s = get_settings()
    init_sentry(s, integration="celery")
    app = Celery(
        "seedlandv",
        broker=s.redis_url,
        backend=s.redis_url,
        include=["app.workers.tasks"],
    )
    app.conf.update(
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_track_started=True,
        worker_prefetch_multiplier=1,
        broker_connection_retry_on_startup=True,
        # Phase 6 will add per-tenant rate limits via Redis token bucket.
        timezone="UTC",
    )
    # Beat schedule (Phase 5). Runs only when celery is started with `-B` or a
    # separate `celery beat` process is up.
    app.conf.beat_schedule = {
        "mirror-retry-sweep": {
            "task": "tos.mirror_retry_sweep",
            "schedule": 3600.0,
            "options": {"expires": 3000},
        },
        "signed-url-refresh": {
            "task": "tos.signed_url_refresh",
            "schedule": crontab(hour=2, minute=0),
            "options": {"expires": 3600},
        },
    }
    return app


celery_app: Celery = _make_celery()
