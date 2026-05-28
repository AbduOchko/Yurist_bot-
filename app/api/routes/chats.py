from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.crud import get_or_create_chat, get_chat_by_id, get_pinned_messages
from app.db.models import ChatType
from app.db.session import get_session

router = APIRouter(prefix="/api/chats", tags=["chats"])


class ChatIn(BaseModel):
    user_id: int
    chat_type: ChatType


class ChatOut(BaseModel):
    id: int
    user_id: int
    chat_type: ChatType

    class Config:
        from_attributes = True


@router.post("/", response_model=ChatOut)
async def get_or_create(data: ChatIn, session: AsyncSession = Depends(get_session)):
    chat = await get_or_create_chat(session, user_id=data.user_id, chat_type=data.chat_type)
    return chat


@router.get("/{chat_id}", response_model=ChatOut)
async def get_chat(chat_id: int, session: AsyncSession = Depends(get_session)):
    chat = await get_chat_by_id(session, chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


@router.get("/{chat_id}/pinned")
async def get_pinned(chat_id: int, session: AsyncSession = Depends(get_session)):
    messages = await get_pinned_messages(session, chat_id)
    return [
        {
            "id": m.id,
            "content": m.content,
            "sender_type": m.sender_type,
            "message_type": m.message_type,
            "created_at": m.created_at.isoformat(),
        }
        for m in messages
    ]
