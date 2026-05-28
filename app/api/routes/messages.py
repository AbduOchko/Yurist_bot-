from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import ChatType, MessageType, SenderType
from app.db.session import get_session

router = APIRouter(prefix="/api/messages", tags=["messages"])


def serialize_message(m) -> dict:
    reply = None
    if m.reply_to:
        reply = {
            "id": m.reply_to.id,
            "content": m.reply_to.content,
            "sender_type": m.reply_to.sender_type,
            "message_type": m.reply_to.message_type,
        }
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "sender_type": m.sender_type,
        "sender_name": m.sender_name,
        "content": m.content,
        "message_type": m.message_type,
        "file_url": m.file_url,
        "file_name": m.file_name,
        "file_size": m.file_size,
        "is_pinned": m.is_pinned,
        "reply_to": reply,
        "forwarded_from_chat_type": m.forwarded_from_chat_type,
        "created_at": m.created_at.isoformat(),
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


@router.get("/{chat_id}")
async def get_messages(
    chat_id: int,
    limit: int = 50,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
):
    messages = await crud.get_messages(session, chat_id, limit=limit, offset=offset)
    return [serialize_message(m) for m in messages]


class MessageIn(BaseModel):
    chat_id: int
    sender_type: SenderType = SenderType.user
    sender_id: Optional[int] = None
    sender_name: Optional[str] = None
    content: Optional[str] = None
    message_type: MessageType = MessageType.text
    file_url: Optional[str] = None
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    reply_to_id: Optional[int] = None
    forwarded_from_chat_type: Optional[ChatType] = None


@router.post("/")
async def send_message(data: MessageIn, session: AsyncSession = Depends(get_session)):
    msg = await crud.create_message(
        session,
        chat_id=data.chat_id,
        sender_type=data.sender_type,
        content=data.content,
        message_type=data.message_type,
        file_url=data.file_url,
        file_name=data.file_name,
        file_size=data.file_size,
        reply_to_id=data.reply_to_id,
        sender_id=data.sender_id,
        sender_name=data.sender_name,
        forwarded_from_chat_type=data.forwarded_from_chat_type,
    )
    # Load reply_to if exists
    if msg.reply_to_id:
        result = await session.get(type(msg).__class__, msg.reply_to_id)

    payload = serialize_message(msg)
    await manager.broadcast_to_chat(data.chat_id, {"type": "message", **payload})

    # Notify admins for lawyer/match chats
    chat = await crud.get_chat_by_id(session, data.chat_id)
    if chat and chat.chat_type in (ChatType.lawyer, ChatType.match):
        await manager.broadcast_to_admins({
            "type": "new_message",
            "chat_id": data.chat_id,
            "chat_type": chat.chat_type,
            "user_id": chat.user_id,
            **payload,
        })

    return payload


class EditIn(BaseModel):
    content: str


@router.patch("/{message_id}")
async def edit_message(
    message_id: int,
    data: EditIn,
    session: AsyncSession = Depends(get_session),
):
    msg = await crud.edit_message(session, message_id, data.content)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    payload = serialize_message(msg)
    await manager.broadcast_to_chat(msg.chat_id, {"type": "edit", **payload})
    return payload


@router.delete("/{message_id}")
async def delete_message(message_id: int, session: AsyncSession = Depends(get_session)):
    # Get message first to find chat_id
    from sqlalchemy import select
    from app.db.models import Message
    result = await session.execute(select(Message).where(Message.id == message_id))
    msg = result.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    chat_id = msg.chat_id
    ok = await crud.delete_message(session, message_id)
    if ok:
        await manager.broadcast_to_chat(chat_id, {"type": "delete", "message_id": message_id})
    return {"ok": ok}


@router.post("/{message_id}/pin")
async def pin_message(message_id: int, session: AsyncSession = Depends(get_session)):
    msg = await crud.toggle_pin_message(session, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    payload = serialize_message(msg)
    await manager.broadcast_to_chat(msg.chat_id, {"type": "pin", **payload})
    return payload
