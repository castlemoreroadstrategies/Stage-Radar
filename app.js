// Stage Analysis Desk — vanilla ES6 module
// Layers: settings/state, data fetch, analytics, render

/* ---------------- Settings & State ---------------- */
const DEFAULTS = {
  proxy: "https://corsproxy.io/?",
  benchmark: "SPY",
  smaWeeks: 30,
  volMultiplier: 2.0,
  lookback: "2y",
  tickers: ["SPY", "XOM", "BTC-USD", "RY", "RY.TO", "FIE.TO", "SIXY.TO"],
};

const LS_KEY = "stageDesk.v1";

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

const state = loadState();
let selectedTicker = state.tickers[1] || state.tickers[0];
const dataCache = new Map(); // ticker -> {weekly, daily, fetchedAt}

/* ---------------- Data Layer (Yahoo Finance) ---------------- */
async function fetchChart(ticker, range = "2y", interval = "1wk") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
  const proxied = state.proxy + encodeURIComponent(url);
  const r = await fetch(proxied);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${ticker}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${ticker}`);
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || q.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = adj[i] ?? q.close?.[i];
    if (close == null) continue;
    out.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? close,
      h: q.high?.[i] ?? close,
      l: q.low?.[i] ?? close,
      c: close,
      v: q.volume?.[i] ?? 0,
    });
  }
  return out;
}

async function getTickerSeries(ticker) {
  const cached = dataCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached;
  const [weekly, daily] = await Promise.all([
    fetchChart(ticker, state.lookback, "1wk"),
    fetchChart(ticker, "3mo", "1d"),
  ]);
  const entry = { weekly, daily, fetchedAt: Date.now() };
  dataCache.set(ticker, entry);
  return entry;
}

/* ---------------- Analytics ---------------- */
function sma(series, period) {
  const out = new Array(series.length).fill(null);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= period) sum -= series[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function slope(series, lookback = 5) {
  // Simple slope: avg pct change of last `lookback` non-null values
  const vals = series.filter((v) => v != null).slice(-lookback - 1);
  if (vals.length < 2) return 0;
  const first = vals[0], last = vals[vals.length - 1];
  return (last - first) / first;
}

function classifyStage({ price, smaNow, smaSlope, rsSlope }) {
  // Weinstein stage approximation
  const flat = Math.abs(smaSlope) < 0.005; // <0.5% over lookback
  if (price > smaNow && smaSlope > 0.005) return rsSlope >= 0 ? 2 : 3;
  if (price > smaNow && flat) return 1;
  if (price < smaNow && smaSlope < -0.005) return 4;
  if (price < smaNow && flat) return 1;
  if (price > smaNow && smaSlope < 0) return 3;
  if (price < smaNow && smaSlope > 0) return 1;
  return 1;
}

function analyze(ticker, series, benchSeries) {
  const closes = series.weekly.map((b) => b.c);
  const vols = series.weekly.map((b) => b.v);
  const smaArr = sma(closes, state.smaWeeks);
  const last = closes.length - 1;
  const price = closes[last];
  const smaNow = smaArr[last];
  const smaSlope = (() => {
    if (smaNow == null || smaArr[last - 5] == null) return 0;
    return (smaNow - smaArr[last - 5]) / smaArr[last - 5];
  })();

  // Relative strength line vs benchmark (aligned by date)
  let rsLine = [];
  let rsSlope = 0;
  if (benchSeries && ticker !== state.benchmark) {
    const benchMap = new Map(benchSeries.weekly.map((b) => [Math.floor(b.t / 86400000), b.c]));
    rsLine = series.weekly.map((b) => {
      const bc = benchMap.get(Math.floor(b.t / 86400000));
      return bc ? b.c / bc : null;
    });
    rsSlope = slope(rsLine, 13);
  }

  // Daily change vs previous daily close
  const d = series.daily;
  const lastDaily = d[d.length - 1];
  const prevDaily = d[d.length - 2];
  const pctChange = lastDaily && prevDaily ? (lastDaily.c - prevDaily.c) / prevDaily.c : 0;
  const currentPrice = lastDaily ? lastDaily.c : price;

  // Volume confirmation: recent weekly volume vs trailing 10-week avg
  const recentVol = vols[last] || 0;
  const trailingVols = vols.slice(Math.max(0, last - 10), last).filter((v) => v > 0);
  const avgVol = trailingVols.length ? trailingVols.reduce((a, b) => a + b, 0) / trailingVols.length : 0;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 0;
  const volBreakout = volRatio >= state.volMultiplier;

  const stage = classifyStage({ price, smaNow, smaSlope, rsSlope });

  return {
    ticker,
    currentPrice,
    pctChange,
    closes,
    smaArr,
    vols,
    timestamps: series.weekly.map((b) => b.t),
    smaSlope,
    rsLine,
    rsSlope,
    volRatio,
    volBreakout,
    stage,
    aboveSma: smaNow != null && price > smaNow,
  };
}

/* ---------------- Rendering ---------------- */
const fmtPrice = (v) => (v == null ? "—" : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2));
const fmtPct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
const stageLabel = (s) => ({ 1: "1 · Basing", 2: "2 · Advancing", 3: "3 · Top", 4: "4 · Declining" }[s] || "—");
const slopeLabel = (s) => (s > 0.005 ? "Up" : s < -0.005 ? "Down" : "Flat");
const slopeIcon = (s) => (s > 0.005 ? "↗" : s < -0.005 ? "↘" : "→");

function setStatus(text, color = "var(--bull)") {
  document.getElementById("statusText").textContent = text;
  document.getElementById("statusDot").style.background = color;
}

function renderGrid(analyses) {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  for (const a of analyses) {
    if (!a) continue;
    const stageCls = `stage-${a.stage}`;
    const changeCls = a.pctChange >= 0 ? "text-[var(--bull)]" : "text-[var(--bear)]";
    const rsChip = a.ticker === state.benchmark
      ? `<span class="chip chip-muted">Benchmark</span>`
      : a.rsSlope >= 0
        ? `<span class="chip chip-bull">RS ↑</span>`
        : `<span class="chip chip-bear">RS ↓</span>`;
    const volChip = a.volBreakout
      ? `<span class="chip chip-bull">Vol ${a.volRatio.toFixed(1)}×</span>`
      : `<span class="chip chip-muted">Vol ${a.volRatio.toFixed(1)}×</span>`;
    const active = a.ticker === selectedTicker ? "active" : "";
    grid.insertAdjacentHTML(
      "beforeend",
      `<div class="panel ticker-card rounded-xl p-4 ${active}" data-ticker="${a.ticker}">
        <div class="flex items-start justify-between">
          <div>
            <div class="mono text-base font-semibold">${a.ticker}</div>
            <div class="text-xs text-[var(--muted)] mt-0.5">${a.aboveSma ? "Above" : "Below"} 30W SMA</div>
          </div>
          <button class="text-[var(--muted)] hover:text-[var(--bear)] text-xs remove-btn" data-remove="${a.ticker}" title="Remove">✕</button>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <div class="mono text-2xl">${fmtPrice(a.currentPrice)}</div>
          <div class="mono text-sm ${changeCls}">${fmtPct(a.pctChange)}</div>
        </div>
        <div class="mt-3 flex items-center justify-between text-xs">
          <span class="${stageCls} font-semibold">Stage ${stageLabel(a.stage)}</span>
          <span class="mono text-[var(--muted)]">SMA ${slopeIcon(a.smaSlope)} ${slopeLabel(a.smaSlope)}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-1.5">${rsChip}${volChip}</div>
      </div>`,
    );
  }
  grid.querySelectorAll("[data-ticker]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove]")) return;
      selectedTicker = el.dataset.ticker;
      renderGrid(currentAnalyses);
      renderDetail();
    });
  });
  grid.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTicker(b.dataset.remove);
    }),
  );
}

let priceChart, volChart;
function renderDetail() {
  const a = currentAnalyses.find((x) => x && x.ticker === selectedTicker);
  document.getElementById("detailTicker").textContent = selectedTicker || "—";
  const stageEl = document.getElementById("detailStage");
  const metrics = document.getElementById("detailMetrics");
  const notes = document.getElementById("detailNotes");
  if (!a) {
    stageEl.textContent = "Stage —";
    stageEl.className = "chip";
    metrics.innerHTML = "";
    notes.textContent = "";
    return;
  }
  stageEl.textContent = `Stage ${stageLabel(a.stage)}`;
  stageEl.className = `chip stage-${a.stage}`;
  metrics.innerHTML = `
    <div><div class="text-[var(--muted)] text-[11px] uppercase tracking-wider">Price</div><div class="mono">${fmtPrice(a.currentPrice)}</div></div>
    <div><div class="text-[var(--muted)] text-[11px] uppercase tracking-wider">Day Δ</div><div class="mono ${a.pctChange >= 0 ? "text-[var(--bull)]" : "text-[var(--bear)]"}">${fmtPct(a.pctChange)}</div></div>
    <div><div class="text-[var(--muted)] text-[11px] uppercase tracking-wider">30W Slope</div><div class="mono">${slopeIcon(a.smaSlope)} ${fmtPct(a.smaSlope)}</div></div>
    <div><div class="text-[var(--muted)] text-[11px] uppercase tracking-wider">Vol vs Avg</div><div class="mono ${a.volBreakout ? "text-[var(--bull)]" : ""}">${a.volRatio.toFixed(2)}×</div></div>
  `;

  const labels = a.timestamps.map((t) => new Date(t).toISOString().slice(0, 10));
  const priceCfg = {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Weekly Close", data: a.closes, borderColor: "#ff7a00", backgroundColor: "rgba(255,122,0,0.10)", borderWidth: 2, pointRadius: 0, tension: 0.15, fill: true },
        { label: `${state.smaWeeks}W SMA`, data: a.smaArr, borderColor: a.smaSlope >= 0 ? "#4ade80" : "#ef4444", borderWidth: 2, pointRadius: 0, borderDash: [4, 4] },
      ],
    },
    options: chartOpts(true),
  };
  const volCfg = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Weekly Volume",
          data: a.vols,
          backgroundColor: a.vols.map((_, i) =>
            i === a.vols.length - 1 && a.volBreakout ? "#ff7a00" : "rgba(138,133,120,0.45)",
          ),
          borderWidth: 0,
        },
      ],
    },
    options: chartOpts(false),
  };
  if (priceChart) priceChart.destroy();
  if (volChart) volChart.destroy();
  priceChart = new Chart(document.getElementById("priceChart"), priceCfg);
  volChart = new Chart(document.getElementById("volChart"), volCfg);

  const noteParts = [];
  noteParts.push(a.aboveSma ? "Price trades above the 30-week SMA." : "Price trades below the 30-week SMA.");
  noteParts.push(`30W SMA is ${slopeLabel(a.smaSlope).toLowerCase()} over the trailing 5 weeks (${fmtPct(a.smaSlope)}).`);
  if (a.ticker !== state.benchmark) noteParts.push(`Relative strength vs ${state.benchmark} is ${a.rsSlope >= 0 ? "rising" : "falling"}.`);
  noteParts.push(a.volBreakout ? `Latest weekly volume is ${a.volRatio.toFixed(1)}× the 10-week average — meets the breakout volume threshold.` : `Latest weekly volume is ${a.volRatio.toFixed(1)}× the 10-week average — below the ${state.volMultiplier}× breakout filter.`);
  notes.innerHTML = noteParts.join(" ");
}

function chartOpts(showX) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#8a8578", font: { size: 11, family: "'JetBrains Mono', monospace" } }, position: "top", align: "end" },
      tooltip: { backgroundColor: "#0b0b0b", borderColor: "#ff7a00", borderWidth: 1, titleColor: "#ff7a00", bodyColor: "#f5f5f0" },
    },
    scales: {
      x: { display: showX, ticks: { color: "#8a8578", maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { family: "'JetBrains Mono', monospace" } }, grid: { color: "rgba(42,42,42,0.6)" } },
      y: { ticks: { color: "#8a8578", font: { family: "'JetBrains Mono', monospace" } }, grid: { color: "rgba(42,42,42,0.6)" } },
    },
  };
}

/* ---------------- Orchestration ---------------- */
let currentAnalyses = [];

async function refreshAll() {
  setStatus("Loading…", "var(--warn)");
  try {
    // ensure benchmark is included
    const all = Array.from(new Set([state.benchmark, ...state.tickers]));
    const seriesMap = new Map();
    const results = await Promise.allSettled(all.map(async (t) => [t, await getTickerSeries(t)]));
    for (const r of results) {
      if (r.status === "fulfilled") seriesMap.set(r.value[0], r.value[1]);
    }
    const bench = seriesMap.get(state.benchmark);
    currentAnalyses = state.tickers
      .map((t) => {
        const s = seriesMap.get(t);
        if (!s) return null;
        try { return analyze(t, s, bench); } catch { return null; }
      })
      .filter(Boolean);
    if (!selectedTicker || !currentAnalyses.find((a) => a.ticker === selectedTicker)) {
      selectedTicker = currentAnalyses[0]?.ticker || null;
    }
    renderGrid(currentAnalyses);
    renderDetail();
    document.getElementById("lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
    setStatus("Live", "var(--bull)");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + e.message, "var(--bear)");
  }
}

function addTicker(raw) {
  const t = (raw || "").trim().toUpperCase();
  if (!t) return;
  if (state.tickers.includes(t)) return;
  state.tickers.push(t);
  saveState();
  refreshAll();
}
function removeTicker(t) {
  state.tickers = state.tickers.filter((x) => x !== t);
  if (selectedTicker === t) selectedTicker = state.tickers[0] || null;
  saveState();
  dataCache.delete(t);
  // re-render from cache
  currentAnalyses = currentAnalyses.filter((a) => a.ticker !== t);
  renderGrid(currentAnalyses);
  renderDetail();
}

/* ---------------- Settings Modal ---------------- */
const modal = document.getElementById("settingsModal");
function openModal() {
  document.getElementById("proxyInput").value = state.proxy;
  document.getElementById("benchmarkInput").value = state.benchmark;
  document.getElementById("smaInput").value = state.smaWeeks;
  document.getElementById("volMultInput").value = state.volMultiplier;
  document.getElementById("lookbackInput").value = state.lookback;
  modal.style.display = "flex";
  modal.classList.remove("hidden");
}
function closeModal() { modal.style.display = "none"; modal.classList.add("hidden"); }

document.getElementById("settingsBtn").addEventListener("click", openModal);
document.getElementById("closeSettings").addEventListener("click", closeModal);
document.getElementById("cancelSettings").addEventListener("click", closeModal);
document.getElementById("saveSettings").addEventListener("click", () => {
  state.proxy = document.getElementById("proxyInput").value.trim() || DEFAULTS.proxy;
  state.benchmark = (document.getElementById("benchmarkInput").value.trim() || DEFAULTS.benchmark).toUpperCase();
  state.smaWeeks = Math.max(5, Math.min(100, parseInt(document.getElementById("smaInput").value, 10) || DEFAULTS.smaWeeks));
  state.volMultiplier = Math.max(1, parseFloat(document.getElementById("volMultInput").value) || DEFAULTS.volMultiplier);
  state.lookback = document.getElementById("lookbackInput").value || DEFAULTS.lookback;
  saveState();
  dataCache.clear();
  updateHeaderLabels();
  closeModal();
  refreshAll();
});
document.getElementById("resetSettings").addEventListener("click", () => {
  Object.assign(state, DEFAULTS, { tickers: state.tickers });
  saveState();
  openModal();
});

document.getElementById("addBtn").addEventListener("click", () => {
  const inp = document.getElementById("tickerInput");
  addTicker(inp.value);
  inp.value = "";
});
document.getElementById("tickerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addBtn").click();
});
document.getElementById("refreshBtn").addEventListener("click", () => {
  dataCache.clear();
  refreshAll();
});

function updateHeaderLabels() {
  document.getElementById("benchmarkLabel").textContent = state.benchmark;
  document.getElementById("lookbackLabel").textContent = state.lookback;
}

/* ---------------- Boot ---------------- */
updateHeaderLabels();
refreshAll();
