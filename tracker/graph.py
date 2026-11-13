"""history.csv로 시술별 가격 추이 페이지(index.html)를 만든다."""

from __future__ import annotations

import json
from pathlib import Path

from .history import group_by_item
from .models import Item
from .util import atomic_write_text

TEMPLATE_PATH = Path(__file__).parent / "templates" / "index.html"
PAYLOAD_PLACEHOLDER = "__PAYLOAD__"

KIND_ORDER = {"decrease": 0, "increase": 1, "new": 2, "removed": 3}


def build_recent_changes(rows: list[dict], items: list[dict]) -> dict:
    """최근 두 수집일을 비교해 페이지 상단에 보여줄 변동 목록을 만든다.

    ``items``는 정렬된 페이로드 항목 목록이며, 각 변동에는 그 목록에서의 위치를
    ``index``로 담아 클릭 시 그래프를 바로 열 수 있게 한다. 기록이 하루뿐이면
    ``baseline``이 참이고 변동 목록은 비운다.
    """
    dates = sorted({row["date"] for row in rows})
    counts = {"decrease": 0, "increase": 0, "new": 0, "removed": 0}

    if not dates:
        return {
            "baseline": True,
            "date": None,
            "prev_date": None,
            "counts": counts,
            "total": 0,
            "items": [],
        }

    last_date = dates[-1]
    if len(dates) < 2:
        return {
            "baseline": True,
            "date": last_date,
            "prev_date": None,
            "counts": counts,
            "total": 0,
            "items": [],
        }

    prev_date = dates[-2]
    prev_prices: dict[tuple[str, str], int] = {}
    last_prices: dict[tuple[str, str], int] = {}
    for row in rows:
        key = (row["category"], row["name"])
        if row["date"] == prev_date:
            prev_prices[key] = row["sale_price"]
        elif row["date"] == last_date:
            last_prices[key] = row["sale_price"]

    index = {(entry["category"], entry["name"]): i for i, entry in enumerate(items)}
    changes: list[dict] = []
    for key in set(prev_prices) | set(last_prices):
        before = prev_prices.get(key)
        after = last_prices.get(key)
        if before == after:
            continue
        if before is None:
            kind = "new"
        elif after is None:
            kind = "removed"
        elif after < before:
            kind = "decrease"
        else:
            kind = "increase"
        counts[kind] += 1
        changes.append(
            {
                "index": index.get(key, -1),
                "category": key[0],
                "name": key[1],
                "kind": kind,
                "prev": before,
                "price": after,
                "delta": (after - before) if before is not None and after is not None else None,
            }
        )

    changes.sort(
        key=lambda change: (
            KIND_ORDER[change["kind"]],
            -(abs(change["delta"]) if change["delta"] is not None else 0),
            change["category"],
            change["name"],
        )
    )

    return {
        "baseline": False,
        "date": last_date,
        "prev_date": prev_date,
        "counts": counts,
        "total": len(changes),
        "items": changes,
    }


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
        prices = [price for _, price in points]
        all_time_low = min(prices)
        all_time_high = max(prices)
        avg_price = round(sum(prices) / len(prices))
        current_price = prices[-1]
        price_vs_avg = round((current_price - avg_price) / avg_price * 100, 1) if avg_price else 0

        entry = {
            "category": category,
            "name": name,
            "active": (category, name) in active,
            "points": [[date, price] for date, price in points],
            "all_time_low": all_time_low,
            "all_time_high": all_time_high,
            "avg_price": avg_price,
            "price_vs_avg": price_vs_avg,
        }
        current = active.get((category, name))
        if current is not None and current.list_price is not None:
            entry["list_price"] = current.list_price
            entry["discount_rate"] = round(
                (1 - current_price / current.list_price) * 100
            ) if current.list_price > 0 else 0
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
        "recent": build_recent_changes(rows, items),
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
