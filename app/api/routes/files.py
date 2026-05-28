import os
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import settings

router = APIRouter(prefix="/api/files", tags=["files"])

ALLOWED_TYPES = {
    "image": ["image/jpeg", "image/png", "image/gif", "image/webp"],
    "video": ["video/mp4", "video/webm", "video/quicktime"],
    "audio": ["audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/webm"],
    "voice": ["audio/ogg", "audio/webm", "audio/mpeg"],
    "document": None,  # Any type allowed for documents
}


def get_message_type(content_type: str) -> str:
    for msg_type, mime_types in ALLOWED_TYPES.items():
        if mime_types and content_type in mime_types:
            return msg_type
    return "document"


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    if file.size and file.size > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    ext = Path(file.filename).suffix if file.filename else ""
    unique_name = f"{uuid.uuid4()}{ext}"
    upload_path = Path(settings.UPLOAD_DIR)
    upload_path.mkdir(exist_ok=True)
    file_path = upload_path / unique_name

    content = await file.read()
    if len(content) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    file_url = f"{settings.WEBAPP_URL}/api/files/{unique_name}"
    message_type = get_message_type(file.content_type or "")

    return {
        "file_url": file_url,
        "file_name": file.filename,
        "file_size": len(content),
        "message_type": message_type,
        "content_type": file.content_type,
    }


@router.get("/{filename}")
async def get_file(filename: str):
    file_path = Path(settings.UPLOAD_DIR) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path)
