// server/probabilityEstimator.js
// Answers "is stock ke saath aisa signal pehle kitni baar aaya, aur tab
// aage kya hua" using the stock's OWN real history - not a guess, not an
// ML model, just an honest frequency count of what actually happened the
// last N times a similar setup occurred on this exact stock.
//
// This is intentionally simple and transparent: find every past day where
// the score first crossed into "Bullish lean" (a fresh signal, same as
// what triggers a backtest entry), then check how far price actually
// moved over the following few days each time. Report what % of those
// past occurrences reached +1%, +5%, or dropped through a stop-loss-sized
// move - with the sample size always shown, since a probability from 4
// past occurrences means something very different from one built on 40.
const { computeSeries, scoreAt } = require('./indicators');

function round1(n) { return n === null || n === undefined ? null : Math.round(n * 10) / 10; }

function estimateMoveProbability(candles, opts = {}) {
  const { entryScore = 2.5, lookAheadDays = 3, downThresholdPct = -2 } = opts;
  if (candles.length < 220) return { status: 'insufficient_history', sampleSize: 0 };

  const series = computeSeries(candles);
  const occurrences = [];
  let wasSignal = false;

  for (let i = 200; i < candles.length - lookAheadDays; i++) {
    const { score } = scoreAt(series, i);
    const isSignal = score >= entryScore;
    if (isSignal && !wasSignal) {
      const entryPrice = candles[i].close;
      let maxUpPct = -Infinity, maxDownPct = Infinity;
      for (let j = i + 1; j <= i + lookAheadDays; j++) {
        maxUpPct = Math.max(maxUpPct, ((candles[j].high - entryPrice) / entryPrice) * 100);
        maxDownPct = Math.min(maxDownPct, ((candles[j].low - entryPrice) / entryPrice) * 100);
      }
      occurrences.push({ maxUpPct, maxDownPct });
    }
    wasSignal = isSignal;
  }

  const n = occurrences.length;
  if (n < 5) return { status: 'insufficient_history', sampleSize: n };

  const pctReachingUp = (threshold) => (occurrences.filter((o) => o.maxUpPct >= threshold).length / n) * 100;
  const pctReachingDown = (threshold) => (occurrences.filter((o) => o.maxDownPct <= threshold).length / n) * 100;

  return {
    status: 'ok',
    sampleSize: n,
    lookAheadDays,
    probabilityUp1PctPlus: round1(pctReachingUp(1)),
    probabilityUp5PctPlus: round1(pctReachingUp(5)),
    probabilityDown2PctPlus: round1(pctReachingDown(downThresholdPct)),
    note: n < 15
      ? `Only ${n} similar past signal(s) found on this stock - small sample, treat as a rough indication only.`
      : `Based on ${n} similar past signals on this specific stock over its available history.`,
  };
}

// Answers "agar main isse abhi le loon, kitne din mein result milne ki
// umeed rakhoon" - using this stock's OWN history again, not a guess. For
// every past occurrence of a similar signal, tracks whether price actually
// reached the CURRENT trade plan's target % gain by day 7, day 15, and day
// 30 - then reports which of those windows has historically had a decent
// (>=55%) hit-rate. A reversal/oversold-bounce setup often genuinely needs
// longer to play out than a momentum setup - this measures that directly
// from the stock's own past behavior instead of assuming.
function estimateTargetTimeline(candles, targetPct, opts = {}) {
  const { entryScore = 2.5 } = opts;
  const horizons = [7, 15, 30];
  const maxHorizon = Math.max(...horizons);
  if (!targetPct || targetPct <= 0 || candles.length < 220 + maxHorizon) {
    return { status: 'insufficient_history', sampleSize: 0 };
  }

  const series = computeSeries(candles);
  const occurrences = [];
  let wasSignal = false;

  for (let i = 200; i < candles.length - maxHorizon; i++) {
    const { score } = scoreAt(series, i);
    const isSignal = score >= entryScore;
    if (isSignal && !wasSignal) {
      const entryPrice = candles[i].close;
      const maxUpByDay = {};
      let runningMaxUp = -Infinity;
      for (let j = i + 1; j <= i + maxHorizon; j++) {
        runningMaxUp = Math.max(runningMaxUp, ((candles[j].high - entryPrice) / entryPrice) * 100);
        const dayOffset = j - i;
        if (horizons.includes(dayOffset)) maxUpByDay[dayOffset] = runningMaxUp;
      }
      occurrences.push(maxUpByDay);
    }
    wasSignal = isSignal;
  }

  const n = occurrences.length;
  if (n < 5) return { status: 'insufficient_history', sampleSize: n };

  const probAtHorizon = (days) => Math.round((occurrences.filter((o) => o[days] >= targetPct).length / n) * 1000) / 10;
  const horizonResults = {};
  horizons.forEach((d) => { horizonResults[`d${d}`] = probAtHorizon(d); });

  const HIT_RATE_THRESHOLD = 55; // historically reached the target this often or more, within this window
  let suggestedWindow = '30d_plus';
  if (horizonResults.d7 >= HIT_RATE_THRESHOLD) suggestedWindow = '7d';
  else if (horizonResults.d15 >= HIT_RATE_THRESHOLD) suggestedWindow = '15d';
  else if (horizonResults.d30 >= HIT_RATE_THRESHOLD) suggestedWindow = '30d';

  return {
    status: 'ok',
    sampleSize: n,
    targetPct: Number(targetPct.toFixed(2)),
    horizons: horizonResults, // e.g. { d7: 42.1, d15: 58.3, d30: 71.4 } = historical % of past signals that reached the target gain BY that many days
    suggestedWindow, // '7d' | '15d' | '30d' | '30d_plus'
    note: n < 15
      ? `Only ${n} similar past signal(s) on this stock - small sample, treat as a rough indication only.`
      : `Based on ${n} similar past signals on this specific stock reaching a ${targetPct.toFixed(1)}%+ move by each horizon.`,
  };
}


