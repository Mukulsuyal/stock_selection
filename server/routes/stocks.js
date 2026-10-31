const express = require('express');
const router = express.Router();
const marketData = require('../marketData');
const { analyze } = require('../indicators');
const { runBacktest } = require('../backtest');
const { getMarketTrend } = require('../marketTrend');
const { INDEXES } = require('../indexConstituents');
const fundamentalsStore = require('../fundamentalsStore');
const { warmFundamentals, warmStatus } = require('../fundamentalsWarm');
const { mapLimit, analyzeOne, computeTieredOpportunities, computeTopPicks, computeSwingSetups, computeRankScore, computeScoreBreakdown, assessPickQuality, computeQualityRankScore, learningFilterStatus } = require('../stockAnalysisEngine');
const { getCombinedUniverseScan } = require('../universeScan');
const { computeZoneState } = require('../buyZoneEngine');
const { computeRelativeStrength } = require('../relativeStrength');
const { detectBreakout } = require('../breakoutEngine');
const { isMongoConfigured } = require('../mongo');
const Recommendation = require('../recommendations/Recommendation');
const { estimateMoveProbability, estimateTargetTimeline } = require('../probabilityEstimator');
const { logRowsForToday, buildRowsToLog, buildReason, logIntradaySnapshotRows } = require('../recommendations/tracker');
const RemovalEvent = require('../recommendations/RemovalEvent');
const { todayIST, getTradingDayStatus } = require('../marketCalendar');
const { getMultiTimeframeAnalysis } = require('../multiTimeframe');
const { getMultiSourceQuote } = require('../dataProviders/aggregator');
const { computeFinalDecision } = require('../decisionEngine');
const progressStore = require('../progressStore');
const { getSectorMap } = require('../institutional/sectorSync');
const { computeSectorTodayMoves } = require('../sectorRotation');
const { getTradingStatus } = require('../riskGuardrails');
const { requireAuth, requireFeature } = require('../auth');

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (q.length < 1) return res.json({ results: [] });
    const results = await marketData.search(q);
    res.json({ results });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not reach market data provider' });
  }
});

router.get('/:symbol/quote', async (req, res) => {
  try {
    const quote = await marketData.getQuote(req.params.symbol);
    res.json({ quote });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not fetch quote. Try again shortly, or check the symbol.' });
  }
});


router.get('/:symbol/company-study', async (req, res) => {
  try {
    const { buildCompanyStudy } = require('../companyStudy');
    const data = await buildCompanyStudy(req.params.symbol);
    res.json(data);
  } catch (err) {
    console.error('[company-study]', err.message);
    res.status(502).json({ error: err.message || 'Company study failed' });
  }
});

router.get('/:symbol/fundamentals', async (req, res) => {
  try {
    // Prefer DB (works after market close). Network only if miss/stale.
    let fundamentals = await marketData.getFundamentals(req.params.symbol, {
      maxAgeDays: 14,
    });
    if (!fundamentals) {
      const c = await fundamentalsStore.readCache(req.params.symbol, { maxAgeDays: 60 });
      if (c.hit && c.data) fundamentals = { ...c.data, fromCache: true, cacheStale: c.stale };
    }
    if (!fundamentals) {
      return res.status(502).json({
        error: 'Could not fetch fundamentals right now. Some smaller/newer listings may not have full data.',
      });
    }
    res.json({ fundamentals });
  } catch (err) {
    // Last resort: any cached row even if old
    try {
      const c = await fundamentalsStore.readCache(req.params.symbol, { maxAgeDays: 365 });
      if (c.hit && c.data) {
        return res.json({ fundamentals: { ...c.data, fromCache: true, cacheStale: true } });
      }
    } catch (_) {}
    console.error('[fundamentals]', req.params.symbol, err.message);
    res.status(502).json({
      error: 'Could not fetch fundamentals right now. Some smaller/newer listings may not have full data.',
      detail: err.message,
    });
  }
});

// Combined news + upcoming-earnings check, used to enrich swing-trade
// setup cards without firing two separate requests per stock from the UI.
router.get('/:symbol/context', async (req, res) => {
  try {
    const [news, events] = await Promise.all([
      marketData.getNews(req.params.symbol).catch(() => []),
      marketData.getEvents(req.params.symbol).catch(() => ({ nextEarnings: null, daysUntil: null })),
    ]);
    res.json({ news: news.slice(0, 2), events });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not fetch context right now' });
  }
});

router.get('/:symbol/news', async (req, res) => {
  try {
    const news = await marketData.getNews(req.params.symbol);
    res.json({ news });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not fetch news right now' });
  }
});

