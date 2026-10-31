/**
 * EARLY BOOM DETECTOR (Morning Storm core)
 * Find 1–5 names as EARLY as possible with data-supported odds of a major
 * SAME-DAY move — before the large move has already happened.
 *
 * Reality check:
 * - No guaranteed +5% / 90% hit rate.
 * - Prefer early volume + momentum acceleration over chasing extensions.
 * - Empty HIGH board = NO HIGH-CONFIDENCE OPPORTUNITY (sit out is valid).
 * - Track entry → MFE/MAE → target/SL from first appearance for calibration.
 */
const marketData = require('./marketData');
const { getCombinedUniverseScan } = require('./universeScan');
const { isAffordableRecommendPrice, isActionable } = require('./stockAnalysisEngine');
const { startJob, updateJob, endJob } = require('./progressStore');
const { INDEXES } = require('./indexConstituents');
const { buildManagedPlan, adviseManagement } = require('./morningStormManage');

function defaultPositionSize(entry, stop2) {
  const capital = Number(process.env.DEFAULT_TRADE_CAPITAL || 10000);
  const riskPct = 2;
  const riskInr = capital * (riskPct / 100);
  let shares = null;
  if (entry && stop2 && entry > stop2) {
    const perShare = entry - stop2;
    shares = perShare > 0 ? Math.max(1, Math.floor(riskInr / perShare)) : null;
  }
  return {
    capitalInr: capital,
    maxLossPct: riskPct,
    maxLossInr: Number(riskInr.toFixed(0)),
    suggestedShares: shares,
    note: '1 Storm trade / din · SL2 pe max loss ~capital ka 2%',
  };
}


const MAX_PICKS = Math.min(5, Number(process.env.MS_MAX_PICKS_SCAN || 5));
const MAX_DAY_EXT = 3.5; // early boom: cut chase earlier
const MIN_DAY_MOVE = 0.35; // catch earlier lift
const PREFER_DAY_MAX = 2.4; // sweet spot still has room
const MIN_VOL = 1.8;
const MIN_STORM_SCORE = 40; // was ~24 — aim fewer, higher-quality
const MIN_RR_T2 = 1.5;
const MAX_ONE_MONTH_RALLY = 22; // already huge 1M rally → skip
const MIN_FUND_SCORE = 55;
const MAX_ACTIVE_PICKS_PER_DAY = Number(process.env.MS_MAX_PICKS || 1); // discipline: 1 HIGH storm / day default
const NEG_NEWS_RE = /fraud|sebi ban|insolvency|default|raid|arrest|plunge|crash|investigation|penalty|writedown|bankruptcy|demerger blocked/i;


function istMinutes() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    const weekday = get('weekday');
    return { hour, minute, mins: hour * 60 + minute, weekday };
  } catch (_) {
    const d = new Date();
    return { hour: d.getHours(), minute: d.getMinutes(), mins: d.getHours() * 60 + d.getMinutes(), weekday: '' };
  }
}

function windowNote(mins) {
  // Market 9:15–15:30 IST
  if (mins < 9 * 60 + 15) return { phase: 'preopen', note: 'Market abhi open nahi — scan prep / watchlist only.' };
  if (mins < 10 * 60 + 15) return { phase: 'early', note: '10:15 se pehle — noise zyada; volume confirm wait better.' };
  if (mins <= 11 * 60 + 30) return { phase: 'prime', note: 'Prime window (~10:15–11:30) — early strength + volume yahi filter.' };
  if (mins <= 14 * 60) return { phase: 'mid', note: 'Prime window nikal gaya — sirf jo abhi bhi room + volume rakhein.' };
  return { phase: 'late', note: 'Late session — same-day chase risky; skip unless already in profit management.' };
}

function archetypeFrom(row, dayPct, vol) {
  const score = row.score;
  const setup = row.setup?.type;
  const quality = row.setup?.quality;
  // Near support / reversal path with green day
  if (setup === 'reversal' && quality !== 'falling_knife' && dayPct > 0 && dayPct <= PREFER_DAY_MAX) {
    return {
      key: 'LAUNCH_PAD',
      label: 'Neeche se lift',
      why: 'Recent soft structure + aaj green with participation — still not a vertical chase.',
    };
  }
  if (dayPct >= MIN_DAY_MOVE && dayPct <= PREFER_DAY_MAX && vol != null && vol >= 1.5) {
    return {
      key: 'EARLY_POWER',
      label: 'Early power (room left)',
      why: `Aaj +${dayPct.toFixed(1)}% with volume — extension still under ~${PREFER_DAY_MAX}% so late FOMO kam.`,
    };
  }
  if (dayPct > PREFER_DAY_MAX && dayPct <= MAX_DAY_EXT && vol != null && vol >= 2) {
    return {
      key: 'CONTINUATION_ROOM',
      label: 'Continuation (limited room)',
      why: 'Already moving; only if volume exceptional and SL tight — 5–6% extra possible, not guaranteed.',
    };
  }
  if (score >= 2 && dayPct >= 0 && dayPct <= PREFER_DAY_MAX) {
    return {
      key: 'STRUCTURE_LONG',
      label: 'Structure long',
      why: 'Technical score constructive with controlled day move.',
    };
  }
  return null;
}


/** Separate metrics — never treat score as a probability. */
function signalStrengthFrom(reasons, risks, vol, rsScore) {
  let pts = 0;
  pts += Math.min(4, (reasons || []).length);
  pts -= Math.min(3, (risks || []).length);
  if (vol != null && vol >= 2.2) pts += 2;
  else if (vol != null && vol >= 1.8) pts += 1;
  if (rsScore != null && rsScore > 1) pts += 1;
  if (pts >= 6) return 'HIGH';
  if (pts >= 3) return 'MED';
  return 'LOW';
}

/**
 * Measurable stages — Accumulation → Setup Forming → Trigger Near → Confirmed → Extended/Invalidated
 */
