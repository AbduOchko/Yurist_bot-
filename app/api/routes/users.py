from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.crud import get_or_create_user, get_all_users
from app.db.session import get_session

router = APIRouter(prefix="/api/users", tags=["users"])


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
async def create_or_get_user(data: UserIn, session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(
        session,
        telegram_id=data.telegram_id,
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
    )
    return user


@router.get("/", response_model=list[UserOut])
async def list_users(session: AsyncSession = Depends(get_session)):
    return await get_all_users(session)
