from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Database (Railway provides postgresql:// — we convert it to asyncpg)
    DATABASE_URL: str = "postgresql+asyncpg://user:password@localhost:5432/yurist_bot"

    @property
    def async_database_url(self) -> str:
        url = self.DATABASE_URL
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url

    # Telegram
    BOT_TOKEN: str = "your_bot_token"
    WEBHOOK_URL: Optional[str] = None

    # AI (llmost.ru — OpenAI-compatible proxy)
    LLMOST_API_KEY: str = "your_llmost_api_key"
    LLMOST_BASE_URL: str = "https://llmost.ru/api/v1"
    LLMOST_MODEL: str = "openai/gpt-4o"
    # Модель, принимающая голос как input_audio в /chat/completions.
    LLMOST_AUDIO_MODEL: str = "openai/gpt-4o-audio-preview"

    # Bootstrap первого владельца (создаётся один раз при старте, если
    # в таблице staff ещё нет роли owner). После первого логина владелец
    # должен сменить пароль через панель.
    OWNER_BOOTSTRAP_LOGIN: str = ""
    OWNER_BOOTSTRAP_PASSWORD: str = ""

    # App
    WEBAPP_URL: str = "http://localhost:8000"
    PORT: int = 8000
    HOST: str = "0.0.0.0"

    # Files
    UPLOAD_DIR: str = "uploads"
    MAX_FILE_SIZE: int = 52428800  # 50MB

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