function deriveSignalStage({ dayPct, vol, aboveOpen, sessionRangePos, setupType, setupQuality, breakout, alreadyMoved }) {
  if (alreadyMoved || (dayPct != null && dayPct >= 5)) return {
    stage: 'EXTENDED',
    detail: 'Move already extended intraday — late for early entry',
  };
  const events = breakout?.events || [];
  const failed = breakout?.primary === 'FAILED_BREAKOUT' || events.some((e) => e.type === 'FAILED_BREAKOUT');
  if (failed && (dayPct == null || dayPct < 1)) return {
    stage: 'INVALIDATED',
    detail: 'Failed breakout / rejection — structure not holding',
  };
  if (aboveOpen === false && dayPct != null && dayPct < 0) return {
    stage: 'INVALIDATED',
    detail: 'Below open with negative day — weak follow-through',
  };
  // Volume-price divergence: up day on weak volume
  if (dayPct != null && dayPct > 1.5 && vol != null && vol < 1.1) return {
    stage: 'SETUP_FORMING',
    detail: 'Price up but volume soft — divergence, not confirmed',
  };
  if (setupQuality === 'confirmed' && vol != null && vol >= MIN_VOL && dayPct != null && dayPct >= MIN_DAY_MOVE) {
    return { stage: 'CONFIRMED_BREAKOUT', detail: 'Confirmed setup + volume + early lift' };
  }
  if (vol != null && vol >= MIN_VOL && dayPct != null && dayPct >= MIN_DAY_MOVE && dayPct <= 2.5) {
    return { stage: 'TRIGGER_NEAR', detail: 'Volume + early lift in trigger band' };
  }
  if (setupType === 'reversal' || setupQuality === 'possible' || (vol != null && vol >= 1.3)) {
    return { stage: 'SETUP_FORMING', detail: 'Structure forming; wait for trigger confirmation' };
  }
  if (vol != null && vol >= 1.2 && (dayPct == null || Math.abs(dayPct) < 0.8)) {
    return { stage: 'ACCUMULATION', detail: 'Quiet volume interest without chase' };
  }
  return { stage: 'SETUP_FORMING', detail: 'Watching for measurable trigger' };
}

/**
 * Strict validation — missing essentials => WAIT / NO TRADE, never forced BUY.
 */
function validateTrade({ price, vol, plan, dayPct, stage, rrToT2, alreadyMoved, fundOkFlag }) {
  const missing = [];
  if (price == null || !Number.isFinite(Number(price))) missing.push('price');
  if (vol == null) missing.push('volume_ratio');
  if (!plan || plan.stopLoss == null || plan.target1 == null) missing.push('plan_sl_or_target');
  if (plan && plan.entryLow == null) missing.push('entry');

  if (missing.length) {
    return {
      ok: false,
      action: 'NO TRADE',
      reason: `Missing essential data: ${missing.join(', ')}`,
      missing,
    };
  }
  if (alreadyMoved) {
    return { ok: false, action: 'WATCHLIST', reason: 'Already moved — not an early entry', missing: [] };
  }
  if (stage === 'INVALIDATED' || stage === 'EXTENDED') {
    return { ok: false, action: stage === 'INVALIDATED' ? 'NO TRADE' : 'WATCHLIST', reason: `Stage ${stage}`, missing: [] };
  }
  if (vol < MIN_VOL) {
    return { ok: false, action: 'WAIT', reason: `Volume ${Number(vol).toFixed(1)}x < ${MIN_VOL}x required`, missing: [] };
  }
  if (rrToT2 != null && rrToT2 < MIN_RR_T2) {
    return { ok: false, action: 'NO TRADE', reason: `Net R:R to T2 ${rrToT2} < ${MIN_RR_T2}`, missing: [] };
  }
  if (fundOkFlag === false) {
    return { ok: false, action: 'NO TRADE', reason: 'Fundamentals gate failed', missing: [] };
  }
  if (stage === 'ACCUMULATION' || stage === 'SETUP_FORMING') {
    return { ok: false, action: 'WAIT', reason: `Stage ${stage} — trigger not confirmed`, missing: [] };
  }
  if (stage === 'TRIGGER_NEAR' || stage === 'CONFIRMED_BREAKOUT') {
    return { ok: true, action: stage === 'CONFIRMED_BREAKOUT' ? 'BUY NOW' : 'WAIT', reason: `Stage ${stage}`, missing: [] };
  }
  return { ok: false, action: 'WAIT', reason: 'Validation incomplete', missing: [] };
}

function historicalMetrics(row) {
  const mp = row.moveProbability || {};
  const n = mp.sampleSize ?? mp.n ?? null;
  let hitRate = mp.probabilityUp5PctPlus ?? mp.hitRatePct ?? null;
  // Historical Confidence is NOT a probability of profit — sample adequacy only
  let historicalConfidence = 'UNKNOWN';
  if (n == null || n < 8) historicalConfidence = 'INSUFFICIENT';
  else if (n < 20) historicalConfidence = 'LOW';
  else if (n < 40) historicalConfidence = 'MED';
  else historicalConfidence = 'HIGH';
  return {
    historicalHitRate: hitRate != null ? Number(hitRate) : null,
    historicalSampleSize: n,
    historicalConfidence,
    historicalNote:
      n == null || n < 8
        ? 'Insufficient similar past signals on this stock — do not treat score as win probability.'
        : `Based on n=${n} similar past signals on this stock only (not a guarantee).`,
  };
}

function relativeStrengthBlock(row, mctx) {
  const rs = row.relativeStrength || {};
  const sector = row.sectorStrength || row.sectorRs || null;
  return {
    vsNifty1W: rs.rs1W ?? null,
    vsNifty1M: rs.rs1M ?? null,
    rsScore: rs.rsScore ?? null,
    rsStatus: rs.status || 'unavailable',
    rsBreakout: !!rs.rsBreakout,
    marketRegime: mctx?.trend || mctx?.label || mctx?.todayDirection || null,
    sectorNote: sector != null ? String(sector) : null,
  };
}


