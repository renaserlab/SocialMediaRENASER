"""Reseñas verificadas de producto (Incremento 8, migración 0081).

EL SELLO SE DERIVA, NO SE ESCRIBE. No existe ninguna columna `verified`. Una
reseña existe porque hay una línea de pedido, de un pedido pagado por quien
opina, cuyo paquete llegó; y eso lo imponen TRES CLAVES AJENAS COMPUESTAS de la
0081, no los `if` de este fichero. Lo que hay aquí arriba es la explicación —un
código de motivo que la pantalla puede traducir— para no enseñar un formulario
que la base va a rechazar. Si alguien borrara estas comprobaciones, el INSERT
seguiría fallando: la protección está debajo.

LA UNIDAD ES LA LÍNEA DE PEDIDO. Lo dice el blueprint §6 con todas las letras:
«una compra genera como máximo una reseña por línea de pedido». No es por
producto ni por variante: quien compró lo mismo en dos pedidos distintos opina
dos veces, porque le llegaron dos cajas en dos momentos y pueden no parecerse.

CINCO PUNTUACIONES, TODAS OBLIGATORIAS, y la general NO es la media de las otras
cuatro: responde a otra pregunta —«¿entregó lo que anunció?»— y promediarlas
exigiría decidir cuánto pesa cada eje, que no lo ha decidido nadie.

MODERAR ES ESCONDER, NUNCA REESCRIBIR. No hay ni una función en este módulo que
cambie la puntuación, el texto o el autor de una reseña ajena, y hay una prueba
que recorre el árbol de sintaxis para que siga sin haberla.

SIN RESEÑAS NO HAY PUNTUACIÓN, y no hay un cero. `promedio` es `None` cuando no
hay ninguna, y la puntuación ajustada tampoco se publica: con cero reseñas la
fórmula del blueprint devuelve el promedio de categoría tal cual, que es una
cifra sobre la categoría y no sobre este producto. Pintarla sería inventar.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.modules.products import esquema
from app.modules.products.models import (
    EJES_DE_RESENA,
    PEDIDO_PAGADO,
    RESENA_ESCONDIDA,
    RESENA_VISIBLE,
    Product,
    ProductOrder,
    ProductOrderItem,
    ProductReview,
    ProductReviewModeration,
    ProductReviewReply,
    ProductSeller,
    ProductShipment,
)

#: Los cuatro ejes, desde el modelo: el resumen, el contrato y las pruebas leen
#: la misma tupla y no pueden divergir.
EJES = EJES_DE_RESENA

#: LA FÓRMULA DEL BLUEPRINT §6.1, literal:
#:
#:     ajustada = (v / (v + 10)) * promedio + (10 / (v + 10)) * promedioCategoria
#:
#: Es una media bayesiana: con pocas opiniones la puntuación se acerca al
#: promedio de referencia, y con muchas se acerca a la real. Sirve para que un
#: producto con una sola reseña de cinco estrellas no aparezca por encima de uno
#: con doscientas de cuatro y media.
PESO_DEL_PREVIO = 10

#: «Si no existe promedio de categoría, categoryAverage = 4.2», blueprint §6.1.
#: DE DÓNDE SALE EL PROMEDIO DE CATEGORÍA ES UNA DECISIÓN ABIERTA —¿las reseñas
#: de la propia plataforma, una referencia externa, un valor por categoría que
#: escriba alguien?— y mientras no se tome se usa el del blueprint, que es la
#: fuente funcional escrita. No se calcula por nuestra cuenta: hacerlo sería
#: elegir la respuesta en silencio.
PROMEDIO_DE_CATEGORIA_POR_DEFECTO = 4.2

#: Cuántas reseñas devuelve una página. El cursor es `(created_at, id)`, que es
#: estable aunque dos reseñas compartan segundo.
POR_PAGINA = 20
TOPE_POR_PAGINA = 50


class ResenaNoPermitida(AppError):
    status_code = 409
    code = "product_review_not_allowed"


class ResenaDuplicada(ConflictError):
    code = "product_review_already_exists"


class ResenaNoEncontrada(NotFoundError):
    code = "product_review_not_found"


class RespuestaNoPermitida(ForbiddenError):
    code = "product_review_reply_forbidden"


class RespuestaDuplicada(ConflictError):
    code = "product_review_reply_already_exists"


@dataclass(frozen=True)
class Resumen:
    """Lo que se enseña en la ficha.

    `promedio` y `ajustada` son `None` cuando no hay ni una reseña. NO SON CERO:
    un producto sin opiniones no tiene una puntuación de 0,0; no tiene
    puntuación. Pintar cinco estrellas vacías dice algo que nadie ha dicho.
    """

    total: int
    promedio: float | None
    ajustada: float | None
    histograma: dict[int, int]
    recomiendan_bps: int | None
    por_eje: dict[str, float | None]
    #: De dónde salió el previo de la fórmula. Va explícito para que la pantalla
    #: pueda decir «referencia por defecto» en vez de dar a entender que Z
    #: calculó un promedio de categoría que todavía no calcula nadie.
    promedio_de_categoria: float
    categoria_configurada: bool


@dataclass(frozen=True)
class Valorable:
    """Una línea de un pedido entregado que todavía no se valoró."""

    order_item_id: str
    order_id: str
    product_id: str
    name_snapshot: str
    variant_name_snapshot: str | None
    quantity: int
    delivered_at: datetime
    review_id: str | None


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    """Sin la 0081, 503 con código estable. No 404 ni 500."""
    await esquema.exigir_resenas(db)


def _vacio() -> Resumen:
    return Resumen(
        total=0,
        promedio=None,
        ajustada=None,
        histograma={n: 0 for n in range(1, 6)},
        recomiendan_bps=None,
        por_eje={eje: None for eje in EJES},
        promedio_de_categoria=PROMEDIO_DE_CATEGORIA_POR_DEFECTO,
        categoria_configurada=False,
    )


def ajustar(promedio: float, cuantas: int, previo: float) -> float:
    """La media bayesiana del blueprint §6.1."""
    peso = cuantas + PESO_DEL_PREVIO
    return (cuantas / peso) * promedio + (PESO_DEL_PREVIO / peso) * previo


# --------------------------------------------------------------------------- #
# Quién puede opinar, y por qué no.
# --------------------------------------------------------------------------- #


async def _dueno_del_producto(db: AsyncSession, producto_id: str) -> str | None:
    return await db.scalar(
        select(ProductSeller.profile_id)
        .join(Product, Product.seller_id == ProductSeller.id)
        .where(Product.id == producto_id)
    )


async def puede_resenar(
    db: AsyncSession, *, order_item_id: str, usuario_id: str
) -> tuple[bool, str, Valorable | None]:
    """Si esta persona puede valorar esta línea, y por qué no.

    Devuelve `(puede, motivo, linea)`. El motivo es un CÓDIGO estable: la
    aplicación lo traduce y una consulta lo puede agrupar.

    404 PARA LO AJENO. Una línea de otra persona no contesta «no es tuya»: si lo
    hiciera, probar identificadores diría qué pedidos existen. Contesta
    `order_item_not_found`, igual que una que no existe.
    """
    if not await esquema.hay_resenas(db):
        return False, "reviews_not_available", None

    fila = (
        await db.execute(
            select(ProductOrderItem, ProductOrder, ProductShipment)
            .join(ProductOrder, ProductOrder.id == ProductOrderItem.order_id)
            .outerjoin(ProductShipment, ProductShipment.order_id == ProductOrder.id)
            .where(ProductOrderItem.id == order_item_id)
        )
    ).first()
    if fila is None:
        return False, "order_item_not_found", None

    linea, orden, envio = fila
    if orden.buyer_id != usuario_id:
        # LO AJENO NO EXISTE. Ver el docstring.
        return False, "order_item_not_found", None

    if orden.status != PEDIDO_PAGADO or orden.paid_at is None:
        return False, "order_not_paid", None

    if envio is None or envio.delivered_at is None:
        return False, "not_delivered", None

    # NADIE VALORA LO SUYO. Es la única de las cuatro condiciones que la base no
    # puede imponer —el dueño está a dos saltos: producto, vendedor, perfil— así
    # que vive aquí y tiene su propia prueba.
    if await _dueno_del_producto(db, linea.product_id) == usuario_id:
        return False, "own_product", None

    ya = await db.scalar(
        select(ProductReview.id).where(ProductReview.order_item_id == order_item_id)
    )
    valorable = Valorable(
        order_item_id=linea.id,
        order_id=orden.id,
        product_id=linea.product_id,
        name_snapshot=linea.name_snapshot,
        variant_name_snapshot=linea.variant_name_snapshot,
        quantity=linea.quantity,
        delivered_at=envio.delivered_at,
        review_id=ya,
    )
    if ya is not None:
        return False, "already_reviewed", valorable

    return True, "ok", valorable


async def valorables_del_pedido(
    db: AsyncSession, *, orden_id: str, usuario_id: str
) -> list[Valorable]:
    """Las líneas de un pedido entregado, con su reseña si ya la tienen.

    UNA SOLA CONSULTA PARA TODAS LAS LÍNEAS y otra para las reseñas: preguntar
    línea a línea sería el N+1 de siempre, y un pedido con doce líneas haría
    veinticinco viajes.
    """
    await exigir_disponible(db)

    fila = (
        await db.execute(
            select(ProductOrder, ProductShipment)
            .outerjoin(ProductShipment, ProductShipment.order_id == ProductOrder.id)
            .where(ProductOrder.id == orden_id)
        )
    ).first()
    if fila is None:
        return []
    orden, envio = fila
    if orden.buyer_id != usuario_id:
        return []
    if orden.status != PEDIDO_PAGADO or orden.paid_at is None:
        return []
    if envio is None or envio.delivered_at is None:
        return []

    lineas = list(
        await db.scalars(
            select(ProductOrderItem)
            .where(ProductOrderItem.order_id == orden_id)
            .order_by(ProductOrderItem.created_at, ProductOrderItem.id)
        )
    )
    if not lineas:
        return []

    #: DE QUIEN ES CADA PRODUCTO, en una consulta por producto distinto y no
    #: por linea. Hoy un pedido es de un solo proveedor, pero se mira por
    #: producto para que el dia que un carrito admita varios esto no mienta.
    duenos: dict[str, str | None] = {}
    for producto_id in dict.fromkeys(l.product_id for l in lineas):
        duenos[producto_id] = await _dueno_del_producto(db, producto_id)

    ya = {
        item: rid
        for item, rid in (
            await db.execute(
                select(ProductReview.order_item_id, ProductReview.id).where(
                    ProductReview.order_id == orden_id
                )
            )
        ).all()
    }

    salida: list[Valorable] = []
    for linea in lineas:
        if duenos.get(linea.product_id) == usuario_id:
            # NADIE VALORA LO SUYO, y tampoco se le ofrece.
            continue
        salida.append(
            Valorable(
                order_item_id=linea.id,
                order_id=orden_id,
                product_id=linea.product_id,
                name_snapshot=linea.name_snapshot,
                variant_name_snapshot=linea.variant_name_snapshot,
                quantity=linea.quantity,
                delivered_at=envio.delivered_at,
                review_id=ya.get(linea.id),
            )
        )
    return salida


# --------------------------------------------------------------------------- #
# Escribir, editar, esconder.
# --------------------------------------------------------------------------- #


def _es(fallo: IntegrityError, restriccion: str) -> bool:
    """Si el choque fue contra ESA restricción y no contra otra cualquiera.

    El nombre viaja en el mensaje del driver. Si un día dejara de viajar, esto
    devolvería `False` y el error subiría tal cual: ruidoso, pero honesto. Lo
    contrario —dar por supuesto que cualquier choque es el duplicado— convierte
    un fallo desconocido en un mensaje tranquilizador y falso.
    """
    return restriccion in str(getattr(fallo, "orig", fallo))


def _limpiar_comentario(comentario: str | None) -> str | None:
    if comentario is None:
        return None
    limpio = comentario.strip()
    return limpio[:1000] or None


async def crear(
    db: AsyncSession,
    *,
    order_item_id: str,
    usuario_id: str,
    overall: int,
    quality: int,
    fidelity: int,
    functioning: int,
    value_for_money: int,
    recommends: bool,
    comentario: str | None = None,
    momento: datetime | None = None,
) -> ProductReview:
    """Escribe la reseña de una línea entregada.

    NI EL PRODUCTO NI LAS FECHAS VIENEN DEL CLIENTE. Se leen de la línea, del
    pedido y del envío. Lo único que manda quien opina son las puntuaciones y el
    texto: todo lo que verifica la compra lo pone el servidor, y la base lo
    vuelve a comprobar con sus tres claves ajenas.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    puede, motivo, linea = await puede_resenar(
        db, order_item_id=order_item_id, usuario_id=usuario_id
    )
    if not puede:
        if motivo == "order_item_not_found":
            raise ResenaNoEncontrada("Esa compra no existe.")
        if motivo == "already_reviewed":
            raise ResenaDuplicada(
                "Ya valoraste esta compra.",
                details={"review_id": linea.review_id if linea else None},
            )
        raise ResenaNoPermitida(
            "Todavía no se puede valorar esta compra.", details={"reason": motivo}
        )
    assert linea is not None

    orden = await db.get(ProductOrder, linea.order_id)
    assert orden is not None and orden.paid_at is not None

    resena = ProductReview(
        product_id=linea.product_id,
        order_id=linea.order_id,
        order_item_id=linea.order_item_id,
        author_id=usuario_id,
        order_paid_at=orden.paid_at,
        delivered_at=linea.delivered_at,
        overall=int(overall),
        quality=int(quality),
        fidelity=int(fidelity),
        functioning=int(functioning),
        value_for_money=int(value_for_money),
        recommends=bool(recommends),
        comment=_limpiar_comentario(comentario),
        status=RESENA_VISIBLE,
        created_at=momento,
        updated_at=momento,
    )
    db.add(resena)
    try:
        await db.flush()
    except IntegrityError as fallo:
        # LA CARRERA. Dos envíos del mismo formulario, o dos pestañas. La única
        # que lo decide es la restricción única de la base.
        #
        # Y SOLO ESA. Tragarse cualquier `IntegrityError` y llamarlo duplicado
        # contaría una mentira: una puntuación fuera de rango o una clave ajena
        # rota diría «ya valoraste esta compra», que es falso y además esconde
        # el fallo de verdad. Cualquier otra se deja subir.
        await db.rollback()
        if _es(fallo, "product_reviews_una_por_linea"):
            raise ResenaDuplicada("Ya valoraste esta compra.") from None
        raise
    return resena


