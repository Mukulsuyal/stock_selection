/**
 * F&O day risk state — consecutive losses / daily loss / cooldown.
 * Additive Mongo collection; fails soft without Mongo.
 */
const mongoose = require('mongoose');
const { isMongoConfigured } = require('../mongo');

let Model;
function model() {
  if (Model) return Model;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    userId: { type: String, index: true },
    tradeDate: { type: String, index: true }, // YYYY-MM-DD IST
    trades: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    consecutiveLosses: { type: Number, default: 0 },
    cooldownUntil: { type: Date, default: null },
    lastOutcome: { type: String, default: null },
  }, { collection: 'fno_risk_state' });
  schema.index({ userId: 1, tradeDate: 1 }, { unique: true });
  Model = mongoose.models.FnoRiskState || mongoose.model('FnoRiskState', schema);
  return Model;
}

function istDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function getState(userId = 'global') {
  const M = model();
  if (!M) {
    return {
      trades: 0, realizedPnl: 0, consecutiveLosses: 0, cooldownUntil: null,
      limits: defaultLimits(), source: 'memory',
    };
  }
  const tradeDate = istDateStr();
  let row = await M.findOne({ userId, tradeDate }).lean();
  if (!row) row = { trades: 0, realizedPnl: 0, consecutiveLosses: 0, cooldownUntil: null };
  return { ...row, tradeDate, limits: defaultLimits(), source: 'db' };
}

function defaultLimits() {
  return {
    maxTradesDay: Number(process.env.FO_MAX_TRADES_DAY || 2),
    maxDailyLossInr: Number(process.env.FO_MAX_DAILY_LOSS_INR || 3000),
    maxConsecutiveLosses: Number(process.env.FO_MAX_CONSEC_LOSS || 2),
    cooldownMinutes: Number(process.env.FO_COOLDOWN_MIN || 45),
  };
}

function canTrade(state) {
  const L = state.limits || defaultLimits();
  if (state.cooldownUntil && new Date(state.cooldownUntil) > new Date()) {
    return { ok: false, reason: `Cooldown until ${new Date(state.cooldownUntil).toLocaleTimeString('en-IN')}` };
  }
  if ((state.trades || 0) >= L.maxTradesDay) {
    return { ok: false, reason: `Max trades/day (${L.maxTradesDay}) reached` };
  }
  if ((state.realizedPnl || 0) <= -Math.abs(L.maxDailyLossInr)) {
    return { ok: false, reason: `Daily loss limit ₹${L.maxDailyLossInr} hit` };
  }
  if ((state.consecutiveLosses || 0) >= L.maxConsecutiveLosses) {
    return { ok: false, reason: `${L.maxConsecutiveLosses} consecutive losses — stop for today` };
  }
  return { ok: true };
}

async function recordOutcome(userId, { pnl = 0 } = {}) {
  const M = model();
  if (!M) return { ok: false, reason: 'no_mongo' };
  const tradeDate = istDateStr();
  const loss = pnl < 0;
  const L = defaultLimits();
  const update = {
    $inc: { trades: 1, realizedPnl: pnl },
    $set: { lastOutcome: loss ? 'loss' : 'win' },
  };
  if (loss) {
    update.$inc.consecutiveLosses = 1;
    update.$set.cooldownUntil = new Date(Date.now() + L.cooldownMinutes * 60 * 1000);
  } else {
    update.$set.consecutiveLosses = 0;
    update.$set.cooldownUntil = null;
  }
  await M.updateOne({ userId, tradeDate }, update, { upsert: true });
  return { ok: true };
}

module.exports = { getState, canTrade, recordOutcome, defaultLimits, istDateStr };