function scoreCandidate(row, dayPct, vol, mctx) {
  let s = 0;
  const reasons = [];
  const risks = [];

  if (dayPct == null) return null;
  if (dayPct < 0) {
    // Weak open still recoverable only with strong reversal quality
    if (row.setup?.type === 'reversal' && row.setup?.quality === 'confirmed' && vol != null && vol >= 1.8) {
      s += 8;
      reasons.push('Confirmed reversal + volume on soft day');
    } else {
      return null; // morning storm wants participation, not catching pure knives
    }
  }

  if (dayPct > MAX_DAY_EXT) {
    risks.push(`Already +${dayPct.toFixed(1)}% — late entry risk`);
    return null;
  }

  // Prefer sweet spot
  if (dayPct >= 1.0 && dayPct <= PREFER_DAY_MAX) {
    s += 20;
    reasons.push(`Day move +${dayPct.toFixed(1)}% (sweet spot, room left)`);
  } else if (dayPct >= MIN_DAY_MOVE && dayPct < 1.0) {
    s += 10;
    reasons.push(`Day move +${dayPct.toFixed(1)}% (early)`);
  } else if (dayPct > PREFER_DAY_MAX) {
    s += 4;
    risks.push('Extended — only exceptional volume keeps it');
  } else {
    s += 4;
  }

  if (vol == null || vol < MIN_VOL) {
    risks.push(vol == null ? 'Volume unknown' : `Volume only ${Number(vol).toFixed(1)}x (need ≥${MIN_VOL}x)`);
    return null; // hard gate for 70/30-style bar on T1
  }
  if (vol >= 3) { s += 18; reasons.push(`Volume ${vol.toFixed(1)}x strong`); }
  else if (vol >= 2.2) { s += 14; reasons.push(`Volume ${vol.toFixed(1)}x`); }
  else { s += 8; reasons.push(`Volume ${vol.toFixed(1)}x (min)`); }

  if (row.score >= 3) { s += 10; reasons.push(`Score ${row.score.toFixed(1)}`); }
  else if (row.score >= 1.5) { s += 6; }
  else if (row.score < 0) { s -= 8; risks.push('Weak technical score'); }

  const rr = row.tradePlan?.riskRewardRatio;
  if (rr != null && rr >= 2) { s += 8; reasons.push(`R:R 1:${rr}`); }
  else if (rr != null && rr >= 1.4) { s += 4; }
  else if (rr != null && rr < 1.2) { s -= 4; risks.push('Tight R:R'); }

  if (row.setup?.type === 'momentum' || row.setup?.type === 'breakout') {
    s += 5;
    reasons.push(`Setup ${row.setup.type}`);
  }
  if (row.setup?.type === 'reversal' && row.setup?.quality === 'confirmed') {
    s += 8;
    reasons.push('Confirmed reversal');
  }
  if (row.setup?.quality === 'falling_knife') {
    s -= 20;
    risks.push('Falling knife');
  }

  // Market context: in bearish tape, demand higher bar
  const trend = mctx?.trend || mctx?.todayDirection;
  if (trend === 'bearish' || trend === 'down') {
    s -= 4;
    risks.push('Index soft — only strongest names');
    if (vol == null || vol < 1.8) s -= 6;
  } else if (trend === 'bullish' || trend === 'up') {
    s += 3;
  }

  if (!isAffordableRecommendPrice(row)) return null;

  // Hard quality gates toward higher T1 hit-rate (target bias ~70/30 — not a guarantee)
  if (row.score != null && row.score < 1.2) {
    risks.push('Technical score soft');
    return null;
  }
  if (rr != null && rr < 1.3) {
    risks.push('R:R too thin');
    return null;
  }

  const arch = archetypeFrom(row, dayPct, vol);
  if (!arch && s < MIN_STORM_SCORE) return null;
  if (s < MIN_STORM_SCORE) return null;

  // Soft probability bias for T1 (~1.5%) only — calibrated by confluence score
  let t1Bias = { up: 55, down: 45, label: 'MEDIUM', note: 'Base filtered long — still not 70/30' };
  if (s >= 52 && vol >= 2.2 && dayPct >= 1 && dayPct <= PREFER_DAY_MAX) {
    t1Bias = {
      up: 70,
      down: 30,
      label: 'HIGH',
      note: 'Target bias ~70/30 toward T1 (~1.5%) in this confluence band — NOT guaranteed; live track record will recalibrate.',
    };
  } else if (s >= 44 && vol >= MIN_VOL) {
    t1Bias = {
      up: 62,
      down: 38,
      label: 'ABOVE_AVG',
      note: 'Above average setup — aim closer to 60/40 on T1 until sample builds.',
    };
  }

  // Early Boom Score: reward EARLY + volume accel + R:R; penalize already-extended
  let early = s;
  if (dayPct != null && dayPct >= MIN_DAY_MOVE && dayPct <= 1.2) early += 12; // earliest band
  else if (dayPct != null && dayPct <= PREFER_DAY_MAX) early += 6;
  else if (dayPct != null && dayPct > PREFER_DAY_MAX) early -= 10;
  if (vol != null && vol >= 2.5) early += 8;
  if (rr != null && rr >= 2) early += 6;
  if (row.scoreBreakdown?.components?.momentum >= 70) early += 5;
  if (row.scoreBreakdown?.components?.volume >= 70) early += 5;
  early = Math.max(0, Math.min(100, Math.round(early)));

  const alreadyMoved = dayPct != null && dayPct >= 2.8;
  if (alreadyMoved) {
    risks.push(`Already moved +${dayPct.toFixed(1)}% — late-entry warning`);
    early = Math.max(0, early - 15);
  }

  const confLabel = early >= 72 && t1Bias.label === 'HIGH' ? 'HIGH'
    : early >= 55 ? 'MEDIUM' : 'LOW';

  return {
    score: s,
    earlyBoomScore: early,
    confidence: confLabel,
    alreadyMoved: !!alreadyMoved,
    currentMovePct: dayPct,
    reasons,
    risks,
    t1Bias,
    archetype: arch || {
      key: 'STRUCTURE',
      label: 'Structure long',
      why: 'Cleared hard volume + score gates.',
    },
  };
}


