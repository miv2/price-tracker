"""실행 진입점: 수집 → 비교 → 기록 → 그래프 생성."""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .compare import ChangeSet, detect_changes
from .config import Config, ConfigError, load_config
from .graph import write_graph
from .history import HistoryError, load_history, record_snapshot
from .models import Item, PriceRow
from .prices import PricesError, load_prices, save_prices
from .report import build_entry, set_date_entry, summary_line
from .scrape import (
    ParseResult,
    ScrapeError,
    fetch_html,
    filter_items,
    matches_exclude,
    parse_items,
)
from .snapshot import DataError, build_snapshot, validate_snapshot
from .util import format_won, now_kst, today_str

log = logging.getLogger("tracker")


@dataclass(frozen=True)
class Paths:
    root: Path
    config: Path
    prices: Path
    history: Path
    changes: Path
    index: Path

    @classmethod
    def from_root(cls, root: Path, config: Path | None = None) -> "Paths":
        root = root.resolve()
        return cls(
            root=root,
            config=config or root / "config.json",
            prices=root / "prices.json",
            history=root / "history.csv",
            changes=root / "CHANGES.md",
            index=root / "index.html",
        )


def _load_html(config: Config, offline_html: str | None) -> str:
    """네트워크 또는 저장된 HTML에서 수집 대상 문서를 가져온다."""
    if not offline_html:
        return fetch_html(config)
    try:
        html = Path(offline_html).read_text(encoding="utf-8")
    except OSError as exc:
        raise DataError(f"HTML 파일을 읽지 못했습니다: {offline_html} ({exc})") from exc
    log.info("저장된 HTML을 사용합니다: %s", offline_html)
    return html


def _collect(config: Config, html: str) -> tuple[ParseResult, list[Item]]:
    """HTML을 파싱하고 제외 키워드를 적용한 항목 목록을 만든다."""
    parsed = parse_items(html)
    log.info(
        "파싱: 가격 블록 %d개 → 고유 항목 %d개 (중복 %d개, 건너뜀 %d개)",
        parsed.boxes,
        len(parsed.items),
        parsed.duplicates,
        parsed.skipped,
    )
    items, excluded = filter_items(parsed.items, config.exclude_keywords)
    if excluded:
        log.info("제외 키워드로 %d개 항목을 뺐습니다.", excluded)
    return parsed, items


def _validate_against_previous(
    items: list[Item],
    previous: dict[tuple[str, str], Item] | None,
    config: Config,
) -> None:
    """직전 스냅샷과 비교해 건수 급감·가격 급변동을 검증한다."""
    if previous is None:
        return
    eligible = {
        key: item for key, item in previous.items()
        if not matches_exclude(item.category, item.name, config.exclude_keywords)
    }
    validate_snapshot(items, eligible, config)


def _changes_for_run(
    items: list[Item],
    previous: dict[tuple[str, str], Item] | None,
    history_rows: list[PriceRow],
    date: str,
    exclude_keywords: tuple[str, ...],
) -> ChangeSet:
    """이번 실행의 변동을 계산한다.

    같은 날 재실행이면 직전 수집일을 기준으로 삼아, 하루 안의 재수집이
    '신규/종료'로 잘못 남지 않게 한다.
    """
    last_known = {
        (row["category"], row["name"]): row["sale_price"]
        for row in history_rows if row["date"] < date
    }

    same_day = any(row["date"] == date for row in history_rows)
    if not same_day:
        changes = detect_changes(
            list(previous.values()) if previous else None, items, last_known,
        )
    else:
        prior_dates = [row["date"] for row in history_rows if row["date"] < date]
        if prior_dates:
            prior_date = max(prior_dates)
            prior_items = [
                Item(row["category"], row["name"], None, row["sale_price"])
                for row in history_rows if row["date"] == prior_date
            ]
            changes = detect_changes(prior_items, items, last_known)
        else:
            changes = ChangeSet()

    if exclude_keywords:
        # 제외 설정을 바꿨을 때 기존 항목이 '종료'로 잘못 기록되지 않게 한다.
        changes.removed = [
            change for change in changes.removed
            if not matches_exclude(change.category, change.name, exclude_keywords)
        ]
    return changes


