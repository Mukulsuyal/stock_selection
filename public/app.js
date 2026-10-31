// public/app.js
const API = '/api';
let TOKEN = localStorage.getItem('token') || null;
let CURRENT_USER = null;
let CURRENT_SYMBOL = null;
let ws = null;
let currentChartRange = 'max';
let chartCandles = []; // backing data for the price chart, kept around so live '1d' ticks can be appended
const qlLiveTimers = new Map(); // uid -> intervalId, for quick-log mini-charts pinned to the live "1D" range

// ---------- dependency-free SVG line chart (no CDN, never fails to load) ----------
// Supports an optional hover/touch crosshair (mouse or finger position ->
// nearest point's exact price + label) via a transparent capture rect and
// a small floating tooltip - drawn fresh into a dedicated <g> on every
// pointer move so hovering never re-renders the whole chart.
function renderSvgLineChart(containerId, labels, series, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.style.position = 'relative'; // tooltip below anchors to this
  const width = container.clientWidth || 600;
  const height = opts.height || 220;
  const padL = 46, padR = 12, padT = 12, padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allValues = series.flatMap((s) => s.data).filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (!allValues.length || !labels.length) {
    container.innerHTML = '<p class="muted small">Not enough data to draw a chart.</p>';
    return;
  }
  let min = Math.min(...allValues), max = Math.max(...allValues);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.06;
  min -= pad; max += pad;

  const n = labels.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  const gridLines = 4;
  let gridSvg = '';
  for (let g = 0; g <= gridLines; g++) {
    const gy = padT + (g / gridLines) * plotH;
    const val = max - (g / gridLines) * (max - min);
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${width - padR}" y2="${gy}" stroke="#1c2531" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 6}" y="${gy + 4}" font-size="10" fill="#8b98ab" text-anchor="end">${val.toFixed(val < 10 ? 2 : 0)}</text>`;
  }

  const labelStep = Math.max(1, Math.ceil(n / 6));
  let xLabelsSvg = '';
  for (let i = 0; i < n; i += labelStep) {
    xLabelsSvg += `<text x="${x(i)}" y="${height - 6}" font-size="10" fill="#8b98ab" text-anchor="middle">${labels[i]}</text>`;
  }

  // Auto green/red when opts.autoColor and single series
  if (opts.autoColor && series.length === 1) {
    const d0 = series[0].data.find((v) => v != null && !isNaN(v));
    const d1 = [...series[0].data].reverse().find((v) => v != null && !isNaN(v));
    if (d0 != null && d1 != null) {
      series[0].color = d1 >= d0 ? '#34d399' : '#f87171';
      series[0].fill = true;
    }
  }

  const seriesSvg = series.map((s) => {
    const pts = [];
    const idxs = [];
    s.data.forEach((v, i) => {
      if (v !== null && v !== undefined && !isNaN(v)) { pts.push(`${x(i)},${y(v)}`); idxs.push(i); }
    });
    if (!pts.length) return '';
    const linePath = `M${pts.join(' L')}`;
    const firstIdx = idxs[0], lastIdx = idxs[idxs.length - 1];
    const areaPath = (s.fill !== false)
      ? `M${x(firstIdx)},${y(min)} L${pts.join(' L')} L${x(lastIdx)},${y(min)} Z`
      : '';
    const gid = `cg-${containerId}-${Math.random().toString(36).slice(2, 7)}`;
    return `
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${areaPath ? `<path d="${areaPath}" fill="url(#${gid})" stroke="none"/>` : ''}
      <path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block; cursor:crosshair;">
      ${gridSvg}${xLabelsSvg}${seriesSvg}
      <g class="chart-hover-layer"></g>
      <rect class="chart-hover-capture" x="${padL}" y="${padT}" width="${Math.max(0, plotW)}" height="${Math.max(0, plotH)}" fill="transparent"/>
    </svg>
    <div class="chart-tooltip hidden"></div>
  `;

  // Crosshair follows the first series (every chart in this app is a
  // single price line, so there's never an ambiguity about which one).
  const primary = series.find((s) => s.data.some((v) => v !== null && v !== undefined && !isNaN(v)));
  if (!primary) return;
  const svgEl = container.querySelector('svg');
  const captureEl = container.querySelector('.chart-hover-capture');
  const hoverLayer = container.querySelector('.chart-hover-layer');
  const tooltipEl = container.querySelector('.chart-tooltip');

  // Floating black box OFF — readout goes to #chartHoverReadout (Groww-style top line)
  if (tooltipEl) tooltipEl.classList.add('hidden');
  const topReadout = document.getElementById('chartHoverReadout');

  function hide() {
    hoverLayer.innerHTML = '';
    if (tooltipEl) tooltipEl.classList.add('hidden');
    if (topReadout && opts.topReadout !== false) {
      // restore range summary mode (cleared hover text)
      topReadout.textContent = topReadout.dataset.idle || '';
      topReadout.classList.remove('chart-hover-active');
    }
  }

  function showAt(clientX) {
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width) return;
    const scaleX = rect.width / width;
    const svgX = (clientX - rect.left) / scaleX;
    let idx = Math.round(((svgX - padL) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    const v = primary.data[idx];
    if (v === null || v === undefined || isNaN(v)) { hide(); return; }
    const px = x(idx), py = y(v);
    hoverLayer.innerHTML = `
      <line x1="${px}" y1="${padT}" x2="${px}" y2="${padT + plotH}" stroke="#8b98ab" stroke-width="1" stroke-dasharray="3,3"/>
      <circle cx="${px}" cy="${py}" r="4" fill="${primary.color}" stroke="#0a0d13" stroke-width="2"/>
    `;
    const first = primary.data.find((x) => x != null && !isNaN(x));
    let absChg = '', pctChg = '';
    if (first != null) {
      const dlt = v - first;
      const pct = first !== 0 ? (dlt / first) * 100 : 0;
      absChg = `${dlt >= 0 ? '+' : ''}${dlt.toFixed(2)}`;
      pctChg = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }
    if (tooltipEl) tooltipEl.classList.add('hidden'); // never show floating box
    if (topReadout && opts.topReadout !== false) {
      const cls = (first != null && v >= first) ? 'cs-pos' : 'cs-neg';
      topReadout.innerHTML = `<span class="chr-date">${labels[idx]}</span> · <b>₹${v.toFixed(2)}</b> <span class="${cls}">${absChg} (${pctChg})</span>`;
      topReadout.classList.add('chart-hover-active');
    }
  }

  captureEl.addEventListener('mousemove', (e) => showAt(e.clientX));
  captureEl.addEventListener('mouseleave', hide);
  captureEl.addEventListener('touchstart', (e) => { if (e.touches[0]) showAt(e.touches[0].clientX); }, { passive: true });
  captureEl.addEventListener('touchmove', (e) => { if (e.touches[0]) showAt(e.touches[0].clientX); }, { passive: true });
  captureEl.addEventListener('touchend', hide);
}


// ---------- helpers ----------
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers });
  } catch (networkErr) {
    console.error('Network error calling', path, networkErr);
    throw new Error('Could not reach the server — check the server is running and you have a network connection.');
  }
  const rawText = await res.text();
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch { /* not JSON */ }
  if (!res.ok) {
    const message = data.error || `Request failed (HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''})`;
    console.error(`API error on ${path}:`, res.status, rawText.slice(0, 500));
    if (res.status === 401 && TOKEN) {
      // Stale/invalid session (e.g. token from a previous database that no
      // longer has this user) - clear it and send the person back to login
      // instead of letting every subsequent action fail with the same error.
      localStorage.removeItem('token');
      TOKEN = null;
      toast('Your session expired — please log in again.');
      setTimeout(() => location.reload(), 1200);
    }
    throw new Error(message);
  }
  return data;
}

// ---------- Real progress bar for long-running bulk scans ----------
// Used by anything that hands the backend a jobId (Index Browser,
// Bulk Screener) - polls server/progressStore.js's tiny endpoint every
// ~600ms and reports real "N of M stocks analyzed" progress, not a fake
// animation. Capped at 99% while polling; the caller sets it to 100% only
// once the actual response has come back, so the bar never lies about
// being "done" a beat before the results actually render.
function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function progressBarHtml(label) {
  return `
    <div class="scan-progress">
      <div class="scan-progress-label"><span class="spin"></span>${label}</div>
      <div class="scan-progress-track"><div class="scan-progress-fill" style="width:3%;"></div></div>
      <div class="scan-progress-pct">3%</div>
    </div>
  `;
}
function startProgressPolling(container, jobId) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const data = await api(`/stocks/progress/${jobId}`);
      if (data.found && data.total) {
        const pct = Math.min(99, Math.max(3, Math.round((data.completed / data.total) * 100)));
        const fill = container.querySelector('.scan-progress-fill');
        const pctEl = container.querySelector('.scan-progress-pct');
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = `${pct}% (${data.completed}/${data.total})`;
      }
    } catch { /* a missed poll isn't worth surfacing - just try again next tick */ }
    if (!stopped) setTimeout(tick, 600);
  };
  tick();
  return () => { stopped = true; };
}

function showPendingScreen(user) {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('pendingScreen').classList.remove('hidden');
  const icon = document.getElementById('pendingIcon');
  const title = document.getElementById('pendingTitle');
  const msg = document.getElementById('pendingMessage');
  if (user.status === 'rejected') {
    icon.textContent = '🚫';
    title.textContent = 'Access denied';
    msg.textContent = 'An admin has denied access to this account. Contact them if you think this is a mistake.';
  } else {
    icon.textContent = '⏳';
    title.textContent = 'Waiting for approval';
    msg.textContent = `Hi ${user.name} — your account has been created but needs an admin to approve it before you can use the app. Check back soon.`;
  }
}

// Hides any main-tab the current user doesn't have permission for (admins
// always see everything, regardless of their own grid), and makes sure
// whatever tab ends up active is actually one they can see - falls back to
// the first visible tab if their previously-active one just got hidden.
function applyAccessControl() {
  const isAdmin = CURRENT_USER?.role === 'admin';
  document.getElementById('adminTabBtn').classList.toggle('hidden', !isAdmin);
  let anyActiveVisible = false;
  document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
    const view = btn.dataset.view;
    if (view === 'admin') return; // handled above
    const allowed = isAdmin || CURRENT_USER?.permissions?.[view] !== false;
    btn.classList.toggle('hidden', !allowed);
    if (allowed && btn.classList.contains('active')) anyActiveVisible = true;
  });
  if (!anyActiveVisible) {
    const firstVisible = document.querySelector('.main-tabs .tab-btn:not(.hidden)');
    if (firstVisible) firstVisible.click();
  }
}

// ---------- auth ----------
function showAuthPanel(which) {
  document.getElementById('loginForm').classList.toggle('hidden', which !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', which !== 'register');
  const forgot = document.getElementById('forgotForm');
  if (forgot) forgot.classList.toggle('hidden', which !== 'forgot');
  document.querySelectorAll('.auth-screen .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === which);
  });
}

document.querySelectorAll('.auth-screen .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    showAuthPanel(btn.dataset.tab);
  });
});

document.getElementById('forgotPasswordLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('forgotError').textContent = '';
  document.getElementById('forgotSuccess').textContent = '';
  document.getElementById('forgotCodeStep').classList.add('hidden');
  const loginEmail = document.getElementById('loginEmail').value;
  if (loginEmail) document.getElementById('forgotEmail').value = loginEmail;
  showAuthPanel('forgot');
});

document.getElementById('backToLoginLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  showAuthPanel('login');
});

document.getElementById('forgotForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  const errEl = document.getElementById('forgotError');
  const okEl = document.getElementById('forgotSuccess');
  errEl.textContent = '';
  okEl.textContent = '';
  try {
    const data = await api('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    document.getElementById('forgotCodeStep').classList.remove('hidden');
    if (data.resetCode) {
      document.getElementById('forgotCode').value = data.resetCode;
      document.getElementById('forgotHint').innerHTML =
        `Your reset code: <b style="font-size:18px; letter-spacing:3px; color:var(--accent,#6ea8fe);">${data.resetCode}</b> — valid 15 min. Enter new password below.`;
    } else {
      document.getElementById('forgotHint').textContent =
        data.message || 'Could not generate code. Try again.';
    }
    okEl.textContent = data.message || 'Code ready on this screen.';
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('forgotResetBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  const code = document.getElementById('forgotCode').value.trim();
  const password = document.getElementById('forgotNewPassword').value;
  const confirm = document.getElementById('forgotConfirmPassword').value;
  const errEl = document.getElementById('forgotError');
  const okEl = document.getElementById('forgotSuccess');
  errEl.textContent = '';
  okEl.textContent = '';
  if (password !== confirm) {
    errEl.textContent = 'New password and confirm password do not match.';
    return;
  }
  if (password.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  try {
    const data = await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    });
    okEl.textContent = data.message || 'Password updated. You can log in now.';
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginPassword').value = '';
    setTimeout(() => showAuthPanel('login'), 1200);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    onAuthSuccess(data);
  } catch (err) {
    document.getElementById('loginError').textContent = err.message;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  try {
    const data = await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    onAuthSuccess(data);
  } catch (err) {
    document.getElementById('regError').textContent = err.message;
  }
});

function onAuthSuccess(data) {
  TOKEN = data.token;
  CURRENT_USER = data.user;
  localStorage.setItem('token', TOKEN);
  if (CURRENT_USER.status !== 'approved') { showPendingScreen(CURRENT_USER); return; }
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('pendingScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('userName').textContent = CURRENT_USER.name;
  try { renderDashboardHero(CURRENT_USER); } catch(_) {}
  try { fillSectionArts(); } catch(_) {}
  applyAccessControl();
  loadWatchlist();
  loadAlerts();
  loadJournal();
  loadPositions();
  loadPortfolio();
  loadMarketRegime();
  loadMarketPlaybook();
  loadHolidayBanner().then(() => { loadGoldenOpportunities(); try { loadMorningStorm(); } catch(_) {}
try { loadSystemHealth(); } catch(_) {}; loadMarketPulse(); loadBestOfToday(); try { loadUnder200(); } catch(_) {} try { renderSearchChips(); } catch(_) {} });
}

document.getElementById('pendingRefreshBtn')?.addEventListener('click', async () => {
  try {
    const data = await api('/auth/me');
    CURRENT_USER = data.user;
    if (CURRENT_USER.status === 'approved') { onAuthSuccess({ token: TOKEN, user: CURRENT_USER }); }
    else showPendingScreen(CURRENT_USER); // re-render in case status flipped to 'rejected'
  } catch (err) {
    toast(err.message);
  }
});
document.getElementById('pendingLogoutBtn')?.addEventListener('click', () => {
  localStorage.removeItem('token');
  location.reload();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('token');
  location.reload();
});

async function tryResumeSession() {
  if (!TOKEN) return;
  try {
    const data = await api('/auth/me');
    CURRENT_USER = data.user;
    if (CURRENT_USER.status !== 'approved') { showPendingScreen(CURRENT_USER); return; }
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('userName').textContent = CURRENT_USER.name;
    try { renderDashboardHero(CURRENT_USER); } catch(_) {}
    applyAccessControl();
    loadWatchlist();
    loadAlerts();
    loadJournal();
    loadPositions();
    loadPortfolio();
    loadMarketRegime();
    loadHolidayBanner().then(() => { loadGoldenOpportunities(); try { loadMorningStorm(); } catch(_) {} try { loadSystemHealth(); } catch(_) {} loadMarketPulse(); loadBestOfToday(); });
  } catch {
    localStorage.removeItem('token');
    TOKEN = null;
  }
}

// ---------- main tabs ----------
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.main-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${btn.dataset.view}`);
    if (viewEl) viewEl.classList.add('active');
    if (btn.dataset.view === 'under200') {
      try { loadUnder200(); } catch (_) {}
    }
    if (btn.dataset.view === 'fno') {
      // Lazy: do NOT auto-scan — user must press Scan (saves backend load)
      const box = document.getElementById('fnoBox');
      if (box && !box.dataset.scanned) {
        box.innerHTML = '<div class="muted small">Scan tab open hai — backend load nahi hua. <b>Scan F&O setups</b> dabao jab ready ho.</div>';
      }
    }
  });
});

// ---------- market regime banner ----------
let _regimeTimer = null;
function scheduleMarketRegimeRefresh() {
  clearTimeout(_regimeTimer);
  _regimeTimer = setTimeout(() => {
    if (typeof isIndianMarketHours === 'function' && isIndianMarketHours() && TOKEN) loadMarketRegime();
    else scheduleMarketRegimeRefresh();
  }, 60 * 1000);
}
function dayChangePctFromQuote(q) {
  if (!q) return null;
  let pct = q.pChange;
  if ((pct == null || pct === 0) && q.change != null && q.previousClose > 0) {
    pct = (Number(q.change) / Number(q.previousClose)) * 100;
  }
  if ((pct == null || pct === 0) && q.lastPrice != null && q.previousClose > 0) {
    pct = ((Number(q.lastPrice) - Number(q.previousClose)) / Number(q.previousClose)) * 100;
  }
  return pct != null && Number.isFinite(Number(pct)) ? Number(pct) : null;
}
async function loadMarketRegime() {
  scheduleMarketRegimeRefresh();

  const box = document.getElementById('marketRegimeBanner');
  box.innerHTML = '<p class="muted small"><span class="spin"></span>Loading market regime...</p>';
  try {
    const { regime } = await api('/market/regime');
    const n = regime.nifty, b = regime.bankNifty, v = regime.indiaVix;
    const label = regime.trendRegime || 'Unknown';
    const trendCls = /bullish|recovering|mildly bullish/i.test(label) ? 'bullish'
      : /bearish|softening|mildly bearish/i.test(label) ? 'bearish' : 'neutral';
    const todayDir = regime.todayDirection || n.todayDirection || '';
    const tech = regime.technicalTrend || n.technicalTrend || '';
    const vixChg = v.changePct != null
      ? ` <span class="${v.changePct >= 0 ? 'change up' : 'change down'}" style="display:inline;">${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}%</span>`
      : '';
    const pr = {
      ...(regime.periodReturns || {}),
      ...(n.periodReturns || {}),
    };
    const fmtPR = (val) => val == null || !Number.isFinite(Number(val)) ? '—'
      : `<span class="${Number(val) >= 0 ? 'change up' : 'change down'}" style="display:inline;">${Number(val) >= 0 ? '+' : ''}${Number(val).toFixed(2)}%</span>`;
    const asOfStr = (n.asOf || v.asOf || regime.asOf)
      ? new Date(n.asOf || v.asOf || regime.asOf).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      : '';
    const liveTag = regime.marketState || n.marketState || '';
    box.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <span class="verdict-badge ${trendCls}" style="padding:4px 12px;">Market: ${label}</span>
        ${todayDir ? `<span class="muted small">Today: <b>${todayDir}</b>${tech ? ` · Tech: ${tech}` : ''}</span>` : ''}
        <span class="muted small">VIX: <b>${v.level != null ? Number(v.level).toFixed(1) : '—'}</b>${vixChg} · ${regime.volatilityRegime || ''}</span>
        ${n.price ? `<span class="muted small">Nifty: <b>₹${Number(n.price).toFixed(0)}</b> ${fmtPR(n.oneDayChangePct)}</span>` : ''}
        ${b.price ? `<span class="muted small">BankNifty: <b>₹${Number(b.price).toFixed(0)}</b> ${fmtPR(b.oneDayChangePct)}</span>` : ''}
      </div>
      <div class="muted small" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:10px;">
        <span>1D ${fmtPR(pr.oneDay ?? n.oneDayChangePct)}</span>
        <span>1W ${fmtPR(pr.oneWeek ?? pr.week)}</span>
        <span>1M ${fmtPR(pr.oneMonth ?? pr.month)}</span>
        ${asOfStr ? `<span style="color:var(--accent,#6ea8fe);">Live as of ${asOfStr}${liveTag ? ' · ' + liveTag : ''}</span>` : '<span>Quote time: checking…</span>'}
        <button type="button" class="ghost-btn small" id="regimeRefreshBtn">↻ Refresh live</button>
      </div>
    `;
    document.getElementById('regimeRefreshBtn')?.addEventListener('click', () => {
      api('/market/regime?fresh=1').then(() => loadMarketRegime()).catch(() => loadMarketRegime());
    });
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

// ---------- index browser (Nifty50 / Midcap / Smallcap tabs) ----------
let currentIndexResults = [];
let currentIndexMarketContext = null;
let currentScreenerResults = [];
let currentScreenerMarketContext = null;

// Columns shown together (no dropdown-switching needed) so periods can be
// compared side by side at a glance.
const TABLE_COLUMNS = [
  { key: 'symbol', label: 'Symbol', sortable: false },
  { key: 'price', label: 'Price', fmt: (v) => v == null ? '-' : `₹${v.toFixed(2)}` },
  { key: 'oneDay', label: '1D %', period: true },
  { key: 'oneWeek', label: '1W %', period: true },
  { key: 'fifteenDay', label: '15D %', period: true },
  { key: 'oneMonth', label: '1M %', period: true },
  { key: 'twoMonth', label: '2M %', period: true },
  { key: 'threeMonth', label: '3M %', period: true },
  { key: 'oneYear', label: '1Y %', period: true },
  { key: 'fiveYear', label: '5Y %', period: true },
  { key: 'streak', label: 'Streak', fmt: (v, r) => r.streak && r.streak.days > 0 ? `${r.streak.direction === 'down' ? '▼' : '▲'} ${r.streak.days}d` : '-' },
  { key: 'score', label: 'Score' },
  { key: 'verdict', label: 'Verdict', sortable: false },
  { key: 'suggestedHorizon', label: 'Horizon', sortable: false },
];

function sortValue(r, key) {
  if (key === 'symbol' || key === 'verdict' || key === 'suggestedHorizon') return null;
  if (key === 'price' || key === 'score') return r[key];
  if (key === 'streak') return r.streak ? (r.streak.direction === 'down' ? -r.streak.days : r.streak.days) : 0;
  return r.periodReturns ? r.periodReturns[key] : undefined;
}

// Net move over 15 TRADING days (periodReturns.fifteenDay), NOT a raw
// consecutive-day streak - so a stock that fell 8 days, bounced 1 day, then
// fell 2 more days still correctly shows as a strong net decliner instead
// of the streak resetting to "up 1 day" and hiding it from a "falling"
// filter. Use dailyBreakdownToggle() below to see the actual day-by-day
// detail behind this net number.
function passesStreakFilter(r, filterValue) {
  if (!filterValue) return true;
  const val = r.periodReturns?.fifteenDay;
  if (val == null) return false;
  const m = filterValue.match(/^(down|up)_(\d+)_15$/);
  if (!m) return true;
  const [, dir, pctStr] = m;
  const threshold = Number(pctStr);
  return dir === 'down' ? val <= -threshold : val >= threshold;
}

// Renders a small toggle link + expandable day-by-day table from
// recentDailyChanges (already present on `r` from the bulk scan - no extra
// fetch needed). This is the actual "1-1 din ki list" - which day fell how
// much, which day rose, and by how much - instead of a single collapsed
// streak number.
function dailyBreakdownToggle(r) {
  const changes = r.recentDailyChanges;
  if (!changes || changes.length < 2) return '';
  const payload = JSON.stringify(changes).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<div style="margin-top:2px;"><a href="#" class="daily-breakdown-toggle" data-changes="${payload}" style="color:var(--accent); font-size:11px;">📅 Day-by-day (last ${changes.length}d)</a><div class="daily-breakdown-content" data-loaded="false"></div></div>`;
}
document.addEventListener('click', (e) => {
  const link = e.target.closest('.daily-breakdown-toggle');
  if (!link) return;
  e.preventDefault();
  const contentBox = link.nextElementSibling;
  if (!contentBox) return;
  if (contentBox.dataset.loaded === 'true') {
    contentBox.innerHTML = '';
    contentBox.dataset.loaded = 'false';
    return;
  }
  let changes = [];
  try { changes = JSON.parse(link.dataset.changes.replace(/&quot;/g, '"').replace(/&#39;/g, "'")); } catch { changes = []; }
  contentBox.innerHTML = `
    <table class="indicator-table" style="width:100%; margin-top:4px; font-size:11px;">
      ${changes.map((c) => `<tr><td>${c.date}</td><td class="change ${c.changePct >= 0 ? 'up' : 'down'}" style="display:table-cell;">${c.changePct >= 0 ? '+' : ''}${c.changePct}%</td></tr>`).join('')}
    </table>
  `;
  contentBox.dataset.loaded = 'true';
});

// Auto-computed "what's actually worth looking at today" - answers
// "kaun suitable hai aaj trade / short-term / long-term ke liye" without
// the user having to filter/sort manually themselves.
//
// Mirrors computeScoreBreakdown/computeRankScore in
// server/stockAnalysisEngine.js - a transparent, weighted 0-100 score
// (technical/R:R/momentum/volume/sector/market/historical), NOT the old
// scheme where a strong technical score could swamp a terrible R:R (a
// 1:0.07 setup ranking #1 purely because its raw score was high). Kept as
// a client-side mirror, not a server round-trip, since this runs on data
// already fetched for whichever index tab is open.
const SCORE_WEIGHTS_CLIENT = {
  technical: 0.22, riskReward: 0.22, momentum: 0.14, volume: 0.10,
  sectorAlignment: 0.08, marketAlignment: 0.10, historical: 0.14,
};
function clampScore(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }
function scoreTechnicalClient(r) { return r.score == null ? 50 : clampScore(50 + r.score * 9); }
function scoreRiskRewardClient(rr) {
  if (rr == null || !isFinite(rr) || rr <= 0) return 5;
  if (rr < 1) return clampScore(15 * rr);
  if (rr < 1.5) return clampScore(15 + (rr - 1) * 70);
  if (rr < 2) return clampScore(50 + (rr - 1.5) * 60);
  return clampScore(80 + (rr - 2) * 10);
}
function scoreMomentumClient(r) {
  let s = 50;
  const ind = r.indicators || {};
  if (ind.ema9 != null && ind.ema21 != null) s += ind.ema9 > ind.ema21 ? 12 : -12;
  if (ind.macdHistogram != null) s += ind.macdHistogram > 0 ? 10 : -10;
  if (ind.rsi14 != null) {
    if (ind.rsi14 >= 45 && ind.rsi14 <= 65) s += 12;
    else if (ind.rsi14 > 72) s -= 10;
    else if (ind.rsi14 < 35) s -= 8;
  }
  const wk = r.periodReturns?.oneWeek;
  if (wk != null) s += clampScore(wk * 2, -16, 16);
  return clampScore(s);
}
function scoreVolumeClient(r) {
  const vs = r.volSpike ?? r.indicators?.volSpike;
  if (vs == null) return 50;
  if (vs >= 2) return 95;
  if (vs >= 1.5) return 82;
  if (vs >= 1) return 62;
  if (vs >= 0.7) return 42;
  return 22;
}
function scoreMarketAlignmentClient(r, marketContext) {
  if (!marketContext?.trend) return 50;
  const v = (r.verdict || '').toLowerCase();
  const bullish = v.includes('bullish'), bearish = v.includes('bearish');
  if (marketContext.trend === 'bullish' && bullish) return 85;
  if (marketContext.trend === 'bearish' && bearish) return 85;
  if (marketContext.trend === 'bullish' && bearish) return 20;
  if (marketContext.trend === 'bearish' && bullish) return 20;
  return 55;
}
function scoreHistoricalClient(r) {
  const p = r.moveProbability;
  if (!p || p.status !== 'ok' || p.sampleSize < 8) return 50;
  let s = 50 + (p.probabilityUp1PctPlus - 50) * 0.7;
  s -= Math.max(0, p.probabilityDown2PctPlus - 30) * 0.9;
  return clampScore(s);
}
// Full transparent breakdown, same shape as the backend's
// computeScoreBreakdown - used both for ranking AND for the "why this
// score" display on Golden/Swing setup cards.
function computeScoreBreakdown(r, marketContext = null) {
  if (r.error || r.score == null) {
    return { overall: 0, components: {}, weights: SCORE_WEIGHTS_CLIENT, error: true };
  }
  const components = {
    technical: Number(scoreTechnicalClient(r).toFixed(1)),
    riskReward: Number(scoreRiskRewardClient(r.tradePlan?.riskRewardRatio).toFixed(1)),
    momentum: Number(scoreMomentumClient(r).toFixed(1)),
    volume: Number(scoreVolumeClient(r).toFixed(1)),
    sectorAlignment: 50, // sector-today context isn't fetched into this per-index view - neutral, not a penalty
    marketAlignment: Number(scoreMarketAlignmentClient(r, marketContext).toFixed(1)),
    historical: Number(scoreHistoricalClient(r).toFixed(1)),
  };
  const overall = clampScore(Object.entries(SCORE_WEIGHTS_CLIENT).reduce((sum, [k, w]) => sum + components[k] * w, 0));
  return { overall: Number(overall.toFixed(1)), components, weights: SCORE_WEIGHTS_CLIENT };
}
function computeRankScore(r, marketContext) {
  if (r.error || r.score == null) return -Infinity;
  return computeScoreBreakdown(r, marketContext).overall;
}
// Filters candidates by expected holding period, using each stock's own
// history (see targetTimeline / estimateTargetTimeline on the server) -
// not a guess. 'any' = no filter.
function passesTimeFilter(r, timeFilter) {
  if (!timeFilter || timeFilter === 'any') return true;
  const tt = r.targetTimeline;
  if (!tt || tt.status !== 'ok') return false; // no reliable estimate - exclude rather than guess when a specific window was asked for
  return tt.suggestedWindow === timeFilter;
}

// Small inline badge showing how long, historically, this stock has taken
// to reach a similar target - so "buy now" doesn't imply "today or never".
function timelineBadge(r) {
  const tt = r.targetTimeline;
  if (!tt || tt.status !== 'ok') return '';
  const meta = {
    '7d': ['⚡', 'Fast — historically often hit target within ~7 days'],
    '15d': ['🕐', 'Medium — historically often needs ~15 days'],
    '30d': ['🐢', 'Patient — historically often needs ~30 days'],
    '30d_plus': ['⏳', 'Long swing — historically often takes 30+ days, or hasn\'t reliably hit this target within a month'],
  }[tt.suggestedWindow] || ['', ''];
  return `<div class="muted small" style="margin-top:2px;">${meta[0]} <b>${meta[1]}</b> <span style="font-size:10px;">(n=${tt.sampleSize}: ${tt.horizons.d7}% by 7d, ${tt.horizons.d15}% by 15d, ${tt.horizons.d30}% by 30d hit this stock's own ${tt.targetPct}%+ target historically)</span></div>`;
}

// Used only to gate the deliberately-rare Golden Setup picks (mirrors
// server/stockAnalysisEngine.js) - Top Picks/Swing Setups are NOT gated by
// this, see computeTopPicks below for why.
function isActionable(r) {
  if (r.decision == null) return true; // decision gate not present on this data - don't hide over it
  return r.decision === 'BUY NOW' || r.decision === 'BUY ON PULLBACK';
}
// Intentionally NOT hard-filtered by isActionable: in a broadly bearish
// market almost nothing passes a strict R:R+regime gate, and hiding every
// row would make this screening tool useless exactly when it's most
// needed. Mirrors TOP_PICKS_LIMIT in server/stockAnalysisEngine.js -
// intraday shows more (8) than short/long-term (5) since it's the
// fastest-moving category with the most genuine same-day candidates.
// buyRangeNote() honestly flags (rather than hides) any pick that wouldn't
// survive its own Decision Card.
const TOP_PICKS_LIMIT = { intraday: 8, short_term: 5, long_term: 5 };
function computeTopPicks(results, marketContext = null, timeFilter = 'any') {
  const valid = results.filter((r) => !r.error && r.score > 0 && passesTimeFilter(r, timeFilter));
  const pick = (horizon) => valid
    .filter((r) => r.suggestedHorizon === horizon)
    .sort((a, b) => computeRankScore(b, marketContext) - computeRankScore(a, marketContext))
    .slice(0, TOP_PICKS_LIMIT[horizon] || 5);
  return {
    intraday: pick('intraday'),
    short_term: pick('short_term'),
    long_term: pick('long_term'),
  };
}

function buyRangeNote(r) {
  if (!r.tradePlan || r.price == null) return '';
  const p = r.tradePlan;
  const inZone = r.price >= p.entryLow && r.price <= p.entryHigh;
  // Even if the price is technically inside the entry zone, don't call it
  // a green buy signal if it wouldn't survive the Decision Card's own
  // checklist (R:R gate, market regime) - say clearly why, so this list
  // never contradicts what clicking into the stock's own Decision Card says.
  if (inZone && !isActionable(r)) {
    const reason = (r.decisionWhyNot && r.decisionWhyNot[0]) || 'fails the Decision Card\'s trade checklist';
    return `<div class="muted small" style="margin-top:2px; color:var(--amber);">⚠️ In price zone, but NOT a clean buy — ${reason}</div>`;
  }
  if (inZone) {
    return `<div class="change up" style="font-size:11px; margin-top:2px;">✅ In buy zone now (₹${p.entryLow}–₹${p.entryHigh}) · SL ₹${p.stopLoss} · Target ₹${p.target}</div>`;
  }
  if (r.price < p.entryLow) {
    return `<div class="muted" style="font-size:11px; margin-top:2px;">⏳ Below suggested entry (₹${p.entryLow}–₹${p.entryHigh}) — could fall further first</div>`;
  }
  return `<div class="muted" style="font-size:11px; margin-top:2px;">⏫ Already ran past suggested entry (₹${p.entryLow}–₹${p.entryHigh}) — wait for a pullback rather than chasing</div>`;
}

// Shows the honest, history-derived odds - not a guess. Small samples are
// flagged rather than hidden, since a number from 4 past occurrences is
// very different from one built on 40.
function dropChanceStyle(pct) {
  // High drop risk → red; mid → amber; low → blue (UI-friendly)
  if (pct == null || !Number.isFinite(Number(pct))) return 'color:inherit';
  const n = Number(pct);
  if (n >= 45) return 'color:var(--red,#f07178);font-weight:700';
  if (n >= 28) return 'color:#fbbf24;font-weight:600';
  return 'color:#6ea8fe;font-weight:600';
}
function probabilityLine(r) {
  const mp = r.moveProbability;
  if (!mp || mp.status !== 'ok') return '';
  const upCls = mp.probabilityUp1PctPlus >= 60 ? 'up' : '';
  const downStyle = dropChanceStyle(mp.probabilityDown2PctPlus);
  return `<div class="muted" style="font-size:11px; margin-top:2px;">📊 History (n=${mp.sampleSize}): <span class="change ${upCls}" style="display:inline;">${mp.probabilityUp1PctPlus}%</span> chance hit +1%, <span class="muted" style="display:inline;">${mp.probabilityUp5PctPlus}%</span> chance hit +5%, <span style="display:inline;${downStyle}">${mp.probabilityDown2PctPlus}%</span> chance dropped 2%+ (next ${mp.lookAheadDays}d, based on similar past signals on this stock)</div>`;
}

// ---------- Quick "mark as taken" widget ----------
// Every pick list (Top Picks, Golden Opportunities, Golden Setups, Swing
// Setups) shows a lot of candidates, but a person only ever *acts* on a
// few of them - some, one, or none. This renders a small inline control on
// each row so picking one and logging exactly what was actually taken
// (qty + price) takes one click + a number, instead of leaving the row,
// finding the symbol again, and filling the full Journal form.
function quickLogWidget(r, horizonHint) {
  const horizon = r.suggestedHorizon || horizonHint || 'short_term';
  const price = r.price != null ? r.price.toFixed(2) : '';
  const sl = r.tradePlan?.stopLoss ?? '';
  const target = r.tradePlan?.target ?? '';
  const uid = `${r.symbol}-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div class="ql-wrap" data-symbol="${r.symbol}">
      <button type="button" class="ql-btn" data-symbol="${r.symbol}" data-uid="${uid}">✓ Maine ye liya</button>
      <div class="ql-logged-list"></div>
      <div class="ql-form hidden" data-symbol="${r.symbol}" data-horizon="${horizon}" data-uid="${uid}">
        <div class="ql-title">Log ${r.symbol} to your journal</div>
        <div class="ql-row">
          <label class="ql-field"><span>Buy/Sell</span><select class="ql-side">
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select></label>
          <label class="ql-field"><span>Qty (shares)</span><input type="number" step="0.01" class="ql-qty" placeholder="e.g. 10" /></label>
          <label class="ql-field"><span>Your price ₹</span><input type="number" step="0.05" class="ql-price" value="${price}" /></label>
          <label class="ql-field"><span>Stop-loss ₹ <i>(opt.)</i></span><input type="number" step="0.05" class="ql-sl" value="${sl}" /></label>
          <label class="ql-field"><span>Target ₹ <i>(opt.)</i></span><input type="number" step="0.05" class="ql-target" value="${target}" /></label>
        </div>
        <div class="ql-row ql-row-actions">
          <button type="button" class="ql-submit">✓ Save to journal</button>
          <button type="button" class="ql-cancel">Cancel</button>
        </div>
        <div class="ql-chart-block">
          <div class="ql-chart-bar">
            <button type="button" class="ql-chart-range-btn active" data-range="5d">5D</button>
            <button type="button" class="ql-chart-range-btn" data-range="1d">1D <span class="live-dot ql-chart-live-dot hidden"></span></button>
            <button type="button" class="ql-chart-range-btn" data-range="1mo">1M</button>
            <button type="button" class="ql-chart-range-btn" data-range="3mo">3M</button>
            <button type="button" class="ql-chart-range-btn" data-range="1y">1Y</button>
          </div>
          <div class="ql-chart-canvas" id="ql-chart-${uid}"><span class="muted small">Loading chart...</span></div>
        </div>
      </div>
    </div>
  `;
}

// Fetches and draws the small chart inside an open quick-log form. Reuses
// the same /stocks/:symbol/chart endpoint and SVG renderer as the main
// symbol-page chart - so "before I log this, let me glance at the chart"
// never requires leaving the picks list. For the 1D range specifically,
// also pulls the exact live quote (not just the last 1-minute candle's
// close) so the price shown is the actual current tick, timestamped.
async function loadQlChart(symbol, uid, range) {
  const canvasId = `ql-chart-${uid}`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const form = canvas.closest('.ql-form');
  canvas.innerHTML = '<span class="muted small">Loading chart...</span>';
  try {
    const chartPromise = api(`/stocks/${symbol}/chart?range=${range}`);
    const quotePromise = range === '1d' ? api(`/stocks/${symbol}/quote`).then((r) => r.quote).catch(() => null) : Promise.resolve(null);
    const [{ candles, isIntraday }, liveQuote] = await Promise.all([chartPromise, quotePromise]);
    const labels = candles.map((c) => isIntraday
      ? new Date(c.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : c.date);
    const closes = candles.map((c) => c.close);
    // The exact live tick, if we have one, replaces the last candle point
    // so the chart's rightmost edge matches the price actually shown right
    // now - not whatever the last completed 1-minute bar happened to close at.
    if (liveQuote?.lastPrice != null && isIntraday) {
      labels[labels.length - 1] = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      closes[closes.length - 1] = liveQuote.lastPrice;
    }
    renderSvgLineChart(canvasId, labels, [{ data: closes, color: '#3ea6ff' }], { height: 120 });
    form?.querySelector('.ql-chart-live-dot')?.classList.toggle('hidden', range !== '1d');
    let liveLabel = form?.querySelector('.ql-chart-live-price');
    if (range === '1d' && liveQuote?.lastPrice != null) {
      if (!liveLabel) {
        liveLabel = document.createElement('div');
        liveLabel.className = 'ql-chart-live-price muted small';
        canvas.insertAdjacentElement('beforebegin', liveLabel);
      }
      let dayPct = liveQuote.pChange;
      if ((dayPct == null || dayPct === 0) && liveQuote.change != null && liveQuote.previousClose > 0) {
        dayPct = (liveQuote.change / liveQuote.previousClose) * 100;
      }
      if ((dayPct == null || dayPct === 0) && liveQuote.lastPrice != null && liveQuote.previousClose > 0) {
        dayPct = ((liveQuote.lastPrice - liveQuote.previousClose) / liveQuote.previousClose) * 100;
      }
      const cls = (dayPct ?? 0) >= 0 ? 'up' : 'down';
      liveLabel.innerHTML = `🔴 Live: <b>₹${liveQuote.lastPrice.toFixed(2)}</b> <span class="change ${cls}" style="display:inline;">${(dayPct ?? 0) >= 0 ? '+' : ''}${(dayPct != null ? dayPct : 0).toFixed(2)}%</span> · updated ${new Date().toLocaleTimeString('en-IN', { hour12: false })}`;
      liveLabel.classList.remove('hidden');
    } else if (liveLabel) {
      liveLabel.classList.add('hidden');
    }
  } catch (err) {
    canvas.innerHTML = `<span class="muted small">${err.message}</span>`;
  }
}

function clearQlLiveTimer(uid) {
  const t = qlLiveTimers.get(uid);
  if (t) { clearInterval(t); qlLiveTimers.delete(uid); }
}

// Starts (or restarts) a "live-ish" refresh for a quick-log mini-chart
// pinned to the 1D range. There's no per-row WebSocket subscription here
// (that's reserved for whichever single symbol the person has open on the
// full symbol page) - a fast poll of today's intraday candles PLUS the
// exact live quote (see loadQlChart above) gets the same "it's visibly
// moving, with the real current price" feel across however many pick rows
// someone has expanded at once, without needing a multi-symbol WS feed.
function startQlLiveRefresh(symbol, uid) {
  clearQlLiveTimer(uid);
  const id = setInterval(() => {
    const canvas = document.getElementById(`ql-chart-${uid}`);
    if (!canvas || !document.body.contains(canvas)) { clearQlLiveTimer(uid); return; }
    loadQlChart(symbol, uid, '1d');
  }, 6000);
  qlLiveTimers.set(uid, id);
}

// One-time delegated handler for every ql-btn / ql-submit / ql-cancel on the
// page, however many rows get re-rendered. Kept separate from each row's
// own "click to open symbol" listener - those already bail out early when
// the click lands inside .ql-wrap (see the .closest('.ql-wrap') guards
// below each renderXSetups function).
document.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('.ql-btn');
  if (openBtn) {
    e.stopPropagation();
    const form = openBtn.parentElement.querySelector('.ql-form');
    const isHidden = form.classList.contains('hidden');
    // close any other open quick-log forms first, so only one is open at a time
    document.querySelectorAll('.ql-form:not(.hidden)').forEach((f) => { f.classList.add('hidden'); clearQlLiveTimer(f.dataset.uid); });
    if (isHidden) {
      form.classList.remove('hidden');
      form.querySelector('.ql-qty')?.focus();
      if (!form.dataset.chartLoaded) {
        form.dataset.chartLoaded = '1';
        loadQlChart(form.dataset.symbol, form.dataset.uid, '5d');
      }
    } else {
      clearQlLiveTimer(form.dataset.uid);
    }
    return;
  }
  const qlRangeBtn = e.target.closest('.ql-chart-range-btn');
  if (qlRangeBtn) {
    e.stopPropagation();
    const form = qlRangeBtn.closest('.ql-form');
    form.querySelectorAll('.ql-chart-range-btn').forEach((b) => b.classList.toggle('active', b === qlRangeBtn));
    clearQlLiveTimer(form.dataset.uid);
    loadQlChart(form.dataset.symbol, form.dataset.uid, qlRangeBtn.dataset.range);
    if (qlRangeBtn.dataset.range === '1d') startQlLiveRefresh(form.dataset.symbol, form.dataset.uid);
    return;
  }
  const cancelBtn = e.target.closest('.ql-cancel');
  if (cancelBtn) {
    e.stopPropagation();
    const form = cancelBtn.closest('.ql-form');
    clearQlLiveTimer(form.dataset.uid);
    form.classList.add('hidden');
    return;
  }
  const submitBtn = e.target.closest('.ql-submit');
  if (submitBtn) {
    e.stopPropagation();
    const form = submitBtn.closest('.ql-form');
    const wrap = form.closest('.ql-wrap');
    const symbol = form.dataset.symbol;
    const horizon = form.dataset.horizon;
    const side = form.querySelector('.ql-side').value;
    const quantity = form.querySelector('.ql-qty').value;
    const price = form.querySelector('.ql-price').value;
    const stopLoss = form.querySelector('.ql-sl').value;
    const target = form.querySelector('.ql-target').value;
    if (!quantity || Number(quantity) <= 0) { toast('Enter how many shares/units you took'); return; }
    if (!price || Number(price) <= 0) { toast('Enter the price you took it at'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging...';
    try {
      await api('/journal', {
        method: 'POST',
        body: JSON.stringify({ symbol, side, quantity, price, horizon, stopLoss: stopLoss || null, target: target || null, reason: 'Marked as taken from picks list' }),
      });
      // Don't destroy the button/form - someone may want to log a second
      // buy on the same pick later (averaging in, or just re-checking the
      // chart). Show a confirmation line, close the form, but leave the
      // "✓ Maine ye liya" button live and clickable for next time.
      const loggedList = wrap.querySelector('.ql-logged-list');
      if (loggedList) {
        const line = document.createElement('div');
        line.className = 'ql-logged';
        line.textContent = `✓ Logged: ${side} ${quantity} @ ₹${Number(price).toFixed(2)}`;
        loggedList.appendChild(line);
      }
      form.classList.add('hidden');
      form.querySelector('.ql-qty').value = '';
      submitBtn.disabled = false;
      submitBtn.textContent = '✓ Save to journal';
      clearQlLiveTimer(form.dataset.uid);
      toast(`${symbol} added to your journal`);
      loadJournal();
      loadPositions();
      loadPortfolio();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log it';
      toast(err.message);
    }
  }
});

function renderTopPicks(results, containerId, marketContext = null, timeFilter = 'any') {
  const box = document.getElementById(containerId);
  const picks = computeTopPicks(results, marketContext, timeFilter);
  const sections = [
    ['intraday', "Today's best for Intraday"],
    ['short_term', 'Best for Short/Mid-term'],
    ['long_term', 'Best for Long-term'],
  ];
  const anyPicks = sections.some(([key]) => picks[key].length);
  if (!anyPicks) {
    box.innerHTML = timeFilter !== 'any'
      ? `<div class="muted small" style="margin:14px 0; padding:10px; border:1px dashed var(--border); border-radius:8px;">Nothing currently matches that holding-period filter. Try "Any holding period", or check back after today's scan.</div>`
      : '';
    return;
  }
  box.innerHTML = `
    <div style="margin:14px 0;">
      <div class="muted small" style="margin-bottom:8px;">📌 Auto-picked — no filtering needed. Based on today's technical score only, not a guarantee.</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
        ${sections.map(([key, label]) => `
          <div class="card" style="padding:12px;">
            <div class="muted small" style="margin-bottom:8px; text-transform:uppercase; letter-spacing:.04em;">${label}</div>
            ${picks[key].length ? picks[key].map((r) => `
              <div class="pick-row" data-symbol="${r.symbol}" style="padding:6px 0; cursor:pointer; border-bottom:1px solid var(--border);">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span><b>${r.symbol}</b> <span class="muted" style="font-size:11px;">₹${r.price?.toFixed(2) ?? '-'}</span></span>
                  <span class="verdict-badge ${verdictClass(r.verdict)}" style="padding:2px 8px; font-size:11px;">${r.verdict}</span>
                </div>
                ${buyRangeNote(r)}
                ${timelineBadge(r)}
                ${dailyBreakdownToggle(r)}
                ${probabilityLine(r)}
                <div class="price-history-box" data-hist-symbol="${r.symbol}" data-hist-category="${key}"></div>
                ${quickLogWidget(r, key)}
              </div>
            `).join('') : '<div class="muted small">Nothing qualifies right now</div>'}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  sections.forEach(([key]) => picks[key].forEach((r) => loadPriceHistory(r.symbol, key)));
  box.querySelectorAll('.pick-row').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ql-wrap')) return;
      loadSymbol(el.dataset.symbol);
    });
  });
}

// Swing-trade specific view: momentum picks AND reversal/bounce candidates
// together (a pure "highest score" list misses stocks that fell a lot and
// are just turning up near support - still worth a swing trader's look).
// Same reasoning as computeTopPicks - not hard-gated by isActionable, so a
// quiet/bearish day still shows the best available momentum/reversal
// candidates. buyRangeNote() flags any that wouldn't pass the Decision Card.
function computeSwingSetups(results, timeFilter = 'any', marketContext = null) {
  const valid = results.filter((r) => !r.error && r.suggestedHorizon !== 'intraday' && r.setup && r.setup.type && passesTimeFilter(r, timeFilter));
  const byRank = (a, b) => computeRankScore(b, marketContext) - computeRankScore(a, marketContext);
  const momentum = valid.filter((r) => r.setup.type === 'momentum').sort(byRank).slice(0, 6);
  const reversal = valid.filter((r) => r.setup.type === 'reversal').sort(byRank).slice(0, 6);
  return { momentum, reversal };
}

// Does this stock show real directional conviction - either a strong raw
// bullish score, OR a genuine reversal/bounce setup (fell hard, now
// turning up) even if its raw score is still weak/negative. Mirrors
// hasConviction in server/stockAnalysisEngine.js.
function hasConviction(r, minScore) {
  if (r.error) return false;
  if (r.score >= minScore) return true;
  if (r.setup?.type === 'reversal') return true;
  return false;
}

// Four-tier setup quality, loosest (🥉 Bronze) to strictest (💎 Diamond) -
// mirrors classifyOpportunityTier in server/stockAnalysisEngine.js. Every
// tier requires isActionable() - it must also pass the Decision Card's own
// checklist, so nothing labeled an "opportunity" here would show NO TRADE
// on its own Decision Card.
function classifyOpportunityTier(r) {
  if (r.error || !r.tradePlan || !r.price || !isActionable(r)) return null;
  const p = r.tradePlan;
  const rr = p.riskRewardRatio;
  if (rr == null) return null;
  const vol = r.volSpike;
  const inZone = r.price >= p.entryLow && r.price <= p.entryHigh;
  const nearZone = r.price >= p.entryLow * 0.97 && r.price <= p.entryHigh * 1.03;
  const upside = r.potentialReturnPct ?? (r.tradePlan && r.price ? ((r.tradePlan.target - r.price) / r.price) * 100 : null);
  const downside = r.moveProbability?.status === 'ok' ? r.moveProbability.probabilityDown2PctPlus : null;

  if (hasConviction(r, 4) && rr >= 3 && vol != null && vol >= 2 && inZone
      && upside != null && upside >= 5 && upside <= 50
      && (downside == null || downside <= 35)) {
    return 'diamond';
  }
  if (hasConviction(r, 4) && rr >= 3 && vol != null && vol >= 2 && inZone) return 'gold';
  if (hasConviction(r, 2.5) && rr >= 2 && vol != null && vol >= 1.3 && inZone) return 'silver';
  if (hasConviction(r, 1) && rr >= 1.3 && nearZone) return 'bronze';
  return null;
}

function computeTieredOpportunities(results) {
  const tiers = { diamond: [], gold: [], silver: [], bronze: [] };
  results.forEach((r) => {
    const tier = classifyOpportunityTier(r);
    if (tier) tiers[tier].push(r);
  });
  Object.keys(tiers).forEach((t) => tiers[t].sort((a, b) => (b.tradePlan.riskRewardRatio || 0) - (a.tradePlan.riskRewardRatio || 0)));
  return tiers;
}

const TIER_META = {
  diamond: { icon: '💎', label: 'Diamond', color: '#93c5fd', desc: 'Everything below, PLUS a real 5-50% target upside and history says downside risk is low.' },
  gold: { icon: '🥇', label: 'Gold', color: '#fbbf24', desc: 'Strong conviction, strong R:R (≥3), real volume confirmation, still in the buy zone.' },
  silver: { icon: '🥈', label: 'Silver', color: '#cbd5e1', desc: 'Solid but not exceptional: decent conviction, acceptable R:R (≥2), some volume confirmation.' },
  bronze: { icon: '🥉', label: 'Bronze', color: '#d97706', desc: 'Flexible catch-all: includes reversal/bounce setups, workable R:R (≥1.3), close to the buy zone.' },
};

// ---------- Auto-refresh: Golden Opportunity Scanner + Best of Today ----------
// Every 25 minutes, UNLESS a manual "Rescan" (or any reload of that same
// card, auto or manual) already happened more recently - each refresh
// pushes the next one 25 minutes further out, rather than ticking on a
// fixed clock regardless of what the person's already done. Self-pauses
// outside market hours by just rechecking every 25 min until it's live
// again, instead of firing pointless calls after close.
const AUTO_REFRESH_MS = 25 * 60 * 1000;
let goldenAutoRefreshTimer = null;
let bestOfTodayAutoRefreshTimer = null;

function scheduleGoldenAutoRefresh() {
  clearTimeout(goldenAutoRefreshTimer);
  goldenAutoRefreshTimer = setTimeout(() => {
    if (isIndianMarketHours() && TOKEN) loadGoldenOpportunities();
    else scheduleGoldenAutoRefresh();
  }, AUTO_REFRESH_MS);
}
function scheduleBestOfTodayAutoRefresh() {
  clearTimeout(bestOfTodayAutoRefreshTimer);
  bestOfTodayAutoRefreshTimer = setTimeout(() => {
    if (isIndianMarketHours() && TOKEN) loadBestOfToday();
    else scheduleBestOfTodayAutoRefresh();
  }, AUTO_REFRESH_MS);
}

// ---------- Best of Today: Short-term vs Long-term vs Momentum vs Reversal ----------
// "In charon mein se sabse achha kaun hai" - each category's own #1
// candidate (same ranking already used for that category everywhere else
// in the app), run across the FULL combined universe, side by side, with
// one explicit overall-winner call using the same composite rank score
// (technical score + R:R + volume + this stock's own historical
// profit/loss odds + market-regime alignment) the rest of the app relies on.
const BEST_OF_TODAY_META = {
  short_term: { icon: '📆', label: 'Short-term', color: '#3ea6ff' },
  long_term: { icon: '🗓️', label: 'Long-term', color: '#8b7dff' },
  momentum: { icon: '📈', label: 'Momentum', color: '#22c55e' },
  reversal: { icon: '🔄', label: 'Reversal/Bounce', color: '#f5a623' },
};


let _fundWarmRunning = false;
async function startFundamentalsWarmAndRefresh(symbols, onDone) {
  if (_fundWarmRunning) return;
  _fundWarmRunning = true;
  try {
    const start = await api('/stocks/fundamentals-warm', {
      method: 'POST',
      body: JSON.stringify({ symbols: (symbols || []).slice(0, 60) }),
    });
    const jobId = start.jobId;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      let prog = null;
      try { prog = await api('/stocks/fundamentals-warm/' + jobId); } catch (_) {}
      const el = document.getElementById('fundWarmStatus');
      if (el && prog?.ok) {
        el.textContent = `📦 Fundamentals cache: ${prog.percent || 0}% · ${prog.message || prog.detail || ''}`;
      }
      if (prog?.phase === 'done' || (prog?.percent != null && prog.percent >= 100)) break;
    }
    if (typeof onDone === 'function') onDone();
  } catch (err) {
    console.warn('fund warm', err);
  } finally {
    _fundWarmRunning = false;
  }
}

async function loadBestOfToday() {
  const box = document.getElementById('bestOfTodayCard');
  if (!box) return;
  scheduleBestOfTodayAutoRefresh();
  if (!isIndianMarketHours()) { box.innerHTML = ''; return; }
  box.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;"><div style="font-weight:700;">🏆 Best of Today</div><button id="bestOfTodayScanBtn" class="small">🔍 Rescan</button></div><div class="muted small" style="margin-top:6px;"><span class="spin"></span> Comparing categories…</div>';
  document.getElementById('bestOfTodayScanBtn')?.addEventListener('click', loadBestOfToday);
  try {
    const data = await api('/stocks/best-of-today');
    const { categories, learningFilter } = data;
    if ((data.fundamentalsMissing || 0) > 0) {
      startFundamentalsWarmAndRefresh(data.fundamentalsMissingSample || [], () => loadBestOfToday());
    }

    const MIN_RR = 1.5;
    const CAPITAL = Number(window.__BOT_CAPITAL__ || 10000);
    const RISK_PCT = Number(window.__BOT_RISK_PCT__ || 2);
    const ROUND_TRIP_CHG_PCT = 0.25; // approx brokerage+taxes soft estimate

    function rrOf(r) {
      const v = r?.tradePlan?.riskRewardRatio;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    }
    function tradeQuality(r) {
      const rr = rrOf(r);
      const vol = r?.volSpike ?? r?.scoreBreakdown?.components?.volume;
      let q = 50;
      if (rr != null) {
        if (rr >= 3) q += 25;
        else if (rr >= 2) q += 15;
        else if (rr >= 1.5) q += 8;
        else q -= 25;
      } else q -= 10;
      if (vol != null) {
        if (vol >= 70 || vol >= 2) q += 10;
        else if (vol < 40 && vol < 1.2) q -= 10;
      }
      return Math.max(0, Math.min(100, Math.round(q)));
    }
    function confidenceOf(r) {
      const n = r?.moveProbability?.sampleSize ?? r?.historicalSampleSize ?? r?.scoreBreakdown?.components?.historical;
      let c = 45;
      const score = r?.score ?? r?.scoreBreakdown?.overall;
      if (score != null) c += Math.max(-15, Math.min(20, (Number(score) - 55) * 0.5));
      if (n != null && n >= 40) c += 15;
      else if (n != null && n >= 15) c += 5;
      else if (n != null && n < 10) c -= 15;
      if (rrOf(r) != null && rrOf(r) < MIN_RR) c -= 12;
      return Math.max(10, Math.min(90, Math.round(c)));
    }
    function actionOf(r) {
      const rr = rrOf(r);
      const conf = confidenceOf(r);
      const tq = tradeQuality(r);
      if (rr != null && rr < 1.2) return 'NO TRADE';
      if (rr != null && rr < MIN_RR) return 'WATCHLIST';
      if (conf < 40 || tq < 40) return 'WAIT';
      const px = r.price;
      const el = r.tradePlan?.entryLow;
      const eh = r.tradePlan?.entryHigh;
      if (el != null && eh != null && px != null) {
        if (px > eh * 1.01) return 'BUY ON PULLBACK';
        if (px >= el && px <= eh * 1.005) return 'BUY NOW';
        if (px < el) return 'BUY ON PULLBACK';
      }
      if (tq >= 65 && conf >= 55) return 'BUY NOW';
      if (tq >= 55) return 'WATCHLIST';
      return 'WAIT';
    }
    function actionCls(a) {
      if (a === 'BUY NOW') return 'buy';
      if (a === 'BUY ON PULLBACK') return 'watch';
      if (a === 'NO TRADE' || a === 'WAIT') return 'wait';
      return 'watch';
    }
    function positionSize(r) {
      const px = r.price;
      const sl = r.tradePlan?.stopLoss;
      if (!px || !sl || px <= sl) return null;
      const riskInr = CAPITAL * (RISK_PCT / 100);
      const riskPerShare = px - sl;
      const qty = Math.max(0, Math.floor(riskInr / riskPerShare));
      return { capital: CAPITAL, riskInr: Math.round(riskInr), qty, riskPerShare: Number(riskPerShare.toFixed(2)) };
    }
    function netExpected(r, pos) {
      const px = r.price;
      const tgt = r.tradePlan?.target;
      if (!px || !tgt || !pos?.qty) return null;
      const gross = (tgt - px) * pos.qty;
      const charges = (px * pos.qty + tgt * pos.qty) * (ROUND_TRIP_CHG_PCT / 100);
      return { gross: Math.round(gross), net: Math.round(gross - charges), charges: Math.round(charges) };
    }

    // Eligible overall winner: R:R >= 1.5 preferred, higher quality+confidence
    const cats = (categories || []).map((c) => {
      const r = c.pick || c.top || c.result || c;
      // categories shape: { key, pick: stock }
      return c;
    });

    function pickRow(c) {
      return c.pick || c.stock || c.result || null;
    }

    let winnerKey = null;
    let winnerScore = -1;
    for (const c of (categories || [])) {
      const r = pickRow(c);
      if (!r) continue;
      const rr = rrOf(r);
      if (rr == null || rr < MIN_RR) continue;
      const conf = confidenceOf(r);
      const tq = tradeQuality(r);
      if (conf < 40) continue;
      const rank = (r.score || 0) * 0.5 + tq * 0.3 + conf * 0.2 + Math.min(rr, 4) * 5;
      if (rank > winnerScore) {
        winnerScore = rank;
        winnerKey = c.key;
      }
    }

    const regime = data.marketContext || data.regime || {};
    const regimeLabel = regime.trend || regime.trendRegime || data.marketTrend || '—';
    const vix = regime.indiaVix?.level ?? regime.vix ?? data.indiaVix ?? null;
    const updated = data.scannedAt || data.updatedAt || null;

    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:700; margin-bottom:2px;">🏆 Best of Today</div>
          <div class="muted small">R:R ≥ ${MIN_RR} preferred · below = flagged, cannot be Overall Winner. Score ≠ Trade Quality ≠ Confidence.</div>
          <div class="muted small" style="margin-top:4px;">
            Market: <b>${regimeLabel}</b>
            ${vix != null ? ` · VIX <b>${Number(vix).toFixed(1)}</b>` : ''}
            ${updated ? ` · Updated ${new Date(updated).toLocaleString('en-IN')}` : ''}
            · Size base ₹${CAPITAL} · risk ${RISK_PCT}%
          </div>
          ${(data.fundamentalsMissing || 0) > 0 ? `<div id="fundWarmStatus" class="muted small">📦 Fund cache pending: ${data.fundamentalsMissing}</div>` : ''}
          ${learningFilter?.message ? `<div class="muted small">🧠 ${learningFilter.message}</div>` : ''}
        </div>
        <button id="bestOfTodayScanBtn" class="small ghost-btn">🔍 Rescan</button>
      </div>
      <div class="grid" style="margin-top:12px; display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px;">
        ${(categories || []).map((c) => {
          const meta = BEST_OF_TODAY_META[c.key] || { label: c.key, icon: '', color: '#94a3b8' };
          const r = pickRow(c);
          if (!r) {
            return `<div class="card" style="padding:12px; border-top:3px solid ${meta.color};"><div style="font-weight:600;">${meta.icon || ''} ${meta.label}</div><div class="muted small">No pick</div></div>`;
          }
          const rr = rrOf(r);
          const rrFlag = rr != null && rr < MIN_RR;
          const tq = tradeQuality(r);
          const conf = confidenceOf(r);
          const act = actionOf(r);
          const pos = positionSize(r);
          const net = netExpected(r, pos);
          const isWinner = winnerKey === c.key;
          const sb = r.scoreBreakdown || {};
          const score = r.score ?? sb.overall;
          const mp = r.moveProbability || {};
          const sample = mp.sampleSize ?? r.historicalSampleSize;
          const lowN = sample != null && sample < 15;
          const why = [
            ...(r.bullishFactors || []).slice(0, 2),
            r.setupType ? `Setup ${r.setupType}` : null,
            rr != null ? `R:R 1:${rr.toFixed(2)}` : null,
          ].filter(Boolean).slice(0, 3);
          const risks = [
            ...(r.riskFactors || []).slice(0, 2),
            rrFlag ? `R:R below ${MIN_RR}` : null,
            lowN ? `Low sample n=${sample}` : null,
          ].filter(Boolean).slice(0, 3);
          const tp = r.tradePlan || {};
          return `
            <div class="card" style="padding:12px; border-top:3px solid ${meta.color}; ${isWinner ? 'box-shadow:0 0 0 1px rgba(52,211,153,.35);' : ''}">
              <div style="display:flex; justify-content:space-between; gap:6px; flex-wrap:wrap;">
                <div style="font-weight:600;">${meta.icon || ''} ${meta.label}</div>
                ${isWinner ? '<span class="verdict-badge bullish" style="margin:0;">🏆 Overall winner</span>' : ''}
                ${rrFlag ? '<span class="muted small" style="color:var(--amber);">R:R flag</span>' : ''}
              </div>
              <div style="margin-top:6px;">
                <b class="wp-symbol-link" style="cursor:pointer; font-size:1.05rem;">${r.symbol}</b>${fundShBadge(r.fundamentals)}
                <span class="muted"> ₹${Number(r.price).toFixed(2)}</span>
                <span class="golden-action ${actionCls(act)}" style="margin-left:6px;">${act}</span>
              </div>
              <div class="muted small" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:8px;">
                <span>Score <b>${score != null ? Number(score).toFixed(0) : '—'}</b></span>
                <span>Quality <b>${tq}</b></span>
                <span>Conf <b>${conf}</b>${lowN ? ' ⚠' : ''}</span>
              </div>
              <div class="muted small" style="margin-top:4px;">
                Entry ${tp.entryLow != null ? `₹${tp.entryLow}–₹${tp.entryHigh}` : (tp.entry ?? '—')}
                · SL ₹${tp.stopLoss ?? '—'}
                · Tgt ₹${tp.target ?? '—'}
                · R:R ${rr != null ? '1:' + rr.toFixed(2) : '—'}
              </div>
              ${pos ? `<div class="muted small">Capital ₹${pos.capital} · Risk ₹${pos.riskInr} · Qty ~${pos.qty}</div>` : ''}
              ${net ? `<div class="muted small">Gross ~₹${net.gross} · <b>Net after charges ~₹${net.net}</b> (est. ${ROUND_TRIP_CHG_PCT}% RT)</div>` : ''}
              <div class="muted small" style="margin-top:4px;">
                Hist:
                ${mp.probabilityUp5PctPlus != null ? `up5% ${mp.probabilityUp5PctPlus}%` : ''}
                ${mp.probabilityDown2PctPlus != null ? ` · down2% ${mp.probabilityDown2PctPlus}%` : ''}
                ${sample != null ? ` · n=${sample}${lowN ? ' (low)' : ''}` : ' · n=—'}
                ${mp.horizon || mp.timeframe ? ` · ${mp.horizon || mp.timeframe}` : ''}
              </div>
              <div class="muted small" style="margin-top:6px;"><b>Why:</b> ${why.join(' · ') || '—'}</div>
              <div class="muted small"><b>Risks:</b> ${risks.join(' · ') || '—'}</div>
              ${typeof scoreBreakdownHtml === 'function' && sb.overall != null ? scoreBreakdownHtml(sb) : ''}
              ${typeof quickLogWidget === 'function' ? quickLogWidget(r, c.key === 'short_term' || c.key === 'long_term' ? c.key : 'short_term') : ''}
            </div>`;
        }).join('')}
      </div>
      ${!winnerKey ? `<div class="muted small" style="margin-top:8px; color:var(--amber);">No Overall Winner — no category cleared R:R ≥ ${MIN_RR} with adequate confidence.</div>` : ''}
    `;
    box.querySelectorAll('.wp-symbol-link').forEach((el) => el.addEventListener('click', () => loadSymbol(el.textContent.trim())));
    document.getElementById('bestOfTodayScanBtn')?.addEventListener('click', loadBestOfToday);
  } catch (err) {
    box.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
}


// Renders the transparent 0-100 breakdown (see computeScoreBreakdown in
// server/stockAnalysisEngine.js) as "Score 82/100" plus a labeled bar per
// component - so *why* a pick ranked where it did is always answerable by
// glancing at the card, not just trusting a single opaque number.
const SCORE_COMPONENT_LABELS = {
  technical: 'Technical', riskReward: 'R:R', momentum: 'Momentum',
  volume: 'Volume', sectorAlignment: 'Sector', marketAlignment: 'Market',
  historical: 'Historical', fundamentals: 'Fundamentals',
};
function scoreBreakdownHtml(b) {
  if (b.error) return '';
  const overallCls = b.overall >= 65 ? 'up' : (b.overall < 40 ? 'down' : '');
  return `
    <div class="score-breakdown">
      <div class="score-breakdown-total">Score <span class="change ${overallCls}" style="display:inline; font-size:15px; font-weight:800;">${b.overall}/100</span></div>
      <div class="score-breakdown-rows">
        ${Object.entries(SCORE_COMPONENT_LABELS).map(([key, label]) => {
          const val = b.components[key];
          if (val == null) return '';
          const barCls = val >= 65 ? 'good' : (val < 40 ? 'bad' : 'mid');
          return `
            <div class="score-row">
              <span class="score-row-label">${label}</span>
              <span class="score-row-bar"><span class="score-row-fill ${barCls}" style="width:${val}%;"></span></span>
              <span class="score-row-val">${val}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ---------- cross-index Golden Opportunity scanner ----------
// Unlike renderGoldenSetups (scoped to whichever index tab is currently
// open), this scans Nifty50 + Midcap + Smallcap together and grades what
// it finds into 4 tiers (💎🥇🥈🥉 - see classifyOpportunityTier). Shown at
// the top of the Analysis view regardless of which index tab is selected.
async function loadGoldenOpportunities() {
  const box = document.getElementById('goldenOpportunityCard');
  if (!box) return;
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="font-weight:700; color:var(--amber);">🎯 Golden Opportunity Scanner</div>
          <div class="muted small">Diamond → Gold → Silver → Bronze. Actionable ranks — not profit guarantee.</div>
        </div>
        <button id="goldenOppScanBtn" class="small ghost-btn">🔍 Rescan</button>
      </div>
      <div id="goldenOppMeta" class="muted small" style="margin-top:8px;"></div>
      <div id="goldenOppResult" style="margin-top:10px;"><span class="spin"></span> <span class="muted small">Scanning…</span></div>
      <div id="goldenRemovedBox"></div>
    `;
    document.getElementById('goldenOppScanBtn')?.addEventListener('click', loadGoldenOpportunities);
  }
  const resultBox = document.getElementById('goldenOppResult');
  const metaBox = document.getElementById('goldenOppMeta');
  if (resultBox) resultBox.innerHTML = '<span class="spin"></span> <span class="muted small">Scanning all indices…</span>';
  loadGoldenRemovedList();
  try {
    const data = await api('/stocks/golden-opportunities');
    if (data.marketClosed) {
      if (resultBox) {
        resultBox.innerHTML = `<div class="market-closed-banner">⏸ Golden scanner paused — ${data.skipReason || 'market closed'}. Live ranks only 9:15–15:30 IST on trading days.</div>`;
      }
      if (metaBox) metaBox.textContent = data.message || '';
      return;
    }
    const { tiers, scannedCount, scannedAt, locked, lockNote } = data;
    scheduleGoldenAutoRefresh();

    const tierOrder = ['diamond', 'gold', 'silver', 'bronze'];
    const all = [];
    tierOrder.forEach((t) => (tiers[t] || []).forEach((r) => all.push({ ...r, _tier: t })));

    // Best opportunity: prefer higher tier then score / R:R (display only)
    const tierRank = { diamond: 4, gold: 3, silver: 2, bronze: 1 };
    const best = all.slice().sort((a, b) => {
      const tr = (tierRank[b._tier] || 0) - (tierRank[a._tier] || 0);
      if (tr) return tr;
      return (b.score || 0) - (a.score || 0);
    })[0] || null;

    function goldenAction(r, tier) {
      if (tier === 'bronze') {
        if ((r.volSpike || 0) < 1.2) return 'WAIT';
        return 'WATCH';
      }
      if (tier === 'diamond' || tier === 'gold') {
        if ((r.score || 0) >= 70 && (r.tradePlan?.riskRewardRatio || 0) >= 2.5) return 'BUY CANDIDATE';
        return 'WATCH';
      }
      if ((r.score || 0) < 50) return 'WAIT';
      return 'WATCH';
    }
    function actionCls(a) {
      if (a === 'BUY CANDIDATE') return 'buy';
      if (a === 'AVOID') return 'avoid';
      if (a === 'WAIT') return 'wait';
      return 'watch';
    }
    function potentialPct(r) {
      const px = r.price;
      const tgt = r.tradePlan?.target;
      if (px && tgt) return (((tgt - px) / px) * 100).toFixed(1);
      return null;
    }
    function whyRank(r) {
      const sb = r.scoreBreakdown || {};
      const parts = [];
      if (sb.technical != null) parts.push(`Tech ${Number(sb.technical).toFixed(0)}`);
      if (sb.momentum != null) parts.push(`Mom ${Number(sb.momentum).toFixed(0)}`);
      if (sb.volume != null) parts.push(`Vol ${Number(sb.volume).toFixed(0)}`);
      if (sb.market != null) parts.push(`Mkt ${Number(sb.market).toFixed(0)}`);
      if (r.tradePlan?.riskRewardRatio != null) parts.push(`R:R 1:${Number(r.tradePlan.riskRewardRatio).toFixed(2)}`);
      return parts.slice(0, 5);
    }

    // Track record soft fetch (optional, non-blocking shape)
    let hitNote = 'Historical hit rate: open Track Record for full sample. Small samples = low confidence.';
    try {
      // use already-loaded if any global; skip heavy call
    } catch (_) {}

    const marketLive = isIndianMarketHours() ? 'Live market hours' : 'Market closed / off-hours';
    const nextRefresh = isIndianMarketHours() ? 'Next auto refresh ~25 min (if still in session)' : 'Auto refresh paused off-hours';
    if (metaBox) {
      metaBox.innerHTML = `${marketLive} · Scanned ${scannedCount || '—'} · Updated ${scannedAt ? new Date(scannedAt).toLocaleString('en-IN') : '—'} · ${nextRefresh}${locked ? ` · <b>Locked</b>` : ''}<div>${lockNote || ''}</div><div>${hitNote}</div>`;
    }

    let bestHtml = '';
    if (best) {
      const act = goldenAction(best, best._tier);
      const pot = potentialPct(best);
      const tp = best.tradePlan || {};
      const reasons = [
        best.whyThisTier,
        ...(best.bullishFactors || []).slice(0, 2),
      ].filter(Boolean).slice(0, 3);
      bestHtml = `
        <div class="golden-best">
          <div style="font-weight:700;">🏆 Best Opportunity Now · ${TIER_META[best._tier]?.icon || ''} ${best._tier.toUpperCase()}</div>
          <div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
            <b style="font-size:1.15rem;">${best.symbol}</b>
            <span class="muted">₹${Number(best.price).toFixed(2)}</span>
            <span class="golden-action ${actionCls(act)}">${act}</span>
            <span class="muted small">Score ${best.score != null ? Number(best.score).toFixed(1) : '—'}${pot != null ? ` · Potential ~${pot}%` : ''}</span>
          </div>
          <div class="muted small" style="margin-top:6px;">
            Entry ${tp.entryLow != null ? `₹${tp.entryLow}–₹${tp.entryHigh}` : (tp.entry || '—')}
            · Trigger ${tp.trigger || '—'}
            · Target ₹${tp.target ?? '—'}
            · SL ₹${tp.stopLoss ?? '—'}
            · R:R ${tp.riskRewardRatio != null ? '1:' + Number(tp.riskRewardRatio).toFixed(2) : '—'}
          </div>
          <div class="muted small">Why: ${reasons.join(' · ') || whyRank(best).join(' · ') || '—'}</div>
          ${fundShBadge(best.fundamentals)}
          <button type="button" class="ghost-btn small" style="margin-top:8px;" data-g-open="${best.symbol}">View Full Analysis</button>
        </div>`;
    } else {
      bestHtml = `<div class="golden-best muted small">Abhi koi tier clear nahi — NO forced pick.</div>`;
    }

    // Tier tabs
    window._goldenTiersCache = tiers;
    window._goldenActiveTierTab = window._goldenActiveTierTab || 'diamond';
    if (!(tiers[window._goldenActiveTierTab] || []).length) {
      window._goldenActiveTierTab = tierOrder.find((t) => (tiers[t] || []).length) || 'diamond';
    }

    function renderTierList(active) {
      const list = tiers[active] || [];
      const bronzeNote = active === 'bronze'
        ? `<div class="muted small" style="margin:6px 0; color:var(--amber);">Bronze = early / weaker setup — equal strength BUY mat samjho. Confirm volume + plan pehle.</div>`
        : '';
      if (!list.length) {
        return bronzeNote + `<div class="muted small">Is tier me abhi koi name nahi.</div>`;
      }
      return bronzeNote + list.map((r) => {
        const act = goldenAction(r, active);
        const pot = potentialPct(r);
        const tp = r.tradePlan || {};
        const factors = whyRank(r);
        const down = r.whyThisTier || '';
        return `
          <div class="g-block" data-symbol="${r.symbol}">
            <div class="golden-row-compact">
              <div>
                <b>${r.symbol}</b>
                <span class="golden-action ${actionCls(act)}">${act}</span>
                <div class="muted small">${r.indexLabel || ''} · ₹${Number(r.price).toFixed(2)}${pot != null ? ` · ~${pot}% upside to tgt` : ''}</div>
                ${fundShBadge(r.fundamentals)}
              </div>
              <div class="muted small" style="text-align:right;">Score ${r.score != null ? Number(r.score).toFixed(0) : '—'}<br/>R:R ${tp.riskRewardRatio != null ? '1:' + Number(tp.riskRewardRatio).toFixed(2) : '—'}</div>
              <button type="button" class="ghost-btn small g-exp" data-sym="${r.symbol}">Details</button>
            </div>
            <div class="golden-detail" id="g-d-${r.symbol}-${active}">
              <div><b>Why this rank?</b> ${factors.join(' · ') || '—'}</div>
              ${down ? `<div style="margin-top:4px;"><b>Tier note:</b> ${down}</div>` : ''}
              ${(r.bullishFactors || []).length ? `<div style="margin-top:4px; color:var(--green);">✓ ${(r.bullishFactors || []).slice(0, 4).join(' · ')}</div>` : ''}
              ${(r.riskFactors || []).length ? `<div style="margin-top:4px; color:var(--red);">⚠ ${(r.riskFactors || []).slice(0, 3).join(' · ')}</div>` : ''}
              <div class="muted small" style="margin-top:4px;">Entry ${tp.entryLow != null ? `₹${tp.entryLow}–₹${tp.entryHigh}` : '—'} · SL ₹${tp.stopLoss ?? '—'} · Tgt ₹${tp.target ?? '—'} · Invalidation: ${r.invalidation || '—'}</div>
              <button type="button" class="ghost-btn small g-open" data-symbol="${r.symbol}" style="margin-top:8px;">View Full Analysis</button>
              ${typeof quickLogWidget === 'function' ? quickLogWidget(r) : ''}
            </div>
          </div>`;
      }).join('');
    }

    const tabs = tierOrder.map((t) => {
      const n = (tiers[t] || []).length;
      const meta = TIER_META[t] || {};
      const active = window._goldenActiveTierTab === t ? 'active' : '';
      return `<button type="button" class="golden-tier-tab ${active}" data-tier="${t}">${meta.icon || ''} ${meta.label || t} (${n})</button>`;
    }).join('');

    resultBox.innerHTML = `
      ${bestHtml}
      <div class="golden-tier-tabs">${tabs}</div>
      <div id="goldenTierList">${renderTierList(window._goldenActiveTierTab)}</div>
      <div class="muted small" style="margin-top:8px;">${scannedCount || 0} stocks scanned · ${lockNote || ''}</div>
    `;

    resultBox.querySelectorAll('.golden-tier-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        window._goldenActiveTierTab = btn.dataset.tier;
        resultBox.querySelectorAll('.golden-tier-tab').forEach((b) => b.classList.toggle('active', b.dataset.tier === window._goldenActiveTierTab));
        const host = document.getElementById('goldenTierList');
        if (host) host.innerHTML = renderTierList(window._goldenActiveTierTab);
        wireGoldenRows(resultBox);
      });
    });
    wireGoldenRows(resultBox);
  } catch (err) {
    if (resultBox) resultBox.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
}

function wireGoldenRows(root) {
  root.querySelectorAll('.g-exp').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tier = window._goldenActiveTierTab;
      const el = document.getElementById(`g-d-${btn.dataset.sym}-${tier}`);
      if (el) el.classList.toggle('open');
    });
  });
  root.querySelectorAll('.g-open, [data-g-open]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sym = btn.dataset.symbol || btn.getAttribute('data-g-open');
      if (sym) loadSymbol(sym, { fromView: 'golden' });
    });
  });
  root.querySelectorAll('.golden-row-compact').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const sym = row.parentElement?.dataset?.symbol;
      const el = sym && document.getElementById(`g-d-${sym}-${window._goldenActiveTierTab}`);
      if (el) el.classList.toggle('open');
    });
  });
}

async function loadGoldenRemovedList() {
  const box = document.getElementById('goldenRemovedBox');
  if (!box) return;
  box.innerHTML = '<div class="muted small" style="margin-top:10px;"><span class="spin"></span> Loading removed…</div>';
  try {
    let items = [];
    try {
      const data = await api('/recommendations/still-tracking?period=1M');
      items = data.items || [];
    } catch (_) {}
    if (!items.length) {
      const { removals } = await api('/recommendations/removed?period=1M');
      items = (removals || [])
        .filter((r) => r.category?.startsWith('golden_') || ['short_term', 'long_term', 'momentum', 'reversal'].includes(r.category))
        .map((r) => ({
          ...r,
          action: 'HOLD',
          actionLabel: 'HOLD (recheck)',
          notes: [r.reason || 'Removed from list'],
          currentPrice: r.priceAtRemoval ?? null,
          changePctSinceRecommended: r.changePctSinceRecommended ?? null,
        }));
    }
    if (!items.length) { box.innerHTML = ''; return; }

    const ymd = (d) => {
      const x = typeof d === 'string' ? new Date(d.includes('T') ? d : d + 'T12:00:00') : d;
      return x.toISOString().slice(0, 10);
    };
    const today = new Date();
    const todayStr = ymd(today);
    const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    const yestStr = ymd(yest);
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);

    const buckets = { today: [], yesterday: [], week: [], all: items.slice() };
    for (const r of items) {
      const rd = r.removedDate || (r.removedAt ? ymd(r.removedAt) : '');
      const rdDate = rd ? new Date(rd + 'T12:00:00') : null;
      if (rd === todayStr) buckets.today.push(r);
      else if (rd === yestStr) buckets.yesterday.push(r);
      else if (rdDate && rdDate >= weekAgo) buckets.week.push(r);
    }

    window._removedBucket = window._removedBucket || 'today';
    if (!(buckets[window._removedBucket] || []).length && window._removedBucket === 'today') {
      // stay on today empty ok
    }

    const renderItem = (r) => {
      const cat = r.category || '';
      const tierName = cat.startsWith('golden_') ? cat.replace('golden_', '') : null;
      const catLabel = tierName ? (TIER_META[tierName]?.label || tierName) : (cat || 'pick');
      const label = r.actionLabel || r.action || 'HOLD';
      const badgeCls = /exit/i.test(label) ? 'bearish' : (/trail|hold/i.test(label) ? 'neutral' : 'bullish');
      const chg = r.changePctSinceRecommended;
      const why = (r.notes || []).slice(0, 2).join(' · ') || r.reason || '—';
      return `
        <div style="padding:8px 0; border-bottom:1px solid var(--border-soft); font-size:13px;">
          <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <b class="wp-symbol-link" data-symbol="${r.symbol}" style="cursor:pointer;">${r.symbol}</b>
              <span class="muted small"> · ${catLabel} · ${r.removedDate || ''}</span>
              ${chg != null ? `<span class="change ${chg >= 0 ? 'up' : 'down'}" style="display:inline; margin-left:4px;">${chg >= 0 ? '+' : ''}${Number(chg).toFixed(1)}%</span>` : ''}
            </div>
            <span class="verdict-badge ${badgeCls}" style="margin:0; font-size:11px;">${label}</span>
          </div>
          <div class="muted small" style="margin-top:2px;">${why}</div>
        </div>`;
    };

    const tabs = [
      ['today', 'Today', buckets.today.length],
      ['yesterday', 'Yesterday', buckets.yesterday.length],
      ['week', '7 day', buckets.week.length],
      ['all', 'All', buckets.all.length],
    ];

    window._removedPage = window._removedPage || 0;
    window._removedExpanded = window._removedExpanded || false;
    const PAGE = 50;
    const PREVIEW = 5;

    function paint() {
      const key = window._removedBucket || 'today';
      const full = buckets[key] || [];
      // newest first if dates present
      const sorted = full.slice().sort((a, b) => String(b.removedDate || b.removedAt || '').localeCompare(String(a.removedDate || a.removedAt || '')));
      let list = sorted;
      let pager = '';
      if (key === 'today' && !window._removedExpanded) {
        list = sorted.slice(0, PREVIEW);
        if (sorted.length > PREVIEW) {
          pager = `<button type="button" class="ghost-btn small" id="rmExpandBtn" style="margin-top:8px;">▼ Aur ${sorted.length - PREVIEW} dikhao (latest ${PREVIEW} pehle)</button>`;
        }
      } else {
        const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
        if (window._removedPage >= pages) window._removedPage = 0;
        const start = window._removedPage * PAGE;
        list = sorted.slice(start, start + PAGE);
        if (sorted.length > PAGE) {
          pager = `<div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
            <button type="button" class="ghost-btn small" id="rmPrev" ${window._removedPage <= 0 ? 'disabled' : ''}>← Prev</button>
            <span class="muted small">Page ${window._removedPage + 1} / ${pages} · ${sorted.length} total</span>
            <button type="button" class="ghost-btn small" id="rmNext" ${window._removedPage >= pages - 1 ? 'disabled' : ''}>Next →</button>
          </div>`;
        }
      }
      box.innerHTML = `
        <div class="card" style="margin-top:12px; padding:12px;">
          <div style="font-weight:700;">📌 List se hatne ke baad — HOLD ya EXIT</div>
          <div class="muted small">Sirf pehle liye picks. Today: latest ${PREVIEW} default · baaki arrow se. All/Yesterday: ${PAGE}/page.</div>
          <div class="golden-tier-tabs" style="margin-top:8px;">
            ${tabs.map(([k, lab, n]) => `<button type="button" class="golden-tier-tab ${key === k ? 'active' : ''}" data-rm-tab="${k}">${lab} (${n})</button>`).join('')}
          </div>
          <div id="removedTabBody">
            ${list.length ? list.map(renderItem).join('') : '<div class="muted small" style="margin-top:8px;">Is period me koi removal nahi.</div>'}
          </div>
          ${pager}
        </div>`;
      box.querySelectorAll('[data-rm-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window._removedBucket = btn.dataset.rmTab;
          window._removedPage = 0;
          window._removedExpanded = false;
          paint();
        });
      });
      document.getElementById('rmExpandBtn')?.addEventListener('click', () => {
        window._removedExpanded = true;
        paint();
      });
      document.getElementById('rmPrev')?.addEventListener('click', () => {
        window._removedPage = Math.max(0, (window._removedPage || 0) - 1);
        paint();
      });
      document.getElementById('rmNext')?.addEventListener('click', () => {
        window._removedPage = (window._removedPage || 0) + 1;
        paint();
      });
      box.querySelectorAll('.wp-symbol-link').forEach((el) => {
        el.addEventListener('click', () => loadSymbol(el.dataset.symbol || el.textContent.trim(), { fromView: 'golden' }));
      });
    }
    paint();
  } catch (err) {
    box.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
}


async function loadMarkets() {
  const indianBox = document.getElementById('indianIndicesBox');
  const globalBox = document.getElementById('globalIndicesBox');
  const commoditiesBox = document.getElementById('commoditiesBox');
  if (!indianBox) return;
  indianBox.innerHTML = '<p class="muted small"><span class="spin"></span> Loading...</p>';
  globalBox.innerHTML = '';
  commoditiesBox.innerHTML = '';
  try {
    const [{ indian, global }, { commodities }] = await Promise.all([
      api('/market/indices'),
      api('/market/commodities'),
    ]);
    indianBox.innerHTML = indian.length ? indian.map(marketCardHtml).join('') : '<p class="muted small">No Indian index data available right now.</p>';
    globalBox.innerHTML = global.length ? global.map(marketCardHtml).join('') : '<p class="muted small">No global index data available right now.</p>';
    commoditiesBox.innerHTML = commodities.length ? commodities.map(marketCardHtml).join('') : '<p class="muted small">No commodity data available right now.</p>';
  } catch (err) {
    indianBox.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

document.getElementById('marketsRefreshBtn')?.addEventListener('click', loadMarkets);
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'markets') btn.addEventListener('click', () => { loadMarkets(); loadNiftyDeepDive(); });
  if (btn.dataset.view === 'institutional') btn.addEventListener('click', () => { loadInstitutionalDashboard(); loadSectorFlow(); loadBulkDeals(); });
  if (btn.dataset.view === 'zero-loss') btn.addEventListener('click', () => {});
  if (btn.dataset.view === 'tomorrow-conviction') btn.addEventListener('click', () => loadTomorrowConviction());
  if (btn.dataset.view === 'sector-ancillary') btn.addEventListener('click', () => loadSectorAncillary());
});

// ---------- Admin Panel ----------
const PERMISSION_LABELS = {
  dashboard: '📊 Analysis (Dashboard)', watchlist: '⭐ Watchlist', alerts: '🔔 Alerts',
  journal: '📓 Trade Journal', screener: '🔍 Bulk Screener', import: '📥 Import Data',
  institutional: '🏦 Institutional Money', trackrecord: '📈 Track Record',
  weekendpicks: '🔬 Weekend Picks', modellearning: '🧠 Model Learning',
  markets: '🌐 Markets', settings: '⚙️ Settings',
};

async function loadAdminUsers() {
  const box = document.getElementById('adminUsersBox');
  box.innerHTML = '<p class="muted small">Loading...</p>';
  try {
    const { users, permissionKeys } = await api('/admin/users');
    box.innerHTML = users.map((u) => {
      const isSelf = u.id === CURRENT_USER.id;
      const statusBadge = u.status === 'approved' ? '<span class="verdict-badge bullish">Approved</span>'
        : u.status === 'pending' ? '<span class="verdict-badge neutral">Pending</span>'
        : '<span class="verdict-badge bearish">Rejected</span>';
      return `
        <div class="card" style="padding:14px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
            <div>
              <div style="font-weight:700;">${u.name} ${u.role === 'admin' ? '<span class="tag" style="margin-left:4px;">admin</span>' : ''} ${isSelf ? '<span class="muted small">(you)</span>' : ''}</div>
              <div class="muted small">${u.email} · joined ${new Date(u.created_at).toLocaleDateString('en-IN')}</div>
            </div>
            ${statusBadge}
          </div>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            ${u.status !== 'approved' ? `<button class="small approve-btn" data-id="${u.id}">✓ Approve</button>` : ''}
            ${u.status !== 'rejected' && !isSelf ? `<button class="small reject-btn" data-id="${u.id}">✕ Reject</button>` : ''}
            ${u.role !== 'admin' ? `<button class="small make-admin-btn" data-id="${u.id}">🛡️ Make admin</button>` : (!isSelf ? `<button class="small remove-admin-btn" data-id="${u.id}">Remove admin</button>` : '')}
          </div>
          ${u.role === 'admin' ? '<div class="muted small" style="margin-top:8px;">Admins always have full access - permissions below don\'t apply to them.</div>' : `
            <div style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
              <div class="muted small" style="margin-bottom:6px; text-transform:uppercase; letter-spacing:.03em;">Tab access</div>
              <div style="display:flex; flex-wrap:wrap; gap:6px;">
                ${permissionKeys.map((key) => `
                  <label class="perm-toggle ${u.permissions[key] ? 'on' : ''}">
                    <input type="checkbox" class="perm-checkbox" data-id="${u.id}" data-key="${key}" ${u.permissions[key] ? 'checked' : ''} style="display:none;" />
                    ${PERMISSION_LABELS[key] || key}
                  </label>
                `).join('')}
              </div>
            </div>
          `}
        </div>
      `;
    }).join('');

    box.querySelectorAll('.approve-btn').forEach((b) => b.addEventListener('click', () => setUserStatus(b.dataset.id, 'approved')));
    box.querySelectorAll('.reject-btn').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Reject this user? They will lose access immediately.')) setUserStatus(b.dataset.id, 'rejected');
    }));
    box.querySelectorAll('.make-admin-btn').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Make this user an admin? They will get full access to everything, including this Admin Panel.')) setUserRole(b.dataset.id, 'admin');
    }));
    box.querySelectorAll('.remove-admin-btn').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Remove admin rights from this user?')) setUserRole(b.dataset.id, 'user');
    }));
    box.querySelectorAll('.perm-checkbox').forEach((cb) => cb.addEventListener('change', async (e) => {
      const { id, key } = e.target.dataset;
      e.target.closest('.perm-toggle').classList.toggle('on', e.target.checked);
      try {
        await api(`/admin/users/${id}/permissions`, { method: 'POST', body: JSON.stringify({ [key]: e.target.checked }) });
      } catch (err) {
        toast(err.message);
        e.target.checked = !e.target.checked; // revert on failure
        e.target.closest('.perm-toggle').classList.toggle('on', e.target.checked);
      }
    }));
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

async function setUserStatus(id, status) {
  try {
    await api(`/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    toast(`User ${status}`);
    loadAdminUsers();
  } catch (err) { toast(err.message); }
}
async function setUserRole(id, role) {
  try {
    await api(`/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    toast(role === 'admin' ? 'Now an admin' : 'Admin rights removed');
    loadAdminUsers();
  } catch (err) { toast(err.message); }
}

document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'admin') btn.addEventListener('click', loadAdminUsers);
});


function greetingForIST() {
  try {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good night';
  } catch (_) {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }
}

function renderDashboardHero(user) {
  const greetEl = document.getElementById('dashGreet');
  const subEl = document.getElementById('dashGreetSub');
  const av = document.getElementById('dashAvatar');
  if (!greetEl) return;
  const name = (user?.name || CURRENT_USER?.name || 'trader').trim();
  const first = name.split(/\s+/)[0] || 'trader';
  greetEl.textContent = `${greetingForIST()}, ${first}!`;
  if (subEl) {
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' }).format(new Date());
    subEl.textContent = `${day} · StockLens desk ready`;
  }
  if (av) {
    av.textContent = (first[0] || 'S').toUpperCase();
  }
}

function svgRing(pct, color) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 28;
  const c = 2 * Math.PI * r;
  const off = c - (p / 100) * c;
  return `<svg width="72" height="72" viewBox="0 0 72 72">
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--border)" stroke-width="7"/>
    <circle cx="36" cy="36" r="${r}" fill="none" stroke="${color}" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 36 36)" style="transition: stroke-dashoffset .6s ease"/>
    <text x="36" y="40" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)">${Math.round(p)}%</text>
  </svg>`;
}


let _lastMarketPulseHtml = null;
async function loadMarketPulse() {
  const box = document.getElementById('marketPulseCard');
  if (!box) return;
  // Keep previous visual while refreshing so card doesn't "vanish"
  if (_lastMarketPulseHtml && box.innerHTML.trim() === '') {
    box.innerHTML = _lastMarketPulseHtml;
  }
  try { renderDashboardHero(CURRENT_USER); } catch(_) {}

  const closedNote = (typeof isIndianMarketHours === 'function' && !isIndianMarketHours())
    ? '<span class="muted small">Market closed — last available breadth/sectors.</span>'
    : '';

  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:baseline; margin-bottom:8px;">
      <div style="font-weight:700; font-size:1.05rem;">Overall market</div>
      ${closedNote}
    </div>
    <div class="muted small" style="margin-bottom:12px;">Tracked universe (Nifty50 + Mid + Small) — price breadth, not institutional flow.</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;" id="marketPulseGrid">
      <div>
        <div class="muted small" style="margin-bottom:8px; font-weight:600;">Sector rotation</div>
        <div id="sectorRotationBox"><span class="spin"></span></div>
      </div>
      <div>
        <div class="muted small" style="margin-bottom:8px; font-weight:600;">Advance ratio</div>
        <div id="marketBreadthBox"><span class="spin"></span></div>
      </div>
    </div>
  `;

  const savePulse = () => { try { _lastMarketPulseHtml = box.innerHTML; } catch(_) {} };
  api('/market/sectors').then(({ sectors, note }) => {
    const el = document.getElementById('sectorRotationBox');
    if (!el) return;
    if (note) { el.innerHTML = `<div class="muted small">${note}</div>`; return; }
    if (!sectors.length) { el.innerHTML = '<div class="muted small">No sector data available yet.</div>'; return; }
    const statusIcon = { improving: '📈', weakening: '📉', neutral: '➖' };
    el.innerHTML = `
      <table class="indicator-table" style="width:100%;">
        ${sectors.slice(0, 8).map((s) => `
          <tr>
            <td>${statusIcon[s.status] || ''} ${s.sector} <span class="muted" style="font-size:10px;">(${s.stockCount})</span></td>
            <td class="change ${s.rs1M >= 0 ? 'up' : 'down'}">${s.rs1M != null ? (s.rs1M >= 0 ? '+' : '') + s.rs1M + '%' : '-'}</td>
          </tr>
        `).join('')}
      </table>
      <div class="muted small" style="margin-top:4px;">RS = sector avg 1M return minus Nifty — tracked universe only.</div>
    `;
    savePulse();
  }).catch((err) => {
    const el = document.getElementById('sectorRotationBox');
    if (el) el.innerHTML = `<div class="muted small">${err.message}</div>`;
    savePulse();
  });

  api('/market/breadth').then(({ breadth }) => {
    const el = document.getElementById('marketBreadthBox');
    if (!el) return;
    if (!breadth) { el.innerHTML = '<div class="muted small">No breadth data.</div>'; return; }
    const adv = breadth.advancing ?? breadth.advances ?? breadth.advanceCount ?? 0;
    const dec = breadth.declining ?? breadth.declines ?? breadth.declineCount ?? 0;
    const unch = breadth.unchanged ?? 0;
    const total = breadth.total ?? ((adv + dec + unch) || 1);
    const advPct = breadth.advancePct != null ? breadth.advancePct : (breadth.advPct != null ? breadth.advPct : (100 * adv / total));
    const decPct = breadth.declinePct != null ? breadth.declinePct : (100 * dec / total);
    const by = breadth.byIndex || breadth.buckets || {};
    const rings = [];
    const colors = { nifty50: '#f59e0b', midcap: '#f59e0b', smallcap: '#ef4444', large: '#f59e0b', mid: '#f59e0b', small: '#ef4444' };
    const labels = { nifty50: 'Large', midcap: 'Mid', smallcap: 'Small', large: 'Large', mid: 'Mid', small: 'Small' };
    for (const [k, v] of Object.entries(by)) {
      const pct = v.advancePct != null ? v.advancePct : (v.advances != null && v.total ? (100 * v.advances / v.total) : null);
      if (pct == null) continue;
      rings.push(`<div class="breadth-ring">${svgRing(pct, colors[k] || '#6366f1')}<div class="br-label">${labels[k] || k}</div></div>`);
    }
    if (!rings.length) {
      rings.push(`<div class="breadth-ring">${svgRing(advPct, advPct >= 45 ? '#10b981' : '#f59e0b')}<div class="br-label">Universe</div></div>`);
    }
    el.innerHTML = `
      <div class="breadth-stats-grid">
        <div class="breadth-stat"><div class="k">Advances</div><div class="v" style="color:var(--green)">${adv}</div></div>
        <div class="breadth-stat"><div class="k">Declines</div><div class="v" style="color:var(--red)">${dec}</div></div>
        <div class="breadth-stat"><div class="k">Unchanged</div><div class="v">${unch}</div></div>
        <div class="breadth-stat"><div class="k">Advance %</div><div class="v">${Number(advPct).toFixed(0)}%</div></div>
      </div>
      <div class="breadth-rings">${rings.join('')}</div>
    `;
    savePulse();
  }).catch((err) => {
    const el = document.getElementById('marketBreadthBox');
    if (el) el.innerHTML = `<div class="muted small">${err.message}</div>`;
    savePulse();
  });
}

// ---------- Golden/Swing setup card details (score, "why this tier",
// entry zone vs trigger, expected hold, honestly-labeled historical rate,
// volume interpretation, %upside/%downside) - all built from data already
// on `r`, no extra network calls. ----------
function volumeInterpretation(vs) {
  if (vs == null) return { label: '-', note: '' };
  if (vs >= 2) return { label: `${vs.toFixed(1)}× average`, note: 'Strong confirmation' };
  if (vs >= 1.5) return { label: `${vs.toFixed(1)}× average`, note: 'Good confirmation' };
  if (vs >= 1) return { label: `${vs.toFixed(1)}× average`, note: 'Adequate confirmation' };
  if (vs >= 0.7) return { label: `${vs.toFixed(1)}× average`, note: 'Weak confirmation' };
  return { label: `${vs.toFixed(1)}× average`, note: 'Very weak — low conviction' };
}
function expectedHoldLabel(r) {
  const tt = r.targetTimeline;
  if (!tt || tt.status !== 'ok') return null;
  return { '7d': '~7 days', '15d': '~15 days', '30d': '~30 days', '30d_plus': '30+ days' }[tt.suggestedWindow] || null;
}
function setupTypeLabel(r) {
  if (r.setup?.type === 'reversal') return '🔄 Statistical Bounce Setup';
  if (r.setup?.type === 'momentum') return '📈 Momentum Continuation Setup';
  return '📊 Technical Setup';
}
function tierWhyReasons(r) {
  const reasons = [];
  const rr = r.tradePlan?.riskRewardRatio;
  if (rr >= 2) reasons.push(`R:R strong at 1:${rr}`);
  else if (rr >= 1.3) reasons.push(`R:R workable at 1:${rr}`);
  const vs = r.volSpike ?? r.indicators?.volSpike;
  if (vs >= 1.5) reasons.push(`Volume confirmed (${vs.toFixed(1)}× avg)`);
  const p = r.moveProbability;
  if (p?.status === 'ok' && p.probabilityUp1PctPlus >= 60) reasons.push(`Historical edge (${p.probabilityUp1PctPlus}% hit rate, n=${p.sampleSize})`);
  if (r.setup?.type === 'reversal') reasons.push('Bounce off support, not chasing a high');
  else if (r.score >= 3) reasons.push('Strong bullish technical trend');
  if (!reasons.length) reasons.push("Meets this tier's minimum bar on balance of factors");
  return reasons;
}
function entryTriggerNote(r) {
  if (!r.tradePlan || r.price == null) return '';
  const p = r.tradePlan;
  const inZone = r.price >= p.entryLow && r.price <= p.entryHigh;
  if (inZone) return 'Price is inside the entry zone right now — trigger is a confirming candle close in this range, not a blind market buy.';
  if (r.price < p.entryLow) return `Price is still above the zone (₹${(r.price - p.entryLow).toFixed(2)} to go) — wait for it to come down into range rather than chasing.`;
  return `Price already ran past the zone — wait for a pullback into ₹${p.entryLow}–₹${p.entryHigh} rather than chasing here.`;
}
function goldenCardDetailsHtml(r, tier) {
  const breakdown = computeScoreBreakdown(r, currentIndexMarketContext || currentScreenerMarketContext);
  const score5 = (breakdown.overall / 20).toFixed(1);
  const vol = volumeInterpretation(r.volSpike ?? r.indicators?.volSpike);
  const hold = expectedHoldLabel(r);
  const p = r.moveProbability;
  const upsidePct = r.tradePlan && r.price ? (((r.tradePlan.target - r.price) / r.price) * 100).toFixed(1) : null;
  const downsidePct = r.tradePlan && r.price ? (((r.price - r.tradePlan.stopLoss) / r.price) * 100).toFixed(1) : null;
  return `
    <div class="muted small" style="font-weight:600; margin-bottom:2px;">${setupTypeLabel(r)}</div>
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
      <span style="font-weight:700; font-size:14px;">${score5}<span class="muted" style="font-size:11px; font-weight:normal;">/5</span></span>
      <span class="muted small">${tier ? `— Why ${TIER_META[tier].label}?` : ''}</span>
    </div>
    ${tier ? `<ul class="factor-list" style="margin:0 0 6px;">${tierWhyReasons(r).map((why) => `<li class="bullish" style="padding:4px 8px; font-size:11.5px;">${why}</li>`).join('')}</ul>` : ''}
    ${r.tradePlan ? `
      <div class="muted small">Entry Zone: ₹${r.tradePlan.entryLow}–₹${r.tradePlan.entryHigh}</div>
      <div class="muted small" style="margin-bottom:2px;">🎯 Trigger: ${entryTriggerNote(r)}</div>
      <div class="muted small">SL ₹${r.tradePlan.stopLoss}${downsidePct ? ` (−${downsidePct}%)` : ''} · Target ₹${r.tradePlan.target}${upsidePct ? ` (+${upsidePct}%)` : ''} · R:R 1:${r.tradePlan.riskRewardRatio}</div>
    ` : ''}
    ${hold ? `<div class="muted small">⏱ Expected Hold: ${hold}</div>` : ''}
    ${p?.status === 'ok' ? `
      <div class="muted small" title="Based on similar historical setups, not guaranteed future probability.">
        📊 ${p.probabilityUp1PctPlus}% Historical Hit Rate ⓘ
      </div>
      <div class="muted small">+1% Hit: <span class="change up" style="display:inline;">${p.probabilityUp1PctPlus}%</span> · +5% Hit: <span class="change up" style="display:inline;">${p.probabilityUp5PctPlus}%</span> · -2% Downside: <span class="change down" style="display:inline;">${p.probabilityDown2PctPlus}%</span> · n=${p.sampleSize}</div>
    ` : ''}
    <div class="muted small">Volume: ${vol.label} — ${vol.note}</div>
  `;
}

function renderGoldenSetups(results, containerId) {
  const box = document.getElementById(containerId);
  const tiers = computeTieredOpportunities(results);
  const tierOrder = ['diamond', 'gold', 'silver', 'bronze'];
  const anyFound = tierOrder.some((t) => tiers[t].length);

  if (!anyFound) {
    box.innerHTML = `<div class="muted small" style="margin:14px 0; padding:10px; border:1px dashed var(--border); border-radius:8px;">🌟 No opportunity in any tier (💎🥇🥈🥉) today — even Bronze (the flexible catch-all) needs a workable R:R and price near a real buy zone. Most days show at least Bronze; a totally empty result is rare.</div>`;
    return;
  }

  box.innerHTML = `
    <div style="margin:14px 0;">
      <div class="muted small" style="margin-bottom:8px;">Graded 💎 Diamond → 🥇 Gold → 🥈 Silver → 🥉 Bronze (strictest to most flexible). Includes reversal/bounce setups, not just raw-bullish-score stocks — a hard-fallen stock turning up can rank here too.</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px;">
        ${tierOrder.filter((t) => tiers[t].length).map((tier) => {
          const meta = TIER_META[tier];
          const category = `golden_${tier}`;
          return `
            <div class="card" style="padding:12px; border-color:${meta.color};">
              <div style="font-weight:700; color:${meta.color}; margin-bottom:2px;">${meta.icon} ${meta.label}</div>
              <div class="muted small" style="margin-bottom:8px;">${meta.desc}</div>
              ${tiers[tier].map((r) => `
                <div class="golden-row" data-symbol="${r.symbol}" data-tier="${tier}" style="padding:8px 0; cursor:pointer; border-bottom:1px solid var(--border);">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span><b>${r.symbol}</b> <span class="muted" style="font-size:11px;">₹${r.price?.toFixed(2) ?? '-'}</span></span>
                  </div>
                  ${goldenCardDetailsHtml(r, tier)}
                  ${timelineBadge(r)}
                  ${dailyBreakdownToggle(r)}
                  <div class="price-history-box" data-hist-symbol="${r.symbol}" data-hist-category="${category}"></div>
                  ${quickLogWidget(r)}
                </div>
              `).join('')}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
  box.querySelectorAll('.golden-row').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.ql-wrap')) return;
    loadSymbol(el.dataset.symbol);
  }));
  tierOrder.forEach((tier) => tiers[tier].forEach((r) => loadPriceHistory(r.symbol, `golden_${tier}`)));
}

function tradePlanLine(r) {
  if (!r.tradePlan) return '';
  const p = r.tradePlan;
  return `<div class="muted small">Entry ₹${p.entryLow}–₹${p.entryHigh} · SL ₹${p.stopLoss} · Target ₹${p.target}${p.riskRewardRatio ? ` · R:R 1:${p.riskRewardRatio}` : ''}</div>`;
}

function renderSwingSetups(results, containerId, timeFilter = 'any', marketContext = null) {
  const box = document.getElementById(containerId);
  const { momentum, reversal } = computeSwingSetups(results, timeFilter, marketContext);
  if (!momentum.length && !reversal.length) {
    box.innerHTML = timeFilter !== 'any'
      ? `<div class="muted small" style="margin:14px 0; padding:10px; border:1px dashed var(--border); border-radius:8px;">No momentum/reversal setup currently matches that holding-period filter.</div>`
      : '';
    return;
  }
  const section = (list, title, icon) => `
    <div class="card" style="padding:12px;">
      <div class="muted small" style="margin-bottom:8px; text-transform:uppercase; letter-spacing:.04em;">${icon} ${title}</div>
      ${list.length ? list.map((r) => `
        <div class="swing-row" data-symbol="${r.symbol}" style="padding:8px 0; cursor:pointer; border-bottom:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span><b>${r.symbol}</b> <span class="muted" style="font-size:11px;">₹${r.price?.toFixed(2) ?? '-'}</span></span>
            <span class="verdict-badge ${verdictClass(r.verdict)}" style="padding:2px 8px; font-size:11px;">${r.verdict}</span>
          </div>
          <div class="muted small" style="margin-top:3px;">${r.setup.reason}</div>
          ${buyRangeNote(r)}
          ${goldenCardDetailsHtml(r, null)}
          ${dailyBreakdownToggle(r)}
          <div class="context-box" data-ctx-symbol="${r.symbol}" style="margin-top:4px;"><span class="muted" style="font-size:11px;">Checking news &amp; earnings date...</span></div>
          <div class="price-history-box" data-hist-symbol="${r.symbol}" data-hist-category="${r.setup.type}"></div>
          ${quickLogWidget(r)}
        </div>
      `).join('') : '<div class="muted small">Nothing qualifies right now</div>'}
    </div>
  `;
  box.innerHTML = `
    <div style="margin:14px 0;">
      <div class="muted small" style="margin-bottom:8px;">🎯 Swing-trade setups — momentum picks AND stocks that fell hard and are now bouncing near support. Not just "currently bullish".</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">
        ${section(momentum, 'Momentum (trending up)', '📈')}
        ${section(reversal, 'Reversal / Bounce (was falling, turning up)', '🔄')}
      </div>
    </div>
  `;
  box.querySelectorAll('.swing-row').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let news links open normally
      if (e.target.closest('.ql-wrap')) return;
      loadSymbol(el.dataset.symbol);
    });
  });

  // Enrich each card with news + earnings-date risk, in the background -
  // only for the handful of candidates shown here (not the whole scan).
  [...momentum, ...reversal].forEach((r) => { loadSwingContext(r.symbol); loadPriceHistory(r.symbol, r.setup.type); });
}

async function loadSwingContext(symbol) {
  try {
    const { news, events } = await api(`/stocks/${symbol}/context`);
    document.querySelectorAll(`.context-box[data-ctx-symbol="${symbol}"]`).forEach((box) => {
      let html = '';
      if (events && events.daysUntil !== null && events.daysUntil >= 0 && events.daysUntil <= 7) {
        html += `<div style="color:var(--amber); font-size:11px; margin-bottom:3px;">⚠️ Earnings expected ~${events.nextEarnings} (${events.daysUntil}d away) — expect volatility, a swing trade could gap through your stop.</div>`;
      }
      if (news && news.length) {
        html += `<div class="muted" style="font-size:11px;">📰 <a href="${news[0].link}" target="_blank" rel="noopener" style="color:inherit;">${news[0].title}</a></div>`;
      }
      box.innerHTML = html || '<span class="muted" style="font-size:11px;">No recent news or earnings date found.</span>';
    });
  } catch (err) {
    document.querySelectorAll(`.context-box[data-ctx-symbol="${symbol}"]`).forEach((box) => {
      box.innerHTML = '<span class="muted" style="font-size:11px;">Could not load news/earnings.</span>';
    });
  }
}

async function loadPriceHistory(symbol, category) {
  try {
    const data = await api(`/recommendations?symbol=${symbol}&category=${category}`);
    const rows = (data.recommendations || []).sort((a, b) => new Date(a.recommendedDate) - new Date(b.recommendedDate));
    const today = new Date().toISOString().slice(0, 10);
    const earliest = rows.find((r) => r.recommendedDate !== today);
    document.querySelectorAll(`.price-history-box[data-hist-symbol="${symbol}"][data-hist-category="${category}"]`).forEach((box) => {
      const timelineLinkHtml = `<a href="#" class="timeline-toggle" data-symbol="${symbol}" data-category="${category}" style="color:var(--accent); font-size:11px;">🕐 Show today's timeline</a>`;
      let priceLineHtml = '';
      if (earliest) {
        const latest = earliest.latestPrice ?? earliest.recommendedPrice;
        const changePct = earliest.changePct ?? 0;
        const cls = changePct >= 0 ? 'up' : 'down';
        priceLineHtml = `<div class="muted small" style="margin-top:3px;">📌 First flagged ₹${earliest.recommendedPrice.toFixed(2)} on ${earliest.recommendedDate} → <span class="change ${cls}" style="display:inline;">₹${latest.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)</span></div>`;
      }
      box.innerHTML = `${priceLineHtml}<div style="margin-top:3px;">${timelineLinkHtml}</div><div class="timeline-content" data-symbol="${symbol}" data-category="${category}"></div>`;
    });
  } catch {
    // silent - price history is a nice-to-have enrichment, not critical
  }
}

document.addEventListener('click', async (e) => {
  const link = e.target.closest('.timeline-toggle');
  if (!link) return;
  e.preventDefault();
  const { symbol, category } = link.dataset;
  const contentBox = document.querySelector(`.timeline-content[data-symbol="${symbol}"][data-category="${category}"]`);
  if (!contentBox) return;
  if (contentBox.dataset.loaded === 'true') {
    contentBox.innerHTML = '';
    contentBox.dataset.loaded = 'false';
    link.textContent = "🕐 Show today's timeline";
    return;
  }
  link.textContent = 'Loading...';
  try {
    const { snapshots } = await api(`/recommendations/intraday-history?symbol=${symbol}&category=${category}`);
    if (!snapshots.length) {
      contentBox.innerHTML = '<div class="muted small">No intraday snapshots logged yet today.</div>';
    } else {
      contentBox.innerHTML = `
        <table class="indicator-table" style="width:100%; margin-top:6px; font-size:11px;">
          <tr><td><b>Time</b></td><td><b>Price</b></td><td><b>SL</b></td><td><b>Target</b></td></tr>
          ${snapshots.map((s) => `<tr>
            <td>${new Date(s.snapshotAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
            <td>₹${s.price.toFixed(2)}</td><td>${s.stopLoss ? '₹' + s.stopLoss.toFixed(2) : '-'}</td><td>${s.target ? '₹' + s.target.toFixed(2) : '-'}</td>
          </tr>`).join('')}
        </table>
      `;
    }
    contentBox.dataset.loaded = 'true';
    link.textContent = '🕐 Hide timeline';
  } catch (err) {
    contentBox.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
});

async function loadRemovedList(containerId) {
  const box = document.getElementById(containerId);
  try {
    const { removals } = await api('/recommendations/removed?period=1W');
    if (!removals.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="card" style="margin:14px 0; padding:12px;">
        <div class="muted small" style="margin-bottom:8px; text-transform:uppercase; letter-spacing:.04em;">🚪 Recently removed from lists (last 7 days)</div>
        ${removals.slice(0, 15).map((r) => `
          <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <b>${r.symbol}</b> <span class="muted" style="font-size:11px;">(${CATEGORY_LABELS[r.category] || r.category}) — removed ${r.removedDate}</span>
            ${r.changePctSinceRecommended !== null ? `<span class="change ${r.changePctSinceRecommended >= 0 ? 'up' : 'down'}" style="display:inline; margin-left:6px;">${r.changePctSinceRecommended >= 0 ? '+' : ''}${r.changePctSinceRecommended.toFixed(2)}% since flagged</span>` : ''}
            <div class="muted small">${r.reason}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch {
    box.innerHTML = '';
  }
}

function applyIndexSortAndFilter() {
  const q = document.getElementById('indexFilterInput').value.trim().toUpperCase();
  const streakFilter = document.getElementById('indexStreakSelect').value;
  let list = currentIndexResults.filter((r) => (!q || r.symbol.includes(q)) && passesStreakFilter(r, streakFilter));
  renderIndexTable(list, 'indexResults', indexSortState);

  // Nifty50 / Midcap / Smallcap tabs are browse-only: plain stock table.
  // Recommendation cards (Today's best for Intraday / Short / Long, Golden
  // setups, Swing momentum-reversal) and "recently removed" live only on the
  // home surface — Best of Today + Golden Opportunity Scanner — not here.
  document.getElementById('topPicksBox').innerHTML = '';
  document.getElementById('goldenSetupsBox').innerHTML = '';
  document.getElementById('swingSetupsBox').innerHTML = '';
  document.getElementById('removedListBox').innerHTML = '';
}

let indexSortState = { key: 'score', dir: 'desc' };
let screenerSortState = { key: 'score', dir: 'desc' };

document.querySelectorAll('.index-tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.index-tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const indexName = btn.dataset.index;
    const status = document.getElementById('indexStatus');
    const hint = document.getElementById('indexHint');
    const controls = document.getElementById('indexControls');
    hint.classList.add('hidden');
    controls.classList.remove('hidden');
    document.getElementById('indexFilterInput').value = '';
    document.getElementById('indexStreakSelect').value = '';
    document.getElementById('indexTimeFilterSelect').value = 'any';
    document.getElementById('indexResults').innerHTML = '';
    document.getElementById('topPicksBox').innerHTML = '';
    document.getElementById('goldenSetupsBox').innerHTML = '';
    document.getElementById('swingSetupsBox').innerHTML = '';
    document.getElementById('removedListBox').innerHTML = '';
    indexSortState = { key: 'score', dir: 'desc' };
    const jobId = makeJobId();
    status.innerHTML = progressBarHtml(`Loading ${btn.textContent} — analyzing all constituents (incl. 5-year history; Midcap/Smallcap now cover the full official ~150/~250-stock NSE index, not a shortlist), this can take 1-3 minutes...`);
    const stopPolling = startProgressPolling(status, jobId);
    try {
      const data = await api(`/stocks/index/${indexName}/analysis?jobId=${jobId}`);
      stopPolling();
      currentIndexResults = data.results;
      currentIndexMarketContext = data.marketContext;
      status.textContent = `${data.label}: ${data.results.filter(r => !r.error).length}/${data.results.length} analyzed. Click a row for full details.`;
      // Make sure we know today's trading-day status before deciding
      // whether to show the picks/setups sections (avoids a flash of
      // stale picks on holidays if the banner fetch hasn't resolved yet).
      if (CACHED_MARKET_STATUS === null) await loadHolidayBanner();
      applyIndexSortAndFilter();
    } catch (err) {
      stopPolling();
      status.textContent = err.message;
    }
  });
});

document.getElementById('indexFilterInput').addEventListener('input', applyIndexSortAndFilter);
document.getElementById('indexStreakSelect').addEventListener('change', applyIndexSortAndFilter);
document.getElementById('indexTimeFilterSelect').addEventListener('change', applyIndexSortAndFilter);

function fmtCell(col, r) {
  const v = r[col.key] !== undefined ? r[col.key] : sortValue(r, col.key);
  if (col.fmt) return col.fmt(v, r);
  if (col.key === 'verdict') return `<span class="verdict-badge ${verdictClass(r.verdict)}" style="padding:3px 8px; font-size:11px;">${r.verdict}</span>`;
  if (col.key === 'suggestedHorizon') return r.suggestedHorizon.replace('_', ' ');
  if (v === null || v === undefined) return '-';
  if (col.key === 'score') return v.toFixed(1);
  if (col.period) return `<span class="change ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  return v;
}

function renderIndexTable(results, containerId, sortState) {
  const box = document.getElementById(containerId);
  if (!results.length) { box.innerHTML = '<p class="muted small">No matches.</p>'; return; }

  const sorted = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (b.error && !a.error) return -1;
    if (a.error && b.error) return 0;
    const va = sortValue(a, sortState.key), vb = sortValue(b, sortState.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sortState.dir === 'asc' ? va - vb : vb - va;
  });

  const table = document.createElement('table');
  table.className = 'indicator-table table-reveal';
  table.style.width = '100%';
  table.style.marginTop = '10px';
  table.style.minWidth = '900px';

  const headerRow = document.createElement('tr');
  TABLE_COLUMNS.forEach((col) => {
    const th = document.createElement('td');
    const arrow = sortState.key === col.key ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
    th.innerHTML = `<b>${col.label}${arrow}</b>`;
    if (col.sortable !== false) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        if (sortState.key === col.key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        else { sortState.key = col.key; sortState.dir = 'desc'; }
        renderIndexTable(results, containerId, sortState);
      });
    }
    headerRow.appendChild(th);
  });
  headerRow.appendChild(document.createElement('td'));
  table.appendChild(headerRow);

  sorted.forEach((r) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    if (r.error) {
      tr.innerHTML = `<td><b>${r.symbol}</b></td><td colspan="${TABLE_COLUMNS.length}" class="muted">${r.error}</td><td></td>`;
    } else {
      tr.innerHTML = TABLE_COLUMNS.map((col) => `<td>${col.key === 'symbol' ? `<b>${r.symbol}</b>` : fmtCell(col, r)}</td>`).join('')
        + `<td><button class="small view-btn">View</button></td>`;
      // Note: this row is NOT re-rendered when the person comes back via
      // "Back to results" - the whole list just gets un-hidden as-is. So
      // this handler must never leave the row in a state that would still
      // be visible/broken on return (e.g. dimmed + un-clickable) - the
      // list disappearing entirely (indexBrowser gets hidden) is already
      // all the "this is loading" feedback needed.
      const openIt = () => loadSymbol(r.symbol);
      tr.querySelector('.view-btn').addEventListener('click', (e) => { e.stopPropagation(); openIt(); });
      tr.addEventListener('click', openIt);
    }
    table.appendChild(tr);
  });
  box.innerHTML = '';
  box.appendChild(table);
}


// ---------- sticky search history (until user crosses) ----------
const SEARCH_HIST_KEY = 'stocklens_search_hist_v1';
function getSearchHist() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HIST_KEY) || '[]'); } catch { return []; }
}
function saveSearchHist(list) {
  try { localStorage.setItem(SEARCH_HIST_KEY, JSON.stringify(list.slice(0, 24))); } catch (_) {}
}
function addSearchHist(symbol, name) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  let list = getSearchHist().filter((x) => x.symbol !== sym);
  list.unshift({ symbol: sym, name: name || sym, at: Date.now() });
  saveSearchHist(list);
  renderSearchChips();
}
function removeSearchHist(symbol) {
  saveSearchHist(getSearchHist().filter((x) => x.symbol !== String(symbol).toUpperCase()));
  renderSearchChips();
}
function openSymbolFromSearch(symbol, name) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return;
  const resultsBox = document.getElementById('searchResults');
  const chipsBox = document.getElementById('searchRecentChips');
  const input = document.getElementById('searchInput');
  if (resultsBox) resultsBox.classList.add('hidden');
  if (chipsBox) chipsBox.classList.remove('is-open');
  if (input) input.value = sym;
  try { addSearchHist(sym, name || sym); } catch (_) {}
  // Always force a fresh open (same symbol re-click also reloads)
  loadSymbol(sym, { keepReturn: false });
}

function renderSearchChips() {
  const box = document.getElementById('searchRecentChips');
  if (!box) return;
  const list = getSearchHist();
  if (!list.length) { box.innerHTML = ''; box.classList.remove('is-open'); return; }
  box.innerHTML = list.map((x) => `
    <span class="search-chip" data-symbol="${x.symbol}" role="button" tabindex="0">
      <span class="chip-sym">${x.symbol}</span>
      <button type="button" class="chip-x" data-remove="${x.symbol}" title="Remove" aria-label="Remove">×</button>
    </span>`).join('');
  box.querySelectorAll('.search-chip').forEach((el) => {
    const open = (e) => {
      if (e.target.closest('.chip-x')) return;
      e.preventDefault();
      e.stopPropagation();
      openSymbolFromSearch(el.dataset.symbol);
    };
    // pointerdown fires before blur — avoids second-click / focus race
    el.addEventListener('pointerdown', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
  });
  box.querySelectorAll('.chip-x').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeSearchHist(btn.dataset.remove);
    });
  });
}

function wireSearchChipsFocus() {
  const input = document.getElementById('searchInput');
  const box = document.getElementById('searchRecentChips');
  if (!input || !box || box.dataset.wired) return;
  box.dataset.wired = '1';
  let blurT = null;
  const showChips = () => {
    clearTimeout(blurT);
    // Only show recent chips when input empty / short — suggestions take priority while typing
    if ((input.value || '').trim().length >= 1) {
      box.classList.remove('is-open');
      return;
    }
    if (getSearchHist().length) box.classList.add('is-open');
  };
  input.addEventListener('focus', showChips);
  input.addEventListener('click', showChips);
  input.addEventListener('blur', () => {
    blurT = setTimeout(() => box.classList.remove('is-open'), 220);
  });
  // Do NOT preventDefault on whole box — chip uses pointerdown instead
}


// ---------- search ----------
let searchDebounce = null;
let searchReqId = 0;
const searchInputEl = document.getElementById('searchInput');
if (searchInputEl) {
  searchInputEl.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    const box = document.getElementById('searchResults');
    const chips = document.getElementById('searchRecentChips');
    if (!box) return;
    if (q.length < 1) {
      box.classList.add('hidden');
      box.innerHTML = '';
      if (chips && getSearchHist().length) chips.classList.add('is-open');
      return;
    }
    if (chips) chips.classList.remove('is-open');
    box.innerHTML = '<div class="muted small" style="padding:8px 12px;">Searching…</div>';
    box.classList.remove('hidden');
    const req = ++searchReqId;
    searchDebounce = setTimeout(async () => {
      try {
        const { results } = await api(`/stocks/search?q=${encodeURIComponent(q)}`);
        if (req !== searchReqId) return; // stale response
        box.innerHTML = '';
        if (!results?.length) {
          box.innerHTML = '<div class="muted small" style="padding:8px 12px;">No match — try symbol like RELIANCE, TCS</div>';
          box.classList.remove('hidden');
          return;
        }
        results.slice(0, 12).forEach((r) => {
          const div = document.createElement('div');
          div.className = 'search-result-row';
          div.setAttribute('role', 'option');
          div.innerHTML = `<b>${r.symbol}</b> <span class="muted small">— ${r.name || r.symbol}</span>`;
          const pick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openSymbolFromSearch(r.symbol, r.name);
          };
          div.addEventListener('pointerdown', pick);
          box.appendChild(div);
        });
        box.classList.remove('hidden');
      } catch (err) {
        if (req !== searchReqId) return;
        box.innerHTML = '<div class="muted small" style="padding:8px 12px;color:var(--red);">Search failed — retry</div>';
        box.classList.remove('hidden');
      }
    }, 180);
  });

  // Enter → open first suggestion or typed symbol
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const box = document.getElementById('searchResults');
    const first = box?.querySelector('.search-result-row, div[role="option"]');
    const q = searchInputEl.value.trim().toUpperCase();
    if (first?.querySelector('b')) {
      openSymbolFromSearch(first.querySelector('b').textContent, '');
    } else if (q.length >= 1) {
      openSymbolFromSearch(q);
    }
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) {
    document.getElementById('searchResults')?.classList.add('hidden');
    document.getElementById('searchRecentChips')?.classList.remove('is-open');
  }
});

// ---------- symbol / analysis view ----------
// Remember where the user came from so Back restores that screen (IPO, Results, etc.)
let NAV_RETURN = { scrollY: 0, view: 'dashboard', label: 'home' };

function getActiveMainView() {
  const active = document.querySelector('.main-tabs .tab-btn.active');
  return active?.dataset?.view || 'dashboard';
}

function backLabelForView(view) {
  const map = {
    dashboard: '← Back to home',
    under200: '← Back to Under ₹200',
    fno: '← Back to F&O Desk',
    ipo: '← Back to IPO',
    multibagger: '← Back to Multi-Bagger',
    'results-calendar': '← Back to Results',
    'zero-loss': '← Back to Zero-Loss',
    weekend: '← Back to Weekend Picks',
    watchlist: '← Back to Watchlist',
    alerts: '← Back to Alerts',
    journal: '← Back to Journal',
    'bulk-screener': '← Back to Screener',
    institutional: '← Back to Institutional',
    track: '← Back to Track Record',
    learning: '← Back to Model Learning',
    'tomorrow-conviction': '← Back to Kal ke liye',
    'sector-ancillary': '← Back to Sector Invest',
    markets: '← Back to Markets',
    'early-opportunity': '← Back to Early Opportunity',
  };
  return map[view] || '← Back to results';
}

document.getElementById('backToListBtn').addEventListener('click', () => {
  document.getElementById('symbolView').classList.add('hidden');
  const home = document.getElementById('dashboardHome');
  if (home) home.classList.remove('hidden');
  document.getElementById('indexBrowser')?.classList.remove('hidden');
  if (!currentIndexResults.length) document.getElementById('noSymbol')?.classList.remove('hidden');

  const returnView = NAV_RETURN.view || 'dashboard';
  document.querySelectorAll('.main-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.main-tabs .tab-btn[data-view="${returnView}"]`)?.classList.add('active');
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const viewEl = document.getElementById(`view-${returnView}`);
  if (viewEl) viewEl.classList.add('active');
  else document.getElementById('view-dashboard')?.classList.add('active');

  // IPO: ensure list (not detail-only) is visible when returning
  if (returnView === 'ipo') {
    const ipoHome = document.getElementById('ipoHome');
    const ipoDetail = document.getElementById('ipoDetailPage');
    if (ipoDetail) ipoDetail.classList.add('hidden');
    if (ipoHome) ipoHome.classList.remove('hidden');
  }

  window.scrollTo({ top: NAV_RETURN.scrollY || 0, behavior: 'smooth' });
  if (ws && ws.readyState === WebSocket.OPEN && CURRENT_SYMBOL) {
    ws.send(JSON.stringify({ type: 'unsubscribe', symbol: CURRENT_SYMBOL }));
  }
  CURRENT_SYMBOL = null;
});

async function loadSymbol(symbol, opts = {}) {
  const next = String(symbol || '').toUpperCase().trim();
  if (!next) return;
  CURRENT_SYMBOL = next;
  try { addSearchHist(CURRENT_SYMBOL); } catch (_) {}
  // Capture source view before switching tabs (unless caller set it)
  if (opts.fromView) {
    NAV_RETURN.view = opts.fromView;
  } else if (!opts.keepReturn) {
    NAV_RETURN.view = getActiveMainView();
  }
  NAV_RETURN.scrollY = window.scrollY || 0;
  NAV_RETURN.label = backLabelForView(NAV_RETURN.view);

  // True "page" switch: hide home feed, show only symbol analysis.
  const home = document.getElementById('dashboardHome');
  if (home) home.classList.add('hidden');
  document.getElementById('noSymbol')?.classList.add('hidden');
  document.getElementById('symbolView').classList.remove('hidden');
  document.getElementById('backToListBtn').classList.remove('hidden');
  document.getElementById('backToListBtn').textContent = NAV_RETURN.label || '← Back to results';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  document.getElementById('symTitle').textContent = CURRENT_SYMBOL;
  document.getElementById('symCompany').innerHTML = '<span class="spin"></span>Loading...';
  document.getElementById('symPrice').textContent = '-';
  document.getElementById('symChange').textContent = '';
  clearAnalysisPanels();

  // Analysis UI lives under dashboard shell; keep that visible for chart
  document.querySelectorAll('.main-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.main-tabs .tab-btn[data-view="dashboard"]')?.classList.add('active');
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-dashboard')?.classList.add('active');

  try {
    const { analysis, candles, marketContext } = await api(`/stocks/${CURRENT_SYMBOL}/analysis`);
    renderAnalysis(analysis, candles, marketContext);
    subscribeLive(CURRENT_SYMBOL);
    setLiveStatus(isIndianMarketHours());
    loadNews(CURRENT_SYMBOL, analysis);
    loadFundamentals(CURRENT_SYMBOL);
    loadCompanyStudy(CURRENT_SYMBOL);
    prefillRiskCalc(analysis);
    renderTradePlan(analysis);
  } catch (err) {
    clearAnalysisPanels();
    document.getElementById('symCompany').innerHTML =
      `<span style="color:var(--red)">${err.message}</span> — <a href="#" id="retryLoadBtn" style="color:var(--accent)">Retry</a>`;
    document.getElementById('retryLoadBtn').addEventListener('click', (ev) => {
      ev.preventDefault();
      loadSymbol(CURRENT_SYMBOL, { keepReturn: true });
    });
  }
}

function clearAnalysisPanels() {
  document.getElementById('verdictBadge').textContent = '-';
  document.getElementById('verdictBadge').className = 'verdict-badge';
  document.getElementById('suggestedHorizon').textContent = '-';
  document.getElementById('factorList').innerHTML = '';
  document.getElementById('indicatorTable').innerHTML = '';
  document.getElementById('periodReturnsTable').innerHTML = '';
  document.getElementById('activityNote').textContent = '';
  document.getElementById('newsList').innerHTML = '';
  document.getElementById('earningsNote').innerHTML = '';
  document.getElementById('backtestResults').innerHTML = '';
  document.getElementById('mtfResults').innerHTML = '';
  document.getElementById('decisionResults').innerHTML = '';
  document.getElementById('fundamentalsBox').innerHTML = '';
  const cs = document.getElementById('companyStudyBox');
  if (cs) cs.innerHTML = '';
  document.getElementById('riskCalcResult').innerHTML = '';
  document.getElementById('tradePlanBox').innerHTML = '';
  document.getElementById('marketContextNote').textContent = '';
  document.getElementById('weeklyReadNote').textContent = '';
  document.getElementById('resistanceList').innerHTML = '';
  document.getElementById('supportList').innerHTML = '';
  document.getElementById('candlePatternsBox').innerHTML = '';
  document.getElementById('breakoutBox').innerHTML = '';
  document.getElementById('relativeStrengthBox').innerHTML = '';
  document.getElementById('streakNote').textContent = '';
}

document.getElementById('runDecisionBtn').addEventListener('click', async () => {
  if (!CURRENT_SYMBOL) return;
  const box = document.getElementById('decisionResults');
  box.innerHTML = '<p class="muted small"><span class="spin"></span>Checking data quality, market regime and your trading status...</p>';
  try {
    const data = await api(`/stocks/${CURRENT_SYMBOL}/decision`);
    renderDecisionCard(data);
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red)">${err.message}</p>`;
  }
});

const DECISION_COLOR = {
  'BUY NOW': 'bullish', 'BUY ON PULLBACK': 'bullish', 'BUY ON CONFIRMED BREAKOUT': 'bullish',
  WAIT: 'neutral', WATCHLIST: 'neutral', HOLD: 'neutral', AVOID: 'bearish', 'NO TRADE': 'bearish',
};

// Colors the buy-zone state machine's fixed states (see server/buyZoneEngine.js)
const ZONE_STATE_BADGE_CLASS = {
  BUY_ZONE: 'bullish', BELOW_ZONE: 'neutral', ABOVE_ZONE: 'neutral', WAIT_FOR_RETEST: 'neutral',
  TARGET_HIT: 'bullish', STOP_LOSS_HIT: 'bearish', EXPIRED: 'bearish', INVALIDATED: 'bearish',
};

function renderDecisionCard(data) {
  const box = document.getElementById('decisionResults');
  const { analysis, decision, dataQuality, marketContext, tradingStatus } = data;
  const p = analysis.tradePlan;
  const zs = analysis.zoneState;
  const dcColor = dataQuality.dataConfidence >= 70 ? 'up' : dataQuality.dataConfidence >= 50 ? '' : 'down';

  box.innerHTML = `
    <div class="verdict-badge ${DECISION_COLOR[decision.decision] || 'neutral'}" style="font-size:16px; padding:8px 16px; margin-bottom:8px;">${decision.decision}</div>
    ${zs ? `<div class="verdict-badge ${ZONE_STATE_BADGE_CLASS[zs.state] || 'neutral'}" style="padding:4px 10px; margin-bottom:12px; display:inline-block; margin-left:8px;">${zs.label}</div>` : ''}
    <table class="indicator-table" style="width:100%; margin-bottom:12px;">
      <tr><td>CMP</td><td>₹${analysis.price?.toFixed(2) ?? '-'}</td></tr>
      <tr><td>Entry Quality Score</td><td><b>${decision.entryQuality}/100</b> (${decision.scoreLabel})</td></tr>
      <tr><td>Data Confidence</td><td class="change ${dcColor}">${dataQuality.dataConfidence}%</td></tr>
      <tr><td>Market Regime</td><td>${marketContext.trend}</td></tr>
      ${p ? `<tr><td>Entry / SL / Target</td><td>₹${p.entryLow}–₹${p.entryHigh} / ₹${p.stopLoss} / ₹${p.target}</td></tr>` : ''}
      ${p ? `<tr><td>Risk:Reward</td><td>1:${p.riskRewardRatio ?? '-'}</td></tr>` : ''}
      <tr><td>Today's trades / limit</td><td>${tradingStatus.tradesTakenToday} / ${tradingStatus.settings.maxTradesPerDay}${tradingStatus.maxTradesHit ? ' ⚠️ limit reached' : ''}</td></tr>
      <tr><td>Today's P&amp;L</td><td class="change ${tradingStatus.todaysPnl >= 0 ? 'up' : 'down'}">₹${tradingStatus.todaysPnl}${tradingStatus.dailyLimitHit ? ' ⚠️ daily loss limit hit' : ''}</td></tr>
      ${tradingStatus.inCooldown ? `<tr><td>Cooldown</td><td class="change down">Active — ${tradingStatus.cooldownMinutesLeft} min left</td></tr>` : ''}
    </table>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <div>
        <div class="muted small" style="margin-bottom:6px;">✅ WHY</div>
        <ul class="factor-list">${decision.why.map(w => `<li class="bullish">${w}</li>`).join('') || '<li class="muted">-</li>'}</ul>
      </div>
      <div>
        <div class="muted small" style="margin-bottom:6px;">❌ WHY NOT</div>
        <ul class="factor-list">${decision.whyNot.map(w => `<li class="bearish">${w}</li>`).join('') || '<li class="muted">-</li>'}</ul>
      </div>
    </div>

    <div class="muted small" style="margin-top:12px; padding:10px; background:var(--panel-2); border-radius:8px;">
      <b>Invalidation:</b> ${decision.invalidation}
    </div>
    <p class="disclaimer">${decision.disclaimer}</p>
    <p class="muted small" style="margin-top:6px;">Data timestamp: ${new Date().toLocaleString('en-IN')}</p>
  `;
}

document.getElementById('runMtfBtn').addEventListener('click', async () => {
  if (!CURRENT_SYMBOL) return;
  const box = document.getElementById('mtfResults');
  box.innerHTML = '<p class="muted small"><span class="spin"></span>Checking 5m, 15m, 1h, 4h, Daily, Weekly...</p>';
  try {
    const { mtf } = await api(`/stocks/${CURRENT_SYMBOL}/mtf`);
    renderMtf(mtf);
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red)">${err.message}</p>`;
  }
});

const TF_LABELS = { '5m': '5 Min', '15m': '15 Min', '1h': '1 Hour', '4h': '4 Hour', daily: 'Daily', weekly: 'Weekly' };

function renderMtf(mtf) {
  const box = document.getElementById('mtfResults');
  const dominantCls = mtf.dominant === 'bullish' ? 'bullish' : mtf.dominant === 'bearish' ? 'bearish' : 'neutral';
  box.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
      <span class="verdict-badge ${dominantCls}">${mtf.dominant.toUpperCase()} bias</span>
      <span class="muted small">Alignment: <b>${mtf.alignmentScore === null ? '-' : mtf.alignmentScore + '%'}</b> of timeframes agree</span>
    </div>
    <table class="indicator-table" style="width:100%;">
      <tr><td><b>Timeframe</b></td><td><b>Verdict</b></td><td><b>Score</b></td></tr>
      ${mtf.timeframes.map((tf) => {
        if (tf.status) return `<tr><td>${TF_LABELS[tf.timeframe] || tf.timeframe}</td><td colspan="2" class="muted">${tf.status === 'insufficient_data' ? 'Not enough history' : 'Could not load'}</td></tr>`;
        return `<tr>
          <td>${TF_LABELS[tf.timeframe] || tf.timeframe}</td>
          <td><span class="verdict-badge ${verdictClass(tf.verdict)}" style="padding:2px 8px; font-size:11px;">${tf.verdict}</span></td>
          <td class="change ${tf.score >= 0 ? 'up' : 'down'}">${tf.score}</td>
        </tr>`;
      }).join('')}
    </table>
    <p class="muted small" style="margin-top:8px;">${mtf.note}</p>
  `;
}

document.getElementById('runBacktestBtn').addEventListener('click', async () => {
  if (!CURRENT_SYMBOL) return;
  const box = document.getElementById('backtestResults');
  box.innerHTML = '<p class="muted small">Running backtest over up to 5 years of data...</p>';
  try {
    const { backtest } = await api(`/stocks/${CURRENT_SYMBOL}/backtest`);
    renderBacktest(backtest);
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red)">${err.message}</p>`;
  }
});

function renderBacktest(bt) {
  const box = document.getElementById('backtestResults');
  const s = bt.stats;
  const wrColor = s.winRate === null ? '' : (s.winRate >= 50 ? 'up' : 'down');
  const netColor = s.netReturnPct >= 0 ? 'up' : 'down';
  const bhColor = s.buyHoldReturnPct >= 0 ? 'up' : 'down';
  const confColor = bt.backtestConfidence >= 60 ? 'bullish' : bt.backtestConfidence >= 40 ? 'neutral' : 'bearish';

  box.innerHTML = `
    <div class="muted small" style="margin-bottom:10px;">Tested ${bt.period.from} → ${bt.period.to} (${bt.period.tradingDays} trading days) · ${s.totalTrades} trade(s) generated</div>
    ${bt.sampleSizeWarning ? `<p class="muted small" style="color:var(--amber); margin-bottom:10px;">⚠️ ${bt.sampleSizeWarning}</p>` : ''}

    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
      <span class="verdict-badge ${confColor}">Backtest Confidence: ${bt.backtestConfidence}/100</span>
      <span class="muted small">${bt.lookAheadBiasCheck}</span>
    </div>

    <table class="indicator-table" style="width:100%; margin-bottom:14px;">
      <tr><td>Win rate</td><td class="change ${wrColor}">${s.winRate === null ? 'no trades' : s.winRate.toFixed(1) + '%'}</td></tr>
      <tr><td>Avg win / avg loss</td><td>${s.avgWinPct === null ? '-' : '+' + s.avgWinPct.toFixed(2) + '%'} / ${s.avgLossPct === null ? '-' : s.avgLossPct.toFixed(2) + '%'}</td></tr>
      <tr><td>Profit factor</td><td>${s.profitFactor === null ? '-' : s.profitFactor}</td></tr>
      <tr><td>Avg holding period</td><td>${s.avgHoldDays === null ? '-' : s.avgHoldDays + ' trading days'}</td></tr>
      <tr><td>Expectancy (avg return/trade)</td><td class="change ${s.expectancyPct >= 0 ? 'up' : 'down'}">${s.expectancyPct === null ? '-' : (s.expectancyPct >= 0 ? '+' : '') + s.expectancyPct.toFixed(2) + '%'}</td></tr>
      <tr><td>Gross return (before costs)</td><td>${s.grossReturnPct >= 0 ? '+' : ''}${s.grossReturnPct.toFixed(1)}%</td></tr>
      <tr><td><b>Net return (after costs)</b></td><td class="change ${netColor}"><b>${s.netReturnPct >= 0 ? '+' : ''}${s.netReturnPct.toFixed(1)}%</b></td></tr>
      <tr><td>Buy &amp; hold (same stock)</td><td class="change ${bhColor}">${s.buyHoldReturnPct >= 0 ? '+' : ''}${s.buyHoldReturnPct.toFixed(1)}%</td></tr>
      <tr><td>Nifty 50 (same period)</td><td>${s.niftyReturnPct === null ? '-' : (s.niftyReturnPct >= 0 ? '+' : '') + s.niftyReturnPct.toFixed(1) + '%'}</td></tr>
      <tr><td>Max drawdown</td><td class="change down">-${s.maxDrawdownPct.toFixed(1)}%</td></tr>
      <tr><td>Beat buy &amp; hold / beat Nifty?</td><td>${s.outperformedBuyHold === null ? '-' : (s.outperformedBuyHold ? '✅' : '❌')} / ${s.outperformedNifty === null ? '-' : (s.outperformedNifty ? '✅' : '❌')}</td></tr>
    </table>
    <div id="equityChartCanvas" style="margin-top:8px;"></div>

    ${bt.outOfSample?.status === 'ok' ? `
    <div class="card" style="margin-top:14px; padding:12px;">
      <div class="muted small" style="text-transform:uppercase; margin-bottom:8px;">Walk-Forward (In-Sample vs Out-of-Sample)</div>
      <table class="indicator-table" style="width:100%;">
        <tr><td>In-sample (${bt.outOfSample.inSamplePeriod.from} → ${bt.outOfSample.inSamplePeriod.to})</td><td>${bt.outOfSample.inSampleReturnPct}% · ${bt.outOfSample.inSampleWinRate ?? '-'}% win rate · ${bt.outOfSample.inSamplePeriod.trades} trades</td></tr>
        <tr><td>Out-of-sample (${bt.outOfSample.outOfSamplePeriod.from} → ${bt.outOfSample.outOfSamplePeriod.to})</td><td>${bt.outOfSample.outOfSampleReturnPct}% · ${bt.outOfSample.outOfSampleWinRate ?? '-'}% win rate · ${bt.outOfSample.outOfSamplePeriod.trades} trades</td></tr>
        <tr><td>Survives out-of-sample?</td><td>${bt.outOfSample.survivesOutOfSample === null ? '-' : (bt.outOfSample.survivesOutOfSample ? '✅ Yes' : '❌ No — performance did not hold up')}</td></tr>
      </table>
    </div>` : ''}

    ${bt.monteCarlo && bt.monteCarlo.runs ? `
    <div class="card" style="margin-top:14px; padding:12px;">
      <div class="muted small" style="text-transform:uppercase; margin-bottom:8px;">Monte Carlo (${bt.monteCarlo.runs} reshuffles of these trades)</div>
      <table class="indicator-table" style="width:100%;">
        <tr><td>Return range (5th–95th percentile)</td><td>${bt.monteCarlo.returnPercentiles.p5}% to ${bt.monteCarlo.returnPercentiles.p95}%</td></tr>
        <tr><td>Median outcome</td><td>${bt.monteCarlo.returnPercentiles.p50}%</td></tr>
        <tr><td>Drawdown (median / 95th percentile)</td><td>-${bt.monteCarlo.drawdownPercentiles.p50}% / -${bt.monteCarlo.drawdownPercentiles.p95}%</td></tr>
        <tr><td>Probability of an overall loss</td><td>${bt.monteCarlo.probabilityOfLoss}%</td></tr>
      </table>
    </div>` : ''}

    ${bt.parameterSensitivity ? `
    <div class="card" style="margin-top:14px; padding:12px;">
      <div class="muted small" style="text-transform:uppercase; margin-bottom:8px;">Parameter Sensitivity</div>
      <p class="muted small">Base return ${bt.parameterSensitivity.baseReturnPct}% vs nearby threshold variants spread ${bt.parameterSensitivity.spread}pp — ${bt.parameterSensitivity.stable ? '✅ reasonably stable, likely not overfit to this exact threshold' : '⚠️ small threshold changes swing results a lot — possible overfitting, treat with caution'}.</p>
    </div>` : ''}

    <details style="margin-top:12px;">
      <summary style="cursor:pointer; color:var(--accent); font-size:13px;">Show all ${bt.trades.length} trade(s)</summary>
      <table class="indicator-table" style="width:100%; margin-top:8px; font-size:12px;">
        <tr><td><b>Entry</b></td><td><b>Exit</b></td><td><b>Entry ₹</b></td><td><b>Exit ₹</b></td><td><b>Net Return</b></td><td><b>Days held</b></td></tr>
        ${bt.trades.map(t => `<tr>
          <td>${t.entryDate}</td><td>${t.exitDate}</td><td>${t.entryPrice.toFixed(2)}</td><td>${t.exitPrice.toFixed(2)}</td>
          <td class="change ${t.returnPct >= 0 ? 'up' : 'down'}">${t.returnPct >= 0 ? '+' : ''}${t.returnPct.toFixed(2)}%</td>
          <td>${t.daysHeld}${t.forcedExit ? ' (open at test end)' : ''}</td>
        </tr>`).join('')}
      </table>
    </details>
    <ul class="muted small" style="margin-top:12px; padding-left:18px;">
      ${bt.caveats.map(c => `<li>${c}</li>`).join('')}
    </ul>
  `;

  renderSvgLineChart('equityChartCanvas',
    bt.equityCurve.map((p) => p.date),
    [{ data: bt.equityCurve.map((p) => p.equity), color: '#22c55e', fill: true }]
  );
}


async function loadCompanyStudy(symbol) {
  const box = document.getElementById('companyStudyBox');
  if (!box) return;
  box.innerHTML = '<p class="muted small"><span class="spin"></span> Company overview load…</p>';
  try {
    const d = await api(`/stocks/${encodeURIComponent(symbol)}/company-study`);
    const o = d.overview || {};
    const fmt = (v, suffix = '') => {
      if (v == null || v === '' || (typeof v === 'object')) return '—';
      return v + suffix;
    };
    const fmtPct = (v) => {
      if (v == null) return '—';
      const n = Number(v);
      const cls = n >= 0 ? 'cs-pos' : 'cs-neg';
      return `<span class="${cls}">${n >= 0 ? '+' : ''}${n}%</span>`;
    };
    const rangeBar = (low, high, pos, lowLabel, highLabel) => {
      if (low == null && high == null) return '<div class="muted small">Range data N/A</div>';
      const p = pos != null ? pos : 50;
      return `
        <div class="cs-range">
          <div class="cs-range-labels">
            <span class="cs-range-side"><span class="cs-muted">${lowLabel}</span><b>${fmt(low)}</b></span>
            <span class="cs-range-side" style="text-align:right"><span class="cs-muted">${highLabel}</span><b>${fmt(high)}</b></span>
          </div>
          <div class="cs-range-track">
            <div class="cs-range-fill" style="width:${p}%"></div>
            <div class="cs-range-marker" style="left:${p}%" title="Current"></div>
          </div>
        </div>`;
    };

    const qList = d.quarterly || [];
    const maxQ = Math.max(...qList.map((q) => Math.max(q.revenueCr || 0, q.profitCr || 0)), 1);
    const qBars = qList.map((q) => {
      const rh = q.revenueCr != null ? Math.max(4, Math.round((q.revenueCr / maxQ) * 100)) : 0;
      const ph = q.profitCr != null ? Math.max(4, Math.round((q.profitCr / maxQ) * 100)) : 0;
      const tip = `${q.labelFull || q.label || ''}
Revenue: ${q.revenueCr != null ? '₹' + q.revenueCr + ' Cr' : 'N/A'}
Profit: ${q.profitCr != null ? '₹' + q.profitCr + ' Cr' : 'N/A'}`;
      return `<div class="cs-qcol" title="${tip.replace(/"/g, '&quot;')}">
        <div class="cs-qbars">
          <div class="cs-qbar rev" style="height:${rh}%"></div>
          <div class="cs-qbar prof" style="height:${ph}%"></div>
        </div>
        <div class="cs-qlab">${q.label || '—'}</div>
        <div class="cs-qnums">
          <span class="cs-qrev">${q.revenueCr != null ? q.revenueCr : '—'}</span>
          <span class="cs-qprof">${q.profitCr != null ? q.profitCr : '—'}</span>
        </div>
      </div>`;
    }).join('');

    const fundRows = (d.fundamentalsGrid || []).map((r) => {
      const val = r.value != null && typeof r.value !== 'object' ? r.value : 'N/A';
      return `<div class="cs-fund-cell"><span class="cs-fund-k">${r.label}</span><span class="cs-fund-v">${val}</span></div>`;
    }).join('');

    const shBars = (d.shareholdingBars || []).map((b) =>
      `<div class="cs-sh-row">
        <span class="cs-sh-k">${b.key}</span>
        <div class="cs-sh-track"><div class="cs-sh-fill" style="width:${Math.min(100, Number(b.pct) || 0)}%;background:${b.color}"></div></div>
        <span class="cs-sh-v">${b.pct}%</span>
      </div>`
    ).join('') || '<div class="muted small">Shareholding breakdown N/A</div>';

    const mfList = (d.fundHolders || []).length
      ? (d.fundHolders || []).map((h) => `<div class="cs-mf-row"><span>${h.name}</span><span class="cs-pos">${h.pct != null ? h.pct + '%' : '—'}</span></div>`).join('')
      : '<div class="muted small">Mutual fund list N/A</div>';

    const piv = d.pivots || {};
    const tech = d.technicals || {};
    const ma = d.movingAverages || {};
    const techVerdict = tech.verdict || '—';
    const bullishish = /bull/i.test(String(techVerdict));
    const bearishish = /bear/i.test(String(techVerdict));

    box.innerHTML = `
      <div class="cs-hero">
        <div>
          <div class="cs-hero-name">${fmt(o.companyName) !== '—' ? o.companyName : symbol}</div>
          <div class="cs-hero-meta">
            <span class="cs-chip">${fmt(o.sector)}</span>
            <span class="cs-chip cs-chip-ind">${fmt(o.industry)}</span>
            <span class="cs-chip muted">${fmt(o.symbol)}</span>
          </div>
        </div>
        <div class="cs-hero-price">
          <div class="cs-price-big">${o.price != null ? '₹' + o.price : '—'}</div>
          <div>${fmtPct(o.changePct)}</div>
        </div>
      </div>

      <div class="cs-tabs">
        <button type="button" class="cs-tab active" data-cs="overview">Overview</button>
        <button type="button" class="cs-tab" data-cs="tech">Technicals</button>
        <button type="button" class="cs-tab" data-cs="about">About</button>
      </div>

      <div class="cs-pane active" id="csPaneOverview">
        <div class="cs-block">
          <div class="cs-block-title">Performance</div>
          ${rangeBar(o.dayLow, o.dayHigh, o.dayPos, "Today's low", "Today's high")}
          ${rangeBar(o.week52Low, o.week52High, o.week52Pos, '52 week low', '52 week high')}
          <div class="cs-stat-row">
            <div class="cs-stat"><span class="cs-muted">Open</span><div class="cs-stat-v">${fmt(o.open)}</div></div>
            <div class="cs-stat"><span class="cs-muted">Prev close</span><div class="cs-stat-v">${fmt(o.previousClose)}</div></div>
            <div class="cs-stat"><span class="cs-muted">Volume</span><div class="cs-stat-v">${o.volume != null ? Number(o.volume).toLocaleString('en-IN') : '—'}</div></div>
            <div class="cs-stat"><span class="cs-muted">Hist high${o.allTimeHighDate ? ' · ' + o.allTimeHighDate : ''}</span><div class="cs-stat-v cs-pos">${fmt(o.allTimeHigh)}</div></div>
            <div class="cs-stat"><span class="cs-muted">Hist low${o.allTimeLowDate ? ' · ' + o.allTimeLowDate : ''}</span><div class="cs-stat-v cs-neg">${fmt(o.allTimeLow)}</div></div>
          </div>
        </div>

        <div class="cs-block">
          <div class="cs-block-title">Fundamentals</div>
          <div class="cs-fund-grid">${fundRows}</div>
        </div>

        ${(() => {
          const vv = d.valuationVerdict;
          if (!vv) return '';
          const toneCls = 'cs-val-' + (vv.tone || 'mixed');
          return `<div class="cs-block cs-val-block ${toneCls}">
            <div class="cs-block-title">${vv.title || 'Valuation check'}</div>
            <div class="cs-val-head">${vv.headline || ''}</div>
            <ul class="cs-val-list">${(vv.bullets || []).map((b) => `<li>${b}</li>`).join('')}</ul>
            <div class="cs-val-metrics">
              <span>PE ${vv.metrics?.pe ?? '—'}</span>
              <span>P/B ${vv.metrics?.pb ?? '—'}</span>
              <span>Ind PE ${vv.metrics?.industryPE ?? '—'}</span>
              <span>PEG ${vv.metrics?.peg ?? '—'}</span>
              <span>ROE ${vv.metrics?.roe != null ? vv.metrics.roe + '%' : '—'}</span>
            </div>
            <div class="cs-muted" style="margin-top:8px;">Simple rule-based read — guaranteed cheap/expensive nahi. Sector cycle + debt + news alag dekho.</div>
          </div>`;
        })()}

        <div class="cs-block">
          <div class="cs-block-title">Financial performance</div>
          <div class="cs-growth-row">
            <div class="cs-growth-card"><span class="cs-muted">Revenue 1Y</span><div>${fmtPct(d.growth?.revenueYoY)}</div></div>
            <div class="cs-growth-card"><span class="cs-muted">Profit 1Y</span><div>${fmtPct(d.growth?.profitYoY)}</div></div>
            <div class="cs-growth-card"><span class="cs-muted">Rev QoQ</span><div>${fmtPct(d.growth?.revenueQoQ)}</div></div>
            <div class="cs-growth-card"><span class="cs-muted">Profit QoQ</span><div>${fmtPct(d.growth?.profitQoQ)}</div></div>
          </div>
          <div class="cs-qchart">${qBars || '<div class="muted small">Quarterly bars N/A</div>'}</div>
          <div class="cs-qlegend">
            <span><i class="cs-dot rev"></i> Revenue (₹ Cr)</span>
            <span><i class="cs-dot prof"></i> Profit (₹ Cr)</span>
            <span class="cs-muted">Hover bar · neeche quarter date</span>
          </div>
        </div>

        <div class="cs-block">
          <div class="cs-block-title">Shareholding pattern</div>
          ${(() => {
            const quarters = d.shareholdingMeta?.quarters || [];
            if (!quarters.length) {
              return shBars + (d.shareholdingMeta?.source
                ? `<div class="cs-muted" style="margin-top:6px;">Source: ${d.shareholdingMeta.source}</div>`
                : '<div class="cs-muted" style="margin-top:6px;">Pattern unavailable</div>');
            }
            const qBtns = quarters.map((q, i) =>
              `<button type="button" class="cs-sh-qbtn${i===0?' active':''}" data-shq="${i}">${q.label}</button>`
            ).join('');
            const renderBars = (q, prev) => {
              const rows = [
                { key: 'DII', pct: q.diiPct, color: '#84cc16', prev: prev?.diiPct },
                { key: 'FII', pct: q.fiiPct, color: '#38bdf8', prev: prev?.fiiPct },
                { key: 'Public', pct: q.publicPct, color: '#f59e0b', prev: prev?.publicPct },
                { key: 'Promoters', pct: q.promoterPct, color: '#a78bfa', prev: prev?.promoterPct },
              ].filter((x) => x.pct != null);
              return rows.map((b) => {
                let deltaHtml = '';
                if (b.prev != null && b.pct != null) {
                  const d = Number(b.pct) - Number(b.prev);
                  if (Math.abs(d) >= 0.01) {
                    const up = d > 0;
                    deltaHtml = `<span class="cs-sh-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${d.toFixed(2)}%</span>`;
                  } else {
                    deltaHtml = `<span class="cs-sh-delta flat">— 0%</span>`;
                  }
                }
                return `<div class="cs-sh-row"><span class="cs-sh-k">${b.key}</span><div class="cs-sh-track"><div class="cs-sh-fill" style="width:${Math.min(100, Number(b.pct)||0)}%;background:${b.color}"></div></div><span class="cs-sh-v"><span class="cs-sh-pct">${Number(b.pct).toFixed(2)}%</span>${deltaHtml}</span></div>`;
              }).join('');
            };
            // quarters[0]=latest; previous quarter for delta = quarters[1]
            return `<div class="cs-sh-qbar">${qBtns}</div>
              <div class="cs-sh-panel" id="csShPanel">${renderBars(quarters[0], quarters[1])}</div>
              <div class="cs-muted" style="margin-top:6px;">Source: groww · ▲/▼ = vs previous quarter</div>
              <script type="application/json" id="csShData">${JSON.stringify(quarters).replace(/</g,'\u003c')}</script>`;
          })()}
        </div>

        <div class="cs-block">
          <div class="cs-block-title">Mutual funds / institutions</div>
          ${mfList}
          ${(d.institutionHolders || []).length ? '<div class="cs-muted" style="margin-top:10px;">Institutions</div>' + (d.institutionHolders || []).map((h) => `<div class="cs-mf-row"><span>${h.name}</span><span>${h.pct != null ? h.pct + '%' : '—'}</span></div>`).join('') : ''}
        </div>
      </div>

      <div class="cs-pane" id="csPaneTech">
        <div class="cs-block">
          <div class="cs-block-title">Summary</div>
          <div class="cs-tech-banner ${bullishish ? 'bull' : bearishish ? 'bear' : ''}">
            Based on technicals: <b>${techVerdict}</b>${tech.score != null ? ` · score ${tech.score}` : ''}
          </div>
          <div class="cs-tech-grid">
            <div class="cs-tech-card">
              <div class="cs-block-title">Support &amp; Resistance</div>
              ${piv.r3 != null ? `<div class="cs-sr res"><span>R3</span><b>${piv.r3}</b></div>` : ''}
              ${piv.r2 != null ? `<div class="cs-sr res"><span>R2</span><b>${piv.r2}</b></div>` : ''}
              ${piv.r1 != null ? `<div class="cs-sr res"><span>R1</span><b>${piv.r1}</b></div>` : ''}
              ${piv.pivot != null ? `<div class="cs-sr pivot"><span>Pivot</span><b>${piv.pivot}</b></div>` : ''}
              <div class="cs-sr price"><span>Price</span><b>${fmt(o.price)}</b></div>
              ${piv.s1 != null ? `<div class="cs-sr sup"><span>S1</span><b>${piv.s1}</b></div>` : ''}
              ${piv.s2 != null ? `<div class="cs-sr sup"><span>S2</span><b>${piv.s2}</b></div>` : ''}
              ${piv.s3 != null ? `<div class="cs-sr sup"><span>S3</span><b>${piv.s3}</b></div>` : ''}
              ${!piv.pivot ? '<div class="muted small">Pivot levels N/A</div>' : ''}
            </div>
            <div class="cs-tech-card">
              <div class="cs-block-title">Indicators</div>
              <div class="cs-sr"><span>RSI (14)</span><b>${fmt(tech.rsi14)}</b></div>
              <div class="cs-sr"><span>MACD hist</span><b class="${tech.macd != null && tech.macd >= 0 ? 'cs-pos' : 'cs-neg'}">${fmt(tech.macd)}</b></div>
              <div class="cs-sr"><span>Beta</span><b>${fmt(tech.beta)}</b></div>
              <div class="cs-sr sup"><span>Nearest support</span><b>${fmt(tech.support)}</b></div>
              <div class="cs-sr res"><span>Nearest resistance</span><b>${fmt(tech.resistance)}</b></div>
            </div>
          </div>
        </div>
        <div class="cs-block">
          <div class="cs-block-title">Moving averages</div>
          <table class="cs-ma-table"><thead><tr><th>Period</th><th>SMA</th><th>EMA</th></tr></thead>
          <tbody>
            <tr><td>10D</td><td class="cs-pos">${fmt(ma.sma10)}</td><td class="cs-pos">${fmt(ma.ema10)}</td></tr>
            <tr><td>20D</td><td class="cs-pos">${fmt(ma.sma20)}</td><td class="cs-pos">${fmt(ma.ema20)}</td></tr>
            <tr><td>50D</td><td class="cs-pos">${fmt(ma.sma50)}</td><td class="cs-pos">${fmt(ma.ema50)}</td></tr>
            <tr><td>100D</td><td class="cs-pos">${fmt(ma.sma100)}</td><td class="cs-pos">${fmt(ma.ema100)}</td></tr>
            <tr><td>200D</td><td class="cs-pos">${fmt(ma.sma200)}</td><td class="cs-pos">${fmt(ma.ema200)}</td></tr>
          </tbody></table>
        </div>
      </div>

      <div class="cs-pane" id="csPaneAbout">
        <div class="cs-block">
          <div class="cs-block-title">About</div>
          <p class="cs-about-text">${d.about?.summary ? String(d.about.summary).slice(0, 1000) : 'Business summary N/A'}</p>
          <div class="cs-stat-row" style="margin-top:12px;">
            <div class="cs-stat"><span class="cs-muted">Sector</span><div class="cs-stat-v">${fmt(d.about?.sector)}</div></div>
            <div class="cs-stat"><span class="cs-muted">Industry</span><div class="cs-stat-v">${fmt(d.about?.industry)}</div></div>
            <div class="cs-stat"><span class="cs-muted">NSE</span><div class="cs-stat-v">${fmt(d.about?.nseSymbol)}</div></div>
            <div class="cs-stat"><span class="cs-muted">Country</span><div class="cs-stat-v">${fmt(o.country)}</div></div>
          </div>
          ${o.website ? `<div class="muted small" style="margin-top:8px;"><a href="${o.website}" target="_blank" rel="noopener">${o.website}</a></div>` : ''}
        </div>
      </div>

      <div class="cs-honesty">${(d.honesty || []).map((h) => `• ${h}`).join('<br/>')}</div>
      <div class="muted small" style="margin-top:6px;">Updated ${d.asOf ? new Date(d.asOf).toLocaleString('en-IN') : ''} · ${d.source || ''}</div>
    `;

    box.querySelectorAll('.cs-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('.cs-tab').forEach((b) => b.classList.remove('active'));
        box.querySelectorAll('.cs-pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const id = btn.dataset.cs === 'overview' ? 'csPaneOverview' : btn.dataset.cs === 'tech' ? 'csPaneTech' : 'csPaneAbout';
        document.getElementById(id)?.classList.add('active');
      });
    });
    // Shareholding quarter tabs
    const shDataEl = box.querySelector('#csShData');
    const shPanel = box.querySelector('#csShPanel');
    if (shDataEl && shPanel) {
      let quarters = [];
      try { quarters = JSON.parse(shDataEl.textContent || '[]'); } catch (_) {}
      box.querySelectorAll('.cs-sh-qbtn').forEach((btn) => {
        btn.addEventListener('click', () => {
          box.querySelectorAll('.cs-sh-qbtn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const qi = Number(btn.dataset.shq);
          const q = quarters[qi];
          const prev = quarters[qi + 1]; // older quarter
          if (!q) return;
          const rows = [
            { key: 'DII', pct: q.diiPct, color: '#84cc16', prev: prev?.diiPct },
            { key: 'FII', pct: q.fiiPct, color: '#38bdf8', prev: prev?.fiiPct },
            { key: 'Public', pct: q.publicPct, color: '#f59e0b', prev: prev?.publicPct },
            { key: 'Promoters', pct: q.promoterPct, color: '#a78bfa', prev: prev?.promoterPct },
          ].filter((x) => x.pct != null);
          shPanel.innerHTML = rows.map((b) => {
            let deltaHtml = '';
            if (b.prev != null && b.pct != null) {
              const d = Number(b.pct) - Number(b.prev);
              if (Math.abs(d) >= 0.01) {
                const up = d > 0;
                deltaHtml = `<span class="cs-sh-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${d.toFixed(2)}%</span>`;
              } else deltaHtml = `<span class="cs-sh-delta flat">— 0%</span>`;
            }
                return `<div class="cs-sh-row"><span class="cs-sh-k">${b.key}</span><div class="cs-sh-track"><div class="cs-sh-fill" style="width:${Math.min(100, Number(b.pct)||0)}%;background:${b.color}"></div></div><span class="cs-sh-v"><span class="cs-sh-pct">${Number(b.pct).toFixed(2)}%</span>${deltaHtml}</span></div>`;
          }).join('');
        });
      });
    }
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red)">${err.message || 'Study load nahi hui'}</p>`;
  }
}

async function loadFundamentals(symbol) {
  const box = document.getElementById('fundamentalsBox');
  box.innerHTML = '<p class="muted small">Loading fundamentals…</p>';
  try {
    const { fundamentals: f } = await api(`/stocks/${symbol}/fundamentals`);
    const pct = (v) => v === null || v === undefined ? '-' : `${(Number(v) * (Math.abs(Number(v)) <= 5 ? 100 : 1)).toFixed(1)}%`;
    // ROE etc are fractions 0.18; growth may be fraction too
    const pctFrac = (v) => v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(1)}%`;
    const num = (v, d = 2) => v === null || v === undefined ? '-' : Number(v).toFixed(d);
    const crore = (v) => {
      if (v === null || v === undefined) return '-';
      const cr = Number(v) / 1e7;
      return `₹${cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
    };
    const rows = [
      ['Sector / Industry', [f.sector, f.industry].filter(Boolean).join(' · ') || '-'],
      ['Market Cap', crore(f.marketCap)],
      ['P/E (TTM / Forward)', `${num(f.peTrailing, 1)} / ${num(f.peForward, 1)}`],
      ['EPS (TTM)', f.eps != null ? `₹${num(f.eps)}` : '-'],
      ['Book Value', f.bookValue != null ? `₹${num(f.bookValue)}` : '-'],
      ['P/B Ratio', num(f.priceToBook)],
      ['ROE', pctFrac(f.roe)],
      ['Profit Margin', pctFrac(f.profitMargin)],
      ['Debt to Equity', num(f.debtToEquity, 2)],
      ['Current Ratio', num(f.currentRatio, 2)],
      ['Dividend Yield', pctFrac(f.dividendYield)],
      ['Beta', num(f.beta)],
      ['52-Week Range', `₹${num(f.week52Low)} — ₹${num(f.week52High)}`],
      ['Revenue Growth (Yahoo YoY)', pctFrac(f.revenueGrowth)],
      ['Earnings Growth (Yahoo YoY)', pctFrac(f.earningsGrowth)],
      ['Rev QoQ (last 2Q)', pctFrac(f.revenueQoQ)],
      ['Profit QoQ (last 2Q)', pctFrac(f.profitQoQ)],
      ['Rev YoY (same Q)', pctFrac(f.revenueYoY)],
      ['Profit YoY (same Q)', pctFrac(f.profitYoY)],
      ['Analyst Consensus', f.recommendationKey ? f.recommendationKey.replace(/_/g, ' ') : '-'],
      ['Analyst Target', f.targetMeanPrice != null ? `₹${num(f.targetMeanPrice)}` : '-'],
    ];

    const q = f.quarterly || [];
    const qHtml = q.length ? `
      <div style="margin-top:14px; font-weight:600;">Financial performance (quarterly)</div>
      <div class="muted small" style="margin-bottom:6px;">Quarter label + revenue/profit/margin · QoQ = vs previous quarter (green up / red down)</div>
      <table class="indicator-table" style="width:100%; font-size:12px;">
        <tr>
          <th>Quarter</th>
          <th>Revenue</th>
          <th>QoQ</th>
          <th>Net profit</th>
          <th>QoQ</th>
          <th>OPM</th>
        </tr>
        ${q.map((row) => {
          const qLabel = row.label || row.endDate || '—';
          const fmtQ = (x) => {
            if (x == null || !Number.isFinite(Number(x))) return '—';
            const pct = Number(x) * 100;
            const sign = pct >= 0 ? '+' : '';
            const col = pct >= 0 ? 'var(--green,#3dd68c)' : 'var(--red,#f07178)';
            return `<span style="color:${col}">${sign}${pct.toFixed(1)}%</span>`;
          };
          const fmtPts = (x) => {
            if (x == null || !Number.isFinite(Number(x))) return '—';
            const sign = x >= 0 ? '+' : '';
            const col = x >= 0 ? 'var(--green,#3dd68c)' : 'var(--red,#f07178)';
            return `<span style="color:${col}">${sign}${Number(x).toFixed(1)} pt</span>`;
          };
          return `<tr>
            <td><b>${qLabel}</b></td>
            <td>${row.revenueCr != null ? '₹' + Number(row.revenueCr).toLocaleString('en-IN') + ' Cr' : crore(row.totalRevenue)}</td>
            <td>${fmtQ(row.revenueQoQ)}</td>
            <td>${row.profitCr != null ? '₹' + Number(row.profitCr).toLocaleString('en-IN') + ' Cr' : crore(row.netIncome)}</td>
            <td>${fmtQ(row.profitQoQ)}</td>
            <td>${row.opmPct != null ? Number(row.opmPct).toFixed(1) + '%' : '—'} ${row.opmChangePts != null ? '(' + fmtPts(row.opmChangePts) + ')' : ''}</td>
          </tr>`;
        }).join('')}
      </table>` : '<p class="muted small" style="margin-top:10px;">Quarterly income history not available on feed for this symbol.</p>';

    const sh = f.shareholding || {};
    const shHtml = `
      <div style="margin-top:14px; font-weight:600;">Shareholding (Yahoo major holders)</div>
      <table class="indicator-table" style="width:100%;">
        <tr><td>Insiders / Promoter-like</td><td>${pctFrac(sh.insidersPercent)}</td></tr>
        <tr><td>Institutions</td><td>${pctFrac(sh.institutionsPercent)}</td></tr>
        <tr><td>Institutions (float)</td><td>${pctFrac(sh.institutionsFloatPercent)}</td></tr>
        <tr><td>Institution count</td><td>${sh.institutionsCount ?? '—'}</td></tr>
      </table>
      <p class="muted small">NSE-style Promoter / DII / FII / Public split is not fully on Yahoo — this is the closest free feed.</p>`;

    const funds = [...(f.fundHolders || []), ...(f.institutionHolders || [])].slice(0, 10);
    const fundHtml = funds.length ? `
      <div style="margin-top:14px; font-weight:600;">Institution / fund holders (sample)</div>
      <table class="indicator-table" style="width:100%;">
        <tr><th>Name</th><th>% held</th><th>Report</th></tr>
        ${funds.map((o) => `<tr>
          <td>${o.name}</td>
          <td>${o.pctHeld != null ? pctFrac(o.pctHeld) : '—'}</td>
          <td class="muted small">${o.reportDate || '—'}</td>
        </tr>`).join('')}
      </table>` : '';

    box.innerHTML = `<table class="indicator-table" style="width:100%;">
      ${rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}
    </table>
    ${qHtml}
    ${shHtml}
    ${fundHtml}
    <p class="disclaimer">${f.dataNote || ''} Free data via Yahoo Finance — gaps on small/SME names. Not investment advice.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

function renderTradePlan(analysis) {
  const box = document.getElementById('tradePlanBox');
  const plan = analysis.tradePlan;
  const setup = analysis.setup;
  const zs = analysis.zoneState;

  let setupHtml = '';
  if (setup && setup.type) {
    const label = setup.type === 'reversal' ? '🔄 Reversal/bounce setup' : '📈 Momentum setup';
    setupHtml = `<div class="muted small" style="margin-bottom:10px;"><b>${label}</b> — ${setup.reason}</div>`;
  }

  if (!plan) {
    box.innerHTML = setupHtml + '<p class="muted small">Not enough data (support/resistance or ATR) to suggest a plan for this stock right now.</p>';
    return;
  }

  const zoneStateHtml = zs ? `
    <div class="verdict-badge ${ZONE_STATE_BADGE_CLASS[zs.state] || 'neutral'}" style="padding:5px 12px; margin-bottom:8px; display:inline-block;">${zs.label}</div>
    <div class="muted small" style="margin-bottom:10px;">${zs.reason}</div>
  ` : '';

  const timelineHtml = timelineBadge(analysis);

  const rr = plan.riskRewardRatio;
  const rrNote = rr === null ? ''
    : rr >= 2 ? `<span class="change up">1:${rr} risk-reward — solid</span>`
    : rr >= 1.3 ? `<span class="muted">1:${rr} risk-reward — acceptable</span>`
    : `<span class="change down">1:${rr} risk-reward — thin, weigh carefully</span>`;

  box.innerHTML = `
    ${setupHtml}
    ${zoneStateHtml}
    <table class="indicator-table" style="width:100%;">
      <tr><td>Entry range</td><td>₹${plan.entryLow} – ₹${plan.entryHigh}</td></tr>
      <tr><td>Stop-loss</td><td class="change down">₹${plan.stopLoss}</td></tr>
      <tr><td>Target</td><td class="change up">₹${plan.target}</td></tr>
      <tr><td>Risk : Reward</td><td>${rrNote}</td></tr>
    </table>
    ${timelineHtml ? `<div style="margin-top:8px;">${timelineHtml}</div>` : ''}
    <p class="muted small" style="margin-top:8px;">Basis: ${plan.basis}. Stop is placed just under the nearest real support (not an arbitrary number) so ordinary daily noise is less likely to shake you out; target sits just under the nearest resistance so it's a level price has actually struggled at before, not a wish.</p>
    <p class="disclaimer">⚠️ Still a rule-based estimate, not a guarantee — support/resistance can break, and price can gap past either level on news. Always confirm with your own judgement.</p>
  `;
}

function prefillRiskCalc(analysis) {
  const entryInput = document.getElementById('riskEntry');
  const stopInput = document.getElementById('riskStop');
  const price = analysis.price;
  const atr14 = analysis.indicators?.atr14;
  if (price) entryInput.value = price.toFixed(2);
  if (price && atr14) {
    const suggestedStop = price - 1.5 * atr14;
    stopInput.value = Math.max(suggestedStop, 0.01).toFixed(2);
    stopInput.title = `Suggested from ATR(14) = ₹${atr14.toFixed(2)} × 1.5 below entry`;
  } else {
    stopInput.value = '';
    stopInput.title = 'Not enough data for an ATR-based suggestion — enter your own stop-loss.';
  }
}

document.getElementById('riskCalcForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const capital = Number(document.getElementById('riskCapital').value);
  const riskPct = Number(document.getElementById('riskPercent').value);
  const entry = Number(document.getElementById('riskEntry').value);
  const stop = Number(document.getElementById('riskStop').value);
  const box = document.getElementById('riskCalcResult');

  if (!capital || !riskPct || !entry || !stop || stop >= entry) {
    box.innerHTML = `<p class="muted small" style="color:var(--red)">Check your inputs — stop-loss must be below entry price, and all fields required.</p>`;
    return;
  }

  const riskAmount = capital * (riskPct / 100);
  const riskPerShare = entry - stop;
  const quantity = Math.floor(riskAmount / riskPerShare);
  const positionValue = quantity * entry;
  const pctOfCapital = (positionValue / capital) * 100;
  const target2R = entry + riskPerShare * 2;
  const target3R = entry + riskPerShare * 3;

  if (quantity < 1) {
    box.innerHTML = `<p class="muted small" style="color:var(--amber)">Your stop-loss is too close to entry for this risk % — even 1 share would exceed your risk budget. Widen the stop or increase risk %.</p>`;
    return;
  }
  if (pctOfCapital > 100) {
    box.innerHTML = `<p class="muted small" style="color:var(--amber)">This position would need more than your total capital. Your stop-loss may be too tight relative to your risk % — the math wants a bigger position than you can afford.</p>`;
    return;
  }

  box.innerHTML = `
    <table class="indicator-table" style="width:100%;">
      <tr><td>Risk amount (this trade)</td><td>₹${riskAmount.toFixed(0)}</td></tr>
      <tr><td>Risk per share (entry − stop)</td><td>₹${riskPerShare.toFixed(2)}</td></tr>
      <tr><td><b>Suggested quantity</b></td><td><b>${quantity} shares</b></td></tr>
      <tr><td>Position value</td><td>₹${positionValue.toFixed(0)} (${pctOfCapital.toFixed(1)}% of capital)</td></tr>
      <tr><td>Target for 1:2 risk-reward</td><td class="change up">₹${target2R.toFixed(2)}</td></tr>
      <tr><td>Target for 1:3 risk-reward</td><td class="change up">₹${target3R.toFixed(2)}</td></tr>
    </table>
    <p class="disclaimer">A common rule of thumb is risking 0.5-2% of capital per trade so no single loss is ruinous — this doesn't guarantee profit, it just controls how much any one wrong call can cost you.</p>
  `;
});

async function loadNews(symbol) {
  const box = document.getElementById('newsList');
  const earningsBox = document.getElementById('earningsNote');
  box.innerHTML = '<p class="muted small">Loading news...</p>';
  earningsBox.innerHTML = '';
  try {
    const { news, events } = await api(`/stocks/${symbol}/context`);
    if (events && events.daysUntil !== null && events.daysUntil >= 0 && events.daysUntil <= 10) {
      earningsBox.innerHTML = `<div style="background:rgba(245,158,11,.12); border:1px solid var(--amber); border-radius:8px; padding:8px 10px; font-size:12px; color:var(--amber);">⚠️ Earnings expected around <b>${events.nextEarnings}</b> (${events.daysUntil} day${events.daysUntil === 1 ? '' : 's'} away) — results can gap the price hard in either direction. Worth factoring into your stop-loss/position size, or waiting till after.</div>`;
    }
    // full news list wants a bit more than the 2-headline context endpoint gives -
    // fetch the fuller list separately
    const { news: fullNews } = await api(`/stocks/${symbol}/news`);
    if (!fullNews.length) { box.innerHTML = '<p class="muted small">No recent news found for this symbol.</p>'; return; }
    box.innerHTML = fullNews.slice(0, 6).map((n) => `
      <div style="padding:8px 0; border-bottom:1px solid var(--border);">
        <a href="${n.link}" target="_blank" rel="noopener" style="color:var(--text); font-size:13px; text-decoration:none;">${n.title}</a>
        <div class="muted" style="font-size:11px; margin-top:2px;">${n.publisher || ''}${n.publishedAt ? ' · ' + new Date(n.publishedAt).toLocaleDateString() : ''}</div>
      </div>
    `).join('');
  } catch (err) {
    box.innerHTML = '<p class="muted small">Could not load news right now.</p>';
  }
}

function renderAnalysis(analysis, candles, marketContext, resetChart = true) {
  document.getElementById('symCompany').textContent = analysis.symbol;
  document.getElementById('symPrice').textContent = `₹${analysis.price?.toFixed(2) ?? '-'}`;

  if (marketContext) {
    const el = document.getElementById('marketContextNote');
    if (el) el.textContent = `Market context: Nifty 50 is currently ${marketContext.trend} (${marketContext.verdict})`;
  }

  const sectorEl = document.getElementById('sectorContextNote');
  if (sectorEl) {
    const sc = analysis.sectorContext;
    if (!sc) {
      sectorEl.textContent = '';
    } else if (sc.sectorTodayPct == null) {
      sectorEl.textContent = `Sector: ${sc.sector} (not enough tracked peers today for a sector average)`;
    } else {
      const alignmentNote = sc.alignment === 'with_sector' ? '— moving WITH its sector'
        : sc.alignment === 'against_sector' ? '⚠️ bucking the sector trend — worth a second look'
        : '— roughly in line with its sector';
      sectorEl.innerHTML = `🏢 Sector (${sc.sector}): <span class="change ${sc.sectorTodayPct >= 0 ? 'up' : 'down'}" style="display:inline;">${sc.sectorTodayPct >= 0 ? '+' : ''}${sc.sectorTodayPct}%</span> today (avg of ${sc.sectorStockCount} tracked peers) ${alignmentNote}`;
    }
  }

  const badge = document.getElementById('verdictBadge');
  badge.textContent = analysis.verdict;
  badge.className = 'verdict-badge ' + (analysis.verdict.toLowerCase().includes('bull') ? 'bullish'

    : analysis.verdict.toLowerCase().includes('bear') ? 'bearish' : 'neutral');

  document.getElementById('suggestedHorizon').textContent = analysis.suggestedHorizon.replace('_', ' ');

  const list = document.getElementById('factorList');
  list.innerHTML = '';
  analysis.factors.forEach((f) => {
    const li = document.createElement('li');
    li.className = f.signal;
    li.textContent = f.factor;
    list.appendChild(li);
  });

  const ind = analysis.indicators;
  const rows = [
    ['SMA 20', ind.sma20], ['SMA 50', ind.sma50], ['SMA 200', ind.sma200],
    ['EMA 9', ind.ema9], ['EMA 21', ind.ema21], ['RSI (14)', ind.rsi14],
    ['MACD Histogram', ind.macdHistogram], ['Avg Volume (20d)', ind.avgVol20],
    ['Volume Spike (x avg)', ind.volSpike], ['ATR (14)', ind.atr14], ['Avg Daily Range %', ind.avgRangePct],
  ];
  const table = document.getElementById('indicatorTable');
  table.innerHTML = rows.map(([label, val]) => `
    <tr><td>${label}</td><td>${val === null || val === undefined ? '-' : Number(val).toFixed(2)}</td></tr>
  `).join('');

  const pr = analysis.periodReturns || {};
  const prRows = [
    ['1 Day', pr.oneDay], ['1 Week', pr.oneWeek], ['15 Days', pr.fifteenDay], ['1 Month', pr.oneMonth],
    ['2 Months', pr.twoMonth], ['3 Months', pr.threeMonth], ['1 Year', pr.oneYear], ['5 Years', pr.fiveYear],
  ];
  document.getElementById('periodReturnsTable').innerHTML = prRows.map(([label, val]) => {
    if (val === null || val === undefined) return `<tr><td>${label}</td><td class="muted">not enough history</td></tr>`;
    const cls = val >= 0 ? 'up' : 'down';
    return `<tr><td>${label}</td><td class="change ${cls}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</td></tr>`;
  }).join('');

  const streakEl = document.getElementById('streakNote');
  const st = analysis.streak;
  if (st && st.days > 0) {
    const dirWord = st.direction === 'down' ? 'falling' : 'rising';
    const dirIcon = st.direction === 'down' ? '🔻' : '🔺';
    streakEl.innerHTML = `${dirIcon} <b>${st.days} day${st.days > 1 ? 's' : ''} straight ${dirWord}</b> (${st.dailyChangesPct.map(c => (c >= 0 ? '+' : '') + c + '%').join(', ')})`;
  } else {
    streakEl.innerHTML = '';
  }
  // The fuller recent back-and-forth, when there's more than one run to
  // show - e.g. "fell 6d then bounced 1d then fell 2d more" reads very
  // differently from just "down 2 days" (the current streak above).
  // Counts trading days only (Yahoo has no row for weekends/holidays).
  if (analysis.recentStreakPattern) {
    streakEl.innerHTML += `<div class="muted small" style="margin-top:2px;">Recent pattern (trading days only): ${analysis.recentStreakPattern}</div>`;
  }
  streakEl.innerHTML += dailyBreakdownToggle(analysis);

  // Weekly trend confirmation
  const wr = analysis.weeklyRead;
  const weeklyNote = document.getElementById('weeklyReadNote');
  weeklyNote.textContent = wr ? `Weekly chart read: ${wr.verdict}` : 'Not enough history for a weekly read.';

  // Support / Resistance
  const sr = analysis.supportResistance || { support: [], resistance: [] };
  const fmtLevel = (arr, cls) => arr.length
    ? arr.map((l) => `<div class="change ${cls}" style="margin-bottom:4px;">₹${l.level.toFixed(2)} <span class="muted" style="font-size:11px;">(touched ${l.strength}x)</span></div>`).join('')
    : '<div class="muted small">None found nearby</div>';
  document.getElementById('resistanceList').innerHTML = fmtLevel(sr.resistance, 'down');
  document.getElementById('supportList').innerHTML = fmtLevel(sr.support, 'up');

  // Candlestick patterns
  const patterns = analysis.candlePatterns || [];
  document.getElementById('candlePatternsBox').innerHTML = patterns.length
    ? patterns.map((p) => `<div style="margin-bottom:6px;"><b>${p.pattern}</b><div class="muted small">${p.note}</div></div>`).join('')
    : '<p class="muted small">No notable candlestick pattern on the latest candle.</p>';

  // Breakout engine - 20-day/52-week high breaks, consolidation breakouts,
  // retests, failed breakouts, and gap-up follow-through/fade.
  const breakoutBox = document.getElementById('breakoutBox');
  if (breakoutBox) {
    const bo = analysis.breakout;
    if (!bo || !bo.events?.length) {
      breakoutBox.innerHTML = '<div class="muted small">No breakout pattern on the latest candle.</div>';
    } else {
      breakoutBox.innerHTML = `
        <div class="muted small" style="margin-bottom:4px; font-weight:600;">⚡ Breakout signals</div>
        ${bo.events.map((e) => `
          <div style="margin-bottom:6px; padding:6px 8px; border-radius:6px; background:${e.confirmed ? 'rgba(34,197,94,.1)' : 'rgba(245,158,11,.1)'};">
            <b>${e.confirmed ? '✅' : '⚠️'} ${e.type.replace(/_/g, ' ')}</b>
            <div class="muted small">${e.detail}</div>
          </div>
        `).join('')}
      `;
    }
  }

  // Relative Strength vs Nifty 50 - is the stock beating or lagging the
  // index over the same window, and is that gap widening or narrowing.
  const rsBox = document.getElementById('relativeStrengthBox');
  if (rsBox) {
    const rs = analysis.relativeStrength;
    if (!rs || rs.status === 'unavailable') {
      rsBox.innerHTML = '<p class="muted small">Not enough data to compare against Nifty 50 right now.</p>';
    } else {
      const fmtRs = (v) => v == null ? '<span class="muted">-</span>' : `<span class="change ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v}%</span>`;
      const statusLabel = { improving: '📈 Improving vs Nifty', weakening: '📉 Weakening vs Nifty', neutral: '➖ Steady vs Nifty' }[rs.status] || '';
      rsBox.innerHTML = `
        <table class="indicator-table" style="width:100%;">
          <tr><td>1 Week RS</td><td>${fmtRs(rs.rs1W)}</td></tr>
          <tr><td>1 Month RS</td><td>${fmtRs(rs.rs1M)}</td></tr>
          <tr><td>3 Month RS</td><td>${fmtRs(rs.rs3M)}</td></tr>
        </table>
        <div class="muted small" style="margin-top:6px;">${statusLabel}${rs.rsBreakout ? ' · 🚀 <b>RS breakout</b> — was lagging Nifty over the past month but has swung to clearly outperforming this week, an early rotation signal.' : ''}</div>
        <p class="disclaimer">RS = this stock's return minus Nifty 50's return over the same window. Positive means it beat the index (even if its own return was negative), negative means it lagged (even if its own return was positive).</p>
      `;
    }
  }

  const activityNote = document.getElementById('activityNote');
  const vs = ind.volSpike;
  if (vs !== null && vs !== undefined) {
    if (vs > 1.5) {
      const direction = (analysis.factors.some(f => f.factor.includes('above 20-day')) ) ? 'buying' : 'activity';
      activityNote.innerHTML = `🔥 Volume is <b>${vs.toFixed(1)}x</b> the 20-day average today — noticeably more ${direction} interest than usual.`;
    } else if (vs < 0.5) {
      activityNote.innerHTML = `😴 Volume is only <b>${vs.toFixed(1)}x</b> the 20-day average — quiet trading, low participation today.`;
    } else {
      activityNote.innerHTML = `Volume is roughly normal today (${vs.toFixed(1)}x the 20-day average).`;
    }
  } else {
    activityNote.textContent = 'Not enough volume history to gauge activity.';
  }

  const labels = candles.map((c) => {
    const d = new Date(c.date);
    if (Number.isNaN(d.getTime())) return String(c.date || '');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  });
  const closes = candles.map((c) => c.close);
  // Only (re)claim the chart for the default "max" range on a fresh symbol
  // load - a periodic silent refresh while the person has picked a
  // different range (or the live "1D" chart) shouldn't yank them back.
  if (resetChart || currentChartRange === 'max') {
    currentChartRange = 'max';
    chartCandles = candles;
    document.querySelectorAll('.chart-range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === 'max'));
    document.querySelector('.chart-live-dot')?.classList.add('hidden');
    const priceChartTitleEl = document.getElementById('priceChartTitle');
    if (priceChartTitleEl) priceChartTitleEl.textContent = 'Price chart';
    updateChartRangeSummary(candles, 'max');
    renderSvgLineChart('priceChartCanvas', labels, [{ data: closes, color: '#3ea6ff', fill: true }], { height: 280, autoColor: true });
  }
}


function fundShBadge(fundamentals) {
  if (!fundamentals) return '';
  const sh = fundamentals.shareholdingSummary;
  const bits = [];
  if (fundamentals.peTrailing != null) bits.push(`PE ${Number(fundamentals.peTrailing).toFixed(1)}`);
  if (fundamentals.roe != null) {
    const roe = fundamentals.roe <= 1.5 ? fundamentals.roe * 100 : fundamentals.roe;
    bits.push(`ROE ${Number(roe).toFixed(0)}%`);
  }
  if (sh) {
    if (sh.fiiDelta != null) bits.push(`FII ${sh.fiiDelta >= 0 ? '+' : ''}${sh.fiiDelta}%`);
    if (sh.diiDelta != null) bits.push(`DII ${sh.diiDelta >= 0 ? '+' : ''}${sh.diiDelta}%`);
  }
  if (!bits.length) return '';
  return `<div class="fund-sh-badge">${bits.map((b) => `<span>${b}</span>`).join('')}</div>`;
}

function updateChartRangeSummary(candles, rangeKey) {
  const el = document.getElementById('chartRangeSummary');
  const hover = document.getElementById('chartHoverReadout');
  if (!el) return;
  const closes = (candles || []).map((c) => c.close).filter((v) => v != null && !isNaN(v));
  if (closes.length < 2) {
    el.innerHTML = '';
    if (hover) { hover.dataset.idle = ''; hover.textContent = ''; }
    return;
  }
  const first = closes[0];
  const last = closes[closes.length - 1];
  const dlt = last - first;
  const pct = first !== 0 ? (dlt / first) * 100 : 0;
  const cls = dlt >= 0 ? 'cs-pos' : 'cs-neg';
  const label = (CHART_RANGE_TITLES && CHART_RANGE_TITLES[rangeKey]) ? rangeKey.toUpperCase() : (rangeKey || '').toUpperCase();
  el.innerHTML = `<span class="crs-price">₹${last.toFixed(2)}</span> <span class="${cls}">${dlt >= 0 ? '+' : ''}${dlt.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span> <span class="crs-range">${label}</span>`;
  if (hover) {
    hover.dataset.idle = 'Hover chart for date · price';
    hover.textContent = hover.dataset.idle;
    hover.classList.remove('chart-hover-active');
  }
}

const CHART_RANGE_TITLES = {
  '1d': 'Today (live)', '2d': 'Last 2 days', '3d': 'Last 3 days', '4d': 'Last 4 days', '5d': 'Last 5 days',
  '1w': 'Last 1 week', '15d': 'Last 15 days', '1mo': 'Last 1 month', '3mo': 'Last 3 months',
  '6mo': 'Last 6 months', '1y': 'Last 1 year', '3y': 'Last 3 years', '5y': 'Last 5 years',
  'max': 'Max history (~5–25Y)',
};

async function loadPriceChartRange(symbol, range) {
  currentChartRange = range;
  document.querySelectorAll('.chart-range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
  document.querySelector('.chart-live-dot')?.classList.toggle('hidden', range !== '1d');
  const titleEl = document.getElementById('priceChartTitle');
  const canvas = document.getElementById('priceChartCanvas');
  canvas.innerHTML = '<p class="muted small">Loading chart...</p>';
  try {
    const { candles, isIntraday } = await api(`/stocks/${symbol}/chart?range=${range}`);
    chartCandles = candles;
    if (titleEl) titleEl.textContent = `Price chart (${CHART_RANGE_TITLES[range] || range})`;
    const labels = candles.map((c) => {
      const d = new Date(c.date);
      if (Number.isNaN(d.getTime())) return String(c.date || '');
      if (isIntraday) {
        return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      }
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    });
    const closes = candles.map((c) => c.close);
    updateChartRangeSummary(candles, range);
    renderSvgLineChart('priceChartCanvas', labels, [{ data: closes, color: '#3ea6ff', fill: true }], { height: 280, autoColor: true });
  } catch (err) {
    canvas.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

document.getElementById('chartRangeBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.chart-range-btn');
  if (!btn || !CURRENT_SYMBOL) return;
  loadPriceChartRange(CURRENT_SYMBOL, btn.dataset.range);
});

function subscribeLive(symbol) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', symbol })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'quote' && msg.symbol === CURRENT_SYMBOL) updateLivePrice(msg.quote);
    });
  } else {
    ws.send(JSON.stringify({ type: 'subscribe', symbol }));
  }
}

function updateLivePrice(quote) {
  document.getElementById('symPrice').textContent = `₹${Number(quote.lastPrice).toFixed(2)}`;
  const chEl = document.getElementById('symChange');
  const pc = (typeof dayChangePctFromQuote === 'function' ? dayChangePctFromQuote(quote) : null) ?? Number(quote.pChange || 0);
  chEl.textContent = `${pc >= 0 ? '+' : ''}${Number(pc).toFixed(2)}%`;
  chEl.className = 'change ' + (pc >= 0 ? 'up' : 'down');
  const dot = document.getElementById('liveDot');
  if (dot && quote.source) dot.title = `Live via ${quote.source}${quote.asOf ? ' — ' + new Date(quote.asOf).toLocaleTimeString() : ''}`;

  // Keep the "1D" chart genuinely live - every tick nudges on a new point,
  // so the chart visibly moves instead of only the number at the top
  // changing. Capped so this can run all session without the array (and
  // the SVG being redrawn) growing without bound.
  if (currentChartRange === '1d' && quote.lastPrice != null) {
    chartCandles = [...chartCandles, { date: new Date().toISOString(), close: Number(quote.lastPrice) }].slice(-400);
    const labels = chartCandles.map((c) => new Date(c.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
    const closes = chartCandles.map((c) => c.close);
    renderSvgLineChart('priceChartCanvas', labels, [{ data: closes, color: '#3ea6ff', fill: true }], { height: 280, autoColor: true });
  }
}

// ---------- watchlist ----------
document.getElementById('addWatchBtn').addEventListener('click', async () => {
  if (!CURRENT_SYMBOL) return;
  const horizon = document.getElementById('watchHorizon').value;
  try {
    await api('/watchlist', { method: 'POST', body: JSON.stringify({ symbol: CURRENT_SYMBOL, horizon }) });
    toast(`${CURRENT_SYMBOL} added to watchlist`);
    loadWatchlist();
  } catch (err) { toast(err.message); }
});

async function loadWatchlist() {
  if (!TOKEN) return;
  try {
    const { watchlist } = await api('/watchlist');
    const grid = document.getElementById('watchlistGrid');
    grid.innerHTML = watchlist.length ? '' : '<p class="muted">No stocks yet — search and add one.</p>';
    watchlist.forEach((w) => {
      const div = document.createElement('div');
      div.className = 'list-item';
      const verdictHtml = w.last_verdict
        ? `<span class="verdict-badge ${verdictClass(w.last_verdict)}" style="padding:2px 8px; font-size:11px;">${w.last_verdict}</span>`
        : `<span class="muted small">not checked yet</span>`;
      div.innerHTML = `
        <div class="row"><span class="sym">${w.symbol}</span><span class="tag">${w.horizon.replace('_', ' ')}</span></div>
        <div class="row">${verdictHtml}<button class="small" data-symbol="${w.symbol}">Remove</button></div>
        ${w.note ? `<div class="muted small">${w.note}</div>` : ''}
        ${w.last_checked_at ? `<div class="muted" style="font-size:10px; margin-top:4px;">Checked ${new Date(w.last_checked_at).toLocaleString()}</div>` : ''}
      `;
      div.querySelector('.sym').addEventListener('click', () => loadSymbol(w.symbol));
      div.querySelector('button').addEventListener('click', async () => {
        await api(`/watchlist/${w.symbol}`, { method: 'DELETE' });
        loadWatchlist();
      });
      grid.appendChild(div);
    });
  } catch (err) { /* not logged in yet */ }
}

document.getElementById('refreshWatchlistBtn').addEventListener('click', async (e) => {
  e.target.textContent = 'Refreshing...';
  e.target.disabled = true;
  try {
    await api('/watchlist/refresh', { method: 'POST' });
    await loadWatchlist();
    toast('Watchlist updated');
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.textContent = 'Refresh now';
    e.target.disabled = false;
  }
});

// ---------- alerts ----------
document.getElementById('quickAlertForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const condition = document.getElementById('quickAlertCondition').value;
  const targetPrice = document.getElementById('quickAlertPrice').value;
  try {
    await api('/alerts', { method: 'POST', body: JSON.stringify({ symbol: CURRENT_SYMBOL, condition, targetPrice }) });
    toast('Alert created');
    document.getElementById('quickAlertPrice').value = '';
    loadAlerts();
  } catch (err) { toast(err.message); }
});

async function loadAlerts() {
  if (!TOKEN) return;
  try {
    const { alerts } = await api('/alerts');
    const grid = document.getElementById('alertsGrid');
    grid.innerHTML = alerts.length ? '' : '<p class="muted">No alerts yet.</p>';
    alerts.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row"><span class="sym">${a.symbol}</span><span class="tag">${a.is_active ? 'active' : 'triggered'}</span></div>
        <div class="row"><span class="muted">Price ${a.condition} ₹${a.target_price}</span><button class="small">Remove</button></div>
      `;
      div.querySelector('button').addEventListener('click', async () => {
        await api(`/alerts/${a.id}`, { method: 'DELETE' });
        loadAlerts();
      });
      grid.appendChild(div);
    });
  } catch (err) { /* ignore */ }
}

// ---------- journal ----------
document.getElementById('quickJournalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const side = document.getElementById('journalSide').value;
  const quantity = document.getElementById('journalQty').value;
  const price = document.getElementById('journalPrice').value;
  const horizon = document.getElementById('journalHorizon').value;
  const reason = document.getElementById('journalReason').value;
  const stopLoss = document.getElementById('journalStopLoss').value;
  const target = document.getElementById('journalTarget').value;
  try {
    await api('/journal', { method: 'POST', body: JSON.stringify({ symbol: CURRENT_SYMBOL, side, quantity, price, horizon, reason, stopLoss, target }) });
    toast('Trade logged');
    e.target.reset();
    loadJournal();
    loadPositions();
    loadPortfolio();
  } catch (err) { toast(err.message); }
});

// Trade Journal (all trades) - every entry shown with full context: how
// much was actually put in, where it stands right now (live price + P&L
// for open trades, realized P&L for closed ones), not just the bare
// symbol/qty/price line this used to be. Pulls /journal/manage in
// parallel purely to reuse its already-fetched live price + hold/exit
// verdict for OPEN entries - no separate live-quote logic duplicated here.
async function loadJournal() {
  if (!TOKEN) return;
  try {
    const [{ entries }, manageData] = await Promise.all([
      api('/journal'),
      api('/journal/manage').catch(() => ({ positions: [] })),
    ]);
    const liveById = Object.fromEntries((manageData.positions || []).map((p) => [p.id, p]));

    const grid = document.getElementById('journalGrid');
    grid.innerHTML = entries.length ? '' : '<p class="muted">No trades logged yet — use "✓ Maine ye liya" on any pick, or log one manually below.</p>';
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
    const fmtRupees = (n) => `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

    entries.forEach((j) => {
      const invested = j.quantity * j.price;
      const div = document.createElement('div');
      div.className = 'list-item journal-item';

      let bodyHtml;
      if (j.status === 'open') {
        const live = liveById[j.id];
        const currentPrice = live?.currentPrice ?? null;
        const pnlPct = live?.pnlPct ?? null;
        const pnlAmount = pnlPct !== null ? (pnlPct / 100) * invested : null;
        const pnlCls = pnlAmount === null ? '' : (pnlAmount >= 0 ? 'up' : 'down');
        bodyHtml = `
          <div class="journal-row"><span class="muted">Invested</span><b>${fmtRupees(invested)}</b> <span class="muted small">(${j.quantity} × ₹${j.price})</span></div>
          <div class="journal-row"><span class="muted">Current price</span><b>${currentPrice !== null ? '₹' + currentPrice.toFixed(2) : 'unavailable'}</b></div>
          <div class="journal-row"><span class="muted">Unrealized P&amp;L</span>${pnlAmount === null ? '<span class="muted">-</span>' : `<b class="change ${pnlCls}" style="display:inline;">${pnlAmount >= 0 ? '+' : '-'}${fmtRupees(pnlAmount)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</b>`}</div>
          ${j.stop_loss ? `<div class="journal-row"><span class="muted">Stop-loss</span>₹${j.stop_loss}</div>` : ''}
          ${j.target ? `<div class="journal-row"><span class="muted">Target</span>₹${j.target}${live?.target2 ? ` <span class="muted small">(T2 ₹${live.target2})</span>` : ''}</div>` : ''}
          <div class="journal-row"><span class="muted">Entered</span>${fmtDate(j.trade_date)}</div>
          ${live?.daysSinceEntry != null ? `<div class="journal-row"><span class="muted">${live.predictedWindowDays ? `Day ${live.daysSinceEntry} · usually resolves in ~${live.predictedWindowDays}d` : `Day ${live.daysSinceEntry} since entry`}</span></div>` : ''}
          ${live?.action ? `<div style="margin-top:6px;"><span class="journal-action-badge ${live.action === 'HOLD' ? 'hold' : live.action === 'TARGET HIT' ? 'target-hit-blink hold' : 'exit'}">${live.action === 'TARGET HIT' ? '🎯 ' : ''}${live.action}</span></div>` : ''}
        `;
      } else {
        const pnlAmount = j.side === 'buy' ? (j.exit_price - j.price) * j.quantity : (j.price - j.exit_price) * j.quantity;
        const pnlPct = (pnlAmount / invested) * 100;
        const pnlCls = pnlAmount >= 0 ? 'up' : 'down';
        bodyHtml = `
          <div class="journal-row"><span class="muted">Invested</span><b>${fmtRupees(invested)}</b> <span class="muted small">(${j.quantity} × ₹${j.price})</span></div>
          <div class="journal-row"><span class="muted">Exited at</span><b>₹${j.exit_price}</b></div>
          <div class="journal-row"><span class="muted">Realized P&amp;L</span><b class="change ${pnlCls}" style="display:inline;">${pnlAmount >= 0 ? '+' : '-'}${fmtRupees(pnlAmount)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</b></div>
          <div class="journal-row"><span class="muted">Entered</span>${fmtDate(j.trade_date)}</div>
          <div class="journal-row"><span class="muted">Closed</span>${fmtDate(j.exit_date)}</div>
        `;
      }

      div.innerHTML = `
        <div class="row">
          <span class="sym">${j.symbol}</span>
          <span class="tag ${j.side === 'buy' ? 'tag-buy' : 'tag-sell'}">${j.side.toUpperCase()} · ${j.horizon.replace('_', ' ')}</span>
        </div>
        <div class="journal-body">${bodyHtml}</div>
        ${j.reason ? `<div class="muted small" style="margin-top:6px;">${j.reason}</div>` : ''}
        <div class="row" style="margin-top:10px;">
          ${j.status === 'open' ? '<button class="small close-btn">Close position</button>' : '<span class="tag">closed</span>'}
          <button class="small delete-btn" title="Delete this journal entry">🗑</button>
        </div>
      `;
      const closeBtn = div.querySelector('.close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', async () => {
          const exitPrice = prompt('Exit price?');
          if (!exitPrice) return;
          await api(`/journal/${j.id}/close`, { method: 'POST', body: JSON.stringify({ exitPrice }) });
          loadJournal();
          loadPositions();
          loadPortfolio();
        });
      }
      div.querySelector('.delete-btn').addEventListener('click', async () => {
        if (!confirm(`Delete this ${j.symbol} journal entry? This can't be undone.`)) return;
        await api(`/journal/${j.id}`, { method: 'DELETE' });
        loadJournal();
        loadPositions();
        loadPortfolio();
      });
      grid.appendChild(div);
    });
  } catch (err) { /* ignore */ }
}

document.getElementById('refreshPositionsBtn').addEventListener('click', loadPositions);

async function loadPortfolio() {
  if (!TOKEN) return;
  const box = document.getElementById('portfolioOverview');
  box.innerHTML = '<p class="muted small">Loading...</p>';
  try {
    const data = await api('/journal/portfolio');
    if (!data.totals) { box.innerHTML = '<p class="muted small">No open positions yet.</p>'; return; }
    const t = data.totals;
    const pnlCls = t.totalPnlAmount >= 0 ? 'up' : 'down';
    let html = `
      <div class="card">
        <table class="indicator-table" style="width:100%;">
          <tr><td>Total invested</td><td>₹${t.totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td></tr>
          <tr><td>Current value</td><td>₹${t.totalCurrentValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td></tr>
          <tr><td><b>Total P&amp;L</b></td><td class="change ${pnlCls}"><b>${t.totalPnlAmount >= 0 ? '+' : ''}₹${t.totalPnlAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${t.totalPnlPct >= 0 ? '+' : ''}${t.totalPnlPct.toFixed(2)}%)</b></td></tr>
        </table>
    `;
    if (data.warnings.length) {
      html += data.warnings.map((w) => `<p class="muted small" style="color:var(--amber); margin-top:10px;">⚠️ ${w}</p>`).join('');
    }
    if (data.sectorBreakdown.length) {
      html += `<div class="muted small" style="margin-top:14px; margin-bottom:6px;">Sector breakdown</div>`;
      html += data.sectorBreakdown.map((s) => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-size:13px;">${s.sector}</span>
          <span style="font-size:13px;">${s.pctOfPortfolio.toFixed(0)}%</span>
        </div>
        <div style="background:var(--panel-2); border-radius:4px; height:6px; margin-bottom:8px;">
          <div style="background:${s.pctOfPortfolio > 40 ? 'var(--amber)' : 'var(--accent)'}; width:${Math.min(s.pctOfPortfolio, 100)}%; height:100%; border-radius:4px;"></div>
        </div>
      `).join('');
    }
    html += '</div>';
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

const ACTION_COLOR = { EXIT: 'bearish', 'CONSIDER EXIT': 'neutral', 'TARGET HIT': 'bullish', HOLD: 'bullish' };

async function loadPositions() {
  if (!TOKEN) return;
  const grid = document.getElementById('positionsGrid');
  grid.innerHTML = '<p class="muted small">Checking open positions against live data...</p>';
  try {
    const { positions } = await api('/journal/manage');
    if (!positions.length) { grid.innerHTML = '<p class="muted small">No open positions. Log a trade from any stock\'s Analysis page.</p>'; return; }

    grid.innerHTML = '';
    positions.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'card';
      div.style.marginBottom = '12px';
      if (p.error) {
        div.innerHTML = `<h3>${p.symbol}</h3><p class="muted small">${p.error}</p>`;
        grid.appendChild(div);
        return;
      }
      const pnlCls = p.pnlPct >= 0 ? 'up' : 'down';
      const badgeCls = ACTION_COLOR[p.action] || 'neutral';
      const isTargetHit = p.action === 'TARGET HIT';
      const windowNote = p.predictedWindowDays
        ? `<div class="muted small" style="margin-top:2px;">Day ${p.daysSinceEntry} since entry · historically often resolves within ~${p.predictedWindowDays}d</div>`
        : (p.daysSinceEntry != null ? `<div class="muted small" style="margin-top:2px;">Day ${p.daysSinceEntry} since entry</div>` : '');
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
          <div>
            <h3 style="margin-bottom:4px;">${p.symbol} <span class="muted" style="font-weight:normal; font-size:12px;">${p.side} · ${p.quantity} @ ₹${p.entryPrice} · ${p.horizon.replace('_',' ')}</span></h3>
            <div class="muted small">Entry: ${p.tradeDate.slice(0,10)}${p.stopLoss ? ` · SL ₹${p.stopLoss}` : ''}${p.target ? ` · Target ₹${p.target}` : ''}${p.target2 ? ` · Target 2 ₹${p.target2}` : ''}</div>
            ${windowNote}
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px; font-weight:700;">₹${p.currentPrice.toFixed(2)}</div>
            <div class="change ${pnlCls}">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%</div>
          </div>
        </div>
        <div class="verdict-badge ${badgeCls} ${isTargetHit ? 'target-hit-blink' : ''}" style="margin-top:10px;">${isTargetHit ? '🎯 ' : ''}${p.action}</div>
        <p class="small" style="margin:8px 0 0;">${p.reason}</p>
        ${p.topFactors.length ? `<ul class="factor-list" style="margin-top:8px;">${p.topFactors.map(f => `<li class="${f.signal}">${f.factor}</li>`).join('')}</ul>` : ''}
      `;
      grid.appendChild(div);
    });
  } catch (err) {
    grid.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

// ---------- bulk screener ----------
document.getElementById('screenerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('screenerInput').value;
  const symbols = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return;
  const status = document.getElementById('screenerStatus');
  const box = document.getElementById('screenerResults');
  document.getElementById('screenerControls').classList.add('hidden');
  document.getElementById('screenerTopPicksBox').innerHTML = '';
  document.getElementById('screenerSwingSetupsBox').innerHTML = '';
  status.innerHTML = progressBarHtml(`Analyzing ${symbols.length} symbol(s) (incl. 5-year history)... this can take a bit.`);
  box.innerHTML = '';
  const jobId = makeJobId();
  const stopPolling = startProgressPolling(status, jobId);
  try {
    const { results, marketContext } = await api(`/stocks/bulk-analysis?jobId=${jobId}`, { method: 'POST', body: JSON.stringify({ symbols }) });
    stopPolling();
    currentScreenerResults = results;
    currentScreenerMarketContext = marketContext;
    status.textContent = `Done — ${results.filter(r => !r.error).length}/${results.length} analyzed successfully.`;
    document.getElementById('screenerControls').classList.remove('hidden');
    document.getElementById('screenerStreakSelect').value = '';
    screenerSortState = { key: 'score', dir: 'desc' };
    applyScreenerFilter();
  } catch (err) {
    stopPolling();
    status.textContent = err.message;
  }
});

function applyScreenerFilter() {
  const streakFilter = document.getElementById('screenerStreakSelect').value;
  const list = currentScreenerResults.filter((r) => passesStreakFilter(r, streakFilter));
  renderIndexTable(list, 'screenerResults', screenerSortState);
  renderTopPicks(currentScreenerResults, 'screenerTopPicksBox', currentScreenerMarketContext);
  renderGoldenSetups(currentScreenerResults, 'screenerGoldenSetupsBox');
  renderSwingSetups(currentScreenerResults, 'screenerSwingSetupsBox', 'any', currentScreenerMarketContext);
}

document.getElementById('screenerStreakSelect').addEventListener('change', applyScreenerFilter);

function verdictClass(verdict) {
  if (!verdict) return 'neutral';
  const v = verdict.toLowerCase();
  return v.includes('bull') ? 'bullish' : v.includes('bear') ? 'bearish' : 'neutral';
}


document.getElementById('csvImportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const symbol = document.getElementById('csvSymbol').value;
  const csv = document.getElementById('csvData').value;
  try {
    const { analysis, candles } = await api('/stocks/import-csv', { method: 'POST', body: JSON.stringify({ symbol, csv }) });
    renderImportResult(symbol.toUpperCase(), analysis, candles);
    toast('Data analyzed');
  } catch (err) {
    toast(err.message);
  }
});

function renderImportResult(symbol, analysis, candles) {
  const box = document.getElementById('importResults');
  const factorsHtml = analysis.factors.map(f => `<li class="${f.signal}">${f.factor}</li>`).join('');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.marginTop = '12px';
  div.innerHTML = `
    <h3>${symbol} — imported data result</h3>
    <div class="verdict-badge ${verdictClass(analysis.verdict)}">${analysis.verdict}</div>
    <div class="muted small">Suggested horizon: ${analysis.suggestedHorizon.replace('_',' ')} · Latest price: ₹${analysis.price?.toFixed(2) ?? '-'}</div>
    ${analysis.note ? `<p class="muted small">${analysis.note}</p>` : ''}
    <ul class="factor-list">${factorsHtml}</ul>
    <p class="disclaimer">⚠️ Educational technical read only — not financial advice.</p>
  `;
  box.prepend(div);
}

// ---------- import: screenshot upload ----------
(async function checkScreenshotStatus() {
  try {
    const data = await api('/import/status');
    const msg = document.getElementById('screenshotStatusMsg');
    msg.textContent = data.screenshotAnalysisEnabled
      ? 'Upload one or more screenshots (chart, watchlist, price table) — data will be extracted and analyzed automatically.'
      : 'Screenshot analysis is off — add ANTHROPIC_API_KEY to your .env to enable it. (CSV paste above still works fully.)';
  } catch { /* ignore */ }
})();

document.getElementById('screenshotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = document.getElementById('screenshotInput').files;
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('images', f);
  toast('Uploading & extracting...');
  try {
    const res = await fetch(`${API}/import/screenshot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    renderScreenshotResults(data.results);
  } catch (err) {
    toast(err.message);
  }
});

function renderScreenshotResults(results) {
  const box = document.getElementById('importResults');
  results.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'card';
    div.style.marginTop = '12px';
    if (r.error) {
      div.innerHTML = `<h3>${r.filename}</h3><p class="muted">${r.error}</p>`;
      box.prepend(div);
      return;
    }
    const ex = r.extracted;
    let inner = `<h3>${r.filename} — ${ex.symbol || 'extracted data'}</h3>`;
    if (ex.currentPrice != null) inner += `<div class="price">₹${ex.currentPrice} ${ex.changePercent != null ? `<span class="change ${ex.changePercent >= 0 ? 'up' : 'down'}">${ex.changePercent}%</span>` : ''}</div>`;
    if (r.analysis) {
      const factorsHtml = r.analysis.factors.map(f => `<li class="${f.signal}">${f.factor}</li>`).join('');
      inner += `
        <div class="verdict-badge ${verdictClass(r.analysis.verdict)}">${r.analysis.verdict}</div>
        <div class="muted small">Suggested horizon: ${r.analysis.suggestedHorizon.replace('_',' ')}</div>
        <ul class="factor-list">${factorsHtml}</ul>
        <p class="disclaimer">⚠️ Educational technical read only — not financial advice.</p>
      `;
    } else if (r.note) {
      inner += `<p class="muted small">${r.note}</p>`;
    }
    div.innerHTML = inner;
    box.prepend(div);
  });
}


// ---------- institutional money intelligence (UI only; APIs unchanged) ----------
let _instOverview = null;
let _instPeriod = '1M';

function instFmtCr(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  const body = abs >= 1000 ? (v / 1000).toFixed(2) + 'k' : v.toFixed(1);
  return (v > 0 ? '+' : '') + body;
}
function instCls(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n) >= 0 ? 'pos' : 'neg';
}

async function loadInstitutionalDashboard() {
  const cards = document.getElementById('instTopCards');
  const sent = document.getElementById('instSentimentBar');
  const fresh = document.getElementById('instFreshness');
  const honesty = document.getElementById('instHonesty');
  const tabs = document.getElementById('instPeriodTabs');
  const flow = document.getElementById('instFlowBars');
  if (!cards) return;
  cards.innerHTML = '<span class="spin"></span>';
  try {
    const data = await api('/institutional/overview');
    _instOverview = data;
    const periods = data.periods || {};
    const p = periods[_instPeriod] || periods['1M'] || {};
    const latest = data.latestDay || {};
    const sentObj = data.sentiment || {};

    if (fresh) {
      const src = latest.source || 'NSE';
      const dt = latest.date || p.to || '—';
      const asOf = data.asOf ? new Date(data.asOf).toLocaleString('en-IN') : '';
      fresh.innerHTML = `Source: <b>${src}</b> · Last flow day <b>${dt}</b>${asOf ? ` · UI ${asOf}` : ''}<br><span title="Daily trading flow vs monthly holdings">Class: ${data.dataClass?.dailyFlow || 'Daily NSE FII/DII'}</span>`;
    }

    if (sent) {
      const lab = sentObj.label || 'Mixed';
      const sig = sentObj.institutionalSignal || 'Neutral';
      const cls = /Bullish|Accumulation/i.test(sig) ? 'bullish' : /Bearish|Distribution/i.test(sig) ? 'bearish' : 'neutral';
      sent.innerHTML = `
        <span class="verdict-badge ${cls}" style="padding:4px 12px;">🧠 ${lab} · ${sig}</span>
        <span class="muted small" title="${sentObj.basis || ''}">${sentObj.basis || 'Based on FII/DII daily cash flow'}</span>
        <span class="muted small">Latest day: FII ${instFmtCr(latest.fiiNetCr)} · DII ${instFmtCr(latest.diiNetCr)} · Total ${instFmtCr(latest.totalNetCr)}</span>
      `;
    }

    const periodKeys = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y'];
    if (tabs) {
      tabs.innerHTML = periodKeys.map((k) =>
        `<button type="button" class="golden-tier-tab ${_instPeriod === k ? 'active' : ''}" data-inst-p="${k}">${k}</button>`
      ).join('');
      tabs.querySelectorAll('[data-inst-p]').forEach((btn) => {
        btn.addEventListener('click', () => {
          _instPeriod = btn.dataset.instP;
          loadInstitutionalDashboard();
        });
      });
    }

    const row = periods[_instPeriod] || p;
    cards.innerHTML = [
      { k: 'FII Net', v: row.fiiNetCr, tip: 'Foreign Institutional / FPI cash-market net (₹ Cr) for period' },
      { k: 'DII Net', v: row.diiNetCr, tip: 'Domestic Institutional Investors — includes banks, insurance, MFs (SEBI class)' },
      { k: 'MF Net', v: null, tip: 'Stock/category MF net not available free — DII is the proxy' },
      { k: 'Total Institutional', v: row.totalInstitutionalCr, tip: 'FII + DII net for period (daily flow, not holdings)' },
    ].map((c) => `
      <div class="inst-card" title="${c.tip}">
        <div class="k">${c.k} · ${_instPeriod}</div>
        <div class="v ${instCls(c.v)}">${c.v == null ? 'Not available' : instFmtCr(c.v)}</div>
        <div class="sub">${c.v == null ? 'See honesty note' : `₹ Cr · ${row.tradingDays || 0} sessions`}</div>
      </div>
    `).join('');

    // Flow bars FII/DII buy vs sell
    if (flow) {
      const mk = (label, buy, sell) => {
        const b = Math.max(0, Number(buy) || 0);
        const s = Math.max(0, Number(sell) || 0);
        const t = b + s || 1;
        return `<div class="inst-flow-row">
          <span style="width:36px;">${label}</span>
          <div class="inst-flow-bar" title="Buy ${b} / Sell ${s} ₹Cr">
            <div class="in" style="width:${(b / t) * 100}%"></div>
            <div class="out" style="width:${(s / t) * 100}%"></div>
          </div>
          <span class="muted small">In ${instFmtCr(b)} · Out ${instFmtCr(-s)}</span>
        </div>`;
      };
      const moneyIn = (Number(row.fiiNetCr) || 0) + (Number(row.diiNetCr) || 0) >= 0;
      flow.innerHTML = `
        <div class="muted small" style="margin-bottom:8px;">
          ${moneyIn ? '🟢 Money Coming In (period net +)' : '🔴 Money Going Out (period net −)'} · ${_instPeriod}
        </div>
        ${mk('FII', row.fiiBuyCr, row.fiiSellCr)}
        ${mk('DII', row.diiBuyCr, row.diiSellCr)}
        <div class="muted small" style="margin-top:8px;">Green = buy value share · Red = sell value share (same period totals)</div>
      `;
    }

    if (honesty) {
      honesty.innerHTML = `
        <div><b>Daily / live flow:</b> ${data.dataClass?.dailyFlow || 'NSE FII-DII'}</div>
        <div><b>Bulk deals:</b> ${data.dataClass?.bulkDeals || 'NSE bulk disclosures'}</div>
        <div><b>Holdings / MF stock-level:</b> ${data.mutualFunds?.status === 'not_available' ? 'Not available (not invented)' : '—'}</div>
        <div style="margin-top:6px;">${data.mutualFunds?.reason || ''}</div>
        <div style="margin-top:4px;">${data.shareholding?.reason || ''}</div>
      `;
    }

    // Keep legacy boxes filled if present
    const ov = document.getElementById('fiiDiiOverview');
    if (ov) {
      ov.innerHTML = `<div class="muted small">Use cards above · period ${_instPeriod}: FII ${instFmtCr(row.fiiNetCr)} · DII ${instFmtCr(row.diiNetCr)}</div>`;
    }
  } catch (err) {
    cards.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

async function loadSectorFlow() {
  const box = document.getElementById('sectorFlowBox');
  if (!box) return;
  const period = document.getElementById('sectorFlowPeriod')?.value || '1M';
  box.innerHTML = '<span class="spin"></span>';
  try {
    const data = await api(`/institutional/sector-flow?period=${period}`);
    const sectors = (data.sectors || []).slice().sort((a, b) => (b.netValueCr || 0) - (a.netValueCr || 0));
    if (!sectors.length) {
      box.innerHTML = `<div class="muted small">${data.reason || 'No sector bulk-deal data for this period.'}</div>`;
      return;
    }
    const maxAbs = Math.max(...sectors.map((s) => Math.abs(s.netValueCr || 0)), 1);
    const topIn = sectors.filter((s) => (s.netValueCr || 0) > 0).slice(0, 10);
    const topOut = sectors.filter((s) => (s.netValueCr || 0) < 0).sort((a, b) => (a.netValueCr || 0) - (b.netValueCr || 0)).slice(0, 10);
    const bar = (s, inv = false) => {
      const n = s.netValueCr || 0;
      const w = Math.min(100, (Math.abs(n) / maxAbs) * 100);
      return `<div class="inst-flow-row">
        <span style="width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${s.sector}">${s.sector}</span>
        <div class="inst-flow-bar"><div class="${n >= 0 ? 'in' : 'out'}" style="width:${w}%"></div></div>
        <span class="${instCls(n)}">${instFmtCr(n)}</span>
      </div>`;
    };
    box.innerHTML = `
      <div class="muted small">Source: ${data.source || 'NSE Bulk Deals'} · ${data.from || ''} → ${data.to || ''} · deals ${data.dataPointsFound ?? '—'}</div>
      <div style="margin-top:8px; font-weight:600; font-size:12px;">Top money-in sectors</div>
      ${topIn.length ? topIn.map((s) => bar(s)).join('') : '<div class="muted small">None</div>'}
      <div style="margin-top:10px; font-weight:600; font-size:12px;">Top money-out sectors</div>
      ${topOut.length ? topOut.map((s) => bar(s)).join('') : '<div class="muted small">None</div>'}
    `;
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

async function loadBulkDeals() {
  const box = document.getElementById('bulkDealBox');
  const accum = document.getElementById('instAccumBox');
  const sellb = document.getElementById('instSellBox');
  if (!box && !accum) return;
  const period = document.getElementById('bulkDealPeriod')?.value || '1M';
  if (box) box.innerHTML = '<span class="spin"></span>';
  if (accum) accum.innerHTML = '<span class="spin"></span>';
  if (sellb) sellb.innerHTML = '<span class="spin"></span>';
  try {
    const [buyersRes, sellersRes] = await Promise.all([
      api(`/institutional/top-buyers?period=${period}`),
      api(`/institutional/top-sellers?period=${period}`),
    ]);
    const buyers = buyersRes.buyers || buyersRes.stocks || [];
    const sellers = sellersRes.sellers || sellersRes.stocks || [];
    const row = (r, side) => {
      const net = r.netValueCr ?? r.netCr ?? (side === 'buy' ? r.buyValueCr : -(r.sellValueCr || 0));
      return `<div class="inst-stock-row" data-symbol="${r.symbol}">
        <div><b>${r.symbol}</b> <span class="muted small">${r.clientName ? String(r.clientName).slice(0, 28) : ''}</span></div>
        <div class="${instCls(net)}">${instFmtCr(net)} <span class="muted small">₹Cr</span></div>
      </div>`;
    };
    const listHtml = (arr, side) => arr.length
      ? arr.slice(0, 12).map((r) => row(r, side)).join('')
      : `<div class="muted small">${side === 'buy' ? (buyersRes.reason || 'No bulk buy data') : (sellersRes.reason || 'No bulk sell data')}</div>`;

    if (accum) {
      accum.innerHTML = `<div class="muted small">Source: ${buyersRes.source || 'NSE'} · ${period}</div>${listHtml(buyers, 'buy')}`;
      accum.querySelectorAll('[data-symbol]').forEach((el) => {
        el.addEventListener('click', () => loadSymbol(el.dataset.symbol, { fromView: 'institutional' }));
      });
    }
    if (sellb) {
      sellb.innerHTML = `<div class="muted small">Source: ${sellersRes.source || 'NSE'} · ${period}</div>${listHtml(sellers, 'sell')}`;
      sellb.querySelectorAll('[data-symbol]').forEach((el) => {
        el.addEventListener('click', () => loadSymbol(el.dataset.symbol, { fromView: 'institutional' }));
      });
    }
    if (box) {
      box.innerHTML = `
        <div class="inst-grid-2">
          <div>
            <div style="font-weight:600; font-size:12px; margin-bottom:4px;">📈 Getting attention (bulk buy net)</div>
            ${listHtml(buyers, 'buy')}
          </div>
          <div>
            <div style="font-weight:600; font-size:12px; margin-bottom:4px;">📉 Losing support (bulk sell net)</div>
            ${listHtml(sellers, 'sell')}
          </div>
        </div>
        <p class="muted small" style="margin-top:10px;">${buyersRes.source || 'NSE Bulk Deals'} — large disclosed trades only, not complete institutional positioning.</p>
      `;
      box.querySelectorAll('[data-symbol]').forEach((el) => {
        el.addEventListener('click', () => loadSymbol(el.dataset.symbol, { fromView: 'institutional' }));
      });
    }
  } catch (err) {
    const msg = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
    if (box) box.innerHTML = msg;
    if (accum) accum.innerHTML = msg;
    if (sellb) sellb.innerHTML = msg;
  }
}

// Back-compat names used elsewhere
async function loadFiiDiiOverview() { return loadInstitutionalDashboard(); }

document.getElementById('sectorFlowPeriod')?.addEventListener('change', () => loadSectorFlow());
document.getElementById('bulkDealPeriod')?.addEventListener('change', () => { loadBulkDeals(); });


// ---------- track record (daily-logged recommendation performance) ----------
const CATEGORY_LABELS = {
  intraday: 'Intraday', short_term: 'Short/Mid-term', long_term: 'Long-term',
  momentum: 'Momentum', reversal: 'Reversal/Bounce',
  golden_diamond: '💎 Golden: Diamond', golden_gold: '🥇 Golden: Gold',
  golden_silver: '🥈 Golden: Silver', golden_bronze: '🥉 Golden: Bronze',
};

const PREDICTED_WINDOW_LABELS = { '7d': '⚡ ~7d', '15d': '🕐 ~15d', '30d': '🐢 ~30d', '30d_plus': '⏳ 30d+' };

const WINDOW_OUTCOME_LABELS = {
  hit_within_window: '✅ within predicted window',
  hit_late: '⚠️ hit, but later than predicted',
  not_hit_in_window: '❌ predicted window passed, not hit',
  stopped_out: '🛑 stopped out',
  pending: '⏳ still within window',
};

// Rich, exact breakdown of what actually happened to a pick - the date,
// the ACTUAL price at that moment (not today's, possibly since-reversed,
// price), and how many trading days it took - for target, 2nd target
// (an equal further extension beyond target1), and stop-loss separately,
// plus whether it happened within the app's own predicted holding window.
function buildOutcomeCell(r) {
  const lines = [];
  // Target takes priority: once hit, that pick is graded a win and the
  // backend no longer lets a later pullback flip on hitStopLoss too - but
  // this stays defensive (else-if, not two separate ifs) in case older
  // data hasn't been touched by the tracker job since the fix.
  if (r.hitTarget) {
    lines.push(`🎯 <b>Target 1 hit</b> ${r.hitTargetDate || ''} @ ₹${r.hitTargetPrice?.toFixed(2) ?? '?'} (${r.daysToHitTarget ?? '?'} trading day${r.daysToHitTarget === 1 ? '' : 's'})`);
    if (r.target2 != null) {
      lines.push(r.hitTarget2
        ? `🎯🎯 <b>Target 2 hit</b> ${r.hitTarget2Date || ''} @ ₹${r.hitTarget2Price?.toFixed(2) ?? '?'} (${r.daysToHitTarget2 ?? '?'} trading day${r.daysToHitTarget2 === 1 ? '' : 's'})`
        : `🎯🎯 Target 2 (₹${r.target2.toFixed(2)}) not reached yet`);
    }
    if (r.latestPrice != null && r.hitTargetPrice) {
      const since = ((r.latestPrice - r.hitTargetPrice) / r.hitTargetPrice) * 100;
      lines.push(`<span class="muted">Since target hit: now ₹${r.latestPrice.toFixed(2)} (<span class="change ${since >= 0 ? 'up' : 'down'}" style="display:inline;">${since >= 0 ? '+' : ''}${since.toFixed(2)}%</span>)</span>`);
    }
  } else if (r.hitStopLoss) {
    lines.push(`🛑 <b>Stop-loss hit</b> ${r.hitStopLossDate || ''} @ ₹${r.hitStopLossPrice?.toFixed(2) ?? '?'} (${r.daysToHitStopLoss ?? '?'} trading day${r.daysToHitStopLoss === 1 ? '' : 's'})`);
    if (r.latestPrice != null && r.hitStopLossPrice) {
      const since = ((r.latestPrice - r.hitStopLossPrice) / r.hitStopLossPrice) * 100;
      lines.push(`<span class="muted">Since stop-loss hit: now ₹${r.latestPrice.toFixed(2)} (<span class="change ${since >= 0 ? 'up' : 'down'}" style="display:inline;">${since >= 0 ? '+' : ''}${since.toFixed(2)}%</span>)</span>`);
    }
  } else {
    lines.push('Still open — neither target nor stop-loss hit yet.');
  }
  if (r.predictedWindow) {
    lines.push(`<span class="muted">${WINDOW_OUTCOME_LABELS[r.windowOutcome] || r.windowOutcome || ''}</span>`);
  }
  return lines.join('<br>');
}

let trackRecordPage = 1;
const TRACK_RECORD_PAGE_SIZE = 100;

async function loadTrackRecord(page = 1) {
  trackRecordPage = page;
  const period = document.getElementById('trackRecordPeriod').value;
  const category = document.getElementById('trackRecordCategory').value;
  const status = document.getElementById('trackRecordStatus').value;
  const summaryBox = document.getElementById('trackRecordSummary');
  const tableBox = document.getElementById('trackRecordTable');
  const pagerBox = document.getElementById('trackRecordPagination');
  summaryBox.innerHTML = '<p class="muted small">Loading...</p>';
  tableBox.innerHTML = '';
  pagerBox.innerHTML = '';

  try {
    const periodQs = new URLSearchParams();
    if (period) periodQs.set('period', period);

    // Open and Resolved are fetched and shown as two SEPARATE scorecards
    // (not blended into one number) - a still-open pick has no win/loss
    // yet, so folding it into the same win-rate as already-resolved picks
    // would just be misleading either way.
    const [openSummary, resolvedSummary] = await Promise.all([
      api(`/recommendations/summary?${periodQs.toString()}&status=open`),
      api(`/recommendations/summary?${periodQs.toString()}&status=resolved`),
    ]);
    const fmtRupees = (n) => `${n >= 0 ? '+' : '-'}₹${Math.abs(n).toLocaleString('en-IN')}`;
    const cardHtml = (r, isTotal, isOpenSection) => `
      <div class="card" style="padding:12px; ${isTotal ? 'border-color:var(--accent);' : ''}">
        <div class="muted small" style="text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px;">${isTotal ? '🔢 ALL CATEGORIES COMBINED' : (CATEGORY_LABELS[r.category] || r.category)}</div>
        ${isOpenSection
          ? `<div style="font-size:20px; font-weight:700;" class="${r.avgChangePct >= 0 ? 'change up' : 'change down'}">${r.avgChangePct >= 0 ? '+' : ''}${r.avgChangePct ?? 0}% <span class="muted" style="font-size:11px; font-weight:normal;">avg unrealized</span></div>
             <div class="muted small">${r.totalPicks} still open right now</div>`
          : `<div style="font-size:20px; font-weight:700;" class="${r.winRate >= 50 ? 'change up' : 'change down'}">${r.winRate === null ? '-' : r.winRate + '%'} <span class="muted" style="font-size:11px; font-weight:normal;">win rate</span></div>
             <div class="muted small" style="margin-top:4px;">Avg return: <span class="${r.avgChangePct >= 0 ? 'change up' : 'change down'}" style="display:inline;">${r.avgChangePct >= 0 ? '+' : ''}${r.avgChangePct}%</span></div>
             <div class="muted small">${r.totalPicks} resolved (🎯${r.hitTargetCount} target + 🛑${r.hitStopLossCount} stopped)</div>`
        }
        <div class="muted small" style="margin-top:4px; font-weight:600;" title="Hypothetical: assumes ₹10,000 equal stake per pick, exited at target/SL where hit, or at today's price if still open">
          Hypothetical P&amp;L: <span class="${r.hypotheticalPnlRupees >= 0 ? 'change up' : 'change down'}" style="display:inline;">${fmtRupees(r.hypotheticalPnlRupees)}</span>
        </div>
      </div>
    `;
    const section = (title, data, isOpenSection) => {
      if (!data.summary.length) return `<div class="muted small" style="margin-bottom:16px;">${title}: nothing for this period yet.</div>`;
      return `
        <div style="margin-bottom:22px;">
          <div style="font-weight:700; margin-bottom:8px;">${title}</div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-bottom:10px;">
            ${cardHtml(data.total, true, isOpenSection)}
          </div>
          <div class="muted small" style="margin:10px 0 6px; text-transform:uppercase; letter-spacing:.04em;">By category</div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
            ${data.summary.map((r) => cardHtml(r, false, isOpenSection)).join('')}
          </div>
        </div>
      `;
    };
    summaryBox.innerHTML = `
      <p class="muted small" style="margin-bottom:14px;">${resolvedSummary.note}</p>
      ${section('📈 Currently Open (unrealized)', openSummary, true)}
      ${section('✅ Resolved (target or stop-loss hit)', resolvedSummary, false)}
    `;

    const qs = new URLSearchParams(periodQs);
    if (category) qs.set('category', category);
    if (status) qs.set('status', status);
    // Ascending by date (oldest first) is the server's default sort for
    // this endpoint - so an unfiltered load naturally starts from day 1 of
    // whatever history exists, and paging forward moves toward "now".
    qs.set('page', String(page));
    qs.set('limit', String(TRACK_RECORD_PAGE_SIZE));
    const listData = await api(`/recommendations?${qs.toString()}`);
    const list = listData.recommendations;
    if (!list.length) { tableBox.innerHTML = '<p class="muted small">No individual picks logged for this filter yet.</p>'; return; }
    const table = document.createElement('table');
    table.className = 'indicator-table';
    table.style.width = '100%';
    table.style.minWidth = '820px';
    table.innerHTML = `<tr>
      <td><b>Symbol</b></td><td><b>Category</b></td><td><b>Picked on</b></td><td><b>Predicted window</b></td>
      <td><b>Price then</b></td><td><b>Price now</b></td><td><b>Change</b></td><td><b>Outcome — exact date/price/days it actually happened (click a row for full detail)</b></td>
    </tr>`;
    list.forEach((r) => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      const cls = r.changePct === null ? '' : (r.changePct >= 0 ? 'up' : 'down');
      tr.innerHTML = `
        <td><b>${r.symbol}</b></td>
        <td class="muted">${CATEGORY_LABELS[r.category] || r.category}</td>
        <td class="muted">${r.recommendedDate}</td>
        <td class="muted">${PREDICTED_WINDOW_LABELS[r.predictedWindow] || '-'}</td>
        <td>₹${r.recommendedPrice.toFixed(2)}</td>
        <td>${r.latestPrice ? '₹' + r.latestPrice.toFixed(2) : '-'}</td>
        <td class="change ${cls}">${r.changePct === null ? '-' : (r.changePct >= 0 ? '+' : '') + r.changePct.toFixed(2) + '%'}</td>
        <td style="font-size:11px; line-height:1.5;">${buildOutcomeCell(r)}</td>
      `;
      tr.addEventListener('click', () => loadSymbol(r.symbol));
      table.appendChild(tr);
    });
    tableBox.appendChild(table);

    // Pagination - only shown once there's more than one page, so a small
    // history doesn't grow a redundant pager for no reason.
    const { total, pages } = listData;
    if (pages > 1) {
      const start = (page - 1) * TRACK_RECORD_PAGE_SIZE + 1;
      const end = Math.min(page * TRACK_RECORD_PAGE_SIZE, total);
      pagerBox.innerHTML = `
        <button class="ghost-btn" id="trPrevBtn" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="muted small">Showing ${start}–${end} of ${total} · page ${page} of ${pages}</span>
        <button class="ghost-btn" id="trNextBtn" ${page >= pages ? 'disabled' : ''}>Next →</button>
      `;
      document.getElementById('trPrevBtn')?.addEventListener('click', () => { loadTrackRecord(page - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      document.getElementById('trNextBtn')?.addEventListener('click', () => { loadTrackRecord(page + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    } else {
      pagerBox.innerHTML = `<span class="muted small">${total} pick${total === 1 ? '' : 's'} total</span>`;
    }
  } catch (err) {
    summaryBox.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

document.getElementById('trackRecordPeriod').addEventListener('change', () => loadTrackRecord(1));
document.getElementById('trackRecordCategory').addEventListener('change', () => loadTrackRecord(1));
document.getElementById('trackRecordStatus').addEventListener('change', () => loadTrackRecord(1));
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'trackrecord') btn.addEventListener('click', () => loadTrackRecord(1));
});

// ---------- Weekend Picks ----------
const WEEKEND_TIER_LABEL = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`);

async function populateWeekendWeeks(selected) {
  const sel = document.getElementById('weekendPicksWeek');
  try {
    const { weeks } = await api('/weekend-picks/weeks');
    if (!weeks.length) { sel.innerHTML = '<option value="">No batches yet</option>'; return; }
    sel.innerHTML = weeks.map((w) => `<option value="${w}">For Monday ${w}</option>`).join('');
    if (selected) sel.value = selected;
  } catch { /* ignore */ }
}

async function loadWeekendPicks() {
  const box = document.getElementById('weekendPicksBox');
  box.innerHTML = '<p class="muted small">Loading...</p>';
  const weekSel = document.getElementById('weekendPicksWeek');
  const monday = weekSel.value || '';
  try {
    const qs = monday ? `?monday=${monday}` : '';
    const { picks, forMondayDate, weekendRunDate } = await api(`/weekend-picks${qs}`);
    await populateWeekendWeeks(forMondayDate);
    if (!picks.length) {
      box.innerHTML = `<div class="muted small" style="padding:14px; border:1px dashed var(--border); border-radius:8px;">No weekend picks saved yet. Click "🔬 Run fresh research now" above — first run can take a couple of minutes since it scans the full ~450-stock universe.</div>`;
      return;
    }
    box.innerHTML = `
      <p class="muted small" style="margin-bottom:12px;">Researched ${weekendRunDate}, for Monday ${forMondayDate}. Ranked #1 (best) to #${picks.length}.</p>
      <div class="grid">
        ${picks.map((r) => {
          const statusBadge = r.hitTarget
            ? `<span class="verdict-badge bullish">🎯 Target hit</span>`
            : r.hitStopLoss
              ? `<span class="verdict-badge bearish">🛑 Stop-loss hit</span>`
              : `<span class="verdict-badge neutral">📈 Still open</span>`;
          const changeCls = r.changePct >= 0 ? 'up' : 'down';
          return `
            <div class="card" style="border-color:${r.meetsStrictBar ? 'var(--green)' : 'var(--border)'};">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
                <div>
                  <div style="font-weight:700; font-size:16px;">${WEEKEND_TIER_LABEL(r.rank)} <span class="wp-symbol-link">${r.symbol}</span> ${r.indexLabel ? `<span class="muted small">(${r.indexLabel})</span>` : ''}</div>
                  <div class="muted small">Researched @ ₹${r.priceAtResearch.toFixed(2)} · now ₹${r.latestPrice?.toFixed(2) ?? '-'} <span class="change ${changeCls}" style="display:inline;">${r.changePct >= 0 ? '+' : ''}${r.changePct?.toFixed(2) ?? 0}%</span></div>
                </div>
                ${statusBadge}
              </div>
              ${r.meetsStrictBar ? '<div class="muted small" style="color:var(--green); font-weight:600; margin-top:4px;">✅ Cleared the strict bar: negligible loss odds, high profit odds</div>' : '<div class="muted small" style="margin-top:4px;">⚠️ Best available this week — didn\'t fully clear the strict bar</div>'}
              <div class="muted small" style="margin-top:6px;">Entry ₹${r.entryLow}–₹${r.entryHigh} · SL ₹${r.stopLoss} · Target ₹${r.target}${r.target2 ? ` · T2 ₹${r.target2}` : ''} · R:R 1:${r.riskRewardRatio}</div>
              <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
                <span class="change up" style="display:inline;">✅ ${r.profitProbability1Pct}% profit odds</span>
                <span class="change down" style="display:inline;">⚠️ ${r.lossProbability2Pct}% loss odds</span>
                ${r.predictedWindowDays ? `<span class="muted small">⏱ usually resolves in ~${r.predictedWindowDays}d</span>` : ''}
              </div>
              <div class="muted small" style="margin-top:8px;">${r.reason}</div>
              ${r.topFactors?.length ? `<ul class="factor-list" style="margin-top:8px;">${r.topFactors.map((f) => `<li class="${f.signal}">${f.factor}</li>`).join('')}</ul>` : ''}
              ${quickLogWidget({ symbol: r.symbol, price: r.latestPrice ?? r.priceAtResearch, tradePlan: { stopLoss: r.stopLoss, target: r.target }, suggestedHorizon: 'short_term' })}
            </div>
          `;
        }).join('')}
      </div>
    `;
    box.querySelectorAll('.wp-symbol-link').forEach((el) => el.addEventListener('click', () => loadSymbol(el.textContent)));
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

document.getElementById('weekendPicksWeek').addEventListener('change', loadWeekendPicks);
document.getElementById('weekendPicksGenerateBtn').addEventListener('click', async () => {
  const btn = document.getElementById('weekendPicksGenerateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Researching all ~450 stocks... this can take 2-4 minutes';
  try {
    const result = await api('/weekend-picks/generate', { method: 'POST', body: JSON.stringify({ force: true }) });
    if (result.count) {
      toast(`Generated ${result.count} weekend picks for Monday ${result.forMondayDate}`);
    } else if (result.skipped) {
      toast(result.reason);
    } else {
      toast(result.note || 'No qualifying candidates found this weekend.');
    }
    await loadWeekendPicks();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔬 Run fresh research now';
  }
});
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'weekendpicks') btn.addEventListener('click', loadWeekendPicks);
});

// ---------- Model Learning (factor-performance feedback loop) ----------
async function loadFactorPerformance() {
  const box = document.getElementById('modelLearningBox');
  const meta = document.getElementById('modelLearningMeta');
  box.innerHTML = '<p class="muted small">Loading...</p>';
  try {
    const data = await api('/recommendations/factor-performance');
    const {
      factors, combinations = [], totalResolvedWithFactors, unresolvedWithFactors = 0,
      minSampleForAdjustment, maxAdjustment, baselineWinRate,
    } = data;
    const regimeNow = data.cache?.currentLearningRegime || data.cache?.lastRecompute?.currentLearningRegime || '—';
    meta.textContent = `${totalResolvedWithFactors} resolved · ${unresolvedWithFactors} unresolved · cache: ${data.cache?.size || 0} signal(s)${data.cache?.comboSize ? ' + ' + data.cache.comboSize + ' combo(s)' : ''}${data.cache?.loadedAt ? ' · ' + new Date(data.cache.loadedAt).toLocaleTimeString() : ''} · regime ${regimeNow}`;

    if (!factors.length) {
      box.innerHTML = `<div class="empty-state">No factor data yet. Builds as picks resolve (target or SL). Each signal needs ${minSampleForAdjustment}+ resolved picks before ranking influence. Crisis days are stored separately so they do not poison normal-market learning.</div>`;
      return;
    }

    const rowHtml = (f, isCombo) => {
      const sample = f.sampleSize ?? f.occurrences ?? 0;
      const eff = f.effectiveSampleSize != null ? Number(f.effectiveSampleSize).toFixed(1) : sample;
      const trusted = sample >= minSampleForAdjustment;
      const conf = f.learningConfidence || (sample < 8 ? 'none' : sample < minSampleForAdjustment ? 'low' : sample < 50 ? 'medium' : 'high');
      const modelConf = f.modelConfidence || conf;
      const winCls = (f.winRate ?? 0) >= baselineWinRate ? 'up' : 'down';
      const adjCls = f.scoreAdjustment > 0 ? 'up' : (f.scoreAdjustment < 0 ? 'down' : '');
      const label = isCombo ? (f.combinationLabel || f.factor) : f.factor;
      const regimeBits = f.regimeBreakdown
        ? Object.entries(f.regimeBreakdown).map(([k, v]) => `${k}:${v.winRate ?? '—'}%(n=${v.occurrences})`).join(' · ')
        : '';
      return `
        <tr style="${trusted ? '' : 'opacity:.55;'}">
          <td>${label}</td>
          <td class="muted">${isCombo ? 'combo' : f.signal}</td>
          <td>${sample} <span class="muted small">eff ${eff}</span><br/><span class="muted small">${f.wins ?? 0}T / ${f.losses ?? 0}SL</span></td>
          <td class="muted small">N:${f.normalOccurrences ?? '—'} (${f.normalWinRate != null ? f.normalWinRate + '%' : '—'})<br/>C:${f.crisisOccurrences ?? '—'} (${f.crisisWinRate != null ? f.crisisWinRate + '%' : '—'})</td>
          <td class="muted small">${f.targetHitPct != null ? f.targetHitPct + '%' : '-'} / ${f.slHitPct != null ? f.slHitPct + '%' : '-'} / ${f.noResolutionPct != null ? f.noResolutionPct + '%' : '-'}</td>
          <td class="change ${winCls}">${f.winRate != null ? f.winRate + '%' : '-'}${f.recentWinRate != null ? `<br/><span class="muted small">recent ${f.recentWinRate}%</span>` : ''}</td>
          <td class="muted small">
            Exp ${f.expectancy != null ? f.expectancy + '%' : '—'}
            <br/>W ${f.avgWinPct != null ? f.avgWinPct + '%' : '—'} / L ${f.avgLossPct != null ? f.avgLossPct + '%' : '—'}
            <br/>Med ${f.medianReturnPct != null ? f.medianReturnPct + '%' : '—'}
          </td>
          <td class="muted small">Hold ${f.avgHoldingDays != null ? f.avgHoldingDays + 'd' : '—'}
            <br/>MAE ${f.avgMaePct != null ? f.avgMaePct + '%' : '—'} / MFE ${f.avgMfePct != null ? f.avgMfePct + '%' : '—'}
          </td>
          <td><span class="verdict-badge ${conf === 'high' ? 'bullish' : conf === 'medium' ? 'neutral' : ''}" style="font-size:10px;">${conf}</span>
            <br/><span class="muted small">model ${modelConf}</span></td>
          <td class="change ${adjCls}"><b>${f.scoreAdjustment > 0 ? '+' : ''}${f.scoreAdjustment ?? 0}</b></td>
          <td class="muted small" style="max-width:280px;">${f.why || '—'}
            ${regimeBits ? `<div style="margin-top:4px;">Regimes: ${regimeBits}</div>` : ''}
          </td>
        </tr>`;
    };

    const table = (title, rows, isCombo) => `
      <div class="card" style="padding:12px; margin-bottom:12px; overflow-x:auto;">
        <div style="font-weight:700; margin-bottom:8px;">${title} <span class="muted small">(${rows.length})</span></div>
        <table class="indicator-table" style="width:100%; font-size:12px;">
          <thead>
            <tr>
              <th>Signal</th><th>Type</th><th>Sample</th><th>Normal / Crisis</th>
              <th>T% / SL% / Open%</th><th>Overall WR</th><th>Expectancy</th><th>Hold / MAE·MFE</th>
              <th>Confidence</th><th>Nudge</th><th>Why / Regimes</th>
            </tr>
          </thead>
          <tbody>${rows.map((f) => rowHtml(f, isCombo)).join('')}</tbody>
        </table>
      </div>`;

    box.innerHTML = `
      <div class="card" style="padding:12px; margin-bottom:12px;">
        <div class="muted small">${data.note || ''}</div>
        <div class="muted small" style="margin-top:6px;">Nudge hard-capped at ±${maxAdjustment}. Low sample → zero influence. Crisis learning is isolated from normal. NOT a future profit probability.</div>
      </div>
      <div id="mlSimilarBox" class="card" style="padding:12px; margin-bottom:12px;">
        <div style="font-weight:700; margin-bottom:6px;">📎 Similar past conditions</div>
        <div class="muted small"><span class="spin"></span> Loading matches for current / selected regime…</div>
      </div>
      ${table('Individual signals', factors, false)}
      ${combinations.length ? table('Signal combinations', combinations, true) : ''}
    `;
    loadSimilarConditionsPanel(data.cache?.currentLearningRegime || null);
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red);">${err.message}</p>`;
  }
}

async function loadSimilarConditionsPanel(preferredRegime) {
  const box = document.getElementById('mlSimilarBox');
  if (!box) return;
  try {
    // Prefer live market regime if available
    let regime = preferredRegime;
    try {
      const m = await api('/market/regime');
      const reg = m?.regime || m;
      if (reg?.learningRegime) regime = reg.learningRegime;
    } catch (_) {}
    const q = regime && regime !== 'UNKNOWN' ? `?regime=${encodeURIComponent(regime)}&limit=15` : '?limit=15';
    const data = await api(`/recommendations/similar-conditions${q}`);
    const matches = data.matches || [];
    if (!matches.length) {
      box.innerHTML = `
        <div style="font-weight:700; margin-bottom:6px;">📎 Similar past conditions</div>
        <div class="muted small">No resolved picks stored yet for regime <b>${regime || 'any'}</b>. Builds as more picks hit target/SL with regime tags.</div>
        <p class="muted small">${data.note || ''}</p>`;
      return;
    }
    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
        <div style="font-weight:700;">📎 Similar past conditions <span class="muted small">(${matches.length} · regime ${regime || 'any'})</span></div>
        <div class="muted small">${data.note || ''}</div>
      </div>
      <div style="overflow-x:auto;">
        <table class="indicator-table" style="width:100%; font-size:12px;">
          <thead><tr><th>Date</th><th>Symbol</th><th>Outcome</th><th>Return</th><th>Regime</th><th>Sector</th><th>Signals</th></tr></thead>
          <tbody>
            ${matches.map((m) => `
              <tr>
                <td>${m.date || '—'}</td>
                <td><b class="ml-sim-sym" data-symbol="${m.symbol}" style="cursor:pointer;">${m.symbol}</b></td>
                <td class="${m.outcome === 'target' ? 'change up' : 'change down'}">${m.outcome === 'target' ? 'Target' : 'SL'}</td>
                <td class="${(m.returnPct ?? 0) >= 0 ? 'change up' : 'change down'}">${m.returnPct != null ? (m.returnPct >= 0 ? '+' : '') + m.returnPct + '%' : '—'}</td>
                <td class="muted small">${m.regime || '—'}${m.crisisTags?.length ? ' · ' + m.crisisTags.join(',') : ''}</td>
                <td class="muted small">${m.sector || '—'}</td>
                <td class="muted small">${(m.signals || []).slice(0, 3).join(', ')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    box.querySelectorAll('.ml-sim-sym').forEach((el) => {
      el.addEventListener('click', () => {
        if (typeof loadSymbol === 'function') loadSymbol(el.dataset.symbol, { fromView: 'modellearning' });
      });
    });
  } catch (err) {
    box.innerHTML = `<div style="font-weight:700;">📎 Similar past conditions</div><div class="muted small" style="color:var(--red);">${err.message}</div>`;
  }
}

document.getElementById('modelLearningRecomputeBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('modelLearningRecomputeBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Recomputing…';
  try {
    const result = await api('/recommendations/factor-performance/recompute', { method: 'POST' });
    toast(result.ok
      ? `Recomputed ${result.factorsTracked} signal(s) from ${result.resolvedPicksUsed} resolved picks`
      : (result.reason || 'Done'));
    await loadFactorPerformance();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔄 Recompute now';
  }
});
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'modellearning') btn.addEventListener('click', loadFactorPerformance);
});

// ---------- settings ----------
async function loadSettings() {
  const status = document.getElementById('settingsStatus');
  status.textContent = 'Loading...';
  try {
    const { settings: s } = await api('/settings');
    document.getElementById('setCapital').value = s.capital;
    document.getElementById('setRiskPerTrade').value = s.riskPerTradePct;
    document.getElementById('setMinRR').value = s.minRiskReward;
    document.getElementById('setMaxDailyLoss').value = s.maxDailyLossPct;
    document.getElementById('setMaxTrades').value = s.maxTradesPerDay;
    document.getElementById('setCooldown').value = s.cooldownMinutes;
    document.getElementById('setMaxSector').value = s.maxSectorExposurePct;
    document.getElementById('setMaxStock').value = s.maxStockExposurePct;
    document.getElementById('setMinDataConf').value = s.minDataConfidence;
    status.textContent = '';
  } catch (err) {
    status.textContent = err.message;
  }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    capital: document.getElementById('setCapital').value,
    riskPerTradePct: document.getElementById('setRiskPerTrade').value,
    minRiskReward: document.getElementById('setMinRR').value,
    maxDailyLossPct: document.getElementById('setMaxDailyLoss').value,
    maxTradesPerDay: document.getElementById('setMaxTrades').value,
    cooldownMinutes: document.getElementById('setCooldown').value,
    maxSectorExposurePct: document.getElementById('setMaxSector').value,
    maxStockExposurePct: document.getElementById('setMaxStock').value,
    minDataConfidence: document.getElementById('setMinDataConf').value,
  };
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    toast('Settings saved');
  } catch (err) {
    toast(err.message);
  }
});

async function loadUpstoxStatus() {
  const box = document.getElementById('upstoxStatus');
  try {
    const { upstoxConfigured } = await api('/auth/upstox/status');
    box.innerHTML = upstoxConfigured
      ? '<span class="change up">✅ Connected — live data tries Upstox first.</span>'
      : '<span class="muted">Not connected — using Yahoo Finance only (still fully functional).</span>';
  } catch {
    box.textContent = 'Not connected — using Yahoo Finance only.';
  }
}

// ---------- market holidays ----------
async function loadHolidayList() {
  const box = document.getElementById('holidayListBox');
  box.innerHTML = '<p class="muted small">Loading...</p>';
  try {
    const { holidays } = await api('/market/calendar/holidays');
    if (!holidays.length) { box.innerHTML = '<p class="muted small">No holidays saved yet.</p>'; return; }
    const today = new Date().toISOString().slice(0, 10);
    box.innerHTML = holidays.map((h) => `
      <div class="row" style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border);">
        <span style="font-size:13px;">${h.date === today ? '📍 ' : ''}${h.date} — ${h.name}</span>
        <button class="small remove-holiday-btn" data-date="${h.date}">Remove</button>
      </div>
    `).join('');
    box.querySelectorAll('.remove-holiday-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/market/calendar/holidays/${btn.dataset.date}`, { method: 'DELETE' });
        loadHolidayList();
      });
    });
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

document.getElementById('holidayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = document.getElementById('holidayDate').value;
  const name = document.getElementById('holidayName').value;
  try {
    await api('/market/calendar/holidays', { method: 'POST', body: JSON.stringify({ date, name }) });
    e.target.reset();
    loadHolidayList();
    toast('Holiday added');
  } catch (err) {
    toast(err.message);
  }
});

async function loadHolidayBanner() {
  const box = document.getElementById('holidayBanner');
  try {
    const { status } = await api('/market/calendar/status');
    if (status.isTradingDay) { box.classList.add('hidden'); box.innerHTML = ''; return CACHED_MARKET_STATUS = status; }
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px; padding:12px 16px; border-color:var(--amber); background:rgba(245,158,11,.08);">
        <b>🎉 Market closed today — ${status.reason}</b>
        <div class="muted small" style="margin-top:4px;">No new picks, snapshots, or alerts get logged today. The "Best for Intraday/Short-Mid/Long-term", golden setup and swing setup sections are hidden — only the plain sortable/filterable stock list is shown below. Good day to review and plan your strategy for the next trading day.</div>
      </div>
    `;
    return (CACHED_MARKET_STATUS = status);
  } catch {
    box.classList.add('hidden');
  }
}
let CACHED_MARKET_STATUS = null;

document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'settings') btn.addEventListener('click', () => { loadSettings(); loadUpstoxStatus(); loadHolidayList(); });
});

// ---------- live auto-refresh (no manual page refresh needed, 9:00-3:40 IST) ----------
function isIndianMarketHours() {
  if (CACHED_MARKET_STATUS && !CACHED_MARKET_STATUS.isTradingDay) return false; // holiday/weekend, confirmed by server
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30; // 9:15–15:30 IST only
}

function setLiveStatus(active) {
  const dot = document.getElementById('liveDot');
  const text = document.getElementById('liveStatusText');
  if (!dot) return;
  dot.style.background = active ? 'var(--green)' : 'var(--muted)';
  dot.style.animation = active ? '' : 'none';
  dot.title = active ? `Auto-updating — last refresh ${new Date().toLocaleTimeString()}` : 'Market closed / weekend / after 3:30 — no auto scan-refresh';
  if (text) text.textContent = active ? `Live · updated ${new Date().toLocaleTimeString()}` : 'Market closed';
}

// Re-fetches the current stock's full analysis without resetting scroll
// position, the "Loading..." flicker, or anything the user typed into the
// risk calculator / journal forms - just the numbers update in place.
async function silentRefreshCurrentSymbol() {
  if (!CURRENT_SYMBOL) return;
  try {
    const { analysis, candles, marketContext } = await api(`/stocks/${CURRENT_SYMBOL}/analysis`);
    renderAnalysis(analysis, candles, marketContext, false);
    renderTradePlan(analysis);
    setLiveStatus(true);
  } catch (err) {
    console.error('Silent refresh failed:', err.message);
  }
}

function isViewActive(viewId) {
  const el = document.getElementById(viewId);
  return el && el.classList.contains('active');
}

// Full-analysis + position refresh: every 60s during market hours.
setInterval(() => {
  if (!isIndianMarketHours() || !TOKEN) { setLiveStatus(false); return; }
  if (CURRENT_SYMBOL) silentRefreshCurrentSymbol();
  if (isViewActive('view-journal')) { loadPositions(); loadPortfolio(); }
}, 60 * 1000);

// Keeps Top Picks/Swing Setups/Golden tiers/Golden Opportunity/Market Pulse
// in sync with live market hours, even if the page is just left open: hides
// them the moment the market closes for the day (3:40pm IST) since intraday
// trades in particular can no longer be placed, and refreshes them with
// live data if the page was left open across the market re-opening.
let wasMarketLiveForPicks = null;
setInterval(() => {
  if (!TOKEN) return;
  const live = isIndianMarketHours();
  if (live === wasMarketLiveForPicks) return; // no change since last check
  wasMarketLiveForPicks = live;
  if (!live) {
    ['topPicksBox', 'goldenSetupsBox', 'swingSetupsBox', 'goldenOpportunityCard', 'marketPulseCard', 'bestOfTodayCard'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  } else if (currentIndexResults.length) {
    applyIndexSortAndFilter();
    loadGoldenOpportunities();
    loadMarketPulse();
    loadBestOfToday();
  }
}, 30 * 1000);

// Watchlist verdict refresh: every 5 min during market hours (lighter load).
setInterval(() => {
  if (!isIndianMarketHours() || !TOKEN) return;
  if (isViewActive('view-watchlist')) {
    api('/watchlist/refresh', { method: 'POST' }).then(loadWatchlist).catch(() => {});
  }
}, 5 * 60 * 1000);

// ---------- init ----------
tryResumeSession();


// ---------- IPO Listing Day (separate module) ----------
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'ipo') {
      if (isIndianMarketHours()) { loadIpoBoard(); loadIpoWatchList(); }
    }
  });
});

document.getElementById('ipoRefreshBoardBtn')?.addEventListener('click', () => loadIpoBoard(true));

document.getElementById('ipoAnalyzeBtn')?.addEventListener('click', () => analyzeIpoDay());
document.getElementById('ipoSaveWatchBtn')?.addEventListener('click', () => saveIpoWatch());
document.getElementById('ipoScanWatchBtn')?.addEventListener('click', () => scanIpoWatch());


async function loadIpoBoard(forceAnalyze) {
  if (!forceAnalyze && typeof isIndianMarketHours === 'function' && !isIndianMarketHours()) {
    const st = document.getElementById('ipoStatus');
    if (st) st.textContent = 'Market closed / after 3:30 — auto IPO scan off (manual Refresh OK).';
  }
  const box = document.getElementById('ipoBoardBox');
  const status = document.getElementById('ipoStatus');
  const resultBox = document.getElementById('ipoResultBox');
  if (!box) return;
  box.innerHTML = '<div class="muted small"><span class="spin"></span> Loading NSE IPO board (today + last ~45 days)…</div>';
  try {
    const data = await api('/ipo/listed-today/analyze');
    const today = data.today || '';
    const nextD = data.nextTradingDay || '';
    const listedToday = data.results || [];
    const last30 = data.listedLast30Days || listedToday;
    const tomorrow = data.listedTomorrow || [];
    const openSub = data.openForSubscription || [];

    function rowHtml(r, { showAnalysis } = {}) {
      const sig = r.analysis?.signal;
      const sigCls = sig === 'BUY' ? 'bullish' : (sig === 'AVOID' ? 'bearish' : 'neutral');
      const vs = r.vsIssuePct != null ? r.vsIssuePct : r.analysis?.metrics?.listingPremiumPct;
      const vsCls = vs == null ? '' : (vs >= 0 ? 'up' : 'down');
      const reclaim = r.analysis?.reclaimSetup;
      return `
        <div class="ipo-row" data-symbol="${r.symbol}" data-issue="${r.issuePrice ?? ''}"
          style="padding:10px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; cursor:pointer;">
          <div style="flex:1; min-width:180px;">
            <b class="ipo-sym-link">${r.symbol}</b>
            ${r.companyName ? `<span class="muted small"> ${r.companyName}</span>` : ''}
            ${sig ? `<span class="verdict-badge ${sigCls}" style="margin-left:6px; font-size:11px;"><b>${sig}</b></span>` : ''}
            ${reclaim?.active ? `<span class="verdict-badge bullish" style="margin-left:4px; font-size:10px;">RECLAIM</span>` : ''}
            <div class="muted small">
              Listed ${r.listingDate || '—'} · Issue ₹${r.issuePrice ?? '—'}
              ${r.livePrice != null || r.analysis?.metrics?.price != null
                ? ` · Now ₹${Number(r.livePrice ?? r.analysis.metrics.price).toFixed(2)}`
                : ''}
              ${vs != null ? ` · <span class="change ${vsCls}" style="display:inline;">${vs >= 0 ? '+' : ''}${Number(vs).toFixed(2)}% vs issue</span>` : ''}
              ${r.analysis?.confidence != null ? ` · conf ${r.analysis.confidence}` : ''}
              ${r.error ? ` · ${r.error}` : ''}
            </div>
            ${reclaim?.note ? `<div class="muted small" style="margin-top:2px;">${reclaim.note}</div>` : ''}
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="ghost-btn small ipo-board-open" data-symbol="${r.symbol}" data-issue="${r.issuePrice ?? ''}">Full chart</button>
            <button type="button" class="ghost-btn small ipo-board-ipo" data-symbol="${r.symbol}" data-issue="${r.issuePrice ?? ''}">IPO view</button>
          </div>
        </div>`;
    }

    const card = (title, rows, emptyMsg) => `
      <div class="card" style="padding:12px; margin-bottom:10px;">
        <div style="font-weight:700; margin-bottom:8px;">${title}</div>
        ${!rows.length ? `<div class="muted small">${emptyMsg}</div>` : rows.map((r) => rowHtml(r)).join('')}
      </div>`;

    const tomRows = tomorrow.map((r) => ({
      symbol: r.symbol,
      companyName: r.companyName,
      issuePrice: r.issuePrice,
      listingDate: r.listingDate,
      error: r.listingDate ? `Lists ${r.listingDate}` : null,
    }));
    const openRows = openSub.slice(0, 12).map((r) => ({
      symbol: r.symbol,
      companyName: r.companyName,
      issuePrice: r.issuePrice,
      error: r.status === 'open' ? 'Subscription open' : 'Upcoming',
    }));

    const reclaimAlerts = data.reclaimAlerts || [];
    const approachingAlerts = data.approachingAlerts || [];
    const alertBanner = (reclaimAlerts.length || approachingAlerts.length) ? `
      <div class="card" style="padding:12px; margin-bottom:12px; border:1px solid var(--accent,#6ea8fe);">
        <div style="font-weight:700; margin-bottom:8px;">⚡ IPO alerts (listing / issue zone)</div>
        ${reclaimAlerts.map((a) => `
          <div class="ipo-alert-reclaim" data-symbol="${a.symbol}" style="padding:8px 10px; margin-bottom:6px; border-radius:8px; background:rgba(61,214,140,.12); animation: ipoBlink 1.2s ease-in-out infinite; cursor:pointer;">
            <b>RECLAIMED</b> ${a.symbol}${a.companyName ? ' · ' + a.companyName : ''}
            <div class="muted small">${a.message}</div>
            <div class="muted small">Issue ₹${a.issuePrice ?? '—'} · Now ₹${a.livePrice != null ? Number(a.livePrice).toFixed(2) : '—'} · ${a.vsIssuePct != null ? (a.vsIssuePct >= 0 ? '+' : '') + a.vsIssuePct + '%' : '—'} · Listed ${a.listingDate || '—'}</div>
            <div class="muted small">Listing ke baad: <b>High ₹${a.postListHigh ?? '—'}</b>${a.highPctFromIssue!=null?` (${a.highPctFromIssue>=0?'+':''}${a.highPctFromIssue}%)`:''}
              · <b>Low ₹${a.postListLow ?? '—'}</b>${a.lowPctFromIssue!=null?` (${a.lowPctFromIssue}%)`:''}
              · Bounce ~₹${a.bounceFrom ?? a.postListLow ?? '—'}</div>
          </div>`).join('')}
        ${approachingAlerts.map((a) => `
          <div class="ipo-alert-near" data-symbol="${a.symbol}" style="padding:8px 10px; margin-bottom:6px; border-radius:8px; background:rgba(110,168,254,.12); animation: ipoPulse 1.6s ease-in-out infinite; cursor:pointer;">
            <b>NEAR ISSUE</b> ${a.symbol}${a.companyName ? ' · ' + a.companyName : ''}
            <div class="muted small">${a.message}</div>
            <div class="muted small">Issue ₹${a.issuePrice ?? '—'} · Now ₹${a.livePrice != null ? Number(a.livePrice).toFixed(2) : '—'} · ${a.vsIssuePct != null ? a.vsIssuePct + '%' : '—'} · Listed ${a.listingDate || '—'}</div>
            <div class="muted small">Listing ke baad: <b>High ₹${a.postListHigh ?? '—'}</b>${a.highPctFromIssue!=null?` (${a.highPctFromIssue>=0?'+':''}${a.highPctFromIssue}%)`:''}
              · <b>Low ₹${a.postListLow ?? '—'}</b>${a.lowPctFromIssue!=null?` (${a.lowPctFromIssue}%)`:''}
              · Bounce ~₹${a.bounceFrom ?? a.postListLow ?? '—'}</div>
          </div>`).join('')}
      </div>` : '';

    box.innerHTML = `
      ${alertBanner}
      <div class="muted small" style="margin-bottom:8px;">NSE · today <b>${today}</b> · next trade day <b>${nextD}</b> · last ~45 days listed. <b>Full chart</b> opens analysis page. ${data.note || ''}</div>
      ${card(`📢 Listed today (${listedToday.length})`, listedToday, 'No listings marked today on NSE.')}
      ${card(`📆 Listed last ~45 days (${last30.length}) — price vs issue`, last30, 'No recent listings.')}
      ${card(`📅 Next trading day (${tomRows.length})`, tomRows, 'None yet.')}
      ${card(`🧾 Subscription open / upcoming`, openRows, 'None active.')}
    `;

    if (resultBox && listedToday.some((r) => r.analysis)) {
      resultBox.innerHTML = listedToday.filter((r) => r.analysis).map((r) => renderIpoAnalysis(r.analysis)).join('');
    }
    if (status) {
      const buys = last30.filter((r) => r.analysis?.signal === 'BUY').length;
      const reclaims = last30.filter((r) => r.analysis?.reclaimSetup?.active).length;
      status.textContent = `Today ${listedToday.length} · last 15d ${last30.length} · BUY ${buys} · reclaim ${reclaims}`;
    }

    const openFull = (symbol) => {
      if (!symbol) return;
      // Remember IPO as source so Back returns here (not generic home)
      if (typeof loadSymbol === 'function') loadSymbol(symbol, { fromView: 'ipo' });
    };
    const openIpo = (symbol, issue) => {
      document.getElementById('ipoSymbol').value = symbol || '';
      if (issue) document.getElementById('ipoIssuePrice').value = issue;
      analyzeIpoDay({ asPage: true });
    };

    box.querySelectorAll('.ipo-alert-reclaim, .ipo-alert-near').forEach((el) => {
      el.addEventListener('click', () => openFull(el.dataset.symbol));
    });
    box.querySelectorAll('.ipo-board-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFull(btn.dataset.symbol);
      });
    });
    box.querySelectorAll('.ipo-board-ipo').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIpo(btn.dataset.symbol, btn.dataset.issue);
      });
    });
    box.querySelectorAll('.ipo-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openFull(row.dataset.symbol);
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
    if (status) status.textContent = err.message;
  }
}

function showIpoDetailPage(html) {
  const home = document.getElementById('ipoHome');
  const page = document.getElementById('ipoDetailPage');
  const content = document.getElementById('ipoDetailContent');
  if (home) home.classList.add('hidden');
  if (page) page.classList.remove('hidden');
  if (content) content.innerHTML = html || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideIpoDetailPage() {
  const home = document.getElementById('ipoHome');
  const page = document.getElementById('ipoDetailPage');
  if (page) page.classList.add('hidden');
  if (home) home.classList.remove('hidden');
}

document.getElementById('ipoBackBtn')?.addEventListener('click', () => {
  hideIpoDetailPage();
});

async function analyzeIpoDay(opts = {}) {
  const asPage = opts.asPage === true;
  const symbol = document.getElementById('ipoSymbol')?.value?.trim();
  const issuePrice = Number(document.getElementById('ipoIssuePrice')?.value);
  const listingOpen = document.getElementById('ipoListingOpen')?.value;
  const listingDate = document.getElementById('ipoListingDate')?.value;
  const status = document.getElementById('ipoStatus');
  if (!symbol || !issuePrice) {
    if (status) status.textContent = 'Symbol and issue price are required.';
    return;
  }
  if (status) status.innerHTML = '<span class="spin"></span> Analysing listing day…';
  if (asPage) {
    showIpoDetailPage('<div class="muted small"><span class="spin"></span> Loading IPO analysis…</div>');
  }
  try {
    const body = { symbol, issuePrice };
    if (listingOpen) body.listingOpen = Number(listingOpen);
    if (listingDate) body.listingDate = listingDate;
    const data = await api('/ipo/analyze', { method: 'POST', body: JSON.stringify(body) });
    if (status) status.textContent = `Updated ${new Date(data.analysis.analyzedAt).toLocaleTimeString('en-IN')}`;
    const html = renderIpoAnalysis(data.analysis, data.quote);
    if (asPage) {
      showIpoDetailPage(html);
    } else {
      // Manual analyse from form — still use detail page so it is not buried under the board
      showIpoDetailPage(html);
    }
  } catch (err) {
    if (status) status.textContent = err.message;
    if (asPage) showIpoDetailPage(`<div class="muted small" style="color:var(--red);">${err.message}</div>`);
  }
}

function renderIpoAnalysis(a, quote) {
  if (!a) return '';
  const sigCls = a.signal === 'BUY' ? 'bullish' : (a.signal === 'AVOID' ? 'bearish' : 'neutral');
  const m = a.metrics || {};
  const p = a.plan || {};
  const er = p.entryRange || {};
  const tg = p.targets || {};
  return `
    <div class="card" style="padding:16px;">
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; align-items:center;">
        <div>
          <h3 style="margin:0;">${a.symbol} <span class="verdict-badge ${sigCls}" style="margin-left:8px;">${a.signal}</span></h3>
          <div class="muted small">Confidence ${a.confidence}/100 · Score ${a.score}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:22px; font-weight:700;">₹${m.price != null ? Number(m.price).toFixed(2) : '—'}</div>
          <div class="muted small">Issue ₹${m.issuePrice}${m.listingPremiumPct != null ? ` · ${m.listingPremiumPct >= 0 ? '+' : ''}${m.listingPremiumPct}% vs issue` : ''}</div>
        </div>
      </div>
      <p style="margin:12px 0; font-size:14px;">${a.explanation || ''}</p>
      ${a.reclaimSetup?.active || a.reclaimSetup?.watch ? `<div class="card" style="padding:10px; margin-bottom:10px; border-left:3px solid var(--accent,#6ea8fe);"><b>Reclaim / support watch</b><div class="muted small">${a.reclaimSetup.note || ''}</div><div class="muted small">Level ₹${a.reclaimSetup.level ?? '—'} · post-list high ₹${a.reclaimSetup.postListHigh ?? '—'} · low ₹${a.reclaimSetup.postListLow ?? '—'}</div></div>` : ''}
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; margin:12px 0;">
        <div class="card" style="padding:10px;"><div class="muted small">Ideal entry</div><b>₹${p.idealEntry ?? '—'}</b></div>
        <div class="card" style="padding:10px;"><div class="muted small">Entry range</div><b>₹${er.low ?? '—'} – ${er.high ?? '—'}</b></div>
        <div class="card" style="padding:10px;"><div class="muted small">Stop-loss</div><b>₹${p.stopLoss ?? '—'}</b></div>
        <div class="card" style="padding:10px;"><div class="muted small">T1 / T2 / T3</div><b>₹${tg.t1 ?? '—'} / ${tg.t2 ?? '—'} / ${tg.t3 ?? '—'}</b></div>
        <div class="card" style="padding:10px;"><div class="muted small">R:R to T2</div><b>${p.riskRewardToT2 != null ? p.riskRewardToT2 + ':1' : '—'}</b></div>
        <div class="card" style="padding:10px;"><div class="muted small">Upside / Downside</div><b>${p.expectedUpsidePct != null ? '+' + p.expectedUpsidePct + '%' : '—'} / ${p.expectedDownsidePct != null ? p.expectedDownsidePct + '%' : '—'}</b></div>
      </div>
      <div class="muted small" style="margin-bottom:6px;">VWAP ₹${m.vwap ?? '—'} · vs VWAP ${m.distFromVwapPct != null ? m.distFromVwapPct + '%' : '—'} · Day range ${m.dayRangePct != null ? m.dayRangePct + '%' : '—'} · Pressure ${m.buySellPressure != null ? m.buySellPressure : '—'} · Market ${m.marketDirection || '—'}</div>
      ${m.orderBookNote ? `<div class="muted small">${m.orderBookNote}</div>` : ''}
      ${p.trailingStop ? `<div class="muted small" style="margin-top:6px;">Trailing: ${p.trailingStop.rule}</div>` : ''}
      <div style="margin-top:10px;">
        ${(a.reasons || []).map((r) => `<div class="muted small">✓ ${r}</div>`).join('')}
        ${(a.risks || []).map((r) => `<div class="muted small" style="color:var(--red,#f87171);">⚠ ${r}</div>`).join('')}
      </div>
      <p class="muted small" style="margin-top:12px;">${a.disclaimer || ''}</p>
    </div>
  `;
}

async function saveIpoWatch() {
  const symbol = document.getElementById('ipoSymbol')?.value?.trim();
  const issuePrice = Number(document.getElementById('ipoIssuePrice')?.value);
  const listingOpen = document.getElementById('ipoListingOpen')?.value;
  const listingDate = document.getElementById('ipoListingDate')?.value;
  if (!symbol || !issuePrice) {
    toast('Symbol and issue price required');
    return;
  }
  try {
    const body = { symbol, issuePrice, alertOnBuy: true };
    if (listingOpen) body.listingOpen = Number(listingOpen);
    if (listingDate) body.listingDate = listingDate;
    await api('/ipo/watch', { method: 'POST', body: JSON.stringify(body) });
    toast(`${symbol.toUpperCase()} saved to IPO watch`);
    loadIpoWatchList();
  } catch (err) {
    toast(err.message);
  }
}

async function loadIpoWatchList() {
  const box = document.getElementById('ipoWatchBox');
  if (!box) return;
  try {
    const { items } = await api('/ipo/watch');
    if (!items?.length) {
      box.innerHTML = '<div class="muted small">No IPOs saved yet. Analyse one and click Save to IPO watch.</div>';
      return;
    }
    box.innerHTML = `
      <div style="font-weight:700; margin-bottom:8px;">📋 My IPO watch</div>
      ${items.map((it) => `
        <div style="padding:8px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
          <div>
            <b>${it.symbol}</b> · Issue ₹${it.issuePrice}
            ${it.lastSignal ? `<span class="verdict-badge ${it.lastSignal === 'BUY' ? 'bullish' : it.lastSignal === 'AVOID' ? 'bearish' : 'neutral'}" style="margin-left:6px; font-size:11px;">${it.lastSignal}</span>` : ''}
            <div class="muted small">${it.listingDate || ''} ${it.lastConfidence != null ? `· conf ${it.lastConfidence}` : ''}</div>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="ghost-btn small ipo-reanalyze" data-symbol="${it.symbol}" data-issue="${it.issuePrice}" data-open="${it.listingOpen ?? ''}">Analyse</button>
            <button type="button" class="ghost-btn small ipo-remove" data-id="${it.id}">Remove</button>
          </div>
        </div>
      `).join('')}
    `;
    box.querySelectorAll('.ipo-reanalyze').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('ipoSymbol').value = btn.dataset.symbol;
        document.getElementById('ipoIssuePrice').value = btn.dataset.issue;
        if (btn.dataset.open) document.getElementById('ipoListingOpen').value = btn.dataset.open;
        analyzeIpoDay();
      });
    });
    box.querySelectorAll('.ipo-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/ipo/watch/${btn.dataset.id}`, { method: 'DELETE' });
          loadIpoWatchList();
        } catch (err) {
          toast(err.message);
        }
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
}

async function scanIpoWatch() {
  const status = document.getElementById('ipoStatus');
  const box = document.getElementById('ipoResultBox');
  if (status) status.innerHTML = '<span class="spin"></span> Scanning IPO watch…';
  try {
    const { results, scannedAt } = await api('/ipo/watch/scan');
    if (status) status.textContent = `Scan done ${scannedAt ? new Date(scannedAt).toLocaleTimeString('en-IN') : ''}`;
    const buys = (results || []).filter((r) => r.analysis?.signal === 'BUY');
    if (box) {
      box.innerHTML = `
        <div class="card" style="padding:12px; margin-bottom:10px;">
          <div class="muted small">${results?.length || 0} IPO(s) scanned · ${buys.length} BUY signal(s)</div>
        </div>
        ${(results || []).map((r) => r.analysis ? renderIpoAnalysis(r.analysis) : `<div class="card" style="padding:10px;"><b>${r.symbol}</b> — ${r.error || 'no data'}</div>`).join('')}
      `;
    }
    loadIpoWatchList();
    if (buys.length) toast(`${buys.length} IPO BUY signal(s) on watch`);
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}


// ---------- Multi-Bagger Radar (1–2 deep conviction names) ----------
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'multibagger') loadMultibaggerLatest();
  });
});
document.getElementById('mbRefreshBtn')?.addEventListener('click', () => loadMultibaggerLatest());
document.getElementById('mbGenerateBtn')?.addEventListener('click', () => generateMultibagger());


function renderMultibaggerCard(p, idx) {
  const chg = p.changePct;
  const chgCls = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
  const id = `mb-detail-${p.symbol}-${idx || 0}`;
  const up5 = p.profitProbability5Pct;
  const dn2 = p.lossProbability2Pct;
  const n = p.probabilitySampleSize;
  const conv = Number(p.convictionScore) || 50;
  const softUp5 = up5 != null ? up5 : Math.max(8, Math.min(35, Math.round(conv * 0.28)));
  const softDn2 = dn2 != null ? dn2 : Math.max(15, Math.min(55, Math.round(60 - conv * 0.35)));
  const softLadder = [
    { label: '+5%', hist: up5, soft: up5 == null ? softUp5 : null },
    { label: '+10%', hist: null, soft: Math.max(5, Math.round(softUp5 * 0.7)) },
    { label: '+20%', hist: null, soft: Math.max(3, Math.round(softUp5 * 0.45)) },
    { label: '+50%', hist: null, soft: conv >= 70 ? 8 : (conv >= 55 ? 5 : 3) },
    { label: '−2%', hist: dn2, soft: dn2 == null ? softDn2 : null },
    { label: '−10%', hist: null, soft: Math.min(75, Math.round(softDn2 * 1.2)) },
  ];
  const border = ['#3dd68c','#6ea8fe','#c084fc','#fbbf24','#fb923c'][(idx || 0) % 5];
  return `
    <div class="card mb-row" style="padding:0; margin-bottom:10px; border-left:3px solid ${border}; overflow:hidden;">
      <button type="button" class="mb-toggle" data-target="${id}"
        style="width:100%; text-align:left; background:transparent; border:0; color:inherit; padding:14px 16px; cursor:pointer; display:flex; justify-content:space-between; gap:12px; align-items:center;">
        <div style="min-width:0;">
          <div style="font-weight:700; font-size:1.05rem;">#${p.rank || (idx + 1)} ${p.symbol}
            ${p.indexLabel ? `<span class="muted small">${p.indexLabel}</span>` : ''}
          </div>
          <div class="muted small">${p.companyName || ''} ${p.sector ? '· ' + p.sector : ''}</div>
          <div class="muted small" style="margin-top:2px;">
            Conviction <b>${p.convictionScore ?? '—'}</b>
            ${p.scorePillars ? ` · Q${p.scorePillars.fundamentalQuality} G${p.scorePillars.businessGrowth} V${p.scorePillars.valuation}` : ''}
            · ~${p.horizonDays || 180}d
          </div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div style="font-size:1.15rem; font-weight:700;">₹${p.latestPrice ?? p.priceAtResearch ?? '—'}</div>
          ${chg != null ? `<div class="change ${chgCls}" style="display:inline; font-size:12px;">${chg >= 0 ? '+' : ''}${Number(chg).toFixed(1)}%</div>` : ''}
          <div class="muted small mb-arrow" style="margin-top:2px;">Details ▾</div>
        </div>
      </button>
      <div id="${id}" class="mb-detail" style="display:none; padding:0 16px 14px; border-top:1px solid var(--border);">
        <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(100px,1fr)); gap:8px; margin-top:12px;">
          <div class="card" style="padding:8px;"><div class="muted small">Entry</div><b>₹${p.entryLow ?? '—'}–${p.entryHigh ?? '—'}</b></div>
          <div class="card" style="padding:8px;"><div class="muted small">SL</div><b>₹${p.stopLoss ?? '—'}</b></div>
          <div class="card" style="padding:8px;"><div class="muted small">T1</div><b>₹${p.target1 ?? '—'}</b></div>
          <div class="card" style="padding:8px;"><div class="muted small">Stretch</div><b>₹${p.target2 ?? '—'}</b></div>
          <div class="card" style="padding:8px;"><div class="muted small">R:R</div><b>${p.riskRewardRatio != null ? '1:' + p.riskRewardRatio : '—'}</b></div>
        </div>
        <div style="margin-top:12px; font-weight:600; font-size:13px;">Move odds</div>
        <div class="muted small" style="margin-bottom:6px;">n=${n ?? '—'} · hist = past signals · soft = estimate</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(90px,1fr)); gap:6px;">
          ${softLadder.map((row) => {
            const val = row.hist != null ? row.hist : row.soft;
            const tag = row.hist != null ? 'hist' : (row.soft != null ? 'soft' : '—');
            const col = String(row.label).startsWith('−')
              ? (val != null && val >= 45 ? 'var(--red,#f07178)' : (val != null && val >= 28 ? '#fbbf24' : '#6ea8fe'))
              : (val != null && val >= 50 ? 'var(--green,#3dd68c)' : 'inherit');
            return `<div class="card" style="padding:8px; text-align:center;">
              <div class="muted small">${row.label}</div>
              <b style="color:${col}">${val != null ? val + '%' : '—'}</b>
              <div class="muted small">${tag}</div>
            </div>`;
          }).join('')}
        </div>
        ${(p.passReasons || []).length || (p.failReasons || []).length ? `
        <div style="margin-top:12px; font-size:12px;">
          ${(p.passReasons || []).slice(0, 5).map((x) => `<div style="color:var(--green,#3dd68c);">✓ ${x}</div>`).join('')}
          ${(p.failReasons || []).slice(0, 3).map((x) => `<div style="color:var(--red,#f07178);">✗ ${x}</div>`).join('')}
        </div>` : ''}
        <p class="muted small" style="margin:10px 0 6px;">${(p.thesis || '').slice(0, 280)}</p>
        <button type="button" class="ghost-btn small mb-open" data-symbol="${p.symbol}">Full chart / analysis</button>
        <p class="muted small" style="margin-top:8px;">Research only — multi-bag not guaranteed.</p>
      </div>
    </div>`;
}

async function loadMultibaggerLatest() {
  const box = document.getElementById('mbResultBox');
  const status = document.getElementById('mbStatus');
  if (!box) return;
  // ensure fallen-strong container exists under multi-bagger
  let fallenHost = document.getElementById('mbFallenBox');
  if (!fallenHost && box.parentElement) {
    fallenHost = document.createElement('div');
    fallenHost.id = 'mbFallenBox';
    fallenHost.style.marginTop = '16px';
    box.parentElement.appendChild(fallenHost);
  }

  box.innerHTML = '<div class="muted small"><span class="spin"></span> Loading…</div>';
  try {
    const data = await api('/multibagger/latest');
    const picks = data.picks || [];
    if (status) {
      status.textContent = picks.length
        ? `Batch ${data.batchDate} · ${picks.length} name(s). ${data.note || ''}`
        : `No batch yet. ${data.note || ''} Click “Run deep research now” after market hours (scan is heavy).`;
    }
    const near = data.nearMisses || [];
    if (!picks.length) {
      box.innerHTML = `
        <div class="card" style="padding:14px;">
          <p class="muted">${data.note || 'Abhi koi multi-bagger batch nahi. Run deep research now dabao.'}</p>
          ${near.length ? `<div style="margin-top:12px;"><div style="font-weight:700;">Near-miss (almost multi-bagger — minor gate)</div>
            <div class="muted small" style="margin-bottom:8px;">Ye full bar clear nahi — isliye official pick nahi. Reason clear hai.</div>
            ${near.map((n, i) => `
              <div style="padding:10px 0; border-bottom:1px solid var(--border);">
                <b>#${i + 1} ${n.symbol}</b> · ₹${n.price ?? '—'} · conviction ${n.convictionScore ?? '—'}
                ${n.pillars ? ` · Q${n.pillars.fundamentalQuality}/G${n.pillars.businessGrowth}/V${n.pillars.valuation}/T${n.pillars.technicalTiming}` : ''}
                <div class="muted small" style="margin-top:4px; color:#fbbf24;">Ruka kyun: ${(n.reasons || []).join(' · ')}</div>
                ${n.missingData?.length ? `<div class="muted small">Missing: ${n.missingData.join(', ')}</div>` : ''}
              </div>`).join('')}
          </div>` : '<p class="muted small" style="margin-top:8px;">Koi near-miss bhi nahi — filters se koi close nahi aaya.</p>'}
        </div>`;
      return;
    }
    const top = picks.slice(0, 5);
    const removed = data.removed || [];
    box.innerHTML = `
      <div class="muted small" style="margin-bottom:8px;">Active multi-bagger · fund change tak list stable · click row for detail</div>
      ${top.length ? top.map((p, i) => renderMultibaggerCard(p, i)).join('') : '<div class="muted small">Abhi koi open multi-bagger pick nahi.</div>'}
      ${removed.length ? `
        <div class="card" style="padding:12px; margin-top:14px; border-left:3px solid #fbbf24;">
          <div style="font-weight:700;">List se hatae (pehle the)</div>
          <div class="muted small" style="margin-bottom:8px;">Fundamental drift / better set — reason + kya karna hai</div>
          ${removed.map((r) => `
            <div style="padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
              <b class="mb-open" data-symbol="${r.symbol}" style="cursor:pointer;">${r.symbol}</b>
              <span class="muted small">${r.removedDate || ''} · was batch ${r.batchDate || ''}</span>
              <div class="muted small" style="margin-top:2px; color:#fbbf24;"><b>Kyun hata:</b> ${r.removalReason || '—'}</div>
              <div class="muted small"><b>Kya karein:</b> ${r.actionGuidance || 'Thesis + SL se manage'}</div>
            </div>`).join('')}
        </div>` : ''}
      ${near.length ? `<details class="card" style="padding:12px; margin-top:12px;"><summary style="cursor:pointer; font-weight:600;">Near-miss (${near.length}) — not official</summary>
        ${near.map((n) => `<div class="muted small" style="padding:6px 0;"><b>${n.symbol}</b> · ${n.convictionScore ?? ''} — ${(n.reasons || []).join(' · ')}</div>`).join('')}
      </details>` : ''}
    `;
    box.querySelectorAll('.mb-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.target);
        if (!el) return;
        const open = el.style.display !== 'none';
        el.style.display = open ? 'none' : 'block';
        const ar = btn.querySelector('.mb-arrow');
        if (ar) ar.textContent = open ? 'Details ▾' : 'Hide ▴';
      });
    });
    box.querySelectorAll('.mb-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof loadSymbol === 'function') loadSymbol(btn.dataset.symbol, { fromView: 'multibagger' });
      });
    });
    loadFallenStrongPanel();
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
    loadFallenStrongPanel();
  }
}

async function loadFallenStrongPanel() {
  const host = document.getElementById('mbFallenBox');
  if (!host) return;
  const WINDOW_KEYS = ['3d', '5d', '15d', '1m', '3m', '6m'];
  const WINDOW_LABELS = { '3d': '3 din', '5d': '5 din', '15d': '15 din', '1m': '1 month', '3m': '3 month', '6m': '6 month' };
  let activeWindow = '1m';
  let cacheData = null;

  /** Soft path odds after a drop — research estimate, not guarantee */
  function pathOdds(r) {
    const fund = Number(r.fundScore) || 50;
    const drop = Math.abs(Number(r.dropPct) || 0);
    // Deeper drop + strong fund → more recovery chance; weak fund → more downside
    let recovery = Math.round(25 + (fund - 50) * 0.55 + Math.min(18, drop * 0.35));
    let furtherDown = Math.round(35 - (fund - 50) * 0.4 + Math.min(15, drop * 0.25));
    recovery = Math.max(12, Math.min(62, recovery));
    furtherDown = Math.max(12, Math.min(55, furtherDown));
    let sideways = 100 - recovery - furtherDown;
    if (sideways < 15) {
      const fix = 15 - sideways;
      recovery = Math.max(12, recovery - Math.ceil(fix / 2));
      furtherDown = Math.max(12, furtherDown - Math.floor(fix / 2));
      sideways = 100 - recovery - furtherDown;
    }
    return { recovery, furtherDown, sideways };
  }

  host.innerHTML = `
    <div class="card" style="padding:14px;">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
        <div>
          <div style="font-weight:700;">📉 Fallen + fundamentally strong</div>
          <div class="muted small">Har index me <b>max 3</b> · fund strong + drop. Click section to open/close. Path % = soft estimate.</div>
        </div>
        <button type="button" class="ghost-btn small" id="mbFallenRunBtn">Scan now</button>
      </div>
      <div id="mbFallenFilters" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px;"></div>
      <div id="mbFallenResult" class="muted small" style="margin-top:12px;">Filter choose karo ya Scan now…</div>
    </div>`;

  const filterBox = document.getElementById('mbFallenFilters');
  filterBox.innerHTML = WINDOW_KEYS.map((k) =>
    `<button type="button" class="ghost-btn small fs-win" data-win="${k}" style="border-radius:999px;">${WINDOW_LABELS[k]}</button>`
  ).join('');

  const paintFilters = () => {
    filterBox.querySelectorAll('.fs-win').forEach((btn) => {
      const on = btn.dataset.win === activeWindow;
      btn.style.background = on ? 'rgba(110,168,254,.25)' : '';
      btn.style.fontWeight = on ? '700' : '';
    });
  };

  const renderFallen = (data) => {
    cacheData = data;
    const res = document.getElementById('mbFallenResult');
    if (!res) return;
    const order = ['nifty50', 'midcap', 'smallcap'];
    const labels = { nifty50: 'Nifty 50', midcap: 'Midcap', smallcap: 'Smallcap' };
    const colors = { nifty50: '#6ea8fe', midcap: '#c084fc', smallcap: '#3dd68c' };
    let html = `<div class="muted small" style="margin-bottom:8px;">Window: <b>${WINDOW_LABELS[activeWindow]}</b> · max 3 / index · ${data.computedAt ? new Date(data.computedAt).toLocaleString('en-IN') : ''}</div>`;
    html += `<div class="muted small" style="margin-bottom:10px;">${data.note || ''} Path % soft research estimate — guarantee nahi.</div>`;
    for (const k of order) {
      const winMap = (data.byIndex && data.byIndex[k]) || {};
      const rows = Array.isArray(winMap) ? winMap : (winMap[activeWindow] || []);
      const secId = `fs-sec-${k}`;
      html += `
        <div style="margin-top:12px; border-left:3px solid ${colors[k]}; border-radius:8px; overflow:hidden; background:rgba(255,255,255,0.02);">
          <button type="button" class="fs-sec-toggle" data-target="${secId}"
            style="width:100%; text-align:left; background:transparent; border:0; color:inherit; padding:12px 12px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:700; color:${colors[k]};">${labels[k]} · ${rows.length}/3</span>
            <span class="muted small fs-sec-arrow">▾ open</span>
          </button>
          <div id="${secId}" style="display:block; padding:0 12px 10px;">`;
      // Which other windows also list this symbol (same index)
      const presence = {};
      const winMapAll = (data.byIndex && data.byIndex[k]) || {};
      for (const wk of WINDOW_KEYS) {
        const list = Array.isArray(winMapAll) ? [] : (winMapAll[wk] || []);
        for (const x of list) {
          if (!presence[x.symbol]) presence[x.symbol] = [];
          presence[x.symbol].push(wk);
        }
      }
      if (!rows.length) {
        html += `<div class="muted small">Is window me fund-strong + enough drop nahi (force fill nahi).</div>`;
      } else {
        for (const r of rows.slice(0, 3)) {
          const o = pathOdds(r);
          const also = (presence[r.symbol] || []).filter((w) => w !== activeWindow);
          const allWins = presence[r.symbol] || [activeWindow];
          const presenceLabel = allWins.length > 1
            ? `Present in ${allWins.length} filters: ${allWins.map((w) => WINDOW_LABELS[w] || w).join(', ')}`
            : `Sirf ${WINDOW_LABELS[activeWindow]} me`;
          html += `<div style="padding:10px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <b class="fs-sym" data-symbol="${r.symbol}" style="cursor:pointer;">${r.symbol}</b>
            <span class="muted small">${r.companyName ? ' ' + r.companyName : ''} · ${r.sector || ''}</span>
            ${allWins.length > 1 ? `<div style="margin-top:4px;"><span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:rgba(110,168,254,.18); border:1px solid rgba(110,168,254,.35);">${presenceLabel}</span></div>` : `<div class="muted small" style="margin-top:2px;">${presenceLabel}</div>`}
            <div style="margin-top:2px;">
              <span>₹${r.price != null ? Number(r.price).toFixed(1) : '—'}</span>
              <span class="change down" style="display:inline; margin-left:8px; font-weight:700;">${r.dropPct}%</span>
              <span class="muted small"> in ${WINDOW_LABELS[activeWindow]}</span>
              ${also.length ? `<span class="muted small"> · also ${also.map((w) => WINDOW_LABELS[w] || w).join(', ')}</span>` : ''}
            </div>
            <div class="muted small">Fund ${r.fundScore} · ROE ${r.roe != null ? Number(r.roe).toFixed(1) + '%' : '—'} · Debt ${r.debtToEquity != null ? Number(r.debtToEquity).toFixed(2) : '—'} · ${(r.reasons || []).slice(0, 2).join(' · ')}</div>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:8px;">
              <div class="card" style="padding:8px; text-align:center;">
                <div class="muted small">Recovery / up</div>
                <b style="color:var(--green,#3dd68c);">${o.recovery}%</b>
              </div>
              <div class="card" style="padding:8px; text-align:center;">
                <div class="muted small">Sideways range</div>
                <b style="color:#fbbf24;">${o.sideways}%</b>
              </div>
              <div class="card" style="padding:8px; text-align:center;">
                <div class="muted small">Aur niche</div>
                <b style="color:var(--red,#f07178);">${o.furtherDown}%</b>
              </div>
            </div>
          </div>`;
        }
      }
      html += `</div></div>`;
    }
    res.innerHTML = html;
    res.querySelectorAll('.fs-sym').forEach((el) => {
      el.addEventListener('click', () => {
        if (typeof loadSymbol === 'function') loadSymbol(el.dataset.symbol, { fromView: 'multibagger' });
      });
    });
    res.querySelectorAll('.fs-sec-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.target);
        if (!el) return;
        const open = el.style.display !== 'none';
        el.style.display = open ? 'none' : 'block';
        const ar = btn.querySelector('.fs-sec-arrow');
        if (ar) ar.textContent = open ? '▸ closed' : '▾ open';
      });
    });
  };

  filterBox.querySelectorAll('.fs-win').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeWindow = btn.dataset.win;
      paintFilters();
      if (cacheData) renderFallen(cacheData);
    });
  });
  paintFilters();

  document.getElementById('mbFallenRunBtn')?.addEventListener('click', async () => {
    const res = document.getElementById('mbFallenResult');
    if (res) res.innerHTML = '<span class="spin"></span> Full scan (Nifty+Mid+Small) — 2–5 min…';
    try {
      await api('/multibagger/fallen-strong/run', { method: 'POST', body: '{}' });
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const data = await api('/multibagger/fallen-strong');
          if (data?.byIndex && data.computedAt) {
            renderFallen(data);
            if (!data.fromCache || i > 2) return;
          }
        } catch (_) {}
      }
    } catch (err) {
      if (res) res.innerHTML = `<span style="color:var(--red);">${err.message}</span>`;
    }
  });

  try {
    const data = await api('/multibagger/fallen-strong');
    if (data?.byIndex) renderFallen(data);
    else {
      const res = document.getElementById('mbFallenResult');
      if (res) res.textContent = 'Pehli baar Scan now dabao.';
    }
  } catch (_) {
    const res = document.getElementById('mbFallenResult');
    if (res) res.textContent = 'Scan now dabao.';
  }
}

async function generateMultibagger() {
  const status = document.getElementById('mbStatus');
  const box = document.getElementById('mbResultBox');
  const jobId = `mb-${Date.now()}`;
  if (status) status.innerHTML = '<span class="spin"></span> Starting deep research…';
  if (box) {
    box.innerHTML = `
      <div class="card" style="padding:14px;" id="mbProgressCard">
        <div style="font-weight:700; margin-bottom:8px;">🔬 Deep research in progress</div>
        <div class="muted small" style="margin-bottom:8px;">Har stock alag se check ho raha hai (technicals, R:R, history odds). Cache skip — real scan. 5–15 min lag sakte hain.</div>
        <div style="background:var(--panel-2); border-radius:8px; height:12px; overflow:hidden; margin-bottom:8px;">
          <div id="mbProgressBar" style="height:100%; width:2%; background:var(--accent,#6ea8fe); transition:width .35s;"></div>
        </div>
        <div class="muted small" id="mbProgressMsg">Starting…</div>
        <div class="muted small" id="mbProgressDetail" style="margin-top:4px;"></div>
        <div style="margin-top:10px; font-weight:600; font-size:12px;">Recently scanned</div>
        <div id="mbRecentSymbols" style="margin-top:6px; min-height:36px;"></div>
        <div id="mbProgressLogs" class="muted small" style="margin-top:12px; max-height:180px; overflow:auto; font-family:monospace; font-size:11px; line-height:1.45;"></div>
      </div>`;
  }
  let pollTimer = null;
  const poll = async () => {
    try {
      const job = await api(`/multibagger/progress/${jobId}`);
      const bar = document.getElementById('mbProgressBar');
      const msg = document.getElementById('mbProgressMsg');
      const det = document.getElementById('mbProgressDetail');
      const logs = document.getElementById('mbProgressLogs');
      const recentBox = document.getElementById('mbRecentSymbols');
      if (bar) bar.style.width = `${Math.max(2, job.percent || 0)}%`;
      if (msg) msg.textContent = job.message || '';
      if (det) {
        const scan = (job.scanTotal != null)
          ? ` · ${job.scanCompleted ?? 0}/${job.scanTotal} stocks`
          : '';
        det.textContent = job.detail
          ? `Currently: ${job.detail}${scan}`
          : (job.phase ? `Phase: ${job.phase}${scan}` : '');
      }
      if (recentBox && Array.isArray(job.recent)) {
        recentBox.innerHTML = job.recent.length
          ? job.recent.map((s, i) => {
              const isLast = i === job.recent.length - 1;
              return `<span style="display:inline-block; margin:3px 4px; padding:4px 8px; border-radius:999px; font-size:12px; background:${isLast ? 'rgba(110,168,254,.25)' : 'var(--panel-2)'}; border:1px solid var(--border); ${isLast ? 'font-weight:700;' : ''}">${s}</span>`;
            }).join('')
          : '<span class="muted small">Waiting for first symbol…</span>';
      }
      if (logs && job.logs?.length) {
        logs.innerHTML = job.logs.slice(-20).map((l) => `<div>${l.text}</div>`).join('');
        logs.scrollTop = logs.scrollHeight;
      }
      if (status) status.textContent = `${job.percent || 0}% — ${job.message || 'Working…'}`;
    } catch (_) {}
  };
  pollTimer = setInterval(poll, 800);
  poll();
  try {
    const result = await api('/multibagger/generate', { method: 'POST', body: JSON.stringify({ force: false }) });
    clearInterval(pollTimer);
    await poll();
    if (status) {
      status.textContent = result.skipped
        ? (result.note || result.reason || 'List unchanged — fundamentals still OK')
        : (result.count
          ? `Done: ${result.count} pick(s) ${(result.symbols || []).join(', ')} · ${result.batchDate}`
          : (result.note || 'No candidates cleared the bar.'));
    }
    await loadMultibaggerLatest();
  } catch (err) {
    clearInterval(pollTimer);
    if (status) status.textContent = err.message;
  }
}


// ---------- Earnings Intelligence Center ----------
document.querySelectorAll('.main-tabs .tab-btn').forEach((btn) => {
  if (btn.dataset.view === 'results-calendar') {
    btn.addEventListener('click', () => loadResultsCalendar());
  }
});

let _rcData = null;
let _rcTab = 'today';

function rcFmtDate(d) {
  if (!d) return '—';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (_) { return d; }
}

function renderResultsCalendar(data) {
  _rcData = data;
  const box = document.getElementById('rcBox');
  const tabs = document.getElementById('rcTabs');
  const status = document.getElementById('rcStatus');
  const fresh = document.getElementById('rcFresh');
  if (!box) return;

  const counts = {
    today: (data.today || []).length,
    next24h: (data.next24h || data.near7 || []).filter((r) => r.daysUntil != null && r.daysUntil <= 1).length,
    upcoming: (data.near7 || []).length + (data.near15 || []).length + (data.near30 || []).length,
    released: (data.released || data.pastFew || []).length,
    all: (data.all || []).length,
  };
  // fix next24 count from data.next24h
  counts.next24h = (data.next24h || []).length;

  if (tabs) {
    const tabDefs = [
      ['today', `Today (${counts.today})`],
      ['next24h', `Next 24h (${counts.next24h})`],
      ['upcoming', `Upcoming (${counts.upcoming})`],
      ['released', `Released (${counts.released})`],
      ['all', `All (${counts.all})`],
    ];
    tabs.innerHTML = tabDefs.map(([k, lab]) =>
      `<button type="button" class="golden-tier-tab ${_rcTab === k ? 'active' : ''}" data-rc-tab="${k}">${lab}</button>`
    ).join('');
    tabs.querySelectorAll('[data-rc-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _rcTab = btn.dataset.rcTab;
        renderResultsCalendar(_rcData);
      });
    });
  }

  if (status) {
    status.textContent = data.fromCache
      ? `Cache hit · ${data.withDateCount || 0} upcoming dates · ${data.releasedCount || 0} released window`
      : `Fresh scan · ${data.scannedCount || 0} symbols`;
  }
  if (fresh) {
    fresh.textContent = data.scannedAt
      ? `As of ${new Date(data.scannedAt).toLocaleString('en-IN')}${data.bgRefresh ? ' · bg refresh…' : ''}`
      : '';
  }

  let rows = [];
  if (_rcTab === 'today') rows = data.today || [];
  else if (_rcTab === 'next24h') rows = data.next24h || [];
  else if (_rcTab === 'upcoming') {
    rows = [...(data.near7 || []), ...(data.near15 || []), ...(data.near30 || []), ...(data.later || [])];
  } else if (_rcTab === 'released') rows = data.released || data.pastFew || [];
  else rows = data.all || [];

  const q = (document.getElementById('rcSearch')?.value || '').trim().toUpperCase();
  const vf = document.getElementById('rcVerdictFilter')?.value || '';
  if (q) rows = rows.filter((r) => (r.symbol || '').includes(q) || (r.companyName || '').toUpperCase().includes(q));
  if (vf) rows = rows.filter((r) => (r.verdict?.verdict || '') === vf);

  if (!rows.length) {
    box.innerHTML = `<div class="muted small">Is tab/filter me koi result nahi.
      ${data.note ? `<div style="margin-top:6px;">${data.note}</div>` : ''}
      Full rescan se dates fill ho sakti hain.</div>`;
    return;
  }

  box.innerHTML = rows.map((r, i) => {
    const v = r.verdict || {};
    const bm = r.lastResultBeatMiss;
    const bmCls = bm?.label === 'Beat' ? 'beat' : bm?.label === 'Miss' ? 'miss' : 'inline';
    return `
      <div class="rc-card" data-symbol="${r.symbol}">
        <div class="rc-top">
          <div>
            <b>${r.symbol}</b>
            <span class="muted small">${r.companyName || ''}${r.sector ? ' · ' + r.sector : ''}</span>
            ${bm ? `<span class="rc-badge ${bmCls}">${bm.label}${bm.surprisePct != null ? ' ' + bm.surprisePct + '%' : ''}</span>` : ''}
            ${v.verdict ? `<span class="rc-verdict ${v.verdict}">${v.verdict}</span>` : ''}
          </div>
          <div style="text-align:right;" class="muted small">
            ${r.nextEarnings != null ? `<div>Next: <b>${rcFmtDate(r.nextEarnings)}</b> (${r.daysUntil == null ? '—' : r.daysUntil === 0 ? 'today' : r.daysUntil + 'd'})</div>` : '<div>Next: —</div>'}
            ${r.lastResultDate ? `<div>Last: ${rcFmtDate(r.lastResultDate)}${r.daysSinceRelease != null ? ` · ${r.daysSinceRelease}d ago` : ''}</div>` : ''}
          </div>
        </div>
        <div class="muted small" style="margin-top:6px;">
          Est EPS ${r.earningsEstimate != null ? r.earningsEstimate : '—'}
          ${r.lastEpsActual != null ? ` · Last actual ${r.lastEpsActual}` : ''}
          ${r.lastEpsEstimate != null ? ` vs est ${r.lastEpsEstimate}` : ''}
          · src ${r.source || 'yahoo'} · conf ${v.confidence || '—'}
        </div>
        <button type="button" class="ghost-btn small rc-exp" data-i="${i}">Details</button>
        <button type="button" class="ghost-btn small rc-open" data-symbol="${r.symbol}">View Analysis</button>
        <div class="rc-detail" id="rc-d-${i}">
          <div><b>Why verdict:</b> ${(v.reasons || []).join(' · ') || '—'}</div>
          <div><b>Risks:</b> ${(v.risks || []).join(' · ') || '—'}</div>
          <div class="muted small">${v.note || ''}</div>
          <div style="margin-top:6px;"><b>History (EPS):</b></div>
          ${(r.history || []).slice(0, 5).map((h) =>
            `<div class="muted small">${h.date || h.quarter || '—'} · act ${h.epsActual ?? '—'} est ${h.epsEstimate ?? '—'}
            ${h.surprisePercent != null ? ' · surprise ' + h.surprisePercent : ''}</div>`
          ).join('') || '<div class="muted small">No history</div>'}
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.rc-exp').forEach((btn) => {
    btn.addEventListener('click', () => document.getElementById('rc-d-' + btn.dataset.i)?.classList.toggle('open'));
  });
  box.querySelectorAll('.rc-open').forEach((btn) => {
    btn.addEventListener('click', () => loadSymbol(btn.dataset.symbol, { fromView: 'results-calendar' }));
  });
}

async function loadResultsCalendar() {
  const box = document.getElementById('rcBox');
  const status = document.getElementById('rcStatus');
  if (box) box.innerHTML = '<span class="spin"></span> Loading earnings cache…';
  try {
    const data = await api('/results-calendar');
    renderResultsCalendar(data);
    if (data.bgRefresh) {
      try { api('/results-calendar/nudge', { method: 'POST', body: '{}' }).catch(() => {}); } catch (_) {}
    }
  } catch (err) {
    if (box) box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
    if (status) status.textContent = err.message;
  }
}

async function forceResultsCalendarRefresh() {
  const status = document.getElementById('rcStatus');
  const prog = document.getElementById('rcProg');
  if (prog) prog.style.display = 'block';
  const jobId = 'rc-' + Date.now();
  if (status) status.textContent = 'Full rescan…';
  const timer = setInterval(async () => {
    try {
      const job = await api(`/results-calendar/progress/${jobId}`);
      const m = document.getElementById('rcProgMsg');
      const l = document.getElementById('rcProgLogs');
      if (m) m.textContent = `${job.percent || 0}% — ${job.message || ''}`;
      if (l && job.logs?.length) l.innerHTML = job.logs.slice(-12).map((x) => `<div>${x.text || x}</div>`).join('');
    } catch (_) {}
  }, 900);
  try {
    const data = await api('/results-calendar/refresh', {
      method: 'POST',
      body: JSON.stringify({ jobId }),
    });
    clearInterval(timer);
    if (prog) prog.style.display = 'none';
    renderResultsCalendar(data);
  } catch (err) {
    clearInterval(timer);
    if (status) status.textContent = err.message;
  }
}

document.getElementById('rcLoadBtn')?.addEventListener('click', () => loadResultsCalendar());
document.getElementById('rcForceBtn')?.addEventListener('click', () => forceResultsCalendarRefresh());
document.getElementById('rcSearch')?.addEventListener('input', () => { if (_rcData) renderResultsCalendar(_rcData); });
document.getElementById('rcVerdictFilter')?.addEventListener('change', () => { if (_rcData) renderResultsCalendar(_rcData); });

// ---------- Nifty Support & Pulse ----------
document.getElementById('niftyDeepRefreshBtn')?.addEventListener('click', () => loadNiftyDeepDive());

async function loadNiftyDeepDive() {
  const box = document.getElementById('niftyDeepBox');
  if (!box) return;
  box.innerHTML = '<p class="muted small"><span class="spin"></span> Nifty map + history load ho raha hai…</p>';
  try {
    const d = await api('/market/nifty-deep-dive');
    const fmtPct = (v, dig = 2) => {
      if (v == null || !Number.isFinite(Number(v))) return '—';
      const n = Number(v);
      return `${n >= 0 ? '+' : ''}${n.toFixed(dig)}%`;
    };
    const fmtN = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

    const lvl = (rows, kind) => {
      if (!rows?.length) {
        return kind === 'support'
          ? '<div class="muted small">Clear neeche wala shelf thin hai — price local low ke paas ho sakta hai. Structural lows refresh ke baad aane chahiye.</div>'
          : '<div class="muted small">Upar resistance list empty.</div>';
      }
      return rows.map((r) => `
        <div style="padding:8px 0; border-bottom:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; gap:8px;">
            <b>${fmtN(r.level)}</b>
            <span class="muted small">${r.distancePct != null ? fmtPct(r.distancePct) + ' door' : ''}</span>
          </div>
          <div class="muted small">${r.name || ''}</div>
          ${r.plain ? `<div class="muted small" style="margin-top:2px;">👉 ${r.plain}</div>` : ''}
        </div>`).join('');
    };

    const w = d.scenarios?.biasWeights || {};
    const tm = d.todayMove || {};
    const sc = d.scenarios || {};
    const chart = d.chart || [];
    let spark = '';
    if (chart.length > 5) {
      const closes = chart.map((c) => c.close);
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const wdt = 320, hgt = 64;
      const pts = closes.map((c, i) => {
        const x = (i / (closes.length - 1)) * wdt;
        const y = hgt - ((c - min) / (max - min || 1)) * (hgt - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const supports = (d.supportLevels || []).slice(0, 3);
      const lines = supports.map((s) => {
        if (s.level < min || s.level > max) return '';
        const y = hgt - ((s.level - min) / (max - min || 1)) * (hgt - 4) - 2;
        return `<line x1="0" y1="${y}" x2="${wdt}" y2="${y}" stroke="rgba(61,214,140,.45)" stroke-width="1" stroke-dasharray="4 3"/>`;
      }).join('');
      spark = `<svg viewBox="0 0 ${wdt} ${hgt}" width="100%" height="72" style="background:rgba(0,0,0,.15); border-radius:8px;">
        ${lines}
        <polyline fill="none" stroke="#6ea8fe" stroke-width="1.5" points="${pts}"/>
      </svg>
      <div class="muted small">Pichhle ~60 trading days. Hara dashed = support jo is window me dikhe.</div>`;
    }

    const histBanner = (d.historyFrom || d.historyStudy?.historyFrom)
      ? `<div class="muted small" style="margin-bottom:10px; padding:8px; border-radius:8px; background:rgba(110,168,254,.08);">
          <b>${d.symbol || _chartReaderIndex}</b> · history ${d.historyFrom || d.historyStudy?.historyFrom || '—'} → ${d.historyTo || d.historyStudy?.historyTo || '—'}
          · <b>${d.historyBars || d.historyStudy?.historyBars || '—'}</b> daily bars (upto ~25y where Yahoo has data)
        </div>`
      : '';
    const narr = (d.narrative || []).map((line) => `<li style="margin-bottom:6px;">${line}</li>`).join('');
    const healthyTxt = tm.healthyPullback === true
      ? 'Zyada tar normal giraawat / pullback jaisa (full panic crash nahi).'
      : tm.healthyPullback === false
        ? 'Aaj ka move bhaari / stress wala — seedha knife catch mat karo, support hold ka wait better.'
        : 'Beech ka case — na bilkul soft dip, na full crash stamp.';

    const hs = d.historyStudy;
    const path = d.pathStory;
    let histBlock = '';

    // —— How to read (new user guide) ——
    const guide = `
      <div class="card" style="padding:14px; margin-top:12px; border-left:3px solid #6ea8fe;">
        <div style="font-weight:700; margin-bottom:8px;">🧭 Ye section kaise padhein (simple)</div>
        <ol style="margin:0; padding-left:18px; font-size:13px; line-height:1.55;">
          <li><b>Upar story</b> — aaj index kahan hai, support kahan, bounce vs aur girne ka lean.</li>
          <li><b>Is saal / 20–200 din</b> — abhi tak ka rasta: kitna gira, kitna aaya (numbers, not prediction).</li>
          <li><b>Purane milte-julte din</b> — history me jab chart isse milta-julta tha, <i>uske baad</i> 20/60 din me kya hua. Ye past rhyme hai, future guarantee nahi.</li>
          <li><b>Badi giraawat</b> — purane bade peak→bottom episodes: kitne din me bottom, phir bounce.</li>
        </ol>
        <p class="muted small" style="margin:8px 0 0;">Red = pressure / girawat side · Green = recovery / bounce side. Koi bhi % “pakka profit” nahi bolta.</p>
      </div>`;

    // —— 2026 / path story ——
    let pathBlock = '';
    if (path) {
      const r = path.returns || {};
      const y = path.year || '';
      const rp = path.recentPeak || {};
      pathBlock = `
        <div class="card" style="padding:14px; margin-top:12px;">
          <div style="font-weight:700; margin-bottom:6px;">📍 Abhi tak ka rasta (${y || 'year'} + windows)</div>
          <p class="muted small" style="margin:0 0 10px;">Yeh batata hai <b>kaise yahan tak aaye</b> — prediction nahi, sirf map.</p>
          <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px; margin-bottom:12px;">
            <div class="card" style="padding:10px; text-align:center;">
              <div class="muted small">${y} YTD</div>
              <b class="${(path.ytdPct||0)>=0?'change up':'change down'}" style="display:inline; font-size:1.1rem;">${path.ytdPct!=null?((path.ytdPct>=0?'+':'')+Number(path.ytdPct).toFixed(2)+'%'):'—'}</b>
              <div class="muted small">Year high se ${path.yearFromHighPct!=null?Number(path.yearFromHighPct).toFixed(2)+'%':'—'}</div>
            </div>
            ${[['20d', r.d20],['40d', r.d40],['100d', r.d100],['200d', r.d200]].map(([lab,v]) => `
              <div class="card" style="padding:10px; text-align:center;">
                <div class="muted small">Last ${lab} net</div>
                <b class="${(v||0)>=0?'change up':'change down'}" style="display:inline;">${v!=null?((v>=0?'+':'')+Number(v).toFixed(2)+'%'):'—'}</b>
              </div>`).join('')}
          </div>
          ${path.yearHighDate ? `<div class="muted small" style="margin-bottom:6px;">${y} high ~<b>${path.yearHighDate}</b> · low ~<b>${path.yearLowDate || '—'}</b></div>` : ''}
          ${rp.date ? `<div style="font-size:13px; margin-top:8px; padding:10px; border-radius:8px; background:rgba(0,0,0,.2);">
            <b>Recent peak → ab</b><br/>
            Peak <b>${rp.date}</b> (~${fmtN(rp.price)}) se ab <span class="change down" style="display:inline;">${rp.fromPeakPct}%</span>.<br/>
            Beech ka low <b>${rp.troughDate}</b> (~${fmtN(rp.troughPrice)}) · peak→low <span class="change down" style="display:inline;">${rp.peakToTroughPct}%</span> (${rp.daysPeakToTrough} sessions).<br/>
            Us low se ab recovery <span class="change up" style="display:inline;">${rp.troughToNowPct}%</span> (${rp.daysTroughToNow} sessions).
          </div>` : ''}
          ${(path.plainLines||[]).length ? `<ul style="margin:10px 0 0; padding-left:18px; font-size:13px;">${path.plainLines.map(l=>`<li style="margin-bottom:4px;">${l}</li>`).join('')}</ul>` : ''}
          ${(path.pastRecoveries||[]).length ? `
            <div style="margin-top:12px; font-weight:600; font-size:13px;">Purani giraawat ke baad naya high kab?</div>
            <p class="muted small">Jab index ~10%+ gira, bottom ke baad purane peak se upar jane me kitne sessions lage.</p>
            <div style="overflow-x:auto;">
              <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <thead><tr class="muted small">
                  <th style="text-align:left; padding:6px;">Peak → Bottom</th>
                  <th>Girawat</th>
                  <th>Bottom → new high</th>
                </tr></thead>
                <tbody>
                  ${path.pastRecoveries.map(e => `
                    <tr style="border-top:1px solid var(--border);">
                      <td style="padding:6px;">${e.peakDate} → ${e.troughDate}</td>
                      <td class="change down" style="display:table-cell; text-align:center;">${e.drawdownPct}%</td>
                      <td style="text-align:center;">${e.recovered ? (e.daysTroughToNewHigh + ' sessions') : 'Abhi tak nahi / window bahar'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>` : ''}
        </div>`;
    }

    if (hs?.summary) {
      const s = hs.summary;
      histBlock = `
        <div class="card" style="padding:14px; margin-top:12px; background:rgba(110,168,254,.05);">
          <div style="font-weight:700; margin-bottom:6px;">📜 Purane milte-julte din (analog)</div>
          <p class="muted small" style="margin:0 0 8px;">
            System ne history me <b>aisi hi shape</b> wale din dhundhe (giraawat depth + trend milta-julta).
            Neeche unke <b>baad</b> kya hua — isliye columns “baad 20d / 60d” hain.
            <b>Future pakka nahi</b> — sirf “pehle aisa hone par average kya hua”.
          </p>
          <ul style="margin:0 0 10px; padding-left:18px; font-size:13px;">
            <li><b>${s.sample || 0}</b> milte-julte purane din.</li>
            <li>Unke baad 20 din: avg extra girawat <b>${s.avgMaxDrawdownNext20d ?? '—'}%</b>, avg bounce <b>${s.avgMaxBounceNext20d != null ? ((s.avgMaxBounceNext20d>=0?'+':'')+s.avgMaxBounceNext20d) : '—'}%</b>.</li>
            <li>~${s.shareFurtherDrop3pctIn20d ?? '—'}% cases me 20 din me aur ≥3% gira · ~${s.shareBounce3pctIn20d ?? '—'}% me ≥3% bounce.</li>
            <li>Median sessions: +5% recovery ~<b>${s.medianDaysToPlus5 ?? '—'}</b> · extra −5% ~<b>${s.medianDaysToMinus5 ?? '—'}</b>.</li>
          </ul>
          <p class="muted small" style="margin:0 0 6px;"><b>Table padho aise:</b> Purana din = kab similar tha · Baad max fall = uske baad 20d me sabse zyada pressure · Baad bounce = us window me max up · +5%/−5% din = kitne sessions me wo move.</p>
      `;
      if (hs.analogs?.length) {
        const rows = hs.analogs.slice(0, 8).map((a) => {
          const f20 = a.forward?.d20;
          const f60 = a.forward?.d60;
          const tab = a.features
            ? `High se ${a.features.dd60 ?? '—'}% · 20d ${a.features.ret20 ?? '—'}%`
            : '';
          return `<tr style="border-top:1px solid var(--border); font-size:12px;">
            <td style="padding:6px;">${a.date}</td>
            <td>${fmtN(a.price)}</td>
            <td class="muted small">${tab}</td>
            <td style="text-align:center;"><span class="change down" style="display:inline; padding:2px 6px; border-radius:4px; background:rgba(240,113,120,.15);">${f20?.maxDrawdownPct != null ? f20.maxDrawdownPct + '%' : '—'}</span></td>
            <td style="text-align:center;"><span class="change up" style="display:inline; padding:2px 6px; border-radius:4px; background:rgba(61,214,140,.15);">${f20?.maxBouncePct != null ? ((f20.maxBouncePct>=0?'+':'')+f20.maxBouncePct+'%') : '—'}</span></td>
            <td style="text-align:center;">${f60?.endReturnPct != null ? ((f60.endReturnPct>=0?'+':'')+f60.endReturnPct+'%') : '—'}</td>
            <td style="text-align:center;" class="muted small">${a.forward?.daysToPlus5 ?? '—'} / ${a.forward?.daysToMinus5 ?? '—'}</td>
          </tr>`;
        }).join('');
        histBlock += `
          <div style="overflow-x:auto; margin-top:8px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead><tr class="muted small">
                <th style="text-align:left; padding:6px;">Purana din</th>
                <th style="text-align:left;">Price</th>
                <th style="text-align:left;">Tab kaisa tha</th>
                <th>Baad max fall 20d</th>
                <th>Baad bounce 20d</th>
                <th>60d baad</th>
                <th>+5% / −5% din</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }
      if (hs.majorDrawdowns?.length) {
        const dd = hs.majorDrawdowns.slice(-8).reverse().map((e) => `
          <tr style="border-top:1px solid var(--border); font-size:12px;">
            <td style="padding:6px;">${e.peakDate} → ${e.troughDate}</td>
            <td style="text-align:center;"><span class="change down" style="display:inline; padding:2px 6px; border-radius:4px; background:rgba(240,113,120,.15);">${e.drawdownPct}%</span></td>
            <td style="text-align:center;">${e.sessionsPeakToTrough} din</td>
            <td style="text-align:center;"><span class="change up" style="display:inline;">${e.bounce20dFromTroughPct != null ? ((e.bounce20dFromTroughPct>=0?'+':'')+e.bounce20dFromTroughPct+'%') : '—'}</span></td>
            <td style="text-align:center;"><span class="change up" style="display:inline;">${e.bounce60dFromTroughPct != null ? ((e.bounce60dFromTroughPct>=0?'+':'')+e.bounce60dFromTroughPct+'%') : '—'}</span></td>
          </tr>`).join('');
        histBlock += `
          <div style="margin-top:14px; font-weight:600;">Badi giraawat (peak → bottom)</div>
          <p class="muted small" style="margin:4px 0 8px;">History ki badi drops: top se bottom kitna, kitne din, bottom ke baad 20/60 din me bounce.</p>
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse;">
              <thead><tr class="muted small">
                <th style="text-align:left; padding:6px;">Peak → Bottom</th>
                <th>Girawat</th>
                <th>Din</th>
                <th>Bottom+20d</th>
                <th>Bottom+60d</th>
              </tr></thead>
              <tbody>${dd}</tbody>
            </table>
          </div>`;
      }
      histBlock += `</div>`;
    } else if (hs?.error) {
      histBlock = `<div class="muted small" style="margin-top:10px;">History study: ${hs.error}</div>`;
    }

    histBlock = guide + pathBlock + histBlock;

    box.innerHTML = `
      <div class="muted small" style="margin-bottom:10px; padding:8px; border-radius:8px; background:rgba(255,255,255,.04);">
        <b>Ye screen kya hai?</b> Nifty kahan hai, neeche/upar levels, aaj ki girawat ka type, history me aise phases ke baad kya hua.
        <b>Guarantee nahi.</b>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:12px;">
        <div><div class="muted small">Abhi Nifty</div><div style="font-size:1.25rem; font-weight:700;">${fmtN(d.price)}</div></div>
        <div><div class="muted small">Aaj</div><div class="change ${(d.dayPct ?? 0) >= 0 ? 'up' : 'down'}" style="font-weight:700;">${fmtPct(d.dayPct)}</div></div>
        <div><div class="muted small">1 hafte / 1 mahine</div><div>${fmtPct(d.periodReturns?.oneWeek)} · ${fmtPct(d.periodReturns?.oneMonth)}</div></div>
        <div><div class="muted small">~8 hafte high se</div><div class="change down">${fmtPct(d.fromRecentHighPct)}</div></div>
        <div><div class="muted small">Regime</div><div>${d.context?.learningRegime || d.context?.trendRegime || '—'}</div></div>
        <div><div class="muted small">India VIX</div><div>${d.context?.vix != null ? Number(d.context.vix).toFixed(1) : '—'}${d.context?.vixChangePct != null ? ` (${fmtPct(d.context.vixChangePct)})` : ''}</div></div>
      </div>
      ${spark}

      <div class="card" style="padding:12px; margin:12px 0;">
        <div style="font-weight:700;">Aaj ki girawat — seedha matlab</div>
        <div style="margin-top:4px;"><b>${tm.label || '—'}</b></div>
        <p style="margin:8px 0; font-size:13px;">${healthyTxt}</p>
        <ul class="muted small" style="margin:0; padding-left:18px;">
          ${(tm.reasons || []).map((r) => `<li>${r}</li>`).join('') || '<li>—</li>'}
        </ul>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px;">
        <div class="card" style="padding:12px;">
          <div style="font-weight:700; color:var(--green,#3dd68c);">Neeche support (floor)</div>
          <p class="muted small">Yahan se price rukne ki koshish kar sakta hai. % = abhi se door.</p>
          ${lvl(d.supportLevels, 'support')}
        </div>
        <div class="card" style="padding:12px;">
          <div style="font-weight:700; color:var(--red,#f07178);">Upar resistance</div>
          <p class="muted small">Bounce aaye to pehli rukawat yahan common.</p>
          ${lvl(d.resistanceLevels, 'resistance')}
        </div>
      </div>

      <div class="card" style="padding:12px; margin-top:12px;">
        <div style="font-weight:700;">Bounce vs aur neeche</div>
        <p style="margin:8px 0; font-size:13px;">
          <b>Bounce zone:</b> ${sc.bounceZone ? `${fmtN(sc.bounceZone.from)} – ${fmtN(sc.bounceZone.to)}` : 'Pehle koi support hold dekho'}.
          ${sc.breakdownLevel != null ? `<br/><b>Agar ~${fmtN(sc.breakdownLevel)} se neeche band:</b> bounce case kamzor.` : ''}
          ${sc.nextSupportBelow ? `<br/><b>Next floor:</b> ~${fmtN(sc.nextSupportBelow.level)} (${fmtPct(sc.nextSupportBelow.distancePct)}).` : ''}
        </p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <span class="verdict-badge bullish" style="font-size:11px;">Bounce lean ${w.bounce ?? '—'}%</span>
          <span class="verdict-badge bearish" style="font-size:11px;">Aur neeche ${w.continuation_down ?? '—'}%</span>
          <span class="verdict-badge neutral" style="font-size:11px;">Sideways ${w.sideways_digest ?? '—'}%</span>
        </div>
        <p class="muted small" style="margin:8px 0 0;">Ye % jeet ki probability <b>nahi</b> — technical lean only.</p>
      </div>

      <div class="card" style="padding:12px; margin-top:12px;">
        <div style="font-weight:700;">Short summary</div>
        <ul style="margin:0; padding-left:18px;">${narr}</ul>
      </div>
      ${histBlock}
      <p class="disclaimer" style="margin-top:10px;">${d.disclaimer || ''}</p>
    `;
  } catch (err) {
    box.innerHTML = `<p class="muted small" style="color:var(--red);">${err.message}</p>`;
  }
}


// ---------- Market playbook (how Nifty pulse affects stock picks) ----------
async function loadMarketPlaybook() {
  const banner = document.getElementById('marketPlaybookBanner');
  try {
    const data = await api('/market/playbook');
    const p = data.playbook;
    if (!p) return;
    window.__marketPlaybook = p;
    const color =
      p.posture === 'defensive' ? 'rgba(240,113,120,.12)' :
      p.posture === 'cautious' ? 'rgba(255,203,107,.1)' :
      p.posture === 'opportunity_reversal' ? 'rgba(61,214,140,.1)' :
      'rgba(110,168,254,.08)';
    const html = `
      <div style="background:${color}; border-radius:10px; padding:10px 12px;">
        <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; align-items:center;">
          <div>
            <div style="font-weight:700;">📐 Aaj stock kaise le? · ${p.posture.replace(/_/g, ' ')}</div>
            <div style="margin-top:4px; font-size:13px;">${p.oneLiner}</div>
          </div>
          <button type="button" class="ghost-btn small" id="playbookDetailsBtn">Details</button>
        </div>
        <div id="playbookDetails" class="hidden" style="margin-top:10px; font-size:13px;">
          <div class="muted small" style="margin-bottom:6px;">Nifty ${p.niftySnapshot?.price ?? '—'} · aaj ${p.niftySnapshot?.dayPct != null ? (p.niftySnapshot.dayPct >= 0 ? '+' : '') + Number(p.niftySnapshot.dayPct).toFixed(2) + '%' : '—'} · regime ${p.niftySnapshot?.learningRegime || '—'}
            ${p.niftySnapshot?.nearestSupport ? ` · nearest floor ~${p.niftySnapshot.nearestSupport}` : ''}</div>
          <div style="font-weight:600;">Rules</div>
          <ul style="margin:4px 0 8px; padding-left:18px;">${(p.rules || []).map((x) => `<li>${x}</li>`).join('')}</ul>
          <div style="font-weight:600;">Prefer</div>
          <ul style="margin:4px 0 8px; padding-left:18px;">${(p.prefer || []).map((x) => `<li>${x}</li>`).join('')}</ul>
          <div style="font-weight:600;">Avoid</div>
          <ul style="margin:4px 0 8px; padding-left:18px;">${(p.avoid || []).map((x) => `<li>${x}</li>`).join('')}</ul>
          <div style="font-weight:600;">Checklist</div>
          <ul style="margin:4px 0 0; padding-left:18px;">${(p.checklist || []).map((x) => `<li>${x}</li>`).join('')}</ul>
          <p class="muted small" style="margin:8px 0 0;">${p.disclaimer || ''}</p>
        </div>
      </div>`;
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = html;
      document.getElementById('playbookDetailsBtn')?.addEventListener('click', () => {
        document.getElementById('playbookDetails')?.classList.toggle('hidden');
      });
    }
  } catch (err) {
    if (banner) banner.style.display = 'none';
  }
}


// ---------- Tomorrow high-conviction (post close, max 1–2) ----------
document.getElementById('tcLoadBtn')?.addEventListener('click', () => loadTomorrowConviction());
document.getElementById('tcRunBtn')?.addEventListener('click', () => loadTomorrowConviction(true));
document.getElementById('tcMorningBtn')?.addEventListener('click', () => loadTomorrowMorningRecheck());
document.getElementById('tcLearningBtn')?.addEventListener('click', () => loadTomorrowLearning());
document.getElementById('tcHoldBtn')?.addEventListener('click', () => loadTomorrowHoldCoach());

async function loadTomorrowConviction(force) {
  const box = document.getElementById('tcResultBox');
  const status = document.getElementById('tcStatus');
  if (!box) return;
  box.innerHTML = '<div class="muted small"><span class="spin"></span> Scanning high-conviction names for next session…</div>';
  try {
    const data = force
      ? await api('/tomorrow-conviction/run', { method: 'POST', body: '{}' })
      : await api('/tomorrow-conviction');
    const m = data.market || {};
    if (status) {
      status.textContent = `${data.pickCount || 0} pick(s) · scanned ${data.scanned || 0} · gates pass ${data.candidatesPassedGates || 0} · Nifty ${m.niftyPrice ?? '—'} (${m.niftyDayPct != null ? (m.niftyDayPct >= 0 ? '+' : '') + Number(m.niftyDayPct).toFixed(2) + '%' : '—'}) · ${m.posture || ''}`;
    }
    if (!data.picks?.length) {
      box.innerHTML = `
        <div class="card" style="padding:16px;">
          <div style="font-weight:700; margin-bottom:6px;">Aaj koi naam nahi</div>
          <p class="muted small">${data.note || 'Strict gates clear nahi hue — 0 better than forced trade.'}</p>
          <p class="muted small">${m.oneLiner || ''}</p>
        </div>`;
      return;
    }
    box.innerHTML = `
      <div class="muted small" style="margin-bottom:10px;">${data.note || ''}</div>
      <div class="card" style="padding:12px; margin-bottom:12px; background:rgba(110,168,254,.06);">
        <div style="font-weight:600;">Market context (kal ke trades se pehle)</div>
        <div class="muted small">${m.oneLiner || ''}</div>
        <div class="muted small">Regime ${m.learningRegime || '—'} · nearest Nifty floor ${m.nearestSupport ?? '—'}</div>
      </div>
      ${data.picks.map((p, i) => {
        const plan = p.tradePlan || {};
        const sc = p.scenarios || {};
        return `
        <div class="card" style="padding:14px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div>
              <span class="muted small">#${i + 1}</span>
              <b style="font-size:1.15rem; margin-left:6px; cursor:pointer;" class="tc-sym" data-symbol="${p.symbol}">${p.symbol}</b>
              <span class="muted small">${p.sector || ''}</span>
            </div>
            <div>
              <span class="verdict-badge bullish">Conviction ${p.convictionScore}</span>
              <span class="muted small"> R:R ${p.riskRewardRatio != null ? '1:' + Number(p.riskRewardRatio).toFixed(1) : '—'}</span>
            </div>
          </div>
          <div style="margin-top:8px;">₹${p.price != null ? Number(p.price).toFixed(2) : '—'}
            <span class="change ${(p.pChange ?? 0) >= 0 ? 'up' : 'down'}">${p.pChange != null ? (p.pChange >= 0 ? '+' : '') + Number(p.pChange).toFixed(2) + '%' : ''}</span>
            · ${p.verdict || ''} · setup ${p.setup || '—'}
          </div>
          <div class="muted small" style="margin-top:6px;">
            Plan: entry ${plan.entryLow ?? '—'}–${plan.entryHigh ?? '—'} · <b>SL ${p.gapPlan?.stopLoss ?? plan.stopLoss ?? '—'}</b> · Tgt ${plan.target ?? '—'}
          </div>
          <div class="muted small">${p.gapPlan?.stopLossRule || p.eveningGuidance?.stopLossRule || ''}</div>
          <ul style="margin:8px 0; padding-left:18px; font-size:13px;">
            ${(p.reasons || []).map((x) => `<li>${x}</li>`).join('')}
          </ul>
          ${p.gapPlan ? `
          <div class="card" style="padding:10px; margin:8px 0; background:rgba(255,203,107,.06);">
            <div style="font-weight:600; margin-bottom:4px;">Kal gap / time plan</div>
            <div class="muted small"><b>${p.gapPlan.gapUp?.label || 'Gap up'}:</b> ${p.gapPlan.gapUp?.takeIf || ''}</div>
            <div class="muted small">Buy zone UP: ${p.gapPlan.gapUp?.buyZone?.from ?? '—'} – ${p.gapPlan.gapUp?.buyZone?.to ?? '—'}
              · skip if open above ${p.gapPlan.gapUp?.skipIfOpenAbove ?? '—'}</div>
            <div class="muted small" style="margin-top:4px;"><b>${p.gapPlan.gapDown?.label || 'Gap down'}:</b> ${p.gapPlan.gapDown?.takeIf || ''}</div>
            <div class="muted small">Buy zone DOWN: ${p.gapPlan.gapDown?.buyZone?.from ?? '—'} – ${p.gapPlan.gapDown?.buyZone?.to ?? '—'}
              · hard skip below ${p.gapPlan.gapDown?.hardSkipBelow ?? '—'}</div>
            <div class="muted small" style="margin-top:4px;"><b>Time:</b> pehle ${p.gapPlan.timeWindow?.avoidFirstMinutes ?? 15} min skip · preferred ${p.gapPlan.timeWindow?.preferredWindow || '—'} · last entry ${p.gapPlan.timeWindow?.lastEntryBefore || '—'}</div>
          </div>` : ''}
          ${p.softOdds ? `
          <div class="card" style="padding:10px; margin:8px 0; background:rgba(110,168,254,.06);">
            <div style="font-weight:600;">Soft path odds (heuristic — guarantee nahi)</div>
            <div class="muted small">+2% lean ~<b>${p.softOdds.upside?.atLeast2pct ?? '—'}%</b>
              · +5% ~<b>${p.softOdds.upside?.atLeast5pct ?? '—'}%</b>
              · +10% ~<b>${p.softOdds.upside?.atLeast10pct ?? '—'}%</b></div>
            <div class="muted small">−2% down lean ~<b>${p.softOdds.downside?.atLeast2pctDown ?? '—'}%</b>
              · −5% ~<b>${p.softOdds.downside?.atLeast5pctDown ?? '—'}%</b></div>
            <div class="muted small">${p.softOdds.note || ''}</div>
          </div>` : ''}
          ${p.positionSize ? `
          <div class="card" style="padding:10px; margin:8px 0; background:rgba(61,214,140,.08);">
            <div style="font-weight:600;">💰 Kitna paisa · profit / loss (size plan)</div>
            <div style="font-size:13px; margin-top:4px;">
              <b>Min ₹${(p.positionSize.minCapital || 10000).toLocaleString('en-IN')}</b>
              · suggest <b>₹${(p.positionSize.suggestedCapital || 10000).toLocaleString('en-IN')}</b>
              ${p.positionSize.qty != null ? ` · ~<b>${p.positionSize.qty}</b> shares (≈ ₹${Number(p.positionSize.actualCapital).toLocaleString('en-IN')})` : ''}
            </div>
            <div class="muted small" style="margin-top:4px;">
              Target pe profit ~<b style="color:var(--green,#3dd68c)">₹${p.positionSize.profitIfTarget != null ? Number(p.positionSize.profitIfTarget).toLocaleString('en-IN') : '—'}</b>
              ${p.positionSize.profitPctOfEntry != null ? `(${p.positionSize.profitPctOfEntry}%)` : ''}
              · SL pe loss ~<b style="color:var(--red,#f07178)">₹${p.positionSize.lossIfStop != null ? Math.abs(Number(p.positionSize.lossIfStop)).toLocaleString('en-IN') : '—'}</b>
              ${p.positionSize.lossPctOfEntry != null ? `(${p.positionSize.lossPctOfEntry}%)` : ''}
            </div>
            <div class="muted small">${p.positionSize.increaseReason || ''}</div>
            <div class="muted small">${p.positionSize.note || ''}</div>
          </div>` : ''}
          <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-top:8px;">
            ${['if_market_up','if_market_down','if_market_flat'].map((k) => {
              const s = sc[k];
              if (!s) return '';
              return `<div class="card" style="padding:8px; background:rgba(0,0,0,.15);">
                <div class="muted small">${s.label}</div>
                <div style="font-weight:600; font-size:12px;">${s.edge}</div>
                <div class="muted small">${s.note}</div>
              </div>`;
            }).join('')}
          </div>
          <button type="button" class="ghost-btn small tc-open" data-symbol="${p.symbol}" style="margin-top:10px;">Full chart</button>
        </div>`;
      }).join('')}
      <p class="disclaimer">${data.disclaimer || ''}</p>
    `;
    box.querySelectorAll('.tc-sym, .tc-open').forEach((el) => {
      el.addEventListener('click', () => {
        if (typeof loadSymbol === 'function') loadSymbol(el.dataset.symbol, { fromView: 'tomorrow-conviction' });
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
    if (status) status.textContent = err.message;
  }
}


async function loadTomorrowMorningRecheck() {
  const box = document.getElementById('tcMorningBox');
  if (!box) return;
  box.innerHTML = '<div class="muted small"><span class="spin"></span> Morning re-check…</div>';
  try {
    const data = await api('/tomorrow-conviction/morning-recheck');
    if (!data.ok) {
      box.innerHTML = `<div class="muted small">${data.message || 'No pack'}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="card" style="padding:12px;">
        <div style="font-weight:700;">☀️ Morning re-check · pack ${data.asOfDate}</div>
        <div class="muted small">Nifty live ${data.marketLive?.niftyDayPct != null ? data.marketLive.niftyDayPct + '%' : '—'} · ${data.marketLive?.regime || ''}</div>
        ${(data.picks || []).map((p) => {
          const badge = p.status === 'take' ? 'bullish' : p.status === 'avoid' ? 'bearish' : 'neutral';
          return `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
            <b>${p.symbol}</b> · live ₹${p.livePrice ?? '—'} (${p.liveDayPct != null ? (p.liveDayPct >= 0 ? '+' : '') + p.liveDayPct + '%' : '—'})
            · evening ₹${p.eveningPrice ?? '—'}
            <span class="verdict-badge ${badge}" style="margin-left:6px;">${(p.status || '').toUpperCase()}</span>
            <div style="font-size:13px; margin-top:4px;">${p.note || ''}</div>
            <div class="muted small">Time: ${p.timeHint || ''} · SL ${p.stopLoss ?? '—'}</div>
            ${p.softOdds?.upside ? `<div class="muted small">Soft odds now: +2% ~${p.softOdds.upside.atLeast2pct}% · +5% ~${p.softOdds.upside.atLeast5pct}% · −2% ~${p.softOdds.downside?.atLeast2pctDown}%</div>` : ''}
          </div>`;
        }).join('')}
        <p class="disclaimer" style="margin-top:8px;">${data.disclaimer || ''}</p>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
  }
}

async function loadTomorrowLearning() {
  const box = document.getElementById('tcLearningBox');
  if (!box) return;
  box.innerHTML = '<div class="muted small"><span class="spin"></span> Learning stats…</div>';
  try {
    await api('/tomorrow-conviction/resolve-outcomes', { method: 'POST', body: '{}' }).catch(() => {});
    const s = await api('/tomorrow-conviction/learning');
    box.innerHTML = `
      <div class="card" style="padding:12px;">
        <div style="font-weight:700;">📊 Tomorrow-conviction learning</div>
        <div class="muted small">${s.message || ''}</div>
        <ul style="margin:8px 0 0; padding-left:18px; font-size:13px;">
          <li>Logged rows: <b>${s.totalLogged ?? 0}</b> · resolved: <b>${s.sample ?? 0}</b></li>
          <li>Target hit: <b>${s.targetHitPct != null ? s.targetHitPct + '%' : '—'}</b> · SL hit: <b>${s.slHitPct != null ? s.slHitPct + '%' : '—'}</b></li>
          <li>Morning avoid/cancel: <b>${s.morningAvoidCount ?? 0}</b> (${s.morningCancelledPct != null ? s.morningCancelledPct + '%' : '—'} of resolved)</li>
          <li>Avg next-day max up: <b>${s.avgMaxUpPctNextDay ?? '—'}%</b> · max down: <b>${s.avgMaxDownPctNextDay ?? '—'}%</b></li>
        </ul>
        <p class="muted small" style="margin-top:8px;">Jitna data resolve hoga, utna soft feedback better — future guarantee nahi.</p>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
  }
}


async function loadTomorrowHoldCoach() {
  const box = document.getElementById('tcHoldBox');
  if (!box) return;
  box.innerHTML = '<div class="muted small"><span class="spin"></span> Hold/Exit coach…</div>';
  try {
    const data = await api('/tomorrow-conviction/hold-coach');
    if (!data.coaches?.length) {
      box.innerHTML = `<div class="muted small">${data.message || 'No active picks'}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="card" style="padding:12px;">
        <div style="font-weight:700;">📌 Hold / Exit coach (active picks)</div>
        <div class="muted small">Target/SL clear hit na ho to yahan se next action. Path: recovery / up / down lean.</div>
        ${data.coaches.map((c) => {
          const badge = c.action === 'EXIT' ? 'bearish' : c.action === 'HOLD' ? 'bullish' : c.action === 'TRIM' ? 'neutral' : 'neutral';
          return `<div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">
            <b>${c.symbol}</b> · pack ${c.asOfDate || '—'}
            <span class="verdict-badge ${badge}" style="margin-left:6px;">${c.action}</span>
            <div class="muted small">Live ₹${c.livePrice ?? '—'} (${c.liveDayPct != null ? (c.liveDayPct >= 0 ? '+' : '') + c.liveDayPct + '%' : '—'})
              · entry ref ₹${c.eveningPrice ?? '—'} · from entry <b>${c.fromEntryPct != null ? (c.fromEntryPct >= 0 ? '+' : '') + c.fromEntryPct + '%' : '—'}</b>
              · max up ${c.maxUpPct ?? '—'}% · max down ${c.maxDownPct ?? '—'}%</div>
            <div class="muted small">SL ${c.stopLoss ?? '—'} · Tgt ${c.target ?? '—'} · sessions since pick ${c.sessionsHeld ?? '—'}
              · hold hint: <b>${c.holdDaysHint || '—'}</b></div>
            <ul style="margin:6px 0 0; padding-left:18px; font-size:13px;">
              ${(c.reasons || []).map((x) => `<li>${x}</li>`).join('')}
            </ul>
          </div>`;
        }).join('')}
        <p class="disclaimer" style="margin-top:10px;">${data.disclaimer || ''}</p>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
  }
}


// ---------- Sector + Ancillary long-term invest ----------
document.getElementById('saLoadBtn')?.addEventListener('click', () => loadSectorAncillary());
document.getElementById('saRunBtn')?.addEventListener('click', () => loadSectorAncillary(true));

async function loadSectorAncillary(force) {
  const box = document.getElementById('saResultBox');
  const status = document.getElementById('saStatus');
  if (!box) return;

  const fmtPct = (x) => {
    if (x == null || !Number.isFinite(Number(x))) return '—';
    const n = Number(x);
    const pct = Math.abs(n) <= 5 ? n * 100 : n;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };
  const fmtN = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));

  function renderPick(p, i) {
    const exp = p.themeExposure || {};
    const expTxt = exp.level
      ? (exp.pct != null ? `${exp.level} (${exp.pct}%)` : exp.level)
      : '—';
    const valSt = p.valuationStatus || {};
    const vc = p.valueChain || {};
    const th = p.thesis3to5Y || {};
    return `<div style="padding:10px 0; border-bottom:1px solid var(--border);">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
        <div>
          <b class="sa-sym" data-symbol="${p.symbol}" style="cursor:pointer; font-size:1.05rem;">${i != null ? '#' + (i + 1) + ' ' : ''}${p.symbol}</b>
          <span class="muted small"> ${p.name || ''}</span>
        </div>
        <span class="verdict-badge ${p.overall >= 65 ? 'bullish' : p.overall >= 55 ? 'neutral' : 'bearish'}">${p.fit || ''} ${p.overall}</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:8px; font-size:12px;">
        <div style="background:rgba(61,214,140,.1); padding:6px; border-radius:6px; text-align:center;"><div class="muted small">Quality</div><b>${p.quality}</b></div>
        <div style="background:rgba(110,168,254,.12); padding:6px; border-radius:6px; text-align:center;"><div class="muted small">Growth</div><b>${p.growth}</b></div>
        <div style="background:rgba(251,191,36,.12); padding:6px; border-radius:6px; text-align:center;"><div class="muted small">Valuation</div><b>${p.valuation}</b></div>
      </div>
      <div class="muted small" style="margin-top:4px;">Research scores only — not auto BUY</div>
      <div style="margin-top:8px; padding:8px 10px; border-radius:8px; background:rgba(110,168,254,.08); font-size:12px; line-height:1.5;">
        <div><b>Why ancillary:</b> ${p.whyAncillary || p.thesis || '—'}</div>
        <div><b>Theme exposure:</b> ${expTxt}</div>
        <div><b>Value chain:</b> ${vc.stage || '—'} <span class="muted">(${vc.chain || 'Core → Ancillary → Components → Equipment → Services'})</span></div>
        <div><b>Valuation status:</b> ${valSt.status || '—'} ${valSt.note ? '· ' + valSt.note : ''}</div>
        <div><b>3–5Y thesis:</b> ${th.oneLiner || th.whyNow || '—'}</div>
        ${th.keyRisk ? `<div><b>Key risk:</b> ${th.keyRisk}</div>` : ''}
      </div>
      <div class="muted small" style="margin-top:4px;">PE ${fmtN(p.metrics?.trailingPE)} · ROE ${fmtPct(p.metrics?.returnOnEquity)} · Rev ${fmtPct(p.metrics?.revenueGrowth)} · 1Y ${p.metrics?.priceReturn1y != null ? p.metrics.priceReturn1y + '%' : '—'} · ${p.dataSource || ''}</div>
    </div>`;
  }

  function bindSymbols(root) {
    root.querySelectorAll('.sa-sym').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof loadSymbol === 'function') loadSymbol(el.dataset.symbol, { fromView: 'sector-ancillary' });
      });
    });
  }

  if (force) {
    box.innerHTML = `
      <div class="card" style="padding:16px;">
        <div style="font-weight:600; margin-bottom:8px;">🔬 Sector scan chal raha hai…</div>
        <div style="height:10px; background:rgba(255,255,255,.08); border-radius:6px; overflow:hidden;">
          <div id="saProgressBar" style="height:100%; width:2%; background:linear-gradient(90deg,#6ea8fe,#3dd68c); transition:width .3s;"></div>
        </div>
        <div id="saProgressText" class="muted small" style="margin-top:8px;">Starting…</div>
        <div id="saProgressLog" class="muted small" style="margin-top:6px; max-height:120px; overflow:auto;"></div>
      </div>`;
    if (status) status.textContent = 'Force refresh…';

    try {
      const start = await api('/sector-ancillary/run-async', { method: 'POST', body: '{}' });
      const jobId = start.jobId;
      let done = false;
      let finalData = null;
      for (let i = 0; i < 180 && !done; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        let prog = null;
        try {
          prog = await api(`/sector-ancillary/progress/${jobId}`);
        } catch (_) {}
        const bar = document.getElementById('saProgressBar');
        const txt = document.getElementById('saProgressText');
        const log = document.getElementById('saProgressLog');
        if (prog?.ok) {
          const pct = prog.percent ?? 0;
          if (bar) bar.style.width = Math.max(2, pct) + '%';
          if (txt) txt.textContent = `${pct}% · ${prog.message || prog.phase || ''} ${prog.detail ? '· ' + prog.detail : ''}`;
          if (log && prog.logs?.length) {
            log.innerHTML = prog.logs.slice(-8).map((l) => `<div>${l.text || ''}</div>`).join('');
          }
          if (prog.phase === 'done' || pct >= 100) done = true;
        }
      }
      // Load result (cache should be filled)
      finalData = await api('/sector-ancillary');
      renderSa(finalData);
    } catch (err) {
      box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
    }
    return;
  }

  box.innerHTML = '<div class="muted small"><span class="spin"></span> Loading sector invest…</div>';
  try {
    const data = await api('/sector-ancillary');
    renderSa(data);
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red);">${err.message}</div>`;
  }

  function renderSa(data) {
    if (status) {
      status.textContent = `Scanned ${data.scanned || 0} · ranked ${data.rankedCount ?? '—'} · soft-fit ${data.passedSoftFit || 0} · skipped ${data.failedOrSkipped || 0} · ${data.fromCache ? 'cache' : 'fresh'} · ${data.computedAt ? new Date(data.computedAt).toLocaleString('en-IN') : ''}`;
    }
    const themes = data.rankedThemes || data.themes || [];
    const themeAcc = themes.map((th, idx) => {
      const color = th.color || '#6ea8fe';
      const picks = th.picks || data.byTheme?.[th.id]?.picks || [];
      const open = idx === 0 ? true : false;
      return `
        <div class="card sa-theme" data-theme="${th.id}" style="padding:0; margin-bottom:12px; border-left:4px solid ${color}; overflow:hidden;">
          <button type="button" class="sa-theme-toggle" data-theme="${th.id}"
            style="width:100%; text-align:left; background:transparent; border:0; color:inherit; padding:14px 16px; cursor:pointer; display:flex; justify-content:space-between; gap:10px; align-items:center;">
            <div>
              <div style="font-weight:700;">
                <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${color}; margin-right:8px;"></span>
                #${idx + 1} ${th.name}
              </div>
              <div class="muted small" style="margin-top:4px;">
                Rank ${th.rankScore ?? '—'} · 1Y avg ${th.avgReturn1y != null ? th.avgReturn1y + '%' : '—'}
                · outlook <b>${th.futureOutlook || '—'}</b> · ${picks.length} selective picks
              </div>
              <div class="muted small">${th.whyGrowing || ''}</div>
            </div>
            <span class="sa-arrow" style="font-size:1.2rem; transition:transform .2s; ${open ? 'transform:rotate(90deg);' : ''}">▶</span>
          </button>
          <div class="sa-theme-body" style="display:${open ? 'block' : 'none'}; padding:0 16px 14px;">
            <div class="muted small" style="margin-bottom:8px;">${th.ancillaryFocus || ''} · horizon ${th.horizon || ''}</div>
            ${picks.length ? picks.map((p, i) => renderPick(p, i)).join('') : '<div class="muted small">Is theme me selective pick nahi.</div>'}
          </div>
        </div>`;
    }).join('');

    box.innerHTML = `
      <div class="card" style="padding:12px; margin-bottom:12px; background:rgba(110,168,254,.06);">
        <div style="font-weight:600;">Kaise padho</div>
        <ol class="muted small" style="margin:6px 0 0; padding-left:18px;">
          <li>Pehle <b>ranked sectors</b> — upar = better recent + quality blend.</li>
          <li>Arrow → us sector ki <b>3–4 selective ancillary</b> companies.</li>
          <li><b>Q / G / V</b> = research scores only — <b>not</b> automatic BUY.</li>
          <li>Investment hold — 1–2 mahine baad review.</li>
        </ol>
        <p class="muted small" style="margin:8px 0 0;">${data.aspirationNote || ''}</p>
        ${data.universe ? `<div class="muted small" style="margin-top:8px; padding:8px; border-radius:8px; background:rgba(0,0,0,.15);"><b>Universe:</b> ${data.universe.pipeline || ''}</div>` : ''}
      </div>

      ${(data.exclusions || []).length ? `
      <details class="card" style="padding:12px; margin-bottom:12px;">
        <summary style="cursor:pointer; font-weight:600;">Why excluded? (${(data.exclusions || []).length})</summary>
        <div class="muted small" style="margin-top:8px; max-height:180px; overflow:auto;">
          ${(data.exclusions || []).slice(0, 40).map((e) =>
            `<div style="padding:4px 0; border-bottom:1px solid var(--border);"><b>${e.symbol}</b> · ${e.themeName || ''} · ${e.reason}${e.overall != null ? ' · score ' + e.overall : ''}</div>`
          ).join('')}
        </div>
      </details>` : ''}

      <div class="card" style="padding:12px; margin-bottom:14px; background:rgba(61,214,140,.08);">
        <div style="font-weight:700; margin-bottom:6px;">⭐ Best now + ahead</div>
        <div class="muted small" style="margin-bottom:6px;">Strict-ish Q/G/V (ya strong price growth jab fundamentals thin hon).</div>
        ${(data.bestNowAndAhead || []).length
          ? (data.bestNowAndAhead || []).map((p, i) => renderPick(p, i)).join('')
          : '<div class="muted small">Best tier empty is run me — neeche ranked sectors expand karo.</div>'}
      </div>

      <div style="font-weight:700; margin:12px 0 8px;">Sectors (ranked) — click arrow</div>
      ${themeAcc}
      ${(data.errorSamples || []).length ? `<div class="muted small" style="margin-top:8px;">Data gaps: ${data.errorSamples.slice(0, 5).map((e) => e.symbol).join(', ')}</div>` : ''}
      <p class="disclaimer">${data.disclaimer || ''}</p>
    `;

    box.querySelectorAll('.sa-theme-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.sa-theme');
        const body = card.querySelector('.sa-theme-body');
        const arrow = btn.querySelector('.sa-arrow');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (arrow) arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
      });
    });
    bindSymbols(box);
  }
}


function updateTodayFlowStrip(phase) {
  const el = document.getElementById('todayFlowSteps');
  if (!el) return;
  const map = {
    preopen: 'Pre-open — prep only, trade mat.',
    early: 'Early open — volume wait; 10:15 ke baad Storm.',
    prime: 'Prime: Scan Storm → SL/T buttons → partial T1.',
    mid: 'Mid day: nayi chase kam; manage open trades.',
    late: 'Late: EOD book bias; overnight sirf carry-confirm.',
  };
  el.innerHTML = (map[phase] || map.prime) + ' · Max ~1 Storm/day · Research secondary · Empty = sit out.';
}

function ebMetricPills(p) {
  if (!p) return '';
  const act = p.action || 'WAIT';
  const actCls = act === 'BUY NOW' ? 'action-buy' : act === 'NO TRADE' ? 'action-no' : 'action-wait';
  const stages = ['ACCUMULATION','SETUP_FORMING','TRIGGER_NEAR','CONFIRMED_BREAKOUT','EXTENDED','INVALIDATED'];
  const st = p.signalStage || '';
  const tl = stages.map((s) => `<span class="${s===st?'on':''}">${s.replace('_',' ')}</span>`).join(' → ');
  const rs = p.relativeStrength || {};
  return `<div class="eb-metrics">
    <span>Score ${p.signalScore ?? p.earlyBoomScore ?? '—'}</span>
    <span>Strength ${p.signalStrength || '—'}</span>
    <span>Hist conf ${p.historicalConfidence || '—'}</span>
    ${p.historicalHitRate != null ? `<span>Hist hit ${p.historicalHitRate}% n=${p.historicalSampleSize ?? '?'}</span>` : '<span>Hist hit n/a</span>'}
    <span class="stage">${st || '—'}</span>
    <span class="${actCls}">${act}</span>
    ${rs.rsScore != null ? `<span>RS vs Nifty ${rs.rsScore > 0 ? '+' : ''}${rs.rsScore}</span>` : ''}
  </div>
  <div class="eb-stage-timeline">${tl}</div>
  ${p.tradeValidation?.reason ? `<div class="muted small" style="margin-top:4px;">Validation: ${p.tradeValidation.reason}</div>` : ''}
  ${p.historicalNote ? `<div class="muted small">${p.historicalNote}</div>` : ''}`;
}

async function loadMorningStorm() {
  const box = document.getElementById('morningStormBox');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span> Early Boom scan…';
  try {
    const d = await api('/morning-storm/latest');
    if (d.skipped || d.marketClosed) {
      box.innerHTML = `<div class="market-closed-banner">⏸ Early Boom / Morning Storm paused — ${d.skipReason || d.window?.note || 'outside market hours'}. Scans only 9:15–15:30 IST.</div>`;
      return;
    }
    const picks = d.picks || d.candidates || [];
    const track = d.trackRecord || d.truth || null;
    const regime = d.marketContext || d.regime || {};
    const scannedAt = d.scannedAt || d.asOf || new Date().toISOString();
    const phase = d.windowPhase || d.phase || '';
    const sample = track?.overall?.sample ?? track?.sample ?? 0;
    const winRate = track?.overall?.winRatePct ?? track?.winRatePct;
    const avgMfe = track?.overall?.avgMaxFavorablePct;
    const avgMae = track?.overall?.avgMaxAdversePct;

    const regimeLabel = regime.trend || regime.todayDirection || d.marketTrend || '—';
    let hero = '';
    if (!picks.length) {
      hero = `
        <div class="early-boom-hero empty">
          <div style="font-weight:800; font-size:1.05rem;">🔥 EARLY BOOM OPPORTUNITY</div>
          <div class="muted" style="margin-top:8px; font-size:14px;"><b>NO HIGH-CONFIDENCE OPPORTUNITY</b></div>
          <div class="muted small" style="margin-top:4px;">Strong early setup nahi mila — forced trade mat lo. Sit out valid.</div>
        </div>`;
    } else {
      const top = picks[0];
      const plan = top.plan || {};
      const eb = top.earlyBoomScore ?? top.stormScore;
      const conf = top.confidence || top.t1Bias?.label || '—';
      const metricHtml = ebMetricPills(top);
      const warn = top.alreadyMoved ? `<span class="golden-action wait">Already moved? +${Number(top.currentMovePct ?? top.dayPct).toFixed(1)}%</span>` : '';
      hero = `
        <div class="early-boom-hero">
          <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div style="font-weight:800; font-size:1.05rem;">🔥 EARLY BOOM OPPORTUNITY</div>
            <span class="muted small">${phase || 'live'} · ${new Date(scannedAt).toLocaleTimeString('en-IN')}</span>
          </div>
          <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
            <b style="font-size:1.25rem;">${top.symbol}</b>
            <span class="muted">₹${Number(top.price).toFixed(2)}</span>
            <span class="golden-action buy">EARLY BOOM ${eb}</span>
            <span class="muted small">Conf <b>${conf}</b></span>
            ${warn}</div>${metricHtml}<div>
          </div>
          <div class="muted small" style="margin-top:8px; display:flex; flex-wrap:wrap; gap:12px;">
            <span>Entry ${plan.entryLow != null ? `₹${plan.entryLow}–₹${plan.entryHigh}` : (plan.entry ?? '—')}</span>
            <span>Trig ${plan.trigger || '—'}</span>
            <span>T1 ₹${plan.target1 ?? '—'} · T2 ₹${plan.target2 ?? '—'}</span>
            <span>SL ₹${plan.stopLoss ?? '—'}</span>
            <span>R:R ${plan.riskRewardRatio != null ? '1:' + Number(plan.riskRewardRatio).toFixed(2) : '—'}</span>
            <span>Exp move ${top.expectedMovePct != null ? top.expectedMovePct + '%' : '—'}</span>
            <span>Now ${top.currentMovePct != null ? (top.currentMovePct >= 0 ? '+' : '') + Number(top.currentMovePct).toFixed(1) + '%' : '—'}</span>
          </div>
          <div class="muted small" style="margin-top:6px;"><b>Why:</b> ${(top.reasons || []).slice(0, 4).join(' · ') || '—'}</div>
          <div class="muted small"><b>Invalidation:</b> ${top.invalidation || '—'}</div>
          <button type="button" class="ghost-btn small" style="margin-top:8px;" data-eb-open="${top.symbol}">View Full Analysis</button>
        </div>`;
    }

    const cards = picks.map((p, i) => {
      const plan = p.plan || {};
      const eb = p.earlyBoomScore ?? p.stormScore;
      const conf = p.confidence || p.t1Bias?.label || '—';
      const overnight = p.carrySuggestion || p.management || {};
      const oLabel = overnight.label || overnight.action || '';
      return `
        <div class="early-boom-card">
          <div style="display:flex; justify-content:space-between; gap:8px;">
            <div><span class="muted small">#${i + 1}</span> <b>${p.symbol}</b>
              <span class="golden-action ${String(conf).includes('HIGH') ? 'buy' : 'watch'}">${conf}</span>
              ${fundShBadge(p.fundamentals)}
              ${ebMetricPills(p)}
              ${p.alreadyMoved ? '<span class="golden-action wait">Already moved</span>' : ''}
            </div>
            <div style="text-align:right;"><div class="u200-comp">${eb}</div><div class="muted small">Early Boom</div>${fundShBadge(p.fundamentals || p.fund || top?.fundamentals)}</div>
          </div>
          <div class="muted small" style="margin-top:6px;">
            ₹${Number(p.price).toFixed(2)} · day ${p.dayPct != null ? (p.dayPct >= 0 ? '+' : '') + p.dayPct + '%' : '—'}
            · vol ${p.volSpike != null ? Number(p.volSpike).toFixed(1) + 'x' : '—'}
            · R:R ${plan.riskRewardRatio != null ? '1:' + Number(plan.riskRewardRatio).toFixed(2) : '—'}
          </div>
          <div class="muted small">T1 ₹${plan.target1 ?? '—'} · T2 ₹${plan.target2 ?? '—'} · SL ₹${plan.stopLoss ?? '—'}</div>
          <div class="muted small" style="margin-top:4px;">Overnight: <b>${oLabel || '—'}</b></div>
          <button type="button" class="ghost-btn small eb-detail-btn" data-i="${i}">Details</button>
          <div class="golden-detail" id="eb-d-${i}">
            <div><b>Reasons:</b> ${(p.reasons || []).join(' · ') || '—'}</div>
            <div><b>Risks:</b> ${(p.risks || []).join(' · ') || '—'}</div>
            <div><b>Invalidation:</b> ${p.invalidation || '—'}</div>
            <div class="muted small">Sample bias note: ${p.t1Bias?.note || 'Historical calibration grows with resolved picks — not a guarantee.'}</div>
            <button type="button" class="ghost-btn small" data-eb-open="${p.symbol}">View Full Analysis</button>
          </div>
        </div>`;
    }).join('');

    box.innerHTML = `
      <div class="muted small" style="margin-bottom:8px;">
        Regime <b>${regimeLabel}</b> · Scan ${new Date(scannedAt).toLocaleString('en-IN')}
        · Track n=${sample}${winRate != null ? ` · win ${winRate}%` : ''}
        ${avgMfe != null ? ` · avg MFE ${avgMfe}%` : ''}
        ${avgMae != null ? ` · avg MAE ${avgMae}%` : ''}
        ${sample < 20 ? ' · <span style="color:var(--amber)">low sample — soft confidence</span>' : ''}
      </div>
      ${hero}
      <div class="early-boom-grid" style="margin-top:12px;">${cards}</div>
    `;
    box.querySelectorAll('[data-eb-open]').forEach((btn) => {
      btn.addEventListener('click', () => loadSymbol(btn.getAttribute('data-eb-open'), { fromView: 'dashboard' }));
    });
    box.querySelectorAll('.eb-detail-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('eb-d-' + btn.dataset.i)?.classList.toggle('open');
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

async function loadSystemHealth() {
  const box = document.getElementById('systemHealthBox');
  const badge = document.getElementById('dataStatusBadge');
  if (!box) return;
  try {
    const h = await api('/market/system-health');
    const d = h.dataStatus || {};
    const pill = (ok, label, detail) =>
      `<span style="display:inline-block; margin:2px 4px 2px 0; padding:2px 8px; border-radius:999px; font-size:11px; background:${ok?'rgba(61,214,140,.15)':'rgba(240,113,120,.15)'};">${ok?'✓':'!'} ${label}${detail?': '+detail:''}</span>`;
    if (badge) {
      badge.innerHTML =
        pill(d.yahoo?.ok, 'Yahoo', d.yahoo?.detail) +
        pill(d.fundamentals?.ok, 'Fund', d.fundamentals?.detail) +
        pill(d.fiiDii?.ok, 'FII/DII', d.fiiDii?.detail);
    }
    const st = h.truth?.morningStorm || {};
    const gt = h.truth?.goldenAndReco || {};
    const pos = h.positionSizeDefault || {};
    const n = st.sample ?? 0;
    box.innerHTML = `
      <div class="sys-health-panel">
        <div class="muted small" style="font-weight:700; margin-bottom:6px;">Scanner & prediction health</div>
        <div class="muted small" style="line-height:1.6;">
          <div><b>Early Boom track</b> · resolved n=<b>${n}</b>
            · win ${st.winRatePct ?? '—'}% · stop ${st.stopRatePct ?? '—'}%
            ${st.avgReturnPct != null ? ` · avg ret ${st.avgReturnPct}%` : ''}
            ${st.avgMaxFavorablePct != null ? ` · avg MFE ${st.avgMaxFavorablePct}%` : ''}
            ${st.avgMaxAdversePct != null ? ` · avg MAE ${st.avgMaxAdversePct}%` : ''}
          </div>
          <div><b>Golden/Reco</b> · n=${gt.sample??0} · win ${gt.winRatePct??'—'}%</div>
          <div>Data: ${pill(d.yahoo?.ok,'Quotes',d.yahoo?.detail)} ${pill(d.fundamentals?.ok,'Fundamentals',d.fundamentals?.detail)} ${pill(d.fiiDii?.ok,'FII/DII',d.fiiDii?.detail)}</div>
          <div>Size default ₹${pos.capitalInr??10000} · max loss ~${pos.maxLossPct??2}%</div>
          ${n < 20 ? '<div style="color:var(--amber);">⚠ Sample &lt; 20 — probability soft, not proven edge.</div>' : ''}
          ${(h.issues||[]).length ? `<div style="color:var(--amber);">${h.issues.slice(0,3).join(' · ')}</div>` : ''}
          <div class="muted">${h.sitOutHint || ''}</div>
        </div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted small">${err.message}</div>`;
  }
}



let _u200Cache = null;
let _u200Mode = 'balanced';

function u200ActionClass(a) {
  if (a === 'BUY CANDIDATE') return 'buy';
  if (a === 'AVOID') return 'avoid';
  if (a === 'WAIT') return 'wait';
  return 'watch';
}

function u200RankScore(r, mode) {
  if (mode === 'investment') return r.investmentScore ?? r.compositeScore ?? 0;
  if (mode === 'trading') return r.tradingScore ?? r.compositeScore ?? 0;
  return r.compositeScore ?? 0;
}

function renderUnder200List() {
  const box = document.getElementById('under200PageBox') || document.getElementById('under200Box');
  if (!box) return;
  if (!_u200Cache) {
    box.innerHTML = '<div class="muted small">Data load ho raha hai / Refresh dabao.</div>';
    return;
  }
  const d = _u200Cache;
  let rows = [...(d.stocks || d.items || [])];
  const minScore = Number(document.getElementById('u200FilterScore')?.value || 0);
  const sector = document.getElementById('u200FilterSector')?.value || '';
  const action = document.getElementById('u200FilterAction')?.value || '';
  const risk = document.getElementById('u200FilterRisk')?.value || '';
  const sort = document.getElementById('u200Sort')?.value || 'score';
  const mode = _u200Mode || 'balanced';

  rows = rows.filter((r) => {
    const sc = u200RankScore(r, mode);
    if (minScore && sc < minScore) return false;
    if (sector && r.sector !== sector) return false;
    if (action && (r.action || r.actionSignal) !== action) return false;
    if (risk && (r.riskLabel || r.risk) !== risk) return false;
    return true;
  });

  rows.sort((a, b) => {
    if (sort === 'price') return (a.price || 0) - (b.price || 0);
    if (sort === 'change') return (b.changePct || -999) - (a.changePct || -999);
    if (sort === 'fund') return (b.scores?.fundamental || 0) - (a.scores?.fundamental || 0);
    if (sort === 'tech') return (b.scores?.technical || 0) - (a.scores?.technical || 0);
    return u200RankScore(b, mode) - u200RankScore(a, mode);
  });

  const catBox = document.getElementById('u200Categories');
  if (catBox && d.categories) {
    const labels = {
      bestTrading: 'Best Trading',
      bestFundamental: 'Best Fundamental',
      bestMomentum: 'Best Momentum',
      bestRr: 'Best R:R',
      bestBounce: 'Best Bounce',
    };
    const cards = Object.entries(labels).map(([k, lab]) => {
      const v = d.categories[k];
      if (!v) return `<div class="u200-cat muted small"><div class="u200-cat-t">${lab}</div><div>—</div></div>`;
      return `<div class="u200-cat" data-symbol="${v.symbol}"><div class="u200-cat-t">${lab}</div><div class="u200-cat-s">${v.symbol}</div><div class="muted small">₹${Number(v.price).toFixed(1)} · ${v.action || v.actionSignal || ''}</div></div>`;
    }).join('');
    catBox.style.display = 'block';
    catBox.innerHTML = `<div class="u200-cat-grid">${cards}</div>`;
    catBox.querySelectorAll('.u200-cat[data-symbol]').forEach((el) => {
      el.addEventListener('click', () => loadSymbol(el.dataset.symbol, { fromView: 'under200' }));
    });
  }

  const scoreCell = (label, val) => {
    if (val == null) return `<div class="u200-score"><span class="u200-k">${label}</span><span class="muted">N/A</span></div>`;
    const cls = val >= 65 ? 'good' : val >= 45 ? 'mid' : 'weak';
    return `<div class="u200-score ${cls}"><span class="u200-k">${label}</span><span class="u200-v">${val}</span></div>`;
  };

  if (!rows.length) {
    box.innerHTML = '<div class="muted small">Is filter se koi name nahi — filters reset karke dekho.</div>';
    return;
  }

  box.innerHTML = `
    <div class="muted small" style="margin-bottom:8px;">
      Showing <b>${rows.length}</b> / ${(d.count != null ? d.count : rows.length)} · mode <b>${mode}</b>
      ${d.note ? ` · ${d.note}` : ''}
    </div>
    ${rows.map((r, i) => {
      const sc = u200RankScore(r, mode);
      const act = r.action || r.actionSignal || 'WATCH';
      const snap = r.tradingSnapshot;
      const why = r.why || r.whyReasons || [];
      return `
      <div class="u200-block" data-symbol="${r.symbol}">
        <div class="u200-row-compact">
          <div>
            <span class="muted small">#${i + 1}</span>
            <b>${r.symbol}</b>
            <span class="u200-action ${u200ActionClass(act)}">${act}</span>
            <div class="muted small">${r.indexLabel || ''}${r.sector ? ' · ' + r.sector : ''} · risk ${r.riskLabel || r.risk || '—'}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700;">₹${Number(r.price).toFixed(2)}</div>
            <div class="muted small">${r.changePct != null ? (r.changePct >= 0 ? '+' : '') + Number(r.changePct).toFixed(1) + '%' : ''}</div>
          </div>
          <div style="text-align:right;">
            <div class="u200-comp">${Math.round(sc)}</div>
            <button type="button" class="ghost-btn small u200-expand" data-sym="${r.symbol}">Details</button>
          </div>
        </div>
        <div class="u200-detail" id="u200-d-${r.symbol}">
          <div><b>Why:</b> ${(Array.isArray(why) ? why : []).slice(0, 4).join(' · ') || '—'}</div>
          <div style="margin-top:4px;"><b>Positives:</b> ${(r.positives || []).join(' · ') || '—'}</div>
          <div style="margin-top:4px;"><b>Risk flags:</b> ${(r.riskFlags || []).join(' · ') || '—'}</div>
          <div style="margin-top:4px;"><b>Data quality:</b> ${r.dataQuality?.label || '—'} (${r.dataQuality?.score ?? '—'})</div>
          <div class="u200-scores-line">
            ${scoreCell('Fund', r.scores?.fundamental)}
            ${scoreCell('Biz', r.scores?.business)}
            ${scoreCell('FII/DII', r.scores?.fiiDii)}
            ${scoreCell('Vol', r.scores?.orderBook)}
            ${scoreCell('Tech', r.scores?.technical)}
            ${scoreCell('Mom', r.scores?.momentum)}
          </div>
          ${snap ? `<div class="muted small"><b>Trading snapshot:</b>
            Entry ${snap.entryZone || '—'}
            ${snap.trigger ? ' · Trigger ' + snap.trigger : ''}
            ${snap.targetPct != null ? ' · Tgt ~' + snap.targetPct + '%' : ''}
            ${snap.stopLossPct != null ? ' · SL ~' + snap.stopLossPct + '%' : ''}
            ${snap.riskReward != null ? ' · R:R 1:' + snap.riskReward : ''}
            ${snap.expectedHold ? ' · Hold ' + snap.expectedHold : ''}
            ${snap.setupType ? ' · Setup ' + snap.setupType : ''}
          </div>` : '<div class="muted small">Trading snapshot: not available</div>'}
          <button type="button" class="ghost-btn small u200-open" data-symbol="${r.symbol}" style="margin-top:8px;">View Analysis</button>
        </div>
      </div>`;
    }).join('')}
  `;

  box.querySelectorAll('.u200-expand').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('u200-d-' + btn.dataset.sym)?.classList.toggle('open');
    });
  });
  box.querySelectorAll('.u200-open').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadSymbol(btn.dataset.symbol, { fromView: 'under200' });
    });
  });
  box.querySelectorAll('.u200-row-compact').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const sym = row.parentElement?.dataset?.symbol;
      if (sym) document.getElementById('u200-d-' + sym)?.classList.toggle('open');
    });
  });
}


async function loadUnder200() {
  const box = document.getElementById('under200PageBox') || document.getElementById('under200Box');
  const status = document.getElementById('under200PageStatus');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span> Under ₹200…';
  if (status) status.textContent = 'Loading…';
  try {
    const d = await api('/market/under-200?maxPrice=200');
    _u200Cache = d;
    if (status) status.textContent = d.scannedAt ? `As of ${new Date(d.scannedAt).toLocaleString('en-IN')}` : '';
    const secSel = document.getElementById('u200FilterSector');
    if (secSel && d.sectors?.length) {
      const cur = secSel.value;
      secSel.innerHTML = '<option value="">Sector: all</option>' + d.sectors.map((s) => `<option value="${s}">${s}</option>`).join('');
      secSel.value = cur;
    }
    renderUnder200List();
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
    if (status) status.textContent = err.message;
  }
}
document.getElementById('under200RefreshBtn')?.addEventListener('click', () => loadUnder200());
document.getElementById('under200PageRefreshBtn')?.addEventListener('click', () => loadUnder200());
['u200FilterScore', 'u200FilterSector', 'u200FilterAction', 'u200FilterRisk', 'u200Sort'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', () => renderUnder200List());
});
document.querySelectorAll('.u200-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.u200-mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    _u200Mode = btn.dataset.mode || 'balanced';
    renderUnder200List();
  });
});





let _fnoData = null;
let _fnoIndex = 'NIFTY';
let _fnoInterval = '5m';

function fnoSparkline(candles, w = 640, h = 200) {
  if (!candles?.length) return '<div class="muted small">No candles</div>';
  const closes = candles.map((c) => Number(c.c)).filter(Number.isFinite);
  if (closes.length < 2) return '<div class="muted small">Few candles</div>';
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((v, i) => {
    const x = (i / (closes.length - 1)) * (w - 20) + 10;
    const y = h - 15 - ((v - min) / span) * (h - 30);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = closes[closes.length - 1];
  const first = closes[0];
  const up = last >= first;
  const color = up ? '#34d399' : '#f87171';
  return `<svg class="fno-chart-box" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" />
    <text x="12" y="18" fill="var(--muted)" font-size="11">${last.toFixed(2)}</text>
  </svg>`;
}

async function loadFnoChart(index, interval) {
  const host = document.getElementById('fnoChartHost');
  if (!host) return;
  host.innerHTML = '<span class="spin"></span> Chart…';
  try {
    const d = await api(`/fno/chart?index=${encodeURIComponent(index)}&interval=${encodeURIComponent(interval)}`);
    host.innerHTML = fnoSparkline(d.candles || []);
    const meta = document.getElementById('fnoChartMeta');
    if (meta) meta.textContent = `${d.index} · ${d.interval} · ${d.count || 0} bars`;
  } catch (err) {
    host.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

function renderFnoChain(ix) {
  const host = document.getElementById('fnoChainHost');
  if (!host) return;
  const chain = ix?.chain;
  if (!chain?.available || !chain.rows?.length) {
    host.innerHTML = `<div class="muted small">${chain?.error || 'Chain unavailable'}</div>`;
    return;
  }
  const warn = chain.demo
    ? `<div class="muted small" style="color:var(--amber);margin-bottom:8px;"><b>DEMO CHAIN</b> — ${chain.warning || 'Not live exchange quotes. Paper only.'}</div>`
    : `<div class="muted small" style="margin-bottom:6px;">Live-ish NSE · PCR ${chain.pcr ?? '—'} · ATM ${chain.atm ?? '—'} · ${chain.expiry || ''}</div>`;
  const rows = chain.rows.map((row) => {
    const atmCls = chain.atm === row.strike ? 'atm' : '';
    const ce = row.CE || {};
    const pe = row.PE || {};
    return `<tr class="${atmCls}">
      <td class="ce">${ce.oi ?? '—'}</td>
      <td class="ce">${ce.chgOi ?? '—'}</td>
      <td class="ce">${ce.volume ?? '—'}</td>
      <td class="ce">${ce.iv ?? '—'}</td>
      <td class="ce"><b>${ce.ltp ?? '—'}</b></td>
      <td class="strike">${row.strike}</td>
      <td class="pe"><b>${pe.ltp ?? '—'}</b></td>
      <td class="pe">${pe.iv ?? '—'}</td>
      <td class="pe">${pe.volume ?? '—'}</td>
      <td class="pe">${pe.chgOi ?? '—'}</td>
      <td class="pe">${pe.oi ?? '—'}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `${warn}
    <div class="fno-chain-wrap">
      <table class="fno-chain-table">
        <thead>
          <tr>
            <th>CE OI</th><th>CE ΔOI</th><th>CE Vol</th><th>CE IV</th><th>CE LTP</th>
            <th>Strike</th>
            <th>PE LTP</th><th>PE IV</th><th>PE Vol</th><th>PE ΔOI</th><th>PE OI</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderFnoDesk() {
  const box = document.getElementById('fnoBox');
  if (!box || !_fnoData) return;
  const d = _fnoData;
  const indexes = d.indexes || [];
  const ix = indexes.find((x) => x.index === _fnoIndex) || indexes[0];
  if (ix) _fnoIndex = ix.index;
  const rec = d.recommendation || {};
  const rs = d.riskState || {};
  const setup = ix?.setup || {};

  let signalHtml = '';
  if (setup.status === 'TRADE') {
    const ht = setup.howTo || {};
    signalHtml = `
      <div class="card" style="padding:12px; border-left:4px solid var(--green); margin-bottom:10px;">
        <div style="font-weight:700;font-size:1.1rem;">${ht.putOrCall || setup.side} · ${ix.label}</div>
        <div class="muted small">Strike <b>${setup.strike}</b> · Exp <b>${setup.expiry || '—'}</b> ${setup.demo ? '· <span style="color:var(--amber)">DEMO</span>' : ''}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:8px;font-size:13px;">
          <div><span class="muted">Entry</span><div><b>₹${setup.entry}</b></div></div>
          <div><span class="muted">SL</span><div><b>₹${setup.stopLoss}</b></div></div>
          <div><span class="muted">T1</span><div><b>₹${setup.target1}</b></div></div>
          <div><span class="muted">T2</span><div><b>₹${setup.target2}</b></div></div>
          <div><span class="muted">R:R</span><div><b>1:${setup.riskReward}</b></div></div>
          <div><span class="muted">Chance</span><div><b>${setup.probabilityPct}%</b></div></div>
          <div><span class="muted">Lots</span><div><b>${setup.lots ?? '—'}</b> × ${setup.lotSize ?? '?'}</div></div>
          <div><span class="muted">Max risk</span><div><b>₹${setup.maxRiskInr ?? '—'}</b></div></div>
        </div>
        <div class="muted small" style="margin-top:6px;">Hold: ${ht.hold || '—'} · ${setup.invalidation || ''}</div>
        <div class="muted small">${(setup.reasons || []).join(' · ')}</div>
      </div>`;
  } else {
    signalHtml = `
      <div class="card" style="padding:12px; border-left:4px solid var(--amber); margin-bottom:10px;">
        <div style="font-weight:700;">NO TRADE · ${ix?.label || _fnoIndex}</div>
        <div class="muted small">${setup.reason || rec.reason || 'Filters not cleared'}</div>
      </div>`;
  }

  // Best overall
  let bestHtml = '';
  if (rec.status === 'TRADE') {
    bestHtml = `<div class="muted small" style="margin-bottom:8px;">Best across 3: <b>${rec.index} ${rec.side} ${rec.strike}</b> · ${rec.probabilityPct}% ${rec.demo ? '(DEMO)' : ''}</div>`;
  } else {
    bestHtml = `<div class="muted small" style="margin-bottom:8px;">Best: <b>NO TRADE</b> — ${rec.reason || ''}</div>`;
  }

  const capital = Number(document.getElementById('fnoCapitalInput')?.value) || 20000;
  const riskPct = Number(document.getElementById('fnoRiskPctInput')?.value) || 1;
  const riskBudget = Math.round(capital * riskPct / 100);
  let sizeNote = '';
  if (setup.status === 'TRADE' && setup.entry && setup.stopLoss && setup.lotSize) {
    const perLotRisk = (setup.entry - setup.stopLoss) * setup.lotSize;
    const lotsFit = perLotRisk > 0 ? Math.max(0, Math.floor(riskBudget / perLotRisk)) : 0;
    sizeNote = `Risk budget ₹${riskBudget} → ~${lotsFit} lot(s) @ ₹${perLotRisk.toFixed(0)} risk/lot (model)`;
  }

  box.innerHTML = `
    <div class="muted small">Session ${d.sessionOpen ? 'open' : 'closed'} · Market ${d.marketTrend || '—'} · Risk desk: ${rs.canTrade === false ? 'BLOCKED ' + (rs.blockReason || '') : 'can trade'} · trades ${rs.tradesToday ?? 0}</div>
    ${bestHtml}
    <div class="fno-index-tabs">
      ${indexes.map((x) => `<button type="button" class="ghost-btn small ${x.index === _fnoIndex ? 'active' : ''}" data-fno-idx="${x.index}">${x.label || x.index}</button>`).join('')}
    </div>
    ${signalHtml}
    <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
      <div class="fno-tf-tabs">
        ${['1m','5m','15m','1h','1d'].map((tf) => `<button type="button" class="ghost-btn small ${tf === _fnoInterval ? 'active' : ''}" data-fno-tf="${tf}">${tf}</button>`).join('')}
      </div>
      <span class="muted small" id="fnoChartMeta"></span>
    </div>
    <div id="fnoChartHost"></div>
    <div style="font-weight:600; margin-top:12px;">Option chain · ${ix?.label || ''}</div>
    <div id="fnoChainHost"></div>
    <div class="fno-paper">
      <div style="font-weight:600;">Paper / risk calculator</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; align-items:center;">
        <label class="muted small">Capital ₹ <input id="fnoCapitalInput" type="number" value="${capital}" style="width:100px;" /></label>
        <label class="muted small">Risk % <input id="fnoRiskPctInput" type="number" value="${riskPct}" min="0.5" max="5" step="0.5" style="width:70px;" /></label>
        <button type="button" class="ghost-btn small" id="fnoSizeBtn">Calc size</button>
      </div>
      <div class="muted small" id="fnoSizeNote" style="margin-top:6px;">${sizeNote || 'Scan + TRADE signal pe size suggest hoga'}</div>
      <div style="margin-top:10px;">
        <button type="button" class="ghost-btn small" id="fnoPaperBuy" ${setup.status === 'TRADE' ? '' : 'disabled'}>Paper ${setup.side || 'CE/PE'}</button>
        <span class="muted small" id="fnoPaperMsg"></span>
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input id="fnoPnlInput" type="number" placeholder="Outcome PnL ₹" style="max-width:140px;" />
        <button type="button" class="ghost-btn small" id="fnoOutcomeBtn">Save outcome</button>
      </div>
    </div>
  `;

  renderFnoChain(ix);
  loadFnoChart(_fnoIndex, _fnoInterval);

  box.querySelectorAll('[data-fno-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _fnoIndex = btn.dataset.fnoIdx;
      renderFnoDesk();
    });
  });
  box.querySelectorAll('[data-fno-tf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _fnoInterval = btn.dataset.fnoTf;
      renderFnoDesk();
    });
  });
  document.getElementById('fnoSizeBtn')?.addEventListener('click', () => renderFnoDesk());
  document.getElementById('fnoPaperBuy')?.addEventListener('click', () => {
    const msg = document.getElementById('fnoPaperMsg');
    if (setup.status !== 'TRADE') return;
    const ticket = {
      at: new Date().toISOString(),
      index: ix.index,
      side: setup.side,
      strike: setup.strike,
      entry: setup.entry,
      sl: setup.stopLoss,
      t1: setup.target1,
      demo: !!setup.demo,
    };
    try {
      const key = 'fno_paper_tickets';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.unshift(ticket);
      localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
    } catch (_) {}
    if (msg) msg.textContent = `Paper logged: ${ticket.side} ${ticket.strike} @ ₹${ticket.entry}${ticket.demo ? ' (DEMO)' : ''}`;
  });
  document.getElementById('fnoOutcomeBtn')?.addEventListener('click', async () => {
    const pnl = Number(document.getElementById('fnoPnlInput')?.value);
    if (!Number.isFinite(pnl)) { toast('PnL number dalo'); return; }
    try {
      await api('/fno/outcome', { method: 'POST', body: JSON.stringify({ pnl }) });
      toast('Outcome saved');
      loadFnoDesk();
    } catch (err) { toast(err.message); }
  });
}

async function loadFnoDesk() {
  const box = document.getElementById('fnoBox');
  const status = document.getElementById('fnoStatus');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span> Scanning NIFTY → BANKNIFTY → SENSEX…';
  if (status) status.textContent = 'Running…';
  try {
    const d = await api('/fno/intelligence');
    _fnoData = d;
    box.dataset.scanned = '1';
    if (status) status.textContent = d.asOf ? new Date(d.asOf).toLocaleString('en-IN') : '';
    renderFnoDesk();
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
    if (status) status.textContent = err.message;
  }
}
document.getElementById('fnoScanBtn')?.addEventListener('click', () => loadFnoDesk());


// ---------- Zero-Loss / +5% Engine ----------
function zlPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(1) + '%';
}

function renderZeroLossCard(d) {
  if (!d) return '';
  const dec = d.decision || 'NO TRADE';
  const cls = dec.startsWith('BUY') ? 'buy' : dec.startsWith('WATCH') ? 'watch' : 'no';
  const sim = d.simulation || {};
  const p2 = sim.pPlus5BeforeMinus2 || {};
  const entry = d.entry || {};
  const rejects = (d.rejects || []).map((r) => r.msg || r.code).join(' · ');
  return `
    <div class="zl-card">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
        <div>
          <b style="font-size:1.1rem;">${d.symbol}</b>
          <span class="zl-decision ${cls}">${dec}</span>
          <span class="muted small">Conf ${d.confidence?.label || '—'} (${d.confidence?.score ?? '—'}) · n=${d.confidence?.sampleSize ?? sim.sampleSize ?? '—'}</span>
        </div>
        <button type="button" class="ghost-btn small" data-zl-open="${d.symbol}">View Analysis</button>
      </div>
      <div class="zl-matrix">
        <div><div class="muted small">P(+5% before −1%)</div><b>${sim.pPlus5BeforeMinus1?.upBeforeDownPct != null ? zlPct(sim.pPlus5BeforeMinus1.upBeforeDownPct) : '—'}</b></div>
        <div><div class="muted small">P(+5% before −2%)</div><b>${zlPct(p2.upBeforeDownPct)}</b></div>
        <div><div class="muted small">P(+5% before −3%)</div><b>${zlPct(sim.pPlus5BeforeMinus3?.upBeforeDownPct)}</b></div>
        <div><div class="muted small">Avg MFE / MAE</div><b>${zlPct(sim.avgMfePct)} / ${zlPct(sim.avgMaePct)}</b></div>
        <div><div class="muted small">Median days to +5%</div><b>${sim.medianDaysToPlus5 ?? '—'}</b></div>
        <div><div class="muted small">Entry zone</div><b>${entry.entryZone || '—'}</b></div>
        <div><div class="muted small">SL · T+5%</div><b>₹${entry.stopLoss ?? '—'} · ₹${entry.target5Pct ?? '—'}</b></div>
        <div><div class="muted small">R:R to +5%</div><b>${entry.riskRewardTo5 != null ? '1:' + entry.riskRewardTo5 : '—'}</b></div>
      </div>
      ${rejects ? `<div class="muted small" style="margin-top:8px; color:var(--amber);"><b>Hard rejects:</b> ${rejects}</div>` : ''}
      <div class="muted small" style="margin-top:6px;">${entry.rationale || ''}</div>
      ${(d.honesty || []).slice(0, 2).map((h) => `<div class="muted small">• ${h}</div>`).join('')}
    </div>`;
}

async function loadZeroLossScan() {
  const box = document.getElementById('zlScanBox');
  const st = document.getElementById('zlScanStatus');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span> Scanning candidates through zero-loss gates…';
  if (st) st.textContent = 'May take a minute — each name needs path history…';
  try {
    const d = await api('/zero-loss/scan');
    if (st) st.textContent = `Evaluated ${d.evaluated || 0} / ${d.scannedCandidates || 0} · ${new Date(d.asOf).toLocaleTimeString('en-IN')}`;
    if (d.noTradeNote && !(d.buys || []).length) {
      box.innerHTML = `<div class="zl-card"><span class="zl-decision no">NO TRADE — WAIT FOR BETTER SETUP</span>
        <div class="muted small" style="margin-top:8px;">${d.noTradeNote}</div></div>
        ${(d.watches || []).slice(0, 3).map(renderZeroLossCard).join('')}`;
    } else {
      box.innerHTML = (d.buys || []).map(renderZeroLossCard).join('') +
        ((d.watches || []).length ? `<div class="muted small" style="margin:10px 0 6px;">Watch only</div>${d.watches.slice(0, 3).map(renderZeroLossCard).join('')}` : '');
    }
    box.querySelectorAll('[data-zl-open]').forEach((btn) => {
      btn.addEventListener('click', () => loadSymbol(btn.getAttribute('data-zl-open'), { fromView: 'zero-loss' }));
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

async function runZeroLossEval() {
  const sym = (document.getElementById('zlSymInput')?.value || '').trim().toUpperCase();
  const box = document.getElementById('zlEvalBox');
  if (!sym || !box) return;
  const bt = document.getElementById('zlBtCheck')?.checked ? '?backtest=1' : '';
  box.innerHTML = '<span class="spin"></span> Running path engine…';
  try {
    const d = await api('/zero-loss/' + encodeURIComponent(sym) + bt);
    box.innerHTML = renderZeroLossCard(d);
    if (d.engineBacktest) {
      const b = d.engineBacktest;
      box.innerHTML += `<div class="muted small" style="margin-top:8px;">Backtest n=${b.totalTrades ?? '—'} · win ${b.winRate ?? '—'} · max DD ${b.maxDrawdownPct ?? '—'}% · conf ${b.backtestConfidence?.label || b.backtestConfidence || '—'}</div>`;
    }
    box.querySelectorAll('[data-zl-open]').forEach((btn) => {
      btn.addEventListener('click', () => loadSymbol(btn.getAttribute('data-zl-open'), { fromView: 'zero-loss' }));
    });
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

async function runZeroLossDefend() {
  const sym = (document.getElementById('zlDefSym')?.value || '').trim().toUpperCase();
  const entry = Number(document.getElementById('zlDefEntry')?.value);
  const box = document.getElementById('zlDefBox');
  if (!sym || !entry || !box) {
    if (box) box.innerHTML = '<div class="muted small">Symbol + entry price required</div>';
    return;
  }
  box.innerHTML = '<span class="spin"></span>';
  try {
    const d = await api('/zero-loss/defend', {
      method: 'POST',
      body: JSON.stringify({ symbol: sym, entryPrice: entry }),
    });
    const def = d.defense || {};
    box.innerHTML = `
      <div class="zl-card">
        <span class="zl-decision ${def.action === 'EXIT' ? 'no' : def.action === 'TRAIL' ? 'buy' : 'watch'}">${def.action}: ${def.label}</span>
        <div style="margin-top:8px;">${def.reason}</div>
        <div class="muted small">P&L ${def.pnlPct ?? '—'}% · Live ₹${d.price ?? '—'}</div>
        <div class="muted small">${def.addNote || ''}</div>
        <div class="muted small">Path n=${d.pathSummary?.sampleSize ?? '—'} · P(+5 before −2)=${d.pathSummary?.p5Before2?.upBeforeDownPct ?? '—'}%</div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="color:var(--red)">${err.message}</div>`;
  }
}

document.getElementById('zlScanBtn')?.addEventListener('click', () => loadZeroLossScan());
document.getElementById('zlEvalBtn')?.addEventListener('click', () => runZeroLossEval());
document.getElementById('zlDefBtn')?.addEventListener('click', () => runZeroLossDefend());


/* ========== Early Opportunity Engine ========== */
const EO_TAB_META = {
  deep_fall_reversal: { label: 'Deep-Fall Reversal', icon: '🔻' },
  bottom_formation: { label: 'Bottom Formation', icon: '🧱' },
  pre_breakout: { label: 'Pre-Breakout', icon: '📦' },
  early_continuation: { label: 'Continuation', icon: '🚀' },
  active: { label: 'Active Signals', icon: '📡' },
  failed: { label: 'Failed', icon: '⚠️' },
  accuracy: { label: 'Backtest / Accuracy', icon: '📊' },
};
let _eoCache = null;
let _eoTab = 'deep_fall_reversal';

function eoActionCls(a) {
  if (a === 'BUY NOW') return 'buy';
  if (a === 'WAIT') return 'wait';
  if (a === 'WATCHLIST') return 'watch';
  return 'no';
}

function renderEoCard(c) {
  const act = c.action || c.entryReadiness || 'WAIT';
  const ez = c.entryZone;
  const tg = c.targets || {};
  const hist = c.historicalProbability || {};
  const fd = c.firstDetection || {};
  const confLabel = c.confidence || '—';
  const confReason = c.confidenceDetail?.reason || '';
  const setupSc = c.setupScore ?? c.score;
  const same = hist.sameDay || {};
  const stopRisk = hist.stopFirstRisk;
  const confCls = confLabel === 'HIGH' ? 'eo-conf-high' : confLabel === 'MED' ? 'eo-conf-med' : confLabel === 'INSUFFICIENT' ? 'eo-conf-ins' : 'eo-conf-low';
  return `<div class="eo-card" data-symbol="${c.symbol}">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <div>
        <b>${c.symbol}</b>
        <span class="eo-action ${eoActionCls(act)}">${act}</span>
        <span class="muted small">${c.indexLabel || ''} · ₹${c.price != null ? Number(c.price).toFixed(2) : '—'}</span>
        ${c.stage ? `<span class="muted small"> · ${c.stage}</span>` : ''}
        ${c.alreadyMoved ? '<span class="muted small" style="color:#fbbf24;"> · Already moved</span>' : ''}
      </div>
      <div class="muted small" style="text-align:right;line-height:1.45;">
        Setup <b>${setupSc ?? '—'}</b><br/>
        Conf <span class="${confCls}"><b>${confLabel}</b></span>
        ${c.sampleSize != null ? `<span class="muted"> n=${c.sampleSize}</span>` : ''}
      </div>
    </div>
    <div class="muted small" style="margin-top:6px;">
      Entry ${ez ? `₹${Number(ez.low).toFixed(2)}–₹${Number(ez.high).toFixed(2)}` : '—'}
      · SL ₹${c.stopLoss != null ? Number(c.stopLoss).toFixed(2) : '—'}
      · T1 ₹${tg.t1 != null ? Number(tg.t1).toFixed(2) : '—'}
      ${tg.t2 != null ? `· T2 ₹${Number(tg.t2).toFixed(2)}` : ''}
      · R:R ${c.riskReward != null ? '1:' + Number(c.riskReward).toFixed(2) : '—'}
      ${c.riskRewardNet != null ? `(net ~1:${Number(c.riskRewardNet).toFixed(2)})` : ''}
    </div>
    ${c.trigger ? `<div class="muted small">Trigger: ${c.trigger}</div>` : ''}
    <div class="muted small" style="margin-top:4px;">
      First detect: ${fd.at ? new Date(fd.at).toLocaleString('en-IN') : 'now'}
      @ ₹${fd.price != null ? Number(fd.price).toFixed(2) : '—'}
      ${fd.returnPct != null ? ` · since ${fd.returnPct > 0 ? '+' : ''}${fd.returnPct}%` : ''}
    </div>
    <div class="muted small">
      Hist probs: ${hist.insufficient || same.p5 == null ? 'withheld (sample)' : `+5% ~${same.p5}%`}
      ${stopRisk != null ? ` · stop-first risk ~${stopRisk}%` : ''}
      ${hist.note ? ` · ${hist.note}` : ''}
    </div>
    <div class="muted small" style="margin-top:4px;">Bullish: ${(c.bullishEvidence || c.reasons || []).slice(0,3).join(' · ') || '—'}</div>
    ${(c.bearishEvidence || c.risks || []).length ? `<div class="muted small" style="color:#fca5a5;">Bearish: ${(c.bearishEvidence || c.risks).slice(0,3).join(' · ')}</div>` : ''}
    ${c.entryReadinessNote ? `<div class="muted small">${c.entryReadinessNote}</div>` : ''}
    ${confReason ? `<div class="muted small">Confidence: ${confReason}</div>` : ''}
    ${c.sampleWarning ? `<div class="muted small">⚠ ${c.sampleWarning}</div>` : ''}
    <div class="muted small">Invalidation: ${c.invalidation || '—'}</div>
    <div class="muted small">Fresh: ${c.dataFreshness ? new Date(c.dataFreshness).toLocaleString('en-IN') : '—'}</div>
    <button type="button" class="ghost-btn small eo-open" data-symbol="${c.symbol}" style="margin-top:8px;">View Full Analysis</button>
  </div>`;
}

function renderEoBoard() {
  const board = document.getElementById('eoBoard');
  if (!board || !_eoCache) return;
  if (_eoTab === 'accuracy') {
    board.innerHTML = '<span class="spin"></span> Loading accuracy…';
    api('/early-opportunity/accuracy').then((acc) => {
      board.innerHTML = `<div class="eo-card">
        <div style="font-weight:700;">Stored signal outcomes</div>
        <div class="muted small" style="margin-top:6px;">Sample: <b>${acc.sampleSize ?? 0}</b>
          ${acc.targetHitPct != null ? ` · Target hit ${acc.targetHitPct}%` : ''}
          ${acc.stopHitPct != null ? ` · SL hit ${acc.stopHitPct}%` : ''}
        </div>
        <div class="muted small" style="margin-top:8px;">${acc.note || acc.limitation || 'No fabricated accuracy. Results only after real resolutions.'}</div>
        <div class="muted small" style="margin-top:8px;">Single-symbol research: open a stock → API <code>/api/early-opportunity/backtest/SYMBOL</code></div>
      </div>`;
    }).catch((e) => { board.innerHTML = `<div class="muted">${e.message}</div>`; });
    return;
  }
  if (_eoTab === 'active' || _eoTab === 'failed') {
    board.innerHTML = '<span class="spin"></span>';
    api(`/early-opportunity/${_eoTab === 'active' ? 'active' : 'failed'}`).then((d) => {
      const rows = d.signals || [];
      if (!rows.length) {
        board.innerHTML = `<div class="muted small">No ${_eoTab} stored signals yet.</div>`;
        return;
      }
      board.innerHTML = rows.map((s) => `<div class="eo-card"><b>${s.symbol}</b> · ${s.scanner}
        <div class="muted small">Detect ₹${s.detectPrice} · status ${s.status} · ${s.tradeDate || ''}</div></div>`).join('');
    }).catch((e) => { board.innerHTML = `<div class="muted">${e.message}</div>`; });
    return;
  }
  const list = (_eoCache.scanners && _eoCache.scanners[_eoTab]) || [];
  if (!list.length) {
    board.innerHTML = `<div class="muted small">Is scanner me abhi koi clear name nahi — NO forced picks. Weak confluence = empty list is correct.</div>`;
    return;
  }
  board.innerHTML = list.map(renderEoCard).join('');
  board.querySelectorAll('.eo-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.symbol;
      if (sym && typeof loadSymbol === 'function') loadSymbol(sym, { fromView: 'early-opportunity' });
      else if (sym) location.hash = '#stock/' + sym;
    });
  });
}

async function loadEarlyOpportunity(force = false) {
  const meta = document.getElementById('eoMeta');
  const board = document.getElementById('eoBoard');
  const tabs = document.getElementById('eoTabs');
  if (!board) return;
  if (meta) meta.innerHTML = '<span class="spin"></span> Scanning universe…';
  board.innerHTML = '';
  try {
    const q = force ? '?force=1' : '';
    const data = await api('/early-opportunity/scan' + q);
    _eoCache = data;
    if (data.marketClosed) {
      if (meta) meta.textContent = `⏸ ${data.skipReason || 'Market closed'} — scanners pause outside session.`;
      board.innerHTML = `<div class="market-closed-banner">${data.message || 'Market closed'}</div>`;
      return;
    }
    if (meta) {
      meta.textContent = `Scanned ${data.scannedCount || '—'} · ${data.scannedAt ? new Date(data.scannedAt).toLocaleString('en-IN') : ''} · Market: ${data.marketTrend || '—'} · ${data.disclaimer || ''}`;
    }
    if (tabs) {
      const keys = ['deep_fall_reversal', 'bottom_formation', 'pre_breakout', 'early_continuation', 'active', 'failed', 'accuracy'];
      tabs.innerHTML = keys.map((k) => {
        const m = EO_TAB_META[k];
        const n = data.scanners?.[k]?.length;
        const badge = n != null ? ` (${n})` : '';
        return `<button type="button" class="eo-tab ${k === _eoTab ? 'active' : ''}" data-eo="${k}">${m.icon} ${m.label}${badge}</button>`;
      }).join('');
      tabs.querySelectorAll('.eo-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          _eoTab = btn.dataset.eo;
          tabs.querySelectorAll('.eo-tab').forEach((b) => b.classList.toggle('active', b === btn));
          renderEoBoard();
        });
      });
    }
    renderEoBoard();
  } catch (err) {
    if (meta) meta.textContent = err.message;
    board.innerHTML = `<div class="muted">${err.message}</div>`;
  }
}

document.getElementById('eoScanBtn')?.addEventListener('click', () => loadEarlyOpportunity(false));

// Hook view switch if app uses data-view clicks
document.querySelectorAll('.tab-btn[data-view="early-opportunity"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setTimeout(() => loadEarlyOpportunity(false), 50);
  });
});


/* ========== Crash Recovery & Bounce Predictor (independent) ========== */
const CR_TABS = {
  deep_fall: { label: 'Deep-Fall Stocks', icon: '📉' },
  strong_fund_temp_fall: { label: 'Strong Fund, Temp Fall', icon: '🏛️' },
  reversal_forming: { label: 'Reversal Forming', icon: '🔄' },
  bounce_confirmed: { label: 'Bounce Confirmed', icon: '✅' },
  high_downside_risk: { label: 'High Downside Risk', icon: '⚠️' },
  failed: { label: 'Failed Recoveries', icon: '❌' },
  accuracy: { label: 'Historical Accuracy', icon: '📊' },
};
let _crCache = null;
let _crTab = 'deep_fall';

function crStatusCls(s) {
  if (s === 'BUY NOW' || s === 'BUY ON DIP') return 'buy';
  if (s === 'WAIT FOR CONFIRMATION') return 'wait';
  if (s === 'AVOID') return 'avoid';
  return 'watch';
}

function renderCrCard(c) {
  const st = c.plan?.status || 'WATCHLIST';
  const p = c.probs || {};
  const bounce3 = p.bounce?.['3pct'];
  const down3 = p.furtherDown?.['3pct'];
  const nf = p.noFurtherSignificantDownside || {};
  const plan = c.plan || {};
  const ez = plan.entryZone;
  return `<div class="cr-card" data-symbol="${c.symbol}">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <div>
        <b>${c.symbol}</b>
        <span class="cr-status ${crStatusCls(st)}">${st}</span>
        <span class="muted small">${c.indexLabel || ''} · ₹${c.price != null ? Number(c.price).toFixed(2) : '—'}</span>
        <span class="cr-fall"> ${c.fallPct != null ? c.fallPct + '%' : ''}</span>
      </div>
      <div class="muted small" style="text-align:right;">
        Tech ${c.tech?.score ?? '—'} · Fund ${c.fund?.label || '—'}
      </div>
    </div>
    <div class="muted small" style="margin-top:6px;">
      Entry ${ez ? `₹${ez.low}–₹${ez.high}` : '—'}
      · SL ₹${plan.stopLoss ?? '—'}
      · T1 ₹${plan.targets?.t1 ?? '—'} · T2 ₹${plan.targets?.t2 ?? '—'} · T3 ₹${plan.targets?.t3 ?? '—'}
      · R:R ${plan.riskReward != null ? '1:' + plan.riskReward : '—'}${plan.riskRewardNet != null ? ` (net 1:${plan.riskRewardNet})` : ''}
    </div>
    <div class="muted small">Trigger: ${plan.trigger || '—'}</div>
    <div class="muted small" style="margin-top:4px;">
      Bounce ~3%: <b>${bounce3 != null ? bounce3 + '%' : 'Insufficient evidence'}</b>
      · Further down ~3%: <b>${down3 != null ? down3 + '%' : '—'}</b>
      · No further −3%/3d: <b>${nf.value != null ? nf.value + '% (' + (nf.claim || '') + ')' : (nf.claim || 'Insufficient evidence')}</b>
      ${p.sampleSize != null ? ` · n=${p.sampleSize}` : ''}
    </div>
    <div class="muted small">Why: ${(c.tech?.reasons || []).slice(0,3).join(' · ') || '—'}</div>
    ${(c.tech?.risks || []).length ? `<div class="muted small" style="color:#fca5a5;">Risks: ${c.tech.risks.slice(0,3).join(' · ')}</div>` : ''}
    ${(c.news?.redFlags || []).length ? `<div class="muted small" style="color:#f87171;">News: ${c.news.redFlags[0]}</div>` : ''}
    <div class="muted small">Invalidation: ${plan.invalidation || '—'}</div>
    <div class="muted small">Updated ${c.detectedAt ? new Date(c.detectedAt).toLocaleString('en-IN') : '—'}</div>
    <button type="button" class="ghost-btn small cr-open" data-symbol="${c.symbol}" style="margin-top:8px;">Full analysis</button>
  </div>`;
}

function renderCrBoard() {
  const board = document.getElementById('crBoard');
  if (!board) return;
  if (_crTab === 'accuracy') {
    board.innerHTML = '<span class="spin"></span>';
    api('/crash-recovery/accuracy').then((a) => {
      board.innerHTML = `<div class="cr-card"><b>Historical accuracy</b>
        <div class="muted small" style="margin-top:6px;">Resolved n=<b>${a.sampleSize ?? 0}</b>
          ${a.bounceHitPct != null ? ` · Bounce hit ${a.bounceHitPct}%` : ''}
          ${a.failedPct != null ? ` · Failed ${a.failedPct}%` : ''}
        </div>
        <div class="muted small">${a.note || 'No fabricated accuracy.'}</div>
        <div class="muted small" style="margin-top:6px;">Symbol backtest: <code>/api/crash-recovery/backtest/SYMBOL</code></div>
      </div>`;
    }).catch((e) => { board.innerHTML = `<div class="muted">${e.message}</div>`; });
    return;
  }
  if (_crTab === 'failed') {
    board.innerHTML = '<span class="spin"></span>';
    api('/crash-recovery/failed').then((d) => {
      const rows = d.signals || [];
      board.innerHTML = rows.length
        ? rows.map((s) => `<div class="cr-card"><b>${s.symbol}</b> · ${s.outcome} · first ₹${s.firstPrice}</div>`).join('')
        : '<div class="muted small">No failed recoveries stored yet.</div>';
    }).catch((e) => { board.innerHTML = `<div class="muted">${e.message}</div>`; });
    return;
  }
  const list = (_crCache?.tabs && _crCache.tabs[_crTab]) || [];
  if (!list.length) {
    board.innerHTML = '<div class="muted small">Is tab me abhi koi clear name nahi — empty list = weak evidence (sahi). Forced bounce nahi.</div>';
    return;
  }
  board.innerHTML = list.map(renderCrCard).join('');
  board.querySelectorAll('.cr-open').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.symbol;
      if (sym && typeof loadSymbol === 'function') loadSymbol(sym, { fromView: 'early-opportunity' });
      else if (sym) location.hash = '#stock/' + sym;
    });
  });
}


/** Poll progress job until done; show live stock names in metaEl / boardEl */
async function pollScanJob(jobId, { metaEl, boardEl, jobPath, onDone }) {
  const recent = [];
  const maxPoll = 180; // ~3 min at 1s
  for (let i = 0; i < maxPoll; i++) {
    await new Promise((r) => setTimeout(r, 900));
    let job;
    try {
      job = await api(jobPath + jobId);
    } catch (e) {
      if (metaEl) metaEl.textContent = e.message;
      continue;
    }
    const pct = job.percent ?? 0;
    const sym = job.detail || '';
    if (sym) {
      recent.push(sym);
      while (recent.length > 12) recent.shift();
    }
    const msg = job.message || 'Scanning…';
    if (metaEl) {
      metaEl.innerHTML = `<span class="spin"></span> <b>${pct}%</b> · ${msg}${sym ? ` · <b>${sym}</b>` : ''} (${job.completed || 0}/${job.total || '?'})`;
    }
    if (boardEl) {
      const chips = recent.map((s) => `<span class="scan-chip">${s}</span>`).join('');
      boardEl.innerHTML = `<div class="scan-progress-box">
        <div class="muted small">Processing stocks…</div>
        <div class="scan-chip-row">${chips || '<span class="muted small">Starting…</span>'}</div>
        <div class="muted small" style="margin-top:8px;">${pct}% complete</div>
      </div>`;
    }
    if (job.done || job.phase === 'done') {
      if (typeof onDone === 'function') onDone(job.result || null, job);
      return job;
    }
  }
  if (metaEl) metaEl.textContent = 'Scan timed out — try Refresh again.';
  return null;
}

async function loadCrashRecovery(force = false) {
  const meta = document.getElementById('crMeta');
  const board = document.getElementById('crBoard');
  const tabs = document.getElementById('crTabs');
  if (!board) return;
  if (meta) meta.innerHTML = '<span class="spin"></span> Starting crash recovery scan…';
  board.innerHTML = '<div class="scan-progress-box"><div class="muted small">Preparing universe…</div></div>';
  try {
    const start = await api('/crash-recovery/scan-async' + (force ? '?force=1' : ''), {
      method: 'POST',
      body: JSON.stringify({ force: !!force }),
    });
    if (start.marketClosed) {
      if (meta) meta.textContent = `⏸ ${start.skipReason || 'Market closed'}`;
      board.innerHTML = `<div class="market-closed-banner">${start.message || 'Paused outside market hours'}</div>`;
      return;
    }
    if (!start.jobId) {
      // fallback sync
      const data = await api('/crash-recovery/scan' + (force ? '?force=1' : ''));
      _crCache = data;
      finishCrashRecoveryUI(data, meta, tabs, board);
      return;
    }
    await pollScanJob(start.jobId, {
      metaEl: meta,
      boardEl: board,
      jobPath: '/crash-recovery/job/',
      onDone: (data) => {
        if (!data || data.ok === false) {
          if (meta) meta.textContent = data?.error || 'Scan failed';
          board.innerHTML = `<div class="muted">${data?.error || 'Scan failed'}</div>`;
          return;
        }
        _crCache = data;
        finishCrashRecoveryUI(data, meta, tabs, board);
      },
    });
  } catch (err) {
    if (meta) meta.textContent = err.message;
    board.innerHTML = `<div class="muted">${err.message}</div>`;
  }
}

function finishCrashRecoveryUI(data, meta, tabs, board) {
  if (meta) {
    meta.textContent = `Scanned ${data.scannedCount || '—'} · falls matched ${data.allCount || 0} · ${data.scannedAt ? new Date(data.scannedAt).toLocaleString('en-IN') : ''} · ${data.disclaimer || ''}`;
  }
  if (tabs) {
    const keys = Object.keys(CR_TABS);
    tabs.innerHTML = keys.map((k) => {
      const n = data.tabs?.[k]?.length;
      const badge = n != null ? ` (${n})` : '';
      return `<button type="button" class="eo-tab ${_crTab === k ? 'active' : ''}" data-cr="${k}">${CR_TABS[k].icon} ${CR_TABS[k].label}${badge}</button>`;
    }).join('');
    tabs.querySelectorAll('.eo-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        _crTab = btn.dataset.cr;
        tabs.querySelectorAll('.eo-tab').forEach((b) => b.classList.toggle('active', b === btn));
        renderCrBoard();
      });
    });
  }
  renderCrBoard();
}

document.getElementById('crScanBtn')?.addEventListener('click', () => loadCrashRecovery(false));
document.querySelectorAll('.tab-btn[data-view="crash-recovery"]').forEach((btn) => {
  btn.addEventListener('click', () => setTimeout(() => loadCrashRecovery(false), 40));
});


/* ========== Today's Best Reversal Picks (max 2–3) ========== */
async function loadBestReversalPicks(force = false) {
  const meta = document.getElementById('brMeta');
  const board = document.getElementById('brBoard');
  if (!board) return;
  if (meta) meta.innerHTML = '<span class="spin"></span> Starting best-reversal scan…';
  board.innerHTML = '<div class="scan-progress-box"><div class="muted small">Preparing…</div></div>';
  try {
    const start = await api('/best-reversal/scan-async' + (force ? '?force=1' : ''), {
      method: 'POST',
      body: JSON.stringify({ force: !!force }),
    });
    if (start.marketClosed) {
      if (meta) meta.textContent = `⏸ ${start.skipReason || 'Market closed'}`;
      board.innerHTML = `<div class="market-closed-banner">Outside market hours</div>`;
      return;
    }
    let d = null;
    if (start.jobId) {
      await pollScanJob(start.jobId, {
        metaEl: meta,
        boardEl: board,
        jobPath: '/best-reversal/job/',
        onDone: (result) => { d = result; },
      });
    } else {
      d = await api('/best-reversal/today' + (force ? '?force=1' : ''));
    }
    if (!d) {
      if (meta) meta.textContent = 'No result';
      return;
    }
    if (d.marketClosed) {
      if (meta) meta.textContent = `⏸ ${d.skipReason || 'Market closed'}`;
      board.innerHTML = `<div class="market-closed-banner">${d.message || 'Outside market hours'}</div>`;
      return;
    }
    if (meta) {
      meta.textContent = `${d.message || ''} · Scanned ${d.scannedCount || '—'} · ${d.scannedAt ? new Date(d.scannedAt).toLocaleString('en-IN') : ''} · ${d.disclaimer || ''}`;
    }
    const picks = d.picks || [];
    if (!picks.length || d.noTrade) {
      board.innerHTML = `<div class="br-notrade">
        <div style="font-weight:800;font-size:1.05rem;">NO TRADE</div>
        <div class="muted" style="margin-top:8px;">Aaj koi fully confirmed, fund-acceptable reversal nahi mila. Forced pick nahi.</div>
      </div>`;
      return;
    }
    board.innerHTML = picks.map((p, i) => {
      const act = p.action || 'WAIT FOR CONFIRMATION';
      const cls = (act === 'BUY NOW' || act === 'BUY ON DIP') ? 'buy' : (act === 'WATCHLIST' ? 'watch' : 'wait');
      const ez = p.entryZone || {};
      const pr = p.probabilities || {};
      return `<div class="br-pick">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div>
            <span class="muted small">#${i + 1}</span>
            <b style="font-size:1.15rem;margin-left:4px;">${p.symbol}</b>
            <span class="muted small">${p.indexLabel || ''} · ₹${Number(p.price).toFixed(2)}</span>
            <span class="br-action ${cls}" style="margin-left:8px;">${act}</span>
          </div>
          <div class="muted small">Quality ${p.quality ?? '—'} · Confirm ${p.confirmationScore ?? '—'}</div>
        </div>
        <div class="br-grid">
          <div>Entry zone<b>₹${ez.low ?? '—'} – ₹${ez.high ?? '—'}</b></div>
          <div>Stop-loss<b>₹${p.stopLoss ?? '—'}</b> <span class="muted">(${p.downsidePct ?? '—'}%)</span></div>
          <div>Target 1<b>₹${p.target1 ?? '—'}</b> <span class="muted">(+${p.upsidePct ?? '—'}%)</span></div>
          <div>Target 2<b>₹${p.target2 ?? '—'}</b></div>
          <div>R:R (net)<b>${p.riskRewardNet != null ? '1:' + p.riskRewardNet : (p.riskReward != null ? '1:' + p.riskReward : '—')}</b></div>
          <div>1–7d probs<b>${pr.targetHitEstimate != null ? 'Up ~' + pr.targetHitEstimate + '%' : 'n/a'}</b>
            <span class="muted">${pr.furtherDownEstimate != null ? ' · Down ~' + pr.furtherDownEstimate + '%' : ''} · ${pr.confidence || ''} n=${pr.sampleSize ?? '—'}</span>
          </div>
        </div>
        <div class="muted small" style="margin-top:8px;"><b>Trigger:</b> ${p.trigger || '—'}</div>
        <div class="muted small" style="margin-top:6px;">
          ${(p.reasons || []).map((r, idx) => `<div>${idx + 1}. ${r}</div>`).join('') || '—'}
        </div>
        ${(p.risks || []).length ? `<div class="muted small" style="color:#fca5a5;margin-top:4px;">Watch: ${p.risks.join(' · ')}</div>` : ''}
        <div class="muted small" style="margin-top:6px;"><b>Invalidation:</b> ${p.invalidation || '—'}</div>
        ${p.supportNote ? `<div class="muted small">Structure: ${p.supportNote}</div>` : ''}
        <div class="muted small">${pr.note || ''}</div>
        <button type="button" class="ghost-btn small br-open" data-symbol="${p.symbol}" style="margin-top:10px;">Full analysis</button>
      </div>`;
    }).join('');
    board.querySelectorAll('.br-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.symbol;
        if (sym && typeof loadSymbol === 'function') loadSymbol(sym, { fromView: 'early-opportunity' });
      });
    });
  } catch (err) {
    if (meta) meta.textContent = err.message;
    board.innerHTML = `<div class="muted">${err.message}</div>`;
  }
}

document.getElementById('brScanBtn')?.addEventListener('click', () => loadBestReversalPicks(false));
document.querySelectorAll('.tab-btn[data-view="best-reversal"]').forEach((btn) => {
  btn.addEventListener('click', () => setTimeout(() => loadBestReversalPicks(false), 40));
});



/* ========== Early Opportunity Hub (one nav, 3 internal panels) ========== */
let _eoHubTab = 'best-reversal';

function switchEoHubTab(tab) {
  _eoHubTab = tab || 'best-reversal';
  document.querySelectorAll('#eoHubSubTabs .eo-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.eoHub === _eoHubTab);
  });
  document.querySelectorAll('.eo-hub-panel').forEach((p) => { p.style.display = 'none'; });
  const panel = document.getElementById('eoPanel-' + _eoHubTab);
  if (panel) panel.style.display = 'block';
  const meta = document.getElementById('eoHubMeta');
  if (meta) meta.textContent = '';
  if (_eoHubTab === 'best-reversal') loadBestReversalPicks(false);
  else if (_eoHubTab === 'crash-recovery') loadCrashRecovery(false);
  else if (_eoHubTab === 'scanners') loadEarlyOpportunity(false);
}

function loadEoHub() {
  switchEoHubTab(_eoHubTab || 'best-reversal');
}

document.getElementById('eoHubRefreshBtn')?.addEventListener('click', () => {
  if (_eoHubTab === 'best-reversal') loadBestReversalPicks(true);
  else if (_eoHubTab === 'crash-recovery') loadCrashRecovery(true);
  else loadEarlyOpportunity(true);
});
document.getElementById('eoHubSubTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-eo-hub]');
  if (!btn) return;
  switchEoHubTab(btn.dataset.eoHub);
});
document.querySelectorAll('.tab-btn[data-view="early-opportunity"]').forEach((btn) => {
  btn.addEventListener('click', () => setTimeout(() => loadEoHub(), 40));
});

// ===== Week Runner v4 — clean layout: hero + diagrams + proof =====
const _e = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const _n = (v, suf = '') => (v == null || Number.isNaN(v) ? '–' : v + suf);
const _sg = (v, suf = '%') => (v == null ? '–' : (v > 0 ? '+' : '') + v + suf);
const _cl = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
let _wrPoll = null;

function _wrMeter(tier) {
  const on = (t, c) => `<span class="${tier === t ? 'on ' + c : ''}">${{ PROVEN: 'PAKKA', LEAN: 'HALKA SANKET', UNPROVEN: 'BINA SABOOT' }[t]}</span>`;
  return `<div class="wr-meter" title="Is tareeke ka past test me kitna bharosa">${on('PROVEN', 'p')}${on('LEAN', 'l')}${on('UNPROVEN', 'u')}</div>`;
}

function _wrLadder(h) {
  const stop = h.stopPrice, t3 = h.targets.t3, lo = stop, hi = t3; const pos = (x) => Math.max(2, Math.min(98, ((x - lo) / (hi - lo)) * 100));
  const pts = [['Stop', stop, 'dn', 'var(--bad)'], ['Entry ~' + h.price, h.price, 'up', '#fff'], [`+${h.exit.t1}%`, h.targets.t1, 'dn', 'var(--ok)'], [`+${h.exit.t3}%`, t3, 'up', 'var(--ok)']];
  return `<div class="wr-ladder"><div class="ln"></div>${pts.map(([l, v, side, col]) => `<div class="mk" style="left:${pos(v)}%;background:${col}"></div><div class="lb ${side}" style="left:${pos(v)}%;color:${col}">${_e(l)}<br><b>₹${v}</b></div>`).join('')}</div>`;
}

function _wrHero(d) {
  const h = d.hero;
  if (!h) {
    return `<div class="wr-hero t-none"><div class="wr-kicker">🎯 AAJ KA BEST STOCK</div><div class="wr-sym">Aaj koi nahi</div>
      <div class="wr-verdict">${_e(d.verdictText)}</div>
      <div class="wr-grid">${d.checks.map((c) => `<div class="wr-box"><span class="wr-chip ${c.ok ? 'ok' : c.warn ? 'warn' : 'bad'}">${c.ok ? '✓' : c.warn ? '!' : '✕'} ${_e(c.title)}</span><div class="wr-small" style="margin-top:6px;">${_e(c.text)}</div></div>`).join('')}</div>
      <div class="wr-small wr-muted" style="margin-top:12px;">Ye bhi ek sahi jawab hai. Jis din kuch achha nahi, us din paisa na lagana hi paise bachana hai.</div></div>`;
  }
  const ex = h.expect; const sz = h.size; const missed = h.liveStatus === 'MISSED' || h.liveStatus === 'INVALID';
  const livechip = h.live ? `<span class="wr-chip ${h.liveStatus === 'OK' ? 'ok' : 'bad'}">Live ₹${h.live.price} (${_sg(h.live.vsSignalPct)}) ${h.liveStatus === 'OK' ? '· abhi bhi lene layak' : '· ' + _e(h.liveStatus)}</span>` : '';
  const ran = `<span class="wr-chip ok">Abhi tak bhaaga nahi</span> <span class="wr-chip">aaj ${_sg(h.d1)}</span> <span class="wr-chip">5 din ${_sg(h.d5)}</span> <span class="wr-chip">20 din ${_sg(h.d20)}</span>`;
  const rec = ex ? `<div class="wr-kv"><span>Is tareeke ka test record</span><b>${ex.n} trades</b></div>
      <div class="wr-kv"><span>Avg har trade me</span><b class="${_cl(ex.expectancy)}">${_sg(ex.expectancy)}</b></div>
      <div class="wr-kv"><span>₹10,000 lagao to avg</span><b class="${_cl(ex.rupeePer10k)}">${ex.rupeePer10k >= 0 ? '+' : '−'}₹${Math.abs(ex.rupeePer10k)}</b></div>
      <div class="wr-kv"><span>Pehla target touch / Stop laga</span><b>${_n(ex.t1Rate, '%')} / ${_n(ex.stopRate, '%')}</b></div>` : '';
  const money = sz ? (sz.qty ? `<div class="wr-kv"><span>Kitne shares</span><b>${sz.qty}</b></div><div class="wr-kv"><span>Lagega</span><b>${_inr(sz.capitalUsed)} (${sz.pctOfCapital}%)</b></div><div class="wr-kv"><span>Stop lagne pe loss</span><b class="neg">${_inr(sz.maxLossIfStopHits)}</b></div><div class="wr-kv"><span>Gap me worst-case</span><b>~${_inr(sz.gapWorstCaseRs)}</b></div>` : `<div class="wr-small">${_e(sz.note)}</div>`) : (h.tier === 'PAPER' ? '<div class="wr-small">Paper trade: sirf note karo, paisa nahi.</div>' : '<div class="wr-small wr-muted">Capital daalo to quantity milegi.</div>');
  return `<div class="wr-hero t-${h.tier}">
    <div class="wr-head"><div><div class="wr-kicker">🎯 AAJ KA BEST STOCK</div>
      <div class="wr-sym">${_e(h.symbol)}<small>₹${h.price}</small></div>
      <div style="margin-top:4px;"><span class="wr-chip">🏭 ${_e(h.sector || 'Sector ?')}</span> <span class="wr-chip">${_e(h.label || h.setupLabel || '')}</span> ${livechip}</div></div>
      <div><div class="wr-small wr-muted" style="margin-bottom:4px;">Bharosa:</div>${_wrMeter(h.tier)}<div class="wr-small" style="margin-top:4px;color:var(--c)">${_e(h.tierLabel)}</div></div></div>
    <div class="wr-verdict">${_e(d.verdictText)}</div>
    <div style="margin-bottom:12px;">${ran}</div>
    <div class="wr-grid">
      <div class="wr-box"><h4>Kyu ye stock?</h4><ul>${h.why.map((w) => `<li>${_e(w)}</li>`).join('')}</ul></div>
      <div class="wr-box"><h4>Kab, kahan se, kahan tak</h4>${missed ? '<div class="wr-small neg">Ye stock pehle hi bhaag gaya / stop ke neeche — aaj chhodo.</div>' : _wrLadder(h)}
        <div class="wr-kv"><span>Kharidne ka din</span><b>${_e(h.action?.buyDate || d.session.actionLabel)}</b></div>
        <div class="wr-kv"><span>Open is se upar ho to SKIP</span><b>₹${h.skipIfOpenAbove}</b></div>
        <div class="wr-kv"><span>Max kitne din</span><b>${h.exit.hold} din (${_e(h.action?.exitByDate || '')})</b></div></div>
      <div class="wr-box"><h4>Paisa & saboot</h4>${money}${rec}</div>
    </div>
    ${(h.cons && h.cons.length) || (h.notes && h.notes.length) ? `<div class="wr-cons"><b>⚠️ Dhyan rakho</b>${[...(h.cons || []), ...(h.notes || [])].map((c) => `<div>• ${_e(c)}</div>`).join('')}</div>` : ''}
    ${h.action && !missed ? `<details class="wr-d" open><summary>📋 Step-by-step kya karna hai</summary><ol class="wr-steps">${h.action.steps.map((x) => `<li>${_e(x)}</li>`).join('')}</ol></details>` : ''}
  </div>`;
}

function _wrFunnel(d) {
  const f = d.rank.funnel; const top = Math.max(1, f[0].n);
  return `<div class="wr-card"><b>🔻 Aaj ka funnel — 1 stock kaise bacha</b><div class="wr-small wr-muted" style="margin-bottom:6px;">Har step pe kamzor stocks hat te gaye.</div>
    ${f.map((r) => `<div class="wr-row"><span>${_e(r.label)}</span><div class="wr-bar"><i style="width:${Math.max(3, (r.n / top) * 100)}%"></i></div><span class="wr-num">${r.n}</span></div>`).join('')}</div>`;
}

function _wrSectors(d) {
  const S = d.rank.sectors; if (!d.rank.sectorsAvailable || !S.length) return `<div class="wr-card"><b>🏭 Sector strength</b><div class="wr-small wr-muted" style="margin-top:6px;">Sector data nahi mila. Admin tab me "sector sync" chalao, tab sector-strength bhi ranking me judega.</div></div>`;
  const mx = Math.max(5, ...S.map((s) => Math.abs(s.rs20 || 0)));
  return `<div class="wr-card"><b>🏭 Kaun sa sector aaj strong hai</b><div class="wr-small wr-muted" style="margin-bottom:6px;">Bar = pichle 20 din me Nifty se kitna aage (+) ya peeche (−). Number = SMA50 ke upar stocks %.</div>
    ${S.slice(0, 8).map((s) => { const w = Math.min(50, (Math.abs(s.rs20 || 0) / mx) * 50); const left = s.rs20 >= 0 ? 50 : 50 - w; return `<div class="wr-row"><span>${d.hero && d.hero.sector === s.sector ? '⭐ ' : ''}${_e(s.sector)} <span class="wr-muted">(${s.n})</span></span><div class="wr-bar div"><i class="${s.rs20 >= 0 ? 'pos' : 'neg'}" style="left:${left}%;width:${w}%"></i></div><span class="wr-num ${_cl(s.rs20)}">${_sg(s.rs20, '')}<br><span class="wr-muted wr-small">${s.breadth}%</span></span></div>`; }).join('')}</div>`;
}

function _wrBackups(d) {
  if (!d.backups.length) return '';
  return `<div class="wr-sec">Aur achhe stocks (backup)</div>` + d.backups.map((b) => `<details class="wr-d"><summary>#${b.rank} ${_e(b.symbol)} · ${_e(b.sector)} · score ${b.scorePct}/100 · stop ₹${b.stopPrice} · target ₹${b.targets.t1}</summary>
    <div class="wr-small" style="margin-top:8px;"><b>Kyu:</b><ul>${b.why.map((w) => `<li>${_e(w)}</li>`).join('')}</ul>${b.cons.length ? `<div class="neg">⚠️ ${b.cons.map(_e).join(' · ')}</div>` : ''}${b.liveStatus === 'MISSED' ? '<div class="neg">⛔ MISSED — pehle hi bhaag gaya</div>' : ''}</div></details>`).join('');
}

function _wrLate(d) {
  const L = d.rank.late; if (!L.length) return '';
  return `<div class="wr-sec">Bhaag chuke — CHASE MAT KARO</div><div class="wr-card wr-scroll"><div class="wr-small wr-muted" style="margin-bottom:6px;">Ye strong dikhte hain, par pehle hi chal chuke — ab lena late hai (yahi aapki purani problem thi).</div>
    <table class="wr-t"><tr><th>Stock</th><th>Bhav</th><th>Aaj</th><th>5 din</th><th>20 din</th><th>Kyu nahi</th></tr>${L.map((x) => `<tr><td><b>${_e(x.symbol)}</b></td><td>₹${x.price}</td><td class="${_cl(x.d1)}">${_sg(x.d1)}</td><td class="${_cl(x.d5)}">${_sg(x.d5)}</td><td class="${_cl(x.d20)}">${_sg(x.d20)}</td><td class="wr-muted">${_e(x.why)}</td></tr>`).join('')}</table></div>`;
}

function _wrProof(d) {
  const L = d.rank.lab, t = L.test, sel = L.selected; const tierChip = { PROVEN: 'ok', LEAN: 'warn', UNPROVEN: 'bad' }[L.tier];
  const bars = [['Roz ka #1', t.expectancy], ['Top-3 stocks', L.test3.expectancy], ['Random stock (compare)', L.baseline.expectancy]]; const mx = Math.max(1, ...bars.map((b) => Math.abs(b[1] || 0)));
  const bar = bars.map(([l, v]) => { const w = Math.min(50, (Math.abs(v || 0) / mx) * 50); const left = (v || 0) >= 0 ? 50 : 50 - w; return `<div class="wr-row"><span>${l}</span><div class="wr-bar div"><i class="${(v || 0) >= 0 ? 'pos' : 'neg'}" style="left:${left}%;width:${w}%"></i></div><span class="wr-num ${_cl(v)}">${_sg(v)}</span></div>`; }).join('');
  const setups = Object.values(d.setupLab).map((l) => `<tr><td><b>${_e(l.label)}</b></td><td><span class="wr-chip ${l.licensed ? 'ok' : 'bad'}">${l.licensed ? 'PASS' : 'FAIL'}</span></td><td class="${_cl(l.outOfSample.expectancy)}">${_sg(l.outOfSample.expectancy)}</td><td>${l.outOfSample.n || 0}</td></tr>`).join('');
  const vars = L.perVariant.map((v) => `<tr><td>${_e(v.variant)}</td><td class="${_cl(v.trainExp)}">${_sg(v.trainExp)} (n${v.trainN})</td><td class="${_cl(v.testExp)}">${_sg(v.testExp)} (n${v.testN})</td></tr>`).join('');
  return `<div class="wr-sec">Saboot — ye system kitna bharosemand hai?</div>
  <details class="wr-d"><summary>🔬 Roz ka #1 tareeka — test ka result <span class="wr-chip ${tierChip}" style="margin-left:6px">${L.tier}</span></summary>
    <div class="wr-small" style="margin-top:10px;">
      <div><b>Tareeka:</b> ${_e(sel.label)} · ${_e(sel.thrLabel)} · ${_e(sel.exit.label)} · stop ${sel.stopMult}×ATR · mausam: ${_e(sel.allowedRegimes.join('/') || '–')}</div>
      <div class="wr-muted" style="margin:4px 0 8px;">Ye 108 mixes me se <b>sirf purane 60% data</b> se chuna gaya, phir <b>${_e(L.testFrom)} ke baad</b> ke untouched data pe parkha gaya. Sab costs aur gap ke baad.</div>
      <div class="wr-grid"><div><b>Test me kya hua (${t.n || 0} trades)</b>${bar}<div class="wr-muted">Bar = avg % per trade. Random stock se compare karne par ranking ${L.liftPct == null ? '–' : (L.liftPct >= 0 ? L.liftPct + '% behtar' : Math.abs(L.liftPct) + '% kharab')} rahi.</div></div>
      <div><div class="wr-kv"><span>₹10,000 lagao to avg</span><b class="${_cl(t.expectancy)}">${t.expectancy == null ? '–' : (t.expectancy >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(t.expectancy * 100))}</b></div>
        <div class="wr-kv"><span>Pehla target touch</span><b>${_n(t.t1Rate, '%')}</b></div><div class="wr-kv"><span>Stop laga</span><b>${_n(t.stopRate, '%')}</b></div>
        <div class="wr-kv"><span>Profit factor</span><b>${_n(t.profitFactor)}</b></div><div class="wr-kv"><span>Lagatar haar (max)</span><b>${_n(t.maxLoseStreak)}</b></div>
        <div class="wr-kv"><span>Test ke 2 aadhe hisse</span><b>${_sg(L.halves[0])} / ${_sg(L.halves[1])}</b></div></div></div>
      ${L.reasons.length ? `<div class="neg" style="margin-top:8px;">Kyu "PAKKA" nahi: ${_e(L.reasons.join(' · '))}</div>` : ''}
      <table class="wr-t" style="margin-top:10px;"><tr><th>4 tareeke</th><th>Train avg</th><th>Test avg</th></tr>${vars}</table></div></details>
  <details class="wr-d"><summary>📐 5 "chart-shape" setups — test result</summary><div class="wr-small wr-scroll" style="margin-top:8px;"><table class="wr-t"><tr><th>Setup</th><th>Result</th><th>Test avg/trade</th><th>Trades</th></tr>${setups}</table><div class="wr-muted" style="margin-top:6px;">PASS = test me paisa banaya aur pakka bhi tha. FAIL = nahi. Ye wahi purane pass/fail setups hain.</div></div></details>`;
}

function _wrMarketForward(d) {
  const fa = d.regime.facts; const f = d.forward;
  const rc = { GREEN: 'ok', AMBER: 'warn', BEAR: 'warn', CRASH: 'bad', UNKNOWN: '' }[d.regime.state];
  return `<div class="wr-sec">Market aur live record</div><div class="wr-grid">
    <div class="wr-card"><b>🌡️ Market</b> <span class="wr-chip ${rc}">${d.regime.state}</span><div class="wr-small" style="margin:6px 0;">${_e(d.regimePlain)}</div>
      ${fa ? `<div class="wr-kv"><span>Nifty</span><b>${fa.nifty}</b></div><div class="wr-kv"><span>SMA50</span><b>${fa.sma50} ${fa.nifty >= fa.sma50 ? '✅ upar' : '❌ neeche'}</b></div><div class="wr-kv"><span>SMA200</span><b>${fa.sma200} ${fa.nifty >= fa.sma200 ? '✅ upar' : '❌ neeche'}</b></div><div class="wr-kv"><span>1D / 5D / 20D</span><b>${_sg(fa.d1)} / ${_sg(fa.d5)} / ${_sg(fa.d20)}</b></div><div class="wr-kv"><span>VIX</span><b>${fa.vix ?? '–'}</b></div>` : ''}
      <ul class="wr-small" style="margin:6px 0 0 16px;">${d.regime.reasons.map((r) => `<li>${_e(r)}</li>`).join('')}</ul></div>
    <div class="wr-card"><b>🧪 Forward test (live record)</b>${f.pause ? `<div class="neg wr-small"><b>⛔ GUARD ON:</b> ${_e(f.pauseReason)}</div>` : ''}
      <div class="wr-kv"><span>Roz ke #1 picks (closed)</span><b>${f.best.n} · avg ${_n(f.best.avgNet, '%')}</b></div>
      <div class="wr-kv"><span>Pakka/halka picks</span><b>${f.picks.n} · win ${_n(f.picks.winRate, '%')}</b></div>
      <div class="wr-kv"><span>Backup (paper)</span><b>${f.paperOnly.n} · avg ${_n(f.paperOnly.avgNet, '%')}</b></div><div class="wr-kv"><span>Abhi open</span><b>${f.open}</b></div>
      <div class="wr-small wr-muted" style="margin-top:6px;">${_e(f.note || 'Ye system apne diye har #1 ko baad me khud grade karta hai.')}</div></div></div>`;
}

async function loadWeekRunner(force) {
  const out = document.getElementById('wrOut'); if (!out) return;
  const cap = Number(document.getElementById('wrCapital')?.value) || 0;
  const risk = Number(document.getElementById('wrRisk')?.value) || 0.75;
  try { localStorage.setItem('wrCap', cap); localStorage.setItem('wrRisk', risk); } catch (_) {}
  out.innerHTML = '<div class="wr-card wr-muted" id="wrProg">Scan chal raha hai…</div>';
  clearInterval(_wrPoll);
  _wrPoll = setInterval(async () => {
    try { const s = await api('/week-runner/status'); const el = document.getElementById('wrProg'); if (!el) return clearInterval(_wrPoll);
      el.textContent = s.progress.phase === 'data' ? `Data le raha hu… ${s.progress.done}/${s.progress.total}` : s.progress.phase === 'analysis' ? 'Ranking + Lab chal raha hai (30–60 sec)…' : 'Final checks (result date, live price)…'; } catch (_) {}
  }, 1500);
  try {
    const d = await api(`/week-runner/scan?capital=${cap}&risk=${risk}${force ? '&force=1' : ''}`);
    clearInterval(_wrPoll);
    let h = '';
    h += `<div class="wr-card" style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;"><b>📅 ${_e(d.session.actionLabel)}</b>${d.session.lines.map((x) => `<span class="wr-small wr-muted">${_e(x)}</span>`).join('')}${d.session.warnings.map((x) => `<span class="wr-small" style="color:var(--warn)">⚠️ ${_e(x)}</span>`).join('')}</div>`;
    h += _wrHero(d);
    if (d.rank.sectorsAvailable === false) h += '<div class="wr-card wr-small" style="color:var(--warn)">⚠️ Sector data nahi mila — ranking me sector-strength factor neutral raha.</div>';
    h += `<div class="wr-sec">Diagram — kaise chuna gaya</div><div class="wr-grid">${_wrFunnel(d)}${_wrSectors(d)}</div>`;
    h += _wrBackups(d) + _wrLate(d) + _wrMarketForward(d) + _wrProof(d);
    h += `<details class="wr-d" style="margin-top:16px;"><summary class="wr-small">Caveats</summary><ul class="wr-small">${d.caveats.map((c) => `<li>${_e(c)}</li>`).join('')}</ul></details>`;
    out.innerHTML = h;
  } catch (e) { clearInterval(_wrPoll); out.innerHTML = '<div class="wr-card neg">Error: ' + _e(e.message || e) + '</div>'; }
}
document.getElementById('wrScanBtn')?.addEventListener('click', () => loadWeekRunner(true));
try { const c = localStorage.getItem('wrCap'), r = localStorage.getItem('wrRisk'); if (c && document.getElementById('wrCapital')) document.getElementById('wrCapital').value = c; if (r && document.getElementById('wrRisk')) document.getElementById('wrRisk').value = r; } catch (_) {}
