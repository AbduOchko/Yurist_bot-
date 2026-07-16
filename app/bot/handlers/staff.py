"""Staff-side bot commands: /lawyer, /manager, /owner.

Каждая команда просто открывает соответствующую панель. Доступ защищён ЛОГИНОМ
и ПАРОЛЕМ внутри самой панели (см. /api/staff/login), а НЕ telegram_id. Кнопку
видит любой, кто знает команду; без верных логина/пароля внутрь не пустят. Из
какого Telegram-аккаунта человек открывает — неважно. telegram_id для доступа
не используется вообще (он нужен только для рассылок по пользователям).
"""
import logging

from aiogram import Router
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from app.config import settings

logger = logging.getLogger(__name__)
router = Router()


def _panel_button(role: str, title: str) -> InlineKeyboardMarkup:
    url = settings.WEBAPP_URL.rstrip("/") + f"/{role}/"
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text=title, web_app=WebAppInfo(url=url))
        ]]
    )


@router.message(Command("owner"))
async def cmd_owner(message: Message):
    await message.answer(
        "👑 <b>Панель владельца</b>\n\nОткройте панель и войдите по логину и паролю:",
        reply_markup=_panel_button("owner", "👑 Открыть панель владельца"),
    )


@router.message(Command("manager"))
async def cmd_manager(message: Message):
    await message.answer(
        "🧭 <b>Панель менеджера</b>\n\nОткройте панель и войдите по логину и паролю:",
        reply_markup=_panel_button("manager", "🧭 Открыть панель менеджера"),
    )


@router.message(Command("lawyer"))
async def cmd_lawyer(message: Message):
    await message.answer(
        "⚖️ <b>Панель юриста</b>\n\nОткройте панель и войдите по логину и паролю:",
        reply_markup=_panel_button("lawyer", "⚖️ Открыть панель юриста"),
    )
