// IPO Listing Day Entry — separate module from regular stock recommendations.
const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const { isMongoConfigured } = require('../mongo');
const marketData = require('../marketData');
const { getMarketTrend } = require('../marketTrend');
const { analyzeIpoListingDay } = require('../ipo/ipoAnalysisEngine');
const IpoWatch = require('../models/IpoWatch');
const { fetchIpoCalendarBoard } = require('../ipo/ipoCalendar');

router.use(requireAuth);
// IPO is a separate product surface; any approved user can use it.
// Admin can still hide the tab via permissions.ipo if set false.
router.use((req, res, next) => {
  if (req.user?.role === 'admin') return next();
  if (req.user?.permissions && req.user.permissions.ipo === false) {
    return res.status(403).json({ error: 'IPO Day access is disabled for your account.', feature: 'ipo' });
  }
  next();
});


async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function fetchIpoLiveBundle(symbol, companyName = null) {
  const sym = String(symbol).toUpperCase().replace(/\.(NS|BO)$/i, '').replace(/-SM$/i, '');
  let quote = null;
  let intraday = [];
  let quoteError = null;

  // Prefer IPO-aware resolver (SME -SM.NS, search spelling fixes). Fresh
  // listings often 404 on plain SYMBOL.NS for the first minutes/hours.
  try {
    if (typeof marketData.getQuoteForIpo === 'function') {
      quote = await marketData.getQuoteForIpo(sym, companyName);
    } else {
      quote = await marketData.getQuote(sym);
    }
  } catch (err) {
    quoteError = err.message;
    // Fallback: plain getQuote once more
    try {
      quote = await marketData.getQuote(sym);
      quoteError = null;
    } catch (err2) {
      quoteError = err2.message || quoteError;
    }
  }

  try {
    if (typeof marketData.getIntradayCandlesForIpo === 'function') {
      intraday = await marketData.getIntradayCandlesForIpo(sym, companyName);
    } else if (typeof marketData.getIntradayCandles === 'function') {
      intraday = await marketData.getIntradayCandles(sym, '1d', '5m');
    }
  } catch (_) {
    try {
      const hist = await marketData.getHistorical(sym, 5);
      intraday = hist || [];
    } catch (__) {}
  }

  return {
    symbol: sym,
    quote,
    intradayCandles: intraday || [],
    quoteError,
    yahooSymbol: quote?.yahooSymbol || null,
  };
}

