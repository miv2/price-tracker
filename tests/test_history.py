"""history.csv 누적 테스트."""

from __future__ import annotations

from pathlib import Path

from tracker.history import group_by_item, load_history, record_snapshot
from tracker.models import Item


def item(category: str, name: str, sale: int) -> Item:
    return Item(category=category, name=name, list_price=sale * 2, sale_price=sale)


def test_record_snapshot_writes_rows(tmp_path: Path):
    path = tmp_path / "history.csv"
    assert record_snapshot(path, "2026-11-13", [item("이벤트", "A", 1_000)]) is True

    rows = load_history(path)
    assert rows == [
        {"date": "2026-11-13", "category": "이벤트", "name": "A", "sale_price": 1_000}
    ]
    # 엑셀 호환을 위해 BOM으로 시작한다.
    assert path.read_bytes().startswith(b"\xef\xbb\xbf")


def test_same_day_rerun_replaces_rows(tmp_path: Path):
    path = tmp_path / "history.csv"
    record_snapshot(path, "2026-11-13", [item("이벤트", "A", 1_000), item("이벤트", "B", 2_000)])
    record_snapshot(path, "2026-11-13", [item("이벤트", "A", 900)])

    rows = load_history(path)
    assert len(rows) == 1
    assert rows[0]["sale_price"] == 900


def test_history_accumulates_across_days(tmp_path: Path):
    path = tmp_path / "history.csv"
    record_snapshot(path, "2026-11-13", [item("이벤트", "A", 1_000)])
    record_snapshot(path, "2026-11-14", [item("이벤트", "A", 900)])
    record_snapshot(path, "2026-11-15", [item("이벤트", "A", 800)])

    rows = load_history(path)
    assert [row["date"] for row in rows] == ["2026-11-13", "2026-11-14", "2026-11-15"]
    assert [row["sale_price"] for row in rows] == [1_000, 900, 800]


def test_handles_commas_and_quotes_in_names(tmp_path: Path):
    path = tmp_path / "history.csv"
    record_snapshot(path, "2026-11-13", [item("이벤트", 'A, B "특가"', 1_000)])
    rows = load_history(path)
    assert rows[0]["name"] == 'A, B "특가"'


def test_unchanged_write_returns_false(tmp_path: Path):
    path = tmp_path / "history.csv"
    record_snapshot(path, "2026-11-13", [item("이벤트", "A", 1_000)])
    assert record_snapshot(path, "2026-11-13", [item("이벤트", "A", 1_000)]) is False


def test_group_by_item_sorts_and_dedupes_dates():
    rows = [
        {"date": "2026-11-14", "category": "이벤트", "name": "A", "sale_price": 900},
        {"date": "2026-11-13", "category": "이벤트", "name": "A", "sale_price": 1_000},
        {"date": "2026-11-14", "category": "이벤트", "name": "A", "sale_price": 950},
    ]
    grouped = group_by_item(rows)
    assert grouped[("이벤트", "A")] == [("2026-11-13", 1_000), ("2026-11-14", 950)]


def test_missing_history_returns_empty(tmp_path: Path):
    assert load_history(tmp_path / "nope.csv") == []
