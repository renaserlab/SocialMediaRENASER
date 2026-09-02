"""El comercio: quien tiene acceso, quien lo concede y que pasa si se repite.

ESTA ES LA RUTA MAS CRITICA DE LA APLICACION. Un fallo aqui no deja una
pantalla en blanco: regala el catalogo, o se lo quita a quien pago.

Lo que se fija:

1. Un derecho activo da acceso a un curso de pago; revocarlo lo quita.
2. **Quien tenia acceso ANTES lo conserva DESPUES.** El trasvase no puede
   quitarle su curso a nadie: `purchases` sigue consultandose.
3. Repetir un aviso NO duplica nada, y no lo garantiza un `if` de Python sino
   los indices unicos de la base. Por eso las pruebas insertan dos veces de
   verdad, contra una base de verdad, en lugar de comprobar que existe un `if`.
4. El importe de una orden lo pone el SERVIDOR. `crear_orden` ni siquiera
   acepta un parametro de importe.
5. Una leccion de muestra se ve sin comprar; el resto del curso, no.

Las pruebas corren sobre SQLite en memoria, que respeta los indices unicos
parciales y los CHECK igual que PostgreSQL. Los CHECK y los indices se declaran
en los modelos justamente para eso: si solo estuvieran en el SQL de la
migracion, estas pruebas pasarian por casualidad y no probarian nada.
"""

from __future__ import annotations

import inspect as inspeccion_de_codigo

import pytest
import pytest_asyncio
from sqlalchemy import (
    Boolean,
    Column,
    MetaData,
    Table,
    Uuid,
    func,
    inspect,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.catalog.models import Course
from app.modules.commerce import esquema, service
from app.modules.commerce.models import (
    CommerceProduct,
    CourseEnrollment,
    Entitlement,
    PaymentEvent,
    PaymentTransaction,
)
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"

CURSO_DE_PAGO = "cccccccc-0000-0000-0000-000000000001"
CURSO_GRATIS = "cccccccc-0000-0000-0000-000000000002"
MODULO = "dddddddd-0000-0000-0000-000000000001"
LECCION_PRIVADA = "eeeeeeee-0000-0000-0000-000000000001"
LECCION_DE_MUESTRA = "eeeeeeee-0000-0000-0000-000000000002"

PRECIO = 29700

#: `course_lessons` con la columna que anade la 0034, tipada.
#:
#: NO se marca la muestra con `text("update ... where id = 'eeee-...'")`, y la
#: razon merece quedar escrita: `Uuid(as_uuid=False)` guarda los identificadores
#: en SQLite como 32 caracteres hexadecimales SIN GUIONES. Una comparacion en
#: SQL crudo contra el uuid con guiones no casa con NADA, no falla, y deja la
#: prueba «pasando» sobre datos que no se prepararon. Con la columna tipada, es
#: SQLAlchemy quien convierte, y funciona igual en SQLite y en PostgreSQL.
_lecciones = Table(
    "course_lessons",
    MetaData(),
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("is_preview", Boolean),
)


async def _anadir_is_preview(conn) -> None:
    """Simula la 0034 sobre la base de pruebas.

    El modelo de lecciones lo mantiene otro modulo y todavia puede no tener la
    columna. Se comprueba antes de anadirla para que esta prueba siga valiendo
    el dia que si la tenga: repetir el `alter table` fallaria.
    """
    columnas = await conn.run_sync(
        lambda sync: [c["name"] for c in inspect(sync).get_columns("course_lessons")]
    )
    if "is_preview" not in columnas:
        await conn.execute(
            text(
                "alter table course_lessons "
                "add column is_preview boolean not null default 0"
            )
        )


@pytest_asyncio.fixture
async def sesiones():
    """Una base con curso de pago, curso gratis, una leccion privada y una muestra."""
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _anadir_is_preview(conn)

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
                price_minor=PRECIO,
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
        db.add(
            CourseLesson(
                id=LECCION_PRIVADA,
                module_id=MODULO,
                title="Leccion de pago",
                media_path="curso/leccion-privada.mp4",
            )
        )
        db.add(
            CourseLesson(
                id=LECCION_DE_MUESTRA,
                module_id=MODULO,
                title="Muestra",
                media_path="curso/muestra.mp4",
            )
        )
        await db.commit()
        await db.execute(
            update(_lecciones)
            .where(_lecciones.c.id == LECCION_DE_MUESTRA)
            .values(is_preview=True)
        )
        await db.commit()

    esquema.olvidar()
    yield fabrica
    esquema.olvidar()
    await engine.dispose()


async def _producto(db) -> str:
    producto = await service.asegurar_producto_de_curso(db, course_id=CURSO_DE_PAGO)
    return producto.id


# --------------------------------------------------------------------------- #
# Las cinco vias de acceso
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_gratuito_lo_ve_cualquiera(sesiones):
    """La via mas facil de perder de vista y la que mas daño hace perder.

    Sin ella, estrenar el muro de pago deja sin acceso a TODO EL MUNDO de golpe,
    porque el dia que se aplica no existe ni una fila de derechos.
    """
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_GRATIS
        )
    assert acceso == service.Acceso(True, service.GRATUITO)


