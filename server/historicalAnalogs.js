// Multi-year historical analog engine for indices (Nifty / Midcap, etc.).
// Finds past dates with similar drawdown + trend features and reports
// what happened AFTER (further fall, bounce, recovery time).
// Not a prediction engine — descriptive history only.

function pct(a, b) {
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100;
}

function rollingMax(closes, i, lookback) {
  let m = -Infinity;
  const from = Math.max(0, i - lookback + 1);
  for (let j = from; j <= i; j++) if (closes[j] > m) m = closes[j];
  return m;
}

function smaAt(closes, i, period) {
  if (i < period - 1) return null;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) s += closes[j];
  return s / period;
}

function featuresAt(closes, i) {
  const price = closes[i];
  const high60 = rollingMax(closes, i, 60);
  const high120 = rollingMax(closes, i, 120);
  const dd60 = pct(high60, price);
  const dd120 = pct(high120, price);
  const ret5 = i >= 5 ? pct(closes[i - 5], price) : null;
  const ret20 = i >= 20 ? pct(closes[i - 20], price) : null;
  const ret60 = i >= 60 ? pct(closes[i - 60], price) : null;
  const s50 = smaAt(closes, i, 50);
  const s200 = smaAt(closes, i, 200);
  const vs50 = s50 != null ? pct(s50, price) : null;
  const vs200 = s200 != null ? pct(s200, price) : null;
  return { price, dd60, dd120, ret5, ret20, ret60, vs50, vs200 };
}

function distance(a, b) {
  // Weighted feature distance — focus on drawdown & medium trend
  const parts = [
    [a.dd60, b.dd60, 2.0],
    [a.dd120, b.dd120, 1.5],
    [a.ret20, b.ret20, 1.2],
    [a.ret60, b.ret60, 1.0],
    [a.vs200, b.vs200, 1.0],
    [a.ret5, b.ret5, 0.6],
  ];
  let sum = 0;
  let wsum = 0;
  for (const [x, y, w] of parts) {
    if (x == null || y == null) continue;
    sum += w * (x - y) ** 2;
    wsum += w;
  }
  if (!wsum) return Infinity;
  return Math.sqrt(sum / wsum);
}

function forwardOutcomes(closes, i, horizons = [10, 20, 40, 60, 120]) {
  const entry = closes[i];
  const out = {};
  for (const h of horizons) {
    if (i + h >= closes.length) {
      out[`d${h}`] = null;
      continue;
    }
    let minP = entry;
    let maxP = entry;
    for (let j = i + 1; j <= i + h; j++) {
      if (closes[j] < minP) minP = closes[j];
      if (closes[j] > maxP) maxP = closes[j];
    }
    const end = closes[i + h];
    out[`d${h}`] = {
      maxDrawdownPct: Number(pct(entry, minP).toFixed(2)),
      maxBouncePct: Number(pct(entry, maxP).toFixed(2)),
      endReturnPct: Number(pct(entry, end).toFixed(2)),
    };
  }
  // Days until +5% recovery (if any within 120 sessions)
  let daysToPlus5 = null;
  let daysToPlus10 = null;
  const limit = Math.min(closes.length - 1, i + 180);
  for (let j = i + 1; j <= limit; j++) {
    const r = pct(entry, closes[j]);
    if (daysToPlus5 == null && r >= 5) daysToPlus5 = j - i;
    if (daysToPlus10 == null && r >= 10) {
      daysToPlus10 = j - i;
      break;
    }
  }
  // Days until further -5% from here
  let daysToMinus5 = null;
  for (let j = i + 1; j <= limit; j++) {
    if (pct(entry, closes[j]) <= -5) {
      daysToMinus5 = j - i;
      break;
    }
  }
  out.daysToPlus5 = daysToPlus5;
  out.daysToPlus10 = daysToPlus10;
  out.daysToMinus5 = daysToMinus5;
  return out;
}

