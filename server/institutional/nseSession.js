// server/institutional/nseSession.js
// Minimal NSE India session-cookie fetcher, used ONLY by the institutional
// FII/DII collector. Kept separate from server/marketData.js (which uses
// Yahoo Finance for everything else) because NSE is the only free source
// for FII/DII cash-market activity - Yahoo doesn't have it.
//
// CAVEAT (same as before, being upfront about it): NSE's unofficial API
// blocks/rate-limits many server IPs. This collector retries with backoff
// and fails gracefully (logs + skips that day) rather than crashing -
// check server logs if FII/DII data stops updating.
const axios = require('axios');

const BASE = 'https://www.nseindia.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nseindia.com/',
};

let cookieJar = '';
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 5 * 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function refreshSession() {
  const res = await axios.get(BASE, { headers: HEADERS, timeout: 10000 });
  const setCookie = res.headers['set-cookie'] || [];
  cookieJar = setCookie.map((c) => c.split(';')[0]).join('; ');
  cookieFetchedAt = Date.now();
  return cookieJar;
}

async function nseGet(pathAndQuery, attempts = 3) {
  if (!cookieJar || Date.now() - cookieFetchedAt > COOKIE_TTL_MS) {
    await refreshSession();
  }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.get(`${BASE}${pathAndQuery}`, { headers: { ...HEADERS, Cookie: cookieJar }, timeout: 10000 });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        await refreshSession();
      }
      await sleep((status === 429 ? 2000 : 500) * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { nseGet };
