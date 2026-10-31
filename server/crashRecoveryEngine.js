/**
 * Crash Recovery & Bounce Predictor — independent of Early Boom / Golden.
 * Capital protection first. No fabricated 80% probabilities.
 */
const { getCombinedUniverseScan } = require('./universeScan');
const marketData = require('./marketData');

const CFG = {
  minDayFall: Number(process.env.CR_MIN_DAY_FALL || 8),
  min3dFall: Number(process.env.CR_MIN_3D_FALL || 10),
  min5dFall: Number(process.env.CR_MIN_5D_FALL || 12),
  min20dFall: Number(process.env.CR_MIN_20D_FALL || 15),
  maxPrice: Number(process.env.CR_MAX_PRICE || 6000),
  minRr: Number(process.env.CR_MIN_RR || 1.8),
  maxPerTab: Number(process.env.CR_MAX_PER || 15),
  capital: Number(process.env.CR_CAPITAL || 10000),
  riskPct: Number(process.env.CR_RISK_PCT || 1),
  minSample: 12,
};

const NEG_NEWS = /fraud|insolvency|sebi.?ban|default|probe|raid|pledged|downgrade|loss.?widen|bankruptcy|winding.?up|forensic|nclt|liquidation/i;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pct(a, b) {
  if (a == null || b == null || !b) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function fundQuality(f) {
  if (!f) return { score: 40, label: 'UNKNOWN', flags: ['No fundamentals cache'], strong: false };
  const flags = [];
  let s = 50;
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
  const de = f.debtToEquity != null ? (f.debtToEquity > 10 ? f.debtToEquity / 100 : f.debtToEquity) : null;
  const pe = f.peTrailing ?? f.pe;
  const margin = f.profitMargin != null ? (f.profitMargin <= 1.5 ? f.profitMargin * 100 : f.profitMargin) : null;
  const rg = f.revenueGrowth != null ? (Math.abs(f.revenueGrowth) <= 5 ? f.revenueGrowth * 100 : f.revenueGrowth) : null;

  if (roe != null) {
    if (roe >= 15) { s += 14; flags.push(`ROE ${roe.toFixed(0)}% solid`); }
    else if (roe >= 8) { s += 6; flags.push(`ROE ${roe.toFixed(0)}%`); }
    else if (roe < 5) { s -= 12; flags.push(`Weak ROE ${roe.toFixed(0)}%`); }
  }
  if (de != null) {
    if (de <= 0.5) { s += 10; flags.push('Low debt'); }
    else if (de <= 1.2) { s += 3; }
    else if (de > 2.5) { s -= 14; flags.push(`High debt ${de.toFixed(1)}`); }
  }
  if (pe != null && pe > 0) {
    if (pe < 20) s += 6;
    else if (pe > 70) { s -= 8; flags.push(`Rich PE ${pe.toFixed(0)}`); }
  }
  if (margin != null) {
    if (margin >= 12) s += 6;
    else if (margin < 2) { s -= 6; flags.push('Thin margins'); }
  }
  if (rg != null) {
    if (rg >= 10) s += 6;
    else if (rg < -10) { s -= 10; flags.push(`Revenue declining ${rg.toFixed(0)}%`); }
  }
  const sh = f.shareholdingSummary;
  if (sh?.promoterDelta != null && sh.promoterDelta < -1) {
    s -= 8; flags.push(`Promoter holding ↓ ${sh.promoterDelta}%`);
  }
  if (sh?.fiiDelta != null && sh.fiiDelta <= -1) flags.push(`FII QoQ ${sh.fiiDelta}%`);

  s = clamp(Math.round(s), 0, 100);
  const strong = s >= 62 && (roe == null || roe >= 8) && (de == null || de <= 2);
  return {
    score: s,
    label: s >= 70 ? 'STRONG' : s >= 55 ? 'FAIR' : s >= 40 ? 'WEAK' : 'POOR',
    flags: flags.slice(0, 5),
    strong,
  };
}

async function newsFlags(symbol) {
  try {
    const items = await marketData.getNews(symbol);
    const bad = (items || []).slice(0, 8).filter((n) => NEG_NEWS.test(n.title || ''));
    return {
      ok: bad.length === 0,
      redFlags: bad.map((n) => (n.title || '').slice(0, 100)),
      headlines: (items || []).slice(0, 2).map((n) => n.title),
    };
  } catch (_) {
    return { ok: true, redFlags: [], headlines: [], note: 'News feed unavailable — not treated as clear' };
  }
}

function technicalRecovery(row) {
  const reasons = [];
  const risks = [];
  let s = 32;
  const rsi = row.rsi14 ?? row.indicators?.rsi14;
  const setup = row.setup || {};
  const br = row.breakout || {};
  const events = br.events || [];
  const vol = row.volSpike ?? row.indicators?.volSpike;
  const d1 = row.periodReturns?.oneDay ?? row.pChange;
  const d5 = row.periodReturns?.oneWeek ?? row.periodReturns?.fiveDay;

  // Structure — confirmed is best, but practical bounce signals also count
  if (setup.type === 'reversal' && setup.quality === 'confirmed') {
    s += 22; reasons.push('Confirmed reversal structure');
  } else if (setup.type === 'reversal' && setup.quality === 'possible') {
    s += 14; reasons.push('Possible reversal forming');
  } else if (setup.type === 'reversal') {
    s += 8; reasons.push('Reversal-type structure');
  } else if (setup.quality === 'falling_knife') {
    s -= 12; risks.push('Falling knife — no recovery confirmation');
  }

  // RSI: context, not sole signal
  if (rsi != null && rsi < 25) { s += 10; reasons.push(`RSI ${rsi.toFixed(0)} capitulation zone`); }
  else if (rsi != null && rsi < 35) { s += 6; reasons.push(`RSI ${rsi.toFixed(0)} oversold`); }
  else if (rsi != null && rsi >= 35 && rsi <= 48 && d1 != null && d1 > 0) {
    s += 6; reasons.push(`RSI recovering ${rsi.toFixed(0)}`);
  } else if (rsi != null && rsi > 60) { s -= 4; risks.push('RSI already stretched'); }

  // Volume — 1.2x is usable; do not hard-block moderate volume
  if (vol != null && vol >= 2) { s += 12; reasons.push(`Volume ${Number(vol).toFixed(1)}x absorption`); }
  else if (vol != null && vol >= 1.4) { s += 8; reasons.push(`Volume ${Number(vol).toFixed(1)}x`); }
  else if (vol != null && vol >= 1.15) { s += 4; reasons.push(`Volume ${Number(vol).toFixed(1)}x moderate`); }
  else if (vol != null && vol < 0.9) { risks.push('Volume still sleepy'); }
  else { risks.push('Volume not strongly elevated'); }

  if (events.some((e) => e.type === 'FAILED_BREAKOUT') || br.primary === 'FAILED_BREAKOUT') {
    s += 10; reasons.push('Failed breakdown / reclaim bias');
  }

  // Practical bounce: green after multi-day fall, or modest green after sharp day fall
  if (d1 != null && d1 > 0 && d1 <= 5) {
    s += 12; reasons.push(`Bounce day +${d1.toFixed(1)}%`);
  } else if (d1 != null && d1 > 5 && d1 <= 8) {
    s += 4; reasons.push(`Strong bounce +${d1.toFixed(1)}% — check not late`);
  } else if (d1 != null && d1 < -8) {
    risks.push('Still in free-fall day'); s -= 10;
  } else if (d1 != null && d1 < -4) {
    s -= 4; risks.push('Still weak on the day');
  }

  // Weekly washout then stabilising today
  if (d5 != null && d5 <= -8 && d1 != null && d1 >= -1) {
    s += 8; reasons.push(`Stabilising after ${d5.toFixed(1)}% weekly fall`);
  }

  const rs = row.relativeStrength || {};
  if (rs.rs1W != null && rs.rs1W > 0) { s += 6; reasons.push('Outperforming Nifty 1W'); }
  if (rs.rs1W != null && rs.rs1W < -4) { s -= 3; risks.push('Lagging Nifty'); }

  // Bounce evidence flag for classify/plan
  const bounceEvidence =
    (d1 != null && d1 > 0.3 && d1 <= 6) ||
    (setup.quality === 'confirmed') ||
    (events.some((e) => e.type === 'FAILED_BREAKOUT') || br.primary === 'FAILED_BREAKOUT');

  return {
    score: clamp(Math.round(s), 0, 100),
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 5),
    rsi,
    vol,
    bounceEvidence,
  };
}

