"""그래프 페이지 생성 테스트."""

from __future__ import annotations

import json
from pathlib import Path

from tracker.graph import (
    asset_version,
    build_payload,
    load_assets,
    render_html,
    render_service_worker,
    write_assets,
    write_graph,
)
from tracker.models import Item, PriceRow

ROOT = Path(__file__).resolve().parents[1]

ROWS = [
    {"date": "2026-11-13", "category": "첫방문 이벤트", "name": "피코토닝 1회", "sale_price": 29_000},
    {"date": "2026-11-14", "category": "첫방문 이벤트", "name": "피코토닝 1회", "sale_price": 25_000},
    {"date": "2026-11-14", "category": "빼빼로데이", "name": "특가 A", "sale_price": 89_000},
]


def active_item() -> Item:
    return Item(
        category="첫방문 이벤트",
        name="피코토닝 1회",
        list_price=52_000,
        sale_price=25_000,
        first_seen="2026-11-13",
        last_seen="2026-11-14",
    )


def test_payload_groups_points_and_marks_ended_items():
    payload = build_payload(ROWS, [active_item()], "https://example.com/", "https://github.com/u/r")

    assert payload["days"] == 2
    assert payload["first_date"] == "2026-11-13"
    assert payload["last_date"] == "2026-11-14"
    assert payload["active_count"] == 1
    assert payload["repo_url"] == "https://github.com/u/r"

    items = {entry["name"]: entry for entry in payload["items"]}
    assert items["피코토닝 1회"]["active"] is True
    assert items["피코토닝 1회"]["points"] == [["2026-11-13", 29_000], ["2026-11-14", 25_000]]
    assert items["피코토닝 1회"]["list_price"] == 52_000
    assert items["피코토닝 1회"]["all_time_low"] == 25_000
    assert items["피코토닝 1회"]["all_time_high"] == 29_000
    assert items["피코토닝 1회"]["avg_price"] == 27_000
    assert items["피코토닝 1회"]["discount_rate"] == 52  # (1 - 25000/52000) * 100 = 51.92 -> 52%

    # 이번 스냅샷에 없으면 종료된 항목으로 남는다.
    assert items["특가 A"]["active"] is False
    assert "list_price" not in items["특가 A"]
    assert items["특가 A"]["all_time_low"] == 89_000


def test_payload_includes_event_period_when_known():
    payload = build_payload(
        ROWS, [active_item()], "https://example.com/", event_period=("2026-11-01", "2026-11-30"),
    )
    assert payload["event_period"] == {"start": "2026-11-01", "end": "2026-11-30"}

    # 기간을 모르면 키는 있지만 null이다(프런트에서 배너를 숨긴다).
    assert build_payload(ROWS, [active_item()], "https://example.com/")["event_period"] is None


def test_recent_changes_compare_last_two_dates():
    payload = build_payload(ROWS, [active_item()], "https://example.com/")
    recent = payload["recent"]

    assert recent["baseline"] is False
    assert recent["prev_date"] == "2026-11-13"
    assert recent["date"] == "2026-11-14"
    assert recent["counts"] == {"decrease": 1, "increase": 0, "new": 1, "returned": 0, "removed": 0}
    assert recent["total"] == 2

    by_name = {change["name"]: change for change in recent["items"]}
    assert by_name["피코토닝 1회"]["kind"] == "decrease"
    assert by_name["피코토닝 1회"]["prev"] == 29_000
    assert by_name["피코토닝 1회"]["price"] == 25_000
    assert by_name["피코토닝 1회"]["delta"] == -4_000
    assert by_name["특가 A"]["kind"] == "new"
    assert by_name["특가 A"]["prev"] is None
    assert by_name["특가 A"]["price"] == 89_000

    # index는 정렬된 items 목록에서의 위치와 같아야 클릭 시 그래프가 열린다.
    for change in recent["items"]:
        assert payload["items"][change["index"]]["name"] == change["name"]


def test_recent_changes_baseline_with_single_date():
    rows = [ROWS[0]]
    payload = build_payload(rows, [active_item()], "https://example.com/")
    recent = payload["recent"]

    assert recent["baseline"] is True
    assert recent["date"] == "2026-11-13"
    assert recent["prev_date"] is None
    assert recent["total"] == 0
    assert recent["items"] == []


