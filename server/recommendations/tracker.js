// server/recommendations/tracker.js
// Daily jobs that together answer "tumne jo bola tha lo, wo sahi nikla ya
// nahi, aur jo hat gaya wo kyun hata":
//   1. logDailyRecommendations() - snapshots today's Top Picks, Swing
//      Setups, and rare Golden Setups (same picks the UI shows) into
//      MongoDB, price frozen at the moment of picking. Also detects which
//      symbols from the PREVIOUS day's lists no longer qualify today and
//      logs a RemovalEvent with a concrete reason - nothing just silently
//      disappears.
//   2. updateRecommendationPrices() - refreshes `latestPrice` (the closing
//      price, since this runs after market close) on EVERY previously
//      logged recommendation, so 1-week/15-day/1-month performance stays
//      trackable, not just the day a pick was made.
const marketData = require('../marketData');
const { mapLimit, analyzeOne, computeTopPicks, computeSwingSetups, computeTieredOpportunities } = require('../stockAnalysisEngine');
const { getMarketTrend } = require('../marketTrend');
const { INDEXES } = require('../indexConstituents');
const { isMongoConfigured } = require('../mongo');
const { countTradingDaysBetween, getTradingDayStatus } = require('../marketCalendar');
const Recommendation = require('./Recommendation');
const { getMarketRegime } = require('../marketRegimeDetector');
const { getFiiDiiAggregate } = require('../institutional/aggregations');
const { computeTrackedUniverseBreadth } = require('../marketBreadth');
const { getSectorMap } = require('../institutional/sectorSync');
const RemovalEvent = require('./RemovalEvent');
const IntradaySnapshot = require('./IntradaySnapshot');

const WINDOW_DAYS = { '7d': 7, '15d': 15, '30d': 30, '30d_plus': null }; // 30d_plus has no fixed cutoff by definition

function buildReason(currentResult, priorRow) {
  if (!currentResult || currentResult.error) return 'Could not re-analyze today (data unavailable).';
  if (currentResult.score <= 0) {
    return `Technical score dropped to ${currentResult.score.toFixed(1)} (was ${priorRow.score?.toFixed(1) ?? '-'}) — verdict now "${currentResult.verdict}".`;
  }
  if (priorRow.category === 'momentum' && currentResult.setup?.type !== 'momentum') {
    return `No longer shows a momentum setup (score ${currentResult.score.toFixed(1)}, verdict "${currentResult.verdict}").`;
  }
  if (priorRow.category === 'reversal' && currentResult.setup?.type !== 'reversal') {
    return 'Reversal/bounce setup no longer valid — the bounce faded or it kept falling.';
  }
  if (priorRow.category?.startsWith('golden_')) {
    const tierName = priorRow.category.replace('golden_', '');
    return `No longer meets the ${tierName} tier's bar (score ${currentResult.score.toFixed(1)}, R:R ${currentResult.tradePlan?.riskRewardRatio ?? '-'}, vol spike ${currentResult.volSpike?.toFixed(1) ?? '-'}x).`;
  }
  return `Still positive (score ${currentResult.score.toFixed(1)}) but displaced by stronger candidates today — ranked outside today's top picks.`;
}