/**
 * Same-day vs next-day carry suggestion (not a guarantee).
 * Default bias for Morning Storm = book same day; carry only when structure still strong.
 */
function buildCarrySuggestion({ price, plan, dayPct, setupType, setupQuality, marketTrend, vol, clockMins }) {
  if (price == null || !plan) {
    return {
      action: 'EXIT_EOD',
      label: 'Same day band karo',
      reason: 'Plan incomplete — overnight risk mat lo.',
      confidence: 'low',
    };
  }
  const t1 = plan.target1, t2 = plan.target2, t3 = plan.target3, sl = plan.stopLoss;
  const fromEntry = plan.entryHigh ? ((price - plan.entryHigh) / plan.entryHigh) * 100 : dayPct;
  let action = 'EXIT_EOD';
  let label = 'Shaam / EOD pe band';
  let reason = 'Morning Storm default = same-day; overnight gap risk.';
  let confidence = 'medium';

  // Stop zone
  if (sl != null && price <= sl) {
    return {
      action: 'EXIT_NOW',
      label: 'Abhi exit (SL zone)',
      reason: 'Price SL ke neeche/near — carry mat socho.',
      confidence: 'high',
    };
  }

  const late = clockMins != null && clockMins >= 14 * 60 + 30;
  const hitT2 = t2 != null && price >= t2;
  const hitT1 = t1 != null && price >= t1;
  const hitT3 = t3 != null && price >= t3;
  const weakTape = marketTrend === 'bearish' || marketTrend === 'down';
  const strongTape = marketTrend === 'bullish' || marketTrend === 'up';

  if (hitT3) {
    action = 'BOOK_FULL';
    label = 'Full book — carry mat';
    reason = 'Stretch T3 touch; overnight me give-back common.';
    confidence = 'high';
  } else if (hitT2) {
    action = 'BOOK_PARTIAL_EXIT_REST';
    label = 'Partial book, baaki EOD exit';
    reason = 'T2 hit — profit lock; gap risk se poora overnight mat rakho.';
    confidence = 'high';
  } else if (hitT1 && late) {
    action = 'BOOK_PARTIAL_EXIT_REST';
    label = 'T1+ late session — partial + EOD';
    reason = 'Target aaya + late day; carry optional nahi, prefer book.';
    confidence = 'medium';
  } else if (hitT1 && strongTape && vol != null && vol >= 2 && setupType === 'momentum') {
    action = 'CARRY_SOFT';
    label = 'Soft carry (partial book pehle)';
    reason = 'T1 hit + strong tape + volume — 30–50% book karke trail; full carry nahi.';
    confidence = 'medium';
  } else if (
    !hitT1
    && (fromEntry == null || fromEntry > -0.4)
    && strongTape
    && vol != null
    && vol >= 2
    && (setupType === 'momentum' || setupQuality === 'confirmed')
    && !late
  ) {
    action = 'CARRY_SOFT';
    label = 'Carry soft possible';
    reason = 'Abhi T1 pending, structure ok, index supportive — chhota size overnight soch sakte ho; SL trail.';
    confidence = 'medium';
  } else if (weakTape) {
    action = 'EXIT_EOD';
    label = 'EOD exit — index soft';
    reason = 'Bearish/soft tape me overnight gap downside zyada.';
    confidence = 'high';
  } else if (late && !hitT1) {
    action = 'EXIT_EOD';
    label = 'EOD exit (time cut)';
    reason = 'Late session + target nahi — force overnight mat karo.';
    confidence = 'medium';
  }

  return { action, label, reason, confidence };
}

function sameDayPlan(row, dayPct) {
  const px = row.price;
  if (px == null) return null;
  const atr = row.indicators?.atr14;
  const riskPad = atr != null ? Math.min(atr * 0.6, px * 0.012) : px * 0.008;
  const entryLow = Number((px * 0.998).toFixed(2));
  const entryHigh = Number((px * 1.006).toFixed(2));
  const stopLoss = Number((px - riskPad).toFixed(2));
  // Same-day targets: conservative then stretch (not multi-bag dreams)
  const t1 = Number((px * 1.015).toFixed(2)); // ~1.5%
  const t2 = Number((px * 1.03).toFixed(2));  // ~3%
  const t3 = Number((px * 1.05).toFixed(2));  // ~5% stretch
  const risk = px - stopLoss;
  const reward = t2 - px;
  return {
    entryLow,
    entryHigh,
    stopLoss,
    target1: t1,
    target2: t2,
    target3: t3,
    riskRewardToT2: risk > 0 ? Number((reward / risk).toFixed(2)) : null,
    note: 'Same-day plan: T1 book partial, trail rest. SL hard.',
    dayPctAtPick: dayPct,
  };
}

async function enrichLiveDay(symbol, row) {
  let dayPct = row.periodReturns?.oneDay ?? null;
  let vol = row.volSpike ?? null;
  let last = row.price;
  try {
    const q = await marketData.getQuote(symbol);
    if (q?.lastPrice != null) last = q.lastPrice;
    if (q?.pChange != null) dayPct = q.pChange;
    // volume vs average when quote has volume and we have hist avg from row
  } catch (_) {}
  // Optional 5m: early range position
  let aboveOpen = null;
  let sessionRangePos = null;
  try {
    const bars = await marketData.getIntradayCandles(symbol, '1d', '5m');
    if (bars?.length >= 3) {
      const dayBars = bars; // Yahoo 1d 5m = today
      const open = dayBars[0].open ?? dayBars[0].close;
      const hi = Math.max(...dayBars.map((b) => b.high));
      const lo = Math.min(...dayBars.map((b) => b.low));
      const px = dayBars[dayBars.length - 1].close;
      if (open) aboveOpen = px >= open;
      if (hi > lo) sessionRangePos = (px - lo) / (hi - lo);
      if (dayPct == null && open) dayPct = ((px - open) / open) * 100;
    }
  } catch (_) {}
  return { dayPct, vol, last, aboveOpen, sessionRangePos };
}


