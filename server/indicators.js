// server/indicators.js
// Pure-JS technical indicators + a transparent, rule-based "verdict" engine.
//
// IMPORTANT: This produces an educational, rule-based read of the numbers -
// it is NOT financial advice and does not predict the future. Every factor
// used is returned explicitly so the user can see exactly *why* a suggestion
// was made and judge it themselves.
//
// Design note: the scoring logic lives in ONE place - scoreAt() - and is
// used both for "what does today look like" (analyze) and for "what would
// this have said on every past day" (server/backtest.js). This keeps live
// analysis and backtests honest about testing the exact same rules.

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

function ema(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      const seed = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
      prev = seed;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValsOnly = macdLine.filter((v) => v !== null);
  const signalOnly = ema(macdValsOnly, signalPeriod);
  const signalLine = new Array(macdLine.length).fill(null);
  let idx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) { signalLine[i] = signalOnly[idx]; idx++; }
  }
  const histogram = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  // Wilder's smoothing (same style as RSI averaging)
  let avg = trueRanges.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = avg;
  for (let i = period + 1; i < candles.length; i++) {
    avg = (avg * (period - 1) + trueRanges[i]) / period;
    out[i] = avg;
  }
  return out;
}

// Trading-day lookback counts for period returns (approx - markets are
// closed weekends/holidays so calendar days don't map 1:1 to candles).
const PERIODS = {
  oneDay: 1, oneWeek: 5, fifteenDay: 11, oneMonth: 21,
  twoMonth: 42, threeMonth: 63, oneYear: 252, fiveYear: 1260,
};

// Groups daily candles into weekly candles (Mon-Fri bucketed by ISO week),
// so the weekly timeframe can be read with the exact same scoring engine as
// daily - no extra API calls needed, it's derived from the same data.
function resampleWeekly(candles) {
  const weeks = new Map();
  for (const c of candles) {
    const d = new Date(c.date);
    // ISO week key: year + week number (Monday-start week)
    const day = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day);
    const key = monday.toISOString().slice(0, 10);

    if (!weeks.has(key)) {
      weeks.set(key, { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      const w = weeks.get(key);
      w.high = Math.max(w.high, c.high);
      w.low = Math.min(w.low, c.low);
      w.close = c.close;
      w.date = c.date; // keep latest date in the week
      w.volume += c.volume || 0;
    }
  }
  return [...weeks.values()];
}

function computePeriodReturns(candles) {
  const out = {};
  const lastClose = candles.length ? candles[candles.length - 1].close : null;
  for (const [key, back] of Object.entries(PERIODS)) {
    if (lastClose == null || candles.length <= back) { out[key] = null; continue; }
    const past = candles[candles.length - 1 - back].close;
    out[key] = past ? ((lastClose - past) / past) * 100 : null;
  }
  return out;
}

/**
 * How many consecutive sessions has the stock closed down (or up) in a
 * row, counting back from the most recent day. A stock that's been red
 * for 4-5 straight days (even if each day is small, like -0.5%, -0.2%,
 * -1%, -2%, -0.1%) shows up as streakDirection: 'down', streakDays: 5 -
 * useful for spotting continuous bleeders or, on the flip side, stocks on
 * a genuine multi-day run.
 */
// Day-by-day change for the last `days` trading days, most recent last -
// the raw material for "day by day: which day fell how much, which day
// rose, and by how much" instead of a single current-streak number that
// resets to 0 on any 1-day bounce even after an 8-day fall.
function computeRecentDailyChanges(candles, days = 15) {
  if (!candles || candles.length < days + 1) return [];
  const recent = candles.slice(-(days + 1));
  const out = [];
  for (let i = 1; i < recent.length; i++) {
    const changePct = ((recent[i].close - recent[i - 1].close) / recent[i - 1].close) * 100;
    out.push({ date: recent[i].date, changePct: Number(changePct.toFixed(2)) });
  }
  return out;
}

function computeStreak(candles) {
  if (candles.length < 2) return { direction: 'flat', days: 0, dailyChangesPct: [] };
  let direction = null;
  let days = 0;
  const dailyChangesPct = [];
  for (let i = candles.length - 1; i > 0; i--) {
    const change = candles[i].close - candles[i - 1].close;
    const changePct = (change / candles[i - 1].close) * 100;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    if (direction === null) {
      if (dir === 'flat') break;
      direction = dir;
    }
    if (dir !== direction) break;
    days += 1;
    dailyChangesPct.unshift(Number(changePct.toFixed(2)));
  }
  return { direction: direction || 'flat', days, dailyChangesPct };
}

// Note: `candles` are Yahoo Finance daily bars - Yahoo simply has no row
// for a weekend or an NSE holiday (the exchange didn't trade), so every
// "days" count here (this streak, the mini-streaks below, targetTimeline
// horizons, etc.) is ALREADY counting trading days only, never calendar
// days - there's no separate weekend/holiday filter needed on candle data.

// The single current streak (computeStreak) hides the recent back-and-forth
// - "fell 6 days, bounced 2%, fell 2 more days" reads very differently
// from "fell 6 days straight", even though the current streak in both
// cases might just say "down 2". This walks back further and returns each
// consecutive same-direction run in order, so that fuller picture is
// visible instead of only the most recent run.
function summarizeRecentStreaks(candles, lookbackDays = 15) {
  if (!candles || candles.length < lookbackDays + 2) return [];
  const recent = candles.slice(-(lookbackDays + 1));
  const streaks = [];
  let curDir = null, curDays = 0, curStartClose = null;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close - recent[i - 1].close;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    if (dir === curDir) {
      curDays += 1;
    } else {
      if (curDir !== null) streaks.push({ direction: curDir, days: curDays, startClose: curStartClose, endClose: recent[i - 1].close });
      curDir = dir; curDays = 1; curStartClose = recent[i - 1].close;
    }
  }
  if (curDir !== null) streaks.push({ direction: curDir, days: curDays, startClose: curStartClose, endClose: recent[recent.length - 1].close });
  return streaks
    .filter((s) => s.direction !== 'flat')
    .map((s) => ({
      direction: s.direction,
      days: s.days,
      changePct: Number((((s.endClose - s.startClose) / s.startClose) * 100).toFixed(2)),
    }));
}

