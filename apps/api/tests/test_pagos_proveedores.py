"""Las reglas que sostienen el dinero en los DOS proveedores.

Complementa a `test_pagos.py` (flujo antiguo sobre `purchases`) y a
`test_comercio.py` (el dominio comercial por dentro). Aquí se prueba la
frontera: lo que llega de RevenueCat y de Stripe, y qué se hace con ello.

**Ninguna prueba sale a la red.** De RevenueCat se simula el transporte HTTP
con `httpx.MockTransport`, que es exactamente la frontera del proveedor: el
cliente de verdad monta las URLs, pagina, traduce los campos y decide, y todo
eso SÍ se ejerce. De Stripe se firman cuerpos con el mismo HMAC que usa Stripe,
así que la verificación se prueba de verdad y no contra un doble que dice «sí».

Lo que se fija, y por qué cada cosa:

1. Un importe manipulado no concede.
2. Una firma inválida se rechaza, y una válida pero vieja también.
3. Un aviso repetido deja UN derecho y UNA compra.
4. Un reembolso confirmado revoca, **sin webhook**.
5. Un producto que no es nuestro no concede.
6. Las compras de otra persona no conceden.
7. Stripe no aparece en la compra nativa, ni RevenueCat se exige en la web.
8. Que falten variables de entorno no revienta nada.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.catalog.models import Course
from app.modules.commerce import esquema, service as comercio
from app.modules.commerce.models import Entitlement, PaymentTransaction, ProviderProduct
from app.modules.gobernanza import models as _modelos_de_gobernanza  # noqa: F401
from app.modules.payments import nativo, service
from app.modules.refunds import models as _modelos_de_devoluciones  # noqa: F401
from app.modules.payments.providers import PROVIDERS
from app.modules.payments.revenuecat import RevenueCatClient, RevenueCatError
from app.modules.payments.stripe_provider import (
    StripeSignatureError,
    traducir_evento,
    verificar_firma,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 29700

PROYECTO = "proj1ab2c3d4"
#: Identificador EN LA TIENDA. Es lo que se da de alta en `provider_products`.
EN_LA_TIENDA = "z.curso.respiracion.lifetime"
#: Identificador INTERNO de RevenueCat. NO es lo mismo, y confundirlos casaría
#: siempre a cero: nadie recibiría nunca su curso.
EN_REVENUECAT = "prod1a2b3c4d5e"


@pytest_asyncio.fixture
async def sesiones():
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    fabrica = async_sessionmaker(engine, expire_on_commit=False)
    async with fabrica() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(
            Course(
                id=CURSO,
                author_id=BRUNO,
                title="Respiración",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        await db.commit()

    esquema.olvidar()
    yield fabrica
    esquema.olvidar()
    await engine.dispose()


async def _dar_de_alta(db, *, provider="google", environment="sandbox") -> str:
    """Deja el curso a la venta en una tienda y devuelve el producto comercial."""
    producto = await comercio.asegurar_producto_de_curso(db, course_id=CURSO)
    db.add(
        ProviderProduct(
            commerce_product_id=producto.id,
            provider=provider,
            environment=environment,
            external_product_id=EN_LA_TIENDA,
        )
    )
    await db.commit()
    return producto.id


def _compra(**cambios) -> dict:
    """Una compra tal y como la devuelve la API v2 de RevenueCat."""
    base = {
        "object": "purchase",
        "id": "purch1a2b3c4d5e",
        "customer_id": ANA,
        "original_customer_id": ANA,
        "product_id": EN_REVENUECAT,
        "purchased_at": 1658399423658,
        "quantity": 1,
        "status": "owned",
        "environment": "sandbox",
        "store": "play_store",
        "store_purchase_identifier": "GPA.1234-5678-9012-34567",
        "ownership": "purchased",
    }
    base.update(cambios)
    return base


def _revenuecat(compras: list[dict], *, store_identifier: str = EN_LA_TIENDA):
    """Un doble del transporte HTTP de RevenueCat. Solo la frontera."""
    llamadas: list[str] = []

    def responder(peticion: httpx.Request) -> httpx.Response:
        llamadas.append(peticion.url.path)
        if peticion.url.path.endswith("/purchases"):
            return httpx.Response(
                200, json={"object": "list", "items": compras, "next_page": None}
            )
        if "/products/" in peticion.url.path:
            return httpx.Response(
                200, json={"object": "product", "store_identifier": store_identifier}
            )
        return httpx.Response(404, json={})

    cliente = httpx.AsyncClient(transport=httpx.MockTransport(responder))
    return cliente, llamadas


def _cliente(compras: list[dict], **kwargs) -> tuple[RevenueCatClient, list[str]]:
    http, llamadas = _revenuecat(compras, **kwargs)
    return (
        RevenueCatClient(
            secret_api_key="sk_de_pruebas",
            project_id=PROYECTO,
            cliente_http=http,
        ),
        llamadas,
    )


# --------------------------------------------------------------------------- #
# El identificador de producto
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_se_casa_el_identificador_de_tienda_y_no_el_interno():
    """`purchase.product_id` NO es lo que hay en `provider_products`.

    Es el id interno de RevenueCat (`prod1a2b3c4d5e`). El que se da de alta en
    la tienda —y el que guardamos— es `store_identifier`, que hay que ir a
    buscar al catálogo de RevenueCat. Confundirlos es el error silencioso más
    fácil de cometer: casaría siempre a cero, sin fallar, y nadie recibiría
    nunca su curso.
    """
    cliente, llamadas = _cliente([_compra()])
    compras = await cliente.compras(ANA)

    assert len(compras) == 1
    assert compras[0].store_product_id == EN_LA_TIENDA
    assert compras[0].store_product_id != EN_REVENUECAT
    # Y se fue a buscarlo de verdad al catálogo.
    assert any("/products/" in ruta for ruta in llamadas)


@pytest.mark.asyncio
async def test_el_catalogo_no_se_pregunta_dos_veces_por_lo_mismo():
    """El dominio de configuración de RevenueCat solo admite 60 por minuto."""
    cliente, llamadas = _cliente(
        [_compra(store_purchase_identifier="A"), _compra(store_purchase_identifier="B")]
    )
    await cliente.compras(ANA)
    assert sum(1 for r in llamadas if "/products/" in r) == 1


# --------------------------------------------------------------------------- #
# Conceder, y lo que NO concede
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_una_compra_real_concede_derecho_y_matricula(sesiones):
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )

        assert resultado.concedidos == [CURSO]
        acceso = await comercio.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO
        )
        assert acceso.tiene_acceso is True
        assert CURSO in await comercio.cursos_con_acceso(db, user_id=ANA)


@pytest.mark.asyncio
async def test_una_recompra_sin_aceptacion_CONCEDE_y_deja_constancia(sesiones):
    """EL DINERO YA SE MOVIO CUANDO ESTO CORRE, y esa es la decision entera.

    La aceptacion de recompra —«se que esta compra no tiene garantia»— solo se
    exigia en el checkout web. En iOS y Android el acceso lo concede
    `native/sync`, y ahi no se comprobaba nada: la casilla de la aplicacion era
    la unica puerta, y una puerta que vive en el telefono no es una puerta.

    PERO RECHAZAR AQUI SERIA PEOR. Google y Apple cobran antes de que nosotros
    nos enteremos, asi que negar el acceso en la sincronizacion es cobrar y no
    entregar. Se concede, y se deja una nota de auditoria: es lo unico que
    convierte «la casilla se salto» en algo que alguien puede ver.
    """
    from app.modules.gobernanza.models import AuditEvent
    from app.modules.refunds import service as devoluciones
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        # Ana ya uso su garantia en este curso.
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        ventana = await db.scalar(_select(devoluciones.CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await db.flush()

        cliente, _ = _cliente([_compra()])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )

        assert resultado.concedidos == [CURSO], "una compra pagada SIEMPRE concede"
        notas = list(await db.scalars(_select(AuditEvent)))
        assert len(notas) == 1, "sin aceptacion tiene que quedar constancia"
        assert notas[0].action == "repurchase.sin_aceptacion"
        assert notas[0].entity_id == CURSO
        assert notas[0].outcome == "ok", "el acceso SI se concedio: lo que falto es la aceptacion"


@pytest.mark.asyncio
async def test_una_recompra_con_aceptacion_no_deja_nota_de_incidencia(sesiones):
    """El camino normal: se acepto antes de comprar, y no hay nada que reportar."""
    from app.modules.gobernanza.models import AuditEvent
    from app.modules.refunds import service as devoluciones
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        ventana = await db.scalar(_select(devoluciones.CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await devoluciones.registrar_aceptacion(
            db, user_id=ANA, course_id=CURSO, order_id=None, fecha_legible="1 de enero"
        )
        await db.flush()

        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")

        incidencias = [
            n
            for n in await db.scalars(_select(AuditEvent))
            if n.action == "repurchase.sin_aceptacion"
        ]
        assert incidencias == [], "con aceptacion no hay incidencia que anotar"


@pytest.mark.asyncio
async def test_la_aceptacion_queda_atada_a_la_orden_y_a_la_operacion(sesiones):
    """LA MIGRACION 0054 SIRVE PARA ESTO Y PARA NADA MAS.

    En el checkout web basta con `order_id`: la orden identifica la compra. En
    las tiendas la orden no existe hasta despues del cobro, asi que sin la
    referencia de la operacion dos recompras del mismo curso serian
    indistinguibles y «que acepto exactamente quien hizo ESTA compra» no tendria
    respuesta.

    Y EL PROVEEDOR NO ES EL CANAL. El canal que trae RevenueCat es 'android' /
    'ios'; el CHECK de la base admite 'google' / 'apple' / 'stripe'. Guardar el
    canal reventaria al insertar.
    """
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import RefundPolicyAcceptance
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        ventana = await db.scalar(_select(devoluciones.CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await devoluciones.registrar_aceptacion(
            db,
            user_id=ANA,
            course_id=CURSO,
            order_id=None,
            fecha_legible="1 de enero",
            provider="google",
            external_product_id="z.curso.respiracion.lifetime",
        )
        await db.flush()

        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")

        aceptaciones = list(await db.scalars(_select(RefundPolicyAcceptance)))
        assert len(aceptaciones) == 1, "la sincronizacion no duplica la aceptacion"
        firmada = aceptaciones[0]
        assert firmada.order_id is not None, "tiene que quedar atada a la orden"
        assert firmada.operation_ref, "y a la operacion de tienda"
        assert firmada.provider == "google", "el proveedor, no el canal"
        assert firmada.external_product_id == "z.curso.respiracion.lifetime"


@pytest.mark.asyncio
async def test_una_aceptacion_anterior_a_la_0054_sigue_funcionando(sesiones):
    """LAS FILAS VIEJAS NO SE RELLENAN HACIA ATRAS, y tienen que valer igual.

    Una aceptacion firmada antes de la 0054 no tiene proveedor ni producto. Eso
    NO la invalida: se acepto, y esta fechada y con la huella del texto.
    Inventarle un valor plausible seria escribir en un registro de
    consentimientos algo que nadie firmo.
    """
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import RefundPolicyAcceptance
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        ventana = await db.scalar(_select(devoluciones.CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        # Sin proveedor ni producto: exactamente como las de antes.
        await devoluciones.registrar_aceptacion(
            db, user_id=ANA, course_id=CURSO, order_id=None, fecha_legible="1 de enero"
        )
        await db.flush()

        assert await devoluciones.tiene_aceptacion(db, user_id=ANA, course_id=CURSO)

        cliente, _ = _cliente([_compra()])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )
        assert resultado.concedidos == [CURSO]
        firmada = await db.scalar(_select(RefundPolicyAcceptance))
        assert firmada.provider is None, "no se le inventa un proveedor"
        assert firmada.order_id is not None, "pero si se ata a la orden"


@pytest.mark.asyncio
async def test_sincronizar_dos_veces_no_duplica_ni_reescribe_la_aceptacion(sesiones):
    """IDEMPOTENCIA: el movil llama a esto al comprar, al restaurar y al entrar."""
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import RefundPolicyAcceptance
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        ventana = await db.scalar(_select(devoluciones.CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await devoluciones.registrar_aceptacion(
            db,
            user_id=ANA,
            course_id=CURSO,
            order_id=None,
            fecha_legible="1 de enero",
            provider="google",
            external_product_id="z.curso.respiracion.lifetime",
        )
        await db.flush()

        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")
        primera = await db.scalar(_select(RefundPolicyAcceptance))
        atada_a, operacion = primera.order_id, primera.operation_ref

        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")
        todas = list(await db.scalars(_select(RefundPolicyAcceptance)))
        assert len(todas) == 1, "la segunda pasada no crea otra aceptacion"
        assert todas[0].order_id == atada_a, "ni la reata a otra orden"
        assert todas[0].operation_ref == operacion


@pytest.mark.asyncio
async def test_sin_garantia_usada_no_se_exige_ni_se_anota_nada(sesiones):
    """La primera compra no tiene nada que aceptar, y no puede ensuciar nada."""
    from app.modules.gobernanza.models import AuditEvent
    from sqlalchemy import select as _select

    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )
        assert resultado.concedidos == [CURSO]
        assert list(await db.scalars(_select(AuditEvent))) == []


@pytest.mark.asyncio
async def test_un_producto_desconocido_no_concede(sesiones):
    """Una compra de algo que no vendemos no abre nada.

    Puede ser de otra aplicación del mismo proyecto de RevenueCat, o un
    producto dado de alta en la tienda y olvidado en `provider_products`.
    """
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()], store_identifier="otra.cosa.que.no.vendemos")
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )

        assert resultado.concedidos == []
        assert resultado.desconocidos == ["otra.cosa.que.no.vendemos"]
        acceso = await comercio.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO
        )
        assert acceso.tiene_acceso is False


@pytest.mark.asyncio
async def test_la_compra_de_otra_persona_no_concede(sesiones):
    """El acceso va contra el `appUserID` de quien firma el JWT.

    RevenueCat se consulta con el UUID de Supabase de quien pide, así que las
    compras de Ana no pueden llegar a la sesión de Bruno. Se comprueba el
    efecto —Bruno no entra— y no solo la intención.
    """
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")

        acceso = await comercio.resolver_acceso_al_curso(
            db, user_id=BRUNO, course_id=CURSO
        )
        # Bruno es el AUTOR del curso, así que entra por esa vía. Lo que no
        # puede es entrar por la compra de Ana.
        assert acceso.motivo != comercio.ENTITLEMENT
        derechos = (
            await db.execute(select(Entitlement).where(Entitlement.user_id == BRUNO))
        ).scalars().all()
        assert derechos == []


@pytest.mark.asyncio
async def test_una_compra_de_pruebas_no_concede_en_produccion(sesiones):
    """Una compra en sandbox no abre un curso en la base de verdad."""
    async with sesiones() as db:
        await _dar_de_alta(db, environment="production")
        cliente, _ = _cliente([_compra(environment="sandbox")])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="production"
        )
        assert resultado.concedidos == []


@pytest.mark.asyncio
async def test_restaurar_dos_veces_no_duplica_nada(sesiones):
    """Restaurar compras es idempotente: es lo que hace al reinstalar."""
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        primera = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )
        segunda = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )

        assert primera.concedidos == [CURSO]
        # La segunda no concede nada nuevo, y eso NO es un error.
        assert segunda.concedidos == []
        assert segunda.sin_cambios == [CURSO]

        derechos = (
            await db.execute(
                select(Entitlement).where(
                    Entitlement.user_id == ANA, Entitlement.status == "active"
                )
            )
        ).scalars().all()
        assert len(derechos) == 1
        compras = (
            await db.execute(
                select(PaymentTransaction).where(PaymentTransaction.kind == "purchase")
            )
        ).scalars().all()
        assert len(compras) == 1


# --------------------------------------------------------------------------- #
# Reembolsos SIN webhook
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_reembolso_revoca_sin_webhook(sesiones):
    """RevenueCat conserva la compra devuelta con `status: refunded`.

    Es decir: el reembolso es un dato que se puede CONSULTAR, no solo un aviso
    que hay que esperar. Por eso revocar funciona aunque nunca lleguemos a
    configurar webhooks, que es justo el requisito.
    """
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")
        assert (
            await comercio.resolver_acceso_al_curso(db, user_id=ANA, course_id=CURSO)
        ).tiene_acceso is True

        devuelto, _ = _cliente([_compra(status="refunded")])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=devuelto, entorno="sandbox"
        )

        assert resultado.revocados == [CURSO]
        assert (
            await comercio.resolver_acceso_al_curso(db, user_id=ANA, course_id=CURSO)
        ).tiene_acceso is False


@pytest.mark.asyncio
async def test_un_fallo_de_revenuecat_no_revoca_nada(sesiones):
    """Un mal minuto del proveedor no puede costarle el curso a quien pagó.

    Si un error se tratara como «esta persona no tiene compras», una caída de
    RevenueCat vaciaría los accesos de todo el mundo.
    """
    async with sesiones() as db:
        await _dar_de_alta(db)
        cliente, _ = _cliente([_compra()])
        await nativo.sincronizar(db, user_id=ANA, cliente=cliente, entorno="sandbox")

        def caido(peticion: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={})

        roto = RevenueCatClient(
            secret_api_key="sk_de_pruebas",
            project_id=PROYECTO,
            cliente_http=httpx.AsyncClient(transport=httpx.MockTransport(caido)),
        )
        with pytest.raises(RevenueCatError):
            await nativo.sincronizar(db, user_id=ANA, cliente=roto, entorno="sandbox")

        assert (
            await comercio.resolver_acceso_al_curso(db, user_id=ANA, course_id=CURSO)
        ).tiene_acceso is True


# --------------------------------------------------------------------------- #
# Stripe: firma
# --------------------------------------------------------------------------- #

SECRETO = "whsec_de_pruebas"


def _firmar(cuerpo: bytes, *, secreto: str = SECRETO, momento: int | None = None) -> str:
    marca = int(time.time()) if momento is None else momento
    firma = hmac.new(
        secreto.encode(), f"{marca}.".encode() + cuerpo, hashlib.sha256
    ).hexdigest()
    return f"t={marca},v1={firma}"


def test_una_firma_valida_se_acepta():
    cuerpo = json.dumps({"id": "evt_1"}).encode()
    verificar_firma(body=cuerpo, signature=_firmar(cuerpo), secret=SECRETO)


def test_una_firma_invalida_se_rechaza():
    """Sin esto, quien descubra la URL del webhook se regala el catálogo."""
    cuerpo = json.dumps({"id": "evt_1"}).encode()
    with pytest.raises(StripeSignatureError):
        verificar_firma(
            body=cuerpo, signature=_firmar(cuerpo, secreto="otro"), secret=SECRETO
        )


def test_un_cuerpo_manipulado_invalida_la_firma():
    """La firma cubre el CUERPO. Cambiar un importe la rompe."""
    cuerpo = json.dumps({"id": "evt_1", "amount": 100}).encode()
    firma = _firmar(cuerpo)
    manipulado = json.dumps({"id": "evt_1", "amount": 1}).encode()
    with pytest.raises(StripeSignatureError):
        verificar_firma(body=manipulado, signature=firma, secret=SECRETO)


def test_un_aviso_viejo_se_rechaza():
    """Reenviar un aviso legítimo capturado hace horas no vale.

    La idempotencia lo pararía la segunda vez, pero la primera no tiene por qué
    haber ocurrido todavía.
    """
    cuerpo = json.dumps({"id": "evt_1"}).encode()
    viejo = _firmar(cuerpo, momento=int(time.time()) - 3600)
    with pytest.raises(StripeSignatureError):
        verificar_firma(body=cuerpo, signature=viejo, secret=SECRETO)


def test_sin_secreto_no_se_verifica_nada():
    """Falla CERRADO. Sin secreto no se puede comprobar, así que no se acepta."""
    cuerpo = json.dumps({"id": "evt_1"}).encode()
    with pytest.raises(Exception):
        verificar_firma(body=cuerpo, signature=_firmar(cuerpo), secret="")


def test_una_cabecera_ausente_se_rechaza():
    with pytest.raises(StripeSignatureError):
        verificar_firma(body=b"{}", signature="", secret=SECRETO)


# --------------------------------------------------------------------------- #
# Stripe: qué concede cada evento
# --------------------------------------------------------------------------- #


def _evento(tipo: str, objeto: dict, *, id_evento: str = "evt_1") -> dict:
    return {
        "id": id_evento,
        "type": tipo,
        "livemode": False,
        "data": {"object": objeto},
    }


def test_una_sesion_completada_sin_pagar_no_concede():
    """`checkout.session.completed` NO significa cobrado.

    Con métodos de pago diferidos llega con `payment_status` en `unpaid` y el
    dinero puede no llegar nunca. Conceder aquí regalaría el curso a quien
    elige transferencia y no la hace.
    """
    evento = traducir_evento(
        _evento(
            "checkout.session.completed",
            {"payment_status": "unpaid", "payment_intent": "pi_1", "amount_total": 100},
        )
    )
    assert evento.status != "paid"


def test_una_sesion_pagada_concede():
    evento = traducir_evento(
        _evento(
            "checkout.session.completed",
            {"payment_status": "paid", "payment_intent": "pi_1", "amount_total": 100},
        )
    )
    assert evento.status == "paid"


@pytest.mark.parametrize(
    "tipo",
    ["checkout.session.async_payment_failed", "checkout.session.expired"],
)
def test_los_eventos_que_no_conceden(tipo):
    evento = traducir_evento(_evento(tipo, {"payment_intent": "pi_1"}))
    assert evento.status != "paid"


@pytest.mark.parametrize("tipo", ["charge.refunded", "refund.created", "refund.updated"])
def test_los_eventos_de_devolucion_se_reconocen(tipo):
    """Los tres, porque cuál llega depende del método de pago.

    ESTA PRUEBA CAMBIÓ, y decía lo contrario. Afirmaba que los tres eventos se
    traducen a `refunded` a secas, que es justo el fallo: `refund.created`
    significa «se ha creado una solicitud de reembolso», no «el dinero ha
    vuelto». Un aviso sin `status` y sin importe no puede declarar devuelta una
    compra —podría estar en trámite, haber fallado o ser parcial—, así que sale
    como «en trámite» y no retira nada.

    Lo que sí se sigue exigiendo, y es lo que esta prueba protege: que los tres
    se RECONOZCAN. Si dejaran de estar en `EVENTOS`, un reembolso real se
    ignoraría en silencio.
    """
    evento = traducir_evento(_evento(tipo, {"payment_intent": "pi_1"}))
    assert evento.status != "ignorado"
    assert evento.status.startswith("refund")
    # Sin confirmacion explicita NO se retira acceso.
    assert evento.status != "refunded"


def test_un_reembolso_confirmado_y_total_si_declara_devolucion():
    """La otra mitad: cuando de verdad volvio el dinero, se dice."""
    evento = traducir_evento(
        _evento(
            "refund.updated",
            {
                "payment_intent": "pi_1",
                "status": "succeeded",
                "amount": 19900,
                "charge": {"id": "ch_1", "amount": 19900},
            },
        )
    )
    assert evento.status == "refunded"


def test_un_evento_que_no_nos_incumbe_se_ignora_sin_fallar():
    """Stripe manda muchos avisos. La mayoría no son nuestros."""
    evento = traducir_evento(_evento("customer.created", {"id": "cus_1"}))
    assert evento.status not in {"paid", "refunded"}


def test_un_aviso_de_produccion_no_es_de_pruebas():
    """`livemode` decide el entorno, y un entorno que no cuadra no concede."""
    real = traducir_evento(
        {"id": "evt_1", "type": "checkout.session.completed", "livemode": True, "data": {"object": {}}}
    )
    pruebas = traducir_evento(_evento("checkout.session.completed", {}))
    assert real.environment == "production"
    assert pruebas.environment == "sandbox"


def test_el_pedido_sale_de_nuestra_metadata_y_no_de_stripe():
    """El id de pedido lo pusimos NOSOTROS al crear el cobro."""
    evento = traducir_evento(
        _evento(
            "checkout.session.completed",
            {
                "payment_status": "paid",
                "payment_intent": "pi_1",
                "metadata": {"order_id": "pedido-nuestro"},
                "client_reference_id": "otra-cosa",
            },
        )
    )
    assert evento.purchase_id == "pedido-nuestro"


def test_la_devolucion_se_ata_al_payment_intent():
    """Un evento de devolución NO trae la sesión de checkout.

    Trae el `payment_intent`, y por eso es eso lo que se guarda como
    `external_transaction_id` al conceder: es lo único que permite encontrar el
    pedido cuando el dinero vuelve.
    """
    evento = traducir_evento(_evento("refund.created", {"payment_intent": "pi_42"}))
    assert evento.provider_transaction_id == "pi_42"


# --------------------------------------------------------------------------- #
# Idempotencia del aviso y del dinero
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_aviso_repetido_deja_un_derecho_y_una_compra(sesiones):
    """Si Stripe lo manda diez veces, un entitlement y una compra.

    Se inserta DE VERDAD dos veces contra una base de verdad, porque lo que
    protege esto es un índice único y no un `if`: comprobar que existe el `if`
    no probaría nada sobre dos avisos simultáneos.
    """
    async with sesiones() as db:
        producto_id = await _dar_de_alta(db, provider="stripe")
        producto = service.ProductoComercial(
            commerce_product_id=producto_id,
            course_id=CURSO,
            provider="stripe",
            environment="sandbox",
            external_product_id=EN_LA_TIENDA,
        )
        for _ in range(3):
            _fila, es_nuevo = await comercio.registrar_evento(
                db,
                provider="stripe",
                external_event_id="evt_repetido",
                event_type="checkout.session.completed",
                environment="sandbox",
                payload={},
            )
            if es_nuevo:
                await service.conceder(
                    db,
                    user_id=ANA,
                    producto=producto,
                    external_transaction_id="pi_1",
                    canal="web",
                )
            await db.commit()

        derechos = (
            await db.execute(
                select(Entitlement).where(
                    Entitlement.user_id == ANA, Entitlement.status == "active"
                )
            )
        ).scalars().all()
        compras = (
            await db.execute(
                select(PaymentTransaction).where(PaymentTransaction.kind == "purchase")
            )
        ).scalars().all()
        assert len(derechos) == 1
        assert len(compras) == 1


@pytest.mark.asyncio
async def test_el_importe_lo_pone_el_servidor(sesiones):
    """`crear_orden` NI SIQUIERA acepta un parámetro de importe.

    No es una comprobación de estilo: sin el parámetro no hay forma de que un
    importe del cliente llegue hasta la orden, ni por descuido ni por un
    argumento que alguien añada mañana.
    """
    import inspect

    firma = inspect.signature(comercio.crear_orden)
    assert "amount_minor" not in firma.parameters
    assert "amount_minor" not in inspect.signature(service.conceder).parameters

    async with sesiones() as db:
        producto_id = await _dar_de_alta(db, provider="stripe")
        orden = await comercio.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto_id,
            provider="stripe",
            channel="web",
            environment="sandbox",
        )
        await db.commit()
        # El importe salió del curso, no de ningún sitio que toque el cliente.
        assert orden.amount_minor == PRECIO


# --------------------------------------------------------------------------- #
# Que cada proveedor esté donde debe
# --------------------------------------------------------------------------- #


def test_stripe_nunca_entra_en_la_compra_nativa():
    """Vender por Stripe dentro de la app es motivo de rechazo en las tiendas."""
    assert "stripe" not in nativo.PROVEEDORES_NATIVOS
    assert nativo.PROVEEDORES_NATIVOS == frozenset(
        {"google", "apple", "revenuecat_test"}
    )


@pytest.mark.asyncio
async def test_una_compra_por_stripe_no_llega_por_la_via_nativa(sesiones):
    """Y no es solo la lista: una compra con `store: stripe` no concede aquí.

    Ese cobro lo confirma el webhook de Stripe con su firma; colarlo por la
    sincronización nativa sería saltarse esa verificación.
    """
    async with sesiones() as db:
        await _dar_de_alta(db, provider="stripe")
        cliente, _ = _cliente([_compra(store="stripe")])
        resultado = await nativo.sincronizar(
            db, user_id=ANA, cliente=cliente, entorno="sandbox"
        )
        assert resultado.concedidos == []


def test_revenuecat_no_se_exige_en_la_web():
    """La web cobra por Stripe. Pedirle RevenueCat sería pedirle un móvil."""
    from app.modules.payments.router import _proveedores_para

    assert _proveedores_para("web", "sandbox") == ["stripe"]
    assert _proveedores_para("web", "production") == ["stripe"]


def test_el_test_store_no_existe_en_produccion():
    """Una compra de juguete no puede abrir un curso de verdad."""
    for plataforma in ("android", "ios"):
        assert "revenuecat_test" in _proveedores("sandbox", plataforma)
        assert "revenuecat_test" not in _proveedores("production", plataforma)


def _proveedores(entorno: str, plataforma: str) -> list[str]:
    from app.modules.payments.router import _proveedores_para

    return _proveedores_para(plataforma, entorno)


# --------------------------------------------------------------------------- #
# Configuración ausente
# --------------------------------------------------------------------------- #


def test_sin_claves_el_cliente_no_se_construye_pero_no_revienta():
    """Falta de configuración = error con nombre, no un 500 opaco."""
    with pytest.raises(RevenueCatError):
        RevenueCatClient(secret_api_key="", project_id="")
    with pytest.raises(RevenueCatError):
        RevenueCatClient(secret_api_key="sk_x", project_id="")


def test_la_clave_publica_del_sdk_no_vale_como_secreta():
    """Las públicas (`appl_`, `goog_`, la del Test Store) no pueden estar aquí.

    Fallar pronto y con nombre propio ahorra depurar un 401 opaco, y sobre todo
    deja claro que en el servidor no pinta nada una clave del cliente.
    """
    for publica in ("appl_abc", "goog_abc", "test_abc"):
        with pytest.raises(RevenueCatError):
            RevenueCatClient(secret_api_key=publica, project_id=PROYECTO)


def test_las_banderas_estan_apagadas_por_defecto():
    """Todo apagado de fábrica. Encender es una decisión, no un descuido."""
    from app.core.config import Settings

    por_defecto = Settings(_env_file=None)
    assert por_defecto.payments_enabled is False
    assert por_defecto.stripe_payments_enabled is False
    assert por_defecto.revenuecat_verification_enabled is False
    assert por_defecto.revenuecat_webhook_enabled is False


def test_no_hay_secretos_escritos_en_el_codigo():
    """Ninguna clave real vive en el repositorio."""
    from app.core.config import Settings

    por_defecto = Settings(_env_file=None)
    assert por_defecto.revenuecat_secret_api_key == ""
    assert por_defecto.revenuecat_project_id == ""
    assert por_defecto.stripe_secret_key == ""
    assert por_defecto.stripe_webhook_secret == ""


def test_stripe_esta_registrado_como_pasarela():
    assert "stripe" in PROVIDERS
    assert PROVIDERS["stripe"].name == "stripe"
