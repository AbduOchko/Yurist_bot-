import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.security import hash_password, login_throttle, new_token, verify_password
from app.db.models import User
from app.db.session import get_session

router = APIRouter(prefix="/api/auth", tags=["auth"])

LOGIN_RE = re.compile(r"^[a-zA-Zа-яА-ЯёЁ0-9_]{3,30}$")


class CheckIn(BaseModel):
    telegram_id: int


class RegisterIn(BaseModel):
    telegram_id: int
    login: str
    password: str
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None


class LoginIn(BaseModel):
    telegram_id: int
    login: str
    password: str


class VerifyIn(BaseModel):
    token: str


@router.post("/check")
async def check_account(data: CheckIn, session: AsyncSession = Depends(get_session)):
    """Check whether this Telegram user already has an app account."""
    result = await session.execute(
        select(User).where(User.telegram_id == data.telegram_id)
    )
    user = result.scalar_one_or_none()
    has_account = user is not None and user.app_login is not None
    return {"has_account": has_account}


@router.post("/register")
async def register(data: RegisterIn, session: AsyncSession = Depends(get_session)):
    login = data.login.strip()

    # Validate login format
    if not LOGIN_RE.match(login):
        raise HTTPException(
            status_code=400,
            detail="Логин должен быть 3–30 символов: буквы, цифры, знак _"
        )

    # Validate password length
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Пароль минимум 6 символов")

    # Check login uniqueness
    existing = await session.execute(select(User).where(User.app_login == login))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Этот логин уже занят")

    # Get or create user by telegram_id
    result = await session.execute(
        select(User).where(User.telegram_id == data.telegram_id)
    )
    user = result.scalar_one_or_none()

    token = new_token()

    if user:
        if user.app_login:
            raise HTTPException(status_code=409, detail="Аккаунт уже существует")
        user.app_login = login
        user.app_password_hash = hash_password(data.password)
        user.session_token = token
    else:
        user = User(
            telegram_id=data.telegram_id,
            username=data.username,
            first_name=data.first_name,
            last_name=data.last_name,
            app_login=login,
            app_password_hash=hash_password(data.password),
            session_token=token,
        )
        session.add(user)

    await session.commit()
    await session.refresh(user)

    return {
        "ok": True,
        "token": token,
        "user_id": user.id,
        "login": user.app_login,
    }


@router.post("/login")
async def login(data: LoginIn, session: AsyncSession = Depends(get_session)):
    login_str = data.login.strip()
    login_throttle(f"user:{login_str.lower()}")

    # Find user by telegram_id first, then verify login matches
    result = await session.execute(
        select(User).where(User.telegram_id == data.telegram_id)
    )
    user = result.scalar_one_or_none()

    if not user or not user.app_login or not user.app_password_hash:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    if user.app_login.lower() != login_str.lower():
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    if not verify_password(data.password, user.app_password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    token = new_token()
    user.session_token = token
    await session.commit()

    return {
        "ok": True,
        "token": token,
        "user_id": user.id,
        "login": user.app_login,
    }


@router.post("/verify")
async def verify(data: VerifyIn, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(User).where(User.session_token == data.token)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    return {
        "ok": True,
        "user_id": user.id,
        "telegram_id": user.telegram_id,
        "login": user.app_login,
        "photo_url": user.photo_url,
        "first_name": user.first_name,
        "last_name": user.last_name,
    }
