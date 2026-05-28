import asyncio
import logging
import os

import uvicorn
from aiogram.types import Update
from fastapi import Request
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

from app.api.server import app
from app.config import settings

# Bot is created lazily to avoid crash if token is missing
_bot = None
_dp = None


def get_bot_dp():
    global _bot, _dp
    if _bot is None:
        from app.bot.bot import create_bot, create_dispatcher
        _bot = create_bot()
        _dp = create_dispatcher()
    return _bot, _dp


@app.post("/webhook")
async def telegram_webhook(request: Request):
    try:
        bot, dp = get_bot_dp()
        data = await request.json()
        update = Update.model_validate(data)
        await dp.feed_update(bot, update)
    except Exception as e:
        logger.error(f"Webhook error: {e}")
    return JSONResponse({"ok": True})


async def setup_webhook_background():
    await asyncio.sleep(2)  # Wait for server to be ready
    try:
        from app.bot.bot import setup_webhook
        bot, _ = get_bot_dp()
        await setup_webhook(bot)
        logger.info("Webhook set up successfully")
    except Exception as e:
        logger.warning(f"Webhook setup failed: {e}")


async def main():
    port = int(os.environ.get("PORT", settings.PORT))
    host = settings.HOST

    logger.info(f"Starting server on {host}:{port}")

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="info",
    )
    server = uvicorn.Server(config)

    if settings.WEBHOOK_URL:
        # Start webhook setup in background after server starts
        loop = asyncio.get_event_loop()
        loop.call_later(3, lambda: asyncio.create_task(setup_webhook_background()))
        await server.serve()
    else:
        from app.bot.bot import start_polling
        bot, dp = get_bot_dp()
        await asyncio.gather(
            server.serve(),
            start_polling(bot, dp),
        )


if __name__ == "__main__":
    asyncio.run(main())
