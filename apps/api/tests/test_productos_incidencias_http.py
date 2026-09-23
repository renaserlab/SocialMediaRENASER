"""El Incremento 7 POR HTTP: las rutas, los permisos y los moldes de salida.

POR QUE ADEMAS DE LAS DEL SERVICIO. Las del servicio demuestran las reglas del
dominio; esto comprueba lo que de verdad ve una pantalla: que la ruta existe,
que exige el rol que dice exigir, que contesta el codigo que promete y que el
molde NO lleva lo que no puede llevar.

Un fallo tipico que solo se ve aqui: una ruta correcta detras de una puerta de
permisos puesta al reves. Ya paso una vez en este proyecto —el Incremento 6
tenia la ruta de intervencion abierta a moderacion y toda la suite estaba en
verde— y por eso estas pruebas existen desde el principio esta vez.

LO QUE DEFIENDEN:

  1. EL RECORRIDO ENTERO DE LOS TRES ACTORES, por las rutas de verdad.
  2. EL PROVEEDOR NO TIENE RUTA PARA RESOLVER SU PROPIO CASO.
  3. MODERACION NO RESUELVE NI MIRA LA COLA DE MEDIACION: 403.
  4. LO AJENO ES UN 404, para quien compra y para quien vende.
  5. LA LISTA NO LLEVA LA DESCRIPCION, que es donde esta el texto libre.
  6. EL MOLDE NO LLEVA NINGUN IMPORTE NI NINGUNA REFERENCIA DE REEMBOLSO.
  7. ABRIR UN CASO BLOQUEA CONFIRMAR LA RECEPCION, tambien por HTTP.
"""

from __future__ import annotations

import io
from datetime import timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import create_app
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products.models import ProductIncident, ProductOrder, ProductSeller
from app.shared.database import get_db
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)
from tests.test_productos_envios import duenno_de, pedido_pagado  # noqa: F401
from tests.test_productos_incidencias import (  # noqa: F401
    DESCRIPCION,
    imagen,
    pedido_entregado,
    primera_linea,
)
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    con_cobro_abierto,
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
    """La aplicacion de verdad, con la sesion de la base local de la prueba."""
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


@pytest_asyncio.fixture(autouse=True)
def sin_salir_al_almacenamiento(monkeypatch):
    """NINGUNA PRUEBA SUBE UN ARCHIVO DE VERDAD.

    El borde del almacenamiento se simula y nada mas: los bytes se siguen
    midiendo con la funcion real, que abre la imagen para comprobar que es lo
    que dice ser.
    """
    from app.shared import storage

    subidos: list[tuple[str, str, int]] = []

    async def _subir(deposito, ruta, datos, tipo):
        subidos.append((deposito, ruta, len(datos)))
        return ruta

    async def _firmar(deposito, rutas, segundos=300):
        return {r: f"https://local.invalido/{deposito}/{r}" for r in rutas}

    monkeypatch.setattr(storage, "subir_objeto", _subir)
    monkeypatch.setattr(storage, "firmar_objetos", _firmar)
    return subidos


async def _rol(sesiones, usuario_id: str, rol: str) -> None:
    from app.modules.profiles.models import Profile

    async with sesiones() as db:
        (await db.get(Profile, usuario_id)).role = rol
        await db.commit()


async def _subir_dos_fotos(http, incident_id: str) -> None:
    for tono in (180, 220):
        respuesta = await http.post(
            f"{PRODUCTOS}/incidents/{incident_id}/evidence",
            files={"archivo": ("prueba.png", io.BytesIO(imagen(tono)), "image/png")},
        )
        assert respuesta.status_code == 201, respuesta.text


