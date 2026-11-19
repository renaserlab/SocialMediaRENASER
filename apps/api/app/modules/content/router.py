"""Endpoints de contenido: feed, posts, likes, guardados y comentarios.

Seguridad clave (Fase 1): al crear un post/comentario o dar like/guardar, la
identidad se toma SIEMPRE de current_user.id (JWT), nunca de un campo del cliente.

El feed devuelve el autor (join a profiles) y los contadores (likes/comentarios)
mas el estado propio (liked_by_me / saved_by_me) cuando hay sesion.
"""

import re
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Response, status
from sqlalchemy import Text as SAText, delete, func, literal, select, update
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ForbiddenError, NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content import hashtags, menciones, reposts, visibilidad
from app.modules.content import media_processing as _mp
from app.modules.content.media_processing import process_media, processing_configured
from app.modules.content.models import (
    Comment,
    CommentLike,
    PodcastCategory,
    Post,
    PostLike,
    PostMedia,
    SavedPost,
)
from app.modules.content.schemas import (
    AuthorSummary,
    CommentCreate,
    CommentRead,
    PodcastCategoryCreate,
    PodcastCategoryRead,
    PodcastCategoryUpdate,
    PostCreate,
    PostMediaInput,
    PostMediaRead,
    PostUpdate,
    PostRead,
)
from app.modules.medios import banderas as medios_banderas
from app.modules.medios import firma as medios_firma
from app.modules.medios import hidratacion as medios_hidratacion
from app.modules.medios import publicacion as medios_publicacion
from app.modules.notifications.push import encolar_push, nombre_visible
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileSummary
from app.modules.recommendations import esquema as esquema_recomendaciones
from app.modules.recommendations import temas_de_contenido
from app.modules.social_graph.models import Follow
from app.modules.social_graph.service import blocked_either_way
from app.shared.cliente_http import cliente_http
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin as is_admin_user
from app.shared.pagination import Page, pagination_params

router = APIRouter(tags=["content"])



# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _feed_columns(uid: str | None):
    likes_sq = (
        select(func.count())
        .select_from(PostLike)
        .where(PostLike.post_id == Post.id)
        .scalar_subquery()
    )
    comments_sq = (
        select(func.count())
        .select_from(Comment)
        .where(Comment.post_id == Post.id, Comment.status == "published")
        .scalar_subquery()
    )
    if uid:
        # EXISTS y no COUNT: solo interesa si hay fila, no cuantas. Postgres
        # corta en la primera coincidencia en vez de recorrer y contar, y el
        # plan usa directamente el indice de la clave primaria (post_id,
        # user_id).
        liked_sq = (
            select(literal(1))
            .select_from(PostLike)
            .where(PostLike.post_id == Post.id, PostLike.user_id == uid)
            .exists()
        )
        saved_sq = (
            select(literal(1))
            .select_from(SavedPost)
            .where(SavedPost.post_id == Post.id, SavedPost.user_id == uid)
            .exists()
        )
    else:
        liked_sq = literal(False)
        saved_sq = literal(False)
    return likes_sq, comments_sq, liked_sq, saved_sq


def _author(profile: Profile) -> AuthorSummary:
    return AuthorSummary(
        id=profile.id,
        full_name=profile.full_name,
        username=profile.username,
        avatar_path=profile.avatar_path,
    )


def _to_post_read(
    post: Post,
    profile: Profile,
    lc: int,
    cc: int,
    lk: int | bool,
    sv: int | bool,
    media: list[PostMediaRead] | None = None,
    topic_ids: list[str] | None = None,
    hashtags: list[str] | None = None,
    mentions: list[dict] | None = None,
) -> PostRead:
    return PostRead(
        id=post.id,
        author=_author(profile),
        body=post.body,
        status=post.status,
        visibility=post.visibility,
        category=post.category,
        created_at=post.created_at,
        media=media or [],
        likes_count=lc or 0,
        comments_count=cc or 0,
        liked_by_me=(lk or 0) > 0,
        saved_by_me=(sv or 0) > 0,
        topic_ids=topic_ids or [],
        hashtags=hashtags or [],
        mentions=[AuthorSummary(**m) for m in (mentions or [])],
    )


async def _nombre_del_actor(db: AsyncSession, uid: str) -> str | None:
    """El nombre con el que aparece quien provoca un aviso.

    SALE DE `profiles`, NO DE `current_user`. Y no es un rodeo: `AuthUser` es un
    dataclass con id, email, role y claims —lo que trae el JWT— y NO tiene
    `full_name`. Leerlo de ahi lanza AttributeError DESPUES del commit, o sea
    un 500 con la operacion ya guardada, que ademas el navegador reporta como
    error de CORS porque Starlette no pone cabeceras CORS en una excepcion sin
    capturar. Es exactamente la trampa numero 3 del proyecto.

    Devolver None es valido: `send_push` escribe «Alguien» y el aviso sale
    igual. Un aviso con el nombre generico es infinitamente mejor que ninguno.
    Antes de llegar ahi se prueba con el usuario (`nombre_visible`).
    """
    fila = (
        await db.execute(
            select(Profile.full_name, Profile.username).where(Profile.id == uid)
        )
    ).first()
    return nombre_visible(fila[0], fila[1]) if fila else None


async def _etiquetas_del_lote(
    db: AsyncSession, post_ids: list[str]
) -> tuple[dict[str, list[str]], dict[str, list[str]], dict[str, list[dict]]]:
    """Temas, hashtags y menciones de un lote entero: TRES consultas, no 3xN.

    Existe para que los cuatro sitios que arman publicaciones (el feed, el
    detalle, la lista del recomendador y la de una etiqueta) pidan lo mismo de
    la misma forma. Cuando se anadio el segundo, ya se habia olvidado uno.

    Las tres degradan solas: sin la 0027 no hay temas, sin la 0031 no hay
    etiquetas, sin la 0032 no hay menciones, y en los tres casos la respuesta
    correcta es un diccionario vacio y no un error.
    """
    return (
        await temas_de_contenido.leer(db, post_ids),
        await hashtags.leer(db, post_ids),
        await menciones.leer(db, post_ids),
    )


async def _load_media_map(
    db: AsyncSession, post_ids: list[str], viewer_id: str | None = None
) -> dict[str, list[PostMediaRead]]:
    if not post_ids:
        return {}
    rows = (
        await db.scalars(
            select(PostMedia)
            .where(PostMedia.post_id.in_(post_ids))
            .order_by(PostMedia.sort_order)
        )
    ).all()
    result: dict[str, list[PostMediaRead]] = {}
    lecturas: list[PostMediaRead] = []
    for media in rows:
        lectura = _media_read(media)
        lecturas.append(lectura)
        result.setdefault(media.post_id, []).append(lectura)
    # LA FIRMA EN UN SOLO PUNTO (spec §7): todo endpoint que devuelve
    # `PostRead` pasa por aqui. Marca `almacen` y firma las filas `s3`; sin la
    # migracion 0116 no hace nada y no cuesta ninguna consulta.
    await medios_hidratacion.hidratar(db, lecturas, viewer_id)
    return result


def _media_read(media: PostMedia) -> PostMediaRead:
    return PostMediaRead(
        id=media.id,
        storage_path=media.storage_path,
        media_type=media.media_type,
        sort_order=media.sort_order,
        width=media.width,
        height=media.height,
        duration_s=media.duration_s,
        bytes=media.bytes,
        poster_path=media.poster_path,
        feed_path=media.feed_path,
        stream_path=media.stream_path,
        processing_status=media.processing_status,
    )


#: Prefijos del bucket de S3. Una ruta asi que llega del cliente como si fuera
#: de Supabase no es de Supabase: se rechaza para que nadie pueda colgar una
#: clave de S3 en una fila que la API no firmo (spec §5, L8).
_PREFIJOS_DE_S3 = ("videos/", "pendientes/", "borrados/")


def _exigir_ruta_de_supabase(ruta: str | None) -> None:
    if ruta and ruta.lstrip("/").startswith(_PREFIJOS_DE_S3):
        raise ValidationAppError("Ruta de medio no valida.")


async def _firmar_respuesta(
    db: AsyncSession, medios: list[PostMediaRead], uid: str
) -> None:
    """Al crear o editar, quien publica recibe ya firmado su video de S3.

    Se marca `almacen` a mano porque estas lecturas se armaron antes de que la
    fila existiera en la base (`_media_read` sobre el objeto recien creado).
    """
    en_s3 = await medios_publicacion.ids_en_s3(db, [m.id for m in medios if m.id])
    if not en_s3:
        return
    vence = medios_firma.vencimiento_de_ventana()
    for medio in medios:
        if medio.id in en_s3:
            medio.almacen = "s3"
            if medios_banderas.puede_recibir_s3():
                medios_hidratacion.firmar_medio(medio, vence, uid)


async def _get_active_post(db: AsyncSession, post_id: str) -> Post:
    post = await db.get(Post, post_id)
    if post is None or post.status == "deleted":
        raise NotFoundError("Publicacion no encontrada.")
    return post