// Turns the mini-streak list into one readable line, e.g. "fell 6d (-8.2%)
// -> rose 1d (+2.1%) -> fell 2d (-1.5%)" - only the most recent handful so
// it doesn't get noisy on a choppy stock.
function describeRecentStreaks(streaks) {
  if (!streaks || streaks.length < 2) return null; // a single run is just the normal streak line, nothing extra to say
  const tail = streaks.slice(-4);
  const verb = { up: 'rose', down: 'fell', flat: 'flat' };
  return tail.map((s) => `${verb[s.direction]} ${s.days}d (${s.changePct >= 0 ? '+' : ''}${s.changePct}%)`).join(' \u2192 ');
}

/**
 * Finds recent swing highs/lows (local pivots) and clusters nearby ones
 * into support/resistance zones. A pivot high is a candle whose high is
 * the max within a small window on both sides (and similarly for lows).
 */
function findSupportResistance(candles, lookback = 90, currentPrice = null) {
  const recent = candles.slice(-lookback);
  if (recent.length < 15) return { support: [], resistance: [] };
  const window = 3;
  const pivotHighs = [], pivotLows = [];

  for (let i = window; i < recent.length - window; i++) {
    const slice = recent.slice(i - window, i + window + 1);
    if (recent[i].high === Math.max(...slice.map((c) => c.high))) pivotHighs.push(recent[i].high);
    if (recent[i].low === Math.min(...slice.map((c) => c.low))) pivotLows.push(recent[i].low);
  }

  // Cluster levels within 1% of each other, keep the count as "strength"
  function cluster(levels) {
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [];
    for (const lvl of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(lvl - last.level) / last.level < 0.01) {
        last.level = (last.level * last.count + lvl) / (last.count + 1);
        last.count += 1;
      } else {
        clusters.push({ level: lvl, count: 1 });
      }
    }
    return clusters;
  }

  const price = currentPrice ?? recent[recent.length - 1].close;
  const resistance = cluster(pivotHighs)
    .filter((c) => c.level > price)
    .sort((a, b) => a.level - b.level)
    .slice(0, 3);
  const support = cluster(pivotLows)
    .filter((c) => c.level < price)
    .sort((a, b) => b.level - a.level)
    .slice(0, 3);

  return {
    resistance: resistance.map((c) => ({ level: c.level, strength: c.count })),
    support: support.map((c) => ({ level: c.level, strength: c.count })),
  };
}

/**
 * Basic candlestick pattern detection on the most recent 1-3 candles.
 * These describe short-term price action, not a prediction - shown as
 * extra context alongside the indicator-based factors.
 */
