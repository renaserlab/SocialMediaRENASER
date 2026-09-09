"""HTTP de entradas e inventario.

VA EN SU PROPIO ROUTER Y SE MONTA ANTES que el de Eventos. `/events/ticket-holds/{id}`
y `/events/{event_id}/ticket-types` tienen los dos tres tramos, y FastAPI
resuelve por orden de registro: declarado después, un identificador de reserva
podría intentar casar con la ruta de tipos. Registrarlo primero cierra la
ambigüedad sin inventar prefijos.

TODO PASA POR `exigir_entradas_disponibles`: la migración Y la bandera. Con
cualquiera de las dos ausentes, 503 con un código estable y el catálogo, la
ficha y la reserva gratuita siguen exactamente igual.
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, Header, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog.models import Event
from app.modules.events import permissions, service, states, ticketing
from app.modules.events.models import EventTicketType
from app.modules.events.schemas import (
    DisponibilidadRead,
    HoldCreate,
    HoldRead,
    LineaDeHold,
    TicketingRead,
    TicketingUpsert,
    TicketTypeCreate,
    TicketTypeDelOrganizador,
    TicketTypeRead,
    TicketTypeUpdate,
    VencidosRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(prefix="/events", tags=["events-ticketing"])
admin_router = APIRouter(prefix="/admin/events", tags=["events-ticketing"])


# --------------------------------------------------------------------------- #
# Presentación
# --------------------------------------------------------------------------- #


def _tipo_publico(tipo: EventTicketType, disponibles: int) -> TicketTypeRead:
    return TicketTypeRead(
        id=tipo.id,
        name=tipo.name,
        description=tipo.description,
        price_minor=tipo.price_minor,
        currency=tipo.currency,
        min_per_order=tipo.min_per_order,
        max_per_order=tipo.max_per_order,
        inclusions=list(tipo.inclusions or []),
        restrictions=list(tipo.restrictions or []),
        sort_order=tipo.sort_order,
        disponibles=disponibles,
    )


def _tipo_del_organizador(
    tipo: EventTicketType, disponibles: int
) -> TicketTypeDelOrganizador:
    return TicketTypeDelOrganizador(
        **_tipo_publico(tipo, disponibles).model_dump(),
        quota=tipo.quota,
        status=tipo.status,
    )


async def _hold_leido(
    db: AsyncSession, hold, momento
) -> HoldRead:
    lineas = await ticketing.lineas_de(db, hold.id)
    # HACIA ARRIBA, NO TRUNCADO. Con 0,4 segundos por delante, `int()` devolvia
    # cero sobre una reserva que el servidor sigue considerando ACTIVA: la
    # pantalla veia el contador en cero, volvia a preguntar, recibia lo mismo y
    # repetia la peticion durante esa ventana de menos de un segundo. Redondear
    # hacia arriba dice la verdad —queda algo— y cierra el bucle.
    restantes = math.ceil(
        max(
            0.0,
            (
                ticketing._comparable(hold.expires_at, momento) - momento
            ).total_seconds(),
        )
    )
    return HoldRead(
        id=hold.id,
        event_id=hold.event_id,
        status=ticketing.estado_efectivo(hold, momento),
        currency=hold.currency,
        subtotal_minor=hold.subtotal_minor,
        items=[
            LineaDeHold(
                ticket_type_id=linea.ticket_type_id,
                name=linea.ticket_type_name_snapshot,
                quantity=linea.quantity,
                unit_price_minor=linea.unit_price_minor,
                subtotal_minor=linea.subtotal_minor,
            )
            for linea in lineas
        ],
        expires_at=hold.expires_at,
        segundos_restantes=restantes,
    )


async def _evento_publico(db: AsyncSession, evento_id: str) -> Event:
    """Un evento que se puede enseñar. Uno que no, responde 404."""
    ensure_uuid(evento_id, "Evento no encontrado.")
    evento = await db.get(Event, evento_id)
    if evento is None:
        raise NotFoundError("Evento no encontrado.")
    operacion = await service.operacion_de(db, evento_id)
    workflow = operacion.workflow_status if operacion else None
    if not states.se_puede_saber_que_existe(workflow, evento.status):
        raise NotFoundError("Evento no encontrado.")
    return evento


async def _evento_propio(db: AsyncSession, evento_id: str, usuario: AuthUser) -> Event:
    ensure_uuid(evento_id, "Evento no encontrado.")
    evento = await db.get(Event, evento_id)
    if evento is None:
        raise NotFoundError("Evento no encontrado.")
    permissions.exigir_organizador(evento, usuario)
    return evento


# --------------------------------------------------------------------------- #
# Reservas temporales. PRIMERO, por el orden de resolución de rutas.
# --------------------------------------------------------------------------- #


@router.get("/ticket-holds/{hold_id}", response_model=HoldRead)
async def ver_hold(
    hold_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HoldRead:
    """La reserva de quien pregunta. La de otra persona responde 404."""
    await ticketing.exigir_entradas_disponibles(db)
    ensure_uuid(hold_id, "Reserva no encontrada.")
    hold = await ticketing.leer_hold(db, hold_id=hold_id, usuario_id=current_user.id)
    return await _hold_leido(db, hold, ticketing.ahora())


@router.delete("/ticket-holds/{hold_id}", response_model=HoldRead)
async def liberar_hold(
    hold_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HoldRead:
    """Devuelve las entradas apartadas. Liberar dos veces no es un error."""
    await ticketing.exigir_entradas_disponibles(db)
    ensure_uuid(hold_id, "Reserva no encontrada.")
    hold = await ticketing.liberar_hold(
        db, hold_id=hold_id, usuario_id=current_user.id
    )
    return await _hold_leido(db, hold, ticketing.ahora())


@router.post(
    "/{evento_id}/ticket-holds",
    response_model=HoldRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_hold(
    evento_id: str,
    payload: HoldCreate,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HoldRead:
    """Aparta entradas durante diez minutos. NO ES UNA COMPRA.

    La clave de idempotencia es OBLIGATORIA: sin ella, un reintento de la red
    aparta el doble de entradas y la persona no se entera hasta que ve el
    resumen.
    """
    await ticketing.exigir_entradas_disponibles(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    if not idempotency_key.strip():
        raise ValidationAppError("Falta la clave de idempotencia.")
    hold = await ticketing.crear_hold(
        db,
        evento_id=evento_id,
        usuario_id=current_user.id,
        pedido=[(linea.ticket_type_id, linea.quantity) for linea in payload.items],
        clave=idempotency_key.strip(),
    )
    # LA HORA SE LEE AQUI, con la reserva ya escrita. Fijarla antes de llamar
    # hacia que los segundos restantes se contaran desde antes de la espera del
    # cerrojo, y salian de mas.
    return await _hold_leido(db, hold, ticketing.ahora())


# --------------------------------------------------------------------------- #
# Lectura pública
# --------------------------------------------------------------------------- #


@router.get("/{evento_id}/ticket-types", response_model=list[TicketTypeRead])
async def tipos_publicos(
    evento_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[TicketTypeRead]:
    """Los tipos A LA VENTA de un evento con entradas.

    Un evento gratuito responde 409 `event_not_ticketed` y no una lista vacía:
    son dos cosas distintas y la pantalla decide cosas distintas con cada una.
    """
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_publico(db, evento_id)
    ajustes = await ticketing.configuracion(db, evento_id)
    if not ticketing.vende_entradas(ajustes):
        raise ticketing.EventoSinEntradas()
    momento = ticketing.ahora()
    libre = await ticketing.disponibilidad(db, evento, momento, solo_a_la_venta=True)
    return [
        _tipo_publico(tipo, libre.por_tipo.get(tipo.id, 0))
        for tipo in await ticketing.tipos_de(db, evento_id, solo_a_la_venta=True)
    ]


@router.get("/{evento_id}/availability", response_model=DisponibilidadRead)
async def disponibilidad(
    evento_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> DisponibilidadRead:
    """Cuánto queda AHORA. Se calcula en el servidor, siempre.

    SOLO LOS TIPOS A LA VENTA. Esta ruta es anónima: los borradores y los
    retirados no se nombran aquí.
    """
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_publico(db, evento_id)
    libre = await ticketing.disponibilidad(db, evento, solo_a_la_venta=True)
    ajustes = await ticketing.configuracion(db, evento_id)
    return DisponibilidadRead(
        general=libre.general,
        por_tipo=libre.por_tipo,
        max_per_order=ajustes.max_per_order if ajustes else None,
    )


# --------------------------------------------------------------------------- #
# Organizador
# --------------------------------------------------------------------------- #


@router.get("/{evento_id}/ticketing", response_model=TicketingRead)
async def leer_configuracion(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TicketingRead:
    await ticketing.exigir_entradas_disponibles(db)
    await _evento_propio(db, evento_id, current_user)
    ajustes = await ticketing.configuracion(db, evento_id)
    if ajustes is None:
        # SIN FILA SIGNIFICA GRATUITO. Se responde eso en vez de un 404: el
        # evento existe y su modo de acceso es conocido.
        return TicketingRead(access_mode=ticketing.LIBRE, currency="PEN")
    return TicketingRead(
        access_mode=ajustes.access_mode,
        currency=ajustes.currency,
        max_per_order=ajustes.max_per_order,
        sales_open_at=ajustes.sales_open_at,
        sales_close_at=ajustes.sales_close_at,
    )


@router.put("/{evento_id}/ticketing", response_model=TicketingRead)
async def guardar_configuracion(
    evento_id: str,
    payload: TicketingUpsert,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TicketingRead:
    """Configura el modo de acceso y la moneda del evento."""
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_propio(db, evento_id, current_user)
    # `exclude_unset`: lo que el cliente no menciona no se toca. Ver
    # `guardar_configuracion`.
    await ticketing.guardar_configuracion(
        db,
        evento=evento,
        datos=payload.model_dump(exclude_unset=True),
        usuario=current_user,
    )
    return await leer_configuracion(evento_id, current_user, db)


@router.get(
    "/{evento_id}/ticket-types/manage", response_model=list[TicketTypeDelOrganizador]
)
async def tipos_del_organizador(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TicketTypeDelOrganizador]:
    """Todos los tipos, incluidos los borradores y los retirados."""
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_propio(db, evento_id, current_user)
    libre = await ticketing.disponibilidad(db, evento)
    return [
        _tipo_del_organizador(tipo, libre.por_tipo.get(tipo.id, 0))
        for tipo in await ticketing.tipos_de(db, evento_id)
    ]


@router.post(
    "/{evento_id}/ticket-types",
    response_model=TicketTypeDelOrganizador,
    status_code=status.HTTP_201_CREATED,
)
async def crear_tipo(
    evento_id: str,
    payload: TicketTypeCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TicketTypeDelOrganizador:
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_propio(db, evento_id, current_user)
    tipo = await ticketing.crear_tipo(
        db, evento=evento, datos=payload.model_dump(), usuario=current_user
    )
    libre = await ticketing.disponibilidad(db, evento)
    return _tipo_del_organizador(tipo, libre.por_tipo.get(tipo.id, 0))


@router.patch(
    "/{evento_id}/ticket-types/{tipo_id}", response_model=TicketTypeDelOrganizador
)
async def editar_tipo(
    evento_id: str,
    tipo_id: str,
    payload: TicketTypeUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TicketTypeDelOrganizador:
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_propio(db, evento_id, current_user)
    ensure_uuid(tipo_id, "Tipo de entrada no encontrado.")
    # UN `null` EXPLÍCITO NO ES UN CAMBIO. `{"quota": null}` llegaba al servicio
    # y acababa en `int(None)`, es decir, un 500 por una petición mal formada.
    # Ninguno de estos campos es anulable: mandarlos vacíos no significa nada.
    datos = {
        campo: valor
        for campo, valor in payload.model_dump(exclude_unset=True).items()
        if valor is not None
    }
    if not datos:
        raise ValidationAppError("No hay nada que cambiar.")
    tipo = await ticketing.editar_tipo(
        db, evento=evento, tipo_id=tipo_id, datos=datos, usuario=current_user
    )
    libre = await ticketing.disponibilidad(db, evento)
    return _tipo_del_organizador(tipo, libre.por_tipo.get(tipo.id, 0))


@router.delete(
    "/{evento_id}/ticket-types/{tipo_id}", response_model=TicketTypeDelOrganizador
)
async def retirar_tipo(
    evento_id: str,
    tipo_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TicketTypeDelOrganizador:
    """RETIRA, no borra.

    Una reserva puede estar apuntando a este tipo y su resumen tiene que seguir
    contando lo mismo. Solo se borra de verdad el que no ha vendido ni apartado
    nada, y eso lo decide el servicio.
    """
    await ticketing.exigir_entradas_disponibles(db)
    evento = await _evento_propio(db, evento_id, current_user)
    ensure_uuid(tipo_id, "Tipo de entrada no encontrado.")
    tipo = await ticketing.retirar_tipo(
        db, evento=evento, tipo_id=tipo_id, usuario=current_user
    )
    libre = await ticketing.disponibilidad(db, evento)
    return _tipo_del_organizador(tipo, libre.por_tipo.get(tipo.id, 0))


# --------------------------------------------------------------------------- #
# Limpieza
# --------------------------------------------------------------------------- #


@admin_router.post("/ticket-holds/expire", response_model=VencidosRead)
async def vencer_holds(
    lote: int = 500,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VencidosRead:
    """Pasa a `EXPIRED` las reservas vencidas. Por lotes e idempotente.

    NO ES LO QUE LIBERA EL INVENTARIO: la disponibilidad ya ignora las
    vencidas. Esto es limpieza, para que la tabla diga lo que pasa.

    Sin bucle: devuelve cuántas tocó y quien la llame decide si vuelve. Pensada
    para un programador de tareas externo; montar un temporizador dentro de
    FastAPI lo ataría a que hubiera exactamente un proceso vivo.
    """
    await ticketing.exigir_entradas_disponibles(db)
    # EL ROL ESTRECHO, no `require_admin`. Aquel incluye `moderator`, que existe
    # para revisar contenido; esto es una operación masiva sobre inventario.
    await permissions.exigir_rol_de_admision(db, current_user)
    return VencidosRead(
        procesados=await ticketing.vencer_holds(db, lote=lote, usuario=current_user)
    )
