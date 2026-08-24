"""Todo lo que el recomendador lee de la base de datos, y nada mas.

POR QUE EXISTE ESTE FICHERO. El resto del modulo decide REGLAS DE PRODUCTO
(quien puede aportarle valor a quien, en que orden, por que). Si esas reglas
llevaran consultas dentro serian imposibles de probar sin una base de datos, y
cualquier cambio de criterio arrastraria SQL. Aqui solo hay lecturas; ninguna
funcion de este fichero decide nada.

La otra razon es el rendimiento. Cada funcion esta escrita para responder de
UNA consulta sobre TODOS los candidatos a la vez. La forma natural de escribir
un recomendador —recorrer candidatos y preguntar por cada uno— seria una
consulta por persona: con doscientos candidatos, doscientos viajes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking
from app.modules.catalog.models import Course
from app.modules.content.models import Post, PostLike, PostMedia
from app.modules.profiles.models import Profile
from app.modules.recommendations.config import (
    MEDIA_VIDA_DE_SENAL_DIAS,
    PENALIZACION_MAXIMA_POR_TEMA,
    PENALIZACION_POR_RECHAZO,
    PESO_MINIMO_POR_ANTIGUEDAD,
)
from app.modules.recommendations.models import (
    BehaviorEvent,
    PostTopic,
    RecommendationPreference,
    Topic,
    UserTopicRelation,
)
from app.modules.social_graph.models import Follow, UserBlock


# --------------------------------------------------------------------------- #
# Estructuras de lectura
# --------------------------------------------------------------------------- #
@dataclass
class ActividadDeAutor:
    """Lo que se sabe de la actividad real de un perfil.

    No es reputacion: es EXISTENCIA. Distingue a quien esta y publica de una
    cuenta abandonada, sin pretender medir la calidad de nada.
    """

    publicaciones: int = 0
    ultima_publicacion: datetime | None = None
    #: Formatos en los que publica de verdad: video, audio, publicacion, curso.
    formatos: set[str] = field(default_factory=set)
    #: Reacciones RECIBIDAS. Se usa acotada y con poco peso: la popularidad no
    #: es experiencia (ver `ranker`).
    reacciones: int = 0
    #: Sesiones 1:1 que esta persona ya ha dado o aceptado. Es lo mas cercano a
    #: «de verdad atiende a gente» que hay hoy en el sistema.
    sesiones_dadas: int = 0


@dataclass
class SenalesDelUsuario:
    """Lo que el propio usuario ha hecho, ya agregado.

    Se agrega AQUI y no en el ranker para que el ranker reciba numeros y no
    filas: asi se puede probar con un diccionario escrito a mano.
    """

    #: Cuantas senales por perfil concreto. Afinidad directa.
    por_perfil: dict[str, float] = field(default_factory=dict)
    #: Cuantas senales por tema. Es lo que hace que el interes se mueva con el
    #: uso: quien empieza en negocios y acaba abriendo perfiles de programacion
    #: ve subir «tecnologia» sin haber tocado sus preferencias.
    por_tema: dict[str, float] = field(default_factory=dict)
    #: Perfiles que la persona marco como «no me interesa». No se recomiendan.
    descartados: set[str] = field(default_factory=set)
    #: Publicaciones concretas rechazadas. Se excluyen del feed, pero NO se
    #: bloquea a su autor: rechazar un video no es rechazar a una persona.
    contenido_descartado: set[str] = field(default_factory=set)
    #: Cuanto se ha rechazado cada tema, de 0 a 1. Resta relevancia sin borrar
    #: el tema: hacen falta varios rechazos para que se note, y nunca llega a
    #: hundirlo del todo (ver `PENALIZACION_MAXIMA_POR_TEMA`).
    penalizacion_por_tema: dict[str, float] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Preferencias y relaciones
# --------------------------------------------------------------------------- #
async def cargar_preferencias(
    db: AsyncSession, user_id: str
) -> RecommendationPreference | None:
    return await db.get(RecommendationPreference, user_id)


async def relaciones_de(
    db: AsyncSession, user_ids: list[str] | set[str], relaciones: tuple[str, ...] | None = None
) -> dict[str, dict[str, set[str]]]:
    """Relaciones de varias personas de UNA consulta.

    Devuelve `{user_id: {relacion: {topic_id, ...}}}`. Esa forma es la que
    consumen las comparaciones del ranker (interseccion de conjuntos), asi que
    se construye una sola vez aqui en vez de rehacerse en cada comparacion.
    """
    ids = list(user_ids)
    if not ids:
        return {}
    consulta = select(
        UserTopicRelation.user_id, UserTopicRelation.relation, UserTopicRelation.topic_id
    ).where(UserTopicRelation.user_id.in_(ids))
    if relaciones:
        consulta = consulta.where(UserTopicRelation.relation.in_(list(relaciones)))
    salida: dict[str, dict[str, set[str]]] = {}
    for user_id, relacion, topic_id in (await db.execute(consulta)).all():
        salida.setdefault(user_id, {}).setdefault(relacion, set()).add(topic_id)
    return salida


async def topics_activos(db: AsyncSession) -> list[Topic]:
    return list(
        (
            await db.scalars(
                select(Topic)
                .where(Topic.active.is_(True))
                .order_by(Topic.position, Topic.name)
            )
        ).all()
    )


async def topics_por_id(db: AsyncSession, topic_ids: set[str]) -> dict[str, Topic]:
    if not topic_ids:
        return {}
    filas = (await db.scalars(select(Topic).where(Topic.id.in_(list(topic_ids))))).all()
    return {t.id: t for t in filas}


async def ids_de_topics_validos(db: AsyncSession, topic_ids: set[str]) -> set[str]:
    """Cuales de esos temas existen y siguen activos.

    Guardar una relacion contra un tema retirado dejaria preferencias que no se
    pueden pintar; contra uno inventado, un error de clave foranea a mitad de
    una transaccion.
    """
    if not topic_ids:
        return set()
    filas = (
        await db.scalars(
            select(Topic.id).where(Topic.id.in_(list(topic_ids)), Topic.active.is_(True))
        )
    ).all()
    return set(filas)


# --------------------------------------------------------------------------- #
# Grafo social
# --------------------------------------------------------------------------- #
async def seguidos_por(db: AsyncSession, user_id: str) -> set[str]:
    filas = (
        await db.scalars(select(Follow.following_id).where(Follow.follower_id == user_id))
    ).all()
    return set(filas)


async def bloqueos_en_ambos_sentidos(db: AsyncSession, user_id: str) -> set[str]:
    """A quien no se puede ver ni por quien se puede ser visto.

    El corte es simetrico, igual que en el muro: si solo se cortara un sentido,
    a la persona bloqueada le bastaria con no bloquear a su vez para seguir
    apareciendo entre las recomendaciones de quien la bloqueo.
    """
    filas = (
        await db.execute(
            select(UserBlock.blocker_id, UserBlock.blocked_id).where(
                or_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == user_id)
            )
        )
    ).all()
    salida: set[str] = set()
    for blocker, blocked in filas:
        salida.add(blocked if blocker == user_id else blocker)
    return salida


# --------------------------------------------------------------------------- #
# Candidatos
# --------------------------------------------------------------------------- #
def _perfiles_visibles(excluidos: set[str]) -> Select:
    """Base comun de cualquier busqueda de personas.

    Las cuentas privadas quedan fuera: recomendar a alguien que ha pedido no
    ser encontrado seria ignorar lo unico que pidio.
    """
    consulta = select(Profile.id).where(Profile.is_private.is_(False))
    if excluidos:
        consulta = consulta.where(Profile.id.not_in(list(excluidos)))
    return consulta


async def candidatos_por_oferta(
    db: AsyncSession,
    *,
    topic_ids: set[str],
    relaciones: tuple[str, ...],
    excluidos: set[str],
    limite: int,
) -> list[str]:
    """Quien OFRECE alguno de los temas que el usuario busca.

    Es la generacion de candidatos principal y responde exactamente a la
    pregunta del producto: «usuario quiere aprender X ↔ otra persona puede
    ayudar en X». El orden preliminar es por numero de temas coincidentes,
    para que el corte por `limite` no descarte a los mas compatibles.
    """
    if not topic_ids:
        return []
    coincidencias = func.count(func.distinct(UserTopicRelation.topic_id))
    consulta = (
        select(UserTopicRelation.user_id, coincidencias.label("coincidencias"))
        .join(Profile, Profile.id == UserTopicRelation.user_id)
        .where(
            UserTopicRelation.topic_id.in_(list(topic_ids)),
            UserTopicRelation.relation.in_(list(relaciones)),
            Profile.is_private.is_(False),
        )
        .group_by(UserTopicRelation.user_id)
        .order_by(coincidencias.desc())
        .limit(limite)
    )
    if excluidos:
        consulta = consulta.where(UserTopicRelation.user_id.not_in(list(excluidos)))
    return [fila[0] for fila in (await db.execute(consulta)).all()]


async def candidatos_por_interes_comun(
    db: AsyncSession, *, topic_ids: set[str], excluidos: set[str], limite: int
) -> list[str]:
    """Quien comparte intereses, para «personas con intereses parecidos».

    Lo que se comparte NO se dice en la respuesta: nombrar el tema revelaria
    algo que la otra persona no declaro en publico. El motivo se explica en
    generico (ver `ranker.MOTIVO_INTERES_COMUN`).
    """
    if not topic_ids:
        return []
    coincidencias = func.count(func.distinct(UserTopicRelation.topic_id))
    consulta = (
        select(UserTopicRelation.user_id, coincidencias.label("coincidencias"))
        .join(Profile, Profile.id == UserTopicRelation.user_id)
        .where(
            UserTopicRelation.topic_id.in_(list(topic_ids)),
            UserTopicRelation.relation.in_(["interest", "learn"]),
            Profile.is_private.is_(False),
        )
        .group_by(UserTopicRelation.user_id)
        .order_by(coincidencias.desc())
        .limit(limite)
    )
    if excluidos:
        consulta = consulta.where(UserTopicRelation.user_id.not_in(list(excluidos)))
    return [fila[0] for fila in (await db.execute(consulta)).all()]


async def candidatos_activos(
    db: AsyncSession, *, excluidos: set[str], desde: datetime, limite: int
) -> list[str]:
    """Quien ha publicado ultimamente. El respaldo de arranque en frio.

    Se ordena por ULTIMA publicacion y no por numero de seguidores. Ordenar por
    seguidores convertiria el recomendador en un ranking de popularidad, que es
    justo lo que no debe ser: una persona nueva con conocimiento relevante
    tiene que poder aparecer.
    """
    consulta = (
        select(Post.author_id, func.max(Post.created_at).label("ultima"))
        .join(Profile, Profile.id == Post.author_id)
        .where(
            Post.status == "published",
            Post.created_at >= desde,
            Profile.is_private.is_(False),
        )
        .group_by(Post.author_id)
        .order_by(func.max(Post.created_at).desc())
        .limit(limite)
    )
    if excluidos:
        consulta = consulta.where(Post.author_id.not_in(list(excluidos)))
    return [fila[0] for fila in (await db.execute(consulta)).all()]


async def candidatos_destacados(
    db: AsyncSession, *, excluidos: set[str], limite: int
) -> list[str]:
    """Los perfiles que el producto destaca. Ultimo recurso, nunca vacio."""
    consulta = (
        _perfiles_visibles(excluidos)
        .where(Profile.is_featured.is_(True))
        .order_by(Profile.created_at)
        .limit(limite)
    )
    return list((await db.scalars(consulta)).all())


async def perfiles(db: AsyncSession, ids: list[str]) -> dict[str, Profile]:
    if not ids:
        return {}
    filas = (await db.scalars(select(Profile).where(Profile.id.in_(ids)))).all()
    return {p.id: p for p in filas}


# --------------------------------------------------------------------------- #
# Actividad de los candidatos (4 consultas fijas, no una por candidato)
# --------------------------------------------------------------------------- #
async def actividad_de(
    db: AsyncSession, ids: list[str], *, desde: datetime
) -> dict[str, ActividadDeAutor]:
    if not ids:
        return {}
    salida: dict[str, ActividadDeAutor] = {i: ActividadDeAutor() for i in ids}

    # 1. Cuanto y cuando publica.
    filas = (
        await db.execute(
            select(
                Post.author_id,
                func.count(Post.id),
                func.max(Post.created_at),
            )
            .where(
                Post.author_id.in_(ids),
                Post.status == "published",
                Post.created_at >= desde,
            )
            .group_by(Post.author_id)
        )
    ).all()
    for autor, total, ultima in filas:
        salida[autor].publicaciones = total or 0
        salida[autor].ultima_publicacion = ultima

    # 2. En que formatos. Un perfil sin medios publica «publicacion».
    filas = (
        await db.execute(
            select(Post.author_id, PostMedia.media_type)
            .join(PostMedia, PostMedia.post_id == Post.id)
            .where(Post.author_id.in_(ids), Post.status == "published")
            .group_by(Post.author_id, PostMedia.media_type)
        )
    ).all()
    con_medios: set[str] = set()
    for autor, tipo in filas:
        salida[autor].formatos.add(tipo)
        con_medios.add(autor)
    for autor, actividad in salida.items():
        if actividad.publicaciones and autor not in con_medios:
            actividad.formatos.add("publicacion")

    # 3. Reacciones recibidas.
    filas = (
        await db.execute(
            select(Post.author_id, func.count(PostLike.user_id))
            .join(PostLike, PostLike.post_id == Post.id)
            .where(Post.author_id.in_(ids), Post.status == "published")
            .group_by(Post.author_id)
        )
    ).all()
    for autor, total in filas:
        salida[autor].reacciones = total or 0

    # 4. Sesiones 1:1 atendidas y cursos publicados.
    filas = (
        await db.execute(
            select(Booking.provider_id, func.count(Booking.id))
            .where(
                Booking.provider_id.in_(ids),
                Booking.status.in_(["accepted", "completed"]),
            )
            .group_by(Booking.provider_id)
        )
    ).all()
    for proveedor, total in filas:
        salida[proveedor].sesiones_dadas = total or 0
        if total:
            salida[proveedor].formatos.add("sesion_1a1")

    filas = (
        await db.execute(
            select(Course.author_id, func.count(Course.id))
            .where(Course.author_id.in_(ids), Course.status == "published")
            .group_by(Course.author_id)
        )
    ).all()
    for autor, total in filas:
        if total:
            salida[autor].formatos.add("curso")

    return salida


# --------------------------------------------------------------------------- #
# Senales de uso
# --------------------------------------------------------------------------- #
#: Cuanto vale cada senal. Que alguien abra un perfil dice algo; que le escriba
#: dice mucho mas; que le pida una sesion, todavia mas. Ordenarlas asi es lo
#: que hace que el recomendador aprenda de lo que IMPORTA y no de lo que
#: simplemente pasa mas veces.
PESO_POR_SENAL: dict[str, float] = {
    "content_impression": 0.05,
    "content_engaged": 0.6,
    "content_completed": 1.0,
    "profile_view": 0.8,
    "search_result_opened": 0.9,
    "follow": 2.5,
    "message_started": 3.0,
    "booking_requested": 4.0,
    "booking_completed": 5.0,
    # La senal negativa no resta puntos: EXCLUYE. Se trata aparte.
    "not_interested": 0.0,
}


def peso_por_antiguedad(creado: datetime, ahora: datetime) -> float:
    """Cuanto vale HOY una senal de hace N dias.

    Decaimiento exponencial con media vida configurable
    (`MEDIA_VIDA_DE_SENAL_DIAS`): a los 30 dias vale la mitad, a los 60 un
    cuarto, a los 90 un octavo. Sin esto, lo que alguien miro hace mes y medio
    pesaba igual que lo de ayer, y el recomendador se quedaba anclado en un
    interes que quiza ya paso.

    NUNCA baja de `PESO_MINIMO_POR_ANTIGUEDAD`. Una senal antigua pierde
    fuerza, no se convierte en mentira: sigue diciendo algo de esa persona. Sin
    suelo habria un salto brusco entre «cuenta un poco» y «no existe».

    Recibe el reloj por parametro y no lo consulta: asi se puede comprobar el
    decaimiento de noventa dias sin esperarlos.
    """
    if creado.tzinfo is None:
        creado = creado.replace(tzinfo=timezone.utc)
    dias = max(0.0, (ahora - creado).total_seconds() / 86400.0)
    factor = 0.5 ** (dias / MEDIA_VIDA_DE_SENAL_DIAS)
    return max(PESO_MINIMO_POR_ANTIGUEDAD, factor)


async def senales_de(
    db: AsyncSession, user_id: str, *, desde: datetime, ahora: datetime, limite: int
) -> SenalesDelUsuario:
    """Lo que ha hecho esta persona, ya sumado por perfil y por tema.

    Se leen las mas RECIENTES primero y con tope: alguien muy activo no puede
    hacer que su propia pantalla tarde mas que la de los demas.

    Cada senal se pondera por su ANTIGUEDAD (ver `peso_por_antiguedad`): lo de
    ayer manda sobre lo del mes pasado. El reloj llega por parametro para poder
    comprobar el decaimiento sin esperar noventa dias.
    """
    filas = (
        await db.scalars(
            select(BehaviorEvent)
            .where(BehaviorEvent.user_id == user_id, BehaviorEvent.created_at >= desde)
            .order_by(BehaviorEvent.created_at.desc())
            .limit(limite)
        )
    ).all()

    senales = SenalesDelUsuario()
    rechazos_por_tema: dict[str, int] = {}

    for evento in filas:
        if evento.event_type == "not_interested":
            # Rechazar tiene DOS efectos y conviene no mezclarlos: la entidad
            # exacta desaparece, y su tema se enfria un poco. Rechazar un video
            # NO bloquea a quien lo publico.
            if evento.entity_id:
                if evento.entity_type == "profile":
                    senales.descartados.add(evento.entity_id)
                elif evento.entity_type == "post":
                    senales.contenido_descartado.add(evento.entity_id)
            for topic_id in evento.topic_ids or ():
                rechazos_por_tema[topic_id] = rechazos_por_tema.get(topic_id, 0) + 1
            continue

        peso = PESO_POR_SENAL.get(evento.event_type, 0.0)
        if peso <= 0:
            continue
        # Lo visto a medias vale menos que lo visto entero...
        if evento.value is not None:
            peso *= max(0.2, float(evento.value))
        # ...y lo de hace un mes, menos que lo de ayer.
        peso *= peso_por_antiguedad(evento.created_at, ahora)

        if evento.entity_type == "profile" and evento.entity_id:
            senales.por_perfil[evento.entity_id] = (
                senales.por_perfil.get(evento.entity_id, 0.0) + peso
            )
        for topic_id in evento.topic_ids or ():
            senales.por_tema[topic_id] = senales.por_tema.get(topic_id, 0.0) + peso

    senales.penalizacion_por_tema = {
        topic_id: min(PENALIZACION_MAXIMA_POR_TEMA, veces * PENALIZACION_POR_RECHAZO)
        for topic_id, veces in rechazos_por_tema.items()
    }
    return senales


async def autores_de_senales(
    db: AsyncSession, user_id: str, *, desde: datetime, ahora: datetime, limite: int
) -> dict[str, float]:
    """Afinidad con AUTORES a partir de senales sobre su contenido.

    Una senal sobre una publicacion no dice nada de una persona hasta que se
    sabe de quien era la publicacion. Se resuelve de una consulta uniendo con
    `posts`, en vez de pedir el autor de cada publicacion por separado.
    """
    filas = (
        await db.execute(
            select(
                Post.author_id,
                BehaviorEvent.event_type,
                BehaviorEvent.value,
                BehaviorEvent.created_at,
            )
            .join(Post, Post.id == BehaviorEvent.entity_id)
            .where(
                BehaviorEvent.user_id == user_id,
                BehaviorEvent.entity_type == "post",
                BehaviorEvent.created_at >= desde,
            )
            .limit(limite)
        )
    ).all()
    salida: dict[str, float] = {}
    for autor, tipo, valor, creado in filas:
        peso = PESO_POR_SENAL.get(tipo, 0.0)
        if peso <= 0:
            continue
        if valor is not None:
            peso *= max(0.2, float(valor))
        peso *= peso_por_antiguedad(creado, ahora)
        salida[autor] = salida.get(autor, 0.0) + peso
    return salida


# --------------------------------------------------------------------------- #
# Temas del contenido (migracion 0027)
# --------------------------------------------------------------------------- #
async def temas_de_publicaciones(
    db: AsyncSession, post_ids: list[str]
) -> dict[str, set[str]]:
    """De que trata cada publicacion. UNA consulta para el lote entero.

    Solo devuelve las que TIENEN temas. Las que faltan son las publicaciones
    anteriores a la 0027 y las que nadie etiqueto; para esas, el ranker cae a
    los temas del autor (ver `service.contenido_para`). Distinguir «no tiene»
    de «tiene cero» es justo lo que permite que el contenido antiguo siga
    funcionando en vez de quedarse sin puntuar.
    """
    if not post_ids:
        return {}
    filas = (
        await db.execute(
            select(PostTopic.post_id, PostTopic.topic_id).where(
                PostTopic.post_id.in_(post_ids)
            )
        )
    ).all()
    salida: dict[str, set[str]] = {}
    for post_id, topic_id in filas:
        salida.setdefault(post_id, set()).add(topic_id)
    return salida
