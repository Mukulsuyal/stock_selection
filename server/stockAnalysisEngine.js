// server/stockAnalysisEngine.js
// Shared helpers used by both the Bulk Screener/Index Browser routes and
// the daily recommendation tracker - kept in one place so both use the
// exact same analysis logic (no risk of the two drifting apart).
const marketData = require('./marketData');
const { analyze } = require('./indicators');
const { estimateMoveProbability, estimateTargetTimeline } = require('./probabilityEstimator');
const { computeRelativeStrength } = require('./relativeStrength');
const { detectBreakout } = require('./breakoutEngine');
const { computeFinalDecision } = require('./decisionEngine');
const { getAdaptiveAdjustment, isLearningFilterReady, learningFilterStatus, setCurrentLearningRegime, getCurrentLearningRegime } = require('./factorPerformance');

// Run `fn` over `items` with at most `limit` in flight at once - keeps us
// from firing 50-100 simultaneous requests at Yahoo Finance, which tends to
// trigger throttling. `onProgress(completedCount, total)`, if given, fires
// after each item finishes - purely so a caller (e.g. an HTTP route) can
// mirror real progress out to something pollable, like server/progressStore.js.
async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      completed++;
      if (onProgress) onProgress(completed, items.length);
      // Small breather between requests within each worker - keeps total
      // request rate gentler on Yahoo's free endpoint so a big index/bulk
      // scan doesn't get the server's IP temporarily rate-limited.
      await new Promise((r) => setTimeout(r, 90));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function analyzeOne(symbol, marketContext) {
  try {
    // Prefer a single Yahoo chart call (quote meta + history) when available —
    // halves outbound requests per symbol during bulk scans. Falls back to the
    // classic two-call path if the combined helper is missing.
    let quote, candles;
    if (typeof marketData.getQuoteAndHistory === 'function') {
      const combined = await marketData.getQuoteAndHistory(symbol, 1260);
      quote = combined.quote;
      candles = combined.candles;
    } else {
      [quote, candles] = await Promise.all([
        marketData.getQuote(symbol),
        marketData.getHistorical(symbol, 1260),
      ]);
    }
    if (!candles.length) return { symbol, error: 'No historical data found' };
    const a = analyze(candles, quote, marketContext);
    const moveProbability = estimateMoveProbability(candles);
    const relativeStrength = computeRelativeStrength(a.periodReturns, marketContext?.periodReturns);
    const breakout = detectBreakout(candles, a.indicators.volSpike);
    // "Kitne din mein result milega" - how long, historically, similar
    // signals on THIS stock have taken to reach the current target %.
    // Momentum setups often resolve fast; reversal/oversold-bounce setups
    // often genuinely need more time - this measures that from the
    // stock's own past behavior rather than assuming from setup type alone.
    const targetTimeline = a.tradePlan && a.price
      ? estimateTargetTimeline(candles, ((a.tradePlan.target - a.price) / a.price) * 100)
      : { status: 'unavailable' };
    // Same universal gates the single-symbol Decision Card applies (default
    // min R:R 2:1, market-regime check) - NOT the user's personal daily
    // loss limit/cooldown, since a bulk scan isn't tied to one logged-in
    // user's trading day. This is what keeps "In buy zone now" in a list
    // from contradicting "NO TRADE" on that same stock's own Decision Card -
    // both now run through the same core checklist.
    const decisionGate = computeFinalDecision({
      analysis: a, dataConfidence: null, marketContext, tradingStatus: null,
      minRiskReward: 2, minDataConfidence: 0,
    });
    // Fundamentals: DB cache first (7d / big price move). Bulk scan does NOT
    // network-fetch every name — that was freezing the UI for 10+ minutes.
    // Detail page / multi-bagger still force full fetch when needed.
    let fundamentals = null;
    try {
      fundamentals = await marketData.getFundamentals(symbol, {
        preferCacheOnly: true,
        livePrice: a.price,
        maxAgeDays: 7,
      });
    } catch (_) {}
    return {
      symbol,
      price: a.price,
      verdict: a.verdict,
      score: a.score,
      suggestedHorizon: a.suggestedHorizon,
      topFactors: a.factors.slice(0, 3),
      fundamentals,
      periodReturns: a.periodReturns,
      relativeStrength,
      breakout,
      streak: a.streak,
      recentStreakPattern: a.recentStreakPattern,
      recentDailyChanges: a.recentDailyChanges,
      setup: a.setup,
      setupType: a.setup?.type || null,
      setupQuality: a.setup?.quality || null,
      tradePlan: a.tradePlan,
      moveProbability,
      targetTimeline,
      // Full indicators so composite ranking (momentum/volume) can use EMA/MACD/RSI
      indicators: a.indicators,
      volSpike: a.indicators.volSpike,
      rsi14: a.indicators.rsi14,
      pChange: quote.pChange,
      decision: decisionGate.decision,
      decisionWhyNot: decisionGate.whyNot,
    };
  } catch (err) {
    return { symbol, error: 'Could not fetch/analyze' };
  }
}

// Mirrors the same "Top Picks" / "Swing Setups" selection logic used in
// the frontend (public/app.js), so the daily recommendation tracker logs
// exactly what a user would have seen that day - not a separate opinion.
//
// "Smart" ranking: a raw technical score alone can favor a stock that's
// ---------------------------------------------------------------------------
// Composite scoring - the actual "how good is this pick" number used to
// rank Top Picks / Swing Setups / Best of Today / Weekend Picks.
//
// Design goals (see the conversation that prompted this rewrite):
//   1. R:R gets REAL weight - a technically strong signal with a terrible
//      reward:risk (e.g. 1:0.07) must not still rank #1 just because its
//      raw technical score was high. R:R is its own weighted component,
//      not a small bonus tacked onto a technical-score-dominated total.
//   2. The final number is a transparent 0-100 score with a visible
//      breakdown (technical / R:R / momentum / volume / sector alignment /
//      market alignment / historical), not an opaque single figure.
//   3. "Historical odds" and "current technical signal" are kept as
//      separate, clearly labeled things - never blended into one number
//      that hides which is which.
// ---------------------------------------------------------------------------

