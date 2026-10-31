/**
 * Zero-Loss Protection / +5% Target Engine
 * Capital protection first. NO TRADE when sample/structure cannot support.
 * Uses path probabilities from the stock's own history — no invented %.
 */
const marketData = require('./marketData');
const { analyze } = require('./indicators');
const { getMarketTrend } = require('./marketTrend');
const { estimatePathProbabilities } = require('./probabilityEstimator');
const { runBacktest } = require('./backtest');

const MIN_SAMPLE = 12;
const MIN_SAMPLE_HIGH = 25;
const MIN_P5_BEFORE_2 = 55; // soft gate
const MIN_P5_BEFORE_3 = 50;
const MAX_AVG_MAE = -4.5; // avg adverse worse than -4.5% → reject
const MIN_RR = 1.8;

function round2(n) {
  return n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100;
}

function entryOptimizer(price, atr, support, resistance) {
  if (price == null) return null;
  const a = atr != null && atr > 0 ? atr : price * 0.015;
  const nearSupport = support != null && support < price && (price - support) / price < 0.04;
  const ideal = nearSupport
    ? round2(Math.max(support * 1.002, price - a * 0.35))
    : round2(price - a * 0.25);
  const aggressive = round2(price); // market
  const conservative = round2(Math.min(price, ideal != null ? ideal : price));
  const stop = support != null && support < price
    ? round2(support - a * 0.15)
    : round2(price - a * 1.2);
  const t5 = round2(price * 1.05);
  const risk = conservative != null && stop != null ? conservative - stop : null;
  const reward = conservative != null && t5 != null ? t5 - conservative : null;
  const rr = risk > 0 && reward != null ? round2(reward / risk) : null;
  return {
    currentPrice: round2(price),
    recommendedEntry: conservative,
    entryZone: ideal != null ? `${round2(Math.min(ideal, price))} – ${round2(price)}` : String(round2(price)),
    stopLoss: stop,
    target5Pct: t5,
    riskRewardTo5: rr,
    rationale: nearSupport
      ? 'Prefer pull toward nearby support for better downside buffer'
      : 'Slight limit below last for better R:R vs chasing',
  };
}

function hardRejects({ path, analysis, marketTrend, events, entry }) {
  const rejects = [];
  if (!path || path.status === 'insufficient_history') {
    rejects.push({ code: 'LOW_SAMPLE', msg: `Insufficient history sample (n=${path?.sampleSize ?? 0})` });
  } else if (path.sampleSize < MIN_SAMPLE) {
    rejects.push({ code: 'LOW_SAMPLE', msg: `Sample n=${path.sampleSize} < ${MIN_SAMPLE}` });
  }
  if (path?.p5Before2?.upBeforeDownPct != null && path.p5Before2.upBeforeDownPct < MIN_P5_BEFORE_2) {
    rejects.push({
      code: 'WEAK_PATH',
      msg: `P(+5% before -2%) only ${path.p5Before2.upBeforeDownPct}% (need ≥${MIN_P5_BEFORE_2}%)`,
    });
  }
  if (path?.avgMaePct != null && path.avgMaePct < MAX_AVG_MAE) {
    rejects.push({ code: 'HIGH_MAE', msg: `Avg adverse ${path.avgMaePct}% too deep` });
  }
  if (entry?.riskRewardTo5 != null && entry.riskRewardTo5 < MIN_RR) {
    rejects.push({ code: 'POOR_RR', msg: `R:R to +5% is 1:${entry.riskRewardTo5} (need ≥${MIN_RR})` });
  }
  const rsi = analysis?.indicators?.rsi14;
  if (rsi != null && rsi > 78) rejects.push({ code: 'OVERBOUGHT', msg: `RSI ${rsi.toFixed(0)} overbought — chase risk` });
  if (marketTrend === 'bearish' || marketTrend === 'down') {
    rejects.push({ code: 'MARKET', msg: 'Market tape soft — fighting index' });
  }
  if (events?.daysUntil != null && events.daysUntil >= 0 && events.daysUntil <= 2) {
    rejects.push({ code: 'EVENT', msg: `Earnings in ${events.daysUntil}d — gap risk` });
  }
  const res = analysis?.supportResistance?.resistance;
  const price = analysis?.price;
  if (res != null && price != null && ((res - price) / price) * 100 < 2.5 && ((res - price) / price) * 100 > 0) {
    rejects.push({ code: 'RESISTANCE', msg: 'Resistance within ~2.5% — +5% path blocked' });
  }
  if (analysis?.setup?.quality === 'falling_knife') {
    rejects.push({ code: 'FALLING_KNIFE', msg: 'Falling knife setup' });
  }
  return rejects;
}

