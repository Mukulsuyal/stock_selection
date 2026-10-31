// server/sectorRotation.js
// Ranks sectors by how their stocks (within our own tracked Nifty50 +
// Midcap + Smallcap universe) are performing vs Nifty, using the SAME
// period-return data already computed per stock. This is price-action
// based sector strength, NOT an institutional money-flow claim - we don't
// have real FII/DII sector-level flow data, so we never imply we do.
function computeSectorRotation(results, sectorMap, benchmarkReturns) {
  const bySector = {};
  results.forEach((r) => {
    if (r.error || !r.periodReturns) return;
    const sector = sectorMap[r.symbol];
    if (!sector || sector === 'Unknown') return; // don't lump unmapped stocks into a fake bucket
    if (!bySector[sector]) bySector[sector] = { symbols: [], sumW: 0, nW: 0, sumM: 0, nM: 0, sum3M: 0, n3M: 0 };
    const b = bySector[sector];
    b.symbols.push(r.symbol);
    if (r.periodReturns.oneWeek != null) { b.sumW += r.periodReturns.oneWeek; b.nW++; }
    if (r.periodReturns.oneMonth != null) { b.sumM += r.periodReturns.oneMonth; b.nM++; }
    if (r.periodReturns.threeMonth != null) { b.sum3M += r.periodReturns.threeMonth; b.n3M++; }
  });

  return Object.entries(bySector)
    .filter(([, b]) => b.symbols.length >= 2) // need at least 2 stocks for a meaningful sector average
    .map(([sector, b]) => {
      const avg1W = b.nW ? Number((b.sumW / b.nW).toFixed(2)) : null;
      const avg1M = b.nM ? Number((b.sumM / b.nM).toFixed(2)) : null;
      const avg3M = b.n3M ? Number((b.sum3M / b.n3M).toFixed(2)) : null;
      const rs1W = avg1W != null && benchmarkReturns?.oneWeek != null ? Number((avg1W - benchmarkReturns.oneWeek).toFixed(2)) : null;
      const rs1M = avg1M != null && benchmarkReturns?.oneMonth != null ? Number((avg1M - benchmarkReturns.oneMonth).toFixed(2)) : null;
      let status = 'neutral';
      if (rs1W != null && rs1M != null) {
        if (rs1W > rs1M + 1) status = 'improving';
        else if (rs1W < rs1M - 1) status = 'weakening';
      }
      return { sector, stockCount: b.symbols.length, avg1W, avg1M, avg3M, rs1W, rs1M, status };
    })
    .sort((a, b) => (b.rs1M ?? -999) - (a.rs1M ?? -999));
}

// "Is this stock's move today just it, or is its whole sector moving?" -
// averages TODAY's %change (pChange, from the live quote) across every
// stock in our own tracked universe that shares a sector, using the same
// sectorMap as computeSectorRotation above. This is our own tracked
// universe's average, not the official NSE sectoral index value - the
// frontend labels it that way so it's never confused with one.
function computeSectorTodayMoves(results, sectorMap) {
  const bySector = {};
  results.forEach((r) => {
    if (r.error || r.pChange == null) return;
    const sector = sectorMap[r.symbol];
    if (!sector || sector === 'Unknown') return;
    if (!bySector[sector]) bySector[sector] = { sum: 0, n: 0 };
    bySector[sector].sum += r.pChange;
    bySector[sector].n++;
  });
  const out = {};
  Object.entries(bySector).forEach(([sector, b]) => {
    if (b.n >= 2) out[sector] = { avgPct: Number((b.sum / b.n).toFixed(2)), stockCount: b.n };
  });
  return out;
}

module.exports = { computeSectorRotation, computeSectorTodayMoves };