async def editar(
    db: AsyncSession,
    *,
    resena_id: str,
    usuario_id: str,
    overall: int | None = None,
    ejes: dict[str, int] | None = None,
    recommends: bool | None = None,
    comentario: str | None = None,
    momento: datetime | None = None,
) -> ProductReview:
    """Solo su autor, y solo lo que escribió.

    NO SE PUEDE CAMBIAR DE QUÉ COMPRA HABLA. `order_item_id`, `product_id` y las
    dos fechas no se tocan aquí, y la base tampoco lo permitiría sin romper sus
    claves ajenas.

    UNA ESCONDIDA NO SE EDITA. Reescribir lo que moderación escondió y dejarla
    escondida no sirve de nada, y dejarla visible sería saltarse la moderación
    editando. Quien quiera que se revise otra vez tiene que pedirlo.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    resena = await db.get(ProductReview, resena_id)
    if resena is None or resena.author_id != usuario_id:
        raise ResenaNoEncontrada("Reseña no encontrada.")
    if resena.status == RESENA_ESCONDIDA:
        raise ResenaNoPermitida(
            "Esta reseña está oculta por moderación y no se puede editar.",
            details={"reason": "hidden"},
        )

    if overall is not None:
        resena.overall = int(overall)
    for eje in EJES:
        if ejes is not None and eje in ejes and ejes[eje] is not None:
            setattr(resena, eje, int(ejes[eje]))
    if recommends is not None:
        resena.recommends = bool(recommends)
    if comentario is not None:
        resena.comment = _limpiar_comentario(comentario)
    resena.updated_at = momento
    await db.flush()
    return resena


async def moderar(
    db: AsyncSession,
    *,
    resena_id: str,
    actor_id: str,
    esconder: bool,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> ProductReview:
    """Esconde o restaura. NUNCA reescribe.

    La puntuación, el texto y el autor se quedan exactamente como estaban: lo
    único que cambia es si se ve. Y cada cambio deja una fila en el historial,
    que solo se añade.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    resena = await db.get(ProductReview, resena_id)
    if resena is None:
        raise ResenaNoEncontrada("Reseña no encontrada.")

    anterior = resena.status
    nuevo = RESENA_ESCONDIDA if esconder else RESENA_VISIBLE
    if anterior == nuevo:
        return resena

    resena.status = nuevo
    if esconder:
        resena.moderation_reason = (motivo or "").strip()[:500] or None
        resena.moderated_by = actor_id
        resena.moderated_at = momento
    else:
        # RESTAURAR LIMPIA LA MARCA, porque el CHECK de la 0081 exige que
        # «escondida» y «tiene fecha de moderación» sean lo mismo. El motivo por
        # el que se escondió no se pierde: vive en el historial.
        resena.moderation_reason = None
        resena.moderated_by = None
        resena.moderated_at = None
    resena.updated_at = momento

    db.add(
        ProductReviewModeration(
            review_id=resena.id,
            actor_id=actor_id,
            from_status=anterior,
            to_status=nuevo,
            reason=(motivo or "").strip()[:500] or None,
            created_at=momento,
        )
    )
    await db.flush()
    return resena


