"""Owner panel — full administrative control."""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sql_delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession


def _friendly_conflict(e: IntegrityError) -> str:
    """Map common Postgres UNIQUE-violation messages to readable Russian."""
    msg = str(getattr(e, "orig", "") or e).lower()
    if "ux_staff_tg_role" in msg:
        return "У этого Telegram ID уже есть такая роль"
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


# ── Stats ─────────────────────────────────────────────────────────────
@router.get("/stats")
async def stats(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    counts = {}
    counts["total_users"] = (await session.execute(select(func.count(User.id)))).scalar_one()
    counts["total_messages"] = (
        await session.execute(select(func.count(Message.id)).where(Message.is_deleted == False))  # noqa: E712
    ).scalar_one()
    for t in (ChatType.ai, ChatType.lawyer, ChatType.match):
        counts[f"{t.value}_chats"] = (
            await session.execute(select(func.count(Chat.id)).where(Chat.chat_type == t))
        ).scalar_one()
    for r in (StaffRole.lawyer, StaffRole.manager, StaffRole.owner):
        counts[f"{r.value}_count"] = (
            await session.execute(
                select(func.count(Staff.id)).where(Staff.role == r, Staff.is_active == True)  # noqa: E712
            )
        ).scalar_one()
    return counts


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

    if data.telegram_id:
        existing_tg = await session.execute(
            select(Staff).where(
                Staff.telegram_id == data.telegram_id,
                Staff.role == role,
            )
        )
        if existing_tg.scalar_one_or_none():
            raise HTTPException(
                status_code=409,
                detail=f"У этого Telegram ID уже есть роль «{role.value}»",
            )

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
    if staff_id == staff.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить себя")
    result = await session.execute(select(Staff).where(Staff.id == staff_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Не найден")
    target.is_active = False
    target.session_token = None
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
