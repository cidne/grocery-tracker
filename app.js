const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const SECTION_ORDER = ["Produce", "Meat & Seafood", "Dairy", "Pantry", "Other"];
const STATE = {
  data: null,
  logSort: { key: "purchased_date", dir: "desc" },
  logFilters: { status: "", section: "", search: "" },
  charts: {},
};

async function loadData() {
  try {
    const res = await fetch("data/pantry.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.items = data.items.map((it) => ({ ...it, days_held: computeDaysHeld(it) }));
    STATE.data = data;
    return data;
  } catch (err) {
    console.error("Failed to load pantry.json:", err);
    showLoadError(err);
    return null;
  }
}
function computeDaysHeld(item) {
  const start = item.purchased_date || (item.added_at ? item.added_at.slice(0, 10) : null);
  if (!start) return null;
  const end = item.completed_at ? item.completed_at.slice(0, 10) : todayISO();
  return daysBetweenISO(start, end);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysBetweenISO(a, b) {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.max(0, Math.round((db - da) / 86400000));
}
function showLoadError(err) {
  const msg = `<div class="loading" style="color: var(--crit);">DATA LOAD FAILED :: ${err.message}<br/><br/>If you're opening index.html directly, run a local server:<br/><code>python -m http.server 8000</code></div>`;
  $("#inventory-content").innerHTML = msg;
  $("#log-content").innerHTML = msg;
  $("#analytics-content").innerHTML = msg;
}

function renderHeader(data) {
  const inPantry = data.items.filter((i) => i.status === "in_pantry");
  const inventoryValue = inPantry.reduce((s, i) => s + (i.total || 0), 0);
  const totalSpend = data.items.reduce((s, i) => s + (i.total || 0), 0);
  $("#hdr-sub").textContent = `// ${inPantry.length} items active · tracking ${data.items.length} total`;
  $("#hdr-stats").innerHTML = `
    <div class="hdr-stat"><span class="hdr-stat-k">PANTRY VALUE</span><span class="hdr-stat-v">$${inventoryValue.toFixed(2)}</span></div>
    <div class="hdr-stat"><span class="hdr-stat-k">LIFETIME SPEND</span><span class="hdr-stat-v">$${totalSpend.toFixed(2)}</span></div>
  `;
  const syncStr = data.last_sync
    ? new Date(data.last_sync).toISOString().replace("T", " ").slice(0, 16) + "Z"
    : "—";
  $("#foot-sync").textContent = `LAST SYNC :: ${syncStr}`;
}

function renderInventory(data) {
  const items = data.items.filter((i) => i.status === "in_pantry");
  if (items.length === 0) {
    $("#inventory-content").innerHTML = `<div class="loading">PANTRY EMPTY</div>`;
    return;
  }
  const bySection = groupBy(items, (i) => i.section || "Other");
  const ordered = SECTION_ORDER.filter((s) => bySection[s]).concat(
    Object.keys(bySection).filter((s) => !SECTION_ORDER.includes(s))
  );
  const html = ordered.map((section) => {
    const list = bySection[section];
    const total = list.reduce((s, i) => s + (i.total || 0), 0);
    const itemsHtml = list.sort((a, b) => (b.days_held ?? 0) - (a.days_held ?? 0))
      .map(renderInventoryItem).join("");
    return `
      <div class="section-group">
        <div class="section-head">${escapeHtml(section)}<span class="section-count">${list.length} · $${total.toFixed(2)}</span></div>
        <div class="inv-grid">${itemsHtml}</div>
      </div>`;
  }).join("");
  $("#inventory-content").innerHTML = html;
}
function renderInventoryItem(item) {
  const days = item.days_held ?? 0;
  const ageClass = days >= 14 ? "age-old" : days >= 7 ? "age-mid" : "age-fresh";
  const qtyStr = item.qty != null && item.unit ? `${trimNum(item.qty)} ${item.unit}` : "—";
  const costStr = item.total != null ? `$${item.total.toFixed(2)}` : "";
  return `
    <div class="inv-item">
      <div class="inv-name">${escapeHtml(item.name)}</div>
      <div class="inv-cost">${costStr}</div>
      <div class="inv-meta">${qtyStr}</div>
      <div class="inv-age ${ageClass}">D+${days}</div>
    </div>`;
}

function renderLog(data) {
  populateSectionFilter(data);
  const filtered = applyLogFilters(data.items);
  const sorted = sortLogItems(filtered);
  if (sorted.length === 0) {
    $("#log-content").innerHTML = `<div class="loading">NO MATCHING RECORDS</div>`;
    return;
  }
  const headers = [
    { k: "purchased_date", label: "DATE" },
    { k: "name", label: "ITEM" },
    { k: "section", label: "CATEGORY" },
    { k: "qty", label: "QTY" },
    { k: "total", label: "TOTAL" },
    { k: "status", label: "STATUS" },
    { k: "days_held", label: "DAYS" },
  ];
  const headHtml = headers.map((h) => {
    const cls = STATE.logSort.key === h.k ? `sort-${STATE.logSort.dir}` : "";
    return `<th data-sort="${h.k}" class="${cls}">${h.label}</th>`;
  }).join("");
  const rowsHtml = sorted.map(renderLogRow).join("");
  $("#log-content").innerHTML = `<table class="log-table"><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
  $$(".log-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (STATE.logSort.key === k) STATE.logSort.dir = STATE.logSort.dir === "asc" ? "desc" : "asc";
      else { STATE.logSort.key = k; STATE.logSort.dir = "desc"; }
      renderLog(STATE.data);
    });
  });
}
function renderLogRow(item) {
  const qtyStr = item.qty != null && item.unit ? `${trimNum(item.qty)} ${item.unit}` : "—";
  const totalStr = item.total != null ? `$${item.total.toFixed(2)}` : "—";
  const dateStr = item.purchased_date || "—";
  const daysStr = item.days_held != null ? String(item.days_held) : "—";
  const statusLabel = {
    in_pantry: "in pantry", consumed: "consumed",
    "wasted-spoiled": "spoiled", "wasted-rejected": "rejected",
  }[item.status] || item.status;
  return `
    <tr>
      <td>${escapeHtml(dateStr)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.section || "—")}</td>
      <td>${qtyStr}</td><td>${totalStr}</td>
      <td><span class="status-tag status-${item.status}">${statusLabel}</span></td>
      <td>${daysStr}</td>
    </tr>`;
}
function applyLogFilters(items) {
  const { status, section, search } = STATE.logFilters;
  const s = search.trim().toLowerCase();
  return items.filter((i) => {
    if (status && i.status !== status) return false;
    if (section && i.section !== section) return false;
    if (s && !(i.name || "").toLowerCase().includes(s)) return false;
    return true;
  });
}
function sortLogItems(items) {
  const { key, dir } = STATE.logSort;
  const mult = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
    return String(av).localeCompare(String(bv)) * mult;
  });
}
function populateSectionFilter(data) {
  const sel = $("#filter-section");
  if (sel.options.length > 1) return;
  const sections = [...new Set(data.items.map((i) => i.section).filter(Boolean))].sort();
  sections.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s.toLowerCase();
    sel.appendChild(opt);
  });
}
function bindLogFilters() {
  $("#filter-status").addEventListener("change", (e) => { STATE.logFilters.status = e.target.value; if (STATE.data) renderLog(STATE.data); });
  $("#filter-section").addEventListener("change", (e) => { STATE.logFilters.section = e.target.value; if (STATE.data) renderLog(STATE.data); });
  $("#filter-search").addEventListener("input", (e) => { STATE.logFilters.search = e.target.value; if (STATE.data) renderLog(STATE.data); });
}

function renderAnalytics(data) {
  const items = data.items;
  const totalSpend = sumBy(items, "total");
  const completed = items.filter((i) => i.status !== "in_pantry");
  const spoiled = items.filter((i) => i.status === "wasted-spoiled");
  const rejected = items.filter((i) => i.status === "wasted-rejected");
  const consumed = items.filter((i) => i.status === "consumed");
  const wasteRate = completed.length ? (spoiled.length + rejected.length) / completed.length : 0;
  const avgConsumedDays = avgDaysHeld(consumed);
  const avgSpoiledDays = avgDaysHeld(spoiled);
  const byCategory = {};
  items.forEach((i) => { const k = i.section || "Other"; byCategory[k] = (byCategory[k] || 0) + (i.total || 0); });
  const byDate = {};
  items.forEach((i) => { if (!i.purchased_date) return; byDate[i.purchased_date] = (byDate[i.purchased_date] || 0) + (i.total || 0); });
  const dates = Object.keys(byDate).sort();
  const wasted = [...spoiled, ...rejected];
  const wastedTotals = aggregateByName(wasted);
  const purchaseCounts = {};
  items.forEach((i) => { const k = baseName(i.name); purchaseCounts[k] = (purchaseCounts[k] || 0) + 1; });
  const topPurchases = Object.entries(purchaseCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  $("#analytics-content").innerHTML = `
    <div class="kpis">
      <div class="kpi"><span class="kpi-k">LIFETIME SPEND</span><span class="kpi-v">$${totalSpend.toFixed(2)}</span><span class="kpi-sub">${items.length} line items</span></div>
      <div class="kpi"><span class="kpi-k">WASTE RATE</span><span class="kpi-v ${wasteRate > 0.15 ? "crit" : wasteRate > 0.05 ? "warn" : ""}">${(wasteRate * 100).toFixed(1)}%</span><span class="kpi-sub">${spoiled.length} spoiled · ${rejected.length} rejected</span></div>
      <div class="kpi"><span class="kpi-k">AVG SHELF LIFE</span><span class="kpi-v">${avgConsumedDays != null ? avgConsumedDays.toFixed(1) : "—"}</span><span class="kpi-sub">days · ${consumed.length} consumed</span></div>
      <div class="kpi"><span class="kpi-k">AVG TIME TO SPOIL</span><span class="kpi-v warn">${avgSpoiledDays != null ? avgSpoiledDays.toFixed(1) : "—"}</span><span class="kpi-sub">days · ${spoiled.length} spoiled</span></div>
    </div>
    <div class="charts">
      <div class="chart-card"><div class="chart-title">SPEND BY CATEGORY</div><div class="chart-canvas-wrap"><canvas id="chart-category"></canvas></div></div>
      <div class="chart-card"><div class="chart-title">SPEND OVER TIME</div><div class="chart-canvas-wrap"><canvas id="chart-time"></canvas></div></div>
    </div>
    <div class="charts">
      <div class="leaderboard"><h3>TOP WASTED ($)</h3>${wastedTotals.length === 0 ? '<div class="leaderboard-empty">NO WASTE LOGGED</div>' : wastedTotals.slice(0, 8).map(([name, t]) => `<div class="leaderboard-row"><span>${escapeHtml(name)}</span><span>$${t.toFixed(2)}</span></div>`).join("")}</div>
      <div class="leaderboard"><h3>MOST PURCHASED</h3>${topPurchases.length === 0 ? '<div class="leaderboard-empty">NO DATA</div>' : topPurchases.map(([name, n]) => `<div class="leaderboard-row"><span>${escapeHtml(name)}</span><span>×${n}</span></div>`).join("")}</div>
    </div>`;
  drawCategoryChart(byCategory);
  drawTimeChart(dates, dates.map((d) => byDate[d]));
}

function drawCategoryChart(byCategory) {
  const canvas = $("#chart-category"); if (!canvas) return;
  destroyChart("category");
  const labels = Object.keys(byCategory);
  const values = labels.map((l) => +byCategory[l].toFixed(2));
  const palette = ["#7cc14b", "#5fa3d4", "#d4a84a", "#b07ad4", "#c54b3c", "#4ac4a8"];
  STATE.charts.category = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => palette[i % palette.length]), borderColor: "#0a0d0c", borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#8a948f", font: { family: "JetBrains Mono", size: 11 }, boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: $${ctx.parsed.toFixed(2)}` } },
      },
    },
  });
}
function drawTimeChart(labels, values) {
  const canvas = $("#chart-time"); if (!canvas) return;
  destroyChart("time");
  STATE.charts.time = new Chart(canvas, {
    type: "line",
    data: { labels, datasets: [{ label: "spend ($)", data: values, borderColor: "#7cc14b", backgroundColor: "rgba(124,193,75,0.12)", borderWidth: 2, tension: 0.2, fill: true, pointBackgroundColor: "#7cc14b", pointRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `$${ctx.parsed.y.toFixed(2)}` } } },
      scales: {
        x: { ticks: { color: "#8a948f", font: { family: "JetBrains Mono", size: 10 } }, grid: { color: "#16201f" } },
        y: { ticks: { color: "#8a948f", font: { family: "JetBrains Mono", size: 10 }, callback: (v) => `$${v}` }, grid: { color: "#16201f" } },
      },
    },
  });
}
function destroyChart(key) { if (STATE.charts[key]) { STATE.charts[key].destroy(); STATE.charts[key] = null; } }

