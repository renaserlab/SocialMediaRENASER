"""El que orquesta: junta preferencias, candidatos, rasgos, orden y motivos.

Nadie mas conoce el proceso entero. El router solo traduce HTTP; el ranker solo
puntua; el repositorio solo lee. Aqui esta la secuencia, y por eso es el unico
sitio donde hay que mirar para responder a «¿como se decide lo que ve alguien?»:

    preferencias
      -> demanda (que necesita)
      -> candidatos (quien podria aportarle valor)
      -> rasgos (que sabemos de cada uno)
      -> orden (quien primero)
      -> diversidad (que la lista no sea una sola cosa)
      -> motivos (por que)

Guardar el cuestionario tambien vive aqui, y en UNA transaccion: media
respuesta guardada es peor que ninguna, porque deja un perfil que dice cosas
que la persona no dijo.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.content.models import Post, PostLike, PostMedia
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, candidate_generator, repository as repo
from app.modules.recommendations.config import (
    CANDIDATOS_MAXIMOS,
    MAX_TEMAS_POR_PUBLICACION,
    CONTENT_ALGORITHM_VERSION,
    FORMATOS,
    MAX_SEGUIDAS_DEL_MISMO_AUTOR,
    MODOS_DE_OFERTA,
    OBJETIVOS,
    ONBOARDING_VERSION,
    PESOS_DE_CONTENIDO,
    PESOS_DE_PERSONAS,
    RECOMMENDATION_ALGORITHM_VERSION,
    RELACION_POR_CONEXION,
    RELACION_POR_MODO_DE_OFERTA,
    RELACIONES_DE_OFERTA,
    SENALES_MAXIMAS,
    TIPOS_DE_CONEXION,
    VENTANA_DE_ACTIVIDAD_DIAS,
    VENTANA_DE_COMPORTAMIENTO_DIAS,
    PesosDePersonas,
)
from app.modules.recommendations.features import Candidato, PerfilDeDemanda, Rasgos
from app.modules.recommendations.features import construir as construir_rasgos
from app.modules.recommendations.features import exploracion_de
from app.modules.recommendations.models import (
    RecommendationPreference,
    UserTopicRelation,
)
from app.modules.recommendations.ranker import Puntuacion, puntuar
from app.modules.recommendations.reranker import por_grupo, sin_rachas
from app.modules.recommendations.schemas import (
    OnboardingCatalog,
    OnboardingStatus,
    OpcionRead,
    PersonRecommendation,
    PreferencesInput,
    PreferencesRead,
    RecommendationReason,
    TopicRead,
    TopicRelationRead,
)

#: Cuantas publicaciones se puntuan como mucho para ordenar el feed. Con techo
#: porque una peticion de feed no puede crecer con el catalogo: el dia que haya
#: cien mil videos, esto seguiria respondiendo igual de rapido.
CANDIDATOS_DE_CONTENIDO = 300

#: De donde sale la fuente de la que se ordena el contenido.
ORIGEN_PERSONALIZADO = "personalized"
ORIGEN_ARRANQUE_EN_FRIO = "cold_start"


def ahora_utc() -> datetime:
    return datetime.now(timezone.utc)


def semilla_de_exploracion(ahora: datetime) -> str:
    """La exploracion cambia UNA VEZ AL DIA, no en cada peticion.

    Si cambiara en cada peticion, la lista se reordenaria al desplazarla y al
    volver atras: quien vio a alguien interesante no volveria a encontrarlo. Si
    no cambiara nunca, la exploracion no exploraria nada. Un cubo por dia es el
    equilibrio, y ademas hace la paginacion estable dentro de una sesion.
    """
    return ahora.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- #
# Onboarding
# --------------------------------------------------------------------------- #
async def estado_del_onboarding(db: AsyncSession, user_id: str) -> OnboardingStatus:
    """¿Hay que ensenar el cuestionario a esta persona?

    Lo decide el SERVIDOR. Si lo decidiera el movil, cambiar de telefono
    volveria a preguntarlo todo y dos versiones de la aplicacion podrian
    discrepar sobre la misma cuenta.

    Cubre a quien ya existia: un usuario antiguo no tiene fila, asi que
    `should_show` sale true una vez y, en cuanto responde o pasa de largo, deja
    de salir. No se le persigue en cada arranque.
    """
    preferencias = await repo.cargar_preferencias(db, user_id)
    if preferencias is None:
        return OnboardingStatus(
            completed=False,
            should_show=True,
            onboarding_version=0,
            current_version=ONBOARDING_VERSION,
        )
    completado = preferencias.completed_at is not None
    # Ya paso por esta version (respondiendo o saltandosela): no se repite.
    visto = preferencias.onboarding_version >= ONBOARDING_VERSION
    return OnboardingStatus(
        completed=completado,
        should_show=not visto,
        onboarding_version=preferencias.onboarding_version,
        current_version=ONBOARDING_VERSION,
        skipped=preferencias.skipped,
        completed_at=preferencias.completed_at,
    )


def _opciones(origen) -> list[OpcionRead]:
    return [OpcionRead(key=o.clave, label=o.etiqueta, help=o.ayuda) for o in origen]


async def catalogo(db: AsyncSession) -> OnboardingCatalog:
    """Las preguntas y sus opciones, en UNA peticion.

    Los temas salen de la base de datos y no de una constante de React: anadir
    «Panaderia» tiene que ser una fila, no una version de la aplicacion en dos
    tiendas.
    """
    temas = await repo.topics_activos(db)
    return OnboardingCatalog(
        onboarding_version=ONBOARDING_VERSION,
        topics=[TopicRead.model_validate(t) for t in temas],
        goals=_opciones(OBJETIVOS),
        connection_types=_opciones(TIPOS_DE_CONEXION),
        content_formats=_opciones(FORMATOS),
        offer_modes=_opciones(MODOS_DE_OFERTA),
    )


def relaciones_derivadas(payload: PreferencesInput) -> dict[str, set[str]]:
    """De respuestas humanas a aristas PERSONA --relacion--> TEMA.

    Esta es la unica traduccion del sistema y vive en el servidor, no en el
    movil: es una regla de producto, y una regla de producto repartida entre
    dos clientes acaba significando dos cosas distintas.

    Las reglas, dichas en voz alta:

    - Los temas de la pregunta 2 son lo que la persona QUIERE APRENDER, y
      ademas le interesan. Las dos relaciones, porque no son lo mismo:
      «aprender» pide a alguien que ensene, «interes» sirve para encontrar
      gente parecida.
    - Si ademas dijo que busca ORIENTACION, esos mismos temas llevan
      `seek_guidance`: no es lo mismo querer un curso que querer un consejo.
    - Los temas de la pregunta 5 son lo que OFRECE, y en que forma lo ofrece lo
      dicen los modos elegidos. «Creo contenido» y «ofrezco sesiones» describen
      el canal, no el conocimiento, asi que no crean relacion por si solos: si
      fueran lo unico marcado, queda `can_help`, que es lo que la persona
      acaba de responder que si a la pregunta.
    """
    salida: dict[str, set[str]] = {}

    demanda = {"learn", "interest"}
    if "orientacion" in payload.goals:
        demanda.add("seek_guidance")
    for topic_id in payload.learning_topic_ids:
        salida.setdefault(topic_id, set()).update(demanda)

    oferta = {
        relacion
        for modo in payload.offer_modes
        if (relacion := RELACION_POR_MODO_DE_OFERTA.get(modo)) is not None
    }
    if payload.offer_topic_ids and not oferta:
        oferta = {"can_help"}
    for topic_id in payload.offer_topic_ids:
        salida.setdefault(topic_id, set()).update(oferta)

    # Un tema sin ninguna relacion no es una relacion: se descarta en vez de
    # guardar una fila vacia de significado.
    return {t: r for t, r in salida.items() if r}


async def leer_preferencias(db: AsyncSession, user_id: str) -> PreferencesRead:
    """Lo guardado, en la misma forma en que se envio. Para poder editarlo."""
    preferencias = await repo.cargar_preferencias(db, user_id)
    relaciones = (await repo.relaciones_de(db, [user_id])).get(user_id, {})

    por_tema: dict[str, set[str]] = {}
    for relacion, temas in relaciones.items():
        for topic_id in temas:
            por_tema.setdefault(topic_id, set()).add(relacion)

    aprender = sorted(t for t, r in por_tema.items() if r & {"learn", "seek_guidance"})
    ofrecer = sorted(t for t, r in por_tema.items() if r & set(RELACIONES_DE_OFERTA))

    return PreferencesRead(
        goals=list(preferencias.goals or []) if preferencias else [],
        learning_topic_ids=aprender,
        connection_types=(
            list(preferencias.preferred_connection_types or []) if preferencias else []
        ),
        content_formats=(
            list(preferencias.preferred_content_formats or []) if preferencias else []
        ),
        offer_modes=list(preferencias.offer_modes or []) if preferencias else [],
        offer_topic_ids=ofrecer,
        derived_relations=[
            TopicRelationRead(topic_id=topic_id, relations=sorted(rels))
            for topic_id, rels in sorted(por_tema.items())
        ],
        onboarding_version=preferencias.onboarding_version if preferencias else 0,
        completed_at=preferencias.completed_at if preferencias else None,
        skipped=preferencias.skipped if preferencias else False,
    )


async def guardar_preferencias(
    db: AsyncSession, user_id: str, payload: PreferencesInput
) -> PreferencesRead:
    """Guarda el cuestionario. Todo o nada.

    DOS DECISIONES QUE IMPORTAN:

    1. Es un REEMPLAZO, no una suma. Editar preferencias tiene que poder
       QUITAR: si solo anadiera, quien se equivoco al marcar «carpinteria»
       cargaria con ella para siempre y el recomendador seguiria creyendo algo
       que ya no es verdad.

    2. Se borran SOLO las relaciones de esta persona y SOLO las que vinieron
       del cuestionario (`source='onboarding'`). Nunca datos globales, y nunca
       lo que en el futuro venga del perfil o de las senales de uso.

    Todo ocurre en una transaccion: si algo falla a mitad, no queda un perfil
    con la mitad de las respuestas nuevas y la mitad de las viejas.
    """
    derivadas = relaciones_derivadas(payload)
    seleccionados = set(derivadas)
    validos = await repo.ids_de_topics_validos(db, seleccionados)
    desconocidos = seleccionados - validos
    if desconocidos:
        # Se rechaza entero en vez de guardar «lo que se pueda»: aceptar a
        # medias dejaria a la persona creyendo que eligio algo que no se guardo.
        raise ValidationAppError(
            "Hay temas que ya no están disponibles. Vuelve a elegirlos.",
            details={"topic_ids": sorted(desconocidos)},
        )

    # Guardar de verdad. Se separa porque puede tener que repetirse: dos
    # dispositivos guardando a la vez chocan contra la restriccion de unicidad
    # de (usuario, tema, relacion), y la segunda vez ya no choca porque el
    # borrado de esta misma funcion deja la mesa limpia.
    try:
        await _escribir_preferencias(db, user_id, payload, derivadas)
    except IntegrityError:
        await db.rollback()
        try:
            await _escribir_preferencias(db, user_id, payload, derivadas)
        except IntegrityError as choque:
            await db.rollback()
            raise ConflictError(
                "Estás guardando tus preferencias desde dos sitios a la vez. "
                "Inténtalo de nuevo."
            ) from choque

    # Lo recomendado hasta ahora se calculo con las respuestas VIEJAS. Sin esto,
    # quien acaba de contestar veria durante un minuto justo lo de antes de
    # contestar, que es el momento en el que hay que demostrar que sirve.
    cache.invalidar(user_id)
    return await leer_preferencias(db, user_id)


async def _escribir_preferencias(
    db: AsyncSession,
    user_id: str,
    payload: PreferencesInput,
    derivadas: dict[str, set[str]],
) -> None:
    """El guardado en si. Una transaccion: o entra todo, o no entra nada."""
    ahora = ahora_utc()
    preferencias = await repo.cargar_preferencias(db, user_id)
    if preferencias is None:
        preferencias = RecommendationPreference(user_id=user_id)
        db.add(preferencias)

    preferencias.goals = list(payload.goals)
    preferencias.preferred_connection_types = list(payload.connection_types)
    preferencias.preferred_content_formats = list(payload.content_formats)
    preferencias.offer_modes = list(payload.offer_modes)
    preferencias.onboarding_version = ONBOARDING_VERSION
    preferencias.skipped = payload.skipped
    preferencias.updated_at = ahora
    # Saltar tambien deja constancia de que paso por esta version —para no
    # volver a preguntarle— pero no cuenta como respondido.
    preferencias.completed_at = None if payload.skipped else ahora

    await db.execute(
        delete(UserTopicRelation).where(
            UserTopicRelation.user_id == user_id,
            UserTopicRelation.source == "onboarding",
        )
    )
    for topic_id, relaciones in derivadas.items():
        for relacion in sorted(relaciones):
            db.add(
                UserTopicRelation(
                    user_id=user_id,
                    topic_id=topic_id,
                    relation=relacion,
                    source="onboarding",
                )
            )
    await db.commit()


# --------------------------------------------------------------------------- #
# Personas
# --------------------------------------------------------------------------- #
async def _construir_demanda(
    db: AsyncSession, user_id: str, ahora: datetime
) -> tuple[PerfilDeDemanda, repo.SenalesDelUsuario]:
    """Traduce lo que la persona respondio (y lo que hace) a una necesidad.

    Devuelve tambien las senales en crudo porque quien llama las necesita para
    otra cosa: los perfiles que la persona marco como «no me interesa» son una
    EXCLUSION, no un rasgo, y volver a leerlas seria repetir la consulta.
    """
    preferencias = await repo.cargar_preferencias(db, user_id)
    relaciones = (await repo.relaciones_de(db, [user_id])).get(user_id, {})

    aprender = relaciones.get("learn", set())
    orientacion = relaciones.get("seek_guidance", set())
    intereses = relaciones.get("interest", set())

    tipos = list(preferencias.preferred_connection_types or []) if preferencias else []
    buscadas: set[str] = set()
    for tipo in tipos:
        buscadas.update(RELACION_POR_CONEXION.get(tipo, ()))

    senales = await repo.senales_de(
        db,
        user_id,
        desde=ahora - timedelta(days=VENTANA_DE_COMPORTAMIENTO_DIAS),
        ahora=ahora,
        limite=SENALES_MAXIMAS,
    )

    return PerfilDeDemanda(
        usuario_id=user_id,
        aprender=frozenset(aprender),
        orientacion=frozenset(orientacion),
        intereses=frozenset(intereses),
        relaciones_buscadas=frozenset(buscadas),
        busca_afines="afines" in tipos,
        formatos=frozenset(preferencias.preferred_content_formats or []) if preferencias else frozenset(),
        afinidad_por_tema=senales.por_tema,
        penalizacion_por_tema=senales.penalizacion_por_tema,
        tiene_senales=bool(senales.por_perfil or senales.por_tema),
    ), senales


@dataclass(frozen=True)
class PersonaPuntuada:
    """Una persona ya medida y puntuada.

    Lleva los datos del perfil COPIADOS y no el objeto del ORM. Es lo que
    permite guardarla en la memoria corta: una fila del ORM pertenece a la
    sesion que la trajo y deja de ser legible cuando esa sesion se cierra.
    """

    id: str
    full_name: str
    username: str | None
    avatar_path: str | None
    bio: str
    puntuacion: Puntuacion
    rasgos: Rasgos

    @property
    def score(self) -> float:
        return self.puntuacion.score


async def personas_puntuadas(
    db: AsyncSession,
    user_id: str,
    *,
    ahora: datetime | None = None,
    pesos: PesosDePersonas = PESOS_DE_PERSONAS,
    limite_candidatos: int = CANDIDATOS_MAXIMOS,
) -> tuple[list[PersonaPuntuada], str]:
    """El nucleo: candidatos, rasgos y orden. Sin paginar y sin diversificar.

    Se expone aparte del endpoint porque el recomendador de CONTENIDO necesita
    exactamente esto —a quien le interesa esta persona— y calcularlo dos veces
    seria pagar dos veces la misma consulta.
    """
    ahora = ahora or ahora_utc()
    semilla = semilla_de_exploracion(ahora)

    # El mismo ranking lo piden «Personas para ti» y cada pagina del feed. Se
    # calcula una vez y se reutiliza durante unos segundos; cualquier cosa que
    # cambie lo que hay que recomendarle a alguien lo invalida al momento (ver
    # `cache.invalidar`). Solo con los pesos de siempre: una peticion con pesos
    # ajustados es un experimento y no debe leer ni escribir la memoria.
    usa_memoria = pesos is PESOS_DE_PERSONAS and limite_candidatos == CANDIDATOS_MAXIMOS
    if usa_memoria:
        guardado = cache.obtener(user_id, semilla)
        if guardado is not None:
            return guardado

    demanda, senales = await _construir_demanda(db, user_id, ahora)

    # EXCLUSIONES. No son un detalle: son la diferencia entre recomendar y
    # molestar. Uno mismo; quien bloqueo o me bloqueo; y a quien ya dije que no
    # me interesa.
    bloqueados = await repo.bloqueos_en_ambos_sentidos(db, user_id)
    excluidos = {user_id} | bloqueados | senales.descartados

    candidatos = await candidate_generator.generar(
        db, demanda, excluidos=excluidos, ahora=ahora, limite=limite_candidatos
    )
    if not candidatos.ids:
        vacio: tuple[list[PersonaPuntuada], str] = ([], ORIGEN_ARRANQUE_EN_FRIO)
        if usa_memoria:
            cache.guardar(user_id, semilla, vacio)
        return vacio

    # Todo lo que se sabe de TODOS los candidatos, en un punado de consultas
    # fijas. Ninguna crece con el numero de candidatos.
    perfiles = await repo.perfiles(db, candidatos.ids)
    ofertas = await repo.relaciones_de(db, candidatos.ids)
    actividades = await repo.actividad_de(
        db, candidatos.ids, desde=ahora - timedelta(days=VENTANA_DE_ACTIVIDAD_DIAS)
    )
    seguidos = await repo.seguidos_por(db, user_id)
    afinidad_por_autor = await repo.autores_de_senales(
        db,
        user_id,
        desde=ahora - timedelta(days=VENTANA_DE_COMPORTAMIENTO_DIAS),
        ahora=ahora,
        limite=SENALES_MAXIMAS,
    )

    salida: list[PersonaPuntuada] = []
    for candidato_id in candidatos.ids:
        perfil = perfiles.get(candidato_id)
        if perfil is None:
            # Un perfil borrado entre consulta y consulta no debe tumbar nada.
            continue
        relaciones = ofertas.get(candidato_id, {})
        candidato = Candidato(
            id=candidato_id,
            oferta={
                relacion: frozenset(relaciones.get(relacion, set()))
                for relacion in RELACIONES_DE_OFERTA
            },
            intereses=frozenset(
                relaciones.get("interest", set()) | relaciones.get("learn", set())
            ),
            actividad=actividades.get(candidato_id) or repo.ActividadDeAutor(),
            afinidad=(
                senales.por_perfil.get(candidato_id, 0.0)
                + afinidad_por_autor.get(candidato_id, 0.0)
            ),
            ya_seguido=candidato_id in seguidos,
        )
        rasgos = construir_rasgos(candidato, demanda, ahora=ahora, semilla=semilla)
        salida.append(
            PersonaPuntuada(
                id=candidato_id,
                full_name=perfil.full_name,
                username=perfil.username,
                avatar_path=perfil.avatar_path,
                bio=perfil.bio or "",
                puntuacion=puntuar(rasgos, pesos),
                rasgos=rasgos,
            )
        )

    # Desempate por id: sin un orden total, dos personas con el mismo score
    # podrian intercambiarse entre paginas y aparecer dos veces o ninguna.
    salida.sort(key=lambda p: (-p.score, p.id))
    estrategia = (
        ORIGEN_PERSONALIZADO
        if candidatos.hubo_coincidencia_real
        else ORIGEN_ARRANQUE_EN_FRIO
    )
    resultado = (salida, estrategia)
    if usa_memoria:
        cache.guardar(user_id, semilla, resultado)
    return resultado


async def personas_para(
    db: AsyncSession,
    user_id: str,
    *,
    limite: int,
    offset: int = 0,
    incluir_seguidos: bool = False,
    debug: bool = False,
    ahora: datetime | None = None,
) -> tuple[list[PersonRecommendation], str]:
    """La lista lista para pintar: paginada, diversa y con motivos."""
    ahora = ahora or ahora_utc()
    puntuadas, estrategia = await personas_puntuadas(db, user_id, ahora=ahora)

    if not incluir_seguidos:
        # A quien ya sigues no hay que recomendartelo: ya lo encontraste. Se
        # filtra DESPUES de puntuar para que siga contando como contexto.
        sin_seguidos = [p for p in puntuadas if not p.rasgos.ya_seguido]
        # ...salvo que no quede nadie mas. Una pantalla vacia es peor.
        puntuadas = sin_seguidos or puntuadas

    # Diversidad por tema principal: diez carpinteros seguidos no ayudan mas
    # que tres. Quien no coincide en ningun tema forma su propio grupo.
    diversas = por_grupo(
        puntuadas,
        grupo_de=lambda p: p.rasgos.temas_coincidentes[0] if p.rasgos.temas_coincidentes else p.id,
        maximo_por_grupo=3,
        limite=offset + limite,
    )
    pagina = diversas[offset : offset + limite]

    temas_a_nombrar: set[str] = set()
    for persona in pagina:
        for motivo in persona.puntuacion.motivos:
            temas_a_nombrar.update(motivo.topics)
    nombres = await repo.topics_por_id(db, temas_a_nombrar)

    items = [
        PersonRecommendation(
            # La posicion la pone el SERVIDOR y viaja de vuelta en la impresion.
            # Dejarsela calcular al movil funcionaria hoy, pero cualquier filtro
            # que hiciera por su cuenta desplazaria los numeros y las metricas
            # medirian otra cosa sin que nadie se diera cuenta.
            rank=offset + posicion,
            id=persona.id,
            full_name=persona.full_name,
            username=persona.username,
            avatar_path=persona.avatar_path,
            bio=persona.bio,
            is_following=persona.rasgos.ya_seguido,
            reasons=[
                RecommendationReason(
                    code=motivo.code,
                    topics=[
                        nombres[t].name for t in motivo.topics if t in nombres
                    ],
                )
                for motivo in persona.puntuacion.motivos
            ],
            debug=persona.puntuacion.desglose if debug else None,
        )
        for posicion, persona in enumerate(pagina)
    ]
    return items, estrategia


# --------------------------------------------------------------------------- #
# Contenido
# --------------------------------------------------------------------------- #
@dataclass
class ContenidoOrdenado:
    post_ids: list[str]
    estrategia: str
    #: Cuantas de las devueltas tenian temas PROPIOS (frente a heredados del
    #: autor). Es la medida honesta de cuanto sabe de verdad el recomendador
    #: sobre el contenido que esta ordenando.
    con_tema_propio: int = 0


def _afinidad_tematica(
    demanda: PerfilDeDemanda,
    temas_del_post: set[str] | None,
    temas_del_autor: set[str] | None,
) -> tuple[float, bool]:
    """Cuanto encaja una publicacion con lo que la persona busca, y por que via.

    EL ORDEN IMPORTA, y es el cambio de fondo de la V1.1:

    1. Los temas PROPIOS de la publicacion, si los tiene. Es lo unico que dice
       de verdad de que trata: un carpintero tambien publica recetas, y
       heredarle «carpinteria» a todo lo que sube es lo que hacia que el feed
       mintiera.

    2. Si no los tiene, los temas del AUTOR, con un descuento. Sirve para las
       publicaciones anteriores a la 0027 y para las que nadie etiqueto: son
       una pista razonable, no un hecho, y por eso no valen lo mismo.

    3. Si no hay ninguna de las dos cosas, cero. No se inventa afinidad.

    Devuelve tambien SI la via fue el tema propio, para poder decir la verdad
    al explicar y para poder medir cuanto contenido esta clasificado.
    """
    buscados = demanda.temas_buscados
    if not buscados:
        return 0.0, False

    def _encaje(temas: set[str]) -> float:
        coincidentes = temas & buscados
        if not coincidentes:
            return 0.0
        castigo = max(
            (demanda.penalizacion_por_tema.get(t, 0.0) for t in coincidentes),
            default=0.0,
        )
        # Con uno basta para que sea relevante; el segundo y el tercero suman
        # menos. Coincidir en tres temas no hace un video tres veces mejor.
        bruto = min(1.0, len(coincidentes) / MAX_TEMAS_POR_PUBLICACION + 0.34)
        return bruto * max(0.0, 1.0 - castigo)

    if temas_del_post:
        return _encaje(temas_del_post), True
    if temas_del_autor:
        # Descuento del respaldo: es una pista sobre el autor, no un hecho
        # sobre esta publicacion concreta.
        return _encaje(temas_del_autor) * 0.6, False
    return 0.0, False


def _recencia(creado: datetime, ahora: datetime, dias: int = 14) -> float:
    if creado.tzinfo is None:
        creado = creado.replace(tzinfo=timezone.utc)
    transcurridos = max(0.0, (ahora - creado).total_seconds() / 86400.0)
    return max(0.0, 1.0 - transcurridos / dias)


async def contenido_para(
    db: AsyncSession,
    user_id: str,
    *,
    limite: int,
    offset: int = 0,
    media: str | None = None,
    ahora: datetime | None = None,
) -> ContenidoOrdenado:
    """Que publicaciones, y en que orden.

    HONESTIDAD SOBRE LO QUE SE PUEDE HACER HOY. Una publicacion no declara de
    que trata: no hay temas en `posts` ni embeddings. Lo unico que se sabe de
    su tema es lo que declara QUIEN la publico. Asi que la afinidad tematica se
    HEREDA del autor, y se dice: si a alguien le encaja mucho un carpintero, es
    correcto que sus videos suban. No se inventa contenido que no existe: si
    solo hay tres videos, se ordenan tres videos.
    """
    ahora = ahora or ahora_utc()
    demanda, senales = await _construir_demanda(db, user_id, ahora)
    puntuadas, estrategia = await personas_puntuadas(db, user_id, ahora=ahora)
    score_por_autor = {p.id: p.score for p in puntuadas}

    bloqueados = await repo.bloqueos_en_ambos_sentidos(db, user_id)

    consulta = (
        select(Post.id, Post.author_id, Post.created_at)
        .where(Post.status == "published")
        .order_by(Post.created_at.desc())
        .limit(CANDIDATOS_DE_CONTENIDO)
    )
    if bloqueados:
        consulta = consulta.where(Post.author_id.not_in(list(bloqueados)))
    # Lo que la persona ya rechazo no vuelve. Su AUTOR si: rechazar un video no
    # es rechazar a quien lo publico.
    if senales.contenido_descartado:
        consulta = consulta.where(Post.id.not_in(list(senales.contenido_descartado)))
    if media:
        con_medio = select(PostMedia.post_id).where(PostMedia.media_type == media)
        consulta = consulta.where(Post.id.in_(con_medio))
    else:
        # El feed nunca mezcla audios: son episodios del podcast y tienen su
        # propia seccion. Mismo criterio que el muro.
        audios = select(PostMedia.post_id).where(PostMedia.media_type == "audio")
        consulta = consulta.where(Post.id.not_in(audios))

    filas = (await db.execute(consulta)).all()
    if not filas:
        return ContenidoOrdenado(post_ids=[], estrategia=estrategia)

    post_ids = [fila[0] for fila in filas]
    reacciones = dict(
        (
            await db.execute(
                select(PostLike.post_id, func.count(PostLike.user_id))
                .where(PostLike.post_id.in_(post_ids))
                .group_by(PostLike.post_id)
            )
        ).all()
    )
    # De que trata cada publicacion. UNA consulta para el lote entero.
    temas_por_post = await repo.temas_de_publicaciones(db, post_ids)

    # Y de que trata cada AUTOR, para las publicaciones que nadie etiqueto.
    autores = {fila[1] for fila in filas}
    oferta_de_autores = await repo.relaciones_de(db, autores)
    temas_por_autor: dict[str, set[str]] = {}
    for autor_id, relaciones in oferta_de_autores.items():
        acumulado: set[str] = set()
        for relacion in RELACIONES_DE_OFERTA:
            acumulado |= relaciones.get(relacion, set())
        if acumulado:
            temas_por_autor[autor_id] = acumulado

    semilla = semilla_de_exploracion(ahora)
    pesos = PESOS_DE_CONTENIDO
    total = pesos.total()

    @dataclass
    class _Puntuado:
        id: str
        autor: str
        score: float
        por_tema_propio: bool

    puntuados = []
    for post_id, autor_id, creado in filas:
        propios = temas_por_post.get(post_id)
        tema, por_tema_propio = _afinidad_tematica(
            demanda, propios, temas_por_autor.get(autor_id)
        )
        puntuados.append(
            _Puntuado(
                id=post_id,
                autor=autor_id,
                por_tema_propio=por_tema_propio,
                score=(
                    pesos.tema * tema
                    + pesos.autor * score_por_autor.get(autor_id, 0.0)
                    + pesos.recencia * _recencia(creado, ahora)
                    + pesos.interaccion
                    * min(1.0, (reacciones.get(post_id, 0) or 0) / 20.0)
                    + pesos.exploracion * exploracion_de(user_id, post_id, semilla)
                )
                / total,
            )
        )
    puntuados.sort(key=lambda p: (-p.score, p.id))

    # Sin rachas del mismo autor: nadie se queda fuera, solo se intercala. Con
    # un unico creador la lista sale igual, que es lo correcto.
    intercalados = sin_rachas(
        puntuados,
        grupo_de=lambda p: p.autor,
        maximo_seguidos=MAX_SEGUIDAS_DEL_MISMO_AUTOR,
    )
    pagina = intercalados[offset : offset + limite]
    return ContenidoOrdenado(
        post_ids=[p.id for p in pagina],
        estrategia=estrategia,
        con_tema_propio=sum(1 for p in pagina if p.por_tema_propio),
    )


VERSIONES = {
    "people": RECOMMENDATION_ALGORITHM_VERSION,
    "content": CONTENT_ALGORITHM_VERSION,
}
