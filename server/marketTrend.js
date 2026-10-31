// server/marketTrend.js
// Computes the broader market's (Nifty 50) current trend once and caches it
// briefly, so every stock analysis can factor in "is the overall market
// bullish or bearish right now" without hammering Yahoo for every request.
//
// Day-wise: also exposes today's % change so scoring/UI can distinguish
// "technically still weak" from "today is actually green".
const marketData = require('./marketData');
const { analyze } = require('./indicators');

const CACHE_MS = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, ts: 0 };

async function getMarketTrend() {
  if (cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;
  try {
    const [quote, candles] = await Promise.all([
      marketData.getQuote('^NSEI'),
      marketData.getHistorical('^NSEI', 300),
    ]);
    const result = analyze(candles, quote);
    // Prefer live quote day-change when present
    const oneDay = quote.pChange != null ? quote.pChange : (result.periodReturns?.oneDay ?? null);
    if (result.periodReturns) result.periodReturns.oneDay = oneDay;

    const technicalTrend = result.score >= 1 ? 'bullish' : result.score <= -1 ? 'bearish' : 'neutral';
    // Soften pure technical label when today's move clearly disagrees
    let trend = technicalTrend;
    if (oneDay != null) {
      if (technicalTrend === 'bearish' && oneDay > 0.4) trend = 'neutral';
      if (technicalTrend === 'bullish' && oneDay < -0.4) trend = 'neutral';
    }

    // Best-effort learning regime (from full regime detector) — non-blocking
    let learningRegime = null;
    let crisisTags = [];
    try {
      const { getMarketRegime } = require('./marketRegimeDetector');
      const reg = await getMarketRegime();
      learningRegime = reg.learningRegime || null;
      crisisTags = reg.crisisTags || [];
    } catch (_) {}

    cache = {
      data: {
        trend,
        technicalTrend,
        score: result.score,
        verdict: result.verdict,
        niftyPrice: result.price,
        periodReturns: result.periodReturns,
        oneDayChangePct: oneDay,
        todayDirection: oneDay == null ? 'unknown' : oneDay > 0.25 ? 'up' : oneDay < -0.25 ? 'down' : 'flat',
        asOf: quote.asOf || null,
        marketState: quote.marketState || null,
        learningRegime,
        crisisTags,
      },
      ts: Date.now(),
    };
    return cache.data;
  } catch (err) {
    console.error('[marketTrend] could not fetch Nifty trend:', err.message);
    return {
      trend: 'neutral', technicalTrend: 'neutral', score: 0, verdict: 'Unknown',
      niftyPrice: null, periodReturns: null, oneDayChangePct: null,
      todayDirection: 'unknown', asOf: null, marketState: null,
    };
  }
}

module.exports = { getMarketTrend };