// GET /api/stocks/:symbol/mtf — multi-timeframe (5m/15m/1h/4h/daily/weekly) read
// GET /api/stocks/:symbol/data-quality — multi-source quote with per-field
// source/timestamp/reliability, and an overall Data Confidence score.
// Tries Upstox first (if configured), falls back to Yahoo per-field.
router.get('/:symbol/data-quality', async (req, res) => {
  try {
    const quote = await getMultiSourceQuote(req.params.symbol);
    res.json({ quote });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not check data quality right now' });
  }
});

// GET /api/stocks/:symbol/decision — the Final Decision Card: combines
// technical analysis, data confidence, market regime, and the user's own
// trading-discipline status (daily loss limit, cooldown, etc.) into one
// decision with explicit reasons. Requires login (trading status is
// per-user); everything else on this route needs no login.
router.get('/:symbol/decision', requireAuth, async (req, res) => {
  try {
    const [quote, candles, marketContext, dq, tradingStatus] = await Promise.all([
      marketData.getQuote(req.params.symbol),
      marketData.getHistorical(req.params.symbol, 1260),
      getMarketTrend(),
      getMultiSourceQuote(req.params.symbol),
      getTradingStatus(req.user.id),
    ]);
    if (!candles.length) return res.status(404).json({ error: 'No historical data found for this symbol' });
    const analysis = analyze(candles, quote, marketContext);
    const priorRec = await getPriorRecommendation(req.params.symbol);
    analysis.zoneState = await computeZoneState({ analysis, priorRec, horizon: analysis.suggestedHorizon });
    const decision = computeFinalDecision({
      analysis, dataConfidence: dq.dataConfidence, marketContext, tradingStatus,
      minRiskReward: tradingStatus.settings.minRiskReward,
      minDataConfidence: tradingStatus.settings.minDataConfidence,
    });
    // The zone state machine has final say on BUY: a hard technical BUY
    // NOW is meaningless if the same call already hit target/SL, expired,
    // or the plan is logically invalidated - override rather than showing
    // a fresh buy signal on a closed/stale call.
    const overrideStates = ['TARGET_HIT', 'STOP_LOSS_HIT', 'EXPIRED', 'INVALIDATED'];
    if (overrideStates.includes(analysis.zoneState.state) && decision.decision !== 'NO TRADE') {
      decision.whyNot.unshift(analysis.zoneState.reason);
      decision.decision = analysis.zoneState.state === 'EXPIRED' || analysis.zoneState.state === 'INVALIDATED' ? 'WATCHLIST' : 'NO TRADE';
    }
    res.json({ analysis, decision, dataQuality: dq, marketContext, tradingStatus });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not compute a decision right now' });
  }
});

router.get('/:symbol/mtf', async (req, res) => {
  try {
    const mtf = await getMultiTimeframeAnalysis(req.params.symbol);
    res.json({ mtf });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not run multi-timeframe analysis right now' });
  }
});

router.get('/:symbol/backtest', async (req, res) => {
  try {
    const [candles, niftyCandles] = await Promise.all([
      marketData.getHistorical(req.params.symbol, 1260),
      marketData.getHistorical('^NSEI', 1260).catch(() => []),
    ]);
    if (!candles.length) return res.status(404).json({ error: 'No historical data found for this symbol' });
    // Align the Nifty benchmark window to the same warmup start the stock's
    // backtest will use, so the "beat Nifty?" comparison is apples-to-apples.
    const warmupDays = 205;
    const benchmarkCandles = niftyCandles.length > warmupDays ? niftyCandles.slice(-(candles.length - warmupDays)) : null;
    const result = runBacktest(candles, { benchmarkCandles });
    if (result.error) return res.status(400).json(result);
    res.json({ symbol: req.params.symbol.toUpperCase(), backtest: result });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not run backtest right now. Try again shortly.' });
  }
});

// Looks up the most recent logged pick for this symbol (any category), if
// any, so the buy-zone state machine can tell "fresh read" apart from
// "this exact call already hit target/SL" - never silently invented if
// Mongo isn't configured or nothing was ever logged for this symbol.
async function getPriorRecommendation(symbol) {
  if (!isMongoConfigured()) return null;
  try {
    return await Recommendation.findOne({ symbol: symbol.toUpperCase() }).sort({ recommendedDate: -1 }).lean();
  } catch {
    return null;
  }
}

