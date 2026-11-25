"""Remux intercalado (+faststart) de los videos YA publicados, en los dos almacenes.

POR QUE HACE FALTA. El procesado de lo nuevo (`media_processing`) ya deja un
`feed-remux` intercalado cuando el original viene sin intercalar (el
compresor de Android escribe todo el video y despues todo el audio). Lo que
se publico antes se queda como estaba: ExoPlayer tiene que bajarse casi el
archivo entero para arrancarlo. Esto lo pasa por el MISMO remux
(`media_processing._remuxar_y_subir`), sin una segunda forma de hacerlo.

QUE MIRA. Para cada video vivo, el MP4 que de verdad reproduce el movil:
`feed_path` si existe (el `feed-720` recodificado, que ya sale intercalado)
y si no, el original. Con `--variantes` mira tambien las calidades de S3.
Solo LEE: ffprobe sobre una URL firmada de corta vida pide unos pocos rangos
(el indice y las cabeceras), no el archivo.

QUE HACE CON `--aplicar`. Solo con los que no tienen `feed_path` y estan sin
intercalar (o con el indice al final): baja el original a disco, lo remuxa
con `-c copy` (no recodifica), comprueba el resultado, lo sube como derivado
NUEVO y anota `feed_path`.

  * El original NO se toca. Rollback = `update post_media set feed_path = null
    where feed_path like '%feed-remux%'` (el objeto puede quedarse o borrarse).
  * Repetible: lo que ya tiene `feed_path` se salta, y la anotacion final solo
    se hace si sigue vacia (no pisa un `feed-720` que llegara mientras tanto).
  * No toca `processing_status`: el video ya se servia bien; esto es mejora.
  * Un video a la vez (el semaforo del procesado) y ffmpeg con `nice`.

COMO SE CORRE (dentro del contenedor de produccion, con sus credenciales):

    docker exec renaser-api nice -n 19 python -m app.modules.content.rellenar_remux
    docker exec renaser-api nice -n 19 python -m app.modules.content.rellenar_remux --aplicar

EN SECO POR DEFECTO: sin `--aplicar` solo lista.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx
from sqlalchemy import select

from app.modules.content import media_processing as mp
from app.modules.content import remux
from app.modules.content.models import Post, PostMedia

logger = logging.getLogger("renaser.rellenar_remux")


@dataclass
class Fila:
    media_id: str
    post_id: str
    autor: str | None
    almacen: str
    storage_path: str
    feed_path: str | None
    stream_path: str | None
    bytes: int | None
    variantes: list[dict] | None = None

    @property
    def reproduce(self) -> str:
        """La ruta del MP4 que reproduce el movil (`media_url`)."""
        return self.feed_path or self.storage_path

    @property
    def que_es(self) -> str:
        if not self.feed_path:
            return "original"
        return "feed-remux" if remux.es_remux(self.feed_path) else "feed-720"


@dataclass
class Revision:
    fila: Fila
    archivo: str  # original | feed-720 | feed-remux | variante-480 ...
    ruta: str
    diagnostico: remux.Diagnostico | None
    lo_reproduce: bool

    @property
    def remuxable(self) -> bool:
        return (
            self.archivo == "original"
            and self.lo_reproduce
            and self.diagnostico is not None
            and self.diagnostico.necesita_remux
        )


async def leer_filas(db, limite: int) -> list[Fila]:
    """Videos de publicaciones vivas, los mas recientes primero."""
    from app.modules.medios import calidades, esquema

    filas = (
        await db.execute(
            select(
                PostMedia.id,
                PostMedia.post_id,
                Post.author_id,
                PostMedia.storage_path,
                PostMedia.feed_path,
                PostMedia.stream_path,
                PostMedia.bytes,
            )
            .join(Post, Post.id == PostMedia.post_id)
            .where(PostMedia.media_type == "video", Post.status != "deleted")
            .order_by(PostMedia.created_at.desc())
            .limit(limite)
        )
    ).all()
    ids = [f.id for f in filas]
    en_s3: set[str] = set()
    if ids and await esquema.hay_almacen(db):
        tabla = esquema.POST_MEDIA_ALMACEN
        en_s3 = set(
            (
                await db.scalars(
                    select(tabla.c.id).where(tabla.c.id.in_(ids), tabla.c.almacen == "s3")
                )
            ).all()
        )
    variantes: dict[str, list[dict]] = {}
    if en_s3 and await calidades.hay_columna(db):
        tabla = calidades.POST_MEDIA_VARIANTES
        for fila in (
            await db.execute(
                select(tabla.c.id, tabla.c.variantes).where(
                    tabla.c.id.in_(list(en_s3)), tabla.c.variantes.is_not(None)
                )
            )
        ).all():
            if isinstance(fila.variantes, list):
                variantes[fila.id] = fila.variantes
    return [
        Fila(
            media_id=f.id,
            post_id=f.post_id,
            autor=f.author_id,
            almacen="s3" if f.id in en_s3 else "supabase",
            storage_path=f.storage_path,
            feed_path=f.feed_path,
            stream_path=f.stream_path,
            bytes=f.bytes,
            variantes=variantes.get(f.id),
        )
        for f in filas
    ]


async def _url(client: httpx.AsyncClient, almacen: str, ruta: str) -> str:
    from app.modules.medios.almacen import almacen_para

    return await almacen_para(almacen, client).url_de_lectura_temporal(ruta, 900)


async def revisar(
    client: httpx.AsyncClient, filas: list[Fila], con_variantes: bool
) -> list[Revision]:
    salida: list[Revision] = []
    for fila in filas:
        archivos = [(fila.que_es, fila.reproduce, True)]
        if con_variantes and fila.variantes:
            for v in fila.variantes:
                if isinstance(v, dict) and isinstance(v.get("clave"), str):
                    archivos.append((f"variante-{v.get('alto')}", v["clave"], True))
        for archivo, ruta, lo_reproduce in archivos:
            try:
                url = await _url(client, fila.almacen, ruta)
                diagnostico = await mp.diagnosticar_url(client, url)
            except Exception:  # noqa: BLE001 — uno ilegible no para la lista
                logger.warning("No se pudo firmar/leer %s", fila.media_id, exc_info=True)
                diagnostico = None
            salida.append(Revision(fila, archivo, ruta, diagnostico, lo_reproduce))
    return salida


def _mb(n: int | None) -> str:
    return f"{n / 1048576:7.1f}" if n else "      ?"


def imprimir(revisiones: list[Revision]) -> None:
    print(
        f"{'medio':36}  {'almacen':8}  {'archivo':12}  {'MB':>7}  {'audio@MB':>8}  "
        f"{'desfase_s':>9}  {'moov':6}  estado"
    )
    for r in revisiones:
        d = r.diagnostico
        if d is None:
            print(f"{r.fila.media_id:36}  {r.fila.almacen:8}  {r.archivo:12}  {'':>7}  "
                  f"{'':>8}  {'':>9}  {'':6}  ILEGIBLE")
            continue
        audio = f"{d.pos_audio / 1048576:8.1f}" if d.pos_audio is not None else "  (mudo)"
        desfase = f"{d.desfase_s:9.1f}" if d.desfase_s is not None else " " * 9
        moov = {True: "delante", False: "final", None: "?"}[d.moov_delante]
        estado = "REMUXAR" if r.remuxable else ("mal (no es original)" if d.necesita_remux else "bien")
        print(f"{r.fila.media_id:36}  {r.fila.almacen:8}  {r.archivo:12}  {_mb(d.tamano)}  "
              f"{audio}  {desfase}  {moov:7} {estado} ({d.motivo})")


def resumen(revisiones: list[Revision]) -> dict:
    total: dict = {}
    for r in revisiones:
        d = r.diagnostico
        clave = (r.fila.almacen, r.archivo)
        t = total.setdefault(clave, {"videos": 0, "mal": 0, "mb_mal": 0.0, "remuxar": 0, "ilegibles": 0})
        t["videos"] += 1
        if d is None:
            t["ilegibles"] += 1
            continue
        if d.necesita_remux:
            t["mal"] += 1
            t["mb_mal"] += (d.tamano or 0) / 1048576
        if r.remuxable:
            t["remuxar"] += 1
    return total


async def remuxar_medio(media_id: str, *, sesiones=None) -> str:
    """Remux de UN video ya publicado. Devuelve que paso (para el informe)."""
    if sesiones is None:
        from app.shared.database import SessionLocal

        sesiones = SessionLocal
    from app.modules.medios import publicacion
    from app.modules.medios.almacen import CACHE_INMUTABLE, almacen_para

    async with sesiones() as db:
        media = (await db.scalars(select(PostMedia).where(PostMedia.id == media_id))).first()
        if media is None or media.media_type != "video":
            return "sin fila"
        if media.feed_path:
            return "ya tiene feed"
        almacen = "s3" if await publicacion.ids_en_s3(db, [media.id]) else "supabase"
        owner = (
            await db.scalar(select(Post.author_id).where(Post.id == media.post_id))
            if almacen == "s3"
            else media.storage_path.split("/", 1)[0]
        )
        db.expunge(media)

    ffmpeg = mp._ffmpeg()
    if not ffmpeg or not mp._ffprobe():
        return "sin ffmpeg"

    async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
        alm = almacen_para(almacen, client)

        async def _subir(ruta: str, datos: bytes, tipo: str) -> None:
            if almacen == "s3":
                await alm.subir(ruta, datos, tipo, cache_control=CACHE_INMUTABLE)
            else:
                await mp._upload(client, ruta, datos, tipo)

        async with mp._turno_de_video():
            with tempfile.TemporaryDirectory() as tmp:
                carpeta = Path(tmp)
                local = carpeta / "original"
                # Dentro del semaforo: la URL (Supabase) se firma justo antes.
                await alm.descargar_a_disco(media.storage_path, local)
                if not await mp._remuxar_y_subir(
                    ffmpeg, media, local, carpeta, almacen, owner, _subir
                ):
                    return "no hizo falta o fallo (ver log)"

    # Anotar SOLO si sigue vacio y la fila sigue ahi (con bloqueo, como el
    # procesado): no se pisa un `feed-720` que llegara mientras tanto.
    async with sesiones() as db:
        fila = (
            await db.scalars(
                select(PostMedia).where(PostMedia.id == media_id).with_for_update()
            )
        ).first()
        if fila is None:
            await mp._retirar_derivados(media, almacen, owner)
            return "la fila desaparecio"
        if fila.feed_path:
            return f"otro feed llego antes; queda sin usar {media.feed_path}"
        fila.feed_path = media.feed_path
        await db.commit()
    return f"remuxado -> {media.feed_path}"


async def principal(argv: list[str] | None = None, *, sesiones=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modo = parser.add_mutually_exclusive_group()
    modo.add_argument("--dry-run", action="store_true", help="Solo lista (por defecto).")
    modo.add_argument("--aplicar", action="store_true", help="Remuxa de verdad.")
    parser.add_argument("--variantes", action="store_true", help="Mira tambien las calidades de S3.")
    parser.add_argument("--limite", type=int, default=1000)
    args = parser.parse_args(argv)

    if not mp._ffprobe():
        print("Falta ffprobe en esta maquina.")
        return 1
    if sesiones is None:
        from app.shared.database import SessionLocal

        sesiones = SessionLocal

    async with sesiones() as db:
        filas = await leer_filas(db, args.limite)
    async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
        revisiones = await revisar(client, filas, args.variantes)

    imprimir(revisiones)
    print("\nResumen (almacen, archivo que se mira):")
    for (almacen, archivo), t in sorted(resumen(revisiones).items()):
        print(
            f"  {almacen:8} {archivo:12} videos={t['videos']:4}  mal={t['mal']:4} "
            f"({t['mb_mal']:.1f} MB)  a_remuxar={t['remuxar']:4}  ilegibles={t['ilegibles']}"
        )
    pendientes = [r.fila.media_id for r in revisiones if r.remuxable]
    if not args.aplicar:
        print(f"\nEn seco: no se ha escrito nada. {len(pendientes)} por remuxar. "
              "Para hacerlo de verdad: --aplicar")
        return 0

    fallos = 0
    for media_id in pendientes:
        try:
            resultado = await remuxar_medio(media_id, sesiones=sesiones)
        except Exception:  # noqa: BLE001 — uno roto no para los demas
            logger.warning("Fallo con %s", media_id, exc_info=True)
            resultado = "error (ver log)"
        if not resultado.startswith("remuxado"):
            fallos += 1
        print(f"  {media_id}: {resultado}")
    print(f"\nRemuxados: {len(pendientes) - fallos}. Sin remuxar: {fallos}.")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(asyncio.run(principal()))
