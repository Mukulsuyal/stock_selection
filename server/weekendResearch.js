// server/weekendResearch.js
// "Weekend mein RnD karke Monday ke liye best 5-8 stocks batao, jinme loss
// ki probability negligible ho aur profit ki probability kaafi acchi ho."
//
// The market is closed all weekend, so this is deliberately NOT another
// "refresh every few minutes" list like Top Picks or the Golden Scanner.
// It runs the full Nifty50+Midcap+Smallcap scan ONCE, ranks every valid
// candidate by a composite of its own historical odds of gaining vs
// dropping (see server/probabilityEstimator.js estimateMoveProbability -
// same "n=63 similar past signals on this stock" idea used everywhere
// else in the app, not a guess), and freezes the best handful as "what to
// watch for Monday" until the following weekend.
const { isMongoConfigured } = require('./mongo');
const { getCombinedUniverseScan } = require('./universeScan');
const marketData = require('./marketData');
const { computeScoreBreakdown } = require('./stockAnalysisEngine');
const WeekendPick = require('./recommendations/WeekendPick');

const MIN_SAMPLE_SIZE = 10; // below this, the probability numbers are too noisy to rank on
const STRICT_MAX_LOSS_PROB = 30;   // "negligible" loss odds: dropped 2%+ in under 30% of past similar signals
const STRICT_MIN_PROFIT_PROB = 60; // "high" profit odds: gained 1%+ in 60%+ of past similar signals
const MIN_RISK_REWARD = 2;
const TARGET_COUNT = 8;
const MIN_COUNT = 5;

