"""이력 기반 변동 계산 테스트."""

from __future__ import annotations

from tracker.changes import changes_for_run
from tracker.models import Item, PriceRow


def item(name: str, sale: int) -> Item:
    return Item("이벤트", name, None, sale)


def row(date: str, name: str, sale: int) -> PriceRow:
    return {
        "date": date,
        "category": "이벤트",
        "name": name,
        "sale_price": sale,
    }


def test_changes_for_run_compares_previous_snapshot():
    previous = {("이벤트", "A"): item("A", 1_000)}
    changes = changes_for_run(
        [item("A", 900)],
        previous,
        [row("2026-11-13", "A", 1_000)],
        "2026-11-14",
    )

    assert [(change.old_price, change.new_price) for change in changes.decreases] == [
        (1_000, 900)
    ]


def test_changes_for_run_same_day_uses_prior_history_date():
    previous = {("이벤트", "A"): item("A", 900)}
    changes = changes_for_run(
        [item("A", 800)],
        previous,
        [row("2026-11-13", "A", 1_000), row("2026-11-14", "A", 900)],
        "2026-11-14",
    )

    # 같은 날 재실행은 prices.json(900)이 아니라 직전 수집일(1,000)과 비교한다.
    assert [(change.old_price, change.new_price) for change in changes.decreases] == [
        (1_000, 800)
    ]


def test_changes_for_run_same_day_without_prior_date_is_empty():
    changes = changes_for_run(
        [item("A", 800)],
        None,
        [row("2026-11-14", "A", 900)],
        "2026-11-14",
    )

    assert changes.is_empty
