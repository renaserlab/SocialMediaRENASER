"""Endpoints de mensajería.

- Solo los miembros pueden leer/escribir en una conversación (identidad del JWT).
- La entrega en tiempo real la hace Supabase Realtime sobre la tabla messages;
  aquí solo persistimos y exponemos el historial.

El listado de conversaciones se arma en `lectura.py`, que hace un numero de
consultas CONSTANTE. Ese fichero explica por que: aqui construir cada fila por
separado costaba `1 + 3N` viajes a la base y era el motivo de que la pantalla de
Mensajes tardara segundos en abrirse.
"""

import logging
import unicodedata
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy import false, func, insert, or_, select, true, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import (
    audio,
    avisos,
    esquema,
    grupos,
    historias,
    preferencias,
    reacciones,
    sesiones,
    subgrupos,
    temas,
)
from app.modules.messaging.etiquetas import condicion_de_etiqueta
from app.modules.messaging.entrada_a_grupos import router as entrada_router
from app.modules.messaging.etiquetas import router as etiquetas_router
from app.modules.messaging.grupos import router as grupos_router
from app.modules.messaging.lecturas import router as lecturas_router
from app.modules.messaging.preferencias import router as preferencias_router
from app.modules.messaging.reacciones import router as reacciones_router
from app.modules.messaging.subgrupos import router as subgrupos_router
from app.modules.messaging.temas import router as temas_router
from app.modules.messaging.lectura import adjuntos_por_mensaje, leer_conversaciones
from app.modules.messaging.models import (
    ES_NOTA_DE_VOZ,
    Conversation,
    ConversationMember,
    DirectConversationPair,
    Message,
    MessageAttachment,
    MessageStoryContext,
)
from app.modules.messaging.schemas import (
    MAX_BUSQUEDA,
    MAX_TITULO_DE_ADJUNTO,
    TIPOS_SIN_NOMBRE,
    AttachmentCreate,
    AttachmentRead,
    ConversationRead,
    DirectConversationCreate,
    MessageCreate,
    MessageRead,
    MessagingAvailability,
    StoryContextRead,
    TituloDeAdjunto,
)
from app.modules.messaging.vistas import administra
from app.modules.messaging.vistas import router as vistas_router
from app.modules.notifications.push import encolar_push
from app.modules.profiles.models import Profile
from app.modules.recommendations.signals import registrar_senal
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["messaging"])

# El CRM ligero de etiquetas privadas (`etiquetas.py`), montado ANTES que las
# rutas de este fichero: FastAPI prueba en orden de declaracion, asi que el dia
# que alguien anada un `GET /{conversation_id}` aqui, `/conversations/labels`
# seguiria leyendose como lo que es y no como un id de conversacion.
router.include_router(etiquetas_router)

# Las vistas de una conversacion —categorias automaticas y filtros de grupo—
# (`vistas.py`). Sus rutas cuelgan todas de `/{conversation_id}/views` y
# `/{conversation_id}/filters`, que no chocan con ninguna de este fichero.
router.include_router(vistas_router)

# Los grupos (`grupos.py`): crearlos, ver quién está y cambiar sus miembros.
# `POST /groups` se declara antes que las rutas con `{conversation_id}` de
# este fichero por la misma precaución que las etiquetas.
router.include_router(grupos_router)

# Como se entra a un grupo (`entrada_a_grupos.py`): su tarjeta, su enlace,
# su foto y las solicitudes. Sus rutas fijas empiezan por `/groups/…`.
router.include_router(entrada_router)

# Reaccionar a un mensaje y consultar reacciones (`reacciones.py`).
router.include_router(reacciones_router)

# Silenciar una conversación y vaciarla para uno mismo (`preferencias.py`).
router.include_router(preferencias_router)

# Quién ha leído cada mensaje: la confirmación de lectura (`lecturas.py`).
router.include_router(lecturas_router)

# Los temas de un grupo (`temas.py`) y sus comunidades (`subgrupos.py`). Sus
# rutas cuelgan de `/{conversation_id}/topics` y `/{conversation_id}/subgroups`.
router.include_router(temas_router)
router.include_router(subgrupos_router)

#: Columnas que necesita una fila del listado. Se piden EXPLICITAS y no con
#: `select(Conversation)` porque un `select(Entidad)` trae todas las columnas
#: mapeadas: el dia que el modelo se adelante a la migracion, la consulta
#: revienta contra produccion pidiendo una columna que aun no existe.
_COLUMNAS_DE_CONVERSACION = (
    Conversation.id,
    Conversation.kind,
    Conversation.title,
    Conversation.updated_at,
)

#: «Esta conversacion tiene al menos un mensaje vivo».
#:
#: POR QUE EXISTE. Abrir el perfil de alguien y pulsar «Mensaje» CREA la
#: conversacion aunque despues no se escriba nada, porque la pantalla de chat
#: necesita un id al que ir. El resultado era que curiosear perfiles ensuciaba
#: la bandeja: filas con «Sin mensajes aun» de gente con la que nunca se ha
#: hablado. Una conversacion vacia no es una conversacion, es una intencion.
#:
#: `deleted_at is null` a proposito, y no por simetria: `ultimos_mensajes` y
#: `no_leidos` (ver `lectura.py`) tambien ignoran lo borrado. Sin esa condicion
#: aqui, un chat cuyos mensajes se borraron todos volveria a la bandeja
#: diciendo «Sin mensajes aun» —justo la fila que este filtro quita— y con el
#: contador de no leidos a cero. Con ella, las tres consultas cuentan LO MISMO:
#: si esta en la lista, hay algo que leer.
_TIENE_ALGUN_MENSAJE = (
    select(Message.id)
    .where(
        Message.conversation_id == Conversation.id,
        Message.deleted_at.is_(None),
    )
    .exists()
)

#: «Quien escribio el ultimo mensaje vigente de esta conversacion».
#:
#: MISMO ORDEN QUE `ultimos_mensajes` (ver `lectura.py`), y eso no es una
#: coincidencia que se pueda dejar suelta: si aqui se ordenara distinto, el
#: filtro «No respondidos» escogeria una conversacion por un mensaje y la fila
#: enseñaria otro. El desempate por `id` hace falta porque el `now()` de SQLite
#: tiene resolucion de SEGUNDO y varios mensajes seguidos comparten marca.
#:
#: Es una subconsulta CORRELACIONADA: viaja dentro de la consulta del listado y
#: NO añade ninguna consulta. Devuelve NULL cuando no hay mensajes vigentes, asi
#: que cualquier comparacion con ella deja fuera esas conversaciones — que es lo
#: correcto: una conversacion sin mensajes no esta «sin responder».
_ULTIMO_REMITENTE = (
    select(Message.sender_id)
    .where(
        Message.conversation_id == Conversation.id,
        Message.deleted_at.is_(None),
    )
    .order_by(Message.created_at.desc(), Message.id.desc())
    .limit(1)
    .correlate(Conversation)
    .scalar_subquery()
)

#: «Esta conversacion tiene algun mensaje que responde a una historia».
#:
#: El `join` contra `messages` no es adorno: sin el se contarian los contextos de
#: mensajes YA BORRADOS, y la conversacion saldria en el filtro por una respuesta
#: que ya no existe.
#:
#: SOLO SE USA SI LA 0044 ESTA APLICADA. Sin la tabla, tocarla seria un 500 —que
#: ademas sale sin cabeceras CORS y en el navegador parece un fallo de red—, asi
#: que el endpoint pregunta antes por `esquema.hay_respuestas_a_historias` y la
#: interfaz ni siquiera ofrece el filtro. Nunca un boton muerto.
_TIENE_RESPUESTA_A_HISTORIA = (
    select(MessageStoryContext.message_id)
    .join(Message, Message.id == MessageStoryContext.message_id)
    .where(Message.conversation_id == Conversation.id, Message.deleted_at.is_(None))
    .exists()
)


def _patron_de_busqueda(texto: str) -> str:
    """El texto buscado, convertido en un patron de `LIKE` que no muerde.

    `%` y `_` SON COMODINES EN SQL. Sin escaparlos, buscar «%» devolveria la
    bandeja entera y buscar «a_a» encontraria «ana», «ala» y «aja»: quien busca
    no sabe que ha escrito un comodin y la lista le miente sin avisar. La barra
    invertida se escapa primero, porque si no la que se añade despues se
    duplicaria.
    """
    limpio = texto.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{limpio}%"


