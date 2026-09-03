"""Garantía de 7 días y devoluciones. Las reglas viven aquí, no en la pantalla.

TRES COSAS QUE ESTE MÓDULO NO SE CREE NUNCA DEL CLIENTE:

1. **Cuándo empezó la garantía.** La pone el servidor al entregar contenido
   protegido por primera vez. Una fecha que manda el móvil se puede retrasar
   para estirar el plazo indefinidamente.
2. **Cuánto se devuelve.** Sale de la ORDEN. Aceptar un importe del navegador
   es dejar elegir cuánto se devuelve.
3. **Si todavía está en plazo.** Se recalcula con la hora del servidor en cada
   paso, incluido el momento de aprobar. El contador de la pantalla es un
   adorno: informa, no decide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.commerce.models import Order
# El mismo `insert` con `on conflict do nothing` que usa el comercio. Se reutiliza
# a proposito: es el unico que cierra la carrera sin tirar la transaccion entera.
from app.modules.commerce.service import _insert
from app.modules.refunds import estados, politica
from app.modules.refunds.models import (
    HORAS_DE_GARANTIA,
    CourseRefundWindow,
    RefundPolicyAcceptance,
    RefundRequest,
    RefundRequestEvent,
)

logger = logging.getLogger("renaser.refunds")


def ahora() -> datetime:
    """La hora oficial, en UTC y consciente de zona.

    Una sola función para todo el módulo. Con `datetime.utcnow()` repartido por
    ahí acaban conviviendo fechas con zona y sin zona, y restarlas lanza; peor
    aún, compararlas da resultados silenciosamente equivocados.
    """
    return datetime.now(timezone.utc)


def _con_zona(momento: datetime | None) -> datetime | None:
    """SQLite devuelve fechas SIN zona. Compararlas con una que sí la tiene
    lanza `TypeError`, y eso sólo se ve en producción si las pruebas usan otra
    base. Se asume UTC, que es lo único que este módulo escribe."""
    if momento is None:
        return None
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Motivos por los que NO se puede pedir devolución
# --------------------------------------------------------------------------- #
#
# Códigos y no frases: la pantalla los traduce a los tres idiomas. Mandar el
# texto ya montado desde el servidor obligaría a saber aquí en qué idioma
# está mirando quien pregunta.

SIN_COMPRA = "no_purchase"
GARANTIA_NO_INICIADA = "not_started"
FUERA_DE_PLAZO = "expired"
GARANTIA_YA_USADA = "already_refunded"
SOLICITUD_ACTIVA = "request_active"
DESACTIVADO = "disabled"


@dataclass(frozen=True)
class EstadoDeGarantia:
    """Todo lo que la pantalla necesita saber, resuelto en el servidor."""

    #: La hora del SERVIDOR. La pantalla calcula su cuenta atrás a partir de
    #: esta y no del reloj del teléfono, que puede estar mal puesto o movido a
    #: mano justo para estirar el plazo.
    server_time: datetime
    elegible: bool
    motivo: str | None
    first_accessed_at: datetime | None = None
    expires_at: datetime | None = None
    seconds_remaining: int = 0
    #: Si esta persona ya gastó su devolución en este curso, alguna vez.
    refund_used: bool = False
    refund_used_at: datetime | None = None
    #: La solicitud viva, si la hay.
    request_id: str | None = None
    request_status: str | None = None
    #: La orden sobre la que se pediría la devolución.
    order_id: str | None = None
    amount_minor: int = 0
    currency: str = ""


# --------------------------------------------------------------------------- #
# 1. Arrancar la garantía
# --------------------------------------------------------------------------- #


async def asegurar_ventana(
    db: AsyncSession, *, user_id: str, course_id: str, order_id: str | None
) -> CourseRefundWindow | None:
    """Arranca la garantía si no estaba arrancada. Devuelve la ventana.

    SE LLAMA AL ENTREGAR CONTENIDO PROTEGIDO, no al pagar ni al abrir la ficha.
    Ver `learning/router.py`: se invoca justo donde se decide entregar el vídeo
    o el texto de una lección que no es muestra.

    CONCURRENCIA. Dos peticiones simultáneas a la primera lección —el móvil y
    la web, o un doble toque— intentan crearla a la vez. No se resuelve con
    «mira si existe y si no créala»: las dos leen antes de que escriba ninguna
    y las dos insertan. Se resuelve dejando que lo impida el índice único
    `course_refund_windows_unica` y recogiendo el choque: la que pierde relee
    la fila que escribió la otra. Esa es la que vale para las dos.

    NO REINICIA NADA. Si la ventana ya existe se devuelve tal cual, con su
    fecha original. Reinstalar, cambiar de teléfono o recomprar no la mueven.
    """
    existente = await _ventana(db, user_id=user_id, course_id=course_id)
    if existente is not None:
        return existente

    inicio = ahora()
    # `on conflict do nothing` y NO «insertar y capturar el choque»: capturarlo
    # obliga a un `rollback`, y un rollback a media peticion tira TODO lo demas
    # que hubiera en la transaccion —la entrega de la leccion, por ejemplo—.
    # Con `do nothing`, la insercion perdedora no hace nada y la transaccion
    # sigue viva.
    await db.execute(
        _insert(db)(CourseRefundWindow.__table__)
        .values(
            user_id=user_id,
            course_id=course_id,
            order_id=order_id,
            first_accessed_at=inicio,
            expires_at=inicio + timedelta(hours=HORAS_DE_GARANTIA),
        )
        .on_conflict_do_nothing(index_elements=["user_id", "course_id"])
    )
    await db.flush()
    # Se relee SIEMPRE: la fila puede ser la nuestra o la de quien llego antes.
    # Cual de las dos sea da igual; lo que importa es que las dos vean la misma.
    ventana = await _ventana(db, user_id=user_id, course_id=course_id)
    # EL SALDO DEL PROPIETARIO VENCE CON ESTA GARANTIA, NO CON LA COMPRA.
    # Al cobrar se retuvo el plazo completo desde la venta, que es el peor caso
    # porque todavia no se sabia cuando iba a entrar. Ahora ya se sabe: quien
    # compra el lunes y entra el viernes corre sus 168 horas desde el viernes,
    # y pagarle al propietario el lunes siguiente seria pagarle con la garantia
    # todavia abierta.
    if ventana is not None:
        await _sincronizar_vencimiento_del_saldo(db, ventana)
    return ventana


async def _sincronizar_vencimiento_del_saldo(
    db: AsyncSession, ventana: CourseRefundWindow
) -> None:
    """Mueve `available_at` del saldo al vencimiento REAL de la garantia.

    Solo toca saldos `pending`: uno congelado esta en manos de una solicitud, y
    uno ya elegible o transferido no se puede retrasar sin descuadrar lo que ya
    se conto como pagable.

    Nunca revienta la entrega de la leccion: si la liquidacion no esta
    disponible, no hay nada que sincronizar y se sigue.
    """
    if ventana.order_id is None:
        return
    from app.modules.commerce.models import OwnerSaleBalance
    from app.modules.refunds import esquema

    if not await esquema.hay_liquidaciones(db):
        return

    # SAVEPOINT, no un `try` a secas. En PostgreSQL una sentencia que falla
    # ABORTA la transaccion entera: a partir de ahi todo lo demas revienta con
    # «current transaction is aborted». Capturar el error y seguir dejaria la
    # entrega de la leccion escribiendo sobre una transaccion muerta, y el
    # sintoma aparece lejos de aqui.
    #
    # Con `begin_nested` el fallo deshace SOLO esto y la transaccion de fuera
    # sigue viva y utilizable.
    try:
        async with db.begin_nested():
            await db.execute(
                update(OwnerSaleBalance)
                .where(
                    OwnerSaleBalance.order_id == ventana.order_id,
                    OwnerSaleBalance.status == "pending",
                )
                .values(available_at=ventana.expires_at, updated_at=ahora())
            )
    except Exception:  # noqa: BLE001
        logger.exception(
            "[devoluciones] no se pudo sincronizar el vencimiento del saldo de "
            "la orden %s; la garantia SI quedo registrada",
            ventana.order_id,
        )


async def _ventana(
    db: AsyncSession, *, user_id: str, course_id: str
) -> CourseRefundWindow | None:
    return await db.scalar(
        select(CourseRefundWindow).where(
            CourseRefundWindow.user_id == user_id,
            CourseRefundWindow.course_id == course_id,
        )
    )


# --------------------------------------------------------------------------- #
# 2. ¿Se puede pedir?
# --------------------------------------------------------------------------- #


async def estado_de_garantia(
    db: AsyncSession, *, user_id: str, course_id: str
) -> EstadoDeGarantia:
    """Lo que la pantalla enseña y lo que el servidor volverá a comprobar.

    Que sea la MISMA función la que responde a la pantalla y la que valida al
    crear la solicitud no es ahorro de líneas: es lo que impide que la pantalla
    ofrezca un botón que el servidor va a rechazar, o al revés.
    """
    momento = ahora()
    if not get_settings().feature_course_refunds:
        return EstadoDeGarantia(server_time=momento, elegible=False, motivo=DESACTIVADO)

    ventana = await _ventana(db, user_id=user_id, course_id=course_id)
    orden = await _orden_reembolsable(db, user_id=user_id, course_id=course_id)
    viva = await solicitud_viva(db, user_id=user_id, course_id=course_id)

    base = {
        "server_time": momento,
        "first_accessed_at": _con_zona(ventana.first_accessed_at) if ventana else None,
        "expires_at": _con_zona(ventana.expires_at) if ventana else None,
        "refund_used": bool(ventana and ventana.refund_used_at),
        "refund_used_at": _con_zona(ventana.refund_used_at) if ventana else None,
        "request_id": viva.id if viva else None,
        "request_status": viva.status if viva else None,
        "order_id": orden.id if orden else None,
        "amount_minor": orden.amount_minor if orden else 0,
        "currency": orden.currency if orden else "",
    }

    # El orden de estas comprobaciones ES la explicación que recibe la persona.
    # «Ya la usaste» antes que «fuera de plazo» porque es la razón de fondo:
    # decirle que se le pasó el plazo cuando lo que ocurre es que ya devolvió
    # una vez le haría pensar que llegó tarde por poco.
    if base["refund_used"]:
        return EstadoDeGarantia(elegible=False, motivo=GARANTIA_YA_USADA, **base)
    if viva is not None:
        return EstadoDeGarantia(elegible=False, motivo=SOLICITUD_ACTIVA, **base)
    if orden is None:
        return EstadoDeGarantia(elegible=False, motivo=SIN_COMPRA, **base)
    if ventana is None:
        # Compró y todavía no ha entrado. La garantía no ha empezado: no es que
        # no pueda devolver, es que su plazo ni siquiera está corriendo.
        return EstadoDeGarantia(elegible=False, motivo=GARANTIA_NO_INICIADA, **base)

    vence = _con_zona(ventana.expires_at)
    if momento >= vence:
        return EstadoDeGarantia(elegible=False, motivo=FUERA_DE_PLAZO, **base)

    return EstadoDeGarantia(
        elegible=True,
        motivo=None,
        seconds_remaining=int((vence - momento).total_seconds()),
        **base,
    )


async def _orden_reembolsable(
    db: AsyncSession, *, user_id: str, course_id: str
) -> Order | None:
    """La compra PAGADA más reciente de esta persona en este curso.

    `paid` y no cualquiera: una orden pendiente no ha cobrado nada, y devolver
    lo que no se cobró es regalar acceso. Las ya reembolsadas quedan fuera por
    el mismo motivo.
    """
    from app.modules.commerce.models import CommerceProduct

    return await db.scalar(
        select(Order)
        .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
        .where(
            Order.user_id == user_id,
            CommerceProduct.course_id == course_id,
            Order.status == "paid",
        )
        .order_by(Order.created_at.desc())
        .limit(1)
    )


async def solicitud_viva(
    db: AsyncSession, *, user_id: str, course_id: str
) -> RefundRequest | None:
    """La solicitud abierta de esta persona en este curso, si la hay."""
    return await db.scalar(
        select(RefundRequest)
        .where(
            RefundRequest.user_id == user_id,
            RefundRequest.course_id == course_id,
            RefundRequest.status.in_(tuple(estados.VIVOS)),
        )
        .order_by(RefundRequest.requested_at.desc())
        .limit(1)
    )


async def ya_devolvio(db: AsyncSession, *, user_id: str, course_id: str) -> datetime | None:
    """Cuándo consumió su garantía en este curso, o None si no lo hizo.

    Mira la VENTANA y no las solicitudes: la ventana es la que sobrevive a que
    un expediente se archive, y es la que decide si una recompra lleva garantía.
    """
    ventana = await _ventana(db, user_id=user_id, course_id=course_id)
    return _con_zona(ventana.refund_used_at) if ventana else None


# --------------------------------------------------------------------------- #
# 3. Crear la solicitud
# --------------------------------------------------------------------------- #


class NoElegible(Exception):
    """La solicitud no se puede crear, y el código dice por qué."""

    def __init__(self, motivo: str) -> None:
        self.motivo = motivo
        super().__init__(motivo)


async def crear_solicitud(
    db: AsyncSession,
    *,
    user_id: str,
    order_id: str,
    reason: str,
    explanation: str | None,
) -> RefundRequest:
    """Crea la solicitud tras revalidar TODO en el servidor.

    El cliente manda dos cosas y solo dos: qué orden y por qué. El importe, la
    moneda, el curso, el plazo y la elegibilidad los resuelve este servicio.

    La doble pulsación no crea dos: el índice parcial
    `refund_requests_viva_por_orden` lo impide en la base, y aquí se recoge el
    choque para devolver la que ya existía en vez de un error.
    """
    orden = await db.get(Order, order_id)
    if orden is None or orden.user_id != user_id:
        # Mismo mensaje para «no existe» y «es de otro»: distinguirlos deja
        # comprobar si un id de orden ajeno es real.
        raise NoElegible(SIN_COMPRA)
    if orden.status != "paid":
        raise NoElegible(SIN_COMPRA)

    course_id = await _curso_de_la_orden(db, orden)
    if course_id is None:
        raise NoElegible(SIN_COMPRA)

    estado = await estado_de_garantia(db, user_id=user_id, course_id=course_id)
    if not estado.elegible:
        raise NoElegible(estado.motivo or SIN_COMPRA)

    # Se construye SIN anadirlo a la sesion: solo sirve para reunir los valores
    # que van al insert de abajo, que es el que de verdad escribe.
    solicitud = RefundRequest(
        id=__import__("uuid").uuid4().hex,
        order_id=orden.id,
        user_id=user_id,
        course_id=course_id,
        status=estados.REQUESTED,
        reason=reason,
        explanation=(explanation or "").strip() or None,
        # Del SERVIDOR, no del cuerpo de la petición.
        amount_minor=orden.amount_minor,
        currency=orden.currency,
        provider=orden.provider,
        environment=orden.environment,
    )
    # Mismo motivo que en la ventana: `do nothing` en vez de capturar el choque.
    # La doble pulsacion no crea dos solicitudes y no tira la transaccion.
    resultado = await db.execute(
        _insert(db)(RefundRequest.__table__)
        .values(
            id=solicitud.id,
            order_id=solicitud.order_id,
            user_id=solicitud.user_id,
            course_id=solicitud.course_id,
            status=solicitud.status,
            reason=solicitud.reason,
            explanation=solicitud.explanation,
            amount_minor=solicitud.amount_minor,
            currency=solicitud.currency,
            provider=solicitud.provider,
            environment=solicitud.environment,
            requested_at=ahora(),
        )
        .on_conflict_do_nothing(
            index_elements=["order_id"],
            # Texto literal y compartido con el indice: ver `estados.SQL_VIVOS`.
            index_where=text(estados.SQL_VIVOS),
        )
    )
    await db.flush()
    if resultado.rowcount == 0:
        # Alguien se adelanto. La suya es la buena.
        existente = await solicitud_viva(db, user_id=user_id, course_id=course_id)
        if existente is not None:
            return existente
        raise NoElegible(SOLICITUD_ACTIVA)
    solicitud = await db.get(RefundRequest, solicitud.id)

    await _anotar(
        db,
        solicitud,
        desde=None,
        hasta=estados.REQUESTED,
        rol="user",
        actor_id=user_id,
        reason=reason,
    )
    return solicitud


async def _curso_de_la_orden(db: AsyncSession, orden: Order) -> str | None:
    from app.modules.commerce.models import CommerceProduct

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    return producto.course_id if producto else None


# --------------------------------------------------------------------------- #
# 4. Mover el expediente
# --------------------------------------------------------------------------- #


#: Las unicas decisiones cuya nota se le ENSENA a quien pidio la devolucion.
#: `review_notes` viaja en la respuesta del alumno, asi que solo puede contener
#: lo que se le DIRIGE a el: la justificacion de una decision humana.
NOTAS_PARA_EL_ALUMNO = frozenset({estados.APPROVED, estados.REJECTED})


async def transicionar(
    db: AsyncSession,
    solicitud: RefundRequest,
    *,
    hasta: str,
    rol: str,
    actor_id: str | None,
    reason: str | None = None,
    notes: str | None = None,
    external_reference: str | None = None,
    metadata: dict | None = None,
) -> RefundRequest:
    """Cambia el estado, comprobando que el salto existe y que el actor puede.

    CADA cambio deja fila en el historial. Un reembolso de dinero real sin
    rastro de quién lo autorizó no es defendible ante nadie.

    Lanza `estados.TransicionInvalida` si el salto no está permitido; quien
    llama decide si eso es un 409 o un 403.
    """
    desde = solicitud.status
    estados.exigir(desde, hasta, rol=rol)

    # LA COMPROBACION DE ARRIBA NO BASTA, Y ESTE ES EL CASO QUE LO DEMUESTRA:
    # dos administradores abren la misma solicitud, los dos ven `under_review`
    # y los dos pulsan «aprobar». Los dos pasan `estados.exigir` —porque cada
    # uno lee su propia copia en memoria— y los dos escriben. Resultado: dos
    # reembolsos del mismo dinero.
    #
    # Se cierra con un UPDATE CONDICIONAL: la base cambia la fila solo si su
    # estado sigue siendo el que leimos. Es una comparacion y una escritura en
    # la MISMA sentencia, asi que no hay hueco entre las dos por el que se
    # cuele nadie. El segundo administrador afecta a cero filas y se entera.
    momento = ahora()
    resultado = await db.execute(
        update(RefundRequest)
        .where(RefundRequest.id == solicitud.id, RefundRequest.status == desde)
        .values(status=hasta, updated_at=momento)
    )
    if resultado.rowcount == 0:
        # Alguien la movio entre que la leimos y ahora. Se relee para decir a
        # que estado, que es mas util que «no se pudo».
        await db.refresh(solicitud)
        raise estados.TransicionInvalida(
            solicitud.status,
            hasta,
            "Otra persona movio esta solicitud mientras la revisabas: ahora "
            f"esta en '{solicitud.status}'.",
        )

    solicitud.status = hasta
    solicitud.updated_at = momento
    if hasta == estados.UNDER_REVIEW:
        solicitud.reviewer_id = actor_id
        solicitud.reviewed_at = ahora()
    if hasta in estados.FINALES:
        solicitud.resolved_at = ahora()
    # SOLO LA NOTA QUE SE LE DIRIGE AL ALUMNO. Antes se escribia en CUALQUIER
    # transicion, y como `review_notes` viaja en la respuesta del alumno eso
    # significaba dos cosas malas: las notas internas de un `cancel` se leian
    # desde la app, y el mensaje con el que la pasarela rechazo el cargo
    # aparecia presentado como si fuera la nota del revisor.
    #
    # No se pierde nada: `_anotar` guarda igual la nota en el historial, que
    # solo ve administracion.
    if notes and rol == "admin" and hasta in NOTAS_PARA_EL_ALUMNO:
        solicitud.review_notes = notes
    if external_reference:
        solicitud.external_refund_id = external_reference

    await _anotar(
        db,
        solicitud,
        desde=desde,
        hasta=hasta,
        rol=rol,
        actor_id=actor_id,
        reason=reason,
        notes=notes,
        external_reference=external_reference,
        metadata=metadata,
    )
    return solicitud


async def _anotar(
    db: AsyncSession,
    solicitud: RefundRequest,
    *,
    desde: str | None,
    hasta: str,
    rol: str,
    actor_id: str | None,
    reason: str | None = None,
    notes: str | None = None,
    external_reference: str | None = None,
    metadata: dict | None = None,
) -> None:
    db.add(
        RefundRequestEvent(
            refund_request_id=solicitud.id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=rol,
            reason=reason,
            notes=notes,
            external_reference=external_reference,
            # Identificadores y códigos. NUNCA el cuerpo de un webhook ni nada
            # que pueda llevar un secreto dentro.
            event_metadata=metadata or {},
        )
    )
    await db.flush()


async def historial(db: AsyncSession, refund_request_id: str) -> list[RefundRequestEvent]:
    filas = await db.scalars(
        select(RefundRequestEvent)
        .where(RefundRequestEvent.refund_request_id == refund_request_id)
        .order_by(RefundRequestEvent.created_at)
    )
    return list(filas)


# --------------------------------------------------------------------------- #
# 5. Consumir la garantía
# --------------------------------------------------------------------------- #


async def consumir_garantia(
    db: AsyncSession, solicitud: RefundRequest
) -> CourseRefundWindow | None:
    """Marca la ventana como usada. SOLO tras un reembolso confirmado.

    Si la persona nunca llegó a abrir el curso no hay ventana que marcar —pagó,
    pidió devolución sin entrar y se le devolvió—. Se crea una ya consumida:
    sin ella, recomprar le daría una garantía que en realidad ya gastó.
    """
    ventana = await _ventana(
        db, user_id=solicitud.user_id, course_id=solicitud.course_id
    )
    momento = ahora()
    if ventana is None:
        ventana = CourseRefundWindow(
            user_id=solicitud.user_id,
            course_id=solicitud.course_id,
            order_id=solicitud.order_id,
            first_accessed_at=momento,
            expires_at=momento + timedelta(hours=HORAS_DE_GARANTIA),
        )
        db.add(ventana)
    ventana.refund_used_at = momento
    ventana.refund_request_id = solicitud.id
    ventana.updated_at = momento
    await db.flush()
    return ventana


# --------------------------------------------------------------------------- #
# 6. Aceptación de recompra sin garantía
# --------------------------------------------------------------------------- #


async def registrar_aceptacion(
    db: AsyncSession,
    *,
    user_id: str,
    course_id: str,
    order_id: str | None,
    fecha_legible: str,
) -> RefundPolicyAcceptance:
    """Guarda que aceptó comprar sin garantía, con la huella del texto exacto.

    Un doble clic devuelve la que ya había en vez de crear otra: la casilla no
    mueve dinero, pero dos filas idénticas ensucian la auditoría y luego hay
    que decidir cuál vale.
    """
    ya = await db.scalar(
        select(RefundPolicyAcceptance)
        .where(
            RefundPolicyAcceptance.user_id == user_id,
            RefundPolicyAcceptance.course_id == course_id,
            RefundPolicyAcceptance.order_id.is_(None),
            RefundPolicyAcceptance.policy_version == politica.VERSION_ACTUAL,
        )
        .limit(1)
    )
    if ya is not None:
        return ya
    aceptacion = RefundPolicyAcceptance(
        user_id=user_id,
        course_id=course_id,
        order_id=order_id,
        policy_version=politica.VERSION_ACTUAL,
        policy_hash=politica.huella_de_recompra(fecha_legible),
    )
    db.add(aceptacion)
    await db.flush()
    return aceptacion


async def tiene_aceptacion(
    db: AsyncSession, *, user_id: str, course_id: str
) -> bool:
    """Si ya aceptó comprar este curso sin garantía, en la versión vigente.

    Se exige la versión ACTUAL: si el texto cambió, hay que volver a enseñarlo.
    Una aceptación de una redacción anterior no cubre lo que dice la nueva.
    """
    fila = await db.scalar(
        select(RefundPolicyAcceptance.id)
        .where(
            RefundPolicyAcceptance.user_id == user_id,
            RefundPolicyAcceptance.course_id == course_id,
            RefundPolicyAcceptance.policy_version == politica.VERSION_ACTUAL,
        )
        .limit(1)
    )
    return fila is not None


async def enlazar_aceptacion(
    db: AsyncSession, *, user_id: str, course_id: str, order_id: str
) -> None:
    """Ata la aceptación suelta a la orden que acabó creándose.

    Se acepta ANTES de que la orden exista, así que la fila nace con
    `order_id` nulo. Enlazarla después es lo que permite responder «qué aceptó
    exactamente quien compró ESTA orden».
    """
    # UNA, LA MÁS RECIENTE. Antes esto era un UPDATE sin límite sobre todas las
    # sueltas, así que dos aceptaciones —un doble clic, o una compra abandonada
    # y otra retomada— acababan las DOS apuntando a la misma orden. Entonces
    # «qué aceptó exactamente quien compró esta orden» tenía dos respuestas, y
    # una aceptación vieja quedaba consumida por una compra que no era la suya.
    suelta = await db.scalar(
        select(RefundPolicyAcceptance.id)
        .where(
            RefundPolicyAcceptance.user_id == user_id,
            RefundPolicyAcceptance.course_id == course_id,
            RefundPolicyAcceptance.order_id.is_(None),
        )
        .order_by(RefundPolicyAcceptance.accepted_at.desc())
        .limit(1)
    )
    if suelta is None:
        return
    await db.execute(
        update(RefundPolicyAcceptance)
        .where(RefundPolicyAcceptance.id == suelta)
        .values(order_id=order_id)
    )
    await db.flush()
