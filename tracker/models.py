"""가격 항목 모델."""

from __future__ import annotations

from dataclasses import dataclass


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

    def to_json(self) -> dict:
        return {
            "category": self.category,
            "name": self.name,
            "list_price": self.list_price,
            "sale_price": self.sale_price,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
        }
