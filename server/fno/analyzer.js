/**
 * F&O Trading Intelligence — richer MTF + clear CE/PE playbook.
 * Probability is filtered confidence, not guaranteed profit.
 */
const marketData = require('../marketData');
const { getMarketTrend } = require('../marketTrend');
const { INDEXES, lotFor, setLotFallback } = require('./instruments');
const {
  fetchNseOptionChain,
  parseChain,
  pickBestExpiry,
  summarizeExpiry,
} = require('./optionChain');
const riskState = require('./riskState');
const { buildSyntheticChain } = require('./syntheticChain');

const MAX_RISK_INR = Number(process.env.FO_MAX_RISK_INR || 2000);
const MIN_RR = 1.5;
const PREFER_RR = 2.0;

function istNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { hour: Number(get('hour')), minute: Number(get('minute')), weekday: get('weekday') };
}

function sessionOpen() {
  const { hour, minute, weekday } = istNow();
  if (['Sat', 'Sun'].includes(weekday)) return false;
  const m = hour * 60 + minute;
  return m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

function isExpiryLikelyThursday() {
  return istNow().weekday === 'Thu';
}

function candlesFromIntraday(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
    volume: Number(c.volume) || 0, time: c.time || c.date,
  })).filter((c) => Number.isFinite(c.close));
}

