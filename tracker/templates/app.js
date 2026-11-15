const DATA = (function () {
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
    counts: { decrease: 0, increase: 0, new: 0, removed: 0 },
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
  let currentItem = null;
  let searchTimer = null;

  const $ = (id) => document.getElementById(id);

  const SORT_VALUES = ["category", "recent", "discount-desc", "price-desc", "price-asc", "name"];

  function readUrlState() {
    state.q = "";
    state.category = "";
    state.status = "active";
    state.changedOnly = false;
    state.sort = "category";
    state.view = "cards";
    state.pageSize = PAGE_SIZE;
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) state.q = q;
    const category = params.get("category");
    if (category) state.category = category;
    const status = params.get("status");
    if (status === "active" || status === "ended" || status === "all") state.status = status;
    if (params.get("changed") === "1") state.changedOnly = true;
    const sort = params.get("sort");
    if (SORT_VALUES.indexOf(sort) !== -1) state.sort = sort;
    if (params.get("view") === "table") state.view = "table";
    const limit = params.get("limit");
    if (limit === "all") state.pageSize = Infinity;
    else if (limit === "100") state.pageSize = 100;
    else if (limit === "40") state.pageSize = PAGE_SIZE;
  }

  function syncUrl(push) {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.category) params.set("category", state.category);
    if (state.status !== "active") params.set("status", state.status);
    if (state.changedOnly) params.set("changed", "1");
    if (state.sort !== "category") params.set("sort", state.sort);
    if (state.view !== "cards") params.set("view", "table");
    if (state.pageSize !== PAGE_SIZE) params.set("limit", state.pageSize === Infinity ? "all" : String(state.pageSize));
    const query = params.toString();
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
    if (d === 0) return COLORS.flat;
    return d < 0 ? COLORS.down : COLORS.up;
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    if (attrs) {
      for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function svgText(x, y, text, extra) {
    const node = el("text", Object.assign({
      x: x, y: y, fill: "currentColor",
      "font-size": "11", "font-family": "inherit"
    }, extra || {}));
    node.textContent = text;
    return node;
  }

  function sparkline(item) {
    const W = 104, H = 28, pad = 4;
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H, "class": "spark", "aria-hidden": "true" });
    svg.style.color = trendColor(item);
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
      const poly = el("polyline", {
        points: coords.map((c) => c.join(",")).join(" "),
        fill: "none", stroke: "currentColor", "stroke-width": "1.8",
        "stroke-linecap": "round", "stroke-linejoin": "round"
      });
      svg.appendChild(poly);
    }
    const last = coords[coords.length - 1];
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: "2.6", fill: "currentColor" }));
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
        " · 신규 " + (counts.new || 0) + " · 종료 " + (counts.removed || 0);
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

    const kinds = [
      ["decrease", "인하", "good"],
      ["increase", "인상", "bad"],
      ["new", "신규", ""],
      ["removed", "종료", ""]
    ];
    for (const entry of kinds) {
      const count = (RECENT.counts && RECENT.counts[entry[0]]) || 0;
      const span = document.createElement("span");
      span.className = "count" + (count ? " " + entry[2] : " zero");
      span.textContent = entry[1] + " " + fmt(count);
      countsBox.appendChild(span);
    }

    if (!RECENT.items.length) {
      const empty = document.createElement("li");
      empty.className = "recent-empty";
      empty.textContent = "직전 수집 대비 변동이 없습니다.";
      list.appendChild(empty);
      return;
    }

    const labels = { decrease: "인하", increase: "인상", new: "신규", removed: "종료" };
    for (const change of RECENT.items) {
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
      name.textContent = change.name;
      btn.appendChild(name);

      const value = document.createElement("span");
      value.className = "rval" + (change.kind === "decrease" ? " good" : change.kind === "increase" ? " bad" : "");
      if (change.kind === "new") {
        value.textContent = won(change.price);
      } else if (change.kind === "removed") {
        value.textContent = won(change.prev);
      } else {
        const sign = change.delta > 0 ? "+" : "-";
        value.textContent = sign + fmt(Math.abs(change.delta)) + "원";
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
        banner.appendChild(img);
      } else {
        banner.classList.add("generic");
        const label = document.createElement("span");
        label.textContent = "LIMITED EVENT";
        const title = document.createElement("strong");
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
      const categoryLabel = document.createElement("span");
      categoryLabel.className = "event-category";
      categoryLabel.textContent = item.category || "이벤트";
      const prices = document.createElement("span");
      prices.className = "event-prices";
      const listPrice = document.createElement("span");
      listPrice.className = "event-list-price";
      listPrice.textContent = item.list_price > currentPrice(item) ? won(item.list_price) : "";
      const salePrice = document.createElement("span");
      salePrice.className = "event-sale-price";
      salePrice.textContent = won(currentPrice(item));
      prices.append(listPrice, salePrice);
      top.append(categoryLabel, prices);
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
      line.append(top, name);
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
      // 카테고리 카드가 페이지 경계에서 쪼개지지 않도록 카테고리 단위로 자른다.
      groups = [];
      let loaded = 0;
      for (const item of currentFilteredList) {
        const last = groups[groups.length - 1];
        const sameCategory = last && last[0] === item.category;
        if (!sameCategory && loaded >= displayLimit) break;
        if (sameCategory) last[1].push(item);
        else groups.push([item.category, [item]]);
        loaded += 1;
      }
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
    currentItem = item;
    const dialog = $("chartDialog");
    const last = item.points[item.points.length - 1];
    const first = item.points[0];

    $("chartCat").textContent = (item.category || "기타") + (item.active ? "" : " · 종료된 항목");
    $("chartName").textContent = item.name;

    const meta = $("chartMeta");
    meta.textContent = "";
    function part(label, value, className) {
      const span = document.createElement("span");
      span.appendChild(document.createTextNode(label + " "));
      const bold = document.createElement("b");
      bold.textContent = value;
      if (className) bold.className = className;
      span.appendChild(bold);
      meta.appendChild(span);
    }
    part("현재", won(last[1]));
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

    if (!dialog.open) dialog.showModal();
    drawChart(item);
  }

  function axisLabel(value) {
    if (value >= 10000) {
      const man = value / 10000;
      return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + "만";
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

  function smoothLine(coords) {
    let d = "M" + coords[0][0] + "," + coords[0][1];
    for (let i = 0; i < coords.length - 1; i += 1) {
      const p0 = coords[i - 1] || coords[i];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[i + 2] || p2;
      const t = 0.18;
      const low = Math.min(p1[1], p2[1]);
      const high = Math.max(p1[1], p2[1]);
      const c1y = Math.min(high, Math.max(low, p1[1] + (p2[1] - p0[1]) * t));
      const c2y = Math.min(high, Math.max(low, p2[1] - (p3[1] - p1[1]) * t));
      d += " C" + (p1[0] + (p2[0] - p0[0]) * t) + "," + c1y +
        " " + (p2[0] - (p3[0] - p1[0]) * t) + "," + c2y +
        " " + p2[0] + "," + p2[1];
    }
    return d;
  }

  function drawChart(item) {
    const svg = $("chartSvg");
    svg.textContent = "";
    const points = item.points;
    const compact = window.innerWidth < 620;
    const width = Math.max(300, Math.floor(svg.clientWidth || 860));
    const height = compact ? 250 : 320;
    const pad = { l: compact ? 44 : 52, r: compact ? 14 : 20, t: 32, b: 38 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.style.color = "var(--muted)";

    const values = points.map((p) => p[1]);
    const rawMin = Math.min.apply(null, values);
    const rawMax = Math.max.apply(null, values);
    let min = rawMin;
    let max = rawMax;
    if (rawMin === rawMax) {
      const margin = Math.max(1000, Math.round(rawMax * 0.06));
      min = Math.max(0, rawMin - margin);
      max = rawMax + margin;
    } else {
      const margin = (rawMax - rawMin) * 0.16;
      min = Math.max(0, rawMin - margin);
      max = rawMax + margin;
    }
    const span0 = max - min || 1;
    const step = niceStep(span0, compact ? 4 : 5);
    min = Math.max(0, Math.floor(min / step) * step);
    max = Math.ceil(max / step) * step;
    if (max <= min) max = min + step;
    const span = max - min || 1;
    const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
    const x = (i) => (points.length > 1 ? pad.l + i * stepX : pad.l + innerW / 2);
    const y = (value) => pad.t + innerH - ((value - min) / span) * innerH;
    const baseY = pad.t + innerH;
    const color = trendColor(item);

    const defs = el("defs");
    const grad = el("linearGradient", { id: "chartAreaGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.30" }));
    grad.appendChild(el("stop", { offset: "70%", "stop-color": color, "stop-opacity": "0.06" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    for (let value = min; value <= max + step / 2; value += step) {
      const gy = y(value);
      const isBase = value === min;
      svg.appendChild(el("line", {
        x1: pad.l, x2: width - pad.r, y1: gy, y2: gy,
        stroke: "currentColor", "stroke-opacity": isBase ? "0.3" : "0.13",
        "stroke-width": "1", "stroke-dasharray": isBase ? "" : "3 5"
      }));
      svg.appendChild(svgText(pad.l - 8, gy + 3.5, axisLabel(value), {
        "text-anchor": "end", "font-size": "10.5", "fill-opacity": "0.7"
      }));
    }

    function refLine(value, label, stroke, dash, atStart) {
      if (value === null || value === undefined || value < min || value > max) return;
      const gy = y(value);
      svg.appendChild(el("line", {
        x1: pad.l, x2: width - pad.r, y1: gy, y2: gy,
        stroke: stroke, "stroke-opacity": "0.5", "stroke-width": "1.2", "stroke-dasharray": dash
      }));
      svg.appendChild(svgText(atStart ? pad.l + 4 : width - pad.r - 2, gy - 5, label, {
        "text-anchor": atStart ? "start" : "end",
        "font-size": "10", "font-weight": "700", fill: stroke, "fill-opacity": "0.95",
        "paint-order": "stroke", stroke: "var(--panel)", "stroke-width": "3", "stroke-linejoin": "round"
      }));
    }

    if (rawMin !== rawMax) {
      if (item.all_time_low !== undefined) refLine(item.all_time_low, "역대 최저", COLORS.down, "2 4", true);
      if (item.avg_price !== undefined && points.length > 1) refLine(item.avg_price, "평균", "currentColor", "5 4", false);
    }

    const coords = points.map((p, i) => [x(i), y(p[1])]);
    if (rawMin === rawMax) {
      svg.appendChild(svgText(pad.l + innerW / 2, y(rawMin) - 18, "가격 변동 없음 · " + points.length + "일 기록", {
        "text-anchor": "middle", "font-size": "11", "fill-opacity": "0.6"
      }));
    }
    if (coords.length > 1) {
      const line = smoothLine(coords);
      svg.appendChild(el("path", {
        d: line + " L" + coords[coords.length - 1][0] + "," + baseY +
          " L" + coords[0][0] + "," + baseY + " Z",
        fill: "url(#chartAreaGrad)", stroke: "none"
      }));
      svg.appendChild(el("path", {
        d: line, fill: "none", stroke: color, "stroke-width": "2.6",
        "stroke-linecap": "round", "stroke-linejoin": "round"
      }));
    }

    const xTickCount = Math.min(compact ? 4 : 6, points.length);
    const xIndexes = [];
    for (let i = 0; i < xTickCount; i += 1) {
      xIndexes.push(xTickCount === 1 ? 0 : Math.round((i * (points.length - 1)) / (xTickCount - 1)));
    }
    Array.from(new Set(xIndexes)).forEach(function (index) {
      const isLast = index === points.length - 1;
      svg.appendChild(svgText(x(index), height - pad.b + 20, mmdd(points[index][0]), {
        "text-anchor": "middle", "font-size": "10.5",
        "font-weight": isLast ? "700" : "400", "fill-opacity": isLast ? "1" : "0.75"
      }));
    });

    coords.forEach(function (coord, i) {
      const lastIndex = i === coords.length - 1;
      let dotColor = COLORS.flat;
      if (i > 0) {
        const diff = points[i][1] - points[i - 1][1];
        if (diff > 0) dotColor = COLORS.up;
        else if (diff < 0) dotColor = COLORS.down;
      }
      if (lastIndex) {
        svg.appendChild(el("circle", { cx: coord[0], cy: coord[1], r: "9", fill: color, "fill-opacity": "0.16" }));
      }
      const dot = el("circle", {
        cx: coord[0], cy: coord[1], r: lastIndex ? "4.8" : "3.1",
        fill: lastIndex ? color : "var(--panel)",
        stroke: lastIndex ? "var(--panel)" : dotColor,
        "stroke-width": lastIndex ? "2.6" : "1.8"
      });
      const title = el("title");
      title.textContent = points[i][0] + " · " + won(points[i][1]);
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    const lastCoord = coords[coords.length - 1];
    const lastText = won(points[points.length - 1][1]);
    const pillW = lastText.length * 6.6 + 18;
    const pillH = 22;
    const pillX = Math.min(Math.max(lastCoord[0] - pillW / 2, pad.l), width - pad.r - pillW);
    let pillY = lastCoord[1] - pillH - 12;
    if (pillY < pad.t - 6) pillY = lastCoord[1] + 12;
    svg.appendChild(el("rect", {
      x: pillX, y: pillY, width: pillW, height: pillH, rx: "11",
      fill: color
    }));
    svg.appendChild(svgText(pillX + pillW / 2, pillY + 15, lastText, {
      "text-anchor": "middle", "font-size": "11.5", "font-weight": "700", fill: "#fff"
    }));

    const first = points[0];
    const lastPoint = points[points.length - 1];
    svg.setAttribute("aria-label",
      item.name + " 가격 추이: " + first[0] + " " + won(first[1]) + "에서 " +
      lastPoint[0] + " " + won(lastPoint[1]) + ", 최저 " + won(rawMin) + ", 최고 " + won(rawMax));

    if (!window.matchMedia || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    const hover = el("g", { opacity: "0", "pointer-events": "none" });
    const hoverLine = el("line", {
      y1: pad.t, y2: baseY, stroke: "currentColor", "stroke-opacity": "0.4",
      "stroke-width": "1", "stroke-dasharray": "4 4"
    });
    const hoverDot = el("circle", { r: "4.6", fill: "var(--panel)", stroke: color, "stroke-width": "2.4" });
    const tip = el("g");
    const tipRect = el("rect", { rx: "8", fill: "var(--panel)", stroke: "var(--line)", "stroke-width": "1" });
    const tipDate = svgText(0, 0, "", { "font-size": "10", "fill-opacity": "0.75" });
    const tipPrice = svgText(0, 0, "", { "font-size": "12", "font-weight": "700", fill: "var(--text)" });
    tip.append(tipRect, tipDate, tipPrice);
    hover.append(hoverLine, hoverDot, tip);
    svg.appendChild(hover);

    const overlay = el("rect", {
      x: pad.l - 6, y: pad.t - 6, width: innerW + 12, height: innerH + 12,
      fill: "transparent", "pointer-events": "all"
    });
    svg.appendChild(overlay);

    function measureText(node, text) {
      try {
        return node.getComputedTextLength();
      } catch (error) {
        return text.length * 6.4;
      }
    }

    function showAt(index) {
      const point = points[index];
      const cx = x(index);
      const cy = y(point[1]);
      hoverLine.setAttribute("x1", cx);
      hoverLine.setAttribute("x2", cx);
      hoverDot.setAttribute("cx", cx);
      hoverDot.setAttribute("cy", cy);
      hover.setAttribute("opacity", "1");

      tipDate.textContent = point[0];
      tipPrice.textContent = won(point[1]);
      const tipW = Math.max(measureText(tipDate, point[0]), measureText(tipPrice, won(point[1]))) + 20;
      const tipH = 40;
      const tipX = Math.min(Math.max(cx - tipW / 2, pad.l), width - pad.r - tipW);
      let tipY = cy - tipH - 14;
      if (tipY < pad.t - 8) tipY = cy + 14;
      tipRect.setAttribute("x", tipX);
      tipRect.setAttribute("y", tipY);
      tipRect.setAttribute("width", tipW);
      tipRect.setAttribute("height", tipH);
      tipDate.setAttribute("x", tipX + 10);
      tipDate.setAttribute("y", tipY + 16);
      tipPrice.setAttribute("x", tipX + 10);
      tipPrice.setAttribute("y", tipY + 31);
    }

    overlay.addEventListener("pointermove", function (event) {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width ? width / rect.width : 1;
      const px = (event.clientX - rect.left) * scale;
      const index = points.length > 1 ? Math.round((px - pad.l) / stepX) : 0;
      showAt(Math.min(Math.max(index, 0), points.length - 1));
    });
    overlay.addEventListener("pointerleave", function () { hover.setAttribute("opacity", "0"); });
  }

  function closeDialog() {
    const dialog = $("chartDialog");
    if (dialog.open) dialog.close();
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

  $("loadMoreBtn").addEventListener("click", function () {
    displayLimit += state.pageSize;
    renderTable(false);
  });

  const scrollBtn = $("scrollTopBtn");
  window.addEventListener("scroll", function () {
    if (window.scrollY > 350) {
      scrollBtn.style.display = "flex";
    } else {
      scrollBtn.style.display = "none";
    }
  }, { passive: true });

  scrollBtn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  $("chartDialog").addEventListener("click", function (event) {
    if (event.target === $("chartDialog")) closeDialog();
  });
  window.addEventListener("resize", function () {
    if (currentItem && $("chartDialog").open) drawChart(currentItem);
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
  renderStale();
  buildCategoryChips();
  applyStateToControls();
  renderTable();
  syncUrl(false);
})();
