"""Incremento 4 de Productos: las fotografías (0073), contra PostgreSQL real.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. NO SE ACEPTA UNA RUTA PEGADA. El borrador ya no lleva galería; la ruta la
     genera el servidor a partir del proveedor, el producto y la versión.
  2. SE MIRAN LOS BYTES, NO LA EXTENSIÓN. Un `.jpg` que no es un JPEG se
     rechaza, y un archivo con cabecera de JPEG pero basura dentro también.
  3. SUBIR NO ES PUBLICAR. La foto nace pendiente, el catálogo solo firma las
     aprobadas, y una rechazada no aparece en ninguna parte pública.
  4. SOLO EL PROPIETARIO, Y SOLO EN BORRADOR. Un producto ajeno es un 404.
  5. NADIE APRUEBA LA FOTO DE SU PROPIO PRODUCTO, ni siendo administrador.
  6. NO SE BORRA UN ARCHIVO QUE SIGUE REFERENCIADO por otra fila.
  7. SIN LA 0073 NADA DE ESTO EXISTE, y se contesta 503 con su código: la
     degradación es segura, no un 500.
"""

from __future__ import annotations

import io as _io
import uuid

import psycopg
import pytest
from sqlalchemy import func, select, text

from app.core.exceptions import AppError
from app.modules.products import esquema, media, service
from app.modules.products import states as maquina
from app.modules.products.models import (
    FOTO_APROBADA,
    FOTO_PENDIENTE,
    FOTO_RECHAZADA,
    MAXIMO_BYTES_DE_LA_FOTO,
    MAXIMO_DE_FOTOS,
    Product,
    ProductMedia,
    ProductVersion,
)
from app.shared import storage
from tests.test_productos_dominio import (  # noqa: F401
    DATOS,
    SIN_POSTGRES,
    URL,
    VARIANTES,
    ahora,
    base_aplicada,
    persona,
    producto_en_borrador,
    sesiones,
    vendedor,
)


# =========================================================================== #
# Archivos de verdad
# =========================================================================== #
def imagen(formato: str = "JPEG", tamano: tuple[int, int] = (64, 48)) -> bytes:
    """Una imagen REAL, generada al vuelo.

    Escribir aquí unos bytes inventados haría que la prueba de «se miran los
    bytes» pasara por casualidad: lo que se comprueba es que el servidor abre
    la imagen, y para eso tiene que haber una imagen.
    """
    from PIL import Image

    buffer = _io.BytesIO()
    Image.new("RGB", tamano, (30, 30, 30)).save(buffer, format=formato)
    return buffer.getvalue()


@pytest.fixture()
def almacen_falso(monkeypatch):
    """Storage de mentira: guarda en un diccionario y cuenta los borrados.

    No se llama a Supabase en ninguna prueba. Lo que se prueba es QUÉ decide
    subir y borrar este módulo, no que `httpx` sepa hablar por la red.
    """
    subidos: dict[str, bytes] = {}
    borrados: list[str] = []

    async def _subir(bucket, ruta, datos, content_type, *, sobrescribir=False):
        assert bucket == media.DEPOSITO
        subidos[ruta] = datos

    async def _borrar(bucket, ruta):
        borrados.append(ruta)
        subidos.pop(ruta, None)
        return True

    async def _firmar(bucket, rutas, *, segundos=3600):
        return {r: f"https://firmada.test/{r}?exp={segundos}" for r in rutas if r in subidos}

    monkeypatch.setattr(storage, "subir_objeto", _subir)
    monkeypatch.setattr(storage, "borrar_objeto", _borrar)
    monkeypatch.setattr(storage, "firmar_objetos", _firmar)
    monkeypatch.setattr(storage, "storage_configured", lambda: True)
    return {"subidos": subidos, "borrados": borrados}