async function detectRemovals(results, today) {
  const priorDoc = await Recommendation.findOne({ recommendedDate: { $lt: today } }).sort({ recommendedDate: -1 }).lean();
  if (!priorDoc) return { removed: 0 };
  const priorDate = priorDoc.recommendedDate;

  const [priorRows, todayRows] = await Promise.all([
    Recommendation.find({ recommendedDate: priorDate }).lean(),
    Recommendation.find({ recommendedDate: today }).lean(),
  ]);
  const todayKeys = new Set(todayRows.map((r) => `${r.symbol}|${r.category}`));
  const resultsBySymbol = Object.fromEntries(results.map((r) => [r.symbol, r]));

  let removed = 0;
  for (const row of priorRows) {
    const key = `${row.symbol}|${row.category}`;
    if (todayKeys.has(key)) continue; // still active today, nothing to log

    const current = resultsBySymbol[row.symbol];
    const reason = buildReason(current, row);
    const priceAtRemoval = current?.price ?? row.latestPrice ?? null;
    const changePctSinceRecommended = priceAtRemoval && row.recommendedPrice
      ? ((priceAtRemoval - row.recommendedPrice) / row.recommendedPrice) * 100
      : null;

    try {
      await RemovalEvent.create({
        symbol: row.symbol, category: row.category, removedDate: today,
        lastRecommendedDate: row.recommendedDate, lastRecommendedPrice: row.recommendedPrice,
        priceAtRemoval, changePctSinceRecommended, reason,
      });
      removed++;
    } catch (err) {
      console.error(`[recommendations] failed to log removal for ${row.symbol}/${row.category}:`, err.message);
    }
  }
  return { removed };
}