const SCORE_WEIGHTS = {
  technical: 0.20,
  riskReward: 0.20,
  momentum: 0.12,
  volume: 0.09,
  sectorAlignment: 0.07,
  marketAlignment: 0.09,
  historical: 0.12,
  fundamentals: 0.11, // soft: PE/ROE/debt/growth when available; neutral 50 if missing
};

function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }

// Raw technical score (see indicators.js scoreAt - roughly -5..+6 in
// practice) normalized to 0-100, centred on 50.
function scoreTechnical(r) {
  if (r.score == null) return 50;
  return clamp(50 + r.score * 9);
}

// The core fix this rewrite exists for: R:R is graded on its own curve,
// not folded as a minor add-on to the technical score.
//   < 1:1        -> strong penalty (0-15)
//   1:1 - 1:1.5  -> neutral (15-50)
//   1:1.5 - 1:2  -> positive (50-80)
//   1:2+         -> strong positive (80-100, saturating by ~1:4)
// A setup with R:R 1:0.07 (reward is 7% of the risk taken) now scores ~1/100
// on this component instead of losing at most a small bonus.
function scoreRiskReward(rr) {
  if (rr == null || !isFinite(rr) || rr <= 0) return 5; // no usable trade plan at all
  if (rr < 1) return clamp(15 * rr);
  if (rr < 1.5) return clamp(15 + (rr - 1) * 70);
  if (rr < 2) return clamp(50 + (rr - 1.5) * 60);
  return clamp(80 + (rr - 2) * 10);
}

// Short-term momentum: EMA9/21 crossover direction, MACD histogram sign,
// RSI positioning (healthy zone vs overbought/oversold), and the last
// week's actual return - all already computed per-stock, no extra work.
function scoreMomentum(r) {
  let s = 50;
  const ind = r.indicators || {};
  const ema9 = ind.ema9, ema21 = ind.ema21;
  const macdHist = ind.macdHistogram ?? ind.macdHist;
  const rsi = ind.rsi14 ?? r.rsi14;
  if (ema9 != null && ema21 != null) s += ema9 > ema21 ? 12 : -12;
  if (macdHist != null) s += macdHist > 0 ? 10 : -10;
  if (rsi != null) {
    if (rsi >= 45 && rsi <= 65) s += 12; // healthy momentum, not yet stretched
    else if (rsi > 72) s -= 10; // overbought - momentum may be running out
    else if (rsi < 35) s -= 8;
  }
  const wk = r.periodReturns?.oneWeek;
  if (wk != null) s += clamp(wk * 2, -16, 16);
  return clamp(s);
}

// Real volume confirmation, not just "did price move" - a move on weak
// volume is a much weaker signal than the same move on 2x+ average volume.
// Very weak volume (<0.7x) is intentionally harsh so those names cannot
// rank near the top on R:R/technical alone.
function scoreVolume(r) {
  const vs = r.volSpike ?? r.indicators?.volSpike;
  if (vs == null) return 50;
  if (vs >= 2) return 95;
  if (vs >= 1.5) return 82;
  if (vs >= 1) return 62;
  if (vs >= 0.7) return 38; // weak confirmation
  if (vs >= 0.4) return 18; // very weak — hard penalty
  return 8; // almost no volume — severe penalty
}

// Is this stock's move today aligned with, or fighting, its own sector's
// average move today (see server/sectorRotation.js computeSectorTodayMoves)?
// Neutral (50) whenever sector context isn't available - never penalizes a
// pick just because sector data hasn't synced yet.
function scoreSectorAlignment(r, sectorContext) {
  if (!sectorContext || sectorContext.sectorTodayPct == null || r.pChange == null) return 50;
  const stockUp = r.pChange >= 0;
  const sectorUp = sectorContext.sectorTodayPct >= 0;
  if (stockUp === sectorUp) return clamp(70 + Math.abs(sectorContext.sectorTodayPct) * 5, 50, 92);
  return clamp(35 - Math.abs(r.pChange - sectorContext.sectorTodayPct) * 3, 5, 45);
}

// Trading with vs against the broader Nifty regime.
// Strongly bearish market → bullish stocks get a hard penalty (user request:
// fighting the tape should not rank high). Uses both multi-day technical
// trend AND today's direction when available so a single green day in a
// still-technically-weak market doesn't suddenly treat every long as aligned.
function scoreMarketAlignment(r, marketContext) {
  if (!marketContext?.trend) return 50;
  const v = (r.verdict || '').toLowerCase();
  const bullish = v.includes('bullish');
  const bearish = v.includes('bearish');
  const trend = marketContext.trend;
  const score = marketContext.score;
  const stronglyBearish = trend === 'bearish' && (score == null || score <= -2);
  const stronglyBullish = trend === 'bullish' && (score == null || score >= 2);
  const todayDown = marketContext.periodReturns?.oneDay != null && marketContext.periodReturns.oneDay < -0.3;
  const todayUp = marketContext.periodReturns?.oneDay != null && marketContext.periodReturns.oneDay > 0.3;

  if (trend === 'bullish' && bullish) return stronglyBullish ? 90 : 82;
  if (trend === 'bearish' && bearish) return stronglyBearish ? 90 : 82;
  // Fighting the tape — extra hard when regime is strongly one-sided or today is also against the stock
  if (trend === 'bullish' && bearish) {
    return stronglyBullish || todayUp ? 12 : 22;
  }
  if (trend === 'bearish' && bullish) {
    return stronglyBearish || todayDown ? 10 : 20;
  }
  return 55;
}

// This stock's OWN historical pattern-based odds (see
// server/probabilityEstimator.js estimateMoveProbability - "of every past
// signal that looked like this one on THIS stock, how often did it gain
// 1%+/5%+ vs drop 2%+ within 3 days"). Kept deliberately separate from the
// CURRENT technical read above - this is what actually happened historically
// in similar setups, not a guess about today. See buildHistoricalStats()
// below for the honestly-labeled version of these same numbers shown in the UI.
function scoreHistorical(r) {
  const p = r.moveProbability;
  if (!p || p.status !== 'ok' || p.sampleSize < 8) return 50; // not enough history to trust yet
  let s = 50 + (p.probabilityUp1PctPlus - 50) * 0.7;
  s -= Math.max(0, p.probabilityDown2PctPlus - 30) * 0.9;
  return clamp(s);
}

