from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.security import assert_user_owns_chat, get_current_user
from app.api.utils import iso_utc
from app.api.websocket_manager import manager
from app.db.crud import (
    create_message,
    get_or_create_chat,
    get_pinned_messages,
)
from app.db.models import Chat, ChatType, MessageType, SenderType, Staff, User
from app.db.session import get_session

router = APIRouter(prefix="/api/chats", tags=["chats"])


class ChatIn(BaseModel):
    user_id: int
    chat_type: ChatType


class ChatOut(BaseModel):
    id: int
    user_id: int
    chat_type: ChatType

    class Config:
        from_attributes = True


@router.post("/", response_model=ChatOut)
async def get_or_create(
    data: ChatIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # Создать/получить чат можно только для СВОЕЙ учётки — иначе можно было бы
    # получить chat_id чужого аккаунта, подставив чужой user_id.
    if data.user_id != user.id:
        raise HTTPException(status_code=403, detail="Нет доступа к этому аккаунту")
    chat = await get_or_create_chat(session, user_id=data.user_id, chat_type=data.chat_type)
    return chat


# ── User's group chats (must be declared BEFORE /{chat_id}) ───────────
async def _staff_names(session, *staff_ids):
    ids = {i for i in staff_ids if i}
    if not ids:
        return {}
    rows = (await session.execute(select(Staff).where(Staff.id.in_(ids)))).scalars().all()
    return {s.id: s.full_name for s in rows}


@router.get("/groups")
async def user_groups(
    user_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Group chats the user participates in — shown under the 3 main cards.

    Только свои группы: user_id обязан совпадать с вошедшей учёткой."""
    if user_id != user.id:
        raise HTTPException(status_code=403, detail="Нет доступа")
    chats = (await session.execute(
        select(Chat)
        .options(selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.group, Chat.user_id == user_id)
        .order_by(Chat.updated_at.desc())
    )).scalars().all()

    all_ids = set()
    for c in chats:
        all_ids.update([c.lawyer_staff_id, c.manager_staff_id])
    names = await _staff_names(session, *all_ids)

    out = []
    for c in chats:
        msgs = [m for m in c.messages if not m.is_deleted]
        if c.user_cleared_at:
            msgs = [m for m in msgs if m.created_at and m.created_at > c.user_cleared_at]
        last = None
        if msgs:
            lm = msgs[-1]
            last = {
                "content": lm.content,
                "sender_type": lm.sender_type.value if lm.sender_type else None,
                "created_at": iso_utc(lm.created_at),
            }
        out.append({
            "chat_id": c.id,
            "lawyer_name": names.get(c.lawyer_staff_id),
            "manager_name": names.get(c.manager_staff_id),
            "message_count": len(msgs),
            "last_message": last,
            "updated_at": iso_utc(c.updated_at),
        })
    return out


@router.get("/group-info/{chat_id}")
async def group_info(
    chat_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    chat = await assert_user_owns_chat(session, user, chat_id)
    if chat.chat_type != ChatType.group:
        raise HTTPException(status_code=404, detail="Групповой чат не найден")
    names = await _staff_names(session, chat.lawyer_staff_id, chat.manager_staff_id)
    return {
        "chat_id": chat.id,
        "lawyer_name": names.get(chat.lawyer_staff_id),
        "manager_name": names.get(chat.manager_staff_id),
    }


@router.get("/{chat_id}", response_model=ChatOut)
async def get_chat(
    chat_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await assert_user_owns_chat(session, user, chat_id)


@router.get("/{chat_id}/pinned")
async def get_pinned(
    chat_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    await assert_user_owns_chat(session, user, chat_id)
    messages = await get_pinned_messages(session, chat_id)
    return [
        {
            "id": m.id,
            "content": m.content,
            "sender_type": m.sender_type,
            "message_type": m.message_type,
            "created_at": iso_utc(m.created_at),
        }
        for m in messages
    ]


class ClearChatIn(BaseModel):
    user_id: int
    chat_type: ChatType


@router.post("/clear")
async def clear_chat(
    data: ClearChatIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Clear chat history for THIS account only.

    Только своя учётка (user_id обязан совпадать с вошедшим). Ставит персональную
    отсечку (chat.user_cleared_at): пользователь (и, для ИИ-чата, контекст модели)
    больше не видит ничего до неё, но сообщения остаются в БД и видны персоналу.
    Для чатов с персоналом добавляется системная пометка об очистке.
    """
    if data.user_id != user.id:
        raise HTTPException(status_code=403, detail="Нет доступа")
    result = await session.execute(
        select(Chat).where(Chat.user_id == data.user_id, Chat.chat_type == data.chat_type)
    )
    chat = result.scalar_one_or_none()
    if not chat:
        return {"ok": True, "cleared": False}  # nothing to clear yet

    if data.chat_type in (ChatType.lawyer, ChatType.match, ChatType.support):
        sys_msg = await create_message(
            session,
            chat_id=chat.id,
            sender_type=SenderType.system,
            content="🧹 Пользователь очистил историю переписки на своей стороне.",
            message_type=MessageType.system,
            sender_name="Система",
        )
        # Cutoff == the note's timestamp → the note itself stays hidden from the
        # user (filter is strictly ">") but is visible to staff.
        chat.user_cleared_at = sys_msg.created_at
        await session.commit()
        await manager.broadcast_to_staff_for_chat(chat, {
            "type": "message",
            "id": sys_msg.id,
            "chat_id": chat.id,
            "sender_type": "system",
            "sender_name": "Система",
            "content": sys_msg.content,
            "message_type": "system",
            "created_at": iso_utc(sys_msg.created_at),
        })
    else:
        # AI chat — no staff side, just move the cutoff to now.
        chat.user_cleared_at = datetime.utcnow()
        await session.commit()

    return {"ok": True, "cleared": True}
