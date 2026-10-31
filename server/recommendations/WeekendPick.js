// server/recommendations/WeekendPick.js
// One row per stock chosen by the weekend deep-dive research run (see
// server/weekendResearch.js). Unlike the daily Top Picks/Golden Scanner -
// which re-run every few minutes and are meant to be read fresh each time -
// this is a deliberately SMALL, deliberately STABLE list: the market is
// closed all weekend, so this scans the full Nifty50+Midcap+Smallcap
// universe once, ranks everything by "high odds of profit, negligible odds
// of loss", and freezes the best 5-8 as "what to watch for Monday" - not
// regenerated again until next weekend.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const weekendPickSchema = new Schema({
  // The Monday these picks are FOR (YYYY-MM-DD) - the natural key someone
  // actually cares about ("is weekend ka Monday ke liye kya best tha").
  forMondayDate: { type: String, required: true, index: true },
  weekendRunDate: { type: String, required: true }, // the Sat/Sun this research actually ran on
  rank: { type: Number, required: true }, // 1 = best

  symbol: { type: String, required: true },
  indexLabel: { type: String, default: null }, // Nifty 50 / Midcap / Smallcap
  priceAtResearch: { type: Number, required: true },
  verdict: { type: String, default: null },
  technicalScore: { type: Number, default: null },
  decision: { type: String, default: null }, // BUY NOW / BUY ON PULLBACK

  entryLow: { type: Number, default: null },
  entryHigh: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  target: { type: Number, default: null },
  target2: { type: Number, default: null },
  riskRewardRatio: { type: Number, default: null },

  // Historical odds, computed from THIS stock's own past behaviour (see
  // server/probabilityEstimator.js estimateMoveProbability) - the actual
  // basis for "loss probability negligible, profit probability high".
  profitProbability1Pct: { type: Number, default: null },  // % of past similar signals that gained 1%+ within 3 days
  profitProbability5Pct: { type: Number, default: null },  // % that gained 5%+
  lossProbability2Pct: { type: Number, default: null },    // % that DROPPED 2%+ - the "negligible" side
  probabilitySampleSize: { type: Number, default: null },

  predictedWindow: { type: String, default: null }, // 7d / 15d / 30d / 30d_plus
  predictedWindowDays: { type: Number, default: null },

  qualityScore: { type: Number, required: true }, // the composite ranking score - see weekendResearch.js
  meetsStrictBar: { type: Boolean, default: false }, // true if it cleared the "negligible loss / high profit" thresholds outright
  reason: { type: String, default: '' },
  topFactors: { type: [{ factor: String, signal: String, _id: false }], default: [] },

  // Refreshed by the same EOD price-update job that maintains
  // Recommendation rows, so "how did last weekend's picks actually do"
  // stays checkable - see server/recommendations/tracker.js.
  latestPrice: { type: Number, default: null },
  latestPriceDate: { type: String, default: null },
  changePct: { type: Number, default: null },
  hitTarget: { type: Boolean, default: false },
  hitStopLoss: { type: Boolean, default: false },
  hitTargetDate: { type: String, default: null },
  hitStopLossDate: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

weekendPickSchema.index({ forMondayDate: 1, symbol: 1 }, { unique: true });

module.exports = mongoose.models.WeekendPick || mongoose.model('WeekendPick', weekendPickSchema);
