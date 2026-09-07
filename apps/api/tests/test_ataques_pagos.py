"""Intentos de ROMPER el comercio, los pagos y el muro de los cursos V2.

Este fichero no comprueba que las cosas funcionen: comprueba que NO se pueden
forzar. Cada apartado es un ataque concreto escrito como lo escribiria quien lo
intenta —una peticion HTTP contra la aplicacion entera, con su sesion, sus
dependencias y su base de datos—, no una llamada directa a la funcion que ya se
sabe que valida.

POR QUE POR HTTP Y NO POR LA FUNCION. Porque el agujero casi nunca esta en la
funcion: esta en el endpoint que se olvido de llamarla. `test_comercio.py` ya
prueba que `resolver_acceso_al_curso()` responde bien; lo que aqui se prueba es
que la respuesta de esa funcion LLEGA a la pantalla que sirve el video. Las dos
cosas se rompen por separado.

LA FRONTERA DE LOS PROVEEDORES SE SIMULA, Y SOLO ESA. De Stripe se firman los
avisos con el mismo HMAC-SHA256 que usa Stripe, asi que la verificacion se
ejerce de verdad; de RevenueCat se sustituye el transporte HTTP por un
`httpx.MockTransport`, asi que el cliente monta sus URLs, pagina y traduce igual
que en produccion. **Ninguna prueba sale a la red, ni en modo de pruebas.**

Los catorce ataques, y por que cada uno:

  1. Precio alterado desde el cliente.       8. Producto de otro curso.
  2. «Ya pague» dicho por el telefono.       9. `appUserID` que no es el del token.
  3. Reenvio del mismo aviso diez veces.    10. Compra sin sesion.
  4. Transaccion repetida entre entornos.   11. IDOR en historial y pedidos.
  5. El curso de otra persona.              12. RLS: escribirse un derecho.
  6. Contenido privado sin derecho.         13. Firma de Stripe invalida.
  7. Reembolso que no revoca.               14. La compra vieja que se pierde.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog import cursos_v2
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.catalog.models import Course
from app.modules.commerce import esquema as esquema_de_comercio
from app.modules.commerce import service as comercio
from app.modules.commerce.models import (
    Entitlement,
    Order,
    PaymentEvent,
    PaymentTransaction,
    ProviderProduct,
)
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.payments import providers as modulo_de_pasarelas
from app.modules.payments import router as router_de_pagos
from app.modules.payments.revenuecat import RevenueCatClient
from app.modules.payments.stripe_provider import StripeProvider
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.shared.database import Base, get_db

PAGOS = "/api/v1/payments"
LEARNING = "/api/v1/learning"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # compra
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # el que lo intenta
AUTORA = "aaaaaaaa-0000-0000-0000-000000000003"  # dueña de los cursos

CURSO_A = "cccccccc-0000-0000-0000-00000000000a"
CURSO_B = "cccccccc-0000-0000-0000-00000000000b"
MODULO_A = "dddddddd-0000-0000-0000-00000000000a"
LECCION_PRIVADA = "eeeeeeee-0000-0000-0000-000000000001"
LECCION_MUESTRA = "eeeeeeee-0000-0000-0000-000000000002"
LECCION_DE_TEXTO = "eeeeeeee-0000-0000-0000-000000000003"

PRECIO_A = 29700
PRECIO_B = 19900

RUTA_PRIVADA = "curso-a/leccion-1.mp4"
RUTA_MUESTRA = "curso-a/muestra.mp4"
TEXTO_DE_PAGO = "El metodo entero, paso a paso. Esto es lo que se paga."

EN_LA_TIENDA_A = "z.curso.a.lifetime"
EN_LA_TIENDA_B = "z.curso.b.lifetime"
EN_REVENUECAT_A = "prod1a2b3c4d5e"
PROYECTO = "proj1ab2c3d4"
SECRETO_DE_STRIPE = "whsec_de_pruebas_no_es_real"

#: Los mismos `alter table` de `0034_cursos_v2.sql` que ya usa
#: `test_cursos_v2.py`, recortados a lo que necesita el muro: sin `is_preview`
#: no hay muestras y sin `kind` no hay lecciones de texto.
MIGRACION_0034 = (
    "alter table courses add column subtitle text",
    "alter table courses add column promo_video_path text",
    "alter table courses add column primary_topic_id char(32)",
    "alter table courses add column language text not null default 'es'",
    "alter table courses add column level text",
    "alter table courses add column target_audience json",
    "alter table courses add column prerequisites json",
    "alter table courses add column review_status text not null default 'draft'",
    "alter table courses add column submitted_at timestamp",
    "alter table courses add column reviewed_at timestamp",
    "alter table courses add column reviewed_by char(32)",
    "alter table courses add column rejection_reason text",
    "alter table course_modules add column description text not null default ''",
    "alter table course_lessons add column kind text not null default 'video'",
    "alter table course_lessons add column is_preview boolean not null default 0",
)


# --------------------------------------------------------------------------- #
# Montaje
# --------------------------------------------------------------------------- #
async def _levantar():
    """Dos cursos de pago publicados y aprobados, con muestra y leccion de texto."""
    cache.vaciar()
    esquema_de_catalogo.olvidar()
    esquema_de_comercio.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for sentencia in MIGRACION_0034:
            await conn.execute(text(sentencia))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=AUTORA, full_name="Autora", username="autora"))
        for cid, titulo, precio in (
            (CURSO_A, "Curso A", PRECIO_A),
            (CURSO_B, "Curso B", PRECIO_B),
        ):
            db.add(
                Course(
                    id=cid,
                    author_id=AUTORA,
                    title=titulo,
                    description="Una descripcion suficientemente larga.",
                    price_minor=precio,
                    currency="PEN",
                    status="published",
                )
            )
        db.add(CourseModule(id=MODULO_A, course_id=CURSO_A, title="Modulo 1"))
        db.add(
            CourseLesson(
                id=LECCION_PRIVADA,
                module_id=MODULO_A,
                title="Leccion cerrada",
                media_path=RUTA_PRIVADA,
                sort_order=0,
            )
        )
        db.add(
            CourseLesson(
                id=LECCION_MUESTRA,
                module_id=MODULO_A,
                title="Muestra",
                media_path=RUTA_MUESTRA,
                sort_order=1,
            )
        )
        db.add(
            CourseLesson(
                id=LECCION_DE_TEXTO,
                module_id=MODULO_A,
                title="Leccion escrita",
                body=TEXTO_DE_PAGO,
                sort_order=2,
            )
        )
        await db.commit()

        # La ficha de la 0034: aprobados, y una leccion marcada como muestra.
        # Se escribe con las tablas TIPADAS de `cursos_v2`, nunca con SQL crudo:
        # `Uuid(as_uuid=False)` guarda los identificadores en SQLite sin
        # guiones, y una comparacion en texto plano no casaria con nada, no
        # fallaria, y dejaria la prueba «pasando» sobre datos sin preparar.
        await db.execute(
            cursos_v2.CURSOS.update().values(review_status=cursos_v2.APROBADO)
        )
        await db.execute(
            cursos_v2.LECCIONES.update()
            .where(cursos_v2.LECCIONES.c.id == LECCION_MUESTRA)
            .values(is_preview=True)
        )
        await db.execute(
            cursos_v2.LECCIONES.update()
            .where(cursos_v2.LECCIONES.c.id == LECCION_DE_TEXTO)
            .values(kind="text")
        )
        await db.commit()

    return engine, sesiones


def _stripe_de_mentira() -> tuple[StripeProvider, list[dict]]:
    """La FRONTERA de Stripe, y nada mas: el transporte HTTP.

    Se queda con lo que se le manda para poder mirarlo: el importe que sale
    hacia la pasarela es el que decidio el servidor, y esa es media prueba del
    ataque 1.
    """
    enviado: list[dict] = []

    def responder(peticion: httpx.Request) -> httpx.Response:
        # El cuerpo va `form-encoded` y con los corchetes escapados; sin
        # deshacerlo, buscar la clave del importe no encontraria nada y la
        # prueba «pasaria» sin haber mirado lo que se manda.
        enviado.append(dict(parse_qsl(peticion.content.decode("utf-8"))))
        return httpx.Response(
            200, json={"id": "cs_test_1", "url": "https://checkout.stripe/cs_test_1"}
        )

    cliente = httpx.AsyncClient(transport=httpx.MockTransport(responder))
    return StripeProvider(cliente_http=cliente), enviado


def _revenuecat_de_mentira(compras_por_usuario: dict[str, list[dict]]):
    """El transporte de RevenueCat. Responde SEGUN el `appUserID` que se pida.

    Esto es lo que convierte el ataque 9 en una prueba de verdad: si el servidor
    preguntara por el identificador que manda el telefono en vez de por el del
    token, este doble le devolveria las compras de otra persona.
    """
    pedidas: list[str] = []

    def responder(peticion: httpx.Request) -> httpx.Response:
        ruta = peticion.url.path
        pedidas.append(ruta)
        if ruta.endswith("/purchases"):
            quien = ruta.split("/customers/")[1].split("/")[0]
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "items": compras_por_usuario.get(quien, []),
                    "next_page": None,
                },
            )
        if "/products/" in ruta:
            # El `product_id` de RevenueCat NO es el identificador de la
            # tienda, y confundirlos casaria siempre a cero. El doble los
            # distingue de verdad: cualquier producto que no sea el nuestro
            # devuelve un `store_identifier` que no esta en `provider_products`.
            interno = ruta.rsplit("/", 1)[-1]
            return httpx.Response(
                200,
                json={
                    "object": "product",
                    "id": interno,
                    "store_identifier": (
                        EN_LA_TIENDA_A
                        if interno == EN_REVENUECAT_A
                        else f"de.otra.app.{interno}"
                    ),
                },
            )
        return httpx.Response(404, json={})

    return httpx.MockTransport(responder), pedidas


class _Entorno:
    """Lo que necesita cada prueba, junto y con nombre."""

    def __init__(self, http, sesiones, identidad, stripe_enviado, revenuecat_pedidas):
        self.http = http
        self.sesiones = sesiones
        self.identidad = identidad
        self.stripe_enviado = stripe_enviado
        self.revenuecat_pedidas = revenuecat_pedidas

    def como(self, uid: str | None) -> None:
        self.identidad["uid"] = uid


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones = await _levantar()
    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        # `role="authenticated"` a proposito: es LO UNICO que trae el JWT de
        # Supabase. Si algun endpoint decidiera permisos con esto, aqui se veria.
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    async def _opcional_override() -> AuthUser | None:
        return None if identidad["uid"] is None else await _usuario_override()

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _opcional_override

    ajustes = get_settings()
    anterior = {
        "payments_enabled": ajustes.payments_enabled,
        "stripe_payments_enabled": ajustes.stripe_payments_enabled,
        "revenuecat_verification_enabled": ajustes.revenuecat_verification_enabled,
        "stripe_secret_key": ajustes.stripe_secret_key,
        "stripe_webhook_secret": ajustes.stripe_webhook_secret,
        "revenuecat_secret_api_key": ajustes.revenuecat_secret_api_key,
        "revenuecat_project_id": ajustes.revenuecat_project_id,
        "environment": ajustes.environment,
    }
    ajustes.payments_enabled = True
    ajustes.stripe_payments_enabled = True
    ajustes.revenuecat_verification_enabled = True
    ajustes.stripe_secret_key = "sk_test_de_pruebas"
    ajustes.stripe_webhook_secret = SECRETO_DE_STRIPE
    ajustes.revenuecat_secret_api_key = "sk_de_pruebas"
    ajustes.revenuecat_project_id = PROYECTO

    pasarela, enviado = _stripe_de_mentira()
    pasarela_anterior = modulo_de_pasarelas.PROVIDERS.get("stripe")
    modulo_de_pasarelas.PROVIDERS["stripe"] = pasarela

    compras: dict[str, list[dict]] = {}
    transporte, pedidas = _revenuecat_de_mentira(compras)
    cliente_anterior = router_de_pagos.RevenueCatClient

    def _fabricar(**kwargs):
        kwargs.pop("base_url", None)
        return RevenueCatClient(
            **kwargs,
            base_url="https://revenuecat.de.mentira/v2",
            cliente_http=httpx.AsyncClient(transport=transporte),
        )

    router_de_pagos.RevenueCatClient = _fabricar  # type: ignore[assignment]

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        e = _Entorno(http, sesiones, identidad, enviado, pedidas)
        e.compras_de_revenuecat = compras  # type: ignore[attr-defined]
        yield e

    router_de_pagos.RevenueCatClient = cliente_anterior  # type: ignore[assignment]
    if pasarela_anterior is None:
        modulo_de_pasarelas.PROVIDERS.pop("stripe", None)
    else:
        modulo_de_pasarelas.PROVIDERS["stripe"] = pasarela_anterior
    for clave, valor in anterior.items():
        setattr(ajustes, clave, valor)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema_de_catalogo.olvidar()
    esquema_de_comercio.olvidar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Ayudas de datos
# --------------------------------------------------------------------------- #
async def _dar_de_alta(sesiones, *, curso, provider, external, environment="sandbox"):
    async with sesiones() as db:
        producto = await comercio.asegurar_producto_de_curso(db, course_id=curso)
        db.add(
            ProviderProduct(
                commerce_product_id=producto.id,
                provider=provider,
                environment=environment,
                external_product_id=external,
            )
        )
        await db.commit()
        return producto.id


def _firmar(cuerpo: bytes, *, secreto: str = SECRETO_DE_STRIPE, marca=None) -> str:
    instante = int(time.time()) if marca is None else int(marca)
    firma = hmac.new(
        secreto.encode("utf-8"),
        f"{instante}.".encode("utf-8") + cuerpo,
        hashlib.sha256,
    ).hexdigest()
    return f"t={instante},v1={firma}"


def _sesion_pagada(
    *,
    order_id: str,
    importe: int,
    event_id: str = "evt_1",
    intento: str = "pi_1",
    livemode: bool = False,
    metadata_extra: dict | None = None,
) -> dict:
    metadata = {"order_id": order_id}
    metadata.update(metadata_extra or {})
    return {
        "id": event_id,
        "type": "checkout.session.completed",
        "livemode": livemode,
        "data": {
            "object": {
                "id": "cs_test_1",
                "payment_status": "paid",
                "payment_intent": intento,
                "amount_total": importe,
                "currency": "pen",
                "client_reference_id": order_id,
                "metadata": metadata,
            }
        },
    }


def _devolucion(
    *,
    intento: str = "pi_1",
    importe: int,
    cobrado: int | None = None,
    event_id: str = "evt_ref",
    reembolso: str | None = "re_1",
) -> dict:
    """Un `charge.refunded` como lo manda Stripe DE VERDAD.

    ESTE DOBLE CAMBIO. Antes solo llevaba `amount_refunded`, y con eso no se
    puede saber si el reembolso fue total o parcial: falta el importe original.
    Mientras los eventos de devolucion se traducian por su NOMBRE daba igual
    —cualquiera revocaba—, pero esa era justamente la traduccion equivocada:
    devolver 1 de 199 quitaba el curso entero.

    Ahora se mandan los tres campos que trae el evento real: `amount` (lo que
    se cobro), `amount_refunded` (lo que se devuelve) y `refunded` (si el cobro
    quedo devuelto DEL TODO). `cobrado` por defecto es el importe devuelto, o
    sea una devolucion total.

    Y LA LISTA `refunds`, que es de donde sale el `re_...`. El objeto Charge la
    trae por defecto, y sin ella el aviso no identifica ningun reembolso: lo
    unico que hay es el cobro. `reembolso=None` reproduce ese caso a proposito.
    """
    total = cobrado if cobrado is not None else importe
    cobro: dict = {
        "id": "ch_1",
        "payment_intent": intento,
        "amount": total,
        "amount_refunded": importe,
        "refunded": importe >= total,
        "currency": "pen",
    }
    if reembolso is not None:
        cobro["refunds"] = {
            "object": "list",
            "data": [{"id": reembolso, "amount": importe, "currency": "pen"}],
        }
    return {
        "id": event_id,
        "type": "charge.refunded",
        "livemode": False,
        "data": {"object": cobro},
    }


async def _avisar(http, evento: dict, *, firma: str | None = None, cuerpo=None):
    crudo = cuerpo if cuerpo is not None else json.dumps(evento).encode("utf-8")
    cabeceras = {"content-type": "application/json"}
    if firma is not None:
        cabeceras["stripe-signature"] = firma
    return await http.post(f"{PAGOS}/webhook/stripe", content=crudo, headers=cabeceras)


async def _comprar_por_stripe(
    entorno,
    *,
    curso=CURSO_A,
    importe=PRECIO_A,
    intento: str = "pi_1",
    event_id: str = "evt_1",
):
    """El camino legitimo entero: checkout, aviso firmado y derecho concedido.

    `intento` y `event_id` se pueden cambiar para encadenar DOS compras en la
    misma prueba: dos cobros distintos no pueden compartir `payment_intent`, y
    dos avisos no pueden compartir identificador o el segundo se descarta por
    repetido.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=curso, provider="stripe", external="price_" + curso[-1]
    )
    respuesta = await entorno.http.post(
        f"{PAGOS}/stripe/checkout", json={"course_id": curso}
    )
    assert respuesta.status_code == 200, respuesta.text
    pedido = respuesta.json()["purchase_id"]
    evento = _sesion_pagada(
        order_id=pedido, importe=importe, intento=intento, event_id=event_id
    )
    crudo = json.dumps(evento).encode("utf-8")
    aviso = await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    assert aviso.status_code == 204, aviso.text
    return pedido


