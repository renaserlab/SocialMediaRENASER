"""Etiquetar una publicacion con los temas de los que trata.

POR QUE ESTA APARTE. Lo escribe el modulo de CONTENIDO (al publicar y al
editar) pero lo lee el RECOMENDADOR, y el modelo `PostTopic` es de este
modulo. Metiendo la funcion en `service.py` habria hecho falta que
`content/router.py` importara un fichero que a su vez importa medio
recomendador; aqui solo hay validacion y escritura, sin nada mas colgando.

LO QUE PROTEGE. La comprobacion de que el tema existe y sigue activo no puede
vivir en React: quien publica no manda el formulario, manda una peticion. Sin
esto, cualquiera podria etiquetar con un id inventado —y romper la clave
foranea a mitad de una transaccion— o con veinte temas, que es como mueren las
taxonomias.

QUIEN puede etiquetar QUE lo decide quien llama: en los dos casos, el autor de
la publicacion. Y ademas la RLS de la 0027, que es la que manda de verdad.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationAppError
from app.modules.recommendations import cache
from app.modules.recommendations.config import MAX_TEMAS_POR_PUBLICACION
from app.modules.recommendations.models import PostTopic, Topic


async def validar(db: AsyncSession, topic_ids: list[str]) -> list[str]:
    """Deja la lista limpia, o explica por que no vale.

    Se rechaza entera en vez de guardar «lo que se pueda»: aceptar a medias
    dejaria a quien publica creyendo que su video esta clasificado en algo que
    en realidad no se guardo.
    """
    unicos = list(dict.fromkeys(topic_ids))
    if not unicos:
        return []
    if len(unicos) > MAX_TEMAS_POR_PUBLICACION:
        raise ValidationAppError(
            f"Una publicación admite como máximo {MAX_TEMAS_POR_PUBLICACION} temas."
        )
    validos = set(
        (
            await db.scalars(
                select(Topic.id).where(Topic.id.in_(unicos), Topic.active.is_(True))
            )
        ).all()
    )
    desconocidos = [t for t in unicos if t not in validos]
    if desconocidos:
        raise ValidationAppError(
            "Hay temas que ya no están disponibles. Vuelve a elegirlos.",
            details={"topic_ids": desconocidos},
        )
    return unicos


async def fijar(
    db: AsyncSession,
    post_id: str,
    topic_ids: list[str],
    *,
    autor_id: str | None = None,
    source: str = "manual",
) -> None:
    """Deja la publicacion con EXACTAMENTE esos temas. No hace commit.

    Es un reemplazo, no una suma: editar tiene que poder QUITAR un tema mal
    elegido. Y borra solo los de ESTA publicacion, nunca los de otra.

    El commit lo hace quien llama, para que la publicacion y sus temas entren
    juntos: una publicacion guardada sin sus temas se quedaria sin clasificar
    para siempre sin que nadie se entere.
    """
    limpios = await validar(db, topic_ids)

    await db.execute(delete(PostTopic).where(PostTopic.post_id == post_id))
    for topic_id in limpios:
        db.add(PostTopic(post_id=post_id, topic_id=topic_id, source=source))

    # Lo que se le recomienda a esta persona acaba de cambiar: su contenido ya
    # no trata de lo mismo. Se invalida SOLO su memoria, no la de todos.
    if autor_id:
        cache.invalidar(autor_id)


async def leer(db: AsyncSession, post_ids: list[str]) -> dict[str, list[str]]:
    """Los temas de varias publicaciones, de UNA consulta.

    Lo consume el feed para devolverlos junto a cada publicacion, y por eso no
    puede ser una consulta por fila: con veinte publicaciones serian veinte
    viajes para pintar unas etiquetas.
    """
    if not post_ids:
        return {}
    filas = (
        await db.execute(
            select(PostTopic.post_id, PostTopic.topic_id)
            .where(PostTopic.post_id.in_(post_ids))
            .order_by(PostTopic.created_at)
        )
    ).all()
    salida: dict[str, list[str]] = {}
    for post_id, topic_id in filas:
        salida.setdefault(post_id, []).append(topic_id)
    return salida
