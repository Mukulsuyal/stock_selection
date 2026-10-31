// server/dataProviders/upstoxProvider.js
// Upstox API v2 provider - the PRIMARY live-data source when configured.
//
// HONESTY NOTE: this integration is built from Upstox's documented API
// structure, but could not be tested against a live account in this
// environment (no internet access in the build sandbox). It's designed to
// fail safely - any error here (bad/expired token, network issue, unknown
// symbol) throws, and the aggregator (server/dataProviders/aggregator.js)
// catches that and falls back to Yahoo automatically. Nothing else in the
// app breaks if this provider doesn't work. Please test it yourself and
// report back if something needs fixing.
//
// Setup (.env) — pick ONE path:
//
// A) Analytics Access Token (recommended, ~1 year, read-only market data):
//    UPSTOX_ACCESS_TOKEN=eyJ...   // from Upstox → Apps → My Apps → Generate Token
//
// B) OAuth app (daily login ~3:30 AM IST):
//    UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI
//    Then open /api/auth/upstox/login once per day after expiry.
//
const axios = require('axios');
const zlib = require('zlib');
const UpstoxToken = require('./models/UpstoxToken');
const { isMongoConfigured } = require('../mongo');

const NAME = 'upstox';
const RELIABILITY = 'high'; // authenticated broker-grade feed, when it's working

function isEnvConfigured() {
  if (process.env.UPSTOX_ACCESS_TOKEN && String(process.env.UPSTOX_ACCESS_TOKEN).trim().length > 20) return true;
  return Boolean(process.env.UPSTOX_API_KEY && process.env.UPSTOX_API_SECRET && process.env.UPSTOX_REDIRECT_URI);
}

async function isConfigured() {
  if (!isEnvConfigured()) return false;
  // Analytics token needs no Mongo / daily OAuth
  if (process.env.UPSTOX_ACCESS_TOKEN && String(process.env.UPSTOX_ACCESS_TOKEN).trim().length > 20) return true;
  if (!isMongoConfigured()) return false;
  const token = await getStoredToken();
  return Boolean(token);
}

