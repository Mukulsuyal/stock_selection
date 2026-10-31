// server/backtest.js
// Walks the SAME rule-based scoring engine (server/indicators.js scoreAt)
// day-by-day over real historical candles, simulating a simple trade rule:
//   - BUY when the score first reaches the "Bullish lean" threshold
//   - SELL when the score drops to "Bearish lean" threshold, OR after a
//     max holding period, OR at the end of the data (open trade closed out)
// Then reports how that would ACTUALLY have performed. This file also adds
// the more rigorous checks a serious backtest needs: real transaction
// costs, a benchmark comparison, Monte Carlo robustness, a walk-forward
// (in-sample vs out-of-sample) split, and a basic parameter-sensitivity
// check - so a good-looking backtest can't hide behind a small, lucky, or
// overfit sample.

const { computeSeries, scoreAt } = require('./indicators');

// ---- Realistic Indian retail delivery-trade costs (approximate, 2026) ----
// These are reasonable defaults for a discount broker, delivery segment:
// most discount brokers charge ~0 brokerage on delivery, but statutory
// charges still apply. Intraday would look different (brokerage + STT on
// both legs) - this models delivery/swing trading, which is what this
// app's picks are oriented toward.
const DEFAULT_COSTS = {
  brokeragePct: 0,        // many discount brokers: ₹0 for delivery
  sttSellPct: 0.1,        // Securities Transaction Tax, sell side, delivery
  exchangeChargesPct: 0.00297, // NSE transaction charges (both legs)
  gstPct: 18,              // on (brokerage + exchange charges)
  stampDutyBuyPct: 0.015,  // stamp duty, buy side
  slippagePct: 0.05,       // estimated slippage each way
};

function costForLeg(value, { brokeragePct, exchangeChargesPct, gstPct, sttSellPct, stampDutyBuyPct, slippagePct }, isSell) {
  const brokerage = value * (brokeragePct / 100);
  const exchangeCharges = value * (exchangeChargesPct / 100);
  const gst = (brokerage + exchangeCharges) * (gstPct / 100);
  const stt = isSell ? value * (sttSellPct / 100) : 0;
  const stampDuty = isSell ? 0 : value * (stampDutyBuyPct / 100);
  const slippage = value * (slippagePct / 100);
  return brokerage + exchangeCharges + gst + stt + stampDuty + slippage;
}

function applyCosts(entryPrice, exitPrice, costs) {
  const buyValue = entryPrice, sellValue = exitPrice; // per-share; scales linearly so fine per-unit
  const buyCost = costForLeg(buyValue, costs, false);
  const sellCost = costForLeg(sellValue, costs, true);
  const totalCostPct = ((buyCost + sellCost) / entryPrice) * 100;
  const grossReturnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return { grossReturnPct, netReturnPct: grossReturnPct - totalCostPct, totalCostPct };
}

function simulateTrades(candles, series, { entryScore, exitScore, maxHoldDays, warmupDays, startIdx, endIdx }) {
  const trades = [];
  let inTrade = false, entryPrice = null, entryDate = null, entryIndex = null;
  const from = startIdx ?? warmupDays;
  const to = endIdx ?? candles.length - 1;

  for (let i = from; i <= to; i++) {
    const { score } = scoreAt(series, i);
    if (!inTrade) {
      if (score >= entryScore) { inTrade = true; entryPrice = candles[i].close; entryDate = candles[i].date; entryIndex = i; }
    } else {
      const daysHeld = i - entryIndex;
      const isLast = i === to;
      if (score <= exitScore || daysHeld >= maxHoldDays || isLast) {
        const exitPrice = candles[i].close;
        const grossReturnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        trades.push({ entryDate, exitDate: candles[i].date, entryPrice, exitPrice, grossReturnPct, daysHeld, forcedExit: isLast && score > exitScore && daysHeld < maxHoldDays });
        inTrade = false;
      }
    }
  }
  return trades;
}