async def _cuantos(sesiones, entidad, *filtros) -> int:
    async with sesiones() as db:
        return int(
            await db.scalar(select(func.count()).select_from(entidad).where(*filtros))
            or 0
        )


async def _acceso(http, curso: str) -> dict:
    respuesta = await http.get(f"{PAGOS}/courses/{curso}/access")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _leccion(http, lesson_id: str) -> dict:
    respuesta = await http.get(f"{LEARNING}/lessons/{lesson_id}")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# =========================================================================== #
# 1. El importe lo pone el servidor
# =========================================================================== #
@pytest.mark.asyncio
async def test_mandar_el_importe_no_cambia_lo_que_se_cobra(entorno):
    """El cuerpo trae un importe de 1 centimo. No llega a ninguna parte.

    Se comprueban los DOS extremos, porque romper uno solo ya bastaria: lo que
    se guarda en el pedido, y lo que sale hacia la pasarela. Un pedido correcto
    con un `unit_amount` de 1 cobraria 1.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    respuesta = await entorno.http.post(
        f"{PAGOS}/stripe/checkout",
        json={
            "course_id": CURSO_A,
            "amount_minor": 1,
            "price_minor": 1,
            "currency": "USD",
            "amount": 1,
        },
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["amount_minor"] == PRECIO_A
    assert respuesta.json()["currency"] == "PEN"

    async with entorno.sesiones() as db:
        pedido = await db.get(Order, respuesta.json()["purchase_id"])
        assert pedido.amount_minor == PRECIO_A
        assert pedido.currency == "PEN"

    campos = entorno.stripe_enviado[-1]
    assert campos["line_items[0][price_data][unit_amount]"] == str(PRECIO_A)
    assert campos["line_items[0][price_data][currency]"] == "pen"


@pytest.mark.asyncio
async def test_un_aviso_por_otro_importe_no_concede(entorno):
    """El pedido dice 29700 y el aviso dice 1. No se concede nada.

    Es la unica forma de comprar un curso de 300 por 1 si alguien consiguiera
    manipular la sesion de pago, asi que la comprobacion tiene que estar en el
    servidor y no en la pasarela.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    respuesta = await entorno.http.post(
        f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A}
    )
    pedido = respuesta.json()["purchase_id"]

    evento = _sesion_pagada(order_id=pedido, importe=1)
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    assert await _cuantos(entorno.sesiones, Entitlement) == 0
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False


