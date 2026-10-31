// server/seedHolidays.js
// Seeds the NSE trading-holiday calendar. Fixed-date national holidays
// (Republic Day, Independence Day, Gandhi Jayanti, Christmas) are safe to
// assume every year. The 2026 festival dates below were provided directly
// (not guessed) - confirmed NSE holidays for 2026. Beyond 2026, or if any
// of these shift, add/edit them in the Settings tab - every automated
// feature (daily picks, intraday snapshots, FII/DII, watchlist alerts)
// respects the list from then on.
const MarketHoliday = require('./models/MarketHoliday');
const { isMongoConfigured } = require('./mongo');

function fixedDateHolidays(year) {
  return [
    { date: `${year}-01-26`, name: 'Republic Day' },
    { date: `${year}-08-15`, name: 'Independence Day' },
    { date: `${year}-10-02`, name: 'Gandhi Jayanti' },
    { date: `${year}-12-25`, name: 'Christmas' },
  ];
}

// Confirmed NSE 2026 festival holidays (provided, not guessed).
const CONFIRMED_2026 = [
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-10', name: 'Diwali – Balipratipada' },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
];

async function seedHolidaysIfEmpty() {
  if (!isMongoConfigured()) return;
  const count = await MarketHoliday.countDocuments();
  if (count > 0) return; // already seeded/user-managed - never overwrite
  const year = new Date().getFullYear();
  const rows = [...fixedDateHolidays(year), ...fixedDateHolidays(year + 1), ...CONFIRMED_2026];
  for (const row of rows) {
    await MarketHoliday.updateOne({ date: row.date }, { $set: row }, { upsert: true });
  }
  console.log(`[seedHolidays] seeded ${rows.length} holiday(s) including confirmed 2026 festival dates. Add any more (or years beyond 2026) in Settings.`);
}

module.exports = { seedHolidaysIfEmpty };