def _filtros_de_contenido(
    stmt,
    *,
    circle_id: str | None,
    media: str | None,
    exclude_media: str | None,
    category: str | None,
    exclude_category: str | None,
):
    """Los criterios del muro que miran a la PUBLICACION, no a quien la firma.

    Se sacaron a una funcion cuando el muro empezo a mezclar republicaciones:
    las dos corrientes tienen que aplicar exactamente los mismos, o el muro
    ensenaria por la puerta de atras lo que echo por la principal. El caso
    concreto es `exclude_media=audio`: los audios son episodios del podcast y
    no van al muro, asi que la republicacion de un audio tampoco.

    Lo que NO esta aqui es deliberado. Quien firma —el bloqueo, `following` y
    `author_id`— significa una persona distinta en cada corriente: en una es el
    autor y en la otra quien republica. Compartirlo seria justo el error.
    """
    stmt = stmt.where(Post.status == "published")

    if circle_id:
        ensure_uuid(circle_id, "Círculo no encontrado.")
        stmt = stmt.where(Post.circle_id == circle_id)

    if media:
        with_media = select(PostMedia.post_id).where(PostMedia.media_type == media)
        stmt = stmt.where(Post.id.in_(with_media))

    if category:
        stmt = stmt.where(Post.category == category)

    if exclude_category:
        # El audio privado es un audio con categoria reservada: se pide aparte
        # y no debe colarse en la lista de episodios del podcast.
        stmt = stmt.where(
            (Post.category.is_(None)) | (Post.category != exclude_category)
        )

    if exclude_media:
        # El feed de Inicio excluye los audios: son episodios del podcast y
        # tienen su propia seccion, no deben repetirse en el muro.
        of_type = select(PostMedia.post_id).where(PostMedia.media_type == exclude_media)
        stmt = stmt.where(Post.id.not_in(of_type))
    return stmt


async def _hidratar_publicaciones(
    db: AsyncSession, post_ids: list[str], uid: str | None
) -> dict[str, PostRead]:
    """Arma publicaciones enteras a partir de una lista de ids.

    Contadores, medios, temas, etiquetas y menciones de TODO el lote, en un
    numero fijo de consultas. Es la mitad de `list_posts` que no decide el
    orden, sacada aparte porque hay dos sitios donde el orden lo decide otra
    cosa: el muro cuando mezcla republicaciones, y la pestana de
    republicaciones de un perfil.

    ANTES DE ESTO la lista de republicaciones pasaba `0, 0, 0, 0` a mano. Una
    publicacion con cuarenta me gusta salia con cero en cuanto alguien la
    compartia, y el corazon aparecia apagado aunque estuviera dado: el dato
    estaba en la base, simplemente no se pedia.

    Devuelve un diccionario, no una lista: quien llama ya tiene su orden y ademas
    puede necesitar la misma publicacion dos veces (el original y la
    republicacion de alguien). Por eso hay que COPIAR antes de tocar cada
    ocurrencia; si no, ponerle la cabecera a una se la pondria a las dos.
    """
    if not post_ids:
        return {}
    unicos = list(dict.fromkeys(post_ids))
    likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(uid)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.id.in_(unicos))
    )
    # Quien llama ya filtro, pero esta es la ultima puerta antes de firmar: se
    # vuelve a aplicar el predicado comun (spec §7). Sin nada que aplicar, la
    # consulta sale igual que antes.
    stmt = await visibilidad.aplicar(stmt, db, uid)
    filas = (await db.execute(stmt)).all()
    presentes = [fila[0].id for fila in filas]
    medios = await _load_media_map(db, presentes, uid)
    temas, etiquetas, personas = await _etiquetas_del_lote(db, presentes)
    lecturas = {
        fila[0].id: _to_post_read(
            *fila,
            media=medios.get(fila[0].id, []),
            topic_ids=temas.get(fila[0].id, []),
            hashtags=etiquetas.get(fila[0].id, []),
            mentions=personas.get(fila[0].id, []),
        )
        for fila in filas
    }
    # Aqui dentro y no en quien llama: asi lo tienen las dos listas que pasan
    # por esta funcion (el muro con republicaciones y la pestana de
    # republicaciones de un perfil) sin repetir la consulta en cada una.
    await anotar_guardados(db, list(lecturas.values()))
    return lecturas


async def anotar_guardados(db: AsyncSession, posts: list[PostRead]) -> None:
    """Rellena `saves_count` de un lote entero: UNA consulta agrupada.

    Igual que `reposts.anotar`, y por el mismo motivo: el dato vive en otra
    tabla (`saved_posts`) y las consultas del feed estan ajustadas al indice y
    paginadas por cursor. Se anota DESPUES, sobre la lista ya armada, con un
    solo `GROUP BY` para toda la pagina — nunca una consulta por publicacion.

    NO HACE FALTA MIGRACION: `saved_posts` existe desde el principio (es la
    tabla de guardar/quitar de guardados). Lo unico que faltaba era contarla.

    Solo el NUMERO. Quien guardo no sale de aqui ni tiene endpoint propio:
    guardar es apartar algo para uno mismo, no un gesto publico como reaccionar.
    """
    if not posts:
        return
    # `dict.fromkeys` y no `set`: la misma publicacion puede venir dos veces en
    # el muro (el original y la republicacion de alguien) y cada copia recibe
    # su valor abajo, pero preguntar dos veces por ella no tendria sentido.
    ids = list(dict.fromkeys(post.id for post in posts))
    filas = (
        await db.execute(
            select(SavedPost.post_id, func.count())
            .where(SavedPost.post_id.in_(ids))
            .group_by(SavedPost.post_id)
        )
    ).all()
    cuenta = {post_id: total for post_id, total in filas}
    for post in posts:
        post.saves_count = cuenta.get(post.id, 0)


async def _likes_count(db: AsyncSession, post_id: str) -> int:
    value = await db.scalar(
        select(func.count()).select_from(PostLike).where(PostLike.post_id == post_id)
    )
    return value or 0