function fundOk(f) {
  if (!f) return { ok: false, score: 0, reason: 'No fundamentals' };
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
  const de = f.debtToEquity;
  const pe = f.peTrailing;
  let score = 50;
  const notes = [];
  if (roe != null && roe >= 12) score += 15;
  else if (roe != null && roe >= 8) score += 6;
  else if (roe != null && roe < 5) score -= 15;
  if (de != null && de <= 0.6) score += 10;
  else if (de != null && de <= 1.2) score += 4;
  else if (de != null && de > 2) score -= 15;
  if (pe != null && pe > 0 && pe < 40) score += 5;
  else if (pe != null && pe > 70) score -= 8;
  const sh = f.shareholdingSummary;
  if (sh) {
    if (sh.fiiDelta != null) {
      if (sh.fiiDelta >= 0.5) { score += 8; notes.push(`FII +${sh.fiiDelta}%`); }
      else if (sh.fiiDelta <= -0.5) { score -= 8; notes.push(`FII ${sh.fiiDelta}%`); }
    }
    if (sh.diiDelta != null) {
      if (sh.diiDelta >= 0.5) { score += 6; notes.push(`DII +${sh.diiDelta}%`); }
      else if (sh.diiDelta <= -0.5) { score -= 5; notes.push(`DII ${sh.diiDelta}%`); }
    }
  }
  const ok = score >= MIN_FUND_SCORE && (roe == null || roe >= 8) && (de == null || de <= 1.8);
  const reason = ok
    ? `Fund ${score}${notes.length ? ' · ' + notes.join(' ') : ''}`
    : `Weak fund ${score}${notes.length ? ' · ' + notes.join(' ') : ''}`;
  return { ok, score: Math.max(0, Math.min(100, score)), reason, shareholding: sh || null };
}


async function newsRisk(symbol) {
  try {
    const items = await marketData.getNews(symbol);
    const bad = (items || []).slice(0, 5).filter((n) => NEG_NEWS_RE.test(n.title || ''));
    if (bad.length) {
      return { ok: false, reason: `News risk: ${bad[0].title?.slice(0, 80)}` };
    }
    return { ok: true, headlines: (items || []).slice(0, 2).map((n) => n.title) };
  } catch (_) {
    return { ok: true, headlines: [] }; // fail-open soft
  }
}

async function isStormSessionOpen() {
  try {
    const { getTradingDayStatus } = require('./marketCalendar');
    const st = await getTradingDayStatus();
    if (!st.isTradingDay) return { open: false, reason: st.reason || 'Holiday/weekend' };
  } catch (_) {}
  const clock = istMinutes();
  if (clock.mins < 9 * 60 + 15 || clock.mins >= 15 * 60 + 30) {
    return { open: false, reason: 'Outside 9:15–15:30 IST' };
  }
  return { open: true, reason: null };
}

