"""Publicar, editar y borrar con videos en S3 (spec §5 y §9).

- `adoptar`: al publicar, comprueba que la subida pendiente es de la cuenta de
  la sesión y que el tamaño y el tipo coinciden, y la copia dentro de S3 a
  `videos/<uid>/<media_id>/original.<ext>` (y el póster a `poster-v1.jpg`).
- `retirar`: al borrar una publicación o reemplazar un video, MUEVE la
  carpeta a `borrados/` (fuera del comodín de las firmas: N1) e invalida
  CloudFront.
- `restaurar`: lo contrario, dentro de los 30 días.
- `borrar_cuenta`: la baja borra en el acto `videos/<uid>/`, `borrados/<uid>/`
  y `pendientes/<uid>/` e invalida `/videos/<uid>/*`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ForbiddenError, NotFoundError, ValidationAppError
from app.modules.medios import almacen, banderas, esquema
from app.modules.medios.models import MedioSubida
from app.shared.identifiers import ensure_uuid

logger = logging.getLogger("renaser.medios")

#: Extensión del original según el tipo firmado en la subida.
EXTENSIONES = {"video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg"}

#: Marca que se deja en `borrados/<uid>/<media_id>/` con el id de la
#: publicación: la limpieza la lee para no borrar contenido con una denuncia
#: abierta (se conserva como evidencia).
MARCA_DE_PUBLICACION = "_publicacion.txt"


class MediosS3NoHabilitado(AppError):
    status_code = 403
    code = "medios_s3_no_habilitado"
    message = "La subida de videos a este almacén no está habilitada para tu cuenta."


class SubidaNoDisponible(AppError):
    status_code = 409
    code = "subida_no_disponible"
    message = "Esa subida ya no está disponible. Vuelve a subir el video."


@dataclass
class Adoptado:
    media_id: str
    storage_path: str
    poster_path: str | None
    bytes: int
    #: Las claves de `pendientes/` ya copiadas. Se borran DESPUES del commit
    #: (`borrar_pendientes`), nunca antes: si publicar falla, el reintento las
    #: necesita.
    pendientes: list[str]


def carpeta_de_medio(uid: str, media_id: str) -> str:
    return f"{almacen.PREFIJO_VIDEOS}/{uid}/{media_id}"


async def exigir_habilitado(db: AsyncSession, uid: str) -> None:
    if not banderas.puede_subir(uid) or not await esquema.hay_almacen(db):
        raise MediosS3NoHabilitado()


async def subida_propia(
    db: AsyncSession, uid: str, id_de_subida: str, *, bloquear: bool = False
) -> MedioSubida:
    """La subida, si es de `uid`. La de otra persona es un 403 (spec,
    «Publicar con la subida de otra persona»).

    `bloquear` toma la fila con `FOR UPDATE` hasta el final de la transacción:
    dos publicaciones con la misma subida a la vez no pueden usarla las dos (la
    segunda espera y la encuentra usada)."""
    ensure_uuid(id_de_subida, "Subida no encontrada.")
    consulta = select(MedioSubida).where(MedioSubida.id == id_de_subida)
    if bloquear:
        consulta = consulta.with_for_update()
    subida = (await db.scalars(consulta)).first()
    if subida is None:
        raise NotFoundError("Subida no encontrada.")
    if subida.uid != uid or not subida.clave_pendiente.startswith(
        f"{almacen.PREFIJO_PENDIENTES}/{uid}/"
    ):
        raise ForbiddenError("Esa subida no es tuya.")
    return subida


def _copiar_pendiente(subida_clave: str, bytes_: int, content_type: str, destino: str) -> None:
    """HeadObject (que exista, tamaño y tipo) + CopyObject. La pendiente NO se
    borra aquí: ver `Adoptado.pendientes`. Síncrono: va en un hilo."""
    s3 = almacen.cliente_s3()
    try:
        cabeza = s3.head_object(Bucket=almacen.bucket(), Key=subida_clave)
    except Exception as error:  # noqa: BLE001
        if almacen.es_no_existe(error):
            raise SubidaNoDisponible("El archivo no llegó a subirse.") from None
        raise
    if int(cabeza.get("ContentLength") or 0) != int(bytes_):
        raise ValidationAppError("El archivo subido no tiene el tamaño anunciado.")
    tipo = (cabeza.get("ContentType") or "").split(";")[0].strip().lower()
    if tipo != content_type:
        raise ValidationAppError("El archivo subido no es del tipo anunciado.")
    # Copia DENTRO de S3: no baja el archivo. Hasta 5 GB en una operación, y
    # el tope de la API son 500 MB.
    s3.copy_object(
        Bucket=almacen.bucket(),
        Key=destino,
        CopySource={"Bucket": almacen.bucket(), "Key": subida_clave},
        MetadataDirective="REPLACE",
        ContentType=content_type,
        CacheControl=almacen.CACHE_INMUTABLE,
    )


def _borrar_pendientes_sync(claves: list[str]) -> None:
    for clave in claves:
        almacen.cliente_s3().delete_object(Bucket=almacen.bucket(), Key=clave)


async def borrar_pendientes(claves: list[str]) -> None:
    """Después del commit, en segundo plano. Si falla, el ciclo de vida de
    `pendientes/` (1 día) las borra igual: no hay que reintentar."""
    if not claves or not banderas.s3_configurado():
        return
    try:
        await asyncio.to_thread(_borrar_pendientes_sync, claves)
    except Exception:  # noqa: BLE001
        logger.info("No se pudieron borrar %d pendiente(s); las borra el ciclo de vida", len(claves))


async def adoptar(
    db: AsyncSession, uid: str, id_de_subida: str, id_de_subida_poster: str | None
) -> Adoptado:
    """Convierte las subidas pendientes en los archivos de un medio nuevo."""
    await exigir_habilitado(db, uid)
    video = await subida_propia(db, uid, id_de_subida, bloquear=True)
    if video.tipo != "video":
        raise ValidationAppError("Esa subida no es un video.")
    poster = None
    if id_de_subida_poster:
        poster = await subida_propia(db, uid, id_de_subida_poster, bloquear=True)
        if poster.tipo != "poster":
            raise ValidationAppError("Esa subida no es un póster.")
    for subida in (video, poster):
        if subida is None:
            continue
        if subida.estado not in ("abierta", "subida") or subida.expira <= _ahora(subida.expira):
            raise SubidaNoDisponible()
        if subida.upload_id and subida.estado != "subida":
            raise SubidaNoDisponible("La subida por partes no se completó.")

    media_id = str(uuid4())
    carpeta = carpeta_de_medio(uid, media_id)
    original = f"{carpeta}/original.{EXTENSIONES.get(video.content_type, 'mp4')}"
    await asyncio.to_thread(
        _copiar_pendiente, video.clave_pendiente, video.bytes_declarados, video.content_type, original
    )
    clave_poster = None
    if poster is not None:
        clave_poster = f"{carpeta}/poster-v1.jpg"
        await asyncio.to_thread(
            _copiar_pendiente,
            poster.clave_pendiente,
            poster.bytes_declarados,
            poster.content_type,
            clave_poster,
        )
    for subida in (video, poster):
        if subida is not None:
            subida.estado = "usada"
            subida.media_id = media_id
    return Adoptado(
        media_id=media_id,
        storage_path=original,
        poster_path=clave_poster,
        bytes=int(video.bytes_declarados),
        pendientes=[s.clave_pendiente for s in (video, poster) if s is not None],
    )


def _ahora(referencia: datetime) -> datetime:
    """`now` comparable con `referencia` (SQLite devuelve fechas sin zona)."""
    ahora = datetime.now(timezone.utc)
    return ahora if referencia.tzinfo else ahora.replace(tzinfo=None)


async def marcar_s3(db: AsyncSession, media_id: str) -> None:
    tabla = esquema.POST_MEDIA_ALMACEN
    await db.execute(update(tabla).where(tabla.c.id == media_id).values(almacen="s3"))


async def ids_en_s3(db: AsyncSession, media_ids: list[str]) -> set[str]:
    if not media_ids or not await esquema.hay_almacen(db):
        return set()
    tabla = esquema.POST_MEDIA_ALMACEN
    return set(
        (
            await db.scalars(
                select(tabla.c.id).where(tabla.c.id.in_(media_ids), tabla.c.almacen == "s3")
            )
        ).all()
    )


# --------------------------------------------------------------------------- #
# Borrado diferido
# --------------------------------------------------------------------------- #
def _retirar_sync(uid: str, media_id: str, post_id: str) -> None:
    s3 = almacen.cliente_s3()
    origen = carpeta_de_medio(uid, media_id)
    destino = f"{almacen.PREFIJO_BORRADOS}/{uid}/{media_id}"
    # La marca primero: si lo demás falla a medias, la limpieza ya sabe de qué
    # publicación es lo que haya llegado a `borrados/`.
    s3.put_object(
        Bucket=almacen.bucket(),
        Key=f"{destino}/{MARCA_DE_PUBLICACION}",
        Body=post_id.encode(),
        ContentType="text/plain",
    )
    almacen.mover_prefijo_sync(origen, destino)
    almacen.invalidar_sync([f"/{origen}/*"])


async def retirar(uid: str, media_id: str, post_id: str) -> bool:
    """Mueve el medio a `borrados/` e invalida. Pensado para BackgroundTasks:
    no lanza; un fallo lo recoge la limpieza diaria (`limpieza.reconciliar`)."""
    if not banderas.s3_configurado():
        return False
    try:
        await asyncio.to_thread(_retirar_sync, uid, media_id, post_id)
        return True
    except Exception:  # noqa: BLE001
        logger.exception("No se pudo retirar el medio %s a borrados/", media_id)
        return False


def _restaurar_sync(uid: str, media_id: str) -> int:
    origen = f"{almacen.PREFIJO_BORRADOS}/{uid}/{media_id}"
    destino = carpeta_de_medio(uid, media_id)
    s3 = almacen.cliente_s3()
    try:
        s3.delete_object(Bucket=almacen.bucket(), Key=f"{origen}/{MARCA_DE_PUBLICACION}")
    except Exception:  # noqa: BLE001 — sin marca no pasa nada
        pass
    return almacen.mover_prefijo_sync(origen, destino)


async def restaurar(uid: str, media_id: str) -> int:
    """Devuelve el medio de `borrados/` a `videos/` (dentro de los 30 días).

    HOY NINGÚN ENDPOINT RESTAURA una publicación borrada (el borrado es
    lógico y no hay «deshacer»): queda listo para cuando exista.
    """
    return await asyncio.to_thread(_restaurar_sync, uid, media_id)


# --------------------------------------------------------------------------- #
# Baja de cuenta
# --------------------------------------------------------------------------- #
def _borrar_cuenta_sync(uid: str) -> int:
    total = 0
    for prefijo in (almacen.PREFIJO_VIDEOS, almacen.PREFIJO_BORRADOS, almacen.PREFIJO_PENDIENTES):
        total += almacen.borrar_prefijo_sync(f"{prefijo}/{uid}/")
    almacen.invalidar_sync([f"/{almacen.PREFIJO_VIDEOS}/{uid}/*"])
    return total


async def tiene_algo_en_s3(db: AsyncSession, uid: str) -> bool:
    """Si en la base hay rastro de `uid` en S3: algún medio `s3` en sus
    publicaciones o alguna subida registrada. Sin la 0116 o sin bucket, no.

    Mira la BASE y no el bucket a propósito: es lo que deja hacer la baja sin
    credenciales de S3 cuando la cuenta nunca subió nada allí (corrección M2
    del QA). Lo que no deja rastro en la base (una pendiente sin fila) lo
    borra el ciclo de vida del bucket a las 24 h.
    """
    if not banderas.s3_configurado() or not await esquema.hay_almacen(db):
        return False
    from app.modules.content.models import Post, PostMedia

    tabla = esquema.POST_MEDIA_ALMACEN
    medio = await db.scalar(
        select(PostMedia.id)
        .join(Post, Post.id == PostMedia.post_id)
        .where(
            Post.author_id == uid,
            PostMedia.id.in_(select(tabla.c.id).where(tabla.c.almacen == "s3")),
        )
        .limit(1)
    )
    if medio is not None:
        return True
    subida = await db.scalar(select(MedioSubida.id).where(MedioSubida.uid == uid).limit(1))
    return subida is not None


async def borrar_cuenta(uid: str) -> int:
    """Borrado INMEDIATO de todo lo de `uid` en S3. Lanza si falla: la baja
    aborta antes de confirmar, igual que con Supabase (`baja.py`). Sin bucket
    configurado no hay nada que borrar."""
    if not banderas.s3_configurado():
        return 0
    return await asyncio.to_thread(_borrar_cuenta_sync, uid)
