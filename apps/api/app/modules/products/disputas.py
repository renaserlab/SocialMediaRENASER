"""Los contracargos de un pedido de productos.

UNA DISPUTA NO ES UNA DEVOLUCIÓN, y por eso tiene su propio módulo. Una
devolución la decide Z y sale por nuestro circuito; una disputa la abre el
banco de quien pagó, el dinero se retira sin preguntarnos, y lo único que
podemos hacer es **enterarnos y dejar de pagar** mientras dure.

TRES COSAS QUE ESTE MÓDULO GARANTIZA:

1. **Se registra, aunque no sepamos quién paga el roto.** Quién absorbe
   finalmente el coste de un contracargo es una decisión de la empresa que no
   está tomada. Esa decisión no impide anotar que existe, ni congelar el dinero
   mientras se resuelve: al contrario, no anotarlo sería la única forma segura
   de perderlo.
2. **No se paga sobre un saldo disputado.** Abrir una disputa congela el saldo
   y aparta su importe. `por_que_no_se_libera` ya lo comprobaba —por saldo o
   por pedido— desde el Incremento 9; lo que faltaba es que alguien escribiera
   la fila, sin la cual esa puerta no podía dispararse jamás.
3. **Es idempotente, y lo impone la base.** Stripe manda el mismo aviso varias
   veces y en cualquier orden. La unicidad la sostiene un índice, no un
   `select` previo: dos avisos simultáneos pasarían los dos por una
   comprobación en Python.

LO QUE **NO** HACE, Y ES DELIBERADO:

* **No mueve inventario.** Que el banco retire el dinero no dice nada de dónde
  está la mercancía, y decidirlo sería inventarse la política de devoluciones.
* **No cobra a nadie.** Al perderse una disputa queda un saldo en negativo
  *anotado como responsabilidad pendiente*, no un cargo: quién lo asume está
  sin decidir y la 0049 ni siquiera admite un neto negativo.
* **No cierra el expediente de posventa.** Una disputa y una reclamación pueden
  convivir, y son cosas distintas.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.commerce.models import OwnerSaleBalance
from app.modules.products import esquema, finanzas, pedidos
from app.modules.products.finanzas_models import (
    ProductDispute,
    ProductDisputeEvent,
)

logger = logging.getLogger("renaser.products")

#: Quien manda los avisos. Forma parte del unico —(provider, referencia)— asi
#: que dos pasarelas distintas podrian usar la misma referencia sin chocar.
PROVEEDOR = "stripe"

#: Y quien mueve la disputa. No es una persona de Z: es el banco de quien pago.
ACTOR_PASARELA = "provider"

# --------------------------------------------------------------------------- #
# El vocabulario. Es el de la pasarela, no uno nuestro.
# --------------------------------------------------------------------------- #
#: Abierta: el banco reclama y todavía no hay decisión.
DISPUTA_ABIERTA = "open"
#: Hace falta responder con pruebas.
DISPUTA_RESPONDER = "needs_response"
#: En estudio.
DISPUTA_EN_REVISION = "under_review"
#: Ganada: el dinero se queda.
DISPUTA_GANADA = "won"
#: Perdida: el dinero se fue.
DISPUTA_PERDIDA = "lost"
#: Retirada por quien la abrió.
DISPUTA_RETIRADA = "withdrawn"

#: Mientras esté en uno de estos, NO se paga nada de ese saldo.
DISPUTA_VIVA = (DISPUTA_ABIERTA, DISPUTA_RESPONDER, DISPUTA_EN_REVISION)

#: Y en estos ya no bloquea: se sabe cómo acabó.
DISPUTA_CERRADA = (DISPUTA_GANADA, DISPUTA_PERDIDA, DISPUTA_RETIRADA)

#: De lo que dice el aviso a lo que significa para nosotros.
#:
#: `disputa_cerrada` NO dice por sí solo quién ganó: eso viene en el objeto, y
#: se lee de `payload`. Suponer que cerrada es ganada soltaría el dinero de un
#: contracargo perdido.
POR_EL_AVISO = {
    "disputa_abierta": DISPUTA_ABIERTA,
    "disputa_fondos_retirados": DISPUTA_EN_REVISION,
}


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    await finanzas.exigir_disponible(db)


def _estado_del_cierre(payload) -> str:  # noqa: ANN001
    """Cómo acabó una disputa cerrada, según el objeto de la pasarela.

    LO QUE NO SE ENTIENDE **NO** SE DA POR GANADO. Un estado desconocido deja
    la disputa en revisión, que sigue bloqueando: dar por ganado lo que no se
    entiende soltaría dinero que quizá ya se fue.
    """
    if not isinstance(payload, dict):
        return DISPUTA_EN_REVISION
    objeto = payload.get("data")
    if isinstance(objeto, dict):
        objeto = objeto.get("object")
    if not isinstance(objeto, dict):
        objeto = payload
    crudo = str(objeto.get("status") or "").lower()
    if crudo in ("won", "warning_closed"):
        return DISPUTA_GANADA
    if crudo == "lost":
        return DISPUTA_PERDIDA
    if crudo in ("charge_refunded",):
        #: SE RESOLVIÓ DEVOLVIENDO, Y ESO CUENTA COMO PERDIDA. No porque fuera
        #: una derrota —no lo es: se devolvió para cerrar la reclamación antes
        #: de que la decidiera el banco— sino porque **el dinero salió**, que es
        #: lo único que este estado gobierna.
        #:
        #: ANTES SE TRADUCÍA A «RETIRADA», que es lo que Stripe llama a la
        #: disputa que retira quien la abrió: ahí el dinero SE QUEDA. Con esa
        #: traducción, `_aplicar_al_dinero` soltaba la retención sin consumirla
        #: y devolvía el saldo a la cola de pago después de haberle reembolsado
        #: el cobro entero a quien compró. Y no lo tapaba nada más: ese
        #: reembolso se hizo desde el panel de la pasarela, así que no tiene
        #: expediente aquí y no hay ninguna devolución que bloquee.
        #:
        #: NO SE INVENTA UN ESTADO NUEVO: el CHECK de `product_disputes` admite
        #: seis y no hay ninguna migración pendiente. Además, la fila tiene que
        #: CARGAR el hecho financiero, porque cada aviso repetido vuelve a
        #: aplicar el dinero leyéndola a ella y no al cuerpo del aviso.
        return DISPUTA_PERDIDA
    return DISPUTA_EN_REVISION


def _se_cerro_devolviendo(payload) -> bool:  # noqa: ANN001
    """Si este cierre concreto fue por un reembolso, para poder DECIRLO.

    Solo cambia el texto de la nota que lee quien concilia: el efecto sobre el
    dinero es el mismo que el de una derrota y lo decide el estado de la fila.
    """
    if not isinstance(payload, dict):
        return False
    objeto = payload.get("data")
    if isinstance(objeto, dict):
        objeto = objeto.get("object")
    if not isinstance(objeto, dict):
        objeto = payload
    return str(objeto.get("status") or "").lower() == "charge_refunded"


def _importe_del_aviso(evento) -> tuple[int, str]:  # noqa: ANN001
    """Cuánto reclama el banco, y en qué moneda.

    SIN MONEDA NO HAY IMPORTE. Un número sin moneda no significa nada, y aquí
    acabaría apartando dinero: se prefiere quedarse a cero, que bloquea igual
    por la vía del estado, antes que apartar una cifra que no se sabe de qué es.
    """
    importe = getattr(evento, "amount_minor", 0) or 0
    moneda = (getattr(evento, "currency", "") or "").upper()
    if not moneda or len(moneda) != 3:
        return 0, ""
    return int(importe), moneda


async def _anotar(
    db: AsyncSession,
    disputa: ProductDispute,
    *,
    desde: str | None,
    hasta: str,
    referencia: str | None,
    momento: datetime,
) -> None:
    """El historial. SOLO SE AÑADE, y lo impone un disparador de la 0082."""
    db.add(
        ProductDisputeEvent(
            dispute_id=disputa.id,
            from_status=desde,
            to_status=hasta,
            #: LA PASARELA, NO UNA PERSONA. Un contracargo no lo mueve nadie de
            #: aqui dentro: lo mueve el banco de quien pago, y el rastro tiene
            #: que decirlo para que nadie busque a quien firmo la decision.
            actor_id=None,
            actor_role=ACTOR_PASARELA,
            reason=(referencia or None),
            created_at=momento,
        )
    )


async def atender_aviso(db: AsyncSession, evento) -> str | None:  # noqa: ANN001
    """Un aviso de disputa YA VERIFICADO, sobre un pedido YA identificado.

    Quien llama —el webhook compartido— comprobó la firma, guardó el aviso
    contra el índice anti-repetición y abrió un savepoint. Aquí se decide qué
    significa para el pedido y para su dinero.

    Devuelve una NOTA cuando hace falta que lo mire una persona, o `None`
    cuando queda cerrado.
    """
    if not await esquema.hay_finanzas(db):
        #: Sin la 0082 no hay dónde anotarlo. Se dice, y no se pierde: el aviso
        #: en crudo ya quedó guardado por quien llama.
        logger.error("[productos] aviso de disputa sin la 0082 aplicada")
        return "Disputa recibida sin las finanzas desplegadas. Conciliar a mano."

    referencia = (getattr(evento, "provider_transaction_id", "") or "").strip()
    if not referencia:
        return "Aviso de disputa sin referencia de cobro. Conciliar a mano."

    #: LA CLAVE ES LA DE LA DISPUTA, no la del cobro.
    #:
    #: Un mismo cobro puede tener más de un contracargo a lo largo del tiempo, y
    #: con la referencia del cobro como clave única el segundo actualizaría el
    #: primero en vez de abrirse. Cuando el aviso no trae `dp_...` —uno antiguo,
    #: o una pasarela que no lo mande— se deriva una clave estable del cobro:
    #: sigue siendo idempotente, y se marca para que se vea que es derivada.
    clave = (getattr(evento, "dispute_id", "") or "").strip()
    if not clave:
        clave = "cobro:" + referencia

    orden = await pedidos.por_cobro(
        db, referencia=referencia, entorno=evento.environment
    )
    if orden is None:
        #: No es nuestro. No reconocerlo no es un error.
        return None

    momento = ahora()
    estado = POR_EL_AVISO.get(
        evento.status, _estado_del_cierre(getattr(evento, "payload", None))
    )
    importe, moneda = _importe_del_aviso(evento)
    if importe <= 0:
        #: SIN IMPORTE EN EL AVISO SE APARTA LO COBRADO, que es el tope de lo
        #: que el banco puede llevarse y no una cifra inventada.
        #:
        #: Antes se escribia el minimo que admite el CHECK —un centimo— y con la
        #: moneda del pedido puesta al lado, asi que la fila afirmaba que el
        #: banco reclamaba 0,01 y eso era lo que se apartaba. Pasarse al apartar
        #: es el lado seguro: se deja de pagar dinero que quiza haya que
        #: devolver. Quedarse corto es pagar de mas.
        importe = int(orden.total_minor)
        moneda = moneda or str(orden.currency)

    saldo = await finanzas.saldo_del_pedido(db, orden_id=orden.id)

    #: LA FILA DERIVADA SE ASCIENDE, NO SE DUPLICA.
    #:
    #: Cuando el primer aviso no trae `dp_...` se abre con una clave derivada
    #: del cobro. El siguiente aviso del MISMO contracargo si lo trae, y con
    #: otra clave se abria una SEGUNDA fila: el cierre llega con el
    #: identificador de verdad, cierra la segunda, y la primera se queda abierta
    #: para siempre. `por_que_no_se_libera` bloquea tambien por pedido, asi que
    #: ese saldo no se liberaba nunca por una disputa fantasma ya resuelta.
    #:
    #: NO ES «TODA DISPUTA DE ESTE COBRO ES LA MISMA»: solo se asciende la fila
    #: DERIVADA, que por construccion es la de un aviso sin identificador. Un
    #: segundo contracargo real del mismo cobro trae el suyo y abre el suyo.
    if clave.startswith("dp_"):
        await _ascender_la_derivada(
            db, orden_id=orden.id, referencia=referencia, clave=clave
        )

    disputa, nueva = await _crear_o_leer(
        db,
        orden_id=orden.id,
        referencia=clave,
        estado=estado,
        importe=importe,
        moneda=moneda or str(orden.currency),
        saldo=saldo,
        momento=momento,
    )

    if not nueva:
        await _mover(db, disputa, hasta=estado, evento=evento, momento=momento)

    #: Y EL DINERO. Se hace SIEMPRE, también cuando la fila ya existía: un aviso
    #: repetido tiene que dejar el saldo igual de bloqueado, no menos.
    await _aplicar_al_dinero(db, disputa=disputa, saldo=saldo, momento=momento)
    await db.flush()

    if disputa.status == DISPUTA_PERDIDA:
        if _se_cerro_devolviendo(getattr(evento, "payload", None)):
            return (
                "Contracargo cerrado DEVOLVIENDO el cobro. El dinero ya salió y "
                "quién lo asume está sin decidir: queda anotado como "
                "responsabilidad pendiente."
            )
        return (
            "Contracargo PERDIDO. El dinero ya salió y quién lo asume está sin "
            "decidir: queda anotado como responsabilidad pendiente."
        )
    return None


async def _ascender_la_derivada(
    db: AsyncSession, *, orden_id: str, referencia: str, clave: str
) -> None:
    """La fila abierta con la clave del cobro pasa a llamarse por la suya.

    SE COMPRUEBA QUE NO EXISTA YA LA REAL, porque entonces son dos filas de
    verdad y ascender la derivada chocaria contra el unico. En ese caso no se
    toca: la derivada se queda como esta y lo mira una persona, que es mejor que
    romper la transaccion de quien llama.
    """
    derivada_id = "cobro:" + referencia
    ya = await db.scalar(
        select(ProductDispute).where(
            ProductDispute.provider == PROVEEDOR,
            ProductDispute.external_dispute_id == clave,
        )
    )
    if ya is not None:
        return
    derivada = await db.scalar(
        select(ProductDispute).where(
            ProductDispute.provider == PROVEEDOR,
            ProductDispute.external_dispute_id == derivada_id[:128],
            ProductDispute.order_id == orden_id,
        )
    )
    if derivada is None:
        return
    derivada.external_dispute_id = clave[:128]
    derivada.updated_at = ahora()
    await db.flush()
    logger.info(
        "[productos] la disputa derivada de %s pasa a su identificador propio",
        referencia,
    )


async def _crear_o_leer(
    db: AsyncSession,
    *,
    orden_id: str,
    referencia: str,
    estado: str,
    importe: int,
    moneda: str,
    saldo: OwnerSaleBalance | None,
    momento: datetime,
) -> tuple[ProductDispute, bool]:
    """La fila de la disputa. UNA POR COBRO, y lo decide el índice único.

    NO SE PREGUNTA ANTES CON UN `select`: dos avisos simultáneos del mismo
    contracargo pasarían los dos esa comprobación. Se intenta escribir y, si la
    base dice que ya está, se lee la que hay. El punto de guardado es para no
    llevarse por delante la transacción de quien llama, que ya escribió el aviso
    en crudo contra su barrera anti-repetición.
    """
    disputa = ProductDispute(
        order_id=orden_id,
        balance_id=saldo.id if saldo is not None else None,
        provider=PROVEEDOR,
        external_dispute_id=referencia[:128],
        #: `product_disputes_importe` exige mayor que cero. Cuando el aviso no
        #: trae moneda no se puede apartar su importe —un numero sin moneda no
        #: significa nada—, y se escribe el minimo: la disputa bloquea por su
        #: ESTADO, no por su cifra, asi que no se pierde proteccion.
        amount_minor=max(1, importe),
        currency=moneda,
        status=estado,
        opened_at=momento,
        closed_at=momento if estado in DISPUTA_CERRADA else None,
        created_at=momento,
        updated_at=momento,
    )
    punto = await db.begin_nested()
    db.add(disputa)
    try:
        await db.flush()
    except IntegrityError:
        await punto.rollback()
        existente = await db.scalar(
            select(ProductDispute)
            .where(
                ProductDispute.provider == PROVEEDOR,
                ProductDispute.external_dispute_id == referencia[:128],
            )
            .with_for_update()
        )
        if existente is None:  # pragma: no cover - solo si el índice cambia
            raise
        return existente, False

    await _anotar(
        db,
        disputa,
        desde=None,
        hasta=estado,
        referencia=referencia,
        momento=momento,
    )
    logger.info("[productos] contracargo abierto sobre el pedido %s", orden_id)
    return disputa, True


async def _mover(
    db: AsyncSession,
    disputa: ProductDispute,
    *,
    hasta: str,
    evento,  # noqa: ANN001
    momento: datetime,
) -> None:
    """Lleva la disputa a su nuevo estado, si es que cambia.

    UN AVISO FUERA DE ORDEN NO REABRE UNA CERRADA. Stripe puede entregar
    `dispute.created` después de `dispute.closed`; volver a «abierta» dejaría
    el saldo bloqueado para siempre sobre algo que ya se resolvió.
    """
    if disputa.status == hasta:
        return
    if disputa.status in DISPUTA_CERRADA and hasta in DISPUTA_VIVA:
        logger.info(
            "[productos] aviso de disputa fuera de orden sobre %s; se ignora",
            disputa.id,
        )
        return
    anterior = disputa.status
    disputa.status = hasta
    disputa.updated_at = momento
    if hasta in DISPUTA_CERRADA:
        disputa.closed_at = momento
    await _anotar(
        db,
        disputa,
        desde=anterior,
        hasta=hasta,
        referencia=str(getattr(evento, "event_id", "") or "") or None,
        momento=momento,
    )


async def _aplicar_al_dinero(
    db: AsyncSession,
    *,
    disputa: ProductDispute,
    saldo: OwnerSaleBalance | None,
    momento: datetime,
) -> None:
    """Congelar mientras dure, y soltar solo cuando se sabe cómo acabó.

    MIENTRAS ESTÉ VIVA: el saldo pasa a `frozen` y su importe queda apartado en
    una reserva. Lo primero es lo que ve quien vende; lo segundo es lo que
    impide que `liberar_vencidos` lo pague —`por_que_no_se_libera` mira las
    reservas vivas—. Las dos cosas, porque cada una protege de algo distinto.

    AL GANARLA: se suelta la reserva y el saldo vuelve a la cola. No se paga
    aquí: vuelve a `pending` y pasa otra vez por todas las puertas, que pueden
    seguir teniendo una reclamación abierta.

    AL PERDERLA: la reserva se CONSUME —ese dinero se fue— y el saldo se
    cancela. No se carga nada a nadie: quién asume el coste está sin decidir.
    """
    if saldo is None:
        return

    vivo = disputa.status in DISPUTA_VIVA
    fresco = await db.get(OwnerSaleBalance, saldo.id, with_for_update=True)
    if fresco is None:  # pragma: no cover - el saldo no se borra
        return

    if vivo:
        if fresco.status in (finanzas.PENDIENTE, finanzas.ELEGIBLE):
            fresco.status = finanzas.RETENIDO
            fresco.updated_at = momento
        ya = [
            r
            for r in await finanzas.reservas_de(db, saldo_id=fresco.id, solo_vivas=True)
            if r.reason == finanzas.RESERVA_POR_DISPUTA
        ]
        if not ya:
            try:
                await finanzas.reservar(
                    db,
                    saldo=fresco,
                    importe_minor=max(1, int(disputa.amount_minor)),
                    motivo=finanzas.RESERVA_POR_DISPUTA,
                    momento=momento,
                )
            except Exception:  # noqa: BLE001
                #: YA HABÍA UNA. No es un fallo: el dinero está apartado, que
                #: es lo que se quería. El estado `frozen` ya lo bloquea además.
                logger.info(
                    "[productos] ya había reserva por disputa en %s", fresco.id
                )
        return

    #: CERRADA. Se suelta o se consume según cómo acabó.
    perdida = disputa.status == DISPUTA_PERDIDA
    for reserva in await finanzas.reservas_de(db, saldo_id=fresco.id, solo_vivas=True):
        if reserva.reason != finanzas.RESERVA_POR_DISPUTA:
            continue
        await finanzas.soltar_reserva(
            db,
            reserva=reserva,
            consumida=perdida,
            motivo=f"disputa {disputa.status}",
            momento=momento,
        )

    if perdida:
        #: EL DINERO YA SALIÓ. No se le paga a nadie, y no se inventa un cargo.
        if fresco.status not in (finanzas.TRANSFERIDO, finanzas.EN_TRANSFERENCIA):
            fresco.status = finanzas.CANCELADO
            fresco.updated_at = momento
        return

    #: GANADA O RETIRADA: vuelve a la cola, no al bolsillo. Pasará otra vez por
    #: todas las puertas, que pueden seguir cerradas por otra cosa.
    if fresco.status == finanzas.RETENIDO:
        fresco.status = finanzas.PENDIENTE
        fresco.updated_at = momento


async def del_pedido(db: AsyncSession, *, orden_id: str) -> list[ProductDispute]:
    """Las disputas de un pedido, para el expediente."""
    if not await esquema.hay_finanzas(db):
        return []
    return list(
        await db.scalars(
            select(ProductDispute)
            .where(ProductDispute.order_id == orden_id)
            .order_by(ProductDispute.created_at.desc())
        )
    )


async def historial_de(
    db: AsyncSession, *, disputa_id: str
) -> list[ProductDisputeEvent]:
    """Los pasos de una disputa, del más viejo al más nuevo."""
    return list(
        await db.scalars(
            select(ProductDisputeEvent)
            .where(ProductDisputeEvent.dispute_id == disputa_id)
            .order_by(ProductDisputeEvent.created_at, ProductDisputeEvent.id)
        )
    )


__all__ = [
    "DISPUTA_ABIERTA",
    "DISPUTA_CERRADA",
    "DISPUTA_EN_REVISION",
    "DISPUTA_GANADA",
    "DISPUTA_PERDIDA",
    "DISPUTA_RESPONDER",
    "DISPUTA_RETIRADA",
    "DISPUTA_VIVA",
    "atender_aviso",
    "del_pedido",
    "historial_de",
]
