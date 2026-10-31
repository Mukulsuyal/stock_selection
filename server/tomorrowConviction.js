// Post-close "Tomorrow High-Conviction" — max 1–2 names for next session.
// + gap entry plan, morning re-check, outcome tracking, soft learning.
// Educational only — not guaranteed profit / not true probability.
const { getCombinedUniverseScan } = require('./universeScan');
const { getMarketRegime } = require('./marketRegimeDetector');
const { buildNiftyDeepDive } = require('./niftyDeepDive');
const { buildMarketPlaybook } = require('./marketPlaybook');
const {
  computeScoreBreakdown,
  assessPickQuality,
} = require('./stockAnalysisEngine');
const marketData = require('./marketData');
const { isMongoConfigured } = require('./mongo');
const mongoose = require('mongoose');

const CACHE_MS = 20 * 60 * 1000;
let memCache = { at: 0, data: null };

let TomorrowPack;
let TomorrowPickRow;

function packModel() {
  if (TomorrowPack) return TomorrowPack;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    asOfDate: { type: String, index: true, unique: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  }, { collection: 'tomorrow_conviction_picks' });
  TomorrowPack = mongoose.models.TomorrowConvictionPick
    || mongoose.model('TomorrowConvictionPick', schema);
  return TomorrowPack;
}

function pickRowModel() {
  if (TomorrowPickRow) return TomorrowPickRow;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    asOfDate: { type: String, index: true },
    symbol: { type: String, index: true },
    eveningPrice: Number,
    eveningPlan: mongoose.Schema.Types.Mixed,
    gapPlan: mongoose.Schema.Types.Mixed,
    softOdds: mongoose.Schema.Types.Mixed,
    convictionScore: Number,
    eveningVerdict: String, // take_watch | avoid
    morningStatus: String, // pending | take | wait | avoid | cancelled
    morningNote: String,
    morningCheckedAt: Date,
    morningPrice: Number,
    // outcomes (filled by EOD/resolution job)
    nextDayOpen: Number,
    nextDayHigh: Number,
    nextDayLow: Number,
    nextDayClose: Number,
    hitTarget: Boolean,
    hitStopLoss: Boolean,
    maxUpPct: Number,
    maxDownPct: Number,
    resolved: { type: Boolean, default: false },
    resolvedAt: Date,
    outcomeLabel: String, // target_hit | sl_hit | neither | morning_cancelled
    holdingGuidance: String, // exit | hold_few_days | hold_upto_7d
    createdAt: { type: Date, default: Date.now },
  }, { collection: 'tomorrow_conviction_rows' });
  schema.index({ asOfDate: 1, symbol: 1 }, { unique: true });
  TomorrowPickRow = mongoose.models.TomorrowConvictionRow
    || mongoose.model('TomorrowConvictionRow', schema);
  return TomorrowPickRow;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function istTodayYmd() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (ty) => parts.find((x) => x.type === ty)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Position size: default ₹10,000. Increase only when conviction is clearly high
 * and market posture is not defensive. Shows qty, capital, profit-if-target, loss-if-SL.
 */
function buildPositionSize(r, convictionScore, posture) {
  const BASE = 10000;
  let capital = BASE;
  let sizeLabel = 'fixed_min_10k';
  let increaseReason = null;

  const rr = r.tradePlan?.riskRewardRatio;
  const q = r.quality?.score ?? r.quality?.label;
  const highQ = (typeof q === 'number' && q >= 6) || (typeof q === 'string' && /high|strong/i.test(q));

  if (posture === 'defensive') {
    capital = BASE;
    sizeLabel = 'fixed_min_10k_defensive';
    increaseReason = 'Market defensive — size ₹10k pe fix; mat badhao.';
  } else if (convictionScore >= 85 && rr != null && rr >= 2.5) {
    capital = 20000;
    sizeLabel = 'high_confidence_20k';
    increaseReason = 'Bahut high conviction + strong R:R — optional ₹20k (abhi bhi risk manage).';
  } else if (convictionScore >= 78 && rr != null && rr >= 2.2) {
    capital = 15000;
    sizeLabel = 'good_confidence_15k';
    increaseReason = 'Good conviction — optional ₹15k. Default min ₹10k bhi theek.';
  } else {
    capital = BASE;
    sizeLabel = 'fixed_min_10k';
    increaseReason = 'Normal confidence — minimum ₹10,000 hi lagaao; size mat badhao.';
  }

  const price = r.price;
  if (price == null || price <= 0) {
    return {
      suggestedCapital: capital,
      minCapital: BASE,
      sizeLabel,
      increaseReason,
      qty: null,
      actualCapital: null,
      profitIfTarget: null,
      lossIfStop: null,
      note: 'Price missing — capital suggest only.',
    };
  }

  const qty = Math.max(1, Math.floor(capital / price));
  const actualCapital = Number((qty * price).toFixed(2));
  const sl = r.tradePlan?.stopLoss ?? r.gapPlan?.stopLoss;
  const tgt = r.tradePlan?.target;
  const lossIfStop = sl != null ? Number(((price - sl) * qty).toFixed(2)) : null;
  const profitIfTarget = tgt != null ? Number(((tgt - price) * qty).toFixed(2)) : null;
  const lossPct = sl != null ? Number((((price - sl) / price) * 100).toFixed(2)) : null;
  const profitPct = tgt != null ? Number((((tgt - price) / price) * 100).toFixed(2)) : null;

  return {
    minCapital: BASE,
    suggestedCapital: capital,
    sizeLabel,
    increaseReason,
    qty,
    actualCapital,
    entryRef: Number(Number(price).toFixed(2)),
    stopLoss: sl != null ? Number(Number(sl).toFixed(2)) : null,
    target: tgt != null ? Number(Number(tgt).toFixed(2)) : null,
    lossIfStop,
    profitIfTarget,
    lossPctOfEntry: lossPct,
    profitPctOfEntry: profitPct,
    note:
      lossIfStop != null && profitIfTarget != null
        ? `₹${actualCapital.toLocaleString('en-IN')} (~${qty} shares): target pe ~₹${profitIfTarget.toLocaleString('en-IN')} profit · SL pe ~₹${Math.abs(lossIfStop).toLocaleString('en-IN')} loss. Educational size only.`
        : `Suggested capital ₹${capital.toLocaleString('en-IN')} (min ₹10k).`,
  };
}



