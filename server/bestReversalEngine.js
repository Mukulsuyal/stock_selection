/**
 * Today's Best Reversal Picks — max 2–3 high-quality confirmed setups.
 * Independent section. Never force-fill. NO TRADE when empty.
 */
const { getCombinedUniverseScan } = require('./universeScan');
const marketData = require('./marketData');

const MAX_PICKS = Number(process.env.BR_MAX_PICKS || 3);
const MIN_SCORE = Number(process.env.BR_MIN_SCORE || 58);
const MAX_PRICE = Number(process.env.BR_MAX_PRICE || 6000);
const MIN_RR = Number(process.env.BR_MIN_RR || 1.8);
const MIN_SAMPLE = 12;
const NEG = /fraud|insolvency|sebi.?ban|default|probe|raid|pledged|downgrade|bankruptcy|nclt|liquidation|forensic/i;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fundOk(f) {
  if (!f) return { ok: false, score: 0, note: 'No fundamentals' };
  let s = 50;
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
  const de = f.debtToEquity != null ? (f.debtToEquity > 10 ? f.debtToEquity / 100 : f.debtToEquity) : null;
  const pe = f.peTrailing ?? f.pe;
  if (roe != null) {
    if (roe >= 12) s += 14;
    else if (roe >= 8) s += 6;
    else if (roe < 5) s -= 14;
  }
  if (de != null) {
    if (de <= 0.6) s += 10;
    else if (de <= 1.5) s += 3;
    else if (de > 2.5) s -= 14;
  }
  if (pe != null && pe > 80) s -= 8;
  const ok = s >= 55 && (roe == null || roe >= 7) && (de == null || de <= 2.2);
  return { ok, score: clamp(s, 0, 100), note: ok ? `Fund OK (${s})` : `Fund weak (${s})` };
}

async function newsOk(symbol) {
  try {
    const items = await marketData.getNews(symbol);
    const bad = (items || []).slice(0, 6).filter((n) => NEG.test(n.title || ''));
    if (bad.length) return { ok: false, flag: bad[0].title?.slice(0, 90) };
    return { ok: true };
  } catch (_) {
    return { ok: true, note: 'news_unavailable' };
  }
}

/**
 * Confirmation quality for base/reversal — not mere oversold.
 */
function confirmationScore(row, marketContext) {
  const reasons = [];
  const risks = [];
  let s = 0;

  const setup = row.setup || {};
  const d1 = row.periodReturns?.oneDay ?? row.pChange;
  const d5 = row.periodReturns?.oneWeek;
  const d20 = row.periodReturns?.oneMonth;
  const rsi = row.rsi14 ?? row.indicators?.rsi14;
  const vol = row.volSpike ?? row.indicators?.volSpike;
  const br = row.breakout || {};
  const events = br.events || [];
  const rs = row.relativeStrength || {};

  // Path A: confirmed / possible reversal structure near support
  const isReversal = setup.type === 'reversal';
  if (setup.quality === 'falling_knife') {
    return null; // hard reject
  }
  if (isReversal && setup.quality === 'confirmed') {
    s += 28;
    reasons.push('Confirmed reversal structure at support');
  } else if (isReversal && setup.quality === 'possible') {
    s += 18;
    reasons.push('Reversal forming — needs final confirmation');
  } else if (isReversal) {
    s += 10;
    reasons.push('Reversal-type setup tagged');
  }

  // Path B: sharp fall today + buying interest
  const sharpFall = d1 != null && d1 <= -4;
  if (sharpFall && vol != null && vol >= 1.8 && d1 > -12) {
    s += 16;
    reasons.push(`Sharp fall ${d1.toFixed(1)}% with volume ${Number(vol).toFixed(1)}x`);
  } else if (sharpFall && (vol == null || vol < 1.3)) {
    risks.push('Fall without volume support — weak bounce risk');
    s -= 8;
  }

  // Base / multi-day washout then stabilise
  if (d5 != null && d5 <= -8 && d5 >= -22 && d1 != null && d1 > -1.5) {
    s += 12;
    reasons.push(`Base after ${d5.toFixed(1)}% weekly drawdown`);
  }

  // RSI: oversold helps only with structure — alone not enough
  if (rsi != null && rsi < 30 && isReversal) {
    s += 8;
    reasons.push(`RSI ${rsi.toFixed(0)} with reversal structure`);
  } else if (rsi != null && rsi < 30 && !isReversal) {
    s += 2;
    risks.push('Oversold RSI alone — not a buy signal');
  }

  // Volume confirmation of buying
  if (vol != null && vol >= 2 && d1 != null && d1 > 0) {
    s += 12;
    reasons.push('Volume spike on green recovery day');
  } else if (vol != null && vol >= 1.5) {
    s += 5;
  } else {
    risks.push('Volume confirmation soft');
  }

  // Failed breakdown
  if (br.primary === 'FAILED_BREAKOUT' || events.some((e) => e.type === 'FAILED_BREAKOUT')) {
    s += 10;
    reasons.push('Failed breakdown / reclaim');
  }

  // Market / sector context
  const mTrend = marketContext?.trend || marketContext?.todayDirection;
  if (mTrend === 'bearish' && !isReversal) {
    s -= 8;
    risks.push('Weak market — reversal needs more proof');
  }
  if (rs.rs1W != null && rs.rs1W > 0) {
    s += 6;
    reasons.push('Relative strength vs Nifty improving');
  }

  // Reject still freefalling
  if (d1 != null && d1 <= -7 && (vol == null || vol < 2)) {
    s -= 15;
    risks.push('Still freefalling without absorption');
  }

  // Technical score soft boost
  if ((row.score || 0) >= 2) s += 6;

  s = clamp(Math.round(s), 0, 100);
  if (s < 40) return null;
  return { score: s, reasons: reasons.slice(0, 5), risks: risks.slice(0, 4) };
}