/**
 * Honest downside/bounce bands from stock moveProbability + heuristics.
 * Never invent 80% figures.
 */
function probabilityBands(row, fallPct, tech, fund) {
  const mp = row.moveProbability || {};
  const n = mp.sampleSize ?? null;
  const insufficient = n == null || n < CFG.minSample;

  // Base bounce chance soft from RSI/setup — labeled as model estimate not calibrated
  let bounceBias = 45;
  if (tech.score >= 70) bounceBias += 12;
  else if (tech.score >= 55) bounceBias += 5;
  if (fund.strong) bounceBias += 8;
  if (tech.rsi != null && tech.rsi < 30) bounceBias += 5;
  if (fallPct <= -15) bounceBias += 3;
  bounceBias = clamp(bounceBias, 15, 72);

  const downBias = clamp(100 - bounceBias + (tech.risks.length * 3), 20, 80);

  function ladder(bias, isUp) {
    // Larger moves less likely
    const scale = isUp
      ? { 1: 1.0, 2: 0.72, 3: 0.5, 5: 0.32, 8: 0.18 }
      : { 1: 1.0, 2: 0.75, 3: 0.55, 5: 0.38, 8: 0.22 };
    const out = {};
    for (const [k, m] of Object.entries(scale)) {
      out[`${k}pct`] = insufficient ? null : Number(clamp(bias * m, 5, 85).toFixed(1));
    }
    return out;
  }

  const noFurtherSignificantDownside = (() => {
    // Only claim ≥80% "no further significant downside (−3% within 3 days)" when calibrated sample supports it
    if (insufficient) {
      return {
        value: null,
        threshold: '−3% within 3 sessions',
        claim: 'Insufficient evidence',
        note: `Need n≥${CFG.minSample} similar past falls on this stock; have n=${n ?? 0}.`,
      };
    }
    // Use available up-prob inverted only as soft — never force 80
    const soft = clamp(100 - downBias * 0.5, 20, 78);
    if (soft >= 80 && n >= 40 && fund.strong && tech.score >= 70) {
      return {
        value: Number(soft.toFixed(1)),
        threshold: '−3% within 3 sessions',
        claim: 'Model estimate (not guarantee)',
        note: `n=${n}; still path-dependent.`,
      };
    }
    return {
      value: Number(soft.toFixed(1)),
      threshold: '−3% within 3 sessions',
      claim: soft >= 80 ? 'Not claimed — calibration bar not met' : 'Below 80% bar',
      note: `Shown estimate ${soft.toFixed(0)}%; 80%+ only with large sample + strong fund + tech.`,
    };
  })();

  return {
    sampleSize: n,
    insufficient,
    bounce: ladder(bounceBias, true),
    furtherDown: ladder(downBias, false),
    horizons: {
      intraday: insufficient ? null : clamp(bounceBias * 0.6, 10, 60),
      d1: insufficient ? null : clamp(bounceBias * 0.85, 15, 70),
      d3: insufficient ? null : clamp(bounceBias, 15, 72),
      d5: insufficient ? null : clamp(bounceBias * 0.9, 12, 68),
      d10: insufficient ? null : clamp(bounceBias * 0.75, 10, 60),
    },
    noFurtherSignificantDownside,
    disclaimer: 'Probabilities are historical/heuristic estimates. Not guarantees. Insufficient sample → null bands.',
  };
}