// "Golden trend, RSI bullish... but is the whole sector moving, or just
// this one stock?" - looks up the stock's sector (from the same
// fundamentals-derived sector map used by Sector Rotation/institutional
// flow), then averages TODAY's live %change across every OTHER stock in
// our tracked universe that shares that sector. Returns null (not an
// error) if Mongo isn't configured, the sector map hasn't synced yet, or
// this stock's sector isn't known - callers should treat that as "no
// sector context available" and simply not show the line, not as a failure.
async function getSectorTodayContext(symbol) {
  const sectorMap = await getSectorMap();
  const sector = sectorMap[symbol.toUpperCase()];
  if (!sector || sector === 'Unknown') return null;
  const { results } = await getCombinedUniverseScan();
  const moves = computeSectorTodayMoves(results, sectorMap);
  const sectorMove = moves[sector];
  if (!sectorMove) return null;
  const stockPChange = results.find((r) => r.symbol === symbol.toUpperCase())?.pChange ?? null;
  return {
    sector,
    sectorTodayPct: sectorMove.avgPct,
    sectorStockCount: sectorMove.stockCount,
    stockTodayPct: stockPChange,
    // "moving with" if both point the same direction and are within 1.5
    // points of each other; "against" if they clearly diverge (e.g. stock
    // up while its sector as a whole is down) - anything else is just
    // "roughly in line", not distinctive enough to call out either way.
    alignment: stockPChange == null ? null
      : (Math.sign(stockPChange) === Math.sign(sectorMove.avgPct) && Math.abs(stockPChange - sectorMove.avgPct) <= 1.5) ? 'with_sector'
      : (Math.sign(stockPChange) !== Math.sign(sectorMove.avgPct) && Math.abs(stockPChange - sectorMove.avgPct) > 1) ? 'against_sector'
      : 'in_line',
  };
}

router.get('/:symbol/analysis', async (req, res) => {
  try {
    const [quote, candles, marketContext] = await Promise.all([
      marketData.getQuote(req.params.symbol),
      marketData.getHistorical(req.params.symbol, 1260),
      getMarketTrend(),
    ]);
    if (!candles.length) return res.status(404).json({ error: 'No historical data found for this symbol' });
    const result = analyze(candles, quote, marketContext);
    result.moveProbability = estimateMoveProbability(candles);
    result.targetTimeline = result.tradePlan && result.price
      ? estimateTargetTimeline(candles, ((result.tradePlan.target - result.price) / result.price) * 100)
      : { status: 'unavailable' };
    result.relativeStrength = computeRelativeStrength(result.periodReturns, marketContext?.periodReturns);
    result.breakout = detectBreakout(candles, result.indicators.volSpike);
    const priorRec = await getPriorRecommendation(req.params.symbol);
    result.zoneState = await computeZoneState({ analysis: result, priorRec, horizon: result.suggestedHorizon });
    // "Is this stock's move today just it, or is its whole sector moving
    // together?" - best-effort only: needs Mongo (for the sector map) and
    // reuses the already-cached combined-universe scan, so it costs
    // nothing extra on top of what Market Pulse etc. already fetch. Left
    // null (not an error) if either piece isn't available.
    result.sectorContext = await getSectorTodayContext(req.params.symbol).catch(() => null);
    res.json({ analysis: result, candles, marketContext });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not analyze symbol right now. Check the symbol or try again shortly.' });
  }
});

// GET /api/stocks/:symbol/chart?range=1d|2d|3d|4d|5d|1w|15d|1mo|3mo|6mo|1y
// Powers the range buttons on the symbol page's price chart. Short ranges
// (under a month) use Yahoo's intraday candles (5m/15m/30m/1h, whatever
// keeps the point count reasonable) - '1d' in particular is effectively
// the "live" chart for today, since it's just today's intraday candles and
// the frontend keeps nudging the last point via the existing WebSocket
// price feed. Longer ranges reuse the same daily getHistorical already
// used by /analysis, just trimmed to fewer days, so those stay consistent
// with the main ~220-session chart.
const CHART_RANGE_MAP = {
  '1d': { kind: 'intraday', range: '1d', interval: '1m' },
  '2d': { kind: 'intraday', range: '5d', interval: '15m', trimDays: 2 },
  '3d': { kind: 'intraday', range: '5d', interval: '15m', trimDays: 3 },
  '4d': { kind: 'intraday', range: '5d', interval: '15m', trimDays: 4 },
  '5d': { kind: 'intraday', range: '5d', interval: '15m' },
  '1w': { kind: 'intraday', range: '1mo', interval: '30m', trimDays: 7 },
  '15d': { kind: 'intraday', range: '1mo', interval: '1h', trimDays: 15 },
  '1mo': { kind: 'daily', days: 22 },
  '3mo': { kind: 'daily', days: 66 },
  '6mo': { kind: 'daily', days: 132 },
  '1y': { kind: 'daily', days: 252 },
  '3y': { kind: 'daily', days: 756 },
  '5y': { kind: 'daily', days: 1260 },
  'max': { kind: 'daily', days: 2520 },
};

