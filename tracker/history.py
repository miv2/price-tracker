"""history.csv에 날짜별 할인가를 누적한다."""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from pathlib import Path

from .models import Item
from .util import atomic_write_text

FIELDNAMES = ("date", "category", "name", "sale_price")


def load_history(path: Path) -> list[dict]:
    """history.csv를 읽어 날짜 오름차순 행 목록으로 돌려준다."""
    if not path.exists():
        return []

    rows: list[dict] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for raw in reader:
                try:
                    value = int(str(raw.get("sale_price", "")).replace(",", "").strip())
                except (TypeError, ValueError):
                    continue
                date = (raw.get("date") or "").strip()
                category = (raw.get("category") or "").strip()
                name = (raw.get("name") or "").strip()
                if not date or not name:
                    continue
                rows.append(
                    {"date": date, "category": category, "name": name, "sale_price": value}
                )
    except OSError:
        return []

    rows.sort(key=lambda row: (row["date"], row["category"], row["name"]))
    return rows


def record_snapshot(path: Path, date: str, items: list[Item]) -> bool:
    """그날의 스냅샷을 기록한다.

    같은 날 다시 실행하면 그날 행을 최신 값으로 교체한다. 다른 날짜 기록은 건드리지 않는다.
    파일이 실제로 바뀌었는지 여부를 돌려준다.
    """
    existing = [row for row in load_history(path) if row["date"] != date]
    merged = existing + [
        {
            "date": date,
            "category": item.category,
            "name": item.name,
            "sale_price": item.sale_price,
        }
        for item in items
    ]
    merged.sort(key=lambda row: (row["date"], row["category"], row["name"]))

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=FIELDNAMES, lineterminator="\n")
    writer.writeheader()
    writer.writerows(merged)
    text = buffer.getvalue()

    if path.exists():
        try:
            if path.read_text(encoding="utf-8-sig") == text:
                return False
        except OSError:
            pass
    # utf-8-sig: 엑셀에서 열어도 한글이 깨지지 않는다.
    atomic_write_text(path, "\ufeff" + text)
    return True


def group_by_item(rows: list[dict]) -> dict[tuple[str, str], list[tuple[str, int]]]:
    """(카테고리, 시술명)별 날짜·가격 목록으로 묶는다. 같은 날짜는 마지막 값만 남긴다."""
    grouped: dict[tuple[str, str], dict[str, int]] = defaultdict(dict)
    for row in rows:
        key = (row["category"], row["name"])
        grouped[key][row["date"]] = row["sale_price"]
    return {
        key: sorted(points.items())  # 날짜 문자열(YYYY-MM-DD)은 사전순 = 시간순
        for key, points in grouped.items()
    }
