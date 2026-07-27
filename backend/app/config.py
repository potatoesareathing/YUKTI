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

    # --- Natural-language query endpoint (POST /api/ask) ---------------------
    # The model translates a question into a query using the schema catalogue
    # only; it never receives rows. See app/services/nl_schema.py.
    ask_enabled: bool = True
    ask_default_source: str = "local"  # "local" (this backend's DB) | "catalyst"

    # Groq's free tier is the default: benchmarked 7/7 on the question set at
    # ~670 ms, against 5/7 at ~13 s for the best OpenRouter free model.
    # Switch to "ollama" for the fully self-hosted path DATA-AND-MODELS.md
    # mandates — slower to set up, but the question never leaves the machine.
    ask_provider: str = "openai_compatible"  # openai_compatible | ollama | anthropic

    # openai_compatible — any chat-completions endpoint (Groq, OpenRouter, vLLM).
    openai_compatible_base_url: str = "https://api.groq.com/openai/v1"
    openai_compatible_model: str = "llama-3.3-70b-versatile"
    openai_compatible_api_key: str = ""

    # ollama — free, runs on your machine, nothing leaves it.
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5-coder:7b"

    # anthropic — paid; only used when ask_provider is "anthropic".
    anthropic_api_key: str = ""
    ask_effort: str = "medium"  # low | medium | high | xhigh | max

    # --- Zoho Catalyst Data Store as a data source ---------------------------
    # Secrets belong in the environment, never in the repo. Leave blank to
    # disable the Catalyst source; /api/ask?source=local keeps working.
    catalyst_project_id: str = ""
    catalyst_environment_id: str = ""
    catalyst_refresh_token: str = ""
    catalyst_client_id: str = ""
    catalyst_client_secret: str = ""
    catalyst_dc: str = "in"
    catalyst_environment: str = "Development"

    @property
    def catalyst_configured(self) -> bool:
        return all(
            [
                self.catalyst_project_id,
                self.catalyst_environment_id,
                self.catalyst_refresh_token,
                self.catalyst_client_id,
                self.catalyst_client_secret,
            ]
        )

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
