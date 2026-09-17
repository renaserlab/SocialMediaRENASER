"""Incremento 4 de Productos: el inventario (0074), contra PostgreSQL de verdad.

CONTRA POSTGRESQL Y NO CONTRA SQLITE, y no es un detalle: SQLite no bloquea
filas, así que una prueba de concurrencia allí pasaría con el bloqueo puesto y
también sin él. Lo que se demuestra aquí es que dos peticiones simultáneas NO
pueden reservar la misma última unidad, y eso solo se puede demostrar donde el
bloqueo existe.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. DOS NO SE LLEVAN LA ÚLTIMA. Con el orden fijado a mano, la segunda espera
     en el `select ... for update` y al despertar ve que no queda.
  2. NUNCA QUEDA NEGATIVO. Ni la existencia, ni lo comprometido, ni lo
     disponible.
  3. SIN FILA NO ES CERO. Un SKU que nadie cargó se contesta con su propio
     código, no con «agotado».
  4. UN DOBLE TOQUE NO MUEVE DOS VECES. La clave de idempotencia lo para en la
     clave primaria, antes de tocar ningún número.
  5. EL HISTORIAL SOLO SE AÑADE. Lo impone un disparador, no una costumbre.
  6. EDITAR EL PRODUCTO NO SE LLEVA EL INVENTARIO. Guardar el borrador rehace
     las variantes; el almacén no se entera, porque cuelga del SKU.
  7. MODERACIÓN NO MUEVE INVENTARIO.
"""

from __future__ import annotations

import asyncio

import psycopg
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import AppError
from app.modules.products import esquema, inventory, service
from app.modules.products.models import (
    AJUSTE,
    ENTRADA,
    InventoryMovement,
    ProductInventory,
    ProductVariant,
)
from tests.test_productos_dominio import (  # noqa: F401
    DATOS,
    SIN_POSTGRES,
    URL,
    VARIANTES,
    base_aplicada,
    persona,
    producto_en_borrador,
    sesiones,
    vendedor,
)

SKU = "CUCH-20"


@pytest.fixture()
def motor(base_aplicada):
    """Un motor propio, para poder abrir DOS sesiones a la vez de verdad."""
    return create_async_engine(
        URL.replace("postgresql://", "postgresql+asyncpg://", 1)
    )


async def con_inventario(sesiones, cuantas: int = 3) -> tuple[str, str]:
    """Quien vende y su producto, con `cuantas` unidades del SKU cargadas."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien, con_foto=False)
    if cuantas:
        async with sesiones() as db:
            await inventory.entrada(
                db,
                product_id=producto_id,
                sku=SKU,
                cantidad=cuantas,
                clave=f"carga-inicial-{producto_id}",
                actor_id=quien,
            )
            await db.commit()
    return quien, producto_id


# =========================================================================== #
# Lógica pura
# =========================================================================== #
def test_como_queda_tras_cada_movimiento() -> None:
    """LÓGICA PURA, sin base: se puede leer de un vistazo y probar sola."""
    assert inventory._aplicar(ENTRADA, 5, 10, 2) == (15, 2)
    assert inventory._aplicar(AJUSTE, -3, 10, 2) == (7, 2)
    assert inventory._aplicar("reservation", 4, 10, 2) == (10, 6)
    assert inventory._aplicar("release", 2, 10, 6) == (10, 4)
    # LA SALIDA BAJA LAS DOS CUENTAS: sale del almacén lo comprometido.
    assert inventory._aplicar("dispatch", 3, 10, 6) == (7, 3)


def test_lo_disponible_se_calcula_y_no_se_guarda() -> None:
    hay = inventory.Existencias(product_id="p", sku="S", on_hand=10, reserved=4)
    assert hay.available == 6
    # Y NO EXISTE LA COLUMNA. Si apareciera, habría dos verdades que divergen.
    assert "available" not in ProductInventory.__table__.columns


def test_el_identificador_del_movimiento_depende_de_todo_lo_que_toca() -> None:
    """SIN EL PRODUCTO, la misma clave reusada en otro devolvería el movimiento
    del primero. SIN EL ACTOR, dos personas mandando «1» se pisarían."""
    base = inventory.id_del_movimiento("p1", "S1", "a1", "k")
    assert base != inventory.id_del_movimiento("p2", "S1", "a1", "k")
    assert base != inventory.id_del_movimiento("p1", "S2", "a1", "k")
    assert base != inventory.id_del_movimiento("p1", "S1", "a2", "k")
    assert base != inventory.id_del_movimiento("p1", "S1", "a1", "otra")
    # Y LA MISMA CLAVE DA SIEMPRE EL MISMO. Si no, el reintento crearía otro.
    assert base == inventory.id_del_movimiento("p1", "S1", "a1", " k ")


# =========================================================================== #
# Sin fila NO es cero
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_sku_sin_cargar_no_tiene_cero_unidades(sesiones) -> None:
    """`None` NO ES CERO. Decir «agotado» de algo que nunca se inventarió manda
    a quien vende a buscar un problema que no existe."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU)
    assert hay is None

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.ajustar(
                db, product_id=producto_id, sku=SKU, cantidad=-1,
                motivo="Una rotura", clave="k1", actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_not_configured"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_solo_la_entrada_crea_la_fila(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.reservar(
                db, product_id=producto_id, sku=SKU, cantidad=1, clave="r1",
            )
    assert fallo.value.code == "product_inventory_not_configured"

    async with sesiones() as db:
        hay, _ = await inventory.entrada(
            db, product_id=producto_id, sku=SKU, cantidad=4, clave="e1",
            actor_id=quien,
        )
        await db.commit()
    assert (hay.on_hand, hay.reserved, hay.available) == (4, 0, 4)


