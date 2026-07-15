"""Общие хелперы сериализации для API."""
from datetime import datetime, timezone
from typing import Optional


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    """datetime → ISO-8601 с явным UTC-суффиксом «Z». None пробрасывается как None.

    В БД время лежит наивным UTC (datetime.utcnow), и голый .isoformat() отдавал
    «2026-07-15T10:10:00» — без таймзоны. По спецу ECMA-262 такую строку
    `new Date()` в браузере трактует как МЕСТНОЕ время, а не UTC, поэтому в чатах
    и панелях время уезжало на UTC-офсет пользователя (для UTC+5 — на 5 часов
    назад). Суффикс «Z» убирает двусмысленность: клиент сам приводит к локальному.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
