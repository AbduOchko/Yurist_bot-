"""Manager panel endpoints: match-chats triage, lawyer directory, assignment."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from sqlalchemy.exc import IntegrityError

from app.api.routes.owner import _friendly_conflict
from app.api.security import (
    assert_chat_access,
    hash_password,
    require_role,
)
from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import Chat, ChatType, MessageType, SenderType, Staff, StaffRole
from app.db.session import get_session

router = APIRouter(prefix="/api/manager", tags=["manager"])

ManagerDep = Depends(require_role(StaffRole.manager, StaffRole.owner))


def _serialize_chat(c: Chat) -> dict:
    last_msg = None
    non_deleted = [m for m in c.messages if not m.is_deleted] if c.messages else []
    if non_deleted:
        lm = non_deleted[-1]
        last_msg = {
            "content": lm.content,
            "sender_type": lm.sender_type.value if lm.sender_type else None,
            "created_at": lm.created_at.isoformat() if lm.created_at else None,
        }
    return {
        "id": c.id,
        "user_id": c.user_id,
        "chat_type": c.chat_type.value,
        "lawyer_staff_id": c.lawyer_staff_id,
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


def _serialize_lawyer(s: Staff) -> dict:
    return {
        "id": s.id,
        "login": s.login,
        "full_name": s.full_name,
        "specialization": s.specialization,
        "telegram_id": s.telegram_id,
        "is_active": s.is_active,
        "is_online": s.is_online,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


# ── Match chats (Подбор Юриста) ───────────────────────────────────────
@router.get("/match-chats")
async def list_match_chats(
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    q = (
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.match)
        .order_by(Chat.updated_at.desc())
    )
    result = await session.execute(q)
    return [_serialize_chat(c) for c in result.scalars().all()]


# ── Lawyer chats (all) — manager view ─────────────────────────────────
@router.get("/lawyer-chats")
async def list_lawyer_chats(
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    q = (
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.lawyer)
        .order_by(Chat.updated_at.desc())
    )
    result = await session.execute(q)
    return [_serialize_chat(c) for c in result.scalars().all()]


@router.get("/chats/{chat_id}/messages")
async def chat_messages(
    chat_id: int,
    staff: Staff = ManagerDep,
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
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    chat = await assert_chat_access(session, staff, chat_id)
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


# ── Lawyer directory (CRUD) ───────────────────────────────────────────
@router.get("/lawyers")
async def list_lawyers(
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    q = select(Staff).where(Staff.role == StaffRole.lawyer).order_by(Staff.created_at.desc())
    result = await session.execute(q)
    return [_serialize_lawyer(s) for s in result.scalars().all()]


class CreateLawyerIn(BaseModel):
    login: str
    password: str
    full_name: str
    specialization: Optional[str] = None
    telegram_id: Optional[int] = None


@router.post("/lawyers")
async def create_lawyer(
    data: CreateLawyerIn,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Пароль минимум 8 символов")

    # Логин обязан быть уникальным; telegram_id намеренно НЕ проверяется —
    # один Telegram ID можно привязать к любому числу юристов.
    existing = await session.execute(select(Staff).where(Staff.login == data.login.strip()))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Логин уже занят")

    lawyer = Staff(
        role=StaffRole.lawyer,
        login=data.login.strip(),
        password_hash=hash_password(data.password),
        full_name=data.full_name.strip(),
        specialization=data.specialization,
        telegram_id=data.telegram_id,
        is_active=True,
    )
    session.add(lawyer)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail=_friendly_conflict(e))
    await session.refresh(lawyer)
    return _serialize_lawyer(lawyer)


class UpdateLawyerIn(BaseModel):
    full_name: Optional[str] = None
    specialization: Optional[str] = None
    telegram_id: Optional[int] = None
    is_active: Optional[bool] = None


@router.patch("/lawyers/{lawyer_id}")
async def update_lawyer(
    lawyer_id: int,
    data: UpdateLawyerIn,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Staff).where(Staff.id == lawyer_id, Staff.role == StaffRole.lawyer)
    )
    lawyer = result.scalar_one_or_none()
    if not lawyer:
        raise HTTPException(status_code=404, detail="Юрист не найден")

    if data.full_name is not None:
        lawyer.full_name = data.full_name.strip()
    if data.specialization is not None:
        lawyer.specialization = data.specialization
    if data.telegram_id is not None:
        lawyer.telegram_id = data.telegram_id
    if data.is_active is not None:
        lawyer.is_active = data.is_active

    await session.commit()
    await session.refresh(lawyer)
    return _serialize_lawyer(lawyer)


@router.delete("/lawyers/{lawyer_id}")
async def delete_lawyer(
    lawyer_id: int,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    # Soft delete (is_active=False) — preserves chat history references.
    result = await session.execute(
        select(Staff).where(Staff.id == lawyer_id, Staff.role == StaffRole.lawyer)
    )
    lawyer = result.scalar_one_or_none()
    if not lawyer:
        raise HTTPException(status_code=404, detail="Юрист не найден")
    lawyer.is_active = False
    lawyer.session_token = None
    await session.commit()
    return {"ok": True}


# ── Assign lawyer to user ─────────────────────────────────────────────
class AssignLawyerIn(BaseModel):
    user_id: int
    lawyer_id: int


@router.post("/assign-lawyer")
async def assign_lawyer(
    data: AssignLawyerIn,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    # Verify lawyer exists & active
    res = await session.execute(
        select(Staff).where(
            Staff.id == data.lawyer_id,
            Staff.role == StaffRole.lawyer,
            Staff.is_active == True,  # noqa: E712
        )
    )
    lawyer = res.scalar_one_or_none()
    if not lawyer:
        raise HTTPException(status_code=404, detail="Юрист не найден или не активен")

    # Find or create lawyer-chat for this user
    chat = await crud.get_or_create_chat(session, user_id=data.user_id, chat_type=ChatType.lawyer)
    chat.lawyer_staff_id = lawyer.id
    await session.commit()
    await session.refresh(chat)

    # Insert system message — visible to user & creates an audit trail
    system_msg = await crud.create_message(
        session,
        chat_id=chat.id,
        sender_type=SenderType.system,
        content=f"Назначен юрист: {lawyer.full_name}",
        message_type=MessageType.system,
        sender_name="Система",
    )
    payload = {
        "type": "message",
        "id": system_msg.id,
        "chat_id": chat.id,
        "sender_type": "system",
        "sender_name": "Система",
        "content": system_msg.content,
        "message_type": "system",
        "created_at": system_msg.created_at.isoformat(),
    }
    await manager.broadcast_to_chat(chat.id, payload)
    # Notify the assigned lawyer's WS so the new chat appears in their list
    await manager.broadcast_to_lawyer(
        lawyer.id,
        {"type": "chat_assigned", "chat_id": chat.id, "user_id": data.user_id},
    )
    await manager.broadcast_to_owners({"type": "chat_assigned", "chat_id": chat.id, "lawyer_id": lawyer.id})

    return {"ok": True, "chat_id": chat.id, "lawyer_id": lawyer.id}
