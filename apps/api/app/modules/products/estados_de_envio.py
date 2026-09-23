"""El ciclo de un envío. Lógica pura, sin base de datos y sin FastAPI.

POR QUÉ UNA MÁQUINA APARTE Y NO MÁS VALORES EN `product_orders.status`.

Un pedido tiene CINCO cosas que cambian por su cuenta y no se pueden meter en
un solo enum sin perder información:

    estado del pedido      ¿existe, sigue vivo, se canceló?
    estado del pago        ¿pendiente, cobrado, fallido, en revisión?
    estado del envío       ¿preparando, despachado, entregado?      <- ESTE
    estado de incidencia   ¿hay un caso abierto?          (Incremento 7)
    estado financiero      ¿retenido, liberado, devuelto? (Incremento 9)

Juntarlos obliga a inventar valores como `PAID_PREPARING_WITH_INCIDENT`, y el
número de valores crece multiplicando en vez de sumando. Peor: al escribir uno
se pierde el otro. Un pedido que pasa a «despachado» no deja de estar pagado, y
si el estado fuera uno solo habría que acordarse de no perder esa mitad.

`product_orders.status` sigue significando exactamente lo que significaba —dónde
está el COBRO— y no se le añade ni un valor. El envío vive en su propia fila,
con su propia máquina y su propio historial.

DOS PREGUNTAS DISTINTAS, como en el ciclo del producto:

    ¿existe ese salto?   -> si no, es un error de programación
    ¿TÚ puedes darlo?    -> si no, es un permiso que falta

LO QUE ESTA MÁQUINA NO PERMITE, Y ES EL PUNTO:

  1. NO SE VUELVE DE «DESPACHADO». Despachar saca las unidades del almacén y
     consume la reserva; deshacerlo significaría devolver al común unas
     unidades que están dentro de una caja camino de otra ciudad. Lo que ocurra
     con un paquete ya despachado es posventa, no una marcha atrás.
  2. NADIE FABRICA UNA ENTREGA. Administración no puede escribir «entregado»:
     no tiene forma de saberlo. Puede registrar que la entrega FALLÓ —eso se lo
     cuenta el transportista— y puede reabrir un paquete antes de que salga.
  3. QUIEN DESPACHA ES QUIEN ENTREGA EL PAQUETE. Solo el proveedor, porque es
     el único que puede afirmar que la caja salió de su almacén.
  4. RETROCEDER ANTES DE SALIR SÍ SE PUEDE, Y CON MOTIVO. Un paquete cerrado
     que hay que reabrir —se rompió algo al embalar— vuelve a «preparando».
     Prohibirlo dejaría el paquete atascado en «listo» para siempre, que es
     peor: obligaría a mentir en el siguiente estado.

LOS MOTIVOS NO SON DECORACIÓN. Los saltos que deshacen trabajo o que cuentan
una mala noticia exigen motivo, y sin él la máquina se para. Un «entrega
fallida» sin motivo no le sirve a nadie: ni a quien compró, que no sabe si
volver a estar en casa, ni a quien vende, que no sabe si reintentar.
"""

from __future__ import annotations

from app.core.exceptions import AppError

#: Pedido pagado que todavía no ha tocado nadie. NO ES UNA FILA: es lo que se
#: contesta mientras no exista, para no tener que crear una fila por cada
#: pedido que se cobra. Ver `envios.del_pedido`.
PENDIENTE = "PENDING"
PREPARANDO = "PREPARING"
LISTO = "READY"
DESPACHADO = "DISPATCHED"
ENTREGADO = "DELIVERED"
ENTREGA_FALLIDA = "DELIVERY_FAILED"
CANCELADO = "CANCELLED"

ESTADOS = (
    PENDIENTE,
    PREPARANDO,
    LISTO,
    DESPACHADO,
    ENTREGADO,
    ENTREGA_FALLIDA,
    CANCELADO,
)

#: Quién puede dar cada paso.
COMPRADOR = "buyer"
PROVEEDOR = "seller"
ADMINISTRACION = "admin"
SISTEMA = "system"
ACTORES = (COMPRADOR, PROVEEDOR, ADMINISTRACION, SISTEMA)

#: Los que no llevan a ningún sitio DENTRO DE ESTE INCREMENTO. Una devolución
#: es otra máquina y otro incremento: no es «volver de entregado».
FINALES = frozenset({ENTREGADO, CANCELADO})