def test_recent_changes_empty_when_prices_unchanged():
    rows = [
        {"date": "2026-11-13", "category": "이벤트", "name": "A", "sale_price": 10_000},
        {"date": "2026-11-14", "category": "이벤트", "name": "A", "sale_price": 10_000},
    ]
    payload = build_payload(rows, [], "https://example.com/")
    recent = payload["recent"]

    assert recent["baseline"] is False
    assert recent["total"] == 0
    assert recent["counts"] == {"decrease": 0, "increase": 0, "new": 0, "returned": 0, "removed": 0}
    assert recent["items"] == []


def test_empty_history_payload():
    payload = build_payload([], [], "https://example.com/")
    assert payload["items"] == []
    assert payload["days"] == 0
    assert payload["last_date"] is None
    assert payload["recent"]["baseline"] is True
    assert payload["recent"]["items"] == []
    assert payload["monthly"] == []


def history_row(date: str, name: str, price: int, category: str = "이벤트") -> PriceRow:
    return {"date": date, "category": category, "name": name, "sale_price": price}


def test_returned_uses_last_price_before_absence_and_keeps_item_index():
    rows = [
        history_row("2026-10-29", "A", 12_000), history_row("2026-10-29", "B", 10_000),
        history_row("2026-10-30", "A", 11_000), history_row("2026-10-30", "B", 10_000),
        history_row("2026-10-31", "B", 10_000),
        history_row("2026-11-03", "B", 10_000), history_row("2026-11-03", "A", 8_000),
    ]
    payload = build_payload(rows, [Item("이벤트", "A", None, 8_000)], "")
    recent = payload["recent"]
    assert recent["counts"]["returned"] == 1
    assert recent["counts"]["new"] == recent["counts"]["decrease"] == 0
    change = recent["items"][0]
    assert change["kind"] == "returned"
    assert change["prev"] == 11_000
    assert change["delta"] == -3_000
    assert payload["items"][change["index"]]["returned"] == change
    assert payload["monthly"][0]["counts"]["returned"] == 1
    assert payload["monthly"][0]["top_decreases"] == []


def test_missing_collection_days_are_not_an_event_end():
    payload = build_payload([
        history_row("2026-10-31", "A", 12_000),
        history_row("2026-11-03", "A", 10_000),
    ], [], "")
    assert payload["recent"]["items"][0]["kind"] == "decrease"
    assert "returned" not in payload["items"][0]
    november, october = payload["monthly"]
    assert november["counts"]["decrease"] == 1  # 월 경계의 직전 수집가와 비교
    assert november["days"] == 1
    assert november["includes_baseline"] is False
    assert october["includes_baseline"] is True
    assert october["total"] == 0


def test_monthly_counts_occurrences_and_ranks_unique_items_by_largest_drop():
    rows: list[PriceRow] = []
    for number in range(7):
        rows.extend([
            history_row("2026-12-31", str(number), 100_000),
            history_row("2027-01-01", str(number), 100_000 - (number + 1) * 1_000),
            history_row("2027-01-02", str(number), 100_000 - (number + 1) * 2_000),
        ])
    rows.append(history_row("2027-01-02", "신규", 5_000))
    rows.append(history_row("2027-01-03", "신규", 6_000))  # 나머지 7건 종료
    payload = build_payload(list(reversed(rows)), [], "")  # 입력 순서와 무관
    january, december = payload["monthly"]
    assert january["month"] == "2027-01"
    assert january["counts"] == {"decrease": 14, "increase": 1, "new": 1, "returned": 0, "removed": 7}
    assert january["total"] == 23
    assert december["total"] == 0
    assert [e["name"] for e in january["top_decreases"]] == ["6", "5", "4", "3", "2"]
    for event in january["top_decreases"]:
        assert event["date"] == "2027-01-02"  # 동일 인하폭이면 가장 최근 기록
        assert payload["items"][event["index"]]["name"] == event["name"]

    # 배지 필터용 전체 변동: 건수 합이 total과 같고, 그 달의 항목만 담는다.
    assert len(january["events"]) == january["total"] == 23
    assert all(event["date"].startswith("2027-01") for event in january["events"])
    assert sum(1 for event in january["events"] if event["kind"] == "removed") == 7
    assert sum(1 for event in january["events"] if event["kind"] == "decrease") == 14
    # 종류별로 묶여 있고, 같은 종류 안에서는 최근 날짜가 먼저 온다.
    for kind in ("decrease", "increase", "new", "returned", "removed"):
        kind_dates = [event["date"] for event in january["events"] if event["kind"] == kind]
        assert kind_dates == sorted(kind_dates, reverse=True)


