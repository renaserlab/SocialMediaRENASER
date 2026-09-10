"""HTTP de órdenes, entradas emitidas y check-in.

SE MONTA ANTES que el router de Eventos, por la misma razón que el de entradas:
`/events/orders/{id}` y `/events/{event_id}/...` tienen los dos tres tramos y
FastAPI resuelve por orden de registro.

TODO PASA POR `exigir_ordenes_disponibles`: la migración 0062 Y la bandera
`FEATURE_EVENT_TICKETING`. Con cualquiera de las dos ausentes, 503 con un código
estable y el catálogo, la ficha, la reserva gratuita y las reservas temporales
siguen exactamente igual.

EL COBRO VA APARTE, detrás de `FEATURE_EVENT_PAYMENTS`. Apagarla detiene la
venta y no toca ni el inventario ni las órdenes ya iniciadas.
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Event
from app.modules.events import orders, pagos, permissions, states, ticketing
from app.modules.events import tickets as emision
from app.modules.events.models import (
    EventOperations,
    EventOrder,
    EventTicket,
    EventTicketHold,
)
from app.modules.events.schemas import (
    AsistenteRead,
    CheckinRequest,
    CredencialRead,
    EntradaRead,
    IntentoDePagoRead,
    LineaDeOrden,
    OrdenRead,
    PaginaDeAsistentes,
    PaginaDeEntradas,
    PaginaDeOrdenes,
    RevocarRequest,
    VencidosRead,
    VentasRead,
    VerificarRequest,
    VeredictoRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(prefix="/events", tags=["events-orders"])
admin_router = APIRouter(prefix="/admin/events", tags=["events-orders"])


# --------------------------------------------------------------------------- #
# Presentación
# --------------------------------------------------------------------------- #
async def _orden_leida(
    db: AsyncSession,
    orden: EventOrder,
    *,
    lineas=None,
    expira=None,
) -> OrdenRead:
    """Una orden, lista para responder.

    `lineas` y `expira` se pueden pasar ya resueltos: la LISTA los trae de dos
    consultas para toda la página. Sin eso eran dos consultas por fila —hasta
    doscientas en una página de cien— para pintar lo mismo.
    """
    if lineas is None:
        lineas = await orders.lineas_de(db, orden.id)
    if expira is None:
        hold = await db.get(EventTicketHold, orden.hold_id)
        expira = hold.expires_at if hold is not None else None
    momento = orders.ahora()
    restantes = 0
    if expira is not None:
        restantes = math.ceil(
            max(
                0.0,
                (ticketing._comparable(expira, momento) - momento).total_seconds(),
            )
        )
    return OrdenRead(
        id=orden.id,
        event_id=orden.event_id,
        status=orden.status,
        currency=orden.currency,
        subtotal_minor=orden.subtotal_minor,
        total_minor=orden.total_minor,
        items=[
            LineaDeOrden(
                ticket_type_id=l.ticket_type_id,
                name=l.ticket_type_name_snapshot,
                quantity=l.quantity,
                unit_price_minor=l.unit_price_minor,
                subtotal_minor=l.subtotal_minor,
            )
            for l in lineas
        ],
        created_at=orden.created_at,
        paid_at=orden.paid_at,
        segundos_restantes=restantes,
    )


def _entrada_leida(entrada: EventTicket) -> EntradaRead:
    return EntradaRead(
        id=entrada.id,
        event_id=entrada.event_id,
        order_id=entrada.order_id,
        ticket_type_id=entrada.ticket_type_id,
        name=entrada.ticket_type_name_snapshot,
        status=entrada.status,
        code=entrada.code,
        issued_at=entrada.issued_at,
        checked_in_at=entrada.checked_in_at,
    )


def _veredicto(v: emision.Veredicto) -> VeredictoRead:
    return VeredictoRead(
        result=v.resultado,
        ticket_id=v.entrada_id,
        name=v.tipo,
        checked_in_at=v.usada_a_las,
    )


# --------------------------------------------------------------------------- #
# Comprador: la orden
# --------------------------------------------------------------------------- #
@router.post(
    "/ticket-holds/{hold_id}/orders",
    response_model=OrdenRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_orden(
    hold_id: str,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> OrdenRead:
    """Convierte una reserva vigente en un pedido. NO cobra.

    La clave de idempotencia es OBLIGATORIA: sin ella un reintento de la red
    crea un segundo pedido sobre la misma reserva, y quien compra ve dos.
    """
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(hold_id, "Reserva no encontrada.")
    if not idempotency_key.strip():
        raise ValidationAppError("Falta la clave de idempotencia.")
    creada = await orders.crear_orden(
        db,
        hold_id=hold_id,
        usuario_id=current_user.id,
        clave=idempotency_key.strip(),
    )
    return await _orden_leida(db, creada.orden)


@router.get("/orders/{order_id}", response_model=OrdenRead)
async def leer_orden(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> OrdenRead:
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await orders.leer_orden(db, orden_id=order_id, usuario_id=current_user.id)
    return await _orden_leida(db, orden)


@router.get("/me/orders", response_model=PaginaDeOrdenes)
async def mis_ordenes(
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeOrdenes:
    await orders.exigir_ordenes_disponibles(db)
    filas = await orders.mis_ordenes(
        db, usuario_id=current_user.id, limite=limit, cursor=cursor
    )
    # DOS CONSULTAS PARA TODA LA PÁGINA, no dos por fila.
    lineas = await orders.lineas_de_varias(db, [o.id for o in filas])
    vencen = await orders.vencimientos_de(db, [o.hold_id for o in filas])
    items = [
        await _orden_leida(
            db, o, lineas=lineas.get(o.id, []), expira=vencen.get(o.hold_id)
        )
        for o in filas
    ]
    siguiente = (
        orders.cursor_de(filas[-1].created_at, filas[-1].id)
        if len(filas) == limit
        else None
    )
    return PaginaDeOrdenes(items=items, next_cursor=siguiente)


@router.post("/orders/{order_id}/cancel", response_model=OrdenRead)
async def cancelar_orden(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> OrdenRead:
    """Quien compra se arrepiente antes de pagar. La reserva sigue siendo suya."""
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await orders.cancelar_orden(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    return await _orden_leida(db, orden)


@router.post("/orders/{order_id}/payment", response_model=IntentoDePagoRead)
async def iniciar_pago(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IntentoDePagoRead:
    """Abre el cobro en la pasarela. NO marca nada como pagado.

    EL IMPORTE NO VIAJA EN LA PETICIÓN. Sale de la orden, que se escribió con
    los precios congelados en la reserva: si el cliente lo mandara, mandaría el
    precio.
    """
    await orders.exigir_ordenes_disponibles(db)
    pagos.exigir_pagos_disponibles()
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await orders.leer_orden(db, orden_id=order_id, usuario_id=current_user.id)
    evento = await db.get(Event, orden.event_id)
    if evento is None:
        raise NotFoundError("Evento no encontrado.")

    # LAS MISMAS URLS QUE USA CURSOS, con el pedido colgado. Volver a «gracias
    # por tu compra» despues de CANCELAR es mentirle a quien acaba de cancelar,
    # asi que las dos son distintas.
    ajustes = get_settings()
    intento = await pagos.iniciar_pago(
        db,
        orden=orden,
        titulo_del_evento=evento.title,
        correo=current_user.email or "",
        return_url=f"{ajustes.payments_return_url}?event_order={orden.id}",
        cancel_url=f"{ajustes.payments_cancel_url}?event_order={orden.id}",
    )
    return IntentoDePagoRead(
        order_id=orden.id,
        provider=intento.provider,
        checkout_url=intento.checkout_url,
    )


# --------------------------------------------------------------------------- #
# Comprador: las entradas
# --------------------------------------------------------------------------- #
@router.get("/me/tickets", response_model=PaginaDeEntradas)
async def mis_entradas(
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeEntradas:
    await orders.exigir_ordenes_disponibles(db)
    filas = await emision.mis_entradas(
        db, usuario_id=current_user.id, limite=limit, cursor=cursor
    )
    siguiente = (
        emision.cursor_de(filas[-1].issued_at, filas[-1].id)
        if len(filas) == limit
        else None
    )
    return PaginaDeEntradas(
        items=[_entrada_leida(e) for e in filas], next_cursor=siguiente
    )


@router.get("/tickets/{ticket_id}", response_model=EntradaRead)
async def leer_entrada(
    ticket_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EntradaRead:
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(ticket_id, "Entrada no encontrada.")
    entrada = await emision.leer_entrada(
        db, entrada_id=ticket_id, usuario_id=current_user.id
    )
    return _entrada_leida(entrada)


@router.post("/tickets/{ticket_id}/credential", response_model=CredencialRead)
async def credencial(
    ticket_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CredencialRead:
    """El valor que va dentro del QR. Se entrega una vez y ROTA.

    Es `POST` y no `GET` porque escribe: cada llamada genera una credencial
    nueva y deja la anterior inservible. Un QR fotografiado y compartido deja
    de valer en cuanto la persona abre su entrada otra vez.
    """
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(ticket_id, "Entrada no encontrada.")
    entrada, valor = await emision.credencial_de(
        db, entrada_id=ticket_id, usuario_id=current_user.id
    )
    return CredencialRead(ticket_id=entrada.id, credential=valor, code=entrada.code)


# --------------------------------------------------------------------------- #
# Admisión: verificar y dejar pasar
# --------------------------------------------------------------------------- #
async def _evento_de_la_puerta(
    db: AsyncSession, evento_id: str, usuario: AuthUser
) -> Event:
    """Quien organiza un evento QUE VENDE ENTRADAS, o el rol de admisión.

    NO VALE `require_admin`, que incluye `moderator`: ese rol existe para
    revisar contenido y esto es dejar entrar gente a un recinto.

    Y NO BASTA CON SER EL ORGANIZADOR. Crear un evento es libre: cualquiera con
    una cuenta abre un borrador que no ve nadie. Sin exigir que ese evento esté
    publicado y venda entradas, su identificador servía para preguntar por
    CUALQUIER credencial de la plataforma, y la respuesta distingue «no existe»
    de «es de otro evento»: un oráculo de validez de entradas ajenas, abierto a
    cualquier cuenta registrada.

    404 Y NO 403, siempre y en los dos casos. Un 403 sobre un evento ajeno
    confirma que ese identificador es un evento real que alguien está
    preparando. Es la misma respuesta que da `permissions.exigir_organizador`.
    """
    ensure_uuid(evento_id, "Evento no encontrado.")
    evento = await db.get(Event, evento_id)
    if evento is None:
        raise NotFoundError("Evento no encontrado.")

    if not permissions.es_organizador(evento, usuario):
        if not await permissions.es_admision(db, usuario.id):
            raise NotFoundError("Evento no encontrado.")

    operacion = await db.get(EventOperations, evento.id)
    workflow = operacion.workflow_status if operacion else "PUBLISHED"
    if not states.es_publico(workflow):
        raise NotFoundError("Evento no encontrado.")

    # UN EVENTO SIN VENTA NO TIENE PUERTA: no emite entradas, así que no hay
    # nada que verificar ni nadie a quien dejar pasar.
    ajustes = await ticketing.configuracion(db, evento.id)
    if not ticketing.vende_entradas(ajustes):
        raise NotFoundError("Evento no encontrado.")
    return evento


@router.post("/{event_id}/tickets/verify", response_model=VeredictoRead)
async def verificar(
    event_id: str,
    payload: VerificarRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VeredictoRead:
    """¿Vale esta credencial? No escribe nada y se puede preguntar mil veces."""
    await orders.exigir_ordenes_disponibles(db)
    evento = await _evento_de_la_puerta(db, event_id, current_user)
    return _veredicto(
        await emision.verificar(
            db, evento_id=evento.id, credencial=payload.credential
        )
    )


@router.post("/{event_id}/check-ins", response_model=VeredictoRead)
async def check_in(
    event_id: str,
    payload: CheckinRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VeredictoRead:
    """Deja pasar, UNA vez. Un segundo escaneo devuelve «ya utilizada»."""
    await orders.exigir_ordenes_disponibles(db)
    evento = await _evento_de_la_puerta(db, event_id, current_user)
    return _veredicto(
        await emision.check_in(
            db,
            evento_id=evento.id,
            credencial=payload.credential,
            operador_id=current_user.id,
        )
    )


@router.get("/{event_id}/attendees", response_model=PaginaDeAsistentes)
async def asistentes(
    event_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
    estado: str | None = Query(default=None, pattern="^(VALID|USED|REVOKED)$"),
    q: str | None = Query(default=None, max_length=32),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeAsistentes:
    """La lista de la puerta. LLEVA EL TIPO Y EL ESTADO, no al comprador."""
    await orders.exigir_ordenes_disponibles(db)
    evento = await _evento_de_la_puerta(db, event_id, current_user)
    filas = await emision.asistentes(
        db, evento_id=evento.id, limite=limit, cursor=cursor, estado=estado, busqueda=q
    )
    siguiente = (
        emision.cursor_de(filas[-1].issued_at, filas[-1].id)
        if len(filas) == limit
        else None
    )
    return PaginaDeAsistentes(
        items=[
            AsistenteRead(
                ticket_id=e.id,
                ticket_type_id=e.ticket_type_id,
                name=e.ticket_type_name_snapshot,
                status=e.status,
                checked_in_at=e.checked_in_at,
            )
            for e in filas
        ],
        next_cursor=siguiente,
    )


# --------------------------------------------------------------------------- #
# Organizador: las ventas
# --------------------------------------------------------------------------- #
@router.get("/{event_id}/sales", response_model=VentasRead)
async def ventas(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VentasRead:
    """El resumen del evento. `ingresos_brutos_minor` es BRUTO y lo dice."""
    await orders.exigir_ordenes_disponibles(db)
    evento = await _evento_de_la_puerta(db, event_id, current_user)
    resumen = await orders.resumen_de_ventas(db, evento.id)
    return VentasRead(
        entradas_emitidas=resumen.entradas_emitidas,
        entradas_usadas=resumen.entradas_usadas,
        entradas_revocadas=resumen.entradas_revocadas,
        ordenes_pagadas=resumen.ordenes_pagadas,
        ordenes_pendientes=resumen.ordenes_pendientes,
        ingresos_brutos_minor=resumen.ingresos_brutos_minor,
        currency=resumen.currency,
        checkins=await emision.cuantos_entraron(db, evento.id),
    )


@router.post("/tickets/{ticket_id}/revoke", response_model=EntradaRead)
async def revocar(
    ticket_id: str,
    payload: RevocarRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EntradaRead:
    """Retira una entrada, con motivo. Solo quien organiza o admisión.

    LA MISMA RESPUESTA EXISTA O NO. Cargar la entrada y comprobar el rol después
    convertía la respuesta en un oráculo: un 404 significaba «no existe» y un
    403, «existe y es de otro». Ahora las dos son 404 con el mismo código.
    """
    await orders.exigir_ordenes_disponibles(db)
    ensure_uuid(ticket_id, "Entrada no encontrada.")
    entrada = await db.get(EventTicket, ticket_id)
    if entrada is None:
        raise emision.EntradaNoEncontrada()
    try:
        await _evento_de_la_puerta(db, entrada.event_id, current_user)
    except NotFoundError:
        raise emision.EntradaNoEncontrada() from None
    entrada = await emision.revocar(
        db, entrada_id=ticket_id, usuario_id=current_user.id, motivo=payload.reason
    )
    return _entrada_leida(entrada)


# --------------------------------------------------------------------------- #
# Mantenimiento
# --------------------------------------------------------------------------- #
@admin_router.post("/orders/expire", response_model=VencidosRead)
async def vencer_ordenes(
    lote: int = 500,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VencidosRead:
    """Cierra los pedidos cuya reserva ya no aparta nada.

    EL ROL ESTRECHO, no `require_admin`: es una operación masiva sobre
    inventario, y `moderator` existe para revisar contenido.
    """
    await orders.exigir_ordenes_disponibles(db)
    await permissions.exigir_rol_de_admision(db, current_user)
    return VencidosRead(
        procesados=await orders.vencer_ordenes(db, lote=lote, usuario=current_user)
    )