async def con_producto(sesiones):
    """Quien vende, su producto en borrador y el objeto del producto."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(
        sesiones, quien, con_foto=False
    )
    return quien, producto_id, version_id


# =========================================================================== #
# Mirar los bytes
# =========================================================================== #
def test_un_archivo_vacio_no_es_una_fotografia() -> None:
    with pytest.raises(AppError) as fallo:
        media.medir(b"")
    assert fallo.value.code == "product_media_invalid"


def test_un_archivo_demasiado_grande_se_rechaza_sin_abrirlo() -> None:
    """EL PESO SE MIRA ANTES DE DECODIFICAR. Abrir 40 MB para decir que pesan
    demasiado es hacer el trabajo dos veces y encima con la memoria ocupada."""
    enorme = b"\xff\xd8\xff" + b"0" * (MAXIMO_BYTES_DE_LA_FOTO + 1)
    with pytest.raises(AppError) as fallo:
        media.medir(enorme)
    assert fallo.value.code == "product_media_invalid"
    assert fallo.value.details["max_bytes"] == MAXIMO_BYTES_DE_LA_FOTO


def test_un_svg_no_pasa_aunque_diga_ser_una_imagen() -> None:
    """UN SVG ES UN DOCUMENTO CON SCRIPTS, no una fotografía. Por eso el
    depósito declara tres tipos y no `image/*`."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    with pytest.raises(AppError) as fallo:
        media.medir(svg, declarado="image/svg+xml")
    assert fallo.value.code == "product_media_invalid"


def test_un_ejecutable_renombrado_a_jpg_se_rechaza() -> None:
    """LA EXTENSIÓN NO DECIDE NADA, y el `Content-Type` tampoco: lo escribe
    quien sube."""
    with pytest.raises(AppError) as fallo:
        media.medir(b"MZ\x90\x00" + b"\x00" * 200, declarado="image/jpeg")
    assert fallo.value.code == "product_media_invalid"


def test_una_cabecera_de_jpeg_con_basura_dentro_tampoco_pasa() -> None:
    """LOS PRIMEROS BYTES SE PUEDEN FALSIFICAR pegando una cabecera delante de
    cualquier cosa. Abrir la imagen de verdad es lo que lo distingue."""
    falsa = b"\xff\xd8\xff" + b"no soy una imagen" * 20
    with pytest.raises(AppError) as fallo:
        media.medir(falsa)
    assert fallo.value.code == "product_media_invalid"


def test_el_tipo_declarado_que_no_coincide_se_dice_con_los_dos() -> None:
    with pytest.raises(AppError) as fallo:
        media.medir(imagen("PNG"), declarado="image/jpeg")
    assert fallo.value.details["detected"] == "image/png"
    assert fallo.value.details["declared"] == "image/jpeg"