# =========================================================================== #
# 2. Un «ya pague» del cliente no concede nada
# =========================================================================== #
@pytest.mark.asyncio
async def test_decir_que_ya_se_pago_no_concede_nada(entorno):
    """El telefono manda estado, entitlements y cursos. RevenueCat dice que no.

    Manda la respuesta del proveedor, no el cuerpo de la peticion. Si el
    endpoint se creyera algo del cuerpo, aqui saldria un derecho de la nada.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="google", external=EN_LA_TIENDA_A
    )
    respuesta = await entorno.http.post(
        f"{PAGOS}/native/sync",
        json={
            "platform": "android",
            "status": "paid",
            "entitlements": ["acceso_total"],
            "granted": [CURSO_A],
            "course_id": CURSO_A,
            "product_id": EN_LA_TIENDA_A,
            "transaction_id": "GPA.inventada",
        },
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["granted"] == []
    assert await _cuantos(entorno.sesiones, Entitlement) == 0
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False


@pytest.mark.asyncio
async def test_volver_del_navegador_no_marca_pagado_el_pedido(entorno):
    """Abrir el checkout deja el pedido en 'pending' y ahi se queda.

    Volver de la pasarela no prueba nada: se puede volver sin haber pagado, y se
    puede pagar sin volver. Solo el aviso firmado mueve el estado.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})

    historial = (await entorno.http.get(f"{PAGOS}/history")).json()
    assert [f["status"] for f in historial] == ["pending"]
    assert historial[0]["has_access"] is False
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False


