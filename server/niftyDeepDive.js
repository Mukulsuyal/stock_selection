// Nifty (and optional index) deep-dive: support/resistance map, today's
// drop classification, bounce vs continuation scenarios.
// Educational technical read — NOT financial advice / guaranteed path.
const marketData = require('./marketData');
const { analyze, findSupportResistance, sma, atr } = require('./indicators');
const { getMarketRegime } = require('./marketRegimeDetector');
const { computeTrackedUniverseBreadth } = require('./marketBreadth');
const { getCombinedUniverseScan } = require('./universeScan');
const { buildIndexHistoryPack } = require('./historicalAnalogs');

/** Yahoo symbols for multi-decade daily charts (as available on Yahoo). */
const INDEX_CHART_PRESETS = [
  { key: 'nifty50', label: 'Nifty 50', yahoo: '^NSEI' },
  { key: 'sensex', label: 'Sensex', yahoo: '^BSESN' },
  { key: 'midcap', label: 'Nifty Midcap 50', yahoo: '^NSEMDCP50' },
  { key: 'smallcap', label: 'Nifty Smallcap 250', yahoo: 'NIFTYSMLCAP250.NS' },
];

function resolveIndexInput(input) {
  if (!input) return INDEX_CHART_PRESETS[0];
  const s = String(input).trim();
  const byKey = INDEX_CHART_PRESETS.find((p) => p.key === s.toLowerCase() || p.label.toLowerCase() === s.toLowerCase());
  if (byKey) return byKey;
  if (s.startsWith('^') || s.includes('.NS') || s.includes('.BO')) {
    return { key: s, label: s, yahoo: s };
  }
  const map = {
    NIFTY: INDEX_CHART_PRESETS[0],
    '^NSEI': INDEX_CHART_PRESETS[0],
    SENSEX: INDEX_CHART_PRESETS[1],
    '^BSESN': INDEX_CHART_PRESETS[1],
  };
  return map[s.toUpperCase()] || { key: s, label: s, yahoo: s.startsWith('^') ? s : marketData.toYahooSymbol(s) };
}

/** Count consecutive weekly down closes (approx Fri-Fri via 5-session blocks). */
function weeklyRedStreak(candles) {
  if (!candles || candles.length < 30) return { weeks: 0, note: null };
  const weeks = [];
  for (let i = candles.length - 1; i >= 5; i -= 5) {
    const slice = candles.slice(Math.max(0, i - 4), i + 1);
    if (slice.length < 3) break;
    const open = slice[0].open ?? slice[0].close;
    const close = slice[slice.length - 1].close;
    weeks.push(close < open);
    if (weeks.length >= 16) break;
  }
  let streak = 0;
  for (const down of weeks) {
    if (down) streak++;
    else break;
  }
  return {
    weeks: streak,
    note: streak >= 2
      ? `Last ~${streak} week-blocks closed lower than they opened (soft sequential weekly pressure).`
      : 'No long stack of consecutive down week-blocks right now.',
  };
}


function pct(from, to) {
  if (from == null || to == null || from === 0) return null;
  return Number((((to - from) / from) * 100).toFixed(2));
}

function distPct(price, level) {
  if (price == null || level == null) return null;
  return Number((((level - price) / price) * 100).toFixed(2));
}

function fibLevels(high, low) {
  if (!high || !low || high <= low) return [];
  const range = high - low;
  const ratios = [
    { name: 'Fib 23.6%', r: 0.236 },
    { name: 'Fib 38.2%', r: 0.382 },
    { name: 'Fib 50%', r: 0.5 },
    { name: 'Fib 61.8%', r: 0.618 },
    { name: 'Fib 78.6%', r: 0.786 },
  ];
  return ratios.map(({ name, r }) => ({
    name,
    level: Number((high - range * r).toFixed(2)),
    kind: 'fib',
  }));
}

