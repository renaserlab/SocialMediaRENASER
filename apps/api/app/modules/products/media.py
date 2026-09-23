"""Las fotografías de un producto: subir, ordenar, quitar y aprobar.

EL ARCHIVO NO VIAJA DESDE EL MÓVIL AL ALMACENAMIENTO. Viaja a esta API, que
comprueba de quién es el borrador, MIRA LOS BYTES, genera el nombre y solo
entonces escribe con la clave de servicio. El depósito `product-media` (0073) es
privado y NO TIENE NINGUNA POLÍTICA: `anon` y `authenticated` no pueden ni leer
ni listar. La única puerta es esta.

LAS SIETE REGLAS QUE ESTE FICHERO SOSTIENE:

  1. NO SE ACEPTA UNA RUTA PEGADA. Antes, quien vendía escribía a mano la ruta
     del almacenamiento. Eso permitía apuntar a un archivo ajeno —o a ninguno—
     y la galería enseñaba lo que dijera esa cadena. Ahora la ruta LA GENERA EL
     SERVIDOR a partir del proveedor, el producto, la versión y un identificador
     nuevo.
  2. SE MIRAN LOS BYTES, NO LA EXTENSIÓN. Un `.jpg` no es un JPEG porque se
     llame así, y el `Content-Type` lo escribe quien sube. Se decodifica la
     imagen de verdad: si no abre, no es una imagen.
  3. SUBIR NO ES PUBLICAR. Nace `pending`. Quien evalúa aprueba o rechaza con
     motivo, y el catálogo solo firma las aprobadas: una rechazada no aparece.
  4. SOLO EL PROPIETARIO, Y SOLO EN BORRADOR. Lo publicado es lo que se evaluó:
     cambiarle una foto reescribiría en silencio lo que vio quien compró.
  5. NO SE BORRA UN ARCHIVO QUE SIGUE REFERENCIADO. Una versión nueva copia las
     filas de la galería con LA MISMA RUTA, sin volver a subir los bytes.
     Borrar el objeto al quitar una de esas filas dejaría la otra apuntando al
     vacío, y la versión publicada perdería su foto.
  6. LA URL SE FIRMA EN EL MOMENTO Y CADUCA. Guardarla haría que la galería
     dejara de cargar sin que nadie tocara nada.
  7. UN DOBLE TOQUE NO SUBE DOS VECES. El identificador de la fila se deriva de
     la clave de idempotencia, así que el reintento choca contra la clave
     primaria en vez de dejar dos fotos iguales.

LO QUE AQUÍ NO SE HACE: ninguna miniatura, ningún recorte, ninguna marca de
agua y ningún reencuadre. Transformar la fotografía de alguien sin que lo pida
es decidir por él cómo se ve su producto.
"""

from __future__ import annotations

import hashlib
import io
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ValidationAppError,
)
from app.modules.products import esquema
from app.modules.products.models import (
    EXTENSION_DE_LA_IMAGEN,
    FOTO_APROBADA,
    FOTO_PENDIENTE,
    FOTO_RECHAZADA,
    MAXIMO_BYTES_DE_LA_FOTO,
    MAXIMO_DE_FOTOS,
    TIPOS_DE_IMAGEN,
    Product,
    ProductMedia,
    ProductSeller,
    ProductVersion,
)
from app.modules.products.states import EDITABLES
from app.shared import storage

logger = logging.getLogger("renaser.products")

#: El depósito de la 0073. Privado, sin políticas, solo por la API.
DEPOSITO = "product-media"

#: Cuánto vive una URL firmada del catálogo. Una hora: lo bastante para pintar
#: una pantalla y volver atrás, lo bastante poco para que reenviarla por chat no
#: sea una forma de compartir el archivo para siempre.
SEGUNDOS_DE_LA_FIRMA = 3600

#: Los primeros bytes de cada formato. Se comprueban ANTES de decodificar: abrir
#: un archivo cualquiera con una biblioteca de imágenes es más superficie de la
#: necesaria, y estos tres prefijos descartan casi todo lo que no toca.
_FIRMAS: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
)

#: Espacio de nombres de los identificadores derivados. ES UNA CONSTANTE Y NO SE
#: CAMBIA: cambiarlo haría que la misma clave de idempotencia produjera otro id,
#: y el reintento que llega después del despliegue subiría la foto dos veces.
_ESPACIO = uuid.UUID("2f4c7d51-0a3e-5b62-9f18-6c4d2a9e70b1")


class FotoNoEncontrada(NotFoundError):
    code = "product_media_not_found"


class FotoInvalida(ValidationAppError):
    code = "product_media_invalid"


class DemasiadasFotos(ConflictError):
    code = "product_media_limit_reached"


