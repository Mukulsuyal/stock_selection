/**
 * Early Opportunity Engine — four scanners on existing universe scan + OHLCV.
 * Setup Score ≠ Historical Probability ≠ Confidence ≠ Entry Readiness.
 * Oversold alone never qualifies as a confirmed reversal.
 * Never invents probabilities; never forces trades.
 */
const { getCombinedUniverseScan } = require('./universeScan');
const marketData = require('./marketData');

const MIN_RR = Number(process.env.EO_MIN_RR || 2);
const MAX_PER_SCANNER = Number(process.env.EO_MAX_PER || 12);
const PRICE_CAP = Number(process.env.EO_MAX_PRICE || 6000);
const MIN_SAMPLE = 20; // for any non-LOW confidence claim
const MIN_SAMPLE_HIGH = 40; // for HIGH confidence

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function rrOf(plan) {
  const r = plan?.riskRewardRatio;
  return r != null && Number.isFinite(Number(r)) ? Number(r) : null;
}

function chargesAwareRR(plan) {
  const rr = rrOf(plan);
  if (rr == null) return null;
  return Number((rr * 0.92).toFixed(2)); // soft round-trip cost haircut
}

function hasReversalConfirm(r) {
  const q = r.setup?.quality;
  if (r.setup?.type === 'reversal' && q === 'confirmed') return 'confirmed';
  if (r.setup?.type === 'reversal' && q === 'possible') return 'possible';
  const events = r.breakout?.events || [];
  if (r.breakout?.primary === 'FAILED_BREAKOUT' || events.some((e) => e.type === 'FAILED_BREAKOUT')) {
    return 'failed_breakdown';
  }
  return null;
}

function volumeConfirm(r) {
  const v = r.volSpike ?? r.indicators?.volSpike;
  if (v == null) return { ok: false, level: 'unknown', v: null };
  if (v >= 1.8) return { ok: true, level: 'strong', v };
  if (v >= 1.3) return { ok: true, level: 'moderate', v };
  return { ok: false, level: 'weak', v };
}

/**
 * Confidence is NOT a copy of setup score.
 * Requires: adequate sample for historical claim + structural confirmation for HIGH.
 */
function deriveConfidence({ setupScore, sampleSize, reversalConfirm, alreadyMoved, rrNet }) {
  const n = sampleSize;
  const insufficient = n == null || n < MIN_SAMPLE;

  if (alreadyMoved) {
    return { label: 'LOW', reason: 'Already extended — confidence capped', sampleSize: n };
  }
  if (rrNet != null && rrNet < 1.5) {
    return { label: 'LOW', reason: 'Net R:R below 1.5', sampleSize: n };
  }
  if (!reversalConfirm && setupScore < 70) {
    return { label: 'LOW', reason: 'No structural confirmation', sampleSize: n };
  }
  if (insufficient) {
    return {
      label: 'INSUFFICIENT',
      reason: `n=${n ?? 0} < ${MIN_SAMPLE} — cannot claim MED/HIGH`,
      sampleSize: n,
    };
  }
  // Confirmed structure + large sample + strong setup → HIGH
  if (
    setupScore >= 72 &&
    n >= MIN_SAMPLE_HIGH &&
    (reversalConfirm === 'confirmed' || reversalConfirm === 'failed_breakdown') &&
    rrNet != null &&
    rrNet >= MIN_RR
  ) {
    return { label: 'HIGH', reason: `Confirmed structure · n=${n}`, sampleSize: n };
  }
  if (setupScore >= 58 && n >= MIN_SAMPLE) {
    return { label: 'MED', reason: `Adequate sample n=${n}`, sampleSize: n };
  }
  return { label: 'LOW', reason: 'Setup or sample not strong enough', sampleSize: n };
}

/**
 * Entry readiness separate from score/confidence.
 * Oversold RSI alone → never BUY NOW.
 */
