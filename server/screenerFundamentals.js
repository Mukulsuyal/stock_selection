// Free Indian fundamentals via Screener.in public company pages (no API key).
// Fallback when Yahoo quoteSummary fails or returns empty ratios.
const axios = require('axios');

const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/,/g, '').replace(/%/g, '').replace(/₹/g, '').replace(/\s/g, '');
  if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return null;
  // strip trailing + used in expandable rows
  s = s.replace(/\+$/, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTopRatios(html) {
  const map = {};
  const re = /<span class="name">\s*([^<]+?)\s*<\/span>[\s\S]{0,220}?<span class="number">\s*([^<]+?)\s*<\/span>/gi;
  let m;
  while ((m = re.exec(html))) {
    map[m[1].trim()] = m[2].trim();
  }
  // High / Low often split across two numbers
  const hl = html.match(/High\s*\/\s*Low[\s\S]{0,200}?<span class="number">\s*([^<]+?)\s*<\/span>\s*\/\s*<span class="number">\s*([^<]+?)\s*<\/span>/i);
  if (hl) {
    map['52w High'] = hl[1].trim();
    map['52w Low'] = hl[2].trim();
  }
  return map;
}


function extractQuarterHeaders(html) {
  const m = html.match(/id="quarters"[\s\S]*?<table[\s\S]*?<\/thead>/i);
  if (!m) return [];
  const head = m[0];
  const keys = [];
  const re = /<th[^>]*data-date-key="([^"]+)"[^>]*>([\s\S]*?)<\/th>/gi;
  let x;
  while ((x = re.exec(head))) {
    const key = x[1]; // 2024-06-30
    const label = stripTags(x[2]) || key;
    keys.push({ key, label });
  }
  if (keys.length) return keys;
  // fallback: plain th text
  const ths = head.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || [];
  return ths.slice(1).map((th) => {
    const label = stripTags(th);
    return { key: null, label: label || null };
  });
}

