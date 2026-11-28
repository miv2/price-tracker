/**
 * tests/test_app.js
 * Node.js 내장 테스트 러너(node --test)를 사용해 핵심 UI/비즈니스 로직을 검증한다.
 * 외부 npm 패키지 없이 'node --test tests/test_app.js'로 실행된다.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../tracker/templates/app.js");

// 기본값은 app.js의 defaultState()에서 가져와 테스트와 화면이 어긋나지 않게 한다.
const DEFAULT_STATE = app.defaultState();

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
  app.state.vatIncluded = false;
  setData(null, 0);
  app.changedIndexes.clear();
  app.favorites.clear();
});

test("readStorage()/writeStorage() - 저장소 접근과 예외를 방어한다", () => {
  const store = new Map();
  const fake = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); }
  };

  app.writeStorage(fake, "key", "value");
  assert.equal(app.readStorage(fake, "key"), "value");
  app.writeStorage(fake, "key", null);
  assert.equal(app.readStorage(fake, "key"), null);
  assert.equal(app.readStorage(null, "key"), null);

  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); }
  };
  assert.equal(app.readStorage(broken, "key"), null);
  assert.doesNotThrow(() => app.writeStorage(broken, "key", "value"));
});

test("setTogglePressed() - on 클래스와 aria 속성을 함께 갱신한다", () => {
  const classes = new Set();
  const attrs = {};
  const fake = {
    classList: {
      toggle: (name, active) => {
        if (active) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute: (name, value) => { attrs[name] = value; }
  };

  app.setTogglePressed(fake, true);
  assert.equal(classes.has("on"), true);
  assert.equal(attrs["aria-pressed"], "true");

  app.setTogglePressed(fake, false, "aria-expanded");
  assert.equal(classes.has("on"), false);
  assert.equal(attrs["aria-expanded"], "false");
  assert.doesNotThrow(() => app.setTogglePressed(null, true));
});

test("returnedPriceText() - 재등장 전후 가격과 동일·인하·인상을 표시한다", () => {
  assert.equal(app.returnedPriceText({ prev: 10000, price: 10000, delta: 0 }), "10,000원 → 10,000원 (종료 전과 동일)");
  assert.equal(app.returnedPriceText({ prev: 10000, price: 8000, delta: -2000 }), "10,000원 → 8,000원 (종료 전 대비 −2,000원)");
  assert.equal(app.returnedPriceText({ prev: 10000, price: 12000, delta: 2000 }), "10,000원 → 12,000원 (종료 전 대비 +2,000원)");
});

test("vatPrice()/displayWon() - VAT 포함 모드에서 10%를 원 단위로 반올림한다", () => {
  assert.equal(app.vatPrice(29000), 31900);
  assert.equal(app.vatPrice(10005), 11006); // 11,005.5원 반올림
  assert.equal(app.vatPrice(null), null);
  app.state.vatIncluded = false;
  assert.equal(app.displayPrice(29000), 29000);
  assert.equal(app.displayWon(29000), "29,000원");
  app.state.vatIncluded = true;
  assert.equal(app.displayPrice(29000), 31900);
  assert.equal(app.displayWon(29000), "31,900원");
  assert.equal(app.displayWon(null), "—");
  // 변동 금액도 표시 가격끼리의 차이로 계산해 화면 숫자와 맞춘다.
  assert.equal(
    app.returnedPriceText({ prev: 10000, price: 9000, delta: -1000 }),
    "11,000원 → 9,900원 (종료 전 대비 −1,100원)"
  );
});

test("loadVatIncluded()/saveVatIncluded() - VAT 표시 설정을 저장하고 복원한다", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); }
  };
  app.saveVatIncluded(storage, true);
  assert.equal(storage.getItem("priceTracker.vat.v1"), "1");
  assert.equal(app.loadVatIncluded(storage), true);
  app.saveVatIncluded(storage, false);
  assert.equal(app.loadVatIncluded(storage), false);
  assert.equal(app.loadVatIncluded(null), false);
  assert.doesNotThrow(() => app.saveVatIncluded(null, true));
});

test("loadTheme()/saveTheme()/getEffectiveTheme() - 테마 설정을 저장하고 복원하며 기본은 라이트다", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); }
  };

  assert.equal(app.loadTheme(storage), null);
  assert.equal(app.getEffectiveTheme(storage), "light"); // 저장된 값이 없으면 시스템 설정과 무관하게 라이트
  assert.equal(app.getEffectiveTheme(null), "light");

  app.saveTheme(storage, "dark");
  assert.equal(storage.getItem("priceTracker.theme.v1"), "dark");
  assert.equal(app.loadTheme(storage), "dark");
  assert.equal(app.getEffectiveTheme(storage), "dark");

  app.saveTheme(storage, "light");
  assert.equal(storage.getItem("priceTracker.theme.v1"), "light");
  assert.equal(app.loadTheme(storage), "light");
  assert.equal(app.getEffectiveTheme(storage), "light");

  // 잘못된 값은 저장소에서 제거되어 null 처리
  app.saveTheme(storage, "invalid");
  assert.equal(app.loadTheme(storage), null);

  assert.equal(app.loadTheme(null), null);
  assert.doesNotThrow(() => app.saveTheme(null, "dark"));
});

test("calculateEstimate() - 상품 수량과 VAT 전환을 정확히 합산한다", () => {
  const catalog = [
    item("토닝 5회 패키지", [["2026-11-16", 10000], ["2026-11-17", 9500]], { active: true }),
    item("관리", [["2026-11-17", 15005]], { active: true })
  ];
  const quantities = new Map([[app.itemKey(catalog[0]), 2], [app.itemKey(catalog[1]), 3]]);
  const included = app.calculateEstimate(quantities, catalog, true);
  assert.equal(included.subtotal, 64015); // 패키지의 5회를 다시 곱하지 않는다.
  assert.equal(included.tax, 6402); // 합계 기준 원 단위 반올림
  assert.equal(included.total, 70417);
  assert.equal(included.quantityCount, 5);
  assert.equal(included.lines[0].lineTotal, 19000); // 최신 수집가 사용
  const excluded = app.calculateEstimate(quantities, catalog, false);
  assert.equal(excluded.total, 64015);
  assert.equal(excluded.tax, 0);
  assert.equal(app.calculateEstimate(new Map(), [], true).total, 0);
});

test("calculateEstimate() - 카테고리별로 구분하고 종료·미확인 상품은 합계에서 제외한다", () => {
  const catalog = [
    item("같은 이름", [["2026-11-17", 10000]], { active: true, category: "첫방문" }),
    item("같은 이름", [["2026-11-17", 20000]], { active: true, category: "일반" }),
    item("종료", [["2026-11-16", 50000]], { active: false }),
    item("오류", [["2026-11-17", -5000]], { active: true })
  ];
  const quantities = new Map(catalog.map((entry) => [app.itemKey(entry), 2]));
  quantities.set("과거||사라진 상품", 1);
  const result = app.calculateEstimate(quantities, catalog, true);
  assert.equal(result.lines.length, 5);
  assert.equal(result.unavailableCount, 3);
  assert.equal(result.subtotal, 60000);
  assert.equal(result.total, 66000);
  assert.equal(result.lines[2].available, false);
  assert.equal(result.lines[2].lineTotal, 0);
  assert.equal(result.lines[4].available, false);
});

test("validQuantity() - 정수 1~99만 허용하고 계산에서도 잘못된 수량을 제외한다", () => {
  for (const value of [0, -1, 1.5, 100, Infinity, NaN, "", "abc", true, null, undefined, [], {}]) {
    assert.equal(app.validQuantity(value), null);
  }
  assert.equal(app.validQuantity("3"), 3);
  assert.equal(app.validQuantity(99), 99);
  const target = item("A", [["2026-11-17", 10000]], { active: true });
  assert.equal(app.calculateEstimate(new Map([[app.itemKey(target), -1]]), [target], true).total, 0);
});

test("loadEstimate()/saveEstimate() - 수량·VAT 설정 저장 및 손상된 데이터 복구", () => {
  const storage = { value: null, getItem() { return this.value; }, setItem(key, value) { this.value = value; } };
  const original = { quantities: new Map([["카테고리||A", 3], ["카테고리||B", 99]]), includeVat: false };
  app.saveEstimate(storage, original);
  const restored = app.loadEstimate(storage);
  assert.deepEqual(Array.from(restored.quantities), Array.from(original.quantities));
  assert.equal(restored.includeVat, false);
  original.quantities.clear();
  app.saveEstimate(storage, original);
  assert.equal(app.loadEstimate(storage).quantities.size, 0);
  storage.value = JSON.stringify({ items: [["유효", 2], ["음수", -1], ["소수", 2.3], ["초과", 100], ["불리언", true], [null, 1], {}], includeVat: "false" });
  assert.deepEqual(Array.from(app.loadEstimate(storage).quantities), [["유효", 2]]);
  assert.equal(app.loadEstimate(storage).includeVat, true);
  storage.value = "{broken";
  assert.equal(app.loadEstimate(storage).quantities.size, 0);
  assert.equal(app.loadEstimate(null).includeVat, true);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(app.loadEstimate(blocked).quantities.size, 0);
  assert.doesNotThrow(() => app.saveEstimate(blocked, original));
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

test("priceValues()/minMax()/priceRange() - 가격 목록과 최저·최고를 계산한다", () => {
  const target = {
    points: [
      ["2026-11-13", 30000],
      ["2026-11-14", 25000],
      ["2026-11-15", 27000]
    ]
  };
  assert.deepEqual(app.priceValues(target), [30000, 25000, 27000]);
  assert.deepEqual(app.minMax([3, 1, 2]), { min: 1, max: 3 });
  assert.deepEqual(app.priceRange(target), { min: 25000, max: 30000 });
  assert.deepEqual(app.lastPoint(target), ["2026-11-15", 27000]);
});

test("chartBounds() - 축 범위가 모든 가격을 포함하고 0 이상이다", () => {
  const bounds = app.chartBounds([15000, 20000, 17000], false, false);
  assert.ok(bounds.min >= 0);
  assert.ok(bounds.min <= 15000);
  assert.ok(bounds.max >= 20000);
  assert.ok(bounds.step > 0);

  const flat = app.chartBounds([29000, 29000], true, false);
  assert.ok(flat.min >= 0);
  assert.ok(flat.max > 29000);
  assert.ok(flat.step > 0);
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

test("matchesBudget() - 누적 상한 구간의 경계값을 정확히 판정한다", () => {
  const priced = (value) => ({ name: "시술", points: [["2026-11-18", value]] });

  assert.equal(app.matchesBudget(priced(29000), ""), true);

  assert.equal(app.matchesBudget(priced(30000), "under-3"), true);
  assert.equal(app.matchesBudget(priced(30001), "under-3"), false);
  assert.equal(app.matchesBudget(priced(30001), "under-5"), true);

  assert.equal(app.matchesBudget(priced(50000), "under-5"), true);
  assert.equal(app.matchesBudget(priced(50001), "under-5"), false);
  assert.equal(app.matchesBudget(priced(50001), "under-10"), true);

  assert.equal(app.matchesBudget(priced(100000), "under-10"), true);
  assert.equal(app.matchesBudget(priced(100001), "under-10"), false);
  assert.equal(app.matchesBudget(priced(100001), "over-10"), true);
  assert.equal(app.matchesBudget(priced(100000), "over-10"), false);

  // 가격을 확인할 수 없는 항목은 예산 구간에서 제외하고, 전체 칩에서는 남긴다.
  assert.equal(app.matchesBudget(priced(null), "under-3"), false);
  assert.equal(app.matchesBudget(priced(null), ""), true);
});

test("matchesBudget() - VAT 포함 표시 중에는 화면 금액 기준으로 판정한다", () => {
  const target = { name: "피코토닝 1회", points: [["2026-11-18", 29000]] };

  app.state.vatIncluded = false;
  assert.equal(app.matchesBudget(target, "under-3"), true);

  app.state.vatIncluded = true; // 29,000원 → 31,900원
  assert.equal(app.matchesBudget(target, "under-3"), false);
  assert.equal(app.matchesBudget(target, "under-5"), true);

  app.state.vatIncluded = false;
});

test("matches() - 예산 칩은 카테고리·검색어와 AND로 결합된다", () => {
  const cheap = { idx: 0, active: true, category: "피부", name: "피코토닝 1회", points: [["2026-11-18", 49000]] };
  const pricey = { idx: 1, active: true, category: "피부", name: "울쎄라 300샷", points: [["2026-11-18", 120000]] };

  resetState({ status: "active", budget: "under-5", category: "피부" });
  assert.equal(app.matches(cheap), true);
  assert.equal(app.matches(pricey), false);

  resetState({ status: "active", budget: "over-10", category: "피부" });
  assert.equal(app.matches(cheap), false);
  assert.equal(app.matches(pricey), true);

  // 검색어와 함께 걸어도 두 조건을 모두 만족해야 남는다.
  resetState({ status: "active", budget: "under-5", q: "울쎄라" });
  assert.equal(app.matches(pricey), false);
  resetState({ status: "active", budget: "over-10", q: "울쎄라" });
  assert.equal(app.matches(pricey), true);
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

test("eventsForKind() - 월별 배지 종류에 맞는 항목만 골라낸다", () => {
  const summary = {
    top_decreases: [{ kind: "decrease", name: "가장 큰 인하" }],
    events: [
      { kind: "decrease", name: "인하1" },
      { kind: "increase", name: "인상1" },
      { kind: "new", name: "신규1" },
      { kind: "returned", name: "재등장1" },
      { kind: "removed", name: "종료1" },
      { kind: "removed", name: "종료2" }
    ]
  };

  assert.deepEqual(app.eventsForKind(summary, "removed").map((e) => e.name), ["종료1", "종료2"]);
  assert.deepEqual(app.eventsForKind(summary, "increase").map((e) => e.name), ["인상1"]);
  assert.deepEqual(app.eventsForKind(summary, "new").map((e) => e.name), ["신규1"]);
  assert.deepEqual(app.eventsForKind(summary, "returned").map((e) => e.name), ["재등장1"]);
  const many = { events: Array.from({ length: 12 }, (_, i) => ({ kind: "decrease", name: "인하" + i })) };
  assert.equal(app.eventsForKind(many, "decrease").length, 12); // TOP 5 제한을 적용하지 않는다.
  // 선택을 해제하면 기존처럼 인하 금액 TOP 5를 보여준다.
  assert.deepEqual(app.eventsForKind(summary, "").map((e) => e.name), ["가장 큰 인하"]);
  assert.deepEqual(app.eventsForKind(summary, null).map((e) => e.name), ["가장 큰 인하"]);

  // 변동 목록이 없는 달·요약이 없을 때도 빈 배열로 안전하게 돌아간다.
  assert.deepEqual(app.eventsForKind({ top_decreases: [] }, "removed"), []);
  assert.deepEqual(app.eventsForKind(null, "removed"), []);
});

test("parseUrlState(buildQuery(state)) - 주소 왕복에서 상태가 보존된다", () => {
  const state = {
    q: "울쎄라",
    category: "울쎄라피 프라임",
    budget: "over-10",
    status: "all",
    changedOnly: true,
    favoritesOnly: false,
    dedupe: true,
    sort: "discount-desc",
    view: "table",
    pageSize: 100
  };
  assert.deepEqual(app.parseUrlState("?" + app.buildQuery(state)), state);
});

test("parseUrlState()/buildQuery() - budget 파라미터를 보존하고 잘못된 값은 무시한다", () => {
  assert.equal(app.parseUrlState("?budget=under-3").budget, "under-3");
  assert.equal(app.parseUrlState("?budget=under-5").budget, "under-5");
  assert.equal(app.parseUrlState("?budget=under-10").budget, "under-10");
  assert.equal(app.parseUrlState("?budget=over-10").budget, "over-10");

  // 알 수 없는 코드는 전체로 되돌린다.
  assert.equal(app.parseUrlState("?budget=under-7").budget, "");
  assert.equal(app.parseUrlState("?budget=30000").budget, "");

  const query = app.buildQuery({ ...DEFAULT_STATE, category: "피부", budget: "under-5" });
  const params = new URLSearchParams(query);
  assert.equal(params.get("budget"), "under-5");
  assert.equal(params.get("category"), "피부");
  assert.equal(app.parseUrlState("?" + query).budget, "under-5");

  // 전체("")는 주소에 남기지 않는다.
  assert.equal(new URLSearchParams(app.buildQuery(DEFAULT_STATE)).has("budget"), false);
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

test("packageInfo() - 이름 끝의 회차만 패키지로 인식한다", () => {
  assert.deepEqual(app.packageInfo({ name: "리투오 5cc 3회" }), { base: "리투오 5cc", count: 3 });
  assert.deepEqual(app.packageInfo({ name: "리투오 5cc 1회 " }), { base: "리투오 5cc", count: 1 });

  // 끝이 회차가 아니면 계산하지 않는다(오탐 방지).
  assert.equal(app.packageInfo({ name: "울트라펄스 앙코르 5회 패키지" }), null);
  assert.equal(app.packageInfo({ name: "한관종 아그네스 3회+co2 1회 (눈 밑, 눈꺼풀 기준)" }), null);
  assert.equal(app.packageInfo({ name: "관리 장바구니 10회 (아쿠아필, 비타민 中 택 2)" }), null);
  assert.equal(app.packageInfo({ name: "회차 없음" }), null);
  assert.equal(app.packageInfo({ name: "0회" }), null);
  assert.equal(app.packageInfo({ name: "100회" }), null);
});

test("unitPriceValue()/packageComparison() - 회당 단가와 1회 대비 차이를 계산한다", () => {
  const catalog = [
    item("리투오 5cc 1회", [["2026-11-19", 600000]], { active: true, category: "리투오" }),
    item("리투오 5cc 3회", [["2026-11-19", 1390000]], { active: true, category: "리투오" }),
    item("고우리 5cc 2회", [["2026-11-19", 990000]], { active: true, category: "고우리" })
  ];

  assert.equal(app.unitPriceValue(catalog[1]), 463333);
  assert.equal(app.unitPriceValue(catalog[0]), 600000);
  assert.equal(app.unitPriceValue(item("패키지 아님", [["2026-11-19", 1000]])), null);

  const comparison = app.packageComparison(catalog[1], catalog);
  assert.equal(comparison.count, 3);
  assert.equal(comparison.unit, 463333);
  assert.equal(comparison.onePrice, 600000);
  assert.equal(comparison.percent, 23);

  // 1회 항목이 없으면 비교만 생략하고 회당 단가는 그대로 계산한다.
  assert.equal(app.packageComparison(catalog[2], catalog), null);
  assert.equal(app.unitPriceText(catalog[2], catalog), "회당 495,000원");

  // VAT 포함 표시에서도 비율은 같고 금액만 10% 오른다.
  app.state.vatIncluded = true;
  const included = app.packageComparison(catalog[1], catalog);
  assert.equal(included.unit, 509667);
  assert.equal(included.percent, 23);
  assert.equal(app.unitPriceText(catalog[1], catalog), "회당 509,667원 · 1회 대비 23% 저렴");
  app.state.vatIncluded = false;

  assert.equal(app.unitPriceText(catalog[0], catalog), ""); // 1회 항목에는 배지를 붙이지 않는다.
});

test("sortItems() - 회당 단가 낮은순은 회차를 알 수 없는 항목을 뒤로 보낸다", () => {
  const list = [
    item("비싼 1회", [["2026-11-19", 600000]]),
    item("3회", [["2026-11-19", 900000]]),
    item("10회", [["2026-11-19", 1000000]]),
    item("회차 없음", [["2026-11-19", 1000]])
  ];
  resetState({ sort: "unit-asc" });
  assert.deepEqual(
    app.sortItems(list).map((entry) => entry.name),
    ["10회", "3회", "비싼 1회", "회차 없음"]
  );
});

test("dedupeItems() - 같은 이름은 대표 항목 하나만 남긴다", () => {
  const list = [
    { idx: 0, active: true, category: "✨ECM부스터 리투오", name: "리투오 5cc 1회" },
    { idx: 1, active: true, category: "리투오", name: "리투오 5cc 1회" },
    { idx: 2, active: true, category: "입고 연장 이벤트", name: "리투오 5cc 1회" },
    { idx: 3, active: true, category: "다른 시술", name: "다른 시술 1회" }
  ];
  assert.deepEqual(
    app.dedupeItems(list).map((entry) => entry.category),
    ["리투오", "다른 시술"]
  );

  // 판매 중인 항목을 종료된 항목보다 우선한다.
  const activeFirst = [
    { idx: 0, active: false, category: "짧은", name: "울써마지 패키지" },
    { idx: 1, active: true, category: "입고 연장 이벤트", name: "울써마지 패키지" }
  ];
  assert.deepEqual(app.dedupeItems(activeFirst).map((entry) => entry.idx), [1]);

  // 이름에 카테고리가 없으면 더 짧은 카테고리를 고른다.
  const noNameMatch = [
    { idx: 0, active: true, category: "아주 긴 카테고리 이름", name: "이름만 있는 시술" },
    { idx: 1, active: true, category: "짧은", name: "이름만 있는 시술" }
  ];
  assert.deepEqual(app.dedupeItems(noNameMatch).map((entry) => entry.idx), [1]);
});

test("packagePeers() - 같은 시술의 패키지를 회차순으로 모은다", () => {
  const catalog = [
    item("리투오 5cc 3회", [["2026-11-19", 1390000]], { category: "리투오", idx: 1 }),
    item("리투오 5cc 1회", [["2026-11-19", 600000]], { category: "리투오", idx: 0 }),
    item("리투오 5cc 2회", [["2026-11-19", 990000]], { category: "리투오", idx: 2 }),
    item("다른 시술 1회", [["2026-11-19", 10000]], { category: "피부", idx: 3 })
  ];

  const peers = app.packagePeers(catalog[0], catalog);
  assert.deepEqual(
    peers.map((entry) => entry.name),
    ["리투오 5cc 1회", "리투오 5cc 2회", "리투오 5cc 3회"]
  );
  assert.equal(peers[2], catalog[0], "연 항목은 같은 객체로 남는다");

  // 이름이 회차로 끝나지 않으면 비교 대상이 없다.
  assert.deepEqual(
    app.packagePeers(item("울트라펄스 앙코르 5회 패키지", [["2026-11-19", 1000]]), catalog),
    []
  );
});

test("packagePeers() - 같은 회차는 대표 항목 하나만 남기고 연 항목은 우선한다", () => {
  const preferred = item("리투오 5cc 1회", [["2026-11-19", 600000]], { category: "리투오", idx: 0 });
  const other = item("리투오 5cc 1회", [["2026-11-19", 600000]], { category: "✨ECM부스터 리투오", idx: 1 });
  const selected = item("리투오 5cc 1회", [["2026-11-19", 600000]], { category: "입고 연장 이벤트", idx: 2 });
  const catalog = [preferred, other, selected, item("리투오 5cc 3회", [["2026-11-19", 1390000]], { category: "리투오", idx: 3 })];

  // 목록에서 열지 않은 1회는 이름에 카테고리가 들어 있는 항목을 고른다.
  assert.equal(
    app.packagePeers(catalog[3], catalog).find((entry) => entry.name === "리투오 5cc 1회"),
    preferred
  );

  // 연 항목은 중복 순위와 무관하게 그대로 표시한다(표에서 '선택'으로 강조).
  assert.equal(
    app.packagePeers(selected, catalog).find((entry) => entry.name === "리투오 5cc 1회"),
    selected
  );
});

test("packagePeers() - 종료된 항목은 판매 중 항목 뒤에 붙인다", () => {
  const ended = item("리투오 5cc 2회", [["2026-11-10", 900000]], { category: "리투오", idx: 0, active: false });
  const active = item("리투오 5cc 2회", [["2026-11-19", 990000]], { category: "리투오", idx: 1, active: true });
  const one = item("리투오 5cc 1회", [["2026-11-19", 600000]], { category: "리투오", idx: 2, active: true });

  assert.deepEqual(
    app.packagePeers(ended, [ended, active, one]).map((entry) => entry.idx),
    [2, 1, 0]
  );
});

test("eventDday() - 이벤트 기간과 오늘(KST)을 비교한다", () => {
  const period = { start: "2026-11-01", end: "2026-11-30" };
  assert.deepEqual(app.eventDday(period, "2026-11-19"), { phase: "during", days: 11 });
  assert.deepEqual(app.eventDday(period, "2026-11-30"), { phase: "during", days: 0 });
  assert.deepEqual(app.eventDday(period, "2026-12-01"), { phase: "after", days: 1 });
  assert.deepEqual(app.eventDday(period, "2026-10-31"), { phase: "before", days: 1 });
  assert.equal(app.eventDday(null, "2026-11-19"), null);
  assert.equal(app.eventDday({ start: "2026-11-01" }, "2026-11-19"), null);
});

test("todayKst()/periodText() - 한국 날짜와 기간 표기를 만든다", () => {
  assert.equal(app.todayKst("2026-11-19T14:59:00Z"), "2026-11-19");
  assert.equal(app.todayKst("2026-11-19T15:00:00Z"), "2026-11-20");
  assert.equal(app.todayKst("잘못된 날짜"), null);

  assert.equal(app.periodText({ start: "2026-11-01", end: "2026-11-30" }), "2026.11.01 ~ 11.30");
  assert.equal(app.periodText({ start: "2026-12-20", end: "2027-01-05" }), "2026.12.20 ~ 2027.01.05");
  assert.equal(app.periodText(null), "");
});

test("parseUrlState()/buildQuery() - 중복 숨기기 상태를 주소에 보존한다", () => {
  assert.equal(app.parseUrlState("?dedupe=1").dedupe, true);
  assert.equal(app.parseUrlState("?dedupe=0").dedupe, false);

  const query = app.buildQuery({ ...DEFAULT_STATE, dedupe: true });
  assert.equal(new URLSearchParams(query).get("dedupe"), "1");
  assert.equal(app.parseUrlState("?" + query).dedupe, true);
  assert.equal(new URLSearchParams(app.buildQuery(DEFAULT_STATE)).has("dedupe"), false);
});

