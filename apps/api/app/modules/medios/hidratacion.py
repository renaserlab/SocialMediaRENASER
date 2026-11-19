"""La firma en UN SOLO PUNTO: la hidratación común de `post_media` (spec §7).

Todo endpoint que devuelve `PostRead` arma sus medios con
`content/router._load_media_map` (o `_media_read` al crear), y esa función
llama aquí. Para cada fila con `almacen = 's3'` se rellenan:

- `media_url`: `feed-720-v<n>.mp4` si existe; si no, el original;
- `poster_url`;
- `stream_url`, si hay HLS: el endpoint de la API con un token corto, porque
  las listas se reescriben allí (ver `content/router.media_hls_playlist`);
- `urls_expiran`.

SOLO DESPUÉS DEL PREDICADO. Esta función no decide quién ve qué: firma lo que
le llega. Lo que no se podía ver ya se quedó fuera de la consulta del endpoint
(`content/visibilidad.py`). Y si quien pregunta no puede recibir videos de S3,
no se firma nada aunque llegue una fila (doble cinturón).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.medios import banderas, esquema, firma

if TYPE_CHECKING:
    from app.modules.content.schemas import PostMediaRead


def url_de_hls(media_id: str, token: str) -> str:
    """Relativa a propósito: la app la resuelve contra la base de la API que
    ya usa, y así no hace falta configurar aquí el dominio público."""
    prefijo = get_settings().api_v1_prefix.rstrip("/")
    return f"{prefijo}/media/{media_id}/hls/master.m3u8?t={token}"


def firmar_medio(medio: PostMediaRead, vence: int, viewer_id: str | None = None) -> None:
    """Rellena las URLs de UNA fila `s3`. Sin firma configurada, las deja
    vacías: la app enseña el error de siempre en vez de una URL rota."""
    carpeta = firma.carpeta_de_clave(medio.storage_path or "")
    if carpeta is None:
        return
    query = firma.query_de_carpeta(carpeta, vence)
    if query is None:
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
    for medio in medios:
        if medio.id not in en_s3:
            continue
        medio.almacen = "s3"
        if firmar:
            firmar_medio(medio, vence, viewer_id)