function extractTableById(html, id) {
  const re = new RegExp(`id="${id}"[\\s\\S]*?<table[\\s\\S]*?<\\/table>`, 'i');
  const m = html.match(re);
  if (!m) return [];
  const rows = m[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rows.map((row) => {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    return cells.map((c) => stripTags(c));
  }).filter((r) => r.length && r[0]);
}

function lastNumeric(row) {
  for (let i = row.length - 1; i >= 1; i--) {
    const n = parseNumber(row[i]);
    if (n != null) return n;
  }
  return null;
}

function growthFromSeries(row) {
  // last two numeric years
  const nums = [];
  for (let i = 1; i < row.length; i++) {
    const n = parseNumber(row[i]);
    if (n != null) nums.push(n);
  }
  if (nums.length < 2) return null;
  const a = nums[nums.length - 2];
  const b = nums[nums.length - 1];
  if (a === 0) return null;
  return (b - a) / Math.abs(a);
}

async function getScreenerFundamentals(symbol) {
  const sym = String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  if (!sym) return null;
  const cached = cache.get(sym);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const url = `https://www.screener.in/company/${encodeURIComponent(sym)}/`;
  const res = await axios.get(url, {
    headers: HEADERS,
    timeout: 8000,
    maxContentLength: 5 * 1024 * 1024,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const html = res.data;
  if (typeof html !== 'string' || html.length < 1000) {
    throw new Error('Screener page empty');
  }
  if (/could not find|page not found/i.test(html) && !/Stock P\/E/i.test(html)) {
    throw new Error('Screener company not found');
  }

  const ratios = extractTopRatios(html);
  const pe = parseNumber(ratios['Stock P/E']);
  const bookValue = parseNumber(ratios['Book Value']);
  const price = parseNumber(ratios['Current Price']);
  const rocePct = parseNumber(ratios['ROCE']);
  const roePct = parseNumber(ratios['ROE']);
  const divYield = parseNumber(ratios['Dividend Yield']);
  const mcapCr = parseNumber(ratios['Market Cap']);
  const high52 = parseNumber(ratios['52w High']);
  const low52 = parseNumber(ratios['52w Low']);

  const sectorMatch = html.match(/title="Sector">([^<]+)<\/a>/i);
  const industryMatch = html.match(/title="Industry">([^<]+)<\/a>/i);
  const sector = sectorMatch ? stripTags(sectorMatch[1]) : null;
  const industry = industryMatch ? stripTags(industryMatch[1]) : null;

  // Annual P&L → sales/profit growth, OPM, EPS
  const pl = extractTableById(html, 'profit-loss');
  let revenueGrowth = null;
  let earningsGrowth = null;
  let profitMargin = null;
  let eps = null;
  let salesLast = null;
  let profitLast = null;
  for (const row of pl) {
    const label = (row[0] || '').replace(/\+$/, '').trim();
    if (/^Sales$/i.test(label)) {
      revenueGrowth = growthFromSeries(row);
      salesLast = lastNumeric(row);
    } else if (/^Net Profit$/i.test(label)) {
      earningsGrowth = growthFromSeries(row);
      profitLast = lastNumeric(row);
    } else if (/^OPM/i.test(label)) {
      const opm = lastNumeric(row);
      if (opm != null) profitMargin = opm / 100;
    } else if (/^EPS/i.test(label)) {
      eps = lastNumeric(row);
    }
  }
  if (salesLast && profitLast && salesLast !== 0 && profitMargin == null) {
    profitMargin = profitLast / salesLast;
  }

  // Quarterly Results → QoQ / same-quarter YoY + history for UI
  const qTable = extractTableById(html, 'quarters');
  let revenueQoQ = null;
  let profitQoQ = null;
  let revenueYoY = null; // same quarter last year (4 steps back)
  let profitYoY = null;
  let quarterly = [];
  let qSales = null;
  let qProfit = null;
  let qOpm = null;
  const qHeaders = extractQuarterHeaders(html);
  const qDates = qHeaders.map((h) => h.key || h.label || null);
  const qLabels = qHeaders.map((h) => h.label || h.key || null);
  for (const row of qTable) {
    const label = (row[0] || '').replace(/\+$/, '').replace(/\u00a0/g, ' ').trim();
    if (/^Sales$/i.test(label)) qSales = row;
    if (/^Net Profit$/i.test(label)) qProfit = row;
    if (/^OPM/i.test(label)) qOpm = row;
  }
  function seriesNums(row) {
    if (!row) return [];
    const out = [];
    for (let i = 1; i < row.length; i++) {
      const n = parseNumber(row[i]);
      out.push(n);
    }
    return out;
  }
  const salesNums = seriesNums(qSales);
  const profitNums = seriesNums(qProfit);
  if (salesNums.length >= 2) {
    const a = salesNums[salesNums.length - 2];
    const b = salesNums[salesNums.length - 1];
    if (a != null && b != null && a !== 0) revenueQoQ = (b - a) / Math.abs(a);
  }
  if (profitNums.length >= 2) {
    const a = profitNums[profitNums.length - 2];
    const b = profitNums[profitNums.length - 1];
    if (a != null && b != null && a !== 0) profitQoQ = (b - a) / Math.abs(a);
  }
  if (salesNums.length >= 5) {
    const b = salesNums[salesNums.length - 1];
    const y = salesNums[salesNums.length - 5];
    if (b != null && y != null && y !== 0) revenueYoY = (b - y) / Math.abs(y);
  }
  if (profitNums.length >= 5) {
    const b = profitNums[profitNums.length - 1];
    const y = profitNums[profitNums.length - 5];
    if (b != null && y != null && y !== 0) profitYoY = (b - y) / Math.abs(y);
  }
  const opmNums = seriesNums(qOpm);
  const nQ = Math.max(salesNums.length, profitNums.length, opmNums.length, qDates.length);
  for (let i = 0; i < nQ; i++) {
    const rev = salesNums[i] != null ? salesNums[i] : null;
    const prof = profitNums[i] != null ? profitNums[i] : null;
    const opm = opmNums[i] != null ? opmNums[i] : null;
    const prevRev = i > 0 ? salesNums[i - 1] : null;
    const prevProf = i > 0 ? profitNums[i - 1] : null;
    const prevOpm = i > 0 ? opmNums[i - 1] : null;
    let revQoQ = null;
    let profQoQ = null;
    let opmChg = null;
    if (rev != null && prevRev != null && prevRev !== 0) revQoQ = (rev - prevRev) / Math.abs(prevRev);
    if (prof != null && prevProf != null && prevProf !== 0) profQoQ = (prof - prevProf) / Math.abs(prevProf);
    if (opm != null && prevOpm != null) opmChg = opm - prevOpm; // percentage points
    quarterly.push({
      endDate: qDates[i] || null,
      label: qLabels[i] || qDates[i] || null,
      totalRevenue: rev != null ? rev * 1e7 : null, // Cr → INR
      netIncome: prof != null ? prof * 1e7 : null,
      revenueCr: rev,
      profitCr: prof,
      opmPct: opm,
      revenueQoQ: revQoQ,
      profitQoQ: profQoQ,
      opmChangePts: opmChg,
      grossProfit: null,
      operatingIncome: null,
      ebit: null,
    });
  }
  quarterly = quarterly
    .filter((q) => q.totalRevenue != null || q.netIncome != null)
    .reverse()
    .slice(0, 10);

  // Balance sheet → debt / equity
  const bs = extractTableById(html, 'balance-sheet');
  let equity = null;
  let borrowings = null;
  for (const row of bs) {
    const label = (row[0] || '').replace(/\+$/, '').trim();
    if (/^Equity Capital$/i.test(label)) {
      const ec = lastNumeric(row);
      equity = (equity || 0) + (ec || 0);
    } else if (/^Reserves$/i.test(label)) {
      const r = lastNumeric(row);
      equity = (equity || 0) + (r || 0);
    } else if (/^Borrowings$/i.test(label)) {
      borrowings = lastNumeric(row);
    }
  }
  let debtToEquity = null;
  if (equity != null && equity !== 0 && borrowings != null) {
    debtToEquity = Number((borrowings / equity).toFixed(3));
  }

  const roe = roePct != null ? roePct / 100 : null;
  const roce = rocePct != null ? rocePct / 100 : null;
  const priceToBook =
    price != null && bookValue != null && bookValue !== 0
      ? Number((price / bookValue).toFixed(2))
      : null;

  const data = {
    symbol: sym,
    companyName: null,
    sector,
    industry,
    marketCap: mcapCr != null ? mcapCr * 1e7 : null,
    peTrailing: pe,
    peForward: null,
    eps,
    bookValue,
    priceToBook,
    roe,
    profitMargin,
    debtToEquity,
    currentRatio: null,
    dividendYield: divYield != null ? divYield / 100 : null,
    beta: null,
    week52High: high52,
    week52Low: low52,
    revenueGrowth,
    earningsGrowth,
    roce,
    recommendationKey: null,
    targetMeanPrice: null,
    quarterly,
    revenueQoQ,
    profitQoQ,
    revenueYoY,
    profitYoY,
    dataNote:
      'Fundamentals from Screener.in including quarterly Sales/Profit (QoQ + same-quarter YoY) and annual growth. Free public page.',
    source: 'screener',
  };

  cache.set(sym, { at: Date.now(), data });
  return data;
}

module.exports = { getScreenerFundamentals };
