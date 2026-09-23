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
from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import func, select
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
from app.modules.gobernanza import auditoria, consentimientos
from app.modules.gobernanza import politicas as politicas_compartidas
from app.modules.gobernanza.contexto import leer_origen
from app.modules.refunds import esquema, estados, politica, validacion
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
from app.shared.permissions import puede_mover_dinero

logger = logging.getLogger("renaser.refunds")

router = APIRouter(prefix="/payments", tags=["devoluciones"])
admin_router = APIRouter(prefix="/admin", tags=["devoluciones-admin"])


async def _exigir_esquema(db: AsyncSession) -> None:
    """503 —nunca un 500— si la 0049 no está aplicada. NO mira la bandera.

    Es lo que exigen las operaciones sobre expedientes que YA existen. Apagar la
    recepción de solicitudes nuevas no puede dejar sin resolver las abiertas: el
    dinero ya está retenido y alguien tiene que poder decidir.
    """
    if not await esquema.hay_devoluciones(db):
        raise ServiceUnavailableError(
            "Las devoluciones no están disponibles en esta base de datos.",
            code="refunds_not_available",
        )


async def _exigir_solicitudes_nuevas(db: AsyncSession) -> None:
    """Además del esquema, que la bandera admita solicitudes NUEVAS."""
    await _exigir_esquema(db)
    if not get_settings().feature_course_refunds:
        raise ServiceUnavailableError(
            "Las devoluciones no están disponibles.", code="refunds_disabled"
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
        guarantee_hours=devoluciones.HORAS_DE_GARANTIA,
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
    await _exigir_solicitudes_nuevas(db)
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
    await _exigir_esquema(db)
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
    await _exigir_esquema(db)
    solicitud = await _mia(db, request_id, current_user.id)
    if solicitud.status not in RETIRABLES:
        # UNA VEZ APROBADA YA NO ES SUYA. Administracion pudo devolver el dinero
        # a mano antes de que llegue el webhook; retirarla ahi descongelaba el
        # saldo del propietario y lo dejaba pagable con el reembolso en marcha.
        raise ValidationAppError(
            "Esta solicitud ya está resuelta y no se puede retirar.",
            code="refund_not_withdrawable",
        )
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
    await liquidacion.descongelar(
        db, order_id=solicitud.order_id, refund_request_id=solicitud.id
    )
    await db.commit()
    return await _a_lectura(db, solicitud)


#: Desde donde puede retirarla QUIEN LA PIDIO. Administracion puede cerrar
#: expedientes muertos desde mas sitios; el alumno, solo mientras nadie haya
#: decidido nada todavia.
RETIRABLES = frozenset({estados.REQUESTED, estados.UNDER_REVIEW})


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
    request: Request,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Guarda la aceptación, con la huella del texto exacto que se mostró."""
    await _exigir_esquema(db)
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
    fecha_legible = usada.date().isoformat()
    await devoluciones.registrar_aceptacion(
        db,
        user_id=current_user.id,
        course_id=payload.course_id,
        order_id=None,
        fecha_legible=fecha_legible,
        provider=payload.provider,
        external_product_id=payload.product_id,
    )

    # ------------------------------------------------------------------ #
    # TRAZABILIDAD ADICIONAL (0050). No cambia ninguna decisión.
    #
    # `refund_policy_acceptances` SIGUE SIENDO LA AUTORIDAD: es la que consulta
    # el checkout para dejar comprar, y moverla de sitio en la misma ronda en
    # que se crea la tabla nueva sería cambiar un flujo legal y su almacén a la
    # vez. Lo que se añade aquí es lo que a aquella le faltaba: de dónde vino la
    # aceptación —huella de IP, prefijo de red, familia del navegador,
    # identificador de petición— y un rastro auditable.
    #
    # SI ALGO DE ESTO FALLA, LA ACEPTACIÓN NO SE PIERDE: va en un savepoint. El
    # caso concreto es que la política todavía no esté sembrada, que es lo
    # normal hasta que alguien llame al endpoint de siembra después de aplicar
    # la 0050. Bloquear una compra por eso sería una regresión.
    # ------------------------------------------------------------------ #
    origen = leer_origen(request)
    consentimiento = None
    try:
        async with db.begin_nested():
            consentimiento = await consentimientos.registrar(
                db,
                subject_id=current_user.id,
                policy_type=politicas_compartidas.RECOMPRA,
                # EL TEXTO EXACTO que se le enseñó, con su fecha dentro. La
                # huella de la plantilla no demostraría nada.
                texto_mostrado=(
                    politica.texto_de_recompra(fecha_legible)
                    + "\n"
                    + politica.CASILLA_DE_ACEPTACION
                ),
                scope_kind="course",
                scope_id=payload.course_id,
                origen=origen,
            )
    except Exception:  # noqa: BLE001
        # CUALQUIER fallo, no solo la politica sin sembrar. Capturar unicamente
        # `PoliticaAusente` dejaba pasar el resto —un CHECK incumplido, la 0050
        # a medias— y esos SI tumbaban la peticion entera: la aceptacion legal,
        # que ya estaba volcada, se perdia con el `rollback` de la dependencia y
        # la compra quedaba bloqueada. Lo accesorio no puede tumbar lo principal.
        logger.warning(
            "[devoluciones] la aceptacion se guardo en refund_policy_acceptances "
            "pero no se pudo registrar el consentimiento compartido",
            exc_info=True,
        )

    # SAVEPOINT APARTE PARA LA ANOTACION, y esta separacion es el motivo de que
    # haya dos bloques y no uno. Compartiendo savepoint, un fallo al anotar
    # —una tabla de auditoria a medias, un `payload` que no pasa el filtro—
    # deshacia tambien el `consent_record` que ya se habia creado bien: se
    # perdia la prueba del consentimiento por no poder escribir su nota. El
    # consentimiento es el dato con valor legal; la nota es el rastro.
    try:
        async with db.begin_nested():
            await auditoria.anotar(
                db,
                action="consent.accepted",
                entity_type="course",
                entity_id=payload.course_id,
                actor_id=current_user.id,
                actor_role="user",
                reason="recompra sin garantia",
                payload={
                    "policy_type": politicas_compartidas.RECOMPRA,
                    "consent_id": consentimiento.id if consentimiento else None,
                },
                origen=origen,
            )
    except Exception:  # noqa: BLE001
        logger.warning(
            "[devoluciones] la aceptacion quedo guardada pero no se pudo anotar "
            "en la auditoria",
            exc_info=True,
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

    `puede_mover_dinero` y NO `is_admin`. Parecen lo mismo y no lo son:
    `is_admin` incluye el rol `moderator`, que existe para ocultar una
    publicación o resolver un reporte. Con él, esa misma cuenta podía aprobar y
    ejecutar un reembolso real contra la pasarela y leer el motivo privado de
    cualquier alumno. Moderar contenido no es administrar dinero.

    LO QUE NUNCA SERÁ: el autor del curso. Aprobar la devolución de lo que uno
    vende es juez y parte, y además le daría acceso al motivo privado de quien
    la pide.
    """
    if not await puede_mover_dinero(db, current_user.id):
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
        # CAST A TEXTO. Las tres columnas son `uuid` en PostgreSQL y no existe
        # el operador `uuid ~~* text`: la bandeja daba 500 en cuanto alguien
        # escribia algo en el buscador. En SQLite pasaba porque ahi los UUID se
        # guardan como texto, asi que las pruebas no lo veian.
        from sqlalchemy import String, cast

        patron = f"%{buscar.strip()}%"
        consulta = consulta.where(
            cast(RefundRequest.order_id, String).ilike(patron)
            | cast(RefundRequest.user_id, String).ilike(patron)
            | cast(RefundRequest.course_id, String).ilike(patron)
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
    await _exigir_esquema(db)
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
    await _exigir_esquema(db)
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

    # Aprobar autoriza; ejecutar es otra cosa y va detras de su propia bandera.
    await ejecutar_reembolso(db, solicitud, actor_id=current_user.id)
    return await _a_lectura_admin(db, solicitud, con_historial=True)


async def ejecutar_reembolso(
    db: AsyncSession, solicitud: RefundRequest, *, actor_id: str | None
) -> None:
    """Pedirle a la pasarela que devuelva el dinero. NO retira acceso.

    Tres capas de idempotencia: no se pide nada si ya hay `external_refund_id`;
    la clave solo cambia tras un fallo TERMINAL; y la transicion a
    `refund_processing` es un UPDATE condicional, asi que dos administradores
    simultaneos solo consiguen una ejecucion.

    Con `STRIPE_REFUNDS_ENABLED` apagado no se llama a nadie y la solicitud se
    queda como estaba: nunca se intento, asi que declararla fallida seria mentir.
    """
    from app.modules.payments.reembolsos import (
        RefundRequestToProvider,
        clave_de_idempotencia,
        proveedor_de_reembolsos,
    )

    if solicitud.external_refund_id:
        logger.info(
            "[devoluciones] la solicitud %s ya tiene reembolso %s; no se repite",
            solicitud.id,
            solicitud.external_refund_id,
        )
        return

    if not get_settings().stripe_refunds_enabled:
        # NO SE INTENTO NADA: se anota y se deja el estado como esta. Marcarla
        # `failed` invitaria a reintentar un fallo que no existio.
        await devoluciones._anotar(
            db,
            solicitud,
            desde=solicitud.status,
            hasta=solicitud.status,
            rol="system",
            actor_id=actor_id,
            reason=(
                "ejecucion externa PENDIENTE de habilitacion: los reembolsos por "
                "pasarela estan desactivados o sin configurar. No se pidio nada."
            ),
            metadata={"provider_execution": "disabled"},
        )
        await db.commit()
        logger.info(
            "[devoluciones] solicitud %s aprobada sin ejecutar: pasarela apagada",
            solicitud.id,
        )
        return

    transaccion = await _transaccion_de_la_orden(db, solicitud.order_id)
    if not transaccion:
        await _marcar_fallo(
            db,
            solicitud,
            codigo="no_transaction",
            mensaje="No se encontro el cobro original que devolver.",
        )
        return

    if solicitud.status != estados.REFUND_PROCESSING:
        try:
            await devoluciones.transicionar(
                db,
                solicitud,
                hasta=estados.REFUND_PROCESSING,
                rol="admin",
                actor_id=actor_id,
                reason="reembolso pedido a la pasarela",
            )
            await db.commit()
        except estados.TransicionInvalida:
            # Otro lo esta ejecutando ya. Que gane el primero.
            return
    elif not await _tomar_el_turno(db, solicitud):
        # Ya estaba en `refund_processing`: la transicion de arriba no corre, y
        # sin esto no quedaria NINGUNA serializacion. N administradores pulsando
        # «Reintentar» a la vez lanzarian N peticiones en paralelo y la unica
        # defensa seria la clave de idempotencia.
        return

    proveedor = proveedor_de_reembolsos()
    resultado = await proveedor.create_full_refund(
        RefundRequestToProvider(
            external_transaction_id=transaccion,
            amount_minor=solicitud.amount_minor,
            currency=solicitud.currency,
            idempotency_key=clave_de_idempotencia(
                solicitud.id, await _fallos_terminales(db, solicitud.id)
            ),
            metadata={"refundRequestId": solicitud.id, "orderId": solicitud.order_id},
        )
    )

    # SOLO SI ES UN `re_...` DE VERDAD. Guardar cualquier cadena que devuelva
    # la pasarela es como el expediente acabo con un `payment_intent` dentro:
    # conciliar preguntaba por un identificador inexistente, para siempre.
    referencia_valida = ""
    if resultado.external_refund_id:
        try:
            referencia_valida = validacion.exigir_referencia(
                resultado.external_refund_id
            )
        except validacion.NoConciliado as error:
            logger.error(
                "[devoluciones] la pasarela devolvio una referencia que no es un "
                "reembolso en la solicitud %s: %s",
                solicitud.id,
                error,
            )
    if referencia_valida:
        solicitud.external_refund_id = referencia_valida
        await db.flush()

    if resultado.status == "failed":
        await _marcar_fallo(
            db,
            solicitud,
            codigo=resultado.failure_code or "provider_failed",
            mensaje=resultado.failure_message or "La pasarela no pudo devolver.",
        )
        return

    if resultado.status not in {"succeeded", "pending"}:
        # Ni por buena ni por descartada: `unknown_status` es ambiguo, asi que
        # el reintento repite clave en vez de arriesgar un segundo reembolso.
        await _marcar_fallo(
            db,
            solicitud,
            codigo="unknown_status",
            mensaje=f"Respuesta no reconocida: {resultado.status!r}.",
        )
        return

    if not (solicitud.external_refund_id or "").strip():
        # Aceptado PERO sin identificador: es lo que deja un tiempo de espera
        # agotado. Sin referencia no hay nada que conciliar, asi que se registra
        # como fallo ambiguo y queda el reintento con la misma clave.
        await _marcar_fallo(
            db,
            solicitud,
            codigo=resultado.failure_code or "no_refund_reference",
            mensaje=(
                resultado.failure_message
                or "La pasarela acepto sin devolver identificador."
            ),
        )
        return

    # `succeeded` incluido: se queda en `refund_processing` a la espera del
    # webhook. La respuesta sincrona no se concilia con la orden ni con el
    # entorno; el webhook si, y es el que retira el acceso.
    await devoluciones._anotar(
        db,
        solicitud,
        desde=solicitud.status,
        hasta=solicitud.status,
        rol="system",
        actor_id=None,
        reason=f"la pasarela respondio '{resultado.status}'",
        external_reference=referencia_valida or None,
        metadata={"provider_status": resultado.status},
    )
    await db.commit()


async def _transaccion_de_la_orden(db: AsyncSession, order_id: str) -> str:
    """El identificador del COBRO original, que es lo que se devuelve."""
    from app.modules.commerce.models import PaymentTransaction

    referencia = await db.scalar(
        select(PaymentTransaction.external_transaction_id)
        .where(
            PaymentTransaction.order_id == order_id,
            PaymentTransaction.kind == "purchase",
        )
        .order_by(PaymentTransaction.created_at.desc())
        .limit(1)
    )
    return referencia or ""


async def _tomar_el_turno(db: AsyncSession, solicitud: RefundRequest) -> bool:
    """Serializa el reintento desde `refund_processing`. UPDATE condicional.

    Estampa `updated_at` solo si la fila sigue en `refund_processing` y sin
    referencia. Dos peticiones simultaneas: la primera afecta a una fila y la
    segunda a cero, asi que solo una llega a la pasarela. Sin esto, la clave de
    idempotencia seria la unica defensa contra el doble cobro.
    """
    from sqlalchemy import update

    resultado = await db.execute(
        update(RefundRequest)
        .where(
            RefundRequest.id == solicitud.id,
            RefundRequest.status == estados.REFUND_PROCESSING,
            RefundRequest.external_refund_id.is_(None),
            RefundRequest.updated_at == solicitud.updated_at,
        )
        .values(updated_at=devoluciones.ahora())
    )
    await db.commit()
    return resultado.rowcount > 0


async def _fallos_terminales(db: AsyncSession, refund_request_id: str) -> int:
    """Cuantas veces dijo la pasarela que NO, de forma CONCLUYENTE.

    Contar TODOS los `failed` era el fallo: un 502 o un timeout subia el numero
    y el siguiente intento mandaba una clave NUEVA, que es como se paga dos
    veces el mismo reembolso.

    Se clasifica el `reason` en Python con `es_terminal` —la unica funcion que
    decide esto— en vez de consultar dentro del `jsonb`/`JSON`: eso no es
    portable a SQLite y los eventos antiguos no llevan el metadato. Y sale de lo
    PERSISTIDO, asi que sobrevive a un reinicio.
    """
    from app.modules.payments.reembolsos import es_terminal
    from app.modules.refunds.models import RefundRequestEvent

    motivos = await db.scalars(
        select(RefundRequestEvent.reason).where(
            RefundRequestEvent.refund_request_id == refund_request_id,
            RefundRequestEvent.to_status == estados.FAILED,
        )
    )
    return sum(1 for motivo in motivos if es_terminal(motivo or ""))


async def _marcar_fallo(
    db: AsyncSession, solicitud: RefundRequest, *, codigo: str, mensaje: str
) -> None:
    """Registra el fallo. SOLO uno TERMINAL mueve el expediente a `failed`.

    Un fallo AMBIGUO —timeout, 5xx, respuesta sin identificador— deja la
    solicitud en `refund_processing`, y eso es deliberado: el reembolso pudo
    crearse, asi que tiene que poder cerrarlo el webhook, que desde `failed` ya
    no podria. El reintento desde ahi repite la MISMA clave.
    """
    from app.modules.payments.reembolsos import es_terminal, sanear_codigo

    # SANEADO ANTES DE CLASIFICAR Y DE GUARDAR, y en ese orden: la decision se
    # toma sobre el mismo valor que queda escrito en el historial. Lo escribe
    # la pasarela, asi que ni su forma ni su longitud las decidimos nosotros.
    codigo = sanear_codigo(codigo)
    terminal = es_terminal(codigo)
    mensaje = (mensaje or "")[:300]
    try:
        if terminal and solicitud.status == estados.REFUND_PROCESSING:
            await devoluciones.transicionar(
                db,
                solicitud,
                hasta=estados.FAILED,
                rol="system",
                actor_id=None,
                reason=codigo,
                notes=mensaje,
                metadata={"terminal": True},
            )
        else:
            await devoluciones._anotar(
                db,
                solicitud,
                desde=solicitud.status,
                hasta=solicitud.status,
                rol="system",
                actor_id=None,
                reason=codigo,
                notes=mensaje,
                metadata={"terminal": terminal},
            )
        await db.commit()
    except estados.TransicionInvalida:
        logger.warning(
            "[devoluciones] no se pudo marcar el fallo de %s", solicitud.id
        )


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
    await _exigir_esquema(db)
    if not (payload.notes or "").strip():
        raise ValidationAppError(
            "Hay que explicar por qué se rechaza.", code="refund_reason_required"
        )
    solicitud = await _cualquiera(db, request_id)
    await _transicion(
        db, solicitud, estados.REJECTED, current_user, notes=payload.notes
    )
    # El propietario recupera su saldo: no hubo devolución.
    await liquidacion.descongelar(
        db, order_id=solicitud.order_id, refund_request_id=solicitud.id
    )
    await db.commit()
    await _avisar_estado(db, solicitud, "rejected")
    return await _a_lectura_admin(db, solicitud, con_historial=True)


#: Desde donde se puede ejecutar: `failed` (la pasarela dijo que no), `approved`
#: (se aprobo con la pasarela apagada) y `refund_processing` (un intento se
#: quedo sin respuesta). El tercero es el que antes no tenia salida: `retry`
#: solo aceptaba `failed` y `reconcile` exige identificador externo.
EJECUTABLES = frozenset({estados.FAILED, estados.APPROVED, estados.REFUND_PROCESSING})

#: Y desde donde tiene sentido PREGUNTARLE a la pasarela como acabo. Es lo
#: mismo mas `refunded`, que es inofensivo: `aplicar` devuelve False si ya
#: estaba aplicado, asi que conciliar dos veces no revoca ni notifica dos veces.
CONCILIABLES = EJECUTABLES | {estados.REFUNDED}


@admin_router.post("/refund-requests/{request_id}/retry", response_model=AdminRefundRead)
async def reintentar(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Ejecutar —o volver a ejecutar— el reembolso en la pasarela.

    NUNCA CREA UN SEGUNDO REEMBOLSO. Si ya hay `external_refund_id` no se pide
    nada: se le pregunta a la pasarela como acabo el que ya existe. Y si no lo
    hay, la clave de idempotencia solo cambia tras un fallo TERMINAL, asi que
    reintentar un timeout recupera la misma operacion en vez de duplicarla.
    """
    await _exigir_gestor(db, current_user)
    await _exigir_esquema(db)
    solicitud = await _cualquiera(db, request_id)
    if solicitud.status not in EJECUTABLES:
        raise ValidationAppError(
            "Esta solicitud no se puede ejecutar en su estado actual.",
            code="refund_invalid_transition",
        )
    if (solicitud.external_refund_id or "").strip():
        # LO QUE CONTESTA LA PASARELA AHORA, no el estado que arrastre el
        # expediente. Antes esta rama solo miraba `status == failed`, y ese
        # estado pudo escribirlo un aviso de OTRO reembolso del mismo cobro: se
        # soltaba una referencia VIVA y se pedia un segundo reembolso con clave
        # nueva. Los dos liquidaban.
        #
        # Se suelta la referencia solo si la pasarela acaba de confirmar, en
        # esta misma consulta, que ese reembolso murio.
        dice_la_pasarela = await _conciliar_con_pasarela(
            db, solicitud, actor_id=current_user.id
        )
        solicitud = await _cualquiera(db, request_id)
        if (
            dice_la_pasarela == "failed"
            and solicitud.status == estados.FAILED
            and (solicitud.external_refund_id or "").strip()
        ):
            solicitud.external_refund_id = None
            await db.commit()
            await ejecutar_reembolso(db, solicitud, actor_id=current_user.id)
            solicitud = await _cualquiera(db, request_id)
    else:
        await ejecutar_reembolso(db, solicitud, actor_id=current_user.id)
    return await _a_lectura_admin(db, solicitud, con_historial=True)


# --------------------------------------------------------------------------- #
# Conciliacion con la pasarela
# --------------------------------------------------------------------------- #
#
# PARA QUE EXISTE. Un reembolso pedido y aceptado se queda en
# `refund_processing` esperando el webhook. Si ese webhook se pierde —firma
# rotada, despliegue a mitad, la pasarela reintentando contra una URL vieja— el
# expediente se queda ahi para siempre: el dinero volvio y la persona sigue
# teniendo el curso, o al reves nadie sabe que paso. Conciliar es PREGUNTARLE a
# la pasarela, que es la unica que sabe la verdad.
#
# NO SE INVENTA NADA. Solo un 'succeeded' cierra, y cierra por el MISMO camino
# que el webhook (`reembolso.aplicar`), que ya concilia orden, entorno e importe
# y ya es idempotente. Un 'pending' no toca el acceso.


async def _conciliar_con_pasarela(
    db: AsyncSession, solicitud: RefundRequest, *, actor_id: str | None
) -> str:
    """Pregunta el estado real y actua. Devuelve lo que contesto la pasarela."""
    from app.modules.payments.reembolsos import proveedor_de_reembolsos
    from app.modules.refunds import reembolso

    referencia = solicitud.external_refund_id or ""
    # EL IDENTIFICADOR, EN UNA CADENA, ANTES DE QUE PUEDA HABER UN `rollback`.
    # `solicitud` es un objeto del ORM y una transaccion deshecha lo caduca: a
    # partir de ahi leerle un atributo dispara una recarga perezosa que en
    # asincrono lanza `MissingGreenlet` y tapa el error de verdad. Es el mismo
    # fallo que ya se corrigio en `_aplicar_reembolso_total`.
    id_de_la_solicitud = solicitud.id
    resultado = await proveedor_de_reembolsos().get_refund_status(referencia)

    if resultado.status == "succeeded":
        orden = await db.get(Order, solicitud.order_id)
        if orden is None:
            raise ValidationAppError(
                "La compra de esta solicitud ya no existe.",
                code="refund_order_missing",
            )
        try:
            # UNA transaccion: o se aplica todo o no se aplica nada. `aplicar`
            # devuelve False si ya estaba, asi que conciliar dos veces no
            # revoca dos veces ni notifica dos veces.
            aplicado = await reembolso.aplicar(
                db,
                orden=orden,
                external_transaction_id=referencia,
                # LO QUE DICE EL PROVEEDOR, tal cual. Antes se caia a
                # `solicitud.amount_minor` y a `solicitud.currency`, los dos
                # derivados de la orden: comparar eso con la orden es comparar
                # la orden consigo misma, y la comprobacion de «reembolso
                # TOTAL» no miraba nada. Si el proveedor no lo informa, el caso
                # se queda sin conciliar y el acceso no se toca.
                amount_minor=resultado.amount_minor,
                currency=resultado.currency,
                environment=orden.environment,
                solicitud=solicitud,
                motivo="conciliado con la pasarela",
            )
        except reembolso.NoConciliado as error:
            await db.rollback()
            solicitud = await _cualquiera(db, id_de_la_solicitud)
            await devoluciones._anotar(
                db,
                solicitud,
                desde=solicitud.status,
                hasta=solicitud.status,
                rol="system",
                actor_id=actor_id,
                reason="la conciliacion no cuadra con la orden",
                notes=str(error)[:500],
                metadata={"provider_status": "succeeded"},
            )
            await db.commit()
            raise ValidationAppError(str(error), code="refund_not_reconciled")

        await devoluciones._anotar(
            db,
            solicitud,
            desde=solicitud.status,
            hasta=solicitud.status,
            rol="system",
            actor_id=actor_id,
            reason="conciliacion con la pasarela",
            external_reference=referencia,
            # Identificadores y codigos. Nunca el cuerpo de la respuesta.
            metadata={"provider_status": "succeeded", "applied": aplicado},
        )
        await db.commit()
        return resultado.status

    if resultado.status == "failed":
        # `_marcar_fallo` ya distingue: transiciona si estaba en proceso y solo
        # anota si no. NO revoca acceso en ningun caso.
        await _marcar_fallo(
            db,
            solicitud,
            codigo=resultado.failure_code or "provider_failed",
            mensaje=(resultado.failure_message or "La pasarela no pudo devolver.")[:500],
        )
        return resultado.status

    # 'pending' y cualquier respuesta que no entendamos: NO se toca el estado y
    # NO se toca el acceso. Se deja constancia y se vuelve a preguntar luego.
    await devoluciones._anotar(
        db,
        solicitud,
        desde=solicitud.status,
        hasta=solicitud.status,
        rol="system",
        actor_id=actor_id,
        reason=f"conciliacion: la pasarela sigue diciendo '{resultado.status}'",
        external_reference=referencia or None,
        metadata={"provider_status": resultado.status},
    )
    await db.commit()
    return resultado.status


@admin_router.post(
    "/refund-requests/{request_id}/reconcile", response_model=AdminRefundRead
)
async def conciliar_solicitud(
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdminRefundRead:
    """Preguntarle a la pasarela como acabo de verdad este reembolso."""
    await _exigir_gestor(db, current_user)
    await _exigir_esquema(db)
    solicitud = await _cualquiera(db, request_id)
    if solicitud.status not in CONCILIABLES:
        # Un expediente ya cerrado —retirado, rechazado, reembolsado— no se
        # concilia: si la pasarela dijera «succeeded», `aplicar` intentaria una
        # transicion que no existe y el boton daria 500 para siempre.
        raise ValidationAppError(
            "Esta solicitud ya está cerrada: no hay nada que conciliar.",
            code="refund_not_reconcilable",
        )
    if not (solicitud.external_refund_id or "").strip():
        # Sin referencia no hay nada que preguntar. Se dice claro en vez de
        # consultar con una cadena vacia y tomar el «no encontrado» por un fallo
        # de la pasarela.
        raise ValidationAppError(
            "Esta solicitud no tiene un reembolso en la pasarela que conciliar.",
            code="refund_no_external_reference",
        )
    await _conciliar_con_pasarela(db, solicitud, actor_id=current_user.id)
    solicitud = await _cualquiera(db, request_id)
    return await _a_lectura_admin(db, solicitud, con_historial=True)


@admin_router.post("/refund-requests/reconcile-stale")
async def conciliar_las_estancadas(
    horas: int = Query(default=24, ge=1, le=720),
    limite: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Preguntarle a la pasarela por TODOS los expedientes que llevan colgados.

    POR QUE HACIA FALTA. `reconciliar_estancadas` estaba escrita y probada, y no
    la llamaba nadie: ni un endpoint, ni una tarea. La conciliacion existia solo
    de una en una, expediente a expediente, y justo el caso que motiva todo esto
    —el webhook que se pierde y deja el reembolso en `refund_processing` para
    siempre— es el que nadie va a ir a buscar a mano.

    IDEMPOTENTE Y ACOTADO. `reembolso.aplicar` devuelve False si ya estaba
    aplicado, asi que llamarlo dos veces seguidas no revoca dos veces ni avisa
    dos veces; `horas` y `limite` acotan cuanto abarca cada pasada.

    A MANO Y NO POR TEMPORIZADOR, por lo mismo que la liquidacion: la API corre
    en varias replicas y un planificador dentro del proceso son tantas pasadas
    como replicas. Cuando se decida colgarlo de un cron externo, este es el
    endpoint.
    """
    await _exigir_gestor(db, current_user)
    await _exigir_esquema(db)
    return {"conciliadas": await reconciliar_estancadas(db, horas=horas, limite=limite)}


async def reconciliar_estancadas(
    db: AsyncSession, *, horas: int = 24, limite: int = 50
) -> int:
    """Las que llevan demasiado en `refund_processing`. Idempotente.

    SIN COLA NI INFRAESTRUCTURA NUEVA: una consulta acotada que se puede
    disparar desde una tarea o desde un comando. Llamarla dos veces seguidas no
    hace nada la segunda, porque `reembolso.aplicar` ya devuelve False cuando
    estaba aplicado.

    Un fallo en una NO puede tumbar las demas: se registra, se deshace lo suyo y
    se sigue con la siguiente.
    """
    if not await esquema.hay_devoluciones(db):
        return 0

    corte = devoluciones.ahora() - timedelta(hours=horas)
    filas = list(
        await db.scalars(
            select(RefundRequest)
            .where(
                RefundRequest.status == estados.REFUND_PROCESSING,
                RefundRequest.external_refund_id.is_not(None),
                RefundRequest.updated_at < corte,
            )
            .order_by(RefundRequest.updated_at)
            .limit(limite)
        )
    )

    conciliadas = 0
    for solicitud in filas:
        try:
            await _conciliar_con_pasarela(db, solicitud, actor_id=None)
            conciliadas += 1
        except Exception:  # noqa: BLE001
            logger.exception(
                "[devoluciones] no se pudo conciliar la solicitud %s", solicitud.id
            )
            await db.rollback()
    return conciliadas


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
    await _exigir_esquema(db)
    solicitud = await _cualquiera(db, request_id)
    await _transicion(db, solicitud, hasta, current_user, notes=notes)
    if hasta == estados.CANCELLED:
        await liquidacion.descongelar(
            db, order_id=solicitud.order_id, refund_request_id=solicitud.id
        )
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
    desde = solicitud.status
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
        #
        # Y SE AUDITA EL INTENTO RECHAZADO. Un rastro que solo apunta lo que
        # salió bien no sirve para investigar: «alguien intentó aprobar dos
        # veces» es exactamente lo que se quiere poder ver después.
        # EL INTENTO RECHAZADO SE CONFIRMA APARTE, y hay que confirmarlo.
        #
        # `anotar` solo hace `flush`, y justo despues se lanza la excepcion:
        # quien cierra la sesion es la dependencia, sin `commit`, asi que la fila
        # `denied` se deshacia SIEMPRE. Era justo el caso que este bloque dice
        # cubrir —dos personas aprobando a la vez— y no dejaba ni una fila.
        #
        # Y es MEJOR ESFUERZO a proposito: la transicion no se aplico, asi que no
        # hay nada que proteger con ella, y convertir un 409 legitimo en un 500
        # porque no se pudo escribir el rastro seria cambiar un problema pequeño
        # por uno grande. Si falla, queda en el registro.
        try:
            await auditoria.anotar(
                db,
                action=f"refund.{hasta}",
                entity_type="refund_request",
                entity_id=solicitud.id,
                actor_id=current_user.id,
                actor_role="admin",
                outcome="denied",
                previous_state=desde,
                new_state=hasta,
                reason=str(error)[:300],
            )
            await db.commit()
        except Exception:  # noqa: BLE001
            logger.warning(
                "[devoluciones] no se pudo anotar el intento rechazado sobre %s",
                solicitud.id,
                exc_info=True,
            )
        raise ValidationAppError(str(error), code="refund_invalid_transition")

    # EL EXPEDIENTE YA LO ANOTA `_anotar` en `refund_request_events`, que es su
    # máquina de estados y sigue siendo la autoridad. Esto es el rastro
    # TRANSVERSAL: el que responde «¿qué se movió hoy y quién lo movió?» sin
    # tener que saber que existe un módulo de devoluciones.
    await auditoria.anotar(
        db,
        action=f"refund.{hasta}",
        entity_type="refund_request",
        entity_id=solicitud.id,
        actor_id=current_user.id,
        actor_role="admin",
        previous_state=desde,
        new_state=hasta,
        payload={"order_id": solicitud.order_id, "course_id": solicitud.course_id},
    )


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
    from app.modules.learning.models import CourseLesson, CourseModule, LessonProgress

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

    # SAVEPOINT, no `rollback`. La sesion no caduca en el commit
    # (`expire_on_commit=False`) pero un `rollback` no anidado SI caduca la
    # identity map entera, y quien llama sigue leyendo la solicitud justo
    # despues: en async eso revienta con `MissingGreenlet` y devuelve un 500
    # sobre una solicitud que YA se creo. El savepoint deshace solo el aviso.
    try:
        async with db.begin_nested():
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

    # Savepoint, por lo mismo que arriba: `aprobar` ejecuta el reembolso justo
    # despues de avisar, y un `rollback` aqui le dejaria la solicitud caducada.
    try:
        async with db.begin_nested():
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
