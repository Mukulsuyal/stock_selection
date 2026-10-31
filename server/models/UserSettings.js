// server/models/UserSettings.js — per-user configurable risk/trading rules.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const settingsSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  capital: { type: Number, default: 100000 },
  riskPerTradePct: { type: Number, default: 1 },
  minRiskReward: { type: Number, default: 2 },
  maxDailyLossPct: { type: Number, default: 3 },
  maxTradesPerDay: { type: Number, default: 5 },
  cooldownMinutes: { type: Number, default: 30 },
  maxSectorExposurePct: { type: Number, default: 40 },
  maxStockExposurePct: { type: Number, default: 20 },
  minDataConfidence: { type: Number, default: 50 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const SettingsModel = mongoose.models.UserSettings || mongoose.model('UserSettings', settingsSchema);

const DEFAULTS = {
  capital: 100000, riskPerTradePct: 1, minRiskReward: 2, maxDailyLossPct: 3,
  maxTradesPerDay: 5, cooldownMinutes: 30, maxSectorExposurePct: 40,
  maxStockExposurePct: 20, minDataConfidence: 50,
};

const UserSettings = {
  defaults: DEFAULTS,
  async getFor(userId) {
    const doc = await SettingsModel.findOne({ user_id: userId }).lean();
    if (!doc) return { ...DEFAULTS };
    const { _id, user_id, created_at, updated_at, __v, ...rest } = doc;
    return { ...DEFAULTS, ...rest };
  },
  async update(userId, patch) {
    const allowed = Object.keys(DEFAULTS);
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = Number(patch[k]);
    const doc = await SettingsModel.findOneAndUpdate(
      { user_id: userId },
      { $set: clean, $setOnInsert: { user_id: userId } },
      { upsert: true, new: true }
    ).lean();
    const { _id, user_id, created_at, updated_at, __v, ...rest } = doc;
    return { ...DEFAULTS, ...rest };
  },
};

module.exports = UserSettings;
