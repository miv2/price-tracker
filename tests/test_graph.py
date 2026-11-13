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


def test_empty_history_payload():
    payload = build_payload([], [], "https://example.com/")
    assert payload["items"] == []
    assert payload["days"] == 0
    assert payload["last_date"] is None


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
