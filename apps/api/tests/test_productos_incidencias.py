"""Incremento 7 de Productos: incidencias. La 0080, contra PostgreSQL.

LO QUE DEFIENDEN ESTAS PRUEBAS, Y POR QUE CADA UNA:

  1. ABRIR NO ES APROBAR. No hay ningun camino de abrir a un reembolso.
  2. RESOLVER NO ES PAGAR. Una resolucion deja el efecto PENDIENTE y no se
     llama a ningun adaptador de reembolsos.
  3. EL PROVEEDOR PROPONE; RESOLVER ES DE Z. No hay forma de que quien tiene el
     conflicto escriba la resolucion de su propio caso.
  4. NADA VUELVE AL ALMACEN. Ni al abrir, ni al responder, ni al resolver, ni
     con una resolucion de reposicion.
  5. UN CASO VIVO BLOQUEA LO INCOMPATIBLE: no se confirma una recepcion
     mientras se discute si el paquete llego, y no se abren dos casos vivos
     sobre la misma linea.
  6. EL SILENCIO NO CIERRA NADA: pasa a mediacion, y el barrido es idempotente.
  7. EL RELOJ DEL PROVEEDOR NO CORRE MIENTRAS ESPERA lo que el mismo pidio.
  8. UNA SOLA APELACION, en plazo y CON EVIDENCIA NUEVA.
  9. EL EXPEDIENTE NO SE REESCRIBE: ni el historial ni la evidencia.
 10. NO SE RECLAMA SOBRE ALGO QUE NO SALIO DEL ALMACEN.
 11. LO AJENO ES UN 404, para quien compra y para quien vende.
 12. LA AUDITORIA COMPARTIDA NO SE LLEVA EL TEXTO DE LA DISPUTA.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text

from app.core.exceptions import AppError
from app.modules.products import envios, esquema, estados_de_envio, incidencias
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products import inventory
from app.modules.products.models import (
    HORAS_PARA_RESPONDER,
    InventoryMovement,
    ProductIncident,
    ProductIncidentEvent,
    ProductIncidentEvidence,
    ProductOrder,
)
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)
from tests.test_productos_envios import (  # noqa: F401
    duenno_de,
    pedido_pagado,
    preparar_entero,
)
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    PasarelaDeMentira,
    bolsa_con,
    crear_pedido,
    motor,
    politica_publicada,
    venta_encendida,
)

DESCRIPCION = "Llego con el cristal roto y la caja aplastada por un lado."


# =========================================================================== #
# Montaje
# =========================================================================== #
async def pedido_entregado(sesiones, monkeypatch, **kwargs):
    """Un pedido pagado, preparado, despachado y ENTREGADO por el camino real."""
    producto_id, variantes, comprador, orden_id = await pedido_pagado(
        sesiones, monkeypatch, **kwargs
    )
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
        )
        await db.commit()
    return producto_id, variantes, comprador, orden_id, quien


async def primera_linea(sesiones, orden_id: str) -> str:
    from app.modules.products import pedidos

    async with sesiones() as db:
        return (await pedidos.lineas_de(db, orden_id))[0].id


def imagen(color: int = 200) -> bytes:
    """Un PNG de verdad. NO UNA CABECERA PEGADA: el servidor abre la imagen."""
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (color, color, color)).save(buffer, format="PNG")
    return buffer.getvalue()


async def caso_abierto(sesiones, monkeypatch, *, motivo=maquina.DANADO, enviar=True):
    """Un caso abierto, con sus dos fotografias y enviado."""
    from app.modules.products import media as fotos

    producto_id, variantes, comprador, orden_id, quien = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = None if motivo == maquina.ENTREGA_NEGADA else await primera_linea(
        sesiones, orden_id
    )
    async with sesiones() as db:
        caso = await incidencias.abrir(
            db,
            orden_id=orden_id,
            usuario_id=comprador,
            motivo=motivo,
            descripcion=DESCRIPCION,
            order_item_id=linea,
        )
        await db.commit()
        caso_id = caso.id

    if motivo != maquina.ENTREGA_NEGADA:
        for tono in (180, 220):
            async with sesiones() as db:
                fila = await db.get(ProductIncident, caso_id)
                await incidencias.anadir_prueba(
                    db,
                    caso=fila,
                    medida=fotos.medir(imagen(tono)),
                    actor_id=comprador,
                    actor_rol="buyer",
                )
                await db.commit()

    if enviar:
        async with sesiones() as db:
            fila = await db.get(ProductIncident, caso_id)
            await incidencias.enviar(db, caso=fila, usuario_id=comprador)
            await db.commit()

    return producto_id, variantes, comprador, orden_id, quien, caso_id


# =========================================================================== #
# 0. La maquina, sola. SIN BASE DE DATOS
# =========================================================================== #
def test_no_hay_ningun_camino_de_abrir_a_resolver_para_el_proveedor() -> None:
    """EL PROVEEDOR PROPONE; RESOLVER ES DE Z.

    Las cinco salidas mueven dinero, mueven mercancia o niegan la reclamacion,
    y ninguna de las tres puede decidirla en solitario quien tiene el
    conflicto. Se comprueba sobre TODA la maquina, no sobre un salto.
    """
    for (desde, hasta), quienes in maquina.TRANSICIONES.items():
        if hasta == maquina.RESUELTA:
            assert quienes == frozenset({maquina.ADMINISTRACION}), (desde, hasta)
            assert maquina.PROVEEDOR not in quienes


def test_el_silencio_no_cierra_nada() -> None:
    """DESDE ABIERTA NO SE VA A RESUELTA NI A RETIRADA POR EL SISTEMA.

    Que el proveedor no conteste no significa que tenga razon ni que no la
    tenga: lo unico que puede hacer el sistema es mandarlo a mediacion.
    """
    del_sistema = [
        hasta
        for (desde, hasta), quienes in maquina.TRANSICIONES.items()
        if maquina.SISTEMA in quienes
    ]
    assert set(del_sistema) == {maquina.MEDIACION}


def test_pedir_mas_evidencia_no_es_una_salida() -> None:
    """UN EXPEDIENTE AL QUE SE LE PIDE MAS EVIDENCIA NO ESTA RESUELTO.

    Contarlo como resolucion daria un numero falso el dia que alguien cuente
    cuantos casos se resolvieron.
    """
    assert maquina.PEDIR_MAS_EVIDENCIA not in maquina.RESOLUCIONES
    assert maquina.PEDIR_MAS_EVIDENCIA in maquina.PROPUESTAS
    assert len(maquina.RESOLUCIONES) == 5


def test_ya_no_lo_quiero_no_es_un_motivo() -> None:
    """ES DESISTIMIENTO, NO UN DEFECTO. Lo dice el blueprint §10 con esas
    palabras, y tiene plazos y consecuencias distintas."""
    for inventado in ("CHANGED_MY_MIND", "REMORSE", "NO_LONGER_WANTED"):
        assert inventado not in maquina.MOTIVOS


def test_la_entrega_negada_no_puede_pedir_fotografias() -> None:
    """NO HAY NADA QUE FOTOGRAFIAR: el paquete no esta.

    Exigirlas convertiria el unico recurso de quien no recibio nada en un
    requisito imposible.
    """
    assert maquina.fotos_exigidas(maquina.ENTREGA_NEGADA) == 0
    for motivo in maquina.MOTIVOS_DEL_PRODUCTO:
        assert maquina.fotos_exigidas(motivo) == maquina.FOTOS_MINIMAS


def test_lo_que_bloquea_el_dinero_incluye_lo_ya_resuelto_y_sin_pagar() -> None:
    """LA SEGUNDA ES LA QUE SE OLVIDA.

    Un caso vivo bloquea, evidentemente. Pero tambien uno YA RESUELTO cuya
    resolucion dejo algo debiendo y no se ha ejecutado: liberar el dinero al
    proveedor con un reembolso aprobado y sin pagar es pagarle dos veces.
    """
    for vivo in maquina.VIVAS:
        assert maquina.bloquea_el_dinero(vivo, None, None) is True

    assert (
        maquina.bloquea_el_dinero(
            maquina.RESUELTA,
            maquina.REEMBOLSAR_TODO_SIN_DEVOLVER,
            maquina.EFECTO_PENDIENTE,
        )
        is True
    )
    #: RECHAZAR NO DEBE NADA, asi que no bloquea.
    assert (
        maquina.bloquea_el_dinero(
            maquina.RESUELTA, maquina.RECHAZAR, maquina.EFECTO_NO_APLICA
        )
        is False
    )
    #: Y UNA RETIRADA TAMPOCO.
    assert maquina.bloquea_el_dinero(maquina.RETIRADA, None, None) is False


def test_este_modulo_no_sabe_tocar_el_inventario() -> None:
    """NADA VUELVE AL ALMACEN POR SU CUENTA, y se comprueba en el fichero.

    Es la clase de regla que se rompe anadiendo un import «solo para esto».
    Donde esta una unidad dañada lo decide una persona; reponerla aqui la
    pondria a la venta estando en casa de alguien.
    """
    import ast
    from pathlib import Path

    arbol = ast.parse(Path(incidencias.__file__).read_text(encoding="utf-8"))

    #: SE MIRA EL ARBOL, NO EL TEXTO. Las cabeceras de este modulo hablan del
    #: inventario y de los reembolsos precisamente para explicar por que NO los
    #: toca; una busqueda de texto encontraria esas explicaciones y se pondria
    #: roja por el comentario que la justifica.
    importados: set[str] = set()
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Import):
            importados.update(a.name for a in nodo.names)
        elif isinstance(nodo, ast.ImportFrom) and nodo.module:
            importados.add(nodo.module)
            importados.update(f"{nodo.module}.{a.name}" for a in nodo.names)
    for prohibido in ("inventory", "refunds", "payments", "stripe"):
        culpables = sorted(i for i in importados if prohibido in i)
        assert not culpables, f"importa «{prohibido}»: {culpables}"

    #: Y NINGUNA LLAMADA A NADA QUE MUEVA EL ALMACEN.
    llamadas = {
        nodo.func.attr
        for nodo in ast.walk(arbol)
        if isinstance(nodo, ast.Call) and isinstance(nodo.func, ast.Attribute)
    }
    for prohibida in ("despachar", "liberar", "reservar", "entrada", "ajustar"):
        assert prohibida not in llamadas, f"llama a «{prohibida}»"


# =========================================================================== #
# 1. Abrir no es aprobar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_abrir_no_mueve_nada(sesiones, venta_encendida, monkeypatch) -> None:
    """NI EL ALMACEN, NI EL PEDIDO, NI EL ENVIO.

    Abrir un caso solo anota que alguien dice que algo llego mal.
    """
    producto_id, variantes, comprador, orden_id, _, caso_id = await caso_abierto(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        envio = await envios.del_pedido(db, orden=orden)
    assert caso.status == maquina.ABIERTA
    assert caso.resolution is None
    assert caso.financial_effect is None, "abrir no decide ningun efecto"
    assert orden.status == "PAID", "el pedido sigue pagado"
    assert envio.status == estados_de_envio.ENTREGADO, "el envio sigue entregado"
    assert (hay.on_hand, hay.reserved) == (3, 0), "el almacen no se entero"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_las_dos_fotografias_el_caso_no_se_envia(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """«2-6 fotografias», literal del blueprint §10."""
    #: EL CASO SE MONTA CON UNA SOLA FOTO, no con dos y quitando una: la
    #: evidencia NO SE PUEDE BORRAR —lo impide un disparador, y esta bien que
    #: lo impida—, asi que el montaje tiene que llegar a este estado por el
    #: camino real, que es no haber subido la segunda.
    from app.modules.products import media as fotos

    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    async with sesiones() as db:
        creado = await incidencias.abrir(
            db,
            orden_id=orden_id,
            usuario_id=comprador,
            motivo=maquina.DANADO,
            descripcion=DESCRIPCION,
            order_item_id=linea,
        )
        await db.commit()
        caso_id = creado.id
    async with sesiones() as db:
        fila = await db.get(ProductIncident, caso_id)
        await incidencias.anadir_prueba(
            db,
            caso=fila,
            medida=fotos.medir(imagen(150)),
            actor_id=comprador,
            actor_rol="buyer",
        )
        await db.commit()

    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        with pytest.raises(incidencias.FaltaEvidencia) as fallo:
            await incidencias.enviar(db, caso=caso, usuario_id=comprador)
        await db.rollback()
    assert fallo.value.details["required"] == 2
    assert fallo.value.details["current"] == 1

    #: Y EL PLAZO DEL PROVEEDOR NO EMPEZO: no se le puede correr el reloj por un
    #: caso que todavia no ha recibido.
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.seller_response_due_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_entrega_negada_se_envia_sin_fotografias(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO HAY NADA QUE FOTOGRAFIAR. Exigirlas dejaria sin recurso a quien no
    recibio nada, que es justo quien mas lo necesita."""
    _, _, _, _, _, caso_id = await caso_abierto(
        sesiones, monkeypatch, motivo=maquina.ENTREGA_NEGADA
    )
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        cuantas = await incidencias.cuantas_pruebas(db, incidencia_id=caso_id)
    assert cuantas == 0
    assert caso.seller_response_due_at is not None, "se envio igual"
    assert caso.order_item_id is None, "es el caso de todo el pedido"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_reclama_sobre_algo_que_no_salio(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """UNA INCIDENCIA HABLA DE COMO LLEGO EL PRODUCTO.

    Si el paquete sigue en el almacen, lo que hay que mirar es el envio, y
    decirlo asi ahorra que alguien abra un caso contra quien todavia no ha
    hecho nada mal.
    """
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    async with sesiones() as db:
        with pytest.raises(incidencias.NoHayNadaQueReclamar) as fallo:
            await incidencias.abrir(
                db,
                orden_id=orden_id,
                usuario_id=comprador,
                motivo=maquina.DANADO,
                descripcion=DESCRIPCION,
                order_item_id=linea,
            )
        await db.rollback()
    assert fallo.value.details["shipment_status"] == "PENDING"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_abren_dos_casos_vivos_sobre_la_misma_linea(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LO IMPIDE UN INDICE UNICO PARCIAL, no un `if` nuestro: dos toques a la
    vez se pasarian por delante de cualquier comprobacion previa."""
    _, _, comprador, orden_id, _, _ = await caso_abierto(sesiones, monkeypatch)
    linea = await primera_linea(sesiones, orden_id)
    async with sesiones() as db:
        with pytest.raises(incidencias.YaHayUnCaso):
            await incidencias.abrir(
                db,
                orden_id=orden_id,
                usuario_id=comprador,
                motivo=maquina.FALTAN_PIEZAS,
                descripcion=DESCRIPCION,
                order_item_id=linea,
            )
        await db.rollback()


# =========================================================================== #
# 2. El bloqueo cruzado
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_un_caso_vivo_no_se_confirma_la_recepcion(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """QUIEN DICE QUE NO LE LLEGO NO PUEDE CONFIRMAR QUE LO RECIBIO.

    Dos afirmaciones contrarias del mismo pedido dejarian un expediente donde
    quien reclama se desmiente solo, y eso lo usaria la otra parte para cerrar
    el caso sin mirarlo.
    """
    _, _, comprador, orden_id, _, caso_id = await caso_abierto(
        sesiones, monkeypatch, motivo=maquina.ENTREGA_NEGADA
    )
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(AppError) as fallo:
            await envios.registrar_entrega(
                db,
                orden=orden,
                actor_id=comprador,
                actor_rol=estados_de_envio.COMPRADOR,
            )
        await db.rollback()
    assert fallo.value.code == "product_shipment_incident_open"

    #: Y RETIRANDO EL CASO SI SE PUEDE: retirar deja rastro de que se retiro.
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RETIRADA,
            actor_id=comprador,
            actor_rol=maquina.COMPRADOR,
            nota="Aparecio en la conserjeria",
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=comprador,
            actor_rol=estados_de_envio.COMPRADOR,
        )
        await db.commit()
    assert envio.buyer_confirmed_at is not None


# =========================================================================== #
# 3. El reloj del proveedor
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_plazo_empieza_al_enviar_y_dura_48_horas(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """«48 HORAS EXACTAS DESDE LA NOTIFICACION», literal del blueprint §10.1."""
    _, _, _, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.seller_response_due_at is not None
    margen = caso.seller_response_due_at - caso.created_at
    assert timedelta(hours=HORAS_PARA_RESPONDER - 1) < margen
    assert margen < timedelta(hours=HORAS_PARA_RESPONDER + 1)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_pedir_evidencia_para_el_reloj_del_proveedor(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO SE LE PUEDE COBRAR AL PROVEEDOR EL TIEMPO DE LA OTRA PARTE.

    Y al volver la pelota, el plazo EMPIEZA DE NUEVO: arrancar con el tiempo ya
    gastado seria darle menos del que tiene.
    """
    _, _, comprador, _, quien, caso_id = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MAS_EVIDENCIA,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
            nota="Manda una foto de la etiqueta del paquete",
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.status == maquina.MAS_EVIDENCIA
    assert caso.seller_response_due_at is None, "su reloj se paro"
    assert caso.seller_proposal == "REQUEST_MORE_EVIDENCE"

    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.ABIERTA,
            actor_id=comprador,
            actor_rol=maquina.COMPRADOR,
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.status == maquina.ABIERTA
    assert caso.seller_response_due_at is not None, "y vuelve a correr entero"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_silencio_lleva_a_mediacion_y_el_barrido_es_idempotente(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO A «RECHAZADO» NI A «ACEPTADO». Que el proveedor no conteste no
    significa que tenga razon ni que no la tenga."""
    _, _, _, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await db.execute(
            text(
                "update product_incidents set seller_response_due_at = now() -"
                " interval '1 hour' where id = cast(:i as uuid)"
            ),
            {"i": caso_id},
        )
        await db.commit()

    async with sesiones() as db:
        escalados = await incidencias.escalar_las_vencidas(db)
    assert escalados >= 1

    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.status == maquina.MEDIACION
    assert caso.resolution is None, "el silencio no resuelve nada"

    #: IDEMPOTENTE: la segunda vez ya no queda ninguno.
    async with sesiones() as db:
        otra_vez = await incidencias.escalar_las_vencidas(db)
    assert otra_vez == 0

    #: Y EL HISTORIAL LO DICE, con el sistema como actor.
    async with sesiones() as db:
        renglon = (
            await db.scalars(
                select(ProductIncidentEvent).where(
                    ProductIncidentEvent.incident_id == caso_id,
                    ProductIncidentEvent.to_status == maquina.MEDIACION,
                )
            )
        ).one()
    assert renglon.actor_role == "system"


# =========================================================================== #
# 4. Resolver no es pagar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_resolver_deja_el_efecto_pendiente_y_no_mueve_nada(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA REGLA CENTRAL DEL INCREMENTO.

    Una resolucion dice QUE SE DECIDIO. Que el dinero se haya movido es del
    Incremento 9 y no existe: el efecto nace PENDIENTE y nadie lo ejecuta.
    """
    producto_id, variantes, _, _, quien, caso_id = await caso_abierto(
        sesiones, monkeypatch
    )
    manda = await persona(sesiones, "media1")

    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESPONDIDA,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
            propuesta=maquina.REEMBOLSAR_TODO_SIN_DEVOLVER,
            nota="Lo siento, mandamos otro",
        )
        await db.commit()
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.REEMBOLSAR_TODO_SIN_DEVOLVER,
            nota="La evidencia demuestra el dano en transito",
        )
        await db.commit()

    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        movimientos = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
    assert caso.status == maquina.RESUELTA
    assert caso.resolution == maquina.REEMBOLSAR_TODO_SIN_DEVOLVER
    assert caso.financial_effect == maquina.EFECTO_PENDIENTE, "NADIE lo ejecuto"
    assert caso.resolved_by == manda
    assert (hay.on_hand, hay.reserved) == (3, 0), "el almacen no se entero"
    #: TRES, Y LOS TRES SON ANTERIORES A LA INCIDENCIA: la entrada que cargo
    #: las existencias, la reserva del pedido y la salida del despacho. La
    #: incidencia no anadio ninguno, que es exactamente lo que se comprueba.
    assert movimientos == 3, "la incidencia escribio un movimiento de almacen"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_reponer_no_saca_nada_del_almacen(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """UNA RESOLUCION DE REPOSICION NO DESPACHA NADA.

    Sacar la unidad aqui la venderia dos veces: lo que hay que hacer es un
    pedido nuevo, y eso lo decide una persona.
    """
    producto_id, variantes, _, _, quien, caso_id = await caso_abierto(
        sesiones, monkeypatch
    )
    manda = await persona(sesiones, "media2")
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MEDIACION,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
        )
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.REPONER,
            nota="Se le manda otro igual",
        )
        await db.commit()
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        caso = await db.get(ProductIncident, caso_id)
    assert (hay.on_hand, hay.reserved) == (3, 0)
    #: REPONER DEJA MERCANCIA DEBIENDO, asi que tambien bloquea el dinero.
    assert caso.financial_effect == maquina.EFECTO_PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_rechazar_no_deja_nada_debiendo(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """RECHAZAR LA RECLAMACION NO DEBE DINERO NI MERCANCIA, y por eso no
    bloquea el saldo. Dejarlo bloqueado seria castigar al proveedor por un caso
    que se decidio a su favor."""
    _, _, _, orden_id, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    manda = await persona(sesiones, "media3")
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MEDIACION,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
        )
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.RECHAZAR,
            nota="Las fotografias no muestran ningun dano",
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        bloquea = await incidencias.bloquea_el_dinero(db, orden_id=orden_id)
    assert caso.financial_effect == maquina.EFECTO_NO_APLICA
    assert bloquea is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_caso_vivo_bloquea_el_dinero_de_su_pedido(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LO QUE LEERA EL INCREMENTO 9. No lo llama nadie todavia, y por eso hay
    que probarlo: codigo que nadie ejercita es codigo que nadie comprueba."""
    _, _, _, orden_id, _, _ = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        assert await incidencias.bloquea_el_dinero(db, orden_id=orden_id) is True
        assert await incidencias.hay_caso_vivo(db, orden_id=orden_id) is True


# =========================================================================== #
# 5. El proveedor no resuelve su propio caso
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_proveedor_no_puede_resolver_su_caso(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """403, Y NI SIQUIERA PROPONIENDO LA RESOLUCION MAS FAVORABLE A QUIEN
    RECLAMA. No es que la decision sea mala: es que no le toca a el."""
    _, _, _, _, quien, caso_id = await caso_abierto(sesiones, monkeypatch)

    #: PRIMERO RESPONDE, que es lo que si puede hacer. Asi el salto a resuelta
    #: EXISTE desde donde esta el caso y lo unico que lo para es QUIEN lo pide.
    #: Intentarlo desde «abierta» probaria que ese salto no existe desde ahi,
    #: que es otra cosa y mas floja: pasaria igual sin la regla de permisos.
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESPONDIDA,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
            propuesta=maquina.REEMBOLSAR_TODO_SIN_DEVOLVER,
            nota="Se lo devolvemos todo",
        )
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(maquina.SaltoNoPermitido):
            await incidencias.mover(
                db,
                incidencia_id=caso_id,
                hasta=maquina.RESUELTA,
                actor_id=quien,
                actor_rol=maquina.PROVEEDOR,
                resolucion=maquina.REEMBOLSAR_TODO_SIN_DEVOLVER,
                nota="Y lo doy por resuelto yo mismo",
            )
        await db.rollback()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.resolution is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderacion_no_resuelve_una_incidencia(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """RESOLVER DECIDE SOBRE DINERO Y SOBRE MERCANCIA. Es el mismo conjunto
    estrecho que ya decide quien publica y quien ajusta existencias."""
    from app.modules.profiles.models import Profile

    moderador = await persona(sesiones, "modinc")
    administrador = await persona(sesiones, "admininc")
    async with sesiones() as db:
        (await db.get(Profile, moderador)).role = "moderator"
        (await db.get(Profile, administrador)).role = "admin"
        await db.commit()
    async with sesiones() as db:
        assert await incidencias.puede_mediar(db, moderador) is False
        assert await incidencias.puede_mediar(db, administrador) is True
        with pytest.raises(AppError) as fallo:
            await incidencias.exigir_mediador(db, moderador)
    assert fallo.value.status_code == 403
    assert fallo.value.code == "product_incident_mediate_forbidden"


# =========================================================================== #
# 6. La apelacion
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_apelar_sin_evidencia_nueva_no_vale(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """«NUEVA» ES «POSTERIOR A LA RESOLUCION».

    Sin esa condicion, apelar seria repetir la misma frase mas alto: el
    blueprint pide evidencia nueva para que la segunda vuelta mire algo que la
    primera no vio.
    """
    _, _, comprador, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    manda = await persona(sesiones, "media4")
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MEDIACION,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
        )
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.RECHAZAR,
            nota="No se aprecia el dano que se describe",
        )
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(incidencias.ApelacionSinEvidenciaNueva):
            await incidencias.mover(
                db,
                incidencia_id=caso_id,
                hasta=maquina.APELADA,
                actor_id=comprador,
                actor_rol=maquina.COMPRADOR,
                nota="No estoy de acuerdo con la decision",
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_evidencia_nueva_se_apela_una_sola_vez(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """UNA SOLA APELACION. Lo dice el blueprint §10.1."""
    from app.modules.products import media as fotos

    _, _, comprador, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    manda = await persona(sesiones, "media5")
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MEDIACION,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
        )
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.RECHAZAR,
            nota="No se aprecia el dano que se describe",
        )
        await db.commit()

    #: EVIDENCIA NUEVA, posterior a la resolucion.
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        await incidencias.anadir_prueba(
            db,
            caso=caso,
            medida=fotos.medir(imagen(90)),
            actor_id=comprador,
            actor_rol="buyer",
        )
        await db.commit()

    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.APELADA,
            actor_id=comprador,
            actor_rol=maquina.COMPRADOR,
            nota="Aporto una foto con mas luz donde se ve la grieta",
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
    assert caso.status == maquina.APELADA
    assert caso.appeals_used == 1

    #: Y NO HAY SEGUNDA. Se resuelve otra vez y se intenta apelar de nuevo.
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=manda,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=maquina.REEMBOLSAR_EN_PARTE,
            nota="Con la foto nueva si se aprecia",
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        await incidencias.anadir_prueba(
            db,
            caso=caso,
            medida=fotos.medir(imagen(30)),
            actor_id=comprador,
            actor_rol="buyer",
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(incidencias.ApelacionAgotada):
            await incidencias.mover(
                db,
                incidencia_id=caso_id,
                hasta=maquina.APELADA,
                actor_id=comprador,
                actor_rol=maquina.COMPRADOR,
                nota="Sigo sin estar de acuerdo",
            )
        await db.rollback()


# =========================================================================== #
# 7. El expediente no se reescribe
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_ni_el_historial_ni_la_evidencia_se_pueden_editar_ni_borrar(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LO IMPONEN DOS DISPARADORES, NO UNA COSTUMBRE.

    Aqui pesa mas que en ningun otro sitio: esto es lo que se mira cuando dos
    personas cuentan lo mismo de dos maneras. Y NI SIQUIERA QUIEN LA SUBIO
    puede quitar una foto: retirarla despues de que la otra parte la haya visto
    es reescribir lo que se discutio.
    """
    _, _, _, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        renglon = (
            await db.scalars(
                select(ProductIncidentEvent)
                .where(ProductIncidentEvent.incident_id == caso_id)
                .limit(1)
            )
        ).one()
        prueba = (
            await db.scalars(
                select(ProductIncidentEvidence)
                .where(ProductIncidentEvidence.incident_id == caso_id)
                .limit(1)
            )
        ).one()
        renglon_id, prueba_id = renglon.id, prueba.id

    sentencias = (
        ("update product_incident_events set to_status = 'RESOLVED'"
         " where id = cast(:i as uuid)", renglon_id),
        ("delete from product_incident_events where id = cast(:i as uuid)", renglon_id),
        ("update product_incident_evidence set caption = 'otra cosa'"
         " where id = cast(:i as uuid)", prueba_id),
        ("delete from product_incident_evidence where id = cast(:i as uuid)", prueba_id),
    )
    for sentencia, ident in sentencias:
        async with sesiones() as db:
            with pytest.raises(Exception) as fallo:
                await db.execute(text(sentencia), {"i": ident})
                await db.commit()
            await db.rollback()
        assert "solo se anade" in str(fallo.value).lower(), sentencia


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_misma_fotografia_no_cuenta_dos_veces(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """SUBIR DOS VECES LA MISMA FOTO PARA LLEGAR AL MINIMO NO ES APORTAR DOS
    EVIDENCIAS. Lo impide un indice unico por huella."""
    from app.core.exceptions import ConflictError
    from app.modules.products import media as fotos

    _, _, comprador, _, _, caso_id = await caso_abierto(
        sesiones, monkeypatch, enviar=False
    )
    misma = imagen(180)
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        with pytest.raises(ConflictError) as fallo:
            await incidencias.anadir_prueba(
                db,
                caso=caso,
                medida=fotos.medir(misma),
                actor_id=comprador,
                actor_rol="buyer",
            )
        await db.rollback()
    assert fallo.value.code == "product_incident_evidence_duplicated"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_choque_que_no_es_un_duplicado_no_se_cuenta_como_duplicado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """CONTESTAR «ESA FOTO YA ESTA» ANTE CUALQUIER CHOQUE ESCONDE EL FALLO REAL.

    Paso de verdad mientras se escribia esto: la ruta insertaba la fila con la
    ruta de almacenamiento vacia y la rellenaba despues, la fila intermedia
    violaba el CHECK de la ruta, y ese `IntegrityError` se contaba como foto
    duplicada. Dos errores en uno, y el segundo tapaba al primero: quien subia
    una foto perfectamente valida leia que ya estaba en el expediente.

    Aqui se fuerza un choque que NO es un duplicado —una ruta vacia, que el
    CHECK rechaza— y se comprueba que el error sale como lo que es.
    """
    from app.modules.products import media as fotos

    _, _, comprador, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        caso = await db.get(ProductIncident, caso_id)
        with pytest.raises(Exception) as fallo:
            await incidencias.anadir_prueba(
                db,
                caso=caso,
                medida=fotos.medir(imagen(40)),
                actor_id=comprador,
                actor_rol="buyer",
                ruta="   ",
            )
        await db.rollback()
    assert "duplicated" not in str(getattr(fallo.value, "code", "")), (
        "un choque que no es un duplicado se conto como duplicado"
    )


# =========================================================================== #
# 8. Lo ajeno es un 404
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_caso_de_otro_es_un_404(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DECIR «EXISTE PERO NO ES TUYO» YA CUENTA que alguien abrio una disputa
    sobre ese pedido."""
    _, _, _, _, _, caso_id = await caso_abierto(sesiones, monkeypatch)
    ajeno = await persona(sesiones, "ajenoinc")
    otro_prov = await persona(sesiones, "otroprovinc")
    await vendedor(sesiones, otro_prov)

    async with sesiones() as db:
        with pytest.raises(incidencias.CasoNoEncontrado):
            await incidencias.de_quien_compra(
                db, incidencia_id=caso_id, usuario_id=ajeno
            )
        with pytest.raises(incidencias.CasoNoEncontrado):
            await incidencias.de_quien_vende(
                db, incidencia_id=caso_id, usuario_id=otro_prov
            )


# =========================================================================== #
# 9. La auditoria compartida
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_auditoria_no_se_lleva_el_texto_de_la_disputa(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA DESCRIPCION Y LAS NOTAS SON TEXTO LIBRE DE LO QUE LE PASO A ALGUIEN.

    `audit_events` la leen otros modulos y otras personas; el expediente se lee
    entrando a el, que es donde se comprueba quien puede. Aqui queda de donde a
    donde se movio y que se decidio, que es lo que hace falta para investigar.
    """
    from app.modules.gobernanza.models import AuditEvent

    _, _, _, orden_id, quien, caso_id = await caso_abierto(sesiones, monkeypatch)
    secreto = "Mi vecino del 3B se lo quedo y no me lo devuelve"
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MAS_EVIDENCIA,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
            nota=secreto,
        )
        await db.commit()

    async with sesiones() as db:
        rastro = list(
            await db.scalars(
                select(AuditEvent).where(
                    AuditEvent.entity_id == orden_id,
                    AuditEvent.action.like("product_incident.%"),
                )
            )
        )
    assert rastro, "mover un caso tiene que dejar rastro"
    for evento in rastro:
        completo = " ".join(
            str(x or "")
            for x in (evento.payload, evento.reason, evento.external_reference)
        )
        assert secreto not in completo, "la auditoria se lleva el texto libre"
        assert DESCRIPCION not in completo, "la auditoria se lleva la descripcion"

    #: LO QUE SI QUEDA: de donde a donde, el motivo cerrado y la resolucion.
    ultimo = rastro[-1]
    assert ultimo.payload.get("to") == maquina.MAS_EVIDENCIA
    assert ultimo.payload.get("reason") == maquina.DANADO


# =========================================================================== #
# 10. Sin la 0080
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0080_las_incidencias_contestan_503(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DEGRADACION SEGURA. Y leer «hay un caso vivo» contesta que no en vez de
    reventar: el envio pregunta eso en cada confirmacion de recepcion, y una
    migracion que falta no puede tumbar el pedido de nadie."""
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_incidencias", _no_hay)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await incidencias.abrir(
                db,
                orden_id=orden_id,
                usuario_id=comprador,
                motivo=maquina.ENTREGA_NEGADA,
                descripcion=DESCRIPCION,
            )
        await db.rollback()
    assert fallo.value.status_code == 503
    assert fallo.value.code == "product_incidents_not_available"

    async with sesiones() as db:
        assert await incidencias.hay_caso_vivo(db, orden_id=orden_id) is False
        assert await incidencias.bloquea_el_dinero(db, orden_id=orden_id) is False
        assert await incidencias.del_pedido(db, orden_id=orden_id) == []
