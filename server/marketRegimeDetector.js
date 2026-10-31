// server/marketRegimeDetector.js
// One combined read of "what kind of market are we in right now" - Nifty
// and Bank Nifty trend (via the same rule engine used everywhere else) and
// India VIX level for a volatility regime. Now multi-source: tries Upstox
// first for these index quotes/candles, falls back to Yahoo, and tracks
// which source supplied each piece. Cached briefly since this is the same
// for every stock/user at a given moment.
//
// Day-wise honesty: technical multi-day score can lag a single strong
// green/red day. We therefore expose BOTH:
//   - technicalTrend (multi-day score-based Bullish/Bearish/Sideways)
//   - todayDirection (today's % change: Up / Down / Flat)
// The banner uses a combined label so a green day is not mis-labelled
// "Bearish" solely because the multi-day technical score is still weak.
const { getMultiSourceQuote, getMultiSourceHistorical } = require('./dataProviders/aggregator');
const { analyze } = require('./indicators');
const { classifyLearningRegime } = require('./learningRegime');

const CACHE_MS = 60 * 1000; // 60s — banner stays closer to live
let cache = { data: null, ts: 0 };

function flattenQuote(msQuote) {
  const flat = { symbol: msQuote.symbol };
  for (const [field, info] of Object.entries(msQuote.fields)) flat[field] = info.value;
  return flat;
}

async function safeAnalyze(symbol) {
  try {
    const [msQuote, msHist] = await Promise.all([
      getMultiSourceQuote(symbol),
      getMultiSourceHistorical(symbol, 400),
    ]);
    if (!msHist.candles.length) return null;
    const quote = flattenQuote(msQuote);
    const result = analyze(msHist.candles, quote);
    // Prefer live quote pChange for "today" when available; fall back to
    // periodReturns.oneDay from candles (last close vs prior close).
    const oneDayFromQuote = quote.pChange != null ? quote.pChange : null;
    const oneDay = oneDayFromQuote != null ? oneDayFromQuote : (result.periodReturns?.oneDay ?? null);
    return {
      ...result,
      oneDayChangePct: oneDay,
      quotePChange: quote.pChange ?? null,
      asOf: quote.asOf || null,
      marketState: quote.marketState || null,
      quoteSource: msQuote.fields.lastPrice?.source || 'unavailable',
      historySource: msHist.source,
    };
  } catch (err) {
    console.error(`[marketRegime] failed for ${symbol}:`, err.message);
    return null;
  }
}

function todayDirectionFromPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'Unknown';
  if (pct > 0.25) return 'Up';
  if (pct < -0.25) return 'Down';
  return 'Flat';
}

function combinedTrendLabel(technicalTrend, todayDir, oneDayPct) {
  // Prefer not to scream "Bearish" on a clearly green day (and vice versa).
  if (todayDir === 'Up' && technicalTrend === 'Bearish') {
    return oneDayPct != null && oneDayPct >= 0.6 ? 'Recovering (today up)' : 'Mixed (tech bearish, today up)';
  }
  if (todayDir === 'Down' && technicalTrend === 'Bullish') {
    return oneDayPct != null && oneDayPct <= -0.6 ? 'Softening (today down)' : 'Mixed (tech bullish, today down)';
  }
  if (todayDir === 'Up' && technicalTrend === 'Sideways') return 'Mildly Bullish (today up)';
  if (todayDir === 'Down' && technicalTrend === 'Sideways') return 'Mildly Bearish (today down)';
  return technicalTrend;
}

