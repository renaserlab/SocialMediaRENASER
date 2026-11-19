"""El trabajo diario de los medios en S3 (spec §9, corrección N3).

Lo lanza EventBridge una vez al día contra `POST /tareas/medios/limpieza`
(la API no tiene planificador y un temporizador dentro del proceso correría
una vez por máquina). ES IDEMPOTENTE: correrlo dos veces seguidas no hace nada
la segunda. Cada paso va por su cuenta: si uno falla, los demás corren igual y
el fallo sale en la respuesta y en el log.

1. Cierra las `medios_subidas` vencidas (y aborta su multipart, si lo hay).
2. Borra `borrados/` con más de 30 días, SALVO que la publicación tenga una
   denuncia abierta: entonces se conserva como evidencia hasta que se
   resuelva (falta confirmar con legal si hay un plazo obligatorio).
3. Borra las versiones viejas de los derivados (`poster-v<n>`,
   `feed-720-v<n>`, `hls-v<n>/`) con más de 7 días que ya no nombra la fila.
4. Reconciliar: si una publicación borrada todavía tiene su carpeta en
   `videos/` (el movimiento en segundo plano falló), la mueve ahora.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.content.models import Post, PostMedia
from app.modules.medios import almacen, banderas, esquema, publicacion
from app.modules.medios.models import MedioSubida
from app.modules.moderation.models import Report

logger = logging.getLogger("renaser.medios")

DIAS_EN_BORRADOS = 30
DIAS_DE_VERSIONES_VIEJAS = 7


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _edad(objeto: dict, ahora: datetime) -> timedelta:
    modificado = objeto.get("LastModified")
    if not isinstance(modificado, datetime):
        return timedelta(0)
    if modificado.tzinfo is None:
        modificado = modificado.replace(tzinfo=timezone.utc)
    return ahora - modificado


def _por_carpeta(objetos: list[dict], profundidad: int = 3) -> dict[str, list[dict]]:
    """Agrupa por `<prefijo>/<uid>/<media_id>`."""
    grupos: dict[str, list[dict]] = {}
    for objeto in objetos:
        partes = objeto["Key"].split("/")
        if len(partes) <= profundidad:
            continue
        grupos.setdefault("/".join(partes[:profundidad]), []).append(objeto)
    return grupos


async def cerrar_subidas_vencidas(db: AsyncSession) -> int:
    ahora = _ahora()
    vencidas = (
        await db.scalars(
            select(MedioSubida).where(
                MedioSubida.estado.in_(("abierta", "subida")), MedioSubida.expira < ahora
            )
        )
    ).all()
    for subida in vencidas:
        if subida.upload_id and banderas.s3_configurado():
            try:
                await asyncio.to_thread(
                    almacen.cliente_s3().abort_multipart_upload,
                    Bucket=almacen.bucket(),
                    Key=subida.clave_pendiente,
                    UploadId=subida.upload_id,
                )
            except Exception:  # noqa: BLE001 — el ciclo de vida la aborta igual a 1 día
                logger.info("No se pudo abortar el multipart de la subida %s", subida.id)
        subida.estado = "vencida"
    await db.commit()
    return len(vencidas)


async def _denuncia_abierta(db: AsyncSession, post_id: str) -> bool:
    fila = await db.scalar(
        select(Report.id)
        .where(Report.entity_type == "post", Report.entity_id == post_id, Report.status == "open")
        .limit(1)
    )
    return fila is not None


def _leer_marca(carpeta: str) -> str | None:
    try:
        cuerpo = almacen.cliente_s3().get_object(
            Bucket=almacen.bucket(), Key=f"{carpeta}/{publicacion.MARCA_DE_PUBLICACION}"
        )["Body"].read()
        return cuerpo.decode("utf-8").strip() or None
    except Exception:  # noqa: BLE001 — sin marca: no se sabe de qué publicación es
        return None


async def purgar_borrados(db: AsyncSession) -> int:
    ahora = _ahora()
    objetos = await asyncio.to_thread(almacen.listar, f"{almacen.PREFIJO_BORRADOS}/")
    borradas = 0
    for carpeta, contenido in _por_carpeta(objetos).items():
        # La edad de la carpeta es la de su objeto MÁS RECIENTE: si algo se
        # escribió hace poco (una restauración a medias, un reintento), espera.
        if min(_edad(o, ahora) for o in contenido) < timedelta(days=DIAS_EN_BORRADOS):
            continue
        post_id = await asyncio.to_thread(_leer_marca, carpeta)
        if post_id and await _denuncia_abierta(db, post_id):
            continue
        await asyncio.to_thread(almacen.borrar_claves, [o["Key"] for o in contenido])
        borradas += 1
    return borradas


def _es_derivado_viejo(nombre_relativo: str, fila: dict) -> bool:
    """`nombre_relativo` es lo que va después de `videos/<uid>/<media_id>/`."""
    clave = f"{fila['carpeta']}/{nombre_relativo}"
    if nombre_relativo.startswith("poster-v"):
        return clave != fila["poster_path"]
    if nombre_relativo.startswith("feed-720-v"):
        return clave != fila["feed_path"]
    if nombre_relativo.startswith("hls-v"):
        carpeta_hls = f"{fila['carpeta']}/{nombre_relativo.split('/', 1)[0]}"
        return carpeta_hls != fila["stream_path"]
    return False


async def purgar_versiones_viejas(db: AsyncSession) -> tuple[int, int]:
    """(derivados viejos borrados, carpetas huérfanas movidas a borrados/)."""
    tabla = esquema.POST_MEDIA_ALMACEN
    filas = (
        await db.execute(
            select(
                PostMedia.id,
                PostMedia.post_id,
                PostMedia.storage_path,
                PostMedia.poster_path,
                PostMedia.feed_path,
                PostMedia.stream_path,
            ).where(PostMedia.id.in_(select(tabla.c.id).where(tabla.c.almacen == "s3")))
        )
    ).all()
    por_carpeta: dict[str, dict] = {}
    for fila in filas:
        partes = (fila.storage_path or "").split("/")
        if len(partes) < 4:
            continue
        carpeta = "/".join(partes[:3])
        por_carpeta[carpeta] = {
            "carpeta": carpeta,
            "poster_path": fila.poster_path,
            "feed_path": fila.feed_path,
            "stream_path": fila.stream_path,
        }

    ahora = _ahora()
    objetos = await asyncio.to_thread(almacen.listar, f"{almacen.PREFIJO_VIDEOS}/")
    viejos: list[str] = []
    huerfanas = 0
    for carpeta, contenido in _por_carpeta(objetos).items():
        uid, media_id = carpeta.split("/")[1:3]
        if uid.startswith("_"):
            continue  # `videos/_salud/`: la prueba de humo
        fila = por_carpeta.get(carpeta)
        if fila is None:
            # Archivos sin fila: una publicación cuyo guardado falló después
            # de copiar. No se borran: se mueven a `borrados/` y allí esperan
            # sus 30 días como cualquier otro.
            if min(_edad(o, ahora) for o in contenido) >= timedelta(days=DIAS_DE_VERSIONES_VIEJAS):
                if await publicacion.retirar(uid, media_id, ""):
                    huerfanas += 1
            continue
        for objeto in contenido:
            relativo = objeto["Key"][len(carpeta) + 1 :]
            if _es_derivado_viejo(relativo, fila) and _edad(objeto, ahora) >= timedelta(
                days=DIAS_DE_VERSIONES_VIEJAS
            ):
                viejos.append(objeto["Key"])
    if viejos:
        await asyncio.to_thread(almacen.borrar_claves, viejos)
    return len(viejos), huerfanas


async def reconciliar(db: AsyncSession) -> int:
    tabla = esquema.POST_MEDIA_ALMACEN
    filas = (
        await db.execute(
            select(PostMedia.id, PostMedia.post_id, PostMedia.storage_path)
            .join(Post, Post.id == PostMedia.post_id)
            .where(
                Post.status == "deleted",
                PostMedia.id.in_(select(tabla.c.id).where(tabla.c.almacen == "s3")),
            )
        )
    ).all()
    movidas = 0
    for fila in filas:
        partes = (fila.storage_path or "").split("/")
        if len(partes) < 4:
            continue
        carpeta = "/".join(partes[:3])
        quedan = await asyncio.to_thread(almacen.listar, f"{carpeta}/")
        if quedan and await publicacion.retirar(partes[1], fila.id, fila.post_id):
            movidas += 1
    return movidas


async def ejecutar(db: AsyncSession) -> dict[str, object]:
    resultado: dict[str, object] = {"errores": []}
    if not await esquema.hay_almacen(db):
        resultado["errores"].append("sin_migracion_0116")  # type: ignore[union-attr]
        return resultado

    pasos = {
        "subidas_vencidas": cerrar_subidas_vencidas,
        "borrados_purgados": purgar_borrados,
        "versiones_viejas": purgar_versiones_viejas,
        "reconciliados": reconciliar,
    }
    if not banderas.s3_configurado():
        # Sin bucket solo se puede cerrar el registro; lo demás es de S3.
        pasos = {"subidas_vencidas": cerrar_subidas_vencidas}
    for nombre, paso in pasos.items():
        try:
            valor = await paso(db)
        except Exception:  # noqa: BLE001
            logger.exception("Limpieza de medios: fallo el paso %s", nombre)
            await db.rollback()
            resultado["errores"].append(nombre)  # type: ignore[union-attr]
            continue
        if isinstance(valor, tuple):
            resultado[nombre], resultado["huerfanas_movidas"] = valor
        else:
            resultado[nombre] = valor
    return resultado

