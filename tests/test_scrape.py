"""파서 테스트."""

from __future__ import annotations

from pathlib import Path

import pytest

from tracker.scrape import (
    filter_items,
    matches_exclude,
    parse_items,
    parse_price,
)

FIXTURE = Path(__file__).parent / "fixtures" / "sample.html"


@pytest.fixture(scope="module")
def parsed():
    return parse_items(FIXTURE.read_text(encoding="utf-8"))


def test_parses_unique_items(parsed):
    assert parsed.boxes == 4
    assert len(parsed.items) == 3
    assert parsed.duplicates == 1
    assert parsed.skipped == 0


def test_extracts_category_name_and_prices(parsed):
    items = {item.name: item for item in parsed.items}
    pico = items["첫방문고객) 피코토닝 1회 체험가"]
    assert pico.category == "첫방문 이벤트"
    assert pico.list_price == 52_000
    assert pico.sale_price == 29_000

    botox = items["[슬림 페이스 컷] 국산 턱 보툴리눔 톡신 50유닛, 침샘 50유닛"]
    assert botox.category == "🍫 빼빼로데이 한정특가"
    assert botox.sale_price == 89_000


def test_decodes_html_entities_in_category(parsed):
    categories = {item.category for item in parsed.items}
    assert "기미·잡티·홍조" in categories


def test_normalizes_whitespace(parsed):
    for item in parsed.items:
        assert item.category == item.category.strip()
        assert item.name == item.name.strip()
        assert "  " not in item.name


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("52,000", 52_000),
        ("1,080,000 원", 1_080_000),
        (" 29,000원 ", 29_000),
        ("가격 없음", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_price(raw, expected):
    assert parse_price(raw) == expected


def test_falls_back_to_list_price_when_discount_missing():
    html = """
    <div class="prd_list">
      <ul class="price_list">
        <li class="price_box">
          <p class="prd_text">한정가 이벤트</p>
          <p class="origin"><span class="num">15,000</span>원</p>
          <p class="prd_info">슈링크 100샷</p>
        </li>
      </ul>
    </div>
    """
    result = parse_items(html)
    assert len(result.items) == 1
    assert result.items[0].sale_price == 15_000


def test_skips_items_without_price_or_name():
    html = """
    <div class="prd_list">
      <ul class="price_list">
        <li class="price_box">
          <p class="prd_text">이벤트</p>
          <p class="prd_info">가격 없는 항목</p>
        </li>
        <li class="price_box">
          <p class="prd_text">이벤트</p>
          <p class="origin"><span class="num">10,000</span>원</p>
        </li>
      </ul>
    </div>
    """
    result = parse_items(html)
    assert result.items == []
    assert result.skipped == 2


def test_conflicting_duplicate_keeps_first_and_reports():
    html = """
    <div class="prd_list">
      <ul class="price_list">
        <li class="price_box">
          <p class="prd_text">이벤트</p>
          <p class="origin"><span class="num">20,000</span>원</p>
          <p class="discount"><span class="num">10,000</span>원</p>
          <p class="prd_info">같은 시술</p>
        </li>
        <li class="price_box">
          <p class="prd_text">이벤트</p>
          <p class="origin"><span class="num">20,000</span>원</p>
          <p class="discount"><span class="num">9,000</span>원</p>
          <p class="prd_info">같은 시술</p>
        </li>
      </ul>
    </div>
    """
    result = parse_items(html)
    assert len(result.items) == 1
    assert result.items[0].sale_price == 10_000
    assert result.conflicts == [("이벤트", "같은 시술")]


def test_filter_items_and_match_exclude(parsed):
    items, removed = filter_items(parsed.items, ("피코",))
    assert removed == 1
    assert all("피코" not in item.name for item in items)
    assert matches_exclude("빼빼로데이 한정특가", "아무 시술", ("빼빼로",))
    assert not matches_exclude("첫방문 이벤트", "피코토닝", ("빼빼로",))

    kept, removed = filter_items(parsed.items, ())
    assert removed == 0
    assert len(kept) == len(parsed.items)


# --- fetch_html 4xx/5xx 재시도 분리 테스트 ---


def _mock_config(**overrides):
    """테스트용 Config를 만든다."""
    from tracker.config import Config

    defaults = {
        "source_url": "https://example.com/",
        "retries": 3,
        "timeout_seconds": 5,
        "retry_delay_seconds": 0,
    }
    defaults.update(overrides)
    return Config(**defaults)


def test_fetch_html_4xx_fails_immediately_without_retry(monkeypatch):
    """4xx 오류는 재시도 없이 즉시 ScrapeError를 던진다."""
    from unittest.mock import MagicMock

    from tracker.scrape import ScrapeError, fetch_html

    call_count = 0

    def fake_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        resp = MagicMock()
        resp.status_code = 403
        return resp

    monkeypatch.setattr("tracker.scrape.requests.get", fake_get)

    config = _mock_config(retries=3)
    with pytest.raises(ScrapeError, match="403"):
        fetch_html(config)

    assert call_count == 1, "4xx는 재시도하지 않아야 한다"


def test_fetch_html_5xx_retries_then_fails(monkeypatch):
    """5xx 오류는 설정된 횟수만큼 재시도한다."""
    from unittest.mock import MagicMock

    from tracker.scrape import ScrapeError, fetch_html

    call_count = 0

    def fake_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        resp = MagicMock()
        resp.status_code = 503
        return resp

    monkeypatch.setattr("tracker.scrape.requests.get", fake_get)

    config = _mock_config(retries=3)
    with pytest.raises(ScrapeError, match="가져오지 못했습니다"):
        fetch_html(config)

    assert call_count == 3, "5xx는 retries 횟수만큼 재시도해야 한다"


def test_fetch_html_5xx_succeeds_on_retry(monkeypatch):
    """5xx 이후 재시도에서 성공하면 HTML을 돌려준다."""
    from unittest.mock import MagicMock

    from tracker.scrape import fetch_html

    call_count = 0

    def fake_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        resp = MagicMock()
        if call_count < 3:
            resp.status_code = 500
        else:
            resp.status_code = 200
            resp.encoding = "utf-8"
            resp.content = "<html><body>ok</body></html>".encode("utf-8")
        return resp

    monkeypatch.setattr("tracker.scrape.requests.get", fake_get)

    config = _mock_config(retries=3)
    html = fetch_html(config)
    assert "ok" in html
    assert call_count == 3