// The historical numbers, honestly framed: these are three INDEPENDENT
// "did X happen within 3 days" rates (not mutually-exclusive outcomes like
// a real target-hit/stop-hit resolution would be), so they're never shown
// as if they sum to a clean "profit vs loss" split. See point 8 of the
// scoring rewrite - "77.4% profit odds / 35.8% loss odds" side by side
// implies they're complementary when they aren't.
function buildHistoricalStats(r) {
  const p = r.moveProbability;
  if (!p || p.status !== 'ok') return { available: false, sampleSize: 0 };
  return {
    available: true,
    gained1PctPlusRate: p.probabilityUp1PctPlus,
    gained5PctPlusRate: p.probabilityUp5PctPlus,
    dropped2PctPlusRate: p.probabilityDown2PctPlus,
    sampleSize: p.sampleSize,
    note: 'Independent historical rates from similar past signals on this stock - not mutually exclusive outcomes, and not a guarantee.',
  };
}

// The full transparent breakdown - every component 0-100, the weights used
// to combine them, and the final weighted overall score (also 0-100).
// sectorContext is optional (existing 2-arg callers keep working exactly as
// before, just with sectorAlignment defaulting to neutral).
//
// FINAL SCORE = Technical + R:R + Momentum + Volume + Sector + Market + Historical
// BUT: strongly bearish market → bullish stocks auto-penalty;
//      very weak volume → penalty;
//      R:R alone cannot put a stock on top (see soft-gate after weighted sum);
//      Model Learning is only a SMALL capped nudge (never a profit guarantee).

/**
 * Soft fundamental quality 0–100.
 * Neutral 50 when data missing so scan still works offline / thin feeds.
 * Does NOT dominate short-term technical ranking (weight ~11%).
 */
function scoreFundamentals(r) {
  const f = r.fundamentals || r._fundamentals || null;
  if (!f) return 50;
  let s = 50;
  const pe = f.peTrailing ?? f.peForward ?? f.pe ?? null;
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null; // handle fraction or %
  const de = f.debtToEquity;
  const margin = f.profitMargin != null ? (f.profitMargin <= 1.5 ? f.profitMargin * 100 : f.profitMargin) : null;
  const rg = f.revenueGrowth;
  const eg = f.earningsGrowth;
  const pb = f.priceToBook;

  if (roe != null) {
    if (roe >= 18) s += 14;
    else if (roe >= 12) s += 8;
    else if (roe >= 8) s += 3;
    else if (roe < 5) s -= 10;
  }
  if (pe != null && pe > 0) {
    if (pe < 18) s += 10;
    else if (pe < 30) s += 4;
    else if (pe < 50) s += 0;
    else if (pe < 80) s -= 6;
    else s -= 12;
  }
  if (pb != null && pb > 0) {
    if (pb < 3) s += 4;
    else if (pb > 12) s -= 5;
  }
  if (de != null) {
    const d = de > 10 ? de / 100 : de;
    if (d <= 0.4) s += 8;
    else if (d <= 1) s += 3;
    else if (d > 2.5) s -= 10;
  }
  if (margin != null) {
    if (margin >= 15) s += 6;
    else if (margin >= 8) s += 3;
    else if (margin < 2) s -= 5;
  }
  if (rg != null) {
    const g = Math.abs(rg) <= 5 ? rg * 100 : rg;
    if (g >= 15) s += 6;
    else if (g >= 8) s += 3;
    else if (g < -5) s -= 6;
  }
  if (eg != null) {
    const g = Math.abs(eg) <= 5 ? eg * 100 : eg;
    if (g >= 15) s += 5;
    else if (g < -10) s -= 6;
  }

  // FII / DII QoQ from Groww shareholdingSummary (when cached on fundamentals)
  const sh = f.shareholdingSummary || r.shareholdingSummary || null;
  if (sh) {
    const fiiD = sh.fiiDelta;
    const diiD = sh.diiDelta;
    if (fiiD != null) {
      if (fiiD >= 1) s += 8;
      else if (fiiD >= 0.3) s += 4;
      else if (fiiD <= -1) s -= 8;
      else if (fiiD <= -0.3) s -= 4;
    }
    if (diiD != null) {
      if (diiD >= 1) s += 6;
      else if (diiD >= 0.3) s += 3;
      else if (diiD <= -1) s -= 5;
      else if (diiD <= -0.3) s -= 2;
    }
    // Both institutions adding is a strong soft signal
    if (fiiD != null && diiD != null && fiiD > 0 && diiD > 0) s += 4;
    if (fiiD != null && diiD != null && fiiD < 0 && diiD < 0) s -= 5;
  }
  return clamp(Math.round(s));
}

