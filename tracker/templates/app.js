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
  const changedIndexes = new Set((RECENT.items || []).map(function (change) { return change.index; }));
  const PAGE_SIZE = 40;
  const state = { q: "", category: "", status: "active", changedOnly: false, sort: "category", view: "cards", pageSize: PAGE_SIZE };
  let displayLimit = PAGE_SIZE;
  const expandedCategories = new Set();
  let currentFilteredList = [];
  let currentPageItems = [];
  let searchTimer = null;
  let previousFocusElement = null;

  const $ = (id) => document.getElementById(id);

  const SORT_VALUES = ["category", "recent", "discount-desc", "price-desc", "price-asc", "name"];

  function parseUrlState(search) {
    const next = {
      q: "",
      category: "",
      status: "active",
      changedOnly: false,
      sort: "category",
      view: "cards",
      pageSize: PAGE_SIZE
    };
    const params = new URLSearchParams(search || "");
    const q = params.get("q");
    if (q) next.q = q;
    const category = params.get("category");
    if (category) next.category = category;
    const status = params.get("status");
    if (status === "active" || status === "ended" || status === "all") next.status = status;
    if (params.get("changed") === "1") next.changedOnly = true;
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

  function buildQuery(current) {
    const params = new URLSearchParams();
    if (current.q) params.set("q", current.q);
    if (current.category) params.set("category", current.category);
    if (current.status !== "active") params.set("status", current.status);
    if (current.changedOnly) params.set("changed", "1");
    if (current.sort !== "category") params.set("sort", current.sort);
    if (current.view !== "cards") params.set("view", "table");
    if (current.pageSize !== PAGE_SIZE) params.set("limit", current.pageSize === Infinity ? "all" : String(current.pageSize));
    return params.toString();
  }

  function syncUrl(push) {
    const query = buildQuery(state);
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
    $("statusFilter").value = state.status;
    $("sortFilter").value = state.sort;
    $("pageSizeFilter").value = state.pageSize === Infinity ? "all" : String(state.pageSize);
    $("changedToggle").classList.toggle("on", state.changedOnly);
    $("changedToggle").setAttribute("aria-pressed", String(state.changedOnly));
    $("viewToggle").textContent = state.view === "cards" ? "표로 보기" : "카드로 보기";
    $("viewToggle").setAttribute("aria-pressed", String(state.view === "table"));
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

  function currentPrice(item) {
    return item.points[item.points.length - 1][1];
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
    return Math.min.apply(null, points.map(function (p) { return p[1]; }));
  }

  function isLow30(item) {
    if (!DATA.last_date || (DATA.days || 0) < 2) return false;
    const cutoff = cutoff30();
    const points = item.points.filter(function (p) { return p[0] >= cutoff; });
    if (points.length < 2) return false;
    const prices = points.map(function (p) { return p[1]; });
    const min = Math.min.apply(null, prices);
    const max = Math.max.apply(null, prices);
    // 가격이 한 번도 변하지 않았으면 '최저' 배지를 붙이지 않는다.
    if (max <= min) return false;
    return currentPrice(item) <= min;
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
    const values = points.map((p) => p[1]);
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
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
    title.textContent = points.length + "일 기록 · " + won(points[points.length - 1][1]);
    svg.appendChild(title);
    return svg;
  }

  function deltaText(item) {
    const change = latestChange(item);
    if (change === null) return "—";
    const pct = change.prev ? (change.delta / change.prev) * 100 : null;
    const sign = change.delta > 0 ? "+" : "-";
    const abs = fmt(Math.abs(change.delta));
    return (change.delta > 0 ? "▲ " : "▼ ") + abs + "원" + (pct === null ? "" : " (" + sign + Math.abs(pct).toFixed(1) + "%)");
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
    if (DATA.repo_url) {
      const base = DATA.repo_url.replace(/\/$/, "");
      $("changesLink").href = base + "/blob/HEAD/CHANGES.md";
      $("historyLink").href = base + "/blob/HEAD/history.csv";
      $("pricesLink").href = base + "/blob/HEAD/prices.json";
    }
  }

  function renderRecent() {
    const sub = $("recentSub");
    const countsBox = $("recentCounts");
    const list = $("recentList");
    countsBox.textContent = "";
    list.textContent = "";

    if (RECENT.baseline) {
      sub.textContent = RECENT.date
        ? mmdd(RECENT.date) + " 기준 데이터를 저장했습니다. 다음 수집부터 변동이 표시됩니다."
        : "아직 수집 기록이 없습니다.";
      return;
    }

    sub.textContent = (RECENT.prev_date ? mmdd(RECENT.prev_date) : "직전") + " → " + mmdd(RECENT.date) + " 비교";

    renderChangeCounts(countsBox, RECENT.counts || {});
    renderChangeList(list, RECENT.items, "직전 수집 대비 변동이 없습니다.");
  }

  function renderChangeCounts(countsBox, counts) {
    countsBox.textContent = "";
    const kinds = [
      ["decrease", "인하", "good"],
      ["increase", "인상", "bad"],
      ["new", "신규", ""],
      ["returned", "재등장", ""],
      ["removed", "종료", ""]
    ];
    for (const entry of kinds) {
      const count = counts[entry[0]] || 0;
      const span = document.createElement("span");
      span.className = "count" + (count ? " " + entry[2] : " zero");
      span.textContent = entry[1] + " " + fmt(count);
      countsBox.appendChild(span);
    }
  }

  function returnedPriceText(change) {
    const diff = change.delta === 0 ? "종료 전과 동일" : "종료 전 대비 " +
      (change.delta > 0 ? "+" : "−") + won(Math.abs(change.delta));
    return won(change.prev) + " → " + won(change.price) + " (" + diff + ")";
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

    const labels = { decrease: "인하", increase: "인상", new: "신규", returned: "재등장", removed: "종료" };
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
        value.textContent = won(change.price);
      } else if (change.kind === "removed") {
        value.textContent = won(change.prev);
      } else {
        const sign = change.delta > 0 ? "+" : "-";
        value.textContent = showDate
          ? won(change.prev) + " → " + won(change.price) + " (" + sign + won(Math.abs(change.delta)) + ")"
          : sign + fmt(Math.abs(change.delta)) + "원";
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
      $("monthlySub").textContent = "아직 수집 기록이 없습니다.";
      renderChangeCounts($("monthlyCounts"), {});
      renderChangeList($("monthlyList"), [], "기록이 쌓이면 인하 항목이 표시됩니다.");
      return;
    }
    select.value = summary.month;
    $("monthlySub").textContent = summary.first_date + " ~ " + summary.last_date + " · " +
      summary.days + "일 수집 · 변동 " + fmt(summary.total) + "건. 수집일 간 변동 횟수 기준입니다." +
      (summary.includes_baseline ? " 첫 수집일은 기준 데이터로 건수에서 제외합니다." : " 월 첫 수집은 직전 수집일과 비교합니다.");
    renderChangeCounts($("monthlyCounts"), summary.counts);
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

  function matches(item) {
    if (state.status === "active" && !item.active) return false;
    if (state.status === "ended" && item.active) return false;
    if (state.changedOnly && !changedIndexes.has(item.idx)) return false;
    if (state.category && item.category !== state.category) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!item.name.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) return false;
    }
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

  function renderRow(item) {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.tabIndex = 0;
    tr.setAttribute("aria-label", item.name + " 가격 추이 보기");

    const catCell = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item.category || "기타";
    chip.title = item.category;
    catCell.appendChild(chip);

    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "name-text";
    name.textContent = item.name;
    nameCell.appendChild(name);
    if (item.active && item.returned) {
      const badge = document.createElement("span");
      badge.className = "badge returned";
      badge.textContent = "재등장 · " + mmdd(item.returned.date);
      badge.title = returnedPriceText(item.returned);
      nameCell.appendChild(badge);
    }
    if (!item.active) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "종료";
      nameCell.appendChild(badge);
    }

    const priceCell = td(won(currentPrice(item)), "num price");
    if (!item.active) priceCell.title = "마지막으로 확인된 가격";

    const cur = currentPrice(item);
    const values = item.points.map(function (p) { return p[1]; });
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const hasRange = max > min;

    const atl = item.all_time_low !== undefined ? item.all_time_low : min;
    const isAtl = hasRange && item.points.length >= 2 && cur <= atl;

    if (isAtl) {
      const atlBadge = document.createElement("span");
      atlBadge.className = "badge low";
      atlBadge.textContent = "역대 최저";
      atlBadge.title = "수집 이래 가장 낮은 가격입니다.";
      priceCell.appendChild(atlBadge);
    } else if (isLow30(item)) {
      const lowBadge = document.createElement("span");
      lowBadge.className = "badge low";
      lowBadge.textContent = "30일 최저";
      lowBadge.title = "최근 30일 중 가장 낮은 가격입니다.";
      priceCell.appendChild(lowBadge);
    }

    const rate = item.discount_rate !== undefined ? item.discount_rate : discountRate(item);
    if (rate !== null && rate > 0) {
      const rateBadge = document.createElement("span");
      rateBadge.className = "badge";
      rateBadge.textContent = rate + "% 할인";
      rateBadge.style.color = "var(--down)";
      rateBadge.style.borderColor = "rgba(200, 51, 104, .3)";
      priceCell.appendChild(rateBadge);
    }

    const change = latestChange(item);
    const deltaCell = td("", "num " + (change === null ? "flat" : change.delta < 0 ? "good" : "bad"));
    if (change === null) {
      deltaCell.textContent = "—";
    } else {
      deltaCell.appendChild(document.createTextNode(deltaText(item)));
      const when = document.createElement("span");
      when.className = "small";
      when.textContent = " · " + mmdd(change.date);
      deltaCell.appendChild(when);
    }

    const rangeCell = td(fmt(min) + " / " + fmt(max), "num small");

    const sparkCell = document.createElement("td");
    sparkCell.className = "spark";
    sparkCell.appendChild(sparkline(item));

    tr.appendChild(catCell);
    tr.appendChild(nameCell);
    tr.appendChild(priceCell);
    tr.appendChild(deltaCell);
    tr.appendChild(rangeCell);
    tr.appendChild(sparkCell);

    tr.addEventListener("click", function () { openChart(item); });
    tr.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openChart(item);
      }
    });
    return tr;
  }

  function renderEventCard(category, entries, options) {
    const compact = !!(options && options.compact);
    const card = document.createElement("article");
    card.className = "event-card" + (compact ? " compact" : "");
    card.setAttribute("aria-label", (category || "이벤트") + " 가격 목록");
    if (!compact) {
      const banner = document.createElement("div");
      banner.className = "event-banner";
      let bannerFile = "";
      if (category.includes("첫방문")) bannerFile = "assets/first-visit-banner.jpg";
      else if (category.includes("이달의 단독")) bannerFile = "assets/monthly-banner.jpg";
      if (bannerFile) {
        const img = document.createElement("img");
        img.src = bannerFile;
        img.alt = category + " 이벤트 배너";
        img.loading = "lazy";
        img.decoding = "async";
        banner.appendChild(img);
      } else {
        banner.classList.add("generic");
        const label = document.createElement("span");
        label.textContent = "LIMITED EVENT";
        const title = document.createElement("h3");
        title.className = "event-banner-title";
        title.textContent = category || "이벤트";
        banner.append(label, title);
      }
      card.appendChild(banner);
    }

    const body = document.createElement("div");
    body.className = "event-card-body";
    const lines = [];
    for (const item of entries) {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "event-line";
      line.setAttribute("aria-label", item.name + " 가격 추이 보기");
      const top = document.createElement("span");
      top.className = "event-line-top";
      const prices = document.createElement("span");
      prices.className = "event-prices";
      const listPrice = document.createElement("span");
      listPrice.className = "event-list-price";
      listPrice.textContent = item.list_price > currentPrice(item) ? won(item.list_price) : "";
      const salePrice = document.createElement("span");
      salePrice.className = "event-sale-price";
      salePrice.textContent = won(currentPrice(item));
      prices.append(listPrice, salePrice);
      const name = document.createElement("span");
      name.className = "event-name";
      const nameText = document.createElement("span");
      nameText.className = "event-name-text";
      nameText.textContent = item.name;
      const openHint = document.createElement("span");
      openHint.className = "event-open";
      openHint.setAttribute("aria-hidden", "true");
      openHint.textContent = "↗";
      name.append(nameText, openHint);
      if (compact) {
        const categoryLabel = document.createElement("span");
        categoryLabel.className = "event-category";
        categoryLabel.textContent = item.category || "이벤트";
        top.append(categoryLabel, prices);
        line.append(top, name);
      } else {
        // 그룹 카드에서는 배너에 카테고리가 이미 있으므로 시술명을 제목 줄로 올린다.
        top.append(name, prices);
        line.appendChild(top);
      }
      if (item.active && item.returned) {
        const returned = document.createElement("span");
        returned.className = "event-extra returned";
        returned.textContent = "재등장 · " + mmdd(item.returned.date) + " · " + returnedPriceText(item.returned);
        line.appendChild(returned);
      }
      if (!item.active || isLow30(item)) {
        const extra = document.createElement("span");
        extra.className = "event-extra";
        extra.textContent = item.active ? "30일 최저" : "종료된 이벤트 · 마지막 확인가";
        line.appendChild(extra);
      }
      line.addEventListener("click", function () { openChart(item); });
      lines.push(line);
      body.appendChild(line);
    }
    if (entries.length > 2) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "event-more";
      const label = document.createElement("span");
      label.textContent = "⌄";
      const initiallyExpanded = expandedCategories.has(category);
      lines.slice(2).forEach(function (line) { line.hidden = !initiallyExpanded; });
      more.append(initiallyExpanded ? "접기 " : "펼치기 ", label);
      label.textContent = initiallyExpanded ? "⌃" : "⌄";
      more.setAttribute("aria-expanded", String(initiallyExpanded));
      more.addEventListener("click", function () {
        const expanded = more.getAttribute("aria-expanded") === "true";
        lines.slice(2).forEach(function (line) { line.hidden = expanded; });
        if (expanded) expandedCategories.delete(category);
        else expandedCategories.add(category);
        more.setAttribute("aria-expanded", String(!expanded));
        more.firstChild.textContent = expanded ? "펼치기 " : "접기 ";
        label.textContent = expanded ? "⌄" : "⌃";
        updateExpandAllButton();
      });
      body.appendChild(more);
    }
    if (compact) {
      const foot = document.createElement("div");
      foot.className = "event-compact-foot";
      const rate = discountRate(entries[0]);
      if (rate !== null) {
        const badge = document.createElement("span");
        badge.className = "event-compact-rate";
        badge.textContent = rate + "% 할인";
        foot.appendChild(badge);
      }
      foot.appendChild(sparkline(entries[0]));
      body.appendChild(foot);
    }
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
    syncCategoryChips(false);
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

  function openChart(item) {
    const dialog = $("chartDialog");
    const last = item.points[item.points.length - 1];
    const first = item.points[0];

    $("chartCat").textContent = (item.category || "기타") + (item.active ? "" : " · 종료된 항목");
    $("chartName").textContent = item.name;

    const meta = $("chartMeta");
    meta.textContent = "";
    function part(label, value, className) {
      const chip = document.createElement("span");
      chip.className = "chart-badge" + (className ? " " + className : "");
      const lbl = document.createElement("span");
      lbl.textContent = label;
      const bold = document.createElement("b");
      bold.textContent = value;
      chip.append(lbl, bold);
      meta.appendChild(chip);
    }
    part("현재", won(last[1]));
    if (item.returned) {
      part("최근 재등장", item.returned.date);
      part("재등장 가격 비교", returnedPriceText(item.returned));
    }
    if (item.list_price !== undefined && item.list_price !== null) part("정가", won(item.list_price));
    const rate = item.discount_rate !== undefined ? item.discount_rate : discountRate(item);
    if (rate !== null && rate > 0) part("할인율", rate + "%", "good");

    if (item.all_time_low !== undefined) {
      part("역대 최저", won(item.all_time_low), last[1] <= item.all_time_low && item.points.length >= 2 ? "good" : "");
    }
    if (item.avg_price !== undefined && item.points.length > 1) {
      part("역대 평균", won(item.avg_price));
      const vsAvg = item.price_vs_avg;
      if (vsAvg !== undefined && vsAvg !== 0) {
        part("평균 대비", (vsAvg > 0 ? "+" : "") + vsAvg + "%", vsAvg < 0 ? "good" : "bad");
      }
    }

    if ((DATA.days || 0) >= 2) {
      const low = min30(item);
      if (low !== null) part("30일 최저", won(low), currentPrice(item) <= low ? "good" : "");
    }
    if (item.points.length > 1) {
      const diff = last[1] - first[1];
      if (diff !== 0) part("첫 기록 대비", (diff > 0 ? "+" : "-") + fmt(Math.abs(diff)) + "원", diff > 0 ? "bad" : "good");
    }
    part("기간", mmdd(first[0]) + " ~ " + mmdd(last[0]) + " (" + item.points.length + "일 기록)");

    const tbody = $("chartPoints");
    tbody.textContent = "";
    const fragment = document.createDocumentFragment();
    for (let i = item.points.length - 1; i >= 0; i -= 1) {
      const point = item.points[i];
      const tr = document.createElement("tr");
      tr.appendChild(td(point[0]));
      tr.appendChild(td(won(point[1]), "num"));
      if (i === 0) {
        tr.appendChild(td("—", "num flat"));
      } else {
        const diff = point[1] - item.points[i - 1][1];
        tr.appendChild(td(
          diff === 0 ? "—" : (diff > 0 ? "+" : "-") + fmt(Math.abs(diff)) + "원",
          "num " + (diff === 0 ? "flat" : diff > 0 ? "bad" : "good")
        ));
      }
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);

    previousFocusElement = document.activeElement;
    if (!dialog.open) dialog.showModal();
    updateScrollBtn();
    const closeBtn = $("chartClose");
    if (closeBtn) closeBtn.focus();
    drawChart(item);
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

  function drawChart(item) {
    const canvas = $("chartCanvas");
    if (!canvas) return;
    const points = item.points;
    const labels = points.map(function (p) { return p[0]; });
    const values = points.map(function (p) { return p[1]; });
    const first = points[0];
    const last = points[points.length - 1];
    const rawMin = Math.min.apply(null, values);
    const rawMax = Math.max.apply(null, values);
    const flat = rawMin === rawMax;

    canvas.setAttribute("aria-label",
      item.name + " 가격 추이: " + first[0] + " " + won(first[1]) + "에서 " +
      last[0] + " " + won(last[1]) + ", 최저 " + won(rawMin) + ", 최고 " + won(rawMax));

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
    const flatColor = cssVar("--flat") || COLORS.flat;
    const palette = {
      muted: cssVar("--muted") || "#807a7d",
      panel: cssVar("--panel") || "#ffffff",
      down: cssVar("--down") || COLORS.down,
      up: cssVar("--up") || COLORS.up
    };

    let min = rawMin;
    let max = rawMax;
    if (flat) {
      const margin = Math.max(1000, Math.round(rawMax * 0.06));
      min = Math.max(0, rawMin - margin);
      max = rawMax + margin;
    } else {
      const margin = (rawMax - rawMin) * 0.16;
      min = Math.max(0, rawMin - margin);
      max = rawMax + margin;
    }
    const step = niceStep(max - min || 1, compact ? 4 : 5);
    min = Math.max(0, Math.floor(min / step) * step);
    max = Math.ceil(max / step) * step;
    if (max <= min) max = min + step;

    const datasets = [{
      label: item.name,
      data: values,
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
      pointBackgroundColor: values.map(function (_, i) {
        return i === values.length - 1 ? color : palette.panel;
      }),
      pointBorderColor: values.map(function (price, i) {
        if (i === 0) return flatColor;
        if (price > values[i - 1]) return palette.up;
        if (price < values[i - 1]) return palette.down;
        return flatColor;
      }),
      pointBorderWidth: values.map(function (_, i) {
        return i === values.length - 1 ? 2.4 : 1.8;
      }),
      pointRadius: values.map(function (_, i) {
        return i === values.length - 1 ? 5.5 : 3.6;
      }),
      pointHoverRadius: 7,
      pointHoverBorderWidth: 2.6,
      pointHitRadius: 16
    }];

    if (!flat) {
      if (item.all_time_low !== undefined) {
        datasets.push({
          label: "역대 최저",
          data: values.map(function () { return item.all_time_low; }),
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
      if (item.avg_price !== undefined && points.length > 1) {
        datasets.push({
          label: "평균",
          data: values.map(function () { return item.avg_price; }),
          order: 0,
          borderColor: palette.muted,
          borderWidth: 1.1,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
          refLabel: "평균 " + won(item.avg_price),
          refColor: palette.muted
        });
      }
    }

    chartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 120,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 26, right: 6, bottom: 2 } },
        animation: prefersReducedMotion() ? false : { duration: 520, easing: "easeOutQuart" },
        scales: {
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
            min: min,
            max: max,
            grid: { color: "rgba(128, 122, 125, .16)", drawTicks: false },
            border: { display: false },
            ticks: {
              stepSize: step,
              padding: 6,
              color: palette.muted,
              font: { size: 10.5 },
              callback: function (value) { return axisLabel(value); }
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
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
                const prev = values[index - 1];
                const diff = entry.parsed.y - prev;
                if (diff === 0) return "변동 없음";
                const pct = prev ? (Math.abs(diff) / prev) * 100 : 0;
                return (diff > 0 ? "▲ +" : "▼ -") + fmt(Math.abs(diff)) + "원 (" +
                  (diff > 0 ? "+" : "-") + pct.toFixed(1) + "%)";
              }
            }
          },
          lastValuePill: { text: won(last[1]), color: color },
          flatNotice: { text: flat ? "수집 이래 가격 변동 없음 · " + points.length + "일 기록" : "" }
        }
      },
      plugins: [lastValuePill, crosshair, refLabels, flatNotice]
    });
  }

  function closeDialog() {
    const dialog = $("chartDialog");
    if (dialog.open) dialog.close();
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    updateScrollBtn();
    if (previousFocusElement && typeof previousFocusElement.focus === "function") {
      previousFocusElement.focus();
      previousFocusElement = null;
    }
  }

  function resetFilters() {
    state.q = "";
    state.category = "";
    state.status = "active";
    state.changedOnly = false;
    state.sort = "category";
    $("q").value = "";
    $("statusFilter").value = "active";
    $("sortFilter").value = "category";
    $("changedToggle").classList.remove("on");
    $("changedToggle").setAttribute("aria-pressed", "false");
    renderTable();
    syncUrl(true);
  }

  // Node 테스트(node --test)에서 순수 로직을 검증할 수 있도록 DOM 없이도 내보낸다.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = {
        DATA,
        PAGE_SIZE,
        state,
        changedIndexes,
        matches,
        sortItems,
        compareName,
        groupItemsByBoundary,
        parseUrlState,
        buildQuery,
        discountRate,
        currentPrice,
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
    syncUrl(true);
  });
  $("monthFilter").addEventListener("change", function (event) {
    renderMonthly(event.target.value);
  });
  $("changedToggle").addEventListener("click", function () {
    state.changedOnly = !state.changedOnly;
    this.classList.toggle("on", state.changedOnly);
    this.setAttribute("aria-pressed", String(state.changedOnly));
    renderTable();
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
    syncUrl(true);
  });
  $("resetFilters").addEventListener("click", resetFilters);
  $("chartClose").addEventListener("click", closeDialog);
  $("chartDialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeDialog();
  });
  $("chartDialog").addEventListener("click", function (event) {
    if (event.target === $("chartDialog")) closeDialog();
  });
  window.addEventListener("popstate", function () {
    readUrlState();
    applyStateToControls();
    renderTable();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable) return;
    if ($("chartDialog").open) return;
    event.preventDefault();
    $("q").focus();
  });

  readUrlState();
  renderStats();
  renderRecent();
  renderMonthly();
  renderStale();
  buildCategoryChips();
  applyStateToControls();
  renderTable();
  syncUrl(false);
})();
