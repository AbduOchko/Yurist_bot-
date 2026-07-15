from datetime import datetime
from typing import List, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import Chat, ChatType, Message, MessageType, SenderType, User


async def get_or_create_user(
    session: AsyncSession,
    telegram_id: int,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> User:
    result = await session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        user = User(
            telegram_id=telegram_id,
            username=username,
            first_name=first_name,
            last_name=last_name,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
    return user


async def get_user_by_telegram_id(session: AsyncSession, telegram_id: int) -> Optional[User]:
    result = await session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    return result.scalar_one_or_none()


async def get_or_create_chat(
    session: AsyncSession,
    user_id: int,
    chat_type: ChatType,
) -> Chat:
    result = await session.execute(
        select(Chat).where(Chat.user_id == user_id, Chat.chat_type == chat_type)
    )
    chat = result.scalar_one_or_none()
    if not chat:
        chat = Chat(user_id=user_id, chat_type=chat_type)
        session.add(chat)
        await session.commit()
        await session.refresh(chat)
    return chat


async def get_chat_by_id(session: AsyncSession, chat_id: int) -> Optional[Chat]:
    result = await session.execute(
        select(Chat)
        .options(selectinload(Chat.user))
        .where(Chat.id == chat_id)
    )
    return result.scalar_one_or_none()


async def get_messages(
    session: AsyncSession,
    chat_id: int,
    limit: int = 50,
    offset: int = 0,
    after: Optional[datetime] = None,
) -> List[Message]:
    q = (
        select(Message)
        .options(selectinload(Message.reply_to))
        .where(Message.chat_id == chat_id, Message.is_deleted == False)
    )
    # `after` — пользовательская отметка очистки истории: скрывает всё, что было
    # до неё (используется только на стороне пользователя/ИИ, не для персонала).
    if after is not None:
        q = q.where(Message.created_at > after)
    # Берём limit САМЫХ СВЕЖИХ сообщений (offset листает вглубь истории), а
    # отдаём в хронологическом порядке. ASC+LIMIT возвращал бы самые старые:
    # переписка длиннее limit «замерзала» на первых сообщениях, и ни новые
    # реплики пользователя, ни контекст ИИ дальше них не уезжали.
    # id — тай-брейк на случай одинаковых created_at.
    q = q.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit).offset(offset)
    result = await session.execute(q)
    return list(reversed(result.scalars().all()))


async def create_message(
    session: AsyncSession,
    chat_id: int,
    sender_type: SenderType,
    content: Optional[str] = None,
    message_type: MessageType = MessageType.text,
    file_url: Optional[str] = None,
    file_name: Optional[str] = None,
    file_size: Optional[int] = None,
    reply_to_id: Optional[int] = None,
    sender_id: Optional[int] = None,
    sender_name: Optional[str] = None,
    forwarded_from_chat_type: Optional[ChatType] = None,
    caption: Optional[str] = None,
) -> Message:
    msg = Message(
        chat_id=chat_id,
        sender_type=sender_type,
        sender_id=sender_id,
        sender_name=sender_name,
        content=content,
        caption=caption,
        message_type=message_type,
        file_url=file_url,
        file_name=file_name,
        file_size=file_size,
        reply_to_id=reply_to_id,
        forwarded_from_chat_type=forwarded_from_chat_type,
    )
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    # Update chat updated_at
    await session.execute(
        update(Chat).where(Chat.id == chat_id).values(updated_at=datetime.utcnow())
    )
    await session.commit()
    return msg


async def edit_message(
    session: AsyncSession,
    message_id: int,
    content: str,
) -> Optional[Message]:
    result = await session.execute(
        select(Message).where(Message.id == message_id)
    )
    msg = result.scalar_one_or_none()
    if msg:
        msg.content = content
        msg.updated_at = datetime.utcnow()
        await session.commit()
        await session.refresh(msg)
    return msg


async def delete_message(session: AsyncSession, message_id: int) -> bool:
    result = await session.execute(
        select(Message).where(Message.id == message_id)
    )
    msg = result.scalar_one_or_none()
    if msg:
        msg.is_deleted = True
        await session.commit()
        return True
    return False


async def toggle_pin_message(session: AsyncSession, message_id: int) -> Optional[Message]:
    result = await session.execute(
        select(Message).where(Message.id == message_id)
    )
    msg = result.scalar_one_or_none()
    if msg:
        msg.is_pinned = not msg.is_pinned
        await session.commit()
        await session.refresh(msg)
    return msg


async def get_pinned_messages(session: AsyncSession, chat_id: int) -> List[Message]:
    result = await session.execute(
        select(Message)
        .where(Message.chat_id == chat_id, Message.is_pinned == True, Message.is_deleted == False)
        .order_by(Message.created_at.desc())
    )
    return list(result.scalars().all())


async def get_all_chats(session: AsyncSession, chat_type: Optional[ChatType] = None):
    q = select(Chat).options(selectinload(Chat.user), selectinload(Chat.messages))
    if chat_type:
        q = q.where(Chat.chat_type == chat_type)
    q = q.order_by(Chat.updated_at.desc())
    result = await session.execute(q)
    return list(result.scalars().all())


async def get_all_users(session: AsyncSession) -> List[User]:
    result = await session.execute(select(User).order_by(User.created_at.desc()))
    return list(result.scalars().all())
