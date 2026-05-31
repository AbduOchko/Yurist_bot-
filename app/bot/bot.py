import logging
from typing import Optional

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app.bot.handlers import staff, start
from app.config import settings

logger = logging.getLogger(__name__)

# Singletons — broadcast service and webhook handler share the same Bot.
_bot_singleton: Optional[Bot] = None
_dp_singleton: Optional[Dispatcher] = None


def create_bot() -> Bot:
    return Bot(
        token=settings.BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )


def create_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(start.router)
    dp.include_router(staff.router)
    return dp


def get_bot() -> Bot:
    global _bot_singleton
    if _bot_singleton is None:
        _bot_singleton = create_bot()
    return _bot_singleton


def get_dispatcher() -> Dispatcher:
    global _dp_singleton
    if _dp_singleton is None:
        _dp_singleton = create_dispatcher()
    return _dp_singleton


async def setup_webhook(bot: Bot):
    webhook_url = settings.WEBHOOK_URL
    if webhook_url:
        await bot.set_webhook(
            url=f"{webhook_url.rstrip('/')}/webhook",
            drop_pending_updates=True,
        )
        logger.info(f"Webhook set to {webhook_url}/webhook")
    else:
        await bot.delete_webhook(drop_pending_updates=True)
        logger.info("Webhook deleted, using polling mode")


async def start_polling(bot: Bot, dp: Dispatcher):
    logger.info("Starting bot in polling mode")
    await dp.start_polling(bot, allowed_updates=["message", "callback_query"])
