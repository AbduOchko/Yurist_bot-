import json
from collections import defaultdict
from typing import Any, Dict, List

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # chat_id -> list of WebSocket connections
        self.chat_connections: Dict[int, List[WebSocket]] = defaultdict(list)
        # admin connections (receive all lawyer/match chat messages)
        self.admin_connections: List[WebSocket] = []

    async def connect_chat(self, websocket: WebSocket, chat_id: int):
        await websocket.accept()
        self.chat_connections[chat_id].append(websocket)

    def disconnect_chat(self, websocket: WebSocket, chat_id: int):
        connections = self.chat_connections.get(chat_id, [])
        if websocket in connections:
            connections.remove(websocket)

    async def connect_admin(self, websocket: WebSocket):
        await websocket.accept()
        self.admin_connections.append(websocket)

    def disconnect_admin(self, websocket: WebSocket):
        if websocket in self.admin_connections:
            self.admin_connections.remove(websocket)

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

    async def broadcast_to_admins(self, data: Any):
        message = json.dumps(data, ensure_ascii=False, default=str)
        dead = []
        for ws in self.admin_connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_admin(ws)

    async def send_to_chat(self, websocket: WebSocket, data: Any):
        message = json.dumps(data, ensure_ascii=False, default=str)
        await websocket.send_text(message)


manager = ConnectionManager()
