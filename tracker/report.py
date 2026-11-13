"""변동 요약을 CHANGES.md에 기록한다."""

from __future__ import annotations

import re
from pathlib import Path

from .compare import Change, ChangeSet
from .util import atomic_write_text, format_won, weekday_ko

HEADER = """# 가격 변동 기록

유앤아이의원 수원점(https://www.swuni114.co.kr/) 이벤트 가격 변동 기록입니다.
변동이 감지된 날에만 새 항목이 추가됩니다.

- 비교 기준: 할인가(VAT 별도)
- 식별 키: 카테고리 + 시술명
- 가격 추이: [index.html](index.html) (GitHub Pages)
"""

_MD_SPECIALS = re.compile(r"([\\`*_\[\]<>~|])")


def _escape(text: str) -> str:
    """시술명에 들어 있는 마크다운 특수문자를 그대로 보이게 한다."""
    return _MD_SPECIALS.sub(r"\\\1", text)


def _label(change: Change) -> str:
    return f"**{_escape(change.category)}** · {_escape(change.name)}"


def _price_change_line(change: Change) -> str:
    delta = change.delta or 0
    sign = "+" if delta > 0 else ""
    return (
        f"- {_label(change)}: {format_won(change.old_price)} → "
        f"{format_won(change.new_price)} ({sign}{delta:,}원)"
    )


def _new_line(change: Change) -> str:
    return f"- 신규: {_label(change)} — {format_won(change.new_price)}"


def _removed_line(change: Change) -> str:
    return f"- 종료: {_label(change)} — 마지막 확인가 {format_won(change.old_price)}"


def _summary_line(changes: ChangeSet) -> str:
    counts = changes.summary_counts()
    return (
        f"요약: 가격 인하 {counts['decrease']}건 · 가격 인상 {counts['increase']}건 · "
        f"신규 {counts['new']}건 · 종료 {counts['removed']}건"
    )


def build_entry(changes: ChangeSet, date: str, bulk_threshold: int = 10) -> str:
    """CHANGES.md에 넣을 하루치(또는 한 번의 실행) 항목을 만든다.

    신규·종료가 한꺼번에 많이 감지되면(월 전환 등) 건별로 나열하지 않고
    하나의 묶음 요약으로 보여 준다.
    """
    lines: list[str] = [f"## {date} ({weekday_ko(date)})", "", _summary_line(changes), ""]

    if changes.decreases:
        lines.append(f"### 가격 인하 ({len(changes.decreases)}건)")
        lines.append("")
        lines.extend(_price_change_line(change) for change in changes.decreases)
        lines.append("")

    if changes.increases:
        lines.append(f"### 가격 인상 ({len(changes.increases)}건)")
        lines.append("")
        lines.extend(_price_change_line(change) for change in changes.increases)
        lines.append("")

    bulk = (len(changes.new) + len(changes.removed)) >= bulk_threshold
    if bulk:
        counts = changes.summary_counts()
        title = "### 신규·종료 (묶음 요약)"
        lines.append(title)
        lines.append("")
        lines.append(
            f"- 신규 {counts['new']}건 · 종료 {counts['removed']}건이 한 번에 감지되었습니다. "
            "이벤트가 교체된 것으로 보입니다."
        )
        lines.append("")
        lines.append("<details>")
        lines.append(f"<summary>신규 {counts['new']}건 · 종료 {counts['removed']}건 전체 보기</summary>")
        lines.append("")
        lines.extend(_new_line(change) for change in changes.new)
        lines.extend(_removed_line(change) for change in changes.removed)
        lines.append("")
        lines.append("</details>")
        lines.append("")
    else:
        if changes.new:
            lines.append(f"### 신규 ({len(changes.new)}건)")
            lines.append("")
            lines.extend(_new_line(change) for change in changes.new)
            lines.append("")

        if changes.removed:
            lines.append(f"### 종료 ({len(changes.removed)}건)")
            lines.append("")
            lines.extend(_removed_line(change) for change in changes.removed)
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def ensure_changes_file(path: Path) -> None:
    """CHANGES.md가 없으면 머리말만 만들어 둔다."""
    if path.exists():
        return
    atomic_write_text(path, HEADER + "\n")


def prepend_entry(path: Path, entry: str) -> None:
    """새 변동 항목을 머리말 바로 아래(최신 순)에 넣는다."""
    ensure_changes_file(path)
    text = path.read_text(encoding="utf-8")
    marker = text.find("\n## ")
    entry = entry.strip() + "\n"
    if marker == -1:
        new_text = text.rstrip() + "\n\n" + entry
    else:
        head = text[:marker].rstrip()
        rest = text[marker + 1 :]
        new_text = head + "\n\n" + entry + "\n" + rest
    atomic_write_text(path, new_text.rstrip() + "\n")
