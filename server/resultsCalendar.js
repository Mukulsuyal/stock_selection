/**
 * Earnings / Quarterly Results Intelligence
 * - Instant serve from memory + Mongo cache
 * - Incremental refresh (stale symbols only), not full rescan every open
 * - Upcoming + recently RELEASED (history) — never invent numbers
 */
const { INDEXES } = require('./indexConstituents');
const marketData = require('./marketData');
const { mapLimit } = require('./stockAnalysisEngine');
const { isMongoConfigured, connectMongo } = require('./mongo');
const mongoose = require('mongoose');

const MEM_TTL_MS = 15 * 60 * 1000; // serve hot for 15 min
const ROW_FRESH_HOURS = 18; // per-symbol refresh window
const RELEASED_LOOKBACK_DAYS = 21;

let memCache = { at: 0, data: null };
let bgRunning = false;

function allSymbols() {
  const set = new Set();
  Object.values(INDEXES).forEach((idx) => {
    (idx.symbols || []).forEach((s) => set.add(String(s).toUpperCase()));
  });
  return [...set];
}

function daysUntil(ymd) {
  if (!ymd) return null;
  try {
    return Math.round((new Date(ymd + 'T00:00:00') - new Date()) / (1000 * 60 * 60 * 24));
  } catch (_) {
    return null;
  }
}

function col() {
  if (!isMongoConfigured()) return null;
  try {
    if (mongoose.connection?.readyState !== 1) return null;
    return mongoose.connection.db.collection('results_calendar_cache');
  } catch (_) {
    return null;
  }
}

async function ensureIndexes() {
  try { if (isMongoConfigured()) await connectMongo(); } catch (_) {}
  const c = col();
  if (!c) return;
  try {
    await c.createIndex({ symbol: 1 }, { unique: true });
    await c.createIndex({ nextEarnings: 1 });
    await c.createIndex({ updatedAt: 1 });
  } catch (_) {}
}

function beatMissFromHistory(h) {
  if (!h) return null;
  if (h.surprisePercent != null && Number.isFinite(Number(h.surprisePercent))) {
    const s = Number(h.surprisePercent);
    // Yahoo surprise often as fraction or percent
    const pct = Math.abs(s) <= 2 ? s * 100 : s;
    if (pct > 1) return { label: 'Beat', surprisePct: Number(pct.toFixed(1)) };
    if (pct < -1) return { label: 'Miss', surprisePct: Number(pct.toFixed(1)) };
    return { label: 'Inline', surprisePct: Number(pct.toFixed(1)) };
  }
  if (h.epsActual != null && h.epsEstimate != null) {
    if (h.epsActual > h.epsEstimate) return { label: 'Beat', surprisePct: null };
    if (h.epsActual < h.epsEstimate) return { label: 'Miss', surprisePct: null };
    return { label: 'Inline', surprisePct: null };
  }
  return null;
}

function lastReleased(history) {
  if (!history?.length) return null;
  const sorted = [...history].filter((h) => h.date || h.quarter).sort((a, b) =>
    String(b.date || b.quarter).localeCompare(String(a.date || a.quarter))
  );
  return sorted[0] || null;
}

function buildVerdict(row) {
  // Lightweight, explainable — not guaranteed
  const reasons = [];
  const risks = [];
  let score = 50;
  const bm = row.lastResultBeatMiss;
  if (bm?.label === 'Beat') { score += 12; reasons.push(`Last EPS ${bm.label}${bm.surprisePct != null ? ` (${bm.surprisePct}%)` : ''}`); }
  if (bm?.label === 'Miss') { score -= 12; risks.push(`Last EPS Miss${bm.surprisePct != null ? ` (${bm.surprisePct}%)` : ''}`); }
  if (row.daysUntil != null && row.daysUntil >= 0 && row.daysUntil <= 1) {
    score -= 5;
    risks.push('Result very near — gap risk');
  }
  if (row.daysUntil != null && row.daysUntil < 0 && row.daysUntil >= -3) {
    reasons.push('Just released — digest reaction');
  }
  if (row.earningsEstimate != null) reasons.push('Estimate available');

  let verdict = 'HOLD';
  if (score >= 68 && bm?.label === 'Beat') verdict = 'BUY ON PULLBACK';
  else if (score >= 62) verdict = 'WAIT';
  else if (score <= 38) verdict = 'AVOID';
  else if (row.daysUntil != null && row.daysUntil <= 2 && row.daysUntil >= 0) verdict = 'WAIT';
  else verdict = 'HOLD';

  // Pre-result: prefer WAIT not BUY
  if (row.daysUntil != null && row.daysUntil >= 0 && row.daysUntil <= 5) {
    if (verdict === 'BUY ON PULLBACK') verdict = 'WAIT';
  }

  return {
    verdict,
    confidence: Math.abs(score - 50) >= 15 ? 'MEDIUM' : 'LOW',
    score: Math.max(0, Math.min(100, score)),
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 4),
    note: 'Verdict uses earnings surprise + calendar proximity only until full tech/fund merge; not a guarantee.',
  };
}