#: A partir de cuantas letras se mira TAMBIEN dentro de los mensajes.
#:
#: Tres, y no es un numero redondo elegido al azar: `pg_trgm` indexa grupos de
#: TRES letras, asi que con una o dos el indice no puede ayudar y la busqueda
#: dentro del texto volveria a ser el recorrido secuencial que la 0046 vino a
#: evitar. Por debajo de ese umbral se busca por nombre y usuario, como siempre.
#:
#: Ademas es lo razonable de por si: «de» aparece en media aplicacion.
MIN_LETRAS_PARA_BUSCAR_EN_MENSAJES = 3


async def _condicion_de_busqueda(
    db: AsyncSession, uid: str, texto: str
) -> ColumnElement[bool]:
    """Buscar una conversacion POR NOMBRE, POR USUARIO Y POR LO QUE SE DIJO.

    LO QUE ARREGLA. La barra filtraba `conv.name.includes(...)` sobre las veinte
    filas que ya estaban en memoria: buscar a la persona de la conversacion
    numero veinticinco NO la encontraba, y encima se desactivaba la paginacion
    mientras habia texto. Con doscientas conversaciones, buscar entre las veinte
    que hay cargadas es mentirle a quien busca. Esto es una condicion mas en la
    consulta que YA se hacia: **cero consultas extra**, y `limit`/`offset` siguen
    contando las filas que de verdad quedan.

    EL ALIAS NO ES OPCIONAL. El listado ya lleva un `join` contra
    `ConversationMember` —el del que mira, para poder leer su `last_read_at`— y
    SQLAlchemy correlaciona sola cualquier tabla que ya este en el `FROM` de
    fuera. Sin `aliased`, este `exists` se ataria a esa MISMA fila y acabaria
    preguntando si el nombre de quien busca contiene el texto: siempre falso.

    DENTRO DE LOS MENSAJES, SOLO SI HAY INDICE. Un `ILIKE` contra `messages` —la
    tabla mas grande de la aplicacion— sin nada que lo sostenga es un recorrido
    secuencial en cada tecleo. Lo sostiene el indice trigram de la 0046, y
    mientras esa migracion no este aplicada esta parte NO SE AÑADE: la busqueda
    se queda exactamente como estaba, encontrando por nombre y por usuario. Ni un
    resultado distinto, ni una consulta de mas.

    Y NO ES UN `EXISTS` CORRELACIONADO, que es la forma en la que sale sola. Con
    el correlacionado, PostgreSQL entra por `conversation_id` y despues compara
    el texto fila a fila: el indice trigram no llega a usarse y el coste crece
    con los mensajes de cada conversacion de la pagina. Con un `IN` sobre una
    subconsulta independiente, el indice se recorre UNA vez para toda la
    consulta. Sigue siendo la misma sentencia, asi que no cambia el numero de
    consultas.

    LOS BORRADOS NO CUENTAN. Un mensaje con lapida (`deleted_at`) conserva su
    texto en la fila para que el historial pueda enseñar «mensaje eliminado» en
    su sitio, pero encontrarlo al buscar seria devolverle a alguien justo lo que
    decidio quitar.
    """
    patron = _patron_de_busqueda(texto)
    # `aliased` y no `ConversationMember` a secas: ver el parrafo de arriba.
    otro_miembro = aliased(ConversationMember)
    coincide_el_otro = (
        select(otro_miembro.conversation_id)
        .join(Profile, Profile.id == otro_miembro.user_id)
        .where(
            otro_miembro.conversation_id == Conversation.id,
            otro_miembro.user_id != uid,
            or_(
                Profile.full_name.ilike(patron, escape="\\"),
                Profile.username.ilike(patron, escape="\\"),
            ),
        )
        .correlate(Conversation)
        .exists()
    )
    # En un grupo no hay «el otro»: el nombre lo pone el titulo, asi que se busca
    # tambien ahi o los grupos serian inencontrables.
    criterios = [coincide_el_otro, Conversation.title.ilike(patron, escape="\\")]

    if len(texto.strip()) >= MIN_LETRAS_PARA_BUSCAR_EN_MENSAJES and (
        await esquema.hay_busqueda_en_mensajes(db)
    ):
        # Subconsulta INDEPENDIENTE, no correlacionada: ver el docstring. No hace
        # falta acotarla a las conversaciones de quien busca porque la consulta
        # de fuera ya lo hace —esta unida a su propia fila de
        # `conversation_members`—, asi que esto solo puede AÑADIR conversaciones
        # que ya le pertenecen.
        conversaciones_con_el_texto = select(Message.conversation_id).where(
            Message.deleted_at.is_(None),
            Message.body.ilike(patron, escape="\\"),
        )
        criterios.append(Conversation.id.in_(conversaciones_con_el_texto))

    return or_(*criterios)


def _condicion_no_leidos(uid: str) -> ColumnElement[bool]:
    """«Hay mensajes de la otra persona posteriores a mi `last_read_at`».

    CERO CONSULTAS EXTRA. Se apoya en el `ConversationMember` que el listado YA
    tiene unido —el de quien mira— para leer su umbral, exactamente como hace
    `no_leidos` en `lectura.py`. Aqui la correlacion automatica de SQLAlchemy SI
    es la que se quiere, al reves que en la busqueda: esa fila es justo la que
    hace falta.

    `last_read_at` a nulo significa «nunca ha abierto esta conversacion», y
    entonces cuenta todo lo que no haya escrito ella misma. El criterio es el
    MISMO que el del contador de la fila: sin eso, una conversacion podria salir
    en el filtro con el globo a cero, o al reves.
    """
    return (
        select(Message.id)
        .where(
            Message.conversation_id == Conversation.id,
            Message.sender_id != uid,
            Message.deleted_at.is_(None),
            or_(
                ConversationMember.last_read_at.is_(None),
                Message.created_at > ConversationMember.last_read_at,
            ),
        )
        .correlate(Conversation, ConversationMember)
        .exists()
    )


async def _condicion_de_filtro(
    db: AsyncSession, *, uid: str, filtro: str
) -> ColumnElement[bool]:
    """El `WHERE` de cada filtro derivado de la bandeja.

    LOS TRES VAN DENTRO DE LA CONSULTA QUE YA SE HACE, no sobre lo ya descargado:
    filtrar en el telefono cuesta cero peticiones pero solo ve las veinte filas
    de la primera pagina, que es el mismo engaño que tenia la busqueda. Asi
    siguen funcionando `limit` y `offset`.

    Coste: `unread` y `unanswered` son **+0 consultas** (subconsultas
    correlacionadas); `story_replies` tambien, mas la comprobacion de esquema,
    que se cachea por proceso.
    """
    if filtro == "unread":
        return _condicion_no_leidos(uid)
    if filtro == "unanswered":
        # «El ultimo mensaje vigente lo mando la otra persona y yo no he escrito
        # nada despues» es exactamente «el ultimo mensaje no es mio».
        return _ULTIMO_REMITENTE != uid
    if filtro == "story_replies":
        if not await esquema.hay_respuestas_a_historias(db):
            # Sin la 0044 no hay nada que filtrar. Se devuelve la lista VACIA y
            # no un 503: la interfaz no ofrece el filtro (lo pregunta antes por
            # `/availability`), asi que llegar aqui significa un cliente viejo o
            # una URL escrita a mano, y para ese caso «no hay ninguna» es la
            # verdad. Lo que no puede pasar es consultar una tabla que no existe.
            return false()
        return _TIENE_RESPUESTA_A_HISTORIA
    # `filtro` viene validado por el patron de `Query`, asi que esto no deberia
    # alcanzarse; sin filtro, no se filtra.
    return true()


def _clave_de_pareja(uno: str, otro: str) -> tuple[str, str]:
    """Los dos identificadores de un chat directo, SIEMPRE en el mismo orden.

    Es lo que convierte «la pareja» en una clave. Sin normalizar, (Ana, Bruno) y
    (Bruno, Ana) serian dos claves distintas y la restriccion de la 0039 no
    impediria nada: bastaria con que cada uno pulsara desde su lado.

    Pasa por `UUID` y no compara las cadenas tal cual porque el mismo
    identificador se escribe de varias formas —mayusculas, sin guiones— y dos
    formas distintas del MISMO par volverian a ser dos claves. `str(UUID(...))`
    devuelve siempre la forma canonica en minusculas.
    """
    a, b = str(UUID(uno)), str(UUID(otro))
    return (a, b) if a <= b else (b, a)


