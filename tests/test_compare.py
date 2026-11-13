"""변동 판정 테스트."""

from __future__ import annotations

from tracker.compare import detect_changes
from tracker.models import Item


def item(category: str, name: str, sale: int, list_price: int | None = None) -> Item:
    return Item(category=category, name=name, list_price=list_price, sale_price=sale)


def test_first_run_has_no_changes():
    changes = detect_changes(None, [item("이벤트", "피코토닝", 29_000)])
    assert changes.is_empty
    assert changes.total == 0


def test_detects_all_four_change_types():
    previous = [
        item("첫방문 이벤트", "피코토닝", 29_000),
        item("첫방문 이벤트", "보톡스", 10_000),
        item("빼빼로데이", "슬림 페이스 컷", 89_000),
    ]
    current = [
        item("첫방문 이벤트", "피코토닝", 25_000),  # 인하
        item("첫방문 이벤트", "보톡스", 12_000),  # 인상
        item("쁘띠 시술", "슈링크 300샷", 99_000),  # 신규
    ]
    changes = detect_changes(previous, current)

    assert [c.kind for c in changes.decreases] == ["decrease"]
    assert changes.decreases[0].old_price == 29_000
    assert changes.decreases[0].new_price == 25_000
    assert changes.decreases[0].delta == -4_000

    assert [c.kind for c in changes.increases] == ["increase"]
    assert changes.increases[0].delta == 2_000

    assert [c.kind for c in changes.new] == ["new"]
    assert changes.new[0].name == "슈링크 300샷"

    assert [c.kind for c in changes.removed] == ["removed"]
    assert changes.removed[0].name == "슬림 페이스 컷"
    assert changes.removed[0].old_price == 89_000
    assert changes.removed[0].new_price is None
    assert changes.total == 4


def test_ignores_list_price_change_when_sale_price_is_same():
    previous = [item("이벤트", "피코토닝", 29_000, list_price=52_000)]
    current = [item("이벤트", "피코토닝", 29_000, list_price=60_000)]
    assert detect_changes(previous, current).is_empty


def test_same_key_in_different_categories_is_separate():
    previous = [item("첫방문 이벤트", "피코토닝", 29_000)]
    current = [
        item("첫방문 이벤트", "피코토닝", 29_000),
        item("쁘띠 시술", "피코토닝", 39_000),
    ]
    changes = detect_changes(previous, current)
    assert len(changes.new) == 1
    assert changes.new[0].category == "쁘띠 시술"
    assert changes.removed == []


def test_changes_are_sorted_by_category_and_name():
    previous: list[Item] = []
    current = [
        item("다", "2", 1_000),
        item("가", "2", 1_000),
        item("가", "1", 1_000),
    ]
    changes = detect_changes(previous, current)
    assert [(c.category, c.name) for c in changes.new] == [
        ("가", "1"),
        ("가", "2"),
        ("다", "2"),
    ]


def test_zero_and_absent_previous_items():
    previous = [item("이벤트", "A", 1_000)]
    current = [item("이벤트", "A", 1_000), item("이벤트", "B", 2_000)]
    changes = detect_changes(previous, current)
    assert changes.decreases == []
    assert changes.increases == []
    assert len(changes.new) == 1