function saneDayPct(r) {
  // Prefer analysis oneDay; reject absurd Yahoo pChange spikes (e.g. 84%)
  const d = r.periodReturns?.oneDay;
  if (d != null && Math.abs(d) < 25) return Number(Number(d).toFixed(2));
  if (r.pChange != null && Math.abs(r.pChange) < 20) return Number(Number(r.pChange).toFixed(2));
  return null;
}

function buildGapPlan(r) {
  const price = r.price;
  const plan = r.tradePlan || {};
  const atr = r.indicators?.atr14 ?? (price * 0.015);
  const sl = plan.stopLoss;
  const tgt = plan.target;
  const entryLow = plan.entryLow ?? (price * 0.995);
  const entryHigh = plan.entryHigh ?? (price * 1.008);

  return {
    referenceClose: price,
    // Gap UP: don't chase open; wait pullback into zone or skip if too extended
    gapUp: {
      label: 'Agar kal gap UP khule',
      takeIf: `Open entry zone ke andar ya thoda upar ho, lekin open > close + ${(atr * 1.2 / price * 100).toFixed(1)}% (bada gap) ho to pehle 15–30 min mat lo — pullback ka wait.`,
      buyZone: {
        from: Number(entryLow.toFixed(2)),
        to: Number(Math.max(entryHigh, price + atr * 0.3).toFixed(2)),
      },
      skipIfOpenAbove: Number((price + atr * 1.5).toFixed(2)),
      note: 'Bada gap-up chase mat karo; zone me wapas aaye tab hi size chhota.',
    },
    gapDown: {
      label: 'Agar kal gap DOWN khule',
      takeIf: 'Open support ke paas hold kare aur pehle 15–30 min me naya low na bane.',
      buyZone: {
        from: Number(Math.min(entryLow, price - atr * 0.8).toFixed(2)),
        to: Number(entryLow.toFixed(2)),
      },
      hardSkipBelow: sl != null ? Number(sl.toFixed(2)) : Number((price - atr * 1.8).toFixed(2)),
      note: 'Gap-down pe average mat karo. SL ke neeche open = skip / re-plan.',
    },
    timeWindow: {
      avoidFirstMinutes: 15,
      preferredWindow: '10:00 – 14:30 IST (pehle 15 min noise skip; last 30 min only if already in plan)',
      lastEntryBefore: '14:45 IST',
      note: 'Opening auction noise high — confirmation ke baad entry better.',
    },
    stopLoss: sl != null ? Number(Number(sl).toFixed(2)) : null,
    stopLossRule: sl != null
      ? `SL ~${Number(sl).toFixed(2)} (close ke neeche ya swing low). Intraday SL hit → exit, hope nahi.`
      : 'SL trade plan se set karo — bina SL long mat lo.',
    targets: {
      t1: tgt != null ? Number(Number(tgt).toFixed(2)) : null,
      t2: plan.target2 != null ? Number(Number(plan.target2).toFixed(2)) : (tgt != null ? Number((tgt + (tgt - price) * 0.5).toFixed(2)) : null),
    },
  };
}

/**
 * Soft path odds from ATR / structure — LABELS only, not calibrated probability.
 */
function softMoveOdds(r) {
  const price = r.price;
  const atr = r.indicators?.atr14 ?? price * 0.015;
  const atrPct = (atr / price) * 100;
  const rs = r.relativeStrength?.score ?? r.relativeStrength;
  const rsi = r.indicators?.rsi14 ?? r.indicators?.rsi;
  const setup = r.setup?.type;

  // Base difficulty: larger move needs more "room" vs ATR
  function upsideChance(movePct) {
    let base = clamp(55 - movePct * 6 + (atrPct > movePct ? 8 : -5), 8, 62);
    if (typeof rs === 'number' && rs >= 55) base += 6;
    if (setup === 'reversal') base += 4;
    if (rsi != null && rsi >= 30 && rsi <= 50) base += 4;
    if (rsi != null && rsi > 65) base -= 8;
    return clamp(Math.round(base), 5, 70);
  }
  function downsideChance(movePct) {
    let base = clamp(25 + movePct * 4, 10, 55);
    if (typeof rs === 'number' && rs >= 60) base -= 8;
    if (setup === 'reversal') base -= 3;
    return clamp(Math.round(base), 8, 60);
  }

  return {
    label: 'Soft path odds (ATR + structure heuristic) — NOT calibrated win probability',
    upside: {
      atLeast2pct: upsideChance(2),
      atLeast5pct: upsideChance(5),
      atLeast10pct: upsideChance(10),
    },
    downside: {
      atLeast2pctDown: downsideChance(2),
      atLeast5pctDown: downsideChance(5),
    },
    note: 'Ye % system confidence-style lean hain, future guarantee nahi. Position size iske hisaab se chhota rakho.',
  };
}

