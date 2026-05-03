"""phase 5: video mirror bookkeeping columns

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-03
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "tos_video_url_expires_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "mirror_attempt",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "mirror_last_attempt_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "mirror_error", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )

    # Sweeper hot path: rows that succeeded but have not been mirrored yet.
    op.execute(
        """
        CREATE INDEX ix_tasks_mirror_pending
            ON tasks (mirror_last_attempt_at)
            WHERE status = 'succeeded' AND tos_video_key IS NULL
        """
    )
    # URL refresher hot path.
    op.execute(
        """
        CREATE INDEX ix_tasks_url_refresh
            ON tasks (tos_video_url_expires_at)
            WHERE tos_video_key IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_tasks_url_refresh")
    op.execute("DROP INDEX IF EXISTS ix_tasks_mirror_pending")
    op.drop_column("tasks", "mirror_error")
    op.drop_column("tasks", "mirror_last_attempt_at")
    op.drop_column("tasks", "mirror_attempt")
    op.drop_column("tasks", "tos_video_url_expires_at")
