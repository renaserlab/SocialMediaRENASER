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
    escalado = await http.post(f"{PRODUCTOS}/incidents/{incident_id}/escalate")
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
        ("post", f"{PRODUCTOS}/incidents/{incident_id}/escalate", None),
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
    await http.post(
        f"{PRODUCTOS}/orders/{orden_id}/incidents",
        json={
            "reason": maquina.DANADO,
            "description": DESCRIPCION,
            "order_item_id": linea,
        },
    )

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
