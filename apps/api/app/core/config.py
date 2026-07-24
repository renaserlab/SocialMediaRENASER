"""Configuracion central del backend RENASER.

Todas las variables se leen de entorno (.env en desarrollo). Los secretos
(SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, DATABASE_URL) SOLO viven aqui,
en el backend. Nunca en la app movil ni en git.
"""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "staging", "production"]


class Settings(BaseSettings):
    # --- App ---
    app_name: str = "RENASER Social Media API"
    environment: Environment = "development"
    api_v1_prefix: str = "/api/v1"

    # --- Base de datos (Supabase PostgreSQL = unica fuente de verdad) ---
    # Ej: postgresql+asyncpg://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres
    # En desarrollo sin Supabase, arranca con SQLite para poder levantar la app.
    database_url: str = "sqlite+aiosqlite:///./renaser_dev.db"

    # --- Supabase ---
    supabase_url: str = ""
    supabase_anon_key: str = ""
    # Secreto: solo backend. Da acceso saltandose RLS.
    supabase_service_role_key: str = ""

    # --- Validacion de JWT emitido por Supabase Auth ---
    # HS256 usa el "JWT secret" del proyecto (Settings > API > JWT Settings).
    # Nota: NO es la service_role key ni la anon key.
    supabase_jwt_secret: str = ""
    supabase_jwt_algorithm: str = "HS256"
    supabase_jwt_audience: str = "authenticated"
    # Opcional para verificar el emisor: https://<ref>.supabase.co/auth/v1
    supabase_jwt_issuer: str = ""

    # --- CORS ---
    cors_origins: str = "*"

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def uses_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def cors_origin_list(self) -> list[str]:
        """Origenes de navegador autorizados a llamar a esta API.

        En produccion el comodin NO se acepta: dejaria que cualquier web
        llamara a la API desde el navegador de alguien con la sesion abierta.
        Si no se han configurado origenes se deniegan todos, que es la opcion
        segura por defecto; para habilitar la version web hay que declarar el
        dominio en CORS_ORIGINS.

        Esto no afecta a la aplicacion movil: CORS es una restriccion que
        aplican los navegadores, no los clientes nativos.
        """
        raw = self.cors_origins.strip()
        if raw == "*":
            return [] if self.is_production else ["*"]
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        # El comodin tambien puede venir mezclado con dominios reales
        # ("*, https://..."), y ahi seguiria abriendo la API entera.
        if self.is_production:
            origins = [o for o in origins if o != "*"]
        return origins

    @property
    def auth_configured(self) -> bool:
        """True cuando hay como validar tokens de Supabase (JWKS o HS256)."""
        return bool(self.supabase_url or self.supabase_jwt_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
