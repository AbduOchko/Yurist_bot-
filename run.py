import asyncio
import logging
import os
from pathlib import Path

import uvicorn
from aiogram.types import Update
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

from app.api.server import app
from app.config import settings

# ── Bot (lazy init) ───────────────────────────
_bot = None
_dp = None


def get_bot_dp():
    global _bot, _dp
    if _bot is None:
        from app.bot.bot import create_bot, create_dispatcher
        _bot = create_bot()
        _dp = create_dispatcher()
    return _bot, _dp


# ── /webhook route — must be registered BEFORE static "/" mount ───────────────
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


# ── Static files at "/" — registered AFTER /webhook so it doesn't shadow it ──
frontend_path = Path(__file__).parent / "frontend"
if frontend_path.exists():
    app.mount(
        "/admin",
        StaticFiles(directory=str(frontend_path / "admin"), html=True),
        name="admin",
    )
    app.mount(
        "/",
        StaticFiles(directory=str(frontend_path / "webapp"), html=True),
        name="webapp",
    )
    logger.info(f"Frontend mounted from {frontend_path}")
else:
    logger.warning(f"Frontend not found at {frontend_path}")


# ── Webhook setup (runs in background after server start) ─────────────────────
async def setup_webhook_background():
    await asyncio.sleep(3)
    try:
        from app.bot.bot import setup_webhook
        bot, _ = get_bot_dp()
        await setup_webhook(bot)
        logger.info("Webhook set up successfully")
    except Exception as e:
        logger.warning(f"Webhook setup failed: {e}")


# ── Entry point ───────────────────────────────
async def main():
    port = int(os.environ.get("PORT", settings.PORT))
    host = settings.HOST
    logger.info(f"Starting server on {host}:{port}")

    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)

    if settings.WEBHOOK_URL:
        # Production: uvicorn + background webhook setup
        asyncio.get_event_loop().call_later(
            3, lambda: asyncio.create_task(setup_webhook_background())
        )
        await server.serve()
    else:
        # Development: uvicorn + polling together
        from app.bot.bot import start_polling
        bot, dp = get_bot_dp()
        await asyncio.gather(server.serve(), start_polling(bot, dp))


if __name__ == "__main__":
    asyncio.run(main())