function deriveEntryReadiness({
  setupScore,
  confidence,
  reversalConfirm,
  alreadyMoved,
  rrNet,
  vol,
  rsi,
  scanner,
}) {
  if (alreadyMoved) return { action: 'WATCHLIST', note: 'Already moved — late entry risk' };
  if (rrNet == null || rrNet < 1.5) return { action: 'NO TRADE', note: 'R:R net insufficient' };
  if (setupScore < 50) return { action: 'NO TRADE', note: 'Setup score too weak' };

  // Hard rule: oversold alone is not a buy
  const onlyOversold =
    rsi != null &&
    rsi < 32 &&
    !reversalConfirm &&
    (vol == null || vol < 1.3);
  if (onlyOversold) {
    return { action: 'WATCHLIST', note: 'Oversold alone — not a reversal confirmation' };
  }

  if (scanner === 'deep_fall_reversal' || scanner === 'bottom_formation') {
    if (reversalConfirm === 'confirmed' && confidence.label === 'HIGH' && rrNet >= MIN_RR && vol != null && vol >= 1.3) {
      return { action: 'BUY NOW', note: 'Confirmed recovery + volume + R:R' };
    }
    if (reversalConfirm === 'confirmed' || (reversalConfirm === 'possible' && vol != null && vol >= 1.5)) {
      return { action: 'WAIT', note: 'Wait final trigger candle / volume hold' };
    }
    if (reversalConfirm === 'failed_breakdown' && vol != null && vol >= 1.4) {
      return { action: 'WAIT', note: 'Failed breakdown — wait reclaim hold' };
    }
    return { action: 'WATCHLIST', note: 'Fall noted — recovery not confirmed' };
  }

  if (scanner === 'pre_breakout') {
    return { action: 'WAIT', note: 'Pre-breakout — enter only on break & hold' };
  }
  if (scanner === 'early_continuation') {
    if (setupScore >= 70 && vol != null && vol >= 1.4 && rrNet >= MIN_RR && confidence.label !== 'INSUFFICIENT') {
      return { action: 'BUY NOW', note: 'Early continuation with volume' };
    }
    return { action: 'WAIT', note: 'Continuation forming — confirm hold' };
  }
  return { action: 'WATCHLIST', note: 'Monitor only' };
}

function positionSize(entry, stop, capital = 10000, riskPct = 1) {
  if (!entry || !stop || entry <= stop) return { qty: 0, riskRs: 0 };
  const riskRs = capital * (riskPct / 100);
  const perShare = entry - stop;
  const qty = Math.max(0, Math.floor(riskRs / perShare));
  return { qty, riskRs: Number((qty * perShare).toFixed(2)), capital, riskPct };
}

function historicalBlock(r) {
  const mp = r.moveProbability || {};
  const n = mp.sampleSize ?? null;
  const insufficient = n == null || n < MIN_SAMPLE;
  const pick = (v) => (insufficient || v == null ? null : Number(v));
  return {
    sampleSize: n,
    insufficient,
    // Same-day style bands — only when estimator provides them
    sameDay: {
      p3: pick(mp.probabilityUp3PctPlus ?? mp.probabilityUp1PctPlus),
      p5: pick(mp.probabilityUp5PctPlus),
      p10: pick(mp.probabilityUp10PctPlus),
      p15: pick(mp.probabilityUp15PctPlus),
    },
    multiDay: {
      d1: pick(mp.probabilityUp1PctPlus),
      d3: pick(mp.probabilityUp5PctPlus),
      d5: pick(mp.probabilityUp5PctPlus),
    },
    stopFirstRisk: pick(mp.probabilityDown2PctPlus ?? mp.probabilityDown3PctPlus),
    note: insufficient
      ? `Insufficient history (n=${n ?? 0}). Probabilities withheld — not fabricated.`
      : `From n=${n} stock-local analogues. Not a guarantee.`,
  };
}

function stageFrom({ scanner, reversalConfirm, alreadyMoved, setupScore, vol }) {
  if (alreadyMoved) return 'EXTENDED';
  if (scanner === 'pre_breakout') return 'PRE_BREAKOUT';
  if (scanner === 'bottom_formation') {
    if (reversalConfirm === 'confirmed') return 'TRIGGER_NEAR';
    return 'SETUP_FORMING';
  }
  if (scanner === 'deep_fall_reversal') {
    if (reversalConfirm === 'confirmed' && vol != null && vol >= 1.3) return 'CONFIRMED';
    if (reversalConfirm === 'possible' || reversalConfirm === 'failed_breakdown') return 'TRIGGER_NEAR';
    if (setupScore >= 55) return 'ACCUMULATION';
    return 'EARLY';
  }
  if (scanner === 'early_continuation') {
    return setupScore >= 70 ? 'CONFIRMED' : 'EARLY';
  }
  return 'EARLY';
}

