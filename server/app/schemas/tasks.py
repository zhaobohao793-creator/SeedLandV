"""Pydantic schemas mirror the renderer's `SubmitTaskInput` / `TaskRecord`.

Renderer payload conventions (preserved 1:1 for compatibility):
- `localId`: client-generated `local-{ts}-{rand}`; we store + echo it back
- `params.generateAudio` / `returnLastFrame`: camelCase in client, snake_case in Ark
- Asset shape:
    { kind, mode: 'url', url }                  (Phase 2+)
    { kind, mode: 'upload', asset_token }       (Phase 4+)
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import BaseModel, Field

from app.models.enums import AssetKind, GenerationMode, TaskStatus


class GenerationParams(BaseModel):
    model: str
    resolution: str | None = None
    ratio: str | None = None
    duration: int | None = None
    watermark: bool | None = None
    generateAudio: bool | None = Field(default=None)
    returnLastFrame: bool | None = Field(default=None)
    seed: int | None = None


class AssetSourceUrl(BaseModel):
    kind: AssetKind
    mode: Literal["url"]
    url: str


class AssetSourceUpload(BaseModel):
    kind: AssetKind
    mode: Literal["upload"]
    asset_token: str = Field(min_length=1)


AssetSource = Annotated[
    Union[AssetSourceUrl, AssetSourceUpload],
    Field(discriminator="mode"),
]


class SubmitTaskRequest(BaseModel):
    localId: str = Field(min_length=1, max_length=64)
    orderId: str = Field(min_length=1, max_length=64)
    mode: GenerationMode
    prompt: str
    assets: list[AssetSource] = Field(default_factory=list)
    params: GenerationParams


class AssetPreview(BaseModel):
    kind: AssetKind
    label: str


class UsageOut(BaseModel):
    completion_tokens: int | None = None
    total_tokens: int | None = None


class ErrorOut(BaseModel):
    message: str
    raw: str | None = None
    code: str | None = None


class TaskOut(BaseModel):
    """Shape consumed by the renderer (extends TaskRecord with server fields)."""

    server_id: UUID = Field(alias="server_id")
    id: str | None = None  # ark_task_id once known, mirrors renderer `task.id`
    localId: str
    orderId: str
    orderSeq: int
    mode: GenerationMode
    prompt: str
    params: GenerationParams
    assetsPreview: list[AssetPreview]
    status: TaskStatus
    videoUrl: str | None = None
    lastFrameUrl: str | None = None
    error: ErrorOut | None = None
    createdAt: int  # ms epoch, like the renderer's TaskRecord
    updatedAt: int
    usage: UsageOut | None = None

    model_config = {"populate_by_name": True}


class SubmitTaskResponse(BaseModel):
    server_id: UUID
    localId: str
    orderId: str
    orderSeq: int
    status: TaskStatus
