from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg2://yukti:yukti@localhost:5432/yukti"
    redis_url: str = "redis://localhost:6379/0"
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "yuktipassword"
    mlflow_tracking_uri: str = "http://localhost:5001"
    keycloak_issuer: str = "http://localhost:8080/realms/yukti"
    keycloak_audience: str = "yukti-api"
    auth_bypass: bool = True
    # Audit every GET query (expensive). Default off — evidence opens via POST /api/audit.
    audit_reads: bool = False
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,*"
    now_ms: int = 1_753_401_600_000  # 2026-07-25T00:00:00Z
    period_days: int = 180
    incident_sample_cap: int = 4000
    db_pool_size: int = 10
    db_max_overflow: int = 20
    environment: str = "development"
    # CCTNS live-sync
    cctns_api_key: str = "yukti-cctns-dev-key"
    cctns_ip_allowlist: str = ""  # comma-separated; empty = allow all (dev)
    cctns_staging_url: str = ""  # optional external poll URL
    cctns_poll_seconds: int = 60
    mo_match_threshold: float = 0.80

    @property
    def cors_origin_list(self) -> list[str]:
        parts = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        if "*" in parts:
            return ["*"]
        return parts

    @property
    def cors_allow_credentials(self) -> bool:
        # Browsers forbid credentials with Access-Control-Allow-Origin: *
        return "*" not in self.cors_origin_list


@lru_cache
def get_settings() -> Settings:
    return Settings()