function classifyTodayMove({ dayPct, atr14, dayRange, avgVol, vol, vixLevel, vixChange, breadthRead, globalSelloff }) {
  const reasons = [];
  let severity = 'mild'; // mild | moderate | sharp | disorderly
  if (dayPct == null) {
    return {
      label: 'Unknown',
      severity: 'unknown',
      healthyPullback: null,
      reasons: ['Today change not available yet.'],
    };
  }

  const absDay = Math.abs(dayPct);
  if (absDay < 0.35) severity = 'mild';
  else if (absDay < 0.9) severity = 'moderate';
  else if (absDay < 1.8) severity = 'sharp';
  else severity = 'disorderly';

  if (atr14 && dayRange) {
    const atrRatio = dayRange / atr14;
    if (atrRatio > 1.5) {
      severity = absDay >= 1.2 ? 'disorderly' : 'sharp';
      reasons.push(`Day range ${((atrRatio) * 100).toFixed(0)}% of ATR — wider than usual.`);
    } else if (atrRatio < 0.7 && absDay < 0.8) {
      reasons.push('Range is contained vs ATR — more like digestion than panic.');
    }
  }

  if (vol && avgVol) {
    const vr = vol / avgVol;
    if (vr >= 1.4 && dayPct < 0) reasons.push(`Volume elevated (~${vr.toFixed(1)}x avg) on down day — selling pressure real.`);
    else if (vr < 0.85 && dayPct < 0) reasons.push(`Volume lighter (~${vr.toFixed(1)}x) — drop may be quieter / low participation.`);
  }

  if (vixLevel != null) {
    if (vixLevel >= 20) reasons.push(`India VIX elevated (~${vixLevel.toFixed(1)}) — fear premium high.`);
    else if (vixLevel <= 13) reasons.push(`India VIX low (~${vixLevel.toFixed(1)}) — not a full panic regime.`);
  }
  if (vixChange != null && vixChange >= 8) reasons.push(`VIX jumped ~${vixChange.toFixed(1)}% today — risk-off spike.`);

  if (breadthRead === 'broadly bearish') reasons.push('Tracked universe breadth weak (more decliners) — broad pressure.');
  else if (breadthRead === 'broadly bullish' && dayPct < 0) reasons.push('Breadth still mixed/better than index — index-heavy drag possible.');

  if (globalSelloff) reasons.push('Global cues weak (US indices soft) — external risk-off can extend local selling.');

  // Healthy pullback heuristic: modest drop, VIX not exploding, volume not extreme, above key SMA or near support
  let healthyPullback = null;
  if (dayPct >= 0) {
    healthyPullback = null;
  } else if (
    absDay <= 1.0
    && (vixLevel == null || vixLevel < 22)
    && (vixChange == null || vixChange < 12)
    && severity !== 'disorderly'
  ) {
    healthyPullback = true;
    reasons.push('Pattern fits a possible healthy pullback more than a crash day (size + VIX not extreme).');
  } else if (severity === 'disorderly' || (vixLevel != null && vixLevel >= 25) || absDay >= 2) {
    healthyPullback = false;
    reasons.push('Move looks heavy / stress-like — treat as risk event until stabilizes near support.');
  } else {
    healthyPullback = null;
    reasons.push('In between: not a full crash label, not a quiet healthy dip either — watch next supports.');
  }

  const label = dayPct >= 0
    ? (absDay < 0.3 ? 'Flat / mild up' : 'Up day')
    : healthyPullback === true
      ? 'Likely healthy pullback (technical)'
      : healthyPullback === false
        ? 'Heavy / stress-type down day'
        : 'Down day — mixed character';

  return { label, severity, healthyPullback, dayPct, reasons };
}

