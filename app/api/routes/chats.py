from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.websocket_manager import manager
from app.db.crud import (
    create_message,
    get_or_create_chat,
    get_chat_by_id,
    get_pinned_messages,
    get_user_by_telegram_id,
)
from app.db.models import Chat, ChatType, MessageType, SenderType, Staff
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
async def get_or_create(data: ChatIn, session: AsyncSession = Depends(get_session)):
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
async def user_groups(telegram_id: int, session: AsyncSession = Depends(get_session)):
    """Group chats the user participates in — shown under the 3 main cards."""
    user = await get_user_by_telegram_id(session, telegram_id)
    if not user:
        return []
    chats = (await session.execute(
        select(Chat)
        .options(selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.group, Chat.user_id == user.id)
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
                "created_at": lm.created_at.isoformat() if lm.created_at else None,
            }
        out.append({
            "chat_id": c.id,
            "lawyer_name": names.get(c.lawyer_staff_id),
            "manager_name": names.get(c.manager_staff_id),
            "message_count": len(msgs),
            "last_message": last,
            "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        })
    return out


@router.get("/group-info/{chat_id}")
async def group_info(chat_id: int, session: AsyncSession = Depends(get_session)):
    chat = (await session.execute(
        select(Chat).where(Chat.id == chat_id, Chat.chat_type == ChatType.group)
    )).scalar_one_or_none()
    if not chat:
        raise HTTPException(status_code=404, detail="Групповой чат не найден")
    names = await _staff_names(session, chat.lawyer_staff_id, chat.manager_staff_id)
    return {
        "chat_id": chat.id,
        "lawyer_name": names.get(chat.lawyer_staff_id),
        "manager_name": names.get(chat.manager_staff_id),
    }


@router.get("/{chat_id}", response_model=ChatOut)
async def get_chat(chat_id: int, session: AsyncSession = Depends(get_session)):
    chat = await get_chat_by_id(session, chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


@router.get("/{chat_id}/pinned")
async def get_pinned(chat_id: int, session: AsyncSession = Depends(get_session)):
    messages = await get_pinned_messages(session, chat_id)
    return [
        {
            "id": m.id,
            "content": m.content,
            "sender_type": m.sender_type,
            "message_type": m.message_type,
            "created_at": m.created_at.isoformat(),
        }
        for m in messages
    ]


class ClearChatIn(BaseModel):
    telegram_id: int
    chat_type: ChatType


@router.post("/clear")
async def clear_chat(data: ClearChatIn, session: AsyncSession = Depends(get_session)):
    """Clear chat history for THIS user only.

    Sets a per-user cutoff (chat.user_cleared_at) — the user (and, for the AI
    chat, the model's context) no longer sees anything before it, but the
    messages stay in the DB and remain fully visible to staff. For staff-facing
    chats a system note is added so the lawyer / manager / owner sees that the
    user wiped their side.
    """
    user = await get_user_by_telegram_id(session, data.telegram_id)
    if not user:
        return {"ok": True, "cleared": False}

    result = await session.execute(
        select(Chat).where(Chat.user_id == user.id, Chat.chat_type == data.chat_type)
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
            "created_at": sys_msg.created_at.isoformat(),
        })
    else:
        # AI chat — no staff side, just move the cutoff to now.
        chat.user_cleared_at = datetime.utcnow()
        await session.commit()

    return {"ok": True, "cleared": True}
