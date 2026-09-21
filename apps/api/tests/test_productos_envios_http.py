"""El Incremento 6 POR HTTP: las rutas, los permisos y los moldes de salida.

POR QUE ADEMAS DE LAS DEL SERVICIO. `test_productos_envios.py` llama a
`envios.py` directamente y demuestra las reglas del dominio; eso deja sin
comprobar exactamente lo que ve una pantalla: que la ruta existe, que exige el
rol que dice exigir, que contesta el codigo que promete y que el molde de
respuesta NO lleva lo que no puede llevar.

Un fallo tipico que solo se ve aqui: una ruta correcta detras de una puerta de
permisos puesta al reves, o un molde que se lleva la direccion a una lista donde
no pinta nada.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. EL RECORRIDO COMPLETO DE LOS TRES ACTORES, por las rutas de verdad.
  2. UN PROVEEDOR RECIBE 404 —no 403— ante el pedido de otro.
  3. MODERACION NO PUEDE INTERVENIR UN ENVIO: 403.
  4. ADMINISTRACION NO PUEDE DESPACHAR NI ESCRIBIR «ENTREGADO» por su ruta.
  5. LA COLA DE ADMINISTRACION NO LLEVA NI UN DATO PERSONAL.
  6. LA LISTA DEL PROVEEDOR NO LLEVA NI EL COBRO NI QUIEN COMPRO.
  7. EL SEGUIMIENTO VIAJA DENTRO DEL PEDIDO, y es nulo si no hay nada que
     enviar.
  8. REPETIR EL DESPACHO NO DESPACHA DOS VECES, tampoco por HTTP.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import create_app
from app.modules.products import inventory, pedidos
from app.modules.products.models import (
    SALIDA,
    InventoryMovement,
    ProductOrder,
    ProductSeller,
)
from app.shared.database import get_db
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)
from tests.test_productos_envios import pedido_pagado  # noqa: F401
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    PasarelaDeMentira,
    bolsa_con,
    crear_pedido,
    motor,
    politica_publicada,
    venta_encendida,
)

PRODUCTOS = "/api/v1/products"
ADMIN = "/api/v1/admin/products"


@pytest_asyncio.fixture()
async def cliente(sesiones):
    """La aplicacion de verdad, con la sesion de la base local de la prueba.

    `quien` es un diccionario mutable: cambiarlo cambia quien llama, y asi la
    misma prueba puede recorrer el camino de los tres actores sin montar tres
    clientes.
    """
    app = create_app()
    quien: dict[str, str] = {"uid": ""}

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=quien["uid"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, quien
    for dep in (get_db, get_current_user, get_optional_user):
        app.dependency_overrides.pop(dep, None)


async def _duenno(sesiones, orden_id: str) -> str:
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        return (await db.get(ProductSeller, orden.seller_id)).profile_id


async def _rol(sesiones, usuario_id: str, rol: str) -> None:
    from app.modules.profiles.models import Profile

    async with sesiones() as db:
        (await db.get(Profile, usuario_id)).role = rol
        await db.commit()


# =========================================================================== #
# 1. El recorrido entero, por las rutas de verdad
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_recorrido_entero_de_los_tres_actores(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """Comprar pagado -> preparar -> cerrar -> despachar -> entregar.

    TODO POR HTTP, y comprobando en cada paso lo que ve cada quien.
    """
    http, quien = cliente
    producto_id, variantes, comprador, orden_id = await pedido_pagado(
        sesiones, monkeypatch
    )
    proveedor = await _duenno(sesiones, orden_id)

    # --- Quien compra ve su pedido con el envio dentro -------------------- #
    quien["uid"] = comprador
    mio = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    assert mio.status_code == 200, mio.text
    envio = mio.json()["shipment"]
    assert envio is not None
    assert envio["status"] == "PENDING"
    assert envio["exists"] is False, "nadie lo ha tocado todavia"
    #: Y LO UNICO QUE PUEDE HACER es confirmar que llego, cuando llegue.
    assert envio["available_transitions"] == []

    # --- Quien vende lo ve en su lista, SIN cobro ni comprador ------------ #
    quien["uid"] = proveedor
    lista = await http.get(f"{PRODUCTOS}/seller/orders")
    assert lista.status_code == 200, lista.text
    fila = next(p for p in lista.json() if p["id"] == orden_id)
    for prohibido in ("buyer_id", "external_payment_id", "provider", "policy"):
        assert prohibido not in fila, prohibido
    assert fila["shipment"]["status"] == "PENDING"
    #: EN LA LISTA NO VIENE EL HISTORIAL: no se lee, y traerlo serian tantas
    #: consultas como pedidos.
    assert fila["shipment"]["history"] == []

    # --- Preparar --------------------------------------------------------- #
    detalle = await http.get(f"{PRODUCTOS}/seller/orders/{orden_id}")
    assert detalle.status_code == 200
    lineas = detalle.json()["shipment"]["items"]
    assert len(lineas) == 1
    assert lineas[0]["prepared_quantity"] == 0

    a_medias = await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare",
        json={"items": [{"order_item_id": lineas[0]["order_item_id"], "prepared_quantity": 1}]},
    )
    assert a_medias.status_code == 200, a_medias.text
    assert a_medias.json()["shipment"]["status"] == "PREPARING"

    # --- Cerrar a medias NO SE PUEDE, y dice que falta -------------------- #
    pronto = await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready")
    assert pronto.status_code == 409, pronto.text
    cuerpo = pronto.json()
    assert cuerpo["error"]["code"] == "product_shipment_not_fully_prepared"
    assert cuerpo["error"]["details"]["missing"][0]["prepared_quantity"] == 1

    # --- Con todo dentro, si ---------------------------------------------- #
    completo = await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare",
        json={"items": [{"order_item_id": lineas[0]["order_item_id"], "prepared_quantity": 2}]},
    )
    assert completo.status_code == 200, completo.text
    cerrado = await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready")
    assert cerrado.status_code == 200, cerrado.text
    assert cerrado.json()["shipment"]["status"] == "READY"

    # --- Despachar: AQUI SALEN LAS UNIDADES ------------------------------- #
    despachado = await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/dispatch",
        json={"carrier_name": "Transporte de prueba", "tracking_reference": "AB-1"},
    )
    assert despachado.status_code == 200, despachado.text
    assert despachado.json()["shipment"]["status"] == "DISPATCHED"

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert (hay.on_hand, hay.reserved) == (3, 0)

    # --- REPETIR EL POST NO DESPACHA DOS VECES ---------------------------- #
    otra_vez = await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/dispatch", json={}
    )
    assert otra_vez.status_code == 200, otra_vez.text
    assert otra_vez.json()["shipment"]["carrier_name"] == "Transporte de prueba"
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
    assert (hay.on_hand, hay.reserved) == (3, 0)
    assert salidas == 1

    # --- Quien compra ya ve el seguimiento -------------------------------- #
    quien["uid"] = comprador
    ahora = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    seguimiento = ahora.json()["shipment"]
    assert seguimiento["status"] == "DISPATCHED"
    assert seguimiento["carrier_name"] == "Transporte de prueba"
    assert "DELIVERED" in seguimiento["available_transitions"]
    #: EL PEDIDO SIGUE PAGADO: son dos maquinas distintas.
    assert ahora.json()["status"] == "PAID"

    # --- Y confirma que le llego ------------------------------------------ #
    recibido = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/shipment/confirm-receipt"
    )
    assert recibido.status_code == 200, recibido.text
    final = recibido.json()["shipment"]
    assert final["status"] == "DELIVERED"
    assert final["delivered_source"] == "buyer"
    assert final["buyer_confirmed_at"] is not None
    #: Y NO SE OFRECE OTRA VEZ.
    assert "DELIVERED" not in final["available_transitions"]

    #: CONFIRMARLO DOS VECES NO ES UN ERROR y no cambia nada.
    repetido = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/shipment/confirm-receipt"
    )
    assert repetido.status_code == 200
    assert repetido.json()["shipment"]["status"] == "DELIVERED"

    #: NI DEVUELVE NADA AL ALMACEN.
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert (hay.on_hand, hay.reserved) == (3, 0)


# =========================================================================== #
# 2. Lo ajeno es un 404
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_pedido_de_otro_proveedor_es_un_404_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """404 Y NO 403 EN TODAS LAS RUTAS DEL PROVEEDOR, no solo en la de leer.

    Basta con que una sola conteste 403 para que se pueda averiguar que ese
    pedido existe.
    """
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    otro = await persona(sesiones, "provajeno")
    await vendedor(sesiones, otro)
    quien["uid"] = otro

    rutas = [
        ("get", f"{PRODUCTOS}/seller/orders/{orden_id}", None),
        ("post", f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare", {"items": []}),
        ("post", f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready", None),
        ("post", f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/dispatch", {}),
        ("post", f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/delivered", None),
        (
            "post",
            f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/failed",
            {"reason": "lo que sea"},
        ),
    ]
    for metodo, ruta, cuerpo in rutas:
        respuesta = await getattr(http, metodo)(
            ruta, **({"json": cuerpo} if cuerpo is not None else {})
        )
        assert respuesta.status_code == 404, f"{ruta} contesto {respuesta.status_code}"

    #: Y SU LISTA ESTA VACIA: no ve ni que existe.
    lista = await http.get(f"{PRODUCTOS}/seller/orders")
    assert lista.status_code == 200
    assert lista.json() == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_pedido_de_otro_comprador_es_un_404_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien["uid"] = await persona(sesiones, "ajenohttp")

    assert (await http.get(f"{PRODUCTOS}/orders/{orden_id}")).status_code == 404
    confirmar = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/shipment/confirm-receipt"
    )
    assert confirmar.status_code == 404


# =========================================================================== #
# 3. Los permisos de administracion
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderacion_no_interviene_un_envio_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """403 PARA MODERACION. Un envio mueve inventario, y eso no es moderar.

    Y EL ROL SE COMPRUEBA ANTES QUE LA PUERTA DE ESQUEMA: si fuera al reves,
    una cuenta sin permisos distinguiria un 503 de un 403 y averiguaria que
    migraciones estan aplicadas.
    """
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modhttp")
    await _rol(sesiones, moderador, "moderator")
    quien["uid"] = moderador

    intento = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "PREPARING", "reason": "lo intento igualmente"},
    )
    assert intento.status_code == 403, intento.text
    assert intento.json()["error"]["code"] == "product_shipment_intervene_forbidden"

    #: PERO SI PUEDE MIRAR LA COLA: no lleva datos personales, y vigilar no es
    #: mover.
    cola = await http.get(f"{ADMIN}/shipments")
    assert cola.status_code == 200, cola.text


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_administracion_no_despacha_ni_entrega_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LA RUTA EXISTE Y LA MAQUINA LA PARA. 403, y el almacen intacto."""
    http, quien = cliente
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    proveedor = await _duenno(sesiones, orden_id)
    manda = await persona(sesiones, "adminhttp")
    await _rol(sesiones, manda, "admin")

    #: Se deja el paquete listo, para que el salto a despachado exista.
    quien["uid"] = proveedor
    detalle = await http.get(f"{PRODUCTOS}/seller/orders/{orden_id}")
    linea = detalle.json()["shipment"]["items"][0]
    await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare",
        json={
            "items": [
                {
                    "order_item_id": linea["order_item_id"],
                    "prepared_quantity": linea["ordered_quantity"],
                }
            ]
        },
    )
    await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready")

    quien["uid"] = manda
    despachar = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "DISPATCHED", "reason": "quiero sacarlo yo"},
    )
    assert despachar.status_code == 403, despachar.text
    assert (
        despachar.json()["error"]["code"] == "product_shipment_transition_forbidden"
    )

    #: EL ALMACEN NO SE ENTERO DEL INTENTO.
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert (hay.on_hand, hay.reserved) == (5, 2)

    #: LO QUE SI PUEDE: reabrir un paquete cerrado, con motivo.
    reabrir = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "PREPARING", "reason": "el proveedor pidio revisarlo"},
    )
    assert reabrir.status_code == 200, reabrir.text
    assert reabrir.json()["status"] == "PREPARING"

    #: Y SIN MOTIVO NO PUEDE NI ESO.
    sin_motivo = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "READY", "reason": ""},
    )
    assert sin_motivo.status_code == 422, sin_motivo.text


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_por_http_dice_que_decision_falta(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """NI EN SILENCIO NI CON UN 500. 409 y la lista de lo que falta."""
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    manda = await persona(sesiones, "adminhttp2")
    await _rol(sesiones, manda, "admin")
    quien["uid"] = manda

    respuesta = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "CANCELLED", "reason": "se quedo sin stock"},
    )
    assert respuesta.status_code == 409, respuesta.text
    error = respuesta.json()["error"]
    assert error["code"] == "product_shipment_cancellation_not_configured"
    assert "refund_policy" in error["details"]["pending"]


