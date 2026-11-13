"""이벤트 페이지 요청과 가격 파싱.

실제 페이지 구조(2026-11-13 확인):

    <div class="prd_list">
      ...
      <ul class="price_list">
        <li class="price_box">
          <p class="prd_text">첫방문 이벤트</p>            <!-- 카테고리 -->
          <p class="origin"><span class="num">52,000</span>원</p>
          <p class="discount"><span class="num">29,000</span>원</p>
          <p class="prd_info">첫방문고객) 피코토닝 1회 체험가</p>  <!-- 시술명 -->
        </li>
      </ul>
    </div>

가격은 이미지가 아니라 텍스트로 내려오므로 OCR 없이 HTML 파싱만으로 수집한다.
같은 항목이 슬라이드에 두 번씩 들어 있어 (카테고리, 시술명) 기준으로 중복을 제거한다.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import requests
from bs4 import BeautifulSoup

from .config import Config
from .models import Item

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

SELECTOR_BOX = ".prd_list li.price_box"
SELECTOR_CATEGORY = "p.prd_text"
SELECTOR_NAME = "p.prd_info"
SELECTOR_LIST_PRICE = "p.origin .num"
SELECTOR_SALE_PRICE = "p.discount .num"

_PRICE_RE = re.compile(r"[\d,]+")
_WS_RE = re.compile(r"\s+")


class ScrapeError(Exception):
    """페이지 요청 또는 파싱에 실패했을 때 발생한다."""


@dataclass
class ParseResult:
    """파싱 결과와 진단 정보."""

    items: list[Item] = field(default_factory=list)
    boxes: int = 0
    duplicates: int = 0
    skipped: int = 0
    conflicts: list[tuple[str, str]] = field(default_factory=list)

    @property
    def unique_count(self) -> int:
        return len(self.items)


def normalize_text(value: str) -> str:
    return _WS_RE.sub(" ", value).strip()


def parse_price(value: str | None) -> int | None:
    """'1,080,000 원' 같은 문자열에서 첫 숫자를 원 단위 정수로 바꾼다."""
    if not value:
        return None
    match = _PRICE_RE.search(value)
    if not match:
        return None
    try:
        return int(match.group(0).replace(",", ""))
    except ValueError:
        return None


def fetch_html(config: Config) -> str:
    """이벤트 페이지 HTML을 가져온다. 실패하면 ScrapeError를 던진다."""

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
    }
    last_error: Exception | None = None

    for attempt in range(1, config.retries + 1):
        try:
            response = requests.get(
                config.source_url,
                headers=headers,
                timeout=config.timeout_seconds,
            )
            if response.status_code != 200:
                raise ScrapeError(
                    f"페이지 응답 코드가 {response.status_code}입니다. 접근 차단이나 점검일 수 있습니다."
                )
            encoding = response.encoding or "utf-8"
            if encoding.lower() in {"iso-8859-1", "ascii"}:
                # 서버가 charset을 생략하면 requests가 ISO-8859-1로 추정한다. 이 사이트는 UTF-8이다.
                encoding = "utf-8"
            html = response.content.decode(encoding, errors="replace")
            if not html.strip():
                raise ScrapeError("페이지 응답이 비어 있습니다.")
            log.info("페이지를 받았습니다 (%d자, %d번째 시도)", len(html), attempt)
            return html
        except (requests.RequestException, ScrapeError, UnicodeDecodeError) as exc:
            last_error = exc
            log.warning("페이지 요청 실패 (%d/%d): %s", attempt, config.retries, exc)
            if attempt < config.retries:
                time.sleep(config.retry_delay_seconds)

    raise ScrapeError(f"페이지를 가져오지 못했습니다: {last_error}") from last_error


def parse_items(html: str) -> ParseResult:
    """HTML에서 카테고리·시술명·정가·할인가를 뽑아낸다.

    할인가가 없으면 정가를 현재가로 사용한다. 가격이 전혀 없는 항목은 건너뛴다.
    """

    soup = BeautifulSoup(html, "html.parser")
    boxes = soup.select(SELECTOR_BOX)
    result = ParseResult(boxes=len(boxes))

    seen: dict[tuple[str, str], Item] = {}
    for box in boxes:
        category_node = box.select_one(SELECTOR_CATEGORY)
        name_node = box.select_one(SELECTOR_NAME)
        category = normalize_text(category_node.get_text(" ", strip=True)) if category_node else ""
        name = normalize_text(name_node.get_text(" ", strip=True)) if name_node else ""

        if not name:
            result.skipped += 1
            continue

        list_node = box.select_one(SELECTOR_LIST_PRICE)
        sale_node = box.select_one(SELECTOR_SALE_PRICE)
        list_price = parse_price(list_node.get_text(" ", strip=True) if list_node else None)
        sale_price = parse_price(sale_node.get_text(" ", strip=True) if sale_node else None)
        if sale_price is None:
            sale_price = list_price
        if sale_price is None:
            result.skipped += 1
            continue
        # 할인가만 있고 정가가 없으면 정가를 비워 둔다.
        item = Item(category=category, name=name, list_price=list_price, sale_price=sale_price)

        existing = seen.get(item.key)
        if existing is not None:
            result.duplicates += 1
            if existing.sale_price != item.sale_price or existing.list_price != item.list_price:
                if item.key not in result.conflicts:
                    result.conflicts.append(item.key)
            continue
        seen[item.key] = item

    result.items = list(seen.values())
    if result.conflicts:
        log.warning("같은 키에 서로 다른 가격이 있어 첫 값만 사용했습니다: %s", result.conflicts[:5])
    return result


def matches_exclude(
    category: str,
    name: str,
    exclude_keywords: tuple[str, ...],
) -> bool:
    """카테고리나 시술명에 제외 키워드가 들어 있는지 확인한다."""
    if not exclude_keywords:
        return False
    haystack = f"{category} {name}".casefold()
    return any(keyword.casefold() in haystack for keyword in exclude_keywords)


def filter_items(items: list[Item], exclude_keywords: tuple[str, ...]) -> tuple[list[Item], int]:
    """제외 키워드가 카테고리나 시술명에 포함된 항목을 제거한다."""
    if not exclude_keywords:
        return list(items), 0

    kept = [
        item for item in items
        if not matches_exclude(item.category, item.name, exclude_keywords)
    ]
    return kept, len(items) - len(kept)
