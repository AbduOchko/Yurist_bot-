"""Legacy /api/users endpoints.

Оба эндпоинта больше НЕ используются фронтендом (регистрация идёт через
/api/auth, чаты — через /api/chats по вошедшей учётке). Раньше GET / отдавал
СПИСОК ВСЕХ пользователей без авторизации (утечка telegram_id, логинов, имён), а
POST / позволял создавать пользователей кому угодно. Закрыто ролью владельца —
публичного доступа больше нет. Данные о пользователях владелец смотрит в
/api/owner/users.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.security import require_role
from app.db.crud import get_or_create_user, get_all_users
from app.db.models import Staff, StaffRole
from app.db.session import get_session

router = APIRouter(prefix="/api/users", tags=["users"])

OwnerDep = Depends(require_role(StaffRole.owner))


class UserIn(BaseModel):
    telegram_id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None


class UserOut(BaseModel):
    id: int
    telegram_id: int
    username: str | None
    first_name: str | None
    last_name: str | None

    class Config:
        from_attributes = True


@router.post("/", response_model=UserOut)
async def create_or_get_user(
    data: UserIn,
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    user = await get_or_create_user(
        session,
        telegram_id=data.telegram_id,
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
    )
    return user


@router.get("/", response_model=list[UserOut])
async def list_users(
    staff: Staff = OwnerDep,
    session: AsyncSession = Depends(get_session),
):
    return await get_all_users(session)
