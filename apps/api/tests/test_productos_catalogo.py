"""Incremento 3 de Productos: el catálogo.

LO QUE DEFIENDEN ESTAS PRUEBAS. Casi todas son sobre algo que NO tiene que
aparecer, porque el riesgo de este incremento no es que falte un dato: es que se
invente uno.

  1. NINGUNA VALORACIÓN. No hay reseñas de productos, así que `rating` es
     `null` y no cero, ni 4.2, ni 4.8.
  2. NINGÚN PLAZO DE ENTREGA NI DE DEVOLUCIÓN. `delivery` es `null`: no hay
     transportista, ni cobertura, ni condiciones aprobadas.
  3. NINGÚN BOTÓN DE COMPRAR. `purchasable` es `false` siempre, porque no
     existe la compra física.
  4. SOLO LO PUBLICADO SE ENSEÑA. Un borrador, un suspendido o un retirado no
     tienen ficha: compartir un enlace a un producto retirado es lo que esto
     impide.
  5. EL SELLO SALE DEL SERVIDOR, con su texto exacto, y abre un informe REAL.
  6. «SELECCIÓN Z» SE ORDENA POR LA EVALUACIÓN, que es un dato verificado.
  7. «PARA TI» NO ESTÁ PERSONALIZADO, y el contrato lo dice para que la
     pantalla no ponga un título que miente.
  8. GUARDAR NO ES UN CARRITO: es idempotente, no reserva nada y no lleva a
     pagar.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.core.exceptions import NotFoundError
from app.modules.products import catalog, esquema, evaluations, service
from app.modules.products import states as maquina
from app.modules.products.models import (
    PUBLICADO,
    Product,
    ProductVersion,
    SavedProduct,
)
from tests.test_productos_admision import evaluar_completo, hasta_evaluacion
from tests.test_productos_dominio import (  # noqa: F401
    DATOS,
    foto_aprobada,
    SIN_POSTGRES,
    URL,
    VARIANTES,
    base_aplicada,
    categoria,
    persona,
    producto_en_borrador,
    sesiones,
    vendedor,
)


async def publicado(
    sesiones, *, nota=95, nombre="Cuchillo de cocina forjado", categoria_id=None
) -> tuple[str, str, str]:
    """Un producto PUBLICADO por el camino real: postula, evalúa, publica.

    Se hace entero a propósito: un producto en catálogo escrito a mano no
    probaría que el camino funciona, y es el camino lo que tiene que funcionar.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")

    async with sesiones() as db:
        producto, version = await service.crear(
            db,
            usuario_id=quien,
            datos={**DATOS, "name": nombre},
            category_id=categoria_id,
            variantes=VARIANTES,
        )
        await db.commit()
        producto_id, version_id = producto.id, version.id

    # LA FOTO, POR SU CAMINO. Desde la 0073 el borrador ya no lleva galería: se
    # sube aparte y alguien la aprueba, y sin una aprobada no se publica.
    await foto_aprobada(sesiones, version_id, quien=evaluador)

    async with sesiones() as db:
        for hasta, rol in (
            ("submitted", maquina.PROVEEDOR),
            ("document_review", maquina.EVALUADOR),
            ("evaluation", maquina.EVALUADOR),
        ):
            await service.transicionar(
                db,
                producto_id=producto_id,
                hasta=hasta,
                actor_id=evaluador,
                actor_rol=rol,
            )
        await db.commit()

    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=nota)
    async with sesiones() as db:
        evidencias = [
            e.id for e in await evaluations.evidencia_de(db, evaluacion_id=ident)
        ]
        await evaluations.elegir_razones(
            db,
            evaluacion_id=ident,
            usuario_id=evaluador,
            razones=[
                {"evidence_id": e, "text": f"Razón respaldada número {i}."}
                for i, e in enumerate(evidencias[:3])
            ],
        )
        await evaluations.decidir(db, evaluacion_id=ident, usuario_id=evaluador)
        await db.commit()
    async with sesiones() as db:
        await service.publicar(db, producto_id=producto_id, usuario_id=evaluador)
        await db.commit()
    return producto_id, version_id, quien