function computeScoreBreakdown(r, marketContext = null, sectorContext = null) {
  if (r.error || r.score == null) {
    return {
      overall: 0, components: {}, weights: SCORE_WEIGHTS,
      historicalStats: { available: false, sampleSize: 0 }, error: true,
      baseScore: 0, learningNudge: 0, learningConfidence: 'none', learningWhy: null,
    };
  }
  const components = {
    technical: Number(scoreTechnical(r).toFixed(1)),
    riskReward: Number(scoreRiskReward(r.tradePlan?.riskRewardRatio).toFixed(1)),
    momentum: Number(scoreMomentum(r).toFixed(1)),
    volume: Number(scoreVolume(r).toFixed(1)),
    sectorAlignment: Number(scoreSectorAlignment(r, sectorContext).toFixed(1)),
    marketAlignment: Number(scoreMarketAlignment(r, marketContext).toFixed(1)),
    historical: Number(scoreHistorical(r).toFixed(1)),
    fundamentals: Number(scoreFundamentals(r).toFixed(1)),
  };
  let baseScore = Object.entries(SCORE_WEIGHTS).reduce((sum, [key, w]) => sum + (components[key] ?? 50) * w, 0);

  // Soft gate: R:R alone cannot float a weak technical/volume name to the top.
  // If technical + volume + momentum average is weak while R:R is sky-high,
  // pull the overall back toward the non-RR components so ranking stays honest.
  const nonRrKeys = ['technical', 'momentum', 'volume', 'sectorAlignment', 'marketAlignment', 'historical', 'fundamentals'];
  const nonRrAvg = nonRrKeys.reduce((s, k) => s + components[k], 0) / nonRrKeys.length;
  if (components.riskReward >= 80 && nonRrAvg < 45) {
    baseScore = baseScore * 0.72 + nonRrAvg * 0.28;
  }

  // Extra hard penalties (user requirement): strongly bearish market + bullish
  // stock, and/or very weak volume — applied after the weighted sum so they
  // cannot be diluted by a high R:R component.
  const vs = r.volSpike ?? r.indicators?.volSpike;
  let postPenalty = 0;
  const penaltyReasons = [];
  const v = (r.verdict || '').toLowerCase();
  const isBullish = v.includes('bullish');
  if (marketContext?.trend === 'bearish' && (marketContext.score == null || marketContext.score <= -2) && isBullish) {
    postPenalty -= 8;
    penaltyReasons.push('bullish stock in strongly bearish market (−8)');
  }
  // Nifty pulse / learning regime: extra soft haircut so stress days don't
  // promote aggressive long momentum the same as calm days.
  const lr = marketContext?.learningRegime;
  const day = marketContext?.oneDayChangePct ?? marketContext?.periodReturns?.oneDay;
  if (isBullish && (lr === 'CRISIS' || (day != null && day <= -1.2))) {
    postPenalty -= 5;
    penaltyReasons.push('index stress / crisis-tag day — long momentum soft penalty (−5)');
  } else if (isBullish && (lr === 'BEAR' || (day != null && day <= -0.7))) {
    postPenalty -= 2;
    penaltyReasons.push('weak index day — long bias soft penalty (−2)');
  }
  if (vs != null && vs < 0.7) {
    const volPen = vs < 0.4 ? 6 : 3;
    postPenalty -= volPen;
    penaltyReasons.push(`very weak volume ${vs.toFixed(2)}x (−${volPen})`);
  }
  baseScore = clamp(baseScore + postPenalty);

  // Model Learning: small capped nudge only. Never framed as future profit odds.
  const regimeHint = marketContext?.learningRegime || getCurrentLearningRegime();
  if (marketContext?.learningRegime) setCurrentLearningRegime(marketContext.learningRegime);
  const learning = getAdaptiveAdjustment(r.topFactors, { regime: regimeHint, sector: sectorContext?.sector || r.sector || null });
  const learningNudge = typeof learning === 'object' ? Number((learning.nudge || 0).toFixed(2)) : Number((learning || 0).toFixed(2));
  const learningConfidence = typeof learning === 'object' ? (learning.confidence || 'none') : (learningNudge !== 0 ? 'medium' : 'none');
  const learningWhy = typeof learning === 'object' ? (learning.why || null) : null;
  const learningModelConfidence = typeof learning === 'object' ? (learning.modelConfidence || learningConfidence) : learningConfidence;
  const learningTradeConfidence = typeof learning === 'object' ? (learning.tradeConfidence || 'unknown') : 'unknown';
  const learningRegimeUsed = typeof learning === 'object' ? (learning.regime || regimeHint) : regimeHint;

  const overall = clamp(baseScore + learningNudge);
  return {
    overall: Number(overall.toFixed(1)),
    components,
    weights: SCORE_WEIGHTS,
    adaptiveNudge: learningNudge, // kept for backward-compatible callers/UI
    baseScore: Number(baseScore.toFixed(1)),
    learningNudge,
    learningConfidence,
    learningWhy,
    learningModelConfidence,
    learningTradeConfidence,
    learningRegime: learningRegimeUsed,
    postPenalties: penaltyReasons.length ? penaltyReasons : null,
    historicalStats: buildHistoricalStats(r),
  };
}

// Thin wrapper kept for every existing caller (computeTopPicks' sort,
// Weekend Picks, Best of Today) - same 2-arg signature as before, just
// backed by the new weighted 0-100 breakdown instead of the old
// technical-score-dominated total. sectorContext is an optional 3rd arg
// for callers that have it; omitting it is fully backward compatible.
function computeRankScore(r, marketContext, sectorContext) {
  if (r.error || r.score == null) return -Infinity;
  return computeScoreBreakdown(r, marketContext, sectorContext).overall;
}

