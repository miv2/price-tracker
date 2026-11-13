"""설정 파일(config.json) 로딩과 검증."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SOURCE_URL = "https://www.swuni114.co.kr/"


class ConfigError(Exception):
    """설정 파일을 읽을 수 없거나 값이 올바르지 않을 때 발생한다."""


@dataclass(frozen=True)
class Config:
    """수집·비교 동작에 필요한 설정값."""

    source_url: str = DEFAULT_SOURCE_URL
    exclude_keywords: tuple[str, ...] = ()
    bulk_change_threshold: int = 10
    min_items_ratio: float = 0.5
    timeout_seconds: int = 30
    retries: int = 3
    retry_delay_seconds: float = 5.0
    repo_url: str = ""


def _as_int(data: dict, key: str, default: int, minimum: int, maximum: int | None = None) -> int:
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"config.json의 '{key}' 값은 정수여야 합니다.")
    if value < minimum or (maximum is not None and value > maximum):
        bound = f"{minimum} 이상" + (f" {maximum} 이하" if maximum is not None else "")
        raise ConfigError(f"config.json의 '{key}' 값은 {bound}이어야 합니다.")
    return value


def _as_number(data: dict, key: str, default: float) -> float:
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"config.json의 '{key}' 값은 숫자여야 합니다.")
    return float(value)


def load_config(path: Path) -> Config:
    """config.json을 읽어 Config로 변환한다. 파일이 없으면 기본 설정을 쓴다."""

    if not path.exists():
        return Config()

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"설정 파일을 읽지 못했습니다: {path} ({exc})") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"설정 파일이 올바른 JSON이 아닙니다: {path} ({exc})") from exc

    if not isinstance(data, dict):
        raise ConfigError("config.json의 최상위 값은 객체여야 합니다.")

    url = data.get("source_url", DEFAULT_SOURCE_URL)
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ConfigError("config.json의 'source_url'은 http(s) 주소여야 합니다.")

    keywords = data.get("exclude_keywords", [])
    if not isinstance(keywords, list) or any(not isinstance(k, str) for k in keywords):
        raise ConfigError("config.json의 'exclude_keywords'는 문자열 목록이어야 합니다.")
    keywords = tuple(k.strip() for k in keywords if k.strip())

    ratio = _as_number(data, "min_items_ratio", 0.5)
    if not 0 < ratio <= 1:
        raise ConfigError("config.json의 'min_items_ratio'는 0보다 크고 1 이하여야 합니다.")

    retry_delay = _as_number(data, "retry_delay_seconds", 5.0)
    if retry_delay < 0:
        raise ConfigError("config.json의 'retry_delay_seconds'는 0 이상이어야 합니다.")

    repo_url = data.get("repo_url", "")
    if not isinstance(repo_url, str):
        raise ConfigError("config.json의 'repo_url'은 문자열이어야 합니다.")
    repo_url = repo_url.strip().rstrip("/")
    if repo_url and not repo_url.startswith(("http://", "https://")):
        raise ConfigError("config.json의 'repo_url'은 http(s) 주소이거나 비워 두어야 합니다.")

    return Config(
        source_url=url,
        exclude_keywords=keywords,
        bulk_change_threshold=_as_int(data, "bulk_change_threshold", 10, minimum=1),
        min_items_ratio=ratio,
        timeout_seconds=_as_int(data, "timeout_seconds", 30, minimum=1, maximum=300),
        retries=_as_int(data, "retries", 3, minimum=0, maximum=10),
        retry_delay_seconds=retry_delay,
        repo_url=repo_url,
    )