/**
 * Major peak-to-trough drawdown episodes (local 60d high → subsequent low).
 */
function majorDrawdowns(candles, minDropPct = -8) {
  const closes = candles.map((c) => c.close);
  const episodes = [];
  let i = 60;
  while (i < closes.length - 5) {
    const high60 = rollingMax(closes, i, 60);
    // Peak day: close near 60d high and next 10d soft
    if (closes[i] >= high60 * 0.995) {
      let troughIdx = i;
      let trough = closes[i];
      const endScan = Math.min(closes.length - 1, i + 180);
      for (let j = i + 1; j <= endScan; j++) {
        if (closes[j] < trough) {
          trough = closes[j];
          troughIdx = j;
        }
        // recovery of 50% of drop ends episode search
        const drop = pct(closes[i], trough);
        if (drop <= minDropPct && closes[j] >= trough + (closes[i] - trough) * 0.5 && j > troughIdx + 3) {
          break;
        }
      }
      const drop = pct(closes[i], trough);
      if (drop <= minDropPct) {
        const rec20 = troughIdx + 20 < closes.length ? pct(trough, closes[troughIdx + 20]) : null;
        const rec60 = troughIdx + 60 < closes.length ? pct(trough, closes[troughIdx + 60]) : null;
        episodes.push({
          peakDate: candles[i].date,
          peakPrice: Number(closes[i].toFixed(2)),
          troughDate: candles[troughIdx].date,
          troughPrice: Number(trough.toFixed(2)),
          drawdownPct: Number(drop.toFixed(2)),
          sessionsPeakToTrough: troughIdx - i,
          bounce20dFromTroughPct: rec20 != null ? Number(rec20.toFixed(2)) : null,
          bounce60dFromTroughPct: rec60 != null ? Number(rec60.toFixed(2)) : null,
        });
        i = troughIdx + 10;
        continue;
      }
    }
    i += 5;
  }
  // unique-ish by trough date
  const seen = new Set();
  const uniq = [];
  for (const e of episodes.sort((a, b) => a.drawdownPct - b.drawdownPct)) {
    if (seen.has(e.troughDate)) continue;
    seen.add(e.troughDate);
    uniq.push(e);
  }
  return uniq.sort((a, b) => a.peakDate.localeCompare(b.peakDate)).slice(-15);
}

function summarizeAnalogs(analogs) {
  if (!analogs.length) return null;
  const avg = (key, sub) => {
    const vals = analogs.map((a) => (sub ? a.forward?.[key]?.[sub] : a.forward?.[key])).filter((v) => v != null);
    if (!vals.length) return null;
    return Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
  };
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(1));
  };
  const dd20 = analogs.map((a) => a.forward?.d20?.maxDrawdownPct).filter((v) => v != null);
  const bounce20 = analogs.map((a) => a.forward?.d20?.maxBouncePct).filter((v) => v != null);
  const end60 = analogs.map((a) => a.forward?.d60?.endReturnPct).filter((v) => v != null);
  const to5 = analogs.map((a) => a.forward?.daysToPlus5).filter((v) => v != null);
  const toM5 = analogs.map((a) => a.forward?.daysToMinus5).filter((v) => v != null);

  const furtherDownShare = dd20.length
    ? Number(((dd20.filter((v) => v <= -3).length / dd20.length) * 100).toFixed(0))
    : null;
  const bounceShare = bounce20.length
    ? Number(((bounce20.filter((v) => v >= 3).length / bounce20.length) * 100).toFixed(0))
    : null;

  return {
    sample: analogs.length,
    avgMaxDrawdownNext20d: avg('d20', 'maxDrawdownPct'),
    avgMaxBounceNext20d: avg('d20', 'maxBouncePct'),
    avgEndReturn60d: avg('d60', 'endReturnPct'),
    medianDaysToPlus5: median(to5),
    medianDaysToMinus5: median(toM5),
    shareFurtherDrop3pctIn20d: furtherDownShare,
    shareBounce3pctIn20d: bounceShare,
    note: 'Averages over historically similar days only. Markets change; past path ≠ future path.',
  };
}

