// IPO Listing Day Entry Analysis — data-driven, capital-protection first.
// No guaranteed-profit claims. Order-book depth is not available on free feeds;
// buying/selling pressure is approximated from intraday candle volume + direction.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

function computeVwap(candles) {
  if (!candles?.length) return null;
  let pv = 0, vol = 0;
  for (const c of candles) {
    const typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const v = Number(c.volume) || 0;
    if (!Number.isFinite(typical) || v <= 0) continue;
    pv += typical * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

function dayStats(candles, quote) {
  const highs = candles.map((c) => Number(c.high)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low)).filter(Number.isFinite);
  const vols = candles.map((c) => Number(c.volume) || 0);
  const dayHigh = highs.length ? Math.max(...highs) : quote?.dayHigh ?? quote?.lastPrice;
  const dayLow = lows.length ? Math.min(...lows) : quote?.dayLow ?? quote?.lastPrice;
  const volume = vols.reduce((a, b) => a + b, 0) || quote?.volume || null;
  let upVol = 0, downVol = 0;
  for (let i = 1; i < candles.length; i++) {
    const v = Number(candles[i].volume) || 0;
    if (Number(candles[i].close) >= Number(candles[i - 1].close)) upVol += v;
    else downVol += v;
  }
  const pressure = upVol + downVol > 0 ? (upVol - downVol) / (upVol + downVol) : 0; // -1..+1
  return { dayHigh, dayLow, volume, upVol, downVol, pressure };
}

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {number} input.issuePrice - IPO issue / upper band price
 * @param {number} [input.listingOpen] - optional known listing open
 * @param {object} input.quote - from marketData.getQuote
 * @param {array}  input.intradayCandles - 1m/5m candles for listing day
 * @param {object} [input.marketContext] - from getMarketTrend
 * @param {object} [input.sectorContext] - optional { strength: -1..1 }
 */
function analyzeIpoListingDay(input) {
  const {
    symbol,
    issuePrice,
    listingOpen: listingOpenIn,
    quote,
    intradayCandles = [],
    dailyCandles = [],
    marketContext = null,
    sectorContext = null,
    listingDate = null,
  } = input;

  const price = quote?.lastPrice ?? null;
  if (price == null || !issuePrice || issuePrice <= 0) {
    return {
      signal: 'WAIT',
      confidence: 0,
      reasons: ['Need live price and a valid issue price to analyse listing-day entry.'],
      disclaimer: 'Not financial advice. No profit guarantee.',
    };
  }

  const listingOpen = listingOpenIn ?? quote?.open ?? price;
  const listingPremiumPct = pct(price, issuePrice);
  const openPremiumPct = pct(listingOpen, issuePrice);
  const vwap = computeVwap(intradayCandles);
  const stats = dayStats(intradayCandles, quote);
  const dayRangePct = stats.dayHigh && stats.dayLow && stats.dayLow > 0
    ? ((stats.dayHigh - stats.dayLow) / stats.dayLow) * 100
    : null;
  const distFromVwapPct = vwap ? pct(price, vwap) : null;
  const distFromHighPct = stats.dayHigh ? pct(price, stats.dayHigh) : null;
  const distFromLowPct = stats.dayLow ? pct(price, stats.dayLow) : null;

  // Approximate circuit proximity (NSE mainboard listing often ±20% first day bands vary by category)
  const mid = (stats.dayHigh + stats.dayLow) / 2 || price;
  const nearUpperCircuit = dayRangePct != null && dayRangePct >= 18 && distFromHighPct != null && distFromHighPct > -1.5;
  const nearLowerCircuit = dayRangePct != null && dayRangePct >= 18 && distFromLowPct != null && distFromLowPct < 1.5;

  const marketDir = marketContext?.todayDirection || marketContext?.direction || 'unknown';
  const marketScore = marketContext?.score ?? 0;
  const sectorStrength = sectorContext?.strength ?? 0;

  // --- Scoring: capital protection first ---
  let score = 50; // neutral
  const reasons = [];
  const risks = [];

  // Premium vs issue
  if (listingPremiumPct != null) {
    if (listingPremiumPct >= 40) {
      score -= 22;
      risks.push(`Very high listing premium (+${listingPremiumPct.toFixed(1)}% vs issue) — late entry risk.`);
    } else if (listingPremiumPct >= 25) {
      score -= 12;
      risks.push(`Elevated premium (+${listingPremiumPct.toFixed(1)}% vs issue).`);
    } else if (listingPremiumPct >= 8 && listingPremiumPct < 20) {
      score += 6;
      reasons.push(`Moderate premium (+${listingPremiumPct.toFixed(1)}%) — room without extreme froth.`);
    } else if (listingPremiumPct >= 0 && listingPremiumPct < 8) {
      score += 10;
      reasons.push(`Muted premium (+${listingPremiumPct.toFixed(1)}%) — less crowd chase.`);
    } else if (listingPremiumPct < -5) {
      score -= 8;
      risks.push(`Trading below issue (${listingPremiumPct.toFixed(1)}%) — weak listing demand.`);
    }
  }

  // VWAP structure
  if (vwap != null && distFromVwapPct != null) {
    if (distFromVwapPct <= -0.5 && distFromVwapPct >= -3) {
      score += 12;
      reasons.push(`Price near/below VWAP (${distFromVwapPct.toFixed(1)}%) — better entry zone.`);
    } else if (distFromVwapPct > 3) {
      score -= 10;
      risks.push(`Extended above VWAP (+${distFromVwapPct.toFixed(1)}%).`);
    } else if (distFromVwapPct >= -0.5 && distFromVwapPct <= 1.5) {
      score += 5;
      reasons.push('Price hugging VWAP — balanced.');
    }
  }

  // Pullback from day high
  if (distFromHighPct != null) {
    if (distFromHighPct <= -2 && distFromHighPct >= -8) {
      score += 10;
      reasons.push(`Pullback from day high (${distFromHighPct.toFixed(1)}%) — healthier than chasing top.`);
    } else if (distFromHighPct > -1) {
      score -= 8;
      risks.push('Near day high — chasing risk.');
    }
  }

  // Volume / pressure
  if (stats.pressure >= 0.15) {
    score += 8;
    reasons.push(`Buying pressure bias (proxy ${(stats.pressure * 100).toFixed(0)}%).`);
  } else if (stats.pressure <= -0.15) {
    score -= 10;
    risks.push(`Selling pressure bias (proxy ${(stats.pressure * 100).toFixed(0)}%).`);
  }

  if (stats.volume != null && stats.volume > 0) {
    reasons.push(`Session volume ~${formatVol(stats.volume)}.`);
  } else {
    score -= 5;
    risks.push('Volume data thin — lower confidence.');
  }


  // --- Post-listing reclaim setup (user observation) ---
  // Price listed near issue, fell, then reclaims the breakdown level / issue
  // with support + volume → consider entry (still not a guarantee).
  let reclaimSetup = null;
  let postListingPath = null;
  if (dailyCandles && dailyCandles.length >= 3 && issuePrice > 0) {
    const closes = dailyCandles.map((c) => Number(c.close)).filter(Number.isFinite);
    const highs = dailyCandles.map((c) => Number(c.high)).filter(Number.isFinite);
    const lows = dailyCandles.map((c) => Number(c.low)).filter(Number.isFinite);
    const vols = dailyCandles.map((c) => Number(c.volume) || 0);
    if (closes.length >= 3) {
      const postListHigh = Math.max(...highs);
      const postListLow = Math.min(...lows);
      let lowIdx = 0;
      for (let i = 0; i < lows.length; i++) if (lows[i] <= lows[lowIdx]) lowIdx = i;
      const bounceFrom = lows[lowIdx];
      const highPctFromIssue = issuePrice > 0 ? ((postListHigh - issuePrice) / issuePrice) * 100 : null;
      const lowPctFromIssue = issuePrice > 0 ? ((postListLow - issuePrice) / issuePrice) * 100 : null;
      postListingPath = {
        postListHigh: Number(postListHigh.toFixed(2)),
        postListLow: Number(postListLow.toFixed(2)),
        bounceFrom: Number(bounceFrom.toFixed(2)),
        highPctFromIssue: highPctFromIssue != null ? Number(highPctFromIssue.toFixed(2)) : null,
        lowPctFromIssue: lowPctFromIssue != null ? Number(lowPctFromIssue.toFixed(2)) : null,
        sessions: closes.length,
      };
      const fellFromHigh = postListHigh > issuePrice * 1.02 && price < postListHigh * 0.97;
      const belowIssueThen = closes.some((c) => c < issuePrice * 0.98);
      const nearReclaimLevel = Math.abs(price - issuePrice) / issuePrice <= 0.025
        || (postListHigh > issuePrice && price >= issuePrice * 0.99 && price <= postListHigh * 0.98);
      // Recent bounce off lows (last 2-3 sessions)
      const last3 = closes.slice(-3);
      const rising = last3.length >= 2 && last3[last3.length - 1] > last3[0];
      const avgVol = vols.reduce((a, b) => a + b, 0) / (vols.filter((v) => v > 0).length || 1);
      const lastVol = vols[vols.length - 1] || 0;
      const volOk = lastVol >= avgVol * 0.9;
      // Intraday: holding near VWAP/issue for "support"
      const holdingSupport = (vwap != null && price >= vwap * 0.995)
        || (price >= issuePrice * 0.995 && price <= issuePrice * 1.03);

      if ((belowIssueThen || fellFromHigh) && nearReclaimLevel && rising) {
        const quality = (volOk ? 1 : 0) + (holdingSupport ? 1 : 0) + (stats.pressure >= 0 ? 1 : 0);
        reclaimSetup = {
          active: quality >= 2,
          watch: quality === 1,
          level: Number(issuePrice.toFixed(2)),
          postListHigh: Number(postListHigh.toFixed(2)),
          postListLow: Number(postListLow.toFixed(2)),
          note: quality >= 2
            ? 'Reclaim setup: fell after listing, now back near issue/breakdown with volume/support bias — watch 5–10 min hold before entry.'
            : 'Possible reclaim near issue — wait for clear support + volume confirmation (5–10 min).',
        };
        if (reclaimSetup.active) {
          score += 14;
          reasons.push(reclaimSetup.note);
        } else if (reclaimSetup.watch) {
          score += 4;
          reasons.push(reclaimSetup.note);
        }
      }
    }
  }

  // Volatility
  if (dayRangePct != null) {
    if (dayRangePct > 25) {
      score -= 10;
      risks.push(`Very high volatility (day range ${dayRangePct.toFixed(1)}%).`);
    } else if (dayRangePct > 15) {
      score -= 4;
      risks.push(`Elevated volatility (${dayRangePct.toFixed(1)}% range).`);
    } else if (dayRangePct >= 4 && dayRangePct <= 12) {
      score += 4;
      reasons.push(`Manageable range (${dayRangePct.toFixed(1)}%).`);
    }
  }

  // Market / sector
  if (marketDir === 'bearish' || marketScore < -0.5) {
    score -= 12;
    risks.push('Broader market weak — IPO listings often struggle.');
  } else if (marketDir === 'bullish' || marketScore > 0.5) {
    score += 6;
    reasons.push('Market backdrop supportive.');
  }
  if (sectorStrength > 0.3) {
    score += 4;
    reasons.push('Sector relative strength positive.');
  } else if (sectorStrength < -0.3) {
    score -= 6;
    risks.push('Sector lagging.');
  }

  if (nearUpperCircuit) {
    score -= 15;
    risks.push('Near upper extreme / circuit zone — avoid chasing.');
  }
  if (nearLowerCircuit) {
    score -= 8;
    risks.push('Near lower extreme — high risk of further breakdown.');
  }

  score = clamp(score, 0, 100);

  // Signal thresholds — prefer WAIT/AVOID when uncertain
  let signal = 'WAIT';
  if (score >= 68 && !nearUpperCircuit && (listingPremiumPct == null || listingPremiumPct < 35)) {
    signal = 'BUY';
  } else if (score <= 38 || nearUpperCircuit || (listingPremiumPct != null && listingPremiumPct >= 45)) {
    signal = 'AVOID';
  }

  // Trade plan
  const entryLow = vwap != null ? Math.min(vwap, price) * 0.995 : price * 0.99;
  const entryHigh = vwap != null ? Math.max(vwap * 1.005, price * 1.005) : price * 1.01;
  const idealEntry = vwap != null ? (vwap + price) / 2 : price;

  // Stop: below day low or -3% from entry, whichever closer to capital protection
  const stopFromRange = stats.dayLow != null ? stats.dayLow * 0.992 : idealEntry * 0.97;
  const stopFromPct = idealEntry * 0.97;
  let stopLoss = Math.min(stopFromRange, stopFromPct);
  if (stopLoss >= idealEntry) stopLoss = idealEntry * 0.97;

  const risk = idealEntry - stopLoss;
  const t1 = idealEntry + risk * 1.2;
  const t2 = idealEntry + risk * 2.0;
  const t3 = idealEntry + risk * 3.0;
  const rr1 = risk > 0 ? (t1 - idealEntry) / risk : null;
  const trailing = {
    rule: 'After T1, trail stop to entry (breakeven). After T2, trail to T1.',
    afterT1: idealEntry,
    afterT2: t1,
  };

  const expectedUpsidePct = pct(t2, idealEntry);
  const expectedDownsidePct = pct(stopLoss, idealEntry);

  const confidence = Math.round(
    clamp(
      score * 0.7
        + (intradayCandles.length >= 10 ? 10 : 0)
        + (vwap != null ? 8 : 0)
        + (stats.volume ? 6 : 0)
        - (dayRangePct != null && dayRangePct > 20 ? 10 : 0),
      5,
      92
    )
  );

  const explanation = buildExplanation({ signal, score, listingPremiumPct, distFromVwapPct, marketDir, risks, reasons });

  return {
    symbol: String(symbol).toUpperCase(),
    signal, // BUY | WAIT | AVOID
    confidence,
    score: Number(score.toFixed(1)),
    metrics: {
      price,
      issuePrice,
      listingOpen,
      listingPremiumPct: listingPremiumPct != null ? Number(listingPremiumPct.toFixed(2)) : null,
      openPremiumPct: openPremiumPct != null ? Number(openPremiumPct.toFixed(2)) : null,
      vwap: vwap != null ? Number(vwap.toFixed(2)) : null,
      distFromVwapPct: distFromVwapPct != null ? Number(distFromVwapPct.toFixed(2)) : null,
      dayHigh: stats.dayHigh,
      dayLow: stats.dayLow,
      dayRangePct: dayRangePct != null ? Number(dayRangePct.toFixed(2)) : null,
      volume: stats.volume,
      buySellPressure: Number(stats.pressure.toFixed(3)), // -1..+1 proxy
      nearUpperCircuit: !!nearUpperCircuit,
      nearLowerCircuit: !!nearLowerCircuit,
      marketDirection: marketDir,
      marketScore,
      orderBookNote: 'Full order-book depth is not available on free market data. Pressure uses intraday volume direction as a proxy only.',
    },
    plan: {
      idealEntry: Number(idealEntry.toFixed(2)),
      entryRange: { low: Number(entryLow.toFixed(2)), high: Number(entryHigh.toFixed(2)) },
      stopLoss: Number(stopLoss.toFixed(2)),
      targets: {
        t1: Number(t1.toFixed(2)),
        t2: Number(t2.toFixed(2)),
        t3: Number(t3.toFixed(2)),
      },
      riskRewardToT1: rr1 != null ? Number(rr1.toFixed(2)) : null,
      riskRewardToT2: risk > 0 ? Number(((t2 - idealEntry) / risk).toFixed(2)) : null,
      trailingStop: trailing,
      expectedUpsidePct: expectedUpsidePct != null ? Number(expectedUpsidePct.toFixed(2)) : null,
      expectedDownsidePct: expectedDownsidePct != null ? Number(expectedDownsidePct.toFixed(2)) : null,
    },
    reasons,
    risks,
    reclaimSetup,
    postListingPath,
    explanation,
    disclaimer: 'Probability-based guidance only — not a profit guarantee. Listing-day trades are high risk. Size small; respect stop-loss.',
    analyzedAt: new Date().toISOString(),
  };
}

function formatVol(v) {
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return String(Math.round(v));
}

function buildExplanation({ signal, score, listingPremiumPct, distFromVwapPct, marketDir, risks, reasons }) {
  const parts = [];
  if (signal === 'BUY') {
    parts.push(`Setup scores ${score}/100 with a favourable entry structure.`);
  } else if (signal === 'AVOID') {
    parts.push(`Setup scores only ${score}/100 — capital protection says stay out or wait for a cleaner base.`);
  } else {
    parts.push(`Setup is mixed (score ${score}/100) — WAIT for clearer price/volume confirmation.`);
  }
  if (listingPremiumPct != null) parts.push(`Listing vs issue: ${listingPremiumPct >= 0 ? '+' : ''}${listingPremiumPct.toFixed(1)}%.`);
  if (distFromVwapPct != null) parts.push(`Vs VWAP: ${distFromVwapPct >= 0 ? '+' : ''}${distFromVwapPct.toFixed(1)}%.`);
  if (marketDir && marketDir !== 'unknown') parts.push(`Market: ${marketDir}.`);
  if (risks[0]) parts.push(`Main risk: ${risks[0]}`);
  else if (reasons[0]) parts.push(`Support: ${reasons[0]}`);
  return parts.join(' ');
}

module.exports = { analyzeIpoListingDay, computeVwap };
