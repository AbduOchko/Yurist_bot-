"""Auth endpoints for staff (lawyer / manager / owner).

Single login endpoint resolves the role from the staff table — clients send
just login+password and get back a bearer token plus their role, which the
frontend uses to decide which panel UI to render.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.security import (
    hash_password,
    login_throttle,
    new_token,
    require_role,
    verify_password,
)
from app.db.models import Staff, StaffRole
from app.db.session import get_session

router = APIRouter(prefix="/api/staff", tags=["staff-auth"])


# ── Models ────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    login: str
    password: str


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str


def _staff_payload(staff: Staff) -> dict:
    return {
        "id": staff.id,
        "role": staff.role.value,
        "login": staff.login,
        "full_name": staff.full_name,
        "telegram_id": staff.telegram_id,
        "specialization": staff.specialization,
        "is_online": staff.is_online,
    }


# ── Endpoints ─────────────────────────────────────────────────────────
@router.post("/login")
async def staff_login(data: LoginIn, session: AsyncSession = Depends(get_session)):
    login = data.login.strip()
    if not login or not data.password:
        raise HTTPException(status_code=400, detail="Заполните логин и пароль")

    login_throttle(f"staff:{login.lower()}")

    result = await session.execute(
        select(Staff).where(Staff.login == login, Staff.is_active == True)  # noqa: E712
    )
    staff = result.scalar_one_or_none()
    if not staff or not verify_password(data.password, staff.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    token = new_token()
    staff.session_token = token
    await session.commit()

    return {"ok": True, "token": token, **_staff_payload(staff)}


@router.post("/verify")
async def staff_verify(staff: Staff = Depends(require_role(StaffRole.owner, StaffRole.manager, StaffRole.lawyer))):
    """Confirms the bearer token is valid and returns the current staff profile."""
    return {"ok": True, **_staff_payload(staff)}


@router.post("/logout")
async def staff_logout(
    staff: Staff = Depends(require_role(StaffRole.owner, StaffRole.manager, StaffRole.lawyer)),
    session: AsyncSession = Depends(get_session),
):
    staff.session_token = None
    await session.commit()
    return {"ok": True}


@router.post("/change-password")
async def staff_change_password(
    data: ChangePasswordIn,
    staff: Staff = Depends(require_role(StaffRole.owner, StaffRole.manager, StaffRole.lawyer)),
    session: AsyncSession = Depends(get_session),
):
    if not verify_password(data.old_password, staff.password_hash):
        raise HTTPException(status_code=401, detail="Старый пароль неверный")
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Новый пароль минимум 8 символов")

    staff.password_hash = hash_password(data.new_password)
    staff.password_plain = data.new_password  # чтобы владелец видел актуальный пароль
    staff.session_token = new_token()  # invalidate other sessions
    await session.commit()
    return {"ok": True, "token": staff.session_token}