@dataclass(frozen=True)
class Medida:
    """Lo que el servidor averiguó del archivo mirándolo."""

    content_type: str
    byte_size: int
    width: int
    height: int
    checksum_sha256: str


# --------------------------------------------------------------------------- #
# Mirar los bytes
# --------------------------------------------------------------------------- #
def _tipo_por_los_bytes(datos: bytes) -> str | None:
    """El tipo real, deducido del contenido. `None` si no es de los tres."""
    for firma, tipo in _FIRMAS:
        if datos.startswith(firma):
            return tipo
    #: WebP es `RIFF....WEBP`, con el tamaño en medio.
    if datos[:4] == b"RIFF" and datos[8:12] == b"WEBP":
        return "image/webp"
    return None


def medir(datos: bytes, *, declarado: str | None = None) -> Medida:
    """Qué es este archivo de verdad. Se para si no es una fotografía.

    EL `Content-Type` DECLARADO NO DECIDE NADA: lo escribe quien sube. Sirve
    únicamente para dar un error más claro cuando no coincide con lo que hay
    dentro, que es el caso de alguien que renombró un archivo.
    """
    if not datos:
        raise FotoInvalida("El archivo está vacío.")
    if len(datos) > MAXIMO_BYTES_DE_LA_FOTO:
        raise FotoInvalida(
            "La fotografía pesa demasiado.",
            details={
                "byte_size": len(datos),
                "max_bytes": MAXIMO_BYTES_DE_LA_FOTO,
            },
        )

    tipo = _tipo_por_los_bytes(datos)
    if tipo is None:
        raise FotoInvalida(
            "El archivo no es una fotografía JPEG, PNG ni WebP.",
            details={"declared": declarado, "allowed": list(TIPOS_DE_IMAGEN)},
        )
    if declarado and declarado.split(";")[0].strip().lower() != tipo:
        raise FotoInvalida(
            "El contenido del archivo no coincide con el tipo declarado.",
            details={"declared": declarado, "detected": tipo},
        )

    #: Y AHORA SE DECODIFICA DE VERDAD. Los primeros bytes se pueden falsificar
    #: pegando una cabecera delante de cualquier cosa; abrir la imagen es lo que
    #: distingue una fotografía de un archivo disfrazado de fotografía.
    try:
        from PIL import Image

        with Image.open(io.BytesIO(datos)) as imagen:
            imagen.verify()
        with Image.open(io.BytesIO(datos)) as imagen:
            ancho, alto = imagen.size
            formato = (imagen.format or "").lower()
    except FotoInvalida:
        raise
    except Exception as error:  # noqa: BLE001 - cualquier fallo es «no es una foto»
        raise FotoInvalida(
            "El archivo no se puede abrir como imagen.",
            details={"detected": tipo},
        ) from error

    ESPERADO = {"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp"}
    if formato != ESPERADO[tipo]:
        raise FotoInvalida(
            "El contenido no coincide con su cabecera.",
            details={"header": tipo, "decoded": formato},
        )
    if ancho <= 0 or alto <= 0:
        raise FotoInvalida("La fotografía no tiene medidas.")

    return Medida(
        content_type=tipo,
        byte_size=len(datos),
        width=int(ancho),
        height=int(alto),
        checksum_sha256=hashlib.sha256(datos).hexdigest(),
    )


def ruta_de(
    *, seller_id: str, product_id: str, version_id: str, media_id: str, tipo: str
) -> str:
    """`proveedor/producto/version/identificador.ext`. LA GENERA EL SERVIDOR.

    Nada de esto viene del cliente: ni el nombre, ni la extensión, ni las
    carpetas. Un nombre elegido por quien sube puede traer `../`, un punto de
    más o el nombre de un archivo ajeno.
    """
    return (
        f"{seller_id}/{product_id}/{version_id}/"
        f"{media_id}.{EXTENSION_DE_LA_IMAGEN[tipo]}"
    )


def _id_derivado(version_id: str, actor_id: str, clave: str | None) -> str | None:
    """El identificador que le toca a esta subida, o `None` sin clave."""
    if not clave or not clave.strip():
        return None
    return str(uuid.uuid5(_ESPACIO, f"{version_id}:{actor_id}:{clave.strip()}"))


# --------------------------------------------------------------------------- #
# El borrador de quien vende
# --------------------------------------------------------------------------- #
async def _borrador_editable(db: AsyncSession, *, producto: Product) -> ProductVersion:
    """La versión borrador del producto, si todavía se puede tocar."""
    if producto.status not in EDITABLES:
        raise ConflictError(
            "Solo se cambian las fotografías de un borrador.",
            code="product_not_editable",
            details={"status": producto.status},
        )
    version = await db.scalar(
        select(ProductVersion).where(
            ProductVersion.product_id == producto.id,
            ProductVersion.status == "draft",
        )
    )
    if version is None:
        raise ConflictError(
            "Este producto no tiene una versión en borrador.",
            code="product_version_missing",
        )
    return version


