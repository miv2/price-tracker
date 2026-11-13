"""공용 유틸리티."""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 한국 표준시(UTC+9). 서머타임이 없어 고정 오프셋으로 충분하다.
KST = timezone(timedelta(hours=9))

WEEKDAYS = ("월", "화", "수", "목", "금", "토", "일")


def now_kst() -> datetime:
    return datetime.now(tz=KST)


def today_str(now: datetime | None = None) -> str:
    return (now or now_kst()).astimezone(KST).strftime("%Y-%m-%d")


def parse_date(value: str) -> datetime:
    """YYYY-MM-DD 문자열을 KST 자정 datetime으로 변환한다."""
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=KST)


def format_won(price: int | None) -> str:
    return "—" if price is None else f"{price:,}원"


def weekday_ko(value: str) -> str:
    return WEEKDAYS[parse_date(value).weekday()]


def atomic_write_text(path: Path, text: str) -> None:
    """같은 폴더의 임시 파일에 쓴 뒤 교체해 중간에 깨진 파일이 남지 않게 한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
