// server/multiTimeframe.js
// Runs the SAME scoring engine (server/indicators.js) across 6 timeframes
// (5m, 15m, 1h, 4h, Daily, Weekly) and reports how many agree - a trade
// where every timeframe agrees is a stronger case than one where daily
// says bullish but the 15-minute chart is falling apart.
//
// Honest limitation: Yahoo Finance's free intraday history is short (~60
// days for 5m/15m/1h). Shorter timeframes here reflect recent price action
// only, not a long backtest-able history - that's a Yahoo limit, not a bug.
const marketData = require('./marketData');
const { computeSeries, scoreAt, resampleWeekly } = require('./indicators');

// Yahoo has no native "4h" interval - approximate it by grouping every 4
// consecutive 60-minute candles. Not calendar-session-aligned (India's
// trading day is ~6.25 hours, not a clean multiple of 4), but a reasonable
// approximation for a directional read.
function resampleN(candles, n) {
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const chunk = candles.slice(i, i + n);
    if (!chunk.length) continue;
    out.push({
      date: chunk[chunk.length - 1].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, c) => a + (c.volume || 0), 0),
    });
  }
  return out;
}

async function loadCandlesFor(symbol, key) {
  switch (key) {
    case '5m': return marketData.getIntradayCandles(symbol, '5d', '5m');
    case '15m': return marketData.getIntradayCandles(symbol, '5d', '15m');
    case '1h': return marketData.getIntradayCandles(symbol, '1mo', '60m');
    case '4h': return resampleN(await marketData.getIntradayCandles(symbol, '3mo', '60m'), 4);
    case 'daily': return marketData.getHistorical(symbol, 500);
    case 'weekly': return resampleWeekly(await marketData.getHistorical(symbol, 1260));
    default: return [];
  }
}

async function analyzeTimeframe(symbol, key) {
  try {
    const candles = await loadCandlesFor(symbol, key);
    if (candles.length < 25) return { timeframe: key, status: 'insufficient_data', candleCount: candles.length };
    const series = computeSeries(candles);
    const i = candles.length - 1;
    const result = scoreAt(series, i);
    return { timeframe: key, verdict: result.verdict, score: Number(result.score.toFixed(2)), price: result.price, candleCount: candles.length };
  } catch (err) {
    return { timeframe: key, status: 'error', error: err.message };
  }
}

async function getMultiTimeframeAnalysis(symbol) {
  const keys = ['5m', '15m', '1h', '4h', 'daily', 'weekly'];
  // Sequential, not parallel - these are 6 extra Yahoo calls per symbol;
  // pacing them avoids tripping rate limits the way a burst would.
  const results = [];
  for (const key of keys) {
    results.push(await analyzeTimeframe(symbol, key));
    await new Promise((r) => setTimeout(r, 200));
  }

  const valid = results.filter((r) => r.score !== undefined);
  const bullishCount = valid.filter((r) => r.score > 0).length;
  const bearishCount = valid.filter((r) => r.score < 0).length;
  const alignmentScore = valid.length ? Math.round((Math.max(bullishCount, bearishCount) / valid.length) * 100) : null;
  const dominant = bullishCount > bearishCount ? 'bullish' : bearishCount > bullishCount ? 'bearish' : 'mixed';

  return {
    symbol,
    timeframes: results,
    alignmentScore, // 0-100: what % of available timeframes agree with the majority direction
    dominant,
    note: 'Yahoo Finance intraday history is limited (~60 days for 5m/15m/1h, ~3 months for the 4h approximation) - shorter timeframes reflect only recent price action, not a deep history.',
  };
}

module.exports = { getMultiTimeframeAnalysis };