@pytest.mark.asyncio
async def test_el_autor_entra_a_su_propio_material(sesiones):
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=BRUNO, course_id=CURSO_DE_PAGO
        )
    assert acceso == service.Acceso(True, service.AUTOR)


@pytest.mark.asyncio
async def test_la_administracion_entra_sin_comprar(sesiones):
    """El rol vive en `profiles.role`, NO en el token.

    En el JWT de Supabase `role` vale siempre "authenticated": leerlo de ahi
    hace que la rama no se cumpla jamas y la administracion vea "sin acceso"
    sobre un curso que la base de datos si le deja ver. Ya paso dos veces.
    """
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=JEFA, course_id=CURSO_DE_PAGO
        )
    assert acceso == service.Acceso(True, service.ADMINISTRACION)


@pytest.mark.asyncio
async def test_sin_nada_no_hay_acceso(sesiones):
    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso.tiene_acceso is False
    assert acceso.motivo == service.SIN_ACCESO


@pytest.mark.asyncio
async def test_un_entitlement_activo_da_acceso(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id, source_provider="apple"
        )
        await db.commit()

    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso == service.Acceso(True, service.ENTITLEMENT)


@pytest.mark.asyncio
async def test_revocar_el_entitlement_quita_el_acceso(sesiones):
    """Y deja rastro: la fila no se borra, se marca. Sin el rastro no se puede
    explicar despues por que alguien dejo de tener acceso."""
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()

    async with sesiones() as db:
        assert await service.revocar_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()

    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        revocado = await db.scalar(
            select(Entitlement).where(Entitlement.user_id == ANA)
        )
    assert acceso.tiene_acceso is False
    assert revocado is not None, "La fila del derecho NO se borra: se marca."
    assert revocado.status == "revoked"
    assert revocado.revoked_at is not None


@pytest.mark.asyncio
async def test_revocar_dos_veces_no_es_un_error(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        assert await service.revocar_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        assert not await service.revocar_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()


# --------------------------------------------------------------------------- #
# EL TRASVASE: quien tenia acceso antes lo conserva despues
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_compra_antigua_conserva_el_acceso(sesiones):
    """LA prueba del trasvase.

    Alguien que compro cuando solo existia `purchases` y a quien nadie ha
    trasvasado todavia SIGUE entrando. Es la razon entera de que la 0036
    conserve el respaldo a `purchases` en vez de sustituirlo.
    """
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=PRECIO,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
    assert acceso == service.Acceso(True, service.COMPRA_HEREDADA)


@pytest.mark.asyncio
async def test_trasvasar_no_le_quita_el_acceso_a_quien_ya_lo_tenia(sesiones):
    """Se comprueba ANTES y DESPUES, que es la unica forma de probarlo.

    Comprobar solo el despues no distingue «lo conservo» de «nunca lo tuvo».
    """
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=PRECIO,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        antes = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )

    # El trasvase: se le concede el derecho equivalente sin tocar `purchases`.
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id, source_provider="web"
        )
        await db.commit()

    async with sesiones() as db:
        despues = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        compras = await db.scalar(
            select(func.count()).select_from(Purchase).where(Purchase.user_id == ANA)
        )

    assert antes.tiene_acceso is True
    assert despues.tiene_acceso is True
    assert compras == 1, "El trasvase NO borra ni duplica filas de `purchases`."


