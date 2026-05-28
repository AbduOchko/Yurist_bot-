import asyncio
import logging
import os

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


async def main():
    if settings.WEBHOOK_URL:
        # Production mode: webhook
        await setup_webhook(bot)
        config = uvicorn.Config(
            app,
            host=settings.HOST,
            port=settings.PORT,
            log_level="info",
        )
        server = uvicorn.Server(config)
        await server.serve()
    else:
        # Development mode: polling + uvicorn
        async def run_uvicorn():
            config = uvicorn.Config(
                app,
                host=settings.HOST,
                port=settings.PORT,
                log_level="info",
            )
            server = uvicorn.Server(config)
            await server.serve()

        await asyncio.gather(
            run_uvicorn(),
            start_polling(bot, dp),
        )


if __name__ == "__main__":
    asyncio.run(main())
