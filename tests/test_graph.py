"""그래프 페이지 생성 테스트."""

from __future__ import annotations

from pathlib import Path

from tracker.graph import build_payload, render_html, write_graph
from tracker.models import Item

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

    # 이번 스냅샷에 없으면 종료된 항목으로 남는다.
    assert items["특가 A"]["active"] is False
    assert "list_price" not in items["특가 A"]


def test_recent_changes_compare_last_two_dates():
    payload = build_payload(ROWS, [active_item()], "https://example.com/")
    recent = payload["recent"]

    assert recent["baseline"] is False
    assert recent["prev_date"] == "2026-11-13"
    assert recent["date"] == "2026-11-14"
    assert recent["counts"] == {"decrease": 1, "increase": 0, "new": 1, "removed": 0}
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
    assert recent["counts"] == {"decrease": 0, "increase": 0, "new": 0, "removed": 0}
    assert recent["items"] == []


def test_empty_history_payload():
    payload = build_payload([], [], "https://example.com/")
    assert payload["items"] == []
    assert payload["days"] == 0
    assert payload["last_date"] is None
    assert payload["recent"]["baseline"] is True
    assert payload["recent"]["items"] == []


def test_render_embeds_payload_and_escapes_script_close():
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
    assert "</script><script>alert(1)" not in html
    assert "<\\/script>" in html
    assert "__PAYLOAD__" not in html


def test_write_graph_creates_file(tmp_path: Path):
    path = tmp_path / "index.html"
    write_graph(path, ROWS, [active_item()], "https://example.com/")
    html = path.read_text(encoding="utf-8")
    assert "피코토닝 1회" in html
    assert "빼빼로데이" in html
    assert "history.csv" in html
    assert "CHANGES.md" in html
    assert "최근 변동" in html
    assert "변동만" in html
    assert "30일 최저" in html
    assert '"recent"' in html
