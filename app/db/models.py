import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, Column, DateTime, Enum,
    ForeignKey, Integer, String, Text
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class ChatType(str, enum.Enum):
    ai = "ai"
    lawyer = "lawyer"
    match = "match"


class MessageType(str, enum.Enum):
    text = "text"
    image = "image"
    video = "video"
    audio = "audio"
    voice = "voice"
    document = "document"
    system = "system"


class SenderType(str, enum.Enum):
    user = "user"
    ai = "ai"
    lawyer = "lawyer"
    system = "system"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    telegram_id = Column(BigInteger, unique=True, nullable=False, index=True)
    username = Column(String(255), nullable=True)
    first_name = Column(String(255), nullable=True)
    last_name = Column(String(255), nullable=True)
    # App-level authentication
    app_login = Column(String(50), unique=True, nullable=True, index=True)
    app_password_hash = Column(String(255), nullable=True)
    session_token = Column(String(64), nullable=True, index=True)
    photo_url = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    chats = relationship("Chat", back_populates="user", cascade="all, delete-orphan")


class Chat(Base):
    __tablename__ = "chats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    chat_type = Column(Enum(ChatType), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="chats")
    messages = relationship(
        "Message",
        back_populates="chat",
        order_by="Message.created_at",
        cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    sender_type = Column(Enum(SenderType), nullable=False, default=SenderType.user)
    sender_id = Column(BigInteger, nullable=True)
    sender_name = Column(String(255), nullable=True)
    content = Column(Text, nullable=True)
    message_type = Column(Enum(MessageType), default=MessageType.text)
    file_url = Column(String(1000), nullable=True)
    file_name = Column(String(500), nullable=True)
    file_size = Column(Integer, nullable=True)
    is_deleted = Column(Boolean, default=False)
    is_pinned = Column(Boolean, default=False)
    reply_to_id = Column(Integer, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_chat_type = Column(Enum(ChatType), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    chat = relationship("Chat", back_populates="messages")
    reply_to = relationship("Message", remote_side="Message.id", foreign_keys=[reply_to_id])


class Lawyer(Base):
    __tablename__ = "lawyers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    telegram_id = Column(BigInteger, unique=True, nullable=True)
    name = Column(String(255), nullable=False)
    specialization = Column(String(500), nullable=True)
    is_online = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Admin(Base):
    __tablename__ = "admins"

    id = Column(Integer, primary_key=True, autoincrement=True)
    telegram_id = Column(BigInteger, unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    is_superadmin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
