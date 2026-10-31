/**
 * F&O index instrument metadata — prefer env / live fetch; no silent hard-code as sole source.
 */
const INDEXES = [
  {
    key: 'NIFTY',
    priority: 1,
    label: 'NIFTY 50',
    yahoo: '^NSEI',
    nseSymbol: 'NIFTY',
    lotEnv: 'FO_LOT_NIFTY',
    lotFallback: null, // filled only after fetch or explicit env
  },
  {
    key: 'BANKNIFTY',
    priority: 2,
    label: 'BANK NIFTY',
    yahoo: '^NSEBANK',
    nseSymbol: 'BANKNIFTY',
    lotEnv: 'FO_LOT_BANKNIFTY',
    lotFallback: null,
  },
  {
    key: 'SENSEX',
    priority: 3,
    label: 'SENSEX',
    yahoo: '^BSESN',
    nseSymbol: 'SENSEX',
    // BSE sensex options on NSE symbol sometimes SENSEX
    lotEnv: 'FO_LOT_SENSEX',
    lotFallback: null,
  },
];

function lotFor(indexKey) {
  const cfg = INDEXES.find((i) => i.key === indexKey);
  if (!cfg) return null;
  const fromEnv = process.env[cfg.lotEnv];
  if (fromEnv && Number(fromEnv) > 0) return Number(fromEnv);
  return cfg.lotFallback; // may be null → UI shows "set FO_LOT_* or connect broker"
}

function setLotFallback(indexKey, lot) {
  const cfg = INDEXES.find((i) => i.key === indexKey);
  if (cfg && lot > 0) cfg.lotFallback = lot;
}

module.exports = { INDEXES, lotFor, setLotFallback };
