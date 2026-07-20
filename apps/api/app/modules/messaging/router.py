"""Endpoints de mensajería.

- Solo los miembros pueden leer/escribir en una conversación (identidad del JWT).
- La entrega en tiempo real la hace Supabase Realtime sobre la tabla messages;
  aquí solo persistimos y exponemos el historial.
"""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import ForbiddenError, NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.messaging.models import Conversation, ConversationMember, Message
from app.modules.messaging.schemas import (
    ConversationRead,
    DirectConversationCreate,
    MessageCreate,
    MessageRead,
)
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/conversations", tags=["messaging"])


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


async def _build_conversation_read(
    db: AsyncSession, conv: Conversation, member: ConversationMember, uid: str
) -> ConversationRead:
    other = None
    if conv.kind == "direct":
        other_profile = (
            await db.execute(
                select(Profile)
                .join(ConversationMember, ConversationMember.user_id == Profile.id)
                .where(
                    ConversationMember.conversation_id == conv.id,
                    ConversationMember.user_id != uid,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if other_profile is not None:
            other = _author(other_profile)

    last = (
        await db.execute(
            select(Message)
            .where(Message.conversation_id == conv.id, Message.deleted_at.is_(None))
            .order_by(Message.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    unread_stmt = (
        select(func.count())
        .select_from(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.sender_id != uid,
            Message.deleted_at.is_(None),
        )
    )
    if member.last_read_at is not None:
        unread_stmt = unread_stmt.where(Message.created_at > member.last_read_at)
    unread = (await db.scalar(unread_stmt)) or 0

    return ConversationRead(
        id=conv.id,
        kind=conv.kind,
        title=conv.title,
        other=other,
        last_message=last.body if last else None,
        last_message_at=last.created_at if last else None,
        unread_count=unread,
        updated_at=conv.updated_at,
    )


@router.get("", response_model=list[ConversationRead])
async def list_conversations(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationRead]:
    rows = (
        await db.execute(
            select(ConversationMember, Conversation)
            .join(Conversation, Conversation.id == ConversationMember.conversation_id)
            .where(ConversationMember.user_id == current_user.id)
            .order_by(Conversation.updated_at.desc())
        )
    ).all()
    return [
        await _build_conversation_read(db, conv, member, current_user.id)
        for member, conv in rows
    ]


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
        await db.commit()
        conv_id = conv.id

    conv = await db.get(Conversation, conv_id)
    member = await _require_member(db, conv_id, current_user.id)
    return await _build_conversation_read(db, conv, member, current_user.id)


@router.get("/{conversation_id}/messages", response_model=list[MessageRead])
async def list_messages(
    conversation_id: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MessageRead]:
    await _require_member(db, conversation_id, current_user.id)
    rows = (
        await db.execute(
            select(Message, Profile)
            .join(Profile, Profile.id == Message.sender_id)
            .where(
                Message.conversation_id == conversation_id,
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    # Devolvemos en orden cronológico ascendente (más antiguos primero).
    return [
        MessageRead(
            id=msg.id,
            conversation_id=msg.conversation_id,
            sender=_author(profile),
            body=msg.body,
            created_at=msg.created_at,
        )
        for msg, profile in reversed(rows)
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
    await _require_member(db, conversation_id, current_user.id)
    message = Message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        body=payload.body,
    )
    db.add(message)
    await db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=func.now())
    )
    await db.commit()
    await db.refresh(message)

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del remitente no encontrado.")
    return MessageRead(
        id=message.id,
        conversation_id=message.conversation_id,
        sender=_author(profile),
        body=message.body,
        created_at=message.created_at,
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
