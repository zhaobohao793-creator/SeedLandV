"""workshop delivery: employee_id login + task order_id

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-05

Two coupled product changes shipped together:
  1) users.email -> nullable, add employee_id (tenant-scoped unique),
     display_name, is_admin, is_active. Login moves from email to
     employee_id; existing rows get backfilled (email prefix as employee_id,
     promoted to admin so the workshop owner doesn't lose access).
  2) tasks gain order_id (required, indexed by tenant) + order_seq for
     same-order multi-generation. Existing rows backfilled with a
     LEGACY-<uuid8> placeholder so historical data stays queryable.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users -----------------------------------------------------------
    op.add_column("users", sa.Column("employee_id", sa.String(64), nullable=True))
    op.add_column("users", sa.Column("display_name", sa.String(128), nullable=True))
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "users",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )

    # Backfill from email prefix; promote every legacy user to admin so the
    # workshop owner who originally registered keeps full access.
    op.execute(
        """
        UPDATE users
        SET employee_id = split_part(email, '@', 1),
            display_name = split_part(email, '@', 1),
            is_admin = true
        WHERE employee_id IS NULL
        """
    )

    op.alter_column("users", "employee_id", nullable=False)
    op.alter_column("users", "email", nullable=True)
    # Project uses sqlalchemy naming_convention "uq_%(table)s_%(column)s",
    # so the email unique constraint from migration 0001 lives as "uq_users_email".
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.create_unique_constraint(
        "uq_users_tenant_employee_id", "users", ["tenant_id", "employee_id"]
    )

    # --- tasks -----------------------------------------------------------
    op.add_column("tasks", sa.Column("order_id", sa.String(64), nullable=True))
    op.add_column(
        "tasks",
        sa.Column("order_seq", sa.Integer(), nullable=False, server_default="1"),
    )
    op.execute(
        """
        UPDATE tasks
        SET order_id = 'LEGACY-' || substring(uuid::text from 1 for 8)
        WHERE order_id IS NULL
        """
    )
    op.alter_column("tasks", "order_id", nullable=False)
    op.create_index(
        "ix_tasks_tenant_order_id", "tasks", ["tenant_id", "order_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_tenant_order_id", table_name="tasks")
    op.drop_column("tasks", "order_seq")
    op.drop_column("tasks", "order_id")

    op.drop_constraint("uq_users_tenant_employee_id", "users", type_="unique")
    op.create_unique_constraint("uq_users_email", "users", ["email"])
    op.alter_column("users", "email", nullable=False)
    op.drop_column("users", "is_active")
    op.drop_column("users", "is_admin")
    op.drop_column("users", "display_name")
    op.drop_column("users", "employee_id")