// Upserts a list of {symbol, category, ...} rows into Recommendation for
// `today` - first-seen-wins ($setOnInsert), so calling this more than once
// for the same symbol+category+day is always safe/idempotent. Shared by
// the scheduled cron jobs AND any live/manual scan (e.g. clicking "Rescan"
// on the Golden Opportunity Scanner, or just opening an index tab) so a
// live-only sighting still gets a permanent DB record instead of only
// being caught if the timing happened to line up with a cron run - this is
// what makes "isne aaj ye diya tha" actually checkable later, for every
// tier/category, not just the ones a scheduled job happened to catch.
async function logRowsForToday(rows, today = new Date().toISOString().slice(0, 10)) {
  if (!isMongoConfigured()) return 0;
  // Weekends and NSE holidays: the market never opened, so whatever the
  // scan shows is stale data being re-scored, not a real new pick for
  // today - it must never get written as if it were one. This used to
  // only be checked by the scheduled cron jobs; live browsing (opening an
  // index tab, hitting "Rescan") went through this same function without
  // the check, so weekend/holiday browsing was quietly logging rows into
  // Track Record anyway. Centralizing the check here covers every caller,
  // present and future, in one place.
  const tradingDayStatus = await getTradingDayStatus();
  if (!tradingDayStatus.isTradingDay) return 0;
  let learningContext = null;
  try {
    learningContext = await getMarketRegime();
  } catch (_) {}
  let sectorMap = {};
  try {
    sectorMap = await getSectorMap() || {};
  } catch (_) {}
  try {
    const fiiDii = await getFiiDiiAggregate('1D');
    if (learningContext && fiiDii) {
      learningContext = {
        ...learningContext,
        fiiDii: {
          fiiNetCr: fiiDii.fii?.netValueCr ?? null,
          diiNetCr: fiiDii.dii?.netValueCr ?? null,
          date: fiiDii.to || fiiDii.from || null,
        },
      };
    }
  } catch (_) {}
  // Tracked-universe breadth (not full NSE) — best-effort from scan cache
  try {
    const { getCombinedUniverseScan } = require('../universeScan');
    const scan = await getCombinedUniverseScan();
    if (learningContext && scan?.results?.length) {
      const breadth = computeTrackedUniverseBreadth(scan.results);
      learningContext = {
        ...learningContext,
        marketBreadth: breadth,
      };
    }
  } catch (_) {}
  let logged = 0;
  for (const r of rows) {
    if (!r._learningContext && learningContext) r._learningContext = learningContext;
    if (!r.price) continue;
    // What the app predicted, at the moment of picking, about how long
    // this would take to reach its target (see targetTimeline /
    // estimateTargetTimeline) - saved now so it can be checked later:
    // "tumne 15 din bola tha, kya 15 din baad wo gaya ya nahi".
    const predictedWindow = r.targetTimeline?.status === 'ok' ? r.targetTimeline.suggestedWindow : null;
    const target = r.tradePlan?.target ?? null;
    // "2nd target" - an equal further extension beyond the original target,
    // measured from the entry price (if it moved from entry to target once,
    // did it make that same-size move again afterwards). Purely this app's
    // own follow-through measure, not from any official source.
    const target2 = target != null ? Number((2 * target - r.price).toFixed(2)) : null;
    const mctx = r._learningContext || null;
    const doc = {
      symbol: r.symbol, category: r.category, recommendedDate: today, recommendedPrice: r.price,
      verdict: r.verdict, score: r.score,
      entryLow: r.tradePlan?.entryLow ?? null, entryHigh: r.tradePlan?.entryHigh ?? null,
      stopLoss: r.tradePlan?.stopLoss ?? null, target, target2,
      riskRewardRatio: r.tradePlan?.riskRewardRatio ?? null,
      predictedWindow, predictedWindowDays: predictedWindow ? WINDOW_DAYS[predictedWindow] : null,
      latestPrice: r.price, latestPriceDate: today, changePct: 0,
      topFactors: (r.topFactors || []).map((f) => ({ factor: f.factor, signal: f.signal })),
      // Model Learning context snapshot (additive)
      learningRegime: mctx?.learningRegime || r.learningRegime || null,
      crisisTags: mctx?.crisisTags || r.crisisTags || [],
      sectorAtPick: r.sector || r.sectorName || sectorMap[r.symbol] || mctx?.sector || null,
      marketContextAtPick: mctx ? {
        nifty: mctx.nifty || null,
        bankNifty: mctx.bankNifty || null,
        indiaVix: mctx.indiaVix || null,
        macro: mctx.macro || null,
        fiiDii: mctx.fiiDii || null,
        marketBreadth: mctx.marketBreadth || null,
        trendRegime: mctx.trendRegime || null,
        learningRegime: mctx.learningRegime || null,
        crisisTags: mctx.crisisTags || [],
        asOf: mctx.asOf || null,
      } : null,
      // Fundamentals at pick time (for Model Learning — additive, free data)
      fundamentalsAtPick: r.fundamentals ? {
        pe: r.fundamentals.peTrailing ?? r.fundamentals.peForward ?? null,
        pb: r.fundamentals.priceToBook ?? null,
        roe: r.fundamentals.roe ?? null,
        debtToEquity: r.fundamentals.debtToEquity ?? null,
        profitMargin: r.fundamentals.profitMargin ?? null,
        revenueGrowth: r.fundamentals.revenueGrowth ?? null,
        earningsGrowth: r.fundamentals.earningsGrowth ?? null,
        source: r.fundamentals.source || null,
      } : null,
    };
    try {
      // $setOnInsert only - if today's row for this symbol+category already
      // exists (an earlier scan today already logged it), leave it as
      // first logged, don't reset the entry price to a later scan's price.
      await Recommendation.updateOne(
        { symbol: doc.symbol, category: doc.category, recommendedDate: doc.recommendedDate },
        { $setOnInsert: doc },
        { upsert: true }
      );
      logged++;
    } catch (err) {
      console.error(`[recommendations] failed to log ${r.symbol}/${r.category}:`, err.message);
    }
  }
  return logged;
}

// Flattens topPicks/swing/tier results into {..., category} rows ready for
// logRowsForToday. Best of Today uses short_term/long_term/momentum/reversal
// only (no intraday from index tabs). Golden uses golden_* tiers.
function buildRowsToLog({ topPicks = null, swing = null, tiers = null, bestOfTodayOnly = false }) {
  const rows = [];
  if (topPicks) {
    const cats = bestOfTodayOnly ? ['short_term', 'long_term'] : ['intraday', 'short_term', 'long_term'];
    cats.forEach((cat) => (topPicks[cat] || []).forEach((r) => rows.push({ ...r, category: cat })));
  }
  if (swing) {
    ['momentum', 'reversal'].forEach((cat) => (swing[cat] || []).forEach((r) => rows.push({ ...r, category: cat })));
  }
  if (tiers) {
    ['diamond', 'gold', 'silver', 'bronze'].forEach((tier) => (tiers[tier] || []).forEach((r) => rows.push({ ...r, category: `golden_${tier}` })));
  }
  return rows;
}

