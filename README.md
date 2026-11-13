# 피부과 가격 추적기

유앤아이의원 수원점(<https://www.swuni114.co.kr/>) 메인 페이지의 이벤트 가격을 매일 한 번 수집해
가격 변동·신규·종료 항목을 기록하고, 시술별 가격 추이를 정적 페이지로 만들어 주는 개인용 도구입니다.

- 서버가 필요 없습니다. GitHub 저장소 하나와 GitHub Actions, GitHub Pages만으로 동작합니다.
- 알림은 보내지 않습니다. 변동 내역은 `CHANGES.md`, 그래프는 `index.html`에서 확인합니다.
- 운영 비용은 0원입니다(공개 저장소 + 무료 Actions/Pages).

## 동작 흐름

1. GitHub Actions가 매일 오전 10시(KST = 01:00 UTC)에 `python -m tracker`를 실행합니다.
2. 이벤트 페이지 HTML을 요청해 `카테고리 · 시술명 · 정가 · 할인가`를 추출합니다.
3. 저장소의 `prices.json`(직전 결과)과 비교해 **가격 인하 / 인상 / 신규 / 종료**를 판정합니다.
4. 변동이 있으면 `CHANGES.md` 맨 위에 날짜별 요약을 추가합니다.
5. 현재 결과를 `prices.json`에 저장하고, `history.csv`에 그날의 가격을 누적합니다.
6. `history.csv`로 시술별 추이 페이지(`index.html`)를 다시 만들어 함께 커밋합니다.
7. GitHub Pages가 `index.html`을 게시합니다.

페이지 요청이 실패하거나, 추출 건수가 0이거나 직전보다 크게 줄면 **가격 데이터를 덮어쓰지 않고 실행을 실패로 표시**합니다.

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `config.json` | 추적 범위(제외 키워드), 안전장치, 저장소 주소 설정 |
| `prices.json` | 직전 실행 결과(현재 판매 중인 항목의 최신 가격과 발견/확인 날짜) |
| `history.csv` | 날짜별 가격 이력. 그래프의 원본 데이터 |
| `CHANGES.md` | 변동이 있었던 날의 요약. 최신 항목이 위에 쌓임 |
| `index.html` | 시술별 가격 추이 그래프 페이지(생성 파일, GitHub Pages로 게시) |
| `tracker/` | 수집·비교·기록·그래프 생성 코드 |
| `tests/` | 파서·비교·요약·이력·그래프·전체 흐름 테스트 |
| `.github/workflows/track.yml` | 매일 실행 + 결과 커밋 워크플로 |

## 로컬에서 실행하기

Python 3.11 이상이 필요합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt

# 수집 결과만 확인 (파일 쓰지 않음)
python -m tracker --dry-run

# 수집한 시술명·가격을 표로 출력 (파일 쓰지 않음)
python -m tracker --list-items

# 실제 실행: prices.json / history.csv / CHANGES.md / index.html 갱신
python -m tracker
```

`index.html`은 파일을 브라우저로 열거나, 폴더에서 `python -m http.server 8000`을 실행해
<http://localhost:8000/index.html>로 확인할 수 있습니다.

테스트:

```powershell
python -m pytest -q
```

## config.json

```json
{
  "source_url": "https://www.swuni114.co.kr/",
  "exclude_keywords": [],
  "bulk_change_threshold": 10,
  "min_items_ratio": 0.5,
  "timeout_seconds": 30,
  "retries": 3,
  "retry_delay_seconds": 5,
  "repo_url": ""
}
```

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `source_url` | 수원점 메인 | 수집할 페이지 주소 |
| `exclude_keywords` | `[]` | 추적에서 뺄 키워드. **카테고리 또는 시술명에 포함**되면 제외합니다. 비워 두면 전체 시술을 추적합니다. |
| `bulk_change_threshold` | `10` | 신규+종료가 이 수 이상이면 건별 대신 하나의 묶음 요약으로 기록합니다(월 전환 대응). |
| `min_items_ratio` | `0.5` | 직전 대비 추출 건수가 이 비율보다 적으면 실행 실패로 처리합니다. |
| `timeout_seconds` | `30` | 페이지 요청 타임아웃 |
| `retries` | `3` | 요청 재시도 횟수 |
| `retry_delay_seconds` | `5` | 재시도 사이 대기 시간 |
| `repo_url` | `""` | 예: `https://github.com/내계정/저장소`. 넣으면 그래프 페이지의 CHANGES/CSV 링크가 GitHub 파일로 연결됩니다. |

제외 키워드를 나중에 추가해도, 기존 항목이 실수로 "종료"로 기록되지는 않습니다.

## 데이터 규칙

- 항목 식별 키는 **카테고리 + 시술명**입니다. 같은 시술이 여러 카테고리에 노출되면 각각 따로 추적합니다.
- 비교 기준은 **할인가**이며, 정가는 참고용으로만 저장합니다. 가격은 원 단위 정수, VAT 별도입니다.
- 저장 필드: `category`, `name`, `list_price`, `sale_price`, `first_seen`, `last_seen`.
- 페이지에 같은 항목이 두 번씩 노출되어 `(카테고리, 시술명)` 기준으로 중복을 제거합니다.
- 첫 실행은 변동 요약 없이 기준 데이터만 저장합니다. `CHANGES.md`는 머리말만 있는 상태로 시작합니다.
- 변동이 없는 날은 `CHANGES.md`에 아무것도 추가하지 않습니다.
- 한 번에 신규·종료가 많이 감지되면(기본 10건 이상) `CHANGES.md`에서 하나의 묶음으로 요약하고,
  전체 목록은 접힌 영역(`<details>`)에 담습니다.
- 가격 이력은 하루 1회 스냅샷입니다. 같은 날 다시 실행하면 그날 행을 최신 값으로 교체합니다.

## GitHub에 올려 자동 실행하기

1. **공개 저장소**를 만들고 이 폴더를 push합니다.

   ```powershell
   git init
   git add .
   git commit -m "feat: 피부과 가격 추적기 초기 구현"
   git branch -M main
   git remote add origin https://github.com/내계정/저장소.git
   git push -u origin main
   ```

2. 저장소 **Settings → Actions → General → Workflow permissions**에서
   **Read and write permissions**를 선택합니다. (워크플로가 결과 파일을 커밋하려면 필요)

3. **Actions** 탭에서 `가격 추적` 워크플로를 열고 **Run workflow**로 한 번 수동 실행해 동작을 확인합니다.
   첫 실행은 기준 데이터만 저장합니다.

4. **Settings → Pages**에서 Source를 **Deploy from a branch**, Branch를 `main` / `/(root)`로 설정합니다.
   잠시 뒤 `https://내계정.github.io/저장소/`에서 그래프가 열립니다.

5. `config.json`의 `repo_url`에 저장소 주소를 넣으면 그래프 페이지에서 변동 내역을 GitHub에서 바로 열 수 있습니다.

6. 매일 01:00 UTC(10:00 KST)에 자동 실행됩니다. Actions 탭에서 7일 연속 성공을 확인하세요.
   수집 실패·구조 변경으로 실패한 날은 데이터가 그대로 남습니다.

> 비공개 저장소는 GitHub Pages 게시가 제한될 수 있어 공개 저장소를 전제로 합니다.
> 저장하는 가격은 병원 홈페이지에 이미 공개된 정보입니다.

## 수집 구조와 유지보수

파서는 2026-11-13 기준 실제 HTML 구조를 사용합니다.

| 데이터 | 선택자 |
| --- | --- |
| 가격 블록 | `.prd_list li.price_box` |
| 카테고리 | `p.prd_text` |
| 시술명 | `p.prd_info` |
| 정가 | `p.origin .num` |
| 할인가 | `p.discount .num` |

사이트 개편으로 선택자가 바뀌면 `tracker/scrape.py`의 상수만 고치면 됩니다.
추출 건수가 급감하면 Actions가 실패하므로, 사이트 구조 변경을 놓치지 않고 알 수 있습니다.
자동 접근이 차단되면 요청 헤더 보강이나 Playwright 전환을 검토하세요(현재는 `requests` + `BeautifulSoup`).

`robots.txt`는 확인 결과 메인 페이지(`/`) 접근을 허용합니다. 요청은 하루 1회만 보냅니다.

## 1차 범위 밖

- 상시 운영 웹 서버, 다른 병원·지점 추가, 자동 예약
- 알림 전송(카카오톡·메일 등) — 변동은 GitHub에서 직접 확인
- 지난 30일 최저가 대비 문구(선택 기능) — 현재는 그래프의 최저/최고가로 대신 확인
