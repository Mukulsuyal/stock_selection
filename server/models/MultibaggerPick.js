// Deep conviction multi-bagger radar — max 1–2 names per batch, not a daily list.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const multibaggerPickSchema = new Schema({
  batchDate: { type: String, required: true, index: true }, // YYYY-MM-DD research run
  horizonDays: { type: Number, default: 90 }, // intended hold window (not a guarantee)
  rank: { type: Number, required: true }, // 1 or 2
  symbol: { type: String, required: true },
  indexLabel: { type: String, default: null },
  companyName: { type: String, default: null },
  sector: { type: String, default: null },

  priceAtResearch: { type: Number, required: true },
  entryLow: { type: Number, default: null },
  entryHigh: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  target1: { type: Number, default: null }, // ~1.5–2x risk
  target2: { type: Number, default: null }, // stretch / multi-bag path
  riskRewardRatio: { type: Number, default: null },

  convictionScore: { type: Number, required: true }, // 0–100 composite
  technicalScore: { type: Number, default: null },
  relativeStrength: { type: Number, default: null },
  lossProbability2Pct: { type: Number, default: null },
  profitProbability5Pct: { type: Number, default: null },
  probabilitySampleSize: { type: Number, default: null },

  thesis: { type: String, default: '' }, // plain-language deep why
  bullCase: { type: String, default: '' },
  bearCase: { type: String, default: '' },
  invalidation: { type: String, default: '' },
  topFactors: { type: [{ factor: String, signal: String, _id: false }], default: [] },
  fundamentalsSnapshot: { type: Schema.Types.Mixed, default: null },
  marketBackdrop: { type: String, default: null },
  newsHeadlines: { type: [String], default: [] },

  latestPrice: { type: Number, default: null },
  latestPriceDate: { type: String, default: null },
  changePct: { type: Number, default: null },
  status: { type: String, default: 'open' }, // open | removed | hit_t1 | hit_t2 | stopped | expired
  removedDate: { type: String, default: null },
  removalReason: { type: String, default: null },
  actionGuidance: { type: String, default: null }, // HOLD / EXIT text
  fundScoreAtPick: { type: Number, default: null },
  scorePillars: { type: Schema.Types.Mixed, default: null },
  passReasons: { type: [String], default: [] },
  failReasons: { type: [String], default: [] },
  confidence: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

multibaggerPickSchema.index({ batchDate: 1, symbol: 1 }, { unique: true });

module.exports = mongoose.models.MultibaggerPick || mongoose.model('MultibaggerPick', multibaggerPickSchema);
