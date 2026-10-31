/**
 * Fallen + fundamentally strong shortlist.
 * Max 3 names per index (Nifty50 / Mid / Small) — not padded.
 * Time filters: 3d, 5d, 15d, 1m, 3m, 6m.
 */
const marketData = require('./marketData');
const { INDEXES } = require('./indexConstituents');
const { isAffordableRecommendPrice } = require('./stockAnalysisEngine');
const { startJob, updateJob, endJob } = require('./progressStore');
const mongoose = require('mongoose');
const { isMongoConfigured } = require('./mongo');

const WINDOWS = [
  { key: '3d', days: 3, minDrop: 3 },
  { key: '5d', days: 5, minDrop: 4 },
  { key: '15d', days: 15, minDrop: 6 },
  { key: '1m', days: 22, minDrop: 8 },
  { key: '3m', days: 66, minDrop: 12 },
  { key: '6m', days: 130, minDrop: 15 },
];

const MAX_PER_INDEX = 3;

let Model;
function model() {
  if (Model) return Model;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    key: { type: String, unique: true },
    payload: mongoose.Schema.Types.Mixed,
    computedAt: Date,
  }, { collection: 'fallen_strong_cache' });
  Model = mongoose.models.FallenStrongCache || mongoose.model('FallenStrongCache', schema);
  return Model;
}

function dropFromCandles(candles, lookbackDays) {
  if (!candles?.length || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const price = last.close;
  const targetDate = new Date(last.date + 'T00:00:00');
  targetDate.setDate(targetDate.getDate() - lookbackDays);
  let ref = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = new Date(candles[i].date + 'T00:00:00');
    if (d <= targetDate) {
      ref = candles[i];
      break;
    }
  }
  if (!ref?.close || !price) return null;
  return {
    price,
    refPrice: ref.close,
    refDate: ref.date,
    dropPct: ((price - ref.close) / ref.close) * 100,
  };
}

function fundQuality(f) {
  if (!f) return { ok: false, score: 0, reasons: ['No fundamentals'] };
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
  const de = f.debtToEquity;
  const pe = f.peTrailing;
  let score = 50;
  const reasons = [];
  // Strict: need meaningful fund strength
  if (roe == null && pe == null && de == null) {
    return { ok: false, score: 0, reasons: ['Missing fund data'] };
  }
  if (roe != null && roe >= 15) { score += 18; reasons.push(`ROE ${roe.toFixed(1)}%`); }
  else if (roe != null && roe >= 12) { score += 12; reasons.push(`ROE ${roe.toFixed(1)}%`); }
  else if (roe != null && roe >= 10) { score += 6; reasons.push(`ROE ${roe.toFixed(1)}%`); }
  else if (roe != null && roe < 8) { score -= 18; reasons.push('ROE weak'); }

  if (de != null && de <= 0.5) { score += 12; reasons.push('Low debt'); }
  else if (de != null && de <= 1) { score += 6; reasons.push('Debt ok'); }
  else if (de != null && de > 1.8) { score -= 16; reasons.push('High debt'); }

  if (pe != null && pe > 0 && pe < 35) score += 6;
  else if (pe != null && pe > 60) score -= 10;

  const g = f.revenueGrowth ?? f.earningsGrowth;
  const gPct = g == null ? null : (Math.abs(g) <= 5 ? g * 100 : g);
  if (gPct != null && gPct >= 12) { score += 8; reasons.push('Growth ok'); }
  else if (gPct != null && gPct < -5) score -= 8;

  // Must clear bar — no "only fell" names
  const ok = score >= 58 && (roe == null || roe >= 10) && (de == null || de <= 1.5);
  return {
    ok,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    roe,
    de,
    pe,
    sector: f.sector || f.industry || 'Unknown',
  };
}

