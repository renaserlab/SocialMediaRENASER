"""Las rutas de la reserva de Servicios (Incremento 5). DOCE, y ninguna más.

DE QUIEN CONTRATA (con sesión; lo ajeno es 404):

    POST   /services/catalog/{id}/holds             apartar un horario (`Idempotency-Key`)
    GET    /services/holds/{h}                      la retención, con la hora del servidor
    POST   /services/holds/{h}/release              soltarla (`Idempotency-Key`)
    GET    /services/holds/{h}/checkout             el resumen: lo que se contrata y se acepta
    POST   /services/holds/{h}/confirm              contratar (`Idempotency-Key`)
    GET    /services/me/bookings                    mis reservas (por venir o pasadas), por cursor
    GET    /services/me/bookings/{b}                una, con lo aceptado y su historial

DEL PRESTADOR (las de SUS servicios; lo ajeno es 404):

    GET    /services/provider/bookings              por venir o pasadas, por cursor
    GET    /services/provider/bookings/{b}          lo que la atención necesita

DE ADMINISTRACIÓN (solo `admin`; nada privado):

    GET    /admin/services/holds                    las retenciones, por estado
    GET    /admin/services/bookings                 las reservas
    POST   /admin/services/holds/expire             EL BARRIDO de las vencidas, por lotes

LAS PUERTAS, en este orden: sesión (401) → `FEATURE_SERVICES`, sin tocar la
base (503 `services_disabled`) → `FEATURE_SERVICE_BOOKING`, sin tocar la base
(503 `service_booking_disabled`) → 0086–0093 (503 `services_not_ready`) →
cuerpo (422). En administración el ROL va antes que las puertas.

NINGUNA RUTA MUEVE DINERO: lo que tiene precio contesta 503
`service_booking_payments_not_configured` y no escribe nada.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.services import atencion, esquema
from app.modules.services import reserva as dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_schemas import CuidadoRead
from app.modules.services.catalogo_router import _id
from app.modules.services.reserva_models import CLIENTE, PRESTADOR
from app.modules.services.reserva_schemas import (
    BarridoRead,
    PaginaDeReservasAdminRead,
    PaginaDeReservasRead,
    PaginaDeRetencionesAdminRead,
    ReservaAdminRead,
    ReservaConfirmar,
    ReservaDelPrestadorRead,
    ReservaDetalleRead,
    ReservaRead,
    ResumenRead,
    RetencionAdminRead,
    RetencionCrear,
    RetencionRead,
)
from app.modules.services.router import _clave, funcion_de_decision
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services-booking"])
admin_router = APIRouter(prefix="/admin/services", tags=["services-booking-admin"])


async def reservas_disponibles(db: AsyncSession = Depends(get_db)) -> None:
    """Banderas, admisión, catálogo, agenda y la 0093 completas, o 503."""
    await esquema.exigir_reservas(db)


async def con_cuidado(db: AsyncSession, detalle: dominio.Detalle, *, rol: str, usuario_id: str) -> dominio.Detalle:
    """Añade al detalle LA ATENCIÓN (Incremento 6) y lo que esa persona puede
    hacer ahora (`care.available_actions`). Sin la 0094 no añade nada: la
    reserva se sigue viendo y la app no ofrece ninguna acción."""
    if await esquema.hay_atencion(db):
        cuidado = await atencion.cuidado(db, detalle.reserva, rol=rol, usuario_id=usuario_id)
        detalle.extra["care"] = CuidadoRead.desde(cuidado, detalle.reserva, usuario_id=usuario_id)
    return detalle


async def _retencion_fresca(db: AsyncSession, retencion, *, ahora=None) -> RetencionRead:  # noqa: ANN001
    ahora = ahora or dominio._ahora()
    reserva = await dominio.reserva_de_la_retencion(db, retencion.id) if retencion.status == "consumed" else None
    return RetencionRead.desde(retencion, ahora=ahora, reserva_id=reserva.id if reserva else None)


# =========================================================================== #
# Quien contrata
# =========================================================================== #
@router.post("/catalog/{service_id}/holds", response_model=RetencionRead, status_code=status.HTTP_201_CREATED)
async def apartar(
    service_id: str,
    cuerpo: RetencionCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> RetencionRead:
    """Aparta un horario que la agenda ofrece AHORA. La misma clave con lo
    mismo devuelve la misma retención (200, sin alargarla)."""
    hecho = await dominio.retener(
        db, cliente_id=current_user.id, servicio_id=_id(service_id), inicio=cuerpo.starts_at,
        modalidad=cuerpo.modality, clave=clave,
    )
    await db.commit()
    if not hecho.creada:
        response.status_code = status.HTTP_200_OK
    return await _retencion_fresca(db, hecho.retencion)


@router.get("/holds/{hold_id}", response_model=RetencionRead)
async def ver_retencion(
    hold_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> RetencionRead:
    return await _retencion_fresca(
        db, await dominio.retencion(db, cliente_id=current_user.id, retencion_id=hold_id)
    )


@router.post("/holds/{hold_id}/release", response_model=RetencionRead)
async def soltar(
    hold_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> RetencionRead:
    """Suelta el horario. Soltar lo ya soltado o vencido es lo mismo (200)."""
    fila = await dominio.liberar(db, cliente_id=current_user.id, retencion_id=hold_id, clave=clave)
    await db.commit()
    return await _retencion_fresca(db, fila)


@router.get("/holds/{hold_id}/checkout", response_model=ResumenRead)
async def resumen(
    hold_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> ResumenRead:
    """Lo que se contrata: el servicio de la retención, su precio, lo que hay
    que aceptar HOY y, en `contract.blockers`, lo que impediría confirmar.
    Solo lectura. Con precio, es la contratación PREPARADA: no se cobra."""
    return ResumenRead.desde(await dominio.resumen(db, cliente_id=current_user.id, retencion_id=hold_id))


@router.post("/holds/{hold_id}/confirm", response_model=ReservaDetalleRead, status_code=status.HTTP_201_CREATED)
async def confirmar(
    hold_id: str,
    cuerpo: ReservaConfirmar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ReservaDetalleRead:
    """CONTRATA lo gratuito: nacen juntos el pedido, la reserva, lo aceptado y
    el historial. Con la misma clave y lo mismo, la misma reserva (200)."""
    hecho = await dominio.confirmar(
        db, cliente_id=current_user.id, retencion_id=hold_id, datos=cuerpo.datos(), clave=clave
    )
    await db.commit()
    if not hecho.creada:
        response.status_code = status.HTTP_200_OK
    detalle = await dominio.mi_reserva(db, cliente_id=current_user.id, reserva_id=hecho.reserva.id)
    return ReservaDetalleRead.del_detalle(await con_cuidado(db, detalle, rol=CLIENTE, usuario_id=current_user.id))


@router.get("/me/bookings", response_model=PaginaDeReservasRead)
async def mis_reservas(
    scope: str = Query(default=dominio.POR_VENIR, pattern=r"^(upcoming|past)$"),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeReservasRead:
    """Por venir, de la más próxima a la más lejana; pasadas, al revés."""
    pagina = await dominio.mis_reservas(db, cliente_id=current_user.id, ambito=scope, cursor=cursor, limite=limit)
    return PaginaDeReservasRead(items=[ReservaRead.desde(b) for b in pagina.reservas], next_cursor=pagina.siguiente)


@router.get("/me/bookings/{booking_id}", response_model=ReservaDetalleRead)
async def mi_reserva(
    booking_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> ReservaDetalleRead:
    detalle = await dominio.mi_reserva(db, cliente_id=current_user.id, reserva_id=booking_id)
    return ReservaDetalleRead.del_detalle(await con_cuidado(db, detalle, rol=CLIENTE, usuario_id=current_user.id))


# =========================================================================== #
# El prestador
# =========================================================================== #
@router.get("/provider/bookings", response_model=PaginaDeReservasRead)
async def reservas_del_prestador(
    scope: str = Query(default=dominio.POR_VENIR, pattern=r"^(upcoming|past)$"),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeReservasRead:
    """Las reservas de los servicios PROPIOS. Sin ser prestador, ninguna."""
    pagina = await dominio.reservas_del_prestador(
        db, usuario_id=current_user.id, ambito=scope, cursor=cursor, limite=limit
    )
    return PaginaDeReservasRead(items=[ReservaRead.desde(b) for b in pagina.reservas], next_cursor=pagina.siguiente)


@router.get("/provider/bookings/{booking_id}", response_model=ReservaDelPrestadorRead)
async def reserva_del_prestador(
    booking_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> ReservaDelPrestadorRead:
    detalle = await dominio.reserva_del_prestador(db, usuario_id=current_user.id, reserva_id=booking_id)
    return ReservaDelPrestadorRead.del_detalle_del_prestador(
        await con_cuidado(db, detalle, rol=PRESTADOR, usuario_id=current_user.id)
    )


# =========================================================================== #
# Administración
# =========================================================================== #
@admin_router.get("/holds", response_model=PaginaDeRetencionesAdminRead)
async def retenciones_para_administrar(
    status_: str | None = Query(default=None, alias="status", pattern=r"^(active|consumed|released|expired)$"),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeRetencionesAdminRead:
    ahora = dominio._ahora()
    pagina = await dominio.retenciones_para_administrar(
        db, estado=status_, cursor=cursor, limite=limit, ahora=ahora
    )
    return PaginaDeRetencionesAdminRead(
        items=[RetencionAdminRead.desde(h, ahora=ahora) for h in pagina.retenciones], next_cursor=pagina.siguiente
    )


@admin_router.get("/bookings", response_model=PaginaDeReservasAdminRead)
async def reservas_para_administrar(
    scope: str = Query(default=dominio.POR_VENIR, pattern=r"^(upcoming|past)$"),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeReservasAdminRead:
    pagina = await dominio.reservas_para_administrar(db, ambito=scope, cursor=cursor, limite=limit)
    return PaginaDeReservasAdminRead(
        items=[ReservaAdminRead.desde(b) for b in pagina.reservas], next_cursor=pagina.siguiente
    )


@admin_router.post("/holds/expire", response_model=BarridoRead)
async def barrer(
    batch: int = Query(default=limites.LOTE_DEL_BARRIDO, ge=1, le=limites.LOTE_MAXIMO_DEL_BARRIDO),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(reservas_disponibles),
    db: AsyncSession = Depends(get_db),
) -> BarridoRead:
    """EL BARRIDO de las retenciones vencidas, por lotes. Idempotente. Lo
    llamará un planificador externo que todavía no existe (decisión
    pendiente); NO es la autoridad del vencimiento: eso lo decide la hora."""
    vencidas = await dominio.vencer_retenciones(db, lote=batch)
    await db.commit()
    return BarridoRead(expired=vencidas)


__all__ = ["admin_router", "con_cuidado", "router"]