function confidenceFrom(path, rejects) {
  if (!path || path.sampleSize < MIN_SAMPLE) return { label: 'NONE', score: 0 };
  if (rejects.length) return { label: 'REJECTED', score: 0 };
  let score = 40;
  score += Math.min(25, (path.sampleSize / MIN_SAMPLE_HIGH) * 25);
  if (path.p5Before2?.upBeforeDownPct != null) score += (path.p5Before2.upBeforeDownPct - 50) * 0.6;
  if (path.status === 'ok') score += 8;
  if (path.status === 'low_sample') score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 72 ? 'HIGH' : score >= 55 ? 'MEDIUM' : 'LOW';
  return { label, score, sampleSize: path.sampleSize };
}

async function evaluateSymbol(symbol, opts = {}) {
  const sym = String(symbol).toUpperCase().replace(/\.(NS|BO)$/i, '');
  const [candles, quote, marketContext, events] = await Promise.all([
    marketData.getHistorical(sym, 800),
    marketData.getQuote(sym).catch(() => ({})),
    getMarketTrend().catch(() => ({ trend: 'neutral' })),
    marketData.getEvents(sym).catch(() => ({})),
  ]);
  if (!candles?.length) {
    return {
      symbol: sym,
      decision: 'NO TRADE — WAIT FOR BETTER SETUP',
      reason: 'No price history',
      confidence: { label: 'NONE', score: 0 },
    };
  }
  const analysis = analyze(candles, quote, marketContext);
  const path = estimatePathProbabilities(candles, {
    lookAheadDays: Number(opts.lookAheadDays) || 10,
    entryScore: Number(opts.entryScore) || 2.0,
  });
  const atr = analysis.indicators?.atr14;
  const support = analysis.supportResistance?.support;
  const resistance = analysis.supportResistance?.resistance;
  const price = quote.lastPrice ?? analysis.price;
  const entry = entryOptimizer(price, atr, support, resistance);

  const trend = marketContext?.trend || marketContext?.todayDirection;
  const rejects = hardRejects({ path, analysis, marketTrend: trend, events, entry });

  // Soft path when sample low — still NO TRADE
  const conf = confidenceFrom(path, rejects);

  let decision = 'NO TRADE — WAIT FOR BETTER SETUP';
  if (!rejects.length && conf.score >= 55 && path?.p5Before2?.upBeforeDownPct >= MIN_P5_BEFORE_2) {
    decision = 'BUY CANDIDATE — ENTRY ZONE ONLY';
  } else if (!rejects.length && conf.score >= 48) {
    decision = 'WATCH — WAIT FOR BETTER ENTRY';
  }

  // Optional backtest snapshot (may be slow — only when requested)
  let engineBacktest = null;
  if (opts.includeBacktest) {
    try {
      engineBacktest = runBacktest(candles, { includeCosts: true });
    } catch (_) {}
  }

  const simulation = {
    pPlus5BeforeMinus1: path?.p5Before1 || null,
    pPlus5BeforeMinus2: path?.p5Before2 || null,
    pPlus5BeforeMinus3: path?.p5Before3 || null,
    avgMfePct: path?.avgMfePct ?? null,
    avgMaePct: path?.avgMaePct ?? null,
    medianDaysToPlus5: path?.medianDaysToPlus5 ?? null,
    sampleSize: path?.sampleSize ?? 0,
    lookAheadDays: path?.lookAheadDays ?? 10,
  };

  return {
    symbol: sym,
    decision,
    confidence: conf,
    rejects,
    path,
    entry,
    simulation,
    marketTrend: trend,
    events: {
      nextEarnings: events?.nextEarnings || null,
      daysUntil: events?.daysUntil ?? null,
    },
    technical: {
      score: analysis.score,
      verdict: analysis.verdict,
      rsi: analysis.indicators?.rsi14 ?? null,
      support,
      resistance,
      setup: analysis.setup || null,
    },
    engineBacktest: engineBacktest
      ? {
          totalTrades: engineBacktest.totalTrades ?? engineBacktest.net?.totalTrades,
          winRate: engineBacktest.winRate ?? engineBacktest.net?.winRate,
          maxDrawdownPct: engineBacktest.maxDrawdownPct ?? engineBacktest.net?.maxDrawdownPct,
          expectancyPct: engineBacktest.expectancyPct ?? engineBacktest.net?.expectancyPct,
          backtestConfidence: engineBacktest.backtestConfidence,
          sampleNote: engineBacktest.sampleNote,
        }
      : null,
    honesty: [
      'P(+5% before −X%) = this stock\'s own past similar signals — not market-wide magic.',
      'NO TRADE is the default when sample, path, R:R, market or events fail gates.',
      'Never auto-average a loser; thesis must still clear the same gates.',
    ],
    asOf: new Date().toISOString(),
  };
}

