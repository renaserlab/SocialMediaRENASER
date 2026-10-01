"""La posventa de una reserva de Servicios (Incremento 6): el caso, su
expediente y la reseña verificada.

EL CASO. Uno por reserva. Lo abre una de las dos partes con un motivo cerrado;
la otra contesta; las dos aportan mensajes y evidencias (privadas); administración
resuelve; una parte puede apelar UNA vez, y entonces resuelve otra persona.

  * EL EXPEDIENTE solo se añade: mensajes, evidencias, resoluciones, la
    apelación y las notas internas (que NUNCA salen de administración).
  * LA EVIDENCIA va al depósito privado `service-incident-evidence`, se valida
    por sus bytes, se guarda con una ruta que genera el servidor y se mira con
    un enlace firmado que caduca. Nunca en un aviso, nunca con URL permanente.
  * RESOLVER NO ES DEVOLVER DINERO. La resolución dice qué se decidió, su
    efecto en la atención y el efecto económico SOLICITADO con su estado
    (`atencion.estado_del_efecto`): «no aplica», «pendiente» o «bloqueado».
    Ninguno dice que se ejecutó, y aquí no se llama a ninguna pasarela.
  * NADIE RESUELVE LO SUYO: ni un caso en el que es parte, ni la apelación de
    su propia resolución.

LA RESEÑA. De una atención CERRADA (verificada), de quien la contrató, una por
reserva y dentro de su plazo. La base lo impone (0094): aquí no hay ningún
«verificada = sí» que alguien pueda editar. El prestador responde una vez;
administración la esconde o la publica, sin borrarla ni reescribirla.

Las transiciones usan lo común de `atencion` (la reserva de quien actúa, su
cerrojo y la `Idempotency-Key`) y el mismo historial.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.modules.services import atencion, avisos, descubrimiento, documentos
from app.modules.services import reserva as reserva_dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.agenda import _es_uuid
from app.modules.services.atencion_models import (
    APELACION,
    AUSENTE_EL_CLIENTE,
    AUSENTE_EL_PRESTADOR,
    CASOS_VIVOS,
    CASO_APELADO,
    CASO_CERRADO,
    CASO_EN_CURSO,
    CASO_RESUELTO,
    CASO_RETIRADO,
    CERRADA,
    EFECTOS_ECONOMICOS,
    EFECTOS_EN_LA_ATENCION,
    EJES_DE_RESENA,
    ESTADOS_DE_CASO,
    ESTADOS_DE_RESENA,
    EVIDENCIA,
    MENSAJE,
    MOTIVOS,
    MOTIVO_DE_SEGURIDAD,
    NOTA_INTERNA,
    RESENA_ESCONDIDA,
    RESENA_PENDIENTE,
    RESENA_PUBLICADA,
    RESOLUCION,
    RESULTADOS,
    SIN_EFECTO,
    ServiceAttendance,
    ServiceIncident,
    ServiceIncidentEntry,
    ServiceReview,
)
from app.modules.services.reserva_models import (
    ADMINISTRACION,
    ATENCION_CERRADA_EVENTO,
    CASO_ABIERTO,
    CASO_APELADO as CASO_APELADO_EVENTO,
    CASO_CON_ENTRADA,
    CASO_RESUELTO as CASO_RESUELTO_EVENTO,
    CASO_RETIRADO as CASO_RETIRADO_EVENTO,
    CLIENTE,
    PRESTADOR,
    RESENA_CREADA,
    RESENA_MODERADA,
    RESENA_RESPONDIDA,
    RESERVA_CONFIRMADA,
    ServiceBooking,
    ServiceBookingEvent,
    ServiceOrder,
)
from app.modules.services.service import CursorInvalido

_utc = reserva_dominio._utc
_ahora = reserva_dominio._ahora

DEPOSITO = "service-incident-evidence"
#: Cuánto vive el enlace para mirar una evidencia. Corto: es para abrirla ahora.
SEGUNDOS_DE_LA_FIRMA = 120

#: Qué motivo puede alegar cada parte: nadie se reporta ausente a sí mismo.
MOTIVOS_DE = {
    CLIENTE: tuple(m for m in MOTIVOS if m != "client_absent"),
    PRESTADOR: ("client_absent", MOTIVO_DE_SEGURIDAD, "technical", "other"),
}
#: Por qué se esconde una reseña: lista cerrada (nunca por ser negativa).
MOTIVOS_DE_MODERACION = ("personal_data", "threat", "hate", "extortion", "off_topic", "other")
PUBLICAR = "publish"
ESCONDER = "hide"


# --------------------------------------------------------------------------- #
# Errores (códigos estables; la app los traduce)
# --------------------------------------------------------------------------- #
class CasoNoEncontrado(NotFoundError):
    code = "service_incident_not_found"
    message = "No encontramos ese caso."


class CasoYaExiste(ConflictError):
    code = "service_incident_exists"
    message = "Esta reserva ya tiene un caso."


class PlazoDelCasoVencido(ConflictError):
    code = "service_incident_window_closed"
    message = "El plazo para reportar este problema ya pasó."


class CasoNoAdmiteEso(ConflictError):
    code = "service_incident_not_open"
    message = "Este caso ya no admite esa acción."


class CasoInvalido(ValidationAppError):
    code = "service_incident_invalid"
    message = "Revisa los datos del caso."


class ApelacionNoPermitida(ConflictError):
    code = "service_incident_appeal_not_allowed"
    message = "Este caso ya no se puede apelar."


class ResolutorEnConflicto(ConflictError):
    code = "service_incident_resolver_conflict"
    message = "Este caso lo tiene que resolver otra persona."


class EfectoNoPermitido(ConflictError):
    code = "service_incident_effect_not_allowed"
    message = "Ese efecto no corresponde al estado de la atención."


class DemasiadasEvidencias(ConflictError):
    code = "service_incident_evidence_limit"
    message = "Este caso ya tiene el máximo de evidencias."


class EvidenciaNoDisponible(AppError):
    status_code = 502
    code = "service_evidence_unavailable"
    message = "No pudimos guardar o abrir la evidencia. Inténtalo de nuevo."


class AlmacenNoConfigurado(ServiceUnavailableError):
    code = "service_evidence_storage_not_configured"
    message = "Las evidencias todavía no están disponibles."


class ResenaNoPermitida(ConflictError):
    code = "service_review_not_allowed"
    message = "Todavía no se puede reseñar esta atención."


class ResenaYaExiste(ConflictError):
    code = "service_review_exists"
    message = "Esta atención ya tiene su reseña."


class ResenaNoEncontrada(NotFoundError):
    code = "service_review_not_found"
    message = "No encontramos esa reseña."


class ResenaInvalida(ValidationAppError):
    code = "service_review_invalid"
    message = "Revisa los datos de la reseña."


class ResenaYaRespondida(ConflictError):
    code = "service_review_already_replied"
    message = "Esta reseña ya tiene tu respuesta."


class ModeracionNoPermitida(ConflictError):
    code = "service_review_moderation_not_allowed"
    message = "Esa reseña ya está en ese estado."


# --------------------------------------------------------------------------- #
# El caso: abrirlo
# --------------------------------------------------------------------------- #
def _texto(valor: object, campo: str, minimo: int, maximo: int, error=CasoInvalido) -> str:  # noqa: ANN001
    limpio = str(valor or "").strip()
    if not minimo <= len(limpio) <= maximo:
        raise error(details={"field": campo, "min": minimo, "max": maximo})
    return limpio


async def _caso_de(db: AsyncSession, reserva_id: str) -> ServiceIncident | None:
    return await db.scalar(
        select(ServiceIncident).where(ServiceIncident.booking_id == reserva_id)
        .execution_options(populate_existing=True)
    )


async def _avisar_del_caso(db: AsyncSession, c: atencion.Contexto, evento_id: str, *, a_cliente: str,
                           a_prestador: str) -> None:
    """A LA OTRA PARTE (nunca a quien acaba de actuar)."""
    if c.rol != CLIENTE:
        await atencion.avisar(db, c.reserva.client_id, a_cliente, c.reserva.id, evento_id)
    if c.rol != PRESTADOR and c.prestador is not None:
        await atencion.avisar(db, c.prestador.profile_id, a_prestador, c.reserva.id, evento_id)


async def _avisar_al_equipo(db: AsyncSession, c: atencion.Contexto, tipo: str, caso: ServiceIncident,
                            evento_id: str) -> None:
    await avisos.avisar_al_equipo(
        db, tipo=tipo, solicitud_id=caso.id, suceso_id=evento_id, excepto={c.usuario_id},
        entidad=avisos.ENTIDAD_CASO,
    )


@reserva_dominio.sin_esperas_largas
async def abrir_caso(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, motivo: str, descripcion: str,
    clave: str | None, ahora: datetime | None = None,
) -> ServiceIncident:
    """Abre EL caso de una reserva. Un motivo de la lista de esa parte y una
    descripción. Dentro del plazo, salvo los de seguridad, que se admiten
    siempre. Mientras esté vivo, la atención no se cierra sola."""
    if motivo not in MOTIVOS_DE.get(rol, ()):
        raise CasoInvalido(details={"field": "reason"})
    descripcion = _texto(descripcion, "description", *limites.DESCRIPCION_DEL_CASO)
    huella = reserva_dominio._huella({"reason": motivo, "description": descripcion})
    c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                             accion=CASO_ABIERTO, huella=huella, ahora=ahora)
    caso = await _caso_de(db, c.reserva.id)
    if c.previo is not None and caso is not None:
        return caso
    if caso is not None:
        raise CasoYaExiste(details={"incident_id": caso.id})
    if c.reserva.status != RESERVA_CONFIRMADA or c.ahora < _utc(c.reserva.starts_at):
        raise atencion.AccionNoDisponible(details={"action": atencion.ABRIR_CASO})
    p = atencion.plazos(c.reserva, await db.get(ServiceAttendance, c.reserva.id), None, c.politica)
    if motivo != MOTIVO_DE_SEGURIDAD and c.ahora > p.caso_hasta:
        raise PlazoDelCasoVencido(details={"until": p.caso_hasta.isoformat()})
    caso = ServiceIncident(
        booking_id=c.reserva.id, opened_by=usuario_id, reason=motivo, description=descripcion,
        status=CASO_EN_CURSO, resolutions=0, created_at=c.ahora, updated_at=c.ahora,
    )
    db.add(caso)
    await db.flush()
    evento = await atencion.anotar(db, c, CASO_ABIERTO, desde=None, hasta=CASO_EN_CURSO,
                                   detalles={"incident_id": caso.id, "reason": motivo, "request_sha256": huella})
    await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_ABIERTO_A_QUIEN_CONTRATA,
                           a_prestador=avisos.CASO_ABIERTO_AL_PRESTADOR)
    await _avisar_al_equipo(db, c, avisos.CASO_ABIERTO_AL_EQUIPO, caso, evento.id)
    return caso


# --------------------------------------------------------------------------- #
# El expediente: mensajes y evidencias
# --------------------------------------------------------------------------- #
async def _entrada_previa(db: AsyncSession, previo: ServiceBookingEvent) -> ServiceIncidentEntry | None:
    return await db.get(ServiceIncidentEntry, (previo.details or {}).get("entry_id") or "")


def _exigir_vivo(caso: ServiceIncident | None) -> ServiceIncident:
    if caso is None:
        raise CasoNoEncontrado()
    if caso.status not in CASOS_VIVOS:
        raise CasoNoAdmiteEso(details={"status": caso.status})
    return caso


@reserva_dominio.sin_esperas_largas
async def escribir(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, texto: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceIncidentEntry:
    """Un mensaje al expediente, de una de las partes. Mientras el caso viva."""
    texto = _texto(texto, "body", 1, limites.ENTRADA_MAXIMA)
    huella = reserva_dominio._huella({"body": texto})
    c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                             accion=CASO_CON_ENTRADA, huella=huella, ahora=ahora)
    if c.previo is not None:
        entrada = await _entrada_previa(db, c.previo)
        if entrada is not None:
            return entrada
    caso = _exigir_vivo(await _caso_de(db, c.reserva.id))
    entrada = ServiceIncidentEntry(incident_id=caso.id, author_id=usuario_id, author_role=rol, kind=MENSAJE,
                                   body=texto, created_at=c.ahora)
    db.add(entrada)
    await db.flush()
    evento = await atencion.anotar(db, c, CASO_CON_ENTRADA, desde=caso.status, hasta=caso.status,
                                   detalles={"entry_id": entrada.id, "kind": MENSAJE, "request_sha256": huella})
    await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_NOVEDAD_A_QUIEN_CONTRATA,
                           a_prestador=avisos.CASO_NOVEDAD_AL_PRESTADOR)
    return entrada


async def _guardar_archivo(ruta: str, datos: bytes, tipo: str) -> None:
    import httpx

    from app.shared import storage

    try:
        await storage.subir_objeto(DEPOSITO, ruta, datos, tipo)
    except storage.StorageNoConfigurado:
        raise AlmacenNoConfigurado() from None
    except (storage.StorageFallo, httpx.HTTPError):
        raise EvidenciaNoDisponible() from None


async def borrar_archivo(ruta: str | None) -> None:
    """Sin romper nada: lo que no se pudo borrar lo barre la baja de la cuenta
    (mismo prefijo)."""
    if not ruta:
        return
    from app.shared import storage

    try:
        await storage.borrar_objeto(DEPOSITO, ruta)
    except Exception:  # noqa: BLE001
        pass


async def _evidencias(db: AsyncSession, caso_id: str) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(ServiceIncidentEntry)
            .where(ServiceIncidentEntry.incident_id == caso_id, ServiceIncidentEntry.kind == EVIDENCIA)
        ) or 0
    )


@dataclass
class Subida:
    entrada: ServiceIncidentEntry
    nueva: bool
    #: Un archivo que se subió y al final no se usó: se borra TRAS confirmar.
    sobrante: str | None = None


async def subir_evidencia(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, datos: bytes, declarado: str | None,
    clave: str | None, ahora: datetime | None = None,
) -> Subida:
    """Una evidencia al expediente: PDF o foto, validada por sus BYTES, en el
    depósito privado y con una ruta que genera el servidor.

    EL ARCHIVO SE SUBE ANTES DE BLOQUEAR NADA (una subida lenta no deja a
    nadie esperando) y la fila se escribe después, con la reserva en fila. Si
    la fila no se puede escribir, el archivo se borra: sin su fila no es de
    nadie. El mismo archivo dos veces en un caso es el mismo."""
    clave = reserva_dominio._exigir_clave(clave)
    reserva, _ = await atencion.reserva_de(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol)
    caso = _exigir_vivo(await _caso_de(db, reserva.id))
    contenido, extension = documentos.detectar(datos, declarado)
    suma = hashlib.sha256(datos).hexdigest()
    if await _evidencias(db, caso.id) >= limites.EVIDENCIAS_POR_CASO:
        raise DemasiadasEvidencias(details={"max": limites.EVIDENCIAS_POR_CASO})
    ruta = f"{usuario_id}/{caso.id}/{uuid.uuid4()}.{extension}"
    await _guardar_archivo(ruta, datos, contenido)
    try:
        c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                                 accion=CASO_CON_ENTRADA, huella=suma, ahora=ahora)
        if c.previo is not None:
            entrada = await _entrada_previa(db, c.previo)
            if entrada is not None:
                return Subida(entrada, False, ruta)
        caso = _exigir_vivo(await _caso_de(db, c.reserva.id))
        repetida = await db.scalar(
            select(ServiceIncidentEntry).where(ServiceIncidentEntry.incident_id == caso.id,
                                               ServiceIncidentEntry.sha256 == suma)
        )
        if repetida is not None:
            return Subida(repetida, False, ruta)
        if await _evidencias(db, caso.id) >= limites.EVIDENCIAS_POR_CASO:
            raise DemasiadasEvidencias(details={"max": limites.EVIDENCIAS_POR_CASO})
        entrada = ServiceIncidentEntry(
            incident_id=caso.id, author_id=usuario_id, author_role=rol, kind=EVIDENCIA, storage_path=ruta,
            content_type=contenido, byte_size=len(datos), sha256=suma, created_at=c.ahora,
        )
        db.add(entrada)
        await db.flush()
        evento = await atencion.anotar(db, c, CASO_CON_ENTRADA, desde=caso.status, hasta=caso.status,
                                       detalles={"entry_id": entrada.id, "kind": EVIDENCIA, "request_sha256": suma})
        await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_NOVEDAD_A_QUIEN_CONTRATA,
                               a_prestador=avisos.CASO_NOVEDAD_AL_PRESTADOR)
        return Subida(entrada, True)
    except BaseException:
        await borrar_archivo(ruta)
        raise


async def enlace_de(entrada: ServiceIncidentEntry) -> str:
    """Un enlace para MIRAR la evidencia AHORA. Nunca se guarda ni se lista."""
    import httpx

    from app.shared import storage

    if entrada.kind != EVIDENCIA or not entrada.storage_path:
        raise CasoNoEncontrado()
    try:
        firmadas = await storage.firmar_objetos(DEPOSITO, [entrada.storage_path], segundos=SEGUNDOS_DE_LA_FIRMA)
    except storage.StorageNoConfigurado:
        raise AlmacenNoConfigurado() from None
    except (storage.StorageFallo, httpx.HTTPError):
        raise EvidenciaNoDisponible() from None
    enlace = firmadas.get(entrada.storage_path)
    if not enlace:
        raise EvidenciaNoDisponible()
    return enlace


# --------------------------------------------------------------------------- #
# Retirar y apelar
# --------------------------------------------------------------------------- #
@reserva_dominio.sin_esperas_largas
async def retirar(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceIncident:
    """Quien abrió el caso lo retira, mientras nadie lo haya resuelto."""
    c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                             accion=CASO_RETIRADO_EVENTO, ahora=ahora)
    caso = await _caso_de(db, c.reserva.id)
    if caso is None:
        raise CasoNoEncontrado()
    if c.previo is not None:
        return caso
    if caso.status != CASO_EN_CURSO or caso.opened_by != usuario_id:
        raise CasoNoAdmiteEso(details={"status": caso.status})
    caso.status = CASO_RETIRADO
    caso.updated_at = c.ahora
    await db.flush()
    evento = await atencion.anotar(db, c, CASO_RETIRADO_EVENTO, desde=CASO_EN_CURSO, hasta=CASO_RETIRADO,
                                   detalles={"incident_id": caso.id})
    await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_NOVEDAD_A_QUIEN_CONTRATA,
                           a_prestador=avisos.CASO_NOVEDAD_AL_PRESTADOR)
    return caso


@reserva_dominio.sin_esperas_largas
async def apelar(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, texto: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceIncident:
    """UNA apelación por caso, de cualquiera de las partes, dentro de su plazo
    y con lo que la justifica. La resolverá OTRA persona."""
    texto = _texto(texto, "body", limites.DESCRIPCION_DEL_CASO[0], limites.ENTRADA_MAXIMA)
    huella = reserva_dominio._huella({"body": texto})
    c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                             accion=CASO_APELADO_EVENTO, huella=huella, ahora=ahora)
    caso = await _caso_de(db, c.reserva.id)
    if caso is None:
        raise CasoNoEncontrado()
    if c.previo is not None:
        return caso
    limite = _utc(caso.resolved_at) + timedelta(days=c.politica.apelacion_dias) if caso.resolved_at else None
    if caso.status != CASO_RESUELTO or caso.resolutions != 1 or limite is None or c.ahora > limite:
        raise ApelacionNoPermitida(details={"status": caso.status})
    caso.status = CASO_APELADO
    caso.appealed_by = rol
    caso.appealed_at = c.ahora
    caso.updated_at = c.ahora
    db.add(ServiceIncidentEntry(incident_id=caso.id, author_id=usuario_id, author_role=rol, kind=APELACION,
                                body=texto, created_at=c.ahora))
    await db.flush()
    evento = await atencion.anotar(db, c, CASO_APELADO_EVENTO, desde=CASO_RESUELTO, hasta=CASO_APELADO,
                                   detalles={"incident_id": caso.id, "request_sha256": huella})
    await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_NOVEDAD_A_QUIEN_CONTRATA,
                           a_prestador=avisos.CASO_NOVEDAD_AL_PRESTADOR)
    await _avisar_al_equipo(db, c, avisos.CASO_APELADO_AL_EQUIPO, caso, evento.id)
    return caso


# --------------------------------------------------------------------------- #
# Leer el expediente
# --------------------------------------------------------------------------- #
@dataclass
class Expediente:
    caso: ServiceIncident
    reserva: ServiceBooking
    entradas: list[ServiceIncidentEntry]
    rol: str
    acciones: list[str] = field(default_factory=list)
    efecto_bloqueado_por: str | None = None


async def _entradas(db: AsyncSession, caso_id: str, *, con_notas: bool) -> list[ServiceIncidentEntry]:
    consulta = select(ServiceIncidentEntry).where(ServiceIncidentEntry.incident_id == caso_id)
    if not con_notas:
        # LAS NOTAS INTERNAS NO SALEN DE ADMINISTRACIÓN. Nunca.
        consulta = consulta.where(ServiceIncidentEntry.kind != NOTA_INTERNA)
    return list(await db.scalars(consulta.order_by(ServiceIncidentEntry.created_at, ServiceIncidentEntry.id)))


async def expediente(db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str) -> Expediente:
    """El caso de una reserva PROPIA, sin las notas internas. Lo ajeno, 404."""
    reserva, prestador = await atencion.reserva_de(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol)
    caso = await _caso_de(db, reserva.id)
    if caso is None:
        raise CasoNoEncontrado()
    cuidado = await atencion.cuidado(db, reserva, rol=rol, usuario_id=usuario_id, prestador=prestador)
    return Expediente(caso, reserva, await _entradas(db, caso.id, con_notas=False), rol,
                      [a for a in cuidado.acciones if "incident" in a])


async def entrada_de(db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, entrada_id: str
                     ) -> ServiceIncidentEntry:
    """Una entrada del expediente de una reserva PROPIA (para firmar su
    evidencia). Una nota interna, para las partes, no existe."""
    reserva, _ = await atencion.reserva_de(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol)
    caso = await _caso_de(db, reserva.id)
    entrada = await db.get(ServiceIncidentEntry, entrada_id) if _es_uuid(entrada_id) else None
    if caso is None or entrada is None or entrada.incident_id != caso.id or entrada.kind == NOTA_INTERNA:
        raise CasoNoEncontrado()
    return entrada


# --------------------------------------------------------------------------- #
# Administración: la bandeja, el expediente entero y la resolución
# --------------------------------------------------------------------------- #
@dataclass
class PaginaDeCasos:
    casos: list[tuple[ServiceIncident, ServiceBooking]]
    siguiente: str | None


def _cursor(momento: datetime, ident: str) -> str:
    return f"{_utc(momento).isoformat()}|{ident}"


def _leer_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    if not cursor:
        return None
    try:
        momento, ident = cursor.split("|", 1)
        instante = datetime.fromisoformat(momento)
    except ValueError:
        raise CursorInvalido() from None
    if instante.tzinfo is None or not _es_uuid(ident):
        raise CursorInvalido()
    return instante, ident


async def casos(
    db: AsyncSession, *, estado: str | None, con_efecto: bool, cursor: str | None, limite: int
) -> PaginaDeCasos:
    """La bandeja de casos, del más reciente al más antiguo. `con_efecto`:
    solo los que tienen un efecto económico SOLICITADO (la vista de «efectos
    financieros pendientes»: de lectura, aquí no se ejecuta nada)."""
    if estado is not None and estado not in ESTADOS_DE_CASO:
        raise CasoInvalido(details={"field": "status"})
    limite = max(1, min(int(limite), limites.RESERVAS_MAXIMAS_POR_PAGINA))
    consulta = select(ServiceIncident, ServiceBooking).join(ServiceBooking, ServiceBooking.id == ServiceIncident.booking_id)
    if estado is not None:
        consulta = consulta.where(ServiceIncident.status == estado)
    if con_efecto:
        consulta = consulta.where(ServiceIncident.financial_effect.is_not(None),
                                  ServiceIncident.financial_effect != SIN_EFECTO)
    punto = _leer_cursor(cursor)
    if punto:
        consulta = consulta.where(
            or_(ServiceIncident.created_at < punto[0],
                and_(ServiceIncident.created_at == punto[0], ServiceIncident.id < punto[1]))
        )
    filas = (await db.execute(
        consulta.order_by(ServiceIncident.created_at.desc(), ServiceIncident.id.desc()).limit(limite + 1)
    )).all()
    siguiente = _cursor(filas[limite - 1][0].created_at, filas[limite - 1][0].id) if len(filas) > limite else None
    return PaginaDeCasos([(f[0], f[1]) for f in filas[:limite]], siguiente)


async def _caso_por_id(db: AsyncSession, caso_id: str) -> tuple[ServiceIncident, ServiceBooking]:
    caso = await db.get(ServiceIncident, caso_id) if _es_uuid(caso_id) else None
    reserva = await db.get(ServiceBooking, caso.booking_id) if caso is not None else None
    if caso is None or reserva is None:
        raise CasoNoEncontrado()
    return caso, reserva


async def expediente_para_administrar(db: AsyncSession, caso_id: str) -> Expediente:
    """El expediente ENTERO, con las notas internas. Solo administración."""
    caso, reserva = await _caso_por_id(db, caso_id)
    return Expediente(caso, reserva, await _entradas(db, caso.id, con_notas=True), ADMINISTRACION)


async def _abrir_de_administracion(
    db: AsyncSession, *, admin_id: str, caso_id: str, clave: str | None, accion: str, huella: str,
    ahora: datetime | None,
) -> tuple[atencion.Contexto, ServiceIncident]:
    """Lo común de administración sobre un caso: la reserva en fila, la clave
    y que quien decide NO SEA PARTE."""
    caso, reserva = await _caso_por_id(db, caso_id)
    c = await atencion.abrir(db, usuario_id=admin_id, reserva_id=reserva.id, rol=ADMINISTRACION, clave=clave,
                             accion=accion, huella=huella, ahora=ahora)
    if admin_id == c.reserva.client_id or (c.prestador is not None and c.prestador.profile_id == admin_id):
        raise ResolutorEnConflicto(details={"reason": "party"})
    caso = await _caso_de(db, c.reserva.id)
    if caso is None:  # pragma: no cover - un caso no se borra suelto
        raise CasoNoEncontrado()
    return c, caso


@reserva_dominio.sin_esperas_largas
async def anotar_desde_administracion(
    db: AsyncSession, *, admin_id: str, caso_id: str, texto: str, interna: bool, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceIncidentEntry:
    """Un mensaje de administración a las partes (una petición de información,
    por ejemplo) o una NOTA INTERNA, que no sale de administración."""
    texto = _texto(texto, "body", 1, limites.ENTRADA_MAXIMA)
    huella = reserva_dominio._huella({"body": texto, "internal": interna})
    c, caso = await _abrir_de_administracion(db, admin_id=admin_id, caso_id=caso_id, clave=clave,
                                             accion=CASO_CON_ENTRADA, huella=huella, ahora=ahora)
    if c.previo is not None:
        entrada = await _entrada_previa(db, c.previo)
        if entrada is not None:
            return entrada
    tipo = NOTA_INTERNA if interna else MENSAJE
    if not interna:
        _exigir_vivo(caso)
    entrada = ServiceIncidentEntry(incident_id=caso.id, author_id=admin_id, author_role=ADMINISTRACION, kind=tipo,
                                   body=texto, created_at=c.ahora)
    db.add(entrada)
    await db.flush()
    evento = await atencion.anotar(db, c, CASO_CON_ENTRADA, desde=caso.status, hasta=caso.status,
                                   detalles={"entry_id": entrada.id, "kind": tipo, "request_sha256": huella})
    if not interna:
        await _avisar_del_caso(db, c, evento.id, a_cliente=avisos.CASO_NOVEDAD_A_QUIEN_CONTRATA,
                               a_prestador=avisos.CASO_NOVEDAD_AL_PRESTADOR)
    return entrada


async def _aplicar_a_la_atencion(db: AsyncSession, c: atencion.Contexto, efecto: str) -> bool:
    """El efecto de la resolución sobre la atención. Devuelve si quedó CERRADA
    (verificada) por esta decisión. Una atención ya cerrada no se desmiente."""
    if efecto == "none":
        return False
    actual = await db.get(ServiceAttendance, c.reserva.id, populate_existing=True)
    if actual is not None and actual.status == CERRADA:
        if efecto == "completed":
            return False
        raise EfectoNoPermitido(details={"attention": CERRADA})
    nueva = actual is None
    if nueva:
        actual = ServiceAttendance(booking_id=c.reserva.id, checkin_attempts=0, started_with_code=False,
                                   created_at=c.ahora)
    if efecto == "completed":
        atencion.cerrar(actual, por=ADMINISTRACION, ahora=c.ahora)
    else:
        actual.status = AUSENTE_EL_PRESTADOR if efecto == "provider_no_show" else AUSENTE_EL_CLIENTE
        actual.no_show_reported_at = actual.no_show_reported_at or c.ahora
        actual.updated_at = c.ahora
    if nueva:
        db.add(actual)
    await db.flush()
    return efecto == "completed"


@reserva_dominio.sin_esperas_largas
async def resolver(
    db: AsyncSession, *, admin_id: str, caso_id: str, resultado: str, texto: str, efecto_en_la_atencion: str,
    efecto_economico: str, nota_interna: str | None, clave: str | None, ahora: datetime | None = None,
) -> ServiceIncident:
    """LA RESOLUCIÓN. Dice, por separado: qué se decidió y por qué, su efecto
    en la atención y el efecto económico SOLICITADO, con su estado. Un caso
    abierto queda resuelto (y se puede apelar); uno apelado queda cerrado, y
    lo resuelve una persona DISTINTA de la primera.

    NO MUEVE DINERO: el estado del efecto lo decide `estado_del_efecto` y
    nunca es «ejecutado»."""
    if resultado not in RESULTADOS:
        raise CasoInvalido(details={"field": "outcome"})
    if efecto_en_la_atencion not in EFECTOS_EN_LA_ATENCION:
        raise CasoInvalido(details={"field": "attention_effect"})
    if efecto_economico not in EFECTOS_ECONOMICOS:
        raise CasoInvalido(details={"field": "financial_effect"})
    texto = _texto(texto, "resolution", 1, limites.ENTRADA_MAXIMA)
    nota = (nota_interna or "").strip() or None
    if nota is not None and len(nota) > limites.ENTRADA_MAXIMA:
        raise CasoInvalido(details={"field": "internal_note", "max": limites.ENTRADA_MAXIMA})
    huella = reserva_dominio._huella({
        "outcome": resultado, "resolution": texto, "attention_effect": efecto_en_la_atencion,
        "financial_effect": efecto_economico, "internal_note": nota,
    })
    c, caso = await _abrir_de_administracion(db, admin_id=admin_id, caso_id=caso_id, clave=clave,
                                             accion=CASO_RESUELTO_EVENTO, huella=huella, ahora=ahora)
    if c.previo is not None:
        return caso
    if caso.status not in CASOS_VIVOS:
        raise CasoNoAdmiteEso(details={"status": caso.status})
    if caso.status == CASO_APELADO and caso.resolved_by == admin_id:
        raise ResolutorEnConflicto(details={"reason": "appeal"})
    desde = caso.status
    cerrada = await _aplicar_a_la_atencion(db, c, efecto_en_la_atencion)
    pedido = await db.get(ServiceOrder, c.reserva.order_id)
    caso.status = CASO_RESUELTO if desde == CASO_EN_CURSO else CASO_CERRADO
    caso.outcome = resultado
    caso.attention_effect = efecto_en_la_atencion
    caso.financial_effect = efecto_economico
    caso.financial_effect_status = atencion.estado_del_efecto(pedido, efecto_economico)
    caso.resolved_by = admin_id
    caso.resolved_at = c.ahora
    caso.resolutions = int(caso.resolutions) + 1
    caso.updated_at = c.ahora
    db.add(ServiceIncidentEntry(incident_id=caso.id, author_id=admin_id, author_role=ADMINISTRACION,
                                kind=RESOLUCION, body=texto, created_at=c.ahora))
    if nota is not None:
        db.add(ServiceIncidentEntry(incident_id=caso.id, author_id=admin_id, author_role=ADMINISTRACION,
                                    kind=NOTA_INTERNA, body=nota, created_at=c.ahora))
    await db.flush()
    evento = await atencion.anotar(
        db, c, CASO_RESUELTO_EVENTO, desde=desde, hasta=caso.status,
        detalles={"incident_id": caso.id, "outcome": resultado, "attention_effect": efecto_en_la_atencion,
                  "financial_effect": efecto_economico, "financial_effect_status": caso.financial_effect_status,
                  "request_sha256": huella},
    )
    await atencion.avisar(db, c.reserva.client_id, avisos.CASO_RESUELTO_A_QUIEN_CONTRATA, c.reserva.id, evento.id)
    if c.prestador is not None:
        await atencion.avisar(db, c.prestador.profile_id, avisos.CASO_RESUELTO_AL_PRESTADOR, c.reserva.id, evento.id)
    if cerrada:
        cierre = await reserva_dominio._anotar(
            db, servicio_id=c.reserva.service_id, accion=ATENCION_CERRADA_EVENTO, desde=None, hasta=CERRADA,
            ahora=c.ahora, reserva_id=c.reserva.id, actor_id=admin_id, rol=ADMINISTRACION,
        )
        await atencion.avisar(db, c.reserva.client_id, avisos.RESENA_DISPONIBLE, c.reserva.id, cierre.id)
    return caso


# --------------------------------------------------------------------------- #
# La reseña verificada
# --------------------------------------------------------------------------- #
def _estrellas(valor: object, campo: str, *, obligatoria: bool) -> int | None:
    if valor is None and not obligatoria:
        return None
    if isinstance(valor, bool) or not isinstance(valor, int) or not 1 <= valor <= 5:
        raise ResenaInvalida(details={"field": campo})
    return valor


async def _resena_de(db: AsyncSession, reserva_id: str) -> ServiceReview | None:
    return await db.scalar(
        select(ServiceReview).where(ServiceReview.booking_id == reserva_id).execution_options(populate_existing=True)
    )


@reserva_dominio.sin_esperas_largas
async def resenar(
    db: AsyncSession, *, cliente_id: str, reserva_id: str, datos: dict, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceReview:
    """La reseña de una atención CERRADA, de quien la contrató, una por
    reserva y dentro de su plazo. Nace publicada o a la espera de moderación,
    según la política (provisional)."""
    calificacion = _estrellas(datos.get("rating"), "rating", obligatoria=True)
    ejes = {eje: _estrellas(datos.get(eje), eje, obligatoria=False) for eje in EJES_DE_RESENA}
    if not isinstance(datos.get("recommends"), bool):
        raise ResenaInvalida(details={"field": "recommends"})
    comentario = _texto(datos.get("comment"), "comment", *limites.COMENTARIO_DE_RESENA, error=ResenaInvalida)
    contenido = {"rating": calificacion, **ejes, "recommends": datos["recommends"], "comment": comentario}
    huella = reserva_dominio._huella(contenido)
    c = await atencion.abrir(db, usuario_id=cliente_id, reserva_id=reserva_id, rol=CLIENTE, clave=clave,
                             accion=RESENA_CREADA, huella=huella, ahora=ahora)
    resena = await _resena_de(db, c.reserva.id)
    if c.previo is not None and resena is not None:
        return resena
    if resena is not None:
        raise ResenaYaExiste()
    actual = await db.get(ServiceAttendance, c.reserva.id, populate_existing=True)
    p = atencion.plazos(c.reserva, actual, None, c.politica)
    if (
        c.reserva.status != RESERVA_CONFIRMADA or actual is None or actual.status != CERRADA
        or p.resena_hasta is None or c.ahora > p.resena_hasta
    ):
        raise ResenaNoPermitida()
    resena = ServiceReview(
        booking_id=c.reserva.id, service_id=c.reserva.service_id, author_id=cliente_id, **contenido,
        status=RESENA_PENDIENTE if c.politica.resena_con_moderacion_previa else RESENA_PUBLICADA,
        created_at=c.ahora, updated_at=c.ahora,
    )
    db.add(resena)
    await db.flush()
    evento = await atencion.anotar(db, c, RESENA_CREADA, desde=None, hasta=resena.status,
                                   detalles={"review_id": resena.id, "request_sha256": huella})
    if resena.status == RESENA_PUBLICADA and c.prestador is not None:
        await atencion.avisar(db, c.prestador.profile_id, avisos.RESENA_RECIBIDA, c.reserva.id, evento.id)
    return resena


@reserva_dominio.sin_esperas_largas
async def responder_resena(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, texto: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceReview:
    """La respuesta PÚBLICA del prestador a una reseña publicada de un
    servicio suyo. Una, y no se reescribe."""
    texto = _texto(texto, "reply", 1, limites.RESPUESTA_MAXIMA, error=ResenaInvalida)
    huella = reserva_dominio._huella({"reply": texto})
    c = await atencion.abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=PRESTADOR, clave=clave,
                             accion=RESENA_RESPONDIDA, huella=huella, ahora=ahora)
    resena = await _resena_de(db, c.reserva.id)
    if resena is None or resena.status != RESENA_PUBLICADA:
        raise ResenaNoEncontrada()
    if c.previo is not None:
        return resena
    if resena.reply is not None:
        raise ResenaYaRespondida()
    resena.reply = texto
    resena.replied_at = c.ahora
    resena.updated_at = c.ahora
    await db.flush()
    evento = await atencion.anotar(db, c, RESENA_RESPONDIDA, desde=resena.status, hasta=resena.status,
                                   detalles={"review_id": resena.id, "request_sha256": huella})
    await atencion.avisar(db, c.reserva.client_id, avisos.RESENA_RESPONDIDA, c.reserva.id, evento.id)
    return resena


@reserva_dominio.sin_esperas_largas
async def moderar(
    db: AsyncSession, *, admin_id: str, resena_id: str, accion: str, motivo: str | None, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceReview:
    """Administración PUBLICA o ESCONDE una reseña. No la borra ni la reescribe,
    y esconderla exige un motivo de la lista. Queda en el historial. Quien es
    parte de esa reserva no la modera. NO MUEVE DINERO."""
    if accion not in (PUBLICAR, ESCONDER):
        raise ResenaInvalida(details={"field": "action"})
    motivo = (motivo or "").strip() or None
    if accion == ESCONDER and motivo not in MOTIVOS_DE_MODERACION:
        raise ResenaInvalida(details={"field": "reason"})
    resena = await db.get(ServiceReview, resena_id) if _es_uuid(resena_id) else None
    if resena is None:
        raise ResenaNoEncontrada()
    huella = reserva_dominio._huella({"review_id": resena.id, "action": accion, "reason": motivo})
    c = await atencion.abrir(db, usuario_id=admin_id, reserva_id=resena.booking_id, rol=ADMINISTRACION, clave=clave,
                             accion=RESENA_MODERADA, huella=huella, ahora=ahora)
    if admin_id == c.reserva.client_id or (c.prestador is not None and c.prestador.profile_id == admin_id):
        raise ResolutorEnConflicto(details={"reason": "party"})
    resena = await _resena_de(db, c.reserva.id)
    if resena is None:  # pragma: no cover - una reseña no se borra suelta
        raise ResenaNoEncontrada()
    if c.previo is not None:
        return resena
    hasta = RESENA_PUBLICADA if accion == PUBLICAR else RESENA_ESCONDIDA
    if resena.status == hasta:
        raise ModeracionNoPermitida(details={"status": resena.status})
    desde = resena.status
    resena.status = hasta
    resena.updated_at = c.ahora
    await db.flush()
    evento = await atencion.anotar(db, c, RESENA_MODERADA, desde=desde, hasta=hasta,
                                   detalles={"review_id": resena.id, "action": accion, "reason": motivo,
                                             "request_sha256": huella})
    # La primera vez que se ve, el prestador se entera.
    if hasta == RESENA_PUBLICADA and desde == RESENA_PENDIENTE and c.prestador is not None:
        await atencion.avisar(db, c.prestador.profile_id, avisos.RESENA_RECIBIDA, c.reserva.id, evento.id)
    return resena


# --------------------------------------------------------------------------- #
# Leer reseñas: lo público y la bandeja de administración
# --------------------------------------------------------------------------- #
@dataclass
class ResumenDeResenas:
    """Lo que enseña la ficha. Sin reseñas, el promedio es NULO, no cero."""

    total: int
    promedio: float | None
    recomiendan_bps: int | None
    por_eje: dict[str, float | None]


@dataclass
class PaginaDeResenas:
    resenas: list[ServiceReview]
    siguiente: str | None
    resumen: ResumenDeResenas | None = None


async def _pagina_de_resenas(db: AsyncSession, filtro, *, cursor: str | None, limite: int) -> PaginaDeResenas:  # noqa: ANN001
    limite = max(1, min(int(limite), limites.RESERVAS_MAXIMAS_POR_PAGINA))
    consulta = select(ServiceReview).where(filtro)
    punto = _leer_cursor(cursor)
    if punto:
        consulta = consulta.where(
            or_(ServiceReview.created_at < punto[0],
                and_(ServiceReview.created_at == punto[0], ServiceReview.id < punto[1]))
        )
    filas = list(await db.scalars(
        consulta.order_by(ServiceReview.created_at.desc(), ServiceReview.id.desc()).limit(limite + 1)
    ))
    siguiente = _cursor(filas[limite - 1].created_at, filas[limite - 1].id) if len(filas) > limite else None
    return PaginaDeResenas(filas[:limite], siguiente)


async def resumen_de(db: AsyncSession, servicio_id: str) -> ResumenDeResenas:
    """El agregado PÚBLICO de un servicio: solo las publicadas."""
    publicadas = and_(ServiceReview.service_id == servicio_id, ServiceReview.status == RESENA_PUBLICADA)
    fila = (await db.execute(
        select(
            func.count(), func.avg(ServiceReview.rating),
            func.sum(case((ServiceReview.recommends.is_(True), 1), else_=0)),
            *[func.avg(getattr(ServiceReview, eje)) for eje in EJES_DE_RESENA],
        ).where(publicadas)
    )).one()
    total = int(fila[0] or 0)
    if total == 0:
        return ResumenDeResenas(0, None, None, {eje: None for eje in EJES_DE_RESENA})
    return ResumenDeResenas(
        total=total,
        promedio=round(float(fila[1]), 2),
        recomiendan_bps=round(int(fila[2] or 0) * 10000 / total),
        por_eje={eje: (round(float(v), 2) if v is not None else None) for eje, v in zip(EJES_DE_RESENA, fila[3:])},
    )


async def resenas_visibles(
    db: AsyncSession, *, servicio_id: str | None = None, prestador_id: str | None = None
) -> tuple[int, float | None]:
    """`(cuántas, promedio)` de las reseñas PUBLICADAS de un servicio, o de
    todos los de un prestador: lo que dicen la ficha y el perfil públicos. Sin
    la 0094 o con la contratación apagada, ninguna; y sin ninguna, el promedio
    es NULO, nunca un 0 que parezca una nota."""
    from app.modules.services import esquema
    from app.modules.services.catalogo_models import Service

    if not esquema.reserva_encendida() or not await esquema.hay_atencion(db):
        return 0, None
    consulta = select(func.count(), func.avg(ServiceReview.rating)).where(ServiceReview.status == RESENA_PUBLICADA)
    if servicio_id is not None:
        consulta = consulta.where(ServiceReview.service_id == servicio_id)
    else:
        consulta = consulta.join(Service, Service.id == ServiceReview.service_id).where(
            Service.provider_id == prestador_id
        )
    total, promedio = (await db.execute(consulta)).one()
    return (int(total), round(float(promedio), 2)) if total else (0, None)


async def resenas_publicas(db: AsyncSession, servicio_id: str, *, mira: str | None, cursor: str | None, limite: int
                           ) -> PaginaDeResenas:
    """Las reseñas PUBLICADAS de un servicio público, con su resumen. Un
    servicio que no es público para quien mira, 404 como siempre."""
    try:
        await descubrimiento.publico(db, servicio_id, mira=mira)
    except descubrimiento.ServicioNoPublico:
        from app.modules.services.catalogo import ServicioNoEncontrado

        raise ServicioNoEncontrado() from None
    pagina = await _pagina_de_resenas(
        db, and_(ServiceReview.service_id == servicio_id, ServiceReview.status == RESENA_PUBLICADA),
        cursor=cursor, limite=limite,
    )
    pagina.resumen = await resumen_de(db, servicio_id)
    return pagina


async def resenas_para_moderar(db: AsyncSession, *, estado: str | None, cursor: str | None, limite: int
                               ) -> PaginaDeResenas:
    if estado is not None and estado not in ESTADOS_DE_RESENA:
        raise ResenaInvalida(details={"field": "status"})
    return await _pagina_de_resenas(
        db, ServiceReview.status == estado if estado is not None else ServiceReview.id.is_not(None),
        cursor=cursor, limite=limite,
    )


__all__ = [
    "AlmacenNoConfigurado",
    "ApelacionNoPermitida",
    "CasoInvalido",
    "CasoNoAdmiteEso",
    "CasoNoEncontrado",
    "CasoYaExiste",
    "DEPOSITO",
    "DemasiadasEvidencias",
    "ESCONDER",
    "EfectoNoPermitido",
    "EvidenciaNoDisponible",
    "Expediente",
    "MOTIVOS_DE",
    "MOTIVOS_DE_MODERACION",
    "ModeracionNoPermitida",
    "PUBLICAR",
    "PaginaDeCasos",
    "PaginaDeResenas",
    "PlazoDelCasoVencido",
    "ResenaInvalida",
    "ResenaNoEncontrada",
    "ResenaNoPermitida",
    "ResenaYaExiste",
    "ResenaYaRespondida",
    "ResolutorEnConflicto",
    "ResumenDeResenas",
    "Subida",
    "abrir_caso",
    "anotar_desde_administracion",
    "apelar",
    "borrar_archivo",
    "casos",
    "enlace_de",
    "entrada_de",
    "escribir",
    "expediente",
    "expediente_para_administrar",
    "moderar",
    "resenar",
    "resenas_para_moderar",
    "resenas_visibles",
    "resenas_publicas",
    "resolver",
    "responder_resena",
    "resumen_de",
    "retirar",
    "subir_evidencia",
]