function buildScenarios({ price, supports, resistances, dayPct, sma200, sma50, healthyPullback, atr14 }) {
  const nearSupport = supports[0] || null;
  const nextSupport = supports[1] || null;
  const nearRes = resistances[0] || null;

  const bounceZone = nearSupport
    ? {
        from: Number((nearSupport.level * 0.997).toFixed(2)),
        to: Number((nearSupport.level * 1.004).toFixed(2)),
        level: nearSupport.level,
        label: nearSupport.name || 'Nearest support',
        distancePct: distPct(price, nearSupport.level),
      }
    : null;

  // Breakdown = lose nearest support under price (never a level already above)
  const breakdownBelow = nearSupport
    ? Number((nearSupport.level * 0.995).toFixed(2))
    : null;

  // Soft scenario weights (NOT probabilities of profit)
  let bounceBias = 40;
  let continueBias = 40;
  let sidewaysBias = 20;
  if (healthyPullback === true) {
    bounceBias += 15;
    continueBias -= 10;
  }
  if (healthyPullback === false) {
    continueBias += 15;
    bounceBias -= 10;
  }
  if (nearSupport && Math.abs(distPct(price, nearSupport.level)) <= 1.2) bounceBias += 8;
  if (sma50 && price < sma50) continueBias += 5;
  if (sma200 && price < sma200) continueBias += 8;
  if (sma200 && price > sma200 && dayPct < 0) bounceBias += 5;
  if (dayPct != null && dayPct <= -1.5) continueBias += 8;

  const sum = bounceBias + continueBias + sidewaysBias;
  bounceBias = Math.round((bounceBias / sum) * 100);
  continueBias = Math.round((continueBias / sum) * 100);
  sidewaysBias = Math.max(0, 100 - bounceBias - continueBias);

  const atrCushion = atr14 ? Number((atr14 * 1.5).toFixed(2)) : null;

  return {
    bounceZone,
    breakdownLevel: breakdownBelow,
    nextSupportBelow: nextSupport
      ? { level: nextSupport.level, distancePct: distPct(price, nextSupport.level), name: nextSupport.name }
      : null,
    upsideResistance: nearRes
      ? { level: nearRes.level, distancePct: distPct(price, nearRes.level), name: nearRes.name }
      : null,
    biasWeights: {
      bounce: bounceBias,
      continuation_down: continueBias,
      sideways_digest: sidewaysBias,
      note: 'Soft scenario weights from technical context only — NOT win probabilities or guarantees.',
    },
    horizonNote: atrCushion
      ? `Near-term noise band ~±1.5 ATR (~${atrCushion} pts). Path can take several sessions; not a 1-day call.`
      : 'Horizon is multi-session; single-day path is noise-heavy.',
  };
}

function narrative(ctx) {
  const lines = [];
  const {
    symbol, price, dayPct, fromRecentHighPct, weeksDown, todayClass, scenarios, regime, levels,
  } = ctx;

  lines.push(`${symbol} around ${price != null ? price.toFixed(2) : '—'}${dayPct != null ? ` (${dayPct >= 0 ? '+' : ''}${dayPct}% today)` : ''}.`);
  if (fromRecentHighPct != null && fromRecentHighPct < 0) {
    lines.push(`About ${Math.abs(fromRecentHighPct).toFixed(1)}% below the recent ~8-week high — multi-week pressure is real, not only today's candle.`);
  }
  if (weeksDown) lines.push(weeksDown);

  lines.push(`Today's read: ${todayClass.label}.`);
  if (todayClass.healthyPullback === true) {
    lines.push('This still looks closer to a healthy pullback / digestion than a panic crash — but supports must hold.');
  } else if (todayClass.healthyPullback === false) {
    lines.push('Selling looks heavy. Prefer waiting for stabilisation near a marked support rather than catching a falling knife.');
  }

  if (scenarios.bounceZone) {
    lines.push(
      `Nearest bounce watch zone ~${scenarios.bounceZone.from}–${scenarios.bounceZone.to} (${scenarios.bounceZone.label}, ~${scenarios.bounceZone.distancePct}% away).`
    );
  }
  if (scenarios.nextSupportBelow) {
    lines.push(`If that breaks, next support area ~${scenarios.nextSupportBelow.level} (${scenarios.nextSupportBelow.distancePct}%).`);
  }
  if (scenarios.breakdownLevel) {
    lines.push(`Sustained trade below ~${scenarios.breakdownLevel} would weaken the bounce case and open more downside.`);
  }
  if (scenarios.upsideResistance) {
    lines.push(`On any bounce, first resistance ~${scenarios.upsideResistance.level} (${scenarios.upsideResistance.distancePct}%).`);
  }

  const w = scenarios.biasWeights;
  lines.push(
    `Scenario lean (technical only): bounce ~${w.bounce}% · further down ~${w.continuation_down}% · sideways ~${w.sideways_digest}%. ${w.note}`
  );
  if (regime?.learningRegime) {
    lines.push(`Learning/market regime tag: ${regime.learningRegime}${regime.crisisTags?.length ? ` (${regime.crisisTags.join(', ')})` : ''}.`);
  }
  lines.push('Not financial advice. Levels are approximate zones from pivots, MAs and Fibs.');

  return lines;
}