function buildPlan(row, fallPct, tech) {
  const px = row.price;
  if (px == null) return null;
  const atr = row.indicators?.atr14;
  const pad = atr != null ? Math.min(atr * 0.9, px * 0.025) : px * 0.02;
  const entryLow = Number((px * 0.995).toFixed(2));
  const entryHigh = Number((px * 1.012).toFixed(2));
  const stop = Number((px - pad).toFixed(2));
  const t1 = Number((px * 1.03).toFixed(2));
  const t2 = Number((px * 1.05).toFixed(2));
  const t3 = Number((px * 1.08).toFixed(2));
  const risk = px - stop;
  const reward = t2 - px;
  const rr = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  const rrNet = rr != null ? Number((rr * 0.9).toFixed(2)) : null;
  const riskRs = CFG.capital * (CFG.riskPct / 100);
  const qty = risk > 0 ? Math.max(0, Math.floor(riskRs / risk)) : 0;

  const d1 = row.periodReturns?.oneDay ?? row.pChange;
  const q = row.setup?.quality;
  const isRev = row.setup?.type === 'reversal';
  const volOk = tech.vol == null || tech.vol >= 1.15;
  const volStrong = tech.vol != null && tech.vol >= 1.35;
  const structureOk = q === 'confirmed' || q === 'possible' || tech.bounceEvidence;
  const notFreefall = d1 == null || d1 > -6;

  let status = 'WATCHLIST';
  let trigger = 'Wait clear bounce candle + hold above entry zone low';

  // BUY NOW — practical: solid tech + structure/bounce evidence + not freefalling
  if (
    tech.score >= 62 &&
    structureOk &&
    volOk &&
    notFreefall &&
    (rrNet == null || rrNet >= 1.5) &&
    q !== 'falling_knife'
  ) {
    if ((q === 'confirmed' && tech.score >= 62) || (tech.bounceEvidence && tech.score >= 68 && volStrong)) {
      status = 'BUY NOW';
      trigger = 'Enter in zone; hold above zone low / today’s support on volume';
    } else if (tech.score >= 58 && (isRev || tech.bounceEvidence)) {
      status = 'BUY ON DIP';
      trigger = 'Buy only inside entry zone with strict SL — do not chase if it gaps up';
    } else {
      status = 'WAIT FOR CONFIRMATION';
      trigger = 'Need one more bullish close or volume ≥1.3x hold';
    }
  } else if (tech.score >= 48 && (isRev || tech.bounceEvidence || (d1 != null && d1 > 0))) {
    status = 'WAIT FOR CONFIRMATION';
    trigger = 'Bullish hold above entry low before size-up';
  } else if (tech.score < 38 || q === 'falling_knife') {
    status = 'AVOID';
    trigger = 'No entry — structure / flow still broken';
  }

  // Hard freefall same day without bounce → never BUY
  if (d1 != null && d1 <= -7 && (status === 'BUY NOW' || status === 'BUY ON DIP')) {
    status = 'WAIT FOR CONFIRMATION';
    trigger = 'Still freefalling — wait stabilization first';
  }

  if (rrNet != null && rrNet < 1.4 && (status === 'BUY NOW' || status === 'BUY ON DIP')) {
    status = 'WAIT FOR CONFIRMATION';
    trigger = 'R:R too thin after costs — wait better entry';
  }

  return {
    entryZone: { low: entryLow, high: entryHigh },
    trigger,
    stopLoss: stop,
    targets: {
      t1, t2, t3,
      t1Pct: 3, t2Pct: 5, t3Pct: 8,
    },
    riskReward: rr,
    riskRewardNet: rrNet,
    positionSize: { qty, capital: CFG.capital, riskPct: CFG.riskPct, riskRs: Number((qty * risk).toFixed(2)) },
    status,
    invalidation: `Daily close below ₹${stop} or breakdown of recovery structure`,
    supportEvidence: tech.reasons.filter((r) => /RSI|reversal|Failed|Volume|Bounce|Stabil/i.test(r)).slice(0, 3),
  };
}