@pytest.mark.asyncio
async def test_un_curso_de_pago_no_se_consigue_por_la_puerta_de_los_gratuitos(entorno):
    """`/enroll` es para cursos gratuitos. Un curso de pago no pasa por ahi."""
    respuesta = await entorno.http.post(f"{LEARNING}/courses/{CURSO_A}/enroll")
    assert respuesta.status_code == 403
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False


# =========================================================================== #
# 3. Reenviar el mismo aviso diez veces
# =========================================================================== #
@pytest.mark.asyncio
async def test_diez_avisos_iguales_dejan_un_derecho_y_un_cobro(entorno):
    """El mismo evento firmado, diez veces. Un derecho, un cobro, un aviso."""
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    pedido = (
        await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})
    ).json()["purchase_id"]

    evento = _sesion_pagada(order_id=pedido, importe=PRECIO_A)
    crudo = json.dumps(evento).encode("utf-8")
    for _ in range(10):
        # La firma se recalcula en cada envio, como haria Stripe al reintentar:
        # asi la barrera que se prueba es la idempotencia y no la caducidad.
        respuesta = await _avisar(
            entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo
        )
        assert respuesta.status_code == 204

    assert await _cuantos(entorno.sesiones, Entitlement) == 1
    assert await _cuantos(entorno.sesiones, PaymentTransaction) == 1
    assert await _cuantos(entorno.sesiones, PaymentEvent) == 1
    assert await _cuantos(entorno.sesiones, Order) == 1
    assert len((await entorno.http.get(f"{PAGOS}/history")).json()) == 1


@pytest.mark.asyncio
async def test_la_idempotencia_la_sostiene_la_base_y_no_un_if(entorno):
    """Se salta el servicio y se inserta A MANO. La base tiene que negarse.

    Es la diferencia que importa: un `if` en Python lo pasan dos peticiones
    simultaneas —leen las dos antes de que escriba ninguna—, un indice unico no.
    Por eso aqui no se llama a `conceder_entitlement()`: se inserta directamente
    contra la tabla, que es lo que haria una carrera.
    """
    await _comprar_por_stripe(entorno)

    async with entorno.sesiones() as db:
        derecho = await db.scalar(select(Entitlement))
        cobro = await db.scalar(select(PaymentTransaction))
        aviso = await db.scalar(select(PaymentEvent))

    duplicados = (
        Entitlement(
            user_id=derecho.user_id,
            commerce_product_id=derecho.commerce_product_id,
            status="active",
        ),
        PaymentTransaction(
            provider=cobro.provider,
            environment=cobro.environment,
            external_transaction_id=cobro.external_transaction_id,
        ),
        PaymentEvent(
            provider=aviso.provider,
            external_event_id=aviso.external_event_id,
            event_type=aviso.event_type,
        ),
    )
    for fila in duplicados:
        async with entorno.sesiones() as db:
            db.add(fila)
            with pytest.raises(IntegrityError):
                await db.commit()


# =========================================================================== #
# 4. La misma transaccion en otro proveedor o en otro entorno
# =========================================================================== #
@pytest.mark.asyncio
async def test_el_mismo_identificador_en_otra_tienda_es_otro_cobro(entorno):
    """La idempotencia va por `(proveedor, entorno, transaccion)`, no por texto.

    Los identificadores de Apple y de Google se parecen y nada impide que
    coincidan. Si la clave fuera solo el texto, la compra de una tienda taparia
    la de la otra y alguien se quedaria sin su curso.
    """
    async with entorno.sesiones() as db:
        for proveedor, entorno_ in (
            ("google", "sandbox"),
            ("apple", "sandbox"),
            ("google", "production"),
        ):
            _fila, nueva = await comercio.registrar_transaccion(
                db,
                provider=proveedor,
                environment=entorno_,
                external_transaction_id="1000000",
            )
            assert nueva is True
        await db.commit()
    assert await _cuantos(entorno.sesiones, PaymentTransaction) == 3


