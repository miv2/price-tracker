const DATA = (function () {
  if (typeof window !== "undefined" && window.__PRICE_DATA__) {
    return window.__PRICE_DATA__;
  }
  if (typeof document === "undefined") return { items: [] };
  const node = document.getElementById("payload");
  if (!node) return { items: [] };
  try {
    return JSON.parse(node.textContent);
  } catch (error) {
    console.error("가격 데이터를 읽지 못했습니다.", error);
    return { items: [] };
  }
})();

(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const COLORS = { up: "#e8590c", down: "#2f9e44", flat: "#868e96" };
  const fmt = (n) => Number(n).toLocaleString("ko-KR");
  const won = (n) => (n === null || n === undefined ? "—" : fmt(n) + "원");
  const mmdd = (date) => date.slice(5).replace("-", ".");
  const items = Array.isArray(DATA.items) ? DATA.items : [];
  items.forEach(function (item, index) { item.idx = index; });
  const RECENT = DATA.recent || {
    baseline: true,
    date: DATA.last_date || null,
    prev_date: null,
    counts: { decrease: 0, increase: 0, new: 0, returned: 0, removed: 0 },
    total: 0,
    items: []
  };
  const EVENT_PERIOD = DATA.event_period || null;
  const changedIndexes = new Set((RECENT.items || []).map(function (change) { return change.index; }));
  const PAGE_SIZE = 40;
  const FAVORITES_KEY = "priceTracker.favorites.v1";
  const ESTIMATE_KEY = "priceTracker.estimate.v1";
  const VAT_KEY = "priceTracker.vat.v1";
  const THEME_KEY = "priceTracker.theme.v1";
  const VAT_RATE = 0.1;
  const MAX_QUANTITY = 99;
  const MAX_PACKAGE_COUNT = 99;
  const CHART_PREVIEW_ROWS = 5;
  const PACKAGE_RE = /^(.*?)\s*(\d+)\s*회\s*$/;
  const CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const CHANGE_LABELS = { decrease: "인하", increase: "인상", new: "신규", returned: "재등장", removed: "종료" };
  const MONTHLY_EMPTY = {
    decrease: "이달에 관측된 가격 인하가 없습니다.",
    increase: "이달에 관측된 가격 인상이 없습니다.",
    new: "이달에 새로 등장한 항목이 없습니다.",
    returned: "이달에 재등장한 항목이 없습니다.",
    removed: "이달에 종료된 항목이 없습니다."
  };
  const state = { q: "", category: "", budget: "", status: "active", changedOnly: false, favoritesOnly: false, dedupe: false, sort: "category", view: "cards", pageSize: PAGE_SIZE, vatIncluded: loadVatIncluded(storageOrNull()) };
  let displayLimit = PAGE_SIZE;
  let monthlyKind = "";
  let openItemKey = "";
  let chartHistoryPushed = false;
  const favorites = loadFavorites(storageOrNull());
  const estimate = loadEstimate(storageOrNull());
  // VAT 설정은 목록 표시와 예상 결제액 계산기가 함께 쓴다. 저장된 값이 다르면 목록 기준을 따른다.
  estimate.includeVat = state.vatIncluded;
  const expandedCategories = new Set();
  let currentFilteredList = [];
  let currentPageItems = [];
  let searchTimer = null;
  let previousFocusElement = null;

  const $ = (id) => document.getElementById(id);

  const SORT_VALUES = ["category", "recent", "discount-desc", "price-desc", "price-asc", "unit-asc", "name"];

  // 누적 상한형 예산 구간. 마지막 칩만 "10만원 초과"를 모은다.
  const BUDGET_OPTIONS = [
    { value: "", label: "전체" },
    { value: "under-3", label: "~3만원", max: 30000 },
    { value: "under-5", label: "~5만원", max: 50000 },
    { value: "under-10", label: "~10만원", max: 100000 },
    { value: "over-10", label: "10만원+" }
  ];
  const BUDGET_VALUES = BUDGET_OPTIONS.map(function (option) { return option.value; });

  function itemKey(item) {
    return (item.category || "") + "||" + item.name;
  }

  function findItemByKey(key) {
    if (!key) return null;
    for (const item of items) {
      if (itemKey(item) === key) return item;
    }
    return null;
  }

  function readItemKey(search) {
    return new URLSearchParams(search || "").get("item") || "";
  }

  function storageOrNull() {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  function loadVatIncluded(storage) {
    if (!storage || typeof storage.getItem !== "function") return false;
    try {
      return storage.getItem(VAT_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function saveVatIncluded(storage, included) {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(VAT_KEY, included ? "1" : "0");
    } catch (error) {
      // 저장 공간이 없으면 이번 방문 동안만 유지한다.
    }
  }

  function loadTheme(storage) {
    if (!storage || typeof storage.getItem !== "function") return null;
    try {
      const val = storage.getItem(THEME_KEY);
      return val === "dark" || val === "light" ? val : null;
    } catch (error) {
      return null;
    }
  }

  function saveTheme(storage, theme) {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      if (theme === "dark" || theme === "light") {
        storage.setItem(THEME_KEY, theme);
      } else if (typeof storage.removeItem === "function") {
        storage.removeItem(THEME_KEY);
      }
    } catch (error) {
      // 저장 공간이 없으면 무시한다.
    }
  }

  function getEffectiveTheme(storage) {
    // 저장된 값이 없으면 항상 라이트 모드로 시작한다(시스템 설정을 따르지 않음).
    return loadTheme(storage) || "light";
  }

  function applyTheme(theme, persist, storage) {
    if (typeof document !== "undefined") {
      const dark = theme === "dark";
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#141316" : "#ffffff");
      const btn = $("themeToggle");
      if (btn) {
        const nextMode = dark ? "라이트 모드로 전환" : "다크 모드로 전환";
        btn.setAttribute("aria-label", nextMode);
        btn.setAttribute("aria-pressed", String(dark));
        btn.title = nextMode;
      }
      if ($("chartDialog") && $("chartDialog").open && openItemKey) {
        const target = findItemByKey(openItemKey);
        if (target) drawChart(target);
      }
    }
    if (persist) {
      saveTheme(storage || storageOrNull(), theme);
    }
  }

  function toggleTheme() {
    const next = getEffectiveTheme(storageOrNull()) === "dark" ? "light" : "dark";
    applyTheme(next, true, storageOrNull());
    toast(next === "dark" ? "다크 모드로 전환되었습니다." : "라이트 모드로 전환되었습니다.");
  }

  function initTheme() {
    const btn = $("themeToggle");
    if (btn) btn.addEventListener("click", toggleTheme);
    applyTheme(getEffectiveTheme(storageOrNull()), false);
  }

  function vatPrice(price) {
    if (price === null || price === undefined) return price;
    return Math.round(Number(price) * (1 + VAT_RATE));
  }

  // 목록·표·차트·계산기가 같은 VAT 설정을 공유한다.
  function displayPrice(price) {
    return state.vatIncluded ? vatPrice(price) : price;
  }

  function displayWon(price) {
    return won(displayPrice(price));
  }

  function loadFavorites(storage) {
    if (!storage || typeof storage.getItem !== "function") return new Set();
    try {
      const raw = storage.getItem(FAVORITES_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter(function (value) { return typeof value === "string"; }));
    } catch (error) {
      return new Set();
    }
  }

  function saveFavorites(storage, set) {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(set)));
    } catch (error) {
      // 저장 공간이 없거나 프라이빗 모드면 이번 방문 동안만 유지한다.
    }
  }

  function validQuantity(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const quantity = Number(value);
    return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null;
  }

  function loadEstimate(storage) {
    const result = { quantities: new Map(), includeVat: true };
    try {
      const raw = storage && JSON.parse(storage.getItem(ESTIMATE_KEY));
      if (!raw || !Array.isArray(raw.items)) return result;
      if (typeof raw.includeVat === "boolean") result.includeVat = raw.includeVat;
      for (const entry of raw.items) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0]) continue;
        const quantity = validQuantity(entry[1]);
        if (quantity !== null) result.quantities.set(entry[0], quantity);
      }
    } catch (error) {
      // 저장이 차단되거나 데이터가 손상되어도 이번 방문 동안 계산할 수 있다.
    }
    return result;
  }

  function saveEstimate(storage, value) {
    try {
      if (storage) storage.setItem(ESTIMATE_KEY, JSON.stringify({
        items: Array.from(value.quantities), includeVat: value.includeVat
      }));
    } catch (error) {
      // 저장 실패는 현재 계산에 영향을 주지 않는다.
    }
  }

  function calculateEstimate(quantities, catalog, includeVat) {
    const byKey = new Map(catalog.map(function (item) { return [itemKey(item), item]; }));
    const lines = [];
    let subtotal = 0;
    let quantityCount = 0;
    let unavailableCount = 0;
    for (const [key, value] of quantities) {
      const quantity = validQuantity(value);
      if (quantity === null) continue;
      const item = byKey.get(key);
      const price = item && Array.isArray(item.points) && item.points.length ? currentPrice(item) : null;
      const available = !!(item && item.active && Number.isSafeInteger(price) && price >= 0);
      const lineTotal = available ? price * quantity : 0;
      subtotal += lineTotal;
      quantityCount += quantity;
      if (!available) unavailableCount += 1;
      lines.push({ key, item, quantity, available, price, lineTotal });
    }
    const tax = includeVat ? Math.round(subtotal / 10) : 0;
    return { lines, subtotal, tax, total: subtotal + tax, quantityCount, unavailableCount };
  }

  function updateEstimateChart() {
    const item = findItemByKey(openItemKey);
    const quantity = estimate.quantities.get(openItemKey) || 0;
    const add = $("estimateAdd");
    add.disabled = !item || !item.active || quantity >= MAX_QUANTITY;
    add.textContent = !item || !item.active ? "종료된 상품은 담을 수 없습니다" :
      quantity >= MAX_QUANTITY ? "최대 99개까지 담을 수 있습니다" : "계산에 담기";
    $("estimateAdded").textContent = quantity ? "이 상품 " + quantity + "개 담음" : "";
    $("estimateShow").hidden = estimate.quantities.size === 0;
  }

  function renderEstimateTotals() {
    estimate.includeVat = state.vatIncluded;
    const result = calculateEstimate(estimate.quantities, items, state.vatIncluded);
    $("estimateCount").textContent = result.lines.length ? result.lines.length + "종 · " + result.quantityCount + "개 · " +
      (state.vatIncluded ? "VAT 포함" : "VAT 별도") +
      (result.unavailableCount ? " · 종료·미확인 " + result.unavailableCount + "종 합계 제외" : "") : "시술 상세에서 계산에 담아 보세요.";
    $("estimateTotal").textContent = won(result.total);
    $("estimateSubtotal").textContent = won(result.subtotal);
    $("estimateTax").textContent = won(result.tax);
    $("estimateVatLabel").textContent = state.vatIncluded ? "VAT (10%)" : "VAT 미포함";
    $("estimatePayable").textContent = won(result.total);
    $("estimateVat").checked = state.vatIncluded;
    $("estimateClear").disabled = result.lines.length === 0;
    const badge = $("tabEstimateBadge");
    if (badge) {
      const count = result.lines.length;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    return result;
  }

  function renderEstimateRow(line, index) {
    const row = document.createElement("li");
    row.className = "estimate-row";
    const info = document.createElement("div");
    info.className = "estimate-info";
    const category = makeSpan(line.item ? line.item.category : "미확인 상품", "small");
    const name = document.createElement("strong");
    name.textContent = line.item ? line.item.name : line.key;
    const detail = makeSpan(
      line.available ? "상품 1개 " + won(line.price) : "종료·미확인 상품 · 합계에서 제외",
      "small"
    );
    info.append(category, name, detail);
    const controls = document.createElement("div");
    controls.className = "estimate-quantity";
    function changeQuantity(quantity) {
      const valid = validQuantity(quantity);
      if (valid !== null) estimate.quantities.set(line.key, valid);
      saveEstimate(storageOrNull(), estimate);
      renderEstimate();
    }
    function button(text, label, action, id) {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = text;
      node.setAttribute("aria-label", name.textContent + " " + label);
      node.id = id;
      node.addEventListener("click", action);
      return node;
    }
    const minus = button("−", "수량 줄이기", function () { changeQuantity(line.quantity - 1); }, "estimateMinus" + index);
    minus.disabled = !line.available || line.quantity <= 1;
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.inputMode = "numeric";
    quantity.min = "1";
    quantity.max = String(MAX_QUANTITY);
    quantity.step = "1";
    quantity.value = String(line.quantity);
    quantity.id = "estimateQty" + index;
    quantity.setAttribute("aria-label", name.textContent + " 상품 수량");
    quantity.disabled = !line.available;
    quantity.addEventListener("input", function () {
      const value = validQuantity(quantity.value);
      if (value === null) {
        if (quantity.value !== "") quantity.value = String(line.quantity);
        return;
      }
      line.quantity = value;
      estimate.quantities.set(line.key, value);
      saveEstimate(storageOrNull(), estimate);
      renderEstimateTotals();
      total.textContent = won(line.price * value);
      minus.disabled = value <= 1;
      plus.disabled = value >= MAX_QUANTITY;
      updateEstimateChart();
    });
    quantity.addEventListener("blur", function () {
      quantity.value = String(line.quantity);
    });
    const plus = button("+", "수량 늘리기", function () { changeQuantity(line.quantity + 1); }, "estimatePlus" + index);
    plus.disabled = !line.available || line.quantity >= MAX_QUANTITY;
    controls.append(minus, quantity, plus);
    const total = document.createElement("strong");
    total.className = "estimate-line-total";
    total.textContent = line.available ? won(line.lineTotal) : "합계 제외";
    const remove = button("삭제", "계산에서 삭제", function () {
      estimate.quantities.delete(line.key);
      saveEstimate(storageOrNull(), estimate);
      renderEstimate();
      $("estimateSummary").focus({ preventScroll: true });
    }, "estimateRemove" + index);
    remove.className = "link-btn";
    row.append(info, controls, total, remove);
    return row;
  }

  function renderEstimate() {
    const focusedId = document.activeElement && document.activeElement.id;
    const result = renderEstimateTotals();
    const list = $("estimateList");
    list.textContent = "";
    if (!result.lines.length) {
      const empty = document.createElement("li");
      empty.className = "small estimate-empty";
      empty.textContent = "담은 시술이 없습니다. 시술을 선택하고 ‘계산에 담기’를 눌러주세요.";
      list.appendChild(empty);
    }
    result.lines.forEach(function (line, index) {
      list.appendChild(renderEstimateRow(line, index));
    });
    updateEstimateChart();
    if (focusedId && $(focusedId) && !$(focusedId).disabled) $(focusedId).focus({ preventScroll: true });
  }

  function addToEstimate(item) {
    if (!item || !item.active) return;
    const key = itemKey(item);
    const quantity = estimate.quantities.get(key) || 0;
    if (quantity >= MAX_QUANTITY) return;
    estimate.quantities.set(key, quantity + 1);
    saveEstimate(storageOrNull(), estimate);
    renderEstimate();
    $("estimateDetails").open = true;
    toast("계산에 담았습니다. 이 상품 " + (quantity + 1) + "개");
  }

  // 한글을 초성으로 바꿔 "ㅍㅋㅌㄴ" 같은 초성 검색을 가능하게 한다.
  function toChosung(text) {
    let out = "";
    for (const char of String(text).toLowerCase()) {
      const code = char.charCodeAt(0);
      if (code >= 0xac00 && code <= 0xd7a3) {
        out += CHOSUNG.charAt(Math.floor((code - 0xac00) / 588));
      } else if (char !== " ") {
        out += char;
      }
    }
    return out;
  }

  function matchesQuery(item, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    if (item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q)) return true;
    const chosungQuery = toChosung(q);
    if (!chosungQuery) return false;
    return toChosung(item.name).includes(chosungQuery) || toChosung(item.category).includes(chosungQuery);
  }

  // 예산 칩은 화면에 보이는 금액(VAT 포함 여부 반영)을 기준으로 판정한다.
  function matchesBudget(item, budgetCode) {
    if (!budgetCode) return true;
    const price = displayPrice(currentPrice(item));
    if (price === null || price === undefined || !Number.isFinite(price)) return false;
    if (budgetCode === "under-3") return price <= 30000;
    if (budgetCode === "under-5") return price <= 50000;
    if (budgetCode === "under-10") return price <= 100000;
    if (budgetCode === "over-10") return price > 100000;
    return true;
  }

  // "리투오 5cc 3회"처럼 이름 끝에 회차가 있는 항목만 패키지로 본다.
  // "5회 패키지", "3회+co2 1회 (…)"처럼 끝이 회차가 아니면 계산하지 않는다.
  function packageInfo(item) {
    const match = PACKAGE_RE.exec(String(item.name || ""));
    if (!match) return null;
    const count = Number(match[2]);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PACKAGE_COUNT) return null;
    return { base: match[1].trim(), count: count };
  }

  // 회당 단가(화면 표시 금액 기준). 회차를 알 수 없으면 null.
  function unitPriceValue(item) {
    const info = packageInfo(item);
    if (!info) return null;
    return Math.round(displayPrice(currentPrice(item)) / info.count);
  }

  function oneSessionPrice(base, catalog) {
    const list = catalog || items;
    for (const entry of list) {
      if (entry.active === false) continue;
      const info = packageInfo(entry);
      if (info && info.count === 1 && info.base === base) return currentPrice(entry);
    }
    return null;
  }

  // 같은 이름의 1회 항목과 비교해 패키지가 유리한지 계산한다.
  // percent > 0 이면 회당 단가가 1회보다 저렴하다는 뜻이다.
  function packageComparison(item, catalog) {
    const info = packageInfo(item);
    if (!info || info.count < 2) return null;
    const one = oneSessionPrice(info.base, catalog);
    if (one === null) return null;
    const oneShown = displayPrice(one);
    const unit = displayPrice(currentPrice(item)) / info.count;
    if (!oneShown) return null;
    return {
      base: info.base,
      count: info.count,
      unit: Math.round(unit),
      onePrice: one,
      percent: Math.round((1 - unit / oneShown) * 100)
    };
  }

  function unitPriceText(item, catalog) {
    const info = packageInfo(item);
    if (!info || info.count < 2) return "";
    const text = "회당 " + won(unitPriceValue(item));
    const comparison = packageComparison(item, catalog);
    if (!comparison) return text;
    if (comparison.percent > 0) return text + " · 1회 대비 " + comparison.percent + "% 저렴";
    if (comparison.percent < 0) return text + " · 1회 대비 " + Math.abs(comparison.percent) + "% 비쌈";
    return text + " · 1회와 동일";
  }

  // 같은 이름의 1회·2회·3회… 패키지를 회차순으로 모은다.
  // 중복 회차는 목록과 같은 기준으로 고르되, 보고 있는 상품은 그대로 표시한다.
  function packagePeers(item, catalog) {
    const info = packageInfo(item);
    if (!info) return [];
    const list = catalog || items;
    const byCount = new Map();
    for (const entry of list) {
      if (entry.active === false) continue;
      const peer = packageInfo(entry);
      if (!peer || peer.base !== info.base) continue;
      const existing = byCount.get(peer.count);
      if (!existing || compareDuplicateRank(entry, existing) < 0) byCount.set(peer.count, entry);
    }
    if (item.active !== false) byCount.set(info.count, item);
    const peers = Array.from(byCount.values());
    if (item.active === false) peers.push(item);
    return peers.sort(function (a, b) {
      return packageInfo(a).count - packageInfo(b).count;
    });
  }

  // 같은 시술이 여러 카테고리에 중복 등록된 경우 한 번만 남긴다.
  // 이름 안에 카테고리명이 들어 있는 항목(예: '리투오' 카테고리의 '리투오 5cc 1회')을
  // 우선하고, 없으면 이름이 짧은 카테고리를 고른다.
  function duplicateRank(item) {
    const name = String(item.name || "");
    const category = String(item.category || "");
    const inName = category !== "" && name.includes(category);
    return [
      item.active === false ? 1 : 0,
      inName ? 0 : 1,
      category.length,
      Number.isInteger(item.idx) ? item.idx : 0
    ];
  }

  function compareDuplicateRank(a, b) {
    const ra = duplicateRank(a);
    const rb = duplicateRank(b);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  }

  function dedupeItems(list) {
    const keepers = new Map();
    for (const item of list) {
      const current = keepers.get(item.name);
      if (!current || compareDuplicateRank(item, current) < 0) keepers.set(item.name, item);
    }
    return list.filter(function (item) { return keepers.get(item.name) === item; });
  }

  function todayKst(now) {
    const base = now ? new Date(now) : new Date();
    if (Number.isNaN(base.getTime())) return null;
    return new Date(base.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // 이벤트 기간과 오늘(KST)을 비교해 D-day 정보를 만든다.
  function eventDday(period, today) {
    if (!period || !period.start || !period.end) return null;
    const start = Date.parse(period.start + "T00:00:00Z");
    const end = Date.parse(period.end + "T00:00:00Z");
    const current = Date.parse((today || todayKst()) + "T00:00:00Z");
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(current)) return null;
    if (current < start) {
      return { phase: "before", days: Math.round((start - current) / 86400000) };
    }
    if (current > end) {
      return { phase: "after", days: Math.round((current - end) / 86400000) };
    }
    return { phase: "during", days: Math.round((end - current) / 86400000) };
  }

  function periodText(period) {
    if (!period || !period.start || !period.end) return "";
    const start = period.start.replace(/-/g, ".");
    const end = period.end.replace(/-/g, ".");
    if (period.start.slice(0, 4) === period.end.slice(0, 4)) return start + " ~ " + end.slice(5);
    return start + " ~ " + end;
  }

  function parseUrlState(search) {
    const next = {
      q: "",
      category: "",
      budget: "",
      status: "active",
      changedOnly: false,
      favoritesOnly: false,
      dedupe: false,
      sort: "category",
      view: "cards",
      pageSize: PAGE_SIZE
    };
    const params = new URLSearchParams(search || "");
    const q = params.get("q");
    if (q) next.q = q;
    const category = params.get("category");
    if (category) next.category = category;
    const budget = params.get("budget");
    if (BUDGET_VALUES.indexOf(budget) !== -1) next.budget = budget;
    const status = params.get("status");
    if (status === "active" || status === "ended" || status === "all") next.status = status;
    if (params.get("changed") === "1") next.changedOnly = true;
    if (params.get("fav") === "1") next.favoritesOnly = true;
    if (params.get("dedupe") === "1") next.dedupe = true;
    const sort = params.get("sort");
    if (SORT_VALUES.indexOf(sort) !== -1) next.sort = sort;
    if (params.get("view") === "table") next.view = "table";
    const limit = params.get("limit");
    if (limit === "all") next.pageSize = Infinity;
    else if (limit === "100") next.pageSize = 100;
    else if (limit === "40") next.pageSize = PAGE_SIZE;
    return next;
  }

  function readUrlState() {
    Object.assign(state, parseUrlState(window.location.search));
  }

  function buildQuery(current, itemKeyValue) {
    const params = new URLSearchParams();
    if (current.q) params.set("q", current.q);
    if (current.category) params.set("category", current.category);
    if (current.budget) params.set("budget", current.budget);
    if (current.status !== "active") params.set("status", current.status);
    if (current.changedOnly) params.set("changed", "1");
    if (current.favoritesOnly) params.set("fav", "1");
    if (current.dedupe) params.set("dedupe", "1");
    if (current.sort !== "category") params.set("sort", current.sort);
    if (current.view !== "cards") params.set("view", "table");
    if (current.pageSize !== PAGE_SIZE) params.set("limit", current.pageSize === Infinity ? "all" : String(current.pageSize));
    if (itemKeyValue) params.set("item", itemKeyValue);
    return params.toString();
  }

  function syncUrl(push, itemKeyValue) {
    const key = itemKeyValue === undefined ? openItemKey : itemKeyValue;
    const query = buildQuery(state, key);
    const url = window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }

  function applyStateToControls() {
    $("q").value = state.q;
    const chips = $("categoryChips").querySelectorAll("button");
    const known = Array.prototype.some.call(chips, function (button) {
      return button.dataset.category === state.category;
    });
    if (!known) state.category = "";
    syncCategoryChips(true);
    syncBudgetChips(true);
    $("statusFilter").value = state.status;
    $("sortFilter").value = state.sort;
    $("pageSizeFilter").value = state.pageSize === Infinity ? "all" : String(state.pageSize);
    $("changedToggle").classList.toggle("on", state.changedOnly);
    $("changedToggle").setAttribute("aria-pressed", String(state.changedOnly));
    const dedupeToggle = $("dedupeToggle");
    if (dedupeToggle) {
      dedupeToggle.classList.toggle("on", state.dedupe);
      dedupeToggle.setAttribute("aria-pressed", String(state.dedupe));
    }
    $("viewToggle").textContent = state.view === "cards" ? "표로 보기" : "카드로 보기";
    $("viewToggle").setAttribute("aria-pressed", String(state.view === "table"));
    updateFavoritesUi();
    updateFilterDot();
  }

  function overallDelta(item) {
    const p = item.points;
    if (p.length < 2) return 0;
    return p[p.length - 1][1] - p[0][1];
  }

  function latestChange(item) {
    const p = item.points;
    for (let i = p.length - 1; i > 0; i -= 1) {
      if (p[i][1] !== p[i - 1][1]) {
        return { delta: p[i][1] - p[i - 1][1], date: p[i][0], price: p[i][1], prev: p[i - 1][1] };
      }
    }
    return null;
  }

  function lastPoint(item) {
    return item.points[item.points.length - 1];
  }

  function currentPrice(item) {
    return lastPoint(item)[1];
  }

  function priceValues(item) {
    return item.points.map(function (point) { return point[1]; });
  }

  function minMax(values) {
    return { min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
  }

  function priceRange(item) {
    return minMax(priceValues(item));
  }

  function cutoff30() {
    if (!DATA.last_date) return null;
    const date = new Date(DATA.last_date + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() - 29);
    return date.toISOString().slice(0, 10);
  }

  function min30(item) {
    const cutoff = cutoff30();
    const points = cutoff ? item.points.filter(function (p) { return p[0] >= cutoff; }) : item.points;
    if (!points.length) return null;
    return minMax(points.map(function (p) { return p[1]; })).min;
  }

  function isLow30(item) {
    if (!DATA.last_date || (DATA.days || 0) < 2) return false;
    const cutoff = cutoff30();
    const points = item.points.filter(function (p) { return p[0] >= cutoff; });
    if (points.length < 2) return false;
    const range = minMax(points.map(function (p) { return p[1]; }));
    // 가격이 한 번도 변하지 않았으면 '최저' 배지를 붙이지 않는다.
    if (range.max <= range.min) return false;
    return currentPrice(item) <= range.min;
  }

  function discountRate(item) {
    if (!item.list_price) return null;
    const rate = Math.round((1 - currentPrice(item) / item.list_price) * 100);
    return rate > 0 ? rate : null;
  }

  function trendColor(item) {
    const d = overallDelta(item);
    if (d === 0) return cssVar("--flat") || COLORS.flat;
    return d < 0 ? (cssVar("--down") || COLORS.down) : (cssVar("--up") || COLORS.up);
  }

  function cssVar(name) {
    // Node 테스트에서는 DOM이 없으므로 빈 문자열을 돌려주고 호출부가 기본값을 쓴다.
    if (typeof document === "undefined" || !document.documentElement) return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function withAlpha(color, alpha) {
    if (typeof color !== "string" || color.charAt(0) !== "#") return color;
    const hex = color.slice(1);
    const full = hex.length === 3
      ? hex.split("").map(function (c) { return c + c; }).join("")
      : hex;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return color;
    return "rgba(" + ((num >> 16) & 255) + ", " + ((num >> 8) & 255) + ", " + (num & 255) + ", " + alpha + ")";
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    if (attrs) {
      for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function sparkline(item) {
    const W = 104, H = 28, pad = 4;
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H, "class": "spark", "aria-hidden": "true" });
    const color = trendColor(item);
    svg.style.color = color;
    const points = item.points;
    const range = priceRange(item);
    const min = range.min;
    const max = range.max;
    const span = max - min;
    const step = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
    const coords = points.map((p, i) => [
      pad + (points.length > 1 ? i * step : (W - pad * 2) / 2),
      span === 0 ? H / 2 : H - pad - ((p[1] - min) / span) * (H - pad * 2)
    ]);
    if (coords.length > 1) {
      const areaPath = "M" + coords[0][0] + "," + coords[0][1] + " " +
        coords.map((c) => "L" + c[0] + "," + c[1]).join(" ") +
        " L" + coords[coords.length - 1][0] + "," + H +
        " L" + coords[0][0] + "," + H + " Z";
      svg.appendChild(el("path", { d: areaPath, fill: "currentColor", opacity: "0.14" }));

      const poly = el("polyline", {
        points: coords.map((c) => c.join(",")).join(" "),
        fill: "none", stroke: "currentColor", "stroke-width": "2",
        "stroke-linecap": "round", "stroke-linejoin": "round"
      });
      svg.appendChild(poly);
    }
    const last = coords[coords.length - 1];
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: "4.5", fill: "currentColor", opacity: "0.2" }));
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: "2.4", fill: "currentColor" }));
    const title = el("title");
    title.textContent = points.length + "일 기록 · " + displayWon(points[points.length - 1][1]);
    svg.appendChild(title);
    return svg;
  }

  function deltaText(item) {
    const change = latestChange(item);
    if (change === null) return "—";
    const prev = displayPrice(change.prev);
    const delta = displayPrice(change.price) - prev;
    const pct = change.prev ? (delta / prev) * 100 : null;
    const sign = delta > 0 ? "+" : "-";
    const abs = fmt(Math.abs(delta));
    return (delta > 0 ? "▲ " : "▼ ") + abs + "원" + (pct === null ? "" : " (" + sign + Math.abs(pct).toFixed(1) + "%)");
  }

  function renderStats() {
    const dates = new Set();
    for (const item of items) {
      for (const p of item.points) dates.add(p[0]);
    }
    $("statActive").textContent = fmt(DATA.active_count || 0) + "개";
    $("statDays").textContent = fmt(dates.size) + "일";
    $("statLast").textContent = DATA.last_date ? mmdd(DATA.last_date) : "—";
    if (RECENT.baseline) {
      $("statChanges").textContent = "—";
      $("statChanges").title = "기준 데이터만 있습니다. 다음 수집부터 변동이 계산됩니다.";
    } else {
      const counts = RECENT.counts || {};
      $("statChanges").textContent = fmt(RECENT.total) + "건";
      $("statChanges").title = "인하 " + (counts.decrease || 0) + " · 인상 " + (counts.increase || 0) +
        " · 신규 " + (counts.new || 0) + " · 재등장 " + (counts.returned || 0) + " · 종료 " + (counts.removed || 0);
    }
    if (DATA.source_url) $("sourceLink").href = DATA.source_url;
    $("chartSource").href = $("sourceLink").href;
    if (DATA.repo_url) {
      const base = DATA.repo_url.replace(/\/$/, "");
      $("changesLink").href = base + "/blob/HEAD/CHANGES.md";
      $("historyLink").href = base + "/blob/HEAD/history.csv";
      $("pricesLink").href = base + "/blob/HEAD/prices.json";
    }
  }

  function renderRecent() {
    const sub = $("recentSub");
    const list = $("recentList");
    list.textContent = "";

    if (RECENT.baseline) {
      sub.textContent = RECENT.date
        ? mmdd(RECENT.date) + " 기준 데이터를 저장했습니다. 다음 수집부터 변동이 표시됩니다."
        : "아직 수집 기록이 없습니다.";
      return;
    }

    sub.textContent = (RECENT.prev_date ? mmdd(RECENT.prev_date) : "직전") + " → " + mmdd(RECENT.date) + " 비교 · " + fmt(RECENT.total) + "건";

    renderChangeList(list, RECENT.items, "직전 수집 대비 변동이 없습니다.");
  }

  function renderChangeCounts(countsBox, counts) {
    countsBox.textContent = "";
    const kinds = [
      ["decrease", "인하"],
      ["increase", "인상"],
      ["new", "신규"],
      ["returned", "재등장"],
      ["removed", "종료"]
    ];
    for (const entry of kinds) {
      const kind = entry[0];
      const count = counts[kind] || 0;
      const selected = monthlyKind === kind;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "count kind-" + kind + (count ? "" : " zero") + (selected ? " on" : "");
      button.disabled = count === 0;
      button.dataset.kind = kind;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-controls", "monthlyList");
      button.setAttribute("aria-label", entry[1] + " " + fmt(count) + "건" + (selected ? " · 다시 누르면 인하 금액 TOP 5 보기" : " 보기"));
      button.title = count
        ? (selected ? "다시 누르면 인하 금액 TOP 5로 돌아갑니다" : "이달 " + entry[1] + " 항목 보기")
        : "이달 " + entry[1] + " 항목이 없습니다";
      const label = document.createElement("span");
      label.className = "count-label";
      label.textContent = entry[1];
      const number = document.createElement("span");
      number.className = "count-num";
      number.textContent = fmt(count);
      button.append(label, number);
      button.addEventListener("click", function () {
        monthlyKind = monthlyKind === kind ? "" : kind;
        renderMonthly($("monthFilter").value);
        // 다시 그린 버튼으로 포커스를 복원해 키보드로 연속 선택할 수 있게 한다.
        $("monthlyCounts").querySelector('[data-kind="' + kind + '"]').focus({ preventScroll: true });
      });
      countsBox.appendChild(button);
    }
  }

  function eventsForKind(summary, kind) {
    if (!summary) return [];
    if (!kind) return summary.top_decreases || [];
    return (summary.events || []).filter(function (event) {
      return event.kind === kind;
    });
  }

  function returnedPriceText(change) {
    const prev = displayPrice(change.prev);
    const price = displayPrice(change.price);
    const delta = prev === null || prev === undefined || price === null || price === undefined
      ? change.delta
      : price - prev;
    const diff = delta === 0 ? "종료 전과 동일" : "종료 전 대비 " +
      (delta > 0 ? "+" : "−") + won(Math.abs(delta));
    return won(prev) + " → " + won(price) + " (" + diff + ")";
  }

  function renderChangeList(list, changes, emptyText, showDate) {
    list.textContent = "";
    if (!changes.length) {
      const empty = document.createElement("li");
      empty.className = "recent-empty";
      empty.textContent = emptyText;
      list.appendChild(empty);
      return;
    }

    const labels = CHANGE_LABELS;
    for (const change of changes) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-item";

      const kind = document.createElement("span");
      kind.className = "kind" + (change.kind === "decrease" ? " good" : change.kind === "increase" ? " bad" : "");
      kind.textContent = labels[change.kind] || change.kind;
      btn.appendChild(kind);

      if (change.category) {
        const cat = document.createElement("span");
        cat.className = "rcat";
        cat.textContent = change.category;
        btn.appendChild(cat);
      }

      const name = document.createElement("span");
      name.className = "rname";
      name.textContent = change.name + (showDate ? " · " + mmdd(change.date) : "");
      btn.appendChild(name);

      const value = document.createElement("span");
      value.className = "rval" + (change.kind === "decrease" ? " good" : change.kind === "increase" ? " bad" : "");
      if (change.kind === "returned") {
        value.textContent = returnedPriceText(change);
      } else if (change.kind === "new") {
        value.textContent = displayWon(change.price);
      } else if (change.kind === "removed") {
        value.textContent = displayWon(change.prev);
      } else {
        const prev = displayPrice(change.prev);
        const price = displayPrice(change.price);
        const delta = change.delta === null || change.delta === undefined ? change.delta : price - prev;
        const sign = delta > 0 ? "+" : "-";
        value.textContent = showDate
          ? won(prev) + " → " + won(price) + " (" + sign + won(Math.abs(delta)) + ")"
          : sign + fmt(Math.abs(delta)) + "원";
      }
      btn.appendChild(value);

      btn.addEventListener("click", function () {
        const target = items[change.index];
        if (target) openChart(target);
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function renderMonthly(month) {
    const summaries = DATA.monthly || [];
    const summary = summaries.find(function (entry) { return entry.month === month; }) || summaries[0];
    const select = $("monthFilter");
    if (!select.options.length) {
      summaries.forEach(function (entry) {
        const option = document.createElement("option");
        option.value = entry.month;
        option.textContent = entry.month.replace("-", "년 ") + "월";
        select.appendChild(option);
      });
    }
    select.disabled = !summary;
    if (!summary) {
      monthlyKind = "";
      $("monthlySub").textContent = "아직 수집 기록이 없습니다.";
      renderChangeCounts($("monthlyCounts"), {});
      renderChangeList($("monthlyList"), [], "기록이 쌓이면 인하 항목이 표시됩니다.");
      return;
    }
    // 달을 바꿨을 때 이전 달에만 있던 종류가 선택된 채로 남지 않게 한다.
    if (monthlyKind && !(summary.counts || {})[monthlyKind]) monthlyKind = "";
    select.value = summary.month;
    $("monthlySub").textContent = summary.first_date + " ~ " + summary.last_date + " · " +
      summary.days + "일 수집 · 변동 " + fmt(summary.total) + "건. 수집일 간 변동 횟수 기준입니다." +
      (summary.includes_baseline ? " 첫 수집일은 기준 데이터로 건수에서 제외합니다." : " 월 첫 수집은 직전 수집일과 비교합니다.");
    renderChangeCounts($("monthlyCounts"), summary.counts);

    const title = $("monthlyListTitle");
    const hint = $("monthlyListHint");
    if (monthlyKind) {
      const changes = eventsForKind(summary, monthlyKind);
      const label = CHANGE_LABELS[monthlyKind] || monthlyKind;
      if (title) title.textContent = label + " " + fmt(changes.length) + "건";
      if (hint) hint.textContent = "이달 " + label + " 항목 전체 · 최근 날짜순 · 같은 시술의 반복 변동도 각각 표시합니다. 항목을 누르면 가격 추이가 열립니다.";
      $("monthlyDetails").open = true;
      renderChangeList($("monthlyList"), changes, MONTHLY_EMPTY[monthlyKind] || "해당 항목이 없습니다.", true);
      return;
    }
    if (title) title.textContent = "인하 금액 TOP 5";
    if (hint) hint.textContent = "시술별 가장 큰 1회 인하 기준 · 재등장 가격 차이는 제외";
    renderChangeList($("monthlyList"), summary.top_decreases, "이달에 관측된 가격 인하가 없습니다.", true);
  }

  function renderStale() {
    if (!DATA.last_date) return;
    const last = Date.parse(DATA.last_date + "T00:00:00+09:00");
    const days = Math.floor((Date.now() - last) / 86400000);
    if (days < 2) return;
    $("staleDays").textContent = fmt(days);
    if (DATA.repo_url) {
      $("actionsLink").href = DATA.repo_url.replace(/\/$/, "") + "/actions";
    }
    $("staleNotice").hidden = false;
  }

  function renderDeadline() {
    const box = $("eventDeadline");
    if (!box) return;
    const info = eventDday(EVENT_PERIOD, todayKst());
    if (!info) {
      box.hidden = true;
      return;
    }
    const badge = $("deadlineBadge");
    const text = $("deadlineText");
    box.classList.remove("ended", "upcoming");
    if (info.phase === "after") {
      badge.textContent = "종료";
      text.textContent = "이벤트가 " + mmdd(EVENT_PERIOD.end) + "에 종료되었습니다 · 가격이 갱신됐을 수 있습니다.";
      box.classList.add("ended");
    } else if (info.phase === "before") {
      badge.textContent = "D-" + info.days;
      text.textContent = "이벤트 시작까지 " + info.days + "일 · " + periodText(EVENT_PERIOD);
      box.classList.add("upcoming");
    } else if (info.days === 0) {
      badge.textContent = "D-DAY";
      text.textContent = "오늘 이벤트가 종료됩니다 · " + periodText(EVENT_PERIOD);
    } else {
      badge.textContent = "D-" + info.days;
      text.textContent = "이벤트 종료까지 " + info.days + "일 · " + periodText(EVENT_PERIOD);
    }
    box.hidden = false;
  }

  function buildCategoryChips() {
    const chips = $("categoryChips");
    const categories = Array.from(new Set(items.map((item) => item.category))).sort(function (a, b) {
      return a.localeCompare(b, "ko");
    });
    function addChip(value, label) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.category = value;
      button.textContent = label;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", function () {
        state.category = value;
        renderTable();
        syncUrl(true);
      });
      chips.appendChild(button);
    }
    addChip("", "전체보기");
    for (const category of categories) {
      addChip(category, category || "기타");
    }
  }

  function syncCategoryChips(scrollToActive) {
    const strip = $("categoryChips");
    let active = null;
    strip.querySelectorAll("button").forEach(function (button) {
      const on = button.dataset.category === state.category;
      button.setAttribute("aria-pressed", String(on));
      if (on) active = button;
    });
    if (!scrollToActive || !active) return;
    const stripRect = strip.getBoundingClientRect();
    const chipRect = active.getBoundingClientRect();
    strip.scrollLeft += chipRect.left - stripRect.left - (strip.clientWidth - chipRect.width) / 2;
  }

  function buildBudgetChips() {
    const strip = $("budgetChips");
    if (!strip) return;
    BUDGET_OPTIONS.forEach(function (option) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.budget = option.value;
      button.textContent = option.label;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", function () {
        state.budget = option.value;
        renderTable();
        updateFilterDot();
        syncUrl(true);
      });
      strip.appendChild(button);
    });
  }

  function syncBudgetChips(scrollToActive) {
    const strip = $("budgetChips");
    if (!strip) return;
    let active = null;
    strip.querySelectorAll("button").forEach(function (button) {
      const on = button.dataset.budget === state.budget;
      button.setAttribute("aria-pressed", String(on));
      if (on) active = button;
    });
    if (!scrollToActive || !active) return;
    const stripRect = strip.getBoundingClientRect();
    const chipRect = active.getBoundingClientRect();
    strip.scrollLeft += chipRect.left - stripRect.left - (strip.clientWidth - chipRect.width) / 2;
  }

  function matches(item) {
    if (state.status === "active" && !item.active) return false;
    if (state.status === "ended" && item.active) return false;
    if (state.changedOnly && !changedIndexes.has(item.idx)) return false;
    if (state.favoritesOnly && !favorites.has(itemKey(item))) return false;
    if (state.category && item.category !== state.category) return false;
    if (!matchesQuery(item, state.q)) return false;
    if (!matchesBudget(item, state.budget)) return false;
    return true;
  }

  function compareName(a, b) {
    return a.name.localeCompare(b.name, "ko");
  }

  function sortItems(list) {
    const sorted = list.slice();
    if (state.sort === "recent") {
      sorted.sort(function (a, b) {
        const ca = latestChange(a);
        const cb = latestChange(b);
        if (!ca && !cb) return compareName(a, b);
        if (!ca) return 1;
        if (!cb) return -1;
        if (ca.date !== cb.date) return ca.date < cb.date ? 1 : -1;
        return Math.abs(cb.delta) - Math.abs(ca.delta);
      });
    } else if (state.sort === "discount-desc") {
      sorted.sort(function (a, b) {
        const da = a.discount_rate || discountRate(a) || 0;
        const db = b.discount_rate || discountRate(b) || 0;
        if (da !== db) return db - da;
        return compareName(a, b);
      });
    } else if (state.sort === "price-desc") {
      sorted.sort(function (a, b) { return currentPrice(b) - currentPrice(a); });
    } else if (state.sort === "price-asc") {
      sorted.sort(function (a, b) { return currentPrice(a) - currentPrice(b); });
    } else if (state.sort === "unit-asc") {
      sorted.sort(function (a, b) {
        const ua = unitPriceValue(a);
        const ub = unitPriceValue(b);
        if (ua === null && ub === null) return compareName(a, b);
        if (ua === null) return 1;
        if (ub === null) return -1;
        if (ua !== ub) return ua - ub;
        return compareName(a, b);
      });
    } else if (state.sort === "name") {
      sorted.sort(compareName);
    } else {
      sorted.sort(function (a, b) {
        return a.category.localeCompare(b.category, "ko") || compareName(a, b);
      });
    }
    return sorted;
  }

  function td(text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function makeSpan(text, className, title) {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    if (title) node.title = title;
    return node;
  }

  function makeBadge(text, modifier, title) {
    return makeSpan(text, "badge" + (modifier ? " " + modifier : ""), title);
  }

  function makeExtra(text, modifier) {
    return makeSpan(text, "event-extra" + (modifier ? " " + modifier : ""));
  }

  function buildCategoryCell(item) {
    const cell = document.createElement("td");
    const chip = makeSpan(item.category || "기타", "chip");
    chip.title = item.category;
    cell.appendChild(chip);
    return cell;
  }

  function buildNameCell(item) {
    const cell = document.createElement("td");
    cell.appendChild(makeSpan(item.name, "name-text"));
    if (item.active && item.returned) {
      cell.appendChild(makeBadge(
        "재등장 · " + mmdd(item.returned.date),
        "returned",
        returnedPriceText(item.returned)
      ));
    }
    if (!item.active) cell.appendChild(makeBadge("종료"));
    return cell;
  }

  function buildPriceCell(item, range) {
    const cur = currentPrice(item);
    const cell = td(displayWon(cur), "num price");
    if (!item.active) cell.title = "마지막으로 확인된 가격";

    const hasRange = range.max > range.min;
    const atl = item.all_time_low !== undefined ? item.all_time_low : range.min;
    const isAtl = hasRange && item.points.length >= 2 && cur <= atl;

    if (isAtl) {
      cell.appendChild(makeBadge("역대 최저", "low", "수집 이래 가장 낮은 가격입니다."));
    } else if (isLow30(item)) {
      cell.appendChild(makeBadge("30일 최저", "low", "최근 30일 중 가장 낮은 가격입니다."));
    }

    const rate = item.discount_rate !== undefined ? item.discount_rate : discountRate(item);
    if (rate !== null && rate > 0) {
      const rateBadge = makeBadge(rate + "% 할인");
      rateBadge.style.color = "var(--down)";
      rateBadge.style.borderColor = "rgba(200, 51, 104, .3)";
      cell.appendChild(rateBadge);
    }

    const unitText = unitPriceText(item);
    if (unitText) cell.appendChild(makeSpan(unitText, "unit-price"));
    return cell;
  }

  function buildDeltaCell(item) {
    const change = latestChange(item);
    const cell = td("", "num " + (change === null ? "flat" : change.delta < 0 ? "good" : "bad"));
    if (change === null) {
      cell.textContent = "—";
    } else {
      cell.appendChild(document.createTextNode(deltaText(item)));
      cell.appendChild(makeSpan(" · " + mmdd(change.date), "small"));
    }
    return cell;
  }

  function buildRangeCell(range) {
    return td(fmt(displayPrice(range.min)) + " / " + fmt(displayPrice(range.max)), "num small");
  }

  function buildSparkCell(item) {
    const cell = document.createElement("td");
    cell.className = "spark";
    cell.appendChild(sparkline(item));
    return cell;
  }

  function renderRow(item) {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.tabIndex = 0;
    tr.setAttribute("aria-label", item.name + " 가격 추이 보기");

    const range = priceRange(item);
    tr.appendChild(buildCategoryCell(item));
    tr.appendChild(buildNameCell(item));
    tr.appendChild(buildPriceCell(item, range));
    tr.appendChild(buildDeltaCell(item));
    tr.appendChild(buildRangeCell(range));
    tr.appendChild(buildSparkCell(item));

    tr.addEventListener("click", function () { openChart(item); });
    tr.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openChart(item);
      }
    });
    return tr;
  }

  function buildEventBanner(category) {
    const label = category || "이벤트";
    const banner = document.createElement("div");
    banner.className = "event-banner";
    let bannerFile = "";
    if (label.includes("첫방문")) bannerFile = "assets/first-visit-banner.jpg";
    else if (label.includes("이달의 단독")) bannerFile = "assets/monthly-banner.jpg";
    if (bannerFile) {
      const img = document.createElement("img");
      img.src = bannerFile;
      img.alt = label + " 이벤트 배너";
      img.loading = "lazy";
      img.decoding = "async";
      banner.appendChild(img);
    } else {
      banner.classList.add("generic");
      const prefix = makeSpan("LIMITED EVENT", "");
      const title = document.createElement("h3");
      title.className = "event-banner-title";
      title.textContent = label;
      banner.append(prefix, title);
    }
    return banner;
  }

  function buildEventLine(item, compact) {
    const cur = currentPrice(item);
    const line = document.createElement("button");
    line.type = "button";
    line.className = "event-line";
    line.setAttribute("aria-label", item.name + " 가격 추이 보기");
    const top = document.createElement("span");
    top.className = "event-line-top";
    const prices = document.createElement("span");
    prices.className = "event-prices";
    const listPrice = makeSpan("", "event-list-price");
    listPrice.textContent = item.list_price > cur ? displayWon(item.list_price) : "";
    const salePrice = makeSpan(displayWon(cur), "event-sale-price");
    prices.append(listPrice, salePrice);
    const name = document.createElement("span");
    name.className = "event-name";
    const openHint = makeSpan("↗", "event-open");
    openHint.setAttribute("aria-hidden", "true");
    name.append(makeSpan(item.name, "event-name-text"), openHint);
    if (compact) {
      top.append(makeSpan(item.category || "이벤트", "event-category"), prices);
      line.append(top, name);
    } else {
      // 그룹 카드에서는 배너에 카테고리가 이미 있으므로 시술명을 제목 줄로 올린다.
      top.append(name, prices);
      line.appendChild(top);
    }
    if (item.active && item.returned) {
      line.appendChild(makeExtra(
        "재등장 · " + mmdd(item.returned.date) + " · " + returnedPriceText(item.returned),
        "returned"
      ));
    }
    if (!item.active || isLow30(item)) {
      line.appendChild(makeExtra(item.active ? "30일 최저" : "종료된 이벤트 · 마지막 확인가"));
    }
    const unitText = unitPriceText(item);
    if (unitText) line.appendChild(makeExtra(unitText, "unit"));
    line.addEventListener("click", function () { openChart(item); });
    return line;
  }

  function buildMoreToggle(category, lines) {
    if (lines.length <= 2) return null;
    const initiallyExpanded = expandedCategories.has(category);
    const more = document.createElement("button");
    more.type = "button";
    more.className = "event-more";
    const chevron = makeSpan(initiallyExpanded ? "⌃" : "⌄", "");
    lines.slice(2).forEach(function (line) { line.hidden = !initiallyExpanded; });
    more.append(initiallyExpanded ? "접기 " : "펼치기 ", chevron);
    more.setAttribute("aria-expanded", String(initiallyExpanded));
    more.addEventListener("click", function () {
      const expanded = more.getAttribute("aria-expanded") === "true";
      lines.slice(2).forEach(function (line) { line.hidden = expanded; });
      if (expanded) expandedCategories.delete(category);
      else expandedCategories.add(category);
      more.setAttribute("aria-expanded", String(!expanded));
      more.firstChild.textContent = expanded ? "펼치기 " : "접기 ";
      chevron.textContent = expanded ? "⌄" : "⌃";
      updateExpandAllButton();
    });
    return more;
  }

  function buildCompactFoot(item) {
    const foot = document.createElement("div");
    foot.className = "event-compact-foot";
    const rate = discountRate(item);
    if (rate !== null) foot.appendChild(makeSpan(rate + "% 할인", "event-compact-rate"));
    foot.appendChild(sparkline(item));
    return foot;
  }

  function renderEventCard(category, entries, options) {
    const compact = !!(options && options.compact);
    const card = document.createElement("article");
    card.className = "event-card" + (compact ? " compact" : "");
    card.setAttribute("aria-label", (category || "이벤트") + " 가격 목록");
    if (!compact) card.appendChild(buildEventBanner(category));

    const body = document.createElement("div");
    body.className = "event-card-body";
    const lines = entries.map(function (item) {
      const line = buildEventLine(item, compact);
      body.appendChild(line);
      return line;
    });
    const more = buildMoreToggle(category, lines);
    if (more) body.appendChild(more);
    if (compact) body.appendChild(buildCompactFoot(entries[0]));
    card.appendChild(body);
    return card;
  }

  function expandableCategories() {
    const counts = new Map();
    currentPageItems.forEach(function (item) {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    });
    const result = [];
    counts.forEach(function (count, category) {
      if (count > 2) result.push(category);
    });
    return result;
  }

  function updateExpandAllButton() {
    const button = $("expandAllToggle");
    const visible = state.view === "cards" && state.sort === "category";
    button.hidden = !visible;
    if (!visible) return;
    const categories = expandableCategories();
    const expanded = categories.length > 0 && categories.every(function (category) {
      return expandedCategories.has(category);
    });
    button.textContent = expanded ? "전체 접기" : "전체 펼치기";
    button.setAttribute("aria-pressed", String(expanded));
  }

  function groupItemsByBoundary(list, limit) {
    // 카테고리 카드가 페이지 경계에서 쪼개지지 않도록 카테고리 단위로 자른다.
    const groups = [];
    let loaded = 0;
    for (const item of list) {
      const last = groups[groups.length - 1];
      const sameCategory = last && last[0] === item.category;
      if (!sameCategory && loaded >= limit) break;
      if (sameCategory) last[1].push(item);
      else groups.push([item.category, [item]]);
      loaded += 1;
    }
    return groups;
  }

  function renderTable(resetPaging) {
    if (resetPaging !== false) {
      displayLimit = state.pageSize;
    }
    const body = $("rows");
    body.textContent = "";
    const grid = $("eventGrid");
    grid.textContent = "";
    const fragment = document.createDocumentFragment();
    currentFilteredList = sortItems(items.filter(matches));
    if (state.dedupe) currentFilteredList = dedupeItems(currentFilteredList);
    syncCategoryChips(false);
    syncBudgetChips(false);
    let pageItems;
    let groups = null;
    if (state.sort === "category") {
      groups = groupItemsByBoundary(currentFilteredList, displayLimit);
      pageItems = [];
      for (const group of groups) pageItems = pageItems.concat(group[1]);
    } else {
      pageItems = currentFilteredList.slice(0, displayLimit);
    }
    currentPageItems = pageItems;
    const cardsView = state.view === "cards";
    $("tableWrap").hidden = cardsView;
    grid.hidden = !cardsView;
    $("viewToggle").textContent = cardsView ? "표로 보기" : "카드로 보기";
    $("viewToggle").setAttribute("aria-pressed", String(!cardsView));
    if (cardsView) {
      if (groups) {
        groups.forEach(function (group) { fragment.appendChild(renderEventCard(group[0], group[1])); });
      } else {
        pageItems.forEach(function (item) { fragment.appendChild(renderEventCard(item.category, [item], { compact: true })); });
      }
      grid.appendChild(fragment);
    } else {
      for (const item of pageItems) fragment.appendChild(renderRow(item));
      body.appendChild(fragment);
    }

    $("empty").hidden = currentFilteredList.length > 0;
    $("count").textContent = currentFilteredList.length > pageItems.length
      ? fmt(pageItems.length) + "개 불러옴 / 전체 " + fmt(currentFilteredList.length) + "개"
      : fmt(currentFilteredList.length) + "개";

    const loadMoreWrap = $("loadMoreWrap");
    const remaining = currentFilteredList.length - pageItems.length;
    if (remaining > 0) {
      loadMoreWrap.hidden = false;
      $("loadMoreStep").textContent = fmt(Math.min(state.pageSize, remaining));
      $("loadMoreCount").textContent = fmt(remaining);
    } else {
      loadMoreWrap.hidden = true;
    }
    updateExpandAllButton();
  }

  function renderChartHero(item, last, peers) {
    $("chartPriceLabel").textContent = item.active === false ? "마지막 확인가" : "현재가";
    $("chartPriceBasis").textContent = state.vatIncluded ? "VAT 포함" : "VAT 별도";
    $("chartPrice").textContent = displayWon(last[1]);

    const listPrice = $("chartListPrice");
    listPrice.hidden = !(item.list_price > last[1]);
    listPrice.textContent = listPrice.hidden ? "" : "정가 " + displayWon(item.list_price);

    const rate = item.discount_rate !== undefined ? item.discount_rate : discountRate(item);
    const discount = $("chartDiscount");
    discount.hidden = listPrice.hidden || !(rate > 0);
    discount.textContent = discount.hidden ? "" : rate + "% 할인";

    const unit = $("chartUnit");
    const unitText = unitPriceText(item, peers);
    unit.textContent = unitText;
    unit.hidden = unitText === "";
  }

  function renderPackageCompare(item, peers) {
    const tbody = $("packageRows");
    tbody.textContent = "";
    $("packageCompare").hidden = peers.length < 2;
    if (peers.length < 2) return;

    let bestUnit = Infinity;
    for (const peer of peers) {
      if (peer.active === false) continue;
      bestUnit = Math.min(bestUnit, displayPrice(currentPrice(peer)) / packageInfo(peer).count);
    }

    const fragment = document.createDocumentFragment();
    for (const peer of peers) {
      const info = packageInfo(peer);
      const tr = document.createElement("tr");
      const selected = peer === item;
      if (selected) tr.className = "selected-package";

      const countCell = document.createElement("th");
      countCell.scope = "row";
      countCell.textContent = info.count + "회";
      if (selected) {
        const status = document.createElement("span");
        status.className = "package-row-note";
        status.textContent = peer.active === false ? "선택 · 종료" : "선택";
        countCell.appendChild(status);
      }

      const price = currentPrice(peer);
      const unitCell = td(won(unitPriceValue(peer)), "num");
      if (peer.active !== false && displayPrice(price) / info.count === bestUnit) {
        const best = document.createElement("span");
        best.className = "package-row-note good";
        best.textContent = "회당 최저";
        unitCell.appendChild(best);
      }

      const comparison = packageComparison(peer, peers);
      const percent = comparison ? comparison.percent : 0;
      let savings = info.count === 1 && peer.active !== false ? "기준" : "—";
      if (comparison) {
        savings = percent > 0 ? percent + "% 저렴" : percent < 0 ? Math.abs(percent) + "% 비쌈" : "동일";
      }
      tr.append(countCell, td(displayWon(price), "num"), unitCell,
        td(savings, "num " + (percent > 0 ? "good" : percent < 0 ? "bad" : "flat")));
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
  }

  function renderChartSummary(item) {
    const last = item.points[item.points.length - 1];
    const first = item.points[0];
    $("chartLow").textContent = displayWon(item.all_time_low);
    $("chartAvg").textContent = displayWon(item.avg_price);
    $("chartLow30").textContent = displayWon(min30(item));

    const diff = displayPrice(last[1]) - displayPrice(first[1]);
    const delta = $("chartDelta");
    delta.className = diff > 0 ? "bad" : diff < 0 ? "good" : "";
    delta.textContent = item.points.length === 1 ? "—" : diff === 0 ? "변동 없음" :
      (diff > 0 ? "+" : "−") + won(Math.abs(diff));
  }

  function renderChartHistory(item, expanded) {
    const tbody = $("chartPoints");
    tbody.textContent = "";
    const fragment = document.createDocumentFragment();
    const start = expanded ? 0 : Math.max(0, item.points.length - CHART_PREVIEW_ROWS);
    for (let i = item.points.length - 1; i >= start; i -= 1) {
      const point = item.points[i];
      const tr = document.createElement("tr");
      tr.appendChild(td(point[0]));
      tr.appendChild(td(displayWon(point[1]), "num"));
      if (i === 0) {
        tr.appendChild(td("—", "num flat"));
      } else {
        const diff = displayPrice(point[1]) - displayPrice(item.points[i - 1][1]);
        tr.appendChild(td(
          diff === 0 ? "—" : (diff > 0 ? "+" : "-") + fmt(Math.abs(diff)) + "원",
          "num " + (diff === 0 ? "flat" : diff > 0 ? "bad" : "good")
        ));
      }
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);

    const toggle = $("chartHistoryToggle");
    toggle.hidden = item.points.length <= CHART_PREVIEW_ROWS;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "전체 이력 접기" : "전체 이력 펼치기 (" + fmt(item.points.length) + "건)";
  }

  function openChart(item, options) {
    const fromHistory = !!(options && options.fromHistory);
    const dialog = $("chartDialog");
    const last = item.points[item.points.length - 1];
    const peers = packagePeers(item);

    $("chartCat").textContent = (item.category || "기타") + (item.active ? "" : " · 종료된 항목");
    $("chartName").textContent = item.name;
    renderChartHero(item, last, peers);
    renderChartSummary(item);
    renderPackageCompare(item, peers);
    renderChartHistory(item, false);
    $("chartReturned").hidden = !item.returned;
    $("chartReturned").textContent = item.returned
      ? "최근 재등장 " + item.returned.date + " · " + returnedPriceText(item.returned) : "";
    $("chartCollected").dateTime = last[0];
    $("chartCollected").textContent = last[0];

    previousFocusElement = document.activeElement;
    openItemKey = itemKey(item);
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    updateScrollBtn();
    const closeBtn = $("chartClose");
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    drawChart(item);
    updateFavoritesUi();
    updateEstimateChart();
    if (fromHistory) {
      chartHistoryPushed = false;
    } else {
      syncUrl(true, openItemKey);
      chartHistoryPushed = true;
    }
  }

  function axisLabel(value) {
    if (value >= 10000) {
      const man = Math.round((value / 10000) * 10) / 10;
      return man + "만";
    }
    return fmt(Math.round(value));
  }

  function niceStep(span, targetTicks) {
    const raw = span / Math.max(1, targetTicks);
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / magnitude;
    let factor = 10;
    if (norm <= 1) factor = 1;
    else if (norm <= 2) factor = 2;
    else if (norm <= 2.5) factor = 2.5;
    else if (norm <= 5) factor = 5;
    return factor * magnitude;
  }

  const CHART_FONT = "system-ui, -apple-system, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  // 마지막 가격을 강조하는 말풍선
  const lastValuePill = {
    id: "lastValuePill",
    afterDatasetsDraw: function (chart, args, options) {
      if (!options || !options.text) return;
      const meta = chart.getDatasetMeta(0);
      const point = meta && meta.data[meta.data.length - 1];
      const area = chart.chartArea;
      if (!point || !area) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "700 11.5px " + CHART_FONT;
      const width = ctx.measureText(options.text).width + 18;
      const height = 22;
      const x = Math.min(Math.max(point.x - width / 2, area.left), area.right - width);
      let y = point.y - height - 10;
      if (y < area.top - 2) y = point.y + 12;
      roundedRect(ctx, x, y, width, height, 11);
      ctx.fillStyle = options.color;
      ctx.shadowColor = "rgba(0, 0, 0, .18)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(options.text, x + width / 2, y + height / 2 + 0.5);
      ctx.restore();
    }
  };

  // 역대 최저·평균 참조선의 왼쪽 라벨
  const refLabels = {
    id: "refLabels",
    afterDatasetsDraw: function (chart) {
      const area = chart.chartArea;
      if (!area) return;
      const ctx = chart.ctx;
      const drawn = [];
      chart.data.datasets.forEach(function (dataset, index) {
        if (!dataset.refLabel) return;
        const meta = chart.getDatasetMeta(index);
        const point = meta.data[meta.data.length - 1];
        if (!point) return;
        const x = area.left + 8;
        const y = point.y - 5;
        // 두 참조선이 가까우면 라벨이 겹치므로 뒤쪽 라벨은 생략한다(위 배지에 값이 있음).
        if (drawn.some(function (otherY) { return Math.abs(otherY - y) < 14; })) return;
        drawn.push(y);
        ctx.save();
        ctx.font = "700 10px " + CHART_FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        // 선과 겹쳐도 읽히도록 밝은 테두리를 먼저 그린다.
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255, 255, 255, .9)";
        ctx.strokeText(dataset.refLabel, x, y);
        ctx.fillStyle = dataset.refColor;
        ctx.fillText(dataset.refLabel, x, y);
        ctx.restore();
      });
    }
  };

  // 툴팁이 열렸을 때 세로 안내선
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw: function (chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements
        ? chart.tooltip.getActiveElements()
        : [];
      if (!active.length || !chart.chartArea) return;
      const point = active[0].element;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(128, 122, 125, .45)";
      ctx.moveTo(point.x, area.top);
      ctx.lineTo(point.x, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  // 가격이 한 번도 변하지 않았을 때의 안내 문구
  const flatNotice = {
    id: "flatNotice",
    afterDatasetsDraw: function (chart, args, options) {
      if (!options || !options.text || !chart.chartArea) return;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "600 11.5px " + CHART_FONT;
      ctx.fillStyle = cssVar("--muted") || "#807a7d";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(options.text, (area.left + area.right) / 2, area.top - 4);
      ctx.restore();
    }
  };

  let chartInstance = null;

  function chartBounds(shown, flat, compact) {
    const range = minMax(shown);
    let min = range.min;
    let max = range.max;
    if (flat) {
      const margin = Math.max(1000, Math.round(range.max * 0.06));
      min = Math.max(0, range.min - margin);
      max = range.max + margin;
    } else {
      const margin = (range.max - range.min) * 0.16;
      min = Math.max(0, range.min - margin);
      max = range.max + margin;
    }
    const step = niceStep(max - min || 1, compact ? 4 : 5);
    min = Math.max(0, Math.floor(min / step) * step);
    max = Math.ceil(max / step) * step;
    if (max <= min) max = min + step;
    return { min: min, max: max, step: step };
  }

  function buildChartDatasets(item, shown, color, palette, flat) {
    const flatColor = cssVar("--flat") || COLORS.flat;
    const datasets = [{
      label: item.name,
      data: shown,
      order: 1,
      borderColor: color,
      borderWidth: 2.6,
      cubicInterpolationMode: "monotone",
      fill: true,
      backgroundColor: function (context) {
        const area = context.chart.chartArea;
        if (!area) return withAlpha(color, 0.12);
        const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        gradient.addColorStop(0, withAlpha(color, 0.26));
        gradient.addColorStop(0.62, withAlpha(color, 0.07));
        gradient.addColorStop(1, withAlpha(color, 0));
        return gradient;
      },
      pointBackgroundColor: shown.map(function (_, i) {
        return i === shown.length - 1 ? color : palette.panel;
      }),
      pointBorderColor: shown.map(function (price, i) {
        if (i === 0) return flatColor;
        if (price > shown[i - 1]) return palette.up;
        if (price < shown[i - 1]) return palette.down;
        return flatColor;
      }),
      pointBorderWidth: shown.map(function (_, i) {
        return i === shown.length - 1 ? 2.4 : 1.8;
      }),
      pointRadius: shown.map(function (_, i) {
        return i === shown.length - 1 ? 5.5 : 3.6;
      }),
      pointHoverRadius: 7,
      pointHoverBorderWidth: 2.6,
      pointHitRadius: 16
    }];

    if (!flat) {
      if (item.all_time_low !== undefined) {
        datasets.push({
          label: "역대 최저",
          data: shown.map(function () { return displayPrice(item.all_time_low); }),
          order: 0,
          borderColor: palette.down,
          borderWidth: 1.2,
          borderDash: [2, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
          refLabel: "★ 역대 최저",
          refColor: palette.down
        });
      }
      if (item.avg_price !== undefined && item.points.length > 1) {
        datasets.push({
          label: "평균",
          data: shown.map(function () { return displayPrice(item.avg_price); }),
          order: 0,
          borderColor: palette.muted,
          borderWidth: 1.1,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
          refLabel: "평균 " + displayWon(item.avg_price),
          refColor: palette.muted
        });
      }
    }
    return datasets;
  }

  function chartScales(palette, compact, bounds) {
    return {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: palette.muted,
          font: { size: 10.5 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: compact ? 4 : 6,
          callback: function (value) {
            return mmdd(this.getLabelForValue(value));
          }
        }
      },
      y: {
        min: bounds.min,
        max: bounds.max,
        grid: { color: "rgba(128, 122, 125, .16)", drawTicks: false },
        border: { display: false },
        ticks: {
          stepSize: bounds.step,
          padding: 6,
          color: palette.muted,
          font: { size: 10.5 },
          callback: function (value) { return axisLabel(value); }
        }
      }
    };
  }

  function chartTooltip(shown) {
    return {
      filter: function (entry) { return entry.datasetIndex === 0; },
      backgroundColor: "rgba(36, 33, 36, .94)",
      titleColor: "#f4eef1",
      bodyColor: "#ffffff",
      titleFont: { size: 11, weight: "600" },
      bodyFont: { size: 13, weight: "700" },
      padding: 10,
      cornerRadius: 10,
      caretSize: 6,
      caretPadding: 8,
      displayColors: false,
      titleMarginBottom: 3,
      callbacks: {
        title: function (entries) { return entries.length ? entries[0].label : ""; },
        label: function (entry) { return won(entry.parsed.y); },
        afterLabel: function (entry) {
          const index = entry.dataIndex;
          if (index === 0) return "첫 기록";
          const prev = shown[index - 1];
          const diff = entry.parsed.y - prev;
          if (diff === 0) return "변동 없음";
          const pct = prev ? (Math.abs(diff) / prev) * 100 : 0;
          return (diff > 0 ? "▲ +" : "▼ -") + fmt(Math.abs(diff)) + "원 (" +
            (diff > 0 ? "+" : "-") + pct.toFixed(1) + "%)";
        }
      }
    };
  }

  function buildChartOptions(context) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 120,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 26, right: 6, bottom: 2 } },
      animation: prefersReducedMotion() ? false : { duration: 520, easing: "easeOutQuart" },
      scales: chartScales(context.palette, context.compact, context.bounds),
      plugins: {
        legend: { display: false },
        tooltip: chartTooltip(context.shown),
        lastValuePill: { text: won(context.shown[context.shown.length - 1]), color: context.color },
        flatNotice: { text: context.flat ? "수집 이래 가격 변동 없음 · " + context.pointCount + "일 기록" : "" }
      }
    };
  }

  function drawChart(item) {
    const canvas = $("chartCanvas");
    if (!canvas) return;
    const points = item.points;
    const labels = points.map(function (p) { return p[0]; });
    const values = priceValues(item);
    const shown = values.map(displayPrice);
    const first = points[0];
    const last = lastPoint(item);
    const rawRange = minMax(values);
    const shownRange = minMax(shown);
    const flat = shownRange.min === shownRange.max;

    canvas.setAttribute("aria-label",
      item.name + " 가격 추이: " + first[0] + " " + displayWon(first[1]) + "에서 " +
      last[0] + " " + displayWon(last[1]) + ", 최저 " + displayWon(rawRange.min) + ", 최고 " + displayWon(rawRange.max));

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    if (typeof Chart === "undefined") {
      // 차트 라이브러리를 못 불러와도 아래 가격 표는 그대로 볼 수 있게 한다.
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;

    const compact = window.innerWidth < 620;
    const color = trendColor(item);
    const palette = {
      muted: cssVar("--muted") || "#807a7d",
      panel: cssVar("--panel") || "#ffffff",
      down: cssVar("--down") || COLORS.down,
      up: cssVar("--up") || COLORS.up
    };
    const bounds = chartBounds(shown, flat, compact);

    const datasets = buildChartDatasets(item, shown, color, palette, flat);

    chartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: buildChartOptions({
        palette: palette,
        compact: compact,
        bounds: bounds,
        shown: shown,
        color: color,
        flat: flat,
        pointCount: points.length
      }),
      plugins: [lastValuePill, crosshair, refLabels, flatNotice]
    });
  }

  function closeDialog(options) {
    const fromHistory = !!(options && options.fromHistory);
    const dialog = $("chartDialog");
    if (dialog.open) dialog.close();
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    const hadKey = openItemKey;
    openItemKey = "";
    const toastBox = $("toast");
    if (toastBox && toastBox.parentNode && toastBox.parentNode !== document.body) {
      document.body.appendChild(toastBox);
    }
    updateScrollBtn();
    if (previousFocusElement && document.contains(previousFocusElement) && typeof previousFocusElement.focus === "function") {
      previousFocusElement.focus();
    }
    previousFocusElement = null;
    if (fromHistory || !hadKey) {
      chartHistoryPushed = false;
    } else if (chartHistoryPushed) {
      // 상세 창을 열 때 쌓은 방문 기록을 되돌려, 뒤로 가기 동작과 어긋나지 않게 한다.
      chartHistoryPushed = false;
      window.history.back();
    } else {
      syncUrl(false, "");
    }
  }

  function resetFilters() {
    state.q = "";
    state.category = "";
    state.budget = "";
    state.status = "active";
    state.changedOnly = false;
    state.favoritesOnly = false;
    state.dedupe = false;
    state.sort = "category";
    $("q").value = "";
    $("statusFilter").value = "active";
    $("sortFilter").value = "category";
    $("changedToggle").classList.remove("on");
    $("changedToggle").setAttribute("aria-pressed", "false");
    const dedupeToggle = $("dedupeToggle");
    if (dedupeToggle) {
      dedupeToggle.classList.remove("on");
      dedupeToggle.setAttribute("aria-pressed", "false");
    }
    syncBudgetChips();
    updateFavoritesUi();
    updateFilterDot();
    renderTable();
    syncUrl(true);
  }

  let toastTimer = null;

  function toast(message) {
    const box = $("toast");
    if (!box) return;
    // <dialog>는 최상위 레이어에 그려져 z-index만으로는 위에 올 수 없다.
    // 상세 창이 열려 있으면 토스트를 그 안으로 옮겨 화면에 보이게 한다.
    const dialog = $("chartDialog");
    const host = dialog && dialog.open ? dialog : document.body;
    if (box.parentNode !== host) host.appendChild(box);
    box.textContent = message;
    box.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { box.hidden = true; }, 2200);
  }

  function updateFavoritesUi() {
    const toggle = $("favoritesToggle");
    if (!toggle) return;
    const count = favorites.size;
    $("favoritesCount").textContent = String(count);
    toggle.hidden = count === 0 && !state.favoritesOnly;
    toggle.classList.toggle("on", state.favoritesOnly);
    toggle.setAttribute("aria-pressed", String(state.favoritesOnly));
    const star = $("chartFav");
    if (!star) return;
    const saved = openItemKey ? favorites.has(openItemKey) : false;
    star.setAttribute("aria-pressed", String(saved));
    star.textContent = saved ? "★" : "☆";
    const label = saved ? "관심 시술에서 빼기" : "관심 시술에 추가";
    star.setAttribute("aria-label", label);
    star.title = label;
  }

  function renderVatState() {
    const toggle = $("vatToggle");
    if (toggle) {
      toggle.classList.toggle("on", state.vatIncluded);
      toggle.setAttribute("aria-pressed", String(state.vatIncluded));
      toggle.title = state.vatIncluded
        ? "부가세 포함 결제 예상가로 표시 중입니다. 눌러서 VAT 별도로 전환합니다"
        : "부가세 10%를 더한 결제 예상가로 표시합니다";
    }
    const basis = $("priceBasis");
    if (basis) basis.textContent = state.vatIncluded ? "VAT 포함 결제 예상가" : "VAT 별도";
  }

  // 목록의 VAT 포함 토글과 계산기의 VAT 스위치를 한 번에 바꾼다.
  function applyVatIncluded(included) {
    state.vatIncluded = included;
    estimate.includeVat = included;
    saveVatIncluded(storageOrNull(), included);
    saveEstimate(storageOrNull(), estimate);
    renderVatState();
    renderTable(false);
    renderRecent();
    renderMonthly($("monthFilter").value || undefined);
    updateFilterDot();
    renderEstimate();
  }

  function updateFilterDot() {
    const dot = $("filterActiveDot");
    if (!dot) return;
    const isCustom = state.status !== "active" || state.changedOnly || state.dedupe || state.budget !== "" || state.vatIncluded || state.view !== "cards" || state.pageSize !== PAGE_SIZE;
    dot.hidden = !isCustom;
    const btn = $("filterMoreToggle");
    if (btn) {
      if (isCustom && !btn.classList.contains("on")) {
        btn.style.borderColor = "var(--accent)";
      } else if (!isCustom && !btn.classList.contains("on")) {
        btn.style.borderColor = "";
      }
    }
  }

  function setSummaryTab(tabName) {
    const tabs = {
      recent: { tab: $("tabRecent"), panel: $("recentPanel") },
      monthly: { tab: $("tabMonthly"), panel: $("monthlyPanel") },
      estimate: { tab: $("tabEstimate"), panel: $("estimatePanel") }
    };
    Object.keys(tabs).forEach(function (key) {
      const isTarget = key === tabName;
      if (tabs[key].tab) {
        tabs[key].tab.classList.toggle("active", isTarget);
        tabs[key].tab.setAttribute("aria-selected", String(isTarget));
      }
      if (tabs[key].panel) {
        tabs[key].panel.hidden = !isTarget;
        tabs[key].panel.classList.toggle("active", isTarget);
      }
    });
    const content = $("summaryContent");
    const collapseBtn = $("summaryCollapseBtn");
    if (content) content.classList.remove("collapsed");
    if (collapseBtn) collapseBtn.classList.remove("collapsed");
  }

  function initSummaryHub() {
    const tabRecent = $("tabRecent");
    const tabMonthly = $("tabMonthly");
    const tabEstimate = $("tabEstimate");
    const collapseBtn = $("summaryCollapseBtn");
    if (tabRecent) tabRecent.addEventListener("click", function () { setSummaryTab("recent"); });
    if (tabMonthly) tabMonthly.addEventListener("click", function () { setSummaryTab("monthly"); });
    if (tabEstimate) tabEstimate.addEventListener("click", function () { setSummaryTab("estimate"); });
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function () {
        const content = $("summaryContent");
        if (!content) return;
        const isCollapsed = content.classList.toggle("collapsed");
        this.classList.toggle("collapsed", isCollapsed);
        this.setAttribute("aria-expanded", String(!isCollapsed));
      });
    }
  }

  function initFilterDrawer() {
    const toggle = $("filterMoreToggle");
    const drawer = $("filterDrawer");
    if (!toggle || !drawer) return;
    toggle.addEventListener("click", function () {
      drawer.hidden = !drawer.hidden;
      toggle.classList.toggle("on", !drawer.hidden);
      toggle.setAttribute("aria-expanded", String(!drawer.hidden));
      updateFilterDot();
    });
  }

  function copyLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { toast("링크를 복사했습니다."); },
        function () { toast("주소창의 링크를 복사해 주세요."); }
      );
      return;
    }
    toast("주소창의 링크를 복사해 주세요.");
  }

  function shareChart() {
    const name = $("chartName").textContent;
    const url = window.location.href;
    if (navigator.share) {
      navigator.share({ title: name + " 가격 추이", text: name + " · " + document.title, url: url })
        .catch(function (error) {
          if (!error || error.name !== "AbortError") copyLink(url);
        });
      return;
    }
    copyLink(url);
  }

  function openChartFromUrl() {
    const target = findItemByKey(readItemKey(window.location.search));
    if (target) openChart(target, { fromHistory: true });
  }

  // Node 테스트(node --test)에서 순수 로직을 검증할 수 있도록 DOM 없이도 내보낸다.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = {
        DATA,
        PAGE_SIZE,
        state,
        items,
        favorites,
        changedIndexes,
        matches,
        sortItems,
        compareName,
        groupItemsByBoundary,
        parseUrlState,
        buildQuery,
        matchesBudget,
        BUDGET_OPTIONS,
        packageInfo,
        unitPriceValue,
        oneSessionPrice,
        packageComparison,
        unitPriceText,
        dedupeItems,
        duplicateRank,
        eventDday,
        todayKst,
        periodText,
        EVENT_PERIOD,
        itemKey,
        findItemByKey,
        readItemKey,
        loadFavorites,
        saveFavorites,
        loadVatIncluded,
        saveVatIncluded,
        THEME_KEY,
        loadTheme,
        saveTheme,
        getEffectiveTheme,
        applyTheme,
        vatPrice,
        displayPrice,
        displayWon,
        validQuantity,
        loadEstimate,
        saveEstimate,
        calculateEstimate,
        toChosung,
        matchesQuery,
        eventsForKind,
        discountRate,
        lastPoint,
        currentPrice,
        priceValues,
        minMax,
        priceRange,
        chartBounds,
        latestChange,
        overallDelta,
        min30,
        isLow30,
        trendColor,
        niceStep,
        axisLabel,
        withAlpha,
        won,
        returnedPriceText,
        mmdd
      };
    }
    return;
  }

  $("estimateAdd").addEventListener("click", function () {
    addToEstimate(findItemByKey(openItemKey));
  });
  $("estimateShow").addEventListener("click", function () {
    closeDialog();
    setSummaryTab("estimate");
    $("estimateDetails").open = true;
    $("estimateSummary").focus({ preventScroll: true });
    const hub = $("summaryHub");
    if (hub) hub.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $("estimateVat").addEventListener("change", function (event) {
    applyVatIncluded(event.target.checked);
  });
  $("estimateClear").addEventListener("click", function () {
    estimate.quantities.clear();
    saveEstimate(storageOrNull(), estimate);
    renderEstimate();
    $("estimateSummary").focus({ preventScroll: true });
  });

  $("loadMoreBtn").addEventListener("click", function () {
    displayLimit += state.pageSize;
    renderTable(false);
  });

  const scrollBtn = $("scrollTopBtn");
  let lastScrollY = window.scrollY;
  let scrollFrame = 0;

  // 아래로 읽는 중이거나 상세 창이 열려 있을 때는 시술명·가격을 가리지 않도록 숨긴다.
  function updateScrollBtn() {
    scrollFrame = 0;
    const y = window.scrollY;
    const goingDown = y > lastScrollY + 2;
    if (Math.abs(y - lastScrollY) > 2) lastScrollY = y;
    const dialogOpen = $("chartDialog").open;
    const show = y > 350 && !dialogOpen && !goingDown;
    scrollBtn.style.display = show ? "flex" : "none";
  }

  window.addEventListener("scroll", function () {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateScrollBtn);
  }, { passive: true });

  scrollBtn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("searchForm").addEventListener("submit", function (event) {
    // Enter로 제출해도 페이지를 새로 읽지 않고 현재 필터 결과를 유지한다.
    event.preventDefault();
    $("q").blur();
  });
  $("q").addEventListener("input", function (event) {
    window.clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = window.setTimeout(function () {
      state.q = value.trim();
      renderTable();
      syncUrl(false);
    }, 120);
  });
  $("statusFilter").addEventListener("change", function (event) {
    state.status = event.target.value;
    renderTable();
    updateFilterDot();
    syncUrl(true);
  });
  $("monthFilter").addEventListener("change", function (event) {
    monthlyKind = "";
    renderMonthly(event.target.value);
  });
  $("changedToggle").addEventListener("click", function () {
    state.changedOnly = !state.changedOnly;
    this.classList.toggle("on", state.changedOnly);
    this.setAttribute("aria-pressed", String(state.changedOnly));
    renderTable();
    updateFilterDot();
    syncUrl(true);
  });
  const dedupeToggle = $("dedupeToggle");
  if (dedupeToggle) {
    dedupeToggle.addEventListener("click", function () {
      state.dedupe = !state.dedupe;
      this.classList.toggle("on", state.dedupe);
      this.setAttribute("aria-pressed", String(state.dedupe));
      renderTable();
      updateFilterDot();
      syncUrl(true);
    });
  }
  $("favoritesToggle").addEventListener("click", function () {
    state.favoritesOnly = !state.favoritesOnly;
    renderTable();
    updateFavoritesUi();
    syncUrl(true);
  });
  $("sortFilter").addEventListener("change", function (event) {
    state.sort = event.target.value;
    renderTable();
    syncUrl(true);
  });
  $("pageSizeFilter").addEventListener("change", function (event) {
    state.pageSize = event.target.value === "all" ? Infinity : Number(event.target.value);
    renderTable();
    updateFilterDot();
    syncUrl(true);
  });
  $("expandAllToggle").addEventListener("click", function () {
    const categories = expandableCategories();
    const expanded = categories.length > 0 && categories.every(function (category) {
      return expandedCategories.has(category);
    });
    if (expanded) expandedCategories.clear();
    else categories.forEach(function (category) { expandedCategories.add(category); });
    renderTable(false);
  });
  $("viewToggle").addEventListener("click", function () {
    state.view = state.view === "cards" ? "table" : "cards";
    renderTable(false);
    updateFilterDot();
    syncUrl(true);
  });
  $("vatToggle").addEventListener("click", function () {
    applyVatIncluded(!state.vatIncluded);
  });
  $("resetFilters").addEventListener("click", resetFilters);
  $("chartClose").addEventListener("click", closeDialog);
  $("chartHistoryToggle").addEventListener("click", function (event) {
    const item = findItemByKey(openItemKey);
    if (item) renderChartHistory(item, event.currentTarget.getAttribute("aria-expanded") !== "true");
  });
  $("chartShare").addEventListener("click", shareChart);
  $("chartFav").addEventListener("click", function () {
    if (!openItemKey) return;
    const saved = favorites.has(openItemKey);
    if (saved) favorites.delete(openItemKey);
    else favorites.add(openItemKey);
    saveFavorites(storageOrNull(), favorites);
    if (saved && favorites.size === 0 && state.favoritesOnly) {
      state.favoritesOnly = false;
      renderTable(false);
      syncUrl(false, openItemKey);
    } else if (state.favoritesOnly) {
      renderTable(false);
    }
    updateFavoritesUi();
    toast(saved ? "관심 시술에서 뺐습니다." : "관심 시술에 추가했습니다.");
  });
  $("chartDialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeDialog();
  });
  $("chartDialog").addEventListener("click", function (event) {
    if (event.target === $("chartDialog")) closeDialog();
  });
  window.addEventListener("popstate", function () {
    const key = readItemKey(window.location.search);
    readUrlState();
    applyStateToControls();
    renderTable();
    if (key) {
      const target = findItemByKey(key);
      if (target) {
        openChart(target, { fromHistory: true });
        return;
      }
    }
    if ($("chartDialog").open) closeDialog({ fromHistory: true });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable) return;
    if ($("chartDialog").open) return;
    event.preventDefault();
    $("q").focus();
  });

  let installPromptEvent = null;

  // 홈 화면 추가(PWA)를 위해 서비스 워커를 등록한다. https 또는 localhost에서만 동작한다.
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function () {
        // 구형 사파리·사생활 보호 모드처럼 등록이 막힌 환경에서도 페이지는 그대로 쓴다.
      });
    });
  }

  function setupInstallButton() {
    const button = $("installBtn");
    if (!button) return;
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPromptEvent = event;
      button.hidden = false;
    });
    button.addEventListener("click", function () {
      if (!installPromptEvent) return;
      const prompt = installPromptEvent;
      installPromptEvent = null;
      button.hidden = true;
      prompt.prompt();
    });
    window.addEventListener("appinstalled", function () {
      installPromptEvent = null;
      button.hidden = true;
      toast("홈 화면에 추가했습니다.");
    });
  }

  function setupConnectionNotice() {
    window.addEventListener("offline", function () {
      toast("오프라인 · 저장된 가격을 보여줍니다.");
    });
    window.addEventListener("online", function () {
      toast("다시 연결되었습니다.");
    });
  }

  registerServiceWorker();
  setupInstallButton();
  setupConnectionNotice();
  // 오프라인 상태로 새로 열었을 때는 offline 이벤트가 발생하지 않으므로 직접 알린다.
  if (navigator.onLine === false) toast("오프라인 · 저장된 가격을 보여줍니다.");

  readUrlState();
  initTheme();
  initSummaryHub();
  initFilterDrawer();
  renderVatState();
  renderStats();
  renderRecent();
  renderMonthly();
  renderEstimate();
  renderStale();
  renderDeadline();
  buildCategoryChips();
  buildBudgetChips();
  applyStateToControls();
  updateFilterDot();
  renderTable();
  const initialItemKey = readItemKey(window.location.search);
  if (initialItemKey) {
    openChartFromUrl();
    if (!openItemKey) syncUrl(false, "");
  } else {
    syncUrl(false);
  }
})();