// Write intraday snapshot rows for Best of Today / Golden only.
// Safe to call often; each call creates a new timestamped row (not unique).
async function logIntradaySnapshotRows(rows) {
  if (!isMongoConfigured() || !rows?.length) return 0;
  const tradingDayStatus = await getTradingDayStatus();
  if (!tradingDayStatus.isTradingDay) return 0;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let logged = 0;
  for (const r of rows) {
    if (!r.price || !r.symbol || !r.category) continue;
    try {
      await IntradaySnapshot.create({
        symbol: r.symbol, category: r.category, snapshotDate: today, snapshotAt: now, price: r.price,
        verdict: r.verdict, score: r.score,
        entryLow: r.tradePlan?.entryLow ?? null, entryHigh: r.tradePlan?.entryHigh ?? null,
        stopLoss: r.tradePlan?.stopLoss ?? null, target: r.tradePlan?.target ?? null,
        riskRewardRatio: r.tradePlan?.riskRewardRatio ?? null,
        probabilityUp1PctPlus: r.moveProbability?.probabilityUp1PctPlus ?? null,
        probabilityUp5PctPlus: r.moveProbability?.probabilityUp5PctPlus ?? null,
        probabilityDown2PctPlus: r.moveProbability?.probabilityDown2PctPlus ?? null,
      });
      logged++;
    } catch (err) {
      console.error(`[intradaySnapshot] failed to log ${r.symbol}/${r.category}:`, err.message);
    }
  }
  if (logged) console.log(`[intradaySnapshot] logged ${logged} snapshot(s) at ${now.toLocaleTimeString()} (best-of-today / golden)`);
  return logged;
}

// Daily / cron recommendation log: FULL combined universe, but ONLY the two
// surfaces the user tracks — Best of Today (short/long/momentum/reversal)
// and Golden Opportunity tiers. Individual Nifty50/Midcap/Smallcap tab
// scans never call this.
async function logDailyRecommendations(_indexNameIgnored) {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };

  // Lazy require avoids circular dependency with universeScan -> engine
  const { getCombinedUniverseScan } = require('../universeScan');
  const { results, marketContext } = await getCombinedUniverseScan();
  const topPicks = computeTopPicks(results, marketContext);
  const swing = computeSwingSetups(results, marketContext);
  const tiers = computeTieredOpportunities(results);
  const today = new Date().toISOString().slice(0, 10);

  // Best of Today: only #1 per category (same as the home screen)
  const bestOfTodayRows = [];
  if (topPicks.short_term?.[0]) bestOfTodayRows.push({ ...topPicks.short_term[0], category: 'short_term' });
  if (topPicks.long_term?.[0]) bestOfTodayRows.push({ ...topPicks.long_term[0], category: 'long_term' });
  if (swing.momentum?.[0]) bestOfTodayRows.push({ ...swing.momentum[0], category: 'momentum' });
  if (swing.reversal?.[0]) bestOfTodayRows.push({ ...swing.reversal[0], category: 'reversal' });

  const goldenRows = buildRowsToLog({ tiers });
  const rowsToLog = [...bestOfTodayRows, ...goldenRows];
  const logged = await logRowsForToday(rowsToLog, today);

  const { removed } = await detectRemovals(results, today);
  const goldenCount = tiers.diamond.length + tiers.gold.length + tiers.silver.length + tiers.bronze.length;

  console.log(`[recommendations] logged ${logged} pick(s) (Best of Today ${bestOfTodayRows.length} + 💎${tiers.diamond.length}/🥇${tiers.gold.length}/🥈${tiers.silver.length}/🥉${tiers.bronze.length}), ${removed} removal(s) for ${today}`);
  try {
    const { notifyGoldenTiers } = require('../mobileNotify');
    if (goldenCount > 0) {
      notifyGoldenTiers(tiers).catch((e) => console.warn('[mobileNotify]', e.message));
    }
  } catch (e) { console.warn('[mobileNotify] golden hook', e.message); }
  return { ok: true, date: today, logged, goldenCount, removed, bestOfToday: bestOfTodayRows.length };
}

