import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import admin, ai, chats, files, messages, users, ws

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up...")
    try:
        from app.db.session import create_tables
        await create_tables()
        logger.info("Database tables created/verified")
    except Exception as e:
        logger.error(f"DB startup error (non-fatal): {e}")

    Path("uploads").mkdir(exist_ok=True)
    logger.info("Startup complete")
    yield
    logger.info("Shutting down...")


app = FastAPI(title="Юрист Бот API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/debug")
async def debug():
    frontend_path = Path(__file__).parent.parent.parent / "frontend"
    return {
        "status": "ok",
        "port": os.environ.get("PORT", "not set"),
        "webhook_url": os.environ.get("WEBHOOK_URL", "not set"),
        "database_url_prefix": os.environ.get("DATABASE_URL", "")[:30] + "...",
        "frontend_exists": frontend_path.exists(),
        "cwd": str(Path.cwd()),
    }


# API routers — must be registered BEFORE static files mount
app.include_router(users.router)
app.include_router(chats.router)
app.include_router(messages.router)
app.include_router(files.router)
app.include_router(ai.router)
app.include_router(admin.router)
app.include_router(ws.router)

# NOTE: Static files at "/" are mounted in run.py AFTER /webhook is registered,
# so that POST /webhook is not intercepted by StaticFiles.