def test_repeated_return_uses_most_recent_price_and_unchanged_return_counts():
    rows = [history_row(date, "유지", 1_000) for date in [
        "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
    ]]
    rows.extend([
        history_row("2026-11-01", "A", 10_000),
        history_row("2026-11-03", "A", 12_000),
        history_row("2026-11-05", "A", 12_000),
    ])
    payload = build_payload(rows, [], "")
    assert payload["monthly"][0]["counts"]["returned"] == 2
    returns = [event for event in payload["monthly"][0]["events"] if event["kind"] == "returned"]
    assert [event["date"] for event in returns] == ["2026-11-05", "2026-11-03"]
    assert all(payload["items"][event["index"]]["name"] == "A" for event in returns)
    assert payload["recent"]["items"][0]["delta"] == 0
    assert payload["recent"]["items"][0]["prev"] == 12_000


def test_render_leaves_only_the_skeleton():
    payload = build_payload(
        [
            {
                "date": "2026-11-13",
                "category": "이벤트",
                "name": "</script><script>alert(1)</script>",
                "sale_price": 1_000,
            }
        ],
        [],
        "https://example.com/",
    )
    html = render_html(payload)
    assert "가격 추이" in html
    assert "__PAYLOAD__" not in html
    assert "__ASSET_VERSION__" not in html
    assert "__DATA_VERSION__" not in html
    # 데이터는 HTML이 아니라 assets/data.js로 나간다.
    assert "</script><script>alert(1)" not in html


def test_data_js_escapes_script_close(tmp_path: Path):
    rows = [
        {
            "date": "2026-11-13",
            "category": "이벤트",
            "name": "</script><script>alert(1)</script>",
            "sale_price": 1_000,
        }
    ]
    write_graph(tmp_path / "index.html", rows, [], "https://example.com/")
    data_js = (tmp_path / "assets" / "data.js").read_text(encoding="utf-8")
    assert "</script><script>alert(1)" not in data_js
    assert "<\\/script>" in data_js
    assert "window.__PRICE_DATA__=" in data_js


def test_render_inlines_payload_for_legacy_template(tmp_path: Path):
    template = tmp_path / "index.html"
    template.write_text(
        '<script type="application/json" id="payload">__PAYLOAD__</script>',
        encoding="utf-8",
    )
    html = render_html({"items": [{"name": "</script>"}]}, template)
    assert "__PAYLOAD__" not in html
    assert "<\\/script>" in html


def test_write_graph_creates_file(tmp_path: Path):
    path = tmp_path / "index.html"
    write_graph(path, ROWS, [active_item()], "https://example.com/")
    html = path.read_text(encoding="utf-8")
    data_js = (tmp_path / "assets" / "data.js").read_text(encoding="utf-8")

    assert "history.csv" in html
    assert "CHANGES.md" in html
    assert "최근 변동" in html
    assert "변동만" in html
    assert "피코토닝 1회" in data_js
    assert "빼빼로데이" in data_js
    assert '"recent"' in data_js
    assert "window.__PRICE_DATA__=" in data_js
    # 홈 화면 추가(PWA)에 필요한 메타데이터와 설치 버튼.
    assert '<link rel="manifest" href="manifest.webmanifest">' in html
    assert 'href="icons/apple-touch-icon.png"' in html
    assert 'id="installBtn"' in html