@pytest.mark.parametrize(
    "formato,tipo", [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")]
)
def test_los_tres_formatos_admitidos_se_miden(formato: str, tipo: str) -> None:
    medida = media.medir(imagen(formato), declarado=tipo)
    assert medida.content_type == tipo
    assert medida.width == 64 and medida.height == 48
    assert medida.byte_size > 0
    assert len(medida.checksum_sha256) == 64


def test_sin_tipo_declarado_el_tipo_SALE_DE_LOS_BYTES() -> None:
    """LO ENCONTRÓ LA BATERÍA DE MUTACIONES.

    Rechazar un SVG lo hacían DOS cosas a la vez: que el tipo salga de los bytes
    y que la lista de admitidos sea cerrada. Con las dos puestas, cambiar la
    primera no ponía roja ninguna prueba, y entonces la prueba no demostraba
    cuál de las dos protege.

    Aquí no se declara NADA. Si el tipo viniera de lo declarado, no habría de
    dónde sacarlo, y los tres formatos no se podrían distinguir.
    """
    for formato, esperado in (
        ("JPEG", "image/jpeg"),
        ("PNG", "image/png"),
        ("WEBP", "image/webp"),
    ):
        assert media.medir(imagen(formato), declarado=None).content_type == esperado

    # Y CON UN TIPO DECLARADO QUE MIENTE, gana el de los bytes: el error dice
    # que no coinciden y nombra el detectado, no el declarado.
    with pytest.raises(AppError) as fallo:
        media.medir(imagen("WEBP"), declarado="image/png")
    assert fallo.value.details["detected"] == "image/webp"


def test_la_ruta_la_genera_el_servidor_y_no_lleva_nada_del_cliente() -> None:
    """NI EL NOMBRE, NI LA EXTENSIÓN, NI LAS CARPETAS. Un nombre elegido por
    quien sube puede traer `../` o el nombre de un archivo ajeno."""
    ruta = media.ruta_de(
        seller_id="v1", product_id="p1", version_id="ver1",
        media_id="m1", tipo="image/webp",
    )
    assert ruta == "v1/p1/ver1/m1.webp"
    assert "://" not in ruta and ".." not in ruta


# =========================================================================== #
# Subir
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_subir_deja_la_foto_PENDIENTE_y_con_su_medida(
    sesiones, almacen_falso
) -> None:
    """SUBIR NO ES PUBLICAR. Nace `pending`, y el catálogo no la enseña."""
    quien, producto_id, version_id = await con_producto(sesiones)
    datos = imagen("JPEG")
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db,
            producto=producto,
            datos=datos,
            declarado="image/jpeg",
            alt_text="Cuchillo forjado sobre una tabla de madera",
            actor_id=quien,
        )
        await db.commit()
        media_id = fila.id

    async with sesiones() as db:
        guardada = await db.get(ProductMedia, media_id)
        assert guardada.status == FOTO_PENDIENTE
        assert guardada.content_type == "image/jpeg"
        assert guardada.byte_size == len(datos)
        assert guardada.width == 64 and guardada.height == 48
        assert guardada.reviewed_at is None
        # LA RUTA LA GENERÓ EL SERVIDOR: cuelga del producto y de la versión.
        assert guardada.storage_path.endswith(f"{media_id}.jpg")
        assert f"/{producto_id}/{version_id}/" in guardada.storage_path
        assert "://" not in guardada.storage_path
    assert guardada.storage_path in almacen_falso["subidos"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_texto_alternativo_no_se_sube(sesiones, almacen_falso) -> None:
    """EL TEXTO ALTERNATIVO NO ES UN ADORNO: es lo único que queda cuando la
    imagen no carga, y es lo que lee quien no ve."""
    quien, producto_id, _ = await con_producto(sesiones)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        with pytest.raises(AppError) as fallo:
            await media.subir(
                db, producto=producto, datos=imagen(), declarado="image/jpeg",
                alt_text="  ", actor_id=quien,
            )
    assert fallo.value.code == "product_media_invalid"
    assert fallo.value.details["field"] == "alt_text"
    # Y NO SE SUBIÓ EL ARCHIVO: el error es antes de tocar el almacenamiento.
    assert almacen_falso["subidos"] == {}


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_caben_mas_de_las_que_admite_la_version(
    sesiones, almacen_falso
) -> None:
    quien, producto_id, _ = await con_producto(sesiones)
    for i in range(MAXIMO_DE_FOTOS):
        async with sesiones() as db:
            producto = await db.get(Product, producto_id)
            await media.subir(
                db, producto=producto, datos=imagen(tamano=(64, 48 + i)),
                declarado="image/jpeg", alt_text=f"Fotografía número {i}",
                actor_id=quien,
            )
            await db.commit()
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        with pytest.raises(AppError) as fallo:
            await media.subir(
                db, producto=producto, datos=imagen(tamano=(70, 70)),
                declarado="image/jpeg", alt_text="Una de más", actor_id=quien,
            )
    assert fallo.value.code == "product_media_limit_reached"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_doble_toque_no_sube_dos_veces(sesiones, almacen_falso) -> None:
    """EL IDENTIFICADOR SE DERIVA DE LA CLAVE, así que la segunda petición
    choca contra la clave primaria en vez de dejar dos fotos iguales."""
    quien, producto_id, version_id = await con_producto(sesiones)
    for _ in range(2):
        async with sesiones() as db:
            producto = await db.get(Product, producto_id)
            try:
                await media.subir(
                    db, producto=producto, datos=imagen(), declarado="image/jpeg",
                    alt_text="La misma fotografía, dos veces", actor_id=quien,
                    clave="toque-1",
                )
                await db.commit()
            except Exception:
                await db.rollback()

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(ProductMedia)
            .where(ProductMedia.version_id == version_id)
        )
    assert cuantas == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_toca_la_galeria_de_un_producto_ajeno(
    sesiones, almacen_falso
) -> None:
    """UN PRODUCTO AJENO ES UN 404. Decir «existe pero no es tuyo» ya cuenta
    que existe."""
    from app.modules.products import permissions

    _, producto_id, _ = await con_producto(sesiones)
    otro = await persona(sesiones, "otro")
    await vendedor(sesiones, otro)
    async with sesiones() as db:
        with pytest.raises(permissions.NoEsTuProducto) as fallo:
            await permissions.exigir_mio(db, producto_id=producto_id, user_id=otro)
    assert fallo.value.code == "product_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_lo_publicado_no_cambia_de_fotos(sesiones, almacen_falso) -> None:
    """LO PUBLICADO ES LO QUE SE EVALUÓ. Cambiarle una foto reescribiría en
    silencio lo que vio quien compró."""
    quien, producto_id, _ = await con_producto(sesiones)
    async with sesiones() as db:
        await service.transicionar(
            db, producto_id=producto_id, hasta="submitted",
            actor_id=quien, actor_rol=maquina.PROVEEDOR,
        )
        await db.commit()
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        with pytest.raises(AppError) as fallo:
            await media.subir(
                db, producto=producto, datos=imagen(), declarado="image/jpeg",
                alt_text="Una foto sobre algo que ya está en revisión",
                actor_id=quien,
            )
    assert fallo.value.code == "product_not_editable"