router.get('/:symbol/chart', async (req, res) => {
  try {
    const rangeKey = req.query.range || '1mo';
    const cfg = CHART_RANGE_MAP[rangeKey];
    if (!cfg) return res.status(400).json({ error: `Unknown range. Use one of: ${Object.keys(CHART_RANGE_MAP).join(', ')}` });

    let candles;
    if (cfg.kind === 'intraday') {
      candles = await marketData.getIntradayCandles(req.params.symbol, cfg.range, cfg.interval);
      if (cfg.trimDays) {
        const cutoff = Date.now() - cfg.trimDays * 24 * 60 * 60 * 1000;
        candles = candles.filter((c) => new Date(c.date).getTime() >= cutoff);
      }
    } else {
      candles = await marketData.getHistorical(req.params.symbol, cfg.days);
    }
    if (!candles.length) return res.status(404).json({ error: 'No chart data available for this range yet - try a longer range.' });
    res.json({ symbol: req.params.symbol.toUpperCase(), range: rangeKey, isIntraday: cfg.kind === 'intraday', candles });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not load chart data right now.' });
  }
});

// ---------- Browse by index: Nifty 50 / Midcap / Smallcap ----------
router.get('/index/:name', (req, res) => {
  const idx = INDEXES[req.params.name];
  if (!idx) return res.status(404).json({ error: 'Unknown index. Use nifty50, midcap, or smallcap.' });
  res.json({ name: req.params.name, label: idx.label, symbols: idx.symbols });
});

// GET /api/stocks/index/:name/analysis -> full bulk analysis for every
// symbol in that index, computed with limited concurrency.
// GET /api/stocks/progress/:jobId -> polled by the frontend while a big
// index/bulk scan is running, to drive a real 0-100% progress bar instead
// of a plain spinner. See server/progressStore.js.
router.get('/progress/:jobId', (req, res) => {
  const job = progressStore.getJob(req.params.jobId);
  if (!job) return res.json({ found: false });
  res.json({ found: true, completed: job.completed, total: job.total });
});

router.get('/index/:name/analysis', async (req, res) => {
  const idx = INDEXES[req.params.name];
  if (!idx) return res.status(404).json({ error: 'Unknown index. Use nifty50, midcap, or smallcap.' });
  const { jobId } = req.query;
  try {
    const marketContext = await getMarketTrend();
    progressStore.startJob(jobId, idx.symbols.length);
    const results = await mapLimit(idx.symbols, 4, (s) => analyzeOne(s, marketContext), (done, total) => progressStore.updateJob(jobId, done));
    progressStore.endJob(jobId);
    results.sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
    res.json({ name: req.params.name, label: idx.label, results, marketContext });
    // Intentionally NO recommendation / snapshot logging here.
    // Opening Nifty50 / Midcap / Smallcap tabs is for browsing only —
    // permanent Track Record + intraday snapshots come ONLY from
    // "Best of Today" and "Golden Opportunity Scanner" (and their crons).
  } catch (err) {
    progressStore.endJob(jobId);
    console.error(err.message);
    res.status(500).json({ error: 'Index analysis failed' });
  }
});

// In-memory "what did the last live scan show" snapshot, so a stock that
// drops out of a tier BETWEEN two live scans on the same day (e.g. 10:20am
// scan had it in Bronze, 11:00am rescan doesn't) still gets a RemovalEvent
// with a real reason attached - not just silently vanishing from the list
// until the once-a-day cron eventually notices. Reset automatically when
// the date rolls over; intentionally in-memory (not DB) since it only
// needs to survive between requests on the same running server, and losing
// it on a restart just means the very next scan re-establishes a baseline
// instead of comparing against something stale.
let lastGoldenSnapshot = { date: null, bySymbol: {} };

