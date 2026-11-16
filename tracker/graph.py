"""history.csv로 시술별 가격 추이 페이지(index.html)를 만든다.

페이지는 HTML 골격(index.html)과 정적 자산(assets/style.css, assets/app.js,
assets/vendor/chart.umd.min.js)으로 나뉜다. 매일 바뀌는 것은 데이터가 들어간
HTML뿐이라 브라우저가 CSS·JS를 재사용할 수 있고, 자산 주소에는 내용 해시를
붙여 바뀔 때만 새로 받게 한다.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .compare import detect_changes
from .history import group_by_item
from .models import Item, PriceRow
from .util import atomic_write_text

TEMPLATE_DIR = Path(__file__).parent / "templates"
TEMPLATE_PATH = TEMPLATE_DIR / "index.html"
PAYLOAD_PLACEHOLDER = "__PAYLOAD__"
ASSET_VERSION_PLACEHOLDER = "__ASSET_VERSION__"
DATA_VERSION_PLACEHOLDER = "__DATA_VERSION__"
ASSET_NAMES = ("style.css", "app.js", "vendor/chart.umd.min.js")
ASSET_DIR_NAME = "assets"
DATA_JS_NAME = "data.js"

Payload = dict[str, Any]

KIND_ORDER = {"decrease": 0, "increase": 1, "returned": 2, "new": 3, "removed": 4}


def build_history_changes(rows: list[PriceRow], items: list[Payload]) -> list[Payload]:
    """수집일 사이 변동을 계산한다. 수집하지 않은 날은 종료로 해석하지 않는다."""
    snapshots: dict[str, dict[tuple[str, str], Item]] = defaultdict(dict)
    for row in rows:
        item = Item(row["category"], row["name"], None, row["sale_price"])
        snapshots[row["date"]][item.key] = item
    index = {(entry["category"], entry["name"]): i for i, entry in enumerate(items)}
    previous: dict[tuple[str, str], Item] | None = None
    last_known: dict[tuple[str, str], int] = {}
    prev_date: str | None = None
    events: list[Payload] = []
    for date, snapshot in sorted(snapshots.items()):
        changes = detect_changes(previous.values() if previous is not None else None, snapshot.values(), last_known)
        for change in changes.decreases + changes.increases + changes.returned + changes.new + changes.removed:
            events.append({
                "index": index.get(change.key, -1),
                "date": date,
                "prev_date": prev_date,
                "category": change.category,
                "name": change.name,
                "kind": change.kind,
                "prev": change.old_price,
                "price": change.new_price,
                "delta": change.delta,
            })
        last_known.update({key: item.sale_price for key, item in snapshot.items()})
        previous = snapshot
        prev_date = date
    return events


def change_counts(events: list[Payload]) -> dict[str, int]:
    counts = dict.fromkeys(KIND_ORDER, 0)
    for event in events:
        counts[event["kind"]] += 1
    return counts


def build_recent_changes(
    rows: list[PriceRow], items: list[Payload], events: list[Payload] | None = None,
) -> Payload:
    """최근 두 수집일의 변동. 재등장은 종료 전 마지막 가격과 비교한다."""
    dates = sorted({row["date"] for row in rows})
    if events is None:
        events = build_history_changes(rows, items)
    changes = [event for event in events if dates and event["date"] == dates[-1]]
    changes.sort(
        key=lambda change: (
            KIND_ORDER[change["kind"]],
            -(abs(change["delta"]) if change["delta"] is not None else 0),
            change["category"], change["name"],
        )
    )
    return {
        "baseline": len(dates) < 2,
        "date": dates[-1] if dates else None,
        "prev_date": dates[-2] if len(dates) > 1 else None,
        "counts": change_counts(changes),
        "total": len(changes),
        "items": changes,
    }


def build_monthly_summary(rows: list[PriceRow], events: list[Payload]) -> list[Payload]:
    """월별 변동 횟수와 시술별 가장 큰 단일 인하 상위 5개를 만든다."""
    dates = sorted({row["date"] for row in rows})
    months: dict[str, list[str]] = defaultdict(list)
    monthly_events: dict[str, list[Payload]] = defaultdict(list)
    for date in dates:
        months[date[:7]].append(date)
    for event in events:
        monthly_events[event["date"][:7]].append(event)
    summaries: list[Payload] = []
    for month, month_dates in sorted(months.items(), reverse=True):
        changes = monthly_events[month]
        biggest: dict[int, Payload] = {}
        for event in changes:
            if event["kind"] != "decrease":
                continue
            old = biggest.get(event["index"])
            if old is None or event["delta"] < old["delta"] or (
                event["delta"] == old["delta"] and event["date"] > old["date"]
            ):
                biggest[event["index"]] = event
        top = sorted(biggest.values(), key=lambda event: (event["delta"], event["category"], event["name"]))[:5]
        summaries.append({
            "month": month,
            "first_date": month_dates[0],
            "last_date": month_dates[-1],
            "days": len(month_dates),
            "includes_baseline": month_dates[0] == dates[0],
            "counts": change_counts(changes),
            "total": len(changes),
            "top_decreases": top,
        })
    return summaries


def build_payload(
    rows: list[PriceRow],
    active_items: list[Item],
    source_url: str,
    repo_url: str = "",
) -> Payload:
    """그래프 페이지가 쓰는 JSON 데이터를 만든다.

    종료된 항목도 지난 이력을 볼 수 있도록 남기고 ``active``로 구분한다.
    """
    grouped = group_by_item(rows)
    active = {item.key: item for item in active_items}

    items: list[Payload] = []
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
    events = build_history_changes(rows, items)
    for event in events:
        if event["kind"] == "returned":
            items[event["index"]]["returned"] = event

    return {
        "source_url": source_url,
        "repo_url": repo_url,
        "days": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "active_count": sum(1 for entry in items if entry["active"]),
        "recent": build_recent_changes(rows, items, events),
        "monthly": build_monthly_summary(rows, events),
        "items": items,
    }


def load_assets(template_dir: Path = TEMPLATE_DIR) -> dict[str, str]:
    """템플릿 폴더에서 배포할 정적 자산(CSS·JS)을 읽는다."""
    return {
        name: (template_dir / name).read_text(encoding="utf-8")
        for name in ASSET_NAMES
    }


def asset_version(assets: dict[str, str]) -> str:
    """자산 내용이 바뀔 때만 달라지는 짧은 해시. 캐시 무효화용 쿼리로 쓴다."""
    digest = hashlib.sha256()
    for name in sorted(assets):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(assets[name].encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()[:10]


def write_assets(target_dir: Path, assets: dict[str, str]) -> None:
    """정적 자산을 대상 폴더에 쓴다. 내용이 같으면 건드리지 않는다."""
    for name, text in assets.items():
        target = target_dir / name
        if target.exists() and target.read_text(encoding="utf-8") == text:
            continue
        atomic_write_text(target, text)


def serialize_payload(payload: Payload) -> str:
    """페이로드를 JSON 문자열로 직렬화한다."""
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return (
        payload_json.replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def render_html(
    payload: Payload,
    template_path: Path = TEMPLATE_PATH,
    version: str = "",
    data_version: str = "",
) -> str:
    template = template_path.read_text(encoding="utf-8")

    if not version:
        try:
            version = asset_version(load_assets(template_path.parent))
        except OSError:
            version = "0"

    html = template.replace(ASSET_VERSION_PLACEHOLDER, version)
    if DATA_VERSION_PLACEHOLDER in html:
        html = html.replace(DATA_VERSION_PLACEHOLDER, data_version or "0")

    # 하위 호환: 템플릿에 여전히 __PAYLOAD__ 자리가 남아있는 경우 인라인 치환
    if PAYLOAD_PLACEHOLDER in html:
        html = html.replace(PAYLOAD_PLACEHOLDER, serialize_payload(payload))

    return html


def write_graph(
    path: Path,
    rows: list[PriceRow],
    active_items: list[Item],
    source_url: str,
    template_path: Path = TEMPLATE_PATH,
    repo_url: str = "",
) -> None:
    payload = build_payload(rows, active_items, source_url, repo_url)
    assets = load_assets(template_path.parent)
    assets_dir = path.parent / ASSET_DIR_NAME

    # 1. CSS 및 정적 JS 자산 저장
    write_assets(assets_dir, assets)

    # 2. 대용량 가격 페이로드를 assets/data.js로 분리하여 HTML 용량 절감 및 캐싱 활성화
    payload_json = serialize_payload(payload)
    data_js = f"window.__PRICE_DATA__={payload_json};"
    data_version = hashlib.sha256(data_js.encode("utf-8")).hexdigest()[:10]
    data_target = assets_dir / DATA_JS_NAME
    if not data_target.exists() or data_target.read_text(encoding="utf-8") != data_js:
        atomic_write_text(data_target, data_js)

    # 3. 경량 HTML 스켈레톤 생성
    html = render_html(payload, template_path, asset_version(assets), data_version)
    atomic_write_text(path, html)
