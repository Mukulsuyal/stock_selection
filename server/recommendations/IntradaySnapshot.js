// server/recommendations/IntradaySnapshot.js
// Unlike Recommendation (one row per symbol+category+DAY, used for the
// Track Record win-rate history), this logs EVERY intraday scan
// separately with a full timestamp - so "aaj subah ye bola tha, 2 ghante
// baad ye badal gaya" has an actual record, not just one end-of-day
// snapshot. Kept as a separate collection so it doesn't disturb the
// existing daily Track Record math.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const intradaySnapshotSchema = new Schema({
  symbol: { type: String, required: true, index: true },
  category: { type: String, required: true, index: true },
  snapshotDate: { type: String, required: true, index: true }, // YYYY-MM-DD
  snapshotAt: { type: Date, required: true, index: true },     // full timestamp
  price: { type: Number, required: true },
  verdict: { type: String, default: null },
  score: { type: Number, default: null },
  entryLow: { type: Number, default: null },
  entryHigh: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  target: { type: Number, default: null },
  riskRewardRatio: { type: Number, default: null },
  probabilityUp1PctPlus: { type: Number, default: null },
  probabilityUp5PctPlus: { type: Number, default: null },
  probabilityDown2PctPlus: { type: Number, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

// Not unique on purpose - multiple snapshots per symbol+category+day are
// exactly the point. Indexed for fast "give me today's snapshots" queries.
intradaySnapshotSchema.index({ symbol: 1, category: 1, snapshotDate: 1 });

module.exports = mongoose.models.IntradaySnapshot || mongoose.model('IntradaySnapshot', intradaySnapshotSchema);