/* ---------------- scanners ---------------- */

function deepFallScore(r) {
  const d1 = r.periodReturns?.oneDay ?? r.pChange;
  const d5 = r.periodReturns?.fiveDay ?? r.periodReturns?.oneWeek ?? r.periodReturns?.fifteenDay;
  const d1m = r.periodReturns?.oneMonth;
  if (r.price != null && r.price > PRICE_CAP) return null;

  // Same-day deep fall 5–20% OR multi-day 5–22%
  const dayFall = d1 != null && d1 <= -5 && d1 >= -20;
  const weekFall = d5 != null && d5 <= -5 && d5 >= -22;
  const monthFall = d1m != null && d1m <= -10 && d1m >= -35;
  if (!dayFall && !weekFall && !monthFall) return null;

  // Falling knife without any volume absorption → reject
  if (r.setup?.quality === 'falling_knife' && (r.volSpike || 0) < 1.4) return null;

  let s = 30;
  const reasons = [];
  const risks = [];
  const bullish = [];
  const bearish = [];

  if (dayFall) {
    s += 14;
    reasons.push(`Down ${d1.toFixed(1)}% today`);
    bullish.push(`Sharp same-day decline ${d1.toFixed(1)}% — watching for absorption`);
  }
  if (weekFall) {
    s += 10;
    reasons.push(`Down ${d5.toFixed(1)}% ~1w`);
  }
  if (monthFall) {
    s += 6;
    reasons.push(`Down ${d1m.toFixed(1)}% 1M`);
  }

  const rev = hasReversalConfirm(r);
  if (rev === 'confirmed') {
    s += 22;
    reasons.push('Confirmed reversal structure');
    bullish.push('Price structure confirms recovery attempt');
  } else if (rev === 'possible') {
    s += 10;
    reasons.push('Possible reversal — needs confirmation');
  } else if (rev === 'failed_breakdown') {
    s += 14;
    reasons.push('Failed breakdown / reclaim bias');
    bullish.push('Failed breakdown — sellers may be exhausted');
  } else {
    risks.push('No structural reversal confirmation');
    bearish.push('No confirmed recovery structure yet');
    // Oversold alone does NOT rescue the setup
  }

  const rsi = r.rsi14 ?? r.indicators?.rsi14;
  if (rsi != null && rsi < 30) {
    // Soft context only — never primary qualification
    if (rev) {
      s += 6;
      reasons.push(`RSI ${rsi.toFixed(0)} with structure`);
    } else {
      s += 2;
      risks.push(`RSI ${rsi.toFixed(0)} oversold alone — not enough`);
      bearish.push('Oversold without structure is not a buy signal');
    }
  } else if (rsi != null && rsi < 40 && rev) {
    s += 4;
    reasons.push(`RSI ${rsi.toFixed(0)}`);
  } else if (rsi != null && rsi > 55) {
    s -= 6;
    risks.push('RSI already mid-range');
  }

  const vol = volumeConfirm(r);
  if (vol.ok && vol.level === 'strong') {
    s += 12;
    reasons.push(`Vol ${Number(vol.v).toFixed(1)}x`);
    bullish.push('Elevated volume — possible capitulation/absorption');
  } else if (vol.ok) {
    s += 6;
    reasons.push(`Vol ${Number(vol.v).toFixed(1)}x`);
  } else {
    risks.push('Volume not elevated for exhaustion read');
    bearish.push('Weak volume on bounce attempt');
  }

  // Early bounce day after fall (not freefall continuation)
  if (d1 != null && d1 > 0 && d1 < 3.5 && (weekFall || monthFall)) {
    s += 8;
    reasons.push('Early bounce day after multi-day fall');
    bullish.push('First green response after decline');
  }
  if (d1 != null && d1 <= -8 && !vol.ok) {
    s -= 10;
    risks.push('Still freefalling without absorption');
    bearish.push('Selling still in control');
  }
  if (d1 != null && d1 >= 5) {
    s -= 12;
    risks.push('Already bounced hard today — late');
  }

  const plan = r.tradePlan;
  const rr = rrOf(plan);
  if (rr != null && rr >= MIN_RR) {
    s += 10;
    reasons.push(`R:R 1:${rr.toFixed(2)}`);
  } else if (rr != null && rr >= 1.5) {
    s += 4;
  } else {
    risks.push('R:R weak or missing');
  }

  if (r.fundamentals) {
    const roe = r.fundamentals.roe;
    if (roe != null) {
      const roePct = roe <= 1.5 ? roe * 100 : roe;
      if (roePct >= 12) {
        s += 5;
        reasons.push('ROE supportive');
        bullish.push('Fundamentals not broken');
      } else if (roePct < 5) {
        s -= 8;
        risks.push('Weak ROE — fall may be justified');
        bearish.push('Fundamental weakness');
      }
    }
  }

  s = clamp(Math.round(s), 0, 100);
  // Gate: no confirmation + weak volume → must score low enough to not look "ready"
  if (!rev && !vol.ok && s > 55) s = 55;

  const alreadyMoved = d1 != null && d1 >= 5;
  return {
    scanner: 'deep_fall_reversal',
    setupScore: s,
    score: s, // backward compat
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 5),
    bullishEvidence: bullish.slice(0, 4),
    bearishEvidence: bearish.slice(0, 4),
    alreadyMoved,
    reversalConfirm: rev,
    vol: vol.v,
    rsi,
  };
}

