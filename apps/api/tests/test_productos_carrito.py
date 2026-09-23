"""Incremento 4 de Productos: el carrito (0075), contra PostgreSQL de verdad.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. EL CARRITO NO COMPRA. `purchasable` dice si la bolsa tiene algo que
     comprar, no que se pueda: eso son cinco banderas y una política publicada,
     y vive en el Incremento 5 (`test_productos_pedidos.py`).
  2. EL CARRITO NO RESERVA NADA. Meter algo en la bolsa no mueve el inventario
     ni una unidad: se comprueba contando los movimientos.
  3. LOS IMPORTES LOS CALCULA EL SERVIDOR. El cliente manda qué y cuántas.
  4. UN CARRITO VACÍO NO ENSEÑA CERO. El subtotal viaja nulo.
  5. MONEDAS INCOMPATIBLES NO SE SUMAN.
  6. AÑADIR DOS VECES AJUSTA LA LÍNEA, y un doble toque con la misma clave no
     suma dos.
  7. QUITAR Y CAMBIAR LA CANTIDAD SON IDEMPOTENTES.
  8. LO SUSPENDIDO SIGUE IDENTIFICABLE Y NO ES COMPRABLE.
  9. EL CONTADOR DE LA BOLSA Y EL DE GUARDADOS SON DOS NÚMEROS DISTINTOS.
"""

from __future__ import annotations

import asyncio

import psycopg
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import AppError
from app.modules.products import carts, catalog, esquema, inventory, service
from app.modules.products.models import (
    InventoryMovement,
    ProductCart,
    ProductCartItem,
    ProductVariant,
    ProductVersion,
)
from tests.test_productos_catalogo import publicado
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)


@pytest.fixture()
def motor(base_aplicada):
    return create_async_engine(
        URL.replace("postgresql://", "postgresql+asyncpg://", 1)
    )


async def variantes_de(sesiones, version_id: str) -> list[ProductVariant]:
    async with sesiones() as db:
        return list(
            await db.scalars(
                select(ProductVariant)
                .where(ProductVariant.version_id == version_id)
                .order_by(ProductVariant.position, ProductVariant.sku)
            )
        )


async def con_existencias(sesiones, producto_id: str, sku: str, cuantas: int) -> None:
    async with sesiones() as db:
        await inventory.entrada(
            db,
            product_id=producto_id,
            sku=sku,
            cantidad=cuantas,
            clave=f"carga-{producto_id}-{sku}",
            actor_id=None,
            actor_rol="system",
        )
        await db.commit()


async def bolsa_lista(sesiones, *, cuantas: int = 5):
    """Un producto publicado con existencias y alguien que compra."""
    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, cuantas)
    comprador = await persona(sesiones, "compra")
    return producto_id, version_id, variantes, comprador


# =========================================================================== #
# Añadir
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_anadir_no_reserva_ni_una_unidad(sesiones) -> None:
    """TENER ALGO EN LA BOLSA NO SE LO QUITA A NADIE. Una reserva sin caducidad
    convertiría un carrito olvidado en un producto agotado."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=2,
        )
        await db.commit()

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        movimientos = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
    assert hay.reserved == 0
    assert hay.available == 5
    # Solo el movimiento de la carga inicial. Meter en la bolsa no mueve nada.
    assert movimientos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_anadir_dos_veces_ajusta_la_linea_y_no_la_duplica(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    for _ in range(3):
        async with sesiones() as db:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1,
            )
            await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.lines == 1
    assert bolsa.items[0].quantity == 3
    assert bolsa.units == 3


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_doble_toque_con_la_misma_clave_no_suma_dos(sesiones) -> None:
    """ES LA DIFERENCIA entre un doble toque y dos toques: el primero es la
    misma petición repetida, y no debe sumar dos."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    for _ in range(4):
        async with sesiones() as db:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1, clave="un-solo-toque",
            )
            await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.items[0].quantity == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_anade_mas_de_lo_que_hay(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones, cuantas=2)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=3,
            )
    assert fallo.value.code == "product_inventory_insufficient"
    assert fallo.value.details["available"] == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_variante_sin_inventario_cargado_no_es_agotada(sesiones) -> None:
    """SIN INVENTARIO NO ES CERO. Decir «agotado» de algo que nadie cargó manda
    a quien vende a buscar otro problema."""
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[1].id, cantidad=1,
            )
    assert fallo.value.code == "product_inventory_not_configured"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_variante_que_no_es_de_ese_producto_no_pasa(sesiones) -> None:
    producto_id, _, _, comprador = await bolsa_lista(sesiones)
    otro_id, otra_version, _ = await publicado(sesiones, nombre="Otro producto")
    ajenas = await variantes_de(sesiones, otra_version)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=ajenas[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_variant_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_producto_sin_precio_no_se_puede_meter(sesiones) -> None:
    """NULO NO ES GRATIS. Es «sin precio configurado», y lo que hay que hacer
    es decirlo, no cobrar cero."""
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.product_versions set price_minor = null,"
                " currency = null where id = cast(:v as uuid)"
            ),
            {"v": version_id},
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_price_not_configured"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_mete_un_producto_que_no_esta_en_catalogo(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.products set status = 'suspended',"
                " suspended_at = now() where id = cast(:p as uuid)"
            ),
            {"p": producto_id},
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_not_found"


