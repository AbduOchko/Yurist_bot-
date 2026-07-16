"""Required-channel subscription check.

Two layers of cache to keep this cheap on the hot path of user message sends:

  channels list cache : 60s         (re-queries DB)
  membership cache    : 5min        (re-calls Telegram bot.get_chat_member)

A FastAPI dependency `verify_subscription` raises 403 with the list of
missing channels if the user is not subscribed; the frontend catches that
specific code and shows a "subscribe & retry" modal.
"""
import asyncio
import logging
import time
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RequiredChannel, Setting
from app.db.session import get_session

logger = logging.getLogger(__name__)

# (telegram_id, channel_id) → (is_ok, expires_at_ts)
_membership_cache: dict[tuple[int, int], tuple[bool, float]] = {}
_MEMBERSHIP_TTL = 300  # 5 minutes

# Cached channels + settings
_channels_cache: Optional[list[RequiredChannel]] = None
_channels_cache_ts: float = 0.0
_CHANNELS_TTL = 60

_setting_enabled_cache: Optional[bool] = None
_setting_enabled_ts: float = 0.0
_SETTING_TTL = 60


def invalidate_channels_cache():
    """Called by owner endpoints when channels list or settings change."""
    global _channels_cache, _channels_cache_ts, _setting_enabled_cache, _setting_enabled_ts
    _channels_cache = None
    _channels_cache_ts = 0.0
    _setting_enabled_cache = None
    _setting_enabled_ts = 0.0
    _membership_cache.clear()


async def _is_check_enabled(session: AsyncSession) -> bool:
    global _setting_enabled_cache, _setting_enabled_ts
    now = time.time()
    if _setting_enabled_cache is not None and now - _setting_enabled_ts < _SETTING_TTL:
        return _setting_enabled_cache
    result = await session.execute(
        select(Setting).where(Setting.key == "subscription_check_enabled")
    )
    row = result.scalar_one_or_none()
    # Default: disabled (so the app keeps working out of the box).
    enabled = (row is not None and row.value == "1")
    _setting_enabled_cache = enabled
    _setting_enabled_ts = now
    return enabled


async def _get_required_channels(session: AsyncSession) -> list[RequiredChannel]:
    global _channels_cache, _channels_cache_ts
    now = time.time()
    if _channels_cache is not None and now - _channels_cache_ts < _CHANNELS_TTL:
        return _channels_cache
    result = await session.execute(
        select(RequiredChannel).where(RequiredChannel.is_active == True)  # noqa: E712
    )
    channels = list(result.scalars().all())
    _channels_cache = channels
    _channels_cache_ts = now
    return channels


async def _check_one_channel(bot, channel_id: int, telegram_id: int) -> bool:
    cached = _membership_cache.get((telegram_id, channel_id))
    now = time.time()
    if cached and cached[1] > now:
        return cached[0]
    try:
        member = await bot.get_chat_member(chat_id=channel_id, user_id=telegram_id)
        status = getattr(member, "status", None)
        ok = str(status) in ("member", "administrator", "creator", "ChatMemberStatus.MEMBER",
                             "ChatMemberStatus.ADMINISTRATOR", "ChatMemberStatus.CREATOR")
        # aiogram returns an enum; fall back to .value
        if not ok and status is not None:
            val = getattr(status, "value", "")
            ok = val in ("member", "administrator", "creator")
    except Exception as e:
        # If the API errors (e.g. bot not admin of channel), treat as ok=False
        # but log loudly — owner needs to fix bot permissions.
        logger.warning(f"get_chat_member failed (channel={channel_id}, user={telegram_id}): {e}")
        ok = False
    _membership_cache[(telegram_id, channel_id)] = (ok, now + _MEMBERSHIP_TTL)
    return ok


async def check_subscribed(telegram_id: int, session: AsyncSession) -> list[dict]:
    """Return list of channels the user must still join (empty = all good)."""
    if not await _is_check_enabled(session):
        return []
    channels = await _get_required_channels(session)
    if not channels:
        return []

    from app.bot.bot import get_bot
    bot = get_bot()

    results = await asyncio.gather(
        *(_check_one_channel(bot, c.channel_id, telegram_id) for c in channels),
        return_exceptions=True,
    )
    missing = []
    for ch, ok in zip(channels, results):
        if ok is not True:
            missing.append({
                "channel_id": ch.channel_id,
                "username": ch.username,
                "title": ch.title,
                "invite_url": ch.invite_url,
            })
    return missing


async def enforce_subscription(telegram_id: Optional[int], session: AsyncSession):
    """Проверка подписки по УЖЕ подтверждённому telegram_id аккаунта.

    Используется на защищённых пользовательских эндпоинтах (сообщения, ИИ) вместо
    verify_subscription: там telegram_id берётся из аутентифицированного User, а
    не из тела запроса, поэтому его нельзя подменить. No-op, если проверка
    выключена, каналов нет или telegram_id неизвестен. 403 с missing-каналами.
    """
    if telegram_id is None:
        return
    missing = await check_subscribed(telegram_id, session)
    if missing:
        raise HTTPException(
            status_code=403,
            detail={"reason": "subscription_required", "channels": missing},
        )


async def verify_subscription(
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """FastAPI dependency: reads the JSON body once (Starlette caches it so the
    endpoint's own Pydantic parsing still works), extracts telegram_id from any
    of the common user-side fields, and raises 403 with the missing channels.

    A no-op if the check is disabled in settings, the body has no telegram_id,
    or there are no required channels configured.
    """
    telegram_id = None
    try:
        body = await request.json()
    except Exception:
        body = None
    if isinstance(body, dict):
        # user-side endpoints carry telegram_id under one of these names
        for key in ("telegram_id", "user_id", "sender_id"):
            v = body.get(key)
            if v is not None:
                telegram_id = v
                break

    if telegram_id is None:
        return  # nothing to check — let the endpoint enforce auth itself
    try:
        telegram_id = int(telegram_id)
    except (TypeError, ValueError):
        return

    missing = await check_subscribed(telegram_id, session)
    if missing:
        raise HTTPException(
            status_code=403,
            detail={"reason": "subscription_required", "channels": missing},
        )