@pytest.mark.asyncio
async def test_un_aviso_de_pruebas_no_concede_en_produccion(entorno):
    """Servidor en produccion, aviso con `livemode: false`. No concede.

    Las tiendas y Stripe mandan las compras de prueba con la misma forma que las
    de verdad. Sin este corte, una compra de juguete abre un curso real.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    pedido = (
        await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})
    ).json()["purchase_id"]

    ajustes = get_settings()
    ajustes.environment = "production"
    try:
        evento = _sesion_pagada(order_id=pedido, importe=PRECIO_A, livemode=False)
        crudo = json.dumps(evento).encode("utf-8")
        respuesta = await _avisar(
            entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo
        )
        assert respuesta.status_code == 204
    finally:
        ajustes.environment = "development"

    assert await _cuantos(entorno.sesiones, Entitlement) == 0


# =========================================================================== #
# 5. El curso de otra persona
# =========================================================================== #
@pytest.mark.asyncio
async def test_el_derecho_de_una_persona_no_abre_el_curso_a_otra(entorno):
    """Ana compra. Bruno no. Los DOS endpoints tienen que decir lo mismo.

    Se preguntan los dos a proposito: `/payments/.../access` es el que consulta
    la pantalla de compra y `/learning/courses/{id}` es el que sirve el temario
    y las rutas del video. Que uno diga «tienes acceso» y el otro lo niegue es
    justo el fallo que ya costo caro en la 0016, y se rompen por separado.
    """
    await _comprar_por_stripe(entorno)

    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True
    ficha = (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()
    assert ficha["has_access"] is True, (
        "Quien ha pagado con el flujo nuevo no puede ver su curso: "
        "/learning ignora `entitlements`."
    )
    rutas = {
        leccion["id"]: leccion["media_path"]
        for modulo in ficha["modules"]
        for leccion in modulo["lessons"]
    }
    assert rutas[LECCION_PRIVADA] == RUTA_PRIVADA

    entorno.como(BRUNO)
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False
    ajena = (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()
    assert ajena["has_access"] is False
    ajenas = {
        leccion["id"]: leccion["media_path"]
        for modulo in ajena["modules"]
        for leccion in modulo["lessons"]
    }
    assert ajenas[LECCION_PRIVADA] is None


@pytest.mark.asyncio
async def test_el_curso_comprado_aparece_en_la_biblioteca_de_quien_pago(entorno):
    """«Mis cursos» sale del servidor, y tiene que incluir lo comprado.

    Si la biblioteca solo mirara la tabla vieja, quien compre por Stripe o por
    la tienda pagaria y no veria el curso en ninguna lista.
    """
    await _comprar_por_stripe(entorno)
    mios = (await entorno.http.get(f"{LEARNING}/me/courses")).json()
    assert [c["id"] for c in mios] == [CURSO_A]

    entorno.como(BRUNO)
    assert (await entorno.http.get(f"{LEARNING}/me/courses")).json() == []


# =========================================================================== #
# 6. Contenido privado sin derecho, y la muestra sin comprar
# =========================================================================== #
@pytest.mark.asyncio
async def test_sin_derecho_no_se_reparte_la_ruta_del_video(entorno):
    """Sin comprar no se entrega la ruta, pero si se dice que hay video.

    Esconder la ruta no puede convertir «no tienes acceso» en «esta leccion aun
    no tiene video»: son dos cosas distintas delante de quien mira.
    """
    entorno.como(BRUNO)
    leccion = await _leccion(entorno.http, LECCION_PRIVADA)
    assert leccion["media_path"] is None
    assert leccion["has_media"] is True
    assert leccion["has_access"] is False


@pytest.mark.asyncio
async def test_una_leccion_de_muestra_si_se_ve_sin_comprar(entorno):
    """Para eso existe. Sin esto, o se compra todo o no se ve nada."""
    entorno.como(BRUNO)
    muestra = await _leccion(entorno.http, LECCION_MUESTRA)
    assert muestra["is_preview"] is True
    assert muestra["media_path"] == RUTA_MUESTRA
    assert muestra["has_access"] is False


@pytest.mark.asyncio
async def test_el_texto_de_una_leccion_de_pago_no_se_regala(entorno):
    """Una leccion `kind='text'` NO tiene video: su contenido es el texto.

    Esconder `media_path` no protege nada aqui, porque no hay archivo que
    firmar. Si el cuerpo viaja sin comprobar el acceso, el curso escrito se lee
    entero con solo abrir la leccion, y la RLS del almacenamiento no puede
    hacer nada: nunca llega a haber un objeto que proteger.
    """
    entorno.como(BRUNO)
    leccion = await _leccion(entorno.http, LECCION_DE_TEXTO)
    assert leccion["kind"] == "text"
    assert leccion["has_access"] is False
    assert TEXTO_DE_PAGO not in leccion["body"], (
        "El contenido de una leccion de texto de pago se entrega sin comprarla."
    )


@pytest.mark.asyncio
async def test_quien_paga_si_lee_la_leccion_de_texto(entorno):
    """Y el corte anterior no puede dejar sin su curso a quien lo compro."""
    await _comprar_por_stripe(entorno)
    leccion = await _leccion(entorno.http, LECCION_DE_TEXTO)
    assert leccion["body"] == TEXTO_DE_PAGO


# =========================================================================== #
# 7. El reembolso revoca de verdad
# =========================================================================== #
@pytest.mark.asyncio
async def test_un_reembolso_quita_el_acceso_de_verdad(entorno):
    """Revocar el derecho no basta si queda la compra vieja abierta.

    `has_course_access` sigue mirando `purchases` durante el trasvase, asi que
    un reembolso que solo toque `entitlements` deja el acceso puesto para
    siempre. Aqui la persona tiene LAS DOS COSAS, que es el caso realista de
    quien vuelve a comprar algo que ya tenia.
    """
    await _comprar_por_stripe(entorno)
    async with entorno.sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_A,
                provider="web",
                amount_minor=PRECIO_A,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True

    evento = _devolucion(importe=PRECIO_A)
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False
    ficha = (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()
    assert ficha["has_access"] is False
    assert await _cuantos(entorno.sesiones, Entitlement, Entitlement.status == "active") == 0
    assert await _cuantos(entorno.sesiones, Purchase, Purchase.status == "paid") == 0
    historial = (await entorno.http.get(f"{PAGOS}/history")).json()
    assert historial[0]["status"] == "refunded"
    assert historial[0]["has_access"] is False


@pytest.mark.asyncio
async def test_un_charge_refunded_SIN_identificador_de_reembolso_no_revoca(entorno):
    """El aviso trae el cobro pero no el reembolso: no hay qué conciliar.

    ANTES SE COMPONIA UNO: `f"{payment_intent}:refund"`. Ese identificador no
    existe en Stripe, asi que no se podia consultar para verificarlo, no se
    podia auditar, y como salia del cobro tampoco servia para detectar que el
    mismo reembolso se estaba aplicando a dos ordenes distintas.

    Sin `re_...` el caso queda SIN CONCILIAR: el acceso se conserva y hace falta
    una revision —o el `refund.updated` que llegara despues con su
    identificador—. Un acceso de mas se corrige; quitarle el curso a quien no
    cobro, no.
    """
    await _comprar_por_stripe(entorno)
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True

    evento = _devolucion(importe=PRECIO_A, reembolso=None)
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    # Ni acceso retirado, ni orden reembolsada, ni garantia consumida.
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True
    assert await _cuantos(entorno.sesiones, Entitlement, Entitlement.status == "active") == 1


@pytest.mark.asyncio
async def test_un_aviso_sin_importe_no_revoca(entorno):
    """La coalescencia que habia aqui convertia la ausencia en el total."""
    await _comprar_por_stripe(entorno)
    evento = _devolucion(importe=PRECIO_A)
    # Se le quita el importe al cobro, como si Stripe no lo informara.
    evento["data"]["object"]["amount"] = None
    evento["data"]["object"]["amount_refunded"] = None
    evento["data"]["object"]["refunds"]["data"][0]["amount"] = None
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True


@pytest.mark.asyncio
async def test_un_aviso_en_otra_moneda_no_revoca(entorno):
    """El mismo numero en otra divisa no es el mismo dinero."""
    await _comprar_por_stripe(entorno)
    evento = _devolucion(importe=PRECIO_A)
    evento["data"]["object"]["currency"] = "usd"
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True


@pytest.mark.asyncio
async def test_un_aviso_de_produccion_no_toca_una_compra_de_pruebas(entorno):
    """Sin esto, un reembolso del entorno real retira un acceso de sandbox."""
    await _comprar_por_stripe(entorno)
    evento = _devolucion(importe=PRECIO_A)
    evento["livemode"] = True
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True


@pytest.mark.asyncio
async def test_el_mismo_reembolso_no_puede_cerrar_dos_compras(entorno):
    """Un `re_...` real, reenviado apuntando a OTRA compra.

    El UNIQUE de `payment_transactions` impide duplicar la fila, no apuntarla a
    otra orden: sin la comprobacion, un unico reembolso retiraba dos accesos.
    """
    await _comprar_por_stripe(entorno)
    evento = _devolucion(importe=PRECIO_A, reembolso="re_compartido")
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False

    # OTRA compra, con su propio cobro, y el MISMO identificador de reembolso.
    await _comprar_por_stripe(
        entorno, curso=CURSO_B, importe=PRECIO_B, intento="pi_2", event_id="evt_2"
    )
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is True
    otro = _devolucion(
        importe=PRECIO_B, intento="pi_2", event_id="evt_ref_2", reembolso="re_compartido"
    )
    crudo = json.dumps(otro).encode("utf-8")
    assert (
        await _avisar(entorno.http, otro, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204
    # La segunda compra NO se cierra con el reembolso de la primera.
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is True


@pytest.mark.asyncio
async def test_un_reembolso_PARCIAL_no_quita_el_acceso(entorno):
    """Devolver 1 de 199 no puede costar el curso entero.

    Es el reverso de la prueba de arriba y protege el fallo que tenia la
    traduccion de eventos: los tres avisos de devolucion se leian por su NOMBRE,
    asi que un reembolso parcial —una compensacion por una leccion que fallaba,
    por ejemplo— retiraba el acceso completo. La persona se quedaba sin el curso
    y con 198 sin devolver.
    """
    await _comprar_por_stripe(entorno)
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True

    evento = _devolucion(importe=100, cobrado=PRECIO_A, event_id="evt_parcial")
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    # El acceso SIGUE puesto y el derecho sigue activo.
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True
    assert await _cuantos(
        entorno.sesiones, Entitlement, Entitlement.status == "active"
    ) == 1


@pytest.mark.asyncio
async def test_un_reembolso_en_tramite_tampoco_quita_el_acceso(entorno):
    """`refund.created` significa «se ha pedido», no «ha vuelto el dinero».

    Retirar el acceso aqui deja a la persona sin curso Y sin reembolso durante
    todo el tramite, que puede durar dias.
    """
    await _comprar_por_stripe(entorno)

    evento = {
        "id": "evt_tramite",
        "type": "refund.created",
        "livemode": False,
        "data": {
            "object": {
                "id": "re_1",
                "payment_intent": "pi_1",
                "status": "pending",
                "amount": PRECIO_A,
                "currency": "pen",
            }
        },
    }
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True


# =========================================================================== #
# 8. El producto de un curso no abre otro
# =========================================================================== #
@pytest.mark.asyncio
async def test_comprar_un_curso_no_abre_el_otro(entorno):
    """Pagar el curso A da A. Ni B, ni el catalogo."""
    await _comprar_por_stripe(entorno)
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is False


@pytest.mark.asyncio
async def test_la_metadata_del_aviso_no_elige_el_curso(entorno):
    """El aviso dice que el curso es el B. Se concede el del PEDIDO, que es el A.

    La metadata viaja por fuera y se puede manipular si alguien llega a firmar.
    Lo que manda es el pedido guardado en nuestra base: el aviso solo lo
    identifica.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    producto_b = await _dar_de_alta(
        entorno.sesiones, curso=CURSO_B, provider="stripe", external="price_b"
    )
    pedido = (
        await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})
    ).json()["purchase_id"]

    evento = _sesion_pagada(
        order_id=pedido,
        importe=PRECIO_A,
        metadata_extra={"course_id": CURSO_B, "commerce_product_id": producto_b},
    )
    crudo = json.dumps(evento).encode("utf-8")
    assert (
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)
    ).status_code == 204

    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is False


