from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import ENUM as PG_ENUM
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.enums import TaskStatus

# A single shared enum type per Postgres database. Alembic creates it once.
task_status_enum = PG_ENUM(
    TaskStatus,
    name="task_status",
    values_callable=lambda e: [m.value for m in e],
    create_type=False,
)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    uuid: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        nullable=False,
        unique=True,
        server_default=func.gen_random_uuid(),
    )
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        nullable=False,
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    local_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ark_task_id: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    prompt: Mapped[str] = mapped_column(String, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        task_status_enum, nullable=False, default=TaskStatus.PENDING
    )
    ark_video_url: Mapped[str | None] = mapped_column(String, nullable=True)
    ark_last_frame: Mapped[str | None] = mapped_column(String, nullable=True)
    tos_video_key: Mapped[str | None] = mapped_column(String, nullable=True)
    tos_video_url: Mapped[str | None] = mapped_column(String, nullable=True)
    tos_video_url_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    usage: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    mirror_attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    mirror_last_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    mirror_error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    terminal_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index(
            "ix_tasks_tenant_status_created",
            "tenant_id",
            "status",
            "created_at",
        ),
        Index("ix_tasks_tenant_local_id", "tenant_id", "local_id"),
    )
