"""Genera las calidades 480/560 de los videos de S3 publicados ANTES de encenderlas.

POR QUE HACE FALTA. `video_calidades_enabled` solo actúa en el procesado de lo
que se sube de ahora en adelante. Lo que ya está en S3 se quedaría con su única
calidad para siempre; esto lo pasa, uno por uno, por el MISMO camino que un
video nuevo (`process_media`), así que no hay una segunda forma de codificar
que mantener.

POR QUE VIVE EN `app/` Y NO EN `scripts/`. La imagen de la API solo copia
`app/`: así se corre DENTRO del contenedor que ya está en producción, con sus
credenciales de S3 (rol de la máquina), su `DATABASE_URL` y su ffmpeg, sin
copiar secretos a ningún otro sitio ni cargar la máquina de nadie:

    docker exec -e VIDEO_CALIDADES_ENABLED=true renaser-api \\
        nice -n 19 python -m app.modules.medios.rellenar_calidades            # en seco
    docker exec -e VIDEO_CALIDADES_ENABLED=true renaser-api \\
        nice -n 19 python -m app.modules.medios.rellenar_calidades --aplicar

El `-e` enciende la generación SOLO para este proceso: se puede rellenar lo
viejo sin encender todavía la codificación de lo nuevo.

QUE HACE Y QUE NO HACE. Solo AÑADE: objetos nuevos en `calidades-v1/` y la
columna `variantes` (0117). No toca el original, ni el `feed-720`, ni el
póster. Repetible: lo que ya tiene `variantes` se salta (`puede_generar`).
Un video a la vez (el mismo semáforo del procesado), con un hilo de ffmpeg.

EN SECO POR DEFECTO. Sin `--aplicar` solo cuenta y estima el gasto.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass

from sqlalchemy import select, update

from app.core.config import get_settings
from app.modules.content.models import Post, PostMedia
from app.modules.medios import calidades, publicacion

logger = logging.getLogger("renaser.medios.rellenar_calidades")

#: Segundos de CPU por minuto de video en la t3.small (medido en
#: `config.video_calidades_enabled`: ~85 s). Solo para la estimación.
CPU_S_POR_MINUTO = 85.0
#: Créditos de CPU de una t3: 1 crédito = 1 vCPU al 100 % durante 1 minuto.
CPU_S_POR_CREDITO = 60.0


@dataclass(frozen=True)
class Pendiente:
    media_id: str
    duracion_s: float
    estado: str


async def pendientes(db, limite: int) -> list[Pendiente]:
    """Videos de S3 vivos, sin `variantes`, que merecen calidades.

    Los más recientes primero: son los que más se ven si esto se corta.
    """
    if not await calidades.hay_columna(db):
        return []
    filas = (
        await db.execute(
            select(
                PostMedia.id,
                PostMedia.duration_s,
                PostMedia.width,
                PostMedia.height,
                PostMedia.feed_path,
                PostMedia.processing_status,
            )
            .join(Post, Post.id == PostMedia.post_id)
            .where(
                PostMedia.media_type == "video",
                PostMedia.processing_status.in_(("ready", "failed")),
                Post.status != "deleted",
            )
            .order_by(PostMedia.created_at.desc())
        )
    ).all()
    if not filas:
        return []
    en_s3 = await publicacion.ids_en_s3(db, [f.id for f in filas])
    tabla = calidades.POST_MEDIA_VARIANTES
    con_variantes = set(
        (
            await db.scalars(
                select(tabla.c.id).where(
                    tabla.c.id.in_(list(en_s3)), tabla.c.variantes.is_not(None)
                )
            )
        ).all()
    ) if en_s3 else set()
    salida: list[Pendiente] = []
    for f in filas:
        if f.id not in en_s3 or f.id in con_variantes:
            continue
        if not calidades.merece_calidades(f.duration_s, f.width, f.height, calidades.es_feed_720(f.feed_path)):
            continue
        salida.append(Pendiente(f.id, float(f.duration_s or 0), f.processing_status))
        if len(salida) >= limite:
            break
    return salida


async def _devolver_estado(sesiones, media_id: str, anterior: str) -> None:
    """Si el procesado dejó `failed` un video que estaba `ready`, se devuelve.

    `process_media` marca `failed` ante cualquier fallo (p. ej. un corte de
    red al bajar el original). Para un video nuevo es lo correcto; para uno
    que YA se servía bien, solo falló la mejora: el video sigue igual.
    """
    if anterior != "ready":
        return
    async with sesiones() as db:
        await db.execute(
            update(PostMedia)
            .where(PostMedia.id == media_id, PostMedia.processing_status == "failed")
            .values(processing_status="ready")
        )
        await db.commit()


async def principal(argv: list[str] | None = None, *, sesiones=None, procesar=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aplicar", action="store_true", help="Codifica de verdad.")
    parser.add_argument("--limite", type=int, default=500)
    args = parser.parse_args(argv)

    if sesiones is None:
        from app.shared.database import SessionLocal

        sesiones = SessionLocal
    if procesar is None:
        from app.modules.content.media_processing import process_media

        procesar = process_media

    if not calidades.generacion_activa():
        print(
            "La generacion de calidades esta apagada en este proceso.\n"
            "Encenderla SOLO para el relleno: docker exec -e VIDEO_CALIDADES_ENABLED=true ..."
        )
        return 1

    async with sesiones() as db:
        if not await calidades.hay_columna(db):
            print("Falta la migracion 0117 (post_media.variantes). Nada que hacer.")
            return 1
        lista = await pendientes(db, args.limite)

    minutos = sum(p.duracion_s for p in lista) / 60
    cpu_s = minutos * CPU_S_POR_MINUTO
    tope = get_settings().video_calidades_duracion_maxima_s
    print(f"Videos de S3 sin calidades (<= {tope:.0f} s): {len(lista)}")
    print(f"Minutos de video: {minutos:.1f}")
    print(
        f"Estimado en la t3.small: ~{cpu_s / 60:.0f} min de CPU, "
        f"~{cpu_s / CPU_S_POR_CREDITO:.0f} creditos (gana 24 por hora)"
    )
    if not lista:
        return 0
    if not args.aplicar:
        print("\nEn seco: no se ha escrito nada. Para hacerlo de verdad: --aplicar")
        return 0

    hechas = fallos = 0
    for p in lista:
        try:
            await procesar(p.media_id)
        except Exception:  # noqa: BLE001 — un video roto no para los demás
            logger.warning("Fallo con %s", p.media_id, exc_info=True)
        await _devolver_estado(sesiones, p.media_id, p.estado)
        async with sesiones() as db:
            tabla = calidades.POST_MEDIA_VARIANTES
            hecho = await db.scalar(select(tabla.c.variantes).where(tabla.c.id == p.media_id))
        if hecho:
            hechas += 1
            print(f"  {p.media_id}: {','.join(str(v.get('alto')) for v in hecho)}")
        else:
            fallos += 1
            print(f"  {p.media_id}: sin calidades (ver el log)")

    print(f"\nCon calidades: {hechas}. Sin ellas: {fallos}.")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(asyncio.run(principal()))