// Quality confluence — how many independent "this is a healthier long from
// the pick price" gates the name clears. Used to rank Best of Today / Top
// Picks so a high technical score with terrible R:R or dead volume cannot
// still be #1. Does NOT guarantee profit; it only prefers setups that have
// historically been less loss-prone when several of these line up.
function assessPickQuality(r, marketContext = null) {
  const reasons = [];
  let points = 0;
  const rr = r.tradePlan?.riskRewardRatio;
  const vs = r.volSpike ?? r.indicators?.volSpike;
  const rsi = r.rsi14 ?? r.indicators?.rsi14;
  const hist = r.moveProbability;
  const v = (r.verdict || '').toLowerCase();
  const bullish = v.includes('bullish');

  // 1) Tradeable R:R (biggest real-world filter — screenshot showed 0.13:1 tops)
  if (rr != null && rr >= 2) { points += 3; reasons.push(`R:R ${rr}:1 ≥ 2`); }
  else if (rr != null && rr >= 1.5) { points += 2; reasons.push(`R:R ${rr}:1 ≥ 1.5`); }
  else if (rr != null && rr >= 1) { points += 0.5; reasons.push(`R:R ${rr}:1 only ≥ 1`); }
  else if (rr != null) { points -= 2; reasons.push(`weak R:R ${rr}:1`); }

  // 2) Volume confirmation
  if (vs != null && vs >= 1.5) { points += 2; reasons.push(`volume ${vs.toFixed(1)}x`); }
  else if (vs != null && vs >= 1.0) { points += 1; reasons.push(`volume ok ${vs.toFixed(1)}x`); }
  else if (vs != null && vs < 0.7) { points -= 1.5; reasons.push(`weak volume ${vs.toFixed(2)}x`); }

  // 3) Not chasing extreme overbought (momentum longs)
  if (rsi != null && rsi > 75 && r.setup?.type !== 'reversal') { points -= 1.5; reasons.push(`RSI ${rsi.toFixed(0)} overbought`); }
  else if (rsi != null && rsi >= 45 && rsi <= 68) { points += 1; reasons.push('RSI healthy zone'); }

  // 4) Market alignment
  if (marketContext?.trend === 'bullish' && bullish) { points += 1.5; reasons.push('with market'); }
  else if (marketContext?.trend === 'bearish' && bullish) { points -= 2; reasons.push('against bearish market'); }
  else if (marketContext?.trend === 'bearish' && r.setup?.type === 'reversal') { points += 1; reasons.push('reversal in weak market'); }

  // 5) Historical downside not extreme on similar past signals
  if (hist?.status === 'ok' && hist.sampleSize >= 12) {
    if (hist.probabilityDown2PctPlus != null && hist.probabilityDown2PctPlus <= 30) {
      points += 1.5; reasons.push(`hist down-risk ${hist.probabilityDown2PctPlus}%`);
    } else if (hist.probabilityDown2PctPlus != null && hist.probabilityDown2PctPlus >= 45) {
      points -= 1; reasons.push(`hist down-risk high ${hist.probabilityDown2PctPlus}%`);
    }
    if (hist.probabilityUp1PctPlus != null && hist.probabilityUp1PctPlus >= 60) {
      points += 1; reasons.push(`hist up1% ${hist.probabilityUp1PctPlus}%`);
    }
  }

  // 6) Actionable decision gate
  if (r.decision === 'BUY NOW' || r.decision === 'BUY ON PULLBACK') {
    points += 1.5; reasons.push(r.decision);
  } else if (r.decision === 'NO TRADE') {
    points -= 1; reasons.push('NO TRADE gate');
  }

  // 7) In entry zone (price near plan)
  if (r.tradePlan && r.price != null) {
    const { entryLow, entryHigh } = r.tradePlan;
    if (entryLow != null && entryHigh != null && r.price >= entryLow && r.price <= entryHigh) {
      points += 1; reasons.push('in buy zone');
    }
  }

  const score = Math.max(0, Math.min(10, Number(points.toFixed(1))));
  let label = 'low';
  if (score >= 7) label = 'high';
  else if (score >= 4) label = 'medium';
  return { score, label, reasons };
}

// Rank key: composite overall first, then quality confluence as tie-breaker
// and soft boost so low-quality (bad R:R / dead volume) names sink.
function computeQualityRankScore(r, marketContext, sectorContext) {
  const base = computeRankScore(r, marketContext, sectorContext);
  if (!Number.isFinite(base)) return -Infinity;
  const q = assessPickQuality(r, marketContext);
  // Up to +8 soft boost for high confluence; up to -6 for very poor quality
  let boost = (q.score - 4) * 1.2;
  // When Model Learning has enough history, demote signals that historically underperformed
  if (isLearningFilterReady()) {
    const learning = getAdaptiveAdjustment(r.topFactors);
    const nudge = typeof learning === 'object' ? (learning.nudge || 0) : (learning || 0);
    if (nudge <= -0.25) boost -= 6; // historically weak signal combo
    else if (nudge >= 0.25) boost += 2;
  }
  return base + boost;
}

// Used only to gate the deliberately-rare "exceptional confluence" picks
// (Golden Setup / Golden Opportunity) - those are explicitly framed as
// "this is a real buy, act on it", so they must also pass the Decision
// Card's own core checklist (min R:R 2:1, market-regime alignment).
// Top Picks / Swing Setups are NOT gated by this (see note below) - they're
// "best of what's actually available today" screening tools, not a claim
// that any of them is a slam-dunk trade.
function isActionable(r) {
  if (r.decision == null) return true;
  return r.decision === 'BUY NOW' || r.decision === 'BUY ON PULLBACK';
}

// Top Picks intentionally do NOT hard-filter by isActionable: in a broadly
// bearish market almost nothing will pass a strict R:R+regime gate, and
// hiding every single row would make this screening tool useless exactly
// when it's most needed (a quiet/bearish day). Instead it always surfaces
// the relative best candidates per horizon by rankScore, and buyRangeNote()
// below honestly flags (rather than hides) any pick that's in its price
// zone but wouldn't actually pass its own Decision Card.
// Intraday shows more (8) than short/long-term (5) - intraday is the
// fastest-moving, highest-volume category with the most genuine same-day
// candidates on any given day, so a narrow top-3 cut was hiding real movers
// (e.g. a stock ranked #4-#8 by score that was still clearly worth a look).
const TOP_PICKS_LIMIT = { intraday: 8, short_term: 5, long_term: 5 };
// User capital: skip expensive names in recommend lists (Best of Today / Golden / Bronze…).
const MAX_RECOMMEND_PRICE = Number(process.env.MAX_RECOMMEND_PRICE || 6000);

function isAffordableRecommendPrice(r, maxPrice = MAX_RECOMMEND_PRICE) {
  const px = r?.price;
  if (px == null || !Number.isFinite(Number(px))) return false;
  return Number(px) <= maxPrice;
}

function computeTopPicks(results, marketContext = null) {
  const valid = results.filter((r) => !r.error && isAffordableRecommendPrice(r) && r.score > -1);
  const pick = (horizon) => {
    let pool = valid.filter((r) => r.suggestedHorizon === horizon);
    // If horizon empty (quiet day), widen to any non-error affordable with plan
    if (!pool.length) {
      pool = results.filter((r) => !r.error && isAffordableRecommendPrice(r) && r.tradePlan && r.suggestedHorizon === horizon);
    }
    if (!pool.length) {
      pool = results.filter((r) => !r.error && isAffordableRecommendPrice(r) && r.tradePlan);
    }
    // Prefer quality bar; else full pool so section rarely empty
    const preferred = pool.filter((r) => {
      if (r.setup?.quality === 'falling_knife') return false;
      const rr = r.tradePlan?.riskRewardRatio;
      return (rr != null && rr >= 1.3) || isActionable(r) || (r.score != null && r.score >= 0.5);
    });
    const use = preferred.length ? preferred : pool.filter((r) => r.setup?.quality !== 'falling_knife');
    return use
      .map((r) => {
        const conf = evaluateSetupConfluence(r, marketContext);
        return {
          ...r,
          setupConfluence: conf,
          setupType: conf.setupType,
          setupQuality: conf.setupQuality,
          bullishFactors: conf.bullishFactors,
          riskFactors: conf.riskFactors,
          invalidation: conf.invalidation,
          _setupAwareRank: computeQualityRankScore(r, marketContext)
            + (conf.confluenceScore || 0) * 2
            - (conf.setupQuality === 'falling_knife' ? 20 : 0)
            - ((conf.riskFactors || []).length * 1.5),
        };
      })
      .sort((a, b) => (b._setupAwareRank || 0) - (a._setupAwareRank || 0))
      .slice(0, TOP_PICKS_LIMIT[horizon] || 5);
  };
  return { intraday: pick('intraday'), short_term: pick('short_term'), long_term: pick('long_term') };
}