# --------------------------------------------------------------------------- #
# Feed / posts
# --------------------------------------------------------------------------- #
@router.get("/posts", response_model=list[PostRead])
async def list_posts(
    page: Page = Depends(pagination_params),
    feed: str = Query(default="all", pattern="^(all|following)$"),
    author_id: str | None = Query(default=None),
    circle_id: str | None = Query(default=None),
    media: str | None = Query(default=None, pattern="^(image|video|audio)$"),
    exclude_media: str | None = Query(default=None, pattern="^(image|video|audio)$"),
    category: str | None = Query(default=None, max_length=40),
    exclude_category: str | None = Query(default=None, max_length=40),
    # Paginacion por cursor (keyset): "lo publicado ANTES de este punto". A
    # diferencia de offset, no se descuadra cuando entran publicaciones nuevas
    # entre pagina y pagina, y Postgres salta directo por el indice en vez de
    # recorrer y descartar filas. Si llega, tiene prioridad sobre `offset`.
    before_created_at: str | None = Query(default=None),
    before_id: str | None = Query(default=None),
    # Republicaciones mezcladas en el muro. Apagado por defecto A PROPOSITO:
    # este endpoint sirve tambien la galeria de un perfil, un circulo y el feed
    # de video, y en ninguno de esos sitios una republicacion significa lo
    # mismo. Quien las quiere, las pide.
    with_reposts: bool = Query(default=False),
    # Publicaciones CONCRETAS, en el orden pedido (spec §7): la app las vuelve
    # a pedir cuando las URLs firmadas de sus videos estan por vencer (la
    # instantanea de Inicio dura hasta 3 dias; las firmas, 6 h). Con `ids`,
    # los demas filtros no aplican: se devuelve lo que se pidio y se puede ver.
    ids: str | None = Query(default=None, max_length=50 * 37),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostRead]:
    """Feed publico.

    `feed=all` ("Para ti") devuelve todo lo publicado; `feed=following`
    ("Siguiendo") solo lo de los perfiles que sigue el usuario. Sin sesion,
    `following` no tiene a quien consultar y devuelve una lista vacia.

    `author_id` restringe a las publicaciones de un perfil (su galeria) y
    `media` al tipo de adjunto, para separar la cuadricula de los audios sin
    traerse todo y filtrar en el cliente. `exclude_media` hace lo contrario:
    lo usa el muro para dejar fuera los audios, que viven en el podcast.

    Filtrar aqui y no en el cliente evita que la paginacion se descuadre: si el
    muro descartara los audios despues de recibirlos, una pagina de 20 podria
    quedarse en 12 y el scroll infinito pediria de mas.
    """
    uid = current_user.id if current_user else None

    if ids is not None:
        pedidos = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))
        if not pedidos or len(pedidos) > 50:
            raise ValidationAppError("Pide entre 1 y 50 publicaciones.")
        for pid in pedidos:
            ensure_uuid(pid, "Publicacion no encontrada.")
        salida = await leer_posts_por_id(db, pedidos, uid)
        await reposts.anotar(db, salida, uid)
        return salida

    # El predicado comun de visibilidad (spec §7). Se calcula UNA vez y entra
    # en `filtro_de_contenido`, que lo comparten las dos corrientes del muro.
    condicion_visible = await visibilidad.predicado(db, uid)

    # El cursor se interpreta UNA vez: lo usan las dos corrientes.
    cursor_at: datetime | None = None
    if before_created_at:
        try:
            cursor_at = datetime.fromisoformat(before_created_at.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationAppError("Cursor de paginacion no valido.")
        if before_id:
            ensure_uuid(before_id, "Cursor de paginacion no valido.")
    if author_id:
        # Un id con otro formato llegaria a Postgres y reventaria la consulta.
        ensure_uuid(author_id, "Perfil no encontrado.")

    def filtro_de_contenido(stmt):
        stmt = _filtros_de_contenido(
            stmt,
            circle_id=circle_id,
            media=media,
            exclude_media=exclude_media,
            category=category,
            exclude_category=exclude_category,
        )
        return stmt if condicion_visible is None else stmt.where(condicion_visible)

    def filtro_de_autoria(stmt):
        """Quien firma la publicacion: bloqueos, «siguiendo» y el perfil pedido.

        Aparte de `filtro_de_contenido` porque en la corriente de
        republicaciones «quien firma» es OTRA persona —quien comparte— y estos
        mismos criterios se aplican alli sobre ella.
        """
        # Bloquear tiene que servir de algo: sin esto la persona bloqueada
        # seguiria apareciendo en el muro. Se filtra en la consulta, igual que
        # el resto de criterios, para no descuadrar la paginacion.
        #
        # El corte va en los dos sentidos: no se ve a quien has bloqueado, y
        # tampoco a quien te ha bloqueado a ti. Si solo se cortara en un
        # sentido, bastaria con que la otra persona no te bloqueara para seguir
        # leyendote.
        if uid:
            stmt = stmt.where(Post.author_id.not_in(blocked_either_way(uid)))
        if feed == "following":
            seguidos = select(Follow.following_id).where(Follow.follower_id == uid)
            stmt = stmt.where(Post.author_id.in_(seguidos))
        if author_id:
            stmt = stmt.where(Post.author_id == author_id)
        return stmt

    def filtro_de_cursor(stmt, columna_fecha, columna_id):
        if cursor_at is None:
            return stmt
        # Desempate por id: dos publicaciones pueden compartir instante y sin un
        # orden total el cursor podria saltarse una o repetirla.
        if before_id:
            return stmt.where(
                (columna_fecha < cursor_at)
                | ((columna_fecha == cursor_at) & (columna_id < before_id))
            )
        return stmt.where(columna_fecha < cursor_at)

    if feed == "following" and not uid:
        return []

    # ----------------------------------------------------------------- #
    # Camino de siempre: solo publicaciones, en UNA consulta.
    # ----------------------------------------------------------------- #
    if not with_reposts:
        likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(uid)
        stmt = (
            select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
            .join(Profile, Profile.id == Post.author_id)
            .order_by(Post.created_at.desc(), Post.id.desc())
            .limit(page.limit)
        )
        stmt = filtro_de_contenido(stmt)
        stmt = filtro_de_autoria(stmt)
        stmt = filtro_de_cursor(stmt, Post.created_at, Post.id)
        if cursor_at is None:
            stmt = stmt.offset(page.offset)
        rows = (await db.execute(stmt)).all()
        ids_de_pagina = [row[0].id for row in rows]
        media_map = await _load_media_map(db, ids_de_pagina, uid)
        # Una consulta por cosa para el lote entero, no una por publicacion.
        temas, etiquetas, personas = await _etiquetas_del_lote(db, ids_de_pagina)
        salida = [
            _to_post_read(
                *row,
                media=media_map.get(row[0].id, []),
                topic_ids=temas.get(row[0].id, []),
                hashtags=etiquetas.get(row[0].id, []),
                mentions=personas.get(row[0].id, []),
            )
            for row in rows
        ]
        # Cuantas veces se republico cada una, y si fui yo. Se anota DESPUES en
        # vez de meterlo en la consulta de arriba: esa esta ajustada al indice y
        # paginada por cursor, y el dato vive en otra tabla que ademas puede no
        # existir todavia (migracion 0042).
        await reposts.anotar(db, salida, uid)
        await anotar_guardados(db, salida)
        return salida

    # ----------------------------------------------------------------- #
    # Muro con republicaciones: dos corrientes, un solo orden.
    # ----------------------------------------------------------------- #
    #
    # Se piden primero las CLAVES —fecha e id de lo que ordena— de cada
    # corriente, se mezclan, y solo despues se trae el contenido de las que
    # entran en la pagina. Traer el contenido de las dos corrientes enteras para
    # tirar la mitad seria pagar dos veces por lo mismo.
    #
    # POR QUE SE PIDEN `offset + limit` DE CADA UNA. El elemento numero N de la
    # mezcla sale de una de las dos, asi que los N primeros de la mezcla estan
    # todos entre los N primeros de A y los N primeros de B. Pedir menos podria
    # saltarse elementos cuando una corriente domina a la otra. Son dos columnas
    # por fila y el indice ya las tiene ordenadas: el coste es un recorrido de
    # indice, no de tabla.
    cuantas = page.limit if cursor_at is not None else page.offset + page.limit

    claves_stmt = (
        select(Post.created_at, Post.id)
        .order_by(Post.created_at.desc(), Post.id.desc())
        .limit(cuantas)
    )
    claves_stmt = filtro_de_contenido(claves_stmt)
    claves_stmt = filtro_de_autoria(claves_stmt)
    claves_stmt = filtro_de_cursor(claves_stmt, Post.created_at, Post.id)
    propias = [
        reposts.ClaveDeFeed(orden_at=creado, orden_id=pid, post_id=pid, repost_id="")
        for creado, pid in (await db.execute(claves_stmt)).all()
    ]

    republicadas = await reposts.claves_del_feed(
        db,
        uid=uid,
        feed=feed,
        author_id=author_id,
        cuantas=cuantas,
        cursor_at=cursor_at,
        cursor_id=before_id,
        filtro_de_contenido=filtro_de_contenido,
    )

    mezcla = sorted(
        propias + republicadas, key=lambda c: (c.orden_at, c.orden_id), reverse=True
    )
    pagina = (
        mezcla[: page.limit]
        if cursor_at is not None
        else mezcla[page.offset : page.offset + page.limit]
    )
    if not pagina:
        return []

    publicaciones = await _hidratar_publicaciones(
        db, [clave.post_id for clave in pagina], uid
    )
    cabeceras = await reposts.detalles(
        db, [clave.repost_id for clave in pagina if clave.repost_id]
    )

    salida = []
    for clave in pagina:
        lectura = publicaciones.get(clave.post_id)
        if lectura is None:
            # La publicacion desaparecio entre la consulta de claves y esta. Se
            # omite en vez de devolver un hueco.
            continue
        # Copia: la misma publicacion puede salir dos veces —el original y la
        # republicacion de alguien— y son objetos distintos en la respuesta.
        lectura = lectura.model_copy(deep=True)
        if clave.repost_id:
            cabecera = cabeceras.get(clave.repost_id)
            if cabecera is None:
                continue
            lectura.repost = cabecera
        salida.append(lectura)
    await reposts.anotar(db, salida, uid)
    return salida


@router.post("/posts", response_model=PostRead, status_code=status.HTTP_201_CREATED)
async def create_post(
    payload: PostCreate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostRead:
    for item in payload.media:
        _exigir_ruta_de_supabase(item.storage_path)
        _exigir_ruta_de_supabase(item.poster_path)
    for ruta in payload.image_paths:
        _exigir_ruta_de_supabase(ruta)
    # Sin bandera para esta cuenta, un video de S3 se rechaza YA, antes de
    # tocar nada. La adopcion de verdad va mas abajo (ver «VIDEOS EN S3»).
    if any(item.id_de_subida for item in payload.media):
        await medios_publicacion.exigir_habilitado(db, current_user.id)

    post = Post(
        author_id=current_user.id,
        body=payload.body,
        visibility=payload.visibility,
        category=payload.category,
    )
    db.add(post)
    # Los temas se validan ANTES del commit y viajan con el: una publicacion
    # guardada sin sus temas se quedaria sin clasificar para siempre y nadie se
    # enteraria. Si un tema no existe, no se guarda nada.
    await db.flush()
    if payload.topic_ids:
        await temas_de_contenido.fijar(
            db, post.id, payload.topic_ids, autor_id=current_user.id
        )

    # Las etiquetas salen del TEXTO, no del payload: si el cliente mandara la
    # lista, cualquiera podria colgar su publicacion de #python sin que la
    # palabra aparezca por ningun lado.
    await hashtags.fijar(db, post.id, post.body)

    # Las menciones si vienen elegidas, porque cada una manda una notificacion
    # y «@ana» es ambiguo. `fijar` devuelve solo a QUIEN HAY QUE AVISAR: ya ha
    # descartado a quien esta bloqueado y al propio autor.
    nuevas_menciones = await menciones.fijar(
        db, post.id, current_user.id, payload.mentioned_user_ids
    )
    # Se avisa a quien de verdad ha estrenado aviso. `add_notification` devuelve
    # False cuando ya habia uno igual —misma persona, misma publicacion— y en
    # ese caso mandar el push haria sonar el telefono por algo que ya estaba en
    # la bandeja.
    avisados: list[str] = []
    for mencionado in nuevas_menciones:
        if await add_notification(
            db,
            user_id=mencionado,
            actor_id=current_user.id,
            type="post_mention",
            entity_type="post",
            entity_id=post.id,
        ):
            avisados.append(mencionado)
    nuevas_menciones = avisados

    # VIDEOS SUBIDOS A S3 (spec §5). Se adoptan DESPUES de validar temas y
    # menciones y DENTRO de la misma transaccion que la publicacion: la fila,
    # su `almacen = 's3'` y la subida marcada como usada se confirman juntas o
    # no se confirma nada. Adoptar COPIA la pendiente a `videos/<uid>/<id>/`;
    # la pendiente NO se borra hasta despues del commit, asi que si publicar
    # falla, el reintento encuentra su subida intacta (estado sin cambiar).
    adoptados: dict[int, medios_publicacion.Adoptado] = {}
    filas_s3: dict[int, PostMedia] = {}
    for indice, item in enumerate(payload.media):
        if not item.id_de_subida:
            continue
        adoptado = await medios_publicacion.adoptar(
            db, current_user.id, item.id_de_subida, item.id_de_subida_poster
        )
        adoptados[indice] = adoptado
        fila = PostMedia(
            id=adoptado.media_id,
            post_id=post.id,
            storage_path=adoptado.storage_path,
            media_type=item.media_type,
            sort_order=indice,
            width=item.width,
            height=item.height,
            duration_s=item.duration_s,
            bytes=item.bytes or adoptado.bytes,
            poster_path=adoptado.poster_path,
        )
        db.add(fila)
        filas_s3[indice] = fila
    if filas_s3:
        await db.flush()
        for fila in filas_s3.values():
            await medios_publicacion.marcar_s3(db, fila.id)

    await db.commit()
    await db.refresh(post)
    # Ahora si: las pendientes ya copiadas se borran (y si esto falla, el ciclo
    # de vida de `pendientes/` las borra en un dia).
    for adoptado in adoptados.values():
        background.add_task(medios_publicacion.borrar_pendientes, adoptado.pendientes)

    # Los push van DESPUES del commit: si la transaccion fallara, no puede
    # haberse avisado ya de algo que no llego a ocurrir.
    if nuevas_menciones:
        actor = await _nombre_del_actor(db, current_user.id)
        encolar_push(
            background,
            user_ids=nuevas_menciones,
            notification_type="post_mention",
            actor_name=actor,
            # `postId` es lo que hace que tocar el aviso abra /post/{id} y
            # no el perfil de quien etiqueto, donde no esta la publicacion.
            data={"type": "post_mention", "postId": post.id},
        )

    # Medios con tipo explícito + compatibilidad con image_paths (sin tipo).
    entries: list[PostMediaInput] = list(payload.media)
    entries += [
        PostMediaInput(storage_path=path, media_type="image")
        for path in payload.image_paths
    ]

    media: list[PostMediaRead] = []
    for index, item in enumerate(entries):
        if index in filas_s3:
            # Ya guardada arriba, con la publicacion.
            media.append(_media_read(filas_s3[index]))
            continue
        row = PostMedia(
            post_id=post.id,
            storage_path=item.storage_path,
            media_type=item.media_type,
            sort_order=index,
            # Metadata calculada en el dispositivo al subir (si el movil pudo).
            width=item.width,
            height=item.height,
            duration_s=item.duration_s,
            bytes=item.bytes,
            poster_path=item.poster_path,
        )
        db.add(row)
        media.append(_media_read(row))
    if filas_s3:
        await _firmar_respuesta(db, media, current_user.id)
    if media:
        await db.commit()
        ids_s3 = {row.id for row in filas_s3.values()}
        if processing_configured() or (ids_s3 and _mp.procesado_s3_configurado()):
            # DESPUES de responder: genera la version ligera de la imagen y el
            # poster del video si el dispositivo no lo mando. Publicar no
            # espera a nada de esto.
            for row in (
                await db.scalars(
                    select(PostMedia).where(PostMedia.post_id == post.id)
                )
            ).all():
                if row.media_type not in ("image", "video"):
                    continue
                if row.id in ids_s3:
                    if _mp.procesado_s3_configurado():
                        background.add_task(process_media, row.id)
                elif processing_configured():
                    background.add_task(process_media, row.id)

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del autor no encontrado.")
    # Temas, etiquetas y menciones se devuelven LEIDOS DE LA BASE y no del
    # payload: asi lo que ve quien publica es exactamente lo que quedo
    # guardado. Importa especialmente aqui, porque las tres cosas pueden salir
    # distintas de lo que se pidio —las etiquetas se extraen del texto y se
    # cortan en diez, y una mencion bloqueada no se guarda— y ensenar la lista
    # pedida seria decirle a alguien que etiqueto a una persona a la que no.
    temas, etiquetas, personas = await _etiquetas_del_lote(db, [post.id])
    return _to_post_read(
        post,
        profile,
        0,
        0,
        0,
        0,
        media=media,
        topic_ids=temas.get(post.id, []),
        hashtags=etiquetas.get(post.id, []),
        mentions=personas.get(post.id, []),
    )


async def _load_single_post(
    db: AsyncSession, post_id: str, uid: str | None
) -> PostRead:
    """Una publicacion con autor, contadores y estado propio."""
    likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(uid)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.id == post_id, Post.status != "deleted")
    )
    # Con el predicado, lo que no se puede ver es un 404 limpio, igual que lo
    # que no existe: tambien para una app vieja que abre desde un enlace o un
    # aviso una publicacion con video en S3 (spec §7, «Compatibilidad»).
    stmt = await visibilidad.aplicar(stmt, db, uid)
    row = (await db.execute(stmt)).first()
    if row is None:
        raise NotFoundError("Publicacion no encontrada.")
    media_map = await _load_media_map(db, [row[0].id], uid)
    temas, etiquetas, personas = await _etiquetas_del_lote(db, [row[0].id])
    lectura = _to_post_read(
        *row,
        media=media_map.get(row[0].id, []),
        topic_ids=temas.get(row[0].id, []),
        hashtags=etiquetas.get(row[0].id, []),
        mentions=personas.get(row[0].id, []),
    )
    # El detalle ensena la misma fila de acciones que el muro: sin esto, abrir
    # una publicacion desde el muro haria desaparecer el numero de guardados.
    await anotar_guardados(db, [lectura])
    return lectura