async def cuantas(db: AsyncSession, *, version_id: str) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ProductMedia)
            .where(ProductMedia.version_id == version_id)
        )
        or 0
    )


async def subir(
    db: AsyncSession,
    *,
    producto: Product,
    datos: bytes,
    declarado: str | None,
    alt_text: str,
    actor_id: str,
    clave: str | None = None,
) -> ProductMedia:
    """Guarda una fotografía del borrador. Nace PENDIENTE de aprobación.

    EL TEXTO ALTERNATIVO ES OBLIGATORIO. No es un adorno de accesibilidad: es lo
    único que queda cuando la imagen no carga, y es lo que lee quien no ve.
    """
    await esquema.exigir_fotografias(db)
    version = await _borrador_editable(db, producto=producto)

    alt = (alt_text or "").strip()
    if len(alt) < 3:
        raise FotoInvalida(
            "La fotografía necesita un texto alternativo que la describa.",
            details={"field": "alt_text"},
        )
    if len(alt) > 300:
        raise FotoInvalida("El texto alternativo es demasiado largo.")

    if await cuantas(db, version_id=version.id) >= MAXIMO_DE_FOTOS:
        raise DemasiadasFotos(
            "Esta versión ya tiene todas las fotografías que admite.",
            details={"max": MAXIMO_DE_FOTOS},
        )

    medida = medir(datos, declarado=declarado)

    vendedor_id = await db.scalar(
        select(ProductSeller.id).where(ProductSeller.id == producto.seller_id)
    )
    media_id = _id_derivado(version.id, actor_id, clave) or str(uuid.uuid4())
    ruta = ruta_de(
        seller_id=str(vendedor_id),
        product_id=producto.id,
        version_id=version.id,
        media_id=media_id,
        tipo=medida.content_type,
    )

    #: EL ARCHIVO PRIMERO. Si la subida falla, no queda una fila que promete una
    #: fotografía que no existe; si la fila falla, queda un objeto sin
    #: referencia, que es basura y no una mentira.
    await storage.subir_objeto(DEPOSITO, ruta, datos, medida.content_type)

    siguiente = (
        await db.scalar(
            select(func.coalesce(func.max(ProductMedia.position), -1)).where(
                ProductMedia.version_id == version.id
            )
        )
    ) + 1

    fila = ProductMedia(
        id=media_id,
        version_id=version.id,
        kind="image",
        storage_path=ruta,
        alt_text=alt,
        position=int(siguiente),
        created_by=actor_id,
        status=FOTO_PENDIENTE,
        content_type=medida.content_type,
        byte_size=medida.byte_size,
        width=medida.width,
        height=medida.height,
        checksum_sha256=medida.checksum_sha256,
    )
    db.add(fila)
    await db.flush()
    return fila


async def ordenar(
    db: AsyncSession, *, producto: Product, en_orden: list[str]
) -> list[ProductMedia]:
    """Deja las fotografías en el orden que llega. TODAS o ninguna.

    Aceptar una lista parcial dejaría las que faltan en una posición que nadie
    eligió, y el orden final no sería ni el viejo ni el nuevo.
    """
    await esquema.exigir_fotografias(db)
    version = await _borrador_editable(db, producto=producto)
    actuales = list(
        await db.scalars(
            select(ProductMedia).where(ProductMedia.version_id == version.id)
        )
    )
    if sorted(m.id for m in actuales) != sorted(set(en_orden)):
        raise FotoInvalida(
            "El orden tiene que nombrar exactamente las fotografías que hay.",
            details={"expected": sorted(m.id for m in actuales)},
        )
    por_id = {m.id: m for m in actuales}
    for posicion, media_id in enumerate(en_orden):
        por_id[media_id].position = posicion
    await db.flush()
    return [por_id[i] for i in en_orden]


async def _sigue_referenciado(db: AsyncSession, *, ruta: str, salvo: str) -> bool:
    """¿Queda alguna otra fila apuntando a este archivo?"""
    return bool(
        await db.scalar(
            select(func.count())
            .select_from(ProductMedia)
            .where(ProductMedia.storage_path == ruta, ProductMedia.id != salvo)
        )
    )


