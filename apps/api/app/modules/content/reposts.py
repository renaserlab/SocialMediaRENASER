"""Republicar: volver a compartir la publicacion de otra persona, sin copiarla.

QUE NO ES. No es el boton de compartir que ya habia: ese abre la hoja del
sistema operativo y saca un enlace HACIA FUERA. Esto ocurre dentro de la
aplicacion y deja rastro: quien republico, que republico, de quien era y cuando.

LAS CUATRO REGLAS DEL ENCARGO, Y DONDE VIVE CADA UNA
----------------------------------------------------

1. EL ARCHIVO NO SE DUPLICA. Una republicacion NO tiene medios propios: apunta
   al post original y de ahi salen sus imagenes y sus videos. Ademas de ahorrar
   almacenamiento, es lo unico que funciona: la politica de escritura de Storage
   ata cada objeto a la carpeta de su dueno, asi que copiar el archivo obligaria
   a volver a subirlo con otra identidad. Y como el movil firma los medios por
   RUTA y no por publicacion, la cache del dispositivo ni se entera: la misma
   foto ya descargada se reutiliza.

2. LA AUTORIA SE CONSERVA Y SE DISTINGUE. La respuesta lleva los dos: `author`
   sigue siendo el AUTOR ORIGINAL —con su nombre, su usuario y su avatar— y
   `repost` dice quien lo compartio y cuando. Nunca se sustituye uno por otro,
   porque entonces republicar seria una forma comoda de apropiarse del trabajo
   ajeno.

3. NO HAY RECURSION, Y NO HACE FALTA COMPROBARLO. `post_reposts.post_id` es una
   clave ajena a `posts`, y una republicacion no es una fila de `posts`: la
   cadena «republicacion de una republicacion» no se puede escribir. Republicar
   algo que se esta viendo republicado apunta al original, porque el original es
   lo unico que hay en la tabla.

4. LOS BLOQUEOS SE RESPETAN EN LOS DOS EXTREMOS. Una republicacion tiene DOS
   personas detras, asi que el corte se aplica dos veces: si has bloqueado a
   quien republica, no la ves; y si has bloqueado al AUTOR ORIGINAL, tampoco
   —o bloquear no serviria de nada en cuanto un tercero republicara a la persona
   bloqueada—. Es la parte que un `join` a secas se deja siempre.

SIN LA MIGRACION 0042 ESTE MODULO NO ROMPE NADA. La tabla puede no existir
todavia: entonces las listas responden vacio y republicar contesta que la
funcion aun no esta disponible, en vez de reventar con un 500 (que ademas el
navegador reporta como error de CORS; ver `recommendations/esquema.py`).
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, ForeignKey, Text, Uuid, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, aliased, mapped_column

from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content.models import Post
from app.modules.content.schemas import AuthorSummary, PostRead, RepostRead
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import Follow
from app.modules.social_graph.service import blocked_either_way
from app.shared.database import Base, get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

router = APIRouter(tags=["content"])

#: Tope del comentario de quien republica. Coincide con el CHECK de la 0042.
MAX_COMENTARIO = 500


def _uuid() -> str:
    return str(uuid4())


class PostRepost(Base):
    """Una republicacion. Ver `supabase/migrations/0042_...sql`."""

    __tablename__ = "post_reposts"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: Quien republica. NO es el autor del contenido.
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    #: El post ORIGINAL, siempre.
    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("posts.id", ondelete="CASCADE"), index=True
    )
    comentario: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class RepostCreate(BaseModel):
    """Lo unico que aporta quien republica: un comentario, y es opcional."""

    comentario: str = Field(default="", max_length=MAX_COMENTARIO)


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def anotar(db: AsyncSession, posts: list[PostRead], uid: str | None) -> None:
    """Rellena `reposts_count` y `reposted_by_me` de un lote entero.

    UNA consulta para toda la pagina, no una por publicacion. Se llama DESPUES
    de armar la lista y la modifica en el sitio: asi el feed no tiene que
    cambiar su consulta —que esta ajustada al indice y paginada por cursor—
    para ganar un dato que es de otra tabla.

    Sin la 0042 no hace nada y las publicaciones salen con cero republicaciones,
    que es exactamente lo que hay hoy.
    """
    if not posts:
        return
    if not await esquema.hay_republicaciones(db):
        return
    ids = [p.id for p in posts]
    filas = (
        await db.execute(
            select(PostRepost.post_id, func.count())
            .where(PostRepost.post_id.in_(ids))
            .group_by(PostRepost.post_id)
        )
    ).all()
    cuenta = {post_id: total for post_id, total in filas}

    mios: set[str] = set()
    if uid:
        mios = set(
            (
                await db.scalars(
                    select(PostRepost.post_id).where(
                        PostRepost.post_id.in_(ids), PostRepost.author_id == uid
                    )
                )
            ).all()
        )
    for post in posts:
        post.reposts_count = cuenta.get(post.id, 0)
        post.reposted_by_me = post.id in mios


@router.get("/reposts", response_model=list[PostRead])
async def list_reposts(
    page: Page = Depends(pagination_params),
    author_id: str | None = Query(default=None),
    feed: str = Query(default="author", pattern="^(author|following)$"),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostRead]:
    """Republicaciones de un perfil, o de la gente a la que se sigue.

    Devuelve PUBLICACIONES (`PostRead`) y no republicaciones sueltas, porque lo
    que se pinta es la publicacion original con una cabecera encima que dice
    quien la compartio. Cada elemento trae su `repost`.
    """
    if not await esquema.hay_republicaciones(db):
        return []
    uid = current_user.id if current_user else None

    # Dos perfiles en la misma consulta: el autor original y quien republica.
    # Sin el alias, el segundo `join` a `profiles` seria el mismo y el nombre
    # de quien republica saldria siendo el del autor.
    QuienRepublica = aliased(Profile)
    stmt = (
        select(PostRepost, Post, Profile, QuienRepublica)
        .join(Post, Post.id == PostRepost.post_id)
        # El autor ORIGINAL.
        .join(Profile, Profile.id == Post.author_id)
        # Quien republica.
        .join(QuienRepublica, QuienRepublica.id == PostRepost.author_id)
        .where(Post.status == "published")
        .order_by(PostRepost.created_at.desc(), PostRepost.id.desc())
        .limit(page.limit)
        .offset(page.offset)
    )

    if feed == "following":
        if not uid:
            return []
        seguidos = select(Follow.following_id).where(Follow.follower_id == uid)
        stmt = stmt.where(PostRepost.author_id.in_(seguidos))
    else:
        if not author_id:
            raise ValidationAppError("Falta el perfil del que leer las republicaciones.")
        ensure_uuid(author_id, "Perfil no encontrado.")
        stmt = stmt.where(PostRepost.author_id == author_id)

    if uid:
        # LAS DOS PERSONAS. Bloquear a alguien tiene que esconderlo tambien
        # cuando aparece porque otro le republico.
        bloqueados = blocked_either_way(uid)
        stmt = stmt.where(
            PostRepost.author_id.not_in(bloqueados), Post.author_id.not_in(bloqueados)
        )

    filas = (await db.execute(stmt)).all()
    if not filas:
        return []

    # Los medios, los temas y las etiquetas salen del post ORIGINAL. Se importa
    # aqui dentro y no arriba porque el router de contenido importa este modulo:
    # a nivel de fichero seria un ciclo.
    from app.modules.content.router import (  # noqa: PLC0415
        _author,
        _etiquetas_del_lote,
        _load_media_map,
        _to_post_read,
    )

    ids = [fila[1].id for fila in filas]
    medios = await _load_media_map(db, ids)
    temas, etiquetas, personas = await _etiquetas_del_lote(db, ids)

    salida: list[PostRead] = []
    for repost, post, autor_original, quien_republica in filas:
        lectura = _to_post_read(
            post,
            autor_original,
            0,
            0,
            0,
            0,
            media=medios.get(post.id, []),
            topic_ids=temas.get(post.id, []),
            hashtags=etiquetas.get(post.id, []),
            mentions=personas.get(post.id, []),
        )
        lectura.repost = RepostRead(
            id=repost.id,
            author=AuthorSummary(
                id=quien_republica.id,
                full_name=quien_republica.full_name,
                username=quien_republica.username,
                avatar_path=quien_republica.avatar_path,
            ),
            comentario=repost.comentario or "",
            created_at=repost.created_at,
        )
        salida.append(lectura)
    await anotar(db, salida, uid)
    return salida


# --------------------------------------------------------------------------- #
# Escritura
# --------------------------------------------------------------------------- #
@router.post(
    "/posts/{post_id}/repost",
    response_model=RepostRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_repost(
    post_id: str,
    payload: RepostCreate | None = None,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RepostRead:
    """Republicar una publicacion.

    `post_id` es SIEMPRE el de la publicacion original: es lo unico que existe
    en `posts`. Republicar lo que se esta viendo republicado apunta al original
    por construccion, no por una comprobacion que alguien pueda olvidar.
    """
    if not await esquema.hay_republicaciones(db):
        raise ValidationAppError(
            "Republicar todavia no esta disponible en este servidor."
        )
    ensure_uuid(post_id, "Publicacion no encontrada.")
    uid = current_user.id

    post = await db.get(Post, post_id)
    if post is None or post.status != "published":
        raise NotFoundError("Publicacion no encontrada.")

    # Republicar a quien te ha bloqueado —o a quien tu bloqueaste— seria
    # devolver a la aplicacion justo lo que el bloqueo saco de ella.
    bloqueados = set((await db.scalars(blocked_either_way(uid))).all())
    if post.author_id in bloqueados:
        # Se responde «no encontrada» y no «estas bloqueado»: quien bloquea no
        # tiene por que enterarse de que le buscaron.
        raise NotFoundError("Publicacion no encontrada.")

    ya = await db.scalar(
        select(PostRepost).where(
            PostRepost.author_id == uid, PostRepost.post_id == post_id
        )
    )
    if ya is not None:
        # Republicar dos veces lo mismo es querer republicarlo una: se devuelve
        # la que ya hay en vez de un error, que es lo que espera un doble toque.
        fila = ya
    else:
        fila = PostRepost(
            author_id=uid,
            post_id=post_id,
            comentario=(payload.comentario if payload else "").strip(),
        )
        db.add(fila)
        await db.commit()
        await db.refresh(fila)

    perfil = await db.get(Profile, uid)
    from app.modules.content.router import _author  # noqa: PLC0415

    return RepostRead(
        id=fila.id,
        author=_author(perfil) if perfil else AuthorSummary(id=uid),
        comentario=fila.comentario or "",
        created_at=fila.created_at,
    )


@router.delete("/posts/{post_id}/repost", status_code=status.HTTP_204_NO_CONTENT)
async def borrar_repost(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Deshacer la republicacion propia. Idempotente."""
    if not await esquema.hay_republicaciones(db):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    ensure_uuid(post_id, "Publicacion no encontrada.")
    await db.execute(
        delete(PostRepost).where(
            PostRepost.author_id == current_user.id, PostRepost.post_id == post_id
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