// One-time-per-record backfill: records that already had hitTarget/
// hitStopLoss=true BEFORE this exact-date/price/days-taken tracking was
// added (see hitTargetPrice etc. in Recommendation.js) would otherwise show
// "?" for those details forever, since the EOD loop above only fills them
// the moment a hit is FIRST detected. This reconstructs them from the
// already-stored daily priceHistory (find the first day price actually
// crossed the level) - safe to re-run, only touches records missing these
// fields. Also backfills target2 (added at the same time) for old records
// that predate it.
async function backfillHitDetails() {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  const docs = await Recommendation.find({
    $or: [
      { hitTarget: true, hitTargetPrice: null },
      { hitStopLoss: true, hitStopLossPrice: null },
      { target: { $ne: null }, target2: null },
    ],
  });
  let fixed = 0;
  for (const doc of docs) {
    const updates = {};
    if (doc.target != null && doc.target2 == null) {
      updates.target2 = Number((2 * doc.target - doc.recommendedPrice).toFixed(2));
    }
    const history = Array.isArray(doc.priceHistory) ? doc.priceHistory : [];
    if (doc.hitTarget && doc.hitTargetPrice == null && doc.target != null && history.length) {
      const entry = history.find((h) => h.price >= doc.target);
      if (entry) {
        updates.hitTargetDate = entry.date;
        updates.hitTargetPrice = entry.price;
        updates.daysToHitTarget = await countTradingDaysBetween(doc.recommendedDate, entry.date);
        const target2 = updates.target2 ?? doc.target2;
        if (target2 != null) {
          const t2Entry = history.find((h) => h.price >= target2);
          if (t2Entry) {
            updates.hitTarget2 = true;
            updates.hitTarget2Date = t2Entry.date;
            updates.hitTarget2Price = t2Entry.price;
            updates.daysToHitTarget2 = await countTradingDaysBetween(doc.recommendedDate, t2Entry.date);
          }
        }
      }
    }
    if (doc.hitStopLoss && doc.hitStopLossPrice == null && doc.stopLoss != null && history.length) {
      const entry = history.find((h) => h.price <= doc.stopLoss);
      if (entry) {
        updates.hitStopLossDate = entry.date;
        updates.hitStopLossPrice = entry.price;
        updates.daysToHitStopLoss = await countTradingDaysBetween(doc.recommendedDate, entry.date);
      }
    }
    if (Object.keys(updates).length) {
      await Recommendation.updateOne({ _id: doc._id }, { $set: updates });
      fixed++;
    }
  }
  if (fixed) console.log(`[recommendations] backfilled hit-detail fields for ${fixed} historical record(s)`);
  return { ok: true, fixed };
}

