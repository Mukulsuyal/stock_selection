// server/institutional/routes.js
// The 5 endpoints. Where real free data exists (FII/DII, sector mapping),
// it's used. Where it genuinely doesn't (MF holdings-change, FII/DII
// sector-level positioning, quarterly shareholding change) - this returns
// an explicit `not_available` status with a reason, never a fabricated
// number, per the "no fake data" requirement.
const express = require('express');
const router = express.Router();
const { isMongoConfigured } = require('../mongo');
const { getFiiDiiAggregate, getFiiDiiAllPeriods, VALID_PERIODS, getTopBulkDealStocks, getSectorBulkDealActivity } = require('./aggregations');
const { getSectorMap } = require('./sectorSync');
const MfHoldingChange = require('./models/MfHoldingChange');
const ShareholdingChange = require('./models/ShareholdingChange');
const { requireAuth, requireFeature } = require('../auth');

function requireMongo(req, res, next) {
  if (!isMongoConfigured()) {
    return res.status(503).json({ error: 'MongoDB is not configured (MONGODB_URL missing) - institutional data feature is disabled.' });
  }
  next();
}

router.use(requireAuth, requireFeature('institutional'));
router.use(requireMongo);

function validatePeriod(period) {
  return VALID_PERIODS.includes(period) ? period : '1M';
}