// Same reasoning as computeTopPicks - not hard-gated by isActionable, so a
// quiet/bearish day still shows the best available momentum/reversal
// candidates rather than going empty. buyRangeNote() flags any that
// wouldn't survive the Decision Card's own checklist. Widened from 4 to 6
// per side for the same "don't hide a real candidate behind an arbitrary
// small cutoff" reasoning as Top Picks above.
// marketContext is optional (existing callers that don't pass it keep
// working exactly as before - computeRankScore treats a missing
// marketContext as "neutral", not a penalty).
function computeSwingSetups(results, marketContext = null) {
  const valid = results.filter((r) => !r.error && r.suggestedHorizon !== 'intraday' && r.setup && r.setup.type && isAffordableRecommendPrice(r));
  // Sorted by the same composite rank score as everywhere else now - R:R,
  // volume, and historical odds all weigh in here too, not just raw
  // technical score. A momentum/reversal setup with a great technical read
  // but a garbage R:R no longer automatically outranks one with a slightly
  // lower technical score but an actually-tradeable reward:risk.
  const enrich = (r) => {
    const conf = evaluateSetupConfluence(r, marketContext);
    return {
      ...r,
      setupConfluence: conf,
      setupType: conf.setupType,
      setupQuality: conf.setupQuality,
      bullishFactors: conf.bullishFactors,
      riskFactors: conf.riskFactors,
      invalidation: conf.invalidation,
      _setupAwareRank: computeQualityRankScore(r, marketContext)
        + (conf.confluenceScore || 0) * 2
        - (conf.setupQuality === 'falling_knife' ? 25 : 0)
        - ((conf.riskFactors || []).length * 1.5),
    };
  };
  const byRank = (a, b) => (b._setupAwareRank || 0) - (a._setupAwareRank || 0);
  const prefer = (list) => {
    const good = list.filter((r) => {
      if (r.setup?.quality === 'falling_knife') return false;
      const rr = r.tradePlan?.riskRewardRatio;
      return (rr != null && rr >= 1.5) || isActionable(r);
    });
    const base = (good.length ? good : list).map(enrich);
    return base.sort(byRank).slice(0, 6);
  };
  let momentum = prefer(valid.filter((r) => r.setup.type === 'momentum' || r.setup.type === 'breakout' || r.setup.type === 'pullback'));
  let reversal = prefer(valid.filter((r) => r.setup.type === 'reversal'));
  // Soft fill so daily lists are not both empty
  if (!momentum.length && !reversal.length) {
    const any = prefer(valid);
    momentum = any.slice(0, 3);
  } else {
    if (!momentum.length) momentum = prefer(valid).slice(0, 3);
    if (!reversal.length) {
      const softRev = valid.filter((r) => r.setup?.type === 'reversal' || (r.score != null && r.score < 1));
      reversal = prefer(softRev.length ? softRev : valid).slice(0, 3);
    }
  }
  return { momentum, reversal };
}

function potentialReturnPct(r) {
  if (!r.tradePlan || !r.price) return null;
  return ((r.tradePlan.target - r.price) / r.price) * 100;
}

function downsideRiskPct(r) {
  if (!r.tradePlan || !r.price) return null;
  return ((r.price - r.tradePlan.stopLoss) / r.price) * 100;
}

// Does this stock show real directional conviction - either a strong raw
// bullish score, OR a genuine reversal/bounce setup (fell hard, now
// turning up near support) even if its raw score is still weak or
// negative. A "score >= N" bar alone is blind to good reversal setups -
// which are often the best risk/reward the market offers, especially in a
// falling/bearish market where nothing has a strongly positive score yet.
function hasConviction(r, minScore) {
  if (r.error) return false;
  if (r.score >= minScore) return true;
  // Reversal only counts when not a falling knife
  if (r.setup?.type === 'reversal' && r.setup?.quality !== 'falling_knife') return true;
  if (r.setup?.type === 'breakout' || r.setup?.type === 'pullback') return r.score >= Math.max(0, minScore - 1);
  return false;
}

/**
 * Setup-aware confluence: different rules for momentum / breakout / pullback / reversal.
 * Additive only — does not replace existing R:R / volume / score gates.
 */
