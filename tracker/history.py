"""history.csv에 날짜별 할인가를 누적한다."""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date as calendar_date
from pathlib import Path

from .models import Item, PriceRow
from .util import atomic_write_text

FIELDNAMES = ("date", "category", "name", "sale_price")


def _row_sort_key(row: PriceRow) -> tuple[str, str, str]:
    return (row["date"], row["category"], row["name"])


class HistoryError(Exception):
    """기존 이력을 안전하게 읽을 수 없을 때 발생한다."""


def load_history(path: Path) -> list[PriceRow]:
    """history.csv를 읽어 날짜 오름차순 행 목록으로 돌려준다."""
    if not path.exists():
        return []

    rows: list[PriceRow] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle, strict=True)
            if tuple(reader.fieldnames or ()) != FIELDNAMES:
                raise HistoryError(f"history.csv의 열 구성이 올바르지 않습니다: {path}")
            for line_number, raw in enumerate(reader, start=2):
                try:
                    value = int(raw["sale_price"].replace(",", "").strip())
                    if value < 0:
                        raise ValueError("negative price")
                    date = raw["date"].strip()
                    if calendar_date.fromisoformat(date).isoformat() != date:
                        raise ValueError("noncanonical date")
                    category = raw["category"].strip()
                    name = raw["name"].strip()
                    if not name or None in raw:
                        raise ValueError("missing or extra field")
                except (AttributeError, KeyError, TypeError, ValueError) as exc:
                    raise HistoryError(f"history.csv의 {line_number}행이 올바르지 않습니다: {path}") from exc
                rows.append(
                    {"date": date, "category": category, "name": name, "sale_price": value}
                )
    except (OSError, UnicodeError, csv.Error) as exc:
        raise HistoryError(f"history.csv를 읽지 못했습니다: {path} ({exc})") from exc

    rows.sort(key=_row_sort_key)
    return rows


def merge_snapshot(rows: list[PriceRow], date: str, items: list[Item]) -> list[PriceRow]:
    """기존 이력에서 해당 날짜 행을 새 스냅샷으로 교체하고 정렬한 목록을 만든다."""
    merged = [row for row in rows if row["date"] != date]
    merged.extend(
        {
            "date": date,
            "category": item.category,
            "name": item.name,
            "sale_price": item.sale_price,
        }
        for item in items
    )
    merged.sort(key=_row_sort_key)
    return merged


def record_snapshot(
    path: Path,
    date: str,
    items: list[Item],
    rows: list[PriceRow] | None = None,
) -> tuple[bool, list[PriceRow]]:
    """그날의 스냅샷을 기록하고 (파일 변경 여부, 갱신된 이력)을 돌려준다.

    같은 날 다시 실행하면 그날 행을 최신 값으로 교체한다. 다른 날짜 기록은 건드리지 않는다.
    ``rows``를 넘기면 이미 읽어 둔 이력을 다시 읽지 않는다.
    """
    merged = merge_snapshot(rows if rows is not None else load_history(path), date, items)

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=FIELDNAMES, lineterminator="\n")
    writer.writeheader()
    writer.writerows(merged)
    text = buffer.getvalue()

    if path.exists():
        try:
            if path.read_text(encoding="utf-8-sig") == text:
                return False, merged
        except OSError:
            pass
    # utf-8-sig: 엑셀에서 열어도 한글이 깨지지 않는다.
    atomic_write_text(path, "\ufeff" + text)
    return True, merged


def group_by_item(rows: list[PriceRow]) -> dict[tuple[str, str], list[tuple[str, int]]]:
    """(카테고리, 시술명)별 날짜·가격 목록으로 묶는다. 같은 날짜는 마지막 값만 남긴다."""
    grouped: dict[tuple[str, str], dict[str, int]] = defaultdict(dict)
    for row in rows:
        key = (row["category"], row["name"])
        grouped[key][row["date"]] = row["sale_price"]
    return {
        key: sorted(points.items())  # 날짜 문자열(YYYY-MM-DD)은 사전순 = 시간순
        for key, points in grouped.items()
    }