async function detectIntradayGoldenRemovals(results, tiers, today) {
  if (!isMongoConfigured()) return;
  // Same reasoning as logRowsForToday in tracker.js: on a weekend/holiday
  // the underlying data isn't moving, so any apparent tier change is noise,
  // not a real removal - never log one.
  const tradingDayStatus = await getTradingDayStatus();
  if (!tradingDayStatus.isTradingDay) return;
  const currentBySymbol = {};
  ['diamond', 'gold', 'silver', 'bronze'].forEach((tier) => {
    tiers[tier].forEach((r) => { currentBySymbol[r.symbol] = { category: `golden_${tier}`, score: r.score }; });
  });

  if (lastGoldenSnapshot.date !== today) {
    // First scan of a new day - nothing to diff against yet (the daily
    // cron's detectRemovals already covers day-over-day drops).
    lastGoldenSnapshot = { date: today, bySymbol: currentBySymbol };
    return;
  }

  const resultsBySymbol = Object.fromEntries(results.map((r) => [r.symbol, r]));
  const priorBySymbol = lastGoldenSnapshot.bySymbol;

  for (const [symbol, priorRow] of Object.entries(priorBySymbol)) {
    const stillThere = currentBySymbol[symbol]?.category === priorRow.category;
    if (stillThere) continue; // same tier as before - nothing changed

    try {
      // Idempotency: don't log the same symbol+category+day removal twice
      // if it's already been recorded (e.g. server restarted mid-day, or
      // this same drop got caught by both a live rescan AND the cron).
      const exists = await RemovalEvent.findOne({ symbol, category: priorRow.category, removedDate: today }).lean();
      if (exists) continue;

      const current = resultsBySymbol[symbol];
      const reason = buildReason(current, priorRow);
      const priceAtRemoval = current?.price ?? null;

      // Pull the frozen recommendedPrice from today's Recommendation row
      // (set once via $setOnInsert, never overwritten by later scans) so
      // "how much has it moved since it was first flagged today" is exact,
      // not an approximation.
      let changePctSinceRecommended = null;
      let lastRecommendedPrice = null;
      try {
        const recDoc = await Recommendation.findOne({ symbol, category: priorRow.category, recommendedDate: today }).lean();
        if (recDoc?.recommendedPrice && priceAtRemoval != null) {
          lastRecommendedPrice = recDoc.recommendedPrice;
          changePctSinceRecommended = Number((((priceAtRemoval - recDoc.recommendedPrice) / recDoc.recommendedPrice) * 100).toFixed(2));
        }
      } catch { /* best-effort only */ }

      // "It's out of the list now, but historically on THIS stock, what
      // are the odds it still climbs back to (or past) where it was
      // recommended, within the next week / two weeks / month?" - carried
      // straight from the same targetTimeline calc used everywhere else,
      // just re-pointed at the removal price as the new reference point.
      let outlookProb7d = null, outlookProb15d = null, outlookProb30d = null, outlookSampleSize = null;
      if (current?.targetTimeline?.status === 'ok') {
        outlookProb7d = current.targetTimeline.horizons.d7 ?? null;
        outlookProb15d = current.targetTimeline.horizons.d15 ?? null;
        outlookProb30d = current.targetTimeline.horizons.d30 ?? null;
        outlookSampleSize = current.targetTimeline.sampleSize ?? null;
      }

      await RemovalEvent.create({
        symbol, category: priorRow.category, removedDate: today,
        lastRecommendedDate: today, lastRecommendedPrice,
        priceAtRemoval, changePctSinceRecommended, reason,
        outlookProb7d, outlookProb15d, outlookProb30d, outlookSampleSize,
      });
    } catch (err) {
      console.error(`[golden-opportunities] failed to log intraday removal for ${symbol}:`, err.message);
    }
  }

  lastGoldenSnapshot = { date: today, bySymbol: currentBySymbol };
}