@pytest.mark.asyncio
async def test_una_concesion_manual_se_matricula_y_sigue_entrando(sesiones):
    """Caso (a) del trasvase: `manual` con importe 0.

    No hubo compra, asi que NO se le inventa un derecho comprado: se le pone la
    matricula. Su acceso lo sostiene la fila de `purchases`, que es exactamente
    por lo que ese respaldo no se retira en la 0036.
    """
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="manual",
                amount_minor=0,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        assert await service.matricular(
            db, user_id=ANA, course_id=CURSO_DE_PAGO, source="legacy"
        )
        await db.commit()

    async with sesiones() as db:
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        matricula = await db.get(CourseEnrollment, (ANA, CURSO_DE_PAGO))
        derechos = await db.scalar(select(func.count()).select_from(Entitlement))

    assert acceso == service.Acceso(True, service.COMPRA_HEREDADA)
    assert matricula is not None and matricula.source == "legacy"
    assert derechos == 0, "Una concesion manual sin importe no inventa un cobro."


@pytest.mark.asyncio
async def test_revocar_el_derecho_no_basta_si_queda_la_compra_vieja(sesiones):
    """El precio de conservar el respaldo, dicho en voz alta.

    Un reembolso que solo revoca el derecho deja el acceso puesto, porque
    `purchases` sigue diciendo 'paid'. Por eso existe `revocar_compra_heredada`
    y por eso `resolver_acceso_al_curso` devuelve el motivo: para poder verlo.
    """
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_DE_PAGO,
                provider="web",
                amount_minor=PRECIO,
                currency="PEN",
                status="paid",
            )
        )
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id, source_provider="web"
        )
        await db.commit()

    async with sesiones() as db:
        await service.revocar_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()
        a_medias = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )

    assert a_medias == service.Acceso(True, service.COMPRA_HEREDADA)

    async with sesiones() as db:
        cerradas = await service.revocar_compra_heredada(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        await db.commit()
        final = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )
        sigue_la_fila = await db.scalar(
            select(func.count()).select_from(Purchase).where(Purchase.user_id == ANA)
        )

    assert cerradas == 1
    assert final.tiene_acceso is False
    assert sigue_la_fila == 1, "Cerrar una compra no la borra: cambia su estado."


# --------------------------------------------------------------------------- #
# IDEMPOTENCIA: la garantiza la base, no un `if`
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_deja_un_solo_derecho(sesiones):
    """Se concede DOS VECES de verdad, contra la base.

    Comprobar que el codigo tiene un `if` no probaria nada: dos peticiones
    simultaneas pasan las dos por el `if`. Lo que se prueba es que la segunda
    insercion choca contra `entitlements_activo_unico` y no crea nada.
    """
    async with sesiones() as db:
        producto_id = await _producto(db)
        _, primera = await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id, source_provider="apple"
        )
        _, segunda = await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id, source_provider="apple"
        )
        await db.commit()
        cuantos = await db.scalar(select(func.count()).select_from(Entitlement))

    assert primera is True
    assert segunda is False, "El segundo aviso NO concede nada nuevo."
    assert cuantos == 1


@pytest.mark.asyncio
async def test_volver_a_comprar_despues_de_revocar_deja_el_historial(sesiones):
    """El indice unico es PARCIAL a proposito.

    Con un unique total, volver a comprar obligaria a borrar el derecho
    revocado, es decir, a borrar que aquello ocurrio. Asi hay dos filas: una
    revocada y una activa.
    """
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await service.revocar_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()
        total = await db.scalar(select(func.count()).select_from(Entitlement))
        activos = await db.scalar(
            select(func.count())
            .select_from(Entitlement)
            .where(Entitlement.status == "active")
        )
        acceso = await service.resolver_acceso_al_curso(
            db, user_id=ANA, course_id=CURSO_DE_PAGO
        )

    assert total == 2
    assert activos == 1
    assert acceso.tiene_acceso is True


