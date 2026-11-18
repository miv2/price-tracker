"""수집 결과 검증과 스냅샷 구성.

파일을 읽거나 쓰지 않고 판단만 한다. 실제 저장은 main.py가 맡는다.
검증 기준을 한곳에 모아 두어 수집 파이프라인과 테스트가 같은 규칙을 쓴다.
"""

from __future__ import annotations

import math

from .config import Config
from .models import Item

MIN_VALID_PRICE = 1_000
MAX_VALID_PRICE = 50_000_000


class DataError(Exception):
    """수집 결과를 신뢰할 수 없어 실행을 중단할 때 발생한다."""


def validate_snapshot(items: list[Item], previous: dict[tuple[str, str], Item] | None, config: Config) -> None:
    """수집 건수, 가격 범위 및 전일 대비 급변동을 검증하여 이상 데이터를 차단한다."""
    if not items:
        raise DataError(
            "페이지에서 시술을 하나도 찾지 못했습니다. 페이지 구조가 바뀌었거나 접근이 차단됐을 수 있습니다. "
            "prices.json은 그대로 두었습니다."
        )

    # 1. 시술명, 카테고리 및 가격 자릿수/범위 기본 검증 (Sanity Check)
    invalid_prices: list[str] = []
    inverted_prices: list[str] = []
    empty_names: int = 0

    for item in items:
        if not item.name.strip() or not item.category.strip():
            empty_names += 1
        if item.sale_price < MIN_VALID_PRICE or item.sale_price > MAX_VALID_PRICE:
            invalid_prices.append(f"{item.category} · {item.name}: {item.sale_price:,}원")
        if item.list_price is not None and item.list_price < item.sale_price:
            inverted_prices.append(f"{item.category} · {item.name}: 정가 {item.list_price:,}원 < 할인가 {item.sale_price:,}원")

    if empty_names > 0:
        raise DataError(f"시술명 또는 카테고리가 빈 항목이 {empty_names}건 발견되었습니다. 파서를 확인하세요.")

    if invalid_prices:
        sample = ", ".join(invalid_prices[:3])
        raise DataError(
            f"유효하지 않은 가격 범위({MIN_VALID_PRICE:,}원 ~ {MAX_VALID_PRICE:,}원)의 항목이 {len(invalid_prices)}건 발견되었습니다: "
            f"{sample}. 가격 파싱 단위를 확인하세요."
        )

    if len(inverted_prices) >= 5:
        sample = ", ".join(inverted_prices[:3])
        raise DataError(
            f"정가가 할인가보다 낮은 역전 항목이 {len(inverted_prices)}건 발견되었습니다: {sample}. 파서를 확인하세요."
        )

    if not previous:
        return

    # 2. 전체 건수 급감 검증
    previous_count = len(previous)
    minimum = max(1, math.ceil(previous_count * config.min_items_ratio))
    if len(items) < minimum:
        raise DataError(
            f"수집 건수가 {previous_count}건에서 {len(items)}건으로 급감했습니다 "
            f"(허용 하한 {minimum}건). 페이지 구조 변경을 확인하세요. prices.json은 그대로 두었습니다."
        )

    # 3. 기존 동일 시술 대비 비정상 급변동 (자릿수 누락/폭등 방어)
    extreme_changes: list[str] = []
    for item in items:
        old = previous.get(item.key)
        if not old or old.sale_price <= 0:
            continue
        ratio = item.sale_price / old.sale_price
        # 5배 이상 폭등(500%) 또는 90% 이상 폭락(0.1배 이하)인 경우 자릿수 오류 의심
        if ratio >= 5.0 or ratio <= 0.1:
            extreme_changes.append(
                f"{item.category} · {item.name}: {old.sale_price:,}원 → {item.sale_price:,}원 ({ratio:.1f}x)"
            )

    if len(extreme_changes) >= 3:
        sample = ", ".join(extreme_changes[:3])
        raise DataError(
            f"전일 대비 5배 이상 급등하거나 90% 이상 폭락한 이상 항목이 {len(extreme_changes)}건 감지되었습니다: "
            f"{sample}. 가격 자릿수 파싱 오류일 수 있으므로 수집을 중단합니다."
        )


def build_snapshot(
    items: list[Item],
    previous: dict[tuple[str, str], Item] | None,
    date: str,
) -> list[Item]:
    """현재 항목에 first_seen/last_seen을 채워 새 스냅샷을 만든다."""
    snapshot: list[Item] = []
    for item in items:
        old = previous.get(item.key) if previous else None
        first_seen = (old.first_seen if old and old.first_seen else date)
        snapshot.append(
            Item(
                category=item.category,
                name=item.name,
                list_price=item.list_price,
                sale_price=item.sale_price,
                first_seen=first_seen,
                last_seen=date,
            )
        )
    return snapshot
