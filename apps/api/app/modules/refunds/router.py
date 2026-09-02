"""Endpoints de devoluciones: los del alumno y los de administración.

DOS GRUPOS EN UN FICHERO, y separados por permisos y no por carpetas. Lo que
importa no es dónde vive el código sino que ninguna ruta de alumno pueda
aprobar nada y que ninguna acepte un importe del cliente.

QUIÉN PUEDE QUÉ, en una tabla:

    alumno          ver su garantía, pedir, ver lo suyo, retirar lo suyo
    administración  listar todo, tomar, aprobar, rechazar, reintentar, cancelar
    propietario     NADA de esto. Ni aparece.

El propietario del curso no aprueba, no rechaza, no ejecuta reembolsos y no ve
el motivo privado de nadie. Lo suyo está en `commerce`: la vista comercial de
sus ventas.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import (
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Course
from app.modules.commerce import liquidacion
from app.modules.commerce.models import Order
from app.modules.profiles.models import Profile
from app.modules.refunds import esquema, estados, politica
from app.modules.refunds import service as devoluciones
from app.modules.refunds.models import RefundRequest
from app.modules.refunds.schemas import (
    AdminDecision,
    AdminRefundRead,
    PolicyAcceptanceCreate,
    RefundEligibilityRead,
    RefundEventRead,
    RefundRequestCreate,
    RefundRequestRead,
    RepurchaseNoticeRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin

logger = logging.getLogger("renaser.refunds")

router = APIRouter(prefix="/payments", tags=["devoluciones"])
admin_router = APIRouter(prefix="/admin", tags=["devoluciones-admin"])


async def _exigir_disponible(db: AsyncSession) -> None:
    """503 si la 0049 no está aplicada o la función está apagada. Nunca un 500.

    Un 500 sale sin cabeceras CORS y el navegador lo reporta como fallo de red,
    que manda a buscar el problema al sitio equivocado. Es la lección de la
    0027, escrita en `recommendations/esquema.py`.
    """
    if not get_settings().feature_course_refunds:
        raise ServiceUnavailableError(
            "Las devoluciones no están disponibles.", code="refunds_disabled"
        )
    if not await esquema.hay_devoluciones(db):
        raise ServiceUnavailableError(
            "Las devoluciones no están disponibles en esta base de datos.",
            code="refunds_not_available",
        )


async def _titulo(db: AsyncSession, course_id: str) -> str:
    curso = await db.get(Course, course_id)
    return curso.title if curso else ""


async def _a_lectura(db: AsyncSession, solicitud: RefundRequest) -> RefundRequestRead:
    return RefundRequestRead(
        id=solicitud.id,
        order_id=solicitud.order_id,
        course_id=solicitud.course_id,
        course_title=await _titulo(db, solicitud.course_id),
        status=solicitud.status,
        reason=solicitud.reason,
        explanation=solicitud.explanation,
        amount_minor=solicitud.amount_minor,
        currency=solicitud.currency,
        requested_at=solicitud.requested_at,
        resolved_at=solicitud.resolved_at,
        review_notes=solicitud.review_notes,
    )


# --------------------------------------------------------------------------- #
# Alumno
# --------------------------------------------------------------------------- #


@router.get(
    "/courses/{course_id}/refund-eligibility", response_model=RefundEligibilityRead
)
async def refund_eligibility(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RefundEligibilityRead:
    """Si esta persona puede pedir devolución de este curso, y hasta cuándo.

    RESPONDE AUNQUE ESTÉ TODO APAGADO. Con la función desactivada o la 0049 sin
    aplicar devuelve `eligible: false` con el código `disabled`, no un error: la
    ficha del curso tiene que poder pintarse igual.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    estado = await devoluciones.estado_de_garantia(
        db, user_id=current_user.id, course_id=course_id
    )
    return RefundEligibilityRead(
        server_time=estado.server_time,
        eligible=estado.elegible,
        reason_code=estado.motivo,
        first_accessed_at=estado.first_accessed_at,
        expires_at=estado.expires_at,
        seconds_remaining=estado.seconds_remaining,
        refund_used=estado.refund_used,
        refund_used_at=estado.refund_used_at,
        active_request_id=estado.request_id,
        active_request_status=estado.request_status,
        order_id=estado.order_id,
        amount_minor=estado.amount_minor,
        currency=estado.currency,
    )


