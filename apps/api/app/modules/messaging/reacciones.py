"""Reaccionar a un mensaje y responder a uno concreto (migracion 0106).

LO QUE SE PIDIO (10/10/2026, visto en telefono). Poder reaccionar a un mensaje
y responder a uno en particular, como en WhatsApp o Telegram. En un grupo,
donde se cruzan varias conversaciones, sin eso no se sabe a que contesta cada
cual.

DOS COSAS, DOS TABLAS:

  * Una REACCION es de una persona a un mensaje, y hay una sola por persona y
    mensaje: reaccionar otra vez la cambia. Se entregan agrupadas —«❤ 3»—, y a
    quien pregunta se le dice si una de ellas es la suya.
  * Una RESPUESTA es un mensaje normal que ademas apunta a otro. Lo que se
    entrega es una CITA: quien escribio el original y un extracto.

TODO VA ACOTADO A LA CONVERSACION. Se reacciona o se responde a un mensaje de
la conversacion en la que se esta, nunca a uno de otra: la conversacion va en
el `WHERE`, asi que el mensaje de otro chat no se alcanza ni conociendo su
identificador.

UN MENSAJE BORRADO no admite reacciones nuevas y no entrega las que tenia. Si
se cita, la cita dice que se elimino y no trae su texto: borrar para todos
borra tambien de las citas.

SE LEE POR LOTES. Las reacciones y las citas de una pagina de mensajes se
resuelven con un `IN` sobre sus identificadores, igual que los adjuntos: el
historial no crece en consultas con el numero de mensajes.

SIN LA 0106 no hay reacciones ni citas: se leen vacias, reaccionar responde
503, y un mensaje que responde a otro SE MANDA IGUAL, sin la cita. El texto es
de quien lo escribio y no se le quita por una tabla que falta.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.messaging import esquema
from app.modules.messaging.models import (
    ES_NOTA_DE_VOZ,
    TITULO_DE_ADJUNTO,
    ConversationMember,
    Message,
    MessageAttachment,
    MessageReaction,
    MessageReply,
)
from app.modules.messaging.schemas import ReactionRead, ReplyRead
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])

#: Cuanto del mensaje original viaja en la cita.
MAX_EXTRACTO = 140
#: Cuantos mensajes se pueden consultar de una vez al refrescar reacciones.
MAX_CONSULTA = 100
MAX_EMOJI = 16


class ReaccionNueva(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emoji: str = Field(min_length=1, max_length=MAX_EMOJI)

    @field_validator("emoji")
    @classmethod
    def _es_un_emoji(cls, v: str) -> str:
        """Un emoji, no un texto: ni letras, ni cifras, ni espacios.

        No se valida contra una lista: los emoji cambian con cada version de
        Unicode y la aplicacion ofrece los suyos. Lo que se impide es usar la
        reaccion para escribir —«ok», «jaja»—, que es otra cosa.
        """
        limpio = v.strip()
        if not limpio or any(c.isascii() and (c.isalnum() or c.isspace()) for c in limpio):
            raise ValueError("La reacción tiene que ser un emoji.")
        return limpio


class ConsultaDeReacciones(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_ids: list[str] = Field(min_length=1, max_length=MAX_CONSULTA)


class ReaccionesLeidas(BaseModel):
    #: Las reacciones de cada mensaje consultado. Uno sin reacciones no sale.
    reactions: dict[str, list[ReactionRead]] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Lectura por lotes
# --------------------------------------------------------------------------- #
async def reacciones_por_mensaje(
    db: AsyncSession, message_ids: list[str], uid: str
) -> dict[str, list[ReactionRead]]:
    """Las reacciones de VARIOS mensajes, agrupadas, en UNA consulta."""
    if not message_ids or not await esquema.hay_reacciones_y_respuestas(db):
        return {}
    filas = await db.execute(
        select(
            MessageReaction.message_id,
            MessageReaction.emoji,
            func.count().label("cuantos"),
            func.sum(case((MessageReaction.user_id == uid, 1), else_=0)).label("mias"),
            func.min(MessageReaction.created_at).label("primera"),
        )
        .where(MessageReaction.message_id.in_(message_ids))
        .group_by(MessageReaction.message_id, MessageReaction.emoji)
        # La mas usada, primero; a igualdad, la que llego antes. El emoji
        # desempata para que el orden no baile entre peticiones.
        .order_by(
            func.count().desc(), func.min(MessageReaction.created_at).asc(), MessageReaction.emoji
        )
    )
    salida: dict[str, list[ReactionRead]] = {}
    for fila in filas:
        salida.setdefault(fila.message_id, []).append(
            ReactionRead(emoji=fila.emoji, count=int(fila.cuantos), mine=bool(fila.mias))
        )
    return salida


def _extracto(texto: str) -> str:
    limpio = " ".join((texto or "").split())
    return limpio if len(limpio) <= MAX_EXTRACTO else limpio[: MAX_EXTRACTO - 1].rstrip() + "…"


async def respuestas_por_mensaje(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, ReplyRead]:
    """La cita de VARIOS mensajes: a cual responde cada uno. Dos consultas.

    La primera trae el original con su autor; la segunda, de que tipo es su
    primer adjunto, para poder decir «Foto» o «Nota de voz» cuando no tenia
    texto. Un original borrado sale marcado y SIN texto.
    """
    if not message_ids or not await esquema.hay_reacciones_y_respuestas(db):
        return {}
    filas = (
        await db.execute(
            select(
                MessageReply.message_id,
                Message.id.label("original"),
                Message.body,
                Message.deleted_at,
                Profile.id.label("autor"),
                Profile.full_name,
                Profile.username,
            )
            .join(Message, Message.id == MessageReply.reply_to_id)
            .join(Profile, Profile.id == Message.sender_id)
            .where(MessageReply.message_id.in_(message_ids))
        )
    ).all()
    if not filas:
        return {}

    tipos: dict[str, str] = {}
    # El nombre del primer adjunto (0113), para que la cita de un audio con
    # nombre diga «Respiración 4-7-8» y no «Audio» (spec del 30/10/2026). Viaja
    # en `excerpt`, que en un mensaje sin texto iba vacio: las aplicaciones de
    # antes ya pintan `excerpt` si trae algo, asi que no hace falta otro campo.
    titulos: dict[str, str] = {}
    # Y si el primer audio es nota de voz o archivo, para que la aplicacion
    # diga «Nota de voz» o «Audio». Sin la 0113, todo audio es nota de voz.
    de_voz: set[str] = set()
    vivos = [fila.original for fila in filas if fila.deleted_at is None]
    if vivos and await esquema.hay_adjuntos_de_chat(db):
        con_nombres = await esquema.hay_nombres_de_adjuntos(db)
        adjuntos = await db.execute(
            select(
                MessageAttachment.message_id,
                MessageAttachment.kind,
                *((TITULO_DE_ADJUNTO, ES_NOTA_DE_VOZ) if con_nombres else ()),
            )
            .where(MessageAttachment.message_id.in_(vivos))
            .order_by(MessageAttachment.sort_order.asc(), MessageAttachment.id.asc())
        )
        for adjunto in adjuntos:
            if adjunto.message_id not in tipos:
                tipos[adjunto.message_id] = adjunto.kind
                if con_nombres and adjunto.title:
                    titulos[adjunto.message_id] = adjunto.title
                if adjunto.kind == "audio" and (adjunto.voice_note if con_nombres else True):
                    de_voz.add(adjunto.message_id)

    salida: dict[str, ReplyRead] = {}
    for fila in filas:
        borrado = fila.deleted_at is not None
        salida[fila.message_id] = ReplyRead(
            id=fila.original,
            sender_id=fila.autor,
            sender_name=(fila.full_name or "").strip() or fila.username or "",
            # El texto de un mensaje borrado no viaja, tampoco dentro de una cita.
            excerpt=(
                ""
                if borrado
                else _extracto(fila.body) or _extracto(titulos.get(fila.original, ""))
            ),
            kind=None if borrado else tipos.get(fila.original),
            voice_note=not borrado and fila.original in de_voz,
            deleted=borrado,
        )
    return salida


# --------------------------------------------------------------------------- #
# Escritura
# --------------------------------------------------------------------------- #
async def guardar_respuesta(
    db: AsyncSession, *, message_id: str, conversation_id: str, reply_to_id: str
) -> bool:
    """Apunta que `message_id` responde a `reply_to_id`. `False` si no se guarda.

    NO LANZA Y NO BLOQUEA EL ENVIO. Si la 0106 no esta, o el original no es de
    ESTA conversacion —un identificador inventado, o el de otro chat—, el
    mensaje se manda igual, sin cita. Va dentro de la transaccion del envio.
    """
    if not await esquema.hay_reacciones_y_respuestas(db):
        return False
    original = (
        await db.execute(
            select(Message.id).where(
                Message.id == reply_to_id,
                # En el WHERE: no se puede citar un mensaje de otra conversacion.
                Message.conversation_id == conversation_id,
            )
        )
    ).scalar_one_or_none()
    if original is None:
        return False
    await db.execute(
        insert(MessageReply).values(message_id=message_id, reply_to_id=reply_to_id)
    )
    return True


async def _mensaje_reaccionable(
    db: AsyncSession, conversation_id: str, message_id: str, uid: str
) -> None:
    """Pertenecer a la conversacion, y que el mensaje sea de ella y siga vivo."""
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    ensure_uuid(message_id, "Mensaje no encontrado.")
    miembro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")
    if not await esquema.hay_reacciones_y_respuestas(db):
        raise ServiceUnavailableError(
            "Las reacciones todavía no están disponibles.",
            code="reactions_not_available",
        )
    borrado = (
        await db.execute(
            select(Message.deleted_at).where(
                Message.id == message_id, Message.conversation_id == conversation_id
            )
        )
    ).one_or_none()
    if borrado is None:
        raise NotFoundError("Mensaje no encontrado.", code="message_not_found")
    if borrado[0] is not None:
        raise ConflictError(
            "No se puede reaccionar a un mensaje eliminado.", code="message_deleted"
        )


@router.put(
    "/{conversation_id}/messages/{message_id}/reaction",
    response_model=list[ReactionRead],
)
async def reaccionar(
    conversation_id: str,
    message_id: str,
    payload: ReaccionNueva,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ReactionRead]:
    """Pone la reaccion de quien pregunta, o cambia la que tenia. Devuelve como queda.

    UNA POR PERSONA Y MENSAJE: lo impone la clave primaria. Dos toques a la
    vez no dejan dos; el que pierde actualiza la fila del que gano.
    """
    uid = current_user.id
    await _mensaje_reaccionable(db, conversation_id, message_id, uid)

    cambiadas = await db.execute(
        update(MessageReaction)
        .where(MessageReaction.message_id == message_id, MessageReaction.user_id == uid)
        .values(emoji=payload.emoji)
    )
    if not cambiadas.rowcount:
        try:
            await db.execute(
                insert(MessageReaction).values(
                    message_id=message_id,
                    # La identidad sale del JWT. Nunca de la peticion.
                    user_id=uid,
                    conversation_id=conversation_id,
                    emoji=payload.emoji,
                )
            )
        except IntegrityError:
            await db.rollback()
            await db.execute(
                update(MessageReaction)
                .where(MessageReaction.message_id == message_id, MessageReaction.user_id == uid)
                .values(emoji=payload.emoji)
            )
    await db.commit()
    return (await reacciones_por_mensaje(db, [message_id], uid)).get(message_id, [])


@router.delete(
    "/{conversation_id}/messages/{message_id}/reaction",
    response_model=list[ReactionRead],
)
async def quitar_reaccion(
    conversation_id: str,
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ReactionRead]:
    """Quita la reaccion propia. Sin ella, no hace nada. Devuelve como queda."""
    uid = current_user.id
    await _mensaje_reaccionable(db, conversation_id, message_id, uid)
    await db.execute(
        delete(MessageReaction).where(
            MessageReaction.message_id == message_id, MessageReaction.user_id == uid
        )
    )
    await db.commit()
    return (await reacciones_por_mensaje(db, [message_id], uid)).get(message_id, [])


@router.post("/{conversation_id}/reactions/lookup", response_model=ReaccionesLeidas)
async def consultar_reacciones(
    conversation_id: str,
    payload: ConsultaDeReacciones,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReaccionesLeidas:
    """Las reacciones de unos mensajes concretos de esta conversacion.

    PARA QUE EXISTE. Una reaccion cambia un mensaje ANTIGUO, y el chat solo
    pide los mensajes nuevos. Cuando alguien reacciona, los demas reciben un
    aviso sin contenido y preguntan aqui por los mensajes que tienen a la
    vista, en una sola peticion.

    Los identificadores que no sean de ESTA conversacion —o que no existan— se
    ignoran sin decir nada: no se puede usar esta ruta para saber si un
    mensaje de otro chat existe.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    miembro = await db.get(
        ConversationMember,
        {"conversation_id": conversation_id, "user_id": current_user.id},
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")
    validos = [i for i in dict.fromkeys(payload.message_ids) if _es_uuid(i)]
    if not validos or not await esquema.hay_reacciones_y_respuestas(db):
        return ReaccionesLeidas()
    de_aqui = list(
        (
            await db.execute(
                select(Message.id).where(
                    Message.id.in_(validos),
                    Message.conversation_id == conversation_id,
                    Message.deleted_at.is_(None),
                )
            )
        ).scalars()
    )
    return ReaccionesLeidas(
        reactions=await reacciones_por_mensaje(db, de_aqui, current_user.id)
    )


def _es_uuid(texto: str) -> bool:
    try:
        UUID(str(texto))
    except ValueError:
        return False
    return True

