// server/marketData.js
// Live market data provider using Yahoo Finance's public endpoints.
//
// Why Yahoo instead of NSE directly: NSE India's unofficial API blocks most
// server/cloud IPs (it wants a "real browser" session), which is why data
// often fails to load when this app runs on a server. Yahoo Finance's chart
// and search endpoints are free, need no API key, and work reliably from
// servers for NSE-listed stocks using the ".NS" suffix (e.g. RELIANCE.NS).
// Price data is real-time/near real-time during market hours and end-of-day
// otherwise - i.e. exactly "abhi ka ya kal tak ka" data, for free.
//
// This is the ONLY file that talks to the data provider - swap it out later
// for a paid feed (Upstox, Kite Connect, etc.) without touching anything else.

const axios = require('axios');
const { getScreenerFundamentals } = require('./screenerFundamentals');
const { getGrowwFundamentals } = require('./growwFundamentals');
const fundamentalsStore = require('./fundamentalsStore');
// Yahoo sometimes returns large Set-Cookie headers; Node default maxHeaderSize
// causes "Parse Error: Header overflow". Use a dedicated client with headroom.
const yahooHttp = axios.create({
  timeout: 15000,
  maxHeaderSize: 1024 * 1024,
  maxContentLength: 20 * 1024 * 1024,
  validateStatus: (s) => s >= 200 && s < 500,
});

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

function toYahooSymbol(symbol) {
  const s = symbol.trim().toUpperCase();
  if (s.startsWith('^') || s.includes('=')) return s; // index symbols (^NSEI) and futures/FX (CL=F, USDINR=X) - no suffix
  if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
  // Mutual-fund style codes from Yahoo (e.g. 0P0000XXXX) — leave as-is so
  // getQuote can try them without forcing .NS (which would 404).
  if (/^0P[0-9A-Z]+$/i.test(s) || s.includes('.')) return s;
  return `${s}.NS`;
}

function fromYahooSymbol(yahooSymbol) {
  if (yahooSymbol.startsWith('^')) return yahooSymbol;
  return yahooSymbol.replace(/\.(NS|BO)$/, '');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Yahoo's quoteSummary endpoint (used for fundamentals + earnings calendar)
// requires a session cookie + "crumb" token - the chart/search endpoints
// don't need this, which is why those keep working without it. Fetch once,
// cache for a while, and attach to quoteSummary requests.
let crumbCache = { crumb: null, cookie: '', fetchedAt: 0 };
const CRUMB_TTL_MS = 55 * 60 * 1000; // Yahoo crumbs last ~1hr; refresh a bit early

async function getCrumb() {
  if (crumbCache.crumb && Date.now() - crumbCache.fetchedAt < CRUMB_TTL_MS) return crumbCache;
  // finance.yahoo.com (not the fc.yahoo.com shortlink) is what reliably
  // sets the full cookie set (A1/A3 etc.) that the getcrumb endpoint wants -
  // using fc.yahoo.com has been a common cause of an immediately-invalid
  // crumb in community reports.
  const sessionRes = await yahooHttp.get('https://finance.yahoo.com', { headers: HEADERS, timeout: 10000, validateStatus: () => true, maxHeaderSize: 256 * 1024, maxContentLength: 10 * 1024 * 1024 });
  // Keep only the cookies Yahoo crumb needs — joining every Set-Cookie can
  // blow past Node's default header size ("Parse Error: Header overflow").
  const rawCookies = sessionRes.headers['set-cookie'] || [];
  // Minimal cookie jar: only A1. Large Cookie request headers trigger
  // "Parse Error: Header overflow" under bulk quoteSummary load.
  const cookie = rawCookies
    .map((c) => String(c).split(';')[0].trim())
    .filter((c) => /^A1=/i.test(c) && c.length <= 180)
    .slice(0, 2)
    .join('; ');
  const crumbRes = await yahooHttp.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...HEADERS, Cookie: cookie },
    timeout: 10000,
    maxHeaderSize: 1024 * 1024,
  });
  crumbCache = { crumb: crumbRes.data, cookie, fetchedAt: Date.now() };
  return crumbCache;
}

// Transient failures (timeouts, momentary 429s) are common with a free,
// unauthenticated endpoint - retry a couple of times before giving up so a
// single blip doesn't surface as "could not load data" to the user.
async function withRetry(fn, attempts = 3, baseDelayMs = 400) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status && status !== 429 && status < 500) break; // don't retry hard 4xx (bad symbol etc.)
      // 429 (rate-limited) needs a much longer breather than a normal
      // network blip, or we just get rate-limited again immediately.
      const delay = status === 429 ? 2000 * (i + 1) : baseDelayMs * (i + 1);
      if (i < attempts - 1) await sleep(delay);
    }
  }
  throw lastErr;
}

