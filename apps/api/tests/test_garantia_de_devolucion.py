"""La garantía de 7 días y la máquina de estados de una devolución.

POR QUÉ ESTE FICHERO ES EL PRIMERO QUE SE ESCRIBIÓ. Porque las dos cosas que
protege no se ven fallar: una garantía que se reinicia al reinstalar y una
transición que se salta un paso producen un resultado que PARECE correcto —hay
acceso, hay dinero devuelto— y solo se descubre cuando alguien devuelve dos
veces el mismo curso o pierde el suyo sin motivo.

Lo que se fija aquí:

1. La garantía la arranca el SERVIDOR al entregar contenido protegido, una sola
   vez, y no la mueve nada después.
2. Dos peticiones simultáneas crean UNA ventana, y lo impide un índice único,
   no un `if`.
3. El plazo son 168 horas exactas: el último segundo vale, el siguiente no.
4. Ninguna transición puede saltarse un paso, y ningún actor puede dar un paso
   que no le corresponde.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.catalog.models import Course
from app.modules.commerce.models import CommerceProduct, Order
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.refunds import estados, service
from app.modules.refunds.models import HORAS_DE_GARANTIA, CourseRefundWindow
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 19900


@pytest_asyncio.fixture
async def sesiones():
    """Una base con un curso de pago de Bruno y una compra pagada de Ana.

    LA GARANTÍA SE ENCIENDE MUTANDO EL AJUSTE, NO LIMPIANDO EL CACHÉ.
    `get_settings()` está cacheado y devuelve el MISMO objeto para toda la
    sesión; el `conftest.py` se apoya en eso para apagar de una vez las salidas
    al almacenamiento real. Un `cache_clear()` aquí tira ese apagado al suelo y
    las pruebas siguientes empiezan a intentar salir a producción —que es
    exactamente lo que pasó la primera vez que se escribió esta fixture, y el
    fallo aparecía en pruebas de recomendaciones que no tienen nada que ver—.
    """
    esquema.olvidar()
    from app.core.config import get_settings

    ajustes = get_settings()
    anterior = ajustes.feature_course_refunds
    ajustes.feature_course_refunds = True

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
                title="Curso de pago",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        producto = CommerceProduct(course_id=CURSO)
        db.add(producto)
        await db.flush()
        db.add(
            Order(
                id="00000000-0000-0000-0000-0000000000a1",
                user_id=ANA,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        await db.commit()

    yield fabrica
    await engine.dispose()
    ajustes.feature_course_refunds = anterior


# --------------------------------------------------------------------------- #
# 1. Cuándo arranca la garantía
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_primera_entrega_protegida_arranca_la_garantia(sesiones):
    async with sesiones() as db:
        ventana = await service.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        await db.commit()

    assert ventana is not None
    assert ventana.first_accessed_at is not None
    # Las 168 horas se guardan EN LA FILA, no se calculan al leer: el plazo de
    # una garantía ya empezada no puede cambiar porque alguien edite una
    # constante del código.
    inicio = ventana.first_accessed_at.replace(tzinfo=timezone.utc)
    vence = ventana.expires_at.replace(tzinfo=timezone.utc)
    assert vence - inicio == timedelta(hours=HORAS_DE_GARANTIA)


@pytest.mark.asyncio
async def test_volver_a_entrar_no_reinicia_la_garantia(sesiones):
    """Reinstalar, cambiar de teléfono o recomprar no mueven la fecha."""
    async with sesiones() as db:
        primera = await service.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        inicio = primera.first_accessed_at
        await db.commit()

    async with sesiones() as db:
        segunda = await service.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        await db.commit()

    assert segunda.id == primera.id
    assert segunda.first_accessed_at == inicio


@pytest.mark.asyncio
async def test_dos_entregas_simultaneas_crean_UNA_sola_ventana(sesiones):
    """La carrera real: el móvil y la web abriendo la misma lección a la vez.

    NO se comprueba que exista un `if`: se lanzan dos de verdad contra la misma
    base. Con «mira si existe y si no créala», las dos leen antes de que escriba
    ninguna, las dos ven que no hay nada y las dos insertan. Lo que lo impide es
    el índice `course_refund_windows_unica`.
    """

    async def entrar():
        async with sesiones() as db:
            await service.asegurar_ventana(
                db, user_id=ANA, course_id=CURSO, order_id=None
            )
            await db.commit()

    await asyncio.gather(entrar(), entrar(), entrar())

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(CourseRefundWindow)
            .where(
                CourseRefundWindow.user_id == ANA,
                CourseRefundWindow.course_id == CURSO,
            )
        )
    assert cuantas == 1


@pytest.mark.asyncio
async def test_la_garantia_de_cada_persona_es_la_suya(sesiones):
    async with sesiones() as db:
        await service.asegurar_ventana(db, user_id=ANA, course_id=CURSO, order_id=None)
        await service.asegurar_ventana(db, user_id=BRUNO, course_id=CURSO, order_id=None)
        await db.commit()

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count()).select_from(CourseRefundWindow)
        )
    assert cuantas == 2


# --------------------------------------------------------------------------- #
# 2. El plazo, al segundo
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_dentro_de_plazo_es_elegible(sesiones):
    async with sesiones() as db:
        await service.asegurar_ventana(db, user_id=ANA, course_id=CURSO, order_id=None)
        await db.commit()
        estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)

    assert estado.elegible is True
    assert estado.motivo is None
    # Queda casi todo el plazo: se acaba de abrir.
    assert HORAS_DE_GARANTIA * 3600 - 60 < estado.seconds_remaining <= HORAS_DE_GARANTIA * 3600


@pytest.mark.asyncio
async def test_el_ultimo_segundo_todavia_vale(sesiones):
    """168 horas menos un segundo: dentro. Es el borde exacto de la promesa."""
    async with sesiones() as db:
        ventana = await service.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        casi = service.ahora() - timedelta(hours=HORAS_DE_GARANTIA) + timedelta(seconds=1)
        ventana.first_accessed_at = casi
        ventana.expires_at = casi + timedelta(hours=HORAS_DE_GARANTIA)
        await db.commit()
        estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)

    assert estado.elegible is True
    assert estado.seconds_remaining >= 0


@pytest.mark.asyncio
async def test_pasado_el_plazo_ya_no(sesiones):
    async with sesiones() as db:
        ventana = await service.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=None
        )
        justo = service.ahora() - timedelta(hours=HORAS_DE_GARANTIA, seconds=1)
        ventana.first_accessed_at = justo
        ventana.expires_at = justo + timedelta(hours=HORAS_DE_GARANTIA)
        await db.commit()
        estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)

    assert estado.elegible is False
    assert estado.motivo == service.FUERA_DE_PLAZO
    assert estado.seconds_remaining == 0


@pytest.mark.asyncio
async def test_sin_haber_entrado_la_garantia_no_ha_empezado(sesiones):
    """Compró y no ha abierto nada. No es que no pueda: es que no ha empezado."""
    async with sesiones() as db:
        estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)

    assert estado.elegible is False
    assert estado.motivo == service.GARANTIA_NO_INICIADA


@pytest.mark.asyncio
async def test_sin_compra_pagada_no_hay_nada_que_devolver(sesiones):
    async with sesiones() as db:
        await service.asegurar_ventana(db, user_id=BRUNO, course_id=CURSO, order_id=None)
        await db.commit()
        estado = await service.estado_de_garantia(db, user_id=BRUNO, course_id=CURSO)

    assert estado.elegible is False
    assert estado.motivo == service.SIN_COMPRA


@pytest.mark.asyncio
async def test_la_hora_que_manda_es_la_del_servidor(sesiones):
    """El DTO lleva la hora oficial para que la pantalla no use la del teléfono.

    Un reloj movido a mano es la forma más sencilla de estirar un plazo, y no
    hace falta ser malintencionado: basta con tener la zona horaria mal puesta.
    """
    antes = datetime.now(timezone.utc)
    async with sesiones() as db:
        estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)
    despues = datetime.now(timezone.utc)

    assert antes <= estado.server_time <= despues
    assert estado.server_time.tzinfo is not None


@pytest.mark.asyncio
async def test_con_el_interruptor_apagado_no_hay_garantia(sesiones):
    """Todo lo que mueve dinero nace apagado, y apagado no miente: dice que no."""
    from app.core.config import get_settings

    ajustes = get_settings()
    ajustes.feature_course_refunds = False
    try:
        async with sesiones() as db:
            estado = await service.estado_de_garantia(db, user_id=ANA, course_id=CURSO)
    finally:
        ajustes.feature_course_refunds = True

    assert estado.elegible is False
    assert estado.motivo == service.DESACTIVADO


# --------------------------------------------------------------------------- #
# 3. La máquina de estados
# --------------------------------------------------------------------------- #


def test_el_camino_feliz_completo():
    camino = [
        estados.REQUESTED,
        estados.UNDER_REVIEW,
        estados.APPROVED,
        estados.REFUND_PROCESSING,
        estados.REFUNDED,
    ]
    for desde, hasta in zip(camino, camino[1:]):
        assert estados.puede(desde, hasta), f"{desde} -> {hasta}"


@pytest.mark.parametrize(
    "desde, hasta",
    [
        # Aprobar sin revisar: se salta a quien tenía que mirarlo.
        (estados.REQUESTED, estados.APPROVED),
        # Reembolsar sin aprobar: dinero fuera sin que nadie lo autorizara.
        (estados.UNDER_REVIEW, estados.REFUNDED),
        (estados.APPROVED, estados.REFUNDED),
        # Resucitar un expediente cerrado.
        (estados.REFUNDED, estados.REFUND_PROCESSING),
        (estados.REJECTED, estados.APPROVED),
        (estados.CANCELLED, estados.UNDER_REVIEW),
    ],
)


def test_los_saltos_prohibidos_no_existen(desde, hasta):
    assert not estados.puede(desde, hasta)
    with pytest.raises(estados.TransicionInvalida):
        estados.exigir(desde, hasta, rol="admin")


def test_un_webhook_tardio_SI_puede_cerrar_un_expediente_fallido():
    """`FAILED -> REFUNDED` estaba prohibido, y hubo que permitirlo.

    ESTA PRUEBA CAMBIO DE SIGNO, y conviene explicar por qué. Antes afirmaba
    que dar por reembolsado algo que había fallado era un salto inválido, y
    suena razonable: no se da por bueno lo que falló.

    Pero el caso real es otro. Un reembolso se pide, la respuesta se pierde y el
    expediente acaba en `failed`; después llega el webhook bueno —el dinero SÍ
    volvió—. `reembolso.aplicar` ya había escrito sus siete primeros pasos
    (transacción, orden reembolsada, derecho revocado, garantía consumida,
    saldo cancelado) y reventaba en el octavo con `TransicionInvalida`. El
    resultado: acceso retirado, dinero devuelto, y el expediente en `failed`
    para siempre. Peor que el salto que se quería impedir.

    La salvaguarda no es prohibir la arista: es QUIÉN puede recorrerla. Solo el
    sistema, y solo con un webhook verificado.
    """
    assert estados.puede(estados.FAILED, estados.REFUNDED)
    assert estados.puede_actor("system", estados.REFUNDED)
    assert not estados.puede_actor("admin", estados.REFUNDED)
    assert not estados.puede_actor("user", estados.REFUNDED)

def test_repetir_el_mismo_estado_tampoco(sesiones=None):
    """La doble aprobación: dos administradores pulsando a la vez."""
    with pytest.raises(estados.TransicionInvalida):
        estados.exigir(estados.APPROVED, estados.APPROVED, rol="admin")


def test_solo_el_sistema_declara_reembolsado():
    """Ni un administrador puede marcarlo a mano.

    Si pudiera, retiraría el acceso sin que nadie hubiera devuelto el dinero: el
    alumno se quedaría sin curso Y sin reembolso. Solo un webhook verificado,
    total y conciliado, lleva a este estado.
    """
    assert estados.puede_actor("system", estados.REFUNDED)
    assert not estados.puede_actor("admin", estados.REFUNDED)
    assert not estados.puede_actor("user", estados.REFUNDED)
    with pytest.raises(estados.TransicionInvalida):
        estados.exigir(estados.REFUND_PROCESSING, estados.REFUNDED, rol="admin")


def test_el_alumno_solo_puede_retirar_la_suya():
    assert estados.puede_actor("user", estados.CANCELLED)
    for prohibido in (estados.APPROVED, estados.REJECTED, estados.UNDER_REVIEW):
        assert not estados.puede_actor("user", prohibido)


def test_el_propietario_del_curso_no_aparece_en_ninguna_transicion():
    """No aprueba, no rechaza y no ejecuta reembolsos. En ninguna."""
    for permitidos in estados.ACTORES.values():
        assert "owner" not in permitidos
        assert "author" not in permitidos


def test_los_estados_vivos_coinciden_con_el_indice_de_la_migracion():
    """Si divergen, la base rechaza inserciones que el código creía válidas.

    El índice `refund_requests_viva_por_orden` de la 0049 lista exactamente
    estos cinco. Duplicar la lista en dos sitios es un riesgo aceptado —uno es
    SQL y el otro Python—, pero entonces hay que comprobarlo.
    """
    assert estados.VIVOS == frozenset({
        "requested", "under_review", "approved", "refund_processing", "failed",
    })


def test_de_los_estados_finales_no_se_sale():
    for final in estados.FINALES:
        assert estados.TRANSICIONES[final] == frozenset()
        assert not estados.esta_vivo(final)
