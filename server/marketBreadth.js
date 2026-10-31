// server/marketBreadth.js
// "Market Breadth" computed over our OWN tracked universe (Nifty50 +
// Midcap + Smallcap, ~250 stocks) - NOT full-NSE-exchange advance/decline
// data, which our free data sources don't provide. Always labeled
// "Tracked Universe Breadth" so it's never confused with real exchange-wide
// breadth (e.g. full NSE advance/decline of 2000+ stocks).
function computeTrackedUniverseBreadth(results) {
  const valid = results.filter((r) => !r.error && r.pChange != null);
  const advancing = valid.filter((r) => r.pChange > 0).length;
  const declining = valid.filter((r) => r.pChange < 0).length;
  const unchanged = valid.length - advancing - declining;
  const advanceDeclineRatio = declining > 0 ? Number((advancing / declining).toFixed(2)) : null;

  let breadthRead = 'neutral';
  if (valid.length) {
    const advPct = (advancing / valid.length) * 100;
    if (advPct >= 60) breadthRead = 'broadly bullish';
    else if (advPct <= 40) breadthRead = 'broadly bearish';
  }

  return {
    label: 'Tracked Universe Breadth', // deliberately not "NSE Market Breadth" - see header note
    total: valid.length, advancing, declining, unchanged, advanceDeclineRatio, breadthRead,
  };
}

module.exports = { computeTrackedUniverseBreadth };
