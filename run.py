import asyncio
import logging

import uvicorn
from aiogram.types import Update
from fastapi import Request
from fastapi.responses import JSONResponse

from app.api.server import app
from app.bot.bot import create_bot, create_dispatcher, setup_webhook, start_polling
from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

bot = create_bot()
dp = create_dispatcher()


@app.post("/webhook")
async def telegram_webhook(request: Request):
    data = await request.json()
    update = Update.model_validate(data)
    await dp.feed_update(bot, update)
    return JSONResponse({"ok": True})


@app.on_event("startup")
async def on_startup():
    # Set up Telegram webhook in background — does NOT block the server start
    if settings.WEBHOOK_URL:
        asyncio.create_task(_setup_webhook_safe())


async def _setup_webhook_safe():
    try:
        await setup_webhook(bot)
    except Exception as e:
        logger.warning(f"Webhook setup failed (bot will still work via polling): {e}")


async def main():
    config = uvicorn.Config(
        app,
        host=settings.HOST,
        port=settings.PORT,
        log_level="info",
    )
    server = uvicorn.Server(config)

    if settings.WEBHOOK_URL:
        # Production: just run uvicorn; webhook is set up in startup event
        await server.serve()
    else:
        # Development: run uvicorn + polling together
        await asyncio.gather(
            server.serve(),
            start_polling(bot, dp),
        )


if __name__ == "__main__":
    asyncio.run(main())
