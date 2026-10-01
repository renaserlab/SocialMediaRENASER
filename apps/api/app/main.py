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
from app.modules.content.reposts import router as reposts_router
from app.modules.content.router_etiquetas import router as etiquetas_router
from app.modules.commerce.router import admin_router as commerce_admin_router
from app.modules.gobernanza.router import admin_router as gobernanza_admin_router
from app.modules.gobernanza.router import router as gobernanza_router
from app.modules.commerce.router import router as commerce_router
from app.modules.identity.router import router as identity_router
from app.modules.events.router import admin_router as events_admin_router
from app.modules.events.order_router import admin_router as orders_admin_router
from app.modules.events.order_router import router as orders_router
from app.modules.events.finanzas_router import admin_router as finanzas_admin_router
from app.modules.events.finanzas_router import router as finanzas_router
from app.modules.events.politicas_router import admin_router as politicas_admin_router
from app.modules.events.politicas_router import router as politicas_router
from app.modules.events.resenas_router import admin_router as resenas_admin_router
from app.modules.events.resenas_router import router as resenas_router
from app.modules.events.posventa_router import admin_router as posventa_admin_router
from app.modules.events.posventa_router import router as posventa_router
from app.modules.events.ticket_router import admin_router as tickets_admin_router
from app.modules.events.ticket_router import router as tickets_router
from app.modules.events.router import router as events_router
from app.modules.products.router import admin_router as products_admin_router
from app.modules.products.router import router as products_router
from app.modules.services.agenda_router import router as services_schedule_router
from app.modules.services.atencion_router import admin_router as services_attention_admin_router
from app.modules.services.atencion_router import router as services_attention_router
from app.modules.services.catalogo_router import admin_router as services_catalog_admin_router
from app.modules.services.catalogo_router import router as services_catalog_router
from app.modules.services.descubrimiento_router import router as services_discovery_router
from app.modules.services.reserva_router import admin_router as services_booking_admin_router
from app.modules.services.reserva_router import router as services_booking_router
from app.modules.services.router import admin_router as services_admin_router
from app.modules.services.router import router as services_router
from app.modules.learning.router import router as learning_router
from app.modules.live.router import router as live_router
from app.modules.messaging.router import router as messaging_router
from app.modules.moderation.router import router as moderation_router
from app.modules.notifications.router import admin_router as notifications_admin_router
from app.modules.notifications.router import router as notifications_router
from app.modules.payments.router import router as payments_router
from app.modules.plataforma.router import router as plataforma_router
from app.modules.refunds.router import admin_router as refunds_admin_router
from app.modules.refunds.router import router as refunds_router
from app.modules.profiles.router import router as profiles_router
from app.modules.recommendations.router import router as recommendations_router
from app.modules.reviews.router import router as reviews_router
from app.modules.search.router import router as search_router
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

    # El proveedor de directo se registra AL ARRANCAR, no en cada peticion:
    # firmar tokens es barato pero construir el cliente en caliente escondia
    # los fallos de configuracion hasta que alguien intentaba emitir.
    from app.modules.live import providers as proveedores_de_directo

    elegido = proveedores_de_directo.registrar_desde_configuracion()
    logger.info("Proveedor de directo: %s", elegido)
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

    # EL IDENTIFICADOR DE LA PETICION. Lo genera aqui si no viene de fuera, lo
    # deja en un `ContextVar` para que lo lean la auditoria y el registro sin
    # pasarlo por veinte firmas, y lo devuelve en la respuesta para que quien
    # reporta un fallo pueda decir cual fue el suyo.
    @app.middleware("http")
    async def _con_identificador(request, call_next):  # noqa: ANN001, ANN202
        from app.modules.gobernanza.contexto import (
            fijar_request_id,
            identificador_admisible,
            nuevo_request_id,
        )

        entrante = (request.headers.get("x-request-id") or "").strip()
        # SE VALIDA CON UNA LISTA BLANCA, NO SE RECORTA. Recortar a 64 dejaba
        # pasar el contenido entero: esta cabecera la manda cualquiera y acaba
        # en una columna de auditoria, en cada linea de registro y —lo peor— de
        # vuelta en una cabecera de respuesta. Un valor con caracteres de
        # control ensucia el registro de forma que ya no se puede leer con
        # confianza, y uno fuera de latin-1 revienta al escribir la respuesta.
        # Lo que no encaje se descarta entero y se genera uno propio.
        identificador = identificador_admisible(entrante) or nuevo_request_id()
        testigo = fijar_request_id(identificador)
        try:
            respuesta = await call_next(request)
        finally:
            from app.modules.gobernanza.contexto import _peticion

            _peticion.reset(testigo)
        respuesta.headers["X-Request-Id"] = identificador
        return respuesta

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
    app.include_router(plataforma_router, prefix=prefix)
    app.include_router(profiles_router, prefix=prefix)
    app.include_router(social_graph_router, prefix=prefix)
    app.include_router(content_router, prefix=prefix)
    # Etiquetas sociales y candidatos a mencion. Es el MISMO modulo que
    # `content_router`, en otro fichero para que el trabajo sobre el feed y el
    # trabajo sobre las etiquetas no choquen en las mismas novecientas lineas.
    # Se monta siempre: sin las migraciones 0031/0032 responde vacio, que es la
    # verdad, en vez de reventar.
    app.include_router(etiquetas_router, prefix=prefix)
    # Republicar. Mismo modulo de contenido, fichero aparte por lo mismo que
    # las etiquetas. Se monta siempre: sin la migracion 0042 las listas salen
    # vacias y republicar avisa de que no esta disponible.
    app.include_router(reposts_router, prefix=prefix)
    app.include_router(stories_router, prefix=prefix)
    app.include_router(messaging_router, prefix=prefix)
    app.include_router(catalog_router, prefix=prefix)
    # El dominio de Eventos. La lectura publica sigue en `catalog`.
    #
    # LAS ENTRADAS VAN ANTES. `/events/ticket-holds/{id}` y
    # `/events/{event_id}/ticket-types` tienen los dos tres tramos y FastAPI
    # resuelve por orden de registro: declarado despues, un identificador de
    # reserva podria intentar casar con la ruta de tipos.
    # Y LOS PEDIDOS ANTES QUE LAS ENTRADAS: `/events/ticket-holds/{id}/orders`
    # tiene cuatro tramos y `/events/ticket-holds/{id}` tres, pero
    # `/events/orders/{id}` y `/events/{event_id}/ticket-types` vuelven a
    # colisionar en tres. Mismo criterio: lo mas concreto, primero.
    # La posventa PRIMERO: `/events/aftersale-cases/{id}` y
    # `/events/{event_id}/...` vuelven a colisionar, y Starlette resuelve
    # por orden de registro. Lo mas concreto, primero.
    app.include_router(posventa_router, prefix=prefix)
    app.include_router(posventa_admin_router, prefix=prefix)
    app.include_router(orders_router, prefix=prefix)
    app.include_router(resenas_router, prefix=prefix)
    app.include_router(resenas_admin_router, prefix=prefix)
    app.include_router(politicas_router, prefix=prefix)
    app.include_router(politicas_admin_router, prefix=prefix)
    app.include_router(finanzas_router, prefix=prefix)
    app.include_router(finanzas_admin_router, prefix=prefix)
    app.include_router(orders_admin_router, prefix=prefix)
    app.include_router(tickets_router, prefix=prefix)
    app.include_router(tickets_admin_router, prefix=prefix)
    app.include_router(events_router, prefix=prefix)
    # PRODUCTOS. El de administracion primero: `/admin/products` no choca con
    # `/products/{id}`, pero declararlo antes deja el orden igual que en el
    # resto del fichero y no hay que pensarlo dos veces.
    app.include_router(products_admin_router, prefix=prefix)
    app.include_router(products_router, prefix=prefix)
    # SERVICIOS. Se monta siempre, pero con `FEATURE_SERVICES` apagada (lo de
    # fabrica) cada ruta contesta 503 `services_disabled` sin tocar la base.
    app.include_router(services_admin_router, prefix=prefix)
    app.include_router(services_router, prefix=prefix)
    # El catálogo (Incremento 2). Sus rutas no chocan con las de la admisión:
    # `/services/provider/services`, `/services/categories`,
    # `/services/catalog/{id}` y `/admin/services/{catalog,categories}`.
    app.include_router(services_catalog_admin_router, prefix=prefix)
    app.include_router(services_catalog_router, prefix=prefix)
    # El descubrimiento (Incremento 3): `/services/catalog` (sin id), las
    # categorías públicas, las sugerencias, `/services/providers/{id}` y los
    # guardados. No choca con nada de lo anterior.
    app.include_router(services_discovery_router, prefix=prefix)
    # La agenda (Incremento 4): `/services/provider/services/{id}/schedule…`
    # y `/services/catalog/{id}/availability…`. Tampoco choca.
    app.include_router(services_schedule_router, prefix=prefix)
    # La reserva (Incremento 5): `/services/catalog/{id}/holds`,
    # `/services/holds/…`, `/services/me/bookings…`, `/services/provider/bookings…`
    # y `/admin/services/{holds,bookings}`. Tampoco choca. Además de
    # `FEATURE_SERVICES`, `FEATURE_SERVICE_BOOKING` (apagada).
    app.include_router(services_booking_router, prefix=prefix)
    app.include_router(services_booking_admin_router, prefix=prefix)
    # La atención y la posventa (Incremento 6): lo que cuelga de una reserva
    # (`/services/{me,provider}/bookings/{b}/…`), `/services/catalog/{id}/reviews`
    # y `/admin/services/{incidents,reviews,tasks}`. Tampoco choca. Además de
    # las puertas de la reserva exige la 0094.
    app.include_router(services_attention_router, prefix=prefix)
    app.include_router(services_attention_admin_router, prefix=prefix)
    app.include_router(events_admin_router, prefix=prefix)
    app.include_router(communities_router, prefix=prefix)
    app.include_router(learning_router, prefix=prefix)
    app.include_router(live_router, prefix=prefix)
    app.include_router(notifications_router, prefix=prefix)
    app.include_router(notifications_admin_router, prefix=prefix)
    app.include_router(moderation_router, prefix=prefix)
    app.include_router(bookings_router, prefix=prefix)
    # Resenas entre personas. Se monta siempre: sin la migracion 0030 los
    # listados responden vacio y las escrituras 503, en vez de reventar.
    app.include_router(reviews_router, prefix=prefix)
    app.include_router(recommendations_router, prefix=prefix)
    # Busqueda global. Se monta siempre y NO depende del recomendador: comparte
    # su tabla de temas, no su servicio. Sin la 0040 funciona igual, mas lento.
    app.include_router(search_router, prefix=prefix)
    # Portal de pagos. Se monta siempre para poder probarlo y documentarlo,
    # pero responde 503 mientras `payments_enabled` este en false.
    app.include_router(payments_router, prefix=prefix)
    app.include_router(refunds_router, prefix=prefix)
    app.include_router(refunds_admin_router, prefix=prefix)
    # La vista comercial del propietario. Sin la 0049 responde ceros.
    app.include_router(commerce_router, prefix=prefix)
    app.include_router(commerce_admin_router, prefix=prefix)
    # Politicas versionadas, consentimientos y auditoria (0050). Se monta
    # siempre: sin la migracion responde vacio o 404, que es la verdad, en vez
    # de reventar.
    app.include_router(gobernanza_router, prefix=prefix)
    app.include_router(gobernanza_admin_router, prefix=prefix)

    return app


app = create_app()
