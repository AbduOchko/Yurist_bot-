"""WebSocket routes.

Two endpoints:
  /ws/chat/{chat_id}/{user_id}  — end-user; trusts URL params (same as before)
  /ws/staff?token=...           — staff (any role); server-side resolves role
                                   from the bearer-style session_token and joins
                                   the correct broadcast pool.
"""
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.api.websocket_manager import manager
from app.db.models import Staff, StaffRole
from app.db.session import async_session_maker

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


# ── End-user chat WS ──────────────────────────────────────────────────
@router.websocket("/ws/chat/{chat_id}/{user_id}")
async def chat_websocket(websocket: WebSocket, chat_id: int, user_id: int):
    await manager.connect_chat(websocket, chat_id)
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            event_type = data.get("type")

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


# ── Staff WS ──────────────────────────────────────────────────────────
@router.websocket("/ws/staff")
async def staff_websocket(websocket: WebSocket):
    token = websocket.query_params.get("token", "").strip()
    if not token:
        await websocket.close(code=4401)
        return

    # Resolve staff from token before accept()
    async with async_session_maker() as session:
        result = await session.execute(
            select(Staff).where(Staff.session_token == token)
        )
        staff = result.scalar_one_or_none()

    if not staff or not staff.is_active:
        await websocket.close(code=4401)
        return

    role = staff.role
    staff_id = staff.id

    # Accept & join the appropriate pool
    if role == StaffRole.owner:
        await manager.connect_owner(websocket)
    elif role == StaffRole.manager:
        await manager.connect_manager(websocket, staff_id)
    elif role == StaffRole.lawyer:
        await manager.connect_lawyer(websocket, staff_id)
    else:
        await websocket.close(code=4403)
        return

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event_type = data.get("type")

            if event_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
            # Reserved: staff-to-staff events could go here in v2

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Staff WS error (staff_id={staff_id}, role={role.value}): {e}")
    finally:
        if role == StaffRole.owner:
            manager.disconnect_owner(websocket)
        elif role == StaffRole.manager:
            manager.disconnect_manager(websocket, staff_id)
        elif role == StaffRole.lawyer:
            manager.disconnect_lawyer(websocket, staff_id)