#: TODAVÍA NO HA SALIDO DEL ALMACÉN, y por tanto sigue apartando unidades.
#: La reserva de un pedido pagado se consume al despachar, no al cobrar.
ANTES_DE_SALIR = frozenset({PENDIENTE, PREPARANDO, LISTO})

#: YA SALIÓ. Estos estados han consumido la reserva exactamente una vez.
DESPUES_DE_SALIR = frozenset({DESPACHADO, ENTREGADO, ENTREGA_FALLIDA})

#: `(desde, hasta) -> quiénes`. Lo que no está aquí, no existe.
TRANSICIONES: dict[tuple[str, str], frozenset[str]] = {
    # --- Preparar ------------------------------------------------------- #
    (PENDIENTE, PREPARANDO): frozenset({PROVEEDOR, ADMINISTRACION}),
    (PREPARANDO, LISTO): frozenset({PROVEEDOR, ADMINISTRACION}),
    # REABRIR UN PAQUETE CERRADO. Nada ha salido todavía y nada se ha
    # consumido: es el único paso atrás que esta máquina admite, y exige
    # motivo. Ver la cabecera, punto 4.
    (LISTO, PREPARANDO): frozenset({PROVEEDOR, ADMINISTRACION}),
    # --- Salir ---------------------------------------------------------- #
    # SOLO EL PROVEEDOR. Es el único que puede afirmar que la caja salió, y
    # este salto es el que consume el inventario.
    (LISTO, DESPACHADO): frozenset({PROVEEDOR}),
    # --- Llegar --------------------------------------------------------- #
    # ADMINISTRACIÓN NO ESTÁ AQUÍ, a propósito: no tiene cómo saber que algo
    # llegó, y escribirlo sería fabricar una entrega.
    (DESPACHADO, ENTREGADO): frozenset({PROVEEDOR, COMPRADOR}),
    (DESPACHADO, ENTREGA_FALLIDA): frozenset({PROVEEDOR, ADMINISTRACION}),
    # EL TRANSPORTISTA VUELVE A INTENTARLO. No es marcha atrás: es un intento
    # nuevo, y lleva motivo para que se pueda leer por qué falló el anterior.
    (ENTREGA_FALLIDA, DESPACHADO): frozenset({PROVEEDOR, ADMINISTRACION}),
    (ENTREGA_FALLIDA, ENTREGADO): frozenset({PROVEEDOR, COMPRADOR}),
    # --- Cancelar, solo antes de salir ---------------------------------- #
    # EXISTE EN LA MÁQUINA Y HOY NO SE PUEDE USAR. Cancelar un pedido YA
    # PAGADO obliga a devolver el dinero, y ninguna política publicada dice
    # con qué plazo, en qué casos ni quién paga el porte de vuelta. El
    # servicio lo para con su propio código; aquí queda declarado quién podría
    # darlo el día que esa decisión exista, que es administración y nadie más.
    (PENDIENTE, CANCELADO): frozenset({ADMINISTRACION}),
    (PREPARANDO, CANCELADO): frozenset({ADMINISTRACION}),
    (LISTO, CANCELADO): frozenset({ADMINISTRACION}),
}

#: LOS SALTOS QUE EXIGEN MOTIVO. Los que deshacen trabajo hecho y los que
#: cuentan una mala noticia: sin el porqué, el historial no sirve para nada.
CON_MOTIVO: frozenset[tuple[str, str]] = frozenset(
    {
        (LISTO, PREPARANDO),
        (DESPACHADO, ENTREGA_FALLIDA),
        (ENTREGA_FALLIDA, DESPACHADO),
        (PENDIENTE, CANCELADO),
        (PREPARANDO, CANCELADO),
        (LISTO, CANCELADO),
    }
)

#: EL ÚNICO SALTO QUE SACA UNIDADES DEL ALMACÉN.
CONSUME_INVENTARIO: frozenset[tuple[str, str]] = frozenset({(LISTO, DESPACHADO)})

#: LOS QUE DEVUELVEN AL COMÚN LO QUE ESTE PEDIDO APARTABA.
LIBERA_INVENTARIO: frozenset[tuple[str, str]] = frozenset(
    {
        (PENDIENTE, CANCELADO),
        (PREPARANDO, CANCELADO),
        (LISTO, CANCELADO),
    }
)

