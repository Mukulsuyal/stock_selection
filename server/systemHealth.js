/**
 * System Health + Truth card + data status for dashboard.
 */
const { isMongoConfigured } = require('./mongo');
const marketData = require('./marketData');

async function probeYahoo() {
  try {
    const q = await marketData.getQuote('^NSEI');
    return { ok: q?.lastPrice != null, detail: q?.lastPrice != null ? `Nifty ~${q.lastPrice}` : 'no price' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function fundCacheAge() {
  if (!isMongoConfigured()) return { ok: false, detail: 'mongo off', count: 0, maxAgeHours: null };
  try {
    const mongoose = require('mongoose');
    const col = mongoose.connection.collection('fundamentals_cache');
    const count = await col.countDocuments();
    const newest = await col.find({}).sort({ updatedAt: -1 }).limit(1).toArray();
    const oldestFresh = newest[0];
    const ts = oldestFresh?.updatedAt || oldestFresh?.fetchedAt || oldestFresh?.updated_at;
    const ageH = ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : null;
    return {
      ok: count > 100,
      count,
      maxAgeHours: ageH != null ? Number(ageH.toFixed(1)) : null,
      detail: count ? `${count} symbols, newest ~${ageH != null ? ageH.toFixed(1) + 'h' : '?'} ago` : 'empty',
    };
  } catch (e) {
    return { ok: false, detail: e.message, count: 0 };
  }
}

async function fiiLast() {
  if (!isMongoConfigured()) return { ok: false, detail: 'mongo off' };
  try {
    const Fii = require('./institutional/models/FiiDiiFlow');
    const row = await Fii.findOne({}).sort({ date: -1 }).lean();
    return {
      ok: !!row,
      detail: row?.date ? `FII/DII last ${row.date}` : 'no FII rows',
      date: row?.date || null,
    };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function stormTruth() {
  try {
    const store = require('./morningStormStore');
    const tr = await store.getTrackRecord();
    return {
      ok: true,
      sample: tr.overall?.sample ?? 0,
      winRatePct: tr.overall?.winRatePct,
      avgReturnPct: tr.overall?.avgReturnPct,
      stopRatePct: tr.overall?.stopRatePct,
      avgMaxFavorablePct: tr.overall?.avgMaxFavorablePct,
      avgMaxAdversePct: tr.overall?.avgMaxAdversePct,
      pending: tr.pending,
      byScenario: tr.byScenario,
      note: tr.note,
    };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function goldenTruth() {
  if (!isMongoConfigured()) return { ok: false, sample: 0 };
  try {
    const Rec = require('./recommendations/Recommendation');
    const cats = ['golden_bronze', 'golden_silver', 'golden_gold', 'golden_diamond', 'short_term', 'momentum', 'reversal'];
    const rows = await Rec.find({ category: { $in: cats } }).sort({ date: -1 }).limit(500).lean();
    const resolved = rows.filter((r) => r.outcome && r.outcome !== 'pending' && r.outcome !== 'open');
    const wins = resolved.filter((r) => /target|hit_t|win/i.test(String(r.outcome)));
    const stops = resolved.filter((r) => /stop|sl/i.test(String(r.outcome)));
    const byCat = {};
    for (const r of resolved) {
      const c = r.category || 'other';
      byCat[c] = byCat[c] || { n: 0, wins: 0, stops: 0 };
      byCat[c].n += 1;
      if (/target|hit_t|win/i.test(String(r.outcome))) byCat[c].wins += 1;
      if (/stop|sl/i.test(String(r.outcome))) byCat[c].stops += 1;
    }
    return {
      ok: true,
      sample: resolved.length,
      pendingish: rows.length - resolved.length,
      winRatePct: resolved.length ? Number(((wins.length / resolved.length) * 100).toFixed(1)) : null,
      stopRatePct: resolved.length ? Number(((stops.length / resolved.length) * 100).toFixed(1)) : null,
      byCategory: Object.fromEntries(
        Object.entries(byCat).map(([k, v]) => [
          k,
          {
            sample: v.n,
            winRatePct: v.n ? Number(((v.wins / v.n) * 100).toFixed(1)) : null,
            stopRatePct: v.n ? Number(((v.stops / v.n) * 100).toFixed(1)) : null,
          },
        ])
      ),
    };
  } catch (e) {
    return { ok: false, detail: e.message, sample: 0 };
  }
}

async function buildSystemHealth() {
  const [yahoo, fund, fii, storm, golden] = await Promise.all([
    probeYahoo(),
    fundCacheAge(),
    fiiLast(),
    stormTruth(),
    goldenTruth(),
  ]);
  const issues = [];
  if (!yahoo.ok) issues.push('Yahoo/index quote weak');
  if (!fund.ok) issues.push('Fundamentals cache thin/stale');
  if (!fii.ok) issues.push('FII/DII missing');
  if ((storm.sample || 0) < 20) issues.push('Early Boom sample < 20 — confidence soft until track record grows');
  if ((golden.sample || 0) < 20) issues.push('Golden/reco sample < 20 — treat % as soft');

  return {
    asOf: new Date().toISOString(),
    dataStatus: { yahoo, fundamentals: fund, fiiDii: fii },
    truth: { morningStorm: storm, goldenAndReco: golden },
    issues,
    walkForwardNote:
      'Model Learning / truth % only trustworthy after adequate out-of-sample sample. Low sample = show UNKNOWN, not fake precision.',
    weeklyDiscipline: {
      maxStormTradesPerDay: Number(process.env.MS_MAX_PICKS || 1),
      maxStormTradesPerWeek: Number(process.env.MS_MAX_WEEKLY || 4),
      note: 'Forced daily trade = edge kill. Empty HIGH day = sit out.',
    },
    sitOutHint:
      'Agar Early Boom HIGH empty → NO HIGH-CONFIDENCE OPPORTUNITY. Forced trade edge khatam karta hai.',
    positionSizeDefault: {
      capitalInr: Number(process.env.DEFAULT_TRADE_CAPITAL || 10000),
      maxLossPct: 2,
      note: 'Default ₹10k · max loss ~−2% SL · 1 active Storm trade / din better',
    },
  };
}

module.exports = { buildSystemHealth, probeYahoo };
