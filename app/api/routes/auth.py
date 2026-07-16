import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
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
    # telegram_id принимается для обратной совместимости, но НЕ используется:
    # аккаунт определяется логином, вход идёт по паре логин+пароль.
    telegram_id: int | None = None
    login: str
    password: str


class VerifyIn(BaseModel):
    token: str


@router.post("/check")
async def check_account(data: CheckIn, session: AsyncSession = Depends(get_session)):
    """Есть ли у этого Telegram-аккаунта хотя бы одна учётка в приложении.

    Нужно только чтобы фронт выбрал вкладку по умолчанию (вход vs регистрация).
    Один telegram_id может держать несколько учёток, поэтому считаем количество,
    а не берём одну строку."""
    count = (await session.execute(
        select(func.count(User.id)).where(
            User.telegram_id == data.telegram_id,
            User.app_login.isnot(None),
        )
    )).scalar_one()
    return {"has_account": count > 0}


@router.post("/register")
async def register(data: RegisterIn, session: AsyncSession = Depends(get_session)):
    """Создать новую учётку в приложении.

    Аккаунт определяется логином, а НЕ telegram_id: один Telegram-аккаунт может
    завести сколько угодно учёток, лишь бы логины были разными. Первая
    регистрация с данного telegram_id «усыновляет» пустую строку, созданную
    ботом на /start (telegram_id есть, app_login=NULL); последующие — заводят
    новую строку. Каждая учётка получает свои чаты (Chat.user_id → users.id)."""
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

    # Логин уникален без учёта регистра (вход сравнивает по lower()). Проверяем
    # так же, иначе «Ivan» и «ivan» стали бы разными логинами, а войти нельзя.
    existing = (await session.execute(
        select(User).where(func.lower(User.app_login) == login.lower())
    )).scalars().first()
    if existing:
        raise HTTPException(status_code=409, detail="Этот логин уже занят")

    token = new_token()

    # Пустая /start-строка этого telegram_id (если есть) — займём её под первую учётку.
    shell = (await session.execute(
        select(User)
        .where(User.telegram_id == data.telegram_id, User.app_login.is_(None))
        .order_by(User.id)
        .limit(1)
    )).scalars().first()

    if shell:
        shell.app_login = login
        shell.app_password_hash = hash_password(data.password)
        shell.session_token = token
        if data.username:
            shell.username = data.username
        if data.first_name:
            shell.first_name = data.first_name
        if data.last_name:
            shell.last_name = data.last_name
        user = shell
    else:
        # Подтянем аватар из любой существующей учётки того же telegram_id.
        photo = (await session.execute(
            select(User.photo_url)
            .where(User.telegram_id == data.telegram_id, User.photo_url.isnot(None))
            .limit(1)
        )).scalar_one_or_none()
        user = User(
            telegram_id=data.telegram_id,
            username=data.username,
            first_name=data.first_name,
            last_name=data.last_name,
            app_login=login,
            app_password_hash=hash_password(data.password),
            session_token=token,
            photo_url=photo,
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
    """Вход по паре логин+пароль. telegram_id не участвует — учётка ищется
    строго по логину (он глобально уникален), поэтому один Telegram-аккаунт
    может входить в любую из своих (и вообще любую известную ему) учёток."""
    login_str = data.login.strip()
    login_throttle(f"user:{login_str.lower()}")

    user = (await session.execute(
        select(User)
        .where(
            func.lower(User.app_login) == login_str.lower(),
            User.app_password_hash.isnot(None),
        )
        .limit(1)
    )).scalars().first()

    if not user or not verify_password(data.password, user.app_password_hash):
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