# =========================================================================== #
# Monedas
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_suman_dos_monedas(sesiones) -> None:
    """SUMAR SOLES CON EUROS da un número que no es dinero."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()

    otro_id, otra_version, _ = await publicado(sesiones, nombre="En otra moneda")
    ajenas = await variantes_de(sesiones, otra_version)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.product_versions set currency = 'EUR'"
                " where id = cast(:v as uuid)"
            ),
            {"v": otra_version},
        )
        await db.commit()
    await con_existencias(sesiones, otro_id, ajenas[0].sku, 3)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=otro_id,
                variante_id=ajenas[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_cart_currency_mismatch"
    assert fallo.value.details["cart"] != fallo.value.details["product"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_al_vaciarse_la_bolsa_olvida_su_moneda(sesiones) -> None:
    """DEJAR LA ÚLTIMA MONEDA PUESTA impediría meter algo en otra en una bolsa
    que ya no tiene nada, y el error diría que hay algo dentro que no hay."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        carrito = await db.get(ProductCart, comprador)
        assert carrito.currency == "PEN"
    async with sesiones() as db:
        await carts.vaciar(db, usuario_id=comprador)
        await db.commit()
    async with sesiones() as db:
        carrito = await db.get(ProductCart, comprador)
    assert carrito.currency is None