async function updateRecommendationPrices() {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  // Only symbols that still have at least one row worth tracking - a
  // symbol whose every logged pick has long since resolved (or expired)
  // doesn't need a fresh quote fetched for it at all anymore.
  const symbols = await Recommendation.distinct('symbol', { trackingStopped: { $ne: true } });
  if (!symbols.length) return { ok: true, updated: 0 };
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0, failed = 0, stopped = 0, newlyResolved = 0;

  await mapLimit(symbols, 4, async (symbol) => {
    try {
      const quote = await marketData.getQuote(symbol);
      const price = quote.lastPrice; // job runs after market close - this is effectively the day's EOD price
      if (!price) return;
      const docs = await Recommendation.find({ symbol, trackingStopped: { $ne: true } });
      for (const doc of docs) {
        const changePct = ((price - doc.recommendedPrice) / doc.recommendedPrice) * 100;
        // One-time correction for docs written before the fix below existed:
        // if a doc somehow has BOTH hitTarget and hitStopLoss true, target
        // wins and the stale stop-loss hit-flags get cleared here so old
        // data self-heals the next time this job touches that symbol.
        const corrupted = doc.hitTarget && doc.hitStopLoss;
        const wasHitTarget = doc.hitTarget;
        const wasHitStopLoss = corrupted ? false : doc.hitStopLoss;
        const wasHitTarget2 = doc.hitTarget2;
        // Once the target has been hit, that pick is a WIN - full stop.
        // A later pullback below the stop-loss level must never retroactively
        // also mark it "stopped out" (that used to happen, and made the
        // Track Record table show a pick as both "target hit" AND
        // "stop-loss hit" at once, which makes no sense to read). The
        // underlying price is still tracked either way via latestPrice/
        // changePct below, just not folded into the hit-flags anymore.
        const hitStopLoss = wasHitStopLoss || (!wasHitTarget && doc.stopLoss ? price <= doc.stopLoss : false);
        const hitTarget = wasHitTarget || (doc.target ? price >= doc.target : false);
        // 2nd target only makes sense to check once the 1st is already hit.
        const hitTarget2 = wasHitTarget2 || (hitTarget && doc.target2 ? price >= doc.target2 : false);
        const hitStopLossDateBase = corrupted ? null : doc.hitStopLossDate;
        const hitStopLossPriceBase = corrupted ? null : doc.hitStopLossPrice;
        const daysToHitStopLossBase = corrupted ? null : doc.daysToHitStopLoss;

        // First day any of these flips true - freeze the EXACT date AND
        // price at that moment (not today's, possibly since-reversed,
        // price), plus how many TRADING days it took from the pick date -
        // so "kab, kis price pe, kitne din mein" is always answerable
        // later instead of only ever showing a plain hit/not-hit flag.
        const hitTargetDate = !wasHitTarget && hitTarget ? today : doc.hitTargetDate;
        const hitStopLossDate = !wasHitStopLoss && hitStopLoss ? today : hitStopLossDateBase;
        const hitTarget2Date = !wasHitTarget2 && hitTarget2 ? today : doc.hitTarget2Date;
        const hitTargetPrice = !wasHitTarget && hitTarget ? price : doc.hitTargetPrice;
        const hitStopLossPrice = !wasHitStopLoss && hitStopLoss ? price : hitStopLossPriceBase;
        const hitTarget2Price = !wasHitTarget2 && hitTarget2 ? price : doc.hitTarget2Price;

        const daysToHitTarget = !wasHitTarget && hitTarget
          ? await countTradingDaysBetween(doc.recommendedDate, today) : doc.daysToHitTarget;
        const daysToHitStopLoss = !wasHitStopLoss && hitStopLoss
          ? await countTradingDaysBetween(doc.recommendedDate, today) : daysToHitStopLossBase;
        const daysToHitTarget2 = !wasHitTarget2 && hitTarget2
          ? await countTradingDaysBetween(doc.recommendedDate, today) : doc.daysToHitTarget2;

        // Was the predicted holding-period window (7d/15d/30d) actually
        // right? Computed in TRADING days (see countTradingDaysBetween),
        // never calendar days - so a Fri->Mon gap never looks like "2 days".
        let windowOutcome = doc.windowOutcome;
        if (windowOutcome === 'pending' || windowOutcome == null) {
          if (hitTarget && hitTargetDate) {
            const elapsed = daysToHitTarget ?? await countTradingDaysBetween(doc.recommendedDate, hitTargetDate);
            if (doc.predictedWindowDays == null) {
              // predictedWindow was '30d_plus' (no fixed cutoff) or wasn't
              // computed at all - hitting the target at all still counts
              // as a win, just can't be graded against a specific window.
              windowOutcome = 'hit_within_window';
            } else {
              windowOutcome = elapsed <= doc.predictedWindowDays ? 'hit_within_window' : 'hit_late';
            }
          } else if (hitStopLoss) {
            windowOutcome = 'stopped_out';
          } else if (doc.predictedWindowDays != null) {
            const elapsedSinceRec = await countTradingDaysBetween(doc.recommendedDate, today);
            if (elapsedSinceRec > doc.predictedWindowDays) windowOutcome = 'not_hit_in_window';
          }
          // else: predictedWindow is '30d_plus' or unknown and neither
          // target nor SL hit yet - stays 'pending' indefinitely, since
          // that tier has no fixed deadline to grade against.
        }

        // Append today's close to the full history (skip if this doc was
        // already updated today - e.g. job re-run). This is what lets us
        // answer "what was the price N trading days after this pick" for
        // ANY N later, not just whatever window was predicted at pick time.
        const priceHistory = Array.isArray(doc.priceHistory) ? [...doc.priceHistory] : [];
        if (!priceHistory.length || priceHistory[priceHistory.length - 1].date !== today) {
          priceHistory.push({ date: today, price, changePct: Number(changePct.toFixed(2)) });
        }

        // The story is over once either: (a) target or stop-loss hit at
        // least 10 trading days ago - the outcome is settled, no further
        // price action changes what already happened; or (b) neither ever
        // hit AND the predicted window (7d/15d/30d) expired 20+ trading
        // days ago - it missed its window long enough ago that continuing
        // to check it daily forever adds nothing. Once true, this row is
        // excluded from the query at the top of this function from
        // tomorrow onward - priceHistory freezes at whatever it is right now.
        let trackingStopped = false;
        const resolvedDate = hitTarget ? hitTargetDate : (hitStopLoss ? hitStopLossDate : null);
        if (resolvedDate) {
          const daysSinceResolved = await countTradingDaysBetween(resolvedDate, today);
          if (daysSinceResolved >= 10) trackingStopped = true;
        } else if (doc.predictedWindowDays != null) {
          const elapsedSinceRec = await countTradingDaysBetween(doc.recommendedDate, today);
          if (elapsedSinceRec - doc.predictedWindowDays >= 20) trackingStopped = true;
        }
        if (trackingStopped) stopped++;

        // Max adverse / favorable excursion from entry across priceHistory
        let maxAdversePct = doc.maxAdversePct ?? null;
        let maxFavorablePct = doc.maxFavorablePct ?? null;
        if (doc.recommendedPrice && priceHistory.length) {
          let mae = 0, mfe = 0;
          for (const p of priceHistory) {
            if (p.price == null) continue;
            const ch = ((p.price - doc.recommendedPrice) / doc.recommendedPrice) * 100;
            if (ch < mae) mae = ch;
            if (ch > mfe) mfe = ch;
          }
          maxAdversePct = Number(mae.toFixed(2));
          maxFavorablePct = Number(mfe.toFixed(2));
        }
        let holdingDaysToResolve = doc.holdingDaysToResolve ?? null;
        if (holdingDaysToResolve == null) {
          if (hitTarget && daysToHitTarget != null) holdingDaysToResolve = daysToHitTarget;
          else if (hitStopLoss && daysToHitStopLoss != null) holdingDaysToResolve = daysToHitStopLoss;
        }

        await Recommendation.updateOne(
          { _id: doc._id },
          {
            $set: {
              latestPrice: price, latestPriceDate: today, changePct,
              hitStopLoss, hitTarget, hitTarget2,
              hitTargetDate, hitStopLossDate, hitTarget2Date,
              hitTargetPrice, hitStopLossPrice, hitTarget2Price,
              daysToHitTarget, daysToHitStopLoss, daysToHitTarget2,
              windowOutcome, priceHistory, trackingStopped,
              maxAdversePct, maxFavorablePct, holdingDaysToResolve,
            },
          }
        );
        updated++;
      }
    } catch (err) {
      failed++;
    }
  });
  console.log(`[recommendations] EOD price-updated ${updated} record(s), ${failed} symbol(s) failed, ${stopped} row(s) newly retired from tracking, ${newlyResolved} newly resolved`);
  // Auto-recompute Model Learning when enough NEW resolutions accumulate
  // (Sunday cron still runs; this is the mid-week refresh so learning
  // does not stay stale for 6 days after a busy week of target/SL hits).
  const AUTO_RECOMPUTE_THRESHOLD = Number(process.env.LEARNING_AUTO_RECOMPUTE_EVERY || 10);
  let learningRecompute = null;
  if (newlyResolved >= AUTO_RECOMPUTE_THRESHOLD) {
    try {
      const { recomputeFactorPerformance } = require('../factorPerformance');
      learningRecompute = await recomputeFactorPerformance();
      console.log(`[recommendations] auto Model Learning recompute after ${newlyResolved} new resolutions:`, learningRecompute?.factorsTracked);
    } catch (err) {
      console.error('[recommendations] auto learning recompute failed:', err.message);
      learningRecompute = { ok: false, error: err.message };
    }
  }
  return { ok: true, updated, failed, stopped, newlyResolved, learningRecompute };
}