@pytest.mark.asyncio
async def test_la_misma_transaccion_dos_veces_no_se_duplica(sesiones):
    async with sesiones() as db:
        fila_1, nueva_1 = await service.registrar_transaccion(
            db,
            provider="apple",
            environment="production",
            external_transaction_id="tx-1",
            amount_minor=PRECIO,
            currency="PEN",
        )
        fila_2, nueva_2 = await service.registrar_transaccion(
            db,
            provider="apple",
            environment="production",
            external_transaction_id="tx-1",
            amount_minor=PRECIO,
            currency="PEN",
        )
        await db.commit()
        cuantas = await db.scalar(select(func.count()).select_from(PaymentTransaction))

    assert nueva_1 is True and nueva_2 is False
    assert fila_1.id == fila_2.id
    assert cuantas == 1


@pytest.mark.asyncio
async def test_la_misma_transaccion_en_otro_entorno_si_es_otra(sesiones):
    """`sandbox` y `production` no se pisan.

    Sin la columna en el UNIQUE, una compra de prueba con el mismo
    identificador taparia una real, o al reves: concederia acceso de verdad.
    """
    async with sesiones() as db:
        _, nueva_prod = await service.registrar_transaccion(
            db,
            provider="apple",
            environment="production",
            external_transaction_id="tx-1",
        )
        _, nueva_sandbox = await service.registrar_transaccion(
            db, provider="apple", environment="sandbox", external_transaction_id="tx-1"
        )
        await db.commit()
        cuantas = await db.scalar(select(func.count()).select_from(PaymentTransaction))

    assert nueva_prod is True and nueva_sandbox is True
    assert cuantas == 2


@pytest.mark.asyncio
async def test_el_mismo_evento_dos_veces_no_se_vuelve_a_procesar(sesiones):
    """ANTI-REPLAY. Sin esto, quien intercepte un webhook lo reenvia a voluntad."""
    async with sesiones() as db:
        _, primero = await service.registrar_evento(
            db,
            provider="apple",
            external_event_id="evt-1",
            event_type="INITIAL_BUY",
            payload={"foo": "bar"},
        )
        _, repetido = await service.registrar_evento(
            db,
            provider="apple",
            external_event_id="evt-1",
            event_type="INITIAL_BUY",
            payload={"foo": "bar"},
        )
        await db.commit()
        cuantos = await db.scalar(select(func.count()).select_from(PaymentEvent))

    assert primero is True
    assert repetido is False, "Un aviso repetido NO se vuelve a aplicar."
    assert cuantos == 1


@pytest.mark.asyncio
async def test_el_aviso_se_guarda_en_crudo_y_se_puede_cerrar(sesiones):
    async with sesiones() as db:
        evento, _ = await service.registrar_evento(
            db,
            provider="stripe",
            external_event_id="evt-2",
            event_type="checkout.completed",
            payload={"amount": 29700, "raw": {"a": 1}},
        )
        await service.marcar_evento_procesado(db, event_id=evento.id)
        await db.commit()
        guardado = await db.get(PaymentEvent, evento.id)

    assert guardado is not None
    assert guardado.payload == {"amount": 29700, "raw": {"a": 1}}
    assert guardado.processed_at is not None
    assert guardado.error is None


@pytest.mark.asyncio
async def test_asegurar_el_producto_del_curso_es_idempotente(sesiones):
    """Dos productos «acceso permanente» del mismo curso darian dos derechos
    distintos sobre el mismo contenido y nadie sabria cual mirar."""
    async with sesiones() as db:
        uno = await service.asegurar_producto_de_curso(db, course_id=CURSO_DE_PAGO)
        otro = await service.asegurar_producto_de_curso(db, course_id=CURSO_DE_PAGO)
        await db.commit()
        cuantos = await db.scalar(select(func.count()).select_from(CommerceProduct))

    assert uno.id == otro.id
    assert cuantos == 1


@pytest.mark.asyncio
async def test_matricular_dos_veces_deja_una_matricula(sesiones):
    async with sesiones() as db:
        primera = await service.matricular(
            db, user_id=ANA, course_id=CURSO_GRATIS, source="free"
        )
        segunda = await service.matricular(
            db, user_id=ANA, course_id=CURSO_GRATIS, source="free"
        )
        await db.commit()
        cuantas = await db.scalar(select(func.count()).select_from(CourseEnrollment))

    assert primera is True and segunda is False
    assert cuantas == 1


