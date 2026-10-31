// Persistent fundamentals cache (Mongo).
// One document per NSE symbol (unique). Updates overwrite same row — no new docs on refresh.
const mongoose = require('mongoose');
const { isMongoConfigured } = require('./mongo');

const DEFAULT_MAX_AGE_DAYS = 7;
const BIG_MOVE_PCT = 12;

let Model;
function model() {
  if (Model) return Model;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    symbol: { type: String, unique: true, index: true },
    data: mongoose.Schema.Types.Mixed,
    sector: { type: String, default: null, index: true },
    industry: { type: String, default: null },
    priceAtCache: Number,
    fetchedAt: { type: Date, index: true },
    source: String,
    nextEarnings: String,
  }, { collection: 'fundamentals_cache' });
  Model = mongoose.models.FundamentalsCache
    || mongoose.model('FundamentalsCache', schema);
  return Model;
}

function normSymbol(symbol) {
  return String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase().trim();
}

function ageDays(fetchedAt) {
  if (!fetchedAt) return Infinity;
  return (Date.now() - new Date(fetchedAt).getTime()) / 86400000;
}

async function readCache(symbol, { maxAgeDays = DEFAULT_MAX_AGE_DAYS, livePrice = null } = {}) {
  const M = model();
  if (!M) return { hit: false, stale: true, data: null, reason: 'no_mongo' };
  const sym = normSymbol(symbol);
  const row = await M.findOne({ symbol: sym }).lean();
  if (!row?.data) return { hit: false, stale: true, data: null, reason: 'miss' };

  // Ensure sector on data object
  const data = {
    ...row.data,
    sector: row.data.sector || row.sector || null,
    industry: row.data.industry || row.industry || null,
  };

  const age = ageDays(row.fetchedAt);
  if (age > maxAgeDays) {
    return { hit: true, stale: true, data, reason: 'age', ageDays: age, priceAtCache: row.priceAtCache };
  }

  if (livePrice != null && row.priceAtCache != null && row.priceAtCache > 0) {
    const move = Math.abs((livePrice - row.priceAtCache) / row.priceAtCache) * 100;
    if (move >= BIG_MOVE_PCT) {
      return { hit: true, stale: true, data, reason: 'price_move', movePct: move, priceAtCache: row.priceAtCache };
    }
  }

  if (row.nextEarnings) {
    const ed = new Date(row.nextEarnings);
    if (!Number.isNaN(ed.getTime()) && ed.getTime() < Date.now() - 86400000) {
      if (row.fetchedAt && new Date(row.fetchedAt) < ed) {
        return { hit: true, stale: true, data, reason: 'post_earnings', nextEarnings: row.nextEarnings };
      }
    }
  }

  return { hit: true, stale: false, data, ageDays: age, priceAtCache: row.priceAtCache };
}

async function writeCache(symbol, data, { priceAtCache = null, nextEarnings = null } = {}) {
  const M = model();
  if (!M || !data) return false;
  const sym = normSymbol(symbol);
  const sector = data.sector || null;
  const industry = data.industry || null;
  try {
    // Same symbol → UPDATE same document (upsert). Never creates a second row for same NSE code.
    await M.updateOne(
      { symbol: sym },
      {
        $set: {
          symbol: sym,
          data: { ...data, symbol: sym, sector, industry },
          sector,
          industry,
          priceAtCache: priceAtCache ?? data.priceAtCache ?? null,
          fetchedAt: new Date(),
          source: data.source || null,
          nextEarnings: nextEarnings || data.nextEarnings || null,
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn('[fundamentalsStore] write failed', sym, err.message);
    return false;
  }
}

/**
 * Remove duplicate / messy symbol rows (RELIANCE vs reliance vs RELIANCE.NS).
 * Keeps the newest fetchedAt per normalized symbol.
 */
async function dedupeFundamentalsCache() {
  const M = model();
  if (!M) return { ok: false, reason: 'no_mongo' };
  const all = await M.find({}).lean();
  const byNorm = new Map();
  let removed = 0;
  for (const row of all) {
    const n = normSymbol(row.symbol);
    if (!n) {
      await M.deleteOne({ _id: row._id });
      removed += 1;
      continue;
    }
    const prev = byNorm.get(n);
    if (!prev) {
      byNorm.set(n, row);
      continue;
    }
    const prevAt = prev.fetchedAt ? new Date(prev.fetchedAt).getTime() : 0;
    const curAt = row.fetchedAt ? new Date(row.fetchedAt).getTime() : 0;
    if (curAt >= prevAt) {
      await M.deleteOne({ _id: prev._id });
      byNorm.set(n, row);
      removed += 1;
    } else {
      await M.deleteOne({ _id: row._id });
      removed += 1;
    }
  }
  // Normalize surviving docs: symbol upper, sector top-level
  let normalized = 0;
  for (const [, row] of byNorm) {
    const n = normSymbol(row.symbol);
    const sector = row.data?.sector || row.sector || null;
    const industry = row.data?.industry || row.industry || null;
    if (row.symbol !== n || row.sector !== sector) {
      await M.updateOne(
        { _id: row._id },
        {
          $set: {
            symbol: n,
            sector,
            industry,
            'data.symbol': n,
            'data.sector': sector,
            'data.industry': industry,
          },
        }
      );
      normalized += 1;
    }
  }
  const count = await M.countDocuments();
  console.log(`[fundamentalsStore] dedupe: removed ${removed}, normalized ${normalized}, remaining ${count}`);
  return { ok: true, removed, normalized, remaining: count };
}

module.exports = {
  readCache,
  writeCache,
  dedupeFundamentalsCache,
  normSymbol,
  DEFAULT_MAX_AGE_DAYS,
  BIG_MOVE_PCT,
};
