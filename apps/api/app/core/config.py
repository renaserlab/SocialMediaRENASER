"""Configuracion central del backend RENASER.

Todas las variables se leen de entorno (.env en desarrollo). Los secretos
(SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, DATABASE_URL) SOLO viven aqui,
en el backend. Nunca en la app movil ni en git.
"""

from functools import lru_cache
from typing import ClassVar, Literal

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

    # --- Pagos ---
    #: Portal de pagos de los cursos. APAGADO por defecto: el modulo esta
    #: construido pero no hay pasarela elegida, y un cobro que no se completa es
    #: motivo de rechazo en las tiendas. Encenderlo exige haber implementado un
    #: PaymentProvider real (ver modules/payments/providers.py).
    payments_enabled: bool = False

    #: A donde vuelve el usuario despues de pagar. Es una pagina de la WEB, no
    #: de la app: cobrar dentro de la aplicacion obliga a usar las compras
    #: integradas de Apple y Google, con su comision.
    payments_return_url: str = "https://social-media-renaser.vercel.app/pago"

    # --- Procesado de media (derivados) ---
    #: Genera en segundo plano la version ligera de las imagenes nuevas y el
    #: poster de los videos que suban sin el. Necesita la service_role key.
    #: Es barato (Pillow sobre una foto, un fotograma con ffmpeg) y corre tras
    #: responder la peticion, asi que no anade latencia a publicar.
    media_processing_enabled: bool = True

    #: Transcodificar VIDEO en el servidor (720p H.264). Apagado por defecto:
    #: en el plan gratuito de Render (0.1 CPU, 512 MB) un video de un minuto
    #: tardaria decenas de minutos y podria morir al dormirse la instancia.
    #: Para el contenido existente esta scripts/procesar_media.py, que corre
    #: donde si hay CPU. Encenderlo aqui es decision de infraestructura.
    video_transcode_enabled: bool = False

    # --- Recomendaciones ---
    #: Personalizacion (onboarding + "Personas para ti" + "Para ti" ordenado).
    #: ENCENDIDO por defecto, y apagable en caliente desde una variable de
    #: entorno sin desplegar nada.
    #:
    #: Es el plan de vuelta atras de esta fase: apagarlo devuelve la aplicacion
    #: al comportamiento anterior —feed cronologico, sin cuestionario— sin
    #: borrar una sola fila. Las tablas nuevas se quedan donde estan, quietas.
    #: Un rollback que exija borrar informacion de gente real no es un rollback.
    feature_recommendations_v1: bool = True
    #: «Cursos para ti». Interruptor propio y no el de siempre: apagar los
    #: cursos si algo sale mal no puede llevarse por delante las personas y el
    #: feed, que llevan funcionando desde antes. Apagado, Explorar vuelve al
    #: catalogo publico sin borrar una sola fila.
    feature_course_recommendations_v1: bool = True

    # --- CORS ---
    cors_origins: str = "*"

    #: Origenes propios del producto, permitidos en produccion aunque nadie haya
    #: configurado CORS_ORIGINS.
    #:
    #: Cerrar el comodin dejo la API denegando TODAS las peticiones de navegador
    #: y tumbo la web, porque la variable no estaba puesta en el servidor. Que la
    #: seguridad dependa de recordar una variable de entorno es fragil: si se
    #: olvida, el sistema no falla al desplegar sino mas tarde y en otro sitio.
    #: Declarar aqui los dominios conocidos hace que funcione de fabrica, y sigue
    #: siendo seguro porque es una lista concreta, no un comodin.
    #:
    #: CORS_ORIGINS los sustituye cuando se define (dominio propio, previews...).
    DEFAULT_PRODUCTION_ORIGINS: ClassVar[tuple[str, ...]] = (
        "https://social-media-renaser.vercel.app",
    )

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
        Si no se declara nada se usan los dominios propios del producto
        (DEFAULT_PRODUCTION_ORIGINS), de modo que la web funciona sin depender
        de que alguien se acuerde de configurar la variable. Para anadir otros
        —un dominio propio, las vistas previa de Vercel— se declaran en
        CORS_ORIGINS separados por comas, y esa lista sustituye a la de por
        defecto.

        Esto no afecta a la aplicacion movil: CORS es una restriccion que
        aplican los navegadores, no los clientes nativos.
        """
        raw = self.cors_origins.strip()
        if raw == "*":
            # Sin configurar: comodin en local, dominios propios en produccion.
            return list(self.DEFAULT_PRODUCTION_ORIGINS) if self.is_production else ["*"]
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