// POST /api/ipo/analyze
// Body: { symbol, issuePrice, listingOpen?, listingDate?, companyName? }
router.post('/analyze', async (req, res) => {
  try {
    const symbol = (req.body.symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
    const issuePrice = Number(req.body.issuePrice);
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    if (!issuePrice || issuePrice <= 0) return res.status(400).json({ error: 'Valid issuePrice required' });

    const { quote, intradayCandles } = await fetchIpoLiveBundle(symbol);
    const marketContext = await getMarketTrend().catch(() => null);

    const analysis = analyzeIpoListingDay({
      symbol,
      issuePrice,
      listingOpen: req.body.listingOpen != null ? Number(req.body.listingOpen) : null,
      quote,
      intradayCandles,
      marketContext,
      sectorContext: null,
    });

    // Optionally persist last signal if this IPO is on user's watch
    if (isMongoConfigured()) {
      try {
        await IpoWatch.updateSignal(req.user.id, symbol, {
          signal: analysis.signal,
          confidence: analysis.confidence,
        });
      } catch (_) {}
    }

    res.json({ analysis, quote });
  } catch (err) {
    console.error('[ipo/analyze]', err.message);
    res.status(500).json({ error: err.message || 'IPO analysis failed' });
  }
});

// GET /api/ipo/watch
router.get('/watch', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ items: [] });
  try {
    const items = await IpoWatch.list(req.user.id);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ipo/watch
router.post('/watch', async (req, res) => {
  if (!isMongoConfigured()) return res.status(503).json({ error: 'MongoDB required to save IPO watch' });
  try {
    const issuePrice = Number(req.body.issuePrice);
    if (!req.body.symbol || !issuePrice) return res.status(400).json({ error: 'symbol and issuePrice required' });
    const item = await IpoWatch.upsert(req.user.id, {
      symbol: req.body.symbol,
      companyName: req.body.companyName,
      issuePrice,
      listingDate: req.body.listingDate,
      listingOpen: req.body.listingOpen,
      notes: req.body.notes,
      alertOnBuy: req.body.alertOnBuy,
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ipo/watch/:id
router.delete('/watch/:id', async (req, res) => {
  if (!isMongoConfigured()) return res.status(503).json({ error: 'MongoDB required' });
  try {
    await IpoWatch.remove(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ipo/watch/scan — re-analyse all watched IPOs for current user
router.get('/watch/scan', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ results: [] });
  try {
    const items = await IpoWatch.list(req.user.id);
    const marketContext = await getMarketTrend().catch(() => null);
    const results = [];
    for (const item of items) {
      try {
        const { quote, intradayCandles } = await fetchIpoLiveBundle(item.symbol);
        const analysis = analyzeIpoListingDay({
          symbol: item.symbol,
          issuePrice: item.issuePrice,
          listingOpen: item.listingOpen,
          quote,
          intradayCandles,
          marketContext,
        });
        await IpoWatch.updateSignal(req.user.id, item.symbol, {
          signal: analysis.signal,
          confidence: analysis.confidence,
        });
        results.push({ ...item, analysis });
        await new Promise((r) => setTimeout(r, 120));
      } catch (err) {
        results.push({ ...item, error: err.message });
      }
    }
    res.json({ results, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/ipo/calendar — today's listings + next trading day + open issues (NSE)
router.get('/calendar', async (req, res) => {
  try {
    const board = await fetchIpoCalendarBoard();
    res.json(board);
  } catch (err) {
    console.error('[ipo/calendar]', err.message);
    res.status(502).json({ error: err.message || 'Could not load IPO calendar from NSE' });
  }
});

// GET /api/ipo/listed-today/analyze — today + last 30 days listings with live vs issue
router.get('/listed-today/analyze', async (req, res) => {
  try {
    const board = await fetchIpoCalendarBoard();
    const marketContext = await getMarketTrend().catch(() => null);

    async function analyzeRow(ipo, { fullIntraday = false } = {}) {
      if (!ipo.issuePrice) {
        return { ...ipo, error: 'Issue price missing on NSE feed' };
      }
      try {
        const { quote, intradayCandles, quoteError, yahooSymbol } = await fetchIpoLiveBundle(ipo.symbol, ipo.companyName);
        let dailyCandles = [];
        if (quote) {
          try {
            dailyCandles = await marketData.getHistorical(ipo.symbol, 30);
          } catch (_) {}
        }
        let analysis = null;
        if (quote && quote.lastPrice != null) {
          analysis = analyzeIpoListingDay({
            symbol: ipo.symbol,
            issuePrice: ipo.issuePrice,
            listingOpen: null,
            quote,
            intradayCandles: fullIntraday ? intradayCandles : (intradayCandles || []),
            dailyCandles,
            marketContext,
            listingDate: ipo.listingDate,
          });
        }
        const price = quote?.lastPrice ?? null;
        const vsIssuePct = price != null && ipo.issuePrice
          ? Number((((price - ipo.issuePrice) / ipo.issuePrice) * 100).toFixed(2))
          : null;
        return {
          symbol: ipo.symbol,
          companyName: ipo.companyName,
          listingDate: ipo.listingDate,
          issuePrice: ipo.issuePrice,
          priceRange: ipo.priceRange,
          securityType: ipo.securityType,
          livePrice: price,
          vsIssuePct,
          analysis,
          yahooSymbol: yahooSymbol || null,
          error: quote ? null : (quoteError || 'Live quote not available yet — Yahoo/NSE lag common right after listing. Row still shown; retry shortly.'),
        };
      } catch (err) {
        return {
          symbol: ipo.symbol,
          companyName: ipo.companyName,
          listingDate: ipo.listingDate,
          issuePrice: ipo.issuePrice,
          error: err.message,
        };
      }
    }

    // Full analysis for today (priority)
    const todayResults = await mapPool(board.listedToday || [], 3, async (ipo) => {
      const row = await analyzeRow(ipo, { fullIntraday: true });
      await new Promise((r) => setTimeout(r, 40));
      return row;
    });

    // Last 15 days (skip ones already in todayResults to save calls if same)
    const todaySyms = new Set(todayResults.map((r) => r.symbol));
    const recentSource = (board.listedLast30Days || []).filter((p) => !todaySyms.has(p.symbol));
    const recentCap = recentSource.slice(0, 40);
    const recentResults = await mapPool(recentCap, 3, async (ipo) => {
      const row = await analyzeRow(ipo, { fullIntraday: false });
      await new Promise((r) => setTimeout(r, 35));
      return row;
    });
    // Append any remaining without live quote (calendar only)
    for (const ipo of recentSource.slice(40)) {
      recentResults.push({ ...ipo, livePrice: null, vsIssuePct: null });
    }

    const allRecent = [...todayResults, ...recentResults];
    // Calendar already limited to ~45 days. Alerts need listingDate + live + issue.
    const reclaimAlerts = [];
    const approachingAlerts = [];
    for (const row of allRecent) {
      if (!row.listingDate) continue;
      const price = row.livePrice ?? row.analysis?.metrics?.price ?? null;
      const issue = row.issuePrice != null ? Number(row.issuePrice) : null;
      if (price == null || !Number.isFinite(price) || issue == null || !(issue > 0)) continue;
      const vs = ((price - issue) / issue) * 100;
      const reclaim = row.analysis?.reclaimSetup;
      const path = row.analysis?.postListingPath || row.analysis?.reclaimSetup || null;
      const high = path?.postListHigh ?? null;
      const low = path?.postListLow ?? null;
      const bounce = path?.bounceFrom ?? low;
      const base = {
        symbol: row.symbol,
        companyName: row.companyName || null,
        listingDate: row.listingDate,
        issuePrice: issue,
        livePrice: Number(Number(price).toFixed(2)),
        vsIssuePct: Number(vs.toFixed(2)),
        postListHigh: high,
        postListLow: low,
        bounceFrom: bounce,
        highPctFromIssue: path?.highPctFromIssue ?? (high != null ? Number((((high - issue) / issue) * 100).toFixed(2)) : null),
        lowPctFromIssue: path?.lowPctFromIssue ?? (low != null ? Number((((low - issue) / issue) * 100).toFixed(2)) : null),
      };
      if (vs >= -0.5 && vs <= 2.5 && (reclaim?.active || Math.abs(vs) <= 1.2)) {
        reclaimAlerts.push({
          ...base,
          type: 'reclaimed',
          message: `At/near issue (listed ${row.listingDate})`
            + (high != null ? ` · listing ke baad high ₹${high}` : '')
            + (low != null ? ` · low ₹${low}` : '')
            + (bounce != null ? ` · bounce ~₹${bounce}` : ''),
        });
      } else if (vs >= -3 && vs < -0.5) {
        approachingAlerts.push({
          ...base,
          type: 'approaching',
          message: `${Math.abs(vs).toFixed(1)}% under issue · listed ${row.listingDate}`
            + (high != null ? ` · high ₹${high}` : '')
            + (low != null ? ` · low ₹${low}` : ''),
        });
      }
    }

    res.json({
      results: todayResults,
      listedLast30Days: allRecent,
      reclaimAlerts,
      approachingAlerts,
      today: board.today,
      nextTradingDay: board.nextTradingDay,
      listedTomorrow: board.listedTomorrow || [],
      openForSubscription: board.openForSubscription || [],
      scannedAt: new Date().toISOString(),
      note: 'Today + last 30 days listed IPOs from NSE. Reclaim / near-issue alerts on top. Not a profit guarantee.',
    });
  } catch (err) {
    console.error('[ipo/listed-today]', err.message);
    res.status(500).json({ error: err.message || 'Listed-today analysis failed' });
  }
});

module.exports = router;
