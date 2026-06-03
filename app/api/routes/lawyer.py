"""Lawyer panel endpoints. Lawyers see only chats assigned to them
(chat.chat_type='lawyer' AND chat.lawyer_staff_id == self.id)."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.security import assert_chat_access, require_role
from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import Chat, ChatType, MessageType, SenderType, Staff, StaffRole
from app.db.session import get_session

router = APIRouter(prefix="/api/lawyer", tags=["lawyer"])

LawyerDep = Depends(require_role(StaffRole.lawyer, StaffRole.owner))


def _serialize_chat(chat: Chat) -> dict:
    last_msg = None
    non_deleted = [m for m in chat.messages if not m.is_deleted] if chat.messages else []
    if non_deleted:
        lm = non_deleted[-1]
        last_msg = {
            "content": lm.content,
            "sender_type": lm.sender_type.value if lm.sender_type else None,
            "created_at": lm.created_at.isoformat() if lm.created_at else None,
        }
    return {
        "id": chat.id,
        "user_id": chat.user_id,
        "chat_type": chat.chat_type.value,
        "lawyer_staff_id": chat.lawyer_staff_id,
        "is_free": chat.lawyer_staff_id is None,
        "user": {
            "telegram_id": chat.user.telegram_id,
            "first_name": chat.user.first_name,
            "last_name": chat.user.last_name,
            "username": chat.user.username,
            "photo_url": chat.user.photo_url,
        },
        "message_count": len(non_deleted),
        "last_message": last_msg,
        "updated_at": chat.updated_at.isoformat() if chat.updated_at else None,
    }


def _serialize_message(m) -> dict:
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "sender_type": m.sender_type.value if m.sender_type else None,
        "sender_name": m.sender_name,
        "sender_id": m.sender_id,
        "content": m.content,
        "message_type": m.message_type.value if m.message_type else None,
        "file_url": m.file_url,
        "file_name": m.file_name,
        "file_size": m.file_size,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# ── My profile / online toggle ────────────────────────────────────────
@router.get("/me")
async def get_me(staff: Staff = LawyerDep):
    return {
        "id": staff.id,
        "role": staff.role.value,
        "login": staff.login,
        "full_name": staff.full_name,
        "specialization": staff.specialization,
        "is_online": staff.is_online,
    }


class OnlineIn(BaseModel):
    is_online: bool


@router.post("/online")
async def set_online(
    data: OnlineIn,
    staff: Staff = LawyerDep,
    session: AsyncSession = Depends(get_session),
):
    staff.is_online = data.is_online
    await session.commit()
    return {"ok": True, "is_online": staff.is_online}


# ── My chats ──────────────────────────────────────────────────────────
@router.get("/chats")
async def my_chats(
    staff: Staff = LawyerDep,
    session: AsyncSession = Depends(get_session),
):
    # Lawyer sees: chats assigned to them + free-pool (unassigned) chats.
    # First lawyer to reply auto-claims the chat (see send_chat_message).
    # Owner sees all lawyer chats.
    q = select(Chat).options(
        selectinload(Chat.user),
        selectinload(Chat.messages),
    ).where(Chat.chat_type == ChatType.lawyer)
    if staff.role == StaffRole.lawyer:
        q = q.where(or_(Chat.lawyer_staff_id == staff.id, Chat.lawyer_staff_id.is_(None)))
    q = q.order_by(Chat.updated_at.desc())
    result = await session.execute(q)
    return [_serialize_chat(c) for c in result.scalars().all()]


@router.get("/chats/{chat_id}/messages")
async def chat_messages(
    chat_id: int,
    staff: Staff = LawyerDep,
    session: AsyncSession = Depends(get_session),
):
    await assert_chat_access(session, staff, chat_id)
    msgs = await crud.get_messages(session, chat_id, limit=200)
    return [_serialize_message(m) for m in msgs]


class SendMessageIn(BaseModel):
    content: str
    reply_to_id: Optional[int] = None


@router.post("/chats/{chat_id}/messages")
async def send_chat_message(
    chat_id: int,
    data: SendMessageIn,
    staff: Staff = LawyerDep,
    session: AsyncSession = Depends(get_session),
):
    chat = await assert_chat_access(session, staff, chat_id)

    # Auto-claim: if the chat is in the free pool and this is a lawyer
    # replying — assign them. Insert a visible system message so the user
    # and other staff see who took the case.
    if (
        chat.chat_type == ChatType.lawyer
        and chat.lawyer_staff_id is None
        and staff.role == StaffRole.lawyer
    ):
        chat.lawyer_staff_id = staff.id
        await session.commit()
        await session.refresh(chat)

        sys_msg = await crud.create_message(
            session,
            chat_id=chat_id,
            sender_type=SenderType.system,
            content=f"Юрист {staff.full_name} взял ваш запрос в работу.",
            message_type=MessageType.system,
            sender_name="Система",
        )
        sys_payload = {
            "type": "message",
            "id": sys_msg.id,
            "chat_id": chat_id,
            "sender_type": "system",
            "sender_name": "Система",
            "content": sys_msg.content,
            "message_type": "system",
            "created_at": sys_msg.created_at.isoformat(),
        }
        await manager.broadcast_to_chat(chat_id, sys_payload)
        await manager.broadcast_to_staff_for_chat(chat, sys_payload)
        # Tell other lawyers the chat is now taken — they should drop it from
        # their free-pool list.
        await manager.broadcast_to_all_lawyers({
            "type": "chat_claimed",
            "chat_id": chat_id,
            "claimed_by": staff.id,
        })

    msg = await crud.create_message(
        session,
        chat_id=chat_id,
        sender_type=SenderType.lawyer,
        content=data.content,
        message_type=MessageType.text,
        sender_id=staff.id,
        sender_name=staff.full_name,
        reply_to_id=data.reply_to_id,
    )

    payload = {
        "type": "message",
        "id": msg.id,
        "chat_id": chat_id,
        "sender_type": "lawyer",
        "sender_name": staff.full_name,
        "sender_id": staff.id,
        "content": data.content,
        "message_type": "text",
        "created_at": msg.created_at.isoformat(),
    }
    await manager.broadcast_to_chat(chat_id, payload)
    await manager.broadcast_to_staff_for_chat(chat, payload)
    return payload


# ── Group chats (пользователь + юрист + менеджер) ─────────────────────
def _serialize_group(c: Chat, staff_by_id: dict) -> dict:
    non_deleted = [m for m in c.messages if not m.is_deleted] if c.messages else []
    last_msg = None
    if non_deleted:
        lm = non_deleted[-1]
        last_msg = {
            "content": lm.content,
            "sender_type": lm.sender_type.value if lm.sender_type else None,
            "sender_name": lm.sender_name,
            "created_at": lm.created_at.isoformat() if lm.created_at else None,
        }
    lawyer = staff_by_id.get(c.lawyer_staff_id)
    mgr = staff_by_id.get(c.manager_staff_id)
    return {
        "id": c.id,
        "user_id": c.user_id,
        "chat_type": c.chat_type.value,
        "lawyer_staff_id": c.lawyer_staff_id,
        "manager_staff_id": c.manager_staff_id,
        "lawyer_name": lawyer.full_name if lawyer else None,
        "manager_name": mgr.full_name if mgr else None,
        "user": {
            "telegram_id": c.user.telegram_id,
            "first_name": c.user.first_name,
            "last_name": c.user.last_name,
            "username": c.user.username,
            "photo_url": c.user.photo_url,
        },
        "message_count": len(non_deleted),
        "last_message": last_msg,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/groups")
async def my_groups(
    staff: Staff = LawyerDep,
    session: AsyncSession = Depends(get_session),
):
    """Group chats this lawyer is part of (owner sees all)."""
    q = (
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.group)
    )
    if staff.role == StaffRole.lawyer:
        q = q.where(Chat.lawyer_staff_id == staff.id)
    q = q.order_by(Chat.updated_at.desc())
    chats = (await session.execute(q)).scalars().all()

    ids = {c.lawyer_staff_id for c in chats if c.lawyer_staff_id} | \
          {c.manager_staff_id for c in chats if c.manager_staff_id}
    staff_by_id = {}
    if ids:
        rows = (await session.execute(select(Staff).where(Staff.id.in_(ids)))).scalars().all()
        staff_by_id = {s.id: s for s in rows}
    return [_serialize_group(c, staff_by_id) for c in chats]
