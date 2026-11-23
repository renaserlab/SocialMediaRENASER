"""Videos en tres calidades elegidas UNA vez por video (escalera 480/560/720).

DE DÓNDE SALE LA IDEA. Medido en TikTok (Dashlet, NSDI 2023, §2.2): cada video
existe en unas pocas calidades de MP4 progresivo y el reproductor escoge UNA
al empezar, según la red, y no la cambia a mitad del video. No es HLS: con
videos cortos la adaptación por segmentos no llega a notarse, y un MP4 entero
sí entra en la caché de disco de expo-video (`useCaching`), que en iOS NO
funciona con HLS.

QUÉ HACE ESTE MÓDULO.

- Generar: con el original ya bajado (el camino caro de `media_processing`,
  dentro del MISMO semáforo de un video a la vez), una sola pasada de ffmpeg
  decodifica UNA vez y codifica los peldaños de abajo (`split`). El peldaño
  de arriba es lo que ya se servía: el `feed-720` si existe o el original
  (la app sube a 720p y ~2.5 Mbps), así que no se recodifica nada que ya
  estuviera bien.
- Guardar: la lista va en `post_media.variantes` (migración 0117, jsonb).
  Sin la columna no se genera nada: sería CPU gastada en archivos que nadie
  podría encontrar.
- Leer: la hidratación de las filas `s3` firma cada variante con la MISMA
  política de carpeta que ya firma el video (no cuesta una firma más) y
  añade `variantes: [{alto, url, bitrate}]`. Retrocompatible: una app vieja
  no mira el campo y sigue usando `media_url`.

TODO APAGADO DE FÁBRICA. `video_calidades_enabled` (generar) y
`video_calidades_lectura` (entregar) nacen en False: sin tocarlas, la API se
comporta exactamente como antes y ni siquiera mira si la columna existe.

`alto` ES EL LADO MENOR, como en «480p»: un video vertical de 480x854 es el
peldaño 480. Así se llaman las calidades en todas partes y así las compara
la app.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from sqlalchemy import JSON, Uuid, column, inspect, select, table, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings

if TYPE_CHECKING:
    from app.modules.content.models import PostMedia

logger = logging.getLogger("renaser.medios")


@dataclass(frozen=True)
class Peldano:
    #: Lado menor en píxeles (la «p» de 480p).
    lado: int
    #: Bitrate de video en kbps. El de 720 es el mismo del `feed-720`.
    kbps: int


#: La escalera, de menor a mayor. 480 y 560 son los peldaños que TikTok sirve
#: por debajo de 720 (Dashlet §2.2). El de 720 solo se genera si el principal
#: es MAYOR que 720 (un original de 1080p que no pasó por el `feed-720` porque
#: ya venía ligero); con un principal de 720 —lo normal— se queda en dos.
ESCALERA: tuple[Peldano, ...] = (
    Peldano(480, 900),
    Peldano(560, 1300),
    Peldano(720, 2400),
)

#: Audio de los peldaños. 96 kbps en AAC estéreo se oye bien en un teléfono y
#: es lo mismo que usa la escalera HLS.
AUDIO_KBPS = 96

#: Bitrate nominal del `feed-720` (video + audio de `_transcodificar_mp4`).
#: Su tamaño real no se guarda en la fila, así que se usa el nominal.
BITRATE_FEED_720 = (2400 + 128) * 1000

#: La carpeta de los peldaños dentro de `videos/<uid>/<medio>/`. Versionada
#: igual que los demás derivados: CloudFront guarda cada objeto un año.
CARPETA = "calidades-v1"

#: Un peldaño que no ahorra al menos esto frente al principal no merece la
#: copia: elegirlo daría casi los mismos bytes con peor imagen.
AHORRO_MINIMO = 0.85

#: Espera máxima de la codificación (la misma que el resto del procesado).
ESPERA_S = 1800


# --------------------------------------------------------------------------- #
# Banderas
# --------------------------------------------------------------------------- #
def generacion_activa() -> bool:
    return bool(get_settings().video_calidades_enabled)


def lectura_activa() -> bool:
    return bool(get_settings().video_calidades_lectura)


# --------------------------------------------------------------------------- #
# Reglas puras (se prueban sin ffmpeg ni base)
# --------------------------------------------------------------------------- #
def lado_menor(ancho: int | None, alto: int | None) -> int | None:
    if not ancho or not alto:
        return None
    return min(ancho, alto)


def lado_del_principal(
    ancho: int | None, alto: int | None, con_feed_720: bool
) -> int | None:
    """El lado menor de lo que hoy sirve `media_url`.

    Con `feed-720`, 720 (es lo que pide `_escala(720)`); si no, el original.
    """
    if con_feed_720:
        return 720
    return lado_menor(ancho, alto)


def peldanos_para(lado_principal: int | None) -> list[Peldano]:
    """Los peldaños que tiene sentido generar por DEBAJO del principal.

    Nunca uno igual o mayor: reescalar hacia arriba es CPU para una copia que
    no se distingue. Sin medidas, ninguno (ante la duda, el original).
    """
    if not lado_principal:
        return []
    return [p for p in ESCALERA if p.lado < lado_principal]


def merece_calidades(
    duracion: float | None,
    ancho: int | None,
    alto: int | None,
    con_feed_720: bool,
) -> bool:
    """¿Se generan peldaños para este video?

    Bandera encendida, duración conocida y por debajo del tope
    (`video_calidades_duracion_maxima_s`, el freno de CPU por video) y al
    menos un peldaño por debajo del principal.
    """
    if not generacion_activa():
        return False
    if not duracion or duracion <= 0:
        return False
    if duracion > get_settings().video_calidades_duracion_maxima_s:
        return False
    return bool(peldanos_para(lado_del_principal(ancho, alto, con_feed_720)))


def clave_de(carpeta_del_medio: str, peldano: Peldano) -> str:
    """`videos/<uid>/<medio>/calidades-v1/480p.mp4`."""
    return f"{carpeta_del_medio.rstrip('/')}/{CARPETA}/{peldano.lado}p.mp4"


def _escala(lado_menor_objetivo: int) -> str:
    # La misma fórmula de `media_processing._escala`: lado menor al objetivo y
    # el otro en proporción (par), sirve para vertical y apaisado.
    return (
        f"scale=w='if(gte(iw,ih),-2,{lado_menor_objetivo})'"
        f":h='if(gte(iw,ih),{lado_menor_objetivo},-2)'"
    )


def comando(ffmpeg: str, origen: Path, salidas: list[tuple[Peldano, Path]]) -> list[str]:
    """UNA pasada de ffmpeg para todos los peldaños.

    Decodificar el original es una parte grande del trabajo; con `split` se
    decodifica una vez y se codifica N. `-threads` acota los hilos (1 de
    fábrica): la t3.small tiene 2 vCPU y la otra queda para la API. El total
    de CPU es el mismo; solo tarda más en reloj, y da igual: mientras tanto se
    sirve el principal, como hoy.
    """
    hilos = str(max(1, get_settings().video_calidades_hilos))
    etiquetas = [f"[v{p.lado}]" for p, _ in salidas]
    ramas = "".join(f"[r{i}]" for i in range(len(salidas)))
    filtros = [f"[0:v]split={len(salidas)}{ramas}"]
    for i, (peldano, _) in enumerate(salidas):
        filtros.append(f"[r{i}]{_escala(peldano.lado)}{etiquetas[i]}")
    cmd = [ffmpeg, "-v", "error", "-y", "-threads", hilos, "-i", str(origen)]
    cmd += ["-filter_complex", ";".join(filtros)]
    for (peldano, destino), etiqueta in zip(salidas, etiquetas):
        cmd += [
            "-map", etiqueta,
            # El audio si lo hay: un video mudo no puede hacer fallar la pasada.
            "-map", "0:a?",
            "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main",
            "-threads", hilos,
            "-b:v", f"{peldano.kbps}k",
            "-maxrate", f"{int(peldano.kbps * 1.1)}k",
            "-bufsize", f"{peldano.kbps * 2}k",
            "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k",
            # El índice al principio: el reproductor arranca sin pedir el final
            # del archivo, y la precarga de los primeros bytes sirve de algo.
            "-movflags", "+faststart",
            str(destino),
        ]
    return cmd


def entrada(peldano: Peldano, clave: str, tamano: int, duracion: float | None) -> dict[str, Any]:
    """Lo que se guarda de cada peldaño en `post_media.variantes`."""
    bitrate = (
        round(tamano * 8 / duracion)
        if duracion and duracion > 0
        else (peldano.kbps + AUDIO_KBPS) * 1000
    )
    return {"alto": peldano.lado, "clave": clave, "bitrate": bitrate, "bytes": tamano}


Ejecutor = Callable[..., Awaitable[tuple[int, bytes, bytes]]]


async def generar(
    ffmpeg: str,
    origen: Path,
    carpeta_tmp: Path,
    peldanos: list[Peldano],
    ejecutar: Ejecutor,
) -> list[tuple[Peldano, Path]]:
    """Codifica los peldaños. Devuelve los que salieron (vacío si falló).

    `ejecutar` es `media_processing._run`: así ffmpeg sale con la prioridad
    rebajada (`nice`) igual que el resto del procesado.
    """
    if not peldanos:
        return []
    salidas = [(p, carpeta_tmp / f"calidad-{p.lado}.mp4") for p in peldanos]
    inicio = time.monotonic()
    codigo, _, stderr = await ejecutar(comando(ffmpeg, origen, salidas), timeout=ESPERA_S)
    if codigo != 0:
        logger.warning("Las calidades extra fallaron: %s", stderr[-300:])
        return []
    hechas = [(p, d) for p, d in salidas if d.exists() and d.stat().st_size > 0]
    logger.info(
        "Calidades %s codificadas en %.1f s",
        ",".join(str(p.lado) for p, _ in hechas),
        time.monotonic() - inicio,
    )
    return hechas


# --------------------------------------------------------------------------- #
# La columna (migración 0117)
# --------------------------------------------------------------------------- #
#: `post_media` vista solo con lo que hace falta. Tabla LIGERA y no el modelo:
#: si `variantes` entrara en el modelo, CUALQUIER consulta de publicaciones
#: fallaría en una base sin la 0117 (mismo motivo que `almacen` en la 0116).
POST_MEDIA_VARIANTES = table(
    "post_media",
    column("id", Uuid(as_uuid=False)),
    column("variantes", JSON().with_variant(JSONB(), "postgresql")),
)

_REINTENTO_S = 60.0
_hay: bool | None = None
_mirado_en = 0.0


async def hay_columna(db: AsyncSession) -> bool:
    """`post_media.variantes` existe. El «sí» se recuerda; el «no» se vuelve a
    mirar cada minuto (la 0117 se pega a mano y la API la ve sin reiniciar)."""
    global _hay, _mirado_en
    if _hay is True:
        return True
    ahora = time.monotonic()
    if _hay is False and ahora - _mirado_en < _REINTENTO_S:
        return False
    conexion = await db.connection()

    def _mirar(sync) -> bool:
        inspector = inspect(sync)
        return inspector.has_table("post_media") and any(
            c["name"] == "variantes" for c in inspector.get_columns("post_media")
        )

    resultado = await conexion.run_sync(_mirar)
    if not resultado and _hay is None:
        logger.warning(
            "La migracion 0117 no esta aplicada: no se generan ni se entregan "
            "calidades extra de video."
        )
    _hay, _mirado_en = resultado, ahora
    return resultado


def fijar(valor: bool | None) -> None:
    """Para las pruebas: forzar o borrar lo averiguado."""
    global _hay, _mirado_en
    _hay, _mirado_en = valor, 0.0


async def puede_generar(db: AsyncSession, media_id: str) -> bool:
    """La bandera, la columna y que la fila aún no tenga peldaños.

    Con la bandera apagada no se hace NINGUNA consulta: es la garantía de que
    apagada no cambia nada.
    """
    if not generacion_activa():
        return False
    try:
        if not await hay_columna(db):
            return False
        tabla = POST_MEDIA_VARIANTES
        actuales = await db.scalar(select(tabla.c.variantes).where(tabla.c.id == media_id))
    except Exception:  # noqa: BLE001 — una mejora no puede tumbar el procesado
        logger.warning("No se pudo mirar si el medio %s tiene calidades", media_id, exc_info=True)
        return False
    return not actuales


async def guardar(db: AsyncSession, media_id: str, variantes: list[dict[str, Any]]) -> None:
    if not variantes:
        return
    tabla = POST_MEDIA_VARIANTES
    await db.execute(update(tabla).where(tabla.c.id == media_id).values(variantes=variantes))


async def leer(db: AsyncSession, ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Los peldaños guardados de un lote de medios. UNA consulta.

    Nada si la lectura está apagada o falta la columna.
    """
    if not ids or not lectura_activa() or not await hay_columna(db):
        return {}
    tabla = POST_MEDIA_VARIANTES
    filas = (
        await db.execute(
            select(tabla.c.id, tabla.c.variantes).where(
                tabla.c.id.in_(ids), tabla.c.variantes.is_not(None)
            )
        )
    ).all()
    return {fila.id: fila.variantes for fila in filas if isinstance(fila.variantes, list)}