// Logs a full point-in-time snapshot of today's picks (every category,
// including price/SL/target/probability AT THAT MOMENT) - called several
// times during market hours so "9:30 baje ye bola tha, 1:00 baje ye tha"
// has an actual answer instead of only one end-of-day number. Cheap to
// run often: reuses the same bulk scan logic, no extra data sources.
// Intraday snapshots for cron: same universe as Best of Today + Golden only.
async function logIntradaySnapshot(_indexNameIgnored) {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };

  const { getCombinedUniverseScan } = require('../universeScan');
  const { results, marketContext } = await getCombinedUniverseScan();
  const topPicks = computeTopPicks(results, marketContext);
  const swing = computeSwingSetups(results, marketContext);
  const tiers = computeTieredOpportunities(results);

  const bestOfTodayRows = [];
  if (topPicks.short_term?.[0]) bestOfTodayRows.push({ ...topPicks.short_term[0], category: 'short_term' });
  if (topPicks.long_term?.[0]) bestOfTodayRows.push({ ...topPicks.long_term[0], category: 'long_term' });
  if (swing.momentum?.[0]) bestOfTodayRows.push({ ...swing.momentum[0], category: 'momentum' });
  if (swing.reversal?.[0]) bestOfTodayRows.push({ ...swing.reversal[0], category: 'reversal' });

  const goldenRows = buildRowsToLog({ tiers });
  const rowsToLog = [...bestOfTodayRows, ...goldenRows];
  const logged = await logIntradaySnapshotRows(rowsToLog);
  try {
    const { notifyGoldenTiers } = require('../mobileNotify');
    if ((tiers.diamond?.length || 0) + (tiers.gold?.length || 0) + (tiers.silver?.length || 0) + (tiers.bronze?.length || 0) > 0) {
      notifyGoldenTiers(tiers).catch((e) => console.warn('[mobileNotify]', e.message));
    }
  } catch (e) { console.warn('[mobileNotify] intraday golden', e.message); }
  return { ok: true, at: new Date().toISOString(), logged };
}

// Kept for backward-compatible exports / logs. Logging no longer scans each
// index separately — one combined-universe pass covers Best of Today + Golden.
const TRACKED_INDEXES = ['combined'];

// Runs the tracker fn once (combined universe). Signature kept so server.js
// cron/startup calls stay unchanged.
async function runForTrackedIndexes(fn, label) {
  const results = {};
  try {
    results.combined = await fn('combined');
  } catch (err) {
    console.error(`[recommendations] ${label} failed:`, err.message);
    results.combined = { ok: false, error: err.message };
  }
  return results;
}

module.exports = {
  logDailyRecommendations, updateRecommendationPrices, detectRemovals, logIntradaySnapshot,
  logIntradaySnapshotRows,
  TRACKED_INDEXES, runForTrackedIndexes, logRowsForToday, buildRowsToLog, backfillHitDetails, buildReason,
};