function nextMondayDateStr(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const daysAhead = day === 0 ? 1 : (day === 1 ? 7 : 8 - day); // if already Monday, means "next" Monday (rare/manual-trigger case)
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// Composite ranking score: rewards high profit odds and technical score/
// risk-reward, PENALIZES loss odds heavily (this list's whole point is
// "negligible loss probability", so that term dominates). Transparent and
// simple on purpose - every input is something already shown elsewhere in
// the app, nothing hidden.
// Same composite weighted breakdown used everywhere else in the app now
// (technical/R:R/momentum/volume/sector/market/historical - see
// computeScoreBreakdown in server/stockAnalysisEngine.js), scaled to the
// same 0-100 range this function's callers already expect. Replaces the
// old bespoke formula that let a strong technical score swamp a bad R:R,
// same issue this whole rewrite exists to fix.
function qualityScoreFor(r, marketContext) {
  return computeScoreBreakdown(r, marketContext).overall;
}

function buildReason(r) {
  const p = r.moveProbability;
  return `${r.verdict || 'Bullish setup'} (technical score ${r.score?.toFixed(1) ?? '?'}). Historically on this stock, a similar signal gained 1%+ within 3 days in ${p.probabilityUp1PctPlus}% of ${p.sampleSize} past cases, gained 5%+ in ${p.probabilityUp5PctPlus}%, and dropped 2%+ in only ${p.probabilityDown2PctPlus}% - based on ${p.sampleSize} similar past signals on this exact stock. R:R is 1:${r.tradePlan.riskRewardRatio}.`;
}

async function runWeekendResearch({ force = false } = {}) {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };

  const forMondayDate = nextMondayDateStr();
  const weekendRunDate = new Date().toISOString().slice(0, 10);

  if (!force) {
    const existing = await WeekendPick.countDocuments({ forMondayDate });
    if (existing > 0) {
      return { ok: true, skipped: true, reason: `Already generated for ${forMondayDate} (${existing} picks). Pass force:true to regenerate.` };
    }
  }

  const { results, symbolToIndex, marketContext } = await getCombinedUniverseScan();

  const candidates = results.filter((r) =>
    !r.error
    && r.tradePlan
    && (r.tradePlan.riskRewardRatio || 0) >= MIN_RISK_REWARD
    && (r.decision === 'BUY NOW' || r.decision === 'BUY ON PULLBACK')
    && r.moveProbability?.status === 'ok'
    && r.moveProbability.sampleSize >= MIN_SAMPLE_SIZE
  );

  const scored = candidates.map((r) => ({
    r,
    qualityScore: qualityScoreFor(r, marketContext),
    meetsStrictBar: r.moveProbability.probabilityDown2PctPlus <= STRICT_MAX_LOSS_PROB
      && r.moveProbability.probabilityUp1PctPlus >= STRICT_MIN_PROFIT_PROB,
  })).sort((a, b) => b.qualityScore - a.qualityScore);

  // Prefer the strict "negligible loss / high profit" bar. Only fall back
  // to the wider ranked pool if too few names clear it outright - and even
  // then, every pick still carries its own meetsStrictBar flag so the UI
  // never overstates confidence on the ones that didn't.
  const strictPool = scored.filter((s) => s.meetsStrictBar);
  const pool = strictPool.length >= MIN_COUNT ? strictPool : scored;
  // Fundamentals pass on top of technical pool (PE/ROE/debt/growth) — soft boost/penalty
  const topForFund = pool.slice(0, Math.min(24, pool.length));
  for (const item of topForFund) {
    try {
      const f = await marketData.getFundamentals(item.r.symbol);
      let boost = 0;
      const pe = f.peTrailing ?? f.peForward;
      const roe = f.roe != null ? (f.roe <= 1 ? f.roe * 100 : f.roe) : null;
      if (pe != null && pe > 0 && pe < 35) boost += 4;
      if (pe != null && pe > 60) boost -= 5;
      if (roe != null && roe > 12) boost += 5;
      if (f.debtToEquity != null && f.debtToEquity < 1) boost += 3;
      if (f.debtToEquity != null && f.debtToEquity > 2) boost -= 4;
      if (f.revenueGrowth != null && f.revenueGrowth > 0.1) boost += 3;
      if (f.earningsGrowth != null && f.earningsGrowth > 0.1) boost += 3;
      if (f.revenueYoY != null && f.revenueYoY > 0.1) boost += 2;
      if (f.profitYoY != null && f.profitYoY > 0.1) boost += 2;
      item.qualityScore += boost;
      item.fundamentalsBoost = boost;
      item.fundSnap = { pe, roe, debtToEquity: f.debtToEquity, revenueGrowth: f.revenueGrowth };
    } catch (_) {
      item.fundamentalsBoost = 0;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  topForFund.sort((a, b) => b.qualityScore - a.qualityScore);
  // Re-merge: boosted names first among pool order
  const boostedSyms = new Set(topForFund.map((x) => x.r.symbol));
  const rest = pool.filter((s) => !boostedSyms.has(s.r.symbol));
  const ranked = [...topForFund, ...rest];
  const chosen = ranked.slice(0, TARGET_COUNT);

  if (!chosen.length) {
    return { ok: true, skipped: false, forMondayDate, count: 0, note: 'No candidates cleared even the relaxed bar this weekend - a genuinely quiet/no-conviction market, not a bug.' };
  }

  await WeekendPick.deleteMany({ forMondayDate }); // in case of a forced regenerate
  const docs = chosen.map(({ r, qualityScore, meetsStrictBar }, i) => {
    const p = r.moveProbability;
    return {
      forMondayDate, weekendRunDate, rank: i + 1,
      symbol: r.symbol, indexLabel: symbolToIndex[r.symbol] || null,
      priceAtResearch: r.price, verdict: r.verdict, technicalScore: r.score, decision: r.decision,
      entryLow: r.tradePlan.entryLow, entryHigh: r.tradePlan.entryHigh,
      stopLoss: r.tradePlan.stopLoss, target: r.tradePlan.target,
      target2: r.tradePlan.target != null ? Number((2 * r.tradePlan.target - r.price).toFixed(2)) : null,
      riskRewardRatio: r.tradePlan.riskRewardRatio,
      profitProbability1Pct: p.probabilityUp1PctPlus, profitProbability5Pct: p.probabilityUp5PctPlus,
      lossProbability2Pct: p.probabilityDown2PctPlus, probabilitySampleSize: p.sampleSize,
      predictedWindow: r.targetTimeline?.status === 'ok' ? r.targetTimeline.suggestedWindow : null,
      predictedWindowDays: r.targetTimeline?.status === 'ok'
        ? ({ '7d': 7, '15d': 15, '30d': 30 }[r.targetTimeline.suggestedWindow] ?? null) : null,
      qualityScore, meetsStrictBar,
      reason: buildReason(r),
      topFactors: (r.topFactors || []).map((f) => ({ factor: f.factor, signal: f.signal })),
      latestPrice: r.price, latestPriceDate: weekendRunDate, changePct: 0,
    };
  });
  await WeekendPick.insertMany(docs);

  return { ok: true, skipped: false, forMondayDate, count: docs.length, strictCount: strictPool.length };
}

// Keeps each weekend pick's latestPrice/changePct/hit-flags fresh once the
// market reopens Monday, same idea as updateRecommendationPrices but much
// lighter - at most 8 rows a week, and querying only still-open ones means
// this naturally stops touching a pick the moment it resolves (no
// unbounded daily-history array here at all, so there's nothing to retire
// later the way Recommendation rows need trackingStopped for).
async function updateWeekendPickPrices() {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  const marketData = require('./marketData');
  const openPicks = await WeekendPick.find({ hitTarget: false, hitStopLoss: false });
  if (!openPicks.length) return { ok: true, updated: 0 };
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0, failed = 0;
  for (const doc of openPicks) {
    try {
      const quote = await marketData.getQuote(doc.symbol);
      const price = quote.lastPrice;
      if (!price) continue;
      const changePct = ((price - doc.priceAtResearch) / doc.priceAtResearch) * 100;
      const hitTarget = doc.target ? price >= doc.target : false;
      const hitStopLoss = !hitTarget && doc.stopLoss ? price <= doc.stopLoss : false;
      await WeekendPick.updateOne({ _id: doc._id }, {
        $set: {
          latestPrice: price, latestPriceDate: today, changePct,
          hitTarget, hitStopLoss,
          hitTargetDate: hitTarget && !doc.hitTarget ? today : doc.hitTargetDate,
          hitStopLossDate: hitStopLoss && !doc.hitStopLoss ? today : doc.hitStopLossDate,
        },
      });
      updated++;
    } catch (err) {
      failed++;
    }
  }
  return { ok: true, updated, failed };
}

module.exports = { runWeekendResearch, updateWeekendPickPrices, nextMondayDateStr };
