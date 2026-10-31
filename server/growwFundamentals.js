// Indian stock fundamentals via Groww public API (no key).
// Used when Yahoo quoteSummary / Screener are blocked on the user's network.
const axios = require('axios');

const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://groww.in/',
};

function parseValue(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '—') return null;
  s = s.replace(/₹/g, '').replace(/,/g, '').replace(/%/g, '').trim();
  // 16,21,874Cr or 1621874Cr
  let mult = 1;
  if (/Cr$/i.test(s)) {
    mult = 1e7;
    s = s.replace(/Cr$/i, '');
  } else if (/Lakh$/i.test(s)) {
    mult = 1e5;
    s = s.replace(/Lakh$/i, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : null;
}

function parsePct(raw) {
  const n = parseValue(raw);
  if (n == null) return null;
  // Groww ROE comes as 45.89 meaning 45.89% → store as 0.4589 like Yahoo
  if (Math.abs(n) > 1.5) return n / 100;
  return n;
}

function fundMap(list) {
  const m = {};
  for (const row of list || []) {
    const k = (row.name || row.shortName || '').trim();
    if (k) m[k] = row.value;
  }
  return m;
}

async function resolveSearchId(symbol) {
  const sym = String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  const res = await axios.get('https://groww.in/v1/api/search/v1/entity', {
    params: { query: sym, size: 8 },
    headers: HEADERS,
    timeout: 12000,
  });
  const content = res.data?.content || [];
  const stocks = content.filter((c) => (c.entity_type || '').toLowerCase() === 'stocks');
  // Exact NSE code match first
  let hit =
    stocks.find((c) => String(c.nse_scrip_code || '').toUpperCase() === sym) ||
    stocks.find((c) => String(c.symbol || '').toUpperCase() === sym) ||
    stocks.find((c) => String(c.search_id || c.id || '').toUpperCase() === sym.toLowerCase()) ||
    stocks[0];
  if (!hit) throw new Error('Groww search: symbol not found');
  return hit.search_id || hit.id;
}

async function getGrowwFundamentals(symbol) {
  const sym = String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  if (!sym) return null;
  const cached = cache.get(sym);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const searchId = await resolveSearchId(sym);
  const res = await axios.get(
    `https://groww.in/v1/api/stocks_data/v1/company/search_id/${encodeURIComponent(searchId)}`,
    { headers: HEADERS, timeout: 15000 }
  );
  const d = res.data || {};
  const header = d.header || {};
  const fmap = fundMap(d.fundamentals);

  const pick = (...names) => {
    for (const n of names) {
      if (fmap[n] != null) return fmap[n];
    }
    return null;
  };

  const pe = parseValue(pick('P/E Ratio(TTM)', 'P/E Ratio', 'PE', 'P/E'));
  const eps = parseValue(pick('EPS(TTM)', 'EPS'));
  const pb = parseValue(pick('P/B Ratio', 'PB', 'P/B'));
  const book = parseValue(pick('Book Value', 'Book Value/Share'));
  const face = parseValue(pick('Face Value', 'Face value'));
  const roe = parsePct(pick('ROE', 'Return on Equity'));
  const div = parsePct(pick('Dividend Yield', 'Div Yield', 'Dividend'));
  const debt = parseValue(pick('Debt to Equity', 'Debt/Equity', 'D/E'));
  const currentRatio = parseValue(pick('Current Ratio'));
  const beta = parseValue(pick('Beta'));
  const industryPE = parseValue(pick('Industry P/E', 'Industry PE', 'Industry P/E(TTM)'));
  let profitMargin = parsePct(pick('Profit Margin', 'NPM', 'Net Profit Margin', 'OPM'));
  if (profitMargin == null) {
    const pmRaw = parseValue(pick('Profit Margin', 'NPM'));
    if (pmRaw != null) profitMargin = Math.abs(pmRaw) > 1.5 ? pmRaw / 100 : pmRaw;
  }
  const mcapRaw = pick('Market Cap', 'Mkt Cap');
  let marketCap = parseValue(mcapRaw);
  // parseValue already applies Cr → *1e7 for values like 749559 after stripping Cr
  // Groww "₹7,49,559Cr" → after strip commas + Cr → 749559 * 1e7

  // Revenue / profit growth from financialStatement
  let revenueGrowth = null;
  let earningsGrowth = null;
  let quarterly = [];
  let revenueQoQ = null;
  let profitQoQ = null;
  const stmts = d.financialStatement || d.financialStatementV2 || [];
  const rev = stmts.find((x) => /revenue/i.test(x.title || ''));
  const prof = stmts.find((x) => /profit|pat|net/i.test(x.title || ''));
  if (rev?.cagr?.oneYearTtm != null) revenueGrowth = Number(rev.cagr.oneYearTtm);
  if (prof?.cagr?.oneYearTtm != null) earningsGrowth = Number(prof.cagr.oneYearTtm);

  if (rev?.quarterly && typeof rev.quarterly === 'object') {
    const qEntries = Object.entries(rev.quarterly);
    const pEntries = prof?.quarterly ? Object.entries(prof.quarterly) : [];
    for (let i = 0; i < qEntries.length; i++) {
      const [label, sales] = qEntries[i];
      const profit = pEntries[i] ? pEntries[i][1] : null;
      quarterly.push({
        endDate: null,
        label,
        totalRevenue: sales != null ? Number(sales) * 1e7 : null,
        netIncome: profit != null ? Number(profit) * 1e7 : null,
        revenueCr: sales != null ? Number(sales) : null,
        profitCr: profit != null ? Number(profit) : null,
      });
    }
    // QoQ last two
    if (qEntries.length >= 2) {
      const a = Number(qEntries[qEntries.length - 2][1]);
      const b = Number(qEntries[qEntries.length - 1][1]);
      if (a) revenueQoQ = (b - a) / Math.abs(a);
    }
    if (pEntries.length >= 2) {
      const a = Number(pEntries[pEntries.length - 2][1]);
      const b = Number(pEntries[pEntries.length - 1][1]);
      if (a) profitQoQ = (b - a) / Math.abs(a);
    }
    // newest first for UI
    quarterly = quarterly.reverse().slice(0, 8);
  }


  // Shareholding — prefer V2 (exact Groww UI: promoters/fii/dii/public)
  let shareholdingSummary = null;
  try {
    const n2 = (v) => {
      if (v == null || v === '') return null;
      const x = Number(v);
      return Number.isFinite(x) ? Number(x.toFixed(2)) : null;
    };
    const v2 = d.shareholdingPatternV2?.data || d.shareholdingPatternV2;
    let quarters = [];
    if (v2 && typeof v2 === 'object') {
      quarters = Object.keys(v2).map((lab) => {
        const raw = v2[lab] || {};
        return {
          label: lab,
          promoterPct: n2(raw.promoters ?? raw.promoter),
          fiiPct: n2(raw.fii),
          diiPct: n2(raw.dii),
          publicPct: n2(raw.public),
        };
      });
    }
    if (!quarters.length && d.shareHoldingPattern) {
      const pat = d.shareHoldingPattern;
      quarters = Object.keys(pat).map((lab) => {
        const raw = pat[lab] || {};
        const prom = raw.promoters || {};
        let p = 0;
        for (const k of ['individual', 'government', 'corporation']) p += Number(prom[k]?.percent) || 0;
        const mf = Number(raw.mutualFunds?.percent) || 0;
        const ins = Number(raw.otherDomesticInstitutions?.insurance?.percent) || 0;
        const oth = Number(raw.otherDomesticInstitutions?.otherFirms?.percent) || 0;
        return {
          label: lab,
          promoterPct: n2(p),
          fiiPct: n2(raw.foreignInstitutions?.percent),
          diiPct: n2(mf + ins + oth),
          publicPct: n2(raw.retailAndOthers?.percent),
        };
      });
    }
    if (quarters.length) {
      const latest = quarters[0];
      const prev = quarters[1] || null;
      const delta = (a, b) => (a != null && b != null ? n2(a - b) : null);
      shareholdingSummary = {
        asOf: latest.label,
        promoterPct: latest.promoterPct,
        fiiPct: latest.fiiPct,
        diiPct: latest.diiPct,
        publicPct: latest.publicPct,
        fiiDelta: prev ? delta(latest.fiiPct, prev.fiiPct) : null,
        diiDelta: prev ? delta(latest.diiPct, prev.diiPct) : null,
        promoterDelta: prev ? delta(latest.promoterPct, prev.promoterPct) : null,
        publicDelta: prev ? delta(latest.publicPct, prev.publicPct) : null,
        source: 'groww',
      };
    }
  } catch (_) {}

  const data = {
    symbol: header.nseScriptCode || sym,
    companyName: header.displayName || header.shortName || null,
    sector: header.industryName || null,
    industry: header.industryName || null,
    marketCap: marketCap,
    peTrailing: pe,
    peForward: null,
    eps,
    bookValue: book,
    faceValue: face,
    priceToBook: pb,
    roe,
    profitMargin,
    debtToEquity: debt,
    currentRatio,
    dividendYield: div,
    beta,
    industryPE,
    week52High: null,
    week52Low: null,
    revenueGrowth,
    earningsGrowth,
    revenueQoQ,
    profitQoQ,
    revenueYoY: revenueGrowth,
    profitYoY: earningsGrowth,
    quarterly,
    shareholdingSummary,
    dataNote: 'Fundamentals from Groww public API (Yahoo/Screener fallback).',
    source: 'groww',
  };

  cache.set(sym, { at: Date.now(), data });
  return data;
}

module.exports = { getGrowwFundamentals };
