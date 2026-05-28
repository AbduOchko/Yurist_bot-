import json
from typing import AsyncGenerator

import openai
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.websocket_manager import manager
from app.config import settings
from app.db import crud
from app.db.models import SenderType
from app.db.session import get_session

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


def build_messages(history: list) -> list:
    msgs = []
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


@router.post("/chat")
async def ai_chat(data: AIChatIn, session: AsyncSession = Depends(get_session)):
    # Save user message
    user_msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=SenderType.user,
        content=data.user_message,
        sender_id=data.user_id,
    )

    # Broadcast user message to chat
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

    # Get chat history
    history = await crud.get_messages(session, data.chat_id, limit=30)
    messages = build_messages(history)

    # Ensure last message is user's (it should already be)
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": data.user_message})

    client = openai.OpenAI(api_key=settings.AI_PROVIDER_API_KEY)

    full_response = ""

    # Stream AI response via WebSocket
    with client.messages.stream(
        model="gpt-4o-mini",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=messages,
    ) as stream:
        for text_chunk in stream.text_stream:
            full_response += text_chunk
            await manager.broadcast_to_chat(
                data.chat_id,
                {"type": "ai_chunk", "content": text_chunk},
            )

    # Save complete AI response
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