async function getMarketRegime() {
  if (cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;

  const [nifty, bankNifty, vixQuoteMs, liveIdx] = await Promise.all([
    safeAnalyze('^NSEI'),
    safeAnalyze('^NSEBANK'),
    getMultiSourceQuote('^INDIAVIX').catch(() => null),
    require('./liveIndices').getLiveIndices().catch(() => null),
  ]);

  // Prefer Moneycontrol live LTP + day % (matches Groww/NSE much closer than delayed Yahoo)
  if (liveIdx?.nifty50 && nifty) {
    nifty.price = liveIdx.nifty50.lastPrice;
    nifty.oneDayChangePct = liveIdx.nifty50.pChange;
    nifty.quotePChange = liveIdx.nifty50.pChange;
    nifty.asOf = liveIdx.nifty50.asOf;
    nifty.marketState = liveIdx.nifty50.marketState;
    nifty.quoteSource = 'moneycontrol';
    if (!nifty.periodReturns) nifty.periodReturns = {};
    nifty.periodReturns.oneDay = liveIdx.nifty50.pChange;
    if (liveIdx.nifty50.oneWeekPct != null) nifty.periodReturns.oneWeek = liveIdx.nifty50.oneWeekPct;
    if (liveIdx.nifty50.oneMonthPct != null) nifty.periodReturns.oneMonth = liveIdx.nifty50.oneMonthPct;
  }
  if (liveIdx?.bankNifty && bankNifty) {
    bankNifty.price = liveIdx.bankNifty.lastPrice;
    bankNifty.oneDayChangePct = liveIdx.bankNifty.pChange;
    bankNifty.quotePChange = liveIdx.bankNifty.pChange;
    bankNifty.asOf = liveIdx.bankNifty.asOf;
    bankNifty.marketState = liveIdx.bankNifty.marketState;
    bankNifty.quoteSource = 'moneycontrol';
  } else if (liveIdx?.bankNifty && !bankNifty) {
    // minimal bank object if analyze failed
  }

  const technicalTrend = !nifty ? 'Unknown'
    : nifty.score >= 1 ? 'Bullish'
    : nifty.score <= -1 ? 'Bearish'
    : 'Sideways';

  const niftyOneDay = (liveIdx?.nifty50?.pChange != null)
    ? liveIdx.nifty50.pChange
    : (nifty?.oneDayChangePct ?? null);
  const todayDirection = todayDirectionFromPct(niftyOneDay);
  const trendRegime = combinedTrendLabel(technicalTrend, todayDirection, niftyOneDay);

  let vixLevel = null;
  let vixSource = 'unavailable';
  let vixChangePct = null;
  let vixAsOf = null;
  if (vixQuoteMs?.fields?.lastPrice?.value != null) {
    vixLevel = vixQuoteMs.fields.lastPrice.value;
    vixSource = vixQuoteMs.fields.lastPrice.source || 'unavailable';
    if (vixQuoteMs.fields.pChange?.value != null) vixChangePct = vixQuoteMs.fields.pChange.value;
    if (vixQuoteMs.fields.asOf?.value) vixAsOf = vixQuoteMs.fields.asOf.value;
  }

  const volatilityRegime = vixLevel === null ? 'Unknown'
    : vixLevel >= 20 ? 'High Volatility'
    : vixLevel <= 13 ? 'Low Volatility'
    : 'Normal Volatility';

  // Optional macro (best-effort; failures leave nulls — never block regime)
  let crudeChangePct = null;
  let usdinrChangePct = null;
  let us10yChangePct = null;
  let globalSelloff = false;
  try {
    const macros = await Promise.all([
      getMultiSourceQuote('CL=F').catch(() => null),
      getMultiSourceQuote('USDINR=X').catch(() => null),
      getMultiSourceQuote('^TNX').catch(() => null),
      getMultiSourceQuote('^GSPC').catch(() => null),
      getMultiSourceQuote('^IXIC').catch(() => null),
    ]);
    const [crude, usdInr, us10y, spx, nasdaq] = macros;
    if (crude?.fields?.pChange?.value != null) crudeChangePct = crude.fields.pChange.value;
    if (usdInr?.fields?.pChange?.value != null) usdinrChangePct = usdInr.fields.pChange.value;
    if (us10y?.fields?.pChange?.value != null) us10yChangePct = us10y.fields.pChange.value;
    const spxCh = spx?.fields?.pChange?.value;
    const nqCh = nasdaq?.fields?.pChange?.value;
    if ((spxCh != null && spxCh <= -1.5) || (nqCh != null && nqCh <= -1.8)) globalSelloff = true;
  } catch (_) {}

  const learning = classifyLearningRegime({
    technicalTrend,
    todayDirection,
    niftyOneDayPct: niftyOneDay,
    vixLevel,
    vixChangePct,
    breadthRead: null,
    crudeChangePct,
    usdinrChangePct,
    us10yChangePct,
    globalSelloff,
  });

  const data = {
    nifty: nifty ? {
      price: nifty.price,
      verdict: nifty.verdict,
      score: nifty.score,
      oneDayChangePct: niftyOneDay,
      todayDirection,
      technicalTrend,
      asOf: nifty.asOf,
      marketState: nifty.marketState,
      source: nifty.quoteSource,
      periodReturns: {
        oneDay: niftyOneDay,
        oneWeek: nifty.periodReturns?.oneWeek ?? liveIdx?.nifty50?.oneWeekPct ?? null,
        oneMonth: nifty.periodReturns?.oneMonth ?? liveIdx?.nifty50?.oneMonthPct ?? null,
        week: nifty.periodReturns?.oneWeek ?? liveIdx?.nifty50?.oneWeekPct ?? null,
        month: nifty.periodReturns?.oneMonth ?? liveIdx?.nifty50?.oneMonthPct ?? null,
      },
    } : { status: 'not_available' },
    bankNifty: bankNifty ? {
      price: bankNifty.price,
      verdict: bankNifty.verdict,
      score: bankNifty.score,
      oneDayChangePct: bankNifty.oneDayChangePct,
      todayDirection: todayDirectionFromPct(bankNifty.oneDayChangePct),
      asOf: bankNifty.asOf,
      source: bankNifty.quoteSource,
      periodReturns: {
        oneDay: bankNifty.oneDayChangePct,
        oneWeek: liveIdx?.bankNifty?.oneWeekPct ?? bankNifty.periodReturns?.oneWeek ?? null,
        oneMonth: liveIdx?.bankNifty?.oneMonthPct ?? bankNifty.periodReturns?.oneMonth ?? null,
      },
    } : { status: 'not_available' },
    indiaVix: vixLevel !== null
      ? { level: vixLevel, changePct: vixChangePct, asOf: vixAsOf, source: vixSource }
      : { status: 'not_available' },
    macro: {
      crudeChangePct,
      usdinrChangePct,
      us10yChangePct,
      globalSelloff,
    },
    // Primary label shown in UI — day-aware, not pure multi-day technical
    trendRegime,
    // Explicit day-wise fields so UI / scoring can use them separately
    technicalTrend,
    todayDirection,
    volatilityRegime,
    // Learning-facing regime (BULL/BEAR/SIDEWAYS/HIGH_VOLATILITY/CRISIS/RECOVERY)
    learningRegime: learning.regime,
    crisisTags: learning.crisisTags || [],
    regimeTransition: learning.transition,
    marketBreadth: { status: 'not_available', reason: 'Exchange-wide advance/decline data is not available for free.' },
    asOf: new Date().toISOString(),
  };

  cache = { data, ts: Date.now() };
  return data;
}

function clearMarketRegimeCache() {
  cache = { data: null, ts: 0 };
  try { require('./liveIndices').clearLiveIndicesCache(); } catch (_) {}
}

module.exports = { getMarketRegime, clearMarketRegimeCache };
