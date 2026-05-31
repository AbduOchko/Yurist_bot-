"""Telegram broadcast runner.

Triggered by `POST /api/owner/broadcasts` via `asyncio.create_task`.
Iterates over users with a telegram_id, sends the message under a semaphore
(rough rate-limit), updates counters on the Broadcast row, and emits
progress events to the owner WebSocket pool.
"""
import asyncio
import logging
from datetime import datetime

from sqlalchemy import select

from app.api.websocket_manager import manager
from app.db.models import Broadcast, BroadcastStatus, User
from app.db.session import async_session_maker

logger = logging.getLogger(__name__)

CONCURRENCY = 25     # Telegram global cap is ~30 msg/sec
PROGRESS_EVERY = 25  # WS event cadence


async def _send_one(bot, semaphore, telegram_id: int, text: str) -> bool:
    """Send a single message. Returns True on success."""
    from aiogram.exceptions import TelegramRetryAfter

    async with semaphore:
        for attempt in range(3):
            try:
                await bot.send_message(chat_id=telegram_id, text=text)
                return True
            except TelegramRetryAfter as e:
                await asyncio.sleep(min(e.retry_after, 30))
            except Exception as e:
                logger.warning(f"Broadcast send failed (tg_id={telegram_id}): {e}")
                return False
        return False


async def run_broadcast(broadcast_id: int):
    """Background runner for a single Broadcast row."""
    from app.bot.bot import get_bot

    bot = get_bot()

    async with async_session_maker() as session:
        bc = (await session.execute(select(Broadcast).where(Broadcast.id == broadcast_id))).scalar_one_or_none()
        if not bc:
            logger.error(f"run_broadcast: row {broadcast_id} not found")
            return

        # Gather recipient telegram_ids
        users = (
            await session.execute(
                select(User.telegram_id).where(User.telegram_id.isnot(None))
            )
        ).scalars().all()

        bc.recipients_total = len(users)
        await session.commit()

        await manager.broadcast_to_owners({
            "type": "broadcast_started",
            "broadcast_id": broadcast_id,
            "total": bc.recipients_total,
        })

        sent = 0
        failed = 0
        sem = asyncio.Semaphore(CONCURRENCY)

        async def worker(tg_id: int):
            nonlocal sent, failed
            ok = await _send_one(bot, sem, tg_id, bc.content)
            if ok:
                sent += 1
            else:
                failed += 1

        # Fire all tasks; the semaphore throttles concurrency
        tasks = [asyncio.create_task(worker(tg_id)) for tg_id in users]

        progress_seen = 0
        for fut in asyncio.as_completed(tasks):
            await fut
            done = sent + failed
            if done - progress_seen >= PROGRESS_EVERY:
                progress_seen = done
                await manager.broadcast_to_owners({
                    "type": "broadcast_progress",
                    "broadcast_id": broadcast_id,
                    "sent": sent,
                    "failed": failed,
                    "total": bc.recipients_total,
                })
                # persist intermediate progress
                bc.recipients_sent = sent
                bc.recipients_failed = failed
                await session.commit()

        # Finalize
        bc.recipients_sent = sent
        bc.recipients_failed = failed
        bc.status = BroadcastStatus.done if failed == 0 else (
            BroadcastStatus.done if sent > 0 else BroadcastStatus.failed
        )
        bc.finished_at = datetime.utcnow()
        await session.commit()

    await manager.broadcast_to_owners({
        "type": "broadcast_done",
        "broadcast_id": broadcast_id,
        "sent": sent,
        "failed": failed,
    })