function groupBy(arr, fn) { return arr.reduce((acc, item) => { const k = fn(item); (acc[k] = acc[k] || []).push(item); return acc; }, {}); }
function sumBy(arr, key) { return arr.reduce((s, i) => s + (i[key] || 0), 0); }
function avgDaysHeld(items) {
  const wd = items.filter((i) => i.days_held != null);
  if (!wd.length) return null;
  return wd.reduce((s, i) => s + i.days_held, 0) / wd.length;
}
function aggregateByName(items) {
  const m = {};
  items.forEach((i) => { const k = baseName(i.name); m[k] = (m[k] || 0) + (i.total || 0); });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function baseName(name) { if (!name) return "—"; return name.replace(/\s*\([^)]*\)\s*$/, "").trim(); }
function trimNum(n) { return Number.isInteger(n) ? String(n) : String(+n.toFixed(2)); }
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function bindTabs() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      $$(".tab").forEach((b) => b.classList.toggle("is-active", b === btn));
      $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${tab}`));
      if (tab === "analytics" && STATE.data) setTimeout(() => renderAnalytics(STATE.data), 0);
    });
  });
}

async function boot() {
  bindTabs();
  bindLogFilters();
  const data = await loadData();
  if (!data) return;
  renderHeader(data);
  renderInventory(data);
  renderLog(data);
  renderAnalytics(data);
}
boot();