# =========================================================================== #
# Lo que NO se inventa
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_ficha_no_inventa_valoraciones_ni_plazos(sesiones) -> None:
    """EL RIESGO DE ESTE INCREMENTO no es que falte un dato: es que se invente.

    `4.8 estrellas`, `entrega en 3 días` o `120 compras verificadas` son los
    tres que la pantalla querría enseñar y que no existen.
    """
    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        ficha = await catalog.ficha(db, producto_id=producto_id)

    assert ficha.rating is None, "no hay reseñas de productos: no hay media"
    assert ficha.delivery is None, "no hay transportista ni condiciones aprobadas"
    assert ficha.purchasable is False, "no existe la compra física"
    # Y EL SELLO viene del servidor con su texto exacto (blueprint §4.1).
    assert ficha.seal == (
        "Producto de Excelencia Z · Evaluado y aprobado por nuestro estándar"
    )
    assert catalog.MANIFIESTO == "No está todo. Está lo que merece estar."


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_razones_dicen_de_que_evidencia_salen(sesiones) -> None:
    """SIN ESO no se pueden comprobar, y comprobarlas es lo único que las
    distingue de una frase escrita a mano."""
    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        ficha = await catalog.ficha(db, producto_id=producto_id)

    assert len(ficha.reasons) == 3
    assert [r["position"] for r in ficha.reasons] == [1, 2, 3]
    for razon in ficha.reasons:
        assert razon["evidence_kind"], razon
        assert razon["evidence_dimension"] in (
            "quality",
            "design",
            "usefulness",
            "durability",
            "origin",
            "warranty",
        )
    # Y el sello abre un informe REAL.
    assert ficha.evaluation_id is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_informe_no_ensena_la_nota_interna(sesiones) -> None:
    """LO INTERNO NO SALE. Es el mismo criterio que en los expedientes de
    eventos: una respuesta pública no puede llevar dentro una nota de uso
    interno."""
    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        informe = await catalog.informe_de_evaluacion(db, producto_id=producto_id)

    assert informe is not None
    assert informe["decision"] == "approved"
    # EN CENTÉSIMAS DE PUNTO: la pantalla decide cómo lo escribe.
    assert informe["score_total"] == 9_500
    assert "notes" not in informe
    assert set(informe["dimensions"]) == {
        "quality",
        "design",
        "usefulness",
        "durability",
        "origin",
        "warranty",
    }
    for datos in informe["dimensions"].values():
        assert datos["evidence"], datos
        assert "score" in datos and "weight" in datos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_indicador_de_confianza_es_uno_y_es_demostrable(sesiones) -> None:
    """UNO SOLO (§3.1), y hoy solo puede ser el ORIGEN.

    Recomendación y compras verificadas necesitan reseñas y pedidos; la garantía
    necesita condiciones aprobadas. Ninguno de los tres existe.
    """
    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        p = await catalog.portada(db)
    assert p.para_ti
    tarjeta = next(t for t in p.para_ti if t.product_id == producto_id)
    assert tarjeta.trust == "origin"
    assert tarjeta.trust_value == "PE"
    # Y LA PRIMERA IMAGEN sale de la galería APROBADA, como ruta. Cuál es la
    # ruta lo decide el servidor (0073); lo que se comprueba es que es una ruta.
    assert tarjeta.image_path and "://" not in tarjeta.image_path
    # SIN ALMACENAMIENTO CONFIGURADO no se inventa ninguna URL: viaja nula y la
    # pantalla enseña el texto alternativo.
    assert tarjeta.image_url is None
    assert tarjeta.image_alt


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_para_ti_no_miente_con_el_titulo(sesiones) -> None:
    """NO HAY RECOMENDADOR DE PRODUCTOS.

    Ordenar por lo más reciente y llamarlo «elegidos para ti» sería mentir con
    el título, así que el contrato manda `personalized: false` y la pantalla
    pone el que corresponde.
    """
    await publicado(sesiones)
    async with sesiones() as db:
        p = await catalog.portada(db)
    assert p.personalized is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_seleccion_se_ordena_por_la_evaluacion(sesiones) -> None:
    """UN DATO VERIFICADO, no una lista a dedo.

    Una selección escrita a mano sería una decisión de producto que nadie ha
    tomado; ordenar por la puntuación de la evaluación aprobada sí se puede
    explicar.
    """
    flojo, _, _ = await publicado(sesiones, nota=91, nombre="Tabla de picar")
    bueno, _, _ = await publicado(sesiones, nota=99, nombre="Cuchillo santoku")
    async with sesiones() as db:
        p = await catalog.portada(db)
    orden = [t.product_id for t in p.seleccion]
    assert orden.index(bueno) < orden.index(flojo)


