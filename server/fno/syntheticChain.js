/**
 * DEMO option chain when NSE is blocked — clearly labeled, not live market quotes.
 * Strikes around spot; premium ≈ intrinsic + simple time value proxy.
 */
function roundStrike(spot, step) {
  return Math.round(spot / step) * step;
}

function stepFor(indexKey, spot) {
  if (indexKey === 'BANKNIFTY') return spot > 40000 ? 100 : 100;
  if (indexKey === 'SENSEX') return 100;
  return 50; // NIFTY
}

function syntheticPremium(spot, strike, side, ivApprox = 0.14) {
  const intrinsic = side === 'CE'
    ? Math.max(0, spot - strike)
    : Math.max(0, strike - spot);
  const dist = Math.abs(spot - strike) / spot;
  const timeValue = spot * ivApprox * 0.08 * Math.exp(-dist * 8);
  return Number(Math.max(1, intrinsic + timeValue).toFixed(2));
}

function buildSyntheticChain(indexKey, spot, { expiryLabel = 'DEMO-NEAR' } = {}) {
  if (!spot || !Number.isFinite(spot)) return null;
  const step = stepFor(indexKey, spot);
  const atm = roundStrike(spot, step);
  const strikes = [];
  for (let i = -8; i <= 8; i++) strikes.push(atm + i * step);

  const calls = [];
  const puts = [];
  for (const k of strikes) {
    const ce = syntheticPremium(spot, k, 'CE');
    const pe = syntheticPremium(spot, k, 'PE');
    calls.push({
      side: 'CE', strike: k, oi: Math.round(5000 + Math.random() * 20000),
      chgOi: Math.round((Math.random() - 0.5) * 2000),
      volume: Math.round(1000 + Math.random() * 8000),
      iv: Number((12 + Math.abs(k - spot) / spot * 40).toFixed(1)),
      ltp: ce, bid: Number((ce * 0.98).toFixed(2)), ask: Number((ce * 1.02).toFixed(2)),
      lot: null, demo: true,
    });
    puts.push({
      side: 'PE', strike: k, oi: Math.round(5000 + Math.random() * 20000),
      chgOi: Math.round((Math.random() - 0.5) * 2000),
      volume: Math.round(1000 + Math.random() * 8000),
      iv: Number((12 + Math.abs(k - spot) / spot * 40).toFixed(1)),
      ltp: pe, bid: Number((pe * 0.98).toFixed(2)), ask: Number((pe * 1.02).toFixed(2)),
      lot: null, demo: true,
    });
  }

  const callOi = calls.reduce((s, c) => s + c.oi, 0);
  const putOi = puts.reduce((s, p) => s + p.oi, 0);
  const pcr = callOi > 0 ? Number((putOi / callOi).toFixed(3)) : null;

  return {
    demo: true,
    source: 'synthetic-demo',
    warning: 'DEMO chain — NSE live chain unavailable. Premiums are model estimates, not exchange quotes. Paper trade only.',
    spot,
    expiry: expiryLabel,
    atm,
    pcr,
    strikes,
    calls,
    puts,
    rows: strikes.map((k) => ({
      strike: k,
      CE: calls.find((c) => c.strike === k),
      PE: puts.find((p) => p.strike === k),
    })),
  };
}

module.exports = { buildSyntheticChain, stepFor, roundStrike };