function buildReasons(r, ctx) {
  const out = [];
  if (ctx.rr >= 2) out.push(`R:R ~1:${ctx.rr.toFixed(1)} — risk defined vs target`);
  if (ctx.setup === 'reversal') out.push('Reversal/bounce structure near support');
  if (ctx.setup === 'momentum') out.push('Momentum structure (index stress me size chhota)');
  if (typeof ctx.rs === 'number' && ctx.rs >= 55) out.push('Relative strength vs market');
  if (ctx.dayPct != null && ctx.niftyDayPct != null && ctx.dayPct > ctx.niftyDayPct + 0.5) {
    out.push('Held up better than Nifty today');
  }
  if (ctx.rsi != null && ctx.rsi <= 45) out.push(`RSI ~${Math.round(ctx.rsi)} — not stretched up`);
  if (ctx.vs != null && ctx.vs >= 1) out.push('Volume participation OK');
  if (ctx.quality?.label) out.push(`Quality: ${ctx.quality.label}`);
  return out;
}

function scenarioMatrix(r, niftyDayPct, posture) {
  const rs = r.relativeStrength?.score ?? r.relativeStrength;
  const strongRs = typeof rs === 'number' && rs >= 55;
  const reversal = r.setup?.type === 'reversal';
  return {
    if_market_up: {
      label: 'Agar kal market up',
      edge: strongRs || reversal ? 'favourable' : 'ok',
      note: strongRs
        ? 'RS strong — up-day pe saath chalnes ki better technical case'
        : 'Market up me longs easier; phir bhi SL respect',
    },
    if_market_down: {
      label: 'Agar kal market down',
      edge: strongRs && reversal ? 'relative_hold' : (strongRs ? 'cushion' : 'fragile'),
      note: strongRs
        ? 'RS wale aksar index se kam girte hain — SL phir bhi zaroori'
        : 'Down day me koi long safe nahi; size chhota + SL',
    },
    if_market_flat: {
      label: 'Agar kal sideways',
      edge: reversal ? 'level_play' : 'ok',
      note: 'Support-resistance ke beech range / mean-reversion better than blind momentum',
    },
    postureNote: posture ? `Aaj posture: ${posture}` : null,
  };
}

function convictionScore(r, marketContext, sectorContext, niftyDayPct) {
  if (r.error || r.price == null) return null;
  const dayPct = saneDayPct(r);
  const breakdown = computeScoreBreakdown(r, marketContext, sectorContext);
  const quality = assessPickQuality(r, marketContext);
  const plan = r.tradePlan || {};
  const rr = plan.riskRewardRatio;
  const vs = r.indicators?.volSpike ?? r.volumeRatio ?? null;
  const rsi = r.indicators?.rsi14 ?? r.indicators?.rsi ?? null;
  const setup = r.setup?.type || null;
  const rs = r.relativeStrength?.score ?? r.relativeStrength ?? null;

  if (rr == null || rr < 1.8) return null;
  if (plan.stopLoss == null || plan.target == null) return null;
  if (rsi != null && rsi >= 72) return null;
  if (vs != null && vs < 0.55) return null;
  if (quality.score != null && quality.score < 4) return null;

  let s = breakdown.overall || 0;
  if (typeof rs === 'number') {
    if (rs >= 60) s += 8;
    else if (rs >= 50) s += 4;
    else if (rs < 40) s -= 6;
  }
  if (dayPct != null && niftyDayPct != null) {
    const rel = dayPct - niftyDayPct;
    if (rel >= 1) s += 6;
    else if (rel >= 0.3) s += 3;
    else if (rel <= -1.5) s -= 5;
  }
  if (setup === 'reversal') s += 5;
  else if (setup === 'momentum' && (niftyDayPct == null || niftyDayPct > -0.8)) s += 2;
  else if (setup === 'momentum' && niftyDayPct != null && niftyDayPct <= -1) s -= 3;
  if (rr >= 2.5) s += 6;
  else if (rr >= 2) s += 3;
  if (r.buyZone?.inZone || r.zoneState?.nearSupport) s += 5;
  if (vs != null && vs >= 1.1 && vs <= 3.5) s += 3;
  if (rsi != null && rsi >= 38 && rsi <= 58) s += 4;
  else if (rsi != null && rsi >= 30 && rsi < 38) s += 2;
  else if (rsi != null && rsi > 65) s -= 3;
  const v = (r.verdict || '').toLowerCase();
  if (v.includes('bull')) s += 2;
  if (v.includes('strong sell') || v.includes('bear')) s -= 8;
  s = clamp(s, 0, 100);
  if (s < 62) return null;

  return {
    score: Number(s.toFixed(1)),
    breakdown,
    quality,
    rr,
    setup,
    dayPct,
    reasons: buildReasons(r, { rs, niftyDayPct, rr, rsi, vs, setup, quality, dayPct }),
  };
}

