"""history.csv로 시술별 가격 추이 페이지(index.html)를 만든다.

페이지는 HTML 골격(index.html)과 정적 자산(assets/style.css, assets/app.js,
assets/vendor/chart.umd.min.js)으로 나뉜다. 매일 바뀌는 것은 데이터가 들어간
HTML뿐이라 브라우저가 CSS·JS를 재사용할 수 있고, 자산 주소에는 내용 해시를
붙여 바뀔 때만 새로 받게 한다.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .changes import (
    Payload,
    build_history_changes,
    build_monthly_summary,
    build_recent_changes,
    snapshot_dates,
)
from .history import group_by_item
from .models import Item, PriceRow
from .util import atomic_write_text

TEMPLATE_DIR = Path(__file__).parent / "templates"
TEMPLATE_PATH = TEMPLATE_DIR / "index.html"
ASSET_VERSION_PLACEHOLDER = "__ASSET_VERSION__"
DATA_VERSION_PLACEHOLDER = "__DATA_VERSION__"
SW_CACHE_PLACEHOLDER = "__CACHE_VERSION__"
SW_PRECACHE_PLACEHOLDER = "__PRECACHE__"
ASSET_NAMES = ("style.css", "app.js", "vendor/chart.umd.min.js")
ASSET_DIR_NAME = "assets"
DATA_JS_NAME = "data.js"
SW_NAME = "sw.js"
PWA_STATIC_FILES = (
    "manifest.webmanifest",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
    "icons/apple-touch-icon.png",
    "assets/first-visit-banner.jpg",
    "assets/monthly-banner.jpg",
)


def build_item_entries(rows: list[PriceRow], active_items: list[Item]) -> list[Payload]:
    """시술별 가격 통계(최저·최고·평균·할인율)를 담은 목록을 만든다."""
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
    return items


def build_payload(
    rows: list[PriceRow],
    active_items: list[Item],
    source_url: str,
    repo_url: str = "",
    event_period: tuple[str, str] | None = None,
) -> Payload:
    """그래프 페이지가 쓰는 JSON 데이터를 만든다.

    종료된 항목도 지난 이력을 볼 수 있도록 남기고 ``active``로 구분한다.
    """
    items = build_item_entries(rows, active_items)
    dates = snapshot_dates(rows)
    events = build_history_changes(rows, items)
    for event in events:
        if event["kind"] == "returned":
            items[event["index"]]["returned"] = event

    return {
        "source_url": source_url,
        "repo_url": repo_url,
        "event_period": (
            {"start": event_period[0], "end": event_period[1]}
            if event_period else None
        ),
        "days": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "active_count": sum(1 for entry in items if entry["active"]),
        "recent": build_recent_changes(rows, events),
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


def _resolve_asset_version(template_dir: Path, version: str) -> str:
    """넘겨받은 버전이 없으면 템플릿 내용으로 계산한다. 템플릿이 없으면 0."""
    if version:
        return version
    try:
        return asset_version(load_assets(template_dir))
    except OSError:
        return "0"


def _write_if_changed(path: Path, text: str) -> bool:
    """내용이 같으면 다시 쓰지 않는다. 실제로 썼는지 돌려준다."""
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == text:
                return False
        except OSError:
            pass
    atomic_write_text(path, text)
    return True


def write_assets(target_dir: Path, assets: dict[str, str]) -> None:
    """정적 자산을 대상 폴더에 쓴다. 내용이 같으면 건드리지 않는다."""
    for name, text in assets.items():
        _write_if_changed(target_dir / name, text)


def precache_urls(version: str, data_version: str = "") -> list[str]:
    """서비스 워커가 첫 설치에서 미리 받을 주소 목록을 만든다.

    자산 이름은 ``ASSET_NAMES``·``PWA_STATIC_FILES`` 한 곳에서만 관리한다.
    """
    return [
        "./",
        "./index.html",
        *[f"./{ASSET_DIR_NAME}/{name}?v={version}" for name in ASSET_NAMES],
        f"./{ASSET_DIR_NAME}/{DATA_JS_NAME}?v={data_version or '0'}",
        *[f"./{name}" for name in PWA_STATIC_FILES],
    ]


def render_service_worker(
    template_dir: Path = TEMPLATE_DIR,
    version: str = "",
    data_version: str = "",
) -> str:
    """오프라인 캐시용 서비스 워커(sw.js)를 만든다.

    캐시 이름에는 자산·데이터 해시를 넣어, 내용이 바뀌면 예전 캐시를 버리고
    새 파일을 미리 받는다. 첫 설치에서도 오프라인으로 열 수 있도록 페이지와
    화면에 필요한 자산을 모두 미리 받아 둔다.
    """
    template = (template_dir / SW_NAME).read_text(encoding="utf-8")
    version = _resolve_asset_version(template_dir, version)
    precache = precache_urls(version, data_version)
    cache_version = hashlib.sha256(f"{version}|{data_version}".encode("utf-8")).hexdigest()[:10]
    return (
        template.replace(SW_CACHE_PLACEHOLDER, cache_version)
        .replace(SW_PRECACHE_PLACEHOLDER, json.dumps(precache, ensure_ascii=False))
    )


def serialize_payload(payload: Payload) -> str:
    """페이로드를 JSON 문자열로 직렬화한다."""
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return (
        payload_json.replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def render_html(
    template_path: Path = TEMPLATE_PATH,
    version: str = "",
    data_version: str = "",
) -> str:
    template = template_path.read_text(encoding="utf-8")
    version = _resolve_asset_version(template_path.parent, version)

    html = template.replace(ASSET_VERSION_PLACEHOLDER, version)
    if DATA_VERSION_PLACEHOLDER in html:
        html = html.replace(DATA_VERSION_PLACEHOLDER, data_version or "0")
    return html


def write_data(target_dir: Path, payload: Payload) -> str:
    """대용량 페이로드를 assets/data.js로 분리 저장하고 내용 해시를 돌려준다.

    HTML에는 데이터가 들어가지 않으므로 골격을 캐시할 수 있고, 데이터가
    바뀔 때만 data.js의 쿼리 문자열이 달라진다.
    """
    data_js = f"window.__PRICE_DATA__={serialize_payload(payload)};"
    data_version = hashlib.sha256(data_js.encode("utf-8")).hexdigest()[:10]
    _write_if_changed(target_dir / DATA_JS_NAME, data_js)
    return data_version


def write_graph(
    path: Path,
    rows: list[PriceRow],
    active_items: list[Item],
    source_url: str,
    template_path: Path = TEMPLATE_PATH,
    repo_url: str = "",
    event_period: tuple[str, str] | None = None,
) -> None:
    payload = build_payload(rows, active_items, source_url, repo_url, event_period)
    assets = load_assets(template_path.parent)
    assets_dir = path.parent / ASSET_DIR_NAME

    write_assets(assets_dir, assets)
    data_version = write_data(assets_dir, payload)

    version = asset_version(assets)
    atomic_write_text(path, render_html(template_path, version, data_version))
    atomic_write_text(
        path.parent / SW_NAME,
        render_service_worker(template_path.parent, version, data_version),
    )
