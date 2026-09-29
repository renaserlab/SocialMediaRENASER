"""Las credenciales profesionales del prestador.

QUIEN POSTULA DECLARA; SOLO Z VERIFICA. El prestador registra, edita, cambia
la evidencia y retira (antes de enviar); administración verifica, observa o
rechaza, con motivo, autor y fecha.

EL NÚMERO NUNCA SE GUARDA ENTERO: llega en la petición y se guarda
enmascarado («••••4587»). El número completo está en el documento que la
respalda, que es privado.

OBSERVAR NO ES UN ESTADO NUEVO (0088): la credencial sigue `declared`, con
`observed_at` y el motivo. Editarla la devuelve a «pendiente». Rechazar sí es
final para esa credencial; si hace falta, se declara otra.

VENCIDA SE CALCULA (`requisitos.estado_visible_de_credencial`): no hace falta
un proceso que pase a marcarlas para que dejen de contar.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.services import states
from app.modules.services.models import (
    ACTIVO,
    CREDENCIAL_DECLARADA,
    CREDENCIAL_RECHAZADA,
    CREDENCIAL_VERIFICADA,
    RETIRADO,
    ServiceProviderApplication,
    ServiceProviderApplicationSubmission,
    ServiceProviderCredential,
    ServiceProviderDocument,
)

#: Tope de credenciales ACTIVAS por postulación.
MAXIMO_ACTIVAS = 20


class CredencialNoEncontrada(NotFoundError):
    code = "service_credential_not_found"
    message = "No encontramos esa credencial."


class CredencialBloqueada(ConflictError):
    code = "service_credential_locked"
    message = "Esta credencial ya no se puede cambiar."


class CredencialYaEnviada(ConflictError):
    code = "service_credential_submitted"
    message = "Esta credencial ya se envió: edítala en lugar de retirarla."


class CredencialInvalida(ValidationAppError):
    code = "service_credential_invalid"
    message = "La credencial no es válida."


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def enmascarar(numero: str | None) -> str | None:
    """Solo los cuatro últimos caracteres a la vista. Nunca el número entero."""
    limpio = "".join((numero or "").split())
    if not limpio:
        return None
    visibles = limpio[-4:] if len(limpio) > 4 else limpio[-1:]
    return "••••" + visibles


async def de_la_solicitud(
    db: AsyncSession, solicitud_id: str, *, solo_activas: bool = True
) -> list[ServiceProviderCredential]:
    """Las presentadas EN ESA postulación: una nueva no hereda las de otra."""
    consulta = select(ServiceProviderCredential).where(
        ServiceProviderCredential.application_id == solicitud_id
    )
    if solo_activas:
        consulta = consulta.where(ServiceProviderCredential.lifecycle == ACTIVO)
    return list(
        await db.scalars(
            consulta.order_by(ServiceProviderCredential.created_at, ServiceProviderCredential.id)
        )
    )


async def una(
    db: AsyncSession, *, solicitud_id: str, credencial_id: str
) -> ServiceProviderCredential:
    """La credencial DE ESA postulación. Lo ajeno o mal escrito es un 404."""
    try:
        uuid.UUID(credencial_id)
    except ValueError:
        raise CredencialNoEncontrada() from None
    credencial = await db.get(ServiceProviderCredential, credencial_id)
    if credencial is None or credencial.application_id != solicitud_id:
        raise CredencialNoEncontrada()
    return credencial


async def _exigir_evidencia_propia(
    db: AsyncSession, *, solicitud: ServiceProviderApplication, documento_id: str | None
) -> None:
    """La evidencia es un documento ACTIVO de esta misma postulación."""
    if documento_id is None:
        return
    try:
        uuid.UUID(documento_id)
    except ValueError:
        raise CredencialInvalida(code="service_credential_evidence_invalid") from None
    documento = await db.get(ServiceProviderDocument, documento_id)
    if (
        documento is None
        or documento.application_id != solicitud.id
        or documento.lifecycle != ACTIVO
    ):
        raise CredencialInvalida(
            "La evidencia tiene que ser un documento de esta postulación.",
            code="service_credential_evidence_invalid",
        )


def _exigir_editable(solicitud: ServiceProviderApplication) -> None:
    if not states.es_editable(solicitud.status):
        raise CredencialBloqueada(
            "La postulación no se puede cambiar en este estado.",
            details={"status": solicitud.status},
        )


async def enviadas(db: AsyncSession, solicitud_id: str) -> set[str]:
    ids: set[str] = set()
    for foto in await db.scalars(
        select(ServiceProviderApplicationSubmission.snapshot).where(
            ServiceProviderApplicationSubmission.application_id == solicitud_id
        )
    ):
        for c in (foto or {}).get("credentials", []):
            if isinstance(c, dict) and c.get("id"):
                ids.add(str(c["id"]))
    return ids


async def crear(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    datos: dict,
    clave: str | None,
) -> tuple[ServiceProviderCredential, bool]:
    """Declara una credencial. REINTENTAR con la misma clave devuelve la misma."""
    _exigir_editable(solicitud)
    if clave:
        previa = await db.scalar(
            select(ServiceProviderCredential).where(
                ServiceProviderCredential.provider_id == solicitud.provider_id,
                ServiceProviderCredential.idempotency_key == clave,
            )
        )
        if previa is not None:
            return previa, False
    if len(await de_la_solicitud(db, solicitud.id)) >= MAXIMO_ACTIVAS:
        raise CredencialInvalida(
            "Demasiadas credenciales en una sola postulación.",
            code="service_credential_too_many",
            details={"max": MAXIMO_ACTIVAS},
        )
    await _exigir_evidencia_propia(
        db, solicitud=solicitud, documento_id=datos.get("evidence_document_id")
    )
    ahora = _ahora()
    credencial = ServiceProviderCredential(
        provider_id=solicitud.provider_id,
        application_id=solicitud.id,
        kind=datos["kind"],
        title=datos["title"],
        issuer=datos["issuer"],
        jurisdiction=datos.get("jurisdiction"),
        number_masked=enmascarar(datos.get("number")),
        specialty=datos.get("specialty"),
        issued_on=datos.get("issued_on"),
        expires_on=datos.get("expires_on"),
        evidence_document_id=datos.get("evidence_document_id"),
        status=CREDENCIAL_DECLARADA,
        idempotency_key=clave,
        lifecycle=ACTIVO,
        created_at=ahora,
        updated_at=ahora,
    )
    db.add(credencial)
    await db.flush()
    return credencial, True


async def editar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    credencial: ServiceProviderCredential,
    cambios: dict,
) -> ServiceProviderCredential:
    """Solo mientras la postulación es editable y la credencial está declarada.

    Editar una OBSERVADA la devuelve a pendiente: es la forma de corregirla.
    """
    _exigir_editable(solicitud)
    if credencial.lifecycle != ACTIVO or credencial.status != CREDENCIAL_DECLARADA:
        raise CredencialBloqueada(
            details={"status": credencial.status, "lifecycle": credencial.lifecycle}
        )
    if "evidence_document_id" in cambios:
        await _exigir_evidencia_propia(
            db, solicitud=solicitud, documento_id=cambios["evidence_document_id"]
        )
    for campo, valor in cambios.items():
        if campo == "number":
            credencial.number_masked = enmascarar(valor)  # type: ignore[arg-type]
        else:
            setattr(credencial, campo, valor)
    if credencial.issued_on and credencial.expires_on and credencial.expires_on < credencial.issued_on:
        raise CredencialInvalida(
            "La credencial no puede vencer antes de emitirse.",
            code="service_credential_dates_invalid",
        )
    credencial.observed_at = None
    credencial.review_note = None
    credencial.updated_at = _ahora()
    await db.flush()
    return credencial


async def retirar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    credencial: ServiceProviderCredential,
) -> ServiceProviderCredential:
    """La retira ANTES DE ENVIARLA. Lo enviado se edita, no se retira."""
    _exigir_editable(solicitud)
    if credencial.lifecycle == RETIRADO:
        return credencial
    if credencial.id in await enviadas(db, solicitud.id):
        raise CredencialYaEnviada()
    credencial.lifecycle = RETIRADO
    credencial.lifecycle_changed_at = _ahora()
    credencial.updated_at = credencial.lifecycle_changed_at
    await db.flush()
    return credencial


async def revisar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    credencial: ServiceProviderCredential,
    accion: str,
    nota: str | None,
    revisor_id: str,
    hoy: date,
) -> ServiceProviderCredential:
    """`verify`, `observe` o `reject`. SOLO con la postulación EN REVISIÓN."""
    if solicitud.status != states.EN_REVISION:
        raise CredencialBloqueada(
            "Solo se revisa con la postulación en revisión.",
            details={"status": solicitud.status},
        )
    if credencial.lifecycle != ACTIVO or credencial.status != CREDENCIAL_DECLARADA:
        raise CredencialBloqueada(
            details={"status": credencial.status, "lifecycle": credencial.lifecycle}
        )
    texto = (nota or "").strip()[:1000] or None
    ahora = _ahora()
    if accion == "verify":
        evidencia = (
            await db.get(ServiceProviderDocument, credencial.evidence_document_id)
            if credencial.evidence_document_id
            else None
        )
        if (
            evidencia is None
            or evidencia.application_id != credencial.application_id
            or evidencia.lifecycle == RETIRADO
        ):
            raise CredencialInvalida(
                "No se verifica una credencial sin evidencia.",
                code="service_credential_evidence_required",
            )
        if credencial.expires_on is not None and credencial.expires_on < hoy:
            raise CredencialInvalida(
                "La credencial está vencida.", code="service_credential_expired"
            )
        credencial.status = CREDENCIAL_VERIFICADA
        credencial.verified_at = ahora
        credencial.verified_by = revisor_id
        credencial.observed_at = None
        credencial.review_note = None
    elif accion in ("observe", "reject"):
        if texto is None:
            raise CredencialInvalida(
                "Di qué hay que corregir en la credencial.",
                code="service_credential_note_required",
            )
        credencial.review_note = texto
        if accion == "observe":
            credencial.observed_at = ahora
        else:
            credencial.status = CREDENCIAL_RECHAZADA
            credencial.observed_at = None
    else:  # pragma: no cover - el router solo manda estas tres
        raise CredencialInvalida(code="service_credential_action_invalid")
    credencial.updated_at = ahora
    await db.flush()
    return credencial


__all__ = [
    "CredencialBloqueada",
    "CredencialInvalida",
    "CredencialNoEncontrada",
    "CredencialYaEnviada",
    "MAXIMO_ACTIVAS",
    "crear",
    "de_la_solicitud",
    "editar",
    "enmascarar",
    "enviadas",
    "retirar",
    "revisar",
    "una",
]