@pytest.mark.asyncio
async def test_un_producto_de_tienda_que_no_es_nuestro_no_concede(entorno):
    """Una compra de otra aplicacion del mismo proyecto de RevenueCat no abre nada."""
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="google", external=EN_LA_TIENDA_A
    )
    entorno.compras_de_revenuecat[ANA] = [
        {
            "object": "purchase",
            "id": "purch_otro",
            "customer_id": ANA,
            "product_id": "prod_de_otra_app",
            "purchased_at": 1658399423658,
            "status": "owned",
            "environment": "sandbox",
            "store": "play_store",
            "store_purchase_identifier": "GPA.9999",
            "ownership": "purchased",
        }
    ]
    respuesta = await entorno.http.post(f"{PAGOS}/native/sync", json={"platform": "android"})
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["granted"] == []
    assert respuesta.json()["unknown_products"] == ["de.otra.app.prod_de_otra_app"]
    assert await _cuantos(entorno.sesiones, Entitlement) == 0
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is False


# =========================================================================== #
# 9. El `appUserID` que manda el telefono
# =========================================================================== #
@pytest.mark.asyncio
async def test_revenuecat_se_consulta_con_el_usuario_del_token(entorno):
    """Bruno pide sincronizar diciendo que es Ana. Se pregunta por Bruno.

    El doble responde SEGUN el identificador que se le pida: si el servidor
    usara el del cuerpo, Bruno se llevaria el curso que pago Ana.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="google", external=EN_LA_TIENDA_A
    )
    entorno.compras_de_revenuecat[ANA] = [
        {
            "object": "purchase",
            "id": "purch_de_ana",
            "customer_id": ANA,
            "product_id": EN_REVENUECAT_A,
            "purchased_at": 1658399423658,
            "status": "owned",
            "environment": "sandbox",
            "store": "play_store",
            "store_purchase_identifier": "GPA.de-ana",
            "ownership": "purchased",
        }
    ]

    entorno.como(BRUNO)
    respuesta = await entorno.http.post(
        f"{PAGOS}/native/sync",
        json={
            "platform": "android",
            "app_user_id": ANA,
            "appUserID": ANA,
            "user_id": ANA,
            "customer_id": ANA,
        },
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["granted"] == []
    assert any(BRUNO in r for r in entorno.revenuecat_pedidas)
    assert not any(ANA in r for r in entorno.revenuecat_pedidas)
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False

    # Control en el otro sentido: si el doble no sirviera compras a NADIE, lo de
    # arriba pasaria sin probar nada. Pedidas con el token de Ana, si llegan.
    entorno.como(ANA)
    suya = await entorno.http.post(f"{PAGOS}/native/sync", json={"platform": "android"})
    assert suya.json()["granted"] == [CURSO_A]
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is True


# =========================================================================== #
# 10. Sin sesion
# =========================================================================== #
@pytest.mark.asyncio
async def test_sin_sesion_no_se_compra_ni_se_consulta_nada(entorno):
    """Todo el portal exige token. Se quita la sesion de verdad, no se finge."""
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    try:
        for metodo, ruta, cuerpo in (
            ("post", f"{PAGOS}/stripe/checkout", {"course_id": CURSO_A}),
            ("post", f"{PAGOS}/checkout", {"course_id": CURSO_A}),
            ("post", f"{PAGOS}/native/sync", {"platform": "android"}),
            ("get", f"{PAGOS}/history", None),
            ("get", f"{PAGOS}/me", None),
            ("get", f"{PAGOS}/courses/{CURSO_A}/access", None),
            ("get", f"{PAGOS}/courses/{CURSO_A}/product", None),
        ):
            llamada = getattr(entorno.http, metodo)
            respuesta = await (llamada(ruta, json=cuerpo) if cuerpo else llamada(ruta))
            assert respuesta.status_code == 401, f"{metodo.upper()} {ruta} -> {respuesta.status_code}"
    finally:
        entorno.como(ANA)


@pytest.mark.asyncio
async def test_sin_sesion_el_temario_no_reparte_las_rutas(entorno):
    """La ficha de un curso de pago se puede mirar sin cuenta; el video no."""
    entorno.como(None)
    ficha = (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()
    assert ficha["has_access"] is False
    rutas = {
        leccion["id"]: leccion["media_path"]
        for modulo in ficha["modules"]
        for leccion in modulo["lessons"]
    }
    assert rutas[LECCION_PRIVADA] is None
    assert rutas[LECCION_MUESTRA] == RUTA_MUESTRA


# =========================================================================== #
# 11. IDOR en historial, pedidos y derechos
# =========================================================================== #
@pytest.mark.asyncio
async def test_el_historial_y_los_pedidos_son_solo_los_propios(entorno):
    """Bruno no ve ni un pedido de Ana, ni su compra vieja, ni su derecho."""
    await _comprar_por_stripe(entorno)
    async with entorno.sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_B,
                provider="web",
                amount_minor=PRECIO_B,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    assert len((await entorno.http.get(f"{PAGOS}/history")).json()) == 1
    assert len((await entorno.http.get(f"{PAGOS}/me")).json()) == 1

    entorno.como(BRUNO)
    assert (await entorno.http.get(f"{PAGOS}/history")).json() == []
    assert (await entorno.http.get(f"{PAGOS}/me")).json() == []
    assert (await entorno.http.get(f"{LEARNING}/me/courses")).json() == []
    assert (await _acceso(entorno.http, CURSO_B))["has_access"] is False


@pytest.mark.asyncio
async def test_el_producto_de_un_curso_no_dice_lo_que_compro_otro(entorno):
    """`ya_comprado` es sobre quien pregunta, no sobre el curso."""
    await _comprar_por_stripe(entorno)
    mio = (await entorno.http.get(f"{PAGOS}/courses/{CURSO_A}/product?platform=web")).json()
    assert mio["reason"] == "ya_comprado"

    entorno.como(BRUNO)
    ajeno = (await entorno.http.get(f"{PAGOS}/courses/{CURSO_A}/product?platform=web")).json()
    assert ajeno["reason"] != "ya_comprado"
    assert ajeno["available"] is True


# =========================================================================== #
# 12. RLS: nadie se escribe un derecho desde la clave publica
# =========================================================================== #
MIGRACIONES = Path(__file__).resolve().parents[3] / "supabase" / "migrations"

#: Las siete del comercio. Ninguna admite escrituras de usuario, HOY NI LUEGO.
TABLAS_DEL_COMERCIO = (
    "commerce_products",
    "provider_products",
    "orders",
    "payment_transactions",
    "payment_events",
    "entitlements",
    "course_enrollments",
)


def _sin_comentarios(sql: str) -> str:
    return "\n".join(linea.split("--")[0] for linea in sql.splitlines())


@pytest.mark.parametrize("fichero", sorted(MIGRACIONES.glob("*.sql")), ids=lambda p: p.name)
def test_ninguna_migracion_abre_una_escritura_del_comercio(fichero: Path):
    """Se leen TODAS las migraciones, no solo la 0035.

    `test_comercio_rls.py` ya vigila el fichero que crea las tablas. Lo que no
    vigila nadie es la migracion 0042 que alguien escriba dentro de seis meses
    para «arreglar algo rapido» y le ponga un `for all` a `entitlements`. Con
    una sola politica de escritura, regalarse el catalogo entero desde la clave
    `anon` —que viaja dentro de la aplicacion movil y se lee descompilandola—
    es una linea, y ademas queda registrado como una concesion legitima.

    Ojo al detalle que obliga a mirar el `for`: `create policy x on t using (...)`
    SIN `for` vale para TODOS los comandos, asi que buscar la palabra «insert»
    no encontraria justo la que se cuela por descuido.
    """
    sql = _sin_comentarios(fichero.read_text(encoding="utf-8"))
    for tabla, resto in re.findall(
        r"create\s+policy\s+\S+\s+on\s+(?:public\.)?(\w+)([^;]*);", sql, re.IGNORECASE
    ):
        if tabla not in TABLAS_DEL_COMERCIO:
            continue
        comando = re.search(r"\bfor\s+(all|select|insert|update|delete)\b", resto, re.I)
        cual = comando.group(1).lower() if comando else "all"
        assert cual == "select", (
            f"{fichero.name} da permiso de '{cual}' sobre `{tabla}`. Conceder y "
            "revocar pasa SIEMPRE por el backend con identidad de servicio."
        )


@pytest.mark.parametrize("fichero", sorted(MIGRACIONES.glob("*.sql")), ids=lambda p: p.name)
def test_ninguna_migracion_concede_escritura_al_rol_publico(fichero: Path):
    """Un `grant` se salta la discusion de las politicas y llega igual de lejos.

    La RLS decide sobre las FILAS; el `grant` decide sobre la TABLA. Cerrar una
    y dejar la otra abierta no cierra nada.
    """
    sql = _sin_comentarios(fichero.read_text(encoding="utf-8"))
    for permisos, tabla, rol in re.findall(
        r"grant\s+([\w\s,]+?)\s+on\s+(?:table\s+)?(?:public\.)?(\w+)\s+to\s+(\w+)",
        sql,
        re.IGNORECASE,
    ):
        if tabla not in TABLAS_DEL_COMERCIO:
            continue
        if rol.lower() not in {"anon", "authenticated", "public"}:
            continue
        escrituras = {"insert", "update", "delete", "truncate", "all"}
        concedidos = {p.strip().lower() for p in permisos.split(",")}
        assert not (concedidos & escrituras), (
            f"{fichero.name} concede {sorted(concedidos & escrituras)} sobre "
            f"`{tabla}` a `{rol}`."
        )


@pytest.mark.asyncio
async def test_el_comercio_no_expone_ninguna_ruta_de_escritura(entorno):
    """No hay endpoint que acepte «concedeme esto».

    La unica forma de que aparezca un derecho es un aviso verificado. Si algun
    dia se añade una ruta que escriba en el comercio, esta prueba la enseña.
    """
    rutas = {
        r.path
        for r in router_de_pagos.router.routes
        if {"POST", "PUT", "PATCH", "DELETE"} & getattr(r, "methods", set())
    }
    assert rutas == {
        "/payments/checkout",
        "/payments/stripe/checkout",
        "/payments/native/sync",
        "/payments/webhook/{provider_name}",
    }, f"Rutas de escritura inesperadas en pagos: {sorted(rutas)}"


# =========================================================================== #
# 13. La firma de Stripe
# =========================================================================== #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "caso",
    ["sin_cabecera", "otro_secreto", "caducada", "cuerpo_cambiado", "cabecera_rota"],
)
async def test_un_aviso_de_stripe_mal_firmado_se_rechaza(entorno, caso):
    """Cinco formas de llegar sin firma valida. Las cinco se rechazan.

    Y ninguna concede: se comprueba DESPUES de cada intento, porque rechazar con
    un 4xx y haber escrito el derecho por el camino seria el mismo agujero con
    mejor cara.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    pedido = (
        await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})
    ).json()["purchase_id"]

    evento = _sesion_pagada(order_id=pedido, importe=PRECIO_A)
    crudo = json.dumps(evento).encode("utf-8")

    if caso == "sin_cabecera":
        firma, cuerpo = None, crudo
    elif caso == "otro_secreto":
        firma, cuerpo = _firmar(crudo, secreto="whsec_del_atacante"), crudo
    elif caso == "caducada":
        firma, cuerpo = _firmar(crudo, marca=time.time() - 3600), crudo
    elif caso == "cuerpo_cambiado":
        firma = _firmar(crudo)
        cuerpo = json.dumps(
            _sesion_pagada(order_id=pedido, importe=1, event_id="evt_otro")
        ).encode("utf-8")
    else:
        firma, cuerpo = "v1=deadbeef", crudo

    respuesta = await _avisar(entorno.http, evento, firma=firma, cuerpo=cuerpo)
    assert respuesta.status_code == 422, respuesta.text
    assert await _cuantos(entorno.sesiones, Entitlement) == 0
    assert await _cuantos(entorno.sesiones, PaymentEvent) == 0
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False