function trendFromCloses(closes) {
  if (!closes || closes.length < 8) return { trend: 'UNKNOWN', score: 0, last: null };
  const last = closes[closes.length - 1];
  const sma = (n) => {
    const s = closes.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const s5 = sma(Math.min(5, closes.length));
  const s20 = sma(Math.min(20, closes.length));
  let trend = 'SIDEWAYS';
  let score = 0;
  if (last > s5 && s5 > s20) { trend = 'BULLISH'; score = 20; }
  else if (last < s5 && s5 < s20) { trend = 'BEARISH'; score = 20; }
  else if (last > s20) { trend = 'MILD_BULL'; score = 8; }
  else if (last < s20) { trend = 'MILD_BEAR'; score = 8; }
  const prev = closes[closes.length - 2];
  const dayPct = prev ? ((last - prev) / prev) * 100 : 0;
  return { trend, score, last, dayPct: Number(dayPct.toFixed(2)), sma5: s5, sma20: s20 };
}

function approxVwap(candles) {
  if (!candles?.length) return null;
  let pv = 0; let v = 0;
  for (const c of candles.slice(-78)) { // ~day of 5m
    const typ = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    pv += typ * vol;
    v += vol;
  }
  return v > 0 ? Number((pv / v).toFixed(2)) : null;
}

async function loadMtf(yahooSymbol) {
  const frames = {};
  const load = async (range, interval, key) => {
    try {
      const raw = await marketData.getIntradayCandles(yahooSymbol, range, interval);
      const candles = candlesFromIntraday(raw);
      frames[key] = trendFromCloses(candles.map((c) => c.close));
      frames[key].candles = candles;
      return candles;
    } catch (_) {
      frames[key] = { trend: 'UNKNOWN', score: 0 };
      return [];
    }
  };

  const c5 = await load('1d', '5m', 'm5');
  await load('5d', '15m', 'm15');
  await load('1mo', '1h', 'H1');
  let daily = [];
  try {
    daily = await marketData.getHistorical(yahooSymbol, 80);
  } catch (_) {}
  const dCloses = (daily || []).map((c) => Number(c.close)).filter(Number.isFinite);
  frames.D = trendFromCloses(dCloses);
  frames.H4 = frames.H1; // proxy if no 4h

  const vwap = approxVwap(c5);
  const alignedBull = ['BULLISH', 'MILD_BULL'].includes(frames.m15?.trend)
    && ['BULLISH', 'MILD_BULL'].includes(frames.H1?.trend || frames.D?.trend);
  const alignedBear = ['BEARISH', 'MILD_BEAR'].includes(frames.m15?.trend)
    && ['BEARISH', 'MILD_BEAR'].includes(frames.H1?.trend || frames.D?.trend);

  let consensus = 'SIDEWAYS';
  let score = 0;
  if (alignedBull) { consensus = 'BULLISH'; score = 28; }
  else if (alignedBear) { consensus = 'BEARISH'; score = 28; }
  else if (frames.D?.trend === 'BULLISH') { consensus = 'MILD_BULL'; score = 10; }
  else if (frames.D?.trend === 'BEARISH') { consensus = 'MILD_BEAR'; score = 10; }

  const last = frames.m5?.last || frames.D?.last;
  return {
    consensus,
    score,
    last,
    vwap,
    frames: {
      m5: frames.m5?.trend,
      m15: frames.m15?.trend,
      H1: frames.H1?.trend,
      D: frames.D?.trend,
    },
    detail: `5m ${frames.m5?.trend} · 15m ${frames.m15?.trend} · 1H ${frames.H1?.trend} · D ${frames.D?.trend}${vwap ? ` · VWAP ${vwap}` : ''}`,
  };
}

function noTrade(reason) {
  return {
    status: 'NO_TRADE',
    reason,
    probabilityPct: null,
    confidence: 'NONE',
    playbook: null,
  };
}

function buildPlaybook({ dir, strike, expiry, entry, sl, t1, t2, rr, probability, lot, lots, maxRisk, index, spot, holdHint }) {
  return {
    action: dir === 'CE' ? 'BUY CALL (CE)' : 'BUY PUT (PE)',
    when: dir === 'CE'
      ? 'Sirf jab structure bullish + PCR/volume support; FOMO gap-up chase mat karo'
      : 'Sirf jab structure bearish + weakness confirm; panic spike pe mat kudo',
    index: index.key,
    instrument: `${index.key} ${strike} ${dir} ${expiry || ''}`.trim(),
    strike,
    side: dir,
    expiry,
    entryZone: entry != null ? `₹${entry} (ATM LTP ke paas; spread tight ho)` : null,
    stopLoss: sl != null ? `₹${sl} (premium) — hit pe exit, average mat karo` : null,
    target1: t1 != null ? `₹${t1} (~partial book)` : null,
    target2: t2 != null ? `₹${t2} (runner / trail)` : null,
    riskReward: `1:${rr}`,
    chanceUpApprox: `${probability}% filtered confidence (guarantee nahi)`,
    holdTime: holdHint,
    lots: lots,
    lotSize: lot,
    quantity: lot && lots ? lot * lots : null,
    maxRiskInr: maxRisk,
    spotRef: spot,
    rules: [
      'SL pehle set karo',
      'T1 pe 50–70% book, baaki trail',
      'News/event candle pe size ghatao',
      'Revenge trade mat — cooldown follow karo',
    ],
  };
}

function buildSetup({ index, mtf, chainSummary, marketTrend, spot, riskGate }) {
  const reasons = [];
  const risks = [];

  if (!sessionOpen()) return noTrade('Market closed / outside 9:15–15:30 IST');
  if (riskGate && !riskGate.ok) return noTrade(riskGate.reason);

  if (!mtf || mtf.consensus === 'SIDEWAYS' || mtf.score < 10) {
    return noTrade('Multi-TF unclear / sideways — NO TRADE');
  }

  let dir = null;
  if (mtf.consensus === 'BULLISH' || mtf.consensus === 'MILD_BULL') dir = 'CE';
  else if (mtf.consensus === 'BEARISH' || mtf.consensus === 'MILD_BEAR') dir = 'PE';
  else return noTrade('No directional consensus');

  let probability = 42 + mtf.score;
  reasons.push(`MTF consensus ${mtf.consensus}: ${mtf.detail}`);

  if (mtf.vwap != null && spot != null) {
    if (dir === 'CE' && spot >= mtf.vwap) {
      probability += 6;
      reasons.push(`Price ≥ VWAP (${mtf.vwap})`);
    } else if (dir === 'PE' && spot <= mtf.vwap) {
      probability += 6;
      reasons.push(`Price ≤ VWAP (${mtf.vwap})`);
    } else {
      probability -= 6;
      risks.push('Price vs VWAP against bias');
    }
  }

  const mdir = String(marketTrend?.trend || marketTrend?.todayDirection || '').toLowerCase();
  if (dir === 'CE' && /bear/.test(mdir)) { probability -= 12; risks.push('Broader market soft vs CE'); }
  if (dir === 'PE' && /bull/.test(mdir)) { probability -= 12; risks.push('Broader market firm vs PE'); }

  if (isExpiryLikelyThursday() && istNow().hour >= 13) {
    probability -= 10;
    risks.push('Expiry afternoon — gamma/theta hostile; size down or skip');
  }
  if (istNow().hour >= 14 && istNow().minute >= 30) {
    probability -= 8;
    risks.push('Last 60m — prefer no new positions');
  }

  if (!chainSummary) {
    return noTrade('Option chain unavailable — CE/PE premium/strike guess nahi karenge');
  }

  if (chainSummary.pcr != null) {
    if (dir === 'CE' && chainSummary.pcr >= 1.0) { probability += 8; reasons.push(`PCR ${chainSummary.pcr}`); }
    else if (dir === 'PE' && chainSummary.pcr <= 0.9) { probability += 8; reasons.push(`PCR ${chainSummary.pcr}`); }
    else { probability -= 5; risks.push(`PCR ${chainSummary.pcr} mixed vs ${dir}`); }
  }

  const leg = dir === 'CE' ? chainSummary.atmCe : chainSummary.atmPe;
  const strike = chainSummary.atm;
  const entry = leg?.ltp;
  const iv = leg?.iv;
  const expiry = chainSummary.expiry;

  if (entry == null || entry <= 0 || strike == null) {
    return noTrade('ATM option LTP missing — NO TRADE');
  }
  if (iv != null && iv > 40) { probability -= 12; risks.push(`IV ${iv} high — premium rich`); }
  if ((leg.volume || 0) < 300) { probability -= 10; risks.push('Thin option volume'); }
  const spread = dir === 'CE' ? chainSummary.atmCeSpreadPct : chainSummary.atmPeSpreadPct;
  if (spread != null && spread > 10) { probability -= 12; risks.push(`Spread ~${spread.toFixed(1)}%`); }

  // Premium plan
  const sl = Number((entry * 0.72).toFixed(2));
  const t1 = Number((entry * 1.4).toFixed(2));
  const t2 = Number((entry * 1.85).toFixed(2));
  const risk = entry - sl;
  const reward = t1 - entry;
  const rr = risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
  if (rr < MIN_RR) return noTrade(`R:R ${rr} < ${MIN_RR}`);

  probability = Math.max(18, Math.min(76, Math.round(probability)));
  if (probability < 54) return noTrade(`Confidence ${probability}% below bar after filters`);

  let confidence = 'LOW';
  if (probability >= 60) confidence = 'MEDIUM';
  if (probability >= 68 && rr >= PREFER_RR) confidence = 'HIGH';

  const lot = chainSummary.lot || lotFor(index.key);
  let lots = null; let qty = null; let maxRisk = MAX_RISK_INR;
  if (lot && risk > 0) {
    lots = Math.max(1, Math.floor(MAX_RISK_INR / (risk * lot)));
    if (lots < 1) return noTrade('1 lot also exceeds max ₹ risk');
    // Cap 2 lots for safety
    lots = Math.min(lots, 2);
    qty = lots * lot;
    maxRisk = Number((risk * qty).toFixed(0));
  }

  const holdHint = isExpiryLikelyThursday()
    ? 'Intraday only — expiry day pe overnight avoid'
    : 'Intraday to same-day; overnight only if strong T1+ and trail active (default square-off bias)';

  const playbook = buildPlaybook({
    dir, strike, expiry, entry, sl, t1, t2, rr, probability, lot, lots, maxRisk, index, spot, holdHint,
  });

  return {
    status: 'TRADE',
    index: index.key,
    indexLabel: index.label,
    side: dir,
    strike,
    expiry,
    entry,
    stopLoss: sl,
    target1: t1,
    target2: t2,
    riskReward: rr,
    quantity: qty,
    lots,
    lotSize: lot,
    maxRiskInr: maxRisk,
    probabilityPct: probability,
    confidence,
    reasons,
    invalidation: `Premium ≤ ₹${sl} OR index breaks against ${dir} (CE: lose VWAP/support; PE: reclaim VWAP/resistance)`,
    riskWarnings: risks,
    iv,
    pcr: chainSummary.pcr,
    playbook,
    howTo: {
      putOrCall: dir === 'CE' ? 'CALL lo (CE)' : 'PUT lo (PE)',
      stop: `Premium SL ₹${sl}`,
      chanceUp: `~${probability}% (model confidence, not guarantee)`,
      hold: holdHint,
      book: `T1 ₹${t1} pe partial; T2 ₹${t2} trail`,
    },
  };
}

async function analyzeIndex(index, marketTrend, riskGate) {
  let quote = null;
  try { quote = await marketData.getQuote(index.yahoo); } catch (_) {}
  const spot = quote?.lastPrice ?? quote?.regularMarketPrice ?? null;

  const mtf = await loadMtf(index.yahoo);
  if (spot) mtf.last = spot;

  let chainSummary = null;
  let chainError = null;
  let chainUi = null;
  let chainMode = 'live';
  const chainRes = await fetchNseOptionChain(index.nseSymbol);
  if (chainRes.ok) {
    const parsed = parseChain(chainRes.raw, spot);
    if (parsed) {
      const exp = pickBestExpiry(parsed);
      chainSummary = summarizeExpiry(parsed, exp, parsed.spot || spot);
      if (chainSummary?.lot) setLotFallback(index.key, chainSummary.lot);
      chainUi = {
        demo: false,
        source: 'nse',
        expiry: chainSummary.expiry,
        atm: chainSummary.atm,
        pcr: chainSummary.pcr,
        rows: (chainSummary.rows || []).filter((row) => {
          const s = spot || mtf.last;
          return s && Math.abs(row.strike - s) / s <= 0.04;
        }).slice(0, 21),
      };
    }
  } else chainError = chainRes.error;

  // DEMO chain if live missing — paper trade only
  if (!chainSummary && (spot || mtf.last)) {
    const syn = buildSyntheticChain(index.key, spot || mtf.last);
    if (syn) {
      chainMode = 'demo';
      const atmCe = syn.calls.find((c) => c.strike === syn.atm);
      const atmPe = syn.puts.find((p) => p.strike === syn.atm);
      chainSummary = {
        expiry: syn.expiry,
        atm: syn.atm,
        pcr: syn.pcr,
        atmCe,
        atmPe,
        maxCallOiStrike: syn.atm,
        maxPutOiStrike: syn.atm,
        atmCeSpreadPct: 2,
        atmPeSpreadPct: 2,
        lot: lotFor(index.key),
        demo: true,
      };
      chainUi = {
        demo: true,
        source: 'synthetic-demo',
        warning: syn.warning,
        expiry: syn.expiry,
        atm: syn.atm,
        pcr: syn.pcr,
        rows: syn.rows,
      };
    }
  }

  let setup = buildSetup({
    index, mtf, chainSummary, marketTrend, spot: spot || mtf.last, riskGate,
  });
  // Tag demo setups
  if (setup.status === 'TRADE' && chainMode === 'demo') {
    setup = {
      ...setup,
      demo: true,
      riskWarnings: [...(setup.riskWarnings || []), 'DEMO premiums — paper trade only, not live exchange quotes'],
      playbook: setup.playbook
        ? { ...setup.playbook, rules: [...(setup.playbook.rules || []), 'DEMO mode: real capital mat lagao'] }
        : setup.playbook,
    };
  }

  // Default lot fallbacks for paper (env still preferred)
  const defaultLots = { NIFTY: 25, BANKNIFTY: 15, SENSEX: 10 };
  if (setup.lotSize == null && setup.status === 'TRADE') {
    const L = lotFor(index.key) || defaultLots[index.key];
    if (L && setup.entry && setup.stopLoss) {
      const risk = setup.entry - setup.stopLoss;
      let lots = Math.max(1, Math.floor((Number(process.env.FO_MAX_RISK_INR || 2000)) / (risk * L)));
      lots = Math.min(lots, 2);
      setup.lotSize = L;
      setup.lots = lots;
      setup.quantity = lots * L;
      setup.maxRiskInr = Number((risk * setup.quantity).toFixed(0));
      if (setup.playbook) {
        setup.playbook.lots = lots;
        setup.playbook.lotSize = L;
        setup.playbook.quantity = setup.quantity;
        setup.playbook.maxRiskInr = setup.maxRiskInr;
      }
    }
  }

  return {
    index: index.key,
    label: index.label,
    priority: index.priority,
    spot: spot || mtf.last,
    mtf: {
      consensus: mtf.consensus,
      detail: mtf.detail,
      frames: mtf.frames,
      vwap: mtf.vwap,
    },
    chain: chainUi
      ? {
          available: true,
          demo: chainUi.demo,
          source: chainUi.source,
          warning: chainUi.warning || null,
          expiry: chainUi.expiry,
          atm: chainUi.atm,
          pcr: chainUi.pcr,
          maxCallOi: chainSummary?.maxCallOiStrike,
          maxPutOi: chainSummary?.maxPutOiStrike,
          rows: chainUi.rows,
        }
      : { available: false, error: chainError || 'unavailable' },
    setup,
  };
}

async function runFnoIntelligence(userId = 'global') {
  let marketTrend = null;
  try { marketTrend = await getMarketTrend(); } catch (_) {}

  const state = await riskState.getState(userId);
  const riskGate = riskState.canTrade(state);

  const ranked = [];
  for (const index of [...INDEXES].sort((a, b) => a.priority - b.priority)) {
    try {
      ranked.push(await analyzeIndex(index, marketTrend, riskGate));
    } catch (err) {
      ranked.push({
        index: index.key, label: index.label, priority: index.priority,
        error: err.message, setup: noTrade(err.message),
      });
    }
  }

  const trades = ranked
    .filter((r) => r.setup?.status === 'TRADE')
    .sort((a, b) => {
      const pa = (a.setup.probabilityPct || 0) * Math.min(a.setup.riskReward || 1, 3);
      const pb = (b.setup.probabilityPct || 0) * Math.min(b.setup.riskReward || 1, 3);
      if (pb !== pa) return pb - pa;
      return a.priority - b.priority;
    });

  const best = trades[0] || null;

  return {
    asOf: new Date().toISOString(),
    sessionOpen: sessionOpen(),
    marketTrend: marketTrend?.trend || marketTrend?.todayDirection || null,
    riskState: {
      tradesToday: state.trades || 0,
      realizedPnl: state.realizedPnl || 0,
      consecutiveLosses: state.consecutiveLosses || 0,
      canTrade: riskGate.ok,
      blockReason: riskGate.ok ? null : riskGate.reason,
      limits: state.limits,
    },
    maxRiskInrDefault: MAX_RISK_INR,
    minRr: MIN_RR,
    honesty: [
      'Probability = filtered confidence, guaranteed profit nahi.',
      '5m/15m/1H Yahoo se; chain NSE best-effort (block ho to NO TRADE).',
      'Greeks approximate / limited without full model.',
      'Scan only when you open F&O Desk and press Scan — no background load.',
    ],
    indexes: ranked,
    recommendation: best
      ? {
          status: 'TRADE',
          selected: best.index,
          ...best.setup,
          spot: best.spot,
          compared: ranked.map((r) => ({
            index: r.index,
            status: r.setup?.status,
            probabilityPct: r.setup?.probabilityPct,
            reason: r.setup?.reason || r.setup?.reasons?.[0],
          })),
        }
      : {
          status: 'NO_TRADE',
          reason: !riskGate.ok
            ? riskGate.reason
            : (ranked.find((r) => r.setup?.reason)?.setup?.reason || 'No index cleared filters'),
          compared: ranked.map((r) => ({
            index: r.index,
            status: r.setup?.status,
            reason: r.setup?.reason || 'filtered',
          })),
        },
  };
}

module.exports = { runFnoIntelligence, MAX_RISK_INR };