async def moderar_respuesta(
    db: AsyncSession,
    *,
    respuesta_id: str,
    actor_id: str,
    esconder: bool,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> ProductReviewReply:
    """Lo mismo, para la respuesta del proveedor."""
    await exigir_disponible(db)
    momento = momento or ahora()

    respuesta = await db.get(ProductReviewReply, respuesta_id)
    if respuesta is None:
        raise ResenaNoEncontrada("Respuesta no encontrada.")

    anterior = respuesta.status
    nuevo = RESENA_ESCONDIDA if esconder else RESENA_VISIBLE
    if anterior == nuevo:
        return respuesta

    if not esconder:
        # RESTAURAR PUEDE CHOCAR: si el proveedor escribió otra mientras esta
        # estaba escondida, habría dos visibles. Lo impide el índice parcial, y
        # aquí se dice con palabras en vez de dejar salir un 500.
        otra = await db.scalar(
            select(ProductReviewReply.id).where(
                ProductReviewReply.review_id == respuesta.review_id,
                ProductReviewReply.status == RESENA_VISIBLE,
                ProductReviewReply.id != respuesta.id,
            )
        )
        if otra is not None:
            raise RespuestaDuplicada(
                "Ya hay otra respuesta visible en esa reseña.",
                details={"reply_id": otra},
            )

    respuesta.status = nuevo
    if esconder:
        respuesta.moderation_reason = (motivo or "").strip()[:500] or None
        respuesta.moderated_by = actor_id
        respuesta.moderated_at = momento
    else:
        respuesta.moderation_reason = None
        respuesta.moderated_by = None
        respuesta.moderated_at = None
    respuesta.updated_at = momento

    db.add(
        ProductReviewModeration(
            reply_id=respuesta.id,
            actor_id=actor_id,
            from_status=anterior,
            to_status=nuevo,
            reason=(motivo or "").strip()[:500] or None,
            created_at=momento,
        )
    )
    await db.flush()
    return respuesta


# --------------------------------------------------------------------------- #
# La respuesta del proveedor.
# --------------------------------------------------------------------------- #


async def responder(
    db: AsyncSession,
    *,
    resena_id: str,
    usuario_id: str,
    texto: str,
    momento: datetime | None = None,
) -> ProductReviewReply:
    """El proveedor del producto responde en público. UNA VISIBLE, como mucho.

    404 PARA LA RESEÑA DE OTRO PRODUCTO. Quien vende no tiene por qué saber qué
    reseñas existen fuera de su catálogo.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    resena = await db.get(ProductReview, resena_id)
    if resena is None:
        raise ResenaNoEncontrada("Reseña no encontrada.")
    if await _dueno_del_producto(db, resena.product_id) != usuario_id:
        raise ResenaNoEncontrada("Reseña no encontrada.")
    if resena.status == RESENA_ESCONDIDA:
        # RESPONDER A LO QUE NO SE VE no tiene sentido, y dejaría una respuesta
        # visible colgando de una reseña invisible.
        raise RespuestaNoPermitida(
            "Esa reseña está oculta.", details={"reason": "hidden"}
        )

    limpio = (texto or "").strip()
    if not 1 <= len(limpio) <= 1000:
        raise ResenaNoPermitida(
            "La respuesta tiene que tener entre 1 y 1000 caracteres.",
            details={"reason": "length"},
        )

    respuesta = ProductReviewReply(
        review_id=resena.id,
        author_id=usuario_id,
        body=limpio,
        status=RESENA_VISIBLE,
        created_at=momento,
        updated_at=momento,
    )
    db.add(respuesta)
    try:
        await db.flush()
    except IntegrityError as fallo:
        await db.rollback()
        if _es(fallo, "product_review_replies_una_visible"):
            raise RespuestaDuplicada("Ya respondiste a esa reseña.") from None
        raise
    return respuesta


async def respuestas_de(
    db: AsyncSession, *, resena_ids: list[str]
) -> dict[str, ProductReviewReply]:
    """Las respuestas VISIBLES de un puñado de reseñas, en una sola consulta.

    CONTRA EL N+1. Pintar veinte reseñas preguntando la respuesta de cada una
    son veintiuna consultas; esto es una.
    """
    if not resena_ids:
        return {}
    filas = await db.scalars(
        select(ProductReviewReply).where(
            ProductReviewReply.review_id.in_(resena_ids),
            ProductReviewReply.status == RESENA_VISIBLE,
        )
    )
    return {r.review_id: r for r in filas}


# --------------------------------------------------------------------------- #
# Leer: resumen, lista, historial.
# --------------------------------------------------------------------------- #


async def resumen(db: AsyncSession, *, producto_id: str) -> Resumen:
    """Lo que la ficha necesita, en DOS consultas y no en una por estrella."""
    if not await esquema.hay_resenas(db):
        return _vacio()
    mapa = await resumen_de(db, producto_ids=[producto_id])
    return mapa.get(producto_id, _vacio())


async def resumen_de(
    db: AsyncSession, *, producto_ids: list[str]
) -> dict[str, Resumen]:
    """El resumen de VARIOS productos a la vez.

    Es lo que usa la portada y cualquier lista: sin esto, pintar doce tarjetas
    con su puntuación son veinticuatro consultas.
    """
    if not producto_ids or not await esquema.hay_resenas(db):
        return {}

    unicos = list(dict.fromkeys(producto_ids))

    agregado = (
        await db.execute(
            select(
                ProductReview.product_id,
                func.count(ProductReview.id),
                func.avg(ProductReview.overall),
                #: CUANTOS RECOMIENDAN. Un `sum` de un booleano no es
                #: portable entre PostgreSQL y SQLite; un `case` si.
                func.sum(case((ProductReview.recommends.is_(True), 1), else_=0)),
                *[func.avg(getattr(ProductReview, eje)) for eje in EJES],
            )
            .where(
                ProductReview.product_id.in_(unicos),
                ProductReview.status == RESENA_VISIBLE,
            )
            .group_by(ProductReview.product_id)
        )
    ).all()

    histogramas = (
        await db.execute(
            select(
                ProductReview.product_id,
                ProductReview.overall,
                func.count(ProductReview.id),
            )
            .where(
                ProductReview.product_id.in_(unicos),
                ProductReview.status == RESENA_VISIBLE,
            )
            .group_by(ProductReview.product_id, ProductReview.overall)
        )
    ).all()

    por_producto: dict[str, dict[int, int]] = {}
    for producto_id, estrella, cuantas in histogramas:
        por_producto.setdefault(producto_id, {n: 0 for n in range(1, 6)})
        por_producto[producto_id][int(estrella)] = int(cuantas)

    salida: dict[str, Resumen] = {}
    for fila in agregado:
        producto_id = fila[0]
        total = int(fila[1] or 0)
        promedio = float(fila[2]) if fila[2] is not None else None
        recomiendan = int(fila[3] or 0)
        ejes = {
            eje: (float(fila[4 + i]) if fila[4 + i] is not None else None)
            for i, eje in enumerate(EJES)
        }
        salida[producto_id] = Resumen(
            total=total,
            promedio=promedio,
            # CON CERO RESEÑAS NO SE PUBLICA NINGUNA PUNTUACIÓN AJUSTADA. La
            # fórmula devolvería el promedio de categoría entero, que habla de
            # la categoría y no de este producto.
            ajustada=(
                ajustar(promedio, total, PROMEDIO_DE_CATEGORIA_POR_DEFECTO)
                if promedio is not None and total > 0
                else None
            ),
            histograma=por_producto.get(producto_id, {n: 0 for n in range(1, 6)}),
            recomiendan_bps=(
                round(recomiendan * 10_000 / total) if total > 0 else None
            ),
            por_eje=ejes,
            promedio_de_categoria=PROMEDIO_DE_CATEGORIA_POR_DEFECTO,
            categoria_configurada=False,
        )

    for producto_id in unicos:
        salida.setdefault(producto_id, _vacio())
    return salida


async def listar(
    db: AsyncSession,
    *,
    producto_id: str,
    antes_de: tuple[datetime, str] | None = None,
    limite: int = POR_PAGINA,
) -> list[ProductReview]:
    """Las reseñas VISIBLES de un producto, de la más nueva a la más vieja.

    EL CURSOR ES `(created_at, id)` Y NO UN NÚMERO DE PÁGINA. Con un desplazamiento
    numérico, una reseña nueva mientras alguien lee corre todas las demás una
    posición y la página siguiente repite una fila y se salta otra. El orden
    desempata por `id` porque dos reseñas pueden compartir el mismo instante.
    """
    await exigir_disponible(db)
    limite = max(1, min(int(limite), TOPE_POR_PAGINA))

    consulta = select(ProductReview).where(
        ProductReview.product_id == producto_id,
        ProductReview.status == RESENA_VISIBLE,
    )
    if antes_de is not None:
        creada, ident = antes_de
        consulta = consulta.where(
            (ProductReview.created_at < creada)
            | ((ProductReview.created_at == creada) & (ProductReview.id < ident))
        )
    consulta = consulta.order_by(
        ProductReview.created_at.desc(), ProductReview.id.desc()
    ).limit(limite)
    return list(await db.scalars(consulta))


async def mia(
    db: AsyncSession, *, resena_id: str, usuario_id: str
) -> ProductReview:
    """La propia, incluso escondida: quien la escribió tiene derecho a saberlo."""
    await exigir_disponible(db)
    resena = await db.get(ProductReview, resena_id)
    if resena is None or resena.author_id != usuario_id:
        raise ResenaNoEncontrada("Reseña no encontrada.")
    return resena


async def mias(
    db: AsyncSession, *, usuario_id: str, limite: int = POR_PAGINA
) -> list[ProductReview]:
    """Las que escribió esta persona, escondidas incluidas."""
    await exigir_disponible(db)
    return list(
        await db.scalars(
            select(ProductReview)
            .where(ProductReview.author_id == usuario_id)
            .order_by(ProductReview.created_at.desc(), ProductReview.id.desc())
            .limit(max(1, min(int(limite), TOPE_POR_PAGINA)))
        )
    )


async def del_proveedor(
    db: AsyncSession, *, usuario_id: str, limite: int = POR_PAGINA
) -> list[ProductReview]:
    """Las reseñas de los productos de quien vende, para poder responderlas.

    Solo las VISIBLES: una escondida por moderación no se le enseña a nadie más
    que a quien la escribió.
    """
    await exigir_disponible(db)
    return list(
        await db.scalars(
            select(ProductReview)
            .join(Product, Product.id == ProductReview.product_id)
            .join(ProductSeller, ProductSeller.id == Product.seller_id)
            .where(
                ProductSeller.profile_id == usuario_id,
                ProductReview.status == RESENA_VISIBLE,
            )
            .order_by(ProductReview.created_at.desc(), ProductReview.id.desc())
            .limit(max(1, min(int(limite), TOPE_POR_PAGINA)))
        )
    )


async def para_moderar(
    db: AsyncSession, *, limite: int = POR_PAGINA
) -> list[ProductReview]:
    """La cola de moderación: las visibles, de la más nueva a la más vieja."""
    await exigir_disponible(db)
    return list(
        await db.scalars(
            select(ProductReview)
            .where(ProductReview.status == RESENA_VISIBLE)
            .order_by(ProductReview.created_at.desc(), ProductReview.id.desc())
            .limit(max(1, min(int(limite), TOPE_POR_PAGINA)))
        )
    )


async def historial_de_moderacion(
    db: AsyncSession, *, resena_id: str
) -> list[ProductReviewModeration]:
    """Qué se hizo con esta reseña y con su respuesta, en orden.

    Incluye las filas de la respuesta porque esconder la respuesta también es
    moderar esa conversación, y leerlo en dos sitios distintos haría falsa la
    lectura de cualquiera de los dos.
    """
    await exigir_disponible(db)
    respuestas = list(
        await db.scalars(
            select(ProductReviewReply.id).where(
                ProductReviewReply.review_id == resena_id
            )
        )
    )
    condicion = ProductReviewModeration.review_id == resena_id
    if respuestas:
        condicion = condicion | ProductReviewModeration.reply_id.in_(respuestas)
    return list(
        await db.scalars(
            select(ProductReviewModeration)
            .where(condicion)
            .order_by(ProductReviewModeration.created_at, ProductReviewModeration.id)
        )
    )


__all__ = [
    "EJES",
    "PESO_DEL_PREVIO",
    "POR_PAGINA",
    "PROMEDIO_DE_CATEGORIA_POR_DEFECTO",
    "TOPE_POR_PAGINA",
    "ResenaDuplicada",
    "ResenaNoEncontrada",
    "ResenaNoPermitida",
    "RespuestaDuplicada",
    "RespuestaNoPermitida",
    "Resumen",
    "Valorable",
    "ahora",
    "ajustar",
    "crear",
    "del_proveedor",
    "editar",
    "exigir_disponible",
    "historial_de_moderacion",
    "listar",
    "mia",
    "mias",
    "moderar",
    "moderar_respuesta",
    "para_moderar",
    "puede_resenar",
    "responder",
    "respuestas_de",
    "resumen",
    "resumen_de",
    "valorables_del_pedido",
]