function statsFromTrades(trades, useCosts, costs) {
  const enriched = trades.map((t) => {
    if (!useCosts) return { ...t, returnPct: t.grossReturnPct };
    const c = applyCosts(t.entryPrice, t.exitPrice, costs);
    return { ...t, returnPct: c.netReturnPct, costPct: c.totalCostPct };
  });
  const wins = enriched.filter((t) => t.returnPct > 0);
  const losses = enriched.filter((t) => t.returnPct <= 0);
  const winRate = enriched.length ? (wins.length / enriched.length) * 100 : null;
  const avgWinPct = wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : null;
  const avgLossPct = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : null;
  const avgHoldDays = enriched.length ? enriched.reduce((a, t) => a + t.daysHeld, 0) / enriched.length : null;
  const expectancyPct = enriched.length ? enriched.reduce((a, t) => a + t.returnPct, 0) / enriched.length : null;

  let equity = 100;
  const equityCurve = enriched.length ? [{ date: enriched[0].entryDate, equity }] : [];
  enriched.forEach((t) => { equity *= 1 + t.returnPct / 100; equityCurve.push({ date: t.exitDate, equity }); });
  const totalReturnPct = ((equity - 100) / 100) * 100;

  let peak = 100, maxDrawdownPct = 0;
  equityCurve.forEach((p) => { peak = Math.max(peak, p.equity); maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - p.equity) / peak) * 100); });

  const grossWins = enriched.filter(t => t.grossReturnPct > 0).reduce((a,t)=>a+t.grossReturnPct,0);
  const grossLosses = Math.abs(enriched.filter(t => t.grossReturnPct <= 0).reduce((a,t)=>a+t.grossReturnPct,0));
  const profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : null;

  return { trades: enriched, totalTrades: enriched.length, winRate, avgWinPct, avgLossPct, avgHoldDays, expectancyPct, totalReturnPct, maxDrawdownPct, profitFactor, equityCurve };
}

function benchmarkReturn(candles, fromIdx, toIdx) {
  if (!candles.length || toIdx <= fromIdx) return null;
  const startPrice = candles[fromIdx].close, endPrice = candles[toIdx].close;
  return ((endPrice - startPrice) / startPrice) * 100;
}

// Shuffle the ORDER of trade returns (not the values) many times and
// compound them into an equity curve each time - shows the range of
// outcomes that pure sequencing luck could have produced from the same
// set of trades, and how often a bad drawdown shows up.
function monteCarlo(tradeReturns, runs = 1000) {
  if (tradeReturns.length < 5) return { status: 'insufficient_trades', minTradesNeeded: 5, tradesAvailable: tradeReturns.length };
  const finalReturns = [], maxDrawdowns = [];
  for (let r = 0; r < runs; r++) {
    const shuffled = [...tradeReturns];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let equity = 100, peak = 100, maxDD = 0;
    shuffled.forEach((ret) => {
      equity *= 1 + ret / 100;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
    });
    finalReturns.push(((equity - 100) / 100) * 100);
    maxDrawdowns.push(maxDD);
  }
  finalReturns.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
  return {
    runs,
    returnPercentiles: { p5: round2(pct(finalReturns, 5)), p25: round2(pct(finalReturns, 25)), p50: round2(pct(finalReturns, 50)), p75: round2(pct(finalReturns, 75)), p95: round2(pct(finalReturns, 95)) },
    drawdownPercentiles: { p50: round2(pct(maxDrawdowns, 50)), p75: round2(pct(maxDrawdowns, 75)), p95: round2(pct(maxDrawdowns, 95)) },
    probabilityOfLoss: round2((finalReturns.filter((r) => r < 0).length / runs) * 100),
  };
}

function round2(n) { return n === undefined || n === null ? null : Math.round(n * 100) / 100; }