# =========================================================================== #
# Nunca negativo
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_reserva_mas_de_lo_que_hay(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=3)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.reservar(
                db, product_id=producto_id, sku=SKU, cantidad=4, clave="r1",
            )
    assert fallo.value.code == "product_inventory_insufficient"
    assert fallo.value.details["available"] == 3
    assert fallo.value.details["requested"] == 4


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_ajuste_no_puede_dejar_la_existencia_negativa(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=3)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.ajustar(
                db, product_id=producto_id, sku=SKU, cantidad=-10,
                motivo="Se perdió el lote entero", clave="a1", actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_insufficient"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_ajuste_no_puede_dejar_menos_de_lo_comprometido(sesiones) -> None:
    """RESERVADO <= EXISTENCIA. Ajustar por debajo de lo ya comprometido
    dejaría lo disponible en negativo, que es lo que el CHECK impide."""
    quien, producto_id = await con_inventario(sesiones, cuantas=5)
    async with sesiones() as db:
        await inventory.reservar(
            db, product_id=producto_id, sku=SKU, cantidad=4, clave="r1"
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.ajustar(
                db, product_id=producto_id, sku=SKU, cantidad=-2,
                motivo="Dos piezas rotas", clave="a1", actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_insufficient"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_ajuste_sin_motivo_no_pasa(sesiones) -> None:
    """ES EL ÚNICO MOVIMIENTO que cambia el número sin que haya ocurrido nada
    fuera del sistema, y por eso es el único que exige explicar por qué."""
    quien, producto_id = await con_inventario(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.ajustar(
                db, product_id=producto_id, sku=SKU, cantidad=-1, motivo="  ",
                clave="a1", actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_movement_invalid"
    assert fallo.value.details["field"] == "reason"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_entrada_negativa_es_un_ajuste_mal_nombrado(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.entrada(
                db, product_id=producto_id, sku=SKU, cantidad=-2, clave="e2",
                actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_movement_invalid"

    # Y LA OTRA CAPA, POR SEPARADO. Lo encontró la batería de mutaciones: con
    # las dos puestas, retirar una no ponía roja ninguna prueba, así que la
    # prueba no demostraba cuál de las dos protege. `mover` es la única puerta
    # del inventario, y tiene que pararlo aunque nadie pase por `entrada`.
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.mover(
                db, product_id=producto_id, sku=SKU, kind=ENTRADA, cantidad=-2,
                clave="e3", actor_id=quien, actor_rol="seller",
            )
    assert fallo.value.code == "product_inventory_movement_invalid"
    assert fallo.value.details["kind"] == ENTRADA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_movimiento_de_cero_no_es_un_movimiento(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.mover(
                db, product_id=producto_id, sku=SKU, kind=AJUSTE, cantidad=0,
                clave="a0", actor_id=quien, actor_rol="seller", motivo="nada",
            )
    assert fallo.value.code == "product_inventory_movement_invalid"


# =========================================================================== #
# Idempotencia
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_misma_clave_no_carga_dos_veces(sesiones) -> None:
    """UN DOBLE TOQUE NO CARGA EL DOBLE. El identificador se deriva de la
    clave, así que la segunda choca contra la clave primaria."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    for _ in range(3):
        async with sesiones() as db:
            hay, movimiento = await inventory.entrada(
                db, product_id=producto_id, sku=SKU, cantidad=7,
                clave="el-mismo-toque", actor_id=quien,
            )
            await db.commit()
    assert hay.on_hand == 7

    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.sku == SKU,
            )
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_claves_distintas_si_cargan_dos_veces(sesiones) -> None:
    """DOS TOQUES SON DOS TOQUES. La idempotencia protege del reintento, no de
    querer cargar más."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    for i in range(2):
        async with sesiones() as db:
            hay, _ = await inventory.entrada(
                db, product_id=producto_id, sku=SKU, cantidad=5, clave=f"toque-{i}",
                actor_id=quien,
            )
            await db.commit()
    assert hay.on_hand == 10


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_misma_clave_en_otro_sku_si_mueve(sesiones) -> None:
    """LA CLAVE ES POR (PRODUCTO, SKU). Un cliente mal escrito manda «1» para
    todo, y dos SKU distintos no deben pisarse."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    async with sesiones() as db:
        await inventory.entrada(
            db, product_id=producto_id, sku="CUCH-20", cantidad=2, clave="1",
            actor_id=quien,
        )
        await db.commit()
    async with sesiones() as db:
        hay, _ = await inventory.entrada(
            db, product_id=producto_id, sku="CUCH-24", cantidad=3, clave="1",
            actor_id=quien,
        )
        await db.commit()
    assert hay.sku == "CUCH-24" and hay.on_hand == 3


# =========================================================================== #
# LA CARRERA
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_mientras_una_reserva_tiene_la_fila_bloqueada_la_otra_espera(
    sesiones, motor
) -> None:
    """LA PRUEBA QUE DEMUESTRA EL BLOQUEO, y la única que no depende de la
    suerte.

        A  ->  bloquea la fila del SKU y NO confirma
        B  ->  pide la última unidad: se queda esperando en el `for update`
        A  ->  se lleva la última y confirma
        B  ->  despierta, lee lo que hay AHORA y ve que no queda

    El paso que importa es el segundo. SIN `with_for_update()`, B no espera:
    lee el mismo número que A, y las dos se llevan la misma unidad.
    """
    quien, producto_id = await con_inventario(sesiones, cuantas=1)
    Dos = async_sessionmaker(motor, expire_on_commit=False)

    async with Dos() as a:
        # A se queda con la fila. No confirma: la deja bloqueada.
        await a.scalar(
            select(ProductInventory)
            .where(
                ProductInventory.product_id == producto_id,
                ProductInventory.sku == SKU,
            )
            .with_for_update()
        )

        async with Dos() as b:
            intento = asyncio.create_task(
                inventory.reservar(
                    b, product_id=producto_id, sku=SKU, cantidad=1, clave="b",
                )
            )
            # B TIENE que seguir esperando. Medio segundo es una eternidad para
            # una consulta local; si termina, es que nadie la detuvo.
            await asyncio.sleep(0.5)
            assert not intento.done(), (
                "la segunda reserva no esperó al cerrojo: sin él, las dos leen "
                "el mismo número y las dos se llevan la última unidad"
            )

            await a.execute(
                text(
                    "update public.product_inventory set reserved = 1"
                    " where product_id = cast(:p as uuid) and sku = :s"
                ),
                {"p": producto_id, "s": SKU},
            )
            await a.commit()

            with pytest.raises(AppError) as fallo:
                await intento
            assert fallo.value.code == "product_inventory_insufficient"

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU)
    assert (hay.on_hand, hay.reserved, hay.available) == (1, 1, 0)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cinco_a_la_vez_por_dos_unidades_se_llevan_dos(sesiones, motor) -> None:
    """LA COMPROBACIÓN DE PUNTA A PUNTA. Cinco peticiones simultáneas por dos
    unidades: dos entran, tres reciben un conflicto EXPLICADO —no un 500— y el
    número final es exactamente dos."""
    quien, producto_id = await con_inventario(sesiones, cuantas=2)
    Dos = async_sessionmaker(motor, expire_on_commit=False)

    async def intenta(n: int):
        async with Dos() as db:
            try:
                await inventory.reservar(
                    db, product_id=producto_id, sku=SKU, cantidad=1, clave=f"c{n}",
                )
                await db.commit()
                return "ok"
            except AppError as error:
                await db.rollback()
                return error.code

    resultados = await asyncio.gather(*[intenta(n) for n in range(5)])
    assert sum(r == "ok" for r in resultados) == 2, resultados
    assert all(
        r in ("ok", "product_inventory_insufficient") for r in resultados
    ), resultados

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU)
    assert (hay.on_hand, hay.reserved, hay.available) == (2, 2, 0)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_primeras_entradas_a_la_vez_no_crean_dos_filas(
    sesiones, motor
) -> None:
    """LA CREACIÓN TAMBIÉN ES UNA CARRERA. Dos primeras entradas simultáneas
    llegan las dos al `insert`; la clave primaria impide la segunda fila y la
    relectura recoge la que ganó."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    Dos = async_sessionmaker(motor, expire_on_commit=False)

    async def carga(n: int):
        async with Dos() as db:
            try:
                await inventory.entrada(
                    db, product_id=producto_id, sku=SKU, cantidad=1,
                    clave=f"primera-{n}", actor_id=quien,
                )
                await db.commit()
                return "ok"
            except AppError as error:
                await db.rollback()
                return error.code

    resultados = await asyncio.gather(*[carga(n) for n in range(4)])
    assert all(r == "ok" for r in resultados), resultados

    async with sesiones() as db:
        filas = await db.scalar(
            select(func.count())
            .select_from(ProductInventory)
            .where(ProductInventory.product_id == producto_id)
        )
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU)
    assert filas == 1
    assert hay.on_hand == 4


# =========================================================================== #
# El historial
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_no_se_edita_ni_se_borra(sesiones) -> None:
    """UNA RECTIFICACIÓN ES UN MOVIMIENTO NUEVO. Si una fila se puede editar,
    «cuántas había el martes» deja de tener respuesta."""
    quien, producto_id = await con_inventario(sesiones, cuantas=3)
    async with sesiones() as db:
        movimiento = await db.scalar(
            select(InventoryMovement).where(
                InventoryMovement.product_id == producto_id
            )
        )
        movimiento_id = movimiento.id

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "update public.inventory_movements set quantity = 999"
                " where id = cast(%s as uuid)",
                (movimiento_id,),
            )
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "delete from public.inventory_movements where id = cast(%s as uuid)",
                (movimiento_id,),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cada_movimiento_deja_como_quedo(sesiones) -> None:
    """SIN `on_hand_after`, reconstruir el pasado exigiría sumar la cadena
    entera y confiar en que no falta ninguna."""
    quien, producto_id = await con_inventario(sesiones, cuantas=10)
    async with sesiones() as db:
        await inventory.ajustar(
            db, product_id=producto_id, sku=SKU, cantidad=-3,
            motivo="Tres piezas con un defecto de acabado", clave="a1",
            actor_id=quien,
        )
        await db.commit()
    async with sesiones() as db:
        historial = await inventory.movimientos(
            db, product_id=producto_id, sku=SKU
        )
    assert [m.kind for m in historial] == [AJUSTE, ENTRADA]
    assert historial[0].quantity == -3
    assert historial[0].on_hand_after == 7
    assert historial[0].reason == "Tres piezas con un defecto de acabado"
    assert historial[1].on_hand_after == 10


# =========================================================================== #
# El producto se edita y el almacén no se entera
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_editar_el_borrador_no_se_lleva_el_inventario(sesiones) -> None:
    """EL INVENTARIO CUELGA DEL SKU, no de la fila de la variante. Guardar el
    borrador rehace esas filas; si el almacén colgara de ellas, editar la
    descripción borraría las existencias."""
    quien, producto_id = await con_inventario(sesiones, cuantas=6)

    async with sesiones() as db:
        antes = list(
            await db.scalars(
                select(ProductVariant.id)
                .join(
                    service.ProductVersion,
                    service.ProductVersion.id == ProductVariant.version_id,
                )
                .where(service.ProductVersion.product_id == producto_id)
            )
        )

    async with sesiones() as db:
        await service.guardar_borrador(
            db,
            producto_id=producto_id,
            usuario_id=quien,
            datos={**DATOS, "description": "Otra descripción entera"},
            variantes=VARIANTES,
        )
        await db.commit()

    async with sesiones() as db:
        despues = list(
            await db.scalars(
                select(ProductVariant.id)
                .join(
                    service.ProductVersion,
                    service.ProductVersion.id == ProductVariant.version_id,
                )
                .where(service.ProductVersion.product_id == producto_id)
            )
        )
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU)

    # Las filas de variante SON OTRAS...
    assert set(antes) != set(despues)
    # ...y el almacén sigue exactamente donde estaba.
    assert hay is not None and hay.on_hand == 6


# =========================================================================== #
# Permisos y auditoría
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_actor_desconocido_no_mueve_nada(sesiones) -> None:
    """MODERACIÓN NO MUEVE INVENTARIO, y ningún rol inventado tampoco: los
    actores son tres y están escritos."""
    quien, producto_id = await con_inventario(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await inventory.mover(
                db, product_id=producto_id, sku=SKU, kind=ENTRADA, cantidad=1,
                clave="x", actor_id=quien, actor_rol="moderator",
            )
    assert fallo.value.code == "product_inventory_movement_invalid"
    assert "moderator" not in inventory.ROL_DE_AUDITORIA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cada_movimiento_deja_rastro_de_auditoria(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=0)
    async with sesiones() as db:
        await inventory.entrada(
            db, product_id=producto_id, sku=SKU, cantidad=4, clave="e1",
            actor_id=quien,
        )
        await db.commit()

    async with sesiones() as db:
        filas = list(
            (
                await db.execute(
                    text(
                        "select action, actor_role, payload from public.audit_events"
                        " where entity_id = cast(:p as uuid)"
                        "   and action like 'product_inventory.%'"
                    ),
                    {"p": producto_id},
                )
            ).all()
        )
    assert len(filas) == 1
    assert filas[0][0] == "product_inventory.intake"
    # EL ROL SE TRADUCE. `audit_events.actor_role` solo admite cuatro valores, y
    # la 0050 —aplicada— no se amplía por esto.
    assert filas[0][1] == "user"
    assert filas[0][2]["sku"] == SKU
    assert filas[0][2]["available_after"] == 4


# =========================================================================== #
# Sin la 0074
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0074_el_inventario_contesta_503(sesiones, monkeypatch) -> None:
    """DEGRADACIÓN SEGURA: 503 con su código, y leer devuelve `None` en vez de
    reventar. Un catálogo no se cae porque falte una migración del almacén."""
    quien, producto_id = await con_inventario(sesiones, cuantas=0)

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_inventario", _no_hay)
    async with sesiones() as db:
        assert await inventory.de_la_unidad(db, product_id=producto_id, sku=SKU) is None
        assert await inventory.del_producto(db, product_id=producto_id) == {}
        with pytest.raises(AppError) as fallo:
            await inventory.entrada(
                db, product_id=producto_id, sku=SKU, cantidad=1, clave="k",
                actor_id=quien,
            )
    assert fallo.value.code == "product_inventory_not_available"
    assert fallo.value.status_code == 503


# =========================================================================== #
# Lo que impone la base
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_comprometer_mas_de_lo_que_hay(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=2)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "update public.product_inventory set reserved = 5"
                " where product_id = cast(%s as uuid) and sku = %s",
                (producto_id, SKU),
            )
    assert "product_inventory_reservado_cabe" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_una_existencia_negativa(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=2)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "update public.product_inventory set on_hand = -1"
                " where product_id = cast(%s as uuid) and sku = %s",
                (producto_id, SKU),
            )
    assert "product_inventory_existencia" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_exige_motivo_en_un_ajuste(sesiones) -> None:
    quien, producto_id = await con_inventario(sesiones, cuantas=2)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "insert into public.inventory_movements"
                " (id, product_id, sku, kind, quantity, on_hand_after,"
                "  reserved_after, actor_role, idempotency_key)"
                " values (gen_random_uuid(), cast(%s as uuid), %s, 'adjustment',"
                "         -1, 1, 0, 'seller', 'sin-motivo')",
                (producto_id, SKU),
            )
    assert "inventory_movements_ajuste_con_motivo" in str(violado.value)
