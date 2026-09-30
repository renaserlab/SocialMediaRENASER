"""Las rutas de la agenda de Servicios (Incremento 4). CATORCE, y ninguna más.

DEL PRESTADOR, sobre SU servicio (lo ajeno es 404):

    GET    /services/provider/services/{id}/schedule           la agenda entera
    PUT    /services/provider/services/{id}/schedule           crearla o sustituir su configuración
    POST   …/schedule/rules | /exceptions | /blocks            añadir (con `Idempotency-Key`)
    PATCH  …/schedule/rules/{r} | /exceptions/{e}              cambiar solo lo que llega
    DELETE …/schedule/rules/{r} | /exceptions/{e} | /blocks/{b}
    GET    …/schedule/preview                                   fechas, como las vería una persona
    GET    …/schedule/preview/{date}                            horarios de una fecha

PÚBLICAS, con o sin sesión, SOLO de lo público:

    GET    /services/catalog/{id}/availability                  fechas con horarios
    GET    /services/catalog/{id}/availability/{date}           horarios de una fecha

LAS PUERTAS, en este orden: sesión (401, solo el prestador) → bandera, 0086–0090
y 0092 (503 `services_disabled` / `services_not_ready`) → cuerpo (422).

Cada escritura devuelve LA AGENDA ENTERA recién leída: la pantalla pinta lo que
dice el servidor. NINGUNA RUTA CREA UNA RESERVA NI UNA RETENCIÓN.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.services import agenda as dominio
from app.modules.services import agenda_politica as limites
from app.modules.services import esquema
from app.modules.services.agenda_schemas import (
    AgendaConfigurar,
    AgendaPrivadaRead,
    BloqueoCrear,
    CalendarioRead,
    ExcepcionCrear,
    ExcepcionEditar,
    PaginaDeHorariosRead,
    ReglaCrear,
    ReglaEditar,
)
from app.modules.services.catalogo_router import _id
from app.modules.services.router import _clave
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services-schedule"])

AGENDA = "/provider/services/{service_id}/schedule"
DISPONIBILIDAD = "/catalog/{service_id}/availability"


async def agenda_disponible(db: AsyncSession = Depends(get_db)) -> None:
    """Bandera, admisión, catálogo y la 0092 completas, o 503 con su código."""
    await esquema.exigir_agenda(db)


def _mira(usuario: AuthUser | None) -> str | None:
    return usuario.id if usuario is not None else None


async def _fresca(db: AsyncSession, usuario_id: str, servicio_id: str) -> AgendaPrivadaRead:
    return AgendaPrivadaRead.desde(await dominio.leer(db, usuario_id=usuario_id, servicio_id=servicio_id))


async def _tras_escribir(
    db: AsyncSession, escrito: dominio.Escrito, response: Response, usuario_id: str, servicio_id: str, *, nuevo: bool
) -> AgendaPrivadaRead:
    await db.commit()
    if nuevo:
        response.status_code = status.HTTP_201_CREATED if escrito.creado else status.HTTP_200_OK
    return await _fresca(db, usuario_id, servicio_id)


# =========================================================================== #
# El prestador
# =========================================================================== #
@router.get(AGENDA, response_model=AgendaPrivadaRead)
async def mi_agenda(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """La agenda propia. Sin configurar, `configured: false` y lo que falta."""
    return await _fresca(db, current_user.id, _id(service_id))


@router.put(AGENDA, response_model=AgendaPrivadaRead)
async def configurar_agenda(
    service_id: str,
    cuerpo: AgendaConfigurar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """Crea la agenda (201) o sustituye su configuración (200). Idempotente:
    la misma dos veces no escribe dos veces. Cambiar la zona de una agenda con
    semana o excepciones exige `confirm_timezone_change`."""
    escrito = await dominio.configurar(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), zona=cuerpo.timezone, estado=cuerpo.status,
        preparacion=cuerpo.buffer_before_minutes, descanso=cuerpo.buffer_after_minutes,
        intervalo=cuerpo.slot_interval_minutes, confirmar_zona=cuerpo.confirm_timezone_change,
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=True)


@router.post(f"{AGENDA}/rules", response_model=AgendaPrivadaRead, status_code=status.HTTP_201_CREATED)
async def crear_regla(
    service_id: str,
    cuerpo: ReglaCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """Una franja semanal. Con la misma `Idempotency-Key`, la misma (200)."""
    escrito = await dominio.crear_regla(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), dia=cuerpo.weekday, inicio=cuerpo.start,
        fin=cuerpo.end, modalidad=cuerpo.modality, capacidad=cuerpo.capacity, activa=cuerpo.active, clave=clave,
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=True)


@router.patch(f"{AGENDA}/rules/{{rule_id}}", response_model=AgendaPrivadaRead)
async def editar_regla(
    service_id: str,
    rule_id: str,
    cuerpo: ReglaEditar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """Solo lo que llega. `active: false` la desactiva sin borrarla."""
    escrito = await dominio.editar_regla(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), regla_id=rule_id, cambios=cuerpo.cambios()
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=False)


@router.delete(f"{AGENDA}/rules/{{rule_id}}", response_model=AgendaPrivadaRead)
async def borrar_regla(
    service_id: str,
    rule_id: str,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    escrito = await dominio.borrar_regla(db, usuario_id=current_user.id, servicio_id=_id(service_id), regla_id=rule_id)
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=False)


@router.post(f"{AGENDA}/exceptions", response_model=AgendaPrivadaRead, status_code=status.HTTP_201_CREATED)
async def crear_excepcion(
    service_id: str,
    cuerpo: ExcepcionCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """Una fecha: `closed` (sin franja, el día entero), `extra` (añade una
    franja) o `replace` (sustituye la semana ese día)."""
    escrito = await dominio.crear_excepcion(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), datos=cuerpo.model_dump(), clave=clave
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=True)


@router.patch(f"{AGENDA}/exceptions/{{exception_id}}", response_model=AgendaPrivadaRead)
async def editar_excepcion(
    service_id: str,
    exception_id: str,
    cuerpo: ExcepcionEditar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    escrito = await dominio.editar_excepcion(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), excepcion_id=exception_id,
        cambios=cuerpo.cambios(),
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=False)


@router.delete(f"{AGENDA}/exceptions/{{exception_id}}", response_model=AgendaPrivadaRead)
async def borrar_excepcion(
    service_id: str,
    exception_id: str,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    escrito = await dominio.borrar_excepcion(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), excepcion_id=exception_id
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=False)


@router.post(f"{AGENDA}/blocks", response_model=AgendaPrivadaRead, status_code=status.HTTP_201_CREATED)
async def crear_bloqueo(
    service_id: str,
    cuerpo: BloqueoCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    """Aparta un intervalo, con fecha y hora LOCALES de la agenda. El motivo
    es privado: no sale de la agenda del prestador."""
    escrito = await dominio.crear_bloqueo(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), datos=cuerpo.model_dump(), clave=clave
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=True)


@router.delete(f"{AGENDA}/blocks/{{block_id}}", response_model=AgendaPrivadaRead)
async def borrar_bloqueo(
    service_id: str,
    block_id: str,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> AgendaPrivadaRead:
    escrito = await dominio.borrar_bloqueo(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), bloqueo_id=block_id
    )
    return await _tras_escribir(db, escrito, response, current_user.id, service_id, nuevo=False)


@router.get(f"{AGENDA}/preview", response_model=CalendarioRead)
async def vista_previa(
    service_id: str,
    from_date: str | None = Query(default=None, alias="from", max_length=10),
    to_date: str | None = Query(default=None, alias="to", max_length=10),
    modality: str | None = Query(default=None, max_length=16),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> CalendarioRead:
    """Las fechas que vería una persona, aunque el servicio todavía no sea
    público, con `issues`: por qué el público aún no las ve."""
    return CalendarioRead.desde(
        await dominio.calendario_previo(
            db, usuario_id=current_user.id, servicio_id=_id(service_id), desde=from_date, hasta=to_date,
            modalidad=modality,
        ),
    )


@router.get(f"{AGENDA}/preview/{{day}}", response_model=PaginaDeHorariosRead)
async def vista_previa_del_dia(
    service_id: str,
    day: str,
    modality: str | None = Query(default=None, max_length=16),
    cursor: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=limites.HORARIOS_POR_PAGINA, ge=1, le=limites.HORARIOS_MAXIMOS_POR_PAGINA),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeHorariosRead:
    return PaginaDeHorariosRead.desde(
        await dominio.horarios_previos(
            db, usuario_id=current_user.id, servicio_id=_id(service_id), fecha=day, modalidad=modality,
            cursor=cursor, limite=limit,
        )
    )


# =========================================================================== #
# Lo público
# =========================================================================== #
@router.get(DISPONIBILIDAD, response_model=CalendarioRead)
async def disponibilidad(
    service_id: str,
    from_date: str | None = Query(default=None, alias="from", max_length=10),
    to_date: str | None = Query(default=None, alias="to", max_length=10),
    modality: str | None = Query(default=None, max_length=16),
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> CalendarioRead:
    """Las fechas con horarios POSIBLES de un servicio público, desde hoy y
    como mucho hasta el horizonte, de 31 días en 31. Un horario que se ve no
    queda apartado: no hay reservas todavía."""
    return CalendarioRead.desde(
        await dominio.calendario_publico(
            db, servicio_id=_id(service_id), mira=_mira(current_user), desde=from_date, hasta=to_date,
            modalidad=modality,
        ),
    )


@router.get(f"{DISPONIBILIDAD}/{{day}}", response_model=PaginaDeHorariosRead)
async def disponibilidad_del_dia(
    service_id: str,
    day: str,
    modality: str | None = Query(default=None, max_length=16),
    cursor: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=limites.HORARIOS_POR_PAGINA, ge=1, le=limites.HORARIOS_MAXIMOS_POR_PAGINA),
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(agenda_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeHorariosRead:
    return PaginaDeHorariosRead.desde(
        await dominio.horarios_publicos(
            db, servicio_id=_id(service_id), mira=_mira(current_user), fecha=day, modalidad=modality,
            cursor=cursor, limite=limit,
        )
    )


__all__ = ["router"]