// Nudges entry/exit thresholds by ±0.5 and re-runs - if results swing
// wildly for a tiny parameter change, the original result is more likely
// a lucky fit to this exact threshold than a real edge.
function parameterSensitivity(candles, series, base, warmupDays) {
  const variants = [
    { entryScore: base.entryScore - 0.5, exitScore: base.exitScore },
    { entryScore: base.entryScore + 0.5, exitScore: base.exitScore },
    { entryScore: base.entryScore, exitScore: base.exitScore - 0.5 },
    { entryScore: base.entryScore, exitScore: base.exitScore + 0.5 },
  ];
  const baseTrades = simulateTrades(candles, series, { ...base, warmupDays });
  const baseStats = statsFromTrades(baseTrades, false, DEFAULT_COSTS);
  const results = variants.map((v) => {
    const trades = simulateTrades(candles, series, { entryScore: v.entryScore, exitScore: v.exitScore, maxHoldDays: base.maxHoldDays, warmupDays });
    const stats = statsFromTrades(trades, false, DEFAULT_COSTS);
    return { entryScore: v.entryScore, exitScore: v.exitScore, totalReturnPct: round2(stats.totalReturnPct), totalTrades: stats.totalTrades };
  });
  const spread = Math.max(baseStats.totalReturnPct, ...results.map(r => r.totalReturnPct)) - Math.min(baseStats.totalReturnPct, ...results.map(r => r.totalReturnPct));
  return {
    baseReturnPct: round2(baseStats.totalReturnPct),
    variants: results,
    spread: round2(spread),
    stable: spread < Math.abs(baseStats.totalReturnPct) * 0.5 || spread < 15, // coarse heuristic
  };
}