/**
 * Path-aware: for each historical signal, did price hit +up% BEFORE -down%?
 * Also avg MFE/MAE and median days to +5% when achieved.
 */
function estimatePathProbabilities(candles, opts = {}) {
  const entryScore = opts.entryScore ?? 2.5;
  const lookAheadDays = opts.lookAheadDays ?? 10;
  const upLevels = opts.upLevels || [1, 3, 5, 10];
  const downLevels = opts.downLevels || [1, 2, 3, 5];
  if (!candles || candles.length < 220) {
    return { status: 'insufficient_history', sampleSize: 0 };
  }
  const series = computeSeries(candles);
  const occurrences = [];
  let wasSignal = false;
  for (let i = 200; i < candles.length - lookAheadDays; i++) {
    const { score } = scoreAt(series, i);
    const isSignal = score >= entryScore;
    if (isSignal && !wasSignal) {
      const entry = candles[i].close;
      let mfe = 0, mae = 0;
      const firstHit = {}; // key like "up5" or "dn2" -> day offset
      for (let j = i + 1; j <= i + lookAheadDays; j++) {
        const hi = ((candles[j].high - entry) / entry) * 100;
        const lo = ((candles[j].low - entry) / entry) * 100;
        mfe = Math.max(mfe, hi);
        mae = Math.min(mae, lo);
        for (const u of upLevels) {
          const k = `up${u}`;
          if (firstHit[k] == null && hi >= u) firstHit[k] = j - i;
        }
        for (const d of downLevels) {
          const k = `dn${d}`;
          if (firstHit[k] == null && lo <= -d) firstHit[k] = j - i;
        }
      }
      occurrences.push({ mfe, mae, firstHit });
    }
    wasSignal = isSignal;
  }
  const n = occurrences.length;
  if (n < 8) {
    return { status: n < 5 ? 'insufficient_history' : 'low_sample', sampleSize: n, lookAheadDays };
  }

  function pathProb(up, down) {
    let hitUpFirst = 0, hitDownFirst = 0, neither = 0;
    for (const o of occurrences) {
      const u = o.firstHit[`up${up}`];
      const d = o.firstHit[`dn${down}`];
      if (u != null && (d == null || u <= d)) hitUpFirst += 1;
      else if (d != null && (u == null || d < u)) hitDownFirst += 1;
      else neither += 1;
    }
    return {
      upBeforeDownPct: round1((hitUpFirst / n) * 100),
      downBeforeUpPct: round1((hitDownFirst / n) * 100),
      neitherPct: round1((neither / n) * 100),
    };
  }

  const matrix = {};
  for (const u of upLevels) {
    for (const d of downLevels) {
      matrix[`p_${u}_before_${d}`] = pathProb(u, d);
    }
  }

  const daysTo5 = occurrences.map((o) => o.firstHit.up5).filter((x) => x != null);
  daysTo5.sort((a, b) => a - b);
  const medianDaysTo5 = daysTo5.length
    ? daysTo5[Math.floor(daysTo5.length / 2)]
    : null;

  const avgMfe = occurrences.reduce((s, o) => s + o.mfe, 0) / n;
  const avgMae = occurrences.reduce((s, o) => s + o.mae, 0) / n;

  return {
    status: n < 20 ? 'low_sample' : 'ok',
    sampleSize: n,
    lookAheadDays,
    matrix,
    probabilityUp1PctPlus: round1((occurrences.filter((o) => o.mfe >= 1).length / n) * 100),
    probabilityUp3PctPlus: round1((occurrences.filter((o) => o.mfe >= 3).length / n) * 100),
    probabilityUp5PctPlus: round1((occurrences.filter((o) => o.mfe >= 5).length / n) * 100),
    probabilityUp10PctPlus: round1((occurrences.filter((o) => o.mfe >= 10).length / n) * 100),
    probabilityDown1PctPlus: round1((occurrences.filter((o) => o.mae <= -1).length / n) * 100),
    probabilityDown2PctPlus: round1((occurrences.filter((o) => o.mae <= -2).length / n) * 100),
    probabilityDown3PctPlus: round1((occurrences.filter((o) => o.mae <= -3).length / n) * 100),
    probabilityDown5PctPlus: round1((occurrences.filter((o) => o.mae <= -5).length / n) * 100),
    avgMfePct: round1(avgMfe),
    avgMaePct: round1(avgMae),
    medianDaysToPlus5: medianDaysTo5,
    p5Before2: pathProb(5, 2),
    p5Before3: pathProb(5, 3),
    p5Before1: pathProb(5, 1),
    note: 'Frequencies from this stock\'s own past bullish-score signals. Not a guarantee. Low sample = soft confidence.',
  };
}

module.exports = { estimateMoveProbability, estimateTargetTimeline, estimatePathProbabilities };