// Search for a symbol/company name -> list of matches.
// Includes NSE/BSE equities AND Indian mutual funds (Yahoo often lists MFs
// under .BO or as quoteType MUTUALFUND / ETF). Without the MF filter the
// search used to drop every fund result, which is why "mutual fund ka data
// nahi aa pata" was a common complaint.
async function search(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  // 1) Local universe (Nifty50/Mid/Small) — instant partial match even for "rel", "tcs"
  let local = [];
  try {
    const { INDEXES } = require('./indexConstituents');
    const ql = q.toUpperCase();
    const seen = new Set();
    for (const idx of Object.values(INDEXES || {})) {
      for (const sym of idx.symbols || []) {
        const s = String(sym).toUpperCase();
        if (seen.has(s)) continue;
        if (s.startsWith(ql) || s.includes(ql)) {
          seen.add(s);
          local.push({
            symbol: s,
            yahooSymbol: `${s}.NS`,
            name: s,
            quoteType: 'EQUITY',
            isMutualFund: false,
            exchange: 'NSE',
            source: 'local',
            _rank: s.startsWith(ql) ? 0 : 1,
          });
        }
      }
    }
    local.sort((a, b) => a._rank - b._rank || a.symbol.localeCompare(b.symbol));
    local = local.slice(0, 12).map(({ _rank, ...r }) => r);
  } catch (_) {}

  // 2) Yahoo search (may need fuller query; still useful for names)
  let remote = [];
  try {
    const res = await withRetry(() =>
      yahooHttp.get('https://query1.finance.yahoo.com/v1/finance/search', {
        params: { q, quotesCount: 15, newsCount: 0 },
        headers: HEADERS,
        timeout: 10000,
      })
    );
    const quotes = res.data?.quotes || [];
    const allowedTypes = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', undefined, null]);
    remote = quotes
      .filter((item) => {
        if (!item.symbol) return false;
        const type = (item.quoteType || item.typeDisp || '').toUpperCase();
        const isIndianListing = item.symbol.endsWith('.NS') || item.symbol.endsWith('.BO');
        const isMfOrEtf = type === 'MUTUALFUND' || type === 'ETF'
          || /mutual|fund|etf|index fund/i.test(item.longname || item.shortname || '');
        if (isIndianListing && (allowedTypes.has(type) || !type)) return true;
        if (isMfOrEtf && (isIndianListing || item.exchDisp === 'NSE' || item.exchDisp === 'BSE' || item.exchange === 'NSI' || item.exchange === 'BOM')) return true;
        return false;
      })
      .map((item) => {
        const type = (item.quoteType || item.typeDisp || '').toUpperCase();
        const isMf = type === 'MUTUALFUND' || /mutual|fund/i.test(item.longname || item.shortname || '');
        return {
          symbol: fromYahooSymbol(item.symbol),
          yahooSymbol: item.symbol,
          name: item.longname || item.shortname || item.symbol,
          quoteType: type || (isMf ? 'MUTUALFUND' : 'EQUITY'),
          isMutualFund: isMf,
          exchange: item.exchDisp || item.exchange || null,
          source: 'yahoo',
        };
      });
  } catch (_) {
    // Yahoo fail → still return local matches
  }

  // Merge: local first, then remote unique
  const out = [];
  const seenSym = new Set();
  for (const r of [...local, ...remote]) {
    const s = String(r.symbol || '').toUpperCase();
    if (!s || seenSym.has(s)) continue;
    seenSym.add(s);
    out.push({ ...r, symbol: s });
    if (out.length >= 15) break;
  }
  return out;
}

// Short in-memory chart cache: bulk scans hit the same symbol for quote
// (5d/1d) then historical (1y+/1d). Caching avoids duplicate Yahoo calls
// within a few minutes and makes universe/index scans noticeably smoother
// without changing any API response shape.
const chartCache = new Map(); // key -> { at, result }
const CHART_CACHE_TTL_MS = 3 * 60 * 1000;
const CHART_CACHE_MAX = 800;

function chartCacheKey(symbol, range, interval) {
  return `${toYahooSymbol(symbol)}|${range}|${interval}`;
}

function getCachedChart(key) {
  const hit = chartCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CHART_CACHE_TTL_MS) {
    chartCache.delete(key);
    return null;
  }
  return hit.result;
}

function setCachedChart(key, result) {
  if (chartCache.size >= CHART_CACHE_MAX) {
    // drop oldest ~20%
    const entries = [...chartCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < Math.ceil(entries.length * 0.2); i++) chartCache.delete(entries[i][0]);
  }
  chartCache.set(key, { at: Date.now(), result });
}