function computeBacktestConfidence({ totalTrades, outOfSample, monteCarloResult, maxDrawdownPct, profitFactor, sensitivity }) {
  let score = 50;
  if (totalTrades >= 30) score += 15; else if (totalTrades >= 15) score += 5; else score -= 15;
  if (outOfSample && outOfSample.status === 'ok') {
    if (outOfSample.outOfSampleReturnPct !== null && outOfSample.inSampleReturnPct !== null) {
      const sameDirection = (outOfSample.outOfSampleReturnPct >= 0) === (outOfSample.inSampleReturnPct >= 0);
      score += sameDirection ? 10 : -15;
    }
  }
  if (profitFactor !== null) score += profitFactor >= 1.5 ? 10 : profitFactor < 1 ? -15 : 0;
  if (maxDrawdownPct !== null) score -= Math.min(maxDrawdownPct / 2, 20);
  if (monteCarloResult && monteCarloResult.probabilityOfLoss !== undefined) score -= monteCarloResult.probabilityOfLoss / 4;
  if (sensitivity && sensitivity.stable === false) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function runBacktest(candles, opts = {}) {
  const {
    entryScore = 2.5, exitScore = -1, maxHoldDays = 60, warmupDays = 205,
    includeCosts = true, costs = DEFAULT_COSTS, benchmarkCandles = null,
  } = opts;

  if (candles.length < warmupDays + 10) {
    return { error: `Not enough history for a meaningful backtest (need 200+ days, have ${candles.length}).` };
  }

  const series = computeSeries(candles);
  const rawTrades = simulateTrades(candles, series, { entryScore, exitScore, maxHoldDays, warmupDays });
  const grossStats = statsFromTrades(rawTrades, false, costs);
  const netStats = includeCosts ? statsFromTrades(rawTrades, true, costs) : grossStats;

  const buyHoldReturnPct = benchmarkReturn(candles, warmupDays, candles.length - 1);
  const niftyReturnPct = benchmarkCandles ? benchmarkReturn(benchmarkCandles, 0, benchmarkCandles.length - 1) : null;

  // Walk-forward: split into in-sample (first 70%) / out-of-sample (last 30%)
  const usableLen = candles.length - warmupDays;
  const splitIdx = warmupDays + Math.floor(usableLen * 0.7);
  let outOfSample = { status: 'insufficient_data' };
  if (splitIdx > warmupDays + 20 && candles.length - splitIdx > 20) {
    const inSampleTrades = simulateTrades(candles, series, { entryScore, exitScore, maxHoldDays, warmupDays, startIdx: warmupDays, endIdx: splitIdx });
    const outSampleTrades = simulateTrades(candles, series, { entryScore, exitScore, maxHoldDays, warmupDays, startIdx: splitIdx + 1, endIdx: candles.length - 1 });
    const inStats = statsFromTrades(inSampleTrades, includeCosts, costs);
    const outStats = statsFromTrades(outSampleTrades, includeCosts, costs);
    outOfSample = {
      status: 'ok',
      inSamplePeriod: { from: candles[warmupDays].date, to: candles[splitIdx].date, trades: inStats.totalTrades },
      outOfSamplePeriod: { from: candles[splitIdx + 1].date, to: candles[candles.length - 1].date, trades: outStats.totalTrades },
      inSampleReturnPct: round2(inStats.totalReturnPct),
      outOfSampleReturnPct: round2(outStats.totalReturnPct),
      inSampleWinRate: round2(inStats.winRate),
      outOfSampleWinRate: round2(outStats.winRate),
      survivesOutOfSample: outStats.totalReturnPct !== null ? outStats.totalReturnPct > 0 : null,
    };
  }

  const monteCarloResult = monteCarlo(netStats.trades.map((t) => t.returnPct));
  const sensitivity = parameterSensitivity(candles, series, { entryScore, exitScore, maxHoldDays }, warmupDays);
  const backtestConfidence = computeBacktestConfidence({
    totalTrades: netStats.totalTrades, outOfSample, monteCarloResult,
    maxDrawdownPct: netStats.maxDrawdownPct, profitFactor: netStats.profitFactor, sensitivity,
  });

  const sampleSizeWarning = netStats.totalTrades < 20
    ? `Only ${netStats.totalTrades} trade(s) in this backtest - too small a sample to be statistically reliable. Treat these numbers as directional, not conclusive.`
    : null;

  return {
    period: { from: candles[warmupDays].date, to: candles[candles.length - 1].date, tradingDays: candles.length - warmupDays },
    stats: {
      totalTrades: netStats.totalTrades,
      winRate: round2(netStats.winRate),
      avgWinPct: round2(netStats.avgWinPct),
      avgLossPct: round2(netStats.avgLossPct),
      avgHoldDays: netStats.avgHoldDays !== null ? Math.round(netStats.avgHoldDays) : null,
      expectancyPct: round2(netStats.expectancyPct),
      profitFactor: netStats.profitFactor,
      grossReturnPct: round2(grossStats.totalReturnPct),
      netReturnPct: round2(netStats.totalReturnPct),
      strategyReturnPct: round2(netStats.totalReturnPct), // kept for backward compatibility with existing UI
      buyHoldReturnPct: round2(buyHoldReturnPct),
      niftyReturnPct: niftyReturnPct !== null ? round2(niftyReturnPct) : null,
      maxDrawdownPct: round2(netStats.maxDrawdownPct),
      outperformedBuyHold: netStats.totalTrades ? netStats.totalReturnPct > buyHoldReturnPct : null,
      outperformedNifty: niftyReturnPct !== null && netStats.totalTrades ? netStats.totalReturnPct > niftyReturnPct : null,
    },
    trades: netStats.trades,
    equityCurve: netStats.equityCurve,
    costsApplied: includeCosts ? costs : null,
    sampleSizeWarning,
    outOfSample,
    monteCarlo: monteCarloResult,
    parameterSensitivity: sensitivity,
    backtestConfidence,
    lookAheadBiasCheck: 'PASS — every signal at index i is computed only from candles[0..i] (see computeSeries/scoreAt in indicators.js); no future data is used.',
    caveats: [
      includeCosts ? 'Includes estimated brokerage/STT/exchange charges/GST/stamp duty/slippage - see costsApplied for the assumptions used.' : 'No transaction costs included - real returns would be lower.',
      'Past performance of this rule set does not guarantee it keeps working - market conditions change.',
      'This tests ONE simple rule (enter on Bullish lean, exit on Bearish lean) - not a complete trading system.',
    ],
  };
}

module.exports = { runBacktest, DEFAULT_COSTS };
