from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.db.models import Base

engine = create_async_engine(
    settings.async_database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def create_tables():
    async with engine.begin() as conn:
        # Create all tables that don't exist yet
        await conn.run_sync(Base.metadata.create_all)

        # Add new columns to existing tables (safe: IF NOT EXISTS)
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS app_login VARCHAR(50) UNIQUE;"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS app_password_hash VARCHAR(255);"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(64);"
        ))
        # Index on session_token for fast verify lookups
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_session_token ON users (session_token);"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_app_login ON users (app_login);"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);"
        ))
        # Expand file_url to TEXT to support base64 data URLs
        await conn.execute(text(
            "ALTER TABLE messages ALTER COLUMN file_url TYPE TEXT;"
        ))


async def get_session() -> AsyncSession:
    async with async_session_maker() as session:
        yield session
