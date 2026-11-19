"""prices.json(직전 실행 결과) 읽기와 저장."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from .models import Item
from .util import atomic_write_text


class PricesError(Exception):
    """prices.json을 읽을 수 없을 때 발생한다. 데이터를 덮어쓰지 않기 위해 실행을 중단한다."""


def load_prices(path: Path) -> dict[tuple[str, str], Item] | None:
    """prices.json을 읽는다. 파일이 없으면 None(첫 실행)을 돌려준다."""

    if not path.exists():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PricesError(f"prices.json을 읽지 못했습니다: {path} ({exc})") from exc

    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise PricesError("prices.json 형식이 올바르지 않습니다. 'items' 목록이 필요합니다.")

    items: dict[tuple[str, str], Item] = {}
    for raw in data["items"]:
        if not isinstance(raw, dict):
            raise PricesError("prices.json의 items 항목이 객체가 아닙니다.")
        try:
            category = str(raw["category"])
            name = str(raw["name"])
            sale_price = int(raw["sale_price"])
        except (KeyError, TypeError, ValueError) as exc:
            raise PricesError(f"prices.json 항목에 필수 값이 없습니다: {raw!r}") from exc

        list_price = raw.get("list_price")
        list_price = int(list_price) if isinstance(list_price, (int, float)) and not isinstance(list_price, bool) else None
        item = Item(
            category=category,
            name=name,
            list_price=list_price,
            sale_price=sale_price,
            first_seen=raw.get("first_seen"),
            last_seen=raw.get("last_seen"),
        )
        items[item.key] = item

    return items


def save_prices(
    path: Path,
    items: list[Item],
    updated_at: str,
    source_url: str,
    event_period: tuple[str, str] | None = None,
) -> None:
    """현재 스냅샷을 사람이 읽기 좋은 형태로 저장한다."""
    payload: dict[str, object] = {
        "source_url": source_url,
        "updated_at": updated_at,
        "count": len(items),
        "items": [item.to_json() for item in sorted(items, key=lambda i: i.key)],
    }
    if event_period:
        payload["event_period"] = {"start": event_period[0], "end": event_period[1]}
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(path, text)


def load_event_period(path: Path) -> tuple[str, str] | None:
    """prices.json에 저장된 이벤트 기간을 읽는다. 없거나 잘못됐으면 None."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = data.get("event_period") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        return None
    start, end = raw.get("start"), raw.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        return None
    try:
        if date.fromisoformat(end) < date.fromisoformat(start):
            return None
    except ValueError:
        return None
    return start, end