function bottomFormationScore(r) {
  const d1m = r.periodReturns?.oneMonth;
  const d3m = r.periodReturns?.threeMonth;
  const d1y = r.periodReturns?.oneYear;
  const d5 = r.periodReturns?.fiveDay ?? r.periodReturns?.oneWeek;
  if (r.price != null && r.price > PRICE_CAP) return null;

  const nearWeekLow = (d1m != null && d1m <= -8 && d1m >= -28) || (d5 != null && d5 <= -10);
  const nearMonthLow = d3m != null && d3m <= -12;
  const nearYearLow = d1y != null && d1y <= -20;
  if (!nearWeekLow && !nearMonthLow && !nearYearLow) return null;
  if (r.setup?.quality === 'falling_knife') return null;

  let s = 32;
  const reasons = [];
  const risks = [];
  const bullish = [];
  const bearish = [];

  if (d1m != null && d1m <= -8) {
    s += 10;
    reasons.push(`1M ${d1m.toFixed(1)}%`);
  }
  if (nearMonthLow) {
    s += 10;
    reasons.push(`3M ${d3m.toFixed(1)}%`);
  }
  if (nearYearLow) {
    s += 8;
    reasons.push(`1Y ${d1y.toFixed(1)}%`);
  }

  const rev = hasReversalConfirm(r);
  if (rev === 'confirmed') {
    s += 16;
    reasons.push('Confirmed base recovery');
    bullish.push('Structure supports bottom attempt');
  } else if (rev === 'possible' || rev === 'failed_breakdown') {
    s += 8;
    reasons.push('Base structure forming');
  } else {
    risks.push('Bottom not confirmed by structure');
    bearish.push('May still be mid-trend decline');
  }

  const rsi = r.rsi14 ?? r.indicators?.rsi14;
  if (rsi != null && rsi >= 35 && rsi <= 50 && rev) {
    s += 10;
    reasons.push('RSI base zone with structure');
  } else if (rsi != null && rsi < 30 && !rev) {
    s += 2;
    risks.push('Deep oversold without confirmation');
  }

  const vol = volumeConfirm(r);
  if (vol.v != null && vol.v < 0.85) {
    s += 4;
    reasons.push('Quiet volume (possible absorption)');
  }
  if (vol.v != null && vol.v > 2.5 && (r.pChange || 0) < -2) {
    s -= 8;
    risks.push('Heavy sell volume still active');
    bearish.push('Distribution still ongoing');
  }

  const rr = rrOf(r.tradePlan);
  if (rr != null && rr >= MIN_RR) s += 8;

  s = clamp(Math.round(s), 0, 100);
  if (!rev && s > 58) s = 58;

  return {
    scanner: 'bottom_formation',
    setupScore: s,
    score: s,
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 5),
    bullishEvidence: bullish.slice(0, 4),
    bearishEvidence: bearish.slice(0, 4),
    alreadyMoved: false,
    reversalConfirm: rev,
    vol: vol.v,
    rsi,
    horizonHint: nearYearLow ? 'multi_week' : nearMonthLow ? '1_3_weeks' : '1_2_weeks',
  };
}