def _author(profile: Profile) -> AuthorSummary:
    return AuthorSummary(
        id=profile.id,
        full_name=profile.full_name,
        username=profile.username,
        avatar_path=profile.avatar_path,
    )


async def _require_member(
    db: AsyncSession, conversation_id: str, uid: str
) -> ConversationMember:
    member = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if member is None:
        raise ForbiddenError("No perteneces a esta conversación.")
    return member


def _validar_rutas(
    adjuntos: list[AttachmentCreate], conversation_id: str, uid: str
) -> None:
    """Que cada archivo viva donde dice vivir. Es la mitad de la privacidad.

    Los bytes se suben directamente a Storage desde la aplicación; aquí solo
    llega la RUTA. Sin esta comprobación, un miembro de esta conversación podría
    registrar como adjunto suyo la ruta de un archivo de OTRA conversación, y
    aunque Storage le negaría los bytes, el listado de este chat pasaría a
    enseñar el nombre del fichero y su tamaño a quien no debe verlos. Peor: al
    resto de miembros, que sí pueden leer todo lo que cuelga de su carpeta, les
    quedaría accesible un archivo ajeno.

    La forma obligatoria es la misma que exige la política RLS del bucket:

        <id de conversacion>/<id de quien sube>/<fichero>

    El identificador viene del JWT, nunca del cuerpo de la petición.
    """
    prefijo = f"{conversation_id}/{uid}/"
    for adjunto in adjuntos:
        ruta = adjunto.storage_path
        if not ruta.startswith(prefijo) or len(ruta) <= len(prefijo):
            raise ValidationAppError(
                "La ruta del adjunto no corresponde a esta conversación.",
                code="attachment_path_invalid",
            )
        # `..` escaparía de la carpeta al resolverse en algunos clientes, y una
        # barra de más produce nombres que la política de Storage lee distinto.
        resto = ruta[len(prefijo) :]
        if ".." in resto or "/" in resto:
            raise ValidationAppError(
                "La ruta del adjunto no es válida.",
                code="attachment_path_invalid",
            )


async def _exigir_esquema_de_adjuntos(db: AsyncSession) -> None:
    """503 mientras la 0033 espere aprobación, nunca un 500.

    503 y no 404: la ruta existe y está bien escrita, lo que falta es que la
    migración esté puesta. Y con un código propio para que la aplicación pueda
    decir «los archivos todavía no están disponibles» en vez de un error
    genérico.
    """
    if not await esquema.hay_adjuntos_de_chat(db):
        raise ServiceUnavailableError(
            "Todavía no se pueden enviar archivos por el chat.",
            code="chat_attachments_not_available",
        )


def _exigir_titulo_valido(titulo: str | None) -> None:
    """422 si el nombre, ya recortado, tiene caracteres de control o pasa de 80.

    Aqui y no en Pydantic para que cada caso tenga su codigo y la aplicacion
    pueda decir que pasa junto al campo, en vez de un error generico de datos.
    Se comprueba SIEMPRE, este o no la 0113: la misma peticion no puede valer
    en un servidor y no en otro segun una migracion que quien escribe no ve.

    LOS CARACTERES DE CONTROL (categoria Unicode `Cc`: `\n`, `\r`, `\t`,
    `\u0000`…) SE RECHAZAN, `attachment_title_invalid`. Un nombre es una
    linea: un salto partiria la tarjeta y la fila de la bandeja, un tabulador
    se pinta distinto en cada sitio, y `\u0000` ni siquiera llega a la base
    —PostgreSQL no admite NUL en `text` y asyncpg lo convierte en un 500—. Se
    mira DESPUES de recortar: un salto de linea pegado al final, lo que deja
    un teclado al pulsar «Listo», se quita sin molestar a nadie; uno en medio
    no es un descuido que se pueda arreglar por quien lo escribio.
    """
    if titulo is None:
        return
    if any(unicodedata.category(letra) == "Cc" for letra in titulo):
        raise ValidationAppError(
            "El nombre no puede tener saltos de línea ni caracteres de control.",
            code="attachment_title_invalid",
        )
    if len(titulo) > MAX_TITULO_DE_ADJUNTO:
        raise ValidationAppError(
            f"El nombre puede tener hasta {MAX_TITULO_DE_ADJUNTO} caracteres.",
            code="attachment_title_too_long",
        )


async def _puede_retocar_el_mensaje(
    db: AsyncSession, conversation_id: str, remitente: str, uid: str
) -> bool:
    """Quien escribio el mensaje, quien administra la conversacion o la moderacion.

    ES LA REGLA DE BORRAR (`borrar_mensaje`), y ponerle nombre a un adjunto
    usa LA MISMA, en una sola funcion: si un dia cambia quien administra (los
    co-administradores), cambian las dos a la vez y no puede quedar una
    persona que borra un audio pero no puede ponerle nombre, o al reves.
    """
    return (
        str(remitente) == str(uid)
        or await _administra_la_conversacion(db, conversation_id, uid)
        or await is_admin(db, uid)
    )


async def _leer_una(db: AsyncSession, conversation_id: str, uid: str) -> ConversationRead:
    """Una conversacion concreta, con el mismo camino que el listado.

    Reutilizar el lector por lotes para una sola fila no es rebuscado: evita
    tener dos formas distintas de construir la MISMA respuesta, que es como
    acaban divergiendo (una arregla un fallo y la otra no).
    """
    fila = (
        await db.execute(
            select(*_COLUMNAS_DE_CONVERSACION).where(Conversation.id == conversation_id)
        )
    ).one_or_none()
    if fila is None:
        raise NotFoundError("Conversación no encontrada.")
    return (await leer_conversaciones(db, [fila], uid))[0]


async def _exigir_que_pueda_escribir_en_el_tema(
    db: AsyncSession, conversation_id: str, uid: str
) -> None:
    """403 `topic_admin_only` si es el chat de un tema y no administra su grupo.

    Se mira el GRUPO y no el `created_by` del chat, aunque hoy coincidan: quien
    manda en un tema es quien administra el grupo, y el dia que eso cambie se
    cambia en `vistas.administra` y lo aprende esto sin tocarlo.
    """
    tema = await grupos.tema_del_chat(db, conversation_id)
    if tema is None:
        return
    fila = (
        await db.execute(
            select(Conversation.kind, Conversation.created_by).where(
                Conversation.id == tema[0]
            )
        )
    ).one_or_none()
    if fila is None or not administra(fila.kind, fila.created_by, uid):
        raise ForbiddenError(
            "En un tema solo escribe quien administra el grupo.",
            code="topic_admin_only",
        )


async def _administra_la_conversacion(
    db: AsyncSession, conversation_id: str, uid: str
) -> bool:
    """Si `uid` administra esta conversacion (`vistas.administra`).

    En una comunidad y en el chat de un tema da lo mismo que en su grupo: los
    crea quien administra el grupo, asi que su `created_by` es esa persona.
    """
    fila = (
        await db.execute(
            select(Conversation.kind, Conversation.created_by).where(
                Conversation.id == conversation_id
            )
        )
    ).one_or_none()
    return fila is not None and administra(fila.kind, fila.created_by, uid)


