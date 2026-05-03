from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / "server" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    database_url: str = Field(alias="DATABASE_URL")
    redis_url: str = Field(alias="REDIS_URL")

    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    jwt_access_ttl_seconds: int = Field(default=3600, alias="JWT_ACCESS_TTL_SECONDS")
    jwt_refresh_ttl_seconds: int = Field(default=604800, alias="JWT_REFRESH_TTL_SECONDS")

    ark_key_fernet_secret: str = Field(default="", alias="ARK_KEY_FERNET_SECRET")
    ark_base_url: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3",
        alias="ARK_BASE_URL",
    )

    volc_tos_ak: str = Field(alias="VOLC_TOS_AK")
    volc_tos_sk: str = Field(alias="VOLC_TOS_SK")
    volc_tos_region: str = Field(default="cn-beijing", alias="VOLC_TOS_REGION")
    volc_tos_endpoint: str = Field(
        default="tos-cn-beijing.volces.com", alias="VOLC_TOS_ENDPOINT"
    )
    volc_tos_bucket: str = Field(alias="VOLC_TOS_BUCKET")

    # Phase 6: per-tenant Ark submit rate limit (fixed window, 1h).
    ark_submit_rate_limit_per_hour: int = Field(
        default=100, alias="ARK_SUBMIT_RATE_LIMIT_PER_HOUR"
    )

    # Phase 6: Sentry — empty DSN disables (no-op init).
    sentry_dsn: str = Field(default="", alias="SENTRY_DSN")
    sentry_env: str = Field(default="dev", alias="SENTRY_ENV")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