/**
 * @param {Array} candles long daily history
 * @param {object} opts
 */
function findHistoricalAnalogs(candles, opts = {}) {
  const minHistory = 250;
  if (!candles || candles.length < minHistory + 60) {
    return { analogs: [], summary: null, current: null, majorDrawdowns: [], error: 'insufficient_history' };
  }

  const closes = candles.map((c) => c.close);
  const lastIdx = closes.length - 1;
  // Exclude last 60 bars from "analogs" so forward outcomes are fully known (no look-ahead into unknown future of past events is fine; we need past events with completed forward windows)
  const searchEnd = lastIdx - 60;
  const searchStart = 200;
  const current = featuresAt(closes, lastIdx);

  const scored = [];
  for (let i = searchStart; i <= searchEnd; i += 1) {
    // skip if not in a soft/downish phase similar intent — optional filter
    const f = featuresAt(closes, i);
    if (f.dd60 == null) continue;
    // Only compare when market was also at least mildly soft (dd60 <= -2) if current is soft
    if (current.dd60 != null && current.dd60 <= -3 && f.dd60 > -1) continue;
    const dist = distance(current, f);
    if (!Number.isFinite(dist)) continue;
    scored.push({ i, dist, f });
  }
  scored.sort((a, b) => a.dist - b.dist);

  // Diversity: avoid clustering all analogs in same week
  const picked = [];
  const usedDates = [];
  for (const s of scored) {
    if (picked.length >= (opts.limit || 12)) break;
    const d = candles[s.i].date;
    if (usedDates.some((u) => Math.abs(Date.parse(u) - Date.parse(d)) < 20 * 86400000)) continue;
    usedDates.push(d);
    const forward = forwardOutcomes(closes, s.i);
    picked.push({
      date: d,
      price: Number(s.f.price.toFixed(2)),
      similarity: Number((1 / (1 + s.dist)).toFixed(3)),
      distance: Number(s.dist.toFixed(3)),
      features: {
        dd60: s.f.dd60 != null ? Number(s.f.dd60.toFixed(2)) : null,
        dd120: s.f.dd120 != null ? Number(s.f.dd120.toFixed(2)) : null,
        ret20: s.f.ret20 != null ? Number(s.f.ret20.toFixed(2)) : null,
        ret60: s.f.ret60 != null ? Number(s.f.ret60.toFixed(2)) : null,
        vs200: s.f.vs200 != null ? Number(s.f.vs200.toFixed(2)) : null,
      },
      forward,
    });
  }

  return {
    current: {
      dd60: current.dd60 != null ? Number(current.dd60.toFixed(2)) : null,
      dd120: current.dd120 != null ? Number(current.dd120.toFixed(2)) : null,
      ret20: current.ret20 != null ? Number(current.ret20.toFixed(2)) : null,
      ret60: current.ret60 != null ? Number(current.ret60.toFixed(2)) : null,
      vs200: current.vs200 != null ? Number(current.vs200.toFixed(2)) : null,
    },
    analogs: picked,
    summary: summarizeAnalogs(picked),
    majorDrawdowns: majorDrawdowns(candles, -10),
    historyFrom: candles[0]?.date || null,
    historyTo: candles[candles.length - 1]?.date || null,
    historyBars: candles.length,
  };
}

async function buildIndexHistoryPack(symbol, label) {
  const marketData = require('./marketData');
  const candles = await marketData.getLongHistory(symbol, 25);
  const pack = findHistoricalAnalogs(candles, { limit: 12 });
  return {
    symbol,
    label,
    ...pack,
  };
}

module.exports = {
  findHistoricalAnalogs,
  buildIndexHistoryPack,
  majorDrawdowns,
};
