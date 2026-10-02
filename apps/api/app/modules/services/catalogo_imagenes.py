"""Las imágenes de un servicio: subir, ordenar, elegir portada, quitar y firmar.

REUTILIZA LO QUE YA EXISTE: `products.media.medir` mira los bytes (y decodifica
la imagen de verdad), y `shared/storage.py` sube, borra y firma en el depósito
PRIVADO `service-media` (0090). No hay procesador nuevo, ni miniaturas, ni
recortes.

LAS REGLAS:

  1. LA RUTA LA PONE EL SERVIDOR Y ES OPACA (P29, 0096):
     `<servicio>/<32 hexadecimales al azar>.<ext>`. Nada viene del cliente y
     nada sale del título, del prestador ni de su perfil: la URL firmada de
     una tarjeta, que se ve sin sesión, ya no lleva el identificador del
     perfil de nadie. El del servicio sí: es el mismo que lleva la dirección
     de su ficha, y con él delante la base comprueba que la ruta es de ese
     servicio y la baja de la cuenta barre la carpeta entera (también lo que
     se subió y se quedó sin fila). LAS RUTAS ANTERIORES (0090,
     `<perfil>/<servicio>/<versión>/<id>.<ext>`) siguen valiendo donde ya
     existan: se firman, se copian a una versión nueva y se borran igual. Lo
     que no se puede es REGISTRAR una nueva con esa forma: lo impide la base.
  2. SE MIRAN LOS BYTES y el peso (5 MB). JPEG, PNG o WebP; nada más.
  3. SOLO EN EL BORRADOR, SOLO EL DUEÑO. Lo enviado está congelado (y la base
     no deja tocar imágenes fuera del borrador).
  4. NO SE BORRA UN ARCHIVO QUE SIGUE REFERENCIADO: una versión nueva copia
     las filas con la misma ruta. Quitar una del borrador borra el objeto solo
     si ninguna otra versión lo nombra; así la publicada nunca se queda sin su
     imagen.
  5. LA URL SE FIRMA AL LEER Y CADUCA. Nunca se guarda ni se devuelve la ruta.
  6. UN DOBLE TOQUE NO SUBE DOS VECES: el id de la FILA se deriva de la clave
     de idempotencia (como en Productos), y un reintento devuelve la imagen
     que ya está. La ruta no: cada subida que llega a escribir un archivo
     tiene un nombre que no se puede adivinar ni repetir.
"""

from __future__ import annotations

import logging
import re
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ServiceUnavailableError, ValidationAppError
from app.modules.services import catalogo, catalogo_estados as estados
from app.modules.services.catalogo_models import (
    PESO_MAXIMO_DE_LA_IMAGEN,
    Service,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.catalogo_requisitos import Reglas
from app.shared import storage

logger = logging.getLogger("renaser.services")

DEPOSITO = "service-media"
#: Una hora, como las fotos de Productos: pintar una pantalla y volver atrás.
SEGUNDOS_DE_LA_FIRMA = 3600
_EXTENSION = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
#: La forma de una ruta nueva, LA MISMA que exige la 0096. 128 bits al azar.
RUTA_OPACA = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}\.(jpg|png|webp)$"
)
#: CONSTANTE. Cambiarla haría que la misma clave diera otro id.
_ESPACIO = uuid.UUID("6b1f3a2e-9c4d-5e7f-8a1b-2c3d4e5f6a7b")


class ImagenNoEncontrada(NotFoundError):
    code = "service_image_not_found"
    message = "No encontramos esa imagen."


class ImagenInvalida(ValidationAppError):
    code = "service_image_invalid"
    message = "Sube una foto JPEG, PNG o WebP de hasta 5 MB."


class DemasiadasImagenes(ConflictError):
    code = "service_image_limit_reached"
    message = "Este servicio ya tiene todas las imágenes que admite."


class AlmacenamientoNoDisponible(ServiceUnavailableError):
    code = "service_storage_unavailable"
    message = "No pudimos guardar la imagen. Inténtalo de nuevo."


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def ruta_nueva(servicio_id: str, content_type: str) -> str:
    """La ruta de un archivo que se va a escribir. La extensión sale del tipo
    que dijeron LOS BYTES (`_medir`), nunca del nombre que mandó el teléfono."""
    return f"{servicio_id}/{secrets.token_hex(16)}.{_EXTENSION[content_type]}"