// One combined call gets both the current quote (from `meta`) and the
// historical candles (from `timestamp` + `indicators.quote[0]`).
async function getChart(symbol, range = '1y', interval = '1d') {
  const key = chartCacheKey(symbol, range, interval);
  const cached = getCachedChart(key);
  if (cached) return cached;
  const yahooSymbol = toYahooSymbol(symbol);
  const res = await withRetry(() =>
    yahooHttp.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
      { params: { range, interval }, headers: HEADERS, timeout: 12000 }
    )
  );
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error('No data returned for this symbol');
  setCachedChart(key, result);
  return result;
}

async function getQuote(symbol) {
  const result = await getChart(symbol, '5d', '1d');
  const meta = result.meta || {};
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const pChange = change != null && prevClose ? (change / prevClose) * 100 : null;

  return {
    symbol: fromYahooSymbol(meta.symbol || toYahooSymbol(symbol)),
    companyName: meta.longName || meta.shortName || null,
    lastPrice: price,
    change,
    pChange,
    open: meta.regularMarketOpen ?? null,
    previousClose: prevClose ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    weekHigh52: meta.fiftyTwoWeekHigh ?? null,
    weekLow52: meta.fiftyTwoWeekLow ?? null,
    vwap: null,
    totalTradedVolume: meta.regularMarketVolume ?? null,
    marketState: meta.marketState || null, // REGULAR | PRE | POST | CLOSED
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getHistorical(symbol, days = 1260) {
  // Yahoo ranges are coarse buckets; pick one comfortably larger than `days`.
  const range = days > 1000 ? '5y' : days > 400 ? '2y' : days > 150 ? '1y' : days > 50 ? '6mo' : '3mo';
  const result = await getChart(symbol, range, '1d');
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  const candles = timestamps
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null);

  return candles.slice(-days);
}

// Intraday candles (5m/15m/1h etc.) via the same Yahoo chart endpoint, just
// with a shorter interval. Yahoo only keeps limited intraday history (~60
// days for 5m/15m/1h, ~7 days for 1m) - that's a Yahoo limitation, not a
// bug here. `date` is a full ISO timestamp (not just a date) since these
// candles are sub-daily.
async function getIntradayCandles(symbol, range, interval) {
  const result = await getChart(symbol, range, interval);
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null);
}

// Recent news headlines for a symbol (free, via Yahoo's search endpoint).
// Used to give a plain-language "why is it moving" context alongside the
// technical factors - since real institutional (FII/DII/mutual fund) flow
// data isn't available for free, this + the volume-spike indicator are the
// practical free proxy for "who's interested in this stock right now".
async function getNews(symbol) {
  const res = await withRetry(() =>
    yahooHttp.get('https://query1.finance.yahoo.com/v1/finance/search', {
      params: { q: symbol.replace(/\.(NS|BO)$/, ''), quotesCount: 0, newsCount: 8 },
      headers: HEADERS,
      timeout: 10000,
    })
  );
  const news = res.data?.news || [];
  return news.map((n) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
  }));
}

