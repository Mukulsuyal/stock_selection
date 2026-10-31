/**
 * System-level Morning Storm price watches (no user required).
 * alertChecker polls these alongside user alerts.
 * Collection: morning_storm_watches
 */
const mongoose = require('mongoose');
const { isMongoConfigured } = require('./mongo');

let Watch;
function model() {
  if (Watch) return Watch;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    symbol: { type: String, index: true },
    tradeDate: String,
    condition: { type: String, enum: ['above', 'below'] },
    targetPrice: Number,
    tag: String, // SL2 SL3 T1 T2 TRAIL
    isActive: { type: Boolean, default: true },
    triggeredAt: Date,
    note: String,
  }, { collection: 'morning_storm_watches', timestamps: true });
  schema.index({ symbol: 1, tag: 1, tradeDate: 1 });
  Watch = mongoose.models.MorningStormWatch || mongoose.model('MorningStormWatch', schema);
  return Watch;
}

async function ensureWatchesForPick(pick, tradeDate) {
  const M = model();
  if (!M || !pick?.symbol || !pick.managedPlan) return { created: 0 };
  const mp = pick.managedPlan;
  const levels = [
    { condition: 'below', targetPrice: mp.stop2, tag: 'SL2' },
    { condition: 'below', targetPrice: mp.stop3, tag: 'SL3' },
    { condition: 'above', targetPrice: mp.target1, tag: 'T1' },
    { condition: 'above', targetPrice: mp.target2, tag: 'T2' },
    { condition: 'above', targetPrice: mp.target3, tag: 'T3' },
    { condition: 'below', targetPrice: mp.trailAfterT2, tag: 'TRAIL' },
  ];
  let created = 0;
  for (const lv of levels) {
    if (lv.targetPrice == null) continue;
    const existing = await M.findOne({
      symbol: pick.symbol,
      tradeDate,
      tag: lv.tag,
      isActive: true,
    });
    if (existing) {
      await M.updateOne({ _id: existing._id }, { $set: { targetPrice: lv.targetPrice } });
      continue;
    }
    await M.create({
      symbol: pick.symbol,
      tradeDate,
      condition: lv.condition,
      targetPrice: lv.targetPrice,
      tag: lv.tag,
      isActive: true,
      note: `MorningStorm ${lv.tag}`,
    });
    created += 1;
  }
  return { created };
}

async function getActiveWatches() {
  const M = model();
  if (!M) return [];
  return M.find({ isActive: true }).lean();
}

async function markTriggered(id, price) {
  const M = model();
  if (!M) return;
  await M.updateOne({ _id: id }, { $set: { isActive: false, triggeredAt: new Date(), note: `hit @ ${price}` } });
}

async function recentTriggers(limit = 15) {
  const M = model();
  if (!M) return [];
  return M.find({ triggeredAt: { $ne: null } }).sort({ triggeredAt: -1 }).limit(limit).lean();
}

module.exports = { ensureWatchesForPick, getActiveWatches, markTriggered, recentTriggers };