function buildEntryPlan(row, conf) {
  const px = row.price;
  const plan0 = row.tradePlan || {};
  const atr = row.indicators?.atr14;
  const pad = atr != null ? Math.min(atr * 0.85, px * 0.022) : px * 0.018;
  const entryLow = plan0.entryLow ?? Number((px * 0.997).toFixed(2));
  const entryHigh = plan0.entryHigh ?? Number((px * 1.01).toFixed(2));
  const stop = plan0.stopLoss ?? Number((px - pad).toFixed(2));
  const t1 = plan0.target ?? plan0.target1 ?? Number((px * 1.035).toFixed(2));
  const t2 = plan0.target2 ?? Number((px * 1.06).toFixed(2));
  const risk = px - stop;
  const reward = t1 - px;
  const rr = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  const rrNet = rr != null ? Number((rr * 0.9).toFixed(2)) : null;

  const upsidePct = Number((((t1 - px) / px) * 100).toFixed(2));
  const downsidePct = Number((((stop - px) / px) * 100).toFixed(2));

  const d1 = row.periodReturns?.oneDay ?? row.pChange;
  const q = row.setup?.quality;
  const vol = row.volSpike ?? row.indicators?.volSpike;
  const volOk = vol == null || vol >= 1.15;
  const bounceDay = d1 != null && d1 > 0.2 && d1 <= 5;
  const structureOk = q === 'confirmed' || q === 'possible' || bounceDay;

  let action = 'WATCHLIST';
  let trigger = 'Wait clear hold above entry zone';

  // Practical BUY path — not only perfect "confirmed + 1.5x vol + score 75"
  if (conf.score >= 62 && structureOk && volOk && (rrNet == null || rrNet >= 1.5) && q !== 'falling_knife') {
    if (
      (q === 'confirmed' && conf.score >= 62) ||
      (bounceDay && conf.score >= 65 && (vol == null || vol >= 1.25))
    ) {
      action = 'BUY NOW';
      trigger = 'Enter in zone; SL hard. Do not average if SL hits.';
    } else if (conf.score >= 58) {
      action = 'BUY ON DIP';
      trigger = 'Buy only inside entry zone on pullback — strict SL, no chase';
    } else {
      action = 'WAIT FOR CONFIRMATION';
      trigger = 'One more confirming close / volume before entry';
    }
  } else if (conf.score >= 50 && structureOk) {
    action = 'WAIT FOR CONFIRMATION';
    trigger = 'Bullish hold above entry low with volume ≥1.2x';
  }

  // Freefall same day without bounce → no buy
  if (d1 != null && d1 <= -6 && (action === 'BUY NOW' || action === 'BUY ON DIP')) {
    action = 'WAIT FOR CONFIRMATION';
    trigger = 'Still weak on day — wait stabilization candle';
  }
  if (rrNet != null && rrNet < 1.4 && (action === 'BUY NOW' || action === 'BUY ON DIP')) {
    action = 'WAIT FOR CONFIRMATION';
    trigger = 'R:R thin after costs — wait better price';
  }

  return {
    action,
    entryZone: { low: entryLow, high: entryHigh },
    trigger,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    upsidePct,
    downsidePct,
    riskReward: rr,
    riskRewardNet: rrNet,
    invalidation: `Daily close below ₹${stop} or recovery structure fails`,
  };
}

function probabilityBlock(row) {
  const mp = row.moveProbability || {};
  const n = mp.sampleSize ?? null;
  const insufficient = n == null || n < MIN_SAMPLE;
  return {
    targetHitEstimate: insufficient ? null : (mp.probabilityUp5PctPlus ?? mp.probabilityUp1PctPlus ?? null),
    furtherDownEstimate: insufficient ? null : (mp.probabilityDown2PctPlus ?? null),
    sampleSize: n,
    confidence: insufficient ? 'INSUFFICIENT' : n < 25 ? 'LOW' : n < 40 ? 'MED' : 'HIGH',
    horizon: '1–7 trading days',
    note: insufficient
      ? `Insufficient history (n=${n ?? 0}) — no fabricated probability.`
      : `From ${n} similar past signals on this stock only — not a guarantee.`,
  };
}

