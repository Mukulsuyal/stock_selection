/**
 * Morning Storm persistence: same-day sticky picks + track record.
 * Collection: morning_storm_picks
 */
const mongoose = require('mongoose');
const { isMongoConfigured } = require('./mongo');

let Model;
function model() {
  if (Model) return Model;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    tradeDate: { type: String, index: true }, // YYYY-MM-DD IST
    symbol: { type: String, index: true },
    status: { type: String, default: 'active' }, // active | rotated | closed
    firstSeenAt: Date,
    firstPrice: Number,
    lastPrice: Number,
    dayPctAtFirst: Number,
    stormScore: Number,
    signalStage: String,
    signalScore: Number,
    action: String,
    t1BiasLabel: String,
    t1BiasUp: Number,
    archetype: String,
    setupType: String,
    marketTrend: String,
    windowPhase: String,
    plan: mongoose.Schema.Types.Mixed,
    reasons: [String],
    risks: [String],
    // outcomes (filled EOD / later)
    outcome: { type: String, default: 'pending' }, // pending | t1_hit | t2_hit | t3_hit | stopped | faded | expired
    maxFavorablePct: Number,
    maxAdversePct: Number,
    endDayPctFromEntry: Number,
    resolvedAt: Date,
    scenarioTags: [String],
    userStance: { type: String, default: 'open' }, // open | hold_to_sl3 | booked_partial | carry | carry_after_t2 | exited
    t1Hit: { type: Boolean, default: false },
    t2Hit: { type: Boolean, default: false },
    t3Hit: { type: Boolean, default: false },
    managedPlan: mongoose.Schema.Types.Mixed,
    lastAdvice: mongoose.Schema.Types.Mixed,
    carryToNextDay: { type: Boolean, default: false },
  }, { collection: 'morning_storm_picks', timestamps: true });
  schema.index({ tradeDate: 1, symbol: 1 }, { unique: true });
  Model = mongoose.models.MorningStormPick || mongoose.model('MorningStormPick', schema);
  return Model;
}

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function upsertTodaysPicks(picks, meta = {}) {
  const M = model();
  if (!M || !picks?.length) return { saved: 0 };
  const tradeDate = todayIST();
  let saved = 0;
  const seen = new Set();
  for (const p of picks) {
    seen.add(p.symbol);
    const existing = await M.findOne({ tradeDate, symbol: p.symbol }).lean();
    if (existing) {
      await M.updateOne(
        { _id: existing._id },
        {
          $set: {
            lastPrice: p.price,
            status: 'active',
            stormScore: p.stormScore,
            signalStage: p.signalStage,
            signalScore: p.signalScore || p.earlyBoomScore,
            action: p.action,
            // firstSeenAt / firstPrice NEVER overwritten — no sample inflation
          },
        }
      );
    } else {
      await M.create({
        tradeDate,
        symbol: p.symbol,
        status: 'active',
        firstSeenAt: new Date(),
        firstPrice: p.price,
        lastPrice: p.price,
        dayPctAtFirst: p.dayPct,
        stormScore: p.stormScore,
        signalStage: p.signalStage,
        signalScore: p.signalScore || p.earlyBoomScore,
        action: p.action,
        t1BiasLabel: p.t1Bias?.label,
        t1BiasUp: p.t1Bias?.up,
        archetype: p.archetype?.key || p.archetype?.label,
        setupType: p.setupType,
        marketTrend: meta.marketTrend || null,
        windowPhase: meta.windowPhase || null,
        plan: p.plan,
        reasons: p.reasons || [],
        risks: p.risks || [],
        managedPlan: p.managedPlan || null,
        lastAdvice: p.management || null,
        outcome: 'pending',
        scenarioTags: [
          meta.marketTrend || 'unknown_trend',
          p.archetype?.key || 'arch',
          p.t1Bias?.label || 'bias',
        ],
      });
      saved += 1;
    }
  }
  // Mark today's actives not in current scan as rotated (still visible in history)
  await M.updateMany(
    { tradeDate, status: 'active', symbol: { $nin: [...seen] } },
    { $set: { status: 'rotated' } }
  );
  return { saved, tradeDate };
}

