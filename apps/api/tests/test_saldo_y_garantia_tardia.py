"""El saldo del propietario no puede vencer antes que la garantía del comprador.

EL CASO QUE OBLIGA A ESTE FICHERO, y que estaba mal:

    1. alguien compra;
    2. NO entra al curso en ocho días;
    3. el trabajo de liberación da el saldo por vencido al séptimo;
    4. al noveno entra, y ES ENTONCES cuando empieza su garantía;
    5. el propietario ya cobró, con la garantía abierta.

La solución es que el saldo nazca SIN fecha de vencimiento. No hay nada que
vencer hasta que la garantía empiece, y quien la empieza es el primer acceso a
contenido protegido.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.modules.catalog.models import Course
from app.modules.commerce import liquidacion
from app.modules.commerce.models import CommerceProduct, Order, OwnerSaleBalance
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.refunds import service as devoluciones
from app.modules.refunds.models import HORAS_DE_GARANTIA, CourseRefundWindow
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
PRECIO = 20000


@pytest_asyncio.fixture
async def sesiones():
    esquema.olvidar()
    ajustes = get_settings()
    antes = (ajustes.feature_course_refunds, ajustes.platform_fee_bps)
    ajustes.feature_course_refunds = True
    # Sin comisión no se crea saldo; se fija una para poder probar el saldo.
    ajustes.platform_fee_bps = 1000  # 10 %

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
                title="Curso",
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
                id=ORDEN,
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
    ajustes.feature_course_refunds, ajustes.platform_fee_bps = antes


async def _saldo_al_comprar(sesiones, *, con_garantia: bool = True):
    """Lo que escribe el webhook al confirmar el pago."""
    ajustes = get_settings()
    previo = ajustes.feature_course_refunds
    ajustes.feature_course_refunds = con_garantia
    try:
        async with sesiones() as db:
            orden = await db.get(Order, ORDEN)
            await liquidacion.registrar_saldo(
                db,
                orden=orden,
                disponible_desde=None if con_garantia else devoluciones.ahora(),
            )
            await db.commit()
    finally:
        ajustes.feature_course_refunds = previo


async def _saldo(sesiones) -> OwnerSaleBalance | None:
    async with sesiones() as db:
        return await db.scalar(
            select(OwnerSaleBalance).where(OwnerSaleBalance.order_id == ORDEN)
        )


# --------------------------------------------------------------------------- #
# 1. El saldo nace sin fecha
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_al_comprar_el_saldo_queda_pendiente_y_SIN_fecha(sesiones):
    await _saldo_al_comprar(sesiones)
    saldo = await _saldo(sesiones)
    assert saldo is not None
    assert saldo.status == "pending"
    # Es lo que impide que nada lo libere: no hay fecha que comparar.
    assert saldo.available_at is None


@pytest.mark.asyncio
async def test_liberar_no_toca_un_saldo_sin_fecha(sesiones):
    """La ejecución del trabajo ANTES del primer acceso no puede liberar nada."""
    await _saldo_al_comprar(sesiones)
    async with sesiones() as db:
        liberados = await liquidacion.liberar_vencidos(db)
        await db.commit()
    assert liberados == 0
    assert (await _saldo(sesiones)).status == "pending"


@pytest.mark.asyncio
async def test_una_compra_que_nadie_abre_nunca_sigue_pendiente(sesiones):
    """Deliberado: no se puede liberar un plazo que no ha empezado.

    Se vigila con la señal de «pendientes sin fecha» de la documentación, no
    liberándolo a ciegas.
    """
    await _saldo_al_comprar(sesiones)
    for _ in range(3):
        async with sesiones() as db:
            await liquidacion.liberar_vencidos(db)
            await db.commit()
    saldo = await _saldo(sesiones)
    assert saldo.status == "pending"
    assert saldo.available_at is None


# --------------------------------------------------------------------------- #
# 2. El primer acceso pone la fecha REAL
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_primer_acceso_fija_el_vencimiento_del_saldo(sesiones):
    await _saldo_al_comprar(sesiones)
    async with sesiones() as db:
        ventana = await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()

    saldo = await _saldo(sesiones)
    assert saldo.available_at is not None
    # La MISMA fecha que la garantía, no una calculada aparte.
    assert saldo.available_at.replace(tzinfo=None) == ventana.expires_at.replace(
        tzinfo=None
    )


@pytest.mark.asyncio
async def test_EL_CASO_CRITICO_entrar_a_los_ocho_dias(sesiones):
    """Compra, ocho días sin entrar, se ejecuta la liberación, y entonces entra.

    Antes: el saldo se liberaba al séptimo día desde la COMPRA y el propietario
    cobraba con la garantía todavía por empezar.
    """
    await _saldo_al_comprar(sesiones)

    # Pasan ocho días y el trabajo corre varias veces. No libera nada.
    for _ in range(8):
        async with sesiones() as db:
            assert await liquidacion.liberar_vencidos(db) == 0
            await db.commit()

    # Al noveno día, entra por primera vez.
    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()

    saldo = await _saldo(sesiones)
    assert saldo.status == "pending"
    # Su garantía empieza AHORA, así que el saldo vence dentro de 168 horas,
    # no hace un día.
    restante = saldo.available_at.replace(tzinfo=None) - devoluciones.ahora().replace(
        tzinfo=None
    )
    assert restante > timedelta(hours=HORAS_DE_GARANTIA - 1)

    # Y ejecutar la liberación otra vez sigue sin tocarlo.
    async with sesiones() as db:
        assert await liquidacion.liberar_vencidos(db) == 0
        await db.commit()


@pytest.mark.asyncio
async def test_cuando_la_garantia_vence_el_saldo_si_se_libera(sesiones):
    """La otra mitad: pasado el plazo, el dinero sí es del propietario."""
    await _saldo_al_comprar(sesiones)
    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()

    # Se envejece la ventana y se resincroniza, como haría el paso del tiempo.
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        pasado = devoluciones.ahora() - timedelta(hours=HORAS_DE_GARANTIA + 1)
        ventana.first_accessed_at = pasado
        ventana.expires_at = pasado + timedelta(hours=HORAS_DE_GARANTIA)
        await db.commit()
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        await devoluciones._fechar_saldo(db, ventana=ventana)
        await db.commit()

    async with sesiones() as db:
        assert await liquidacion.liberar_vencidos(db) == 1
        await db.commit()
    assert (await _saldo(sesiones)).status == "eligible"


@pytest.mark.asyncio
async def test_varios_accesos_a_la_vez_no_mueven_la_fecha(sesiones):
    """Concurrencia: la ventana es una, así que la fecha del saldo es una."""
    await _saldo_al_comprar(sesiones)

    async def entrar():
        async with sesiones() as db:
            await devoluciones.asegurar_ventana(
                db, user_id=ANA, course_id=CURSO, order_id=ORDEN
            )
            await db.commit()

    await asyncio.gather(entrar(), entrar(), entrar())

    async with sesiones() as db:
        ventanas = list(await db.scalars(select(CourseRefundWindow)))
    assert len(ventanas) == 1
    saldo = await _saldo(sesiones)
    assert saldo.available_at.replace(tzinfo=None) == ventanas[0].expires_at.replace(
        tzinfo=None
    )


# --------------------------------------------------------------------------- #
# 3. Sin garantía, el saldo sí nace disponible
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_con_las_devoluciones_apagadas_el_saldo_no_queda_bloqueado(sesiones):
    """Antes se quedaba en NULL también aquí, o sea bloqueado para siempre.

    Sin garantía no hay nada que esperar: el dinero es del propietario desde el
    primer momento.
    """
    await _saldo_al_comprar(sesiones, con_garantia=False)
    saldo = await _saldo(sesiones)
    assert saldo.available_at is not None
    async with sesiones() as db:
        assert await liquidacion.liberar_vencidos(db) == 1
        await db.commit()
    assert (await _saldo(sesiones)).status == "eligible"


# --------------------------------------------------------------------------- #
# 4. Recompra
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_recomprar_no_reinicia_la_garantia_ni_la_fecha_del_saldo(sesiones):
    await _saldo_al_comprar(sesiones)
    async with sesiones() as db:
        primera = await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        inicio = primera.first_accessed_at
        await db.commit()
    fecha_saldo = (await _saldo(sesiones)).available_at

    # Vuelve a entrar mil veces: la ventana no se mueve, ni la fecha del saldo.
    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()

    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
    assert ventana.first_accessed_at == inicio
    assert (await _saldo(sesiones)).available_at == fecha_saldo