def _print_items(items: list[Item]) -> None:
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except OSError:
            pass
    print("카테고리\t시술명\t정가\t할인가")
    for item in sorted(items, key=lambda i: i.key):
        print(
            f"{item.category}\t{item.name}\t"
            f"{format_won(item.list_price)}\t{format_won(item.sale_price)}"
        )


def _parse_date_arg(value: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise argparse.ArgumentTypeError("날짜는 YYYY-MM-DD 형식이어야 합니다.") from exc
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m tracker",
        description="유앤아이의원 수원점 이벤트 가격을 수집하고 변동을 기록합니다.",
    )
    parser.add_argument("--root", default=".", help="데이터 파일이 있는 폴더 (기본: 현재 폴더)")
    parser.add_argument("--config", default=None, help="설정 파일 경로 (기본: <root>/config.json)")
    parser.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 수집·비교 결과만 확인")
    parser.add_argument(
        "--offline-html",
        default=None,
        help="네트워크 대신 저장한 HTML 파일을 파싱 (개발·테스트용)",
    )
    parser.add_argument(
        "--list-items",
        action="store_true",
        help="수집한 시술과 가격을 표로 출력하고 종료 (파일 쓰지 않음)",
    )
    parser.add_argument(
        "--today",
        type=_parse_date_arg,
        default=None,
        help="기록 날짜를 강제로 지정 (YYYY-MM-DD, 테스트용)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="자세한 로그 출력")
    return parser


def run(args: argparse.Namespace) -> int:
    paths = Paths.from_root(Path(args.root), Path(args.config) if args.config else None)
    config = load_config(paths.config)
    date = args.today or today_str()

    html = _load_html(config, args.offline_html)
    parsed, items = _collect(config, html)

    if args.list_items:
        _print_items(items)
        log.info("총 %d개 항목을 출력했습니다.", len(items))
        return 0

    validate_snapshot(parsed.items, None, config)
    if not items:
        raise DataError(
            "제외 키워드를 적용한 뒤 남은 항목이 없습니다. config.json의 exclude_keywords를 확인하세요."
        )

    previous = load_prices(paths.prices)
    first_run = previous is None
    _validate_against_previous(items, previous, config)

    history_rows = load_history(paths.history)
    changes = _changes_for_run(
        items, previous, history_rows, date, config.exclude_keywords,
    )

    log.info("기록 날짜: %s", date)
    if first_run:
        log.info("첫 실행입니다. 변동 요약 없이 기준 데이터만 저장합니다.")
    else:
        log.info("변동: %s", summary_line(changes))

    if args.dry_run:
        log.info("--dry-run: 파일을 쓰지 않고 종료합니다.")
        return 0

    snapshot = build_snapshot(items, previous, date)
    save_prices(
        paths.prices,
        snapshot,
        updated_at=now_kst().isoformat(timespec="seconds"),
        source_url=config.source_url,
    )

    history_changed = record_snapshot(paths.history, date, snapshot)
    entry = (
        build_entry(changes, date, bulk_threshold=config.bulk_change_threshold)
        if not first_run and not changes.is_empty else None
    )
    set_date_entry(paths.changes, date, entry)
    if entry is not None:
        log.info("CHANGES.md의 %s 변동 요약을 갱신했습니다.", date)

    write_graph(
        paths.index,
        load_history(paths.history),
        snapshot,
        config.source_url,
        repo_url=config.repo_url,
    )

    log.info(
        "완료: %d개 항목 저장 · 이력 %s · 그래프 갱신",
        len(snapshot),
        "변경됨" if history_changed else "변동 없음",
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )
    try:
        return run(args)
    except (ConfigError, ScrapeError, PricesError, HistoryError, DataError) as exc:
        log.error("%s", exc)
        return 1
    except Exception:  # noqa: BLE001 - Actions에서 실패로 표시되도록 마지막 방어선
        log.exception("예상하지 못한 오류로 중단했습니다.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
