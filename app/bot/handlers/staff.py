"""Staff-side bot commands: /lawyer, /manager, /owner.

Each command checks the caller's telegram_id against the staff table and
opens the matching WebApp panel. If the caller has no matching role, the
command politely refuses (no leak of "do you have admin? no.").
"""
import logging

from aiogram import Router
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo
from sqlalchemy import select

from app.config import settings
from app.db.models import Staff, StaffRole
from app.db.session import async_session_maker

logger = logging.getLogger(__name__)
router = Router()


async def _find_staff(telegram_id: int, role: StaffRole) -> Staff | None:
    async with async_session_maker() as session:
        result = await session.execute(
            select(Staff).where(
                Staff.telegram_id == telegram_id,
                Staff.role == role,
                Staff.is_active == True,  # noqa: E712
            )
        )
        return result.scalar_one_or_none()


def _panel_button(role: str, title: str) -> InlineKeyboardMarkup:
    url = settings.WEBAPP_URL.rstrip("/") + f"/{role}/"
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text=title, web_app=WebAppInfo(url=url))
        ]]
    )


@router.message(Command("owner"))
async def cmd_owner(message: Message):
    s = await _find_staff(message.from_user.id, StaffRole.owner)
    if not s:
        await message.answer("⛔ У вас нет доступа.")
        return
    await message.answer(
        f"👑 <b>Панель владельца</b>\n\nДобро пожаловать, {s.full_name}!",
        reply_markup=_panel_button("owner", "👑 Открыть панель владельца"),
    )


@router.message(Command("manager"))
async def cmd_manager(message: Message):
    s = await _find_staff(message.from_user.id, StaffRole.manager)
    if not s:
        # Owners can also open manager UI
        s = await _find_staff(message.from_user.id, StaffRole.owner)
        if not s:
            await message.answer("⛔ У вас нет доступа.")
            return
    await message.answer(
        f"🧭 <b>Панель менеджера</b>\n\n{s.full_name}, открывайте панель:",
        reply_markup=_panel_button("manager", "🧭 Открыть панель менеджера"),
    )


@router.message(Command("lawyer"))
async def cmd_lawyer(message: Message):
    s = await _find_staff(message.from_user.id, StaffRole.lawyer)
    if not s:
        s = await _find_staff(message.from_user.id, StaffRole.owner)
        if not s:
            await message.answer("⛔ У вас нет доступа.")
            return
    await message.answer(
        f"⚖️ <b>Панель юриста</b>\n\n{s.full_name}, открывайте панель:",
        reply_markup=_panel_button("lawyer", "⚖️ Открыть панель юриста"),
    )
