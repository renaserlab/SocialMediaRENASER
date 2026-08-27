"""La Beta gratuita: conceder sin cobrar, y que se note que no se cobro.

EL RIESGO QUE VIGILAN ESTAS PRUEBAS. Durante la beta no hay pasarela y el
licenciado decidio que lo que despues se cobrara sea gratis para quien prueba.
La forma facil de hacerlo —una compra de importe cero, una orden en 'paid', una
transaccion inventada— deja en la base una MENTIRA CONTABLE que sobrevive a la
beta y que alguien tiene que desenredar mas tarde, con dinero real de por medio.
Por eso aqui no se comprueba solo que el acceso funcione: se comprueba, tabla
por tabla, que NO hay ni un apunte de cobro.

LO QUE SE FIJA:

1. Conceder NO escribe en `payment_transactions`, ni en `orders`, ni en
   `payment_events`, ni en `purchases`. Ni una fila.
2. El derecho se distingue de una compra PARA SIEMPRE: `source_provider` vale
   'beta_free' y `transaction_id` es NULO, porque no hubo cobro que apuntar.
3. Repetir la operacion deja UN derecho, no dos. Lo garantiza el indice unico
   parcial de la base, no un `if`.
4. `price_minor` no se toca: el curso sigue costando lo que cuesta.
5. Con el interruptor APAGADO no se concede nada.
6. Apagarlo NO revoca lo ya concedido.
7. El acceso vive en el SERVIDOR: la misma cuenta lo tiene desde otro
   dispositivo sin restaurar nada.
8. Stripe y RevenueCat siguen apagados por defecto en el codigo.
"""

from __future__ import annotations

import inspect as inspeccion_de_codigo
import re
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.commerce import service as comercio
from app.modules.commerce.models import (
    CourseEnrollment,
    Entitlement,
    Order,
    PaymentEvent,
    PaymentTransaction,
)
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

LEARNING = "/api/v1/learning"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
AUTORA = "aaaaaaaa-0000-0000-0000-000000000002"

CURSO_DE_PAGO = "cccccccc-0000-0000-0000-000000000001"
CURSO_GRATIS = "cccccccc-0000-0000-0000-000000000002"

PRECIO = 29700

MIGRACION_0036 = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "0036_acceso_v2.sql"
)