// GET /api/stocks/golden-opportunities -> "is there ONE stock, anywhere
// across Nifty50 + Midcap + Smallcap combined, worth buying right now" -
// graded into 4 tiers (💎 diamond / 🥇 gold / 🥈 silver / 🥉 bronze, see
// classifyOpportunityTier in server/stockAnalysisEngine.js) instead of a
// single pass/fail bar, so a quiet or broadly bearish market still
// surfaces its relatively-best candidates rather than showing nothing.
// Reuses the shared combined-universe scan (see server/universeScan.js)
// instead of running its own separate 250-symbol scan.
//
// Picks are LOCKED for the day at 3:00pm IST: almost nobody starts a new
// trade off this list after that hour, so letting the underlying 10-min
// rescan keep swapping symbols in and out past that point just made the
// list feel like it never settled down. Before the cutoff, tier membership
// is recomputed fresh every scan as before; at/after the cutoff, the LAST
// pre-cutoff line-up is frozen (same symbols, same tiers, all day) while
// each symbol's price/score/history still update live off the same 10-min
// scan - so the list itself goes still, but nothing inside it goes stale.
// GET /api/stocks/best-of-today -> "in charon categories mein se sabse
// achha kaun hai" - Short-term, Long-term, Momentum, Reversal/Bounce,
// each category's #1 candidate (same ranking each category already uses
// elsewhere in the app), run across the FULL combined universe (not just
// whichever index tab happens to be open), plus one explicit "overall
// winner" across all 4 - ranked by the same composite score
// (computeRankScore) used everywhere else in the app: technical score,
// R:R, volume, this stock's own historical profit/loss odds, and
// alignment with the broader market regime, all in one number.
router.get('/best-of-today', async (req, res) => {
  try {
    const { results, marketContext, scannedAt } = await getCombinedUniverseScan();
    // Hydrate fundamentals from Mongo cache (scan itself is cache-only / fast)
    const missingFund = [];
    for (const row of results || []) {
      if (!row || row.error) continue;
      if (row.fundamentals) continue;
      try {
        const c = await fundamentalsStore.readCache(row.symbol, { maxAgeDays: 7, livePrice: row.price });
        if (c.hit && c.data) row.fundamentals = c.data;
        else missingFund.push(row.symbol);
      } catch (_) {
        missingFund.push(row.symbol);
      }
    }
    const topPicks = computeTopPicks(results, marketContext);
    const swing = computeSwingSetups(results, marketContext);
    const sectorMap = await getSectorMap().catch(() => ({}));
    const sectorMoves = Object.keys(sectorMap).length ? computeSectorTodayMoves(results, sectorMap) : {};

    const categories = [
      { key: 'short_term', label: 'Short-term', pick: topPicks.short_term[0] || null },
      { key: 'long_term', label: 'Long-term', pick: topPicks.long_term[0] || null },
      { key: 'momentum', label: 'Momentum', pick: swing.momentum[0] || null },
      { key: 'reversal', label: 'Reversal/Bounce', pick: swing.reversal[0] || null },
    ].map((c) => {
      if (!c.pick) return { ...c, pick: null, rankScore: null, scoreBreakdown: null, pickQuality: null };
      const sector = sectorMap[c.pick.symbol];
      const sectorMove = sector ? sectorMoves[sector] : null;
      const sectorContext = sectorMove ? { sector, sectorTodayPct: sectorMove.avgPct } : (sector ? { sector, sectorTodayPct: null } : null);
      const breakdown = computeScoreBreakdown(c.pick, marketContext, sectorContext);
      const pickQuality = assessPickQuality(c.pick, marketContext);
      const qualityRank = computeQualityRankScore(c.pick, marketContext, sectorContext);
      return {
        ...c,
        rankScore: breakdown.overall,
        qualityRankScore: Number(qualityRank.toFixed(1)),
        scoreBreakdown: breakdown,
        pickQuality,
        pick: { ...c.pick, sectorContext, pickQuality },
      };
    });

    const withPicks = categories.filter((c) => c.pick);
    let overallWinner = null;
    if (withPicks.length) {
      // Prefer higher quality-rank (R:R + volume + market alignment), not raw score alone
      overallWinner = withPicks.reduce((best, c) =>
        ((c.qualityRankScore ?? c.rankScore) > (best.qualityRankScore ?? best.rankScore) ? c : best)
      ).key;
    }

    // Debug/explainability: one line per category showing exactly how its
    // score was built - so "why is X ranked where it is" is answerable
    // from the server logs alone, without re-deriving it by hand.
    categories.forEach((c) => {
      if (!c.pick || !c.scoreBreakdown) return;
      const b = c.scoreBreakdown;
      console.log(`[best-of-today] ${c.key} -> ${c.pick.symbol}: overall=${b.overall} (technical=${b.components.technical}, R:R=${b.components.riskReward}, momentum=${b.components.momentum}, volume=${b.components.volume}, sector=${b.components.sectorAlignment}, market=${b.components.marketAlignment}, historical=${b.components.historical}, fundamentals=${b.components.fundamentals}, adaptiveNudge=${b.adaptiveNudge}) | tradePlan R:R=1:${c.pick.tradePlan?.riskRewardRatio ?? '?'}`);
    });

    const lf = typeof learningFilterStatus === 'function' ? learningFilterStatus() : { ready: false, message: '' };
    res.json({
      categories, overallWinner, scannedAt, marketContext,
      learningFilter: lf,
      fundamentalsMissing: missingFund.length,
      fundamentalsMissingSample: missingFund.slice(0, 30),
    });

    // Permanent Track Record + intraday snapshot ONLY for Best of Today
    // categories (short_term / long_term / momentum / reversal) — never from
    // individual Nifty50/Midcap/Smallcap tab clicks.
    const rows = [];
    categories.forEach((c) => {
      if (!c.pick || !c.pick.symbol) return;
      rows.push({ ...c.pick, category: c.key });
    });
    if (rows.length) {
      logRowsForToday(rows).catch((err) => console.error('[recommendations] best-of-today live-log failed:', err.message));
      logIntradaySnapshotRows(rows).catch((err) => console.error('[intradaySnapshot] best-of-today snapshot failed:', err.message));
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute best-of-today right now. Try again shortly.' });
  }
});

let lockedGoldenTiers = { date: null, tierBySymbol: {}, lockedAt: null };
const GOLDEN_LOCK_HOUR_IST = 15;
const GOLDEN_LOCK_MINUTE_IST = 0;

function isPastGoldenLockTime(ist) {
  return ist.getHours() > GOLDEN_LOCK_HOUR_IST
    || (ist.getHours() === GOLDEN_LOCK_HOUR_IST && ist.getMinutes() >= GOLDEN_LOCK_MINUTE_IST);
}

router.get('/golden-opportunities', async (req, res) => {
  try {
    // After market close / holiday: do not run heavy universe scan (unless ?force=1)
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force) {
      try {
        const { getTradingDayStatus } = require('../marketCalendar');
        const stDay = await getTradingDayStatus();
        const now = new Date();
        const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const mins = ist.getHours() * 60 + ist.getMinutes();
        const afterClose = mins >= 15 * 60 + 30;
        const beforeOpen = mins < 9 * 60 + 15;
        if (!stDay.isTradingDay || afterClose || beforeOpen) {
          return res.json({
            marketClosed: true,
            skipReason: !stDay.isTradingDay ? (stDay.reason || 'Holiday/weekend') : (afterClose ? 'After 15:30 IST' : 'Before 9:15 IST'),
            tiers: { diamond: [], gold: [], silver: [], bronze: [] },
            scannedCount: 0,
            scannedAt: new Date().toISOString(),
            locked: true,
            message: 'Golden scanner pauses outside market hours (9:15–15:30 IST, trading days only).',
          });
        }
      } catch (_) {}
    }
    const { results, symbolToIndex, scannedCount, scannedAt, marketContext } = await getCombinedUniverseScan();
    let mctx = marketContext;
    if (!mctx) {
      try { mctx = await require('../marketTrend').getMarketTrend(); } catch (_) { mctx = null; }
    }
    const freshTiers = computeTieredOpportunities(results, mctx);

    const ist = todayIST();
    const dateStr = ist.toISOString().slice(0, 10);
    const pastLockTime = isPastGoldenLockTime(ist);
    if (lockedGoldenTiers.date !== dateStr) {
      lockedGoldenTiers = { date: dateStr, tierBySymbol: {}, lockedAt: null };
    }

    let tiers = freshTiers;
    let locked = false;
    if (!pastLockTime) {
      // Still before the cutoff - keep saving the latest line-up as the
      // "candidate" snapshot to freeze once the clock crosses 3:00pm.
      const snap = {};
      ['diamond', 'gold', 'silver', 'bronze'].forEach((t) => freshTiers[t].forEach((r) => { snap[r.symbol] = t; }));
      lockedGoldenTiers.tierBySymbol = snap;
    } else {
      locked = true;
      if (!Object.keys(lockedGoldenTiers.tierBySymbol).length) {
        // Cutoff already passed and there's no pre-cutoff snapshot yet
        // (e.g. server only just started this afternoon) - lock whatever
        // this first scan shows, so it's stable from here on rather than
        // showing nothing.
        const snap = {};
        ['diamond', 'gold', 'silver', 'bronze'].forEach((t) => freshTiers[t].forEach((r) => { snap[r.symbol] = t; }));
        lockedGoldenTiers.tierBySymbol = snap;
      }
      if (!lockedGoldenTiers.lockedAt) lockedGoldenTiers.lockedAt = new Date().toISOString();
      const resultsBySymbol = Object.fromEntries(results.map((r) => [r.symbol, r]));
      const reconstructed = { diamond: [], gold: [], silver: [], bronze: [] };
      Object.entries(lockedGoldenTiers.tierBySymbol).forEach(([symbol, tierName]) => {
        const fresh = resultsBySymbol[symbol];
        if (fresh) reconstructed[tierName].push(fresh); // same line-up, live price/score
      });
      tiers = reconstructed;
    }

    const withIndex = (list) => list.map((r) => ({ ...r, indexLabel: symbolToIndex[r.symbol] || null }));
    res.json({
      tiers: { diamond: withIndex(tiers.diamond), gold: withIndex(tiers.gold), silver: withIndex(tiers.silver), bronze: withIndex(tiers.bronze) },
      scannedCount, scannedAt,
      locked, lockedAt: lockedGoldenTiers.lockedAt,
      lockNote: locked
        ? `Today's picks locked at 3:00pm IST — same line-up all afternoon, prices still update live.`
        : `Picks refresh freely until 3:00pm IST, then lock for the rest of the day.`,
    });
    // Permanent Track Record + intraday snapshot ONLY for Golden Opportunity
    // tiers — never from individual Nifty50/Midcap/Smallcap tab clicks.
    const goldenRows = buildRowsToLog({ tiers });
    logRowsForToday(goldenRows).catch((err) => console.error('[recommendations] golden live-log failed:', err.message));
    logIntradaySnapshotRows(goldenRows).catch((err) => console.error('[intradaySnapshot] golden snapshot failed:', err.message));
    // Anything that WAS in a tier on the previous live scan today but isn't
    // anymore gets a RemovalEvent. Skipped once locked — membership is frozen.
    if (!locked) {
      detectIntradayGoldenRemovals(results, freshTiers, scannedAt.slice(0, 10)).catch((err) => console.error('[golden-opportunities] removal-diff failed:', err.message));
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Golden opportunity scan failed. Try again shortly.' });
  }
});

// ---------- Bulk screener: check many symbols in one go ----------
// POST { symbols: ["RELIANCE", "TCS", "INFY", ...] }  (max 100 per request)
router.post('/bulk-analysis', async (req, res) => {
  const { jobId } = req.query;
  try {
    let symbols = req.body.symbols;
    if (!Array.isArray(symbols) || !symbols.length) {
      return res.status(400).json({ error: 'symbols array required' });
    }
    symbols = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 100);

    const marketContext = await getMarketTrend();
    progressStore.startJob(jobId, symbols.length);
    const results = await mapLimit(symbols, 4, (s) => analyzeOne(s, marketContext), (done, total) => progressStore.updateJob(jobId, done));
    progressStore.endJob(jobId);
    results.sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
    res.json({ results, marketContext });
  } catch (err) {
    progressStore.endJob(jobId);
    console.error(err.message);
    res.status(500).json({ error: 'Bulk analysis failed' });
  }
});

