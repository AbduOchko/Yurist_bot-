import base64
import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import iso_utc
from app.api.websocket_manager import manager
from app.config import settings
from app.db import crud
from app.db.models import MessageType, SenderType
from app.db.session import get_session
from app.services import gigachat
from app.services.subscription import verify_subscription

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])

SYSTEM_PROMPT = """Вы — опытный юрист-консультант с более чем 15-летним стажем работы в различных областях права.
Вы специализируетесь на гражданском, трудовом, семейном, уголовном и административном праве.

Правила общения:
- Отвечайте исключительно на русском языке
- Давайте конкретные, практичные и профессиональные советы
- Если вопрос выходит за рамки вашей компетенции — честно скажите об этом
- Рекомендуйте обращаться к живому юристу для сложных дел
- Сохраняйте профессиональный, но доступный тон
- Структурируйте ответы с использованием нумерованных списков и абзацев
- При необходимости ссылайтесь на конкретные статьи законов РФ
- Если пользователь прислал изображение документа — внимательно изучите его и дайте юридический анализ"""


def _api_configured() -> bool:
    key = (settings.GIGACHAT_AUTH_KEY or "").strip()
    return bool(key) and key != "your_authorization_key_here"


def _user_turn_text(m) -> str:
    """Текст реплики пользователя так, как её должен увидеть ИИ.

    Ключевой момент: у медиа-сообщений `content` — НЕ текст. У голосовых там
    лежит длительность в секундах (см. ai_media), у старых картинок — подпись.
    Настоящая подпись всегда в `caption`. Раньше длительность уходила в модель
    как реплика пользователя, и ИИ отвечал на «14» вместо вопроса.
    """
    caption = (m.caption or "").strip()

    if m.message_type == MessageType.voice:
        # content == длительность в секундах → в модель не отдаём никогда.
        return caption or "[голосовое сообщение]"
    if m.message_type == MessageType.image:
        # Легаси: до появления `caption` подпись к фото хранилась в `content`.
        return caption or (m.content or "").strip() or "[изображение]"
    if m.message_type in (MessageType.video, MessageType.audio, MessageType.document):
        return caption or f"[{m.message_type.value}]"
    return (m.content or "").strip()


def build_messages(history: list, current: Optional[dict] = None) -> list:
    """Build the GigaChat messages array from chat history.

    History items use simple text; `current` is a richer message (e.g. an image
    attachment) appended as the final user turn — callers exclude it from
    `history` themselves.
    """
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history[-20:]:
        if m.sender_type == SenderType.user:
            msgs.append({"role": "user", "content": _user_turn_text(m)})
        elif m.sender_type == SenderType.ai:
            msgs.append({"role": "assistant", "content": m.content or ""})

    if current:
        msgs.append(current)
    return msgs


async def _send_error(chat_id: int, text: str):
    await manager.broadcast_to_chat(chat_id, {"type": "ai_error", "content": text})


async def _broadcast_done(chat_id: int, ai_msg, content: str):
    payload = {
        "id": ai_msg.id,
        "chat_id": chat_id,
        "sender_type": "ai",
        "sender_name": "ИИ-Советник",
        "content": content,
        "message_type": "text",
        "created_at": iso_utc(ai_msg.created_at),
    }
    await manager.broadcast_to_chat(chat_id, {"type": "ai_done", **payload})
    # Mirror to owners for live oversight ("Чаты с ИИ").
    await manager.broadcast_to_owners({"type": "message", **payload})


async def _ai_say(session, chat_id: int, text: str):
    """Emit a canned assistant reply (single chunk + done) and persist it.

    Goes through the same ai_chunk/ai_done path the streaming flow uses, so the
    frontend removes its typing indicator and renders the bubble normally.
    """
    await manager.broadcast_to_chat(chat_id, {"type": "ai_chunk", "content": text})
    ai_msg = await crud.create_message(
        session,
        chat_id=chat_id,
        sender_type=SenderType.ai,
        content=text,
        sender_name="ИИ-Советник",
    )
    await _broadcast_done(chat_id, ai_msg, text)
    return ai_msg


async def _stream_and_save(
    session,
    chat_id: int,
    messages: list,
    model: Optional[str] = None,
):
    """Stream a GigaChat completion over WebSocket and save the final message."""
    full_response = ""
    try:
        async for delta in gigachat.stream_chat(messages, model=model):
            full_response += delta
            await manager.broadcast_to_chat(chat_id, {"type": "ai_chunk", "content": delta})
    except Exception as e:
        logger.error(f"GigaChat streaming error: {type(e).__name__}: {e}")
        await _send_error(chat_id, "ИИ-советник временно недоступен. Попробуйте позже.")
        return None

    if not full_response:
        await _send_error(chat_id, "ИИ не вернул ответ. Попробуйте переформулировать.")
        return None

    ai_msg = await crud.create_message(
        session,
        chat_id=chat_id,
        sender_type=SenderType.ai,
        content=full_response,
        sender_name="ИИ-Советник",
    )
    await _broadcast_done(chat_id, ai_msg, full_response)
    return ai_msg


# ─────────────────────────────────────────────
# TEXT CHAT
# ─────────────────────────────────────────────
class AIChatIn(BaseModel):
    chat_id: int
    user_message: str
    user_id: int


