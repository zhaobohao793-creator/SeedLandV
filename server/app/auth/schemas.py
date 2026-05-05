from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class BootstrapRequest(BaseModel):
    """Bootstrap-only endpoint payload: creates the very first tenant + admin
    when the database is empty. After delivery, swap to admin-managed creation."""

    workshop_name: str = Field(min_length=1, max_length=255)
    employee_id: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=128)


class LoginRequest(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(BaseModel):
    id: UUID
    tenant_id: UUID
    employee_id: str
    display_name: str | None = None
    email: EmailStr | None = None
    is_admin: bool
    is_active: bool


class CreateEmployeeRequest(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=128)
    email: EmailStr | None = None
    is_admin: bool = False


class UpdateEmployeeRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    is_admin: bool | None = None
    is_active: bool | None = None
