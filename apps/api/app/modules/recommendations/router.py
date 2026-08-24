"""Endpoints del recomendador.

Este fichero solo traduce HTTP: valida la entrada, saca la identidad del token
y llama al servicio. Ninguna regla de producto vive aqui.

DOS COSAS QUE ATRAVIESAN TODO EL FICHERO:

- La identidad sale SIEMPRE de `current_user.id`. Ningun endpoint acepta un
  `user_id` del cliente: aceptarlo seria dejar leer las recomendaciones —y
  escribir las preferencias— de cualquiera.

- Con la personalizacion apagada (`FEATURE_RECOMMENDATIONS_V1=false`) esto no
  falla: responde vacio y en silencio. Que el interruptor devuelva 503
  convertiria un apagado controlado en una pantalla rota.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.security import AuthUser, get_current_user
from app.modules.content.router import leer_posts_por_id
from app.modules.content.schemas import PostRead
from app.modules.recommendations import cache, metrics, service, temas_de_contenido
from app.modules.recommendations.config import (
    CONTENT_ALGORITHM_VERSION,
    ONBOARDING_VERSION,
    RECOMMENDATION_ALGORITHM_VERSION,
    VENTANA_DE_ATRIBUCION_DIAS,
)
from app.modules.recommendations.models import BehaviorEvent
from app.modules.recommendations.schemas import (
    BehaviorEventBatch,
    BehaviorEventResult,
    ContentRecommendations,
    OnboardingCatalog,
    OnboardingStatus,
    PeopleRecommendations,
    PreferencesInput,
    PreferencesRead,
    ProfileOffer,
    RecommendationMetrics,
    SurfaceFunnel,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import require_admin

router = APIRouter(prefix="/recommendations", tags=["recommendations"])

#: Lo que se responde cuando la personalizacion esta apagada.
ORIGEN_APAGADO = "disabled"


# --------------------------------------------------------------------------- #
# Onboarding
# --------------------------------------------------------------------------- #
@router.get("/onboarding/status", response_model=OnboardingStatus)
async def onboarding_status(
    current_user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> OnboardingStatus:
    """¿Hay que ensenarle el cuestionario a quien pregunta?

    Es la unica pregunta que el arranque de la aplicacion necesita responder, y
    por eso es un endpoint aparte y minusculo: se pide en cada arranque con
    sesion y tiene que costar una lectura por clave primaria.
    """
    if not settings.feature_recommendations_v1:
        return OnboardingStatus(
            completed=False,
            should_show=False,
            onboarding_version=0,
            current_version=ONBOARDING_VERSION,
        )
    return await service.estado_del_onboarding(db, current_user.id)


@router.get("/onboarding/catalog", response_model=OnboardingCatalog)
async def onboarding_catalog(
    _: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> OnboardingCatalog:
    """Las preguntas y sus opciones. Una peticion para las cinco pantallas."""
    return await service.catalogo(db)


@router.get("/preferences", response_model=PreferencesRead)
async def leer_preferencias(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PreferencesRead:
    """Las preferencias PROPIAS. No existe forma de pedir las de otra persona."""
    return await service.leer_preferencias(db, current_user.id)


@router.put("/preferences", response_model=PreferencesRead)
async def guardar_preferencias(
    payload: PreferencesInput,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PreferencesRead:
    """Guarda (o reemplaza) las respuestas de quien hace la peticion.

    PUT y no POST porque es idempotente: mandar dos veces lo mismo deja el
    mismo estado, que es justo lo que hace falta cuando el boton de guardar se
    pulsa dos veces o la red obliga a reintentar.
    """
    return await service.guardar_preferencias(db, current_user.id, payload)


# --------------------------------------------------------------------------- #
# La oferta publica de un perfil
# --------------------------------------------------------------------------- #
@router.get("/profiles/{profile_id}/offer", response_model=ProfileOffer)
async def oferta_de_un_perfil(
    profile_id: str,
    _: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileOffer:
    """Lo que esa persona declara poder aportar. SOLO eso.

    No existe el endpoint simetrico —«que busca esta persona»— y no es un olvido:
    la demanda es privada y no debe poder consultarse de ninguna forma sobre
    otra cuenta. Quien quiera ver la suya, la tiene en `/preferences`.

    Pide sesion aunque la informacion sea publica dentro de Z: el grafo entero
    de quien sabe que no tiene por que ser descargable por cualquiera con la
    direccion del proyecto. Es el mismo criterio que la RLS de la 0026.
    """
    ensure_uuid(profile_id, "Perfil no encontrado.")
    return await service.oferta_publica(db, profile_id)


# --------------------------------------------------------------------------- #
# Personas
# --------------------------------------------------------------------------- #
@router.get("/people", response_model=PeopleRecommendations)
async def personas_para_ti(
    limit: int = Query(default=10, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    include_following: bool = Query(default=False),
    debug: bool = Query(default=False),
    current_user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> PeopleRecommendations:
    """Personas que probablemente puedan aportarle valor a quien pregunta.

    `debug=1` devuelve el desglose numerico del score, y SOLO fuera de
    produccion. Sirve para responder «¿por que salio Carlos primero?» sin
    adivinar; en produccion ese detalle no aporta nada a quien mira la pantalla
    y expone como funciona el orden a quien quisiera manipularlo.
    """
    if not settings.feature_recommendations_v1:
        return PeopleRecommendations(
            algorithm_version=RECOMMENDATION_ALGORITHM_VERSION,
            strategy=ORIGEN_APAGADO,
            items=[],
        )
    items, estrategia = await service.personas_para(
        db,
        current_user.id,
        limite=limit,
        offset=offset,
        incluir_seguidos=include_following,
        debug=debug and not settings.is_production,
    )
    return PeopleRecommendations(
        algorithm_version=RECOMMENDATION_ALGORITHM_VERSION,
        strategy=estrategia,
        items=items,
    )


# --------------------------------------------------------------------------- #
# Contenido
# --------------------------------------------------------------------------- #
@router.get("/content", response_model=ContentRecommendations)
async def contenido_para_ti(
    limit: int = Query(default=6, ge=1, le=30),
    offset: int = Query(default=0, ge=0),
    media: str | None = Query(default=None, pattern="^(image|video)$"),
    current_user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> ContentRecommendations:
    """El "Para ti" ordenado. Los `items` son `PostRead` sin tocar.

    La envoltura existe para que la version del algoritmo la diga el SERVIDOR:
    el movil la devuelve en cada impresion y, si la llevara escrita en su
    codigo, una version antigua de la aplicacion mediria contra una etiqueta
    equivocada. Los elementos siguen siendo `PostRead`, asi que la pantalla usa
    el mismo mapper que el feed cronologico.

    Una lista vacia NO es un error: significa «no hay nada que personalizar».
    El movil sabe leerla y cae a la fuente cronologica de siempre.
    """
    if not settings.feature_recommendations_v1:
        return ContentRecommendations(
            algorithm_version=CONTENT_ALGORITHM_VERSION,
            strategy=ORIGEN_APAGADO,
            items=[],
        )
    ordenado = await service.contenido_para(
        db, current_user.id, limite=limit, offset=offset, media=media
    )
    items = await leer_posts_por_id(db, ordenado.post_ids, current_user.id)
    return ContentRecommendations(
        algorithm_version=CONTENT_ALGORITHM_VERSION,
        strategy=ordenado.estrategia,
        with_own_topics=ordenado.con_tema_propio,
        items=items,
    )


# --------------------------------------------------------------------------- #
# Senales
# --------------------------------------------------------------------------- #
@router.post("/events", response_model=BehaviorEventResult)
async def registrar_eventos(
    payload: BehaviorEventBatch,
    current_user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> BehaviorEventResult:
    """Senales de uso enviadas por el movil, en lote.

    Solo tipos de CLIENTE: los que implican una accion real (seguir, agendar)
    los escribe el servidor cuando ocurren, y el esquema de entrada ni siquiera
    los admite (ver `schemas.EVENTOS_DE_CLIENTE`).

    Las repetidas se descartan sin error. Un lote se reintenta cuando la red
    falla, y responder 409 obligaria al movil a distinguir «ya estaba» de
    «fallo», que para una senal no cambia nada.
    """
    if not settings.feature_recommendations_v1:
        return BehaviorEventResult(accepted=0, duplicated=len(payload.events))

    claves = [e.event_key for e in payload.events if e.event_key]
    ya_registradas: set[str] = set()
    if claves:
        filas = (
            await db.scalars(
                select(BehaviorEvent.event_key).where(
                    BehaviorEvent.user_id == current_user.id,
                    BehaviorEvent.event_key.in_(claves),
                )
            )
        ).all()
        ya_registradas = {c for c in filas if c}

    # Cuando alguien rechaza una publicacion, se guardan tambien SUS TEMAS: sin
    # ellos, «no me interesa» solo podria esconder ese video concreto y nunca
    # aprenderia nada. Se resuelve de UNA consulta para todo el lote.
    rechazados = [
        e.entity_id
        for e in payload.events
        if e.event_type == "not_interested" and e.entity_type == "post" and e.entity_id
    ]
    temas_rechazados = (
        await temas_de_contenido.leer(db, rechazados) if rechazados else {}
    )

    aceptadas = 0
    duplicadas = 0
    vistas_en_el_lote: set[str] = set()
    for evento in payload.events:
        clave = evento.event_key
        if clave and (clave in ya_registradas or clave in vistas_en_el_lote):
            duplicadas += 1
            continue
        if clave:
            vistas_en_el_lote.add(clave)
        db.add(
            BehaviorEvent(
                user_id=current_user.id,
                event_type=evento.event_type,
                entity_type=evento.entity_type,
                entity_id=evento.entity_id,
                value=evento.value,
                dwell_ms=evento.dwell_ms,
                event_key=clave,
                source="client",
                # De donde venia. Es lo que convierte una senal suelta en una
                # linea de un embudo que se puede medir.
                surface=evento.surface,
                algorithm_version=evento.algorithm_version,
                rank=evento.rank,
                # Los temas del contenido rechazado, para que «no me interesa»
                # enfrie el tema y no solo la publicacion concreta.
                topic_ids=temas_rechazados.get(evento.entity_id or "") or None,
            )
        )
        aceptadas += 1

    try:
        await db.commit()
    except IntegrityError:
        # Dos dispositivos mandando el mismo lote a la vez: el indice unico de
        # idempotencia hace su trabajo. No es un fallo que deba ver nadie.
        await db.rollback()
        return BehaviorEventResult(accepted=0, duplicated=len(payload.events))
    if aceptadas:
        # Decir «no me interesa» tiene que quitar a alguien de la lista YA, no
        # dentro de un minuto.
        cache.invalidar(current_user.id)
    return BehaviorEventResult(accepted=aceptadas, duplicated=duplicadas)


@router.get("/version")
async def version() -> dict[str, str | int]:
    """Que version del orden y del cuestionario esta sirviendo el servidor.

    Sirve para saber, al mirar un resultado raro, contra que se estaba
    hablando. Es publico porque no revela nada: son dos etiquetas.
    """
    return {
        "people": RECOMMENDATION_ALGORITHM_VERSION,
        "content": CONTENT_ALGORITHM_VERSION,
        "onboarding": ONBOARDING_VERSION,
    }


# --------------------------------------------------------------------------- #
# Metricas
# --------------------------------------------------------------------------- #
@router.get("/metrics", response_model=RecommendationMetrics)
async def metricas(
    days: int = Query(default=30, ge=1, le=180),
    _: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RecommendationMetrics:
    """¿Las recomendaciones producen algo?

    SOLO ADMINISTRACION. Es informacion agregada del producto, no de una
    persona, pero aun asi no tiene por que verla cualquiera: dice cuanta gente
    hay al otro lado y como se comporta.

    Es un endpoint, no un panel. Un panel es una pantalla que mantener; esto es
    una consulta que se hace cuando hay algo que decidir. Si mas adelante hace
    falta ensenarlo, ya existe de donde leerlo.

    Si todo sale a cero, es que todavia no ha ocurrido nada. Eso es un
    resultado, no un fallo, y no se rellena con nada.
    """
    ahora = datetime.now(timezone.utc)
    desde = ahora - timedelta(days=days)
    embudos = await metrics.embudo(db, desde=desde, ahora=ahora)
    return RecommendationMetrics(
        since=desde,
        attribution_window_days=VENTANA_DE_ATRIBUCION_DIAS,
        funnels=[
            SurfaceFunnel(
                surface=e.surface,
                algorithm_version=e.algorithm_version,
                impressions=e.impressions,
                conversions=e.conversions,
                rates=e.tasas(),
            )
            for e in embudos
        ],
    )