@pytest.mark.asyncio
async def test_conceder_el_derecho_matricula_tambien(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()
        matricula = await db.get(CourseEnrollment, (ANA, CURSO_DE_PAGO))

    assert matricula is not None
    assert matricula.source == "entitlement"


# --------------------------------------------------------------------------- #
# El importe lo pone el servidor
# --------------------------------------------------------------------------- #
def test_crear_orden_no_acepta_un_importe():
    """No es que no lo use: es que NO EXISTE el parametro.

    Mientras exista, tarde o temprano alguien lo pasa desde un endpoint y un
    curso de 300 se compra por 1. Sin parametro no hay forma de equivocarse.
    """
    firma = inspeccion_de_codigo.signature(service.crear_orden)
    prohibidos = {"amount_minor", "amount", "price", "price_minor", "importe"}
    assert not (prohibidos & set(firma.parameters)), (
        f"`crear_orden` acepta un importe: {sorted(prohibidos & set(firma.parameters))}"
    )


@pytest.mark.asyncio
async def test_la_orden_congela_el_precio_del_curso(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        orden = await service.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto_id,
            provider="stripe",
            channel="web",
        )
        await db.commit()

    assert orden.amount_minor == PRECIO
    assert isinstance(orden.amount_minor, int), "El dinero nunca en coma flotante."
    assert orden.currency == "PEN"
    assert orden.status == "pending"
    assert orden.paid_at is None, "Crear la orden NO cobra ni concede nada."


@pytest.mark.asyncio
async def test_abrir_el_checkout_dos_veces_no_acumula_ordenes_muertas(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        una = await service.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto_id,
            provider="stripe",
            channel="web",
        )
        otra = await service.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto_id,
            provider="stripe",
            channel="web",
        )
        await db.commit()
    assert una.id == otra.id


@pytest.mark.asyncio
async def test_marcar_la_orden_pagada_sella_la_fecha(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        orden = await service.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto_id,
            provider="stripe",
            channel="web",
        )
        assert await service.marcar_orden(db, order_id=orden.id, status="paid")
        # Repetir el aviso no vuelve a cambiar nada.
        assert not await service.marcar_orden(db, order_id=orden.id, status="paid")
        await db.commit()

    assert orden.status == "paid"
    assert orden.paid_at is not None


# --------------------------------------------------------------------------- #
# La muestra
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_muestra_se_ve_sin_comprar(sesiones):
    """Es la razon de ser de `has_lesson_access`.

    Sin ella, o se compra el curso entero o no se ve nada, y no hay forma de
    enseñar de que va antes de pagar.
    """
    async with sesiones() as db:
        acceso = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id=LECCION_DE_MUESTRA
        )
    assert acceso == service.Acceso(True, service.MUESTRA)


@pytest.mark.asyncio
async def test_el_contenido_privado_no_se_ve_sin_comprar(sesiones):
    """La otra mitad, y la que de verdad protege el negocio.

    Que la muestra sea libre no puede abrir el resto del curso.
    """
    async with sesiones() as db:
        acceso = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id=LECCION_PRIVADA
        )
    assert acceso.tiene_acceso is False
    assert acceso.motivo == service.SIN_ACCESO


@pytest.mark.asyncio
async def test_comprado_el_curso_se_ve_la_leccion_privada(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        await db.commit()

    async with sesiones() as db:
        acceso = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id=LECCION_PRIVADA
        )
    assert acceso == service.Acceso(True, service.ENTITLEMENT)


@pytest.mark.asyncio
async def test_una_leccion_que_no_existe_no_da_acceso(sesiones):
    async with sesiones() as db:
        acceso = await service.resolver_acceso_a_la_leccion(
            db, user_id=ANA, lesson_id="eeeeeeee-0000-0000-0000-00000000ffff"
        )
    assert acceso.tiene_acceso is False