@router.post("/chat")
async def ai_chat(
    data: AIChatIn,
    session: AsyncSession = Depends(get_session),
    _sub=Depends(verify_subscription),
):
    if not _api_configured():
        await _send_error(data.chat_id, "ИИ (GigaChat) не настроен. Обратитесь к администратору.")
        return {"ok": False, "error": "api_key_missing"}

    user_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=data.user_message,
        sender_id=data.user_id,
    )
    user_payload = {
        "type": "message",
        "id": user_msg.id,
        "chat_id": data.chat_id,
        "sender_type": "user",
        "content": data.user_message,
        "message_type": "text",
        "created_at": iso_utc(user_msg.created_at),
    }
    await manager.broadcast_to_chat(data.chat_id, user_payload)
    await manager.broadcast_to_owners(user_payload)  # live oversight

    chat = await crud.get_chat_by_id(session, data.chat_id)
    after = chat.user_cleared_at if chat else None
    history = await crud.get_messages(session, data.chat_id, limit=30, after=after)
    messages = build_messages(history)
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": data.user_message})

    ai_msg = await _stream_and_save(session, data.chat_id, messages)
    return {"ok": bool(ai_msg)}


# ─────────────────────────────────────────────
# MEDIA CHAT (image / voice)
# ─────────────────────────────────────────────
class AIMediaIn(BaseModel):
    chat_id: int
    user_id: int
    message_type: str          # "image" | "voice"
    file_url: str              # base64 data URL для хранения/проигрывания
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    caption: Optional[str] = None
    duration: Optional[int] = None       # voice duration in seconds
    ai_audio_url: Optional[str] = None   # принимается от старого фронта, GigaChat не использует


def _decode_data_url(data_url: str) -> tuple[Optional[bytes], str]:
    """data:<mime>;base64,<payload> → (bytes, mime). Returns (None, "") on failure."""
    if not data_url or "," not in data_url:
        return None, ""
    meta, b64 = data_url.split(",", 1)
    mime = "image/jpeg"
    if meta.startswith("data:") and ";" in meta:
        mime = meta[5:meta.index(";")] or "image/jpeg"
    try:
        return base64.b64decode(b64), mime
    except Exception:
        return None, ""


@router.post("/media")
async def ai_media(
    data: AIMediaIn,
    session: AsyncSession = Depends(get_session),
    _sub=Depends(verify_subscription),
):
    if not _api_configured():
        await _send_error(data.chat_id, "ИИ (GigaChat) не настроен. Обратитесь к администратору.")
        return {"ok": False, "error": "api_key_missing"}

    mtype = MessageType.image if data.message_type == "image" else MessageType.voice

    # Voice keeps the duration in `content` (player convention); the typed caption
    # (if any) goes into the dedicated `caption` field for every media type.
    stored_content = str(data.duration) if mtype == MessageType.voice and data.duration else None
    caption = (data.caption or "").strip() or None

    # ── 1. Save & broadcast the user's media message ──
    user_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=stored_content,
        caption=caption,
        message_type=mtype,
        file_url=data.file_url,
        file_name=data.file_name,
        file_size=data.file_size,
        sender_id=data.user_id,
    )
    media_payload = {
        "type": "message",
        "id": user_msg.id,
        "chat_id": data.chat_id,
        "sender_type": "user",
        "content": stored_content,
        "caption": caption,
        "message_type": data.message_type,
        "file_url": data.file_url,
        "file_name": data.file_name,
        "file_size": data.file_size,
        "created_at": iso_utc(user_msg.created_at),
    }
    await manager.broadcast_to_chat(data.chat_id, media_payload)
    await manager.broadcast_to_owners(media_payload)  # live oversight

    # ── 2a. Voice ──
    if mtype == MessageType.voice:
        # GigaChat can't hear audio. If the user added a text caption, answer it;
        # otherwise ask them to write the question.
        if caption:
            chat = await crud.get_chat_by_id(session, data.chat_id)
            after = chat.user_cleared_at if chat else None
            history = await crud.get_messages(session, data.chat_id, limit=30, after=after)
            history = [m for m in history if m.id != user_msg.id]
            messages = build_messages(history)
            messages.append({"role": "user", "content": caption})
            ai_msg = await _stream_and_save(session, data.chat_id, messages)
            return {"ok": bool(ai_msg)}
        await _ai_say(
            session,
            data.chat_id,
            "🎤 Голосовые сообщения пока не поддерживаются ИИ-советником на базе GigaChat. "
            "Пожалуйста, напишите ваш вопрос текстом — и я подробно отвечу.",
        )
        return {"ok": True, "voice_unsupported": True}

    # ── 2b. Image: upload to GigaChat, reference it via attachments ──
    img_bytes, mime = _decode_data_url(data.file_url)
    if not img_bytes:
        await _send_error(data.chat_id, "Не удалось обработать изображение. Попробуйте другое фото.")
        return {"ok": False, "error": "bad_image"}

    try:
        file_id = await gigachat.upload_file(
            img_bytes,
            filename=data.file_name or "image.jpg",
            mime=mime or "image/jpeg",
        )
    except Exception as e:
        logger.error(f"GigaChat file upload failed: {type(e).__name__}: {e}")
        await _send_error(data.chat_id, "Не удалось загрузить изображение в ИИ. Попробуйте позже.")
        return {"ok": False, "error": "upload_failed"}

    prompt_text = data.caption or (
        "Изучите это изображение как юрист и дайте подробный анализ. "
        "Если это документ — разберите его содержание и правовые нюансы."
    )

    chat = await crud.get_chat_by_id(session, data.chat_id)
    after = chat.user_cleared_at if chat else None
    history = await crud.get_messages(session, data.chat_id, limit=30, after=after)
    history = [m for m in history if m.id != user_msg.id]  # drop the just-saved image msg
    current = {
        "role": "user",
        "content": prompt_text,
        "attachments": [file_id],
    }
    messages = build_messages(history, current=current)

    ai_msg = await _stream_and_save(session, data.chat_id, messages)
    return {"ok": bool(ai_msg)}
