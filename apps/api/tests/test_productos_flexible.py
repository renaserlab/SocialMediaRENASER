"""Productos en MODO FLEXIBLE (`PUBLICACION_FLEXIBLE`), contra PostgreSQL real.

LO QUE DEFIENDEN ESTAS PRUEBAS (24/09/2026):
  1. La postulación de proveedor se acepta al enviarla, y quien postula queda
     activo y avisado.
  2. Quien vende publica su borrador sin evaluación, pero no sin foto: una
     ficha sin imagen no es un producto.
  3. Un producto publicado se EDITA: la versión nueva lleva la galería de la
     vigente y, al publicarla, supera a la anterior sin salir del catálogo.
  4. Sin el modo, lo publicado sigue sin poder tocarse.
  5. La categoría se cambia al guardar, y una que no existe se rechaza.
  6. Una foto nace aprobada en este modo.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.notifications.models import Notification
from app.modules.products import applications, media, service
from app.modules.products.models import (
    FOTO_APROBADA,
    FOTO_PENDIENTE,
    PUBLICADO,
    VERSION_PUBLICADA,
    VERSION_SUPERADA,
    Product,
    ProductMedia,
    ProductSeller,
    ProductVersion,
    SellerApplication,
)
from tests.test_productos_admision import postular
from tests.test_productos_dominio import (  # noqa: F401
    DATOS,
    SIN_POSTGRES,
    URL,
    ahora,
    base_aplicada,
    categoria,
    persona,
    producto_en_borrador,
    sesiones,
    vendedor,
)
from tests.test_productos_fotografias import almacen_falso, imagen  # noqa: F401


@pytest.fixture()
def flexible(monkeypatch):
    monkeypatch.setattr(get_settings(), "publicacion_flexible", True, raising=False)


async def _avisos(sesiones, usuario: str) -> list[str]:
    async with sesiones() as db:
        filas = await db.scalars(
            select(Notification.type).where(Notification.user_id == usuario)
        )
        return list(filas)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_postulacion_se_acepta_al_enviarla(sesiones) -> None:
    quien = await persona(sesiones, "post")
    ident = await postular(sesiones, quien, enviar=False)
    async with sesiones() as db:
        postulacion = await db.get(SellerApplication, ident)
        await applications.enviar(db, postulacion_id=ident, usuario_id=quien)
        await applications.aceptar_al_enviar(db, postulacion=postulacion)
        await db.commit()

    async with sesiones() as db:
        postulacion = await db.get(SellerApplication, ident)
        assert postulacion.status == "accepted"
        assert postulacion.decided_by is None
        vendedor_ = await db.scalar(
            select(ProductSeller).where(ProductSeller.profile_id == quien)
        )
        assert vendedor_ is not None and vendedor_.status == "active"
    assert await _avisos(sesiones, quien) == ["seller_application_accepted"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_vende_publica_su_borrador_sin_evaluacion(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(sesiones, quien)

    async with sesiones() as db:
        await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        version = await db.get(ProductVersion, version_id)
        assert producto.status == PUBLICADO
        assert producto.published_version_id == version_id
        assert version.status == VERSION_PUBLICADA
    assert await _avisos(sesiones, quien) == ["product_published"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_foto_no_se_publica(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien, con_foto=False)
    async with sesiones() as db:
        with pytest.raises(ConflictError) as fallo:
            await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
    assert fallo.value.code == "product_media_required"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_foto_pendiente_de_antes_se_aprueba_al_publicar(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(sesiones, quien, con_foto=False)
    foto = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(
            ProductMedia(
                id=foto,
                version_id=version_id,
                kind="image",
                storage_path=f"v/p/{version_id}/{foto}.jpg",
                alt_text="Cuchillo sobre la tabla",
                position=0,
                status=FOTO_PENDIENTE,
                content_type="image/jpeg",
                byte_size=1000,
                checksum_sha256="b" * 64,
            )
        )
        await db.commit()
    async with sesiones() as db:
        await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()
    async with sesiones() as db:
        fila = await db.get(ProductMedia, foto)
        assert fila.status == FOTO_APROBADA
        assert fila.reviewed_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_publicado_se_edita_con_su_galeria_y_se_vuelve_a_publicar(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, v1 = await producto_en_borrador(sesiones, quien)
    async with sesiones() as db:
        await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()

    async with sesiones() as db:
        v2 = await service.guardar_borrador(
            db,
            producto_id=producto_id,
            usuario_id=quien,
            datos={**DATOS, "name": "Cuchillo de cocina forjado, edición 2"},
            flexible=True,
        )
        await db.commit()
        v2_id = v2.id
    assert v2_id != v1
    async with sesiones() as db:
        fotos = await db.scalar(
            select(func.count()).select_from(ProductMedia).where(ProductMedia.version_id == v2_id)
        )
        assert fotos == 1, "la versión nueva nace con la galería de la publicada"
        # Mientras no se publica, el catálogo sigue con la vigente.
        assert (await db.get(Product, producto_id)).published_version_id == v1

    async with sesiones() as db:
        await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert producto.status == PUBLICADO
        assert producto.published_version_id == v2_id
        assert (await db.get(ProductVersion, v1)).status == VERSION_SUPERADA
        assert (await db.get(ProductVersion, v2_id)).status == VERSION_PUBLICADA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_modo_flexible_lo_publicado_no_se_toca(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)
    async with sesiones() as db:
        await service.publicar_sin_admision(db, producto_id=producto_id, usuario_id=quien)
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(ConflictError) as fallo:
            await service.guardar_borrador(
                db, producto_id=producto_id, usuario_id=quien, datos=DATOS, flexible=False
            )
    assert fallo.value.code == "product_not_editable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_categoria_se_elige_al_guardar(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien, con_foto=False)
    cat = await categoria(sesiones)
    async with sesiones() as db:
        await service.guardar_borrador(
            db, producto_id=producto_id, usuario_id=quien, datos={**DATOS, "category_id": cat}
        )
        await db.commit()
    async with sesiones() as db:
        assert (await db.get(Product, producto_id)).category_id == cat
        with pytest.raises(ValidationAppError) as fallo:
            await service.guardar_borrador(
                db,
                producto_id=producto_id,
                usuario_id=quien,
                datos={**DATOS, "category_id": str(uuid.uuid4())},
            )
    assert fallo.value.code == "product_category_invalid"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_modo_flexible_la_foto_nace_aprobada(sesiones, almacen_falso, flexible) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien, con_foto=False)
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        fila = await media.subir(
            db,
            producto=producto,
            datos=imagen(),
            declarado="image/jpeg",
            alt_text="Cuchillo sobre la tabla",
            actor_id=quien,
        )
        await db.commit()
        assert fila.status == FOTO_APROBADA
        assert fila.reviewed_at is not None


# =========================================================================== #
# Documentos de la postulación (0085)
# =========================================================================== #
@pytest.fixture()
def deposito_de_documentos(monkeypatch):
    from app.shared import storage

    subidos: dict[str, bytes] = {}

    async def _subir(bucket, ruta, datos, content_type, *, sobrescribir=False):
        assert bucket == applications.DEPOSITO_DE_DOCUMENTOS
        subidos[ruta] = datos

    monkeypatch.setattr(storage, "subir_objeto", _subir)
    monkeypatch.setattr(storage, "storage_configured", lambda: True)
    return subidos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pdf_se_sube_con_ruta_propia(sesiones, deposito_de_documentos) -> None:
    quien = await persona(sesiones, "post")
    ident = await postular(sesiones, quien, enviar=False)
    async with sesiones() as db:
        await applications.subir_documento(
            db,
            usuario_id=quien,
            kind="identity",
            nota="DNI por las dos caras",
            datos=b"%PDF-1.7 contenido de prueba",
            declarado="application/pdf",
        )
        await db.commit()
        documentos = await applications.documentos_de(db, postulacion_id=ident)
    subido = [d for d in documentos if d.storage_path]
    assert len(subido) == 1
    assert subido[0].storage_path.startswith(f"{quien}/{ident}/")
    assert subido[0].storage_path.endswith(".pdf")
    assert subido[0].storage_path in deposito_de_documentos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_archivo_que_no_es_pdf_ni_foto_se_rechaza(sesiones, deposito_de_documentos) -> None:
    quien = await persona(sesiones, "post")
    await postular(sesiones, quien, enviar=False)
    async with sesiones() as db:
        with pytest.raises(ValidationAppError) as fallo:
            await applications.subir_documento(
                db, usuario_id=quien, kind="other", nota=None,
                datos=b"MZ\x90\x00ejecutable", declarado="application/pdf",
            )
    assert fallo.value.code == "seller_application_document_type_invalid"
    assert deposito_de_documentos == {}


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_guarda_una_ruta_ajena(sesiones) -> None:
    """Las rutas las genera el servidor; al guardar solo vuelven las propias."""
    quien = await persona(sesiones, "post")
    async with sesiones() as db:
        with pytest.raises(ValidationAppError) as fallo:
            await applications.guardar(
                db,
                usuario_id=quien,
                display_name="Taller Andino",
                proposal="Hacemos cuchillos forjados a mano en Cusco desde 2010.",
                documentos=[{"kind": "identity", "storage_path": "otra-persona/dni.pdf"}],
            )
    assert fallo.value.code == "seller_application_document_path_invalid"
