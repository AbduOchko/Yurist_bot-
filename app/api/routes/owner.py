"""Owner panel — full administrative control."""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sql_delete, func, select, update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload


def _friendly_conflict(e: IntegrityError) -> str:
    """Map common Postgres UNIQUE-violation messages to readable Russian."""
    msg = str(getattr(e, "orig", "") or e).lower()
    if "ix_staff_login" in msg or ("login" in msg and "unique" in msg):
        return "Логин уже занят"
    if "required_channels" in msg and "channel_id" in msg:
        return "Этот канал уже добавлен"
    return "Конфликт: значение уже занято"

from app.api.security import hash_password, require_role
from app.db import crud
from app.db.models import (
    Broadcast,
    BroadcastStatus,
    Chat,
    ChatType,
    Message,
    RequiredChannel,
    SenderType,
    Setting,
    Staff,
    StaffRole,
    User,
)
from app.db.session import get_session

router = APIRouter(prefix="/api/owner", tags=["owner"])

OwnerDep = Depends(require_role(StaffRole.owner))


# ── Helpers ───────────────────────────────────────────────────────────
def _serialize_staff(s: Staff) -> dict:
    return {
        "id": s.id,
        "role": s.role.value,
        "login": s.login,
        "full_name": s.full_name,
        "specialization": s.specialization,
        "telegram_id": s.telegram_id,
        "is_active": s.is_active,
        "is_online": s.is_online,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _serialize_support_chat(c: Chat) -> dict:
    non_deleted = [m for m in c.messages if not m.is_deleted] if c.messages else []
    last_msg = None
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


# ── Support chats (прямой чат пользователя с владельцем) ──────────────
@router.get("/support-chats")
async def list_support_chats(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    q = (
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.chat_type == ChatType.support)
        .order_by(Chat.updated_at.desc())
    )
    result = await session.execute(q)
    # Чтение и отправка сообщений идут через /api/manager/chats/{id}/messages
    # (ManagerDep уже допускает роль owner), отдельные эндпоинты не нужны.
    return [_serialize_support_chat(c) for c in result.scalars().all()]


# ── Oversight: все чаты конкретного сотрудника ────────────────────────
_TYPE_LABELS = {
    "ai": "ИИ-Советник",
    "lawyer": "Личный юрист",
    "match": "Подбор",
    "support": "Поддержка",
    "group": "Общий чат",
}


def _serialize_oversight_chat(c: Chat, names: dict) -> dict:
    non_deleted = [m for m in c.messages if not m.is_deleted] if c.messages else []
    last = None
    if non_deleted:
        lm = non_deleted[-1]
        last = {
            "content": lm.content,
            "sender_type": lm.sender_type.value if lm.sender_type else None,
            "sender_name": lm.sender_name,
            "created_at": lm.created_at.isoformat() if lm.created_at else None,
        }
    u = c.user
    return {
        "id": c.id,
        "chat_type": c.chat_type.value,
        "type_label": _TYPE_LABELS.get(c.chat_type.value, c.chat_type.value),
        "category": "group" if c.chat_type == ChatType.group else "individual",
        "user": {
            "telegram_id": u.telegram_id if u else None,
            "first_name": u.first_name if u else None,
            "last_name": u.last_name if u else None,
            "username": u.username if u else None,
            "photo_url": u.photo_url if u else None,
        },
        "lawyer_name": names.get(c.lawyer_staff_id),
        "manager_name": names.get(c.manager_staff_id),
        "message_count": len(non_deleted),
        "last_message": last,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/chats/by-staff/{staff_id}")
async def chats_by_staff(
    staff_id: int,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    """Every chat a given staff member is involved in (individual + groups)."""
    target = (await session.execute(select(Staff).where(Staff.id == staff_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Сотрудник не найден")

    chat_ids: set[int] = set()

    # Lawyer: their lawyer-type chats AND groups (both via lawyer_staff_id).
    if target.role == StaffRole.lawyer:
        rows = (await session.execute(select(Chat.id).where(Chat.lawyer_staff_id == staff_id))).scalars().all()
        chat_ids.update(rows)

    # Manager / owner: groups they own + match chats they actually replied in.
    if target.role in (StaffRole.manager, StaffRole.owner):
        rows = (await session.execute(select(Chat.id).where(Chat.manager_staff_id == staff_id))).scalars().all()
        chat_ids.update(rows)
        rows = (await session.execute(
            select(Message.chat_id)
            .join(Chat, Chat.id == Message.chat_id)
            .where(Message.sender_id == staff_id, Chat.chat_type == ChatType.match)
            .distinct()
        )).scalars().all()
        chat_ids.update(rows)

    # Owner: also the support chats (owner's domain).
    if target.role == StaffRole.owner:
        rows = (await session.execute(select(Chat.id).where(Chat.chat_type == ChatType.support))).scalars().all()
        chat_ids.update(rows)

    staff_payload = {"id": target.id, "role": target.role.value, "full_name": target.full_name}
    if not chat_ids:
        return {"staff": staff_payload, "chats": []}

    chats = (await session.execute(
        select(Chat)
        .options(selectinload(Chat.user), selectinload(Chat.messages))
        .where(Chat.id.in_(chat_ids))
        .order_by(Chat.updated_at.desc())
    )).scalars().all()

    name_ids = set()
    for c in chats:
        name_ids.update([c.lawyer_staff_id, c.manager_staff_id])
    name_ids.discard(None)
    names = {}
    if name_ids:
        srows = (await session.execute(select(Staff).where(Staff.id.in_(name_ids)))).scalars().all()
        names = {s.id: s.full_name for s in srows}

    return {"staff": staff_payload, "chats": [_serialize_oversight_chat(c, names) for c in chats]}


# ── Stats ─────────────────────────────────────────────────────────────
async def _daily_series(session, model, days: int) -> list[dict]:
    """Per-day counts for the last `days` days (gaps filled with 0)."""
    start = (datetime.utcnow() - timedelta(days=days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    conds = [model.created_at >= start]
    if model is Message:
        conds.append(Message.is_deleted == False)  # noqa: E712
    rows = (await session.execute(
        select(func.date(model.created_at), func.count())
        .where(*conds)
        .group_by(func.date(model.created_at))
    )).all()
    counts = {}
    for d, c in rows:
        key = d.isoformat() if hasattr(d, "isoformat") else str(d)
        counts[key] = int(c)
    base = start.date()
    out = []
    for i in range(days):
        key = (base + timedelta(days=i)).isoformat()
        out.append({"date": key, "count": counts.get(key, 0)})
    return out


@router.get("/stats")
async def stats(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    out = {}
    out["total_users"] = (await session.execute(select(func.count(User.id)))).scalar_one()
    out["total_messages"] = (
        await session.execute(select(func.count(Message.id)).where(Message.is_deleted == False))  # noqa: E712
    ).scalar_one()

    # Chats by type (+ flat back-compat keys)
    rows = (await session.execute(select(Chat.chat_type, func.count()).group_by(Chat.chat_type))).all()
    chats_by_type = {t.value: 0 for t in ChatType}
    for ct, c in rows:
        chats_by_type[ct.value if hasattr(ct, "value") else str(ct)] = int(c)
    out["chats_by_type"] = chats_by_type
    for t in ChatType:
        out[f"{t.value}_chats"] = chats_by_type[t.value]

    # Staff by role (active) (+ flat back-compat keys)
    rows = (await session.execute(
        select(Staff.role, func.count()).where(Staff.is_active == True).group_by(Staff.role)  # noqa: E712
    )).all()
    staff_by_role = {r.value: 0 for r in StaffRole}
    for role, c in rows:
        staff_by_role[role.value if hasattr(role, "value") else str(role)] = int(c)
    out["staff_by_role"] = staff_by_role
    for r in StaffRole:
        out[f"{r.value}_count"] = staff_by_role[r.value]

    # Messages by sender
    rows = (await session.execute(
        select(Message.sender_type, func.count())
        .where(Message.is_deleted == False)  # noqa: E712
        .group_by(Message.sender_type)
    )).all()
    by_sender = {st.value: 0 for st in SenderType}
    for st, c in rows:
        by_sender[st.value if hasattr(st, "value") else str(st)] = int(c)
    out["messages_by_sender"] = by_sender

    # Today
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    out["new_users_today"] = (
        await session.execute(select(func.count(User.id)).where(User.created_at >= today))
    ).scalar_one()
    out["messages_today"] = (
        await session.execute(
            select(func.count(Message.id)).where(Message.created_at >= today, Message.is_deleted == False)  # noqa: E712
        )
    ).scalar_one()

    # Time series for charts
    out["users_series"] = await _daily_series(session, User, 30)
    out["messages_series"] = await _daily_series(session, Message, 14)

    return out


# ── Users management ──────────────────────────────────────────────────
@router.get("/users")
async def list_users(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    users = await crud.get_all_users(session)
    return [
        {
            "id": u.id,
            "telegram_id": u.telegram_id,
            "username": u.username,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "app_login": u.app_login,
            "photo_url": u.photo_url,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    await session.delete(user)  # cascades to chats & messages
    await session.commit()
    return {"ok": True}


# ── Staff management ──────────────────────────────────────────────────
@router.get("/staff")
async def list_staff(
    role: Optional[str] = None,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    q = select(Staff).order_by(Staff.role, Staff.created_at.desc())
    if role:
        try:
            q = q.where(Staff.role == StaffRole(role))
        except ValueError:
            raise HTTPException(status_code=400, detail="Неверная роль")
    result = await session.execute(q)
    return [_serialize_staff(s) for s in result.scalars().all()]


class CreateStaffIn(BaseModel):
    role: str  # owner | manager | lawyer
    login: str
    password: str
    full_name: str
    specialization: Optional[str] = None
    telegram_id: Optional[int] = None


@router.post("/staff")
async def create_staff(
    data: CreateStaffIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    try:
        role = StaffRole(data.role)
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверная роль")
    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Пароль минимум 8 символов")

    existing = await session.execute(select(Staff).where(Staff.login == data.login.strip()))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Логин уже занят")

    # telegram_id намеренно НЕ проверяется на уникальность — один и тот же
    # Telegram ID можно привязать к любому числу сотрудников и ролей.

    s = Staff(
        role=role,
        login=data.login.strip(),
        password_hash=hash_password(data.password),
        full_name=data.full_name.strip(),
        specialization=data.specialization,
        telegram_id=data.telegram_id,
        is_active=True,
    )
    session.add(s)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail=_friendly_conflict(e))
    await session.refresh(s)
    return _serialize_staff(s)


class UpdateStaffIn(BaseModel):
    full_name: Optional[str] = None
    specialization: Optional[str] = None
    telegram_id: Optional[int] = None
    is_active: Optional[bool] = None


@router.patch("/staff/{staff_id}")
async def update_staff(
    staff_id: int,
    data: UpdateStaffIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(Staff).where(Staff.id == staff_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Не найден")
    if data.full_name is not None:
        target.full_name = data.full_name.strip()
    if data.specialization is not None:
        target.specialization = data.specialization
    if data.telegram_id is not None:
        target.telegram_id = data.telegram_id
    if data.is_active is not None:
        target.is_active = data.is_active
        if not data.is_active:
            target.session_token = None
    await session.commit()
    await session.refresh(target)
    return _serialize_staff(target)


class ResetPasswordIn(BaseModel):
    new_password: str


@router.post("/staff/{staff_id}/reset-password")
async def reset_staff_password(
    staff_id: int,
    data: ResetPasswordIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Пароль минимум 8 символов")
    result = await session.execute(select(Staff).where(Staff.id == staff_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Не найден")
    target.password_hash = hash_password(data.new_password)
    target.session_token = None  # force re-login
    await session.commit()
    return {"ok": True}


@router.delete("/staff/{staff_id}")
async def delete_staff(
    staff_id: int,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    """Hard-delete a staff member (removes the row entirely).

    Their lawyer-chats return to the free pool and broadcast authorship is
    cleared. Both FKs are ON DELETE SET NULL, but we null them explicitly so
    the delete works regardless of the DB-level FK config.

    To temporarily revoke access without losing the row, use
    PATCH /staff/{id} with {"is_active": false} instead.
    """
    if staff_id == staff.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить себя")
    result = await session.execute(select(Staff).where(Staff.id == staff_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Не найден")

    await session.execute(
        sql_update(Chat).where(Chat.lawyer_staff_id == staff_id).values(lawyer_staff_id=None)
    )
    await session.execute(
        sql_update(Broadcast).where(Broadcast.sender_staff_id == staff_id).values(sender_staff_id=None)
    )
    await session.delete(target)
    await session.commit()
    return {"ok": True}


# ── Required channels (mandatory subscription) ───────────────────────
@router.get("/channels")
async def list_channels(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(RequiredChannel).order_by(RequiredChannel.created_at.desc())
    )
    return [
        {
            "id": c.id,
            "channel_id": c.channel_id,
            "username": c.username,
            "title": c.title,
            "invite_url": c.invite_url,
            "is_active": c.is_active,
        }
        for c in result.scalars().all()
    ]


class ChannelIn(BaseModel):
    channel_id: int
    username: Optional[str] = None
    title: str
    invite_url: Optional[str] = None
    is_active: bool = True


@router.post("/channels")
async def add_channel(
    data: ChannelIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    existing = await session.execute(
        select(RequiredChannel).where(RequiredChannel.channel_id == data.channel_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Канал уже добавлен")
    ch = RequiredChannel(
        channel_id=data.channel_id,
        username=data.username,
        title=data.title.strip(),
        invite_url=data.invite_url,
        is_active=data.is_active,
    )
    session.add(ch)
    await session.commit()
    await session.refresh(ch)
    # Invalidate cache
    from app.services.subscription import invalidate_channels_cache
    invalidate_channels_cache()
    return {"ok": True, "id": ch.id}


@router.delete("/channels/{channel_id}")
async def remove_channel(
    channel_id: int,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    await session.execute(sql_delete(RequiredChannel).where(RequiredChannel.id == channel_id))
    await session.commit()
    from app.services.subscription import invalidate_channels_cache
    invalidate_channels_cache()
    return {"ok": True}


# ── Broadcasts ────────────────────────────────────────────────────────
class BroadcastIn(BaseModel):
    content: str


@router.post("/broadcasts")
async def start_broadcast(
    data: BroadcastIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    if not data.content.strip():
        raise HTTPException(status_code=400, detail="Текст пустой")

    bc = Broadcast(
        sender_staff_id=staff.id,
        content=data.content,
        status=BroadcastStatus.sending,
    )
    session.add(bc)
    await session.commit()
    await session.refresh(bc)

    # Fire-and-forget the runner
    import asyncio
    from app.services.broadcast import run_broadcast
    asyncio.create_task(run_broadcast(bc.id))

    return {"ok": True, "broadcast_id": bc.id}


@router.get("/broadcasts")
async def list_broadcasts(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Broadcast).order_by(Broadcast.created_at.desc()).limit(50)
    )
    return [
        {
            "id": b.id,
            "content": b.content,
            "status": b.status.value if b.status else None,
            "recipients_total": b.recipients_total,
            "recipients_sent": b.recipients_sent,
            "recipients_failed": b.recipients_failed,
            "created_at": b.created_at.isoformat() if b.created_at else None,
            "finished_at": b.finished_at.isoformat() if b.finished_at else None,
        }
        for b in result.scalars().all()
    ]


# ── Settings (key/value) ──────────────────────────────────────────────
@router.get("/settings")
async def list_settings(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(Setting))
    return {s.key: s.value for s in result.scalars().all()}


class SettingIn(BaseModel):
    value: str


@router.patch("/settings/{key}")
async def set_setting(
    key: str,
    data: SettingIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = data.value
    else:
        session.add(Setting(key=key, value=data.value))
    await session.commit()
    # Invalidate subscription cache if affected
    if key == "subscription_check_enabled":
        from app.services.subscription import invalidate_channels_cache
        invalidate_channels_cache()
    return {"ok": True}