async function getTodayBoard() {
  const M = model();
  if (!M) return { active: [], rotated: [], tradeDate: todayIST() };
  const tradeDate = todayIST();
  const rows = await M.find({ tradeDate }).sort({ firstSeenAt: 1 }).lean();
  return {
    tradeDate,
    active: rows.filter((r) => r.status === 'active'),
    rotated: rows.filter((r) => r.status === 'rotated'),
    all: rows,
  };
}

async function resolvePendingOutcomes() {
  const marketData = require('./marketData');
  const M = model();
  if (!M) return { updated: 0 };
  const pending = await M.find({ outcome: 'pending' }).sort({ tradeDate: -1 }).limit(40).lean();
  let updated = 0;
  const today = todayIST();
  for (const row of pending) {
    // Only resolve past days fully; today can update MFE/MAE soft
    try {
      const q = await marketData.getQuote(row.symbol);
      const px = q?.lastPrice;
      if (px == null || row.firstPrice == null) continue;
      const chg = ((px - row.firstPrice) / row.firstPrice) * 100;
      const plan = row.plan || {};
      let outcome = row.outcome;
      if (plan.target3 && px >= plan.target3) outcome = 't3_hit';
      else if (plan.target2 && px >= plan.target2) outcome = 't2_hit';
      else if (plan.target1 && px >= plan.target1) outcome = 't1_hit';
      else if (plan.stopLoss && px <= plan.stopLoss) outcome = 'stopped';
      else if (row.tradeDate < today) outcome = chg >= 0.5 ? 't1_hit' : (chg <= -0.8 ? 'stopped' : 'faded');

      const set = {
        lastPrice: px,
        endDayPctFromEntry: Number(chg.toFixed(2)),
        maxFavorablePct: Math.max(row.maxFavorablePct || -999, chg),
        maxAdversePct: Math.min(row.maxAdversePct == null ? 999 : row.maxAdversePct, chg),
      };
      if (outcome !== 'pending' && row.tradeDate < today) {
        set.outcome = outcome;
        set.resolvedAt = new Date();
        set.status = 'closed';
      } else if (outcome === 't1_hit' || outcome === 't2_hit' || outcome === 't3_hit' || outcome === 'stopped') {
        // same-day target/SL touch
        set.outcome = outcome;
        set.resolvedAt = new Date();
      }
      await M.updateOne({ _id: row._id }, { $set: set });
      updated += 1;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { updated };
}

async function getTrackRecord() {
  const M = model();
  if (!M) return { ok: false, reason: 'mongo_not_configured' };
  await resolvePendingOutcomes().catch(() => {});
  const rows = await M.find({ outcome: { $ne: 'pending' } }).lean();
  const pending = await M.countDocuments({ outcome: 'pending' });
  const blank = () => ({ n: 0, wins: 0, stops: 0, faded: 0, sumRet: 0, sumMfe: 0, nMfe: 0, sumMae: 0, nMae: 0 });
  const overall = blank();
  const byScenario = {};
  for (const r of rows) {
    const ret = r.endDayPctFromEntry;
    const win = r.outcome === 't1_hit' || r.outcome === 't2_hit' || r.outcome === 't3_hit';
    overall.n += 1;
    if (win) overall.wins += 1;
    if (r.outcome === 'stopped') overall.stops += 1;
    if (r.outcome === 'faded') overall.faded += 1;
    if (ret != null) overall.sumRet += ret;
    if (r.maxFavorablePct != null) { overall.sumMfe += r.maxFavorablePct; overall.nMfe += 1; }
    if (r.maxAdversePct != null && r.maxAdversePct < 500) { overall.sumMae += r.maxAdversePct; overall.nMae += 1; }
    for (const tag of r.scenarioTags || [r.marketTrend || 'unknown']) {
      const b = byScenario[tag] || blank();
      b.n += 1;
      if (win) b.wins += 1;
      if (r.outcome === 'stopped') b.stops += 1;
      if (r.outcome === 'faded') b.faded += 1;
      if (ret != null) b.sumRet += ret;
      byScenario[tag] = b;
    }
  }
  const fmt = (b) => ({
    sample: b.n,
    winRatePct: b.n ? Number(((b.wins / b.n) * 100).toFixed(1)) : null,
    stopRatePct: b.n ? Number(((b.stops / b.n) * 100).toFixed(1)) : null,
    fadedRatePct: b.n ? Number(((b.faded / b.n) * 100).toFixed(1)) : null,
    avgReturnPct: b.n ? Number((b.sumRet / b.n).toFixed(2)) : null,
    avgMaxFavorablePct: b.nMfe ? Number((b.sumMfe / b.nMfe).toFixed(2)) : null,
    avgMaxAdversePct: b.nMae ? Number((b.sumMae / b.nMae).toFixed(2)) : null,
  });
  return {
    ok: true,
    pending,
    overall: fmt(overall),
    byScenario: Object.fromEntries(
      Object.entries(byScenario).map(([k, v]) => [k, fmt(v)])
    ),
    note: 'Win = T1/T2/T3 hit from first seen price. Sample chhota ho to % stable nahi. Guarantee nahi.',
  };
}

async function confirmUserAction(symbol, action, tradeDate = null) {
  const M = model();
  if (!M) return { ok: false, reason: 'mongo_not_configured' };
  const date = tradeDate || todayIST();
  const row = await M.findOne({ tradeDate: date, symbol: String(symbol).toUpperCase() });
  if (!row) {
    // try latest active
    const latest = await M.findOne({ symbol: String(symbol).toUpperCase() }).sort({ tradeDate: -1 });
    if (!latest) return { ok: false, reason: 'pick_not_found' };
    return applyAction(latest, action);
  }
  return applyAction(row, action);
}

async function applyAction(row, action) {
  const M = model();
  const set = {};
  const a = String(action || '').toLowerCase();
  if (a === 'exit' || a === 'book_full' || a === 'book_loss') {
    set.userStance = 'exited';
    set.status = 'closed';
    set.outcome = a === 'book_full' ? 't1_hit' : (a === 'book_loss' ? 'stopped' : 'faded');
    set.resolvedAt = new Date();
    set.carryToNextDay = false;
  } else if (a === 'hold' || a === 'hold_to_sl3') {
    set.userStance = 'hold_to_sl3';
  } else if (a === 'book_partial') {
    set.userStance = 'booked_partial';
    set.t1Hit = true;
  } else if (a === 'carry') {
    set.userStance = 'carry';
    set.carryToNextDay = true;
  } else if (a === 'carry_trail') {
    set.userStance = 'carry_after_t2';
    set.t2Hit = true;
    set.carryToNextDay = true;
  }
  await M.updateOne({ _id: row._id }, { $set: set });
  return { ok: true, symbol: row.symbol, tradeDate: row.tradeDate, userStance: set.userStance || row.userStance };
}

async function getMonitorBoard() {
  const M = model();
  if (!M) return { today: [], carry: [] };
  const tradeDate = todayIST();
  const today = await M.find({ tradeDate, status: { $in: ['active', 'rotated'] } }).lean();
  const carry = await M.find({
    carryToNextDay: true,
    userStance: { $in: ['carry', 'carry_after_t2', 'booked_partial', 'hold_to_sl3', 'open'] },
    status: { $ne: 'closed' },
  }).sort({ tradeDate: -1 }).limit(20).lean();
  return { tradeDate, today, carry };
}

module.exports = {
  upsertTodaysPicks,
  getTodayBoard,
  getTrackRecord,
  resolvePendingOutcomes,
  todayIST,
  confirmUserAction,
  getMonitorBoard,
};