// GET /api/institutional/overview
// Real data: FII/DII cash-market flow across every standard period.
router.get('/overview', async (req, res) => {
  try {
    const fiiDii = await getFiiDiiAllPeriods();

    // Latest single trading day (LIVE/daily flow — not holdings)
    let latestDay = null;
    try {
      const FiiDiiFlow = require('./models/FiiDiiFlow');
      const lastDate = await FiiDiiFlow.findOne({}).sort({ date: -1 }).select('date fetchedAt source').lean();
      if (lastDate?.date) {
        const dayRows = await FiiDiiFlow.find({ date: lastDate.date }).lean();
        const fii = dayRows.find((r) => r.category === 'FII');
        const dii = dayRows.find((r) => r.category === 'DII');
        latestDay = {
          date: lastDate.date,
          fetchedAt: lastDate.fetchedAt || null,
          source: lastDate.source || 'NSE',
          fiiNetCr: fii?.netValueCr ?? null,
          diiNetCr: dii?.netValueCr ?? null,
          fiiBuyCr: fii?.buyValueCr ?? null,
          fiiSellCr: fii?.sellValueCr ?? null,
          diiBuyCr: dii?.buyValueCr ?? null,
          diiSellCr: dii?.sellValueCr ?? null,
          totalNetCr: (fii?.netValueCr ?? 0) + (dii?.netValueCr ?? 0),
        };
      }
    } catch (_) {}

    // Period summary cards for UI
    const periods = {};
    for (const [p, row] of Object.entries(fiiDii || {})) {
      const fiiNet = row?.fii?.netValueCr ?? null;
      const diiNet = row?.dii?.netValueCr ?? null;
      const total = (fiiNet != null || diiNet != null)
        ? Number(((fiiNet || 0) + (diiNet || 0)).toFixed(2))
        : null;
      periods[p] = {
        fiiNetCr: fiiNet,
        diiNetCr: diiNet,
        mfNetCr: null, // never invent — DII includes MF as largest SEBI component
        totalInstitutionalCr: total,
        fiiBuyCr: row?.fii?.buyValueCr ?? null,
        fiiSellCr: row?.fii?.sellValueCr ?? null,
        diiBuyCr: row?.dii?.buyValueCr ?? null,
        diiSellCr: row?.dii?.sellValueCr ?? null,
        tradingDays: Math.max(row?.fii?.tradingDays || 0, row?.dii?.tradingDays || 0),
        from: row?.from,
        to: row?.to,
        dataPointsFound: row?.dataPointsFound ?? 0,
      };
    }

    // Simple sentiment from 1M + 1W nets (daily flow, not holdings)
    const w = periods['1W'] || {};
    const m = periods['1M'] || {};
    const score =
      (w.fiiNetCr || 0) * 0.35 +
      (w.diiNetCr || 0) * 0.25 +
      (m.fiiNetCr || 0) * 0.25 +
      (m.diiNetCr || 0) * 0.15;
    let sentiment = 'Mixed';
    let signal = 'Neutral';
    if (score >= 2500) { sentiment = 'Bullish'; signal = 'Strong Accumulation'; }
    else if (score >= 500) { sentiment = 'Bullish'; signal = 'Accumulation'; }
    else if (score <= -2500) { sentiment = 'Bearish'; signal = 'Strong Distribution'; }
    else if (score <= -500) { sentiment = 'Bearish'; signal = 'Distribution'; }

    res.json({
      fiiDii, // legacy shape preserved
      periods, // UI cards
      latestDay,
      sentiment: {
        label: sentiment,
        institutionalSignal: signal,
        scoreHint: Number(score.toFixed(0)),
        basis: 'Weighted FII/DII net from 1W + 1M daily cash-market flow (₹ Cr). Not holdings.',
      },
      mutualFunds: {
        status: 'not_available',
        netCr: null,
        reason: 'AMFI does not publish a stable free machine-readable MF net-inflow JSON feed. DII cash-market flow already includes mutual funds as the largest SEBI-classified DII component — use DII as aggregate MF proxy only, not stock-level MF buying.',
      },
      shareholding: {
        status: 'not_available',
        reason: 'Quarterly shareholding pattern is per-company BSE/NSE filings (PDF/XBRL), not a free bulk API. Not invented.',
      },
      dataClass: {
        dailyFlow: 'LIVE/daily NSE FII-DII cash market (provisional)',
        bulkDeals: 'NSE bulk-deal disclosures (0.5% threshold) — not full institutional book',
        holdings: 'MONTHLY/QUARTERLY — not available free; never shown as live buying',
      },
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load institutional overview' });
  }
});

router.get('/sector-flow', async (req, res) => {
  try {
    const period = validatePeriod(req.query.period);
    const [fiiDii, sectorMap] = await Promise.all([getFiiDiiAggregate(period), getSectorMap()]);
    const bulkDealActivity = await getSectorBulkDealActivity(period, sectorMap);
    const bulkBySector = Object.fromEntries(bulkDealActivity.sectors.map((s) => [s.sector, s]));

    const allSectors = [...new Set(Object.values(sectorMap))].filter((s) => s && s !== 'Unknown').sort();
    const rows = allSectors.map((sector) => ({
      sector,
      bulkDealActivity: bulkBySector[sector]
        ? { buyValueCr: bulkBySector[sector].buyValueCr, sellValueCr: bulkBySector[sector].sellValueCr, netValueCr: bulkBySector[sector].netValueCr, dealCount: bulkBySector[sector].dealCount }
        : { buyValueCr: 0, sellValueCr: 0, netValueCr: 0, dealCount: 0 },
      mfFlow: 'not_available',
      fiiPositioning: 'not_available',
      diiPositioning: 'not_available',
      publicChange: 'not_available',
    }));

    res.json({
      period,
      marketWideFiiDii: fiiDii, // real
      sectors: rows.sort((a, b) => b.bulkDealActivity.netValueCr - a.bulkDealActivity.netValueCr),
      note: 'bulkDealActivity is real (NSE Bulk Deals, aggregated by sector via our symbol->sector map) but only reflects unusually large disclosed single-client trades, not full institutional positioning. mfFlow/fiiPositioning/diiPositioning/publicChange remain honestly not_available - they would need per-stock ownership data not available for free.',
    });
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/institutional/stock-flow?period=1M
router.get('/stock-flow', async (req, res) => {
  try {
    const period = validatePeriod(req.query.period);
    const symbols = (req.query.symbols ? String(req.query.symbols).split(',') : []).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return res.status(400).json({ error: 'Pass ?symbols=RELIANCE,TCS,... (comma separated)' });

    const [mfDocs, shDocs] = await Promise.all([
      MfHoldingChange.find({ symbol: { $in: symbols } }).lean(),
      ShareholdingChange.find({ symbol: { $in: symbols } }).lean(),
    ]);
    const mfBySymbol = Object.fromEntries(mfDocs.map((d) => [d.symbol, d]));
    const shBySymbol = Object.fromEntries(shDocs.map((d) => [d.symbol, d]));

    const rows = symbols.map((symbol) => ({
      symbol,
      period,
      mfHoldingChange: mfBySymbol[symbol]
        ? { changeType: mfBySymbol[symbol].changeType, quantityChange: mfBySymbol[symbol].quantityChange, month: mfBySymbol[symbol].month }
        : { status: 'not_available', reason: 'No MF portfolio-disclosure collector wired yet (see server/institutional/models/MfHoldingChange.js).' },
      shareholdingChange: shBySymbol[symbol]
        ? { publicPctChange: shBySymbol[symbol].publicPctChange, fiiPctChange: shBySymbol[symbol].fiiPctChange, diiPctChange: shBySymbol[symbol].diiPctChange, quarter: shBySymbol[symbol].quarter }
        : { status: 'not_available', reason: 'No quarterly shareholding-pattern collector wired yet.' },
    }));

    res.json({ period, stocks: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load stock-level flow' });
  }
});

// GET /api/institutional/top-buyers?period=1M
// Real data: which stocks had the most NSE Bulk Deals (large disclosed
// single-client trades) net-bought over this period. NOT the same as full
// FII/DII stock-level positioning (that's not free anywhere) - this is the
// closest legitimate free per-stock proxy: a real, named, disclosed
// large-trade record.
router.get('/top-buyers', async (req, res) => {
  try {
    const period = validatePeriod(req.query.period);
    const { topBuys, dataPointsFound, from, to } = await getTopBulkDealStocks(period);
    res.json({
      period, from, to,
      buyers: topBuys,
      status: dataPointsFound ? 'ok' : 'no_data',
      source: 'NSE Bulk Deals (large disclosed single-client trades only, not full institutional flow)',
      reason: dataPointsFound ? undefined : 'No bulk deals collected for this period yet - either none were large enough to disclose, or the NSE bulk-deals collector couldn\'t reach NSE (see server/institutional/bulkDealsCollector.js).',
    });
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/institutional/top-sellers?period=1M
router.get('/top-sellers', async (req, res) => {
  try {
    const period = validatePeriod(req.query.period);
    const { topSells, dataPointsFound, from, to } = await getTopBulkDealStocks(period);
    res.json({
      period, from, to,
      sellers: topSells,
      status: dataPointsFound ? 'ok' : 'no_data',
      source: 'NSE Bulk Deals (large disclosed single-client trades only, not full institutional flow)',
      reason: dataPointsFound ? undefined : 'No bulk deals collected for this period yet - either none were large enough to disclose, or the NSE bulk-deals collector couldn\'t reach NSE (see server/institutional/bulkDealsCollector.js).',
    });
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