function classifyTab(card) {
  const st = card.plan?.status;
  if (st === 'AVOID') return 'high_downside_risk';
  if (card.probs?.furtherDown?.['5pct'] != null && card.probs.furtherDown['5pct'] >= 60 && (card.tech?.score || 0) < 50) {
    return 'high_downside_risk';
  }
  // Bounce confirmed: actionable buy states OR clear bounce evidence with decent tech
  if (
    st === 'BUY NOW' ||
    st === 'BUY ON DIP' ||
    (card.tech?.bounceEvidence && (card.tech?.score || 0) >= 58 && st !== 'AVOID')
  ) {
    return 'bounce_confirmed';
  }
  if (card.fund?.strong && card.fallPct <= -8) {
    if ((card.tech?.score || 0) >= 50) return 'reversal_forming';
    return 'strong_fund_temp_fall';
  }
  if ((card.tech?.score || 0) >= 48 || st === 'WAIT FOR CONFIRMATION') return 'reversal_forming';
  return 'deep_fall';
}

function isDeepFall(row) {
  const d1 = row.periodReturns?.oneDay ?? row.pChange;
  const d3 = row.periodReturns?.fifteenDay != null
    ? row.periodReturns.fifteenDay // soft proxy if no 3d
    : null;
  const d5 = row.periodReturns?.oneWeek;
  const d20 = row.periodReturns?.oneMonth;
  const falls = [];
  if (d1 != null && d1 <= -CFG.minDayFall) falls.push({ window: '1d', pct: d1 });
  if (d5 != null && d5 <= -CFG.min5dFall) falls.push({ window: '5d', pct: d5 });
  if (d20 != null && d20 <= -CFG.min20dFall) falls.push({ window: '20d', pct: d20 });
  // 3-day approx from recentDailyChanges if present
  if (Array.isArray(row.recentDailyChanges) && row.recentDailyChanges.length >= 3) {
    const sum3 = row.recentDailyChanges.slice(-3).reduce((a, b) => a + (Number(b) || 0), 0);
    if (sum3 <= -CFG.min3dFall) falls.push({ window: '3d', pct: sum3 });
  }
  if (!falls.length) return null;
  const primary = falls.sort((a, b) => a.pct - b.pct)[0];
  return { falls, primaryFall: primary };
}

