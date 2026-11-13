"""실행 진입점: 수집 → 비교 → 기록 → 그래프 생성."""

from __future__ import annotations

import argparse
import logging
import math
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .compare import ChangeSet, detect_changes
from .config import Config, ConfigError, load_config
from .graph import write_graph
from .history import HistoryError, load_history, record_snapshot
from .models import Item
from .prices import PricesError, load_prices, save_prices
from .report import build_entry, set_date_entry
from .scrape import (
    ScrapeError,
    fetch_html,
    filter_items,
    matches_exclude,
    parse_items,
)
from .util import format_won, now_kst, today_str

log = logging.getLogger("tracker")


class DataError(Exception):
    """수집 결과를 신뢰할 수 없어 실행을 중단할 때 발생한다."""


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


def validate_snapshot(items: list[Item], previous: dict[tuple[str, str], Item] | None, config: Config) -> None:
    """추출 건수가 0이거나 급감하면 데이터를 덮어쓰지 않고 실패시킨다."""
    if not items:
        raise DataError(
            "페이지에서 시술을 하나도 찾지 못했습니다. 페이지 구조가 바뀌었거나 접근이 차단됐을 수 있습니다. "
            "prices.json은 그대로 두었습니다."
        )

    if not previous:
        return

    previous_count = len(previous)
    minimum = max(1, math.ceil(previous_count * config.min_items_ratio))
    if len(items) < minimum:
        raise DataError(
            f"수집 건수가 {previous_count}건에서 {len(items)}건으로 급감했습니다 "
            f"(허용 하한 {minimum}건). 페이지 구조 변경을 확인하세요. prices.json은 그대로 두었습니다."
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


def _changes_line(changes: ChangeSet) -> str:
    counts = changes.summary_counts()
    return (
        f"가격 인하 {counts['decrease']}건 · 가격 인상 {counts['increase']}건 · "
        f"신규 {counts['new']}건 · 종료 {counts['removed']}건"
    )


def _print_items(items: list[Item]) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
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

    if args.offline_html:
        try:
            html = Path(args.offline_html).read_text(encoding="utf-8")
        except OSError as exc:
            raise DataError(f"HTML 파일을 읽지 못했습니다: {args.offline_html} ({exc})") from exc
        log.info("저장된 HTML을 사용합니다: %s", args.offline_html)
    else:
        html = fetch_html(config)

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
    if previous is not None:
        eligible_previous = {
            key: item for key, item in previous.items()
            if not matches_exclude(item.category, item.name, config.exclude_keywords)
        }
        validate_snapshot(items, eligible_previous, config)

    history_rows = load_history(paths.history)
    same_day = any(row["date"] == date for row in history_rows)

    changes = detect_changes(list(previous.values()) if previous else None, items)
    if same_day:
        prior_dates = [row["date"] for row in history_rows if row["date"] < date]
        if prior_dates:
            prior_date = max(prior_dates)
            prior_items = [
                Item(row["category"], row["name"], None, row["sale_price"])
                for row in history_rows if row["date"] == prior_date
            ]
            changes = detect_changes(prior_items, items)
        else:
            changes = ChangeSet()
    if config.exclude_keywords:
        # 제외 설정을 바꿨을 때 기존 항목이 '종료'로 잘못 기록되지 않게 한다.
        changes.removed = [
            change
            for change in changes.removed
            if not matches_exclude(change.category, change.name, config.exclude_keywords)
        ]

    log.info("기록 날짜: %s", date)
    if first_run:
        log.info("첫 실행입니다. 변동 요약 없이 기준 데이터만 저장합니다.")
    else:
        log.info("변동: %s", _changes_line(changes))

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
