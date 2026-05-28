import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.websocket_manager import manager
from app.db import crud
from app.db.models import SenderType
from app.db.session import async_session_maker

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{chat_id}/{user_id}")
async def chat_websocket(websocket: WebSocket, chat_id: int, user_id: int):
    await manager.connect_chat(websocket, chat_id)
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            event_type = data.get("type")

            async with async_session_maker() as session:
                if event_type == "typing":
                    await manager.broadcast_to_chat(
                        chat_id,
                        {"type": "typing", "user_id": user_id},
                    )

                elif event_type == "ping":
                    await manager.send_to_chat(websocket, {"type": "pong"})

    except WebSocketDisconnect:
        manager.disconnect_chat(websocket, chat_id)
    except Exception:
        manager.disconnect_chat(websocket, chat_id)


@router.websocket("/ws/admin/{admin_id}")
async def admin_websocket(websocket: WebSocket, admin_id: int):
    await manager.connect_admin(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            event_type = data.get("type")

            if event_type == "admin_message":
                chat_id = data.get("chat_id")
                content = data.get("content")
                sender_name = data.get("sender_name", "Юрист")

                async with async_session_maker() as session:
                    msg = await crud.create_message(
                        session,
                        chat_id=chat_id,
                        sender_type=SenderType.lawyer,
                        content=content,
                        sender_name=sender_name,
                        sender_id=admin_id,
                    )

                payload = {
                    "type": "message",
                    "id": msg.id,
                    "chat_id": chat_id,
                    "sender_type": "lawyer",
                    "sender_name": sender_name,
                    "content": content,
                    "message_type": "text",
                    "created_at": msg.created_at.isoformat(),
                }
                await manager.broadcast_to_chat(chat_id, payload)
                await manager.broadcast_to_admins({**payload, "from_admin": True})

            elif event_type == "ping":
                await manager.send_to_chat(websocket, {"type": "pong"})

    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)
    except Exception:
        manager.disconnect_admin(websocket)
