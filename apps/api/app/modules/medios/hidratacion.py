"""La firma en UN SOLO PUNTO: la hidratación común de `post_media` (spec §7).

Todo endpoint que devuelve `PostRead` arma sus medios con
`content/router._load_media_map` (o `_media_read` al crear), y esa función
llama aquí. Para cada fila con `almacen = 's3'` se rellenan:

- `media_url`: `feed-720-v<n>.mp4` si existe; si no, el original;
- `poster_url`;
- `stream_url`, si hay HLS: el endpoint de la API con un token corto, porque
  las listas se reescriben allí (ver `content/router.media_hls_playlist`);
- `urls_expiran`;
- `variantes`, si el video tiene calidades extra y `video_calidades_lectura`
  está encendida (ver `medios/calidades.py`; apagado de fábrica).

SOLO DESPUÉS DEL PREDICADO. Esta función no decide quién ve qué: firma lo que
le llega. Lo que no se podía ver ya se quedó fuera de la consulta del endpoint
(`content/visibilidad.py`). Y si quien pregunta no puede recibir videos de S3,
no se firma nada aunque llegue una fila (doble cinturón).
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.medios import banderas, calidades, esquema, firma

if TYPE_CHECKING:
    from app.modules.content.schemas import PostMediaRead

logger = logging.getLogger("renaser.medios")

#: La línea de log que vigila la alarma `AlarmaFirmaDeMediosFallida` (filtro
#: de métrica en la pila 02). NO CAMBIAR el texto sin cambiar el filtro: si la
#: firma deja de funcionar, cada fila `s3` sale sin URL y los videos nuevos
#: se ven negros sin que nada más lo diga.
MARCA_FIRMA_FALLIDA = "medios.firma_fallida"
#: Una línea por proceso cada tanto, no una por fila: basta para la alarma y
#: no inunda el log en cada página del muro.
_AVISO_CADA_S = 60.0
_ultimo_aviso = 0.0


def _avisar_firma_fallida(motivo: str, media_id: str | None) -> None:
    global _ultimo_aviso
    ahora = time.monotonic()
    if ahora - _ultimo_aviso < _AVISO_CADA_S:
        return
    _ultimo_aviso = ahora
    # Estructurada (clave=valor) y SIN nada secreto: el motivo y el medio.
    logger.error("%s motivo=%s media_id=%s", MARCA_FIRMA_FALLIDA, motivo, media_id or "-")


def url_de_hls(media_id: str, token: str) -> str:
    """Relativa a propósito: la app la resuelve contra la base de la API que
    ya usa, y así no hace falta configurar aquí el dominio público."""
    prefijo = get_settings().api_v1_prefix.rstrip("/")
    return f"{prefijo}/media/{media_id}/hls/master.m3u8?t={token}"


def firmar_medio(
    medio: PostMediaRead,
    vence: int,
    viewer_id: str | None = None,
    variantes_guardadas: list[dict] | None = None,
) -> None:
    """Rellena las URLs de UNA fila `s3`. Sin firma configurada, las deja
    vacías: la app enseña el error de siempre en vez de una URL rota.

    `variantes_guardadas` (calidades extra, apagado de fábrica): se firman con
    la misma query de carpeta, sin coste de firma adicional."""
    from app.modules.content.schemas import VarianteDeVideo

    carpeta = firma.carpeta_de_clave(medio.storage_path or "")
    if carpeta is None:
        _avisar_firma_fallida("clave_fuera_de_videos", medio.id)
        return
    query = firma.query_de_carpeta(carpeta, vence)
    if query is None:
        _avisar_firma_fallida("sin_firma_configurada", medio.id)
        return

    def _de_esta_carpeta(clave: str | None) -> str | None:
        # Nunca se firma una clave de otra carpeta, aunque la fila la nombre.
        if clave and firma.carpeta_de_clave(clave) == carpeta:
            return firma.url_firmada(clave, query)
        return None

    medio.media_url = _de_esta_carpeta(medio.feed_path) or _de_esta_carpeta(medio.storage_path)
    medio.poster_url = _de_esta_carpeta(medio.poster_path)
    if medio.stream_path and medio.id and firma.carpeta_de_clave(medio.stream_path) == carpeta:
        token = firma.token_hls(medio.id, viewer_id, vence)
        if token:
            medio.stream_url = url_de_hls(medio.id, token)
    medio.urls_expiran = datetime.fromtimestamp(vence, tz=timezone.utc)
    if variantes_guardadas:
        con_feed = bool(_de_esta_carpeta(medio.feed_path))
        armadas = calidades.armar_variantes(
            variantes_guardadas,
            url_principal=medio.media_url,
            lado_principal=calidades.lado_del_principal(medio.width, medio.height, con_feed),
            bitrate_principal=calidades.bitrate_del_principal(
                con_feed, medio.bytes, medio.duration_s
            ),
            firmar=_de_esta_carpeta,
        )
        if armadas:
            medio.variantes = [VarianteDeVideo(**v) for v in armadas]


async def hidratar(
    db: AsyncSession, medios: list[PostMediaRead], viewer_id: str | None = None
) -> None:
    """Marca `almacen` y firma las filas `s3` de un lote. UNA consulta."""
    if not medios or not await esquema.hay_almacen(db):
        return
    ids = [m.id for m in medios if m.id]
    if not ids:
        return
    tabla = esquema.POST_MEDIA_ALMACEN
    en_s3 = set(
        (
            await db.scalars(
                select(tabla.c.id).where(tabla.c.id.in_(ids), tabla.c.almacen == "s3")
            )
        ).all()
    )
    if not en_s3:
        return
    firmar = banderas.puede_recibir_s3()
    vence = firma.vencimiento_de_ventana()
    guardadas = await _variantes_o_nada(db, list(en_s3)) if firmar else {}
    for medio in medios:
        if medio.id not in en_s3:
            continue
        medio.almacen = "s3"
        if firmar:
            firmar_medio(medio, vence, viewer_id, guardadas.get(medio.id))


async def _variantes_o_nada(db: AsyncSession, ids: list[str]) -> dict[str, list[dict]]:
    """Las calidades extra del lote. Con `video_calidades_lectura` apagada no
    consulta nada; y un fallo aquí nunca deja sin video: sin variantes, la app
    usa `media_url` como siempre."""
    if not calidades.lectura_activa():
        return {}
    try:
        return await calidades.leer(db, ids)
    except Exception:  # noqa: BLE001
        logger.warning("No se pudieron leer las calidades extra", exc_info=True)
        return {}