async function scanIndexAllWindows(indexKey, onProgress) {
  const idx = INDEXES[indexKey];
  const symbols = idx?.symbols || [];
  // per window: array of candidates
  const byWindow = {};
  for (const w of WINDOWS) byWindow[w.key] = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (onProgress && i % 12 === 0) onProgress(i, symbols.length, symbol);
    try {
      const candles = await marketData.getHistorical(symbol, 160);
      if (!candles?.length) continue;
      const price = candles[candles.length - 1].close;
      if (!isAffordableRecommendPrice({ price })) continue;

      let f = null;
      try {
        f = await marketData.getFundamentals(symbol, { maxAgeDays: 14 });
      } catch (_) {}
      const q = fundQuality(f);
      if (!q.ok) continue; // FUND first — never list only because it fell

      for (const w of WINDOWS) {
        const d = dropFromCandles(candles, w.days);
        if (!d || d.dropPct > -w.minDrop) continue;
        byWindow[w.key].push({
          symbol,
          indexKey,
          indexLabel: idx?.label || indexKey,
          price,
          sector: q.sector,
          dropWindow: w.key,
          dropPct: Number(d.dropPct.toFixed(2)),
          refDate: d.refDate,
          fundScore: q.score,
          roe: q.roe,
          debtToEquity: q.de,
          pe: q.pe,
          reasons: q.reasons,
          companyName: f?.companyName || null,
        });
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 35));
  }

  // Top 3 per window: deepest drop among fund-strong (then fund score)
  const result = {};
  for (const w of WINDOWS) {
    const list = byWindow[w.key]
      .sort((a, b) => {
        if (a.dropPct !== b.dropPct) return a.dropPct - b.dropPct; // more negative first
        return b.fundScore - a.fundScore;
      })
      .slice(0, MAX_PER_INDEX);
    result[w.key] = list;
  }
  return result;
}

async function runFallenStrongResearch({ jobId = null, force = false } = {}) {
  const M = model();
  if (!force && M) {
    const row = await M.findOne({ key: 'latest' }).lean();
    if (row?.payload?.computedAt) {
      const ageH = (Date.now() - new Date(row.computedAt).getTime()) / 3600000;
      if (ageH < 20) return { ...row.payload, fromCache: true };
    }
  }

  const jid = jobId || `fallen-strong-${Date.now()}`;
  try { startJob(jid, 1, 'Fallen+strong scan…'); } catch (_) {}

  const byIndex = {};
  const keys = ['nifty50', 'midcap', 'smallcap'];
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    try {
      updateJob(jid, Math.round((ki / keys.length) * 90), {
        phase: 'scan',
        message: `Scanning ${key}…`,
        detail: key,
      });
    } catch (_) {}
    byIndex[key] = await scanIndexAllWindows(key, (i, total, sym) => {
      try {
        updateJob(jid, Math.round(((ki + i / Math.max(total, 1)) / keys.length) * 90), {
          phase: 'scan',
          message: `${key}: ${sym}`,
          detail: sym,
        });
      } catch (_) {}
    });
  }

  const payload = {
    computedAt: new Date().toISOString(),
    note: 'Har index me max 3 — sirf jab fund strong + us window me enough drop. 0 bhi ho sakta hai. Guarantee nahi.',
    windows: WINDOWS.map((w) => ({ key: w.key, days: w.days, minDrop: w.minDrop })),
    byIndex,
    maxPerIndex: MAX_PER_INDEX,
  };

  try {
    if (M) {
      await M.updateOne(
        { key: 'latest' },
        { $set: { payload, computedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (e) {
    console.warn('[fallen-strong] cache write', e.message);
  }

  try { endJob(jid, 'Fallen+strong done'); } catch (_) {}
  runFallenStrongResearch._last = payload;
  return { ...payload, jobId: jid, fromCache: false };
}

async function getLastFallenStrong() {
  if (runFallenStrongResearch._last) return runFallenStrongResearch._last;
  const M = model();
  if (!M) return null;
  const row = await M.findOne({ key: 'latest' }).lean();
  return row?.payload || null;
}

module.exports = { runFallenStrongResearch, getLastFallenStrong, WINDOWS, MAX_PER_INDEX };
