import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.db.models import Base

logger = logging.getLogger(__name__)

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
    """Create new tables and apply idempotent ALTERs. Runs at app startup."""
    async with engine.begin() as conn:
        # Create all tables defined in models.py (no-op if exist).
        await conn.run_sync(Base.metadata.create_all)

        # ── User auth columns (legacy migration, kept for safety) ─────
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS app_login VARCHAR(50) UNIQUE;"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS app_password_hash VARCHAR(255);"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(64);"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_session_token ON users (session_token);"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_app_login ON users (app_login);"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);"
        ))
        await conn.execute(text(
            "ALTER TABLE messages ALTER COLUMN file_url TYPE TEXT;"
        ))

        # ── Chat → Staff FK for lawyer assignment ─────────────────────
        await conn.execute(text(
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS lawyer_staff_id INTEGER "
            "REFERENCES staff(id) ON DELETE SET NULL;"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chats_lawyer_staff_id ON chats (lawyer_staff_id);"
        ))

        # ── Orphaned-broadcast cleanup: anything still 'sending' after
        # a server restart is stuck; flip to 'failed' so it doesn't lie.
        await conn.execute(text(
            "UPDATE broadcasts SET status = 'failed', finished_at = NOW() "
            "WHERE status = 'sending';"
        ))


async def bootstrap_owner():
    """Create the first owner from env vars if none exists.

    Idempotent: once an owner is in the staff table, this is a no-op even
    if the env vars stay set.
    """
    from app.api.security import hash_password
    from app.db.models import Staff, StaffRole
    from sqlalchemy import select

    login = (settings.OWNER_BOOTSTRAP_LOGIN or "").strip()
    password = settings.OWNER_BOOTSTRAP_PASSWORD or ""

    if not login or not password:
        logger.info("Owner bootstrap skipped (OWNER_BOOTSTRAP_LOGIN/PASSWORD not set).")
        return

    async with async_session_maker() as session:
        existing = await session.execute(
            select(Staff).where(Staff.role == StaffRole.owner)
        )
        if existing.scalar_one_or_none():
            logger.info("Owner bootstrap skipped (an owner already exists).")
            return

        if len(password) < 12:
            logger.warning(
                "OWNER_BOOTSTRAP_PASSWORD is shorter than 12 chars — change it after first login."
            )

        owner = Staff(
            role=StaffRole.owner,
            login=login,
            password_hash=hash_password(password),
            full_name="Владелец",
            telegram_id=settings.OWNER_BOOTSTRAP_TELEGRAM_ID or None,
            is_active=True,
        )
        session.add(owner)
        await session.commit()
        logger.info(
            f"Bootstrap owner created: login={login!r} "
            f"telegram_id={settings.OWNER_BOOTSTRAP_TELEGRAM_ID or 'не задан — установите в панели'}"
        )


async def get_session() -> AsyncSession:
    async with async_session_maker() as session:
        yield session
