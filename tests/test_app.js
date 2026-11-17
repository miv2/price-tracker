/**
 * tests/test_app.js
 * Node.js 내장 테스트 러너(node --test)를 사용해 핵심 UI/비즈니스 로직을 검증한다.
 * 외부 npm 패키지 없이 'node --test tests/test_app.js'로 실행된다.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../tracker/templates/app.js");

const DEFAULT_STATE = {
  q: "",
  category: "",
  status: "active",
  changedOnly: false,
  favoritesOnly: false,
  sort: "category",
  view: "cards",
  pageSize: app.PAGE_SIZE
};

function resetState(overrides) {
  Object.assign(app.state, DEFAULT_STATE, overrides || {});
  return app.state;
}

function setData(lastDate, days) {
  app.DATA.last_date = lastDate || null;
  app.DATA.days = days || 0;
}

function item(name, points, extra) {
  return Object.assign({ name, category: "피부", points }, extra || {});
}

beforeEach(function () {
  resetState();
  setData(null, 0);
  app.changedIndexes.clear();
  app.favorites.clear();
});

test("returnedPriceText() - 재등장 전후 가격과 동일·인하·인상을 표시한다", () => {
  assert.equal(app.returnedPriceText({ prev: 10000, price: 10000, delta: 0 }), "10,000원 → 10,000원 (종료 전과 동일)");
  assert.equal(app.returnedPriceText({ prev: 10000, price: 8000, delta: -2000 }), "10,000원 → 8,000원 (종료 전 대비 −2,000원)");
  assert.equal(app.returnedPriceText({ prev: 10000, price: 12000, delta: 2000 }), "10,000원 → 12,000원 (종료 전 대비 +2,000원)");
});

test("discountRate() - 정가와 할인가 비율을 올바르게 계산한다", () => {
  const itemWithDiscount = {
    list_price: 100000,
    points: [["2026-11-13", 70000]]
  };
  assert.equal(app.discountRate(itemWithDiscount), 30);

  const itemNoDiscount = {
    list_price: 50000,
    points: [["2026-11-13", 50000]]
  };
  assert.equal(app.discountRate(itemNoDiscount), null);

  const itemNoListPrice = {
    list_price: null,
    points: [["2026-11-13", 50000]]
  };
  assert.equal(app.discountRate(itemNoListPrice), null);

  const itemZeroListPrice = {
    list_price: 0,
    points: [["2026-11-13", 50000]]
  };
  assert.equal(app.discountRate(itemZeroListPrice), null);
});

test("currentPrice() - 가장 최근 날짜의 가격을 반환한다", () => {
  const target = {
    points: [
      ["2026-11-13", 30000],
      ["2026-11-14", 25000],
      ["2026-11-15", 27000]
    ]
  };
  assert.equal(app.currentPrice(target), 27000);
});

test("latestChange() - 가장 최근 가격 변동 시점과 차액을 계산한다", () => {
  const target = {
    points: [
      ["2026-11-13", 30000],
      ["2026-11-14", 25000],
      ["2026-11-15", 25000] // 변동 없음
    ]
  };
  const change = app.latestChange(target);
  assert.ok(change);
  assert.equal(change.date, "2026-11-14");
  assert.equal(change.delta, -5000);
  assert.equal(change.prev, 30000);
  assert.equal(change.price, 25000);
});

test("latestChange() - 변동이 없거나 점이 하나면 null을 반환한다", () => {
  assert.equal(app.latestChange(item("A", [["2026-11-13", 1000], ["2026-11-14", 1000]])), null);
  assert.equal(app.latestChange(item("A", [["2026-11-13", 1000]])), null);
});

test("overallDelta() - 첫 기록 대비 총 변동액을 반환한다", () => {
  const target = {
    points: [
      ["2026-11-13", 30000],
      ["2026-11-14", 25000],
      ["2026-11-15", 22000]
    ]
  };
  assert.equal(app.overallDelta(target), -8000);
  assert.equal(app.overallDelta(item("A", [["2026-11-13", 30000]])), 0);
});

test("trendColor() - 상승·하락·보합에 따라 색을 고른다", () => {
  assert.equal(app.trendColor(item("A", [["2026-11-13", 1000], ["2026-11-14", 900]])), "#2f9e44");
  assert.equal(app.trendColor(item("A", [["2026-11-13", 1000], ["2026-11-14", 1200]])), "#e8590c");
  assert.equal(app.trendColor(item("A", [["2026-11-13", 1000], ["2026-11-14", 1000]])), "#868e96");
});

test("matches() - 상태, 검색어, 카테고리 필터링 조건을 정확히 판별한다", () => {
  const itemA = { idx: 0, active: true, category: "리프팅", name: "슈링크 300샷", points: [["2026-11-15", 100000]] };
  const itemB = { idx: 1, active: false, category: "토닝", name: "피코토닝 1회", points: [["2026-11-15", 50000]] };

  // 1. 판매 상태 필터
  resetState({ status: "active" });
  assert.equal(app.matches(itemA), true);
  assert.equal(app.matches(itemB), false);

  resetState({ status: "ended" });
  assert.equal(app.matches(itemA), false);
  assert.equal(app.matches(itemB), true);

  // 2. 카테고리 필터
  resetState({ status: "all", category: "리프팅" });
  assert.equal(app.matches(itemA), true);
  assert.equal(app.matches(itemB), false);

  // 3. 검색어 필터 (대소문자 무시 및 부분 일치)
  resetState({ status: "all", q: "피코" });
  assert.equal(app.matches(itemA), false);
  assert.equal(app.matches(itemB), true);

  // 카테고리 이름으로도 검색된다.
  resetState({ status: "all", q: "리프팅" });
  assert.equal(app.matches(itemA), true);
  assert.equal(app.matches(itemB), false);

  // 4. 변동만 보기
  app.changedIndexes.add(1);
  resetState({ status: "all", changedOnly: true });
  assert.equal(app.matches(itemA), false);
  assert.equal(app.matches(itemB), true);
});

test("sortItems() - 가격순, 할인율순, 이름순 정렬이 올바르게 동작한다", () => {
  const list = [
    { name: "C", category: "피부", list_price: 100000, points: [["2026-11-15", 30000]] }, // 70% 할인
    { name: "A", category: "피부", list_price: 100000, points: [["2026-11-15", 90000]] }, // 10% 할인
    { name: "B", category: "피부", list_price: 100000, points: [["2026-11-15", 50000]] } // 50% 할인
  ];

  resetState({ sort: "price-asc" });
  assert.deepEqual(app.sortItems(list).map((entry) => entry.name), ["C", "B", "A"]);

  resetState({ sort: "price-desc" });
  assert.deepEqual(app.sortItems(list).map((entry) => entry.name), ["A", "B", "C"]);

  resetState({ sort: "discount-desc" });
  assert.deepEqual(app.sortItems(list).map((entry) => entry.name), ["C", "B", "A"]);

  resetState({ sort: "name" });
  assert.deepEqual(app.sortItems(list).map((entry) => entry.name), ["A", "B", "C"]);
});

test("sortItems() - 카테고리순은 카테고리로 묶고 그 안에서 이름순으로 정렬한다", () => {
  const list = [
    { name: "b2", category: "B", points: [["2026-11-15", 1000]] },
    { name: "a2", category: "A", points: [["2026-11-15", 1000]] },
    { name: "b1", category: "B", points: [["2026-11-15", 1000]] },
    { name: "a1", category: "A", points: [["2026-11-15", 1000]] }
  ];
  resetState({ sort: "category" });
  assert.deepEqual(
    app.sortItems(list).map((entry) => entry.category + "/" + entry.name),
    ["A/a1", "A/a2", "B/b1", "B/b2"]
  );
});

test("sortItems() - 최근 변동순은 변동일 내림차순, 같은 날은 변동 폭 내림차순이다", () => {
  const list = [
    item("열흘전", [["2026-11-01", 1000], ["2026-11-05", 900]]),
    item("오늘소폭", [["2026-11-01", 1000], ["2026-11-15", 950]]),
    item("오늘대폭", [["2026-11-01", 1000], ["2026-11-15", 500]]),
    item("변동없음", [["2026-11-01", 1000], ["2026-11-15", 1000]])
  ];
  resetState({ sort: "recent" });
  assert.deepEqual(
    app.sortItems(list).map((entry) => entry.name),
    ["오늘대폭", "오늘소폭", "열흘전", "변동없음"]
  );
});

test("groupItemsByBoundary() - 카테고리 카드가 페이징 경계에서 쪼개지지 않는다", () => {
  const items = [
    { category: "카테고리1", name: "시술1" },
    { category: "카테고리1", name: "시술2" },
    { category: "카테고리1", name: "시술3" },
    { category: "카테고리2", name: "시술4" },
    { category: "카테고리2", name: "시술5" },
    { category: "카테고리3", name: "시술6" }
  ];

  // limit이 2일 때: 카테고리1에 3개가 있으므로 카테고리1은 온전하게 3개 모두 포함하고 다음 카테고리 진입 전에 끊긴다.
  const groups = app.groupItemsByBoundary(items, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], "카테고리1");
  assert.equal(groups[0][1].length, 3);

  // limit이 4일 때: 카테고리1(3개) + 카테고리2(2개) -> 총 5개로 카테고리2까지 온전하게 닫힌다.
  const groups4 = app.groupItemsByBoundary(items, 4);
  assert.equal(groups4.length, 2);
  assert.equal(groups4[0][0], "카테고리1");
  assert.equal(groups4[1][0], "카테고리2");
  assert.equal(groups4[1][1].length, 2);

  // 경계에 정확히 걸치면 다음 카테고리를 시작하지 않는다.
  const exact = app.groupItemsByBoundary(items, 3);
  assert.equal(exact.length, 1);

  // 전체 보기(Infinity)는 모든 카테고리를 담는다.
  assert.equal(app.groupItemsByBoundary(items, Infinity).length, 3);
});

test("parseUrlState() - 쿼리 문자열을 상태로 복원한다", () => {
  assert.deepEqual(app.parseUrlState(""), DEFAULT_STATE);

  const parsed = app.parseUrlState(
    "?q=%ED%94%BC%EC%BD%94&category=%EB%A6%AC%ED%94%84%ED%8C%85&status=ended&changed=1&sort=price-asc&view=table&limit=100"
  );
  assert.equal(parsed.q, "피코");
  assert.equal(parsed.category, "리프팅");
  assert.equal(parsed.status, "ended");
  assert.equal(parsed.changedOnly, true);
  assert.equal(parsed.sort, "price-asc");
  assert.equal(parsed.view, "table");
  assert.equal(parsed.pageSize, 100);

  assert.equal(app.parseUrlState("?limit=all").pageSize, Infinity);
  assert.equal(app.parseUrlState("?limit=40").pageSize, app.PAGE_SIZE);
  assert.equal(app.parseUrlState("?limit=999").pageSize, app.PAGE_SIZE);
});

test("parseUrlState() - 허용되지 않은 값은 기본값으로 되돌린다", () => {
  const parsed = app.parseUrlState("?status=weird&sort=random&view=grid&limit=abc");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.sort, "category");
  assert.equal(parsed.view, "cards");
  assert.equal(parsed.pageSize, app.PAGE_SIZE);
});

test("buildQuery() - 기본값은 주소에서 생략하고 바뀐 값만 담는다", () => {
  assert.equal(app.buildQuery(DEFAULT_STATE), "");

  const query = app.buildQuery({
    q: "피코",
    category: "리프팅",
    status: "ended",
    changedOnly: true,
    sort: "price-asc",
    view: "table",
    pageSize: Infinity
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get("q"), "피코");
  assert.equal(params.get("category"), "리프팅");
  assert.equal(params.get("status"), "ended");
  assert.equal(params.get("changed"), "1");
  assert.equal(params.get("sort"), "price-asc");
  assert.equal(params.get("view"), "table");
  assert.equal(params.get("limit"), "all");

  assert.equal(app.buildQuery({ ...DEFAULT_STATE, pageSize: 100 }).includes("limit=100"), true);
});

test("buildQuery() - 관심 필터와 선택한 시술을 주소에 담는다", () => {
  const key = app.itemKey({ category: "리프팅", name: "리투오 5cc 1회" });
  const query = app.buildQuery({ ...DEFAULT_STATE, favoritesOnly: true }, key);
  const params = new URLSearchParams(query);
  assert.equal(params.get("fav"), "1");
  assert.equal(params.get("item"), key);

  // 특수문자(||, 공백, 한글)가 있어도 주소 왕복에서 그대로 복원된다.
  assert.equal(app.readItemKey("?" + query), key);
  assert.equal(app.parseUrlState("?" + query).favoritesOnly, true);
});

test("itemKey()/findItemByKey() - 이름이 같아도 카테고리로 구분한다", () => {
  const a = { category: "A", name: "같은 이름" };
  const b = { category: "B", name: "같은 이름" };
  assert.notEqual(app.itemKey(a), app.itemKey(b));

  app.items.push(a, b);
  assert.equal(app.findItemByKey(app.itemKey(b)), b);
  assert.equal(app.findItemByKey("없는키"), null);
  assert.equal(app.findItemByKey(""), null);
  app.items.pop();
  app.items.pop();
});

test("loadFavorites()/saveFavorites() - 저장된 관심 시술을 읽고 쓴다", () => {
  const store = {
    data: {},
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); }
  };
  assert.equal(app.loadFavorites(store).size, 0);
  assert.equal(app.loadFavorites(null).size, 0);

  app.saveFavorites(store, new Set(["A||하나", "B||둘"]));
  assert.deepEqual(Array.from(app.loadFavorites(store)), ["A||하나", "B||둘"]);

  // 깨진 JSON이나 배열이 아니면 조용히 빈 목록으로 돌아간다.
  store.data["priceTracker.favorites.v1"] = "{broken";
  assert.equal(app.loadFavorites(store).size, 0);
  store.data["priceTracker.favorites.v1"] = "{\"a\":1}";
  assert.equal(app.loadFavorites(store).size, 0);
});

test("toChosung()/matchesQuery() - 초성과 영문이 섞인 검색을 지원한다", () => {
  assert.equal(app.toChosung("피코토닝"), "ㅍㅋㅌㄴ");
  assert.equal(app.toChosung("FCR 필러"), "fcrㅍㄹ");

  const target = item("피코토닝 1회", [["2026-11-16", 30000]]);
  assert.equal(app.matchesQuery(target, "피코"), true);
  assert.equal(app.matchesQuery(target, "ㅍㅋㅌㄴ"), true);
  assert.equal(app.matchesQuery(target, "ㅍㅋ"), true);

  const lifting = item("리투오 5cc 1회", [["2026-11-16", 600000]]);
  assert.equal(app.matchesQuery(lifting, "ㄹㅌㅇ"), true);
  assert.equal(app.matchesQuery(lifting, "5cc"), true);
  assert.equal(app.matchesQuery(lifting, "ㅍㅋㅌㄴ"), false);
});

test("matches() - 관심 시술만 보기 필터가 동작한다", () => {
  const target = item("피코토닝 1회", [["2026-11-16", 30000]], { active: true });
  resetState({ favoritesOnly: true });
  assert.equal(app.matches(target), false);

  app.favorites.add(app.itemKey(target));
  assert.equal(app.matches(target), true);

  resetState({ favoritesOnly: false });
  assert.equal(app.matches(target), true);
});

test("parseUrlState(buildQuery(state)) - 주소 왕복에서 상태가 보존된다", () => {
  const state = {
    q: "울쎄라",
    category: "울쎄라피 프라임",
    status: "all",
    changedOnly: true,
    favoritesOnly: false,
    sort: "discount-desc",
    view: "table",
    pageSize: 100
  };
  assert.deepEqual(app.parseUrlState("?" + app.buildQuery(state)), state);
});

test("isLow30() - 최근 30일 최저가일 때만 배지를 붙인다", () => {
  setData("2026-11-15", 3);

  const atLow = item("최저", [["2026-11-13", 30000], ["2026-11-14", 25000], ["2026-11-15", 25000]]);
  assert.equal(app.isLow30(atLow), true);

  const aboveLow = item("보통", [["2026-11-13", 30000], ["2026-11-14", 25000], ["2026-11-15", 28000]]);
  assert.equal(app.isLow30(aboveLow), false);

  // 한 번도 변하지 않은 항목에는 붙이지 않는다.
  const flat = item("보합", [["2026-11-13", 25000], ["2026-11-14", 25000], ["2026-11-15", 25000]]);
  assert.equal(app.isLow30(flat), false);

  // 점이 하나뿐이면 판단하지 않는다.
  assert.equal(app.isLow30(item("하루", [["2026-11-15", 25000]])), false);

  // 기록이 하루뿐이면 붙이지 않는다.
  setData("2026-11-15", 1);
  assert.equal(app.isLow30(atLow), false);
});

test("min30() - 30일 창 밖의 가격은 최저가 계산에서 제외한다", () => {
  setData("2026-11-15", 90);
  const target = item("A", [
    ["2026-09-01", 1000],
    ["2026-11-14", 5000],
    ["2026-11-15", 4000]
  ]);
  assert.equal(app.min30(target), 4000);

  // 마지막 수집일이 없으면 전체 기간을 쓴다.
  setData(null, 0);
  assert.equal(app.min30(target), 1000);
});

test("niceStep() - 축 눈금 간격을 1·2·2.5·5·10 배수로 맞춘다", () => {
  assert.equal(app.niceStep(10000, 5), 2000);
  assert.equal(app.niceStep(5, 5), 1);
  assert.equal(app.niceStep(100, 5), 20);
  assert.equal(app.niceStep(1, 5), 0.2);
  assert.equal(app.niceStep(0, 5), 1);
});

test("axisLabel() - 만 단위와 천 단위 구분자를 적용한다", () => {
  assert.equal(app.axisLabel(10000), "1만");
  assert.equal(app.axisLabel(15000), "1.5만");
  assert.equal(app.axisLabel(100000), "10만");
  assert.equal(app.axisLabel(1000000), "100만");
  assert.equal(app.axisLabel(1025000), "102.5만");
  assert.equal(app.axisLabel(5000), "5,000");
  assert.equal(app.axisLabel(0), "0");
});

test("withAlpha() - 브랜드 색상을 투명도 있는 rgba로 바꾼다", () => {
  assert.equal(app.withAlpha("#cb3f70", 0.5), "rgba(203, 63, 112, 0.5)");
  assert.equal(app.withAlpha("#fff", 0.2), "rgba(255, 255, 255, 0.2)");
  assert.equal(app.withAlpha("rgb(1,2,3)", 0.5), "rgb(1,2,3)");
});

test("won()/mmdd() - 금액과 날짜 표기를 맞춘다", () => {
  assert.equal(app.won(25000), "25,000원");
  assert.equal(app.won(0), "0원");
  assert.equal(app.won(null), "—");
  assert.equal(app.won(undefined), "—");
  assert.equal(app.mmdd("2026-11-15"), "11.15");
});