async function persistPickRows(asOfDate, picks) {
  const M = pickRowModel();
  if (!M) return;
  for (const p of picks) {
    await M.updateOne(
      { asOfDate, symbol: p.symbol },
      {
        $set: {
          eveningPrice: p.price,
          eveningPlan: p.tradePlan,
          gapPlan: p.gapPlan,
          softOdds: p.softOdds,
          positionSize: p.positionSize,
          convictionScore: p.convictionScore,
          eveningVerdict: 'take_watch',
          morningStatus: 'pending',
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  }
}

async function runTomorrowConviction({ force = false } = {}) {
  if (!force && memCache.data && Date.now() - memCache.at < CACHE_MS) {
    return { ...memCache.data, fromCache: true };
  }

  const [scan, regime, deepDive] = await Promise.all([
    getCombinedUniverseScan({ forceRefresh: force }),
    getMarketRegime().catch(() => null),
    buildNiftyDeepDive('^NSEI').catch(() => null),
  ]);
  const results = scan?.results || [];
  const marketContext = {
    ...(scan?.marketContext || {}),
    learningRegime: regime?.learningRegime || scan?.marketContext?.learningRegime,
    oneDayChangePct: deepDive?.dayPct ?? regime?.nifty?.oneDayChangePct,
  };
  const niftyDayPct = marketContext.oneDayChangePct ?? null;
  const playbook = buildMarketPlaybook(deepDive, regime);

  const scored = [];
  for (const r of results) {
    const c = convictionScore(r, marketContext, r.sectorContext || null, niftyDayPct);
    if (!c) continue;
    const gapPlan = buildGapPlan(r);
    const softOdds = softMoveOdds(r);
    const positionSize = buildPositionSize(
      { ...r, gapPlan, quality: c.quality },
      c.score,
      playbook.posture
    );
    scored.push({
      symbol: r.symbol,
      price: r.price,
      verdict: r.verdict,
      pChange: c.dayPct,
      convictionScore: c.score,
      overallScore: c.breakdown.overall,
      riskRewardRatio: c.rr,
      setup: c.setup,
      reasons: c.reasons,
      tradePlan: r.tradePlan,
      gapPlan,
      softOdds,
      positionSize,
      scenarios: scenarioMatrix(r, niftyDayPct, playbook.posture),
      quality: c.quality,
      relativeStrength: r.relativeStrength,
      sector: r.sector || r.sectorContext?.sector || null,
      eveningGuidance: {
        action: 'WATCHLIST_FOR_TOMORROW',
        summary: 'Aaj band ke baad plan lock. Kal open pe gap plan follow karo; pehle 15 min skip.',
        stopLoss: gapPlan.stopLoss,
        stopLossRule: gapPlan.stopLossRule,
        timeWindow: gapPlan.timeWindow,
      },
    });
  }
  scored.sort((a, b) => b.convictionScore - a.convictionScore);

  const picks = [];
  for (const row of scored) {
    if (picks.length >= 2) break;
    if (picks.length === 1 && row.convictionScore < 68) break;
    if (row.convictionScore < 64) break;
    picks.push(row);
  }

  const asOfDate = istTodayYmd();
  const data = {
    asOf: new Date().toISOString(),
    asOfDate,
    forSession: 'next_trading_day',
    pickCount: picks.length,
    picks,
    market: {
      niftyPrice: deepDive?.price ?? null,
      niftyDayPct,
      learningRegime: regime?.learningRegime || null,
      posture: playbook.posture,
      oneLiner: playbook.oneLiner,
      nearestSupport: deepDive?.supportLevels?.[0]?.level ?? null,
    },
    scanned: results.length,
    candidatesPassedGates: scored.length,
    note:
      picks.length === 0
        ? 'Aaj koi naam strict next-day conviction gate clear nahi karta — 0 picks better than forced weak trade.'
        : 'Max 1–2. Gap plan + soft odds + SL aaj lock. Kal morning “Morning re-check” se TAKE/WAIT/AVOID update. NOT guaranteed.',
    disclaimer: 'Educational only. Soft odds ≠ calibrated probability. Not investment advice.',
  };

  memCache = { at: Date.now(), data };
  try {
    const Pack = packModel();
    if (Pack) {
      await Pack.updateOne(
        { asOfDate },
        { $set: { payload: data, createdAt: new Date() } },
        { upsert: true }
      );
    }
    await persistPickRows(asOfDate, picks);
  } catch (err) {
    console.warn('[tomorrow-conviction] persist:', err.message);
  }

  return { ...data, fromCache: false };
}

async function getLatestTomorrowConviction() {
  if (memCache.data) return { ...memCache.data, fromCache: true };
  try {
    const Pack = packModel();
    if (Pack) {
      const row = await Pack.findOne({}).sort({ asOfDate: -1 }).lean();
      if (row?.payload) return { ...row.payload, fromCache: true, fromDb: true };
    }
  } catch (_) {}
  return runTomorrowConviction({ force: false });
}

/**
 * Morning / live re-check of last evening's picks.
 */
async function morningRecheck() {
  const Pack = packModel();
  const today = istTodayYmd();
  // Morning re-check is ONLY for a prior evening's pack (asOfDate < today).
  // Aaj shaam ke naye picks pe ye nahi chalega.
  let pack = null;
  if (Pack) {
    const row = await Pack.findOne({ asOfDate: { $lt: today } }).sort({ asOfDate: -1 }).lean();
    pack = row?.payload || null;
  }
  if (!pack && memCache.data?.asOfDate && memCache.data.asOfDate < today) {
    pack = memCache.data;
  }
  if (!pack?.picks?.length) {
    return {
      ok: false,
      message: 'Kal morning re-check sirf pichhle trading day ke evening picks pe. Aaj shaam ke naye names ke liye ye button mat use karo — kal market open ke baad use karo.',
      today,
    };
  }
  if (pack.asOfDate >= today) {
    return {
      ok: false,
      message: `Ye pack aaj (${pack.asOfDate}) ka hai — morning re-check kal open ke baad lagega.`,
      today,
      asOfDate: pack.asOfDate,
    };
  }

  const regime = await getMarketRegime().catch(() => null);
  const niftyDay = regime?.nifty?.oneDayChangePct ?? null;
  const live = [];

  for (const p of pack.picks) {
    let quote = null;
    try {
      quote = await marketData.getQuote(p.symbol);
    } catch (_) {}
    const last = quote?.lastPrice ?? null;
    const dayPct = quote?.pChange != null && Math.abs(quote.pChange) < 25
      ? Number(Number(quote.pChange).toFixed(2))
      : null;
    const gapPlan = p.gapPlan || {};
    const sl = gapPlan.stopLoss ?? p.tradePlan?.stopLoss;
    const ref = p.price;
    const openish = last; // approx; true open may differ

    let status = 'wait';
    let note = '';
    let timeHint = gapPlan.timeWindow?.preferredWindow || '10:00 – 14:30 IST';

    if (last == null) {
      status = 'wait';
      note = 'Live price nahi mili — thodi der baad dubara check.';
    } else if (sl != null && last <= sl) {
      status = 'avoid';
      note = `Price SL (~${sl}) ke neeche/near — aaj long skip.`;
    } else if (gapPlan.gapUp?.skipIfOpenAbove != null && last >= gapPlan.gapUp.skipIfOpenAbove) {
      status = 'avoid';
      note = `Bahut upar extend (~${last}) — chase mat karo, pullback ka wait ya skip.`;
    } else if (gapPlan.gapDown?.hardSkipBelow != null && last <= gapPlan.gapDown.hardSkipBelow) {
      status = 'avoid';
      note = 'Gap-down structure toot gaya — skip.';
    } else {
      const zoneFrom = gapPlan.gapUp?.buyZone?.from ?? p.tradePlan?.entryLow ?? ref * 0.99;
      const zoneTo = gapPlan.gapUp?.buyZone?.to ?? p.tradePlan?.entryHigh ?? ref * 1.01;
      if (last >= zoneFrom * 0.98 && last <= zoneTo * 1.02) {
        status = 'take';
        note = `Price entry zone ke paas (~${zoneFrom}–${zoneTo}). Size chhota, SL ${sl ?? 'set'} pehle.`;
      } else if (last > zoneTo) {
        status = 'wait';
        note = 'Zone se upar — pullback wait ya skip. Chase nahi.';
      } else {
        status = 'wait';
        note = 'Zone se neeche — support hold + volume dekh kar hi socho; force nahi.';
      }
    }

    // Refresh soft odds roughly with live day move
    const softOdds = { ...(p.softOdds || {}) };
    if (dayPct != null && softOdds.upside) {
      if (dayPct <= -2) {
        softOdds.upside = {
          atLeast2pct: clamp((softOdds.upside.atLeast2pct || 40) - 8, 5, 70),
          atLeast5pct: clamp((softOdds.upside.atLeast5pct || 25) - 6, 5, 70),
          atLeast10pct: clamp((softOdds.upside.atLeast10pct || 12) - 4, 5, 70),
        };
        softOdds.downside = {
          atLeast2pctDown: clamp((softOdds.downside?.atLeast2pctDown || 30) + 8, 8, 65),
          atLeast5pctDown: clamp((softOdds.downside?.atLeast5pctDown || 15) + 5, 8, 65),
        };
      }
    }

    const row = {
      symbol: p.symbol,
      eveningPrice: ref,
      livePrice: last,
      liveDayPct: dayPct,
      status,
      note,
      timeHint,
      stopLoss: sl,
      gapPlan,
      softOdds,
      tradePlan: p.tradePlan,
      convictionScore: p.convictionScore,
      niftyLivePct: niftyDay,
    };
    live.push(row);

    try {
      const M = pickRowModel();
      if (M) {
        await M.updateOne(
          { asOfDate: pack.asOfDate, symbol: p.symbol },
          {
            $set: {
              morningStatus: status,
              morningNote: note,
              morningCheckedAt: new Date(),
              morningPrice: last,
            },
          }
        );
      }
    } catch (_) {}
  }

  return {
    ok: true,
    asOfDate: pack.asOfDate,
    checkedAt: new Date().toISOString(),
    marketLive: { niftyDayPct: niftyDay, regime: regime?.learningRegime },
    picks: live,
    disclaimer: 'Morning re-check is a risk filter update — not a profit guarantee.',
  };
}

/**
 * Resolve previous rows with next-day OHLC (call from EOD or on demand).
 */
async function resolveTomorrowOutcomes() {
  const M = pickRowModel();
  if (!M) return { ok: false, reason: 'no_mongo' };
  const pending = await M.find({ resolved: false }).sort({ asOfDate: -1 }).limit(40).lean();
  let updated = 0;
  for (const row of pending) {
    try {
      // Need at least next calendar session after asOfDate
      const hist = await marketData.getHistorical(row.symbol, 15);
      if (!hist?.length) continue;
      const after = hist.filter((c) => c.date > row.asOfDate);
      if (!after.length) continue;
      const d1 = after[0];
      const maxUp = row.eveningPrice
        ? ((d1.high - row.eveningPrice) / row.eveningPrice) * 100
        : null;
      const maxDown = row.eveningPrice
        ? ((d1.low - row.eveningPrice) / row.eveningPrice) * 100
        : null;
      const tgt = row.eveningPlan?.target;
      const sl = row.eveningPlan?.stopLoss ?? row.gapPlan?.stopLoss;
      const hitTarget = tgt != null && d1.high >= tgt;
      const hitStopLoss = sl != null && d1.low <= sl;
      let outcomeLabel = 'neither';
      if (row.morningStatus === 'avoid' || row.morningStatus === 'cancelled') {
        outcomeLabel = 'morning_cancelled';
      } else if (hitStopLoss && !hitTarget) outcomeLabel = 'sl_hit';
      else if (hitTarget) outcomeLabel = 'target_hit';
      else outcomeLabel = 'neither';

      let holdingGuidance = 'exit';
      if (outcomeLabel === 'target_hit') holdingGuidance = 'exit';
      else if (outcomeLabel === 'sl_hit') holdingGuidance = 'exit';
      else if (maxDown != null && maxDown > -2 && maxUp != null && maxUp < 3) {
        holdingGuidance = 'hold_few_days';
      } else if (maxDown != null && maxDown > -3) {
        holdingGuidance = 'hold_upto_7d';
      }

      await M.updateOne(
        { _id: row._id },
        {
          $set: {
            nextDayOpen: d1.open,
            nextDayHigh: d1.high,
            nextDayLow: d1.low,
            nextDayClose: d1.close,
            hitTarget,
            hitStopLoss,
            maxUpPct: maxUp != null ? Number(maxUp.toFixed(2)) : null,
            maxDownPct: maxDown != null ? Number(maxDown.toFixed(2)) : null,
            resolved: true,
            resolvedAt: new Date(),
            outcomeLabel,
            holdingGuidance,
          },
        }
      );
      updated++;
    } catch (_) {}
  }
  return { ok: true, updated };
}

async function getTomorrowLearningStats() {
  const M = pickRowModel();
  if (!M) {
    return {
      ready: false,
      message: 'Mongo nahi — learning stats baad me.',
      sample: 0,
    };
  }
  const rows = await M.find({}).sort({ asOfDate: -1 }).limit(200).lean();
  const resolved = rows.filter((r) => r.resolved);
  const sample = resolved.length;
  if (sample < 5) {
    return {
      ready: false,
      message: `Abhi sirf ${sample} resolved — learning tab strong hogi jab ~20+ next-day outcomes milen.`,
      sample,
      totalLogged: rows.length,
      morningAvoidCount: rows.filter((r) => r.morningStatus === 'avoid').length,
    };
  }
  const targetHits = resolved.filter((r) => r.outcomeLabel === 'target_hit').length;
  const slHits = resolved.filter((r) => r.outcomeLabel === 'sl_hit').length;
  const cancelled = resolved.filter((r) => r.outcomeLabel === 'morning_cancelled').length;
  const morningAvoid = rows.filter((r) => r.morningStatus === 'avoid').length;
  const avgMaxUp = resolved.reduce((s, r) => s + (r.maxUpPct || 0), 0) / sample;
  const avgMaxDown = resolved.reduce((s, r) => s + (r.maxDownPct || 0), 0) / sample;

  return {
    ready: sample >= 20,
    sample,
    totalLogged: rows.length,
    targetHitPct: Number(((targetHits / sample) * 100).toFixed(1)),
    slHitPct: Number(((slHits / sample) * 100).toFixed(1)),
    neitherPct: Number((((sample - targetHits - slHits - cancelled) / sample) * 100).toFixed(1)),
    morningCancelledPct: Number(((cancelled / sample) * 100).toFixed(1)),
    morningAvoidCount: morningAvoid,
    avgMaxUpPctNextDay: Number(avgMaxUp.toFixed(2)),
    avgMaxDownPctNextDay: Number(avgMaxDown.toFixed(2)),
    message: sample >= 20
      ? 'Sample enough for soft feedback — still not a future profit guarantee.'
      : `Sample ${sample}/20 — stats provisional.`,
  };
}

async function maybeRunTomorrowConvictionIfDue() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      weekday: 'short',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const wd = get('weekday');
    if (wd === 'Sat' || wd === 'Sun') return { skipped: true, reason: 'weekend' };
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    const afterClose = hour > 17 || (hour === 17 && minute >= 35);
    if (!afterClose) return { skipped: true, reason: 'before_1735_ist', hour, minute };
    const asOfDate = `${get('year')}-${get('month')}-${get('day')}`;
    const Pack = packModel();
    if (Pack) {
      const existing = await Pack.findOne({ asOfDate }).lean();
      if (existing?.payload?.picks != null) {
        memCache = { at: Date.now(), data: existing.payload };
        return { skipped: true, reason: 'already_have_today', asOfDate, pickCount: existing.payload.pickCount };
      }
    }
    try {
      const { isTradingDay } = require('./tradingCalendar');
      if (typeof isTradingDay === 'function') {
        const ok = await isTradingDay(new Date(`${asOfDate}T12:00:00+05:30`));
        if (ok === false) return { skipped: true, reason: 'holiday', asOfDate };
      }
    } catch (_) {}
    console.log('[tomorrow-conviction] startup after 17:35 IST — running scan for', asOfDate);
    const data = await runTomorrowConviction({ force: true });
    return { skipped: false, asOfDate, pickCount: data.pickCount };
  } catch (err) {
    console.error('[tomorrow-conviction] maybeRun failed:', err.message);
    return { skipped: true, reason: 'error', error: err.message };
  }
}


/**
 * Multi-day hold/exit coach after evening pick.
 * Uses live quote + evening plan + path since entry reference.
 */
function holdCoachForRow(row, quote, hist) {
  const ref = row.eveningPrice;
  const last = quote?.lastPrice ?? null;
  const dayPct = quote?.pChange != null && Math.abs(quote.pChange) < 25
    ? Number(Number(quote.pChange).toFixed(2))
    : null;
  const sl = row.gapPlan?.stopLoss ?? row.eveningPlan?.stopLoss ?? null;
  const tgt = row.eveningPlan?.target ?? null;
  const tgt2 = row.eveningPlan?.target2 ?? null;
  const asOf = row.asOfDate;

  let sessionsHeld = null;
  if (hist?.length && asOf) {
    sessionsHeld = hist.filter((c) => c.date > asOf).length;
  }

  // Path since evening reference
  let fromEntryPct = null;
  let maxUpPct = row.maxUpPct ?? null;
  let maxDownPct = row.maxDownPct ?? null;
  if (ref != null && hist?.length) {
    const after = hist.filter((c) => c.date > asOf);
    if (after.length) {
      let hi = -Infinity, lo = Infinity;
      for (const c of after) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
      }
      if (last != null) {
        if (last > hi) hi = last;
        if (last < lo) lo = last;
      }
      maxUpPct = Number((((hi - ref) / ref) * 100).toFixed(2));
      maxDownPct = Number((((lo - ref) / ref) * 100).toFixed(2));
    }
  }
  if (ref != null && last != null) {
    fromEntryPct = Number((((last - ref) / ref) * 100).toFixed(2));
  }

  const hitT = tgt != null && last != null && last >= tgt;
  const hitS = sl != null && last != null && last <= sl;
  // also check hist highs/lows
  if (tgt != null && maxUpPct != null && ref != null) {
    const impliedHigh = ref * (1 + maxUpPct / 100);
    if (impliedHigh >= tgt) { /* touched */ }
  }

  let action = 'HOLD'; // HOLD | EXIT | TRIM | WAIT
  let holdDaysHint = null;
  let reasons = [];
  let recoveryNote = null;

  if (row.morningStatus === 'avoid' && sessionsHeld != null && sessionsHeld <= 1 && last != null && ref != null && last < ref * 0.99) {
    action = 'EXIT';
    reasons.push('Morning pe already AVOID tha aur price weak hai — naya long force mat karo / open position cut consider.');
  } else if (hitS || (sl != null && last != null && last <= sl)) {
    action = 'EXIT';
    reasons.push(`SL zone (~${sl}) touch/breach — plan ke hisaab se exit.`);
  } else if (hitT || (tgt != null && last != null && last >= tgt)) {
    action = 'EXIT';
    reasons.push(`Target (~${tgt}) area — book / trail; hope pe unlimited hold mat rakho.`);
    if (tgt2 != null && last < tgt2) {
      action = 'TRIM';
      reasons.push(`T1 near; partial book, baaki trail SL with T2 ~${tgt2} optional.`);
    }
  } else if (fromEntryPct != null && fromEntryPct <= -4) {
    action = 'EXIT';
    reasons.push(`Entry se ~${fromEntryPct}% neeche — thesis soft; cut loss better than average down.`);
  } else if (fromEntryPct != null && fromEntryPct <= -2) {
    // recovery path?
    if (dayPct != null && dayPct >= 1.2) {
      action = 'HOLD';
      holdDaysHint = '1–3 more sessions max';
      recoveryNote = 'Neeche se aaj recover ho raha hai — SL respect karke chhota hold OK; unlimited nahi.';
      reasons.push(recoveryNote);
    } else if (dayPct != null && dayPct >= 0.4) {
      action = 'WAIT';
      holdDaysHint = '1–2 sessions';
      recoveryNote = 'Thoda recover / stabilise — confirmation chahiye; size mat badhao.';
      reasons.push(recoveryNote);
    } else {
      action = 'EXIT';
      reasons.push('2%+ underwater aur recovery strong nahi — exit lean.');
    }
  } else if (fromEntryPct != null && fromEntryPct >= 3 && fromEntryPct < 6) {
    action = 'HOLD';
    holdDaysHint = '1–4 sessions; trail SL up';
    reasons.push(`Entry se ~+${fromEntryPct}% — profit me trail SL (breakeven ke paas laao), full exit sirf target/weakness pe.`);
    if (dayPct != null && dayPct <= -1.5) {
      action = 'TRIM';
      reasons.push('Aaj sharp give-back — partial book + trail.');
    }
  } else if (fromEntryPct != null && fromEntryPct >= 6) {
    action = 'TRIM';
    holdDaysHint = 'Trail only';
    reasons.push(`Strong move ~+${fromEntryPct}% — partial profits; baaki trail. Greed me full bag mat rakho.`);
  } else {
    // flat-ish
    action = 'HOLD';
    holdDaysHint = sessionsHeld != null && sessionsHeld >= 5 ? 'Max 1–2 more days then review exit' : 'Up to 3–5 trading sessions';
    reasons.push('Target/SL abhi clear hit nahi — plan active. Time stop: zyada din sideways = capital free karo.');
    if (sessionsHeld != null && sessionsHeld >= 7) {
      action = 'EXIT';
      holdDaysHint = '0 — time stop';
      reasons.push('~7+ sessions ho gaye bina clear target — time-stop exit lean.');
    } else if (sessionsHeld != null && sessionsHeld >= 5) {
      action = 'WAIT';
      reasons.push('5+ sessions: patience kam; weakness pe exit jaldi.');
    }
  }

  // If recovered from red to green
  if (maxDownPct != null && maxDownPct <= -2 && fromEntryPct != null && fromEntryPct >= 0.5) {
    recoveryNote = (recoveryNote ? recoveryNote + ' ' : '') +
      `Pehle ~${maxDownPct}% tak neeche gaya tha, ab ~${fromEntryPct}% pe hai — recovery move. SL ko tight (entry ke paas) laake hold soch sakte ho; dobara deep red = exit.`;
    if (action === 'EXIT' && fromEntryPct >= 1) {
      action = 'HOLD';
      holdDaysHint = '1–3 sessions with tight SL';
    }
    reasons.push(recoveryNote);
  }

  // Upside continuation vs fade
  let pathBias = null;
  if (fromEntryPct != null && fromEntryPct >= 2 && dayPct != null && dayPct > 0.5) {
    pathBias = 'or_upar_ja_sakta_hai';
    reasons.push('Short-term strength dikh rahi — trail SL, panic exit mat; target pe trim.');
  } else if (fromEntryPct != null && fromEntryPct >= 2 && dayPct != null && dayPct < -1) {
    pathBias = 'giveback_risk';
    reasons.push('Profit se de-rha hai — trim / tight trail; full bag risky.');
  } else if (fromEntryPct != null && fromEntryPct < 0 && dayPct != null && dayPct < -0.8) {
    pathBias = 'aur_neeche_risk';
    reasons.push('Weakness continue — exit lean stronger.');
  }

  return {
    symbol: row.symbol,
    action,
    holdDaysHint,
    fromEntryPct,
    maxUpPct,
    maxDownPct,
    sessionsHeld,
    livePrice: last,
    liveDayPct: dayPct,
    eveningPrice: ref,
    stopLoss: sl,
    target: tgt,
    pathBias,
    recoveryNote,
    reasons,
    morningStatus: row.morningStatus,
    asOfDate: asOf,
  };
}

