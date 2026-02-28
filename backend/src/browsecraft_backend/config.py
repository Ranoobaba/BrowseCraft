from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    browser_use_api_key: str | None = None
    github_token: str | None = None
    curseforge_api_key: str | None = None

    browser_use_primary_llm: str = "browser-use-llm"
    browser_use_fallback_llm: str = "browser-use-2.0"
    browser_use_task_timeout_seconds: int = 300

    max_plan_blocks: int = 8000
    app_host: str = "127.0.0.1"
    app_port: int = 8080

    laminar_api_key: str | None = None
    convex_url: str | None = None
    convex_access_key: str | None = None
    google_api_key: str | None = None
    anthropic_api_key: str | None = None
    supermemory_api_key: str | None = None

    allowed_download_exts: tuple[str, ...] = (".schem", ".litematic", ".schematic")


@lru_cache
def get_settings() -> Settings:
    return Settings()