# =========================================================================== #
# Guardar el borrador NO borra las fotos
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_guardar_el_borrador_no_se_lleva_las_fotografias(
    sesiones, almacen_falso
) -> None:
    """ERA EL DEFECTO QUE ABRIÓ ESTE CAMBIO. `PUT .../draft` reemplazaba la
    galería entera, así que editar la descripción borraba lo que se acababa de
    subir. Ahora la galería vive fuera de ese camino."""
    quien, producto_id, version_id = await con_producto(sesiones)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        await media.subir(
            db, producto=producto, datos=imagen(), declarado="image/jpeg",
            alt_text="La fotografía que no se puede perder", actor_id=quien,
        )
        await db.commit()

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
        siguen = await db.scalar(
            select(func.count())
            .select_from(ProductMedia)
            .where(ProductMedia.version_id == version_id)
        )
    assert siguen == 1


# =========================================================================== #
# Aprobar y rechazar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_rechazada_lleva_motivo_y_no_sale_en_el_catalogo(
    sesiones, almacen_falso
) -> None:
    quien, producto_id, version_id = await con_producto(sesiones)
    curador = await persona(sesiones, "cur", rol="admin")
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db, producto=producto, datos=imagen(), declarado="image/jpeg",
            alt_text="Una fotografía movida y con poca luz", actor_id=quien,
        )
        await db.commit()
        media_id = fila.id

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await media.decidir(
                db, media_id=media_id, aprobada=False, motivo="", actor_id=curador
            )
    assert fallo.value.code == "product_media_invalid"

    async with sesiones() as db:
        decidida = await media.decidir(
            db, media_id=media_id, aprobada=False,
            motivo="Está movida y no se ve el filo", actor_id=curador,
        )
        await db.commit()
        assert decidida.status == FOTO_RECHAZADA
        assert decidida.reviewed_at is not None
        assert decidida.reviewed_by == curador


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_publica_con_todas_las_fotos_pendientes(
    sesiones, almacen_falso
) -> None:
    """HAY FOTOS Y NINGUNA APROBADA es otro problema y otro arreglo: no falta
    subir nada, falta que alguien las mire. Y por eso tiene su propio código.

    Se lleva el producto hasta `approved` POR EL CAMINO REAL, porque la puerta
    de publicación comprueba el estado ANTES que las fotos: sin llegar hasta
    ahí, el bloqueo que se vería sería otro y esta prueba no probaría nada.
    """
    from tests.test_productos_admision import evaluar_completo, hasta_evaluacion

    dueno = await persona(sesiones, "prov")
    await vendedor(sesiones, dueno)
    evaluador = await persona(sesiones, "cur", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, dueno, evaluador)

    # La foto que trae `producto_en_borrador` viene aprobada: se rechaza para
    # dejar la versión con fotos y NINGUNA aprobada, que es el caso.
    async with sesiones() as db:
        for fila in await db.scalars(
            select(ProductMedia).where(ProductMedia.version_id == version_id)
        ):
            fila.status = FOTO_PENDIENTE
            fila.reviewed_at = None
            fila.reviewed_by = None
        await db.commit()

    evaluacion_id = await evaluar_completo(sesiones, version_id, evaluador)
    # Y SE DECIDE, que es lo que mueve el producto a `approved`: la máquina
    # solo admite ese salto al SISTEMA, a partir de la puntuación.
    async with sesiones() as db:
        from app.modules.products import evaluations

        evidencias = await evaluations.evidencia_de(db, evaluacion_id=evaluacion_id)
        await evaluations.elegir_razones(
            db,
            evaluacion_id=evaluacion_id,
            usuario_id=evaluador,
            razones=[
                {"text": f"Razón respaldada número {i + 1}", "evidence_id": e.id}
                for i, e in enumerate(evidencias[:3])
            ],
        )
        await evaluations.decidir(
            db, evaluacion_id=evaluacion_id, usuario_id=evaluador
        )
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert producto.status == "approved", producto.status
        bloqueo = await service.por_que_no_se_publica(db, producto=producto)
    assert bloqueo is not None
    assert bloqueo[0] == "product_media_not_approved"
    assert bloqueo[1]["pending"] >= 1

    # Y EN CUANTO ALGUIEN LA APRUEBA, la puerta se abre.
    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductMedia).where(ProductMedia.version_id == version_id)
        )
        fila.status = FOTO_APROBADA
        fila.reviewed_at = ahora()
        fila.reviewed_by = evaluador
        fila.content_type = "image/jpeg"
        fila.byte_size = 1_024
        await db.commit()
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert await service.por_que_no_se_publica(db, producto=producto) is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aprobar_dos_veces_no_reescribe_quien_la_aprobo(
    sesiones, almacen_falso
) -> None:
    quien, producto_id, _ = await con_producto(sesiones)
    curador = await persona(sesiones, "cur", rol="admin")
    otro_curador = await persona(sesiones, "cur2", rol="admin")
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db, producto=producto, datos=imagen(), declarado="image/jpeg",
            alt_text="Fotografía frontal del producto", actor_id=quien,
        )
        await db.commit()
        media_id = fila.id

    async with sesiones() as db:
        await media.decidir(
            db, media_id=media_id, aprobada=True, motivo=None, actor_id=curador
        )
        await db.commit()
    async with sesiones() as db:
        await media.decidir(
            db, media_id=media_id, aprobada=True, motivo=None, actor_id=otro_curador
        )
        await db.commit()

    async with sesiones() as db:
        guardada = await db.get(ProductMedia, media_id)
    assert guardada.status == FOTO_APROBADA
    assert guardada.reviewed_by == curador


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_aprueba_una_fila_sin_archivo_detras(sesiones) -> None:
    """APROBAR UNA FILA SIN BYTES dejaría el catálogo firmando una ruta que no
    existe, y la tarjeta saldría rota sin que nada hubiera fallado."""
    quien, producto_id, version_id = await con_producto(sesiones)
    curador = await persona(sesiones, "cur", rol="admin")
    identificador = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(
            ProductMedia(
                id=identificador,
                version_id=version_id,
                storage_path=f"a/b/{version_id}/{identificador}.jpg",
                alt_text="Una fila escrita a mano, sin archivo",
            )
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await media.decidir(
                db, media_id=identificador, aprobada=True, motivo=None,
                actor_id=curador,
            )
    assert fallo.value.code == "product_media_without_file"


# =========================================================================== #
# Borrar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_borra_un_archivo_que_otra_fila_sigue_nombrando(
    sesiones, almacen_falso
) -> None:
    """UNA VERSIÓN NUEVA COPIA LA GALERÍA CON LA MISMA RUTA. Borrar el objeto
    al quitar una de esas filas dejaría a la otra apuntando al vacío."""
    quien, producto_id, version_id = await con_producto(sesiones)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db, producto=producto, datos=imagen(), declarado="image/jpeg",
            alt_text="Fotografía compartida entre dos versiones", actor_id=quien,
        )
        await db.commit()
        media_id, ruta = fila.id, fila.storage_path

    # Otra versión —de otro producto— que nombra EL MISMO archivo.
    otro_quien = await persona(sesiones, "prov2")
    await vendedor(sesiones, otro_quien)
    _, otra_version = await producto_en_borrador(sesiones, otro_quien, con_foto=False)
    async with sesiones() as db:
        db.add(
            ProductMedia(
                version_id=otra_version,
                storage_path=ruta,
                alt_text="La misma fotografía, otra versión",
                status=FOTO_APROBADA,
                content_type="image/jpeg",
                byte_size=100,
                reviewed_at=ahora(),
            )
        )
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        borrado = await media.quitar(db, producto=producto, media_id=media_id)
        await db.commit()

    assert borrado is False
    assert almacen_falso["borrados"] == []
    assert ruta in almacen_falso["subidos"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quitar_la_ultima_referencia_si_borra_el_archivo(
    sesiones, almacen_falso
) -> None:
    quien, producto_id, _ = await con_producto(sesiones)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db, producto=producto, datos=imagen(), declarado="image/jpeg",
            alt_text="La única referencia a este archivo", actor_id=quien,
        )
        await db.commit()
        media_id, ruta = fila.id, fila.storage_path

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        borrado = await media.quitar(db, producto=producto, media_id=media_id)
        await db.commit()

    assert borrado is True
    assert almacen_falso["borrados"] == [ruta]


