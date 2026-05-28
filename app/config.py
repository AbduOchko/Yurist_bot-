from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://user:password@localhost:5432/yurist_bot"

    # Telegram
    BOT_TOKEN: str = "your_bot_token"
    WEBHOOK_URL: Optional[str] = None

    # AI
    AI_PROVIDER_API_KEY: str = "your_ai_provider_key"

    # Admin
    ADMIN_PASSWORD: str = "admin123"
    ADMIN_IDS: str = ""

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

    @property
    def admin_ids_list(self) -> list[int]:
        if not self.ADMIN_IDS:
            return []
        return [int(x.strip()) for x in self.ADMIN_IDS.split(",") if x.strip()]


settings = Settings()
