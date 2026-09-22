"""El Incremento 8 POR HTTP: las rutas, los permisos y los moldes de salida.

POR QUE ADEMAS DE LAS DEL SERVICIO. Las del servicio demuestran las reglas del
dominio; esto comprueba lo que de verdad ve una pantalla: que la ruta existe,
que exige el rol que dice exigir, que contesta el codigo que promete y que el
molde NO lleva lo que no puede llevar.

LO QUE DEFIENDEN:

  1. EL RECORRIDO ENTERO DE LOS TRES ACTORES, por las rutas de verdad.
  2. EL MOLDE PUBLICO NO LLEVA DE QUE COMPRA SALE CADA OPINION. Ni el pedido,
     ni la linea: eso ata a una persona con un importe y una direccion.
  3. LO AJENO ES UN 404, tambien por HTTP.
  4. EL PROVEEDOR PUEDE RESPONDER Y NADA MAS.
  5. EL RESUMEN NO EXIGE SESION y sin resenas viaja NULO, no en cero.
  6. LA RUTA DE MODERACION EXIGE ROL, y el rol se comprueba ANTES que nada.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import create_app
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
from tests.test_productos_incidencias import pedido_entregado  # noqa: F401
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    PasarelaDeMentira,
    bolsa_con,
    crear_pedido,
    motor,
    politica_publicada,
    venta_encendida,
)
from tests.test_productos_resenas import linea_de  # noqa: F401

PRODUCTOS = "/api/v1/products"
ADMIN = "/api/v1/admin/products"

CINCO = {
    "overall": 5,
    "quality": 5,
    "fidelity": 4,
    "functioning": 5,
    "value_for_money": 3,
    "recommends": True,
}


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


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_recorrido_entero_por_las_rutas(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """Comprar, recibir, valorar, responder y moderar. Todo por HTTP."""
    http, quien = cliente
    _, _, comprador, orden_id, proveedor = await pedido_entregado(sesiones, monkeypatch)

    # 1. QUE PUEDO VALORAR DE ESTE PEDIDO.
    quien["uid"] = comprador
    r = await http.get(f"{PRODUCTOS}/orders/{orden_id}/reviewable")
    assert r.status_code == 200, r.text
    lineas = r.json()
    assert len(lineas) == 1
    assert lineas[0]["can_review"] is True
    item_id = lineas[0]["order_item_id"]

    # 2. VALORAR.
    r = await http.post(
        f"{PRODUCTOS}/order-items/{item_id}/review",
        json={**CINCO, "comment": "Llego bien y es como lo describen."},
    )
    assert r.status_code == 201, r.text
    resena = r.json()
    assert resena["compra_verificada"] is True
    assert resena["order_item_id"] == item_id, "la propia si dice de que compra sale"
    resena_id = resena["id"]

    # 3. LA SEGUNDA VEZ, 409.
    r = await http.post(f"{PRODUCTOS}/order-items/{item_id}/review", json=CINCO)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "product_review_already_exists"

    # 4. EDITAR LA PROPIA.
    r = await http.patch(f"{PRODUCTOS}/reviews/{resena_id}", json={"overall": 3})
    assert r.status_code == 200, r.text
    assert r.json()["overall"] == 3

    # 5. EL PROVEEDOR RESPONDE.
    quien["uid"] = proveedor
    r = await http.post(
        f"{PRODUCTOS}/seller/reviews/{resena_id}/reply",
        json={"body": "Gracias por contarlo, lo tenemos en cuenta."},
    )
    assert r.status_code == 201, r.text
    assert r.json()["reply"]["body"].startswith("Gracias")

    # 6. Y LA VE EN SU BANDEJA.
    r = await http.get(f"{PRODUCTOS}/seller/reviews")
    assert r.status_code == 200, r.text
    assert resena_id in [x["id"] for x in r.json()]

    # 7. MODERACION LA ESCONDE.
    admin = await persona(sesiones, "adm-res", rol="admin")
    quien["uid"] = admin
    r = await http.post(
        f"{ADMIN}/reviews/{resena_id}/moderate",
        json={"hidden": True, "reason": "datos personales"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "hidden"

    # 8. Y EL HISTORIAL LO CUENTA.
    r = await http.get(f"{ADMIN}/reviews/{resena_id}/moderation")
    assert r.status_code == 200, r.text
    assert [f["to_status"] for f in r.json()] == ["hidden"]

    # 9. LA ESCONDIDA SALE DE LA LISTA PUBLICA.
    quien["uid"] = comprador
    r = await http.get(f"{PRODUCTOS}/{resena['product_id']}/reviews")
    assert r.status_code == 200, r.text
    assert resena_id not in [x["id"] for x in r.json()]

    # 10. PERO NO DE LA MIA.
    r = await http.get(f"{PRODUCTOS}/reviews/mine")
    assert r.status_code == 200, r.text
    mias = {x["id"]: x for x in r.json()}
    assert resena_id in mias
    assert mias[resena_id]["status"] == "hidden"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_molde_publico_no_dice_de_que_compra_sale(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """`order_id`, `order_item_id` y las dos fechas atan a una persona con un
    pedido concreto: su importe, su direccion y su dia."""
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)

    quien["uid"] = comprador
    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    assert r.status_code == 201, r.text
    producto_id = r.json()["product_id"]

    r = await http.get(f"{PRODUCTOS}/{producto_id}/reviews")
    assert r.status_code == 200, r.text
    publica = r.json()[0]
    assert publica["order_item_id"] is None
    assert publica["status"] is None
    for prohibido in ("order_id", "order_paid_at", "delivered_at", "moderation_reason"):
        assert prohibido not in publica, prohibido


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_compra_ajena_es_un_404(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    http, quien = cliente
    _, _, _, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = await persona(sesiones, "curiosa-http")

    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "product_review_not_found"

    #: Y EL PEDIDO AJENO DEVUELVE LISTA VACIA, no un 403: decir «ese no es
    #: tuyo» confirmaria que existe.
    r = await http.get(f"{PRODUCTOS}/orders/{orden_id}/reviewable")
    assert r.status_code == 200
    assert r.json() == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_otro_proveedor_no_responde_esa_resena(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = comprador
    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    resena_id = r.json()["id"]

    otro = await persona(sesiones, "prov-ajeno-http")
    await vendedor(sesiones, otro)
    quien["uid"] = otro
    r = await http.post(
        f"{PRODUCTOS}/seller/reviews/{resena_id}/reply", json={"body": "Hola."}
    )
    assert r.status_code == 404


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderar_exige_rol(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """Y el rol se comprueba ANTES que nada: sin el, 403 y no un 404."""
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = comprador
    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    resena_id = r.json()["id"]

    r = await http.post(f"{ADMIN}/reviews/{resena_id}/moderate", json={"hidden": True})
    assert r.status_code == 403, r.text

    r = await http.get(f"{ADMIN}/reviews")
    assert r.status_code == 403


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_resumen_sin_resenas_viaja_nulo(sesiones, cliente) -> None:
    """NO EN CERO. Un producto sin opiniones no puntua 0,0: no puntua."""
    from tests.test_productos_catalogo import publicado

    http, quien = cliente
    producto_id, _, _ = await publicado(sesiones)
    quien["uid"] = await persona(sesiones, "mira-ficha")

    r = await http.get(f"{PRODUCTOS}/{producto_id}/reviews/summary")
    assert r.status_code == 200, r.text
    resumen = r.json()
    assert resumen["total"] == 0
    assert resumen["average"] is None
    assert resumen["adjusted"] is None
    assert resumen["recommend_bps"] is None
    assert resumen["distribution"] == {
        "uno": 0,
        "dos": 0,
        "tres": 0,
        "cuatro": 0,
        "cinco": 0,
    }
    #: Y DICE QUE EL PREVIO ES EL POR DEFECTO, para que la pantalla no de a
    #: entender que Z calculo un promedio de categoria que nadie calcula.
    assert resumen["category_average"] == 4.2
    assert resumen["category_configured"] is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_puntuacion_fuera_de_rango_es_un_422(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """LA VALIDA EL CONTRATO, antes de tocar la base."""
    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = comprador
    r = await http.post(
        f"{PRODUCTOS}/order-items/{linea.id}/review", json={**CINCO, "overall": 9}
    )
    assert r.status_code == 422, r.text


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_entrega_la_ruta_dice_por_que(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """409 CON EL MOTIVO DENTRO, para que la pantalla lo pueda traducir."""
    http, quien = cliente
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = comprador
    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    assert r.status_code == 409, r.text
    cuerpo = r.json()["error"]
    assert cuerpo["code"] == "product_review_not_allowed"
    assert cuerpo["details"]["reason"] == "not_delivered"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_auditoria_compartida_no_se_lleva_el_motivo(
    sesiones, cliente, monkeypatch, venta_encendida
) -> None:
    """EL MOTIVO PUEDE LLEVAR DENTRO UNA CITA de lo que escribio quien opino.

    `audit_events` la leen mas personas que esta cola. El motivo vive en
    `product_review_moderation`, que es de quien modera, y ahi se queda.
    """
    from sqlalchemy import select

    from app.modules.gobernanza.models import AuditEvent

    http, quien = cliente
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    quien["uid"] = comprador
    r = await http.post(f"{PRODUCTOS}/order-items/{linea.id}/review", json=CINCO)
    resena_id = r.json()["id"]

    secreto = "vive en la calle Mayor 14, tercero"
    quien["uid"] = await persona(sesiones, "adm-pii", rol="admin")
    r = await http.post(
        f"{ADMIN}/reviews/{resena_id}/moderate",
        json={"hidden": True, "reason": secreto},
    )
    assert r.status_code == 200, r.text

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(AuditEvent).where(AuditEvent.entity_id == resena_id)
            )
        )
    assert filas, "moderar una resena tiene que dejar rastro"
    for fila in filas:
        assert secreto not in str(fila.payload or {})
        assert secreto not in (fila.reason or "")
