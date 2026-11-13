"""history.csv로 시술별 가격 추이 페이지(index.html)를 만든다."""

from __future__ import annotations

import json
from pathlib import Path

from .history import group_by_item
from .models import Item
from .util import atomic_write_text

TEMPLATE_PATH = Path(__file__).parent / "templates" / "index.html"
PAYLOAD_PLACEHOLDER = "__PAYLOAD__"


def build_payload(
    rows: list[dict],
    active_items: list[Item],
    source_url: str,
    repo_url: str = "",
) -> dict:
    """그래프 페이지가 쓰는 JSON 데이터를 만든다.

    종료된 항목도 지난 이력을 볼 수 있도록 남기고 ``active``로 구분한다.
    """
    grouped = group_by_item(rows)
    active = {item.key: item for item in active_items}

    items: list[dict] = []
    for (category, name), points in grouped.items():
        entry = {
            "category": category,
            "name": name,
            "active": (category, name) in active,
            "points": [[date, price] for date, price in points],
        }
        current = active.get((category, name))
        if current is not None and current.list_price is not None:
            entry["list_price"] = current.list_price
        items.append(entry)

    items.sort(key=lambda entry: (entry["category"], entry["name"]))
    dates = sorted({row["date"] for row in rows})

    return {
        "source_url": source_url,
        "repo_url": repo_url,
        "days": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "active_count": sum(1 for entry in items if entry["active"]),
        "items": items,
    }


def render_html(payload: dict, template_path: Path = TEMPLATE_PATH) -> str:
    template = template_path.read_text(encoding="utf-8")
    if PAYLOAD_PLACEHOLDER not in template:
        raise RuntimeError(f"그래프 템플릿에 {PAYLOAD_PLACEHOLDER} 자리표시자가 없습니다: {template_path}")

    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # JSON을 <script> 안에 넣을 때 </script>로 조기 종료되지 않게 한다.
    payload_json = (
        payload_json.replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    return template.replace(PAYLOAD_PLACEHOLDER, payload_json)


def write_graph(
    path: Path,
    rows: list[dict],
    active_items: list[Item],
    source_url: str,
    template_path: Path = TEMPLATE_PATH,
    repo_url: str = "",
) -> None:
    payload = build_payload(rows, active_items, source_url, repo_url)
    html = render_html(payload, template_path)
    atomic_write_text(path, html)
