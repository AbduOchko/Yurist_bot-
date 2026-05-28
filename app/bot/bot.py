import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app.bot.handlers import start
from app.config import settings

logger = logging.getLogger(__name__)


def create_bot() -> Bot:
    return Bot(
        token=settings.BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )


def create_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(start.router)
    return dp


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
