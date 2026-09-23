"""La postulación del proveedor: «Postula tu producto», no «Hazte vendedor».

QUÉ DECIDE ESTE FICHERO Y QUÉ NO. Decide el recorrido de una solicitud —se
escribe, se envía, alguien la mira, se acepta o se rechaza con motivo— y, al
aceptarla, crea la capacidad comercial. NO decide qué documentación exige la
empresa: qué papeles hacen falta depende de la entidad legal que vende y del
país, y eso no está definido. Por eso los documentos son filas con un código de
tipo y no columnas de datos tributarios inventadas aquí.

DOS PUERTAS QUE NO SON DE ROL:

  1. NADIE DECIDE SU PROPIA POSTULACIÓN, ni siendo administrador. Se comprueba
     antes que el rol.
  2. UN RECHAZO NECESITA MOTIVO, y lo exige también la base. Un «no» que no se
     le puede enseñar a la persona no es una decisión: es un silencio.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationAppError,
)
from app.modules.gobernanza import auditoria
from app.modules.products import esquema, permissions
from app.modules.products.models import (
    DOCUMENTOS,
    POSTULACION_ACEPTADA,
    POSTULACION_BORRADOR,
    POSTULACION_EN_REVISION,
    POSTULACION_ENVIADA,
    POSTULACION_RECHAZADA,
    POSTULACION_RETIRADA,
    POSTULACIONES_VIVAS,
    VENDEDOR_ACTIVO,
    ProductSeller,
    SellerApplication,
    SellerApplicationDocument,
)

logger = logging.getLogger("renaser.products")

#: Desde dónde puede seguir escribiendo quien postula. Después no: una
#: postulación en revisión ya ocupó el tiempo de alguien, y cambiarla a mitad
#: haría que se decidiera sobre algo distinto de lo que se leyó.
EDITABLES = (POSTULACION_BORRADOR,)

#: Desde dónde se puede enviar.
ENVIABLES = (POSTULACION_BORRADOR,)

#: Desde dónde se puede decidir.
DECIDIBLES = (POSTULACION_ENVIADA, POSTULACION_EN_REVISION)

LARGO_DE_LA_PROPUESTA = (20, 4_000)
LARGO_DEL_NOMBRE = (2, 120)
MAXIMO_DE_DOCUMENTOS = 30


def ahora() -> datetime:
    return datetime.now(timezone.utc)


class PostulacionNoEncontrada(NotFoundError):
    code = "seller_application_not_found"


class PostulacionNoEditable(ConflictError):
    code = "seller_application_not_editable"


async def mia(db: AsyncSession, *, usuario_id: str) -> SellerApplication | None:
    """La postulación viva de esa persona, o la última que tuvo.

    SE DEVUELVE TAMBIÉN UNA RECHAZADA a propósito: quien la escribió tiene
    derecho a leer por qué se le dijo que no.
    """
    if not await esquema.hay_admision(db):
        return None
    viva = await db.scalar(
        select(SellerApplication).where(
            SellerApplication.profile_id == usuario_id,
            SellerApplication.status.in_(POSTULACIONES_VIVAS),
        )
    )
    if viva is not None:
        return viva
    return await db.scalar(
        select(SellerApplication)
        .where(SellerApplication.profile_id == usuario_id)
        .order_by(SellerApplication.created_at.desc(), SellerApplication.id.desc())
        .limit(1)
    )


async def documentos_de(
    db: AsyncSession, *, postulacion_id: str
) -> list[SellerApplicationDocument]:
    return list(
        await db.scalars(
            select(SellerApplicationDocument)
            .where(SellerApplicationDocument.application_id == postulacion_id)
            .order_by(
                SellerApplicationDocument.kind,
                SellerApplicationDocument.created_at,
            )
        )
    )


def _exigir_texto(nombre: str, valor: str | None, cotas: tuple[int, int], codigo: str) -> str:
    limpio = (valor or "").strip()
    minimo, maximo = cotas
    if len(limpio) < minimo or len(limpio) > maximo:
        raise ValidationAppError(
            f"`{nombre}` está fuera de lo posible.",
            code=codigo,
            details={"field": nombre, "min": minimo, "max": maximo},
        )
    return limpio


async def guardar(
    db: AsyncSession,
    *,
    usuario_id: str,
    display_name: str,
    proposal: str,
    documentos: list[dict] | None = None,
) -> SellerApplication:
    """Crea el borrador o reescribe el que haya. UNO VIVO por perfil.

    Lo impone un índice parcial de la 0071: dos postulaciones abiertas de la
    misma persona son dos respuestas posibles a la misma pregunta.
    """
    await esquema.exigir_admision(db)
    nombre = _exigir_texto(
        "display_name", display_name, LARGO_DEL_NOMBRE, "seller_application_name_invalid"
    )
    propuesta = _exigir_texto(
        "proposal", proposal, LARGO_DE_LA_PROPUESTA, "seller_application_proposal_invalid"
    )
    limpios = _exigir_documentos(documentos)

    # YA ES RESPONSABLE COMERCIAL: no hay nada que postular.
    vendedor = await permissions.vendedor_de(db, usuario_id)
    if vendedor is not None and vendedor.status == VENDEDOR_ACTIVO:
        raise ConflictError(
            "Ya eres responsable comercial en Z.",
            code="seller_already_active",
        )

    viva = await db.scalar(
        select(SellerApplication).where(
            SellerApplication.profile_id == usuario_id,
            SellerApplication.status.in_(POSTULACIONES_VIVAS),
        )
    )
    if viva is not None and viva.status not in EDITABLES:
        raise PostulacionNoEditable(
            "Tu postulación ya está en revisión y no se puede cambiar.",
            details={"status": viva.status},
        )

    if viva is None:
        viva = SellerApplication(
            profile_id=usuario_id,
            status=POSTULACION_BORRADOR,
            display_name=nombre,
            proposal=propuesta,
        )
        db.add(viva)
        await db.flush()
    else:
        viva.display_name = nombre
        viva.proposal = propuesta
        viva.updated_at = ahora()
        await db.flush()

    await _reemplazar_documentos(
        db, postulacion=viva, documentos=limpios, usuario_id=usuario_id
    )
    return viva


def _exigir_documentos(crudos: list[dict] | None) -> list[dict]:
    if not crudos:
        return []
    if len(crudos) > MAXIMO_DE_DOCUMENTOS:
        raise ValidationAppError(
            "Demasiados documentos en una sola postulación.",
            code="seller_application_documents_too_many",
            details={"max": MAXIMO_DE_DOCUMENTOS},
        )
    limpios: list[dict] = []
    for d in crudos:
        tipo = str(d.get("kind") or "").strip()
        if tipo not in DOCUMENTOS:
            raise ValidationAppError(
                "Ese tipo de documento no existe.",
                code="seller_application_document_kind_invalid",
                details={"allowed": list(DOCUMENTOS)},
            )
        ruta = (d.get("storage_path") or "").strip() or None
        nota = (d.get("note") or "").strip() or None
        if ruta is None and nota is None:
            raise ValidationAppError(
                "Un documento necesita un archivo o una nota.",
                code="seller_application_document_empty",
            )
        if ruta is not None and "://" in ruta:
            raise ValidationAppError(
                "Se guarda la ruta del almacenamiento, no una URL.",
                code="seller_application_document_path_invalid",
            )
        if nota is not None and len(nota) > 2_000:
            raise ValidationAppError(
                "La nota del documento es demasiado larga.",
                code="seller_application_document_note_too_long",
            )
        limpios.append({"kind": tipo, "storage_path": ruta, "note": nota})
    return limpios


async def _reemplazar_documentos(
    db: AsyncSession,
    *,
    postulacion: SellerApplication,
    documentos: list[dict],
    usuario_id: str,
) -> None:
    """Se reemplazan enteros. Es lo que hace que guardar sea idempotente."""
    for fila in await db.scalars(
        select(SellerApplicationDocument).where(
            SellerApplicationDocument.application_id == postulacion.id
        )
    ):
        await db.delete(fila)
    await db.flush()
    for d in documentos:
        db.add(
            SellerApplicationDocument(
                application_id=postulacion.id, created_by=usuario_id, **d
            )
        )
    await db.flush()


async def enviar(
    db: AsyncSession, *, postulacion_id: str, usuario_id: str
) -> SellerApplication:
    """La manda a revisión. Con UPDATE CONDICIONAL: pulsar dos veces no cuenta
    dos."""
    await esquema.exigir_admision(db)
    postulacion = await _mia(db, postulacion_id=postulacion_id, usuario_id=usuario_id)
    if postulacion.status not in ENVIABLES:
        raise PostulacionNoEditable(
            "Esta postulación ya se envió.", details={"status": postulacion.status}
        )
    momento = ahora()
    await _mover(
        db,
        postulacion=postulacion,
        desde=POSTULACION_BORRADOR,
        hasta=POSTULACION_ENVIADA,
        valores={"submitted_at": momento, "updated_at": momento},
    )
    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="seller_application.submit",
        entity_type="seller_application",
        entity_id=postulacion.id,
        actor_role="user",
        previous_state=POSTULACION_BORRADOR,
        new_state=POSTULACION_ENVIADA,
    )
    return postulacion


async def retirar(
    db: AsyncSession, *, postulacion_id: str, usuario_id: str
) -> SellerApplication:
    """La retira quien la escribió. Solo antes de que se decida."""
    await esquema.exigir_admision(db)
    postulacion = await _mia(db, postulacion_id=postulacion_id, usuario_id=usuario_id)
    if postulacion.status not in POSTULACIONES_VIVAS:
        raise PostulacionNoEditable(
            "Esta postulación ya no está abierta.",
            details={"status": postulacion.status},
        )
    desde = postulacion.status
    momento = ahora()
    await _mover(
        db,
        postulacion=postulacion,
        desde=desde,
        hasta=POSTULACION_RETIRADA,
        valores={
            "updated_at": momento,
            # UNA RETIRADA TIENE FECHA DE ENVÍO aunque fuera un borrador: el
            # CHECK de la base solo exime a `draft`.
            "submitted_at": postulacion.submitted_at or momento,
        },
    )
    return postulacion


async def _mia(
    db: AsyncSession, *, postulacion_id: str, usuario_id: str
) -> SellerApplication:
    postulacion = await db.get(SellerApplication, postulacion_id)
    if postulacion is None or postulacion.profile_id != usuario_id:
        # 404 PARA LA AJENA, nunca 403.
        raise PostulacionNoEncontrada("Postulación no encontrada.")
    return postulacion


async def _mover(
    db: AsyncSession,
    *,
    postulacion: SellerApplication,
    desde: str,
    hasta: str,
    valores: dict,
) -> None:
    """UPDATE CONDICIONAL. Dos peticiones a la vez: una cambia una fila y la
    otra cero."""
    async with db.begin_nested() as punto:
        cambiadas = await db.execute(
            update(SellerApplication)
            .where(
                SellerApplication.id == postulacion.id,
                SellerApplication.status == desde,
            )
            .values(status=hasta, **valores)
        )
        if cambiadas.rowcount != 1:
            await punto.rollback()
    if cambiadas.rowcount != 1:
        raise ConflictError(
            "Alguien movió esta postulación mientras decidías.",
            code="seller_application_changed",
            details={"expected": desde},
        )
    await db.refresh(postulacion)


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
async def bandeja(
    db: AsyncSession, *, estado: str | None = None, limite: int = 50
) -> list[SellerApplication]:
    """Las que hay que mirar. Sin esquema, lista vacía."""
    if not await esquema.hay_admision(db):
        return []
    consulta = select(SellerApplication)
    if estado:
        consulta = consulta.where(SellerApplication.status == estado)
    else:
        consulta = consulta.where(
            SellerApplication.status.in_(
                (POSTULACION_ENVIADA, POSTULACION_EN_REVISION)
            )
        )
    return list(
        await db.scalars(
            consulta.order_by(
                SellerApplication.submitted_at.desc(), SellerApplication.id.desc()
            ).limit(max(1, min(int(limite), 200)))
        )
    )


async def tomar(
    db: AsyncSession, *, postulacion_id: str, usuario_id: str
) -> SellerApplication:
    """Alguien la está mirando. Se dice para que no la miren dos."""
    await permissions.exigir_evaluador(db, usuario_id)
    await esquema.exigir_admision(db)
    postulacion = await _cualquiera(db, postulacion_id)
    await _exigir_ajena(postulacion, usuario_id)
    if postulacion.status != POSTULACION_ENVIADA:
        raise PostulacionNoEditable(
            "Esta postulación no está esperando revisión.",
            details={"status": postulacion.status},
        )
    await _mover(
        db,
        postulacion=postulacion,
        desde=POSTULACION_ENVIADA,
        hasta=POSTULACION_EN_REVISION,
        valores={"updated_at": ahora()},
    )
    return postulacion


async def decidir(
    db: AsyncSession,
    *,
    postulacion_id: str,
    usuario_id: str,
    aceptar: bool,
    motivo: str | None = None,
    notas: str | None = None,
) -> tuple[SellerApplication, ProductSeller | None]:
    """Acepta o rechaza. Aceptar CREA la capacidad comercial, en la misma
    transacción.

    Una postulación aceptada sin `product_sellers` sería una persona a la que se
    le dijo que sí y que no puede postular nada.
    """
    # EL ROL, DESPUÉS DE COMPROBAR QUE NO ES LA SUYA: si fuera al revés, quien
    # no tiene permisos distinguiría un 403 de un 404 y sabría que existe.
    await esquema.exigir_admision(db)
    postulacion = await _cualquiera(db, postulacion_id)
    await _exigir_ajena(postulacion, usuario_id)
    await permissions.exigir_publicador(db, usuario_id)

    if postulacion.status not in DECIDIBLES:
        raise PostulacionNoEditable(
            "Esta postulación no está esperando decisión.",
            details={"status": postulacion.status},
        )
    razon = (motivo or "").strip() or None
    if not aceptar and not razon:
        raise ValidationAppError(
            "Un rechazo necesita un motivo que se le pueda enseñar a la persona.",
            code="seller_application_reject_needs_reason",
        )
    if razon is not None and len(razon) > 2_000:
        raise ValidationAppError(
            "El motivo es demasiado largo.",
            code="seller_application_reason_too_long",
        )

    desde = postulacion.status
    momento = ahora()
    await _mover(
        db,
        postulacion=postulacion,
        desde=desde,
        hasta=POSTULACION_ACEPTADA if aceptar else POSTULACION_RECHAZADA,
        valores={
            "decided_at": momento,
            "decided_by": usuario_id,
            "decision_reason": razon,
            "internal_notes": (notas or "").strip() or postulacion.internal_notes,
            "updated_at": momento,
            "submitted_at": postulacion.submitted_at or momento,
        },
    )

    vendedor: ProductSeller | None = None
    if aceptar:
        vendedor = await _activar(
            db, postulacion=postulacion, usuario_id=usuario_id, momento=momento
        )

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="seller_application.decide",
        entity_type="seller_application",
        entity_id=postulacion.id,
        actor_role="admin",
        previous_state=desde,
        new_state=postulacion.status,
        reason=razon,
        payload={"seller_id": vendedor.id if vendedor is not None else None},
    )
    return postulacion, vendedor


async def _activar(
    db: AsyncSession,
    *,
    postulacion: SellerApplication,
    usuario_id: str,
    momento: datetime,
) -> ProductSeller:
    """Crea o reactiva la capacidad comercial. IDEMPOTENTE por perfil."""
    vendedor = await permissions.vendedor_de(db, postulacion.profile_id)
    if vendedor is None:
        vendedor = ProductSeller(
            profile_id=postulacion.profile_id,
            display_name=postulacion.display_name,
            status=VENDEDOR_ACTIVO,
            activated_at=momento,
            activated_by=usuario_id,
        )
        db.add(vendedor)
    else:
        vendedor.display_name = postulacion.display_name
        vendedor.status = VENDEDOR_ACTIVO
        vendedor.activated_at = vendedor.activated_at or momento
        vendedor.activated_by = vendedor.activated_by or usuario_id
        # REACTIVAR BORRA LA SUSPENSIÓN, y su motivo con ella: dejarlo haría
        # que una cuenta activa siguiera enseñando por qué estuvo suspendida.
        vendedor.suspended_at = None
        vendedor.suspension_reason = None
        vendedor.updated_at = momento
    await db.flush()
    return vendedor


async def _cualquiera(db: AsyncSession, postulacion_id: str) -> SellerApplication:
    postulacion = await db.get(SellerApplication, postulacion_id)
    if postulacion is None:
        raise PostulacionNoEncontrada("Postulación no encontrada.")
    return postulacion


async def _exigir_ajena(postulacion: SellerApplication, usuario_id: str) -> None:
    if postulacion.profile_id == usuario_id:
        raise ForbiddenError(
            "Nadie decide su propia postulación.",
            code="seller_application_self_review_forbidden",
        )


__all__ = [
    "DECIDIBLES",
    "EDITABLES",
    "ENVIABLES",
    "LARGO_DEL_NOMBRE",
    "LARGO_DE_LA_PROPUESTA",
    "MAXIMO_DE_DOCUMENTOS",
    "PostulacionNoEditable",
    "PostulacionNoEncontrada",
    "bandeja",
    "decidir",
    "documentos_de",
    "enviar",
    "guardar",
    "mia",
    "retirar",
    "tomar",
]
