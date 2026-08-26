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

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import (
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

    El coste en consultas es CONSTANTE: cuatro, con tres conversaciones y con
    ochenta. Ver `lectura.py`.
    """
    filas = (
        await db.execute(
            select(*_COLUMNAS_DE_CONVERSACION)
            .join(
                ConversationMember,
                ConversationMember.conversation_id == Conversation.id,
            )
            .where(ConversationMember.user_id == current_user.id)
            # Desempate por id: `updated_at` puede repetirse (en SQLite tiene
            # resolucion de segundo) y sin un segundo criterio una misma fila
            # podria salir en dos paginas o en ninguna.
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return await leer_conversaciones(db, filas, current_user.id)


@router.post("/direct", response_model=ConversationRead)
async def get_or_create_direct(
    payload: DirectConversationCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationRead:
    if payload.user_id == current_user.id:
        raise ValidationAppError("No puedes iniciar una conversación contigo mismo.")
    target = await db.get(Profile, payload.user_id)
    if target is None:
        raise NotFoundError("Perfil no encontrado.")

    m1 = aliased(ConversationMember)
    m2 = aliased(ConversationMember)
    existing = (
        await db.execute(
            select(Conversation.id)
            .join(m1, m1.conversation_id == Conversation.id)
            .join(m2, m2.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "direct",
                m1.user_id == current_user.id,
                m2.user_id == payload.user_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()

    if existing is not None:
        conv_id = existing
    else:
        conv = Conversation(kind="direct", created_by=current_user.id)
        db.add(conv)
        await db.flush()
        db.add(ConversationMember(conversation_id=conv.id, user_id=current_user.id))
        db.add(ConversationMember(conversation_id=conv.id, user_id=payload.user_id))
        # Solo cuando la conversacion se CREA. Abrir un chat que ya existia no
        # es una decision nueva, y contarla cada vez que se entra convertiria
        # una senal fuerte en ruido.
        await registrar_senal(
            db,
            user_id=current_user.id,
            event_type="message_started",
            entity_type="profile",
            entity_id=payload.user_id,
        )
        await db.commit()
        conv_id = conv.id

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
            Profile.id,
            Profile.full_name,
            Profile.username,
            Profile.avatar_path,
        )
        .join(Profile, Profile.id == Message.sender_id)
        .where(
            Message.conversation_id == conversation_id,
            Message.deleted_at.is_(None),
        )
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
    adjuntos = await adjuntos_por_mensaje(db, [fila[0] for fila in rows])

    # Devolvemos en orden cronológico ascendente (más antiguos primero).
    return [
        MessageRead(
            id=msg_id,
            conversation_id=conv_id,
            sender=AuthorSummary(
                id=pid, full_name=full_name, username=username, avatar_path=avatar_path
            ),
            body=body,
            created_at=created_at,
            attachments=adjuntos.get(msg_id, []),
        )
        for (
            msg_id,
            conv_id,
            body,
            created_at,
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