async function getStoredToken() {
  // Prefer long-lived Analytics Access Token from env
  const envTok = (process.env.UPSTOX_ACCESS_TOKEN || '').trim();
  if (envTok.length > 20) return envTok;

  const doc = await UpstoxToken.findOne().sort({ obtainedAt: -1 });
  if (!doc) return null;
  // OAuth tokens expire ~3:30 AM IST daily
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const cycleStart = new Date(nowIst);
  cycleStart.setHours(3, 30, 0, 0);
  if (nowIst < cycleStart) cycleStart.setDate(cycleStart.getDate() - 1);
  const obtainedIst = new Date(doc.obtainedAt.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  if (obtainedIst < cycleStart) return null;
  return doc.accessToken;
}

async function saveToken(accessToken) {
  await UpstoxToken.create({ accessToken, obtainedAt: new Date() });
}

// ---- OAuth helpers (used by server/routes/upstoxAuth.js) ----
function getAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: process.env.UPSTOX_API_KEY,
    redirect_uri: process.env.UPSTOX_REDIRECT_URI,
    response_type: 'code',
  });
  return `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await axios.post(
    'https://api.upstox.com/v2/login/authorization/token',
    new URLSearchParams({
      code, client_id: process.env.UPSTOX_API_KEY, client_secret: process.env.UPSTOX_API_SECRET,
      redirect_uri: process.env.UPSTOX_REDIRECT_URI, grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
  );
  const accessToken = res.data?.access_token;
  if (!accessToken) throw new Error('Upstox did not return an access token');
  await saveToken(accessToken);
  return accessToken;
}

// ---- Instrument key resolution (Upstox needs "NSE_EQ|ISIN", not plain symbols) ----
let instrumentCache = { map: null, fetchedAt: 0 };
const INSTRUMENT_CACHE_MS = 24 * 60 * 60 * 1000; // refresh daily

async function loadInstrumentMap() {
  if (instrumentCache.map && Date.now() - instrumentCache.fetchedAt < INSTRUMENT_CACHE_MS) return instrumentCache.map;
  const res = await axios.get('https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz', {
    responseType: 'arraybuffer', timeout: 20000,
  });
  const json = JSON.parse(zlib.gunzipSync(res.data).toString('utf-8'));
  const map = {};
  for (const inst of json) {
    if (inst.instrument_type === 'EQ' && inst.trading_symbol) {
      map[inst.trading_symbol.toUpperCase()] = inst.instrument_key;
    }
  }
  instrumentCache = { map, fetchedAt: Date.now() };
  return map;
}

async function resolveInstrumentKey(symbol) {
  const map = await loadInstrumentMap();
  const key = map[symbol.toUpperCase().replace(/\.(NS|BO)$/, '')];
  if (!key) throw new Error(`Upstox instrument key not found for ${symbol}`);
  return key;
}

// ---- Live data ----
async function authHeaders() {
  const token = await getStoredToken();
  if (!token) throw new Error('Upstox not authorized - visit /api/auth/upstox/login');
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function parseQuoteEntry(entry) {
  const ohlc = entry.ohlc || {};
  const last = entry.last_price != null ? Number(entry.last_price) : null;
  const net = entry.net_change != null ? Number(entry.net_change) : null;
  // Upstox: ohlc.close is usually prev session close; also may expose percentage fields
  let prev = ohlc.close != null ? Number(ohlc.close) : null;
  if ((prev == null || !Number.isFinite(prev) || prev === 0) && last != null && net != null) {
    prev = last - net;
  }
  let pChange = null;
  if (entry.percentage_change != null && Number.isFinite(Number(entry.percentage_change))) {
    pChange = Number(entry.percentage_change);
  } else if (entry.ohlc && entry.ohlc.close != null && last != null && Number(ohlc.close) > 0) {
    pChange = ((last - Number(ohlc.close)) / Number(ohlc.close)) * 100;
  } else if (prev != null && prev > 0 && last != null) {
    pChange = ((last - prev) / prev) * 100;
  } else if (net != null && prev != null && prev > 0) {
    pChange = (net / prev) * 100;
  }
  // Guard: if API left net_change but prev==last → 0%, still try net/prev
  if ((pChange == null || pChange === 0) && net != null && Math.abs(net) > 0.001 && prev != null && prev > 0) {
    pChange = (net / prev) * 100;
  }
  return {
    lastPrice: last,
    change: net,
    pChange: pChange != null && Number.isFinite(pChange) ? Number(pChange) : null,
    open: ohlc.open != null ? Number(ohlc.open) : null,
    previousClose: prev,
    dayHigh: ohlc.high != null ? Number(ohlc.high) : null,
    dayLow: ohlc.low != null ? Number(ohlc.low) : null,
    weekHigh52: null,
    weekLow52: null,
    volume: entry.volume ?? null,
    marketState: entry.market_status || null,
    asOf: new Date().toISOString(),
  };
}

async function getQuote(symbol) {
  const instrumentKey = await resolveInstrumentKey(symbol);
  const headers = await authHeaders();
  const res = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
    params: { instrument_key: instrumentKey }, headers, timeout: 10000,
  });
  const data = res.data?.data;
  const entry = data ? Object.values(data)[0] : null;
  if (!entry) throw new Error('Upstox returned no quote data');
  return parseQuoteEntry(entry);
}

// Index instruments (Nifty 50, Bank Nifty, India VIX) use a different
// segment ("NSE_INDEX") with fixed, documented instrument keys rather than
// the equity instrument-master lookup used for stocks.
const INDEX_KEYS = {
  '^NSEI': 'NSE_INDEX|Nifty 50',
  '^NSEBANK': 'NSE_INDEX|Nifty Bank',
  '^INDIAVIX': 'NSE_INDEX|India VIX',
};

async function getIndexQuote(symbol) {
  const instrumentKey = INDEX_KEYS[symbol];
  if (!instrumentKey) throw new Error(`No known Upstox index key for ${symbol}`);
  const headers = await authHeaders();
  const res = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
    params: { instrument_key: instrumentKey }, headers, timeout: 10000,
  });
  const data = res.data?.data;
  const entry = data ? Object.values(data)[0] : null;
  if (!entry) throw new Error('Upstox returned no index quote data');
  return parseQuoteEntry(entry);
}

// Historical daily/weekly/monthly candles.
// Upstox v2 historical-candle endpoint: /v2/historical-candle/{instrument_key}/{interval}/{to_date}/{from_date}
// interval: "day" | "week" | "month" (there's also minute-based intervals,
// handled separately below for intraday).
async function getHistorical(symbol, days = 1260) {
  const instrumentKey = symbol.startsWith('^') ? INDEX_KEYS[symbol] : await resolveInstrumentKey(symbol);
  if (!instrumentKey) throw new Error(`No Upstox instrument key for ${symbol}`);
  const headers = await authHeaders();
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${toDate}/${fromDate}`;
  const res = await axios.get(url, { headers, timeout: 15000 });
  const rows = res.data?.data?.candles || [];
  // Upstox candle format: [timestamp, open, high, low, close, volume, oi]
  return rows
    .map((c) => ({ date: c[0].slice(0, 10), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .filter((c) => c.close != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-days);
}

// Intraday candles (today's session only - Upstox's intraday endpoint only
// covers the current trading day, unlike Yahoo which keeps ~60 days).
// interval: "1minute" | "30minute" (Upstox v2 intraday-candle options).
async function getIntradayCandles(symbol, interval = '30minute') {
  const instrumentKey = symbol.startsWith('^') ? INDEX_KEYS[symbol] : await resolveInstrumentKey(symbol);
  if (!instrumentKey) throw new Error(`No Upstox instrument key for ${symbol}`);
  const headers = await authHeaders();
  const url = `https://api.upstox.com/v2/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${interval}`;
  const res = await axios.get(url, { headers, timeout: 15000 });
  const rows = res.data?.data?.candles || [];
  return rows
    .map((c) => ({ date: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .filter((c) => c.close != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// FII/DII: Upstox's public Developer API does not document a dedicated
// FII/DII endpoint (it's broker infrastructure for trading/quotes, not a
// source for NSE's published institutional-flow statistics). Rather than
// guess at an endpoint that may not exist, FII/DII stays sourced from NSE
// directly (server/institutional/fiiDiiCollector.js) - unchanged by this.

module.exports = {
  name: NAME, reliability: RELIABILITY, isConfigured,
  getQuote, getIndexQuote, getHistorical, getIntradayCandles,
  getAuthorizeUrl, exchangeCodeForToken, INDEX_KEYS,
};
