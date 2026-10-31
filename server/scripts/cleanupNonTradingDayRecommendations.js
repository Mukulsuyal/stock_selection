// server/scripts/cleanupNonTradingDayRecommendations.js
//
// One-off cleanup: before logRowsForToday() checked getTradingDayStatus(),
// simply opening an index tab or the Golden Opportunity Scanner on a
// weekend or NSE holiday would still log that day's (stale) scan as if it
// were a real new pick - polluting Track Record with rows dated on days
// the market was never open. That logging path is now fixed (see
// server/recommendations/tracker.js logRowsForToday and
// server/routes/stocks.js detectIntradayGoldenRemovals), but any rows
// already written before the fix need a one-time purge.
//
// Usage (from the project root, with MONGODB_URL set in the environment
// or in a .env file already loaded by your normal startup):
//   node server/scripts/cleanupNonTradingDayRecommendations.js
//
// Add --dry-run to see what WOULD be deleted without deleting anything:
//   node server/scripts/cleanupNonTradingDayRecommendations.js --dry-run

require('dotenv').config();
const mongoose = require('mongoose');
const { connectMongo } = require('../mongo');
const Recommendation = require('../recommendations/Recommendation');
const RemovalEvent = require('../recommendations/RemovalEvent');
const MarketHoliday = require('../models/MarketHoliday');

const DRY_RUN = process.argv.includes('--dry-run');

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00`).getDay(); // 0 Sun, 6 Sat
  return day === 0 || day === 6;
}

async function run() {
  const conn = await connectMongo();
  if (!conn) {
    console.error('MONGODB_URL not set - nothing to clean up against.');
    process.exit(1);
  }

  const holidayDocs = await MarketHoliday.find({}).lean();
  const holidaySet = new Set(holidayDocs.map((d) => d.date));

  // Pull every distinct date actually present in each collection, then
  // work out which of those are weekends/holidays - far cheaper than
  // scanning every document with a JS predicate.
  const recDates = await Recommendation.distinct('recommendedDate');
  const badRecDates = recDates.filter((d) => isWeekend(d) || holidaySet.has(d));

  const removalDates = await RemovalEvent.distinct('removedDate');
  const badRemovalDates = removalDates.filter((d) => isWeekend(d) || holidaySet.has(d));

  console.log(`Found ${badRecDates.length} non-trading-day date(s) in Recommendation: ${badRecDates.join(', ') || '(none)'}`);
  console.log(`Found ${badRemovalDates.length} non-trading-day date(s) in RemovalEvent: ${badRemovalDates.join(', ') || '(none)'}`);

  if (!badRecDates.length && !badRemovalDates.length) {
    console.log('Nothing to clean up.');
    await mongoose.disconnect();
    return;
  }

  if (badRecDates.length) {
    const count = await Recommendation.countDocuments({ recommendedDate: { $in: badRecDates } });
    console.log(`${DRY_RUN ? '[dry-run] Would delete' : 'Deleting'} ${count} Recommendation row(s)...`);
    if (!DRY_RUN) await Recommendation.deleteMany({ recommendedDate: { $in: badRecDates } });
  }

  if (badRemovalDates.length) {
    const count = await RemovalEvent.countDocuments({ removedDate: { $in: badRemovalDates } });
    console.log(`${DRY_RUN ? '[dry-run] Would delete' : 'Deleting'} ${count} RemovalEvent row(s)...`);
    if (!DRY_RUN) await RemovalEvent.deleteMany({ removedDate: { $in: badRemovalDates } });
  }

  console.log(DRY_RUN ? 'Dry run complete - nothing was actually deleted.' : 'Cleanup complete.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