/**
 * Live position defense — after entry
 */
function defendPosition({ entryPrice, price, path, analysis, marketTrend, userStance }) {
  if (entryPrice == null || price == null) {
    return { action: 'WAIT', label: 'Data incomplete', reason: 'Need entry + live price' };
  }
  const pnlPct = ((price - entryPrice) / entryPrice) * 100;
  const rejects = [];
  const trend = marketTrend;
  if (trend === 'bearish' || trend === 'down') rejects.push('Market soft');
  if (analysis?.setup?.quality === 'falling_knife') rejects.push('Structure break');

  // Never auto average loss
  let action = 'HOLD';
  let label = 'Hold — thesis check';
  let reason = `P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

  if (pnlPct <= -2.5 || (path?.avgMaePct != null && pnlPct <= path.avgMaePct * 0.8)) {
    action = 'EXIT';
    label = 'Exit — adverse beyond plan';
    reason = 'Downside exceeds statistical comfort; do not average.';
  } else if (pnlPct >= 5) {
    action = 'TRAIL';
    label = 'Trail / book partial';
    reason = '+5% zone reached — protect gains, trail stop.';
  } else if (pnlPct >= 3) {
    action = 'TRAIL';
    label = 'Tighten stop';
    reason = 'Favorable move — lock risk free if possible.';
  } else if (pnlPct < 0 && rejects.length) {
    action = 'EXIT';
    label = 'Exit — thesis + market weak';
    reason = rejects.join('; ') + ' — no averaging.';
  } else if (pnlPct < -1 && pnlPct > -2.5) {
    action = 'WAIT';
    label = 'Wait — do not add';
    reason = 'Underwater but within MAE band — no average down.';
  } else if (pnlPct > 0 && !rejects.length) {
    action = 'HOLD';
    label = 'Hold';
    reason = 'In profit, structure ok.';
  }

  // ADD ONLY IF SAFE — only when green and path still strong
  let addAllowed = false;
  if (
    action === 'HOLD' &&
    pnlPct >= 1 &&
    path?.p5Before2?.upBeforeDownPct >= 60 &&
    (path?.sampleSize || 0) >= MIN_SAMPLE
  ) {
    addAllowed = true;
  }

  return {
    action,
    label,
    reason,
    pnlPct: round2(pnlPct),
    addAllowed,
    addNote: addAllowed
      ? 'ADD ONLY IF SAFE — original thesis still valid, already green, path stats strong. Never average a loss.'
      : 'Averaging a loss is blocked by engine rules.',
  };
}

async function scanUniverseTop(opts = {}) {
  const { getCombinedUniverseScan } = require('./universeScan');
  const limit = Math.min(8, Number(opts.limit) || 5);
  const scan = await getCombinedUniverseScan();
  const ranked = (scan.results || [])
    .filter((r) => r.score != null && r.score >= 1.5 && r.price != null && r.price < 6000)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 25);

  const evaluated = [];
  for (const r of ranked) {
    try {
      const ev = await evaluateSymbol(r.symbol, { includeBacktest: false });
      evaluated.push(ev);
    } catch (_) {}
    if (evaluated.filter((e) => e.decision?.startsWith('BUY')).length >= limit) break;
  }

  const buys = evaluated.filter((e) => e.decision?.startsWith('BUY'));
  const watches = evaluated.filter((e) => e.decision?.startsWith('WATCH'));
  return {
    asOf: new Date().toISOString(),
    scannedCandidates: ranked.length,
    evaluated: evaluated.length,
    buys,
    watches,
    noTradeNote:
      buys.length === 0
        ? 'NO TRADE — WAIT FOR BETTER SETUP. No candidate cleared zero-loss / +5% path gates.'
        : null,
  };
}

module.exports = {
  evaluateSymbol,
  defendPosition,
  scanUniverseTop,
  entryOptimizer,
  hardRejects,
};