async def _borrador(db: AsyncSession, servicio: Service) -> ServiceVersion:
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise catalogo.ServicioRetirado()
    version = await catalogo.abierta(db, servicio.id)
    if version is None:
        raise catalogo.SinBorrador()
    if version.status != estados.BORRADOR:
        raise catalogo.VersionPendiente(details={"status": version.status})
    return version


def _medir(datos: bytes, declarado: str | None):
    """`products.media.medir` con el tope de este depósito (5 MB)."""
    from app.modules.products import media

    if not datos:
        raise ImagenInvalida(details={"reason": "empty"})
    if len(datos) > PESO_MAXIMO_DE_LA_IMAGEN:
        raise ImagenInvalida(details={"reason": "too_big", "max_bytes": PESO_MAXIMO_DE_LA_IMAGEN})
    try:
        return media.medir(datos, declarado=declarado)
    except Exception:  # noqa: BLE001 - cualquier fallo es «no es una foto»
        raise ImagenInvalida(details={"reason": "not_an_image"}) from None


def _alternativo(texto: str | None) -> str:
    limpio = (texto or "").strip()
    if not 3 <= len(limpio) <= 300:
        raise ImagenInvalida(
            "La imagen necesita una descripción corta para quien no la ve.",
            details={"field": "alt_text"},
        )
    return limpio


async def subir(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    datos: bytes,
    declarado: str | None,
    alt_text: str | None,
    clave: str | None,
) -> tuple[ServiceVersionImage, bool]:
    """`(imagen, nueva)`. Un reintento con la misma clave devuelve la misma."""
    servicio, prestador = await catalogo.mio(db, usuario_id, servicio_id)
    catalogo.exigir_activo(prestador)
    version = await _borrador(db, servicio)
    alt = _alternativo(alt_text)

    imagen_id = (
        str(uuid.uuid5(_ESPACIO, f"{version.id}:{usuario_id}:{clave.strip()}"))
        if clave and clave.strip()
        else str(uuid.uuid4())
    )
    repetida = await db.get(ServiceVersionImage, imagen_id)
    if repetida is not None and repetida.version_id == version.id:
        return repetida, False

    actuales = await catalogo.imagenes_de(db, version.id)
    if len(actuales) >= Reglas.de().maximo_de_imagenes:
        raise DemasiadasImagenes(details={"max": Reglas.de().maximo_de_imagenes})

    medida = _medir(datos, declarado)
    ruta = ruta_nueva(servicio.id, medida.content_type)

    # EL ARCHIVO PRIMERO: si falla, no queda una fila que promete una imagen.
    try:
        # LA RUTA ES NUEVA SIEMPRE, así que nunca pisa nada. Si un intento
        # anterior escribió su archivo y se cortó antes de guardar la fila, ese
        # archivo queda sin nombre en la base, bajo la carpeta del servicio: lo
        # barre la baja de la cuenta. El reintento sube el suyo.
        await storage.subir_objeto(DEPOSITO, ruta, datos, medida.content_type, sobrescribir=False)
    except (storage.StorageNoConfigurado, storage.StorageFallo):
        raise AlmacenamientoNoDisponible() from None
    except Exception:  # noqa: BLE001 - httpx y compañía
        raise AlmacenamientoNoDisponible() from None

    fila = ServiceVersionImage(
        id=imagen_id,
        version_id=version.id,
        service_id=servicio.id,
        storage_path=ruta,
        alt_text=alt,
        position=(max((i.position for i in actuales), default=-1) + 1),
        # LA PRIMERA ES LA PORTADA: un servicio siempre tiene una en cuanto
        # tiene una imagen.
        is_cover=not any(i.is_cover for i in actuales),
        content_type=medida.content_type,
        byte_size=medida.byte_size,
        width=medida.width,
        height=medida.height,
        checksum_sha256=medida.checksum_sha256,
        created_by=usuario_id,
        created_at=_ahora(),
    )
    try:
        db.add(fila)
        await db.flush()
    except BaseException:
        # Sin su fila, el archivo no es de nadie.
        await borrar_archivo(ruta)
        raise
    version.updated_at = _ahora()
    return fila, True