async function activeHoldCoach() {
  const M = pickRowModel();
  if (!M) return { ok: false, message: 'Mongo nahi' };
  const today = istTodayYmd();
  // Hold/exit coach ONLY for packs from before today (next-day onwards).
  // Aaj shaam suggest kiye stocks pe same evening apply nahi.
  const rows = await M.find({
    asOfDate: { $lt: today },
    $or: [
      { resolved: false },
      { resolved: true, outcomeLabel: 'neither', asOfDate: { $gte: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10) } },
    ],
  }).sort({ asOfDate: -1 }).limit(20).lean();

  if (!rows.length) {
    return {
      ok: true,
      coaches: [],
      message: 'Koi active purana pick nahi. Aaj shaam ke naye names ke liye Hold/Exit coach kal se lagega.',
      today,
    };
  }

  const coaches = [];
  for (const row of rows) {
    let quote = null;
    let hist = null;
    try {
      quote = await marketData.getQuote(row.symbol);
    } catch (_) {}
    try {
      hist = await marketData.getHistorical(row.symbol, 20);
    } catch (_) {}
    const coach = holdCoachForRow(row, quote, hist);
    coaches.push(coach);
    // persist light snapshot
    try {
      await M.updateOne(
        { _id: row._id },
        {
          $set: {
            lastCoachAction: coach.action,
            lastCoachAt: new Date(),
            lastCoachNote: (coach.reasons || []).slice(0, 2).join(' | '),
            maxUpPct: coach.maxUpPct,
            maxDownPct: coach.maxDownPct,
          },
        }
      );
    } catch (_) {}
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    coaches,
    disclaimer: 'Hold/exit coach is a plan reminder from levels + path — not a profit promise. SL always first.',
  };
}


module.exports = {
  runTomorrowConviction,
  getLatestTomorrowConviction,
  maybeRunTomorrowConvictionIfDue,
  morningRecheck,
  resolveTomorrowOutcomes,
  getTomorrowLearningStats,
  activeHoldCoach,
};
