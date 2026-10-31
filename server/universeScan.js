// Shared cache for combined Nifty50 + Midcap + Smallcap scan.
const { mapLimit, analyzeOne } = require('./stockAnalysisEngine');
const { getMarketTrend } = require('./marketTrend');
const { INDEXES } = require('./indexConstituents');

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, data: null };

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] - bypass cache
 * @param {function} [opts.onProgress] - ({ completed, total, symbol, phase }) => void
 * @param {number} [opts.concurrency]
 */
async function getCombinedUniverseScan(opts = {}) {
  const { forceRefresh = false, onProgress = null, concurrency = 5 } = opts;

  if (!forceRefresh && cache.data && Date.now() - cache.at < CACHE_MS) {
    if (onProgress) {
      onProgress({
        completed: cache.data.scannedCount,
        total: cache.data.scannedCount,
        symbol: null,
        phase: 'cache',
        message: `Using recent scan cache (${cache.data.scannedCount} stocks from ${cache.data.scannedAt})`,
      });
    }
    return cache.data;
  }

  const marketContext = await getMarketTrend();
  const symbolToIndex = {};
  Object.values(INDEXES).forEach((idx) => {
    idx.symbols.forEach((s) => { if (!symbolToIndex[s]) symbolToIndex[s] = idx.label; });
  });
  const allSymbols = Object.keys(symbolToIndex);
  const total = allSymbols.length;
  let completed = 0;

  if (onProgress) {
    onProgress({ completed: 0, total, symbol: null, phase: 'universe', message: `Scanning ${total} stocks…` });
  }

  const results = await mapLimit(allSymbols, concurrency, async (s) => {
    if (onProgress) {
      onProgress({
        completed,
        total,
        symbol: s,
        phase: 'universe',
        message: `Analysing ${s} (${completed + 1}/${total}) — technicals, volume, R:R, history…`,
      });
    }
    const row = await analyzeOne(s, marketContext);
    completed += 1;
    if (onProgress) {
      onProgress({
        completed,
        total,
        symbol: s,
        phase: 'universe',
        message: `Done ${s} (${completed}/${total})`,
        justFinished: s,
      });
    }
    return row;
  });

  const data = {
    results,
    symbolToIndex,
    marketContext,
    scannedAt: new Date().toISOString(),
    scannedCount: allSymbols.length,
  };
  cache = { at: Date.now(), data };
  return data;
}

function clearUniverseScanCache() {
  cache = { at: 0, data: null };
}

module.exports = { getCombinedUniverseScan, clearUniverseScanCache };
