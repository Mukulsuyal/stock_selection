// Learning-oriented market regime labels (separate from UI banner wording).
// Used by Model Learning so NORMAL vs CRISIS history stays separated.
//
// Labels: BULL | BEAR | SIDEWAYS | HIGH_VOLATILITY | CRISIS | RECOVERY | UNKNOWN
const LEARNING_REGIMES = ['BULL', 'BEAR', 'SIDEWAYS', 'HIGH_VOLATILITY', 'CRISIS', 'RECOVERY', 'UNKNOWN'];

/**
 * Classify a learning regime from regime detector + optional macro snapshot.
 * Does not replace UI trendRegime — additive for learning only.
 */
function classifyLearningRegime({
  technicalTrend,
  todayDirection,
  niftyOneDayPct,
  vixLevel,
  vixChangePct,
  breadthRead,
  crudeChangePct,
  usdinrChangePct,
  us10yChangePct,
  globalSelloff, // boolean from major global indices down hard
} = {}) {
  const vix = vixLevel;
  const day = niftyOneDayPct;
  const crisisHints = [];

  // Crisis / shock heuristics (any strong combination)
  if (vix != null && vix >= 28) crisisHints.push('vix_spike');
  if (vixChangePct != null && vixChangePct >= 15) crisisHints.push('vix_spike');
  if (day != null && day <= -2.5) crisisHints.push('equity_crash_day');
  if (day != null && day <= -1.5 && vix != null && vix >= 22) crisisHints.push('equity_crash_day');
  if (crudeChangePct != null && Math.abs(crudeChangePct) >= 5) crisisHints.push('oil_shock');
  if (us10yChangePct != null && Math.abs(us10yChangePct) >= 3) crisisHints.push('bond_yield_shock');
  if (usdinrChangePct != null && usdinrChangePct >= 1.2) crisisHints.push('fx_shock');
  if (globalSelloff) crisisHints.push('global_selloff');
  if (breadthRead === 'broadly bearish' && day != null && day <= -1.2) crisisHints.push('breadth_collapse');

  // Need real stress: either equity crash + elevated VIX level, or 2+ strong
  // tags excluding a lone VIX % jump when absolute VIX is still low (<18).
  const strong = crisisHints.filter((t) => t !== 'vix_spike' || (vix != null && vix >= 18));
  const elevatedVix = vix != null && vix >= 20;
  if (
    (crisisHints.includes('equity_crash_day') && elevatedVix)
    || (strong.length >= 2 && (elevatedVix || crisisHints.includes('equity_crash_day')))
    || (vix != null && vix >= 28)
  ) {
    return { regime: 'CRISIS', crisisTags: [...new Set(crisisHints)], transition: null };
  }
  // Soft risk-off without full crisis label
  if (crisisHints.length && !elevatedVix && day != null && day > -2) {
    // fall through to HIGH_VOLATILITY / trend labels
  }

  // Recovery: was weak multi-day tech but strong up day / cooling VIX
  if (
    (technicalTrend === 'Bearish' || technicalTrend === 'Sideways')
    && todayDirection === 'Up'
    && day != null
    && day >= 0.8
    && (vix == null || vix < 26)
  ) {
    return { regime: 'RECOVERY', crisisTags: [], transition: 'BEAR_OR_SIDEWAYS_TO_RECOVERY' };
  }

  if (vix != null && vix >= 20) {
    // Elevated vol without full crisis
    if (technicalTrend === 'Bullish' && (day == null || day > -1)) {
      return { regime: 'HIGH_VOLATILITY', crisisTags: crisisHints, transition: null };
    }
    if (technicalTrend === 'Bearish') {
      return { regime: 'HIGH_VOLATILITY', crisisTags: crisisTagsOr(crisisHints, 'policy_or_risk_off'), transition: null };
    }
  }

  if (technicalTrend === 'Bullish') return { regime: 'BULL', crisisTags: [], transition: null };
  if (technicalTrend === 'Bearish') return { regime: 'BEAR', crisisTags: [], transition: null };
  if (technicalTrend === 'Sideways') return { regime: 'SIDEWAYS', crisisTags: [], transition: null };

  // Fallback from day direction
  if (todayDirection === 'Up' && day != null && day > 0.4) return { regime: 'BULL', crisisTags: [], transition: null };
  if (todayDirection === 'Down' && day != null && day < -0.4) return { regime: 'BEAR', crisisTags: [], transition: null };

  return { regime: 'UNKNOWN', crisisTags: [], transition: null };
}

function crisisTagsOr(tags, extra) {
  return [...new Set([...(tags || []), extra])];
}

function isCrisisRegime(regime) {
  return regime === 'CRISIS';
}

function isNormalLearningBucket(regime) {
  // HIGH_VOLATILITY and RECOVERY stay in "elevated" but not pure CRISIS isolation
  return regime === 'BULL' || regime === 'BEAR' || regime === 'SIDEWAYS' || regime === 'RECOVERY' || regime === 'HIGH_VOLATILITY' || regime === 'UNKNOWN';
}

module.exports = {
  LEARNING_REGIMES,
  classifyLearningRegime,
  isCrisisRegime,
  isNormalLearningBucket,
};
