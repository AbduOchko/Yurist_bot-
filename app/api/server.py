import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import (
    ai,
    auth,
    chats,
    files,
    lawyer,
    manager,
    messages,
    owner,
    staff_auth,
    users,
    ws,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up...")
    try:
        from app.db.session import bootstrap_owner, create_tables
        await create_tables()
        logger.info("Database tables created/verified")
        await bootstrap_owner()
    except Exception as e:
        logger.error(f"DB startup error (non-fatal): {e}")

    Path("uploads").mkdir(exist_ok=True)
    logger.info("Startup complete")
    yield
    logger.info("Shutting down...")


app = FastAPI(title="Юрист Бот API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic validation error messages in Russian
_VALIDATION_MESSAGES = {
    "missing": "Обязательное поле не заполнено",
    "string_pattern_mismatch": "Недопустимые символы в логине",
    "string_too_short": "Слишком короткое значение",
    "string_too_long": "Слишком длинное значение",
    "value_error": "Неверное значение",
    "int_parsing": "Ожидается число",
    "greater_than": "Значение слишком маленькое",
    "less_than": "Значение слишком большое",
}


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    first = errors[0] if errors else {}
    err_type = first.get("type", "")
    msg = _VALIDATION_MESSAGES.get(err_type, "Проверьте правильность введённых данных")
    return JSONResponse(status_code=422, content={"detail": msg})


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
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(chats.router)
app.include_router(messages.router)
app.include_router(files.router)
app.include_router(ai.router)
app.include_router(staff_auth.router)
app.include_router(owner.router)
app.include_router(manager.router)
app.include_router(lawyer.router)
app.include_router(ws.router)

# NOTE: Static files at "/" are mounted in run.py AFTER /webhook is registered,
# so that POST /webhook is not intercepted by StaticFiles.
