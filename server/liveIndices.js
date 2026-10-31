/**
 * Live Indian index quotes via Moneycontrol price API (closer to NSE than delayed Yahoo).
 * Used by market regime banner so Today Up/Down matches brokers like Groww.
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Moneycontrol index keys
const INDEX_KEYS = {
  nifty50: 'in;NSX',
  banknifty: 'in;nbx',
  sensex: 'in;SEN',
};

const cache = { data: null, ts: 0 };
const CACHE_MS = 20 * 1000; // 20s

async function fetchOne(key) {
  const url = `https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/${encodeURIComponent(key)}`;
  const res = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  const d = res.data?.data;
  if (!d || d.pricecurrent == null) throw new Error('no index data');
  const price = Number(d.pricecurrent);
  const pChange = d.pricepercentchange != null ? Number(d.pricepercentchange) : null;
  const change = d.pricechange != null ? Number(d.pricechange) : null;
  return {
    lastPrice: price,
    pChange,
    change,
    open: d.OPEN != null ? Number(d.OPEN) : null,
    dayHigh: d.HIGH != null ? Number(d.HIGH) : null,
    dayLow: d.LOW != null ? Number(d.LOW) : null,
    previousClose: d.prevclose != null ? Number(d.prevclose) : (price != null && change != null ? price - change : null),
    oneWeekPct: d['1wk'] != null ? Number(d['1wk']) : null,
    oneMonthPct: d['1mth'] != null ? Number(d['1mth']) : null,
    oneYearPct: d['1yr'] != null ? Number(d['1yr']) : null,
    asOf: d.lastupd ? new Date(d.lastupd.replace(' ', 'T') + '+05:30').toISOString() : new Date().toISOString(),
    marketState: 'REGULAR',
    source: 'moneycontrol',
    name: d.HN || d.shortname || null,
  };
}

async function getLiveIndices(force = false) {
  if (!force && cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;
  const [nifty, bank, sensex] = await Promise.all([
    fetchOne(INDEX_KEYS.nifty50).catch((e) => ({ error: e.message })),
    fetchOne(INDEX_KEYS.banknifty).catch((e) => ({ error: e.message })),
    fetchOne(INDEX_KEYS.sensex).catch((e) => ({ error: e.message })),
  ]);
  const data = {
    nifty50: nifty.error ? null : nifty,
    bankNifty: bank.error ? null : bank,
    sensex: sensex.error ? null : sensex,
    fetchedAt: new Date().toISOString(),
  };
  if (data.nifty50 || data.bankNifty) {
    cache.data = data;
    cache.ts = Date.now();
  }
  return data;
}

function clearLiveIndicesCache() {
  cache.data = null;
  cache.ts = 0;
}

module.exports = { getLiveIndices, clearLiveIndicesCache, fetchOne, INDEX_KEYS };
