"""Las consultas de la busqueda. Una por grupo, todas con el mismo esqueleto.

EL ESQUELETO, que se repite en las cinco:

  1. Una CONDICION: que filas pueden salir. Es texto (`LIKE` sobre las columnas
     que tiene sentido buscar) o tema (la fila esta etiquetada con un tema que
     la consulta activo). Se cruza con las reglas de visibilidad, que van
     SIEMPRE en la consulta y nunca despues: filtrar en memoria descuadraria la
     paginacion, exactamente igual que en el muro.
  2. Una PUNTUACION: una suma de `case` que ordena. Vive en SQL y no en Python
     porque ordenar en Python obligaria a traerse todas las filas que cumplen la
     condicion —que pueden ser miles— para quedarse con diez.
  3. Un ORDEN TOTAL: puntuacion, y despues fecha e id. El desempate por id no es
     un adorno: sin un orden total, dos filas empatadas pueden intercambiarse
     entre la pagina 1 y la pagina 2, y entonces un resultado se repite y otro
     no sale nunca.

SE PIDE UNO MAS DEL LIMITE. Es lo que permite responder «hay mas» con un hecho
en vez de con una suposicion.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import Select, and_, case, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog import cursos_v2
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.catalog import eventos as eventos_catalogo
from app.modules.catalog.models import Course, Event
from app.modules.content import hashtags as etiquetas
from app.modules.content.models import Post
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema as esquema_de_temas
from app.modules.recommendations.config import RELACIONES_DE_OFERTA
from app.modules.recommendations.models import (
    CourseTopic,
    PostTopic,
    Topic,
    UserTopicRelation,
)
from app.modules.search import normalizacion
from app.modules.search.schemas import (
    CourseHit,
    EventHit,
    HashtagHit,
    PersonHit,
    PostHit,
)
from app.modules.social_graph.models import Follow
from app.modules.social_graph.service import blocked_either_way

logger = logging.getLogger("renaser.search")

#: Cuanto suma que el termino aparezca en cada sitio. Los pesos no son verdad
#: revelada: son un punto de partida legible. Lo que si es una decision es el
#: ORDEN —el titulo pesa mas que la descripcion, el nombre mas que la
#: biografia—, porque quien busca «carpinteria» quiere antes el curso que se
#: llama asi que el que la menciona de pasada en el parrafo doce.
PESO_TITULO = 3.0
PESO_SECUNDARIO = 1.5
PESO_CUERPO = 1.0
PESO_AUTOR = 0.8

#: Cuanto suma estar etiquetado con un tema que la consulta activo.
#:
#: Por debajo de `PESO_TITULO` a proposito. Coincidir por tema es una inferencia
#: nuestra («muebles» probablemente signifique carpinteria); coincidir por
#: titulo es lo que la persona escribio, literal. Cuando las dos cosas pasan a
#: la vez, manda lo literal.
PESO_TEMA = 2.0

#: Cuanto suma que el texto empiece por lo que se escribio. Es lo que pone
#: «Ana Torres» por delante de «Juliana» cuando se busca «ana».
PESO_PREFIJO = 1.0

#: Cuanto se recorta el cuerpo de una publicacion en los resultados.
RECORTE = 240

#: Cuantos nombres de tema acompañan a cada fila. Mas de tres no caben en una
#: linea de movil y solo servirian para hacer la respuesta mas grande.
MAX_TEMAS_POR_FILA = 3


@dataclass(frozen=True)
class Consulta:
    """Lo que se ha entendido de lo que alguien escribio.

    Se calcula UNA vez por peticion y se pasa a los cinco grupos: plegar la
    frase cinco veces daria el mismo resultado cinco veces mas tarde.
    """

    texto: str
    terminos: tuple[str, ...]
    temas: tuple[str, ...]

    @property
    def hay_algo(self) -> bool:
        return bool(self.terminos or self.temas)


# --------------------------------------------------------------------------- #
# Piezas comunes
# --------------------------------------------------------------------------- #
def _coincide(columna, termino: str):
    """La columna contiene el termino, con o sin tildes. Ver `normalizacion`."""
    return or_(*[columna.ilike(patron) for patron in normalizacion.patrones(termino)])


def _texto_coincide(columnas: list, consulta: Consulta):
    """Alguna de esas columnas contiene alguno de los terminos."""
    condiciones = [
        _coincide(col, termino) for col in columnas for termino in consulta.terminos
    ]
    return or_(*condiciones) if condiciones else None


def _puntos(columna, consulta: Consulta, peso: float):
    """Cuanto suma esta columna: `peso` por cada termino que aparezca en ella.

    Se suma por TERMINO y no por patron: un termino que coincide con el patron
    exacto y tambien con el que tolera tildes ha coincidido una vez, no dos.
    """
    total = literal(0.0)
    for termino in consulta.terminos:
        total = total + case((_coincide(columna, termino), peso), else_=0.0)
    return total


def _puntos_de_prefijo(columna, consulta: Consulta):
    """Suma si la columna EMPIEZA por lo que se escribio."""
    if not consulta.texto:
        return literal(0.0)
    return case((columna.ilike(f"{consulta.texto}%"), PESO_PREFIJO), else_=0.0)


def _puntos_de_tema(columna_id, subconsulta, consulta: Consulta):
    """Suma si la fila esta etiquetada con alguno de los temas detectados."""
    if subconsulta is None or not consulta.temas:
        return literal(0.0)
    return case((columna_id.in_(subconsulta), PESO_TEMA), else_=0.0)


def _pagina(stmt: Select, limite: int, salto: int) -> Select:
    """Una fila mas del limite, para poder decir si hay pagina siguiente."""
    return stmt.limit(limite + 1).offset(salto)


def _recortar(hay_mas: list, limite: int, salto: int) -> tuple[list, int | None]:
    if len(hay_mas) > limite:
        return hay_mas[:limite], salto + limite
    return hay_mas, None


async def _hay(comprobacion, db: AsyncSession) -> bool:
    """Si una tabla opcional existe en ESTA base, sin poder tumbar la busqueda.

    Las comprobaciones son de `recommendations.esquema` y de
    `catalog.esquema` —no se duplican, que seria tener dos verdades sobre la
    misma base—, pero su fallo no se hereda: si preguntar revienta, la respuesta
    es «no esta» y se busca sin esa tabla. Se encuentra menos y se encuentra.
    """
    try:
        return await comprobacion(db)
    except Exception:  # noqa: BLE001 - degradar es el objetivo.
        logger.warning("No se pudo comprobar el esquema; se busca sin él.", exc_info=True)
        return False


async def _nombres_de_temas(
    db: AsyncSession, tabla, columna_padre, ids: list[str]
) -> dict[str, list[str]]:
    """Los nombres de los temas de varias filas, de UNA consulta."""
    if not ids:
        return {}
    try:
        filas = (
            await db.execute(
                select(columna_padre, Topic.name)
                .join(Topic, Topic.id == tabla.topic_id)
                .where(columna_padre.in_(ids))
                .order_by(Topic.position, Topic.name)
            )
        ).all()
    except Exception:  # noqa: BLE001
        logger.warning("No se pudieron leer los temas de las filas.", exc_info=True)
        return {}
    salida: dict[str, list[str]] = {}
    for padre, nombre in filas:
        actuales = salida.setdefault(padre, [])
        if len(actuales) < MAX_TEMAS_POR_FILA:
            actuales.append(nombre)
    return salida


# --------------------------------------------------------------------------- #
# Personas
# --------------------------------------------------------------------------- #
def _oferta_publica(temas: tuple[str, ...]):
    """Quien DECLARA poder aportar alguno de esos temas.

    LA LINEA MAS IMPORTANTE DE ESTE FICHERO es el filtro por
    `RELACIONES_DE_OFERTA`. Sin el, esta misma consulta encontraria a quien
    dijo que quiere APRENDER carpinteria, y buscar se convertiria en una lista
    publica de lo que cada persona no sabe y de la ayuda que necesita. Que
    alguien se ofrezca a enseñar es una declaracion hecha para que le
    encuentren; que busque orientacion sobre su familia, no.

    Es la misma regla —y la misma constante— que aplica `oferta_publica` en el
    recomendador. Se repite aqui porque el backend se conecta con su propio rol
    y no pasa por la RLS de la 0026: si esta linea no estuviera, no habria nada
    debajo que lo impidiera.
    """
    return select(UserTopicRelation.user_id).where(
        UserTopicRelation.topic_id.in_(list(temas)),
        UserTopicRelation.relation.in_(list(RELACIONES_DE_OFERTA)),
    )


async def personas(
    db: AsyncSession, consulta: Consulta, *, viewer_id: str | None, limite: int, salto: int
) -> tuple[list[PersonHit], int | None]:
    """Personas por nombre, usuario, biografia y oferta publica.

    LA CUENTA PRIVADA SOLO SE ENCUENTRA POR SU NOMBRE. Quien marca su perfil
    como privado pide no ser descubierto, no desaparecer: si alguien escribe su
    usuario es porque ya sabe que existe, y no dejar encontrarla asi romperia lo
    unico para lo que se usa un buscador entre amigos. Lo que NO puede pasar es
    que aparezca porque su biografia o los temas que ofrece encajaron con una
    busqueda: eso es descubrimiento, y es justo lo que pidio no tener.
    """
    if not consulta.hay_algo:
        return [], None

    identidad = _texto_coincide([Profile.username, Profile.full_name], consulta)
    por_biografia = _texto_coincide([Profile.bio], consulta)
    oferta = _oferta_publica(consulta.temas) if consulta.temas else None

    descubrimiento = [c for c in (por_biografia,) if c is not None]
    if oferta is not None:
        descubrimiento.append(Profile.id.in_(oferta))

    condiciones = [c for c in (identidad,) if c is not None]
    if descubrimiento:
        condiciones.append(and_(Profile.is_private.is_(False), or_(*descubrimiento)))
    if not condiciones:
        return [], None

    puntuacion = (
        _puntos(Profile.username, consulta, PESO_TITULO)
        + _puntos(Profile.full_name, consulta, PESO_TITULO)
        + _puntos(Profile.bio, consulta, PESO_CUERPO)
        + _puntos_de_prefijo(Profile.full_name, consulta)
        + _puntos_de_tema(Profile.id, oferta, consulta)
    )

    stmt = (
        select(Profile)
        .where(or_(*condiciones))
        .order_by(puntuacion.desc(), Profile.created_at.desc(), Profile.id)
    )
    if viewer_id:
        # Bloquear tiene que servir de algo tambien aqui: sin esto, buscar el
        # nombre de quien te bloqueo seria la forma mas facil de saltarselo.
        stmt = stmt.where(Profile.id.not_in(blocked_either_way(viewer_id)))

    perfiles = list((await db.scalars(_pagina(stmt, limite, salto))).all())
    perfiles, siguiente = _recortar(perfiles, limite, salto)

    ofrecidos = await _temas_ofrecidos(db, [p.id for p in perfiles])
    return [
        PersonHit(
            id=p.id,
            full_name=p.full_name,
            username=p.username,
            avatar_path=p.avatar_path,
            bio=(p.bio or "")[:RECORTE],
            offer_topics=ofrecidos.get(p.id, []),
        )
        for p in perfiles
    ], siguiente


async def _temas_ofrecidos(db: AsyncSession, ids: list[str]) -> dict[str, list[str]]:
    """Lo que cada persona declara poder aportar. SOLO eso.

    El filtro por `RELACIONES_DE_OFERTA` se repite aqui —ya estaba en la
    busqueda— porque estos nombres SALEN por la respuesta. Los dos sitios dicen
    lo mismo a proposito: uno decide a quien se encuentra, el otro que se cuenta
    de quien se encontro, y un descuido en cualquiera de los dos publicaria la
    demanda privada de alguien.
    """
    if not ids:
        return {}
    try:
        filas = (
            await db.execute(
                select(UserTopicRelation.user_id, Topic.name)
                .join(Topic, Topic.id == UserTopicRelation.topic_id)
                .where(
                    UserTopicRelation.user_id.in_(ids),
                    UserTopicRelation.relation.in_(list(RELACIONES_DE_OFERTA)),
                )
                .order_by(Topic.position, Topic.name)
            )
        ).all()
    except Exception:  # noqa: BLE001
        logger.warning("No se pudo leer la oferta publica.", exc_info=True)
        return {}
    salida: dict[str, list[str]] = {}
    for user_id, nombre in filas:
        actuales = salida.setdefault(user_id, [])
        if nombre not in actuales and len(actuales) < MAX_TEMAS_POR_FILA:
            actuales.append(nombre)
    return salida


# --------------------------------------------------------------------------- #
# Publicaciones
# --------------------------------------------------------------------------- #
def _publicaciones_que_puede_ver(viewer_id: str | None):
    """Que publicaciones tiene derecho a ver quien pregunta.

    - `public`: todo el mundo. Es lo que ya se ve en el muro sin cuenta.
    - `followers`: solo quien sigue a esa persona.
    - `circle`: NO sale en la busqueda de nadie mas que de su autor. La
      pertenencia a un circulo no se resuelve aqui, y ante la duda se deja
      fuera: dejar de encontrar algo propio es una molestia, ensenarselo a
      quien no debia es un fallo de privacidad.
    """
    publica = Post.visibility == "public"
    if not viewer_id:
        return publica
    seguidos = select(Follow.following_id).where(Follow.follower_id == viewer_id)
    return or_(
        publica,
        Post.author_id == viewer_id,
        and_(Post.visibility == "followers", Post.author_id.in_(seguidos)),
    )


async def publicaciones(
    db: AsyncSession, consulta: Consulta, *, viewer_id: str | None, limite: int, salto: int
) -> tuple[list[PostHit], int | None]:
    """Publicaciones por cuerpo, por autor, por etiqueta y por tema.

    ESTO ES LO QUE ANTES NO EXISTIA. La pantalla filtraba `state.posts`, o sea
    las veinte publicaciones que el telefono ya se habia descargado: una
    publicacion de hace tres meses no se podia encontrar de ninguna forma. Aqui
    se busca sobre la tabla, que es donde estan todas.
    """
    if not consulta.hay_algo:
        return [], None

    por_texto = _texto_coincide([Post.body], consulta)
    por_autor = _texto_coincide([Profile.full_name, Profile.username], consulta)

    temas_sq = None
    if consulta.temas and await _hay(esquema_de_temas.hay_temas_de_contenido, db):
        temas_sq = select(PostTopic.post_id).where(
            PostTopic.topic_id.in_(list(consulta.temas))
        )

    etiquetas_sq = await _etiquetas_como_publicaciones(db, consulta)

    condiciones = [c for c in (por_texto, por_autor) if c is not None]
    if temas_sq is not None:
        condiciones.append(Post.id.in_(temas_sq))
    if etiquetas_sq is not None:
        condiciones.append(Post.id.in_(etiquetas_sq))
    if not condiciones:
        return [], None

    puntuacion = (
        _puntos(Post.body, consulta, PESO_CUERPO)
        + _puntos(Profile.full_name, consulta, PESO_AUTOR)
        + _puntos_de_tema(Post.id, temas_sq, consulta)
    )

    stmt = (
        select(Post, Profile)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.status == "published")
        .where(_publicaciones_que_puede_ver(viewer_id))
        .where(or_(*condiciones))
        .order_by(puntuacion.desc(), Post.created_at.desc(), Post.id.desc())
    )
    if viewer_id:
        stmt = stmt.where(Post.author_id.not_in(blocked_either_way(viewer_id)))

    filas = list((await db.execute(_pagina(stmt, limite, salto))).all())
    filas, siguiente = _recortar(filas, limite, salto)

    ids = [post.id for post, _ in filas]
    nombres: dict[str, list[str]] = {}
    if await _hay(esquema_de_temas.hay_temas_de_contenido, db):
        nombres = await _nombres_de_temas(db, PostTopic, PostTopic.post_id, ids)
    return [
        PostHit(
            id=post.id,
            body=(post.body or "")[:RECORTE],
            author_id=autor.id,
            author_name=autor.full_name,
            author_username=autor.username,
            author_avatar_path=autor.avatar_path,
            created_at=post.created_at,
            topics=nombres.get(post.id, []),
        )
        for post, autor in filas
    ], siguiente


async def _etiquetas_como_publicaciones(db: AsyncSession, consulta: Consulta):
    """Publicaciones que llevan una etiqueta igual a alguno de los terminos.

    Buscar «carpinteria» tiene que encontrar lo etiquetado con «#carpinteria»
    aunque la palabra no este en el texto —pasa constantemente: el cuerpo dice
    «mira como quedo» y la etiqueta es la que clasifica—. Se compara por
    igualdad y no por prefijo porque aqui la etiqueta no se esta sugiriendo, se
    esta usando como filtro.
    """
    if not consulta.terminos:
        return None
    if not await _hay(esquema_de_temas.hay_hashtags, db):
        return None
    # Import local: `content.models` ya esta cargado, pero estos dos nombres
    # solo hacen falta cuando la 0031 esta aplicada.
    from app.modules.content.models import Hashtag, PostHashtag

    claves = [etiquetas.normalizar(t) for t in consulta.terminos]
    claves = [c for c in claves if c]
    if not claves:
        return None
    return (
        select(PostHashtag.post_id)
        .join(Hashtag, Hashtag.id == PostHashtag.hashtag_id)
        .where(Hashtag.tag.in_(claves))
    )


# --------------------------------------------------------------------------- #
# Etiquetas
# --------------------------------------------------------------------------- #
async def etiquetas_sociales(
    db: AsyncSession, consulta: Consulta, *, limite: int, salto: int
) -> tuple[list[HashtagHit], int | None]:
    """Etiquetas que empiezan por alguno de los terminos.

    Se reusa `content.hashtags.buscar` tal cual: ya normaliza igual que el resto
    del producto, ya cuenta solo publicaciones publicadas y ya sabe responder
    vacio sin la 0031. Reescribir esa consulta aqui habria creado una segunda
    forma de contar publicaciones por etiqueta, y el dia que las dos no
    coincidieran nadie sabria cual mentia.
    """
    if not consulta.terminos:
        return [], None
    vistas: dict[str, HashtagHit] = {}
    for termino in consulta.terminos:
        try:
            for fila in await etiquetas.buscar(db, termino, limite + salto + 1):
                vistas.setdefault(fila["tag"], HashtagHit(**fila))
        except Exception:  # noqa: BLE001
            logger.warning("No se pudieron buscar etiquetas.", exc_info=True)
            return [], None
    ordenadas = sorted(vistas.values(), key=lambda h: (-h.posts_count, h.tag))
    pagina = ordenadas[salto : salto + limite + 1]
    return _recortar(pagina, limite, salto)


# --------------------------------------------------------------------------- #
# Cursos
# --------------------------------------------------------------------------- #
async def cursos(
    db: AsyncSession, consulta: Consulta, *, viewer_id: str | None, limite: int, salto: int
) -> tuple[list[CourseHit], int | None]:
    """Cursos por titulo, subtitulo, descripcion, instructor y tema.

    SOLO LOS PUBLICADOS. Un borrador es trabajo a medias de su autor y no puede
    salir en la busqueda de nadie —tampoco en la suya: verlo aqui daria a
    entender que ya esta publicado—. Los «proximamente» SI salen: se anuncian a
    proposito para que la gente los espere.

    Antes esto se resolvia descargando el catalogo ENTERO en el telefono y
    filtrandolo con un `includes`. Con veinte cursos colaba; con doscientos es
    una descarga completa por cada busqueda, y con el catalogo paginado
    directamente deja de encontrar los que no vinieron en la primera pagina.
    """
    if not consulta.hay_algo:
        return [], None

    por_texto = _texto_coincide([Course.title, Course.description], consulta)
    por_autor = _texto_coincide([Profile.full_name, Profile.username], consulta)

    condiciones = [c for c in (por_texto, por_autor) if c is not None]

    ficha_sq = await _cursos_por_ficha(db, consulta)
    if ficha_sq is not None:
        condiciones.append(Course.id.in_(ficha_sq))

    temas_sq = None
    if consulta.temas and await _hay(esquema_de_temas.hay_temas_de_curso, db):
        temas_sq = select(CourseTopic.course_id).where(
            CourseTopic.topic_id.in_(list(consulta.temas))
        )
        condiciones.append(Course.id.in_(temas_sq))
    if not condiciones:
        return [], None

    puntuacion = (
        _puntos(Course.title, consulta, PESO_TITULO)
        + _puntos(Course.description, consulta, PESO_CUERPO)
        + _puntos(Profile.full_name, consulta, PESO_AUTOR)
        + _puntos_de_prefijo(Course.title, consulta)
        + _puntos_de_tema(Course.id, temas_sq, consulta)
    )

    stmt = (
        select(Course, Profile)
        .join(Profile, Profile.id == Course.author_id)
        .where(Course.status == "published")
        .where(or_(*condiciones))
        .order_by(puntuacion.desc(), Course.created_at.desc(), Course.id.desc())
    )
    if viewer_id:
        stmt = stmt.where(Course.author_id.not_in(blocked_either_way(viewer_id)))

    filas = list((await db.execute(_pagina(stmt, limite, salto))).all())
    filas, siguiente = _recortar(filas, limite, salto)

    ids = [curso.id for curso, _ in filas]
    fichas = await _fichas(db, ids)
    nombres: dict[str, list[str]] = {}
    if await _hay(esquema_de_temas.hay_temas_de_curso, db):
        nombres = await _nombres_de_temas(db, CourseTopic, CourseTopic.course_id, ids)
    return [
        CourseHit(
            id=curso.id,
            title=curso.title,
            subtitle=fichas.get(curso.id).subtitle if fichas.get(curso.id) else None,
            level=fichas.get(curso.id).level if fichas.get(curso.id) else None,
            cover_path=curso.cover_path,
            price_minor=curso.price_minor or 0,
            currency=curso.currency or "PEN",
            coming_soon=bool(curso.coming_soon),
            author_id=autor.id,
            author_name=autor.full_name,
            topics=nombres.get(curso.id, []),
        )
        for curso, autor in filas
    ], siguiente


async def _cursos_por_ficha(db: AsyncSession, consulta: Consulta):
    """Cursos cuyo SUBTITULO coincide, o cuyo tema principal es uno detectado.

    El subtitulo y el tema principal los añadio la 0034 y viven fuera del ORM
    compartido a proposito (ver `catalog/cursos_v2.py`). Sin esa migracion esto
    devuelve `None` y se busca por titulo y descripcion, que es exactamente lo
    que hay hoy.
    """
    if not await _hay(esquema_de_catalogo.hay_cursos_v2, db):
        return None
    condiciones = []
    por_subtitulo = _texto_coincide([cursos_v2.CURSOS.c.subtitle], consulta)
    if por_subtitulo is not None:
        condiciones.append(por_subtitulo)
    if consulta.temas:
        condiciones.append(cursos_v2.CURSOS.c.primary_topic_id.in_(list(consulta.temas)))
    if not condiciones:
        return None
    return select(cursos_v2.CURSOS.c.id).where(or_(*condiciones))


async def _fichas(db: AsyncSession, ids: list[str]) -> dict:
    try:
        return await cursos_v2.leer(db, ids)
    except Exception:  # noqa: BLE001
        logger.warning("No se pudo leer la ficha de los cursos.", exc_info=True)
        return {}


# --------------------------------------------------------------------------- #
# Eventos
# --------------------------------------------------------------------------- #
async def eventos(
    db: AsyncSession, consulta: Consulta, *, limite: int, salto: int
) -> tuple[list[EventHit], int | None]:
    """Eventos publicados, por titulo, descripcion y lugar.

    Los eventos ya estaban en la busqueda, tambien filtrando en el cliente el
    listado completo. Aqui no hay capa de temas: un evento no lleva temas en el
    esquema, asi que decir que la busqueda «inteligente» tambien los alcanza
    seria mentira.
    """
    if not consulta.terminos:
        return [], None

    condicion = _texto_coincide(
        [Event.title, Event.description, Event.location], consulta
    )
    if condicion is None:
        return [], None

    puntuacion = (
        _puntos(Event.title, consulta, PESO_TITULO)
        + _puntos(Event.description, consulta, PESO_CUERPO)
        + _puntos(Event.location, consulta, PESO_SECUNDARIO)
    )
    stmt = (
        select(Event)
        .where(Event.status == "published")
        .where(condicion)
        .order_by(puntuacion.desc(), Event.created_at.desc(), Event.id.desc())
    )
    filas = list((await db.scalars(_pagina(stmt, limite, salto))).all())
    filas, siguiente = _recortar(filas, limite, salto)
    # UNA sola lectura del reloj para todo el lote. Pidiendola dentro del bucle,
    # dos eventos de la misma respuesta podrian juzgarse con relojes distintos.
    momento = eventos_catalogo.ahora()
    return [
        EventHit(
            id=e.id,
            title=e.title,
            starts_at=e.starts_at,
            ends_at=e.ends_at,
            location=e.location,
            cover_path=e.cover_path,
            time_state=eventos_catalogo.estado_de(e, momento),
        )
        for e in filas
    ], siguiente
