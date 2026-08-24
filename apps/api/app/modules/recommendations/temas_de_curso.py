"""Etiquetar un curso con los temas de los que trata.

Es el gemelo de `temas_de_contenido`, y esta aparte por la misma razon: lo
escribe el modulo de CATALOGO (al crear y al editar un curso) pero lo lee el
RECOMENDADOR, y el modelo `CourseTopic` es de aqui.

LO QUE PROTEGE. Que el tema existe y sigue activo no se puede comprobar en
React: quien publica no manda un formulario, manda una peticion. Sin esto
cualquiera podria etiquetar con un id inventado —rompiendo la clave foranea a
mitad de una transaccion— o con veinte temas, que es como mueren las taxonomias.

QUIEN puede etiquetar QUE lo decide quien llama: en los dos casos, el autor del
curso o la administracion. Y ademas la RLS de la 0028, que es la que manda de
verdad cuando la escritura entra por PostgREST.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationAppError
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.config import MAX_TEMAS_POR_CURSO
from app.modules.recommendations.models import CourseTopic, Topic


async def disponible(db: AsyncSession) -> bool:
    """Si hay donde guardar los temas de un curso."""
    return await esquema.hay_temas_de_curso(db)


async def validar(db: AsyncSession, topic_ids: list[str]) -> list[str]:
    """Deja la lista limpia, o explica por que no vale.

    Se rechaza entera en vez de guardar «lo que se pueda»: aceptar a medias
    dejaria a quien publica creyendo que su curso esta clasificado en algo que
    en realidad no se guardo.
    """
    unicos = list(dict.fromkeys(topic_ids))
    if not unicos:
        return []
    if len(unicos) > MAX_TEMAS_POR_CURSO:
        raise ValidationAppError(
            f"Un curso admite como máximo {MAX_TEMAS_POR_CURSO} temas."
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
    course_id: str,
    topic_ids: list[str],
    *,
    autor_id: str | None = None,
    source: str = "manual",
) -> None:
    """Deja el curso con EXACTAMENTE esos temas. No hace commit.

    Es un reemplazo, no una suma: editar tiene que poder QUITAR un tema mal
    elegido. Y borra solo los de ESTE curso, nunca los de otro.

    El commit lo hace quien llama, para que el curso y sus temas entren juntos.
    """
    if not await esquema.hay_temas_de_curso(db):
        # Sin la 0028 no hay donde guardarlos. El curso se crea y se edita
        # igual; lo que no puede pasar es que no se pueda guardar por esto.
        return

    limpios = await validar(db, topic_ids)

    await db.execute(delete(CourseTopic).where(CourseTopic.course_id == course_id))
    for topic_id in limpios:
        db.add(CourseTopic(course_id=course_id, topic_id=topic_id, source=source))

    # Lo que se le recomienda a esta persona cambia: su curso ya no trata de lo
    # mismo. Se invalida SOLO su memoria, no la de todos.
    if autor_id:
        cache.invalidar(autor_id)


async def tiene_alguno(db: AsyncSession, course_id: str) -> bool:
    """Si el curso tiene al menos un tema. Lo usa la validacion de publicar."""
    if not await esquema.hay_temas_de_curso(db):
        return False
    fila = await db.scalar(
        select(CourseTopic.topic_id).where(CourseTopic.course_id == course_id).limit(1)
    )
    return fila is not None


async def leer(db: AsyncSession, course_ids: list[str]) -> dict[str, list[str]]:
    """Los temas de varios cursos, de UNA consulta.

    Lo consume el catalogo y el recomendador, y por eso no puede ser una
    consulta por fila.
    """
    if not course_ids:
        return {}
    if not await esquema.hay_temas_de_curso(db):
        # Ningun curso tiene temas porque la tabla no existe. Vacio es la
        # respuesta correcta, no un error: es lo mismo que decir «nadie ha
        # etiquetado nada todavia».
        return {}
    filas = (
        await db.execute(
            select(CourseTopic.course_id, CourseTopic.topic_id)
            .where(CourseTopic.course_id.in_(course_ids))
            .order_by(CourseTopic.created_at)
        )
    ).all()
    salida: dict[str, list[str]] = {}
    for course_id, topic_id in filas:
        salida.setdefault(course_id, []).append(topic_id)
    return salida