// ---------- Manual import: paste your own OHLCV data ----------
// POST { symbol, csv } where csv has header: date,open,high,low,close,volume
router.post('/import-csv', requireAuth, requireFeature('import'), async (req, res) => {
  try {
    const { symbol, csv } = req.body;
    if (!symbol || !csv) return res.status(400).json({ error: 'symbol and csv required' });

    const lines = csv.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'Provide a header row plus at least 1 data row' });

    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idx = {
      date: header.indexOf('date'),
      open: header.indexOf('open'),
      high: header.indexOf('high'),
      low: header.indexOf('low'),
      close: header.indexOf('close'),
      volume: header.indexOf('volume'),
    };
    if ([idx.date, idx.open, idx.high, idx.low, idx.close].some((i) => i === -1)) {
      return res.status(400).json({ error: 'CSV header must include date,open,high,low,close (volume optional)' });
    }

    const candles = lines.slice(1).map((line) => {
      const cols = line.split(',').map((c) => c.trim());
      return {
        date: cols[idx.date],
        open: Number(cols[idx.open]),
        high: Number(cols[idx.high]),
        low: Number(cols[idx.low]),
        close: Number(cols[idx.close]),
        volume: idx.volume !== -1 ? Number(cols[idx.volume]) || 0 : 0,
      };
    }).filter((c) => !isNaN(c.close) && !isNaN(c.open));

    if (candles.length < 5) return res.status(400).json({ error: 'Not enough valid rows to analyze' });

    candles.sort((a, b) => new Date(a.date) - new Date(b.date));
    const lastClose = candles[candles.length - 1].close;
    const quote = { symbol: symbol.toUpperCase(), lastPrice: lastClose };
    const marketContext = await getMarketTrend();
    const result = analyze(candles, quote, marketContext);

    const note = candles.length < 50
      ? `Only ${candles.length} data points provided — indicators needing 50/200-day averages will show as "-". More history = more reliable read.`
      : null;

    res.json({ analysis: { ...result, note }, candles });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not parse/analyze the pasted data' });
  }
});


router.post('/fundamentals-warm', async (req, res) => {
  try {
    let symbols = req.body?.symbols || [];
    if (!symbols.length) {
      // warm from combined universe keys / request list empty → sample from scan
      const scan = await getCombinedUniverseScan(req);
      symbols = (scan.results || []).slice(0, 80).map((r) => r.symbol);
    }
    const { isFundamentalsRefreshWindow } = require('../fundamentalsWarm');
    if (!isFundamentalsRefreshWindow() && !req.body?.force) {
      return res.json({
        ok: true,
        skipped: true,
        reason: 'outside_fund_window',
        message: 'Fundamentals warm only 09:45–10:15 IST or after 15:30 IST. Pass force:true to override.',
      });
    }
    const jobId = `fund-warm-${Date.now()}`;
    res.json({ ok: true, jobId, queued: symbols.length, message: 'Warm started — poll progress' });
    warmFundamentals(symbols, { jobId, forceAll: !!req.body?.force }).catch((err) => console.warn('[fund-warm]', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/fundamentals-warm/:jobId', (req, res) => {
  const job = warmStatus(req.params.jobId);
  if (!job) return res.json({ ok: false, status: 'unknown' });
  res.json({ ok: true, ...job });
});


module.exports = router;
