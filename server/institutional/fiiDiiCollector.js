// server/institutional/fiiDiiCollector.js
// Fetches daily FII/DII cash-market buy/sell/net figures and stores them in
// MongoDB. Runs daily via cron (see server.js) and is safe to re-run -
// duplicate (date, category) rows are prevented by a unique index, using
// upsert.
//
// TWO SOURCES, in order:
//  1. NSE India's own unofficial endpoint (most direct, but NSE
//     aggressively blocks many server/cloud IPs with 401/403 - a
//     well-known limitation, not a bug here).
//  2. A free community-run mirror (chirag127/fii-dii-activity-api) that
//     itself scrapes NSE -> Groww -> Moneycontrol with validation, and
//     publishes the result as static JSON on GitHub Pages + CDN mirrors
//     (jsDelivr/Statically) - since it's just static files on GitHub's own
//     CDN, it isn't subject to NSE's server-IP blocking at all. It's a
//     small third-party hobby project (MIT licensed, source on GitHub), so
//     treat it as a "best-effort free fallback", not an official feed -
//     it updates once/day (~18:30 IST, after NSE close) and could go
//     offline if the maintainer stops running it.
const { nseGet } = require('./nseSession');
const axios = require('axios');
const FiiDiiFlow = require('./models/FiiDiiFlow');
const { isMongoConfigured } = require('../mongo');

// NSE dates come as "08-Sep-2026" - convert to "2026-09-08"
function parseNseDate(str) {
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = str.match(/(\d{1,2})-(\w{3})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${months[m[2]] || '01'}-${m[1].padStart(2, '0')}`;
}

function normalizeCategory(raw) {
  const s = (raw || '').toUpperCase();
  if (s.includes('DII')) return 'DII';
  if (s.includes('FII') || s.includes('FPI')) return 'FII';
  return null;
}

async function fetchFiiDiiFromNse() {
  // This is NSE's unofficial (but widely used) endpoint for daily
  // provisional FII/DII cash-market activity.
  const data = await nseGet('/api/fiidiiTradeReact');
  if (!Array.isArray(data)) throw new Error('Unexpected response shape from NSE FII/DII endpoint');

  const rows = [];
  for (const item of data) {
    const category = normalizeCategory(item.category);
    const date = parseNseDate(item.date);
    const buyValueCr = Number(item.buyValue);
    const sellValueCr = Number(item.sellValue);
    const netValueCr = Number(item.netValue);
    if (!category || !date || isNaN(buyValueCr) || isNaN(sellValueCr) || isNaN(netValueCr)) continue;
    rows.push({ category, date, buyValueCr, sellValueCr, netValueCr, source: 'NSE' });
  }
  return rows;
}

// Free community mirror - static JSON, no key, no bot-blocking (it's just
// files on GitHub's CDN). Response shape:
// { date, source: 'nse'|'groww'|'moneycontrol'|'placeholder',
//   equity: { fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net } }
const COMMUNITY_MIRROR_URLS = [
  'https://cdn.jsdelivr.net/gh/chirag127/fii-dii-activity-api@main/data/latest.json',
  'https://raw.githubusercontent.com/chirag127/fii-dii-activity-api/main/data/latest.json',
  'https://chirag127.github.io/fii-dii-activity-api/data/latest.json',
];

async function fetchFiiDiiFromCommunityMirror() {
  let lastErr;
  for (const url of COMMUNITY_MIRROR_URLS) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      const data = res.data;
      if (!data || !data.equity || data.source === 'placeholder') throw new Error('Community mirror has no usable data yet for today');
      const { date, equity, source } = data;
      const tag = `community-mirror(${source})`;
      return [
        { category: 'FII', date, buyValueCr: equity.fii_buy, sellValueCr: equity.fii_sell, netValueCr: equity.fii_net, source: tag },
        { category: 'DII', date, buyValueCr: equity.dii_buy, sellValueCr: equity.dii_sell, netValueCr: equity.dii_net, source: tag },
      ];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All community mirror URLs failed');
}

async function collectFiiDii() {
  if (!isMongoConfigured()) {
    console.warn('[fiiDiiCollector] MONGODB_URL not set, skipping.');
    return { ok: false, reason: 'mongo_not_configured' };
  }

  let rows = [];
  let usedSource = null;
  try {
    rows = await fetchFiiDiiFromNse();
    if (rows.length) usedSource = 'nse-direct';
  } catch (err) {
    console.warn('[fiiDiiCollector] NSE direct fetch failed, trying community mirror:', err.message);
  }

  if (!rows.length) {
    try {
      rows = await fetchFiiDiiFromCommunityMirror();
      usedSource = 'community-mirror';
    } catch (err) {
      console.error('[fiiDiiCollector] failed (both NSE and community mirror):', err.message);
      return { ok: false, reason: err.message };
    }
  }

  if (!rows.length) {
    console.warn('[fiiDiiCollector] No usable rows today from any source.');
    return { ok: false, reason: 'no_data' };
  }

  for (const row of rows) {
    await FiiDiiFlow.updateOne(
      { date: row.date, category: row.category },
      { $set: { ...row, fetchedAt: new Date() } },
      { upsert: true }
    );
  }
  console.log(`[fiiDiiCollector] stored ${rows.length} row(s) for ${rows[0].date} (via ${usedSource})`);
  return { ok: true, rows: rows.length, date: rows[0].date, source: usedSource };
}

module.exports = { collectFiiDii };
