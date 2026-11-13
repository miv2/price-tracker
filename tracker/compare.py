"""직전 스냅샷과 현재 결과를 비교해 변동을 가려낸다."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Literal

from .models import Item

ChangeKind = Literal["decrease", "increase", "new", "removed"]


@dataclass(frozen=True)
class Change:
    kind: ChangeKind
    category: str
    name: str
    old_price: int | None
    new_price: int | None

    @property
    def key(self) -> tuple[str, str]:
        return (self.category, self.name)

    @property
    def delta(self) -> int | None:
        if self.old_price is None or self.new_price is None:
            return None
        return self.new_price - self.old_price


@dataclass
class ChangeSet:
    decreases: list[Change] = field(default_factory=list)
    increases: list[Change] = field(default_factory=list)
    new: list[Change] = field(default_factory=list)
    removed: list[Change] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.decreases) + len(self.increases) + len(self.new) + len(self.removed)

    @property
    def is_empty(self) -> bool:
        return self.total == 0

    def summary_counts(self) -> dict[str, int]:
        return {
            "decrease": len(self.decreases),
            "increase": len(self.increases),
            "new": len(self.new),
            "removed": len(self.removed),
        }


def _sort_key(change: Change) -> tuple[str, str]:
    return (change.category, change.name)


def detect_changes(previous: Iterable[Item] | None, current: Iterable[Item]) -> ChangeSet:
    """할인가 비교로 인하·인상·신규·종료를 판정한다.

    previous가 None이면 첫 실행이므로 비교하지 않고 빈 ChangeSet을 돌려준다.
    """
    if previous is None:
        return ChangeSet()

    before = {item.key: item for item in previous}
    after = {item.key: item for item in current}
    changes = ChangeSet()

    for key, item in after.items():
        old = before.get(key)
        if old is None:
            changes.new.append(
                Change(
                    kind="new",
                    category=item.category,
                    name=item.name,
                    old_price=None,
                    new_price=item.sale_price,
                )
            )
        elif item.sale_price < old.sale_price:
            changes.decreases.append(
                Change(
                    kind="decrease",
                    category=item.category,
                    name=item.name,
                    old_price=old.sale_price,
                    new_price=item.sale_price,
                )
            )
        elif item.sale_price > old.sale_price:
            changes.increases.append(
                Change(
                    kind="increase",
                    category=item.category,
                    name=item.name,
                    old_price=old.sale_price,
                    new_price=item.sale_price,
                )
            )

    for key, item in before.items():
        if key not in after:
            changes.removed.append(
                Change(
                    kind="removed",
                    category=item.category,
                    name=item.name,
                    old_price=item.sale_price,
                    new_price=None,
                )
            )

    changes.decreases.sort(key=_sort_key)
    changes.increases.sort(key=_sort_key)
    changes.new.sort(key=_sort_key)
    changes.removed.sort(key=_sort_key)
    return changes
