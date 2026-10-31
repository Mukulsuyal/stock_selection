// server/recommendations/FactorPerformance.js
// One row per individual signal (e.g. "Golden trend (50-day SMA above
// 200-day SMA)" + bullish) - not per stock, not per pick. Tracks how that
// EXACT signal has actually performed across every resolved pick that ever
// carried it, anywhere in the app (Top Picks, Golden tiers, Swing Setups,
// Weekend Picks). This is the raw material for the self-improving feedback
// loop (see server/factorPerformance.js) and for the "🧠 Model Learning"
// screen - real, resolved-outcome statistics, not a guess and not a
// black-box model.
//
// Also stores signal COMBINATIONS (isCombination=true) when useful pairs
// like RSI + Volume appear often enough. Existing keys are unchanged;
// only new optional fields were added for transparency / walk-forward.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const factorPerformanceSchema = new Schema({
  factor: { type: String, required: true },   // exact signal text, e.g. "RSI(14) bullish momentum zone"
  signal: { type: String, required: true },   // bullish / bearish / caution / combination

  occurrences: { type: Number, default: 0 },  // resolved (target-or-SL-hit) picks that carried this signal
  wins: { type: Number, default: 0 },         // of those, target hit
  losses: { type: Number, default: 0 },       // of those, stop-loss hit
  winRate: { type: Number, default: null },   // wins / occurrences * 100
  avgReturnPct: { type: Number, default: null }, // average outcome return % across all resolved picks carrying this signal

  // The actual, bounded nudge this signal's track record earns in ranking
  // (see MAX_ADJUSTMENT / MIN_SAMPLE_FOR_ADJUSTMENT in
  // server/factorPerformance.js) - deliberately small and capped, so this
  // stays a NUDGE informed by real outcomes, never an override of the
  // underlying technical analysis.
  scoreAdjustment: { type: Number, default: 0 },

  lastComputedAt: { type: Date, default: null },

  // ---- New optional fields (do not break existing documents) ----
  isCombination: { type: Boolean, default: false },
  combinationLabel: { type: String, default: null },

  // Transparent outcome mix (includes unresolved picks that still carry this signal)
  targetHitPct: { type: Number, default: null },
  slHitPct: { type: Number, default: null },
  noResolutionPct: { type: Number, default: null },
  sampleSize: { type: Number, default: null }, // same as occurrences for resolved; kept explicit for UI

  // Walk-forward / out-of-sample
  recentWinRate: { type: Number, default: null },
  recentSampleSize: { type: Number, default: 0 },

  learningConfidence: { type: String, enum: ['none', 'low', 'medium', 'high', null], default: null },
  why: { type: String, default: null }, // human-readable explanation of the nudge

  // ---- Regime-aware / expectancy metrics (additive) ----
  // NORMAL = non-CRISIS resolved sample; CRISIS isolated so crashes don't poison normal learning
  normalOccurrences: { type: Number, default: 0 },
  normalWins: { type: Number, default: 0 },
  normalWinRate: { type: Number, default: null },
  normalScoreAdjustment: { type: Number, default: 0 },
  crisisOccurrences: { type: Number, default: 0 },
  crisisWins: { type: Number, default: 0 },
  crisisWinRate: { type: Number, default: null },
  crisisScoreAdjustment: { type: Number, default: 0 },
  // Per-regime breakdown { BULL: { occurrences, wins, winRate, avgReturnPct, nudge }, ... }
  regimeBreakdown: { type: Schema.Types.Mixed, default: {} },
  sectorBreakdown: { type: Schema.Types.Mixed, default: {} },

  expectancy: { type: Number, default: null }, // avg return per resolved trade (pct)
  avgWinPct: { type: Number, default: null },
  avgLossPct: { type: Number, default: null },
  medianReturnPct: { type: Number, default: null },
  avgHoldingDays: { type: Number, default: null },
  avgMaePct: { type: Number, default: null }, // max adverse excursion
  avgMfePct: { type: Number, default: null }, // max favorable excursion
  avgRiskRewardObserved: { type: Number, default: null },
  avgTargetDistancePct: { type: Number, default: null },
  avgSlDistancePct: { type: Number, default: null },

  // Cluster-adjusted sample (correlated same-day crash not counted as N independent events)
  effectiveSampleSize: { type: Number, default: null },
  modelConfidence: { type: String, enum: ['none', 'low', 'medium', 'high', 'unknown', null], default: null },
  tradeConfidenceNote: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

factorPerformanceSchema.index({ factor: 1, signal: 1 }, { unique: true });

module.exports = mongoose.models.FactorPerformance || mongoose.model('FactorPerformance', factorPerformanceSchema);
