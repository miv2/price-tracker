"""config.json 로딩 테스트."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tracker.config import DEFAULT_SOURCE_URL, Config, ConfigError, load_config


def write_config(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_missing_file_uses_defaults(tmp_path: Path):
    config = load_config(tmp_path / "config.json")
    assert config == Config()
    assert config.source_url == DEFAULT_SOURCE_URL


def test_reads_all_options(tmp_path: Path):
    path = write_config(
        tmp_path,
        {
            "source_url": "https://example.com/event",
            "exclude_keywords": ["제모", "  "],
            "bulk_change_threshold": 20,
            "min_items_ratio": 0.8,
            "timeout_seconds": 10,
            "retries": 1,
            "retry_delay_seconds": 0,
            "repo_url": "https://github.com/example/price-tracker/",
        },
    )
    config = load_config(path)
    assert config.source_url == "https://example.com/event"
    assert config.exclude_keywords == ("제모",)
    assert config.bulk_change_threshold == 20
    assert config.min_items_ratio == 0.8
    assert config.timeout_seconds == 10
    assert config.retries == 1
    assert config.repo_url == "https://github.com/example/price-tracker"


@pytest.mark.parametrize(
    "data",
    [
        {"source_url": "ftp://example.com"},
        {"exclude_keywords": "제모"},
        {"bulk_change_threshold": 0},
        {"min_items_ratio": 0},
        {"min_items_ratio": 1.5},
        {"timeout_seconds": 0},
        {"retries": -1},
        {"retry_delay_seconds": -1},
        {"retries": "3"},
        {"repo_url": "not-a-url"},
    ],
)
def test_invalid_values_raise(tmp_path: Path, data: dict):
    path = write_config(tmp_path, data)
    with pytest.raises(ConfigError):
        load_config(path)


def test_invalid_json_raises(tmp_path: Path):
    path = tmp_path / "config.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(path)