# =========================================================================== #
# 1. El recorrido entero
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_recorrido_entero_de_una_incidencia(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """Abrir -> evidencia -> enviar -> responder -> mediacion -> resolver.

    TODO POR HTTP, comprobando en cada paso lo que ve cada quien.
    """
    http, quien = cliente
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = await primera_linea(sesiones, orden_id)
    manda = await persona(sesiones, "mandahttp")
    await _rol(sesiones, manda, "admin")

    # --- Quien compra abre el caso ---------------------------------------- #
    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    assert abierto.status_code == 201, abierto.text
    caso = abierto.json()
    assert caso["status"] == maquina.ABIERTA
    assert caso["resolution"] is None
    assert caso["financial_effect"] is None, "abrir no decide ningun efecto"
    assert caso["seller_response_due_at"] is None, "el plazo no empieza al abrir"
    incident_id = caso["id"]

    # --- Sin las dos fotografias no se envia ------------------------------ #
    pronto = await http.post(f"{PRODUCTOS}/incidents/{incident_id}/submit")
    assert pronto.status_code == 409, pronto.text
    assert pronto.json()["error"]["code"] == "product_incident_evidence_required"

    await _subir_dos_fotos(http, incident_id)
    enviado = await http.post(f"{PRODUCTOS}/incidents/{incident_id}/submit")
    assert enviado.status_code == 200, enviado.text
    assert enviado.json()["seller_response_due_at"] is not None
    assert len(enviado.json()["evidence"]) == 2
    #: LA URL SE FIRMA AL PINTAR y no se guarda.
    assert enviado.json()["evidence"][0]["url"] is not None

    # --- Quien vende lo ve y PROPONE -------------------------------------- #
    quien["uid"] = proveedor
    suyo = await http.get(f"{PRODUCTOS}/seller/incidents/{incident_id}")
    assert suyo.status_code == 200, suyo.text
    assert suyo.json()["description"] == DESCRIPCION
    #: Y LO UNICO QUE PUEDE HACER es responder o pedir mas evidencia.
    assert set(suyo.json()["available_transitions"]) == {
        maquina.RESPONDIDA,
        maquina.MAS_EVIDENCIA,
    }

    respondido = await http.post(
        f"{PRODUCTOS}/seller/incidents/{incident_id}/respond",
        json={
            "proposal": maquina.REPONER,
            "note": "Le mandamos otro igual sin coste",
        },
    )
    assert respondido.status_code == 200, respondido.text
    assert respondido.json()["seller_proposal"] == maquina.REPONER
    assert respondido.json()["resolution"] is None, "proponer no es resolver"

    # --- Quien compra no lo acepta y pide mediacion ----------------------- #
    quien["uid"] = comprador
    #: CON SU EXPLICACION: el motivo por el que se rechaza la propuesta es lo
    #: primero que lee quien media, y desde la revision independiente la ruta
    #: lo exige en vez de descartarlo en silencio.
    escalado = await http.post(
        f"{PRODUCTOS}/incidents/{incident_id}/escalate",
        json={"note": "No acepto la propuesta: el golpe no se arregla asi."},
    )
    assert escalado.status_code == 200, escalado.text
    assert escalado.json()["status"] == maquina.MEDIACION

    # --- Z resuelve -------------------------------------------------------- #
    quien["uid"] = manda
    cola = await http.get(f"{ADMIN}/incidents")
    assert cola.status_code == 200, cola.text
    assert any(c["id"] == incident_id for c in cola.json())
    #: LA COLA NO LLEVA LA DESCRIPCION: el texto libre se lee entrando.
    for fila in cola.json():
        assert "description" not in fila

    resuelto = await http.post(
        f"{ADMIN}/incidents/{incident_id}/resolve",
        json={
            "resolution": maquina.DEVOLVER_Y_REEMBOLSAR_TODO,
            "note": "La evidencia demuestra el dano en transito",
        },
    )
    assert resuelto.status_code == 200, resuelto.text
    final = resuelto.json()
    assert final["status"] == maquina.RESUELTA
    assert final["resolution"] == maquina.DEVOLVER_Y_REEMBOLSAR_TODO
    #: RESOLVER NO ES PAGAR.
    assert final["financial_effect"] == maquina.EFECTO_PENDIENTE
    #: Y EL MOLDE NO LLEVA NINGUN IMPORTE NI REFERENCIA DE REEMBOLSO.
    for prohibido in (
        "refund_amount_minor",
        "refund_reference",
        "refunded_at",
        "amount_minor",
        "transfer_status",
    ):
        assert prohibido not in final, prohibido


# =========================================================================== #
# 2. El proveedor no resuelve su propio caso
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_hay_ruta_para_que_el_proveedor_resuelva(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """NI SIQUIERA UNA QUE FALLE: no existe.

    Se comprueba sobre el inventario de rutas, que es donde se ve de un
    vistazo: ninguna ruta de `/seller/` termina en `resolve`.
    """
    http, _ = cliente
    rutas = [r for r in create_app().openapi()["paths"] if "incident" in r]
    assert rutas, "no se leyeron las rutas de incidencias"
    for ruta in rutas:
        if "/seller/" in ruta:
            assert not ruta.endswith("/resolve"), ruta
    #: Y LA QUE RESUELVE ESTA BAJO ADMINISTRACION.
    assert f"{ADMIN}/incidents/{{incident_id}}/resolve" in rutas


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderacion_no_entra_en_la_mediacion(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """403 EN LAS TRES RUTAS DE ADMINISTRACION.

    Resolver decide sobre dinero y sobre mercancia; y la cola dice quien tiene
    una disputa abierta, asi que tampoco se abre a quien no puede hacer nada
    con ella.
    """
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    incident_id = abierto.json()["id"]

    moderador = await persona(sesiones, "modinchttp")
    await _rol(sesiones, moderador, "moderator")
    quien["uid"] = moderador

    for metodo, ruta, cuerpo in (
        ("get", f"{ADMIN}/incidents", None),
        ("get", f"{ADMIN}/incidents/{incident_id}", None),
        (
            "post",
            f"{ADMIN}/incidents/{incident_id}/resolve",
            {"resolution": maquina.RECHAZAR, "note": "no procede"},
        ),
        ("post", f"{ADMIN}/incidents/escalate-overdue", None),
    ):
        respuesta = await getattr(http, metodo)(
            ruta, **({"json": cuerpo} if cuerpo is not None else {})
        )
        assert respuesta.status_code == 403, f"{ruta} contesto {respuesta.status_code}"
        assert (
            respuesta.json()["error"]["code"] == "product_incident_mediate_forbidden"
        )


# =========================================================================== #
# 3. Lo ajeno es un 404
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_caso_de_otro_es_un_404_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    incident_id = abierto.json()["id"]

    ajeno = await persona(sesiones, "ajenoinchttp")
    quien["uid"] = ajeno
    for metodo, ruta, cuerpo in (
        ("get", f"{PRODUCTOS}/incidents/{incident_id}", None),
        ("post", f"{PRODUCTOS}/incidents/{incident_id}/submit", None),
        (
            "post",
            f"{PRODUCTOS}/incidents/{incident_id}/escalate",
            {"note": "que lo mire Z"},
        ),
        (
            "post",
            f"{PRODUCTOS}/incidents/{incident_id}/withdraw",
            {"note": "lo retiro yo"},
        ),
    ):
        respuesta = await getattr(http, metodo)(
            ruta, **({"json": cuerpo} if cuerpo is not None else {})
        )
        assert respuesta.status_code == 404, f"{ruta} contesto {respuesta.status_code}"

    #: Y SU LISTA ESTA VACIA: no ve ni que existe.
    mias = await http.get(f"{PRODUCTOS}/incidents")
    assert mias.status_code == 200
    assert mias.json() == []

    #: OTRO PROVEEDOR TAMPOCO.
    otro = await persona(sesiones, "otroprovinchttp")
    await vendedor(sesiones, otro)
    quien["uid"] = otro
    assert (
        await http.get(f"{PRODUCTOS}/seller/incidents/{incident_id}")
    ).status_code == 404


# =========================================================================== #
# 4. El bloqueo cruzado, por HTTP
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_un_caso_vivo_no_se_confirma_la_recepcion_por_http(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """QUIEN DICE QUE NO LE LLEGO NO PUEDE CONFIRMAR QUE LO RECIBIO."""
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    quien["uid"] = comprador

    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.ENTREGA_NEGADA,
            "description": "No lo he recibido y en el portal dicen que no llego.",
        },
    )
    assert abierto.status_code == 201, abierto.text

    confirmar = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/shipment/confirm-receipt"
    )
    assert confirmar.status_code == 409, confirmar.text
    assert confirmar.json()["error"]["code"] == "product_shipment_incident_open"


# =========================================================================== #
# 5. Lo que el molde no puede llevar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_lista_no_lleva_el_texto_de_la_disputa(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """LA DESCRIPCION ES LO QUE LE PASO A ALGUIEN EN SU CASA.

    Se lee entrando al caso, que es donde se comprueba quien puede. Una lista
    la pinta cualquier pantalla que la pida.
    """
    http, quien = cliente
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = await primera_linea(sesiones, orden_id)
    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    assert abierto.status_code == 201, abierto.text
    #: Y SE ENVIA, porque desde la correccion de la revision independiente un
    #: borrador que nadie ha mandado NO sale en la lista del proveedor: su
    #: descripcion es texto libre sobre lo que paso en una casa, y hasta que se
    #: envia el caso no es suyo. Sin esto, la lista del proveedor vendria vacia
    #: y la comprobacion de «no filtra la descripcion» seria vacuamente cierta.
    await _subir_dos_fotos(http, abierto.json()["id"])
    enviado = await http.post(f"{PRODUCTOS}/incidents/{abierto.json()['id']}/submit")
    assert enviado.status_code == 200, enviado.text

    for uid, ruta in ((comprador, f"{PRODUCTOS}/incidents"),
                      (proveedor, f"{PRODUCTOS}/seller/incidents")):
        quien["uid"] = uid
        lista = await http.get(ruta)
        assert lista.status_code == 200, lista.text
        assert lista.json(), f"{ruta} no devolvio nada"
        assert DESCRIPCION not in lista.text, f"{ruta} filtra la descripcion"
        for fila in lista.json():
            assert "description" not in fila
            assert "evidence" not in fila
            assert "history" not in fila


@pytest.mark.asyncio
async def test_el_pedido_trae_sus_casos_y_solo_el_resumen(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """EL CASO VIAJA DENTRO DEL PEDIDO, igual que el seguimiento y por lo mismo.

    Quien abrio una reclamacion tiene que verla donde esta el pedido del que
    habla. Si no viajara aqui, la pantalla del pedido tendria que pedir ademas
    la lista entera de casos de esa persona y buscar el suyo dentro.

    Y SOLO EL RESUMEN: la descripcion —texto libre que escribio quien reclama—
    se lee entrando al caso, no en la ficha del pedido.
    """
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    quien["uid"] = comprador

    antes = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    assert antes.status_code == 200, antes.text
    assert antes.json()["incidents"] == [], "un pedido sin reclamar no tiene casos"

    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    assert abierto.status_code == 201, abierto.text
    caso_id = abierto.json()["id"]

    despues = await http.get(f"{PRODUCTOS}/orders/{orden_id}")
    assert despues.status_code == 200, despues.text
    casos = despues.json()["incidents"]
    assert [c["id"] for c in casos] == [caso_id]
    assert casos[0]["status"] == maquina.ABIERTA
    assert DESCRIPCION not in despues.text, "el pedido filtra la descripcion"
    for campo in ("description", "evidence", "history"):
        assert campo not in casos[0]


@pytest.mark.asyncio
async def test_pasado_el_plazo_de_la_politica_la_ruta_contesta_409(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """EL PLAZO DE LA POLITICA TAMBIEN SE APLICA POR HTTP, y con su codigo.

    409 y no 400: no es que la peticion este mal escrita, es que el pedido ya
    no admite reclamacion. La pantalla necesita distinguirlo para decir por que.
    """
    from app.modules.products.models import ProductPolicy, ProductShipment

    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)

    #: SE ENVEJECE LA ENTREGA en vez de viajar al futuro: por HTTP no hay
    #: `momento`, y adelantar el reloj del proceso contaminaria el resto.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        politica = await db.get(ProductPolicy, orden.policy_id)
        horas = int(politica.incident_report_hours)
        envio = await db.get(ProductShipment, orden_id)
        envio.delivered_at = envio.delivered_at - timedelta(hours=horas + 1)
        await db.commit()

    quien["uid"] = comprador
    tarde = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    assert tarde.status_code == 409, tarde.text
    assert tarde.json()["error"]["code"] == "product_incident_report_window_closed"


@pytest.mark.asyncio
async def test_la_cola_de_conciliacion_no_lee_los_casos_de_cada_pedido(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """UNA CONSULTA POR FILA ES UNA CONSULTA POR FILA.

    Meter el resumen de los casos dentro de `PedidoRead` fue lo correcto para
    LA FICHA de un pedido, que es una sola. Pero esa misma funcion la usa la
    cola de conciliacion, que devuelve VARIOS: ahi cada pedido habria traido
    su propia consulta a `product_incidents`. Cuadrar un cobro no necesita
    saber si hay una disputa abierta, igual que no necesita saber donde vive
    nadie —por eso la direccion tampoco viaja—.

    LOS PEDIDOS LLEGAN A LA COLA POR SU CAMINO REAL: un pago que entra despues
    de que la reserva venciera. Escribir el estado a mano dejaria una fila que
    el codigo nunca produce.

    SE CUENTAN LAS CONSULTAS A ESA TABLA, no el tiempo: un umbral de
    milisegundos convierte la prueba en una apuesta sobre la maquina.
    """
    from datetime import datetime, timezone

    from sqlalchemy import event

    from app.modules.products import pagos, pedidos as _pedidos
    from app.modules.products.models import PEDIDO_EN_REVISION, ProductOrder

    http, quien = cliente

    #: DOS PEDIDOS, porque con uno solo un N+1 no se distingue de la consulta
    #: unica que si seria correcta.
    ids: list[str] = []
    for _ in range(2):
        _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
        ids.append(orden_id)

    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await _pedidos.vencer(db, momento=despues)
    for orden_id in ids:
        async with sesiones() as db:
            await pagos.atender_aviso(
                db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
            )
            await db.commit()
    async with sesiones() as db:
        for orden_id in ids:
            orden = await db.get(ProductOrder, orden_id)
            assert orden.status == PEDIDO_EN_REVISION, orden.status

    administra = await persona(sesiones, "colahttp")
    await _rol(sesiones, administra, "admin")
    quien["uid"] = administra

    consultas: list[str] = []
    async with sesiones() as db:
        motor_sincrono = (await db.connection()).sync_engine

    def _apuntar(conn, cursor, sentencia, parametros, contexto, muchas):
        if "product_incidents" in sentencia:
            consultas.append(sentencia)

    event.listen(motor_sincrono, "before_cursor_execute", _apuntar)
    try:
        respuesta = await http.get(f"{ADMIN}/orders/review")
    finally:
        event.remove(motor_sincrono, "before_cursor_execute", _apuntar)

    assert respuesta.status_code == 200, respuesta.text
    devueltos = {f["id"] for f in respuesta.json()}
    assert set(ids) <= devueltos, "la cola tiene que traer los dos pedidos"
    assert consultas == [], (
        f"{len(consultas)} consultas a product_incidents desde la cola"
    )
    #: Y NINGUN CASO EN EL MOLDE: vacio, no ausente.
    for fila in respuesta.json():
        assert fila["incidents"] == []


@pytest.mark.asyncio
async def test_la_explicacion_de_escalar_y_de_aportar_llega_al_expediente(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """EL TEXTO QUE LA PANTALLA EXIGE ESCRIBIR TIENE QUE LLEGAR A ALGUN SITIO.

    LO ENCONTRO LA REVISION INDEPENDIENTE: ni /escalate ni /reply declaraban
    cuerpo, asi que FastAPI descartaba el `note` que el movil si obligaba a
    rellenar —bloquea el boton por debajo de tres caracteres— y el renglon del
    historial quedaba con la nota en nulo. Quien lo escribia creia que lo
    habia mandado.

    Y EL MOTIVO POR EL QUE SE RECHAZA UNA PROPUESTA es lo primero que lee quien
    media: perderlo es perder la mitad del caso.
    """
    http, quien = cliente
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = await primera_linea(sesiones, orden_id)

    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    caso_id = abierto.json()["id"]
    await _subir_dos_fotos(http, caso_id)
    await http.post(f"{PRODUCTOS}/incidents/{caso_id}/submit")

    #: El proveedor pide mas pruebas y quien compra contesta CON SU TEXTO.
    quien["uid"] = proveedor
    pedido = await http.post(
        f"{PRODUCTOS}/seller/incidents/{caso_id}/request-evidence",
        json={"note": "Mandame una foto de la caja por fuera."},
    )
    assert pedido.status_code == 200, pedido.text

    quien["uid"] = comprador
    APORTADA = "Subi la foto de la caja, se ve el golpe en la esquina."
    aportado = await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/reply", json={"note": APORTADA}
    )
    assert aportado.status_code == 200, aportado.text
    assert any(
        p["note"] == APORTADA for p in aportado.json()["history"]
    ), "la explicacion de aportar no llego al expediente"

    #: Y al escalar, igual.
    ESCALADA = "No acepto la reposicion: quiero que lo mire Z."
    escalado = await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/escalate", json={"note": ESCALADA}
    )
    assert escalado.status_code == 200, escalado.text
    assert escalado.json()["status"] == maquina.MEDIACION
    assert any(
        p["note"] == ESCALADA for p in escalado.json()["history"]
    ), "la explicacion de escalar no llego al expediente"

    #: SIN TEXTO NO SE PUEDE. La pantalla lo exige y el servidor tambien.
    quien["uid"] = comprador
    sin_texto = await http.post(f"{PRODUCTOS}/incidents/{caso_id}/escalate", json={})
    assert sin_texto.status_code in (400, 422), sin_texto.status_code


@pytest.mark.asyncio
async def test_con_las_seis_fotografias_gastadas_no_se_ofrece_apelar(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """NO SE ANUNCIA UN BOTON QUE EL SERVIDOR VA A RECHAZAR SIEMPRE.

    LO ENCONTRO LA REVISION INDEPENDIENTE, y son dos reglas del blueprint que
    chocan en el borde: el tope de seis fotografias y la exigencia de evidencia
    POSTERIOR a la resolucion para apelar. Quien aporto todas las que el
    blueprint permite antes de que se resolviera su caso no puede subir una mas
    ni puede apelar sin ella.

    QUE EL TOPE CUENTE EL EXPEDIENTE ENTERO O SOLO LA RECLAMACION INICIAL ES
    UNA DECISION QUE NADIE HA TOMADO, y no se inventa aqui. Lo que si se puede
    arreglar sin inventar nada es la mentira: `available_transitions` promete
    que lo que sale ahi se puede pulsar.
    """
    from app.modules.products.models import MAXIMO_DE_FOTOS_DE_INCIDENCIA

    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    manda = await persona(sesiones, "seisfotos")
    await _rol(sesiones, manda, "admin")

    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    caso_id = abierto.json()["id"]

    #: LAS SEIS QUE EL BLUEPRINT PERMITE, todas antes de que se resuelva.
    for tono in range(100, 100 + MAXIMO_DE_FOTOS_DE_INCIDENCIA * 10, 10):
        subida = await http.post(
            f"{PRODUCTOS}/incidents/{caso_id}/evidence",
            files={"archivo": ("p.png", io.BytesIO(imagen(tono)), "image/png")},
        )
        assert subida.status_code == 201, subida.text

    await http.post(f"{PRODUCTOS}/incidents/{caso_id}/submit")
    await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/escalate", json={"note": "que lo mire Z"}
    )
    quien["uid"] = manda
    resuelto = await http.post(
        f"{ADMIN}/incidents/{caso_id}/resolve",
        json={"resolution": maquina.RECHAZAR, "note": "no procede con lo aportado"},
    )
    assert resuelto.status_code == 200, resuelto.text

    quien["uid"] = comprador
    caso = await http.get(f"{PRODUCTOS}/incidents/{caso_id}")
    assert caso.status_code == 200, caso.text
    assert len(caso.json()["evidence"]) == MAXIMO_DE_FOTOS_DE_INCIDENCIA
    #: NO SE OFRECE, porque no puede salir bien.
    assert maquina.APELADA not in caso.json()["available_transitions"]

    #: Y SI SE INTENTA A PESAR DE TODO, el servidor lo dice con su codigo, que
    #: es lo que la pantalla puede explicar. No se estrella.
    intento = await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/appeal", json={"note": "quiero apelar"}
    )
    assert intento.status_code == 409, intento.text
    assert intento.json()["error"]["code"] == "product_incident_appeal_without_evidence"


@pytest.mark.asyncio
async def test_con_sitio_para_otra_fotografia_si_se_ofrece_apelar(
    cliente, sesiones, venta_encendida, monkeypatch
) -> None:
    """Y LA OTRA MITAD: con sitio para una mas, el boton SI sale.

    Sin esta prueba, la correccion anterior podria haber apagado la apelacion
    para todo el mundo y la suite seguiria verde.
    """
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    manda = await persona(sesiones, "dosfotos")
    await _rol(sesiones, manda, "admin")

    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    caso_id = abierto.json()["id"]
    await _subir_dos_fotos(http, caso_id)
    await http.post(f"{PRODUCTOS}/incidents/{caso_id}/submit")
    await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/escalate", json={"note": "que lo mire Z"}
    )
    quien["uid"] = manda
    await http.post(
        f"{ADMIN}/incidents/{caso_id}/resolve",
        json={"resolution": maquina.RECHAZAR, "note": "no procede con lo aportado"},
    )

    quien["uid"] = comprador
    caso = await http.get(f"{PRODUCTOS}/incidents/{caso_id}")
    assert maquina.APELADA in caso.json()["available_transitions"], (
        "con sitio para otra prueba, apelar tiene que seguir ofreciendose"
    )


# =========================================================================== #
# La reposicion entregada, POR HTTP
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dar_por_entregada_una_reposicion_es_de_finanzas_y_no_de_moderacion(
    sesiones, cliente, venta_encendida, monkeypatch
) -> None:
    """La ruta EXISTE, la alcanza finanzas, y moderacion no.

    POR QUE POR HTTP. Un servicio correcto al que no llega ninguna ruta es el
    defecto que este modulo ya ha pagado tres veces: codigo escrito, comentado y
    probado que no se ejecutaba nunca. Y porque el reparto de permisos solo se
    puede comprobar aqui: `puede_mover_dinero` es un conjunto MAS ESTRECHO que
    `is_admin`, y desbloquear un cobro es mover dinero.
    """
    http, quien = cliente
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = await primera_linea(sesiones, orden_id)
    manda = await persona(sesiones, "reposicion-admin")
    await _rol(sesiones, manda, "admin")
    modera = await persona(sesiones, "reposicion-modera")
    await _rol(sesiones, modera, "moderator")

    quien["uid"] = comprador
    abierto = await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )
    assert abierto.status_code == 201, abierto.text
    caso_id = abierto.json()["id"]
    await _subir_dos_fotos(http, caso_id)
    assert (await http.post(f"{PRODUCTOS}/incidents/{caso_id}/submit")).status_code == 200

    #: A MEDIACION LO LLEVA QUIEN COMPRA. No hay salto de abierta a resuelta:
    #: resolver es de Z y se llega desde respondida, mediacion o apelada.
    quien["uid"] = comprador
    mediacion = await http.post(
        f"{PRODUCTOS}/incidents/{caso_id}/escalate",
        json={"note": "No hay respuesta y pido que lo mire Z."},
    )
    assert mediacion.status_code == 200, mediacion.text

    quien["uid"] = manda
    resuelto = await http.post(
        f"{ADMIN}/incidents/{caso_id}/resolve",
        json={
            "resolution": maquina.REPONER,
            "note": "Se repone la unidad danada.",
        },
    )
    assert resuelto.status_code == 200, resuelto.text
    assert resuelto.json()["financial_effect"] == maquina.EFECTO_PENDIENTE

    #: MODERACION NO. Puede resolver el caso y no puede saldar su efecto.
    quien["uid"] = modera
    negado = await http.post(
        f"{ADMIN}/incidents/{caso_id}/replacement-delivered",
        json={"reason": "Moderacion no mueve dinero."},
    )
    assert negado.status_code == 403, negado.text
    assert negado.json()["error"]["code"] == "product_finance_forbidden"

    #: Y SIN MOTIVO TAMPOCO, ni siquiera finanzas.
    quien["uid"] = manda
    sin_motivo = await http.post(
        f"{ADMIN}/incidents/{caso_id}/replacement-delivered",
        json={"reason": "  "},
    )
    assert sin_motivo.status_code == 422, sin_motivo.text

    hecho = await http.post(
        f"{ADMIN}/incidents/{caso_id}/replacement-delivered",
        json={"reason": "La unidad de repuesto llego y quien compro lo confirmo."},
    )
    assert hecho.status_code == 200, hecho.text
    assert hecho.json()["financial_effect"] == maquina.EFECTO_EJECUTADO

    #: IDEMPOTENTE: repetirla no escribe un segundo renglon en el historial.
    pasos = len(hecho.json()["history"])
    otra = await http.post(
        f"{ADMIN}/incidents/{caso_id}/replacement-delivered",
        json={"reason": "Otra vez, por si acaso."},
    )
    assert otra.status_code == 200, otra.text
    assert len(otra.json()["history"]) == pasos
