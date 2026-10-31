/**
 * Option chain fetch — NSE public API best-effort; fails soft (no crash).
 */
const axios = require('axios');
const { setLotFallback } = require('./instruments');

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/option-chain',
};

let cookieJar = '';
let cookieAt = 0;

async function warmNseCookies() {
  if (cookieJar && Date.now() - cookieAt < 10 * 60 * 1000) return cookieJar;
  try {
    const res = await axios.get('https://www.nseindia.com', {
      headers: NSE_HEADERS,
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const set = res.headers['set-cookie'];
    if (set) {
      cookieJar = set.map((c) => c.split(';')[0]).join('; ');
      cookieAt = Date.now();
    }
  } catch (_) {}
  return cookieJar;
}

async function fetchNseOptionChain(nseSymbol) {
  await warmNseCookies();
  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(nseSymbol)}`;
  try {
    const res = await axios.get(url, {
      headers: { ...NSE_HEADERS, Cookie: cookieJar || '' },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });
    if (res.status !== 200 || !res.data?.records) {
      return { ok: false, error: `NSE chain HTTP ${res.status}`, raw: null };
    }
    return { ok: true, raw: res.data, error: null };
  } catch (err) {
    return { ok: false, error: err.message, raw: null };
  }
}

function parseChain(raw, spot) {
  if (!raw?.records) return null;
  const records = raw.records;
  const expiryDates = records.expiryDates || [];
  const data = records.data || [];
  const timestamp = records.timestamp || null;

  // Infer lot from any CE/PE if present
  for (const row of data) {
    const lot = row.CE?.marketLot || row.PE?.marketLot;
    if (lot) break;
  }

  const byExpiry = {};
  for (const row of data) {
    const exp = row.expiryDate;
    if (!exp) continue;
    if (!byExpiry[exp]) byExpiry[exp] = { calls: [], puts: [], strikes: [] };
    if (row.CE) {
      byExpiry[exp].calls.push(normalizeSide(row.CE, row.strikePrice, 'CE'));
      byExpiry[exp].strikes.push(row.strikePrice);
    }
    if (row.PE) {
      byExpiry[exp].puts.push(normalizeSide(row.PE, row.strikePrice, 'PE'));
      byExpiry[exp].strikes.push(row.strikePrice);
    }
  }

  const expiries = expiryDates.length ? expiryDates : Object.keys(byExpiry);
  return {
    spot: records.underlyingValue ?? spot,
    expiries,
    byExpiry,
    timestamp,
    source: 'nse',
  };
}

function normalizeSide(leg, strike, side) {
  return {
    side,
    strike: Number(strike),
    oi: Number(leg.openInterest) || 0,
    chgOi: Number(leg.changeinOpenInterest) || 0,
    volume: Number(leg.totalTradedVolume) || 0,
    iv: Number(leg.impliedVolatility) || null,
    ltp: Number(leg.lastPrice) || null,
    bid: Number(leg.bidprice) || null,
    ask: Number(leg.askPrice) || null,
    bidQty: Number(leg.bidQty) || 0,
    askQty: Number(leg.askQty) || 0,
    lot: Number(leg.marketLot) || null,
  };
}

function pickBestExpiry(chain, { preferWeekly = true } = {}) {
  if (!chain?.expiries?.length) return null;
  // First expiry = nearest (NSE lists chronological)
  return chain.expiries[0];
}

function computePcr(expiryBucket) {
  if (!expiryBucket) return null;
  const callOi = expiryBucket.calls.reduce((s, c) => s + (c.oi || 0), 0);
  const putOi = expiryBucket.puts.reduce((s, p) => s + (p.oi || 0), 0);
  if (callOi <= 0) return null;
  return Number((putOi / callOi).toFixed(3));
}

function nearestStrike(strikes, spot) {
  if (!strikes?.length || spot == null) return null;
  const uniq = [...new Set(strikes)].sort((a, b) => a - b);
  return uniq.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), uniq[0]);
}

function summarizeExpiry(chain, expiry, spot) {
  const bucket = chain.byExpiry[expiry];
  if (!bucket) return null;
  const atm = nearestStrike(bucket.strikes, spot);
  const pcr = computePcr(bucket);
  const atmCe = bucket.calls.find((c) => c.strike === atm);
  const atmPe = bucket.puts.find((p) => p.strike === atm);

  // Max OI strikes (support/resistance style)
  const maxCallOi = bucket.calls.slice().sort((a, b) => b.oi - a.oi)[0];
  const maxPutOi = bucket.puts.slice().sort((a, b) => b.oi - a.oi)[0];

  // Liquidity: ATM spread
  function spreadPct(leg) {
    if (!leg || leg.bid == null || leg.ask == null || leg.ltp <= 0) return null;
    if (leg.ask <= 0) return null;
    return ((leg.ask - leg.bid) / ((leg.ask + leg.bid) / 2 || 1)) * 100;
  }

  // Build candidate strikes ATM / slightly OTM
  const candidates = [];
  for (const ce of bucket.calls) {
    if (Math.abs(ce.strike - spot) / spot > 0.03) continue;
    candidates.push({ ...ce, moneyness: ce.strike <= spot ? 'ITM/ATM' : 'OTM' });
  }
  for (const pe of bucket.puts) {
    if (Math.abs(pe.strike - spot) / spot > 0.03) continue;
    candidates.push({ ...pe, moneyness: pe.strike >= spot ? 'ITM/ATM' : 'OTM' });
  }

  // Infer lot
  const lot = atmCe?.lot || atmPe?.lot || bucket.calls.find((c) => c.lot)?.lot || null;

  return {
    expiry,
    atm,
    pcr,
    atmCe,
    atmPe,
    maxCallOiStrike: maxCallOi?.strike ?? null,
    maxPutOiStrike: maxPutOi?.strike ?? null,
    atmCeSpreadPct: spreadPct(atmCe),
    atmPeSpreadPct: spreadPct(atmPe),
    candidates,
    lot,
    rows: buildUiRows(bucket),
  };
}

function buildUiRows(bucket) {
  if (!bucket) return [];
  const strikes = [...new Set([...(bucket.calls || []).map((c) => c.strike), ...(bucket.puts || []).map((p) => p.strike)])].sort((a, b) => a - b);
  return strikes.map((k) => ({
    strike: k,
    CE: bucket.calls.find((c) => c.strike === k) || null,
    PE: bucket.puts.find((p) => p.strike === k) || null,
  }));
}

module.exports = {
  fetchNseOptionChain,
  parseChain,
  pickBestExpiry,
  summarizeExpiry,
  buildUiRows,
};