function preBreakoutScore(r) {
  const d1 = r.periodReturns?.oneDay ?? r.pChange;
  if (r.price != null && r.price > PRICE_CAP) return null;
  if (d1 != null && (d1 < -2.5 || d1 > 2.5)) return null;

  const br = r.breakout;
  const events = br?.events || [];
  const hasRetest = events.some((e) => e.type === 'BREAKOUT_RETEST');
  const hasConsol = events.some((e) => e.type === 'CONSOLIDATION_BREAKOUT');
  const has20d = events.some((e) => e.type === '20_DAY_HIGH');
  const alreadyConfirmed = (has20d || hasConsol) && d1 != null && d1 > 3;
  if (alreadyConfirmed) return null;

  let s = 28;
  const reasons = [];
  const risks = [];
  const bullish = [];
  const bearish = [];

  if (hasRetest) {
    s += 16;
    reasons.push('Breakout retest — second-chance zone');
    bullish.push('Retest holds — energy for next leg');
  }
  if (hasConsol && !alreadyConfirmed) {
    s += 12;
    reasons.push('Consolidation break structure');
  }
  if ((r.score || 0) >= 2) {
    s += 8;
    reasons.push('Technical pressure building');
  }

  const vol = volumeConfirm(r);
  if (vol.ok && vol.level === 'moderate') {
    s += 10;
    reasons.push(`Volume waking ${Number(vol.v).toFixed(1)}x`);
  } else if (vol.v != null && vol.v >= 2.5) {
    s -= 5;
    risks.push('Volume already explosive — may be late');
  } else {
    risks.push('Volume still quiet');
  }

  if (r.setup?.type === 'breakout' || r.setup?.type === 'momentum') {
    s += 8;
    reasons.push(`Setup ${r.setup.type}`);
  }
  if (d1 != null && Math.abs(d1) <= 1) {
    s += 6;
    reasons.push('Flat day — energy stored');
  }

  const rr = rrOf(r.tradePlan);
  if (rr != null && rr >= MIN_RR) s += 10;
  else if (rr != null && rr < 1.5) {
    s -= 6;
    risks.push('Poor R:R');
  }

  s = clamp(Math.round(s), 0, 100);
  if (s < 48) return null;

  return {
    scanner: 'pre_breakout',
    setupScore: s,
    score: s,
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 5),
    bullishEvidence: bullish.slice(0, 4),
    bearishEvidence: bearish.slice(0, 4),
    alreadyMoved: false,
    reversalConfirm: hasRetest ? 'possible' : null,
    vol: vol.v,
    rsi: r.rsi14 ?? r.indicators?.rsi14,
  };
}

function continuationScore(r) {
  const d1 = r.periodReturns?.oneDay ?? r.pChange;
  const d5 = r.periodReturns?.fiveDay ?? r.periodReturns?.oneWeek;
  if (r.price != null && r.price > PRICE_CAP) return null;
  if (d1 == null || d1 < 0.5 || d1 > 6) return null;
  if (d5 != null && d5 > 18) return null;

  let s = 32;
  const reasons = [];
  const risks = [];
  const bullish = [];
  const bearish = [];

  if (
    r.breakout?.primary === '20_DAY_HIGH' ||
    r.breakout?.primary === 'CONSOLIDATION_BREAKOUT' ||
    r.breakout?.primary === '52_WEEK_HIGH'
  ) {
    s += 15;
    reasons.push('Breakout structure');
    bullish.push('Breakout structure intact');
  }
  if (r.setup?.type === 'momentum' || r.setup?.type === 'breakout') {
    s += 10;
    reasons.push(`Setup ${r.setup.type}`);
  }

  const vol = volumeConfirm(r);
  if (vol.ok) {
    s += 12;
    reasons.push(`Vol ${Number(vol.v).toFixed(1)}x`);
    bullish.push('Volume supports continuation');
  } else {
    risks.push('Volume weak for continuation');
    bearish.push('Move may lack follow-through');
  }

  if (d1 >= 0.5 && d1 <= 3) {
    s += 10;
    reasons.push('Early-day continuation range');
  }
  if (d1 > 4) {
    s -= 8;
    risks.push('Already extended intraday');
    bearish.push('Late entry risk');
  }

  const rr = rrOf(r.tradePlan);
  if (rr != null && rr >= MIN_RR) s += 10;
  else if (rr != null && rr < 1.5) risks.push('R:R thin');

  s = clamp(Math.round(s), 0, 100);
  if (s < 52) return null;

  return {
    scanner: 'early_continuation',
    setupScore: s,
    score: s,
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 5),
    bullishEvidence: bullish.slice(0, 4),
    bearishEvidence: bearish.slice(0, 4),
    alreadyMoved: d1 > 4,
    reversalConfirm: null,
    vol: vol.v,
    rsi: r.rsi14 ?? r.indicators?.rsi14,
  };
}