async function fetchOneSymbol(symbol) {
  const ev = await marketData.getEvents(symbol);
  let companyName = null;
  let sector = null;
  try {
    const f = await marketData.getFundamentals(symbol, { preferCacheOnly: true, maxAgeDays: 14 });
    companyName = f?.companyName || null;
    sector = f?.sector || null;
  } catch (_) {}

  const next = ev.nextEarnings || null;
  const d = next != null ? (ev.daysUntil != null ? ev.daysUntil : daysUntil(next)) : null;
  const history = (ev.history || []).slice(0, 8);
  const last = lastReleased(history);
  const lastDate = last?.date || last?.quarter || null;
  let daysSinceRelease = lastDate ? daysUntil(lastDate) : null;
  // daysUntil for past dates is negative
  const bm = beatMissFromHistory(last);

  const row = {
    symbol,
    companyName,
    sector,
    nextEarnings: next,
    daysUntil: d,
    earningsEstimate: ev.earningsAverage ?? null,
    earningsLow: ev.earningsLow ?? null,
    earningsHigh: ev.earningsHigh ?? null,
    revenueEstimate: ev.revenueAverage ?? null,
    history,
    trends: ev.trends || [],
    lastResultDate: lastDate,
    daysSinceRelease: daysSinceRelease != null ? -daysSinceRelease : null, // positive = days ago
    lastResultBeatMiss: bm,
    lastEpsActual: last?.epsActual ?? null,
    lastEpsEstimate: last?.epsEstimate ?? null,
    source: 'yahoo_calendar',
    updatedAt: new Date().toISOString(),
  };
  row.verdict = buildVerdict(row);
  return row;
}

async function loadAllFromMongo() {
  const c = col();
  if (!c) return [];
  try {
    return await c.find({}).project({ _id: 0 }).toArray();
  } catch (_) {
    return [];
  }
}

async function upsertRows(rows) {
  const c = col();
  if (!c || !rows?.length) return;
  const ops = rows.map((r) => ({
    updateOne: {
      filter: { symbol: r.symbol },
      update: { $set: { ...r, updatedAt: new Date() } },
      upsert: true,
    },
  }));
  try {
    await c.bulkWrite(ops, { ordered: false });
  } catch (_) {}
}

function assemblePayload(rows, meta = {}) {
  const withNext = rows
    .filter((r) => r.nextEarnings)
    .sort((a, b) => (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999) || a.symbol.localeCompare(b.symbol));

  const today = withNext.filter((r) => r.daysUntil === 0);
  const next24 = withNext.filter((r) => r.daysUntil != null && r.daysUntil >= 0 && r.daysUntil <= 1);
  const near7 = withNext.filter((r) => r.daysUntil != null && r.daysUntil >= 0 && r.daysUntil <= 7);
  const near15 = withNext.filter((r) => r.daysUntil != null && r.daysUntil > 7 && r.daysUntil <= 15);
  const near30 = withNext.filter((r) => r.daysUntil != null && r.daysUntil > 15 && r.daysUntil <= 30);
  const later = withNext.filter((r) => r.daysUntil != null && r.daysUntil > 30);

  // Released: history date within lookback OR nextEarnings in past few days
  const released = rows
    .filter((r) => {
      if (r.daysUntil != null && r.daysUntil < 0 && r.daysUntil >= -RELEASED_LOOKBACK_DAYS) return true;
      if (r.daysSinceRelease != null && r.daysSinceRelease >= 0 && r.daysSinceRelease <= RELEASED_LOOKBACK_DAYS) return true;
      return false;
    })
    .sort((a, b) => (a.daysSinceRelease ?? 99) - (b.daysSinceRelease ?? 99) || a.symbol.localeCompare(b.symbol));

  const pastFew = withNext.filter((r) => r.daysUntil != null && r.daysUntil < 0 && r.daysUntil >= -14);

  return {
    scannedAt: meta.scannedAt || new Date().toISOString(),
    scannedCount: rows.length,
    withDateCount: withNext.length,
    releasedCount: released.length,
    today,
    next24h: next24,
    near7,
    near15,
    near30,
    later,
    pastFew,
    released,
    all: rows
      .filter((r) => r.nextEarnings || (r.history && r.history.length) || r.lastResultDate)
      .sort((a, b) => {
        if (a.nextEarnings && b.nextEarnings) return (a.daysUntil ?? 999) - (b.daysUntil ?? 999);
        if (a.nextEarnings) return -1;
        if (b.nextEarnings) return 1;
        return a.symbol.localeCompare(b.symbol);
      }),
    note: 'Dates from Yahoo calendar + earnings history when announced. Verify with NSE/BSE filings. Instant UI from cache; background refresh keeps data fresh.',
    dataFreshness: meta.dataFreshness || null,
    fromCache: !!meta.fromCache,
    bgRefresh: !!meta.bgRefresh,
  };
}