async def leer_posts_por_id(
    db: AsyncSession, post_ids: list[str], viewer_id: str | None
) -> list[PostRead]:
    """Publicaciones concretas, EN EL ORDEN PEDIDO.

    La escribe este modulo porque `PostRead` es suyo: es aqui donde se sabe
    como se arma una publicacion con su autor, sus medios y sus contadores.
    La usa el recomendador, que decide el ORDEN pero no tiene por que saber
    montar una tarjeta de feed —ni volver a escribir esas cuatro consultas.

    El orden lo impone quien llama. Una consulta `IN (...)` devuelve las filas
    en el orden que le conviene al motor, asi que reordenar aqui es lo unico
    que impide que el trabajo del ranker se pierda en el ultimo paso.
    """
    if not post_ids:
        return []
    likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(viewer_id)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.id.in_(post_ids), Post.status == "published")
    )
    stmt = await visibilidad.aplicar(stmt, db, viewer_id)
    filas = (await db.execute(stmt)).all()
    ids_cargados = [fila[0].id for fila in filas]
    media_map = await _load_media_map(db, ids_cargados, viewer_id)
    temas, etiquetas, personas = await _etiquetas_del_lote(db, ids_cargados)
    por_id = {
        fila[0].id: _to_post_read(
            *fila,
            media=media_map.get(fila[0].id, []),
            topic_ids=temas.get(fila[0].id, []),
            hashtags=etiquetas.get(fila[0].id, []),
            mentions=personas.get(fila[0].id, []),
        )
        for fila in filas
    }
    salida = [por_id[pid] for pid in post_ids if pid in por_id]
    await anotar_guardados(db, salida)
    return salida