/**
 * Plain-language path of the last ~200 sessions + calendar year (e.g. 2026).
 * Helps users see "how we got here" without reading raw OHLC.
 */
function buildCurrentPathStory(candles, price) {
  if (!candles?.length || price == null) return null;
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const last = n - 1;
  const ret = (days) => {
    if (last < days) return null;
    return pct(closes[last - days], price);
  };
  const windowHighLow = (days) => {
    const start = Math.max(0, last - days);
    let hi = -Infinity, lo = Infinity, hiDate = null, loDate = null;
    for (let i = start; i <= last; i++) {
      if (candles[i].high > hi) { hi = candles[i].high; hiDate = candles[i].date; }
      if (candles[i].low < lo) { lo = candles[i].low; loDate = candles[i].date; }
    }
    return {
      high: hi, low: lo, highDate: hiDate, lowDate: loDate,
      fromHighPct: pct(hi, price), fromLowPct: pct(lo, price),
    };
  };

  // Calendar year path (e.g. 2026)
  const year = (candles[last].date || '').slice(0, 4);
  let yOpen = null, yOpenDate = null, yHigh = -Infinity, yLow = Infinity, yHighDate = null, yLowDate = null;
  for (const c of candles) {
    if (!c.date || !c.date.startsWith(year)) continue;
    if (yOpen == null) { yOpen = c.open ?? c.close; yOpenDate = c.date; }
    if (c.high > yHigh) { yHigh = c.high; yHighDate = c.date; }
    if (c.low < yLow) { yLow = c.low; yLowDate = c.date; }
  }
  const ytdPct = yOpen != null ? pct(yOpen, price) : null;
  const yFromHigh = yHigh > 0 && yHigh < Infinity ? pct(yHigh, price) : null;

  // Last significant peak (60d high touch) then path to now
  let peakIdx = last;
  const high60 = (() => {
    let m = -Infinity, mi = last;
    for (let i = Math.max(0, last - 120); i <= last; i++) {
      if (closes[i] >= m) { m = closes[i]; mi = i; }
    }
    return mi;
  })();
  peakIdx = high60;
  const peakPrice = closes[peakIdx];
  const peakDate = candles[peakIdx].date;
  const fromPeakPct = pct(peakPrice, price);
  let troughIdx = peakIdx;
  let troughP = peakPrice;
  for (let i = peakIdx; i <= last; i++) {
    if (closes[i] < troughP) { troughP = closes[i]; troughIdx = i; }
  }
  const peakToTroughPct = pct(peakPrice, troughP);
  const troughToNowPct = pct(troughP, price);
  const daysPeakToTrough = troughIdx - peakIdx;
  const daysTroughToNow = last - troughIdx;

  // After prior big drawdowns (>10%), days until NEW high above prior peak
  const recoveries = [];
  let i = 80;
  while (i < last - 30 && recoveries.length < 8) {
    let localHigh = closes[i];
    let localHighIdx = i;
    for (let k = i - 40; k <= i; k++) {
      if (k >= 0 && closes[k] >= localHigh) { localHigh = closes[k]; localHighIdx = k; }
    }
    if (localHighIdx !== i) { i += 5; continue; }
    let trough = localHigh, troughI = i;
    const end = Math.min(last, i + 150);
    for (let j = i + 1; j <= end; j++) {
      if (closes[j] < trough) { trough = closes[j]; troughI = j; }
      const drop = pct(localHigh, trough);
      if (drop <= -10) {
        // search recovery to new high
        let daysToNewHigh = null;
        for (let j = troughI + 1; j <= Math.min(last, troughI + 400); j++) {
          if (closes[j] >= localHigh) { daysToNewHigh = j - troughI; break; }
        }
        recoveries.push({
          peakDate: candles[localHighIdx].date,
          troughDate: candles[troughI].date,
          drawdownPct: Number(drop.toFixed(2)),
          daysPeakToTrough: troughI - localHighIdx,
          daysTroughToNewHigh: daysToNewHigh,
          recovered: daysToNewHigh != null,
        });
        i = troughI + 20;
        break;
      }
      if (j === end) i += 10;
    }
    i += 5;
  }

  const w20 = windowHighLow(20);
  const w40 = windowHighLow(40);
  const w100 = windowHighLow(100);
  const w200 = windowHighLow(200);

  const plain = [];
  plain.push(`${year} year so far: ${ytdPct != null ? (ytdPct >= 0 ? '+' : '') + ytdPct + '% year-open se' : '—'} · year high se ab ${yFromHigh != null ? yFromHigh + '%' : '—'}.`);
  if (yHighDate && yLowDate) {
    plain.push(`Is saal ka high ~${yHighDate} pe, low ~${yLowDate} pe.`);
  }
  plain.push(`Last 20 sessions: net ${ret(20) != null ? ret(20) + '%' : '—'} · is window ke high se ${w20.fromHighPct != null ? w20.fromHighPct + '%' : '—'}.`);
  plain.push(`Last 40 sessions: net ${ret(40) != null ? ret(40) + '%' : '—'} · high se ${w40.fromHighPct != null ? w40.fromHighPct + '%' : '—'}.`);
  plain.push(`Last 100 sessions: net ${ret(100) != null ? ret(100) + '%' : '—'} · high se ${w100.fromHighPct != null ? w100.fromHighPct + '%' : '—'}.`);
  plain.push(`Last 200 sessions: net ${ret(200) != null ? ret(200) + '%' : '—'} · high se ${w200.fromHighPct != null ? w200.fromHighPct + '%' : '—'}.`);
  plain.push(`Recent peak ${peakDate} (~${Number(peakPrice).toFixed(0)}) se ab ${fromPeakPct}%. Beech ka low ${candles[troughIdx].date} pe ${peakToTroughPct}%; us low se recovery ${troughToNowPct}% (${daysTroughToNow} sessions).`);

  return {
    year,
    ytdPct,
    yearOpen: yOpen,
    yearOpenDate: yOpenDate,
    yearHigh: yHigh < Infinity ? yHigh : null,
    yearHighDate: yHighDate,
    yearLow: yLow > 0 ? yLow : null,
    yearLowDate: yLowDate,
    yearFromHighPct: yFromHigh,
    returns: {
      d20: ret(20),
      d40: ret(40),
      d100: ret(100),
      d200: ret(200),
    },
    windows: { d20: w20, d40: w40, d100: w100, d200: w200 },
    recentPeak: {
      date: peakDate,
      price: Number(peakPrice.toFixed(2)),
      fromPeakPct,
      troughDate: candles[troughIdx].date,
      troughPrice: Number(troughP.toFixed(2)),
      peakToTroughPct,
      troughToNowPct,
      daysPeakToTrough,
      daysTroughToNow,
    },
    pastRecoveries: recoveries.slice(-6),
    plainLines: plain,
  };
}