@router.post(
    "/refund-requests",
    response_model=RefundRequestRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_solicitud(
    payload: RefundRequestCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RefundRequestRead:
    """Pedir devolución. El servidor revalida TODO.

    Que la pantalla haya enseñado el botón no autoriza nada: se vuelve a mirar
    la orden, el plazo, la devolución anterior y la solicitud activa, con la
    hora del servidor.
    """
    await _exigir_disponible(db)
    ensure_uuid(payload.order_id, "Compra no encontrada.")
    try:
        solicitud = await devoluciones.crear_solicitud(
            db,
            user_id=current_user.id,
            order_id=payload.order_id,
            reason=payload.reason,
            explanation=payload.explanation,
        )
    except devoluciones.NoElegible as error:
        raise ValidationAppError(
            "No se puede solicitar la devolución de esta compra.",
            code=f"refund_{error.motivo}",
        )

    # El dinero del propietario queda retenido mientras se resuelve.
    await liquidacion.congelar(
        db, order_id=solicitud.order_id, refund_request_id=solicitud.id
    )
    await db.commit()
    await _avisar_solicitud_recibida(db, solicitud)
    return await _a_lectura(db, solicitud)


@router.get("/refund-requests/mine", response_model=list[RefundRequestRead])
async def mis_solicitudes(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RefundRequestRead]:
    """Las mías, de la más reciente a la más antigua.

    Responde LISTA VACÍA y no un error cuando la 0049 no está: el historial de
    compras tiene que poder pintarse igual.
    """
    if not await esquema.hay_devoluciones(db):
        return []
    filas = await db.scalars(
        select(RefundRequest)
        .where(RefundRequest.user_id == current_user.id)
        .order_by(RefundRequest.requested_at.desc())
        .limit(100)
    )
    return [await _a_lectura(db, fila) for fila in filas]


@router.get("/refund-requests/{request_id}", response_model=RefundRequestRead)
async def mi_solicitud(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RefundRequestRead:
    await _exigir_disponible(db)
    solicitud = await _mia(db, request_id, current_user.id)
    return await _a_lectura(db, solicitud)


@router.post("/refund-requests/{request_id}/cancel", response_model=RefundRequestRead)
async def retirar_solicitud(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RefundRequestRead:
    """Retirar la propia solicitud. NO consume la garantía.

    Quien se arrepiente sigue teniendo sus 168 horas, si aún le quedan.
    """
    await _exigir_disponible(db)
    solicitud = await _mia(db, request_id, current_user.id)
    try:
        await devoluciones.transicionar(
            db,
            solicitud,
            hasta=estados.CANCELLED,
            rol="user",
            actor_id=current_user.id,
            reason="retirada por quien la pidió",
        )
    except estados.TransicionInvalida as error:
        raise ValidationAppError(str(error), code="refund_invalid_transition")
    # El propietario recupera su saldo pendiente.
    await liquidacion.descongelar(db, order_id=solicitud.order_id)
    await db.commit()
    return await _a_lectura(db, solicitud)


async def _mia(db: AsyncSession, request_id: str, user_id: str) -> RefundRequest:
    ensure_uuid(request_id, "Solicitud no encontrada.")
    solicitud = await db.get(RefundRequest, request_id)
    # Mismo mensaje para «no existe» y «es de otro»: distinguirlos permitiría
    # comprobar si un identificador ajeno es real.
    if solicitud is None or solicitud.user_id != user_id:
        raise NotFoundError("Solicitud no encontrada.")
    return solicitud


# --------------------------------------------------------------------------- #
# Recompra sin garantía
# --------------------------------------------------------------------------- #


@router.get(
    "/courses/{course_id}/repurchase-notice", response_model=RepurchaseNoticeRead
)
async def aviso_de_recompra(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RepurchaseNoticeRead:
    """Qué hay que enseñarle antes de dejarle comprar otra vez.

    El texto viene del SERVIDOR. Si viviera en la aplicación cambiaría con cada
    despliegue y las aceptaciones antiguas apuntarían a una redacción que ya no
    existe; entonces «lo aceptó» no significaría nada.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    if not await esquema.hay_devoluciones(db):
        return RepurchaseNoticeRead(requires_acceptance=False)

    usada = await devoluciones.ya_devolvio(
        db, user_id=current_user.id, course_id=course_id
    )
    if usada is None:
        return RepurchaseNoticeRead(requires_acceptance=False)
    if await devoluciones.tiene_aceptacion(
        db, user_id=current_user.id, course_id=course_id
    ):
        return RepurchaseNoticeRead(
            requires_acceptance=False, refund_used_at=usada
        )

    legible = usada.date().isoformat()
    return RepurchaseNoticeRead(
        requires_acceptance=True,
        policy_version=politica.VERSION_ACTUAL,
        notice=politica.texto_de_recompra(legible),
        checkbox_label=politica.CASILLA_DE_ACEPTACION,
        refund_used_at=usada,
    )


@router.post("/repurchase-acceptance", status_code=status.HTTP_204_NO_CONTENT)
async def aceptar_recompra(
    payload: PolicyAcceptanceCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Guarda la aceptación, con la huella del texto exacto que se mostró."""
    await _exigir_disponible(db)
    ensure_uuid(payload.course_id, "Curso no encontrado.")
    if not payload.accepted:
        raise ValidationAppError(
            "Hay que aceptar la condición para continuar.",
            code="refund_acceptance_required",
        )
    usada = await devoluciones.ya_devolvio(
        db, user_id=current_user.id, course_id=payload.course_id
    )
    if usada is None:
        # No hay nada que aceptar: esta compra sí tiene garantía.
        raise ValidationAppError(
            "Esta compra no necesita aceptación.", code="refund_acceptance_not_needed"
        )
    await devoluciones.registrar_aceptacion(
        db,
        user_id=current_user.id,
        course_id=payload.course_id,
        order_id=None,
        fecha_legible=usada.date().isoformat(),
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
#
# `require_admin` en TODAS. Se diseña para que mañana se pueda cambiar por un
# permiso `refund_manager` sin tocar los endpoints: la comprobación está en un
# solo sitio.


async def _exigir_gestor(db: AsyncSession, current_user: AuthUser) -> None:
    """Quién puede gestionar devoluciones.

    Hoy: el rol de administración que ya existe. Mañana puede ser un permiso
    propio (`refund_manager`) y solo cambia esta función.

    LO QUE NUNCA SERÁ: el autor del curso. Aprobar la devolución de lo que uno
    vende es juez y parte, y además le daría acceso al motivo privado de quien
    la pide.
    """
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("No puedes gestionar devoluciones.")


@admin_router.get("/refund-requests", response_model=list[AdminRefundRead])
async def listar_solicitudes(
    estado_filtro: str | None = Query(default=None, alias="status"),
    buscar: str | None = Query(default=None, alias="q"),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AdminRefundRead]:
    """La bandeja. Se ordena por antigüedad: lo que lleva más esperando, arriba."""
    await _exigir_gestor(db, current_user)
    if not await esquema.hay_devoluciones(db):
        return []

    consulta = select(RefundRequest)
    if estado_filtro:
        if estado_filtro not in estados.ESTADOS:
            raise ValidationAppError("Estado no válido.", code="refund_bad_status")
        consulta = consulta.where(RefundRequest.status == estado_filtro)
    if buscar:
        patron = f"%{buscar.strip()}%"
        consulta = consulta.where(
            RefundRequest.order_id.ilike(patron)
            | RefundRequest.user_id.ilike(patron)
            | RefundRequest.course_id.ilike(patron)
        )
    filas = await db.scalars(
        consulta.order_by(RefundRequest.requested_at).offset(page.offset).limit(page.limit)
    )
    return [await _a_lectura_admin(db, fila, con_historial=False) for fila in filas]


@admin_router.get("/refund-requests/{request_id}", response_model=AdminRefundRead)
async def detalle_de_solicitud(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    await _exigir_gestor(db, current_user)
    await _exigir_disponible(db)
    solicitud = await _cualquiera(db, request_id)
    return await _a_lectura_admin(db, solicitud, con_historial=True)


@admin_router.post("/refund-requests/{request_id}/take", response_model=AdminRefundRead)
async def tomar(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Tomarla para revisarla. Es lo que impide que dos personas la trabajen."""
    return await _mover(
        db, request_id, current_user, hasta=estados.UNDER_REVIEW, notes=None
    )


@admin_router.post(
    "/refund-requests/{request_id}/approve", response_model=AdminRefundRead
)
async def aprobar(
    payload: AdminDecision,
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Aprobar. REVALIDA la elegibilidad antes de mover nada.

    Entre pedir y aprobar pueden pasar días, y en ese hueco la persona puede
    haber devuelto ya el curso por otra vía. Aprobar sin volver a mirar es
    exactamente como se pagan dos reembolsos del mismo dinero.

    APROBAR NO RETIRA EL ACCESO. Solo autoriza pedirle el reembolso a la
    pasarela; el acceso se retira cuando el dinero vuelve, y no antes.
    """
    await _exigir_gestor(db, current_user)
    await _exigir_disponible(db)
    solicitud = await _cualquiera(db, request_id)

    ya = await devoluciones.ya_devolvio(
        db, user_id=solicitud.user_id, course_id=solicitud.course_id
    )
    if ya is not None:
        raise ValidationAppError(
            "Esta persona ya usó su garantía en este curso.",
            code="refund_already_refunded",
        )

    await _transicion(
        db, solicitud, estados.APPROVED, current_user, notes=payload.notes
    )
    await db.commit()
    await _avisar_estado(db, solicitud, "approved")
    return await _a_lectura_admin(db, solicitud, con_historial=True)


@admin_router.post("/refund-requests/{request_id}/reject", response_model=AdminRefundRead)
async def rechazar(
    payload: AdminDecision,
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Rechazar. El motivo es OBLIGATORIO.

    Un rechazo sin motivo es indefendible ante quien lo recibe y ante quien
    tenga que revisarlo después. Y NO consume la garantía: si aún le queda
    plazo, puede volver a pedirlo.
    """
    await _exigir_gestor(db, current_user)
    await _exigir_disponible(db)
    if not (payload.notes or "").strip():
        raise ValidationAppError(
            "Hay que explicar por qué se rechaza.", code="refund_reason_required"
        )
    solicitud = await _cualquiera(db, request_id)
    await _transicion(
        db, solicitud, estados.REJECTED, current_user, notes=payload.notes
    )
    # El propietario recupera su saldo: no hubo devolución.
    await liquidacion.descongelar(db, order_id=solicitud.order_id)
    await db.commit()
    await _avisar_estado(db, solicitud, "rejected")
    return await _a_lectura_admin(db, solicitud, con_historial=True)


@admin_router.post("/refund-requests/{request_id}/retry", response_model=AdminRefundRead)
async def reintentar(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Volver a intentar un reembolso que la pasarela no pudo completar."""
    return await _mover(
        db, request_id, current_user, hasta=estados.REFUND_PROCESSING, notes=None
    )


@admin_router.post("/refund-requests/{request_id}/cancel", response_model=AdminRefundRead)
async def cancelar_admin(
    payload: AdminDecision,
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Cerrar un expediente muerto. No consume la garantía."""
    resultado = await _mover(
        db, request_id, current_user, hasta=estados.CANCELLED, notes=payload.notes
    )
    return resultado


async def _mover(
    db: AsyncSession,
    request_id: str,
    current_user: AuthUser,
    *,
    hasta: str,
    notes: str | None,
) -> AdminRefundRead:
    await _exigir_gestor(db, current_user)
    await _exigir_disponible(db)
    solicitud = await _cualquiera(db, request_id)
    await _transicion(db, solicitud, hasta, current_user, notes=notes)
    if hasta == estados.CANCELLED:
        await liquidacion.descongelar(db, order_id=solicitud.order_id)
    await db.commit()
    return await _a_lectura_admin(db, solicitud, con_historial=True)


async def _transicion(
    db: AsyncSession,
    solicitud: RefundRequest,
    hasta: str,
    current_user: AuthUser,
    *,
    notes: str | None,
) -> None:
    try:
        await devoluciones.transicionar(
            db,
            solicitud,
            hasta=hasta,
            rol="admin",
            actor_id=current_user.id,
            notes=notes,
        )
    except estados.TransicionInvalida as error:
        # 409 y no 500: dos administradores pulsando a la vez es algo que pasa,
        # no un fallo del servidor. El segundo se entera de que llegó tarde.
        raise ValidationAppError(str(error), code="refund_invalid_transition")


async def _cualquiera(db: AsyncSession, request_id: str) -> RefundRequest:
    ensure_uuid(request_id, "Solicitud no encontrada.")
    solicitud = await db.get(RefundRequest, request_id)
    if solicitud is None:
        raise NotFoundError("Solicitud no encontrada.")
    return solicitud


async def _a_lectura_admin(
    db: AsyncSession, solicitud: RefundRequest, *, con_historial: bool
) -> AdminRefundRead:
    base = await _a_lectura(db, solicitud)
    perfil = await db.get(Profile, solicitud.user_id)
    historial: list[RefundEventRead] = []
    if con_historial:
        historial = [
            RefundEventRead.model_validate(evento)
            for evento in await devoluciones.historial(db, solicitud.id)
        ]
    return AdminRefundRead(
        **base.model_dump(),
        user_id=solicitud.user_id,
        user_name=(perfil.full_name if perfil else "") or "",
        reviewer_id=solicitud.reviewer_id,
        external_refund_id=solicitud.external_refund_id,
        provider=solicitud.provider,
        environment=solicitud.environment,
        progress_percent=await _progreso(db, solicitud),
        history=historial,
    )


async def _progreso(db: AsyncSession, solicitud: RefundRequest) -> int:
    """Cuánto ha visto, como CONTEXTO.

    En V1 no rechaza nada por sí solo: una solicitud que entró en plazo entra en
    plazo, haya visto una lección o todas. Se enseña porque ayuda a decidir en
    los casos raros, no porque decida.
    """
    from app.modules.catalog.models import CourseLesson, CourseModule
    from app.modules.learning.models import LessonProgress
    from sqlalchemy import func

    total = await db.scalar(
        select(func.count())
        .select_from(CourseLesson)
        .join(CourseModule, CourseModule.id == CourseLesson.module_id)
        .where(CourseModule.course_id == solicitud.course_id)
    )
    if not total:
        return 0
    hechas = await db.scalar(
        select(func.count())
        .select_from(LessonProgress)
        .join(CourseLesson, CourseLesson.id == LessonProgress.lesson_id)
        .join(CourseModule, CourseModule.id == CourseLesson.module_id)
        .where(
            CourseModule.course_id == solicitud.course_id,
            LessonProgress.user_id == solicitud.user_id,
            LessonProgress.completed.is_(True),
        )
    )
    return int((hechas or 0) * 100 / total)


# --------------------------------------------------------------------------- #
# Avisos
# --------------------------------------------------------------------------- #
#
# Moderados a propósito: uno al recibir y uno por resolución. Un aviso por cada
# actualización técnica —«el reembolso sigue en trámite»— convierte la bandeja
# en ruido y hace que se dejen de leer los que importan.


async def _avisar_solicitud_recibida(db: AsyncSession, solicitud: RefundRequest) -> None:
    from app.modules.notifications.service import add_notification

    try:
        await add_notification(
            db,
            user_id=solicitud.user_id,
            actor_id=None,
            type="refund_requested",
            entity_type="course",
            entity_id=solicitud.course_id,
            payload={"requestId": solicitud.id},
        )
        await db.commit()
    except Exception:  # noqa: BLE001
        # Un aviso que no sale NO puede tumbar una solicitud ya guardada.
        logger.exception("[devoluciones] no se pudo avisar de la solicitud")


async def _avisar_estado(db: AsyncSession, solicitud: RefundRequest, tipo: str) -> None:
    from app.modules.notifications.service import add_notification

    try:
        await add_notification(
            db,
            user_id=solicitud.user_id,
            actor_id=None,
            type=f"refund_{tipo}",
            entity_type="course",
            entity_id=solicitud.course_id,
            payload={"requestId": solicitud.id},
        )
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("[devoluciones] no se pudo avisar del estado %s", tipo)