#: Cuántos caracteres, como mínimo, hacen un motivo que se pueda leer. Tres es
#: lo que ya exige un ajuste de inventario: la misma vara para lo mismo.
MINIMO_DEL_MOTIVO = 3
MAXIMO_DEL_MOTIVO = 500


class SaltoInexistente(AppError):
    """Ese paso no está en la máquina. Es un error de programación."""

    status_code = 409
    code = "product_shipment_transition_invalid"


class SaltoNoPermitido(AppError):
    """El paso existe, pero no para quien lo pide."""

    status_code = 403
    code = "product_shipment_transition_forbidden"


class MotivoNecesario(AppError):
    """Ese paso no se da sin explicar por qué."""

    status_code = 422
    code = "product_shipment_reason_required"


def existe(desde: str, hasta: str) -> bool:
    return (desde, hasta) in TRANSICIONES


def quienes(desde: str, hasta: str) -> frozenset[str]:
    return TRANSICIONES.get((desde, hasta), frozenset())


def es_final(estado: str) -> bool:
    return estado in FINALES


def exige_motivo(desde: str, hasta: str) -> bool:
    return (desde, hasta) in CON_MOTIVO


def consume_inventario(desde: str, hasta: str) -> bool:
    return (desde, hasta) in CONSUME_INVENTARIO


def libera_inventario(desde: str, hasta: str) -> bool:
    return (desde, hasta) in LIBERA_INVENTARIO


def ya_salio(estado: str) -> bool:
    """Si ese estado significa que las unidades ya no están en el almacén."""
    return estado in DESPUES_DE_SALIR


def exigir(desde: str, hasta: str, actor: str, motivo: str | None = None) -> str | None:
    """Se para si el salto no existe, no es de quien lo pide o le falta motivo.

    Devuelve el motivo ya limpio, o `None` cuando ese salto no lo exige y no se
    mandó ninguno. EL ORDEN IMPORTA: primero si el salto existe —porque un
    salto que no existe no tiene actores ni motivo que comprobar—, después
    quién, y el motivo al final, que es lo único que quien llama puede
    corregir sin cambiar de idea.
    """
    limpio = (motivo or "").strip()

    if desde == hasta:
        raise SaltoInexistente(
            f"El envío ya está {desde}.", details={"status": desde}
        )
    if not existe(desde, hasta):
        raise SaltoInexistente(
            f"Un envío {desde} no puede pasar a {hasta}.",
            details={"from": desde, "to": hasta},
        )
    if actor not in quienes(desde, hasta):
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )
    if exige_motivo(desde, hasta) and len(limpio) < MINIMO_DEL_MOTIVO:
        raise MotivoNecesario(
            "Ese paso lleva motivo.",
            details={
                "from": desde,
                "to": hasta,
                "field": "reason",
                "min": MINIMO_DEL_MOTIVO,
            },
        )
    return limpio[:MAXIMO_DEL_MOTIVO] or None


def siguientes(desde: str, actor: str) -> tuple[str, ...]:
    """Lo que ESTE actor puede hacer ahora. Para pintar botones, no para
    decidir: quien decide es `exigir`, con la fila delante."""
    return tuple(
        sorted(h for (d, h), q in TRANSICIONES.items() if d == desde and actor in q)
    )


__all__ = [
    "ACTORES",
    "ADMINISTRACION",
    "ANTES_DE_SALIR",
    "CANCELADO",
    "COMPRADOR",
    "CONSUME_INVENTARIO",
    "CON_MOTIVO",
    "DESPACHADO",
    "DESPUES_DE_SALIR",
    "ENTREGADO",
    "ENTREGA_FALLIDA",
    "ESTADOS",
    "FINALES",
    "LIBERA_INVENTARIO",
    "LISTO",
    "MAXIMO_DEL_MOTIVO",
    "MINIMO_DEL_MOTIVO",
    "MotivoNecesario",
    "PENDIENTE",
    "PREPARANDO",
    "PROVEEDOR",
    "SISTEMA",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES",
    "consume_inventario",
    "es_final",
    "exige_motivo",
    "exigir",
    "existe",
    "libera_inventario",
    "quienes",
    "siguientes",
    "ya_salio",
]
