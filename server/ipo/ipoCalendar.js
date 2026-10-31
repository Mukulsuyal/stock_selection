// NSE public IPO calendar (no key). Session + browser headers required.
const axios = require('axios');

const NSE_HOME = 'https://www.nseindia.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo',
};

let cookieCache = { cookie: '', fetchedAt: 0 };
const COOKIE_TTL = 10 * 60 * 1000;

async function nseGet(path) {
  if (!cookieCache.cookie || Date.now() - cookieCache.fetchedAt > COOKIE_TTL) {
    const home = await axios.get(NSE_HOME, {
      headers: HEADERS,
      timeout: 15000,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    const set = home.headers['set-cookie'] || [];
    cookieCache = {
      cookie: set.map((c) => c.split(';')[0]).join('; '),
      fetchedAt: Date.now(),
    };
  }
  const res = await axios.get(`${NSE_HOME}${path}`, {
    headers: { ...HEADERS, Cookie: cookieCache.cookie },
    timeout: 25000,
    validateStatus: (s) => s < 500,
  });
  if (res.status === 401 || res.status === 403) {
    cookieCache = { cookie: '', fetchedAt: 0 };
    throw new Error(`NSE blocked IPO calendar request (${res.status})`);
  }
  return res.data;
}

function parseIssuePrice(row) {
  // Prefer fixed issuePrice number; else upper band of "Rs.X to Rs.Y"
  const raw = String(row.issuePrice || '').trim();
  if (raw && raw !== '-' && !/^rs/i.test(raw)) {
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const range = String(row.priceRange || row.issuePrice || '');
  const nums = [...range.matchAll(/([\d,.]+)/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0);
  if (nums.length) return Math.max(...nums); // upper band for listing-day analysis
  return null;
}

function parseNseDate(str) {
  if (!str || str === '-') return null;
  // 23-SEP-2026 or 23-Sep-2026
  const m = String(str).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const mon = months[m[2].toUpperCase()];
  if (mon == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ymdInIST(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function addCalendarDaysIST(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isWeekendYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Next trading calendar day (skips Sat/Sun only; holiday list optional later). */
function nextTradingDay(fromYmd) {
  let y = addCalendarDaysIST(fromYmd, 1);
  for (let i = 0; i < 7; i++) {
    if (!isWeekendYmd(y)) return y;
    y = addCalendarDaysIST(y, 1);
  }
  return y;
}

function normalizePastRow(row) {
  const symbol = String(row.symbol || '').toUpperCase().trim();
  if (!symbol) return null;
  const listingDate = parseNseDate(row.listingDate);
  const issuePrice = parseIssuePrice(row);
  return {
    symbol,
    companyName: row.company || row.companyName || null,
    listingDate,
    issuePrice,
    priceRange: row.priceRange || null,
    securityType: row.securityType || row.series || null,
    ipoStartDate: parseNseDate(row.ipoStartDate),
    ipoEndDate: parseNseDate(row.ipoEndDate),
    source: 'nse_past',
    status: 'listed',
  };
}

function normalizeActiveRow(row) {
  const symbol = String(row.symbol || '').toUpperCase().trim();
  if (!symbol) return null;
  const issuePrice = parseIssuePrice(row);
  return {
    symbol,
    companyName: row.companyName || row.company || null,
    listingDate: null,
    issuePrice,
    priceRange: row.issuePrice || row.priceRange || null,
    securityType: row.series || row.securityType || null,
    ipoStartDate: parseNseDate(row.issueStartDate || row.ipoStartDate),
    ipoEndDate: parseNseDate(row.issueEndDate || row.ipoEndDate),
    subscriptionTimes: row.noOfTime != null ? Number(row.noOfTime) : null,
    source: 'nse_active',
    status: String(row.status || 'Active').toLowerCase() === 'active' ? 'open' : 'upcoming',
  };
}

/**
 * Today listed + next trading day listings + currently open issues.
 * Weekends skipped for "tomorrow".
 */
async function fetchIpoCalendarBoard() {
  const today = ymdInIST();
  const tomorrow = nextTradingDay(today);

  let past = [];
  let active = [];
  let upcoming = [];
  const errors = [];

  try {
    const rawPast = await nseGet('/api/public-past-issues');
    if (Array.isArray(rawPast)) past = rawPast.map(normalizePastRow).filter(Boolean);
  } catch (err) {
    errors.push(`past: ${err.message}`);
  }
  try {
    const rawActive = await nseGet('/api/ipo-current-issue');
    if (Array.isArray(rawActive)) active = rawActive.map(normalizeActiveRow).filter(Boolean);
  } catch (err) {
    errors.push(`active: ${err.message}`);
  }
  try {
    const rawUp = await nseGet('/api/all-upcoming-issues?category=ipo');
    if (Array.isArray(rawUp)) upcoming = rawUp.map(normalizeActiveRow).filter(Boolean);
  } catch (err) {
    errors.push(`upcoming: ${err.message}`);
  }

  const listedToday = past.filter((p) => p.listingDate === today);
  const listedTomorrow = past.filter((p) => p.listingDate === tomorrow);
  // Also catch "upcoming listing" if listingDate was populated on past feed for future
  const listedNextFew = past.filter((p) => {
    if (!p.listingDate) return false;
    return p.listingDate > today && p.listingDate <= addCalendarDaysIST(today, 5) && !isWeekendYmd(p.listingDate);
  });
  // Last ~45 calendar days (≈1–1.5 months) of already-listed IPOs (includes today)
  const from15 = addCalendarDaysIST(today, -45);
  const listedLast30Days = past
    .filter((p) => p.listingDate && p.listingDate >= from15 && p.listingDate <= today)
    .sort((a, b) => (b.listingDate || '').localeCompare(a.listingDate || '') || a.symbol.localeCompare(b.symbol));

  // Dedupe open book by symbol
  const openMap = new Map();
  for (const r of [...active, ...upcoming]) {
    if (!openMap.has(r.symbol)) openMap.set(r.symbol, r);
  }

  return {
    asOf: new Date().toISOString(),
    today,
    nextTradingDay: tomorrow,
    listedToday,
    listedTomorrow: listedTomorrow.length ? listedTomorrow : listedNextFew.filter((p) => p.listingDate === tomorrow),
    listedSoon: listedNextFew,
    listedLast30Days,
    openForSubscription: [...openMap.values()],
    errors,
    note: 'NSE public calendar. Listing-day analysis uses upper issue band when fixed price is missing. Weekends skipped for next trading day.',
  };
}

module.exports = {
  fetchIpoCalendarBoard,
  parseIssuePrice,
  ymdInIST,
  nextTradingDay,
};
