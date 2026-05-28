from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import crud
from app.db.models import ChatType
from app.db.session import get_session

router = APIRouter(prefix="/api/admin", tags=["admin"])


def verify_admin(x_admin_password: str = Header(...)):
    if x_admin_password != settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/stats")
async def get_stats(
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_admin),
):
    users = await crud.get_all_users(session)
    ai_chats = await crud.get_all_chats(session, ChatType.ai)
    lawyer_chats = await crud.get_all_chats(session, ChatType.lawyer)
    match_chats = await crud.get_all_chats(session, ChatType.match)

    total_messages = sum(
        len([m for m in c.messages if not m.is_deleted])
        for c in (ai_chats + lawyer_chats + match_chats)
    )

    return {
        "total_users": len(users),
        "ai_chats": len(ai_chats),
        "lawyer_chats": len(lawyer_chats),
        "match_chats": len(match_chats),
        "total_messages": total_messages,
    }


@router.get("/users")
async def admin_users(
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_admin),
):
    users = await crud.get_all_users(session)
    return [
        {
            "id": u.id,
            "telegram_id": u.telegram_id,
            "username": u.username,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "created_at": u.created_at.isoformat(),
        }
        for u in users
    ]


@router.get("/chats")
async def admin_chats(
    chat_type: str | None = None,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_admin),
):
    ct = ChatType(chat_type) if chat_type else None
    chats = await crud.get_all_chats(session, ct)
    result = []
    for c in chats:
        last_msg = None
        non_deleted = [m for m in c.messages if not m.is_deleted]
        if non_deleted:
            lm = non_deleted[-1]
            last_msg = {
                "content": lm.content,
                "sender_type": lm.sender_type,
                "created_at": lm.created_at.isoformat(),
            }
        result.append(
            {
                "id": c.id,
                "chat_type": c.chat_type,
                "user_id": c.user_id,
                "user": {
                    "telegram_id": c.user.telegram_id,
                    "first_name": c.user.first_name,
                    "last_name": c.user.last_name,
                    "username": c.user.username,
                },
                "message_count": len(non_deleted),
                "last_message": last_msg,
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            }
        )
    return result


@router.get("/chats/{chat_id}/messages")
async def admin_chat_messages(
    chat_id: int,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_admin),
):
    messages = await crud.get_messages(session, chat_id, limit=200)
    return [
        {
            "id": m.id,
            "sender_type": m.sender_type,
            "sender_name": m.sender_name,
            "content": m.content,
            "message_type": m.message_type,
            "file_url": m.file_url,
            "file_name": m.file_name,
            "is_pinned": m.is_pinned,
            "created_at": m.created_at.isoformat(),
        }
        for m in messages
    ]


class VerifyRequest(BaseModel):
    password: str


@router.post("/verify")
async def verify_password(data: VerifyRequest):
    if data.password != settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Wrong password")
    return {"ok": True}