@router.get("/availability", response_model=MessagingAvailability)
async def messaging_availability(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MessagingAvailability:
    """Que funciones del chat existen en ESTA instalacion. NUNCA UN BOTON MUERTO.

    POR QUE SE PREGUNTA EN VEZ DE PROBAR. Sin esto, la unica forma de saber si
    se puede mandar una nota de voz seria grabarla, subirla y recibir un 503: el
    boton pareceria funcionar, alguien hablaria treinta segundos y lo perderia
    todo. Se pregunta antes de pintar el microfono y, mientras la respuesta sea
    `false`, no se ofrece grabar.

    Lo mismo vale para el filtro «Respuestas a historias» de la bandeja: sin la
    0044 no hay nada que filtrar, y un filtro que siempre devuelve vacio es un
    boton muerto.

    SE DECLARA ANTES QUE LAS DEMAS RUTAS a proposito. FastAPI prueba en orden de
    declaracion, asi que el dia que alguien añada un `GET /{conversation_id}`
    aqui, `/availability` seguiria leyendose como lo que es y no como el id de
    una conversacion. Es la misma precaucion que ya se tomo con el sub-router de
    etiquetas.

    LAS DOS SALEN DE LA MISMA MIGRACION y aun asi se mandan por separado: son
    dos funciones distintas para quien las usa, y el dia que una se despliegue
    sin la otra la aplicacion no tendra que adivinarlo. `current_user` esta
    aunque no se use: esto describe el servidor, pero no tiene por que
    contarselo a quien no ha iniciado sesion.
    """
    disponible = await esquema.hay_notas_de_voz(db)
    return MessagingAvailability(
        voice_notes=disponible,
        story_replies=await esquema.hay_respuestas_a_historias(db),
        reactions=await esquema.hay_reacciones_y_respuestas(db),
        preferences=await esquema.hay_preferencias_de_conversacion(db),
        # No depende de ninguna migración: sale de `last_read_at`, que existe
        # desde la 0001. Se anuncia igual para que una aplicación nueva contra
        # un servidor anterior a esto no pinte marcas que nadie le va a dar.
        read_receipts=True,
        topics=await esquema.hay_temas(db),
        subgroups=await esquema.hay_comunidades(db),
        # Con la misma comprobacion cacheada que usa todo lo demas de la 0113:
        # lo que se anuncia aqui es exactamente lo que el envio y el PATCH van
        # a aceptar.
        attachment_titles=await esquema.hay_nombres_de_adjuntos(db),
    )


@router.get("", response_model=list[ConversationRead])
async def list_conversations(
    q: str | None = Query(default=None, max_length=MAX_BUSQUEDA),
    filtro: str | None = Query(default=None, pattern="^(unread|unanswered|story_replies)$"),
    label_id: str | None = Query(default=None, max_length=64),
    grouped: bool = Query(default=False),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationRead]:
    """Las conversaciones de quien pregunta, de la mas reciente a la mas antigua.

    BUSCAR Y FILTRAR ES COSA DEL SERVIDOR, y los tres parametros nuevos existen
    por eso. Antes la pantalla filtraba `nombre.includes(texto)` sobre las veinte
    filas ya descargadas: con doscientas conversaciones eso encuentra lo que haya
    tenido la suerte de caber en la primera pagina y calla el resto. Los tres
    entran en la consulta que YA se hacia, asi que `limit` y `offset` siguen
    contando filas de verdad.

    - `q` — busca por nombre y por usuario de la otra persona (y por el titulo,
      en los grupos). **+0 consultas.**
    - `filtro` — `unread` | `unanswered` | `story_replies`. Son ESTADOS
      DERIVADOS: se calculan de los mensajes y cambian solos. **+0 consultas.**
    - `label_id` — una etiqueta del CRM, que es una CATEGORIA PERSISTENTE que
      pone una persona. **+1 consulta** (comprobar que la etiqueta es suya), y
      esa una no depende del tamaño de la pagina.

    `filtro` y `label_id` son EJES DISTINTOS y se pueden combinar («no leidos
    entre los que marque como Alumnos»). Lo que no se hace es guardar «no leido»
    como una etiqueta manual: mezclar un estado derivado con una categoria que
    nadie vuelve a desmarcar es lo que convierte un CRM en un cajon de sastre.

    PAGINADO. Antes se traian TODAS: quien acumulaba conversaciones pagaba la
    lista entera cada vez que abria la pestana, para ver diez filas. Ahora se
    piden las que caben en una pantalla y el resto se va trayendo al bajar.

    LOS CHATS DIRECTOS VACIOS NO SALEN. Ver `_TIENE_ALGUN_MENSAJE`: pulsar
    «Mensaje» en un perfil crea la conversacion aunque luego no se escriba, y
    eso llenaba la bandeja de filas «Sin mensajes aun». El filtro va AQUI, en la
    consulta, y no en la pantalla, por tres motivos: la paginacion cuenta filas
    (filtrar despues devolveria paginas de tres elementos y un «hay mas» que
    miente), quien lo esconda tiene que ser el mismo sitio que decide el orden,
    y el telefono no puede saber si una fila vacia se quedara vacia. En cuanto
    alguien escribe, la conversacion aparece sola: no hace falta nada mas.

    Los GRUPOS si salen vacios, y no es un olvido. Un grupo se crea a proposito
    y con un titulo, asi que existe aunque nadie haya hablado todavia; un chat
    directo vacio solo dice que alguien miro un perfil.

    EL COSTE SIGUE SIENDO CONSTANTE, que es la garantia que costo ganarla y no
    se puede perder aqui. Medido: cuatro consultas con tres conversaciones y
    cuatro con ochenta. Con lo nuevo son **cinco** —la quinta son las etiquetas
    de la pagina con un `IN`, ver `lectura.py`— y **seis** cuando ademas se
    filtra por etiqueta. Ninguna de las dos depende de cuantas filas haya: siguen
    siendo cinco y seis con tres conversaciones y con ochenta. Todo lo demas son
    `exists` correlacionados dentro de la consulta que ya se hacia.

    Y NO SE BAJA EL TAMAÑO DE PAGINA: esta medido que son cuatro consultas con
    `limit=10` y con `limit=80`, asi que bajarlo no compra nada en el servidor y
    solo obliga a paginar antes.

    LOS CHATS DE LOS TEMAS NO SALEN NUNCA. Son conversaciones de verdad —para
    que adjuntos, Realtime y avisos funcionen sin tocarlos—, pero viven dentro
    de su grupo: en la bandeja serian un grupo fantasma por cada tema.

    `grouped=true` lo manda la aplicacion nueva, que pinta las comunidades
    DENTRO de su grupo (D12): no salen sueltas, y cada grupo trae cuantos temas
    y comunidades tiene y un `total_unread` que suma lo de dentro. Sin
    `grouped` —las versiones ya instaladas, que no saben abrir una comunidad
    desde su grupo— salen como grupos normales para que nadie pierda el acceso,
    y `total_unread` es `unread_count`. Las dos exclusiones son `NOT EXISTS`
    dentro de la consulta de siempre: +0 consultas. Lo de dentro se lee por
    lotes en `lectura.py`.
    """
    condiciones = [
        ConversationMember.user_id == current_user.id,
        or_(Conversation.kind != "direct", _TIENE_ALGUN_MENSAJE),
    ]
    if await esquema.hay_temas(db):
        condiciones.append(temas.condicion_no_es_chat_de_tema(Conversation.id))
    if grouped and await esquema.hay_comunidades(db):
        condiciones.append(subgrupos.condicion_no_es_comunidad(Conversation.id))

    # `strip()` porque un espacio suelto no es una busqueda: sin esto, tocar la
    # barra y borrar dejaria un `q=" "` que no encuentra a nadie y vacia la
    # bandeja sin que se vea por que.
    texto = (q or "").strip()
    if texto:
        condiciones.append(await _condicion_de_busqueda(db, current_user.id, texto))

    if filtro:
        condiciones.append(await _condicion_de_filtro(db, uid=current_user.id, filtro=filtro))

    if label_id:
        # Devuelve `false()` —ninguna conversacion— si la etiqueta no es de quien
        # pregunta, si no existe, si el identificador no es un UUID o si la 0045
        # no esta aplicada. Los cuatro responden lo mismo a proposito: poder
        # distinguirlos permitiria averiguar que etiquetas existen probando
        # identificadores, sin llegar a leer ninguna.
        condiciones.append(
            await condicion_de_etiqueta(db, uid=current_user.id, label_id=label_id)
        )

    filas = (
        await db.execute(
            select(*_COLUMNAS_DE_CONVERSACION)
            .join(
                ConversationMember,
                ConversationMember.conversation_id == Conversation.id,
            )
            .where(*condiciones)
            # Desempate por id: `updated_at` puede repetirse (en SQLite tiene
            # resolucion de segundo) y sin un segundo criterio una misma fila
            # podria salir en dos paginas o en ninguna.
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return await leer_conversaciones(db, filas, current_user.id, agrupado=grouped)


async def _buscar_directa(db: AsyncSession, uid: str, otro_id: str) -> str | None:
    """La conversacion directa que YA existe entre dos personas, o None.

    ORDENADA A PROPOSITO aunque solo se quiera una. Antes era `limit(1)` sin
    orden: si por lo que fuera existieran dos conversaciones para la misma
    pareja —el fallo que cierra la 0039, y que ya pudo dejar duplicados
    historicos—, el motor podia devolver hoy una y manana la otra, y la persona
    veria su chat cambiar de contenido segun le pareciera al planificador.

    Se elige SIEMPRE la mas antigua: es la que tiene el historial. El desempate
    por `id` no es adorno, porque `created_at` en SQLite tiene resolucion de
    segundo y dos conversaciones creadas por un doble toque comparten marca.
    """
    m1 = aliased(ConversationMember)
    m2 = aliased(ConversationMember)
    return (
        await db.execute(
            select(Conversation.id)
            .join(m1, m1.conversation_id == Conversation.id)
            .join(m2, m2.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "direct",
                m1.user_id == uid,
                m2.user_id == otro_id,
            )
            .order_by(Conversation.created_at.asc(), Conversation.id.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _crear_directa(db: AsyncSession, uid: str, otro_id: str) -> str:
    """Crea el chat directo, o devuelve el que gano la carrera.

    AQUI ESTABA EL FALLO. `buscar y si no crear` no es atomico: dos peticiones
    simultaneas —un doble toque, o un toque mas el reintento de una red lenta—
    hacen las dos el SELECT, las dos no encuentran nada, y las dos insertan. La
    bandeja acababa mostrando a la misma persona varias veces.

    LA GARANTIA LA PONE LA BASE, no este codigo. Con la 0039 aplicada, la clave
    primaria de `direct_conversation_pairs` hace que la SEGUNDA insercion de la
    misma pareja sea imposible: la perdedora recibe un error de integridad. Lo
    que aporta esta funcion es que ese error no se lo coma nadie: se
    deshace la transaccion, se vuelve a buscar —y ahora si esta, porque el
    conflicto solo salta cuando la ganadora ya ha confirmado— y se devuelve la
    conversacion de la ganadora. Las dos peticiones responden lo mismo.

    SIN LA 0039 esto sigue funcionando y no empeora nada: no hay restriccion que
    violar, asi que no hay `IntegrityError` que capturar y el comportamiento es
    el de hoy. La proteccion que queda es la del cliente (el cerrojo `chatBusy`
    de `ProfileScreen`), que es de un solo telefono y no cubre el reintento de
    la red. Por eso la garantia de verdad necesita la migracion.

    EL FLUSH EXPLICITO ANTES DE `registrar_senal` NO ES ADORNO, y costo un fallo
    en pruebas encontrarlo. `signals.py` se traga sus errores a proposito —anotar
    una senal no puede tumbar la operacion que la provoco— pero su consulta
    dispara el AUTOFLUSH de la sesion, asi que sin este flush la violacion de
    clave saltaba DENTRO de `registrar_senal`, que la capturaba y la registraba
    como «no se pudo anotar la senal». La sesion quedaba muerta y el `commit` de
    despues fallaba con `PendingRollbackError` —que NO es `IntegrityError`—, o
    sea: un 500 en la cara del usuario por el fallo que esto arregla. Se fuerza
    la escritura aqui, donde el error tiene quien lo espere.
    """
    con_pares = await esquema.hay_pares_directos(db)
    try:
        conv = Conversation(kind="direct", created_by=uid)
        db.add(conv)
        await db.flush()
        db.add(ConversationMember(conversation_id=conv.id, user_id=uid))
        db.add(ConversationMember(conversation_id=conv.id, user_id=otro_id))
        if con_pares:
            bajo, alto = _clave_de_pareja(uid, otro_id)
            db.add(
                DirectConversationPair(
                    user_low=bajo, user_high=alto, conversation_id=conv.id
                )
            )
        # Aqui, y no en el commit, es donde se decide quien gana la carrera.
        await db.flush()
        # Solo cuando la conversacion se CREA. Abrir un chat que ya existia no
        # es una decision nueva, y contarla cada vez que se entra convertiria
        # una senal fuerte en ruido.
        await registrar_senal(
            db,
            user_id=uid,
            event_type="message_started",
            entity_type="profile",
            entity_id=otro_id,
        )
        await db.commit()
    except IntegrityError:
        # Perder la carrera no es un error para quien esta mirando: queria un
        # chat con esa persona y hay exactamente uno. Se le da ese.
        await db.rollback()
        ganadora = await _buscar_directa(db, uid, otro_id)
        if ganadora is None:
            # No deberia ocurrir: el conflicto implica que otra transaccion ya
            # confirmo la pareja. Si aun asi pasa, 409 y no 500: el cliente
            # puede reintentar, y un 500 saldria en el movil como fallo de red.
            raise ConflictError(
                "No se pudo abrir la conversación. Inténtalo de nuevo.",
                code="direct_conversation_race",
            ) from None
        return ganadora
    return conv.id


async def conversacion_directa(db: AsyncSession, uid: str, otro_id: str) -> str:
    """El chat directo entre dos personas: el que hay, o uno nuevo.

    Para quien necesita la conversacion SIN ser la pantalla de chat —la agenda,
    que deja en ella la solicitud de una sesion—. Es exactamente lo que hace
    `POST /conversations/direct`, sin la respuesta.

    OJO: SI LA CREA, CONFIRMA SU PROPIA TRANSACCION (`_crear_directa`). Hay que
    llamarla ANTES de empezar a escribir lo propio, no en medio.
    """
    existente = await _buscar_directa(db, uid, otro_id)
    if existente is not None:
        return existente
    return await _crear_directa(db, uid, otro_id)


@router.post("/direct", response_model=ConversationRead)
async def get_or_create_direct(
    payload: DirectConversationCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationRead:
    """Abre el chat directo con alguien. IDEMPOTENTE: siempre la misma.

    Abrirlo tres veces, o cien, devuelve la misma conversacion. Lo que lo
    garantiza no es el orden de estas lineas —eso es lo que fallaba— sino la
    clave primaria de `direct_conversation_pairs` (migracion 0039); ver
    `_crear_directa`.

    Entrar aqui y no escribir NO deja rastro en la bandeja: la conversacion se
    crea, porque la pantalla de chat necesita un id, pero el listado no muestra
    los chats directos sin mensajes. Ver `_TIENE_ALGUN_MENSAJE`.
    """
    # Antes de tocar la base: un id con otro formato llegaba hasta el driver y
    # salia como 500. Es un 404, que es lo que de verdad pasa.
    ensure_uuid(payload.user_id, "Perfil no encontrado.")
    if payload.user_id == current_user.id:
        raise ValidationAppError("No puedes iniciar una conversación contigo mismo.")
    target = await db.get(Profile, payload.user_id)
    if target is None:
        raise NotFoundError("Perfil no encontrado.")

    conv_id = await _buscar_directa(db, current_user.id, payload.user_id)
    if conv_id is None:
        conv_id = await _crear_directa(db, current_user.id, payload.user_id)

    await _require_member(db, conv_id, current_user.id)
    return await _leer_una(db, conv_id, current_user.id)


@router.get("/{conversation_id}/messages", response_model=list[MessageRead])
async def list_messages(
    conversation_id: str,
    before: datetime | None = Query(
        default=None,
        description="Trae solo mensajes anteriores a este instante (historial).",
    ),
    after: datetime | None = Query(
        default=None,
        description="Trae solo mensajes posteriores a este instante (novedades).",
    ),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MessageRead]:
    """El historial, del mas antiguo al mas reciente dentro de la pagina.

    PAGINADO POR INSTANTE Y NO POR POSICION. `offset` sigue admitido, pero para
    ir hacia atras el movil manda `before` con la fecha del mensaje mas antiguo
    que ya tiene. La diferencia importa aqui y no en un catalogo: mientras
    alguien lee, siguen ENTRANDO mensajes nuevos por arriba, y cada uno desplaza
    la ventana un puesto. Con `offset` eso repite o se salta mensajes al pedir
    la pagina siguiente; con un instante fijo, lo que ya paso no se mueve.

    `after` es el camino contrario y existe por los ADJUNTOS. Realtime entrega
    la fila cruda de `messages`, que no sabe nada de los archivos que cuelgan de
    ella: la burbuja de texto sale al instante, pero para completar sus adjuntos
    hace falta preguntar. Con `after` se piden de una vez todas las novedades
    desde el ultimo mensaje conocido, en lugar de una peticion por mensaje. De
    paso repara el hueco cuando Realtime se pierde algo —el telefono estuvo en
    segundo plano, el canal se cayo— sin recargar el historial entero.

    Los autores se resuelven con un JOIN y los adjuntos con UNA consulta para
    todos los mensajes de la pagina: el historial no crece en consultas.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    await _require_member(db, conversation_id, current_user.id)

    # De que tipo es la conversacion, DENTRO de la consulta de los mensajes:
    # una subconsulta sin correlacion, que PostgreSQL resuelve una vez (por
    # clave primaria) y no por fila. Solo sirve para no preguntar por los
    # temas en un chat de dos, que no puede tenerlos: es lo mas abierto de
    # la aplicacion y asi no paga una consulta por algo que nunca tendra.
    tipo_de_chat = (
        select(Conversation.kind)
        .where(Conversation.id == conversation_id)
        .scalar_subquery()
        .label("tipo_de_chat")
    )
    consulta = (
        select(
            Message.id,
            Message.conversation_id,
            Message.body,
            Message.created_at,
            Message.deleted_at,
            Profile.id,
            Profile.full_name,
            Profile.username,
            Profile.avatar_path,
            tipo_de_chat,
        )
        .join(Profile, Profile.id == Message.sender_id)
        # LO BORRADO SÍ SALE, y esto es lo que cambió. Antes se filtraba aquí y
        # el mensaje desaparecía sin dejar hueco: quien estaba al otro lado
        # había leído algo que de pronto no estaba, sin saber que se había
        # borrado ni que hubo nada ahí. Ahora sale la LÁPIDA —la marca y nada
        # más— y la aplicación escribe «Mensaje eliminado».
        #
        # El texto NO viaja: se vacía unas líneas más abajo. Borrar para todos
        # tiene que borrar de verdad para todos, incluido un cliente que no sea
        # el nuestro.
        #
        # La BANDEJA sigue ignorando lo borrado (`_TIENE_ALGUN_MENSAJE`,
        # `ultimos_mensajes`, `no_leidos`) y no es una incoherencia: una lápida
        # no es algo pendiente de leer, así que no puede contar como no leído ni
        # devolver a la bandeja un chat que se vació.
        .where(Message.conversation_id == conversation_id)
    )
    if before is not None:
        consulta = consulta.where(Message.created_at < before)
    if after is not None:
        consulta = consulta.where(Message.created_at > after)
    # LO QUE ESTA PERSONA VACIO NO SE LE ENSEÑA. Es suyo: a los demas
    # miembros el historial les sale entero. Ver `preferencias.py`.
    vaciado = await preferencias.vaciado_desde(db, conversation_id, current_user.id)
    if vaciado is not None:
        consulta = consulta.where(Message.created_at > vaciado)

    rows = (
        await db.execute(
            consulta.order_by(Message.created_at.desc(), Message.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    # Los adjuntos de TODOS los mensajes de la pagina, de una vez. Sin la 0033
    # devuelve el diccionario vacio y cada mensaje sale con `attachments: []`,
    # que es la verdad: no hay adjuntos.
    #
    # Los de un mensaje borrado NI SE PIDEN: no hay que enseñarlos, así que
    # tampoco hay que traerlos. Los ficheros del bucket se quedan donde están
    # (ver la nota de `borrar_mensaje`), pero su existencia no se cuenta.
    vivos = [fila[0] for fila in rows if fila[4] is None]
    adjuntos = await adjuntos_por_mensaje(db, vivos)

    # El contexto de historia de toda la página, también en UNA consulta y por
    # el mismo motivo que los adjuntos: preguntarlo por burbuja convertiría
    # abrir un chat en treinta viajes a la base. Sin la 0044 devuelve `{}` y
    # cada mensaje sale con `story_context: null`, que es la verdad.
    #
    # Los de un mensaje borrado NI SE PIDEN, igual que sus adjuntos: una lápida
    # no enseña a qué respondía. Decirlo sería filtrar parte de lo que su autor
    # acaba de retirar.
    contextos = await historias.contextos_por_mensaje(db, vivos)

    # Y la sesion 1:1 de la que hable cada mensaje, con su estado de AHORA.
    # Tambien una consulta para toda la pagina; sin la 0097, `{}`.
    de_sesion = await sesiones.contextos_por_mensaje(db, vivos, current_user.id)

    # Las reacciones y las citas de la página, también por lotes. Sin la
    # 0106, las dos devuelven `{}` sin tocar la base. Las de un mensaje
    # borrado no se piden.
    reacciones_de = await reacciones.reacciones_por_mensaje(db, vivos, current_user.id)
    citas = await reacciones.respuestas_por_mensaje(db, vivos)

    # En que temas esta cada mensaje: la etiqueta bajo la burbuja. También por
    # lotes, y solo en un grupo —los temas son de General de una comunidad;
    # en un chat de dos no se pregunta—. Las lapidas no llevan etiqueta.
    en_temas = (
        await temas.temas_por_mensaje(db, conversation_id, vivos)
        if rows and rows[0].tipo_de_chat == "group"
        else {}
    )

    # Devolvemos en orden cronológico ascendente (más antiguos primero).
    return [
        MessageRead(
            id=msg_id,
            conversation_id=conv_id,
            sender=AuthorSummary(
                id=pid, full_name=full_name, username=username, avatar_path=avatar_path
            ),
            # LA LÁPIDA NO LLEVA EL TEXTO. Vaciarlo aquí, en el servidor, y no
            # esconderlo en la pantalla: lo que no sale de aquí no lo puede leer
            # nadie, y lo que sale acaba viéndose antes o después —en otro
            # cliente, en la respuesta cruda, en un registro—.
            body="" if borrado_en is not None else body,
            created_at=created_at,
            deleted_at=borrado_en,
            attachments=adjuntos.get(msg_id, []),
            story_context=contextos.get(msg_id),
            booking_context=de_sesion.get(msg_id),
            reactions=reacciones_de.get(msg_id, []),
            reply_to=citas.get(msg_id),
            topics=en_temas.get(str(msg_id), []),
        )
        for (
            msg_id,
            conv_id,
            body,
            created_at,
            borrado_en,
            pid,
            full_name,
            username,
            avatar_path,
            _tipo,
        ) in reversed(rows)
    ]


@router.post(
    "/{conversation_id}/messages",
    response_model=MessageRead,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    conversation_id: str,
    payload: MessageCreate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MessageRead:
    """Guarda un mensaje: solo texto, solo archivos, o las dos cosas.

    Los bytes NO pasan por aquí. La aplicación sube al bucket `message-media`
    con su propio token —que es lo que permite subir un vídeo por trozos
    reanudables sin que la API sostenga la conexión— y esta petición solo
    registra las rutas, después de comprobar que apuntan a esta conversación y a
    la carpeta de quien las manda.

    UNA NOTA DE VOZ ENTRA POR AQUI COMO CUALQUIER OTRO ADJUNTO, con
    `kind: audio`. Lo único propio son sus reglas (`audio.py`): que la 0044 esté
    aplicada —si no, 503 y no la violación de restricción que sería un 500— y
    que traiga duración.

    UN ARCHIVO DE AUDIO TAMBIÉN (30/10/2026): `kind: audio` con
    `voice_note: false`, para que se escuche en el chat en vez de descargarse,
    sin las reglas de una nota de voz (ver `audio.validar_audio`). Y cada
    adjunto puede traer su NOMBRE (`title`, 0113), que se guarda recortado y
    se ignora en una foto. Sin la 0113 el nombre se ignora y todo audio es
    nota de voz: ver `esquema.hay_nombres_de_adjuntos`.

    Y UNA RESPUESTA A UNA HISTORIA TAMBIEN ENTRA POR AQUI, con `story_id` en el
    cuerpo. No hay un endpoint aparte a propósito: duplicar el envío obligaría a
    mantener dos rutas que hacen exactamente lo mismo con los adjuntos, la
    validación, el `updated_at` y Realtime, y esas dos rutas divergen —una
    arregla un fallo y la otra no—. La conversación tampoco se crea aquí: el
    móvil pasa antes por `POST /conversations/direct`, que ya es idempotente
    gracias a la 0039.

    EN EL CHAT DE UN TEMA SOLO ESCRIBE QUIEN ADMINISTRA EL GRUPO (D11): los
    miembros leen los temas pero no escriben en ellos. A los demas, 403
    `topic_admin_only`, aunque sean miembros de ese chat —lo son, para poder
    leerlo y recibir sus avisos—.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    await _require_member(db, conversation_id, current_user.id)
    await _exigir_que_pueda_escribir_en_el_tema(db, conversation_id, current_user.id)

    # Si se puede guardar el nombre de cada adjunto y si es nota de voz (0113).
    # Sin ella el nombre se ignora y todo audio es nota de voz: ver
    # `esquema.hay_nombres_de_adjuntos`.
    con_nombres = False
    if payload.attachments:
        await _exigir_esquema_de_adjuntos(db)
        # El orden importa: primero si CABE guardar un audio (503 si la 0044 no
        # está), después si el audio es válido (422). Al revés, quien mandara una
        # nota de voz mal formada contra una base sin la migración recibiría un
        # «arregla el dato» que no puede arreglar.
        await audio.exigir_esquema_de_audio(db, payload.attachments)
        con_nombres = await esquema.hay_nombres_de_adjuntos(db)
        audio.validar_audio(payload.attachments, con_nombres=con_nombres)
        for adjunto in payload.attachments:
            _exigir_titulo_valido(adjunto.title)
        _validar_rutas(payload.attachments, conversation_id, current_user.id)
    elif not payload.body.strip():
        # Sin la 0033 el esquema todavía exige al menos un carácter en `body`,
        # así que un mensaje vacío se rechaza aquí con un mensaje legible en vez
        # de reventar contra la restricción de la tabla.
        raise ValidationAppError("Escribe algo o adjunta un archivo.")

    # `insert().values()` y no `db.add(Message(...))`: el segundo inserta TODAS
    # las columnas mapeadas, así que el día que el modelo se adelante a la
    # migración deja de poder escribir. `returning` evita además el viaje extra
    # que costaba `db.refresh`.
    fila = (
        await db.execute(
            insert(Message)
            .values(
                conversation_id=conversation_id,
                # La identidad sale del JWT. Nunca de la petición.
                sender_id=current_user.id,
                body=payload.body,
            )
            .returning(Message.id, Message.created_at)
        )
    ).one()
    message_id, created_at = fila

    adjuntos: list[AttachmentRead] = []
    if payload.attachments:
        filas = [
            {
                "message_id": message_id,
                "conversation_id": conversation_id,
                "storage_path": adjunto.storage_path,
                "kind": adjunto.kind,
                "mime_type": adjunto.mime_type,
                "file_name": adjunto.file_name,
                "bytes": adjunto.bytes,
                "width": adjunto.width,
                "height": adjunto.height,
                "duration_s": adjunto.duration_s,
                "sort_order": posicion,
                # Solo si la 0113 esta: nombrar una columna que no existe es
                # un 500. Van por su nombre de columna (no estan en el mapeo
                # del modelo, ver `MessageAttachment`).
                **(
                    {"title": adjunto.title, "voice_note": bool(adjunto.voice_note)}
                    if con_nombres
                    else {}
                ),
            }
            for posicion, adjunto in enumerate(payload.attachments)
        ]
        # Una sola sentencia para todos: mandar diez fotos no puede costar diez
        # viajes a la base.
        ids = (
            await db.execute(
                insert(MessageAttachment).values(filas).returning(MessageAttachment.id)
            )
        ).scalars().all()
        adjuntos = [
            AttachmentRead(
                id=adjunto_id,
                storage_path=adjunto.storage_path,
                kind=adjunto.kind,
                mime_type=adjunto.mime_type,
                file_name=adjunto.file_name,
                bytes=adjunto.bytes,
                width=adjunto.width,
                height=adjunto.height,
                duration_s=adjunto.duration_s,
                # Lo mismo que leera el historial despues: sin la 0113, sin
                # nombre y nota de voz si es audio.
                title=adjunto.title if con_nombres else None,
                voice_note=(
                    bool(adjunto.voice_note) if con_nombres else adjunto.kind == "audio"
                ),
            )
            for adjunto_id, adjunto in zip(ids, payload.attachments, strict=True)
        ]

    # El contexto de la historia, si el mensaje salió del visor.
    #
    # VA DESPUES DE INSERTAR EL MENSAJE porque su clave primaria es
    # `message_id`: no hay a qué atarlo hasta que el mensaje existe. Y va DENTRO
    # de la misma transacción que el `commit` de abajo, así que o se guardan los
    # dos o no se guarda ninguno: un contexto huérfano apuntaría a un mensaje
    # que nadie escribió.
    #
    # DEVUELVE `None` SIN LANZAR cuando la 0044 no está aplicada o cuando la
    # historia ya no existe —entre abrir el visor y pulsar «enviar» pueden pasar
    # minutos, y en ese hueco su autor ha podido borrarla—. En los dos casos el
    # mensaje SE MANDA IGUAL, sin contexto: el texto es de quien lo escribió y
    # quitárselo por una tabla que falta o una historia que caducó sería el peor
    # de los desenlaces. Ver `historias.guardar_contexto`.
    contexto: StoryContextRead | None = None
    if payload.story_id:
        ensure_uuid(payload.story_id, "Historia no encontrada.")
        contexto = await historias.guardar_contexto(db, message_id, payload.story_id)

    # A QUÉ MENSAJE RESPONDE, si responde a alguno. Dentro de la misma
    # transacción, y sin bloquear el envío: si el original no es de esta
    # conversación o la 0106 no está, el mensaje se manda sin cita.
    con_cita = False
    if payload.reply_to_id:
        ensure_uuid(payload.reply_to_id, "Mensaje no encontrado.")
        con_cita = await reacciones.guardar_respuesta(
            db,
            message_id=str(message_id),
            conversation_id=conversation_id,
            reply_to_id=payload.reply_to_id,
        )

    await db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=func.now())
    )
    await db.commit()

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del remitente no encontrado.")

    # AVISAR A QUIEN LO RECIBE. El mensaje YA ESTA GUARDADO: si calcular a
    # quien avisar falla, se pierde el aviso y no el mensaje. Y el push sale
    # despues de responder (`encolar_push`), asi que quien escribe no espera a
    # Expo para ver su propio mensaje. Ver `messaging/avisos.py`.
    try:
        a_quien = await avisos.destinatarios(
            db, conversation_id=conversation_id, remitente_id=current_user.id
        )
        # En un grupo el aviso dice QUIÉN y EN CUÁL: «Ana envió un mensaje a la
        # comunidad «Aula»», «al grupo «Valorant»» si es uno de dentro de una
        # comunidad, o «en el tema «Anuncios»». Los datos son los mismos: lleva
        # a la conversación.
        grupo = await avisos.grupo_de(db, conversation_id)
        encolar_push(
            background,
            user_ids=a_quien,
            notification_type=avisos.TIPO if grupo is None else avisos.TIPO_EN_GRUPO,
            actor_name=avisos.nombre_para_el_aviso(profile),
            data=avisos.datos_del_aviso(conversation_id, str(message_id)),
            grupo=grupo,
            nivel=(
                await avisos.nivel_de(db, conversation_id) if grupo is not None else "comunidad"
            ),
        )
    except Exception:  # noqa: BLE001 - el aviso nunca tumba el envio
        logger.warning("[mensajes] no se pudo programar el aviso", exc_info=True)

    return MessageRead(
        id=message_id,
        conversation_id=conversation_id,
        sender=_author(profile),
        body=payload.body,
        created_at=created_at,
        attachments=adjuntos,
        story_context=contexto,
        reply_to=(
            (await reacciones.respuestas_por_mensaje(db, [str(message_id)])).get(str(message_id))
            if con_cita
            else None
        ),
    )


@router.delete(
    "/{conversation_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def borrar_mensaje(
    conversation_id: str,
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra un mensaje para todo el mundo. Borrado suave.

    QUIÉN PUEDE. Quien lo escribió, la moderación y, en un grupo, quien lo
    administra. NADIE MÁS.

    En un chat de dos, esa ausencia es la regla entera: si el otro lado
    pudiera borrar lo que le dijeron, la conversación dejaría de ser prueba de
    nada —bastaría con quitar lo que incomoda— y no habría forma de reportar un
    mensaje abusivo.

    EN UN GRUPO, QUIEN LO ADMINISTRA TAMBIÉN (D4, decisión de producto del
    26/10/2026), y eso incluye sus comunidades y sus temas. Un grupo es un
    espacio que alguien abrió y del que responde: tiene que poder quitar el
    spam, lo ofensivo o lo que está fuera de lugar sin esperar a que intervenga
    la moderación. Y no rompe lo que protegía la regla anterior: el
    borrado sigue siendo suave, así que la fila y su autor se quedan en la base
    por si hay que responder de ello, y en el chat queda la lápida «Mensaje
    eliminado», no un hueco que mienta. Un miembro normal sigue sin poder
    borrar lo de otro, y quien administra no gana nada en un chat de dos
    (`vistas.administra` solo reconoce grupos).

    El rol se lee de `profiles`, NUNCA del token: en el JWT de Supabase `role`
    vale siempre "authenticated", y comprobarlo contra "admin" no se cumple
    jamás. Ese fallo ya llegó a producción varias veces en este proyecto.

    POR QUÉ SUAVE Y NO UN `DELETE`. Porque la fila la miran más cosas que la
    burbuja: el contador de no leídos, la previsualización de la bandeja y el
    filtro que decide si un chat directo existe. Un borrado físico deja huecos
    en todo eso y no se puede deshacer si mañana hay que responder a un reporte.
    Con la marca, la conversación sigue contando la verdad: aquí hubo un mensaje
    y su autor lo retiró.

    LOS FICHEROS DEL BUCKET NO SE TOCAN. Borrarlos aquí rompería el mensaje si
    la escritura fallara después, y sobre todo son irrecuperables: la limpieza
    de huérfanos tiene su sitio (`app/shared/storage.py`) y decide con toda la
    información delante. Lo que sí deja de ocurrir es entregarlos: un mensaje
    borrado sale sin adjuntos (ver `list_messages`).

    IDEMPOTENTE. Borrar dos veces responde 204 las dos: la marca no se
    sobreescribe, así que la fecha sigue siendo la del borrado de verdad.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    ensure_uuid(message_id, "Mensaje no encontrado.")
    # Pertenecer a la conversación es lo PRIMERO. Sin esto, quien no está dentro
    # podría averiguar si un id de mensaje existe por la diferencia entre un 404
    # y un 403.
    await _require_member(db, conversation_id, current_user.id)

    fila = (
        await db.execute(
            select(Message.sender_id, Message.deleted_at).where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
            )
        )
    ).one_or_none()
    if fila is None:
        raise NotFoundError("Mensaje no encontrado.")
    remitente, ya_borrado = fila

    if not await _puede_retocar_el_mensaje(db, conversation_id, remitente, current_user.id):
        raise ForbiddenError(
            "Solo puedes borrar los mensajes que has escrito tú.",
            code="message_not_yours",
        )

    if ya_borrado is not None:
        # Ya estaba. No se vuelve a marcar: la fecha tiene que seguir siendo la
        # del borrado real, no la del último toque en un botón.
        return

    # EL REGISTRO DE UNA SESIÓN NO LO BORRA QUIEN LO ESCRIBIÓ. Es lo que deja
    # constancia de que se pidió, se aceptó o se canceló: quitarlo dejaría una
    # sesión aceptada sin rastro de quién la aceptó. Lo que se puede hacer es
    # cancelar la sesión, y eso deja su propio registro. 409 y no 403: no es
    # que no sea suyo, es que este mensaje no admite esa acción.
    #
    # LA MODERACIÓN SÍ PUEDE. El tema de una sesión es texto libre: uno
    # ofensivo no puede quedarse fijo para siempre en el chat de quien lo
    # recibió. El borrado es suave, así que la constancia sigue en la base.
    if await sesiones.es_registro_de_sesion(db, message_id) and not await is_admin(
        db, current_user.id
    ):
        raise ConflictError(
            "Este mensaje es el registro de una sesión y no se puede borrar.",
            code="message_is_booking_record",
        )

    await db.execute(
        update(Message)
        .where(Message.id == message_id, Message.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
    await db.commit()


@router.patch(
    "/{conversation_id}/messages/{message_id}/attachments/{attachment_id}",
    response_model=AttachmentRead,
)
async def nombrar_adjunto(
    conversation_id: str,
    message_id: str,
    attachment_id: str,
    payload: TituloDeAdjunto,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AttachmentRead:
    """Pone, cambia o quita (`null` o vacío) el nombre de un adjunto (0113).

    QUIÉN PUEDE: LA MISMA REGLA QUE BORRAR (`_puede_retocar_el_mensaje`): quien
    envió el mensaje, quien administra la conversación y la moderación. Los
    demás, 403 `attachment_title_forbidden` aunque llamen a la API a mano: la
    aplicación esconde «Ponerle nombre», pero esconder un botón es comodidad,
    no permiso. Y `message_attachments` NO TIENE POLÍTICA DE UPDATE (0033), así
    que por PostgREST nadie puede cambiarlo: esta ruta es el único camino.

    EN ESTE ORDEN, y cada paso por algo:
      1. pertenecer (403): sin eso, la diferencia entre un 404 y un 403 diría
         qué identificadores existen en una conversación ajena;
      2. la 0113 (503 `attachment_titles_not_available`): sin la columna no
         hay dónde guardarlo, y no es un error del dato;
      3. el adjunto, de ESE mensaje, de ESTA conversación y vivo (404
         `attachment_not_found`): un mensaje borrado ya no enseña sus
         adjuntos, así que tampoco se les pone nombre;
      4. poder (403 `attachment_title_forbidden`);
      5. que admita nombre (422 `attachment_title_not_allowed` en una foto) y
         que quepa (422 `attachment_title_too_long`).

    Devuelve el adjunto como lo leerá el historial. No avisa a nadie ni toca
    `updated_at` de la conversación: renombrar no es un mensaje nuevo.
    """
    uid = current_user.id
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    await _require_member(db, conversation_id, uid)
    if not await esquema.hay_adjuntos_de_chat(db) or not await esquema.hay_nombres_de_adjuntos(db):
        raise ServiceUnavailableError(
            "Todavía no se les puede poner nombre a los archivos.",
            code="attachment_titles_not_available",
        )

    no_esta = NotFoundError("Archivo no encontrado.", code="attachment_not_found")
    try:
        UUID(message_id)
        UUID(attachment_id)
    except (ValueError, AttributeError, TypeError):
        raise no_esta from None
    fila = (
        await db.execute(
            select(
                MessageAttachment.id,
                MessageAttachment.storage_path,
                MessageAttachment.kind,
                MessageAttachment.mime_type,
                MessageAttachment.file_name,
                MessageAttachment.bytes,
                MessageAttachment.width,
                MessageAttachment.height,
                MessageAttachment.duration_s,
                ES_NOTA_DE_VOZ,
                Message.sender_id,
            )
            .join(Message, Message.id == MessageAttachment.message_id)
            .where(
                MessageAttachment.id == attachment_id,
                MessageAttachment.message_id == message_id,
                # La conversación va en el WHERE, en las dos tablas: el adjunto
                # de otro chat no llega ni a leerse.
                MessageAttachment.conversation_id == conversation_id,
                Message.conversation_id == conversation_id,
                Message.deleted_at.is_(None),
            )
        )
    ).one_or_none()
    if fila is None:
        raise no_esta
    if not await _puede_retocar_el_mensaje(db, conversation_id, fila.sender_id, uid):
        raise ForbiddenError(
            "Solo quien envió el mensaje o quien administra puede ponerle nombre.",
            code="attachment_title_forbidden",
        )
    if fila.kind in TIPOS_SIN_NOMBRE:
        raise ValidationAppError(
            "Las fotos no llevan nombre: ya tienen el texto del mensaje.",
            code="attachment_title_not_allowed",
        )
    _exigir_titulo_valido(payload.title)

    # La TABLA y no la entidad: `title` no está en el mapeo del modelo.
    await db.execute(
        update(MessageAttachment.__table__)
        .where(MessageAttachment.__table__.c.id == attachment_id)
        .values(title=payload.title)
    )
    await db.commit()
    return AttachmentRead(
        id=fila.id,
        storage_path=fila.storage_path,
        kind=fila.kind,
        mime_type=fila.mime_type,
        file_name=fila.file_name,
        bytes=fila.bytes,
        width=fila.width,
        height=fila.height,
        duration_s=fila.duration_s,
        title=payload.title,
        voice_note=bool(fila.voice_note),
    )


@router.post("/{conversation_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _require_member(db, conversation_id, current_user.id)
    await db.execute(
        update(ConversationMember)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == current_user.id,
        )
        .values(last_read_at=func.now())
    )
    await db.commit()
