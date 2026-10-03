"""Los documentos privados de la postulación.

REUTILIZA EL ALMACENAMIENTO QUE YA EXISTE (`shared/storage.py`, el mismo de
los documentos de proveedores de Productos): la API recibe los bytes, los mira
y los sube con la clave de servicio al depósito PRIVADO
`service-provider-documents` (0088). No hay proveedor de archivos nuevo.

LO QUE GARANTIZA ESTE FICHERO:

  * SE MIRAN LOS BYTES, NO LA EXTENSIÓN: un PDF empieza por `%PDF-`; una foto
    la abre `products.media.medir`, como las de producto. Nada más entra.
  * LA RUTA LA PONE EL SERVIDOR: `<perfil>/<postulación>/<uuid>.<ext>`. Nadie
    puede apuntar a un archivo ajeno, y el prefijo `<perfil>/` hace que borrar
    la cuenta lo barra (`USER_BUCKETS`).
  * LA RUTA NUNCA SALE: ni en listados, ni en el historial, ni en la
    auditoría. Ver un documento es pedir un ENLACE FIRMADO de dos minutos, uno
    por petición, y solo para su dueño o para el equipo de Z.
  * NADA SE BORRA SUELTO (0086): reemplazar deja el anterior como evidencia
    (`replaced`), y retirar (`removed`) solo cabe si NUNCA se envió; entonces
    sí se borra el archivo, porque no es evidencia de nada.

LIMITACIÓN CONOCIDA, NO FINGIDA: no hay antivirus ni procesamiento
documental. El proyecto no los tiene; queda como endurecimiento futuro.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.modules.services import states
from app.modules.services.models import (
    ACTIVO,
    CREDENCIAL_DECLARADA,
    DOCUMENTO_ACEPTADO,
    DOCUMENTO_OBSERVADO,
    DOCUMENTO_PENDIENTE,
    PESO_MAXIMO_DE_DOCUMENTO,
    REEMPLAZADO,
    RETIRADO,
    TIPOS_DE_DOCUMENTO,
    ServiceProviderApplication,
    ServiceProviderApplicationSubmission,
    ServiceProviderCredential,
    ServiceProviderDocument,
)

DEPOSITO = "service-provider-documents"
#: Cuánto vive un enlace para mirar un documento. Corto a propósito: es para
#: abrirlo ahora, no para guardarlo.
SEGUNDOS_DE_LA_FIRMA = 120
#: Tope de documentos ACTIVOS por postulación.
MAXIMO_ACTIVOS = 20
#: Tope de documentos GUARDADOS por postulación, contando reemplazados y
#: retirados. No es una regla de negocio: es la barrera contra reemplazar sin
#: fin, que dejaría cientos de archivos de 10 MB. Tres veces los activos.
MAXIMO_POR_POSTULACION = 3 * MAXIMO_ACTIVOS


class DocumentoNoEncontrado(NotFoundError):
    code = "service_document_not_found"
    message = "No encontramos ese documento."


class DocumentoBloqueado(ConflictError):
    code = "service_document_locked"
    message = "Este documento ya no se puede cambiar."


class DocumentoYaEnviado(ConflictError):
    code = "service_document_submitted"
    message = "Este documento ya se envió: reemplázalo en lugar de retirarlo."


class DocumentoInvalido(ValidationAppError):
    code = "service_document_invalid"
    message = "El documento no es válido."


class DocumentoEnUso(ConflictError):
    """Respalda una credencial activa: retirarlo la dejaría sin evidencia."""

    code = "service_document_in_use"
    message = "Este documento respalda una credencial: cambia su evidencia o quita la credencial antes."


class AlmacenamientoNoConfigurado(ServiceUnavailableError):
    code = "service_storage_not_configured"
    message = "El almacenamiento de documentos no está configurado."


class AlmacenamientoFallo(AppError):
    status_code = 503
    code = "service_storage_failed"
    message = "No pudimos guardar o abrir el documento. Inténtalo de nuevo."


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def detectar(datos: bytes, declarado: str | None) -> tuple[str, str]:
    """`(content_type, extensión)` según los BYTES, o `DocumentoInvalido`."""
    if not datos:
        raise DocumentoInvalido("El archivo está vacío.", code="service_document_empty")
    if len(datos) > PESO_MAXIMO_DE_DOCUMENTO:
        raise DocumentoInvalido(
            "El documento pesa demasiado (máximo 10 MB).",
            code="service_document_too_big",
            details={"max_bytes": PESO_MAXIMO_DE_DOCUMENTO},
        )
    if datos[:5] == b"%PDF-":
        return "application/pdf", "pdf"
    # Import local, como en Productos: `media` arrastra el catálogo.
    from app.modules.products import media

    try:
        medida = media.medir(datos, declarado=declarado)
    except Exception:  # noqa: BLE001
        raise DocumentoInvalido(
            "Sube un PDF o una foto (JPEG, PNG o WebP).",
            code="service_document_type_invalid",
        ) from None
    return medida.content_type, media.EXTENSION_DE_LA_IMAGEN.get(medida.content_type, "jpg")


def exigir_tipo(kind: str) -> str:
    tipo = (kind or "").strip()
    if tipo not in TIPOS_DE_DOCUMENTO:
        raise DocumentoInvalido(
            "Ese tipo de documento no existe.",
            code="service_document_kind_invalid",
            details={"allowed": list(TIPOS_DE_DOCUMENTO)},
        )
    return tipo


def exigir_editable(solicitud: ServiceProviderApplication) -> None:
    if not states.es_editable(solicitud.status):
        raise DocumentoBloqueado(
            "La postulación no se puede cambiar en este estado.",
            details={"status": solicitud.status},
        )


async def de_la_solicitud(
    db: AsyncSession, solicitud_id: str, *, solo_activos: bool = True
) -> list[ServiceProviderDocument]:
    consulta = select(ServiceProviderDocument).where(
        ServiceProviderDocument.application_id == solicitud_id
    )
    if solo_activos:
        consulta = consulta.where(ServiceProviderDocument.lifecycle == ACTIVO)
    return list(
        await db.scalars(
            consulta.order_by(ServiceProviderDocument.created_at, ServiceProviderDocument.id)
        )
    )


async def uno(
    db: AsyncSession, *, solicitud_id: str, documento_id: str
) -> ServiceProviderDocument:
    """El documento DE ESA postulación. Lo ajeno o mal escrito es un 404."""
    try:
        uuid.UUID(documento_id)
    except ValueError:
        raise DocumentoNoEncontrado() from None
    documento = await db.get(ServiceProviderDocument, documento_id)
    if documento is None or documento.application_id != solicitud_id:
        raise DocumentoNoEncontrado()
    return documento


async def enviados(db: AsyncSession, solicitud_id: str) -> set[str]:
    """Los identificadores de documento que forman parte de ALGÚN envío."""
    ids: set[str] = set()
    for foto in await db.scalars(
        select(ServiceProviderApplicationSubmission.snapshot).where(
            ServiceProviderApplicationSubmission.application_id == solicitud_id
        )
    ):
        for d in (foto or {}).get("documents", []):
            if isinstance(d, dict) and d.get("id"):
                ids.add(str(d["id"]))
    return ids


async def _guardar_archivo(ruta: str, datos: bytes, tipo: str) -> None:
    from app.shared import storage

    import httpx

    try:
        await storage.subir_objeto(DEPOSITO, ruta, datos, tipo)
    except storage.StorageNoConfigurado:
        raise AlmacenamientoNoConfigurado() from None
    except (storage.StorageFallo, httpx.HTTPError):
        raise AlmacenamientoFallo() from None


async def _exigir_hueco(db: AsyncSession, solicitud_id: str) -> None:
    guardados = await db.scalar(
        select(func.count())
        .select_from(ServiceProviderDocument)
        .where(ServiceProviderDocument.application_id == solicitud_id)
    )
    if (guardados or 0) >= MAXIMO_POR_POSTULACION:
        raise DocumentoInvalido(
            "Demasiados documentos en una sola postulación.",
            code="service_document_too_many",
            details={"max": MAXIMO_POR_POSTULACION},
        )


async def _registrar_o_borrar(db: AsyncSession, documento: ServiceProviderDocument) -> None:
    """La fila del archivo recién subido. Si no se puede escribir, el archivo
    se borra: sin su fila no es de nadie y nada lo encontraría."""
    try:
        db.add(documento)
        await db.flush()
    except BaseException:
        await borrar_archivo(documento.storage_path)
        raise


async def subir(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    usuario_id: str,
    kind: str,
    datos: bytes,
    declarado: str | None,
) -> tuple[ServiceProviderDocument, bool]:
    """Sube un documento a la postulación editable. Devuelve (documento, nuevo).

    REINTENTAR NO DUPLICA: el mismo archivo (misma huella) del mismo tipo en la
    misma postulación devuelve el que ya está.
    """
    exigir_editable(solicitud)
    tipo = exigir_tipo(kind)
    contenido, extension = detectar(datos, declarado)
    suma = hashlib.sha256(datos).hexdigest()

    activos = await de_la_solicitud(db, solicitud.id)
    for d in activos:
        if d.kind == tipo and d.checksum_sha256 == suma:
            return d, False
    if len(activos) >= MAXIMO_ACTIVOS:
        raise DocumentoInvalido(
            "Demasiados documentos en una sola postulación.",
            code="service_document_too_many",
            details={"max": MAXIMO_ACTIVOS},
        )
    await _exigir_hueco(db, solicitud.id)

    # EL ARCHIVO PRIMERO: si la subida falla, no queda una fila que promete un
    # documento que no existe.
    ruta = f"{usuario_id}/{solicitud.id}/{uuid.uuid4()}.{extension}"
    await _guardar_archivo(ruta, datos, contenido)
    documento = ServiceProviderDocument(
        provider_id=solicitud.provider_id,
        application_id=solicitud.id,
        kind=tipo,
        storage_path=ruta,
        content_type=contenido,
        byte_size=len(datos),
        checksum_sha256=suma,
        review_status=DOCUMENTO_PENDIENTE,
        uploaded_by=usuario_id,
        lifecycle=ACTIVO,
        created_at=_ahora(),
    )
    await _registrar_o_borrar(db, documento)
    return documento, True


async def reemplazar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    documento: ServiceProviderDocument,
    usuario_id: str,
    datos: bytes,
    declarado: str | None,
) -> ServiceProviderDocument:
    """Sube uno nuevo del MISMO tipo y deja el anterior como evidencia."""
    exigir_editable(solicitud)
    if documento.lifecycle != ACTIVO:
        raise DocumentoBloqueado(details={"lifecycle": documento.lifecycle})
    contenido, extension = detectar(datos, declarado)
    await _exigir_hueco(db, solicitud.id)
    ruta = f"{usuario_id}/{solicitud.id}/{uuid.uuid4()}.{extension}"
    await _guardar_archivo(ruta, datos, contenido)
    ahora = _ahora()
    nuevo = ServiceProviderDocument(
        provider_id=solicitud.provider_id,
        application_id=solicitud.id,
        kind=documento.kind,
        storage_path=ruta,
        content_type=contenido,
        byte_size=len(datos),
        checksum_sha256=hashlib.sha256(datos).hexdigest(),
        review_status=DOCUMENTO_PENDIENTE,
        uploaded_by=usuario_id,
        lifecycle=ACTIVO,
        created_at=ahora,
    )
    await _registrar_o_borrar(db, nuevo)
    documento.lifecycle = REEMPLAZADO
    documento.lifecycle_changed_at = ahora
    documento.replaced_by = nuevo.id
    # LA EVIDENCIA SIGUE AL REEMPLAZO en las credenciales que aún se pueden
    # cambiar (declaradas). Una ya verificada sigue apuntando al que Z miró,
    # que se conserva como evidencia.
    for credencial in await db.scalars(
        select(ServiceProviderCredential).where(
            ServiceProviderCredential.evidence_document_id == documento.id,
            ServiceProviderCredential.lifecycle == ACTIVO,
            ServiceProviderCredential.status == CREDENCIAL_DECLARADA,
        )
    ):
        credencial.evidence_document_id = nuevo.id
        credencial.updated_at = ahora
    await db.flush()
    return nuevo


async def retirar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    documento: ServiceProviderDocument,
) -> str | None:
    """Lo retira ANTES DE ENVIARLO. Devuelve la ruta a borrar tras el commit.

    Lo que ya se envió es evidencia: no se retira, se reemplaza. Retirar lo ya
    retirado no hace nada (y no devuelve ruta).
    """
    exigir_editable(solicitud)
    if documento.lifecycle == RETIRADO:
        return None
    if documento.lifecycle != ACTIVO:
        raise DocumentoBloqueado(details={"lifecycle": documento.lifecycle})
    if documento.id in await enviados(db, solicitud.id):
        raise DocumentoYaEnviado()
    en_uso = await db.scalar(
        select(func.count())
        .select_from(ServiceProviderCredential)
        .where(
            ServiceProviderCredential.evidence_document_id == documento.id,
            ServiceProviderCredential.lifecycle == ACTIVO,
        )
    )
    if en_uso:
        raise DocumentoEnUso()
    documento.lifecycle = RETIRADO
    documento.lifecycle_changed_at = _ahora()
    await db.flush()
    return documento.storage_path


async def borrar_archivo(ruta: str | None) -> None:
    """Tras el commit y sin romper nada: un archivo que no se pudo borrar lo
    barre el borrado de la cuenta (mismo prefijo)."""
    if not ruta:
        return
    from app.shared import storage

    try:
        await storage.borrar_objeto(DEPOSITO, ruta)
    except Exception:  # noqa: BLE001
        pass


async def firmar(documento: ServiceProviderDocument) -> str:
    """Un enlace para MIRARLO AHORA. Nunca se guarda ni se lista."""
    from app.shared import storage

    import httpx

    try:
        firmadas = await storage.firmar_objetos(
            DEPOSITO, [documento.storage_path], segundos=SEGUNDOS_DE_LA_FIRMA
        )
    except storage.StorageNoConfigurado:
        raise AlmacenamientoNoConfigurado() from None
    except (storage.StorageFallo, httpx.HTTPError):
        raise AlmacenamientoFallo() from None
    enlace = firmadas.get(documento.storage_path)
    if not enlace:
        raise AlmacenamientoFallo()
    return enlace


async def revisar(
    db: AsyncSession,
    *,
    solicitud: ServiceProviderApplication,
    documento: ServiceProviderDocument,
    aceptar: bool,
    nota: str | None,
    revisor_id: str,
) -> ServiceProviderDocument:
    """Aceptar u observar. SOLO con la postulación EN REVISIÓN."""
    if solicitud.status != states.EN_REVISION:
        raise DocumentoBloqueado(
            "Solo se revisa con la postulación en revisión.",
            details={"status": solicitud.status},
        )
    if documento.lifecycle != ACTIVO:
        raise DocumentoBloqueado(details={"lifecycle": documento.lifecycle})
    if not aceptar and not (nota or "").strip():
        raise DocumentoInvalido(
            "Di qué hay que corregir en el documento.",
            code="service_document_note_required",
        )
    documento.review_status = DOCUMENTO_ACEPTADO if aceptar else DOCUMENTO_OBSERVADO
    documento.review_note = None if aceptar else (nota or "").strip()[:1000]
    documento.reviewed_at = _ahora()
    documento.reviewed_by = revisor_id
    await db.flush()
    return documento


__all__ = [
    "DocumentoEnUso",
    "MAXIMO_POR_POSTULACION",
    "AlmacenamientoFallo",
    "AlmacenamientoNoConfigurado",
    "DEPOSITO",
    "DocumentoBloqueado",
    "DocumentoInvalido",
    "DocumentoNoEncontrado",
    "DocumentoYaEnviado",
    "MAXIMO_ACTIVOS",
    "SEGUNDOS_DE_LA_FIRMA",
    "borrar_archivo",
    "de_la_solicitud",
    "detectar",
    "enviados",
    "firmar",
    "reemplazar",
    "retirar",
    "revisar",
    "subir",
    "uno",
]
