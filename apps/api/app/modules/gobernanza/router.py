"""Endpoints de políticas, consentimientos y auditoría.

QUIÉN PUEDE QUÉ, en una tabla:

    cualquiera        leer la política vigente (es un texto público)
    quien la firmó    ver SUS aceptaciones, sin contexto de origen
    tesorería         leer la auditoría
    nadie             escribir aquí desde el cliente

LA AUDITORÍA NO ES PARA MODERACIÓN. Se protege con `puede_mover_dinero`
—`FINANCE_ROLES`, hoy solo `admin`— y no con `is_admin`, que incluye
`moderator`: quien oculta una publicación no tiene por qué ver quién lanzó una
transferencia ni sobre qué orden.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.gobernanza import auditoria, esquema, politicas
from app.modules.gobernanza.contexto import leer_origen
from app.modules.gobernanza.models import AuditEvent, ConsentRecord
from app.modules.gobernanza.schemas import (
    ConsentimientoPropio,
    EventoDeAuditoria,
    PoliticaVigente,
)
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import puede_mover_dinero

router = APIRouter(prefix="/policies", tags=["politicas"])
admin_router = APIRouter(prefix="/admin", tags=["auditoria"])


@router.get("/{policy_type}", response_model=PoliticaVigente)
async def politica_vigente(
    policy_type: str,
    jurisdiction: str = Query(default="PE"),
    locale: str = Query(default="es"),
    db: AsyncSession = Depends(get_db),
) -> PoliticaVigente:
    """El texto que rige ahora mismo para ese tipo.

    NO PIDE SESIÓN: un texto legal publicado es público por definición, y quien
    va a comprar tiene derecho a leerlo antes de identificarse.

    EL CLIENTE PIDE EL TIPO, NUNCA LA VERSIÓN. Si eligiera la versión, elegiría
    la que más le conviene, y una aceptación firmada contra un texto escogido
    por quien firma no demuestra nada.

    404 y no una respuesta vacía cuando no hay ninguna vigente: «no hay
    política» es una situación que quien llama tiene que tratar, no un hueco que
    se rellena solo. Hoy pasa con `terms`, que no tiene texto aprobado.
    """
    politica = await politicas.vigente(
        db, policy_type=policy_type, jurisdiction=jurisdiction, locale=locale
    )
    if politica is None:
        raise NotFoundError(
            "No hay una política vigente para eso todavía.",
            code="policy_not_available",
        )
    return PoliticaVigente.model_validate(politica)


@router.get("/me/consents", response_model=list[ConsentimientoPropio])
async def mis_consentimientos(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConsentimientoPropio]:
    """Lo que esta persona ha aceptado. Solo lo suyo.

    El filtro por `subject_id` NO es una comodidad: es el permiso. Y el esquema
    de salida deja fuera el contexto de origen incluso para quien lo firmó —ver
    `schemas.py`—.

    Lista vacía, no un error, si la 0050 no está aplicada: la pantalla de
    compras se tiene que poder pintar igual.
    """
    if not await esquema.hay_gobernanza(db):
        return []
    filas = await db.scalars(
        select(ConsentRecord)
        .where(ConsentRecord.subject_id == current_user.id)
        .order_by(ConsentRecord.accepted_at.desc())
        .offset(page.offset)
        .limit(page.limit)
    )
    return [ConsentimientoPropio.model_validate(f) for f in filas]


@admin_router.get("/audit-events", response_model=list[EventoDeAuditoria])
async def eventos_de_auditoria(
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    action: str | None = Query(default=None),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EventoDeAuditoria]:
    """El rastro de las operaciones sensibles. Solo tesorería.

    Los filtros se aplican EN SQL, antes de paginar: filtrar después de paginar
    devuelve una página incompleta que parece completa.
    """
    if not await puede_mover_dinero(db, current_user.id):
        raise ForbiddenError("No puedes consultar la auditoría.")
    if not await esquema.hay_gobernanza(db):
        return []

    consulta = select(AuditEvent)
    if entity_type:
        consulta = consulta.where(AuditEvent.entity_type == entity_type)
    if entity_id:
        consulta = consulta.where(AuditEvent.entity_id == entity_id)
    if action:
        consulta = consulta.where(AuditEvent.action == action)

    filas = await db.scalars(
        consulta.order_by(AuditEvent.occurred_at.desc())
        .offset(page.offset)
        .limit(page.limit)
    )
    return [EventoDeAuditoria.model_validate(f) for f in filas]


@admin_router.post("/policies/seed-refund-repurchase", response_model=PoliticaVigente)
async def sembrar_politica_de_recompra(
    request: Request,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaVigente:
    """Mete en la base la política de recompra que hoy vive en el código.

    SE DISPARA UNA VEZ, DESPUÉS DE APLICAR LA 0050, y es idempotente: llamarlo
    dos veces devuelve la misma fila.

    POR QUÉ NO SE SIEMBRA EN LA PROPIA MIGRACIÓN NI AL ARRANCAR. El texto vive
    en `refunds/politica.py`, así que la migración tendría que copiarlo y las
    dos copias se separarían al primer cambio de redacción. Y sembrarlo al
    arrancar significa que cada réplica escribe en la base durante el despliegue,
    que es justo cuando no conviene que nadie escriba nada.

    NO CAMBIA NINGUNA POLÍTICA VIGENTE: si la versión ya está, no toca nada.
    """
    if not await puede_mover_dinero(db, current_user.id):
        raise ForbiddenError("No puedes publicar políticas.")
    # SE MIRA ANTES SI YA ESTABA. La siembra es idempotente y devuelve la misma
    # fila las dos veces; sin esta comprobacion, la auditoria registraria una
    # publicacion de politica cada vez que alguien pulsa el boton, y una tabla
    # que cuenta publicaciones que no ocurrieron deja de servir como prueba.
    estaba = await politicas.recompra_ya_sembrada(db) is not None
    politica = await politicas.sembrar_recompra(db)
    if politica is None:
        raise NotFoundError(
            "La migración 0050 todavía no está aplicada.",
            code="governance_not_available",
        )
    if not estaba:
        # PUBLICAR UNA POLITICA ES EL ACTO QUE MAS FALTA HACE AUDITAR de todos
        # los que pasan por aqui: fija el texto contra el que se comparara cada
        # aceptacion posterior. Sin esta nota, la primera version aparecia en la
        # base sin decir quien la puso ni cuando.
        await auditoria.anotar(
            db,
            action="policy.published",
            entity_type="policy_version",
            entity_id=politica.id,
            actor_id=current_user.id,
            actor_role="admin",
            reason="siembra de la politica de recompra",
            payload={
                "policy_type": politica.policy_type,
                "version": politica.version,
                # `policy_hash` Y NO `body_sha256`: el filtro de la nota descarta
                # cualquier clave con el trozo `body`, y hace bien —una nota no
                # archiva cuerpos—. Este campo es la huella del texto, no el
                # texto, y `policy_hash` es ademas el nombre que ya usa
                # `consent_records` para lo mismo.
                "policy_hash": politica.body_sha256,
            },
            origen=leer_origen(request),
        )
    await db.commit()
    return PoliticaVigente.model_validate(politica)
