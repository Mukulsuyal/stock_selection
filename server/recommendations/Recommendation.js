// server/recommendations/Recommendation.js
// One row per (symbol, category, date) - a permanent daily log of every
// pick this app has ever surfaced under "Today's best for Intraday / Best
// for Short-Mid-term / Best for Long-term / Momentum / Reversal". Each
// row's `recommendedPrice` is frozen at the price on the day it was
// picked; `latestPrice` is refreshed daily so you can look back and see,
// honestly, how that pick has actually performed over the following
// week/15 days/month - not just today's opinion.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const recommendationSchema = new Schema({
  symbol: { type: String, required: true, index: true },
  category: {
    type: String,
    enum: ['intraday', 'short_term', 'long_term', 'momentum', 'reversal', 'golden_diamond', 'golden_gold', 'golden_silver', 'golden_bronze'],
    required: true, index: true,
  },
  recommendedDate: { type: String, required: true, index: true }, // YYYY-MM-DD, the day it was picked
  recommendedPrice: { type: Number, required: true },
  verdict: { type: String, default: null },
  score: { type: Number, default: null },
  entryLow: { type: Number, default: null },
  entryHigh: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  target: { type: Number, default: null },
  // "2nd target" - an equal further extension beyond the original target
  // (target2 = 2*target - recommendedPrice, i.e. "if it made this move
  // once, did it make the same-size move again"). Simple, not from any
  // official source - purely this app's own follow-through measure.
  target2: { type: Number, default: null },
  riskRewardRatio: { type: Number, default: null },

  // What the app predicted, at pick time, about how long this would take
  // to reach target (see server/probabilityEstimator.js estimateTargetTimeline)
  // - saved here so it can be checked later: "tumne kitne din bola tha,
  // utne din baad wo gaya ya nahi". null if there wasn't enough history on
  // this stock to make that call at the time.
  predictedWindow: { type: String, enum: ['7d', '15d', '30d', '30d_plus', null], default: null },
  predictedWindowDays: { type: Number, default: null }, // 7 / 15 / 30 / Infinity(as null for 30d_plus display) - numeric mirror of predictedWindow for querying

  latestPrice: { type: Number, default: null },
  latestPriceDate: { type: String, default: null },
  changePct: { type: Number, default: null }, // (latestPrice - recommendedPrice) / recommendedPrice * 100

  // Full daily closing-price history since the pick was made - NOT just
  // the latest snapshot. One entry per trading day (the EOD cron itself
  // skips weekends/holidays), so priceHistory[N-1] is effectively "the
  // price N trading days after this was recommended". This is what makes
  // later analysis possible: "what was the win rate for a 7-day hold vs a
  // 30-day hold, looking back over the last 3 months" - answerable without
  // having to have decided that question in advance.
  priceHistory: {
    type: [{ date: String, price: Number, changePct: Number, _id: false }],
    default: [],
  },

  // Did price ever hit the suggested stop-loss, target, or the further
  // "2nd target" since being picked? Each records not just yes/no but the
  // EXACT date, the EXACT price at that moment, and how many TRADING days
  // (see server/marketCalendar.js countTradingDaysBetween) it took from the
  // pick date - so "kab, kis price pe, kitne din mein" is always answerable
  // later, instead of only ever showing today's (possibly since-reversed)
  // price next to a plain hit/not-hit flag.
  hitStopLoss: { type: Boolean, default: false },
  hitTarget: { type: Boolean, default: false },
  hitTarget2: { type: Boolean, default: false },
  hitStopLossDate: { type: String, default: null },
  hitTargetDate: { type: String, default: null },
  hitTarget2Date: { type: String, default: null },
  hitStopLossPrice: { type: Number, default: null }, // actual price on hitStopLossDate, not today's price
  hitTargetPrice: { type: Number, default: null },   // actual price on hitTargetDate, not today's price
  hitTarget2Price: { type: Number, default: null },
  daysToHitStopLoss: { type: Number, default: null },  // TRADING days from recommendedDate to hitStopLossDate
  daysToHitTarget: { type: Number, default: null },
  daysToHitTarget2: { type: Number, default: null },

  // The actual answer to "kya prediction sahi nikla" - computed once the
  // outcome is knowable (target/SL hit, or the predicted window has fully
  // elapsed in TRADING days - see server/marketCalendar.js countTradingDaysBetween).
  windowOutcome: {
    type: String,
    enum: ['pending', 'hit_within_window', 'hit_late', 'stopped_out', 'not_hit_in_window', null],
    default: 'pending',
  },

  // Which exact technical signals justified this pick, at the moment it
  // was picked - feeds server/factorPerformance.js's win/loss crediting
  // once this row resolves. Rows logged before this field existed simply
  // have an empty array here, which the feedback loop already skips over
  // safely (nothing to credit, nothing breaks).
  topFactors: { type: [{ factor: String, signal: String, _id: false }], default: [] },

  // ---- Model Learning context (additive; older rows simply lack these) ----
  learningRegime: { type: String, default: null }, // BULL/BEAR/SIDEWAYS/HIGH_VOLATILITY/CRISIS/RECOVERY/UNKNOWN
  crisisTags: { type: [String], default: [] },
  sectorAtPick: { type: String, default: null },
  marketContextAtPick: { type: Schema.Types.Mixed, default: null }, // nifty/vix/breadth/fii/macro snapshot
  // Max adverse / favorable excursion from priceHistory (filled on resolve/recompute)
  maxAdversePct: { type: Number, default: null },
  maxFavorablePct: { type: Number, default: null },
  holdingDaysToResolve: { type: Number, default: null },

  // Once a pick's story is genuinely over - target/SL hit 10+ trading days
  // ago, or 20+ trading days have passed since its predicted window expired
  // with neither ever hit - the daily EOD job (updateRecommendationPrices)
  // stops touching this row entirely: no more quote lookups, no more
  // priceHistory growth. Nothing is deleted; latestPrice/priceHistory just
  // freeze at their final values. Without this, every pick this app has
  // EVER logged - including ones from a year ago - would keep getting a
  // fresh daily quote fetch and a growing priceHistory array forever,
  // which is pure waste once the outcome is long since settled.
  trackingStopped: { type: Boolean, default: false, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

recommendationSchema.index({ symbol: 1, category: 1, recommendedDate: 1 }, { unique: true });

module.exports = mongoose.models.Recommendation || mongoose.model('Recommendation', recommendationSchema);
