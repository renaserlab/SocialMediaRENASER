"""Endpoints de mensajería.

- Solo los miembros pueden leer/escribir en una conversación (identidad del JWT).
- La entrega en tiempo real la hace Supabase Realtime sobre la tabla messages;
  aquí solo persistimos y exponemos el historial.

El listado de conversaciones se arma en `lectura.py`, que hace un numero de
consultas CONSTANTE. Ese fichero explica por que: aqui construir cada fila por
separado costaba `1 + 3N` viajes a la base y era el motivo de que la pantalla de
Mensajes tardara segundos en abrirse.
"""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, insert, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import esquema
from app.modules.messaging.lectura import adjuntos_por_mensaje, leer_conversaciones
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    DirectConversationPair,
    Message,
    MessageAttachment,
)
from app.modules.messaging.schemas import (
    AttachmentCreate,
    AttachmentRead,
    ConversationRead,
    DirectConversationCreate,
    MessageCreate,
    MessageRead,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations.signals import registrar_senal
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin

router = APIRouter(prefix="/conversations", tags=["messaging"])

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


@router.get("", response_model=list[ConversationRead])
async def list_conversations(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationRead]:
    """Las conversaciones de quien pregunta, de la mas reciente a la mas antigua.

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

    El coste en consultas es CONSTANTE: cuatro, con tres conversaciones y con
    ochenta. Ver `lectura.py`. El filtro no anade ninguna: es un `exists`
    correlacionado dentro de la consulta que ya se hacia.
    """
    filas = (
        await db.execute(
            select(*_COLUMNAS_DE_CONVERSACION)
            .join(
                ConversationMember,
                ConversationMember.conversation_id == Conversation.id,
            )
            .where(
                ConversationMember.user_id == current_user.id,
                or_(Conversation.kind != "direct", _TIENE_ALGUN_MENSAJE),
            )
            # Desempate por id: `updated_at` puede repetirse (en SQLite tiene
            # resolucion de segundo) y sin un segundo criterio una misma fila
            # podria salir en dos paginas o en ninguna.
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return await leer_conversaciones(db, filas, current_user.id)


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
    adjuntos = await adjuntos_por_mensaje(
        db, [fila[0] for fila in rows if fila[4] is None]
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
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MessageRead:
    """Guarda un mensaje: solo texto, solo archivos, o las dos cosas.

    Los bytes NO pasan por aquí. La aplicación sube al bucket `message-media`
    con su propio token —que es lo que permite subir un vídeo por trozos
    reanudables sin que la API sostenga la conexión— y esta petición solo
    registra las rutas, después de comprobar que apuntan a esta conversación y a
    la carpeta de quien las manda.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    await _require_member(db, conversation_id, current_user.id)

    if payload.attachments:
        await _exigir_esquema_de_adjuntos(db)
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
            )
            for adjunto_id, adjunto in zip(ids, payload.attachments, strict=True)
        ]

    await db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=func.now())
    )
    await db.commit()

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del remitente no encontrado.")
    return MessageRead(
        id=message_id,
        conversation_id=conversation_id,
        sender=_author(profile),
        body=payload.body,
        created_at=created_at,
        attachments=adjuntos,
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
    """Borra un mensaje PROPIO para todo el mundo. Borrado suave.

    QUIÉN PUEDE. Quien lo escribió, y la moderación. NADIE MÁS, y esa ausencia
    es la regla entera: si el otro lado pudiera borrar lo que le dijeron, una
    conversación dejaría de ser prueba de nada —bastaría con quitar lo que
    incomoda— y no habría forma de reportar un mensaje abusivo, porque quien lo
    mandó ya no aparecería como su autor de nada.

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

    if remitente != current_user.id and not await is_admin(db, current_user.id):
        raise ForbiddenError(
            "Solo puedes borrar los mensajes que has escrito tú.",
            code="message_not_yours",
        )

    if ya_borrado is not None:
        # Ya estaba. No se vuelve a marcar: la fecha tiene que seguir siendo la
        # del borrado real, no la del último toque en un botón.
        return

    await db.execute(
        update(Message)
        .where(Message.id == message_id, Message.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
    await db.commit()


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