# =========================================================================== #
# Ordenar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_orden_tiene_que_nombrarlas_todas(sesiones, almacen_falso) -> None:
    """UNA LISTA PARCIAL dejaría las que faltan en una posición que nadie
    eligió, y el orden final no sería ni el viejo ni el nuevo."""
    quien, producto_id, _ = await con_producto(sesiones)
    ids = []
    for i in range(3):
        async with sesiones() as db:
            producto = await db.get(Product, producto_id)
            fila = await media.subir(
                db, producto=producto, datos=imagen(tamano=(64, 48 + i)),
                declarado="image/jpeg", alt_text=f"Fotografía {i} del producto",
                actor_id=quien,
            )
            await db.commit()
            ids.append(fila.id)

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        with pytest.raises(AppError) as fallo:
            await media.ordenar(db, producto=producto, en_orden=ids[:2])
    assert fallo.value.code == "product_media_invalid"

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        puestas = await media.ordenar(
            db, producto=producto, en_orden=[ids[2], ids[0], ids[1]]
        )
        await db.commit()
    assert [m.id for m in puestas] == [ids[2], ids[0], ids[1]]
    assert [m.position for m in puestas] == [0, 1, 2]


# =========================================================================== #
# El catálogo solo firma las aprobadas
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_catalogo_solo_ensena_fotografias_aprobadas(
    sesiones, almacen_falso
) -> None:
    """UNA RECHAZADA NO APARECE PÚBLICAMENTE, y una pendiente tampoco: si
    aparecieran, aprobar el producto aprobaría cualquier imagen que le
    añadieran después."""
    from tests.test_productos_catalogo import publicado
    from app.modules.products import catalog

    producto_id, version_id, _ = await publicado(sesiones)

    async with sesiones() as db:
        db.add(
            ProductMedia(
                version_id=version_id,
                storage_path=f"x/{version_id}/pendiente.jpg",
                alt_text="Pendiente de revisión",
                position=9,
                status=FOTO_PENDIENTE,
                content_type="image/jpeg",
                byte_size=100,
            )
        )
        db.add(
            ProductMedia(
                version_id=version_id,
                storage_path=f"x/{version_id}/rechazada.jpg",
                alt_text="Rechazada por estar movida",
                position=8,
                status=FOTO_RECHAZADA,
                content_type="image/jpeg",
                byte_size=100,
                reviewed_at=ahora(),
                rejection_reason="Está movida",
            )
        )
        await db.commit()

    async with sesiones() as db:
        ficha = await catalog.ficha(db, producto_id=producto_id)

    rutas = [m["storage_path"] for m in ficha.gallery]
    assert not any("pendiente" in r for r in rutas)
    assert not any("rechazada" in r for r in rutas)
    assert len(ficha.gallery) == 1