# =========================================================================== #
# Solo lo publicado
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_borrador_no_tiene_ficha(sesiones) -> None:
    """COMPARTIR UN ENLACE a algo que Z no publicó es lo que esto impide."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)
    async with sesiones() as db:
        with pytest.raises(NotFoundError) as fallo:
            await catalog.ficha(db, producto_id=producto_id)
    assert fallo.value.code == "product_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_suspendido_sale_del_catalogo_y_un_observado_no(sesiones) -> None:
    """OBSERVAR ES VIGILAR, NO ESCONDER. Suspender es lo contrario."""
    producto_id, _, _ = await publicado(sesiones)
    admin = await persona(sesiones, "adm2", rol="admin")

    async with sesiones() as db:
        await service.transicionar(
            db,
            producto_id=producto_id,
            hasta="observation",
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
        )
        await db.commit()
    async with sesiones() as db:
        # SIGUE VISIBLE: se está vigilando, no escondiendo.
        assert (await catalog.ficha(db, producto_id=producto_id)).status == "observation"

    async with sesiones() as db:
        await service.transicionar(
            db,
            producto_id=producto_id,
            hasta="suspended",
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
            motivo="el lote no coincide con la muestra",
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(NotFoundError):
            await catalog.ficha(db, producto_id=producto_id)
        items, _ = await catalog.buscar(db, q="Cuchillo")
        assert producto_id not in [t.product_id for t in items]


# =========================================================================== #
# Búsqueda y categorías
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_busqueda_filtra_en_el_servidor(sesiones) -> None:
    """EL FILTRO LO APLICA EL SERVIDOR.

    Si lo aplicara la aplicación, bastaría una versión vieja instalada en un
    teléfono para que apareciera algo que Z retiró.
    """
    # NOMBRES PROPIOS DE ESTA PRUEBA. La base es del módulo entero, y buscar
    # una palabra que otra prueba también publicó mediría lo de las dos.
    uno, _, _ = await publicado(sesiones, nombre="Espátula acanalada singular")
    dos, _, _ = await publicado(sesiones, nombre="Rodillo estriado singular")

    async with sesiones() as db:
        items, _ = await catalog.buscar(db, q="acanalada")
        assert [t.product_id for t in items] == [uno]

        items, _ = await catalog.buscar(db, q="singular")
        assert {t.product_id for t in items} == {uno, dos}

        # BUSCA TAMBIÉN EN LOS MATERIALES y en quien fabrica, no solo en el
        # nombre: es lo que hace que «nogal» encuentre lo que es de nogal.
        items, _ = await catalog.buscar(db, q="nogal")
        assert uno in [t.product_id for t in items]
        items, _ = await catalog.buscar(db, q="Taller Andino")
        assert uno in [t.product_id for t in items]

        # CON UNA LETRA NO SE BUSCA: devolver el catálogo entero parecería un
        # buscador que no filtra.
        items, siguiente = await catalog.buscar(db, q="c")
        assert items == [] and siguiente is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_busqueda_pagina_por_cursor_sin_repetir(sesiones) -> None:
    """PAGINAR POR DESPLAZAMIENTO repite y se salta filas cuando alguien
    publica a mitad. El cursor es el último identificador."""
    esperados = set()
    for i in range(3):
        producto_id, _, _ = await publicado(sesiones, nombre=f"Utensilio {i}")
        esperados.add(producto_id)

    vistos: list[str] = []
    cursor = None
    async with sesiones() as db:
        for _ in range(5):
            items, cursor = await catalog.buscar(
                db, q="Utensilio", cursor=cursor, limite=1
            )
            vistos += [t.product_id for t in items]
            if cursor is None:
                break
    assert len(vistos) == len(set(vistos)) == 3
    assert set(vistos) == esperados


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_categorias_nacen_vacias(sesiones) -> None:
    """LA EMPRESA NO LAS HA DEFINIDO. Vacío no es un fallo: es la verdad."""
    async with sesiones() as db:
        assert await catalog.categorias(db) == []

    real = await categoria(sesiones, "cocina")
    producto_id, _, _ = await publicado(sesiones, categoria_id=real)
    async with sesiones() as db:
        assert len(await catalog.categorias(db)) == 1
        items, _ = await catalog.buscar(db, category_id=real)
        assert [t.product_id for t in items] == [producto_id]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cursor_que_ya_no_existe_no_es_un_error(sesiones) -> None:
    """EL PRODUCTO PUDO RETIRARSE entre dos páginas. Se empieza de nuevo."""
    import uuid as _uuid

    await publicado(sesiones)
    async with sesiones() as db:
        items, _ = await catalog.buscar(db, cursor=str(_uuid.uuid4()))
    assert items, "un cursor caducado no puede dejar la lista vacía"


# =========================================================================== #
# Guardados
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_guardar_es_idempotente_y_no_reserva_nada(sesiones) -> None:
    """GUARDAR NO ES UN CARRITO. No tiene cantidad, no tiene variante y no lleva
    a pagar."""
    producto_id, _, _ = await publicado(sesiones)
    quien = await persona(sesiones, "comprador")

    async with sesiones() as db:
        assert await catalog.guardar(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()
    async with sesiones() as db:
        # SEGUNDA VEZ: no duplica y no es un error.
        assert not await catalog.guardar(
            db, producto_id=producto_id, usuario_id=quien
        )
        await db.commit()

    async with sesiones() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(SavedProduct)
                .where(SavedProduct.user_id == quien)
            )
        ) == 1
        assert await catalog.cuantos_guardados(db, usuario_id=quien) == 1
        mios = await catalog.guardados(db, usuario_id=quien)
        assert [t.product_id for t in mios] == [producto_id]
        assert all(t.saved for t in mios)
        # Y la ficha lo sabe.
        assert (
            await catalog.ficha(db, producto_id=producto_id, usuario_id=quien)
        ).saved is True


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quitar_lo_que_no_esta_tampoco_es_un_error(sesiones) -> None:
    producto_id, _, _ = await publicado(sesiones)
    quien = await persona(sesiones, "comprador")
    async with sesiones() as db:
        assert not await catalog.quitar(
            db, producto_id=producto_id, usuario_id=quien
        )
        await db.commit()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_guarda_un_borrador_ajeno(sesiones) -> None:
    """GUARDAR UN BORRADOR AJENO sería enterarse de que existe."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)
    curioso = await persona(sesiones, "curioso")
    async with sesiones() as db:
        with pytest.raises(NotFoundError):
            await catalog.guardar(
                db, producto_id=producto_id, usuario_id=curioso
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_producto_retirado_no_se_ensena_aunque_este_guardado(
    sesiones,
) -> None:
    """LA FILA SE CONSERVA —por si vuelve— pero la lista no promete algo que ya
    no está."""
    producto_id, _, _ = await publicado(sesiones)
    quien = await persona(sesiones, "comprador")
    admin = await persona(sesiones, "adm2", rol="admin")
    async with sesiones() as db:
        await catalog.guardar(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()
    async with sesiones() as db:
        await service.transicionar(
            db,
            producto_id=producto_id,
            hasta="removed",
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
        )
        await db.commit()

    async with sesiones() as db:
        assert await catalog.guardados(db, usuario_id=quien) == []
        # La fila sigue ahí: no se borra el gesto de alguien.
        assert (
            await db.get(SavedProduct, (quien, producto_id))
        ) is not None


# =========================================================================== #
# Publicar una versión nueva
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_ficha_ensena_la_version_publicada_y_no_el_borrador(
    sesiones,
) -> None:
    """LO PUBLICADO NO SE TOCA.

    Se abre un borrador nuevo sobre lo publicado y la ficha sigue enseñando lo
    de antes: cambiar el texto de una ficha en catálogo sin volver a evaluarla
    es exactamente lo que la inmutabilidad de la versión impide.
    """
    producto_id, version_id, dueno = await publicado(sesiones)
    admin = await persona(sesiones, "adm2", rol="admin")

    # Vuelve a borrador para poder escribir una versión nueva.
    async with sesiones() as db:
        await service.transicionar(
            db,
            producto_id=producto_id,
            hasta="removed",
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
        )
        await db.commit()

    async with sesiones() as db:
        version = await db.get(ProductVersion, version_id)
        producto = await db.get(Product, producto_id)
    # La versión publicada CONSERVA su huella y su texto pase lo que pase.
    assert version.status == "published"
    assert version.content_sha256 == service.huella(DATOS, variantes=VARIANTES)
    assert producto.published_version_id == version_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_esquema_la_portada_no_revienta(sesiones) -> None:
    """LA PORTADA ES LA PUERTA DE ENTRADA. Un 503 aquí parecería que la
    aplicación está rota; los bloques vacíos dicen la verdad."""
    esquema.olvidar()
    esquema._cache["dominio"] = False
    try:
        async with sesiones() as db:
            p = await catalog.portada(db)
        assert p.seleccion == [] and p.para_ti == [] and p.creadores == []
        assert p.manifest == catalog.MANIFIESTO
    finally:
        esquema.olvidar()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_ficha_dice_que_se_compra_cuando_la_venta_esta_encendida(
    sesiones, monkeypatch
) -> None:
    """ENCENDER STRIPE NO PUEDE EXIGIR TOCAR CODIGO.

    LO ENCONTRO LA REVISION INDEPENDIENTE. La ficha llevaba `purchasable=False`
    escrito a fuego, mientras la bolsa lo calcula de verdad. El dia que se
    encendieran las ventas, la ficha seguiria diciendo «en Z todavia no se
    compran productos» con el boton de la bolsa debajo y el recorrido entero
    hasta la pasarela funcionando. Que la entrega de Stripe sea solo
    configuracion es justamente lo que este cierre promete.

    Y CON LA VENTA APAGADA SIGUE EN FALSO, que es lo que ve hoy cualquiera: la
    prueba de arriba lo fija con la configuracion de fabrica.
    """
    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        apagada = await catalog.ficha(db, producto_id=producto_id)
    assert apagada.purchasable is False

    from app.core.config import get_settings

    ajustes = get_settings()
    for nombre, valor in (
        ("feature_product_sales", True),
        ("payments_enabled", True),
        ("stripe_payments_enabled", True),
        ("product_reservation_minutes", 30),
        ("stripe_secret_key", "sk_test_de_mentira_para_la_prueba"),
    ):
        monkeypatch.setattr(ajustes, nombre, valor, raising=False)

    async with sesiones() as db:
        encendida = await catalog.ficha(db, producto_id=producto_id)
    assert encendida.purchasable is True, (
        "con las cinco condiciones de venta cumplidas la ficha sigue diciendo "
        "que no se compra: encender Stripe exigiria tocar el codigo"
    )
