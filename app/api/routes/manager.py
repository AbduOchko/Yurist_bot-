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
from app.api.utils import iso_utc
from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import Chat, ChatType, MessageType, SenderType, Staff, StaffRole, User
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
            "created_at": iso_utc(lm.created_at),
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
        "updated_at": iso_utc(c.updated_at),
    }


def _serialize_message(m) -> dict:
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "sender_type": m.sender_type.value if m.sender_type else None,
        "sender_name": m.sender_name,
        "sender_id": m.sender_id,
        "content": m.content,
        "caption": m.caption,
        "message_type": m.message_type.value if m.message_type else None,
        "file_url": m.file_url,
        "file_name": m.file_name,
        "file_size": m.file_size,
        "created_at": iso_utc(m.created_at),
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
        "created_at": iso_utc(s.created_at),
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
    # In group chats the manager writes as `manager` (so the UI can tell manager
    # apart from lawyer); elsewhere they write as generic staff (`lawyer`).
    stype = SenderType.manager if chat.chat_type == ChatType.group else SenderType.lawyer
    msg = await crud.create_message(
        session,
        chat_id=chat_id,
        sender_type=stype,
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
        "sender_type": stype.value,
        "sender_name": staff.full_name,
        "sender_id": staff.id,
        "content": data.content,
        "message_type": "text",
        "created_at": iso_utc(msg.created_at),
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
        "created_at": iso_utc(system_msg.created_at),
    }
    await manager.broadcast_to_chat(chat.id, payload)
    # Notify the assigned lawyer's WS so the new chat appears in their list
    await manager.broadcast_to_lawyer(
        lawyer.id,
        {"type": "chat_assigned", "chat_id": chat.id, "user_id": data.user_id},
    )
    await manager.broadcast_to_owners({"type": "chat_assigned", "chat_id": chat.id, "lawyer_id": lawyer.id})

    return {"ok": True, "chat_id": chat.id, "lawyer_id": lawyer.id}


# ── Unified inbox: every user + their manager-channel (match) chat ─────
@router.get("/users")
async def list_users_inbox(
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    """All bot users with a summary of their manager↔user (match) chat.

    The manager can write to anyone — even users who only ever used the AI.
    Opening a user without an existing chat lazily creates one (see /chats/open).
    """
    users = await crud.get_all_users(session)
    chats = (
        await session.execute(
            select(Chat)
            .options(selectinload(Chat.messages))
            .where(Chat.chat_type == ChatType.match)
        )
    ).scalars().all()
    by_user = {c.user_id: c for c in chats}

    out = []
    for u in users:
        c = by_user.get(u.id)
        last, count, chat_id, updated = None, 0, None, None
        if c:
            non_deleted = [m for m in c.messages if not m.is_deleted]
            count = len(non_deleted)
            chat_id = c.id
            updated = iso_utc(c.updated_at)
            if non_deleted:
                lm = non_deleted[-1]
                last = {
                    "content": lm.content,
                    "sender_type": lm.sender_type.value if lm.sender_type else None,
                    "created_at": iso_utc(lm.created_at),
                }
        out.append({
            "user_id": u.id,
            "telegram_id": u.telegram_id,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "username": u.username,
            "photo_url": u.photo_url,
            "chat_id": chat_id,
            "message_count": count,
            "last_message": last,
            "updated_at": updated,
            "created_at": iso_utc(u.created_at),
        })

    out.sort(key=lambda r: (r["updated_at"] or r["created_at"] or ""), reverse=True)
    return out


class OpenChatIn(BaseModel):
    user_id: int


@router.post("/chats/open")
async def open_user_chat(
    data: OpenChatIn,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    """Get-or-create the manager↔user (match) chat for a user, return its id."""
    chat = await crud.get_or_create_chat(session, user_id=data.user_id, chat_type=ChatType.match)
    return {"chat_id": chat.id}


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
            "created_at": iso_utc(lm.created_at),
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
        "updated_at": iso_utc(c.updated_at),
    }


async def _groups_with_names(session, base_query):
    chats = (await session.execute(base_query)).scalars().all()
    ids = {c.lawyer_staff_id for c in chats if c.lawyer_staff_id} | \
          {c.manager_staff_id for c in chats if c.manager_staff_id}
    staff_by_id = {}
    if ids:
        rows = (await session.execute(select(Staff).where(Staff.id.in_(ids)))).scalars().all()
        staff_by_id = {s.id: s for s in rows}
    return [_serialize_group(c, staff_by_id) for c in chats]


@router.get("/groups")
async def list_groups(
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    """Group chats. Manager sees their own; owner sees all."""
    q = (
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.group)
    )
    if staff.role == StaffRole.manager:
        q = q.where(Chat.manager_staff_id == staff.id)
    q = q.order_by(Chat.updated_at.desc())
    return await _groups_with_names(session, q)


class CreateGroupIn(BaseModel):
    user_id: int
    lawyer_id: int


@router.post("/groups")
async def create_group(
    data: CreateGroupIn,
    staff: Staff = ManagerDep,
    session: AsyncSession = Depends(get_session),
):
    lawyer = (await session.execute(
        select(Staff).where(
            Staff.id == data.lawyer_id,
            Staff.role == StaffRole.lawyer,
            Staff.is_active == True,  # noqa: E712
        )
    )).scalar_one_or_none()
    if not lawyer:
        raise HTTPException(status_code=404, detail="Юрист не найден или не активен")

    user = (await session.execute(select(User).where(User.id == data.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    chat = Chat(
        chat_type=ChatType.group,
        user_id=data.user_id,
        lawyer_staff_id=lawyer.id,
        manager_staff_id=staff.id,
    )
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    sys_msg = await crud.create_message(
        session,
        chat_id=chat.id,
        sender_type=SenderType.system,
        content=(
            f"Создан общий чат. Участники: "
            f"клиент {user.first_name or 'пользователь'}, "
            f"юрист {lawyer.full_name}, менеджер {staff.full_name}."
        ),
        message_type=MessageType.system,
        sender_name="Система",
    )
    payload = {
        "type": "message",
        "id": sys_msg.id,
        "chat_id": chat.id,
        "sender_type": "system",
        "sender_name": "Система",
        "content": sys_msg.content,
        "message_type": "system",
        "created_at": iso_utc(sys_msg.created_at),
    }
    await manager.broadcast_to_chat(chat.id, payload)
    await manager.broadcast_to_staff_for_chat(chat, payload)
    # Tell the lawyer a new group appeared so it shows up in their list live.
    await manager.broadcast_to_lawyer(lawyer.id, {"type": "group_created", "chat_id": chat.id})

    return {"ok": True, "chat_id": chat.id}