function detectCandlePatterns(candles) {
  if (candles.length < 3) return [];
  const patterns = [];
  const [prev2, prev, last] = candles.slice(-3);

  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => c.high - c.low || 0.0001;
  const upperWick = (c) => c.high - Math.max(c.open, c.close);
  const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
  const isBullish = (c) => c.close > c.open;
  const isBearish = (c) => c.close < c.open;

  // Doji - open ≈ close relative to the day's range
  if (body(last) / range(last) < 0.1) {
    patterns.push({ pattern: 'Doji', note: 'Open and close are almost equal — indecision, often before a reversal or pause.' });
  }

  // Hammer - small body near the top, long lower wick, little upper wick
  if (lowerWick(last) > body(last) * 2 && upperWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.4) {
    patterns.push({ pattern: 'Hammer', note: 'Long lower wick, small body — buyers stepped in after a sell-off. More meaningful after a downtrend.' });
  }

  // Shooting star - small body near the bottom, long upper wick
  if (upperWick(last) > body(last) * 2 && lowerWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.4) {
    patterns.push({ pattern: 'Shooting Star', note: 'Long upper wick, small body — sellers pushed back a rally. More meaningful after an uptrend.' });
  }

  // Bullish / Bearish Engulfing - today's body fully engulfs yesterday's
  if (isBearish(prev) && isBullish(last) && last.close > prev.open && last.open < prev.close) {
    patterns.push({ pattern: 'Bullish Engulfing', note: "Today's green candle fully covers yesterday's red one — buyers took control." });
  }
  if (isBullish(prev) && isBearish(last) && last.open > prev.close && last.close < prev.open) {
    patterns.push({ pattern: 'Bearish Engulfing', note: "Today's red candle fully covers yesterday's green one — sellers took control." });
  }

  return patterns;
}

/**
 * Builds a concrete, actionable trade plan (entry range, stop-loss,
 * target) instead of leaving it as an exercise for the user. Prefers real
 * support/resistance zones over arbitrary ATR multiples where available -
 * a stop placed just under actual support gives the trade room to breathe
 * (less likely to get shaken out by normal noise) and a target placed just
 * under actual resistance is a more realistic level to actually reach than
 * a number pulled out of thin air.
 */