# =========================================================================== #
# 4. Los moldes no llevan lo que no pueden llevar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cola_de_administracion_no_lleva_datos_personales_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """NI DIRECCION, NI NOMBRE DE QUIEN COMPRO, NI IMPORTE.

    Se comprueba sobre el JSON entero, no sobre las claves: un dato personal
    metido dentro de un texto libre tambien es un dato personal.
    """
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    manda = await persona(sesiones, "adminhttp3")
    await _rol(sesiones, manda, "admin")
    quien["uid"] = manda

    async with sesiones() as db:
        direccion = await pedidos.direccion_de(db, orden_id)

    cola = await http.get(f"{ADMIN}/shipments")
    assert cola.status_code == 200, cola.text
    crudo = cola.text
    for dato in (
        direccion.recipient_name,
        direccion.phone,
        direccion.address_line,
        direccion.city,
    ):
        assert dato not in crudo, f"la cola filtra «{dato}»"

    fila = next(f for f in cola.json() if f["order_id"] == orden_id)
    for prohibido in ("address", "recipient_name", "phone", "buyer_id", "total_minor"):
        assert prohibido not in fila, prohibido
    #: Y LO QUE SI LLEVA: el tiempo transcurrido, que es un hecho.
    assert fila["waiting_hours"] is not None
    assert fila["units"] == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_sin_pagar_no_trae_envio_por_http(
    sesiones, cliente, venta_encendida
) -> None:
    """NULO, NO «PENDIENTE DE PREPARACION».

    Contestar «pendiente de preparacion» sobre un pedido que nadie pago haria
    creer que va a salir algo.
    """
    http, quien = cliente
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    quien["uid"] = comprador

    mio = await http.get(f"{PRODUCTOS}/orders/{creado.orden.id}")
    assert mio.status_code == 200, mio.text
    assert mio.json()["status"] == "PENDING_PAYMENT"
    assert mio.json()["shipment"] is None

    #: Y NO SE PUEDE CONFIRMAR UNA RECEPCION QUE NO EXISTE.
    confirmar = await http.post(
        f"{PRODUCTOS}/orders/{creado.orden.id}/shipment/confirm-receipt"
    )
    assert confirmar.status_code == 409, confirmar.text
    assert confirmar.json()["error"]["code"] == "product_shipment_order_not_paid"


# =========================================================================== #
# 5. El numero de consultas, contado
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_lista_del_proveedor_no_lee_dos_veces_las_mismas_lineas(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LO CONTO LA REVISION INDEPENDIENTE, y sin contar no se ve.

    `del_pedido` volvia a leer las lineas del pedido que la respuesta ya habia
    leido para el albaran: dos consultas a `product_order_items` por cada
    pedido de la lista. No revienta nada y no se nota con tres pedidos; se
    nota con trescientos, y para entonces nadie recuerda por que.

    SE CUENTAN LAS CONSULTAS A ESA TABLA, no el tiempo: un umbral de
    milisegundos convierte la prueba en una apuesta sobre la maquina.
    """
    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    proveedor = await _duenno(sesiones, orden_id)
    quien["uid"] = proveedor

    consultas: list[str] = []

    from sqlalchemy import event

    async with sesiones() as db:
        motor_sincrono = (await db.connection()).sync_engine

    def _apuntar(conn, cursor, sentencia, parametros, contexto, muchas):
        if "product_order_items" in sentencia:
            consultas.append(sentencia)

    event.listen(motor_sincrono, "before_cursor_execute", _apuntar)
    try:
        respuesta = await http.get(f"{PRODUCTOS}/seller/orders")
    finally:
        event.remove(motor_sincrono, "before_cursor_execute", _apuntar)

    assert respuesta.status_code == 200, respuesta.text
    cuantos = len(respuesta.json())
    assert cuantos >= 1
    #: UNA POR PEDIDO PARA LAS LINEAS. La de las cantidades preparadas va a
    #: otra tabla y no cuenta aqui.
    assert len(consultas) <= cuantos, (
        f"{len(consultas)} consultas a product_order_items para {cuantos} pedidos"
    )