@router.get("/posts/{post_id}", response_model=PostRead)
async def get_post(
    post_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> PostRead:
    ensure_uuid(post_id, "Publicacion no encontrada.")
    return await _load_single_post(
        db, post_id, current_user.id if current_user else None
    )


@router.patch("/posts/{post_id}", response_model=PostRead)
async def update_post(
    post_id: str,
    payload: PostUpdate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostRead:
    """Edita una publicacion propia (texto y/o adjunto).

    Solo el autor: un moderador puede retirar contenido, pero no reescribir lo
    que otra persona dijo.
    """
    ensure_uuid(post_id, "Publicacion no encontrada.")
    post = await _get_active_post(db, post_id)
    if post.author_id != current_user.id:
        raise ForbiddenError("No puedes editar esta publicacion.")

    if payload.body is not None:
        post.body = payload.body
    if payload.visibility is not None:
        post.visibility = payload.visibility
    if payload.category is not None:
        post.category = payload.category

    # `topic_ids` ausente deja los temas como estaban; presente los REEMPLAZA
    # (una lista vacia equivale a quitarlos todos). Solo los de ESTA
    # publicacion: el borrado va acotado por `post_id`.
    if payload.topic_ids is not None:
        await temas_de_contenido.fijar(
            db, post_id, payload.topic_ids, autor_id=current_user.id
        )

    # Las etiquetas se vuelven a extraer SOLO si cambio el texto, porque el
    # texto es su unica fuente. Si no cambio, no hay nada que recalcular y
    # rehacerlo seria borrar y reescribir las mismas filas.
    #
    # Y se recalculan SIEMPRE que cambie: editar para quitar una almohadilla
    # tiene que quitar la etiqueta, o la publicacion seguiria apareciendo en una
    # busqueda por una palabra que ya no dice.
    if payload.body is not None:
        await hashtags.fijar(db, post_id, post.body)

    # `mentioned_user_ids` ausente deja las menciones como estaban; presente las
    # REEMPLAZA (vacio = desetiquetar a todo el mundo).
    #
    # AQUI ESTA LO FACIL DE HACER MAL: se avisa solo a quien NO ESTABA ANTES.
    # `fijar` lee las anteriores antes de borrarlas y devuelve la diferencia, asi
    # que corregir una falta de ortografia en una publicacion con cinco personas
    # etiquetadas no vuelve a hacer sonar cinco telefonos.
    nuevas_menciones: list[str] = []
    if payload.mentioned_user_ids is not None:
        nuevas_menciones = await menciones.fijar(
            db, post_id, current_user.id, payload.mentioned_user_ids
        )
        # Igual que al crear: solo suena el telefono de quien estrena aviso.
        avisados: list[str] = []
        for mencionado in nuevas_menciones:
            if await add_notification(
                db,
                user_id=mencionado,
                actor_id=current_user.id,
                type="post_mention",
                entity_type="post",
                entity_id=post_id,
            ):
                avisados.append(mencionado)
        nuevas_menciones = avisados

    # `media` ausente deja el adjunto como estaba; presente lo reemplaza (una
    # lista vacia equivale a quitarlo).
    #
    # VIDEOS EN S3 (spec §5, «Publicar y editar»). Un video `s3` que la app
    # reenvia con su clave (`storage_path`) se CONSERVA tal cual: su fila no se
    # borra ni se recrea, y la API no acepta ninguna otra clave de S3 del
    # cliente. Uno nuevo llega con `id_de_subida`. El que sale se mueve a
    # `borrados/` e invalida CloudFront, y el nuevo se procesa.
    retirados_s3: list[PostMedia] = []
    nuevos_s3: list[str] = []
    adoptados: dict[int, medios_publicacion.Adoptado] = {}
    if payload.media is not None:
        existentes = (
            await db.scalars(select(PostMedia).where(PostMedia.post_id == post_id))
        ).all()
        en_s3 = await medios_publicacion.ids_en_s3(db, [m.id for m in existentes])
        s3_por_clave = {m.storage_path: m for m in existentes if m.id in en_s3}
        conservados: dict[int, PostMedia] = {}
        for index, item in enumerate(payload.media):
            if item.id_de_subida:
                adoptados[index] = await medios_publicacion.adoptar(
                    db, current_user.id, item.id_de_subida, item.id_de_subida_poster
                )
            elif (
                item.storage_path in s3_por_clave
                and s3_por_clave[item.storage_path] not in conservados.values()
            ):
                conservados[index] = s3_por_clave[item.storage_path]
            else:
                _exigir_ruta_de_supabase(item.storage_path)
                _exigir_ruta_de_supabase(item.poster_path)
        ids_conservados = [m.id for m in conservados.values()]
        retirados_s3 = [
            m for m in existentes if m.id in en_s3 and m.id not in ids_conservados
        ]
        borrar = delete(PostMedia).where(PostMedia.post_id == post_id)
        if ids_conservados:
            borrar = borrar.where(PostMedia.id.not_in(ids_conservados))
        await db.execute(borrar)
        for index, item in enumerate(payload.media):
            if index in conservados:
                conservados[index].sort_order = index
                continue
            adoptado = adoptados.get(index)
            fila = PostMedia(
                post_id=post_id,
                storage_path=adoptado.storage_path if adoptado else item.storage_path,
                media_type=item.media_type,
                sort_order=index,
                width=item.width,
                height=item.height,
                duration_s=item.duration_s,
                bytes=(item.bytes or adoptado.bytes) if adoptado else item.bytes,
                poster_path=adoptado.poster_path if adoptado else item.poster_path,
            )
            if adoptado:
                fila.id = adoptado.media_id
                nuevos_s3.append(adoptado.media_id)
            db.add(fila)
        if nuevos_s3:
            await db.flush()
            for media_id in nuevos_s3:
                await medios_publicacion.marcar_s3(db, media_id)

    await db.commit()

    # Las pendientes adoptadas, solo ahora que la edicion quedo guardada: si el
    # commit hubiera fallado, el reintento las encontraria intactas.
    if payload.media is not None:
        for adoptado in adoptados.values():
            background.add_task(medios_publicacion.borrar_pendientes, adoptado.pendientes)

    # Lo que sale de S3, despues del commit: el predicado ya no lo firma y la
    # carpeta se mueve fuera del comodin de las firmas.
    for medio in retirados_s3:
        background.add_task(
            medios_publicacion.retirar, post.author_id, medio.id, post_id
        )
    # Hoy PATCH no reprocesaba; para un video nuevo de S3, si (spec §5).
    if nuevos_s3 and _mp.procesado_s3_configurado():
        for media_id in nuevos_s3:
            background.add_task(process_media, media_id)

    # DESPUES del commit, como en el resto del modulo: si la transaccion
    # fallara, no puede haberse avisado ya de algo que no llego a ocurrir.
    if nuevas_menciones:
        actor = await _nombre_del_actor(db, current_user.id)
        encolar_push(
            background,
            user_ids=nuevas_menciones,
            notification_type="post_mention",
            actor_name=actor,
            data={"type": "post_mention", "postId": post_id},
        )

    return await _load_single_post(db, post_id, current_user.id)


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_post(
    post_id: str,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    post = await _get_active_post(db, post_id)
    # El rol de la app esta en profiles.role, no en el JWT: alli `role` vale
    # siempre "authenticated", asi que esta comprobacion nunca se cumplia y un
    # moderador no podia retirar la publicacion de otra persona.
    if post.author_id != current_user.id and not await is_admin_user(db, current_user.id):
        raise ForbiddenError("No puedes eliminar esta publicacion.")
    post.status = "deleted"  # soft delete
    medios_ids = list(
        (await db.scalars(select(PostMedia.id).where(PostMedia.post_id == post_id))).all()
    )
    en_s3 = await medios_publicacion.ids_en_s3(db, medios_ids)
    await db.commit()
    # VIDEOS EN S3 (spec §9). El predicado ya excluye `deleted`, asi que la API
    # dejo de firmar al instante. Ademas la carpeta se MUEVE a `borrados/`:
    # invalidar no basta, porque con una URL firmada todavia vigente CloudFront
    # volveria a traer el objeto de S3. Se borra de verdad a los 30 dias
    # (limpieza diaria), salvo denuncia abierta.
    for media_id in en_s3:
        background.add_task(medios_publicacion.retirar, post.author_id, media_id, post_id)


# --------------------------------------------------------------------------- #
# HLS: playlists con segmentos firmados
# --------------------------------------------------------------------------- #
_PLAYLIST_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,40}\.m3u8$")
#: Lineas de una playlist que apuntan a un archivo de segmento.
_SEGMENT_LINE = re.compile(r"^[^#].*\.(ts|m4s|mp4)$")


@router.get("/media/{media_id}/hls/{playlist}")
async def media_hls_playlist(
    media_id: str,
    playlist: str,
    # Token corto de la API, solo para videos en S3 (ver `_hls_de_s3`).
    t: str | None = Query(default=None, max_length=200),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Sirve una playlist HLS del empaquetado de un video.

    El bucket es privado y una playlist guarda referencias RELATIVAS a sus
    segmentos: servida tal cual desde una URL firmada, el reproductor pediria
    los segmentos sin firma y recibiria un 400 por cada uno. Este endpoint
    descarga la playlist y reescribe cada segmento como URL firmada (en un
    solo lote); las referencias a otras playlists (master → renditions) se
    dejan relativas, porque resuelven contra esta misma ruta.

    Es publico a proposito: los videos del muro ya se pueden ver sin cuenta
    (migracion 0018) y el reproductor nativo no envia cabeceras de sesion al
    pedir playlists.
    """
    ensure_uuid(media_id, "Medio no encontrado.")
    if not _PLAYLIST_NAME.match(playlist):
        raise NotFoundError("Playlist no encontrada.")
    media = await db.get(PostMedia, media_id)
    if media is None or not media.stream_path:
        raise NotFoundError("Este video no tiene streaming.")
    if await medios_publicacion.ids_en_s3(db, [media.id]):
        return await _hls_de_s3(db, media, playlist, t)
    if not _mp.processing_configured():
        raise NotFoundError("Streaming no configurado en este servidor.")

    # El cliente del proceso (`shared/cliente_http.py`): cada video que
    # arranca pide esta playlist, y abrir un cliente por peticion costaba un
    # contexto TLS nuevo con el bucle parado y dos saludos TLS a Storage.
    async with cliente_http(30.0) as client:
        firmada = await _mp._signed_url(client, f"{media.stream_path}/{playlist}")
        respuesta = await client.get(firmada)
        if respuesta.status_code != 200:
            raise NotFoundError("Playlist no encontrada.")
        lineas = respuesta.text.splitlines()

        segmentos = [l.strip() for l in lineas if _SEGMENT_LINE.match(l.strip())]
        firmas: dict[str, str] = {}
        if segmentos:
            base = get_settings().supabase_url
            r = await client.post(
                f"{base}/storage/v1/object/sign/{_mp.BUCKET}",
                headers=_mp._headers(),
                json={
                    "paths": [f"{media.stream_path}/{s}" for s in segmentos],
                    "expiresIn": 3600,
                },
            )
            r.raise_for_status()
            for item in r.json():
                if item.get("path") and item.get("signedURL"):
                    firmas[item["path"].rsplit("/", 1)[-1]] = (
                        f"{base}/storage/v1{item['signedURL']}"
                    )

    cuerpo = "\n".join(
        firmas.get(linea.strip(), linea) for linea in lineas
    )
    return Response(
        content=cuerpo,
        media_type="application/vnd.apple.mpegurl",
        # Corta pero cacheable: las firmas duran una hora; la playlist puede
        # reutilizarse unos minutos sin volver a firmar nada.
        headers={"Cache-Control": "public, max-age=300"},
    )


#: `URI="..."` dentro de una etiqueta (`#EXT-X-MAP`, `#EXT-X-MEDIA`...).
_URI_ATTR = re.compile(r'URI="([^"]+)"')


def reescribir_lista_hls(
    texto: str, *, token: str, carpeta_hls: str, query_cloudfront: str
) -> str:
    """Reescribe una lista HLS de S3 (master o variante) — spec §7, A1.

    - Las referencias a OTRA lista (`360p.m3u8`) vuelven a pasar por la API con
      el mismo token: quedan RELATIVAS a esta misma ruta, asi que resuelven
      contra `/media/<id>/hls/` sin saber el dominio de la API.
    - Cada segmento (y cada `URI=` de una etiqueta) pasa a una URL ABSOLUTA de
      CloudFront con la query de la politica con comodin: todos llegan
      firmados, y ningun pedido de segmento toca la API.
    """

    def _absoluta(nombre: str) -> str:
        if nombre.startswith(("http://", "https://")) or "/" in nombre:
            # La disposicion es plana: algo con carpetas no es nuestro.
            return nombre
        if nombre.endswith(".m3u8"):
            return f"{nombre}?t={token}"
        return medios_firma.url_firmada(f"{carpeta_hls}/{nombre}", query_cloudfront)

    salida = []
    for linea in texto.splitlines():
        limpia = linea.strip()
        if not limpia:
            salida.append(linea)
        elif limpia.startswith("#"):
            salida.append(_URI_ATTR.sub(lambda m: f'URI="{_absoluta(m.group(1))}"', linea))
        else:
            salida.append(_absoluta(limpia))
    return "\n".join(salida) + "\n"


async def _hls_de_s3(
    db: AsyncSession, media: PostMedia, playlist: str, token: str | None
) -> Response:
    """HLS de un video en S3: token de la API + predicado EN CADA PEDIDO (N2).

    El reproductor nativo no manda la sesion. Por eso la visibilidad se decide
    al emitir el token (con el mismo predicado que el muro) y se VUELVE a
    comprobar aqui en cada lista, para la persona a la que se emitio: un
    borrado o un bloqueo cortan el acceso al instante. La firma de CloudFront
    que se pone nunca vence despues que el token.
    """
    if not medios_banderas.lectura_activa():
        raise NotFoundError("Este video no tiene streaming.")
    valido = medios_firma.validar_token_hls(media.id, token)
    if valido is None:
        raise NotFoundError("Este video no tiene streaming.")
    vence_token, quien = valido
    if not await visibilidad.puede_ver_publicacion(db, media.post_id, quien):
        raise NotFoundError("Este video no tiene streaming.")
    carpeta = medios_firma.carpeta_de_clave(media.stream_path or "")
    if carpeta is None:
        raise NotFoundError("Este video no tiene streaming.")
    vence = min(vence_token, medios_firma.vencimiento_de_ventana())
    query = medios_firma.query_de_carpeta(carpeta, vence)
    if query is None:
        raise NotFoundError("Streaming no configurado en este servidor.")

    from app.modules.medios.almacen import S3Storage

    try:
        crudo = await S3Storage().descargar(f"{media.stream_path}/{playlist}")
    except Exception as error:  # noqa: BLE001
        from app.modules.medios.almacen import es_no_existe

        if es_no_existe(error):
            raise NotFoundError("Playlist no encontrada.") from None
        raise
    cuerpo = reescribir_lista_hls(
        crudo.decode("utf-8", "replace"),
        token=token or "",
        carpeta_hls=media.stream_path or "",
        query_cloudfront=query,
    )
    return Response(
        content=cuerpo,
        media_type="application/vnd.apple.mpegurl",
        # PRIVADA y corta: la lista lleva firmas, y el predicado se revisa en
        # cada pedido. Una cache compartida se saltaria esa revision.
        headers={"Cache-Control": "private, max-age=60"},
    )


# --------------------------------------------------------------------------- #
# Likes
# --------------------------------------------------------------------------- #
@router.post("/posts/{post_id}/like")
async def like_post(
    post_id: str,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    post = await _get_active_post(db, post_id)
    existing = await db.get(PostLike, {"post_id": post_id, "user_id": current_user.id})
    if existing is None:
        db.add(PostLike(post_id=post_id, user_id=current_user.id))
        # Quitar y volver a poner el «me gusta» dejaba DOS filas en la bandeja:
        # `post_likes` se borra al retirarlo, asi que este `if` volvia a decir
        # que era la primera vez. Ahora el aviso es idempotente por (persona,
        # publicacion) y solo se manda push si de verdad se ha estrenado.
        estrenado = await add_notification(
            db,
            user_id=post.author_id,
            actor_id=current_user.id,
            type="like",
            entity_type="post",
            entity_id=post_id,
        )
        await db.commit()
        # El push va DESPUES del commit: si la transaccion fallara, no puede
        # haberse avisado ya de algo que no llego a ocurrir.
        #
        # El nombre sale del PERFIL, no del token; el porque completo esta en
        # `_nombre_del_actor`. Se usa el helper y no `db.get(Profile, ...)`
        # porque aqui no hace falta la fila entera: solo el nombre. Y que sea
        # el mismo helper que en los avisos de mencion evita que este sitio
        # vuelva a divergir, que es justo como empezo el fallo.
        if estrenado:
            actor = await _nombre_del_actor(db, current_user.id)
            encolar_push(
                background,
                user_ids=[post.author_id],
                notification_type="like",
                actor_name=actor,
                data={"type": "like", "postId": post_id},
            )
    return {"liked": True, "likes_count": await _likes_count(db, post_id)}


@router.delete("/posts/{post_id}/like")
async def unlike_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    await db.execute(
        delete(PostLike).where(
            PostLike.post_id == post_id, PostLike.user_id == current_user.id
        )
    )
    await db.commit()
    return {"liked": False, "likes_count": await _likes_count(db, post_id)}


@router.get("/posts/{post_id}/likes", response_model=list[ProfileSummary])
async def list_post_likes(
    post_id: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    """Quién reaccionó a una publicación, de lo más reciente a lo más antiguo.

    POR QUE EXISTE. No había forma de saberlo: `post_likes` solo se consultaba
    para contar y para responder «¿le gusta a quien pregunta?». Sin esto, la
    notificación agrupada («Edson y 99 personas más») no lleva a ningún sitio,
    porque no hay ninguna lista que abrir.

    PIDE SESION a proposito, aunque el muro se pueda leer sin cuenta. Una lista
    de seguidores dice a quién sigue alguien; esta dice qué le ha gustado, que
    es una señal de comportamiento y no una relación que se declara en público.
    Es el mismo criterio que `oferta_de_un_perfil` en recomendaciones: dentro de
    Z es visible, descargable por cualquiera con la dirección no.

    Devuelve `ProfileSummary` —la misma forma que seguidores y seguidos— para
    que la pantalla reutilice la lista de personas que ya existe en vez de
    inventarse otra.
    """
    ensure_uuid(post_id, "Publicacion no encontrada.")
    # Que la publicacion exista y sea visible se comprueba igual que en el resto
    # del modulo: asi una publicacion retirada no filtra quien reacciono.
    await _get_active_post(db, post_id)

    # Alias tipado, no `literal_column`: el porque esta en `_people` del grafo
    # social —comparar un uuid contra texto revienta en PostgreSQL—.
    seguido = aliased(Follow)
    is_following_sq = (
        select(func.count())
        .select_from(seguido)
        .where(
            seguido.follower_id == current_user.id,
            seguido.following_id == Profile.id,
        )
        .scalar_subquery()
    )

    filas = (
        await db.execute(
            select(Profile, is_following_sq)
            .join(PostLike, PostLike.user_id == Profile.id)
            .where(PostLike.post_id == post_id)
            # Por fecha de reaccion y no por nombre: quien acaba de reaccionar
            # es lo que se espera ver arriba al abrir la lista desde un aviso.
            .order_by(PostLike.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return [
        ProfileSummary(
            id=perfil.id,
            full_name=perfil.full_name,
            username=perfil.username,
            avatar_path=perfil.avatar_path,
            bio=perfil.bio,
            is_following=bool(sigue),
        )
        for perfil, sigue in filas
    ]


# --------------------------------------------------------------------------- #
# Guardados
# --------------------------------------------------------------------------- #
#
# LA RUTA ES `/saved-posts` Y NO `/posts/saved` PORQUE `/posts/{post_id}` YA
# EXISTE: FastAPI resuelve por orden de registro y "saved" acabaria entrando
# como identificador de publicacion en cuanto alguien moviera una funcion de
# sitio. Una ruta que no se puede romper reordenando el fichero vale mas que
# una ruta bonita.


@router.get("/saved-posts", response_model=list[PostRead])
async def list_saved_posts(
    page: Page = Depends(pagination_params),
    media: str | None = Query(default=None, pattern="^(image|video|audio)$"),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostRead]:
    """Lo que ha guardado QUIEN PREGUNTA. Nunca lo de otra persona.

    POR QUE EXISTE. El movil resolvia los guardados filtrando una lista de ids
    del telefono contra el muro que hubiera en memoria: se vaciaba al
    reinstalar, no se compartia entre dispositivos y podia seguir ensenando
    algo ya retirado. Guardar es un hecho del servidor, igual que ya se
    corrigio con los cursos.

    Devuelve lo mismo que el muro (`PostRead`) a proposito: la pantalla pinta
    las publicaciones con la misma tarjeta, y una forma resumida obligaria a
    pedir cada publicacion otra vez para tener el medio y los contadores.

    `media` separa los audios guardados del resto, que es lo que necesita la
    biblioteca. Se filtra aqui y no en el cliente por lo mismo que en el muro:
    descartar despues de recibir descuadra la paginacion.
    """
    uid = current_user.id
    likes_sq, comments_sq, liked_sq, _ = _feed_columns(uid)
    # Alias para el JOIN, y `literal(True)` en vez del `saved_by_me` de
    # `_feed_columns`: esa columna es un EXISTS sobre la MISMA tabla que aqui se
    # une, asi que SQLAlchemy la autocorrelaciona y la subconsulta se queda sin
    # FROM. Ademas seria trabajo tirado: todo lo que sale de esta lista esta
    # guardado por definicion.
    guardado = aliased(SavedPost)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, literal(True))
        .join(Profile, Profile.id == Post.author_id)
        .join(guardado, guardado.post_id == Post.id)
        # `status == published` no es un detalle: sin esto, una publicacion
        # retirada seguiria en los guardados de todo el que la marco.
        .where(guardado.user_id == uid, Post.status == "published")
        # Por cuando SE GUARDO, no por cuando se publico: lo ultimo que aparto
        # esta persona es lo que espera ver arriba.
        .order_by(guardado.created_at.desc(), Post.id.desc())
        .limit(page.limit)
        # Offset y no cursor, al reves que en los comentarios: esta lista solo
        # la mueve su dueno, y con una sola persona anadiendo no hay pagina que
        # se descuadre por debajo.
        .offset(page.offset)
    )
    # Bloquear tiene que servir de algo tambien aqui: lo guardado antes de
    # bloquear a alguien no puede seguir apareciendo.
    stmt = stmt.where(Post.author_id.not_in(blocked_either_way(uid)))
    if media:
        with_media = select(PostMedia.post_id).where(PostMedia.media_type == media)
        stmt = stmt.where(Post.id.in_(with_media))
    # Guardar algo no da derecho a verlo despues: si dejo de ser visible para
    # quien lo guardo, deja de salir aqui (spec §7).
    stmt = await visibilidad.aplicar(stmt, db, uid)

    rows = (await db.execute(stmt)).all()
    ids = [row[0].id for row in rows]
    media_map = await _load_media_map(db, ids, uid)
    temas, etiquetas, personas = await _etiquetas_del_lote(db, ids)
    salida = [
        _to_post_read(
            *row,
            media=media_map.get(row[0].id, []),
            topic_ids=temas.get(row[0].id, []),
            hashtags=etiquetas.get(row[0].id, []),
            mentions=personas.get(row[0].id, []),
        )
        for row in rows
    ]
    # El numero TOTAL de veces que se guardo cada una, no «cuantas he guardado
    # yo»: en esta lista lo segundo seria siempre uno.
    await anotar_guardados(db, salida)
    return salida


@router.post("/posts/{post_id}/save")
async def save_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    await _get_active_post(db, post_id)
    existing = await db.get(SavedPost, {"post_id": post_id, "user_id": current_user.id})
    if existing is None:
        db.add(SavedPost(post_id=post_id, user_id=current_user.id))
        await db.commit()
    return {"saved": True}


@router.delete("/posts/{post_id}/save")
async def unsave_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    await db.execute(
        delete(SavedPost).where(
            SavedPost.post_id == post_id, SavedPost.user_id == current_user.id
        )
    )
    await db.commit()
    return {"saved": False}


# --------------------------------------------------------------------------- #
# Comentarios
# --------------------------------------------------------------------------- #
def _to_comment_read(
    comment: Comment,
    profile: Profile,
    *,
    likes_count: int = 0,
    viewer_reacted: bool = False,
) -> CommentRead:
    return CommentRead(
        id=comment.id,
        post_id=comment.post_id,
        author=_author(profile),
        parent_id=comment.parent_id,
        body=comment.body,
        created_at=comment.created_at,
        likes_count=likes_count,
        viewer_reacted=viewer_reacted,
    )


async def _reacciones_de_comentarios(
    db: AsyncSession, ids: list[str], viewer_id: str | None
) -> tuple[dict[str, int], set[str]]:
    """Cuantas reacciones tiene cada comentario, y cuales reacciono quien mira.

    DOS CONSULTAS PARA LA PAGINA ENTERA, no dos por comentario. Con veinte
    comentarios por pagina, resolverlo fila a fila serian cuarenta viajes a la
    base para pintar una lista.

    Sin la migracion 0048 no hay tabla: se devuelve vacio y cada comentario sale
    con 0 y sin corazon, que es exactamente como se pintaba antes de esto.
    """
    if not ids or not await esquema_recomendaciones.hay_reacciones_a_comentarios(db):
        return {}, set()

    filas = (
        await db.execute(
            select(CommentLike.comment_id, func.count())
            .where(CommentLike.comment_id.in_(ids))
            .group_by(CommentLike.comment_id)
        )
    ).all()
    contadores = {comment_id: total for comment_id, total in filas}

    if viewer_id is None:
        return contadores, set()
    mias = set(
        (
            await db.scalars(
                select(CommentLike.comment_id).where(
                    CommentLike.comment_id.in_(ids), CommentLike.user_id == viewer_id
                )
            )
        ).all()
    )
    return contadores, mias


@router.get("/posts/{post_id}/comments", response_model=list[CommentRead])
async def list_comments(
    post_id: str,
    page: Page = Depends(pagination_params),
    # Cursor (keyset): "lo comentado ANTES de este punto", igual que en el feed.
    before_created_at: str | None = Query(default=None),
    before_id: str | None = Query(default=None),
    # Opcional a proposito: leer no pide cuenta. Solo sirve para saber a cuales
    # reacciono quien mira; sin sesion, ninguno sale marcado.
    viewer: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[CommentRead]:
    """Comentarios de una publicacion, del mas reciente al mas antiguo.

    LECTURA PUBLICA a proposito: leer no pide cuenta, escribir si. No se toca.

    POR QUE DEL MAS RECIENTE AL MAS ANTIGUO. Antes se ordenaba de antiguo a
    nuevo y se recortaba con `limit`, asi que en una publicacion con 100
    comentarios el movil recibia los 20 PRIMEROS y los recientes eran
    inalcanzables: no habia forma de llegar al final sin pedir las cinco
    paginas. Quien abre los comentarios quiere lo ultimo, asi que lo ultimo es
    lo que cabe en la primera pagina.

    Y POR QUE CURSOR Y NO OFFSET. Aqui entran comentarios MIENTRAS se lee. Con
    offset, un comentario nuevo empuja la lista y la pagina siguiente repite el
    que ya se vio; el cursor apunta a una fila concreta, asi que lo que llega
    despues no descuadra nada. `offset` se conserva como respaldo para un movil
    anterior a este cambio, que no manda cursor.
    """
    ensure_uuid(post_id, "Publicacion no encontrada.")
    stmt = (
        select(Comment, Profile)
        .join(Profile, Profile.id == Comment.author_id)
        .where(Comment.post_id == post_id, Comment.status == "published")
        # Desempate por id: dos comentarios pueden compartir instante y sin un
        # orden total el cursor podria saltarse uno o repetirlo.
        .order_by(Comment.created_at.desc(), Comment.id.desc())
        .limit(page.limit)
    )
    if before_created_at:
        try:
            cursor_at = datetime.fromisoformat(before_created_at.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationAppError("Cursor de paginacion no valido.")
        if before_id:
            ensure_uuid(before_id, "Cursor de paginacion no valido.")
            stmt = stmt.where(
                (Comment.created_at < cursor_at)
                | ((Comment.created_at == cursor_at) & (Comment.id < before_id))
            )
        else:
            stmt = stmt.where(Comment.created_at < cursor_at)
    else:
        stmt = stmt.offset(page.offset)
    rows = (await db.execute(stmt)).all()
    contadores, mias = await _reacciones_de_comentarios(
        db, [comment.id for comment, _ in rows], viewer.id if viewer else None
    )
    return [
        _to_comment_read(
            comment,
            profile,
            likes_count=contadores.get(comment.id, 0),
            viewer_reacted=comment.id in mias,
        )
        for comment, profile in rows
    ]


@router.post(
    "/posts/{post_id}/comments",
    response_model=CommentRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    post_id: str,
    payload: CommentCreate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CommentRead:
    ensure_uuid(post_id, "Publicacion no encontrada.")
    post = await _get_active_post(db, post_id)

    # ----------------------------------------------------------------------- #
    # A que se responde
    # ----------------------------------------------------------------------- #
    #
    # `parent_id` llegaba del cliente y se guardaba SIN mirar: se podia colgar
    # una respuesta de un comentario de otra publicacion, o de un id que no
    # existe. Lo primero mezcla hilos entre publicaciones; lo segundo deja una
    # fila que ninguna pantalla sabe pintar.
    parent_id: str | None = None
    autor_del_padre: str | None = None
    if payload.parent_id:
        ensure_uuid(payload.parent_id, "Comentario no encontrado.")
        padre = await db.get(Comment, payload.parent_id)
        if padre is None or padre.post_id != post_id or padre.status != "published":
            raise NotFoundError("Comentario no encontrado.")
        # UN SOLO NIVEL. Responder a una respuesta cuelga del mismo raiz. Sin
        # este tope, un hilo largo acaba sangrado hasta una columna de dos
        # caracteres, y cada pantalla tendria que decidir su propio limite.
        parent_id = padre.parent_id or padre.id
        autor_del_padre = padre.author_id

    comment = Comment(
        post_id=post_id,
        author_id=current_user.id,
        parent_id=parent_id,
        body=payload.body,
    )
    db.add(comment)

    # ----------------------------------------------------------------------- #
    # A quien se avisa
    # ----------------------------------------------------------------------- #
    #
    # Un comentario NO se deduplica: dos comentarios de la misma persona en la
    # misma publicacion son dos cosas distintas que han pasado. Ver
    # `TIPOS_IDEMPOTENTES` en `notifications/service.py`.
    #
    # `add_notification` ya se calla si el actor es el destinatario, y devuelve
    # si escribio algo. Se mira ese resultado: un aviso que no se escribio no
    # puede hacer sonar un telefono.
    avisado_al_padre = False
    if autor_del_padre is not None:
        avisado_al_padre = await add_notification(
            db,
            user_id=autor_del_padre,
            actor_id=current_user.id,
            type="comment_reply",
            entity_type="post",
            entity_id=post_id,
        )
    # Al autor de la publicacion, SALVO que sea el mismo al que ya se aviso por
    # la respuesta: seria dos filas en la bandeja por un solo comentario.
    avisado_al_autor = False
    if post.author_id != autor_del_padre:
        avisado_al_autor = await add_notification(
            db,
            user_id=post.author_id,
            actor_id=current_user.id,
            type="comment",
            entity_type="post",
            entity_id=post_id,
        )
    await db.commit()
    # Despues del commit, por el mismo motivo que en el "me gusta".
    #
    # El nombre sale del PERFIL, no del token: el porque esta en
    # `_nombre_del_actor`. Aqui, a diferencia del "me gusta", NO se llama a ese
    # helper: la respuesta ya necesita la fila entera del perfil para pintar al
    # autor del comentario, asi que se lee UNA vez y sirve para el aviso y para
    # la respuesta. Usar el helper ademas seria una consulta de mas para traer
    # un dato que ya esta en la mano.
    autor = await db.get(Profile, current_user.id)
    if avisado_al_autor:
        encolar_push(
            background,
            user_ids=[post.author_id],
            notification_type="comment",
            actor_name=nombre_visible(autor.full_name, autor.username) if autor else None,
            data={"type": "comment", "postId": post_id},
        )
    if avisado_al_padre and autor_del_padre is not None:
        encolar_push(
            background,
            user_ids=[autor_del_padre],
            notification_type="comment_reply",
            actor_name=nombre_visible(autor.full_name, autor.username) if autor else None,
            data={"type": "comment_reply", "postId": post_id},
        )
    await db.refresh(comment)

    if autor is None:
        raise NotFoundError("Perfil del autor no encontrado.")
    return _to_comment_read(comment, autor)


# --------------------------------------------------------------------------- #
# Reaccionar a un comentario  (migracion 0048)
# --------------------------------------------------------------------------- #
#
# V1: un solo tipo, «me gusta». No hay parametro de tipo porque hoy no hay nada
# que distinguir; anadirlo luego es aditivo y no pierde ni una fila.
#
# SIN LA 0048 APLICADA la tabla no existe. No se responde 500 —que en el
# navegador aparece como un error de CORS y manda a buscar donde no es— sino
# 404: la accion no esta disponible en esta base, y el movil ya sabe que un 404
# aqui significa «no insistas».


async def _comentario_activo(db: AsyncSession, comment_id: str) -> Comment:
    ensure_uuid(comment_id, "Comentario no encontrado.")
    comment = await db.get(Comment, comment_id)
    if comment is None or comment.status != "published":
        raise NotFoundError("Comentario no encontrado.")
    return comment


async def _contar_reacciones(db: AsyncSession, comment_id: str) -> int:
    total = await db.scalar(
        select(func.count()).select_from(CommentLike).where(
            CommentLike.comment_id == comment_id
        )
    )
    return int(total or 0)


@router.post("/comments/{comment_id}/like")
async def like_comment(
    comment_id: str,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Reaccionar a un comentario. Idempotente: pulsar dos veces deja una fila.

    `user_id` NUNCA llega del cliente: sale del token. Mandar el id de otro no
    sirve de nada porque aqui no se lee, y la RLS de la 0048 lo rechazaria
    igualmente.
    """
    if not await esquema_recomendaciones.hay_reacciones_a_comentarios(db):
        raise NotFoundError("Comentario no encontrado.")
    comment = await _comentario_activo(db, comment_id)

    existente = await db.get(
        CommentLike, {"comment_id": comment_id, "user_id": current_user.id}
    )
    if existente is None:
        db.add(CommentLike(comment_id=comment_id, user_id=current_user.id))
        # Idempotente por (persona, comentario), igual que el de la publicacion:
        # quitar y volver a poner el corazon no puede dejar dos filas en la
        # bandeja. `add_notification` ya se calla si el actor es el destinatario.
        estrenado = await add_notification(
            db,
            user_id=comment.author_id,
            actor_id=current_user.id,
            type="comment_like",
            # El comentario, NO la publicacion: la clave de deduplicacion se
            # construye con `entity_id`, y con el id de la publicacion dos
            # corazones a dos comentarios distintos del mismo hilo contarian
            # como el mismo aviso y el segundo no se escribiria.
            entity_type="comment",
            entity_id=comment_id,
            # A donde lleva al tocarlo. `entity_id` ya esta ocupado por la clave,
            # asi que la publicacion viaja aqui.
            payload={"postId": comment.post_id},
        )
        await db.commit()
        # Push despues del commit: si la transaccion fallara, no puede haberse
        # avisado de algo que no llego a ocurrir.
        if estrenado:
            actor = await _nombre_del_actor(db, current_user.id)
            encolar_push(
                background,
                user_ids=[comment.author_id],
                notification_type="comment_like",
                actor_name=actor,
                data={"type": "comment_like", "postId": comment.post_id},
            )
    return {
        "reacted": True,
        "likes_count": await _contar_reacciones(db, comment_id),
    }


@router.delete("/comments/{comment_id}/like")
async def unlike_comment(
    comment_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    if not await esquema_recomendaciones.hay_reacciones_a_comentarios(db):
        raise NotFoundError("Comentario no encontrado.")
    await db.execute(
        delete(CommentLike).where(
            CommentLike.comment_id == comment_id,
            CommentLike.user_id == current_user.id,
        )
    )
    await db.commit()
    return {
        "reacted": False,
        "likes_count": await _contar_reacciones(db, comment_id),
    }


# --------------------------------------------------------------------------- #
# Categorias de podcast
# --------------------------------------------------------------------------- #
#
# Cada creador organiza sus audios como quiera. Antes habia TRES categorias
# escritas en el codigo del movil ("Mente y Emociones", "Cuerpo", "Dinero"):
# servian para un podcast de una sola persona y no dicen nada del carpintero
# que quiere "Mis experiencias", "Carpinteria" e "Historias".
#
# La categoria de un audio se sigue guardando en `posts.category`, que es texto
# libre; lo que se guarda ahi es el ID de una de estas filas. Por eso las
# etiquetas antiguas siguen funcionando y no hizo falta convertir nada.


def _categoria_read(fila: PodcastCategory, episodios: int) -> PodcastCategoryRead:
    return PodcastCategoryRead(
        id=fila.id,
        owner_id=fila.owner_id,
        name=fila.name,
        position=fila.position,
        episodes_count=episodios or 0,
    )


@router.get("/podcast-categories", response_model=list[PodcastCategoryRead])
async def list_podcast_categories(
    owner_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> list[PodcastCategoryRead]:
    """Categorias de un perfil, en su orden, con cuantos audios tiene cada una.

    Publico: las categorias se ven al visitar un perfil, igual que sus
    episodios. Esconderlas dejaria la lista sin agrupar para todo el que no
    fuera su dueno.
    """
    ensure_uuid(owner_id, "Perfil no encontrado.")
    # `posts.category` es texto y el id es uuid: se compara en texto, que es
    # como esta guardado.
    episodios = (
        select(func.count())
        .select_from(Post)
        .where(
            Post.author_id == PodcastCategory.owner_id,
            Post.category == func.cast(PodcastCategory.id, SAText),
            Post.status == "published",
        )
        .scalar_subquery()
    )
    filas = (
        await db.execute(
            select(PodcastCategory, episodios)
            .where(PodcastCategory.owner_id == owner_id)
            .order_by(PodcastCategory.position, PodcastCategory.created_at)
        )
    ).all()
    return [_categoria_read(fila, n) for fila, n in filas]


@router.post(
    "/podcast-categories",
    response_model=PodcastCategoryRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_podcast_category(
    payload: PodcastCategoryCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PodcastCategoryRead:
    """Crea una categoria en el perfil de quien la pide.

    El dueno sale del token, nunca del cuerpo: si viniera del cliente,
    cualquiera podria crear categorias en el perfil de otra persona.
    """
    nombre = payload.name.strip()
    if not nombre:
        raise ValidationAppError("Ponle un nombre a la categoria.")

    # Dos categorias con el mismo nombre no son dos categorias, son un error de
    # dedo: repartirian los episodios sin motivo. Se avisa antes de insertar
    # para poder explicarlo; el indice unico de la migracion 0024 lo garantiza
    # aunque dos peticiones lleguen a la vez.
    repetida = (
        await db.execute(
            select(PodcastCategory.id).where(
                PodcastCategory.owner_id == current_user.id,
                func.lower(func.trim(PodcastCategory.name)) == nombre.lower(),
            )
        )
    ).first()
    if repetida:
        raise ValidationAppError("Ya tienes una categoria con ese nombre.")

    ultima = (
        await db.execute(
            select(func.coalesce(func.max(PodcastCategory.position), -1)).where(
                PodcastCategory.owner_id == current_user.id
            )
        )
    ).scalar_one()

    fila = PodcastCategory(
        owner_id=current_user.id, name=nombre, position=int(ultima) + 1
    )
    db.add(fila)
    await db.commit()
    await db.refresh(fila)
    return _categoria_read(fila, 0)


async def _categoria_propia(
    db: AsyncSession, categoria_id: str, user_id: str
) -> PodcastCategory:
    ensure_uuid(categoria_id, "Categoria no encontrada.")
    fila = await db.get(PodcastCategory, categoria_id)
    if fila is None:
        raise NotFoundError("Categoria no encontrada.")
    # La comprobacion de verdad esta aqui, en el servidor. Que el movil solo
    # ensene el boton en el perfil propio es comodidad, no seguridad.
    if fila.owner_id != user_id:
        raise ForbiddenError("Solo puedes cambiar tus propias categorias.")
    return fila


@router.patch("/podcast-categories/{categoria_id}", response_model=PodcastCategoryRead)
async def update_podcast_category(
    categoria_id: str,
    payload: PodcastCategoryUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PodcastCategoryRead:
    """Renombra o reordena una categoria propia.

    Renombrar NO toca los audios: `posts.category` guarda el ID, no el nombre,
    asi que cambiar el texto no puede dejar episodios sueltos.
    """
    fila = await _categoria_propia(db, categoria_id, current_user.id)

    if payload.name is not None:
        nombre = payload.name.strip()
        if not nombre:
            raise ValidationAppError("Ponle un nombre a la categoria.")
        repetida = (
            await db.execute(
                select(PodcastCategory.id).where(
                    PodcastCategory.owner_id == current_user.id,
                    PodcastCategory.id != fila.id,
                    func.lower(func.trim(PodcastCategory.name)) == nombre.lower(),
                )
            )
        ).first()
        if repetida:
            raise ValidationAppError("Ya tienes una categoria con ese nombre.")
        fila.name = nombre

    if payload.position is not None:
        fila.position = payload.position

    await db.commit()
    await db.refresh(fila)

    # El contador se vuelve a calcular: devolver 0 al renombrar dejaba una
    # categoria con doce audios anunciando que estaba vacia.
    episodios = (
        await db.execute(
            select(func.count())
            .select_from(Post)
            .where(
                Post.author_id == fila.owner_id,
                Post.category == fila.id,
                Post.status == "published",
            )
        )
    ).scalar_one()
    return _categoria_read(fila, int(episodios or 0))


@router.delete(
    "/podcast-categories/{categoria_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_podcast_category(
    categoria_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Borra una categoria SIN borrar sus audios.

    Los episodios que la tenian se quedan sin categoria y vuelven a aparecer en
    "Todos". Borrarlos con ella seria destruir contenido por reorganizar una
    estanteria, y nadie espera eso al quitar una etiqueta.
    """
    fila = await _categoria_propia(db, categoria_id, current_user.id)

    await db.execute(
        update(Post)
        .where(Post.author_id == current_user.id, Post.category == fila.id)
        .values(category=None)
    )
    await db.delete(fila)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