function threeReasons(conf, fund, row) {
  const out = [];
  if (conf.reasons[0]) out.push(conf.reasons[0]);
  // volume/buying
  const vol = row.volSpike;
  if (vol != null && vol >= 1.5) out.push(`Volume confirmation ${Number(vol).toFixed(1)}x avg`);
  else if (conf.reasons[1]) out.push(conf.reasons[1]);
  // fund
  out.push(fund.note || 'Fundamentals screened');
  return out.slice(0, 3);
}

async function runBestReversalPicks(opts = {}) {
  const { forceRefresh = false, jobId = null } = opts;
  const { startJob, updateJob, endJob } = require('./progressStore');
  if (jobId) try { startJob(jobId, 450, 'Best reversal: scanning universe…'); } catch (_) {}
  const progress = (info) => {
    if (!jobId) return;
    try {
      updateJob(jobId, info.completed, {
        total: info.total,
        message: info.message || `Checking ${info.symbol || ''}…`,
        phase: info.phase || 'universe',
        detail: info.symbol || null,
        log: info.symbol ? `${info.completed}/${info.total} ${info.symbol}` : info.message,
      });
    } catch (_) {}
  };
  const { results, symbolToIndex, marketContext, scannedAt, scannedCount } =
    await getCombinedUniverseScan({ forceRefresh, onProgress: progress });

  const ranked = [];

  for (const row0 of results) {
    if (!row0 || row0.error || row0.price == null) continue;
    if (row0.price > MAX_PRICE) continue;

    const conf = confirmationScore(row0, marketContext);
    if (!conf || conf.score < MIN_SCORE - 15) continue; // soft prefilter

    const fund = fundOk(row0.fundamentals);
    // Strong technical confirmation can pass with unknown fund; weak fund still blocked
    if (!fund.ok && fund.score > 0 && fund.score < 45) continue;
    if (!fund.ok && !row0.fundamentals && conf.score < 72) continue;
    if (!fund.ok && fund.note === 'No fundamentals' && conf.score < 70) continue;
    if (!fund.ok && fund.note !== 'No fundamentals') continue;

    const news = await newsOk(row0.symbol);
    if (!news.ok) continue;

    if (conf.score < MIN_SCORE) continue;

    const plan = buildEntryPlan(row0, conf);
    if (plan.riskRewardNet != null && plan.riskRewardNet < 1.3) continue;

    const probs = probabilityBlock(row0);
    const quality =
      conf.score * 0.55 +
      fund.score * 0.25 +
      (plan.riskRewardNet != null ? Math.min(plan.riskRewardNet, 4) * 5 : 0) -
      conf.risks.length * 3;

    ranked.push({
      symbol: row0.symbol,
      indexLabel: symbolToIndex[row0.symbol] || null,
      price: row0.price,
      quality: Number(quality.toFixed(1)),
      confirmationScore: conf.score,
      action: plan.action,
      entryZone: plan.entryZone,
      trigger: plan.trigger,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      upsidePct: plan.upsidePct,
      downsidePct: plan.downsidePct,
      riskReward: plan.riskReward,
      riskRewardNet: plan.riskRewardNet,
      probabilities: probs,
      reasons: threeReasons(conf, fund, row0),
      risks: conf.risks.slice(0, 2),
      invalidation: plan.invalidation,
      setupQuality: row0.setup?.quality || null,
      supportNote: (row0.setup?.reason || '').slice(0, 120) || null,
      resistanceNote: null,
      fundNote: fund.note,
      newsFlag: news.flag || null,
      detectedAt: new Date().toISOString(),
    });
  }

  ranked.sort((a, b) => b.quality - a.quality);

  // Prefer BUY NOW → BUY ON DIP → WAIT; hard cap 2–3; never pad with junk
  const buys = ranked.filter((r) => r.action === 'BUY NOW');
  const dips = ranked.filter((r) => r.action === 'BUY ON DIP');
  const waits = ranked.filter((r) => r.action === 'WAIT FOR CONFIRMATION');
  let picks = [...buys, ...dips, ...waits].slice(0, MAX_PICKS);

  // If top has only weak WAIT and quality barely passes — still allow 1–2
  // but if nothing above MIN_SCORE quality, empty
  picks = picks.filter((p) => p.confirmationScore >= MIN_SCORE - 18).slice(0, MAX_PICKS);

  const payload = {
    ok: true,
    scannedAt,
    scannedCount,
    marketTrend: marketContext?.trend || null,
    picks,
    pickCount: picks.length,
    noTrade: picks.length === 0,
    message: picks.length
      ? `${picks.length} high-quality reversal candidate(s) — not a guarantee.`
      : 'NO TRADE — no fully confirmed, fundamentally acceptable reversal today.',
    disclaimer:
      'Max 2–3 picks by design. Score ≠ probability. Historical estimates only when sample allows. Never averages down automatically.',
  };
  if (jobId) {
    try { endJob(jobId, payload.noTrade ? 'NO TRADE' : `${picks.length} pick(s)`, payload); } catch (_) {}
  }
  return payload;
}

module.exports = { runBestReversalPicks, MAX_PICKS, MIN_SCORE };