@pytest.mark.asyncio
async def test_quien_compro_puede_confirmar_una_entrega_que_registro_el_proveedor(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LA CONFIRMACION DE QUIEN COMPRO NO ES UN SALTO, Y ASI NO SE OFRECIA.

    `registrar_entrega` tiene un camino explicito para esto —«YA ESTABA
    ENTREGADO. Si lo confirma quien compro, se guarda su confirmacion, que es
    un dato que no teniamos»— y el servidor lo acepta. Pero la maquina no tiene
    ninguna transicion desde DELIVERED, asi que `available_transitions` venia
    VACIA y el movil, que solo pinta lo que el servidor ofrece, no ensenaba
    nunca el boton.

    Resultado: en cuanto el proveedor registraba la entrega, quien compro ya no
    podia decir «si, me llego». `buyer_confirmed_at` quedaba inalcanzable por
    ese camino, que es justo el camino normal.

    NO ES UN CAMBIO DE MAQUINA: DELIVERED -> DELIVERED no existe y no se
    inventa. Lo que se corrige es lo que el servidor ANUNCIA que aceptara.
    """
    http, quien = cliente
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    proveedor = await _duenno(sesiones, orden_id)

    #: El proveedor lo prepara, lo despacha y REGISTRA LA ENTREGA el primero.
    quien["uid"] = proveedor
    detalle = (await http.get(f"{PRODUCTOS}/seller/orders/{orden_id}")).json()
    await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare",
        json={
            "items": [
                {"order_item_id": l["id"], "prepared_quantity": l["quantity"]}
                for l in detalle["items"]
            ]
        },
    )
    await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready")
    await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/dispatch", json={})
    entregado = await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/delivered"
    )
    assert entregado.status_code == 200, entregado.text

    #: Y AHORA QUIEN COMPRO MIRA SU PEDIDO.
    quien["uid"] = comprador
    pedido = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    assert pedido.status_code == 200, pedido.text
    envio = pedido.json()["shipment"]
    assert envio["status"] == "DELIVERED"
    assert envio["delivered_source"] == "seller"
    assert envio["buyer_confirmed_at"] is None, "todavia no lo ha confirmado"
    assert "DELIVERED" in envio["available_transitions"], (
        "el servidor no le ofrece confirmar una entrega que si acepta: el boton"
        " no se pinta nunca"
    )

    #: Y EL SERVIDOR LO ACEPTA DE VERDAD, que es lo que hace correcta la oferta.
    confirmado = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/shipment/confirm-receipt"
    )
    assert confirmado.status_code == 200, confirmado.text
    assert confirmado.json()["shipment"]["buyer_confirmed_at"] is not None

    #: UNA SOLA VEZ: confirmado ya, deja de ofrecerse.
    otra = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    assert "DELIVERED" not in otra.json()["shipment"]["available_transitions"]

    #: Y AL PROVEEDOR NUNCA SE LE OFRECE: ya no hay nada que registrar.
    quien["uid"] = proveedor
    suyo = await http.get(f"{PRODUCTOS}/seller/orders/{orden_id}")
    assert "DELIVERED" not in (suyo.json()["shipment"]["available_transitions"])


@pytest.mark.asyncio
async def test_el_motivo_del_envio_no_pisa_el_de_suspender_un_producto(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """DOS CLASES CON EL MISMO NOMBRE, Y LA SEGUNDA GANA EN SILENCIO.

    LO ENCONTRO LA REVISION INDEPENDIENTE. El Incremento 6 anadio un
    `MotivoRequest` con campo `reason` al final de `schemas.py`, donde ya habia
    otro con campo `motivo`. Python rebindea el nombre: el router importa
    `MotivoRequest` y se queda con el ultimo, asi que
    `/admin/products/{id}/suspend` —que es del Incremento 3 y lee
    `cuerpo.motivo`— paso a exigir `reason`.

    Consecuencia: el movil manda `{"motivo": ...}` y recibe 422, y quien
    mandara `{"reason": ...}` llegaria a `cuerpo.motivo` y reventaria con un
    500. Retirar del catalogo un producto reportado es un control de
    moderacion, y no funcionaba por ninguna via.

    NO LO VEIA NADIE porque ninguna prueba tocaba esa ruta por HTTP.

    SE COMPRUEBA EL MOLDE, que es donde vive el defecto: los dos nombres tienen
    que resolver a moldes DISTINTOS, cada uno con su campo.
    """
    from app.modules.products import schemas

    #: EL MOLDE DEL ENVIO lleva `reason` y es obligatorio.
    assert "reason" in schemas.MotivoDelEnvio.model_fields
    assert "motivo" not in schemas.MotivoDelEnvio.model_fields

    #: EL MOLDE DE SUSPENDER lleva `motivo` y es opcional, como siempre fue.
    assert "motivo" in schemas.MotivoRequest.model_fields
    assert "reason" not in schemas.MotivoRequest.model_fields
    assert schemas.MotivoRequest is not schemas.MotivoDelEnvio

    #: Y NINGUN NOMBRE DE NIVEL SUPERIOR ESTA DEFINIDO DOS VECES, ni en los
    #: moldes ni en el router. ES LA CAUSA, NO EL SINTOMA.
    #:
    #: Buscando esto aparecio una SEGUNDA colision que la revision no vio:
    #: `_del_proveedor` tambien estaba dos veces —una para el producto y otra,
    #: del Incremento 6, para el pedido—, asi que suspender daba 500 ademas de
    #: 422. Dos defectos del mismo origen: anadir al final de un fichero sin
    #: mirar si el nombre ya existia.
    import ast
    import io as _io
    from pathlib import Path

    from app.modules.products import router as router_de_productos

    for modulo in (schemas, router_de_productos):
        fuente = _io.open(Path(modulo.__file__), encoding="utf-8").read()
        definidos = [
            n.name
            for n in ast.parse(fuente).body
            if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        ]
        repetidos = sorted({d for d in definidos if definidos.count(d) > 1})
        assert repetidos == [], (
            f"nombres definidos dos veces en {Path(modulo.__file__).name}:"
            f" {repetidos}"
        )


@pytest.mark.asyncio
async def test_suspender_un_producto_acepta_el_cuerpo_que_manda_el_movil(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LA RUTA, EJECUTADA, con el cuerpo exacto que manda el repositorio movil.

    `ProductAdmissionRepository.suspender` manda `{"motivo": ...}`. Comprobar
    solo el molde dejaria pasar el dia que alguien cambie la ruta y no el
    molde; esto ejecuta la suspension de verdad y mira el estado del producto.
    """
    from app.modules.products.models import Product

    http, quien = cliente
    producto_id, _, _, _ = await pedido_pagado(sesiones, monkeypatch)
    manda = await persona(sesiones, "suspende")
    await _rol(sesiones, manda, "admin")
    quien["uid"] = manda

    respuesta = await http.post(
        f"{ADMIN}/{producto_id}/suspend",
        json={"motivo": "Retirado del catalogo por un reporte."},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "suspended"

    async with sesiones() as db:
        assert (await db.get(Product, producto_id)).status == "suspended"


@pytest.mark.asyncio
async def test_no_se_anuncia_cancelar_mientras_no_haya_politica(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LO QUE SE ANUNCIA TIENE QUE PODER PULSARSE.

    LO ENCONTRO LA REVISION INDEPENDIENTE. La maquina declara el salto a
    CANCELLED para administracion, pero `envios.cancelar` se para SIEMPRE:
    `product_policies` no dice con que plazo, en que casos, quien paga el porte
    de vuelta ni cuando se repone el stock. Anunciarlo era prometer un boton
    que devuelve 409 sin excepcion, y es la misma mentira —al reves— que
    costaba el boton de confirmar la recepcion.

    SE MIRA LA VISTA DE ADMINISTRACION, que es la unica que tenia el defecto, y
    la unica ruta que la expone es la respuesta de su propia intervencion. Una
    version anterior de esta prueba leia por descuido las transiciones del
    PROVEEDOR, que nunca llevaron CANCELLED: pasaba sin demostrar nada, y la
    mutacion que tenia que ponerla roja la dejaba verde.
    """
    from app.modules.products import envios as servicio_de_envios

    assert servicio_de_envios.HAY_POLITICA_DE_CANCELACION is False, (
        "si esto cambia, esta prueba tiene que cambiar con ello"
    )

    http, quien = cliente
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    proveedor = await _duenno(sesiones, orden_id)
    manda = await persona(sesiones, "nocancela")
    await _rol(sesiones, manda, "admin")

    #: El proveedor cierra el paquete, que es el estado desde el que la maquina
    #: SI le declara a administracion el salto a CANCELLED.
    quien["uid"] = proveedor
    detalle = (await http.get(f"{PRODUCTOS}/seller/orders/{orden_id}")).json()
    await http.post(
        f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/prepare",
        json={
            "items": [
                {"order_item_id": l["id"], "prepared_quantity": l["quantity"]}
                for l in detalle["items"]
            ]
        },
    )
    await http.post(f"{PRODUCTOS}/seller/orders/{orden_id}/shipment/ready")

    #: ADMINISTRACION INTERVIENE DE VERDAD —reabrir es lo que si puede— y en SU
    #: respuesta se mira lo que se le ofrece.
    quien["uid"] = manda
    reabierto = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "PREPARING", "reason": "faltaba una pieza en la caja"},
    )
    assert reabierto.status_code == 200, reabierto.text
    ofrecidos = reabierto.json()["available_transitions"]

    #: LO QUE SI PUEDE SE SIGUE OFRECIENDO: la correccion no apaga la ruta.
    assert "READY" in ofrecidos, ofrecidos
    #: Y LO QUE NO, NO.
    assert "CANCELLED" not in ofrecidos, ofrecidos
    assert "DISPATCHED" not in ofrecidos, "administracion no despacha"
    assert "DELIVERED" not in ofrecidos, "administracion no fabrica una entrega"

    #: Y SI ALGUIEN LO INTENTA IGUAL, el servidor lo dice con su codigo y no se
    #: estrella: la puerta de verdad sigue siendo el servicio.
    intento = await http.post(
        f"{ADMIN}/shipments/{orden_id}/transition",
        json={"to": "CANCELLED", "reason": "quiero cancelarlo"},
    )
    assert intento.status_code == 409, intento.text
    assert (
        intento.json()["error"]["code"]
        == "product_shipment_cancellation_not_configured"
    )
