"""Punto de entrada del backend RENASER (monolito modular).

- Estructura por dominios en app/modules/*.
- Identidad validada por JWT de Supabase (app/core/security.py).
- El esquema de datos lo gestionan las migraciones de Supabase; el backend
  NO ejecuta create_all en produccion.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.modules.bookings.router import router as bookings_router
from app.modules.catalog.router import router as catalog_router
from app.modules.communities.router import router as communities_router
from app.modules.content.router import router as content_router
from app.modules.identity.router import router as identity_router
from app.modules.learning.router import router as learning_router
from app.modules.messaging.router import router as messaging_router
from app.modules.moderation.router import router as moderation_router
from app.modules.notifications.router import router as notifications_router
from app.modules.payments.router import router as payments_router
from app.modules.profiles.router import router as profiles_router
from app.modules.recommendations.router import router as recommendations_router
from app.modules.social_graph.router import router as social_graph_router
from app.modules.stories.router import router as stories_router

settings = get_settings()
logger = get_logger("renaser.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    if not settings.auth_configured:
        logger.warning(
            "SUPABASE_JWT_SECRET no configurado: los endpoints protegidos "
            "responderan 401 hasta que se configure."
        )
    if settings.uses_sqlite and not settings.is_production:
        # Conveniencia de desarrollo local sin Supabase: crear tablas ORM.
        # En produccion el esquema viene de supabase/migrations.
        from app.shared.database import create_all_dev

        await create_all_dev()
        logger.info("Modo desarrollo con SQLite: tablas ORM creadas (create_all_dev).")
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        description="API monolitica modular para RENASER Social Media.",
        lifespan=lifespan,
    )

    if settings.is_production:
        logger.info(
            "CORS permitido para: %s", ", ".join(settings.cors_origin_list) or "(ninguno)"
        )
        if not settings.cors_origin_list:
            logger.warning(
                "CORS cerrado a todos los origenes: ninguna web podra llamar a "
                "esta API. La app movil funciona igual (CORS solo afecta a "
                "navegadores). Define CORS_ORIGINS con los dominios permitidos, "
                "separados por comas."
            )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=settings.cors_origin_list != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    @app.get("/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "renaser-social-media-api"}

    prefix = settings.api_v1_prefix
    app.include_router(identity_router, prefix=prefix)
    app.include_router(profiles_router, prefix=prefix)
    app.include_router(social_graph_router, prefix=prefix)
    app.include_router(content_router, prefix=prefix)
    app.include_router(stories_router, prefix=prefix)
    app.include_router(messaging_router, prefix=prefix)
    app.include_router(catalog_router, prefix=prefix)
    app.include_router(communities_router, prefix=prefix)
    app.include_router(learning_router, prefix=prefix)
    app.include_router(notifications_router, prefix=prefix)
    app.include_router(moderation_router, prefix=prefix)
    app.include_router(bookings_router, prefix=prefix)
    app.include_router(recommendations_router, prefix=prefix)
    # Portal de pagos. Se monta siempre para poder probarlo y documentarlo,
    # pero responde 503 mientras `payments_enabled` este en false.
    app.include_router(payments_router, prefix=prefix)

    return app


app = create_app()
