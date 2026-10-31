// server/institutional/bulkDealsCollector.js
// Free, real, per-stock proxy for "who's buying/selling this stock in
// size" - see server/institutional/models/BulkDeal.js for what this is
// (and isn't). Uses the same NSE session/cookie mechanism as the FII/DII
// collector (server/institutional/nseSession.js), so it's subject to the
// same known limitation: NSE aggressively blocks many server/cloud IPs
// with 401/403. When that happens this fails cleanly (logs and returns
// { ok: false }) rather than fabricating numbers - there's no free
// community mirror for stock-level bulk-deal data the way there is for
// aggregate FII/DII, so this one genuinely depends on NSE being reachable
// from wherever the app is hosted.
const { nseGet } = require('./nseSession');
const BulkDeal = require('./models/BulkDeal');
const { isMongoConfigured } = require('../mongo');

function parseNseDate(str) {
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = (str || '').match(/(\d{1,2})-(\w{3})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${months[m[2]] || '01'}-${m[1].padStart(2, '0')}`;
}

async function fetchBulkDealsToday() {
  const data = await nseGet('/api/snapshot-capital-market-largedeal?bandtype=bulk_deals');
  // NSE's own field names for this endpoint have shifted before -
  // tolerate a couple of shapes rather than assume one exact structure.
  const rows = data?.BULK_DEALS_DATA || data?.data || data?.BULK_DEALS || [];
  if (!Array.isArray(rows)) throw new Error('Unexpected response shape from NSE bulk-deals endpoint');

  return rows
    .map((d) => ({
      date: parseNseDate(d.BD_DT_DATE || d.date || d.mTIMESTAMP),
      symbol: (d.BD_SYMBOL || d.symbol || '').toUpperCase(),
      clientName: (d.BD_CLIENT_NAME || d.clientName || 'Unknown').trim(),
      dealType: (d.BD_BUY_SELL || d.buySell || '').toUpperCase().startsWith('B') ? 'BUY' : 'SELL',
      quantity: Number(d.BD_QTY_TRD || d.qty) || 0,
      price: Number(d.BD_TP_WATP || d.price) || 0,
    }))
    .filter((d) => d.date && d.symbol && d.quantity > 0);
}

async function collectBulkDeals() {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  try {
    const rows = await fetchBulkDealsToday();
    if (!rows.length) {
      console.log('[bulkDealsCollector] No bulk deals reported today (a genuinely quiet day is normal, not an error).');
      return { ok: true, rows: 0 };
    }
    for (const row of rows) {
      await BulkDeal.updateOne(
        { date: row.date, symbol: row.symbol, clientName: row.clientName, dealType: row.dealType, quantity: row.quantity },
        { $setOnInsert: { ...row, fetchedAt: new Date() } },
        { upsert: true }
      );
    }
    console.log(`[bulkDealsCollector] stored ${rows.length} bulk-deal row(s) for ${rows[0].date}`);
    return { ok: true, rows: rows.length, date: rows[0].date };
  } catch (err) {
    console.error('[bulkDealsCollector] failed (NSE bulk-deals endpoint blocked/unavailable from this host):', err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { collectBulkDeals };
