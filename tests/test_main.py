"""전체 실행 흐름 테스트 (네트워크 없이 저장한 HTML 사용)."""

from __future__ import annotations

import html as html_lib
import json
from pathlib import Path

from tracker.main import main

Entry = tuple[str, str, int, int]  # (카테고리, 시술명, 할인가, 정가)


def make_page(entries: list[Entry]) -> str:
    boxes = []
    for category, name, sale, list_price in entries:
        boxes.append(
            '<li class="price_box type02">'
            f'<p class="prd_text">{html_lib.escape(category)}</p>'
            f'<p class="origin"><span class="num">{list_price:,}</span>원</p>'
            f'<p class="discount"><span class="num">{sale:,}</span>원</p>'
            f'<p class="prd_info">{html_lib.escape(name)}</p>'
            "</li>"
        )
    return (
        '<!DOCTYPE html><html><body><div class="prd_list">'
        '<ul class="price_list">' + "".join(boxes) + "</ul></div></body></html>"
    )


def setup_project(tmp_path: Path) -> Path:
    (tmp_path / "config.json").write_text(
        json.dumps(
            {
                "source_url": "https://www.swuni114.co.kr/",
                "min_items_ratio": 0.9,
                "retry_delay_seconds": 0,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return tmp_path


def run(project: Path, page: Path, date: str) -> int:
    return main(
        [
            "--root", str(project),
            "--offline-html", str(page),
            "--today", date,
        ]
    )


FIRST: list[Entry] = [
    ("첫방문 이벤트", "피코토닝 1회 체험가", 29_000, 52_000),
    ("빼빼로데이 한정특가", "특가 A", 89_000, 160_000),
    ("쁘띠 시술", "쥬베룩 2cc", 99_000, 178_000),
]

SECOND: list[Entry] = [
    ("첫방문 이벤트", "피코토닝 1회 체험가", 25_000, 52_000),  # 인하
    ("쁘띠 시술", "쥬베룩 2cc", 99_000, 178_000),
    ("쁘띠 시술", "슈링크 300샷", 99_000, 178_000),  # 신규
]


def test_full_flow_baseline_then_changes(tmp_path: Path):
    project = setup_project(tmp_path)
    page1 = tmp_path / "day1.html"
    page1.write_text(make_page(FIRST), encoding="utf-8")

    assert run(project, page1, "2026-11-13") == 0

    prices = json.loads((project / "prices.json").read_text(encoding="utf-8"))
    assert prices["count"] == 3
    assert all(item["first_seen"] == "2026-11-13" for item in prices["items"])
    assert all(item["last_seen"] == "2026-11-13" for item in prices["items"])

    changes = (project / "CHANGES.md").read_text(encoding="utf-8")
    assert changes.startswith("# 가격 변동 기록")
    assert "\n## " not in changes  # 첫 실행은 변동 요약 없음

    history = (project / "history.csv").read_text(encoding="utf-8-sig")
    assert len([line for line in history.splitlines() if line]) == 4  # 헤더 + 3항목
    assert (project / "index.html").exists()

    # 둘째 날: 인하 1건, 종료 1건, 신규 1건
    page2 = tmp_path / "day2.html"
    page2.write_text(make_page(SECOND), encoding="utf-8")
    assert run(project, page2, "2026-11-14") == 0

    changes = (project / "CHANGES.md").read_text(encoding="utf-8")
    assert "## 2026-11-14 (토)" in changes
    assert "29,000원 → 25,000원" in changes
    assert "신규:" in changes and "슈링크 300샷" in changes
    assert "종료:" in changes and "특가 A" in changes

    prices = json.loads((project / "prices.json").read_text(encoding="utf-8"))
    by_name = {item["name"]: item for item in prices["items"]}
    assert by_name["피코토닝 1회 체험가"]["first_seen"] == "2026-11-13"
    assert by_name["피코토닝 1회 체험가"]["last_seen"] == "2026-11-14"
    assert by_name["슈링크 300샷"]["first_seen"] == "2026-11-14"
    assert "특가 A" not in by_name

    history = (project / "history.csv").read_text(encoding="utf-8-sig")
    assert len([line for line in history.splitlines() if line]) == 1 + 3 + 3
    assert "2026-11-14" in history


def test_failed_fetch_does_not_overwrite_data(tmp_path: Path, monkeypatch):
    project = setup_project(tmp_path)
    page = tmp_path / "day1.html"
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-13") == 0

    before = (project / "prices.json").read_bytes()
    history_before = (project / "history.csv").read_bytes()

    empty = tmp_path / "empty.html"
    empty.write_text("<html><body>점검 중</body></html>", encoding="utf-8")
    assert run(project, empty, "2026-11-14") == 1

    assert (project / "prices.json").read_bytes() == before
    assert (project / "history.csv").read_bytes() == history_before


def test_sharp_drop_fails_without_overwrite(tmp_path: Path):
    project = setup_project(tmp_path)
    page = tmp_path / "day1.html"
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-13") == 0
    before = (project / "prices.json").read_bytes()

    small = tmp_path / "small.html"
    small.write_text(make_page(FIRST[:1]), encoding="utf-8")
    assert run(project, small, "2026-11-14") == 1
    assert (project / "prices.json").read_bytes() == before


def test_dry_run_writes_nothing(tmp_path: Path):
    project = setup_project(tmp_path)
    page = tmp_path / "day1.html"
    page.write_text(make_page(FIRST), encoding="utf-8")

    assert main(
        ["--root", str(project), "--offline-html", str(page), "--today", "2026-11-13", "--dry-run"]
    ) == 0
    assert not (project / "prices.json").exists()
    assert not (project / "history.csv").exists()
    assert not (project / "index.html").exists()


def test_list_items_prints_and_writes_nothing(tmp_path: Path, capsys):
    project = setup_project(tmp_path)
    page = tmp_path / "day1.html"
    page.write_text(make_page(FIRST), encoding="utf-8")

    assert main(
        ["--root", str(project), "--offline-html", str(page), "--list-items"]
    ) == 0
    output = capsys.readouterr().out
    assert "피코토닝 1회 체험가" in output
    assert "29,000원" in output
    assert not (project / "prices.json").exists()


def test_excluded_removals_are_not_reported(tmp_path: Path):
    project = setup_project(tmp_path)
    config = json.loads((project / "config.json").read_text(encoding="utf-8"))
    config["exclude_keywords"] = []
    (project / "config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

    page1 = tmp_path / "day1.html"
    page1.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page1, "2026-11-13") == 0

    # 제외 키워드 추가: 기존 항목이 종료로 잘못 기록되면 안 된다.
    config["exclude_keywords"] = ["특가 A"]
    (project / "config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

    page2 = tmp_path / "day2.html"
    page2.write_text(
        make_page([entry for entry in FIRST if entry[1] != "특가 A"]),
        encoding="utf-8",
    )
    assert run(project, page2, "2026-11-14") == 0

    changes = (project / "CHANGES.md").read_text(encoding="utf-8")
    assert "특가 A" not in changes
    assert "## 2026-11-14" not in changes


def test_missing_offline_file_returns_error(tmp_path: Path):
    project = setup_project(tmp_path)
    assert main(
        ["--root", str(project), "--offline-html", str(tmp_path / "nope.html")]
    ) == 1
    assert not (project / "prices.json").exists()


def test_excluded_items_cannot_hide_drop_in_tracked_items(tmp_path: Path):
    project = setup_project(tmp_path)
    initial = [("추적", f"A{i}", 10_000, 20_000) for i in range(4)]
    page1 = tmp_path / "day1.html"
    page1.write_text(make_page(initial), encoding="utf-8")
    assert run(project, page1, "2026-11-13") == 0
    before = (project / "prices.json").read_bytes()

    config_path = project / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["exclude_keywords"] = ["제외"]
    config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    page2 = tmp_path / "day2.html"
    page2.write_text(make_page([initial[0]] + [
        ("제외", f"B{i}", 10_000, 20_000) for i in range(3)
    ]), encoding="utf-8")

    assert run(project, page2, "2026-11-14") == 1
    assert (project / "prices.json").read_bytes() == before


def test_same_day_rerun_replaces_change_summary(tmp_path: Path):
    project = setup_project(tmp_path)
    page = tmp_path / "page.html"
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-13") == 0

    page.write_text(make_page(SECOND), encoding="utf-8")
    assert run(project, page, "2026-11-14") == 0
    later = [(category, name, 24_000 if name == "피코토닝 1회 체험가" else sale, regular)
             for category, name, sale, regular in SECOND]
    page.write_text(make_page(later), encoding="utf-8")
    assert run(project, page, "2026-11-14") == 0

    changes = (project / "CHANGES.md").read_text(encoding="utf-8")
    assert changes.count("## 2026-11-14") == 1
    assert "29,000원 → 24,000원" in changes
    assert "29,000원 → 25,000원" not in changes
    assert "신규:" in changes and "종료:" in changes
    history = (project / "history.csv").read_text(encoding="utf-8-sig")
    assert "2026-11-14,첫방문 이벤트,피코토닝 1회 체험가,24000" in history


def test_same_day_revert_removes_change_summary(tmp_path: Path):
    project = setup_project(tmp_path)
    page = tmp_path / "page.html"
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-13") == 0
    changed = [(category, name, 25_000 if name == "피코토닝 1회 체험가" else sale, regular)
               for category, name, sale, regular in FIRST]
    page.write_text(make_page(changed), encoding="utf-8")
    assert run(project, page, "2026-11-14") == 0
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-14") == 0
    assert "## 2026-11-14" not in (project / "CHANGES.md").read_text(encoding="utf-8")


def test_corrupt_history_does_not_update_prices(tmp_path: Path):
    project = setup_project(tmp_path)
    page = tmp_path / "page.html"
    page.write_text(make_page(FIRST), encoding="utf-8")
    assert run(project, page, "2026-11-13") == 0
    prices_before = (project / "prices.json").read_bytes()
    (project / "history.csv").write_text("broken,header\n", encoding="utf-8")
    page.write_text(make_page(SECOND), encoding="utf-8")
    assert run(project, page, "2026-11-14") == 1
    assert (project / "prices.json").read_bytes() == prices_before
