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
    support = "support"  # прямой чат с владельцем проекта
    group = "group"      # общий чат: пользователь + юрист + менеджер


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
    manager = "manager"  # сообщения менеджера в групповом чате
    system = "system"


class StaffRole(str, enum.Enum):
    owner = "owner"
    manager = "manager"
    lawyer = "lawyer"


class BroadcastStatus(str, enum.Enum):
    draft = "draft"
    sending = "sending"
    done = "done"
    failed = "failed"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    telegram_id = Column(BigInteger, unique=True, nullable=False, index=True)
    username = Column(String(255), nullable=True)
    first_name = Column(String(255), nullable=True)
    last_name = Column(String(255), nullable=True)
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
    lawyer_staff_id = Column(
        Integer,
        ForeignKey("staff.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Менеджер-создатель группового чата (chat_type=group). Для остальных типов NULL.
    manager_staff_id = Column(
        Integer,
        ForeignKey("staff.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Момент, до которого пользователь «очистил» историю у себя. Сообщения с
    # created_at <= user_cleared_at не показываются пользователю (и не идут в
    # контекст ИИ), но остаются в БД и видны персоналу.
    user_cleared_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="chats")
    lawyer = relationship("Staff", foreign_keys=[lawyer_staff_id])
    messages = relationship(
        "Message",
        back_populates="chat",
        order_by="Message.created_at",
        cascade="all, delete-orphan",
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    sender_type = Column(Enum(SenderType), nullable=False, default=SenderType.user)
    sender_id = Column(BigInteger, nullable=True)
    sender_name = Column(String(255), nullable=True)
    content = Column(Text, nullable=True)
    caption = Column(Text, nullable=True)  # подпись к медиа (фото/видео/голос/файл)
    message_type = Column(Enum(MessageType), default=MessageType.text)
    file_url = Column(Text, nullable=True)
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


class Staff(Base):
    __tablename__ = "staff"

    id = Column(Integer, primary_key=True, autoincrement=True)
    role = Column(Enum(StaffRole), nullable=False, index=True)
    login = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=False)
    # telegram_id не уникален вообще: один telegram_id можно привязать к любому
    # числу staff-строк (разные роли или даже несколько строк с одной ролью).
    # Никаких unique-индексов на него нет — см. session.py create_tables.
    telegram_id = Column(BigInteger, nullable=True, index=True)
    specialization = Column(String(500), nullable=True)
    is_active = Column(Boolean, default=True)
    is_online = Column(Boolean, default=False)
    session_token = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class RequiredChannel(Base):
    __tablename__ = "required_channels"

    id = Column(Integer, primary_key=True, autoincrement=True)
    channel_id = Column(BigInteger, unique=True, nullable=False)  # Telegram chat_id
    username = Column(String(255), nullable=True)
    title = Column(String(255), nullable=False)
    invite_url = Column(String(500), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Broadcast(Base):
    __tablename__ = "broadcasts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sender_staff_id = Column(Integer, ForeignKey("staff.id", ondelete="SET NULL"), nullable=True)
    content = Column(Text, nullable=False)
    recipients_total = Column(Integer, default=0)
    recipients_sent = Column(Integer, default=0)
    recipients_failed = Column(Integer, default=0)
    status = Column(Enum(BroadcastStatus), default=BroadcastStatus.draft, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)
