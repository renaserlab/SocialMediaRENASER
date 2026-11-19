"""El predicado común de visibilidad de las publicaciones (spec §7, C3).

POR QUÉ EXISTE. Hasta aquí ningún endpoint de publicaciones miraba
`Post.visibility`: el muro, el detalle (que solo excluía `deleted` y devolvía
hasta borradores), la lista del recomendador, los guardados, las
republicaciones y las etiquetas. Solo la búsqueda lo aplicaba
(`search/repositorio.py`). La promesa de privacidad de los videos en S3 —«la
API solo firma después de revisar quién puede ver»— depende de esto.

LAS REGLAS:

- `public`: todos, también sin cuenta;
- `followers`: el autor y sus seguidores;
- `circle`: el autor y los miembros del círculo de la publicación
  (`posts.circle_id`); con `circle_id` nulo, solo el autor;
- borradores (y todo lo que no está `published`): solo el autor;
- administración (`admin`, `moderator`): todo;
- bloqueos: en ningún sentido;
- `deleted`: nadie (tampoco administración: borrar mueve los videos fuera
  del alcance de las firmas).

CUÁNDO SE APLICA. `publicaciones_visibilidad = estricta` lo aplica a todas las
publicaciones. De fábrica (`abierta`) los endpoints quedan como estaban, con
UNA excepción: las publicaciones con videos en S3 pasan SIEMPRE por el
predicado, porque son las únicas que la API firma. Así desplegar esto no
cambia nada para nadie (no hay filas `s3` hasta la fase 2) y, aun así, nunca
se firma un video que no se debía.

Y además, a quien no puede recibir videos de S3 (app vieja sin la cabecera
`X-Zeta-Medios: s3`, o la lectura apagada) se le esconden esas publicaciones
en todos los endpoints.

TODO ES SQL. Se incrusta en la consulta de cada endpoint para no descuadrar la
paginación (filtrar en memoria dejaría páginas de 12 en vez de 20).
"""

from __future__ import annotations

from sqlalchemy import and_, exists, literal, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.communities.models import CircleMember
from app.modules.content.models import Post
from app.modules.medios import banderas, esquema
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import Follow
from app.modules.social_graph.service import blocked_either_way
from app.shared.permissions import ADMIN_ROLES


def puede_ver(viewer_id: str | None):
    """La condición estricta, para `Post`. Ver las reglas en la cabecera."""
    no_borrada = Post.status != "deleted"
    publicada = Post.status == "published"
    publica = Post.visibility == "public"
    if not viewer_id:
        return and_(no_borrada, publicada, publica)

    # ALIAS EN LAS TRES SUBCONSULTAS, y no es estetica. Casi todas las
    # consultas de publicaciones ya unen `profiles` (el autor): sin alias,
    # SQLAlchemy correlaciona la subconsulta con esa fila y «quien mira es
    # admin» pasaria a ser «el AUTOR es admin».
    quien_mira = aliased(Profile)
    seguimiento = aliased(Follow)
    membresia = aliased(CircleMember)
    es_admin = exists(
        select(literal(1))
        .select_from(quien_mira)
        .where(quien_mira.id == viewer_id, quien_mira.role.in_(tuple(ADMIN_ROLES)))
    )
    seguidos = select(seguimiento.following_id).where(seguimiento.follower_id == viewer_id)
    mis_circulos = select(membresia.circle_id).where(membresia.user_id == viewer_id)
    visible_para_otros = and_(
        publicada,
        or_(
            publica,
            and_(Post.visibility == "followers", Post.author_id.in_(seguidos)),
            and_(
                Post.visibility == "circle",
                Post.circle_id.is_not(None),
                Post.circle_id.in_(mis_circulos),
            ),
        ),
        Post.author_id.not_in(blocked_either_way(viewer_id)),
    )
    return and_(no_borrada, or_(es_admin, Post.author_id == viewer_id, visible_para_otros))


def tiene_videos_s3():
    """La publicación tiene algún medio en S3. Solo con la 0116 aplicada."""
    tabla = esquema.POST_MEDIA_ALMACEN
    return Post.id.in_(select(tabla.c.post_id).where(tabla.c.almacen == "s3"))


async def predicado(db: AsyncSession, viewer_id: str | None):
    """Lo que hay que añadir al `WHERE` de un endpoint que devuelve `PostRead`.

    `None` = nada que añadir (el caso de fábrica sin la 0116), y entonces la
    consulta sale EXACTAMENTE igual que antes de este cambio.
    """
    partes = []
    estricta = banderas.visibilidad_estricta()
    if estricta:
        partes.append(puede_ver(viewer_id))
    if await esquema.hay_almacen(db):
        con_s3 = tiene_videos_s3()
        if not banderas.puede_recibir_s3():
            partes.append(not_(con_s3))
        elif not estricta:
            partes.append(or_(not_(con_s3), puede_ver(viewer_id)))
    if not partes:
        return None
    return and_(*partes) if len(partes) > 1 else partes[0]


async def aplicar(stmt, db: AsyncSession, viewer_id: str | None):
    condicion = await predicado(db, viewer_id)
    return stmt if condicion is None else stmt.where(condicion)


async def puede_ver_publicacion(db: AsyncSession, post_id: str, viewer_id: str | None) -> bool:
    """La condición estricta para UNA publicación: la usa el HLS de S3, que la
    vuelve a comprobar en cada pedido (una consulta por índice)."""
    fila = await db.scalar(
        select(Post.id).where(Post.id == post_id, puede_ver(viewer_id)).limit(1)
    )
    return fila is not None