function buildPlanCard(r, meta, prior = null) {
  const plan = r.tradePlan || {};
  const price = r.price;
  const entry = plan.entry ?? plan.entryLow ?? price;
  const entryHigh = plan.entryHigh ?? entry;
  const stop = plan.stopLoss;
  const t1 = plan.target ?? plan.target1;
  const t2 = plan.target2 || (t1 && price ? price + (t1 - price) * 1.6 : null);
  const t3 = plan.target3 || (t1 && price ? price + (t1 - price) * 2.4 : null);
  const rr = rrOf(plan);
  const rrNet = chargesAwareRR(plan);
  const pos = positionSize(entry, stop);
  const hist = historicalBlock(r);

  const conf = deriveConfidence({
    setupScore: meta.setupScore ?? meta.score,
    sampleSize: hist.sampleSize,
    reversalConfirm: meta.reversalConfirm,
    alreadyMoved: meta.alreadyMoved,
    rrNet,
  });

  const readiness = deriveEntryReadiness({
    setupScore: meta.setupScore ?? meta.score,
    confidence: conf,
    reversalConfirm: meta.reversalConfirm,
    alreadyMoved: meta.alreadyMoved,
    rrNet,
    vol: meta.vol,
    rsi: meta.rsi,
    scanner: meta.scanner,
  });

  const stage = stageFrom({
    scanner: meta.scanner,
    reversalConfirm: meta.reversalConfirm,
    alreadyMoved: meta.alreadyMoved,
    setupScore: meta.setupScore ?? meta.score,
    vol: meta.vol,
  });

  const detectPrice = prior?.detectPrice ?? price;
  const detectedAt = prior?.detectedAt ?? new Date().toISOString();
  const returnSinceDetection =
    detectPrice != null && price != null && detectPrice > 0
      ? Number((((price - detectPrice) / detectPrice) * 100).toFixed(2))
      : null;

  return {
    symbol: r.symbol,
    indexLabel: r.indexLabel || null,
    price,
    scanner: meta.scanner,
    // Separate metrics (score kept for backward compat)
    setupScore: meta.setupScore ?? meta.score,
    score: meta.setupScore ?? meta.score,
    historicalProbability: hist,
    confidence: conf.label,
    confidenceDetail: conf,
    entryReadiness: readiness.action,
    entryReadinessNote: readiness.note,
    action: readiness.action, // primary action field for UI
    stage,
    reasons: meta.reasons,
    risks: meta.risks,
    bullishEvidence: meta.bullishEvidence || [],
    bearishEvidence: meta.bearishEvidence || [],
    alreadyMoved: !!meta.alreadyMoved,
    setupType: r.setupType || r.setup?.type || null,
    setupQuality: r.setupQuality || r.setup?.quality || null,
    reversalConfirm: meta.reversalConfirm || null,
    entryZone: entry != null ? { low: entry, high: entryHigh } : null,
    trigger:
      plan.trigger ||
      (meta.scanner === 'pre_breakout'
        ? 'Break & hold above recent range high on volume'
        : meta.scanner === 'deep_fall_reversal'
          ? 'Hold above entry zone low with volume ≥1.3x'
          : null),
    stopLoss: stop,
    targets: { t1, t2, t3 },
    riskReward: rr,
    riskRewardNet: rrNet,
    positionSize: pos,
    invalidation:
      plan.invalidation ||
      (stop != null ? `Daily close below ₹${Number(stop).toFixed(2)}` : 'Structure break / thesis fails'),
    firstDetection: {
      at: detectedAt,
      price: detectPrice,
      returnPct: returnSinceDetection,
    },
    multiDayHint: meta.horizonHint || null,
    fundamentalsNote: r.fundamentals
      ? {
          pe: r.fundamentals.peTrailing,
          roe: r.fundamentals.roe,
          fiiDelta: r.fundamentals.shareholdingSummary?.fiiDelta,
          diiDelta: r.fundamentals.shareholdingSummary?.diiDelta,
        }
      : null,
    dataFreshness: r.scannedAt || new Date().toISOString(),
    sampleSize: hist.sampleSize,
    sampleWarning: hist.insufficient
      ? hist.note
      : hist.sampleSize != null && hist.sampleSize < MIN_SAMPLE_HIGH
        ? `Moderate sample n=${hist.sampleSize} — not HIGH confidence eligible`
        : null,
  };
}