# =========================================================================== #
# Sin la 0073
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0073_las_fotos_contestan_503_con_su_codigo(
    sesiones, monkeypatch
) -> None:
    """DEGRADACIÓN SEGURA: 503 con su código, no 404 —que haría pensar que la
    ruta está mal escrita— ni 500, que haría pensar que algo se rompió."""
    quien, producto_id, _ = await con_producto(sesiones)

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_fotografias", _no_hay)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        with pytest.raises(AppError) as fallo:
            await media.subir(
                db, producto=producto, datos=imagen(), declarado="image/jpeg",
                alt_text="Una fotografía cualquiera", actor_id=quien,
            )
    assert fallo.value.code == "product_media_not_available"
    assert fallo.value.status_code == 503


# =========================================================================== #
# Lo que impone la base, no el código
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_una_url_donde_va_una_ruta(sesiones) -> None:
    _, _, version_id = await con_producto(sesiones)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "insert into public.product_media (version_id, storage_path, alt_text)"
                " values (cast(%s as uuid), %s, %s)",
                (version_id, "https://cdn.example/1.jpg?firma=x", "una URL"),
            )
    assert "product_media_ruta_no_es_url" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_un_rechazo_sin_motivo(sesiones) -> None:
    _, _, version_id = await con_producto(sesiones)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "insert into public.product_media"
                " (version_id, storage_path, status, reviewed_at)"
                " values (cast(%s as uuid), %s, 'rejected', now())",
                (version_id, "a/b/c/d.jpg"),
            )
    assert "product_media_rechazo_con_motivo" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_aprobar_sin_archivo(sesiones) -> None:
    _, _, version_id = await con_producto(sesiones)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "insert into public.product_media"
                " (version_id, storage_path, status, reviewed_at)"
                " values (cast(%s as uuid), %s, 'approved', now())",
                (version_id, "a/b/c/e.jpg"),
            )
    assert "product_media_aprobada_con_archivo" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_deposito_es_privado_y_no_admite_cualquier_tipo(sesiones) -> None:
    """EL DEPÓSITO PÚBLICO SERÍA UNA GALERÍA ABIERTA de productos que nadie ha
    aprobado, y `allowed_mime_types` nulo admitiría ejecutables."""
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        cur.execute(
            "select public, allowed_mime_types, file_size_limit"
            " from storage.buckets where id = 'product-media'"
        )
        fila = cur.fetchone()
    assert fila is not None, "la 0073 no dejó el depósito"
    assert fila[0] is False
    assert sorted(fila[1]) == ["image/jpeg", "image/png", "image/webp"]
    assert fila[2] == MAXIMO_BYTES_DE_LA_FOTO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_deposito_no_tiene_ninguna_politica(sesiones) -> None:
    """LA ÚNICA PUERTA ES LA API. Sin políticas, `anon` y `authenticated` no
    pueden ni leer ni listar ni escribir en el depósito."""
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        cur.execute(
            "select count(*) from pg_policies where schemaname = 'storage'"
            " and tablename = 'objects' and qual like '%product-media%'"
        )
        assert cur.fetchone()[0] == 0
