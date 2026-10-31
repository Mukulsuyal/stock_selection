// server/recommendations/RemovalEvent.js
// Logs exactly when a stock drops out of a daily pick category, with a
// concrete reason (score dropped, setup invalidated, or simply displaced
// by stronger candidates) - so "ye hat gaya" always comes with "kyun".
const mongoose = require('mongoose');
const { Schema } = mongoose;

const removalEventSchema = new Schema({
  symbol: { type: String, required: true, index: true },
  category: { type: String, required: true, index: true },
  removedDate: { type: String, required: true, index: true }, // YYYY-MM-DD
  lastRecommendedDate: { type: String, default: null },
  lastRecommendedPrice: { type: Number, default: null },
  priceAtRemoval: { type: Number, default: null },
  changePctSinceRecommended: { type: Number, default: null },
  reason: { type: String, required: true },
  // "Even though it's gone from the list, how likely is it, historically on
  // THIS stock, to still go on and reach the price it was recommended at
  // (or beyond) within the next 1/7/15/30 days?" - carried over from
  // targetTimeline at the moment of removal, so a weak-and-fading pick and
  // a still-promising-but-displaced pick read very differently even though
  // both just show up as "removed".
  outlookProb7d: { type: Number, default: null },
  outlookProb15d: { type: Number, default: null },
  outlookProb30d: { type: Number, default: null },
  outlookSampleSize: { type: Number, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

module.exports = mongoose.models.RemovalEvent || mongoose.model('RemovalEvent', removalEventSchema);