function evaluateSetupConfluence(r, marketContext = null) {
  const bullish = [];
  const risks = [];
  const setupType = r.setup?.type || null;
  const quality = r.setup?.quality || null;
  const rr = r.tradePlan?.riskRewardRatio;
  const vol = r.volSpike ?? r.volumeRatio;
  const rsi = r.indicators?.rsi14;
  const plan = r.tradePlan;
  const inZone = plan && r.price != null && r.price >= plan.entryLow && r.price <= plan.entryHigh;
  const nearZone = plan && r.price != null && r.price >= plan.entryLow * 0.97 && r.price <= plan.entryHigh * 1.03;
  let conf = 0; // 0–10 scale of setup-specific confirmations

  if (!setupType) {
    risks.push('No clear setup type');
    return {
      setupType: null,
      setupQuality: null,
      confluenceScore: 0,
      bullishFactors: bullish,
      riskFactors: risks,
      invalidation: plan?.stopLoss != null ? `Close below ₹${plan.stopLoss}` : 'Setup structure break',
      inZone: !!inZone,
      nearZone: !!nearZone,
    };
  }

  // Shared structure
  if (rr != null && rr >= 1.5) { conf += 1; bullish.push(`R:R 1:${Number(rr).toFixed(2)}`); }
  else if (rr != null && rr < 1.2) { conf -= 1; risks.push(`Weak R:R 1:${Number(rr).toFixed(2)}`); }
  if (vol != null && vol >= 1.5) { conf += 1; bullish.push(`Volume ${Number(vol).toFixed(1)}x`); }
  else if (vol != null && vol < 0.7) { conf -= 1; risks.push('Thin volume'); }
  if (inZone) { conf += 1; bullish.push('In entry zone'); }
  else if (nearZone) { conf += 0.5; bullish.push('Near entry zone'); }

  // Market / sector
  const mTrend = marketContext?.trend || marketContext?.todayDirection;
  if (mTrend === 'bullish' || mTrend === 'up') {
    if (setupType !== 'reversal') { conf += 0.5; bullish.push('Nifty context supportive'); }
  } else if (mTrend === 'bearish' || mTrend === 'down') {
    if (setupType === 'momentum' || setupType === 'breakout') {
      conf -= 1;
      risks.push('Market weak vs momentum/breakout');
    } else if (setupType === 'reversal') {
      conf += 0.5;
      bullish.push('Reversal context in weak market');
    }
  }
  if (r.sectorAlignment != null && r.sectorAlignment >= 60) {
    conf += 0.5;
    bullish.push('Sector alignment ok');
  } else if (r.sectorAlignment != null && r.sectorAlignment < 40) {
    conf -= 0.5;
    risks.push('Sector lagging');
  }

  // Setup-specific
  if (setupType === 'momentum') {
    if (r.score >= 3) { conf += 1.5; bullish.push('Strong momentum score'); }
    if (rsi != null && rsi > 75) { conf -= 1.5; risks.push('RSI stretched (chase risk)'); }
    if (rsi != null && rsi >= 45 && rsi <= 68) { conf += 0.5; bullish.push('RSI healthy momentum band'); }
  } else if (setupType === 'breakout') {
    if (vol != null && vol >= 2) { conf += 1.5; bullish.push('Breakout volume confirmation'); }
    else if (vol == null || vol < 1.3) { conf -= 1; risks.push('Breakout without volume'); }
    if (r.score >= 2) conf += 0.5;
  } else if (setupType === 'pullback') {
    if (r.setup?.confirms?.includes('near_support')) { conf += 1; bullish.push('Support pullback'); }
    if (rsi != null && rsi >= 40 && rsi <= 60) { conf += 0.5; bullish.push('RSI cool-down pullback'); }
    if (rsi != null && rsi > 70) { conf -= 1; risks.push('Pullback RSI still hot'); }
  } else if (setupType === 'reversal') {
    if (quality === 'falling_knife') {
      conf -= 3;
      risks.push('Falling knife — not a confirmed reversal');
    } else if (quality === 'confirmed') {
      conf += 2;
      bullish.push('Confirmed reversal confluence');
    } else if (quality === 'possible') {
      conf += 1;
      bullish.push('Possible reversal');
    }
    (r.setup?.confirms || []).forEach((c) => {
      if (c === 'support_hold') bullish.push('Support/demand hold');
      if (c === 'volume_exhaustion') bullish.push('Selling pressure easing');
      if (c === 'higher_low') bullish.push('Higher-low structure');
      if (c === 'volume_or_reclaim') bullish.push('Reclaim / volume confirmation');
    });
    conf += Math.min(2, (r.setup?.confirms || []).length * 0.35);
  }

  // Conflicting signals
  if (r.score < 0 && setupType === 'momentum') {
    conf -= 1.5;
    risks.push('Score negative vs momentum label');
  }
  if (quality === 'falling_knife') {
    risks.push('Avoid sizing until structure confirms');
  }

  const invalidation = plan?.stopLoss != null
    ? (setupType === 'reversal'
      ? `Close below support/SL ₹${plan.stopLoss} or failed higher-low`
      : `Close below SL ₹${plan.stopLoss} or setup structure break`)
    : 'Setup structure break / no SL defined';

  return {
    setupType,
    setupQuality: quality,
    confluenceScore: Number(conf.toFixed(1)),
    bullishFactors: [...new Set(bullish)].slice(0, 8),
    riskFactors: [...new Set(risks)].slice(0, 6),
    invalidation,
    inZone: !!inZone,
    nearZone: !!nearZone,
  };
}

function whyThisTier(tier, r, conf) {
  const parts = [];
  parts.push(`setup=${conf.setupType || 'n/a'}${conf.setupQuality ? '/' + conf.setupQuality : ''}`);
  parts.push(`confluence=${conf.confluenceScore}`);
  if (r.tradePlan?.riskRewardRatio != null) parts.push(`R:R 1:${r.tradePlan.riskRewardRatio}`);
  if (r.volSpike != null) parts.push(`vol ${Number(r.volSpike).toFixed(1)}x`);
  if (tier === 'diamond') parts.push('exceptional multi-factor + history downside controlled');
  else if (tier === 'gold') parts.push('strong setup confluence + R:R/volume gates');
  else if (tier === 'silver') parts.push('solid confirmations, clean structure');
  else if (tier === 'bronze') parts.push('valid setup, basic confirmations only');
  return parts.join(' · ');
}

// Four-tier setup quality, loosest (🥉 Bronze) to strictest (💎 Diamond).
// Replaces the old single pass/fail "Golden Setup" bar - grades what's
// actually available today instead of showing nothing on a quiet or
// broadly bearish day, while still reserving Diamond for a genuinely rare
// best-of-everything case. Every tier requires isActionable() - i.e. it
// must also pass the Decision Card's own core checklist (min R:R,
// market-regime alignment) - a setup that would show NO TRADE on its own
// Decision Card is never labeled an "opportunity" at any tier.
const MAX_GOLDEN_ONE_MONTH = 25; // already huge swing — skip golden
const MAX_GOLDEN_FIVE_DAY = 12;