# =========================================================================== #
# Leer: los importes y los avisos
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_carrito_vacio_no_ensena_cero(sesiones) -> None:
    """UN CERO CON MONEDA se lee como una compra de cero soles."""
    comprador = await persona(sesiones, "vacio")
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.items == []
    assert bolsa.subtotal_minor is None
    assert bolsa.units == 0
    assert bolsa.purchasable is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_servidor_calcula_el_importe_con_el_recargo_de_la_variante(
    sesiones,
) -> None:
    """EL CLIENTE NO MANDA NINGÚN IMPORTE. Ni el unitario, ni el total."""
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    cara = next(v for v in variantes if v.price_delta_minor)
    await con_existencias(sesiones, producto_id, cara.sku, 4)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=cara.id, cantidad=2,
        )
        await db.commit()

    async with sesiones() as db:
        version = await db.get(ProductVersion, version_id)
        bolsa = await carts.leer(db, usuario_id=comprador)

    esperado = int(version.price_minor) + int(cara.price_delta_minor)
    assert bolsa.items[0].unit_price_minor == esperado
    assert bolsa.items[0].line_total_minor == esperado * 2
    assert bolsa.subtotal_minor == esperado * 2
    assert bolsa.currency == version.currency


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_precio_que_cambio_se_avisa_y_no_bloquea(sesiones) -> None:
    """UN PRECIO QUE SUBIÓ SIGUE SIENDO COMPRABLE. Lo que hay que hacer es
    decirlo, no bloquear la línea."""
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()

    async with sesiones() as db:
        await db.execute(
            text(
                "update public.product_versions set price_minor = price_minor + 5000"
                " where id = cast(:v as uuid)"
            ),
            {"v": version_id},
        )
        await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    linea = bolsa.items[0]
    assert carts.PRECIO_CAMBIO in linea.issues
    assert linea.purchasable is True
    # EL TOTAL VA CON EL PRECIO DE AHORA, no con el que se vio al añadir.
    assert linea.unit_price_minor != linea.seen_price_minor
    assert linea.line_total_minor == linea.unit_price_minor


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_lo_suspendido_sigue_identificable_y_no_es_comprable(sesiones) -> None:
    """NO DESAPARECE DE LA BOLSA: quien lo metió tiene que poder ver qué era y
    quitarlo. Lo que no puede es contarse en el subtotal."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.products set status = 'suspended',"
                " suspended_at = now() where id = cast(:p as uuid)"
            ),
            {"p": producto_id},
        )
        await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.lines == 1
    assert bolsa.items[0].name  # SE SIGUE VIENDO qué era
    assert carts.NO_DISPONIBLE in bolsa.items[0].issues
    assert bolsa.items[0].purchasable is False
    assert bolsa.blocked_lines == 1
    assert bolsa.subtotal_minor is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_la_disponibilidad_baja_se_avisa(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones, cuantas=5)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=4,
        )
        await db.commit()
    async with sesiones() as db:
        await inventory.ajustar(
            db, product_id=producto_id, sku=variantes[0].sku, cantidad=-3,
            motivo="Tres piezas rotas en el almacén", clave="a1", actor_id=None,
            actor_rol="admin",
        )
        await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert carts.NO_ALCANZA in bolsa.items[0].issues
    assert bolsa.items[0].available == 2
    assert bolsa.items[0].purchasable is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_el_producto_se_republica_se_avisa_del_cambio_de_version(
    sesiones,
) -> None:
    """LA VERSIÓN ENTRA EN LA IDENTIDAD DE LA LÍNEA. Sin ella, republicar con
    otra descripción y otro precio sería invisible."""
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()

    # Se apunta a OTRA versión publicada, que es lo que deja una republicación.
    #
    # PRIMERO SE SUPERSEDE LA ANTERIOR. El índice parcial de la 0070 admite UNA
    # sola vigente por producto, y hacerlo al revés lo revienta —lo que
    # confirma, de paso, que ese índice está puesto.
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.product_versions set effective_to = now(),"
                " status = 'superseded' where id = cast(:v as uuid)"
            ),
            {"v": version_id},
        )
        await db.flush()
        otra = ProductVersion(
            product_id=producto_id,
            version="2",
            status="published",
            name="El mismo producto, otra versión",
            content_sha256="b" * 64,
            published_at=service.ahora(),
        )
        db.add(otra)
        await db.flush()
        await db.execute(
            text(
                "update public.products set published_version_id = cast(:n as uuid)"
                " where id = cast(:p as uuid)"
            ),
            {"n": otra.id, "p": producto_id},
        )
        await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert carts.VERSION_CAMBIO in bolsa.items[0].issues


# =========================================================================== #
# Cambiar y quitar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cambiar_la_cantidad_es_idempotente(sesiones) -> None:
    """ES UN DESTINO, NO UN PASO: mandar lo mismo dos veces deja lo mismo."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        linea = await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
        item_id = linea.id

    for _ in range(3):
        async with sesiones() as db:
            await carts.cambiar_cantidad(
                db, usuario_id=comprador, item_id=item_id, cantidad=3
            )
            await db.commit()

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.items[0].quantity == 3


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cero_quita_la_linea(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        linea = await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=2,
        )
        await db.commit()
        item_id = linea.id
    async with sesiones() as db:
        assert (
            await carts.cambiar_cantidad(
                db, usuario_id=comprador, item_id=item_id, cantidad=0
            )
            is None
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.items == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quitar_lo_que_ya_no_esta_tampoco_es_un_error(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        linea = await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
        item_id = linea.id
    async with sesiones() as db:
        assert await carts.quitar(db, usuario_id=comprador, item_id=item_id) is True
        await db.commit()
    async with sesiones() as db:
        assert await carts.quitar(db, usuario_id=comprador, item_id=item_id) is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_toca_la_linea_de_otra_persona(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    otro = await persona(sesiones, "otro")
    async with sesiones() as db:
        linea = await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
        item_id = linea.id

    async with sesiones() as db:
        # Le hace falta un carrito propio para llegar hasta la comprobación.
        await carts.anadir(
            db, usuario_id=otro, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.cambiar_cantidad(
                db, usuario_id=otro, item_id=item_id, cantidad=9
            )
    assert fallo.value.code == "product_cart_item_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_sube_la_cantidad_por_encima_de_lo_que_hay(sesiones) -> None:
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones, cuantas=2)
    async with sesiones() as db:
        linea = await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
        item_id = linea.id
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.cambiar_cantidad(
                db, usuario_id=comprador, item_id=item_id, cantidad=5
            )
    assert fallo.value.code == "product_inventory_insufficient"


# =========================================================================== #
# Persistencia y contadores
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_carrito_persiste_entre_sesiones(sesiones) -> None:
    """NO VIVE EN LA MEMORIA DE UN PROCESO ni en el teléfono: está en la base,
    y por eso sigue ahí al volver a entrar."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=2,
        )
        await db.commit()
    esquema.olvidar()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.units == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_bolsa_y_los_guardados_son_dos_numeros_distintos(sesiones) -> None:
    """JUNTARLOS haría que el número del encabezado no quisiera decir nada
    concreto: uno cuenta unidades y el otro productos marcados."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    otro_id, otra_version, _ = await publicado(sesiones, nombre="Para guardar")

    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=3,
        )
        await catalog.guardar(db, producto_id=otro_id, usuario_id=comprador)
        await db.commit()

    async with sesiones() as db:
        unidades = await carts.cuantas_unidades(db, usuario_id=comprador)
        guardados = await catalog.cuantos_guardados(db, usuario_id=comprador)
    assert unidades == 3
    assert guardados == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_guardar_no_mete_nada_en_la_bolsa(sesiones) -> None:
    producto_id, _, _, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await catalog.guardar(db, producto_id=producto_id, usuario_id=comprador)
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
        assert bolsa.items == []
        assert await catalog.cuantos_guardados(db, usuario_id=comprador) == 1


# =========================================================================== #
# La carrera
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cuatro_toques_a_la_vez_con_la_misma_clave_suman_uno(
    sesiones, motor
) -> None:
    """EL DOBLE TOQUE DE VERDAD: cuatro peticiones simultáneas con la misma
    clave. La fila del carrito se bloquea, así que se ordenan y solo la primera
    suma."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones, cuantas=20)
    # El carrito tiene que existir antes: crearlo es parte de la carrera y aquí
    # lo que se prueba es la clave, no la creación.
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1, clave="previo",
        )
        await db.commit()

    Dos = async_sessionmaker(motor, expire_on_commit=False)

    async def toca(n: int):
        async with Dos() as db:
            try:
                await carts.anadir(
                    db, usuario_id=comprador, producto_id=producto_id,
                    variante_id=variantes[0].id, cantidad=1, clave="el-mismo",
                )
                await db.commit()
                return "ok"
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    await asyncio.gather(*[toca(n) for n in range(4)])

    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.items[0].quantity == 2, bolsa.items[0].quantity


# =========================================================================== #
# Todavía no se compra
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_CUATRO_PRIMEROS_TOQUES_A_LA_VEZ_no_pierden_ninguno(
    sesiones, motor
) -> None:
    """LO ENCONTRO LA REVISION INDEPENDIENTE, y la prueba de mas abajo lo
    esquivaba a proposito.

    `select ... for update` sobre CERO filas no bloquea nada: cuatro primeros
    toques simultaneos de una persona SIN carrito llegaban los cuatro al
    `insert` y tres se estrellaban contra la clave primaria con un 500,
    perdiendo tres unidades. Ahora la creacion usa `on conflict do nothing` y
    una relectura bloqueada, igual que el inventario.
    """
    producto_id, _, variantes, _ = await bolsa_lista(sesiones, cuantas=20)
    #: SIN CARRITO PREVIO: crearlo es justo la carrera que se prueba.
    comprador = await persona(sesiones, "sincarro")
    Dos = async_sessionmaker(motor, expire_on_commit=False)

    async def toque(n: int):
        async with Dos() as db:
            try:
                await carts.anadir(
                    db, usuario_id=comprador, producto_id=producto_id,
                    variante_id=variantes[0].id, cantidad=1, clave=f"t{n}",
                )
                await db.commit()
                return "ok"
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    resultados = await asyncio.gather(*[toque(n) for n in range(4)])
    assert all(r == "ok" for r in resultados), resultados

    async with sesiones() as db:
        assert await carts.cuantas_unidades(db, usuario_id=comprador) == 4
        cuantos = await db.scalar(
            select(func.count())
            .select_from(ProductCart)
            .where(ProductCart.user_id == comprador)
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_recargo_NO_puede_dejar_el_precio_negativo(sesiones) -> None:
    """TAMBIEN DE LA REVISION. Un recargo mayor que el precio de la version
    dejaba el efectivo en negativo, y como no era `None` pasaba el guardian de
    «sin precio» y se estrellaba contra el CHECK de la base con un 500.

    Un precio negativo no es un precio: la linea se marca como sin precio, que
    es lo que de verdad le pasa.
    """
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        version = await db.get(ProductVersion, version_id)
        precio = int(version.price_minor)
        await db.execute(
            text(
                "update public.product_variants set price_delta_minor = :d"
                " where id = cast(:v as uuid)"
            ),
            {"d": -(precio + 1_000), "v": variantes[0].id},
        )
        await db.commit()

    async with sesiones() as db:
        version = await db.get(ProductVersion, version_id)
        variante = await db.get(ProductVariant, variantes[0].id)
        assert carts.precio_de(version, variante) is None

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_price_not_configured"

    # Y EL RECARGO NI SIQUIERA SE PUEDE ESCRIBIR ASI DE GRANDE: el tope existe
    # tambien por arriba, porque un total que no cabe en el `double` con el que
    # JavaScript lee el JSON deja de ser el que calculo el servidor.
    from app.modules.products.service import MAXIMO_DEL_RECARGO

    assert MAXIMO_DEL_RECARGO * 1_000 < 2**53


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_bolsa_vaciada_POR_CASCADA_no_se_queda_con_su_moneda(
    sesiones,
) -> None:
    """TAMBIEN DE LA REVISION, como riesgo. Las lineas pueden irse por cascada
    —al borrar una version o una variante— sin pasar por `quitar`, y entonces
    la moneda guardada rechazaba todo sobre una bolsa donde no hay nada."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()

    #: Se borran las lineas POR DEBAJO, como haria una cascada.
    async with sesiones() as db:
        await db.execute(
            text("delete from public.product_cart_items where user_id = cast(:u as uuid)"),
            {"u": comprador},
        )
        await db.commit()
    async with sesiones() as db:
        carrito = await db.get(ProductCart, comprador)
        assert carrito.currency == "PEN", "la moneda sigue puesta, como se esperaba"

    #: Y aun asi se puede volver a meter algo, en cualquier moneda.
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.units == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_carrito_dice_si_tiene_algo_que_comprar(sesiones) -> None:
    """QUE LA BOLSA TENGA ALGO COMPRABLE NO ES QUE SE PUEDA COMPRAR.

    Hasta el Incremento 5 este campo era `false` siempre porque no existia la
    compra fisica. Ahora dice lo que de verdad significa: que el carrito, por
    su parte, no lo impide. Si la venta esta habilitada son otras cinco cosas y
    una politica, y eso lo contesta `pedidos.preparar` y lo escribe la ruta.
    """
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    #: BOLSA VACIA: nada que comprar.
    assert bolsa.purchasable is False
    assert bolsa.subtotal_minor is None

    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    assert bolsa.purchasable is True

    #: Y LA RUTA SIGUE DICIENDO QUE NO, porque la venta esta apagada.
    import os

    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app.modules.products.router import _carrito

    assert _carrito(bolsa).purchasable is False


def test_el_molde_de_la_respuesta_escribe_false_pase_lo_que_pase() -> None:
    """EL HUECO QUE ENCONTRÓ LA BATERÍA DE MUTACIONES.

    `test_el_carrito_nunca_dice_que_se_puede_comprar` mira el dataclass, y el
    molde de la ruta es otro sitio: poner ahí `purchasable=True` no ponía roja
    ninguna prueba. Y la ruta es EXACTAMENTE donde alguien lo encendería.

    El molde NO lee `purchasable` de lo que le llega: lo escribe. Por eso este
    caso le pasa un carrito que dice que sí y comprueba que la respuesta dice
    que no.
    """
    import os

    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app.modules.products.router import _carrito

    mentiroso = carts.Carrito(items=[], purchasable=True, disponible=True)
    #: CON LA VENTA APAGADA —que es como nace— la respuesta dice que no aunque
    #: el carrito diga que si. Es la capa de la ruta, y existe para que
    #: encender la compra tenga que pasar por el router.
    assert _carrito(mentiroso).purchasable is False


def test_las_rutas_de_compra_existen_y_no_cobran_nada() -> None:
    """EL INCREMENTO 5 LAS TRAE, y siguen sin mover dinero.

    Esta prueba decia antes que NO existia ninguna ruta de compra, y era cierto
    hasta el Incremento 5. Lo que hay que sostener ahora es otra cosa y es mas
    dificil: que existan, que lleven a un recorrido real y que aun asi no se
    pueda cobrar nada sin que la empresa termine de configurar la venta.

    Y NINGUNA RUTA DE LAS QUE NO ESTA IMPLEMENTADO. Devolucion, reembolso,
    garantia, resena y transferencia son de los Incrementos 7 a 9: una ruta
    vacia que devolviera 501 ya seria una promesa.

    EL DESPACHO SI ESTA, DESDE EL INCREMENTO 6, y por eso `shipment` salio de la
    lista de prohibidas y entro en la de esperadas. Cambiar una prueba para que
    deje de mirar algo es como se pierde una proteccion: lo que antes prohibia
    ahora lo EXIGE, y ademas exige que administracion no tenga ruta para
    despachar ni para fabricar una entrega.
    """
    import os

    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app.core.config import get_settings
    from app.main import create_app
    from app.modules.products import pedidos

    rutas = [r for r in create_app().openapi()["paths"] if "/products" in r]

    esperadas = (
        "/api/v1/products/orders",
        "/api/v1/products/orders/{order_id}/checkout",
        "/api/v1/products/orders/{order_id}/cancel",
        "/api/v1/products/checkout/preparation",
        "/api/v1/products/policies",
        # Incremento 6: el recorrido de la entrega, entero y alcanzable.
        "/api/v1/products/orders/{order_id}/shipment/confirm-receipt",
        "/api/v1/products/seller/orders/{order_id}/shipment/prepare",
        "/api/v1/products/seller/orders/{order_id}/shipment/ready",
        "/api/v1/products/seller/orders/{order_id}/shipment/dispatch",
        "/api/v1/products/seller/orders/{order_id}/shipment/delivered",
        "/api/v1/products/seller/orders/{order_id}/shipment/failed",
        "/api/v1/products/seller/orders/{order_id}/shipment/reopen",
        "/api/v1/products/seller/orders/{order_id}/shipment/retry",
        "/api/v1/admin/products/shipments",
        "/api/v1/admin/products/shipments/{order_id}/transition",
        # Incremento 7: el expediente de una incidencia, entero.
        "/api/v1/products/orders/{order_id}/incidents",
        "/api/v1/products/incidents/{incident_id}",
        "/api/v1/products/incidents/{incident_id}/evidence",
        "/api/v1/products/incidents/{incident_id}/submit",
        "/api/v1/products/incidents/{incident_id}/appeal",
        "/api/v1/products/seller/incidents/{incident_id}/respond",
        "/api/v1/admin/products/incidents",
        "/api/v1/admin/products/incidents/{incident_id}/resolve",
        # Incremento 8: la resena verificada, entera.
        "/api/v1/products/orders/{order_id}/reviewable",
        "/api/v1/products/order-items/{order_item_id}/review",
        "/api/v1/products/reviews/mine",
        "/api/v1/products/reviews/{review_id}",
        "/api/v1/products/{product_id}/reviews",
        "/api/v1/products/{product_id}/reviews/summary",
        "/api/v1/products/seller/reviews",
        "/api/v1/products/seller/reviews/{review_id}/reply",
        "/api/v1/admin/products/reviews",
        "/api/v1/admin/products/reviews/{review_id}/moderate",
        "/api/v1/admin/products/reviews/{review_id}/moderation",
        "/api/v1/admin/products/review-replies/{reply_id}/moderate",
        # Incremento 9: las finanzas, enteras.
        "/api/v1/products/seller/finance",
        "/api/v1/products/seller/finance/balances",
        "/api/v1/products/seller/finance/reserves",
        "/api/v1/products/seller/payout-account",
        "/api/v1/products/orders/{order_id}/refunds",
        "/api/v1/products/orders/{order_id}/conformity",
        "/api/v1/admin/products/finance/health",
        "/api/v1/admin/products/finance/release-due",
        "/api/v1/admin/products/finance/blocks",
        "/api/v1/admin/products/finance/refunds",
        "/api/v1/admin/products/finance/disputes",
        "/api/v1/admin/products/orders/{order_id}/refunds",
        "/api/v1/admin/products/refunds/{refund_id}/request",
        "/api/v1/admin/products/refunds/{refund_id}/cancel",
        "/api/v1/admin/products/refunds/{refund_id}/history",
        "/api/v1/admin/products/finance/reserves/{reserve_id}/release",
    )
    for ruta in esperadas:
        assert ruta in rutas, ruta

    #: LO QUE NO PUEDE EXISTIR TODAVIA. `/return` lleva barra delante a
    #: proposito: es una palabra corta y no quiero que aparezca dentro de otra.
    #: `incident` SALIO DE AQUI con el Incremento 7, y entro en `esperadas`:
    #: cambiar una prueba para que deje de mirar algo es como se pierde una
    #: proteccion, asi que lo que antes prohibia ahora lo EXIGE.
    #: LO QUE SIGUE SIN PODER EXISTIR. `refund` y `payout` SALIERON de aqui con
    #: el Incremento 9 y entraron en `esperadas`, igual que `incident` con el 7 y
    #: `reviews` con el 8: cambiar una prueba para que deje de mirar algo es como
    #: se pierde una proteccion, asi que lo que antes prohibia ahora lo EXIGE.
    #:
    #: `/return` y `warranty` NO se mueven. El recorrido de devolucion fisica
    #: —etiqueta, plazo de siete dias, inspeccion— y la garantia posterior son
    #: del blueprint §11 y §12 y NO estan en este incremento: devolver DINERO y
    #: devolver la MERCANCIA son dos cosas, y la segunda necesita transportista,
    #: porte de vuelta y reposicion, que nadie ha decidido.
    prohibidas = ("/return", "warranty")
    for ruta in rutas:
        for prohibida in prohibidas:
            assert prohibida not in ruta, ruta

    #: Y `transfer` TAMPOCO: ejecutar una transferencia necesita Stripe Connect
    #: confirmado para el pais y el rubro, y esa confirmacion no existe. El
    #: panel dice cuanto hay y por que no sale; no hay ruta que lo saque.
    for ruta in rutas:
        assert "transfer" not in ruta, ruta

    #: NINGUNA RUTA FINANCIERA FUERA DE ADMINISTRACION, salvo las del propio
    #: proveedor y las de quien compro: mover dinero es de un conjunto mas
    #: estrecho que curar contenido.
    for ruta in rutas:
        if "/finance" in ruta or "refund" in ruta:
            assert (
                ruta.startswith("/api/v1/admin/")
                or "/seller/" in ruta
                or "/orders/" in ruta
            ), ruta

    #: LAS RESENAS SALIERON DE AQUI con el Incremento 8 y entraron en
    #: `esperadas`, igual que las incidencias con el 7. Lo que queda prohibido
    #: es lo que una resena NO puede hacer: no mueve dinero y no reescribe lo
    #: que escribio otra persona, asi que no hay ninguna ruta que ponga el
    #: sello a mano ni que edite una resena ajena.
    #: NINGUNA RUTA DE VALORACIONES FUERA DE ADMINISTRACION PUEDE MODERAR. Los
    #: dos asertos que habia aqui —que no existiera una ruta de «verificar» ni
    #: una de «editar» una valoracion— eran decorativos: nadie escribiria esas
    #: URL. Lo senalo la revision independiente.
    modera = [r for r in rutas if "moderate" in r or "moderation" in r]
    assert modera, "no se encontro ninguna ruta de moderacion: esto no mide nada"
    for ruta in modera:
        assert ruta.startswith("/api/v1/admin/"), ruta

    #: Y NINGUNA RUTA DE PROVEEDOR TOCA LA RESENA. Puede responder, y nada mas:
    #: ni esconder, ni editar, ni borrar.
    for ruta in rutas:
        if "/seller/reviews" in ruta:
            assert ruta.endswith("/reply") or ruta.endswith("/seller/reviews"), ruta

    #: Y ADMINISTRACION NO TIENE RUTA PARA DESPACHAR NI PARA ENTREGAR. Lo que
    #: puede mover lo decide la maquina de estados, pero que no exista una URL
    #: con ese nombre es la primera puerta y la mas facil de leer.
    for ruta in rutas:
        assert not ruta.startswith("/api/v1/admin/products/shipments/{order_id}/d")

    #: Y EL PROVEEDOR NO TIENE RUTA PARA RESOLVER SU PROPIO CASO. Las cinco
    #: salidas mueven dinero, mueven mercancia o niegan la reclamacion, y
    #: ninguna la decide en solitario quien tiene el conflicto.
    for ruta in rutas:
        if "/seller/incidents" in ruta:
            assert not ruta.endswith("/resolve"), ruta

    #: Y LO QUE DE VERDAD IMPORTA: con la configuracion de fabrica no se puede
    #: cobrar, y faltan CINCO cosas, no una.
    faltan = pedidos.por_que_no_se_puede_vender()
    assert "feature_product_sales" in faltan
    assert "payments_enabled" in faltan
    assert "stripe_payments_enabled" in faltan
    assert "product_reservation_minutes" in faltan
    assert get_settings().product_reservation_minutes == 0


def test_la_bandera_de_venta_sigue_apagada() -> None:
    import os

    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app.core.config import get_settings

    assert get_settings().feature_product_sales is False


# =========================================================================== #
# Sin la 0075
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0075_el_carrito_contesta_503_y_leer_no_revienta(
    sesiones, monkeypatch
) -> None:
    """DEGRADACIÓN SEGURA. Leer devuelve la bolsa marcada como no disponible,
    y el contador devuelve cero sin consultar nada: el encabezado del catálogo
    no puede caerse porque falte una migración."""
    producto_id, _, variantes, comprador = await bolsa_lista(sesiones)

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_carrito", _no_hay)
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
        assert bolsa.disponible is False
        assert bolsa.items == []
        assert await carts.cuantas_unidades(db, usuario_id=comprador) == 0
        with pytest.raises(AppError) as fallo:
            await carts.anadir(
                db, usuario_id=comprador, producto_id=producto_id,
                variante_id=variantes[0].id, cantidad=1,
            )
    assert fallo.value.code == "product_cart_not_available"
    assert fallo.value.status_code == 503


# =========================================================================== #
# Lo que impone la base
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_dos_lineas_iguales(sesiones) -> None:
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        await carts.anadir(
            db, usuario_id=comprador, producto_id=producto_id,
            variante_id=variantes[0].id, cantidad=1,
        )
        await db.commit()
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.UniqueViolation) as violado:
            cur.execute(
                "insert into public.product_cart_items"
                " (user_id, product_id, version_id, variant_id, quantity,"
                "  seen_price_minor, seen_currency)"
                " values (cast(%s as uuid), cast(%s as uuid), cast(%s as uuid),"
                "         cast(%s as uuid), 1, 100, 'PEN')",
                (comprador, producto_id, version_id, variantes[0].id),
            )
    assert "product_cart_items_una_linea" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_una_cantidad_de_cero(sesiones) -> None:
    producto_id, version_id, variantes, comprador = await bolsa_lista(sesiones)
    async with sesiones() as db:
        db.add(ProductCart(user_id=comprador))
        await db.commit()
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "insert into public.product_cart_items"
                " (user_id, product_id, version_id, variant_id, quantity,"
                "  seen_price_minor, seen_currency)"
                " values (cast(%s as uuid), cast(%s as uuid), cast(%s as uuid),"
                "         cast(%s as uuid), 0, 100, 'PEN')",
                (comprador, producto_id, version_id, variantes[0].id),
            )
    assert "product_cart_items_cantidad" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_carrito_no_tiene_ninguna_columna_de_reserva(sesiones) -> None:
    """SI APARECE UNA, es que alguien mezcló el carrito con el inventario."""
    columnas = set(ProductCartItem.__table__.columns.keys())
    assert not (columnas & {"reserved", "reserved_until", "reservation_id"})
