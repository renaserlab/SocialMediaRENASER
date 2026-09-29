"""Los casos de uso de LECTURA y del BORRADOR de la admisión de Servicios.

LO QUE HAY AQUÍ: empezar o recuperar la postulación propia, leer el
expediente, cambiar el borrador, el historial, y en administración la bandeja,
el detalle, los envíos y el historial completo. NINGUNO cambia el estado de
una postulación: los saltos viven todos en `admision`.

LA IDENTIDAD SALE SIEMPRE DEL TOKEN, nunca del cuerpo: todas las funciones del
prestador reciben `usuario_id` y solo tocan lo suyo.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.services import credenciales, documentos, politicas, requisitos, states
from app.modules.services.models import (
    ACTIVO,
    RETIRADO,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderApplicationSubmission,
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
    #: ACTIVOS. Los reemplazados van aparte, solo para administración.
    documentos: list[ServiceProviderDocument]
    credenciales: list[ServiceProviderCredential]
    reemplazados: list[ServiceProviderDocument] = field(default_factory=list)
    #: Los identificadores ya enviados alguna vez: esos no se retiran.
    documentos_enviados: set[str] = field(default_factory=set)
    credenciales_enviadas: set[str] = field(default_factory=set)
    envios: list[ServiceProviderApplicationSubmission] = field(default_factory=list)
    #: Lo que Z señaló en la última petición de correcciones.
    campos_observados: list[str] = field(default_factory=list)
    politica_aceptada: ServicePolicy | None = None


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def hoy() -> date:
    return _ahora().date()


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def prestador_de(db: AsyncSession, usuario_id: str) -> ServiceProvider | None:
    return await db.scalar(
        select(ServiceProvider).where(ServiceProvider.profile_id == usuario_id)
    )


async def _actual(db: AsyncSession, prestador_id: str) -> ServiceProviderApplication | None:
    """La viva si la hay; si no, la última (rechazada o retirada). Es lo que el
    prestador tiene que ver: su expediente en curso o cómo acabó el último."""
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


async def _campos_observados(db: AsyncSession, solicitud: ServiceProviderApplication) -> list[str]:
    if solicitud.status != states.CORRECCIONES_PEDIDAS:
        return []
    pedido = await db.scalar(
        select(ServiceProviderApplicationEvent)
        .where(
            ServiceProviderApplicationEvent.application_id == solicitud.id,
            ServiceProviderApplicationEvent.to_status == states.CORRECCIONES_PEDIDAS,
        )
        .order_by(ServiceProviderApplicationEvent.created_at.desc())
        .limit(1)
    )
    campos = ((pedido.details if pedido else None) or {}).get("fields", [])
    return [c for c in campos if c in requisitos.CAMPOS_OBSERVABLES]


async def expediente_de(
    db: AsyncSession, solicitud: ServiceProviderApplication
) -> Expediente:
    """El expediente de ESA postulación. Nada de otra postulación se cuela."""
    prestador = await db.get(ServiceProvider, solicitud.provider_id)
    todos = await documentos.de_la_solicitud(db, solicitud.id, solo_activos=False)
    envios = list(
        await db.scalars(
            select(ServiceProviderApplicationSubmission)
            .where(ServiceProviderApplicationSubmission.application_id == solicitud.id)
            .order_by(ServiceProviderApplicationSubmission.sequence)
        )
    )
    enviados_d: set[str] = set()
    enviadas_c: set[str] = set()
    for envio in envios:
        foto = envio.snapshot or {}
        enviados_d |= {str(d.get("id")) for d in foto.get("documents", []) if isinstance(d, dict)}
        enviadas_c |= {str(c.get("id")) for c in foto.get("credentials", []) if isinstance(c, dict)}
    return Expediente(
        solicitud=solicitud,
        prestador=prestador,
        documentos=[d for d in todos if d.lifecycle == ACTIVO],
        credenciales=await credenciales.de_la_solicitud(db, solicitud.id),
        reemplazados=[d for d in todos if d.lifecycle not in (ACTIVO, RETIRADO)],
        documentos_enviados=enviados_d,
        credenciales_enviadas=enviadas_c,
        envios=envios,
        campos_observados=await _campos_observados(db, solicitud),
        politica_aceptada=(
            await db.get(ServicePolicy, solicitud.terms_policy_id)
            if solicitud.terms_policy_id
            else None
        ),
    )


async def la_mia(db: AsyncSession, usuario_id: str, *, bloquear: bool = False) -> Expediente:
    """El expediente propio, o 404.

    `bloquear=True` para ESCRIBIR: bloquea la fila de la postulación antes de
    leer nada más. Sin el bloqueo, un cambio que se colaba mientras se enviaba
    la postulación la modificaba después de congelar el envío.
    """
    prestador = await prestador_de(db, usuario_id)
    solicitud = await _actual(db, prestador.id) if prestador is not None else None
    if solicitud is None:
        raise SolicitudNoEncontrada()
    if bloquear:
        from app.modules.services import admision

        solicitud = await admision.bloquear(db, solicitud.id)
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


def _evidencia(expediente: Expediente) -> requisitos.Evidencia:
    return requisitos.Evidencia(
        solicitud=expediente.solicitud,
        prestador=expediente.prestador,
        documentos=expediente.documentos,
        credenciales=expediente.credenciales,
    )


async def faltantes_de(db: AsyncSession, expediente: Expediente) -> list[str]:
    """Lo que falta para ENVIAR o REENVIAR, como códigos. Vacío = se puede."""
    prestador = expediente.prestador
    solicitud = expediente.solicitud
    vigente = (
        await politicas.vigente(db, pais=prestador.country_code, categoria=solicitud.requested_category)
        if prestador.country_code
        else None
    )
    faltan = requisitos.para_enviar(
        _evidencia(expediente),
        vigente=vigente,
        hoy=hoy(),
        terminos_consultables=bool(prestador.country_code),
    )
    if solicitud.status == states.CORRECCIONES_PEDIDAS:
        faltan += requisitos.correcciones_pendientes(
            _evidencia(expediente),
            campos_observados=expediente.campos_observados,
            ultimo_envio=expediente.envios[-1].snapshot if expediente.envios else None,
            hoy=hoy(),
        )
    return faltan


def bloqueos_para_aprobar(expediente: Expediente) -> list[str]:
    """Lo que impide aprobar, medido contra la política ACEPTADA."""
    return requisitos.para_aprobar(
        _evidencia(expediente), aceptada=expediente.politica_aceptada, hoy=hoy()
    )


# --------------------------------------------------------------------------- #
# Escritura del prestador (sin cambiar estados)
# --------------------------------------------------------------------------- #
async def iniciar(
    db: AsyncSession, *, usuario_id: str, tipo: str, nombre: str
) -> tuple[Expediente, bool]:
    """La postulación viva, o una nueva. IDEMPOTENTE.

    Devuelve el expediente y si acaba de nacer. Si ya hay una viva, se devuelve
    esa y no se toca nada. Si la última está RETIRADA, nace otra, vacía. Si está
    RECHAZADA, volver a postular lo decide la política vigente
    (`reapplication_after_rejection`); sin esa decisión, no se inventa.

    DOS PETICIONES A LA VEZ no crean dos: la base tiene un prestador por perfil
    y una postulación viva por prestador. La que pierde la carrera se deshace y
    devuelve la que ganó.
    """
    from app.modules.services import admision

    prestador = await prestador_de(db, usuario_id)
    if prestador is not None:
        actual = await _actual(db, prestador.id)
        if actual is not None and actual.status in states.VIVAS:
            return await expediente_de(db, actual), False
        if actual is not None:
            await admision.exigir_que_pueda_repostular(db, prestador=prestador, ultima=actual)

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
                details={},
                created_at=ahora,
            )
        )
        await db.flush()
    except IntegrityError:
        await db.rollback()
        return await la_mia(db, usuario_id), False
    await admision.auditar(
        db,
        accion="service_application.created",
        entidad="service_application",
        entidad_id=solicitud.id,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
    )
    return await expediente_de(db, solicitud), True


#: Lo que la base exige a una postulación que ya se envió.
OBLIGATORIOS_TRAS_ENVIAR = frozenset({"summary"})


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

    expediente = await la_mia(db, usuario_id, bloquear=True)
    if not states.es_editable(expediente.solicitud.status):
        raise SolicitudNoEditable(details={"status": expediente.solicitud.status})
    # Lo que una postulación ENVIADA tiene que tener (0086/0087,
    # `enviada_completa`) no se vacía al corregirla: sería un 500 en la base.
    if expediente.solicitud.status != states.BORRADOR:
        vaciados = sorted(c for c in OBLIGATORIOS_TRAS_ENVIAR if c in cambios and cambios[c] is None)
        if vaciados:
            raise ValidationAppError(
                "Ese dato no se puede vaciar una vez enviada la postulación.",
                code="service_application_field_required",
                details={"fields": vaciados},
            )

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
# Administración (lectura)
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
    "LIMITE_MAXIMO",
    "SolicitudNoEditable",
    "actualizar_borrador",
    "bandeja",
    "bloqueos_para_aprobar",
    "cursor_de",
    "expediente_de",
    "faltantes_de",
    "historial",
    "hoy",
    "iniciar",
    "la_mia",
    "por_id",
    "prestador_de",
]
