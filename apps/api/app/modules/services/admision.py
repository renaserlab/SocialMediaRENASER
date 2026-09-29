"""EL FLUJO DE ADMISIÓN: todas las transiciones de una postulación, en un sitio.

CADA ACCIÓN, EN ESTE ORDEN Y EN UNA SOLA TRANSACCIÓN:

  1. BLOQUEA LA FILA de la postulación (`SELECT … FOR UPDATE`). Dos decisiones
     a la vez no pueden ver el mismo estado: la segunda espera y, al entrar,
     encuentra el nuevo.
  2. REPETICIÓN: si la misma `Idempotency-Key` ya dejó su evento, devuelve lo
     que hay sin escribir nada. Y las acciones de quien postula (enviar,
     reenviar, retirar) son idempotentes también por estado.
  3. NADIE SE ADMITE A SÍ MISMO (antes que el rol), el salto EXISTE y es de
     quien lo pide (`states.exigir`), y los REQUISITOS se cumplen.
  4. ESCRIBE a la vez el estado, el historial (`service_provider_application_
     events`, solo se añade), el envío congelado cuando toca, el estado del
     PRESTADOR (derivado aquí, verificado por la base al confirmar), la
     AUDITORÍA (`gobernanza.auditoria`) y los AVISOS (en savepoints: si fallan,
     la decisión sigue).

LA FUENTE DE VERDAD ES LA POSTULACIÓN. El estado del prestador se deriva con
`estado_del_prestador` y nunca se escribe por otro camino; la 0088 comprueba
al confirmar que los dos coinciden.

NINGUNA TRANSICIÓN POR PATCH: cada salto tiene su función y su ruta.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ForbiddenError, ValidationAppError
from app.modules.services import avisos, credenciales, documentos, politicas, requisitos, states
from app.modules.services.models import (
    ENVIO_INICIAL,
    PRESTADOR_ACTIVO,
    PRESTADOR_PENDIENTE,
    PRESTADOR_SUSPENDIDO,
    REENVIO,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderApplicationSubmission,
)
from app.modules.services.permissions import SolicitudNoEncontrada, exigir_ajena

#: Cómo se llama cada función en `audit_events.actor_role` (0050, que no se
#: amplía): el prestador actúa como usuario sobre lo suyo; revisar es curaduría.
ROL_DE_AUDITORIA = {
    states.PRESTADOR: "user",
    states.REVISOR: "moderator",
    states.ADMINISTRACION: "admin",
    states.SISTEMA: "system",
}


class SolicitudIncompleta(ValidationAppError):
    code = "service_application_incomplete"
    message = "A la postulación todavía le falta información."


class CorreccionesPendientes(ValidationAppError):
    code = "service_application_corrections_pending"
    message = "Todavía falta corregir lo que se pidió."


class RequisitosPendientes(ConflictError):
    code = "service_application_requirements_pending"
    message = "No se puede aprobar: hay evidencia sin revisar o requisitos sin cumplir."


class RepostulacionNoConfigurada(ConflictError):
    code = "service_reapplication_not_configured"
    message = "Todavía no está decidido si se puede volver a postular tras un rechazo."


class RepostulacionNoPermitida(ForbiddenError):
    code = "service_reapplication_not_allowed"
    message = "Las condiciones vigentes no permiten volver a postular tras un rechazo."


class PaisRequerido(ConflictError):
    code = "service_application_country_required"
    message = "Indica primero tu país: las condiciones dependen de él."


class YaDecidida(ConflictError):
    """Retirarse es ANTES de la decisión. Una aprobada que se suspendió y volvió
    a revisión está en `under_review`, pero ya tuvo su decisión: retirarla
    sería salir de la investigación por la puerta de atrás."""

    code = "service_application_already_decided"
    message = "Esta postulación ya tuvo una decisión: no se puede retirar."


@dataclass
class Resultado:
    solicitud: ServiceProviderApplication
    evento: ServiceProviderApplicationEvent | None
    repetido: bool


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _hoy() -> date:
    return _ahora().date()


# --------------------------------------------------------------------------- #
# El estado del prestador: DERIVADO de su postulación
# --------------------------------------------------------------------------- #
def estado_del_prestador(actual: str, estado_de_la_solicitud: str) -> str:
    """El estado que tiene que tener el prestador tras este paso.

    - aprobada   -> `active`
    - suspendida -> `suspended`
    - cualquier otra: `suspended` si YA lo estaba (una suspensión en revisión,
      o rechazada tras investigarla, NO devuelve a nadie a «pendiente» por la
      puerta de atrás); si no, `pending`. Nunca `active`.
    """
    if estado_de_la_solicitud == states.APROBADA:
        return PRESTADOR_ACTIVO
    if estado_de_la_solicitud == states.SUSPENDIDA:
        return PRESTADOR_SUSPENDIDO
    return PRESTADOR_SUSPENDIDO if actual == PRESTADOR_SUSPENDIDO else PRESTADOR_PENDIENTE


def _sincronizar(prestador: ServiceProvider, estado_de_la_solicitud: str, ahora: datetime) -> None:
    nuevo = estado_del_prestador(prestador.status, estado_de_la_solicitud)
    if nuevo == prestador.status:
        return
    prestador.status = nuevo
    if nuevo == PRESTADOR_ACTIVO:
        prestador.activated_at = ahora
    elif nuevo == PRESTADOR_SUSPENDIDO:
        prestador.suspended_at = ahora
    prestador.updated_at = ahora


# --------------------------------------------------------------------------- #
# Piezas comunes
# --------------------------------------------------------------------------- #
async def bloquear(db: AsyncSession, solicitud_id: str) -> ServiceProviderApplication:
    """La fila, BLOQUEADA hasta el final de la transacción (en PostgreSQL)."""
    solicitud = await db.scalar(
        select(ServiceProviderApplication)
        .where(ServiceProviderApplication.id == solicitud_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if solicitud is None:
        raise SolicitudNoEncontrada()
    return solicitud


async def la_mia_bloqueada(db: AsyncSession, usuario_id: str) -> tuple[ServiceProviderApplication, ServiceProvider]:
    """La postulación actual de quien pregunta, bloqueada. 404 si no hay."""
    prestador = await db.scalar(
        select(ServiceProvider).where(ServiceProvider.profile_id == usuario_id)
    )
    if prestador is None:
        raise SolicitudNoEncontrada()
    ident = await db.scalar(
        select(ServiceProviderApplication.id)
        .where(ServiceProviderApplication.provider_id == prestador.id)
        .order_by(
            ServiceProviderApplication.status.in_(tuple(states.FINALES)),
            ServiceProviderApplication.created_at.desc(),
            ServiceProviderApplication.id.desc(),
        )
        .limit(1)
    )
    if ident is None:
        raise SolicitudNoEncontrada()
    return await bloquear(db, ident), prestador


class ClaveReutilizada(ConflictError):
    code = "idempotency_key_reused"
    message = "Esa clave ya se usó para otra acción."


async def _por_clave(
    db: AsyncSession, solicitud_id: str, clave: str | None, hasta: str
) -> ServiceProviderApplicationEvent | None:
    """El evento que ya dejó ESTA clave, si lo hay. Una clave usada para OTRA
    acción no es una repetición: es un error de quien llama."""
    if not clave:
        return None
    previo = await db.scalar(
        select(ServiceProviderApplicationEvent).where(
            ServiceProviderApplicationEvent.application_id == solicitud_id,
            ServiceProviderApplicationEvent.idempotency_key == clave,
        )
    )
    if previo is not None and previo.to_status != hasta:
        raise ClaveReutilizada(details={"to": previo.to_status})
    return previo


def exigir_clave_valida(clave: str | None) -> str | None:
    if clave is None:
        return None
    limpia = clave.strip()
    if not 8 <= len(limpia) <= 100:
        raise ValidationAppError(
            "La clave de idempotencia no es válida.",
            code="idempotency_key_invalid",
        )
    return limpia


async def _evidencia(db: AsyncSession, solicitud: ServiceProviderApplication, prestador: ServiceProvider) -> requisitos.Evidencia:
    return requisitos.Evidencia(
        solicitud=solicitud,
        prestador=prestador,
        documentos=await documentos.de_la_solicitud(db, solicitud.id, solo_activos=False),
        credenciales=await credenciales.de_la_solicitud(db, solicitud.id, solo_activas=False),
    )


async def politica_vigente_para(
    db: AsyncSession, solicitud: ServiceProviderApplication, prestador: ServiceProvider
) -> ServicePolicy | None:
    if not prestador.country_code:
        return None
    return await politicas.vigente(
        db, pais=prestador.country_code, categoria=solicitud.requested_category
    )


async def _registrar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    funcion: str,
    nota_visible: str | None = None,
    nota_interna: str | None = None,
    detalles: dict | None = None,
    clave: str | None = None,
    ahora: datetime,
) -> ServiceProviderApplicationEvent:
    evento = ServiceProviderApplicationEvent(
        application_id=solicitud.id,
        from_status=desde,
        to_status=hasta,
        actor_id=actor_id,
        actor_role=funcion,
        visible_note=nota_visible,
        internal_note=nota_interna,
        details=detalles or {},
        idempotency_key=clave,
        created_at=ahora,
    )
    db.add(evento)
    await db.flush()
    return evento


async def _auditar(
    db: AsyncSession,
    *,
    accion: str,
    solicitud: ServiceProviderApplication,
    actor_id: str | None,
    funcion: str,
    desde: str | None,
    hasta: str | None,
    motivo: str | None = None,
    datos: dict | None = None,
) -> None:
    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        action=accion,
        entity_type=avisos.ENTIDAD,
        entity_id=solicitud.id,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[funcion],
        previous_state=desde,
        new_state=hasta,
        reason=motivo,
        payload=datos or {},
    )


async def auditar(
    db: AsyncSession,
    *,
    accion: str,
    entidad: str,
    entidad_id: str,
    actor_id: str | None,
    funcion: str,
    datos: dict | None = None,
    motivo: str | None = None,
) -> None:
    """El rastro de una acción que no es un salto (documentos, credenciales,
    políticas). Misma auditoría, misma transacción."""
    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        action=accion,
        entity_type=entidad,
        entity_id=entidad_id,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[funcion],
        reason=motivo,
        payload=datos or {},
    )


def _huella_json(datos: dict) -> str:
    texto = json.dumps(datos, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


async def _ultimo_envio(
    db: AsyncSession, solicitud_id: str
) -> ServiceProviderApplicationSubmission | None:
    return await db.scalar(
        select(ServiceProviderApplicationSubmission)
        .where(ServiceProviderApplicationSubmission.application_id == solicitud_id)
        .order_by(ServiceProviderApplicationSubmission.sequence.desc())
        .limit(1)
    )


async def _congelar(
    db: AsyncSession,
    *,
    evidencia: requisitos.Evidencia,
    politica: ServicePolicy,
    tipo: str,
    usuario_id: str,
    ahora: datetime,
) -> ServiceProviderApplicationSubmission:
    """La foto del envío: datos, documentos SIN rutas, credenciales enmascaradas."""
    solicitud = evidencia.solicitud
    secuencia = (
        await db.scalar(
            select(func.max(ServiceProviderApplicationSubmission.sequence)).where(
                ServiceProviderApplicationSubmission.application_id == solicitud.id
            )
        )
        or 0
    ) + 1
    foto = {
        "fields": requisitos.datos_del_borrador(evidencia),
        "documents": [
            {
                "id": d.id,
                "kind": d.kind,
                "content_type": d.content_type,
                "byte_size": d.byte_size,
                "checksum_sha256": d.checksum_sha256,
            }
            for d in evidencia.documentos_activos
        ],
        "credentials": [
            {
                "id": c.id,
                "kind": c.kind,
                "title": c.title,
                "issuer": c.issuer,
                "jurisdiction": c.jurisdiction,
                "number_masked": c.number_masked,
                "specialty": c.specialty,
                "issued_on": c.issued_on.isoformat() if c.issued_on else None,
                "expires_on": c.expires_on.isoformat() if c.expires_on else None,
                "evidence_document_id": c.evidence_document_id,
            }
            for c in evidencia.credenciales_activas
        ],
        "terms": {"policy_id": politica.id, "version": politica.version, "sha256": politica.body_sha256},
    }
    envio = ServiceProviderApplicationSubmission(
        application_id=solicitud.id,
        sequence=secuencia,
        kind=tipo,
        terms_policy_id=politica.id,
        terms_version=politica.version,
        terms_sha256=politica.body_sha256,
        snapshot=foto,
        snapshot_sha256=_huella_json(foto),
        submitted_by=usuario_id,
        created_at=ahora,
    )
    db.add(envio)
    await db.flush()
    return envio


# --------------------------------------------------------------------------- #
# Quien postula
# --------------------------------------------------------------------------- #
async def exigir_que_pueda_repostular(
    db: AsyncSession, *, prestador: ServiceProvider, ultima: ServiceProviderApplication
) -> None:
    """Tras un RECHAZO, volver a postular lo decide la política vigente.

    Sin política, o sin esa decisión escrita en ella, NO se interpreta como sí
    ni como no: se dice que falta decidirlo. Tras una RETIRADA siempre se puede.
    """
    if ultima.status != states.RECHAZADA:
        return
    if not prestador.country_code:
        raise RepostulacionNoConfigurada()
    vigente = await politicas.vigente(db, pais=prestador.country_code)
    decision = ((vigente.parameters if vigente else None) or {}).get(
        "reapplication_after_rejection"
    )
    if decision is None:
        raise RepostulacionNoConfigurada()
    if decision != politicas.REPOSTULAR_PERMITIDO:
        raise RepostulacionNoPermitida()


async def aceptar_terminos(
    db: AsyncSession, *, usuario_id: str, politica_id: str, huella: str
) -> ServiceProviderApplication:
    """Acepta EXPRESAMENTE una versión: la vigente, con su huella exacta."""
    solicitud, prestador = await la_mia_bloqueada(db, usuario_id)
    if not states.es_editable(solicitud.status):
        from app.modules.services.service import SolicitudNoEditable

        raise SolicitudNoEditable(details={"status": solicitud.status})
    if not prestador.country_code:
        raise PaisRequerido()
    vigente = await politica_vigente_para(db, solicitud, prestador)
    if vigente is None:
        raise politicas.TerminosNoPublicados()
    if politica_id != vigente.id or huella != vigente.body_sha256:
        raise politicas.TerminosCambiaron(
            details={"current_policy_id": vigente.id, "current_version": vigente.version}
        )
    ahora = _ahora()
    solicitud.terms_policy_id = vigente.id
    solicitud.terms_sha256 = vigente.body_sha256
    solicitud.terms_accepted_at = ahora
    solicitud.updated_at = ahora
    await db.flush()
    await _auditar(
        db,
        accion="service_application.terms_accepted",
        solicitud=solicitud,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
        desde=solicitud.status,
        hasta=solicitud.status,
        datos={"policy_id": vigente.id, "policy_version": vigente.version},
    )
    return solicitud


async def _enviar_o_reenviar(
    db: AsyncSession, *, usuario_id: str, reenvio: bool, clave: str | None
) -> Resultado:
    solicitud, prestador = await la_mia_bloqueada(db, usuario_id)
    desde_esperado = states.CORRECCIONES_PEDIDAS if reenvio else states.BORRADOR
    hasta = states.REENVIADA if reenvio else states.ENVIADA

    previo = await _por_clave(db, solicitud.id, clave, hasta)
    if previo is not None:
        return Resultado(solicitud, previo, True)
    if solicitud.status == hasta:
        # Un doble toque sin clave: ya está enviada; no se escribe nada más.
        return Resultado(solicitud, None, True)
    states.exigir(solicitud.status, hasta, states.PRESTADOR)

    evidencia = await _evidencia(db, solicitud, prestador)
    vigente = await politica_vigente_para(db, solicitud, prestador)
    faltan = requisitos.para_enviar(
        evidencia, vigente=vigente, hoy=_hoy(), terminos_consultables=bool(prestador.country_code)
    )
    if faltan:
        raise SolicitudIncompleta(details={"missing": faltan})
    if reenvio:
        ultimo = await _ultimo_envio(db, solicitud.id)
        pedido = await db.scalar(
            select(ServiceProviderApplicationEvent)
            .where(
                ServiceProviderApplicationEvent.application_id == solicitud.id,
                ServiceProviderApplicationEvent.to_status == states.CORRECCIONES_PEDIDAS,
            )
            .order_by(ServiceProviderApplicationEvent.created_at.desc())
            .limit(1)
        )
        pendientes = requisitos.correcciones_pendientes(
            evidencia,
            campos_observados=list(((pedido.details if pedido else None) or {}).get("fields", [])),
            ultimo_envio=ultimo.snapshot if ultimo else None,
            hoy=_hoy(),
        )
        if pendientes:
            raise CorreccionesPendientes(details={"missing": pendientes})

    ahora = _ahora()
    solicitud.status = hasta
    solicitud.truthfulness_declared_at = ahora
    if solicitud.submitted_at is None:
        solicitud.submitted_at = ahora
    solicitud.last_submitted_at = ahora
    solicitud.updated_at = ahora
    await db.flush()
    envio = await _congelar(
        db,
        evidencia=evidencia,
        politica=vigente,  # type: ignore[arg-type]  (no es None: ya se comprobó)
        tipo=REENVIO if reenvio else ENVIO_INICIAL,
        usuario_id=usuario_id,
        ahora=ahora,
    )
    evento = await _registrar(
        db,
        solicitud=solicitud,
        desde=desde_esperado,
        hasta=hasta,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
        detalles={"submission": envio.sequence, "terms_version": envio.terms_version},
        clave=clave,
        ahora=ahora,
    )
    _sincronizar(prestador, hasta, ahora)
    await db.flush()
    await _auditar(
        db,
        accion="service_application.resubmitted" if reenvio else "service_application.submitted",
        solicitud=solicitud,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
        desde=desde_esperado,
        hasta=hasta,
        datos={
            "submission": envio.sequence,
            "policy_id": envio.terms_policy_id,
            "policy_version": envio.terms_version,
            "event_id": evento.id,
            "idempotency": clave,
        },
    )
    await avisos.avisar_al_equipo(
        db,
        tipo=avisos.REENVIADA if reenvio else avisos.ENVIADA,
        solicitud_id=solicitud.id,
        suceso_id=evento.id,
        excepto={usuario_id},
    )
    return Resultado(solicitud, evento, False)


async def enviar(db: AsyncSession, *, usuario_id: str, clave: str | None) -> Resultado:
    return await _enviar_o_reenviar(db, usuario_id=usuario_id, reenvio=False, clave=clave)


async def reenviar(db: AsyncSession, *, usuario_id: str, clave: str | None) -> Resultado:
    return await _enviar_o_reenviar(db, usuario_id=usuario_id, reenvio=True, clave=clave)


async def retirar(
    db: AsyncSession, *, usuario_id: str, motivo: str | None, clave: str | None
) -> Resultado:
    """Solo el dueño, solo antes de la decisión. IDEMPOTENTE por estado."""
    solicitud, prestador = await la_mia_bloqueada(db, usuario_id)
    previo = await _por_clave(db, solicitud.id, clave, states.RETIRADA)
    if previo is not None:
        return Resultado(solicitud, previo, True)
    if solicitud.status == states.RETIRADA:
        return Resultado(solicitud, None, True)
    desde = solicitud.status
    states.exigir(desde, states.RETIRADA, states.PRESTADOR)
    if solicitud.decided_at is not None:
        raise YaDecidida(details={"status": desde})

    ahora = _ahora()
    solicitud.status = states.RETIRADA
    solicitud.updated_at = ahora
    await db.flush()
    nota = (motivo or "").strip()[:500] or None
    evento = await _registrar(
        db,
        solicitud=solicitud,
        desde=desde,
        hasta=states.RETIRADA,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
        nota_visible=nota if nota and len(nota) >= 3 else None,
        clave=clave,
        ahora=ahora,
    )
    _sincronizar(prestador, states.RETIRADA, ahora)
    await db.flush()
    await _auditar(
        db,
        accion="service_application.withdrawn",
        solicitud=solicitud,
        actor_id=usuario_id,
        funcion=states.PRESTADOR,
        desde=desde,
        hasta=states.RETIRADA,
        motivo=nota,
        datos={"event_id": evento.id, "idempotency": clave},
    )
    await avisos.avisar(
        db,
        usuario_id=usuario_id,
        tipo=avisos.RETIRADA,
        solicitud_id=solicitud.id,
        suceso_id=evento.id,
    )
    if desde != states.BORRADOR:
        # El equipo ya la tenía en su bandeja: que sepa que se retiró.
        await avisos.avisar_al_equipo(
            db,
            tipo=avisos.RETIRADA_EN_REVISION,
            solicitud_id=solicitud.id,
            suceso_id=evento.id,
            excepto={usuario_id},
        )
    return Resultado(solicitud, evento, False)


# --------------------------------------------------------------------------- #
# El equipo de Z
# --------------------------------------------------------------------------- #
async def _decidir(
    db: AsyncSession,
    *,
    solicitud_id: str,
    hasta: str,
    actor_id: str,
    funcion: str,
    mensaje: str | None = None,
    nota_interna: str | None = None,
    detalles: dict | None = None,
    clave: str | None = None,
    aviso: str,
) -> Resultado:
    solicitud = await bloquear(db, solicitud_id)
    prestador = await db.get(ServiceProvider, solicitud.provider_id)
    # NADIE DECIDE LO SUYO, y se dice antes que cualquier otra cosa.
    exigir_ajena(dueno_del_expediente=prestador.profile_id, user_id=actor_id)

    previo = await _por_clave(db, solicitud.id, clave, hasta)
    if previo is not None:
        return Resultado(solicitud, previo, True)
    desde = solicitud.status
    states.exigir(desde, hasta, funcion)

    ahora = _ahora()
    if hasta == states.APROBADA:
        evidencia = await _evidencia(db, solicitud, prestador)
        aceptada = (
            await db.get(ServicePolicy, solicitud.terms_policy_id)
            if solicitud.terms_policy_id
            else None
        )
        bloqueos = requisitos.para_aprobar(evidencia, aceptada=aceptada, hoy=_hoy())
        if bloqueos:
            raise RequisitosPendientes(details={"blockers": bloqueos})

    solicitud.status = hasta
    solicitud.updated_at = ahora
    if hasta == states.EN_REVISION:
        solicitud.review_started_at = ahora
    if hasta in (states.APROBADA, states.RECHAZADA):
        solicitud.decided_at = ahora
        solicitud.decided_by = actor_id
    if hasta == states.SUSPENDIDA:
        solicitud.suspended_at = ahora
    if hasta in (states.CORRECCIONES_PEDIDAS, states.RECHAZADA, states.SUSPENDIDA):
        solicitud.applicant_message = mensaje
    elif hasta == states.APROBADA:
        solicitud.applicant_message = mensaje
    if nota_interna:
        solicitud.internal_notes = nota_interna[:4000]
    await db.flush()

    evento = await _registrar(
        db,
        solicitud=solicitud,
        desde=desde,
        hasta=hasta,
        actor_id=actor_id,
        funcion=funcion,
        nota_visible=mensaje,
        nota_interna=nota_interna,
        detalles=detalles,
        clave=clave,
        ahora=ahora,
    )
    _sincronizar(prestador, hasta, ahora)
    await db.flush()
    await _auditar(
        db,
        accion=f"service_application.{_ACCIONES[hasta]}",
        solicitud=solicitud,
        actor_id=actor_id,
        funcion=funcion,
        desde=desde,
        hasta=hasta,
        motivo=mensaje,
        datos={"event_id": evento.id, "idempotency": clave, "provider_status": prestador.status},
    )
    await avisos.avisar(
        db,
        usuario_id=prestador.profile_id,
        tipo=aviso,
        solicitud_id=solicitud.id,
        suceso_id=evento.id,
    )
    return Resultado(solicitud, evento, False)


async def revisar_documento(
    db: AsyncSession, *, solicitud_id: str, documento_id: str, aceptar: bool,
    nota: str | None, actor_id: str, funcion: str,
):
    """Aceptar u observar un documento. Bloquea la postulación como un salto."""
    solicitud = await bloquear(db, solicitud_id)
    prestador = await db.get(ServiceProvider, solicitud.provider_id)
    exigir_ajena(dueno_del_expediente=prestador.profile_id, user_id=actor_id)
    documento = await documentos.uno(db, solicitud_id=solicitud.id, documento_id=documento_id)
    documento = await documentos.revisar(
        db, solicitud=solicitud, documento=documento, aceptar=aceptar, nota=nota,
        revisor_id=actor_id,
    )
    await auditar(
        db, accion="service_document.accepted" if aceptar else "service_document.observed",
        entidad="service_provider_document", entidad_id=documento.id, actor_id=actor_id,
        funcion=funcion, motivo=None if aceptar else documento.review_note,
        datos={"application_id": solicitud.id, "kind": documento.kind},
    )
    if not aceptar:
        await avisos.avisar(
            db, usuario_id=prestador.profile_id, tipo=avisos.DOCUMENTO_OBSERVADO,
            solicitud_id=solicitud.id, suceso_id=f"{documento.id}:observed",
        )
    return documento


async def revisar_credencial(
    db: AsyncSession, *, solicitud_id: str, credencial_id: str, accion: str,
    nota: str | None, actor_id: str, funcion: str,
):
    """Verificar, observar o rechazar una credencial."""
    solicitud = await bloquear(db, solicitud_id)
    prestador = await db.get(ServiceProvider, solicitud.provider_id)
    exigir_ajena(dueno_del_expediente=prestador.profile_id, user_id=actor_id)
    credencial = await credenciales.una(db, solicitud_id=solicitud.id, credencial_id=credencial_id)
    credencial = await credenciales.revisar(
        db, solicitud=solicitud, credencial=credencial, accion=accion, nota=nota,
        revisor_id=actor_id, hoy=_hoy(),
    )
    nombres = {"verify": "verified", "observe": "observed", "reject": "rejected"}
    await auditar(
        db, accion=f"service_credential.{nombres[accion]}",
        entidad="service_provider_credential", entidad_id=credencial.id, actor_id=actor_id,
        funcion=funcion, motivo=credencial.review_note,
        datos={"application_id": solicitud.id, "kind": credencial.kind},
    )
    if accion in ("observe", "reject"):
        marca = int((credencial.observed_at or credencial.updated_at or _ahora()).timestamp())
        await avisos.avisar(
            db, usuario_id=prestador.profile_id,
            tipo=avisos.CREDENCIAL_OBSERVADA if accion == "observe" else avisos.CREDENCIAL_RECHAZADA,
            solicitud_id=solicitud.id, suceso_id=f"{credencial.id}:{accion}:{marca}",
        )
    return credencial


_ACCIONES = {
    states.EN_REVISION: "review_started",
    states.CORRECCIONES_PEDIDAS: "changes_requested",
    states.APROBADA: "approved",
    states.RECHAZADA: "rejected",
    states.SUSPENDIDA: "suspended",
}


async def iniciar_revision(
    db: AsyncSession, *, solicitud_id: str, actor_id: str, funcion: str,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    """Tomar una enviada o reenviada, o devolver a revisión una suspendida."""
    return await _decidir(
        db, solicitud_id=solicitud_id, hasta=states.EN_REVISION, actor_id=actor_id,
        funcion=funcion, nota_interna=nota_interna, clave=clave, aviso=avisos.REVISION_INICIADA,
    )


async def pedir_correcciones(
    db: AsyncSession, *, solicitud_id: str, actor_id: str, funcion: str, mensaje: str,
    campos: list[str], nota_interna: str | None, clave: str | None,
) -> Resultado:
    desconocidos = [c for c in campos if c not in requisitos.CAMPOS_OBSERVABLES]
    if desconocidos:
        raise ValidationAppError(
            "Hay campos que no se pueden señalar.",
            code="service_application_field_unknown",
            details={"fields": desconocidos},
        )
    return await _decidir(
        db, solicitud_id=solicitud_id, hasta=states.CORRECCIONES_PEDIDAS, actor_id=actor_id,
        funcion=funcion, mensaje=mensaje, nota_interna=nota_interna,
        detalles={"fields": list(dict.fromkeys(campos))}, clave=clave,
        aviso=avisos.CORRECCIONES_PEDIDAS,
    )


async def aprobar(
    db: AsyncSession, *, solicitud_id: str, actor_id: str, funcion: str,
    mensaje: str | None, nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _decidir(
        db, solicitud_id=solicitud_id, hasta=states.APROBADA, actor_id=actor_id,
        funcion=funcion, mensaje=mensaje, nota_interna=nota_interna, clave=clave,
        aviso=avisos.APROBADA,
    )


async def rechazar(
    db: AsyncSession, *, solicitud_id: str, actor_id: str, funcion: str,
    mensaje: str, nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _decidir(
        db, solicitud_id=solicitud_id, hasta=states.RECHAZADA, actor_id=actor_id,
        funcion=funcion, mensaje=mensaje, nota_interna=nota_interna, clave=clave,
        aviso=avisos.RECHAZADA,
    )


async def suspender(
    db: AsyncSession, *, solicitud_id: str, actor_id: str, funcion: str,
    mensaje: str, nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _decidir(
        db, solicitud_id=solicitud_id, hasta=states.SUSPENDIDA, actor_id=actor_id,
        funcion=funcion, mensaje=mensaje, nota_interna=nota_interna, clave=clave,
        aviso=avisos.SUSPENDIDA,
    )


__all__ = [
    "ClaveReutilizada",
    "auditar",
    "revisar_credencial",
    "revisar_documento",
    "CorreccionesPendientes",
    "PaisRequerido",
    "YaDecidida",
    "RepostulacionNoConfigurada",
    "RepostulacionNoPermitida",
    "RequisitosPendientes",
    "Resultado",
    "SolicitudIncompleta",
    "aceptar_terminos",
    "aprobar",
    "bloquear",
    "enviar",
    "estado_del_prestador",
    "exigir_clave_valida",
    "exigir_que_pueda_repostular",
    "iniciar_revision",
    "la_mia_bloqueada",
    "pedir_correcciones",
    "politica_vigente_para",
    "rechazar",
    "reenviar",
    "retirar",
    "suspender",
]
