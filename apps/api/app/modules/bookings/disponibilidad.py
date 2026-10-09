"""Disponibilidad para las sesiones 1:1: la semana tipo de cada persona.

LO QUE SE PIDIÓ (07/10/2026): que cada usuario defina en qué días y horarios
está disponible, y que quien le pide una sesión elija entre esos horarios.

ES UN PROTOTIPO. Lo que hace:

  * Cada persona guarda sus franjas de la semana («martes de 9 a 12»), en su
    zona horaria. Guardar SUSTITUYE la semana entera: no hay edición franja a
    franja que pueda dejarla a medias.
  * Quien va a pedir una sesión recibe los HUECOS concretos de los próximos
    días: cada franja partida en sesiones de una hora, sin los que ya pasaron
    ni los que esa persona ya tiene ocupados con una sesión aceptada.

Lo que NO hace, a sabiendas:

  * Excepciones por fecha, vacaciones ni bloqueos de un día.
  * Sesiones de otra duración que una hora.
  * IMPONER la franja: pedir una sesión sigue aceptando cualquier momento
    futuro (`bookings/router.py`). Los huecos orientan a quien pide; quien
    recibe la solicitud sigue pudiendo aceptarla o no.
  * No es la agenda de Z Servicios (`modules/services`), que es de los
    prestadores y tiene sus reglas.

SIN LA MIGRACIÓN 0100 no hay tabla: se dice `available: false`, la aplicación
no enseña nada de esto y pedir una sesión funciona como siempre.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone as tz
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.bookings.models import AvailabilitySlot, Booking
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(prefix="/availability", tags=["availability"])

#: Lo que dura una sesión. Fijo en el prototipo.
MINUTOS_DE_SESION = 60
#: Con cuánta antelación mínima se ofrece un hueco: nadie agenda «dentro de
#: diez minutos» con alguien que todavía tiene que aceptarlo.
ANTELACION = timedelta(hours=1)
#: Cuántos días hacia delante se ofrecen, por omisión y como mucho.
DIAS_POR_OMISION = 14
DIAS_MAXIMO = 30
#: Tope de huecos en una respuesta: es una lista para elegir, no un calendario.
HUECOS_MAXIMO = 60
#: Franjas por día y por semana. Cuatro al día cubre mañana, mediodía, tarde y
#: noche; más que eso ya no es una semana tipo.
FRANJAS_POR_DIA = 4
ZONA_POR_OMISION = "America/Lima"


def _zona(nombre: str) -> ZoneInfo:
    try:
        return ZoneInfo(nombre)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as error:
        raise ValueError(f"Zona horaria no reconocida: '{nombre}'.") from error


def _a_minutos(texto: str) -> int:
    """De «09:30» a 570. «24:00» vale como final de día."""
    try:
        horas, minutos = (int(parte) for parte in texto.split(":"))
    except ValueError as error:
        raise ValueError("La hora tiene que ir como HH:MM.") from error
    if texto == "24:00":
        return 1440
    if not (0 <= horas <= 23 and 0 <= minutos <= 59):
        raise ValueError("La hora tiene que ir como HH:MM.")
    return horas * 60 + minutos


def _a_texto(minutos: int) -> str:
    return f"{minutos // 60:02d}:{minutos % 60:02d}"


class Franja(BaseModel):
    """«Este día de la semana, de tal hora a tal hora»."""

    #: 0 = lunes … 6 = domingo.
    weekday: int = Field(ge=0, le=6)
    start: str = Field(min_length=4, max_length=5)
    end: str = Field(min_length=4, max_length=5)

    @model_validator(mode="after")
    def _con_sentido(self) -> "Franja":
        inicio, fin = _a_minutos(self.start), _a_minutos(self.end)
        if fin - inicio < MINUTOS_DE_SESION:
            raise ValueError(
                f"Una franja tiene que durar al menos {MINUTOS_DE_SESION} minutos."
            )
        return self


class DisponibilidadEscrita(BaseModel):
    timezone: str = Field(default=ZONA_POR_OMISION, min_length=1, max_length=64)
    slots: list[Franja] = Field(default_factory=list, max_length=FRANJAS_POR_DIA * 7)

    @field_validator("timezone")
    @classmethod
    def _zona_real(cls, v: str) -> str:
        _zona(v)
        return v

    @model_validator(mode="after")
    def _sin_solapes(self) -> "DisponibilidadEscrita":
        por_dia: dict[int, list[tuple[int, int]]] = {}
        for franja in self.slots:
            por_dia.setdefault(franja.weekday, []).append(
                (_a_minutos(franja.start), _a_minutos(franja.end))
            )
        for tramos in por_dia.values():
            if len(tramos) > FRANJAS_POR_DIA:
                raise ValueError(f"Como mucho {FRANJAS_POR_DIA} franjas por día.")
            tramos.sort()
            for (_, fin), (inicio, _) in zip(tramos, tramos[1:]):
                if inicio < fin:
                    raise ValueError("Dos franjas del mismo día se pisan.")
        return self


class DisponibilidadLeida(BaseModel):
    #: `False` si el servidor todavía no tiene la tabla (migración 0100).
    available: bool
    timezone: str = ZONA_POR_OMISION
    slots: list[Franja] = Field(default_factory=list)


class Hueco(BaseModel):
    starts_at: datetime
    ends_at: datetime


class HuecosLeidos(BaseModel):
    available: bool
    #: En qué zona horaria tiene dicha su semana esa persona.
    timezone: str = ZONA_POR_OMISION
    session_minutes: int = MINUTOS_DE_SESION
    openings: list[Hueco] = Field(default_factory=list)


async def _franjas(db: AsyncSession, user_id: str) -> list[AvailabilitySlot]:
    return list(
        await db.scalars(
            select(AvailabilitySlot)
            .where(AvailabilitySlot.user_id == user_id)
            .order_by(AvailabilitySlot.weekday, AvailabilitySlot.starts_minute)
        )
    )


def _leer(filas: list[AvailabilitySlot]) -> DisponibilidadLeida:
    return DisponibilidadLeida(
        available=True,
        timezone=filas[0].timezone if filas else ZONA_POR_OMISION,
        slots=[
            Franja(
                weekday=f.weekday,
                start=_a_texto(f.starts_minute),
                end=_a_texto(f.ends_minute),
            )
            for f in filas
        ],
    )


@router.get("/me", response_model=DisponibilidadLeida)
async def mi_disponibilidad(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DisponibilidadLeida:
    if not await esquema.hay_disponibilidad(db):
        return DisponibilidadLeida(available=False)
    return _leer(await _franjas(db, current_user.id))


@router.put("/me", response_model=DisponibilidadLeida)
async def guardar_mi_disponibilidad(
    payload: DisponibilidadEscrita,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DisponibilidadLeida:
    """Sustituye la semana entera. Una lista vacía es «no estoy disponible»."""
    if not await esquema.hay_disponibilidad(db):
        return DisponibilidadLeida(available=False)
    await db.execute(
        delete(AvailabilitySlot).where(AvailabilitySlot.user_id == current_user.id)
    )
    for franja in payload.slots:
        db.add(
            AvailabilitySlot(
                user_id=current_user.id,
                weekday=franja.weekday,
                starts_minute=_a_minutos(franja.start),
                ends_minute=_a_minutos(franja.end),
                timezone=payload.timezone,
            )
        )
    await db.commit()
    return _leer(await _franjas(db, current_user.id))


def huecos_de(
    filas: list[AvailabilitySlot],
    *,
    ahora: datetime,
    dias: int,
    ocupados: list[datetime],
) -> list[Hueco]:
    """Los huecos concretos de los próximos `dias`, en orden.

    Pura a propósito —no toca la base ni el reloj— para poder probarla con una
    fecha fija. `ocupados` son los comienzos de las sesiones que esa persona ya
    tiene aceptadas: un hueco que se pise con una de ellas no se ofrece.
    """
    if not filas:
        return []
    zona = _zona(filas[0].timezone)
    sesion = timedelta(minutes=MINUTOS_DE_SESION)
    hoy: date = ahora.astimezone(zona).date()

    salida: list[Hueco] = []
    for desplazamiento in range(dias):
        dia = hoy + timedelta(days=desplazamiento)
        for fila in filas:
            if fila.weekday != dia.weekday():
                continue
            minuto = fila.starts_minute
            while minuto + MINUTOS_DE_SESION <= fila.ends_minute:
                # La hora se construye EN LA ZONA de la persona y luego se pasa
                # a UTC: «las 9 de Lima» no es la misma hora UTC todo el año en
                # las zonas con horario de verano.
                local = datetime.combine(dia, time(minuto // 60, minuto % 60), tzinfo=zona)
                empieza = local.astimezone(tz.utc)
                minuto += MINUTOS_DE_SESION
                if empieza < ahora + ANTELACION:
                    continue
                if any(abs(empieza - otro) < sesion for otro in ocupados):
                    continue
                salida.append(Hueco(starts_at=empieza, ends_at=empieza + sesion))
                if len(salida) >= HUECOS_MAXIMO:
                    return salida
    return salida


@router.get("/{user_id}/openings", response_model=HuecosLeidos)
async def huecos_de_una_persona(
    user_id: str,
    days: int = Query(default=DIAS_POR_OMISION, ge=1, le=DIAS_MAXIMO),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HuecosLeidos:
    """Cuándo se le puede pedir una sesión a esta persona."""
    ensure_uuid(user_id, "Perfil no encontrado.")
    if not await esquema.hay_disponibilidad(db):
        return HuecosLeidos(available=False)
    if await db.get(Profile, user_id) is None:
        raise NotFoundError("Perfil no encontrado.")

    # Un bloqueo, en cualquier sentido, corta también esto: no se enseña la
    # semana de alguien a quien no se le puede pedir nada.
    bloqueo = (
        await db.execute(
            select(UserBlock.blocker_id).where(
                or_(
                    (UserBlock.blocker_id == current_user.id)
                    & (UserBlock.blocked_id == user_id),
                    (UserBlock.blocker_id == user_id)
                    & (UserBlock.blocked_id == current_user.id),
                )
            )
        )
    ).first()
    if bloqueo:
        return HuecosLeidos(available=True)

    filas = await _franjas(db, user_id)
    if not filas:
        return HuecosLeidos(available=True)

    ahora = datetime.now(tz.utc)
    aceptadas = await db.scalars(
        select(Booking.scheduled_at).where(
            or_(Booking.provider_id == user_id, Booking.requester_id == user_id),
            Booking.status == "accepted",
            Booking.scheduled_at.is_not(None),
            Booking.scheduled_at >= ahora - timedelta(minutes=MINUTOS_DE_SESION),
        )
    )
    ocupados = [
        momento if momento.tzinfo else momento.replace(tzinfo=tz.utc)
        for momento in aceptadas
    ]
    return HuecosLeidos(
        available=True,
        timezone=filas[0].timezone,
        openings=huecos_de(filas, ahora=ahora, dias=days, ocupados=ocupados),
    )
