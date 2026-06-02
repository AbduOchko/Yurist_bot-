"""Shared security primitives: password hashing, session tokens, RBAC deps."""
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from typing import Optional

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Chat, ChatType, Staff, StaffRole
from app.db.session import get_session

# ── Password hashing (PBKDF2-SHA256, stdlib only) ─────────────────────────
_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
    return f"{salt}${dk.hex()}"


def verify_password(plain: str, stored: str) -> bool:
    try:
        salt, dk_hex = stored.split("$", 1)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt.encode(), _ITERATIONS)
    return hmac.compare_digest(dk.hex(), dk_hex)


def new_token() -> str:
    return secrets.token_urlsafe(32)


# ── Login rate-limit (in-memory leaky bucket) ─────────────────────────────
_LOGIN_ATTEMPTS: dict[str, deque] = defaultdict(deque)
_LOGIN_WINDOW_SEC = 60
_LOGIN_MAX_PER_WINDOW = 5


def login_throttle(login_key: str):
    """Raise 429 if too many attempts for this login in last 60s."""
    now = time.time()
    bucket = _LOGIN_ATTEMPTS[login_key.lower()]
    # Drop old attempts
    while bucket and bucket[0] < now - _LOGIN_WINDOW_SEC:
        bucket.popleft()
    if len(bucket) >= _LOGIN_MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Слишком много попыток. Подождите минуту.")
    bucket.append(now)


# ── Staff bearer-token resolution + RBAC dependency ───────────────────────
async def _resolve_staff(token: str, session: AsyncSession) -> Optional[Staff]:
    if not token:
        return None
    result = await session.execute(select(Staff).where(Staff.session_token == token))
    staff = result.scalar_one_or_none()
    if not staff or not staff.is_active:
        return None
    return staff


def _extract_token(authorization: str) -> str:
    if not authorization:
        return ""
    return authorization.removeprefix("Bearer ").strip()


def require_role(*allowed: StaffRole):
    """FastAPI dependency: gates an endpoint by staff role.

    Usage:
        @router.get("/...")
        async def x(staff = Depends(require_role(StaffRole.owner, StaffRole.manager))):
            ...
    """
    allowed_set = set(allowed)

    async def dep(
        authorization: str = Header(default=""),
        session: AsyncSession = Depends(get_session),
    ) -> Staff:
        staff = await _resolve_staff(_extract_token(authorization), session)
        if not staff:
            raise HTTPException(status_code=401, detail="Не авторизован")
        if staff.role not in allowed_set:
            raise HTTPException(status_code=403, detail="Нет прав на это действие")
        return staff

    return dep


async def assert_chat_access(session: AsyncSession, staff: Staff, chat_id: int) -> Chat:
    """Object-level check for staff access to a chat.

    Rules:
      - owner / manager: full access to any chat (read & write).
      - lawyer: lawyer-type chats that are EITHER assigned to them OR currently
        unassigned (free pool — first lawyer to reply auto-claims, see
        lawyer.send_chat_message).

    Returns the Chat row on success, raises 404/403 otherwise.
    """
    result = await session.execute(select(Chat).where(Chat.id == chat_id))
    chat = result.scalar_one_or_none()
    if not chat:
        raise HTTPException(status_code=404, detail="Чат не найден")

    # Support chats are the owner's domain only (manager/lawyer have no access).
    if chat.chat_type == ChatType.support:
        if staff.role == StaffRole.owner:
            return chat
        raise HTTPException(status_code=403, detail="Чат поддержки доступен только владельцу")

    if staff.role in (StaffRole.owner, StaffRole.manager):
        return chat

    # lawyer
    if chat.chat_type == ChatType.lawyer:
        if chat.lawyer_staff_id == staff.id or chat.lawyer_staff_id is None:
            return chat
    raise HTTPException(status_code=403, detail="Нет доступа к этому чату")