// Fundamentals (P/E, EPS, ROE, sector, etc.) via Yahoo's quoteSummary
// endpoint - free, no key needed. This is the closest free equivalent to
// what a paid fundamentals data provider would give you.
async function quoteSummaryGet(symbol, modules) {
  const yahooSymbol = toYahooSymbol(symbol);
  const attempt = async (useSession) => {
    const params = { modules };
    const headers = { ...HEADERS };
    if (useSession) {
      const { crumb, cookie } = await getCrumb();
      params.crumb = crumb;
      if (cookie) headers.Cookie = cookie;
    }
    // query2 is often less aggressive with oversized headers under bulk load
    const res = await yahooHttp.get(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}`,
      { params, headers, timeout: 15000, maxHeaderSize: 1024 * 1024 }
    );
    return res.data;
  };
  try {
    return await attempt(true);
  } catch (err) {
    const status = err.response?.status;
    const looksLikeBadSession = [401, 403, 406].includes(status)
      || /header overflow|parse error/i.test(err.message || '');
    if (looksLikeBadSession) {
      crumbCache = { crumb: null, cookie: '', fetchedAt: 0 };
      await sleep(800);
      try {
        return await attempt(true);
      } catch (err2) {
        await sleep(400);
        try {
          return await attempt(false);
        } catch (err3) {
          // Final fallback: try query1 without session
          try {
            const res = await yahooHttp.get(
              `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}`,
              { params: { modules }, headers: { ...HEADERS }, timeout: 15000, maxHeaderSize: 1024 * 1024 }
            );
            return res.data;
          } catch (_) {
            throw err3;
          }
        }
      }
    }
    throw err;
  }
}

async function getFundamentals(symbol, opts = {}) {
  // opts.preferCacheOnly — bulk scan: DB only, no network
  // opts.forceRefresh — ignore 7d cache (only honored in fund refresh window unless ignoreWindow)
  // opts.livePrice — invalidate on big move
  // opts.maxAgeDays — default 7
  let preferCacheOnly = !!opts.preferCacheOnly;
  let forceRefresh = !!opts.forceRefresh;
  const ignoreWindow = !!opts.ignoreWindow;
  const maxAgeDays = opts.maxAgeDays ?? fundamentalsStore.DEFAULT_MAX_AGE_DAYS;
  const livePrice = opts.livePrice ?? null;
  let staleFallback = null;

  // Outside 09:45–10:15 / after 15:30 IST: do not hammer Yahoo/Groww or rewrite cache
  if (!opts.ignoreWindow) {
    try {
      const { isFundamentalsRefreshWindow } = require('./fundamentalsWarm');
      if (!isFundamentalsRefreshWindow() && !ignoreWindow) {
        if (forceRefresh) forceRefresh = false;
        // Prefer cache; if miss, still one soft fetch only when no stale at all is handled below — mark prefer cache for bulk
        if (opts.preferCacheOnly !== false && opts.bulk) preferCacheOnly = true;
      }
    } catch (_) {}
  }

  if (!forceRefresh) {
    try {
      const cached = await fundamentalsStore.readCache(symbol, { maxAgeDays, livePrice });
      if (cached.hit && !cached.stale && cached.data) {
        return { ...cached.data, fromCache: true };
      }
      if (cached.hit && cached.data) staleFallback = cached.data;
      if (preferCacheOnly && cached.hit && cached.data) {
        return { ...cached.data, fromCache: true, cacheStale: true, cacheReason: cached.reason };
      }
      if (preferCacheOnly) return null;
    } catch (_) {}
  }

  const persist = async (data) => {
    if (!data) return data;
    try {
      await fundamentalsStore.writeCache(symbol, data, {
        priceAtCache: livePrice ?? null,
        nextEarnings: data.nextEarnings || null,
      });
    } catch (err) {
      console.warn('[fundamentals] cache write failed', symbol, err.message);
    }
    return data;
  };

  const runYahoo = async () => {
    const g = (obj, path, key = 'raw') => {
      try {
        const val = path.split('.').reduce((o, p) => o?.[p], obj);
        return val && typeof val === 'object' ? val[key] ?? null : val ?? null;
      } catch { return null; }
    };

    const data = await quoteSummaryGet(
      symbol,
      'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price'
    );
    const result = data?.quoteSummary?.result?.[0];
    if (!result) throw new Error('No fundamentals data found for this symbol');

    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};
    const ap = result.assetProfile || {};
    const pr = result.price || {};

    let quarterly = [];
    let revenueQoQ = null;
    let profitQoQ = null;
    let revenueYoY = null;
    let profitYoY = null;
    let shareholding = {
      insidersPercent: null,
      institutionsPercent: null,
      institutionsFloatPercent: null,
      institutionsCount: null,
    };
    let institutionHolders = [];
    let fundHolders = [];

    try {
      const extra = await quoteSummaryGet(
        symbol,
        'incomeStatementHistoryQuarterly,majorHoldersBreakdown,institutionOwnership,fundOwnership'
      );
      const er = extra?.quoteSummary?.result?.[0] || {};
      const qStatements = er.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
      quarterly = qStatements.slice(0, 5).map((row) => {
        const end = row.endDate?.raw != null
          ? new Date(row.endDate.raw * 1000).toISOString().slice(0, 10)
          : (row.endDate?.fmt || null);
        return {
          endDate: end,
          totalRevenue: g(row, 'totalRevenue'),
          netIncome: g(row, 'netIncome'),
          grossProfit: g(row, 'grossProfit'),
          operatingIncome: g(row, 'operatingIncome'),
          ebit: g(row, 'ebit'),
        };
      });
      if (quarterly.length >= 2 && quarterly[0].totalRevenue && quarterly[1].totalRevenue) {
        revenueQoQ = (quarterly[0].totalRevenue - quarterly[1].totalRevenue) / Math.abs(quarterly[1].totalRevenue);
      }
      if (quarterly.length >= 2 && quarterly[0].netIncome != null && quarterly[1].netIncome != null && quarterly[1].netIncome !== 0) {
        profitQoQ = (quarterly[0].netIncome - quarterly[1].netIncome) / Math.abs(quarterly[1].netIncome);
      }
      if (quarterly.length >= 5 && quarterly[0].totalRevenue && quarterly[4].totalRevenue) {
        revenueYoY = (quarterly[0].totalRevenue - quarterly[4].totalRevenue) / Math.abs(quarterly[4].totalRevenue);
      }
      if (quarterly.length >= 5 && quarterly[0].netIncome != null && quarterly[4].netIncome != null && quarterly[4].netIncome !== 0) {
        profitYoY = (quarterly[0].netIncome - quarterly[4].netIncome) / Math.abs(quarterly[4].netIncome);
      }
      const mh = er.majorHoldersBreakdown || {};
      shareholding = {
        insidersPercent: g(mh, 'insidersPercentHeld'),
        institutionsPercent: g(mh, 'institutionsPercentHeld'),
        institutionsFloatPercent: g(mh, 'institutionsFloatPercentHeld'),
        institutionsCount: g(mh, 'institutionsCount'),
      };
      institutionHolders = (er.institutionOwnership?.ownershipList || []).slice(0, 8).map((h) => ({
        organization: h.organization || null,
        pctHeld: g(h, 'pctHeld'),
      }));
      fundHolders = (er.fundOwnership?.ownershipList || []).slice(0, 8).map((h) => ({
        organization: h.organization || null,
        pctHeld: g(h, 'pctHeld'),
      }));
    } catch (_) {}

    return {
      symbol: String(symbol).replace(/\.(NS|BO)$/i, '').toUpperCase(),
      companyName: pr.longName || pr.shortName || null,
      sector: ap.sector || null,
      industry: ap.industry || null,
      businessSummary: ap.longBusinessSummary || ap.description || null,
      website: ap.website || null,
      employees: g(ap, 'fullTimeEmployees'),
      country: ap.country || null,
      city: ap.city || null,
      marketCap: g(pr, 'marketCap') ?? g(sd, 'marketCap'),
      peTrailing: g(sd, 'trailingPE'),
      peForward: g(sd, 'forwardPE'),
      eps: g(ks, 'trailingEps'),
      bookValue: g(ks, 'bookValue'),
      faceValue: g(ks, 'faceValue') ?? g(ks, 'parValue') ?? g(sd, 'faceValue') ?? null,
      priceToBook: g(ks, 'priceToBook'),
      roe: g(fd, 'returnOnEquity'),
      profitMargin: g(fd, 'profitMargins'),
      debtToEquity: g(fd, 'debtToEquity'),
      currentRatio: g(fd, 'currentRatio'),
      dividendYield: g(sd, 'dividendYield'),
      beta: g(sd, 'beta'),
      week52High: g(sd, 'fiftyTwoWeekHigh'),
      week52Low: g(sd, 'fiftyTwoWeekLow'),
      revenueGrowth: g(fd, 'revenueGrowth'),
      earningsGrowth: g(fd, 'earningsGrowth'),
      recommendationKey: fd.recommendationKey || null,
      targetMeanPrice: g(fd, 'targetMeanPrice'),
      quarterly,
      revenueQoQ,
      profitQoQ,
      revenueYoY,
      profitYoY,
      shareholding,
      institutionHolders,
      fundHolders,
      dataNote: 'Core metrics from Yahoo. Quarterly / holders when available.',
      source: 'yahoo',
    };
  };

  // Yahoo first (works on most home networks). Screener is optional — many ISPs
  // intermittently block screener.in even when finance.yahoo.com works.
  let yahooData = null;
  try {
    yahooData = await runYahoo();
  } catch (yahooErr) {
    if (process.env.FUND_DEBUG === '1') console.warn('[fundamentals] Yahoo miss', symbol, yahooErr.message);
  }

  let screenerData = null;
  // Only try Screener if Yahoo empty/partial OR Yahoo fully failed — short timeout inside screener module
  const needScreener = !yahooData || (yahooData.peTrailing == null && yahooData.roe == null);
  if (needScreener) {
    try {
      screenerData = await getScreenerFundamentals(symbol);
    } catch (scErr) {
      // Quiet — ECONNREFUSED is common when ISP blocks Screener
      if (!/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(String(scErr.message))) {
        console.warn('[fundamentals] Screener miss', symbol, scErr.message);
      }
    }
  }

  if (yahooData && screenerData) {
    const merged = {
      ...yahooData,
      peTrailing: yahooData.peTrailing ?? screenerData.peTrailing,
      priceToBook: yahooData.priceToBook ?? screenerData.priceToBook,
      bookValue: yahooData.bookValue ?? screenerData.bookValue,
      faceValue: yahooData.faceValue ?? screenerData.faceValue ?? null,
      industryPE: yahooData.industryPE ?? screenerData.industryPE ?? null,
      currentRatio: yahooData.currentRatio ?? screenerData.currentRatio ?? null,
      beta: yahooData.beta ?? screenerData.beta ?? null,
      roe: yahooData.roe ?? screenerData.roe,
      roce: screenerData.roce ?? yahooData.roce,
      dividendYield: yahooData.dividendYield ?? screenerData.dividendYield,
      marketCap: yahooData.marketCap ?? screenerData.marketCap,
      revenueGrowth: yahooData.revenueGrowth ?? screenerData.revenueGrowth,
      earningsGrowth: yahooData.earningsGrowth ?? screenerData.earningsGrowth,
      revenueQoQ: yahooData.revenueQoQ ?? screenerData.revenueQoQ,
      profitQoQ: yahooData.profitQoQ ?? screenerData.profitQoQ,
      revenueYoY: yahooData.revenueYoY ?? screenerData.revenueYoY,
      profitYoY: yahooData.profitYoY ?? screenerData.profitYoY,
      quarterly: (yahooData.quarterly && yahooData.quarterly.length) ? yahooData.quarterly : (screenerData.quarterly || []),
      sector: yahooData.sector || screenerData.sector,
      industry: yahooData.industry || screenerData.industry,
      debtToEquity: yahooData.debtToEquity ?? screenerData.debtToEquity,
      profitMargin: yahooData.profitMargin ?? screenerData.profitMargin,
      eps: yahooData.eps ?? screenerData.eps,
      week52High: yahooData.week52High ?? screenerData.week52High,
      week52Low: yahooData.week52Low ?? screenerData.week52Low,
      dataNote: 'Yahoo + Screener.in merged.',
      source: 'yahoo+screener',
    };
    return await persist(merged);
  }
  // Always try Groww to fill holes (face, debt, industry PE, etc.) even when Yahoo has PE
  let growwData = null;
  try {
    growwData = await getGrowwFundamentals(symbol);
  } catch (gwErr) {
    if (process.env.FUND_DEBUG === '1') console.warn('[fundamentals] Groww miss', symbol, gwErr.message);
  }

  if (yahooData && growwData) {
    return await persist({
      ...yahooData,
      peTrailing: yahooData.peTrailing ?? growwData.peTrailing,
      peForward: yahooData.peForward ?? growwData.peForward,
      priceToBook: yahooData.priceToBook ?? growwData.priceToBook,
      bookValue: yahooData.bookValue ?? growwData.bookValue,
      faceValue: yahooData.faceValue ?? growwData.faceValue ?? null,
      roe: yahooData.roe ?? growwData.roe,
      debtToEquity: yahooData.debtToEquity ?? growwData.debtToEquity,
      currentRatio: yahooData.currentRatio ?? growwData.currentRatio,
      profitMargin: yahooData.profitMargin ?? growwData.profitMargin,
      dividendYield: yahooData.dividendYield ?? growwData.dividendYield,
      beta: yahooData.beta ?? growwData.beta,
      industryPE: yahooData.industryPE ?? growwData.industryPE ?? null,
      marketCap: yahooData.marketCap ?? growwData.marketCap,
      eps: yahooData.eps ?? growwData.eps,
      sector: yahooData.sector || growwData.sector,
      industry: yahooData.industry || growwData.industry,
      revenueGrowth: yahooData.revenueGrowth ?? growwData.revenueGrowth,
      earningsGrowth: yahooData.earningsGrowth ?? growwData.earningsGrowth,
      quarterly: (yahooData.quarterly && yahooData.quarterly.length) ? yahooData.quarterly : (growwData.quarterly || []),
      shareholdingSummary: yahooData.shareholdingSummary || growwData.shareholdingSummary || null,
      dataNote: 'Yahoo + Groww merged (gap-fill).',
      source: 'yahoo+groww',
    });
  }
  if (growwData && (growwData.peTrailing != null || growwData.roe != null || growwData.marketCap != null)) {
    return await persist(growwData);
  }
  if (yahooData) return await persist(yahooData);
  if (screenerData) return await persist(screenerData);

  // Quote-lite last resort
  try {
    const q = await getQuote(symbol);
    if (q && (q.trailingPE != null || q.marketCap != null || q.epsTrailingTwelveMonths != null)) {
      const lite = {
        symbol: String(symbol).replace(/\.(NS|BO)$/i, '').toUpperCase(),
        peTrailing: q.trailingPE ?? q.forwardPE ?? null,
        peForward: q.forwardPE ?? null,
        eps: q.epsTrailingTwelveMonths ?? null,
        marketCap: q.marketCap ?? null,
        bookValue: q.bookValue ?? null,
        priceToBook: q.priceToBook ?? null,
        dividendYield: q.dividendYield ?? null,
        week52High: q.fiftyTwoWeekHigh ?? null,
        week52Low: q.fiftyTwoWeekLow ?? null,
        beta: q.beta ?? null,
        sector: null,
        industry: null,
        roe: null,
        debtToEquity: null,
        profitMargin: null,
        revenueGrowth: null,
        earningsGrowth: null,
        quarterly: [],
        dataNote: 'Lite from Yahoo quote (full fundamentals blocked).',
        source: 'yahoo-quote-lite',
      };
      return await persist(lite);
    }
  } catch (_) {}

  if (staleFallback) return { ...staleFallback, fromCache: true, cacheStale: true };
  throw new Error('No fundamentals data found for this symbol');
}

async function getEvents(symbol) {
  const data = await quoteSummaryGet(symbol, 'calendarEvents,earningsHistory,earningsTrend');
  const result = data?.quoteSummary?.result?.[0];
  const cal = result?.calendarEvents?.earnings || {};
  const earningsDates = cal.earningsDate || [];
  const nextEarnings = earningsDates.length
    ? new Date(earningsDates[0].raw * 1000).toISOString().slice(0, 10)
    : null;
  let daysUntil = null;
  if (nextEarnings) {
    daysUntil = Math.round((new Date(nextEarnings) - new Date()) / (1000 * 60 * 60 * 24));
  }
  const g = (obj, key = 'raw') => {
    if (obj == null) return null;
    if (typeof obj === 'object' && key in obj) return obj[key];
    return typeof obj === 'number' ? obj : null;
  };
  const history = (result?.earningsHistory?.history || []).map((h) => ({
    quarter: h.quarter?.fmt || (h.quarter?.raw != null ? new Date(h.quarter.raw * 1000).toISOString().slice(0, 10) : null),
    date: h.quarter?.raw != null ? new Date(h.quarter.raw * 1000).toISOString().slice(0, 10) : null,
    epsActual: g(h.epsActual),
    epsEstimate: g(h.epsEstimate),
    epsDifference: g(h.epsDifference),
    surprisePercent: g(h.surprisePercent),
  })).filter((h) => h.date || h.quarter);

  // Earnings trend estimates (current / next quarter if available)
  const trends = result?.earningsTrend?.trend || [];
  const trendSnap = trends
    .filter((tr) => ['0q', '1q', '0y', '1y'].includes(tr.period))
    .map((tr) => ({
      period: tr.period,
      endDate: tr.endDate || null,
      epsEstimate: g(tr.earningsEstimate?.avg),
      revenueEstimate: g(tr.revenueEstimate?.avg),
      growth: g(tr.growth),
    }));

  return {
    nextEarnings,
    daysUntil,
    earningsAverage: g(cal.earningsAverage),
    earningsLow: g(cal.earningsLow),
    earningsHigh: g(cal.earningsHigh),
    revenueAverage: g(cal.revenueAverage),
    history,
    trends: trendSnap,
  };
}


// One Yahoo request → both live quote fields and daily candles. Used by
// bulk analyzeOne so each symbol costs ~1 outbound call instead of 2.
async function getQuoteAndHistory(symbol, days = 1260) {
  const range = days > 1000 ? '5y' : days > 400 ? '2y' : days > 150 ? '1y' : days > 50 ? '6mo' : '3mo';
  const result = await getChart(symbol, range, '1d');
  const meta = result.meta || {};
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const pChange = change != null && prevClose ? (change / prevClose) * 100 : null;
  const quote = {
    symbol: fromYahooSymbol(meta.symbol || toYahooSymbol(symbol)),
    companyName: meta.longName || meta.shortName || null,
    lastPrice: price,
    change,
    pChange,
    open: meta.regularMarketOpen ?? null,
    previousClose: prevClose ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    weekHigh52: meta.fiftyTwoWeekHigh ?? null,
    weekLow52: meta.fiftyTwoWeekLow ?? null,
    vwap: null,
    totalTradedVolume: meta.regularMarketVolume ?? null,
    marketState: meta.marketState || null,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = timestamps
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null)
    .slice(-days);
  // If live meta price is missing (closed market edge cases), use last close
  if (quote.lastPrice == null && candles.length) {
    quote.lastPrice = candles[candles.length - 1].close;
  }
  return { quote, candles };
}


// Fresh IPO / SME tickers often land on Yahoo as SYMBOL-SM.NS (or slightly
// different spelling) hours after NSE listing — plain SYMBOL.NS 404s until
// Yahoo indexes them. Resolve with a short candidate list + search.
const ipoSymbolCache = new Map(); // nseSymbol -> yahooSymbol
async function resolveIpoYahooSymbol(symbol, companyName = null) {
  const base = String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '').replace(/-SM$/i, '');
  if (!base) return null;
  if (ipoSymbolCache.has(base)) return ipoSymbolCache.get(base);

  const candidates = [
    `${base}.NS`,
    `${base}-SM.NS`,
    `${base}.BO`,
    `${base}-SM.BO`,
  ];
  // Common NSE vs Yahoo spelling: extra A in SME codes
  if (!base.endsWith('A')) candidates.splice(2, 0, `${base}A-SM.NS`, `${base}A.NS`);

  for (const y of candidates) {
    try {
      const res = await yahooHttp.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}`, {
        params: { range: '1d', interval: '5m', events: 'div,splits' },
        headers: HEADERS,
        timeout: 8000,
        validateStatus: () => true,
      });
      if (res.status === 200 && res.data?.chart?.result?.[0]?.meta?.regularMarketPrice != null) {
        ipoSymbolCache.set(base, y);
        return y;
      }
    } catch (_) {}
  }

  // Yahoo search fallback
  const queries = [base, companyName, base.replace(/AUTO$/, ' AUTO')].filter(Boolean);
  for (const q of queries) {
    try {
      const res = await yahooHttp.get('https://query1.finance.yahoo.com/v1/finance/search', {
        params: { q, quotesCount: 8, newsCount: 0 },
        headers: HEADERS,
        timeout: 8000,
      });
      const quotes = res.data?.quotes || [];
      for (const row of quotes) {
        const ys = row.symbol;
        if (!ys || !/\.(NS|BO)$/i.test(ys)) continue;
        const core = ys.replace(/\.(NS|BO)$/i, '').replace(/-SM$/i, '').toUpperCase();
        if (core === base || core.startsWith(base) || base.startsWith(core) || (companyName && (row.shortname || row.longname || '').toUpperCase().includes(base.slice(0, 5)))) {
          try {
            const chk = await yahooHttp.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}`, {
              params: { range: '1d', interval: '5m' },
              headers: HEADERS,
              timeout: 8000,
              validateStatus: () => true,
            });
            if (chk.status === 200 && chk.data?.chart?.result?.[0]?.meta?.regularMarketPrice != null) {
              ipoSymbolCache.set(base, ys);
              return ys;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return null;
}

async function getQuoteForIpo(symbol, companyName = null) {
  const y = await resolveIpoYahooSymbol(symbol, companyName);
  if (!y) {
    const err = new Error(`Live quote not on Yahoo yet for ${symbol} (common in first minutes after listing). Will retry.`);
    err.code = 'IPO_QUOTE_PENDING';
    throw err;
  }
  const chartRes = await withRetry(() =>
    yahooHttp.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}`, {
      params: { range: '1d', interval: '1m', events: 'div,splits' },
      headers: HEADERS,
      timeout: 12000,
    })
  );
  const result2 = chartRes.data?.chart?.result?.[0];
  if (!result2) throw new Error(`No quote data for ${y}`);
  const meta = result2.meta || {};
  const q = result2.indicators?.quote?.[0] || {};
  const highs = (q.high || []).filter((x) => x != null);
  const lows = (q.low || []).filter((x) => x != null);
  return {
    symbol: String(symbol).toUpperCase().replace(/\.(NS|BO)$/i, ''),
    yahooSymbol: y,
    lastPrice: meta.regularMarketPrice ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    open: meta.regularMarketOpen ?? q.open?.[0] ?? null,
    dayHigh: meta.regularMarketDayHigh ?? (highs.length ? Math.max(...highs) : null),
    dayLow: meta.regularMarketDayLow ?? (lows.length ? Math.min(...lows) : null),
    volume: meta.regularMarketVolume ?? null,
    change: null,
    changePercent: null,
  };
}

async function getIntradayCandlesForIpo(symbol, companyName = null) {
  const y = await resolveIpoYahooSymbol(symbol, companyName);
  if (!y) return [];
  const chartRes = await withRetry(() =>
    yahooHttp.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}`, {
      params: { range: '1d', interval: '5m', events: 'div,splits' },
      headers: HEADERS,
      timeout: 12000,
    })
  );
  const result = chartRes.data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return timestamps
    .map((ts, i) => ({
      date: new Date(ts * 1000).toISOString(),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((c) => c.close != null);
}


// Full daily history via period1/period2 (Yahoo "max" range is often truncated).
// Used for multi-year analog / drawdown studies (Nifty ~2007+).
async function getLongHistory(symbol, years = 25) {
  const yahooSymbol = toYahooSymbol(symbol);
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - Math.floor(years * 365.25 * 24 * 3600);
  const key = chartCacheKey(symbol, `long${years}y`, '1d');
  const cached = getCachedChart(key);
  let result = cached;
  if (!result) {
    const res = await withRetry(() =>
      yahooHttp.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
        {
          params: { period1, period2, interval: '1d', events: 'history' },
          headers: HEADERS,
          timeout: 25000,
        }
      )
    );
    result = res.data?.chart?.result?.[0];
    if (!result) throw new Error('No long history returned for ' + symbol);
    setCachedChart(key, result);
  }
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return timestamps
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((c) => c.close != null && c.high != null && c.low != null);
}

module.exports = { search, getQuote, getQuoteAndHistory, getHistorical, getLongHistory, getIntradayCandles, getNews, getFundamentals, getEvents, toYahooSymbol, resolveIpoYahooSymbol, getQuoteForIpo, getIntradayCandlesForIpo };