async def ordenar(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, en_orden: list[str], portada: str | None
) -> list[ServiceVersionImage]:
    """TODAS o ninguna, y la portada entre ellas."""
    servicio, _ = await catalogo.mio(db, usuario_id, servicio_id)
    version = await _borrador(db, servicio)
    actuales = await catalogo.imagenes_de(db, version.id)
    if sorted(i.id for i in actuales) != sorted(set(en_orden)) or len(en_orden) != len(actuales):
        raise ImagenInvalida(
            "El orden tiene que nombrar exactamente las imágenes que hay.",
            details={"field": "image_ids"},
        )
    if portada is not None and portada not in en_orden:
        raise ImagenInvalida("La portada tiene que ser una de las imágenes.", details={"field": "cover_id"})
    por_id = {i.id: i for i in actuales}
    # Primero se quita la portada (el índice no admite dos a la vez).
    if portada is not None:
        for imagen in actuales:
            imagen.is_cover = False
        await db.flush()
    for posicion, ident in enumerate(en_orden):
        por_id[ident].position = posicion
        if portada is not None:
            por_id[ident].is_cover = ident == portada
    version.updated_at = _ahora()
    await db.flush()
    return [por_id[i] for i in en_orden]


async def _sigue_nombrado(db: AsyncSession, ruta: str, *, salvo: str | None) -> bool:
    consulta = select(func.count()).select_from(ServiceVersionImage).where(
        ServiceVersionImage.storage_path == ruta
    )
    if salvo is not None:
        consulta = consulta.where(ServiceVersionImage.id != salvo)
    return bool(await db.scalar(consulta))


async def borrar_archivo(ruta: str) -> None:
    """Sin romper nada: lo que no se pueda borrar lo barre el borrado de la
    cuenta (la carpeta del servicio, o la del perfil en una ruta anterior).
    Nunca se registra la ruta."""
    try:
        await storage.borrar_objeto(DEPOSITO, ruta)
    except Exception:  # noqa: BLE001
        logger.warning("[servicios] no se pudo borrar una imagen del depósito")


async def quitar(db: AsyncSession, *, usuario_id: str, servicio_id: str, imagen_id: str) -> str | None:
    """Quita la fila de una imagen del borrador y devuelve la ruta del archivo
    que hay que borrar, o `None` si otra versión (la publicada) lo sigue
    nombrando. EL ARCHIVO SE BORRA DESPUÉS DE CONFIRMAR (`borrar_archivo`):
    si la base fallara, la fila volvería y apuntaría a un archivo que ya no
    está."""
    servicio, _ = await catalogo.mio(db, usuario_id, servicio_id)
    version = await _borrador(db, servicio)
    fila = await db.get(ServiceVersionImage, imagen_id)
    if fila is None or fila.version_id != version.id:
        raise ImagenNoEncontrada()
    ruta, era_portada = fila.storage_path, fila.is_cover
    compartida = await _sigue_nombrado(db, ruta, salvo=fila.id)
    await db.delete(fila)
    await db.flush()
    if era_portada:
        # La siguiente pasa a ser portada: nunca queda un borrador con
        # imágenes y sin portada por haber quitado la primera.
        siguiente = next(iter(await catalogo.imagenes_de(db, version.id)), None)
        if siguiente is not None:
            siguiente.is_cover = True
            await db.flush()
    version.updated_at = _ahora()
    return None if compartida else ruta


async def firmar(rutas: list[str]) -> dict[str, str]:
    """`ruta -> URL firmada`. NUNCA LANZA: sin almacenamiento, la ficha sale
    con el texto alternativo de cada imagen."""
    if not rutas:
        return {}
    try:
        return await storage.firmar_objetos(DEPOSITO, rutas, segundos=SEGUNDOS_DE_LA_FIRMA)
    except Exception:  # noqa: BLE001
        logger.warning("[servicios] no se pudieron firmar %s imágenes", len(rutas))
        return {}


__all__ = [
    "AlmacenamientoNoDisponible",
    "DEPOSITO",
    "DemasiadasImagenes",
    "ImagenInvalida",
    "ImagenNoEncontrada",
    "RUTA_OPACA",
    "borrar_archivo",
    "firmar",
    "ordenar",
    "quitar",
    "ruta_nueva",
    "subir",
]
