from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import admin, ai, chats, files, messages, users, ws
from app.db.session import create_tables

app = FastAPI(title="Юрист Бот API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    await create_tables()
    Path("uploads").mkdir(exist_ok=True)


@app.get("/health")
async def health():
    return {"status": "ok"}


# Include routers
app.include_router(users.router)
app.include_router(chats.router)
app.include_router(messages.router)
app.include_router(files.router)
app.include_router(ai.router)
app.include_router(admin.router)
app.include_router(ws.router)

# Serve uploads
uploads_path = Path("uploads")
uploads_path.mkdir(exist_ok=True)

# Serve frontend static files
frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/admin", StaticFiles(directory=str(frontend_path / "admin"), html=True), name="admin")
    app.mount("/", StaticFiles(directory=str(frontend_path / "webapp"), html=True), name="webapp")
