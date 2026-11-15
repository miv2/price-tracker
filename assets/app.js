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
    currentItem = item;
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
    const closeBtn = $("chartClose");
    if (closeBtn) closeBtn.focus();
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
    const height = compact ? 260 : 330;
    const pad = { l: compact ? 42 : 54, r: compact ? 18 : 26, t: 34, b: 40 };
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

    // 에어리어 그라디언트
    const grad = el("linearGradient", { id: "chartAreaGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.30" }));
    grad.appendChild(el("stop", { offset: "65%", "stop-color": color, "stop-opacity": "0.06" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }));
    defs.appendChild(grad);

    // 라인 소프트 글로우 그림자
    const glow = el("filter", { id: "chartGlow", x: "-10%", y: "-10%", width: "125%", height: "135%" });
    glow.appendChild(el("feDropShadow", {
      dx: "0", dy: "4", stdDeviation: "4", "flood-color": color, "flood-opacity": "0.32"
    }));
    defs.appendChild(glow);

    // 툴팁 팝업 카드 그림자
    const tipShadow = el("filter", { id: "tipShadow", x: "-20%", y: "-20%", width: "140%", height: "140%" });
    tipShadow.appendChild(el("feDropShadow", {
      dx: "0", dy: "5", stdDeviation: "8", "flood-color": "#000", "flood-opacity": "0.14"
    }));
    defs.appendChild(tipShadow);

    svg.appendChild(defs);

    // 배경 가로 격자선 및 Y축 눈금
    for (let value = min; value <= max + step / 2; value += step) {
      const gy = y(value);
      const isBase = value === min;
      svg.appendChild(el("line", {
        x1: pad.l, x2: width - pad.r, y1: gy, y2: gy,
        stroke: "currentColor", "stroke-opacity": isBase ? "0.28" : "0.11",
        "stroke-width": "1", "stroke-dasharray": isBase ? "" : "3 6"
      }));
      svg.appendChild(svgText(pad.l - 8, gy + 3.5, axisLabel(value), {
        "text-anchor": "end", "font-size": "10.5", "font-weight": isBase ? "600" : "400", "fill-opacity": isBase ? "0.85" : "0.65"
      }));
    }

    // 참조선 (역대 최저 / 평균가)
    function refLine(value, label, stroke, dash, atStart) {
      if (value === null || value === undefined || value < min || value > max) return;
      const gy = y(value);
      svg.appendChild(el("line", {
        x1: pad.l, x2: width - pad.r, y1: gy, y2: gy,
        stroke: stroke, "stroke-opacity": "0.55", "stroke-width": "1.2", "stroke-dasharray": dash
      }));
      svg.appendChild(svgText(atStart ? pad.l + 6 : width - pad.r - 4, gy - 6, label, {
        "text-anchor": atStart ? "start" : "end",
        "font-size": "10", "font-weight": "700", fill: stroke, "fill-opacity": "0.95",
        "paint-order": "stroke", stroke: "var(--panel)", "stroke-width": "3", "stroke-linejoin": "round"
      }));
    }

    if (rawMin !== rawMax) {
      if (item.all_time_low !== undefined) refLine(item.all_time_low, "★ 역대 최저", COLORS.down, "2 4", true);
      if (item.avg_price !== undefined && points.length > 1) refLine(item.avg_price, "평균 " + won(item.avg_price), "currentColor", "5 4", false);
    }

    const coords = points.map((p, i) => [x(i), y(p[1])]);

    if (rawMin === rawMax) {
      svg.appendChild(svgText(pad.l + innerW / 2, y(rawMin) - 18, "수집 이래 가격 변동 없음 · " + points.length + "일 기록", {
        "text-anchor": "middle", "font-size": "11.5", "font-weight": "600", "fill-opacity": "0.7"
      }));
    }

    // 곡선 에어리어 및 메인 라인
    if (coords.length > 1) {
      const line = smoothLine(coords);
      svg.appendChild(el("path", {
        d: line + " L" + coords[coords.length - 1][0] + "," + baseY +
          " L" + coords[0][0] + "," + baseY + " Z",
        fill: "url(#chartAreaGrad)", stroke: "none"
      }));
      svg.appendChild(el("path", {
        d: line, fill: "none", stroke: color, "stroke-width": "2.8",
        filter: "url(#chartGlow)",
        "stroke-linecap": "round", "stroke-linejoin": "round"
      }));
    }

    // X축 날짜 눈금
    const xTickCount = Math.min(compact ? 4 : 6, points.length);
    const xIndexes = [];
    for (let i = 0; i < xTickCount; i += 1) {
      xIndexes.push(xTickCount === 1 ? 0 : Math.round((i * (points.length - 1)) / (xTickCount - 1)));
    }
    Array.from(new Set(xIndexes)).forEach(function (index) {
      const isLast = index === points.length - 1;
      svg.appendChild(svgText(x(index), height - pad.b + 20, mmdd(points[index][0]), {
        "text-anchor": "middle", "font-size": "10.5",
        "font-weight": isLast ? "700" : "500", "fill-opacity": isLast ? "1" : "0.75"
      }));
    });

    // 최저가 점 하이라이트 링
    if (rawMin !== rawMax && item.all_time_low !== undefined) {
      coords.forEach(function (coord, i) {
        if (points[i][1] === rawMin) {
          svg.appendChild(el("circle", {
            cx: coord[0], cy: coord[1], r: "8",
            fill: "none", stroke: COLORS.down, "stroke-width": "1.4", "stroke-dasharray": "2 2"
          }));
        }
      });
    }

    // 최신 포인트 펄스 링
    const lastCoord = coords[coords.length - 1];
    svg.appendChild(el("circle", {
      cx: lastCoord[0], cy: lastCoord[1], r: "8",
      fill: "none", stroke: color, "class": "chart-pulse"
    }));

    // 데이터 포인트들 (외곽 링 + 중심 코어)
    coords.forEach(function (coord, i) {
      const lastIndex = i === coords.length - 1;
      let dotColor = COLORS.flat;
      if (i > 0) {
        const diff = points[i][1] - points[i - 1][1];
        if (diff > 0) dotColor = COLORS.up;
        else if (diff < 0) dotColor = COLORS.down;
      }
      svg.appendChild(el("circle", {
        cx: coord[0], cy: coord[1], r: lastIndex ? "5.5" : "4",
        fill: "var(--panel)", stroke: lastIndex ? color : dotColor,
        "stroke-width": lastIndex ? "2.6" : "1.8"
      }));
      svg.appendChild(el("circle", {
        cx: coord[0], cy: coord[1], r: lastIndex ? "2.8" : "2",
        fill: lastIndex ? color : dotColor
      }));
      const title = el("title");
      title.textContent = points[i][0] + " · " + won(points[i][1]);
      svg.appendChild(title);
    });

    // 최신 가격 말풍선 핀 (Pill)
    const lastText = won(points[points.length - 1][1]);
    const pillW = lastText.length * 6.8 + 18;
    const pillH = 22;
    const pillX = Math.min(Math.max(lastCoord[0] - pillW / 2, pad.l), width - pad.r - pillW);
    let pillY = lastCoord[1] - pillH - 12;
    if (pillY < pad.t - 6) pillY = lastCoord[1] + 12;
    svg.appendChild(el("rect", {
      x: pillX, y: pillY, width: pillW, height: pillH, rx: "11",
      fill: color, filter: "url(#chartGlow)"
    }));
    svg.appendChild(svgText(pillX + pillW / 2, pillY + 15, lastText, {
      "text-anchor": "middle", "font-size": "11.5", "font-weight": "700", fill: "#fff"
    }));

    const first = points[0];
    const lastPoint = points[points.length - 1];
    svg.setAttribute("aria-label",
      item.name + " 가격 추이: " + first[0] + " " + won(first[1]) + "에서 " +
      lastPoint[0] + " " + won(lastPoint[1]) + ", 최저 " + won(rawMin) + ", 최고 " + won(rawMax));

    // 호버 & 터치 스크러빙 인터랙션
    const hover = el("g", { opacity: "0", "pointer-events": "none" });
    const hoverLine = el("line", {
      y1: pad.t, y2: baseY, stroke: "currentColor", "stroke-opacity": "0.35",
      "stroke-width": "1.2", "stroke-dasharray": "3 4"
    });
    const hoverHalo = el("circle", { r: "9", fill: color, "fill-opacity": "0.2" });
    const hoverDot = el("circle", { r: "4.8", fill: "var(--panel)", stroke: color, "stroke-width": "2.4" });
    const tip = el("g");
    const tipRect = el("rect", { rx: "9", fill: "var(--panel)", stroke: "var(--line)", "stroke-width": "1", filter: "url(#tipShadow)" });
    const tipDate = svgText(0, 0, "", { "font-size": "10.5", "font-weight": "600", "fill-opacity": "0.7" });
    const tipPrice = svgText(0, 0, "", { "font-size": "13", "font-weight": "800", fill: "var(--text)" });
    const tipDelta = svgText(0, 0, "", { "font-size": "11", "font-weight": "700" });
    tip.append(tipRect, tipDate, tipPrice, tipDelta);
    hover.append(hoverLine, hoverHalo, hoverDot, tip);
    svg.appendChild(hover);

    const overlay = el("rect", {
      x: pad.l - 6, y: pad.t - 6, width: innerW + 12, height: innerH + 12,
      fill: "transparent", "pointer-events": "all", style: "cursor: crosshair; touch-action: none;"
    });
    svg.appendChild(overlay);

    function measureText(node, text) {
      try {
        return node.getComputedTextLength();
      } catch (error) {
        return text.length * 6.6;
      }
    }

    function showAt(index) {
      const point = points[index];
      const cx = x(index);
      const cy = y(point[1]);
      hoverLine.setAttribute("x1", cx);
      hoverLine.setAttribute("x2", cx);
      hoverHalo.setAttribute("cx", cx);
      hoverHalo.setAttribute("cy", cy);
      hoverDot.setAttribute("cx", cx);
      hoverDot.setAttribute("cy", cy);
      hover.setAttribute("opacity", "1");

      tipDate.textContent = point[0];
      tipPrice.textContent = won(point[1]);

      let deltaStr = "첫 기록";
      let deltaColor = "var(--muted)";
      if (index > 0) {
        const prev = points[index - 1][1];
        const diff = point[1] - prev;
        if (diff === 0) {
          deltaStr = "변동 없음";
          deltaColor = "var(--flat)";
        } else {
          const pct = prev ? ((Math.abs(diff) / prev) * 100).toFixed(1) : "0";
          const sign = diff > 0 ? "+" : "-";
          deltaStr = (diff > 0 ? "▲ " : "▼ ") + sign + fmt(Math.abs(diff)) + "원 (" + sign + pct + "%)";
          deltaColor = diff > 0 ? COLORS.up : COLORS.down;
        }
      }
      tipDelta.textContent = deltaStr;
      tipDelta.setAttribute("fill", deltaColor);

      const maxTextW = Math.max(
        measureText(tipDate, tipDate.textContent),
        measureText(tipPrice, tipPrice.textContent),
        measureText(tipDelta, deltaStr)
      );
      const tipW = Math.max(110, maxTextW + 24);
      const tipH = 56;
      const tipX = Math.min(Math.max(cx - tipW / 2, pad.l), width - pad.r - tipW);
      let tipY = cy - tipH - 14;
      if (tipY < pad.t - 8) tipY = cy + 14;

      tipRect.setAttribute("x", tipX);
      tipRect.setAttribute("y", tipY);
      tipRect.setAttribute("width", tipW);
      tipRect.setAttribute("height", tipH);
      tipDate.setAttribute("x", tipX + 11);
      tipDate.setAttribute("y", tipY + 16);
      tipPrice.setAttribute("x", tipX + 11);
      tipPrice.setAttribute("y", tipY + 33);
      tipDelta.setAttribute("x", tipX + 11);
      tipDelta.setAttribute("y", tipY + 48);
    }

    function handlePointer(event) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scale = width / rect.width;
      const px = (event.clientX - rect.left) * scale;
      const index = points.length > 1 ? Math.round((px - pad.l) / stepX) : 0;
      showAt(Math.min(Math.max(index, 0), points.length - 1));
    }

    overlay.addEventListener("pointerdown", function (event) {
      if (overlay.setPointerCapture) {
        try { overlay.setPointerCapture(event.pointerId); } catch (_) {}
      }
      handlePointer(event);
    });
    overlay.addEventListener("pointermove", handlePointer);
    overlay.addEventListener("pointerup", function (event) {
      if (overlay.releasePointerCapture) {
        try { overlay.releasePointerCapture(event.pointerId); } catch (_) {}
      }
      hover.setAttribute("opacity", "0");
    });
    overlay.addEventListener("pointercancel", function () { hover.setAttribute("opacity", "0"); });
    overlay.addEventListener("pointerleave", function () { hover.setAttribute("opacity", "0"); });
  }

  function closeDialog() {
    const dialog = $("chartDialog");
    if (dialog.open) dialog.close();
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
        smoothLine,
        won,
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