function generateTradePlan(price, atr14, supportResistance) {
  if (!price) return null;
  const support = supportResistance?.support?.[0]?.level ?? null;
  const resistance = supportResistance?.resistance?.[0]?.level ?? null;

  const stopLoss = support && support < price
    ? support * 0.99
    : (atr14 ? price - 1.5 * atr14 : null);
  const target = resistance && resistance > price
    ? resistance * 0.995
    : (atr14 ? price + 2.5 * atr14 : null);

  if (!stopLoss || !target || stopLoss >= price || target <= price) return null;

  const risk = price - stopLoss;
  const reward = target - price;
  const riskRewardRatio = risk > 0 ? reward / risk : null;

  return {
    entryLow: Number((price * 0.995).toFixed(2)),
    entryHigh: Number((price * 1.01).toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    target: Number(target.toFixed(2)),
    riskRewardRatio: riskRewardRatio !== null ? Number(riskRewardRatio.toFixed(2)) : null,
    basis: support && resistance ? 'support/resistance zones' : 'volatility (ATR) - no clear support/resistance nearby',
  };
}

/**
 * Classifies the setup as 'momentum' (already trending up, score-driven)
 * or 'reversal' (was falling, now turning up near support - a bounce
 * candidate that a pure "highest score" filter would miss, since its
 * longer-term trend score can still be negative even as the last few days
 * turn up). Swing traders often care about both, not just whatever is
 * bullish right this second.
 */
function detectSetupType({ score, verdict, streak, periodReturns, indicators, supportResistance, price, volumeRatio, candles }) {
  const rsi = indicators?.rsi14;
  const support = supportResistance?.support?.[0];
  const resistance = supportResistance?.resistance?.[0];
  const nearSupport = support && price ? Math.abs(price - support.level) / price < 0.03 : false;
  const nearResistance = resistance && price ? Math.abs(price - resistance.level) / price < 0.025 : false;
  const declineBase = periodReturns?.fifteenDay ?? periodReturns?.oneMonth;
  const wasDeclining = declineBase !== null && declineBase < -4;
  const deepDecline = declineBase !== null && declineBase < -10;
  const turningUp = streak?.direction === 'up' && streak.days >= 1 && streak.days <= 4;
  const rsiRecovering = rsi !== null && rsi >= 25 && rsi <= 48;
  const rsiHealthy = rsi !== null && rsi >= 45 && rsi <= 68;
  const vol = volumeRatio ?? indicators?.volSpike ?? null;

  // Higher-low vs prior swing (simple: last close > close 3–5 bars ago while still recovering)
  let higherLow = false;
  if (candles && candles.length >= 8 && price) {
    const recent = candles.slice(-6);
    const lows = recent.map((c) => c.low);
    higherLow = lows[lows.length - 1] > Math.min(...lows.slice(0, -2));
  }
  // Volume exhaustion: last down-leg not expanding volume
  let volumeExhaustion = false;
  if (candles && candles.length >= 6) {
    const last3 = candles.slice(-3);
    const prev3 = candles.slice(-6, -3);
    const avg = (arr) => arr.reduce((s, c) => s + (c.volume || 0), 0) / Math.max(arr.length, 1);
    volumeExhaustion = avg(last3) < avg(prev3) * 0.95 && turningUp;
  }
  const reclaimShortHigh = nearResistance && turningUp && (vol == null || vol >= 1.2);

  // --- Reversal / bounce (strict quality labels) ---
  if (wasDeclining && turningUp) {
    const confirms = [];
    if (nearSupport) confirms.push('support_hold');
    if (rsiRecovering || (rsi != null && rsi > 30 && rsi < 55)) confirms.push('rsi_recovery');
    if (higherLow) confirms.push('higher_low');
    if (volumeExhaustion) confirms.push('volume_exhaustion');
    if (reclaimShortHigh || (vol != null && vol >= 1.5 && turningUp)) confirms.push('volume_or_reclaim');
    if (streak.days >= 2) confirms.push('multi_day_turn');

    const parts = [`fell ${Math.abs(declineBase).toFixed(1)}% recently`, `now up ${streak.days}d`];
    if (nearSupport) parts.push('near support');
    if (rsiRecovering) parts.push(`RSI ${rsi.toFixed(0)} recovering`);
    if (higherLow) parts.push('higher-low forming');
    if (volumeExhaustion) parts.push('selling volume easing');

    // Falling knife: still declining hard, weak confirms
    if (deepDecline && confirms.length < 2 && (!nearSupport || streak.days < 2)) {
      return {
        type: 'reversal',
        quality: 'falling_knife',
        reason: parts.join(', ') + ' — falling-knife risk (not confirmed reversal).',
        confirms,
      };
    }
    if (confirms.length >= 4 && nearSupport && (higherLow || reclaimShortHigh)) {
      return {
        type: 'reversal',
        quality: 'confirmed',
        reason: parts.join(', ') + ' — confirmed reversal confluence.',
        confirms,
      };
    }
    if (confirms.length >= 2 && (nearSupport || rsiRecovering)) {
      return {
        type: 'reversal',
        quality: 'possible',
        reason: parts.join(', ') + ' — possible reversal (needs more confirmation).',
        confirms,
      };
    }
    // weak — still tag as reversal possible only if near support
    if (nearSupport || rsiRecovering) {
      return {
        type: 'reversal',
        quality: 'possible',
        reason: parts.join(', ') + '.',
        confirms,
      };
    }
  }

  // --- Breakout: score ok, near resistance, volume ---
  if (score >= 1.5 && nearResistance && vol != null && vol >= 1.4 && streak?.direction === 'up') {
    return {
      type: 'breakout',
      quality: vol >= 2 ? 'strong' : 'standard',
      reason: `Near resistance with volume ${Number(vol).toFixed(1)}x — breakout attempt.`,
      confirms: ['near_resistance', 'volume'],
    };
  }

  // --- Pullback: uptrend context (1m positive or score), price near support, not new high chase ---
  const oneM = periodReturns?.oneMonth;
  if ((score >= 1 || (oneM != null && oneM > 3)) && nearSupport && rsiHealthy && streak?.direction !== 'down') {
    return {
      type: 'pullback',
      quality: 'standard',
      reason: `Pullback toward support in constructive structure (RSI ${rsi != null ? rsi.toFixed(0) : '—'}).`,
      confirms: ['near_support', 'rsi_healthy'],
    };
  }

  // --- Momentum: strong score trend ---
  if (score >= 2) {
    return {
      type: 'momentum',
      quality: score >= 4 ? 'strong' : 'standard',
      reason: `Strong technical score (${score.toFixed(1)}), verdict "${verdict}".`,
      confirms: ['score'],
    };
  }

  return { type: null, quality: null, reason: null, confirms: [] };
}

/**
 * The single source of truth for what indicators look like day-by-day.
 * Each array's value at index i only depends on candles[0..i] - i.e. no
 * look-ahead - so this same series can be safely walked day-by-day for a
 * backtest without leaking future information into past signals.
 */
function computeSeries(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const { histogram: macdHist } = macd(closes);
  const avgVol20 = sma(volumes, 20);
  const volSpike = volumes.map((v, i) => (avgVol20[i] ? v / avgVol20[i] : null));
  const atr14 = atr(candles, 14);

  const rangePct = candles.map((c, i) => {
    if (i < 13) return null;
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += (candles[j].high - candles[j].low) / candles[j].close;
    return (sum / 14) * 100;
  });

  return { closes, sma20, sma50, sma200, ema9, ema21, rsi14, macdHist, avgVol20, volSpike, atr14, rangePct };
}

function verdictFromScore(score) {
  if (score >= 2.5) return 'Bullish lean';
  if (score >= 1) return 'Mildly bullish';
  if (score <= -2.5) return 'Bearish lean';
  if (score <= -1) return 'Mildly bearish';
  return 'Neutral / Hold';
}

/**
 * The single source of truth for "what does the rule-based read say" at a
 * given index of a precomputed series. `priceOverride` lets live analysis
 * use the just-fetched live price instead of yesterday's close.
 */
function scoreAt(series, i, priceOverride = null) {
  const price = priceOverride ?? series.closes[i];
  const sma20 = series.sma20[i], sma50 = series.sma50[i], sma200 = series.sma200[i];
  const ema9 = series.ema9[i], ema21 = series.ema21[i];
  const rsi14 = series.rsi14[i];
  const macdHistVal = series.macdHist[i];
  const avgVol20 = series.avgVol20[i];
  const volSpike = series.volSpike[i];
  const atr14 = series.atr14[i];
  const avgRangePct = series.rangePct[i];

  const factors = [];
  let score = 0;

  if (sma50 && sma200) {
    if (sma50 > sma200) { factors.push({ factor: 'Golden trend (50-day SMA above 200-day SMA)', signal: 'bullish' }); score += 1; }
    else { factors.push({ factor: '50-day SMA below 200-day SMA (weak long-term trend)', signal: 'bearish' }); score -= 1; }
  }
  if (price && sma20) {
    if (price > sma20) { factors.push({ factor: 'Price trading above 20-day SMA', signal: 'bullish' }); score += 1; }
    else { factors.push({ factor: 'Price trading below 20-day SMA', signal: 'bearish' }); score -= 1; }
  }
  if (ema9 && ema21) {
    if (ema9 > ema21) { factors.push({ factor: '9-EMA above 21-EMA (short-term momentum up)', signal: 'bullish' }); score += 1; }
    else { factors.push({ factor: '9-EMA below 21-EMA (short-term momentum down)', signal: 'bearish' }); score -= 1; }
  }
  if (rsi14 !== null) {
    if (rsi14 > 70) { factors.push({ factor: `RSI(14) = ${rsi14.toFixed(1)} — overbought`, signal: 'caution' }); score -= 0.5; }
    else if (rsi14 < 30) { factors.push({ factor: `RSI(14) = ${rsi14.toFixed(1)} — oversold`, signal: 'caution' }); score += 0.5; }
    else if (rsi14 > 50) { factors.push({ factor: `RSI(14) = ${rsi14.toFixed(1)} — bullish momentum zone`, signal: 'bullish' }); score += 0.5; }
    else { factors.push({ factor: `RSI(14) = ${rsi14.toFixed(1)} — bearish momentum zone`, signal: 'bearish' }); score -= 0.5; }
  }
  if (macdHistVal !== null) {
    if (macdHistVal > 0) { factors.push({ factor: 'MACD histogram positive (bullish crossover)', signal: 'bullish' }); score += 1; }
    else { factors.push({ factor: 'MACD histogram negative (bearish crossover)', signal: 'bearish' }); score -= 1; }
  }
  if (volSpike !== null) {
    if (volSpike > 1.5) { factors.push({ factor: `Volume ${volSpike.toFixed(1)}x the 20-day average — strong interest`, signal: 'bullish' }); score += 0.5; }
    else if (volSpike < 0.5) { factors.push({ factor: `Volume only ${volSpike.toFixed(1)}x the 20-day average — weak participation`, signal: 'caution' }); }
  }

  let verdict = verdictFromScore(score);

  let suggestedHorizon = 'short_term';
  if (avgRangePct !== null && avgRangePct > 2.5) suggestedHorizon = 'intraday';
  else if (sma200 && price && Math.abs(score) < 1) suggestedHorizon = 'long_term';

  return {
    price,
    factors,
    score,
    verdict,
    suggestedHorizon,
    indicators: { sma20, sma50, sma200, ema9, ema21, rsi14, macdHistogram: macdHistVal, avgVol20, volSpike, atr14, avgRangePct },
  };
}

function analyze(candles, quote, marketContext = null) {
  const series = computeSeries(candles);
  const i = candles.length - 1;
  const result = scoreAt(series, i, quote?.lastPrice);

  let score = result.score;
  const factors = [...result.factors];

  // Multi-timeframe confirmation: check the weekly chart too. A daily
  // signal that agrees with the weekly trend is statistically more
  // reliable than one that fights it - this is derived from the SAME
  // candles (no extra API call), just grouped into weekly bars.
  let weeklyRead = null;
  const weeklyCandles = resampleWeekly(candles);
  if (weeklyCandles.length >= 25) {
    const weeklySeries = computeSeries(weeklyCandles);
    const weeklyResult = scoreAt(weeklySeries, weeklyCandles.length - 1);
    weeklyRead = { verdict: weeklyResult.verdict, score: weeklyResult.score };
    const dailyLeans = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
    const weeklyLeans = weeklyResult.score > 0 ? 'bullish' : weeklyResult.score < 0 ? 'bearish' : 'neutral';
    if (weeklyLeans !== 'neutral') {
      if (weeklyLeans === dailyLeans) {
        score += weeklyLeans === 'bullish' ? 0.5 : -0.5;
        factors.push({ factor: `Weekly chart also reads "${weeklyResult.verdict}" — daily and weekly agree`, signal: weeklyLeans });
      } else if (dailyLeans !== 'neutral') {
        factors.push({ factor: `Weekly chart reads "${weeklyResult.verdict}" — conflicts with the daily read, treat with extra caution`, signal: 'caution' });
      }
    }
  }

  // "Trade with the market, not against it" - stocks tend to do better
  // when the broader index is trending the same way. Evidence-backed
  // filter (not a magic bullet), added as one more transparent factor.
  if (marketContext && marketContext.trend !== 'neutral') {
    const bonus = marketContext.trend === 'bullish' ? 0.5 : -0.5;
    score += bonus;
    factors.push({
      factor: `Nifty 50 (broader market) is trending ${marketContext.trend} right now`,
      signal: marketContext.trend,
    });
  }

  const verdict = verdictFromScore(score);
  const periodReturns = computePeriodReturns(candles);
  const streak = computeStreak(candles);
  const recentStreaks = summarizeRecentStreaks(candles);
  const recentStreakPattern = describeRecentStreaks(recentStreaks);
  const recentDailyChanges = computeRecentDailyChanges(candles);
  const supportResistance = findSupportResistance(candles, 90, result.price);
  const setup = detectSetupType({ score, verdict, streak, periodReturns, indicators: result.indicators, supportResistance, price: result.price, volumeRatio: result.volumeRatio ?? result.indicators?.volSpike, candles });
  const tradePlan = generateTradePlan(result.price, result.indicators.atr14, supportResistance);

  return {
    symbol: quote?.symbol,
    price: result.price,
    indicators: result.indicators,
    periodReturns,
    streak,
    recentStreakPattern, // e.g. "fell 6d (-8.2%) -> rose 1d (+2.1%) -> fell 2d (-1.5%)", null if there's only one run to show
    recentDailyChanges, // [{date, changePct}, ...] last ~15 trading days, oldest first - the full day-by-day list
    weeklyRead,
    supportResistance,
    candlePatterns: detectCandlePatterns(candles),
    setup,
    tradePlan,
    factors,
    score,
    verdict,
    suggestedHorizon: result.suggestedHorizon,
    disclaimer:
      'Rule-based technical read only. Not financial advice — always do your own research and consider fundamentals, news, and risk management before trading.',
  };
}

module.exports = { sma, ema, rsi, macd, atr, computeSeries, scoreAt, verdictFromScore, computePeriodReturns, computeStreak, summarizeRecentStreaks, describeRecentStreaks, computeRecentDailyChanges, resampleWeekly, findSupportResistance, detectCandlePatterns, generateTradePlan, detectSetupType, analyze };