def test_write_graph_splits_static_assets(tmp_path: Path):
    path = tmp_path / "index.html"
    write_graph(path, ROWS, [active_item()], "https://example.com/")

    html = path.read_text(encoding="utf-8")
    css = (tmp_path / "assets" / "style.css").read_text(encoding="utf-8")
    js = (tmp_path / "assets" / "app.js").read_text(encoding="utf-8")
    data_js = (tmp_path / "assets" / "data.js").read_text(encoding="utf-8")

    # HTML은 골격만 남고, 스타일·스크립트·데이터는 외부 파일로 분리된다.
    assert "<style>" not in html
    assert "const DATA = __PAYLOAD__" not in html
    assert "__ASSET_VERSION__" not in html
    assert "__DATA_VERSION__" not in html
    assert 'id="summaryHub"' in html
    assert 'id="filterDrawer"' in html
    assert ":root {" in css
    assert "30일 최저" in js
    assert "window.__PRICE_DATA__" in js
    assert "window.__PRICE_DATA__=" in data_js

    # 자산 주소에는 내용 해시가 붙어 CSS·JS·데이터가 바뀔 때만 새로 받는다.
    version = asset_version(load_assets())
    assert f'href="assets/style.css?v={version}"' in html
    assert f'src="assets/app.js?v={version}"' in html
    assert 'src="assets/data.js?v=' in html
    # 데이터가 app.js보다 먼저 실행되어야 window.__PRICE_DATA__가 준비된다.
    assert html.index("assets/data.js") < html.index("assets/app.js")


def test_render_service_worker_fills_placeholders():
    sw = render_service_worker()
    # 남은 자리표시자가 있으면 브라우저가 캐시 이름·미리 받을 목록을 해석하지 못한다.
    assert "__CACHE_VERSION__" not in sw
    assert "__PRECACHE__" not in sw
    assert 'const CACHE = "price-tracker-' in sw
    assert "self.addEventListener(\"fetch\"" in sw
    for url in (
        "./index.html",
        "./manifest.webmanifest",
        "./assets/style.css?v=",
        "./assets/app.js?v=",
        "./assets/vendor/chart.umd.min.js?v=",
        "./assets/data.js?v=",
        "./icons/icon-192.png",
        "./icons/icon-maskable-512.png",
        "./icons/apple-touch-icon.png",
    ):
        assert url in sw


def test_render_service_worker_version_follows_content():
    first = render_service_worker(version="aaaa", data_version="1111")
    same = render_service_worker(version="aaaa", data_version="1111")
    changed = render_service_worker(version="aaaa", data_version="2222")
    assert first == same
    assert first != changed
    assert '"./assets/data.js?v=1111"' in first


def test_write_graph_writes_service_worker(tmp_path: Path):
    path = tmp_path / "index.html"
    write_graph(path, ROWS, [active_item()], "https://example.com/")

    sw = (tmp_path / "sw.js").read_text(encoding="utf-8")
    assert "__CACHE_VERSION__" not in sw
    assert "price-tracker-" in sw


def test_pwa_manifest_and_icons_exist():
    manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["start_url"] == "./"
    assert manifest["scope"] == "./"
    assert manifest["display"] == "standalone"
    assert manifest["lang"] == "ko"

    entries = {(icon["sizes"], icon["purpose"]) for icon in manifest["icons"]}
    assert ("192x192", "any") in entries
    assert ("512x512", "any") in entries
    assert ("512x512", "maskable") in entries
    for icon in manifest["icons"]:
        assert (ROOT / icon["src"]).is_file(), icon["src"]
    assert (ROOT / "icons" / "apple-touch-icon.png").is_file()


def test_asset_version_tracks_content():
    base = load_assets()
    assert asset_version(base) == asset_version(dict(base))
    changed = dict(base)
    changed["app.js"] = base["app.js"] + "\n"
    assert asset_version(changed) != asset_version(base)


def test_write_assets_keeps_unchanged_file(tmp_path: Path):
    assets = load_assets()
    write_assets(tmp_path / "assets", assets)
    target = tmp_path / "assets" / "app.js"
    before = target.stat().st_ino
    write_assets(tmp_path / "assets", assets)
    # 내용이 같으면 다시 쓰지 않는다(원자적 교체는 inode를 바꾼다).
    assert target.stat().st_ino == before
    assert target.read_text(encoding="utf-8") == assets["app.js"]

