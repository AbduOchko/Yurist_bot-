import logging

from fastapi import APIRouter, Depends
from openai import AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.websocket_manager import manager
from app.config import settings
from app.db import crud
from app.db.models import SenderType
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
- При необходимости ссылайтесь на конкретные статьи законов РФ"""


def get_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=settings.LLMOST_API_KEY,
        base_url=settings.LLMOST_BASE_URL,
    )


def build_messages(history: list) -> list:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history[-20:]:
        if m.sender_type == SenderType.user:
            msgs.append({"role": "user", "content": m.content or ""})
        elif m.sender_type == SenderType.ai:
            msgs.append({"role": "assistant", "content": m.content or ""})
    return msgs


class AIChatIn(BaseModel):
    chat_id: int
    user_message: str
    user_id: int


async def _send_error(chat_id: int, text: str):
    """Send an error message to the chat via WebSocket so the client clears the typing indicator."""
    await manager.broadcast_to_chat(chat_id, {"type": "ai_error", "content": text})


@router.post("/chat")
async def ai_chat(data: AIChatIn, session: AsyncSession = Depends(get_session)):
    # Save and broadcast user message
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

    # Check API key
    if not settings.LLMOST_API_KEY or settings.LLMOST_API_KEY == "your_llmost_api_key_here":
        logger.error("LLMOST_API_KEY is not configured")
        await _send_error(data.chat_id, "API ключ не настроен. Обратитесь к администратору.")
        return {"ok": False, "error": "api_key_missing"}

    # Build history
    history = await crud.get_messages(session, data.chat_id, limit=30)
    messages = build_messages(history)
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": data.user_message})

    client = get_client()
    full_response = ""

    try:
        stream = await client.chat.completions.create(
            model=settings.LLMOST_MODEL,
            messages=messages,
            max_tokens=2048,
            stream=True,
            timeout=60,
        )

        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                full_response += delta
                await manager.broadcast_to_chat(
                    data.chat_id,
                    {"type": "ai_chunk", "content": delta},
                )

    except Exception as e:
        logger.error(f"AI streaming error: {type(e).__name__}: {e}")
        error_text = "ИИ-советник временно недоступен. Попробуйте позже или обратитесь к живому юристу."
        await _send_error(data.chat_id, error_text)
        return {"ok": False, "error": str(e)}

    if not full_response:
        await _send_error(data.chat_id, "ИИ не вернул ответ. Попробуйте переформулировать вопрос.")
        return {"ok": False, "error": "empty_response"}

    # Save and broadcast AI response
    ai_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.ai,
        content=full_response,
        sender_name="ИИ-Советник",
    )

    await manager.broadcast_to_chat(
        data.chat_id,
        {
            "type": "ai_done",
            "id": ai_msg.id,
            "chat_id": data.chat_id,
            "sender_type": "ai",
            "sender_name": "ИИ-Советник",
            "content": full_response,
            "message_type": "text",
            "created_at": ai_msg.created_at.isoformat(),
        },
    )

    return {"ok": True, "message_id": ai_msg.id}