# --------------------------------------------------------------------------- #
# Lo que se entrega
# --------------------------------------------------------------------------- #
def _entero_positivo(valor: Any) -> int | None:
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None
    entero = int(valor)
    return entero if entero > 0 else None


def bitrate_del_principal(
    con_feed_720: bool, tamano: int | None, duracion: float | None
) -> int | None:
    if con_feed_720:
        return BITRATE_FEED_720
    if tamano and duracion and duracion > 0:
        return round(tamano * 8 / duracion)
    return None


def armar_variantes(
    guardadas: list[dict[str, Any]],
    *,
    url_principal: str | None,
    lado_principal: int | None,
    bitrate_principal: int | None,
    firmar: Callable[[str | None], str | None],
) -> list[dict[str, Any]] | None:
    """`[{alto, url, bitrate}]` de menor a mayor, con el principal arriba.

    `firmar` devuelve None para una clave que no es de la carpeta del medio:
    lo que no se puede firmar se omite, nunca sale una URL rota. Si al final
    no queda ningún peldaño por debajo del principal, no se manda nada y la
    app hace exactamente lo de hoy.
    """
    if not url_principal or not lado_principal:
        return None
    lista: list[dict[str, Any]] = []
    vistos: set[int] = set()
    for item in guardadas:
        if not isinstance(item, dict):
            continue
        alto = _entero_positivo(item.get("alto"))
        if alto is None or alto >= lado_principal or alto in vistos:
            continue
        url = firmar(item.get("clave") if isinstance(item.get("clave"), str) else None)
        if not url:
            continue
        vistos.add(alto)
        lista.append({"alto": alto, "url": url, "bitrate": _entero_positivo(item.get("bitrate"))})
    if not lista:
        return None
    lista.sort(key=lambda v: v["alto"])
    lista.append({"alto": lado_principal, "url": url_principal, "bitrate": bitrate_principal})
    return lista


def con_feed_720(medio: PostMedia | Any) -> bool:
    return bool(getattr(medio, "feed_path", None))