function isRowStale(row) {
  if (!row?.updatedAt) return true;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  return age > ROW_FRESH_HOURS * 3600 * 1000;
}

/**
 * Background: refresh only stale / missing symbols, upsert Mongo, refresh mem
 */
async function incrementalRefresh({ forceAll = false, onProgress = null, symbolsLimit = null } = {}) {
  if (bgRunning && !forceAll) return { ok: false, reason: 'already_running' };
  bgRunning = true;
  try {
    await ensureIndexes();
    const symbols = allSymbols();
    const existing = await loadAllFromMongo();
    const bySym = Object.fromEntries(existing.map((r) => [r.symbol, r]));
    let todo = symbols.filter((s) => forceAll || isRowStale(bySym[s]));
    if (symbolsLimit) todo = todo.slice(0, symbolsLimit);

    const total = todo.length;
    let completed = 0;
    const updated = [];

    await mapLimit(todo, 3, async (symbol) => {
      if (onProgress) onProgress({ completed, total, symbol, message: `Earnings: ${symbol}` });
      try {
        const row = await fetchOneSymbol(symbol);
        updated.push(row);
        bySym[symbol] = row;
      } catch (_) {
        if (!bySym[symbol]) {
          bySym[symbol] = {
            symbol,
            nextEarnings: null,
            history: [],
            error: 'no data',
            updatedAt: new Date().toISOString(),
          };
        }
      }
      completed += 1;
      if (onProgress) onProgress({ completed, total, symbol, message: `Done ${symbol}` });
    });

    if (updated.length) await upsertRows(updated);

    const allRows = symbols.map((s) => bySym[s]).filter(Boolean);
    // Recompute daysUntil on serve for freshness of clock
    allRows.forEach((r) => {
      if (r.nextEarnings) r.daysUntil = daysUntil(r.nextEarnings);
      if (r.lastResultDate) {
        const d = daysUntil(r.lastResultDate);
        r.daysSinceRelease = d != null ? -d : null;
      }
    });

    const data = assemblePayload(allRows, {
      scannedAt: new Date().toISOString(),
      fromCache: false,
      dataFreshness: { updatedSymbols: updated.length, total: symbols.length },
    });
    memCache = { at: Date.now(), data };
    return { ok: true, updated: updated.length, total: symbols.length, data };
  } finally {
    bgRunning = false;
  }
}

/**
 * Instant path: memory → mongo → optional kick background
 */
async function buildResultsCalendar({ force = false, onProgress = null } = {}) {
  await ensureIndexes();

  if (force) {
    const r = await incrementalRefresh({ forceAll: true, onProgress });
    return { ...(r.data || assemblePayload([])), fromCache: false };
  }

  // Hot memory
  if (memCache.data && Date.now() - memCache.at < MEM_TTL_MS) {
    // Kick soft bg if many stale
    if (!bgRunning) {
      incrementalRefresh({ forceAll: false }).catch(() => {});
    }
    return { ...memCache.data, fromCache: true, bgRefresh: bgRunning };
  }

  // Mongo instant
  const existing = await loadAllFromMongo();
  if (existing.length) {
    existing.forEach((r) => {
      if (r.nextEarnings) r.daysUntil = daysUntil(r.nextEarnings);
      if (r.lastResultDate) {
        const d = daysUntil(r.lastResultDate);
        r.daysSinceRelease = d != null ? -d : null;
      }
    });
    const data = assemblePayload(existing, {
      scannedAt: existing.reduce((max, r) => {
        const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
        return t > max ? t : max;
      }, 0)
        ? new Date(
            Math.max(...existing.map((r) => (r.updatedAt ? new Date(r.updatedAt).getTime() : 0)))
          ).toISOString()
        : new Date().toISOString(),
      fromCache: true,
      dataFreshness: { rows: existing.length },
    });
    memCache = { at: Date.now(), data };
    if (!bgRunning) incrementalRefresh({ forceAll: false }).catch(() => {});
    return { ...data, fromCache: true, bgRefresh: true };
  }

  // Cold start: limited first batch for speed, then bg rest
  const r = await incrementalRefresh({
    forceAll: true,
    onProgress,
    symbolsLimit: 80,
  });
  if (!bgRunning) {
    setTimeout(() => incrementalRefresh({ forceAll: true }).catch(() => {}), 2000);
  }
  return { ...(r.data || assemblePayload([])), fromCache: false, coldStart: true };
}

module.exports = {
  buildResultsCalendar,
  incrementalRefresh,
  assemblePayload,
};
