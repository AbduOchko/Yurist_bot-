from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.security import assert_user_owns_chat, get_current_user
from app.api.utils import iso_utc
from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import ChatType, Message, MessageType, SenderType, User
from app.db.session import get_session
from app.services.subscription import enforce_subscription

router = APIRouter(prefix="/api/messages", tags=["messages"])


def serialize_message(m) -> dict:
    reply = None
    if m.reply_to:
        reply = {
            "id": m.reply_to.id,
            "content": m.reply_to.content,
            "sender_type": m.reply_to.sender_type,
            "message_type": m.reply_to.message_type,
        }
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "sender_type": m.sender_type,
        "sender_name": m.sender_name,
        "content": m.content,
        "caption": m.caption,
        "message_type": m.message_type,
        "file_url": m.file_url,
        "file_name": m.file_name,
        "file_size": m.file_size,
        "is_pinned": m.is_pinned,
        "reply_to": reply,
        "forwarded_from_chat_type": m.forwarded_from_chat_type,
        "created_at": iso_utc(m.created_at),
        "updated_at": iso_utc(m.updated_at),
    }


@router.get("/{chat_id}")
async def get_messages(
    chat_id: int,
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # Приватность: историю чата видит только его владелец (персонал — через свои
    # эндпоинты /api/manager|lawyer). Плюс учитываем персональную отсечку очистки.
    chat = await assert_user_owns_chat(session, user, chat_id)
    messages = await crud.get_messages(
        session, chat_id, limit=limit, offset=offset, after=chat.user_cleared_at
    )
    return [serialize_message(m) for m in messages]


class MessageIn(BaseModel):
    chat_id: int
    content: Optional[str] = None
    caption: Optional[str] = None
    message_type: MessageType = MessageType.text
    file_url: Optional[str] = None
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    reply_to_id: Optional[int] = None
    forwarded_from_chat_type: Optional[ChatType] = None


@router.post("/")
async def send_message(
    data: MessageIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # Писать можно только в свой чат. Отправитель — всегда сам пользователь:
    # sender_type/имя/id задаёт сервер, поэтому подделать сообщение «от юриста»
    # или «от системы» в своём чате нельзя (раньше эти поля брались из тела).
    await assert_user_owns_chat(session, user, data.chat_id)
    await enforce_subscription(user.telegram_id, session)

    reply_to_id = data.reply_to_id
    if reply_to_id is not None:
        # reply_to обязан принадлежать этому же чату — иначе не даём сослаться
        # на чужое сообщение (утечка превью). Просто снимаем ссылку.
        ok = (await session.execute(
            select(Message.id).where(Message.id == reply_to_id, Message.chat_id == data.chat_id)
        )).scalar_one_or_none()
        if ok is None:
            reply_to_id = None

    msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=data.content,
        caption=data.caption,
        message_type=data.message_type,
        file_url=data.file_url,
        file_name=data.file_name,
        file_size=data.file_size,
        reply_to_id=reply_to_id,
        sender_id=user.telegram_id,
        sender_name=user.first_name or "Пользователь",
        forwarded_from_chat_type=data.forwarded_from_chat_type,
    )
    # Подгружаем reply_to для сериализации (иначе ленивое обращение падает в async).
    if msg.reply_to_id:
        msg = (await session.execute(
            select(Message)
            .options(selectinload(Message.reply_to))
            .where(Message.id == msg.id)
        )).scalar_one()

    payload = serialize_message(msg)
    await manager.broadcast_to_chat(data.chat_id, {"type": "message", **payload})

    # Notify staff (manager / lawyer / owner) for non-AI chats
    chat = await crud.get_chat_by_id(session, data.chat_id)
    if chat and chat.chat_type in (ChatType.lawyer, ChatType.match, ChatType.support, ChatType.group):
        await manager.broadcast_to_staff_for_chat(chat, {
            "type": "new_message",
            "chat_id": data.chat_id,
            "chat_type": chat.chat_type.value,
            "user_id": chat.user_id,
            **payload,
        })

    return payload


class EditIn(BaseModel):
    content: str


async def _load_owned_message(session, user, message_id):
    """Load a message and assert the caller owns its chat. Returns the Message."""
    msg = (await session.execute(
        select(Message).where(Message.id == message_id)
    )).scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    await assert_user_owns_chat(session, user, msg.chat_id)
    return msg


@router.patch("/{message_id}")
async def edit_message(
    message_id: int,
    data: EditIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    msg = await _load_owned_message(session, user, message_id)
    if msg.sender_type != SenderType.user:
        raise HTTPException(status_code=403, detail="Можно редактировать только свои сообщения")
    msg = await crud.edit_message(session, message_id, data.content)
    payload = serialize_message(msg)
    event = {"type": "edit", **payload}
    await manager.broadcast_to_chat(msg.chat_id, event)
    chat = await crud.get_chat_by_id(session, msg.chat_id)
    if chat and chat.chat_type in (ChatType.lawyer, ChatType.match, ChatType.support, ChatType.group):
        await manager.broadcast_to_staff_for_chat(chat, event)
    return payload


@router.delete("/{message_id}")
async def delete_message(
    message_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    msg = await _load_owned_message(session, user, message_id)
    if msg.sender_type != SenderType.user:
        raise HTTPException(status_code=403, detail="Можно удалять только свои сообщения")
    chat_id = msg.chat_id
    ok = await crud.delete_message(session, message_id)
    if ok:
        event = {"type": "delete", "message_id": message_id}
        await manager.broadcast_to_chat(chat_id, event)
        chat = await crud.get_chat_by_id(session, chat_id)
        if chat and chat.chat_type in (ChatType.lawyer, ChatType.match, ChatType.support, ChatType.group):
            await manager.broadcast_to_staff_for_chat(chat, event)
    return {"ok": ok}


@router.post("/{message_id}/pin")
async def pin_message(
    message_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # Закрепить можно любое сообщение в СВОЁМ чате (в т.ч. ответ юриста).
    await _load_owned_message(session, user, message_id)
    msg = await crud.toggle_pin_message(session, message_id)
    payload = serialize_message(msg)
    await manager.broadcast_to_chat(msg.chat_id, {"type": "pin", **payload})
    return payload