@pytest_asyncio.fixture
async def entorno():
    """Una base con un curso de pago, su autora y alguien que no ha pagado.

    El interruptor se enciende aqui y se DEVUELVE a su valor anterior al
    terminar: `get_settings()` esta cacheado y es el mismo objeto para toda la
    suite, asi que dejarlo encendido contagiaria a las demas pruebas.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.commerce import models as _cm  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=AUTORA, full_name="Autora", username="autora"))
        for curso_id, precio, titulo in (
            (CURSO_DE_PAGO, PRECIO, "Curso de pago"),
            (CURSO_GRATIS, 0, "Curso gratis"),
        ):
            db.add(
                Course(
                    id=curso_id,
                    author_id=AUTORA,
                    title=titulo,
                    description="Una descripción larga de verdad.",
                    price_minor=precio,
                    currency="PEN",
                    status="published",
                )
            )
        await db.flush()
        modulo = CourseModule(course_id=CURSO_DE_PAGO, title="Módulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id,
                title="Lección 1",
                duration_seconds=900,
                sort_order=0,
                media_path="curso/leccion-1.mp4",
            )
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    ajustes = get_settings()
    anterior = ajustes.beta_free_access_enabled
    ajustes.beta_free_access_enabled = True

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad, ajustes
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    ajustes.beta_free_access_enabled = anterior
    await engine.dispose()


async def _contar(sesiones, entidad) -> int:
    async with sesiones() as db:
        return int(
            await db.scalar(select(func.count()).select_from(entidad.__table__)) or 0
        )


# --------------------------------------------------------------------------- #
# 1. Ni un apunte de cobro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_concesion_no_crea_ningun_pago_falso(entorno):
    """LA PRUEBA QUE MAS IMPORTA. Nada de esto ocurrio, asi que nada se escribe.

    Se miran las CUATRO tablas donde podria colarse un cobro inventado, no solo
    `payment_transactions`: una orden en 'paid' o una fila en `purchases` con
    importe cero mienten exactamente igual, y la segunda ademas concede acceso
    por una via que no es la suya.
    """
    http, sesiones, _, _ = entorno
    respuesta = await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")
    assert respuesta.status_code == 200
    assert respuesta.json()["granted"] is True

    assert await _contar(sesiones, PaymentTransaction) == 0
    assert await _contar(sesiones, Order) == 0
    assert await _contar(sesiones, PaymentEvent) == 0
    assert await _contar(sesiones, Purchase) == 0


@pytest.mark.asyncio
async def test_el_derecho_dice_que_fue_un_regalo_de_la_beta(entorno):
    """La concesion tiene que ser distinguible de una compra PARA SIEMPRE.

    `source_provider` no es una pasarela y `transaction_id` es nulo: quien
    cuadre cuentas dentro de un ano separa lo regalado de lo cobrado con una
    sola consulta, sin tener que reconstruir nada.
    """
    http, sesiones, _, _ = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    async with sesiones() as db:
        derecho = await db.scalar(select(Entitlement))
    assert derecho is not None
    assert derecho.source_provider == comercio.BETA_GRATIS == "beta_free"
    assert derecho.transaction_id is None
    assert derecho.status == "active"
    # Nunca el nombre de una tienda: eso significaria que alguien pago.
    assert derecho.source_provider not in {"stripe", "apple", "google", "revenuecat"}


@pytest.mark.asyncio
async def test_tambien_se_asegura_la_matricula(entorno):
    """El curso tiene que salir en la biblioteca, no solo estar accesible."""
    http, sesiones, _, _ = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    async with sesiones() as db:
        matricula = await db.scalar(select(CourseEnrollment))
    assert matricula is not None
    assert matricula.course_id == CURSO_DE_PAGO
    assert matricula.source == "entitlement"

    biblioteca = await http.get(f"{LEARNING}/me/courses")
    assert biblioteca.status_code == 200
    assert [c["id"] for c in biblioteca.json()] == [CURSO_DE_PAGO]


# --------------------------------------------------------------------------- #
# 2. Idempotencia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_repetir_la_concesion_no_duplica_el_derecho(entorno):
    """Un solo derecho activo por mucho que se insista.

    No lo garantiza un `if ya existe` —dos peticiones simultaneas lo pasarian
    las dos— sino el indice unico parcial `entitlements_activo_unico`. Por eso
    la prueba llama de verdad tres veces contra una base de verdad.
    """
    http, sesiones, _, _ = entorno
    respuestas = [
        await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")
        for _ in range(3)
    ]
    assert [r.status_code for r in respuestas] == [200, 200, 200]
    assert [r.json()["already_granted"] for r in respuestas] == [False, True, True]

    assert await _contar(sesiones, Entitlement) == 1
    assert await _contar(sesiones, CourseEnrollment) == 1


# --------------------------------------------------------------------------- #
# 3. El precio no se toca
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_concesion_no_cambia_el_precio_del_curso(entorno):
    """Regalar el acceso no es poner el curso a cero.

    Si se tocara `price_minor`, al apagar la beta el curso seguiria siendo
    gratis para TODO EL MUNDO por la primera via de acceso, y nadie se daria
    cuenta hasta ver la facturacion.
    """
    http, sesiones, _, _ = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    async with sesiones() as db:
        curso = await db.get(Course, CURSO_DE_PAGO)
    assert curso is not None
    assert curso.price_minor == PRECIO
    assert curso.currency == "PEN"


# --------------------------------------------------------------------------- #
# 4. El interruptor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_apagado_no_se_concede_nada(entorno):
    """Con el modo apagado, un curso de pago se paga."""
    http, sesiones, _, ajustes = entorno
    ajustes.beta_free_access_enabled = False

    respuesta = await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")
    assert respuesta.status_code == 403
    assert respuesta.json()["error"]["code"] == "beta_free_access_disabled"
    assert await _contar(sesiones, Entitlement) == 0

    ficha = await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")
    assert ficha.json()["has_access"] is False


@pytest.mark.asyncio
async def test_apagar_el_modo_no_revoca_lo_ya_concedido(entorno):
    """El rollback no puede quitarle el curso a quien ya lo tenia.

    `has_course_access()` no pregunta de donde viene un derecho: mira que este
    activo. Por eso apagar el interruptor cierra la puerta a los nuevos y no
    toca a los de dentro.
    """
    http, sesiones, _, ajustes = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    ajustes.beta_free_access_enabled = False

    ficha = await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")
    assert ficha.json()["has_access"] is True

    async with sesiones() as db:
        acceso = await comercio.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        derecho = await db.scalar(select(Entitlement))
    assert acceso == comercio.Acceso(True, comercio.ENTITLEMENT)
    assert derecho is not None
    assert derecho.status == "active"
    assert derecho.revoked_at is None

    biblioteca = await http.get(f"{LEARNING}/me/courses")
    assert [c["id"] for c in biblioteca.json()] == [CURSO_DE_PAGO]


@pytest.mark.asyncio
async def test_la_pantalla_pregunta_al_servidor_si_hay_beta(entorno):
    """El interruptor vive en el servidor y la ficha lo refleja.

    Asi apagarlo hace desaparecer el boton sin publicar una version nueva de la
    aplicacion, y un curso gratuito nunca lo ofrece: no hay nada que conceder.
    """
    http, _, _, ajustes = entorno

    estado = (await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")).json()
    assert estado == {"enabled": True, "available": True, "has_access": False}

    gratis = (await http.get(f"{LEARNING}/courses/{CURSO_GRATIS}/beta-access")).json()
    assert gratis["available"] is False
    rechazo = await http.post(f"{LEARNING}/courses/{CURSO_GRATIS}/beta-access")
    assert rechazo.status_code == 422
    assert rechazo.json()["error"]["code"] == "course_is_free"

    ajustes.beta_free_access_enabled = False
    apagado = (await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")).json()
    assert apagado == {"enabled": False, "available": False, "has_access": False}


# --------------------------------------------------------------------------- #
# 5. El acceso vive en el servidor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_acceso_se_tiene_desde_otro_dispositivo(entorno):
    """Otro telefono, la misma cuenta, y el curso esta ahi.

    Es lo que arregla que la biblioteca saliera de una lista guardada en el
    movil: lo que una persona tiene es un hecho del servidor. Aqui se concede
    desde un cliente y se lee desde OTRO, sin restaurar nada y sin que el
    segundo haya llamado jamas a conceder.
    """
    http, _, _, _ = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://otro-telefono"
    ) as otro:
        ficha = await otro.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")
        biblioteca = await otro.get(f"{LEARNING}/me/courses")

    assert ficha.json()["has_access"] is True
    assert [c["id"] for c in biblioteca.json()] == [CURSO_DE_PAGO]


@pytest.mark.asyncio
async def test_el_derecho_es_de_quien_lo_pidio_y_de_nadie_mas(entorno):
    """Regalar durante la beta no es abrir el curso a todo el mundo."""
    http, _, identidad, _ = entorno
    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    identidad["uid"] = "aaaaaaaa-0000-0000-0000-000000000009"
    ficha = await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")
    assert ficha.json()["has_access"] is False


@pytest.mark.asyncio
async def test_tras_la_concesion_se_puede_ver_y_guardar_progreso(entorno):
    """`has_course_access()` en verde: se entrega el video y se acepta el avance.

    Guardar progreso exige acceso al curso (`course_access_required`), asi que
    esta prueba comprueba de paso que la concesion abre las dos puertas: la de
    leer el contenido y la de escribir el avance.
    """
    http, _, _, _ = entorno
    ficha_antes = (await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")).json()
    leccion = ficha_antes["modules"][0]["lessons"][0]
    assert ficha_antes["has_access"] is False
    # Sin acceso no se entrega ni la RUTA del video.
    assert leccion["media_path"] is None

    await http.post(f"{LEARNING}/courses/{CURSO_DE_PAGO}/beta-access")

    ficha = (await http.get(f"{LEARNING}/courses/{CURSO_DE_PAGO}")).json()
    assert ficha["has_access"] is True
    assert ficha["modules"][0]["lessons"][0]["media_path"] == "curso/leccion-1.mp4"

    avance = await http.put(
        f"{LEARNING}/lessons/{leccion['id']}/progress",
        json={"progress_seconds": 300},
    )
    assert avance.status_code == 200
    assert avance.json()["progress_seconds"] == 300


# --------------------------------------------------------------------------- #
# 6. Nada de esto enciende una pasarela
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "bandera",
    [
        "payments_enabled",
        "stripe_payments_enabled",
        "revenuecat_verification_enabled",
        "revenuecat_webhook_enabled",
        # El propio modo de beta: el valor seguro es APAGADO. Encendido regala
        # el catalogo, y un interruptor que nace encendido acaba encendido en
        # produccion el dia que alguien despliegue sin poner la variable.
        "beta_free_access_enabled",
    ],
)
def test_las_pasarelas_siguen_apagadas_en_el_codigo(bandera):
    """El DEFECTO EN CODIGO, no lo que diga el `.env` de esta maquina.

    Se mira `model_fields` a proposito: `get_settings()` esta cacheado y las
    pruebas lo mutan, asi que leer la instancia probaria el estado de la suite y
    no la decision que se tomo al escribir la configuracion.
    """
    assert Settings.model_fields[bandera].default is False


def test_la_beta_no_toca_ninguna_pasarela():
    """Conceder no pasa por Stripe, ni por RevenueCat, ni por las tiendas.

    El endpoint concede con `conceder_entitlement` y punto: ni cobra, ni
    registra transacciones, ni marca ordenes. Si algun dia alguien le enchufa un
    proveedor o un apunte de cobro, esta prueba lo dice.
    """
    from app.modules.learning import router as learning_router

    fuente = inspeccion_de_codigo.getsource(learning_router.grant_beta_access)
    for prohibido in (
        "stripe",
        "Stripe",
        "revenuecat",
        "RevenueCat",
        "registrar_transaccion",
        "marcar_orden",
        "crear_orden",
        "Purchase",
    ):
        assert prohibido not in fuente, f"La beta no puede tocar {prohibido}"
    assert "conceder_entitlement" in fuente
    assert "BETA_GRATIS" in fuente


def test_la_base_de_datos_da_acceso_por_el_derecho_sin_mirar_su_origen():
    """Lo que sostiene que apagar el interruptor no revoque nada.

    Quien manda sobre los ARCHIVOS es `has_course_access()` en PostgreSQL. Si su
    via de derechos filtrara por `source_provider`, un derecho de beta no
    abriria el video por mucho que la aplicacion dijera que si —el desacuerdo
    que corrigio la 0016— y bastaria retocar esa lista para dejar sin curso a
    quien lo recibio.
    """
    sql = MIGRACION_0036.read_text(encoding="utf-8")
    via = re.search(
        r"from public\.entitlements e.*?cp\.course_id = c\.id", sql, re.DOTALL
    )
    assert via is not None, "No se encuentra la via de derechos en la 0036"
    assert "source_provider" not in via.group(0)
    assert "e.status = 'active'" in via.group(0)
