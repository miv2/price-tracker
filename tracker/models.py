"""가격 항목 모델."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict


class PriceRow(TypedDict):
    """history.csv의 한 행. 날짜별 할인가 기록."""

    date: str
    category: str
    name: str
    sale_price: int


@dataclass(frozen=True)
class Item:
    """페이지에서 수집한 시술 하나.

    식별 키는 ``(category, name)``이다. 같은 시술이 여러 카테고리에 노출되면
    카테고리마다 별도 항목으로 추적한다.
    """

    category: str
    name: str
    list_price: int | None
    sale_price: int
    first_seen: str | None = None
    last_seen: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.category, self.name)

    def to_json(self) -> dict[str, object]:
        return {
            "category": self.category,
            "name": self.name,
            "list_price": self.list_price,
            "sale_price": self.sale_price,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
        }


def item_from_row(row: PriceRow) -> Item:
    """history.csv의 한 행을 가격 비교용 Item으로 바꾼다.

    이력에는 목록가가 없으므로 ``list_price``는 비워 둔다.
    """
    return Item(row["category"], row["name"], None, row["sale_price"])