function classifyOpportunityTier(r, marketContext = null) {
  if (r.error || !r.tradePlan || !r.price || !isActionable(r)) return null;
  // Must identify a setup first — generic high score alone does not create a tier
  const conf = r.setupConfluence || evaluateSetupConfluence(r, marketContext);
  if (!conf.setupType) return null;
  if (conf.setupQuality === 'falling_knife') return null; // never golden-tier a falling knife
  // Extension penalty: already ran hard → not a fresh golden
  const m1 = r.periodReturns?.oneMonth;
  const d5 = r.periodReturns?.fiveDay ?? r.periodReturns?.oneWeek;
  if (m1 != null && m1 >= MAX_GOLDEN_ONE_MONTH) return null;
  if (d5 != null && d5 >= MAX_GOLDEN_FIVE_DAY) return null;
  // Far above 20DMA = chase risk for diamond/gold especially handled below via conf

  const p = r.tradePlan;
  const rr = p.riskRewardRatio;
  if (rr == null) return null;
  const vol = r.volSpike;
  const inZone = conf.inZone;
  const nearZone = conf.nearZone;
  const upside = potentialReturnPct(r);
  const downside = r.moveProbability?.status === 'ok' ? r.moveProbability.probabilityDown2PctPlus : null;
  const cScore = conf.confluenceScore;
  const riskCount = (conf.riskFactors || []).length;

  // Progressive tiers: keep existing numeric gates + setup-specific confluence
  // 💎 Diamond
  if (hasConviction(r, 4) && rr >= 3 && vol != null && vol >= 2 && inZone
      && upside != null && upside >= 5 && upside <= 50
      && (downside == null || downside <= 35)
      && cScore >= 6 && riskCount <= 1
      && (conf.setupQuality === 'confirmed' || conf.setupQuality === 'strong' || conf.setupType === 'momentum')) {
    return 'diamond';
  }
  // 🥇 Gold
  if (hasConviction(r, 4) && rr >= 3 && vol != null && vol >= 2 && inZone
      && cScore >= 4.5 && riskCount <= 2) {
    return 'gold';
  }
  // 🥈 Silver
  if (hasConviction(r, 2.5) && rr >= 2 && vol != null && vol >= 1.3 && inZone
      && cScore >= 3 && riskCount <= 3) {
    return 'silver';
  }
  // 🥉 Bronze — softest valid opportunity (must still not be falling knife)
  if (hasConviction(r, 0.5) && rr >= 1.2 && nearZone && cScore >= 0.5 && riskCount <= 5) {
    return 'bronze';
  }
  // Ultra-soft bronze: actionable + workable R:R near zone, any non-knife setup
  if (rr >= 1.2 && nearZone && conf.setupType && riskCount <= 6) {
    return 'bronze';
  }
  return null;
}

// Groups a result set into all 4 tiers at once. Each stock lands in
// exactly the highest tier it qualifies for (classifyOpportunityTier
// already checks strictest-first), never counted twice.
function computeTieredOpportunities(results, marketContext = null) {
  const tiers = { diamond: [], gold: [], silver: [], bronze: [] };
  results.forEach((r) => {
    if (!isAffordableRecommendPrice(r)) return;
    const conf = evaluateSetupConfluence(r, marketContext);
    const row = { ...r, setupConfluence: conf, setupType: conf.setupType, setupQuality: conf.setupQuality };
    const tier = classifyOpportunityTier(row, marketContext);
    if (!tier) return;
    tiers[tier].push({
      ...row,
      tier,
      whyThisTier: whyThisTier(tier, row, conf),
      bullishFactors: conf.bullishFactors,
      riskFactors: conf.riskFactors,
      invalidation: conf.invalidation,
      potentialReturnPct: potentialReturnPct(r),
      downsideRiskPct: downsideRiskPct(r),
    });
  });
  Object.keys(tiers).forEach((t) => {
    tiers[t].sort((a, b) => {
      const cb = (b.setupConfluence?.confluenceScore || 0) - (a.setupConfluence?.confluenceScore || 0);
      if (cb !== 0) return cb;
      return (b.tradePlan.riskRewardRatio || 0) - (a.tradePlan.riskRewardRatio || 0);
    });
  });

  // Never leave Golden completely empty when any tradeable name exists —
  // soft Bronze only (not auto Gold/Diamond). User needs at least watchlist names.
  const total = tiers.diamond.length + tiers.gold.length + tiers.silver.length + tiers.bronze.length;
  if (total === 0) {
    const soft = [];
    for (const r of results) {
      if (!isAffordableRecommendPrice(r) || r.error || !r.tradePlan || !r.price) continue;
      if (r.setup?.quality === 'falling_knife') continue;
      const rr = r.tradePlan.riskRewardRatio;
      if (rr == null || rr < 1.1) continue;
      const conf = evaluateSetupConfluence(r, marketContext);
      soft.push({
        ...r,
        setupConfluence: conf,
        setupType: conf.setupType || r.setup?.type || 'watch',
        setupQuality: conf.setupQuality || 'soft',
        tier: 'bronze',
        whyThisTier: 'Soft bronze — best available today (full confluence not met; not a high-conviction golden)',
        bullishFactors: conf.bullishFactors || [],
        riskFactors: [...(conf.riskFactors || []), 'Soft fill — size small / confirm yourself'],
        invalidation: conf.invalidation || (r.tradePlan.stopLoss != null ? `SL ₹${r.tradePlan.stopLoss}` : 'Structure break'),
        potentialReturnPct: potentialReturnPct(r),
        downsideRiskPct: downsideRiskPct(r),
        _setupAwareRank: computeQualityRankScore(r, marketContext) + (conf.confluenceScore || 0),
      });
    }
    soft.sort((a, b) => (b._setupAwareRank || 0) - (a._setupAwareRank || 0));
    tiers.bronze = soft.slice(0, 5);
  }
  return tiers;
}

module.exports = {
  mapLimit, analyzeOne, computeTopPicks, computeSwingSetups,
  classifyOpportunityTier, computeTieredOpportunities, hasConviction,
  potentialReturnPct, downsideRiskPct, computeRankScore, computeScoreBreakdown,
  assessPickQuality, computeQualityRankScore, learningFilterStatus,
  isActionable, isAffordableRecommendPrice, MAX_RECOMMEND_PRICE,
  evaluateSetupConfluence, whyThisTier,
};