async function buildNiftyDeepDive(symbolOrKey = 'nifty50') {
  const preset = resolveIndexInput(symbolOrKey);
  let yahooSymbol = preset.yahoo;
  const display = preset.label;

  // Structure + live pulse on ~2y; analogs on up to 25y long history
  const [histShort, histLong, regime] = await Promise.all([
    marketData.getHistorical(yahooSymbol, 500).catch(() => null),
    marketData.getLongHistory(yahooSymbol, 25).catch(() => null),
    getMarketRegime().catch(() => null),
  ]);
  let hist = (histLong && histLong.length > 200) ? histLong : histShort;
  if (!hist?.length) {
    // Alternate Yahoo tickers for mid/small when primary fails
    const alts = {
      midcap: ['^NSEMDCP50', 'NIFTY_MIDCAP_100.NS', 'NIFTYMIDCAP100.NS'],
      smallcap: ['NIFTYSMLCAP250.NS', '^CNXSC', 'NIFTY_SMLCAP_100.NS'],
    };
    const tryList = alts[preset.key] || [];
    for (const alt of tryList) {
      if (alt === yahooSymbol) continue;
      try {
        const longAlt = await marketData.getLongHistory(alt, 25).catch(() => null);
        const shortAlt = await marketData.getHistorical(alt, 500).catch(() => null);
        hist = (longAlt && longAlt.length > 200) ? longAlt : shortAlt;
        if (hist?.length) {
          yahooSymbol = alt; preset.yahoo = alt;
          break;
        }
      } catch (_) {}
    }
  }
  if (!hist?.length) throw new Error(`No history available for ${display} (${yahooSymbol})`);
  const recentHist = hist.length > 400 ? hist.slice(-400) : hist;

  const quote = {
    lastPrice: hist[hist.length - 1].close,
    pChange: hist.length >= 2
      ? pct(hist[hist.length - 2].close, hist[hist.length - 1].close)
      : null,
  };
  // Prefer live quote if available
  try {
    const live = await marketData.getQuote(yahooSymbol);
    if (live?.lastPrice != null) {
      quote.lastPrice = live.lastPrice;
      if (live.pChange != null) quote.pChange = live.pChange;
      quote.volume = live.volume;
    }
  } catch (_) {}

  const analysis = analyze(hist, quote, null);
  const price = analysis.price;
  const dayPct = analysis.periodReturns?.oneDay ?? quote.pChange;
  const atr14 = analysis.indicators?.atr14 ?? null;

  const closes = hist.map((c) => c.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma100 = sma(closes, 100);
  const sma200 = sma(closes, 200);
  const lastSma = (arr) => (arr?.length ? arr[arr.length - 1] : null);

  const s20 = lastSma(sma20);
  const s50 = lastSma(sma50);
  const s100 = lastSma(sma100);
  const s200 = lastSma(sma200);

  // Swing high/low ~8 weeks (~40 sessions)
  const window = hist.slice(-40);
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const c of window) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  const fromRecentHighPct = pct(swingHigh, price);

  // Count rough down weeks (Friday-to-Friday proxy: last 8 weeks of weekly resample if available)
  let weeksDownNote = null;
  try {
    const wr = weeklyRedStreak(hist);
    weeksDownNote = wr.note;
  } catch (_) {}
  if (fromRecentHighPct != null && fromRecentHighPct <= -5) {
    weeksDownNote = `Multi-week drawdown from recent high (~${Math.abs(fromRecentHighPct).toFixed(1)}%). Aligns with a soft/pressure phase lasting several weeks — not only one bad day.`;
  }

  // Longer pivot windows so we still find supports when price is near local lows
  const sr120 = findSupportResistance(hist, 120, price);
  const sr250 = findSupportResistance(hist, 250, price);
  const fibs = fibLevels(swingHigh, swingLow);

  // Structural lows: recent swing low, 6m low, 1y low
  function rangeLow(bars, n) {
    const slice = bars.slice(-n);
    let lo = Infinity;
    for (const c of slice) if (c.low != null && c.low < lo) lo = c.low;
    return lo < Infinity ? lo : null;
  }
  const low20 = rangeLow(hist, 20);
  const low60 = rangeLow(hist, 60);
  const low120 = rangeLow(hist, 120);
  const low252 = rangeLow(hist, 252);

  const maLevels = [
    { name: 'SMA 20 (short trend)', level: s20, kind: 'ma', strength: 1 },
    { name: 'SMA 50 (swing trend)', level: s50, kind: 'ma', strength: 2 },
    { name: 'SMA 100', level: s100, kind: 'ma', strength: 2 },
    { name: 'SMA 200 (long trend)', level: s200, kind: 'ma', strength: 3 },
  ].filter((x) => x.level != null);

  const supports = [];
  const resistances = [];

  function pushLevel(list, row) {
    if (row.level == null || !Number.isFinite(row.level)) return;
    list.push({
      ...row,
      level: Number(row.level.toFixed(2)),
      distancePct: distPct(price, row.level),
    });
  }

  for (const s of [...(sr120.support || []), ...(sr250.support || [])]) {
    pushLevel(supports, {
      name: `Purana swing support (strength ${s.strength})`,
      level: s.level,
      strength: s.strength,
      kind: 'pivot',
      plain: 'Pehle yahan se price ne neeche jaane se rokne ki koshish ki thi.',
    });
  }
  for (const r of [...(sr120.resistance || []), ...(sr250.resistance || [])]) {
    pushLevel(resistances, {
      name: `Purana swing resistance (strength ${r.strength})`,
      level: r.level,
      strength: r.strength,
      kind: 'pivot',
      plain: 'Pehle yahan upar rukawat mili thi — bounce pe pehli diwal ho sakti hai.',
    });
  }
  for (const m of maLevels) {
    const row = {
      name: m.name,
      level: m.level,
      kind: 'ma',
      strength: m.strength,
      plain: m.level < price
        ? 'Average line abhi neeche hai — support zone ki tarah dekhte hain.'
        : 'Average line upar hai — ab resistance / recovery target jaisi.',
    };
    if (m.level < price) pushLevel(supports, row);
    else if (m.level > price) pushLevel(resistances, row);
  }
  for (const f of fibs) {
    const row = {
      ...f,
      strength: 2,
      plain: 'Fibonacci zone — pure mathematical retracement, exact magic number nahi.',
    };
    if (f.level < price) pushLevel(supports, row);
    else if (f.level > price) pushLevel(resistances, row);
  }

  // Always add structural lows BELOW price (or slightly under if touching)
  const structural = [
    { name: '20-session low', level: low20, strength: 2, plain: 'Pichhle ~1 mahine ka lowest point.' },
    { name: '60-session low (~3m)', level: low60, strength: 3, plain: 'Pichhle ~3 mahine ka low — strong demand zone ho sakta hai.' },
    { name: '120-session low (~6m)', level: low120, strength: 3, plain: '~6 mahine ka low.' },
    { name: '52-week area low', level: low252, strength: 4, plain: 'Lagbhag 1 saal ka low region.' },
    { name: 'Recent 8-week swing low', level: swingLow, strength: 3, plain: 'Is recent giraawat ka local bottom area.' },
  ];
  for (const s of structural) {
    if (s.level == null) continue;
    // Include if below price OR within 0.35% (touching support)
    if (s.level < price * 1.0035) {
      pushLevel(supports, { ...s, kind: 'swing_low' });
    }
  }

  supports.sort((a, b) => b.level - a.level);
  resistances.sort((a, b) => a.level - b.level);

  function dedupe(list) {
    const out = [];
    for (const item of list) {
      const last = out[out.length - 1];
      if (last && Math.abs(item.level - last.level) / last.level < 0.004) {
        if ((item.strength || 0) > (last.strength || 0)) out[out.length - 1] = item;
        continue;
      }
      out.push(item);
    }
    return out.slice(0, 8);
  }

  const supportLevels = dedupe(supports).filter((s) => s.level < price * 1.002);
  const resistanceLevels = dedupe(resistances).filter((r) => r.level > price * 0.998);

  // Volume / range
  const last = hist[hist.length - 1];
  const dayRange = last.high != null && last.low != null ? last.high - last.low : null;
  const vols = hist.slice(-21, -1).map((c) => c.volume).filter((v) => v != null);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const vol = quote.volume ?? last.volume;

  let breadthRead = null;
  try {
    const scan = await getCombinedUniverseScan();
    if (scan?.results?.length) {
      breadthRead = computeTrackedUniverseBreadth(scan.results).breadthRead;
    }
  } catch (_) {}

  const vixLevel = regime?.indiaVix?.level ?? null;
  const vixChange = regime?.indiaVix?.changePct ?? null;
  const globalSelloff = regime?.macro?.globalSelloff ?? false;

  const todayClass = classifyTodayMove({
    dayPct,
    atr14,
    dayRange,
    avgVol,
    vol,
    vixLevel,
    vixChange,
    breadthRead,
    globalSelloff,
  });

  const scenarios = buildScenarios({
    price,
    supports: supportLevels,
    resistances: resistanceLevels,
    dayPct,
    sma200: s200,
    sma50: s50,
    healthyPullback: todayClass.healthyPullback,
    atr14,
  });

  const periodReturns = analysis.periodReturns || {};
  const ctx = {
    symbol: display,
    price,
    dayPct,
    fromRecentHighPct,
    weeksDown: weeksDownNote,
    todayClass,
    scenarios,
    regime,
    levels: { supportLevels, resistanceLevels },
  };

  // Sparkline-ish last 60 closes for simple UI chart
  const chart = hist.slice(-120).map((c) => ({
    date: c.date,
    close: c.close,
    high: c.high,
    low: c.low,
  }));

  // Multi-year analogs (Nifty + Midcap when available)
  let historyStudy = null;
  let midcapHistory = null;
  try {
    historyStudy = await buildIndexHistoryPack(yahooSymbol, display);
  } catch (err) {
    console.warn('[niftyDeepDive] history study failed:', err.message);
    historyStudy = { error: err.message };
  }
  if (preset.key === 'nifty50' || yahooSymbol === '^NSEI') {
    try {
      midcapHistory = await buildIndexHistoryPack('^NSEMDCP50', 'Nifty Midcap 50');
    } catch (err) {
      midcapHistory = { error: err.message };
    }
  }

  const historyLines = [];
  if (historyStudy?.summary) {
    const s = historyStudy.summary;
    historyLines.push(
      `History window: ${historyStudy.historyFrom || '?'} → ${historyStudy.historyTo || '?'} (${historyStudy.historyBars || 0} sessions).`
    );
    historyLines.push(
      `Among ${s.sample} similar past days: next-20d avg max further drop ${s.avgMaxDrawdownNext20d ?? '—'}%, avg max bounce ${s.avgMaxBounceNext20d ?? '—'}%.`
    );
    if (s.shareFurtherDrop3pctIn20d != null) {
      historyLines.push(
        `In ~${s.shareFurtherDrop3pctIn20d}% of those analogs, price fell at least 3% more within 20 sessions; ~${s.shareBounce3pctIn20d}% saw a ≥3% bounce within 20 sessions.`
      );
    }
    if (s.medianDaysToPlus5 != null) {
      historyLines.push(`Median sessions to a +5% recovery from the analog day: ~${s.medianDaysToPlus5}.`);
    }
    if (s.medianDaysToMinus5 != null) {
      historyLines.push(`Median sessions to an extra −5% from the analog day: ~${s.medianDaysToMinus5}.`);
    }
    historyLines.push(s.note);
  }

  return {
    indexKey: preset.key,
    symbol: display,
    yahooSymbol,
    historyYearsRequested: 25,
    historyBars: hist.length,
    historyFrom: hist[0]?.date || null,
    historyTo: hist[hist.length - 1]?.date || null,
    price: Number(Number(price).toFixed(2)),
    dayPct: dayPct != null ? Number(Number(dayPct).toFixed(2)) : null,
    periodReturns: {
      oneDay: periodReturns.oneDay ?? dayPct,
      oneWeek: periodReturns.oneWeek ?? null,
      oneMonth: periodReturns.oneMonth ?? null,
      threeMonth: periodReturns.threeMonth ?? null,
    },
    swingHigh: Number(swingHigh.toFixed(2)),
    swingLow: Number(swingLow.toFixed(2)),
    fromRecentHighPct: fromRecentHighPct != null ? Number(Number(fromRecentHighPct).toFixed(2)) : null,
    movingAverages: {
      sma20: s20 != null ? Number(s20.toFixed(2)) : null,
      sma50: s50 != null ? Number(s50.toFixed(2)) : null,
      sma100: s100 != null ? Number(s100.toFixed(2)) : null,
      sma200: s200 != null ? Number(s200.toFixed(2)) : null,
    },
    supportLevels,
    resistanceLevels,
    todayMove: todayClass,
    scenarios,
    context: {
      learningRegime: regime?.learningRegime || null,
      trendRegime: regime?.trendRegime || null,
      volatilityRegime: regime?.volatilityRegime || null,
      vix: vixLevel,
      vixChangePct: vixChange,
      globalSelloff,
      breadthRead,
      crisisTags: regime?.crisisTags || [],
      nifty: regime?.nifty || null,
      bankNifty: regime?.bankNifty || null,
    },
    narrative: narrative(ctx),
    historyNarrative: historyLines,
    pathStory: buildCurrentPathStory(hist, price),
    historyStudy,
    midcapHistory,
    chart,
    disclaimer: 'Educational technical map only. Levels are zones, not exact ticks. Not investment advice. Markets can gap through supports.',
    asOf: new Date().toISOString(),
  };
}

module.exports = { buildNiftyDeepDive, INDEX_CHART_PRESETS, resolveIndexInput };