async def quitar(db: AsyncSession, *, producto: Product, media_id: str) -> bool:
    """Quita una fotografía del borrador.

    BORRA EL ARCHIVO SOLO SI NADIE MÁS LO NOMBRA. Una versión nueva copia la
    galería con la misma ruta; borrar el objeto aquí dejaría a la versión
    publicada apuntando al vacío.
    """
    await esquema.exigir_fotografias(db)
    version = await _borrador_editable(db, producto=producto)
    fila = await db.get(ProductMedia, media_id)
    if fila is None or fila.version_id != version.id:
        raise FotoNoEncontrada("Fotografía no encontrada.")

    ruta = fila.storage_path
    compartida = await _sigue_referenciado(db, ruta=ruta, salvo=fila.id)
    await db.delete(fila)
    await db.flush()

    if not compartida:
        try:
            await storage.borrar_objeto(DEPOSITO, ruta)
        except storage.StorageNoConfigurado:
            #: La fila ya se fue. Dejar el objeto es basura que se limpia; no
            #: quitar la fila sería una galería que enseña lo que se quitó.
            logger.warning("Queda huérfano %s/%s: Storage sin configurar", DEPOSITO, ruta)
    return not compartida


# --------------------------------------------------------------------------- #
# La aprobación
# --------------------------------------------------------------------------- #
async def decidir(
    db: AsyncSession,
    *,
    media_id: str,
    aprobada: bool,
    motivo: str | None,
    actor_id: str,
    momento: datetime | None = None,
) -> ProductMedia:
    """Aprueba o rechaza una fotografía. UN RECHAZO LLEVA MOTIVO.

    Decidir dos veces lo mismo es decidir una: repetir la aprobación devuelve la
    fila sin tocar la fecha, así que un doble toque no reescribe quién la
    aprobó ni cuándo.
    """
    await esquema.exigir_fotografias(db)
    fila = await db.get(ProductMedia, media_id)
    if fila is None:
        raise FotoNoEncontrada("Fotografía no encontrada.")

    destino = FOTO_APROBADA if aprobada else FOTO_RECHAZADA
    limpio = (motivo or "").strip()
    if not aprobada and len(limpio) < 3:
        raise FotoInvalida(
            "Un rechazo lleva motivo: es lo único que permite corregirlo.",
            details={"field": "reason"},
        )
    if aprobada and not (fila.content_type and fila.byte_size):
        #: Aprobar una fila sin archivo dejaría el catálogo firmando una ruta
        #: que no existe, y la tarjeta saldría rota sin que nada hubiera fallado.
        raise ConflictError(
            "Esta fotografía no tiene un archivo detrás.",
            code="product_media_without_file",
        )
    if fila.status == destino:
        return fila

    fila.status = destino
    fila.reviewed_at = momento or datetime.now(timezone.utc)
    fila.reviewed_by = actor_id
    fila.rejection_reason = None if aprobada else limpio
    await db.flush()
    return fila


async def pendientes(db: AsyncSession, *, limite: int = 50) -> list[tuple]:
    """La bandeja de quien revisa: `(foto, version, producto)`, lo más viejo
    primero, que es lo que lleva más tiempo esperando."""
    await esquema.exigir_fotografias(db)
    return list(
        (
            await db.execute(
                select(ProductMedia, ProductVersion, Product)
                .join(ProductVersion, ProductVersion.id == ProductMedia.version_id)
                .join(Product, Product.id == ProductVersion.product_id)
                .where(ProductMedia.status == FOTO_PENDIENTE)
                .order_by(ProductMedia.created_at, ProductMedia.id)
                .limit(max(1, min(int(limite), 200)))
            )
        ).all()
    )


# --------------------------------------------------------------------------- #
# Firmar, para el catálogo
# --------------------------------------------------------------------------- #
async def firmar(rutas: list[str]) -> dict[str, str]:
    """`ruta -> URL firmada` de las que se puedan firmar. NUNCA lanza.

    Una portada no se cae porque el almacenamiento no conteste: lo que ocurre
    es que esas tarjetas salen con su texto alternativo, que es exactamente lo
    que pasaba antes de que existiera el depósito. Y SI NO HAY CREDENCIALES,
    tampoco: en un entorno local sin claves el catálogo se recorre igual.
    """
    if not rutas:
        return {}
    try:
        return await storage.firmar_objetos(
            DEPOSITO, rutas, segundos=SEGUNDOS_DE_LA_FIRMA
        )
    except storage.StorageNoConfigurado:
        return {}
    except Exception:  # noqa: BLE001 - ver la cabecera
        logger.warning("No se pudieron firmar %d fotografías", len(rutas))
        return {}


__all__ = [
    "DEPOSITO",
    "DemasiadasFotos",
    "FotoInvalida",
    "FotoNoEncontrada",
    "Medida",
    "SEGUNDOS_DE_LA_FIRMA",
    "cuantas",
    "decidir",
    "firmar",
    "medir",
    "ordenar",
    "pendientes",
    "quitar",
    "ruta_de",
    "subir",
]
