"""CHANGES.md 생성 테스트."""

from __future__ import annotations

from pathlib import Path

from tracker.compare import detect_changes
from tracker.models import Item
from tracker.report import HEADER, build_entry, ensure_changes_file, prepend_entry


def item(category: str, name: str, sale: int) -> Item:
    return Item(category=category, name=name, list_price=None, sale_price=sale)


def make_changes(previous: list[Item], current: list[Item]):
    return detect_changes(previous, current)


def test_entry_contains_price_change_and_new_and_removed():
    changes = make_changes(
        [item("첫방문 이벤트", "피코토닝 1회", 29_000), item("빼빼로데이", "특가 A", 50_000)],
        [item("첫방문 이벤트", "피코토닝 1회", 25_000), item("쁘띠 시술", "슈링크 300샷", 99_000)],
    )
    entry = build_entry(changes, "2026-11-14", bulk_threshold=10)

    assert entry.startswith("## 2026-11-14 (토)")
    assert "가격 인하 1건" in entry
    assert "29,000원 → 25,000원 (-4,000원)" in entry
    assert "신규: " in entry and "슈링크 300샷" in entry and "99,000원" in entry
    assert "종료: " in entry and "특가 A" in entry
    assert "<details>" not in entry


def test_bulk_new_and_removed_are_collapsed():
    previous = [item("11월 이벤트", f"종료 {i}", 10_000 + i) for i in range(12)]
    current = [item("12월 이벤트", f"신규 {i}", 20_000 + i) for i in range(12)]
    changes = make_changes(previous, current)
    entry = build_entry(changes, "2026-12-01", bulk_threshold=10)

    assert "신규·종료 (묶음 요약)" in entry
    assert "신규 12건 · 종료 12건" in entry
    assert entry.count("<details>") == 1
    assert "<summary>" in entry
    # 묶음이어도 전체 목록은 details 안에 남는다.
    assert "신규: " in entry
    assert "종료: " in entry


def test_changes_only_listed_when_present():
    changes = make_changes(
        [item("이벤트", "A", 10_000)],
        [item("이벤트", "A", 9_000)],
    )
    entry = build_entry(changes, "2026-11-14")
    assert "### 가격 인하" in entry
    assert "### 가격 인상" not in entry
    assert "### 신규" not in entry
    assert "### 종료" not in entry


def test_escapes_markdown_specials_in_names():
    changes = make_changes(
        [],
        [item("이벤트*", "[특가] A_B <script> | ~취소선~", 10_000)],
    )
    entry = build_entry(changes, "2026-11-14", bulk_threshold=100)
    assert "\\*" in entry
    assert "\\[" in entry and "\\]" in entry
    assert "\\_" in entry
    assert "\\<script\\>" in entry
    assert "\\|" in entry


def test_ensure_changes_file_creates_header_once(tmp_path: Path):
    path = tmp_path / "CHANGES.md"
    ensure_changes_file(path)
    assert path.read_text(encoding="utf-8").startswith("# 가격 변동 기록")

    first = path.read_text(encoding="utf-8")
    ensure_changes_file(path)
    assert path.read_text(encoding="utf-8") == first


def test_prepend_entry_puts_newest_first(tmp_path: Path):
    path = tmp_path / "CHANGES.md"
    ensure_changes_file(path)

    old = make_changes([item("이벤트", "A", 10_000)], [item("이벤트", "A", 9_000)])
    new = make_changes([item("이벤트", "A", 9_000)], [item("이벤트", "A", 8_000)])

    prepend_entry(path, build_entry(old, "2026-11-13"))
    prepend_entry(path, build_entry(new, "2026-11-14"))

    text = path.read_text(encoding="utf-8")
    assert text.startswith("# 가격 변동 기록")
    assert text.index("## 2026-11-14") < text.index("## 2026-11-13")
    assert text.count("# 가격 변동 기록") == 1
    assert "9,000원 → 8,000원" in text


def test_header_mentions_source_and_graph():
    assert "swuni114.co.kr" in HEADER
    assert "index.html" in HEADER