async function runCrashRecoveryScan(opts = {}) {
  const { forceRefresh = false, jobId = null, onProgress = null } = opts;
  const { startJob, updateJob, endJob } = require('./progressStore');
  if (jobId) {
    try { startJob(jobId, 450, 'Crash recovery: loading universe…'); } catch (_) {}
  }
  const progress = (info) => {
    if (typeof onProgress === 'function') onProgress(info);
    if (jobId) {
      try {
        updateJob(jobId, info.completed, {
          total: info.total,
          message: info.message || `Scanning ${info.symbol || ''}…`,
          phase: info.phase || 'universe',
          detail: info.symbol || null,
          log: info.symbol ? `${info.completed}/${info.total} ${info.symbol}` : info.message,
          recent: info.symbol ? [info.symbol] : undefined,
        });
      } catch (_) {}
    }
  };
  const { results, symbolToIndex, marketContext, scannedAt, scannedCount } =
    await getCombinedUniverseScan({ forceRefresh, onProgress: progress });

  const marketDay = marketContext?.periodReturns?.oneDay ?? marketContext?.oneDayChangePct;
  const cards = [];

  for (const row0 of results) {
    if (!row0 || row0.error || row0.price == null) continue;
    if (row0.price > CFG.maxPrice) continue;
    const fall = isDeepFall(row0);
    if (!fall) continue;

    const row = { ...row0, indexLabel: symbolToIndex[row0.symbol] || row0.indexLabel };
    const fund = fundQuality(row.fundamentals);
    const news = await newsFlags(row.symbol);
    if (!news.ok) {
      // still list under high downside / avoid
    }
    const tech = technicalRecovery(row);
    const fallPct = fall.primaryFall.pct;
    const probs = probabilityBands(row, fallPct, tech, fund);
    let plan = buildPlan(row, fallPct, tech);

    if (!news.ok) {
      plan = { ...plan, status: 'AVOID', trigger: 'Negative corporate/news red flag' };
      tech.risks.push(...news.redFlags.slice(0, 2));
    }
    if (fund.label === 'POOR') {
      if (plan.status === 'BUY NOW' || plan.status === 'BUY ON DIP') {
        plan = { ...plan, status: 'WAIT FOR CONFIRMATION', trigger: 'Fund POOR — size down or wait structure only' };
      }
      tech.risks.push('Fundamentals weak — fall may be justified');
    } else if (fund.label === 'WEAK' && plan.status === 'BUY NOW') {
      plan = { ...plan, status: 'BUY ON DIP', trigger: (plan.trigger || '') + ' · Fund WEAK — smaller size' };
    }

    // Market-wide crash tag
    const marketWide = marketDay != null && marketDay <= -1.5 && fallPct <= marketDay - 2;
    const stockSpecific = marketDay != null && marketDay > -0.8 && fallPct <= -8;

    const card = {
      symbol: row.symbol,
      indexLabel: row.indexLabel,
      price: row.price,
      fallPct: Number(fallPct.toFixed(2)),
      fallWindows: fall.falls,
      marketWideCrashContext: marketWide,
      stockSpecificSelling: stockSpecific,
      fund,
      news: { redFlags: news.redFlags, headlines: news.headlines },
      tech: { score: tech.score, reasons: tech.reasons, risks: tech.risks, rsi: tech.rsi, vol: tech.vol },
      setupType: row.setupType || row.setup?.type,
      setupQuality: row.setupQuality || row.setup?.quality,
      probs,
      plan,
      relativeStrength: row.relativeStrength || null,
      detectedAt: new Date().toISOString(),
      scannedAt,
    };
    card.tab = classifyTab(card);
    cards.push(card);
  }

  cards.sort((a, b) => (b.tech?.score || 0) - (a.tech?.score || 0) || (a.fallPct - b.fallPct));

  const tabs = {
    deep_fall: [],
    strong_fund_temp_fall: [],
    reversal_forming: [],
    bounce_confirmed: [],
    high_downside_risk: [],
  };
  for (const c of cards) {
    const k = c.tab in tabs ? c.tab : 'deep_fall';
    if (tabs[k].length < CFG.maxPerTab) tabs[k].push(c);
  }

  const payload = {
    ok: true,
    scannedAt,
    scannedCount,
    marketTrend: marketContext?.trend || null,
    marketDayPct: marketDay,
    config: {
      minDayFall: CFG.minDayFall,
      min5dFall: CFG.min5dFall,
      min20dFall: CFG.min20dFall,
    },
    counts: Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, v.length])),
    tabs,
    allCount: cards.length,
    disclaimer:
      'Crash Recovery is independent of Early Boom. No recovery/profit guarantee. 80%+ “no further downside” only when calibrated sample + evidence allow; otherwise Insufficient evidence.',
  };
  if (jobId) {
    try { endJob(jobId, `Done — ${cards.length} deep-fall candidates`, payload); } catch (_) {}
  }
  return payload;
}

