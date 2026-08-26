"""La aplicacion tiene que funcionar SIN las migraciones 0035 y 0036.

MISMA LECCION QUE LA 0027, LA 0028 Y LA 0029, Y FUE CARA. Se escribio codigo
contra un esquema que todavia esperaba aprobacion y la rama entera dejo de
funcionar contra la base real: cada peticion que tocaba la tabla que faltaba
reventaba con un 500 que el navegador reportaba como error de CORS, porque
Starlette NO añade cabeceras CORS a una respuesta que sale de una excepcion sin
capturar. Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta, y una vuelta atras no puede tumbar la aplicacion.

QUE CAMBIA SIN LA 0035:

- El acceso se decide EXACTAMENTE como hoy: curso gratuito, autor,
  administracion o fila en `purchases` en 'paid'. Nadie pierde su curso.
- No hay productos: preguntar por el de un curso responde `None`, que es la
  verdad —ese curso no esta a la venta— y no un error.
- Conceder, revocar, crear ordenes y registrar cobros responden 503 con
  `commerce_not_available`. 503 y no 404: la funcion existe, lo que falta es
  que este montada. Un 404 haria pensar que la ruta esta mal escrita.
- Matricular devuelve `False` y sigue. Es cosmetico —pone el curso en «mis
  cursos»— y no puede impedir nada.

Y SIN LA 0034 no hay `is_preview`: una leccion vale lo que vale su curso, que
es lo que pasa hoy. Lo que NO puede pasar es que preguntar por una columna
inexistente tumbe la comprobacion de acceso y deje sin ver su curso a quien lo
compro.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITAN las siete
tablas del comercio, dejando la base exactamente como esta hoy en produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import ServiceUnavailableError
from app.modules.catalog.models import Course
from app.modules.commerce import esquema, service
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"

CURSO_DE_PAGO = "cccccccc-0000-0000-0000-000000000001"
CURSO_GRATIS = "cccccccc-0000-0000-0000-000000000002"
MODULO = "dddddddd-0000-0000-0000-000000000001"
LECCION = "eeeeeeee-0000-0000-0000-000000000001"

#: Un producto que no existe porque no puede existir: sin tablas no hay
#: ninguno. Tiene que ser un uuid valido para que lo que se compruebe sea la
#: falta de esquema y no la validacion del identificador.
PRODUCTO = "ffffffff-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def sesiones():
    """El esquema tal y como esta HOY: sin las tablas del comercio."""
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Y ahora se DESHACE la 0035, que es lo que se quiere probar. En este
        # orden para no dejar referencias colgando.
        for tabla in (
            "entitlements",
            "payment_transactions",
            "payment_events",
            "orders",
            "provider_products",
            "course_enrollments",
            "commerce_products",
        ):
            await conn.execute(text(f"drop table {tabla}"))
        # La 0034 tampoco esta: `course_lessons` no tiene `is_preview`.

    fabrica = async_sessionmaker(engine, expire_on_commit=False)
    async with fabrica() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=JEFA, full_name="Jefa", username="jefa", role="admin"))
        db.add(
            Course(
                id=CURSO_DE_PAGO,
                author_id=BRUNO,
                title="Curso de pago",
                price_minor=29700,
                currency="PEN",
                status="published",
            )
        )
        db.add(
            Course(
                id=CURSO_GRATIS,
                author_id=BRUNO,
                title="Curso gratis",
                price_minor=0,
                currency="PEN",
                status="published",
            )
        )
        db.add(CourseModule(id=MODULO, course_id=CURSO_DE_PAGO, title="Modulo 1"))
        db.add(CourseLesson(id=LECCION, module_id=MODULO, title="Leccion"))
        await db.commit()

    esquema.olvidar()
    yield fabrica
    esquema.olvidar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# El acceso sigue funcionando: nadie pierde su curso
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_gratuito_se_sigue_viendo(sesiones):
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_GRATIS
        )
    assert acceso == service.Acceso(True, service.GRATUITO)


@pytest.mark.asyncio
async def test_quien_compro_sigue_entrando(sesiones):
    """LA prueba de esta suite: sin el comercio, `purchases` es lo unico que
    hay, y tiene que bastar."""
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=29700,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso == service.Acceso(True, service.COMPRA_HEREDADA)


@pytest.mark.asyncio
async def test_el_autor_y_la_administracion_tampoco_pierden_nada(sesiones):
    async with sesiones() as db:
        autor = await service.resolver_acceso_al_curso(
            db, user_id=BRUNO, course_id=CURSO_DE_PAGO
        )
        jefa = await service.resolver_acceso_al_curso(
            db, user_id=JEFA, course_id=CURSO_DE_PAGO
        )
    assert autor == service.Acceso(True, service.AUTOR)
    assert jefa == service.Acceso(True, service.ADMINISTRACION)


@pytest.mark.asyncio
async def test_sin_comprar_no_hay_acceso_y_no_revienta(sesiones):
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso.tiene_acceso is False


@pytest.mark.asyncio
async def test_una_leccion_vale_lo_que_vale_su_curso(sesiones):
    """Sin la 0034 no hay muestras, y preguntar por `is_preview` reventaria.

    El acceso a la leccion cae al del curso, que es lo que hace la aplicacion
    hoy.
    """
    async with sesiones() as db:
        sin_comprar = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id=LECCION
        )
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=29700,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        comprado = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id=LECCION
        )
    assert sin_comprar.tiene_acceso is False
    assert comprado == service.Acceso(True, service.COMPRA_HEREDADA)


@pytest.mark.asyncio
async def test_cursos_con_acceso_responde_con_lo_que_hay(sesiones):
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=29700,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        cursos = await service.cursos_con_acceso(db, user_id=ANA)
    assert cursos == [CURSO_DE_PAGO]


# --------------------------------------------------------------------------- #
# Lo que todavia no se puede hacer, dicho con un 503 y no con un 500
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_hay_productos_y_eso_no_es_un_error(sesiones):
    """`None` significa «no esta a la venta por aqui», y la interfaz lo DICE.
    Es la regla 6 del contrato: nunca un boton muerto."""
    async with sesiones() as db:
        assert await service.producto_de_curso(db, CURSO_DE_PAGO) is None
        assert (
            await service.producto_de_tienda(
                db, course_id=CURSO_DE_PAGO, provider="apple"
            )
            is None
        )


@pytest.mark.asyncio
async def test_matricular_no_pasa_nada_y_sigue(sesiones):
    """La matricula es cosmetica. Que falte no puede impedir nada."""
    async with sesiones() as db:
        assert await service.matricular(
            db, user_id=ANA, course_id=CURSO_GRATIS, source="free"
        ) is False


@pytest.mark.asyncio
async def test_todo_lo_que_escribe_responde_503_y_no_500(sesiones):
    """Ninguna de estas puede acabar en una excepcion sin capturar: el 500 sale
    sin cabeceras CORS y el fallo de esquema se disfraza de fallo de red."""
    async with sesiones() as db:
        llamadas = [
            service.asegurar_producto_de_curso(db, course_id=CURSO_DE_PAGO),
            service.crear_orden(
                db,
                user_id=ANA,
                commerce_product_id=PRODUCTO,
                provider="stripe",
                channel="web",
            ),
            service.marcar_orden(db, order_id=PRODUCTO, status="paid"),
            service.registrar_transaccion(
                db,
                provider="apple",
                environment="production",
                external_transaction_id="tx-1",
            ),
            service.registrar_evento(
                db, provider="apple", external_event_id="evt-1", event_type="BUY"
            ),
            service.marcar_evento_procesado(db, event_id=PRODUCTO),
            service.conceder_entitlement(
                db, user_id=ANA, commerce_product_id=PRODUCTO
            ),
            service.revocar_entitlement(
                db, user_id=ANA, commerce_product_id=PRODUCTO
            ),
        ]
        for llamada in llamadas:
            with pytest.raises(ServiceUnavailableError) as fallo:
                await llamada
            assert fallo.value.code == "commerce_not_available"
            assert fallo.value.status_code == 503


@pytest.mark.asyncio
async def test_cerrar_una_compra_vieja_si_funciona_sin_el_comercio(sesiones):
    """Es la unica escritura que NO depende de la 0035, y tiene que serlo:
    `purchases` existe desde la 0001 y un reembolso no puede quedar bloqueado
    esperando a que se apruebe una migracion."""
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=29700,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        assert (
            await service.revocar_compra_heredada(
                db, user_id=ANA, course_id=CURSO_DE_PAGO
            )
            == 1
        )
        await db.commit()
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso.tiene_acceso is False


# --------------------------------------------------------------------------- #
# El coste de comprobarlo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_esquema_se_detecta_una_sola_vez(sesiones):
    """No puede costar una consulta por peticion: se mira una vez por proceso y
    se recuerda. Por eso las 0035/0036 piden REINICIAR la API despues."""
    async with sesiones() as db:
        esquema.olvidar()
        await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        assert esquema._cache.get("entitlements") is False
        await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        assert esquema._cache.get("entitlements") is False


@pytest.mark.asyncio
async def test_la_limpieza_de_la_suite_tambien_vacia_esta_memoria(sesiones):
    """El cache se comparte con `recommendations.esquema` a proposito.

    El `conftest.py` ya lo vacia antes de CADA prueba. Con un diccionario propio
    quedaria fuera de esa limpieza, y bastaria que una prueba con las tablas
    puestas corriera antes que una sin ellas para que la segunda diera por bueno
    un esquema que no tiene.
    """
    from app.modules.recommendations import esquema as esquema_de_recomendaciones

    async with sesiones() as db:
        await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert "entitlements" in esquema_de_recomendaciones._cache
    esquema_de_recomendaciones.olvidar()
    assert "entitlements" not in esquema._cache
