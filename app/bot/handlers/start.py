from aiogram import Router
from aiogram.filters import Command
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

from app.config import settings
from app.db.crud import get_or_create_user
from app.db.session import async_session_maker

router = Router()


@router.message(Command("start"))
async def cmd_start(message: Message):
    async with async_session_maker() as session:
        await get_or_create_user(
            session,
            telegram_id=message.from_user.id,
            username=message.from_user.username,
            first_name=message.from_user.first_name,
            last_name=message.from_user.last_name,
        )

    webapp_url = settings.WEBAPP_URL.rstrip("/")

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="⚖️ Открыть Юрист Бот",
                    web_app=WebAppInfo(url=webapp_url),
                )
            ]
        ]
    )

    name = message.from_user.first_name or "Пользователь"
    await message.answer(
        f"👋 Добро пожаловать, {name}!\n\n"
        "⚖️ <b>Юрист Бот</b> — ваш персональный правовой помощник.\n\n"
        "Нажмите кнопку ниже, чтобы открыть приложение:",
        parse_mode="HTML",
        reply_markup=keyboard,
    )


@router.message(Command("help"))
async def cmd_help(message: Message):
    await message.answer(
        "ℹ️ <b>Справка по боту</b>\n\n"
        "/start — Открыть приложение\n"
        "/help — Справка\n\n"
        "<b>Режимы работы:</b>\n"
        "🤖 <b>ИИ-Советник</b> — мгновенные юридические консультации от ИИ\n"
        "👨‍💼 <b>Личный Юрист</b> — чат с живым юристом\n"
        "🔍 <b>Подбор Юриста</b> — помощь в поиске специалиста",
        parse_mode="HTML",
    )
