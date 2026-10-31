// server/decisionEngine.js
// Combines everything the app already knows about a stock - technical
// score, R:R, data confidence, market regime, trading-discipline status -
// into ONE final decision with explicit reasons. This is the "hard
// checklist" layer: a single strong technical score never overrides a
// poor R:R, missing data, or a blown daily loss limit.
//
// Decision values: BUY NOW | BUY ON PULLBACK | WAIT | WATCHLIST | NO TRADE
// Never "guaranteed profit" - always paired with WHY / WHY NOT reasons.

function computeEntryQualityScore({ analysis, dataConfidence, marketContext }) {
  let score = 50 + analysis.score * 8; // technical score is the base driver
  const rr = analysis.tradePlan?.riskRewardRatio;
  if (rr) score += Math.min((rr - 1) * 6, 18);
  if (marketContext?.trend === 'bullish') score += 5;
  else if (marketContext?.trend === 'bearish') score -= 5;
  if (dataConfidence !== null) score = score * (dataConfidence / 100);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function labelForScore(score) {
  if (score >= 80) return 'A+';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'WAIT';
  if (score >= 50) return 'Weak';
  return 'NO TRADE';
}

function computeFinalDecision({ analysis, dataConfidence, marketContext, tradingStatus, minRiskReward = 2, minDataConfidence = 50 }) {
  const why = [], whyNot = [];
  const rr = analysis.tradePlan?.riskRewardRatio ?? null;

  // ---- Hard gates: any of these force NO TRADE regardless of score ----
  const hardBlocks = [];
  if (tradingStatus?.dailyLimitHit) hardBlocks.push(`Daily loss limit hit today (${tradingStatus.todaysPnlPct}%) — no new trades today.`);
  if (tradingStatus?.maxTradesHit) hardBlocks.push(`Max trades/day reached (${tradingStatus.tradesTakenToday}/${tradingStatus.settings.maxTradesPerDay}).`);
  if (tradingStatus?.inCooldown) hardBlocks.push(`Cooldown active after a recent loss — ${tradingStatus.cooldownMinutesLeft} min left.`);
  if (dataConfidence !== null && dataConfidence < minDataConfidence) hardBlocks.push(`Data confidence too low (${dataConfidence}% < required ${minDataConfidence}%).`);
  if (rr !== null && rr < minRiskReward) hardBlocks.push(`Risk:Reward ${rr}:1 is below your minimum ${minRiskReward}:1 — never overridden by a high score.`);

  hardBlocks.forEach((b) => whyNot.push(b));

  // ---- Supporting evidence (why / why not) ----
  if (analysis.score >= 2.5) why.push(`Strong technical score (${analysis.score}), verdict "${analysis.verdict}".`);
  else if (analysis.score <= -1) whyNot.push(`Weak/negative technical score (${analysis.score}).`);

  if (rr !== null && rr >= minRiskReward) why.push(`Risk:Reward ${rr}:1 meets your minimum ${minRiskReward}:1.`);

  if (marketContext?.trend === 'bullish') why.push('Broader market (Nifty) is trending bullish — trading with the market.');
  else if (marketContext?.trend === 'bearish') whyNot.push('Broader market (Nifty) is trending bearish — fighting the market.');

  if (analysis.setup?.type === 'reversal') why.push(`Reversal setup: ${analysis.setup.reason}`);
  if (analysis.weeklyRead && analysis.weeklyRead.verdict) {
    if (analysis.weeklyRead.score > 0 && analysis.score > 0) why.push('Weekly chart agrees with the daily read.');
    else if ((analysis.weeklyRead.score > 0) !== (analysis.score > 0)) whyNot.push('Weekly chart conflicts with the daily read.');
  }

  const indicators = analysis.indicators || {};
  if (indicators.rsi14 !== null && indicators.rsi14 > 75) whyNot.push(`RSI ${indicators.rsi14.toFixed(0)} is quite overbought — possible overextension, avoid chasing.`);

  const entryQuality = computeEntryQualityScore({ analysis, dataConfidence, marketContext });
  const scoreLabel = labelForScore(entryQuality);

  // ---- Final decision ----
  let decision;
  if (hardBlocks.length) {
    decision = 'NO TRADE';
  } else if (scoreLabel === 'NO TRADE' || scoreLabel === 'Weak') {
    decision = 'NO TRADE';
  } else if (scoreLabel === 'WAIT') {
    decision = 'WAIT';
  } else if (analysis.setup?.type === 'reversal') {
    decision = 'BUY ON PULLBACK'; // reversal setups: wait for confirmation near support, not chase
  } else if (analysis.verdict.toLowerCase().includes('bullish') && rr !== null && rr >= minRiskReward) {
    decision = 'BUY NOW';
  } else {
    decision = 'WATCHLIST';
  }

  return {
    decision,
    entryQuality,
    scoreLabel,
    why,
    whyNot,
    invalidation: analysis.tradePlan
      ? `If price closes below ₹${analysis.tradePlan.stopLoss} (structural stop), or the verdict flips to "Bearish lean", this thesis is invalidated — exit rather than average down.`
      : 'No trade plan available to define invalidation — treat with extra caution.',
    disclaimer: 'A rule-based read combining the signals this app has, not a guarantee. Never treat a high score as forcing a trade — WAIT/NO TRADE is a valid, often correct, answer.',
  };
}

module.exports = { computeFinalDecision, computeEntryQualityScore, labelForScore };
