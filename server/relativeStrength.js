// server/relativeStrength.js
// Relative Strength = how a stock's (or sector's) own return compares to
// Nifty 50's return over the SAME window. A stock down 2% while Nifty is
// down 8% is quietly showing strength, not weakness; a stock up 3% while
// Nifty is up 10% is lagging despite the green number. Built entirely from
// periodReturns each analysis already computes - no extra API calls.
function diffReturns(periodReturns, benchmarkReturns, key) {
  if (!periodReturns || !benchmarkReturns) return null;
  const a = periodReturns[key];
  const b = benchmarkReturns[key];
  if (a == null || b == null) return null;
  return Number((a - b).toFixed(2));
}

function computeRelativeStrength(periodReturns, benchmarkReturns) {
  if (!periodReturns || !benchmarkReturns) return { status: 'unavailable' };
  const rs1W = diffReturns(periodReturns, benchmarkReturns, 'oneWeek');
  const rs1M = diffReturns(periodReturns, benchmarkReturns, 'oneMonth');
  const rs3M = diffReturns(periodReturns, benchmarkReturns, 'threeMonth');

  // Weighted RS score - recent outperformance weighted more heavily, but
  // the medium-term picture still counts so a one-week blip doesn't
  // dominate the read.
  const weighted = [[rs1W, 0.5], [rs1M, 0.3], [rs3M, 0.2]].filter(([v]) => v != null);
  const rsScore = weighted.length
    ? Number((weighted.reduce((sum, [v, w]) => sum + v * w, 0) / weighted.reduce((sum, [, w]) => sum + w, 0)).toFixed(2))
    : null;

  // Improving/weakening: is this week's outperformance vs Nifty notably
  // better (or worse) than the past month's average outperformance?
  let status = 'neutral';
  if (rs1W != null && rs1M != null) {
    if (rs1W > rs1M + 1) status = 'improving';
    else if (rs1W < rs1M - 1) status = 'weakening';
  }

  // RS breakout: was clearly lagging Nifty over the medium term (negative
  // 1M RS) but has swung to meaningfully outperforming this week - i.e.
  // relative strength itself just broke out, often an early rotation signal.
  const rsBreakout = rs1M != null && rs1M < -1 && rs1W != null && rs1W > 2;

  return { status, rs1W, rs1M, rs3M, rsScore, rsBreakout };
}

module.exports = { computeRelativeStrength };