async function runMorningStormScan({ jobId = null, force = false } = {}) {
  const clock = istMinutes();
  const win = windowNote(clock.mins);
  // Holiday / after 3:30: no heavy universe scan (unless force=true manual research)
  if (!force) {
    const sess = await isStormSessionOpen();
    if (!sess.open) {
      let board = { active: [], rotated: [], tradeDate: null };
      try {
        const store = require('./morningStormStore');
        board = await store.getTodayBoard();
      } catch (_) {}
      if (jobId) {
        try { endJob(jobId, 'Market closed — scan skipped'); } catch (_) {}
      }
      return {
        ok: true,
        skipped: true,
        skipReason: sess.reason,
        window: { phase: 'closed', note: `Scan off: ${sess.reason}. Sticky/monitor only.` },
        clockIST: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
        marketTrend: null,
        scannedAt: null,
        prefilterCount: 0,
        candidateCount: 0,
        board,
        picks: (board.active || []).map((a) => ({
          symbol: a.symbol,
          price: a.lastPrice ?? a.firstPrice,
          firstPrice: a.firstPrice,
          sticky: true,
          stormScore: a.stormScore,
          plan: a.plan,
          managedPlan: a.managedPlan,
          t1Bias: a.t1BiasLabel ? { label: a.t1BiasLabel, up: a.t1BiasUp, down: 100 - (a.t1BiasUp || 70) } : null,
          archetype: { label: a.archetype || 'Sticky', why: 'Aaj pehle suggest — market closed, no rescan' },
          reasons: a.reasons || [],
          risks: a.risks || [],
        })),
        rotatedToday: (board.rotated || []).map((r) => ({
          symbol: r.symbol,
          firstPrice: r.firstPrice,
          firstSeenAt: r.firstSeenAt,
          lastPrice: r.lastPrice,
          stormScore: r.stormScore,
          note: 'Pehle suggest hua',
        })),
        nearMiss: [],
        metricDefinitions: {
      signalScore: '0–100 confluence score for early boom setup (technical+volume+timing). NOT a win probability.',
      signalStrength: 'HIGH/MED/LOW from reason/risk count + volume + relative strength — qualitative strength only.',
      historicalConfidence: 'Sample adequacy (INSUFFICIENT/LOW/MED/HIGH) from similar past signals on THIS stock.',
      historicalHitRate: 'Past analogue hit rate when sample exists — not a forecast of today.',
      signalStage: 'ACCUMULATION | SETUP_FORMING | TRIGGER_NEAR | CONFIRMED_BREAKOUT | EXTENDED | INVALIDATED',
    },
    honesty: [
          'Holiday / 3:30 ke baad naya Morning Storm scan nahi chalta.',
          'Pehle ke sticky picks monitor ke liye dikh sakte hain.',
        ],
        asOf: new Date().toISOString(),
      };
    }
  }

  if (jobId) {
    try {
      startJob(jobId, 100, 'Morning storm scan…');
      updateJob(jobId, 5, { phase: 'universe', message: 'Loading universe scan…' });
    } catch (_) {}
  }

  const { results, marketContext, scannedAt } = await getCombinedUniverseScan({
    forceRefresh: force,
    concurrency: 4,
  });

  const candidates = [];
  const pool = (results || []).filter((r) => !r.error && r.price && isAffordableRecommendPrice(r));

  // Pre-filter to limit live quote calls
  const pre = pool
    .filter((r) => {
      const d = r.periodReturns?.oneDay;
      if (d != null && d > MAX_DAY_EXT + 2) return false;
      if (r.setup?.quality === 'falling_knife') return false;
      return (r.volSpike != null && r.volSpike >= 1.1) || (r.score != null && r.score >= 1) || r.setup?.type === 'reversal';
    })
    .sort((a, b) => {
      const va = a.volSpike || 0;
      const vb = b.volSpike || 0;
      return vb - va || (b.score || 0) - (a.score || 0);
    })
    .slice(0, 80);

  let i = 0;
  for (const row of pre) {
    i += 1;
    if (jobId && i % 8 === 0) {
      try {
        updateJob(jobId, Math.min(90, 10 + Math.round((i / pre.length) * 75)), {
          phase: 'live',
          message: `Live check ${row.symbol}`,
          detail: row.symbol,
        });
      } catch (_) {}
    }
    const live = await enrichLiveDay(row.symbol, row);
    // Skip 1-month monster rallies (already extended swing)
    const m1 = row.periodReturns?.oneMonth;
    if (m1 != null && m1 >= MAX_ONE_MONTH_RALLY) continue;

    let fund = null;
    try {
      fund = await marketData.getFundamentals(row.symbol, { maxAgeDays: 14 });
    } catch (_) {}
    const fq = fundOk(fund);
    if (!fq.ok) continue;

    const nr = await newsRisk(row.symbol);
    if (!nr.ok) continue;

    const scored = scoreCandidate(
      { ...row, price: live.last ?? row.price },
      live.dayPct,
      live.vol,
      marketContext
    );
    if (!scored || scored.score < MIN_STORM_SCORE) continue;
    scored.reasons = [`${fq.reason}`, ...(scored.reasons || [])].slice(0, 7);
    if (nr.headlines?.length) scored.reasons.push(`News clear (${nr.headlines[0]?.slice(0, 40) || 'ok'})`);
    if (live.aboveOpen === false) {
      scored.score -= 12;
      scored.risks.push('Below open — skip for 70/30 bar');
      if (scored.score < MIN_STORM_SCORE) continue;
    }
    if (live.sessionRangePos != null && live.sessionRangePos > 0.92 && live.dayPct > 3) {
      scored.score -= 8;
      scored.risks.push('Near day high already — late');
    }
    if (scored.score < MIN_STORM_SCORE) continue;

    const plan = sameDayPlan({ ...row, price: live.last ?? row.price }, live.dayPct);
    const entryPx = live.last ?? row.price;
    // Skip incomplete live data — never emit as valid BUY signal
    if (entryPx == null || live.vol == null || !plan) continue;

    const managedPlan = buildManagedPlan(entryPx);
    const management = adviseManagement({
      entryPrice: entryPx,
      price: entryPx,
      userStance: 'open',
      marketTrend: marketContext?.trend || marketContext?.todayDirection,
      vol: live.vol,
      clockMins: clock.mins,
    });
    const carrySuggestion = buildCarrySuggestion({
      price: live.last ?? row.price,
      plan,
      dayPct: live.dayPct,
      setupType: row.setup?.type,
      setupQuality: row.setup?.quality,
      marketTrend: marketContext?.trend || marketContext?.todayDirection,
      vol: live.vol,
      clockMins: clock.mins,
    });

    const stageInfo = deriveSignalStage({
      dayPct: live.dayPct,
      vol: live.vol,
      aboveOpen: live.aboveOpen,
      sessionRangePos: live.sessionRangePos,
      setupType: row.setup?.type,
      setupQuality: row.setup?.quality,
      breakout: row.breakout,
      alreadyMoved: !!scored.alreadyMoved,
    });
    const hist = historicalMetrics(row);
    const rsBlock = relativeStrengthBlock(row, marketContext);
    const strength = signalStrengthFrom(scored.reasons, scored.risks, live.vol, rsBlock.rsScore);
    // Soft R:R haircut for charges/slippage (~8%)
    const rrRaw = plan.riskRewardToT2;
    const rrNet = rrRaw != null ? Number((rrRaw * 0.92).toFixed(2)) : null;
    const validation = validateTrade({
      price: entryPx,
      vol: live.vol,
      plan,
      dayPct: live.dayPct,
      stage: stageInfo.stage,
      rrToT2: rrNet != null ? rrNet : rrRaw,
      alreadyMoved: !!scored.alreadyMoved,
      fundOkFlag: fq.ok,
    });
    const signalScore = scored.earlyBoomScore != null
      ? Number(scored.earlyBoomScore)
      : Number(scored.score.toFixed(1));

    candidates.push({
      symbol: row.symbol,
      companyName: row.companyName || null,
      indexLabel: row.indexLabel || null,
      price: entryPx,
      dayPct: live.dayPct != null ? Number(Number(live.dayPct).toFixed(2)) : null,
      volSpike: live.vol,
      volumeRatio: live.vol,
      technicalScore: row.score,
      setupType: row.setup?.type || null,
      setupQuality: row.setup?.quality || null,
      // Separate metrics (score ≠ probability)
      signalScore,
      stormScore: Number(scored.score.toFixed(1)),
      earlyBoomScore: signalScore,
      signalStrength: strength,
      historicalConfidence: hist.historicalConfidence,
      historicalHitRate: hist.historicalHitRate,
      historicalSampleSize: hist.historicalSampleSize,
      historicalNote: hist.historicalNote,
      confidence: scored.confidence || scored.t1Bias?.label || 'LOW',
      signalStage: stageInfo.stage,
      signalStageDetail: stageInfo.detail,
      action: validation.action,
      tradeValidation: validation,
      relativeStrength: rsBlock,
      alreadyMoved: !!scored.alreadyMoved,
      currentMovePct: scored.currentMovePct != null ? scored.currentMovePct : live.dayPct,
      expectedMovePct: plan?.target2 && entryPx
        ? Number(((((plan.target2 - entryPx) / entryPx) * 100)).toFixed(2))
        : null,
      archetype: scored.archetype,
      reasons: scored.reasons.slice(0, 6),
      risks: scored.risks.slice(0, 5),
      t1Bias: scored.t1Bias || null,
      plan: {
        ...plan,
        riskRewardToT2: rrRaw,
        riskRewardNet: rrNet,
        trigger: live.dayPct != null && live.dayPct >= MIN_DAY_MOVE && live.vol >= MIN_VOL
          ? 'Hold above open + volume ≥ threshold'
          : 'Wait volume + early lift confirmation',
      },
      entry: plan.entryLow,
      entryHigh: plan.entryHigh,
      stopLoss: plan.stopLoss,
      targets: { t1: plan.target1, t2: plan.target2, t3: plan.target3 },
      trigger: plan.trigger || 'Volume + early lift confirmation',
      riskReward: rrRaw,
      riskRewardNet: rrNet,
      managedPlan,
      management,
      positionSize: defaultPositionSize(entryPx, managedPlan?.stop2 || plan.stopLoss),
      carrySuggestion,
      invalidation: plan
        ? `Close / hold below ₹${plan.stopLoss} or volume fade + price back under open`
        : 'Structure break',
      aboveOpen: live.aboveOpen,
      sessionRangePos: live.sessionRangePos != null ? Number(live.sessionRangePos.toFixed(2)) : null,
      fundamentals: fund,
      fundScore: fq.score,
      fundReason: fq.reason,
      shareholding: fq.shareholding || fund?.shareholdingSummary || null,
      detectedAt: new Date().toISOString(),
      dataFreshness: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 40));
  }

  candidates.sort((a, b) => (b.earlyBoomScore || b.stormScore) - (a.earlyBoomScore || a.stormScore));
  // Prefer validated, earlier-stage, stronger historical sample — still no forced fills
  candidates.sort((a, b) => {
    const rank = (x) => ({ 'BUY NOW': 4, WAIT: 3, WATCHLIST: 2, 'NO TRADE': 0 }[x.action] || 1);
    return rank(b) - rank(a)
      || (b.earlyBoomScore || b.stormScore || 0) - (a.earlyBoomScore || a.stormScore || 0)
      || (b.historicalSampleSize || 0) - (a.historicalSampleSize || 0);
  });
  // Prefer HIGH only; sector cluster max 1; default max 1 pick/day discipline
  function takeDiversified(list, n) {
    const out = [];
    const sectors = new Set();
    for (const c of list) {
      const sec = (c.indexLabel || c.sector || 'UNK').toString();
      if (sectors.has(sec) && out.length >= 1) continue; // one per index/sector bucket
      sectors.add(sec);
      out.push(c);
      if (out.length >= n) break;
    }
    return out;
  }
  const high = candidates.filter((c) => c.t1Bias?.label === 'HIGH');
  const above = candidates.filter((c) => c.t1Bias?.label === 'ABOVE_AVG');
  const boardCap = Math.min(MAX_PICKS, Math.max(MAX_ACTIVE_PICKS_PER_DAY, 3));
  let picks = takeDiversified(high, boardCap);
  if (picks.length < boardCap && above.length) {
    const more = takeDiversified(above.filter((c) => !picks.find((p) => p.symbol === c.symbol)), boardCap - picks.length);
    picks = picks.concat(more);
  }
  // Soft MEDIUM only if still empty — mark lower confidence, never force
  if (!picks.length) {
    const soft = candidates.filter((c) =>
      c.action !== 'NO TRADE' && (c.earlyBoomScore || c.stormScore) >= MIN_STORM_SCORE + 5
    ).slice(0, 1);
    picks = soft;
  }
  // Never promote NO TRADE / incomplete into BUY NOW
  picks = picks.map((p) => {
    if (p.action === 'NO TRADE' || p.tradeValidation?.ok === false && p.action === 'BUY NOW') {
      return { ...p, action: p.tradeValidation?.action || 'WAIT' };
    }
    return p;
  });


  // Sticky log: jo pehle aa chuka hai aaj, list se silently gayab nahi
  let board = { active: [], rotated: [], tradeDate: null };
  try {
    const store = require('./morningStormStore');
    let prevStormSyms = [];
    try {
      const prevBoard = await store.getTodayBoard();
      prevStormSyms = (prevBoard?.active || []).map((a) => a.symbol);
    } catch (_) {}
    await store.upsertTodaysPicks(picks, {
      marketTrend: marketContext?.trend || marketContext?.todayDirection,
      windowPhase: win.phase,
    });
    try {
      const { notifyMorningStorm } = require('./mobileNotify');
      notifyMorningStorm(picks, { previousSymbols: prevStormSyms }).catch((e) => console.warn('[mobileNotify]', e.message));
    } catch (e) { console.warn('[mobileNotify] storm hook', e.message); }

    board = await store.getTodayBoard();
    try {
      const { ensureWatchesForPick } = require('./morningStormAlerts');
      const { todayIST } = store;
      const td = typeof todayIST === 'function' ? todayIST() : board.tradeDate;
      for (const p of picks) {
        if (p.managedPlan) await ensureWatchesForPick(p, td);
      }
    } catch (e) {
      console.warn('[morning-storm] watches', e.message);
    }
  } catch (e) {
    console.warn('[morning-storm] store', e.message);
  }

  // Merge: current picks + today's active from DB (first price preserved)
  const bySym = new Map(picks.map((p) => [p.symbol, { ...p, sticky: false }]));
  for (const a of board.active || []) {
    if (!bySym.has(a.symbol)) {
      bySym.set(a.symbol, {
        symbol: a.symbol,
        price: a.lastPrice ?? a.firstPrice,
        firstPrice: a.firstPrice,
        firstSeenAt: a.firstSeenAt,
        dayPct: a.dayPctAtFirst,
        stormScore: a.stormScore,
        t1Bias: a.t1BiasLabel ? { label: a.t1BiasLabel, up: a.t1BiasUp, down: 100 - (a.t1BiasUp || 70), note: 'Sticky — pehle suggest ho chuka' } : null,
        archetype: { key: a.archetype, label: a.archetype || 'Sticky', why: 'Aaj pehle aa chuka — scan se hata ke bhi board pe' },
        plan: a.plan,
        reasons: a.reasons || [],
        risks: a.risks || [],
        sticky: true,
        setupType: a.setupType,
        carrySuggestion: buildCarrySuggestion({
          price: a.lastPrice ?? a.firstPrice,
          plan: a.plan,
          dayPct: a.dayPctAtFirst,
          setupType: a.setupType,
          marketTrend: marketContext?.trend || marketContext?.todayDirection,
          vol: null,
          clockMins: clock.mins,
        }),
        managedPlan: a.managedPlan || buildManagedPlan(a.firstPrice),
        management: adviseManagement({
          entryPrice: a.firstPrice,
          price: a.lastPrice ?? a.firstPrice,
          userStance: a.userStance || 'open',
          t1Hit: a.t1Hit,
          t2Hit: a.t2Hit,
          t3Hit: a.t3Hit,
          marketTrend: marketContext?.trend || marketContext?.todayDirection,
          clockMins: clock.mins,
        }),
        userStance: a.userStance || 'open',
      });
    } else {
      const cur = bySym.get(a.symbol);
      cur.firstPrice = a.firstPrice;
      cur.firstSeenAt = a.firstSeenAt;
      cur.sticky = true;
      if (!cur.carrySuggestion && cur.plan) {
        cur.carrySuggestion = buildCarrySuggestion({
          price: cur.price,
          plan: cur.plan,
          dayPct: cur.dayPct,
          setupType: cur.setupType,
          marketTrend: marketContext?.trend || marketContext?.todayDirection,
          vol: cur.volSpike,
          clockMins: clock.mins,
        });
      }
    }
  }
  picks = [...bySym.values()].slice(0, Math.max(MAX_PICKS, board.active?.length || 0)).slice(0, 4);

  if (jobId) {
    try {
      endJob(jobId, picks.length ? `${picks.length} morning candidate(s)` : 'No storm-quality name');
    } catch (_) {}
  }

  let trackRecord = null;
  try {
    trackRecord = await require('./morningStormStore').getTrackRecord();
  } catch (_) {}

  return {
    ok: true,
    window: win,
    windowPhase: win?.phase || win?.label || null,
    clockIST: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
    marketTrend: marketContext?.trend || marketContext?.todayDirection || null,
    marketContext,
    scannedAt,
    trackRecord,
    prefilterCount: pre.length,
    candidateCount: candidates.length,
    board,
    picks,
    nearMiss: candidates.slice(MAX_PICKS, MAX_PICKS + 3).map((c) => ({
      symbol: c.symbol,
      stormScore: c.stormScore,
      dayPct: c.dayPct,
      reason: (c.risks[0] || c.reasons[0] || 'Rank below top'),
    })),
    rotatedToday: (board.rotated || []).map((r) => ({
      symbol: r.symbol,
      firstPrice: r.firstPrice,
      firstSeenAt: r.firstSeenAt,
      lastPrice: r.lastPrice,
      stormScore: r.stormScore,
      note: 'Pehle suggest hua, baad me rank bahar — pehli price yaad rakho',
    })),
    metricDefinitions: {
      signalScore: '0–100 confluence score for early boom setup (technical+volume+timing). NOT a win probability.',
      signalStrength: 'HIGH/MED/LOW from reason/risk count + volume + relative strength — qualitative strength only.',
      historicalConfidence: 'Sample adequacy (INSUFFICIENT/LOW/MED/HIGH) from similar past signals on THIS stock.',
      historicalHitRate: 'Past analogue hit rate when sample exists — not a forecast of today.',
      signalStage: 'ACCUMULATION | SETUP_FORMING | TRIGGER_NEAR | CONFIRMED_BREAKOUT | EXTENDED | INVALIDATED',
    },
    honesty: [
      'EARLY BOOM: pehle volume + early lift; already +3% extended chase kam.',
      'HIGH confidence rare — empty board = NO HIGH-CONFIDENCE OPPORTUNITY (sit out OK).',
      'T1 bias historical confluence se — guaranteed 70/30 / +5% claim nahi.',
      'Har pick pe entry → MFE/MAE → target/SL track hota hai calibration ke liye.',
      'Sample <20 pe probability soft; Track Record me n dikhao.',
      'Signal Score ≠ probability. BUY NOW only after validation (price, volume, plan, R:R, stage).',
      'Overnight: HOLD / EXIT / PARTIAL / WAIT — gap risk alag.',
    ],
    asOf: new Date().toISOString(),
  };
}

module.exports = { runMorningStormScan, MAX_PICKS };
