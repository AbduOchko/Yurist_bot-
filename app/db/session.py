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
        await conn.execute(text(
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS caption TEXT;"
        ))

        # ── Фантомное «изм.»: раньше messages.updated_at проставлялся прямо при
        # вставке (default=utcnow) и расходился с created_at на микросекунды, из-за
        # чего фронт помечал редактированием каждое сообщение. Теперь колонка
        # NULL до реальной правки (см. models.Message), а старые строки чистим:
        # правка человеком не укладывается в 2 секунды после отправки, поэтому
        # всё, что ближе, — заведомо ложная отметка. Идемпотентно.
        await conn.execute(text(
            "UPDATE messages SET updated_at = NULL "
            "WHERE updated_at IS NOT NULL AND created_at IS NOT NULL "
            "AND updated_at - created_at < INTERVAL '2 seconds';"
        ))

        # ── Chat → Staff FK for lawyer assignment ─────────────────────
        await conn.execute(text(
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS lawyer_staff_id INTEGER "
            "REFERENCES staff(id) ON DELETE SET NULL;"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chats_lawyer_staff_id ON chats (lawyer_staff_id);"
        ))

        # ── Per-user "clear my history" cutoff ────────────────────────
        await conn.execute(text(
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS user_cleared_at TIMESTAMP;"
        ))

        # ── Group chats: manager who created the group ────────────────
        await conn.execute(text(
            "ALTER TABLE chats ADD COLUMN IF NOT EXISTS manager_staff_id INTEGER "
            "REFERENCES staff(id) ON DELETE SET NULL;"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chats_manager_staff_id ON chats (manager_staff_id);"
        ))

        # ── Staff telegram_id: no uniqueness at all. One telegram_id may map to
        # any number of staff rows (multiple roles, or even several rows with the
        # same role). Drop the legacy single-column UNIQUE and the later
        # (telegram_id, role) partial unique; keep only a plain lookup index.
        await conn.execute(text("DROP INDEX IF EXISTS ix_staff_telegram_id;"))
        await conn.execute(text("DROP INDEX IF EXISTS ux_staff_tg_role;"))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_staff_telegram_id ON staff (telegram_id);"
        ))

        # ── Orphaned-broadcast cleanup: anything still 'sending' after
        # a server restart is stuck; flip to 'failed' so it doesn't lie.
        await conn.execute(text(
            "UPDATE broadcasts SET status = 'failed', finished_at = NOW() "
            "WHERE status = 'sending';"
        ))

    # ── New ChatType value 'support' (direct chat with the owner). ──────
    # ALTER TYPE ADD VALUE can't run inside a transaction on older Postgres,
    # so use an autocommit connection. The enum type name is resolved by a
    # value unique to ChatType ('match') so we don't hardcode it.
    # Enum type names are resolved by a label unique to each enum
    # ('match' → ChatType, 'user' → SenderType) so we don't hardcode names.
    try:
        ac_engine = engine.execution_options(isolation_level="AUTOCOMMIT")
        async with ac_engine.connect() as conn:
            async def _add_enum_value(discriminator: str, new_value: str):
                typ = (await conn.execute(text(
                    "SELECT t.typname FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid "
                    "WHERE e.enumlabel = :lbl LIMIT 1;"
                ), {"lbl": discriminator})).scalar()
                if typ:
                    await conn.execute(text(
                        f'ALTER TYPE "{typ}" ADD VALUE IF NOT EXISTS \'{new_value}\';'
                    ))
            await _add_enum_value("match", "support")   # ChatType.support
            await _add_enum_value("match", "group")     # ChatType.group
            await _add_enum_value("user", "manager")    # SenderType.manager
    except Exception as e:
        logger.warning(f"Could not add new enum values (non-fatal): {e}")


async def bootstrap_owner():
    """Create owner row(s) from env.

    OWNER_BOOTSTRAP_TELEGRAM_ID is a comma-separated list of telegram_ids;
    one owner row is created per id (if none with that id already exists).
    The first id in the list gets the clean OWNER_BOOTSTRAP_LOGIN; subsequent
    ones get '<login>_<telegram_id>'. All share OWNER_BOOTSTRAP_PASSWORD
    initially — each owner should change their own via the panel.

    Adding new ids to the env var later and restarting will add new owners
    without touching existing ones. Idempotent on second restart.
    """
    from app.api.security import hash_password
    from app.db.models import Staff, StaffRole
    from sqlalchemy import select

    login_base = (settings.OWNER_BOOTSTRAP_LOGIN or "").strip()
    password = settings.OWNER_BOOTSTRAP_PASSWORD or ""

    if not login_base or not password:
        logger.info("Owner bootstrap skipped (OWNER_BOOTSTRAP_LOGIN/PASSWORD not set).")
        return

    if len(password) < 12:
        logger.warning(
            "OWNER_BOOTSTRAP_PASSWORD is shorter than 12 chars — change it after first login."
        )

    ids = settings.owner_bootstrap_telegram_ids
    pwd_hash = hash_password(password)

    async with async_session_maker() as session:
        # ── Branch 1: no telegram_ids configured → fall back to single owner
        # without a telegram_id (web-only access). Backward-compatible with the
        # previous single-owner bootstrap.
        if not ids:
            existing = await session.execute(
                select(Staff).where(Staff.role == StaffRole.owner)
            )
            if existing.scalar_one_or_none():
                logger.info("Owner bootstrap skipped (an owner already exists, no IDs configured).")
                return
            owner = Staff(
                role=StaffRole.owner,
                login=login_base,
                password_hash=pwd_hash,
                full_name="Владелец",
                is_active=True,
            )
            session.add(owner)
            await session.commit()
            logger.info(f"Bootstrap owner created (no telegram_id): login={login_base!r}")
            return

        # ── Branch 2: one or more telegram_ids → ensure each has its own owner row.
        created = 0
        for telegram_id in ids:
            ex = await session.execute(
                select(Staff).where(
                    Staff.telegram_id == telegram_id,
                    Staff.role == StaffRole.owner,
                ).limit(1)
            )
            if ex.scalars().first():
                continue  # already exists, skip

            # Pick a login: clean OWNER_BOOTSTRAP_LOGIN if free, otherwise suffix with telegram_id
            candidate = login_base
            ex_login = await session.execute(select(Staff).where(Staff.login == candidate))
            if ex_login.scalar_one_or_none():
                candidate = f"{login_base}_{telegram_id}"
                # If even that's taken (extremely unlikely), suffix with a counter
                n = 2
                while True:
                    ex_login2 = await session.execute(select(Staff).where(Staff.login == candidate))
                    if not ex_login2.scalar_one_or_none():
                        break
                    candidate = f"{login_base}_{telegram_id}_{n}"
                    n += 1

            session.add(Staff(
                role=StaffRole.owner,
                login=candidate,
                password_hash=pwd_hash,
                full_name="Владелец",
                telegram_id=telegram_id,
                is_active=True,
            ))
            await session.commit()
            logger.info(f"Bootstrap owner created: login={candidate!r} telegram_id={telegram_id}")
            created += 1

        if created == 0:
            logger.info(f"Bootstrap: all {len(ids)} configured owner(s) already exist — no-op.")


async def get_session() -> AsyncSession:
    async with async_session_maker() as session:
        yield session