# --------------------------------------------------------------------------- #
# Nadie se concede acceso a si mismo
# --------------------------------------------------------------------------- #
#: LO UNICO que puede tener rutas en el comercio: la vista de SOLO LECTURA del
#: propietario sobre sus ventas. Cualquier otro fichero con rutas es una puerta
#: nueva, y la puerta que se olvida es la que abren.
_ROUTER_PERMITIDO = "router.py"


def _carpeta_del_comercio():
    import pathlib

    import app.modules.commerce as paquete

    return pathlib.Path(paquete.__file__).parent


def test_el_comercio_solo_expone_la_vista_del_propietario():
    """Conceder y revocar NO tienen ruta HTTP en este modulo.

    La unica forma de conceder un derecho es que el backend lo haga tras
    verificar un aviso servidor a servidor. Un endpoint —aunque estuviera
    protegido— es una puerta mas que vigilar. La otra mitad de esta regla vive
    en la RLS de la 0035, que no da ninguna politica de escritura a
    `authenticated`.

    LA EXCEPCION, Y POR QUE LO ES: `router.py` publica lo que el propietario ya
    tiene derecho a saber —cuanto ha vendido— y no escribe NADA.
    """
    carpeta = _carpeta_del_comercio()
    routers = sorted(f.name for f in carpeta.glob("*.py") if "router" in f.name)
    assert routers == [_ROUTER_PERMITIDO], f"Rutas inesperadas en comercio: {routers}"


def test_el_comercio_no_declara_ningun_apirouter_de_escritura():
    """Ni con otro nombre de fichero, ni con un verbo que escriba.

    Se comprueban las dos cosas: que solo un fichero declara `APIRouter`, y que
    ese fichero es de LECTURA. Un `POST` aqui dentro seria una ruta capaz de
    conceder o revocar acceso; conceder se sigue llamando solo desde el modulo
    de pagos, que es quien verifica los avisos.
    """
    carpeta = _carpeta_del_comercio()
    con_router = sorted(
        f.name
        for f in carpeta.glob("*.py")
        if "APIRouter" in f.read_text(encoding="utf-8")
    )
    assert con_router == [_ROUTER_PERMITIDO], f"Rutas inesperadas: {con_router}"

    texto = (carpeta / _ROUTER_PERMITIDO).read_text(encoding="utf-8")
    for verbo in ("@router.post", "@router.put", "@router.patch", "@router.delete"):
        assert verbo not in texto, f"El comercio no puede escribir por HTTP: {verbo}"
    for prohibido in ("conceder", "revocar", "marcar_orden", "registrar_transaccion"):
        assert prohibido not in texto, f"El comercio no puede llamar a '{prohibido}'"


@pytest.mark.asyncio
async def test_los_estados_invalidos_los_rechaza_la_base(sesiones):
    """Los CHECK viajan en el modelo, no solo en la migracion.

    Asi las pruebas los ejercitan de verdad en lugar de dar por hecho que el
    SQL de produccion los tiene.
    """
    from sqlalchemy.exc import IntegrityError

    async with sesiones() as db:
        producto_id = await _producto(db)
        await db.commit()
        db.add(
            Entitlement(
                user_id=ANA, commerce_product_id=producto_id, status="regalado"
            )
        )
        with pytest.raises(IntegrityError):
            await db.commit()


@pytest.mark.asyncio
async def test_matricular_con_un_origen_inventado_no_cuela(sesiones):
    from app.core.exceptions import ValidationAppError

    async with sesiones() as db:
        with pytest.raises(ValidationAppError):
            await service.matricular(
                db, user_id=ANA, course_id=CURSO_GRATIS, source="porque_si"
            )


@pytest.mark.asyncio
async def test_cursos_con_acceso_junta_derechos_y_compras_viejas(sesiones):
    async with sesiones() as db:
        producto_id = await _producto(db)
        await service.conceder_entitlement(
            db, user_id=ANA, commerce_product_id=producto_id
        )
        db.add(
            Purchase(
                user_id=ANA,
                course_id=CURSO_GRATIS,
                provider="web",
                amount_minor=0,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
        cursos = await service.cursos_con_acceso(db, user_id=ANA)

    assert cursos == sorted([CURSO_DE_PAGO, CURSO_GRATIS])
