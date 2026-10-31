// server/institutional/sectorSync.js
// Builds/refreshes the symbol -> sector mapping using the SAME free
// fundamentals source already used elsewhere in this app (Yahoo Finance
// quoteSummary via server/marketData.js) - no new/unverified data source,
// no NSE dependency, cached in Mongo so it's cheap to reuse.
const marketData = require('../marketData');
const SectorMap = require('./models/SectorMap');
const { isMongoConfigured } = require('../mongo');
const { INDEXES } = require('../indexConstituents');

async function syncSectorsFor(symbols) {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  let updated = 0, failed = 0, consecutiveFailures = 0;
  let firstErrorMessage = null;
  let abortedEarly = false;
  // After this many consecutive failures, Yahoo session is likely dead —
  // stop the whole run instead of logging "backing off 15s" hundreds of times.
  const MAX_CONSECUTIVE = 8;
  const HARD_ABORT_AFTER = 25; // absolute consecutive fail ceiling

  for (const symbol of symbols) {
    try {
      const f = await marketData.getFundamentals(symbol);
      await SectorMap.updateOne(
        { symbol },
        { $set: { symbol, sector: f.sector || null, industry: f.industry || null, updatedAt: new Date() } },
        { upsert: true }
      );
      updated++;
      consecutiveFailures = 0;
    } catch (err) {
      failed++;
      consecutiveFailures++;
      if (!firstErrorMessage) firstErrorMessage = err.message;

      if (consecutiveFailures >= HARD_ABORT_AFTER) {
        console.warn(`[sectorSync] aborting early after ${consecutiveFailures} consecutive failures (latest: ${err.message}). Will retry on next scheduled run.`);
        abortedEarly = true;
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE) {
        console.warn(`[sectorSync] ${consecutiveFailures} failures in a row (latest: ${err.message}) - backing off 20s then continuing`);
        await new Promise((r) => setTimeout(r, 20000));
        // Reset counter so one bad stretch doesn't immediately hard-abort;
        // HARD_ABORT_AFTER still caps total pain if it never recovers.
        consecutiveFailures = Math.floor(MAX_CONSECUTIVE / 2);
      }
    }
    // Gentler pacing — fundamentals use crumb session; too fast = header overflow / 429
    await new Promise((r) => setTimeout(r, 550));
  }
  console.log(`[sectorSync] updated ${updated} symbol(s), ${failed} failed${abortedEarly ? ' (aborted early)' : ''}${firstErrorMessage ? ` (first error: ${firstErrorMessage})` : ''}`);
  return { ok: true, updated, failed, abortedEarly };
}

async function syncAllKnownSectors() {
  const allSymbols = [...new Set(Object.values(INDEXES).flatMap((i) => i.symbols))];
  return syncSectorsFor(allSymbols);
}

async function getSectorMap() {
  if (!isMongoConfigured()) return {};
  const docs = await SectorMap.find({}).lean();
  const map = {};
  docs.forEach((d) => { map[d.symbol] = d.sector || 'Unknown'; });
  return map;
}

module.exports = { syncSectorsFor, syncAllKnownSectors, getSectorMap };
