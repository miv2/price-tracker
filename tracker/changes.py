"""수집 이력에서 변동 이벤트와 최근·월별 요약을 계산한다.

이 모듈은 파일을 읽거나 쓰지 않는다. ``history.csv``를 읽은 결과(rows)만
받아 렌더링에 쓰는 사전(dict)을 돌려주므로, 페이지 생성(graph.py)과
분리해서 검증할 수 있다.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .compare import ChangeSet, detect_changes
from .models import Item, PriceRow, item_from_row

Payload = dict[str, Any]

# 화면에서 보여 줄 변동 종류의 순서.
KIND_ORDER = {"decrease": 0, "increase": 1, "returned": 2, "new": 3, "removed": 4}


def snapshot_dates(rows: list[PriceRow]) -> list[str]:
    """이력에 등장한 수집일을 오름차순으로 돌려준다."""
    return sorted({row["date"] for row in rows})


def changes_for_run(
    items: list[Item],
    previous: dict[tuple[str, str], Item] | None,
    history_rows: list[PriceRow],
    date: str,
) -> ChangeSet:
    """이번 실행에서 직전 스냅샷과 비교한 변동을 계산한다.

    같은 날 재실행이면 하루 안의 재수집이 '신규/종료'로 잘못 남지 않도록
    ``previous`` 대신 직전 수집일의 이력 스냅샷을 기준으로 삼는다.
    """
    last_known = {
        (row["category"], row["name"]): row["sale_price"]
        for row in history_rows if row["date"] < date
    }
    same_day = any(row["date"] == date for row in history_rows)
    if not same_day:
        return detect_changes(
            list(previous.values()) if previous else None, items, last_known,
        )

    prior_dates = [row["date"] for row in history_rows if row["date"] < date]
    if not prior_dates:
        return ChangeSet()
    prior_date = max(prior_dates)
    prior_items = [
        item_from_row(row)
        for row in history_rows if row["date"] == prior_date
    ]
    return detect_changes(prior_items, items, last_known)


def build_history_changes(rows: list[PriceRow], items: list[Payload]) -> list[Payload]:
    """수집일 사이 변동을 계산한다. 수집하지 않은 날은 종료로 해석하지 않는다."""
    snapshots: dict[str, dict[tuple[str, str], Item]] = defaultdict(dict)
    for row in rows:
        item = item_from_row(row)
        snapshots[row["date"]][item.key] = item
    index = {(entry["category"], entry["name"]): i for i, entry in enumerate(items)}
    previous: dict[tuple[str, str], Item] | None = None
    last_known: dict[tuple[str, str], int] = {}
    prev_date: str | None = None
    events: list[Payload] = []
    for date, snapshot in sorted(snapshots.items()):
        changes = detect_changes(previous.values() if previous is not None else None, snapshot.values(), last_known)
        for change in changes.decreases + changes.increases + changes.returned + changes.new + changes.removed:
            events.append({
                "index": index.get(change.key, -1),
                "date": date,
                "prev_date": prev_date,
                "category": change.category,
                "name": change.name,
                "kind": change.kind,
                "prev": change.old_price,
                "price": change.new_price,
                "delta": change.delta,
            })
        last_known.update({key: item.sale_price for key, item in snapshot.items()})
        previous = snapshot
        prev_date = date
    return events


def change_counts(events: list[Payload]) -> dict[str, int]:
    counts = dict.fromkeys(KIND_ORDER, 0)
    for event in events:
        counts[event["kind"]] += 1
    return counts


def _abs_delta(event: Payload) -> int:
    delta = event["delta"]
    return abs(delta) if delta is not None else 0


def build_recent_changes(
    rows: list[PriceRow], events: list[Payload] | None = None,
) -> Payload:
    """최근 두 수집일의 변동. 재등장은 종료 전 마지막 가격과 비교한다."""
    dates = snapshot_dates(rows)
    if events is None:
        events = build_history_changes(rows, [])
    changes = [event for event in events if dates and event["date"] == dates[-1]]
    changes.sort(
        key=lambda change: (
            KIND_ORDER[change["kind"]],
            -_abs_delta(change),
            change["category"], change["name"],
        )
    )
    return {
        "baseline": len(dates) < 2,
        "date": dates[-1] if dates else None,
        "prev_date": dates[-2] if len(dates) > 1 else None,
        "counts": change_counts(changes),
        "total": len(changes),
        "items": changes,
    }


def _sort_monthly_events(events: list[Payload]) -> list[Payload]:
    """종류 → 최근 날짜 → 변동 폭 큰 순으로 정렬한다.

    날짜 내림차순은 문자열 키를 뒤집을 수 없어, 우선순위가 낮은 정렬부터
    안정 정렬(stable sort)로 차례로 적용한다.
    """
    ordered = sorted(events, key=_abs_delta, reverse=True)
    ordered.sort(key=lambda event: event["date"], reverse=True)
    ordered.sort(key=lambda event: KIND_ORDER[event["kind"]])
    return ordered


def build_monthly_summary(rows: list[PriceRow], events: list[Payload]) -> list[Payload]:
    """월별 변동 횟수와 시술별 가장 큰 단일 인하 상위 5개를 만든다."""
    dates = snapshot_dates(rows)
    months: dict[str, list[str]] = defaultdict(list)
    monthly_events: dict[str, list[Payload]] = defaultdict(list)
    for date in dates:
        months[date[:7]].append(date)
    for event in events:
        monthly_events[event["date"][:7]].append(event)
    summaries: list[Payload] = []
    for month, month_dates in sorted(months.items(), reverse=True):
        changes = monthly_events[month]
        biggest: dict[int, Payload] = {}
        for event in changes:
            if event["kind"] != "decrease":
                continue
            old = biggest.get(event["index"])
            if old is None or event["delta"] < old["delta"] or (
                event["delta"] == old["delta"] and event["date"] > old["date"]
            ):
                biggest[event["index"]] = event
        top = sorted(biggest.values(), key=lambda event: (event["delta"], event["category"], event["name"]))[:5]
        # 배지를 눌렀을 때 그 달의 해당 항목을 모두 보여줄 수 있도록 전체 변동을 담는다.
        summaries.append({
            "month": month,
            "first_date": month_dates[0],
            "last_date": month_dates[-1],
            "days": len(month_dates),
            "includes_baseline": month_dates[0] == dates[0],
            "counts": change_counts(changes),
            "total": len(changes),
            "top_decreases": top,
            "events": _sort_monthly_events(changes),
        })
    return summaries
