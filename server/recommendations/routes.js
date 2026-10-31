// server/recommendations/routes.js
const express = require('express');
const router = express.Router();
const { isMongoConfigured } = require('../mongo');
const Recommendation = require('./Recommendation');
const RemovalEvent = require('./RemovalEvent');
const IntradaySnapshot = require('./IntradaySnapshot');
const FactorPerformance = require('./FactorPerformance');
const { recomputeFactorPerformance, MIN_SAMPLE_FOR_ADJUSTMENT, MAX_ADJUSTMENT, BASELINE_WIN_RATE, HARD_MIN_EFFECTIVE, getCacheInfo, findSimilarHistoricalConditions } = require('../factorPerformance');
const { requireAuth } = require('../auth');

router.use(requireAuth);
router.use((req, res, next) => {
  if (!isMongoConfigured()) return res.status(503).json({ error: 'MongoDB is not configured - recommendation tracking is disabled.' });
  next();
});

function fromDateForPeriod(period) {
  const days = { '1W': 7, '15D': 15, '1M': 30, '2M': 60, '3M': 90, '6M': 180, '1Y': 365, '2Y': 730, '5Y': 1825 }[period];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// GET /api/recommendations?category=momentum&period=1M&status=open&page=1&limit=100
// Lists logged picks, OLDEST first by default (so "the very first day's
// data" is what a fresh, unfiltered page load shows, per how this is
// actually used) - with page/limit so a history that's grown past 500+
// rows doesn't have to be pulled and rendered all at once, which is what
// made this page slow to load once there was a few months of history.
// status=open / status=resolved narrows to only-still-open or
// only-target-or-stop-hit picks; omit for everything.
router.get('/', async (req, res) => {
  try {
    const { category, period, symbol, status } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (symbol) filter.symbol = symbol.toUpperCase();
    const fromDate = period ? fromDateForPeriod(period) : null;
    if (fromDate) filter.recommendedDate = { $gte: fromDate };
    if (status === 'open') { filter.hitTarget = false; filter.hitStopLoss = false; }
    else if (status === 'resolved') { filter.$or = [{ hitTarget: true }, { hitStopLoss: true }]; }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      Recommendation.find(filter).sort({ recommendedDate: 1, symbol: 1 }).skip(skip).limit(limit).lean(),
      Recommendation.countDocuments(filter),
    ]);
    res.json({ recommendations: docs, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load recommendation history' });
  }
});

// Purely illustrative equal-weighted stake used for the "how much money"
// figures below - this app doesn't know your real position sizes (use the
// Trade Journal for your own actual, quantity-based P&L). This just answers
// "if you'd put an equal ₹10,000 into every single pick, hit-target/hit-SL
// exits taken exactly at those levels, what would the total look like".
const HYPOTHETICAL_CAPITAL_PER_PICK = 10000;

// The return% to actually judge a pick by: if target or SL was hit, use the
// return AT THAT DATE (from priceHistory) - not today's changePct, which
// keeps drifting with the market long after a pick's target/SL was hit and
// would otherwise misrepresent what an exit at that level actually returned.
function computeOutcomeReturn(d) {
  if (d.hitTarget && d.hitTargetDate) {
    const entry = (d.priceHistory || []).find((h) => h.date === d.hitTargetDate);
    return { outcome: 'target', returnPct: entry ? entry.changePct : (d.target != null ? ((d.target - d.recommendedPrice) / d.recommendedPrice) * 100 : d.changePct) };
  }
  if (d.hitStopLoss && d.hitStopLossDate) {
    const entry = (d.priceHistory || []).find((h) => h.date === d.hitStopLossDate);
    return { outcome: 'stopped', returnPct: entry ? entry.changePct : (d.stopLoss != null ? ((d.stopLoss - d.recommendedPrice) / d.recommendedPrice) * 100 : d.changePct) };
  }
  return { outcome: 'open', returnPct: d.changePct };
}

// GET /api/recommendations/summary?period=1M&status=open
// Honest scorecard: of everything this app has recommended, how many
// actually went up vs down since, by category - AND a combined "all
// categories together" total. Every category (and the total) reports
// target-hit and stop-hit counts BOTH combined (resolved = target+stop)
// and separately, plus a hypothetical ₹ P&L (see HYPOTHETICAL_CAPITAL_PER_PICK).
// status=open / status=resolved narrows the scorecard to just currently-open
// picks or just picks that have already hit target/stop-loss - the two are
// meant to be read as separate sections (see the frontend), not blended
// into one number that hides which is which.
router.get('/summary', async (req, res) => {
  try {
    const { period, status } = req.query;
    const fromDate = period ? fromDateForPeriod(period) : null;
    const filter = {};
    if (fromDate) filter.recommendedDate = { $gte: fromDate };
    if (status === 'open') { filter.hitTarget = false; filter.hitStopLoss = false; }
    else if (status === 'resolved') { filter.$or = [{ hitTarget: true }, { hitStopLoss: true }]; }

    const docs = await Recommendation.find(filter).lean();
    const blank = () => ({ count: 0, positive: 0, totalReturnPct: 0, hitTarget: 0, hitStopLoss: 0, stillOpen: 0, hypotheticalPnlRupees: 0 });
    const byCategory = {};
    const grandTotal = blank();

    docs.forEach((d) => {
      if (d.changePct === null || d.changePct === undefined) return; // not yet price-updated
      const { outcome, returnPct } = computeOutcomeReturn(d);
      const pnlRupees = (returnPct / 100) * HYPOTHETICAL_CAPITAL_PER_PICK;

      const c = byCategory[d.category] || blank();
      [c, grandTotal].forEach((bucket) => {
        bucket.count += 1;
        if (returnPct > 0) bucket.positive += 1;
        bucket.totalReturnPct += returnPct;
        bucket.hypotheticalPnlRupees += pnlRupees;
        if (outcome === 'target') bucket.hitTarget += 1;
        else if (outcome === 'stopped') bucket.hitStopLoss += 1;
        else bucket.stillOpen += 1;
      });
      byCategory[d.category] = c;
    });

    const toRow = (category, c) => ({
      category,
      totalPicks: c.count,
      winRate: c.count ? Number(((c.positive / c.count) * 100).toFixed(1)) : null,
      avgChangePct: c.count ? Number((c.totalReturnPct / c.count).toFixed(2)) : null,
      hitTargetCount: c.hitTarget,
      hitStopLossCount: c.hitStopLoss,
      resolvedCount: c.hitTarget + c.hitStopLoss, // "combined" filter - target+stop together
      stillOpenCount: c.stillOpen,
      hypotheticalPnlRupees: Math.round(c.hypotheticalPnlRupees),
    });

    const summary = Object.entries(byCategory).map(([category, c]) => toRow(category, c));
    const total = toRow('all', grandTotal);

    res.json({
      period: period || 'all', summary, total,
      hypotheticalCapitalPerPick: HYPOTHETICAL_CAPITAL_PER_PICK,
      note: `hypotheticalPnlRupees assumes an equal ₹${HYPOTHETICAL_CAPITAL_PER_PICK.toLocaleString('en-IN')} stake in every pick, exited exactly at target/SL where hit (or at today's price if still open) - illustrative only, not your real P&L. Use the Trade Journal for that.`,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute recommendation summary' });
  }
});

// GET /api/recommendations/removed?period=1W
// "Ye hat gaya" list - symbols that dropped out of a pick category, with
// an explicit reason each time (score dropped, setup invalidated, or
// simply displaced by stronger candidates).
router.get('/removed', async (req, res) => {
  try {
    const { period, category } = req.query;
    const filter = {};
    if (category) filter.category = category;
    const fromDate = period ? fromDateForPeriod(period) : null;
    if (fromDate) filter.removedDate = { $gte: fromDate };

    const docs = await RemovalEvent.find(filter).sort({ removedDate: -1 }).limit(200).lean();
    res.json({ removals: docs });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load removal history' });
  }
});

// GET /api/recommendations/still-tracking?period=2W
// Symbols that LEFT a Best-of-Today or Golden list recently, but you may
// still be holding. Live quote + original plan → HOLD / EXIT / TRAIL / etc.
router.get('/still-tracking', async (req, res) => {
  try {
    const period = req.query.period || '1M';
    const fromDate = fromDateForPeriod(period) || fromDateForPeriod('1M');
    const trackedCats = [
      'golden_diamond', 'golden_gold', 'golden_silver', 'golden_bronze',
      'short_term', 'long_term', 'momentum', 'reversal',
    ];
    const removals = await RemovalEvent.find({
      removedDate: { $gte: fromDate },
      category: { $in: trackedCats },
    }).sort({ removedDate: -1 }).limit(120).lean();

    const bySymbol = new Map();
    for (const r of removals) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
    }
    const symbols = [...bySymbol.keys()].slice(0, 40);
    if (!symbols.length) return res.json({ items: [], note: 'No recent removals to track.' });

    const marketData = require('../marketData');
    const { analyze } = require('../indicators');
    const { getMarketTrend } = require('../marketTrend');
    const marketContext = await getMarketTrend().catch(() => null);

    const items = [];
    for (const symbol of symbols) {
      const removal = bySymbol.get(symbol);
      try {
        const prior = await Recommendation.findOne({
          symbol,
          category: removal.category,
        }).sort({ recommendedDate: -1 }).lean();

        let price = null;
        let liveVerdict = null;
        let liveScore = null;
        try {
          if (typeof marketData.getQuoteAndHistory === 'function') {
            const { quote, candles } = await marketData.getQuoteAndHistory(symbol, 90);
            price = quote?.lastPrice ?? null;
            if (candles?.length && quote) {
              try {
                const a = analyze(candles, quote, marketContext);
                liveVerdict = a.verdict;
                liveScore = a.score;
              } catch (_) {}
            }
          } else {
            const quote = await marketData.getQuote(symbol);
            price = quote?.lastPrice ?? null;
          }
        } catch (qErr) {
          console.error(`[still-tracking] quote ${symbol}:`, qErr.message);
        }

        // Fallback to removal snapshot price if live quote failed
        if (price == null) price = removal.priceAtRemoval ?? null;

        const entry = prior?.recommendedPrice ?? removal.lastRecommendedPrice ?? null;
        const stop = prior?.stopLoss ?? null;
        const target = prior?.target ?? null;
        const changePct = (entry != null && price != null)
          ? ((price - entry) / entry) * 100
          : (removal.changePctSinceRecommended ?? null);

        let action = 'HOLD';
        let actionLabel = 'HOLD';
        let actionCls = 'neutral';
        const notes = [];
        const pctFromEntry = (entry != null && price != null && entry > 0)
          ? ((price - entry) / entry) * 100 : null;
        const nearStop = stop != null && price != null && entry != null && entry > stop
          ? (price - stop) / (entry - stop) <= 0.25  // bottom 25% of entry→SL band
          : (stop != null && price != null && price <= stop * 1.02);

        if (price == null) {
          notes.push('Live quote nahi mila — last known pe monitor');
        } else if (stop != null && price <= stop) {
          action = 'EXIT';
          actionLabel = 'EXIT';
          actionCls = 'bearish';
          notes.push(`Price SL ke neeche (₹${Number(price).toFixed(1)} ≤ ₹${stop}) — risk plan break, aur downside open`);
        } else if (target != null && price >= target) {
          action = 'BOOK';
          actionLabel = 'BOOK / EXIT';
          actionCls = 'bullish';
          notes.push(`Target hit (₹${Number(price).toFixed(1)} ≥ ₹${target}) — profit book / trail tight`);
        } else if (target != null && entry != null && price >= entry + (target - entry) * 0.6) {
          action = 'TRAIL';
          actionLabel = 'HOLD';
          actionCls = 'bullish';
          notes.push('Profit me hai aur target ke 60%+ pass — recovery nahi, aur upside try; trail SL');
        } else if (nearStop && liveScore != null && liveScore <= -1) {
          action = 'EXIT';
          actionLabel = 'EXIT';
          actionCls = 'bearish';
          notes.push(`SL ke bohot paas + weak tech (${Number(liveScore).toFixed(1)}) — aur niche jaa sakta hai`);
        } else if (pctFromEntry != null && pctFromEntry <= -4 && liveScore != null && liveScore <= -2) {
          action = 'EXIT';
          actionLabel = 'EXIT';
          actionCls = 'bearish';
          notes.push(`Entry se ~${pctFromEntry.toFixed(1)}% down + bearish score — structure weak, recovery thin`);
        } else if (pctFromEntry != null && pctFromEntry < 0 && (liveScore == null || liveScore > -1.5) && (stop == null || price > stop)) {
          action = 'HOLD';
          actionLabel = 'HOLD';
          actionCls = 'neutral';
          notes.push('Abhi entry ke neeche hai lekin SL hold + tech extreme nahi — recovery chance, panic exit mat');
        } else if (pctFromEntry != null && pctFromEntry >= 0) {
          action = 'HOLD';
          actionLabel = 'HOLD';
          actionCls = 'bullish';
          notes.push(liveScore != null && liveScore >= 1
            ? `Profit me + tech ok (${Number(liveScore).toFixed(1)}) — aur move de sakta hai`
            : 'Entry ke upar — target tak room; structure dekh ke hold');
        } else {
          notes.push(stop != null
            ? 'SL ke upar, beech me — plan intact jab tak SL na toote'
            : 'Levels partial — apna SL fix karke monitor');
        }

        items.push({
          symbol,
          category: removal.category,
          removedDate: removal.removedDate,
          reason: removal.reason,
          lastRecommendedPrice: entry,
          priceAtRemoval: removal.priceAtRemoval ?? null,
          currentPrice: price,
          changePctSinceRecommended: changePct != null ? Number(Number(changePct).toFixed(2)) : null,
          stopLoss: stop,
          target,
          action,
          actionLabel,
          actionCls,
          notes,
          liveVerdict,
          liveScore,
          outlookProb7d: removal.outlookProb7d ?? null,
          outlookProb15d: removal.outlookProb15d ?? null,
          outlookProb30d: removal.outlookProb30d ?? null,
        });
        await new Promise((r) => setTimeout(r, 60));
      } catch (err) {
        console.error(`[still-tracking] ${symbol}:`, err.message);
        // Still surface the name so the UI is never empty for known removals
        items.push({
          symbol,
          category: removal.category,
          removedDate: removal.removedDate,
          reason: removal.reason,
          lastRecommendedPrice: removal.lastRecommendedPrice ?? null,
          priceAtRemoval: removal.priceAtRemoval ?? null,
          currentPrice: removal.priceAtRemoval ?? null,
          changePctSinceRecommended: removal.changePctSinceRecommended ?? null,
          stopLoss: null,
          target: null,
          action: 'HOLD',
          actionLabel: 'Hold / monitor — could not fully re-check right now',
          actionCls: 'neutral',
          notes: [err.message],
          liveVerdict: null,
          liveScore: null,
        });
      }
    }

    const byDate = {};
    for (const it of items) {
      const d = it.removedDate || 'unknown';
      byDate[d] = (byDate[d] || 0) + 1;
    }
    res.json({
      items,
      period,
      byDate,
      note: 'HOLD = recovery/upside still possible. EXIT = plan broken or weak + more downside risk. Not a new buy.',
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load still-tracking list' });
  }
});

// GET /api/recommendations/golden?period=1M&tier=diamond
// Rare, exceptional-confluence setups only, now graded into 4 tiers
// (diamond/gold/silver/bronze - see server/stockAnalysisEngine.js
// classifyOpportunityTier). Omit `tier` to get all 4 together.
router.get('/golden', async (req, res) => {
  try {
    const { period, tier } = req.query;
    const filter = tier ? { category: `golden_${tier}` } : { category: { $in: ['golden_diamond', 'golden_gold', 'golden_silver', 'golden_bronze'] } };
    const fromDate = period ? fromDateForPeriod(period) : null;
    if (fromDate) filter.recommendedDate = { $gte: fromDate };
    const docs = await Recommendation.find(filter).sort({ recommendedDate: -1 }).lean();
    res.json({ goldenSetups: docs });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load golden setups' });
  }
});

// GET /api/recommendations/window-accuracy?period=3M
// The honest answer to "tumne kitne din bola tha, kya utne din baad wo
// gaya ya nahi" - groups every logged pick by its predicted holding
// window (7d/15d/30d/30d+) and reports how often that window's prediction
// actually held up, using the persisted windowOutcome (computed in TRADING
// days, not calendar days - see server/marketCalendar.js).
router.get('/window-accuracy', async (req, res) => {
  try {
    const { period, category } = req.query;
    const filter = { predictedWindow: { $ne: null } };
    if (category) filter.category = category;
    const fromDate = period ? fromDateForPeriod(period) : null;
    if (fromDate) filter.recommendedDate = { $gte: fromDate };

    const docs = await Recommendation.find(filter).lean();
    const byWindow = {};
    docs.forEach((d) => {
      const w = byWindow[d.predictedWindow] || { total: 0, hitWithinWindow: 0, hitLate: 0, stoppedOut: 0, notHitInWindow: 0, pending: 0 };
      w.total += 1;
      if (d.windowOutcome === 'hit_within_window') w.hitWithinWindow += 1;
      else if (d.windowOutcome === 'hit_late') w.hitLate += 1;
      else if (d.windowOutcome === 'stopped_out') w.stoppedOut += 1;
      else if (d.windowOutcome === 'not_hit_in_window') w.notHitInWindow += 1;
      else w.pending += 1;
      byWindow[d.predictedWindow] = w;
    });

    const accuracy = Object.entries(byWindow).map(([predictedWindow, w]) => ({
      predictedWindow,
      total: w.total,
      hitWithinWindow: w.hitWithinWindow,
      hitLate: w.hitLate,
      stoppedOut: w.stoppedOut,
      notHitInWindow: w.notHitInWindow,
      pending: w.pending,
      // Accuracy = of the picks whose outcome is actually known yet
      // (excludes 'pending'), how many hit within the predicted window.
      accuracyPct: (w.total - w.pending) > 0 ? Number(((w.hitWithinWindow / (w.total - w.pending)) * 100).toFixed(1)) : null,
    }));

    res.json({ period: period || 'all', accuracy });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute window-prediction accuracy' });
  }
});

// GET /api/recommendations/intraday-history?symbol=RELIANCE&category=momentum
// Every intraday snapshot logged today (or a given date) for a symbol -
// "9:30 baje ye bola tha, 1:00 baje ye tha" answered with real records.
router.get('/intraday-history', async (req, res) => {
  try {
    const { symbol, category, date } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const filter = { symbol: symbol.toUpperCase(), snapshotDate: date || new Date().toISOString().slice(0, 10) };
    if (category) filter.category = category;
    const docs = await IntradaySnapshot.find(filter).sort({ snapshotAt: 1 }).lean();
    res.json({ snapshots: docs });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load intraday history' });
  }
});

// GET /api/recommendations/performance?period=3M&holdingDays=15&category=momentum
// The win-rate/training-data question: "picks made in the last `period`
// (7D/15D/1M/3M/6M/1Y), held for `holdingDays` trading days each - what
// was the actual win rate and average return?" Uses the full priceHistory
// time series (one entry per trading day, since the EOD cron itself skips
// weekends/holidays) - priceHistory[holdingDays-1] IS the price roughly
// `holdingDays` trading days after the pick, so this can answer ANY
// holding-period question in hindsight, not just whatever window the app
// happened to predict at pick time.
router.get('/performance', async (req, res) => {
  try {
    const { period, category, symbol } = req.query;
    const holdingDays = Math.max(1, parseInt(req.query.holdingDays, 10) || 15);
    const filter = {};
    if (category) filter.category = category;
    if (symbol) filter.symbol = symbol.toUpperCase();
    const fromDate = period ? fromDateForPeriod(period) : null;
    if (fromDate) filter.recommendedDate = { $gte: fromDate };

    const docs = await Recommendation.find(filter).lean();
    let evaluated = 0, wins = 0, losses = 0, sumReturn = 0, pendingCount = 0;

    docs.forEach((d) => {
      let outcomeReturn = null;
      // Whichever came first - the actual target/SL hit (using the exact
      // day it happened), or the Nth-trading-day snapshot if neither hit
      // yet within that many days.
      if (d.hitTarget && d.hitTargetDate) {
        const entry = (d.priceHistory || []).find((h) => h.date === d.hitTargetDate);
        outcomeReturn = entry ? entry.changePct : (d.target != null ? ((d.target - d.recommendedPrice) / d.recommendedPrice) * 100 : null);
      } else if (d.hitStopLoss && d.hitStopLossDate) {
        const entry = (d.priceHistory || []).find((h) => h.date === d.hitStopLossDate);
        outcomeReturn = entry ? entry.changePct : (d.stopLoss != null ? ((d.stopLoss - d.recommendedPrice) / d.recommendedPrice) * 100 : null);
      } else if (Array.isArray(d.priceHistory) && d.priceHistory.length >= holdingDays) {
        outcomeReturn = d.priceHistory[holdingDays - 1].changePct;
      } else {
        pendingCount++; // not enough trading days have passed yet to judge at this holding period
        return;
      }
      if (outcomeReturn == null) { pendingCount++; return; }
      evaluated++;
      sumReturn += outcomeReturn;
      if (outcomeReturn > 0) wins++; else losses++;
    });

    res.json({
      period: period || 'all', holdingDays, category: category || 'all', symbol: symbol || 'all',
      totalLogged: docs.length, evaluated, pending: pendingCount, wins, losses,
      winRatePct: evaluated ? Number(((wins / evaluated) * 100).toFixed(1)) : null,
      avgReturnPct: evaluated ? Number((sumReturn / evaluated).toFixed(2)) : null,
      note: 'evaluated excludes picks still pending (fewer trading days have passed than holdingDays, and neither target nor SL has hit yet).',
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute performance' });
  }
});

// GET /api/recommendations/factor-performance
// "🧠 Model Learning" screen's data source - every individual technical
// signal's real, resolved win-rate/avg-return, plus the small bounded
// ranking nudge it's currently earning (see server/factorPerformance.js).
// Sorted by sample size first (the signals with the most evidence behind
// them are the most meaningful to look at), then win rate.
router.get('/factor-performance', async (req, res) => {
  try {
    const rows = await FactorPerformance.find({}).sort({ occurrences: -1, winRate: -1 }).lean();
    const totalResolvedWithFactors = await Recommendation.countDocuments({
      $or: [{ hitTarget: true }, { hitStopLoss: true }],
      'topFactors.0': { $exists: true },
    });
    const totalWithFactors = await Recommendation.countDocuments({
      'topFactors.0': { $exists: true },
    });
    const unresolvedWithFactors = Math.max(0, totalWithFactors - totalResolvedWithFactors);
    const singles = rows.filter((r) => !r.isCombination);
    const combinations = rows.filter((r) => r.isCombination);
    res.json({
      factors: singles,
      combinations,
      totalResolvedWithFactors,
      unresolvedWithFactors,
      totalWithFactors,
      minSampleForAdjustment: MIN_SAMPLE_FOR_ADJUSTMENT,
      maxAdjustment: MAX_ADJUSTMENT,
      baselineWinRate: BASELINE_WIN_RATE,
      hardMinEffective: HARD_MIN_EFFECTIVE,
      cache: getCacheInfo(),
      note: 'Historical Target-Hit / SL-Hit rates are for ranking transparency only — they are NOT future profit probabilities. '
        + 'A signal only earns a ranking nudge once it has appeared in at least '
        + MIN_SAMPLE_FOR_ADJUSTMENT + ' resolved (target-or-stop-loss-hit) picks; below that, stats are shown but influence is zero. '
        + 'The nudge itself is capped at ±' + MAX_ADJUSTMENT + ' points and only ever adjusts ranking on top of Technical + R:R + Market/Sector analysis — it never replaces them. '
        + 'Learning Confidence grows with sample size; walk-forward (recent vs older) validation reduces overfitting.',
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load factor performance' });
  }
});

// POST /api/recommendations/factor-performance/recompute - manual trigger
// (the weekly cron runs this automatically every Sunday morning; this is
// for "I don't want to wait until Sunday" after logging a bunch of new
// resolved outcomes).
router.post('/factor-performance/recompute', async (req, res) => {
  try {
    const result = await recomputeFactorPerformance();
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Recompute failed. Try again shortly.' });
  }
});


// GET /api/recommendations/similar-conditions?regime=CRISIS
router.get('/similar-conditions', async (req, res) => {
  try {
    const regime = req.query.regime || null;
    const tags = req.query.tags ? String(req.query.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const data = await findSimilarHistoricalConditions({ regime, crisisTags: tags, limit });
    res.json(data);
  } catch (err) {
    console.error('[similar-conditions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;