function rankAndTrim(list, limit = MAX_PER_SCANNER) {
  return list
    .filter(Boolean)
    // Prefer confirmed readiness, then setup score, then net R:R
    .sort((a, b) => {
      const order = { 'BUY NOW': 0, WAIT: 1, WATCHLIST: 2, 'NO TRADE': 3 };
      const ao = order[a.action] ?? 9;
      const bo = order[b.action] ?? 9;
      if (ao !== bo) return ao - bo;
      return (b.setupScore || 0) - (a.setupScore || 0) || (b.riskRewardNet || 0) - (a.riskRewardNet || 0);
    })
    .slice(0, limit);
}

async function loadPriorMap() {
  try {
    const store = require('./earlyOpportunityStore');
    const rows = await store.listByStatus('active', 200);
    const map = new Map();
    for (const row of rows || []) {
      map.set(`${row.scanner}:${row.symbol}`, {
        detectPrice: row.detectPrice,
        detectedAt: row.detectedAt,
      });
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function runEarlyOpportunityScan(opts = {}) {
  const { forceRefresh = false, jobId = null } = opts;
  const progressStore = (() => {
    try {
      return require('./progressStore');
    } catch (_) {
      return null;
    }
  })();
  if (jobId && progressStore) {
    try {
      progressStore.startJob(jobId, 450, 'Early Opportunity: loading universe…');
    } catch (_) {}
  }

  const onProgress = (info) => {
    if (!jobId || !progressStore) return;
    try {
      progressStore.updateJob(jobId, info.completed, {
        total: info.total,
        message: info.message || `Scanning ${info.symbol || ''}…`,
        phase: info.phase || 'universe',
        detail: info.symbol || null,
        log: info.symbol ? `${info.completed}/${info.total} ${info.symbol}` : info.message,
      });
    } catch (_) {}
  };

  const { results, symbolToIndex, marketContext, scannedAt, scannedCount } =
    await getCombinedUniverseScan({ forceRefresh, onProgress });

  const priorMap = await loadPriorMap();

  const deep = [];
  const bottom = [];
  const pre = [];
  const cont = [];

  for (const row of results) {
    if (!row || row.error || row.price == null) continue;
    const r = { ...row, indexLabel: symbolToIndex[row.symbol] || row.indexLabel };

    const df = deepFallScore(r);
    if (df) deep.push(buildPlanCard(r, df, priorMap.get(`deep_fall_reversal:${r.symbol}`)));

    const bf = bottomFormationScore(r);
    if (bf) bottom.push(buildPlanCard(r, bf, priorMap.get(`bottom_formation:${r.symbol}`)));

    const pb = preBreakoutScore(r);
    if (pb) pre.push(buildPlanCard(r, pb, priorMap.get(`pre_breakout:${r.symbol}`)));

    const ec = continuationScore(r);
    if (ec) cont.push(buildPlanCard(r, ec, priorMap.get(`early_continuation:${r.symbol}`)));
  }

  const payload = {
    ok: true,
    scannedAt,
    scannedCount,
    marketTrend: marketContext?.trend || marketContext?.label || null,
    marketNote: marketContext?.note || null,
    metricDefinitions: {
      setupScore: '0–100 technical/structure confluence for this scanner. Not a probability.',
      historicalProbability: 'Stock-local analogue hit rates; null when sample insufficient.',
      confidence: 'INSUFFICIENT / LOW / MED / HIGH from sample size + confirmation — not copied from setup score.',
      entryReadiness: 'BUY NOW / WAIT / WATCHLIST / NO TRADE from confirmation + R:R + volume rules.',
    },
    scanners: {
      deep_fall_reversal: rankAndTrim(deep),
      bottom_formation: rankAndTrim(bottom),
      pre_breakout: rankAndTrim(pre),
      early_continuation: rankAndTrim(cont),
    },
    counts: {
      deep_fall_reversal: deep.length,
      bottom_formation: bottom.length,
      pre_breakout: pre.length,
      early_continuation: cont.length,
    },
    disclaimer:
      'Setup Score ≠ probability. Confidence never HIGH on tiny samples or without structure. Oversold alone is not a reversal. NO TRADE preferred over forced entries.',
  };

  if (jobId && progressStore) {
    try {
      progressStore.endJob(jobId, 'Early Opportunity scan done', payload);
    } catch (_) {}
  }
  return payload;
}

async function backtestSymbolSetup(symbol, kind = 'deep_fall_reversal') {
  try {
    const candles = await marketData.getHistorical(symbol, 800);
    if (!candles || candles.length < 260) {
      return {
        ok: false,
        symbol,
        limitation: 'Insufficient history for walk-forward style test',
        sampleSize: candles?.length || 0,
      };
    }
    let signals = 0;
    let hit5 = 0;
    let hitSL = 0;
    let sumMfe = 0;
    let sumMae = 0;
    let falsePos = 0;

    for (let i = 40; i < candles.length - 6; i++) {
      const c0 = candles[i].close;
      const prev = candles[i - 1]?.close;
      if (!c0 || !prev) continue;
      const dayFall = ((c0 - prev) / prev) * 100;
      // Point-in-time: only use past data for signal
      let trigger = false;
      if (kind === 'deep_fall_reversal' && dayFall <= -5 && dayFall >= -20) trigger = true;
      if (kind === 'bottom_formation') {
        const look = candles.slice(Math.max(0, i - 20), i + 1);
        const hi = Math.max(...look.map((c) => c.high));
        if (hi > 0 && ((c0 - hi) / hi) * 100 <= -12) trigger = true;
      }
      if (!trigger) continue;

      signals += 1;
      const entry = c0;
      const stop = entry * 0.97;
      const tgt = entry * 1.05;
      let mfe = 0;
      let mae = 0;
      let outcome = 'none';
      for (let j = 1; j <= 5; j++) {
        const b = candles[i + j];
        if (!b) break;
        mfe = Math.max(mfe, ((b.high - entry) / entry) * 100);
        mae = Math.min(mae, ((b.low - entry) / entry) * 100);
        if (b.low <= stop) {
          outcome = 'sl';
          break;
        }
        if (b.high >= tgt) {
          outcome = 'tgt';
          break;
        }
      }
      if (outcome === 'tgt') hit5 += 1;
      else if (outcome === 'sl') hitSL += 1;
      else falsePos += 1;
      sumMfe += mfe;
      sumMae += mae;
    }

    const n = signals;
    return {
      ok: true,
      symbol,
      kind,
      sampleSize: n,
      target5PctHitRate: n ? Number(((hit5 / n) * 100).toFixed(1)) : null,
      stop3PctHitRate: n ? Number(((hitSL / n) * 100).toFixed(1)) : null,
      falsePositiveRate: n ? Number(((falsePos / n) * 100).toFixed(1)) : null,
      avgMfe: n ? Number((sumMfe / n).toFixed(2)) : null,
      avgMae: n ? Number((sumMae / n).toFixed(2)) : null,
      costsNote: 'Simplified 3% stop / 5% target; no full slippage model.',
      note:
        n < MIN_SAMPLE
          ? `Only ${n} historical analogues — not reliable for probability claims.`
          : 'Walk-forward style on this symbol only; not portfolio-wide proof.',
      limitation: 'Single-symbol diagnostic. Regime splits and costs partial.',
    };
  } catch (err) {
    return { ok: false, symbol, error: err.message };
  }
}

module.exports = {
  runEarlyOpportunityScan,
  backtestSymbolSetup,
  deepFallScore,
  bottomFormationScore,
  preBreakoutScore,
  continuationScore,
  deriveConfidence,
  deriveEntryReadiness,
  MIN_SAMPLE,
  MIN_SAMPLE_HIGH,
};
