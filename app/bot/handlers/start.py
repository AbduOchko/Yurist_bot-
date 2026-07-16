import logging

from aiogram import Bot, Router
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo
from sqlalchemy import update

from app.config import settings
from app.db.crud import get_or_create_user
from app.db.models import User
from app.db.session import async_session_maker

logger = logging.getLogger(__name__)
router = Router()


async def _save_user_photo(bot: Bot, telegram_id: int):
    """Fetch user's Telegram profile photo and store the URL in DB."""
    try:
        photos = await bot.get_user_profile_photos(telegram_id, limit=1)
        if not photos.total_count:
            return
        file_id = photos.photos[0][0].file_id
        file = await bot.get_file(file_id)
        photo_url = f"https://api.telegram.org/file/bot{settings.BOT_TOKEN}/{file.file_path}"

        # Обновляем аватар во ВСЕХ учётках этого telegram_id (их может быть
        # несколько), а не в одной — иначе scalar_one_or_none упал бы, а часть
        # аккаунтов осталась бы без фото.
        async with async_session_maker() as session:
            await session.execute(
                update(User).where(User.telegram_id == telegram_id).values(photo_url=photo_url)
            )
            await session.commit()
    except Exception as e:
        logger.warning(f"Could not fetch profile photo for {telegram_id}: {e}")


@router.message(Command("start"))
async def cmd_start(message: Message, bot: Bot):
    async with async_session_maker() as session:
        await get_or_create_user(
            session,
            telegram_id=message.from_user.id,
            username=message.from_user.username,
            first_name=message.from_user.first_name,
            last_name=message.from_user.last_name,
        )

    await _save_user_photo(bot, message.from_user.id)

    webapp_url = settings.WEBAPP_URL.rstrip("/")
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(
                text="⚖️ Открыть Юрист Бот",
                web_app=WebAppInfo(url=webapp_url),
            )
        ]]
    )

    name = message.from_user.first_name or "Пользователь"
    await message.answer(
        f"👋 Добро пожаловать, {name}!\n\n"
        "⚖️ <b>Юрист Бот</b> — ваш персональный правовой помощник.\n\n"
        "Нажмите кнопку ниже, чтобы открыть приложение:",
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
    )
