import logging
from typing import Optional

from fastapi import APIRouter, Depends
from openai import AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.websocket_manager import manager
from app.config import settings
from app.db import crud
from app.db.models import MessageType, SenderType
from app.db.session import get_session

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
- Если пользователь прислал изображение документа — внимательно изучите его и дайте юридический анализ
- Если пользователь прислал голосовое сообщение — отвечайте на его суть"""


def get_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=settings.LLMOST_API_KEY,
        base_url=settings.LLMOST_BASE_URL,
    )


def build_messages(history: list, current: Optional[dict] = None) -> list:
    """Build OpenAI messages array from chat history.
    history items use simple text; `current` may be a rich multimodal message."""
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history[-20:]:
        if m.sender_type == SenderType.user:
            # Skip the very last user msg if we'll replace it with `current`
            text = m.content or ""
            if m.message_type == MessageType.voice:
                text = m.content or "[голосовое сообщение]"
            elif m.message_type == MessageType.image:
                text = m.content or "[изображение]"
            msgs.append({"role": "user", "content": text})
        elif m.sender_type == SenderType.ai:
            msgs.append({"role": "assistant", "content": m.content or ""})

    if current:
        # Replace last user message with the rich multimodal version
        if msgs and msgs[-1]["role"] == "user":
            msgs[-1] = current
        else:
            msgs.append(current)
    return msgs


async def _send_error(chat_id: int, text: str):
    await manager.broadcast_to_chat(chat_id, {"type": "ai_error", "content": text})


async def _stream_and_save(
    session,
    chat_id: int,
    messages: list,
    model: Optional[str] = None,
):
    """Stream AI completion via WebSocket and save final message."""
    client = get_client()
    full_response = ""
    try:
        stream = await client.chat.completions.create(
            model=model or settings.LLMOST_MODEL,
            messages=messages,
            max_tokens=2048,
            stream=True,
            timeout=90,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                full_response += delta
                await manager.broadcast_to_chat(chat_id, {"type": "ai_chunk", "content": delta})
    except Exception as e:
        logger.error(f"AI streaming error: {type(e).__name__}: {e}")
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
    await manager.broadcast_to_chat(
        chat_id,
        {
            "type": "ai_done",
            "id": ai_msg.id,
            "chat_id": chat_id,
            "sender_type": "ai",
            "sender_name": "ИИ-Советник",
            "content": full_response,
            "message_type": "text",
            "created_at": ai_msg.created_at.isoformat(),
        },
    )
    return ai_msg


# ─────────────────────────────────────────────
# TEXT CHAT
# ─────────────────────────────────────────────
class AIChatIn(BaseModel):
    chat_id: int
    user_message: str
    user_id: int


@router.post("/chat")
async def ai_chat(data: AIChatIn, session: AsyncSession = Depends(get_session)):
    if not settings.LLMOST_API_KEY or settings.LLMOST_API_KEY == "your_llmost_api_key_here":
        await _send_error(data.chat_id, "API ключ не настроен. Обратитесь к администратору.")
        return {"ok": False, "error": "api_key_missing"}

    user_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=data.user_message,
        sender_id=data.user_id,
    )
    await manager.broadcast_to_chat(
        data.chat_id,
        {
            "type": "message",
            "id": user_msg.id,
            "chat_id": data.chat_id,
            "sender_type": "user",
            "content": data.user_message,
            "message_type": "text",
            "created_at": user_msg.created_at.isoformat(),
        },
    )

    history = await crud.get_messages(session, data.chat_id, limit=30)
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
    ai_audio_url: Optional[str] = None   # WAV-версия для gpt-4o-audio-preview


@router.post("/media")
async def ai_media(data: AIMediaIn, session: AsyncSession = Depends(get_session)):
    if not settings.LLMOST_API_KEY or settings.LLMOST_API_KEY == "your_llmost_api_key_here":
        await _send_error(data.chat_id, "API ключ не настроен. Обратитесь к администратору.")
        return {"ok": False, "error": "api_key_missing"}

    mtype = MessageType.image if data.message_type == "image" else MessageType.voice

    # For voice, content holds duration (player convention); for image, the caption
    stored_content = str(data.duration) if mtype == MessageType.voice and data.duration else data.caption

    # ── 1. Save & broadcast the user's media message ──
    user_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=stored_content,
        message_type=mtype,
        file_url=data.file_url,
        file_name=data.file_name,
        file_size=data.file_size,
        sender_id=data.user_id,
    )
    await manager.broadcast_to_chat(
        data.chat_id,
        {
            "type": "message",
            "id": user_msg.id,
            "chat_id": data.chat_id,
            "sender_type": "user",
            "content": stored_content,
            "message_type": data.message_type,
            "file_url": data.file_url,
            "file_name": data.file_name,
            "file_size": data.file_size,
            "created_at": user_msg.created_at.isoformat(),
        },
    )

    history = await crud.get_messages(session, data.chat_id, limit=30)
    use_audio_model = False

    # ── 2. Build the multimodal "current" message for the AI ──
    if mtype == MessageType.image:
        prompt_text = data.caption or (
            "Изучите это изображение как юрист и дайте подробный анализ. "
            "Если это документ — разберите его содержание и правовые нюансы."
        )
        current = {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt_text},
                {"type": "image_url", "image_url": {"url": data.file_url}},
            ],
        }
        # History's last item is this image msg (content=None) — drop it, use `current`
        history = [m for m in history if m.id != user_msg.id]
    else:  # voice → input_audio для gpt-4o-audio-preview
        if not data.ai_audio_url or "," not in data.ai_audio_url:
            await _send_error(
                data.chat_id,
                "Не удалось обработать голос. Попробуйте отправить текстом."
            )
            return {"ok": False, "error": "no_ai_audio"}

        _, audio_b64 = data.ai_audio_url.split(",", 1)
        logger.info(
            f"ai_media voice: audio_b64_len={len(audio_b64)}, model={settings.LLMOST_AUDIO_MODEL}"
        )
        current = {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Это голосовое сообщение пользователя. Ответьте на его суть как юрист.",
                },
                {
                    "type": "input_audio",
                    "input_audio": {"data": audio_b64, "format": "wav"},
                },
            ],
        }
        # History's last item is this voice msg (content=duration) — drop it
        history = [m for m in history if m.id != user_msg.id]
        use_audio_model = True

    messages = build_messages(history, current=current)
    model_id = settings.LLMOST_AUDIO_MODEL if use_audio_model else None

    ai_msg = await _stream_and_save(session, data.chat_id, messages, model=model_id)
    return {"ok": bool(ai_msg)}