async function backtestFallBounce(symbol) {
  try {
    const candles = await marketData.getHistorical(symbol, 900);
    if (!candles || candles.length < 300) {
      return { ok: false, symbol, limitation: 'Insufficient history', sampleSize: candles?.length || 0 };
    }
    let n = 0, bounce3 = 0, stopHit = 0, sumMfe = 0, sumMae = 0;
    for (let i = 40; i < candles.length - 6; i++) {
      const c0 = candles[i].close;
      const prev = candles[i - 1]?.close;
      if (!c0 || !prev) continue;
      const dayFall = ((c0 - prev) / prev) * 100;
      if (dayFall > -8) continue;
      n += 1;
      const entry = c0;
      const stop = entry * 0.97;
      const tgt = entry * 1.05;
      let mfe = 0, mae = 0, outcome = 'none';
      for (let j = 1; j <= 5; j++) {
        const b = candles[i + j];
        if (!b) break;
        mfe = Math.max(mfe, ((b.high - entry) / entry) * 100);
        mae = Math.min(mae, ((b.low - entry) / entry) * 100);
        if (b.low <= stop) { outcome = 'sl'; break; }
        if (b.high >= tgt) { outcome = 'tgt'; break; }
      }
      if (outcome === 'tgt') bounce3 += 1;
      if (outcome === 'sl') stopHit += 1;
      sumMfe += mfe;
      sumMae += mae;
    }
    return {
      ok: true,
      symbol,
      sampleSize: n,
      bounceTo5PctWithin5d: n ? Number(((bounce3 / n) * 100).toFixed(1)) : null,
      stop3PctHitRate: n ? Number(((stopHit / n) * 100).toFixed(1)) : null,
      avgMfe: n ? Number((sumMfe / n).toFixed(2)) : null,
      avgMae: n ? Number((sumMae / n).toFixed(2)) : null,
      note: n < CFG.minSample
        ? `n=${n} too small for reliable probability claims.`
        : 'Single-symbol walk-forward style; costs partially modeled; not market-wide proof.',
      limitation: 'Not a full multi-regime portfolio backtest.',
    };
  } catch (err) {
    return { ok: false, symbol, error: err.message };
  }
}

module.exports = { runCrashRecoveryScan, backtestFallBounce, CFG };
