"""Los casos de uso de la admisión de Servicios que existen en el Bloque 1A.

LO QUE HAY: empezar o recuperar la postulación propia, leerla, cambiar el
borrador, leer el historial, y en administración la bandeja, el detalle y el
historial completo. Ninguno cambia el estado de una postulación.

LO QUE NO HAY TODAVÍA (Bloque 1B): enviar, reenviar, registrar documentos y
credenciales, y las decisiones de Z. Sus contratos están en `schemas` y su mapa
en `states`; aquí no se simulan.

LA IDENTIDAD SALE SIEMPRE DEL TOKEN, nunca del cuerpo: todas las funciones del
prestador reciben `usuario_id` y solo tocan lo suyo.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.services import politicas, states
from app.modules.services.models import (
    DOCUMENTO_OBSERVADO,
    EMPRESA,
    POLITICA_TERMINOS_DEL_PRESTADOR,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderCredential,
    ServiceProviderDocument,
)
from app.modules.services.permissions import SolicitudNoEncontrada

#: Los campos del borrador que son del PRESTADOR y los que son de la POSTULACIÓN.
CAMPOS_DEL_PRESTADOR = frozenset(
    {
        "provider_type",
        "display_name",
        "legal_name",
        "country_code",
        "tax_id",
        "representative_name",
    }
)
CAMPOS_DE_LA_SOLICITUD = frozenset({"summary", "requested_category"})

#: Tope de la bandeja por página.
LIMITE_MAXIMO = 100


class SolicitudNoEditable(ConflictError):
    code = "service_application_not_editable"
    message = "Esta postulación ya no se puede editar."


class CursorInvalido(ValidationAppError):
    code = "invalid_cursor"
    message = "Cursor no válido."


@dataclass
class Expediente:
    solicitud: ServiceProviderApplication
    prestador: ServiceProvider
    documentos: list[ServiceProviderDocument]
    credenciales: list[ServiceProviderCredential]


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def prestador_de(db: AsyncSession, usuario_id: str) -> ServiceProvider | None:
    return await db.scalar(
        select(ServiceProvider).where(ServiceProvider.profile_id == usuario_id)
    )


async def _actual(db: AsyncSession, prestador_id: str) -> ServiceProviderApplication | None:
    """La viva si la hay; si no, la última (rechazada). Es lo que el prestador
    tiene que ver: su expediente en curso o el motivo del último rechazo."""
    viva = await db.scalar(
        select(ServiceProviderApplication).where(
            ServiceProviderApplication.provider_id == prestador_id,
            ServiceProviderApplication.status.in_(states.VIVAS),
        )
    )
    if viva is not None:
        return viva
    return await db.scalar(
        select(ServiceProviderApplication)
        .where(ServiceProviderApplication.provider_id == prestador_id)
        .order_by(
            ServiceProviderApplication.created_at.desc(),
            ServiceProviderApplication.id.desc(),
        )
        .limit(1)
    )


async def expediente_de(
    db: AsyncSession, solicitud: ServiceProviderApplication
) -> Expediente:
    prestador = await db.get(ServiceProvider, solicitud.provider_id)
    documentos = list(
        await db.scalars(
            select(ServiceProviderDocument)
            .where(ServiceProviderDocument.application_id == solicitud.id)
            .order_by(ServiceProviderDocument.created_at, ServiceProviderDocument.id)
        )
    )
    credenciales = list(
        await db.scalars(
            select(ServiceProviderCredential)
            .where(ServiceProviderCredential.provider_id == solicitud.provider_id)
            .order_by(ServiceProviderCredential.created_at, ServiceProviderCredential.id)
        )
    )
    return Expediente(
        solicitud=solicitud,
        prestador=prestador,
        documentos=documentos,
        credenciales=credenciales,
    )


async def la_mia(db: AsyncSession, usuario_id: str) -> Expediente:
    """El expediente propio, o 404."""
    prestador = await prestador_de(db, usuario_id)
    solicitud = await _actual(db, prestador.id) if prestador is not None else None
    if solicitud is None:
        raise SolicitudNoEncontrada()
    return await expediente_de(db, solicitud)


async def historial(
    db: AsyncSession, solicitud_id: str
) -> list[ServiceProviderApplicationEvent]:
    return list(
        await db.scalars(
            select(ServiceProviderApplicationEvent)
            .where(ServiceProviderApplicationEvent.application_id == solicitud_id)
            .order_by(
                ServiceProviderApplicationEvent.created_at,
                ServiceProviderApplicationEvent.id,
            )
        )
    )


# --------------------------------------------------------------------------- #
# Lo que falta para enviar (el validador que el Bloque 1B hará cumplir)
# --------------------------------------------------------------------------- #
def faltantes(expediente: Expediente, *, terminos_publicados: bool | None) -> list[str]:
    """Códigos traducibles de lo que falta. Vacío = completo.

    `terminos_publicados` en `None` significa «no se pudo mirar» (sin país no
    se sabe qué política rige); no se inventa ni un sí ni un no.

    LO QUE NO SE PIDE AQUÍ, porque la empresa no lo ha cerrado: qué documentos
    exige cada categoría, el teléfono verificado y la cuenta de cobro (que
    espera a que exista dinero). Se añaden cuando se decidan.
    """
    prestador = expediente.prestador
    solicitud = expediente.solicitud
    presentados = {
        d.kind for d in expediente.documentos if d.review_status != DOCUMENTO_OBSERVADO
    }

    faltan: list[str] = []
    if not prestador.legal_name:
        faltan.append("legal_name")
    if not prestador.country_code:
        faltan.append("country_code")
    if not solicitud.summary:
        faltan.append("summary")
    if "identity" not in presentados:
        faltan.append("document:identity")
    if prestador.provider_type == EMPRESA:
        if not prestador.tax_id:
            faltan.append("tax_id")
        if not prestador.representative_name:
            faltan.append("representative_name")
        if "legal_representation" not in presentados:
            faltan.append("document:legal_representation")
    if terminos_publicados is False:
        faltan.append("provider_terms_not_published")
    return faltan


async def faltantes_de(db: AsyncSession, expediente: Expediente) -> list[str]:
    publicados: bool | None = None
    if expediente.prestador.country_code:
        politica = await politicas.vigente(
            db,
            tipo=POLITICA_TERMINOS_DEL_PRESTADOR,
            pais=expediente.prestador.country_code,
            categoria=expediente.solicitud.requested_category,
        )
        publicados = politica is not None
    return faltantes(expediente, terminos_publicados=publicados)


# --------------------------------------------------------------------------- #
# Escritura del prestador (sin cambiar estados)
# --------------------------------------------------------------------------- #
async def iniciar(
    db: AsyncSession, *, usuario_id: str, tipo: str, nombre: str
) -> tuple[Expediente, bool]:
    """La postulación viva, o una nueva. IDEMPOTENTE.

    Devuelve el expediente y si acaba de nacer. Si ya hay una viva, se devuelve
    esa y no se toca nada. Si la última está rechazada, nace otra: volver a
    postular es otra postulación.

    DOS PETICIONES A LA VEZ no crean dos: la base tiene un prestador por perfil
    y una postulación viva por prestador. La que pierde la carrera se deshace y
    devuelve la que ganó.
    """
    prestador = await prestador_de(db, usuario_id)
    if prestador is not None:
        actual = await _actual(db, prestador.id)
        if actual is not None and actual.status in states.VIVAS:
            return await expediente_de(db, actual), False

    ahora = _ahora()
    try:
        if prestador is None:
            prestador = ServiceProvider(
                profile_id=usuario_id,
                provider_type=tipo,
                display_name=nombre,
                created_at=ahora,
                updated_at=ahora,
            )
            db.add(prestador)
            await db.flush()
        solicitud = ServiceProviderApplication(
            provider_id=prestador.id,
            status=states.BORRADOR,
            created_at=ahora,
            updated_at=ahora,
        )
        db.add(solicitud)
        await db.flush()
        db.add(
            ServiceProviderApplicationEvent(
                application_id=solicitud.id,
                from_status=None,
                to_status=states.BORRADOR,
                actor_id=usuario_id,
                actor_role=states.PRESTADOR,
                created_at=ahora,
            )
        )
        await db.flush()
    except IntegrityError:
        await db.rollback()
        return await la_mia(db, usuario_id), False
    return await expediente_de(db, solicitud), True


async def actualizar_borrador(
    db: AsyncSession, *, usuario_id: str, cambios: dict[str, object]
) -> Expediente:
    """Cambia el borrador propio. NUNCA el estado.

    `cambios` solo trae campos del prestador y de la postulación; el esquema de
    entrada rechaza cualquier otro, y aquí se vuelve a filtrar por si alguien
    llama a esta función desde otro sitio.
    """
    desconocidos = set(cambios) - CAMPOS_DEL_PRESTADOR - CAMPOS_DE_LA_SOLICITUD
    if desconocidos:
        raise ValidationAppError(
            "Hay campos que no se pueden cambiar aquí.",
            code="service_application_field_not_editable",
            details={"fields": sorted(desconocidos)},
        )

    expediente = await la_mia(db, usuario_id)
    if not states.es_editable(expediente.solicitud.status):
        raise SolicitudNoEditable(details={"status": expediente.solicitud.status})

    ahora = _ahora()
    tocado_prestador = False
    tocada_solicitud = False
    for campo, valor in cambios.items():
        if campo in CAMPOS_DEL_PRESTADOR:
            setattr(expediente.prestador, campo, valor)
            tocado_prestador = True
        else:
            setattr(expediente.solicitud, campo, valor)
            tocada_solicitud = True
    if tocado_prestador:
        expediente.prestador.updated_at = ahora
    if tocada_solicitud or tocado_prestador:
        expediente.solicitud.updated_at = ahora
    await db.flush()
    return expediente


# --------------------------------------------------------------------------- #
# Administración (solo lectura en este bloque)
# --------------------------------------------------------------------------- #
def _orden():
    """La bandeja ordena por el último envío; un borrador, por su creación."""
    return func.coalesce(
        ServiceProviderApplication.last_submitted_at,
        ServiceProviderApplication.created_at,
    )


def cursor_de(solicitud: ServiceProviderApplication) -> str:
    momento = solicitud.last_submitted_at or solicitud.created_at
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return f"{momento.isoformat()}|{solicitud.id}"


def _cursor_partido(cursor: str) -> tuple[datetime, str]:
    """La fecha Y el identificador, los dos validados: un identificador mal
    escrito que llega a una columna `uuid` sería un 500."""
    fecha, _, ident = cursor.partition("|")
    try:
        momento = datetime.fromisoformat(fecha)
        UUID(ident)
    except ValueError:
        raise CursorInvalido() from None
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return momento, ident


async def bandeja(
    db: AsyncSession,
    *,
    estados: frozenset[str] | tuple[str, ...],
    tipo: str | None,
    cursor: str | None,
    limite: int,
) -> tuple[list[tuple[ServiceProviderApplication, ServiceProvider]], str | None]:
    """Una página de la bandeja y el cursor de la siguiente (`None` = no hay)."""
    limite = max(1, min(int(limite), LIMITE_MAXIMO))
    orden = _orden()
    consulta = (
        select(ServiceProviderApplication, ServiceProvider)
        .join(ServiceProvider, ServiceProvider.id == ServiceProviderApplication.provider_id)
        .where(ServiceProviderApplication.status.in_(tuple(estados)))
    )
    if tipo:
        consulta = consulta.where(ServiceProvider.provider_type == tipo)
    if cursor:
        momento, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            or_(
                orden < momento,
                and_(orden == momento, ServiceProviderApplication.id < ident),
            )
        )
    filas = list(
        (
            await db.execute(
                consulta.order_by(orden.desc(), ServiceProviderApplication.id.desc()).limit(
                    limite + 1
                )
            )
        ).all()
    )
    siguiente = None
    if len(filas) > limite:
        filas = filas[:limite]
        siguiente = cursor_de(filas[-1][0])
    return [(s, p) for s, p in filas], siguiente


async def por_id(db: AsyncSession, solicitud_id: str) -> ServiceProviderApplication:
    """Para administración. Un identificador mal escrito es un 404, no un 500."""
    try:
        UUID(solicitud_id)
    except ValueError:
        raise SolicitudNoEncontrada() from None
    solicitud = await db.get(ServiceProviderApplication, solicitud_id)
    if solicitud is None:
        raise SolicitudNoEncontrada()
    return solicitud


__all__ = [
    "CAMPOS_DE_LA_SOLICITUD",
    "CAMPOS_DEL_PRESTADOR",
    "CursorInvalido",
    "Expediente",
    "SolicitudNoEditable",
    "actualizar_borrador",
    "bandeja",
    "cursor_de",
    "expediente_de",
    "faltantes",
    "faltantes_de",
    "historial",
    "iniciar",
    "la_mia",
    "por_id",
    "prestador_de",
]