# =========================================================================== #
# 14. Quien ya tenia acceso no lo pierde
# =========================================================================== #
@pytest.mark.asyncio
async def test_la_compra_vieja_sigue_abriendo_el_curso(entorno):
    """Una fila en `purchases` en 'paid' y ningun derecho. Entra igual.

    Es LA regla del trasvase de la 0036, y la unica que no se puede negociar:
    quien tenia acceso antes lo conserva despues. Se comprueban los dos
    endpoints y la biblioteca, que son los tres sitios donde se notaria.
    """
    entorno.como(BRUNO)
    async with entorno.sesiones() as db:
        db.add(
            Purchase(
                user_id=BRUNO,
                course_id=CURSO_A,
                provider="web",
                amount_minor=PRECIO_A,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    acceso = await _acceso(entorno.http, CURSO_A)
    assert acceso["has_access"] is True
    assert acceso["reason"] == "comprado"

    ficha = (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()
    assert ficha["has_access"] is True
    rutas = {
        leccion["id"]: leccion["media_path"]
        for modulo in ficha["modules"]
        for leccion in modulo["lessons"]
    }
    assert rutas[LECCION_PRIVADA] == RUTA_PRIVADA
    assert [c["id"] for c in (await entorno.http.get(f"{LEARNING}/me/courses")).json()] == [
        CURSO_A
    ]


@pytest.mark.asyncio
async def test_una_compra_a_medias_no_abre_nada(entorno):
    """'pending' no es 'paid'. Un cobro iniciado y no completado no da derecho."""
    entorno.como(BRUNO)
    async with entorno.sesiones() as db:
        db.add(
            Purchase(
                user_id=BRUNO,
                course_id=CURSO_A,
                provider="web",
                amount_minor=PRECIO_A,
                currency="PEN",
                status="pending",
            )
        )
        await db.commit()
    assert (await _acceso(entorno.http, CURSO_A))["has_access"] is False
    assert (await entorno.http.get(f"{LEARNING}/courses/{CURSO_A}")).json()[
        "has_access"
    ] is False


# =========================================================================== #
# El patron que ya ha llegado tres veces a produccion
# =========================================================================== #
def test_el_rol_de_la_aplicacion_nunca_se_lee_del_token():
    """`role` en el JWT de Supabase vale SIEMPRE 'authenticated'.

    El rol de la aplicacion vive en `profiles.role` y hay que consultarlo con
    `app.shared.permissions.is_admin()`. Comprobarlo contra el token no se
    cumple nunca, asi que la administracion se queda fuera de lo suyo y el fallo
    no da error: simplemente la rama no entra. Ya ha llegado a produccion tres
    veces (`full_name`, `is_admin`, `role`), y por eso se vigila con una prueba
    en vez de con una nota.
    """
    raiz = Path(__file__).resolve().parents[1] / "app"
    culpables: list[str] = []
    for fichero in raiz.rglob("*.py"):
        for numero, linea in enumerate(
            fichero.read_text(encoding="utf-8").splitlines(), 1
        ):
            codigo = linea.split("#")[0]
            if re.search(
                r"(current_user|usuario|user)\.role\b\s*(or\b|\)|\s)*\s*(in|==)", codigo
            ) or re.search(r"\.role\b[^=]*\bin\s+\w*ADMIN", codigo):
                culpables.append(f"{fichero.relative_to(raiz)}:{numero}: {linea.strip()}")
    assert not culpables, (
        "Se decide un permiso con el `role` del token, que siempre vale "
        "'authenticated'. Usa `await is_admin(db, user_id)`:\n" + "\n".join(culpables)
    )


@pytest.mark.asyncio
async def test_un_aviso_que_falla_al_aplicarse_conserva_su_registro(entorno, monkeypatch):
    """Si aplicar el aviso revienta, la fila del aviso TIENE que sobrevivir.

    EL FALLO QUE ESTO CAZA. La fila de `payment_events` se escribe en la misma
    transaccion que aplica el aviso, y todavia sin confirmar. El manejador de
    error hacia `rollback` antes de anotar el fallo —para que en PostgreSQL la
    transaccion no quedara abortada— y con ese rollback se llevaba por delante
    la propia fila: el `UPDATE` posterior no encontraba nada que marcar y el
    registro anti-repeticion desaparecia. Ademas leia `_fila.id` DESPUES del
    rollback, sobre un objeto ya caducado, que en asincrono lanza
    `MissingGreenlet` y enmascaraba el error de verdad.

    Ahora lo que se deshace es un SAVEPOINT: solo se cae lo que se intento
    aplicar, y queda constancia de que ese cobro llego y no concedio nada.
    """
    await _dar_de_alta(
        entorno.sesiones, curso=CURSO_A, provider="stripe", external="price_a"
    )
    pedido = (
        await entorno.http.post(f"{PAGOS}/stripe/checkout", json={"course_id": CURSO_A})
    ).json()["purchase_id"]

    async def _reventar(*_args, **_kwargs):
        raise RuntimeError("el saldo del propietario no se pudo escribir")

    monkeypatch.setattr(router_de_pagos, "_al_confirmar_la_compra", _reventar)

    evento = _sesion_pagada(order_id=pedido, importe=PRECIO_A)
    crudo = json.dumps(evento).encode("utf-8")
    with pytest.raises(RuntimeError):
        await _avisar(entorno.http, evento, firma=_firmar(crudo), cuerpo=crudo)

    async with entorno.sesiones() as db:
        aviso = await db.scalar(select(PaymentEvent))
        # La fila sigue ahi: es lo que impide que un reenvio del mismo aviso se
        # tome por nuevo, y lo unico que deja saber que hubo un cobro.
        assert aviso is not None
        assert aviso.external_event_id == evento["id"]
        assert aviso.processed_at is not None
        assert "no se pudo escribir" in (aviso.error or "")
