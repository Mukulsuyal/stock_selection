// server/institutional/aggregations.js
// Period-based aggregation of the real FII/DII + Bulk Deals data we
// actually have.
const FiiDiiFlow = require('./models/FiiDiiFlow');
const BulkDeal = require('./models/BulkDeal');

const PERIOD_DAYS = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
const VALID_PERIODS = [...Object.keys(PERIOD_DAYS), 'YTD'];

function fromDateFor(period) {
  const today = new Date();
  if (period === 'YTD') return `${today.getFullYear()}-01-01`;
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  const d = new Date(today);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function getFiiDiiAggregate(period) {
  const fromDate = fromDateFor(period);
  if (!fromDate) throw new Error(`Invalid period "${period}". Use one of: ${VALID_PERIODS.join(', ')}`);
  const toDate = new Date().toISOString().slice(0, 10);

  const rows = await FiiDiiFlow.find({ date: { $gte: fromDate, $lte: toDate } }).sort({ date: 1 }).lean();

  const blank = () => ({ buyValueCr: 0, sellValueCr: 0, netValueCr: 0, tradingDays: 0 });
  const byCategory = { FII: blank(), DII: blank() };
  rows.forEach((r) => {
    const b = byCategory[r.category];
    if (!b) return;
    b.buyValueCr += r.buyValueCr;
    b.sellValueCr += r.sellValueCr;
    b.netValueCr += r.netValueCr;
    b.tradingDays += 1;
  });

  return {
    period, from: fromDate, to: toDate,
    fii: { ...byCategory.FII, buyValueCr: round2(byCategory.FII.buyValueCr), sellValueCr: round2(byCategory.FII.sellValueCr), netValueCr: round2(byCategory.FII.netValueCr) },
    dii: { ...byCategory.DII, buyValueCr: round2(byCategory.DII.buyValueCr), sellValueCr: round2(byCategory.DII.sellValueCr), netValueCr: round2(byCategory.DII.netValueCr) },
    dataPointsFound: rows.length,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

async function getFiiDiiAllPeriods() {
  const results = {};
  for (const period of VALID_PERIODS) {
    results[period] = await getFiiDiiAggregate(period);
  }
  return results;
}

// Aggregates NSE Bulk Deals (see models/BulkDeal.js) into "top stocks by
// disclosed bulk-buy/sell value" over a period. Real, named disclosures -
// but only trades large enough to cross NSE's 0.5%-of-shares disclosure
// threshold get reported this way, so this undercounts smaller
// institutional activity rather than showing the full picture.
async function getTopBulkDealStocks(period, limit = 15) {
  const fromDate = fromDateFor(period);
  if (!fromDate) throw new Error(`Invalid period "${period}". Use one of: ${VALID_PERIODS.join(', ')}`);
  const toDate = new Date().toISOString().slice(0, 10);
  const rows = await BulkDeal.find({ date: { $gte: fromDate, $lte: toDate } }).lean();

  const bySymbol = {};
  rows.forEach((d) => {
    const s = bySymbol[d.symbol] || { symbol: d.symbol, buyValueCr: 0, sellValueCr: 0, buyCount: 0, sellCount: 0 };
    const valueCr = (d.quantity * d.price) / 1e7; // paise->rupees not needed, price already ₹; quantity*price = ₹, /1e7 = ₹ crore
    if (d.dealType === 'BUY') { s.buyValueCr += valueCr; s.buyCount += 1; }
    else { s.sellValueCr += valueCr; s.sellCount += 1; }
    bySymbol[d.symbol] = s;
  });

  const list = Object.values(bySymbol).map((s) => ({
    symbol: s.symbol,
    buyValueCr: round2(s.buyValueCr), sellValueCr: round2(s.sellValueCr),
    netValueCr: round2(s.buyValueCr - s.sellValueCr),
    buyCount: s.buyCount, sellCount: s.sellCount,
  }));

  return {
    period, from: fromDate, to: toDate,
    topBuys: [...list].sort((a, b) => b.netValueCr - a.netValueCr).slice(0, limit),
    topSells: [...list].sort((a, b) => a.netValueCr - b.netValueCr).slice(0, limit),
    dataPointsFound: rows.length,
  };
}

// Same bulk-deal data, aggregated by sector (via the existing symbol-sector
// map from server/institutional/sectorSync.js) instead of by stock.
async function getSectorBulkDealActivity(period, sectorMap) {
  const fromDate = fromDateFor(period);
  if (!fromDate) throw new Error(`Invalid period "${period}". Use one of: ${VALID_PERIODS.join(', ')}`);
  const toDate = new Date().toISOString().slice(0, 10);
  const rows = await BulkDeal.find({ date: { $gte: fromDate, $lte: toDate } }).lean();

  const bySector = {};
  rows.forEach((d) => {
    const sector = sectorMap[d.symbol];
    if (!sector || sector === 'Unknown') return;
    const s = bySector[sector] || { sector, buyValueCr: 0, sellValueCr: 0, dealCount: 0 };
    const valueCr = (d.quantity * d.price) / 1e7;
    if (d.dealType === 'BUY') s.buyValueCr += valueCr; else s.sellValueCr += valueCr;
    s.dealCount += 1;
    bySector[sector] = s;
  });

  return {
    period, from: fromDate, to: toDate,
    sectors: Object.values(bySector)
      .map((s) => ({ ...s, buyValueCr: round2(s.buyValueCr), sellValueCr: round2(s.sellValueCr), netValueCr: round2(s.buyValueCr - s.sellValueCr) }))
      .sort((a, b) => b.netValueCr - a.netValueCr),
    dataPointsFound: rows.length,
  };
}

module.exports = { getFiiDiiAggregate, getFiiDiiAllPeriods, VALID_PERIODS, getTopBulkDealStocks, getSectorBulkDealActivity };
