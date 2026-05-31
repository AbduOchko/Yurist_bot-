"""Role-aware WebSocket connection manager.

Three staff pools (manager / lawyer-per-id / owner) plus the per-chat pool
used by end users. `broadcast_to_staff_for_chat` does the routing:

  match chat                          → all managers + all owners
  lawyer chat with assignment         → the assigned lawyer + all owners
  lawyer chat without assignment      → all managers + all owners (so a
                                        manager can pick it up before
                                        assigning anyone)
"""
import json
from collections import defaultdict
from typing import Any, Dict, List

from fastapi import WebSocket

from app.db.models import Chat, ChatType


class ConnectionManager:
    def __init__(self):
        # End-user-side: chat_id → connections
        self.chat_connections: Dict[int, List[WebSocket]] = defaultdict(list)
        # Staff pools
        self.manager_connections: List[WebSocket] = []
        self.lawyer_connections: Dict[int, List[WebSocket]] = defaultdict(list)
        self.owner_connections: List[WebSocket] = []

    # ── End-user-side ──────────────────────────────────────────────
    async def connect_chat(self, websocket: WebSocket, chat_id: int):
        await websocket.accept()
        self.chat_connections[chat_id].append(websocket)

    def disconnect_chat(self, websocket: WebSocket, chat_id: int):
        bucket = self.chat_connections.get(chat_id, [])
        if websocket in bucket:
            bucket.remove(websocket)

    async def broadcast_to_chat(self, chat_id: int, data: Any):
        message = json.dumps(data, ensure_ascii=False, default=str)
        dead = []
        for ws in self.chat_connections.get(chat_id, []):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_chat(ws, chat_id)

    async def send_to_chat(self, websocket: WebSocket, data: Any):
        message = json.dumps(data, ensure_ascii=False, default=str)
        await websocket.send_text(message)

    # ── Staff-side ─────────────────────────────────────────────────
    async def connect_manager(self, websocket: WebSocket):
        await websocket.accept()
        self.manager_connections.append(websocket)

    def disconnect_manager(self, websocket: WebSocket):
        if websocket in self.manager_connections:
            self.manager_connections.remove(websocket)

    async def connect_lawyer(self, websocket: WebSocket, staff_id: int):
        await websocket.accept()
        self.lawyer_connections[staff_id].append(websocket)

    def disconnect_lawyer(self, websocket: WebSocket, staff_id: int):
        bucket = self.lawyer_connections.get(staff_id, [])
        if websocket in bucket:
            bucket.remove(websocket)

    async def connect_owner(self, websocket: WebSocket):
        await websocket.accept()
        self.owner_connections.append(websocket)

    def disconnect_owner(self, websocket: WebSocket):
        if websocket in self.owner_connections:
            self.owner_connections.remove(websocket)

    async def _broadcast_list(self, pool: List[WebSocket], data: Any):
        if not pool:
            return
        message = json.dumps(data, ensure_ascii=False, default=str)
        dead = []
        for ws in pool:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in pool:
                pool.remove(ws)

    async def broadcast_to_managers(self, data: Any):
        await self._broadcast_list(self.manager_connections, data)

    async def broadcast_to_owners(self, data: Any):
        await self._broadcast_list(self.owner_connections, data)

    async def broadcast_to_lawyer(self, staff_id: int, data: Any):
        await self._broadcast_list(self.lawyer_connections.get(staff_id, []), data)

    async def broadcast_to_staff_for_chat(self, chat: Chat, data: Any):
        """Dispatch a chat-event payload to the appropriate staff pools."""
        await self.broadcast_to_owners(data)
        if chat.chat_type == ChatType.match:
            await self.broadcast_to_managers(data)
        elif chat.chat_type == ChatType.lawyer:
            if chat.lawyer_staff_id:
                await self.broadcast_to_lawyer(chat.lawyer_staff_id, data)
            else:
                await self.broadcast_to_managers(data)
        # AI chats: don't broadcast to staff


manager = ConnectionManager()
