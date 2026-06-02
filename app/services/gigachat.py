"""Sber GigaChat client.

Replaces the previous llmost / OpenAI integration. Two-step auth:

  1. Authorization Key (base64 of client_id:client_secret, the "Authorization
     Key" from the Sber developer cabinet) → POST .../oauth → a short-lived
     access_token (~30 min). Cached in-process and auto-refreshed.
  2. access_token is used as a Bearer for /chat/completions and /files.

Sber endpoints use TLS certificates issued by the Russian Ministry of Digital
Development (НУЦ Минцифры), usually absent from the system CA bundle, so SSL
verification is disabled by default (settings.GIGACHAT_VERIFY_SSL).
"""
import asyncio
import json
import logging
import time
import uuid
from typing import AsyncGenerator, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
_API_BASE = "https://gigachat.devices.sberbank.ru/api/v1"

# In-process access-token cache.
_token: Optional[str] = None
_token_exp: float = 0.0  # unix seconds (when the token stops being valid)
_lock = asyncio.Lock()


def _client(timeout: float = 90.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=settings.GIGACHAT_VERIFY_SSL, timeout=timeout)


async def _fetch_token() -> tuple[str, float]:
    """Request a fresh access_token. Returns (token, expires_at_unix_seconds)."""
    headers = {
        "Authorization": f"Basic {settings.GIGACHAT_AUTH_KEY}",
        "RqUID": str(uuid.uuid4()),
        "Accept": "application/json",
    }
    async with _client(timeout=30) as c:
        r = await c.post(_OAUTH_URL, headers=headers, data={"scope": settings.GIGACHAT_SCOPE})
        r.raise_for_status()
        body = r.json()
    token = body["access_token"]
    # Sber returns expires_at as a Unix timestamp in milliseconds.
    expires_at_ms = body.get("expires_at") or 0
    exp = (expires_at_ms / 1000.0) if expires_at_ms else (time.time() + 25 * 60)
    return token, exp


async def get_token() -> str:
    """Return a valid access_token, refreshing if it expires within 60s."""
    global _token, _token_exp
    now = time.time()
    if _token and now < _token_exp - 60:
        return _token
    async with _lock:
        now = time.time()
        if _token and now < _token_exp - 60:
            return _token
        _token, _token_exp = await _fetch_token()
        logger.info("GigaChat access token refreshed")
        return _token


async def stream_chat(messages: list, model: Optional[str] = None) -> AsyncGenerator[str, None]:
    """Yield text deltas from a streaming GigaChat completion."""
    token = await get_token()
    payload = {
        "model": model or settings.GIGACHAT_MODEL,
        "messages": messages,
        "stream": True,
        "max_tokens": 2048,
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    async with _client() as c:
        async with c.stream("POST", f"{_API_BASE}/chat/completions", headers=headers, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    obj = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta


async def upload_file(data: bytes, filename: str, mime: str) -> str:
    """Upload a file (e.g. an image) and return its GigaChat file id.

    The id is then passed in a message's `attachments` so the model can see it.
    """
    token = await get_token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    files = {"file": (filename, data, mime)}
    async with _client(timeout=120) as c:
        r = await c.post(
            f"{_API_BASE}/files",
            headers=headers,
            files=files,
            data={"purpose": "general"},
        )
        r.raise_for_status()
        return r.json()["id"]
